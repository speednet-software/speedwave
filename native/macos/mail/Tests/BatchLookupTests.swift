import SharedCLI
import XCTest
@testable import mail_cli

final class BatchLookupTests: XCTestCase {
    private let harness = MailCommandHarness()
    private let inboxA = MailId(accountId: "W-1", account: "Work", mailbox: "INBOX", messageId: "<a@x>")
    private let inboxB = MailId(accountId: "W-1", account: "Work", mailbox: "INBOX", messageId: "<b@x>")
    private let archive = MailId(accountId: "W-1", account: "Work", mailbox: "Archive", messageId: "<c@x>")

    private func okRow() -> String {
        ["ok", "s", "a", "", ""].joined(separator: MailBatch.fieldSeparator)
    }

    func testEachMailboxOfABatchIsLookedUpAndReadOnceInsteadOfScanningItForEveryMail() throws {
        harness.executor.reply([okRow(), okRow(), okRow()].joined(separator: MailBatch.rowSeparator))

        _ = try harness.call("mark_emails_read", ["ids": [inboxA.encoded, archive.encoded, inboxB.encoded], "read": true])

        let script = try XCTUnwrap(harness.executor.calls.first?.script)
        XCTAssertEqual(script.components(separatedBy: "(message id of every message of mb)").count - 1, 2, script)
        XCTAssertEqual(script.components(separatedBy: "(id of every message of mb)").count - 1, 2, script)
        XCTAssertEqual(script.components(separatedBy: "set mb to mailbox \"INBOX\" of spwAcct").count - 1, 1, script)
        XCTAssertEqual(script.components(separatedBy: "my spwFind(spwGroup0, ").count - 1, 2, script)
        XCTAssertEqual(script.components(separatedBy: "my spwFind(spwGroup1, ").count - 1, 1, script)
        XCTAssertTrue(script.contains("set m to «class mssg» id spwMailId of mb"), script)
    }

    func testFindingAMailAmongSixThousandIsFastExactAndCaseSensitiveInRealAppleScript() throws {
        let script = """
            script spwGroup0
                property spwGKeys : {}
                property spwGIds : {}
            end script
            repeat with i from 1 to 6000
                set end of spwGKeys of spwGroup0 to "<m" & i & "@x>"
                set end of spwGIds of spwGroup0 to 1000 + i
            end repeat
            set spwFound to {}
            repeat with spwKey in {"<m5999@x>", "<m1@x>", "<M1@X>", "<missing@x>"}
                set end of spwFound to my spwFind(spwGroup0, contents of spwKey)
            end repeat
            set AppleScript's text item delimiters to ","
            return spwFound as text

            """ + MailBatch.findHandler
        let started = Date()

        let output = try osascriptExecutor(script, 60)

        XCTAssertLessThan(Date().timeIntervalSince(started), 3)
        XCTAssertEqual(output, "6999,1001,0,0")
    }

    func testABatchStopsTryingMailsShortlyBeforeItsBudgetEndsAndReportsTheRestAsNotAttempted() throws {
        harness.executor.reply([
            okRow(),
            ["error", "", "", "", "\(batchStoppedMarker) (-2700)"].joined(separator: MailBatch.fieldSeparator),
        ].joined(separator: MailBatch.rowSeparator))

        let result = try harness.call(
            "move_emails",
            ["ids": [inboxA.encoded, inboxB.encoded], "mailbox": "Done", "account": "Work", "script_timeout_ms": 115_000])

        let script = try XCTUnwrap(harness.executor.calls.first?.script)
        XCTAssertTrue(script.contains("set spwDeadline to (current date) + 110"), script)
        XCTAssertTrue(script.contains("if (current date) > spwDeadline then error \"\(batchStoppedMarker)\""), script)
        XCTAssertEqual(result["status"] as? String, "partial")
        let rows = try XCTUnwrap(result["emails"] as? [[String: Any]])
        XCTAssertTrue((rows.last?["error"] as? String)?.hasPrefix("MAIL_NOT_ATTEMPTED: ") == true, "\(rows)")
    }

    func testSeparatorCharactersInASubjectSenderOrErrorDoNotBreakTheBatchReportInRealAppleScript() throws {
        harness.executor.reply(okRow())
        _ = try harness.call("mark_emails_read", ["ids": [inboxA.encoded], "read": true])
        let script = try XCTUnwrap(harness.executor.calls.first?.script)
        let tail = String(script[try XCTUnwrap(script.range(of: "end tell", options: .backwards)).upperBound...])
        let rows = """
            set spwRows to {}
            set end of spwRows to {"ok", "A" & (character id 31) & "B" & (character id 30) & "C", "x" & (character id 29) & "y", missing value, ""}
            set end of spwRows to {"error", "", "", missing value, "Can't get " & (character id 30) & "z (-1728)"}

            """

        let output = try osascriptExecutor(rows + tail, 15)

        let lines = output.components(separatedBy: MailBatch.rowSeparator)
        XCTAssertEqual(lines.count, 2, output)
        XCTAssertEqual(lines.first?.components(separatedBy: MailBatch.fieldSeparator), ["ok", "ABC", "xy", "", ""])
        XCTAssertEqual(lines.last?.components(separatedBy: MailBatch.fieldSeparator), ["error", "", "", "", "Can't get z (-1728)"])
    }
}
