import SharedCLI
import XCTest
@testable import mail_cli

final class OrganizeEmailsTests: XCTestCase {
    private let harness = MailCommandHarness()

    private let first = MailId(account: "iCloud", mailbox: "INBOX", messageId: "<a@x>")
    private let second = MailId(account: "Work", mailbox: "Archive/2026", messageId: "<b@x>")

    private func row(_ fields: String...) -> String {
        fields.joined(separator: "\u{1F}")
    }

    private func rows(_ rows: String...) -> String {
        rows.joined(separator: "\u{1E}")
    }

    func testMarkingReadSetsTheReadStatusOfEveryMailWithoutConfirmationAndReportsEachOne() throws {
        harness.executor.reply(rows(
            row("ok", "Invoice 12", "Anna", "2026-10-20T09:15:00", ""),
            row("error", "", "", "", "\(mailNotFoundMarker) (-2700)")
        ))

        let result = try harness.call("mark_emails_read", ["ids": [first.encoded, second.encoded], "read": true])

        XCTAssertEqual(harness.executor.calls.count, 1)
        let script = harness.executor.calls[0].script
        XCTAssertTrue(script.contains("set read status of m to true"), script)
        XCTAssertTrue(script.contains("\"<a@x>\""), script)
        XCTAssertTrue(script.contains("\"<b@x>\""), script)
        XCTAssertEqual(result["status"] as? String, "partial")
        XCTAssertEqual(result["succeeded"] as? Int, 1)
        XCTAssertEqual(result["failed"] as? Int, 1)
        XCTAssertNil(result["confirm_param"])
        let emails = try XCTUnwrap(result["emails"] as? [[String: Any]])
        XCTAssertEqual(emails.map { $0["ok"] as? Bool }, [true, false])
        XCTAssertEqual(emails[0]["subject"] as? String, "Invoice 12")
        let error = try XCTUnwrap(emails[1]["error"] as? String)
        XCTAssertTrue(error.hasPrefix("MAIL_NOT_FOUND: "), error)
    }

    func testMarkingUnreadClearsTheReadStatus() throws {
        harness.executor.reply(row("ok", "s", "a", "", ""))

        let result = try harness.call("mark_emails_read", ["ids": [first.encoded], "read": false])

        XCTAssertTrue(harness.executor.calls[0].script.contains("set read status of m to false"))
        XCTAssertEqual(result["status"] as? String, "completed")
    }

    func testMarkingReadNeedsTheReadFlag() {
        for params: [String: Any] in [["ids": [first.encoded]], ["ids": [first.encoded], "read": "yes"]] {
            let error = harness.callFailing("mark_emails_read", params)

            XCTAssertTrue(error.localizedDescription.contains("read"), error.localizedDescription)
        }
        XCTAssertTrue(harness.executor.calls.isEmpty)
    }

    func testMarkingReadTakesAtMostTwentyFiveMailsLikeEveryBatch() {
        let ids = (1...26).map { MailId(account: "iCloud", mailbox: "INBOX", messageId: "<\($0)@x>").encoded }

        let error = harness.callFailing("mark_emails_read", ["ids": ids, "read": true])

        XCTAssertEqual(error as? MailFailure, .batchTooLarge(count: 26, limit: 25))
        XCTAssertTrue(harness.executor.calls.isEmpty)
    }

    func testFlaggingSetsTheFlagWithTheColorMailNumbers() throws {
        let colors = ["red", "orange", "yellow", "green", "blue", "purple", "gray"]
        for (index, color) in colors.enumerated() {
            harness.executor.reply(row("ok", "s", "a", "", ""))

            let result = try harness.call("flag_emails", ["ids": [first.encoded], "flag": color])

            let script = try XCTUnwrap(harness.executor.calls.last?.script)
            XCTAssertTrue(script.contains("set flagged status of m to true"), script)
            XCTAssertTrue(script.contains("set flag index of m to \(index)"), "\(color): \(script)")
            XCTAssertEqual(result["status"] as? String, "completed")
        }
    }

