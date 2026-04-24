//! Broadcast + bounded history store for a single session (ADR-043).
//!
//! Each active Claude Code session owns one `MsgStore` with two parts:
//! a `tokio::sync::broadcast` channel for live events and a
//! `VecDeque<LogMsg>` capped at 100 MB of serialized bytes for replay.
//! `history_plus_stream()` yields the history first, then switches to live
//! — a new subscriber sees a consistent snapshot without racing against
//! simultaneous pushes.

use std::collections::VecDeque;
use std::sync::Arc;

use async_stream::stream;
use futures_core::stream::BoxStream;
use json_patch::Patch;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast::{self, error::RecvError};

use super::patch::apply;
use super::state_tree::ConversationState;

/// Default cap on history size in bytes (100 MB).
pub const DEFAULT_HISTORY_BYTES: usize = 100 * 1024 * 1024;

/// Broadcast channel capacity — the number of in-flight messages a subscriber
/// may fall behind before being marked `Lagged`. Chosen large enough to
/// smooth normal UI jitter; lagged subscribers recover via `Resync`.
const BROADCAST_CAPACITY: usize = 1024;

/// One message in the session stream (ADR-042 event protocol).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum LogMsg {
    /// A JSON-Patch to apply to the current `ConversationState`.
    JsonPatch(Patch),
    /// A full-state snapshot — emitted to lagged subscribers and on reconnect.
    Resync(Box<ConversationState>),
    /// Session lifecycle marker — a session has started with this id.
    SessionStarted {
        /// Claude Code session identifier.
        session_id: String,
    },
    /// Session lifecycle marker — the session has ended.
    SessionEnded,
}

/// Approximate the serialized byte cost of a message for the history cap.
fn size_of(msg: &LogMsg) -> usize {
    serde_json::to_vec(msg).map(|v| v.len()).unwrap_or(0)
}

struct Inner {
    history: VecDeque<LogMsg>,
    history_bytes: usize,
    max_bytes: usize,
}

impl Inner {
    fn push(&mut self, msg: LogMsg) {
        let size = size_of(&msg);
        self.history.push_back(msg);
        self.history_bytes = self.history_bytes.saturating_add(size);
        // Drop the oldest messages while over the cap, but always keep at
        // least the just-pushed message: the UI still needs to see it, and
        // dropping the only message available would leave the store in a
        // worse state than a bit of overshoot.
        while self.history_bytes > self.max_bytes && self.history.len() > 1 {
            if let Some(old) = self.history.pop_front() {
                self.history_bytes = self.history_bytes.saturating_sub(size_of(&old));
            }
        }
    }
}

/// Per-session store of live broadcast + bounded history.
pub struct MsgStore {
    inner: Arc<Mutex<Inner>>,
    sender: broadcast::Sender<LogMsg>,
}

impl Default for MsgStore {
    fn default() -> Self {
        Self::new()
    }
}

impl MsgStore {
    /// Create a store with the default 100 MB history cap.
    pub fn new() -> Self {
        Self::with_capacity(DEFAULT_HISTORY_BYTES)
    }

    /// Create a store with a custom history cap (bytes).
    pub fn with_capacity(max_bytes: usize) -> Self {
        let (sender, _) = broadcast::channel(BROADCAST_CAPACITY);
        Self {
            inner: Arc::new(Mutex::new(Inner {
                history: VecDeque::new(),
                history_bytes: 0,
                max_bytes,
            })),
            sender,
        }
    }

    /// Append a message to history and broadcast it to live subscribers.
    ///
    /// Never fails: broadcast returns `Err` only when no subscribers exist,
    /// which is not an error condition — history still holds the message for
    /// future subscribers.
    pub fn push(&self, msg: LogMsg) {
        {
            let mut inner = self.inner.lock();
            inner.push(msg.clone());
        }
        let _ = self.sender.send(msg);
    }

    /// Subscribe to live events only (no history replay).
    pub fn subscribe(&self) -> broadcast::Receiver<LogMsg> {
        self.sender.subscribe()
    }

    /// Current history length in bytes (approximate — serialization cost).
    pub fn history_bytes(&self) -> usize {
        self.inner.lock().history_bytes
    }

    /// Current history length in messages.
    pub fn history_len(&self) -> usize {
        self.inner.lock().history.len()
    }

    /// Snapshot current history without holding the lock across the reducer.
    fn history_vec(&self) -> Vec<LogMsg> {
        self.inner.lock().history.iter().cloned().collect()
    }

