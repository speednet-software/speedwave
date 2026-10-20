import SharedCLI
import XCTest
@testable import mail_cli

final class DraftsAndSignaturesTests: XCTestCase {
    private let harness = MailCommandHarness()

    private let archived = MailId(account: "Work", mailbox: "Archive/2026", messageId: "<a@x>")

    private let draft: [String: Any] = [
        "to": "alice@example.com",
        "cc": "carol@example.com",
        "subject": "Draft \"Q4\"",
        "body": "Hi,\nnumbers below.",
    ]

    private func replyRead() -> String {
        ["Re: Invoice 12", "anna@x", "", "Anna <anna@x>", "2026-10-20T09:15:00", "Please pay."]
            .joined(separator: "\u{1D}")
    }

    func testListSignaturesReturnsTheNamesMailHasInItsOrder() throws {
        harness.executor.reply("Work\u{1E}Private \"short\"")

        let result = try harness.call("list_signatures")

        XCTAssertEqual(result["signatures"] as? [String], ["Work", "Private \"short\""])
        let script = harness.executor.calls[0].script
        XCTAssertTrue(script.contains("repeat with spwSignature in signatures"), script)
        XCTAssertTrue(script.contains("my spwClean(name of spwSignature)"), script)
    }

    func testListSignaturesWithoutAnySignatureIsAnEmptyList() throws {
        harness.executor.reply("")

        let result = try harness.call("list_signatures")

        XCTAssertEqual(result["signatures"] as? [String], [])
    }

    func testSaveDraftSavesWithoutSendingOrAskingAndReportsWhatWasSaved() throws {
        let result = try harness.call("save_draft", draft)

        XCTAssertEqual(harness.executor.calls.count, 1)
        let script = harness.executor.calls[0].script
        XCTAssertTrue(script.contains("subject:\"Draft \\\"Q4\\\"\""), script)
        XCTAssertTrue(script.contains("content:\"Hi,\\nnumbers below.\""), script)
        XCTAssertTrue(
            script.contains(
                "make new to recipient at end of to recipients with properties {address:\"alice@example.com\"}"),
            script)
        XCTAssertTrue(
            script.contains(
                "make new cc recipient at end of cc recipients with properties {address:\"carol@example.com\"}"),
            script)
        XCTAssertTrue(script.contains("save spwMsg"), script)
        XCTAssertFalse(script.contains("send spwMsg"), script)
        XCTAssertFalse(script.contains("set sender"), script)
        XCTAssertEqual(result["status"] as? String, "saved")
        XCTAssertNil(result["confirm_param"])
        XCTAssertEqual(result["to"] as? [String], ["alice@example.com"])
        XCTAssertEqual(result["cc"] as? [String], ["carol@example.com"])
        XCTAssertEqual(result["bcc"] as? [String], [])
        XCTAssertEqual(result["subject"] as? String, "Draft \"Q4\"")
        XCTAssertEqual(result["body"] as? String, "Hi,\nnumbers below.")
        XCTAssertNil(result["account"])
        XCTAssertNil(result["signature"])
    }

    func testSaveDraftNeedsNoRecipientAndNoText() throws {
        let result = try harness.call("save_draft", ["subject": "Idea"])

        XCTAssertEqual(result["to"] as? [String], [])
        XCTAssertEqual(result["body"] as? String, "")
        XCTAssertFalse(harness.executor.calls[0].script.contains("recipient"))
    }

