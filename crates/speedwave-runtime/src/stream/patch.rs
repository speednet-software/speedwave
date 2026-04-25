//! Typed helpers that produce RFC 6902 `json_patch::Patch` values (ADR-042).
//!
//! All mutations to `ConversationState` flow through this module. Never
//! hand-craft a `Patch` inline in a handler — add a helper here instead,
//! which keeps the state-shape change surface auditable.

use anyhow::{Context, Result};
use json_patch::{
    jsonptr::PointerBuf, AddOperation, Patch, PatchOperation, RemoveOperation, ReplaceOperation,
};

use super::state_tree::{ConversationEntry, ConversationState, EntryMeta, QueuedMessage};

/// Build a JSON Pointer (RFC 6901) from a printf-style path.
fn pointer(path: &str) -> PointerBuf {
    // Safe: all call sites use constant or numeric-index paths that are
    // guaranteed to be valid pointers. A malformed path is a programmer error.
    PointerBuf::parse(path).unwrap_or_else(|e| panic!("invalid JSON pointer {path:?}: {e}"))
}

fn value_of<T: serde::Serialize>(value: &T) -> serde_json::Value {
    // Panicking is correct here: a silent `Null` fallback would corrupt the
    // patched state in a way that is hard to debug. Our state types are
    // always serde-serializable.
    serde_json::to_value(value).expect("state types are always serde-serializable")
}

/// Builder for `json_patch::Patch` values that operate on
/// `ConversationState`.
pub struct ConversationPatch;

impl ConversationPatch {
    /// Add a new entry at `/entries/<idx>`. Pass the target vector index —
    /// this maps to RFC 6902 `add` which inserts at that position.
    ///
    /// `idx` is the JSON Pointer path segment, i.e. the current vector
    /// position in `/entries`. It is NOT the logical `ConversationEntry.index`
    /// allocated by `EntryIndexProvider`. They coincide only when entries are
    /// appended in order with no removals.
    pub fn add_entry(idx: usize, entry: ConversationEntry) -> Patch {
        Patch(vec![PatchOperation::Add(AddOperation {
            path: pointer(&format!("/entries/{idx}")),
            value: value_of(&entry),
        })])
    }

    /// Replace the entry at `/entries/<idx>` with a new one.
    ///
    /// `idx` is the JSON Pointer path segment, i.e. the current vector
    /// position in `/entries`. It is NOT the logical `ConversationEntry.index`
    /// allocated by `EntryIndexProvider`. They coincide only when entries are
    /// appended in order with no removals.
    pub fn replace_entry(idx: usize, entry: ConversationEntry) -> Patch {
        Patch(vec![PatchOperation::Replace(ReplaceOperation {
            path: pointer(&format!("/entries/{idx}")),
            value: value_of(&entry),
        })])
    }

    /// Remove the entry at `/entries/<idx>`. Subsequent entries shift left;
    /// callers that rely on stable indices (ADR-044) should only remove
    /// trailing entries (e.g. during retry per ADR-046).
    ///
    /// `idx` is the JSON Pointer path segment, i.e. the current vector
    /// position in `/entries`. It is NOT the logical `ConversationEntry.index`
    /// allocated by `EntryIndexProvider`. They coincide only when entries are
    /// appended in order with no removals.
    pub fn remove_entry(idx: usize) -> Patch {
        Patch(vec![PatchOperation::Remove(RemoveOperation {
            path: pointer(&format!("/entries/{idx}")),
        })])
    }

    /// Replace a block's full text content with the provided full string.
    ///
    /// RFC 6902 has no "append" op; streaming callers therefore pass the
    /// accumulated text so far. Keeping the patch within the RFC lets the
    /// frontend use a stock `json-patch` library without a custom extension.
    pub fn replace_text(entry_idx: usize, block_idx: usize, full_text: &str) -> Patch {
        Patch(vec![PatchOperation::Replace(ReplaceOperation {
            path: pointer(&format!("/entries/{entry_idx}/blocks/{block_idx}/content")),
            value: serde_json::Value::String(full_text.to_string()),
        })])
    }

    /// Replace the per-entry metadata for an assistant turn.
    pub fn replace_meta(idx: usize, meta: EntryMeta) -> Patch {
        Patch(vec![PatchOperation::Replace(ReplaceOperation {
            path: pointer(&format!("/entries/{idx}/meta")),
            value: value_of(&meta),
        })])
    }

