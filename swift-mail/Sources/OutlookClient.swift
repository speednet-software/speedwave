import Foundation

/// Microsoft Outlook for Mac automation via AppleScript.
enum OutlookClient {
    static let name = "Microsoft Outlook"

    static func isAvailable() -> Bool {
        let script = """
        tell application "System Events"
            return exists application process "Microsoft Outlook"
        end tell
        """
        let result = try? ScriptRunner.run(script, timeout: 5)
        return result == "true"
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

        let output = try ScriptRunner.run(script)
        return parseDelimited(output, fields: ["account", "name", "message_count"])
    }

    static func listEmails(limit: Int, mailbox: String?) throws -> [[String: Any]] {
        let folderClause: String
        if let mb = mailbox {
            folderClause = "mail folder \"\(escapeAppleScript(mb))\""
        } else {
            folderClause = "inbox"
        }

        // Iterate with counter to avoid "Invalid index" error (-1719)
        // when requesting a range beyond the actual message count.
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
        let parts = output.components(separatedBy: "||")
        guard parts.count >= 6 else {
            throw ScriptError.scriptFailed("Unexpected email format")
        }

        return [
            "id": id,
            "subject": parts[0].trimmingCharacters(in: .whitespaces),
            "sender": parts[1].trimmingCharacters(in: .whitespaces),
            "date": parts[2].trimmingCharacters(in: .whitespaces),
            "read": parts[3].trimmingCharacters(in: .whitespaces) == "true",
            "to": parts[4].trimmingCharacters(in: .whitespaces)
                .components(separatedBy: ",")
                .filter { !$0.isEmpty },
            "body": parts[5...].joined(separator: "||").trimmingCharacters(in: .whitespaces),
        ]
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

    static func sendEmail(to: String, subject: String, body: String, cc: String?) throws -> [String: Any] {
        let toEsc = escapeAppleScript(to)
        let subjectEsc = escapeAppleScript(subject)
        let bodyEsc = escapeAppleScript(body)

        var ccClause = ""
        if let cc = cc {
            let ccEsc = escapeAppleScript(cc)
            ccClause = """
                        make new cc recipient at end of cc recipients with properties {email address:{address:"\(ccEsc)"}}
            """
        }

        let script = """
        tell application "Microsoft Outlook"
            set newMsg to make new outgoing message with properties {subject:"\(subjectEsc)", plain text content:"\(bodyEsc)"}
            tell newMsg
                make new to recipient at end of to recipients with properties {email address:{address:"\(toEsc)"}}
        \(ccClause)
            end tell
            send newMsg
        end tell
        """

        _ = try ScriptRunner.run(script)
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

        _ = try ScriptRunner.run(script)
        return ["status": "sent"]
    }
}
