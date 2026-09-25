use crate::chat::{self, ChatSession, SharedChatSession};
use crate::control_channel::{
    self, ContextUsage, ControlHandle, ControlQuery, ModelSwitchOutcome, PlanUsage,
    SessionInfoState,
};
use crate::reconcile::SharedOauth;
use crate::types::check_project;
use crate::{containers_cmd, ensure_oauth_running};
use crate::{setup_wizard, MSG_NOT_AUTHENTICATED};

static START_SERIALIZE: std::sync::Mutex<()> = std::sync::Mutex::new(());

const MSG_SESSION_KEPT: &str = "the running chat session was kept";

fn kept_session_error(e: impl std::fmt::Display) -> String {
    format!("{MSG_SESSION_KEPT}: {e}")
}

fn start_session_inner(
    project: &str,
    resume_session_id: Option<&str>,
    session_arc: SharedChatSession,
    oauth_arc: SharedOauth,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let _serialize = START_SERIALIZE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);

    let oauth_just_started = ensure_oauth_running(&oauth_arc, project);

    containers_cmd::ensure_images_ready().map_err(kept_session_error)?;

    if oauth_just_started {
        containers_cmd::recreate_project_containers_if_running(project);
    }

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
    .map_err(kept_session_error)?;

    log::info!("extracting old session");
    let mut old_session = {
        let mut guard = session_arc
            .lock()
            .map_err(|e| format!("Lock poisoned: {e}"))
            .map_err(kept_session_error)?;
        std::mem::replace(&mut *guard, ChatSession::new(project))
    };
    log::info!("stopping old session (outside lock)");
    old_session.stop().map_err(|e| e.to_string())?;
    drop(old_session);

    log::info!("starting new session");
    let first_turn = {
        let mut session = session_arc
            .lock()
            .map_err(|e| format!("Lock poisoned: {e}"))?;
        let result = session
            .start(app_handle, resume_session_id)
            .map_err(|e| e.to_string());
        log::info!("session.start result={result:?}");
        result?;
        session.first_turn_gate()
    };
    if !first_turn.wait(control_channel::SET_MODEL_TIMEOUT) {
        log::warn!("the new session's model switch did not settle before the first turn");
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn start_chat(
    project: String,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, SharedChatSession>,
    oauth: tauri::State<'_, SharedOauth>,
) -> Result<(), String> {
    check_project(&project)?;
    log::info!("starting chat for project={project}");
    let session_arc = state.inner().clone();
    let oauth_arc = oauth.inner().clone();
    tokio::task::spawn_blocking(move || {
        start_session_inner(&project, None, session_arc, oauth_arc, app_handle)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn send_message(
    app_handle: tauri::AppHandle,
    blocks: Vec<chat::WireContentBlock>,
    display_text: String,
    state: tauri::State<'_, SharedChatSession>,
) -> Result<(), String> {
    if display_text.len() > chat::MAX_MESSAGE_LEN {
        return Err("Message too long".to_string());
    }
    log::info!(
        "sending message: blocks={}, display_len={}",
        blocks.len(),
        display_text.len()
    );
    let session_arc = state.inner().clone();
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
    session_arc: &SharedChatSession,
    input: impl FnOnce(&mut ChatSession) -> Result<T, String>,
) -> Result<T, String> {
    let first_turn = lock_session_for_input(session_arc)?.first_turn_gate();
    if !first_turn.wait(control_channel::SET_MODEL_TIMEOUT) {
        log::warn!("sending before the session's model switch settled");
    }
    let mut session = lock_session_for_input(session_arc)?;
    if !session.first_turn_gate().is(&first_turn) {
        log::info!("the chat session was replaced while a message waited for its first turn");
        return Err(MSG_SESSION_REPLACED.to_string());
    }
    input(&mut session)
}

#[tauri::command]
pub(crate) async fn submit_question_answer(
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
        let mut session = lock_session_for_input(&session_arc)?;
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

#[tauri::command]
pub(crate) async fn stop_chat(state: tauri::State<'_, SharedChatSession>) -> Result<(), String> {
    log::info!("interrupting chat turn");
    let session_arc = state.inner().clone();
    tokio::task::spawn_blocking(move || stop_chat_inner(session_arc))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn resume_conversation(
    project: String,
    session_id: String,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, SharedChatSession>,
    oauth: tauri::State<'_, SharedOauth>,
) -> Result<(), String> {
    check_project(&project)?;
    crate::history::validate_session_id(&session_id).map_err(|e| e.to_string())?;
    log::info!("resuming conversation for project={project}");
    let session_arc = state.inner().clone();
    let oauth_arc = oauth.inner().clone();
    tokio::task::spawn_blocking(move || {
        start_session_inner(
            &project,
            Some(&session_id),
            session_arc,
            oauth_arc,
            app_handle,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

const MSG_SESSION_BUSY: &str = "chat session is busy";
const MSG_SESSION_REPLACED: &str = "the chat session was replaced before the message was written";
const MSG_NO_SESSION_FOR_PROJECT: &str = "no chat session for this project";

const INPUT_LOCK_WAIT: std::time::Duration = std::time::Duration::from_millis(50);
const INPUT_LOCK_POLL: std::time::Duration = std::time::Duration::from_millis(2);

fn lock_session_for_input(
    session_arc: &SharedChatSession,
) -> Result<std::sync::MutexGuard<'_, ChatSession>, String> {
    lock_session_within(session_arc, INPUT_LOCK_WAIT)
}

fn lock_session_within(
    session_arc: &SharedChatSession,
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
    session_arc: &SharedChatSession,
    project: &str,
) -> SessionInfoState {
    match session_arc.try_lock() {
        Ok(session) if session.project_name() == project => session.session_info_state(),
        _ => SessionInfoState::Unavailable,
    }
}

fn control_handle_for(
    session_arc: &SharedChatSession,
    project: &str,
) -> Result<ControlHandle, String> {
    let session = session_arc
        .try_lock()
        .map_err(|_| MSG_SESSION_BUSY.to_string())?;
    take_from_project_session(&session, project, ChatSession::control_handle)
}

fn take_from_project_session<T>(
    session: &ChatSession,
    project: &str,
    take: impl FnOnce(&ChatSession) -> anyhow::Result<T>,
) -> Result<T, String> {
    if session.project_name() != project {
        return Err(MSG_NO_SESSION_FOR_PROJECT.to_string());
    }
    take(session).map_err(|e| e.to_string())
}

fn control_query_inner<T>(
    session_arc: &SharedChatSession,
    project: &str,
    query: ControlQuery,
    parse: fn(&serde_json::Value) -> Result<T, control_channel::ControlError>,
) -> Result<T, String> {
    let handle = control_handle_for(session_arc, project)?;
    handle
        .query(query)
        .and_then(|value| parse(&value))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn get_chat_session_info(
    project: String,
    state: tauri::State<'_, SharedChatSession>,
) -> Result<SessionInfoState, String> {
    check_project(&project)?;
    Ok(session_info_state_inner(state.inner(), &project))
}

const MAX_MODEL_ID_LEN: usize = 256;

fn validate_model_pick(model: &str) -> Result<(), String> {
    if model.is_empty() {
        return Err("model must not be empty".to_string());
    }
    if model.len() > MAX_MODEL_ID_LEN {
        return Err(format!("model id is longer than {MAX_MODEL_ID_LEN} bytes"));
    }
    if model.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("model id must not contain whitespace or control characters".to_string());
    }
    Ok(())
}

fn live_session_input<T>(
    session_arc: &SharedChatSession,
    project: &str,
    take: impl FnOnce(&ChatSession) -> anyhow::Result<T>,
) -> Result<T, String> {
    let session = lock_session_for_input(session_arc)?;
    take_from_project_session(&session, project, take)
}

fn switch_model_inner(
    session_arc: &SharedChatSession,
    project: &str,
    model: &str,
) -> Result<ModelSwitchOutcome, String> {
    let switch = live_session_input(session_arc, project, ChatSession::model_switch)?;
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
    model: String,
    state: tauri::State<'_, SharedChatSession>,
) -> Result<ModelSwitchOutcome, String> {
    check_project(&project)?;
    validate_model_pick(&model)?;
    let session_arc = state.inner().clone();
    tokio::task::spawn_blocking(move || switch_model_inner(&session_arc, &project, &model))
        .await
        .map_err(|e| e.to_string())?
}

fn apply_effort_inner(
    session_arc: &SharedChatSession,
    project: &str,
    level: &str,
) -> Result<(), String> {
    let handle = live_session_input(session_arc, project, ChatSession::control_handle)?;
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
    level: String,
    state: tauri::State<'_, SharedChatSession>,
) -> Result<(), String> {
    check_project(&project)?;
    crate::pin_cmd::validate_effort_level(&level)?;
    let session_arc = state.inner().clone();
    tokio::task::spawn_blocking(move || apply_effort_inner(&session_arc, &project, &level))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn get_plan_usage(
    project: String,
    state: tauri::State<'_, SharedChatSession>,
) -> Result<PlanUsage, String> {
    check_project(&project)?;
    let session_arc = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        control_query_inner(
            &session_arc,
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
    state: tauri::State<'_, SharedChatSession>,
) -> Result<ContextUsage, String> {
    check_project(&project)?;
    let session_arc = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        control_query_inner(
            &session_arc,
            &project,
            ControlQuery::ContextUsage,
            control_channel::parse_context_usage,
        )
        .map(ContextUsage::without_free_space)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "test assertions may unwrap/expect freely"
)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[test]
    fn session_info_is_unavailable_without_a_live_session() {
        let session_arc: SharedChatSession = Arc::new(Mutex::new(ChatSession::new("acme")));
        assert_eq!(
            session_info_state_inner(&session_arc, "acme"),
            SessionInfoState::Unavailable
        );
    }

    #[test]
    fn session_info_is_unavailable_for_another_project_and_while_the_session_is_locked() {
        let session_arc: SharedChatSession = Arc::new(Mutex::new(ChatSession::new("acme")));
        assert_eq!(
            session_info_state_inner(&session_arc, "other"),
            SessionInfoState::Unavailable
        );
        let _held = session_arc.lock().unwrap();
        assert_eq!(
            session_info_state_inner(&session_arc, "acme"),
            SessionInfoState::Unavailable
        );
    }

    fn assert_the_pick_leaves_the_session_free_while_it_waits<T>(
        pick: fn(&SharedChatSession) -> Result<T, String>,
    ) where
        T: std::fmt::Debug + PartialEq + Send + 'static,
    {
        let session_arc: SharedChatSession = Arc::new(Mutex::new(ChatSession::new("acme")));
        let control = {
            let mut session = session_arc.lock().unwrap();
            session.set_test_stdin_sink(Vec::new());
            session.control_channel_for_test()
        };
        let picker = {
            let session_arc = session_arc.clone();
            std::thread::spawn(move || pick(&session_arc))
        };
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while control.pending_ids().is_empty() {
            if picker.is_finished() {
                panic!(
                    "the pick ended before it waited for Claude Code: {:?}",
                    picker.join()
                );
            }
            assert!(
                std::time::Instant::now() < deadline,
                "the pick never registered its request"
            );
            std::thread::yield_now();
        }

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

    #[test]
    fn an_effort_pick_leaves_the_session_free_while_it_waits_for_the_answer() {
        assert_the_pick_leaves_the_session_free_while_it_waits(|session_arc| {
            apply_effort_inner(session_arc, "acme", "low")
        });
    }

    #[test]
    fn a_model_pick_leaves_the_session_free_while_it_waits_for_the_answer() {
        assert_the_pick_leaves_the_session_free_while_it_waits(|session_arc| {
            switch_model_inner(session_arc, "acme", "claude-haiku-4-5")
        });
    }

    #[test]
    fn an_effort_pick_needs_a_live_session_of_the_same_project() {
        let session_arc: SharedChatSession = Arc::new(Mutex::new(ChatSession::new("acme")));

        let other = apply_effort_inner(&session_arc, "other", "low");
        let idle = apply_effort_inner(&session_arc, "acme", "low");

        assert_eq!(other, Err(MSG_NO_SESSION_FOR_PROJECT.to_string()));
        assert!(idle.unwrap_err().contains("no active session"));
    }

    #[test]
    fn an_effort_pick_on_a_session_held_by_another_command_says_it_is_busy() {
        let session_arc: SharedChatSession = Arc::new(Mutex::new(ChatSession::new("acme")));
        let _held = session_arc.lock().unwrap();

        let picked = apply_effort_inner(&session_arc, "acme", "high");

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
    fn control_query_without_a_live_session_errors_instead_of_waiting() {
        let session_arc: SharedChatSession = Arc::new(Mutex::new(ChatSession::new("acme")));
        let err = control_query_inner(
            &session_arc,
            "acme",
            ControlQuery::Usage,
            control_channel::parse_plan_usage,
        )
        .unwrap_err();
        assert_eq!(err, "no active session");
    }

    #[test]
    fn control_query_rejects_a_project_the_session_does_not_belong_to() {
        let session_arc: SharedChatSession = Arc::new(Mutex::new(ChatSession::new("acme")));
        let err = control_query_inner(
            &session_arc,
            "other",
            ControlQuery::ContextUsage,
            control_channel::parse_context_usage,
        )
        .unwrap_err();
        assert_eq!(err, MSG_NO_SESSION_FOR_PROJECT);
    }

    #[test]
    fn control_query_never_waits_for_a_session_that_is_being_started() {
        let session_arc: SharedChatSession = Arc::new(Mutex::new(ChatSession::new("acme")));
        let _held = session_arc.lock().unwrap();
        let err = control_query_inner(
            &session_arc,
            "acme",
            ControlQuery::Usage,
            control_channel::parse_plan_usage,
        )
        .unwrap_err();
        assert_eq!(err, MSG_SESSION_BUSY);
    }

    #[test]
    fn input_to_a_session_held_by_another_command_is_refused_as_busy() {
        let session_arc: SharedChatSession = Arc::new(Mutex::new(ChatSession::new("acme")));
        let held = session_arc.lock().unwrap();
        let Err(err) = lock_session_for_input(&session_arc) else {
            panic!("a session another command holds must not be taken for input");
        };
        assert_eq!(err, MSG_SESSION_BUSY);
        drop(held);
        assert_eq!(
            lock_session_for_input(&session_arc).unwrap().project_name(),
            "acme"
        );
    }

    #[test]
    fn input_waits_out_a_brief_hold() {
        let session_arc: SharedChatSession = Arc::new(Mutex::new(ChatSession::new("acme")));
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
        let session = lock_session_within(&session_arc, std::time::Duration::from_secs(30))
            .expect("a hold that ends within the wait must let the input through");
        assert_eq!(session.project_name(), "acme");
        drop(session);
        holder.join().unwrap();
    }

    #[test]
    fn send_retry_triggers_in_ts_never_match_the_busy_error() {
        let ts = include_str!("../../src/src/app/services/chat-state.service.ts");
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
        let session_arc: SharedChatSession =
            std::sync::Arc::new(std::sync::Mutex::new(ChatSession::new("test-project")));
        let gate = session_arc.lock().unwrap().hold_first_turn();
        let written = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let sender = {
            let session_arc = session_arc.clone();
            let written = written.clone();
            std::thread::spawn(move || {
                after_first_turn(&session_arc, |_| {
                    written.store(true, std::sync::atomic::Ordering::SeqCst);
                    Ok(())
                })
            })
        };
        std::thread::sleep(std::time::Duration::from_millis(100));

        *session_arc.lock().unwrap() = ChatSession::new("test-project");
        gate.release();

        assert_eq!(
            sender.join().unwrap(),
            Err(MSG_SESSION_REPLACED.to_string())
        );
        assert!(!written.load(std::sync::atomic::Ordering::SeqCst));
    }

    #[test]
    fn input_to_a_poisoned_session_reports_the_poison() {
        let session_arc: SharedChatSession = Arc::new(Mutex::new(ChatSession::new("acme")));
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
        let too_long = "m".repeat(MAX_MODEL_ID_LEN + 1);
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
    fn a_model_pick_needs_a_live_session_of_the_same_project() {
        let session_arc: SharedChatSession = Arc::new(Mutex::new(ChatSession::new("acme")));

        let other = switch_model_inner(&session_arc, "other", "claude-haiku-4-5");
        let idle = switch_model_inner(&session_arc, "acme", "claude-haiku-4-5");

        assert_eq!(other, Err(MSG_NO_SESSION_FOR_PROJECT.to_string()));
        assert!(idle.unwrap_err().contains("no active session"));
    }

    #[test]
    fn a_model_pick_on_a_session_held_by_another_command_says_it_is_busy() {
        let session_arc: SharedChatSession = Arc::new(Mutex::new(ChatSession::new("acme")));
        let _held = session_arc.lock().unwrap();

        let picked = switch_model_inner(&session_arc, "acme", "claude-haiku-4-5");

        assert_eq!(picked, Err(MSG_SESSION_BUSY.to_string()));
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
    fn start_session_inner_serializes_before_any_start_stop() {
        let source = include_str!("chat_session_cmd.rs");
        let body = extract_fn_body(source, "fn start_session_inner(");
        let guard_pos = body
            .find("START_SERIALIZE")
            .expect("start_session_inner must acquire START_SERIALIZE");
        let work_pos = body
            .find("ensure_oauth_running")
            .expect("start_session_inner must call ensure_oauth_running");
        assert!(
            guard_pos < work_pos,
            "START_SERIALIZE must be acquired before any start/stop work"
        );
    }

    #[test]
    fn start_serialize_mutex_admits_one_holder_at_a_time() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;
        let live = Arc::new(AtomicUsize::new(0));
        let max = Arc::new(AtomicUsize::new(0));
        let mut handles = Vec::new();
        for _ in 0..8 {
            let live = live.clone();
            let max = max.clone();
            handles.push(std::thread::spawn(move || {
                let _g = START_SERIALIZE
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                let now = live.fetch_add(1, Ordering::SeqCst) + 1;
                max.fetch_max(now, Ordering::SeqCst);
                std::thread::sleep(std::time::Duration::from_millis(5));
                live.fetch_sub(1, Ordering::SeqCst);
            }));
        }
        for h in handles {
            h.join().unwrap();
        }
        assert_eq!(
            max.load(Ordering::SeqCst),
            1,
            "START_SERIALIZE must admit only one start at a time"
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
            .find(".start(app_handle")
            .expect("start_session_inner must call session.start(app_handle, ...)");

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
                .count(),
            "a failure before the swap leaves the running session in place and must say so"
        );
        let after_stop = &body[body.find("old_session.stop()").unwrap()..];
        assert!(!after_stop.contains("kept_session_error"));
    }

    #[test]
    fn a_kept_session_error_keeps_the_sign_in_wording_the_frontend_matches() {
        let refused = kept_session_error(anyhow::anyhow!("{}", crate::MSG_NOT_AUTHENTICATED));

        assert!(refused.starts_with(MSG_SESSION_KEPT), "{refused}");
        assert!(refused.contains("not authenticated"), "{refused}");
    }

    #[test]
    fn session_kept_marker_matches_ts() {
        let ts = include_str!("../../src/src/app/services/chat-state.service.ts");
        assert!(
            ts.contains(&format!("SESSION_KEPT_MARKER = '{MSG_SESSION_KEPT}'")),
            "chat-state.service.ts must match the backend's kept-session prefix"
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
    fn start_session_inner_acquires_session_lock() {
        let source = include_str!("chat_session_cmd.rs");
        let body = extract_fn_body(source, "fn start_session_inner(");
        assert!(
            body.contains("session_arc") && body.contains(".lock()"),
            "start_session_inner must acquire the session lock"
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
    fn a_message_waits_for_the_first_turn_without_holding_the_session() {
        let session_arc: SharedChatSession =
            std::sync::Arc::new(std::sync::Mutex::new(ChatSession::new("test-project")));
        let gate = session_arc.lock().unwrap().hold_first_turn();
        let sent = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let sender = {
            let session_arc = session_arc.clone();
            let sent = sent.clone();
            std::thread::spawn(move || {
                after_first_turn(&session_arc, |_| {
                    sent.store(true, std::sync::atomic::Ordering::SeqCst);
                    Ok(())
                })
            })
        };
        std::thread::sleep(std::time::Duration::from_millis(100));

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
        let session_arc: SharedChatSession =
            std::sync::Arc::new(std::sync::Mutex::new(ChatSession::new("test-project")));
        let started = std::time::Instant::now();

        after_first_turn(&session_arc, |_| Ok(())).unwrap();

        assert!(started.elapsed() < std::time::Duration::from_secs(1));
    }

    #[test]
    fn start_session_inner_waits_for_the_first_turn_after_it_releases_the_session() {
        let source = include_str!("chat_session_cmd.rs");
        let body = extract_fn_body(source, "fn start_session_inner(");
        let scope = body
            .find("let first_turn = {")
            .expect("the start runs in its own lock scope");
        let start = body
            .find(".start(app_handle, resume_session_id)")
            .expect("the start");
        let gate = body
            .find("session.first_turn_gate()")
            .expect("the gate is read under the lock");
        let scope_end = scope + body[scope..].find("\n    };").expect("the lock scope ends");
        let wait = body.find("first_turn.wait(").expect("the wait");

        assert!(scope < start && start < gate && gate < scope_end && scope_end < wait);
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
    fn stop_chat_inner_without_active_session_errors() {
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
        let source = include_str!("chat_session_cmd.rs");
        let body = extract_fn_body(source, "async fn stop_chat(");
        assert!(
            body.contains("spawn_blocking"),
            "stop_chat must use spawn_blocking to avoid blocking the main thread"
        );
    }
}
