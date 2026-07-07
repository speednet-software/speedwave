import Foundation
import SharedCLI

/// Microsoft Outlook for Mac automation via AppleScript.
enum OutlookClient {
    static let name = "Microsoft Outlook"

    /// One `make new <kind> recipient...` AppleScript line per comma-separated address.
    static func recipientClauses(_ addresses: String, kind: String) -> String {
        splitAddressList(addresses)
            .map { addr in
                "        make new \(kind) recipient at end of \(kind) recipients with properties {email address:{address:\"\(escapeAppleScript(addr))\"}}"
            }
            .joined(separator: "\n")
    }

    /// Whether the Outlook process is running. Rethrows `.automationPermission`/`.timeout`;
    /// a genuine script failure maps to `false`.
    static func isAvailable() throws -> Bool {
        let script = """
        tell application "System Events"
            return exists application process "Microsoft Outlook"
        end tell
        """
        do {
            return try ScriptRunner.run(script, timeout: 5) == "true"
        } catch let err as ScriptError {
            switch err {
            case .automationPermission, .timeout:
                throw err
            case .scriptFailed:
                return false
            }
        }
    }

    static func listMailboxes() throws -> [[String: Any]] {
        let script = """
        tell application "Microsoft Outlook"
            set output to ""
            repeat with acct in exchange accounts
                set acctName to name of acct
                repeat with f in mail folders of acct
                    set fName to name of f
                    set msgCount to count of messages of f
                    set output to output & acctName & "||" & fName & "||" & msgCount & linefeed
                end repeat
            end repeat
            return output
        end tell
        """

        let output = try ScriptRunner.run(script, timeout: 15)
        return parseDelimited(output, fields: ["account", "name", "message_count"])
    }

    static func listEmails(limit: Int, mailbox: String?) throws -> [[String: Any]] {
        let folderClause: String
        if let mb = mailbox {
            folderClause = "mail folder \"\(escapeAppleScript(mb))\""
        } else {
            folderClause = "inbox"
        }

        // Counter loop avoids "Invalid index" error (-1719) past message count.
        let script = """
        tell application "Microsoft Outlook"
            set output to ""
            set allMsgs to messages of \(folderClause)
            set msgCount to count of allMsgs
            if msgCount > \(limit) then set msgCount to \(limit)
            repeat with i from 1 to msgCount
                set m to item i of allMsgs
                set msgId to id of m as string
                set subj to subject of m
                set sndr to (address of sender of m) as string
                set rcvd to time received of m as string
                set isRead to is read of m
                set output to output & msgId & "||" & subj & "||" & sndr & "||" & rcvd & "||" & isRead & linefeed
            end repeat
            return output
        end tell
        """

        let output = try ScriptRunner.run(script, timeout: 30)
        return parseDelimited(output, fields: ["id", "subject", "sender", "date", "read"])
    }

    static func getEmail(id: String) throws -> [String: Any] {
        let idEsc = escapeAppleScript(id)
        let script = """
        tell application "Microsoft Outlook"
            set m to message id "\(idEsc)"
            set subj to subject of m
            set sndr to (address of sender of m) as string
            set rcvd to time received of m as string
            set bod to plain text content of m
            set isRead to is read of m
            set toList to ""
            repeat with r in to recipients of m
                set toList to toList & (address of r) as string & ","
            end repeat
            return subj & "||" & sndr & "||" & rcvd & "||" & isRead & "||" & toList & "||" & bod
        end tell
        """

        let output = try ScriptRunner.run(script, timeout: 15)
        return try parseEmailDetail(output, id: id)
    }

    static func searchEmails(query: String, limit: Int) throws -> [[String: Any]] {
        let queryEsc = escapeAppleScript(query)
        let script = """
        tell application "Microsoft Outlook"
            set output to ""
            set msgCount to 0
            set msgs to (every message of inbox whose subject contains "\(queryEsc)" or content contains "\(queryEsc)")
            repeat with m in msgs
                if msgCount < \(limit) then
                    set msgId to id of m as string
                    set subj to subject of m
                    set sndr to (address of sender of m) as string
                    set rcvd to time received of m as string
                    set output to output & msgId & "||" & subj & "||" & sndr & "||" & rcvd & linefeed
                    set msgCount to msgCount + 1
                end if
            end repeat
            return output
        end tell
        """

        let output = try ScriptRunner.run(script, timeout: 30)
        return parseDelimited(output, fields: ["id", "subject", "sender", "date"])
    }

    static func sendEmail(to: String, subject: String, body: String, cc: String?, bcc: String? = nil) throws -> [String: Any] {
        let subjectEsc = escapeAppleScript(subject)
        let bodyEsc = escapeAppleScript(body)

        let toClause = recipientClauses(to, kind: "to")
        let ccClause = cc.map { recipientClauses($0, kind: "cc") } ?? ""
        let bccClause = bcc.map { recipientClauses($0, kind: "bcc") } ?? ""

        let script = """
        tell application "Microsoft Outlook"
            set newMsg to make new outgoing message with properties {subject:"\(subjectEsc)", plain text content:"\(bodyEsc)"}
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

        let script = """
        tell application "Microsoft Outlook"
            set m to message id "\(idEsc)"
            set replyMsg to \(replyAll ? "reply all" : "reply") m
            set plain text content of replyMsg to "\(bodyEsc)" & return & return & plain text content of replyMsg
            send replyMsg
        end tell
        """

        _ = try ScriptRunner.run(script, timeout: 15)
        return ["status": "sent"]
    }
}