    func testFlagNoneTakesTheFlagOff() throws {
        harness.executor.reply(row("ok", "s", "a", "", ""))

        _ = try harness.call("flag_emails", ["ids": [first.encoded], "flag": "none"])

        let script = harness.executor.calls[0].script
        XCTAssertTrue(script.contains("set flagged status of m to false"), script)
        XCTAssertFalse(script.contains("flag index"), script)
    }

    func testAnUnknownFlagColorIsRefusedWithTheColorsThereAre() {
        for params: [String: Any] in [["ids": [first.encoded], "flag": "pink"], ["ids": [first.encoded]]] {
            let error = harness.callFailing("flag_emails", params)

            XCTAssertTrue(error.localizedDescription.contains("flag"), error.localizedDescription)
            if params["flag"] != nil {
                XCTAssertTrue(error.localizedDescription.contains("purple"), error.localizedDescription)
                XCTAssertTrue(error.localizedDescription.contains("none"), error.localizedDescription)
            }
        }
        XCTAssertTrue(harness.executor.calls.isEmpty)
    }

    func testMovingLooksTheTargetUpInItsAccountOnceAndMovesEveryMailThere() throws {
        harness.executor.reply(rows(row("ok", "a", "b", "", ""), row("ok", "c", "d", "", "")))

        let result = try harness.call(
            "move_emails",
            ["ids": [first.encoded, second.encoded], "mailbox": "Clients/Acme", "account": "Work"])

        XCTAssertEqual(harness.executor.calls.count, 1)
        let script = harness.executor.calls[0].script
        XCTAssertTrue(script.contains("mailbox \"Clients/Acme\" of spwAcct"), script)
        XCTAssertTrue(script.contains("{account \"Work\"}"), script)
        XCTAssertTrue(script.contains("set spwTarget to mb"), script)
        XCTAssertTrue(script.contains("move m to spwTarget"), script)
        let setup = try XCTUnwrap(script.range(of: "set spwTarget to mb"))
        let firstMail = try XCTUnwrap(script.range(of: "\"<a@x>\""))
        XCTAssertLessThan(setup.lowerBound, firstMail.lowerBound)
        XCTAssertEqual(script.components(separatedBy: "set spwTarget to mb").count, 2)
        XCTAssertEqual(result["status"] as? String, "completed")
        XCTAssertEqual(result["succeeded"] as? Int, 2)
    }

    func testAMissingTargetMailboxFailsTheWholeMoveNamingTheTarget() {
        harness.executor.fail(ScriptError.scriptFailed("\(mailboxNotFoundMarker) (-2700)"))

        let error = harness.callFailing(
            "move_emails", ["ids": [first.encoded], "mailbox": "Clients", "account": "Work"])

        XCTAssertEqual(error as? MailFailure, .mailboxNotFound(mailbox: "Clients", account: "Work"))
    }

    func testAMissingTargetAccountFailsTheWholeCopy() {
        harness.executor.fail(ScriptError.scriptFailed("\(accountNotFoundMarker) (-2700)"))

        let error = harness.callFailing(
            "copy_emails", ["ids": [first.encoded], "mailbox": "Clients", "account": "Nope"])

        XCTAssertEqual(error as? MailFailure, .accountNotFound("Nope"))
    }

    func testMovingAndCopyingNeedTheTargetMailboxAndItsAccount() {
        for command in ["move_emails", "copy_emails"] {
            for params: [String: Any] in [
                ["ids": [first.encoded], "account": "Work"],
                ["ids": [first.encoded], "mailbox": "Clients"],
            ] {
                let error = harness.callFailing(command, params)

                let missing = params["mailbox"] == nil ? "mailbox" : "account"
                XCTAssertTrue(error.localizedDescription.contains(missing), "\(command): \(error)")
            }
        }
        XCTAssertTrue(harness.executor.calls.isEmpty)
    }

