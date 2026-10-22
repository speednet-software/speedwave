import Foundation
import SharedCLI

let junkNotFoundMarker = "SPW_JUNK_NOT_FOUND"
let alreadyInJunkMarker = "SPW_ALREADY_IN_JUNK"
let archiveNotFoundMarker = "SPW_ARCHIVE_NOT_FOUND"
let alreadyArchivedMarker = "SPW_ALREADY_ARCHIVED"
let mailboxExistsMarker = "SPW_MAILBOX_EXISTS"
let targetIsTrashMarker = "SPW_TARGET_IS_TRASH"
let targetIsJunkMarker = "SPW_TARGET_IS_JUNK"
let specialMailboxMarker = "SPW_SPECIAL_MAILBOX"

/// The flag colors in the order of Mail's `flag index` (0 is red); `none` takes the flag off.
let mailFlagColors = ["red", "orange", "yellow", "green", "blue", "purple", "gray"]

/// The mailbox paths `archive_emails` looks for, first match wins, inside the mail's own account.
let archiveMailboxNames = ["Archive", "[Gmail]/All Mail"]

/// The application properties of Mail's special mailboxes, which `rename_mailbox` refuses with the archive mailbox.
private let specialMailboxProperties = [
    "inbox", "drafts mailbox", "sent mailbox", "junk mailbox", "trash mailbox", "outbox",
]

/// The `mark_emails_read` command: sets or clears the read status of each mail.
func markEmailsRead(params: [String: Any], scripts: MailScripts) throws -> [String: Any] {
    let batch = try MailBatch(params: params)
    guard let read = params["read"] as? Bool else {
        throw MailError.missingField("read")
    }
    return try batch.apply(scripts: scripts, action: MailAction(lines: "            set read status of m to \(read)"))
}

/// The `flag_emails` command: flags each mail with a color of `mailFlagColors`, or takes the flag off with `none`.
func flagEmails(params: [String: Any], scripts: MailScripts) throws -> [String: Any] {
    let batch = try MailBatch(params: params)
    guard let flag = params["flag"] as? String else {
        throw MailError.missingField("flag")
    }
    let lines: String
    if flag == "none" {
        lines = "            set flagged status of m to false"
    } else if let index = mailFlagColors.firstIndex(of: flag) {
        lines = """
                    set flagged status of m to true
                    set flag index of m to \(index)
            """
    } else {
        throw MailError.invalidValue("flag", "must be one of \((mailFlagColors + ["none"]).joined(separator: ", "))")
    }
    return try batch.apply(scripts: scripts, action: MailAction(lines: lines))
}

/// The `move_emails` command: moves each mail to the mailbox `mailbox` of `account`.
func moveEmails(params: [String: Any], scripts: MailScripts) throws -> [String: Any] {
    let batch = try MailBatch(params: params)
    return try batch.apply(scripts: scripts, action: try targetAction(params, verb: "move"))
}

/// The `copy_emails` command: copies each mail to the mailbox `mailbox` of `account`, keeping the original.
func copyEmails(params: [String: Any], scripts: MailScripts) throws -> [String: Any] {
    let batch = try MailBatch(params: params)
    return try batch.apply(scripts: scripts, action: try targetAction(params, verb: "duplicate"))
}

/// The `archive_emails` command: moves each mail to the archive mailbox of its own account, never anywhere else.
func archiveEmails(params: [String: Any], scripts: MailScripts) throws -> [String: Any] {
    let batch = try MailBatch(params: params)
    return try batch.apply(scripts: scripts, action: MailAction(lines: archiveLookup(into: "spwArchive") + """

                if spwArchive is missing value then error "\(archiveNotFoundMarker)"
                if mb is spwArchive then error "\(alreadyArchivedMarker)"
                move m to spwArchive
        """))
}

/// The `mark_emails_spam` command: after confirmation marks each mail as junk, which trains Mail's filter, and moves
/// it to the Junk mailbox of its own account.
func markEmailsSpam(params: [String: Any], scripts: MailScripts) throws -> [String: Any] {
    try MailBatch.gated(
        params: params,
        scripts: scripts,
        gate: ConfirmationGate(
            param: "confirm_spam",
            tool: "markEmailsSpam",
            question: "Mark these emails as spam and move them to the Junk mailbox?"
        ),
        action: MailAction(lines: accountSpecialMailbox(
            "junk mailbox", into: "spwJunk", missing: junkNotFoundMarker, already: alreadyInJunkMarker
        ) + """

                    set junk mail status of m to true
                    move m to spwJunk
            """)
    )
}

/// The `mark_emails_not_spam` command: clears the junk status of each mail and moves one in its account's Junk to
/// that account's Inbox; each mail reports whether it moved.
func markEmailsNotSpam(params: [String: Any], scripts: MailScripts) throws -> [String: Any] {
    let batch = try MailBatch(params: params)
    return try batch.apply(scripts: scripts, action: MailAction(
        lines: """
                    set junk mail status of m to false
            """ + "\n" + accountSpecialLookup("junk mailbox", into: "spwJunk") + "\n"
            + accountSpecialLookup("inbox", into: "spwInbox") + """

                    if spwJunk is not missing value and spwInbox is not missing value then
                        if mb is spwJunk then
                            move m to spwInbox
                            set spwReported to true
                        end if
                    end if
            """,
        reports: "moved"
    ))
}

