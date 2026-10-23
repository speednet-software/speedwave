# ADR-104: Apple Mail Control Through AppleScript

> **Status:** Accepted
> **Date:** 2026-10-22
> **Context:** Epic SPEED-829 gave Claude full control of the user's mail (read, search, organize, send, reply, forward, redirect, drafts) through the host-side `mcp-os` worker. Mail is personal, partly irreversible and a target for prompt injection, and Apple Mail's scripting has bugs that cost days to find. This ADR records the decisions the epic made and how Speedwave lives with the Mail bugs it found, so they are not rediscovered.

## Decision

### 1. Apple Mail is the only client, driven by AppleScript

`mail-cli` (`native/macos/mail/`) drives Mail.app with AppleScript, one `osascript` process per script (`MailShared.swift::osascriptExecutor`), under the Automation permission model of ADR-049 and ADR-070. Microsoft Outlook is not a client (SPEED-830): the new Outlook for Mac has no AppleScript support[^1], and the legacy Outlook path was dropped with it; `detect_clients` lists an installed Outlook as `supported: false` with instructions to add the account to Apple Mail. That the legacy Outlook no longer connects to Exchange Online is the reason recorded in SPEED-830; no public source for it was found, so it stands here as unverified.

Every script runs within the call's time budget (`mail-shared.ts::mailTimeBudget`), and `MailScripts.run` wraps every `tell application "Mail"` in `with timeout`, because an Apple event otherwise gives up after AppleScript's default of two minutes[^2].

### 2. Irreversible operations go through a confirmation gate

Send, reply, forward, redirect, delete and spam are gated (`MailBatch.swift::ConfirmationGate`): without the `confirm_*` flag set to `true` a call changes nothing and returns a preview with `status: "confirmation_required"`, and Claude asks the user before it calls again with the flag. A batch acts on at most 25 mails and reports per mail. The flag is set by Claude, so a prompt-injected call can skip the preview; the bounds below limit the damage. Reversible organizing (read, flag, move, copy, archive, mailbox create and rename, not-spam, drafts) has no gate in `mail-cli`, but the container's instructions still forbid any write without the user's yes, and every such tool description says so (`mail-shared.ts::ASK_USER_FIRST`).

### 3. Deleting only moves to the Trash

`delete_emails` moves each mail to the Trash of its own account with `move` and never calls Mail's `delete`, so an account set to erase deleted mail cannot lose it. No tool deletes permanently, deletes or empties a mailbox, and a move or copy into a Trash or Junk mailbox is refused (`MAIL_TARGET_IS_TRASH`, `MAIL_TARGET_IS_JUNK`).

### 4. Rules are read-only

`list_rules` reads Mail rules; no command creates, changes or deletes one, because a prompt-injected Claude could otherwise set up permanent forwarding. A rule-writing command needs a new ADR.

### 5. No attachments yet

The tools send plain text without attachments. The host-side worker cannot tell which project called it, so it cannot safely resolve a file path to attach; this is SPEED-842.

### 6. Scripted text is shown as a quote

Mail 16 shows any text a script sets on an outgoing message as a quote (`> ` lines in plain text, a cited block in HTML); Apple's report FB11734014 is open[^3]. Every object-model variant tried keeps the quote, Mail's `mailto` window cannot be sent or closed by a script, and pasting through System Events would need the Accessibility permission and take over the clipboard. `send_email`, `reply_to_email` and `save_draft` therefore keep the quote and tell Claude to warn the user (user decision 2026-10-21). Forward and redirect never set text, since any change to a forward's content leaves only the changed text[^4].

### 7. Mail leaks one compose thread per message, and Speedwave lives with it

On Mail 16 / macOS 27.0.1 (measured 2026-10-22 with `sample`), every outgoing message Mail creates, scripted (`make new outgoing message`, `reply`, `forward`) or opened by hand from the menu, leaves one `ComposeBackEnd_Scripting._workQueue` thread blocked in `-[EFFuture resultBeforeDate:]` until Mail quits. The thread blocks at creation, before anything is set, saved, closed or sent, and no script variant (waiting, order, properties, a long-lived process, JXA) avoids it; `redirect` and reads leak nothing. Measured per operation: a reply, forward or new message +1, a confirmed reply with a preview that made its own reply +2, a redirect 0, a read 0. Around 36 blocked threads Mail silently stops saving drafts; around 45 to 63 it answers no Apple event (-1712) and slows the Mac. This is an Apple bug with no public report found; the user files it through Feedback Assistant.

Speedwave does not fix Mail and does not route around it (no UI scripting, no `mailto`, no own SMTP). It spends the leak only where a message must exist:

