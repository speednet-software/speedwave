//! One-slot queued message per session (ADR-045).
//!
//! When the user sends a message while a turn is streaming, the runtime
//! does NOT append it to a FIFO backlog. Instead it replaces a single
//! reserved queue slot per session: the most recent message wins, the
//! prior queued message (if any) is returned to the caller so it can
//! surface a "replaced" UX hint. On turn completion, the runtime drains
//! the slot via `take()` and starts the next turn from there.
//!
//! Replace semantics deliberately differ from FIFO: the user always
//! knows what runs next (the visible "queued: …" preview), and a
//! background backlog cannot accumulate "send 5, get 5 back" surprise.
//! See ADR-045 for the full rationale and source citations.

use std::sync::Arc;

use dashmap::DashMap;

use crate::stream::QueuedMessage;

/// Snapshot of queue contents for diagnostic and UX surfaces.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct QueueStats {
    /// Number of sessions that currently hold a queued message.
    pub occupied_slots: usize,
}

/// Concurrent one-slot-per-session queued message store.
///
/// Cloning the service is cheap (`Arc` clone) — pass it by value into
/// async tasks that need to enqueue/take/cancel without lifetime gymnastics.
#[derive(Debug, Clone, Default)]
pub struct QueuedMessageService {
    inner: Arc<DashMap<String, QueuedMessage>>,
}

impl QueuedMessageService {
    /// Create an empty queue store.
    pub fn new() -> Self {
        Self::default()
    }

    /// Place `msg` in `session_id`'s slot, returning any previous queued
    /// message that was displaced. `None` when the slot was empty —
    /// callers can surface "replaced previous queued: <preview>" only when
    /// `Some(_)` comes back.
    pub fn queue(&self, session_id: &str, msg: QueuedMessage) -> Option<QueuedMessage> {
        self.inner.insert(session_id.to_string(), msg)
    }

    /// Remove and return the queued message for `session_id`, draining the
    /// slot. Called from the turn-end handler so the next turn can start
    /// from the queued payload.
    pub fn take(&self, session_id: &str) -> Option<QueuedMessage> {
        self.inner.remove(session_id).map(|(_, msg)| msg)
    }

    /// Drop the queued message for `session_id` without returning it. Used
    /// by the explicit "cancel" affordance the composer exposes.
    pub fn cancel(&self, session_id: &str) -> bool {
        self.inner.remove(session_id).is_some()
    }

    /// Read-only peek at the queued message for `session_id`. Returns a
    /// clone so callers don't hold the internal lock; use sparingly.
    pub fn peek(&self, session_id: &str) -> Option<QueuedMessage> {
        self.inner.get(session_id).map(|r| r.value().clone())
    }

    /// Diagnostic snapshot. Cheap — `DashMap::len` is `O(shards)`.
    pub fn stats(&self) -> QueueStats {
        QueueStats {
            occupied_slots: self.inner.len(),
        }
    }

