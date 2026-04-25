# ADR-042: JSON Patch (RFC 6902) as the Stream-to-UI Protocol

**Status:** Accepted
**Date:** 2026-04-25

## Context

The Speedwave chat UI consumes a live stream of events from Claude Code (stdout in `stream-json` format[^1]) and renders a conversation: user messages, streamed assistant text, tool calls with their inputs and results, thinking blocks, permission prompts, ask_user prompts, per-turn usage and cost, error callouts. Before this ADR, each distinct event type (`TextDelta`, `ToolUseStarted`, `ToolUseDelta`, `ToolResult`, `PermissionRequested`, `AskUser`, `SessionEnded`, …) was a separate Tauri event with its own payload shape and its own frontend handler. Adding a new render (e.g. per-turn cost, Feature 3 in `design-proposals/06-terminal-minimal-implementation-prompt.md`) required: a new Rust event struct, a new Tauri event name, a new TypeScript type, a new branch in the Angular reducer, a new test matrix. The code grew linearly with the feature count and every addition was a cross-cutting change.

BloopAI/vibe-kanban — a production Claude Code executor that has shipped the same rendering surface for months — solves this with a single, uniform wire format: every event is a JSON Patch[^2] applied to a conversation state-tree.[^3] Streaming a token = `Replace` at `/entries/<i>/content`. Adding a tool result = `Add` at `/entries/<j>`. Setting a permission approval = `Replace` at `/entries/<i>/pending/approval`. There is one event type across the entire wire, one reducer in the frontend, and one schema for the state-tree. New features become new paths in the tree, not new event types.

JSON Patch is an IETF standard[^2] with well-tested Rust (`json-patch` crate[^4]) and TypeScript (`fast-json-patch`[^5]) implementations, atomic semantics (all ops apply or none[^4]), and a natural RFC 6901 path vocabulary[^6] for addressing nested state. The reducer is pure and trivially testable; sequences of patches can be snapshot-tested against expected state-tree outputs.

## Decision

Every event emitted from the Rust runtime to the Angular frontend is a `json_patch::Patch`[^4] applied to a per-session conversation state-tree. There are no per-feature event types on the wire.

**State-tree shape (defined once, shared between Rust and TypeScript):**

```
ConversationState {
  session_id: String,
  entries: Vec<ConversationEntry>,        // addressed by /entries/<index>
  pending_queue: Option<QueuedMessage>,   // ADR-045
  session_totals: SessionUsage,           // cumulative cost, tokens
  streaming: bool,
}

ConversationEntry {
  index: usize,                           // ADR-044, stable UI key
  uuid: Option<String>,                   // ADR-046, resume identity
  uuid_status: Committed | Pending,       // ADR-046
  role: User | Assistant | System,
  blocks: Vec<Block>,                     // text, tool_use, thinking, error
  meta: Option<EntryMeta>,                // model, usage, cost
  edited_at: Option<Timestamp>,           // ADR-046 retry marker
}
```

The Rust type is authoritative. The TypeScript equivalent is generated via `ts-rs`[^7] so schema drift is a compile-time failure, not a runtime bug.

**Typed patch helpers — `crates/speedwave-runtime/src/stream/patch.rs`:**

Never hand-craft a `Patch` inline in a handler; every call site goes through a typed builder that knows the correct path for each mutation:

- `ConversationPatch::add_entry(entry_idx, entry) -> Patch`
- `ConversationPatch::replace_entry(entry_idx, entry) -> Patch`
- `ConversationPatch::replace_text(entry_idx, block_idx, full_text) -> Patch` (token streaming — `Replace` at `/entries/<entry_idx>/blocks/<block_idx>/content`; RFC 6902 has no "append" op, so the caller accumulates the full text and passes it; the helper does not infer either coordinate)
- `ConversationPatch::remove_entry(entry_idx) -> Patch` (retry — ADR-046, trailing entries only)
- `ConversationPatch::replace_meta(entry_idx, meta) -> Patch` (Feature 3)
- `ConversationPatch::set_streaming(is_streaming) -> Patch`
- `ConversationPatch::set_pending_queue(queued) -> Patch` (ADR-045)

Future-wave additions (state-tree fields already present, helpers to be added alongside the feature): a `set_session_totals(totals)` helper once ADR-042 Feature 3 lands, and block-level permission-approval helpers once interactive permission prompts ship. Both follow the same pattern — one helper per state-tree path, no hand-crafted paths at call sites.

These mirror vibe-kanban's `ConversationPatch::{add_normalized_entry, replace, remove}` helpers[^3] with Speedwave-specific paths. Each helper returns a well-formed `Patch`; callers cannot construct an invalid path by accident.

**Transport — single Tauri event:**

The Rust side emits exactly one Tauri event payload variant to the frontend:

```
enum LogMsg {
    JsonPatch(json_patch::Patch),
    Finished,          // session ended (normal)
    SessionReset,      // on resume / retry, asks frontend to drop state
}
```

`LogMsg::JsonPatch` is the hot path. Legacy per-type events (`TextDelta`, `ToolUseStarted`, etc.) are removed wholesale in this rewrite — there is no compatibility shim because the frontend is being rewritten in the same PR series.

**Frontend reducer — `desktop/src/src/app/chat/chat-state.service.ts`:**

```
state = signal<ConversationState>(initialState);
applyPatch(state, patch);   // pure function; returns new state
```

