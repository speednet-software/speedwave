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

    func testAMailboxNoAccountHasIsReportedAsMailboxNotFound() {
        let mailbox = "SPW-Nonexistent-Mailbox-831"
        XCTAssertThrowsError(try call("list_emails", ["mailbox": mailbox, "limit": 1])) { error in
            XCTAssertEqual(error as? MailFailure, .mailboxNotFound(mailbox: mailbox, account: nil))
        }
    }
}
