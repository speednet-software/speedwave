//! Speedwave Desktop — Tauri v2 backend. Thin `#[tauri::command]` wrappers delegating to module
//! functions; each converts `anyhow::Result` into `Result<T, String>` for serializable errors.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod auth;
mod auth_commands;
mod bridges;
mod chat;
mod chat_session_cmd;
mod claude_settings;
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
mod mic_permission_cmd;
mod mirror_relay;
mod oauth_cmd;
mod oauth_flow;
mod oauth_login_cmd;
mod oauth_loopback;
mod oauth_providers;
mod paste_cmd;
#[cfg(target_os = "windows")]
mod path_util;
mod pii_display;
mod pin_cmd;
mod plugin_cmd;
mod plugin_oauth_cmd;
mod project_cmd;
mod queue_cmd;
mod reconcile;
mod redmine_api_cmd;
mod retry_cmd;
mod session_model;
mod setup_wizard;
mod slack_oauth_cmd;
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

pub(crate) use project_cmd::{rebind_chat, rollback_and_emit_failed};

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

pub(crate) fn stash_cleanup_handle(
    slot: &Arc<Mutex<Option<std::thread::JoinHandle<()>>>>,
    handle: std::thread::JoinHandle<()>,
) {
    match slot.lock() {
        Ok(mut guard) => {
            if guard.is_none() {
                *guard = Some(handle);
            }
        }
        Err(e) => {
            log::warn!("exit cleanup handle slot poisoned, cleanup will not be joined: {e}");
        }
    }
}

const MAIN_WINDOW_LABEL: &str = "main";

fn is_own_origin(url: &url::Url) -> bool {
    match url.scheme() {
        "tauri" => true,
        "http" | "https" => matches!(url.host_str(), Some("localhost") | Some("tauri.localhost")),
        _ => false,
    }
}

fn blocked_navigation_origin(url: &url::Url) -> String {
    format!(
        "{}://{}",
        url.scheme(),
        url.host_str().unwrap_or("<no-host>")
    )
}

static WATCHDOG_STOP: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

static OAUTH_WATCHDOG_STOP: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

pub(crate) const MSG_NOT_AUTHENTICATED: &str =
    "Claude is not authenticated. Please authenticate first.";

use diagnostics::export_diagnostics;
use window::should_debounce;
use window::{
    hide_main_window, should_emit_focus_event, should_prevent_close, should_run_cleanup,
    show_main_window,
};

fn init_and_start_ide_bridge(ide_bridge: &SharedIdeBridge, app_handle: &tauri::AppHandle) {
    if let Some(bridge) = init_and_start_ide_bridge_inner(app_handle) {
        if let Ok(mut guard) = ide_bridge.lock() {
            *guard = Some(bridge);
        }
    }
}

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

#[derive(Serialize)]
struct PluginBridgeCredentialsResponse {
    slug: String,
    url: String,
    token: String,
}

