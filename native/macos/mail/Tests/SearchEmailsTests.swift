import SharedCLI
import XCTest
@testable import mail_cli

final class SearchEmailsTests: XCTestCase {
    private let harness = MailCommandHarness()

    private let messages = [
        ListingRow(messageId: "<old@x>", subject: "Invoice 1", sender: "Anna <anna@x>", received: "2026-10-01T08:00:00", read: true),
        ListingRow(messageId: "<new@x>", subject: "Invoice 3", sender: "Bob <bob@x>", received: "2026-10-20T09:15:00", read: false),
        ListingRow(messageId: "<mid@x>", subject: "Invoice 2", sender: "Ewa <ewa@x>", received: "2026-10-10T12:30:00", read: true),
    ]

    private func emails(_ result: [String: Any]) throws -> [[String: Any]] {
        try XCTUnwrap(result["emails"] as? [[String: Any]])
    }

    private func script() throws -> String {
        XCTAssertEqual(harness.executor.calls.count, 1)
        return try XCTUnwrap(harness.executor.calls.first?.script)
    }

    func testFindsHitsNewestFirstWithMailIdsReadStateAndTheTotal() throws {
        harness.executor.reply(mailListing(account: "Work", messages))

        let result = try harness.call("search_emails", ["query": "invoice", "mailbox": "INBOX", "account": "Work"])

        let rows = try emails(result)
        XCTAssertEqual(rows.map { $0["subject"] as? String }, ["Invoice 3", "Invoice 2", "Invoice 1"])
        XCTAssertEqual(result["total"] as? Int, 3)
        let newest = try XCTUnwrap(rows.first)
        XCTAssertEqual(
            try MailId(decoding: try XCTUnwrap(newest["id"] as? String)),
            MailId(account: "Work", mailbox: "INBOX", messageId: "<new@x>"))
        XCTAssertEqual(newest["read"] as? Bool, false)
        XCTAssertNotNil(parseISO8601(try XCTUnwrap(newest["date"] as? String)))
        XCTAssertEqual(newest["mailbox"] as? String, "INBOX")
        XCTAssertEqual(newest["account"] as? String, "Work")
    }

    func testTheDefaultSearchAsksMailForSubjectOrSenderMatchesInBulkWithoutReadingBodies() throws {
        harness.executor.reply(mailListing(account: "Work", messages))

        _ = try harness.call("search_emails", ["query": "invoice", "mailbox": "Archive", "account": "Work"])

        let script = try script()
        let scope = "every message of mb whose (subject contains \"invoice\" or sender contains \"invoice\")"
        for property in ["message id", "subject", "sender", "date received", "read status"] {
            XCTAssertTrue(script.contains("\(property) of \(scope)"), "\(property): \(script)")
        }
        XCTAssertTrue(script.contains("mailbox \"Archive\" of spwAcct"), script)
        XCTAssertFalse(script.contains("content contains"), script)
        XCTAssertFalse(script.contains("repeat with m in"), script)
    }

    func testNoHitsListNothingWithATotalOfZero() throws {
        harness.executor.reply(mailListing(account: "Work", []))

        let result = try harness.call("search_emails", ["query": "nothing like this", "mailbox": "INBOX"])

        XCTAssertEqual(try emails(result).count, 0)
        XCTAssertEqual(result["total"] as? Int, 0)
    }

    func testAUnicodeQueryReachesMailUnchanged() throws {
        harness.executor.reply(mailListing(account: "Work", []))

        _ = try harness.call("search_emails", ["query": "Zażółć 東京 🚀", "mailbox": "INBOX"])

        XCTAssertTrue(try script().contains("subject contains \"Zażółć 東京 🚀\""))
    }