    func testSaveDraftInAnAccountSendsFromItSoMailFilesItInThatAccountsDrafts() throws {
        let result = try harness.call("save_draft", draft.merging(["account": "Work \"EU\""]) { $1 })

        let script = harness.executor.calls[0].script
        XCTAssertTrue(
            script.contains("if not (exists account \"Work \\\"EU\\\"\") then error \"\(accountNotFoundMarker)\""),
            script)
        XCTAssertTrue(script.contains("set spwAccount to account \"Work \\\"EU\\\"\""), script)
        XCTAssertTrue(script.contains("set spwAddresses to email addresses of spwAccount"), script)
        XCTAssertTrue(
            script.contains("set spwSender to (full name of spwAccount) & \" <\" & (item 1 of spwAddresses) & \">\""),
            script)
        XCTAssertFalse(script.contains("item 1 of email addresses"), script)
        let sender = try XCTUnwrap(script.range(of: "set spwSender to"))
        let message = try XCTUnwrap(script.range(of: "make new outgoing message"))
        XCTAssertLessThan(sender.lowerBound, message.lowerBound)
        XCTAssertTrue(script.contains("set sender of spwMsg to spwSender"), script)
        XCTAssertEqual(result["account"] as? String, "Work \"EU\"")
    }

    func testADraftInAnUnknownAccountIsReportedAsAccountNotFound() {
        harness.executor.fail(ScriptError.scriptFailed("execution error: \(accountNotFoundMarker) (-2700)"))

        let error = harness.callFailing("save_draft", draft.merging(["account": "Nope"]) { $1 })

        XCTAssertEqual(error as? MailFailure, .accountNotFound("Nope"))
    }

    func testADraftInATurnedOffAccountIsRefusedBeforeTheMessageIsMade() throws {
        harness.executor.fail(ScriptError.scriptFailed("execution error: \(accountDisabledMarker) (-2700)"))

        let error = harness.callFailing("save_draft", draft.merging(["account": "Google"]) { $1 })

        XCTAssertEqual(error as? MailFailure, .accountDisabled("Google"))
        XCTAssertEqual(
            (error as? MailFailure)?.errorDescription,
            "MAIL_ACCOUNT_DISABLED: Account 'Google' is turned off in Mail.app, so Mail would file the draft in another account.")
        let script = try XCTUnwrap(harness.executor.calls.first?.script)
        let check = try XCTUnwrap(script.range(of: "if not (enabled of spwAccount) then error \"\(accountDisabledMarker)\""))
        let message = try XCTUnwrap(script.range(of: "make new outgoing message"))
        XCTAssertLessThan(check.lowerBound, message.lowerBound)
    }

    func testSaveDraftRefusesAMissingSubjectBeforeRunningAScript() {
        let error = harness.callFailing("save_draft", ["body": "B"])

        guard case MailError.missingField("subject") = error else {
            return XCTFail("expected missingField(subject), got \(error)")
        }
        XCTAssertTrue(harness.executor.calls.isEmpty)
    }

    func testASendStillNeedsItsText() {
        let error = harness.callFailing("send_email", ["to": "a@x", "subject": "S"])

        guard case MailError.missingField("body") = error else {
            return XCTFail("expected missingField(body), got \(error)")
        }
    }

    func testSaveDraftWithASignatureChecksAndAppliesIt() throws {
        let result = try harness.call("save_draft", draft.merging(["signature": "Work"]) { $1 })

        let script = harness.executor.calls[0].script
        XCTAssertTrue(script.contains("if not (exists signature \"Work\") then error \"\(signatureNotFoundMarker)\""))
        XCTAssertTrue(script.contains("set message signature of spwMsg to signature \"Work\""), script)
        XCTAssertEqual(result["signature"] as? String, "Work")
    }

    func testSendPreviewWithASignatureChecksItExistsAndSendsNothing() throws {
        let result = try harness.call(
            "send_email", ["to": "a@x", "subject": "S", "body": "B", "signature": "Sales \"EU\""])

        XCTAssertEqual(harness.executor.calls.count, 1)
        let script = harness.executor.calls[0].script
        XCTAssertTrue(
            script.contains("if not (exists signature \"Sales \\\"EU\\\"\") then error \"\(signatureNotFoundMarker)\""),
            script)
        XCTAssertFalse(script.contains("outgoing message"), script)
        XCTAssertEqual(result["status"] as? String, "confirmation_required")
        XCTAssertEqual(result["signature"] as? String, "Sales \"EU\"")
    }

