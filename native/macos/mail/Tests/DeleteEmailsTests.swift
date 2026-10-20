import SharedCLI
import XCTest
@testable import mail_cli

final class DeleteEmailsTests: XCTestCase {
    private let harness = MailCommandHarness()

    private let first = MailId(account: "iCloud", mailbox: "INBOX", messageId: "<a@x>")
    private let second = MailId(account: "Work", mailbox: "Archive/2026", messageId: "<b@x>")

    private func row(_ fields: String...) -> String {
        fields.joined(separator: "\u{1F}")
    }

    private func rows(_ rows: String...) -> String {
        rows.joined(separator: "\u{1E}")
    }

    func testWithoutConfirmationNothingIsDeletedAndEachMailIsPreviewedWithTheQuestionForTheUser() throws {
        harness.executor.reply(rows(
            row("ok", "Invoice 12", "Anna <anna@x>", "2026-10-20T09:15:00", ""),
            row("ok", "Lunch?", "Bob <bob@x>", "", "")
        ))

        let result = try harness.call("delete_emails", ["ids": [first.encoded, second.encoded]])

        XCTAssertEqual(harness.executor.calls.count, 1)
        let script = harness.executor.calls[0].script
        XCTAssertFalse(script.contains("move m"), script)
        XCTAssertFalse(script.contains("delete"), script)
        XCTAssertEqual(result["status"] as? String, "confirmation_required")
        XCTAssertEqual(result["confirm_param"] as? String, "confirm_delete")
        let instruction = try XCTUnwrap(result["instruction"] as? String)
        XCTAssertTrue(instruction.contains("Nothing was changed"), instruction)
        XCTAssertTrue(instruction.contains("confirm_delete: true"), instruction)
        XCTAssertTrue(instruction.contains("ask the user"), instruction)
        let emails = try XCTUnwrap(result["emails"] as? [[String: Any]])
        XCTAssertEqual(emails.count, 2)
        XCTAssertEqual(emails[0]["id"] as? String, first.encoded)
        XCTAssertEqual(emails[0]["ok"] as? Bool, true)
        XCTAssertEqual(emails[0]["subject"] as? String, "Invoice 12")
        XCTAssertEqual(emails[0]["sender"] as? String, "Anna <anna@x>")
        XCTAssertEqual(
            (emails[0]["date"] as? String).flatMap(parseISO8601),
            AppleMailClient.localDate("2026-10-20T09:15:00"))
        XCTAssertEqual(emails[0]["mailbox"] as? String, "INBOX")
        XCTAssertEqual(emails[0]["account"] as? String, "iCloud")
        XCTAssertNil(emails[1]["date"])
        XCTAssertEqual(emails[1]["mailbox"] as? String, "Archive/2026")
        XCTAssertEqual(emails[1]["account"] as? String, "Work")
        XCTAssertNil(result["succeeded"])
    }

    func testConfirmationMustBeTheBooleanTrue() throws {
        harness.executor.reply(row("ok", "Invoice 12", "Anna", "", ""))

        let result = try harness.call("delete_emails", ["ids": [first.encoded], "confirm_delete": "true"])

        XCTAssertEqual(result["status"] as? String, "confirmation_required")
        XCTAssertFalse(harness.executor.calls[0].script.contains("move m"))
    }

    func testThePreviewReportsAMailThatIsGoneWithoutFailingTheOthers() throws {
        harness.executor.reply(rows(
            row("ok", "Invoice 12", "Anna", "", ""),
            row("error", "", "", "", "\(mailNotFoundMarker) (-2700)")
        ))

        let result = try harness.call("delete_emails", ["ids": [first.encoded, second.encoded]])

        let emails = try XCTUnwrap(result["emails"] as? [[String: Any]])
        XCTAssertEqual(emails[1]["ok"] as? Bool, false)
        XCTAssertEqual(emails[1]["id"] as? String, second.encoded)
        XCTAssertNil(emails[1]["subject"])
        let error = try XCTUnwrap(emails[1]["error"] as? String)
        XCTAssertTrue(error.hasPrefix("MAIL_NOT_FOUND: "), error)
        XCTAssertTrue(error.contains("Archive/2026"), error)
    }

