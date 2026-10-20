import Foundation
import SharedCLI

/// Apple Mail.app automation via AppleScript.
enum AppleMailClient {
    static let name = "Apple Mail"

    /// The account name `listMailboxes` gives the On My Mac mailboxes, which belong to no account.
    static let localAccountName = "On My Mac"

    static let listFieldSeparator = "\u{1D}"
    static let listItemSeparator = "\u{1E}"

    /// One message of a listing, before paging.
    struct ListedMessage {
        let id: MailId
        let subject: String
        let sender: String
        let received: Date?
        let read: Bool

        var json: [String: Any] {
            var row: [String: Any] = [
                "id": id.encoded,
                "subject": subject,
                "sender": sender,
                "read": read,
                "mailbox": id.mailbox,
                "account": id.account,
            ]
            row["date"] = received.map { iso8601String(from: $0, timeZone: .current) }
            return row
        }
    }

    /// One `make new <kind> recipient...` AppleScript line per comma-separated address.
    static func recipientClauses(_ addresses: String, kind: String) -> String {
        splitAddressList(addresses)
            .map { addr in
                "        make new \(kind) recipient at end of \(kind) recipients "
                    + "with properties {address:\"\(escapeAppleScript(addr))\"}"
            }
            .joined(separator: "\n")
    }

    /// AppleScript lines, run inside `tell application "Mail"`, that set `mb` to the mailbox named `name` in
    /// `account`, or in the one account or On My Mac that has it, and `spwAcctName` to that account's name.
    /// An app-level `mailbox "X"` reaches only On My Mac, so an account mailbox is always `mailbox "X" of account`.
    static func mailboxLookup(name: String, account: String?) -> String {
        let nameEsc = escapeAppleScript(name)
        let localEsc = escapeAppleScript(localAccountName)
        if account == localAccountName {
            return """
                if not (exists mailbox "\(nameEsc)") then error "\(mailboxNotFoundMarker)"
                set mb to mailbox "\(nameEsc)"
                set spwAcctName to "\(localEsc)"
            """
        }
        var accounts = "accounts"
        var accountCheck = ""
        var localCheck = ""
        if let account = account {
            let accountEsc = escapeAppleScript(account)
            accounts = "{account \"\(accountEsc)\"}"
            accountCheck = "    if not (exists account \"\(accountEsc)\") then error \"\(accountNotFoundMarker)\"\n"
        } else {
            localCheck = """

                if exists mailbox "\(nameEsc)" then
                    set end of spwMatches to mailbox "\(nameEsc)"
                    set end of spwNames to "\(localEsc)"
                    set spwAccounts to spwAccounts & "\(localEsc)" & ", "
                end if
            """
        }
        return accountCheck + """
            set spwMatches to {}
            set spwNames to {}
            set spwAccounts to ""
            repeat with spwAcctRef in \(accounts)
                set spwAcct to contents of spwAcctRef
                if exists mailbox "\(nameEsc)" of spwAcct then
                    set end of spwMatches to mailbox "\(nameEsc)" of spwAcct
                    set end of spwNames to name of spwAcct
                    set spwAccounts to spwAccounts & name of spwAcct & ", "
                end if
            end repeat
        """ + localCheck + """

            if (count of spwMatches) is 0 then error "\(mailboxNotFoundMarker)"
            if (count of spwMatches) > 1 then error "\(mailboxAmbiguousMarker)" & spwAccounts
            set mb to item 1 of spwMatches
            set spwAcctName to item 1 of spwNames
        """
    }

    /// AppleScript lines, run inside `tell application "Mail"`, that set `mb` to the mailbox of `id` and `m` to
    /// the message with its Message-ID there.
    static func messageLookup(_ id: MailId) -> String {
        mailboxLookup(name: id.mailbox, account: id.account) + """

            set spwFound to (every message of mb whose message id is "\(escapeAppleScript(id.messageId))")
            if (count of spwFound) is 0 then error "Email not found"
            set m to item 1 of spwFound
        """
    }

    private static let mailboxRow = """
                set mbName to name of mb
                try
                    set parentBox to container of mb
                    repeat while class of parentBox is mailbox
                        set mbName to name of parentBox & "/" & mbName
                        set parentBox to container of parentBox
                    end repeat
                end try
                set msgCount to count of messages of mb
                set output to output & acctName & "||" & mbName & "||" & msgCount & linefeed
        """

