// Compose port reconciliation, exit cleanup, and resource directory resolution.

use crate::ide_bridge;
use crate::mcp_os_process;
use crate::types::BundleReconcileStatus;
use speedwave_runtime::{build, bundle, config};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::Emitter;

/// Shared handle for the IDE Bridge instance.
pub(crate) type SharedIdeBridge = Arc<Mutex<Option<ide_bridge::IdeBridge>>>;

/// Shared handle for the mcp-os process.
pub(crate) type SharedMcpOs = Arc<Mutex<Option<mcp_os_process::McpOsProcess>>>;

/// Shared handle for the background auto-update check task.
pub(crate) type SharedAutoCheckHandle = Arc<Mutex<Option<tauri::async_runtime::JoinHandle<()>>>>;

static BUNDLE_RECONCILE_RUNNING: AtomicBool = AtomicBool::new(false);

fn phase_name(phase: bundle::BundleReconcilePhase) -> String {
    serde_json::to_value(phase)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_else(|| "pending".to_string())
}

pub(crate) fn current_bundle_status() -> BundleReconcileStatus {
    let state = bundle::load_bundle_state();
    let current_bundle_id = bundle::load_current_bundle_manifest()
        .ok()
        .map(|manifest| manifest.bundle_id);
    let bundle_changed = current_bundle_id
        .as_deref()
        .map(|current| state.applied_bundle_id.as_deref() != Some(current))
        .unwrap_or(false);

    BundleReconcileStatus {
        phase: phase_name(state.phase),
        in_progress: BUNDLE_RECONCILE_RUNNING.load(Ordering::Relaxed)
            || (bundle_changed && state.last_error.is_none()),
        last_error: if bundle_changed {
            state.last_error.clone()
        } else {
            None
        },
        pending_running_projects: if bundle_changed {
            state.pending_running_projects.clone()
        } else {
            Vec::new()
        },
        applied_bundle_id: state.applied_bundle_id.clone(),
    }
}

fn emit_bundle_status(app_handle: &tauri::AppHandle) {
    let _ = app_handle.emit("bundle_reconcile_status", current_bundle_status());
}

pub(crate) fn list_running_projects(
    rt: &dyn speedwave_runtime::runtime::ContainerRuntime,
    user_config: &config::SpeedwaveUserConfig,
) -> Result<Vec<String>, String> {
    let mut running = Vec::new();
    for project in &user_config.projects {
        let containers = rt
            .compose_ps(&project.name)
            .map_err(|e| format!("compose_ps failed for '{}': {}", project.name, e))?;
        if !containers.is_empty() {
            running.push(project.name.clone());
        }
    }
    Ok(running)
}

pub(crate) fn restore_projects(
    projects: &[String],
    rt: &dyn speedwave_runtime::runtime::ContainerRuntime,
) -> Result<(), String> {
    for project in projects {
        let _ = rt.compose_down(project);
        crate::containers_cmd::render_and_save_compose(project, rt)?;
        rt.compose_up_recreate(project)
            .map_err(|e| format!("compose_up_recreate failed for '{}': {}", project, e))?;
    }
    Ok(())
}

pub(crate) fn stop_projects(
    projects: &[String],
    rt: &dyn speedwave_runtime::runtime::ContainerRuntime,
) -> Result<(), String> {
    for project in projects {
        rt.compose_down(project)
            .map_err(|e| format!("compose_down failed for '{}': {}", project, e))?;
    }
    Ok(())
}

fn set_bundle_error(state: &mut bundle::BundleState, message: String) -> String {
    state.last_error = Some(message.clone());
    if let Err(e) = bundle::save_bundle_state(state) {
        log::warn!("Failed to save bundle error state: {e}");
    }
    message
}