    /// `true` when no session currently has a queued message. Convenience
    /// over `stats().occupied_slots == 0`.
    pub fn is_empty(&self) -> bool {
        self.inner.is_empty()
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use std::sync::Arc as StdArc;
    use std::thread;

    fn msg(text: &str, ts: u64) -> QueuedMessage {
        QueuedMessage {
            text: text.into(),
            queued_at: ts,
        }
    }

    #[test]
    fn empty_service_returns_none_for_peek_take_cancel() {
        let svc = QueuedMessageService::new();
        assert!(svc.peek("s1").is_none());
        assert!(svc.take("s1").is_none());
        assert!(!svc.cancel("s1"));
        assert!(svc.is_empty());
        assert_eq!(svc.stats(), QueueStats { occupied_slots: 0 });
    }

    #[test]
    fn queue_stores_message_and_peek_returns_clone() {
        let svc = QueuedMessageService::new();
        let prior = svc.queue("s1", msg("hello", 1));
        assert!(prior.is_none(), "first queue must not displace anything");

        let peeked = svc.peek("s1").unwrap();
        assert_eq!(peeked.text, "hello");
        assert_eq!(peeked.queued_at, 1);

        // Peek must NOT drain the slot.
        assert!(svc.peek("s1").is_some());
        assert_eq!(svc.stats().occupied_slots, 1);
    }

    #[test]
    fn queue_replace_returns_previous_and_keeps_one_slot() {
        let svc = QueuedMessageService::new();
        svc.queue("s1", msg("first", 1));

        let replaced = svc.queue("s1", msg("second", 2)).unwrap();
        assert_eq!(replaced.text, "first");
        assert_eq!(replaced.queued_at, 1);

        let now = svc.peek("s1").unwrap();
        assert_eq!(now.text, "second");
        assert_eq!(now.queued_at, 2);

        // Still one slot — never grows into a FIFO.
        assert_eq!(svc.stats().occupied_slots, 1);
    }

    #[test]
    fn take_drains_and_returns_message() {
        let svc = QueuedMessageService::new();
        svc.queue("s1", msg("payload", 9));

        let drained = svc.take("s1").unwrap();
        assert_eq!(drained.text, "payload");
        assert_eq!(drained.queued_at, 9);
        assert!(svc.peek("s1").is_none());
        assert!(svc.is_empty());
    }

    #[test]
    fn take_after_take_returns_none() {
        let svc = QueuedMessageService::new();
        svc.queue("s1", msg("once", 1));
        assert!(svc.take("s1").is_some());
        assert!(svc.take("s1").is_none());
    }

    #[test]
    fn cancel_returns_true_when_slot_was_occupied_false_otherwise() {
        let svc = QueuedMessageService::new();
        assert!(!svc.cancel("s1"), "cancel on empty must be a no-op");

        svc.queue("s1", msg("doomed", 1));
        assert!(svc.cancel("s1"));
        assert!(svc.peek("s1").is_none());
        assert!(!svc.cancel("s1"));
    }

    #[test]
    fn sessions_isolated_from_each_other() {
        let svc = QueuedMessageService::new();
        svc.queue("s1", msg("for-s1", 1));
        svc.queue("s2", msg("for-s2", 2));

        assert_eq!(svc.peek("s1").unwrap().text, "for-s1");
        assert_eq!(svc.peek("s2").unwrap().text, "for-s2");
        assert_eq!(svc.stats().occupied_slots, 2);

        svc.take("s1");
        assert!(svc.peek("s1").is_none());
        assert_eq!(svc.peek("s2").unwrap().text, "for-s2");
        assert_eq!(svc.stats().occupied_slots, 1);
    }

    #[test]
    fn empty_text_is_a_valid_queued_message() {
        // The runtime treats the slot as opaque storage — it does not enforce
        // "text must be non-empty". The composer is responsible for not
        // submitting empties; the queue must round-trip whatever it gets.
        let svc = QueuedMessageService::new();
        svc.queue("s1", msg("", 0));
        let drained = svc.take("s1").unwrap();
        assert_eq!(drained.text, "");
    }

    #[test]
    fn unicode_payload_roundtrips() {
        let svc = QueuedMessageService::new();
        svc.queue("s1", msg("héllo 🌊 — déjà vu", 1));
        let drained = svc.take("s1").unwrap();
        assert_eq!(drained.text, "héllo 🌊 — déjà vu");
    }

    #[test]
    fn concurrent_queue_and_take_is_safe() {
        // 4 producers replace a slot in a tight loop while 4 consumers
        // race them with `take`. The invariants we rely on:
        //   - no panic / poisoned lock under contention
        //   - the slot count stays at most 1 throughout (one-slot semantics)
        //   - every producer's final `queue` returns either None (consumer
        //     drained between calls) or the prior message — never a wedged
        //     state where the slot grows.
        const PRODUCERS: usize = 4;
        const CONSUMERS: usize = 4;
        const ITERS: usize = 1_000;

        let svc = StdArc::new(QueuedMessageService::new());
        let mut handles = Vec::with_capacity(PRODUCERS + CONSUMERS);

        for p in 0..PRODUCERS {
            let svc = StdArc::clone(&svc);
            handles.push(thread::spawn(move || {
                for i in 0..ITERS {
                    svc.queue("hot-session", msg(&format!("p{p}-{i}"), i as u64));
                }
            }));
        }
        for _ in 0..CONSUMERS {
            let svc = StdArc::clone(&svc);
            handles.push(thread::spawn(move || {
                for _ in 0..ITERS {
                    let _ = svc.take("hot-session");
                }
            }));
        }
        for h in handles {
            h.join().expect("worker panicked");
        }

        // Drain whatever survived; one-slot invariant still holds.
        let _final = svc.take("hot-session");
        assert!(svc.peek("hot-session").is_none());
        assert_eq!(svc.stats().occupied_slots, 0);
    }
}
