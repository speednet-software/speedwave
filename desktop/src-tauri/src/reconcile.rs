// Compose port reconciliation, exit cleanup, and resource directory resolution.

use crate::bridges::ide_bridge;
use crate::bridges::plugin_host_bridge::PluginHostBridge;
use crate::types::BundleReconcileStatus;
use speedwave_runtime::compose::{HostBridgeRegistration, HostBridgesInfo};
use speedwave_runtime::host_exec_process::HostExecProcess;
use speedwave_runtime::mcp_os_process;
use speedwave_runtime::oauth_process::OauthProcess;
use speedwave_runtime::{build, bundle, config, plugin};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::Duration;
use tauri::Emitter;

/// Shared handle for the IDE Bridge instance.
pub(crate) type SharedIdeBridge = Arc<Mutex<Option<ide_bridge::IdeBridge>>>;

/// Per-slug handles for all host-bridged plugins started by Desktop.
pub(crate) type SharedPluginBridges = Arc<Mutex<HashMap<String, PluginHostBridge>>>;

/// Process-global handle to the active plugin bridges. Set once in
/// `main.rs::setup()`; read from free functions like
/// `compose::render_compose` callers in setup_wizard / containers_cmd
/// which do not receive Tauri state. Empty until init.
static GLOBAL_PLUGIN_BRIDGES: OnceLock<SharedPluginBridges> = OnceLock::new();

/// Register the plugin-bridges map for global access. Called once at
/// startup. Subsequent calls are no-ops (`OnceLock` semantics).
pub(crate) fn set_global_plugin_bridges(handle: SharedPluginBridges) {
    let _ = GLOBAL_PLUGIN_BRIDGES.set(handle);
}

/// Look up the global plugin-bridges map. Returns `None` before
/// `set_global_plugin_bridges` has run.
pub(crate) fn global_plugin_bridges() -> Option<&'static SharedPluginBridges> {
    GLOBAL_PLUGIN_BRIDGES.get()
}

