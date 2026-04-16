// Compose port reconciliation, exit cleanup, and resource directory resolution.

use crate::ide_bridge;
use crate::mcp_os_process;
use crate::types::BundleReconcileStatus;
use speedwave_runtime::{build, bundle, config, plugin};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;
use tauri::Emitter;

/// Shared handle for the IDE Bridge instance.
pub(crate) type SharedIdeBridge = Arc<Mutex<Option<ide_bridge::IdeBridge>>>;

/// Shared handle for the mcp-os process.
pub(crate) type SharedMcpOs = Arc<Mutex<Option<mcp_os_process::McpOsProcess>>>;

/// Shared handle for the background auto-update check task.
pub(crate) type SharedAutoCheckHandle = Arc<Mutex<Option<tauri::async_runtime::JoinHandle<()>>>>;

/// Reconcile phase: nothing running.
const RECONCILE_IDLE: u8 = 0;
/// Reconcile phase: background thread is checking whether a rebuild is needed.
const RECONCILE_CHECKING: u8 = 1;
/// Reconcile phase: actively rebuilding container images.
const RECONCILE_REBUILDING: u8 = 2;

static BUNDLE_RECONCILE_PHASE: AtomicU8 = AtomicU8::new(RECONCILE_IDLE);

/// Tri-state tracking whether container images are ready for use.
#[derive(Clone, Debug)]
enum ImageReadiness {
    Ready,
    Building,
    Failed(String),
}

static IMAGES_READY: std::sync::LazyLock<(Mutex<ImageReadiness>, Condvar)> =
    std::sync::LazyLock::new(|| (Mutex::new(ImageReadiness::Ready), Condvar::new()));

/// Blocks the calling thread until container images are ready (or timeout).
///
/// - `Ready` → returns `Ok(())` immediately
/// - `Building` → waits on Condvar until signaled, then re-checks
/// - `Failed(msg)` → returns `Err(msg)` immediately
pub(crate) fn wait_for_images_ready(timeout: Duration) -> Result<(), String> {
    let (lock, cvar) = &*IMAGES_READY;
    let mut state = lock.lock().unwrap_or_else(|e| e.into_inner());

    let deadline = std::time::Instant::now() + timeout;
    loop {
        match &*state {
            ImageReadiness::Ready => return Ok(()),
            ImageReadiness::Failed(msg) => return Err(msg.clone()),
            ImageReadiness::Building => {
                let remaining = deadline.saturating_duration_since(std::time::Instant::now());
                if remaining.is_zero() {
                    return Err("Timed out waiting for container images to build".to_string());
                }
                let result = cvar
                    .wait_timeout(state, remaining)
                    .unwrap_or_else(|e| e.into_inner());
                state = result.0;
                if result.1.timed_out() {
                    // Re-check after timeout: the state may have changed between the
                    // wait returning and this check. Treating ambiguous state as success
                    // avoids blocking startup when the builder thread is merely slow.
                    match &*state {
                        ImageReadiness::Ready => return Ok(()),
                        ImageReadiness::Failed(msg) => return Err(msg.clone()),
                        ImageReadiness::Building => {
                            return Err(
                                "Timed out waiting for container images to build".to_string()
                            );
                        }
                    }
                }
            }
        }
    }
}

/// Transitions IMAGES_READY to the given state and wakes all waiters.
fn set_image_readiness(state: ImageReadiness) {
    let (lock, cvar) = &*IMAGES_READY;
    let mut readiness = lock.lock().unwrap_or_else(|e| e.into_inner());
    *readiness = state;
    cvar.notify_all();
}

/// Scope guard that ensures `IMAGES_READY` is signaled even if the reconcile
/// thread panics. If state is still `Building` on drop, transitions to `Failed`.
struct ImageReadinessGuard;

impl Drop for ImageReadinessGuard {
    fn drop(&mut self) {
        // Scope guard: if this thread exits without explicitly signaling Ready or Failed,
        // the guard transitions Building->Failed and wakes all waiters. This covers
        // early returns and panics not caught by catch_unwind.
        let (lock, cvar) = &*IMAGES_READY;
        let mut state = lock.lock().unwrap_or_else(|e| e.into_inner());
        if matches!(&*state, ImageReadiness::Building) {
            *state = ImageReadiness::Failed("reconcile thread exited unexpectedly".to_string());
            cvar.notify_all();
        }
        drop(state);
        BUNDLE_RECONCILE_PHASE.store(RECONCILE_IDLE, Ordering::Relaxed);
    }
}

fn phase_name(phase: bundle::BundleReconcilePhase) -> String {
    serde_json::to_value(phase)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_else(|| "pending".to_string())
}