    /// Set whether a turn is currently streaming.
    pub fn set_streaming(is_streaming: bool) -> Patch {
        Patch(vec![PatchOperation::Replace(ReplaceOperation {
            path: pointer("/is_streaming"),
            value: serde_json::Value::Bool(is_streaming),
        })])
    }

    /// Set (or clear with `None`) the one-slot queued message (ADR-045).
    pub fn set_pending_queue(queued: Option<QueuedMessage>) -> Patch {
        Patch(vec![PatchOperation::Replace(ReplaceOperation {
            path: pointer("/pending_queue"),
            value: value_of(&queued),
        })])
    }

    /// Replace `/session_id` with the given Claude Code session identifier.
    ///
    /// The JSON shape matches `ConversationState::session_id`
    /// (`Option<String>` → `Some(id)`), so the patch round-trips through
    /// `apply()` without touching other fields.
    pub fn set_session_id(id: &str) -> Patch {
        Patch(vec![PatchOperation::Replace(ReplaceOperation {
            path: pointer("/session_id"),
            value: value_of(&Some(id.to_string())),
        })])
    }
}

/// Apply a patch to a conversation state, returning the new state.
///
/// Pure function — the input state is consumed and the patched state
/// returned. Errors surface malformed patches (bad paths, missing targets).
pub fn apply(state: ConversationState, patch: &Patch) -> Result<ConversationState> {
    let mut value = serde_json::to_value(&state).context("failed to serialize state")?;
    json_patch::patch(&mut value, &patch.0).context("failed to apply json patch")?;
    serde_json::from_value(value).context("patched state failed to deserialize")
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use crate::stream::state_tree::{
        EntryMeta, EntryRole, MessageBlock, QueuedMessage, TurnUsage, UuidStatus,
    };

    fn entry(idx: usize, text: &str) -> ConversationEntry {
        ConversationEntry {
            index: idx,
            role: EntryRole::Assistant,
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

    #[test]
    fn add_entry_patch_shape() {
        let p = ConversationPatch::add_entry(0, entry(0, "hi"));
        let encoded = serde_json::to_value(&p).unwrap();
        let arr = encoded.as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["op"], "add");
        assert_eq!(arr[0]["path"], "/entries/0");
        assert_eq!(arr[0]["value"]["index"], 0);
    }

    #[test]
    fn apply_add_entry_happy_path() {
        let state = ConversationState::default();
        let patch = ConversationPatch::add_entry(0, entry(0, "hi"));
        let next = apply(state, &patch).unwrap();
        assert_eq!(next.entries.len(), 1);
        assert_eq!(next.entries[0].index, 0);
    }

    #[test]
    fn apply_replace_entry_idempotent() {
        let state = ConversationState {
            entries: vec![entry(0, "first")],
            ..Default::default()
        };
        let patch = ConversationPatch::replace_entry(0, entry(0, "second"));
        let once = apply(state.clone(), &patch).unwrap();
        let twice = apply(once.clone(), &patch).unwrap();
        assert_eq!(once, twice);
        match &twice.entries[0].blocks[0] {
            MessageBlock::Text { content } => assert_eq!(content, "second"),
            other => panic!("unexpected block: {other:?}"),
        }
    }

    #[test]
    fn apply_remove_entry() {
        let state = ConversationState {
            entries: vec![entry(0, "a"), entry(1, "b")],
            ..Default::default()
        };
        let patch = ConversationPatch::remove_entry(1);
        let next = apply(state, &patch).unwrap();
        assert_eq!(next.entries.len(), 1);
        assert_eq!(next.entries[0].index, 0);
    }

    #[test]
    fn apply_replace_text_streams_progressively() {
        let state = ConversationState {
            entries: vec![entry(0, "")],
            ..Default::default()
        };
        let p1 = ConversationPatch::replace_text(0, 0, "he");
        let p2 = ConversationPatch::replace_text(0, 0, "hello");
        let s1 = apply(state, &p1).unwrap();
        let s2 = apply(s1, &p2).unwrap();
        match &s2.entries[0].blocks[0] {
            MessageBlock::Text { content } => assert_eq!(content, "hello"),
            other => panic!("unexpected block: {other:?}"),
        }
    }

    #[test]
    fn apply_replace_meta() {
        let state = ConversationState {
            entries: vec![entry(0, "hi")],
            ..Default::default()
        };
        let meta = EntryMeta {
            model: Some("opus".into()),
            usage: Some(TurnUsage {
                input_tokens: 10,
                output_tokens: 20,
                cache_read_tokens: 0,
                cache_write_tokens: 0,
            }),
            cost: Some(0.001),
        };
        let patch = ConversationPatch::replace_meta(0, meta.clone());
        let next = apply(state, &patch).unwrap();
        assert_eq!(next.entries[0].meta.as_ref().unwrap(), &meta);
    }

    #[test]
    fn apply_set_streaming_toggles_flag() {
        let state = ConversationState::default();
        let on = apply(state, &ConversationPatch::set_streaming(true)).unwrap();
        assert!(on.is_streaming);
        let off = apply(on, &ConversationPatch::set_streaming(false)).unwrap();
        assert!(!off.is_streaming);
    }

    #[test]
    fn apply_set_pending_queue_roundtrip() {
        let state = ConversationState::default();
        let msg = QueuedMessage {
            text: "next".into(),
            queued_at: 1,
        };
        let set = apply(
            state,
            &ConversationPatch::set_pending_queue(Some(msg.clone())),
        )
        .unwrap();
        assert_eq!(set.pending_queue.as_ref().unwrap(), &msg);
        let cleared = apply(set, &ConversationPatch::set_pending_queue(None)).unwrap();
        assert!(cleared.pending_queue.is_none());
    }

    #[test]
    fn set_session_id_patch_shape() {
        let p = ConversationPatch::set_session_id("abc-123");
        let encoded = serde_json::to_value(&p).unwrap();
        let arr = encoded.as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["op"], "replace");
        assert_eq!(arr[0]["path"], "/session_id");
        assert_eq!(arr[0]["value"], "abc-123");
    }

    #[test]
    fn apply_set_session_id_sets_field() {
        let state = ConversationState::default();
        let patch = ConversationPatch::set_session_id("sess-42");
        let next = apply(state, &patch).unwrap();
        assert_eq!(next.session_id.as_deref(), Some("sess-42"));
    }

    #[test]
    fn apply_set_session_id_overwrites_previous() {
        let state = ConversationState {
            session_id: Some("old".into()),
            ..Default::default()
        };
        let patch = ConversationPatch::set_session_id("new");
        let next = apply(state, &patch).unwrap();
        assert_eq!(next.session_id.as_deref(), Some("new"));
    }

    #[test]
    fn apply_rejects_out_of_range_replace() {
        let state = ConversationState::default();
        // /entries/5 does not exist — replace must fail.
        let patch = ConversationPatch::replace_entry(5, entry(5, "x"));
        let err = apply(state, &patch).unwrap_err();
        assert!(format!("{err:#}").contains("json patch"));
    }

    #[test]
    fn apply_rejects_remove_of_missing_index() {
        let state = ConversationState::default();
        let patch = ConversationPatch::remove_entry(0);
        let err = apply(state, &patch).unwrap_err();
        assert!(!format!("{err:#}").is_empty());
    }

    #[test]
    fn sequential_apply_equals_composed_apply() {
        // Emulate the property the reducer must preserve:
        // apply(apply(s, p1), p2) == apply(s, compose(p1, p2))
        let state = ConversationState::default();
        let p1 = ConversationPatch::add_entry(0, entry(0, "a"));
        let p2 = ConversationPatch::replace_text(0, 0, "aa");

        let step_by_step = apply(apply(state.clone(), &p1).unwrap(), &p2).unwrap();

        let mut composed = p1.clone();
        composed.0.extend(p2.0.clone());
        let composed_state = apply(state, &composed).unwrap();

        assert_eq!(step_by_step, composed_state);
    }

    #[test]
    fn multi_entry_sequence_applies_in_order() {
        let state = ConversationState::default();
        let mut cur = state;
        for i in 0..5 {
            let patch = ConversationPatch::add_entry(i, entry(i, &format!("e{i}")));
            cur = apply(cur, &patch).unwrap();
        }
        assert_eq!(cur.entries.len(), 5);
        for (i, e) in cur.entries.iter().enumerate() {
            assert_eq!(e.index, i);
        }
    }
}
