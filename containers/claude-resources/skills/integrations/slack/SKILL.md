---
name: slack
description: >
  Use Slack integration to read and send Slack messages as the signed-in user — listing the
  channels they belong to, reading or exporting channel history and threads (with pagination),
  reading text files shared in channels (markdown, code, logs), posting messages, and looking
  up workspace users by e-mail. Use whenever the user asks about Slack — "what's new on
  #channel", "summarise this week's discussion including threads", "read the file Paweł
  shared", "post an update to the team", "find the message where…", etc. Use even when you think you know the answer — channel content
  is dynamic; only the live API reflects current messages.
  Do not use for: direct messages and group DMs (not in scope), Slack administration (creating
  channels, inviting members, workspace settings), or messaging platforms other than Slack.
user-invocable: false
allowed-tools: mcp__speedwave-hub__search_tools mcp__speedwave-hub__execute_code
---

# Slack

Slack access goes through MCP Hub. You do not see `slack__*` tools directly — they are discovered at call time via `search_tools` and invoked through `execute_code` using the injected `slack` global. Authentication is OAuth handled entirely by Speedwave (the token rotates and refreshes automatically) — never ask the user for a token.

**You act AS the signed-in user.** Every message you send appears under their name and avatar, indistinguishable from one they typed themselves. There is no bot identity, and consequently no "invite the integration to a channel" concept — you see exactly the channels the user is a member of, nothing more.

## Workflow

1. **Discover** — `search_tools({ query: "slack <keywords>", detail_level: "names_only" })`.
2. **Inspect** — `search_tools({ query: "...", detail_level: "full_schema", service: "slack" })` for exact parameter names.
3. **Execute** — `execute_code` with dot notation: `await slack.getChannelMessages({ channel: "#general" })`.

Always do steps 1–2 before calling a tool for the first time in a conversation.

## Slack-specific pitfalls

**Posting is personal** — the message is signed as the user. The global write-confirmation rule in `claude-resources/CLAUDE.md` applies with extra weight: restate the exact channel and message text and wait for explicit go-ahead before `sendChannel`. Never post drafts, partial summaries, or anything the user has not approved verbatim.

**Membership defines visibility** — `listChannelIds` returns every public and private channel the user is a member of (pagination is handled inside the tool). If a channel is missing, the user is not a member — joining it in Slack is the only fix; there is nothing to "add" or "invite" on the integration side.

**Full-history export is a cursor loop** — `getChannelMessages` returns one page (newest first) plus `next_cursor`/`has_more`. To read further back, call again with `cursor: next_cursor` until `has_more` is false. Combine with `oldest`/`latest` (Slack `ts` strings, e.g. `"1717000000.000000"`) to bound a time window. Expect long channels to take several calls — keep the user informed of progress on big exports.

**Channel references** — tools accept `#name`, bare `name`, or a channel ID (`C…`/`G…`/`D…`). Name resolution scans the (paginated) channel list each time — when you will touch a channel repeatedly, resolve once via `listChannelIds` and reuse the ID.

**Threads need explicit expansion** — channel history returns top-level messages; a thread parent carries `reply_count > 0` and `thread_ts`. Fetch the full thread with `getThreadMessages({ channel, thread_ts })` (parent first, then replies oldest-first; paginate with `cursor`). For a complete channel export, expand every message with `reply_count > 0` — without that step the discussion inside threads is invisible.

**Files and app messages** — uploads arrive as `files[]` metadata on the message (often with empty `text`); read text files (markdown, code, logs, JSON) inline via `getFileContent({ file: files[0].id })`. For binary files (PDF, Word/Excel, images) do NOT stop at metadata: `downloadFile({ file })` saves them to `/workspace/slack-files/…`, then read PDFs/documents through the office integration (when enabled) or the filesystem; if neither can process it (e.g. an image), give the user the workspace path. A `missing_scope` / "Permission denied" error means the sign-in predates the file permission — tell the user to Re-authorise Slack in Desktop. Messages from apps (Jira, CI bots) frequently carry their content in `attachments_text`, not `text` — check it before declaring a message empty.

**DMs are out of scope** — the OAuth grant covers channels only (`channels:*`, `groups:*`). Listing or reading IMs/MPIMs fails with `missing_scope`; tell the user instead of retrying.

**Rate limits** — Slack throttles per method. On a `ratelimited` error, stop and tell the user; do not retry in a loop. For multi-page exports, sequential calls (no parallel bursts) stay comfortably under the limit.

**Auth errors self-heal once** — an expired access token refreshes automatically mid-call. If a tool still returns "Reconnect Slack in Speedwave Desktop", the sign-in itself has expired (e.g. 30 days idle) — direct the user to Integrations → Slack and stop.

**Free-plan workspaces** — Slack hides messages older than the plan's retention window from the API as well as the UI; an export that stops early on an old channel may have hit that wall, not a bug.

**User lookup is e-mail-only** — `getUsers` resolves a user by e-mail address (`users.lookupByEmail`). There is no name search; ask the user for the address when identity matters.

## When not to use this skill

- Direct messages / group DMs — not covered by the granted scopes; tell the user.
- Channel/workspace administration (create, archive, invite, rename) — no such tools; direct the user to Slack.
- Reading channels the user is not a member of — impossible by design; the user must join the channel first.
