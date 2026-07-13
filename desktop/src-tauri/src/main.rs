//! Speedwave Desktop — Tauri v2 backend. Thin `#[tauri::command]` wrappers delegating to module
//! functions; each converts `anyhow::Result` into `Result<T, String>` for serializable errors.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod auth;
mod auth_commands;
mod bridges;
mod chat;
mod chat_session_cmd;
mod clipboard_bridge;
mod cloudstorage_cmd;
mod container_logs_cmd;
mod containers_cmd;
mod diagnostics;
#[cfg(any(test, feature = "e2e"))]
mod e2e_support;
mod firewall;
mod git_cmd;
mod health;
mod health_cmd;
mod history;
mod history_cmd;
mod http_util;
#[cfg(test)]
mod installer_hooks;
use bridges::ide_bridge;
mod github_oauth_cmd;
mod ide_bridge_cmd;
mod integrations_cmd;
mod llm_cmd;
mod logging_cmd;
mod mirror_relay;
mod oauth_cmd;
mod oauth_flow;
mod oauth_login_cmd;
mod oauth_loopback;
mod oauth_providers;
mod paste_cmd;
mod plugin_oauth_cmd;
mod slack_oauth_cmd;
// `path_util` is consumed only by the Windows-only `oauth_login_cmd::open_terminal_with_command`.
mod mic_permission_cmd;
#[cfg(target_os = "windows")]
mod path_util;
mod plugin_cmd;
mod project_cmd;
mod queue_cmd;
mod reconcile;
mod redmine_api_cmd;
mod retry_cmd;
mod setup_wizard;
mod slash_cmd;
mod system_settings_cmd;
mod transcription_cmd;
mod tray;
mod types;
mod ui_prefs_cmd;
mod update_commands;
mod updater;
mod url_validation;
mod window;

// Re-exported at crate root so `diagnostics` can reach it via `super::check_project`.
use types::check_project;

use chat::{ChatSession, SharedChatSession};
use speedwave_runtime::config;

use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::tray::TrayIconBuilder;
use tauri::Manager;

use reconcile::{
    ExitCleanupContext, SharedAutoCheckHandle, SharedIdeBridge, SharedMcpOs, SharedOauth,
    SharedPluginBridges,
};

// Re-export project-switch helpers consumed via `crate::` from containers_cmd.
pub(crate) use project_cmd::{rebind_chat, rollback_and_emit_failed};

/// Joins a cleanup thread with a watchdog that force-exits after `EXIT_CLEANUP_TIMEOUT_SECS`.
/// Exits with code 1 if the cleanup thread panics; returns on normal completion.
pub(crate) fn join_with_exit_watchdog(handle: std::thread::JoinHandle<()>) {
    let watchdog = std::thread::spawn(|| {
        std::thread::sleep(std::time::Duration::from_secs(
            speedwave_runtime::consts::EXIT_CLEANUP_TIMEOUT_SECS,
        ));
        log::error!(
            "exit cleanup timed out after {}s — force-exiting",
            speedwave_runtime::consts::EXIT_CLEANUP_TIMEOUT_SECS
        );
        std::process::exit(1);
    });
    if let Err(e) = handle.join() {
        log::warn!("exit cleanup thread panicked: {e:?}");
    }
    drop(watchdog);
}

/// Stashes a cleanup `JoinHandle` into the shared slot so `RunEvent::Exit` can join it before exit.
/// Drops the handle if the slot is already occupied or the mutex is poisoned.
pub(crate) fn stash_cleanup_handle(
    slot: &Arc<Mutex<Option<std::thread::JoinHandle<()>>>>,
    handle: std::thread::JoinHandle<()>,
) {
    match slot.lock() {
        Ok(mut guard) => {
            if guard.is_none() {
                *guard = Some(handle);
            }
            // else: slot occupied; cleanup runs once (CLEANUP_ONCE), so drop this handle.
        }
        Err(e) => {
            log::warn!("exit cleanup handle slot poisoned, cleanup will not be joined: {e}");
            // Drop the handle — the cleanup thread runs independently.
        }
    }
}

const MAIN_WINDOW_LABEL: &str = "main";

/// Stop flag for the mcp-os watchdog thread. Set during app exit cleanup
/// to prevent the watchdog from respawning mcp-os during shutdown.
static WATCHDOG_STOP: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Stop flag for the `oauth` watchdog (set during exit cleanup).
static OAUTH_WATCHDOG_STOP: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

// Shared "not authenticated" message; kept at crate root for `chat_session_cmd` (`crate::`).
pub(crate) const MSG_NOT_AUTHENTICATED: &str =
    "Claude is not authenticated. Please authenticate first.";

use diagnostics::export_diagnostics;
use window::should_debounce;
use window::{
    hide_main_window, should_emit_focus_event, should_prevent_close, should_run_cleanup,
    show_main_window,
};

// ── Extracted subsystem starters (reused by setup() and ensure_*_running()) ─

/// Create, configure, and start IDE Bridge. Stores it in the shared state.
/// Called from setup() on normal start and from ensure_ide_bridge_running().
fn init_and_start_ide_bridge(ide_bridge: &SharedIdeBridge, app_handle: &tauri::AppHandle) {
    if let Some(bridge) = init_and_start_ide_bridge_inner(app_handle) {
        if let Ok(mut guard) = ide_bridge.lock() {
            *guard = Some(bridge);
        }
    }
}

/// Inner implementation: creates, configures and starts IDE Bridge.
/// Returns `Some(bridge)` on success so the caller can store it under a lock.
fn init_and_start_ide_bridge_inner(app_handle: &tauri::AppHandle) -> Option<ide_bridge::IdeBridge> {
    match ide_bridge::IdeBridge::new() {
        Ok(mut bridge) => {
            let handle = app_handle.clone();
            bridge.set_event_callback(std::sync::Arc::new(move |kind, detail| {
                use tauri::Emitter;
                let _ = handle.emit(
                    "ide_bridge_event",
                    serde_json::json!({ "kind": kind, "detail": detail }),
                );
            }));
            if let Err(e) = bridge.start() {
                log::error!("IDE Bridge start error: {e}");
                return None;
            }
            log::info!("IDE Bridge started");
            if let Ok(cfg) = config::load_user_config() {
                if let Some(sel) = cfg.selected_ide {
                    let _ = bridge.set_upstream(sel.ide_name, sel.port);
                }
            }
            Some(bridge)
        }
        Err(e) => {
            log::error!("IDE Bridge init error: {e}");
            None
        }
    }
}

/// Wire-format for the `plugin_bridge_get_credentials` Tauri response. Mirror:
/// `PluginBridgeCredentials` in `desktop/src/src/app/models/plugin.ts`.
#[derive(Serialize)]
struct PluginBridgeCredentialsResponse {
    slug: String,
    url: String,
    token: String,
}

/// Wire-format for `plugin_bridge_get_status`. Discriminated on `running`.
/// Mirror: `PluginBridgeStatus` in `desktop/src/src/app/models/plugin.ts`.
#[derive(Serialize)]
#[serde(untagged)]
enum PluginBridgeStatusResponse {
    Running {
        slug: String,
        /// Always `true` — TS discriminant. Pinned by wire-format test.
        running: bool,
        port: u16,
        paired: bool,
        partner_connected: bool,
        display_name: String,
    },
    NotRunning {
        slug: String,
        /// Always `false` — TS discriminant. Pinned by wire-format test.
        running: bool,
    },
}

#[tauri::command]
fn plugin_bridge_get_credentials(
    slug: String,
    plugin_bridges: tauri::State<SharedPluginBridges>,
) -> Result<PluginBridgeCredentialsResponse, String> {
    let guard = plugin_bridges
        .lock()
        .map_err(|e| format!("mutex poisoned: {e}"))?;
    let bridge = guard
        .get(&slug)
        .ok_or_else(|| format!("plugin bridge '{slug}' not running"))?;
    let creds = bridge.credentials_for_local_ui();
    Ok(PluginBridgeCredentialsResponse {
        slug,
        url: creds.local_ui_url,
        token: creds.token,
    })
}

#[tauri::command]
fn plugin_bridge_get_status(
    slug: String,
    plugin_bridges: tauri::State<SharedPluginBridges>,
) -> Result<PluginBridgeStatusResponse, String> {
    let guard = plugin_bridges
        .lock()
        .map_err(|e| format!("mutex poisoned: {e}"))?;
    Ok(match guard.get(&slug) {
        Some(bridge) => PluginBridgeStatusResponse::Running {
            slug,
            running: true,
            port: bridge.port(),
            paired: bridge.is_paired(),
            partner_connected: bridge.has_partner(),
            display_name: bridge.manifest().display_name.clone(),
        },
        None => PluginBridgeStatusResponse::NotRunning {
            slug,
            running: false,
        },
    })
}

/// Action decided by one mcp-os watchdog health tick.
#[derive(Debug, PartialEq, Eq)]
enum HealthOutcome {
    Alive,
    ShouldRespawn,
    Cooldown,
}

/// Pure per-tick health decision: maps process liveness + the consecutive-unhealthy
/// count to the action and the next count.
fn mcp_os_health_outcome(
    alive: bool,
    consecutive_unhealthy: u32,
    max_unhealthy: u32,
) -> (HealthOutcome, u32) {
    if alive {
        (HealthOutcome::Alive, 0)
    } else {
        let n = consecutive_unhealthy + 1;
        if n >= max_unhealthy {
            (HealthOutcome::Cooldown, 0)
        } else {
            (HealthOutcome::ShouldRespawn, n)
        }
    }
}

