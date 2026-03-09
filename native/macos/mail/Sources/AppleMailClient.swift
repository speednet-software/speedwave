import Foundation

/// Apple Mail.app automation via AppleScript.
enum AppleMailClient {
    static let name = "Apple Mail"

    static func isAvailable() -> Bool {
        // Mail.app is always installed on macOS
        return true
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

        let output = try ScriptRunner.run(script)
        return parseDelimited(output, fields: ["account", "name", "message_count"])
    }

    static func listEmails(limit: Int, mailbox: String?) throws -> [[String: Any]] {
        let mailboxClause: String
        if let mb = mailbox {
            mailboxClause = "mailbox \"\(escapeAppleScript(mb))\""
        } else {
            mailboxClause = "inbox"
        }

        // Iterate with counter to avoid out-of-range errors.
        // Access each message individually — Apple Mail doesn't support
        // bulk property fetch for dates.
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

        let output = try ScriptRunner.run(script, timeout: 30)
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
        tell application "Mail"
            set output to ""
            set msgCount to 0
            set msgs to (every message of inbox whose subject contains "\(queryEsc)" or content contains "\(queryEsc)")
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
                        make new cc recipient at end of cc recipients with properties {address:"\(ccEsc)"}
            """
        }

        let script = """
        tell application "Mail"
            set newMsg to make new outgoing message with properties {subject:"\(subjectEsc)", content:"\(bodyEsc)", visible:true}
            tell newMsg
                make new to recipient at end of to recipients with properties {address:"\(toEsc)"}
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

        _ = try ScriptRunner.run(script)
        return ["status": "sent"]
    }
}

/// Parse `||`-delimited AppleScript output into array of dictionaries.
func parseDelimited(_ output: String, fields: [String]) -> [[String: Any]] {
    output
        .components(separatedBy: .newlines)
        .filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
        .compactMap { line in
            let parts = line.components(separatedBy: "||")
            guard parts.count == fields.count else { return nil }
            var dict: [String: Any] = [:]
            for (key, val) in zip(fields, parts) {
                dict[key] = val.trimmingCharacters(in: .whitespaces)
            }
            return dict
        }
}
