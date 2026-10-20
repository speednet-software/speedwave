import Foundation
import SharedCLI

/// Reads one mail by its mail id: recipients, cc, ISO date, body, attachments and, on request, headers or source.
enum MailReading {
    /// The longest headers or source, in characters, a read returns; a longer one is cut and flagged truncated.
    static let rawTextLimit = 100_000

    private static let fieldSeparator = "\u{1D}"
    private static let itemSeparator = "\u{1E}"
    private static let subfieldSeparator = "\u{1F}"
    private static let fieldCount = 12

    /// The AppleScript handler `spwClean(t)`: `t` as text without ASCII GS, RS and US, "" for missing value.
    static let cleanHandler = """
        on spwClean(t)
            if t is missing value then return ""
            set spwOld to AppleScript's text item delimiters
            set AppleScript's text item delimiters to {character id 29, character id 30, character id 31}
            set spwParts to text items of (t as text)
            set AppleScript's text item delimiters to ""
            set spwText to spwParts as text
            set AppleScript's text item delimiters to spwOld
            return spwText
        end spwClean
        """

    static func getEmail(
        scripts: MailScripts,
        id: String,
        includeHeaders: Bool,
        includeSource: Bool
    ) throws -> [String: Any] {
        let mailId = try MailId(decoding: id)
        let script = getEmailScript(mailId, includeHeaders: includeHeaders, includeSource: includeSource)
        let output = try scripts.run(script, mailbox: mailId.mailbox, account: mailId.account)
        return try parseEmail(output, id: mailId, includeHeaders: includeHeaders, includeSource: includeSource)
    }

    /// Prints the mail's fields joined by ASCII GS, list items by RS and attachment fields by US; free text is
    /// stripped of those three characters first, so a mail cannot forge a field.
    static func getEmailScript(_ id: MailId, includeHeaders: Bool, includeSource: Bool) -> String {
        """
        \(cleanHandler)

        on spwCapped(t)
            if t is missing value then return {"", "false"}
            set t to t as text
            if (length of t) > \(rawTextLimit) then return {my spwClean(text 1 thru \(rawTextLimit) of t), "true"}
            return {my spwClean(t), "false"}
        end spwCapped

        tell application "Mail"
        \(AppleMailClient.messageLookup(id))
            set spwSubject to subject of m
            set spwSender to sender of m
            set spwDate to date received of m
            set spwRead to read status of m as string
            set spwTo to {}
            repeat with spwRecipient in to recipients of m
                set end of spwTo to my spwClean(address of spwRecipient)
            end repeat
            set spwCc to {}
            repeat with spwRecipient in cc recipients of m
                set end of spwCc to my spwClean(address of spwRecipient)
            end repeat
            set spwAttachments to {}
            repeat with spwAttachment in mail attachments of m
                set spwSize to ""
                try
                    set spwSize to (file size of spwAttachment) as string
                end try
                set spwType to ""
                try
                    set spwType to MIME type of spwAttachment
                end try
                set end of spwAttachments to my spwClean(name of spwAttachment) & (character id 31) & my spwClean(spwSize) & (character id 31) & my spwClean(spwType)
            end repeat
            set spwBody to content of m
            set spwHeaders to \(includeHeaders ? "all headers of m" : "\"\"")
            set spwSource to \(includeSource ? "source of m" : "\"\"")
        end tell
        set spwIsoDate to ""
        if class of spwDate is date then set spwIsoDate to (spwDate as «class isot» as string)
        set spwHeaderPart to my spwCapped(spwHeaders)
        set spwSourcePart to my spwCapped(spwSource)
        set spwSubject to my spwClean(spwSubject)
        set spwSender to my spwClean(spwSender)
        set spwBody to my spwClean(spwBody)
        set AppleScript's text item delimiters to (character id 30)
        set spwFields to {spwSubject, spwSender, spwIsoDate, spwRead, spwTo as text, spwCc as text, spwAttachments as text, item 1 of spwHeaderPart, item 2 of spwHeaderPart, item 1 of spwSourcePart, item 2 of spwSourcePart, spwBody}
        set AppleScript's text item delimiters to (character id 29)
        return spwFields as text
        """
    }

    /// The email of a `getEmailScript` output; `headers` and `source` appear only when asked for.
    static func parseEmail(
        _ output: String,
        id: MailId,
        includeHeaders: Bool,
        includeSource: Bool
    ) throws -> [String: Any] {
        let fields = output.components(separatedBy: fieldSeparator)
        guard fields.count == fieldCount else {
            throw ScriptError.scriptFailed("Unexpected email from Mail.app")
        }
        var email: [String: Any] = [
            "id": id.encoded,
            "subject": fields[0],
            "sender": fields[1],
            "read": fields[3] == "true",
            "to": items(fields[4]),
            "cc": items(fields[5]),
            "attachments": attachments(fields[6]),
            "body": fields[11],
            "mailbox": id.mailbox,
            "account": id.account,
        ]
        email["date"] = AppleMailClient.localDate(fields[2]).map { iso8601String(from: $0, timeZone: .current) }
        if includeHeaders {
            email["headers"] = fields[7]
            email["headers_truncated"] = fields[8] == "true"
        }
        if includeSource {
            email["source"] = fields[9]
            email["source_truncated"] = fields[10] == "true"
        }
        return email
    }

    private static func items(_ field: String) -> [String] {
        field.components(separatedBy: itemSeparator).filter { !$0.isEmpty }
    }

    private static func attachments(_ field: String) -> [[String: Any]] {
        items(field).enumerated().map { offset, item in
            let parts = item.components(separatedBy: subfieldSeparator)
            var attachment: [String: Any] = ["index": offset + 1, "name": parts[0]]
            attachment["size"] = parts.count > 1 ? Double(parts[1]).map { Int($0) } : nil
            attachment["mime_type"] = parts.count > 2 && !parts[2].isEmpty ? parts[2] : nil
            return attachment
        }
    }
}
