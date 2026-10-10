use std::sync::{Arc, Mutex};

use crate::chat::{self, ChatSession};
use crate::chat_registry::{self, SharedChatSessions};
use crate::control_channel::{
    self, ContextUsage, ControlHandle, ControlQuery, ModelSwitchOutcome, PlanUsage,
    SessionInfoState,
};
use crate::project_cmd::clear_chat_sessions;
use crate::reconcile::SharedOauth;
use crate::types::check_project;
use crate::{containers_cmd, ensure_oauth_running};
use crate::{setup_wizard, MSG_NOT_AUTHENTICATED};

const MSG_SESSION_KEPT: &str = "the running chat session was kept";

fn kept_session_error(e: impl std::fmt::Display) -> String {
    format!("{MSG_SESSION_KEPT}: {e}")
}

fn failure_before_swap(session_kept: bool, e: impl std::fmt::Display) -> String {
    if session_kept {
        kept_session_error(e)
    } else {
        e.to_string()
    }
}

fn start_session_inner(
    project: &str,
    tab_id: &str,
    resume_session_id: Option<&str>,
    model_override: Option<&str>,
    registry: SharedChatSessions,
    oauth_arc: SharedOauth,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let entry = registry
        .prepare(tab_id, project)
        .map_err(kept_session_error)?;
    let _serialize = entry
        .start_serialize
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);

    registry
        .check_transcript_free(tab_id, resume_session_id)
        .map_err(kept_session_error)?;

    let oauth_just_started = ensure_oauth_running(&oauth_arc, project);

    containers_cmd::ensure_images_ready().map_err(kept_session_error)?;

    let recreated =
        oauth_just_started && containers_cmd::recreate_project_containers_if_running(project);

    log::info!("acquiring compose lock");
    let rt = speedwave_runtime::runtime::detect_runtime();
    rt.transaction(project, |_rt| -> anyhow::Result<()> {
        log::info!("compose lock acquired, checking auth");
        let authed = setup_wizard::check_claude_auth(project)?;
        if !authed {
            anyhow::bail!("{}", MSG_NOT_AUTHENTICATED);
        }
        Ok(())
    })
    .map_err(|e| failure_before_swap(!recreated, e))?;

    speedwave_runtime::session::reap_unconfirmed(&rt, &chat::claude_container_name(project))
        .map_err(|e| failure_before_swap(!recreated, e))?;

    registry
        .claim_transcript(tab_id, resume_session_id)
        .map_err(|e| failure_before_swap(!recreated, e))?;

    log::info!("extracting old session for this tab");
    let mut old_session = {
        let mut guard = entry
            .session
            .lock()
            .map_err(|e| format!("Lock poisoned: {e}"))
            .map_err(|e| failure_before_swap(!recreated, e))?;
        std::mem::replace(
            &mut *guard,
            ChatSession::new(project, tab_id, entry.transcript.clone()),
        )
    };
    log::info!("stopping old session (outside lock)");
    old_session.stop().map_err(|e| e.to_string())?;
    drop(old_session);

    log::info!("starting new session");
    let allow_log_truncate = !registry.other_entry_for_project(project, tab_id);
    start_then_await_first_turn(&entry.session, |session| {
        session
            .start(
                app_handle,
                resume_session_id,
                allow_log_truncate,
                model_override,
            )
            .map_err(|e| e.to_string())
    })
}

