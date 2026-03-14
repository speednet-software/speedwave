// Speedwave Desktop — Tauri v2 backend
//
// Thin #[tauri::command] wrappers that delegate to the existing module functions.
// Each command converts anyhow::Result into Result<T, String> (Tauri requires
// serializable errors).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#![allow(missing_docs)]

mod auth;
mod auth_commands;
mod chat;
mod container_logs_cmd;
mod containers_cmd;
mod diagnostics;
mod fs_perms;
mod health;
mod history;
mod ide_bridge;
mod integrations_cmd;
mod logging_cmd;
mod mcp_os_process;
mod reconcile;
mod setup_wizard;
mod tray;
mod types;
mod update_commands;
mod updater;
mod url_validation;
mod window;

use types::{check_project, ProjectEntry, ProjectList};

use chat::{ChatSession, SharedChatSession};
use health::HealthMonitor;
use speedwave_runtime::config;

use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::tray::TrayIconBuilder;
use tauri::Manager;

use reconcile::{SharedAutoCheckHandle, SharedIdeBridge};

/// Tracks the latest available update version for the system tray menu.
type SharedUpdateVersion = Arc<Mutex<Option<String>>>;

const MAIN_WINDOW_LABEL: &str = "main";

/// Global mutex protecting all read-modify-write cycles on config.json.
/// Without this, concurrent Tauri commands (e.g. toggling mail then notes in quick
/// succession) can lose writes due to TOCTOU races.
static CONFIG_LOCK: std::sync::LazyLock<Mutex<()>> = std::sync::LazyLock::new(|| Mutex::new(()));

/// Stop flag for the mcp-os watchdog thread. Set during app exit cleanup
/// to prevent the watchdog from respawning mcp-os during shutdown.
static WATCHDOG_STOP: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

// ---------------------------------------------------------------------------
// Chat commands
// ---------------------------------------------------------------------------

#[tauri::command]
fn start_chat(
    project: String,
    app_handle: tauri::AppHandle,
    state: tauri::State<SharedChatSession>,
) -> Result<(), String> {
    check_project(&project)?;
    let mut session = state.lock().map_err(|e| format!("Lock poisoned: {e}"))?;
    // Stop any existing session before starting a new one
    session.stop().map_err(|e| e.to_string())?;
    // Replace with a fresh session for the requested project
    *session = ChatSession::new(&project);
    session.start(app_handle, None).map_err(|e| e.to_string())
}

#[tauri::command]
fn send_message(message: String, state: tauri::State<SharedChatSession>) -> Result<(), String> {
    if message.len() > 1_000_000 {
        return Err("Message too long".to_string());
    }
    let mut session = state.lock().map_err(|e| format!("Lock poisoned: {e}"))?;
    session.send_message(&message).map_err(|e| e.to_string())
}

