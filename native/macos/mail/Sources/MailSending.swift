import Foundation
import SharedCLI

let sendFailedMarker = "SPW_SEND_FAILED"

/// Sends plain-text mail through Mail.app behind the `confirm_send` gate: unconfirmed, a command previews the
/// recipients, subject and full text that would go out; confirmed, it sends exactly that and reports it.
enum MailSending {
    static let sendGate = ConfirmationGate(param: "confirm_send", tool: "sendEmail", question: "Send this email?")
    static let replyGate = ConfirmationGate(param: "confirm_send", tool: "replyToEmail", question: "Send this reply?")
    static let forwardGate = ConfirmationGate(
        param: "confirm_send", tool: "forwardEmail", question: "Forward this email?")
    static let redirectGate = ConfirmationGate(
        param: "confirm_send", tool: "redirectEmail", question: "Redirect this email?")

    private static let fieldSeparator = "\u{1D}"
    private static let itemSeparator = "\u{1E}"
    private static let replyReadFieldCount = 6
    private static let originalReadFieldCount = 5

    private static let quoteDateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.dateFormat = "d MMM yyyy 'at' HH:mm"
        return formatter
    }()

    /// The `send_email` command: a new message to `to`, `cc` and `bcc` from `account` or the default sender; the
    /// preview and the report carry its `from`.
    static func sendEmail(params: [String: Any], scripts: MailScripts) throws -> [String: Any] {
        let signature = try signatureParam(params)
        let account = try accountParam(params)
        var fields = try newMessageFields(params, draft: false, signature: signature)
        fields["account"] = account
        guard sendGate.isConfirmed(params) else {
            fields["from"] = try run(
                senderScript(signature: signature, account: account),
                scripts: scripts,
                signature: signature,
                account: account)
            return sendGate.preview(fields)
        }
        fields["from"] = try run(
            newMessageScript(fields, signature: signature, account: account, finish: sendLine("spwMsg")),
            scripts: scripts,
            signature: signature,
            account: account)
        return sent(fields)
    }

    /// The `save_draft` command: a new message from `account` or the default sender, saved unsent in its Drafts.
    static func saveDraft(params: [String: Any], scripts: MailScripts) throws -> [String: Any] {
        let signature = try signatureParam(params)
        let account = try accountParam(params)
        var fields = try newMessageFields(params, draft: true, signature: signature)
        fields["account"] = account
        fields["from"] = try run(
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

    /// The `reply_to_email` command: Mail's own reply to the mail `id`, the user's text above the quoted original,
    /// with `cc` and `bcc` added to the recipients Mail chose.
    static func replyToEmail(params: [String: Any], scripts: MailScripts) throws -> [String: Any] {
        guard let id = params["id"] as? String else {
            throw MailError.missingField("id")
        }
        guard let body = params["body"] as? String else {
            throw MailError.missingField("body")
        }
        let signature = try signatureParam(params)
        let extraCc = try recipients(params, "cc", required: false)
        let bcc = try recipients(params, "bcc", required: false)
        let mailId = try MailId(decoding: id)
        let replyAll = params["reply_all"] as? Bool ?? false
        let read = try run(
            replyReadScript(mailId, replyAll: replyAll, signature: signature),
            scripts: scripts,
            signature: signature,
            mailbox: mailId.mailbox,
            account: mailId.account)
        var fields = try replyFields(read, body: body)
        let chosen = (fields["to"] as? [String] ?? []) + (fields["cc"] as? [String] ?? [])
        let added = newAddresses(extraCc, besides: chosen)
        let blind = newAddresses(bcc, besides: chosen + added)
        fields["cc"] = (fields["cc"] as? [String] ?? []) + added
        fields["bcc"] = blind
        fields["signature"] = signature
        guard replyGate.isConfirmed(params) else {
            return replyGate.preview(fields)
        }
        let clauses = [recipientClauses(added, kind: "cc"), recipientClauses(blind, kind: "bcc")]
            .filter { !$0.isEmpty }
            .joined(separator: "\n")
        _ = try run(
            replySendScript(
                mailId,
                replyAll: replyAll,
                text: fields["body"] as? String ?? "",
                recipients: clauses,
                signature: signature),
            scripts: scripts,
            signature: signature,
            mailbox: mailId.mailbox,
            account: mailId.account)
        return sent(fields)
    }

    /// The `forward_email` command: Mail's own forward of the mail `id`, with its quote and attachments, to `to`
    /// and `cc`; its content is never changed, since any change leaves only the changed text.
    static func forwardEmail(params: [String: Any], scripts: MailScripts) throws -> [String: Any] {
        try passOn(params, scripts: scripts, gate: forwardGate, command: "forward", readsOutgoingSubject: true)
    }

    /// The `redirect_email` command: Mail's redirect of the mail `id`, unchanged and from its original sender, to
    /// `to` and `cc`.
    static func redirectEmail(params: [String: Any], scripts: MailScripts) throws -> [String: Any] {
        try passOn(params, scripts: scripts, gate: redirectGate, command: "redirect", readsOutgoingSubject: false)
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

    /// Sets the chosen signature, or clears the one Mail may add on its own, so only the previewed text goes out.
    private static func signatureApply(_ signature: String?, to message: String) -> String {
        "    set message signature of \(message) to "
            + (signature.map { "signature \"\(escapeAppleScript($0))\"" } ?? "missing value")
    }

    /// Reads, without making a message, the `Name <address>` a new message goes from.
    private static func senderScript(signature: String?, account: String?) -> String {
        let lines: [String?] = [
            MailReading.cleanHandler,
            "",
            "tell application \"Mail\"",
            signatureCheck(signature),
            senderLines(account: account),
            "end tell",
            "return my spwClean(spwSender)",
        ]
        return lines.compactMap { $0 }.joined(separator: "\n")
    }

    /// AppleScript lines that set `spwSender` to the first address of `account`, or else to Mail's primary address
    /// or the first address of a turned-on account.
    private static func senderLines(account: String?) -> String {
        let address = account.map { name in
            AppleMailClient.accountLookup(name, into: "spwAccount") + """

                if not (enabled of spwAccount) then error "\(accountDisabledMarker)"
                set spwAddresses to email addresses of spwAccount
                if (count of spwAddresses) is 0 then error "\(noSenderMarker)"
                set spwAddress to item 1 of spwAddresses
                set spwName to full name of spwAccount
            """
        } ?? """
                set spwPrimary to ""
                try
                    set spwPrimary to primary email
                end try
                set spwAddress to ""
                set spwName to ""
                repeat with spwCandidate in accounts
                    if enabled of spwCandidate then
                        set spwCandidateAddresses to email addresses of spwCandidate
                        if spwCandidateAddresses contains spwPrimary then
                            set spwAddress to spwPrimary
                            set spwName to full name of spwCandidate
                            exit repeat
                        end if
                        if spwAddress is "" and (count of spwCandidateAddresses) > 0 then
                            set spwAddress to item 1 of spwCandidateAddresses
                            set spwName to full name of spwCandidate
                        end if
                    end if
                end repeat
                if spwAddress is "" then error "\(noSenderMarker)"
            """
        return address + """

                if spwName is missing value then set spwName to ""
                set spwSender to spwAddress
                if spwName is not "" then set spwSender to spwName & " <" & spwAddress & ">"
            """
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
        let lines: [String?] = [
            MailReading.cleanHandler,
            "",
            "tell application \"Mail\"",
            signatureCheck(signature),
            senderLines(account: account),
            "    set spwMsg to make new outgoing message with properties "
                + "{subject:\"\(subject)\", content:\"\(content)\", visible:true}",
            "    set sender of spwMsg to spwSender",
            clauses.isEmpty ? nil : "    tell spwMsg\n\(clauses)\n    end tell",
            signatureApply(signature, to: "spwMsg"),
            finish,
            "end tell",
            "return my spwClean(spwSender)",
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

    /// The addresses of `addresses` not already in `existing`, each once, compared without case.
    private static func newAddresses(_ addresses: [String], besides existing: [String]) -> [String] {
        var seen = Set(existing.map { $0.lowercased() })
        return addresses.filter { seen.insert($0.lowercased()).inserted }
    }

    private static func passOn(
        _ params: [String: Any],
        scripts: MailScripts,
        gate: ConfirmationGate,
        command: String,
        readsOutgoingSubject: Bool
    ) throws -> [String: Any] {
        guard let id = params["id"] as? String else {
            throw MailError.missingField("id")
        }
        let mailId = try MailId(decoding: id)
        let to = try recipients(params, "to", required: true)
        let cc = try recipients(params, "cc", required: false)
        let read = try scripts.run(
            originalReadScript(mailId, makeOutgoing: readsOutgoingSubject ? command : nil),
            mailbox: mailId.mailbox,
            account: mailId.account)
        var fields = try originalFields(read, id: mailId)
        fields["to"] = to
        fields["cc"] = cc
        guard gate.isConfirmed(params) else {
            return gate.preview(fields)
        }
        _ = try scripts.run(
            passOnScript(mailId, command: command, to: to, cc: cc),
            mailbox: mailId.mailbox,
            account: mailId.account)
        return sent(fields)
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

    /// Reads the subject the outgoing message gets (that of Mail's own `makeOutgoing` message, created and closed
    /// unsaved, or else the original's), the original's subject, sender and date, and its attachment names.
    private static func originalReadScript(_ id: MailId, makeOutgoing: String?) -> String {
        let subject = makeOutgoing.map { command in
            """
                set spwOut to \(command) m opening window false
                set spwSubject to my spwClean(subject of spwOut)
                try
                    close spwOut saving no
                end try
            """
        } ?? "    set spwSubject to my spwClean(subject of m)"
        return """
        \(MailReading.cleanHandler)

        tell application "Mail"
        \(AppleMailClient.messageLookup(id))
        \(subject)
            set spwOriginalSubject to my spwClean(subject of m)
            set spwSender to my spwClean(sender of m)
            set spwDate to date received of m
            set spwNames to {}
            repeat with spwAttachment in mail attachments of m
                set end of spwNames to my spwClean(name of spwAttachment)
            end repeat
        end tell
        set spwIsoDate to ""
        if class of spwDate is date then set spwIsoDate to (spwDate as «class isot» as string)
        set AppleScript's text item delimiters to (character id 30)
        set spwFields to {spwSubject, spwOriginalSubject, spwSender, spwIsoDate, spwNames as text}
        set AppleScript's text item delimiters to (character id 29)
        return spwFields as text
        """
    }

    private static func originalFields(_ output: String, id: MailId) throws -> [String: Any] {
        let fields = output.components(separatedBy: fieldSeparator)
        guard fields.count == originalReadFieldCount else {
            throw ScriptError.scriptFailed("Unexpected reply from Mail.app")
        }
        var original: [String: Any] = [
            "id": id.encoded,
            "subject": fields[1],
            "sender": fields[2],
            "mailbox": id.mailbox,
            "account": id.account,
        ]
        original["date"] = AppleMailClient.localDate(fields[3]).map { iso8601String(from: $0, timeZone: .current) }
        return [
            "subject": fields[0],
            "original": original,
            "attachments": fields[4].components(separatedBy: itemSeparator).filter { !$0.isEmpty },
        ]
    }

    private static func passOnScript(_ id: MailId, command: String, to: [String], cc: [String]) -> String {
        let clauses = [recipientClauses(to, kind: "to"), recipientClauses(cc, kind: "cc")]
            .filter { !$0.isEmpty }
            .joined(separator: "\n")
        return """
        tell application "Mail"
        \(AppleMailClient.messageLookup(id))
            set spwOut to \(command) m opening window false
            tell spwOut
        \(clauses)
            end tell
            if not (send spwOut) then error "\(sendFailedMarker)"
        end tell
        """
    }

    private static func replySendScript(
        _ id: MailId,
        replyAll: Bool,
        text: String,
        recipients: String,
        signature: String?
    ) -> String {
        let added = recipients.isEmpty ? "" : "    tell spwReply\n\(recipients)\n    end tell"
        return """
        tell application "Mail"
        \(signatureCheck(signature) ?? "")
        \(AppleMailClient.messageLookup(id))
            \(replyCommand(replyAll))
        \(added)
            set content of spwReply to "\(appleScriptText(text))"
        \(signatureApply(signature, to: "spwReply"))
            if not (send spwReply) then error "\(sendFailedMarker)"
        end tell
        """
    }
}
