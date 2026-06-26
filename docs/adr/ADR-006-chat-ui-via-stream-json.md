# ADR-006: Chat UI via claude -p --stream-json

> **Status:** Accepted
> **Context:** The Desktop needs to embed Claude Code in a chat GUI with real-time token streaming and multi-turn conversation, without a terminal.

## Decision

Run Claude Code headless (`claude -p`) with `--output-format=stream-json --input-format=stream-json --include-partial-messages`. Claude emits typed NDJSON on stdout; the host writes user messages (and control responses) to stdin. The process stays alive across turns, so one subprocess serves a whole conversation.

## Why

- Headless mode (`-p`) plus `stream-json` output yields newline-delimited JSON the host can parse incrementally for real-time token streaming.
- `--input-format=stream-json` makes the channel bidirectional: the same long-lived subprocess handles many turns, preserving session, context, and MCP-hub state.
- The chat UI gives non-technical users a far better experience than an embedded terminal, while still exposing Claude Code's real tools (Read, Edit, Bash).

## How it works

- The base CLI invocation (`-p`, `--output-format stream-json`, `--input-format stream-json`, `--verbose`, `--include-partial-messages`, `--permission-prompt-tool stdio`, plus optional `--resume`/`--resume-session-at`) is assembled by `build_claude_args()` in `desktop/src-tauri/src/chat.rs`. It does **not** add `--dangerously-skip-permissions` itself — that flag (along with `--mcp-config`, `--strict-mcp-config`, `--thinking-display summarized`) arrives through the `flags` argument, whose source is `DEFAULT_FLAGS` in `crates/speedwave-runtime/src/defaults.rs`. The security rationale for skipping permissions lives in the comment on that constant: Claude runs in an isolated, read-only, token-free, capability-dropped container.
- A background thread reads the subprocess stdout (running inside the container via container exec), feeds each line to `StreamParser::parse_line()`, and emits typed `StreamChunk` events to Angular via Tauri's `app_handle.emit("chat_stream", ...)`. Direct emission was chosen over an intermediate mpsc channel + polling bridge, which added latency and a middleman.
- Every emit is sanitized first (`sanitize_chunk` in `chat.rs`) so neither the `chat_stream` channel nor its patch mirror can leak secrets.

## Stream protocol shape

- Output is typed NDJSON. `--include-partial-messages` makes Claude emit `stream_event` messages wrapping raw Anthropic Messages API events (`content_block_start/delta/stop`, `message_stop`) for real-time token, thinking, and tool-input streaming. Complete `assistant` messages are intentionally ignored — they duplicate content already streamed.
- Input lines use the `user` message shape (`{"type":"user","message":{"role":"user","content":...}}`); `content` is a string or an array of content blocks for image input. The host wire format is `WireContentBlock` (`desktop/src-tauri/src/chat.rs`, mirrored in `desktop/src/src/app/models/chat.ts`; see ADR-065).
- `StreamParser` collapses the raw events into the `StreamChunk` tagged enum (`desktop/src-tauri/src/chat.rs`, mirrored 1:1 by the TS `StreamChunk` union in `desktop/src/src/app/models/chat.ts`). It has **12 variants**: `Text`, `Thinking`, `ToolStart`, `ToolInputDelta`, `ToolResult`, `Result`, `AskUserQuestion`, `Error`, `SystemInit` (model from the system-init message), `RateLimit`, `UserMessageCommit` (commits a UUID onto the latest user entry, ADR-046), and `QueueDrained` (one-slot queued message drained server-side, ADR-045).
- The frontend accumulates `MessageBlock[]` during a turn; the TS `MessageBlock` union (`desktop/src/src/app/models/chat.ts`) covers `text`, `thinking`, `tool_use`, `ask_user`, `error`, `permission_prompt`, and `image` (metadata only — ADR-065). Only the `Result` chunk finalizes a turn, moving the blocks into the message list and capturing session stats (session id, cost from `total_cost_usd`, usage).

## Interactive questions, stop, retry

- **AskUserQuestion:** Claude sends a `control_request` via `--permission-prompt-tool stdio` (up to 4 questions). The host parses an `AskUserQuestion` chunk; the frontend answers each slot via the `submit_question_answer` command, and once all slots are filled the host writes one `control_response` to stdin. A 4-question cap and a serialized-wire byte ceiling (`MAX_ASK_USER_QUESTIONS` / `MAX_ASK_USER_WIRE_BYTES` in `crates/speedwave-runtime/src/stream/`) guard against adversarial fan-out; duplicate question texts are rejected at build time.
- **Stop/interrupt:** the `stop_chat` command writes a `control_request` with `subtype: interrupt` to stdin. Claude aborts the in-flight turn, emits a `result` with an error subtype, and stays ready on the same stdin — session and history are preserved. Killing the host-side container exec would not signal the in-container process, so the protocol-level interrupt is the only reliable cancel.
- **Auto-retry:** if `send_message` fails with a session-death error ("session exited", "no active session", "Broken pipe"), the frontend transparently restarts the subprocess via `start_chat` and retries. The interrupt path never triggers this — the session is still alive after a stop.

## Chat history

The Desktop exposes Tauri commands backed by `desktop/src-tauri/src/history.rs` (wired in `desktop/src-tauri/src/main.rs`) that read Claude Code's native JSONL session files at `~/.speedwave/claude-home/<project>/.claude/projects/-workspace/*.jsonl` (resolved by `sessions_dir_impl`, with auto-discovery fallback when the `-workspace` dir name differs):

- `list_conversations(project)` — lists sessions by last activity, newest-first, with a preview (junk `/`-only sessions filtered out).
- `get_conversation(project, session_id)` — reads one session into rich `MessageBlock[]`.
- `get_project_memory(project)` — reads the project's `MEMORY.md` (empty string if absent).
- `resume_conversation(project, session_id)` — stops the current session and starts a new subprocess with `--resume <id>`.

Session ids are validated as lowercase UUID hex before any file access (path-traversal prevention).

## Rejected alternatives

- **Anthropic API directly** — no access to Claude Code's tools (Read, Edit, Bash).
- **Embedded terminal (xterm.js)** — workable, but a chat UI is better UX for non-technical users.
- **mpsc channel → polling bridge** — extra latency and a middleman vs. direct `app_handle.emit()`.
- **Finalizing on the `assistant` message** — duplicates content already streamed via `stream_event`.

## References

- Claude Code headless mode and CLI reference: https://code.claude.com/docs/en/headless and https://code.claude.com/docs/en/cli-reference
- Claude Agent SDK streaming output: https://platform.claude.com/docs/en/agent-sdk/streaming-output
