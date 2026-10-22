import Foundation
import SharedCLI

/// Apple Mail.app automation via AppleScript.
enum AppleMailClient {
    static let name = "Apple Mail"

    /// The account name `listMailboxes` gives the On My Mac mailboxes, which belong to no account.
    static let localAccountName = "On My Mac"

    private static let listFieldSeparator = "\u{1D}"
    private static let listItemSeparator = "\u{1E}"
    private static let mailboxSeparator = "\u{1C}"
    private static let mailboxFieldSeparator = "\u{1F}"

    /// One message of a listing, before paging.
    struct ListedMessage {
        let id: MailId
        let subject: String
        let sender: String
        let received: Date?
        let read: Bool
        let flag: String
        let attachmentCount: Int

        var json: [String: Any] {
            var row: [String: Any] = [
                "id": id.encoded,
                "subject": subject,
                "sender": sender,
                "read": read,
                "flag": flag,
                "attachment_count": attachmentCount,
                "mailbox": id.mailbox,
                "account": id.account,
            ]
            row["date"] = received.map { iso8601String(from: $0, timeZone: .current) }
            return row
        }
    }

    /// The messages of a listing, and how many it left out for having no Message-ID, which no mail id can name.
    private struct Listing {
        let messages: [ListedMessage]
        let withoutId: Int
    }

    /// Which messages a listing reads, as one `whose` clause; a recipient matches a To or Cc address, a query the
    /// subject or the sender, and with `searchBody` also the content, in a separate request.
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

    /// One message property a listing reads with one Apple Event, and the handler that turns Mail's answer into
    /// text items when it is not text already.
    private struct ListedColumn {
        let variable: String
        let read: String
        var nested = false
        var toText: String?

        func reading(_ scope: String) -> String {
            "    set \(variable) to \(read) \(nested ? "(\(scope))" : scope)"
        }
    }

    /// The columns of a listing in output order.
    private static let listedColumns = [
        ListedColumn(variable: "spwIds", read: "message id of", toText: "spwTexts"),
        ListedColumn(variable: "spwSubjects", read: "subject of", toText: "spwTexts"),
        ListedColumn(variable: "spwSenders", read: "sender of", toText: "spwTexts"),
        ListedColumn(variable: "spwDates", read: "date received of", toText: "spwIsoTexts"),
        ListedColumn(variable: "spwReads", read: "read status of"),
        ListedColumn(variable: "spwFlags", read: "flag index of"),
        ListedColumn(variable: "spwAttachments", read: "name of mail attachments of", nested: true, toText: "spwCounts"),
    ]

    /// The AppleScript line that fails with `accountNotFoundMarker` unless Mail has the account `account`.
    static func accountExistsCheck(_ account: String) -> String {
        "if not (exists account \"\(escapeAppleScript(account))\") then error \"\(accountNotFoundMarker)\""
    }

    /// The AppleScript specifier of the mailbox path `path` in `account`; app-level for `localAccountName`.
    static func mailboxSpecifier(_ path: String, account: String) -> String {
        let mailbox = "mailbox \"\(escapeAppleScript(path))\""
        return account == localAccountName ? mailbox : "\(mailbox) of account \"\(escapeAppleScript(account))\""
    }

