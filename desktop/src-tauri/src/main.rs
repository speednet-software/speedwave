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
mod containers_cmd;
mod diagnostics;
mod fs_perms;
mod health;
mod history;
mod ide_bridge;
mod integrations_cmd;
mod log_commands;
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

use types::*;

use chat::{ChatSession, SharedChatSession};
use health::HealthMonitor;
use speedwave_runtime::config;

use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::Manager;

/// Shared handle for the background auto-update check task.
type SharedAutoCheckHandle = Arc<Mutex<Option<tauri::async_runtime::JoinHandle<()>>>>;

/// Tracks the latest available update version for the system tray menu.
type SharedUpdateVersion = Arc<Mutex<Option<String>>>;

const MAIN_WINDOW_LABEL: &str = "main";

/// Global mutex protecting all read-modify-write cycles on config.json.
/// Without this, concurrent Tauri commands (e.g. toggling mail then notes in quick
/// succession) can lose writes due to TOCTOU races.
static CONFIG_LOCK: std::sync::LazyLock<Mutex<()>> = std::sync::LazyLock::new(|| Mutex::new(()));

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
    if !user_config.projects.iter().any(|p| p.name == name) {
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
            .projects
            .iter()
            .find(|p| p.name == project)
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

type SharedIdeBridge = Arc<Mutex<Option<ide_bridge::IdeBridge>>>;

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

/// Returns the current IDE Bridge status for the Angular frontend.
///
/// **Side effect:** when the upstream IDE is detected as dead (PID gone or port
/// not listening), this command clears the upstream selection and removes it from
/// persisted config so it won't be restored on next startup. This fires only once
/// per IDE death — subsequent polls see `upstream_info() → None`.
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
                        bridge.clear_upstream();
                        // Clear persisted selection so it doesn't restore on next startup
                        if let Ok(_lock) = CONFIG_LOCK.lock() {
                            match config::load_user_config() {
                                Ok(mut user_config) => {
                                    user_config.selected_ide = None;
                                    if let Err(e) = config::save_user_config(&user_config) {
                                        log::warn!(
                                            "get_bridge_status: failed to persist IDE deselection: {e}"
                                        );
                                    }
                                }
                                Err(e) => {
                                    log::warn!(
                                        "get_bridge_status: failed to load user config: {e}"
                                    );
                                }
                            }
                        }
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
use window::{
    hide_main_window, should_debounce, should_prevent_close, should_run_cleanup, show_main_window,
};

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
            if let Some(res) = resolve_resources_dir(parent) {
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
                        reconcile_compose_port(app.handle());
                    }
                    Err(e) => log::error!("mcp-os spawn error: {e}"),
                }
            } else {
                log::warn!("mcp-os script not found — OS integrations will be unavailable");
            }

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
            let tray_menu = build_tray_menu(app.handle(), &None)?;
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
                        refresh_tray_menu(&app_handle_listener, &Some(version));
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
            get_container_logs,
            get_compose_logs,
            // IDE Bridge
            list_available_ides,
            select_ide,
            get_selected_ide,
            get_bridge_status,
            // Container updates
            update_containers,
            rollback_containers,
            // Update
            check_for_update,
            install_update,
            get_update_settings,
            set_update_settings,
            restart_app,
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
                    run_exit_cleanup(&ide_bridge_exit, &mcp_os_exit, &auto_check_exit);
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("fatal: Tauri application failed to start");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    // -- Container name validation (get_container_logs logic) --

    #[test]
    fn container_name_requires_compose_prefix() {
        let prefix = speedwave_runtime::consts::COMPOSE_PREFIX;
        let valid = format!("{}_acme_claude", prefix);
        assert!(valid.starts_with(&format!("{}_", prefix)));

        // Without prefix
        assert!(!"random_container".starts_with(&format!("{}_", prefix)));
    }

    #[test]
    fn container_name_rejects_shell_characters() {
        let name = "speedwave_acme;rm -rf /";
        let has_invalid = !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.');
        assert!(has_invalid, "semicolons should be rejected");
    }

    #[test]
    fn container_name_rejects_path_traversal() {
        let name = "speedwave_../etc/passwd";
        let has_invalid = !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.');
        assert!(has_invalid, "slashes should be rejected");
    }

    // -- set_log_level / get_log_level tests --
    //
    // These functions mutate global state (`log::set_max_level`), so we
    // serialize all log-level tests through a single mutex.

    // -- Log sanitization tests (get_container_logs / get_compose_logs) --

    #[test]
    fn container_logs_sanitize_bearer_token() {
        let raw = "2024-01-15 INFO  Calling API with Bearer sk-ant-api03-secret123\nDone.";
        let sanitized = speedwave_runtime::log_sanitizer::sanitize(raw);
        assert!(
            !sanitized.contains("sk-ant-api03-secret123"),
            "Bearer token should be redacted in container logs: {sanitized}"
        );
        assert!(
            sanitized.contains("Bearer ***REDACTED***"),
            "Should contain redacted marker: {sanitized}"
        );
        assert!(
            sanitized.contains("Done."),
            "Non-secret content should remain: {sanitized}"
        );
    }

    #[test]
    fn container_logs_sanitize_slack_token() {
        let raw = "mcp-hub | Connecting with token xoxb-1234567890-abcdefghij";
        let sanitized = speedwave_runtime::log_sanitizer::sanitize(raw);
        assert!(
            !sanitized.contains("xoxb-1234567890-abcdefghij"),
            "Slack token should be redacted in container logs: {sanitized}"
        );
        assert!(
            sanitized.contains("***REDACTED_SLACK_TOKEN***"),
            "Should contain Slack redacted marker: {sanitized}"
        );
    }

    #[test]
    fn container_logs_sanitize_api_key_assignment() {
        let raw = "Config loaded: api_key=sk-proj-abc123def456 endpoint=https://api.example.com";
        let sanitized = speedwave_runtime::log_sanitizer::sanitize(raw);
        assert!(
            !sanitized.contains("sk-proj-abc123def456"),
            "API key should be redacted in container logs: {sanitized}"
        );
        assert!(
            sanitized.contains("api_key=***REDACTED***"),
            "Should contain redacted api_key: {sanitized}"
        );
        assert!(
            sanitized.contains("https://api.example.com"),
            "Non-secret content should remain: {sanitized}"
        );
    }

    #[test]
    fn compose_logs_sanitize_bearer_token() {
        let raw = concat!(
            "claude_1  | Starting session\n",
            "mcp_hub_1 | Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig123\n",
            "mcp_hub_1 | Ready\n"
        );
        let sanitized = speedwave_runtime::log_sanitizer::sanitize(raw);
        assert!(
            !sanitized.contains("eyJhbGciOiJIUzI1NiJ9"),
            "JWT in compose logs should be redacted: {sanitized}"
        );
        assert!(
            sanitized.contains("Starting session"),
            "Non-secret lines should remain: {sanitized}"
        );
        assert!(
            sanitized.contains("Ready"),
            "Non-secret lines should remain: {sanitized}"
        );
    }

    #[test]
    fn compose_logs_sanitize_multiple_secrets() {
        let raw = concat!(
            "hub | password=hunter2 connecting\n",
            "hub | using token xoxb-slack-secret-token\n",
            "hub | Bearer my-bearer-token in header\n",
        );
        let sanitized = speedwave_runtime::log_sanitizer::sanitize(raw);
        assert!(
            !sanitized.contains("hunter2"),
            "Password should be redacted: {sanitized}"
        );
        assert!(
            !sanitized.contains("xoxb-slack-secret-token"),
            "Slack token should be redacted: {sanitized}"
        );
        assert!(
            !sanitized.contains("my-bearer-token"),
            "Bearer token should be redacted: {sanitized}"
        );
    }

    #[test]
    fn container_logs_sanitize_plain_text_unchanged() {
        let raw = "2024-01-15 INFO  Container started successfully on port 4000\nHealthcheck OK";
        let sanitized = speedwave_runtime::log_sanitizer::sanitize(raw);
        assert_eq!(
            sanitized, raw,
            "Plain log lines without secrets should pass through unchanged"
        );
    }

    // -- IntegrationsConfig::set_service tests --

    #[test]
    fn set_service_known_key_returns_true() {
        let mut cfg = config::IntegrationsConfig::default();
        let ic = config::IntegrationConfig {
            enabled: Some(true),
        };
        assert!(cfg.set_service("slack", ic));
        assert_eq!(cfg.slack.unwrap().enabled, Some(true));
    }

    #[test]
    fn set_service_all_known_keys() {
        for key in &["slack", "sharepoint", "redmine", "gitlab"] {
            let mut cfg = config::IntegrationsConfig::default();
            let ic = config::IntegrationConfig {
                enabled: Some(true),
            };
            assert!(
                cfg.set_service(key, ic),
                "set_service should accept '{}'",
                key
            );
        }
    }

    #[test]
    fn set_service_unknown_key_returns_false() {
        let mut cfg = config::IntegrationsConfig::default();
        let ic = config::IntegrationConfig {
            enabled: Some(true),
        };
        assert!(!cfg.set_service("unknown", ic));
        assert!(!cfg.set_service(
            "os",
            config::IntegrationConfig {
                enabled: Some(true)
            }
        ));
    }

    #[test]
    fn set_service_overwrite() {
        let mut cfg = config::IntegrationsConfig::default();
        cfg.set_service(
            "slack",
            config::IntegrationConfig {
                enabled: Some(true),
            },
        );
        cfg.set_service(
            "slack",
            config::IntegrationConfig {
                enabled: Some(false),
            },
        );
        assert_eq!(cfg.slack.unwrap().enabled, Some(false));
    }

    // -- resolve_resources_dir --

    #[cfg(target_os = "macos")]
    mod resolve_resources_dir_tests {
        use super::super::resolve_resources_dir;
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
            // Resources dir exists but has no marker → should return None

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
        use super::super::resolve_resources_dir;
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
        use super::super::resolve_resources_dir;
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

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn set_os_integration_enabled_rejects_on_non_macos() {
        let result = set_os_integration_enabled("test".into(), "reminders".into(), true);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("only available on macOS"));
    }
}