    func testMovingAndCopyingCheckTheTargetAgainstTheTrashAndJunkOfItsAccountBeforeAnyMail() throws {
        for command in ["move_emails", "copy_emails"] {
            let harness = MailCommandHarness()
            harness.executor.reply(row("ok", "a", "b", "", ""))

            _ = try harness.call(command, ["ids": [first.encoded], "mailbox": "Clients", "account": "Work"])

            let script = harness.executor.calls[0].script
            for special in ["trash mailbox", "junk mailbox"] {
                XCTAssertTrue(script.contains("repeat with spwBoxRef in mailboxes of \(special)"), script)
            }
            let trashCheck = try XCTUnwrap(
                script.range(of: "if mb is spwTargetTrash then error \"\(targetIsTrashMarker)\""), script)
            XCTAssertNotNil(script.range(of: "if mb is spwTargetJunk then error \"\(targetIsJunkMarker)\""), script)
            let firstMail = try XCTUnwrap(script.range(of: "\"<a@x>\""))
            XCTAssertLessThan(trashCheck.lowerBound, firstMail.lowerBound)
        }
    }

    func testMovingToTheTrashOfTheTargetAccountIsRefusedPointingToDeleteEmails() {
        harness.executor.fail(ScriptError.scriptFailed("\(targetIsTrashMarker) (-2700)"))

        let error = harness.callFailing(
            "move_emails", ["ids": [first.encoded], "mailbox": "Deleted Items", "account": "Work"])

        XCTAssertEqual(error as? MailFailure, .targetIsTrash(mailbox: "Deleted Items", account: "Work"))
        XCTAssertTrue(error.localizedDescription.hasPrefix("MAIL_TARGET_IS_TRASH: "), error.localizedDescription)
        XCTAssertTrue(error.localizedDescription.contains("deleteEmails"), error.localizedDescription)
    }

    func testCopyingToTheJunkOfTheTargetAccountIsRefusedPointingToMarkEmailsSpam() {
        harness.executor.fail(ScriptError.scriptFailed("\(targetIsJunkMarker) (-2700)"))

        let error = harness.callFailing(
            "copy_emails", ["ids": [first.encoded], "mailbox": "Junk Email", "account": "Work"])

        XCTAssertEqual(error as? MailFailure, .targetIsJunk(mailbox: "Junk Email", account: "Work"))
        XCTAssertTrue(error.localizedDescription.hasPrefix("MAIL_TARGET_IS_JUNK: "), error.localizedDescription)
        XCTAssertTrue(error.localizedDescription.contains("markEmailsSpam"), error.localizedDescription)
    }

    func testCopyingDuplicatesEachMailIntoTheTargetAndLeavesTheOriginal() throws {
        harness.executor.reply(row("ok", "a", "b", "", ""))

        let result = try harness.call(
            "copy_emails", ["ids": [first.encoded], "mailbox": "Speedwave-Test", "account": "On My Mac"])

        let script = harness.executor.calls[0].script
        XCTAssertTrue(script.contains("duplicate m to spwTarget"), script)
        XCTAssertFalse(script.contains("move m"), script)
        XCTAssertTrue(script.contains("set mb to mailbox \"Speedwave-Test\""), script)
        XCTAssertEqual(result["status"] as? String, "completed")
    }

