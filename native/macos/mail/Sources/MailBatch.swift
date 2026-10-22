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

/// What a batch command does: `setup` once, then `lines` on every mail found (`m`, `mb`, `spwAcctName`); with
/// `reports`, the lines set the boolean `spwReported`, which each mail acted on carries under that key.
struct MailAction {
    let lines: String
    var setup = ""
    var mailbox: String?
    var account: String?
    var reports: String?
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
        var reported: (key: String, value: Bool)?

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
            if error == nil, let reported = reported {
                row[reported.key] = reported.value
            }
            return row
        }
    }

    static let fieldSeparator = "\u{1F}"
    static let rowSeparator = "\u{1E}"

    /// Seconds before the end of the script budget after which a batch tries no further mail, so the script still
    /// prints its per-mail report.
    static let stopHeadroomSeconds = 5

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
        action: MailAction
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

    /// A reversible command: runs `action` on every mail without confirmation and reports each one.
    func apply(scripts: MailScripts, action: MailAction) throws -> [String: Any] {
        Self.report(try run(scripts: scripts, action: action))
    }

    /// Looks up every mail in one script, each in its own `try`, and runs `action` on each one found; nil only reads
    /// the mails.
    func run(scripts: MailScripts, action: MailAction?) throws -> [Outcome] {
        let seconds = max(1, Int(scripts.timeout) - Self.stopHeadroomSeconds)
        let output = try scripts.run(
            script(action: action, seconds: seconds), mailbox: action?.mailbox, account: action?.account)
        let rows = output.isEmpty ? [] : output.components(separatedBy: Self.rowSeparator)
        guard rows.count == ids.count else {
            throw ScriptError.scriptFailed("Unexpected batch result from Mail.app")
        }
        return try zip(ids, rows).map { id, row in
            try outcome(id, row: row, reports: action?.reports, scripts: scripts)
        }
    }

    /// The batch script: each mailbox of the batch is looked up once and its Message-IDs and Mail message ids read in
    /// two requests, then each mail is found in those lists and addressed by its Mail id, which a move of another
    /// mail does not shift; a mail is not tried once the script's time is nearly up.
    private func script(action: MailAction?, seconds: Int) -> String {
        let reported = action?.reports == nil ? "" : ", spwReported"
        var groups: [MailId] = []
        for id in ids where !groups.contains(where: { $0.accountId == id.accountId && $0.mailbox == id.mailbox }) {
            groups.append(id)
        }
        let groupOf = { (id: MailId) in
            groups.firstIndex { $0.accountId == id.accountId && $0.mailbox == id.mailbox } ?? 0
        }
        let stores = groups.indices.map { group in
            """
            script spwGroup\(group)
                property spwGKeys : {}
                property spwGIds : {}
                property spwGBox : missing value
                property spwGName : ""
                property spwGAcct : ""
                property spwGError : ""
                property spwGNumber : 0
            end script
            """
        }.joined(separator: "\n")
        let loads = groups.enumerated().map { group, id in
            """
                try
            \(AppleMailClient.mailboxLookup(path: id.mailbox, accountId: id.accountId))
                    set spwGKeys of spwGroup\(group) to (message id of every message of mb)
                    set spwGIds of spwGroup\(group) to (id of every message of mb)
                    set spwGBox of spwGroup\(group) to mb
                    set spwGName of spwGroup\(group) to spwAcctName
                    set spwGAcct of spwGroup\(group) to spwAcctId
                on error spwErr number spwNum
                    set spwGError of spwGroup\(group) to spwErr
                    set spwGNumber of spwGroup\(group) to spwNum
                end try
            """
        }.joined(separator: "\n")
        let perMail = ids.map { id in
            let group = "spwGroup\(groupOf(id))"
            let key = escapeAppleScript(id.messageId)
            return """
                set spwSubject to ""
                set spwSender to ""
                set spwDate to missing value
                set spwReported to false
                try
                    if (current date) > spwDeadline then error "\(batchStoppedMarker)"
                    if spwGError of \(group) is not "" then error (spwGError of \(group)) number (spwGNumber of \(group))
                    set mb to spwGBox of \(group)
                    set spwAcctName to spwGName of \(group)
                    set spwAcctId to spwGAcct of \(group)
                    set spwMailId to my spwFind(\(group), "\(key)")
                    if spwMailId is 0 then error "\(mailNotFoundMarker)"
                    set m to «class mssg» id spwMailId of mb
                    if message id of m is not "\(key)" then
                        set spwFound to (every message of mb whose message id is "\(key)")
                        if (count of spwFound) is 0 then error "\(mailNotFoundMarker)"
                        set m to item 1 of spwFound
                    end if
                    set spwSubject to subject of m
                    set spwSender to sender of m
                    set spwDate to date received of m
            \(action?.lines ?? "")
                    set end of spwRows to {"ok", spwSubject, spwSender, spwDate, ""\(reported)}
                on error spwErr number spwNum
                    set end of spwRows to {"error", spwSubject, spwSender, spwDate, spwErr & " (" & spwNum & ")"\(reported)}
                end try
            """
        }.joined(separator: "\n")
        return """
        \(stores)
        set spwRows to {}
        set spwDeadline to (current date) + \(seconds)
        tell application "Mail"
        \(action?.setup ?? "")
        \(loads)
        \(perMail)
        end tell
        set spwLines to {}
        repeat with spwRowRef in spwRows
            set spwRow to contents of spwRowRef
            set spwIso to ""
            set spwReceived to contents of item 4 of spwRow
            if class of spwReceived is date then set spwIso to (spwReceived as «class isot» as string)
            set spwFields to {(contents of item 1 of spwRow) as text, my spwClean(contents of item 2 of spwRow), ¬
                my spwClean(contents of item 3 of spwRow), spwIso, my spwClean(contents of item 5 of spwRow)}
            if (count of spwRow) > 5 then set end of spwFields to (contents of item 6 of spwRow) as text
            set AppleScript's text item delimiters to (character id 31)
            set end of spwLines to (spwFields as text)
        end repeat
        set AppleScript's text item delimiters to (character id 30)
        return spwLines as text
        \(Self.findHandler)
        \(MailReading.cleanHandler)
        """
    }

    /// The AppleScript handler `spwFind(group, key)`: the Mail id of the message whose Message-ID is `key`, compared
    /// with case, in a group's lists, or 0; the lists are script object properties, read in time linear overall.
    static let findHandler = """
        on spwFind(spwGroup, spwKey)
            considering case
                repeat with spwI from 1 to count of spwGKeys of spwGroup
                    if item spwI of spwGKeys of spwGroup is spwKey then return item spwI of spwGIds of spwGroup
                end repeat
            end considering
            return 0
        end spwFind
        """

    private func outcome(_ id: MailId, row: String, reports: String?, scripts: MailScripts) throws -> Outcome {
        let fields = row.components(separatedBy: Self.fieldSeparator)
        guard fields.count == (reports == nil ? 5 : 6), ["ok", "error"].contains(fields[0]) else {
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
            error: error,
            reported: reports.map { ($0, fields[5] == "true") }
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
        let perMail: [(marker: String, failure: MailFailure)] = [
            (trashNotFoundMarker, .trashNotFound(account: id.account)),
            (alreadyInTrashMarker, .alreadyInTrash),
            (junkNotFoundMarker, .junkNotFound(account: id.account)),
            (alreadyInJunkMarker, .alreadyInJunk),
            (archiveNotFoundMarker, .archiveNotFound(account: id.account)),
            (alreadyArchivedMarker, .alreadyArchived),
            (batchStoppedMarker, .notAttempted),
        ]
        return perMail.first { detail.contains($0.marker) }?.failure.localizedDescription ?? detail
    }
}

