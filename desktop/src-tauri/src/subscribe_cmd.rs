//! Tauri bridge for `MsgStore.history_plus_stream()` (ADR-043).
//!
//! Frontend calls `subscribe_session(session_id)`; backend spawns a task
//! that drains the per-session stream and emits each `LogMsg` as a Tauri
//! event named `chat_patch::<session_id>`. The Angular `ChatStateService`
//! holds the `ConversationState` as a signal and applies each incoming
//! `LogMsg::JsonPatch` via the pure `applyPatch` reducer.
//!
//! The MsgStore registry lives in Tauri state as a `DashMap<session_id,
//! Arc<MsgStore>>`. `chat.rs` registers a store the first time a `Result`
//! event arrives (when the session_id becomes known) and pushes patches
//! mirrored from the `StreamChunk` event protocol so both the legacy
//! `chat_stream` channel and the patch channel converge on the same
//! state without a forklift rewrite.

use std::sync::Arc;

use dashmap::DashMap;
use futures_core::stream::BoxStream;
use futures_util::StreamExt;
use serde::Serialize;
use speedwave_runtime::stream::msg_store::LogMsg;
use speedwave_runtime::stream::MsgStore;
use tauri::{AppHandle, Emitter};

/// Per-session message-store registry, kept in Tauri-managed state.
///
/// Cloning is cheap (`Arc` clone). Tauri commands and the chat reader
/// thread both grab handles via `state::<MsgStoreRegistry>()`.
///
/// The registry tracks only `MsgStore` handles. Each `PatchEmitter` derives
/// its own `EntryIndexProvider` via `EntryIndexProvider::start_from(&store)`
/// **after** flushing any pre-bind patches, which guarantees the post-bind
/// allocator starts at `max(history) + 1`. A registry-level provider is
/// avoided to prevent the pre-bind/post-bind index collision that would
/// otherwise break multi-turn conversations going through ADR-045's
/// queue-drain path.
#[derive(Clone, Default)]
pub struct MsgStoreRegistry {
    inner: Arc<DashMap<String, Arc<MsgStore>>>,
}

impl MsgStoreRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Get-or-create the `MsgStore` for `session_id`.
    pub fn store_for(&self, session_id: &str) -> Arc<MsgStore> {
        if let Some(existing) = self.inner.get(session_id) {
            return existing.value().clone();
        }
        let store: Arc<MsgStore> = Arc::new(MsgStore::new());
        self.inner.insert(session_id.to_string(), store.clone());
        store
    }

    /// Read-only handle for the MsgStore of `session_id`, when one exists.
    #[cfg(test)]
    pub fn get(&self, session_id: &str) -> Option<Arc<MsgStore>> {
        self.inner.get(session_id).map(|r| r.value().clone())
    }

    /// Drop the streams for `session_id`. Called when a session ends — the
    /// next session under the same id starts with a fresh store.
    #[cfg(test)]
    pub fn remove(&self, session_id: &str) {
        self.inner.remove(session_id);
    }

    /// Number of registered sessions. Used by tests.
    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.inner.len()
    }
}

impl std::fmt::Debug for MsgStoreRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Per `.claude/rules/logging.md`, do not leak per-session ids in
        // diagnostic output. Report only the size.
        f.debug_struct("MsgStoreRegistry")
            .field("session_count", &self.inner.len())
            .finish()
    }
}

/// Acknowledgement returned by `subscribe_session` so the frontend knows
/// which event name to listen on.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct SubscribeAck {
    /// Tauri event name to listen on for `LogMsg` payloads.
    pub event_name: String,
}

/// Compute the canonical event name for a session's patch stream.
pub fn patch_event_name(session_id: &str) -> String {
    format!("chat_patch::{session_id}")
}

/// Drain `stream` into Tauri events named `event_name`. Detached task.
fn spawn_forwarder(app: AppHandle, event_name: String, mut stream: BoxStream<'static, LogMsg>) {
    tauri::async_runtime::spawn(async move {
        while let Some(msg) = stream.next().await {
            if let Err(e) = app.emit(&event_name, &msg) {
                log::warn!("subscribe_session: emit failed for {event_name}: {e}");
                break;
            }
        }
    });
}

