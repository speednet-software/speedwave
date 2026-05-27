// Speedwave Desktop — Tauri v2 backend
//
// Thin #[tauri::command] wrappers that delegate to the existing module functions.
// Each command converts anyhow::Result into Result<T, String> (Tauri requires
// serializable errors).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#![allow(missing_docs)]

mod auth;
mod auth_commands;
mod bridges;
mod chat;
mod clipboard_bridge;
mod cloudstorage_cmd;
mod container_logs_cmd;
mod containers_cmd;
mod diagnostics;
mod fs_perms;
mod git_cmd;
mod health;
mod history;
mod host_exec_cmd;
mod host_path;
mod http_util;
#[cfg(test)]
mod installer_hooks;
use bridges::ide_bridge;
mod github_oauth_cmd;
mod integrations_cmd;
mod llm_cmd;
mod logging_cmd;
mod oauth_cmd;
mod oauth_flow;
mod oauth_login_cmd;
mod oauth_providers;
mod paste_cmd;
mod patch_emitter;
// `path_util` is consumed only by `oauth_login_cmd::open_terminal_with_command`
// which is Windows-only (gnome-terminal / xterm spawning was removed with the
// Linux backend in ADR-059). Gating the module declaration keeps clippy quiet
// on macOS without needing per-fn `#[cfg(target_os = "windows")]`.
#[cfg(target_os = "windows")]
mod path_util;
mod plugin_cmd;
mod queue_cmd;
mod reconcile;
mod redmine_api_cmd;
mod retry_cmd;
mod setup_wizard;
mod slash_cmd;
mod subscribe_cmd;
mod system_settings_cmd;
mod transcription_cmd;
mod tray;
mod types;
mod ui_prefs_cmd;
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

use reconcile::{
    ExitCleanupContext, SharedAutoCheckHandle, SharedHostExec, SharedIdeBridge, SharedMcpOs,
    SharedOauth, SharedPluginBridges,
};

pub(crate) use host_path::recovered_host_path;
use speedwave_runtime::host_exec_process::{write_host_exec_config_snapshot, HostExecProcess};

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

const MAIN_WINDOW_LABEL: &str = "main";

/// Stop flag for the mcp-os watchdog thread. Set during app exit cleanup
/// to prevent the watchdog from respawning mcp-os during shutdown.
static WATCHDOG_STOP: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Stop flag for the `host_exec` watchdog (set during exit cleanup).
static OAUTH_WATCHDOG_STOP: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

static HOST_EXEC_WATCHDOG_STOP: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

// ---------------------------------------------------------------------------
// Chat commands
// ---------------------------------------------------------------------------

const MSG_NOT_AUTHENTICATED: &str = "Claude is not authenticated. Please authenticate first.";