    func testQuotesAndBackslashesInTheQueryAndSenderAreEscapedForAppleScript() throws {
        harness.executor.reply(mailListing(account: "Work", []))

        _ = try harness.call(
            "search_emails",
            ["query": #"say "hi" \ now"#, "sender": #"o"brien\"#, "mailbox": "INBOX"])

        let script = try script()
        XCTAssertTrue(script.contains(#"subject contains "say \"hi\" \\ now""#), script)
        XCTAssertTrue(script.contains(#"sender contains "o\"brien\\""#), script)
        XCTAssertFalse(script.contains(#""hi" \ now"#), script)
    }

    func testOffsetAndLimitPageTheHitsNewestFirst() throws {
        harness.executor.reply(mailListing(account: "Work", messages))

        let result = try harness.call(
            "search_emails", ["query": "invoice", "mailbox": "INBOX", "offset": 1, "limit": 1])

        XCTAssertEqual(try emails(result).map { $0["subject"] as? String }, ["Invoice 2"])
        XCTAssertEqual(result["total"] as? Int, 3)
    }

    func testSenderAndUnreadFiltersAreEvaluatedByMail() throws {
        harness.executor.reply(mailListing(account: "Work", [messages[1]]))

        let result = try harness.call(
            "search_emails",
            ["query": "invoice", "mailbox": "INBOX", "sender": "bob@x", "unread_only": true])

        let script = try script()
        XCTAssertTrue(
            script.contains(
                "subject of every message of mb whose read status is false and sender contains \"bob@x\" and "
                    + "(subject contains \"invoice\" or sender contains \"invoice\")"),
            script)
        XCTAssertEqual(try emails(result).map { $0["subject"] as? String }, ["Invoice 3"])
    }

    func testFlaggedOnlyJoinsTheOtherConditionsMailEvaluatesAndRowsCarryTheirFlag() throws {
        var flagged = messages[1]
        flagged.flag = 2
        harness.executor.reply(mailListing(account: "Work", [flagged]))

        let result = try harness.call(
            "search_emails",
            [
                "query": "invoice", "mailbox": "INBOX", "sender": "bob@x", "since": "2026-10-05",
                "unread_only": true, "flagged_only": true,
            ])

        let script = try script()
        let scope = "every message of mb whose read status is false and flagged status is true and "
            + "sender contains \"bob@x\" and date received is greater than or equal to spwSince and "
            + "(subject contains \"invoice\" or sender contains \"invoice\")"
        for property in ["message id", "subject", "flag index"] {
            XCTAssertTrue(script.contains("\(property) of \(scope)"), "\(property): \(script)")
        }
        XCTAssertEqual(try emails(result).map { $0["flag"] as? String }, ["yellow"])
    }

    func testABodySearchKeepsTheFlaggedConditionInItsContentScan() throws {
        harness.executor.reply(mailListing(account: "Work", messages, matchedIds: []))

        _ = try harness.call(
            "search_emails", ["query": "net 30", "mailbox": "INBOX", "search_body": true, "flagged_only": true])

        XCTAssertTrue(
            try script().contains(
                "message id of every message of mb whose flagged status is true and "
                    + "(subject contains \"net 30\" or sender contains \"net 30\" or content contains \"net 30\")"))
    }

    func testADateRangeIsBuiltFromLocalCalendarFieldsAndFilteredByMail() throws {
        harness.executor.reply(mailListing(account: "Work", []))

        _ = try harness.call(
            "search_emails",
            ["query": "invoice", "mailbox": "INBOX", "since": "2026-10-05", "before": "2026-10-20T09:30:15"])

        let script = try script()
        for line in [
            "set spwSince to current date",
            "set day of spwSince to 1",
            "set year of spwSince to 2026",
            "set month of spwSince to 10",
            "set day of spwSince to 5",
            "set time of spwSince to 0",
            "set day of spwBefore to 20",
            "set time of spwBefore to 34215",
        ] {
            XCTAssertTrue(script.contains(line), "\(line): \(script)")
        }
        XCTAssertTrue(
            script.contains(
                "whose date received is greater than or equal to spwSince and date received is less than spwBefore and "),
            script)
        XCTAssertLessThan(
            try XCTUnwrap(script.range(of: "set spwSince to current date")).lowerBound,
            try XCTUnwrap(script.range(of: "tell application \"Mail\"")).lowerBound)
    }

    func testABodySearchScansContentOnceAndKeepsOnlyTheMessagesItMatched() throws {
        harness.executor.reply(mailListing(account: "Work", messages, matchedIds: ["<mid@x>", "<old@x>"]))

        let result = try harness.call(
            "search_emails", ["query": "net 30", "mailbox": "INBOX", "search_body": true, "unread_only": true])

        let script = try script()
        XCTAssertEqual(script.components(separatedBy: "content contains").count - 1, 1, script)
        XCTAssertTrue(
            script.contains(
                "message id of every message of mb whose read status is false and "
                    + "(subject contains \"net 30\" or sender contains \"net 30\" or content contains \"net 30\")"),
            script)
        XCTAssertTrue(script.contains("subject of every message of mb whose read status is false\n"), script)
        XCTAssertEqual(try emails(result).map { $0["subject"] as? String }, ["Invoice 2", "Invoice 1"])
        XCTAssertEqual(result["total"] as? Int, 2)
    }

    func testABodySearchWithoutHitsListsNothing() throws {
        harness.executor.reply(mailListing(account: "Work", messages, matchedIds: []))

        let result = try harness.call("search_emails", ["query": "x", "mailbox": "INBOX", "search_body": true])

        XCTAssertEqual(try emails(result).count, 0)
        XCTAssertEqual(result["total"] as? Int, 0)
    }

    func testAnInvalidDateRunsNothing() {
        for (name, value) in [("since", "yesterday"), ("before", "2026-13-01"), ("since", "20")] as [(String, Any)] {
            let error = harness.callFailing("search_emails", ["query": "x", "mailbox": "INBOX", name: value])
            guard case MailError.invalidValue(name, _) = error else {
                return XCTFail("expected invalidValue(\(name)) for \(value), got \(error)")
            }
        }
        XCTAssertTrue(harness.executor.calls.isEmpty)
    }

    func testAMissingOrEmptyQueryOrABadPageRunsNothing() {
        let cases: [[String: Any]] = [
            ["mailbox": "INBOX"],
            ["mailbox": "INBOX", "query": ""],
            ["mailbox": "INBOX", "query": "x", "limit": 0],
            ["mailbox": "INBOX", "query": "x", "offset": -1],
        ]
        for params in cases {
            XCTAssertNotNil(harness.callFailing("search_emails", params) as? MailError, "\(params)")
        }
        XCTAssertTrue(harness.executor.calls.isEmpty)
    }
}