let batchStoppedMarker = "SPW_BATCH_STOPPED"
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
        action: MailAction(lines: moveToTrashAction)
    )
}

/// AppleScript lines that move `m` to the Trash mailbox of the account `spwAcctName`; Mail's `delete` is never used,
/// because an account set not to move deleted messages to the Trash would erase the mail.
let moveToTrashAction = accountSpecialMailbox(
    "trash mailbox", into: "spwTrash", missing: trashNotFoundMarker, already: alreadyInTrashMarker
) + """

            move m to spwTrash
    """

/// AppleScript lines that set `variable` to the child of Mail's `special` mailbox (`trash mailbox`, `junk mailbox`)
/// that belongs to the account `spwAcctId`, else to `special` itself when it belongs to that account; none is
/// error `missing`, and `m` already in that very mailbox is error `already`.
func accountSpecialMailbox(_ special: String, into variable: String, missing: String, already: String) -> String {
    accountSpecialLookup(special, into: variable) + """

            if \(variable) is missing value then error "\(missing)"
            if mb is \(variable) then error "\(already)"
    """
}

/// AppleScript lines that set `variable` to the child of Mail's `special` mailbox whose account has the Mail id
/// `spwAcctId` ("" for On My Mac, whose mailboxes have no account), else to `special` itself when it belongs to that
/// account, else to `missing value`; ids, unlike names, tell apart two accounts with one name.
func accountSpecialLookup(_ special: String, into variable: String) -> String {
    """
            set \(variable) to missing value
            repeat with spwBoxRef in mailboxes of \(special)
                set spwBox to contents of spwBoxRef
                set spwOwner to ""
                try
                    set spwOwner to id of account of spwBox
                end try
                if spwOwner is spwAcctId then
                    set \(variable) to spwBox
                    exit repeat
                end if
            end repeat
            if \(variable) is missing value then
                try
                    if id of account of \(special) is spwAcctId then set \(variable) to \(special)
                end try
            end if
    """
}