fn reconcile_bundle_update_inner(app_handle: &tauri::AppHandle) -> Result<(), String> {
    let manifest = bundle::load_current_bundle_manifest().map_err(|e| e.to_string())?;
    let mut state = bundle::load_bundle_state();
    let bundle_changed = state.applied_bundle_id.as_deref() != Some(manifest.bundle_id.as_str());

    if !bundle_changed {
        if state.phase != bundle::BundleReconcilePhase::Done
            || state.last_error.is_some()
            || !state.pending_running_projects.is_empty()
        {
            state.phase = bundle::BundleReconcilePhase::Done;
            state.last_error = None;
            state.pending_running_projects.clear();
            bundle::save_bundle_state(&state).map_err(|e| e.to_string())?;
        }
        emit_bundle_status(app_handle);
        return Ok(());
    }

    emit_bundle_status(app_handle);

    let rt = speedwave_runtime::runtime::detect_runtime();
    if !rt.is_available() {
        return Err(set_bundle_error(
            &mut state,
            "Runtime not available while applying the new bundle".to_string(),
        ));
    }
    rt.ensure_ready().map_err(|e| {
        let msg = format!("Runtime is not ready while applying the new bundle: {e}");
        state.last_error = Some(msg.clone());
        let _ = bundle::save_bundle_state(&state);
        msg
    })?;

    let build_root = build::resolve_build_root().map_err(|e| e.to_string())?;

    if state
        .phase
        .is_before(bundle::BundleReconcilePhase::ResourcesSynced)
    {
        bundle::sync_claude_resources(&build_root).map_err(|e| {
            set_bundle_error(&mut state, format!("Claude resources sync failed: {e}"))
        })?;
        state.phase = bundle::BundleReconcilePhase::ResourcesSynced;
        state.last_error = None;
        bundle::save_bundle_state(&state).map_err(|e| e.to_string())?;
        emit_bundle_status(app_handle);
    }

    if state
        .phase
        .is_before(bundle::BundleReconcilePhase::ImagesBuilt)
    {
        build::build_all_images_for_bundle(rt.as_ref(), &manifest.bundle_id).map_err(|e| {
            set_bundle_error(&mut state, format!("Image rebuild failed: {e}"))
        })?;
        state.phase = bundle::BundleReconcilePhase::ImagesBuilt;
        state.last_error = None;
        bundle::save_bundle_state(&state).map_err(|e| e.to_string())?;
        emit_bundle_status(app_handle);
    }

    let user_config = match config::load_user_config() {
        Ok(config) => config,
        Err(e) => {
            log::warn!(
                "reconcile_bundle_update: failed to load user config, proceeding with pending project list only: {e}"
            );
            config::SpeedwaveUserConfig::default()
        }
    };
    let mut projects = state.pending_running_projects.clone();
    let running_projects = list_running_projects(rt.as_ref(), &user_config)?;
    for project in running_projects {
        if !projects.contains(&project) {
            projects.push(project);
        }
    }
    projects.sort();
    projects.dedup();

    if state
        .phase
        .is_before(bundle::BundleReconcilePhase::ProjectsRestored)
    {
        restore_projects(&projects, rt.as_ref()).map_err(|e| {
            set_bundle_error(&mut state, format!("Project restore failed: {e}"))
        })?;
        state.phase = bundle::BundleReconcilePhase::ProjectsRestored;
        state.pending_running_projects = projects;
        state.last_error = None;
        bundle::save_bundle_state(&state).map_err(|e| e.to_string())?;
        emit_bundle_status(app_handle);
    }

    state.applied_bundle_id = Some(manifest.bundle_id);
    state.phase = bundle::BundleReconcilePhase::Done;
    state.pending_running_projects.clear();
    state.last_error = None;
    bundle::save_bundle_state(&state).map_err(|e| e.to_string())?;
    emit_bundle_status(app_handle);

    Ok(())
}

pub(crate) fn reconcile_bundle_update(app_handle: &tauri::AppHandle) {
    if BUNDLE_RECONCILE_RUNNING
        .compare_exchange(false, true, Ordering::Relaxed, Ordering::Relaxed)
        .is_err()
    {
        emit_bundle_status(app_handle);
        return;
    }

    emit_bundle_status(app_handle);
    let handle = app_handle.clone();
    std::thread::spawn(move || {
        if let Err(e) = reconcile_bundle_update_inner(&handle) {
            log::error!("reconcile_bundle_update failed: {e}");
        }
        BUNDLE_RECONCILE_RUNNING.store(false, Ordering::Relaxed);
        emit_bundle_status(&handle);
    });
}