    func testConfirmedSendAppliesTheSignatureBeforeSending() throws {
        let result = try harness.call(
            "send_email", ["to": "a@x", "subject": "S", "body": "B", "signature": "Work", "confirm_send": true])

        XCTAssertEqual(harness.executor.calls.count, 1)
        let script = harness.executor.calls[0].script
        let apply = try XCTUnwrap(script.range(of: "set message signature of spwMsg to signature \"Work\""))
        let send = try XCTUnwrap(script.range(of: "send spwMsg"))
        XCTAssertLessThan(apply.lowerBound, send.lowerBound)
        XCTAssertEqual(result["status"] as? String, "sent")
        XCTAssertEqual(result["signature"] as? String, "Work")
    }

    func testWithoutAChosenSignatureASendADraftAndAReplyClearMailsDefaultSoOnlyThePreviewedTextGoesOut() throws {
        harness.executor.reply("")
        harness.executor.reply("")
        harness.executor.reply(replyRead())
        harness.executor.reply(replyRead())

        let sent = try harness.call("send_email", ["to": "a@x", "subject": "S", "body": "B", "confirm_send": true])
        _ = try harness.call("save_draft", ["subject": "S", "body": "B"])
        let reply = try harness.call("reply_to_email", ["id": archived.encoded, "body": "Ok", "confirm_send": true])

        let scripts = harness.executor.calls.map(\.script)
        XCTAssertEqual(scripts.count, 4)
        for (script, message) in [(scripts[0], "spwMsg"), (scripts[1], "spwMsg"), (scripts[3], "spwReply")] {
            XCTAssertTrue(script.contains("set message signature of \(message) to missing value"), script)
            XCTAssertFalse(script.contains("exists signature"), script)
        }
        let clear = try XCTUnwrap(scripts[0].range(of: "to missing value"))
        let send = try XCTUnwrap(scripts[0].range(of: "send spwMsg"))
        XCTAssertLessThan(clear.lowerBound, send.lowerBound)
        XCTAssertNil(sent["signature"])
        XCTAssertNil(reply["signature"])
    }

    func testAnUnknownSignatureIsReportedByNameBeforeAnythingIsSent() {
        harness.executor.fail(ScriptError.scriptFailed("execution error: \(signatureNotFoundMarker) (-2700)"))

        let error = harness.callFailing("send_email", ["to": "a@x", "subject": "S", "body": "B", "signature": "Nope"])

        XCTAssertEqual(error as? MailFailure, .signatureNotFound("Nope"))
        XCTAssertTrue((error as? MailFailure)?.errorDescription?.hasPrefix("MAIL_SIGNATURE_NOT_FOUND: ") == true)
        XCTAssertEqual(harness.executor.calls.count, 1)
    }

    func testAnEmptySignatureIsRefusedBeforeRunningAScript() {
        let error = harness.callFailing("send_email", ["to": "a@x", "subject": "S", "body": "B", "signature": ""])

        guard case MailError.invalidValue("signature", _) = error else {
            return XCTFail("expected invalidValue(signature), got \(error)")
        }
        XCTAssertTrue(harness.executor.calls.isEmpty)
    }

    func testReplyWithASignatureChecksItInThePreviewAndAppliesItWhenSending() throws {
        harness.executor.reply(replyRead())
        harness.executor.reply(replyRead())

        let preview = try harness.call("reply_to_email", ["id": archived.encoded, "body": "Ok", "signature": "Work"])
        let sent = try harness.call(
            "reply_to_email", ["id": archived.encoded, "body": "Ok", "signature": "Work", "confirm_send": true])

        XCTAssertTrue(harness.executor.calls[0].script.contains("if not (exists signature \"Work\")"))
        XCTAssertEqual(preview["signature"] as? String, "Work")
        let send = harness.executor.calls[2].script
        XCTAssertTrue(send.contains("set message signature of spwReply to signature \"Work\""), send)
        XCTAssertEqual(sent["signature"] as? String, "Work")
    }
}