fn start_then_await_first_turn(
    session_arc: &Arc<Mutex<ChatSession>>,
    start: impl FnOnce(&mut ChatSession) -> Result<(), String>,
) -> Result<(), String> {
    let first_turn = {
        let mut session = session_arc
            .lock()
            .map_err(|e| format!("Lock poisoned: {e}"))?;
        let result = start(&mut session);
        log::info!("session.start result={result:?}");
        result?;
        session.first_turn_gate()
    };
    if !first_turn.wait(chat::FIRST_TURN_WAIT) {
        log::warn!("the new session's model switch did not settle before the first turn");
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn start_chat(
    project: String,
    tab_id: String,
    model: Option<String>,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, SharedChatSessions>,
    oauth: tauri::State<'_, SharedOauth>,
) -> Result<(), String> {
    check_project(&project)?;
    chat_registry::validate_tab_id(&tab_id)?;
    log::info!("starting chat for project={project}");
    let registry = state.inner().clone();
    let oauth_arc = oauth.inner().clone();
    tokio::task::spawn_blocking(move || {
        start_session_inner(
            &project,
            &tab_id,
            None,
            model.as_deref(),
            registry,
            oauth_arc,
            app_handle,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn resume_conversation(
    project: String,
    session_id: String,
    tab_id: String,
    model: Option<String>,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, SharedChatSessions>,
    oauth: tauri::State<'_, SharedOauth>,
) -> Result<(), String> {
    check_project(&project)?;
    crate::history::validate_session_id(&session_id).map_err(|e| e.to_string())?;
    chat_registry::validate_tab_id(&tab_id)?;
    log::info!("resuming conversation for project={project}");
    let registry = state.inner().clone();
    let oauth_arc = oauth.inner().clone();
    tokio::task::spawn_blocking(move || {
        start_session_inner(
            &project,
            &tab_id,
            Some(&session_id),
            model.as_deref(),
            registry,
            oauth_arc,
            app_handle,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

fn close_chat_tab_inner(registry: &SharedChatSessions, tab_id: &str) -> Result<(), String> {
    let Some(entry) = registry.entry(tab_id) else {
        return Ok(());
    };
    let _serialize = entry
        .start_serialize
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let Some(session_arc) = registry.remove(tab_id) else {
        return Ok(());
    };
    let mut session = session_arc
        .lock()
        .map_err(|e| format!("Lock poisoned: {e}"))?;
    session.stop().map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn close_chat_tab(
    tab_id: String,
    state: tauri::State<'_, SharedChatSessions>,
) -> Result<(), String> {
    chat_registry::validate_tab_id(&tab_id)?;
    let registry = state.inner().clone();
    tokio::task::spawn_blocking(move || close_chat_tab_inner(&registry, &tab_id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn reset_chat_tabs(
    state: tauri::State<'_, SharedChatSessions>,
) -> Result<(), String> {
    log::info!("resetting chat tab registry for a freshly booted webview");
    let registry = state.inner().clone();
    tokio::task::spawn_blocking(move || clear_chat_sessions(&registry))
        .await
        .map_err(|e| e.to_string())
}

const MSG_NO_SESSION_FOR_TAB: &str = "no active session for this tab";

fn tab_session(
    registry: &SharedChatSessions,
    tab_id: &str,
) -> Result<Arc<Mutex<ChatSession>>, String> {
    chat_registry::validate_tab_id(tab_id)?;
    registry
        .entry(tab_id)
        .map(|e| e.session)
        .ok_or_else(|| MSG_NO_SESSION_FOR_TAB.to_string())
}

#[tauri::command]
pub(crate) async fn send_message(
    tab_id: String,
    blocks: Vec<chat::WireContentBlock>,
    display_text: String,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, SharedChatSessions>,
) -> Result<(), String> {
    if display_text.len() > chat::MAX_MESSAGE_LEN {
        return Err("Message too long".to_string());
    }
    let session_arc = tab_session(state.inner(), &tab_id)?;
    log::info!(
        "sending message: blocks={}, display_len={}",
        blocks.len(),
        display_text.len()
    );
    tokio::task::spawn_blocking(move || {
        after_first_turn(&session_arc, |session| {
            log::info!("lock acquired, sending message");
            session
                .send_message(&app_handle, &blocks)
                .map_err(|e| e.to_string())
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

fn after_first_turn<T>(
    session_arc: &Arc<Mutex<ChatSession>>,
    input: impl FnOnce(&mut ChatSession) -> Result<T, String>,
) -> Result<T, String> {
    let first_turn = lock_session_for_input(session_arc)?.first_turn_gate();
    write_after(session_arc, &first_turn, input)
}

fn write_after<T>(
    session_arc: &Arc<Mutex<ChatSession>>,
    first_turn: &chat::FirstTurnGate,
    input: impl FnOnce(&mut ChatSession) -> Result<T, String>,
) -> Result<T, String> {
    if !first_turn.wait(chat::FIRST_TURN_WAIT) {
        log::warn!("writing before the session's model switch settled");
    }
    let mut session = lock_session_for_input(session_arc)?;
    if !session.first_turn_gate().is(first_turn) {
        log::info!("the chat session was replaced while an input waited for its first turn");
        return Err(MSG_SESSION_REPLACED.to_string());
    }
    input(&mut session)
}

#[tauri::command]
pub(crate) async fn submit_question_answer(
    tab_id: String,
    tool_use_id: String,
    question_idx: usize,
    answer: String,
    state: tauri::State<'_, SharedChatSessions>,
) -> Result<(), String> {
    if answer.len() > chat::MAX_ASK_USER_ANSWER_LEN {
        return Err("Answer too long".to_string());
    }
    let session_arc = tab_session(state.inner(), &tab_id)?;
    tokio::task::spawn_blocking(move || {
        let mut session = lock_session_for_input(&session_arc)?;
        session
            .submit_question_answer(&tool_use_id, question_idx, &answer)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn stop_chat_inner(session_arc: Arc<Mutex<ChatSession>>) -> Result<(), String> {
    let mut session = session_arc
        .lock()
        .map_err(|e| format!("Lock poisoned: {e}"))?;
    session.interrupt().map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn stop_chat(
    tab_id: String,
    state: tauri::State<'_, SharedChatSessions>,
) -> Result<(), String> {
    log::info!("interrupting chat turn");
    let session_arc = tab_session(state.inner(), &tab_id)?;
    tokio::task::spawn_blocking(move || stop_chat_inner(session_arc))
        .await
        .map_err(|e| e.to_string())?
}

const MSG_SESSION_BUSY: &str = "chat session is busy";
const MSG_SESSION_REPLACED: &str = "the chat session was replaced before this input was written";
const MSG_NO_SESSION_FOR_PROJECT: &str = "no chat session for this project";

const INPUT_LOCK_WAIT: std::time::Duration = std::time::Duration::from_millis(50);
const INPUT_LOCK_POLL: std::time::Duration = std::time::Duration::from_millis(2);

fn lock_session_for_input(
    session_arc: &Arc<Mutex<ChatSession>>,
) -> Result<std::sync::MutexGuard<'_, ChatSession>, String> {
    lock_session_within(session_arc, INPUT_LOCK_WAIT)
}

fn lock_session_within(
    session_arc: &Arc<Mutex<ChatSession>>,
    wait: std::time::Duration,
) -> Result<std::sync::MutexGuard<'_, ChatSession>, String> {
    let deadline = std::time::Instant::now() + wait;
    loop {
        match session_arc.try_lock() {
            Ok(session) => return Ok(session),
            Err(std::sync::TryLockError::Poisoned(e)) => return Err(format!("Lock poisoned: {e}")),
            Err(std::sync::TryLockError::WouldBlock) if std::time::Instant::now() < deadline => {
                std::thread::sleep(INPUT_LOCK_POLL);
            }
            Err(std::sync::TryLockError::WouldBlock) => {
                log::info!("chat session is held by another command, refusing input");
                return Err(MSG_SESSION_BUSY.to_string());
            }
        }
    }
}

pub(crate) fn session_info_state_inner(
    registry: &SharedChatSessions,
    project: &str,
) -> SessionInfoState {
    let Some(session_arc) = registry.any_for_project(project) else {
        return SessionInfoState::Unavailable;
    };
    let guard = session_arc.try_lock();
    match guard {
        Ok(session) => session.session_info_state(),
        Err(_) => SessionInfoState::Unavailable,
    }
}

fn control_handle_for(
    registry: &SharedChatSessions,
    project: &str,
) -> Result<ControlHandle, String> {
    let session_arc = registry
        .any_for_project(project)
        .ok_or_else(|| MSG_NO_SESSION_FOR_PROJECT.to_string())?;
    session_control_handle(&session_arc)
}

fn session_control_handle(session_arc: &Arc<Mutex<ChatSession>>) -> Result<ControlHandle, String> {
    let session = session_arc
        .try_lock()
        .map_err(|_| MSG_SESSION_BUSY.to_string())?;
    session.control_handle().map_err(|e| e.to_string())
}

fn control_query_inner<T>(
    registry: &SharedChatSessions,
    project: &str,
    query: ControlQuery,
    parse: fn(&serde_json::Value) -> Result<T, control_channel::ControlError>,
) -> Result<T, String> {
    let handle = control_handle_for(registry, project)?;
    handle
        .query(query)
        .and_then(|value| parse(&value))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn tab_owning_transcript(
    session_id: String,
    state: tauri::State<'_, SharedChatSessions>,
) -> Result<Option<String>, String> {
    crate::history::validate_session_id(&session_id).map_err(|e| e.to_string())?;
    Ok(state.inner().tab_owning_transcript(&session_id))
}

#[tauri::command]
pub(crate) async fn get_chat_session_info(
    project: String,
    state: tauri::State<'_, SharedChatSessions>,
) -> Result<SessionInfoState, String> {
    check_project(&project)?;
    Ok(session_info_state_inner(state.inner(), &project))
}

fn validate_model_pick(model: &str) -> Result<(), String> {
    if model.is_empty() {
        return Err("model must not be empty".to_string());
    }
    if model.len() > chat::MAX_MODEL_ID_LEN {
        return Err(format!(
            "model id is longer than {} bytes",
            chat::MAX_MODEL_ID_LEN
        ));
    }
    if model.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("model id must not contain whitespace or control characters".to_string());
    }
    Ok(())
}

fn tab_session_for_project(
    registry: &SharedChatSessions,
    tab_id: &str,
    project: &str,
) -> Result<Arc<Mutex<ChatSession>>, String> {
    chat_registry::validate_tab_id(tab_id)?;
    match registry.entry(tab_id) {
        Some(entry) if entry.project == project => Ok(entry.session),
        Some(_) => Err(MSG_NO_SESSION_FOR_PROJECT.to_string()),
        None => Err(MSG_NO_SESSION_FOR_TAB.to_string()),
    }
}

fn live_session_input<T>(
    session_arc: &Arc<Mutex<ChatSession>>,
    take: impl FnOnce(&ChatSession) -> anyhow::Result<T>,
) -> Result<T, String> {
    let session = lock_session_for_input(session_arc)?;
    take(&session).map_err(|e| e.to_string())
}

fn session_after_first_turn<T>(
    session_arc: &Arc<Mutex<ChatSession>>,
    take: impl FnOnce(&ChatSession) -> anyhow::Result<T>,
) -> Result<T, String> {
    let deadline = std::time::Instant::now() + chat::FIRST_TURN_WAIT;
    let mut first_turn = live_session_input(session_arc, |s| Ok(s.first_turn_gate()))?;
    loop {
        let settled =
            first_turn.wait(deadline.saturating_duration_since(std::time::Instant::now()));
        let session = lock_session_for_input(session_arc)?;
        let current = session.first_turn_gate();
        if current.is(&first_turn) || std::time::Instant::now() >= deadline {
            if !settled {
                log::warn!("taking the session before its model switch settled");
            }
            return take(&session).map_err(|e| e.to_string());
        }
        log::info!("the tab's chat session restarted while an input waited for its first turn");
        first_turn = current;
    }
}

fn switch_model_inner(
    session_arc: &Arc<Mutex<ChatSession>>,
    model: &str,
) -> Result<ModelSwitchOutcome, String> {
    let switch = session_after_first_turn(session_arc, ChatSession::model_switch)?;
    log::info!("switching the chat session to {model}");
    let outcome = switch.apply(model).map_err(|e| e.to_string())?;
    match &outcome {
        ModelSwitchOutcome::Confirmed => log::info!("Claude Code switched the session to {model}"),
        ModelSwitchOutcome::Unconfirmed => {
            log::warn!("Claude Code did not answer the switch to {model} in time");
        }
        ModelSwitchOutcome::Refused { reason } => {
            log::warn!("Claude Code refused the switch to {model}: {reason}");
        }
    }
    Ok(outcome)
}

#[tauri::command]
pub(crate) async fn switch_chat_model(
    project: String,
    tab_id: String,
    model: String,
    state: tauri::State<'_, SharedChatSessions>,
) -> Result<ModelSwitchOutcome, String> {
    check_project(&project)?;
    validate_model_pick(&model)?;
    let session_arc = tab_session_for_project(state.inner(), &tab_id, &project)?;
    tokio::task::spawn_blocking(move || switch_model_inner(&session_arc, &model))
        .await
        .map_err(|e| e.to_string())?
}

fn apply_effort_inner(session_arc: &Arc<Mutex<ChatSession>>, level: &str) -> Result<(), String> {
    let handle = live_session_input(session_arc, ChatSession::control_handle)?;
    log::info!("applying effort {level} to the chat session");
    handle.apply_effort(level).map_err(|e| {
        log::warn!("the chat session did not take effort {level}: {e}");
        e.to_string()
    })?;
    #[cfg(feature = "e2e")]
    crate::e2e_support::record_applied_effort(level);
    Ok(())
}

#[tauri::command]
pub(crate) async fn apply_chat_effort(
    project: String,
    tab_id: String,
    level: String,
    state: tauri::State<'_, SharedChatSessions>,
) -> Result<(), String> {
    check_project(&project)?;
    crate::pin_cmd::validate_effort_level(&level)?;
    let session_arc = tab_session_for_project(state.inner(), &tab_id, &project)?;
    tokio::task::spawn_blocking(move || apply_effort_inner(&session_arc, &level))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn get_plan_usage(
    project: String,
    state: tauri::State<'_, SharedChatSessions>,
) -> Result<PlanUsage, String> {
    check_project(&project)?;
    let registry = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        control_query_inner(
            &registry,
            &project,
            ControlQuery::Usage,
            control_channel::parse_plan_usage,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn get_context_usage(
    project: String,
    tab_id: String,
    state: tauri::State<'_, SharedChatSessions>,
) -> Result<ContextUsage, String> {
    check_project(&project)?;
    let session_arc = tab_session_for_project(state.inner(), &tab_id, &project)?;
    tokio::task::spawn_blocking(move || context_usage_inner(&session_arc))
        .await
        .map_err(|e| e.to_string())?
}

fn context_usage_inner(session_arc: &Arc<Mutex<ChatSession>>) -> Result<ContextUsage, String> {
    let handle = session_control_handle(session_arc)?;
    handle
        .query(ControlQuery::ContextUsage)
        .and_then(|value| control_channel::parse_context_usage(&value))
        .map_err(|e| e.to_string())
        .map(ContextUsage::drawn_categories_only)
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "test assertions may unwrap/expect freely"
)]
mod tests {
    use super::*;
    use crate::chat_registry::test_support::registry_with;
    use crate::chat_registry::ChatSessions;

    const TAB_A: &str = "550e8400-e29b-41d4-a716-446655440000";
    const TAB_B: &str = "550e8400-e29b-41d4-a716-446655440001";

    #[test]
    fn session_info_is_unavailable_without_a_live_session() {
        let (reg, _entry) = registry_with("acme");
        assert_eq!(
            session_info_state_inner(&reg, "acme"),
            SessionInfoState::Unavailable
        );
    }

    #[test]
    fn session_info_is_unavailable_on_an_empty_registry() {
        let reg: SharedChatSessions = Arc::new(ChatSessions::default());
        assert_eq!(
            session_info_state_inner(&reg, "acme"),
            SessionInfoState::Unavailable
        );
    }

    #[test]
    fn session_info_is_unavailable_for_another_project_and_while_the_session_is_locked() {
        let (reg, entry) = registry_with("acme");
        assert_eq!(
            session_info_state_inner(&reg, "other"),
            SessionInfoState::Unavailable
        );
        let _held = entry.session.lock().unwrap();
        assert_eq!(
            session_info_state_inner(&reg, "acme"),
            SessionInfoState::Unavailable
        );
    }

    #[test]
    fn control_query_without_a_live_session_errors_instead_of_waiting() {
        let (reg, _entry) = registry_with("acme");
        let err = control_query_inner(
            &reg,
            "acme",
            ControlQuery::Usage,
            control_channel::parse_plan_usage,
        )
        .unwrap_err();
        assert_eq!(err, "no active session");
    }

    #[test]
    fn control_query_rejects_a_project_the_session_does_not_belong_to() {
        let (reg, _entry) = registry_with("acme");
        let err = control_query_inner(
            &reg,
            "other",
            ControlQuery::ContextUsage,
            control_channel::parse_context_usage,
        )
        .unwrap_err();
        assert_eq!(err, MSG_NO_SESSION_FOR_PROJECT);
    }

    #[test]
    fn control_query_never_waits_for_a_session_that_is_being_started() {
        let (reg, entry) = registry_with("acme");
        let _held = entry.session.lock().unwrap();
        let err = control_query_inner(
            &reg,
            "acme",
            ControlQuery::Usage,
            control_channel::parse_plan_usage,
        )
        .unwrap_err();
        assert_eq!(err, MSG_SESSION_BUSY);
    }

    #[test]
    fn control_commands_release_the_session_lock_before_waiting_for_the_response() {
        let source = include_str!("chat_session_cmd.rs");
        let body = extract_fn_body(source, "fn control_query_inner<T>(");
        let handle_pos = body
            .find("control_handle_for")
            .expect("control_query_inner must take a handle");
        let query_pos = body
            .find(".query(")
            .expect("control_query_inner must query");
        assert!(handle_pos < query_pos);
        assert!(
            !body.contains(".lock()"),
            "the session mutex must not be held while the control request waits"
        );
    }

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

    #[test]
    fn start_chat_delegates_to_start_session_inner() {
        let source = include_str!("chat_session_cmd.rs");
        let body = extract_fn_body(source, "async fn start_chat(");
        assert!(
            body.contains("start_session_inner"),
            "start_chat must delegate to start_session_inner"
        );
    }

    #[test]
    fn resume_conversation_delegates_to_start_session_inner() {
        let source = include_str!("chat_session_cmd.rs");
        let body = extract_fn_body(source, "async fn resume_conversation(");
        assert!(
            body.contains("start_session_inner"),
            "resume_conversation must delegate to start_session_inner"
        );
    }

    #[test]
    fn start_session_inner_serializes_per_tab_before_any_start_stop() {
        let source = include_str!("chat_session_cmd.rs");
        let body = extract_fn_body(source, "fn start_session_inner(");
        let guard_pos = body
            .find("start_serialize")
            .expect("start_session_inner must acquire the per-tab start serializer");
        let work_pos = body
            .find("ensure_oauth_running")
            .expect("start_session_inner must call ensure_oauth_running");
        assert!(guard_pos < work_pos);
    }

    #[test]
    fn start_session_inner_propagates_the_tab_cap_rejection_before_any_start_work() {
        let source = include_str!("chat_session_cmd.rs");
        let body = extract_fn_body(source, "fn start_session_inner(");
        let prepare_pos = body
            .find(".prepare(tab_id, project)")
            .expect("start_session_inner must propagate the registry's tab-cap rejection");
        let work_pos = body
            .find("ensure_oauth_running")
            .expect("start_session_inner must call ensure_oauth_running");
        assert!(prepare_pos < work_pos);
    }

    #[test]
    fn two_tabs_start_without_serializing_on_each_other() {
        let reg = ChatSessions::default();
        let a = reg.prepare(TAB_A, "acme").unwrap();
        let b = reg.prepare(TAB_B, "acme").unwrap();
        let _held_a = a.start_serialize.lock().unwrap();
        assert!(
            b.start_serialize.try_lock().is_ok(),
            "tab B's start must not wait on tab A's serializer"
        );
    }

    #[test]
    fn start_session_inner_checks_the_transcript_before_any_start_work() {
        let source = include_str!("chat_session_cmd.rs");
        let body = extract_fn_body(source, "fn start_session_inner(");
        let check_pos = body
            .find("check_transcript_free")
            .expect("start_session_inner must check the transcript for this tab");
        let work_pos = body
            .find("ensure_oauth_running")
            .expect("start_session_inner must call ensure_oauth_running");
        assert!(
            check_pos < work_pos,
            "the resume dedup must reject a doubly-opened conversation before any start work"
        );
    }

    #[test]
    fn start_session_inner_claims_the_transcript_after_the_last_check_that_keeps_the_session() {
        let source = include_str!("chat_session_cmd.rs");
        let body = extract_fn_body(source, "fn start_session_inner(");
        let claim_pos = body
            .find("claim_transcript")
            .expect("start_session_inner must claim the transcript for this tab");
        let reap_pos = body
            .find("reap_unconfirmed")
            .expect("start_session_inner must reap unconfirmed instances");
        let swap_pos = body
            .find("std::mem::replace(")
            .expect("start_session_inner must swap the session");
        assert!(
            reap_pos < claim_pos && claim_pos < swap_pos,
            "a failure that keeps the running session must leave its transcript slot untouched"
        );
    }

    #[test]
    fn start_session_inner_checks_auth_before_session_start() {
        let source = include_str!("chat_session_cmd.rs");
        let body = extract_fn_body(source, "fn start_session_inner(");

        let auth_pos = body
            .find("check_claude_auth")
            .expect("start_session_inner must call check_claude_auth");
        let start_pos = body
            .find(".start(")
            .expect("start_session_inner must call session.start(...)");

        assert!(
            auth_pos < start_pos,
            "check_claude_auth must come BEFORE session.start()"
        );
    }

    #[test]
    fn start_session_inner_acquires_compose_lock_for_auth() {
        let source = include_str!("chat_session_cmd.rs");
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
        let source = include_str!("chat_session_cmd.rs");
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

    #[test]
    fn start_chat_uses_spawn_blocking() {
        let source = include_str!("chat_session_cmd.rs");
        let body = extract_fn_body(source, "async fn start_chat(");
        assert!(
            body.contains("spawn_blocking"),
            "start_chat must use spawn_blocking to avoid blocking the main thread"
        );
    }

    #[test]
    fn send_message_uses_spawn_blocking() {
        let source = include_str!("chat_session_cmd.rs");
        let body = extract_fn_body(source, "async fn send_message(");
        assert!(
            body.contains("spawn_blocking"),
            "send_message must use spawn_blocking to avoid blocking the main thread"
        );
    }

    #[test]
    fn submit_question_answer_uses_spawn_blocking() {
        let source = include_str!("chat_session_cmd.rs");
        let body = extract_fn_body(source, "async fn submit_question_answer(");
        assert!(
            body.contains("spawn_blocking"),
            "submit_question_answer must use spawn_blocking to avoid blocking the main thread"
        );
    }

    #[test]
    fn start_session_inner_computes_allow_log_truncate_from_the_sibling_check() {
        let source = include_str!("chat_session_cmd.rs");
        let body = extract_fn_body(source, "fn start_session_inner(");

        let sibling_pos = body.find("other_entry_for_project").expect(
            "start_session_inner must compute allow_log_truncate via other_entry_for_project",
        );
        let start_pos = body
            .find(".start(")
            .expect("start_session_inner must call session.start(...)");

        assert!(
            sibling_pos < start_pos,
            "the sibling check must be computed before session.start() is called"
        );
    }

    #[test]
    fn start_session_inner_acquires_session_lock() {
        let source = include_str!("chat_session_cmd.rs");
        let body = extract_fn_body(source, "fn start_session_inner(");
        assert!(
            body.contains(".session") && body.contains(".lock()"),
            "start_session_inner must acquire the tab session lock"
        );
    }

    #[test]
    fn send_message_acquires_lock_inside_spawn_blocking() {
        let source = include_str!("chat_session_cmd.rs");
        let body = extract_fn_body(source, "async fn send_message(");
        let spawn_pos = body
            .find("spawn_blocking")
            .expect("send_message must use spawn_blocking");
        let input_pos = body
            .find("after_first_turn(")
            .expect("send_message must write through after_first_turn");
        assert!(
            input_pos > spawn_pos,
            "session lock must be acquired INSIDE spawn_blocking, not before it"
        );
        let input = extract_fn_body(source, "fn after_first_turn<");
        assert!(
            input.contains("lock_session_for_input("),
            "after_first_turn must acquire the session lock via lock_session_for_input"
        );
    }

    #[test]
    fn submit_question_answer_acquires_lock_inside_spawn_blocking() {
        let source = include_str!("chat_session_cmd.rs");
        let body = extract_fn_body(source, "async fn submit_question_answer(");
        let spawn_pos = body
            .find("spawn_blocking")
            .expect("submit_question_answer must use spawn_blocking");
        let lock_pos = body.find("lock_session_for_input(").expect(
            "submit_question_answer must acquire the session lock via lock_session_for_input",
        );
        assert!(
            lock_pos > spawn_pos,
            "session lock must be acquired INSIDE spawn_blocking, not before it"
        );
    }

    #[test]
    fn start_chat_validates_project_before_spawn_blocking() {
        let source = include_str!("chat_session_cmd.rs");
        let body = extract_fn_body(source, "async fn start_chat(");
        let check_pos = body
            .find("check_project")
            .expect("start_chat must call check_project");
        let tab_pos = body
            .find("validate_tab_id")
            .expect("start_chat must validate the tab id");
        let spawn_pos = body
            .find("spawn_blocking")
            .expect("start_chat must use spawn_blocking");
        assert!(
            check_pos < spawn_pos && tab_pos < spawn_pos,
            "check_project and validate_tab_id must come BEFORE spawn_blocking for fail-fast validation"
        );
    }

    #[test]
    fn send_message_validates_length_before_spawn_blocking() {
        let source = include_str!("chat_session_cmd.rs");
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
    fn send_message_resolves_the_tab_before_spawn_blocking() {
        let source = include_str!("chat_session_cmd.rs");
        let body = extract_fn_body(source, "async fn send_message(");
        let tab_pos = body
            .find("tab_session")
            .expect("send_message must resolve the tab session");
        let spawn_pos = body
            .find("spawn_blocking")
            .expect("send_message must use spawn_blocking");
        assert!(
            tab_pos < spawn_pos,
            "the tab must resolve BEFORE spawn_blocking for fail-fast validation"
        );
    }

    #[test]
    fn submit_question_answer_validates_length_before_spawn_blocking() {
        let source = include_str!("chat_session_cmd.rs");
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

    #[test]
    fn submit_question_answer_resolves_the_tab_before_spawn_blocking() {
        let source = include_str!("chat_session_cmd.rs");
        let body = extract_fn_body(source, "async fn submit_question_answer(");
        let tab_pos = body
            .find("tab_session")
            .expect("submit_question_answer must resolve the tab session");
        let spawn_pos = body
            .find("spawn_blocking")
            .expect("submit_question_answer must use spawn_blocking");
        assert!(
            tab_pos < spawn_pos,
            "the tab must resolve BEFORE spawn_blocking for fail-fast validation"
        );
    }

    #[test]
    fn stop_chat_resolves_the_tab_before_spawn_blocking() {
        let source = include_str!("chat_session_cmd.rs");
        let body = extract_fn_body(source, "async fn stop_chat(");
        let tab_pos = body
            .find("tab_session")
            .expect("stop_chat must resolve the tab session");
        let spawn_pos = body
            .find("spawn_blocking")
            .expect("stop_chat must use spawn_blocking");
        assert!(
            tab_pos < spawn_pos,
            "the tab must resolve BEFORE spawn_blocking for fail-fast validation"
        );
    }

    #[test]
    fn start_chat_handles_join_error() {
        let source = include_str!("chat_session_cmd.rs");
        let body = extract_fn_body(source, "async fn start_chat(");
        assert!(
            body.contains(".await") && body.contains("map_err(|e| e.to_string())"),
            "start_chat must handle JoinError from spawn_blocking via .await.map_err"
        );
    }

    #[test]
    fn send_message_handles_join_error() {
        let source = include_str!("chat_session_cmd.rs");
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
        let source = include_str!("chat_session_cmd.rs");
        let body = extract_fn_body(source, "async fn submit_question_answer(");
        assert!(
            body.contains(".await")
                && body.contains("map_err(|e| e.to_string())")
                && body.matches("map_err").count() >= 2,
            "submit_question_answer must handle JoinError from spawn_blocking via .await.map_err"
        );
    }

    #[test]
    fn commands_reject_an_unknown_tab_id() {
        let reg: SharedChatSessions = Arc::new(ChatSessions::default());
        assert_eq!(
            tab_session(&reg, TAB_A).err().unwrap(),
            MSG_NO_SESSION_FOR_TAB
        );
        assert!(tab_session(&reg, "not-a-uuid").is_err());
    }

    #[test]
    fn tab_session_resolves_a_prepared_tab() {
        let reg: SharedChatSessions = Arc::new(ChatSessions::default());
        let entry = reg.prepare(TAB_A, "acme").unwrap();
        let resolved = tab_session(&reg, TAB_A).unwrap();
        assert!(Arc::ptr_eq(&resolved, &entry.session));
    }

    #[test]
    fn stopping_one_tab_leaves_the_sibling_untouched() {
        let reg = ChatSessions::default();
        let a = reg.prepare(TAB_A, "acme").unwrap();
        let b = reg.prepare(TAB_B, "acme").unwrap();
        a.session.lock().unwrap().stop().unwrap();
        assert!(
            b.session.try_lock().is_ok(),
            "sibling session must stay lockable and live"
        );
        assert!(reg.entry(TAB_B).is_some());
    }

    #[test]
    fn close_chat_tab_on_an_unknown_tab_is_ok() {
        let reg: SharedChatSessions = Arc::new(ChatSessions::default());
        close_chat_tab_inner(&reg, TAB_A).unwrap();
    }

    #[test]
    fn close_chat_tab_removes_the_entry_and_stops_the_session() {
        let (reg, entry) = registry_with("acme");
        close_chat_tab_inner(&reg, crate::chat_registry::test_support::TEST_TAB_ID).unwrap();
        assert!(reg
            .entry(crate::chat_registry::test_support::TEST_TAB_ID)
            .is_none());
        assert!(
            entry.session.try_lock().is_ok(),
            "the stopped session must not stay locked"
        );
    }

    #[test]
    fn close_chat_tab_takes_the_serializer_before_removing_the_entry() {
        let source = include_str!("chat_session_cmd.rs");
        let body = extract_fn_body(source, "fn close_chat_tab_inner(");
        let guard_pos = body
            .find("start_serialize")
            .expect("close_chat_tab_inner must take the per-tab serializer");
        let remove_pos = body
            .find(".remove(")
            .expect("close_chat_tab_inner must remove the entry");
        assert!(
            guard_pos < remove_pos,
            "the serializer must be held before the entry is removed"
        );
    }

    #[test]
    fn stop_chat_inner_without_active_session_errors() {
        let (_reg, entry) = registry_with("test-project");
        let err = stop_chat_inner(entry.session).expect_err("expected error on idle session");
        assert!(
            err.contains("no active session"),
            "expected 'no active session' in error, got: {err}"
        );
    }

    #[test]
    fn stop_chat_inner_poisoned_mutex_returns_lock_poisoned_error() {
        let (_reg, entry) = registry_with("test-project");
        let arc_clone = entry.session.clone();
        let _ = std::thread::spawn(move || {
            let _guard = arc_clone.lock().unwrap();
            panic!("poison the mutex");
        })
        .join();
        let result = stop_chat_inner(entry.session);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            err.contains("Lock poisoned"),
            "expected 'Lock poisoned' in error, got: {err}"
        );
    }

    #[test]
    fn stop_chat_uses_spawn_blocking() {
        let source = include_str!("chat_session_cmd.rs");
        let body = extract_fn_body(source, "async fn stop_chat(");
        assert!(
            body.contains("spawn_blocking"),
            "stop_chat must use spawn_blocking to avoid blocking the main thread"
        );
    }

    #[test]
    fn reset_chat_tabs_clears_the_registry_inside_spawn_blocking() {
        let source = include_str!("chat_session_cmd.rs");
        let body = extract_fn_body(source, "async fn reset_chat_tabs(");
        let spawn_pos = body
            .find("spawn_blocking")
            .expect("reset_chat_tabs must use spawn_blocking to avoid blocking the main thread");
        let clear_pos = body
            .find("clear_chat_sessions")
            .expect("reset_chat_tabs must delegate to clear_chat_sessions");
        assert!(
            clear_pos > spawn_pos,
            "clear_chat_sessions must run INSIDE spawn_blocking, not before it"
        );
    }

    fn session_for(project: &str) -> Arc<Mutex<ChatSession>> {
        Arc::new(Mutex::new(ChatSession::new(
            project,
            TAB_A,
            Arc::new(Mutex::new(None)),
        )))
    }

    fn assert_the_pick_leaves_the_session_free_while_it_waits<T>(
        pick: fn(&Arc<Mutex<ChatSession>>) -> Result<T, String>,
    ) where
        T: std::fmt::Debug + PartialEq + Send + 'static,
    {
        let session_arc = session_for("acme");
        let control = {
            let mut session = session_arc.lock().unwrap();
            session.set_test_stdin_sink(Vec::new());
            session.control_channel_for_test()
        };
        let picker = {
            let session_arc = session_arc.clone();
            std::thread::spawn(move || pick(&session_arc))
        };
        let (_, picker) = pending_request_id(&control, picker);

        let mut session = session_arc
            .try_lock()
            .expect("the pick holds the session lock while it waits for Claude Code");
        session.stop().unwrap();
        drop(session);

        assert_eq!(
            picker.join().unwrap(),
            Err(control_channel::ControlError::SessionEnded.to_string())
        );
    }

    fn pending_request_id<T: std::fmt::Debug>(
        control: &control_channel::ControlChannel,
        caller: std::thread::JoinHandle<T>,
    ) -> (String, std::thread::JoinHandle<T>) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            if let Some(id) = control.pending_ids().pop() {
                return (id, caller);
            }
            if caller.is_finished() {
                panic!(
                    "the caller ended before it waited for Claude Code: {:?}",
                    caller.join()
                );
            }
            assert!(
                std::time::Instant::now() < deadline,
                "the caller never registered its request"
            );
            std::thread::yield_now();
        }
    }

    fn answer_the_pending_query<T: std::fmt::Debug>(
        control: &control_channel::ControlChannel,
        caller: std::thread::JoinHandle<T>,
        payload: &serde_json::Value,
    ) -> T {
        let (id, caller) = pending_request_id(control, caller);
        let line = serde_json::json!({
            "type": control_channel::MSG_TYPE_CONTROL_RESPONSE,
            "response": {"subtype": "success", "request_id": id, "response": payload},
        });
        assert_eq!(
            control.route_response(&line),
            control_channel::Routed::Delivered
        );
        caller.join().unwrap()
    }

    #[test]
    fn context_usage_reaches_the_ui_with_only_the_rows_claude_code_marks_used() {
        let fixture: serde_json::Value =
            serde_json::from_str(control_channel::FIXTURE).expect("fixture is valid JSON");
        let captured = &fixture["run_A"]["get_context_usage/claude-opus-5"];
        let (_, entry) = registry_with("acme");
        let control = {
            let mut session = entry.session.lock().unwrap();
            session.set_test_stdin_sink(Vec::new());
            session.control_channel_for_test()
        };
        let session_arc = entry.session.clone();
        let reader = std::thread::spawn(move || context_usage_inner(&session_arc));

        let usage = answer_the_pending_query(&control, reader, captured).expect("context usage");

        let names: Vec<&str> = usage.categories.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "System prompt",
                "System tools",
                "Custom agents",
                "Memory files",
                "Skills"
            ]
        );
        let raw = control_channel::parse_context_usage(captured).unwrap();
        assert!(raw.categories.len() > usage.categories.len());
        assert_eq!(usage.total_tokens, raw.total_tokens);
    }

    #[test]
    fn an_effort_pick_leaves_the_session_free_while_it_waits_for_the_answer() {
        assert_the_pick_leaves_the_session_free_while_it_waits(|session_arc| {
            apply_effort_inner(session_arc, "low")
        });
    }

    #[test]
    fn a_model_pick_leaves_the_session_free_while_it_waits_for_the_answer() {
        assert_the_pick_leaves_the_session_free_while_it_waits(|session_arc| {
            switch_model_inner(session_arc, "claude-haiku-4-5")
        });
    }

    #[test]
    fn an_effort_pick_needs_a_live_session() {
        let session_arc = session_for("acme");

        let idle = apply_effort_inner(&session_arc, "low");

        assert!(idle.unwrap_err().contains("no active session"));
    }

    #[test]
    fn an_effort_pick_on_a_session_held_by_another_command_says_it_is_busy() {
        let session_arc = session_for("acme");
        let _held = session_arc.lock().unwrap();

        let picked = apply_effort_inner(&session_arc, "high");

        assert_eq!(picked, Err(MSG_SESSION_BUSY.to_string()));
    }

    #[test]
    fn apply_chat_effort_validates_before_spawn_blocking() {
        let source = include_str!("chat_session_cmd.rs");
        let body = extract_fn_body(source, "async fn apply_chat_effort(");
        let checked = body
            .find("validate_effort_level")
            .expect("apply_chat_effort must validate the level");
        let spawned = body
            .find("spawn_blocking")
            .expect("the session lock must not run on the async runtime");
        assert!(checked < spawned);
    }

    #[test]
    fn input_to_a_session_held_by_another_command_is_refused_as_busy() {
        let session_arc = session_for("acme");
        let held = session_arc.lock().unwrap();
        let Err(err) = lock_session_for_input(&session_arc) else {
            panic!("a session another command holds must not be taken for input");
        };
        assert_eq!(err, MSG_SESSION_BUSY);
        drop(held);
        assert!(lock_session_for_input(&session_arc).is_ok());
    }

    #[test]
    fn input_waits_out_a_brief_hold() {
        let session_arc = session_for("acme");
        let (held_tx, held_rx) = std::sync::mpsc::channel();
        let holder = {
            let session_arc = session_arc.clone();
            std::thread::spawn(move || {
                let _held = session_arc.lock().unwrap();
                held_tx.send(()).unwrap();
                std::thread::sleep(std::time::Duration::from_millis(200));
            })
        };
        held_rx.recv().unwrap();
        let session = lock_session_within(&session_arc, std::time::Duration::from_secs(30));
        assert!(
            session.is_ok(),
            "a hold that ends within the wait must let the input through"
        );
        drop(session);
        holder.join().unwrap();
    }

    #[test]
    fn send_retry_triggers_in_ts_never_match_the_busy_error() {
        let ts = include_str!("../../src/src/app/services/chat-session-store.ts");
        let triggers: Vec<&str> = ts
            .split("errStr.includes('")
            .skip(1)
            .filter_map(|rest| rest.split("')").next())
            .collect();
        assert!(
            triggers.contains(&"no active session"),
            "the send retry triggers were not found: {triggers:?}"
        );
        for trigger in triggers {
            assert!(
                !MSG_SESSION_BUSY.contains(trigger),
                "the send retry restarts the session on '{trigger}', which would replace a live conversation"
            );
            assert!(
                !MSG_SESSION_REPLACED.contains(trigger),
                "the send retry restarts the session on '{trigger}', which would resend into the conversation that replaced it"
            );
        }
    }

    #[test]
    fn a_message_that_waited_while_the_session_was_replaced_is_not_written_into_the_new_one() {
        let session_arc = session_for("test-project");
        let gate = session_arc.lock().unwrap().hold_first_turn();
        let written = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let sender = {
            let session_arc = session_arc.clone();
            let written = written.clone();
            let gate = gate.clone();
            std::thread::spawn(move || {
                write_after(&session_arc, &gate, |_| {
                    written.store(true, std::sync::atomic::Ordering::SeqCst);
                    Ok(())
                })
            })
        };

        *session_arc.lock().unwrap() =
            ChatSession::new("test-project", TAB_A, Arc::new(Mutex::new(None)));
        gate.release();

        assert_eq!(
            sender.join().unwrap(),
            Err(MSG_SESSION_REPLACED.to_string())
        );
        assert!(!written.load(std::sync::atomic::Ordering::SeqCst));
    }

    #[test]
    fn input_to_a_poisoned_session_reports_the_poison() {
        let session_arc = session_for("acme");
        let arc_clone = session_arc.clone();
        let _ = std::thread::spawn(move || {
            let _guard = arc_clone.lock().unwrap();
            panic!("poison the mutex");
        })
        .join();
        let Err(err) = lock_session_for_input(&session_arc) else {
            panic!("a poisoned session must not be taken for input");
        };
        assert!(err.starts_with("Lock poisoned"), "{err}");
    }

    #[test]
    fn model_picks_are_validated_before_they_reach_the_session() {
        for good in [
            "claude-haiku-4-5",
            "claude-opus-5[1m]",
            "default",
            "openrouter/openai/gpt-4o-mini",
            "local/qwen3.5:9b",
        ] {
            assert_eq!(validate_model_pick(good), Ok(()), "{good}");
        }
        let too_long = "m".repeat(chat::MAX_MODEL_ID_LEN + 1);
        for bad in [
            "",
            " claude-haiku-4-5",
            "claude haiku",
            "claude-haiku-4-5\n",
            "claude\u{0}haiku",
            too_long.as_str(),
        ] {
            assert!(validate_model_pick(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn a_model_pick_needs_a_live_session() {
        let session_arc = session_for("acme");

        let idle = switch_model_inner(&session_arc, "claude-haiku-4-5");

        assert!(idle.unwrap_err().contains("no active session"));
    }

    #[test]
    fn a_pick_goes_only_to_a_known_tab_of_the_same_project() {
        let (reg, entry) = registry_with("acme");

        let same = tab_session_for_project(&reg, TAB_A, "acme").unwrap();
        let other = tab_session_for_project(&reg, TAB_A, "other");
        let unknown = tab_session_for_project(&reg, TAB_B, "acme");
        let malformed = tab_session_for_project(&reg, "not-a-tab", "acme");

        assert!(Arc::ptr_eq(&same, &entry.session));
        assert_eq!(other.err(), Some(MSG_NO_SESSION_FOR_PROJECT.to_string()));
        assert_eq!(unknown.err(), Some(MSG_NO_SESSION_FOR_TAB.to_string()));
        assert!(malformed.is_err());
    }

    #[test]
    fn model_and_effort_picks_resolve_their_tab_before_spawn_blocking() {
        let source = include_str!("chat_session_cmd.rs");
        for signature in [
            "async fn switch_chat_model(",
            "async fn apply_chat_effort(",
            "async fn get_context_usage(",
        ] {
            let body = extract_fn_body(source, signature);
            let resolved = body
                .find("tab_session_for_project(")
                .unwrap_or_else(|| panic!("{signature} must address its tab"));
            let spawned = body
                .find("spawn_blocking")
                .unwrap_or_else(|| panic!("{signature} must use spawn_blocking"));
            assert!(resolved < spawned, "{signature}");
        }
    }

    #[test]
    fn a_model_pick_on_a_session_held_by_another_command_says_it_is_busy() {
        let session_arc = session_for("acme");
        let _held = session_arc.lock().unwrap();

        let picked = switch_model_inner(&session_arc, "claude-haiku-4-5");

        assert_eq!(picked, Err(MSG_SESSION_BUSY.to_string()));
    }

    #[test]
    fn every_failure_before_the_old_session_stops_says_it_was_kept() {
        let source = include_str!("chat_session_cmd.rs");
        let body = extract_fn_body(source, "fn start_session_inner(");
        let before_stop = &body[..body
            .find("std::mem::replace(")
            .expect("start_session_inner must swap the session")];
        let closure_start = before_stop
            .find("rt.transaction(")
            .expect("start_session_inner must check auth under the compose lock");
        let body_start = closure_start
            + before_stop[closure_start..]
                .find('{')
                .expect("the transaction closure has a body");
        let mut depth = 0usize;
        let closure_end = before_stop[body_start..]
            .char_indices()
            .find_map(|(i, c)| {
                match c {
                    '{' => depth += 1,
                    '}' => depth -= 1,
                    _ => {}
                }
                (depth == 0).then_some(body_start + i + 1)
            })
            .expect("the transaction closure must close");
        let outside_closure = format!(
            "{}{}",
            &before_stop[..closure_start],
            &before_stop[closure_end..]
        );

        assert!(outside_closure.contains("?;"));
        assert_eq!(
            outside_closure.matches("?;").count(),
            outside_closure
                .matches(".map_err(kept_session_error)?;")
                .count()
                + outside_closure
                    .matches(".map_err(|e| failure_before_swap(!recreated, e))?;")
                    .count(),
            "a failure before the swap leaves the running session in place and must say so"
        );
        let after_stop = &body[body.find("old_session.stop()").unwrap()..];
        assert!(!after_stop.contains("kept_session_error"));
    }

    #[test]
    fn a_surviving_kept_instance_refuses_the_start_before_the_running_session_stops() {
        let source = include_str!("chat_session_cmd.rs");
        let body: String = extract_fn_body(source, "fn start_session_inner(")
            .split_whitespace()
            .collect();
        let gate = body
            .find(concat!(
                "speedwave_runtime::session::reap_unconfirmed(&rt,",
                "&chat::claude_container_name(project))",
                ".map_err(|e|failure_before_swap(!recreated,e))?;"
            ))
            .expect("the start refuses while an earlier instance survives its reap");
        let swap = body
            .find("std::mem::replace(")
            .expect("start_session_inner must swap the session");

        assert!(gate < swap);
    }

    #[test]
    fn a_start_refused_beside_a_kept_instance_says_the_running_session_was_kept() {
        let container = chat::claude_container_name("kept-instance-refusal");
        let (runtime, _handles) =
            speedwave_runtime::runtime::mock_runtime::MockRuntimeBuilder::new()
                .push_exec_piped_failure("container is not responding")
                .push_exec_piped_failure("container is not responding")
                .build();
        speedwave_runtime::session::reap_instance(&runtime, &container, "leaked")
            .expect_err("the first reap fails");

        let refused = speedwave_runtime::session::reap_unconfirmed(&runtime, &container)
            .map_err(|e| failure_before_swap(true, e))
            .expect_err("the kept instance is still not confirmed gone");
        speedwave_runtime::session::reap_unconfirmed(&runtime, &container)
            .expect("a reap that succeeds lets the next start through");

        assert!(refused.starts_with(MSG_SESSION_KEPT), "{refused}");
        assert!(refused.contains("could not be stopped"), "{refused}");
    }

    #[test]
    fn a_kept_session_error_keeps_the_sign_in_wording_the_frontend_matches() {
        let refused = kept_session_error(anyhow::anyhow!("{}", crate::MSG_NOT_AUTHENTICATED));

        assert!(refused.starts_with(MSG_SESSION_KEPT), "{refused}");
        assert!(refused.contains("not authenticated"), "{refused}");
    }

    #[test]
    fn session_kept_marker_matches_ts() {
        let ts = include_str!("../../src/src/app/services/chat-session-store.ts");
        assert!(
            ts.contains(&format!("SESSION_KEPT_MARKER = '{MSG_SESSION_KEPT}'")),
            "chat-session-store.ts must match the backend's kept-session prefix"
        );
    }

    #[test]
    fn a_message_waits_for_the_first_turn_without_holding_the_session() {
        let session_arc = session_for("test-project");
        let gate = session_arc.lock().unwrap().hold_first_turn();
        let sent = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let sender = {
            let session_arc = session_arc.clone();
            let sent = sent.clone();
            let gate = gate.clone();
            std::thread::spawn(move || {
                ready_tx.send(()).unwrap();
                write_after(&session_arc, &gate, |_| {
                    sent.store(true, std::sync::atomic::Ordering::SeqCst);
                    Ok(())
                })
            })
        };
        ready_rx.recv().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(50));

        assert!(!sent.load(std::sync::atomic::Ordering::SeqCst));
        assert!(
            session_arc.try_lock().is_ok(),
            "the wait must not hold the session"
        );
        gate.release();
        sender.join().unwrap().unwrap();
        assert!(sent.load(std::sync::atomic::Ordering::SeqCst));
    }

    #[test]
    fn a_message_to_a_session_without_a_model_switch_goes_at_once() {
        let session_arc = session_for("test-project");
        let started = std::time::Instant::now();

        after_first_turn(&session_arc, |_| Ok(())).unwrap();

        assert!(started.elapsed() < std::time::Duration::from_secs(1));
    }

    #[test]
    fn start_session_inner_starts_through_the_first_turn_wait() {
        let source = include_str!("chat_session_cmd.rs");
        let body = extract_fn_body(source, "fn start_session_inner(");
        let wrapped = body
            .find("start_then_await_first_turn(&entry.session, |session| {")
            .expect("the start goes through the first-turn wait");
        let start = body.find(".start(").expect("the start");

        assert!(wrapped < start);
    }

    #[test]
    fn a_start_waits_for_its_first_turn_with_the_session_released() {
        let session_arc = session_for("test-project");
        let (gate_tx, gate_rx) = std::sync::mpsc::channel();
        let starter = {
            let session_arc = session_arc.clone();
            std::thread::spawn(move || {
                start_then_await_first_turn(&session_arc, |session| {
                    gate_tx.send(session.hold_first_turn()).unwrap();
                    Ok(())
                })
            })
        };
        let gate = gate_rx.recv().unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while session_arc.try_lock().is_err() {
            assert!(
                std::time::Instant::now() < deadline,
                "the start must release the session while it waits"
            );
            std::thread::sleep(std::time::Duration::from_millis(5));
        }

        assert!(
            !starter.is_finished(),
            "the start returns only once the first turn may go"
        );
        gate.release();
        assert_eq!(starter.join().unwrap(), Ok(()));
    }

    #[test]
    fn a_start_that_fails_returns_its_error_without_waiting() {
        let session_arc = session_for("test-project");
        let started = std::time::Instant::now();

        let result = start_then_await_first_turn(&session_arc, |session| {
            session.hold_first_turn();
            Err("failed to spawn claude".to_string())
        });

        assert_eq!(result, Err("failed to spawn claude".to_string()));
        assert!(started.elapsed() < std::time::Duration::from_secs(1));
    }

    #[test]
    fn a_model_pick_for_another_project_never_waits_for_this_tabs_first_turn() {
        let (reg, entry) = registry_with("project-b");
        let _gate = entry.session.lock().unwrap().hold_first_turn();
        let started = std::time::Instant::now();

        let result = tab_session_for_project(&reg, TAB_A, "project-a")
            .and_then(|session_arc| switch_model_inner(&session_arc, "claude-haiku-4-5"));

        assert_eq!(result.err(), Some(MSG_NO_SESSION_FOR_PROJECT.to_string()));
        assert!(started.elapsed() < std::time::Duration::from_secs(1));
    }

    #[test]
    fn a_model_pick_waits_for_the_first_turn_of_a_new_session() {
        let session_arc = session_for("test-project");
        let gate = session_arc.lock().unwrap().hold_first_turn();
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let picker = {
            let session_arc = session_arc.clone();
            std::thread::spawn(move || {
                ready_tx.send(()).unwrap();
                switch_model_inner(&session_arc, "claude-haiku-4-5")
            })
        };
        ready_rx.recv().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(50));

        assert!(!picker.is_finished(), "the pick waits for the soft-impose");
        assert!(
            session_arc.try_lock().is_ok(),
            "the pick must not hold the session while it waits"
        );
        gate.release();
        let Err(err) = picker.join().unwrap() else {
            panic!("a session without a process cannot take the pick");
        };
        assert!(err.contains("no active session"), "{err}");
    }

    #[test]
    fn a_model_pick_waits_again_when_its_project_session_restarts_during_the_wait() {
        let session_arc = session_for("test-project");
        let first = session_arc.lock().unwrap().hold_first_turn();
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let picker = {
            let session_arc = session_arc.clone();
            std::thread::spawn(move || {
                ready_tx.send(()).unwrap();
                switch_model_inner(&session_arc, "claude-haiku-4-5")
            })
        };
        ready_rx.recv().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(50));

        let second = session_arc.lock().unwrap().hold_first_turn();
        first.release();
        std::thread::sleep(std::time::Duration::from_millis(50));
        assert!(
            !picker.is_finished(),
            "the pick waits for the restarted session's own soft-impose"
        );

        second.release();
        let Err(err) = picker.join().unwrap() else {
            panic!("a session without a process cannot take the pick");
        };
        assert!(err.contains("no active session"), "{err}");
        assert_ne!(err, MSG_SESSION_REPLACED);
    }

    #[test]
    fn a_model_pick_whose_tab_was_rebound_to_another_project_never_reaches_the_new_session() {
        let (reg, entry) = registry_with("test-project");
        let gate = entry.session.lock().unwrap().hold_first_turn();
        let session_arc = tab_session_for_project(&reg, TAB_A, "test-project").unwrap();
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let picker = std::thread::spawn(move || {
            ready_tx.send(()).unwrap();
            switch_model_inner(&session_arc, "claude-haiku-4-5")
        });
        ready_rx.recv().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(50));

        let rebound = reg.prepare(TAB_A, "other-project").unwrap();
        gate.release();

        assert!(!Arc::ptr_eq(&rebound.session, &entry.session));
        let Err(err) = picker.join().unwrap() else {
            panic!("the stopped session of the old project cannot take the pick");
        };
        assert!(err.contains("no active session"), "{err}");
    }

    #[test]
    fn a_failure_before_the_swap_says_kept_only_while_the_old_process_still_runs() {
        assert!(failure_before_swap(true, "not signed in").starts_with(MSG_SESSION_KEPT));
        assert_eq!(failure_before_swap(false, "not signed in"), "not signed in");
    }

    #[test]
    fn a_recreate_for_a_new_oauth_worker_drops_the_kept_marker_after_it() {
        let source = include_str!("chat_session_cmd.rs");
        let body = extract_fn_body(source, "fn start_session_inner(");
        let recreate = body
            .find("let recreated =")
            .expect("the start records whether it recreated the containers");
        let swap = body.find("std::mem::replace(").expect("the swap");
        let after_recreate = &body[recreate..swap];

        assert!(body[recreate..].contains("recreate_project_containers_if_running(project)"));
        assert!(!after_recreate.contains(".map_err(kept_session_error)"));
        assert!(after_recreate.contains("failure_before_swap(!recreated, e)"));
    }
}
