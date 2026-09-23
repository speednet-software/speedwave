use std::sync::{Arc, Mutex};

use crate::chat::{self, ChatSession};
use crate::chat_registry::{self, SharedChatSessions};
use crate::control_channel::{
    self, ContextUsage, ControlHandle, ControlQuery, PlanUsage, SessionInfoState,
};
use crate::reconcile::SharedOauth;
use crate::types::check_project;
use crate::{containers_cmd, ensure_oauth_running};
use crate::{setup_wizard, MSG_NOT_AUTHENTICATED};

fn start_session_inner(
    project: &str,
    tab_id: &str,
    resume_session_id: Option<&str>,
    registry: SharedChatSessions,
    oauth_arc: SharedOauth,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let entry = registry.prepare(tab_id, project);
    let _serialize = entry
        .start_serialize
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);

    registry.claim_transcript(tab_id, resume_session_id)?;

    let oauth_just_started = ensure_oauth_running(&oauth_arc, project);

    containers_cmd::ensure_images_ready()?;

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
    .map_err(|e| e.to_string())?;

    log::info!("extracting old session for this tab");
    let mut old_session = {
        let mut guard = entry
            .session
            .lock()
            .map_err(|e| format!("Lock poisoned: {e}"))?;
        std::mem::replace(
            &mut *guard,
            ChatSession::new(project, tab_id, entry.transcript.clone()),
        )
    };
    log::info!("stopping old session (outside lock)");
    old_session.stop().map_err(|e| e.to_string())?;
    drop(old_session);

    log::info!("starting new session");
    let mut session = entry
        .session
        .lock()
        .map_err(|e| format!("Lock poisoned: {e}"))?;
    let result = session
        .start(app_handle, resume_session_id)
        .map_err(|e| e.to_string());
    log::info!("session.start result={result:?}");
    result
}