- **Previews make no message** (SPEED-866). The reply and forward previews read the original only and work the recipients, subject and sender out in Swift (`MailSending.replyPreview`, `forwardPreview`): a reply goes to the Reply-To, else the sender, or for a mail the user sent to its To recipients; `reply_all` adds the original's other To and Cc recipients as Cc without the user's own addresses, as Mail's own reply-all does (observed 2026-10-22 on an Exchange mail); the subject gets `Re: ` or `Fwd: ` unless it already has it; the sender is the address of the mail's own account it was sent to. A new message's preview never made one. A redirect still reads Mail's own redirect, which leaks nothing.
- **A send is checked against its preview.** A confirmed reply or forward makes Mail's message and, before `send`, checks it against the preview (`MailSending.previewCheck`). A reply first gets the previewed subject and sender set (its content is set anyway), then its To and Cc are compared as sets and its sender address checked, which catches Mail ignoring a sender. A forward gets the previewed subject set and its sender address checked; a forward saved as a draft with and without a set subject had the same content and attachments (observed 2026-10-22), unlike a forward whose content is changed. Mail rewrites subjects on its own (a forward of `ODP: Intro` became `Fwd: Intro`), so the subject is set, not predicted. On any difference it closes the message unsent and fails with `MAIL_PREVIEW_CHANGED`, whose teaching asks Claude for a new preview and, when the same refusal repeats, to stop and offer the user a new email through `sendEmail` instead. The user's yes covers exactly what goes out, even if Mail's choice differs from the computed preview.
- **Claude asks for a restart instead of retrying.** Every `MAIL_TIMEOUT` teaching says that after a second mail timeout in one conversation Mail may have stopped answering, so Claude stops calling mail tools and asks the user to quit and reopen Mail.app (`mail-shared.ts::STUCK_MAIL_STEP`). The mail skill describes the bug and tells Claude to warn before creating many messages and to offer smaller batches or a restart between them.
- **No counter, no hard limit.** `mail-cli` does not count compose operations or cap them (user decision 2026-10-22): Mail leaks the same way when the user writes mail by hand, so a count would be falsely exact and a cap would block work the user could still do.

The 2026-10-21 hang first blamed on `visible:false` (SPEED-854) was this leak; the rule against `visible:false` stays, since such a message also survives `close ... saving no`.

## Consequences

- A reply or forward preview can be repeated freely without wearing Mail down; each confirmed send or saved draft still costs one thread until Mail restarts.
- A reply whose recipients Mail picks differently from the computed preview (an unusual Reply-To), or a forward from another alias, is refused with `MAIL_PREVIEW_CHANGED` rather than sent. When Mail differs in a predictable way, every new preview predicts the same thing, so that reply cannot be sent through `replyToEmail` at all and the user is offered a new email instead; never an unseen recipient. Whether Mail's reply-all splits To and Cc as computed is checked live by `LiveMailTests.testReplyAndForwardPreviewsShowWhatMailsOwnReplyAndForwardCarry`.
- When Mail stops answering, the user restarts it; nothing in Speedwave can.

## Alternatives rejected

- **UI scripting, `mailto` or a Speedwave SMTP client** to avoid Mail's compose path: UI scripting needs the Accessibility permission for the host worker, `mailto` opens a window a script cannot send or close, and SMTP would put mail credentials in Speedwave.
- **Reading Mail's own reply in the preview and closing it**, as before SPEED-866: exact, but it spends a thread on every preview, so a few previews and a send could reach the limit.
- **An operation counter with a hard limit in `mail-cli`**: see above.

## References

[^1]: C-Command forum, EagleFiler and the new Outlook for Mac: "“New” Outlook does not currently support AppleScript" — https://forum.c-command.com/t/eagle-filer-microsoft-outlook-for-mac-version-16-42-fn-f1-does-not-work-with-new-outlook-u1/13237

[^2]: AppleScript Language Guide, control statements (`with timeout`): "By default, when an application fails to respond to a command, AppleScript waits for two minutes" — https://developer.apple.com/library/archive/documentation/AppleScript/Conceptual/AppleScriptLangGuide/reference/ASLR_control_statements.html

[^3]: Apple Developer Forums, Mail 16 sends scripted content as a citation, report FB11734014 — https://developer.apple.com/forums/thread/738842

[^4]: MacScripter, forwarding mail in Mail.app and adding content deletes the existing message body — https://www.macscripter.net/t/forward-mail-in-mail-app-and-adding-attachment-deletes-existing-message-body/77022
