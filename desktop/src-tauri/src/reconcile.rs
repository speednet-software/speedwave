// Compose port reconciliation, exit cleanup, and resource directory resolution.

use crate::bridges::ide_bridge;
use crate::bridges::plugin_host_bridge::PluginHostBridge;
use crate::types::BundleReconcileStatus;
use speedwave_runtime::compose::{HostBridgeRegistration, HostBridgesInfo};
use speedwave_runtime::mcp_os_process;
use speedwave_runtime::oauth_process::OauthProcess;
use speedwave_runtime::{build, bundle, config, log_sanitizer, plugin};
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
/// `main.rs::setup()`; read from free functions without Tauri state. Empty until init.
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

/// Collect compose-injection registrations for every running plugin bridge.
/// Returns an empty `HostBridgesInfo` when nothing is registered (e.g. CLI-only).
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
    let mut bridges: Vec<HostBridgeRegistration> = registrations;
    // Deterministic order (HashMap iteration): renders must hash identically.
    bridges.sort_by(|a, b| a.plugin_slug.cmp(&b.plugin_slug));
    HostBridgesInfo { bridges }
}

/// Shared handle for the mcp-os process.
pub(crate) type SharedMcpOs = Arc<Mutex<Option<mcp_os_process::McpOsProcess>>>;

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
    /// Per-project `oauth` workers (ADR-060) — stopped + files cleaned on exit.
    pub(crate) oauth: SharedOauth,
    pub(crate) auto_check_handle: SharedAutoCheckHandle,
}

/// Stop + remove a project's worker; cleans token/port/pid/config (keeps audit log).
/// Generic best-effort teardown — one body for every `HashMap<project, HostMcpProcess<S>>`.
fn teardown_worker_for_project<S: speedwave_runtime::host_mcp_process::WorkerSpec>(
    map: &Arc<Mutex<HashMap<String, speedwave_runtime::host_mcp_process::HostMcpProcess<S>>>>,
    project: &str,
    label: &str,
) {
    let proc = match map.lock() {
        Ok(mut map) => map.remove(project),
        Err(e) => {
            log::warn!("map mutex poisoned during {label}[{project}] teardown: {e}");
            return;
        }
    };
    if let Some(mut proc) = proc {
        log::info!("tearing down {label}[{project}] worker");
        if let Err(e) = proc.stop() {
            log::warn!("stop error tearing down {label}[{project}]: {e}");
        }
        proc.cleanup_files();
    }
}

/// ADR-060 oauth worker variant of [`teardown_worker_for_project`].
pub(crate) fn teardown_oauth_for_project(oauth: &SharedOauth, project: &str) {
    teardown_worker_for_project(oauth, project, "oauth");
}

/// Reconcile phase: nothing running.
const RECONCILE_IDLE: u8 = 0;
/// Reconcile phase: background thread is checking whether a rebuild is needed.
const RECONCILE_CHECKING: u8 = 1;
/// Reconcile phase: actively rebuilding container images.
const RECONCILE_REBUILDING: u8 = 2;

static BUNDLE_RECONCILE_PHASE: AtomicU8 = AtomicU8::new(RECONCILE_IDLE);

/// Tracks whether container images are ready. `Checking` covers the bundle-manifest
/// comparison at reconcile start; waiters treat it like `Building` to avoid a rebuild race.
#[derive(Clone, Debug)]
enum ImageReadiness {
    Ready,
    Checking,
    Building,
    Failed(String),
}

static IMAGES_READY: std::sync::LazyLock<(Mutex<ImageReadiness>, Condvar)> =
    std::sync::LazyLock::new(|| (Mutex::new(ImageReadiness::Ready), Condvar::new()));