/// The `create_mailbox` command: makes the mailbox path `name` in `account`, On My Mac included; an existing one is
/// refused, never reused.
func createMailbox(params: [String: Any], scripts: MailScripts) throws -> [String: Any] {
    guard let name = params["name"] as? String else {
        throw MailError.missingField("name")
    }
    guard !name.isEmpty else {
        throw MailError.invalidValue("name", "must not be empty")
    }
    guard let account = params["account"] as? String else {
        throw MailError.missingField("account")
    }
    let make = "make new mailbox with properties {name:\"\(escapeAppleScript(name))\"}"
    let local = account == AppleMailClient.localAccountName
    let lines = [
        "tell application \"Mail\"",
        local ? nil : AppleMailClient.accountLookup(account, into: "spwAcct"),
        "        if exists \(mailboxIn(name, local: local)) then error \"\(mailboxExistsMarker)\"",
        local ? "        \(make)" : "        tell spwAcct to \(make)",
        "end tell",
    ]
    _ = try scripts.run(lines.compactMap { $0 }.joined(separator: "\n"), mailbox: name, account: account)
    return ["status": "created", "mailbox": name, "account": account]
}

/// The `rename_mailbox` command: renames the mailbox `mailbox` of `account` to `new_name` inside the same parent,
/// refusing a special or archive mailbox and a name the parent already has.
func renameMailbox(params: [String: Any], scripts: MailScripts) throws -> [String: Any] {
    let (mailbox, account) = try mailboxParams(params)
    guard let account = account else {
        throw MailError.missingField("account")
    }
    guard let newName = params["new_name"] as? String else {
        throw MailError.missingField("new_name")
    }
    guard !newName.isEmpty, !newName.contains("/") else {
        throw MailError.invalidValue("new_name", "must be one mailbox name, not empty and without /")
    }
    let parent = mailbox.split(separator: "/", omittingEmptySubsequences: false).dropLast().joined(separator: "/")
    let renamed = parent.isEmpty ? newName : "\(parent)/\(newName)"
    let taken = mailboxIn(renamed, local: account == AppleMailClient.localAccountName)
    let refuse = "        if mb is spwSpecial then error \"\(specialMailboxMarker)\""
    let checks = specialMailboxProperties.map { accountSpecialLookup($0, into: "spwSpecial") }
        + [archiveLookup(into: "spwSpecial")]
    let script = (
        ["tell application \"Mail\"", AppleMailClient.mailboxLookup(name: mailbox, account: account)]
            + checks.flatMap { [$0, refuse] }
            + [
                "        if exists \(taken) then error \"\(mailboxExistsMarker)\"",
                "        set name of mb to \"\(escapeAppleScript(newName))\"",
                "end tell",
            ]
    ).joined(separator: "\n")
    do {
        _ = try scripts.run(script, mailbox: mailbox, account: account)
    } catch MailFailure.mailboxExists {
        throw MailFailure.mailboxExists(mailbox: renamed, account: account)
    }
    return ["status": "renamed", "mailbox": renamed, "previous_mailbox": mailbox, "account": account]
}

/// The AppleScript specifier of the mailbox path `path` in the account `spwAcct`, app-level when `local`.
private func mailboxIn(_ path: String, local: Bool) -> String {
    "mailbox \"\(escapeAppleScript(path))\"" + (local ? "" : " of spwAcct")
}

/// AppleScript lines that set `variable` to the first of `archiveMailboxNames` in the account with Mail id
/// `spwAcctId` (app-level for On My Mac), else to `missing value`.
private func archiveLookup(into variable: String) -> String {
    let names = "{" + archiveMailboxNames.map { "\"\(escapeAppleScript($0))\"" }.joined(separator: ", ") + "}"
    return """
            set \(variable) to missing value
            repeat with spwNameRef in \(names)
                set spwName to contents of spwNameRef
                if \(variable) is missing value then
                    if spwAcctId is "" then
                        if exists mailbox spwName then set \(variable) to mailbox spwName
                    else
                        if exists mailbox spwName of account id spwAcctId then set \(variable) to mailbox spwName of account id spwAcctId
                    end if
                end if
            end repeat
    """
}

/// The action of `move_emails`/`copy_emails`: looks the target up once, `mailbox` inside `account`, refuses the
/// Trash and the Junk mailbox of that account and every mailbox inside them, which only the gated `delete_emails`
/// and `mark_emails_spam` reach, then runs `verb` (`move` or `duplicate`) on each mail.
private func targetAction(_ params: [String: Any], verb: String) throws -> MailAction {
    let (mailbox, account) = try mailboxParams(params)
    guard let account = account else {
        throw CLIError.missingField("account")
    }
    return MailAction(
        lines: "            \(verb) m to spwTarget",
        setup: AppleMailClient.mailboxLookup(name: mailbox, account: account) + "\n"
            + accountSpecialLookup("trash mailbox", into: "spwTargetTrash") + "\n"
            + accountSpecialLookup("junk mailbox", into: "spwTargetJunk") + """

                set spwUp to mb
                repeat 100 times
                    if spwUp is spwTargetTrash then error "\(targetIsTrashMarker)"
                    if spwUp is spwTargetJunk then error "\(targetIsJunkMarker)"
                    try
                        set spwUp to container of spwUp
                        if class of spwUp is not container and class of spwUp is not mailbox then exit repeat
                    on error
                        exit repeat
                    end try
                end repeat
                set spwTarget to mb
            """,
        mailbox: mailbox,
        account: account
    )
}
