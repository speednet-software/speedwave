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
mod log_file;
mod logging_cmd;
mod mcp_os_process;
mod oauth_cmd;
mod plugin_cmd;
mod reconcile;
mod redmine_api_cmd;
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

use reconcile::{ExitCleanupContext, SharedAutoCheckHandle, SharedIdeBridge, SharedMcpOs};

/// Joins a cleanup thread handle with a watchdog that force-exits after
/// `EXIT_CLEANUP_TIMEOUT_SECS`. If the cleanup thread panics, exits with
/// code 1. If it completes normally, returns and the caller may exit cleanly.
///
/// `drop(watchdog)` detaches the watchdog thread (does NOT cancel it), but
/// `process::exit` from the main path terminates the process before the
/// sleeping watchdog fires.
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

/// Stashes a cleanup `JoinHandle` into the shared slot so `RunEvent::Exit`
/// can join it before the process exits.
///
/// If the slot is already occupied (the other exit path beat us to it, which
/// the `CLEANUP_ONCE` guard makes effectively impossible) or the mutex is
/// poisoned, drops the handle — the cleanup thread will run to completion
/// independently and the process exit path in `RunEvent::Exit` will join
/// whatever handle arrived first.
///
/// **Must not be called on the Tauri event-loop thread with blocking intent** —
/// both call sites (WindowEvent::Destroyed and RunEvent::ExitRequested) only
/// stash the handle; the actual join happens in `RunEvent::Exit` on the same
/// thread after Tauri has finished processing events.
pub(crate) fn stash_cleanup_handle(
    slot: &Arc<Mutex<Option<std::thread::JoinHandle<()>>>>,
    handle: std::thread::JoinHandle<()>,
) {
    match slot.lock() {
        Ok(mut guard) => {
            if guard.is_none() {
                *guard = Some(handle);
            }
            // else: slot already occupied — CLEANUP_ONCE guarantees the
            // cleanup body runs once, so this handle is a no-op. Drop it.
        }
        Err(e) => {
            log::warn!("exit cleanup handle slot poisoned, cleanup will not be joined: {e}");
            // Drop the handle — the cleanup thread runs independently.
        }
    }
}

/// Tracks the latest available update version for the system tray menu.
type SharedUpdateVersion = Arc<Mutex<Option<String>>>;

/// Serialises compose operations across `start_chat`, `resume_conversation`,
/// and `reconcile_compose_port` to prevent concurrent `compose_up` /
/// `compose_up_recreate` calls during container restart.
type ComposeLock = Arc<Mutex<()>>;

const MAIN_WINDOW_LABEL: &str = "main";

/// Stop flag for the mcp-os watchdog thread. Set during app exit cleanup
/// to prevent the watchdog from respawning mcp-os during shutdown.
static WATCHDOG_STOP: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

// ---------------------------------------------------------------------------
// Chat commands
// ---------------------------------------------------------------------------

const MSG_NOT_AUTHENTICATED: &str = "Claude is not authenticated. Please authenticate first.";

/// Shared implementation for `start_chat` and `resume_conversation`.
///
/// 1. Acquires the compose lock and verifies Claude auth (which also runs
///    `ensure_exec_healthy`).
/// 2. Extracts the old session from the mutex and stops it **outside** the
///    session lock — `stop()` can block on `child.wait()` / reader thread
///    join, and holding the session mutex during that time would starve
///    `send_message`.
/// 3. Re-acquires the session lock and starts the new session.
fn start_session_inner(
    project: &str,
    resume_session_id: Option<&str>,
    compose_arc: ComposeLock,
    session_arc: SharedChatSession,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    // Pre-flight: verify Claude is authenticated.  `check_claude_auth`
    // also calls `ensure_exec_healthy`, so containers are guaranteed
    // healthy after this returns.  The compose lock serialises this with
    // `reconcile_compose_port` to prevent concurrent compose operations.
    {
        log::info!("start_session_inner: acquiring compose lock");
        let _compose_guard = compose_arc
            .lock()
            .map_err(|e| format!("Compose lock poisoned: {e}"))?;
        log::info!("start_session_inner: compose lock acquired, checking auth");
        let authed = setup_wizard::check_claude_auth(project).map_err(|e| e.to_string())?;
        if !authed {
            return Err(MSG_NOT_AUTHENTICATED.to_string());
        }
    }

    // Extract old session and stop it outside the lock.
    log::info!("start_session_inner: extracting old session");
    let mut old_session = {
        let mut guard = session_arc
            .lock()
            .map_err(|e| format!("Lock poisoned: {e}"))?;
        std::mem::replace(&mut *guard, ChatSession::new(project))
    };
    log::info!("start_session_inner: stopping old session (outside lock)");
    old_session.stop().map_err(|e| e.to_string())?;
    drop(old_session);

    // Start the new session under the lock.
    log::info!("start_session_inner: starting new session");
    let mut session = session_arc
        .lock()
        .map_err(|e| format!("Lock poisoned: {e}"))?;
    let result = session
        .start(app_handle, resume_session_id)
        .map_err(|e| e.to_string());
    log::info!("start_session_inner: session.start result={result:?}");
    result
}

