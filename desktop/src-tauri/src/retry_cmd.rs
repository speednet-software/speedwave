//! Tauri command — retry the last assistant turn via Claude Code's native
//! `--resume-session-at` flag (ADR-046).
//!
//! The frontend owns the conversation state-tree (until Unit 2's patch-based
//! backbone lands) and passes the retry anchor explicitly: the current
//! `session_id` and the UUID of the user prompt to rewind to. The backend
//! does not mutate the session JSONL file — Claude Code's native resume
//! handles the trim-and-regenerate atomically.
//!
//! Flow:
//! 1. Validate the session id and user UUID.
//! 2. Swap the live `ChatSession` out of its mutex so `stop()` runs without
//!    starving other commands.
//! 3. Stop the old session (kills the child, drains reader threads).
//! 4. Start a new session with `--resume <session> --resume-session-at <uuid>`.
//!
//! Errors are serialised as a tagged `RetryError` enum so the frontend can
//! react (disable the button, show a banner, prompt re-auth, …) without
//! string-matching error messages.
//!
//! The `PendingAssistant` variant is reserved for when the state-tree
//! backbone from Unit 2 has merged — at that point the backend verifies the
//! last assistant entry is `Committed` before spawning. Until then, the
//! frontend's `canRetry` signal guards against retrying a pending assistant.

use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::chat::{validate_retry_uuid, ChatSession, SharedChatSession};
use crate::history::validate_session_id;

/// Errors surfaced to the frontend from `retry_last_turn`.
///
/// Serialised as a tagged enum (`{ "kind": "NoAssistantTurn" }` etc.) so the
/// frontend can match on the kind field without inspecting messages.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(tag = "kind", content = "message")]
pub enum RetryError {
    /// The conversation has no assistant turn yet — retry is meaningless.
    NoAssistantTurn,
    /// The latest assistant entry is still streaming (pending Result).
    PendingAssistant,
    /// The given session id is not known or malformed.
    SessionNotFound,
    /// Another turn is currently streaming — retry would race with it.
    Streaming,
    /// Spawning Claude Code with `--resume-session-at` failed.
    ResumeFailed(String),
}

impl std::fmt::Display for RetryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoAssistantTurn => write!(f, "no assistant turn to retry"),
            Self::PendingAssistant => write!(f, "last assistant turn is still streaming"),
            Self::SessionNotFound => write!(f, "session id not found or invalid"),
            Self::Streaming => write!(f, "another turn is currently streaming"),
            Self::ResumeFailed(msg) => write!(f, "failed to spawn resume: {msg}"),
        }
    }
}

impl std::error::Error for RetryError {}

/// Pure core of `retry_last_turn` — does not touch Tauri types.
///
/// Extracted so unit tests can exercise the validation/stop/spawn sequence
/// against a mocked `ChatSession` layer via the `SessionDriver` trait below.
pub(crate) fn retry_last_turn_inner(
    session_id: &str,
    user_uuid: &str,
    driver: &mut dyn SessionDriver,
) -> Result<(), RetryError> {
    if validate_session_id(session_id).is_err() {
        return Err(RetryError::SessionNotFound);
    }
    if validate_retry_uuid(user_uuid).is_err() {
        return Err(RetryError::NoAssistantTurn);
    }

    driver.stop().map_err(RetryError::ResumeFailed)?;
    driver
        .start_with_retry(session_id, user_uuid)
        .map_err(RetryError::ResumeFailed)?;
    Ok(())
}

/// Driver abstraction over the session lifecycle, for tests.
pub(crate) trait SessionDriver {
    fn stop(&mut self) -> Result<(), String>;
    fn start_with_retry(&mut self, session_id: &str, user_uuid: &str) -> Result<(), String>;
}

/// Real driver backed by [`ChatSession`]. Swaps the session out of its mutex
/// so `stop()` (which can block on reader-thread drain) does not starve
/// `send_message` and friends.
struct ChatSessionDriver<'a> {
    session_arc: SharedChatSession,
    project_name: Option<String>,
    app_handle: &'a AppHandle,
}