#[tauri::command]
pub(crate) async fn start_chat(
    project: String,
    tab_id: String,
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
        start_session_inner(&project, &tab_id, None, registry, oauth_arc, app_handle)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn resume_conversation(
    project: String,
    session_id: String,
    tab_id: String,
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

const MSG_NO_SESSION_FOR_TAB: &str = "no chat session for this tab";

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
        let mut session = session_arc.try_lock().map_err(|_| {
            log::info!("try_lock failed sending message (session busy)");
            "no active session (session is being started)".to_string()
        })?;
        log::info!("lock acquired, sending message");
        session
            .send_message(&app_handle, &blocks)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
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
const MSG_NO_SESSION_FOR_PROJECT: &str = "no chat session for this project";

pub(crate) fn session_info_state_inner(
    registry: &SharedChatSessions,
    project: &str,
) -> SessionInfoState {
    let Some(session_arc) = registry.any_for_project(project) else {
        return SessionInfoState::Unavailable;
    };
    match session_arc.try_lock() {
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

fn takes_wire_effort_inner(registry: &SharedChatSessions, project: &str) -> bool {
    let Some(entry) = registry.entry_for_project(project) else {
        return false;
    };
    let _serialize = entry
        .start_serialize
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut session = entry
        .session
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    session.takes_wire_effort()
}

#[tauri::command]
pub(crate) async fn get_chat_takes_wire_effort(
    project: String,
    state: tauri::State<'_, SharedChatSessions>,
) -> Result<bool, String> {
    check_project(&project)?;
    let registry = state.inner().clone();
    tokio::task::spawn_blocking(move || takes_wire_effort_inner(&registry, &project))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn get_chat_session_info(
    project: String,
    state: tauri::State<'_, SharedChatSessions>,
) -> Result<SessionInfoState, String> {
    check_project(&project)?;
    Ok(session_info_state_inner(state.inner(), &project))
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
    state: tauri::State<'_, SharedChatSessions>,
) -> Result<ContextUsage, String> {
    check_project(&project)?;
    let registry = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        control_query_inner(
            &registry,
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
    fn a_live_process_launched_with_effort_takes_the_wire() {
        let (reg, entry) = registry_with("acme");
        entry
            .session
            .lock()
            .unwrap()
            .set_test_process(chat::spawn_test_child(chat::TestChild::Blocked), true);
        assert!(takes_wire_effort_inner(&reg, "acme"));
        assert!(
            !takes_wire_effort_inner(&reg, "other"),
            "another project's session says nothing about this one"
        );
    }

    #[test]
    fn a_process_without_effort_or_without_life_does_not_take_the_wire() {
        let (never_spawned, _entry) = registry_with("acme");
        assert!(!takes_wire_effort_inner(&never_spawned, "acme"));

        let (unpinned, entry) = registry_with("acme");
        entry
            .session
            .lock()
            .unwrap()
            .set_test_process(chat::spawn_test_child(chat::TestChild::Blocked), false);
        assert!(!takes_wire_effort_inner(&unpinned, "acme"));

        let (exited, entry) = registry_with("acme");
        entry
            .session
            .lock()
            .unwrap()
            .set_test_process(chat::spawn_test_child(chat::TestChild::Exited), true);
        assert!(!takes_wire_effort_inner(&exited, "acme"));
    }

    #[test]
    fn the_wire_effort_answer_waits_for_a_start_in_progress() {
        let (reg, entry) = registry_with("acme");
        entry
            .session
            .lock()
            .unwrap()
            .set_test_process(chat::spawn_test_child(chat::TestChild::Blocked), true);
        let starting = entry
            .start_serialize
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let reader = {
            let reg = reg.clone();
            std::thread::spawn(move || takes_wire_effort_inner(&reg, "acme"))
        };
        std::thread::sleep(std::time::Duration::from_millis(50));
        assert!(
            !reader.is_finished(),
            "a start stopping the old process holds only the tab serializer, and must not read as a hold"
        );
        drop(starting);
        assert!(reader.join().unwrap());
    }

    #[test]
    fn the_wire_effort_answer_waits_for_the_session_lock() {
        let (reg, entry) = registry_with("acme");
        entry
            .session
            .lock()
            .unwrap()
            .set_test_process(chat::spawn_test_child(chat::TestChild::Blocked), true);
        let held = entry.session.lock().unwrap();
        let reader = {
            let reg = reg.clone();
            std::thread::spawn(move || takes_wire_effort_inner(&reg, "acme"))
        };
        std::thread::sleep(std::time::Duration::from_millis(50));
        assert!(
            !reader.is_finished(),
            "a busy session must not read as a held one"
        );
        drop(held);
        assert!(reader.join().unwrap());
    }

    #[test]
    fn get_chat_takes_wire_effort_uses_spawn_blocking() {
        let source = include_str!("chat_session_cmd.rs");
        let body = extract_fn_body(source, "async fn get_chat_takes_wire_effort(");
        assert!(
            body.contains("spawn_blocking"),
            "the blocking session lock must not run on the async runtime"
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
    fn two_tabs_start_without_serializing_on_each_other() {
        let reg = ChatSessions::default();
        let a = reg.prepare(TAB_A, "acme");
        let b = reg.prepare(TAB_B, "acme");
        let _held_a = a.start_serialize.lock().unwrap();
        assert!(
            b.start_serialize.try_lock().is_ok(),
            "tab B's start must not wait on tab A's serializer"
        );
    }

    #[test]
    fn start_session_inner_claims_the_transcript_before_any_start_work() {
        let source = include_str!("chat_session_cmd.rs");
        let body = extract_fn_body(source, "fn start_session_inner(");
        let claim_pos = body
            .find("claim_transcript")
            .expect("start_session_inner must claim the transcript for this tab");
        let work_pos = body
            .find("ensure_oauth_running")
            .expect("start_session_inner must call ensure_oauth_running");
        assert!(
            claim_pos < work_pos,
            "the resume dedup must reject a doubly-opened conversation before any start work"
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
        let source = include_str!("chat_session_cmd.rs");
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
        let entry = reg.prepare(TAB_A, "acme");
        let resolved = tab_session(&reg, TAB_A).unwrap();
        assert!(Arc::ptr_eq(&resolved, &entry.session));
    }

    #[test]
    fn stopping_one_tab_leaves_the_sibling_untouched() {
        let reg = ChatSessions::default();
        let a = reg.prepare(TAB_A, "acme");
        let b = reg.prepare(TAB_B, "acme");
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
}