/// Relay swap after a host worker respawns on a possibly-new port: drop the old relay
/// only when the port actually changed — an ephemeral-port reuse keeps the existing relay
/// valid (it still forwards to the same loopback port), and an unconditional async remove
/// would race the fresh ensure and kill the new relay for ~30 s. ADR-079.
fn swap_relay_for_respawn(old_port: u16, new_port: u16) {
    if old_port != new_port {
        crate::mirror_relay::remove_relay_for_port_async(old_port);
    }
    crate::mirror_relay::ensure_relay_for_port(new_port);
}

/// mcp-os watchdog thread.
fn start_mcp_os_watchdog(mcp_os: SharedMcpOs, app_handle: tauri::AppHandle) {
    std::thread::spawn(move || {
        use std::time::Duration;
        const CHECK_INTERVAL: Duration = Duration::from_secs(30);
        const MAX_UNHEALTHY: u32 = 5;
        const COOLDOWN: Duration = Duration::from_secs(300);
        let mut consecutive_unhealthy: u32 = 0;

        // Decide + mutate under the lock; run relay ops and the cooldown sleep AFTER
        // releasing it, so callers taking mcp_os.lock() don't stall behind a poll.
        enum Tick {
            EnsureRelay(u16),
            Respawned { old: u16, new: u16 },
            Cooldown,
            Nothing,
            Stop,
        }
        loop {
            std::thread::sleep(CHECK_INTERVAL);
            if WATCHDOG_STOP.load(Ordering::Relaxed) {
                break;
            }

            let action = match mcp_os.lock() {
                Err(e) => {
                    log::error!("mcp-os watchdog: mutex poisoned: {e}");
                    Tick::Stop
                }
                Ok(mut guard) => match *guard {
                    None => Tick::Stop,
                    Some(ref mut proc) => {
                        let (outcome, next) = mcp_os_health_outcome(
                            proc.is_alive(),
                            consecutive_unhealthy,
                            MAX_UNHEALTHY,
                        );
                        consecutive_unhealthy = next;
                        match outcome {
                            HealthOutcome::Alive => Tick::EnsureRelay(proc.port()),
                            HealthOutcome::Cooldown => Tick::Cooldown,
                            HealthOutcome::ShouldRespawn => {
                                log::warn!(
                                    "mcp-os watchdog: process unhealthy ({consecutive_unhealthy}/{MAX_UNHEALTHY}), respawning"
                                );
                                let old = proc.port();
                                match proc.respawn() {
                                    Ok(new) => Tick::Respawned { old, new },
                                    Err(e) => {
                                        log::error!("mcp-os watchdog: respawn failed: {e}");
                                        Tick::Nothing
                                    }
                                }
                            }
                        }
                    }
                },
            };

            match action {
                Tick::Stop => break,
                Tick::Nothing => {}
                Tick::EnsureRelay(port) => {
                    // Relay lives in the WSL distro; re-ensure so a distro restart
                    // (which this host process outlives) self-heals it (ADR-079).
                    crate::mirror_relay::ensure_relay_for_port(port);
                }
                Tick::Respawned { old, new } => {
                    log::info!("mcp-os watchdog: respawned (port {new})");
                    swap_relay_for_respawn(old, new);
                    reconcile::reconcile_compose_port(&app_handle);
                }
                Tick::Cooldown => {
                    // Counter already reset by mcp_os_health_outcome.
                    log::error!(
                        "mcp-os watchdog: unhealthy for {MAX_UNHEALTHY} consecutive checks, cooling down"
                    );
                    std::thread::sleep(COOLDOWN);
                }
            }
        }
        log::info!("mcp-os watchdog stopped");
    });
}

/// Start IDE Bridge if not already running. Holds the mutex for the entire
/// init+start to prevent races (two callers both seeing None and double-starting).
pub(crate) fn ensure_ide_bridge_running(
    ide_bridge: &SharedIdeBridge,
    app_handle: &tauri::AppHandle,
) {
    // Ensure the WSL Hyper-V firewall rule before binding the host listener (ADR-067; no-op off Windows).
    firewall::ensure_firewall_rule();
    let mut guard = match ide_bridge.lock() {
        Ok(g) => g,
        Err(e) => {
            log::error!("IDE Bridge mutex poisoned: {e}");
            return;
        }
    };
    if guard.is_some() {
        return;
    }
    if let Some(bridge) = init_and_start_ide_bridge_inner(app_handle) {
        *guard = Some(bridge);
    }
}

/// Start mcp-os if not already running. Holds the mutex for the entire
/// spawn to prevent races, and can block up to `PORT_READ_TIMEOUT` (10 s).
fn ensure_mcp_os_running(mcp_os: &SharedMcpOs, app_handle: &tauri::AppHandle) {
    firewall::ensure_firewall_rule();
    let mut guard = match mcp_os.lock() {
        Ok(g) => g,
        Err(e) => {
            log::error!("mcp-os mutex poisoned: {e}");
            return;
        }
    };
    if guard.is_some() {
        return;
    }
    let script = speedwave_runtime::build::resolve_mcp_os_script();
    if let Some(script_path) = script {
        let script_str = script_path.to_string_lossy().to_string();
        match speedwave_runtime::mcp_os_process::McpOsProcess::spawn(&script_str) {
            Ok(proc) => {
                log::info!("mcp-os started (port {})", proc.port());
                // Reach this host worker from containers under WSL2 mirrored mode (ADR-079; no-op otherwise).
                crate::mirror_relay::ensure_relay_for_port(proc.port());
                *guard = Some(proc);
                drop(guard); // release before spawning watchdog thread
                WATCHDOG_STOP.store(false, Ordering::Relaxed);
                start_mcp_os_watchdog(mcp_os.clone(), app_handle.clone());
            }
            Err(e) => log::error!("mcp-os spawn failed: {e}"),
        }
    }
}

// `is_service_enabled` lives on `ResolvedIntegrationsConfig` in `speedwave-runtime::config`.
// Desktop is the sole oauth-worker supervisor (see the exit-137 note in `speedwave-cli::main`).

/// What to do with a running oauth worker given current vs. desired consumers.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum OauthReconcile {
    /// Consumer set unchanged — leave the worker as is.
    NoChange,
    /// Consumer set changed — stop the worker; respawn happens downstream.
    /// `clear_bearer_map` when the desired set is empty (no respawn follows).
    Respawn { clear_bearer_map: bool },
}

/// Pure reconcile decision for a running worker. `current`/`desired` must be
/// sorted. Extracted so the transition logic is unit-testable without IO.
pub(crate) fn oauth_reconcile_action(current: &[String], desired: &[String]) -> OauthReconcile {
    if current == desired {
        OauthReconcile::NoChange
    } else {
        OauthReconcile::Respawn {
            clear_bearer_map: desired.is_empty(),
        }
    }
}

/// Spawn the per-project `oauth` worker on demand. No-op if no `uses_oauth_refresh = true`
/// integration is enabled, or the worker is already running. Returns true if newly started.
pub(crate) fn ensure_oauth_running(oauth_arc: &SharedOauth, project: &str) -> bool {
    let mut map = match oauth_arc.lock() {
        Ok(g) => g,
        Err(e) => {
            log::error!("oauth worker map mutex poisoned: {e}");
            return false;
        }
    };
    // Check if any OAuth-consuming integration is enabled for this project.
    let user_config = match config::load_user_config() {
        Ok(c) => c,
        Err(e) => {
            log::warn!("cannot load user config: {e}");
            return false;
        }
    };
    let project_dir = match user_config.find_project(project) {
        Some(p) => std::path::PathBuf::from(&p.dir),
        None => {
            log::warn!("unknown project '{project}'");
            return false;
        }
    };
    let resolved = config::resolve_integrations(&project_dir, &user_config, project);

    // OAuth-consuming services for this project via the SSOT helper (matches compose injection).
    let installed = speedwave_runtime::plugin::list_installed_plugins().unwrap_or_default();
    let mut oauth_consumers =
        speedwave_runtime::compose::oauth_consumer_service_ids(&resolved, &installed);
    oauth_consumers.sort();

    // Relay port of a worker we stopped to respawn; its teardown is deferred until the new
    // port is known so an ephemeral-port reuse keeps the relay instead of racing it (S3/ADR-079).
    let mut old_relay_port: Option<u16> = None;

    // A running worker's consumer set is fixed at spawn; reconcile against the desired set.
    if let Some(running) = map.get(project) {
        let mut current: Vec<String> = running.spec().consumers().to_vec();
        current.sort();
        match oauth_reconcile_action(&current, &oauth_consumers) {
            OauthReconcile::NoChange => {
                // Re-ensure the live worker's relay: a WSL distro restart wipes it while
                // the worker (host process) survives (ADR-079; async no-op off Windows).
                crate::mirror_relay::ensure_relay_for_port(running.port());
                return false;
            }
            OauthReconcile::Respawn { clear_bearer_map } => {
                log::info!(
                    "oauth worker for '{project}' consumer set changed ({current:?} -> {oauth_consumers:?}); respawning"
                );
                if let Some(proc) = map.remove(project) {
                    old_relay_port =
                        Some(reconcile::stop_worker(&format!("oauth[{project}]"), proc));
                }
                if clear_bearer_map {
                    // Drop the stale bearer-map so compose stops injecting into orphaned containers.
                    let dir = speedwave_runtime::oauth_process::oauth_project_dir(
                        speedwave_runtime::consts::data_dir(),
                        project,
                    );
                    let _ = std::fs::remove_file(
                        dir.join(speedwave_runtime::consts::OAUTH_BEARER_MAP_FILE),
                    );
                }
            }
        }
    }

    if oauth_consumers.is_empty() {
        // No replacement worker follows — drop the stopped worker's relay now.
        if let Some(old) = old_relay_port {
            crate::mirror_relay::remove_relay_for_port_async(old);
        }
        log::debug!(
            "no oauth-consuming integration enabled for '{project}' — not spawning oauth worker"
        );
        return false;
    }
    let consumer_refs: Vec<&str> = oauth_consumers.iter().map(String::as_str).collect();

    // Ensure the firewall rule only once a spawn is certain (must precede the worker's bind).
    firewall::ensure_firewall_rule();

    let script = match speedwave_runtime::build::resolve_oauth_script() {
        Some(s) => s.to_string_lossy().to_string(),
        None => {
            if let Some(old) = old_relay_port {
                crate::mirror_relay::remove_relay_for_port_async(old);
            }
            log::warn!(
                "oauth worker script not found — \
                 OAuth refresh will be unavailable for '{project}'"
            );
            return false;
        }
    };
    match speedwave_runtime::oauth_process::OauthProcess::spawn_in(
        project,
        &script,
        speedwave_runtime::consts::data_dir(),
        &consumer_refs,
    ) {
        Ok(proc) => {
            let port = proc.port();
            log::info!("oauth worker for '{project}' started (port {port})");
            // Container workers dial WORKER_OAUTH_URL; under WSL2 mirrored mode that reaches
            // the guest relay. Swap (not blind re-add) so an ephemeral-port reuse across the
            // respawn doesn't tear down the fresh relay (ADR-079).
            match old_relay_port {
                Some(old) => swap_relay_for_respawn(old, port),
                None => crate::mirror_relay::ensure_relay_for_port(port),
            }
            map.insert(project.to_string(), proc);
            drop(map);
            OAUTH_WATCHDOG_STOP.store(false, Ordering::Relaxed);
            true
        }
        Err(e) => {
            if let Some(old) = old_relay_port {
                crate::mirror_relay::remove_relay_for_port_async(old);
            }
            log::error!("oauth worker for '{project}' spawn failed: {e}");
            false
        }
    }
}

