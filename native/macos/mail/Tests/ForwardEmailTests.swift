import SharedCLI
import XCTest
@testable import mail_cli

final class ForwardEmailTests: XCTestCase {
    private let harness = MailCommandHarness()

    private let archived = MailId(accountId: "Work-ID", account: "Work", mailbox: "Archive/2026", messageId: "<a@x>")

    private func originalRead(
        subject: String = "Fwd: Invoice 12",
        originalSubject: String = "Invoice 12",
        sender: String = "Anna <anna@x>",
        received: String = "2026-10-20T09:15:00",
        attachments: [String] = ["invoice.pdf", "terms.pdf"]
    ) -> String {
        [subject, originalSubject, sender, received, attachments.joined(separator: "\u{1E}"), "Me <me@x>"]
            .joined(separator: "\u{1D}")
    }

    func testForwardWithoutConfirmationReadsTheMailAndPreviewsWhatWouldGoOut() throws {
        harness.executor.reply(originalRead())

        let result = try harness.call(
            "forward_email",
            ["id": archived.encoded, "to": "bob@x, carol@x", "cc": "dave@x"])

        XCTAssertEqual(harness.executor.calls.count, 1)
        let script = harness.executor.calls[0].script
        XCTAssertTrue(script.contains("mailbox \"Archive/2026\" of spwAcct"), script)
        XCTAssertTrue(script.contains("whose message id is \"<a@x>\""), script)
        XCTAssertTrue(script.contains("set spwOut to forward m opening window false"), script)
        XCTAssertTrue(script.contains("close spwOut saving no"), script)
        XCTAssertTrue(script.contains("repeat with spwAttachment in mail attachments of m"), script)
        XCTAssertFalse(script.contains("send spwOut"), script)
        XCTAssertEqual(result["status"] as? String, "confirmation_required")
        XCTAssertEqual(result["confirm_param"] as? String, "confirm_send")
        let instruction = try XCTUnwrap(result["instruction"] as? String)
        XCTAssertTrue(instruction.contains("forwardEmail"), instruction)
        XCTAssertEqual(result["to"] as? [String], ["bob@x", "carol@x"])
        XCTAssertEqual(result["cc"] as? [String], ["dave@x"])
        XCTAssertEqual(result["subject"] as? String, "Fwd: Invoice 12")
        XCTAssertNil(result["comment"])
        XCTAssertEqual(result["attachments"] as? [String], ["invoice.pdf", "terms.pdf"])
        let original = try XCTUnwrap(result["original"] as? [String: Any])
        XCTAssertEqual(original["id"] as? String, archived.encoded)
        XCTAssertEqual(original["subject"] as? String, "Invoice 12")
        XCTAssertEqual(original["sender"] as? String, "Anna <anna@x>")
        XCTAssertTrue((original["date"] as? String)?.hasPrefix("2026-10-20T09:15:00") == true, "\(original)")
        XCTAssertEqual(original["mailbox"] as? String, "Archive/2026")
        XCTAssertEqual(original["account"] as? String, "Work")
    }

    func testForwardWithoutCcPreviewsEmptyOnes() throws {
        harness.executor.reply(originalRead(received: "", attachments: []))

        let result = try harness.call("forward_email", ["id": archived.encoded, "to": "bob@x"])

        XCTAssertEqual(result["cc"] as? [String], [])
        XCTAssertEqual(result["attachments"] as? [String], [])
        XCTAssertNil((result["original"] as? [String: Any])?["date"])
    }

    func testConfirmedForwardSendsMailsOwnForwardUnchangedToEveryRecipient() throws {
        harness.executor.reply(originalRead())

        let result = try harness.call(
            "forward_email",
            [
                "id": archived.encoded, "to": "bob@x", "cc": "dave@x", "confirm_send": true,
            ])

        XCTAssertEqual(harness.executor.calls.count, 2)
        let send = harness.executor.calls[1].script
        XCTAssertTrue(send.contains("whose message id is \"<a@x>\""), send)
        XCTAssertTrue(send.contains("set spwOut to forward m opening window false"), send)
        XCTAssertTrue(
            send.contains("make new to recipient at end of to recipients with properties {address:\"bob@x\"}"), send)
        XCTAssertTrue(
            send.contains("make new cc recipient at end of cc recipients with properties {address:\"dave@x\"}"), send)
        XCTAssertFalse(send.contains("of spwOut"), send)
        XCTAssertTrue(send.contains("if not (send spwOut) then error \"\(sendFailedMarker)\""), send)
        XCTAssertEqual(result["status"] as? String, "sent")
        XCTAssertNil(result["confirm_param"])
        XCTAssertNil(result["instruction"])
        XCTAssertEqual(result["subject"] as? String, "Fwd: Invoice 12")
        XCTAssertEqual(result["attachments"] as? [String], ["invoice.pdf", "terms.pdf"])
        XCTAssertNil(result["comment"])
    }

