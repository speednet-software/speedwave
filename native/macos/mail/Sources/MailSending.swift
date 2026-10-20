import Foundation
import SharedCLI

let sendFailedMarker = "SPW_SEND_FAILED"

/// Sends plain-text mail through Mail.app behind the `confirm_send` gate: unconfirmed, a command previews the
/// recipients, subject and full text that would go out; confirmed, it sends exactly that and reports it.
enum MailSending {
    static let sendGate = ConfirmationGate(param: "confirm_send", tool: "sendEmail", question: "Send this email?")
    static let replyGate = ConfirmationGate(param: "confirm_send", tool: "replyToEmail", question: "Send this reply?")

    private static let fieldSeparator = "\u{1D}"
    private static let itemSeparator = "\u{1E}"
    private static let replyReadFieldCount = 6

    private static let quoteDateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.dateFormat = "d MMM yyyy 'at' HH:mm"
        return formatter
    }()

    /// The `send_email` command: a new message to `to`, `cc` and `bcc`.
    static func sendEmail(params: [String: Any], scripts: MailScripts) throws -> [String: Any] {
        let signature = try signatureParam(params)
        let fields = try newMessageFields(params, draft: false, signature: signature)
        guard sendGate.isConfirmed(params) else {
            if let signature {
                _ = try run(signatureCheckScript(signature), scripts: scripts, signature: signature)
            }
            return sendGate.preview(fields)
        }
        _ = try run(
            newMessageScript(fields, signature: signature, account: nil, finish: sendLine("spwMsg")),
            scripts: scripts,
            signature: signature)
        return sent(fields)
    }

    /// The `save_draft` command: a new message saved, not sent, in the Drafts of `account` (Mail's default account
    /// when omitted), without a confirmation gate.
    static func saveDraft(params: [String: Any], scripts: MailScripts) throws -> [String: Any] {
        let signature = try signatureParam(params)
        let account = try accountParam(params)
        var fields = try newMessageFields(params, draft: true, signature: signature)
        fields["account"] = account
        _ = try run(
            newMessageScript(fields, signature: signature, account: account, finish: draftLines),
            scripts: scripts,
            signature: signature,
            account: account)
        return fields.merging(["status": "saved"]) { _, status in status }
    }

    /// The `list_signatures` command: the names of the user's Mail signatures.
    static func listSignatures(scripts: MailScripts) throws -> [String: Any] {
        let output = try scripts.run(listSignaturesScript)
        return ["signatures": output.components(separatedBy: itemSeparator).filter { !$0.isEmpty }]
    }

    /// The `reply_to_email` command: Mail's own reply to the mail `id`, in any mailbox, the user's text above the
    /// quoted original.
    static func replyToEmail(params: [String: Any], scripts: MailScripts) throws -> [String: Any] {
        guard let id = params["id"] as? String else {
            throw MailError.missingField("id")
        }
        guard let body = params["body"] as? String else {
            throw MailError.missingField("body")
        }
        let signature = try signatureParam(params)
        let mailId = try MailId(decoding: id)
        let replyAll = params["reply_all"] as? Bool ?? false
        let read = try run(
            replyReadScript(mailId, replyAll: replyAll, signature: signature),
            scripts: scripts,
            signature: signature,
            mailbox: mailId.mailbox,
            account: mailId.account)
        var fields = try replyFields(read, body: body)
        fields["signature"] = signature
        guard replyGate.isConfirmed(params) else {
            return replyGate.preview(fields)
        }
        _ = try run(
            replySendScript(mailId, replyAll: replyAll, text: fields["body"] as? String ?? "", signature: signature),
            scripts: scripts,
            signature: signature,
            mailbox: mailId.mailbox,
            account: mailId.account)
        return sent(fields)
    }

    /// The text of a reply: `body`, a blank line, the attribution line, and every line of `original` quoted with `>`.
    static func replyText(body: String, sender: String, received: Date?, original: String) -> String {
        quoteDateFormatter.timeZone = .current
        let attribution = received.map { "On \(quoteDateFormatter.string(from: $0)), \(sender) wrote:" }
            ?? "\(sender) wrote:"
        let head = plainText(body).trimmingCharacters(in: .whitespacesAndNewlines) + "\n\n" + attribution + "\n"
        let original = plainText(original).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !original.isEmpty else { return head }
        let quoted = original.components(separatedBy: "\n").map { $0.isEmpty ? ">" : "> \($0)" }
        return head + "\n" + quoted.joined(separator: "\n") + "\n"
    }

    /// One `make new <kind> recipient...` AppleScript line per comma-separated address.
    static func recipientClauses(_ addresses: [String], kind: String) -> String {
        addresses
            .map { addr in
                "        make new \(kind) recipient at end of \(kind) recipients "
                    + "with properties {address:\"\(escapeAppleScript(addr))\"}"
            }
            .joined(separator: "\n")
    }

    /// An AppleScript string literal body for multi-line text: line breaks become `\n`, tabs `\t`, other control
    /// characters are dropped and quotes and backslashes escaped.
    static func appleScriptText(_ text: String) -> String {
        plainText(text)
            .components(separatedBy: "\n")
            .map { line in line.components(separatedBy: "\t").map(escapeAppleScript).joined(separator: "\\t") }
            .joined(separator: "\\n")
    }

    private static let draftLines = """
            save spwMsg
            try
                close spwMsg saving yes
            end try
        """

    private static let listSignaturesScript = """
        \(MailReading.cleanHandler)

        tell application "Mail"
            set spwNames to {}
            repeat with spwSignature in signatures
                set end of spwNames to my spwClean(name of spwSignature)
            end repeat
        end tell
        set AppleScript's text item delimiters to (character id 30)
        return spwNames as text
        """

    private static func newMessageFields(
        _ params: [String: Any],
        draft: Bool,
        signature: String?
    ) throws -> [String: Any] {
        let to = try recipients(params, "to", required: !draft)
        guard let subject = params["subject"] as? String else {
            throw MailError.missingField("subject")
        }
        guard let body = params["body"] as? String ?? (draft ? "" : nil) else {
            throw MailError.missingField("body")
        }
        var fields: [String: Any] = [
            "to": to,
            "cc": try recipients(params, "cc", required: false),
            "bcc": try recipients(params, "bcc", required: false),
            "subject": singleLine(subject),
            "body": plainText(body),
        ]
        fields["signature"] = signature
        return fields
    }

    private static func signatureParam(_ params: [String: Any]) throws -> String? {
        try nameParam(params, "signature", rule: "must be a signature name from listMailSignatures")
    }

    private static func accountParam(_ params: [String: Any]) throws -> String? {
        try nameParam(params, "account", rule: "must be an account name from listMailboxes")
    }

    private static func nameParam(_ params: [String: Any], _ field: String, rule: String) throws -> String? {
        guard let raw = params[field] else { return nil }
        guard let name = raw as? String, !name.trimmingCharacters(in: .whitespaces).isEmpty else {
            throw MailError.invalidValue(field, rule)
        }
        return name
    }

    private static func run(
        _ script: String,
        scripts: MailScripts,
        signature: String?,
        mailbox: String? = nil,
        account: String? = nil
    ) throws -> String {
        do {
            return try scripts.run(script, mailbox: mailbox, account: account)
        } catch ScriptError.scriptFailed(let detail) where detail.contains(signatureNotFoundMarker) {
            throw MailFailure.signatureNotFound(signature ?? "")
        }
    }

    private static func signatureCheck(_ signature: String?) -> String? {
        signature.map {
            "    if not (exists signature \"\(escapeAppleScript($0))\") then error \"\(signatureNotFoundMarker)\""
        }
    }

    private static func signatureApply(_ signature: String?, to message: String) -> String? {
        signature.map { "    set message signature of \(message) to signature \"\(escapeAppleScript($0))\"" }
    }

    private static func signatureCheckScript(_ signature: String) -> String {
        ["tell application \"Mail\"", signatureCheck(signature), "end tell"].compactMap { $0 }.joined(separator: "\n")
    }

    private static func sendLine(_ message: String) -> String {
        "    if not (send \(message)) then error \"\(sendFailedMarker)\""
    }

    private static func newMessageScript(
        _ fields: [String: Any],
        signature: String?,
        account: String?,
        finish: String
    ) -> String {
        let clauses = ["to", "cc", "bcc"]
            .map { recipientClauses(fields[$0] as? [String] ?? [], kind: $0) }
            .filter { !$0.isEmpty }
            .joined(separator: "\n")
        let subject = escapeAppleScript(fields["subject"] as? String ?? "")
        let content = appleScriptText(fields["body"] as? String ?? "")
        let accountLines = account.map { name in
            """
                if not (exists account "\(escapeAppleScript(name))") then error "\(accountNotFoundMarker)"
                set spwAccount to account "\(escapeAppleScript(name))"
                set spwSender to (full name of spwAccount) & " <" & (item 1 of email addresses of spwAccount) & ">"
            """
        }
        let lines: [String?] = [
            "tell application \"Mail\"",
            signatureCheck(signature),
            accountLines,
            "    set spwMsg to make new outgoing message with properties "
                + "{subject:\"\(subject)\", content:\"\(content)\", visible:true}",
            account.map { _ in "    set sender of spwMsg to spwSender" },
            clauses.isEmpty ? nil : "    tell spwMsg\n\(clauses)\n    end tell",
            signatureApply(signature, to: "spwMsg"),
            finish,
            "end tell",
        ]
        return lines.compactMap { $0 }.joined(separator: "\n")
    }

    private static func plainText(_ text: String) -> String {
        let lines = text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
        return lines.components(separatedBy: "\n")
            .map { line in line.components(separatedBy: "\t").map(singleLine).joined(separator: "\t") }
            .joined(separator: "\n")
    }

    private static func singleLine(_ text: String) -> String {
        String(String.UnicodeScalarView(text.unicodeScalars.filter { scalar in
            let v = scalar.value
            return v > 0x1F && v != 0x7F && v != 0x85 && v != 0x2028 && v != 0x2029
        }))
    }

    private static func recipients(_ params: [String: Any], _ field: String, required: Bool) throws -> [String] {
        guard let raw = params[field] as? String else {
            if required { throw MailError.missingField(field) }
            return []
        }
        let addresses = splitAddressList(raw)
        guard !addresses.isEmpty else {
            throw MailError.emptyRecipients(field)
        }
        return addresses
    }

    private static func sent(_ fields: [String: Any]) -> [String: Any] {
        fields.merging(["status": "sent"]) { _, status in status }
    }

    private static func replyCommand(_ replyAll: Bool) -> String {
        "set spwReply to reply m opening window false reply to all \(replyAll)"
    }

    /// Creates Mail's reply to read its recipients and subject, closes it unsaved, and reads the original's sender,
    /// date and text; fields joined by GS, list items by RS, free text stripped of both.
    private static func replyReadScript(_ id: MailId, replyAll: Bool, signature: String?) -> String {
        """
        \(MailReading.cleanHandler)

        tell application "Mail"
        \(signatureCheck(signature) ?? "")
        \(AppleMailClient.messageLookup(id))
            \(replyCommand(replyAll))
            set spwTo to {}
            repeat with spwRecipient in to recipients of spwReply
                set end of spwTo to my spwClean(address of spwRecipient)
            end repeat
            set spwCc to {}
            repeat with spwRecipient in cc recipients of spwReply
                set end of spwCc to my spwClean(address of spwRecipient)
            end repeat
            set spwSubject to my spwClean(subject of spwReply)
            try
                close spwReply saving no
            end try
            set spwSender to my spwClean(sender of m)
            set spwDate to date received of m
            set spwOriginal to my spwClean(content of m)
        end tell
        set spwIsoDate to ""
        if class of spwDate is date then set spwIsoDate to (spwDate as «class isot» as string)
        set AppleScript's text item delimiters to (character id 30)
        set spwFields to {spwSubject, spwTo as text, spwCc as text, spwSender, spwIsoDate, spwOriginal}
        set AppleScript's text item delimiters to (character id 29)
        return spwFields as text
        """
    }

    private static func replyFields(_ output: String, body: String) throws -> [String: Any] {
        let fields = output.components(separatedBy: fieldSeparator)
        guard fields.count == replyReadFieldCount else {
            throw ScriptError.scriptFailed("Unexpected reply from Mail.app")
        }
        let items = { (field: String) in field.components(separatedBy: itemSeparator).filter { !$0.isEmpty } }
        return [
            "to": items(fields[1]),
            "cc": items(fields[2]),
            "subject": fields[0],
            "body": replyText(
                body: body, sender: fields[3], received: AppleMailClient.localDate(fields[4]), original: fields[5]),
        ]
    }

    private static func replySendScript(_ id: MailId, replyAll: Bool, text: String, signature: String?) -> String {
        """
        tell application "Mail"
        \(signatureCheck(signature) ?? "")
        \(AppleMailClient.messageLookup(id))
            \(replyCommand(replyAll))
            set content of spwReply to "\(appleScriptText(text))"
        \(signatureApply(signature, to: "spwReply") ?? "")
            if not (send spwReply) then error "\(sendFailedMarker)"
        end tell
        """
    }
}
