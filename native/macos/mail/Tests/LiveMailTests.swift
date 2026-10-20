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
        guard try osascriptExecutor("application id \"com.apple.mail\" is running", 15) == "true" else {
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

    func testDeleteEmailsPreviewsFirstThenMovesTheMailToTheOnMyMacTrashOrReportsThatThereIsNone() throws {
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
        XCTAssertNotNil(parseISO8601(try XCTUnwrap(previewed["date"] as? String)))
        let unchanged = try XCTUnwrap(try call("list_emails", params.merging(["limit": 1]) { $1 }) as? [String: Any])
        XCTAssertEqual(unchanged["total"] as? Int, total)

        let messageId = escapeAppleScript(try MailId(decoding: id).messageId)
        let localTrash = try hasLocalChild("trash mailbox")
        var restored = false
        defer {
            if !restored { _ = try? restoreFromLocalChild("trash mailbox", messageId: messageId) }
        }
        let report = try XCTUnwrap(
            try call("delete_emails", ["ids": [id], "confirm_delete": true]) as? [String: Any])
        let after = try XCTUnwrap(try call("list_emails", params.merging(["limit": 1]) { $1 }) as? [String: Any])

        guard localTrash else {
            XCTAssertEqual(report["status"] as? String, "failed", "\(report)")
            let error = (report["emails"] as? [[String: Any]])?.first?["error"] as? String ?? ""
            XCTAssertTrue(error.hasPrefix("MAIL_TRASH_NOT_FOUND: "), error)
            XCTAssertEqual(after["total"] as? Int, total)
            return
        }
        XCTAssertEqual(report["status"] as? String, "completed", "\(report)")
        XCTAssertEqual(report["succeeded"] as? Int, 1)
        XCTAssertEqual(after["total"] as? Int, total - 1)
        restored = true
        XCTAssertEqual(try restoreFromLocalChild("trash mailbox", messageId: messageId), "restored")
        let home = try XCTUnwrap(try call("list_emails", params.merging(["limit": 1]) { $1 }) as? [String: Any])
        XCTAssertEqual(home["total"] as? Int, total)
    }

    private func hasLocalChild(_ special: String) throws -> Bool {
        try osascriptExecutor("""
            tell application "Mail"
                repeat with spwBoxRef in mailboxes of \(special)
                    try
                        get name of account of (contents of spwBoxRef)
                    on error
                        return "true"
                    end try
                end repeat
                return "false"
            end tell
            """, 30) == "true"
    }

    @discardableResult
    private func restoreFromLocalChild(_ special: String, messageId: String) throws -> String {
        try osascriptExecutor("""
            tell application "Mail"
                repeat with spwBoxRef in mailboxes of \(special)
                    set spwBox to contents of spwBoxRef
                    set spwLocal to false
                    try
                        get name of account of spwBox
                    on error
                        set spwLocal to true
                    end try
                    if spwLocal then
                        set spwFound to (every message of spwBox whose message id is "\(messageId)")
                        if (count of spwFound) > 0 then
                            set spwMail to item 1 of spwFound
                            if junk mail status of spwMail then set junk mail status of spwMail to false
                            move spwMail to mailbox "\(Self.testMailbox)"
                            return "restored"
                        end if
                    end if
                end repeat
                return "missing"
            end tell
            """, 30)
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
        let copies = "\(Self.testMailbox)-copies"
        let moved = "\(Self.testMailbox)-moved"
        let testParams: [String: Any] = ["mailbox": Self.testMailbox, "account": local]
        let testTotal = try XCTUnwrap((try call("list_emails", testParams) as? [String: Any])?["total"] as? Int)

        for name in [copies, moved] {
            let exists = try osascriptExecutor("tell application \"Mail\" to exists mailbox \"\(name)\"", 15)
            if exists == "false" {
                let made = try XCTUnwrap(try call("create_mailbox", ["name": name, "account": local]) as? [String: Any])
                XCTAssertEqual(made["status"] as? String, "created")
            }
            XCTAssertThrowsError(try call("create_mailbox", ["name": name, "account": local])) { error in
                XCTAssertEqual(error as? MailFailure, .mailboxExists(mailbox: name, account: local))
            }
        }
        XCTAssertThrowsError(
            try call("move_emails", ["ids": [mail.id], "mailbox": "\(copies)-missing", "account": local])
        ) { error in
            XCTAssertEqual(error as? MailFailure, .mailboxNotFound(mailbox: "\(copies)-missing", account: local))
        }
        let copiesParams: [String: Any] = ["mailbox": copies, "account": local]
        let movedParams: [String: Any] = ["mailbox": moved, "account": local]
        let copiesBefore = try XCTUnwrap((try call("list_emails", copiesParams) as? [String: Any])?["total"] as? Int)
        let movedBefore = try XCTUnwrap((try call("list_emails", movedParams) as? [String: Any])?["total"] as? Int)
        let copied = try XCTUnwrap(
            try call("copy_emails", ["ids": [mail.id], "mailbox": copies, "account": local]) as? [String: Any])
        XCTAssertEqual(copied["status"] as? String, "completed", "\(copied)")
        XCTAssertEqual((try call("list_emails", testParams) as? [String: Any])?["total"] as? Int, testTotal)
        let inCopies = try XCTUnwrap(try call("list_emails", copiesParams) as? [String: Any])
        XCTAssertEqual(inCopies["total"] as? Int, copiesBefore + 1)
        let copyId = try XCTUnwrap(
            (inCopies["emails"] as? [[String: Any]])?.compactMap { $0["id"] as? String }
                .first { (try? MailId(decoding: $0).messageId) == (try? MailId(decoding: mail.id).messageId) })

        let movedReport = try XCTUnwrap(
            try call("move_emails", ["ids": [copyId], "mailbox": moved, "account": local]) as? [String: Any])
        XCTAssertEqual(movedReport["status"] as? String, "completed", "\(movedReport)")
        XCTAssertEqual((try call("list_emails", copiesParams) as? [String: Any])?["total"] as? Int, copiesBefore)
        XCTAssertEqual((try call("list_emails", movedParams) as? [String: Any])?["total"] as? Int, movedBefore + 1)
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

    func testMarkEmailsSpamPreviewsFirstThenMovesTheMailToTheOnMyMacJunkOrReportsThatThereIsNone() throws {
        let mail = try newestTestMail()
        let params: [String: Any] = ["mailbox": Self.testMailbox, "account": AppleMailClient.localAccountName]
        let total = try XCTUnwrap((try call("list_emails", params) as? [String: Any])?["total"] as? Int)

        let preview = try XCTUnwrap(try call("mark_emails_spam", ["ids": [mail.id]]) as? [String: Any])
        XCTAssertEqual(preview["status"] as? String, "confirmation_required")
        XCTAssertEqual((preview["emails"] as? [[String: Any]])?.first?["ok"] as? Bool, true, "\(preview)")
        XCTAssertEqual((try call("list_emails", params) as? [String: Any])?["total"] as? Int, total)

        let localJunk = try hasLocalChild("junk mailbox")
        var restored = false
        defer {
            if !restored { _ = try? restoreFromLocalChild("junk mailbox", messageId: mail.messageId) }
        }
        let report = try XCTUnwrap(
            try call("mark_emails_spam", ["ids": [mail.id], "confirm_spam": true]) as? [String: Any])

        guard localJunk else {
            XCTAssertEqual(report["status"] as? String, "failed", "\(report)")
            let error = (report["emails"] as? [[String: Any]])?.first?["error"] as? String ?? ""
            XCTAssertTrue(error.hasPrefix("MAIL_JUNK_NOT_FOUND: "), error)
            XCTAssertEqual((try call("list_emails", params) as? [String: Any])?["total"] as? Int, total)
            XCTAssertEqual(try testMailProperty("junk mail status", messageId: mail.messageId), "false")
            return
        }
        XCTAssertEqual(report["status"] as? String, "completed", "\(report)")
        XCTAssertEqual((try call("list_emails", params) as? [String: Any])?["total"] as? Int, total - 1)
        restored = true
        XCTAssertEqual(try restoreFromLocalChild("junk mailbox", messageId: mail.messageId), "restored")
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

    func testForwardOfTheNewestTestMailPreviewsThenSendsItWithItsAttachmentsOnlyToTheTestAddress() throws {
        try passOnTheNewestTestMail("forward_email", extra: [:])
    }

    func testRedirectOfTheNewestTestMailPreviewsThenSendsItUnchangedOnlyToTheTestAddress() throws {
        try passOnTheNewestTestMail("redirect_email", extra: [:])
    }

    private func passOnTheNewestTestMail(_ command: String, extra: [String: Any]) throws {
        guard let address = ProcessInfo.processInfo.environment[Self.sendToVariable], !address.isEmpty else {
            throw XCTSkip("Sending runs only with \(Self.sendToVariable) set to a test address")
        }
        let params: [String: Any] = ["mailbox": Self.testMailbox, "account": AppleMailClient.localAccountName]
        let listed = try XCTUnwrap(try call("list_emails", params.merging(["limit": 1]) { $1 }) as? [String: Any])
        guard let id = (listed["emails"] as? [[String: Any]])?.first?["id"] as? String else {
            throw XCTSkip("\(Self.testMailbox) holds no message to pass on")
        }
        let email = try XCTUnwrap(try call("get_email", ["id": id]) as? [String: Any])["email"] as? [String: Any]
        let names = (email?["attachments"] as? [[String: Any]] ?? []).compactMap { $0["name"] as? String }
        let request = extra.merging(["id": id, "to": address]) { $1 }

        let preview = try XCTUnwrap(try call(command, request) as? [String: Any])
        XCTAssertEqual(preview["status"] as? String, "confirmation_required", "\(preview)")
        XCTAssertEqual(preview["to"] as? [String], [address])
        XCTAssertEqual(preview["attachments"] as? [String], names)
        XCTAssertEqual((preview["original"] as? [String: Any])?["subject"] as? String, email?["subject"] as? String)
        XCTAssertEqual(
            try XCTUnwrap(try call("list_emails", params.merging(["limit": 1]) { $1 }) as? [String: Any])["total"] as? Int,
            listed["total"] as? Int)

        let sent = try XCTUnwrap(try call(command, request.merging(["confirm_send": true]) { $1 }) as? [String: Any])
        XCTAssertEqual(sent["status"] as? String, "sent", "\(sent)")
        XCTAssertEqual(sent["subject"] as? String, preview["subject"] as? String)
    }

    func testListSignaturesReturnsEveryNameMailHas() throws {
        let result = try XCTUnwrap(try call("list_signatures") as? [String: Any])
        let names = try XCTUnwrap(result["signatures"] as? [String])
        let count = try osascriptExecutor("tell application \"Mail\" to count of signatures", 15)

        XCTAssertEqual(String(names.count), count)
        XCTAssertTrue(names.allSatisfy { !$0.isEmpty }, "\(names)")
    }

    func testAnUnknownSignatureIsRefusedBeforeAnythingIsSent() {
        XCTAssertThrowsError(
            try call(
                "send_email",
                ["to": "nobody@example.invalid", "subject": "S", "body": "B", "signature": "Speedwave no such \(UUID())"])
        ) { error in
            XCTAssertEqual((error as? MailFailure)?.code, "MAIL_SIGNATURE_NOT_FOUND", "\(error)")
        }
    }

    func testADraftInATurnedOffAccountIsRefusedAndNothingIsSaved() throws {
        let account = try osascriptExecutor(
            "tell application \"Mail\" to if exists (first account whose enabled is false) then "
                + "return name of first account whose enabled is false", 15)
        guard !account.isEmpty else {
            throw XCTSkip("Mail.app has no turned-off account")
        }
        let subject = "Speedwave live draft \(UUID().uuidString)"

        XCTAssertThrowsError(try call("save_draft", ["subject": subject, "body": "B", "account": account])) { error in
            XCTAssertEqual(error as? MailFailure, .accountDisabled(account))
        }
        Thread.sleep(forTimeInterval: 2)
        XCTAssertEqual(
            try osascriptExecutor(
                "tell application \"Mail\" to count (every message of drafts mailbox whose subject is \"\(subject)\")", 30),
            "0")
    }

    func testSaveDraftInAnAccountLandsUnsentInThatAccountsDraftsOnce() throws {
        let account = try osascriptExecutor(
            "tell application \"Mail\" to name of last account whose enabled is true", 15)
        let subject = "Speedwave live draft \(UUID().uuidString)"
        let signatures = try XCTUnwrap(try call("list_signatures") as? [String: Any])["signatures"] as? [String]
        var draft: [String: Any] = [
            "to": "nobody@example.invalid", "subject": subject, "body": "Line one\nline two", "account": account,
        ]
        draft["signature"] = signatures?.first

        let saved = try XCTUnwrap(try call("save_draft", draft) as? [String: Any])
        XCTAssertEqual(saved["status"] as? String, "saved", "\(saved)")
        defer {
            _ = try? osascriptExecutor(
                "tell application \"Mail\" to delete (every message of drafts mailbox whose subject is \"\(subject)\")", 30)
        }

        var found = ""
        for _ in 0..<10 where found.isEmpty {
            Thread.sleep(forTimeInterval: 1)
            found = try osascriptExecutor(
                """
                tell application "Mail"
                    set spwFound to every message of drafts mailbox whose subject is "\(subject)"
                    if (count of spwFound) is 0 then return ""
                    return ((count of spwFound) as text) & "|" & (name of account of mailbox of item 1 of spwFound)
                end tell
                """, 30)
        }
        XCTAssertEqual(found, "1|\(account)")
        let readBack = try osascriptExecutor(
            """
            tell application "Mail"
                set spwDraft to item 1 of (every message of drafts mailbox whose subject is "\(subject)")
                set spwAddresses to email addresses of account "\(escapeAppleScript(account))"
                set spwAddress to item 1 of spwAddresses
                return (content of spwDraft) & "|" & ((sender of spwDraft) contains spwAddress)
            end tell
            """, 30)
        XCTAssertTrue(readBack.hasPrefix("Line one\nline two"), readBack)
        XCTAssertTrue(readBack.hasSuffix("|true"), readBack)
        let sent = try osascriptExecutor(
            """
            tell application "Mail" to count (every message of sent mailbox whose subject is "\(subject)")
            """, 30)
        XCTAssertEqual(sent, "0")
    }

    func testSendWithAChosenSignatureGoesOnlyToTheTestAddress() throws {
        guard let address = ProcessInfo.processInfo.environment[Self.sendToVariable], !address.isEmpty else {
            throw XCTSkip("Sending runs only with \(Self.sendToVariable) set to a test address")
        }
        let listed = try XCTUnwrap(try call("list_signatures") as? [String: Any])
        guard let signature = (listed["signatures"] as? [String])?.first else {
            throw XCTSkip("Mail.app has no signature to choose")
        }
        let message: [String: Any] = [
            "to": address, "subject": "Speedwave live signed send \(UUID().uuidString)", "body": "Signed",
            "signature": signature,
        ]

        let preview = try XCTUnwrap(try call("send_email", message) as? [String: Any])
        XCTAssertEqual(preview["signature"] as? String, signature)
        let sent = try XCTUnwrap(try call("send_email", message.merging(["confirm_send": true]) { $1 }) as? [String: Any])
        XCTAssertEqual(sent["status"] as? String, "sent", "\(sent)")
        XCTAssertEqual(sent["signature"] as? String, signature)
    }
}
