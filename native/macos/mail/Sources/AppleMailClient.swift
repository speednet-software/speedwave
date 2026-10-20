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

    /// Which messages of a mailbox a listing reads; Mail evaluates every condition. A query matches the subject or
    /// the sender, and with `searchBody` also the content, which Mail scans in a separate, slower request.
    struct MessageFilter {
        var unreadOnly = false
        var sender: String?
        var since: Date?
        var before: Date?
        var query: String?
        var searchBody = false

        var setup: String {
            [since.map { dateVariable("spwSince", $0) }, before.map { dateVariable("spwBefore", $0) }]
                .compactMap { $0 }
                .joined()
        }

        var propertyScope: String {
            scope(conditions(query: searchBody ? nil : queryCondition))
        }

        var bodyScope: String? {
            guard searchBody, query != nil else { return nil }
            return scope(conditions(query: queryCondition))
        }

        private var queryCondition: String? {
            query.map { query in
                let fields = searchBody ? ["subject", "sender", "content"] : ["subject", "sender"]
                let queryEsc = escapeAppleScript(query)
                return "(" + fields.map { "\($0) contains \"\(queryEsc)\"" }.joined(separator: " or ") + ")"
            }
        }

        private func conditions(query: String?) -> [String] {
            [
                unreadOnly ? "read status is false" : nil,
                sender.map { "sender contains \"\(escapeAppleScript($0))\"" },
                since.map { _ in "date received is greater than or equal to spwSince" },
                before.map { _ in "date received is less than spwBefore" },
                query,
            ].compactMap { $0 }
        }

        private func scope(_ conditions: [String]) -> String {
            "every message of mb" + (conditions.isEmpty ? "" : " whose " + conditions.joined(separator: " and "))
        }

        private func dateVariable(_ name: String, _ date: Date) -> String {
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = .current
            let parts = calendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
            let seconds = (parts.hour ?? 0) * 3600 + (parts.minute ?? 0) * 60 + (parts.second ?? 0)
            return """
            set \(name) to current date
            set day of \(name) to 1
            set year of \(name) to \(parts.year ?? 0)
            set month of \(name) to \(parts.month ?? 1)
            set day of \(name) to \(parts.day ?? 1)
            set time of \(name) to \(seconds)

            """
        }
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
            if (count of spwFound) is 0 then error "\(mailNotFoundMarker)"
            set m to item 1 of spwFound
        """
    }

    /// Lists every mailbox of every account, then the On My Mac mailboxes under `localAccountName`, each with
    /// `name` as its path inside the account (`Inbox/Clients`), the form `mailbox "<path>" of account` resolves;
    /// Mail reports a nested mailbox by its last segment only. Each account costs five bulk reads, whatever its
    /// number of mailboxes; the paths and counts are worked out after Mail answered.
    static let listMailboxesScript = """
        tell application "Mail"
            set spwScopes to {}
            repeat with spwAcctRef in accounts
                set spwAcct to contents of spwAcctRef
                set spwAcctName to name of spwAcct
                set spwBoxes to every mailbox of spwAcct
                set spwNames to name of every mailbox of spwAcct
                set spwParents to container of every mailbox of spwAcct
                set spwIds to id of every message of every mailbox of spwAcct
                set end of spwScopes to {spwAcctName, spwBoxes, spwNames, spwParents, spwIds, missing value}
            end repeat
            set spwBoxes to every mailbox
            set spwNames to name of every mailbox
            set spwParents to container of every mailbox
            set spwIds to id of every message of every mailbox
            set spwOwners to account of every mailbox
            set end of spwScopes to {"\(escapeAppleScript(localAccountName))", spwBoxes, spwNames, spwParents, spwIds, spwOwners}
        end tell
        set spwLines to {}
        repeat with spwScopeRef in spwScopes
            set spwScope to contents of spwScopeRef
            set spwAcctName to item 1 of spwScope
            set spwBoxes to item 2 of spwScope
            set spwNames to item 3 of spwScope
            set spwParents to item 4 of spwScope
            set spwIds to item 5 of spwScope
            set spwOwners to item 6 of spwScope
            set spwCount to count of spwBoxes
            if (count of spwNames) is not spwCount or (count of spwParents) is not spwCount or (count of spwIds) is not spwCount then error "\(mailboxesChangedMarker)"
            repeat with spwI from 1 to spwCount
                set spwLocal to true
                if spwOwners is not missing value then set spwLocal to (item spwI of spwOwners is missing value)
                if spwLocal then
                    set spwPath to item spwI of spwNames
                    set spwParent to item spwI of spwParents
                    repeat spwCount times
                        set spwJ to 0
                        repeat with spwK from 1 to spwCount
                            if item spwK of spwBoxes is spwParent then set spwJ to spwK
                        end repeat
                        if spwJ is 0 then exit repeat
                        set spwPath to (item spwJ of spwNames) & "/" & spwPath
                        set spwParent to item spwJ of spwParents
                    end repeat
                    set end of spwLines to spwAcctName & "||" & spwPath & "||" & (count of item spwI of spwIds)
                end if
            end repeat
        end repeat
        set AppleScript's text item delimiters to linefeed
        return spwLines as text
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

    /// The newest-first page `offset..<offset+limit` of the messages `filter` keeps, and the total the page is cut from.
    static func listEmails(
        scripts: MailScripts,
        mailbox: String,
        account: String?,
        filter: MessageFilter,
        offset: Int,
        limit: Int
    ) throws -> [String: Any] {
        let script = listEmailsScript(mailbox: mailbox, account: account, filter: filter)
        let output = try scripts.run(script, mailbox: mailbox, account: account)
        let messages = newestFirst(try parseListing(output, mailbox: mailbox))
        let page = messages.dropFirst(offset).prefix(limit)
        return ["emails": page.map(\.json), "total": messages.count]
    }

    /// Reads each property of every message `filter` keeps with one Apple Event; prints the account name, then one
    /// field per property, items joined by `listItemSeparator` and fields by `listFieldSeparator`. A body search adds
    /// a last field with the Message-IDs whose content matched.
    static func listEmailsScript(mailbox: String, account: String?, filter: MessageFilter) -> String {
        let scope = filter.propertyScope
        let bodyRead = filter.bodyScope.map { "\n    set spwBodyIds to message id of \($0)" } ?? ""
        let bodyField = filter.bodyScope == nil ? "" : ", spwBodyIds as text"
        return """
        \(filter.setup)tell application "Mail"
        \(mailboxLookup(name: mailbox, account: account))
            set spwIds to message id of \(scope)
            set spwSubjects to subject of \(scope)
            set spwSenders to sender of \(scope)
            set spwDates to date received of \(scope)
            set spwReads to read status of \(scope)\(bodyRead)
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
        set spwFields to {spwAcctName, spwIds as text, spwSubjects as text, spwSenders as text, spwIsoDates as text, spwReads as text\(bodyField)}
        set AppleScript's text item delimiters to (character id 29)
        return spwFields as text
        """
    }

    /// The messages of a `listEmailsScript` output, only those a body search matched when it carries their ids;
    /// fields of unequal length mean Mail changed the mailbox mid-read.
    static func parseListing(_ output: String, mailbox: String) throws -> [ListedMessage] {
        var fields = output.components(separatedBy: listFieldSeparator)
        guard fields.count == 6 || fields.count == 7 else {
            throw ScriptError.scriptFailed("Unexpected message list from Mail.app")
        }
        let matched = fields.count == 7 ? Set(fields.removeLast().components(separatedBy: listItemSeparator)) : nil
        let count = fields[1].isEmpty ? 0 : fields[1].components(separatedBy: listItemSeparator).count
        let columns = fields.dropFirst().map { field in
            count == 0 ? [] : field.components(separatedBy: listItemSeparator)
        }
        guard columns.allSatisfy({ $0.count == count }) else {
            throw MailFailure.mailboxChanged(mailbox: mailbox)
        }
        let account = fields[0]
        return (0..<count).filter { matched?.contains(columns[0][$0]) ?? true }.map { i in
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
}
