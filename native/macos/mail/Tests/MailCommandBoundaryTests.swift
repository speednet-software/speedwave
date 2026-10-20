import SharedCLI
import XCTest
@testable import mail_cli

final class MailCommandBoundaryTests: XCTestCase {
    private let harness = MailCommandHarness()
    private let mailId = MailId(account: "Work", mailbox: "INBOX", messageId: "<a@x>").encoded

    private func failure(_ command: String, _ params: [String: Any]) throws -> MailFailure {
        let error = harness.callFailing(command, params)
        return try XCTUnwrap(error as? MailFailure, "expected a MailFailure, got \(error)")
    }

    func testListEmailsRunsItsScriptWithinTheGivenBudgetAndReturnsTheParsedRows() throws {
        harness.executor.reply(["Work", "<a@x>", "Hi", "Anna <anna@x>", "2026-10-20T09:15:00", "false"]
            .joined(separator: "\u{1D}"))

        let result = try harness.call("list_emails", ["mailbox": "INBOX", "limit": 5, scriptTimeoutParam: 12_000])

        XCTAssertEqual(harness.executor.calls.count, 1)
        XCTAssertEqual(harness.executor.calls.first?.timeout, 12)
        let emails = try XCTUnwrap(result["emails"] as? [[String: Any]])
        XCTAssertEqual(emails.first?["id"] as? String, mailId)
        XCTAssertEqual(emails.first?["read"] as? Bool, false)
    }

    func testEveryScriptedCommandRunsWithinTheBudget() throws {
        let calls: [(String, [String: Any])] = [
            ("list_mailboxes", [:]),
            ("list_emails", ["mailbox": "INBOX"]),
            ("get_email", ["id": mailId]),
            ("search_emails", ["query": "x", "mailbox": "INBOX"]),
            ("send_email", ["to": "a@x", "subject": "S", "body": "B", "confirm_send": true]),
            ("reply_to_email", ["id": mailId, "body": "B", "confirm_send": true]),
            ("forward_email", ["id": mailId, "to": "a@x", "confirm_send": true]),
            ("redirect_email", ["id": mailId, "to": "a@x", "confirm_send": true]),
        ]
        let replies = [
            "list_emails": "Work" + String(repeating: "\u{1D}", count: 5),
            "get_email": String(repeating: "\u{1D}", count: 11),
            "search_emails": "Work" + String(repeating: "\u{1D}", count: 5),
            "reply_to_email": String(repeating: "\u{1D}", count: 5),
            "forward_email": String(repeating: "\u{1D}", count: 4),
            "redirect_email": String(repeating: "\u{1D}", count: 4),
        ]
        for (command, params) in calls {
            harness.executor.reply(replies[command] ?? "")
            _ = try harness.call(command, params.merging([scriptTimeoutParam: 7_500]) { $1 })
        }
        XCTAssertEqual(harness.executor.calls.map(\.timeout), Array(repeating: 7.5, count: calls.count + 3))
    }