/// Blocks the calling thread until container images are ready (or timeout): `Ready`
/// returns immediately, `Checking`/`Building` wait on the Condvar, `Failed(msg)` errors.
pub(crate) fn wait_for_images_ready(timeout: Duration) -> Result<(), String> {
    let (lock, cvar) = &*IMAGES_READY;
    let mut state = lock.lock().unwrap_or_else(|e| e.into_inner());

    let deadline = std::time::Instant::now() + timeout;
    loop {
        match &*state {
            ImageReadiness::Ready => return Ok(()),
            ImageReadiness::Failed(msg) => return Err(msg.clone()),
            ImageReadiness::Checking | ImageReadiness::Building => {
                let remaining = deadline.saturating_duration_since(std::time::Instant::now());
                if remaining.is_zero() {
                    return Err("Timed out waiting for container images to build".to_string());
                }
                let result = cvar
                    .wait_timeout(state, remaining)
                    .unwrap_or_else(|e| e.into_inner());
                state = result.0;
                if result.1.timed_out() {
                    // Re-check after timeout: state may have changed since the wait
                    // returned. Ambiguous state is treated as success.
                    match &*state {
                        ImageReadiness::Ready => return Ok(()),
                        ImageReadiness::Failed(msg) => return Err(msg.clone()),
                        ImageReadiness::Checking | ImageReadiness::Building => {
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
        // Scope guard: if this thread exits without signaling Ready or Failed,
        // transition Checking/Building->Failed and wake all waiters.
        let (lock, cvar) = &*IMAGES_READY;
        let mut state = lock.lock().unwrap_or_else(|e| e.into_inner());
        if matches!(&*state, ImageReadiness::Checking | ImageReadiness::Building) {
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
    let current_bundle_id = bundle::load_current_bundle_manifest()
        .ok()
        .map(|m| m.bundle_id);
    bundle_status_from(&bundle::load_bundle_state(), current_bundle_id.as_deref())
}

fn bundle_status_from(
    state: &bundle::BundleState,
    current_bundle_id: Option<&str>,
) -> BundleReconcileStatus {
    let bundle_changed = current_bundle_id
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
    list_running_projects_with(rt, user_config, |p| {
        speedwave_runtime::runtime::project_has_compose_file(p)
    })
}

/// Core with an injectable compose.yml-presence probe so tests drive it
/// against a mock runtime without touching the real data dir.
fn list_running_projects_with(
    rt: &speedwave_runtime::runtime::LockedRuntime,
    user_config: &config::SpeedwaveUserConfig,
    has_compose_file: impl Fn(&str) -> bool,
) -> Result<Vec<String>, String> {
    let mut running = Vec::new();
    for project in &user_config.projects {
        // No rendered compose.yml (deferred start / interrupted init) means the
        // project cannot be running — compose_ps would fatally error on it.
        if !has_compose_file(&project.name) {
            log::debug!(
                "no compose.yml for '{}' — treating as not running",
                project.name
            );
            continue;
        }
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
    // A background teardown of this project (mid-session switch) must finish
    // before the restore, or it would kill the freshly restored containers.
    crate::containers_cmd::wait_for_pending_teardown(project);
    // Build OUTSIDE the lock (ADR-066): bundle + plugin images. Errors are already
    // condensed + sanitized inside ensure_project_images_built before this `?`.
    crate::integrations_cmd::ensure_project_images_built(rt, project)?;

    use crate::types::IntoAnyhow;
    rt.transaction(project, |rt| -> anyhow::Result<()> {
        let _ = rt.compose_down(project);
        crate::containers_cmd::render_and_save_compose(project).into_anyhow()?;
        speedwave_runtime::runtime::compose_validate_with_retry(rt, project)?;
        rt.compose_up_recreate(project)
            .map_err(|e| anyhow::anyhow!("compose_up_recreate failed for '{project}': {e}"))?;
        Ok(())
    })
    // `{e:#}` keeps the whole context chain (an os error alone is undiagnosable);
    // condense to a bounded banner, then sanitize before the string crosses IPC
    // (chains carry nerdctl argv echoes, and engine failures can be unbounded).
    .map_err(|e| {
        speedwave_runtime::log_sanitizer::sanitize(&build::condense_engine_error(&format!("{e:#}")))
    })
}

/// Skip verdict for one project in a restore batch: `Permanent` drops it from
/// the pending list, `Deferred` keeps it there for the next reconcile.
#[derive(Debug, PartialEq, Eq)]
enum RestoreSkip {
    Permanent(String),
    Deferred(String),
}

fn restore_skip_reason(
    user_config: &config::SpeedwaveUserConfig,
    data_dir: &std::path::Path,
    project: &str,
) -> Option<RestoreSkip> {
    let Some(entry) = user_config.projects.iter().find(|p| p.name == project) else {
        return Some(RestoreSkip::Permanent("not in config".to_string()));
    };
    // NotFound may be a deletion OR an unmounted volume — defer, never drop;
    // permission errors don't skip (restore surfaces the TCC remediation).
    match std::fs::metadata(&entry.dir) {
        Ok(meta) if !meta.is_dir() => {
            return Some(RestoreSkip::Deferred(format!(
                "project dir '{}' is not a directory",
                entry.dir
            )));
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Some(RestoreSkip::Deferred(format!(
                "project dir '{}' not found (deleted or volume not mounted)",
                entry.dir
            )));
        }
        _ => {}
    }
    if !crate::auth_commands::project_llm_configured_in(data_dir, user_config, project) {
        return Some(RestoreSkip::Permanent(
            "no LLM provider configured".to_string(),
        ));
    }
    None
}

/// Restore loop core: skips per the verdict, returns the Deferred projects so
/// callers persist them as still-pending; restore errors abort for retry.
fn restore_batch(
    projects: &[String],
    skip_of: impl Fn(&str) -> Option<RestoreSkip>,
    mut restore_one: impl FnMut(&str) -> Result<(), String>,
) -> Result<Vec<String>, String> {
    let mut retained = Vec::new();
    for project in projects {
        match skip_of(project) {
            Some(RestoreSkip::Permanent(reason)) => {
                log::warn!("dropping project '{project}' from restore — {reason}");
                continue;
            }
            Some(RestoreSkip::Deferred(reason)) => {
                log::warn!("deferring restore of project '{project}' — {reason}");
                retained.push(project.clone());
                continue;
            }
            None => {}
        }
        // Substitute CloudStorage TCC prefix before the error escapes this function.
        if let Err(e) = restore_one(project) {
            if e.starts_with(speedwave_runtime::consts::CLOUDSTORAGE_TCC_PREFIX) {
                log::warn!("CloudStorage TCC permission required (raw prefix): {e}");
                return Err(
                    speedwave_runtime::cloudstorage::TCC_USER_REMEDIATION_MESSAGE.to_string(),
                );
            }
            return Err(e);
        }
    }
    Ok(retained)
}

pub(crate) fn restore_projects(
    projects: &[String],
    rt: &speedwave_runtime::runtime::LockedRuntime,
) -> Result<Vec<String>, String> {
    let data_dir = speedwave_runtime::consts::data_dir();
    // One load for the whole batch: restore_skip_reason still re-checks each
    // project's dir on disk, so a mid-batch directory deletion is still caught.
    let cfg = config::load_user_config().unwrap_or_default();
    restore_batch(
        projects,
        |p| restore_skip_reason(&cfg, data_dir, p),
        |p| restore_one_project(p, rt),
    )
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

/// Resets the bundle phase and closes the readiness gate for a rebuild.
/// Must run before any slow work (VM start, image build).
fn prepare_rebuild(
    state: &mut bundle::BundleState,
    app_handle: &tauri::AppHandle,
) -> Result<(), String> {
    log::info!(
        "rebuild needed, starting reconcile (phase={:?})",
        state.phase,
    );
    // New bundle = full reconciliation from scratch. Reset phase so all
    // is_before() gates evaluate to true and every step executes.
    if state.phase != bundle::BundleReconcilePhase::Pending {
        log::info!("resetting reconcile phase to Pending for new bundle");
        state.phase = bundle::BundleReconcilePhase::Pending;
        bundle::save_bundle_state(state).map_err(|e| e.to_string())?;
    }
    // Signal Building so start_containers/switch_project callers block until done.
    BUNDLE_RECONCILE_PHASE.store(RECONCILE_REBUILDING, Ordering::Relaxed);
    set_image_readiness(ImageReadiness::Building);
    emit_bundle_status(app_handle);
    Ok(())
}

/// `true` if the installed reconcile id differs from the applied one — decided
/// WITHOUT starting the VM, so the gate can close before any slow work (#781).
fn reconcile_id_changed(state: &bundle::BundleState, manifest: &bundle::BundleManifest) -> bool {
    state.applied_bundle_id.as_deref() != Some(manifest.bundle_id.as_str())
}

/// INVARIANT: `ensure_ready()` must NOT be gated behind `is_available()`.
/// Behavioral test: `lima.rs` → `test_ensure_ready_stopped_vm_starts_it`.
fn reconcile_bundle_update_inner(app_handle: &tauri::AppHandle) -> Result<(), String> {
    log::info!("loading current bundle manifest");
    let manifest = bundle::load_current_bundle_manifest().map_err(|e| {
        let msg = format!("Failed to load bundle manifest: {e}");
        log::error!("{msg}");
        msg
    })?;

    let mut state = bundle::load_bundle_state();

    log::info!(
        "reconciling bundle: current={} applied={}",
        manifest.bundle_id,
        state.applied_bundle_id.as_deref().unwrap_or("(none)"),
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
                log::warn!("active_project '{name}' not in config — building core only");
                config::ResolvedIntegrationsConfig::default()
            }
        },
        None => config::ResolvedIntegrationsConfig::default(),
    };

    let rt = speedwave_runtime::runtime::detect_runtime();

    // Reconcile-id change is decided without starting the VM, so the gate closes
    // before any slow work (#781). The images-missing fallback needs a probe.
    if reconcile_id_changed(&state, &manifest) {
        // Gate first, then the slow ensure_ready (VM start) — closes the
        // start_containers vs rebuild race ("image not available", #781).
        prepare_rebuild(&mut state, app_handle)?;
        rt.ensure_ready().map_err(|e| {
            set_bundle_error(
                &mut state,
                format!("Runtime is not ready while applying the new bundle: {e}"),
            )
        })?;
    } else if state.phase.is_before(bundle::BundleReconcilePhase::Done) {
        // Previous reconcile was interrupted; resources on disk may reflect a
        // different app version, so force a full re-reconcile (ADR-072).
        log::warn!(
            "bundle id unchanged but phase={:?} — \
             previous reconcile was interrupted, forcing re-reconcile",
            state.phase,
        );
        prepare_rebuild(&mut state, app_handle)?;
        rt.ensure_ready().map_err(|e| {
            set_bundle_error(
                &mut state,
                format!("Runtime is not ready while re-reconciling after interrupted update: {e}"),
            )
        })?;
    } else {
        // Id matches and previous reconcile completed (phase=Done). Restore stopped
        // projects, open the gate, then repair missing images (needs a running VM, ADR-072).
        let mut retained: Vec<String> = Vec::new();
        if !state.pending_running_projects.is_empty() {
            match rt.ensure_ready() {
                Ok(()) => {
                    let pending = state.pending_running_projects.clone();
                    log::info!(
                        "bundle unchanged, restoring {} stopped project(s)",
                        pending.len()
                    );
                    retained = restore_projects(&pending, &rt).map_err(|e| {
                        let msg = format!("Project restore failed: {e}");
                        log::error!("{msg}");
                        set_bundle_error(&mut state, msg)
                    })?;
                }
                Err(e) => {
                    // Keep pending_running_projects so the next launch retries.
                    log::warn!(
                        "{} project(s) pending restore but runtime not ready \
                         ({e}) — will retry next launch",
                        state.pending_running_projects.len()
                    );
                    set_image_readiness(ImageReadiness::Ready);
                    emit_bundle_status(app_handle);
                    return Ok(());
                }
            }
        }
        // Persist the deferred remainder (e.g. unmounted volume) so the next
        // launch retries it; drop the rest along with any stale error.
        if state.last_error.is_some() || state.pending_running_projects != retained {
            log::info!("bundle matches but reconcile state dirty, cleaning up");
            state.last_error = None;
            state.pending_running_projects = retained;
            bundle::save_bundle_state(&state).map_err(|e| e.to_string())?;
        }
        // Open the gate immediately: nothing needs rebuilding, and auth/chat
        // callers must not wait behind a VM start.
        log::info!("no reconcile changes needed, setting images Ready");
        set_image_readiness(ImageReadiness::Ready);
        emit_bundle_status(app_handle);

        // Converge crash-orphans: only projects whose recorded background teardown
        // never finished. Never ps-diff against active_project.
        match config::load_user_config() {
            Ok(cfg) => {
                for project in crate::containers_cmd::crashed_teardown_intents() {
                    if cfg.active_project.as_deref() == Some(project.as_str()) {
                        // The active project is (re)started right after reconcile —
                        // an interrupted teardown converges via that idempotent up.
                        continue;
                    }
                    log::info!("converging crash-interrupted teardown of '{project}'");
                    crate::containers_cmd::spawn_background_teardown(project);
                }
            }
            // Unknown active project — a teardown could race the post-reconcile
            // start. Intents persist, so the next launch retries convergence.
            Err(e) => {
                log::warn!("skipping teardown convergence, config unreadable: {e}");
            }
        }

        // Repair: images may be gone after containerd reinstall/VM recreation;
        // needs a running VM, so it runs after the gate opened (#781).
        match rt.ensure_ready() {
            Ok(()) => {
                if build::images_exist(&rt, &active_integrations) {
                    return Ok(());
                }
                log::warn!("bundle unchanged but images missing, forcing rebuild");
                prepare_rebuild(&mut state, app_handle)?;
            }
            Err(e) => {
                log::warn!("runtime not ready for reconcile: {e}");
                return Ok(());
            }
        }
    }

    let build_root = build::resolve_build_root().map_err(|e| {
        let msg = format!("Failed to resolve build root: {e}");
        log::error!("{msg}");
        msg
    })?;
    log::info!("resolved build_root={}", build_root.display());

    if state
        .phase
        .is_before(bundle::BundleReconcilePhase::ResourcesSynced)
    {
        // Sync atomically replaces the mounted resources dir; stop running projects first (ADR-072).
        if rt.is_available() {
            if let Ok(cfg) = config::load_user_config() {
                if let Ok(running) = list_running_projects(&rt, &cfg) {
                    if !running.is_empty() {
                        for p in &running {
                            if !state.pending_running_projects.contains(p) {
                                state.pending_running_projects.push(p.clone());
                            }
                        }
                        state.pending_running_projects.sort();
                        state.pending_running_projects.dedup();
                        bundle::save_bundle_state(&state).map_err(|e| e.to_string())?;
                        log::info!(
                            "stopping {} running project(s) before resources sync",
                            running.len()
                        );
                        if let Err(e) = stop_projects(&running, &rt) {
                            log::warn!("pre-sync project stop incomplete: {e}");
                        }
                    }
                }
            }
        }
        log::info!("syncing claude-resources");
        bundle::sync_claude_resources(&build_root).map_err(|e| {
            set_bundle_error(&mut state, format!("Claude resources sync failed: {e}"))
        })?;
        state.phase = bundle::BundleReconcilePhase::ResourcesSynced;
        state.last_error = None;
        bundle::save_bundle_state(&state).map_err(|e| e.to_string())?;
        log::info!("claude-resources synced");
        emit_bundle_status(app_handle);
    }

    if state
        .phase
        .is_before(bundle::BundleReconcilePhase::ImagesBuilt)
    {
        log::info!("building images for bundle {}", manifest.bundle_id,);
        // Old-bundle prune runs at the end of reconcile (after ProjectsRestored)
        // for atomicity (ADR-072). On failure: restart engine, retry build.
        let enabled = build::enabled_images(&active_integrations);
        // Missing-only under the build lock — a present per-image tag is
        // already the exact build this manifest needs (ADR-072).
        match build::build_missing_images_locked(&rt, &enabled, &manifest) {
            Ok(built) => {
                let skipped = enabled.len() as u32 - built;
                if skipped > 0 {
                    log::info!(
                        "built {built} image(s), \
                         {skipped} already present for bundle {}",
                        manifest.bundle_id
                    );
                }
            }
            Err(e)
                if e.downcast_ref::<build::SnapshotterRecoveryFailed>()
                    .is_some() =>
            {
                log::warn!("snapshotter recovery failed, restarting engine");
                rt.restart_container_engine().map_err(|re| {
                    let msg = log_sanitizer::sanitize(&format!(
                        "Engine restart failed: {}",
                        build::condense_engine_error(&format!("{re:#}"))
                    ));
                    log::error!("{msg}");
                    set_bundle_error(&mut state, msg)
                })?;
                build::build_missing_images_locked(&rt, &enabled, &manifest).map_err(|e| {
                    let msg = log_sanitizer::sanitize(&format!(
                        "Image rebuild failed after engine restart: {}",
                        build::condense_engine_error(&format!("{e:#}"))
                    ));
                    log::error!("{msg}");
                    set_bundle_error(&mut state, msg)
                })?;
            }
            Err(e) => {
                // Full BuildKit output goes to the log; the banner gets the condensed,
                // sanitized cause (chains carry nerdctl argv echoes incl. tokens).
                log::error!("Image rebuild failed: {e:#}");
                let msg = log_sanitizer::sanitize(&format!(
                    "Image rebuild failed: {}",
                    build::condense_engine_error(&format!("{e:#}"))
                ));
                return Err(set_bundle_error(&mut state, msg));
            }
        }
        // Plugin images enabled in the active project (warn-only).
        let enabled_plugins: Vec<&str> = active_integrations.enabled_plugin_service_ids();
        if let Err(e) = plugin::ensure_plugin_images(&rt, &enabled_plugins) {
            log::warn!("failed to rebuild some plugin images: {e}");
        }
        // Drop tags from this bundle that no longer belong to enabled set (warn-only).
        if let Err(e) = build::prune_orphan_current_bundle_images_locked(&rt, &manifest, &enabled) {
            log::warn!("orphan-tag prune failed: {e}");
        }

        state.phase = bundle::BundleReconcilePhase::ImagesBuilt;
        state.last_error = None;
        bundle::save_bundle_state(&state).map_err(|e| e.to_string())?;

        set_image_readiness(ImageReadiness::Ready);
        log::info!("all images built, waiters unblocked");
        emit_bundle_status(app_handle);

        // After heavy image builds, containerd may be degraded. Re-check readiness
        // before querying running containers.
        rt.ensure_ready().map_err(|e| {
            let msg = format!("Runtime not ready after image build: {e}");
            log::error!("{msg}");
            set_bundle_error(&mut state, msg)
        })?;
    }

    let user_config = match config::load_user_config() {
        Ok(config) => config,
        Err(e) => {
            log::warn!("failed to load user config, using pending list only: {e}");
            config::SpeedwaveUserConfig::default()
        }
    };

    // Converge crash-interrupted teardowns before restoring projects (id-changed path).
    for project in crate::containers_cmd::crashed_teardown_intents() {
        if user_config.active_project.as_deref() == Some(project.as_str()) {
            continue; // active project is re-started right after — idempotent up converges it
        }
        if state.pending_running_projects.contains(&project) {
            continue; // about to restore it — teardown would race the restore
        }
        log::info!("converging crash-interrupted teardown of '{project}' (id-changed path)");
        crate::containers_cmd::spawn_background_teardown(project);
    }

    let mut projects = state.pending_running_projects.clone();
    let running_projects = list_running_projects(&rt, &user_config)?;
    for project in running_projects {
        if !projects.contains(&project) {
            projects.push(project);
        }
    }
    projects.sort();
    projects.dedup();
    log::info!("projects to restore: {:?}", projects,);

    let mut deferred: Vec<String> = Vec::new();
    if state
        .phase
        .is_before(bundle::BundleReconcilePhase::ProjectsRestored)
    {
        // Persist the merged set FIRST: a failed restore must not drop an
        // already-downed project from the next attempt's list.
        state.pending_running_projects = projects.clone();
        bundle::save_bundle_state(&state).map_err(|e| e.to_string())?;
        log::info!("restoring {} project(s)", projects.len());
        deferred = restore_projects(&projects, &rt).map_err(|e| {
            let msg = format!("Project restore failed: {e}");
            log::error!("{msg}");
            set_bundle_error(&mut state, msg)
        })?;
        state.phase = bundle::BundleReconcilePhase::ProjectsRestored;
        state.pending_running_projects = projects;
        state.last_error = None;
        bundle::save_bundle_state(&state).map_err(|e| e.to_string())?;
        log::info!("projects restored");
        emit_bundle_status(app_handle);
    }

    // Prune superseded images only after every earlier phase succeeded (ADR-072).
    build::prune_superseded_images(
        &rt,
        &state.applied_image_hashes,
        state.applied_bundle_id.as_deref(),
        &manifest,
    );

    state.applied_bundle_id = Some(manifest.bundle_id.clone());
    state.applied_image_hashes = manifest.image_hashes.clone();
    state.phase = bundle::BundleReconcilePhase::Done;
    // Deferred restores (e.g. unmounted volume) stay pending for the next launch.
    state.pending_running_projects = deferred;
    state.last_error = None;
    bundle::save_bundle_state(&state).map_err(|e| e.to_string())?;
    emit_bundle_status(app_handle);

    log::info!("reconcile complete, applied={}", manifest.bundle_id,);
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
        log::debug!("bundle reconcile already running, skipping");
        emit_bundle_status(app_handle);
        return;
    }

    log::info!("starting bundle reconcile");

    // Close the gate before the spawn so start_containers cannot race the
    // rebuild decision; no status emit — UI shows overlay only for Building.
    set_image_readiness(ImageReadiness::Checking);

    let handle = app_handle.clone();
    std::thread::spawn(move || {
        // Scope guard: if this thread exits without signaling Ready or Failed,
        // transition Building->Failed and wake all waiters.
        let _guard = ImageReadinessGuard;

        // catch_unwind so panics produce a specific error message and explicit
        // Failed signaling.
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            reconcile_bundle_update_inner(&handle)
        }));

        match result {
            Ok(Ok(())) => {
                log::info!("bundle reconcile thread finished successfully");
            }
            Ok(Err(e)) => {
                log::error!("bundle reconcile failed: {e}");
                set_image_readiness(ImageReadiness::Failed(e));
            }
            Err(panic_info) => {
                let msg = speedwave_runtime::log_sanitizer::panic_payload_to_string(&*panic_info);
                log::error!("bundle reconcile panicked: {msg}");
                set_image_readiness(ImageReadiness::Failed(format!("reconcile panicked: {msg}")));
            }
        }

        BUNDLE_RECONCILE_PHASE.store(RECONCILE_IDLE, Ordering::Relaxed);
        emit_bundle_status(&handle);
    });
}

/// When running containers have a stale `WORKER_OS_URL`, regenerate compose and recreate
/// them so the hub connects to the new mcp-os port. Background thread, per-project lock.
pub(crate) fn reconcile_compose_port(app_handle: &tauri::AppHandle) {
    let handle = app_handle.clone();
    std::thread::spawn(move || {
        let project = match config::load_user_config()
            .ok()
            .and_then(|c| c.active_project)
        {
            Some(p) => p,
            None => {
                log::debug!("no active project, skipping compose port reconcile");
                return;
            }
        };

        let rt = speedwave_runtime::runtime::detect_runtime();
        if !rt.is_available() {
            log::debug!("runtime not available, skipping compose port reconcile");
            return;
        }

        // Check if containers are running
        let containers = match rt.compose_ps(&project) {
            Ok(c) => c,
            Err(e) => {
                log::debug!("compose_ps failed while reconciling compose port: {e}");
                return;
            }
        };
        if containers.is_empty() {
            log::debug!("no containers running, skipping compose port reconcile");
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
                log::debug!("mcp-os lock.json missing or invalid, skipping compose port reconcile");
                return;
            }
        };

        let compose_dir = data_dir.join("compose").join(&project);
        let compose_path = compose_dir.join("compose.yml");
        let compose_content = match std::fs::read_to_string(&compose_path) {
            Ok(c) => c,
            Err(e) => {
                log::debug!("compose file read error, skipping compose port reconcile: {e}");
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
            log::debug!("no WORKER_OS_URL in compose, OS integration not enabled");
            return;
        }

        // ensure_images_ready runs outside the transaction — long-running and idempotent.
        if let Err(e) = crate::containers_cmd::ensure_images_ready() {
            log::warn!("images not ready, skipping compose port reconcile: {e}");
            return;
        }

        // Build OUTSIDE the lock (ADR-066): plugin images for this project.
        if let Err(e) = crate::integrations_cmd::ensure_project_images_built(&rt, &project) {
            log::warn!("project images not built, skipping compose port reconcile: {e}");
            return;
        }

        // Per-project compose lock serialises this with start_chat /
        // restart_integration_containers / update_containers.
        use crate::types::IntoAnyhow;
        let result = rt.transaction(&project, |rt| -> anyhow::Result<()> {
            crate::containers_cmd::render_and_save_compose(&project).into_anyhow()?;
            speedwave_runtime::runtime::compose_validate_with_retry(rt, &project)?;
            rt.compose_up_recreate(&project)?;
            Ok(())
        });
        if let Err(e) = result {
            log::error!("compose port reconcile failed: {e}");
            return;
        }

        log::info!("containers recreated with mcp-os port {current_port}");

        use tauri::Emitter;
        let _ = handle.emit("containers_reconciled", current_port);
    });
}

/// Stop containers for all projects (best-effort), aborting early if a CLI
/// session appears mid-loop. Windows-only (ADR-062); macOS reaps via VM poweroff.
#[cfg(target_os = "windows")]
fn stop_all_containers(
    rt: &speedwave_runtime::runtime::LockedRuntime,
    projects: &[config::ProjectUserEntry],
    data_dir: &std::path::Path,
) -> bool {
    for project in projects {
        if speedwave_runtime::session::any_cli_session_active(data_dir) {
            log::info!(
                "live speedwave CLI session appeared mid-cleanup — \
                 aborting remaining teardown, leaving the VM running"
            );
            return false;
        }
        log::info!("stopping containers for '{}' on exit", project.name);
        if let Err(e) = rt.compose_down(&project.name) {
            log::warn!(
                "compose_down failed for '{}' during exit cleanup: {e}",
                project.name
            );
        }
    }
    true
}

/// Stops all containers and the VM (best-effort). Re-probes the CLI session lock
/// immediately before `stop_vm()`, catching one that starts mid-cleanup.
pub(crate) fn run_container_cleanup(
    rt: &speedwave_runtime::runtime::LockedRuntime,
    projects: &[config::ProjectUserEntry],
    data_dir: &std::path::Path,
) {
    if speedwave_runtime::session::any_cli_session_active(data_dir) {
        log::info!("live speedwave CLI session — leaving containers and VM running on exit");
        return;
    }
    #[cfg(target_os = "windows")]
    if !stop_all_containers(rt, projects, data_dir) {
        return;
    }
    #[cfg(target_os = "macos")]
    log::info!(
        "skipping per-project compose_down for {} project(s) on exit \
         — VM shutdown below will kill all containers",
        projects.len()
    );
    if speedwave_runtime::session::any_cli_session_active(data_dir) {
        log::info!("live speedwave CLI session appeared mid-cleanup — leaving the VM running");
        return;
    }
    if let Err(e) = rt.stop_vm() {
        log::warn!("stop_vm failed during exit cleanup: {e}");
    }
}

/// Runs cleanup on exit: stops containers, VM, IDE Bridge, mcp-os, and aborts
/// the auto-update check. Guarded by `CLEANUP_ONCE`; idempotent.
#[must_use = "join the returned handle before process exit, or VM cleanup will be killed mid-flight"]
pub(crate) fn run_exit_cleanup(ctx: &ExitCleanupContext) -> Option<std::thread::JoinHandle<()>> {
    static CLEANUP_ONCE: AtomicBool = AtomicBool::new(false);
    if CLEANUP_ONCE.swap(true, Ordering::SeqCst) {
        return None;
    }

    crate::WATCHDOG_STOP.store(true, std::sync::atomic::Ordering::Relaxed);
    crate::OAUTH_WATCHDOG_STOP.store(true, std::sync::atomic::Ordering::Relaxed);
    // A graceful exit must not race an in-flight background teardown —
    // join them all before the container cleanup below.
    crate::containers_cmd::drain_pending_teardowns();

    let ide_bridge = ctx.ide_bridge.clone();
    let plugin_bridges = ctx.plugin_bridges.clone();
    let mcp_os = ctx.mcp_os.clone();
    let oauth = ctx.oauth.clone();
    let auto_check = ctx.auto_check_handle.clone();

    let handle = std::thread::spawn(move || {
        // Container + VM cleanup. stop_vm() runs unconditionally because it
        // does not need the project list — only compose_down does.
        let rt = speedwave_runtime::runtime::detect_runtime();
        let projects = match config::load_user_config() {
            Ok(user_config) => user_config.projects,
            Err(e) => {
                log::warn!("failed to load config on exit, skipping container stop: {e}");
                Vec::new()
            }
        };
        run_container_cleanup(&rt, &projects, speedwave_runtime::consts::data_dir());

        // Host process cleanup
        match ide_bridge.lock() {
            Ok(mut guard) => {
                if let Some(mut bridge) = guard.take() {
                    if let Err(e) = bridge.stop() {
                        log::warn!("IDE Bridge stop error: {e}");
                    }
                }
            }
            Err(e) => log::warn!("IDE Bridge cleanup skipped, mutex poisoned: {e}"),
        }
        match plugin_bridges.lock() {
            Ok(mut map) => {
                for (slug, mut bridge) in map.drain() {
                    if let Err(e) = bridge.stop() {
                        log::warn!("plugin bridge '{slug}' stop error: {e}");
                    }
                }
            }
            Err(e) => log::warn!("plugin bridges cleanup skipped, mutex poisoned: {e}"),
        }
        match mcp_os.lock() {
            Ok(mut guard) => {
                if let Some(proc) = guard.take() {
                    let port = stop_worker("mcp-os", proc);
                    // Symmetric with HostBridge::stop — drop the guest relay (ADR-080).
                    crate::mirror_relay::remove_relay_for_port(port);
                }
            }
            Err(e) => log::warn!("mcp-os cleanup skipped, mutex poisoned: {e}"),
        }
        match oauth.lock() {
            Ok(mut map) => {
                for (project, proc) in map.drain() {
                    let port = stop_worker(&format!("oauth[{project}]"), proc);
                    // Symmetric with the relay ensured at oauth spawn (ADR-080).
                    crate::mirror_relay::remove_relay_for_port(port);
                }
            }
            Err(e) => log::warn!("oauth cleanup skipped, map mutex poisoned: {e}"),
        }
        match auto_check.lock() {
            Ok(mut guard) => {
                if let Some(handle) = guard.take() {
                    handle.abort();
                    log::info!("auto-update check task cancelled on exit");
                }
            }
            Err(e) => log::warn!("auto-update check cleanup skipped, mutex poisoned: {e}"),
        }
    });
    Some(handle)
}

/// Stops a host worker and removes its lock/token files, returning its port so the
/// caller can tear down the guest relay (sync on exit paths, async in watchdogs).
pub(crate) fn stop_worker<S: speedwave_runtime::host_mcp_process::WorkerSpec>(
    label: &str,
    mut proc: speedwave_runtime::host_mcp_process::HostMcpProcess<S>,
) -> u16 {
    let port = proc.port();
    if let Err(e) = proc.stop() {
        log::warn!("{label} stop error: {e}");
    }
    proc.cleanup_files();
    port
}

/// Resolves the bundled resources directory from the executable's parent path
/// (macOS: `../Resources`; Windows: `exe_parent` or `resources/`). `None` in dev.
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

    // Check for bundled files to distinguish a resource dir from an empty exe_parent.
    // Windows: check cli/<cli_binary_filename> (the binary); Unix: check cli/ dir.
    candidates.into_iter().find(|p| {
        let has_cli = if cfg!(target_os = "windows") {
            p.join("cli")
                .join(speedwave_runtime::consts::cli_binary_filename(true))
                .exists()
        } else {
            p.join("cli").exists()
        };
        has_cli || p.join("mcp-os").exists() || p.join("build-context").exists()
    })
}

// ── Tests ───────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "test assertions may unwrap/expect freely"
)]
mod tests {
    use super::*;

