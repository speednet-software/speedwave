# ADR-006: Chat UI via claude -p --stream-json

## Decision

The Desktop uses `claude -p --output-format=stream-json --input-format=stream-json --include-partial-messages` to embed Claude Code in the GUI with real-time token streaming and bidirectional multi-turn conversation.

## Rationale

Claude Code has a headless mode (`-p`/`--print`) that runs non-interactively without a terminal UI.[^41] Combined with `--output-format=stream-json`, it produces NDJSON (newline-delimited JSON) on stdout.[^17] Adding `--input-format=stream-json` enables bidirectional communication — the host writes user messages to stdin, Claude responds on stdout, and the process stays alive across turns.[^42]

vibe-kanban[^16] uses the identical approach — a proven production pattern.

```bash
claude -p \
  --output-format=stream-json \
  --input-format=stream-json \
  --verbose \
  --include-partial-messages \
  --dangerously-skip-permissions
```

`--verbose` is recommended alongside `--include-partial-messages` for full streaming output.[^41]

## Stream-JSON Output Protocol

Claude Code's stream-json output consists of typed NDJSON messages. The `SDKMessage` union type defines five message types:[^43]

| Message Type                 | `type` Field   | Purpose                                                                  |
| ---------------------------- | -------------- | ------------------------------------------------------------------------ |
| `SDKPartialAssistantMessage` | `stream_event` | Real-time token streaming — wraps raw Anthropic Messages API events[^44] |
| `SDKAssistantMessage`        | `assistant`    | Complete assistant turn (all content blocks finalized)                   |
| `SDKResultMessage`           | `result`       | Final result — conversation turn done, includes `is_error` flag          |
| `SDKSystemMessage`           | `system`       | System messages (e.g. compact boundary markers)                          |
| `SDKUserMessage`             | `user`         | Echo of user messages                                                    |

**`stream_event` structure:** When `--include-partial-messages` is enabled,[^45] Claude emits `stream_event` messages that wrap raw Anthropic Messages API events in the `event` field.[^44] The key event types are:

| Event Type            | Delta Type         | Contains                                               |
| --------------------- | ------------------ | ------------------------------------------------------ |
| `content_block_start` | —                  | Start of text or `tool_use` block (includes tool name) |
| `content_block_delta` | `text_delta`       | Incremental text token (real-time streaming)           |
| `content_block_delta` | `input_json_delta` | Tool input JSON fragment                               |
| `content_block_stop`  | —                  | End of content block                                   |
| `message_stop`        | —                  | End of message                                         |

Example `stream_event` for a text token:

```json
{
  "type": "stream_event",
  "event": { "type": "content_block_delta", "delta": { "type": "text_delta", "text": "Hello" } }
}
```

## Stream-JSON Input Protocol

The input format for `--input-format=stream-json` uses the `SDKUserMessage` structure:[^46]

```json
{
  "type": "user",
  "message": { "role": "user", "content": [{ "type": "text", "text": "user message here" }] }
}
```

The `content` field accepts either a plain string or an array of content blocks (for multi-modal input with images).[^46] Each JSON message is written as a single line to stdin, followed by a newline.

## Tauri Integration Architecture

```
Claude subprocess (inside container via container_exec_piped)
  stdout → BufReader → background thread → StreamParser::parse_line() → app_handle.emit("chat_stream", chunk)
  stdin  ← build_user_message() → writeln!(stdin, "{}", json)
  stdin  ← answer_question()    → writeln!(stdin, "{}", control_result_json)
                                                    ↓
Angular frontend ← listen("chat_stream") → handleStreamChunk() block-based state machine
```

**Design decision: direct Tauri event emission, not mpsc channel.** The background thread that reads Claude's stdout calls `app_handle.emit()` directly to push `StreamChunk` events to the Angular frontend. An earlier design used an intermediate `mpsc::channel` to collect output, but this required a separate polling mechanism to bridge chunks to the frontend — adding latency and complexity. Direct emission eliminates the middleman.

**Block-based streaming model.** The backend `StreamParser` converts raw NDJSON `stream_event` messages into typed `StreamChunk` variants:

