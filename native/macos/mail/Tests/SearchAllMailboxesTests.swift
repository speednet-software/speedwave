import SharedCLI
import XCTest
@testable import mail_cli

final class SearchAllMailboxesTests: XCTestCase {
    private let harness = MailCommandHarness()

    private let syntheticScopes = """
        set spwD1 to current date
        set day of spwD1 to 1
        set year of spwD1 to 2026
        set month of spwD1 to 10
        set day of spwD1 to 20
        set time of spwD1 to 33300
        set spwD2 to current date
        set day of spwD2 to 1
        set year of spwD2 to 2026
        set month of spwD2 to 10
        set day of spwD2 to 10
        set time of spwD2 to 45000
        set spwD3 to current date
        set day of spwD3 to 1
        set year of spwD3 to 2026
        set month of spwD3 to 10
        set day of spwD3 to 1
        set time of spwD3 to 28800
        set spwScopes to {}
        set end of spwScopes to {"Work", {"box1", "box2", "box3", "box4", "box5"}, ¬
            {"Inbox", "Clients", "Acme", "Deleted Items", "Junk Email"}, {"work", "work", "box2", "work", "work"}, ¬
            missing value, "box4", "box5", ¬
            {{{"<a@x>"}, {}, {"<c@x>"}, {"<t@x>"}, {"<j@x>"}}, ¬
            {{"Hello"}, {}, {"Zażółć 東京"}, {"Old"}, {"Spam"}}, ¬
            {{"Anna <anna@x>"}, {}, {"Ewa <ewa@x>"}, {"T <t@x>"}, {"J <j@x>"}}, ¬
            {{spwD1}, {}, {spwD3}, {spwD2}, {spwD2}}, ¬
            {{false}, {}, {true}, {true}, {true}}, ¬
            {{-1}, {}, {2}, {-1}, {-1}}, ¬
            {{{"a.pdf", "b.png"}}, {}, {{}}, {{"t.txt"}}, {{}}}}, "Work-ID"}
        set end of spwScopes to {"Empty", {}, {}, {}, missing value, missing value, missing value, {{}, {}, {}, {}, {}, {}, {}}, "Empty-ID"}
        set end of spwScopes to {"On My Mac", {"local1", "local2"}, {"Speedwave-Test", "Shared"}, {"root", "root"}, ¬
            {missing value, "an account"}, missing value, missing value, ¬
            {{{"<l@x>"}, {"<z@x>"}}, {{"Local"}, {"Not local"}}, {{"L <l@x>"}, {"Z <z@x>"}}, ¬
            {{spwD2}, {spwD2}}, {{true}, {true}}, {{-1}, {-1}}, {{{"x"}}, {{}}}}, ""}
        """

    private func script() throws -> String {
        try XCTUnwrap(harness.executor.calls.first?.script)
    }

    private func sectionsTail(of script: String) throws -> String {
        let end = try XCTUnwrap(script.range(of: "end tell", options: .backwards))
        return String(script[end.upperBound...])
    }

    private func searchSyntheticMailboxes(_ params: [String: Any]) throws -> [String: Any] {
        harness.executor.reply("")
        _ = try harness.call("search_emails", ["query": "x"])
        let output = try osascriptExecutor(syntheticScopes + (try sectionsTail(of: try script())), 15)
        harness.executor.reply(output)
        return try harness.call("search_emails", params)
    }

    func testWithoutAMailboxEveryMailboxOfEveryAccountAndOnMyMacIsOnePageNewestFirst() throws {
        let result = try searchSyntheticMailboxes(["query": "x"])

        let rows = try XCTUnwrap(result["emails"] as? [[String: Any]])
        XCTAssertEqual(rows.map { $0["subject"] as? String }, ["Hello", "Local", "Zażółć 東京"])
        XCTAssertEqual(rows.map { $0["mailbox"] as? String }, ["Inbox", "Speedwave-Test", "Clients/Acme"])
        XCTAssertEqual(rows.map { $0["account"] as? String }, ["Work", "On My Mac", "Work"])
        XCTAssertEqual(rows.map { $0["flag"] as? String }, ["none", "none", "yellow"])
        XCTAssertEqual(rows.map { $0["read"] as? Bool }, [false, true, true])
        XCTAssertEqual(rows.map { $0["attachment_count"] as? Int }, [2, 1, 0])
        XCTAssertEqual(result["total"] as? Int, 3)
    }

    func testSeparatorCharactersInASubjectOrAMailboxNameAreDroppedInsteadOfBreakingTheSearchInRealAppleScript() throws {
        harness.executor.reply("")
        _ = try harness.call("search_emails", ["query": "x"])
        let crafted = syntheticScopes
            .replacingOccurrences(of: "{{\"Hello\"}", with: "{{\"He\" & (character id 28) & \"l\" & (character id 29) & \"lo\"}")
            .replacingOccurrences(of: "\"Inbox\", \"Clients\"", with: "\"In\" & (character id 30) & \"box\", \"Clients\"")
        let output = try osascriptExecutor(crafted + (try sectionsTail(of: try script())), 15)
        harness.executor.reply(output)

        let result = try harness.call("search_emails", ["query": "x"])

        let rows = try XCTUnwrap(result["emails"] as? [[String: Any]])
        XCTAssertEqual(rows.first?["subject"] as? String, "Hello")
        XCTAssertEqual(rows.first?["mailbox"] as? String, "Inbox")
        XCTAssertEqual(result["total"] as? Int, 3)
    }

