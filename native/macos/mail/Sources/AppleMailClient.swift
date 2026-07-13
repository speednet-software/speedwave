import Foundation
import SharedCLI

/// Apple Mail.app automation via AppleScript.
enum AppleMailClient {
    static let name = "Apple Mail"

    static func isAvailable() -> Bool {
        // Mail.app is always installed on macOS
        return true
    }

    /// One `make new <kind> recipient...` AppleScript line per comma-separated address.
    static func recipientClauses(_ addresses: String, kind: String) -> String {
        makeRecipientClauses(addresses, kind: kind) { "address:\"\($0)\"" }
    }

    /// True only when a probe confirms the mailbox is absent; a probe error returns false
    /// so an unrelated -1728 surfaces its real cause rather than a wrong mailbox message.
    static func mailboxDefinitelyMissing(_ name: String) -> Bool {
        let script = "tell application \"Mail\" to return (exists mailbox \"\(escapeAppleScript(name))\")"
        guard let out = try? ScriptRunner.run(script, timeout: 10) else { return false }
        return out == "false"
    }

    static func listMailboxes() throws -> [[String: Any]] {
        let script = """
        tell application "Mail"
            set output to ""
            repeat with acct in accounts
                set acctName to name of acct
                repeat with mb in mailboxes of acct
                    set mbName to name of mb
                    set msgCount to count of messages of mb
                    set output to output & acctName & "||" & mbName & "||" & msgCount & linefeed
                end repeat
            end repeat
            return output
        end tell
        """

        let output = try ScriptRunner.run(script, timeout: 15)
        return parseDelimited(output, fields: ["account", "name", "message_count"])
    }

    static func listEmails(limit: Int, mailbox: String?) throws -> [[String: Any]] {
        let mailboxClause: String
        if let mb = mailbox {
            mailboxClause = "mailbox \"\(escapeAppleScript(mb))\""
        } else {
            mailboxClause = "inbox"
        }

        // Access each message individually; Apple Mail has no bulk property fetch.
        let script = """
        tell application "Mail"
            set output to ""
            set msgCount to count of messages of \(mailboxClause)
            if msgCount > \(limit) then set msgCount to \(limit)
            repeat with i from 1 to msgCount
                set m to message i of \(mailboxClause)
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

        let output = try runMailScript(
            script, timeout: 30, mailbox: mailbox,
            mailboxMissing: { mailbox.map { Self.mailboxDefinitelyMissing($0) } ?? false }
        )
        return parseDelimited(output, fields: ["id", "subject", "sender", "date", "read"])
    }

    static func getEmail(id: String) throws -> [String: Any] {
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

        let output = try ScriptRunner.run(script, timeout: 15)
        return try parseEmailDetail(output, id: id)
    }

    static func searchEmails(query: String, limit: Int, mailbox: String?) throws -> [[String: Any]] {
        let queryEsc = escapeAppleScript(query)
        let sourceClause = mailbox.map { "mailbox \"\(escapeAppleScript($0))\"" } ?? "inbox"
        let script = """
        tell application "Mail"
            set output to ""
            set msgCount to 0
            set msgs to (every message of \(sourceClause) whose subject contains "\(queryEsc)" or content contains "\(queryEsc)")
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

        let output = try runMailScript(
            script, timeout: 30, mailbox: mailbox,
            mailboxMissing: { mailbox.map { Self.mailboxDefinitelyMissing($0) } ?? false }
        )
        return parseDelimited(output, fields: ["id", "subject", "sender", "date"])
    }

    static func sendEmail(to: String, subject: String, body: String, cc: String?, bcc: String? = nil) throws -> [String: Any] {
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

        _ = try ScriptRunner.run(script, timeout: 15)
        return ["status": "sent"]
    }

    static func replyToEmail(id: String, body: String, replyAll: Bool) throws -> [String: Any] {
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

        _ = try ScriptRunner.run(script, timeout: 15)
        return ["status": "sent"]
    }
}