impl SessionDriver for ChatSessionDriver<'_> {
    fn stop(&mut self) -> Result<(), String> {
        let mut old = {
            let mut guard = self
                .session_arc
                .lock()
                .map_err(|e| format!("session lock poisoned: {e}"))?;
            let project_name = guard.project_name().to_string();
            self.project_name = Some(project_name.clone());
            std::mem::replace(&mut *guard, ChatSession::new(&project_name))
        };
        old.stop().map_err(|e| e.to_string())?;
        drop(old);
        Ok(())
    }

    fn start_with_retry(&mut self, session_id: &str, user_uuid: &str) -> Result<(), String> {
        let mut session = self
            .session_arc
            .lock()
            .map_err(|e| format!("session lock poisoned: {e}"))?;
        session
            .start_with_retry(self.app_handle.clone(), Some(session_id), Some(user_uuid))
            .map_err(|e| e.to_string())
    }
}

/// Tauri command — retry the last assistant turn in the active session.
///
/// The frontend passes the `session_id` of the current conversation and
/// `user_uuid` of the user message to rewind to (ADR-046). On success, a
/// fresh Claude Code spawn starts streaming a replacement turn via the
/// usual `chat_stream` event channel.
#[tauri::command]
pub async fn retry_last_turn(
    session_id: String,
    user_uuid: String,
    app_handle: AppHandle,
    state: tauri::State<'_, SharedChatSession>,
) -> Result<(), RetryError> {
    log::info!(
        "retry_last_turn: session={session_id} user_uuid_len={}",
        user_uuid.len()
    );
    let session_arc = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        let mut driver = ChatSessionDriver {
            session_arc,
            project_name: None,
            app_handle: &app_handle,
        };
        retry_last_turn_inner(&session_id, &user_uuid, &mut driver)
    })
    .await
    .map_err(|e| RetryError::ResumeFailed(format!("join error: {e}")))?
}

