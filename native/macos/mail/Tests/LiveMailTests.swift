import AppKit
import SharedCLI
import XCTest
@testable import mail_cli

final class LiveMailTests: XCTestCase {
    static let optInVariable = "SPEEDWAVE_LIVE_MAIL"
    static let testMailbox = "Speedwave-Test"
    static let scriptTimeoutMs = 25_000

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
}
