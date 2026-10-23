import SharedCLI
import XCTest
@testable import mail_cli

final class ListingScriptTests: XCTestCase {
    private let harness = MailCommandHarness()
    private let wellWithinTheBudget = TimeInterval(MailCommandHarness.scriptTimeoutMs) / 1000 / 3

    private func tail(of command: String, _ params: [String: Any]) throws -> String {
        let probe = MailCommandHarness()
        probe.executor.reply("")
        _ = try? probe.call(command, params)
        let script = try XCTUnwrap(probe.executor.calls.first?.script)
        let end = try XCTUnwrap(script.range(of: "end tell", options: .backwards))
        return String(script[end.upperBound...])
    }

    private func emails(_ result: [String: Any]) throws -> [[String: Any]] {
        try XCTUnwrap(result["emails"] as? [[String: Any]])
    }

    private func listingValues(count: Int, subject: String = "\"S\" & i") -> String {
        """
        set spwAcctName to "Work"
        set spwAcctId to "Work-ID"
        script spwBuild
            property ids : {}
            property subjects : {}
            property senders : {}
            property spwD : {}
            property reads : {}
            property flags : {}
            property attachments : {}
        end script
        set spwDay to current date
        repeat with i from 1 to \(count)
            set end of spwBuild's ids to "<m" & i & "@x>"
            set end of spwBuild's subjects to \(subject)
            set end of spwBuild's senders to "Anna <anna@x>"
            set end of spwBuild's spwD to spwDay
            set end of spwBuild's reads to (i mod 2 is 0)
            set end of spwBuild's flags to -1
            set end of spwBuild's attachments to {"a.pdf"}
        end repeat
        set spwIds to spwBuild's ids
        set spwSubjects to spwBuild's subjects
        set spwSenders to spwBuild's senders
        set spwDates to spwBuild's spwD
        set spwReads to spwBuild's reads
        set spwFlags to spwBuild's flags
        set spwAttachments to spwBuild's attachments

        """
    }

    func testAMailboxOfSixThousandMailsIsTurnedIntoTextWellWithinTheBudgetInRealAppleScript() throws {
        let params: [String: Any] = ["mailbox": "INBOX", "account": "Work"]
        let script = listingValues(count: 6_000) + (try tail(of: "list_emails", params))
        let started = Date()

        let output = try osascriptExecutor(script, 60)

        XCTAssertLessThan(Date().timeIntervalSince(started), wellWithinTheBudget)
        harness.executor.reply(output)
        let result = try harness.call("list_emails", params.merging(["limit": 2]) { $1 })
        XCTAssertEqual(result["total"] as? Int, 6_000)
        XCTAssertEqual(try emails(result).first?["attachment_count"] as? Int, 1)
    }

    func testSeparatorCharactersInASubjectOrSenderAreDroppedInsteadOfBreakingTheListingInRealAppleScript() throws {
        let params: [String: Any] = ["mailbox": "INBOX", "account": "Work"]
        let crafted = "\"A\" & (character id 30) & \"B\" & (character id 29) & \"C\" & (character id 28) & \"D\" & (character id 31) & i"
        let script = listingValues(count: 3, subject: crafted)
            .replacingOccurrences(of: "\"Anna <anna@x>\"", with: "(\"Ann\" & (character id 29) & \"a\")")
            + (try tail(of: "list_emails", params))

        harness.executor.reply(try osascriptExecutor(script, 15))
        let result = try harness.call("list_emails", params)

        XCTAssertEqual(result["total"] as? Int, 3)
        XCTAssertEqual(Set(try emails(result).compactMap { $0["subject"] as? String }), ["ABCD1", "ABCD2", "ABCD3"])
        XCTAssertEqual(Set(try emails(result).compactMap { $0["sender"] as? String }), ["Anna"])
    }

