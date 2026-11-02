# ADR-106: Session titles come from the Claude Code transcript

> **Status:** Accepted
> **Date:** 2026-11-02
> **Context:** SPEED-916. One chat session had three labels: the tab showed the first user message, the conversation history showed the `custom-title` or `ai-title` line of the transcript and fell back to the first message, and the CLI's own `/resume` picker showed what Claude Code reads from the same lines. A Desktop session never had an `ai-title` line, because in stream-json mode Claude Code writes one only when its host asks for it, which Speedwave did not do. This ADR records where a session's title lives, who asks for it, and how it reaches the tab.

## Glossary

- **Session**: one Claude Code transcript with one session id. `/clear` and a new chat start a new one. The code's "conversation" (`ConversationSummary`, `resume_conversation`) is the same thing.
- **Tab**: a place in the Desktop UI that holds at most one session at a time and can go through several in its life.
- **Session title**: the one label of a session, read from its transcript in this order: the custom title set with `/rename`, else the AI title Claude Code generated, else the first user message. The tab, the history row and, by construction, the CLI picker show the same value.
- **Preview**: the text of the first user message. It is the fallback for the title and a field the history search matches, never a name of its own.

## Context

- Claude Code names an unnamed interactive session with a generated title, "a short summary of your first prompt, written by a background request to the small/fast model, normally a Haiku-class model", and a `claude -p` run started from a shell gets none[^1]. `/rename <name>` names the current session, and the session picker shows "the session name if you set one, otherwise the AI-generated session title, conversation summary, or first prompt"[^2].
- Transcripts are JSONL files under `~/.claude/projects/<project>/<session-id>.jsonl`, and Anthropic states that "the entry format is internal to Claude Code and changes between versions, so scripts that parse these files directly can break on any release"[^3]. Speedwave already reads these files for the history (`desktop/src-tauri/src/history.rs`, SPEED-384) and pins what it reads with per-version captures (`.claude/rules/alignments.md`).
- The Desktop drives Claude Code through stream-json and its control channel (`desktop/src-tauri/src/control_channel.rs`, ADR-089). On the pinned 2.1.295, recorded against a stub API in `desktop/src-tauri/tests/fixtures/cc-2.1.295-session-title.sanitized.json`:
  - a `generate_session_title` control request takes `description` and `persist`; the title is generated from the description alone, by one request to `claude-haiku-5-5` with `max_tokens` 128000, `output_config.effort` `medium` and a JSON-schema output of one `title` field, a system prompt of 3195 characters and a user message that wraps the description in `<session>` tags (269 characters for the 68-character description of the capture; `generate_session_title.model_request` there); the stub answered without a `usage` block, so the capture holds no token counts, and the usage JSONL the proxy writes (decision 3) is where they are counted at runtime; the `ai-title` transcript line is written only with `persist: true`, at generation and once more at the end of the turn;
  - a repeated request after an AI title exists still calls the model, answers the existing title and writes no line; after a custom title it answers that title without a model request;
  - the request can be sent before the first user message and is persisted once the session file exists;
  - `/rename <name>` works in stream-json: it writes a `custom-title` line and an `agent-name` line with the same value, answers a synthetic `Session renamed to: <name>` and a `result` with `num_turns: 0`, and raises a `system/session_title_changed` line on stdout; a bare `/rename` answers `Could not generate a name: no conversation context yet`.
- SPEED-825 asked whether chat titles should come from Claude Code or from a local model; the capture settles it for chat.

## Decision

