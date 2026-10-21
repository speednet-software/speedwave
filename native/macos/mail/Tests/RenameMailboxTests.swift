import SharedCLI
import XCTest
@testable import mail_cli

final class RenameMailboxTests: XCTestCase {
    private let harness = MailCommandHarness()

    private let rename: [String: Any] = ["mailbox": "Clients/Acme", "account": "Work", "new_name": "Acme Corp"]

    func testRenamingSetsTheNameOfTheMailboxFoundInItsAccountAndAnswersWithItsNewPath() throws {
        harness.executor.reply("")

        let result = try harness.call("rename_mailbox", rename)

        XCTAssertEqual(harness.executor.calls.count, 1)
        let script = harness.executor.calls[0].script
        XCTAssertTrue(script.contains("mailbox \"Clients/Acme\" of spwAcct"), script)
        XCTAssertTrue(script.contains("{account \"Work\"}"), script)
        XCTAssertTrue(script.contains("set name of mb to \"Acme Corp\""), script)
        XCTAssertEqual(result["status"] as? String, "renamed")
        XCTAssertEqual(result["mailbox"] as? String, "Clients/Acme Corp")
        XCTAssertEqual(result["previous_mailbox"] as? String, "Clients/Acme")
        XCTAssertEqual(result["account"] as? String, "Work")
    }

    func testANameTakenInTheSameParentIsCheckedBeforeTheRename() throws {
        harness.executor.reply("")

        _ = try harness.call("rename_mailbox", rename)

        let script = harness.executor.calls[0].script
        let exists = try XCTUnwrap(script.range(
            of: "if exists mailbox \"Clients/Acme Corp\" of account \"Work\" then error \"\(mailboxExistsMarker)\""),
            script)
        let set = try XCTUnwrap(script.range(of: "set name of mb to"))
        XCTAssertLessThan(exists.lowerBound, set.lowerBound)
    }

    func testEverySpecialMailboxOfTheAccountIsFoundByItsOwnerAndRefusedBeforeTheRename() throws {
        harness.executor.reply("")

        _ = try harness.call("rename_mailbox", rename)

        let script = harness.executor.calls[0].script
        let set = try XCTUnwrap(script.range(of: "set name of mb to"))
        for special in ["inbox", "drafts mailbox", "sent mailbox", "junk mailbox", "trash mailbox", "outbox"] {
            let lookup = try XCTUnwrap(script.range(of: "repeat with spwBoxRef in mailboxes of \(special)\n"), special)
            XCTAssertLessThan(lookup.lowerBound, set.lowerBound, special)
        }
        XCTAssertEqual(
            script.components(separatedBy: "if mb is spwSpecial then error \"\(specialMailboxMarker)\"").count, 8,
            script)
        for name in archiveMailboxNames {
            XCTAssertTrue(script.contains("\"\(escapeAppleScript(name))\""), script)
        }
        XCTAssertFalse(script.contains("if name of mb is"), script)
    }

    func testRenamingAnOnMyMacMailboxLooksItAndTheNewNameUpInMailItself() throws {
        harness.executor.reply("")

        let result = try harness.call(
            "rename_mailbox", ["mailbox": "Projects", "account": "On My Mac", "new_name": "Projects \"2026\""])

        let script = harness.executor.calls[0].script
        XCTAssertTrue(script.contains("set mb to mailbox \"Projects\""), script)
        XCTAssertTrue(script.contains("if exists mailbox \"Projects \\\"2026\\\"\" then"), script)
        XCTAssertFalse(script.contains("account \"On My Mac\""), script)
        XCTAssertTrue(script.contains("set name of mb to \"Projects \\\"2026\\\"\""), script)
        XCTAssertEqual(result["mailbox"] as? String, "Projects \"2026\"")
    }

    func testASpecialMailboxIsRefusedNamingIt() {
        harness.executor.fail(ScriptError.scriptFailed("\(specialMailboxMarker) (-2700)"))

        let error = harness.callFailing("rename_mailbox", ["mailbox": "INBOX", "account": "Work", "new_name": "In"])

        XCTAssertEqual(error as? MailFailure, .specialMailbox(mailbox: "INBOX", account: "Work"))
        XCTAssertTrue(error.localizedDescription.hasPrefix("MAIL_SPECIAL_MAILBOX: "), error.localizedDescription)
        XCTAssertTrue(error.localizedDescription.contains("'INBOX'"), error.localizedDescription)
    }

    func testATakenNameIsRefusedNamingTheMailboxThatExists() {
        harness.executor.fail(ScriptError.scriptFailed("\(mailboxExistsMarker) (-2700)"))

        let error = harness.callFailing("rename_mailbox", rename)

        XCTAssertEqual(error as? MailFailure, .mailboxExists(mailbox: "Clients/Acme Corp", account: "Work"))
    }

    func testAMissingMailboxOrAccountFailsNamingWhatWasLookedFor() {
        harness.executor.fail(ScriptError.scriptFailed("\(mailboxNotFoundMarker) (-2700)"))
        harness.executor.fail(ScriptError.scriptFailed("\(accountNotFoundMarker) (-2700)"))

        let mailbox = harness.callFailing("rename_mailbox", rename)
        let account = harness.callFailing("rename_mailbox", rename)

        XCTAssertEqual(mailbox as? MailFailure, .mailboxNotFound(mailbox: "Clients/Acme", account: "Work"))
        XCTAssertEqual(account as? MailFailure, .accountNotFound("Work"))
    }

    func testRenamingNeedsTheMailboxItsAccountAndOneNewName() {
        let invalid: [(params: [String: Any], field: String)] = [
            (["account": "Work", "new_name": "A"], "mailbox"),
            (["mailbox": "Clients", "new_name": "A"], "account"),
            (["mailbox": "Clients", "account": "Work"], "new_name"),
            (["mailbox": "Clients", "account": "Work", "new_name": ""], "new_name"),
            (["mailbox": "Clients", "account": "Work", "new_name": "A/B"], "new_name"),
        ]
        for (params, field) in invalid {
            let error = harness.callFailing("rename_mailbox", params)

            XCTAssertTrue(error.localizedDescription.contains(field), "\(params): \(error.localizedDescription)")
        }
        XCTAssertTrue(harness.executor.calls.isEmpty)
    }

    func testAMissingAccountIsAMailErrorLikeTheOtherMissingFields() {
        let error = harness.callFailing("rename_mailbox", ["mailbox": "Clients", "new_name": "A"])

        guard case MailError.missingField("account") = error else {
            return XCTFail("expected MailError.missingField(account), got \(error)")
        }
    }

    func testRenamingNeverDeletesAnything() throws {
        harness.executor.reply("")

        _ = try harness.call("rename_mailbox", rename)

        let script = harness.executor.calls[0].script
        XCTAssertNil(script.range(of: #"\bdelete\b"#, options: .regularExpression), script)
    }
}