    func testArchivingMovesEachMailToTheArchiveOfItsOwnAccount() throws {
        harness.executor.reply(rows(row("ok", "a", "b", "", ""), row("ok", "c", "d", "", "")))

        let result = try harness.call("archive_emails", ["ids": [first.encoded, second.encoded]])

        let script = harness.executor.calls[0].script
        XCTAssertTrue(script.contains("of account spwAcctName"), script)
        XCTAssertTrue(script.contains("\"Archive\""), script)
        XCTAssertTrue(script.contains("move m to spwArchive"), script)
        XCTAssertNil(script.range(of: #"\bdelete\b"#, options: .regularExpression), script)
        XCTAssertEqual(result["status"] as? String, "completed")
    }

    func testAnAccountWithoutAnArchiveLeavesTheMailWhereItIsAndSaysWhatToDoInstead() throws {
        harness.executor.reply(rows(
            row("error", "a", "b", "", "\(archiveNotFoundMarker) (-2700)"),
            row("error", "c", "d", "", "\(alreadyArchivedMarker) (-2700)")
        ))

        let result = try harness.call("archive_emails", ["ids": [first.encoded, second.encoded]])

        XCTAssertEqual(result["status"] as? String, "failed")
        let emails = try XCTUnwrap(result["emails"] as? [[String: Any]])
        let noArchive = try XCTUnwrap(emails[0]["error"] as? String)
        XCTAssertTrue(noArchive.hasPrefix("MAIL_ARCHIVE_NOT_FOUND: "), noArchive)
        XCTAssertTrue(noArchive.contains("iCloud"), noArchive)
        XCTAssertTrue(noArchive.contains("moveEmails"), noArchive)
        XCTAssertTrue(noArchive.contains("listMailboxes"), noArchive)
        for name in archiveMailboxNames {
            XCTAssertTrue(noArchive.contains("'\(name)'"), noArchive)
        }
        let archived = try XCTUnwrap(emails[1]["error"] as? String)
        XCTAssertTrue(archived.hasPrefix("MAIL_ALREADY_ARCHIVED: "), archived)
    }

    func testCreatingAMailboxMakesItInTheNamedAccount() throws {
        harness.executor.reply("")

        let result = try harness.call("create_mailbox", ["name": "Clients/Acme", "account": "Work"])

        let script = harness.executor.calls[0].script
        XCTAssertTrue(script.contains("if not (exists account \"Work\") then error \"\(accountNotFoundMarker)\""), script)
        XCTAssertTrue(script.contains("exists mailbox \"Clients/Acme\" of account \"Work\""), script)
        XCTAssertTrue(script.contains("make new mailbox with properties {name:\"Clients/Acme\"}"), script)
        XCTAssertTrue(script.contains("tell account \"Work\""), script)
        XCTAssertEqual(result["status"] as? String, "created")
        XCTAssertEqual(result["mailbox"] as? String, "Clients/Acme")
        XCTAssertEqual(result["account"] as? String, "Work")
    }

    func testCreatingAnOnMyMacMailboxMakesItInMailItself() throws {
        harness.executor.reply("")

        _ = try harness.call("create_mailbox", ["name": "Projects", "account": "On My Mac"])

        let script = harness.executor.calls[0].script
        XCTAssertTrue(script.contains("exists mailbox \"Projects\""), script)
        XCTAssertFalse(script.contains("account \"On My Mac\""), script)
        XCTAssertTrue(script.contains("make new mailbox with properties {name:\"Projects\"}"), script)
    }

    func testCreatingAMailboxThatExistsIsRefusedNamingIt() {
        harness.executor.fail(ScriptError.scriptFailed("\(mailboxExistsMarker) (-2700)"))

        let error = harness.callFailing("create_mailbox", ["name": "Clients", "account": "Work"])

        XCTAssertEqual(error as? MailFailure, .mailboxExists(mailbox: "Clients", account: "Work"))
        XCTAssertTrue(error.localizedDescription.hasPrefix("MAIL_MAILBOX_EXISTS: "))
    }

    func testCreatingAMailboxInAnUnknownAccountIsReportedAsAccountNotFound() {
        harness.executor.fail(ScriptError.scriptFailed("\(accountNotFoundMarker) (-2700)"))

        let error = harness.callFailing("create_mailbox", ["name": "Clients", "account": "Nope"])

        XCTAssertEqual(error as? MailFailure, .accountNotFound("Nope"))
    }

    func testCreatingAMailboxNeedsANameAndAnAccount() {
        for params: [String: Any] in [["account": "Work"], ["name": "Clients"], ["name": "", "account": "Work"]] {
            let error = harness.callFailing("create_mailbox", params)

            let field = params["account"] == nil ? "account" : "name"
            XCTAssertTrue(error.localizedDescription.contains(field), error.localizedDescription)
        }
        XCTAssertTrue(harness.executor.calls.isEmpty)
    }

    func testNoOrganizingCommandDeletesOrRemovesAMailbox() throws {
        let calls: [(String, [String: Any])] = [
            ("mark_emails_read", ["ids": [first.encoded], "read": true]),
            ("flag_emails", ["ids": [first.encoded], "flag": "red"]),
            ("move_emails", ["ids": [first.encoded], "mailbox": "A", "account": "Work"]),
            ("copy_emails", ["ids": [first.encoded], "mailbox": "A", "account": "Work"]),
            ("archive_emails", ["ids": [first.encoded]]),
            ("mark_emails_spam", ["ids": [first.encoded], "confirm_spam": true]),
        ]
        for (command, params) in calls {
            harness.executor.reply(row("ok", "s", "a", "", ""))
            _ = try harness.call(command, params)
        }
        _ = try harness.call("create_mailbox", ["name": "A", "account": "Work"])

        for call in harness.executor.calls {
            XCTAssertNil(call.script.range(of: #"\bdelete\b"#, options: .regularExpression), call.script)
        }
    }

    func testSpamWithoutConfirmationOnlyPreviewsTheMails() throws {
        harness.executor.reply(row("ok", "Win a prize", "spam@x", "2026-10-20T09:15:00", ""))

        let result = try harness.call("mark_emails_spam", ["ids": [first.encoded]])

        let script = harness.executor.calls[0].script
        XCTAssertFalse(script.contains("junk mail status"), script)
        XCTAssertFalse(script.contains("move m"), script)
        XCTAssertEqual(result["status"] as? String, "confirmation_required")
        XCTAssertEqual(result["confirm_param"] as? String, "confirm_spam")
        let instruction = try XCTUnwrap(result["instruction"] as? String)
        XCTAssertTrue(instruction.contains("markEmailsSpam"), instruction)
        XCTAssertTrue(instruction.contains("confirm_spam: true"), instruction)
        let emails = try XCTUnwrap(result["emails"] as? [[String: Any]])
        XCTAssertEqual(emails[0]["subject"] as? String, "Win a prize")
        XCTAssertEqual(emails[0]["sender"] as? String, "spam@x")
    }

    func testConfirmedSpamTrainsTheFilterAndMovesEachMailToTheJunkOfItsAccount() throws {
        harness.executor.reply(rows(
            row("ok", "Win", "spam@x", "", ""),
            row("error", "Old", "x@x", "", "\(alreadyInJunkMarker) (-2700)")
        ))

        let result = try harness.call(
            "mark_emails_spam", ["ids": [first.encoded, second.encoded], "confirm_spam": true])

        let script = harness.executor.calls[0].script
        XCTAssertTrue(script.contains("set junk mail status of m to true"), script)
        XCTAssertTrue(script.contains("mailboxes of junk mailbox"), script)
        XCTAssertTrue(script.contains("move m to spwJunk"), script)
        let train = try XCTUnwrap(script.range(of: "set junk mail status of m to true"))
        let move = try XCTUnwrap(script.range(of: "move m to spwJunk"))
        XCTAssertLessThan(train.lowerBound, move.lowerBound)
        XCTAssertEqual(result["status"] as? String, "partial")
        let emails = try XCTUnwrap(result["emails"] as? [[String: Any]])
        let error = try XCTUnwrap(emails[1]["error"] as? String)
        XCTAssertTrue(error.hasPrefix("MAIL_ALREADY_IN_JUNK: "), error)
    }

    func testAnAccountWithoutAJunkMailboxIsReportedPerMail() throws {
        harness.executor.reply(row("error", "Win", "spam@x", "", "\(junkNotFoundMarker) (-2700)"))

        let result = try harness.call("mark_emails_spam", ["ids": [second.encoded], "confirm_spam": true])

        let emails = try XCTUnwrap(result["emails"] as? [[String: Any]])
        XCTAssertEqual(emails[0]["error"] as? String, MailFailure.junkNotFound(account: "Work").localizedDescription)
    }

    func testSpamTakesAtMostTwentyFiveMails() {
        let ids = (1...26).map { MailId(account: "iCloud", mailbox: "INBOX", messageId: "<\($0)@x>").encoded }

        let error = harness.callFailing("mark_emails_spam", ["ids": ids, "confirm_spam": true])

        XCTAssertEqual(error as? MailFailure, .batchTooLarge(count: 26, limit: 25))
        XCTAssertTrue(harness.executor.calls.isEmpty)
    }
}