| StreamChunk Variant | Source Event                                     | Frontend Action                                                |
| ------------------- | ------------------------------------------------ | -------------------------------------------------------------- |
| `Text`              | `content_block_delta` with `text_delta`          | Append to current text block (or create new one)               |
| `Thinking`          | `content_block_start/delta` with `thinking` type | Append to current thinking block (collapsible)                 |
| `ToolStart`         | `content_block_start` with `tool_use` type       | Push new `ToolUseBlock` with `status: running`                 |
| `ToolInputDelta`    | `content_block_delta` with `input_json_delta`    | Append partial JSON to matching tool block                     |
| `ToolResult`        | User message with `tool_result` content          | Complete tool block with result and `status: done/error`       |
| `AskUserQuestion`   | `control_request` with `AskUser` tool            | Push interactive question block with options                   |
| `Result`            | `result` message type                            | Finalize turn: capture `SessionStats`, move blocks to messages |
| `Error`             | Parse failures, subprocess errors                | Push error block and finalize turn                             |

The frontend accumulates `MessageBlock[]` in `currentBlocks` during an assistant turn. Each `MessageBlock` is one of: `text`, `thinking`, `tool_use`, `ask_user`, or `error`. Only the `Result` chunk finalizes the turn — it moves `currentBlocks` into the `messages` array as a complete `ChatMessage { role, blocks, timestamp }` and captures `SessionStats` (session_id, cost_usd, total_cost, usage). The `assistant` message type from Claude is intentionally ignored — it duplicates content already streamed via `stream_event`.

**Interactive questions (AskUserQuestion flow).** When Claude needs user confirmation (e.g., permission to run a tool), it sends a `control_request` via `--permission-prompt-tool stdio`. The backend parses this into an `AskUserQuestion` chunk containing the question text, selectable options, and a `tool_id`. The frontend renders the question with option buttons. When the user selects an answer, the frontend calls the `answer_question` Tauri command with the `tool_use_id` and selected value(s). The backend writes a `control_result` JSON message to Claude's stdin, and Claude resumes execution.

**Auto-retry on session death.** If `send_message` fails with "session exited", "no active session", or "Broken pipe", the frontend transparently restarts the Claude subprocess via `start_chat` and retries the message — the user sees no interruption.

## Chat History API

The Desktop exposes four Tauri commands for browsing and resuming past conversations. All operate on Claude Code's native JSONL session files stored at `~/.speedwave/data/claude-home/<project>/.claude/projects/-workspace/*.jsonl`.

| Command               | Parameters              | Returns                  | Description                                                                                         |
| --------------------- | ----------------------- | ------------------------ | --------------------------------------------------------------------------------------------------- |
| `list_conversations`  | `project`               | `ConversationSummary[]`  | Lists JSONL session files, sorted newest first. Reads first ~50 lines per file for preview/count    |
| `get_conversation`    | `project`, `session_id` | `ConversationTranscript` | Reads a full session by UUID. Returns messages with rich `MessageBlock[]` for block-based rendering |
| `resume_conversation` | `project`, `session_id` | `()`                     | Stops current session, starts a new Claude subprocess with `--resume <session_id>`                  |
| `get_project_memory`  | `project`               | `String`                 | Reads the project's MEMORY.md file. Returns empty string if the file does not exist                 |

Session IDs are validated as lowercase UUID v4 hex strings before any file access (path traversal prevention). `resume_conversation` re-uses the existing `ChatSession::start()` with an optional `resume_session_id` parameter that appends `--resume <id>` to the Claude CLI arguments.

## Rejected Alternatives

- **Anthropic API directly** — no access to Claude Code tools (Read, Edit, Bash)
- **Tauri terminal (xterm.js)** — possible, but chat UI provides better UX for non-technical users
- **mpsc channel → polling bridge** — adds latency; direct `app_handle.emit()` is simpler and faster
- **Finalizing on `assistant` message** — causes duplicate messages when combined with `stream_event` streaming

---

[^16]: [vibe-kanban - Claude Code GUI integration](https://github.com/BloopAI/vibe-kanban)

[^17]: [Claude Code CLI reference - --output-format](https://code.claude.com/docs/en/cli-reference)

[^41]: [Claude Code Headless Mode — -p flag and stream responses](https://code.claude.com/docs/en/headless)

[^42]: [Claude Code CLI reference — --input-format stream-json](https://code.claude.com/docs/en/cli-reference)

[^43]: [Claude Agent SDK TypeScript — SDKMessage union type](https://platform.claude.com/docs/en/agent-sdk/typescript)

[^44]: [Claude Agent SDK — Streaming Output and StreamEvent reference](https://platform.claude.com/docs/en/agent-sdk/streaming-output)

[^45]: [Claude Code CLI reference — --include-partial-messages](https://code.claude.com/docs/en/cli-reference)

[^46]: [Claude Agent SDK — Streaming vs Single Mode, input message format](https://platform.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)
