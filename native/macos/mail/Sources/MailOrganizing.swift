import Foundation
import SharedCLI

let junkNotFoundMarker = "SPW_JUNK_NOT_FOUND"
let alreadyInJunkMarker = "SPW_ALREADY_IN_JUNK"
let archiveNotFoundMarker = "SPW_ARCHIVE_NOT_FOUND"
let alreadyArchivedMarker = "SPW_ALREADY_ARCHIVED"
let mailboxExistsMarker = "SPW_MAILBOX_EXISTS"
let targetIsTrashMarker = "SPW_TARGET_IS_TRASH"
let targetIsJunkMarker = "SPW_TARGET_IS_JUNK"

/// The flag colors in the order of Mail's `flag index` (0 is red); `none` takes the flag off.
let mailFlagColors = ["red", "orange", "yellow", "green", "blue", "purple", "gray"]

/// The mailbox paths `archive_emails` looks for, first match wins, inside the mail's own account.
let archiveMailboxNames = ["Archive", "[Gmail]/All Mail"]

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
    let names = "{" + archiveMailboxNames.map { "\"\(escapeAppleScript($0))\"" }.joined(separator: ", ") + "}"
    let local = escapeAppleScript(AppleMailClient.localAccountName)
    return try batch.apply(scripts: scripts, action: MailAction(lines: """
                set spwArchive to missing value
                repeat with spwNameRef in \(names)
                    set spwName to contents of spwNameRef
                    if spwArchive is missing value then
                        if spwAcctName is "\(local)" then
                            if exists mailbox spwName then set spwArchive to mailbox spwName
                        else
                            if exists mailbox spwName of account spwAcctName then set spwArchive to mailbox spwName of account spwAcctName
                        end if
                    end if
                end repeat
                if spwArchive is missing value then error "\(archiveNotFoundMarker)"
                if name of mb is name of spwArchive then error "\(alreadyArchivedMarker)"
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
    let nameEsc = escapeAppleScript(name)
    let make = "make new mailbox with properties {name:\"\(nameEsc)\"}"
    let body: String
    if account == AppleMailClient.localAccountName {
        body = """
                if exists mailbox "\(nameEsc)" then error "\(mailboxExistsMarker)"
                \(make)
            """
    } else {
        let accountEsc = escapeAppleScript(account)
        body = """
                if not (exists account "\(accountEsc)") then error "\(accountNotFoundMarker)"
                if exists mailbox "\(nameEsc)" of account "\(accountEsc)" then error "\(mailboxExistsMarker)"
                tell account "\(accountEsc)" to \(make)
            """
    }
    _ = try scripts.run("tell application \"Mail\"\n\(body)\nend tell", mailbox: name, account: account)
    return ["status": "created", "mailbox": name, "account": account]
}

/// The action of `move_emails`/`copy_emails`: looks the target up once, `mailbox` inside `account`, refuses the
/// Trash and the Junk mailbox of that account, which only the gated `delete_emails` and `mark_emails_spam` reach,
/// then runs `verb` (`move` or `duplicate`) on each mail.
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

                if mb is spwTargetTrash then error "\(targetIsTrashMarker)"
                if mb is spwTargetJunk then error "\(targetIsJunkMarker)"
                set spwTarget to mb
            """,
        mailbox: mailbox,
        account: account
    )
}
