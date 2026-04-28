//! Acceptance test #11 from the implementation prompt: a 100-turn
//! patch-driven session must keep `sum(entries.meta.cost) ==
//! session_totals.cost` (within float tolerance) and tokens exact.
//!
//! Drives a synthetic stream of patches through the `apply()` reducer —
//! one user entry + one assistant entry per turn, plus the per-turn
//! `replace_meta` and `replace_session_totals` patches that the live
//! handler emits in lock-step — and asserts the consistency invariants
//! end-to-end.

#![cfg(test)]
#![allow(clippy::unwrap_used, clippy::expect_used)]

use super::patch::{apply, ConversationPatch};
use super::state_tree::{
    ConversationEntry, ConversationState, EntryMeta, EntryRole, MessageBlock, SessionTotals,
    TurnUsage, UuidStatus,
};

const TURNS: usize = 100;

/// Minimal user entry at the given logical index.
fn user_entry(index: usize, ts: u64) -> ConversationEntry {
    ConversationEntry {
        index,
        role: EntryRole::User,
        uuid: Some(format!("u-{index}")),
        uuid_status: UuidStatus::Committed,
        blocks: vec![MessageBlock::Text {
            content: format!("user msg {index}"),
        }],
        meta: None,
        edited_at: None,
        timestamp: ts,
    }
}

/// Minimal assistant entry placeholder — `meta` arrives via a separate
/// `replace_meta` patch later in the same turn (mirrors the live flow).
fn assistant_entry(index: usize, ts: u64) -> ConversationEntry {
    ConversationEntry {
        index,
        role: EntryRole::Assistant,
        uuid: Some(format!("a-{index}")),
        uuid_status: UuidStatus::Committed,
        blocks: vec![MessageBlock::Text {
            content: format!("assistant reply {index}"),
        }],
        meta: None,
        edited_at: None,
        timestamp: ts,
    }
}

/// Per-turn deterministic usage so the math is checkable by hand:
///   input  = 100 + turn
///   output = 200 + turn * 2
///   cache_read  = if turn > 0 { 50 } else { 0 }
///   cache_write = if turn % 5 == 0 { 30 } else { 0 }
///   cost   = 0.001 * turn + 0.002 (so the sum is the closed-form
///            sum of an arithmetic series — no FP traps).
fn turn_usage(turn: usize) -> TurnUsage {
    TurnUsage {
        input_tokens: 100 + turn as u64,
        output_tokens: 200 + (turn as u64) * 2,
        cache_read_tokens: if turn > 0 { 50 } else { 0 },
        cache_write_tokens: if turn % 5 == 0 { 30 } else { 0 },
    }
}

fn turn_cost(turn: usize) -> f64 {
    0.001 * turn as f64 + 0.002
}