/// After mcp-os starts on a new dynamic port, check if running containers have
/// a stale WORKER_OS_URL in their compose.yml. If so, regenerate compose and
/// recreate containers so the hub connects to the correct port.
///
/// Runs in a background thread to avoid blocking app startup.
pub(crate) fn reconcile_compose_port(app_handle: &tauri::AppHandle) {
    let handle = app_handle.clone();
    std::thread::spawn(move || {
        let project = match config::load_user_config()
            .ok()
            .and_then(|c| c.active_project)
        {
            Some(p) => p,
            None => {
                log::debug!("reconcile_compose_port: no active project");
                return;
            }
        };

        let rt = speedwave_runtime::runtime::detect_runtime();
        if !rt.is_available() {
            log::debug!("reconcile_compose_port: runtime not available");
            return;
        }

        // Check if containers are running
        let containers = match rt.compose_ps(&project) {
            Ok(c) => c,
            Err(e) => {
                log::debug!("reconcile_compose_port: compose_ps failed: {e}");
                return;
            }
        };
        if containers.is_empty() {
            log::debug!("reconcile_compose_port: no containers running");
            return;
        }

        // Read current compose and check if WORKER_OS_URL matches the port file
        let home = match dirs::home_dir() {
            Some(h) => h,
            None => {
                log::debug!("reconcile_compose_port: cannot determine home directory");
                return;
            }
        };
        let data_dir = home.join(speedwave_runtime::consts::DATA_DIR);
        let port_path = data_dir.join(speedwave_runtime::consts::MCP_OS_PORT_FILE);
        let current_port = match std::fs::read_to_string(&port_path) {
            Ok(c) => match c.trim().parse::<u16>() {
                Ok(p) => p,
                Err(e) => {
                    log::debug!("reconcile_compose_port: port parse error: {e}");
                    return;
                }
            },
            Err(e) => {
                log::debug!("reconcile_compose_port: port file read error: {e}");
                return;
            }
        };

        let compose_dir = data_dir.join("compose").join(&project);
        let compose_path = compose_dir.join("compose.yml");
        let compose_content = match std::fs::read_to_string(&compose_path) {
            Ok(c) => c,
            Err(e) => {
                log::debug!("reconcile_compose_port: compose file read error: {e}");
                return;
            }
        };

        // Check if compose already has the correct port
        let expected_url_fragment = format!(":{current_port}");
        if let Some(line) = compose_content
            .lines()
            .find(|l| l.contains("WORKER_OS_URL="))
        {
            if line.contains(&expected_url_fragment) {
                log::debug!("compose WORKER_OS_URL already matches mcp-os port {current_port}");
                return;
            }
            log::info!(
                "compose WORKER_OS_URL is stale (mcp-os port is {current_port}), regenerating"
            );
        } else {
            log::debug!(
                "reconcile_compose_port: no WORKER_OS_URL in compose, OS integration not enabled"
            );
            return;
        }

        // Stop existing containers before regenerating compose — nerdctl's
        // name-store can reject `compose up --force-recreate` with "name already
        // used" if containers are not torn down first.
        if let Err(e) = rt.compose_down(&project) {
            log::warn!("reconcile_compose_port: compose_down failed (continuing): {e}");
        }

        // Regenerate compose with the current port
        if let Err(e) = crate::containers_cmd::render_and_save_compose(&project, &*rt) {
            log::error!("reconcile_compose_port: {e}");
            return;
        }

        // Start containers with the new compose
        if let Err(e) = rt.compose_up_recreate(&project) {
            log::error!("reconcile_compose_port: compose_up_recreate failed: {e}");
            return;
        }

        log::info!("reconcile_compose_port: containers recreated with mcp-os port {current_port}");

        // Notify the frontend that containers were restarted
        use tauri::Emitter;
        let _ = handle.emit("containers_reconciled", current_port);
    });
}