/// Shared implementation for `start_chat` and `resume_conversation`.
///
/// 1. Acquires the per-project compose lock via `rt.transaction()` and verifies
///    Claude auth (which also runs `ensure_exec_healthy`).
/// 2. Extracts the old session from the mutex and stops it **outside** the
///    session lock — `stop()` can block on `child.wait()` / reader thread
///    join, and holding the session mutex during that time would starve
///    `send_message`.
/// 3. Re-acquires the session lock and starts the new session.
fn start_session_inner(
    project: &str,
    resume_session_id: Option<&str>,
    session_arc: SharedChatSession,
    host_exec_arc: SharedHostExec,
    oauth_arc: SharedOauth,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let host_exec_just_started = ensure_host_exec_running(&host_exec_arc, project);
    let oauth_just_started = ensure_oauth_running(&oauth_arc, project);

    containers_cmd::ensure_images_ready()?;

    if host_exec_just_started || oauth_just_started {
        host_exec_cmd::recreate_project_containers_if_running(project);
    }

    // Per-project compose lock serialises auth check with concurrent compose ops.
    log::info!("start_session_inner: acquiring compose lock");
    let rt = speedwave_runtime::runtime::detect_runtime();
    // `_rt` unused: `check_claude_auth` builds its own runtime; HELD_LOCKS
    // makes that call reentrant within this thread + project.
    rt.transaction(project, |_rt| -> anyhow::Result<()> {
        log::info!("start_session_inner: compose lock acquired, checking auth");
        let authed = setup_wizard::check_claude_auth(project)?;
        if !authed {
            anyhow::bail!("{}", MSG_NOT_AUTHENTICATED);
        }
        Ok(())
    })
    .map_err(|e| e.to_string())?;

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
    host_exec: tauri::State<'_, SharedHostExec>,
    oauth: tauri::State<'_, SharedOauth>,
) -> Result<(), String> {
    check_project(&project)?;
    log::info!("start_chat: project={project}");
    let session_arc = state.inner().clone();
    let host_exec_arc = host_exec.inner().clone();
    let oauth_arc = oauth.inner().clone();
    tokio::task::spawn_blocking(move || {
        start_session_inner(
            &project,
            None,
            session_arc,
            host_exec_arc,
            oauth_arc,
            app_handle,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn send_message(
    blocks: Vec<chat::WireContentBlock>,
    display_text: String,
    state: tauri::State<'_, SharedChatSession>,
) -> Result<(), String> {
    // `display_text` is the local-bubble preview; wire-size guard is in `send_message`.
    if display_text.len() > chat::MAX_MESSAGE_LEN {
        return Err("Message too long".to_string());
    }
    log::info!(
        "send_message: blocks={}, display_len={}",
        blocks.len(),
        display_text.len()
    );
    let session_arc = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        let mut session = session_arc.try_lock().map_err(|_| {
            log::info!("send_message: try_lock failed (session busy)");
            "no active session (session is being started)".to_string()
        })?;
        log::info!("send_message: lock acquired, sending");
        session.send_message(&blocks).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn submit_question_answer(
    tool_use_id: String,
    question_idx: usize,
    answer: String,
    state: tauri::State<'_, SharedChatSession>,
) -> Result<(), String> {
    if answer.len() > chat::MAX_ASK_USER_ANSWER_LEN {
        return Err("Answer too long".to_string());
    }
    let session_arc = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        let mut session = session_arc
            .try_lock()
            .map_err(|_| "no active session (session is being started)".to_string())?;
        session
            .submit_question_answer(&tool_use_id, question_idx, &answer)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn stop_chat_inner(session_arc: SharedChatSession) -> Result<(), String> {
    let mut session = session_arc
        .lock()
        .map_err(|e| format!("Lock poisoned: {e}"))?;
    session.interrupt().map_err(|e| e.to_string())
}

/// Tauri command — delegates to [`ChatSession::interrupt`].
#[tauri::command]
async fn stop_chat(state: tauri::State<'_, SharedChatSession>) -> Result<(), String> {
    log::info!("stop_chat: interrupting turn");
    let session_arc = state.inner().clone();
    tokio::task::spawn_blocking(move || stop_chat_inner(session_arc))
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
async fn delete_conversation(project: String, session_id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        check_project(&project)?;
        log::info!("delete_conversation: project={project}");
        history::delete_conversation(&project, &session_id).map_err(|e| {
            log::error!("delete_conversation: error: {e}");
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
    host_exec: tauri::State<'_, SharedHostExec>,
    oauth: tauri::State<'_, SharedOauth>,
) -> Result<(), String> {
    check_project(&project)?;
    history::validate_session_id(&session_id).map_err(|e| e.to_string())?;
    log::info!("resume_conversation: project={project}");
    let session_arc = state.inner().clone();
    let host_exec_arc = host_exec.inner().clone();
    let oauth_arc = oauth.inner().clone();
    tokio::task::spawn_blocking(move || {
        start_session_inner(
            &project,
            Some(&session_id),
            session_arc,
            host_exec_arc,
            oauth_arc,
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
    host_exec: tauri::State<'_, SharedHostExec>,
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

    // Tear down the previous project's `host_exec` worker (best-effort).
    if let Some(ref prev) = previous {
        if prev != &name {
            reconcile::teardown_host_exec_for_project(host_exec.inner(), prev);
        }
    }

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
        switch_project_core(&prev_clone, &new_clone, &rt, &|proj, rt| {
            check_project(proj)?;
            // Lazy build for the destination project (ADR-057).
            if let Err(sanitized) = integrations_cmd::ensure_project_images_built(rt, proj) {
                return Err(format!("Image build failed: {sanitized}"));
            }
            // compose_down(prev) already handled by switch_project_core step 2.
            // Wrap the destination project's render → validate → up sequence in a
            // single transaction so it shares semantics with every other compose
            // callsite (see ADR-066) and benefits from compose_validate_with_retry's
            // virtiofs/9p propagation-lag recovery.
            use crate::types::IntoAnyhow;
            rt.transaction(proj, |rt| -> anyhow::Result<()> {
                containers_cmd::render_and_save_compose(proj, rt).into_anyhow()?;
                speedwave_runtime::runtime::compose_validate_with_retry(rt, proj)?;
                rt.compose_up_recreate(proj)?;
                Ok(())
            })
            .map_err(|e| e.to_string())
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
                Some(prev) => teardown_and_restore(&new_for_teardown, prev, &rt),
                None => teardown_only(&new_for_teardown, &rt).map_or(Ok(()), Err),
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

/// Parses a prefix-encoded CloudStorage TCC error into the `(stable_id, dir)`
/// pair if present, otherwise returns `None`.
///
/// Format produced by `cloudstorage::check_project_readable_or_err`:
/// `"CloudStorage TCC required: {stable_id}|{dir}"`. Tolerates extra suffix
/// text that downstream wrappers may have appended after the dir.
fn parse_cloudstorage_tcc_error(error: &str) -> Option<(&str, &str)> {
    let body = error.strip_prefix(speedwave_runtime::cloudstorage::CLOUDSTORAGE_TCC_PREFIX)?;
    let pipe_idx = body.find('|')?;
    let (stable_id, rest) = body.split_at(pipe_idx);
    // rest starts with '|'
    let dir = rest[1..]
        .split_once(". ")
        .map(|(d, _)| d)
        .unwrap_or(&rest[1..]);
    Some((stable_id, dir))
}

/// Builds the JSON payload for the `project_switch_failed` Tauri event.
///
/// Pure function (no IO) so it can be unit-tested independently of Tauri.
/// When the error string is prefix-encoded with `CLOUDSTORAGE_TCC_PREFIX`,
/// emits structured `error_kind`/`provider`/`project_dir` fields so the
/// frontend can route to the CloudStorage remediation modal. Otherwise
/// emits only `project` + `error`.
pub(crate) fn compute_project_switch_failure_payload(
    previous: Option<&str>,
    full_error: &str,
) -> serde_json::Value {
    use speedwave_runtime::cloudstorage::CloudStorageProvider;

    if let Some((stable_id, dir)) = parse_cloudstorage_tcc_error(full_error) {
        let provider = CloudStorageProvider::from_stable_id(stable_id);
        return serde_json::json!({
            "project": previous,
            "error": full_error,
            "error_kind": "cloudstorage_tcc_required",
            "provider": provider.as_ref().map(|p| p.display_name()),
            "project_dir": dir,
        });
    }

    serde_json::json!({
        "project": previous,
        "error": full_error,
    })
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

    let payload = compute_project_switch_failure_payload(previous.as_deref(), &full_error);

    use tauri::Emitter;
    let _ = app.emit("project_switch_failed", payload);

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
    log::info!(target: "ide_bridge", "cleanup_dead_ide: upstream IDE died, clearing selection");
    bridge.clear_upstream();
    if let Err(e) = config::with_config_lock(|| {
        let mut user_config = config::load_user_config()?;
        user_config.selected_ide = None;
        config::save_user_config(&user_config)
    }) {
        log::warn!("cleanup_dead_ide: failed to persist IDE deselection: {e}");
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
    // Validate against the raw live-port list (pre-dedupe): UI may pick
    // an older-window port that `list_available_ides` collapsed away, but
    // we still want the user to be able to connect to that specific window.
    if !health::is_ide_port_alive(port) {
        log::warn!(
            target: "ide_bridge",
            "select_ide: port {port} is not a live IDE lock"
        );
        return Err(format!(
            "IDE on port {} is not in the detected IDEs list",
            port
        ));
    }
    log::info!(target: "ide_bridge", "select_ide: connecting to {ide_name} on port {port}");

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

/// User-initiated disconnect from the upstream IDE. Clears both the live
/// bridge proxy and the persisted `selected_ide` so a restart will not
/// auto-reconnect.
#[tauri::command]
fn disconnect_ide(state: tauri::State<SharedIdeBridge>) -> Result<(), String> {
    log::info!(target: "ide_bridge", "disconnect_ide: clearing upstream");
    config::with_config_lock(|| {
        let mut user_config = config::load_user_config()?;
        user_config.selected_ide = None;
        config::save_user_config(&user_config)
    })
    .map_err(|e| e.to_string())?;
    let guard = state
        .lock()
        .map_err(|e| format!("Bridge mutex poisoned: {e}"))?;
    if let Some(bridge) = guard.as_ref() {
        bridge.clear_upstream();
    }
    Ok(())
}

use diagnostics::export_diagnostics;
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

/// Wire-format for the `plugin_bridge_get_credentials` Tauri response. Mirror:
/// `PluginBridgeCredentials` in `desktop/src/src/app/models/plugin.ts`.
#[derive(serde::Serialize)]
struct PluginBridgeCredentialsResponse {
    slug: String,
    url: String,
    token: String,
}

/// Wire-format for `plugin_bridge_get_status`. Discriminated on `running`.
/// Mirror: `PluginBridgeStatus` in `desktop/src/src/app/models/plugin.ts`.
#[derive(serde::Serialize)]
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

/// mcp-os watchdog thread.
fn start_mcp_os_watchdog(mcp_os: SharedMcpOs, app_handle: tauri::AppHandle) {
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
                                reconcile::reconcile_compose_port(&app_handle);
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
fn ensure_mcp_os_running(mcp_os: &SharedMcpOs, app_handle: &tauri::AppHandle) {
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
        match speedwave_runtime::mcp_os_process::McpOsProcess::spawn(&script_str) {
            Ok(proc) => {
                log::info!("ensure_mcp_os_running: started (port {})", proc.port());
                *guard = Some(proc);
                drop(guard); // release before spawning watchdog thread
                             // Narrow TOCTOU: factory_reset could set WATCHDOG_STOP=true
                             // between drop(guard) and the store below, causing a no-op
                             // watchdog loop on None. Harmless in single-user desktop app
                             // — the watchdog exits on the next iteration when it sees None.
                WATCHDOG_STOP.store(false, Ordering::Relaxed);
                start_mcp_os_watchdog(mcp_os.clone(), app_handle.clone());
            }
            Err(e) => log::error!("ensure_mcp_os_running: spawn failed: {e}"),
        }
    }
}

/// Spawn the project's `host_exec` worker if enabled and not running.
/// Writes the chmod-600 config snapshot first. Returns `true` on fresh spawn.
pub(crate) fn ensure_host_exec_running(host_exec: &SharedHostExec, project: &str) -> bool {
    let mut map = match host_exec.lock() {
        Ok(g) => g,
        Err(e) => {
            log::error!("ensure_host_exec_running: map mutex poisoned: {e}");
            return false;
        }
    };
    if let Some(proc) = map.get(project) {
        if proc.is_alive() {
            return false; // already running and healthy
        }
        // A dead-but-still-mapped worker — drop it; we'll respawn below.
        log::warn!("host_exec[{project}]: stale worker in the map — replacing");
        if let Some(mut dead) = map.remove(project) {
            let _ = dead.stop();
            dead.cleanup_files();
        }
    }

    // Resolve project dir + config (user-config only).
    let user_config = match config::load_user_config() {
        Ok(c) => c,
        Err(e) => {
            log::warn!("ensure_host_exec_running: cannot load user config: {e}");
            return false;
        }
    };
    let project_dir = match user_config.find_project(project) {
        Some(p) => std::path::PathBuf::from(&p.dir),
        None => {
            log::warn!("ensure_host_exec_running: unknown project '{project}'");
            return false;
        }
    };
    let resolved = config::resolve_integrations(&project_dir, &user_config, project);
    if !resolved.host_exec {
        log::debug!("ensure_host_exec_running: host_exec disabled for '{project}' — not spawning");
        return false;
    }

    // Write chmod-600 config snapshot (may hold env-value secrets, ADR-054).
    let state_dir = speedwave_runtime::host_exec::host_exec_project_dir(
        speedwave_runtime::consts::data_dir(),
        project,
    );
    if let Err(e) = std::fs::create_dir_all(&state_dir) {
        log::warn!("ensure_host_exec_running: cannot create state dir for '{project}': {e}");
        return false;
    }
    let snapshot = config::host_exec_config_snapshot(&project_dir, &resolved.host_exec_commands);
    let config_path = state_dir.join(speedwave_runtime::consts::HOST_EXEC_CONFIG_FILE);
    if let Err(e) = write_host_exec_config_snapshot(&config_path, &snapshot) {
        log::warn!("ensure_host_exec_running: cannot write config snapshot for '{project}': {e}");
        return false;
    }

    let script = match speedwave_runtime::build::resolve_host_exec_script() {
        Some(s) => s.to_string_lossy().to_string(),
        None => {
            log::warn!(
                "ensure_host_exec_running: host_exec worker script not found — \
                 host_exec will be unavailable for '{project}'"
            );
            return false;
        }
    };
    match HostExecProcess::spawn_in(
        project,
        &project_dir,
        &script,
        recovered_host_path(),
        speedwave_runtime::consts::data_dir(),
    ) {
        Ok(proc) => {
            log::info!("host_exec[{project}]: started (port {})", proc.port());
            map.insert(project.to_string(), proc);
            drop(map); // release before touching the watchdog flag
            HOST_EXEC_WATCHDOG_STOP.store(false, Ordering::Relaxed);
            true
        }
        Err(e) => {
            log::error!("host_exec[{project}]: spawn failed: {e}");
            false
        }
    }
}

// (`is_service_enabled` lives on `ResolvedIntegrationsConfig` in
// `speedwave-runtime::config` — used here and in the CLI's
// `maybe_spawn_oauth_worker` so the match arms stay in one place.)

/// Spawn the per-project `oauth` worker on demand. No-op if no project
/// integration with `uses_oauth_refresh = true` is enabled, or if the worker
/// is already running. Returns true if a new worker was started this call.
pub(crate) fn ensure_oauth_running(oauth_arc: &SharedOauth, project: &str) -> bool {
    let mut map = match oauth_arc.lock() {
        Ok(g) => g,
        Err(e) => {
            log::error!("ensure_oauth_running: map mutex poisoned: {e}");
            return false;
        }
    };
    if map.contains_key(project) {
        return false;
    }

    // Check if any OAuth-consuming integration is enabled for this project.
    let user_config = match config::load_user_config() {
        Ok(c) => c,
        Err(e) => {
            log::warn!("ensure_oauth_running: cannot load user config: {e}");
            return false;
        }
    };
    let project_dir = match user_config.find_project(project) {
        Some(p) => std::path::PathBuf::from(&p.dir),
        None => {
            log::warn!("ensure_oauth_running: unknown project '{project}'");
            return false;
        }
    };
    let resolved = config::resolve_integrations(&project_dir, &user_config, project);

    // List of enabled OAuth-consuming integrations (drives bearer-map).
    let oauth_consumers: Vec<&'static str> = speedwave_runtime::consts::TOGGLEABLE_MCP_SERVICES
        .iter()
        .filter(|d| {
            d.uses_oauth_refresh && resolved.is_service_enabled(d.config_key).unwrap_or(false)
        })
        .map(|d| d.config_key)
        .collect();
    if oauth_consumers.is_empty() {
        log::debug!(
            "ensure_oauth_running: no oauth-consuming integration enabled for '{project}' — not spawning"
        );
        return false;
    }

    let script = match speedwave_runtime::build::resolve_oauth_script() {
        Some(s) => s.to_string_lossy().to_string(),
        None => {
            log::warn!(
                "ensure_oauth_running: oauth worker script not found — \
                 OAuth refresh will be unavailable for '{project}'"
            );
            return false;
        }
    };
    match speedwave_runtime::oauth_process::OauthProcess::spawn_in(
        project,
        &script,
        speedwave_runtime::consts::data_dir(),
        &oauth_consumers,
    ) {
        Ok(proc) => {
            log::info!("oauth[{project}]: started (port {})", proc.port());
            map.insert(project.to_string(), proc);
            drop(map);
            OAUTH_WATCHDOG_STOP.store(false, Ordering::Relaxed);
            true
        }
        Err(e) => {
            log::error!("oauth[{project}]: spawn failed: {e}");
            false
        }
    }
}

/// Decide which per-project workers in the map are unhealthy, respawn them,
/// and return the names of those that should have their consumer containers
/// recreated. Generic over [`WatchdogWorker`] so the same selection logic
/// drives both the oauth and host_exec watchdogs (and is unit-testable with
/// a fake worker — see `FakeWorker` in this file's tests).
fn sweep_per_project_workers<P>(
    workers: &mut std::collections::HashMap<String, P>,
    log_prefix: &str,
) -> Vec<String>
where
    P: WatchdogWorker,
{
    if workers.is_empty() {
        return Vec::new();
    }
    let names: Vec<String> = workers.keys().cloned().collect();
    let mut respawned = Vec::new();
    for name in names {
        let alive = workers.get(&name).map(|p| p.is_alive()).unwrap_or(false);
        if alive {
            continue;
        }
        if let Some(proc) = workers.get_mut(&name) {
            log::warn!("{log_prefix}: worker for '{name}' unhealthy — respawning");
            match proc.respawn() {
                Ok(port) => {
                    log::info!("{log_prefix}: respawned '{name}' (port {port})");
                    respawned.push(name);
                }
                Err(e) => {
                    log::error!("{log_prefix}: respawn for '{name}' failed: {e}");
                }
            }
        }
    }
    respawned
}

/// Trait abstracting the watchdog's view of a managed worker. Implemented by
/// every host-side worker manager that is supervised by a watchdog —
/// `OauthProcess` and `HostExecProcess` are the per-project ones today.
///
pub(crate) trait WatchdogWorker {
    fn is_alive(&self) -> bool;
    fn respawn(&mut self) -> anyhow::Result<u16>;
}

impl WatchdogWorker for speedwave_runtime::oauth_process::OauthProcess {
    fn is_alive(&self) -> bool {
        speedwave_runtime::oauth_process::OauthProcess::is_alive(self)
    }
    fn respawn(&mut self) -> anyhow::Result<u16> {
        speedwave_runtime::oauth_process::OauthProcess::respawn(self)
    }
}

impl WatchdogWorker for speedwave_runtime::host_exec_process::HostExecProcess {
    fn is_alive(&self) -> bool {
        speedwave_runtime::host_exec_process::HostExecProcess::is_alive(self)
    }
    fn respawn(&mut self) -> anyhow::Result<u16> {
        speedwave_runtime::host_exec_process::HostExecProcess::respawn(self)
    }
}

/// Shared watchdog loop for per-project host-side workers (oauth, host_exec).
/// Polls every 30 s; under the map mutex, calls [`sweep_per_project_workers`]
/// to respawn dead workers; releases the lock; then recreates each respawned
/// project's hub containers so they observe the new worker port (e.g. a fresh
/// `WORKER_OAUTH_URL` or `WORKER_HOST_EXEC_URL`).
///
/// Stops cleanly when `stop_flag` is set (used by app exit cleanup). Catches
/// panics from `recreate_project_containers_if_running` so a single bad
/// project does not kill the watchdog thread silently.
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
            // Respawn under the lock; defer container recreate until after we release it
            // so consumer workers see the new WORKER_<name>_URL.
            let respawned: Vec<String> = {
                let mut map = match workers.lock() {
                    Ok(g) => g,
                    Err(e) => {
                        log::error!("{log_prefix}: map mutex poisoned: {e}");
                        break;
                    }
                };
                sweep_per_project_workers(&mut map, log_prefix)
            };
            // Lock released — recreate containers so consumers pick up the new port.
            // Catch panics so a single bad project does not kill the watchdog thread silently.
            for name in respawned {
                let n = name.clone();
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    host_exec_cmd::recreate_project_containers_if_running(&n);
                }));
                if let Err(payload) = result {
                    let msg = speedwave_runtime::log_sanitizer::panic_payload_to_string(&*payload);
                    log::error!("{log_prefix}: recreate panicked for '{name}': {msg}");
                }
            }
        }
        log::info!("{log_prefix}: stopped");
    });
}

/// Per-project `oauth` watchdog — 30s checks, shared loop with host_exec.
fn start_oauth_watchdog(oauth_arc: SharedOauth) {
    start_per_project_watchdog(oauth_arc, &OAUTH_WATCHDOG_STOP, "oauth watchdog");
}

/// Per-project `host_exec` watchdog — 30s checks, shared loop with oauth.
fn start_host_exec_watchdog(host_exec: SharedHostExec) {
    start_per_project_watchdog(host_exec, &HOST_EXEC_WATCHDOG_STOP, "host_exec watchdog");
}

/// Shows the audit-failure dialog and terminates the process. Returns
/// only via `process::exit`. Caller has already logged the body.
fn show_audit_failure_dialog_and_exit(app: &tauri::AppHandle, body: String) -> ! {
    use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
    let _ = app
        .dialog()
        .message(body)
        .title("Plugin verification failed")
        .kind(MessageDialogKind::Error)
        .blocking_show();
    std::process::exit(1);
}

/// Formats the per-plugin failures from `plugin::audit_all` into a
/// user-actionable dialog message. Tells the user what failed and how
/// to recover via CLI/manual cleanup — Settings UI is unreachable
/// while the audit fails.
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
    let queue_service = speedwave_runtime::session::QueuedMessageService::new();
    let msg_store_registry = subscribe_cmd::MsgStoreRegistry::new();
    // Meeting-transcription stores (ADR-056). Active sessions live in memory;
    // both stores walk the disk lazily on first access. `transcript_drivers`
    // maps an in-flight recording to its stop signal.
    let transcript_store: transcription_cmd::TranscriptStoreHandle =
        Arc::new(speedwave_runtime::transcription::TranscriptStore::new());
    let model_store: transcription_cmd::ModelStoreHandle =
        Arc::new(speedwave_runtime::transcription::ModelStore::new());
    let transcript_drivers: transcription_cmd::DriversHandle =
        Arc::new(std::sync::Mutex::new(std::collections::HashMap::new()));
    let transcript_forwarders: transcription_cmd::ForwardersHandle =
        Arc::new(std::sync::Mutex::new(std::collections::HashSet::new()));

    // Shared state: IDE Bridge, host-bridged plugins, mcp-os, per-project host_exec
    // workers, per-project oauth workers, auto-check handle.
    let ide_bridge: SharedIdeBridge = Arc::new(Mutex::new(None));
    let plugin_bridges: SharedPluginBridges =
        Arc::new(Mutex::new(std::collections::HashMap::new()));
    let mcp_os: SharedMcpOs = Arc::new(Mutex::new(None));
    let host_exec: SharedHostExec = Arc::new(Mutex::new(std::collections::HashMap::new()));
    let oauth: SharedOauth = Arc::new(Mutex::new(std::collections::HashMap::new()));
    let auto_check_handle: SharedAutoCheckHandle = Arc::new(Mutex::new(None));

    // Publish the plugin-bridges map globally so compose-render call sites
    // in setup_wizard / containers_cmd can read it without taking tauri::State
    // (they are free functions and reachable from CLI helpers too).
    reconcile::set_global_plugin_bridges(plugin_bridges.clone());

    let tray_available = Arc::new(AtomicBool::new(false));
    let tray_available_setup = tray_available.clone();
    let tray_available_close = tray_available.clone();

    // One context struct → one clone per exit path instead of N parallel Arc clones.
    let cleanup_ctx = ExitCleanupContext {
        ide_bridge: ide_bridge.clone(),
        plugin_bridges: plugin_bridges.clone(),
        mcp_os: mcp_os.clone(),
        host_exec: host_exec.clone(),
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
        .manage(plugin_bridges.clone())
        .manage(mcp_os.clone())
        .manage(host_exec.clone())
        .manage(oauth.clone())
        .manage(queue_service.clone())
        .manage(msg_store_registry.clone())
        .manage(transcript_store.clone())
        .manage(model_store.clone())
        .manage(transcript_drivers.clone())
        .manage(transcript_forwarders.clone())
        .manage(tray_state)
        .setup(move |app| {
            // Fixed at Trace — no user-facing toggle.
            log::set_max_level(log::LevelFilter::Trace);
            logging_cmd::init_bundle_identifier(app.config().identifier.clone());
            if let Err(e) = speedwave_runtime::config::migrate_drop_log_level_in(
                speedwave_runtime::consts::data_dir(),
            ) {
                log::warn!("config migration: {e:#}");
            }

            clipboard_bridge::spawn(app.handle().clone());

            // Hard-fail on tampered plugins. `plugin::audit_all` re-verifies
            // every plugin under `~/.speedwave/plugins/`; failures are
            // collected and shown to the user in one dialog. Recovery
            // path is the CLI (`speedwave plugin remove <slug>`) or
            // manual deletion — Settings UI is behind this gate.
            //
            // Hard-fail semantics: the dialog shows the user every failed
            // plugin synchronously, then the process exits. Returning
            // `Ok(())` from `setup` would let Tauri continue starting
            // the webview and registering command handlers — a tampered
            // plugin would still be inert (`#[tauri::command]` callers
            // go through the verified-only command gates), but the
            // command surface would be live for unrelated calls. We
            // refuse to bring the rest of the app online at all: the
            // dialog is shown via the OS-native blocking path and the
            // process exits the moment the user dismisses it.
            if let Err(failures) = speedwave_runtime::plugin::audit_all() {
                let body = format_audit_failure_message(&failures);
                log::error!("plugin audit failed:\n{}", body);
                // Diverges (`-> !`) — `process::exit` is the last call.
                // No `Ok(())` / `Err(...)` follows because Tauri must
                // not bring up the webview / command surface for a
                // tampered plugin set.
                show_audit_failure_dialog_and_exit(app.handle(), body);
            }

            // Rotated-log cleanup is owned by `RotationStrategy::KeepSome(10)` —
            // tauri-plugin-log prunes on every rotation. No separate timer needed.

            // Recover the user's login-shell PATH once, on a background thread
            // so a slow shell rc doesn't delay `setup()`. The `host_exec`
            // worker (and its recipes) need this — a GUI-launched app has only
            // a stunted PATH. Idempotent; `recovered_host_path()` returns the
            // cached value (or computes it lazily) afterwards. ADR-054 §PATH.
            std::thread::spawn(host_path::init_recovered_host_path);

            if setup_started {
                // Sanitise any v1 SharePoint secrets still in the worker-mounted
                // token dir (refresh_token / client_id / tenant_id). Best-effort,
                // idempotent. Users with v1 state see the "Re-authorize SharePoint"
                // banner — see legacy_token_cleanup module docs.
                let cleaned =
                    speedwave_runtime::legacy_token_cleanup::run_legacy_token_cleanup_at_startup();
                if cleaned > 0 {
                    log::info!("legacy_token_cleanup: {cleaned} project(s) sanitised");
                }

                // Start IDE Bridge
                init_and_start_ide_bridge(&ide_bridge, app.handle());

                // Start a `PluginHostBridge` for every verified plugin whose
                // manifest declares a `host_bridge` block. Always on,
                // mirroring IDE Bridge's "passive listener" behavior — when
                // the corresponding plugin is disabled in a project the
                // bridge sits idle on its loopback port.
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

                // Start the per-project host_exec watchdog. No worker is
                // spawned here — host_exec is per-project and spawned on
                // demand (ensure_host_exec_running), e.g. when a chat starts
                // for a project that has it enabled (ADR-054). The watchdog
                // simply respawns any that die.
                HOST_EXEC_WATCHDOG_STOP.store(false, Ordering::Relaxed);
                start_host_exec_watchdog(host_exec.clone());
                OAUTH_WATCHDOG_STOP.store(false, Ordering::Relaxed);
                start_oauth_watchdog(oauth.clone());
            } else {
                log::info!("setup not started, deferring IDE Bridge / mcp-os / host_exec / oauth / link_cli until setup completes");
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

                #[cfg(target_os = "windows")]
                if let Err(e) = setup_wizard::ensure_wslconfig_vpn_compat() {
                    log::warn!(".wslconfig VPN-compat migration failed: {e}");
                }

                if let Err(e) = setup_wizard::link_cli() {
                    log::warn!("CLI re-link on startup failed: {e}");
                }
                reconcile::reconcile_bundle_update(app.handle());
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
                                    log::info!("tray: update available: {}", info.version);
                                    use tauri::Emitter;
                                    if let Err(e) = app_clone.emit("update_available", &info) {
                                        log::error!(
                                            "tray: failed to emit update_available event: {e}"
                                        );
                                    }
                                }
                                Ok(updater::UpdateCheckOutcome::UpToDate) => {
                                    log::info!("tray: already up to date");
                                }
                                Err(e) => {
                                    log::error!("tray: check failed: {e}");
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
                    "toggle_beta" => {
                        let app_clone = app.clone();
                        tauri::async_runtime::spawn(async move {
                            let current =
                                app_clone.state::<tray::TrayMenuState>().beta_enabled();
                            if let Err(e) =
                                ui_prefs_cmd::apply_beta_toggle_inner(&app_clone, !current).await
                            {
                                log::error!("tray: beta toggle failed: {e}");
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
                    tray_available_setup.store(true, Ordering::Relaxed);
                }
                Err(e) => {
                    // Tray creation failed. Window is already visible
                    // (tauri.conf.json: visible=true), so no fallback needed.
                    log::error!("tray: failed to create system tray: {e}");
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
            containers_cmd::get_default_base_url,
            containers_cmd::list_anthropic_models,
            containers_cmd::get_default_anthropic_model_label,
            containers_cmd::update_llm_config,
            llm_cmd::discover_llm_models,
            // Authentication
            auth_commands::save_api_key,
            auth_commands::delete_api_key,
            auth_commands::get_auth_status,
            oauth_login_cmd::start_oauth_login,
            // URL opener
            url_validation::open_url,
            // Platform
            url_validation::get_platform,
            auth_commands::get_auth_command,
            // Chat
            start_chat,
            send_message,
            paste_cmd::save_pasted_image,
            submit_question_answer,
            stop_chat,
            retry_cmd::retry_last_turn,
            // Queued messages (ADR-045)
            queue_cmd::queue_message,
            queue_cmd::cancel_queued_message,
            queue_cmd::peek_queued_message,
            // JSON-Patch stream protocol (ADR-042/043)
            subscribe_cmd::subscribe_session,
            // Meeting transcription (ADR-056)
            transcription_cmd::transcription_enabled,
            transcription_cmd::set_transcription_enabled,
            transcription_cmd::get_transcription_config,
            transcription_cmd::set_transcription_config,
            transcription_cmd::transcription_capabilities,
            transcription_cmd::list_audio_sources,
            transcription_cmd::start_transcription,
            transcription_cmd::stop_transcription,
            transcription_cmd::subscribe_transcript,
            transcription_cmd::list_transcripts,
            transcription_cmd::get_transcript,
            transcription_cmd::delete_transcript,
            transcription_cmd::discard_transcript_audio,
            transcription_cmd::relabel_speaker,
            transcription_cmd::get_transcript_markdown,
            transcription_cmd::list_transcription_models,
            transcription_cmd::download_transcription_model,
            transcription_cmd::delete_transcription_model,
            // Chat history
            list_conversations,
            get_conversation,
            delete_conversation,
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
            container_logs_cmd::get_host_exec_logs,
            container_logs_cmd::get_claude_session_logs,
            container_logs_cmd::get_all_logs,
            // IDE Bridge
            list_available_ides,
            select_ide,
            disconnect_ide,
            get_selected_ide,
            get_bridge_status,
            // Per-plugin host bridges (manifest-declared)
            plugin_bridge_get_credentials,
            plugin_bridge_get_status,
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
            // UI preferences (ADR-058)
            ui_prefs_cmd::get_beta_enabled,
            ui_prefs_cmd::set_beta_enabled,
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
            // Redmine API proxy
            redmine_api_cmd::validate_redmine_credentials,
            redmine_api_cmd::fetch_redmine_enumerations,
            // host_exec (ADR-054): Integrations-tab settings commands
            // (status / toggle / edit the whitelist / resolve an executable for
            // the "browse…" picker). No per-call confirmation — enabling
            // host_exec is the consent.
            host_exec_cmd::get_host_exec,
            host_exec_cmd::set_host_exec_enabled,
            host_exec_cmd::host_exec_save_settings,
            host_exec_cmd::host_exec_load_settings,
            host_exec_cmd::host_exec_resolve_executable,
            // Plugins
            plugin_cmd::get_plugins,
            plugin_cmd::peek_plugin_manifest,
            plugin_cmd::install_plugin,
            plugin_cmd::remove_plugin,
            plugin_cmd::set_plugin_enabled,
            plugin_cmd::save_plugin_credentials,
            plugin_cmd::delete_plugin_credentials,
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
            // Meeting-transcription TCC (ADR-056) — deep-links to the macOS
            // Microphone / Audio Recording privacy panes for permission recovery.
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
                // Safe on Windows too: the window is typically already being
                // destroyed when ExitRequested fires (tray-less setups),
                // making this a harmless no-op. Do NOT gate this to macOS —
                // a `#[cfg(target_os = "macos")]` guard would re-introduce
                // the beachball if macOS ever reorders event delivery, and
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
                //
                // Fallback: on macOS, Cmd+Q / app-menu-Quit delivers
                // `applicationWillTerminate`, which tao maps to
                // `Event::LoopDestroyed`, which tauri-runtime-wry maps
                // directly to `RunEvent::Exit` — bypassing
                // `RunEvent::ExitRequested` and (for a hidden tray-mode
                // window) `WindowEvent::Destroyed` entirely. If neither
                // earlier arm ran, the slot is empty here and the Lima VM
                // would be orphaned. Spawn cleanup inline as a last resort.
                // `CLEANUP_ONCE` inside `run_exit_cleanup` makes this
                // idempotent with the other entry points.
                //
                // NOTE: `exit_arm_runs_cleanup_when_handle_slot_is_empty` in
                // the tests below asserts that this arm contains the literal
                // strings `run_exit_cleanup(&cleanup_ctx_runevent)` and
                // `hide_main_window(app_handle)` — if you rename either
                // identifier, update the test assertions too.
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use config::{ProjectUserEntry, SpeedwaveUserConfig};

    #[test]
    fn plugin_bridge_credentials_response_wire_format() {
        let resp = PluginBridgeCredentialsResponse {
            slug: "figma".into(),
            url: "ws://127.0.0.1:60123/".into(),
            token: "uuid-token".into(),
        };
        let expected = serde_json::json!({
            "slug": "figma",
            "url": "ws://127.0.0.1:60123/",
            "token": "uuid-token",
        });
        assert_eq!(serde_json::to_value(&resp).unwrap(), expected);
    }

    #[test]
    fn plugin_bridge_status_response_running_wire_format() {
        let resp = PluginBridgeStatusResponse::Running {
            slug: "figma".into(),
            running: true,
            port: 60123,
            paired: true,
            partner_connected: true,
            display_name: "Figma Bridge".into(),
        };
        let expected = serde_json::json!({
            "slug": "figma",
            "running": true,
            "port": 60123,
            "paired": true,
            "partner_connected": true,
            "display_name": "Figma Bridge",
        });
        assert_eq!(serde_json::to_value(&resp).unwrap(), expected);
    }

    #[test]
    fn plugin_bridge_status_response_not_running_wire_format() {
        let resp = PluginBridgeStatusResponse::NotRunning {
            slug: "figma".into(),
            running: false,
        };
        let expected = serde_json::json!({
            "slug": "figma",
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

    // ────────────────────────────────────────────────────────────────────
    // sweep_per_project_workers — covers the watchdog selection logic without
    // spawning real subprocesses. The fake implements WatchdogWorker; the
    // helper is reused by both oauth and host_exec watchdogs in production.
    // ────────────────────────────────────────────────────────────────────

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
            // After a successful respawn the fake reports alive=true so a
            // re-sweep wouldn't pick it again (matches real OauthProcess behaviour).
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
        // Bug class: a break-early regression would skip the second project.
        let mut map = std::collections::HashMap::new();
        map.insert("a".to_string(), FakeWorker::new(false, Ok(1111)));
        map.insert("b".to_string(), FakeWorker::new(false, Ok(2222)));
        let mut respawned = sweep_per_project_workers(&mut map, "test");
        respawned.sort();
        assert_eq!(respawned, vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn sweep_per_project_workers_failed_respawn_excluded_from_respawned() {
        // Bug class: caller would recreate containers for a project whose
        // worker actually didn't come back up — wasted compose churn.
        let mut map = std::collections::HashMap::new();
        map.insert(
            "bad".to_string(),
            FakeWorker::new(false, Err("spawn failed".into())),
        );
        map.insert("good".to_string(), FakeWorker::new(false, Ok(3333)));
        let respawned = sweep_per_project_workers(&mut map, "test");
        assert_eq!(respawned, vec!["good".to_string()]);
        // The failed worker WAS attempted (so we don't silently skip retries).
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
            .find("rt.transaction(")
            .expect("start_session_inner must call rt.transaction for the per-project lock");
        let auth_pos = body
            .find("setup_wizard::check_claude_auth")
            .expect("start_session_inner must call check_claude_auth");

        assert!(
            compose_pos < auth_pos,
            "compose lock must be acquired BEFORE check_claude_auth"
        );
    }

    #[test]
    fn start_session_inner_waits_for_image_readiness_before_compose_paths() {
        // Race guard: both recreate_project_containers_if_running (fresh
        // host_exec/oauth branch) and check_claude_auth → ensure_exec_healthy
        // can call compose_up_recreate. Gate must come BEFORE the if-block
        // (covers fresh-worker branch) AND BEFORE check_claude_auth (covers
        // the always-runs path).
        let source = include_str!("main.rs");
        let body = extract_fn_body(source, "fn start_session_inner(");

        let ensure_pos = body
            .find("containers_cmd::ensure_images_ready")
            .expect("start_session_inner must call ensure_images_ready");
        let recreate_pos = body
            .find("recreate_project_containers_if_running")
            .expect("start_session_inner must reach recreate_project_containers_if_running");
        let auth_pos = body
            .find("setup_wizard::check_claude_auth")
            .expect("start_session_inner must reach check_claude_auth");

        assert!(
            ensure_pos < recreate_pos,
            "ensure_images_ready must come BEFORE recreate_project_containers_if_running"
        );
        assert!(
            ensure_pos < auth_pos,
            "ensure_images_ready must come BEFORE check_claude_auth"
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
    fn submit_question_answer_uses_spawn_blocking() {
        let source = include_str!("main.rs");
        let body = extract_fn_body(source, "async fn submit_question_answer(");
        assert!(
            body.contains("spawn_blocking"),
            "submit_question_answer must use spawn_blocking to avoid blocking the main thread"
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
    fn submit_question_answer_acquires_lock_inside_spawn_blocking() {
        let source = include_str!("main.rs");
        let body = extract_fn_body(source, "async fn submit_question_answer(");
        let spawn_pos = body
            .find("spawn_blocking")
            .expect("submit_question_answer must use spawn_blocking");
        let lock_pos = body
            .find(".try_lock()")
            .expect("submit_question_answer must acquire the session lock via try_lock");
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
            .find("display_text.len()")
            .expect("send_message must check display_text length");
        let spawn_pos = body
            .find("spawn_blocking")
            .expect("send_message must use spawn_blocking");
        assert!(
            len_pos < spawn_pos,
            "display_text length check must come BEFORE spawn_blocking for fail-fast validation"
        );
    }

    #[test]
    fn submit_question_answer_validates_length_before_spawn_blocking() {
        let source = include_str!("main.rs");
        let body = extract_fn_body(source, "async fn submit_question_answer(");
        let len_pos = body
            .find("answer.len()")
            .expect("submit_question_answer must check answer length");
        let spawn_pos = body
            .find("spawn_blocking")
            .expect("submit_question_answer must use spawn_blocking");
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
    fn submit_question_answer_handles_join_error() {
        let source = include_str!("main.rs");
        let body = extract_fn_body(source, "async fn submit_question_answer(");
        assert!(
            body.contains(".await")
                && body.contains("map_err(|e| e.to_string())")
                && body.matches("map_err").count() >= 2,
            "submit_question_answer must handle JoinError from spawn_blocking via .await.map_err"
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
            transcription: None,
            ui: None,
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
            transcription: None,
            ui: None,
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

    /// Regression guard: the `RunEvent::Exit` arm must have a fallback that
    /// calls `run_exit_cleanup` when the handle slot is empty. On macOS,
    /// Cmd+Q / app-menu-Quit delivers `applicationWillTerminate`, which tao
    /// maps to `Event::LoopDestroyed`, which tauri-runtime-wry maps directly
    /// to `RunEvent::Exit` — bypassing `RunEvent::ExitRequested` and (for a
    /// hidden tray-mode window) `WindowEvent::Destroyed`. Without the
    /// fallback, the slot stays empty, nothing is joined, and the Lima VM
    /// is orphaned after quit.
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

    // -- stop_chat_inner tests --

    #[test]
    fn stop_chat_inner_without_active_session_errors() {
        // interrupt() requires an active stdin (shared_stdin=Some). A freshly
        // constructed ChatSession has no stdin, so interrupt — and therefore
        // stop_chat_inner — returns "no active session" instead of panicking.
        let session_arc: SharedChatSession = Arc::new(Mutex::new(ChatSession::new("test-project")));
        let err = stop_chat_inner(session_arc).expect_err("expected error on idle session");
        assert!(
            err.contains("no active session"),
            "expected 'no active session' in error, got: {err}"
        );
    }

    #[test]
    fn stop_chat_inner_poisoned_mutex_returns_lock_poisoned_error() {
        let session_arc: SharedChatSession = Arc::new(Mutex::new(ChatSession::new("test-project")));
        let arc_clone = session_arc.clone();
        let _ = std::thread::spawn(move || {
            let _guard = arc_clone.lock().unwrap();
            panic!("poison the mutex");
        })
        .join();
        let result = stop_chat_inner(session_arc);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            err.contains("Lock poisoned"),
            "expected 'Lock poisoned' in error, got: {err}"
        );
    }

    #[test]
    fn stop_chat_uses_spawn_blocking() {
        let source = include_str!("main.rs");
        let body = extract_fn_body(source, "async fn stop_chat(");
        assert!(
            body.contains("spawn_blocking"),
            "stop_chat must use spawn_blocking to avoid blocking the main thread"
        );
    }

    // -- compute_project_switch_failure_payload tests --

    #[test]
    fn payload_for_generic_error_omits_cloudstorage_fields() {
        let payload =
            compute_project_switch_failure_payload(Some("acme"), "Container restore failed");
        assert_eq!(payload["project"], "acme");
        assert_eq!(payload["error"], "Container restore failed");
        assert!(payload.get("error_kind").is_none());
        assert!(payload.get("provider").is_none());
        assert!(payload.get("project_dir").is_none());
    }

    #[test]
    fn payload_for_cloudstorage_error_includes_structured_fields() {
        let err = "CloudStorage TCC required: one_drive|/Users/alice/Library/CloudStorage/OneDrive-Personal/p";
        let payload = compute_project_switch_failure_payload(Some("acme"), err);
        assert_eq!(payload["error_kind"], "cloudstorage_tcc_required");
        assert_eq!(payload["provider"], "OneDrive");
        assert_eq!(
            payload["project_dir"],
            "/Users/alice/Library/CloudStorage/OneDrive-Personal/p"
        );
        assert_eq!(payload["error"], err);
        assert_eq!(payload["project"], "acme");
    }

    #[test]
    fn payload_for_cloudstorage_error_with_appended_suffix_extracts_dir_only() {
        let err = "CloudStorage TCC required: dropbox|/Users/alice/Dropbox/p. Config rollback failed: nope";
        let payload = compute_project_switch_failure_payload(None, err);
        assert_eq!(payload["error_kind"], "cloudstorage_tcc_required");
        assert_eq!(payload["provider"], "Dropbox");
        assert_eq!(payload["project_dir"], "/Users/alice/Dropbox/p");
    }

    #[test]
    fn payload_for_cloudstorage_error_unknown_stable_id_emits_null_provider() {
        let err = "CloudStorage TCC required: future_provider|/some/path";
        let payload = compute_project_switch_failure_payload(None, err);
        assert_eq!(payload["error_kind"], "cloudstorage_tcc_required");
        assert!(payload["provider"].is_null());
        assert_eq!(payload["project_dir"], "/some/path");
    }

    #[test]
    fn payload_with_null_previous_serializes_as_null() {
        let payload = compute_project_switch_failure_payload(None, "boom");
        assert!(payload["project"].is_null());
    }

    #[test]
    fn payload_for_malformed_prefix_without_pipe_falls_back_to_generic() {
        let err = "CloudStorage TCC required: just_a_stable_id_without_pipe";
        let payload = compute_project_switch_failure_payload(None, err);
        assert!(payload.get("error_kind").is_none());
        assert!(payload.get("provider").is_none());
        assert!(payload.get("project_dir").is_none());
    }
}
