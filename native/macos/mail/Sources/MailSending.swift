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
        let to = try recipients(params, "to", required: true)
        guard let subject = params["subject"] as? String else {
            throw MailError.missingField("subject")
        }
        guard let body = params["body"] as? String else {
            throw MailError.missingField("body")
        }
        let fields: [String: Any] = [
            "to": to,
            "cc": try recipients(params, "cc", required: false),
            "bcc": try recipients(params, "bcc", required: false),
            "subject": singleLine(subject),
            "body": plainText(body),
        ]
        guard sendGate.isConfirmed(params) else {
            return sendGate.preview(fields)
        }
        _ = try scripts.run(sendScript(fields))
        return sent(fields)
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
        let mailId = try MailId(decoding: id)
        let replyAll = params["reply_all"] as? Bool ?? false
        let read = try scripts.run(
            replyReadScript(mailId, replyAll: replyAll), mailbox: mailId.mailbox, account: mailId.account)
        let fields = try replyFields(read, body: body)
        guard replyGate.isConfirmed(params) else {
            return replyGate.preview(fields)
        }
        _ = try scripts.run(
            replySendScript(mailId, replyAll: replyAll, text: fields["body"] as? String ?? ""),
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

    private static func sendScript(_ fields: [String: Any]) -> String {
        let clauses = ["to", "cc", "bcc"]
            .map { recipientClauses(fields[$0] as? [String] ?? [], kind: $0) }
            .filter { !$0.isEmpty }
            .joined(separator: "\n")
        return """
        tell application "Mail"
            set spwMsg to make new outgoing message with properties {subject:"\(escapeAppleScript(fields["subject"] as? String ?? ""))", content:"\(appleScriptText(fields["body"] as? String ?? ""))", visible:true}
            tell spwMsg
        \(clauses)
            end tell
            if not (send spwMsg) then error "\(sendFailedMarker)"
        end tell
        """
    }

    private static func replyCommand(_ replyAll: Bool) -> String {
        "set spwReply to reply m opening window false reply to all \(replyAll)"
    }

    /// Creates Mail's reply to read its recipients and subject, closes it unsaved, and reads the original's sender,
    /// date and text; fields joined by GS, list items by RS, free text stripped of both.
    private static func replyReadScript(_ id: MailId, replyAll: Bool) -> String {
        """
        \(MailReading.cleanHandler)

        tell application "Mail"
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

    private static func replySendScript(_ id: MailId, replyAll: Bool, text: String) -> String {
        """
        tell application "Mail"
        \(AppleMailClient.messageLookup(id))
            \(replyCommand(replyAll))
            set content of spwReply to "\(appleScriptText(text))"
            if not (send spwReply) then error "\(sendFailedMarker)"
        end tell
        """
    }
}
