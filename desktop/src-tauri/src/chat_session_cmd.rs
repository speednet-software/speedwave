// Chat session lifecycle Tauri commands wrapping `ChatSession`:
// start/resume a session, send a message, submit an ask-user answer, interrupt.

use crate::chat::{self, ChatSession, SharedChatSession};
use crate::reconcile::SharedOauth;
use crate::types::check_project;
use crate::{containers_cmd, ensure_oauth_running};
use crate::{setup_wizard, MSG_NOT_AUTHENTICATED};

/// Serialises start/stop/start so `start_chat`/`resume_conversation` can't
/// interleave. Poison is recovered: this guards ordering, not data invariants.
static START_SERIALIZE: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Shared impl for `start_chat`/`resume_conversation`: locks + checks auth,
/// stops the old session outside the session lock, then starts the new one under it.
fn start_session_inner(
    project: &str,
    resume_session_id: Option<&str>,
    model_override: Option<&str>,
    session_arc: SharedChatSession,
    oauth_arc: SharedOauth,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let _serialize = START_SERIALIZE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);

    let oauth_just_started = ensure_oauth_running(&oauth_arc, project);

    containers_cmd::ensure_images_ready()?;

    if oauth_just_started {
        containers_cmd::recreate_project_containers_if_running(project);
    }

    // Per-project compose lock serialises auth check with concurrent compose ops.
    log::info!("acquiring compose lock");
    let rt = speedwave_runtime::runtime::detect_runtime();
    // `_rt` unused: `check_claude_auth` builds its own (reentrant via HELD_LOCKS).
    rt.transaction(project, |_rt| -> anyhow::Result<()> {
        log::info!("compose lock acquired, checking auth");
        let authed = setup_wizard::check_claude_auth(project)?;
        if !authed {
            anyhow::bail!("{}", MSG_NOT_AUTHENTICATED);
        }
        Ok(())
    })
    .map_err(|e| e.to_string())?;

    // Extract old session and stop it outside the lock.
    log::info!("extracting old session");
    let mut old_session = {
        let mut guard = session_arc
            .lock()
            .map_err(|e| format!("Lock poisoned: {e}"))?;
        std::mem::replace(&mut *guard, ChatSession::new(project))
    };
    log::info!("stopping old session (outside lock)");
    old_session.stop().map_err(|e| e.to_string())?;
    drop(old_session);

    // Start the new session under the lock.
    log::info!("starting new session");
    let mut session = session_arc
        .lock()
        .map_err(|e| format!("Lock poisoned: {e}"))?;
    let result = session
        .start(app_handle, resume_session_id, model_override)
        .map_err(|e| e.to_string());
    log::info!("session.start result={result:?}");
    result
}

#[tauri::command]
pub(crate) async fn start_chat(
    project: String,
    model_override: Option<String>,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, SharedChatSession>,
    oauth: tauri::State<'_, SharedOauth>,
) -> Result<(), String> {
    check_project(&project)?;
    log::info!("starting chat for project={project}");
    let session_arc = state.inner().clone();
    let oauth_arc = oauth.inner().clone();
    tokio::task::spawn_blocking(move || {
        start_session_inner(
            &project,
            None,
            model_override.as_deref(),
            session_arc,
            oauth_arc,
            app_handle,
        )
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
    // `display_text` is the local-bubble preview; wire-size guard is in `send_message`.
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
            None,
            session_arc,
            oauth_arc,
            app_handle,
        )
    })
    .await
    .map_err(|e| e.to_string())?
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
    use std::sync::{Arc, Mutex};

    /// Extracts a function body from source by brace-counting from the first
    /// `split(fn_signature)` match, so `fn_signature` must be unique in the file.
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
        // The serialization guard must be taken before any oauth/image/stop work,
        // so overlapping start_chat/resume calls run strictly one at a time.
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
        // Two threads grab START_SERIALIZE; the concurrent-holder count never
        // exceeds 1 — proves the guard serialises overlapping starts.
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

    // -- spawn_blocking guard-rail tests --

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

    // -- validation-before-spawn tests --

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

    // -- JoinError handling tests --

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

    // -- stop_chat_inner tests --

    #[test]
    fn stop_chat_inner_without_active_session_errors() {
        // A fresh ChatSession has no stdin, so interrupt returns "no active session".
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