#[derive(Serialize)]
#[serde(untagged)]
enum PluginBridgeStatusResponse {
    Running {
        slug: String,
        running: bool,
        port: u16,
        paired: bool,
        partner_connected: bool,
        display_name: String,
    },
    NotRunning {
        slug: String,
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

#[derive(Debug, PartialEq, Eq)]
enum HealthOutcome {
    Alive,
    ShouldRespawn,
    Cooldown,
}

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

fn start_mcp_os_watchdog(mcp_os: SharedMcpOs, app_handle: tauri::AppHandle) {
    std::thread::spawn(move || {
        use std::time::Duration;
        const CHECK_INTERVAL: Duration = Duration::from_secs(30);
        const MAX_UNHEALTHY: u32 = 5;
        const COOLDOWN: Duration = Duration::from_secs(300);
        let mut consecutive_unhealthy: u32 = 0;

        enum Tick {
            Respawned(u16),
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
                    log::error!("mcp-os watchdog mutex poisoned: {e}");
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
                            HealthOutcome::Alive => Tick::Nothing,
                            HealthOutcome::Cooldown => Tick::Cooldown,
                            HealthOutcome::ShouldRespawn => {
                                log::warn!(
                                    "mcp-os process unhealthy ({consecutive_unhealthy}/{MAX_UNHEALTHY}), respawning"
                                );
                                match proc.respawn() {
                                    Ok(new) => Tick::Respawned(new),
                                    Err(e) => {
                                        log::error!("mcp-os respawn failed: {e}");
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
                Tick::Respawned(new) => {
                    log::info!("mcp-os respawned (port {new})");
                    reconcile::reconcile_compose_port(&app_handle);
                }
                Tick::Cooldown => {
                    log::error!(
                        "mcp-os unhealthy for {MAX_UNHEALTHY} consecutive checks, cooling down"
                    );
                    std::thread::sleep(COOLDOWN);
                }
            }
        }
        log::info!("mcp-os watchdog stopped");
    });
}

pub(crate) fn ensure_ide_bridge_running(
    ide_bridge: &SharedIdeBridge,
    app_handle: &tauri::AppHandle,
) {
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
                let worker = crate::mirror_relay::RelayedWorker::new(proc);
                log::info!("mcp-os started (port {})", worker.port());
                *guard = Some(worker);
                drop(guard);
                WATCHDOG_STOP.store(false, Ordering::Relaxed);
                start_mcp_os_watchdog(mcp_os.clone(), app_handle.clone());
            }
            Err(e) => log::error!("mcp-os spawn failed: {e}"),
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum OauthReconcile {
    NoChange,
    Respawn { clear_bearer_map: bool },
}

pub(crate) fn oauth_reconcile_action(current: &[String], desired: &[String]) -> OauthReconcile {
    if current == desired {
        OauthReconcile::NoChange
    } else {
        OauthReconcile::Respawn {
            clear_bearer_map: desired.is_empty(),
        }
    }
}

pub(crate) fn ensure_oauth_running(oauth_arc: &SharedOauth, project: &str) -> bool {
    let mut map = match oauth_arc.lock() {
        Ok(g) => g,
        Err(e) => {
            log::error!("oauth worker map mutex poisoned: {e}");
            return false;
        }
    };
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

    let installed = speedwave_runtime::plugin::list_installed_plugins().unwrap_or_default();
    let mut oauth_consumers =
        speedwave_runtime::compose::oauth_consumer_service_ids(&resolved, &installed);
    oauth_consumers.sort();

    let mut retired_relay: Option<crate::mirror_relay::RetiredRelay> = None;

    if let Some(running) = map.get(project) {
        let mut current: Vec<String> = running.inner().spec().consumers().to_vec();
        current.sort();
        match oauth_reconcile_action(&current, &oauth_consumers) {
            OauthReconcile::NoChange => {
                running.ensure_relay();
                return false;
            }
            OauthReconcile::Respawn { clear_bearer_map } => {
                log::info!(
                    "oauth worker for '{project}' consumer set changed ({current:?} -> {oauth_consumers:?}); respawning"
                );
                if let Some(proc) = map.remove(project) {
                    retired_relay = Some(proc.stop_for_replacement(&format!("oauth[{project}]")));
                }
                if clear_bearer_map {
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
        log::debug!(
            "no oauth-consuming integration enabled for '{project}' — not spawning oauth worker"
        );
        return false;
    }
    let consumer_refs: Vec<&str> = oauth_consumers.iter().map(String::as_str).collect();

    firewall::ensure_firewall_rule();

    let script = match speedwave_runtime::build::resolve_oauth_script() {
        Some(s) => s.to_string_lossy().to_string(),
        None => {
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
            let worker = crate::mirror_relay::RelayedWorker::new(proc);
            let port = worker.port();
            log::info!("oauth worker for '{project}' started (port {port})");
            if let Some(retired) = retired_relay.as_mut() {
                retired.adopt_port(port);
            }
            map.insert(project.to_string(), worker);
            drop(map);
            OAUTH_WATCHDOG_STOP.store(false, Ordering::Relaxed);
            true
        }
        Err(e) => {
            log::error!("oauth worker for '{project}' spawn failed: {e}");
            false
        }
    }
}

fn sweep_per_project_workers<P>(
    workers: &mut std::collections::HashMap<String, P>,
    log_prefix: &str,
) -> Vec<String>
where
    P: WatchdogWorker,
{
    let mut respawned = Vec::new();
    let names: Vec<String> = workers.keys().cloned().collect();
    for name in names {
        let Some(proc) = workers.get_mut(&name) else {
            continue;
        };
        if proc.is_alive() {
            continue;
        }
        log::warn!("{log_prefix} worker for '{name}' unhealthy — respawning");
        match proc.respawn() {
            Ok(new_port) => {
                log::info!("{log_prefix} respawned '{name}' (port {new_port})");
                respawned.push(name);
            }
            Err(e) => {
                log::error!("{log_prefix} respawn for '{name}' failed: {e}");
            }
        }
    }
    respawned
}

pub(crate) trait WatchdogWorker {
    fn is_alive(&self) -> bool;
    fn respawn(&mut self) -> anyhow::Result<u16>;
}

impl<I: mirror_relay::RelayWorkerInner> WatchdogWorker for mirror_relay::RelayedWorker<I> {
    fn is_alive(&self) -> bool {
        mirror_relay::RelayedWorker::is_alive(self)
    }
    fn respawn(&mut self) -> anyhow::Result<u16> {
        mirror_relay::RelayedWorker::respawn(self)
    }
}

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
            let respawned = {
                let mut map = match workers.lock() {
                    Ok(g) => g,
                    Err(e) => {
                        log::error!("{log_prefix} worker map mutex poisoned: {e}");
                        break;
                    }
                };
                sweep_per_project_workers(&mut map, log_prefix)
            };
            for name in respawned {
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

fn start_oauth_watchdog(oauth_arc: SharedOauth) {
    start_per_project_watchdog(oauth_arc, &OAUTH_WATCHDOG_STOP, "oauth watchdog");
}

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

fn log_panic_with_fallback(sanitized: &str, log_fn: impl FnOnce()) {
    if std::panic::catch_unwind(std::panic::AssertUnwindSafe(log_fn)).is_err() {
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
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let sanitized = speedwave_runtime::log_sanitizer::sanitize(&format!("{info}"));
        log_panic_with_fallback(&sanitized, || log::error!("PANIC: {sanitized}"));
        #[cfg(debug_assertions)]
        default_hook(info);
        #[cfg(not(debug_assertions))]
        {
            let _ = &default_hook;
            #[expect(
                clippy::print_stderr,
                reason = "panic-hook stderr fallback (logging.md)"
            )]
            {
                eprintln!("PANIC: {sanitized}");
            }
        }
    }));

    let setup_started = setup_wizard::SetupState::load().runtime_ready;

    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            if let Some(res) = reconcile::resolve_resources_dir(parent) {
                std::env::set_var(speedwave_runtime::consts::BUNDLE_RESOURCES_ENV, &res);
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

    let ide_bridge: SharedIdeBridge = Arc::new(Mutex::new(None));
    let clipboard_bridge_slot: clipboard_bridge::SharedClipboardBridge = Arc::new(Mutex::new(None));
    let plugin_bridges: SharedPluginBridges =
        Arc::new(Mutex::new(std::collections::HashMap::new()));
    let mcp_os: SharedMcpOs = Arc::new(Mutex::new(None));
    let oauth: SharedOauth = Arc::new(Mutex::new(std::collections::HashMap::new()));
    let auto_check_handle: SharedAutoCheckHandle = Arc::new(Mutex::new(None));

    reconcile::set_global_plugin_bridges(plugin_bridges.clone());

    let tray_available = Arc::new(AtomicBool::new(false));
    let tray_available_setup = tray_available.clone();
    let tray_available_close = tray_available.clone();

    let cleanup_ctx = ExitCleanupContext {
        ide_bridge: ide_bridge.clone(),
        plugin_bridges: plugin_bridges.clone(),
        mcp_os: mcp_os.clone(),
        oauth: oauth.clone(),
        auto_check_handle: auto_check_handle.clone(),
    };
    let cleanup_ctx_window = cleanup_ctx.clone();
    let cleanup_ctx_runevent = cleanup_ctx.clone();

    let initial_beta_enabled = config::load_user_config()
        .map(|c| c.beta_enabled())
        .unwrap_or(false);
    let tray_state = tray::TrayMenuState::new(initial_beta_enabled);

    let cleanup_ctx_signal = cleanup_ctx.clone();
    match ctrlc::set_handler(move || {
        if let Some(handle) = reconcile::run_exit_cleanup(&cleanup_ctx_signal) {
            join_with_exit_watchdog(handle);
        }
        std::process::exit(1);
    }) {
        Ok(()) => {}
        Err(e) => {
            log::error!("failed to set signal handler, exiting: {e}");
            std::process::exit(1);
        }
    }

    let exit_cleanup_handle: Arc<Mutex<Option<std::thread::JoinHandle<()>>>> =
        Arc::new(Mutex::new(None));
    let exit_cleanup_handle_window = exit_cleanup_handle.clone();
    let exit_cleanup_handle_runevent = exit_cleanup_handle.clone();

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

    let builder = tauri::Builder::default().plugin(
        tauri::plugin::Builder::<tauri::Wry>::new("navigation-guard")
            .on_navigation(|_webview, url| {
                let allowed = is_own_origin(url);
                if !allowed {
                    log::warn!(
                        "blocked navigation to non-app origin: {}",
                        blocked_navigation_origin(url)
                    );
                }
                allowed
            })
            .build(),
    );

    #[cfg(feature = "e2e")]
    let builder = builder.plugin(tauri_plugin_webdriver::init());

    let app = builder
        .plugin({
            use tauri_plugin_log::{RotationStrategy, Target, TargetKind};
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
                .level_for("whisper_rs", log::LevelFilter::Info)
                .max_file_size(50_000_000)
                .rotation_strategy(RotationStrategy::KeepSome(10))
                .format(move |callback, message, record| {
                    let sanitized =
                        speedwave_runtime::log_sanitizer::sanitize(&format!("{message}"));
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
            log::set_max_level(log::LevelFilter::Trace);
            logging_cmd::init_bundle_identifier(app.config().identifier.clone());
            if let Err(e) = speedwave_runtime::config::migrate_drop_log_level_in(
                speedwave_runtime::consts::data_dir(),
            ) {
                log::warn!("config migration failed: {e:#}");
            }
            if let Err(e) = speedwave_runtime::config::heal_llm_config_on_disk() {
                log::warn!("LLM config heal failed: {e:#}");
            }

            if let Ok(mut slot) = clipboard_bridge_slot.lock() {
                *slot = clipboard_bridge::spawn(app.handle().clone());
            }

            if let Err(failures) = speedwave_runtime::plugin::audit_all() {
                let body = format_audit_failure_message(&failures);
                log::error!("plugin audit failed:\n{}", body);
                show_audit_failure_dialog_and_exit(app.handle(), "Plugin verification failed", body);
            }

            if let Err(e) = speedwave_runtime::config::check_telemetry_policy_at_boot() {
                let body = format!(
                    "Speedwave could not apply the organization telemetry policy.\n\n{e}\n\n\
                     Contact your administrator to correct the managed configuration."
                );
                log::error!("telemetry policy check failed: {}", e);
                show_audit_failure_dialog_and_exit(app.handle(), "Organization policy error", body);
            }

            if let Err(e) = speedwave_runtime::pii_policy::check_pii_policy_at_boot() {
                let body = format!(
                    "Speedwave could not apply the organization PII policy.\n\n{e}\n\n\
                     Contact your administrator to correct the managed configuration."
                );
                log::error!("PII policy check failed: {}", e);
                show_audit_failure_dialog_and_exit(app.handle(), "Organization policy error", body);
            }


            if setup_started {
                let cleaned =
                    speedwave_runtime::legacy_token_cleanup::run_legacy_token_cleanup_at_startup();
                if cleaned > 0 {
                    log::info!("legacy token cleanup sanitised {cleaned} project(s)");
                }

                let _ =
                    speedwave_runtime::oauth_state_migration::run_oauth_state_migration_at_startup();

                init_and_start_ide_bridge(&ide_bridge, app.handle());

                crate::bridges::plugin_bridge_manager::init_and_start(
                    &plugin_bridges,
                    app.handle(),
                );

                let script = speedwave_runtime::build::resolve_mcp_os_script();
                if let Some(script_path) = script {
                    let script_str = script_path.to_string_lossy().to_string();
                    match speedwave_runtime::mcp_os_process::McpOsProcess::spawn(&script_str) {
                        Ok(proc) => {
                            let worker = crate::mirror_relay::RelayedWorker::new(proc);
                            log::info!("mcp-os process started (port {})", worker.port());
                            if let Ok(mut guard) = mcp_os.lock() {
                                *guard = Some(worker);
                            }

                            reconcile::reconcile_compose_port(app.handle());
                        }
                        Err(e) => log::error!("mcp-os spawn error: {e}"),
                    }
                } else {
                    log::warn!("mcp-os script not found — OS integrations will be unavailable");
                }

                start_mcp_os_watchdog(mcp_os.clone(), app.handle().clone());

                OAUTH_WATCHDOG_STOP.store(false, Ordering::Relaxed);
                start_oauth_watchdog(oauth.clone());
            } else {
                log::info!("setup not started, deferring IDE Bridge / mcp-os / oauth / link_cli until setup completes");
            }

            let handle = updater::spawn_auto_check(app.handle().clone());
            match auto_check_handle.lock() {
                Ok(mut guard) => *guard = Some(handle),
                Err(e) => log::warn!("auto-check handle mutex poisoned: {e}"),
            }

            // Post-setup migrations, off the main thread.
            if setup_started {
                let app_handle = app.handle().clone();
                std::thread::spawn(move || {
                    let migrations = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        #[cfg(target_os = "macos")]
                        if let Err(e) = setup_wizard::ensure_lima_vm_config() {
                            log::warn!("Lima VM config migration failed: {e}");
                        }

                        #[cfg(target_os = "windows")]
                        if let Err(e) = setup_wizard::ensure_wslconfig_vpn_compat() {
                            log::warn!(".wslconfig VPN-compat migration failed: {e}");
                        }

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

            use tauri::Manager;
            let tray_menu = tray::build_tray_menu(
                app.handle(),
                None,
                app.state::<tray::TrayMenuState>().beta_enabled(),
                setup_wizard::is_setup_complete(),
            )?;
            let tray_icon = tray::load_tray_icon()?;

            let mut tray_builder = TrayIconBuilder::with_id(tray::TRAY_ID)
                .icon(tray_icon)
                .icon_as_template(true)
                .tooltip(tray::TOOLTIP_IDLE)
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

            {
                use std::sync::atomic::AtomicU64;
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
                    log::error!("failed to create system tray: {e}");
                }
            }

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
            containers_cmd::check_runtime,
            containers_cmd::init_vm,
            containers_cmd::create_project,
            containers_cmd::link_cli,
            containers_cmd::run_system_check,
            containers_cmd::is_setup_complete,
            containers_cmd::build_images,
            containers_cmd::start_containers,
            containers_cmd::retry_bundle_reconcile,
            containers_cmd::defer_container_start,
            containers_cmd::check_containers_running,
            containers_cmd::factory_reset,
            containers_cmd::get_llm_config,
            containers_cmd::get_active_provider_summary,
            containers_cmd::get_default_base_url,
            containers_cmd::get_openrouter_default_model,
            containers_cmd::list_anthropic_models,
            containers_cmd::update_llm_config,
            containers_cmd::set_llm_provider_key,
            containers_cmd::set_provider_model,
            containers_cmd::clear_active_llm_provider,
            containers_cmd::restart_llm_proxy,
            pin_cmd::get_effort_pin,
            pin_cmd::set_effort_pin,
            pin_cmd::get_model_hint,
            pin_cmd::set_model_pin,
            containers_cmd::get_telemetry_config,
            containers_cmd::update_telemetry_config,
            containers_cmd::probe_otlp_endpoint,
            containers_cmd::get_security_policy,
            containers_cmd::list_security_policy_templates,
            containers_cmd::list_pii_rules,
            containers_cmd::update_security_policy,
            llm_cmd::discover_llm_models,
            llm_cmd::get_llm_usage,
            llm_cmd::get_usage_for_response,
            llm_cmd::get_session_cost,
            llm_cmd::get_conversation_cost,
            auth_commands::save_api_key,
            auth_commands::delete_api_key,
            auth_commands::get_auth_status,
            auth_commands::anthropic_logout,
            oauth_login_cmd::start_oauth_login,
            url_validation::open_url,
            url_validation::get_platform,
            auth_commands::get_auth_command,
            chat_session_cmd::start_chat,
            chat_session_cmd::send_message,
            paste_cmd::save_pasted_image,
            chat_session_cmd::submit_question_answer,
            chat_session_cmd::stop_chat,
            retry_cmd::retry_last_turn,
            queue_cmd::queue_message,
            queue_cmd::cancel_queued_message,
            transcription_cmd::transcription_capabilities,
            transcription_cmd::list_audio_sources,
            transcription_cmd::start_transcription,
            transcription_cmd::stop_transcription,
            transcription_cmd::resume_transcription,
            transcription_cmd::subscribe_transcript,
            transcription_cmd::list_transcripts,
            transcription_cmd::get_transcript,
            transcription_cmd::delete_transcript,
            transcription_cmd::get_transcript_markdown,
            transcription_cmd::recommended_transcription_model,
            transcription_cmd::list_transcription_models,
            transcription_cmd::download_transcription_model,
            transcription_cmd::delete_transcription_model,
            history_cmd::list_conversations,
            history_cmd::get_conversation,
            history_cmd::delete_conversation,
            history_cmd::get_project_memory,
            chat_session_cmd::resume_conversation,
            project_cmd::list_projects,
            project_cmd::switch_project,
            containers_cmd::add_project,
            containers_cmd::remove_project,
            health_cmd::get_health,
            container_logs_cmd::get_all_logs,
            ide_bridge_cmd::list_available_ides,
            ide_bridge_cmd::select_ide,
            ide_bridge_cmd::disconnect_ide,
            ide_bridge_cmd::get_selected_ide,
            plugin_bridge_get_credentials,
            plugin_bridge_get_status,
            update_commands::check_for_update,
            update_commands::install_update_and_reconcile,
            update_commands::get_update_settings,
            update_commands::set_update_settings,
            update_commands::get_bundle_reconcile_state,
            ui_prefs_cmd::get_beta_enabled,
            export_diagnostics,
            integrations_cmd::get_integrations,
            integrations_cmd::set_integration_enabled,
            integrations_cmd::set_os_integration_enabled,
            integrations_cmd::validate_os_integrations_on_startup,
            integrations_cmd::save_integration_credentials,
            integrations_cmd::save_redmine_mappings,
            integrations_cmd::delete_integration_credentials,
            integrations_cmd::restart_integration_containers,
            containers_cmd::recreate_project_containers,
            oauth_cmd::start_sharepoint_oauth,
            oauth_cmd::cancel_sharepoint_oauth,
            github_oauth_cmd::start_github_oauth,
            github_oauth_cmd::cancel_github_oauth,
            plugin_oauth_cmd::start_plugin_oauth,
            plugin_oauth_cmd::cancel_plugin_oauth,
            slack_oauth_cmd::start_slack_oauth,
            slack_oauth_cmd::cancel_slack_oauth,
            plugin_oauth_cmd::forget_plugin_oauth,
            redmine_api_cmd::validate_redmine_credentials,
            redmine_api_cmd::fetch_redmine_enumerations,
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
            slash_cmd::list_slash_commands,
            slash_cmd::invalidate_slash_cache,
            git_cmd::get_git_branch,
            system_settings_cmd::open_files_folders_pane,
            cloudstorage_cmd::detect_cloudstorage_path,
            mic_permission_cmd::request_microphone_permission,
            mic_permission_cmd::microphone_permission_status,
            system_settings_cmd::open_microphone_pane,
            system_settings_cmd::open_audio_capture_pane,
            #[cfg(feature = "e2e")]
            e2e_support::e2e_last_spawn_args,
            #[cfg(feature = "e2e")]
            e2e_support::e2e_restart_app,
        ])
        .on_window_event(move |window, event| {
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    if should_prevent_close(
                        window.label(),
                        tray_available_close.load(Ordering::Relaxed),
                    ) {
                        api.prevent_close();
                        hide_main_window(window.app_handle());
                    }
                }
                tauri::WindowEvent::Destroyed => {
                    if !should_run_cleanup(window.label()) {
                        return;
                    }
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
        tauri::RunEvent::ExitRequested { .. } => {
            hide_main_window(app_handle);
            if let Some(handle) = reconcile::run_exit_cleanup(&cleanup_ctx_runevent) {
                stash_cleanup_handle(&exit_cleanup_handle_runevent, handle);
            }
        }
        tauri::RunEvent::Exit => {
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

#[cfg(test)]
#[expect(clippy::unwrap_used, reason = "test-only assertions")]
mod tests {
    use super::*;

    fn v(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn is_own_origin_allows_app_and_dev_origins() {
        for u in [
            "tauri://localhost/index.html",
            "http://tauri.localhost/",
            "http://localhost:4270/",
            "https://localhost/",
        ] {
            assert!(
                is_own_origin(&url::Url::parse(u).unwrap()),
                "must allow own origin: {u}"
            );
        }
    }

    #[test]
    fn is_own_origin_blocks_foreign_and_dangerous_schemes() {
        for u in [
            "https://evil.example.com/phish",
            "http://169.254.169.254/",
            "data:text/html,<h1>hi</h1>",
            "file:///etc/passwd",
        ] {
            assert!(
                !is_own_origin(&url::Url::parse(u).unwrap()),
                "must block non-app navigation: {u}"
            );
        }
    }

    #[test]
    fn blocked_navigation_origin_carries_scheme_and_host_only() {
        let url = url::Url::parse("https://evil.example.com/phish?token=secret#frag").unwrap();
        assert_eq!(blocked_navigation_origin(&url), "https://evil.example.com");
        let no_host = url::Url::parse("data:text/html,<h1>hi</h1>").unwrap();
        assert_eq!(blocked_navigation_origin(&no_host), "data://<no-host>");
        let file = url::Url::parse("file:///etc/passwd").unwrap();
        let logged = blocked_navigation_origin(&file);
        assert!(
            logged.starts_with("file://"),
            "scheme must be logged: {logged}"
        );
        assert!(
            !logged.contains("passwd"),
            "the path must never reach the log: {logged}"
        );
    }

    #[test]
    fn log_panic_with_fallback_runs_log_fn_when_it_succeeds() {
        let ran = std::cell::Cell::new(false);
        log_panic_with_fallback("msg", || ran.set(true));
        assert!(ran.get(), "log_fn must run on the happy path");
    }

    #[test]
    fn log_panic_with_fallback_survives_a_panicking_log_fn() {
        log_panic_with_fallback("msg", || panic!("simulated log sink panic"));
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
        assert!(msg.contains("acme-tools: SIGNATURE file not present"));
        assert!(msg.contains("widget: Ed25519 verification failed"));
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

    struct FakeWorker {
        alive: bool,
        respawn_result: Result<u16, String>,
        respawn_calls: std::cell::Cell<u32>,
    }
    impl FakeWorker {
        fn new(alive: bool, respawn_result: Result<u16, String>) -> Self {
            Self {
                alive,
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
            match &self.respawn_result {
                Ok(p) => {
                    self.alive = true;
                    Ok(*p)
                }
                Err(e) => Err(anyhow::anyhow!(e.clone())),
            }
        }
    }

    #[test]
    fn sweep_per_project_workers_empty_map_returns_empty() {
        let mut map: std::collections::HashMap<String, FakeWorker> = Default::default();
        assert!(sweep_per_project_workers(&mut map, "test").is_empty());
    }

    #[test]
    fn sweep_per_project_workers_skips_alive_workers() {
        let mut map = std::collections::HashMap::new();
        map.insert("p".to_string(), FakeWorker::new(true, Ok(9999)));
        let respawned = sweep_per_project_workers(&mut map, "test");
        assert!(respawned.is_empty(), "alive worker must not be respawned");
        assert_eq!(map["p"].respawn_calls.get(), 0);
    }

    #[test]
    fn sweep_per_project_workers_collects_all_unhealthy_in_one_pass() {
        let mut map = std::collections::HashMap::new();
        map.insert("a".to_string(), FakeWorker::new(false, Ok(1111)));
        map.insert("b".to_string(), FakeWorker::new(false, Ok(2222)));
        let mut names = sweep_per_project_workers(&mut map, "test");
        names.sort();
        assert_eq!(names, vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn sweep_per_project_workers_failed_respawn_excluded_from_respawned() {
        let mut map = std::collections::HashMap::new();
        map.insert(
            "bad".to_string(),
            FakeWorker::new(false, Err("spawn failed".into())),
        );
        map.insert("good".to_string(), FakeWorker::new(false, Ok(3333)));
        let respawned = sweep_per_project_workers(&mut map, "test");
        assert_eq!(respawned, vec!["good".to_string()]);
        assert_eq!(map["bad"].respawn_calls.get(), 1);
    }

    #[test]
    fn sweep_per_project_workers_mixed_alive_and_dead() {
        let mut map = std::collections::HashMap::new();
        map.insert("alive".to_string(), FakeWorker::new(true, Ok(0)));
        map.insert("dead".to_string(), FakeWorker::new(false, Ok(4444)));
        let respawned = sweep_per_project_workers(&mut map, "test");
        assert_eq!(respawned, vec!["dead".to_string()]);
        assert_eq!(map["alive"].respawn_calls.get(), 0);
        assert_eq!(map["dead"].respawn_calls.get(), 1);
    }

    #[test]
    fn mcp_os_health_outcome_transitions() {
        use super::{mcp_os_health_outcome, HealthOutcome};
        assert_eq!(mcp_os_health_outcome(true, 3, 5), (HealthOutcome::Alive, 0));
        assert_eq!(
            mcp_os_health_outcome(false, 0, 5),
            (HealthOutcome::ShouldRespawn, 1)
        );
        assert_eq!(
            mcp_os_health_outcome(false, 3, 5),
            (HealthOutcome::ShouldRespawn, 4)
        );
        assert_eq!(
            mcp_os_health_outcome(false, 4, 5),
            (HealthOutcome::Cooldown, 0)
        );
    }

    #[test]
    fn both_exit_paths_use_join_with_exit_watchdog() {
        let source = include_str!("main.rs");
        let occurrences: Vec<_> = source.match_indices("join_with_exit_watchdog").collect();
        let non_test_count = occurrences
            .iter()
            .filter(|(idx, _)| {
                let before = &source[..*idx];
                let last_mod_tests = before.rfind("mod tests");
                let last_cfg_test = before.rfind("#[cfg(test)]");
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

    #[test]
    fn exit_arm_runs_cleanup_when_handle_slot_is_empty() {
        let source = include_str!("main.rs");
        let arm_start = source
            .find("tauri::RunEvent::Exit =>")
            .expect("Exit arm must exist");
        let after_arm = &source[arm_start..];
        let arm_end = after_arm
            .find("\n        _ => {}")
            .expect("catch-all arm must exist after RunEvent::Exit");
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

    #[test]
    fn stash_cleanup_handle_stores_into_empty_slot() {
        let slot: Arc<Mutex<Option<std::thread::JoinHandle<()>>>> = Arc::new(Mutex::new(None));
        let handle = std::thread::spawn(|| {});
        stash_cleanup_handle(&slot, handle);

        let stashed = slot.lock().unwrap().take();
        assert!(
            stashed.is_some(),
            "first handle must be stashed into empty slot"
        );
        stashed.unwrap().join().expect("test thread must not panic");
    }

    #[test]
    fn csp_img_src_allows_blob_and_data_for_paste_preview() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))
            .expect("tauri.conf.json parses");
        let csp = conf["app"]["security"]["csp"]
            .as_str()
            .expect("app.security.csp is a string");

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

    #[test]
    fn main_window_disables_native_drag_drop_for_html5_composer_dnd() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))
            .expect("tauri.conf.json parses");
        let windows = conf["app"]["windows"]
            .as_array()
            .expect("app.windows is an array");
        let main_window = windows
            .first()
            .expect("app.windows must define the main window");

        let drag_drop_enabled = main_window["dragDropEnabled"]
            .as_bool()
            .expect("main window must set dragDropEnabled explicitly");
        assert!(
            !drag_drop_enabled,
            "dragDropEnabled must be false: Tauri's default native drag-drop \
             handler swallows the drop before it reaches the webview, so \
             composer.component.ts's HTML5 drag & drop (file-drop.directive.ts) \
             never fires (SPEED-636)"
        );
    }
}
