// Compose port reconciliation, exit cleanup, and resource directory resolution.

use crate::ide_bridge;
use crate::mcp_os_process;
use speedwave_runtime::config;
use std::sync::{Arc, Mutex};

/// Shared handle for the IDE Bridge instance.
pub(crate) type SharedIdeBridge = Arc<Mutex<Option<ide_bridge::IdeBridge>>>;

/// Shared handle for the background auto-update check task.
pub(crate) type SharedAutoCheckHandle = Arc<Mutex<Option<tauri::async_runtime::JoinHandle<()>>>>;

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

        // Regenerate compose with the current port
        let user_config = match config::load_user_config() {
            Ok(c) => c,
            Err(e) => {
                log::error!("reconcile_compose_port: failed to load config: {e}");
                return;
            }
        };
        let project_dir = match user_config.projects.iter().find(|p| p.name == project) {
            Some(p) => p.dir.clone(),
            None => {
                log::debug!("reconcile_compose_port: project '{project}' not found in config");
                return;
            }
        };

        let project_path = std::path::Path::new(&project_dir);
        let (resolved, integrations) =
            config::resolve_project_config(project_path, &user_config, &project);

        let yaml = match speedwave_runtime::compose::render_compose(
            &project,
            &project_dir,
            &resolved,
            &integrations,
        ) {
            Ok(y) => y,
            Err(e) => {
                log::error!("reconcile_compose_port: render_compose failed: {e}");
                return;
            }
        };

        let violations = speedwave_runtime::compose::SecurityCheck::run(&yaml, &project);
        if !violations.is_empty() {
            let msgs: Vec<String> = violations
                .iter()
                .map(|v| format!("[{}] {} -- {}", v.container, v.rule, v.message))
                .collect();
            log::error!(
                "reconcile_compose_port: security check failed:\n{}",
                msgs.join("\n")
            );
            return;
        }

        if let Err(e) = speedwave_runtime::compose::save_compose(&project, &yaml) {
            log::error!("reconcile_compose_port: save_compose failed: {e}");
            return;
        }

        // Recreate containers with the new compose
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

/// Runs cleanup when the main window is destroyed: stops IDE Bridge,
/// mcp-os process, and aborts the background auto-update check.
pub(crate) fn run_exit_cleanup(
    ide_bridge: &SharedIdeBridge,
    mcp_os: &Arc<Mutex<Option<mcp_os_process::McpOsProcess>>>,
    auto_check: &SharedAutoCheckHandle,
) {
    // Stop watchdog before killing mcp-os to prevent respawn during shutdown
    crate::WATCHDOG_STOP.store(true, std::sync::atomic::Ordering::Relaxed);

    // Stop containers for all projects before killing mcp-os.
    // Analogous to Docker Desktop stopping containers on quit.
    // Best-effort — failures are logged but do not block remaining cleanup.
    let rt = speedwave_runtime::runtime::detect_runtime();
    match config::load_user_config() {
        Ok(user_config) => {
            for project in &user_config.projects {
                log::info!("exit cleanup: stopping containers for '{}'", project.name);
                if let Err(e) = rt.compose_down(&project.name) {
                    log::warn!(
                        "exit cleanup: compose_down failed for '{}': {e}",
                        project.name
                    );
                }
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