pub(crate) fn current_bundle_status() -> BundleReconcileStatus {
    bundle_status_from(&bundle::load_bundle_state())
}

fn bundle_status_from(state: &bundle::BundleState) -> BundleReconcileStatus {
    let current_bundle_id = bundle::load_current_bundle_manifest()
        .ok()
        .map(|manifest| manifest.bundle_id);
    let bundle_changed = current_bundle_id
        .as_deref()
        .map(|current| state.applied_bundle_id.as_deref() != Some(current))
        .unwrap_or(false);

    let phase_val = BUNDLE_RECONCILE_PHASE.load(Ordering::Relaxed);
    BundleReconcileStatus {
        phase: phase_name(state.phase),
        in_progress: phase_val == RECONCILE_REBUILDING
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

/// INVARIANT: `ensure_ready()` must NOT be gated behind `is_available()`.
/// A stopped Lima VM returns `is_available() == false` but `ensure_ready()`
/// can start it; gating one behind the other silently skips VM auto-start.
/// The behavioral test for this lives in `lima.rs` → `test_ensure_ready_stopped_vm_starts_it`.
fn reconcile_bundle_update_inner(app_handle: &tauri::AppHandle) -> Result<(), String> {
    log::info!("reconcile_bundle: loading current bundle manifest");
    let manifest = bundle::load_current_bundle_manifest().map_err(|e| {
        let msg = format!("Failed to load bundle manifest: {e}");
        log::error!("reconcile_bundle: {msg}");
        msg
    })?;

    let mut state = bundle::load_bundle_state();
    let mut bundle_changed =
        state.applied_bundle_id.as_deref() != Some(manifest.bundle_id.as_str());

    log::info!(
        "reconcile_bundle: current={} applied={} changed={}",
        manifest.bundle_id,
        state.applied_bundle_id.as_deref().unwrap_or("(none)"),
        bundle_changed,
    );

    let rt = speedwave_runtime::runtime::detect_runtime();

    // Call ensure_ready() once and track whether it succeeded. This avoids a
    // double limactl probe (once for image-existence check, once before rebuild).
    let mut runtime_ready = false;
    match rt.ensure_ready() {
        Ok(()) => runtime_ready = true,
        Err(e) => log::warn!("reconcile: runtime not ready: {e}"),
    }

    // Even when bundle_id matches, verify images actually exist.
    // They may have been lost after containerd reinstall or VM recreation.
    if !bundle_changed && runtime_ready && !build::images_exist(&*rt) {
        log::warn!("reconcile: bundle unchanged but images missing, forcing rebuild");
        bundle_changed = true;
    }

    if !bundle_changed {
        if state.phase != bundle::BundleReconcilePhase::Done
            || state.last_error.is_some()
            || !state.pending_running_projects.is_empty()
        {
            log::info!("reconcile_bundle: bundle matches but state dirty, cleaning up");
            state.phase = bundle::BundleReconcilePhase::Done;
            state.last_error = None;
            state.pending_running_projects.clear();
            bundle::save_bundle_state(&state).map_err(|e| e.to_string())?;
        }
        log::info!("reconcile_bundle: no changes needed, setting Ready");
        set_image_readiness(ImageReadiness::Ready);
        emit_bundle_status(app_handle);
        return Ok(());
    }

    log::info!(
        "reconcile_bundle: bundle changed, starting reconcile (phase={:?})",
        state.phase,
    );

    // New bundle = full reconciliation from scratch. Reset phase so all
    // is_before() gates evaluate to true and every step executes.
    if state.phase != bundle::BundleReconcilePhase::Pending {
        log::info!("reconcile_bundle: resetting phase to Pending for new bundle");
        state.phase = bundle::BundleReconcilePhase::Pending;
        bundle::save_bundle_state(&state).map_err(|e| e.to_string())?;
    }

    // Now that we know images need rebuilding, signal Building so that
    // start_containers/switch_project callers block until done.
    BUNDLE_RECONCILE_PHASE.store(RECONCILE_REBUILDING, Ordering::Relaxed);
    set_image_readiness(ImageReadiness::Building);
    emit_bundle_status(app_handle);

    // If the first ensure_ready() failed, retry now — runtime may have
    // recovered (e.g. VM was starting). If it fails again, report the error.
    if !runtime_ready {
        rt.ensure_ready().map_err(|e| {
            set_bundle_error(
                &mut state,
                format!("Runtime is not ready while applying the new bundle: {e}"),
            )
        })?;
    }

    let build_root = build::resolve_build_root().map_err(|e| {
        let msg = format!("Failed to resolve build root: {e}");
        log::error!("reconcile_bundle: {msg}");
        msg
    })?;
    log::info!("reconcile_bundle: build_root={}", build_root.display());

    if state
        .phase
        .is_before(bundle::BundleReconcilePhase::ResourcesSynced)
    {
        log::info!("reconcile_bundle: syncing claude-resources");
        bundle::sync_claude_resources(&build_root).map_err(|e| {
            set_bundle_error(&mut state, format!("Claude resources sync failed: {e}"))
        })?;
        state.phase = bundle::BundleReconcilePhase::ResourcesSynced;
        state.last_error = None;
        bundle::save_bundle_state(&state).map_err(|e| e.to_string())?;
        log::info!("reconcile_bundle: resources synced");
        emit_bundle_status(app_handle);
    }

    if state
        .phase
        .is_before(bundle::BundleReconcilePhase::ImagesBuilt)
    {
        log::info!(
            "reconcile_bundle: building images for bundle {}",
            manifest.bundle_id,
        );
        if let Some(old_id) =
            build::should_prune_bundle(state.applied_bundle_id.as_deref(), &manifest.bundle_id)
        {
            if let Err(e) = build::prune_old_bundle_images(rt.as_ref(), old_id) {
                log::warn!("Failed to prune old bundle images: {e}");
            }
        }
        // build.rs handles: build → fail → prune → retry → SnapshotterRecoveryFailed.
        // Here we escalate: restart engine → retry build. Safe because we are in the
        // pre-restore phase — no containers are running yet (see ContainerRuntime
        // trait docs for restart_container_engine).
        match build::build_all_images_for_bundle(rt.as_ref(), &manifest.bundle_id) {
            Ok(_) => {}
            Err(e)
                if e.downcast_ref::<build::SnapshotterRecoveryFailed>()
                    .is_some() =>
            {
                log::warn!("reconcile_bundle: snapshotter recovery failed, restarting engine");
                rt.restart_container_engine().map_err(|re| {
                    let msg = format!("Engine restart failed: {re}");
                    log::error!("reconcile_bundle: {msg}");
                    set_bundle_error(&mut state, msg)
                })?;
                build::build_all_images_for_bundle(rt.as_ref(), &manifest.bundle_id).map_err(
                    |e| {
                        let msg = format!("Image rebuild failed after engine restart: {e}");
                        log::error!("reconcile_bundle: {msg}");
                        set_bundle_error(&mut state, msg)
                    },
                )?;
            }
            Err(e) => {
                let msg = format!("Image rebuild failed: {e}");
                log::error!("reconcile_bundle: {msg}");
                return Err(set_bundle_error(&mut state, msg));
            }
        }
        // Opportunistically rebuild any missing plugin images (best-effort, warn-only).
        // If this fails, per-project enforcement in render_compose() still catches it.
        if let Err(e) = plugin::ensure_all_plugin_images(rt.as_ref()) {
            log::warn!("reconcile_bundle: failed to rebuild some plugin images: {e}");
        }

        state.phase = bundle::BundleReconcilePhase::ImagesBuilt;
        state.last_error = None;
        bundle::save_bundle_state(&state).map_err(|e| e.to_string())?;

        set_image_readiness(ImageReadiness::Ready);
        log::info!("reconcile_bundle: all images built, waiters unblocked");
        emit_bundle_status(app_handle);

        // After heavy image builds, containerd may be degraded (especially Linux
        // rootless). Re-check readiness before querying running containers.
        rt.ensure_ready().map_err(|e| {
            let msg = format!("Runtime not ready after image build: {e}");
            log::error!("reconcile_bundle: {msg}");
            set_bundle_error(&mut state, msg)
        })?;
    }

    let user_config = match config::load_user_config() {
        Ok(config) => config,
        Err(e) => {
            log::warn!(
                "reconcile_bundle: failed to load user config, using pending list only: {e}"
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
    log::info!("reconcile_bundle: projects to restore: {:?}", projects,);

    if state
        .phase
        .is_before(bundle::BundleReconcilePhase::ProjectsRestored)
    {
        log::info!("reconcile_bundle: restoring {} project(s)", projects.len());
        restore_projects(&projects, rt.as_ref()).map_err(|e| {
            let msg = format!("Project restore failed: {e}");
            log::error!("reconcile_bundle: {msg}");
            set_bundle_error(&mut state, msg)
        })?;
        state.phase = bundle::BundleReconcilePhase::ProjectsRestored;
        state.pending_running_projects = projects;
        state.last_error = None;
        bundle::save_bundle_state(&state).map_err(|e| e.to_string())?;
        log::info!("reconcile_bundle: projects restored");
        emit_bundle_status(app_handle);
    }

    state.applied_bundle_id = Some(manifest.bundle_id.clone());
    state.phase = bundle::BundleReconcilePhase::Done;
    state.pending_running_projects.clear();
    state.last_error = None;
    bundle::save_bundle_state(&state).map_err(|e| e.to_string())?;
    emit_bundle_status(app_handle);

    log::info!("reconcile_bundle: complete, applied={}", manifest.bundle_id,);
    Ok(())
}

pub(crate) fn reconcile_bundle_update(app_handle: &tauri::AppHandle) {
    if BUNDLE_RECONCILE_PHASE
        .compare_exchange(
            RECONCILE_IDLE,
            RECONCILE_CHECKING,
            Ordering::Relaxed,
            Ordering::Relaxed,
        )
        .is_err()
    {
        log::debug!("reconcile_bundle: already running, skipping");
        emit_bundle_status(app_handle);
        return;
    }

    log::info!("reconcile_bundle: starting");

    // NOTE: we do NOT set ImageReadiness::Building here or emit status yet.
    // The inner function sets Building only after confirming bundle_changed==true,
    // so the frontend never shows "Rebuilding..." when nothing needs rebuilding.

    let handle = app_handle.clone();
    std::thread::spawn(move || {
        // Scope guard: if this thread exits without explicitly signaling Ready or Failed,
        // the guard transitions Building->Failed and wakes all waiters. This covers
        // early returns and panics not caught by catch_unwind.
        let _guard = ImageReadinessGuard;

        // catch_unwind so panics produce a specific error message and explicit
        // Failed signaling, rather than relying solely on the scope guard's
        // generic failure transition.
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            reconcile_bundle_update_inner(&handle)
        }));

        match result {
            Ok(Ok(())) => {
                log::info!("reconcile_bundle: thread finished successfully");
            }
            Ok(Err(e)) => {
                log::error!("reconcile_bundle: failed: {e}");
                set_image_readiness(ImageReadiness::Failed(e));
            }
            Err(panic_info) => {
                let msg = panic_info
                    .downcast_ref::<String>()
                    .map(|s| s.as_str())
                    .or_else(|| panic_info.downcast_ref::<&str>().copied())
                    .unwrap_or("unknown panic");
                log::error!("reconcile_bundle: panicked: {msg}");
                set_image_readiness(ImageReadiness::Failed(format!("reconcile panicked: {msg}")));
            }
        }

        BUNDLE_RECONCILE_PHASE.store(RECONCILE_IDLE, Ordering::Relaxed);
        emit_bundle_status(&handle);
    });
}

/// After mcp-os starts on a new dynamic port, check if running containers have
/// a stale WORKER_OS_URL in their compose.yml. If so, regenerate compose and
/// recreate containers so the hub connects to the correct port.
///
/// Runs in a background thread to avoid blocking app startup.
/// The `compose_lock` serialises this with `start_chat`/`resume_conversation`
/// to prevent concurrent compose operations.
pub(crate) fn reconcile_compose_port(
    app_handle: &tauri::AppHandle,
    compose_lock: std::sync::Arc<std::sync::Mutex<()>>,
) {
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
        let data_dir = speedwave_runtime::consts::data_dir();
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

        // Acquire compose lock to prevent concurrent compose operations
        // (e.g. start_chat running ensure_exec_healthy at the same time).
        let _compose_guard = match compose_lock.lock() {
            Ok(g) => g,
            Err(e) => {
                log::error!("reconcile_compose_port: compose lock poisoned: {e}");
                return;
            }
        };

        // Regenerate compose with the current port
        if let Err(e) = crate::containers_cmd::render_and_save_compose(&project, &*rt) {
            log::error!("reconcile_compose_port: {e}");
            return;
        }

        // Force-recreate to ensure the hub picks up the new WORKER_OS_URL.
        // nerdctl compose (unlike Docker Compose) does not reliably detect
        // env-var-only changes in `compose_up`, so force-recreate is needed
        // for correctness.  The compose lock prevents this from racing with
        // start_chat / resume_conversation.
        // Images are guaranteed present — reconcile only runs after a
        // successful mcp-os spawn, meaning containers were running.
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

/// Stops all containers and stops the VM. Extracted so tests can call it
/// directly with a mock runtime.
pub(crate) fn run_container_cleanup(
    rt: &dyn speedwave_runtime::runtime::ContainerRuntime,
    projects: &[config::ProjectUserEntry],
) {
    stop_all_containers(rt, projects);
    if let Err(e) = rt.stop_vm() {
        log::warn!("exit cleanup: stop_vm failed: {e}");
    }
}

/// Runs cleanup when the app exits: stops containers, stops VM, stops IDE
/// Bridge, mcp-os process, and aborts the background auto-update check.
///
/// Guarded by `CLEANUP_ONCE` — safe to call from both `WindowEvent::Destroyed`
/// and a signal handler concurrently. The first call starts the cleanup work
/// in a background thread and returns its `JoinHandle`; subsequent calls
/// return `None`. Callers that intend to terminate the process (e.g. signal
/// handlers calling `std::process::exit`, or the Tauri `RunEvent::Exit` hook)
/// MUST `.join()` the handle before exit, otherwise the cleanup thread is
/// killed mid-flight and the VM never stops.
#[must_use = "join the returned handle before process exit, or VM cleanup will be killed mid-flight"]
pub(crate) fn run_exit_cleanup(
    ide_bridge: &SharedIdeBridge,
    mcp_os: &SharedMcpOs,
    auto_check: &SharedAutoCheckHandle,
) -> Option<std::thread::JoinHandle<()>> {
    static CLEANUP_ONCE: AtomicBool = AtomicBool::new(false);
    if CLEANUP_ONCE.swap(true, Ordering::SeqCst) {
        return None;
    }

    crate::WATCHDOG_STOP.store(true, std::sync::atomic::Ordering::Relaxed);

    let ide_bridge = ide_bridge.clone();
    let mcp_os = mcp_os.clone();
    let auto_check = auto_check.clone();

    let handle = std::thread::spawn(move || {
        // Container + VM cleanup
        if let Ok(user_config) = config::load_user_config() {
            let rt = speedwave_runtime::runtime::detect_runtime();
            run_container_cleanup(rt.as_ref(), &user_config.projects);
        } else {
            log::warn!("exit cleanup: failed to load config, skipping container/VM cleanup");
        }

        // Host process cleanup
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
    });
    Some(handle)
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
            fn image_exists(&self, _: &str) -> anyhow::Result<bool> {
                Ok(true)
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

    mod run_container_cleanup_tests {
        use super::run_container_cleanup;
        use speedwave_runtime::config::ProjectUserEntry;
        use speedwave_runtime::runtime::ContainerRuntime;
        use std::sync::{Arc, Mutex};

        struct TrackingRuntime {
            calls: Arc<Mutex<Vec<String>>>,
            fail_stop_vm: bool,
        }

        impl TrackingRuntime {
            fn new() -> (Self, Arc<Mutex<Vec<String>>>) {
                let calls = Arc::new(Mutex::new(Vec::new()));
                (
                    Self {
                        calls: calls.clone(),
                        fail_stop_vm: false,
                    },
                    calls,
                )
            }

            fn failing_stop_vm() -> (Self, Arc<Mutex<Vec<String>>>) {
                let calls = Arc::new(Mutex::new(Vec::new()));
                (
                    Self {
                        calls: calls.clone(),
                        fail_stop_vm: true,
                    },
                    calls,
                )
            }
        }

        impl ContainerRuntime for TrackingRuntime {
            fn compose_up(&self, _: &str) -> anyhow::Result<()> {
                Ok(())
            }
            fn compose_down(&self, project: &str) -> anyhow::Result<()> {
                self.calls
                    .lock()
                    .unwrap()
                    .push(format!("compose_down:{project}"));
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
            fn image_exists(&self, _: &str) -> anyhow::Result<bool> {
                Ok(true)
            }
            fn stop_vm(&self) -> anyhow::Result<()> {
                self.calls.lock().unwrap().push("stop_vm".to_string());
                if self.fail_stop_vm {
                    anyhow::bail!("mock stop_vm error");
                }
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
        fn full_cleanup_calls_in_order() {
            let (rt, calls) = TrackingRuntime::new();
            let projects = vec![project("alpha"), project("beta")];
            run_container_cleanup(&rt, &projects);
            let recorded = calls.lock().unwrap();
            assert_eq!(
                *recorded,
                vec!["compose_down:alpha", "compose_down:beta", "stop_vm",],
                "cleanup order must be: compose_down per project, then stop_vm"
            );
        }

        #[test]
        fn stop_vm_failure_does_not_panic() {
            let (rt, calls) = TrackingRuntime::failing_stop_vm();
            run_container_cleanup(&rt, &[]);
            let recorded = calls.lock().unwrap();
            assert!(
                recorded.contains(&"stop_vm".to_string()),
                "stop_vm must be attempted, got: {recorded:?}"
            );
        }

        #[test]
        fn empty_projects_still_calls_stop_vm() {
            let (rt, calls) = TrackingRuntime::new();
            run_container_cleanup(&rt, &[]);
            let recorded = calls.lock().unwrap();
            assert_eq!(
                *recorded,
                vec!["stop_vm"],
                "stop_vm must run even with no projects"
            );
        }
    }

    mod bundle_status_tests {
        use super::*;

        /// All tests use `bundle_status_from()` with an explicit `BundleState`
        /// to avoid dependence on the global `data_dir()` OnceLock, which
        /// points to the real `~/.speedwave/` directory during test runs.
        /// Tests that mutate `BUNDLE_RECONCILE_PHASE` must be `#[serial]`.

        #[test]
        #[serial]
        fn current_bundle_status_marks_bundle_change_as_in_progress() {
            BUNDLE_RECONCILE_PHASE.store(RECONCILE_IDLE, Ordering::Relaxed);

            let state = bundle::BundleState {
                applied_bundle_id: Some("older-bundle".to_string()),
                phase: bundle::BundleReconcilePhase::Pending,
                pending_running_projects: vec!["alpha".to_string()],
                last_error: None,
            };

            let status = bundle_status_from(&state);
            assert!(status.in_progress);
            assert_eq!(status.phase, "pending");
            assert_eq!(status.pending_running_projects, vec!["alpha"]);
            assert_eq!(status.applied_bundle_id, Some("older-bundle".to_string()));
        }

        #[test]
        #[serial]
        fn current_bundle_status_hides_stale_error_when_bundle_already_applied() {
            BUNDLE_RECONCILE_PHASE.store(RECONCILE_IDLE, Ordering::Relaxed);
            let manifest = bundle::load_current_bundle_manifest().unwrap();

            let state = bundle::BundleState {
                applied_bundle_id: Some(manifest.bundle_id),
                phase: bundle::BundleReconcilePhase::ImagesBuilt,
                pending_running_projects: vec!["alpha".to_string()],
                last_error: Some("stale error".to_string()),
            };

            let status = bundle_status_from(&state);
            assert!(!status.in_progress);
            assert!(status.last_error.is_none());
            assert!(status.pending_running_projects.is_empty());
        }

        #[test]
        #[serial]
        fn checking_phase_is_not_reported_as_in_progress() {
            let manifest = bundle::load_current_bundle_manifest().unwrap();

            let state = bundle::BundleState {
                applied_bundle_id: Some(manifest.bundle_id),
                phase: bundle::BundleReconcilePhase::Done,
                pending_running_projects: Vec::new(),
                last_error: None,
            };

            // Simulate the CHECKING phase (thread spawned, not yet confirmed rebuild)
            BUNDLE_RECONCILE_PHASE.store(RECONCILE_CHECKING, Ordering::Relaxed);

            let status = bundle_status_from(&state);
            assert!(
                !status.in_progress,
                "CHECKING phase must not show as in_progress"
            );

            // Cleanup
            BUNDLE_RECONCILE_PHASE.store(RECONCILE_IDLE, Ordering::Relaxed);
        }

        #[test]
        #[serial]
        fn rebuilding_phase_is_reported_as_in_progress() {
            let manifest = bundle::load_current_bundle_manifest().unwrap();

            let state = bundle::BundleState {
                applied_bundle_id: Some(manifest.bundle_id),
                phase: bundle::BundleReconcilePhase::Done,
                pending_running_projects: Vec::new(),
                last_error: None,
            };

            // Simulate the REBUILDING phase
            BUNDLE_RECONCILE_PHASE.store(RECONCILE_REBUILDING, Ordering::Relaxed);

            let status = bundle_status_from(&state);
            assert!(
                status.in_progress,
                "REBUILDING phase must show as in_progress"
            );

            // Cleanup
            BUNDLE_RECONCILE_PHASE.store(RECONCILE_IDLE, Ordering::Relaxed);
        }

        #[test]
        #[serial]
        fn current_bundle_status_surfaces_reconcile_error_for_new_bundle() {
            BUNDLE_RECONCILE_PHASE.store(RECONCILE_IDLE, Ordering::Relaxed);

            let state = bundle::BundleState {
                applied_bundle_id: Some("older-bundle".to_string()),
                phase: bundle::BundleReconcilePhase::ImagesBuilt,
                pending_running_projects: vec!["alpha".to_string(), "beta".to_string()],
                last_error: Some("Image rebuild failed".to_string()),
            };

            let status = bundle_status_from(&state);
            assert!(!status.in_progress);
            assert_eq!(status.phase, "images_built");
            assert_eq!(status.last_error.as_deref(), Some("Image rebuild failed"));
            assert_eq!(
                status.pending_running_projects,
                vec!["alpha".to_string(), "beta".to_string()]
            );
        }

        #[test]
        #[serial]
        fn missing_applied_bundle_id_is_reported_as_in_progress() {
            BUNDLE_RECONCILE_PHASE.store(RECONCILE_IDLE, Ordering::Relaxed);

            // Simulate fresh install: no bundle-state.json → applied_bundle_id is None
            // (default BundleState). This should be in_progress because bundle_changed=true.
            let state = bundle::BundleState::default();
            let status = bundle_status_from(&state);
            assert!(
                status.in_progress,
                "missing applied_bundle_id (fresh install) must report in_progress"
            );
            assert!(status.applied_bundle_id.is_none());
        }
    }

    mod wait_for_images_ready_tests {
        use super::*;
        use std::time::Duration;

        /// Helper: reset IMAGES_READY to a known state before each test.
        fn set_readiness(val: ImageReadiness) {
            let (lock, cvar) = &*IMAGES_READY;
            let mut state = lock.lock().unwrap();
            *state = val;
            cvar.notify_all();
        }

        #[test]
        #[serial]
        fn returns_immediately_when_no_reconcile() {
            set_readiness(ImageReadiness::Ready);
            let result = wait_for_images_ready(Duration::from_secs(1));
            assert!(result.is_ok());
        }

        #[test]
        #[serial]
        fn blocks_until_signaled() {
            set_readiness(ImageReadiness::Building);

            let handle = std::thread::spawn(|| wait_for_images_ready(Duration::from_secs(5)));

            // Give the waiter time to block
            std::thread::sleep(Duration::from_millis(50));

            // Signal Ready
            set_readiness(ImageReadiness::Ready);

            let result = handle.join().unwrap();
            assert!(result.is_ok());
        }

        #[test]
        #[serial]
        fn returns_error_on_timeout() {
            set_readiness(ImageReadiness::Building);

            let result = wait_for_images_ready(Duration::from_millis(50));
            assert!(result.is_err());
            assert!(result.unwrap_err().contains("Timed out"));

            // Cleanup
            set_readiness(ImageReadiness::Ready);
        }

        #[test]
        #[serial]
        fn returns_error_when_reconcile_fails() {
            set_readiness(ImageReadiness::Failed("Image rebuild failed".to_string()));

            let result = wait_for_images_ready(Duration::from_secs(1));
            assert!(result.is_err());
            assert_eq!(result.unwrap_err(), "Image rebuild failed");

            // Cleanup
            set_readiness(ImageReadiness::Ready);
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

    /// Structural test: verifies that `reconcile_bundle_update` in main.rs
    /// is gated behind `setup_started`. On a fresh install the Lima VM does
    /// not exist yet, so running reconcile would fail with "Runtime not
    /// available" and poison `ImageReadiness`, blocking the setup wizard's
    /// Start Containers step.
    #[test]
    fn reconcile_gated_behind_setup_started_in_main() {
        let main_source = include_str!("main.rs");
        // The reconcile call must be inside an `if setup_started` block.
        // Find the reconcile_bundle_update call and verify it's preceded by
        // `if setup_started`.
        let idx = main_source
            .find("reconcile::reconcile_bundle_update(app.handle())")
            .expect("main.rs must call reconcile_bundle_update");
        // Look backwards for the nearest `if setup_started`
        let before = &main_source[..idx];
        let last_if = before.rfind("if setup_started");
        assert!(
            last_if.is_some(),
            "reconcile_bundle_update must be gated behind `if setup_started` in main.rs"
        );
        // Verify there's no closing brace between the guard and the call
        // (i.e., the call is inside the same block as the guard).
        let between = &main_source[last_if.unwrap()..idx];
        let open_braces = between.matches('{').count();
        let close_braces = between.matches('}').count();
        assert!(
            open_braces > close_braces,
            "reconcile_bundle_update must be inside the `if setup_started` block, \
             not after it (open={open_braces}, close={close_braces})"
        );
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

    #[test]
    fn reconcile_inner_has_snapshotter_recovery_and_ensure_ready_after_build() {
        let source = include_str!("reconcile.rs");
        let inner_fn = source
            .split("fn reconcile_bundle_update_inner(")
            .nth(1)
            .expect("reconcile_bundle_update_inner function should exist");
        assert!(
            inner_fn.contains("SnapshotterRecoveryFailed"),
            "reconcile must handle SnapshotterRecoveryFailed"
        );
        assert!(
            inner_fn.contains("restart_container_engine"),
            "reconcile must call restart_container_engine on snapshotter failure"
        );
        // ensure_ready must appear inside the ImagesBuilt phase block,
        // after set_image_readiness(Ready) and before the block closes.
        let images_built_block = inner_fn
            .split("is_before(bundle::BundleReconcilePhase::ImagesBuilt)")
            .nth(1)
            .expect("ImagesBuilt phase guard should exist");
        assert!(
            images_built_block.contains("ensure_ready"),
            "reconcile must call ensure_ready inside the ImagesBuilt phase block"
        );
    }

    /// Structural test: verifies that `reconcile_bundle_update_inner` checks
    /// `images_exist` when `bundle_changed` is false. Without this, a
    /// containerd restart that wipes images would leave the app believing
    /// everything is fine while containers cannot start.
    #[test]
    fn reconcile_forces_rebuild_when_images_missing() {
        let source = include_str!("reconcile.rs");
        let inner_fn = source
            .split("fn reconcile_bundle_update_inner(")
            .nth(1)
            .expect("reconcile_bundle_update_inner function should exist");

        assert!(
            inner_fn.contains("images_exist"),
            "reconcile must check images_exist when bundle unchanged"
        );

        // images_exist check must appear BEFORE set_image_readiness(Ready)
        let images_pos = inner_fn
            .find("images_exist")
            .expect("images_exist call not found");
        let ready_pos = inner_fn
            .find("set_image_readiness(ImageReadiness::Ready)")
            .expect("set_image_readiness(Ready) not found");
        assert!(
            images_pos < ready_pos,
            "images_exist check must come before set_image_readiness(Ready)"
        );
    }

    /// Structural test: verifies that `prune_old_bundle_images` is called BEFORE
    /// `build_all_images_for_bundle` inside `reconcile_bundle_update_inner`.
    /// Pruning before building ensures old images are cleaned up first — no data
    /// loss possible since new images haven't been built yet at prune time.
    #[test]
    fn reconcile_prunes_old_images_before_building_new_ones() {
        let source = include_str!("reconcile.rs");
        let inner_fn = source
            .split("fn reconcile_bundle_update_inner(")
            .nth(1)
            .expect("reconcile_bundle_update_inner function should exist");

        let prune_pos = inner_fn
            .find("prune_old_bundle_images")
            .expect("prune_old_bundle_images call must exist in reconcile_bundle_update_inner");
        let build_pos = inner_fn
            .find("build_all_images_for_bundle")
            .expect("build_all_images_for_bundle call must exist in reconcile_bundle_update_inner");

        assert!(
            prune_pos < build_pos,
            "prune_old_bundle_images (at byte {prune_pos}) must appear before \
             build_all_images_for_bundle (at byte {build_pos}) in \
             reconcile_bundle_update_inner — pruning first ensures old images are \
             removed before building new ones"
        );
    }

    /// Structural test: verifies that `ensure_all_plugin_images` is called AFTER
    /// `build_all_images_for_bundle` and BEFORE the `set_image_readiness(ImageReadiness::Ready)`
    /// that follows it. Also verifies it uses warn-only error handling (not `?` propagation).
    #[test]
    fn test_ensure_all_plugin_images_after_core_build_before_ready() {
        let source = include_str!("reconcile.rs");
        let inner_fn = source
            .split("fn reconcile_bundle_update_inner(")
            .nth(1)
            .expect("reconcile_bundle_update_inner function should exist");

        // Verify ensure_all_plugin_images is present
        assert!(
            inner_fn.contains("ensure_all_plugin_images"),
            "reconcile_bundle_update_inner must call ensure_all_plugin_images"
        );

        let build_pos = inner_fn
            .find("build_all_images_for_bundle")
            .expect("build_all_images_for_bundle call must exist");
        let plugin_pos = inner_fn
            .find("ensure_all_plugin_images")
            .expect("ensure_all_plugin_images call must exist");

        assert!(
            build_pos < plugin_pos,
            "ensure_all_plugin_images (offset {plugin_pos}) must appear after \
             build_all_images_for_bundle (offset {build_pos})"
        );

        // Find the set_image_readiness(ImageReadiness::Ready) that comes AFTER
        // ensure_all_plugin_images (not any earlier occurrence in the function).
        let after_plugin = &inner_fn[plugin_pos..];
        let ready_pos_relative = after_plugin
            .find("set_image_readiness(ImageReadiness::Ready)")
            .expect(
                "set_image_readiness(Ready) must appear after ensure_all_plugin_images in \
                 reconcile_bundle_update_inner",
            );
        let ready_pos = plugin_pos + ready_pos_relative;

        assert!(
            plugin_pos < ready_pos,
            "ensure_all_plugin_images (offset {plugin_pos}) must appear before \
             set_image_readiness(Ready) (offset {ready_pos})"
        );

        // Verify warn-only error handling: the call is inside an `if let Err` block
        // with `log::warn!`, NOT a `?` propagation
        let plugin_context = &inner_fn[plugin_pos.saturating_sub(100)..plugin_pos + 200];
        assert!(
            plugin_context.contains("if let Err") || plugin_context.contains("warn!"),
            "ensure_all_plugin_images must use warn-only error handling, not '?' propagation: \
             context around call: {plugin_context}"
        );
    }
}