    func testAttachmentsAreReadForEveryMailboxOfTheAccountInOneRequest() throws {
        harness.executor.reply("")

        _ = try harness.call("search_emails", ["query": "x"])

        let script = try script()
        XCTAssertTrue(
            script.contains(
                "name of mail attachments of (every message of every mailbox of spwAcct whose "
                    + "(subject contains \"x\" or sender contains \"x\"))\n"),
            script)
        XCTAssertTrue(
            script.contains(
                "name of mail attachments of (every message of every mailbox whose "
                    + "(subject contains \"x\" or sender contains \"x\"))\n"),
            script)
    }

    func testEachRowsMailIdNamesTheMailboxTheMailIsIn() throws {
        let result = try searchSyntheticMailboxes(["query": "x"])

        let ids = try XCTUnwrap(result["emails"] as? [[String: Any]]).compactMap { $0["id"] as? String }
        XCTAssertEqual(
            try ids.map { try MailId(decoding: $0) },
            [
                MailId(accountId: "Work-ID", account: "Work", mailbox: "Inbox", messageId: "<a@x>"),
                MailId(accountId: "", account: AppleMailClient.localAccountName, mailbox: "Speedwave-Test", messageId: "<l@x>"),
                MailId(accountId: "Work-ID", account: "Work", mailbox: "Clients/Acme", messageId: "<c@x>"),
            ])
    }

    func testOffsetAndLimitPageTheWholeResultAndTotalCountsEveryMailbox() throws {
        let result = try searchSyntheticMailboxes(["query": "x", "offset": 1, "limit": 1])

        XCTAssertEqual((result["emails"] as? [[String: Any]])?.map { $0["subject"] as? String }, ["Local"])
        XCTAssertEqual(result["total"] as? Int, 3)
    }

    func testNoHitsInAnyMailboxListNothing() throws {
        harness.executor.reply("")

        let result = try harness.call("search_emails", ["sender": "nobody@x"])

        XCTAssertEqual((result["emails"] as? [[String: Any]])?.count, 0)
        XCTAssertEqual(result["total"] as? Int, 0)
    }

    func testEveryAccountIsReadWithOneBulkRequestPerPropertyInsteadOfAMailboxLoop() throws {
        harness.executor.reply("")

        _ = try harness.call("search_emails", ["query": "invoice", "unread_only": true])

        let script = try script()
        XCTAssertEqual(harness.executor.calls.count, 1)
        let accountScope = "every message of every mailbox of spwAcct whose read status is false and "
            + "(subject contains \"invoice\" or sender contains \"invoice\")"
        let localScope = "every message of every mailbox whose read status is false and "
        for property in ["message id", "subject", "sender", "date received", "read status", "flag index"] {
            XCTAssertTrue(script.contains("\(property) of \(accountScope)"), "\(property):\n\(script)")
            XCTAssertTrue(script.contains("\(property) of \(localScope)"), "\(property):\n\(script)")
        }
        XCTAssertTrue(script.contains("repeat with spwAcctRef in accounts"), script)
        XCTAssertTrue(script.contains("container of every mailbox of spwAcct"), script)
        XCTAssertTrue(script.contains("account of every mailbox"), script)
        XCTAssertFalse(script.contains(" of mb"), script)
    }

    func testTrashAndJunkAreFoundByTheirOwnerLikeTheTrashOfADeleteNotByName() throws {
        harness.executor.reply("")

        _ = try harness.call("search_emails", ["query": "x"])

        let script = try script()
        XCTAssertTrue(script.contains(accountSpecialLookup("trash mailbox", into: "spwTrash")), script)
        XCTAssertTrue(script.contains(accountSpecialLookup("junk mailbox", into: "spwJunk")), script)
        XCTAssertFalse(script.contains("\"Deleted"), script)
        XCTAssertFalse(script.contains("\"Junk"), script)
    }