    func testEveryRequestToMailOfEveryCommandWaitsAsLongAsTheScriptBudgetInsteadOfTheTwoMinuteDefault() throws {
        let budget = "with timeout of \(MailCommandHarness.scriptTimeoutMs / 1000) seconds"
        for call in MailCommandCall.all {
            for script in try call.scripts() {
                var depth = 0
                var mailTells = 0
                let lines = script.components(separatedBy: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
                for (index, line) in lines.enumerated() {
                    if line.hasPrefix("with timeout") {
                        XCTAssertEqual(line, budget, call.command)
                        depth += 1
                    } else if line == "end timeout" {
                        depth -= 1
                    } else if line == "tell application \"Mail\"" {
                        mailTells += 1
                        XCTAssertEqual(lines[index + 1], budget, "\(call.command):\n\(script)")
                    } else if line.hasPrefix("tell application \"Mail\"") {
                        mailTells += 1
                        XCTAssertGreaterThan(depth, 0, "\(call.command): \(line) outside \(budget)\n\(script)")
                    }
                }
                XCTAssertEqual(depth, 0, "\(call.command):\n\(script)")
                XCTAssertGreaterThan(mailTells, 0, "\(call.command):\n\(script)")
            }
        }
    }

    func testABudgetOfAFractionOfASecondStillGivesMailAWholeSecond() throws {
        harness.executor.reply("")

        _ = try harness.call("list_mailboxes", [scriptTimeoutParam: 400])

        XCTAssertTrue(harness.executor.calls[0].script.contains("with timeout of 1 seconds"))
    }

    func testAScriptedCommandWithoutABudgetRunsNothing() {
        for budget in [nil, 0, -1, "25000"] as [Any?] {
            let params: [String: Any] = budget.map { [scriptTimeoutParam: $0] } ?? [:]
            let commands = mailCommands(executor: harness.executor.execute)
            XCTAssertThrowsError(try commands["list_emails"]!(params.merging(["mailbox": "INBOX"]) { $1 })) { error in
                guard case CLIError.missingField(scriptTimeoutParam) = error else {
                    return XCTFail("expected missingField(\(scriptTimeoutParam)), got \(error)")
                }
            }
        }
        XCTAssertTrue(harness.executor.calls.isEmpty)
    }

    func testDetectClientsRunsNoScriptAndNeedsNoBudget() throws {
        let commands = mailCommands(executor: harness.executor.execute)
        let result = try XCTUnwrap(try commands["detect_clients"]!([:]) as? [String: Any])
        XCTAssertNotNil(result["clients"])
        XCTAssertTrue(harness.executor.calls.isEmpty)
    }

    func testAScriptTimeoutIsReportedAsAMailTimeoutNamingTheBudget() throws {
        harness.executor.fail(ScriptError.timeout(12, nil))

        let failure = try failure("list_emails", ["mailbox": "INBOX", scriptTimeoutParam: 12_000])

        XCTAssertEqual(failure, .timeout(seconds: 12))
        XCTAssertEqual(failure.errorDescription, "MAIL_TIMEOUT: Mail.app did not answer within 12 s.")
    }

    func testAnAppleEventTimeoutIsReportedAsAMailTimeout() throws {
        harness.executor.fail(ScriptError.scriptFailed("execution error: Mail got an error: AppleEvent timed out. (-1712)"))

        XCTAssertEqual(try failure("search_emails", ["query": "x", "mailbox": "INBOX"]), .timeout(seconds: 25))
    }

    func testADeniedAutomationPermissionIsReportedAsAutomationDenied() throws {
        harness.executor.fail(ScriptError.automationPermission("Not allowed to send Apple events"))

        let failure = try failure("list_mailboxes", [:])

        XCTAssertEqual(failure, .automationDenied("Not allowed to send Apple events"))
        XCTAssertTrue(failure.errorDescription?.hasPrefix("MAIL_AUTOMATION_DENIED: ") == true)
    }

    func testANotAuthorizedAppleEventIsReportedAsAutomationDenied() throws {
        let detail = "execution error: Not authorized to send Apple events to Mail. (-1743)"
        harness.executor.fail(ScriptError.scriptFailed(detail))

        XCTAssertEqual(try failure("get_email", ["id": mailId]), .automationDenied(detail))
    }

    func testAMissingMailboxIsReportedAsMailboxNotFoundInAnyAccount() throws {
        harness.executor.fail(ScriptError.scriptFailed("execution error: SPW_MAILBOX_NOT_FOUND (-2700)"))

        let failure = try failure("list_emails", ["mailbox": "Nope"])

        XCTAssertEqual(failure, .mailboxNotFound(mailbox: "Nope", account: nil))
        XCTAssertEqual(failure.errorDescription, "MAIL_MAILBOX_NOT_FOUND: Mailbox 'Nope' not found in any account.")
    }

    func testAMissingMailboxNamesTheAccountItWasLookedUpIn() throws {
        harness.executor.fail(ScriptError.scriptFailed("execution error: SPW_MAILBOX_NOT_FOUND (-2700)"))

        let failure = try failure("search_emails", ["query": "x", "mailbox": "Nope", "account": "Exchange"])

        XCTAssertEqual(failure.errorDescription, "MAIL_MAILBOX_NOT_FOUND: Mailbox 'Nope' not found in account 'Exchange'.")
    }

    func testAMissingAccountIsReportedAsAccountNotFound() throws {
        harness.executor.fail(ScriptError.scriptFailed("execution error: SPW_ACCOUNT_NOT_FOUND (-2700)"))

        let failure = try failure("list_emails", ["mailbox": "Inbox", "account": "Nope"])

        XCTAssertEqual(failure, .accountNotFound("Nope"))
        XCTAssertEqual(failure.errorDescription, "MAIL_ACCOUNT_NOT_FOUND: Account 'Nope' not found.")
    }

    func testAMailboxInSeveralAccountsIsReportedAsAmbiguousNamingThem() throws {
        harness.executor.fail(
            ScriptError.scriptFailed("execution error: SPW_MAILBOX_AMBIGUOUS:Exchange, Google, (-2700)"))

        let failure = try failure("list_emails", ["mailbox": "Inbox"])

        XCTAssertEqual(failure, .mailboxAmbiguous(mailbox: "Inbox", accounts: ["Exchange", "Google"]))
        XCTAssertEqual(
            failure.errorDescription,
            "MAIL_MAILBOX_AMBIGUOUS: Mailbox 'Inbox' exists in several accounts: Exchange, Google.")
    }

    func testAnUnrelatedScriptFailureKeepsItsRealCause() {
        let detail = "execution error: Can\u{2019}t get subject of message 1. (-1728)"
        harness.executor.fail(ScriptError.scriptFailed(detail))

        let error = harness.callFailing("list_emails", ["mailbox": "Inbox"])

        guard case ScriptError.scriptFailed(let kept) = error else {
            return XCTFail("expected the raw ScriptError.scriptFailed, got \(error)")
        }
        XCTAssertEqual(kept, detail)
    }

    func testListEmailsRefusesAnAccountWithoutAMailbox() {
        let error = harness.callFailing("list_emails", ["account": "Exchange"])
        guard case CLIError.missingField("mailbox") = error else {
            return XCTFail("expected missingField(mailbox), got \(error)")
        }
        XCTAssertTrue(harness.executor.calls.isEmpty)
    }

    func testSearchEmailsRefusesAnAccountWithoutAMailbox() {
        let error = harness.callFailing("search_emails", ["query": "x", "account": "Exchange"])
        guard case CLIError.missingField("mailbox") = error else {
            return XCTFail("expected missingField(mailbox), got \(error)")
        }
    }

    func testSendEmailRefusesARecipientFieldWithoutAnAddress() {
        let cases: [(String, [String: Any])] = [
            ("to", ["to": ""]),
            ("to", ["to": "   "]),
            ("to", ["to": ","]),
            ("to", ["to": " , "]),
            ("cc", ["to": "alice@example.com", "cc": " , "]),
            ("bcc", ["to": "alice@example.com", "bcc": "   "]),
        ]
        for (field, recipients) in cases {
            let params = recipients.merging(["subject": "Test", "body": "Hello", "confirm_send": true]) { $1 }
            let error = harness.callFailing("send_email", params)
            guard case MailError.emptyRecipients(field) = error else {
                return XCTFail("expected emptyRecipients(\(field)) for \(recipients), got \(error)")
            }
        }
        XCTAssertTrue(harness.executor.calls.isEmpty)
    }

    func testSendEmailSendsToEveryRecipientOnceConfirmed() throws {
        let result = try harness.call(
            "send_email",
            ["to": "alice@example.com, bob@example.com", "subject": "S", "body": "B", "confirm_send": true])

        XCTAssertEqual(result["status"] as? String, "sent")
        let script = try XCTUnwrap(harness.executor.calls.first?.script)
        XCTAssertTrue(script.contains("address:\"alice@example.com\""), script)
        XCTAssertTrue(script.contains("address:\"bob@example.com\""), script)
        XCTAssertTrue(script.contains("send spwMsg"), script)
    }

    func testACommandGivenSomethingOtherThanAMailIdRunsNothingAndSaysWhereIdsComeFrom() throws {
        let calls: [(String, [String: Any])] = [
            ("get_email", ["id": "<a@x>"]),
            ("reply_to_email", ["id": "msg-1", "body": "B", "confirm_send": true]),
            ("forward_email", ["id": "msg-1", "to": "a@x", "confirm_send": true]),
            ("redirect_email", ["id": "msg-1", "to": "a@x", "confirm_send": true]),
        ]
        for (command, params) in calls {
            let failure = try failure(command, params)
            XCTAssertEqual(failure, .invalidMailId(params["id"] as? String ?? ""))
            XCTAssertTrue(failure.errorDescription?.hasPrefix("MAIL_INVALID_ID: ") == true)
        }
        XCTAssertTrue(harness.executor.calls.isEmpty)
    }

    func testGetEmailReadsTheMessageInTheMailboxAndAccountOfItsId() throws {
        let id = MailId(account: "On My Mac", mailbox: "Speedwave-Test", messageId: "<z@x>").encoded
        harness.executor.reply(String(repeating: "\u{1D}", count: 11))

        let result = try harness.call("get_email", ["id": id])

        let email = try XCTUnwrap(result["email"] as? [String: Any])
        XCTAssertEqual(email["id"] as? String, id)
        let script = try XCTUnwrap(harness.executor.calls.first?.script)
        XCTAssertTrue(script.contains("set mb to mailbox \"Speedwave-Test\"\n"), script)
        XCTAssertTrue(script.contains("whose message id is \"<z@x>\""), script)
        XCTAssertFalse(script.contains("of inbox"), script)
    }

    func testAMessageWhoseMailboxIsGoneIsReportedAsMailboxNotFoundInItsAccount() throws {
        harness.executor.fail(ScriptError.scriptFailed("execution error: SPW_MAILBOX_NOT_FOUND (-2700)"))

        XCTAssertEqual(
            try failure("reply_to_email", ["id": mailId, "body": "B", "confirm_send": true]),
            .mailboxNotFound(mailbox: "INBOX", account: "Work"))
    }

    func testSearchResultsCarryMailIdsOfTheAccountTheLookupResolved() throws {
        harness.executor.reply(
            mailListing(
                account: "Google",
                [ListingRow(messageId: "<s@x>", subject: "Invoice", sender: "Bob", received: "2026-10-20T09:15:00", read: true)]))

        let result = try harness.call("search_emails", ["query": "invoice", "mailbox": "INBOX"])

        let row = try XCTUnwrap((result["emails"] as? [[String: Any]])?.first)
        XCTAssertEqual(
            try MailId(decoding: try XCTUnwrap(row["id"] as? String)),
            MailId(account: "Google", mailbox: "INBOX", messageId: "<s@x>"))
        XCTAssertEqual(row["account"] as? String, "Google")
        XCTAssertEqual(row["mailbox"] as? String, "INBOX")
        XCTAssertNil(row["message_id"])
    }

    func testSearchEmailsNeedsAMailbox() {
        let error = harness.callFailing("search_emails", ["query": "x"])
        guard case CLIError.missingField("mailbox") = error else {
            return XCTFail("expected missingField(mailbox), got \(error)")
        }
        XCTAssertTrue(harness.executor.calls.isEmpty)
    }
}