    func testAMailWithoutAMessageIdIsLeftOutOfTheListingAndCountedApartInRealAppleScript() throws {
        let params: [String: Any] = ["mailbox": "INBOX", "account": "Work"]
        for (count, expectedTotal) in [(1, 0), (3, 2)] {
            let script = listingValues(count: count)
                + "set item 1 of spwIds to missing value\n"
                + (try tail(of: "list_emails", params))

            harness.executor.reply(try osascriptExecutor(script, 15))
            let result = try harness.call("list_emails", params)

            XCTAssertEqual(result["total"] as? Int, expectedTotal, "\(count) mails")
            XCTAssertEqual(try emails(result).count, expectedTotal, "\(count) mails")
            XCTAssertEqual(result["without_id"] as? Int, 1, "\(count) mails")
        }
    }

    func testAListingWhereEveryMailHasAMessageIdCarriesNoCountOfMailsWithout() throws {
        harness.executor.reply(mailListing(account: "Work", [
            ListingRow(messageId: "<a@x>", subject: "A", sender: "s", received: "", read: true),
        ]))

        let result = try harness.call("list_emails", ["mailbox": "INBOX", "account": "Work"])

        XCTAssertNil(result["without_id"])
        XCTAssertEqual(result["total"] as? Int, 1)
    }

    func testABodySearchThatMatchedNothingListsNothingEvenForAMailWithoutAMessageId() throws {
        let rows = [
            ListingRow(messageId: "", subject: "NoId", sender: "s", received: "", read: true),
            ListingRow(messageId: "<a@x>", subject: "A", sender: "s", received: "", read: true),
        ]
        harness.executor.reply(mailListing(account: "Work", rows, matchedIds: []))

        let result = try harness.call(
            "search_emails", ["mailbox": "INBOX", "account": "Work", "query": "x", "search_body": true])

        XCTAssertEqual(try emails(result).count, 0)
        XCTAssertEqual(result["total"] as? Int, 0)
    }

    func testEightHundredNestedMailboxesGetTheirPathsWellWithinTheBudgetInRealAppleScript() throws {
        let scopes = """
            script spwBuild
                property boxes : {}
                property names : {}
                property parents : {}
                property ids : {}
                property unread : {}
            end script
            repeat with i from 1 to 800
                set end of spwBuild's boxes to "box" & i
                set end of spwBuild's names to "N" & i
                if i mod 4 is 1 then
                    set end of spwBuild's parents to "account"
                else
                    set end of spwBuild's parents to "box" & (i - 1)
                end if
                set end of spwBuild's ids to {1, 2}
                set end of spwBuild's unread to 1
            end repeat
            set spwScopes to {{"Work", spwBuild's boxes, spwBuild's names, spwBuild's parents, spwBuild's ids, spwBuild's unread, missing value}}

            """
        let started = Date()

        let output = try osascriptExecutor(scopes + (try tail(of: "list_mailboxes", [:])), 60)

        XCTAssertLessThan(Date().timeIntervalSince(started), wellWithinTheBudget)
        let rows = AppleMailClient.parseMailboxes(output)
        XCTAssertEqual(rows.count, 800)
        XCTAssertEqual(rows[3]["name"] as? String, "N1/N2/N3/N4")
        XCTAssertEqual(rows[4]["name"] as? String, "N5")
        XCTAssertEqual(rows[799]["message_count"] as? Int, 2)
    }

    func testSeparatorsAndLineBreaksInAMailboxNameAreDroppedInsteadOfBreakingTheMailboxListInRealAppleScript() throws {
        let scopes = """
            set spwScopes to {{"Wo||rk", {"box1", "box2"}, {"In" & linefeed & "box", "A" & (character id 30) & "||B"}, ¬
                {"work", "box1"}, {{1}, {}}, {1, 0}, missing value}}

            """

        let output = try osascriptExecutor(scopes + (try tail(of: "list_mailboxes", [:])), 15)

        let rows = AppleMailClient.parseMailboxes(output)
        XCTAssertEqual(rows.map { $0["name"] as? String }, ["In" + "\n" + "box", "In\nbox/A||B"])
        XCTAssertEqual(rows.map { $0["account"] as? String }, ["Wo||rk", "Wo||rk"])
    }
}
