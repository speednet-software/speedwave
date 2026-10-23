import SharedCLI
import XCTest
@testable import mail_cli

final class AccountIdentityTests: XCTestCase {
    private let harness = MailCommandHarness()
    private let workA = MailId(accountId: "AAAA-1", account: "Work", mailbox: "INBOX", messageId: "<a@x>")
    private let workB = MailId(accountId: "BBBB-2", account: "Work", mailbox: "INBOX", messageId: "<a@x>")

    func testTwoAccountsWithTheSameNameGiveTheSameMailTwoIdsThatDecodeToTheirOwnAccount() throws {
        XCTAssertNotEqual(workA.encoded, workB.encoded)
        XCTAssertEqual(try MailId(decoding: workA.encoded), workA)
        XCTAssertEqual(try MailId(decoding: workB.encoded).accountId, "BBBB-2")
    }

    func testAMailIsLookedUpInTheAccountItsIdNamesByAccountIdNotByName() {
        let script = AppleMailClient.messageLookup(workB)

        XCTAssertTrue(script.contains("account id \"BBBB-2\""), script)
        XCTAssertFalse(script.contains("account \"Work\""), script)
        XCTAssertFalse(script.contains("whose name is"), script)
    }

    func testAnOnMyMacMailIsLookedUpAtAppLevel() {
        let local = MailId(accountId: "", account: "On My Mac", mailbox: "Speedwave-Test", messageId: "<l@x>")

        let script = AppleMailClient.messageLookup(local)

        XCTAssertTrue(script.contains("set mb to mailbox \"Speedwave-Test\"\n"), script)
        XCTAssertFalse(script.contains("account id"), script)
    }

    func testAnAccountNamedByTheUserIsResolvedByNameAndRefusedWhenSeveralAccountsHaveThatName() {
        let script = AppleMailClient.mailboxLookup(name: "INBOX", account: "Work")

        XCTAssertTrue(script.contains("every account whose name is \"Work\""), script)
        XCTAssertTrue(script.contains("error \"\(accountAmbiguousMarker)\""), script)
    }

    func testAnAmbiguousAccountNameIsReportedAsAccountAmbiguousNamingIt() {
        harness.executor.fail(ScriptError.scriptFailed("\(accountAmbiguousMarker) (-2700)"))

        let error = harness.callFailing("list_emails", ["mailbox": "INBOX", "account": "Work"])

        XCTAssertEqual(error as? MailFailure, .accountAmbiguous("Work"))
        XCTAssertTrue(error.localizedDescription.hasPrefix("MAIL_ACCOUNT_AMBIGUOUS: "), error.localizedDescription)
        XCTAssertTrue(error.localizedDescription.contains("'Work'"), error.localizedDescription)
    }

    func testEveryCommandThatTakesAnAccountNameRefusesAnAmbiguousOne() throws {
        let calls: [(String, [String: Any])] = [
            ("search_emails", ["account": "Work", "query": "x"]),
            ("send_email", ["to": "a@x", "subject": "s", "body": "b", "account": "Work"]),
            ("save_draft", ["subject": "s", "account": "Work"]),
            ("check_mail", ["account": "Work"]),
            ("create_mailbox", ["name": "New", "account": "Work"]),
            ("rename_mailbox", ["mailbox": "Old", "account": "Work", "new_name": "New"]),
            ("move_emails", ["ids": [workA.encoded], "mailbox": "Done", "account": "Work"]),
        ]
        for (command, params) in calls {
            let probe = MailCommandHarness()
            probe.executor.reply("")
            _ = try? probe.call(command, params)
            let script = try XCTUnwrap(probe.executor.calls.first?.script, command)
            XCTAssertTrue(script.contains("every account whose name is \"Work\""), "\(command): \(script)")
            XCTAssertFalse(script.contains("account \"Work\""), "\(command): \(script)")
        }
    }

    func testTheTrashOfADeleteIsTheOneWhoseAccountHasTheMailsAccountId() throws {
        harness.executor.reply(["ok", "s", "a", "", ""].joined(separator: MailBatch.fieldSeparator))

        _ = try harness.call("delete_emails", ["ids": [workB.encoded], "confirm_delete": true])

        let script = try XCTUnwrap(harness.executor.calls.first?.script)
        XCTAssertTrue(script.contains("set spwOwner to id of account of spwBox"), script)
        XCTAssertTrue(script.contains("if spwOwner is spwAcctId then"), script)
        XCTAssertFalse(script.contains("name of account of"), script)
    }

    func testAMailAlreadyInATrashArchiveOrJunkIsRecognisedByTheMailboxItselfNotItsName() throws {
        for command in ["delete_emails", "archive_emails", "mark_emails_spam"] {
            let probe = MailCommandHarness()
            probe.executor.reply(["ok", "s", "a", "", ""].joined(separator: MailBatch.fieldSeparator))
            _ = try probe.call(command, ["ids": [workA.encoded], "confirm_delete": true, "confirm_spam": true])
            let script = try XCTUnwrap(probe.executor.calls.first?.script)
            XCTAssertFalse(script.contains("name of mb is"), "\(command): \(script)")
            XCTAssertTrue(
                script.contains("if mb is spwTrash then") || script.contains("if mb is spwArchive then")
                    || script.contains("if mb is spwJunk then"),
                "\(command): \(script)")
        }
    }

    func testTheArchiveOfAMailIsLookedUpInItsAccountById() throws {
        harness.executor.reply(["ok", "s", "a", "", ""].joined(separator: MailBatch.fieldSeparator))

        _ = try harness.call("archive_emails", ["ids": [workB.encoded]])

        let script = try XCTUnwrap(harness.executor.calls.first?.script)
        XCTAssertTrue(script.contains("mailbox spwName of account id spwAcctId"), script)
        XCTAssertFalse(script.contains("of account spwAcctName"), script)
    }
}