/// Maximum time to wait for all containers to stop during exit cleanup.
const CONTAINER_STOP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// Stop containers for all projects. Best-effort — failures are logged
/// but do not prevent remaining cleanup.
fn stop_all_containers(
    rt: &dyn speedwave_runtime::runtime::ContainerRuntime,
    projects: &[config::ProjectUserEntry],
) {
    for project in projects {
        log::info!("exit cleanup: stopping containers for '{}'", project.name);
        if let Err(e) = rt.compose_down(&project.name) {
            log::warn!(
                "exit cleanup: compose_down failed for '{}': {e}",
                project.name
            );
        }
    }
}

/// Runs cleanup when the main window is destroyed: stops IDE Bridge,
/// mcp-os process, and aborts the background auto-update check.
pub(crate) fn run_exit_cleanup(
    ide_bridge: &SharedIdeBridge,
    mcp_os: &SharedMcpOs,
    auto_check: &SharedAutoCheckHandle,
) {
    // Stop watchdog before killing mcp-os to prevent respawn during shutdown
    crate::WATCHDOG_STOP.store(true, std::sync::atomic::Ordering::Relaxed);

    // Stop containers for all projects before killing mcp-os.
    // Analogous to Docker Desktop stopping containers on quit.
    // Runs in a thread with a timeout so the UI doesn't freeze on quit.
    match config::load_user_config() {
        Ok(user_config) => {
            let (tx, rx) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let rt = speedwave_runtime::runtime::detect_runtime();
                stop_all_containers(rt.as_ref(), &user_config.projects);
                let _ = tx.send(());
            });
            if rx.recv_timeout(CONTAINER_STOP_TIMEOUT).is_err() {
                log::warn!(
                    "exit cleanup: container stop timed out after {}s, proceeding",
                    CONTAINER_STOP_TIMEOUT.as_secs()
                );
            }
        }
        Err(e) => {
            log::warn!("exit cleanup: failed to load config, skipping compose_down: {e}");
        }
    }

    match ide_bridge.lock() {
        Ok(mut guard) => {
            if let Some(mut bridge) = guard.take() {
                if let Err(e) = bridge.stop() {
                    log::warn!("IDE Bridge stop error: {e}");
                }
            }
        }
        Err(e) => log::warn!("IDE Bridge cleanup skipped: mutex poisoned: {e}"),
    }
    match mcp_os.lock() {
        Ok(mut guard) => {
            if let Some(mut proc) = guard.take() {
                if let Err(e) = proc.stop() {
                    log::warn!("mcp-os stop error: {e}");
                }
                proc.cleanup_files();
            }
        }
        Err(e) => log::warn!("mcp-os cleanup skipped: mutex poisoned: {e}"),
    }
    match auto_check.lock() {
        Ok(mut guard) => {
            if let Some(handle) = guard.take() {
                handle.abort();
                log::info!("auto-update check task cancelled on exit");
            }
        }
        Err(e) => log::warn!("auto-check cleanup skipped: mutex poisoned: {e}"),
    }
}