#[tauri::command]
async fn start_chat(
    project: String,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, SharedChatSession>,
    compose_lock: tauri::State<'_, ComposeLock>,
) -> Result<(), String> {
    check_project(&project)?;
    log::info!("start_chat: project={project}");
    let session_arc = state.inner().clone();
    let compose_arc = compose_lock.inner().clone();
    tokio::task::spawn_blocking(move || {
        start_session_inner(&project, None, compose_arc, session_arc, app_handle)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn send_message(
    message: String,
    state: tauri::State<'_, SharedChatSession>,
) -> Result<(), String> {
    if message.len() > 1_000_000 {
        return Err("Message too long".to_string());
    }
    log::info!("send_message: len={}", message.len());
    let session_arc = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        let mut session = session_arc.try_lock().map_err(|_| {
            log::info!("send_message: try_lock failed (session busy)");
            "no active session (session is being started)".to_string()
        })?;
        log::info!("send_message: lock acquired, sending");
        session.send_message(&message).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn answer_question(
    tool_use_id: String,
    answer: String,
    state: tauri::State<'_, SharedChatSession>,
) -> Result<(), String> {
    if answer.len() > 1_000_000 {
        return Err("Answer too long".to_string());
    }
    let session_arc = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        let mut session = session_arc
            .try_lock()
            .map_err(|_| "no active session (session is being started)".to_string())?;
        session
            .answer_question(&tool_use_id, &answer)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
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
    compose_lock: tauri::State<'_, ComposeLock>,
) -> Result<(), String> {
    check_project(&project)?;
    history::validate_session_id(&session_id).map_err(|e| e.to_string())?;
    log::info!("resume_conversation: project={project}");
    let session_arc = state.inner().clone();
    let compose_arc = compose_lock.inner().clone();
    tokio::task::spawn_blocking(move || {
        start_session_inner(
            &project,
            Some(&session_id),
            compose_arc,
            session_arc,
            app_handle,
        )
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

/// Switches the active project in-memory. Extracted for testability.
fn apply_switch_project(
    user_config: &mut config::SpeedwaveUserConfig,
    name: &str,
) -> anyhow::Result<()> {
    if user_config.find_project(name).is_none() {
        anyhow::bail!("Project '{}' not found", name);
    }
    user_config.active_project = Some(name.to_string());
    Ok(())
}

#[tauri::command]
async fn switch_project(
    name: String,
    app: tauri::AppHandle,
    chat_state: tauri::State<'_, SharedChatSession>,
) -> Result<(), String> {
    use containers_cmd::{switch_project_core, teardown_and_restore, teardown_only, SwitchResult};

    // Config is committed first to keep the config lock brief — holding it
    // across the blocking container transition would starve other config
    // readers. If the container switch fails, rollback_and_emit_failed
    // restores active_project to `previous`.
    let previous = config::with_config_lock(|| {
        let mut user_config = config::load_user_config()?;
        let prev = user_config.active_project.clone();
        apply_switch_project(&mut user_config, &name)?;
        config::save_user_config(&user_config)?;
        Ok(prev)
    })
    .map_err(|e| e.to_string())?;

    use tauri::Emitter;
    let _ = app.emit(
        "project_switch_started",
        serde_json::json!({ "project": name }),
    );

    // Container transaction: wait for images → stop previous → recreate new
    let prev_clone = previous.clone();
    let new_clone = name.clone();
    let switch_result = tokio::task::spawn_blocking(move || {
        if let Err(e) = containers_cmd::ensure_images_ready() {
            return SwitchResult::Failed {
                error: e,
                cleanup_error: None,
            };
        }
        let rt = speedwave_runtime::runtime::detect_runtime();
        switch_project_core(&prev_clone, &new_clone, &*rt, &|proj, rt| {
            check_project(proj)?;
            // compose_down(prev) already handled by switch_project_core step 2.
            // Here we only render the new compose and start containers.
            containers_cmd::render_and_save_compose(proj, rt)?;
            rt.compose_up_recreate(proj).map_err(|e| e.to_string())
        })
    })
    .await
    .map_err(|e| e.to_string())?;

    if let SwitchResult::Failed {
        error,
        cleanup_error,
    } = switch_result
    {
        let full_error = rollback_and_emit_failed(&app, previous, &error, cleanup_error.as_deref());
        return Err(full_error);
    }

    // Rebind chat session (spawn_blocking: rebind_chat acquires Mutex and calls session.start)
    let rebind_name = name.clone();
    let rebind_app = app.clone();
    let rebind_state = chat_state.inner().clone();
    let rebind_result: Result<(), String> =
        tokio::task::spawn_blocking(move || rebind_chat(&rebind_name, &rebind_app, &rebind_state))
            .await
            .map_err(|e| e.to_string())?;

    if let Err(e) = rebind_result {
        // Restore previous project containers + chat
        let mut cleanup_parts: Vec<String> = Vec::new();

        let prev_for_restore = previous.clone();
        let new_for_teardown = name.clone();
        let restore_result: Result<(), String> = tokio::task::spawn_blocking(move || {
            let rt = speedwave_runtime::runtime::detect_runtime();
            match &prev_for_restore {
                Some(prev) => teardown_and_restore(&new_for_teardown, prev, &*rt),
                None => teardown_only(&new_for_teardown, &*rt).map_or(Ok(()), Err),
            }
        })
        .await
        .unwrap_or_else(|je| Err(format!("join error: {je}")));

        if let Err(ref re) = restore_result {
            if previous.is_some() {
                cleanup_parts.push(format!(
                    "Container restore failed: {re}. \
                     System may be without running containers — run speedwave to restart."
                ));
            } else {
                cleanup_parts.push(format!("Teardown of new project incomplete: {re}"));
            }
        }

        if let Some(ref prev) = previous {
            if restore_result.is_ok() {
                let rb_prev = prev.clone();
                let rb_app = app.clone();
                let rb_state = chat_state.inner().clone();
                let rb_result: Result<(), String> =
                    tokio::task::spawn_blocking(move || rebind_chat(&rb_prev, &rb_app, &rb_state))
                        .await
                        .unwrap_or_else(|je| Err(format!("join error: {je}")));

                if let Err(re) = rb_result {
                    cleanup_parts.push(format!(
                        "Containers restored but chat rebind to '{prev}' failed: {re}"
                    ));
                }
            }
        }

        let cleanup_error = if cleanup_parts.is_empty() {
            None
        } else {
            Some(cleanup_parts.join(". "))
        };

        let full_error =
            rollback_and_emit_failed(&app, previous, &e.to_string(), cleanup_error.as_deref());
        return Err(full_error);
    }

    let _ = app.emit(
        "project_switch_succeeded",
        serde_json::json!({ "project": name }),
    );
    Ok(())
}

fn rebind_chat(
    project: &str,
    app: &tauri::AppHandle,
    chat_state: &SharedChatSession,
) -> Result<(), String> {
    check_project(project)?;
    let mut session = chat_state
        .lock()
        .map_err(|e| format!("Lock poisoned: {e}"))?;
    session.stop().map_err(|e| e.to_string())?;
    *session = ChatSession::new(project);
    session.start(app.clone(), None).map_err(|e| e.to_string())
}

pub(crate) fn rollback_and_emit_failed(
    app: &tauri::AppHandle,
    previous: Option<String>,
    error: &str,
    cleanup_error: Option<&str>,
) -> String {
    let rollback_err = config::with_config_lock(|| {
        let mut cfg = config::load_user_config()?;
        cfg.active_project = previous.clone();
        config::save_user_config(&cfg)?;
        Ok(())
    })
    .err();

    let mut parts = vec![error.to_string()];
    if let Some(ce) = cleanup_error {
        parts.push(ce.to_string());
    }
    if let Some(rb) = rollback_err {
        parts.push(format!("Config rollback failed: {rb}"));
    }
    let full_error = parts.join(". ");

    use tauri::Emitter;
    let _ = app.emit(
        "project_switch_failed",
        serde_json::json!({
            "project": previous,
            "error": full_error,
        }),
    );

    full_error
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
    if let Ok(()) = config::with_config_lock(|| {
        let mut user_config = config::load_user_config()?;
        user_config.selected_ide = None;
        config::save_user_config(&user_config)
    }) {
        // ok
    } else {
        log::warn!("cleanup_dead_ide: failed to persist IDE deselection");
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
    app: tauri::AppHandle,
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
    config::with_config_lock(|| {
        let mut user_config = config::load_user_config()?;
        user_config.selected_ide = Some(speedwave_runtime::config::SelectedIde {
            ide_name: ide_name.clone(),
            port,
        });
        config::save_user_config(&user_config)
    })
    .map_err(|e| e.to_string())?;

    // Start IDE Bridge on-demand if it wasn't started at startup (e.g. after
    // factory reset when setup_started was false during the initial launch).
    ensure_ide_bridge_running(&state, &app);

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
// Extracted subsystem starters (reused by setup() and ensure_*_running())
// ---------------------------------------------------------------------------

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

/// Start mcp-os watchdog thread. Called from setup() and ensure_mcp_os_running().
fn start_mcp_os_watchdog(
    mcp_os: SharedMcpOs,
    app_handle: tauri::AppHandle,
    compose_lock: ComposeLock,
) {
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

            match mcp_os.lock() {
                Ok(mut guard) => match *guard {
                    None => break,
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
                                log::info!("mcp-os watchdog: respawned (port {port})");
                                reconcile::reconcile_compose_port(
                                    &app_handle,
                                    compose_lock.clone(),
                                );
                            }
                            Err(e) => {
                                log::error!("mcp-os watchdog: respawn failed: {e}");
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
}

/// Start IDE Bridge if not already running. Holds the mutex for the entire
/// init+start to prevent races (two callers both seeing None and double-starting).
fn ensure_ide_bridge_running(ide_bridge: &SharedIdeBridge, app_handle: &tauri::AppHandle) {
    let mut guard = match ide_bridge.lock() {
        Ok(g) => g,
        Err(e) => {
            log::error!("ensure_ide_bridge_running: mutex poisoned: {e}");
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
/// spawn to prevent races (two callers both seeing None and double-spawning).
/// This can block up to `PORT_READ_TIMEOUT` (10 s) — acceptable for a
/// single-user desktop app where concurrent Tauri commands are rare.
fn ensure_mcp_os_running(
    mcp_os: &SharedMcpOs,
    app_handle: &tauri::AppHandle,
    compose_lock: ComposeLock,
) {
    let mut guard = match mcp_os.lock() {
        Ok(g) => g,
        Err(e) => {
            log::error!("ensure_mcp_os_running: mutex poisoned: {e}");
            return;
        }
    };
    if guard.is_some() {
        return;
    }
    let script = speedwave_runtime::build::resolve_mcp_os_script();
    if let Some(script_path) = script {
        let script_str = script_path.to_string_lossy().to_string();
        match mcp_os_process::McpOsProcess::spawn(&script_str) {
            Ok(proc) => {
                log::info!("ensure_mcp_os_running: started (port {})", proc.port());
                *guard = Some(proc);
                drop(guard); // release before spawning watchdog thread
                             // Narrow TOCTOU: factory_reset could set WATCHDOG_STOP=true
                             // between drop(guard) and the store below, causing a no-op
                             // watchdog loop on None. Harmless in single-user desktop app
                             // — the watchdog exits on the next iteration when it sees None.
                WATCHDOG_STOP.store(false, Ordering::Relaxed);
                start_mcp_os_watchdog(mcp_os.clone(), app_handle.clone(), compose_lock);
            }
            Err(e) => log::error!("ensure_mcp_os_running: spawn failed: {e}"),
        }
    }
}

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

    // True when setup has been *started* (at least check_runtime passed).
    // After factory reset or fresh install, runtime_ready is false so we
    // skip IDE Bridge / mcp-os / link_cli / resources marker to keep
    // ~/.speedwave/ non-existent until the wizard explicitly creates it.
    let setup_started = setup_wizard::SetupState::load().runtime_ready;

    // Bundled binary resolution for app bundles.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            if let Some(res) = reconcile::resolve_resources_dir(parent) {
                // Env var always set — Desktop uses it directly, never reads the marker file
                std::env::set_var(speedwave_runtime::consts::BUNDLE_RESOURCES_ENV, &res);
                // Marker written to disk only if setup was completed at least once.
                // After factory reset or fresh install: don't recreate ~/.speedwave/.
                // CLI needs the marker only after the wizard finishes and links the binary.
                if setup_started {
                    if let Err(e) = speedwave_runtime::build::write_resources_marker(&res) {
                        log::warn!("could not write resources-dir marker: {e}");
                    }
                }
            }
        }
    }

    let initial_session: SharedChatSession = Arc::new(Mutex::new(ChatSession::new("default")));
    let compose_lock: ComposeLock = Arc::new(Mutex::new(()));

    // Shared state for IDE Bridge, mcp-os process, auto-check handle, and tray update version
    let ide_bridge: SharedIdeBridge = Arc::new(Mutex::new(None));
    let mcp_os: SharedMcpOs = Arc::new(Mutex::new(None));
    let auto_check_handle: SharedAutoCheckHandle = Arc::new(Mutex::new(None));
    let update_version: SharedUpdateVersion = Arc::new(Mutex::new(None));

    let tray_available = Arc::new(AtomicBool::new(false));
    #[cfg_attr(target_os = "linux", allow(unused_variables))]
    let tray_available_setup = tray_available.clone();
    let tray_available_close = tray_available.clone();

    // Bundle the three shared-state Arcs into a single context struct so each
    // exit path only needs one clone instead of three parallel Arc clones.
    let cleanup_ctx = ExitCleanupContext {
        ide_bridge: ide_bridge.clone(),
        mcp_os: mcp_os.clone(),
        auto_check_handle: auto_check_handle.clone(),
    };
    let cleanup_ctx_window = cleanup_ctx.clone();
    let cleanup_ctx_runevent = cleanup_ctx.clone();
    let update_version_setup = update_version.clone();

    // Register SIGTERM/SIGINT handler so process signals trigger the same
    // cleanup as graceful window close. The CLEANUP_ONCE guard in
    // run_exit_cleanup ensures the body runs at most once even when both
    // the signal handler and WindowEvent::Destroyed fire concurrently.
    let cleanup_ctx_signal = cleanup_ctx.clone();
    // The ctrlc crate runs handlers on a dedicated thread (not a real signal
    // handler), so blocking with `.join()` here is safe and necessary —
    // `std::process::exit` would otherwise kill the cleanup thread mid-flight
    // and the Lima VM would never stop.
    match ctrlc::set_handler(move || {
        if let Some(handle) = reconcile::run_exit_cleanup(&cleanup_ctx_signal) {
            join_with_exit_watchdog(handle);
        }
        // Exit code 1: process was terminated by a signal (SIGTERM/SIGINT).
        std::process::exit(1);
    }) {
        Ok(()) => {}
        Err(e) => {
            log::error!("fatal: failed to set signal handler: {e}");
            std::process::exit(1);
        }
    }

    // Shared slot for the cleanup `JoinHandle` produced inside
    // `WindowEvent::Destroyed` or `RunEvent::ExitRequested` (whichever fires
    // first for the given exit path). The Tauri `RunEvent::Exit` hook drains
    // and joins it so the Lima VM stop completes before `Builder::run`
    // returns (and the process exits).
    let exit_cleanup_handle: Arc<Mutex<Option<std::thread::JoinHandle<()>>>> =
        Arc::new(Mutex::new(None));
    let exit_cleanup_handle_window = exit_cleanup_handle.clone();
    let exit_cleanup_handle_runevent = exit_cleanup_handle.clone();

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
            use tauri_plugin_log::{RotationStrategy, Target, TargetKind};
            // Note: no timezone_strategy() here — the custom `.format(...)`
            // below takes over and uses `chrono::Local::now()` directly, so
            // the plugin's TimezoneStrategy would be dead config.
            tauri_plugin_log::Builder::new()
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
                .max_file_size(50_000_000)
                .rotation_strategy(RotationStrategy::KeepAll)
                .format(move |callback, message, record| {
                    let sanitized =
                        speedwave_runtime::log_sanitizer::sanitize(&format!("{message}"));
                    // ISO8601 local-time timestamp with millisecond precision.
                    // Shipped in every log line so post-mortem timing analysis
                    // (e.g. shutdown-sequence profiling) does not need a
                    // separate overlay. `%.3f` keeps the millis in the
                    // fractional-seconds slot; `%z` is the numeric UTC offset
                    // from chrono::Local::now(), which reads the system timezone.
                    let ts = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S%.3f%z");
                    callback.finish(format_args!(
                        "{ts} [{level}][{target}] {sanitized}",
                        level = record.level(),
                        target = record.target(),
                    ))
                })
                .build()
        })
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
        .manage(compose_lock.clone())
        .manage(ide_bridge.clone())
        .manage(mcp_os.clone())
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

            if setup_started {
                // Start IDE Bridge
                init_and_start_ide_bridge(&ide_bridge, app.handle());

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
                            reconcile::reconcile_compose_port(
                                app.handle(),
                                compose_lock.clone(),
                            );
                        }
                        Err(e) => log::error!("mcp-os spawn error: {e}"),
                    }
                } else {
                    log::warn!("mcp-os script not found — OS integrations will be unavailable");
                }

                // Start mcp-os watchdog thread
                start_mcp_os_watchdog(
                    mcp_os.clone(),
                    app.handle().clone(),
                    compose_lock.clone(),
                );
            } else {
                log::info!("setup not started, deferring IDE Bridge / mcp-os / link_cli until setup completes");
            }

            // Start background auto-update check (store handle for cancellation)
            let handle = updater::spawn_auto_check(app.handle().clone());
            match auto_check_handle.lock() {
                Ok(mut guard) => *guard = Some(handle),
                Err(e) => log::warn!("auto-check handle mutex poisoned: {e}"),
            }

            // Re-link CLI binary on every startup to keep it in sync after updates.
            // Gated behind setup_started: CLI doesn't exist on fresh install,
            // and we must not recreate ~/.speedwave/ after factory reset.
            if setup_started {
                #[cfg(target_os = "macos")]
                if let Err(e) = setup_wizard::ensure_lima_vm_config() {
                    log::warn!("Lima VM config migration failed: {e}");
                }

                if let Err(e) = setup_wizard::link_cli() {
                    log::warn!("CLI re-link on startup failed: {e}");
                }
                reconcile::reconcile_bundle_update(app.handle());
            }

            // Build system tray.
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
                        #[cfg(not(target_os = "linux"))]
                        let app_clone = app.clone();
                        let uv = update_version_tray.clone();
                        tauri::async_runtime::spawn(async move {
                            let version = uv.lock().ok().and_then(|g| g.clone());
                            if let Some(expected) = version {
                                #[cfg(target_os = "linux")]
                                let result = {
                                    let _ = expected;
                                    open::that(
                                        "https://github.com/speednet-software/speedwave/releases",
                                    )
                                    .map_err(|e| e.to_string())
                                };

                                #[cfg(not(target_os = "linux"))]
                                let result = update_commands::install_update_and_reconcile(
                                    app_clone.clone(),
                                    expected,
                                )
                                .await;

                                match result {
                                    Ok(()) => {
                                        log::info!("tray: update action completed");
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
                    // extension). Closing the window must always exit on Linux.
                    // The tray menu (Open/Quit) still works when the icon is
                    // visible.
                    #[cfg(not(target_os = "linux"))]
                    tray_available_setup.store(true, Ordering::Relaxed);
                }
                Err(e) => {
                    // Tray creation failed. Window is already visible
                    // (tauri.conf.json: visible=true), so no fallback needed.
                    log::error!("tray: failed to create system tray: {e}");
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
            // System checks
            containers_cmd::run_system_check,
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
            auth_commands::get_auth_command,
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
            containers_cmd::add_project,
            // Health
            get_health,
            // Container logs
            container_logs_cmd::get_container_logs,
            container_logs_cmd::get_compose_logs,
            container_logs_cmd::get_mcp_os_logs,
            container_logs_cmd::get_claude_session_logs,
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
            update_commands::install_update_and_reconcile,
            update_commands::get_update_settings,
            update_commands::set_update_settings,
            update_commands::get_bundle_reconcile_state,
            update_commands::retry_bundle_reconcile,
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
            containers_cmd::recreate_project_containers,
            // OAuth
            oauth_cmd::start_sharepoint_oauth,
            oauth_cmd::cancel_sharepoint_oauth,
            // Redmine API proxy
            redmine_api_cmd::validate_redmine_credentials,
            redmine_api_cmd::fetch_redmine_enumerations,
            // Plugins
            plugin_cmd::get_plugins,
            plugin_cmd::install_plugin,
            plugin_cmd::remove_plugin,
            plugin_cmd::set_plugin_enabled,
            plugin_cmd::save_plugin_credentials,
            plugin_cmd::delete_plugin_credentials,
            plugin_cmd::plugin_save_settings,
            plugin_cmd::plugin_load_settings,
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
                    // Spawn cleanup but DO NOT join here — joining on the
                    // Tauri main thread would deadlock the event loop. Stash
                    // the handle so `RunEvent::Exit` can join before the
                    // process actually exits.
                    if let Some(handle) = reconcile::run_exit_cleanup(&cleanup_ctx_window) {
                        stash_cleanup_handle(&exit_cleanup_handle_window, handle);
                    }
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("fatal: Tauri application failed to start")
        .run(move |app_handle, event| match event {
            // `ExitRequested` covers the paths where `WindowEvent::Destroyed`
            // does NOT fire on the main window before exit:
            //   - Tray menu "Quit" (calls `app.exit(0)`)
            //   - macOS app menu "Quit Speedwave" / Cmd+Q (NSApplication terminate)
            //   - SIGTERM via the Tauri runtime
            // In tray mode the main window is hidden (not destroyed), so the
            // `WindowEvent::Destroyed` branch never runs and the VM would stay
            // up after the process exits. Spawning cleanup here guarantees it
            // runs for every exit path. `CLEANUP_ONCE` inside
            // `run_exit_cleanup` makes this idempotent with respect to the
            // `WindowEvent::Destroyed` call site.
            tauri::RunEvent::ExitRequested { .. } => {
                // Hide the main window immediately so macOS stops waiting for
                // the window to respond during the cleanup join in
                // `RunEvent::Exit`. Without this, the user sees a beachball
                // for ~1s on Cmd+Q because the event loop blocks joining the
                // limactl stop thread while the window is still visible —
                // WindowServer then draws the beachball.
                //
                // Safe on Linux and Windows too: on those platforms the
                // window is typically already being destroyed when
                // ExitRequested fires (tray-less setups), making this a
                // harmless no-op. Do NOT gate this to macOS — a
                // `#[cfg(target_os = "macos")]` guard would re-introduce the
                // beachball if macOS ever reorders event delivery, and
                // removing it costs nothing elsewhere.
                hide_main_window(app_handle);
                if let Some(handle) = reconcile::run_exit_cleanup(&cleanup_ctx_runevent) {
                    stash_cleanup_handle(&exit_cleanup_handle_runevent, handle);
                }
            }
            tauri::RunEvent::Exit => {
                // Drain and join the cleanup thread spawned in
                // `WindowEvent::Destroyed` or `RunEvent::ExitRequested` so
                // `limactl stop` finishes before Tauri returns from `.run()`
                // and the process exits.
                let handle = match exit_cleanup_handle_runevent.lock() {
                    Ok(mut slot) => slot.take(),
                    Err(e) => {
                        log::warn!("exit cleanup handle slot poisoned at exit: {e}");
                        None
                    }
                };
                if let Some(handle) = handle {
                    join_with_exit_watchdog(handle);
                }
            }
            _ => {}
        });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use config::{ProjectUserEntry, SpeedwaveUserConfig};

    /// Extracts the body of a function from source code by matching `{`/`}`
    /// counting braces.  Used by structural tests to assert on function contents.
    ///
    /// NOTE: uses `split(fn_signature)` which matches the first occurrence of
    /// the literal string in the entire file.  Signatures must be unique —
    /// avoid naming test helpers with substrings that collide with real command
    /// signatures (e.g. don't name a test `fn test_async_fn_start_chat_…`).
    fn extract_fn_body<'a>(source: &'a str, fn_signature: &str) -> &'a str {
        let after_sig = source
            .split(fn_signature)
            .nth(1)
            .unwrap_or_else(|| panic!("{fn_signature} not found in source"));
        let brace_start = after_sig.find('{').expect("opening brace not found");
        let rest = &after_sig[brace_start..];
        let mut depth = 0i32;
        let mut end = 0;
        for (i, ch) in rest.char_indices() {
            match ch {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        end = i;
                        break;
                    }
                }
                _ => {}
            }
        }
        assert!(end > 0, "closing brace not found for {fn_signature}");
        &rest[..end]
    }

    // -- auth pre-flight structural tests --

    #[test]
    fn start_chat_delegates_to_start_session_inner() {
        let source = include_str!("main.rs");
        let body = extract_fn_body(source, "async fn start_chat(");
        assert!(
            body.contains("start_session_inner"),
            "start_chat must delegate to start_session_inner"
        );
    }

    #[test]
    fn resume_conversation_delegates_to_start_session_inner() {
        let source = include_str!("main.rs");
        let body = extract_fn_body(source, "async fn resume_conversation(");
        assert!(
            body.contains("start_session_inner"),
            "resume_conversation must delegate to start_session_inner"
        );
    }

    #[test]
    fn start_session_inner_checks_auth_before_session_start() {
        let source = include_str!("main.rs");
        let body = extract_fn_body(source, "fn start_session_inner(");

        let auth_pos = body
            .find("check_claude_auth")
            .expect("start_session_inner must call check_claude_auth");
        let start_pos = body
            .find(".start(app_handle")
            .expect("start_session_inner must call session.start(app_handle, ...)");

        assert!(
            auth_pos < start_pos,
            "check_claude_auth must come BEFORE session.start()"
        );
    }

    #[test]
    fn start_session_inner_acquires_compose_lock_for_auth() {
        let source = include_str!("main.rs");
        let body = extract_fn_body(source, "fn start_session_inner(");

        let compose_pos = body
            .find("_compose_guard")
            .expect("start_session_inner must acquire compose lock");
        let auth_pos = body
            .find("setup_wizard::check_claude_auth")
            .expect("start_session_inner must call check_claude_auth");

        assert!(
            compose_pos < auth_pos,
            "compose lock must be acquired BEFORE check_claude_auth"
        );
    }

    // -- spawn_blocking guard-rail tests --
    //
    // Chat commands must never acquire the SharedChatSession Mutex on the main
    // thread.  These structural tests enforce that every command wrapping the
    // mutex uses `spawn_blocking` and acquires `.lock()` inside it.

    #[test]
    fn start_chat_uses_spawn_blocking() {
        let source = include_str!("main.rs");
        let body = extract_fn_body(source, "async fn start_chat(");
        assert!(
            body.contains("spawn_blocking"),
            "start_chat must use spawn_blocking to avoid blocking the main thread"
        );
    }

    #[test]
    fn send_message_uses_spawn_blocking() {
        let source = include_str!("main.rs");
        let body = extract_fn_body(source, "async fn send_message(");
        assert!(
            body.contains("spawn_blocking"),
            "send_message must use spawn_blocking to avoid blocking the main thread"
        );
    }

    #[test]
    fn answer_question_uses_spawn_blocking() {
        let source = include_str!("main.rs");
        let body = extract_fn_body(source, "async fn answer_question(");
        assert!(
            body.contains("spawn_blocking"),
            "answer_question must use spawn_blocking to avoid blocking the main thread"
        );
    }

    #[test]
    fn start_session_inner_acquires_session_lock() {
        let source = include_str!("main.rs");
        let body = extract_fn_body(source, "fn start_session_inner(");
        assert!(
            body.contains("session_arc") && body.contains(".lock()"),
            "start_session_inner must acquire the session lock"
        );
    }

    #[test]
    fn send_message_acquires_lock_inside_spawn_blocking() {
        let source = include_str!("main.rs");
        let body = extract_fn_body(source, "async fn send_message(");
        let spawn_pos = body
            .find("spawn_blocking")
            .expect("send_message must use spawn_blocking");
        let lock_pos = body
            .find(".try_lock()")
            .expect("send_message must acquire the session lock via try_lock");
        assert!(
            lock_pos > spawn_pos,
            "session lock must be acquired INSIDE spawn_blocking, not before it"
        );
    }

    #[test]
    fn answer_question_acquires_lock_inside_spawn_blocking() {
        let source = include_str!("main.rs");
        let body = extract_fn_body(source, "async fn answer_question(");
        let spawn_pos = body
            .find("spawn_blocking")
            .expect("answer_question must use spawn_blocking");
        let lock_pos = body
            .find(".try_lock()")
            .expect("answer_question must acquire the session lock via try_lock");
        assert!(
            lock_pos > spawn_pos,
            "session lock must be acquired INSIDE spawn_blocking, not before it"
        );
    }

    // -- validation-before-spawn tests --
    //
    // Fast validations (check_project, length checks) must run BEFORE
    // spawn_blocking so invalid requests fail immediately without entering
    // the thread pool.

    #[test]
    fn start_chat_validates_project_before_spawn_blocking() {
        let source = include_str!("main.rs");
        let body = extract_fn_body(source, "async fn start_chat(");
        let check_pos = body
            .find("check_project")
            .expect("start_chat must call check_project");
        let spawn_pos = body
            .find("spawn_blocking")
            .expect("start_chat must use spawn_blocking");
        assert!(
            check_pos < spawn_pos,
            "check_project must come BEFORE spawn_blocking for fail-fast validation"
        );
    }

    #[test]
    fn send_message_validates_length_before_spawn_blocking() {
        let source = include_str!("main.rs");
        let body = extract_fn_body(source, "async fn send_message(");
        let len_pos = body
            .find("message.len()")
            .expect("send_message must check message length");
        let spawn_pos = body
            .find("spawn_blocking")
            .expect("send_message must use spawn_blocking");
        assert!(
            len_pos < spawn_pos,
            "message length check must come BEFORE spawn_blocking for fail-fast validation"
        );
    }

    #[test]
    fn answer_question_validates_length_before_spawn_blocking() {
        let source = include_str!("main.rs");
        let body = extract_fn_body(source, "async fn answer_question(");
        let len_pos = body
            .find("answer.len()")
            .expect("answer_question must check answer length");
        let spawn_pos = body
            .find("spawn_blocking")
            .expect("answer_question must use spawn_blocking");
        assert!(
            len_pos < spawn_pos,
            "answer length check must come BEFORE spawn_blocking for fail-fast validation"
        );
    }

    // -- JoinError handling tests --
    //
    // spawn_blocking returns JoinHandle which can fail with JoinError (e.g.
    // if the spawned task panics).  The outer .await.map_err(…) must convert
    // this to a String for the Tauri IPC error channel.

    #[test]
    fn start_chat_handles_join_error() {
        let source = include_str!("main.rs");
        let body = extract_fn_body(source, "async fn start_chat(");
        assert!(
            body.contains(".await") && body.contains("map_err(|e| e.to_string())"),
            "start_chat must handle JoinError from spawn_blocking via .await.map_err"
        );
    }

    #[test]
    fn send_message_handles_join_error() {
        let source = include_str!("main.rs");
        let body = extract_fn_body(source, "async fn send_message(");
        assert!(
            body.contains(".await")
                && body.contains("map_err(|e| e.to_string())")
                && body.matches("map_err").count() >= 2,
            "send_message must handle JoinError from spawn_blocking via .await.map_err"
        );
    }

    #[test]
    fn answer_question_handles_join_error() {
        let source = include_str!("main.rs");
        let body = extract_fn_body(source, "async fn answer_question(");
        assert!(
            body.contains(".await")
                && body.contains("map_err(|e| e.to_string())")
                && body.matches("map_err").count() >= 2,
            "answer_question must handle JoinError from spawn_blocking via .await.map_err"
        );
    }

    // -- apply_switch_project tests --

    fn make_config_with_projects() -> SpeedwaveUserConfig {
        SpeedwaveUserConfig {
            projects: vec![
                ProjectUserEntry {
                    name: "alpha".to_string(),
                    dir: "/tmp/alpha".to_string(),
                    claude: None,
                    integrations: None,
                    plugin_settings: None,
                },
                ProjectUserEntry {
                    name: "beta".to_string(),
                    dir: "/tmp/beta".to_string(),
                    claude: None,
                    integrations: None,
                    plugin_settings: None,
                },
            ],
            active_project: Some("alpha".to_string()),
            selected_ide: None,
            log_level: None,
        }
    }

    // -- apply_switch_project tests --

    #[test]
    fn switch_project_happy_path() {
        let mut cfg = make_config_with_projects();
        assert_eq!(cfg.active_project.as_deref(), Some("alpha"));

        let result = apply_switch_project(&mut cfg, "beta");
        assert!(result.is_ok());
        assert_eq!(cfg.active_project.as_deref(), Some("beta"));
    }

    #[test]
    fn switch_project_to_same_project() {
        let mut cfg = make_config_with_projects();
        let result = apply_switch_project(&mut cfg, "alpha");
        assert!(result.is_ok());
        assert_eq!(cfg.active_project.as_deref(), Some("alpha"));
    }

    #[test]
    fn switch_project_error_not_found() {
        let mut cfg = make_config_with_projects();
        let result = apply_switch_project(&mut cfg, "nonexistent");
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(
            err.contains("not found"),
            "expected 'not found' error, got: {err}"
        );
        assert!(
            err.contains("nonexistent"),
            "error should mention the project name, got: {err}"
        );
    }

    #[test]
    fn switch_project_error_empty_name() {
        let mut cfg = make_config_with_projects();
        let result = apply_switch_project(&mut cfg, "");
        assert!(result.is_err());
    }

    #[test]
    fn switch_project_does_not_modify_projects_list() {
        let mut cfg = make_config_with_projects();
        let projects_before: Vec<String> = cfg.projects.iter().map(|p| p.name.clone()).collect();

        apply_switch_project(&mut cfg, "beta").unwrap();

        let projects_after: Vec<String> = cfg.projects.iter().map(|p| p.name.clone()).collect();
        assert_eq!(projects_before, projects_after);
    }

    #[test]
    fn switch_project_from_none_active() {
        let mut cfg = SpeedwaveUserConfig {
            projects: vec![ProjectUserEntry {
                name: "only".to_string(),
                dir: "/tmp/only".to_string(),
                claude: None,
                integrations: None,
                plugin_settings: None,
            }],
            active_project: None,
            selected_ide: None,
            log_level: None,
        };

        let result = apply_switch_project(&mut cfg, "only");
        assert!(result.is_ok());
        assert_eq!(cfg.active_project.as_deref(), Some("only"));
    }

    #[test]
    fn switch_project_empty_projects_list() {
        let mut cfg = SpeedwaveUserConfig::default();
        let result = apply_switch_project(&mut cfg, "anything");
        assert!(result.is_err());
    }

    /// Structural test: all exit paths must use `join_with_exit_watchdog`
    /// instead of inline watchdog patterns.
    #[test]
    fn both_exit_paths_use_join_with_exit_watchdog() {
        let source = include_str!("main.rs");
        let occurrences: Vec<_> = source.match_indices("join_with_exit_watchdog").collect();
        // Expected non-test occurrences:
        //   1. fn join_with_exit_watchdog definition
        //   2. ctrlc signal handler call site (blocks — safe on ctrlc's dedicated thread)
        //   3. RunEvent::Exit call site (blocks — after Tauri finishes processing events)
        // The stash_cleanup_handle helper used by WindowEvent::Destroyed and
        // RunEvent::ExitRequested drops handles rather than joining on the event-loop
        // thread, so it does NOT add occurrences here.
        // Total: at least 3 (fn def + 2 call sites) outside the test module.
        let non_test_count = occurrences
            .iter()
            .filter(|(idx, _)| {
                // Exclude occurrences inside #[cfg(test)] mod tests block
                let before = &source[..*idx];
                let last_mod_tests = before.rfind("mod tests");
                let last_cfg_test = before.rfind("#[cfg(test)]");
                // If both markers are found and cfg(test) is close before mod tests,
                // this occurrence is inside the test module.
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
    /// BEFORE spawning cleanup. Without this, the user sees a beachball
    /// on Cmd+Q because the event loop blocks joining the cleanup thread
    /// while the main window is still visible — macOS WindowServer then
    /// draws the beachball. Hiding the window first releases WindowServer
    /// from expecting paint responses.
    ///
    /// The hide is performed via `hide_main_window(app_handle)` — the
    /// canonical helper in `window.rs` that also sets the macOS activation
    /// policy to Accessory so the Dock icon disappears immediately.
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

    /// Regression guard: the `ExitRequested` arm must stash its cleanup handle
    /// into `exit_cleanup_handle_runevent` so that `RunEvent::Exit` can join it
    /// before the process exits. A future refactor that drops the stash would
    /// silently break the join and leave the Lima VM running after quit.
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

    /// Behavioral test for `stash_cleanup_handle` happy path: handle is
    /// stashed into an empty slot. Covers the dominant branch; other
    /// branches (slot-occupied, poisoned-mutex) are unreachable under
    /// `CLEANUP_ONCE` or documented-contract-only.
    #[test]
    fn stash_cleanup_handle_stores_into_empty_slot() {
        let slot: Arc<Mutex<Option<std::thread::JoinHandle<()>>>> = Arc::new(Mutex::new(None));
        let handle = std::thread::spawn(|| {});
        stash_cleanup_handle(&slot, handle);

        let stashed = slot.lock().unwrap().take();
        // Regression guard: if the empty-slot branch were ever inverted
        // (e.g. `if guard.is_some()` instead of `is_none()`), this would be None.
        assert!(
            stashed.is_some(),
            "first handle must be stashed into empty slot"
        );
        stashed.unwrap().join().expect("test thread must not panic");
    }
}
