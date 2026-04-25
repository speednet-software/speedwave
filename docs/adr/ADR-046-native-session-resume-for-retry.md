# ADR-046: Native Session Resume for Assistant-Message Retry

**Status:** Accepted
**Date:** 2026-04-25

## Context

Feature 2 of `design-proposals/06-terminal-minimal-implementation-prompt.md` — "Copy & Retry on assistant messages" — requires a way to re-run the last turn: discard the current assistant response, keep everything before it, and spawn a new generation against the same user message. The user flow: they read the answer, find it unhelpful, click Retry; the assistant message is removed, the user's prior message shows `· edited`, and a new answer streams in.

Earlier proposals suggested implementing this by editing the session's JSONL file directly: open `~/.claude/projects/<hash>/<session_id>.jsonl`, truncate past the last user message, close the file, then launch `claude --resume <session_id>`. This works in isolation but breaks in predictable ways:

1. **Concurrency.** Claude Code itself writes to the same JSONL. If a write is in flight when Speedwave truncates, the file can end in a half-written entry — breaking `--resume` entirely.
2. **Format ownership.** The JSONL format is internal to Claude Code and explicitly not a public contract. Any structural change in a Claude Code release (v2.1.x → v2.2.x) can silently break Speedwave's truncation logic, with no deprecation path.
3. **Lock coordination.** Even if the format were stable, there is no documented lock protocol between an external editor and Claude Code. On Windows, the file may be held exclusively by the running process.
4. **Resume semantics drift.** `--resume` assumes the file is a trace of what happened. Trimming it rewrites history, and subtle behaviors (caching, context, memory references) may key off things the trimmed trace no longer represents.

Claude Code ships a first-class flag for this exact flow: `--resume-session-at <uuid>`. It resumes a session and rewinds the conversation to the specified message UUID, discarding everything after. No file mutation by the caller. BloopAI/vibe-kanban's Claude Code executor uses this flag for its Checkpoint / retry feature and it has been in production since the flag landed.[^1][^2]

The flag is observable in Claude Code's CLI (accepted as an argument to `claude` alongside `--resume`[^1]) and in vibe-kanban's `claude.rs` which explicitly passes `"--resume-session-at"` when spawning a retry process[^2]. Speedwave adopts the same approach.

## Decision

**Retry flow:**

1. User clicks Retry on the last committed assistant entry in a non-streaming session.
2. Frontend calls `invoke('retry_last_turn', { sessionId })`.
3. Backend resolves the last committed user-message UUID from the state-tree.
4. Backend kills any stale `claude` child for the session (there should be none because `!streaming`, but defend against orphans).
5. Backend spawns `claude --resume <session_id> --resume-session-at <user_uuid>` via `ContainerRuntime::container_exec_piped`[^3] with the usual `--output-format stream-json`[^4] flags. If the spawn itself fails (binary missing, container gone, pipe setup error), return `ResumeFailed` and emit no patches — the state-tree is untouched.
6. Once the child is confirmed running, backend emits JSON Patches: `Remove` on the assistant entry, `Replace` on the user entry setting `edited_at = now`. Output from the child routes into the normal patch pipeline.
7. Frontend observes the new assistant entry streaming in, addressed by a fresh index (ADR-044) with a new UUID (`Pending` until the `Result` event — see UUID tracking below).

**UUID tracking — `uuid` and `uuid_status` on every entry:**

Per ADR-042, each `ConversationEntry` carries `uuid: Option<String>` and `uuid_status: Committed | Pending`. Populated as Claude Code streams messages — the envelope shape (`SystemMessage`, `UserMessage`, `AssistantMessage`, `ResultMessage` with `message.id`) is shared with the Claude Agent SDK types[^5]:

- **User entries** — The stream-json `user` message carries a stable `message.id` (UUID). Speedwave's parser extracts it and emits `Replace` at `/entries/<i>/uuid` with `uuid_status: Committed` on the first event. User UUIDs commit immediately because the user turn is atomic and fully known at send time.
- **Assistant entries** — The stream-json `assistant` message's `message.id` is emitted on the first block of an assistant turn. Speedwave stores it as `uuid_status: Pending`. It remains `Pending` across all deltas, tool uses, and tool results that may arrive in interleaved order. Only when the `Result` event[^4] fires does the parser emit a `Replace` at `/entries/<i>/uuid_status` setting it to `Committed`. This mirrors vibe-kanban's pending-uuid pattern[^2] and prevents retry from targeting an assistant turn that hasn't finished.

**Tauri command — `desktop/src-tauri/src/retry_cmd.rs`:**

```
#[tauri::command]
async fn retry_last_turn(session_id: String) -> Result<(), RetryError>;

enum RetryError {
    NoAssistantTurn,      // state has no committed assistant entry
    PendingAssistant,     // last assistant is Pending
    SessionNotFound,
    Streaming,            // session is currently producing output
    ResumeFailed(String), // child failed to spawn; state-tree unchanged
}
```

Each error corresponds to a guard executed in the order above. `ResumeFailed` is scoped strictly to **spawn failure** — if the child process fails to start via `ContainerRuntime::container_exec_piped`[^3], the `Remove` and `edited_at` patches are not emitted and the state-tree is untouched. Implementation: the backend calls `container_exec_piped` first and only emits patches once the child is confirmed running. Any error that surfaces **after** the spawn (rate limit, network failure, broken pipe mid-stream, child exit without a `Result` event) is a different class of failure — see Known Limitations below; the `Remove` patch has already been emitted by the time such errors are observable.