/// Collect compose-injection registrations for every running plugin
/// bridge. Returns an empty `HostBridgesInfo` when nothing is registered
/// yet (e.g. CLI-only contexts).
pub(crate) fn current_bridges_info() -> HostBridgesInfo {
    let registrations = global_plugin_bridges()
        .and_then(|handle| handle.lock().ok())
        .map(|guard| {
            guard
                .iter()
                .map(|(slug, bridge)| {
                    let info = bridge.compose_info();
                    HostBridgeRegistration {
                        plugin_slug: slug.clone(),
                        port: info.port,
                        auth_token: info.auth_token,
                        url_env: bridge.manifest().url_env.clone(),
                        token_env: bridge.manifest().token_env.clone(),
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    HostBridgesInfo {
        bridges: registrations,
    }
}

/// Shared handle for the mcp-os process.
pub(crate) type SharedMcpOs = Arc<Mutex<Option<mcp_os_process::McpOsProcess>>>;

/// Per-project `host_exec` workers, keyed by project name (ADR-054).
pub(crate) type SharedHostExec = Arc<Mutex<HashMap<String, HostExecProcess>>>;

/// Per-project `oauth` workers, keyed by project name (ADR-060).
pub(crate) type SharedOauth = Arc<Mutex<HashMap<String, OauthProcess>>>;

/// Shared handle for the background auto-update check task.
pub(crate) type SharedAutoCheckHandle = Arc<Mutex<Option<tauri::async_runtime::JoinHandle<()>>>>;

/// Shared Arcs needed by `run_exit_cleanup` — clone once per exit path.
#[derive(Clone)]
pub(crate) struct ExitCleanupContext {
    pub(crate) ide_bridge: SharedIdeBridge,
    pub(crate) plugin_bridges: SharedPluginBridges,
    pub(crate) mcp_os: SharedMcpOs,
    /// Per-project `host_exec` workers — stopped + files cleaned on exit.
    pub(crate) host_exec: SharedHostExec,
    /// Per-project `oauth` workers (ADR-060) — stopped + files cleaned on exit.
    pub(crate) oauth: SharedOauth,
    pub(crate) auto_check_handle: SharedAutoCheckHandle,
}

/// Stop + remove a project's worker; cleans token/port/pid/config (keeps audit log).
pub(crate) fn teardown_host_exec_for_project(host_exec: &SharedHostExec, project: &str) {
    let proc = match host_exec.lock() {
        Ok(mut map) => map.remove(project),
        Err(e) => {
            log::warn!("teardown_host_exec_for_project: map mutex poisoned: {e}");
            return;
        }
    };
    if let Some(mut proc) = proc {
        log::info!("host_exec[{project}]: tearing down worker");
        if let Err(e) = proc.stop() {
            log::warn!("host_exec[{project}]: stop error during teardown: {e}");
        }
        proc.cleanup_files();
    }
}

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
    rt: &speedwave_runtime::runtime::LockedRuntime,
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

/// Restores one project under the per-project compose lock.
fn restore_one_project(
    project: &str,
    rt: &speedwave_runtime::runtime::LockedRuntime,
) -> Result<(), String> {
    use crate::types::IntoAnyhow;
    rt.transaction(project, |rt| -> anyhow::Result<()> {
        let _ = rt.compose_down(project);
        crate::containers_cmd::render_and_save_compose(project, rt).into_anyhow()?;
        speedwave_runtime::runtime::compose_validate_with_retry(rt, project)?;
        rt.compose_up_recreate(project)
            .map_err(|e| anyhow::anyhow!("compose_up_recreate failed for '{project}': {e}"))?;
        Ok(())
    })
    .map_err(|e| e.to_string())
}

pub(crate) fn restore_projects(
    projects: &[String],
    rt: &speedwave_runtime::runtime::LockedRuntime,
) -> Result<(), String> {
    for project in projects {
        // NB1-v4 (Option C): substitute CloudStorage TCC prefix BEFORE the
        // error escapes this function, so set_bundle_error and the wrapping
        // "Project restore failed: {e}" caller receive user-readable text.
        // The raw prefix is logged at warn level for diagnostics.
        if let Err(e) = restore_one_project(project, rt) {
            if e.starts_with(speedwave_runtime::consts::CLOUDSTORAGE_TCC_PREFIX) {
                log::warn!("restore_projects: CloudStorage TCC required (raw prefix): {e}");
                return Err(
                    speedwave_runtime::cloudstorage::TCC_USER_REMEDIATION_MESSAGE.to_string(),
                );
            }
            return Err(e);
        }
    }
    Ok(())
}

pub(crate) fn stop_projects(
    projects: &[String],
    rt: &speedwave_runtime::runtime::LockedRuntime,
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

    // Scope: active project only; project switch builds the rest on demand (ADR-057).
    let user_config_for_active = config::load_user_config().unwrap_or_default();
    let active_integrations = match user_config_for_active.active_project.as_deref() {
        Some(name) => match user_config_for_active.find_project(name) {
            Some(p) => config::resolve_integrations(
                std::path::Path::new(&p.dir),
                &user_config_for_active,
                name,
            ),
            None => {
                log::warn!("reconcile: active_project '{name}' not in config — building core only");
                config::ResolvedIntegrationsConfig::default()
            }
        },
        None => config::ResolvedIntegrationsConfig::default(),
    };

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
    if !bundle_changed && runtime_ready && !build::images_exist(&rt, &active_integrations) {
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
        // Old-bundle prune moved to the end of reconcile (after ProjectsRestored).
        // Atomicity: if the build/restore sequence fails partway, the previous
        // bundle's images remain on disk so the project can keep running with
        // the last-known-good set and a retry has something to roll back to.
        // build.rs handles: build → fail → prune → retry → SnapshotterRecoveryFailed.
        // Here we escalate: restart engine → retry build. Safe because we are in the
        // pre-restore phase — no containers are running yet (see ContainerRuntime
        // trait docs for restart_container_engine).
        let enabled = build::enabled_images(&active_integrations);
        match build::build_images_for_bundle(&rt, &enabled, &manifest.bundle_id) {
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
                build::build_images_for_bundle(&rt, &enabled, &manifest.bundle_id).map_err(
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
        // Plugin images enabled in the active project (warn-only).
        let enabled_plugins: Vec<&str> = active_integrations.enabled_plugin_service_ids();
        if let Err(e) = plugin::ensure_plugin_images(&rt, &enabled_plugins) {
            log::warn!("reconcile_bundle: failed to rebuild some plugin images: {e}");
        }
        // Drop tags from this bundle that no longer belong to enabled set (warn-only).
        if let Err(e) =
            build::prune_orphan_current_bundle_images(&rt, &manifest.bundle_id, &enabled)
        {
            log::warn!("reconcile_bundle: orphan-tag prune failed: {e}");
        }

        state.phase = bundle::BundleReconcilePhase::ImagesBuilt;
        state.last_error = None;
        bundle::save_bundle_state(&state).map_err(|e| e.to_string())?;

        set_image_readiness(ImageReadiness::Ready);
        log::info!("reconcile_bundle: all images built, waiters unblocked");
        emit_bundle_status(app_handle);

        // After heavy image builds, containerd may be degraded. Re-check readiness
        // before querying running containers.
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
    let running_projects = list_running_projects(&rt, &user_config)?;
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
        restore_projects(&projects, &rt).map_err(|e| {
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

    // Atomicity: only prune the previous bundle's images now that every
    // earlier phase succeeded. If reconcile failed earlier (image build,
    // project restore, ensure_ready), the previous images stay on disk so
    // a restart resumes with a known-good state.
    if let Some(old_id) =
        build::should_prune_bundle(state.applied_bundle_id.as_deref(), &manifest.bundle_id)
    {
        if let Err(e) = build::prune_old_bundle_images(&rt, old_id) {
            log::warn!("Failed to prune old bundle images: {e}");
        }
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
                let msg = speedwave_runtime::log_sanitizer::panic_payload_to_string(&*panic_info);
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
/// Runs in a background thread. Per-project compose lock serialises this
/// with `start_chat`/`resume_conversation`/`restart_integration_containers`.
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

        // Read the current mcp-os port from its unified lock.json.
        let data_dir = speedwave_runtime::consts::data_dir();
        let lock_path = data_dir.join(speedwave_runtime::consts::MCP_OS_LOCK_FILE);
        let current_port = match speedwave_runtime::host_mcp_process::lock::read(
            &lock_path,
            speedwave_runtime::host_mcp_process::lock::LockService::McpOs,
        ) {
            Some(lock) => lock.port,
            None => {
                log::debug!("reconcile_compose_port: lock.json missing/invalid");
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

        // ensure_images_ready runs outside the transaction — long-running and idempotent.
        if let Err(e) = crate::containers_cmd::ensure_images_ready() {
            log::warn!("reconcile_compose_port: images not ready: {e}");
            return;
        }

        // Per-project compose lock serialises this with start_chat /
        // restart_integration_containers / update_containers.
        use crate::types::IntoAnyhow;
        let result = rt.transaction(&project, |rt| -> anyhow::Result<()> {
            crate::containers_cmd::render_and_save_compose(&project, rt).into_anyhow()?;
            speedwave_runtime::runtime::compose_validate_with_retry(rt, &project)?;
            rt.compose_up_recreate(&project)?;
            Ok(())
        });
        if let Err(e) = result {
            log::error!("reconcile_compose_port: {e}");
            return;
        }

        log::info!("reconcile_compose_port: containers recreated with mcp-os port {current_port}");

        use tauri::Emitter;
        let _ = handle.emit("containers_reconciled", current_port);
    });
}

/// Stop containers for all projects. Best-effort — failures are logged
/// but do not prevent remaining cleanup.
///
/// Runs on Windows, where container state outlives the runtime process: the
/// WSL2 distro is system-managed and `WslRuntime::stop_vm` inherits the no-op
/// default from `ContainerRuntime` — see
/// `crates/speedwave-runtime/src/runtime/mod.rs:142-149`. On macOS,
/// `LimaRuntime::stop_vm` hard-powers the Apple Virtualization VM off via
/// `limactl stop --force` and reaps containers with it, so this function is
/// not called on macOS (compiled out by the cfg).
#[cfg(target_os = "windows")]
fn stop_all_containers(
    rt: &speedwave_runtime::runtime::LockedRuntime,
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

/// Stops all containers (where applicable) and stops the VM (where
/// applicable). Extracted so tests can call it directly with a mock
/// runtime.
///
/// Platform split:
///
/// - macOS (Lima): `limactl stop --force` poweroffs the VM. Every
///   container inside dies with the VM, so the per-project `compose_down`
///   loop is pure UX drag (each `compose down` waits up to ~10 s for
///   nerdctl's hard-coded graceful stop). Skipped.
/// - Windows (WSL2): `WslRuntime::stop_vm` is a no-op (Speedwave does not
///   own the WSL distro lifecycle), so without `compose_down` containers
///   would keep running in the `Speedwave` distro until next Windows boot
///   or manual `wsl --shutdown`. `compose_down` is required.
///
/// Safety: the per-project loop is best-effort on every platform — a
/// failing `compose_down` only logs a warning. Skipping it on macOS loses
/// no information, since VM shutdown imminently replaces it.
pub(crate) fn run_container_cleanup(
    rt: &speedwave_runtime::runtime::LockedRuntime,
    projects: &[config::ProjectUserEntry],
) {
    #[cfg(target_os = "windows")]
    stop_all_containers(rt, projects);
    #[cfg(target_os = "macos")]
    log::info!(
        "exit cleanup: skipping per-project compose_down for {} project(s) — VM shutdown below will kill all containers",
        projects.len()
    );
    if let Err(e) = rt.stop_vm() {
        log::warn!("exit cleanup: stop_vm failed: {e}");
    }
}

/// Runs cleanup when the app exits: stops containers, stops VM, stops IDE
/// Bridge, mcp-os process, and aborts the background auto-update check.
///
/// Guarded by `CLEANUP_ONCE` — safe to call from `WindowEvent::Destroyed`,
/// `RunEvent::ExitRequested`, and a signal handler concurrently. The first
/// call starts the cleanup work in a background thread and returns its
/// `JoinHandle`; subsequent calls return `None`. Callers that intend to
/// terminate the process (e.g. signal handlers calling `std::process::exit`,
/// or the Tauri `RunEvent::Exit` hook) MUST `.join()` the handle before exit,
/// otherwise the cleanup thread is killed mid-flight and the VM never stops.
#[must_use = "join the returned handle before process exit, or VM cleanup will be killed mid-flight"]
pub(crate) fn run_exit_cleanup(ctx: &ExitCleanupContext) -> Option<std::thread::JoinHandle<()>> {
    static CLEANUP_ONCE: AtomicBool = AtomicBool::new(false);
    if CLEANUP_ONCE.swap(true, Ordering::SeqCst) {
        return None;
    }

    crate::WATCHDOG_STOP.store(true, std::sync::atomic::Ordering::Relaxed);
    crate::HOST_EXEC_WATCHDOG_STOP.store(true, std::sync::atomic::Ordering::Relaxed);
    crate::OAUTH_WATCHDOG_STOP.store(true, std::sync::atomic::Ordering::Relaxed);

    let ide_bridge = ctx.ide_bridge.clone();
    let plugin_bridges = ctx.plugin_bridges.clone();
    let mcp_os = ctx.mcp_os.clone();
    let host_exec = ctx.host_exec.clone();
    let oauth = ctx.oauth.clone();
    let auto_check = ctx.auto_check_handle.clone();

    let handle = std::thread::spawn(move || {
        // Container + VM cleanup. stop_vm() runs unconditionally because it
        // does not need the project list — only compose_down does.
        let rt = speedwave_runtime::runtime::detect_runtime();
        let projects = match config::load_user_config() {
            Ok(user_config) => user_config.projects,
            Err(e) => {
                log::warn!("exit cleanup: failed to load config, skipping container stop: {e}");
                Vec::new()
            }
        };
        run_container_cleanup(&rt, &projects);

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
        match plugin_bridges.lock() {
            Ok(mut map) => {
                for (slug, mut bridge) in map.drain() {
                    if let Err(e) = bridge.stop() {
                        log::warn!("plugin bridge[{slug}] stop error: {e}");
                    }
                }
            }
            Err(e) => log::warn!("plugin bridges cleanup skipped: mutex poisoned: {e}"),
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
        match host_exec.lock() {
            Ok(mut map) => {
                for (project, mut proc) in map.drain() {
                    if let Err(e) = proc.stop() {
                        log::warn!("host_exec[{project}] stop error: {e}");
                    }
                    proc.cleanup_files();
                }
            }
            Err(e) => log::warn!("host_exec cleanup skipped: map mutex poisoned: {e}"),
        }
        match oauth.lock() {
            Ok(mut map) => {
                for (project, mut proc) in map.drain() {
                    if let Err(e) = proc.stop() {
                        log::warn!("oauth[{project}] stop error: {e}");
                    }
                    proc.cleanup_files();
                }
            }
            Err(e) => log::warn!("oauth cleanup skipped: map mutex poisoned: {e}"),
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
/// - Windows: `<exe>/resources` (NSIS installer)
///
/// Returns `None` in dev mode (no bundle structure present).
pub(crate) fn resolve_resources_dir(exe_parent: &std::path::Path) -> Option<std::path::PathBuf> {
    let candidates: Vec<std::path::PathBuf> = if cfg!(target_os = "macos") {
        exe_parent
            .parent()
            .map(|p| vec![p.join("Resources")])
            .unwrap_or_default()
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

    #[test]
    fn teardown_host_exec_for_project_is_noop_when_absent() {
        let map: SharedHostExec = SharedHostExec::default();
        // No worker registered for "ghost" — must not panic.
        teardown_host_exec_for_project(&map, "ghost");
        assert!(map.lock().unwrap().is_empty());
    }

    #[test]
    fn restore_one_project_wraps_full_sequence_in_transaction() {
        // Structural test: restore_one_project must wrap compose_down (best-effort),
        // render_and_save_compose, compose_validate_with_retry, and compose_up_recreate
        // in a single rt.transaction(project, ...) so the per-project lock covers
        // the whole sequence.
        let source = include_str!("reconcile.rs");
        let fn_start = source
            .find("fn restore_one_project(")
            .expect("restore_one_project must exist");
        let fn_body = &source[fn_start..];

        let tx_pos = fn_body
            .find("rt.transaction(")
            .expect("restore_one_project must call rt.transaction(project, ...)");
        let down_pos = fn_body
            .find("rt.compose_down(project)")
            .expect("restore_one_project must call compose_down (best-effort)");
        let render_pos = fn_body
            .find("render_and_save_compose")
            .expect("restore_one_project must call render_and_save_compose");
        let validate_pos = fn_body
            .find("compose_validate_with_retry")
            .expect("restore_one_project must call compose_validate_with_retry");
        let up_pos = fn_body
            .find("rt.compose_up_recreate(project)")
            .expect("restore_one_project must call compose_up_recreate");

        assert!(
            tx_pos < down_pos
                && down_pos < render_pos
                && render_pos < validate_pos
                && validate_pos < up_pos,
            "restore_one_project must follow order: transaction(...) {{ compose_down -> render_and_save_compose -> compose_validate_with_retry -> compose_up_recreate }} \
             (tx={tx_pos}, down={down_pos}, render={render_pos}, validate={validate_pos}, up={up_pos})"
        );
    }

    #[test]
    fn reconcile_compose_port_waits_for_image_readiness() {
        // Race guard: mcp-os respawn may race with bundle image rebuild;
        // compose_up_recreate against a missing tag emits image-not-available.
        // Anchor the find on `pub(crate) fn` to skip the bare `fn ...` inside
        // tests that quote the function name.
        let source = include_str!("reconcile.rs");
        let fn_body = extract_fn_body_braced(source, "pub(crate) fn reconcile_compose_port(");

        let ensure_pos = fn_body
            .find("ensure_images_ready(")
            .expect("reconcile_compose_port must call ensure_images_ready");
        let up_pos = fn_body
            .find("compose_up_recreate(")
            .expect("compose_up_recreate must exist in reconcile_compose_port");
        assert!(
            ensure_pos < up_pos,
            "ensure_images_ready must come BEFORE compose_up_recreate"
        );
    }

    /// Returns the body of a function by signature: walks brace depth from
    /// the signature's opening `{` to its matching `}`.
    fn extract_fn_body_braced<'a>(source: &'a str, fn_signature: &'static str) -> &'a str {
        let sig_pos = source
            .find(fn_signature)
            .unwrap_or_else(|| panic!("{fn_signature} not found in source"));
        let after = &source[sig_pos..];
        let open = after.find('{').expect("opening brace not found");
        let bytes = after.as_bytes();
        let mut depth: i32 = 0;
        for (i, &b) in bytes.iter().enumerate().skip(open) {
            match b {
                b'{' => depth += 1,
                b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        return &after[..=i];
                    }
                }
                _ => {}
            }
        }
        panic!("closing brace not found for {fn_signature}")
    }

    // stop_all_containers is compiled out on macOS (see its definition).
    // Its tests are gated to match, otherwise the `use super::stop_all_containers`
    // would fail to resolve on macOS.
    #[cfg(target_os = "windows")]
    mod stop_all_containers_tests {
        use super::stop_all_containers;
        use speedwave_runtime::config::ProjectUserEntry;
        use speedwave_runtime::runtime::mock_runtime::MockRuntimeBuilder;

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
            let (rt, handles) = MockRuntimeBuilder::new().build();
            let projects = vec![project("alpha"), project("beta"), project("gamma")];

            stop_all_containers(&rt, &projects);

            assert_eq!(handles.down_projects(), vec!["alpha", "beta", "gamma"]);
        }

        #[test]
        fn empty_projects_is_noop() {
            let (rt, handles) = MockRuntimeBuilder::new().build();
            stop_all_containers(&rt, &[]);
            assert!(handles.down_projects().is_empty());
        }

        #[test]
        fn failure_does_not_abort_remaining_projects() {
            let (rt, handles) = MockRuntimeBuilder::new()
                .with_fail_on_down(&["beta"])
                .build();
            let projects = vec![project("alpha"), project("beta"), project("gamma")];

            stop_all_containers(&rt, &projects);

            assert_eq!(
                handles.down_projects(),
                vec!["alpha", "beta", "gamma"],
                "all projects should be attempted even when one fails"
            );
        }
    }

    mod run_container_cleanup_tests {
        use super::run_container_cleanup;
        use speedwave_runtime::config::ProjectUserEntry;
        use speedwave_runtime::runtime::mock_runtime::MockRuntimeBuilder;

        fn project(name: &str) -> ProjectUserEntry {
            ProjectUserEntry {
                name: name.to_string(),
                dir: "/tmp/fake".to_string(),
                claude: None,
                integrations: None,
                plugin_settings: None,
            }
        }

        #[cfg(target_os = "windows")]
        #[test]
        fn full_cleanup_calls_in_order_on_windows() {
            // Note: runs on any non-macOS target. Windows dev hosts execute
            // this test routinely, but Windows CI
            // (.github/workflows/desktop-build.yml) runs only `cargo build`,
            // not `cargo test`. Enabling `cargo test` on the Windows matrix
            // leg is tracked as a follow-up PR.
            let (rt, handles) = MockRuntimeBuilder::new().build();
            let projects = vec![project("alpha"), project("beta")];
            run_container_cleanup(&rt, &projects);
            assert_eq!(
                handles.down_projects(),
                vec!["alpha", "beta"],
                "on non-macOS each project must be torn down before stop_vm"
            );
            assert_eq!(
                handles
                    .stop_vm_calls
                    .load(std::sync::atomic::Ordering::SeqCst),
                1,
                "stop_vm must run after per-project compose_down"
            );
        }

        #[cfg(target_os = "macos")]
        #[test]
        fn cleanup_skips_compose_down_when_vm_will_stop() {
            // On macOS the Lima VM is hard-powered off by `limactl stop
            // --force`, which reaps containers for free. Per-project
            // compose_down would waste up to 10s per project (nerdctl's
            // hard-coded graceful stop) and kill the Quit UX.
            let (rt, handles) = MockRuntimeBuilder::new().build();
            let projects = vec![project("alpha"), project("beta")];
            run_container_cleanup(&rt, &projects);
            assert!(
                handles.down_projects().is_empty(),
                "on macOS compose_down must NOT be called; the Lima VM poweroff reaps \
                 every container for free"
            );
            assert_eq!(
                handles
                    .stop_vm_calls
                    .load(std::sync::atomic::Ordering::SeqCst),
                1,
                "only stop_vm must run on macOS cleanup"
            );
        }

        #[test]
        fn stop_vm_failure_does_not_panic() {
            let (rt, handles) = MockRuntimeBuilder::new()
                .with_stop_vm_error("mock stop_vm error")
                .build();
            run_container_cleanup(&rt, &[]);
            assert_eq!(
                handles
                    .stop_vm_calls
                    .load(std::sync::atomic::Ordering::SeqCst),
                1,
                "stop_vm must be attempted even when it fails"
            );
        }

        #[test]
        fn empty_projects_still_calls_stop_vm() {
            let (rt, handles) = MockRuntimeBuilder::new().build();
            run_container_cleanup(&rt, &[]);
            assert!(handles.down_projects().is_empty());
            assert_eq!(
                handles
                    .stop_vm_calls
                    .load(std::sync::atomic::Ordering::SeqCst),
                1,
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

    /// Verifies that `run_exit_cleanup` is idempotent: the first call returns
    /// `Some(JoinHandle)` and the second returns `None`. This tests the
    /// `CLEANUP_ONCE` AtomicBool guard.
    ///
    /// NOTE: Because `CLEANUP_ONCE` is a `static` inside `run_exit_cleanup`, once
    /// set it stays set for the entire process lifetime. This test must run last
    /// (or in a separate test binary) — any subsequent test calling `run_exit_cleanup`
    /// in the same process will see `None`. `#[serial]` ensures ordering within this
    /// module.
    #[test]
    #[serial]
    fn cleanup_once_idempotency() {
        let ctx = ExitCleanupContext {
            ide_bridge: SharedIdeBridge::default(),
            plugin_bridges: SharedPluginBridges::default(),
            mcp_os: SharedMcpOs::default(),
            host_exec: SharedHostExec::default(),
            oauth: SharedOauth::default(),
            auto_check_handle: SharedAutoCheckHandle::default(),
        };

        let first = run_exit_cleanup(&ctx);
        assert!(
            first.is_some(),
            "first call to run_exit_cleanup must return Some(JoinHandle)"
        );
        // Wait for the cleanup thread to finish to avoid leaking threads.
        first.unwrap().join().ok();

        let second = run_exit_cleanup(&ctx);
        assert!(
            second.is_none(),
            "second call to run_exit_cleanup must return None (CLEANUP_ONCE guard)"
        );
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

    /// Structural test: image-build errors return via `set_bundle_error`
    /// before any code that mutates `applied_bundle_id`. This is the atomicity
    /// guarantee for the partial-build-failure path: if build fails after the
    /// prune-old block was moved to the end of reconcile, the old bundle id
    /// must remain so the project keeps running with the previous images.
    ///
    /// We cannot run `reconcile_bundle_update_inner` behaviorally in a unit
    /// test (it depends on `tauri::AppHandle`, `runtime::detect_runtime`,
    /// `config::load_user_config`, ...) — instead we assert on the source
    /// that the bail path is structurally correct.
    #[test]
    fn reconcile_partial_build_failure_does_not_mutate_applied_bundle_id() {
        let source = include_str!("reconcile.rs");
        let inner_fn = source
            .split("fn reconcile_bundle_update_inner(")
            .nth(1)
            .expect("reconcile_bundle_update_inner function should exist");

        let bail_pos = inner_fn
            .find("Image rebuild failed: {e}")
            .expect("Image rebuild failed bail path must exist");
        let applied_id_assignment_pos = inner_fn
            .find("state.applied_bundle_id = Some(manifest.bundle_id.clone())")
            .expect("applied_bundle_id assignment must exist");
        let prune_pos = inner_fn
            .find("prune_old_bundle_images")
            .expect("prune_old_bundle_images must exist");

        assert!(
            bail_pos < applied_id_assignment_pos,
            "Image rebuild failed bail (at byte {bail_pos}) must return BEFORE \
             applied_bundle_id is set (at byte {applied_id_assignment_pos}) — \
             otherwise a partial build failure overwrites the previous bundle id"
        );
        assert!(
            bail_pos < prune_pos,
            "Image rebuild failed bail (at byte {bail_pos}) must return BEFORE \
             prune_old_bundle_images runs (at byte {prune_pos}) — otherwise a \
             partial build failure prunes the previous bundle's images even \
             though no new images replaced them"
        );

        // Spot-check that the failing branch is `return Err(set_bundle_error(...))`
        // and not a silent log + continue.
        let bail_context = &inner_fn[bail_pos..bail_pos.saturating_add(200)];
        assert!(
            bail_context.contains("return Err(set_bundle_error"),
            "Image rebuild failure must `return Err(set_bundle_error(...))`, \
             not log-and-continue; observed context: {bail_context}"
        );
    }

    /// Structural test: `prune_old_bundle_images` must run AFTER the full
    /// build/restore sequence (after `ProjectsRestored`) in
    /// `reconcile_bundle_update_inner`. Atomicity: previous-bundle images stay
    /// on disk until the new bundle has been built AND every project restored,
    /// so a partial failure leaves the previous bundle intact.
    #[test]
    fn reconcile_prunes_old_images_after_full_restore() {
        let source = include_str!("reconcile.rs");
        let inner_fn = source
            .split("fn reconcile_bundle_update_inner(")
            .nth(1)
            .expect("reconcile_bundle_update_inner function should exist");

        let prune_pos = inner_fn
            .find("prune_old_bundle_images")
            .expect("prune_old_bundle_images call must exist in reconcile_bundle_update_inner");
        let build_pos = inner_fn
            .find("build_images_for_bundle")
            .expect("build_images_for_bundle call must exist in reconcile_bundle_update_inner");
        let restore_pos = inner_fn
            .find("restore_projects(")
            .expect("restore_projects call must exist in reconcile_bundle_update_inner");

        assert!(
            prune_pos > build_pos,
            "prune_old_bundle_images (at byte {prune_pos}) must appear AFTER \
             build_images_for_bundle (at byte {build_pos}) in reconcile_bundle_update_inner"
        );
        assert!(
            prune_pos > restore_pos,
            "prune_old_bundle_images (at byte {prune_pos}) must appear AFTER \
             restore_projects (at byte {restore_pos}) in reconcile_bundle_update_inner"
        );
    }

    /// Structural test: `ensure_plugin_images` is called AFTER the built-in build
    /// and BEFORE `set_image_readiness(Ready)`, with warn-only error handling.
    #[test]
    fn test_ensure_plugin_images_after_core_build_before_ready() {
        let source = include_str!("reconcile.rs");
        let inner_fn = source
            .split("fn reconcile_bundle_update_inner(")
            .nth(1)
            .expect("reconcile_bundle_update_inner function should exist");

        assert!(
            inner_fn.contains("ensure_plugin_images"),
            "reconcile_bundle_update_inner must call ensure_plugin_images"
        );

        let build_pos = inner_fn
            .find("build_images_for_bundle")
            .expect("build_images_for_bundle call must exist");
        let plugin_pos = inner_fn
            .find("ensure_plugin_images")
            .expect("ensure_plugin_images call must exist");

        assert!(
            build_pos < plugin_pos,
            "ensure_plugin_images (offset {plugin_pos}) must appear after \
             build_images_for_bundle (offset {build_pos})"
        );

        let after_plugin = &inner_fn[plugin_pos..];
        let ready_pos_relative = after_plugin
            .find("set_image_readiness(ImageReadiness::Ready)")
            .expect("set_image_readiness(Ready) must appear after ensure_plugin_images");
        let ready_pos = plugin_pos + ready_pos_relative;

        assert!(
            plugin_pos < ready_pos,
            "ensure_plugin_images (offset {plugin_pos}) must appear before \
             set_image_readiness(Ready) (offset {ready_pos})"
        );

        // Warn-only handling: `if let Err` / `warn!`, not `?`.
        let plugin_context = &inner_fn[plugin_pos.saturating_sub(100)..plugin_pos + 200];
        assert!(
            plugin_context.contains("if let Err") || plugin_context.contains("warn!"),
            "ensure_plugin_images must use warn-only error handling: {plugin_context}"
        );
    }
}
