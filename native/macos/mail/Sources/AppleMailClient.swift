import Foundation
import SharedCLI

/// Apple Mail.app automation via AppleScript.
enum AppleMailClient {
    static let name = "Apple Mail"

    /// The account name `listMailboxes` gives the On My Mac mailboxes, which belong to no account.
    static let localAccountName = "On My Mac"

    static let listFieldSeparator = "\u{1D}"
    static let listItemSeparator = "\u{1E}"
    static let mailboxSeparator = "\u{1C}"

    /// One message of a listing, before paging.
    struct ListedMessage {
        let id: MailId
        let subject: String
        let sender: String
        let received: Date?
        let read: Bool
        let flag: String

        var json: [String: Any] {
            var row: [String: Any] = [
                "id": id.encoded,
                "subject": subject,
                "sender": sender,
                "read": read,
                "flag": flag,
                "mailbox": id.mailbox,
                "account": id.account,
            ]
            row["date"] = received.map { iso8601String(from: $0, timeZone: .current) }
            return row
        }
    }

    /// Which messages of a mailbox a listing reads; Mail evaluates every condition. A recipient matches a To or Cc
    /// address, a query the subject or the sender, and with `searchBody` also the content, which Mail scans in a
    /// separate, slower request.
    struct MessageFilter {
        var unreadOnly = false
        var flaggedOnly = false
        var sender: String?
        var recipient: String?
        var since: Date?
        var before: Date?
        var query: String?
        var searchBody = false

        var narrows: Bool {
            unreadOnly || flaggedOnly || sender != nil || recipient != nil || since != nil || before != nil
                || query != nil
        }

        var setup: String {
            [since.map { dateVariable("spwSince", $0) }, before.map { dateVariable("spwBefore", $0) }]
                .compactMap { $0 }
                .joined()
        }

        /// The messages of `mailboxes` (`mb`, `every mailbox of spwAcct`) whose properties a listing reads.
        func propertyScope(of mailboxes: String) -> String {
            scope(mailboxes, conditions(query: searchBody ? nil : queryCondition))
        }

        var bodyScope: String? {
            guard searchBody, query != nil else { return nil }
            return scope("mb", conditions(query: queryCondition))
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
                flaggedOnly ? "flagged status is true" : nil,
                sender.map { "sender contains \"\(escapeAppleScript($0))\"" },
                recipient.map { recipient in
                    let addresses = ["to", "cc"].map {
                        "(address of every \($0) recipient) contains \"\(escapeAppleScript(recipient))\""
                    }
                    return "(" + addresses.joined(separator: " or ") + ")"
                },
                since.map { _ in "date received is greater than or equal to spwSince" },
                before.map { _ in "date received is less than spwBefore" },
                query,
            ].compactMap { $0 }
        }