    #[test]
    fn container_cleanup_skips_teardown_while_cli_session_live() {
        // A separate CLI terminal session shares the VM; exit cleanup must not
        // power it off out from under it (shared-lock probe, session::cli_lock).
        let source = include_str!("reconcile.rs");
        let fn_start = source
            .find("fn run_container_cleanup(")
            .expect("run_container_cleanup must exist");
        let body = &source[fn_start..fn_start + 1200];
        let probe = body
            .find("any_cli_session_active(")
            .expect("cleanup must probe for live CLI sessions");
        let stop = body.find("stop_vm()").expect("cleanup must stop the VM");
        assert!(probe < stop, "CLI-session probe must gate the VM stop");
    }

    #[test]
    fn running_projects_are_stopped_before_resources_sync() {
        let source = include_str!("reconcile.rs");
        let stop_pos = source
            .find("stopping {} running project(s) before resources sync")
            .expect("pre-sync stop must exist");
        let sync_pos = source
            .find("syncing claude-resources")
            .expect("sync log must exist");
        assert!(
            stop_pos < sync_pos,
            "sync replaces live bind-mounted dirs — projects must stop first"
        );
    }

    // The teardown-join happens before ensure_project_images_built, whose own
    // errors are condensed+sanitized before the `?` here propagates — so this
    // early-return path is bounded transitively, not by a check in this function.
    #[test]
    fn restore_one_project_joins_pending_teardown_first() {
        let source = include_str!("reconcile.rs");
        let fn_start = source
            .find("fn restore_one_project(")
            .expect("restore_one_project must exist");
        let body = &source[fn_start..fn_start + 1200];
        let wait_pos = body
            .find("wait_for_pending_teardown")
            .expect("restore must join an in-flight teardown of the project");
        let build_pos = body
            .find("ensure_project_images_built")
            .expect("restore must build images");
        assert!(
            wait_pos < build_pos,
            "teardown join must precede any restore work"
        );
        let tail = &source[fn_start..fn_start + 1600];
        assert!(
            tail.contains("log_sanitizer::sanitize"),
            "restore errors cross IPC — the chain must be sanitized, not just flattened"
        );
        assert!(
            tail.contains("condense_engine_error"),
            "restore errors must be condensed to a bounded banner before crossing IPC"
        );
    }

