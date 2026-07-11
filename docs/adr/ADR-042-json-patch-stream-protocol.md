# ADR-042: JSON Patch (RFC 6902) as the Stream-to-UI Protocol

> **Status:** Retired (2026-06-10) — the JSON-Patch wire transport was removed. It ran as a redundant mirror of the legacy `chat_stream` chunk path: the frontend rebuilt the state-tree from its legacy fields after every chunk, overwriting any applied patches, so the patch path never drove the UI at runtime; and the patch protocol never carried session stats (`session_id`, cost, usage, context window, rate limit), which flow only on `chat_stream`. What survives: the **state-tree shape** — `crates/speedwave-runtime/src/stream/state_tree.rs` remains the SSOT mirrored by `desktop/src/src/app/models/state-tree.ts` and `models/chat.ts::MessageBlock` — and the Angular `state()` signal with its projections, now fed exclusively by `ChatStateService.rebuildStateTree()` (legacy fields → tree). The patch builders, reducer, MsgStore (ADR-043), EntryIndexProvider (ADR-044), `subscribe_session`/`chat_patch::*` bridge, and the frontend `applyPatch` reducer were deleted. The rest of this document records the original design.
> **Context:** The chat UI needs to render a live conversation (user/assistant text, tool calls, thinking, ask-user prompts, usage/cost, errors) streamed from Claude Code, without a new event type per render feature.

## Decision

Every update the Rust runtime sends to the Angular frontend is an RFC 6902 JSON Patch applied to a single per-session conversation state-tree. There are no per-feature event types on the wire — a new UI render is a new path in the tree, not a new event. Streaming a token, for example, is a `replace` at `/entries/<i>/blocks/<j>/content` with the full accumulated string (RFC 6902 defines only `add`/`remove`/`replace`/`move`/`copy`/`test`, no append op, so the caller passes the whole text).[^1]

## Why

- One wire format, one frontend reducer, one test surface. New UI data lands on a new state-tree path — no new Tauri event types and no new TypeScript types beyond extending the state-tree shape.
- `replace` is idempotent: re-applying the same patch is a no-op, which lets the history-replay-then-live flow of the MsgStore (ADR-043) and second-window scenarios work without special-case reconnect logic.
- Patch sequences are self-documenting — the path tells you what changed, so debugging a render issue means reading patches, not grepping for handler names.
- The reducer is pure and trivially snapshot-testable: a canned patch sequence asserts an expected state-tree value.

## Where it lives in code

- State-tree shape (SSOT, authoritative) — `crates/speedwave-runtime/src/stream/state_tree.rs`. Root type `ConversationState { session_id, entries, session_totals, pending_queue, model, is_streaming }`; entries carry `index` (ADR-044), `uuid`/`uuid_status` (ADR-046), `role`, `blocks`, `meta`, `edited_at`, `timestamp`. Blocks are a tagged enum (`kind` snake_case) — Text, Thinking, ToolUse, AskUser, Error, Image.
- TypeScript mirror (hand-written, manually kept in sync) — `desktop/src/src/app/models/state-tree.ts`. Its header points back at the Rust file; there is no code generation. Adding a field means editing both files in the same change.
- Typed patch builders — `crates/speedwave-runtime/src/stream/patch.rs`. Every mutation goes through a `ConversationPatch::*` helper (e.g. `add_entry`, `replace_entry`, `remove_entry`, `add_block`, `replace_text`, `replace_tool_input`, `replace_tool_result`, `replace_entry_uuid`, `replace_meta`, `set_streaming`, `set_pending_queue`, `replace_session_totals`, `set_session_id`) so a call site cannot hand-craft an invalid JSON Pointer. The same module's `apply()` is the pure Rust reducer used by the store and tests.
- Transport enum — `crates/speedwave-runtime/src/stream/msg_store.rs`, `LogMsg`. Four adjacently-tagged variants: `JsonPatch(Patch)` (the hot path), `Resync(Box<ConversationState>)` (a full-state snapshot for lagged subscribers and reconnect), `SessionStarted { session_id }`, and `SessionEnded`. The two lifecycle markers are genuinely out-of-band (not state mutations), so collapsing them into patches would only complicate the reducer.
- Frontend reducer (hand-written ~100-line RFC 6902 subset) — `desktop/src/src/app/services/json-patch.ts`, `applyPatch<T>(state, patch): T`. It deep-clones with `structuredClone` and returns the new value, supporting only the `add`/`remove`/`replace` ops the backend emits and rejecting the rest. The chat state service (`desktop/src/src/app/services/chat-state.service.ts`) assigns the result straight back to its signal.
- Stream source — the Rust parser consumes `claude -p --output-format=stream-json --include-partial-messages` and translates those events into patches in one place; the rest of the system never sees stream-json types.[^2]

## Rejected alternatives

- A separate Tauri event type per render feature (the pre-ADR design). Every new render required a new Rust struct, event name, TypeScript type, Angular reducer branch, and test matrix — the code grew linearly with feature count and every addition was a cross-cutting change.
- Pulling in a third-party JS JSON-Patch library (e.g. `fast-json-patch`[^3]). The state-tree surface is small and the reducer is auditable in ~100 lines; the in-house reducer avoids an extra dependency and its prototype-pollution surface. The Rust side does use the mature `json-patch` crate, which provides atomic apply with rollback.[^4]
- A custom "append" op for token streaming. Staying within RFC 6902 (full-string `replace`) keeps the wire format standard; the cost of re-sending accumulated text is negligible for Speedwave's short per-message block arrays.

## Known limitations

- JSON Patch is order-sensitive. Speedwave relies on the in-order delivery of the MsgStore broadcast channel (ADR-043). A future transport change (multi-source merge, lossy transport) would require adding a monotonic `seq` field to patches.
- A pathologically large block (e.g. a 100 MiB tool result) makes whole-subtree `replace` costly and could blow the MsgStore history cap. Guarded by the 100 MiB history cap (ADR-043) and the normalizer's block-size limits; binary/large content is referenced, not inlined as base64 in a patch (ADR-065).

## References

- RFC 6902 — JSON Patch: https://datatracker.ietf.org/doc/html/rfc6902
- RFC 6901 — JSON Pointer: https://datatracker.ietf.org/doc/html/rfc6901
- Design proposal — `design-proposals/06-terminal-minimal.html`
- Related ADRs — ADR-043 (MsgStore), ADR-044 (entry index), ADR-045 (queued message), ADR-046 (resume identity), ADR-065 (image attachment lifecycle).

[^1]: RFC 6902, JavaScript Object Notation (JSON) Patch, section 4 defines only `add`, `remove`, `replace`, `move`, `copy`, and `test` operations: https://datatracker.ietf.org/doc/html/rfc6902#section-4

[^2]: Claude Code headless mode docs, "Stream responses" - `--output-format stream-json` with `--include-partial-messages` streams newline-delimited JSON events: https://code.claude.com/docs/en/headless

[^3]: fast-json-patch, an RFC 6902 implementation for JavaScript: https://github.com/Starcounter-Jack/JSON-Patch

[^4]: json-patch crate docs - the `patch` function reverts all previously-applied operations if any operation in the sequence fails: https://docs.rs/json-patch/latest/json_patch/
