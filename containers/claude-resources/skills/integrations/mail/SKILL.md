---
name: mail
description: Use the OS mail integration to query the user's native macOS Mail.app, listing mailboxes and accounts, searching messages, reading message bodies and attachments, and sending new mail through the configured accounts. Use whenever the user asks about email, for example "any new mail from Anna", "find that invoice email from last week", or "reply to Marek's message". Use even when you think you know the answer, inbox state is dynamic, only the live API reflects current messages, unread counts, and folder organization. Do not use for web-based mail (Gmail/Outlook web), non-macOS systems, email protocol questions (IMAP/SMTP), or generic email-marketing/composition advice.
user-invocable: false
allowed-tools: mcp__speedwave-hub__search_tools mcp__speedwave-hub__execute_code
---

Mail access goes through the Speedwave MCP Hub. Claude does not see `mail__*` tools directly: use `search_tools` to discover them and `execute_code` with the injected `os` global to invoke. Tools are called as `await os.<methodName>({ … })`.

macOS Mail.app unifies all accounts configured in **System Settings, Internet Accounts**: iCloud, Gmail, Exchange, IMAP, and others are all accessible through the same `os.listMailboxes` / `os.listEmails` surface. No per-account credentials are needed; the mcp-os worker uses Automation permission (TCC), pre-validated on first enable.

## Workflow

1. `search_tools({ query: "mail", detail_level: "names_only", service: "os" })`: discover what is available.
2. `search_tools({ query: "os__<toolName>", detail_level: "full_schema", service: "os" })`: get the exact parameter schema.
3. `execute_code`: call the tool using the parameter names from the schema.

Always run steps 1–2 before guessing a tool name or parameter. The live schema is the source of truth.

## Pitfalls

- **`os.*`, not `mail.*`.** All four OS sub-services (mail, calendar, reminders, notes) share the same `os` global. There is no `mail` global.
- **Mailbox names are case-sensitive** and may be nested (e.g. `INBOX/Work/Clients`). Call `os.listMailboxes` first to get exact names; do not guess folder paths.
- **Listing returns metadata only.** `os.listEmails` returns subject, sender, date, and read-status, not the full body. Retrieve the body with a separate `os.getEmail({ id })` call. Be selective; fetching many bodies in a loop can be slow and token-heavy.
- **`confirm_send` is mandatory for writes.** Both `os.sendEmail` and `os.replyToEmail` require `confirm_send: true` in the payload: the parameter is a hard gate in the Swift CLI, not just a convention. Per the global write/delete confirmation rule in CLAUDE.md, always show the user a summary of subject, recipients, and body before calling these tools; never set `confirm_send: true` without explicit user approval.
- **Sending is irreversible.** Once `os.sendEmail` or `os.replyToEmail` returns `{ "status": "sent" }`, the message is in the MTA queue. There is no undo. Drafts (compose without send) are not exposed as a tool; if the user only wants to draft, explain this limitation.
- **Attachments are not returned inline.** The current tool surface does not decode MIME attachments; if attachment content is needed, note this limitation to the user.
- **Search and single-message lookup scope.** `os.searchEmails` only ever searches the Inbox (for both Apple Mail and Outlook), and its `mailbox` parameter has no effect. `os.getEmail` and `os.replyToEmail` are Inbox-only on Apple Mail (the default client) — a message id from `os.listEmails({ mailbox: "Archive" })` (or any non-Inbox mailbox) cannot be fetched or replied to by id. On Outlook (`client: "outlook"`), `os.getEmail` and `os.replyToEmail` can resolve an id from any mailbox in the account. For searches or lookups across all mailboxes on Apple Mail, list target mailboxes with `os.listMailboxes` first and iterate with `os.listEmails({ mailbox })`.
- **Microsoft Outlook.** Pass `client: "outlook"` on any mail tool to redirect calls to it when installed and running. The default is Apple Mail.

## When NOT to use

- Web-based mail accessed through a browser (no native Mail.app account configured).
- IMAP/SMTP server configuration questions: those belong in System Settings.
- Generic email-writing or marketing-copy advice: no tool call needed.
