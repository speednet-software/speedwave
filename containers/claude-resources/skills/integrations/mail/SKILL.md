---
name: mail
description: Use the OS mail integration to query the user's native macOS Mail.app, listing mailboxes and accounts, searching messages, reading message bodies and attachments, and sending new mail through the configured accounts. Use whenever the user asks about email, for example "any new mail from Anna", "find that invoice email from last week", or "reply to Marek's message". Use even when you think you know the answer, inbox state is dynamic, only the live API reflects current messages, unread counts, and folder organization. Do not use for web-based mail (Gmail/Outlook web), non-macOS systems, email protocol questions (IMAP/SMTP), or generic email-marketing/composition advice.
user-invocable: false
allowed-tools: mcp__speedwave-hub__search_tools mcp__speedwave-hub__execute_code
---

# Mail

Mail access goes through the Speedwave MCP Hub. Claude does not see `mail__*` tools directly: use `search_tools` to discover them and `execute_code` with the injected `os` global to invoke. Tools are called as `await os.<methodName>({ … })`.

macOS Mail.app unifies all accounts configured in **System Settings, Internet Accounts**: iCloud, Gmail, Exchange, IMAP, and others are all accessible through the same `os.listMailboxes` / `os.listEmails` surface. No per-account credentials are needed; the mcp-os worker uses Automation permission (TCC), pre-validated on first enable.

## Workflow

1. `search_tools({ query: "mail", detail_level: "names_only", service: "os" })`: discover what is available.
2. `search_tools({ query: "os__<toolName>", detail_level: "full_schema", service: "os" })`: get the exact parameter schema.
3. `execute_code`: call the tool using the parameter names from the schema.

Always run steps 1–2 before guessing a tool name or parameter. The live schema is the source of truth.

## Pitfalls

- **`os.*`, not `mail.*`.** All four OS sub-services (mail, calendar, reminders, notes) share the same `os` global. There is no `mail` global.
- **Mailbox names are case-sensitive paths inside an account** (e.g. `Inbox/Clients` for a nested mailbox). Call `os.listMailboxes` first and pass its `name` as `mailbox`; do not guess folder paths. When the same name exists in several accounts (e.g. `Drafts`), also pass that mailbox's `account`, or the call is refused as ambiguous.
- **Listing returns metadata only.** `os.listEmails` returns subject, sender, date, and read-status, not the full body. Retrieve the body with a separate `os.getEmail({ id })` call. Be selective; fetching many bodies in a loop can be slow and token-heavy.
- **`confirm_send` is mandatory for writes.** Both `os.sendEmail` and `os.replyToEmail` require `confirm_send: true` in the payload: the parameter is a hard gate in the Swift CLI, not just a convention. Per the global write/delete confirmation rule in CLAUDE.md, always show the user a summary of subject, recipients, and body before calling these tools; never set `confirm_send: true` without explicit user approval.
- **Sending is irreversible.** Once `os.sendEmail` or `os.replyToEmail` returns `{ "status": "sent" }`, the message is in the MTA queue. There is no undo. Drafts (compose without send) are not exposed as a tool; if the user only wants to draft, explain this limitation.
- **Attachments are not returned inline.** The current tool surface does not decode MIME attachments; if attachment content is needed, note this limitation to the user.
- **Search and single-message lookup scope.** `os.searchEmails` searches the mailbox named by `mailbox`, or the Inbox when it is omitted. `os.getEmail` and `os.replyToEmail` are Inbox-only: a message id from `os.listEmails({ mailbox: "Archive" })` (or any non-Inbox mailbox) cannot be fetched or replied to by id. For searches across all mailboxes, list target mailboxes with `os.listMailboxes` first and call `os.searchEmails({ query, mailbox })` for each.
- **A failed call says what to fix.** The error code names the cause: `MAIL_TIMEOUT` (Mail.app did not answer in time: retry once with a specific `mailbox` or a smaller `limit`, and check the Sent mailbox before retrying a send or reply), `MAIL_AUTOMATION_DENIED` (ask the user to allow Speedwave to control Mail in System Settings, Privacy & Security, Automation), `MAIL_MAILBOX_NOT_FOUND`, `MAIL_ACCOUNT_NOT_FOUND` and `MAIL_MAILBOX_AMBIGUOUS` (take the `name` and `account` from `os.listMailboxes`). Follow the error's instruction instead of retrying the same call.
- **Rules are read-only.** `os.listMailRules()` returns each rule's name, `enabled`, `match_all`, `conditions` and `actions` (move/copy target, forward or redirect address, reply text): use it to explain why mail lands where it does. No tool creates, changes or deletes a rule, by design (a malicious mail must not be able to set up permanent forwarding); if the user wants a rule changed, tell them to do it in Mail > Settings > Rules.
- **`os.checkMail()` only starts a fetch.** It asks Mail.app to fetch new mail for every account, or for one with `{ account }` (the `account` from `os.listMailboxes`), and returns at once with `status: "started"`; list or search again after a few seconds to see what arrived.
- **Apple Mail is the only client.** The mail tools drive Apple Mail and take no `client` parameter; passing one is rejected. Microsoft Outlook is not supported (New Outlook has no AppleScript, Legacy Outlook no longer connects to Exchange Online): when `os.detectMailClients` lists it with `supported: false`, relay its `instructions` to the user, which explain how to add the account to Apple Mail.

## When NOT to use

- Web-based mail accessed through a browser (no native Mail.app account configured).
- IMAP/SMTP server configuration questions: those belong in System Settings.
- Generic email-writing or marketing-copy advice: no tool call needed.