**File mutation is forbidden.** The backend must not open, read, truncate, or write the session JSONL. The only interface with the session file is through `claude --resume` / `claude --resume-session-at`. An E2E test (`desktop-e2e/` flow) checksums the JSONL before and after a retry operation and asserts the only changes are those written by Claude Code itself during the resumed turn.

**Why UUIDs (not indices) for retry addressing:**

Indices (ADR-044) are Speedwave-internal and not known to Claude Code. `--resume-session-at` accepts only UUIDs, because that is what the session JSONL contains.[^2] The two ID systems serve different layers: indices address the UI state-tree; UUIDs address Claude Code's session trace. Both are necessary, neither is sufficient.

**What Retry is and is not:**

- **Is**: re-run the last assistant turn with the same user input, replacing the assistant entry.
- **Is not**: edit the user message. If Feature 2 ever adds "edit your question and re-run", that is a superset — the flow is "mutate the user message text on disk via `--resume-session-at` against the user message _before_ the one to edit, then `stdin << new_text` into the resumed process". Not in scope today.
- **Is not**: multi-turn rewind. Retry operates on exactly the most recent turn pair. Rewind-to-arbitrary-point is out of scope.

## Consequences

### Positive

- Retry correctness is Claude Code's responsibility, not Speedwave's. When Anthropic fixes an edge case in `--resume-session-at`, Speedwave benefits automatically — no mirror fix needed.
- No file-mutation attack surface. The session JSONL is a private contract of Claude Code; Speedwave never touches it. Future JSONL format changes do not affect retry.
- UUIDs become a first-class identifier in the state-tree anyway, which makes other features (hyperlinking a log event to a message, cross-session references) straightforward if ever needed.
- Composes cleanly with ADR-042 (patches), ADR-043 (MsgStore), ADR-044 (indices), ADR-045 (queue): retry drains the queue if any message is pending-queued (the session-end handler sees the `Result` of the retry turn just like any other), and Resync scenarios continue to work because the new entry has a fresh index.
- Direct parallel to vibe-kanban's production retry flow[^2].

### Neutral

- The `Pending` / `Committed` UUID split adds a small amount of complexity to the stream parser — but the split is isolated to the UUID field; the rest of the entry commits as it streams.
- Retry adds one additional `claude` process lifecycle per retry click. The existing process management in `ContainerRuntime::container_exec_piped`[^3] handles this.

### Negative

- `--resume-session-at` is part of Claude Code's CLI surface[^2]; if Anthropic ever removes it, Speedwave loses retry. Mitigation: the feature is gated behind a runtime capability check (attempt retry, catch "unknown flag" stderr, fall back to disabling the Retry button with a banner). Not built until observed in practice.
- Retry requires the session to be not-streaming. Users who click Retry while the assistant is still talking get a silently-ignored click (guard returns `Streaming` error, toast informs them). Accepted.
- The assistant UUID is `Pending` during streaming and therefore not a retry target until the `Result` event. Racing the button is harmless (guard rejects), but it means "spam-click Retry to re-generate" does not work as some users might expect. Documented; the Retry button is disabled visually while `!canRetry`.

## Known Limitations

- If the container host aliases rewrite (`host.*.internal` etc.) ever changes between the original turn and the retry, Claude Code may see different network paths. Not expected in practice — config changes require restart — but noting that retry is not guaranteed bit-identical to the original turn's environment.
- `--resume-session-at` docs are minimal; the exact behavior when the referenced UUID is mid-tool-call (server-side partial state) is undocumented. Speedwave only allows retry against `Committed` user UUIDs, which are atomic from Claude Code's perspective, so the partial-tool case cannot arise for this feature. Leaving this as a Known Limitation flags it for the implementation PR to verify empirically.
- Transactionality ends at the spawn boundary. Once the child is running, the `Remove` patch has been emitted and the old assistant entry is gone from the state-tree. Any subsequent failure during the resumed turn — rate-limit error, network drop, broken pipe, child exit without a `Result` event, container going down — leaves the state-tree in the post-Remove state: the user message is present with `edited_at` set, and the new assistant entry is either absent (failure before any stream bytes) or partial (failure mid-stream). Speedwave does not roll back the `Remove`, does not restore the old assistant entry, and does not buffer patches until `Result` for this purpose. The user sees the state that the stream produced — same as if they had just typed the message and the turn failed. Recovery: click Send in the composer to re-issue. Accepted as cheap to recover from and consistent with all other mid-stream failure modes.

## References

[^1]: Anthropic Claude Code CLI reference — `--resume` and related flags (`--resume-session-at` referenced by vibe-kanban's production spawn code[^2] as the trim-and-continue mechanism): https://code.claude.com/docs/en/cli-reference

[^2]: BloopAI/vibe-kanban — `claude.rs` executor uses `"--resume"` and `"--resume-session-at"` when spawning retry processes; pending-UUID pattern for assistant turns: https://github.com/BloopAI/vibe-kanban/blob/main/crates/executors/src/executors/claude.rs

[^3]: Speedwave runtime `ContainerRuntime::container_exec_piped` — process spawning (with stdio piped for stream-json parsing) inside the active claude container: `../../crates/speedwave-runtime/src/runtime/mod.rs`

[^4]: Anthropic Claude Code CLI reference — `--output-format stream-json`, `Result` event marks turn completion: https://code.claude.com/docs/en/cli-reference

[^5]: Anthropic Claude Agent SDK — `SystemMessage`, `UserMessage`, `AssistantMessage`, `ResultMessage` types reference the same stream-json event shapes: https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/types.py