    /// Lists every mailbox of every account, then the On My Mac mailboxes under `localAccountName`, each with
    /// `name` as its path inside the account (`Inbox/Clients`), the form `mailbox "<path>" of account` resolves;
    /// Mail reports a nested mailbox by its last segment only.
    static let listMailboxesScript = """
        tell application "Mail"
            set output to ""
            repeat with acctRef in accounts
                set acct to contents of acctRef
                set acctName to name of acct
                repeat with mbRef in mailboxes of acct
                    set mb to contents of mbRef
        \(mailboxRow)
                end repeat
            end repeat
            set acctName to "\(escapeAppleScript(localAccountName))"
            repeat with mbRef in mailboxes
                set mb to contents of mbRef
                set spwOwner to missing value
                try
                    set spwOwner to account of mb
                end try
                if spwOwner is missing value then
        \(mailboxRow)
                end if
            end repeat
            return output
        end tell
        """

    static func listMailboxes(scripts: MailScripts) throws -> [[String: Any]] {
        return parseMailboxes(try scripts.run(listMailboxesScript))
    }

    /// Mailbox rows with `message_count` as a number; a count that is not an integer is left out.
    static func parseMailboxes(_ output: String) -> [[String: Any]] {
        parseDelimited(output, fields: ["account", "name", "message_count"]).map { row in
            var typed = row
            typed["message_count"] = (row["message_count"] as? String).flatMap { Int($0) }
            return typed
        }
    }

    /// The newest-first page `offset..<offset+limit` of the mailbox, and the total the page is cut from.
    static func listEmails(
        scripts: MailScripts,
        mailbox: String,
        account: String?,
        offset: Int,
        limit: Int,
        unreadOnly: Bool
    ) throws -> [String: Any] {
        let script = listEmailsScript(mailbox: mailbox, account: account, unreadOnly: unreadOnly)
        let output = try scripts.run(script, mailbox: mailbox, account: account)
        let messages = newestFirst(try parseListing(output, mailbox: mailbox))
        let page = messages.dropFirst(offset).prefix(limit)
        return ["emails": page.map(\.json), "total": messages.count]
    }

    /// Reads each property of every message in the mailbox with one Apple Event; prints the account name, then one
    /// field per property, items joined by `listItemSeparator` and fields by `listFieldSeparator`.
    static func listEmailsScript(mailbox: String, account: String?, unreadOnly: Bool) -> String {
        let scope = "every message of mb" + (unreadOnly ? " whose read status is false" : "")
        return """
        tell application "Mail"
        \(mailboxLookup(name: mailbox, account: account))
            set spwIds to message id of \(scope)
            set spwSubjects to subject of \(scope)
            set spwSenders to sender of \(scope)
            set spwDates to date received of \(scope)
            set spwReads to read status of \(scope)
        end tell
        set spwIsoDates to {}
        repeat with spwDateRef in spwDates
            set spwDate to contents of spwDateRef
            if class of spwDate is date then
                set end of spwIsoDates to (spwDate as «class isot» as string)
            else
                set end of spwIsoDates to ""
            end if
        end repeat
        set AppleScript's text item delimiters to (character id 30)
        set spwFields to {spwAcctName, spwIds as text, spwSubjects as text, spwSenders as text, spwIsoDates as text, spwReads as text}
        set AppleScript's text item delimiters to (character id 29)
        return spwFields as text
        """
    }

    /// The messages of a `listEmailsScript` output; fields of unequal length mean Mail changed the mailbox mid-read.
    static func parseListing(_ output: String, mailbox: String) throws -> [ListedMessage] {
        let fields = output.components(separatedBy: listFieldSeparator)
        guard fields.count == 6 else {
            throw ScriptError.scriptFailed("Unexpected message list from Mail.app")
        }
        let count = fields[1].isEmpty ? 0 : fields[1].components(separatedBy: listItemSeparator).count
        let columns = fields.dropFirst().map { field in
            count == 0 ? [] : field.components(separatedBy: listItemSeparator)
        }
        guard columns.allSatisfy({ $0.count == count }) else {
            throw MailFailure.mailboxChanged(mailbox: mailbox)
        }
        let account = fields[0]
        return (0..<count).map { i in
            ListedMessage(
                id: MailId(account: account, mailbox: mailbox, messageId: columns[0][i]),
                subject: columns[1][i],
                sender: columns[2][i],
                received: localDate(columns[3][i]),
                read: columns[4][i] == "true"
            )
        }
    }

    /// Newest first; a message without a date goes last, and equal dates keep Mail's order.
    static func newestFirst(_ messages: [ListedMessage]) -> [ListedMessage] {
        messages.enumerated().sorted { a, b in
            switch (a.element.received, b.element.received) {
            case let (x?, y?) where x != y: return x > y
            case (.some, .none): return true
            case (.none, .some): return false
            default: return a.offset < b.offset
            }
        }.map(\.element)
    }