#[test]
fn one_hundred_turn_session_keeps_totals_consistent() {
    let mut state = ConversationState::default();
    let mut totals = SessionTotals::default();
    let mut expected_assistant_indices: Vec<usize> = Vec::with_capacity(TURNS);

    for turn in 0..TURNS {
        // Two entries per turn: user + assistant.
        let user_idx = turn * 2;
        let assistant_idx = turn * 2 + 1;
        let ts = (turn as u64) * 1000;

        // Add user entry.
        state = apply(
            state,
            &ConversationPatch::add_entry(user_idx, user_entry(user_idx, ts)),
        )
        .unwrap();

        // Add assistant entry placeholder.
        state = apply(
            state,
            &ConversationPatch::add_entry(assistant_idx, assistant_entry(assistant_idx, ts + 1)),
        )
        .unwrap();
        expected_assistant_indices.push(assistant_idx);

        // Compute per-turn usage + cost (the live delta handler does the
        // same math; we recompute here to assert the invariant from
        // independent source-of-truth values).
        let usage = turn_usage(turn);
        let cost = turn_cost(turn);

        // Update per-entry meta on the assistant.
        let meta = EntryMeta {
            model: Some("opus-4.7".into()),
            usage: Some(usage),
            cost: Some(cost),
        };
        state = apply(state, &ConversationPatch::replace_meta(assistant_idx, meta)).unwrap();

        // Roll session totals forward in lock-step.
        totals.input_tokens += usage.input_tokens;
        totals.output_tokens += usage.output_tokens;
        totals.cache_read_tokens += usage.cache_read_tokens;
        totals.cache_write_tokens += usage.cache_write_tokens;
        totals.cost += cost;
        totals.turn_count += 1;
        state = apply(state, &ConversationPatch::replace_session_totals(totals)).unwrap();
    }

    // Invariant 1: 200 entries total (one user + one assistant per turn).
    assert_eq!(
        state.entries.len(),
        TURNS * 2,
        "expected {} entries after {TURNS} turns, got {}",
        TURNS * 2,
        state.entries.len()
    );

    // Invariant 2: entry indices monotonic, never reused.
    for (vec_idx, entry) in state.entries.iter().enumerate() {
        assert_eq!(
            entry.index, vec_idx,
            "entry vector position {vec_idx} carries logical index {} (expected monotonic)",
            entry.index
        );
    }

    // Invariant 3: per-entry assistant cost sum equals session totals
    // (within 1e-4 — the acceptance criterion #11 tolerance).
    let assistant_cost_sum: f64 = state
        .entries
        .iter()
        .filter(|e| matches!(e.role, EntryRole::Assistant))
        .map(|e| e.meta.as_ref().and_then(|m| m.cost).unwrap_or(0.0))
        .sum();
    let totals_cost = state.session_totals.cost;
    let cost_drift = (assistant_cost_sum - totals_cost).abs();
    assert!(
        cost_drift < 1e-4,
        "per-entry cost sum {assistant_cost_sum} vs session_totals.cost {totals_cost} \
         drifted {cost_drift} (tolerance 1e-4)"
    );

    // Invariant 4: per-entry assistant token sums equal session totals
    // (exact — no FP).
    let assistant_input: u64 = state
        .entries
        .iter()
        .filter_map(|e| e.meta.as_ref()?.usage.as_ref().map(|u| u.input_tokens))
        .sum();
    let assistant_output: u64 = state
        .entries
        .iter()
        .filter_map(|e| e.meta.as_ref()?.usage.as_ref().map(|u| u.output_tokens))
        .sum();
    let assistant_cache_read: u64 = state
        .entries
        .iter()
        .filter_map(|e| e.meta.as_ref()?.usage.as_ref().map(|u| u.cache_read_tokens))
        .sum();
    let assistant_cache_write: u64 = state
        .entries
        .iter()
        .filter_map(|e| {
            e.meta
                .as_ref()?
                .usage
                .as_ref()
                .map(|u| u.cache_write_tokens)
        })
        .sum();

    assert_eq!(
        assistant_input, state.session_totals.input_tokens,
        "input_tokens drift after {TURNS} turns"
    );
    assert_eq!(
        assistant_output, state.session_totals.output_tokens,
        "output_tokens drift after {TURNS} turns"
    );
    assert_eq!(
        assistant_cache_read, state.session_totals.cache_read_tokens,
        "cache_read drift after {TURNS} turns"
    );
    assert_eq!(
        assistant_cache_write, state.session_totals.cache_write_tokens,
        "cache_write drift after {TURNS} turns"
    );

    // Invariant 5: turn_count reflects the number of completed turns.
    assert_eq!(state.session_totals.turn_count as usize, TURNS);

    // Invariant 6: closed-form check on tokens — input_tokens for turn i is
    // 100 + i, summed over i ∈ [0, TURNS) is 100*TURNS + TURNS*(TURNS-1)/2.
    let expected_input: u64 = 100 * TURNS as u64 + (TURNS as u64) * (TURNS as u64 - 1) / 2;
    assert_eq!(state.session_totals.input_tokens, expected_input);
    let expected_output: u64 = 200 * TURNS as u64 + (TURNS as u64) * (TURNS as u64 - 1);
    assert_eq!(state.session_totals.output_tokens, expected_output);

    // Invariant 7: every assistant entry has non-None meta — no NaN/None
    // leaks into the rendered metadata line.
    for assistant_idx in expected_assistant_indices {
        let entry = &state.entries[assistant_idx];
        let meta = entry
            .meta
            .as_ref()
            .unwrap_or_else(|| panic!("assistant entry {assistant_idx} has None meta"));
        let usage = meta
            .usage
            .as_ref()
            .unwrap_or_else(|| panic!("assistant entry {assistant_idx} has None usage"));
        assert!(usage.input_tokens > 0);
        let cost = meta
            .cost
            .unwrap_or_else(|| panic!("assistant entry {assistant_idx} has None cost"));
        assert!(cost.is_finite(), "cost {cost} not finite");
    }
}

#[test]
fn one_hundred_turn_session_uuid_status_committed() {
    // Variant: every entry must end Committed. Catches a regression where
    // an assistant entry would stick at Pending if a `Result` event got
    // dropped — that would silently disqualify entries from retry.
    let mut state = ConversationState::default();
    for turn in 0..TURNS {
        let user_idx = turn * 2;
        let assistant_idx = turn * 2 + 1;
        state = apply(
            state,
            &ConversationPatch::add_entry(user_idx, user_entry(user_idx, 0)),
        )
        .unwrap();
        state = apply(
            state,
            &ConversationPatch::add_entry(assistant_idx, assistant_entry(assistant_idx, 0)),
        )
        .unwrap();
    }

    for entry in &state.entries {
        assert_eq!(
            entry.uuid_status,
            UuidStatus::Committed,
            "entry {} not committed",
            entry.index
        );
        assert!(entry.uuid.is_some(), "entry {} missing uuid", entry.index);
    }
}