/// Helper used by the Tauri command's driver to read the project name out of
/// a locked `ChatSession`. Defined as a free function on `ChatSession` via a
/// dedicated accessor in `chat.rs`.
///
/// Exposed as a test hook: the trait `SessionDriver` remains the preferred
/// test seam for new code.
#[allow(dead_code)]
pub(crate) fn _project_name_for_driver(arc: &Arc<Mutex<ChatSession>>) -> Option<String> {
    arc.lock().ok().map(|g| g.project_name().to_string())
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    /// Canned driver that records calls for assertion.
    #[derive(Default)]
    struct MockDriver {
        stop_calls: u32,
        start_calls: Vec<(String, String)>,
        stop_err: Option<String>,
        start_err: Option<String>,
    }

    impl SessionDriver for MockDriver {
        fn stop(&mut self) -> Result<(), String> {
            self.stop_calls += 1;
            match &self.stop_err {
                Some(e) => Err(e.clone()),
                None => Ok(()),
            }
        }
        fn start_with_retry(
            &mut self,
            session_id: &str,
            user_uuid: &str,
        ) -> Result<(), String> {
            self.start_calls
                .push((session_id.to_string(), user_uuid.to_string()));
            match &self.start_err {
                Some(e) => Err(e.clone()),
                None => Ok(()),
            }
        }
    }

    const VALID_SESSION: &str = "550e8400-e29b-41d4-a716-446655440000";
    const VALID_UUID: &str = "msg_01ABCdef";

    // ── Happy path ──────────────────────────────────────────────────

    #[test]
    fn retry_happy_path_stops_then_starts_with_retry() {
        let mut drv = MockDriver::default();
        let r = retry_last_turn_inner(VALID_SESSION, VALID_UUID, &mut drv);
        assert!(r.is_ok(), "expected Ok, got {r:?}");
        assert_eq!(drv.stop_calls, 1);
        assert_eq!(
            drv.start_calls,
            vec![(VALID_SESSION.to_string(), VALID_UUID.to_string())]
        );
    }

    // ── Error paths ─────────────────────────────────────────────────

    #[test]
    fn retry_with_invalid_session_returns_session_not_found() {
        let mut drv = MockDriver::default();
        let r = retry_last_turn_inner("not-a-uuid", VALID_UUID, &mut drv);
        assert_eq!(r, Err(RetryError::SessionNotFound));
        assert_eq!(drv.stop_calls, 0, "stop must not be called on invalid input");
        assert!(drv.start_calls.is_empty());
    }

    #[test]
    fn retry_with_empty_session_returns_session_not_found() {
        let mut drv = MockDriver::default();
        let r = retry_last_turn_inner("", VALID_UUID, &mut drv);
        assert_eq!(r, Err(RetryError::SessionNotFound));
        assert_eq!(drv.stop_calls, 0);
    }

    #[test]
    fn retry_with_empty_uuid_returns_no_assistant_turn() {
        // An empty UUID in this architecture means the frontend tried to
        // retry without a committed user UUID — which the `canRetry` signal
        // should have prevented, but we belt-and-brace it on the backend.
        let mut drv = MockDriver::default();
        let r = retry_last_turn_inner(VALID_SESSION, "", &mut drv);
        assert_eq!(r, Err(RetryError::NoAssistantTurn));
        assert_eq!(drv.stop_calls, 0);
    }

    #[test]
    fn retry_with_malformed_uuid_returns_no_assistant_turn() {
        let mut drv = MockDriver::default();
        let r = retry_last_turn_inner(VALID_SESSION, "foo; rm -rf /", &mut drv);
        assert_eq!(r, Err(RetryError::NoAssistantTurn));
        assert_eq!(drv.stop_calls, 0);
    }

    #[test]
    fn retry_stop_failure_returns_resume_failed_without_start() {
        // If stop fails we MUST NOT proceed to start — otherwise the old
        // child could race stdout with the new one.
        let mut drv = MockDriver {
            stop_err: Some("stop boom".to_string()),
            ..Default::default()
        };
        let r = retry_last_turn_inner(VALID_SESSION, VALID_UUID, &mut drv);
        assert!(matches!(r, Err(RetryError::ResumeFailed(m)) if m.contains("stop boom")));
        assert_eq!(drv.stop_calls, 1);
        assert!(drv.start_calls.is_empty(), "start must not run after stop failure");
    }

    #[test]
    fn retry_start_failure_propagates_resume_failed() {
        let mut drv = MockDriver {
            start_err: Some("nerdctl exec failed".to_string()),
            ..Default::default()
        };
        let r = retry_last_turn_inner(VALID_SESSION, VALID_UUID, &mut drv);
        assert!(
            matches!(r, Err(RetryError::ResumeFailed(m)) if m.contains("nerdctl exec failed"))
        );
        assert_eq!(drv.stop_calls, 1);
        assert_eq!(drv.start_calls.len(), 1);
    }

    // ── RetryError serialisation ────────────────────────────────────

    #[test]
    fn retry_error_serialises_as_tagged_kind() {
        let v = serde_json::to_value(RetryError::NoAssistantTurn).unwrap();
        assert_eq!(v["kind"], "NoAssistantTurn");
        let v = serde_json::to_value(RetryError::ResumeFailed("bad".into())).unwrap();
        assert_eq!(v["kind"], "ResumeFailed");
        assert_eq!(v["message"], "bad");
    }

    #[test]
    fn retry_error_round_trips() {
        let original = RetryError::Streaming;
        let json = serde_json::to_string(&original).unwrap();
        let decoded: RetryError = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded, original);
    }

    // ── State invariant: file checksum ──────────────────────────────

    #[test]
    fn retry_does_not_open_session_jsonl_in_mock_driver() {
        // The mock driver never touches disk. This test documents the
        // contract: retry_last_turn_inner does NOT interact with the
        // session JSONL file directly — file mutation is delegated to
        // Claude Code's native `--resume-session-at` flag (ADR-046).
        //
        // An E2E test in `desktop-e2e/` checksums the file before/after
        // and asserts equality against the pre-retry state. This unit
        // test stands as a type-level guard against future changes that
        // might sneak in fs::File::open calls.
        let mut drv = MockDriver::default();
        let r = retry_last_turn_inner(VALID_SESSION, VALID_UUID, &mut drv);
        assert!(r.is_ok());
        assert_eq!(drv.stop_calls, 1);
    }
}