    /// The no-provider guard lives in restore_skip_reason — the single skip
    /// decision restore_projects consults before any restore render.
    #[test]
    fn restore_projects_skips_unconfigured_projects_before_restoring() {
        let source = include_str!("reconcile.rs");
        let skip_start = source
            .find("fn restore_skip_reason(")
            .expect("restore_skip_reason must exist");
        let restore_start = source
            .find("pub(crate) fn restore_projects(")
            .expect("restore_projects must exist");
        assert!(
            source[skip_start..restore_start].contains("project_llm_configured_in"),
            "no-provider guard must live in restore_skip_reason (reconcile must not wedge)"
        );
    }

    #[test]
    fn restore_set_is_persisted_before_restore_projects() {
        let source = include_str!("reconcile.rs");
        let anchor = source
            .find("Persist the merged set FIRST")
            .expect("restore-set persist must exist");
        let window = &source[anchor..anchor + 700];
        let save_pos = window.find("save_bundle_state").expect("must save state");
        let restore_pos = window
            .find("restore_projects(&projects")
            .expect("must restore");
        assert!(
            save_pos < restore_pos,
            "a failed restore must not drop already-downed projects from the retry list"
        );
    }

    #[test]
    fn exit_cleanup_drains_background_teardowns() {
        let source = include_str!("reconcile.rs");
        let fn_start = source
            .find("pub(crate) fn run_exit_cleanup(")
            .expect("run_exit_cleanup must exist");
        let body = &source[fn_start..fn_start + 1500];
        assert!(
            body.contains("drain_pending_teardowns"),
            "graceful exit must join in-flight teardowns before container cleanup"
        );
    }