    func testConfirmedMovesEachMailToTheTrashOfItsOwnAccountAndReportsEveryMail() throws {
        harness.executor.reply(rows(
            row("ok", "Invoice 12", "Anna", "2026-10-20T09:15:00", ""),
            row("ok", "Lunch?", "Bob", "", "")
        ))

        let result = try harness.call(
            "delete_emails", ["ids": [first.encoded, second.encoded], "confirm_delete": true])

        XCTAssertEqual(harness.executor.calls.count, 1)
        let script = harness.executor.calls[0].script
        XCTAssertTrue(script.contains("move m to spwTrash"), script)
        XCTAssertTrue(script.contains("mailboxes of trash mailbox"), script)
        XCTAssertTrue(script.contains("is spwAcctName"), script)
        XCTAssertTrue(script.contains("\"<a@x>\""), script)
        XCTAssertTrue(script.contains("\"<b@x>\""), script)
        XCTAssertTrue(script.contains("mailbox \"Archive/2026\" of"), script)
        XCTAssertEqual(result["status"] as? String, "completed")
        XCTAssertEqual(result["succeeded"] as? Int, 2)
        XCTAssertEqual(result["failed"] as? Int, 0)
        XCTAssertNil(result["instruction"])
        let emails = try XCTUnwrap(result["emails"] as? [[String: Any]])
        XCTAssertEqual(emails.map { $0["ok"] as? Bool }, [true, true])
        XCTAssertEqual(emails.map { $0["subject"] as? String }, ["Invoice 12", "Lunch?"])
    }

