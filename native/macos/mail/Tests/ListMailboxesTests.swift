import SharedCLI
import XCTest
@testable import mail_cli

final class ListMailboxesTests: XCTestCase {
    private let syntheticScopes = """
        set spwScopes to {}
        set end of spwScopes to {"Work", {"box1", "box2", "box3", "box4"}, {"Clients", "Acme", "Inbox", "2026"}, ¬
            {"work", "box1", "work", "box2"}, {{1, 2}, {}, {3}, {4, 5, 6}}, missing value}
        set end of spwScopes to {"Empty", {}, {}, {}, {}, missing value}
        set end of spwScopes to {"On My Mac", {"local1", "local2", "local3"}, {"Speedwave-Test", "INBOX", "Nested"}, ¬
            {"root", "root", "local1"}, {{7, 8, 9}, {10}, {}}, {missing value, "an account", missing value}}
        """

    private func script(_ harness: MailCommandHarness) throws -> String {
        try XCTUnwrap(harness.executor.calls.first?.script)
    }

    private func rowsTail(of script: String) throws -> String {
        let end = try XCTUnwrap(script.range(of: "end tell", options: .backwards))
        return String(script[end.upperBound...])
    }

    func testMailboxesBecomeRowsWithTheirPathInTheAccountAndTheirMessageCountInRealAppleScript() throws {
        let harness = MailCommandHarness()
        harness.executor.reply("")
        _ = try harness.call("list_mailboxes")

        let output = try osascriptExecutor(syntheticScopes + (try rowsTail(of: try script(harness))), 15)

        let rows = AppleMailClient.parseMailboxes(output)
        XCTAssertEqual(rows.map { $0["account"] as? String }, ["Work", "Work", "Work", "Work", "On My Mac", "On My Mac"])
        XCTAssertEqual(
            rows.map { $0["name"] as? String },
            ["Clients", "Clients/Acme", "Inbox", "Clients/Acme/2026", "Speedwave-Test", "Speedwave-Test/Nested"])
        XCTAssertEqual(rows.map { $0["message_count"] as? Int }, [2, 0, 1, 3, 3, 0])
    }

    func testEveryAccountIsReadWithAFewBulkRequestsInsteadOfSeveralPerMailbox() throws {
        let harness = MailCommandHarness()
        harness.executor.reply("")

        _ = try harness.call("list_mailboxes")

        let script = try script(harness)
        XCTAssertEqual(harness.executor.calls.count, 1)
        for read in [
            "every mailbox of spwAcct", "name of every mailbox of spwAcct", "container of every mailbox of spwAcct",
            "id of every message of every mailbox of spwAcct", "account of every mailbox",
        ] {
            XCTAssertTrue(script.contains(read), "\(read):\n\(script)")
        }
        for perMailbox in ["count of messages of", "repeat with mbRef", "class of"] {
            XCTAssertFalse(script.contains(perMailbox), "\(perMailbox):\n\(script)")
        }
    }

    func testMailboxesThatChangedBetweenTheBulkReadsFailInsteadOfMisnamingOne() throws {
        let harness = MailCommandHarness()
        harness.executor.reply("")
        _ = try harness.call("list_mailboxes")
        let torn = """
            set spwScopes to {{"Work", {"box1", "box2"}, {"Inbox"}, {"work", "work"}, {{}, {}}, missing value}}
            """

        XCTAssertThrowsError(try osascriptExecutor(torn + (try rowsTail(of: try script(harness))), 15)) { error in
            XCTAssertTrue("\(error)".contains(mailboxesChangedMarker), "\(error)")
        }
    }

    func testMailboxesThatChangedBetweenTheBulkReadsAreReportedAsARetryableFailure() {
        let harness = MailCommandHarness()
        harness.executor.fail(ScriptError.scriptFailed("\(mailboxesChangedMarker) (-2700)"))

        let error = harness.callFailing("list_mailboxes")

        XCTAssertEqual(error as? MailFailure, .mailboxesChanged)
        XCTAssertTrue(error.localizedDescription.hasPrefix("MAIL_MAILBOX_CHANGED: "), error.localizedDescription)
    }
}