    #[test]
    fn no_change_branch_converges_only_recorded_teardown_intents() {
        let source = include_str!("reconcile.rs");
        assert!(
            source.contains("crashed_teardown_intents()"),
            "convergence must use persisted intents, never ps-vs-active diffing \
             (which killed legitimate CLI-run projects)"
        );
        // Split literal: include_str! sees this test too.
        let removed_marker = format!("converging {} project", "orphaned");
        assert!(
            !source.contains(&removed_marker),
            "the ps-diff orphan sweep must stay removed"
        );
    }

    #[test]
    fn teardown_convergence_skips_when_config_unreadable() {
        // An unreadable config must skip convergence entirely (fail closed).
        let source = include_str!("reconcile.rs");
        let anchor = source
            .find("Converge crash-orphans")
            .expect("convergence block must exist");
        let window = &source[anchor..anchor + 1400];
        let load_pos = window
            .find("match config::load_user_config()")
            .expect("convergence must branch on the config load result");
        let intents_pos = window
            .find("crashed_teardown_intents()")
            .expect("convergence must read persisted intents");
        assert!(
            load_pos < intents_pos,
            "config must be resolved once, before iterating intents"
        );
        assert!(
            window.contains("skipping teardown convergence"),
            "the Err arm must skip convergence instead of tearing down blindly"
        );
    }

    #[test]
    fn id_changed_branch_also_converges_teardown_intents() {
        // Crash-interrupted teardowns must converge in BOTH reconcile paths:
        // the no-change path (else branch) AND the id-changed path.
        let source = include_str!("reconcile.rs");

        // Find the id-changed convergence block — it uses the same call but the
        // comment says "id-changed path".
        let anchor = source
            .find("Converge crash-interrupted teardowns before restoring projects")
            .expect("id-changed convergence block must exist");
        let window = &source[anchor..anchor + 1500];
        assert!(
            window.contains("crashed_teardown_intents()"),
            "id-changed path must read persisted teardown intents"
        );
        assert!(
            window.contains("id-changed path"),
            "id-changed convergence block must be labelled so it is distinguishable from the no-change block"
        );
        assert!(
            window.contains("pending_running_projects.contains"),
            "id-changed convergence must skip projects about to be restored (teardown vs restore race)"
        );
    }
    use serial_test::serial;

    #[test]
    fn teardown_oauth_for_project_is_noop_when_absent() {
        let map: SharedOauth = SharedOauth::default();
        // No worker registered for "ghost" — must not panic.
        teardown_oauth_for_project(&map, "ghost");
        assert!(map.lock().unwrap().is_empty());
    }

    #[test]
    fn restore_one_project_wraps_full_sequence_in_transaction() {
        // Structural test: restore_one_project must wrap the whole compose sequence
        // in a single rt.transaction(project, ...).
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
        // Race guard: mcp-os respawn may race with bundle image rebuild. Anchor the
        // find on `pub(crate) fn` to skip the bare `fn ...` quoted inside tests.
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

    // stop_all_containers is compiled out on macOS; its tests are gated to match.
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
            let tmp = tempfile::tempdir().unwrap();

            let completed = stop_all_containers(&rt, &projects, tmp.path());

            assert!(completed, "no CLI session must run the full batch");
            assert_eq!(handles.down_projects(), vec!["alpha", "beta", "gamma"]);
        }

        #[test]
        fn empty_projects_is_noop() {
            let (rt, handles) = MockRuntimeBuilder::new().build();
            let tmp = tempfile::tempdir().unwrap();
            assert!(stop_all_containers(&rt, &[], tmp.path()));
            assert!(handles.down_projects().is_empty());
        }

        #[test]
        fn failure_does_not_abort_remaining_projects() {
            let (rt, handles) = MockRuntimeBuilder::new()
                .with_fail_on_down(&["beta"])
                .build();
            let projects = vec![project("alpha"), project("beta"), project("gamma")];
            let tmp = tempfile::tempdir().unwrap();

            let completed = stop_all_containers(&rt, &projects, tmp.path());

            assert!(completed);
            assert_eq!(
                handles.down_projects(),
                vec!["alpha", "beta", "gamma"],
                "all projects should be attempted even when one fails"
            );
        }

        /// A CLI session that appears between two compose_down calls must
        /// abort the remaining teardown.
        #[test]
        fn cli_session_appearing_mid_batch_aborts_remaining_teardown() {
            let (rt, handles) = MockRuntimeBuilder::new().build();
            let projects = vec![project("alpha"), project("beta"), project("gamma")];
            let tmp = tempfile::tempdir().unwrap();
            // No guard yet for "alpha"; acquire it right after, simulating a
            // CLI session starting while "alpha" is being torn down.
            let _cli = speedwave_runtime::session::CliSessionGuard::acquire(tmp.path()).unwrap();

            let completed = stop_all_containers(&rt, &projects, tmp.path());

            assert!(
                !completed,
                "mid-batch session must abort the remaining loop"
            );
            assert!(
                handles.down_projects().is_empty(),
                "the probe runs before the first compose_down too"
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
            // Runs on any non-macOS target.
            let (rt, handles) = MockRuntimeBuilder::new().build();
            let projects = vec![project("alpha"), project("beta")];
            let tmp = tempfile::tempdir().unwrap();
            run_container_cleanup(&rt, &projects, tmp.path());
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
            // On macOS the VM poweroff reaps containers, so per-project
            // compose_down is skipped.
            let (rt, handles) = MockRuntimeBuilder::new().build();
            let projects = vec![project("alpha"), project("beta")];
            let tmp = tempfile::tempdir().unwrap();
            run_container_cleanup(&rt, &projects, tmp.path());
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
            let tmp = tempfile::tempdir().unwrap();
            run_container_cleanup(&rt, &[], tmp.path());
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
            let tmp = tempfile::tempdir().unwrap();
            run_container_cleanup(&rt, &[], tmp.path());
            assert!(handles.down_projects().is_empty());
            assert_eq!(
                handles
                    .stop_vm_calls
                    .load(std::sync::atomic::Ordering::SeqCst),
                1,
                "stop_vm must run even with no projects"
            );
        }

        #[test]
        fn live_cli_session_skips_all_teardown() {
            let (rt, handles) = MockRuntimeBuilder::new().build();
            let tmp = tempfile::tempdir().unwrap();
            let _cli = speedwave_runtime::session::CliSessionGuard::acquire(tmp.path()).unwrap();
            run_container_cleanup(&rt, &[project("alpha")], tmp.path());
            assert!(
                handles.down_projects().is_empty(),
                "no compose_down while a CLI session is live"
            );
            assert_eq!(
                handles
                    .stop_vm_calls
                    .load(std::sync::atomic::Ordering::SeqCst),
                0,
                "the shared VM must keep running under a live CLI session"
            );
        }

        #[test]
        fn released_cli_session_allows_teardown() {
            let (rt, handles) = MockRuntimeBuilder::new().build();
            let tmp = tempfile::tempdir().unwrap();
            drop(speedwave_runtime::session::CliSessionGuard::acquire(tmp.path()).unwrap());
            run_container_cleanup(&rt, &[], tmp.path());
            assert_eq!(
                handles
                    .stop_vm_calls
                    .load(std::sync::atomic::Ordering::SeqCst),
                1,
                "teardown must proceed once the CLI session ended"
            );
        }

        #[cfg(target_os = "windows")]
        #[test]
        fn cli_session_appearing_during_compose_down_loop_skips_stop_vm() {
            // The entry probe passes (no guard yet); one appears before the
            // per-project loop can run — stop_vm must never fire under it.
            let (rt, handles) = MockRuntimeBuilder::new().build();
            let tmp = tempfile::tempdir().unwrap();
            let _cli = speedwave_runtime::session::CliSessionGuard::acquire(tmp.path()).unwrap();
            run_container_cleanup(&rt, &[project("alpha"), project("beta")], tmp.path());
            assert!(
                handles.down_projects().is_empty(),
                "the mid-loop probe must abort before any compose_down"
            );
            assert_eq!(
                handles
                    .stop_vm_calls
                    .load(std::sync::atomic::Ordering::SeqCst),
                0,
                "stop_vm must not run when the abort path was taken"
            );
        }

        /// Wiring: the session probe must be re-run immediately before
        /// stop_vm(), not only once at function entry.
        #[test]
        fn run_container_cleanup_reprobes_session_before_stop_vm() {
            let source = include_str!("reconcile.rs");
            let fn_start = source
                .find("pub(crate) fn run_container_cleanup(")
                .expect("run_container_cleanup must exist");
            let body = &source[fn_start..fn_start + 1500];
            let probe_count = body.matches("any_cli_session_active(data_dir)").count();
            assert!(
                probe_count >= 2,
                "run_container_cleanup must probe the CLI session more than once \
                 (entry + immediately before stop_vm)"
            );
            let stop_vm_pos = body
                .find("rt.stop_vm()")
                .expect("run_container_cleanup must call stop_vm");
            let last_probe_pos = body
                .rfind("any_cli_session_active(data_dir)")
                .expect("probe must exist");
            assert!(
                last_probe_pos < stop_vm_pos,
                "the last session probe must run before stop_vm()"
            );
        }
    }

    mod list_running_projects_tests {
        use super::list_running_projects_with;
        use speedwave_runtime::config::{ProjectUserEntry, SpeedwaveUserConfig};
        use speedwave_runtime::runtime::mock_runtime::MockRuntimeBuilder;

        fn config_with(names: &[&str]) -> SpeedwaveUserConfig {
            SpeedwaveUserConfig {
                projects: names
                    .iter()
                    .map(|n| ProjectUserEntry {
                        name: n.to_string(),
                        dir: "/tmp/fake".to_string(),
                        claude: None,
                        integrations: None,
                        plugin_settings: None,
                    })
                    .collect(),
                ..Default::default()
            }
        }