1. **The transcript is the only store of a session's title.** `history.rs::SessionTitles`, behind `read_session_title`, is the one reader: the `custom-title` line wins over the `ai-title` line, the latest line of each kind counts, and `agent-name` and `summary` lines are not read. There is no metadata database, no tag store, no title field in the user config, and no Angular code that derives a title. The CLI changes nothing: its picker reads the same lines.
2. **The Desktop asks Claude Code for the AI title.** `desktop/src-tauri/src/session_title.rs` sends `generate_session_title` with `persist: true` right after a user message is written to stdin, when the message is not a slash command and not empty, and only while the session has no title line and no request is in flight. The description is the message text cut to 1000 characters. A queued message drained at the end of a turn follows the same rule. The request runs on its own thread with its own timeout (`GENERATE_TITLE_TIMEOUT`); a failure is logged without the title text and the next eligible message tries again. A session resumed without a title gets one from its next message, not its first.
3. **The request goes wherever the conversation goes.** Every provider kind gets it, Anthropic and proxy-routed alike: the session's `ANTHROPIC_BASE_URL` is the proxy for every kind, a routed provider answers it with its routed model because `ANTHROPIC_DEFAULT_HAIKU_MODEL` is set to that model (`crates/speedwave-runtime/src/compose/llm.rs`), and the proxy records it in the usage JSONL like any other request (`containers/proxy/src/usage.rs::append_usage`), so it counts in the usage view (`desktop/src-tauri/src/llm_cmd/usage.rs::get_llm_usage`) and not in the chat footer, whose numbers come from the turns' `result` lines (`chat.rs::StreamChunk::Result`).
4. **The tab learns the title from the file.** At every `result` line, a turn that ended in an error included, the backend re-reads the transcript's title lines and raises `chat_title_changed` with `{project, tab_id, session_id, title}` when the pair changed (`session_title.rs::TitleState`); a resumed session is announced at start, and a transcript that cannot be read keeps the last announced title. Once Claude Code has answered a title request, a thread polls the same lines for up to 5 s (`PERSIST_POLLS`) and announces the title when the line is there. That poll amends the decision of 2026-11-01 to re-read only at `result`: Claude Code writes the `ai-title` line at generation and at the end of the turn and emits no stream line for it, so a turn shorter than the title generation would otherwise show its title only at the end of the next turn. The control response's own title text is never shown: the answer and the file write are not ordered. The store keeps the title per session id (`ChatSessionStore.title`), the tab row shows it over the first message, cut to `TITLE_MAX_CHARS` (24 characters, `chat-tab-row.ts`) with the whole title in the tooltip, and the history list patches its row from the same event.
5. **`/rename <name>` typed in the composer is the only rename.** It goes to Claude Code as an input and renders as a control chip like `/model` and `/effort`, with a pattern that accepts a multi-word name; a bare `/rename` and the `/name` alias stay plain messages whose reply is visible in the live chat, while the history rebuild drops them like every other local command entry. No tab menu, no rename of an ended session from the history.
6. **Every Claude Code behaviour above is pinned.** `control_channel.rs::the_session_title_capture_is_of_the_pinned_claude_code` fails on a `CLAUDE_VERSION` bump until the capture is recorded again with the procedure in `.claude/rules/architecture.md`.

## Consequences

- Desktop sessions get the same AI titles as CLI sessions, from the same prompt and the same model, and `/rename` reaches all three surfaces at once.
- One short request on the small model per session, bounded by the 1000-character description. The cost is not shown per conversation.
- The reading of `custom-title` and `ai-title` lines is against a format Anthropic calls internal[^3]; the capture and its pin test are what turns a format change into a failing test on the next bump.
- The title shows at the end of a turn or shortly after generation, never from the control response.
- A `/clear` without an argument keeps a name set with `/rename` for the new session and drops an AI title[^4]; the tab follows either way, because the new session's transcript is what it reads.
- Content search of the history stays open as SPEED-918; the CLI picker already matches a sample of message text, the Desktop history matches only the title and the preview.
- The research in SPEED-825 is narrowed to recordings.

## Alternatives rejected

- **A per-project metadata database or file, synced with the transcripts.** A second store beside the transcript with its own synchronization, for a value Claude Code already writes and reads.
- **Tags on sessions.** They do not answer "I do not know what this session was called".
- **A local model generating chat titles (SPEED-825, item 2).** The conversation already goes to the configured provider, and Claude Code generates the title on request with the same prompt the CLI uses.
- **Taking the title from the control response for the live tab.** Two sources for one value; the file write is not awaited before the response, so the tab and the history could disagree.
- **Generating at the end of the turn instead of at the message.** Claude Code's own trigger is the first eligible message, so the same prompt gives the same title as a CLI session, and a long first turn does not postpone it.

## References

[^1]: Anthropic, Claude Code docs, "Manage sessions", section "Name your sessions": the generated title "is a short summary of your first prompt, written by a background request to the small/fast model, normally a Haiku-class model. A `claude -p` run you start directly from a shell or script doesn't get one." https://code.claude.com/docs/en/sessions#name-your-sessions

[^2]: Anthropic, Claude Code docs, "Manage sessions", sections "Name your sessions" (`/rename auth-refactor` during a session, `Ctrl+R` in the picker) and "Use the session picker" ("Each row shows the session name if you set one, otherwise the AI-generated session title, conversation summary, or first prompt"). https://code.claude.com/docs/en/sessions#use-the-session-picker

[^3]: Anthropic, Claude Code docs, "Manage sessions", section "Where transcripts are stored": transcripts live at `~/.claude/projects/<project>/<session-id>.jsonl`; "The entry format is internal to Claude Code and changes between versions, so scripts that parse these files directly can break on any release." https://code.claude.com/docs/en/sessions#where-transcripts-are-stored

[^4]: Anthropic, Claude Code docs, "Manage sessions", section "Manage context within a session", on `/clear`: "With no argument, the new session keeps a name you set with `--name` or `/rename`, but not an AI-generated session title." https://code.claude.com/docs/en/sessions#manage-context-within-a-session