    /// Replay a sequence of messages through the reducer to produce a state.
    /// Lossy patches (malformed, unknown paths) are skipped with a warning —
    /// the snapshot is best-effort recovery.
    fn replay(history: Vec<LogMsg>) -> ConversationState {
        let mut state = ConversationState::default();
        for msg in history {
            match msg {
                LogMsg::JsonPatch(p) => match apply(state.clone(), &p) {
                    Ok(next) => state = next,
                    Err(e) => log::warn!("msg_store replay: skipping bad patch: {e:#}"),
                },
                LogMsg::Resync(snapshot) => state = *snapshot,
                LogMsg::SessionStarted { session_id } => state.session_id = Some(session_id),
                LogMsg::SessionEnded => {}
            }
        }
        state
    }

    /// Replay the stored history to produce a current state snapshot.
    pub fn snapshot_state(&self) -> ConversationState {
        Self::replay(self.history_vec())
    }

    /// Yield history first, then switch to live events.
    ///
    /// A lagged subscriber (one that falls behind by more than the broadcast
    /// capacity) receives a single `Resync` message with the current snapshot
    /// and then continues from live — never panics, never silently drops.
    pub fn history_plus_stream(&self) -> BoxStream<'static, LogMsg> {
        let mut rx = self.sender.subscribe();
        let history_snapshot = self.history_vec();
        let inner = self.inner.clone();

        Box::pin(stream! {
            for msg in history_snapshot {
                yield msg;
            }
            loop {
                match rx.recv().await {
                    Ok(msg) => yield msg,
                    Err(RecvError::Closed) => break,
                    Err(RecvError::Lagged(_)) => {
                        let history: Vec<LogMsg> =
                            inner.lock().history.iter().cloned().collect();
                        let state = Self::replay(history);
                        yield LogMsg::Resync(Box::new(state));
                    }
                }
            }
        })
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use crate::stream::patch::ConversationPatch;
    use crate::stream::state_tree::{ConversationEntry, EntryRole, MessageBlock, UuidStatus};
    use futures_core::Stream;
    use std::pin::Pin;
    use std::task::{Context, Poll};
    use tokio::time::{timeout, Duration};

    fn entry(idx: usize, text: &str) -> ConversationEntry {
        ConversationEntry {
            index: idx,
            role: EntryRole::User,
            uuid: None,
            uuid_status: UuidStatus::Pending,
            blocks: vec![MessageBlock::Text {
                content: text.to_string(),
            }],
            meta: None,
            edited_at: None,
            timestamp: 0,
        }
    }

    async fn collect_n<S>(mut stream: S, n: usize) -> Vec<S::Item>
    where
        S: Stream + Unpin,
    {
        let mut out = Vec::with_capacity(n);
        for _ in 0..n {
            match timeout(Duration::from_millis(500), next(&mut stream)).await {
                Ok(Some(v)) => out.push(v),
                _ => break,
            }
        }
        out
    }