/// A worker the sweep respawned; the old/new ports drive relay teardown/re-ensure.
struct RespawnedWorker {
    name: String,
    old_port: u16,
    new_port: u16,
}

/// One watchdog pass over the worker map: respawns + the surviving live ports
/// (which need their guest relay re-ensured — ADR-079).
struct SweepOutcome {
    respawned: Vec<RespawnedWorker>,
    alive_ports: Vec<u16>,
}

/// Decide which per-project workers in the map are unhealthy and respawn them;
/// callers recreate consumer containers / fix relays from the returned outcome.
fn sweep_per_project_workers<P>(
    workers: &mut std::collections::HashMap<String, P>,
    log_prefix: &str,
) -> SweepOutcome
where
    P: WatchdogWorker,
{
    let mut outcome = SweepOutcome {
        respawned: Vec::new(),
        alive_ports: Vec::new(),
    };
    let names: Vec<String> = workers.keys().cloned().collect();
    for name in names {
        let Some(proc) = workers.get_mut(&name) else {
            continue;
        };
        if proc.is_alive() {
            outcome.alive_ports.push(proc.port());
            continue;
        }
        log::warn!("{log_prefix}: worker for '{name}' unhealthy — respawning");
        let old_port = proc.port();
        match proc.respawn() {
            Ok(new_port) => {
                log::info!("{log_prefix}: respawned '{name}' (port {new_port})");
                outcome.respawned.push(RespawnedWorker {
                    name,
                    old_port,
                    new_port,
                });
            }
            Err(e) => {
                log::error!("{log_prefix}: respawn for '{name}' failed: {e}");
            }
        }
    }
    outcome
}

/// Trait abstracting the watchdog's view of a managed worker. Implemented by every host-side
/// worker manager supervised by a watchdog — `OauthProcess` is the per-project one today.
pub(crate) trait WatchdogWorker {
    fn is_alive(&self) -> bool;
    fn respawn(&mut self) -> anyhow::Result<u16>;
    fn port(&self) -> u16;
}

impl WatchdogWorker for speedwave_runtime::oauth_process::OauthProcess {
    fn is_alive(&self) -> bool {
        speedwave_runtime::oauth_process::OauthProcess::is_alive(self)
    }
    fn respawn(&mut self) -> anyhow::Result<u16> {
        speedwave_runtime::oauth_process::OauthProcess::respawn(self)
    }
    fn port(&self) -> u16 {
        speedwave_runtime::oauth_process::OauthProcess::port(self)
    }
}

/// Shared watchdog loop for per-project host-side workers (oauth). Polls every 30 s, respawns dead
/// workers via [`sweep_per_project_workers`], recreates each respawned project's hub containers.
fn start_per_project_watchdog<P>(
    workers: std::sync::Arc<std::sync::Mutex<std::collections::HashMap<String, P>>>,
    stop_flag: &'static std::sync::atomic::AtomicBool,
    log_prefix: &'static str,
) where
    P: WatchdogWorker + Send + 'static,
{
    std::thread::spawn(move || {
        use std::time::Duration;
        const CHECK_INTERVAL: Duration = Duration::from_secs(30);
        loop {
            std::thread::sleep(CHECK_INTERVAL);
            if stop_flag.load(Ordering::Relaxed) {
                break;
            }
            // Respawn under the lock; defer container recreate + relay ops until after release.
            let outcome = {
                let mut map = match workers.lock() {
                    Ok(g) => g,
                    Err(e) => {
                        log::error!("{log_prefix} worker map mutex poisoned: {e}");
                        break;
                    }
                };
                sweep_per_project_workers(&mut map, log_prefix)
            };
            // Live workers: re-ensure the guest relay a distro restart wiped (ADR-079).
            for port in outcome.alive_ports {
                crate::mirror_relay::ensure_relay_for_port(port);
            }
            // Recreate containers (panic-isolated per project) so consumers pick up the new port.
            for worker in outcome.respawned {
                swap_relay_for_respawn(worker.old_port, worker.new_port);
                let name = worker.name;
                let n = name.clone();
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    containers_cmd::recreate_project_containers_if_running(&n);
                }));
                if let Err(payload) = result {
                    let msg = speedwave_runtime::log_sanitizer::panic_payload_to_string(&*payload);
                    log::error!("{log_prefix} recreate panicked for '{name}': {msg}");
                }
            }
        }
        log::info!("{log_prefix} stopped");
    });
}

/// Per-project `oauth` watchdog — 30s checks.
fn start_oauth_watchdog(oauth_arc: SharedOauth) {
    start_per_project_watchdog(oauth_arc, &OAUTH_WATCHDOG_STOP, "oauth watchdog");
}

/// Shows the audit-failure dialog and terminates the process. Returns
/// only via `process::exit`. Caller has already logged the body.
fn show_audit_failure_dialog_and_exit(app: &tauri::AppHandle, title: &str, body: String) -> ! {
    use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
    let _ = app
        .dialog()
        .message(body)
        .title(title)
        .kind(MessageDialogKind::Error)
        .blocking_show();
    std::process::exit(1);
}

/// Formats the per-plugin failures from `plugin::audit_all` into a
/// user-actionable dialog message with CLI/manual recovery steps.
fn format_audit_failure_message(failures: &[(String, String)]) -> String {
    let mut body = String::from(
        "Speedwave detected one or more plugins that no longer match their\n\
         original signed contents. For your safety, the app cannot start until\n\
         the affected plugins are removed or reinstalled.\n\n\
         Affected plugins:\n",
    );
    for (slug, reason) in failures {
        body.push_str(&format!("  • {slug}: {reason}\n"));
    }
    body.push_str(
        "\nHow to recover:\n\
         1. Open Terminal and run `speedwave plugin remove <slug>` for each\n\
            affected plugin (CLI commands always work even when this dialog\n\
            blocks the UI).\n\
         2. Reinstall a fresh signed plugin via `speedwave plugin install\n\
            <path/to/plugin.zip>`.\n\n\
         Alternatively, manually delete the affected plugin directory under\n\
         `~/.speedwave/plugins/<slug>/` and restart Speedwave.",
    );
    body
}

// ── Application entry point ─────────────────────────────────────────────────

/// Logs a sanitized panic message via `log_fn`, falling back to `eprintln!` if `log_fn` itself
/// panics — a panic during unwind aborts, so the pipe-fragile log sink runs isolated from the hook.
fn log_panic_with_fallback(sanitized: &str, log_fn: impl FnOnce()) {
    if std::panic::catch_unwind(std::panic::AssertUnwindSafe(log_fn)).is_err() {
        // Sanctioned panic-hook stderr fallback (logging.md) — the log
        // sink itself panicked, so bypass it entirely.
        #[expect(
            clippy::print_stderr,
            reason = "panic-hook stderr fallback (logging.md)"
        )]
        {
            eprintln!("PANIC: {sanitized} (log sink also panicked)");
        }
    }
}