Patches arrive via the MsgStore subscription (ADR-043), are passed to a single pure `applyPatch(state, patch)` reducer (thin wrapper over `fast-json-patch`[^5]), and the result is assigned back to the signal. The reducer is trivially unit-testable against canned patch sequences. Property-based tests cover: idempotency of `Replace` on the same path; the monoid law `apply(apply(s, p1), p2) === apply(s, compose(p1, p2))` for non-conflicting patches.

**What this does NOT do:**

- It does not commit to replicating the state-tree byte-for-byte; the Tauri boundary is still a serialization hop. The guarantee is that after applying all patches emitted up to time `t`, both sides agree on the state-tree value at time `t`.
- It does not replace the MsgStore (ADR-043) — MsgStore owns history and broadcast; patches are the payload the store traffics in.
- It does not change how Claude Code itself emits events. Speedwave's Rust parser still consumes `claude -p --output-format=stream-json --include-partial-messages`[^1][^8] and translates those events into patches — but the translation happens in one module and the rest of the system never sees stream-json types.

## Consequences

### Positive

- One wire format, one frontend reducer, one test surface. New UI data lands on a new path in the state-tree — no new Tauri event types, no new TypeScript types beyond the state-tree extension.
- Idempotent replays become possible: re-applying the same patch on the same state is a no-op for `Replace`, which enables the MsgStore history-plus-stream flow (ADR-043) and second-window scenarios without special-case reconnect logic.
- Patch sequences are self-documenting: the path tells you what changed. Debugging a rendering issue means reading patches, not grepping for handler names.
- Aligns with a production-battle-tested implementation (vibe-kanban).[^3] When we hit an edge case, their solution is a reference — not from scratch.
- `fast-json-patch`[^5] on the frontend and `json-patch`[^4] on the backend are mature, ~10-year-old libraries with known behavior and RFC conformance test suites.

### Neutral

- Shared state-tree schema must be kept in sync across the Rust/TypeScript boundary. `ts-rs`[^7] catches drift at build time. CI adds one generated-types check.
- Patch construction requires typed helpers; a handler author who inlines a raw `Patch` defeats the guarantee. Lint rule or code-review habit: every `Patch` value must originate from a `ConversationPatch::*` helper.

### Negative

- JSON Patch is order-sensitive: applying a list of patches out of order can corrupt the tree. Relying on the ordered stream from MsgStore (ADR-043) — `tokio::broadcast`[^9] delivers messages in send order to each receiver — preserves the guarantee, but a future transport change (UDP, multi-source merge) would break it. If that day comes, patches need a monotonic `seq` field.
- Pure-`Replace` patches at large paths (replacing a whole block tree) are O(depth) in both encode and apply cost. For Speedwave's entry sizes this is negligible, but a runaway tool result (100 MiB JSON) could slow the UI. Guarded by the MsgStore 100 MiB history cap (ADR-043) and the established block size limits in the normalizer.
- The stream still emits `Finished` and `SessionReset` envelopes alongside `JsonPatch`. These are genuinely out-of-band (end-of-stream signals, not state mutations) so collapsing them into patches would complicate the reducer for no gain — accepted asymmetry.

## Known Limitations

- `json-patch` 4.x (current latest) is used on Rust.[^4] Any future major version with changed error semantics requires re-running the conformance tests.
- `fast-json-patch`[^5] has known performance hotspots in `applyOperation` for very large arrays; Speedwave's per-message block arrays are short, but if an assistant turn ever emits thousands of blocks, consider `rfc6902`[^10] as an alternative.
- Binary/large-blob block content (images, file contents) must be pre-chunked in the state-tree (e.g. a blob reference, not an inline base64 string in the patch). Otherwise a single patch can blow the 100 MiB history cap in one shot.

## References

[^1]: Anthropic Claude Code CLI reference — `--output-format stream-json` flag: https://code.claude.com/docs/en/cli-reference

[^2]: RFC 6902 — "JavaScript Object Notation (JSON) Patch": https://datatracker.ietf.org/doc/html/rfc6902

[^3]: BloopAI/vibe-kanban — `ConversationPatch` helpers and state-tree addressing: https://github.com/BloopAI/vibe-kanban/blob/main/crates/executors/src/logs/utils/patch.rs

[^4]: `json-patch` Rust crate — RFC 6902 + RFC 7396 implementation, `Patch` type, atomic apply with rollback: https://docs.rs/json-patch/latest/json_patch/

[^5]: `fast-json-patch` npm package — RFC 6902 JSON Patch for JavaScript/TypeScript: https://www.npmjs.com/package/fast-json-patch

[^6]: RFC 6901 — "JavaScript Object Notation (JSON) Pointer": https://datatracker.ietf.org/doc/html/rfc6901

[^7]: `ts-rs` crate — generate TypeScript types from Rust types: https://docs.rs/ts-rs/latest/ts_rs/

[^8]: Anthropic Claude Code CLI reference — `--include-partial-messages` flag (requires `--output-format stream-json`): https://code.claude.com/docs/en/cli-reference

[^9]: `tokio::sync::broadcast` — in-order delivery to each receiver, multi-producer multi-consumer: https://docs.rs/tokio/latest/tokio/sync/broadcast/index.html

[^10]: `rfc6902` npm package — alternative JSON Patch implementation: https://www.npmjs.com/package/rfc6902
