# ADR-044: EntryIndexProvider — Atomic Counter for Stable Entry Keys

**Status:** Accepted
**Date:** 2026-04-25

## Context

Every conversation entry — user message, assistant message, tool use, thinking block, error, ask_user prompt — needs a stable identifier that serves three distinct roles:

1. **Angular `trackBy` key.** The template renders `@for (entry of state().entries; track entry.???)` and a changing key between renders causes `Change Detection` to destroy and rebuild the DOM node, losing focus, selection, and animation state.[^1]
2. **JSON Patch path segment.** Per ADR-042, the wire protocol is `json_patch::Patch`[^2] with paths like `/entries/<key>/blocks/0/content`. The path must address the correct entry across many patches emitted over the entry's lifetime (token deltas, tool-result fills, permission updates).
3. **Monotonic ordering.** The reducer and the MsgStore history cap (ADR-043) both assume later patches are for later-or-existing entries. An entry identified by UUID would require a separate ordering index; coupling both into one value keeps the reducer simple.

Options considered:

- **UUIDs (per-entry random).** Stable, globally unique, but: not monotonic, not a JSON Pointer[^3]-friendly array index, forces the state-tree to use an object (`entries: Map<uuid, entry>`) which loses natural order, adds a separate `order` field to restore it. Adds bookkeeping with no benefit.
- **Natural array index (position in `entries: Vec<_>`).** Would work, but a `Remove` patch (retry — ADR-046) at index `k` shifts every subsequent entry — every still-open tool-delta patch targeting `/entries/k+1/…` is now silently pointing at the wrong entry. Unusable.
- **Monotonic atomic counter assigned at entry creation.** Stable across `Remove` operations (the index stays with the entry; removed indices leave a hole). Natural trackBy. Embeds trivially in JSON Pointer paths. This is BloopAI/vibe-kanban's `EntryIndexProvider`.[^4]

Speedwave adopts the third option — matching vibe-kanban's `EntryIndexProvider(Arc<AtomicUsize>)` pattern[^4] exactly — because the constraints on a Claude Code stream protocol are the same.

## Decision

**Type — `crates/speedwave-runtime/src/stream/entry_index.rs`:**

```
pub struct EntryIndexProvider(Arc<AtomicUsize>);

impl EntryIndexProvider {
    pub fn new() -> Self;
    pub fn next(&self) -> usize;                    // fetch_add(1, Relaxed)
    pub fn current(&self) -> usize;                 // load(Relaxed)
    pub fn reset(&self);                            // store(0, Relaxed)
    pub fn start_from(store: &MsgStore) -> Self;    // recover max existing + 1
}

impl Clone for EntryIndexProvider {
    fn clone(&self) -> Self { Self(Arc::clone(&self.0)) }
}
```

Public API mirrors vibe-kanban's provider[^4]. Cloning shares the underlying counter (via `Arc`) so multiple handler threads can hand out monotonic indices without coordination.

**Atomic ordering — `Relaxed`.** `next()` uses `fetch_add(1, Ordering::Relaxed)`.[^5] Relaxed is sufficient because:

- Indices are not used for synchronization between threads — they are identifiers.
- The MsgStore broadcast channel provides the happens-before ordering of the _patches themselves_.[^6] As long as a handler calls `next()` before pushing the patch that uses the returned index, and the push into MsgStore is the only synchronization point, readers see indices in the same order they see the patches that reference them.

**Usage contract:**

1. **One provider per `MsgStore` / session.** Create alongside `MsgStore` in the session-start path. Indices are not unique across sessions; paired with `session_id` they are globally unique, which is already how the Tauri event layer keys subscriptions.
2. **Monotonic and never reused.** `Remove` patches (ADR-046 retry) do not recycle the index — the entry is gone, but a future `Add` gets the next unused integer. This keeps patch paths unambiguous even after trims.
3. **The ONLY stable identifier used in patches.** UUIDs (ADR-046) are for semantic message identity across resume / retry — they are stored _inside_ the entry's `uuid` field, never used as addressing.
4. **Angular tracks by index.**

   ```
   @for (entry of state().entries; track entry.index) { … }
   ```

   No other `trackBy` function in any chat-list template.

**Recovery on resume — `start_from(msg_store)`:**

When a session is resumed (ADR-046) or a subscriber reconnects, the store's history contains entries with indices already assigned. A fresh provider starting at 0 would collide. `start_from(&MsgStore)` scans every patch in `msg_store`'s history, extracts the maximum `/entries/<N>/…` path segment it sees, and initializes the atomic counter to `max + 1`. Vibe-kanban uses the same approach[^4]; the helper is implemented once and tested against canned patch sequences covering: empty history, single entry, sparse indices after removes, and multi-digit indices (ensuring the path parser is not naïvely single-char).

**Non-goals:**