#[tauri::command]
fn answer_question(
    tool_use_id: String,
    answer: String,
    state: tauri::State<SharedChatSession>,
) -> Result<(), String> {
    if answer.len() > 1_000_000 {
        return Err("Answer too long".to_string());
    }
    let mut session = state.lock().map_err(|e| format!("Lock poisoned: {e}"))?;
    session
        .answer_question(&tool_use_id, &answer)
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Chat history commands
// ---------------------------------------------------------------------------

#[tauri::command]
async fn list_conversations(project: String) -> Result<Vec<history::ConversationSummary>, String> {
    tokio::task::spawn_blocking(move || {
        check_project(&project)?;
        log::info!("list_conversations: project={project}");
        history::list_conversations(&project).map_err(|e| {
            log::error!("list_conversations: error: {e}");
            e.to_string()
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn get_conversation(
    project: String,
    session_id: String,
) -> Result<history::ConversationTranscript, String> {
    tokio::task::spawn_blocking(move || {
        check_project(&project)?;
        log::info!("get_conversation: project={project}");
        history::get_conversation(&project, &session_id).map_err(|e| {
            log::error!("get_conversation: error: {e}");
            e.to_string()
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn get_project_memory(project: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        check_project(&project)?;
        log::info!("get_project_memory: project={project}");
        history::get_project_memory(&project).map_err(|e| {
            log::error!("get_project_memory: error: {e}");
            e.to_string()
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn resume_conversation(
    project: String,
    session_id: String,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, SharedChatSession>,
) -> Result<(), String> {
    check_project(&project)?;
    history::validate_session_id(&session_id).map_err(|e| e.to_string())?;
    log::info!("resume_conversation: project={project}");
    let session_arc = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        let mut session = session_arc
            .lock()
            .map_err(|e| format!("Lock poisoned: {e}"))?;
        session.stop().map_err(|e| e.to_string())?;
        *session = ChatSession::new(&project);
        session.start(app_handle, Some(&session_id)).map_err(|e| {
            log::error!("resume_conversation failed: {e}");
            e.to_string()
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// Project management commands
// ---------------------------------------------------------------------------

#[tauri::command]
fn list_projects() -> Result<ProjectList, String> {
    let user_config = config::load_user_config().map_err(|e| e.to_string())?;
    let projects = user_config
        .projects
        .iter()
        .map(|p| ProjectEntry {
            name: p.name.clone(),
            dir: p.dir.clone(),
        })
        .collect();
    Ok(ProjectList {
        projects,
        active_project: user_config.active_project,
    })
}

#[tauri::command]
fn switch_project(name: String, app: tauri::AppHandle) -> Result<(), String> {
    let _lock = CONFIG_LOCK.lock().map_err(|e| e.to_string())?;
    let mut user_config = config::load_user_config().map_err(|e| e.to_string())?;

    // Verify project exists
    if user_config.find_project(&name).is_none() {
        return Err(format!("Project '{}' not found", name));
    }

    user_config.active_project = Some(name.clone());

    config::save_user_config(&user_config).map_err(|e| e.to_string())?;

    use tauri::Emitter;
    let _ = app.emit("project_switched", &name);

    Ok(())
}

// ---------------------------------------------------------------------------
// Health check command
// ---------------------------------------------------------------------------

#[tauri::command]
async fn get_health(project: String) -> Result<health::HealthReport, String> {
    tokio::task::spawn_blocking(move || {
        check_project(&project)?;
        let user_config = match config::load_user_config() {
            Ok(c) => c,
            Err(e) => {
                log::warn!("Health check: failed to load config, using defaults: {e}");
                config::SpeedwaveUserConfig::default()
            }
        };
        let project_dir = user_config
            .find_project(&project)
            .map(|p| std::path::PathBuf::from(&p.dir));
        let any_os_enabled = if cfg!(target_os = "macos") {
            project_dir
                .map(|dir| {
                    let resolved = config::resolve_integrations(&dir, &user_config, &project);
                    resolved.any_os_enabled()
                })
                .unwrap_or(false)
        } else {
            false
        };
        Ok(HealthMonitor::check_all(&project, any_os_enabled))
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// IDE Bridge commands
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct BridgeStatus {
    port: u16,
    upstream_ide: Option<String>,
    upstream_port: Option<u16>,
}

/// Checks whether the IDE process behind `~/.claude/ide/<port>.lock` is still alive.
///
/// Verifies both PID liveness and TCP port reachability (50 ms timeout).
/// PID alone is insufficient because Cursor/VS Code may restart on a new port
/// while keeping the same main-process PID, leaving a stale lock file.
fn is_upstream_alive(port: u16) -> bool {
    let lock_path = match dirs::home_dir() {
        Some(h) => h.join(".claude").join("ide").join(format!("{}.lock", port)),
        None => return false,
    };
    health::is_ide_lock_alive(&lock_path)
}

/// Clears the dead IDE selection from both the live bridge and persisted config.
///
/// Called when the upstream IDE is detected as dead (PID gone or port not
/// listening). Separated from the query command so that `get_bridge_status`
/// does not have write side-effects.
fn cleanup_dead_ide(bridge: &ide_bridge::IdeBridge) {
    bridge.clear_upstream();
    if let Ok(_lock) = CONFIG_LOCK.lock() {
        match config::load_user_config() {
            Ok(mut user_config) => {
                user_config.selected_ide = None;
                if let Err(e) = config::save_user_config(&user_config) {
                    log::warn!("cleanup_dead_ide: failed to persist IDE deselection: {e}");
                }
            }
            Err(e) => {
                log::warn!("cleanup_dead_ide: failed to load user config: {e}");
            }
        }
    }
}

/// Returns the current IDE Bridge status for the Angular frontend.
///
/// When the upstream IDE is detected as dead (PID gone or port not listening),
/// delegates to `cleanup_dead_ide()` to clear the stale selection. This fires
/// only once per IDE death — subsequent polls see `upstream_info() -> None`.
#[tauri::command]
fn get_bridge_status(state: tauri::State<SharedIdeBridge>) -> Result<Option<BridgeStatus>, String> {
    let guard = state
        .lock()
        .map_err(|e| format!("Bridge mutex poisoned: {e}"))?;
    match guard.as_ref() {
        Some(bridge) => {
            let (upstream_ide, upstream_port) = match bridge.upstream_info() {
                Some((name, port)) => {
                    if is_upstream_alive(port) {
                        (Some(name), Some(port))
                    } else {
                        cleanup_dead_ide(bridge);
                        (None, None)
                    }
                }
                None => (None, None),
            };
            Ok(Some(BridgeStatus {
                port: bridge.port(),
                upstream_ide,
                upstream_port,
            }))
        }
        None => Ok(None),
    }
}

#[tauri::command]
fn list_available_ides() -> Result<Vec<health::DetectedIde>, String> {
    Ok(health::list_available_ides())
}

#[tauri::command]
fn select_ide(
    ide_name: String,
    port: u16,
    state: tauri::State<SharedIdeBridge>,
) -> Result<(), String> {
    // Validate that the port belongs to a currently detected IDE
    if !health::list_available_ides()
        .iter()
        .any(|i| i.port == Some(port))
    {
        return Err(format!(
            "IDE on port {} is not in the detected IDEs list",
            port
        ));
    }

    // Persist the selection to config.json
    {
        let _lock = CONFIG_LOCK.lock().map_err(|e| e.to_string())?;
        let mut user_config = config::load_user_config().map_err(|e| e.to_string())?;
        user_config.selected_ide = Some(speedwave_runtime::config::SelectedIde {
            ide_name: ide_name.clone(),
            port,
        });
        config::save_user_config(&user_config).map_err(|e| e.to_string())?;
    }

    // Update the live Bridge so new connections are proxied immediately
    let guard = state
        .lock()
        .map_err(|e| format!("Bridge mutex poisoned: {e}"))?;
    if let Some(bridge) = guard.as_ref() {
        bridge
            .set_upstream(ide_name, port)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn get_selected_ide() -> Result<Option<speedwave_runtime::config::SelectedIde>, String> {
    let user_config = config::load_user_config().map_err(|e| e.to_string())?;
    Ok(user_config.selected_ide)
}

use diagnostics::export_diagnostics;
use logging_cmd::{cleanup_old_logs, get_log_level, parse_log_level, set_log_level};
#[cfg(not(target_os = "linux"))]
use window::should_debounce;
use window::{hide_main_window, should_prevent_close, should_run_cleanup, show_main_window};

// ---------------------------------------------------------------------------
// Application entry point
// ---------------------------------------------------------------------------

fn main() {
    // Panic hook — sanitize panic payload before logging
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let sanitized = speedwave_runtime::log_sanitizer::sanitize(&format!("{info}"));
        log::error!("PANIC: {sanitized}");
        #[cfg(debug_assertions)]
        default_hook(info);
        #[cfg(not(debug_assertions))]
        {
            let _ = &default_hook; // suppress unused warning
            #[allow(clippy::print_stderr)]
            {
                eprintln!("PANIC: {sanitized}");
            }
        }
    }));

    // Bundled binary resolution for app bundles.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            if let Some(res) = reconcile::resolve_resources_dir(parent) {
                std::env::set_var(speedwave_runtime::consts::BUNDLE_RESOURCES_ENV, &res);
                if let Err(e) = speedwave_runtime::build::write_resources_marker(&res) {
                    log::warn!("could not write resources-dir marker: {e}");
                }
            }
        }
    }

    let initial_session: SharedChatSession = Arc::new(Mutex::new(ChatSession::new("default")));

    // Shared state for IDE Bridge, mcp-os process, auto-check handle, and tray update version
    let ide_bridge: SharedIdeBridge = Arc::new(Mutex::new(None));
    let mcp_os: Arc<Mutex<Option<mcp_os_process::McpOsProcess>>> = Arc::new(Mutex::new(None));
    let auto_check_handle: SharedAutoCheckHandle = Arc::new(Mutex::new(None));
    let update_version: SharedUpdateVersion = Arc::new(Mutex::new(None));

    let tray_available = Arc::new(AtomicBool::new(false));
    #[cfg_attr(target_os = "linux", allow(unused_variables))]
    let tray_available_setup = tray_available.clone();
    let tray_available_close = tray_available.clone();

    let ide_bridge_exit = ide_bridge.clone();
    let mcp_os_exit = mcp_os.clone();
    let auto_check_exit = auto_check_handle.clone();
    let update_version_setup = update_version.clone();

    #[allow(unused_mut)] // mut needed when "e2e" feature is enabled
    let mut builder = tauri::Builder::default();

    // WebDriver server for E2E tests — only present when the "e2e" feature is
    // enabled. The plugin embeds a W3C WebDriver server on 127.0.0.1:4445 so
    // E2E specs can drive the real app via WebdriverIO.
    // Production releases are built without the feature — the crate is not
    // compiled or linked, so zero attack surface.
    #[cfg(feature = "e2e")]
    {
        builder = builder.plugin(tauri_plugin_webdriver::init());
    }

    #[allow(clippy::expect_used)]
    builder
        .plugin({
            use tauri_plugin_log::{RotationStrategy, Target, TargetKind, TimezoneStrategy};
            tauri_plugin_log::Builder::new()
                .timezone_strategy(TimezoneStrategy::UseLocal)
                .targets([
                    Target::new(TargetKind::Stdout),
                    Target::new(TargetKind::LogDir {
                        file_name: Some("speedwave-desktop".into()),
                    }),
                    Target::new(TargetKind::Webview),
                ])
                .level(log::LevelFilter::Trace)
                .level_for("hyper", log::LevelFilter::Warn)
                .level_for("tungstenite", log::LevelFilter::Warn)
                .level_for("tokio_tungstenite", log::LevelFilter::Warn)
                .level_for("reqwest", log::LevelFilter::Warn)
                .max_file_size(50_000_000)
                .rotation_strategy(RotationStrategy::KeepAll)
                .format(move |callback, message, record| {
                    let sanitized =
                        speedwave_runtime::log_sanitizer::sanitize(&format!("{message}"));
                    callback.finish(format_args!(
                        "[{level}][{target}] {sanitized}",
                        level = record.level(),
                        target = record.target(),
                    ))
                })
                .build()
        })
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
        .setup(move |app| {
            // Restore persisted log level (default: Info)
            let initial_level = config::load_user_config()
                .ok()
                .and_then(|c| c.log_level)
                .and_then(|l| parse_log_level(&l))
                .unwrap_or(log::LevelFilter::Info);
            log::set_max_level(initial_level);

            // Clean up old rotated log files (max 10 kept)
            cleanup_old_logs(10);

            // Periodic cleanup every hour for long-running sessions
            tauri::async_runtime::spawn(async {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
                    cleanup_old_logs(10);
                }
            });

            // Start IDE Bridge
            match ide_bridge::IdeBridge::new() {
                Ok(mut bridge) => {
                    // Wire event callback to emit Tauri events to the Angular frontend
                    let app_handle = app.handle().clone();
                    bridge.set_event_callback(std::sync::Arc::new(move |kind, detail| {
                        use tauri::Emitter;
                        if let Err(e) = app_handle.emit(
                            "ide_bridge_event",
                            serde_json::json!({ "kind": kind, "detail": detail }),
                        ) {
                            log::error!("failed to emit ide_bridge_event: {e}");
                        }
                    }));

                    if let Err(e) = bridge.start() {
                        log::error!("IDE Bridge start error: {e}");
                    } else {
                        log::info!("IDE Bridge started");
                        // Restore upstream IDE selection from persisted config
                        if let Ok(cfg) = config::load_user_config() {
                            if let Some(sel) = cfg.selected_ide {
                                match bridge.set_upstream(sel.ide_name.clone(), sel.port) {
                                    Ok(()) => log::info!(
                                        "IDE Bridge: restored upstream {} :{}",
                                        sel.ide_name,
                                        sel.port
                                    ),
                                    Err(e) => {
                                        log::warn!("IDE Bridge: failed to restore upstream: {e}")
                                    }
                                }
                            }
                        }
                    }
                    if let Ok(mut guard) = ide_bridge.lock() {
                        *guard = Some(bridge);
                    }
                }
                Err(e) => log::error!("IDE Bridge init error: {e}"),
            }

            // Start mcp-os process
            let script = speedwave_runtime::build::resolve_mcp_os_script();

            if let Some(script_path) = script {
                let script_str = script_path.to_string_lossy().to_string();
                match mcp_os_process::McpOsProcess::spawn(&script_str) {
                    Ok(proc) => {
                        let new_port = proc.port();
                        log::info!("mcp-os process started (port {new_port})");
                        if let Ok(mut guard) = mcp_os.lock() {
                            *guard = Some(proc);
                        }

                        // If containers are already running, regenerate compose with the
                        // new mcp-os port and recreate them. Without this, the hub would
                        // keep connecting to the old (dead) port from the previous session.
                        reconcile::reconcile_compose_port(app.handle());
                    }
                    Err(e) => log::error!("mcp-os spawn error: {e}"),
                }
            } else {
                log::warn!("mcp-os script not found — OS integrations will be unavailable");
            }

            // Start mcp-os watchdog thread
            let mcp_os_watchdog = mcp_os.clone();
            let watchdog_handle = app.handle().clone();
            std::thread::spawn(move || {
                use std::time::Duration;
                const CHECK_INTERVAL: Duration = Duration::from_secs(30);
                const MAX_UNHEALTHY: u32 = 5;
                const COOLDOWN: Duration = Duration::from_secs(300);
                let mut consecutive_unhealthy: u32 = 0;

                loop {
                    std::thread::sleep(CHECK_INTERVAL);
                    if WATCHDOG_STOP.load(Ordering::Relaxed) {
                        break;
                    }

                    match mcp_os_watchdog.lock() {
                        Ok(mut guard) => match *guard {
                            None => break, // mcp-os was never started — watchdog not needed
                            Some(ref mut proc) => {
                                if proc.is_alive() {
                                    consecutive_unhealthy = 0;
                                    continue;
                                }

                                consecutive_unhealthy += 1;

                                if consecutive_unhealthy >= MAX_UNHEALTHY {
                                    log::error!(
                                        "mcp-os watchdog: unhealthy for {MAX_UNHEALTHY} consecutive checks, cooling down"
                                    );
                                    std::thread::sleep(COOLDOWN);
                                    consecutive_unhealthy = 0;
                                    continue;
                                }

                                log::warn!(
                                    "mcp-os watchdog: process unhealthy ({consecutive_unhealthy}/{MAX_UNHEALTHY}), respawning"
                                );
                                match proc.respawn() {
                                    Ok(port) => {
                                        log::info!(
                                            "mcp-os watchdog: respawned (port {port})"
                                        );
                                        reconcile::reconcile_compose_port(&watchdog_handle);
                                    }
                                    Err(e) => {
                                        log::error!(
                                            "mcp-os watchdog: respawn failed: {e}"
                                        );
                                    }
                                }
                            }
                        },
                        Err(e) => {
                            log::error!("mcp-os watchdog: mutex poisoned: {e}");
                            break;
                        }
                    }
                }
                log::info!("mcp-os watchdog: stopped");
            });

            // Start background auto-update check (store handle for cancellation)
            let handle = updater::spawn_auto_check(app.handle().clone());
            match auto_check_handle.lock() {
                Ok(mut guard) => *guard = Some(handle),
                Err(e) => log::warn!("auto-check handle mutex poisoned: {e}"),
            }

            // Re-link CLI binary on every startup to keep it in sync after updates.
            // Runs unconditionally — users may need the CLI for OAuth authentication
            // before completing the setup wizard.
            if let Err(e) = setup_wizard::link_cli() {
                log::warn!("CLI re-link on startup failed: {e}");
            }

            // Linux safety net: show the window immediately on startup.
            // Tray icon support on Linux depends on libappindicator/libayatana
            // and may be invisible even when tray_builder.build() succeeds
            // (e.g. GNOME without AppIndicator extension). Showing the window
            // ensures the user is never left with an invisible app. Close always
            // exits on Linux — tray_available is never set (see below).
            #[cfg(target_os = "linux")]
            show_main_window(app.handle());

            // Build system tray. If creation fails, fall back to visible
            // window (see Linux safety net above).
            let tray_menu = tray::build_tray_menu(app.handle(), &None)?;
            let update_version_tray = update_version_setup.clone();
            let tray_icon = app
                .default_window_icon()
                .cloned()
                .ok_or("No default window icon")?;

            #[cfg_attr(target_os = "linux", allow(unused_mut))]
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
                                Ok(Some(info)) => {
                                    log::info!("tray: update available: {}", info.version);
                                    use tauri::Emitter;
                                    if let Err(e) = app_clone.emit("update_available", &info) {
                                        log::error!(
                                            "tray: failed to emit update_available event: {e}"
                                        );
                                    }
                                }
                                Ok(None) => {
                                    log::info!("tray: already up to date");
                                }
                                Err(e) => {
                                    log::error!("tray: check failed: {e}");
                                }
                            }
                        });
                    }
                    "install_update" => {
                        let app_clone = app.clone();
                        let uv = update_version_tray.clone();
                        tauri::async_runtime::spawn(async move {
                            let version = uv.lock().ok().and_then(|g| g.clone());
                            if let Some(expected) = version {
                                match updater::install_update(&app_clone, expected).await {
                                    Ok(()) => {
                                        log::info!("tray: update installed, restarting");
                                        app_clone.restart();
                                    }
                                    Err(e) => {
                                        log::error!("tray: install failed: {e}");
                                    }
                                }
                            } else {
                                log::warn!("tray: install_update clicked but no version available");
                            }
                        });
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    other => {
                        log::warn!("tray: unhandled menu event: {other}");
                    }
                });

            // macOS/Windows: left-click on tray icon toggles window visibility.
            // Linux: TrayIconEvent::Click is unsupported — users rely on the
            // right-click menu "Open Speedwave" instead.
            #[cfg(not(target_os = "linux"))]
            {
                use std::sync::atomic::AtomicU64;
                // Debounce: ignore clicks within 500ms of the previous one
                // to prevent double-toggle from rapid clicks. 500ms equals the
                // Windows default double-click interval, though users with
                // accessibility settings may have a longer interval (up to 900ms).
                // On Windows a double-click fires two Click::Up events.
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
                                        "tray: system clock error (before Unix epoch?): {e}"
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
                                        log::error!("tray: failed to check window visibility: {e}");
                                        false
                                    }
                                },
                                None => {
                                    log::warn!("tray: main window not found for visibility check");
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
                    log::info!("tray: system tray created");
                    // Linux: do not set tray_available — build() can return Ok
                    // even when the icon is invisible (GNOME without AppIndicator
                    // extension). Closing the window must always exit on Linux to
                    // prevent a stuck invisible app. The tray menu (Open/Quit)
                    // still works when the icon is visible.
                    #[cfg(not(target_os = "linux"))]
                    tray_available_setup.store(true, Ordering::Relaxed);

                    // macOS: switch to Accessory activation policy so the app
                    // does not appear in the Dock or Cmd+Tab. The window starts
                    // hidden (tauri.conf.json: visible=false) and is shown on
                    // tray click. Only after tray succeeds — if tray fails,
                    // Dock stays visible.
                    #[cfg(target_os = "macos")]
                    if let Err(e) = app
                        .handle()
                        .set_activation_policy(tauri::ActivationPolicy::Accessory)
                    {
                        log::error!(
                            "tray: failed to set initial activation policy to Accessory: {e}"
                        );
                    }
                }
                Err(e) => {
                    // Tray creation failed. On Linux the safety net above already
                    // showed the window; on other platforms, show it now as fallback.
                    log::error!("tray: failed to create system tray: {e}");
                    log::warn!("tray: falling back to visible window");
                    #[cfg(not(target_os = "linux"))]
                    show_main_window(app.handle());
                }
            }

            // Listen for update_available events (from auto-check) to update tray menu
            let update_version_listener = update_version_setup.clone();
            let app_handle_listener = app.handle().clone();
            use tauri::Listener;
            app.listen(
                "update_available",
                move |event| match serde_json::from_str::<updater::UpdateInfo>(event.payload()) {
                    Ok(info) => {
                        let version = info.version;
                        match update_version_listener.lock() {
                            Ok(mut guard) => *guard = Some(version.clone()),
                            Err(e) => log::warn!("update version mutex poisoned: {e}"),
                        }
                        tray::refresh_tray_menu(&app_handle_listener, &Some(version));
                    }
                    Err(e) => {
                        log::warn!("tray: failed to deserialize update_available payload: {e}");
                    }
                },
            );

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Setup wizard
            containers_cmd::check_runtime,
            containers_cmd::install_runtime,
            containers_cmd::init_vm,
            containers_cmd::create_project,
            containers_cmd::link_cli,
            // Container lifecycle
            containers_cmd::is_setup_complete,
            containers_cmd::build_images,
            containers_cmd::start_containers,
            containers_cmd::check_claude_auth,
            containers_cmd::check_containers_running,
            // Settings
            containers_cmd::factory_reset,
            containers_cmd::get_llm_config,
            containers_cmd::update_llm_config,
            // Authentication
            auth_commands::save_api_key,
            auth_commands::delete_api_key,
            auth_commands::get_auth_status,
            // URL opener
            url_validation::open_url,
            // Platform
            url_validation::get_platform,
            auth_commands::open_auth_terminal,
            // Chat
            start_chat,
            send_message,
            answer_question,
            // Chat history
            list_conversations,
            get_conversation,
            get_project_memory,
            resume_conversation,
            // Project management
            list_projects,
            switch_project,
            // Health
            get_health,
            // Container logs
            container_logs_cmd::get_container_logs,
            container_logs_cmd::get_compose_logs,
            container_logs_cmd::get_mcp_os_logs,
            // IDE Bridge
            list_available_ides,
            select_ide,
            get_selected_ide,
            get_bridge_status,
            // Container updates
            update_commands::update_containers,
            update_commands::rollback_containers,
            // Update
            update_commands::check_for_update,
            update_commands::install_update,
            update_commands::get_update_settings,
            update_commands::set_update_settings,
            update_commands::restart_app,
            // Logging
            set_log_level,
            get_log_level,
            // Diagnostics
            export_diagnostics,
            // Integrations
            integrations_cmd::get_integrations,
            integrations_cmd::set_integration_enabled,
            integrations_cmd::set_os_integration_enabled,
            integrations_cmd::save_integration_credentials,
            integrations_cmd::save_redmine_mappings,
            integrations_cmd::delete_integration_credentials,
            integrations_cmd::restart_integration_containers,
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
                    reconcile::run_exit_cleanup(&ide_bridge_exit, &mcp_os_exit, &auto_check_exit);
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("fatal: Tauri application failed to start");
}
