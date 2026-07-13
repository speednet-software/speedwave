# ADR-044: EntryIndexProvider — Atomic Counter for Stable Entry Keys

> **Status:** Retired (2026-06-10) — `EntryIndexProvider` was deleted together with the JSON-Patch wire transport (see the [ADR-042](ADR-042-json-patch-stream-protocol.md) status note). The `index` field survives on the state-tree shape; the frontend projection assigns it sequentially during `rebuildStateTree()` (`desktop/src/src/app/services/chat-state.service.ts`). This document records the original design.
> **Context:** Every conversation entry needs one stable identifier that works both as a JSON-Patch path segment and as a monotonic ordering key.

## Decision

Each session owns a single `EntryIndexProvider`, a shared atomic counter that hands out monotonic, never-reused `usize` indices at entry creation. The index is the logical identity of an entry across its whole lifecycle (token deltas, tool-result fills, removes on retry). Its public API is `new()` (start at 0), `next()` (allocate the next index), `current()` (peek without consuming), and `start_from(&MsgStore)` (recover after resume). Cloning shares the same underlying counter via `Arc`, so multiple handler threads allocate indices without coordination. There is intentionally no `reset()` — resetting to 0 would violate the never-reused invariant.

## Why

- **Patch addressing (ADR-042).** Patch paths look like `/entries/<N>/blocks/0/content`, a JSON Pointer[^1] used as the address in a JSON Patch operation[^2], and must keep pointing at the same entry across many patches. A monotonic index embeds trivially in those paths.
- **Stable across removes (ADR-046 retry).** A removed entry's index is never recycled, so a still-open patch can never silently retarget a different entry.
- **Monotonic ordering for free.** The reducer and the MsgStore history cap (ADR-043) both assume later patches address later-or-existing entries; one integer carries both identity and order, keeping the reducer simple.
- **`Relaxed` atomic ordering[^3] is sufficient.** Indices are identifiers, not synchronization primitives — `next()` only needs to return a unique value. The MsgStore broadcast channel already provides the happens-before ordering of the patches themselves, as long as a handler calls `next()` before pushing the patch that uses the index.
- **Recovery without persisted state.** On resume, `start_from` rebuilds the next value from the store's history rather than persisting a separate "next index".

## How recovery works

`start_from(&MsgStore)` calls `store.snapshot_state()` to replay history into a `ConversationState`, reads the logical `index` field off each `ConversationEntry`, and initializes the counter to `max + 1` (or 0 for an empty store). It does NOT parse JSON-Pointer path strings — it reads the materialized `index` fields directly. Truncation of old history by the 100 MiB cap (ADR-043) is safe because the maximum index is always among the most recent entries.

## Index vs. Vec position

Two integers coexist per entry: the logical `ConversationEntry.index` (monotonic, never reused) and the Vec position used inside the JSON-Pointer path. The patch-helper layer takes the Vec position directly (`ConversationPatch::add_entry(idx, …)` — `idx` is the position, not the logical index), and the doc-comments there spell out that the two coincide only when entries are appended in order with no removals. Retry (ADR-046) only removes the trailing assistant entry, so the surviving Vec stays contiguous and the two stay equal in practice. A future non-trailing remove would break that equality and require a `find_by_index` lookup.

## Where it lives in code

- **Provider** — `crates/speedwave-runtime/src/stream/entry_index.rs` (`EntryIndexProvider`, `new`/`next`/`current`/`start_from`, with unit tests covering empty/populated `start_from`, monotonicity, shared-counter clone, and concurrent allocation across threads).
- **State snapshot used by recovery** — `crates/speedwave-runtime/src/stream/msg_store.rs` (`MsgStore::snapshot_state`).
- **Entry type carrying the `index` field** — `crates/speedwave-runtime/src/stream/state_tree.rs` (`ConversationEntry`).
- **Patch helpers consuming the Vec position** — `crates/speedwave-runtime/src/stream/patch.rs` (`ConversationPatch::add_entry`/`replace_entry`).
- **Angular rendering.** The shipped chat message list tracks by message timestamp (`@for (msg of messages(); track msg.timestamp)` in `desktop/src/src/app/chat/message-list/chat-message-list.component.ts`), and other chat templates use their own keys (`$index`, attachment id, option value, etc.). Tracking by a per-entry index is not currently wired through to the frontend — the TS chat model in `desktop/src/src/app/models/chat.ts` has no entry-level `index` field.

## Non-goals

- The index is not a cursor or paging token — MsgStore history is the source of truth for replay, and the provider does not persist.
- The index is not user-visible. Labels like "message 3" are derived from position in the visible entries, not from this counter.

## Rejected alternatives

- **Per-entry random UUIDs.** Stable and globally unique, but not monotonic and not a natural array index; they would force the state-tree to a keyed map plus a separate ordering field. (UUIDs still exist, but only for semantic message identity across resume/retry, stored inside the entry — never used for addressing.)
- **Natural array position as the identity.** A remove at index `k` shifts every later entry, so any still-open patch targeting `/entries/k+1/…` would silently point at the wrong entry. Unusable as a stable key.

## References

- [ADR-042](ADR-042-json-patch-stream-protocol.md) — JSON Patch stream protocol (patch paths)
- [ADR-043](ADR-043-msgstore-history-plus-stream.md) — MsgStore history cap and replay
- [ADR-046](ADR-046-native-session-resume-for-retry.md) — session resume and retry removes

[^1]: [RFC 6901: JavaScript Object Notation (JSON) Pointer](https://datatracker.ietf.org/doc/html/rfc6901) - defines the `/entries/0/blocks/0/content`-style path syntax used to address a value within a JSON document.

[^2]: [RFC 6902: JavaScript Object Notation (JSON) Patch](https://datatracker.ietf.org/doc/html/rfc6902) - defines the `add`/`replace`/`remove`-style patch operations, each addressed by a JSON Pointer path.

[^3]: [`std::sync::atomic::Ordering::Relaxed`](https://doc.rust-lang.org/std/sync/atomic/enum.Ordering.html#variant.Relaxed) - Rust standard library docs: "no ordering constraints, only atomic operations," i.e. it guarantees atomicity of the operation but no cross-thread ordering guarantee beyond that.