- The index is not a cursor or a paging token. The MsgStore history is the source of truth for replay; the provider does not need to persist.
- The index is not user-visible. It never renders in UI text. Labels shown to the user ("message 3") are rendered from `1-based-position-in-visible-entries`, not from this counter.

## Consequences

### Positive

- Single trackBy key for every chat-list template. No per-component bespoke keying, no subtle bugs from keys that collide across entry types.
- Patch paths stay stable across the entry's full lifecycle — a token delta arriving after a tool-result fills the same entry does not risk retargeting.
- `Remove`-then-`Add` flows (retry via ADR-046) trivially correct: the removed entry's index is forever unused, the new entry's index is guaranteed fresh, and no concurrent patch handler can mis-address.
- Trivial recovery across resume: `start_from` reads existing patches and resumes the sequence — no separate persisted "next index" state.
- Direct match to vibe-kanban's production pattern[^4] — same API surface, same ordering guarantees, same failure modes.

### Neutral

- The state-tree's `entries: Vec<ConversationEntry>` compacts on removal — RFC 6902 `remove` at `/entries/<k>` drops the element and shifts later elements left. There is no `removed` flag and no `Option` wrapper on entries; the shipped `ConversationEntry` carries only real (present) entries. The `index` field on each entry remains the monotonic session-unique identifier — never reused across removes — and is the key Angular tracks by. Rendering iterates `entries` directly; tracking uses `entry.index`. The patch-helper layer forbids removes at non-trailing positions (retry per ADR-046 only removes the last assistant entry), so the post-remove Vec stays contiguous and the Vec position used inside the JSON Pointer path equals the surviving `entry.index` for every remaining entry in this scenario. Any future non-trailing remove would have to update this invariant.
- Wrap-around of `usize` is possible in theory; at one entry per nanosecond on a 64-bit platform, it takes 584 years to overflow. Not guarded.

### Negative

- Two integers coexist per entry: the stable `entry.index` (monotonic, never reused) and the Vec position used inside JSON Pointer paths. Under the "trailing remove only" invariant they are equal for every surviving entry, but that equality is a consequence of the invariant, not a type-level guarantee. A new contributor must know that a future non-trailing remove would break the equality — and must then introduce a `find_by_index(entries, idx)` lookup and update the patch-helper layer (ADR-042) accordingly. Today the helpers take the Vec position directly; callers reading state from patches do not need to translate.
- `start_from` is O(history size) at resume time. With the 100 MiB MsgStore cap (ADR-043), worst case is ~100 000 patches — a millisecond-scale scan on modern hardware, not worth optimizing.
- No compile-time distinction between an `EntryIndex` and any other `usize`. Could be wrapped in a newtype, but adds noise at every call site for a small correctness win. Accepted as-is; the API surface that touches indices is small enough (patch helpers, reducer, trackBy) to audit by eye.

## Known Limitations

- `start_from` assumes every index-bearing patch is present in history. A history that was truncated by the 100 MiB cap _before_ resume (i.e. the session was very active and old entries rolled out) would omit the oldest entries — but `start_from` looks for the _maximum_, which is always among the most recent patches, so truncation of _old_ history is safe. Truncation of _new_ history would be a MsgStore bug, not an indexing concern.
- Property-based tests must cover: concurrent `next()` from N threads yields N distinct values covering exactly `[start, start+N)`; `start_from` on synthetic histories returns `max+1`; `start_from` on empty history returns 0.
- The provider holds no synchronization primitive besides the atomic — in particular, it does not coordinate with MsgStore push order. The contract "call `next()` before `push(patch)`" is a coding convention enforced by the patch-helper layer, not by types. A handler that reverses the order would emit a patch referencing an index that the reducer has not yet seen — not incorrect (the reducer creates the entry on first `Add`), but confusing. Helper methods guarantee correct order.

## References

[^1]: Angular `@for` block — `track` expression and trackBy semantics: https://angular.dev/api/core/@for

[^2]: RFC 6902 — "JavaScript Object Notation (JSON) Patch": https://datatracker.ietf.org/doc/html/rfc6902

[^3]: RFC 6901 — "JavaScript Object Notation (JSON) Pointer" — path syntax for addressing nested state: https://datatracker.ietf.org/doc/html/rfc6901

[^4]: BloopAI/vibe-kanban — `EntryIndexProvider(Arc<AtomicUsize>)` with `next`/`current`/`reset`/`start_from`: https://github.com/BloopAI/vibe-kanban/blob/main/crates/executors/src/logs/utils/entry_index.rs

[^5]: `std::sync::atomic::Ordering::Relaxed` — semantics and when it is safe: https://doc.rust-lang.org/std/sync/atomic/enum.Ordering.html#variant.Relaxed

[^6]: `tokio::sync::broadcast` — ordered delivery to each subscriber: https://docs.rs/tokio/latest/tokio/sync/broadcast/index.html
