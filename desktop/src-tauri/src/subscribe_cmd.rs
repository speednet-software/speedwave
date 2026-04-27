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
use speedwave_runtime::stream::{EntryIndexProvider, MsgStore};
use tauri::{AppHandle, Emitter};

/// Pair of per-session services: a MsgStore for patches and an
/// EntryIndexProvider for stable monotonic indices (ADR-044).
///
/// They live together in the registry because the index counter must
/// recover from the store's history when a session reconnects — keeping
/// them lockstep removes the chance of drift.
#[derive(Clone)]
pub struct SessionStreams {
    pub store: Arc<MsgStore>,
    pub indices: EntryIndexProvider,
}

/// Per-session SessionStreams registry, kept in Tauri-managed state.
///
/// Cloning is cheap (`Arc` clone). Tauri commands and the chat reader
/// thread both grab handles via `state::<MsgStoreRegistry>()`.
#[derive(Clone, Default)]
pub struct MsgStoreRegistry {
    inner: Arc<DashMap<String, SessionStreams>>,
}

impl MsgStoreRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Get-or-create the SessionStreams for `session_id`.
    pub fn get_or_create(&self, session_id: &str) -> SessionStreams {
        if let Some(existing) = self.inner.get(session_id) {
            return existing.value().clone();
        }
        let store: Arc<MsgStore> = Arc::new(MsgStore::new());
        let indices = EntryIndexProvider::start_from(&store);
        let streams = SessionStreams { store, indices };
        self.inner.insert(session_id.to_string(), streams.clone());
        streams
    }

    /// Convenience accessor — returns just the MsgStore handle for sites
    /// that don't need the index provider.
    pub fn store_for(&self, session_id: &str) -> Arc<MsgStore> {
        self.get_or_create(session_id).store
    }

    /// Read-only handle for the MsgStore of `session_id`, when one exists.
    #[cfg(test)]
    pub fn get(&self, session_id: &str) -> Option<Arc<MsgStore>> {
        self.inner.get(session_id).map(|r| r.value().store.clone())
    }

    /// Drop the streams for `session_id`. Called when a session ends — the
    /// next session under the same id starts with a fresh store/indices.
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
    if session_id.is_empty() {
        return Err("session_id required".to_string());
    }
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
    fn registry_get_or_create_returns_same_arc_on_second_call() {
        let r = MsgStoreRegistry::new();
        let a = r.get_or_create("s-1");
        let b = r.get_or_create("s-1");
        assert!(Arc::ptr_eq(&a.store, &b.store));
        assert_eq!(r.len(), 1);
    }

    #[test]
    fn registry_streams_carry_index_provider() {
        let r = MsgStoreRegistry::new();
        let s = r.get_or_create("s-idx");
        assert_eq!(s.indices.next(), 0);
        assert_eq!(s.indices.next(), 1);
        // Same session id reuses the same provider.
        let s2 = r.get_or_create("s-idx");
        assert_eq!(s2.indices.next(), 2);
    }

    #[test]
    fn registry_get_after_create_returns_handle() {
        let r = MsgStoreRegistry::new();
        let _ = r.get_or_create("s-2");
        assert!(r.get("s-2").is_some());
        assert!(r.get("other").is_none());
    }

    #[test]
    fn registry_remove_drops_store() {
        let r = MsgStoreRegistry::new();
        let _ = r.get_or_create("s-3");
        r.remove("s-3");
        assert!(r.get("s-3").is_none());
    }

    #[test]
    fn patch_event_name_is_namespaced_by_session() {
        assert_eq!(patch_event_name("abc"), "chat_patch::abc");
        assert_eq!(patch_event_name(""), "chat_patch::");
    }

    #[test]
    fn registry_debug_redacts_session_ids() {
        let r = MsgStoreRegistry::new();
        let _ = r.get_or_create("super-secret-session");
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