    func testNoPathDeletesPermanently() throws {
        harness.executor.reply(row("ok", "s", "a", "", ""))
        _ = try harness.call("delete_emails", ["ids": [first.encoded], "confirm_delete": true])
        harness.executor.reply(row("ok", "s", "a", "", ""))
        _ = try harness.call("delete_emails", ["ids": [first.encoded]])

        for call in harness.executor.calls {
            XCTAssertNil(call.script.range(of: #"\bdelete\b"#, options: .regularExpression), call.script)
            XCTAssertFalse(call.script.contains("deleted status"), call.script)
        }
    }

    func testAPartialFailureNamesWhichMailsWereMovedAndWhyTheOthersWereNot() throws {
        let third = MailId(account: "On My Mac", mailbox: "Speedwave-Test", messageId: "<c@x>")
        harness.executor.reply(rows(
            row("ok", "Invoice 12", "Anna", "", ""),
            row("error", "Lunch?", "Bob", "", "SPW_ALREADY_IN_TRASH (-2700)"),
            row("error", "Old", "Carl", "", "SPW_TRASH_NOT_FOUND (-2700)")
        ))

        let result = try harness.call(
            "delete_emails", ["ids": [first.encoded, second.encoded, third.encoded], "confirm_delete": true])

        XCTAssertEqual(result["status"] as? String, "partial")
        XCTAssertEqual(result["succeeded"] as? Int, 1)
        XCTAssertEqual(result["failed"] as? Int, 2)
        let emails = try XCTUnwrap(result["emails"] as? [[String: Any]])
        XCTAssertEqual(emails.map { $0["ok"] as? Bool }, [true, false, false])
        XCTAssertNil(emails[0]["error"])
        XCTAssertEqual(emails[1]["subject"] as? String, "Lunch?")
        let inTrash = try XCTUnwrap(emails[1]["error"] as? String)
        XCTAssertTrue(inTrash.hasPrefix("MAIL_ALREADY_IN_TRASH: "), inTrash)
        let noTrash = try XCTUnwrap(emails[2]["error"] as? String)
        XCTAssertTrue(noTrash.hasPrefix("MAIL_TRASH_NOT_FOUND: "), noTrash)
        XCTAssertTrue(noTrash.contains("On My Mac"), noTrash)
    }

    func testEveryMailFailingIsReportedAsFailed() throws {
        harness.executor.reply(row("error", "", "", "", "\(mailboxNotFoundMarker) (-2700)"))

        let result = try harness.call("delete_emails", ["ids": [second.encoded], "confirm_delete": true])

        XCTAssertEqual(result["status"] as? String, "failed")
        XCTAssertEqual(result["succeeded"] as? Int, 0)
        let emails = try XCTUnwrap(result["emails"] as? [[String: Any]])
        XCTAssertEqual(
            emails[0]["error"] as? String,
            MailFailure.mailboxNotFound(mailbox: "Archive/2026", account: "Work").localizedDescription)
    }

    func testAnUnknownScriptErrorKeepsItsRealCause() throws {
        harness.executor.reply(row("error", "", "", "", "Mail got an error: Can’t get account. (-1728)"))

        let result = try harness.call("delete_emails", ["ids": [first.encoded], "confirm_delete": true])

        let emails = try XCTUnwrap(result["emails"] as? [[String: Any]])
        XCTAssertEqual(emails[0]["error"] as? String, "Mail got an error: Can’t get account. (-1728)")
    }

    func testADeniedAutomationPermissionFailsTheWholeCall() {
        harness.executor.reply(row("error", "", "", "", "Not authorized to send Apple events to Mail. (-1743)"))

        let error = harness.callFailing("delete_emails", ["ids": [first.encoded], "confirm_delete": true])

        guard case MailFailure.automationDenied = error else {
            return XCTFail("\(error)")
        }
    }

    func testTwentyFiveMailsAreAcceptedInOneCall() throws {
        let ids = (1...mailBatchLimit).map { MailId(account: "iCloud", mailbox: "INBOX", messageId: "<\($0)@x>").encoded }
        harness.executor.reply(ids.map { _ in row("ok", "s", "a", "", "") }.joined(separator: "\u{1E}"))

        let result = try harness.call("delete_emails", ["ids": ids])

        XCTAssertEqual(mailBatchLimit, 25)
        XCTAssertEqual((result["emails"] as? [Any])?.count, 25)
    }

    func testMoreThanTwentyFiveMailsAreRefusedBeforeAnyScriptRunsWithTheInstructionToSplitThem() {
        let ids = (1...26).map { MailId(account: "iCloud", mailbox: "INBOX", messageId: "<\($0)@x>").encoded }

        let error = harness.callFailing("delete_emails", ["ids": ids, "confirm_delete": true])

        XCTAssertEqual(error as? MailFailure, .batchTooLarge(count: 26, limit: 25))
        XCTAssertTrue(error.localizedDescription.hasPrefix("MAIL_BATCH_TOO_LARGE: "))
        XCTAssertTrue(error.localizedDescription.contains("batches of at most 25"), error.localizedDescription)
        XCTAssertTrue(harness.executor.calls.isEmpty)
    }

    func testNoMailIdIsRefused() {
        let error = harness.callFailing("delete_emails", ["ids": [String](), "confirm_delete": true])

        XCTAssertTrue(error.localizedDescription.contains("ids"), error.localizedDescription)
        XCTAssertTrue(harness.executor.calls.isEmpty)
    }

    func testMissingIdsAreRefused() {
        let error = harness.callFailing("delete_emails", ["confirm_delete": true])

        XCTAssertEqual(error.localizedDescription, CLIError.missingField("ids").localizedDescription)
        XCTAssertTrue(harness.executor.calls.isEmpty)
    }

    func testOneBadMailIdRefusesTheWholeBatchBeforeAnyScriptRuns() {
        let error = harness.callFailing("delete_emails", ["ids": [first.encoded, "<raw@x>"], "confirm_delete": true])

        XCTAssertEqual(error as? MailFailure, .invalidMailId("<raw@x>"))
        XCTAssertTrue(harness.executor.calls.isEmpty)
    }

    func testARepeatedMailIdIsActedOnOnce() throws {
        harness.executor.reply(row("ok", "s", "a", "", ""))

        let result = try harness.call("delete_emails", ["ids": [first.encoded, first.encoded], "confirm_delete": true])

        XCTAssertEqual((result["emails"] as? [Any])?.count, 1)
        XCTAssertEqual(result["succeeded"] as? Int, 1)
    }

    func testAResultThatDoesNotMatchTheBatchIsAnError() {
        harness.executor.reply(row("ok", "s", "a", "", ""))

        let error = harness.callFailing("delete_emails", ["ids": [first.encoded, second.encoded], "confirm_delete": true])

        XCTAssertTrue(error.localizedDescription.contains("Unexpected"), error.localizedDescription)
    }

    func testAScriptTimeoutFailsTheWholeCall() {
        harness.executor.fail(ScriptError.timeout(12, nil))

        let error = harness.callFailing("delete_emails", ["ids": [first.encoded], "confirm_delete": true])

        guard case MailFailure.timeout = error else {
            return XCTFail("\(error)")
        }
    }
}

final class ConfirmationGateTests: XCTestCase {
    private let gate = ConfirmationGate(
        param: "confirm_send", tool: "sendEmail", question: "Send this email?")

    func testOnlyTheBooleanTrueConfirms() {
        XCTAssertTrue(gate.isConfirmed(["confirm_send": true]))
        XCTAssertFalse(gate.isConfirmed(["confirm_send": false]))
        XCTAssertFalse(gate.isConfirmed(["confirm_send": "true"]))
        XCTAssertFalse(gate.isConfirmed(["confirm_send": 1]))
        XCTAssertFalse(gate.isConfirmed([:]))
    }

    func testThePreviewKeepsTheCallersFieldsAndAddsTheGate() {
        let preview = gate.preview(["to": ["a@x"], "status": "spoofed"])

        XCTAssertEqual(preview["to"] as? [String], ["a@x"])
        XCTAssertEqual(preview["status"] as? String, "confirmation_required")
        XCTAssertEqual(preview["confirm_param"] as? String, "confirm_send")
        let instruction = preview["instruction"] as? String ?? ""
        XCTAssertTrue(instruction.contains("Send this email?"), instruction)
        XCTAssertTrue(instruction.contains("sendEmail"), instruction)
        XCTAssertTrue(instruction.contains("confirm_send: true"), instruction)
    }
}