/// Subscribe to a session's `history+live` patch stream (ADR-042/043).
///
/// Returns the event name the frontend must listen on. Spawns a detached
/// forwarder task — the task lives until the broadcast channel closes
/// (session ends) or an emit fails.
#[tauri::command]
pub async fn subscribe_session(
    session_id: String,
    state: tauri::State<'_, MsgStoreRegistry>,
    app: AppHandle,
) -> Result<SubscribeAck, String> {
    // Same validation surface as `retry_last_turn`. A non-UUID session_id
    // would otherwise create a `DashMap` entry in the registry and surface
    // verbatim in the `chat_patch::<session_id>` event name — leaking
    // arbitrary user-controlled strings into the Tauri event channel.
    crate::history::validate_session_id(&session_id).map_err(|e| e.to_string())?;
    let store = state.store_for(&session_id);
    let event_name = patch_event_name(&session_id);
    let stream = store.history_plus_stream();
    spawn_forwarder(app, event_name.clone(), stream);
    Ok(SubscribeAck { event_name })
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use speedwave_runtime::stream::{ConversationPatch, MsgStore};

    #[test]
    fn registry_is_empty_by_default() {
        let r = MsgStoreRegistry::new();
        assert_eq!(r.len(), 0);
        assert!(r.get("missing").is_none());
    }

    #[test]
    fn registry_store_for_returns_same_arc_on_second_call() {
        let r = MsgStoreRegistry::new();
        let a = r.store_for("s-1");
        let b = r.store_for("s-1");
        assert!(Arc::ptr_eq(&a, &b));
        assert_eq!(r.len(), 1);
    }

    #[test]
    fn registry_get_after_create_returns_handle() {
        let r = MsgStoreRegistry::new();
        let _ = r.store_for("s-2");
        assert!(r.get("s-2").is_some());
        assert!(r.get("other").is_none());
    }

    #[test]
    fn registry_remove_drops_store() {
        let r = MsgStoreRegistry::new();
        let _ = r.store_for("s-3");
        r.remove("s-3");
        assert!(r.get("s-3").is_none());
    }

    #[test]
    fn subscribe_session_rejects_non_uuid_session_id() {
        // Regression guard: `subscribe_session` previously only rejected
        // empty strings, so any non-empty arbitrary input would create a
        // `DashMap` entry in the registry and surface verbatim in the
        // `chat_patch::<session_id>` event name. The fix delegates to
        // `crate::history::validate_session_id` (UUID format + length)
        // matching `retry_last_turn`. We exercise the validator directly
        // since spinning up a real Tauri AppHandle / state in a unit test
        // would only test the wiring — the validator behaviour is the
        // invariant we care about.
        for bad in [
            "",
            "not-a-uuid",
            "../../etc/passwd",
            "550e8400-e29b-41d4-a716", // truncated
            "550e8400-e29b-41d4-a716-446655440000-extra",
            "550e8400_e29b_41d4_a716_446655440000", // wrong separators
            "ZZZe8400-e29b-41d4-a716-446655440000", // non-hex
        ] {
            assert!(
                crate::history::validate_session_id(bad).is_err(),
                "validator must reject {bad:?}"
            );
        }
        // Sanity: the canonical UUID still passes.
        assert!(
            crate::history::validate_session_id("550e8400-e29b-41d4-a716-446655440000").is_ok()
        );
    }

    #[test]
    fn patch_event_name_is_namespaced_by_session() {
        assert_eq!(patch_event_name("abc"), "chat_patch::abc");
        assert_eq!(patch_event_name(""), "chat_patch::");
    }

    #[test]
    fn registry_debug_redacts_session_ids() {
        let r = MsgStoreRegistry::new();
        let _ = r.store_for("super-secret-session");
        let dbg = format!("{r:?}");
        assert!(!dbg.contains("super-secret-session"));
        assert!(dbg.contains("session_count"));
    }

    #[tokio::test]
    async fn store_history_plus_stream_yields_history_first_then_live() {
        // Sanity: confirm MsgStore behaviour we rely on for the bridge.
        let store = MsgStore::new();
        store.push(LogMsg::SessionStarted {
            session_id: "s-x".into(),
        });
        let p = ConversationPatch::set_session_id("s-x");
        store.push(LogMsg::JsonPatch(p));

        let mut stream = store.history_plus_stream();
        let first = futures_util::StreamExt::next(&mut stream).await.unwrap();
        match first {
            LogMsg::SessionStarted { session_id } => assert_eq!(session_id, "s-x"),
            other => panic!("unexpected first: {other:?}"),
        }
        let second = futures_util::StreamExt::next(&mut stream).await.unwrap();
        assert!(matches!(second, LogMsg::JsonPatch(_)));
    }
}
