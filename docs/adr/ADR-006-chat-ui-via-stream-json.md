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
  stdout → BufReader → background thread → parse_stream_line() → app_handle.emit("chat_stream", chunk)
  stdin  ← build_user_message() → writeln!(stdin, "{}", json)
                                                    ↓
Angular frontend ← listen("chat_stream") → handleStreamChunk() state machine
```

**Design decision: direct Tauri event emission, not mpsc channel.** The background thread that reads Claude's stdout calls `app_handle.emit()` directly to push `StreamChunk` events to the Angular frontend. An earlier design used an intermediate `mpsc::channel` to collect output, but this required a separate polling mechanism to bridge chunks to the frontend — adding latency and complexity. Direct emission eliminates the middleman.

**State machine — `result` as sole finalizer.** The frontend accumulates text from `stream_event`/`text_delta` chunks into `currentStream`. Only the `result` message finalizes the accumulated text as a complete assistant message. The `assistant` message type is intentionally ignored — it duplicates content already streamed via `stream_event`. Using both would cause each response to appear twice.

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