    func testAForwardIgnoresACommentAndNeverTouchesMailsText() throws {
        harness.executor.reply(originalRead())

        let result = try harness.call(
            "forward_email", ["id": archived.encoded, "to": "bob@x", "comment": "FYI", "confirm_send": true])

        XCTAssertFalse(harness.executor.calls.contains { $0.script.contains("FYI") })
        XCTAssertFalse(harness.executor.calls[1].script.contains("of spwOut"))
        XCTAssertNil(result["comment"])
    }

    func testForwardConfirmationMustBeTheBooleanTrue() throws {
        for flag in ["true", 1, false] as [Any] {
            harness.executor.reply(originalRead())
            let result = try harness.call(
                "forward_email", ["id": archived.encoded, "to": "bob@x", "confirm_send": flag])
            XCTAssertEqual(result["status"] as? String, "confirmation_required")
        }
        XCTAssertFalse(harness.executor.calls.contains { $0.script.contains("send spwOut") })
    }

    func testForwardRefusesMissingOrEmptyRecipientsBeforeRunningAScript() {
        guard case MailError.missingField("to") = harness.callFailing("forward_email", ["id": archived.encoded]) else {
            return XCTFail("expected missingField(to)")
        }
        guard case MailError.emptyRecipients("to") = harness.callFailing(
            "forward_email", ["id": archived.encoded, "to": " , "])
        else {
            return XCTFail("expected emptyRecipients(to)")
        }
        XCTAssertTrue(harness.executor.calls.isEmpty)
    }

    func testAForwardMailDidNotSendIsReportedAsSendFailed() {
        harness.executor.reply(originalRead())
        harness.executor.fail(ScriptError.scriptFailed("execution error: \(sendFailedMarker) (-2700)"))

        let error = harness.callFailing("forward_email", ["id": archived.encoded, "to": "bob@x", "confirm_send": true])

        XCTAssertEqual(error as? MailFailure, .sendFailed)
    }

    func testAnUnexpectedOriginalReadFailsWithoutSending() {
        harness.executor.reply("garbage")

        let error = harness.callFailing("forward_email", ["id": archived.encoded, "to": "bob@x", "confirm_send": true])

        guard case ScriptError.scriptFailed = error else {
            return XCTFail("expected scriptFailed, got \(error)")
        }
        XCTAssertEqual(harness.executor.calls.count, 1)
    }

    func testRedirectWithoutConfirmationReadsTheSenderOfMailsRedirectClosesItUnsavedAndKeepsTheOriginalSubject() throws {
        harness.executor.reply(originalRead(subject: "Invoice 12"))

        let result = try harness.call("redirect_email", ["id": archived.encoded, "to": "bob@x"])

        XCTAssertEqual(harness.executor.calls.count, 1)
        let script = harness.executor.calls[0].script
        XCTAssertTrue(script.contains("whose message id is \"<a@x>\""), script)
        XCTAssertTrue(script.contains("set spwOut to redirect m opening window false"), script)
        XCTAssertTrue(script.contains("set spwSubject to my spwClean(subject of m)"), script)
        XCTAssertTrue(script.contains("close spwOut saving no"), script)
        XCTAssertFalse(script.contains("send spwOut"), script)
        XCTAssertFalse(script.contains("forward m"), script)
        XCTAssertEqual(result["from"] as? String, "Me <me@x>")
        XCTAssertEqual(result["status"] as? String, "confirmation_required")
        let instruction = try XCTUnwrap(result["instruction"] as? String)
        XCTAssertTrue(instruction.contains("redirectEmail"), instruction)
        XCTAssertEqual(result["to"] as? [String], ["bob@x"])
        XCTAssertEqual(result["cc"] as? [String], [])
        XCTAssertEqual(result["subject"] as? String, "Invoice 12")
        XCTAssertNil(result["comment"])
        XCTAssertEqual(result["attachments"] as? [String], ["invoice.pdf", "terms.pdf"])
        XCTAssertEqual((result["original"] as? [String: Any])?["sender"] as? String, "Anna <anna@x>")
    }

    func testConfirmedRedirectSendsMailsRedirectUnchangedToTheRecipients() throws {
        harness.executor.reply(originalRead(subject: "Invoice 12"))

        let result = try harness.call(
            "redirect_email", ["id": archived.encoded, "to": "bob@x", "cc": "dave@x", "confirm_send": true])

        XCTAssertEqual(harness.executor.calls.count, 2)
        let send = harness.executor.calls[1].script
        XCTAssertTrue(send.contains("set spwOut to redirect m opening window false"), send)
        XCTAssertTrue(
            send.contains("make new to recipient at end of to recipients with properties {address:\"bob@x\"}"), send)
        XCTAssertTrue(
            send.contains("make new cc recipient at end of cc recipients with properties {address:\"dave@x\"}"), send)
        XCTAssertFalse(send.contains("of spwOut"), send)
        XCTAssertTrue(send.contains("if not (send spwOut) then error \"\(sendFailedMarker)\""), send)
        XCTAssertEqual(result["status"] as? String, "sent")
        XCTAssertEqual(result["to"] as? [String], ["bob@x"])
    }
}
