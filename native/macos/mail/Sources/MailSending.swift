import Foundation
import SharedCLI

let sendFailedMarker = "SPW_SEND_FAILED"
let previewChangedMarker = "SPW_PREVIEW_CHANGED"

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
    private static let replyReadFieldCount = 10
    private static let forwardReadFieldCount = 8
    private static let redirectReadFieldCount = 6

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

    /// The `reply_to_email` command: a reply to the mail `id`, the user's text above the quoted original, to its
    /// Reply-To or sender (with `reply_all` also its other recipients but the user's own addresses), with `cc` and
    /// `bcc` added; the preview reads the original only, since every message Mail makes keeps a Mail thread busy.
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
            replyReadScript(mailId, signature: signature),
            scripts: scripts,
            signature: signature,
            mailbox: mailId.mailbox,
            account: mailId.account)
        let reply = try replyPreview(read, body: body, replyAll: replyAll)
        let added = newAddresses(extraCc, besides: reply.to + reply.cc)
        let blind = newAddresses(bcc, besides: reply.to + reply.cc + added)
        var fields: [String: Any] = [
            "to": reply.to,
            "cc": reply.cc + added,
            "bcc": blind,
            "subject": reply.subject,
            "body": reply.body,
            "from": reply.sender.display,
        ]
        fields["signature"] = signature
        guard replyGate.isConfirmed(params) else {
            return replyGate.preview(fields)
        }
        let clauses = [recipientClauses(added, kind: "cc"), recipientClauses(blind, kind: "bcc")]
            .filter { !$0.isEmpty }
            .joined(separator: "\n")
        _ = try run(
            replySendScript(mailId, replyAll: replyAll, reply: reply, recipients: clauses, signature: signature),
            scripts: scripts,
            signature: signature,
            mailbox: mailId.mailbox,
            account: mailId.account)
        return sent(fields)
    }

    /// The `forward_email` command: Mail's own forward of the mail `id`, with its quote and attachments, to `to`
    /// and `cc`; its content is never changed, since any change leaves only the changed text. The preview reads the
    /// original only, since every message Mail makes keeps a Mail thread busy.
    static func forwardEmail(params: [String: Any], scripts: MailScripts) throws -> [String: Any] {
        let (mailId, to, cc) = try passOnParams(params)
        let read = try scripts.run(forwardReadScript(mailId), mailbox: mailId.mailbox, account: mailId.account)
        let forward = try forwardPreview(read, id: mailId)
        let fields = forward.fields.merging(["to": to, "cc": cc]) { _, given in given }
        guard forwardGate.isConfirmed(params) else {
            return forwardGate.preview(fields)
        }
        let check = previewCheck("spwOut", subject: forward.subject, sender: forward.sender.address)
        _ = try scripts.run(
            passOnScript(mailId, command: "forward", to: to, cc: cc, check: check),
            mailbox: mailId.mailbox,
            account: mailId.account)
        return sent(fields)
    }

    /// The `redirect_email` command: Mail's redirect of the mail `id`, unchanged and from its original sender, to
    /// `to` and `cc`.
    static func redirectEmail(params: [String: Any], scripts: MailScripts) throws -> [String: Any] {
        let (mailId, to, cc) = try passOnParams(params)
        let read = try scripts.run(redirectReadScript(mailId), mailbox: mailId.mailbox, account: mailId.account)
        let fields = try redirectFields(read, id: mailId).merging(["to": to, "cc": cc]) { _, given in given }
        guard redirectGate.isConfirmed(params) else {
            return redirectGate.preview(fields)
        }
        _ = try scripts.run(
            passOnScript(mailId, command: "redirect", to: to, cc: cc, check: nil),
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
        let account = try nameParam(params, "account", rule: "must be an account name from listMailboxes")
        guard account != AppleMailClient.localAccountName else {
            throw MailError.invalidValue(
                "account",
                "On My Mac has no mail server, so nothing can be sent or saved from it; pass another account from "
                    + "listMailboxes, or leave account out for the default sender")
        }
        return account
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

    /// AppleScript lines that run `body` and, when any of it fails, close the outgoing message `message` unsaved and
    /// raise the same error, so a failure never leaves a windowless message in Mail.
    private static func closingOnError(_ message: String, _ body: String) -> String {
        """
            try
        \(body)
            on error spwErr number spwNum
                try
                    close \(message) saving no
                end try
                error spwErr number spwNum
            end try
        """
    }

    /// The AppleScript line that refuses a mail whose account is turned off, since Mail would then send its reply,
    /// forward or redirect from another account.
    private static let enabledAccountCheck =
        "    if spwAcct is not missing value then\n"
        + "        if not (enabled of spwAcct) then error \"\(accountDisabledMarker)\"\n"
        + "    end if"

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
            closingOnError("spwMsg", [
                "    set sender of spwMsg to spwSender",
                clauses.isEmpty ? nil : "    tell spwMsg\n\(clauses)\n    end tell",
                signatureApply(signature, to: "spwMsg"),
            ].compactMap { $0 }.joined(separator: "\n")),
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
        let addresses = splitAddressList(raw).map(singleLine).filter { !$0.isEmpty }
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

    private static func passOnParams(_ params: [String: Any]) throws -> (MailId, [String], [String]) {
        guard let id = params["id"] as? String else {
            throw MailError.missingField("id")
        }
        let mailId = try MailId(decoding: id)
        return (mailId, try recipients(params, "to", required: true), try recipients(params, "cc", required: false))
    }

    private static func sent(_ fields: [String: Any]) -> [String: Any] {
        fields.merging(["status": "sent"]) { _, status in status }
    }

    /// Reads, without making a message, the original's subject, sender, Reply-To, recipients, date and text, every
    /// address of every account, and the sender a reply goes from; fields joined by GS, list items by RS.
    private static func replyReadScript(_ id: MailId, signature: String?) -> String {
        """
        \(MailReading.cleanHandler)

        tell application "Mail"
        \(signatureCheck(signature) ?? "")
        \(AppleMailClient.messageLookup(id))
        \(enabledAccountCheck)
            set spwSubject to my spwClean(subject of m)
            set spwOriginalSender to my spwClean(sender of m)
            set spwReplyTo to ""
            try
                set spwReplyTo to my spwClean(reply to of m)
            end try
        \(originalRecipientLines)
            set spwDate to date received of m
            set spwOriginal to my spwClean(content of m)
            set spwOwn to {}
            repeat with spwAccount in accounts
                set spwAccountAddresses to email addresses of spwAccount
                repeat with spwOwnAddress in spwAccountAddresses
                    set end of spwOwn to my spwClean(contents of spwOwnAddress)
                end repeat
            end repeat
        \(fromLines(id))
        end tell
        set spwIsoDate to ""
        if class of spwDate is date then set spwIsoDate to (spwDate as «class isot» as string)
        set AppleScript's text item delimiters to (character id 30)
        set spwFields to {spwSubject, spwOriginalSender, spwReplyTo, spwTo as text, spwCc as text, spwIsoDate, spwOriginal, spwOwn as text, spwFromName, spwFromAddresses as text}
        set AppleScript's text item delimiters to (character id 29)
        return spwFields as text
        """
    }

    /// AppleScript lines that read the addresses of the original's To and Cc recipients into `spwTo` and `spwCc`.
    private static let originalRecipientLines = """
            set spwTo to {}
            repeat with spwRecipient in to recipients of m
                set end of spwTo to my spwClean(address of spwRecipient)
            end repeat
            set spwCc to {}
            repeat with spwRecipient in cc recipients of m
                set end of spwCc to my spwClean(address of spwRecipient)
            end repeat
        """

    /// AppleScript lines that set `spwFromName` and `spwFromAddresses` to the full name and addresses of the mail's
    /// account, or for an On My Mac mail, which has no account, to Mail's default sender.
    private static func fromLines(_ id: MailId) -> String {
        guard !id.accountId.isEmpty else {
            return senderLines(account: nil) + """

                    set spwFromName to my spwClean(spwName)
                    set spwFromAddresses to {spwAddress}
                """
        }
        return """
                set spwFromName to my spwClean(full name of spwAcct)
                set spwFromAddresses to email addresses of spwAcct
            """
    }

    /// The reply a preview shows and a send checks Mail's reply against: Reply-To or sender, with `replyAll` the
    /// original's To and Cc without the user's own addresses, each once whatever its case.
    private static func replyPreview(_ output: String, body: String, replyAll: Bool) throws -> ReplyPreview {
        let fields = output.components(separatedBy: fieldSeparator)
        guard fields.count == replyReadFieldCount else {
            throw ScriptError.scriptFailed("Unexpected reply from Mail.app")
        }
        let originalTo = addresses(fields[3])
        let originalCc = addresses(fields[4])
        let own = addresses(fields[7])
        let replyTo = splitAddressList(fields[2]).map(bareAddress).filter { !$0.isEmpty }
        let targets = replyTo.isEmpty ? [bareAddress(fields[1])].filter { !$0.isEmpty } : replyTo
        var to = newAddresses(targets, besides: [])
        var cc: [String] = []
        if replyAll {
            to += newAddresses(originalTo, besides: own + to)
            cc = newAddresses(originalCc, besides: own + to)
        }
        return ReplyPreview(
            to: to,
            cc: cc,
            subject: prefixed(fields[0], "Re:"),
            body: replyText(
                body: body, sender: fields[1], received: AppleMailClient.localDate(fields[5]), original: fields[6]),
            sender: try sender(name: fields[8], addresses: addresses(fields[9]), recipients: originalTo + originalCc))
    }

    /// Reads, without making a message, the original's subject, sender, date, attachment names and recipients and
    /// the sender a forward goes from.
    private static func forwardReadScript(_ id: MailId) -> String {
        """
        \(MailReading.cleanHandler)

        tell application "Mail"
        \(AppleMailClient.messageLookup(id))
        \(enabledAccountCheck)
            set spwSubject to my spwClean(subject of m)
            set spwOriginalSender to my spwClean(sender of m)
            set spwDate to date received of m
            set spwNames to {}
            repeat with spwAttachment in mail attachments of m
                set end of spwNames to my spwClean(name of spwAttachment)
            end repeat
        \(originalRecipientLines)
        \(fromLines(id))
        end tell
        set spwIsoDate to ""
        if class of spwDate is date then set spwIsoDate to (spwDate as «class isot» as string)
        set AppleScript's text item delimiters to (character id 30)
        set spwFields to {spwSubject, spwOriginalSender, spwIsoDate, spwNames as text, spwTo as text, spwCc as text, spwFromName, spwFromAddresses as text}
        set AppleScript's text item delimiters to (character id 29)
        return spwFields as text
        """
    }

    private static func forwardPreview(_ output: String, id: MailId) throws -> PassOnPreview {
        let fields = output.components(separatedBy: fieldSeparator)
        guard fields.count == forwardReadFieldCount else {
            throw ScriptError.scriptFailed("Unexpected reply from Mail.app")
        }
        let sender = try sender(
            name: fields[6], addresses: addresses(fields[7]), recipients: addresses(fields[4]) + addresses(fields[5]))
        let subject = prefixed(fields[0], "Fwd:")
        return PassOnPreview(
            fields: [
                "subject": subject,
                "from": sender.display,
                "original": original(id, subject: fields[0], sender: fields[1], received: fields[2]),
                "attachments": items(fields[3]),
            ],
            subject: subject,
            sender: sender)
    }

    /// Makes Mail's own redirect of the mail to read the sender it goes from, closes it unsaved, and reads the
    /// original's subject, sender, date and attachment names; a redirect keeps no Mail thread busy.
    private static func redirectReadScript(_ id: MailId) -> String {
        let reads = closingOnError("spwOut", """
                set spwFrom to my spwClean(sender of spwOut)
            """)
        return """
        \(MailReading.cleanHandler)

        tell application "Mail"
        \(AppleMailClient.messageLookup(id))
        \(enabledAccountCheck)
            set spwOut to redirect m opening window false
        \(reads)
            try
                close spwOut saving no
            end try
            set spwSubject to my spwClean(subject of m)
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
        set spwFields to {spwSubject, spwSubject, spwSender, spwIsoDate, spwNames as text, spwFrom}
        set AppleScript's text item delimiters to (character id 29)
        return spwFields as text
        """
    }

    private static func redirectFields(_ output: String, id: MailId) throws -> [String: Any] {
        let fields = output.components(separatedBy: fieldSeparator)
        guard fields.count == redirectReadFieldCount else {
            throw ScriptError.scriptFailed("Unexpected reply from Mail.app")
        }
        return [
            "subject": fields[0],
            "from": fields[5],
            "original": original(id, subject: fields[1], sender: fields[2], received: fields[3]),
            "attachments": items(fields[4]),
        ]
    }

    private static func original(_ id: MailId, subject: String, sender: String, received: String) -> [String: Any] {
        var original: [String: Any] = [
            "id": id.encoded,
            "subject": subject,
            "sender": sender,
            "mailbox": id.mailbox,
            "account": id.account,
        ]
        original["date"] = AppleMailClient.localDate(received).map { iso8601String(from: $0, timeZone: .current) }
        return original
    }

    private static func items(_ field: String) -> [String] {
        field.components(separatedBy: itemSeparator).filter { !$0.isEmpty }
    }

    private static func addresses(_ field: String) -> [String] {
        items(field).map(bareAddress).filter { !$0.isEmpty }
    }

    /// The address of `entry`: the text inside its last `<...>`, else the whole entry, trimmed.
    private static func bareAddress(_ entry: String) -> String {
        let trimmed = entry.trimmingCharacters(in: .whitespaces)
        guard let open = trimmed.lastIndex(of: "<"), let close = trimmed[open...].firstIndex(of: ">") else {
            return trimmed
        }
        return trimmed[trimmed.index(after: open)..<close].trimmingCharacters(in: .whitespaces)
    }

    /// `subject` with `prefix` and a space in front, unless it already starts with `prefix` in any case.
    private static func prefixed(_ subject: String, _ prefix: String) -> String {
        let start = subject.trimmingCharacters(in: .whitespaces).lowercased()
        return start.hasPrefix(prefix.lowercased()) ? subject : "\(prefix) \(subject)"
    }

    /// The account address the original went to, else the account's first one, named by `name` when it has one.
    private static func sender(name: String, addresses: [String], recipients: [String]) throws -> Sender {
        let wanted = Set(recipients.map { $0.lowercased() })
        guard let address = addresses.first(where: { wanted.contains($0.lowercased()) }) ?? addresses.first else {
            throw MailFailure.noSender
        }
        return Sender(display: name.isEmpty ? address : "\(name) <\(address)>", address: address)
    }

    /// AppleScript lines that raise `previewChangedMarker` unless the outgoing `message` Mail made has the previewed
    /// subject and sender address and, when given, exactly the previewed To and Cc addresses in any case.
    private static func previewCheck(
        _ message: String,
        to: [String]? = nil,
        cc: [String]? = nil,
        subject: String,
        sender: String
    ) -> String {
        let changed = "error \"\(previewChangedMarker)\""
        var lines: [String] = []
        for (kind, expected) in [("to", to), ("cc", cc)] {
            guard let expected else { continue }
            let seen = "spwSeen" + kind.capitalized
            let list = expected.map { "\"\(escapeAppleScript($0))\"" }.joined(separator: ", ")
            lines += [
                "    set \(seen) to {}",
                "    repeat with spwRecipient in \(kind) recipients of \(message)",
                "        set end of \(seen) to address of spwRecipient",
                "    end repeat",
                "    if not my spwSameAddresses(\(seen), {\(list)}) then \(changed)",
            ]
        }
        lines += [
            "    considering case",
            "        if (subject of \(message)) is not \"\(escapeAppleScript(subject))\" then \(changed)",
            "    end considering",
            "    if (extract address from (sender of \(message))) is not \"\(escapeAppleScript(sender))\" then \(changed)",
        ]
        return lines.joined(separator: "\n")
    }

    /// The handler `previewCheck` compares address lists with: the same count, and every seen address expected, in
    /// any case.
    private static let sameAddressesHandler = """
        on spwSameAddresses(spwSeen, spwExpected)
            if (count of spwSeen) is not (count of spwExpected) then return false
            repeat with spwAddress in spwSeen
                if spwExpected does not contain (contents of spwAddress) then return false
            end repeat
            return true
        end spwSameAddresses
        """

    private static func passOnScript(
        _ id: MailId,
        command: String,
        to: [String],
        cc: [String],
        check: String?
    ) -> String {
        let clauses = [recipientClauses(to, kind: "to"), recipientClauses(cc, kind: "cc")]
            .filter { !$0.isEmpty }
            .joined(separator: "\n")
        let work = [check, "    tell spwOut\n\(clauses)\n    end tell"].compactMap { $0 }.joined(separator: "\n")
        return """
        tell application "Mail"
        \(AppleMailClient.messageLookup(id))
        \(enabledAccountCheck)
            set spwOut to \(command) m opening window false
        \(closingOnError("spwOut", work))
            if not (send spwOut) then error "\(sendFailedMarker)"
        end tell
        """
    }

    private static func replySendScript(
        _ id: MailId,
        replyAll: Bool,
        reply: ReplyPreview,
        recipients: String,
        signature: String?
    ) -> String {
        let added = recipients.isEmpty ? nil : "    tell spwReply\n\(recipients)\n    end tell"
        let changes = [
            previewCheck("spwReply", to: reply.to, cc: reply.cc, subject: reply.subject, sender: reply.sender.address),
            added,
            "    set content of spwReply to \"\(appleScriptText(reply.body))\"",
            signatureApply(signature, to: "spwReply"),
        ].compactMap { $0 }.joined(separator: "\n")
        return """
        \(sameAddressesHandler)

        tell application "Mail"
        \(signatureCheck(signature) ?? "")
        \(AppleMailClient.messageLookup(id))
        \(enabledAccountCheck)
            set spwReply to reply m opening window false reply to all \(replyAll)
        \(closingOnError("spwReply", changes))
            if not (send spwReply) then error "\(sendFailedMarker)"
        end tell
        """
    }
}

/// The sender a reply or forward goes from: `Name <address>` as previewed, and the address a send checks.
private struct Sender {
    let display: String
    let address: String
}

/// What a reply preview shows and its send checks Mail's reply against.
private struct ReplyPreview {
    let to: [String]
    let cc: [String]
    let subject: String
    let body: String
    let sender: Sender
}

/// The fields a forward preview shows, with the subject and sender its send checks Mail's forward against.
private struct PassOnPreview {
    let fields: [String: Any]
    let subject: String
    let sender: Sender
}