        private func scope(_ mailboxes: String, _ conditions: [String]) -> String {
            "every message of \(mailboxes)"
                + (conditions.isEmpty ? "" : " whose " + conditions.joined(separator: " and "))
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
    /// Mail reports a nested mailbox by its last segment only. Each account costs six bulk reads, whatever its
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
                set spwUnread to unread count of every mailbox of spwAcct
                set end of spwScopes to {spwAcctName, spwBoxes, spwNames, spwParents, spwIds, spwUnread, missing value}
            end repeat
            set spwBoxes to every mailbox
            set spwNames to name of every mailbox
            set spwParents to container of every mailbox
            set spwIds to id of every message of every mailbox
            set spwUnread to unread count of every mailbox
            set spwOwners to account of every mailbox
            set end of spwScopes to {"\(escapeAppleScript(localAccountName))", spwBoxes, spwNames, spwParents, spwIds, spwUnread, spwOwners}
        end tell
        set spwLines to {}
        repeat with spwScopeRef in spwScopes
            set spwScope to contents of spwScopeRef
            set spwAcctName to item 1 of spwScope
            set spwBoxes to item 2 of spwScope
            set spwNames to item 3 of spwScope
            set spwParents to item 4 of spwScope
            set spwIds to item 5 of spwScope
            set spwUnread to item 6 of spwScope
            set spwOwners to item 7 of spwScope
            set spwCount to count of spwBoxes
            if (count of spwNames) is not spwCount or (count of spwParents) is not spwCount or (count of spwIds) is not spwCount or (count of spwUnread) is not spwCount then error "\(mailboxesChangedMarker)"
            repeat with spwI from 1 to spwCount
                set spwLocal to true
                if spwOwners is not missing value then set spwLocal to (item spwI of spwOwners is missing value)
                if spwLocal then
                    set spwPath to spwMailboxPath(spwI, spwBoxes, spwNames, spwParents)
                    set end of spwLines to spwAcctName & "||" & spwPath & "||" & (count of item spwI of spwIds) & "||" & (item spwI of spwUnread)
                end if
            end repeat
        end repeat
        set AppleScript's text item delimiters to linefeed
        return spwLines as text
        \(mailboxPathHandler)
        """

    /// An AppleScript handler, placed after a script's statements, giving the path inside its account of mailbox
    /// `spwI` of the bulk-read lists: every container that `is` another listed mailbox puts that one's name in front.
    private static let mailboxPathHandler = """
        on spwMailboxPath(spwI, spwBoxes, spwNames, spwParents)
            set spwCount to count of spwBoxes
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
            return spwPath
        end spwMailboxPath
        """

    static func listMailboxes(scripts: MailScripts) throws -> [[String: Any]] {
        return parseMailboxes(try scripts.run(listMailboxesScript))
    }

    /// Mailbox rows with `message_count` and `unread_count` as numbers; a count that is not an integer is left out.
    static func parseMailboxes(_ output: String) -> [[String: Any]] {
        parseDelimited(output, fields: ["account", "name", "message_count", "unread_count"]).map { row in
            var typed = row
            for count in ["message_count", "unread_count"] {
                typed[count] = (row[count] as? String).flatMap { Int($0) }
            }
            return typed
        }
    }

    /// The newest-first page `offset..<offset+limit` of the messages `filter` keeps in `mailbox`, or without one in
    /// every mailbox of `account` (every account and On My Mac without either) but its Trash and Junk, and the total
    /// the page is cut from.
    static func listEmails(
        scripts: MailScripts,
        mailbox: String?,
        account: String?,
        filter: MessageFilter,
        offset: Int,
        limit: Int
    ) throws -> [String: Any] {
        let messages: [ListedMessage]
        if let mailbox {
            let script = listEmailsScript(mailbox: mailbox, account: account, filter: filter)
            messages = try parseListing(try scripts.run(script, mailbox: mailbox, account: account), mailbox: mailbox)
        } else {
            let script = searchAllMailboxesScript(account: account, filter: filter)
            messages = try parseAllMailboxes(try scripts.run(script, account: account))
        }
        let sorted = newestFirst(messages)
        let page = sorted.dropFirst(offset).prefix(limit)
        return ["emails": page.map(\.json), "total": sorted.count]
    }

    /// Reads each property of every message `filter` keeps with one Apple Event; prints the account name, then one
    /// field per property (the flag as Mail's `flag index`, -1 when unflagged), items joined by `listItemSeparator` and fields by `listFieldSeparator`. A body search adds
    /// a last field with the Message-IDs whose content matched.
    static func listEmailsScript(mailbox: String, account: String?, filter: MessageFilter) -> String {
        let bodyRead = filter.bodyScope.map { "\n    set spwBodyIds to message id of \($0)" } ?? ""
        let bodyField = filter.bodyScope == nil ? "" : ", spwBodyIds as text"
        return """
        \(filter.setup)tell application "Mail"
        \(mailboxLookup(name: mailbox, account: account))
        \(propertyReads(filter.propertyScope(of: "mb")))\(bodyRead)
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
        set spwFields to {spwAcctName, spwIds as text, spwSubjects as text, spwSenders as text, spwIsoDates as text, spwReads as text, spwFlags as text\(bodyField)}
        set AppleScript's text item delimiters to (character id 29)
        return spwFields as text
        """
    }

    /// AppleScript lines that read each listed property of the messages `scope` names with one Apple Event each.
    private static func propertyReads(_ scope: String) -> String {
        """
            set spwIds to message id of \(scope)
            set spwSubjects to subject of \(scope)
            set spwSenders to sender of \(scope)
            set spwDates to date received of \(scope)
            set spwReads to read status of \(scope)
            set spwFlags to flag index of \(scope)
        """
    }

    /// Reads each property of the messages `filter` keeps in every mailbox of an account with one Apple Event,
    /// which answers one list per mailbox; prints one section per mailbox that has any, `mailboxSeparator` between
    /// them, each the account, the mailbox path and the fields of a `listEmailsScript` output. The account's Trash
    /// and Junk are found as `accountSpecialLookup` finds them and left out.
    static func searchAllMailboxesScript(account: String?, filter: MessageFilter) -> String {
        var reads = ""
        if account != localAccountName {
            var accounts = "accounts"
            if let account {
                let accountEsc = escapeAppleScript(account)
                accounts = "{account \"\(accountEsc)\"}"
                reads += "    if not (exists account \"\(accountEsc)\") then error \"\(accountNotFoundMarker)\"\n"
            }
            reads += """
                repeat with spwAcctRef in \(accounts)
                    set spwAcct to contents of spwAcctRef
                    set spwAcctName to name of spwAcct
            \(accountSpecialLookup("trash mailbox", into: "spwTrash"))
            \(accountSpecialLookup("junk mailbox", into: "spwJunk"))
                    set spwBoxes to every mailbox of spwAcct
                    set spwNames to name of every mailbox of spwAcct
                    set spwParents to container of every mailbox of spwAcct
            \(propertyReads(filter.propertyScope(of: "every mailbox of spwAcct")))
                    set end of spwScopes to {spwAcctName, spwBoxes, spwNames, spwParents, missing value, spwTrash, spwJunk, {spwIds, spwSubjects, spwSenders, spwDates, spwReads, spwFlags}}
                end repeat

            """
        }
        if account == nil || account == localAccountName {
            reads += """
                set spwAcctName to "\(escapeAppleScript(localAccountName))"
            \(accountSpecialLookup("trash mailbox", into: "spwTrash"))
            \(accountSpecialLookup("junk mailbox", into: "spwJunk"))
                set spwBoxes to every mailbox
                set spwNames to name of every mailbox
                set spwParents to container of every mailbox
                set spwOwners to account of every mailbox
            \(propertyReads(filter.propertyScope(of: "every mailbox")))
                set end of spwScopes to {spwAcctName, spwBoxes, spwNames, spwParents, spwOwners, spwTrash, spwJunk, {spwIds, spwSubjects, spwSenders, spwDates, spwReads, spwFlags}}

            """
        }
        return """
        \(filter.setup)tell application "Mail"
            set spwScopes to {}
        \(reads)end tell
        set spwSections to {}
        repeat with spwScopeRef in spwScopes
            set spwScope to contents of spwScopeRef
            set spwAcctName to item 1 of spwScope
            set spwBoxes to item 2 of spwScope
            set spwNames to item 3 of spwScope
            set spwParents to item 4 of spwScope
            set spwOwners to item 5 of spwScope
            set spwTrash to item 6 of spwScope
            set spwJunk to item 7 of spwScope
            set spwColumns to item 8 of spwScope
            set spwCount to count of spwBoxes
            if (count of spwNames) is not spwCount or (count of spwParents) is not spwCount then error "\(mailboxesChangedMarker)"
            if spwOwners is not missing value then
                if (count of spwOwners) is not spwCount then error "\(mailboxesChangedMarker)"
            end if
            repeat with spwC from 1 to 6
                set spwColumn to item spwC of spwColumns
                if (count of spwColumn) is not spwCount then error "\(mailboxesChangedMarker)"
            end repeat
            repeat with spwI from 1 to spwCount
                set spwBox to item spwI of spwBoxes
                set spwMessageIds to item spwI of item 1 of spwColumns
                set spwKeep to (count of spwMessageIds) > 0
                if spwOwners is not missing value then
                    if item spwI of spwOwners is not missing value then set spwKeep to false
                end if
                if spwBox is spwTrash or spwBox is spwJunk then set spwKeep to false
                if spwKeep then
                    set spwIsoDates to {}
                    repeat with spwDateRef in item spwI of item 4 of spwColumns
                        set spwDate to contents of spwDateRef
                        if class of spwDate is date then
                            set end of spwIsoDates to (spwDate as «class isot» as string)
                        else
                            set end of spwIsoDates to ""
                        end if
                    end repeat
                    set AppleScript's text item delimiters to (character id 30)
                    set spwPath to spwMailboxPath(spwI, spwBoxes, spwNames, spwParents)
                    set spwFields to {spwAcctName, spwPath}
                    repeat with spwC from 1 to 6
                        if spwC is 4 then
                            set spwText to spwIsoDates as text
                        else
                            set spwColumn to item spwI of item spwC of spwColumns
                            set spwText to spwColumn as text
                        end if
                        set end of spwFields to spwText
                    end repeat
                    set AppleScript's text item delimiters to (character id 29)
                    set end of spwSections to (spwFields as text)
                end if
            end repeat
        end repeat
        set AppleScript's text item delimiters to (character id 28)
        return spwSections as text
        \(mailboxPathHandler)
        """
    }

    /// The messages of a `searchAllMailboxesScript` output, each with the mailbox its section names.
    static func parseAllMailboxes(_ output: String) throws -> [ListedMessage] {
        guard !output.isEmpty else { return [] }
        return try output.components(separatedBy: mailboxSeparator).flatMap { section in
            var fields = section.components(separatedBy: listFieldSeparator)
            guard fields.count == 8 else {
                throw ScriptError.scriptFailed("Unexpected message list from Mail.app")
            }
            let mailbox = fields.remove(at: 1)
            return try parseListing(fields.joined(separator: listFieldSeparator), mailbox: mailbox)
        }
    }

    /// The messages of a `listEmailsScript` output, only those a body search matched when it carries their ids;
    /// fields of unequal length mean Mail changed the mailbox mid-read.
    static func parseListing(_ output: String, mailbox: String) throws -> [ListedMessage] {
        var fields = output.components(separatedBy: listFieldSeparator)
        guard fields.count == 7 || fields.count == 8 else {
            throw ScriptError.scriptFailed("Unexpected message list from Mail.app")
        }
        let matched = fields.count == 8 ? Set(fields.removeLast().components(separatedBy: listItemSeparator)) : nil
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
                read: columns[4][i] == "true",
                flag: flagName(columns[5][i])
            )
        }
    }

    /// The `mailFlagColors` name of a Mail `flag index`, or `none` for -1 and any index outside the colors.
    static func flagName(_ index: String) -> String {
        Int(index).flatMap { mailFlagColors.indices.contains($0) ? mailFlagColors[$0] : nil } ?? "none"
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
