import Foundation
import SharedCLI

/// The most mails one batch command acts on; a longer list is split into separately confirmed calls.
let mailBatchLimit = 25

/// The confirmation gate of a command that deletes, sends or reports mail: without `param: true` the command changes
/// nothing and answers with a preview and the instruction to ask the user first.
struct ConfirmationGate {
    let param: String
    let tool: String
    let question: String

    func isConfirmed(_ params: [String: Any]) -> Bool {
        params[param] as? Bool == true
    }

    /// The unconfirmed answer: `fields` describe what would happen, the gate adds its status and instruction.
    func preview(_ fields: [String: Any]) -> [String: Any] {
        fields.merging([
            "status": "confirmation_required",
            "confirm_param": param,
            "instruction": instruction,
        ]) { _, gate in gate }
    }

    private var instruction: String {
        "Nothing was changed. Show this preview to the user and ask the user: \(question) "
            + "Only after the user agrees, call \(tool) again with the same arguments and \(param): true. "
            + "If the user declines or does not answer, do not call it again."
    }
}

/// The mails of one batch command: 1 to `mailBatchLimit` distinct mail ids, all decoded before any script runs.
struct MailBatch {
    /// What became of one mail of the batch: found (preview) or acted on, or the reason it was not.
    struct Outcome {
        let id: MailId
        let subject: String
        let sender: String
        let received: Date?
        let error: String?

        var json: [String: Any] {
            var row: [String: Any] = [
                "id": id.encoded,
                "ok": error == nil,
                "mailbox": id.mailbox,
                "account": id.account,
            ]
            if error == nil || !subject.isEmpty || !sender.isEmpty {
                row["subject"] = subject
                row["sender"] = sender
            }
            row["date"] = received.map { iso8601String(from: $0, timeZone: .current) }
            row["error"] = error
            return row
        }
    }

    static let fieldSeparator = "\u{1F}"
    static let rowSeparator = "\u{1E}"

    let ids: [MailId]

    init(params: [String: Any]) throws {
        guard let raw = params["ids"] as? [String] else {
            throw CLIError.missingField("ids")
        }
        guard !raw.isEmpty else {
            throw MailError.invalidValue("ids", "pass at least one mail id")
        }
        guard raw.count <= mailBatchLimit else {
            throw MailFailure.batchTooLarge(count: raw.count, limit: mailBatchLimit)
        }
        var seen = Set<String>()
        ids = try raw.filter { seen.insert($0).inserted }.map(MailId.init(decoding:))
    }

    /// The unconfirmed answer previews every mail; the confirmed one runs `action` on each and reports every mail.
    static func gated(
        params: [String: Any],
        scripts: MailScripts,
        gate: ConfirmationGate,
        action: String
    ) throws -> [String: Any] {
        let batch = try MailBatch(params: params)
        guard gate.isConfirmed(params) else {
            return gate.preview(["emails": try batch.run(scripts: scripts, action: nil).map(\.json)])
        }
        return report(try batch.run(scripts: scripts, action: action))
    }

    /// The per-mail report: `completed` when every mail succeeded, `failed` when none did, `partial` otherwise.
    static func report(_ outcomes: [Outcome]) -> [String: Any] {
        let failed = outcomes.filter { $0.error != nil }.count
        let status = failed == 0 ? "completed" : failed == outcomes.count ? "failed" : "partial"
        return [
            "status": status,
            "emails": outcomes.map(\.json),
            "succeeded": outcomes.count - failed,
            "failed": failed,
        ]
    }

    /// Looks up every mail in one script, each in its own `try`, and runs `action` (AppleScript lines using `m`, `mb`
    /// and `spwAcctName`) on each one found; nil only reads the mails.
    func run(scripts: MailScripts, action: String?) throws -> [Outcome] {
        let output = try scripts.run(script(action: action))
        let rows = output.isEmpty ? [] : output.components(separatedBy: Self.rowSeparator)
        guard rows.count == ids.count else {
            throw ScriptError.scriptFailed("Unexpected batch result from Mail.app")
        }
        return try zip(ids, rows).map { id, row in try outcome(id, row: row, scripts: scripts) }
    }

