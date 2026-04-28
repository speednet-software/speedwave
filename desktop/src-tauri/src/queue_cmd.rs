//! Tauri commands for the one-slot queued-message service (ADR-045).
//!
//! Composer wires `queue_message` when `is_streaming` is true (turn already
//! running) and `cancel_queued_message` for the explicit X button. Drain
//! happens server-side from the stream-reader thread when a `Result` event
//! arrives — the frontend never explicitly drains, it just observes the
//! `state.pending_queue` patch flip back to `null`.

use serde::{Deserialize, Serialize};
use speedwave_runtime::session::QueuedMessageService;
use speedwave_runtime::stream::QueuedMessage;

/// Frontend-facing payload for a queued message — mirrors
/// `speedwave_runtime::stream::QueuedMessage` exactly so the same JSON shape
/// flows through patches and through these RPC return types.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct QueuedMessagePayload {
    pub text: String,
    pub queued_at: u64,
}

impl From<QueuedMessage> for QueuedMessagePayload {
    fn from(m: QueuedMessage) -> Self {
        Self {
            text: m.text,
            queued_at: m.queued_at,
        }
    }
}

impl From<QueuedMessagePayload> for QueuedMessage {
    fn from(p: QueuedMessagePayload) -> Self {
        Self {
            text: p.text,
            queued_at: p.queued_at,
        }
    }
}

const MAX_QUEUED_LEN: usize = 1_000_000;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Place a message in the one-slot queue for `session_id`. Returns the
/// message that was displaced (if any) so the composer can surface
/// "replaced previous queued: …".
#[tauri::command]
pub async fn queue_message(
    session_id: String,
    text: String,
    state: tauri::State<'_, QueuedMessageService>,
    registry: tauri::State<'_, crate::subscribe_cmd::MsgStoreRegistry>,
) -> Result<Option<QueuedMessagePayload>, String> {
    if text.len() > MAX_QUEUED_LEN {
        return Err("Message too long".to_string());
    }
    if session_id.is_empty() {
        return Err("session_id required".to_string());
    }
    let msg = QueuedMessage {
        text: text.clone(),
        queued_at: now_ms(),
    };
    let prior = state
        .queue(&session_id, msg.clone())
        .map(QueuedMessagePayload::from);
    // ADR-042/045 mirror: surface the new slot to state-tree subscribers.
    use speedwave_runtime::stream::msg_store::LogMsg;
    use speedwave_runtime::stream::ConversationPatch;
    let store = registry.store_for(&session_id);
    store.push(LogMsg::JsonPatch(ConversationPatch::set_pending_queue(
        Some(msg),
    )));
    Ok(prior)
}

/// Drop the queued message for `session_id`. Returns whether a slot was
/// occupied beforehand — the composer uses this to keep the UI honest if
/// the slot was racing-cleared by a background drain.
#[tauri::command]
pub async fn cancel_queued_message(
    session_id: String,
    state: tauri::State<'_, QueuedMessageService>,
    registry: tauri::State<'_, crate::subscribe_cmd::MsgStoreRegistry>,
) -> Result<bool, String> {
    if session_id.is_empty() {
        return Err("session_id required".to_string());
    }
    let was_set = state.cancel(&session_id);
    // ADR-042/045 mirror: clear the state-tree slot for any subscribers.
    use speedwave_runtime::stream::msg_store::LogMsg;
    use speedwave_runtime::stream::ConversationPatch;
    let store = registry.store_for(&session_id);
    store.push(LogMsg::JsonPatch(ConversationPatch::set_pending_queue(
        None,
    )));
    Ok(was_set)
}

/// Read-only peek for diagnostics or recovery (e.g. on app restart). The
/// composer normally relies on the state-tree patch stream, not this.
#[tauri::command]
pub async fn peek_queued_message(
    session_id: String,
    state: tauri::State<'_, QueuedMessageService>,
) -> Result<Option<QueuedMessagePayload>, String> {
    if session_id.is_empty() {
        return Err("session_id required".to_string());
    }
    Ok(state.peek(&session_id).map(QueuedMessagePayload::from))
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use speedwave_runtime::session::QueuedMessageService;

    #[test]
    fn queued_message_payload_roundtrips_runtime_type() {
        let runtime = QueuedMessage {
            text: "ping".into(),
            queued_at: 7,
        };
        let payload: QueuedMessagePayload = runtime.clone().into();
        assert_eq!(payload.text, "ping");
        assert_eq!(payload.queued_at, 7);
        let back: QueuedMessage = payload.into();
        assert_eq!(back, runtime);
    }

    #[tokio::test]
    async fn queue_then_peek_returns_message() {
        let svc = QueuedMessageService::new();
        // Direct service call — emulates what the Tauri command body does.
        let prior = svc.queue(
            "s1",
            QueuedMessage {
                text: "x".into(),
                queued_at: 1,
            },
        );
        assert!(prior.is_none());
        let peeked = svc.peek("s1").unwrap();
        assert_eq!(peeked.text, "x");
    }

    #[tokio::test]
    async fn cancel_clears_slot() {
        let svc = QueuedMessageService::new();
        svc.queue(
            "s1",
            QueuedMessage {
                text: "x".into(),
                queued_at: 1,
            },
        );
        assert!(svc.cancel("s1"));
        assert!(svc.peek("s1").is_none());
        assert!(!svc.cancel("s1"));
    }
}
