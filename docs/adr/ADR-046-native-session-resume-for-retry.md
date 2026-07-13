# ADR-046: Native Session Resume for Assistant-Message Retry

> **Status:** Accepted
> **Context:** "Copy & Retry on assistant messages" (Feature 2 of `design-proposals/06-terminal-minimal.html`) needs to re-run the last turn — discard the current assistant answer, keep everything before it, and regenerate against the same user message.

## Decision

Retry uses Claude Code's first-class `--resume-session-at <uuid>` flag instead of editing the session JSONL ourselves. The backend spawns `claude --resume <session_id> --resume-session-at <user_uuid>` with the usual `--output-format stream-json`[^1]; Claude Code rewinds its own session trace to that user-message UUID and regenerates. Speedwave never opens, truncates, or writes the session file.

The flow is frontend-driven. The frontend (which owns the conversation state-tree today) resolves the retry anchor — the current `session_id` and the UUID of the user prompt to rewind to — optimistically trims the old assistant entry, stamps `edited_at` on the user entry, and invokes the `retry_last_turn` Tauri command with both IDs. The backend validates them, stops the live session (kills the child, drains reader threads), then starts a new one with the resume flags. On backend failure the frontend reverts the optimistic changes and surfaces an error block.

## Why

- **Correctness is Claude Code's job.** Trim-and-continue is internal to its session format; when Anthropic fixes an edge case in `--resume-session-at`, Speedwave inherits the fix with no mirror change.
- **No file-mutation attack surface.** The session JSONL is a private Claude Code contract. Editing it directly would race Claude Code's own writes, depend on an undocumented lock protocol (the file may be held exclusively on Windows, a default file-sharing behavior for processes that do not explicitly opt into shared access[^2]), and break silently on any format change between Claude Code releases.
- **UUIDs are the only retry address Claude Code accepts.** `--resume-session-at` keys off the UUIDs in the session trace; Speedwave's internal entry indices (ADR-044) are unknown to Claude Code. The two ID systems address different layers — indices for the UI state-tree, UUIDs for the session trace.
- **Composes with the streaming stack** (the `chat_stream` chunk pipeline plus the ADR-045 queue; the ADR-042/043/044 patch transport it originally composed with was later retired): the resumed turn flows through the normal stream pipeline and ends with a normal `Result` event.

## Scope

- **Is:** re-run the last assistant turn against the same user input, replacing the assistant entry.
- **Is not:** editing the user message text, or rewinding to an arbitrary earlier point. Retry operates on exactly the most recent turn pair.

## Where it lives in code

- Tauri command + error type — `desktop/src-tauri/src/retry_cmd.rs`. `retry_last_turn(session_id, user_uuid, ...)` validates inputs, stops the old session via the `SessionDriver` abstraction, then calls `start_with_retry`.
- `RetryError` enum (`retry_cmd.rs`) has **three** variants: `NoAssistantTurn`, `SessionNotFound`, `ResumeFailed(String)`. Two earlier variants were dropped during review: `Streaming` (speculative, removed per YAGNI in commit `990f9c46`) and `PendingAssistant` (unreachable — the frontend `canRetry` signal already gates against retrying a still-streaming turn, removed in commit `87dc67ad`). Serialised as a tagged enum so the frontend matches on `kind` without string-matching messages.
- Flag assembly + UUID validation — `desktop/src-tauri/src/chat.rs`: `start_with_retry` adds `--resume-session-at <uuid>`; `validate_retry_uuid` rejects empty, overlong, shell-metachar, and path-traversal inputs.
- Frontend retry — `desktop/src/src/app/services/chat-state.service.ts` (`retryLastAssistant` / `findRetryAnchor`) does the optimistic local trim and invokes `retry_last_turn`.
- Process spawning — `LockedRuntime::container_exec_piped` in `crates/speedwave-runtime/src/runtime/locked.rs` runs the resumed `claude` child with piped stdio for stream-json parsing. `LockedRuntime` is the public runtime handle (ADR-066); it delegates to the crate-internal `ContainerRuntime` trait.

## Known limitations

- **Transactionality ends at the spawn boundary.** Once the resumed child is running, the old assistant entry has already been trimmed from local state. A later failure during the resumed turn (rate-limit, network drop, broken pipe, child exit without a `Result` event) leaves the user message present with `edited_at` set and the new assistant entry absent or partial — same as any other mid-stream failure. Recovery is to re-issue from the composer. Accepted as cheap to recover from.
- **CLI-surface dependency.** `--resume-session-at` is part of Claude Code's CLI; if Anthropic removed it, retry would break. Mitigation (capability check + disable the Retry button) is deferred until observed in practice.
- Retry is only allowed against committed user UUIDs, which are atomic from Claude Code's perspective, so the undocumented "UUID mid-tool-call" partial-state case cannot arise for this feature.

## Rejected alternatives

- **Edit the session JSONL directly** (truncate past the last user message, then `claude --resume`): races Claude Code's concurrent writes, depends on an undocumented external-editor lock protocol, and is brittle against the private, version-unstable JSONL format.

## References

- Anthropic Claude Code CLI reference documents `--resume`, `--session-id`, `--fork-session`, `--no-session-persistence`, and `--output-format stream-json`[^1] — `--resume-session-at` is observed on the CLI surface and used by `build_claude_args` in `desktop/src-tauri/src/chat.rs`, but is not listed in that public reference (tracked as the CLI-surface dependency under Known limitations).
- BloopAI/vibe-kanban uses the same `--resume-session-at` trim-and-continue mechanism in its Claude Code executor[^3].

[^1]: Anthropic Claude Code CLI reference: https://code.claude.com/docs/en/cli-reference

[^2]: Microsoft Learn, "Creating and Opening Files" (Win32 apps): an open file with a zero `dwShareMode` cannot be shared and cannot be reopened until its handle is closed, i.e. exclusive access by default: https://learn.microsoft.com/en-us/windows/win32/fileio/creating-and-opening-files

[^3]: BloopAI/vibe-kanban repository (Claude Code executor uses `--resume-session-at`): https://github.com/BloopAI/vibe-kanban