    /// AppleScript lines, run inside `tell application "Mail"`, that set `mb` to the mailbox named `name` in
    /// `account`, or in the one account or On My Mac that has it, and `spwAcctName` to that account's name.
    /// An app-level `mailbox "X"` reaches only On My Mac, so an account mailbox is always `mailbox "X" of account`.
    static func mailboxLookup(name: String, account: String?) -> String {
        let nameEsc = escapeAppleScript(name)
        let localEsc = escapeAppleScript(localAccountName)
        if account == localAccountName {
            let local = mailboxSpecifier(name, account: localAccountName)
            return """
                if not (exists \(local)) then error "\(mailboxNotFoundMarker)"
                set mb to \(local)
                set spwAcctName to "\(localEsc)"
            """
        }
        var accounts = "accounts"
        var accountCheck = ""
        var localCheck = ""
        if let account = account {
            accounts = "{account \"\(escapeAppleScript(account))\"}"
            accountCheck = "    \(accountExistsCheck(account))\n"
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

    /// Lists every mailbox of every account, then the On My Mac mailboxes under `localAccountName`, each `name`
    /// being its path inside the account (`Inbox/Clients`), with its message and unread counts.
    private static let listMailboxesScript = """
        tell application "Mail"
            set spwScopes to {}
            repeat with spwAcctRef in accounts
                set spwAcct to contents of spwAcctRef
                set spwAcctName to name of spwAcct
        \(mailboxReads(of: "spwAcct"))
                set spwIds to id of every message of every mailbox of spwAcct
                set spwUnread to unread count of every mailbox of spwAcct
                set end of spwScopes to {spwAcctName, spwBoxes, spwNames, spwParents, spwIds, spwUnread, missing value}
            end repeat
        \(mailboxReads(of: nil))
            set spwIds to id of every message of every mailbox
            set spwUnread to unread count of every mailbox
            set spwOwners to account of every mailbox
            set end of spwScopes to {"\(escapeAppleScript(localAccountName))", spwBoxes, spwNames, spwParents, spwIds, spwUnread, spwOwners}
        end tell
        set spwLines to {}
        repeat with spwScopeRef in spwScopes
            set spwScope to contents of spwScopeRef
            set spwBoxes to item 2 of spwScope
            set spwCount to count of spwBoxes
            if (count of item 3 of spwScope) is not spwCount or (count of item 4 of spwScope) is not spwCount or (count of item 5 of spwScope) is not spwCount or (count of item 6 of spwScope) is not spwCount then error "\(mailboxesChangedMarker)"
            set spwOwners to item 7 of spwScope
            if spwOwners is not missing value then
                if (count of spwOwners) is not spwCount then error "\(mailboxesChangedMarker)"
            end if
            set spwPaths to my spwMailboxPaths(spwBoxes, my spwTexts(item 3 of spwScope), item 4 of spwScope)
            set spwLines to spwLines & my spwMailboxRows(my spwClean(item 1 of spwScope), spwPaths, my spwCounts(item 5 of spwScope), item 6 of spwScope, spwOwners)
        end repeat
        set AppleScript's text item delimiters to (character id 30)
        return spwLines as text
        on spwMailboxRows(spwAcctName, spwPaths, spwMessageCounts, spwUnread, spwOwners)
            script spwO
                property spwP : spwPaths
                property spwC : spwMessageCounts
                property spwU : spwUnread
                property spwW : spwOwners
                property spwR : {}
            end script
            set spwOld to AppleScript's text item delimiters
            set AppleScript's text item delimiters to (character id 31)
            repeat with spwI from 1 to count of spwO's spwP
                set spwLocal to true
                if spwOwners is not missing value then set spwLocal to (item spwI of spwO's spwW is missing value)
                if spwLocal then
                    set spwRow to {spwAcctName, (item spwI of spwO's spwP) as text, (item spwI of spwO's spwC) as text, (item spwI of spwO's spwU) as text}
                    set end of spwO's spwR to (spwRow as text)
                end if
            end repeat
            set AppleScript's text item delimiters to spwOld
            return spwO's spwR
        end spwMailboxRows
        \(mailboxPathsHandler)
        \(listingHandlers)
        """

    /// AppleScript lines that set `spwBoxes`, `spwNames` and `spwParents` to every mailbox of `owner` (the
    /// application without one), its name and its container.
    private static func mailboxReads(of owner: String?) -> String {
        let mailboxes = "every mailbox" + (owner.map { " of \($0)" } ?? "")
        return """
                set spwBoxes to \(mailboxes)
                set spwNames to name of \(mailboxes)
                set spwParents to container of \(mailboxes)
            """
    }

    /// An AppleScript handler giving the path inside its account of every mailbox of the bulk-read lists: a
    /// mailbox whose container `is` another listed mailbox gets that one's path in front. The lists sit in a script
    /// object, since AppleScript reads `item i` of a list held in a variable in time proportional to `i`.
    private static let mailboxPathsHandler = """
        on spwMailboxPaths(spwBoxes, spwNames, spwParents)
            script spwO
                property spwB : spwBoxes
                property spwN : spwNames
                property spwP : spwParents
                property spwUp : {}
                property spwR : {}
            end script
            set spwCount to count of spwO's spwB
            repeat with spwI from 1 to spwCount
                set spwParent to item spwI of spwO's spwP
                set spwJ to 0
                repeat with spwK from 1 to spwCount
                    if item spwK of spwO's spwB is spwParent then
                        set spwJ to spwK
                        exit repeat
                    end if
                end repeat
                set end of spwO's spwUp to spwJ
            end repeat
            repeat with spwI from 1 to spwCount
                set spwPath to (item spwI of spwO's spwN) as text
                set spwJ to item spwI of spwO's spwUp
                set spwSteps to 0
                repeat while spwJ is not 0 and spwSteps < spwCount
                    set spwPath to ((item spwJ of spwO's spwN) as text) & "/" & spwPath
                    set spwJ to item spwJ of spwO's spwUp
                    set spwSteps to spwSteps + 1
                end repeat
                set end of spwO's spwR to spwPath
            end repeat
            return spwO's spwR
        end spwMailboxPaths
        """

    static func listMailboxes(scripts: MailScripts) throws -> [[String: Any]] {
        return parseMailboxes(try scripts.run(listMailboxesScript))
    }

    /// Mailbox rows, one per RS-separated record of US-separated fields, with `message_count` and `unread_count`
    /// as numbers; a count that is not an integer is left out, a record of another shape is dropped.
    static func parseMailboxes(_ output: String) -> [[String: Any]] {
        guard !output.isEmpty else { return [] }
        return output.components(separatedBy: listItemSeparator).compactMap { record in
            let fields = record.components(separatedBy: mailboxFieldSeparator)
            guard fields.count == 4 else { return nil }
            var row: [String: Any] = ["account": fields[0], "name": fields[1]]
            row["message_count"] = Int(fields[2])
            row["unread_count"] = Int(fields[3])
            return row
        }
    }

    /// The newest-first page `offset..<offset+limit` of the messages `filter` keeps in `mailbox`, or else in every
    /// mailbox of `account` (of all accounts) but its Trash and Junk, and the total the page is cut from.
    static func listEmails(
        scripts: MailScripts,
        mailbox: String?,
        account: String?,
        filter: MessageFilter,
        offset: Int,
        limit: Int
    ) throws -> [String: Any] {
        let listing: Listing
        if let mailbox {
            let script = listEmailsScript(mailbox: mailbox, account: account, filter: filter)
            listing = try parseListing(try scripts.run(script, mailbox: mailbox, account: account), mailbox: mailbox)
        } else {
            let script = searchAllMailboxesScript(account: account, filter: filter)
            listing = try parseAllMailboxes(try scripts.run(script, account: account))
        }
        let sorted = newestFirst(listing.messages)
        let page = sorted.dropFirst(offset).prefix(limit)
        var result: [String: Any] = ["emails": page.map(\.json), "total": sorted.count]
        if listing.withoutId > 0 {
            result["without_id"] = listing.withoutId
        }
        return result
    }

    /// Reads each listed column of every message `filter` keeps in one mailbox, one Apple Event per column; prints
    /// the account, then the columns, and for a body search the Message-IDs whose content matched.
    private static func listEmailsScript(mailbox: String, account: String?, filter: MessageFilter) -> String {
        let bodyRead = filter.bodyScope.map { "\n    set spwBodyIds to message id of \($0)" } ?? ""
        let fields = ["my spwClean(spwAcctName)"] + listedColumns.map { "\($0.variable) as text" }
            + (filter.bodyScope == nil ? [] : ["spwBodyIds as text"])
        let toText = listedColumns.compactMap { column in
            column.toText.map { "set \(column.variable) to my \($0)(\(column.variable))" }
        } + (filter.bodyScope == nil ? [] : ["set spwBodyIds to my spwTexts(spwBodyIds)"])
        return """
        \(filter.setup)tell application "Mail"
        \(mailboxLookup(name: mailbox, account: account))
        \(propertyReads(filter.propertyScope(of: "mb")))\(bodyRead)
        end tell
        \(toText.joined(separator: "\n"))
        set AppleScript's text item delimiters to (character id 30)
        set spwFields to {\(fields.joined(separator: ", "))}
        set AppleScript's text item delimiters to (character id 29)
        return spwFields as text
        \(listingHandlers)
        """
    }

    /// AppleScript lines that read each listed column of the messages `scope` names.
    private static func propertyReads(_ scope: String) -> String {
        listedColumns.map { $0.reading(scope) }.joined(separator: "\n")
    }

    /// The AppleScript handlers named by `ListedColumn.toText`, placed after a script's statements.
    /// Every handler keeps its lists in a script object, since AppleScript reads `item i` of a list held in a
    /// variable, and appends to one, in time proportional to its length.
    private static let listingHandlers = MailReading.cleanHandler + """

        on spwTexts(spwList)
            script spwO
                property spwS : spwList
                property spwR : {}
            end script
            repeat with spwI from 1 to count of spwO's spwS
                set spwItem to item spwI of spwO's spwS
                if spwItem is missing value then
                    set end of spwO's spwR to ""
                else
                    set end of spwO's spwR to (spwItem as text)
                end if
            end repeat
            set spwOld to AppleScript's text item delimiters
            set AppleScript's text item delimiters to ""
            set spwAll to spwO's spwR as text
            set AppleScript's text item delimiters to spwOld
            if spwAll contains (character id 28) or spwAll contains (character id 29) or spwAll contains (character id 30) or spwAll contains (character id 31) then
                repeat with spwI from 1 to count of spwO's spwR
                    set item spwI of spwO's spwR to my spwClean(item spwI of spwO's spwR)
                end repeat
            end if
            return spwO's spwR
        end spwTexts
        on spwCounts(spwLists)
            script spwO
                property spwS : spwLists
                property spwR : {}
            end script
            repeat with spwI from 1 to count of spwO's spwS
                set spwList to item spwI of spwO's spwS
                if class of spwList is list then
                    set end of spwO's spwR to (count of spwList)
                else
                    set end of spwO's spwR to 0
                end if
            end repeat
            return spwO's spwR
        end spwCounts
        on spwIsoTexts(spwDates)
            script spwO
                property spwS : spwDates
                property spwR : {}
            end script
            repeat with spwI from 1 to count of spwO's spwS
                set spwDate to item spwI of spwO's spwS
                if class of spwDate is date then
                    set end of spwO's spwR to (spwDate as «class isot» as string)
                else
                    set end of spwO's spwR to ""
                end if
            end repeat
            return spwO's spwR
        end spwIsoTexts
        """

    /// Reads each listed column of the messages `filter` keeps in every mailbox of `account` (of all accounts) but
    /// its Trash and Junk; prints one section per mailbox with hits: the account, the path and the columns.
    private static func searchAllMailboxesScript(account: String?, filter: MessageFilter) -> String {
        let columns = "{" + listedColumns.map(\.variable).joined(separator: ", ") + "}"
        var reads = ""
        if account != localAccountName {
            var accounts = "accounts"
            if let account {
                accounts = "{account \"\(escapeAppleScript(account))\"}"
                reads += "    \(accountExistsCheck(account))\n"
            }
            reads += """
                repeat with spwAcctRef in \(accounts)
                    set spwAcct to contents of spwAcctRef
                    set spwAcctName to name of spwAcct
            \(accountSpecialLookup("trash mailbox", into: "spwTrash"))
            \(accountSpecialLookup("junk mailbox", into: "spwJunk"))
            \(mailboxReads(of: "spwAcct"))
            \(propertyReads(filter.propertyScope(of: "every mailbox of spwAcct")))
                    set end of spwScopes to {spwAcctName, spwBoxes, spwNames, spwParents, missing value, spwTrash, spwJunk, \(columns)}
                end repeat

            """
        }
        if account == nil || account == localAccountName {
            reads += """
                set spwAcctName to "\(escapeAppleScript(localAccountName))"
            \(accountSpecialLookup("trash mailbox", into: "spwTrash"))
            \(accountSpecialLookup("junk mailbox", into: "spwJunk"))
            \(mailboxReads(of: nil))
                set spwOwners to account of every mailbox
            \(propertyReads(filter.propertyScope(of: "every mailbox")))
                set end of spwScopes to {spwAcctName, spwBoxes, spwNames, spwParents, spwOwners, spwTrash, spwJunk, \(columns)}

            """
        }
        let sectionColumns = listedColumns.enumerated().map { index, column in
            let toText = column.toText.map { "\n                set spwColumn to my \($0)(spwColumn)" } ?? ""
            return """
                            set spwColumn to item spwI of item \(index + 1) of spwO's spwC\(toText)
                            set end of spwFields to (spwColumn as text)
                """
        }.joined(separator: "\n")
        return """
        \(filter.setup)tell application "Mail"
            set spwScopes to {}
        \(reads)end tell
        set spwSections to {}
        repeat with spwScopeRef in spwScopes
            set spwScope to contents of spwScopeRef
            set spwCount to count of item 2 of spwScope
            if (count of item 3 of spwScope) is not spwCount or (count of item 4 of spwScope) is not spwCount then error "\(mailboxesChangedMarker)"
            if item 5 of spwScope is not missing value then
                if (count of item 5 of spwScope) is not spwCount then error "\(mailboxesChangedMarker)"
            end if
            set spwColumns to item 8 of spwScope
            if (count of spwColumns) is not \(listedColumns.count) then error "\(mailboxesChangedMarker)"
            repeat with spwColumnRef in spwColumns
                set spwColumn to contents of spwColumnRef
                if (count of spwColumn) is not spwCount then error "\(mailboxesChangedMarker)"
            end repeat
            set spwPaths to my spwMailboxPaths(item 2 of spwScope, my spwTexts(item 3 of spwScope), item 4 of spwScope)
            set spwSections to spwSections & my spwSectionsOf(my spwClean(item 1 of spwScope), item 2 of spwScope, spwPaths, item 5 of spwScope, item 6 of spwScope, item 7 of spwScope, spwColumns)
        end repeat
        set AppleScript's text item delimiters to (character id 28)
        return spwSections as text
        on spwSectionsOf(spwAcctName, spwBoxes, spwPaths, spwOwners, spwTrash, spwJunk, spwColumns)
            script spwO
                property spwB : spwBoxes
                property spwP : spwPaths
                property spwW : spwOwners
                property spwC : spwColumns
                property spwR : {}
            end script
            set spwOld to AppleScript's text item delimiters
            repeat with spwI from 1 to count of spwO's spwB
                set spwBox to item spwI of spwO's spwB
                set spwKeep to (count of item spwI of item 1 of spwO's spwC) > 0
                if spwOwners is not missing value then
                    if item spwI of spwO's spwW is not missing value then set spwKeep to false
                end if
                if spwBox is spwTrash or spwBox is spwJunk then set spwKeep to false
                if spwKeep then
                    set AppleScript's text item delimiters to (character id 30)
                    set spwFields to {spwAcctName, (item spwI of spwO's spwP) as text}
        \(sectionColumns)
                    set AppleScript's text item delimiters to (character id 29)
                    set end of spwO's spwR to (spwFields as text)
                end if
            end repeat
            set AppleScript's text item delimiters to spwOld
            return spwO's spwR
        end spwSectionsOf
        \(mailboxPathsHandler)
        \(listingHandlers)
        """
    }

    /// The messages of a `searchAllMailboxesScript` output, each with the mailbox its section names.
    private static func parseAllMailboxes(_ output: String) throws -> Listing {
        guard !output.isEmpty else { return Listing(messages: [], withoutId: 0) }
        let sections = try output.components(separatedBy: mailboxSeparator).map { section in
            var fields = section.components(separatedBy: listFieldSeparator)
            guard fields.count == 2 + listedColumns.count else {
                throw ScriptError.scriptFailed("Unexpected message list from Mail.app")
            }
            let mailbox = fields.remove(at: 1)
            return try parseListing(fields.joined(separator: listFieldSeparator), mailbox: mailbox)
        }
        return Listing(
            messages: sections.flatMap(\.messages), withoutId: sections.map(\.withoutId).reduce(0, +))
    }

    /// The messages of a `listEmailsScript` output, only those a body search matched when it carries their ids,
    /// and the number left out for having no Message-ID; fields of unequal length mean Mail changed the mailbox
    /// mid-read. The read-status column, never empty for a mail, gives the count.
    private static func parseListing(_ output: String, mailbox: String) throws -> Listing {
        var fields = output.components(separatedBy: listFieldSeparator)
        let columnCount = listedColumns.count
        guard fields.count == 1 + columnCount || fields.count == 2 + columnCount else {
            throw ScriptError.scriptFailed("Unexpected message list from Mail.app")
        }
        let matched = fields.count == 2 + columnCount ? Set(items(fields.removeLast())) : nil
        let count = items(fields[5]).count
        let columns = fields.dropFirst().map { field in
            count == 0 ? [] : field.components(separatedBy: listItemSeparator)
        }
        guard columns.allSatisfy({ $0.count == count }) else {
            throw MailFailure.mailboxChanged(mailbox: mailbox)
        }
        let account = fields[0]
        let addressable = (0..<count).filter { !columns[0][$0].isEmpty }
        let messages = addressable.filter { matched?.contains(columns[0][$0]) ?? true }.map { i in
            ListedMessage(
                id: MailId(account: account, mailbox: mailbox, messageId: columns[0][i]),
                subject: columns[1][i],
                sender: columns[2][i],
                received: localDate(columns[3][i]),
                read: columns[4][i] == "true",
                flag: flagName(columns[5][i]),
                attachmentCount: Int(columns[6][i]) ?? 0
            )
        }
        return Listing(messages: messages, withoutId: count - addressable.count)
    }

    /// The items of one listing field; an empty field has none.
    private static func items(_ field: String) -> [String] {
        field.isEmpty ? [] : field.components(separatedBy: listItemSeparator)
    }

    /// The `mailFlagColors` name of a Mail `flag index`, or `none` for -1 and any index outside the colors.
    static func flagName(_ index: String) -> String {
        Int(index).flatMap { mailFlagColors.indices.contains($0) ? mailFlagColors[$0] : nil } ?? "none"
    }

    /// Newest first; a message without a date goes last, and equal dates keep Mail's order.
    private static func newestFirst(_ messages: [ListedMessage]) -> [ListedMessage] {
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
