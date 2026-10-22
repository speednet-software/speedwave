import SharedCLI
import XCTest
@testable import mail_cli

final class ListEmailsTests: XCTestCase {
    private let harness = MailCommandHarness()

    private func localISO(_ year: Int, _ month: Int, _ day: Int, _ hour: Int, _ minute: Int) throws -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .current
        let date = try XCTUnwrap(
            calendar.date(from: DateComponents(year: year, month: month, day: day, hour: hour, minute: minute)))
        return iso8601String(from: date, timeZone: .current)
    }

    private func emails(_ result: [String: Any]) throws -> [[String: Any]] {
        try XCTUnwrap(result["emails"] as? [[String: Any]])
    }

    private let threeMessages = [
        ListingRow(messageId: "<old@x>", subject: "Old", sender: "Anna <anna@x>", received: "2026-10-01T08:00:00", read: true),
        ListingRow(messageId: "<new@x>", subject: "New", sender: "Bob <bob@x>", received: "2026-10-20T09:15:00", read: false),
        ListingRow(messageId: "<mid@x>", subject: "Mid", sender: "Ewa <ewa@x>", received: "2026-10-10T12:30:00", read: true),
    ]

    func testListsTheNewestFirstWithMailIdsIsoDatesAndTheTotal() throws {
        harness.executor.reply(mailListing(account: "Work", threeMessages))

        let result = try harness.call("list_emails", ["mailbox": "INBOX", "account": "Work"])

        let rows = try emails(result)
        XCTAssertEqual(rows.map { $0["subject"] as? String }, ["New", "Mid", "Old"])
        XCTAssertEqual(result["total"] as? Int, 3)
        let newest = try XCTUnwrap(rows.first)
        XCTAssertEqual(
            try MailId(decoding: try XCTUnwrap(newest["id"] as? String)),
            MailId(accountId: "Work-ID", account: "Work", mailbox: "INBOX", messageId: "<new@x>"))
        XCTAssertEqual(newest["sender"] as? String, "Bob <bob@x>")
        XCTAssertEqual(newest["read"] as? Bool, false)
        XCTAssertEqual(newest["date"] as? String, try localISO(2026, 10, 20, 9, 15))
        XCTAssertEqual(newest["mailbox"] as? String, "INBOX")
        XCTAssertEqual(newest["account"] as? String, "Work")
    }

    func testTheIdCarriesTheAccountTheLookupResolvedWhenNoneWasGiven() throws {
        harness.executor.reply(mailListing(account: "On My Mac", Array(threeMessages.prefix(1))))

        let result = try harness.call("list_emails", ["mailbox": "Speedwave-Test"])

        let id = try XCTUnwrap(try emails(result).first?["id"] as? String)
        XCTAssertEqual(try MailId(decoding: id).account, "On My Mac")
        XCTAssertEqual(try emails(result).first?["account"] as? String, "On My Mac")
    }

    func testOffsetAndLimitPageThroughTheNewestFirstOrder() throws {
        let cases: [(offset: Int, limit: Int, subjects: [String])] = [
            (0, 2, ["New", "Mid"]),
            (2, 2, ["Old"]),
            (1, 1, ["Mid"]),
            (3, 10, []),
            (50, 10, []),
        ]
        for (offset, limit, subjects) in cases {
            harness.executor.reply(mailListing(account: "Work", threeMessages))

            let result = try harness.call(
                "list_emails", ["mailbox": "INBOX", "account": "Work", "offset": offset, "limit": limit])

            XCTAssertEqual(try emails(result).map { $0["subject"] as? String }, subjects, "offset \(offset)")
            XCTAssertEqual(result["total"] as? Int, 3)
        }
    }

    func testTheDefaultPageIsTheTenNewest() throws {
        let rows = (1...12).map { day in
            ListingRow(messageId: "<\(day)@x>", subject: "\(day)", sender: "a", received: String(format: "2026-10-%02dT10:00:00", day), read: true)
        }
        harness.executor.reply(mailListing(account: "Work", rows))

        let result = try harness.call("list_emails", ["mailbox": "INBOX", "account": "Work"])

        XCTAssertEqual(try emails(result).map { $0["subject"] as? String }, (3...12).reversed().map { "\($0)" })
        XCTAssertEqual(result["total"] as? Int, 12)
    }

    func testAnEmptyMailboxListsNothingWithATotalOfZero() throws {
        harness.executor.reply(mailListing(account: "Work", []))

        let result = try harness.call("list_emails", ["mailbox": "Archive", "account": "Work"])

        XCTAssertEqual(try emails(result).count, 0)
        XCTAssertEqual(result["total"] as? Int, 0)
    }

    func testAMessageWithoutAReadableDateIsListedLastWithoutADate() throws {
        let rows = [
            ListingRow(messageId: "<nodate@x>", subject: "NoDate", sender: "a", received: "", read: true),
            threeMessages[0],
        ]
        harness.executor.reply(mailListing(account: "Work", rows))

        let result = try harness.call("list_emails", ["mailbox": "INBOX", "account": "Work"])

        let listed = try emails(result)
        XCTAssertEqual(listed.map { $0["subject"] as? String }, ["Old", "NoDate"])
        XCTAssertNil(listed.last?["date"])
    }

    func testTheScriptReadsEachPropertyOfTheWholeMailboxInOneRequest() throws {
        harness.executor.reply(mailListing(account: "Work", threeMessages))

        _ = try harness.call("list_emails", ["mailbox": "Archive", "account": "Work", "limit": 2])

        let script = try XCTUnwrap(harness.executor.calls.first?.script)
        XCTAssertEqual(harness.executor.calls.count, 1)
        XCTAssertTrue(script.contains("mailbox \"Archive\" of spwAcct"), script)
        for property in ["message id", "subject", "sender", "date received", "read status"] {
            XCTAssertTrue(script.contains("\(property) of every message of mb"), "\(property): \(script)")
        }
        XCTAssertFalse(script.contains("message i of mb"), script)
        XCTAssertFalse(script.contains("of m\n"), script)
        XCTAssertFalse(script.contains("whose read status"), script)
        XCTAssertFalse(script.contains("set mb to inbox"), script)
    }

    func testUnreadOnlyAsksMailForTheUnreadMessagesOnly() throws {
        harness.executor.reply(mailListing(account: "Work", [threeMessages[1]]))

        let result = try harness.call("list_emails", ["mailbox": "INBOX", "account": "Work", "unread_only": true])

        let script = try XCTUnwrap(harness.executor.calls.first?.script)
        for property in ["message id", "subject", "sender", "date received", "read status"] {
            XCTAssertTrue(
                script.contains("\(property) of every message of mb whose read status is false"),
                "\(property): \(script)")
        }
        XCTAssertEqual(try emails(result).map { $0["subject"] as? String }, ["New"])
        XCTAssertEqual(result["total"] as? Int, 1)
    }

    func testEachRowCarriesItsFlagColorOrNoneWhenUnflagged() throws {
        let rows = mailFlagColors.indices.map { index in
            ListingRow(
                messageId: "<\(index)@x>", subject: "\(index)", sender: "a",
                received: String(format: "2026-10-%02dT10:00:00", index + 1), read: true, flag: index)
        } + [ListingRow(messageId: "<off@x>", subject: "off", sender: "a", received: "", read: true, flag: -1)]
        harness.executor.reply(mailListing(account: "Work", rows))

        let result = try harness.call("list_emails", ["mailbox": "INBOX", "account": "Work", "limit": 20])

        let flags = Dictionary(
            uniqueKeysWithValues: try emails(result).map { ($0["subject"] as? String ?? "", $0["flag"] as? String) })
        XCTAssertEqual(
            flags,
            ["0": "red", "1": "orange", "2": "yellow", "3": "green", "4": "blue", "5": "purple", "6": "gray", "off": "none"])
    }

    func testAFlagIndexOutsideMailsColorsListsAsNone() throws {
        let rows = [7, 42, -2].map { index in
            ListingRow(messageId: "<\(index)@x>", subject: "\(index)", sender: "a", received: "", read: true, flag: index)
        }
        harness.executor.reply(mailListing(account: "Work", rows))

        let result = try harness.call("list_emails", ["mailbox": "INBOX", "account": "Work"])

        XCTAssertEqual(try emails(result).map { $0["flag"] as? String }, ["none", "none", "none"])
    }

    func testTheScriptReadsTheFlagIndexOfTheSameScopeInOneRequest() throws {
        harness.executor.reply(mailListing(account: "Work", threeMessages))

        _ = try harness.call("list_emails", ["mailbox": "INBOX", "account": "Work", "unread_only": true])

        let script = try XCTUnwrap(harness.executor.calls.first?.script)
        XCTAssertTrue(
            script.contains("set spwFlags to flag index of every message of mb whose read status is false\n"), script)
        XCTAssertTrue(script.contains("spwReads as text, spwFlags as text, spwAttachments as text}"), script)
    }

    func testEachRowCarriesItsAttachmentCount() throws {
        var withTwo = threeMessages[1]
        withTwo.attachments = 2
        harness.executor.reply(mailListing(account: "Work", [threeMessages[0], withTwo]))

        let result = try harness.call("list_emails", ["mailbox": "INBOX", "account": "Work"])

        XCTAssertEqual(try emails(result).map { $0["attachment_count"] as? Int }, [2, 0])
    }

    func testTheScriptReadsTheAttachmentsOfTheSameScopeInOneRequest() throws {
        harness.executor.reply(mailListing(account: "Work", threeMessages))

        _ = try harness.call("list_emails", ["mailbox": "INBOX", "account": "Work", "unread_only": true])

        let script = try XCTUnwrap(harness.executor.calls.first?.script)
        XCTAssertTrue(
            script.contains(
                "set spwAttachments to name of mail attachments of (every message of mb whose read status is false)\n"),
            script)
        XCTAssertEqual(script.components(separatedBy: "mail attachments of").count - 1, 1, script)
    }

    func testTheAttachmentNamesOfEachMessageBecomeItsCountInRealAppleScript() throws {
        harness.executor.reply(mailListing(account: "Work", []))
        _ = try harness.call("list_emails", ["mailbox": "INBOX", "account": "Work"])
        let script = try XCTUnwrap(harness.executor.calls.first?.script)
        let tail = String(script[try XCTUnwrap(script.range(of: "end tell", options: .backwards)).upperBound...])
        let synthetic = """
            set spwAcctName to "Work"
            set spwAcctId to "Work-ID"
            set spwIds to {"<a@x>", "<b@x>", "<c@x>"}
            set spwSubjects to {"A", "B", "C"}
            set spwSenders to {"a", "b", "c"}
            set spwDates to {missing value, missing value, missing value}
            set spwReads to {true, false, true}
            set spwFlags to {-1, -1, 3}
            set spwAttachments to {{"a.pdf", "Zażółć.png"}, {}, {"x"}}
            """

        harness.executor.reply(try osascriptExecutor(synthetic + tail, 15))
        let result = try harness.call("list_emails", ["mailbox": "INBOX", "account": "Work"])

        let counts = Dictionary(
            uniqueKeysWithValues: try emails(result).map { ($0["subject"] as? String ?? "", $0["attachment_count"] as? Int) })
        XCTAssertEqual(counts, ["A": 2, "B": 0, "C": 1])
    }

    func testFlaggedOnlyAsksMailForTheFlaggedMessagesOnly() throws {
        harness.executor.reply(mailListing(account: "Work", [threeMessages[0]]))

        let result = try harness.call(
            "list_emails", ["mailbox": "INBOX", "account": "Work", "flagged_only": true, "unread_only": true])

        let script = try XCTUnwrap(harness.executor.calls.first?.script)
        for property in ["message id", "subject", "sender", "date received", "read status", "flag index"] {
            XCTAssertTrue(
                script.contains("\(property) of every message of mb whose read status is false and flagged status is true\n"),
                "\(property): \(script)")
        }
        XCTAssertEqual(result["total"] as? Int, 1)
    }

    func testWithoutFlaggedOnlyTheScriptHasNoFlaggedCondition() throws {
        harness.executor.reply(mailListing(account: "Work", threeMessages))

        _ = try harness.call("list_emails", ["mailbox": "INBOX", "account": "Work", "flagged_only": false])

        let script = try XCTUnwrap(harness.executor.calls.first?.script)
        XCTAssertFalse(script.contains("flagged status"), script)
        XCTAssertFalse(script.contains("message of mb whose"), script)
    }

    func testAnEmptyMailboxReadsNoFlags() throws {
        harness.executor.reply(mailListing(account: "Work", []))

        let result = try harness.call("list_emails", ["mailbox": "INBOX", "account": "Work", "flagged_only": true])

        XCTAssertEqual(try emails(result).count, 0)
        XCTAssertEqual(result["total"] as? Int, 0)
    }

    func testAListWhosePropertyCountsDisagreeIsRefusedAsAChangedMailbox() {
        let torn = ["Work", "Work-ID", "<a@x>\u{1E}<b@x>", "A", "s", "2026-10-01T08:00:00", "true", "-1", "0"]
            .joined(separator: "\u{1D}")
        harness.executor.reply(torn)

        let error = harness.callFailing("list_emails", ["mailbox": "INBOX", "account": "Work"])

        XCTAssertEqual(error as? MailFailure, .mailboxChanged(mailbox: "INBOX"))
    }

    func testListEmailsNeedsAMailbox() {
        let error = harness.callFailing("list_emails", [:])
        guard case CLIError.missingField("mailbox") = error else {
            return XCTFail("expected missingField(mailbox), got \(error)")
        }
        XCTAssertTrue(harness.executor.calls.isEmpty)
    }

    func testANegativeOffsetOrANonPositiveLimitRunsNothing() {
        for params in [["offset": -1], ["limit": 0], ["limit": -5]] as [[String: Any]] {
            let error = harness.callFailing("list_emails", params.merging(["mailbox": "INBOX"]) { $1 })
            guard case MailError.invalidValue = error else {
                return XCTFail("expected invalidValue for \(params), got \(error)")
            }
        }
        XCTAssertTrue(harness.executor.calls.isEmpty)
    }
}
