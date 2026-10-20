import AppKit
import SharedCLI
import XCTest
@testable import mail_cli

final class LiveMailTests: XCTestCase {
    static let optInVariable = "SPEEDWAVE_LIVE_MAIL"
    static let testMailbox = "Speedwave-Test"
    static let scriptTimeoutMs = 25_000
    static let sendToVariable = "SPEEDWAVE_LIVE_MAIL_SEND_TO"

    override func setUpWithError() throws {
        guard ProcessInfo.processInfo.environment[Self.optInVariable] == "1" else {
            throw XCTSkip("Live Mail.app tests run only with \(Self.optInVariable)=1")
        }
        guard !NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.mail").isEmpty else {
            throw XCTSkip("Mail.app is not running")
        }
        let exists = try osascriptExecutor(
            "tell application \"Mail\" to exists mailbox \"\(Self.testMailbox)\"", 15)
        guard exists == "true" else {
            throw XCTSkip("No On My Mac mailbox \(Self.testMailbox) in Mail.app")
        }
    }

    private func call(_ command: String, _ params: [String: Any] = [:]) throws -> Any {
        let commands = mailCommands(executor: osascriptExecutor)
        let handler = try XCTUnwrap(commands[command], "mail-cli has no command \(command)")
        return try handler(params.merging([scriptTimeoutParam: Self.scriptTimeoutMs]) { current, _ in current })
    }

    func testListMailboxesAnswersWithinTheBudget() throws {
        let result = try XCTUnwrap(try call("list_mailboxes") as? [String: Any])
        XCTAssertNotNil(result["mailboxes"] as? [[String: Any]])
    }

    func testListMailboxesListsTheTestMailboxOnceUnderOnMyMac() throws {
        let result = try XCTUnwrap(try call("list_mailboxes") as? [String: Any])
        let mailboxes = try XCTUnwrap(result["mailboxes"] as? [[String: Any]])
        let matches = mailboxes.filter { $0["name"] as? String == Self.testMailbox }
        XCTAssertEqual(matches.count, 1, "\(matches)")
        XCTAssertEqual(matches.first?["account"] as? String, AppleMailClient.localAccountName)
    }

    func testListEmailsPagesTheTestMailboxNewestFirstWithMailIdsGetEmailReads() throws {
        let params: [String: Any] = ["mailbox": Self.testMailbox, "account": AppleMailClient.localAccountName]
        let all = try XCTUnwrap(try call("list_emails", params.merging(["limit": 10_000]) { $1 }) as? [String: Any])
        let emails = try XCTUnwrap(all["emails"] as? [[String: Any]])
        XCTAssertEqual(all["total"] as? Int, emails.count)
        let dates = emails.compactMap { $0["date"] as? String }.compactMap(parseISO8601)
        XCTAssertEqual(dates, dates.sorted(by: >))

        let second = try XCTUnwrap(
            try call("list_emails", params.merging(["offset": 1, "limit": 1]) { $1 }) as? [String: Any])
        let secondIds = (second["emails"] as? [[String: Any]])?.compactMap { $0["id"] as? String }
        XCTAssertEqual(secondIds, emails.dropFirst().prefix(1).compactMap { $0["id"] as? String })

        let unread = try XCTUnwrap(try call("list_emails", params.merging(["unread_only": true]) { $1 }) as? [String: Any])
        XCTAssertEqual(unread["total"] as? Int, emails.filter { $0["read"] as? Bool == false }.count)

        guard let newest = emails.first?["id"] as? String else {
            throw XCTSkip("\(Self.testMailbox) holds no message to read by its mail id")
        }
        XCTAssertEqual(try MailId(decoding: newest).mailbox, Self.testMailbox)
        let read = try XCTUnwrap(try call("get_email", ["id": newest]) as? [String: Any])
        XCTAssertEqual((read["email"] as? [String: Any])?["subject"] as? String, emails.first?["subject"] as? String)
    }

    func testSearchEmailsFindsTheNewestMessageBySubjectAndNothingForAnUnmatchedQuery() throws {
        let params: [String: Any] = ["mailbox": Self.testMailbox, "account": AppleMailClient.localAccountName]
        let listed = try XCTUnwrap(try call("list_emails", params.merging(["limit": 1]) { $1 }) as? [String: Any])
        guard let newest = (listed["emails"] as? [[String: Any]])?.first,
              let id = newest["id"] as? String,
              let subject = newest["subject"] as? String, !subject.isEmpty
        else {
            throw XCTSkip("\(Self.testMailbox) holds no message with a subject to search for")
        }

        for searchBody in [false, true] {
            let query: [String: Any] = ["query": subject, "search_body": searchBody, "limit": 10_000]
            let found = try XCTUnwrap(try call("search_emails", params.merging(query) { $1 }) as? [String: Any])
            let ids = (found["emails"] as? [[String: Any]])?.compactMap { $0["id"] as? String } ?? []
            XCTAssertTrue(ids.contains(id), "search_body \(searchBody): \(found)")
            XCTAssertEqual(found["total"] as? Int, ids.count)
        }

        let unmatchedQuery = #"SPW "no-hit" \ Zażółć 東京 834"#
        let unmatched = try XCTUnwrap(
            try call("search_emails", params.merging(["query": unmatchedQuery]) { $1 }) as? [String: Any])
        XCTAssertEqual(unmatched["total"] as? Int, 0)

        let future = try XCTUnwrap(
            try call("search_emails", params.merging(["query": subject, "since": "2999-01-01"]) { $1 }) as? [String: Any])
        XCTAssertEqual(future["total"] as? Int, 0)
    }

    func testGetEmailReadsCcAttachmentsHeadersAndSourceOfTheNewestTestMail() throws {
        let params: [String: Any] = [
            "mailbox": Self.testMailbox, "account": AppleMailClient.localAccountName, "limit": 1,
        ]
        let listed = try XCTUnwrap(try call("list_emails", params) as? [String: Any])
        guard let newest = (listed["emails"] as? [[String: Any]])?.first?["id"] as? String else {
            throw XCTSkip("\(Self.testMailbox) holds no message to read")
        }

        let read = try XCTUnwrap(
            try call("get_email", ["id": newest, "include_headers": true, "include_source": true]) as? [String: Any])

        let email = try XCTUnwrap(read["email"] as? [String: Any])
        XCTAssertNotNil(email["cc"] as? [String])
        XCTAssertNotNil(parseISO8601(try XCTUnwrap(email["date"] as? String)))
        XCTAssertEqual(email["mailbox"] as? String, Self.testMailbox)
        let attachments = try XCTUnwrap(email["attachments"] as? [[String: Any]])
        for (offset, attachment) in attachments.enumerated() {
            XCTAssertEqual(attachment["index"] as? Int, offset + 1)
            XCTAssertNotNil(attachment["name"] as? String)
        }
        let headers = try XCTUnwrap(email["headers"] as? String)
        XCTAssertTrue(headers.localizedCaseInsensitiveContains("message-id:"), headers)
        XCTAssertNotNil(email["headers_truncated"] as? Bool)
        XCTAssertFalse(try XCTUnwrap(email["source"] as? String).isEmpty)
        XCTAssertNotNil(email["source_truncated"] as? Bool)
    }

    func testGetEmailOfAMessageIdTheMailboxDoesNotHoldIsReportedAsMailNotFound() {
        let id = MailId(
            account: AppleMailClient.localAccountName, mailbox: Self.testMailbox, messageId: "<spw-missing-833@x>")
        XCTAssertThrowsError(try call("get_email", ["id": id.encoded])) { error in
            XCTAssertEqual(
                error as? MailFailure,
                .mailNotFound(mailbox: Self.testMailbox, account: AppleMailClient.localAccountName))
        }
    }

    func testAMailboxNoAccountHasIsReportedAsMailboxNotFound() {
        let mailbox = "SPW-Nonexistent-Mailbox-831"
        XCTAssertThrowsError(try call("list_emails", ["mailbox": mailbox, "limit": 1])) { error in
            XCTAssertEqual(error as? MailFailure, .mailboxNotFound(mailbox: mailbox, account: nil))
        }
    }

    func testListRulesReadsEveryRuleWithItsConditionsAndActions() throws {
        let result = try XCTUnwrap(try call("list_rules") as? [String: Any])
        let rules = try XCTUnwrap(result["rules"] as? [[String: Any]])
        for rule in rules {
            XCTAssertNotNil(rule["name"] as? String)
            XCTAssertNotNil(rule["enabled"] as? Bool)
            let conditions = try XCTUnwrap(rule["conditions"] as? [[String: String]])
            for condition in conditions {
                XCTAssertFalse(condition["field"]?.hasPrefix("\u{AB}") ?? true, "raw enum constant: \(condition)")
                XCTAssertFalse(condition["qualifier"]?.hasPrefix("\u{AB}") ?? true, "raw enum constant: \(condition)")
            }
            XCTAssertNotNil(rule["actions"] as? [[String: String]])
        }
    }

    func testCheckMailStartsAFetchForEveryAccount() throws {
        let result = try XCTUnwrap(try call("check_mail") as? [String: Any])
        XCTAssertEqual(result["status"] as? String, "started")
    }

    func testCheckMailForAnUnknownAccountIsReportedAsAccountNotFound() {
        let account = "SPW-Nonexistent-Account-841"
        XCTAssertThrowsError(try call("check_mail", ["account": account])) { error in
            XCTAssertEqual(error as? MailFailure, .accountNotFound(account))
        }
    }

    func testDeleteEmailsPreviewsFirstThenMovesTheMailToTheTrashWhereItCanBeRestored() throws {
        let params: [String: Any] = ["mailbox": Self.testMailbox, "account": AppleMailClient.localAccountName]
        let before = try XCTUnwrap(try call("list_emails", params.merging(["limit": 1]) { $1 }) as? [String: Any])
        guard let newest = (before["emails"] as? [[String: Any]])?.first,
              let id = newest["id"] as? String
        else {
            throw XCTSkip("\(Self.testMailbox) holds no message to delete")
        }
        let total = try XCTUnwrap(before["total"] as? Int)

        let preview = try XCTUnwrap(try call("delete_emails", ["ids": [id]]) as? [String: Any])
        XCTAssertEqual(preview["status"] as? String, "confirmation_required")
        let previewed = try XCTUnwrap((preview["emails"] as? [[String: Any]])?.first)
        XCTAssertEqual(previewed["ok"] as? Bool, true, "\(previewed)")
        XCTAssertEqual(previewed["subject"] as? String, newest["subject"] as? String)
        let unchanged = try XCTUnwrap(try call("list_emails", params.merging(["limit": 1]) { $1 }) as? [String: Any])
        XCTAssertEqual(unchanged["total"] as? Int, total)

        let messageId = escapeAppleScript(try MailId(decoding: id).messageId)
        defer {
            _ = try? osascriptExecutor("""
                tell application "Mail"
                    repeat with spwBoxRef in ((mailboxes of trash mailbox) & {trash mailbox})
                        set spwFound to (every message of (contents of spwBoxRef) whose message id is "\(messageId)")
                        if (count of spwFound) > 0 then
                            move item 1 of spwFound to mailbox "\(Self.testMailbox)"
                            return "restored"
                        end if
                    end repeat
                    return "missing"
                end tell
                """, 30)
        }
        let report = try XCTUnwrap(
            try call("delete_emails", ["ids": [id], "confirm_delete": true]) as? [String: Any])
        XCTAssertEqual(report["status"] as? String, "completed", "\(report)")
        XCTAssertEqual(report["succeeded"] as? Int, 1)
        let after = try XCTUnwrap(try call("list_emails", params.merging(["limit": 1]) { $1 }) as? [String: Any])
        XCTAssertEqual(after["total"] as? Int, total - 1)
        let inTrash = try osascriptExecutor("""
            tell application "Mail"
                set spwCount to 0
                repeat with spwBoxRef in ((mailboxes of trash mailbox) & {trash mailbox})
                    set spwCount to spwCount + (count of (every message of (contents of spwBoxRef) whose message id is "\(messageId)"))
                end repeat
                return spwCount
            end tell
            """, 30)
        XCTAssertNotEqual(inTrash, "0", "the deleted mail is not in any Trash mailbox")
    }

    private func newestTestMail() throws -> (id: String, messageId: String, read: Bool) {
        let params: [String: Any] = [
            "mailbox": Self.testMailbox, "account": AppleMailClient.localAccountName, "limit": 1,
        ]
        let listed = try XCTUnwrap(try call("list_emails", params) as? [String: Any])
        guard let newest = (listed["emails"] as? [[String: Any]])?.first,
              let id = newest["id"] as? String,
              let read = newest["read"] as? Bool
        else {
            throw XCTSkip("\(Self.testMailbox) holds no message to organize")
        }
        return (id, escapeAppleScript(try MailId(decoding: id).messageId), read)
    }

    private func testMailProperty(_ property: String, messageId: String) throws -> String {
        try osascriptExecutor("""
            tell application "Mail"
                return \(property) of item 1 of (every message of mailbox "\(Self.testMailbox)" whose message id is "\(messageId)")
            end tell
            """, 30)
    }

    func testMarkEmailsReadSetsAndClearsTheReadStatus() throws {
        let mail = try newestTestMail()
        defer { _ = try? call("mark_emails_read", ["ids": [mail.id], "read": mail.read]) }

        for read in [!mail.read, mail.read] {
            let report = try XCTUnwrap(try call("mark_emails_read", ["ids": [mail.id], "read": read]) as? [String: Any])
            XCTAssertEqual(report["status"] as? String, "completed", "\(report)")
            XCTAssertEqual(try testMailProperty("read status", messageId: mail.messageId), "\(read)")
        }
    }

    func testFlagEmailsSetsAColorAndTakesTheFlagOff() throws {
        let mail = try newestTestMail()
        let flagIndex = try testMailProperty("flag index", messageId: mail.messageId)
        defer {
            _ = try? osascriptExecutor("""
                tell application "Mail"
                    set m to item 1 of (every message of mailbox "\(Self.testMailbox)" whose message id is "\(mail.messageId)")
                    if \(flagIndex) is -1 then
                        set flagged status of m to false
                    else
                        set flagged status of m to true
                        set flag index of m to \(flagIndex)
                    end if
                end tell
                """, 30)
        }

        let blue = try XCTUnwrap(try call("flag_emails", ["ids": [mail.id], "flag": "blue"]) as? [String: Any])
        XCTAssertEqual(blue["status"] as? String, "completed", "\(blue)")
        XCTAssertEqual(try testMailProperty("flag index", messageId: mail.messageId), "4")
        XCTAssertEqual(try testMailProperty("flagged status", messageId: mail.messageId), "true")

        let none = try XCTUnwrap(try call("flag_emails", ["ids": [mail.id], "flag": "none"]) as? [String: Any])
        XCTAssertEqual(none["status"] as? String, "completed", "\(none)")
        XCTAssertEqual(try testMailProperty("flagged status", messageId: mail.messageId), "false")
    }

    func testCreateMailboxThenCopyAMailThereAndMoveTheCopyOn() throws {
        let mail = try newestTestMail()
        let local = AppleMailClient.localAccountName
        let suffix = UUID().uuidString.prefix(8)
        let copies = "Speedwave-Test-836-copies-\(suffix)"
        let moved = "Speedwave-Test-836-moved-\(suffix)"
        defer {
            for name in [copies, moved] {
                _ = try? osascriptExecutor(
                    "tell application \"Mail\" to if exists mailbox \"\(name)\" then delete mailbox \"\(name)\"", 30)
            }
        }
        let testParams: [String: Any] = ["mailbox": Self.testMailbox, "account": local]
        let testTotal = try XCTUnwrap((try call("list_emails", testParams) as? [String: Any])?["total"] as? Int)

        for name in [copies, moved] {
            let made = try XCTUnwrap(try call("create_mailbox", ["name": name, "account": local]) as? [String: Any])
            XCTAssertEqual(made["status"] as? String, "created")
        }
        XCTAssertThrowsError(try call("create_mailbox", ["name": copies, "account": local])) { error in
            XCTAssertEqual(error as? MailFailure, .mailboxExists(mailbox: copies, account: local))
        }
        XCTAssertThrowsError(
            try call("move_emails", ["ids": [mail.id], "mailbox": "\(copies)-missing", "account": local])
        ) { error in
            XCTAssertEqual(error as? MailFailure, .mailboxNotFound(mailbox: "\(copies)-missing", account: local))
        }

        let copied = try XCTUnwrap(
            try call("copy_emails", ["ids": [mail.id], "mailbox": copies, "account": local]) as? [String: Any])
        XCTAssertEqual(copied["status"] as? String, "completed", "\(copied)")
        XCTAssertEqual((try call("list_emails", testParams) as? [String: Any])?["total"] as? Int, testTotal)
        let copiesParams: [String: Any] = ["mailbox": copies, "account": local]
        let inCopies = try XCTUnwrap(try call("list_emails", copiesParams) as? [String: Any])
        XCTAssertEqual(inCopies["total"] as? Int, 1)
        let copyId = try XCTUnwrap((inCopies["emails"] as? [[String: Any]])?.first?["id"] as? String)

        let movedReport = try XCTUnwrap(
            try call("move_emails", ["ids": [copyId], "mailbox": moved, "account": local]) as? [String: Any])
        XCTAssertEqual(movedReport["status"] as? String, "completed", "\(movedReport)")
        XCTAssertEqual((try call("list_emails", copiesParams) as? [String: Any])?["total"] as? Int, 0)
        let movedParams: [String: Any] = ["mailbox": moved, "account": local]
        XCTAssertEqual((try call("list_emails", movedParams) as? [String: Any])?["total"] as? Int, 1)
    }

    func testArchiveEmailsOnMyMacWithoutAnArchiveMailboxLeavesTheMailWhereItIs() throws {
        let exists = try osascriptExecutor("tell application \"Mail\" to exists mailbox \"Archive\"", 15)
        guard exists == "false" else {
            throw XCTSkip("On My Mac has an Archive mailbox")
        }
        let mail = try newestTestMail()

        let report = try XCTUnwrap(try call("archive_emails", ["ids": [mail.id]]) as? [String: Any])

        XCTAssertEqual(report["status"] as? String, "failed", "\(report)")
        let error = (report["emails"] as? [[String: Any]])?.first?["error"] as? String ?? ""
        XCTAssertTrue(error.hasPrefix("MAIL_ARCHIVE_NOT_FOUND: "), error)
        XCTAssertFalse(try testMailProperty("subject", messageId: mail.messageId).isEmpty)
    }

    func testMarkEmailsSpamPreviewsFirstThenMovesTheMailToTheJunkWhereItCanBeRestored() throws {
        let mail = try newestTestMail()
        let params: [String: Any] = ["mailbox": Self.testMailbox, "account": AppleMailClient.localAccountName]
        let total = try XCTUnwrap((try call("list_emails", params) as? [String: Any])?["total"] as? Int)

        let preview = try XCTUnwrap(try call("mark_emails_spam", ["ids": [mail.id]]) as? [String: Any])
        XCTAssertEqual(preview["status"] as? String, "confirmation_required")
        XCTAssertEqual((try call("list_emails", params) as? [String: Any])?["total"] as? Int, total)

        defer {
            _ = try? osascriptExecutor("""
                tell application "Mail"
                    repeat with spwBoxRef in ((mailboxes of junk mailbox) & {junk mailbox})
                        set spwFound to (every message of (contents of spwBoxRef) whose message id is "\(mail.messageId)")
                        if (count of spwFound) > 0 then
                            set junk mail status of item 1 of spwFound to false
                            move item 1 of spwFound to mailbox "\(Self.testMailbox)"
                            return "restored"
                        end if
                    end repeat
                    return "missing"
                end tell
                """, 30)
        }
        let report = try XCTUnwrap(
            try call("mark_emails_spam", ["ids": [mail.id], "confirm_spam": true]) as? [String: Any])
        XCTAssertEqual(report["status"] as? String, "completed", "\(report)")
        XCTAssertEqual((try call("list_emails", params) as? [String: Any])?["total"] as? Int, total - 1)
    }

    func testSendEmailPreviewsThenSendsOnlyToTheTestAddress() throws {
        guard let address = ProcessInfo.processInfo.environment[Self.sendToVariable], !address.isEmpty else {
            throw XCTSkip("Sending runs only with \(Self.sendToVariable) set to a test address")
        }
        let message: [String: Any] = [
            "to": address,
            "subject": "Speedwave live send \(UUID().uuidString)",
            "body": "Line \"one\"\nC:\\temp\tend",
        ]

        let preview = try XCTUnwrap(try call("send_email", message) as? [String: Any])
        XCTAssertEqual(preview["status"] as? String, "confirmation_required")
        XCTAssertEqual(preview["to"] as? [String], [address])

        let sent = try XCTUnwrap(try call("send_email", message.merging(["confirm_send": true]) { $1 }) as? [String: Any])
        XCTAssertEqual(sent["status"] as? String, "sent", "\(sent)")
        XCTAssertEqual(sent["body"] as? String, message["body"] as? String)
    }

    func testReplyToTheNewestTestMailPreviewsAndSendsOnlyWhenItGoesToTheTestAddress() throws {
        let params: [String: Any] = ["mailbox": Self.testMailbox, "account": AppleMailClient.localAccountName]
        let listed = try XCTUnwrap(try call("list_emails", params.merging(["limit": 1]) { $1 }) as? [String: Any])
        guard let id = (listed["emails"] as? [[String: Any]])?.first?["id"] as? String else {
            throw XCTSkip("\(Self.testMailbox) holds no message to reply to")
        }
        let reply: [String: Any] = ["id": id, "body": "Speedwave live reply"]

        let preview = try XCTUnwrap(try call("reply_to_email", reply) as? [String: Any])
        XCTAssertEqual(preview["status"] as? String, "confirmation_required", "\(preview)")
        let body = try XCTUnwrap(preview["body"] as? String)
        XCTAssertTrue(body.hasPrefix("Speedwave live reply\n\n"), body)
        XCTAssertTrue(body.contains(" wrote:\n"), body)
        XCTAssertEqual(
            try XCTUnwrap(try call("list_emails", params.merging(["limit": 1]) { $1 }) as? [String: Any])["total"] as? Int,
            listed["total"] as? Int)

        guard let address = ProcessInfo.processInfo.environment[Self.sendToVariable], !address.isEmpty,
              preview["to"] as? [String] == [address], (preview["cc"] as? [String])?.isEmpty == true
        else {
            throw XCTSkip("The reply would not go only to \(Self.sendToVariable); it was previewed, not sent")
        }
        let sent = try XCTUnwrap(
            try call("reply_to_email", reply.merging(["confirm_send": true]) { $1 }) as? [String: Any])
        XCTAssertEqual(sent["status"] as? String, "sent", "\(sent)")
        XCTAssertEqual(sent["body"] as? String, body)
    }
}