/// Resolves the bundled resources directory from the executable's parent path.
///
/// Platform conventions:
/// - macOS: `<exe>/../../Resources` (inside .app bundle)
/// - Linux: `<exe>/../lib/Speedwave` (.deb — Tauri convention)
/// - Windows: `<exe>/resources` (NSIS installer)
///
/// Returns `None` in dev mode (no bundle structure present).
pub(crate) fn resolve_resources_dir(exe_parent: &std::path::Path) -> Option<std::path::PathBuf> {
    let candidates: Vec<std::path::PathBuf> = if cfg!(target_os = "macos") {
        exe_parent
            .parent()
            .map(|p| vec![p.join("Resources")])
            .unwrap_or_default()
    } else if cfg!(target_os = "linux") {
        // .deb: resources at <exe>/../lib/<productName>/
        let lib_path = exe_parent.parent().map(|p| p.join("lib").join("Speedwave"));
        let mut paths = Vec::new();
        if let Some(p) = lib_path {
            paths.push(p);
        }
        // Fallback: <exe>/resources (dev builds / non-standard layouts)
        paths.push(exe_parent.join("resources"));
        paths
    } else {
        // Windows NSIS: resources are installed alongside the .exe (no subdirectory).
        // Fallback: <exe>/resources (dev builds / non-standard layouts).
        vec![exe_parent.to_path_buf(), exe_parent.join("resources")]
    };

    // Verify the candidate actually contains bundled resources (not just that
    // the directory exists — exe_parent always exists).  Check for a known
    // bundled file to confirm it's the right directory.
    //
    // On Windows, check for the actual CLI binary (cli/speedwave.exe) to avoid
    // false positives from an empty cli/ directory. On Unix, check for the
    // directory since the binary name is platform-constant.
    candidates.into_iter().find(|p| {
        let has_cli = if cfg!(target_os = "windows") {
            p.join("cli").join("speedwave.exe").exists()
        } else {
            p.join("cli").exists()
        };
        has_cli || p.join("mcp-os").exists() || p.join("build-context").exists()
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use serial_test::serial;

    struct HomeGuard {
        original_home: Option<std::ffi::OsString>,
    }

    impl HomeGuard {
        fn set(path: &std::path::Path) -> Self {
            let original_home = std::env::var_os("HOME");
            std::env::set_var("HOME", path);
            Self { original_home }
        }
    }

    impl Drop for HomeGuard {
        fn drop(&mut self) {
            if let Some(home) = &self.original_home {
                std::env::set_var("HOME", home);
            } else {
                std::env::remove_var("HOME");
            }
        }
    }

    mod stop_all_containers_tests {
        use super::stop_all_containers;
        use speedwave_runtime::config::ProjectUserEntry;
        use speedwave_runtime::runtime::ContainerRuntime;
        use std::sync::{Arc, Mutex};

        struct MockRuntime {
            down_calls: Arc<Mutex<Vec<String>>>,
            fail_on: Vec<String>,
        }

        impl MockRuntime {
            fn new() -> (Self, Arc<Mutex<Vec<String>>>) {
                let calls = Arc::new(Mutex::new(Vec::new()));
                (
                    Self {
                        down_calls: calls.clone(),
                        fail_on: Vec::new(),
                    },
                    calls,
                )
            }

            fn failing(names: &[&str]) -> (Self, Arc<Mutex<Vec<String>>>) {
                let calls = Arc::new(Mutex::new(Vec::new()));
                (
                    Self {
                        down_calls: calls.clone(),
                        fail_on: names.iter().map(|s| s.to_string()).collect(),
                    },
                    calls,
                )
            }
        }

        impl ContainerRuntime for MockRuntime {
            fn compose_up(&self, _: &str) -> anyhow::Result<()> {
                Ok(())
            }
            fn compose_down(&self, project: &str) -> anyhow::Result<()> {
                self.down_calls.lock().unwrap().push(project.to_string());
                if self.fail_on.contains(&project.to_string()) {
                    anyhow::bail!("mock error for {project}");
                }
                Ok(())
            }
            fn compose_ps(&self, _: &str) -> anyhow::Result<Vec<serde_json::Value>> {
                Ok(vec![])
            }
            fn container_exec(&self, _: &str, _: &[&str]) -> std::process::Command {
                std::process::Command::new("true")
            }
            fn container_exec_piped(
                &self,
                _: &str,
                _: &[&str],
            ) -> anyhow::Result<std::process::Command> {
                Ok(std::process::Command::new("true"))
            }
            fn is_available(&self) -> bool {
                true
            }
            fn ensure_ready(&self) -> anyhow::Result<()> {
                Ok(())
            }
            fn build_image(
                &self,
                _: &str,
                _: &str,
                _: &str,
                _: &[(&str, &str)],
            ) -> anyhow::Result<()> {
                Ok(())
            }
            fn container_logs(&self, _: &str, _: u32) -> anyhow::Result<String> {
                Ok(String::new())
            }
            fn compose_logs(&self, _: &str, _: u32) -> anyhow::Result<String> {
                Ok(String::new())
            }
            fn compose_up_recreate(&self, _: &str) -> anyhow::Result<()> {
                Ok(())
            }
        }

        fn project(name: &str) -> ProjectUserEntry {
            ProjectUserEntry {
                name: name.to_string(),
                dir: "/tmp/fake".to_string(),
                claude: None,
                integrations: None,
                plugin_settings: None,
            }
        }

        #[test]
        fn calls_compose_down_for_each_project() {
            let (rt, calls) = MockRuntime::new();
            let projects = vec![project("alpha"), project("beta"), project("gamma")];

            stop_all_containers(&rt, &projects);

            let recorded = calls.lock().unwrap();
            assert_eq!(*recorded, vec!["alpha", "beta", "gamma"]);
        }

        #[test]
        fn empty_projects_is_noop() {
            let (rt, calls) = MockRuntime::new();
            stop_all_containers(&rt, &[]);
            assert!(calls.lock().unwrap().is_empty());
        }

        #[test]
        fn failure_does_not_abort_remaining_projects() {
            let (rt, calls) = MockRuntime::failing(&["beta"]);
            let projects = vec![project("alpha"), project("beta"), project("gamma")];

            stop_all_containers(&rt, &projects);

            let recorded = calls.lock().unwrap();
            assert_eq!(
                *recorded,
                vec!["alpha", "beta", "gamma"],
                "all projects should be attempted even when one fails"
            );
        }
    }

    mod bundle_status_tests {
        use super::*;

        #[test]
        #[serial]
        fn current_bundle_status_marks_bundle_change_as_in_progress() {
            let temp = tempfile::tempdir().unwrap();
            let _home = HomeGuard::set(temp.path());
            let manifest = bundle::load_current_bundle_manifest().unwrap();

            bundle::save_bundle_state(&bundle::BundleState {
                applied_bundle_id: Some("older-bundle".to_string()),
                phase: bundle::BundleReconcilePhase::Pending,
                pending_running_projects: vec!["alpha".to_string()],
                last_error: None,
            })
            .unwrap();

            let status = current_bundle_status();
            assert!(status.in_progress);
            assert_eq!(status.phase, "pending");
            assert_eq!(status.pending_running_projects, vec!["alpha"]);
            assert_eq!(status.applied_bundle_id, Some("older-bundle".to_string()));
            assert_ne!(status.applied_bundle_id, Some(manifest.bundle_id));
        }

        #[test]
        #[serial]
        fn current_bundle_status_hides_stale_error_when_bundle_already_applied() {
            let temp = tempfile::tempdir().unwrap();
            let _home = HomeGuard::set(temp.path());
            let manifest = bundle::load_current_bundle_manifest().unwrap();

            bundle::save_bundle_state(&bundle::BundleState {
                applied_bundle_id: Some(manifest.bundle_id),
                phase: bundle::BundleReconcilePhase::ImagesBuilt,
                pending_running_projects: vec!["alpha".to_string()],
                last_error: Some("stale error".to_string()),
            })
            .unwrap();

            let status = current_bundle_status();
            assert!(!status.in_progress);
            assert!(status.last_error.is_none());
            assert!(status.pending_running_projects.is_empty());
        }

        #[test]
        #[serial]
        fn current_bundle_status_surfaces_reconcile_error_for_new_bundle() {
            let temp = tempfile::tempdir().unwrap();
            let _home = HomeGuard::set(temp.path());

            bundle::save_bundle_state(&bundle::BundleState {
                applied_bundle_id: Some("older-bundle".to_string()),
                phase: bundle::BundleReconcilePhase::ImagesBuilt,
                pending_running_projects: vec!["alpha".to_string(), "beta".to_string()],
                last_error: Some("Image rebuild failed".to_string()),
            })
            .unwrap();

            let status = current_bundle_status();
            assert!(!status.in_progress);
            assert_eq!(status.phase, "images_built");
            assert_eq!(status.last_error.as_deref(), Some("Image rebuild failed"));
            assert_eq!(
                status.pending_running_projects,
                vec!["alpha".to_string(), "beta".to_string()]
            );
        }
    }

    #[cfg(target_os = "macos")]
    mod resolve_resources_dir_tests {
        use super::resolve_resources_dir;
        use tempfile::TempDir;

        /// Helper: create a marker subdirectory so the resource probe succeeds.
        fn mark_as_resources(dir: &std::path::Path) {
            std::fs::create_dir_all(dir.join("cli")).unwrap();
        }

        #[test]
        fn macos_app_bundle_resolves_resources() {
            let tmp = TempDir::new().unwrap();
            let exe_parent = tmp.path().join("Contents").join("MacOS");
            let resources = tmp.path().join("Contents").join("Resources");
            std::fs::create_dir_all(&exe_parent).unwrap();
            std::fs::create_dir_all(&resources).unwrap();
            mark_as_resources(&resources);

            let result = resolve_resources_dir(&exe_parent);
            assert_eq!(result, Some(resources));
        }

        #[test]
        fn macos_returns_none_when_resources_dir_empty() {
            let tmp = TempDir::new().unwrap();
            let exe_parent = tmp.path().join("Contents").join("MacOS");
            let resources = tmp.path().join("Contents").join("Resources");
            std::fs::create_dir_all(&exe_parent).unwrap();
            std::fs::create_dir_all(&resources).unwrap();
            // Resources dir exists but has no marker -> should return None

            assert_eq!(resolve_resources_dir(&exe_parent), None);
        }

        #[test]
        fn macos_dev_mode_returns_none() {
            let tmp = TempDir::new().unwrap();
            let exe_parent = tmp.path().join("target").join("debug");
            std::fs::create_dir_all(&exe_parent).unwrap();

            assert_eq!(resolve_resources_dir(&exe_parent), None);
        }
    }

    #[cfg(target_os = "linux")]
    mod resolve_resources_dir_tests {
        use super::resolve_resources_dir;
        use tempfile::TempDir;

        fn mark_as_resources(dir: &std::path::Path) {
            std::fs::create_dir_all(dir.join("cli")).unwrap();
        }

        #[test]
        fn linux_deb_layout_resolves_lib_speedwave() {
            let tmp = TempDir::new().unwrap();
            let exe_parent = tmp.path().join("usr").join("bin");
            let lib_dir = tmp.path().join("usr").join("lib").join("Speedwave");
            std::fs::create_dir_all(&exe_parent).unwrap();
            std::fs::create_dir_all(&lib_dir).unwrap();
            mark_as_resources(&lib_dir);

            let result = resolve_resources_dir(&exe_parent);
            assert_eq!(result, Some(lib_dir));
        }

        #[test]
        fn linux_dev_mode_returns_none() {
            let tmp = TempDir::new().unwrap();
            let exe_parent = tmp.path().join("target").join("debug");
            std::fs::create_dir_all(&exe_parent).unwrap();

            assert_eq!(resolve_resources_dir(&exe_parent), None);
        }

        #[test]
        fn linux_fallback_to_resources_subdir() {
            let tmp = TempDir::new().unwrap();
            let exe_parent = tmp.path().join("target").join("debug");
            let resources = exe_parent.join("resources");
            std::fs::create_dir_all(&resources).unwrap();
            mark_as_resources(&resources);

            let result = resolve_resources_dir(&exe_parent);
            assert_eq!(result, Some(resources));
        }

        #[test]
        fn linux_returns_none_when_lib_dir_empty() {
            let tmp = TempDir::new().unwrap();
            let exe_parent = tmp.path().join("usr").join("bin");
            let lib_dir = tmp.path().join("usr").join("lib").join("Speedwave");
            std::fs::create_dir_all(&exe_parent).unwrap();
            std::fs::create_dir_all(&lib_dir).unwrap();
            // lib dir exists but has no marker → should return None

            assert_eq!(resolve_resources_dir(&exe_parent), None);
        }

        #[test]
        fn linux_lib_speedwave_takes_priority_over_resources() {
            let tmp = TempDir::new().unwrap();
            let exe_parent = tmp.path().join("usr").join("bin");
            let lib_dir = tmp.path().join("usr").join("lib").join("Speedwave");
            let resources = exe_parent.join("resources");
            std::fs::create_dir_all(&exe_parent).unwrap();
            std::fs::create_dir_all(&lib_dir).unwrap();
            std::fs::create_dir_all(&resources).unwrap();
            mark_as_resources(&lib_dir);
            mark_as_resources(&resources);

            let result = resolve_resources_dir(&exe_parent);
            assert_eq!(result, Some(lib_dir));
        }
    }

    #[cfg(target_os = "windows")]
    mod resolve_resources_dir_tests {
        use super::resolve_resources_dir;
        use tempfile::TempDir;

        fn mark_as_resources(dir: &std::path::Path) {
            let cli_dir = dir.join("cli");
            std::fs::create_dir_all(&cli_dir).unwrap();
            std::fs::write(cli_dir.join("speedwave.exe"), b"fake-cli").unwrap();
        }

        #[test]
        fn windows_nsis_resolves_exe_parent_when_resources_alongside() {
            // NSIS installs resources (cli/, mcp-os/, wsl/) directly alongside
            // the .exe — there is no `resources/` subdirectory.
            let tmp = TempDir::new().unwrap();
            let exe_parent = tmp.path().to_path_buf();
            mark_as_resources(&exe_parent);

            let result = resolve_resources_dir(&exe_parent);
            assert_eq!(result, Some(exe_parent));
        }

        #[test]
        fn windows_fallback_to_resources_subdir() {
            // Some layouts may use a resources/ subdirectory (e.g., dev builds).
            let tmp = TempDir::new().unwrap();
            let exe_parent = tmp.path().to_path_buf();
            let resources = exe_parent.join("resources");
            std::fs::create_dir_all(&resources).unwrap();
            mark_as_resources(&resources);

            let result = resolve_resources_dir(&exe_parent);
            // exe_parent itself has no marker, so resources/ should win
            assert_eq!(result, Some(resources));
        }

        #[test]
        fn windows_exe_parent_takes_priority_over_resources_subdir() {
            // When both exe_parent and exe_parent/resources have markers,
            // exe_parent (NSIS layout) wins because it is checked first.
            let tmp = TempDir::new().unwrap();
            let exe_parent = tmp.path().to_path_buf();
            let resources = exe_parent.join("resources");
            std::fs::create_dir_all(&resources).unwrap();
            mark_as_resources(&exe_parent);
            mark_as_resources(&resources);

            let result = resolve_resources_dir(&exe_parent);
            assert_eq!(result, Some(exe_parent));
        }

        #[test]
        fn windows_returns_none_when_no_markers() {
            // Empty directory — neither exe_parent nor resources/ has bundled assets.
            let tmp = TempDir::new().unwrap();
            let exe_parent = tmp.path().to_path_buf();
            // exe_parent exists but has no cli/, mcp-os/, or build-context/

            assert_eq!(resolve_resources_dir(&exe_parent), None);
        }

        #[test]
        fn windows_dev_mode_returns_none() {
            let tmp = TempDir::new().unwrap();
            let exe_parent = tmp.path().join("target").join("debug");
            std::fs::create_dir_all(&exe_parent).unwrap();

            assert_eq!(resolve_resources_dir(&exe_parent), None);
        }

        #[test]
        fn windows_detects_mcp_os_marker() {
            let tmp = TempDir::new().unwrap();
            let exe_parent = tmp.path().to_path_buf();
            std::fs::create_dir_all(exe_parent.join("mcp-os")).unwrap();

            let result = resolve_resources_dir(&exe_parent);
            assert_eq!(result, Some(exe_parent));
        }

        #[test]
        fn windows_detects_build_context_marker() {
            let tmp = TempDir::new().unwrap();
            let exe_parent = tmp.path().to_path_buf();
            std::fs::create_dir_all(exe_parent.join("build-context")).unwrap();

            let result = resolve_resources_dir(&exe_parent);
            assert_eq!(result, Some(exe_parent));
        }
    }
}