    private func script(action: String?) -> String {
        let perMail = ids.map { id in
            """
                set spwSubject to ""
                set spwSender to ""
                set spwDate to missing value
                try
            \(AppleMailClient.messageLookup(id))
                    set spwSubject to subject of m
                    set spwSender to sender of m
                    set spwDate to date received of m
            \(action ?? "")
                    set end of spwRows to {"ok", spwSubject, spwSender, spwDate, ""}
                on error spwErr number spwNum
                    set end of spwRows to {"error", spwSubject, spwSender, spwDate, spwErr & " (" & spwNum & ")"}
                end try
            """
        }.joined(separator: "\n")
        return """
        set spwRows to {}
        tell application "Mail"
        \(perMail)
        end tell
        set spwLines to {}
        repeat with spwRowRef in spwRows
            set spwRow to contents of spwRowRef
            set spwIso to ""
            if class of (item 4 of spwRow) is date then set spwIso to ((item 4 of spwRow) as «class isot» as string)
            set AppleScript's text item delimiters to (character id 31)
            set end of spwLines to ({item 1 of spwRow, item 2 of spwRow, item 3 of spwRow, spwIso, item 5 of spwRow} as text)
        end repeat
        set AppleScript's text item delimiters to (character id 30)
        return spwLines as text
        """
    }

    private func outcome(_ id: MailId, row: String, scripts: MailScripts) throws -> Outcome {
        let fields = row.components(separatedBy: Self.fieldSeparator)
        guard fields.count == 5, ["ok", "error"].contains(fields[0]) else {
            throw ScriptError.scriptFailed("Unexpected batch result from Mail.app")
        }
        var error: String?
        if fields[0] == "error" {
            error = try Self.reason(fields[4], id: id, scripts: scripts)
        }
        return Outcome(
            id: id,
            subject: fields[1],
            sender: fields[2],
            received: AppleMailClient.localDate(fields[3]),
            error: error
        )
    }

    /// Why one mail failed; a denied Automation permission fails the whole call, since no mail can be reached.
    private static func reason(_ detail: String, id: MailId, scripts: MailScripts) throws -> String {
        if let failure = MailScripts.failure(
            detail, mailbox: id.mailbox, account: id.account, timeout: scripts.timeout
        ) {
            if case .automationDenied = failure { throw failure }
            return failure.localizedDescription
        }
        if detail.contains(trashNotFoundMarker) {
            return MailFailure.trashNotFound(account: id.account).localizedDescription
        }
        if detail.contains(alreadyInTrashMarker) {
            return MailFailure.alreadyInTrash.localizedDescription
        }
        return detail
    }
}

let trashNotFoundMarker = "SPW_TRASH_NOT_FOUND"
let alreadyInTrashMarker = "SPW_ALREADY_IN_TRASH"

/// The `delete_emails` command: moves each mail to the Trash of its own account, never deletes one permanently.
func deleteEmails(params: [String: Any], scripts: MailScripts) throws -> [String: Any] {
    try MailBatch.gated(
        params: params,
        scripts: scripts,
        gate: ConfirmationGate(
            param: "confirm_delete",
            tool: "deleteEmails",
            question: "Move these emails to the Trash?"
        ),
        action: moveToTrashAction
    )
}

/// AppleScript lines that move `m` to the Trash mailbox of the account `spwAcctName`; Mail's `delete` is never used,
/// because an account set not to move deleted messages to the Trash would erase the mail.
let moveToTrashAction = """
            set spwTrash to missing value
            repeat with spwBoxRef in mailboxes of trash mailbox
                set spwBox to contents of spwBoxRef
                set spwOwner to "\(escapeAppleScript(AppleMailClient.localAccountName))"
                try
                    set spwOwner to name of account of spwBox
                end try
                if spwOwner is spwAcctName then set spwTrash to spwBox
            end repeat
            if spwTrash is missing value then
                try
                    if name of account of trash mailbox is spwAcctName then set spwTrash to trash mailbox
                end try
            end if
            if spwTrash is missing value then error "\(trashNotFoundMarker)"
            if name of mb is name of spwTrash then error "\(alreadyInTrashMarker)"
            move m to spwTrash
    """