        /// Regression: a project whose compose.yml was never rendered
        /// (interrupted init) must be skipped, not fail the whole listing.
        #[test]
        fn skips_project_without_compose_file_instead_of_failing() {
            let (rt, handles) = MockRuntimeBuilder::new()
                .with_ps_error("limactl failed: open compose.yml: no such file or directory")
                .build();
            let cfg = config_with(&["orphaned"]);

            let running = list_running_projects_with(&rt, &cfg, |_| false)
                .expect("project without compose.yml must be skipped, not fatal");

            assert!(running.is_empty());
            assert!(
                handles.ps_projects().is_empty(),
                "compose_ps must not be called for a project without compose.yml"
            );
        }

        #[test]
        fn lists_only_projects_with_containers_and_probes_only_rendered_ones() {
            let (rt, handles) = MockRuntimeBuilder::new()
                .with_ps_response("active", vec![serde_json::json!({"Name": "claude"})])
                .build();
            let cfg = config_with(&["orphaned", "active", "idle"]);

            let running =
                list_running_projects_with(&rt, &cfg, |p| p != "orphaned").expect("must succeed");

            assert_eq!(running, vec!["active"]);
            assert_eq!(
                handles.ps_projects(),
                vec!["active", "idle"],
                "only projects with a rendered compose.yml may be probed"
            );
        }

        /// A compose_ps failure on a project WITH compose.yml still propagates.
        #[test]
        fn propagates_compose_ps_error_for_rendered_project() {
            let (rt, _handles) = MockRuntimeBuilder::new()
                .with_ps_error("engine down")
                .build();
            let cfg = config_with(&["active"]);

            let err = list_running_projects_with(&rt, &cfg, |_| true)
                .expect_err("real compose_ps failures must propagate");

            assert!(err.contains("compose_ps failed for 'active'"));
            assert!(err.contains("engine down"));
        }

        #[test]
        fn empty_config_yields_empty_list() {
            let (rt, handles) = MockRuntimeBuilder::new().build();
            let cfg = config_with(&[]);
            let running = list_running_projects_with(&rt, &cfg, |_| true).expect("must succeed");
            assert!(running.is_empty());
            assert!(handles.ps_projects().is_empty());
        }

        /// Wiring: the public wrapper must probe compose.yml presence via the
        /// runtime SSOT helper, not a hand-rolled path check.
        #[test]
        fn wrapper_wires_runtime_compose_file_probe() {
            let source = include_str!("reconcile.rs");
            let fn_start = source
                .find("pub(crate) fn list_running_projects(")
                .expect("list_running_projects must exist");
            let core_start = source
                .find("fn list_running_projects_with(")
                .expect("list_running_projects_with must exist");
            let wrapper = &source[fn_start..core_start];
            assert!(
                wrapper.contains("speedwave_runtime::runtime::project_has_compose_file"),
                "wrapper must pass the runtime project_has_compose_file probe"
            );
            assert!(
                !wrapper.contains("!speedwave_runtime::runtime::project_has_compose_file"),
                "the probe must keep positive polarity — a negation resurrects the fatal-update bug"
            );
        }
    }

    mod restore_skip_reason_tests {
        use super::restore_skip_reason;
        use speedwave_runtime::config::{
            ClaudeOverrides, LlmConfig, ProjectUserEntry, SpeedwaveUserConfig,
        };

        fn config_with_project(
            name: &str,
            dir: &str,
            provider: Option<&str>,
        ) -> SpeedwaveUserConfig {
            SpeedwaveUserConfig {
                projects: vec![ProjectUserEntry {
                    name: name.to_string(),
                    dir: dir.to_string(),
                    claude: provider.map(|p| ClaudeOverrides {
                        env: None,
                        settings: None,
                        llm: Some(LlmConfig {
                            provider: Some(p.to_string()),
                            ..Default::default()
                        }),
                    }),
                    integrations: None,
                    plugin_settings: None,
                }],
                ..Default::default()
            }
        }

        #[test]
        fn allows_fully_initialized_project() {
            let data = tempfile::tempdir().expect("tempdir");
            let proj = tempfile::tempdir().expect("tempdir");
            let cfg =
                config_with_project("acme", &proj.path().to_string_lossy(), Some("anthropic"));
            assert_eq!(restore_skip_reason(&cfg, data.path(), "acme"), None);
        }

        #[test]
        fn skips_project_missing_from_config() {
            let data = tempfile::tempdir().expect("tempdir");
            let cfg = SpeedwaveUserConfig::default();
            match restore_skip_reason(&cfg, data.path(), "ghost") {
                Some(super::super::RestoreSkip::Permanent(reason)) => {
                    assert!(reason.contains("not in config"), "got: {reason}");
                }
                other => panic!("config-less project must be a Permanent skip, got {other:?}"),
            }
        }

        /// Regression: NotFound may be an unmounted volume, not a deletion —
        /// the project must stay pending (Deferred), never drop permanently.
        #[test]
        fn defers_project_whose_dir_is_not_found() {
            let data = tempfile::tempdir().expect("tempdir");
            let gone = data.path().join("deleted-project");
            let cfg = config_with_project("acme", &gone.to_string_lossy(), Some("anthropic"));
            match restore_skip_reason(&cfg, data.path(), "acme") {
                Some(super::super::RestoreSkip::Deferred(reason)) => {
                    assert!(reason.contains("not found"), "got: {reason}");
                }
                other => panic!("NotFound dir must be a Deferred skip, got {other:?}"),
            }
        }

        #[test]
        fn defers_project_whose_dir_is_a_file() {
            let data = tempfile::tempdir().expect("tempdir");
            let file = data.path().join("not-a-dir");
            std::fs::write(&file, b"x").expect("write");
            let cfg = config_with_project("acme", &file.to_string_lossy(), Some("anthropic"));
            match restore_skip_reason(&cfg, data.path(), "acme") {
                Some(super::super::RestoreSkip::Deferred(reason)) => {
                    assert!(reason.contains("not a directory"), "got: {reason}");
                }
                other => panic!("non-directory path must be a Deferred skip, got {other:?}"),
            }
        }

        #[test]
        fn skips_project_without_llm_provider() {
            let data = tempfile::tempdir().expect("tempdir");
            let proj = tempfile::tempdir().expect("tempdir");
            let cfg = config_with_project("acme", &proj.path().to_string_lossy(), None);
            match restore_skip_reason(&cfg, data.path(), "acme") {
                Some(super::super::RestoreSkip::Permanent(reason)) => {
                    assert!(reason.contains("no LLM provider"), "got: {reason}");
                }
                other => panic!("provider-less project must be a Permanent skip, got {other:?}"),
            }
        }