fn main() {
    // Panic hook — sanitize panic payload before logging.
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let sanitized = speedwave_runtime::log_sanitizer::sanitize(&format!("{info}"));
        log_panic_with_fallback(&sanitized, || log::error!("PANIC: {sanitized}"));
        #[cfg(debug_assertions)]
        default_hook(info);
        #[cfg(not(debug_assertions))]
        {
            let _ = &default_hook; // suppress unused warning
                                   // Sanctioned panic-hook stderr fallback (logging.md).
            #[expect(
                clippy::print_stderr,
                reason = "panic-hook stderr fallback (logging.md)"
            )]
            {
                eprintln!("PANIC: {sanitized}");
            }
        }
    }));

    // True when setup has been *started* (at least check_runtime passed).
    let setup_started = setup_wizard::SetupState::load().runtime_ready;

    // Bundled binary resolution for app bundles.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            if let Some(res) = reconcile::resolve_resources_dir(parent) {
                // Env var always set — Desktop uses it directly, never reads the marker file
                std::env::set_var(speedwave_runtime::consts::BUNDLE_RESOURCES_ENV, &res);
                // Marker written to disk only after setup completed at least once.
                if setup_started {
                    if let Err(e) = speedwave_runtime::build::write_resources_marker(&res) {
                        log::warn!("could not write resources-dir marker: {e}");
                    }
                }
            }
        }
    }

    let initial_session: SharedChatSession = Arc::new(Mutex::new(ChatSession::new("default")));
    let queue_service = speedwave_runtime::session::QueuedMessageService::new();
    // Meeting-transcription stores (ADR-056); `transcript_drivers` maps a recording to its stop signal.
    let transcript_store: transcription_cmd::TranscriptStoreHandle =
        Arc::new(speedwave_runtime::transcription::TranscriptStore::new());
    let model_store: transcription_cmd::ModelStoreHandle =
        Arc::new(speedwave_runtime::transcription::ModelStore::new());
    let transcript_drivers: transcription_cmd::DriversHandle =
        Arc::new(std::sync::Mutex::new(std::collections::HashMap::new()));
    let transcript_forwarders: transcription_cmd::ForwardersHandle =
        Arc::new(std::sync::Mutex::new(std::collections::HashSet::new()));
    let transcript_downloads: transcription_cmd::DownloadsHandle =
        Arc::new(std::sync::Mutex::new(std::collections::HashSet::new()));

    // Shared state: IDE Bridge, host-bridged plugins, mcp-os, per-project oauth
    // workers, auto-check handle.
    let ide_bridge: SharedIdeBridge = Arc::new(Mutex::new(None));
    let clipboard_bridge_slot: clipboard_bridge::SharedClipboardBridge = Arc::new(Mutex::new(None));
    let plugin_bridges: SharedPluginBridges =
        Arc::new(Mutex::new(std::collections::HashMap::new()));
    let mcp_os: SharedMcpOs = Arc::new(Mutex::new(None));
    let oauth: SharedOauth = Arc::new(Mutex::new(std::collections::HashMap::new()));
    let auto_check_handle: SharedAutoCheckHandle = Arc::new(Mutex::new(None));

    // Publish the plugin-bridges map globally so compose-render call sites can read it without tauri::State.
    reconcile::set_global_plugin_bridges(plugin_bridges.clone());

    let tray_available = Arc::new(AtomicBool::new(false));
    let tray_available_setup = tray_available.clone();
    let tray_available_close = tray_available.clone();

    // One context struct → one clone per exit path instead of N parallel Arc clones.
    let cleanup_ctx = ExitCleanupContext {
        ide_bridge: ide_bridge.clone(),
        plugin_bridges: plugin_bridges.clone(),
        mcp_os: mcp_os.clone(),
        oauth: oauth.clone(),
        auto_check_handle: auto_check_handle.clone(),
    };
    let cleanup_ctx_window = cleanup_ctx.clone();
    let cleanup_ctx_runevent = cleanup_ctx.clone();

    // Seed tray state from persisted user-config so the beta-features
    // checkbox reflects the previous session's choice on startup.
    let initial_beta_enabled = config::load_user_config()
        .map(|c| c.beta_enabled())
        .unwrap_or(false);
    let tray_state = tray::TrayMenuState::new(initial_beta_enabled);

    // Register SIGTERM/SIGINT handler so signals run the same cleanup as window close
    // (idempotent via the CLEANUP_ONCE guard in run_exit_cleanup).
    let cleanup_ctx_signal = cleanup_ctx.clone();
    // ctrlc runs handlers on a dedicated thread, so blocking with `.join()` here is safe.
    match ctrlc::set_handler(move || {
        if let Some(handle) = reconcile::run_exit_cleanup(&cleanup_ctx_signal) {
            join_with_exit_watchdog(handle);
        }
        // Exit code 1: process was terminated by a signal (SIGTERM/SIGINT).
        std::process::exit(1);
    }) {
        Ok(()) => {}
        Err(e) => {
            log::error!("failed to set signal handler, exiting: {e}");
            std::process::exit(1);
        }
    }

    // Shared slot for the cleanup `JoinHandle`; `RunEvent::Exit` drains and joins it before exit.
    let exit_cleanup_handle: Arc<Mutex<Option<std::thread::JoinHandle<()>>>> =
        Arc::new(Mutex::new(None));
    let exit_cleanup_handle_window = exit_cleanup_handle.clone();
    let exit_cleanup_handle_runevent = exit_cleanup_handle.clone();

    // A relaunch (factory reset, settings restart) races the dying instance for
    // the WebDriver port; wait until it is free so the plugin's one-shot bind succeeds.
    #[cfg(feature = "e2e")]
    {
        let addr = std::net::SocketAddr::from(([127, 0, 0, 1], e2e_support::E2E_WEBDRIVER_PORT));
        if let Err(e) = e2e_support::wait_until_port_free(
            addr,
            std::time::Duration::from_secs(30),
            std::time::Duration::from_millis(200),
        ) {
            log::error!("webdriver port {addr} still unavailable at startup: {e}");
        }
    }

    let builder = tauri::Builder::default();

    // WebDriver server for E2E tests on 127.0.0.1:4445; only compiled under the "e2e" feature.
    #[cfg(feature = "e2e")]
    let builder = builder.plugin(tauri_plugin_webdriver::init());

    let app = builder
        .plugin({
            use tauri_plugin_log::{RotationStrategy, Target, TargetKind};
            // No timezone_strategy — custom `.format(...)` below uses `log_ts` SSOT.
            tauri_plugin_log::Builder::new()
                .targets([
                    Target::new(TargetKind::Stdout),
                    Target::new(TargetKind::LogDir {
                        file_name: Some("speedwave-desktop".into()),
                    }),
                ])
                .level(log::LevelFilter::Trace)
                .level_for("hyper", log::LevelFilter::Warn)
                .level_for("tungstenite", log::LevelFilter::Warn)
                .level_for("tokio_tungstenite", log::LevelFilter::Warn)
                .max_file_size(50_000_000)
                .rotation_strategy(RotationStrategy::KeepSome(10))
                .format(move |callback, message, record| {
                    let sanitized =
                        speedwave_runtime::log_sanitizer::sanitize(&format!("{message}"));
                    // SSOT log timestamp (see `speedwave_runtime::log_ts`).
                    let ts = speedwave_runtime::log_ts::log_timestamp();
                    callback.finish(format_args!(
                        "{ts} [{level}][{target}] {sanitized}",
                        level = record.level(),
                        target = record.target(),
                    ))
                })
                .build()
        })
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Second instance tried to launch — focus the existing window instead.
            if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                let _ = window.set_focus();
                if let Ok(false) = window.is_visible() {
                    let _ = window.show();
                }
            }
        }))
        .manage(initial_session)
        .manage(ide_bridge.clone())
        .manage(clipboard_bridge_slot.clone())
        .manage(plugin_bridges.clone())
        .manage(mcp_os.clone())
        .manage(oauth.clone())
        .manage(queue_service.clone())
        .manage(transcript_store.clone())
        .manage(model_store.clone())
        .manage(transcript_drivers.clone())
        .manage(transcript_forwarders.clone())
        .manage(transcript_downloads.clone())
        .manage(tray_state)
        .setup(move |app| {
            // Fixed at Trace — no user-facing toggle.
            log::set_max_level(log::LevelFilter::Trace);
            logging_cmd::init_bundle_identifier(app.config().identifier.clone());
            if let Err(e) = speedwave_runtime::config::migrate_drop_log_level_in(
                speedwave_runtime::consts::data_dir(),
            ) {
                log::warn!("config migration failed: {e:#}");
            }
            // v3 LLM provenance self-heal: clear foreign models stuck under
            // anthropic entries on disk (ADR-073). Best-effort, idempotent.
            if let Err(e) = speedwave_runtime::config::heal_llm_config_on_disk() {
                log::warn!("LLM config heal failed: {e:#}");
            }

            if let Ok(mut slot) = clipboard_bridge_slot.lock() {
                *slot = clipboard_bridge::spawn(app.handle().clone());
            }

            // Hard-fail on tampered plugins: `plugin::audit_all` re-verifies every plugin,
            // collects failures into one blocking dialog, then exits. Recovery is CLI/manual deletion.
            if let Err(failures) = speedwave_runtime::plugin::audit_all() {
                let body = format_audit_failure_message(&failures);
                log::error!("plugin audit failed:\n{}", body);
                show_audit_failure_dialog_and_exit(app.handle(), "Plugin verification failed", body);
            }

            // Fail-closed on an invalid MDM telemetry policy: an org policy must
            // never silently vanish on an admin typo (resolves the full policy).
            if let Err(e) = speedwave_runtime::config::check_telemetry_policy_at_boot() {
                let body = format!(
                    "Speedwave could not apply the organization telemetry policy.\n\n{e}\n\n\
                     Contact your administrator to correct the managed configuration."
                );
                log::error!("telemetry policy check failed: {}", e);
                show_audit_failure_dialog_and_exit(app.handle(), "Organization policy error", body);
            }

            // Rotated-log cleanup is owned by `RotationStrategy::KeepSome(10)` (pruned on rotation).

            if setup_started {
                // Sanitise v1 SharePoint secrets from the worker-mounted token dir (best-effort, idempotent).
                let cleaned =
                    speedwave_runtime::legacy_token_cleanup::run_legacy_token_cleanup_at_startup();
                if cleaned > 0 {
                    log::info!("legacy token cleanup sanitised {cleaned} project(s)");
                }

                // Self-heal legacy oauth.json shape (ADR-060 addendum); shape-only, never moves secrets.
                // Do not re-log the return value (CodeQL taints it).
                let _ =
                    speedwave_runtime::oauth_state_migration::run_oauth_state_migration_at_startup();

                // Start IDE Bridge
                init_and_start_ide_bridge(&ide_bridge, app.handle());

                // Start a `PluginHostBridge` for every verified plugin declaring a `host_bridge` block.
                // Always on; sits idle on its loopback port when the plugin is disabled in a project.
                crate::bridges::plugin_bridge_manager::init_and_start(
                    &plugin_bridges,
                    app.handle(),
                );

                // Start mcp-os process
                let script = speedwave_runtime::build::resolve_mcp_os_script();
                if let Some(script_path) = script {
                    let script_str = script_path.to_string_lossy().to_string();
                    match speedwave_runtime::mcp_os_process::McpOsProcess::spawn(&script_str) {
                        Ok(proc) => {
                            let new_port = proc.port();
                            log::info!("mcp-os process started (port {new_port})");
                            // Containers reach this host worker via the guest relay under
                            // WSL2 mirrored mode (ADR-079; async no-op otherwise).
                            crate::mirror_relay::ensure_relay_for_port(new_port);
                            if let Ok(mut guard) = mcp_os.lock() {
                                *guard = Some(proc);
                            }

                            // Compose regen + recreate so hub picks up new mcp-os port.
                            reconcile::reconcile_compose_port(app.handle());
                        }
                        Err(e) => log::error!("mcp-os spawn error: {e}"),
                    }
                } else {
                    log::warn!("mcp-os script not found — OS integrations will be unavailable");
                }

                start_mcp_os_watchdog(mcp_os.clone(), app.handle().clone());

                // Start the per-project oauth watchdog; workers are spawned on demand, not here.
                OAUTH_WATCHDOG_STOP.store(false, Ordering::Relaxed);
                start_oauth_watchdog(oauth.clone());
            } else {
                log::info!("setup not started, deferring IDE Bridge / mcp-os / oauth / link_cli until setup completes");
            }

            // Start background auto-update check (store handle for cancellation)
            let handle = updater::spawn_auto_check(app.handle().clone());
            match auto_check_handle.lock() {
                Ok(mut guard) => *guard = Some(handle),
                Err(e) => log::warn!("auto-check handle mutex poisoned: {e}"),
            }

            // Post-setup migrations + CLI re-link + reconcile, ordered, off the
            // main thread — the VM migrations can stop/start the VM (long downloads).
            if setup_started {
                let app_handle = app.handle().clone();
                std::thread::spawn(move || {
                    // A panic in any pre-reconcile step must still resolve
                    // IMAGES_READY, or wait_for_images_ready hangs to timeout.
                    let migrations = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        #[cfg(target_os = "macos")]
                        if let Err(e) = setup_wizard::ensure_lima_vm_config() {
                            log::warn!("Lima VM config migration failed: {e}");
                        }

                        #[cfg(target_os = "windows")]
                        if let Err(e) = setup_wizard::ensure_wslconfig_vpn_compat() {
                            log::warn!(".wslconfig VPN-compat migration failed: {e}");
                        }

                        // automount=metadata for existing distros via `IfIdle`; non-fatal (ADR-052).
                        #[cfg(target_os = "windows")]
                        {
                            use setup_wizard::TerminateOnChange;
                            if let Err(e) =
                                setup_wizard::ensure_wsl_distro_metadata(TerminateOnChange::IfIdle)
                            {
                                log::warn!("wsl.conf metadata migration failed: {e}");
                            }
                        }

                        if let Err(e) = setup_wizard::link_cli() {
                            log::warn!("CLI re-link on startup failed: {e}");
                        }
                    }));
                    if migrations.is_err() {
                        log::error!("post-setup migrations panicked; continuing to reconcile");
                    }
                    reconcile::reconcile_bundle_update(&app_handle);
                });
            }

            // Build system tray from the managed `TrayMenuState`.
            use tauri::Manager;
            let tray_menu = tray::build_tray_menu(
                app.handle(),
                None,
                app.state::<tray::TrayMenuState>().beta_enabled(),
                setup_wizard::is_setup_complete(),
            )?;
            let tray_icon = tray::load_tray_icon()?;

            let mut tray_builder = TrayIconBuilder::with_id("main-tray")
                .icon(tray_icon)
                .icon_as_template(true)
                .tooltip("Speedwave")
                .menu(&tray_menu)
                .on_menu_event(move |app, event| match event.id().as_ref() {
                    "open" => {
                        show_main_window(app);
                    }
                    "check_update" => {
                        let app_clone = app.clone();
                        tauri::async_runtime::spawn(async move {
                            match updater::check_for_update(&app_clone).await {
                                Ok(updater::UpdateCheckOutcome::UpdateAvailable(info)) => {
                                    log::info!(
                                        "update available from tray check: {}",
                                        info.version
                                    );
                                    use tauri::Emitter;
                                    if let Err(e) = app_clone.emit("update_available", &info) {
                                        log::error!("failed to emit update_available event: {e}");
                                    }
                                }
                                Ok(updater::UpdateCheckOutcome::UpToDate) => {
                                    log::info!("tray update check found no new version");
                                }
                                Err(e) => {
                                    log::error!("tray update check failed: {e}");
                                }
                            }
                        });
                    }
                    "install_update" => {
                        let app_for_state = app.clone();
                        let app_clone = app.clone();
                        tauri::async_runtime::spawn(async move {
                            let version =
                                app_for_state.state::<tray::TrayMenuState>().update_version();
                            if let Some(expected) = version {
                                let result = update_commands::install_update_and_reconcile(
                                    app_clone.clone(),
                                    expected,
                                )
                                .await;

                                match result {
                                    Ok(()) => {
                                        log::info!("tray install-update action completed");
                                    }
                                    Err(e) => {
                                        log::error!("tray install-update action failed: {e}");
                                    }
                                }
                            } else {
                                log::warn!(
                                    "install_update clicked from tray but no version available"
                                );
                            }
                        });
                    }
                    "toggle_beta" => {
                        let app_clone = app.clone();
                        tauri::async_runtime::spawn(async move {
                            let current =
                                app_clone.state::<tray::TrayMenuState>().beta_enabled();
                            if let Err(e) =
                                ui_prefs_cmd::apply_beta_toggle_inner(&app_clone, !current).await
                            {
                                log::error!("beta toggle from tray failed: {e}");
                            }
                        });
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    other => {
                        log::warn!("unhandled tray menu event: {other}");
                    }
                });

            // macOS/Windows: left-click on tray icon toggles window visibility.
            {
                use std::sync::atomic::AtomicU64;
                // Debounce: ignore clicks within 500ms (Windows default double-click interval,
                // which fires two Click::Up events) to prevent double-toggle.
                static LAST_CLICK_MS: AtomicU64 = AtomicU64::new(0);
                const DEBOUNCE_MS: u64 = 500;

                tray_builder = tray_builder
                    .show_menu_on_left_click(false)
                    .on_tray_icon_event(|tray, event| {
                        if let tauri::tray::TrayIconEvent::Click {
                            button: tauri::tray::MouseButton::Left,
                            button_state: tauri::tray::MouseButtonState::Up,
                            ..
                        } = event
                        {
                            let now = match std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                            {
                                // as u64: truncation at ~584 million years — safe
                                Ok(d) => d.as_millis() as u64,
                                Err(e) => {
                                    log::warn!(
                                        "system clock error (before Unix epoch?): {e}"
                                    );
                                    0
                                }
                            };
                            let prev = LAST_CLICK_MS.swap(now, Ordering::Relaxed);
                            if should_debounce(prev, now, DEBOUNCE_MS) {
                                return;
                            }

                            let app = tray.app_handle();
                            let visible = match app.get_webview_window(MAIN_WINDOW_LABEL) {
                                Some(w) => match w.is_visible() {
                                    Ok(v) => v,
                                    Err(e) => {
                                        log::error!("failed to check main window visibility: {e}");
                                        false
                                    }
                                },
                                None => {
                                    log::warn!("main window not found for visibility check");
                                    false
                                }
                            };
                            if visible {
                                hide_main_window(app);
                            } else {
                                show_main_window(app);
                            }
                        }
                    });
            }

            match tray_builder.build(app) {
                Ok(_tray) => {
                    log::info!("system tray created");
                    tray_available_setup.store(true, Ordering::Relaxed);
                }
                Err(e) => {
                    // Tray creation failed; window is already visible (tauri.conf.json: visible=true).
                    log::error!("failed to create system tray: {e}");
                }
            }

            // Listen for update_available events (from auto-check) to update tray menu.
            let app_handle_listener = app.handle().clone();
            use tauri::Listener;
            app.listen(
                "update_available",
                move |event| match serde_json::from_str::<updater::UpdateInfo>(event.payload()) {
                    Ok(info) => {
                        app_handle_listener
                            .state::<tray::TrayMenuState>()
                            .set_update_version(Some(info.version));
                        tray::refresh_tray_menu(&app_handle_listener);
                    }
                    Err(e) => {
                        log::warn!("failed to deserialize update_available payload: {e}");
                    }
                },
            );

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Setup wizard
            containers_cmd::check_runtime,
            containers_cmd::init_vm,
            containers_cmd::create_project,
            containers_cmd::link_cli,
            // System checks
            containers_cmd::run_system_check,
            // Container lifecycle
            containers_cmd::is_setup_complete,
            containers_cmd::build_images,
            containers_cmd::start_containers,
            containers_cmd::defer_container_start,
            containers_cmd::check_containers_running,
            // Settings
            containers_cmd::factory_reset,
            containers_cmd::get_llm_config,
            containers_cmd::get_default_base_url,
            containers_cmd::list_anthropic_models,
            containers_cmd::update_llm_config,
            containers_cmd::set_llm_provider_key,
            containers_cmd::clear_active_llm_provider,
            containers_cmd::restart_llm_proxy,
            containers_cmd::get_telemetry_config,
            containers_cmd::update_telemetry_config,
            containers_cmd::probe_otlp_endpoint,
            llm_cmd::discover_llm_models,
            llm_cmd::get_llm_usage,
            llm_cmd::get_usage_for_response,
            llm_cmd::get_session_cost,
            llm_cmd::get_conversation_cost,
            // Authentication
            auth_commands::save_api_key,
            auth_commands::delete_api_key,
            auth_commands::get_auth_status,
            auth_commands::anthropic_logout,
            oauth_login_cmd::start_oauth_login,
            // URL opener
            url_validation::open_url,
            // Platform
            url_validation::get_platform,
            auth_commands::get_auth_command,
            // Chat
            chat_session_cmd::start_chat,
            chat_session_cmd::send_message,
            paste_cmd::save_pasted_image,
            chat_session_cmd::submit_question_answer,
            chat_session_cmd::stop_chat,
            retry_cmd::retry_last_turn,
            // Queued messages (ADR-045)
            queue_cmd::queue_message,
            queue_cmd::cancel_queued_message,
            // Meeting transcription (ADR-056)
            transcription_cmd::transcription_capabilities,
            transcription_cmd::list_audio_sources,
            transcription_cmd::start_transcription,
            transcription_cmd::stop_transcription,
            transcription_cmd::subscribe_transcript,
            transcription_cmd::list_transcripts,
            transcription_cmd::get_transcript,
            transcription_cmd::delete_transcript,
            transcription_cmd::get_transcript_markdown,
            transcription_cmd::recommended_transcription_model,
            transcription_cmd::list_transcription_models,
            transcription_cmd::download_transcription_model,
            transcription_cmd::delete_transcription_model,
            // Chat history
            history_cmd::list_conversations,
            history_cmd::get_conversation,
            history_cmd::delete_conversation,
            history_cmd::get_project_memory,
            chat_session_cmd::resume_conversation,
            // Project management
            project_cmd::list_projects,
            project_cmd::switch_project,
            containers_cmd::add_project,
            containers_cmd::remove_project,
            // Health
            health_cmd::get_health,
            // Container logs
            container_logs_cmd::get_all_logs,
            // IDE Bridge
            ide_bridge_cmd::list_available_ides,
            ide_bridge_cmd::select_ide,
            ide_bridge_cmd::disconnect_ide,
            ide_bridge_cmd::get_selected_ide,
            // Per-plugin host bridges (manifest-declared)
            plugin_bridge_get_credentials,
            plugin_bridge_get_status,
            // Update
            update_commands::check_for_update,
            update_commands::install_update_and_reconcile,
            update_commands::get_update_settings,
            update_commands::set_update_settings,
            update_commands::get_bundle_reconcile_state,
            // UI preferences (ADR-058)
            ui_prefs_cmd::get_beta_enabled,
            // Diagnostics
            export_diagnostics,
            // Integrations
            integrations_cmd::get_integrations,
            integrations_cmd::set_integration_enabled,
            integrations_cmd::set_os_integration_enabled,
            integrations_cmd::validate_os_integrations_on_startup,
            integrations_cmd::save_integration_credentials,
            integrations_cmd::save_redmine_mappings,
            integrations_cmd::delete_integration_credentials,
            integrations_cmd::restart_integration_containers,
            containers_cmd::recreate_project_containers,
            // OAuth
            oauth_cmd::start_sharepoint_oauth,
            oauth_cmd::cancel_sharepoint_oauth,
            github_oauth_cmd::start_github_oauth,
            github_oauth_cmd::cancel_github_oauth,
            plugin_oauth_cmd::start_plugin_oauth,
            plugin_oauth_cmd::cancel_plugin_oauth,
            slack_oauth_cmd::start_slack_oauth,
            slack_oauth_cmd::cancel_slack_oauth,
            plugin_oauth_cmd::forget_plugin_oauth,
            // Redmine API proxy
            redmine_api_cmd::validate_redmine_credentials,
            redmine_api_cmd::fetch_redmine_enumerations,
            // Plugins
            plugin_cmd::get_plugins,
            plugin_cmd::peek_plugin_manifest,
            plugin_cmd::install_plugin,
            plugin_cmd::remove_plugin,
            plugin_cmd::set_plugin_enabled,
            plugin_cmd::save_plugin_credentials,
            plugin_cmd::delete_plugin_credentials,
            plugin_cmd::delete_plugin_credential_field,
            plugin_cmd::plugin_save_settings,
            plugin_cmd::plugin_load_settings,
            // Slash menu discovery
            slash_cmd::list_slash_commands,
            slash_cmd::invalidate_slash_cache,
            // Git introspection (chat status strip)
            git_cmd::get_git_branch,
            // CloudStorage TCC
            system_settings_cmd::open_files_folders_pane,
            cloudstorage_cmd::detect_cloudstorage_path,
            // Meeting-transcription TCC (ADR-056) — in-process mic consent plus
            // deep-links to the macOS Microphone / Audio panes.
            mic_permission_cmd::request_microphone_permission,
            mic_permission_cmd::microphone_permission_status,
            system_settings_cmd::open_microphone_pane,
            system_settings_cmd::open_audio_capture_pane,
        ])
        .on_window_event(move |window, event| {
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    if should_prevent_close(
                        window.label(),
                        tray_available_close.load(Ordering::Relaxed),
                    ) {
                        // Tray is available — hide window, app lives in tray.
                        api.prevent_close();
                        hide_main_window(window.app_handle());
                    }
                }
                tauri::WindowEvent::Destroyed => {
                    if !should_run_cleanup(window.label()) {
                        return;
                    }
                    // Do NOT join here (would deadlock the event loop); stash the handle for `RunEvent::Exit`.
                    if let Some(handle) = reconcile::run_exit_cleanup(&cleanup_ctx_window) {
                        stash_cleanup_handle(&exit_cleanup_handle_window, handle);
                    }
                }
                tauri::WindowEvent::Focused(focused) => {
                    if should_emit_focus_event(window.label(), *focused) {
                        use tauri::Emitter;
                        let _ = window.emit("window_focused", ());
                    }
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!());

    let app = match app {
        Ok(app) => app,
        Err(e) => {
            log::error!("Tauri application failed to start, exiting: {e}");
            std::process::exit(1);
        }
    };

    app.run(move |app_handle, event| match event {
        // Covers exit paths where `WindowEvent::Destroyed` does not fire (tray Quit, macOS Cmd+Q, SIGTERM).
        // `CLEANUP_ONCE` in `run_exit_cleanup` makes this idempotent with the `Destroyed` call site.
        tauri::RunEvent::ExitRequested { .. } => {
            // Hide the window first to avoid a beachball on Cmd+Q; harmless no-op on Windows.
            hide_main_window(app_handle);
            if let Some(handle) = reconcile::run_exit_cleanup(&cleanup_ctx_runevent) {
                stash_cleanup_handle(&exit_cleanup_handle_runevent, handle);
            }
        }
        tauri::RunEvent::Exit => {
            // Joins the stashed cleanup thread (Cmd+Q skips earlier arms; spawns inline if empty).
            // Test `exit_arm_runs_cleanup_when_handle_slot_is_empty` pins both call sites.
            let handle = match exit_cleanup_handle_runevent.lock() {
                Ok(mut slot) => slot.take(),
                Err(e) => {
                    log::warn!("exit cleanup handle slot poisoned at exit: {e}");
                    None
                }
            };
            let handle = handle.or_else(|| {
                hide_main_window(app_handle);
                reconcile::run_exit_cleanup(&cleanup_ctx_runevent)
            });
            if let Some(handle) = handle {
                join_with_exit_watchdog(handle);
            }
        }
        _ => {}
    });
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
#[expect(clippy::unwrap_used, reason = "test-only assertions")]
mod tests {
    use super::*;

    fn v(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    // -- log_panic_with_fallback --

    #[test]
    fn log_panic_with_fallback_runs_log_fn_when_it_succeeds() {
        let ran = std::cell::Cell::new(false);
        log_panic_with_fallback("msg", || ran.set(true));
        assert!(ran.get(), "log_fn must run on the happy path");
    }

    /// Regression guard: a panic inside `log_fn` (e.g. tauri-plugin-log on a broken pipe) must not
    /// propagate — it is caught and handled by the eprintln fallback, not abort().
    #[test]
    fn log_panic_with_fallback_survives_a_panicking_log_fn() {
        log_panic_with_fallback("msg", || panic!("simulated log sink panic"));
        // Reaching this line proves the panic did not propagate out of the call.
    }

    #[test]
    fn oauth_reconcile_no_change_when_sets_equal() {
        assert_eq!(
            oauth_reconcile_action(&v(&["a", "b"]), &v(&["a", "b"])),
            OauthReconcile::NoChange
        );
    }

    #[test]
    fn oauth_reconcile_respawn_when_set_grows() {
        assert_eq!(
            oauth_reconcile_action(&v(&["a"]), &v(&["a", "b"])),
            OauthReconcile::Respawn {
                clear_bearer_map: false
            }
        );
    }

    #[test]
    fn oauth_reconcile_respawn_when_set_shrinks_but_nonempty() {
        assert_eq!(
            oauth_reconcile_action(&v(&["a", "b"]), &v(&["a"])),
            OauthReconcile::Respawn {
                clear_bearer_map: false
            }
        );
    }

    #[test]
    fn oauth_reconcile_clears_bearer_map_when_set_emptied() {
        assert_eq!(
            oauth_reconcile_action(&v(&["a"]), &[]),
            OauthReconcile::Respawn {
                clear_bearer_map: true
            }
        );
    }

    #[test]
    fn plugin_bridge_credentials_response_wire_format() {
        let resp = PluginBridgeCredentialsResponse {
            slug: "example-plugin".into(),
            url: "ws://127.0.0.1:60123/".into(),
            token: "uuid-token".into(),
        };
        let expected = serde_json::json!({
            "slug": "example-plugin",
            "url": "ws://127.0.0.1:60123/",
            "token": "uuid-token",
        });
        assert_eq!(serde_json::to_value(&resp).unwrap(), expected);
    }

    #[test]
    fn plugin_bridge_status_response_running_wire_format() {
        let resp = PluginBridgeStatusResponse::Running {
            slug: "example-plugin".into(),
            running: true,
            port: 60123,
            paired: true,
            partner_connected: true,
            display_name: "Example Plugin Bridge".into(),
        };
        let expected = serde_json::json!({
            "slug": "example-plugin",
            "running": true,
            "port": 60123,
            "paired": true,
            "partner_connected": true,
            "display_name": "Example Plugin Bridge",
        });
        assert_eq!(serde_json::to_value(&resp).unwrap(), expected);
    }

    #[test]
    fn plugin_bridge_status_response_not_running_wire_format() {
        let resp = PluginBridgeStatusResponse::NotRunning {
            slug: "example-plugin".into(),
            running: false,
        };
        let expected = serde_json::json!({
            "slug": "example-plugin",
            "running": false,
        });
        assert_eq!(serde_json::to_value(&resp).unwrap(), expected);
    }

    #[test]
    fn format_audit_failure_message_lists_every_failure_and_recovery_steps() {
        let failures = vec![
            (
                "acme-tools".to_string(),
                "SIGNATURE file not present".to_string(),
            ),
            (
                "widget".to_string(),
                "Ed25519 verification failed".to_string(),
            ),
        ];
        let msg = format_audit_failure_message(&failures);
        // Every affected slug appears, with its reason.
        assert!(msg.contains("acme-tools: SIGNATURE file not present"));
        assert!(msg.contains("widget: Ed25519 verification failed"));
        // Recovery instructions point at the CLI (Settings is unreachable here).
        assert!(msg.contains("speedwave plugin remove"));
        assert!(msg.contains("speedwave plugin install"));
        assert!(msg.contains("~/.speedwave/plugins/"));
    }

    #[test]
    fn format_audit_failure_message_handles_single_failure() {
        let msg = format_audit_failure_message(&[("solo".to_string(), "tampered".to_string())]);
        assert!(msg.contains("solo: tampered"));
        assert_eq!(
            msg.matches('•').count(),
            1,
            "exactly one bullet for one failure"
        );
    }

    // ── sweep_per_project_workers: covers watchdog selection without real subprocesses ──
    // The fake implements WatchdogWorker; the helper is reused by the oauth watchdog in production.

    struct FakeWorker {
        alive: bool,
        port: u16,
        respawn_result: Result<u16, String>,
        respawn_calls: std::cell::Cell<u32>,
    }
    impl FakeWorker {
        fn new(alive: bool, respawn_result: Result<u16, String>) -> Self {
            Self::with_port(alive, 100, respawn_result)
        }
        fn with_port(alive: bool, port: u16, respawn_result: Result<u16, String>) -> Self {
            Self {
                alive,
                port,
                respawn_result,
                respawn_calls: std::cell::Cell::new(0),
            }
        }
    }
    impl WatchdogWorker for FakeWorker {
        fn is_alive(&self) -> bool {
            self.alive
        }
        fn respawn(&mut self) -> anyhow::Result<u16> {
            self.respawn_calls.set(self.respawn_calls.get() + 1);
            // After a successful respawn the fake reports alive=true (matches real OauthProcess).
            match &self.respawn_result {
                Ok(p) => {
                    self.alive = true;
                    self.port = *p;
                    Ok(*p)
                }
                Err(e) => Err(anyhow::anyhow!(e.clone())),
            }
        }
        fn port(&self) -> u16 {
            self.port
        }
    }

    fn respawned_names(outcome: &SweepOutcome) -> Vec<String> {
        outcome.respawned.iter().map(|w| w.name.clone()).collect()
    }

    #[test]
    fn sweep_per_project_workers_empty_map_returns_empty() {
        let mut map: std::collections::HashMap<String, FakeWorker> = Default::default();
        let outcome = sweep_per_project_workers(&mut map, "test");
        assert!(outcome.respawned.is_empty());
        assert!(outcome.alive_ports.is_empty());
    }

    #[test]
    fn sweep_per_project_workers_skips_alive_workers_but_reports_their_ports() {
        let mut map = std::collections::HashMap::new();
        map.insert("p".to_string(), FakeWorker::with_port(true, 4321, Ok(9999)));
        let outcome = sweep_per_project_workers(&mut map, "test");
        assert!(
            outcome.respawned.is_empty(),
            "alive worker must not be respawned"
        );
        // Live ports feed the relay re-ensure (a distro restart wipes relays; ADR-079).
        assert_eq!(outcome.alive_ports, vec![4321]);
        assert_eq!(map["p"].respawn_calls.get(), 0);
    }

    #[test]
    fn sweep_per_project_workers_collects_all_unhealthy_in_one_pass() {
        // Bug class: a break-early regression would skip the second project.
        let mut map = std::collections::HashMap::new();
        map.insert("a".to_string(), FakeWorker::new(false, Ok(1111)));
        map.insert("b".to_string(), FakeWorker::new(false, Ok(2222)));
        let outcome = sweep_per_project_workers(&mut map, "test");
        let mut names = respawned_names(&outcome);
        names.sort();
        assert_eq!(names, vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn sweep_per_project_workers_failed_respawn_excluded_from_respawned() {
        // Bug class: recreating containers for a worker that didn't come back up.
        let mut map = std::collections::HashMap::new();
        map.insert(
            "bad".to_string(),
            FakeWorker::new(false, Err("spawn failed".into())),
        );
        map.insert("good".to_string(), FakeWorker::new(false, Ok(3333)));
        let outcome = sweep_per_project_workers(&mut map, "test");
        assert_eq!(respawned_names(&outcome), vec!["good".to_string()]);
        // The failed worker WAS attempted (so we don't silently skip retries).
        assert_eq!(map["bad"].respawn_calls.get(), 1);
    }

    #[test]
    fn sweep_per_project_workers_mixed_alive_and_dead() {
        let mut map = std::collections::HashMap::new();
        map.insert("alive".to_string(), FakeWorker::with_port(true, 77, Ok(0)));
        map.insert(
            "dead".to_string(),
            FakeWorker::with_port(false, 4000, Ok(4444)),
        );
        let outcome = sweep_per_project_workers(&mut map, "test");
        assert_eq!(respawned_names(&outcome), vec!["dead".to_string()]);
        // Old + new port travel with the respawn so the watchdog can swap relays.
        assert_eq!(outcome.respawned[0].old_port, 4000);
        assert_eq!(outcome.respawned[0].new_port, 4444);
        assert_eq!(outcome.alive_ports, vec![77]);
        assert_eq!(map["alive"].respawn_calls.get(), 0);
        assert_eq!(map["dead"].respawn_calls.get(), 1);
    }

    /// Wiring guard: the per-project (oauth) watchdog must re-ensure live workers'
    /// relays and swap relays on respawn — a WSL distro restart wipes them (ADR-079).
    #[test]
    fn per_project_watchdog_reensures_mirror_relay() {
        let source = include_str!("main.rs");
        let start = source
            .find("fn start_per_project_watchdog")
            .expect("start_per_project_watchdog must exist");
        let region = &source[start..];
        let end = region.find("\nfn ").unwrap_or(region.len());
        // Match the CALL token, not the bare identifier — a comment must not satisfy it.
        assert!(
            region[..end].contains("mirror_relay::ensure_relay_for_port("),
            "per-project watchdog must re-ensure relays for live workers"
        );
        assert!(
            region[..end].contains("swap_relay_for_respawn("),
            "per-project watchdog must swap relays on a port-changing respawn"
        );
    }

    /// Wiring guard: the mcp-os watchdog must re-ensure the relay on its health check
    /// so a WSL distro restart (which the host process outlives) self-heals (ADR-079).
    #[test]
    fn mcp_os_watchdog_reensures_mirror_relay() {
        let source = include_str!("main.rs");
        let start = source
            .find("fn start_mcp_os_watchdog")
            .expect("start_mcp_os_watchdog must exist");
        // Bound to this fn (up to the next top-level `fn`) so we don't match a neighbour.
        let region = &source[start..];
        let end = region.find("\nfn ").unwrap_or(region.len());
        // Match the CALL token, not the bare identifier — a comment must not satisfy it.
        assert!(
            region[..end].contains("mirror_relay::ensure_relay_for_port("),
            "mcp-os watchdog must re-ensure the relay so a distro restart self-heals"
        );
        assert!(
            region[..end].contains("swap_relay_for_respawn("),
            "mcp-os watchdog must swap the relay on respawn"
        );
    }

    #[test]
    fn swap_relay_for_respawn_only_drops_old_when_port_changed() {
        // Guard against an ephemeral-port reuse tearing down the fresh relay: the old
        // relay is dropped ONLY when the port actually changed (ADR-079 / S3).
        let source = include_str!("main.rs");
        let start = source
            .find("fn swap_relay_for_respawn")
            .expect("swap_relay_for_respawn must exist");
        let region = &source[start..];
        let end = region.find("\nfn ").unwrap_or(region.len());
        assert!(
            region[..end].contains("if old_port != new_port"),
            "swap must guard the old-relay teardown on a port change"
        );
        assert!(
            region[..end].contains("mirror_relay::remove_relay_for_port_async(")
                && region[..end].contains("mirror_relay::ensure_relay_for_port("),
            "swap must drop the old relay and ensure the new one"
        );
    }

    #[test]
    fn mcp_os_health_outcome_transitions() {
        use super::{mcp_os_health_outcome, HealthOutcome};
        // Alive resets the unhealthy counter.
        assert_eq!(mcp_os_health_outcome(true, 3, 5), (HealthOutcome::Alive, 0));
        // Unhealthy below the cap → respawn, counter increments.
        assert_eq!(
            mcp_os_health_outcome(false, 0, 5),
            (HealthOutcome::ShouldRespawn, 1)
        );
        assert_eq!(
            mcp_os_health_outcome(false, 3, 5),
            (HealthOutcome::ShouldRespawn, 4)
        );
        // Reaching the cap → cooldown, counter resets (no respawn-storm).
        assert_eq!(
            mcp_os_health_outcome(false, 4, 5),
            (HealthOutcome::Cooldown, 0)
        );
    }

    /// Structural test: all exit paths must use `join_with_exit_watchdog`
    /// instead of inline watchdog patterns.
    #[test]
    fn both_exit_paths_use_join_with_exit_watchdog() {
        let source = include_str!("main.rs");
        let occurrences: Vec<_> = source.match_indices("join_with_exit_watchdog").collect();
        // Expected non-test occurrences (at least 3, outside the test module): fn def, ctrlc
        // handler call site (blocks — safe on ctrlc's dedicated thread), RunEvent::Exit call site.
        let non_test_count = occurrences
            .iter()
            .filter(|(idx, _)| {
                // Exclude occurrences inside #[cfg(test)] mod tests block
                let before = &source[..*idx];
                let last_mod_tests = before.rfind("mod tests");
                let last_cfg_test = before.rfind("#[cfg(test)]");
                // Inside the test module when cfg(test) precedes the nearest `mod tests`.
                match (last_mod_tests, last_cfg_test) {
                    (Some(mt), Some(ct)) if ct < mt && *idx > mt => false,
                    _ => true,
                }
            })
            .count();
        assert!(
            non_test_count >= 3,
            "join_with_exit_watchdog must appear at least 3 times outside tests \
             (1 definition + 2 call sites: signal handler and RunEvent::Exit), \
             found {non_test_count}"
        );
    }

    /// Regression guard: the `ExitRequested` arm must hide the main window
    /// (via `hide_main_window`) before spawning cleanup, to avoid a Cmd+Q beachball.
    #[test]
    fn exit_requested_arm_hides_main_window_before_cleanup() {
        let source = include_str!("main.rs");
        let arm_start = source
            .find("tauri::RunEvent::ExitRequested { .. } =>")
            .expect("ExitRequested arm must exist");
        let arm_region = &source[arm_start..source.len().min(arm_start + 2_000)];
        let exit_arm = arm_region
            .find("tauri::RunEvent::Exit =>")
            .map_or(arm_region, |end| &arm_region[..end]);
        let hide_idx = exit_arm.find("hide_main_window(app_handle)").expect(
            "ExitRequested arm must call hide_main_window(app_handle) \
                 (the canonical helper) to prevent beachball",
        );
        let cleanup_idx = exit_arm
            .find("run_exit_cleanup")
            .expect("ExitRequested arm must call run_exit_cleanup");
        assert!(
            hide_idx < cleanup_idx,
            "hide_main_window(app_handle) must appear BEFORE run_exit_cleanup in \
             the ExitRequested arm — otherwise the window stays visible during \
             cleanup and macOS shows a beachball"
        );
    }

    /// Regression guard: the `ExitRequested` arm must stash its cleanup handle into
    /// `exit_cleanup_handle_runevent` so `RunEvent::Exit` can join it before the process exits.
    #[test]
    fn exit_requested_arm_stashes_handle_for_exit_join() {
        let source = include_str!("main.rs");
        let arm_start = source
            .find("tauri::RunEvent::ExitRequested { .. } =>")
            .expect("ExitRequested arm must exist");
        let arm_region = &source[arm_start..source.len().min(arm_start + 2_000)];
        let exit_arm = arm_region
            .find("tauri::RunEvent::Exit =>")
            .map_or(arm_region, |end| &arm_region[..end]);
        assert!(
            exit_arm.contains("exit_cleanup_handle_runevent"),
            "the ExitRequested arm must reference exit_cleanup_handle_runevent \
             so RunEvent::Exit can join the cleanup thread before the process exits"
        );
        assert!(
            exit_arm.contains("stash_cleanup_handle"),
            "the ExitRequested arm must call stash_cleanup_handle to \
             store the JoinHandle — direct slot manipulation would bypass the \
             write-once safety logic in the helper"
        );
    }

    /// Regression guard: the `RunEvent::Exit` arm must call `run_exit_cleanup` as a
    /// fallback when the handle slot is empty (macOS Cmd+Q bypasses the earlier arms).
    #[test]
    fn exit_arm_runs_cleanup_when_handle_slot_is_empty() {
        let source = include_str!("main.rs");
        let arm_start = source
            .find("tauri::RunEvent::Exit =>")
            .expect("Exit arm must exist");
        let after_arm = &source[arm_start..];
        let arm_end = after_arm
            .find("\n            _ => {}")
            .unwrap_or(after_arm.len());
        let exit_arm = &after_arm[..arm_end];
        assert!(
            exit_arm.contains("run_exit_cleanup(&cleanup_ctx_runevent)"),
            "the RunEvent::Exit arm must fall back to \
             run_exit_cleanup(&cleanup_ctx_runevent) when the handle slot is \
             empty — otherwise macOS Cmd+Q (which delivers \
             applicationWillTerminate and bypasses ExitRequested) orphans \
             the Lima VM"
        );
        assert!(
            exit_arm.contains("hide_main_window(app_handle)"),
            "the RunEvent::Exit arm must hide the main window before \
             spawning the fallback cleanup to avoid a beachball during \
             limactl stop"
        );
    }

    /// Behavioral test for `stash_cleanup_handle` happy path: handle is
    /// stashed into an empty slot.
    #[test]
    fn stash_cleanup_handle_stores_into_empty_slot() {
        let slot: Arc<Mutex<Option<std::thread::JoinHandle<()>>>> = Arc::new(Mutex::new(None));
        let handle = std::thread::spawn(|| {});
        stash_cleanup_handle(&slot, handle);

        let stashed = slot.lock().unwrap().take();
        // Regression guard: an inverted empty-slot branch would leave this None.
        assert!(
            stashed.is_some(),
            "first handle must be stashed into empty slot"
        );
        stashed.unwrap().join().expect("test thread must not panic");
    }

    /// CSP must allow `blob:`/`data:` images, else WebView2 (Windows) renders
    /// paste-preview thumbnails as broken-image icons.
    #[test]
    fn csp_img_src_allows_blob_and_data_for_paste_preview() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))
            .expect("tauri.conf.json parses");
        let csp = conf["app"]["security"]["csp"]
            .as_str()
            .expect("app.security.csp is a string");

        // Find the directive that governs <img> loading: img-src, or default-src as fallback.
        let directive = csp
            .split(';')
            .map(str::trim)
            .find(|d| d.starts_with("img-src"))
            .or_else(|| {
                csp.split(';')
                    .map(str::trim)
                    .find(|d| d.starts_with("default-src"))
            })
            .unwrap_or_else(|| panic!("CSP must define img-src or default-src; got: {csp}"));

        assert!(
            directive.contains("blob:"),
            "CSP image directive must allow blob: for paste-preview thumbnails \
             (broken-image on Windows WebView2 otherwise); got: {directive}"
        );
        assert!(
            directive.contains("data:"),
            "CSP image directive must allow data: for image sources; got: {directive}"
        );
    }
}
