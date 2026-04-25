//! Atomic counter for stable conversation-entry indices (ADR-044).
//!
//! Each session owns a single `EntryIndexProvider`. Indices are monotonic,
//! never reused, and serve as the only stable identifier for UI addressing
//! (Angular `trackBy`) and JSON-Patch paths (`/entries/<index>`).
//! UUIDs (ADR-046) are for message identity across resume/retry — never mix
//! the two.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use super::msg_store::MsgStore;

/// Shared monotonic counter producing conversation-entry indices.
#[derive(Clone, Debug)]
pub struct EntryIndexProvider(Arc<AtomicUsize>);

impl Default for EntryIndexProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl EntryIndexProvider {
    /// Start from zero — used for a fresh session.
    pub fn new() -> Self {
        Self(Arc::new(AtomicUsize::new(0)))
    }

    /// Allocate the next index. Monotonic, never reused.
    ///
    /// `Relaxed` ordering is sufficient: the only requirement is that each
    /// call returns a unique value. We do not use the counter to synchronize
    /// any other memory, so a full `SeqCst` fence is unnecessary overhead.
    pub fn next(&self) -> usize {
        self.0.fetch_add(1, Ordering::Relaxed)
    }

    /// Read the current counter value without consuming an index.
    pub fn current(&self) -> usize {
        self.0.load(Ordering::Relaxed)
    }

    /// Recover the next value by scanning an existing `MsgStore`'s history.
    ///
    /// Used on resume/reconnect: replay produces the current state, the
    /// highest entry index + 1 becomes the next allocation.
    pub fn start_from(store: &MsgStore) -> Self {
        let state = store.snapshot_state();
        let next = state
            .entries
            .iter()
            .map(|e| e.index)
            .max()
            .map(|h| h + 1)
            .unwrap_or(0);
        Self(Arc::new(AtomicUsize::new(next)))
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use crate::stream::msg_store::LogMsg;
    use crate::stream::patch::ConversationPatch;
    use crate::stream::state_tree::{ConversationEntry, EntryRole, MessageBlock, UuidStatus};
    use std::collections::HashSet;

    fn entry(idx: usize) -> ConversationEntry {
        ConversationEntry {
            index: idx,
            role: EntryRole::User,
            uuid: None,
            uuid_status: UuidStatus::Pending,
            blocks: vec![MessageBlock::Text {
                content: "x".into(),
            }],
            meta: None,
            edited_at: None,
            timestamp: 0,
        }
    }

    #[test]
    fn new_starts_at_zero() {
        let p = EntryIndexProvider::new();
        assert_eq!(p.current(), 0);
    }

    #[test]
    fn next_is_monotonic() {
        let p = EntryIndexProvider::new();
        for expected in 0..5 {
            assert_eq!(p.next(), expected);
        }
        assert_eq!(p.current(), 5);
    }

    #[test]
    fn clone_shares_counter() {
        let a = EntryIndexProvider::new();
        let b = a.clone();
        assert_eq!(a.next(), 0);
        assert_eq!(b.next(), 1);
        assert_eq!(a.current(), 2);
    }

    #[test]
    fn start_from_empty_store_returns_zero() {
        let store = MsgStore::new();
        let p = EntryIndexProvider::start_from(&store);
        assert_eq!(p.current(), 0);
    }

    #[test]
    fn start_from_recovers_highest_index_plus_one() {
        let store = MsgStore::new();
        store.push(LogMsg::JsonPatch(ConversationPatch::add_entry(0, entry(0))));
        store.push(LogMsg::JsonPatch(ConversationPatch::add_entry(1, entry(7))));
        let p = EntryIndexProvider::start_from(&store);
        assert_eq!(p.current(), 8);
        assert_eq!(p.next(), 8);
    }

    #[tokio::test]
    async fn concurrent_next_yields_unique_values() {
        let provider = EntryIndexProvider::new();
        let mut handles = vec![];
        for _ in 0..10 {
            let p = provider.clone();
            handles.push(tokio::spawn(async move {
                let mut locals = Vec::with_capacity(100);
                for _ in 0..100 {
                    locals.push(p.next());
                }
                locals
            }));
        }
        let mut all = HashSet::new();
        for h in handles {
            for v in h.await.unwrap() {
                assert!(all.insert(v), "duplicate index: {v}");
            }
        }
        assert_eq!(all.len(), 1000);
        assert_eq!(provider.current(), 1000);
    }
}
