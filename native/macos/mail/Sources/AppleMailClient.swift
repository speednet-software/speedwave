import Foundation
import SharedCLI

/// Apple Mail.app automation via AppleScript.
enum AppleMailClient {
    static let name = "Apple Mail"

    /// One `make new <kind> recipient...` AppleScript line per comma-separated address.
    static func recipientClauses(_ addresses: String, kind: String) -> String {
        splitAddressList(addresses)
            .map { addr in
                "        make new \(kind) recipient at end of \(kind) recipients "
                    + "with properties {address:\"\(escapeAppleScript(addr))\"}"
            }
            .joined(separator: "\n")
    }

    /// AppleScript lines, run inside `tell application "Mail"`, that set `mb` to the mailbox named `name`
    /// in `account` or in any account (an app-level `mailbox "X"` reaches only On My Mac), or to the inbox.
    static func mailboxLookup(name: String?, account: String?) -> String {
        guard let name = name else { return "set mb to inbox" }
        let nameEsc = escapeAppleScript(name)
        var accounts = "accounts"
        var accountCheck = ""
        if let account = account {
            let accountEsc = escapeAppleScript(account)
            accounts = "{account \"\(accountEsc)\"}"
            accountCheck = "    if not (exists account \"\(accountEsc)\") then error \"\(accountNotFoundMarker)\"\n"
        }
        return accountCheck + """
            set spwMatches to {}
            set spwAccounts to ""
            repeat with spwAcctRef in \(accounts)
                set spwAcct to contents of spwAcctRef
                if exists mailbox "\(nameEsc)" of spwAcct then
                    set end of spwMatches to mailbox "\(nameEsc)" of spwAcct
                    set spwAccounts to spwAccounts & name of spwAcct & ", "
                end if
            end repeat
            if (count of spwMatches) is 0 then error "\(mailboxNotFoundMarker)"
            if (count of spwMatches) > 1 then error "\(mailboxAmbiguousMarker)" & spwAccounts
            set mb to item 1 of spwMatches
        """
    }

    /// Lists every mailbox with `name` as its path inside the account (`Inbox/Clients`), the form
    /// `mailbox "<path>" of account` resolves; Mail reports a nested mailbox by its last segment only.
    static let listMailboxesScript = """
        tell application "Mail"
            set output to ""
            repeat with acctRef in accounts
                set acct to contents of acctRef
                set acctName to name of acct
                repeat with mbRef in mailboxes of acct
                    set mb to contents of mbRef
                    set mbName to name of mb
                    set parentBox to container of mb
                    repeat while class of parentBox is mailbox
                        set mbName to name of parentBox & "/" & mbName
                        set parentBox to container of parentBox
                    end repeat
                    set msgCount to count of messages of mb
                    set output to output & acctName & "||" & mbName & "||" & msgCount & linefeed
                end repeat
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

    static func listEmails(scripts: MailScripts, limit: Int, mailbox: String?, account: String?) throws -> [[String: Any]] {
        let script = """
        tell application "Mail"
        \(mailboxLookup(name: mailbox, account: account))
            set output to ""
            set msgCount to count of messages of mb
            if msgCount > \(limit) then set msgCount to \(limit)
            repeat with i from 1 to msgCount
                set m to message i of mb
                set msgId to message id of m
                set subj to subject of m
                set sndr to sender of m
                set rcvd to date received of m as string
                set isRead to read status of m
                set output to output & msgId & "||" & subj & "||" & sndr & "||" & rcvd & "||" & isRead & linefeed
            end repeat
            return output
        end tell
        """

        let output = try scripts.run(script, mailbox: mailbox, account: account)
        return parseMessageList(output)
    }

    /// Message rows with `read` as a boolean.
    static func parseMessageList(_ output: String) -> [[String: Any]] {
        parseDelimited(output, fields: ["id", "subject", "sender", "date", "read"]).map { row in
            var typed = row
            typed["read"] = (row["read"] as? String) == "true"
            return typed
        }
    }

    static func getEmail(scripts: MailScripts, id: String) throws -> [String: Any] {
        let idEsc = escapeAppleScript(id)
        let script = """
        tell application "Mail"
            set msgs to (every message of inbox whose message id is "\(idEsc)")
            if (count of msgs) is 0 then
                error "Email not found"
            end if
            set m to item 1 of msgs
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

        let output = try scripts.run(script)
        return try parseEmailDetail(output, id: id)
    }

    static func searchEmails(scripts: MailScripts, query: String, limit: Int, mailbox: String?, account: String?) throws -> [[String: Any]] {
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
            return output
        end tell
        """

        let output = try scripts.run(script, mailbox: mailbox, account: account)
        return parseDelimited(output, fields: ["id", "subject", "sender", "date"])
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
        let idEsc = escapeAppleScript(id)
        let bodyEsc = escapeAppleScript(body)
        let replyType = replyAll ? "reply with properties {reply all:true}" : "reply"

        let script = """
        tell application "Mail"
            set msgs to (every message of inbox whose message id is "\(idEsc)")
            if (count of msgs) is 0 then
                error "Email not found"
            end if
            set m to item 1 of msgs
            set replyMsg to \(replyType) m
            tell replyMsg
                set content to "\(bodyEsc)" & content
            end tell
            send replyMsg
        end tell
        """

        _ = try scripts.run(script)
        return ["status": "sent"]
    }
}