        /// Permission errors must NOT skip: the restore attempt surfaces the
        /// CloudStorage TCC remediation instead of silently dropping the project.
        #[cfg(unix)]
        #[test]
        fn does_not_skip_on_permission_denied() {
            use std::os::unix::fs::PermissionsExt;
            let data = tempfile::tempdir().expect("tempdir");
            let parent = data.path().join("locked");
            let proj = parent.join("proj");
            std::fs::create_dir_all(&proj).expect("mkdir");
            std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o000))
                .expect("chmod");
            let cfg = config_with_project("acme", &proj.to_string_lossy(), Some("anthropic"));
            let result = restore_skip_reason(&cfg, data.path(), "acme");
            std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o700))
                .expect("chmod back");
            assert_eq!(result, None, "permission-denied dir must attempt restore");
        }

        /// Wiring: restore_projects must consult the skip guard before any
        /// restore attempt — one dead project must not abort the batch.
        #[test]
        fn restore_projects_wires_skip_guard_before_restore() {
            let source = include_str!("reconcile.rs");
            let fn_start = source
                .find("pub(crate) fn restore_projects(")
                .expect("restore_projects must exist");
            let body = &source[fn_start..];
            let skip_pos = body
                .find("restore_skip_reason(")
                .expect("restore_projects must call restore_skip_reason");
            let restore_pos = body
                .find("restore_one_project(")
                .expect("restore_projects must call restore_one_project");
            assert!(
                skip_pos < restore_pos,
                "skip guard must run before restore_one_project"
            );
        }

        /// The user config is loaded once for the whole batch, not once per
        /// project — N projects must not mean N config file reads.
        #[test]
        fn restore_projects_loads_config_once_before_the_batch() {
            let source = include_str!("reconcile.rs");
            let fn_start = source
                .find("pub(crate) fn restore_projects(")
                .expect("restore_projects must exist");
            let fn_end = source[fn_start..]
                .find("\npub(crate) fn stop_projects(")
                .map(|end| fn_start + end)
                .expect("stop_projects must follow restore_projects");
            let body = &source[fn_start..fn_end];
            let load_count = body.matches("load_user_config()").count();
            assert_eq!(
                load_count, 1,
                "restore_projects must call load_user_config() exactly once"
            );
            let load_pos = body
                .find("load_user_config()")
                .expect("restore_projects must load the user config");
            let batch_pos = body
                .find("restore_batch(")
                .expect("restore_projects must call restore_batch");
            assert!(
                load_pos < batch_pos,
                "config load must happen once before the restore_batch call, not inside its closure"
            );
        }
    }

    mod restore_batch_tests {
        use super::{restore_batch, RestoreSkip};
        use std::cell::RefCell;

        #[test]
        fn deferred_projects_are_retained_not_restored() {
            let restored = RefCell::new(Vec::<String>::new());
            let retained = restore_batch(
                &["unmounted".to_string(), "healthy".to_string()],
                |p| (p == "unmounted").then(|| RestoreSkip::Deferred("volume gone".to_string())),
                |p| {
                    restored.borrow_mut().push(p.to_string());
                    Ok(())
                },
            )
            .expect("batch must succeed");
            assert_eq!(
                retained,
                vec!["unmounted"],
                "deferred project must stay pending"
            );
            assert_eq!(*restored.borrow(), vec!["healthy"]);
        }

        #[test]
        fn permanent_skips_are_dropped_from_pending() {
            let restored = RefCell::new(Vec::<String>::new());
            let retained = restore_batch(
                &["stale".to_string()],
                |_| Some(RestoreSkip::Permanent("not in config".to_string())),
                |p| {
                    restored.borrow_mut().push(p.to_string());
                    Ok(())
                },
            )
            .expect("batch must succeed");
            assert!(retained.is_empty(), "permanent skip must not stay pending");
            assert!(restored.borrow().is_empty());
        }

        #[test]
        fn healthy_projects_restore_and_do_not_linger() {
            let restored = RefCell::new(Vec::<String>::new());
            let retained = restore_batch(
                &["a".to_string(), "b".to_string()],
                |_| None,
                |p| {
                    restored.borrow_mut().push(p.to_string());
                    Ok(())
                },
            )
            .expect("batch must succeed");
            assert!(retained.is_empty());
            assert_eq!(*restored.borrow(), vec!["a", "b"]);
        }

        /// Transient restore failures still abort so the persisted pending
        /// list keeps every not-yet-restored project for the next attempt.
        #[test]
        fn restore_error_aborts_and_propagates() {
            let attempted = RefCell::new(Vec::<String>::new());
            let err = restore_batch(
                &["a".to_string(), "b".to_string()],
                |_| None,
                |p| {
                    attempted.borrow_mut().push(p.to_string());
                    Err("engine down".to_string())
                },
            )
            .expect_err("transient failure must propagate");
            assert!(err.contains("engine down"));
            assert_eq!(*attempted.borrow(), vec!["a"], "abort must stop the batch");
        }

        #[test]
        fn tcc_prefixed_error_maps_to_remediation_message() {
            let err = restore_batch(
                &["cloud".to_string()],
                |_| None,
                |_| {
                    Err(format!(
                        "{}Odmowa dostępu",
                        speedwave_runtime::consts::CLOUDSTORAGE_TCC_PREFIX
                    ))
                },
            )
            .expect_err("TCC failure must propagate");
            assert_eq!(
                err,
                speedwave_runtime::cloudstorage::TCC_USER_REMEDIATION_MESSAGE
            );
        }
    }

    mod reconcile_id_tests {
        use super::*;

        #[test]
        fn app_version_only_update_is_a_reconcile() {
            // Release with zero image changes: reconcile id differs (app_version)
            // → full run, missing-only build (0 builds), restore brings projects back.
            let manifest = bundle::BundleManifest::for_tests("new-id");
            let state = bundle::BundleState {
                applied_bundle_id: Some("old-id".to_string()),
                applied_image_hashes: manifest.image_hashes.clone(),
                pending_running_projects: vec!["alpha".to_string()],
                ..Default::default()
            };
            assert!(reconcile_id_changed(&state, &manifest));
        }

        #[test]
        fn unchanged_id_is_not_a_reconcile() {
            // Reinstall of the same version: id matches → no rebuild; the
            // unchanged branch restores any stopped projects (ADR-072).
            let manifest = bundle::BundleManifest::for_tests("same-id");
            let state = bundle::BundleState {
                applied_bundle_id: Some(manifest.bundle_id.clone()),
                pending_running_projects: vec!["alpha".to_string(), "beta".to_string()],
                ..Default::default()
            };
            assert!(!reconcile_id_changed(&state, &manifest));
        }

        #[test]
        fn fresh_install_is_a_reconcile() {
            let manifest = bundle::BundleManifest::for_tests("id1");
            assert!(reconcile_id_changed(
                &bundle::BundleState::default(),
                &manifest
            ));
        }

        /// Structural: bundle-unchanged branch must restore pending projects BEFORE clearing
        /// them from state — clearing first strands them stopped after a no-op update (ADR-072).
        #[test]
        fn unchanged_bundle_branch_restores_before_clearing_pending() {
            let source = include_str!("reconcile.rs");
            let inner_fn = source
                .split("fn reconcile_bundle_update_inner(")
                .nth(1)
                .expect("reconcile_bundle_update_inner function should exist");
            // The unchanged-id branch is the `else` of the reconcile-id check.
            let branch_pos = inner_fn
                .find("bundle unchanged, restoring")
                .expect("unchanged-id branch must restore stopped projects");
            let branch = &inner_fn[branch_pos..];
            let restore_pos = branch
                .find("restore_projects(")
                .expect("unchanged branch must call restore_projects");
            let persist_pos = branch
                .find("pending_running_projects = retained")
                .expect("unchanged branch persists the deferred remainder after restore");
            assert!(
                restore_pos < persist_pos,
                "restore_projects (at {restore_pos}) must run before the pending \
                 list is rewritten (at {persist_pos})"
            );
        }

        /// Structural: when the runtime isn't ready in the unchanged-id restore
        /// branch, return early keeping pending, before the cleanup that clears it (ADR-072).
        #[test]
        fn unchanged_branch_not_ready_keeps_pending() {
            let source = include_str!("reconcile.rs");
            let inner_fn = source
                .split("fn reconcile_bundle_update_inner(")
                .nth(1)
                .expect("reconcile_bundle_update_inner function should exist");
            let branch_pos = inner_fn
                .find("pending restore but runtime not ready")
                .expect("unchanged branch must handle runtime-not-ready");
            let branch = &inner_fn[branch_pos..];
            // The not-ready arm returns Ok before the pending list is rewritten.
            let return_pos = branch
                .find("return Ok(())")
                .expect("not-ready arm must return early");
            let persist_pos = branch
                .find("pending_running_projects = retained")
                .expect("pending rewrite exists later in the branch");
            assert!(
                return_pos < persist_pos,
                "not-ready arm must return (keeping pending) before the rewrite"
            );
        }

        /// Structural: `prepare_rebuild` must reset phase to Pending WITHOUT
        /// clearing `pending_running_projects`.
        #[test]
        fn prepare_rebuild_resets_phase_preserves_pending_projects() {
            let source = include_str!("reconcile.rs");
            let fn_start = source
                .find("fn prepare_rebuild(")
                .expect("prepare_rebuild must exist");
            // Find the closing brace of prepare_rebuild by taking the next top-level fn.
            let after_fn = &source[fn_start..];
            let fn_end = after_fn
                .find("\nfn ")
                .or_else(|| after_fn.find("\npub(crate) fn "))
                .or_else(|| after_fn.find("\npub fn "))
                .unwrap_or(after_fn.len());
            let body = &after_fn[..fn_end];

            assert!(
                body.contains("BundleReconcilePhase::Pending"),
                "prepare_rebuild must reset phase to Pending"
            );
            assert!(
                !body.contains("pending_running_projects.clear()"),
                "prepare_rebuild must NOT clear pending_running_projects — \
                 projects stopped by a prior interrupted reconcile must survive \
                 into the new run so they are restored at the end"
            );
        }

        /// Structural: when the bundle id matches but the previous reconcile was
        /// interrupted (phase != Done), force a full re-reconcile via `prepare_rebuild`.
        #[test]
        fn interrupted_reconcile_with_matching_id_forces_rebuild() {
            let source = include_str!("reconcile.rs");
            let inner_fn = source
                .split("fn reconcile_bundle_update_inner(")
                .nth(1)
                .expect("reconcile_bundle_update_inner function should exist");

            // The matching-id + interrupted-phase branch must exist and call prepare_rebuild.
            let interrupted_branch = inner_fn
                .find("previous reconcile was interrupted")
                .expect("interrupted-reconcile branch must exist in reconcile_bundle_update_inner");
            let branch = &inner_fn[interrupted_branch..];
            assert!(
                branch.contains("prepare_rebuild"),
                "interrupted-reconcile branch must call prepare_rebuild to force re-reconcile"
            );
            assert!(
                branch.contains("ensure_ready"),
                "interrupted-reconcile branch must call ensure_ready after prepare_rebuild"
            );
        }
    }

    mod bundle_status_tests {
        use super::*;

        /// All tests use `bundle_status_from()` with an explicit `BundleState` to
        /// avoid the global `data_dir()` OnceLock. Phase-mutating tests must be `#[serial]`.

        #[test]
        fn current_bundle_status_marks_bundle_change_as_in_progress() {
            BUNDLE_RECONCILE_PHASE.store(RECONCILE_IDLE, Ordering::Relaxed);

            let state = bundle::BundleState {
                applied_bundle_id: Some("older-bundle".to_string()),
                applied_image_hashes: Default::default(),
                phase: bundle::BundleReconcilePhase::Pending,
                pending_running_projects: vec!["alpha".to_string()],
                last_error: None,
            };

            let status = bundle_status_from(&state, Some("current-bundle"));
            assert!(status.in_progress);
            assert_eq!(status.phase, "pending");
            assert_eq!(status.pending_running_projects, vec!["alpha"]);
            assert_eq!(status.applied_bundle_id, Some("older-bundle".to_string()));
        }

        #[test]
        fn current_bundle_status_hides_stale_error_when_bundle_already_applied() {
            BUNDLE_RECONCILE_PHASE.store(RECONCILE_IDLE, Ordering::Relaxed);

            let state = bundle::BundleState {
                applied_bundle_id: Some("current-bundle".to_string()),
                applied_image_hashes: Default::default(),
                phase: bundle::BundleReconcilePhase::ImagesBuilt,
                pending_running_projects: vec!["alpha".to_string()],
                last_error: Some("stale error".to_string()),
            };

            let status = bundle_status_from(&state, Some("current-bundle"));
            assert!(!status.in_progress);
            assert!(status.last_error.is_none());
            assert!(status.pending_running_projects.is_empty());
        }

        #[test]
        #[serial]
        fn checking_phase_is_not_reported_as_in_progress() {
            let state = bundle::BundleState {
                applied_bundle_id: Some("current-bundle".to_string()),
                applied_image_hashes: Default::default(),
                phase: bundle::BundleReconcilePhase::Done,
                pending_running_projects: Vec::new(),
                last_error: None,
            };

            // Simulate the CHECKING phase (thread spawned, not yet confirmed rebuild)
            BUNDLE_RECONCILE_PHASE.store(RECONCILE_CHECKING, Ordering::Relaxed);

            let status = bundle_status_from(&state, Some("current-bundle"));
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
            let state = bundle::BundleState {
                applied_bundle_id: Some("current-bundle".to_string()),
                applied_image_hashes: Default::default(),
                phase: bundle::BundleReconcilePhase::Done,
                pending_running_projects: Vec::new(),
                last_error: None,
            };

            // Simulate the REBUILDING phase
            BUNDLE_RECONCILE_PHASE.store(RECONCILE_REBUILDING, Ordering::Relaxed);

            let status = bundle_status_from(&state, Some("current-bundle"));
            assert!(
                status.in_progress,
                "REBUILDING phase must show as in_progress"
            );

            // Cleanup
            BUNDLE_RECONCILE_PHASE.store(RECONCILE_IDLE, Ordering::Relaxed);
        }

        #[test]
        fn current_bundle_status_surfaces_reconcile_error_for_new_bundle() {
            BUNDLE_RECONCILE_PHASE.store(RECONCILE_IDLE, Ordering::Relaxed);

            let state = bundle::BundleState {
                applied_bundle_id: Some("older-bundle".to_string()),
                applied_image_hashes: Default::default(),
                phase: bundle::BundleReconcilePhase::ImagesBuilt,
                pending_running_projects: vec!["alpha".to_string(), "beta".to_string()],
                last_error: Some("Image rebuild failed".to_string()),
            };

            let status = bundle_status_from(&state, Some("current-bundle"));
            assert!(!status.in_progress);
            assert_eq!(status.phase, "images_built");
            assert_eq!(status.last_error.as_deref(), Some("Image rebuild failed"));
            assert_eq!(
                status.pending_running_projects,
                vec!["alpha".to_string(), "beta".to_string()]
            );
        }

        #[test]
        fn missing_applied_bundle_id_is_reported_as_in_progress() {
            BUNDLE_RECONCILE_PHASE.store(RECONCILE_IDLE, Ordering::Relaxed);

            // Simulate fresh install: no bundle-state.json → applied_bundle_id is None
            // (default BundleState). This should be in_progress because bundle_changed=true.
            let state = bundle::BundleState::default();
            let status = bundle_status_from(&state, Some("current-bundle"));
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

        #[test]
        #[serial]
        fn blocks_during_checking_until_ready() {
            set_readiness(ImageReadiness::Checking);

            let handle = std::thread::spawn(|| wait_for_images_ready(Duration::from_secs(5)));

            // Give the waiter time to block
            std::thread::sleep(Duration::from_millis(50));

            set_readiness(ImageReadiness::Ready);

            let result = handle.join().unwrap();
            assert!(result.is_ok());
        }

        #[test]
        #[serial]
        fn checking_times_out_like_building() {
            set_readiness(ImageReadiness::Checking);

            let result = wait_for_images_ready(Duration::from_millis(50));
            assert!(result.is_err());
            assert!(result.unwrap_err().contains("Timed out"));

            // Cleanup
            set_readiness(ImageReadiness::Ready);
        }

        #[test]
        #[serial]
        fn guard_fails_waiters_when_dropped_during_checking() {
            set_readiness(ImageReadiness::Checking);

            drop(ImageReadinessGuard);

            let result = wait_for_images_ready(Duration::from_millis(50));
            assert!(result.is_err());
            assert!(result.unwrap_err().contains("exited unexpectedly"));

            // Cleanup
            set_readiness(ImageReadiness::Ready);
        }

        /// Structural: Checking must be set before the spawn, or a concurrent
        /// start_containers slips through the Ready-initialized gate.
        #[test]
        fn checking_is_set_before_thread_spawn() {
            let src = include_str!("reconcile.rs");
            let fn_start = src
                .find("pub(crate) fn reconcile_bundle_update(")
                .expect("reconcile_bundle_update must exist");
            let body = &src[fn_start..];
            let set_checking = body
                .find("set_image_readiness(ImageReadiness::Checking)")
                .expect("reconcile_bundle_update must set Checking");
            let spawn = body
                .find("std::thread::spawn")
                .expect("reconcile_bundle_update must spawn the worker thread");
            assert!(
                set_checking < spawn,
                "Checking must be set before the thread spawn, not inside it"
            );
        }

        /// Structural: in the bundle-changed path the gate must close
        /// (prepare_rebuild) before the slow ensure_ready VM start.
        #[test]
        fn rebuild_gate_closes_before_ensure_ready() {
            let src = include_str!("reconcile.rs");
            let fn_start = src
                .find("fn reconcile_bundle_update_inner(")
                .expect("reconcile_bundle_update_inner must exist");
            let body = &src[fn_start..];
            let gate = body
                .find("prepare_rebuild(&mut state, app_handle)?")
                .expect("inner must call prepare_rebuild");
            let ensure = body
                .find("rt.ensure_ready()")
                .expect("inner must call ensure_ready");
            assert!(
                gate < ensure,
                "prepare_rebuild must precede the first ensure_ready call"
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

    /// Structural test: verifies that `reconcile_bundle_update` in main.rs
    /// is gated behind `setup_started`.
    #[test]
    fn reconcile_gated_behind_setup_started_in_main() {
        let main_source = include_str!("main.rs");
        // The reconcile call must be inside an `if setup_started` block.
        let idx = main_source
            .find("reconcile::reconcile_bundle_update(&app_handle)")
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

    /// Verifies `run_exit_cleanup` is idempotent: first call returns `Some(JoinHandle)`, second
    /// `None` (`CLEANUP_ONCE` guard). Process-wide `static` — `#[serial]` orders it after others.
    #[test]
    #[serial]
    fn cleanup_once_idempotency() {
        let ctx = ExitCleanupContext {
            ide_bridge: SharedIdeBridge::default(),
            plugin_bridges: SharedPluginBridges::default(),
            mcp_os: SharedMcpOs::default(),
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

    /// Structural test: missing images with an unchanged bundle must force a
    /// rebuild via prepare_rebuild (gate opens before this check by design).
    #[test]
    fn reconcile_forces_rebuild_when_images_missing() {
        let source = include_str!("reconcile.rs");
        let inner_fn = source
            .split("fn reconcile_bundle_update_inner(")
            .nth(1)
            .expect("reconcile_bundle_update_inner function should exist");

        let images_pos = inner_fn
            .find("images_exist")
            .expect("reconcile must check images_exist when bundle unchanged");

        // prepare_rebuild must follow the images_exist check (repair path).
        let repair = &inner_fn[images_pos..];
        assert!(
            repair.contains("prepare_rebuild(&mut state, app_handle)?"),
            "missing images must force a rebuild via prepare_rebuild"
        );
    }

    /// Structural test: image-build errors return via `set_bundle_error`
    /// before any code that mutates `applied_bundle_id`.
    #[test]
    fn reconcile_partial_build_failure_does_not_mutate_applied_bundle_id() {
        let source = include_str!("reconcile.rs");
        let inner_fn = source
            .split("fn reconcile_bundle_update_inner(")
            .nth(1)
            .expect("reconcile_bundle_update_inner function should exist");

        let bail_pos = inner_fn
            .find("Image rebuild failed: {}")
            .expect("Image rebuild failed bail path must exist");
        assert!(
            inner_fn[bail_pos..bail_pos + 200].contains("condense_engine_error"),
            "the bail banner must go through build::condense_engine_error, not the raw log"
        );
        assert!(
            inner_fn[bail_pos.saturating_sub(120)..bail_pos].contains("log_sanitizer::sanitize"),
            "the bail banner crosses IPC — it must pass log_sanitizer::sanitize"
        );
        let restart_pos = inner_fn
            .find("Image rebuild failed after engine restart: {}")
            .expect("snapshotter-recovery rebuild bail must exist");
        assert!(
            inner_fn[restart_pos.saturating_sub(120)..restart_pos + 200]
                .contains("log_sanitizer::sanitize")
                && inner_fn[restart_pos..restart_pos + 200].contains("condense_engine_error"),
            "the engine-restart rebuild banner must be sanitized and condensed too"
        );
        let applied_id_assignment_pos = inner_fn
            .find("state.applied_bundle_id = Some(manifest.bundle_id.clone())")
            .expect("applied_bundle_id assignment must exist");
        let prune_pos = inner_fn
            .find("prune_superseded_images")
            .expect("prune_superseded_images must exist");

        assert!(
            bail_pos < applied_id_assignment_pos,
            "Image rebuild failed bail (at byte {bail_pos}) must return BEFORE \
             applied_bundle_id is set (at byte {applied_id_assignment_pos}) — \
             otherwise a partial build failure overwrites the previous bundle id"
        );
        assert!(
            bail_pos < prune_pos,
            "Image rebuild failed bail (at byte {bail_pos}) must return BEFORE \
             prune_superseded_images runs (at byte {prune_pos}) — otherwise a \
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
    /// build/restore sequence (after `ProjectsRestored`).
    #[test]
    fn reconcile_prunes_old_images_after_full_restore() {
        let source = include_str!("reconcile.rs");
        let inner_fn = source
            .split("fn reconcile_bundle_update_inner(")
            .nth(1)
            .expect("reconcile_bundle_update_inner function should exist");

        let prune_pos = inner_fn
            .find("prune_superseded_images")
            .expect("prune_superseded_images call must exist in reconcile_bundle_update_inner");
        let build_pos = inner_fn
            .find("build_missing_images")
            .expect("build_missing_images call must exist in reconcile_bundle_update_inner");
        let restore_pos = inner_fn
            .find("restore_projects(")
            .expect("restore_projects call must exist in reconcile_bundle_update_inner");

        assert!(
            prune_pos > build_pos,
            "prune_superseded_images (at byte {prune_pos}) must appear AFTER \
             build_images_for_bundle (at byte {build_pos}) in reconcile_bundle_update_inner"
        );
        assert!(
            prune_pos > restore_pos,
            "prune_superseded_images (at byte {prune_pos}) must appear AFTER \
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
            .find("build_missing_images")
            .expect("build_missing_images call must exist");
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
