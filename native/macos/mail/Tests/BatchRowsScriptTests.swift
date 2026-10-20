import SharedCLI
import XCTest
@testable import mail_cli

final class BatchRowsScriptTests: XCTestCase {
    private let mail = MailId(account: "iCloud", mailbox: "INBOX", messageId: "<a@x>")

    private let syntheticRows = """
        set spwReceived to current date
        set day of spwReceived to 1
        set year of spwReceived to 2026
        set month of spwReceived to October
        set day of spwReceived to 20
        set time of spwReceived to 9 * hours + 15 * minutes
        set spwRows to {}
        set end of spwRows to {"ok", "Zażółć \\"q\\"", "Anna <anna@x>", spwReceived, ""}
        set end of spwRows to {"error", "", "", missing value, "SPW_ARCHIVE_NOT_FOUND (-2700)"}
        """

    private func rowsTail(of command: String, _ params: [String: Any]) throws -> String {
        let harness = MailCommandHarness()
        harness.executor.reply(["ok", "", "", "", ""].joined(separator: MailBatch.fieldSeparator))
        _ = try harness.call(command, params)
        let script = try XCTUnwrap(harness.executor.calls.first?.script)
        let end = try XCTUnwrap(script.range(of: "end tell", options: .backwards))
        return String(script[end.upperBound...])
    }

    func testTheRowsOfEveryBatchCommandBecomeTextInRealAppleScript() throws {
        let commands: [(String, [String: Any])] = [
            ("delete_emails", ["ids": [mail.encoded]]),
            ("delete_emails", ["ids": [mail.encoded], "confirm_delete": true]),
            ("mark_emails_read", ["ids": [mail.encoded], "read": true]),
            ("archive_emails", ["ids": [mail.encoded]]),
        ]
        for (command, params) in commands {
            let output = try osascriptExecutor(syntheticRows + (try rowsTail(of: command, params)), 15)

            let lines = output.components(separatedBy: MailBatch.rowSeparator)
            XCTAssertEqual(lines.count, 2, "\(command): \(output)")
            XCTAssertEqual(
                lines.first?.components(separatedBy: MailBatch.fieldSeparator),
                ["ok", "Zażółć \"q\"", "Anna <anna@x>", "2026-10-20T09:15:00", ""], command)
            XCTAssertEqual(
                lines.last?.components(separatedBy: MailBatch.fieldSeparator),
                ["error", "", "", "", "SPW_ARCHIVE_NOT_FOUND (-2700)"], command)
        }
    }
}