    private static let isotFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ss"
        return formatter
    }()

    /// The instant of an AppleScript `«class isot»` string, a wall-clock time in the host time zone.
    static func localDate(_ isot: String) -> Date? {
        isotFormatter.timeZone = .current
        return isotFormatter.date(from: isot)
    }

    static func getEmail(scripts: MailScripts, id: String) throws -> [String: Any] {
        let mailId = try MailId(decoding: id)
        let script = """
        tell application "Mail"
        \(messageLookup(mailId))
            set subj to subject of m
            set sndr to sender of m
            set rcvd to date received of m as string
            set bod to content of m
            set isRead to read status of m
            set toList to ""
            repeat with r in to recipients of m
                set toList to toList & address of r & ","
            end repeat
            return subj & "||" & sndr & "||" & rcvd & "||" & isRead & "||" & toList & "||" & bod
        end tell
        """

        let output = try scripts.run(script, mailbox: mailId.mailbox, account: mailId.account)
        return try parseEmailDetail(output, id: id)
    }

    static func searchEmails(scripts: MailScripts, query: String, limit: Int, mailbox: String, account: String?) throws -> [[String: Any]] {
        let queryEsc = escapeAppleScript(query)
        let script = """
        tell application "Mail"
        \(mailboxLookup(name: mailbox, account: account))
            set output to ""
            set msgCount to 0
            set msgs to (every message of mb whose subject contains "\(queryEsc)" or content contains "\(queryEsc)")
            repeat with m in msgs
                if msgCount < \(limit) then
                    set msgId to message id of m
                    set subj to subject of m
                    set sndr to sender of m
                    set rcvd to date received of m as string
                    set output to output & msgId & "||" & subj & "||" & sndr & "||" & rcvd & linefeed
                    set msgCount to msgCount + 1
                end if
            end repeat
            return spwAcctName & (character id 29) & output
        end tell
        """

        let output = try scripts.run(script, mailbox: mailbox, account: account)
        return try parseSearchResults(output, mailbox: mailbox)
    }

    /// Search rows, each with the mail id built from the account the lookup resolved and the mailbox searched.
    static func parseSearchResults(_ output: String, mailbox: String) throws -> [[String: Any]] {
        guard let split = output.range(of: listFieldSeparator) else {
            throw ScriptError.scriptFailed("Unexpected search result from Mail.app")
        }
        let account = String(output[..<split.lowerBound])
        let rows = parseDelimited(
            String(output[split.upperBound...]), fields: ["message_id", "subject", "sender", "date"])
        return rows.map { row in
            var typed = row
            let messageId = typed.removeValue(forKey: "message_id") as? String ?? ""
            typed["id"] = MailId(account: account, mailbox: mailbox, messageId: messageId).encoded
            typed["mailbox"] = mailbox
            typed["account"] = account
            return typed
        }
    }

    static func sendEmail(scripts: MailScripts, to: String, subject: String, body: String, cc: String?, bcc: String? = nil) throws -> [String: Any] {
        let subjectEsc = escapeAppleScript(subject)
        let bodyEsc = escapeAppleScript(body)

        let toClause = recipientClauses(to, kind: "to")
        let ccClause = cc.map { recipientClauses($0, kind: "cc") } ?? ""
        let bccClause = bcc.map { recipientClauses($0, kind: "bcc") } ?? ""

        let script = """
        tell application "Mail"
            set newMsg to make new outgoing message with properties {subject:"\(subjectEsc)", content:"\(bodyEsc)", visible:true}
            tell newMsg
        \(toClause)
        \(ccClause)
        \(bccClause)
            end tell
            send newMsg
        end tell
        """

        _ = try scripts.run(script)
        return ["status": "sent"]
    }

    static func replyToEmail(scripts: MailScripts, id: String, body: String, replyAll: Bool) throws -> [String: Any] {
        let mailId = try MailId(decoding: id)
        let bodyEsc = escapeAppleScript(body)
        let replyType = replyAll ? "reply with properties {reply all:true}" : "reply"

        let script = """
        tell application "Mail"
        \(messageLookup(mailId))
            set replyMsg to \(replyType) m
            tell replyMsg
                set content to "\(bodyEsc)" & content
            end tell
            send replyMsg
        end tell
        """

        _ = try scripts.run(script, mailbox: mailId.mailbox, account: mailId.account)
        return ["status": "sent"]
    }
}