    // Tiny hand-rolled `next` to avoid pulling the full `futures` crate for tests.
    fn next<S: Stream + Unpin>(s: &mut S) -> NextFut<'_, S> {
        NextFut(s)
    }
    struct NextFut<'a, S>(&'a mut S);
    impl<'a, S: Stream + Unpin> std::future::Future for NextFut<'a, S> {
        type Output = Option<S::Item>;
        fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
            Pin::new(&mut *self.0).poll_next(cx)
        }
    }

    #[test]
    fn push_records_history_and_bytes() {
        let store = MsgStore::new();
        assert_eq!(store.history_len(), 0);
        assert_eq!(store.history_bytes(), 0);
        store.push(LogMsg::SessionStarted {
            session_id: "s1".into(),
        });
        assert_eq!(store.history_len(), 1);
        assert!(store.history_bytes() > 0);
    }

    #[test]
    fn snapshot_replays_patches() {
        let store = MsgStore::new();
        store.push(LogMsg::SessionStarted {
            session_id: "s1".into(),
        });
        store.push(LogMsg::JsonPatch(ConversationPatch::add_entry(
            0,
            entry(0, "hi"),
        )));
        let state = store.snapshot_state();
        assert_eq!(state.session_id.as_deref(), Some("s1"));
        assert_eq!(state.entries.len(), 1);
    }

    #[test]
    fn snapshot_resync_replaces_prior_state() {
        let store = MsgStore::new();
        store.push(LogMsg::JsonPatch(ConversationPatch::add_entry(
            0,
            entry(0, "a"),
        )));
        let snapshot = ConversationState {
            session_id: Some("fresh".into()),
            entries: vec![entry(0, "b")],
            ..Default::default()
        };
        store.push(LogMsg::Resync(Box::new(snapshot.clone())));
        assert_eq!(store.snapshot_state(), snapshot);
    }

    #[tokio::test]
    async fn subscribe_receives_only_future_messages() {
        let store = MsgStore::new();
        store.push(LogMsg::SessionStarted {
            session_id: "old".into(),
        });
        let mut rx = store.subscribe();
        store.push(LogMsg::SessionStarted {
            session_id: "new".into(),
        });
        let got = timeout(Duration::from_millis(500), rx.recv())
            .await
            .unwrap()
            .unwrap();
        match got {
            LogMsg::SessionStarted { session_id } => assert_eq!(session_id, "new"),
            other => panic!("unexpected msg: {other:?}"),
        }
    }

    #[tokio::test]
    async fn history_plus_stream_yields_history_then_live() {
        let store = MsgStore::new();
        store.push(LogMsg::SessionStarted {
            session_id: "s1".into(),
        });
        store.push(LogMsg::JsonPatch(ConversationPatch::add_entry(
            0,
            entry(0, "x"),
        )));
        let stream = store.history_plus_stream();

        let collected = collect_n(stream, 2).await;
        assert_eq!(collected.len(), 2);
        match &collected[0] {
            LogMsg::SessionStarted { session_id } => assert_eq!(session_id, "s1"),
            other => panic!("expected SessionStarted, got {other:?}"),
        }
        match &collected[1] {
            LogMsg::JsonPatch(_) => {}
            other => panic!("expected JsonPatch, got {other:?}"),
        }

        // After the history is drained, the stream continues with live events.
        let store2 = MsgStore::new();
        let stream2 = store2.history_plus_stream();
        store2.push(LogMsg::SessionEnded);
        let live = collect_n(stream2, 1).await;
        assert_eq!(live.len(), 1);
        matches!(live[0], LogMsg::SessionEnded);
    }

    #[test]
    fn history_cap_drops_oldest() {
        // Tiny cap to exercise overflow with small messages.
        let store = MsgStore::with_capacity(200);
        for i in 0..20 {
            store.push(LogMsg::SessionStarted {
                session_id: format!("sess-{i}"),
            });
        }
        assert!(store.history_bytes() <= 200);
        // Some oldest entries must have been dropped.
        assert!(store.history_len() < 20);
    }

    #[test]
    fn history_cap_keeps_single_oversized_message() {
        // A cap smaller than one message must not produce an empty history.
        let store = MsgStore::with_capacity(1);
        let big = "x".repeat(1000);
        store.push(LogMsg::SessionStarted { session_id: big });
        assert_eq!(store.history_len(), 1);
    }

    #[tokio::test]
    async fn lagged_subscriber_receives_resync() {
        // Cap the broadcast channel pressure by filling it beyond capacity.
        // We need more than BROADCAST_CAPACITY pending messages so RecvError::Lagged fires.
        let store = MsgStore::new();
        let stream = store.history_plus_stream();
        // Send way more than BROADCAST_CAPACITY before the stream is polled.
        for i in 0..(BROADCAST_CAPACITY + 16) {
            store.push(LogMsg::SessionStarted {
                session_id: format!("s{i}"),
            });
        }
        let collected = collect_n(stream, BROADCAST_CAPACITY + 17).await;
        // At least one Resync must appear to recover from the lag.
        let has_resync = collected.iter().any(|m| matches!(m, LogMsg::Resync(_)));
        assert!(
            has_resync,
            "expected Resync after lag, got: {:?}",
            collected
                .iter()
                .map(std::mem::discriminant)
                .collect::<Vec<_>>()
        );
    }

    #[tokio::test]
    async fn concurrent_push_is_safe() {
        let store = Arc::new(MsgStore::new());
        let mut handles = vec![];
        for i in 0..10 {
            let s = store.clone();
            handles.push(tokio::spawn(async move {
                for j in 0..100 {
                    s.push(LogMsg::SessionStarted {
                        session_id: format!("t{i}-{j}"),
                    });
                }
            }));
        }
        for h in handles {
            h.await.unwrap();
        }
        assert_eq!(store.history_len(), 1000);
    }
}