    func testAnAccountWithoutAMailboxSearchesOnlyThatAccount() throws {
        harness.executor.reply("")

        _ = try harness.call("search_emails", ["query": "x", "account": #"Work "A""#])

        let script = try script()
        XCTAssertTrue(script.contains(#"every account whose name is "Work \"A\"""#), script)
        XCTAssertTrue(script.contains("repeat with spwAcctRef in {spwNamedAcct}"), script)
        XCTAssertFalse(script.contains("account of every mailbox"), script)
    }

    func testOnMyMacWithoutAMailboxSearchesOnlyTheOnMyMacMailboxes() throws {
        harness.executor.reply("")

        _ = try harness.call("search_emails", ["query": "x", "account": AppleMailClient.localAccountName])

        let script = try script()
        XCTAssertTrue(script.contains("account of every mailbox"), script)
        XCTAssertFalse(script.contains("spwAcctRef"), script)
    }

    func testAnUnknownAccountIsReportedAsAccountNotFound() {
        harness.executor.fail(ScriptError.scriptFailed("\(accountNotFoundMarker) (-2700)"))

        let error = harness.callFailing("search_emails", ["query": "x", "account": "Nope"])

        XCTAssertEqual(error as? MailFailure, .accountNotFound("Nope"))
    }

    func testAMailboxListThatChangedBetweenTheBulkReadsFailsAsMailboxesChanged() throws {
        harness.executor.reply("")
        _ = try harness.call("search_emails", ["query": "x"])
        let torn = """
            set spwScopes to {{"Work", {"box1", "box2"}, {"Inbox", "Sent"}, {"work", "work"}, missing value, ¬
                missing value, missing value, {{{}, {}}, {{}}, {{}, {}}, {{}, {}}, {{}, {}}, {{}, {}}, {{}, {}}}}}
            """

        XCTAssertThrowsError(try osascriptExecutor(torn + (try sectionsTail(of: try script())), 15)) { error in
            XCTAssertTrue("\(error)".contains(mailboxesChangedMarker), "\(error)")
        }
    }

    func testAMailboxWhoseColumnsDifferInLengthFailsAsThatMailboxChanged() {
        let section = ["Work", "Work-ID", "Inbox", "<a@x>\u{1E}<b@x>", "One", "A", "", "true", "-1", "0"]
            .joined(separator: "\u{1D}")
        harness.executor.reply(section)

        let error = harness.callFailing("search_emails", ["query": "x"])

        XCTAssertEqual(error as? MailFailure, .mailboxChanged(mailbox: "Inbox"))
    }

    func testAnExplicitTrashMailboxIsStillSearched() throws {
        harness.executor.reply(mailListing(account: "Work", []))

        _ = try harness.call("search_emails", ["query": "x", "mailbox": "Deleted Items", "account": "Work"])

        let script = try script()
        XCTAssertTrue(script.contains("mailbox \"Deleted Items\" of spwAcct"), script)
        XCTAssertFalse(script.contains("spwTrash"), script)
    }

    private func section(_ account: String, _ path: String, ids: [String], flag: Int = -1, read: Bool = true) -> String {
        let column = { (value: String) in ids.map { _ in value }.joined(separator: "\u{1E}") }
        return [
            account, "\(account)-ID", path, ids.joined(separator: "\u{1E}"), column("Hi"), column("Anna <a@x>"),
            column("2026-10-20T09:15:00"), column(read ? "true" : "false"), column("\(flag)"), column("0"),
        ].joined(separator: "\u{1D}")
    }

    func testAGmailMailInSeveralLabelFoldersIsOneResultFromItsInboxAndCountsOnce() throws {
        harness.executor.reply([
            section("Gmail", "[Gmail]/All Mail", ids: ["<g@x>", "<h@x>"]),
            section("Gmail", "Projects", ids: ["<g@x>"], flag: 0, read: false),
            section("Gmail", "INBOX", ids: ["<g@x>"], flag: 0, read: false),
            section("Gmail", "[Gmail]/Important", ids: ["<h@x>"]),
            section("Work", "Inbox", ids: ["<g@x>"]),
        ].joined(separator: "\u{1C}"))

        let result = try harness.call("search_emails", ["flagged_only": true])

        let rows = try XCTUnwrap(result["emails"] as? [[String: Any]])
        XCTAssertEqual(result["total"] as? Int, 3)
        let mailboxes = rows.map { "\($0["account"] as? String ?? "")/\($0["mailbox"] as? String ?? "")" }
        XCTAssertEqual(Set(mailboxes), ["Gmail/INBOX", "Gmail/[Gmail]/All Mail", "Work/Inbox"])
        let gmailInbox = try XCTUnwrap(rows.first { $0["mailbox"] as? String == "INBOX" })
        XCTAssertEqual(gmailInbox["flag"] as? String, "red")
    }

    func testAMailInOneMailboxOfANonGmailAccountKeepsThatMailbox() throws {
        harness.executor.reply([
            section("Work", "Archive", ids: ["<a@x>"]),
            section("Work", "Projects/Trash", ids: ["<b@x>"]),
        ].joined(separator: "\u{1C}"))

        let result = try harness.call("search_emails", ["query": "x"])

        XCTAssertEqual(result["total"] as? Int, 2)
    }

    func testABodySearchWithoutAMailboxRunsNothing() {
        let error = harness.callFailing("search_emails", ["query": "x", "search_body": true])

        guard case MailError.missingField("mailbox") = error else {
            return XCTFail("expected missingField(mailbox), got \(error)")
        }
        XCTAssertTrue(harness.executor.calls.isEmpty)
    }
}
