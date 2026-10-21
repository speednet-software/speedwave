import SharedCLI
import XCTest
@testable import mail_cli

final class SendEmailTests: XCTestCase {
    private let harness = MailCommandHarness()

    private let archived = MailId(account: "Work", mailbox: "Archive/2026", messageId: "<a@x>")

    private let message: [String: Any] = [
        "to": "alice@example.com, bob@example.com",
        "cc": "carol@example.com",
        "bcc": "dave@example.com",
        "subject": "Q4 report",
        "body": "Hi all,\nsee the numbers.",
    ]

    private func replyRead(
        subject: String = "Re: Invoice 12",
        to: [String] = ["anna@x"],
        cc: [String] = [],
        sender: String = "Anna <anna@x>",
        received: String = "2026-10-20T09:15:00",
        original: String = "Please pay.\n\nThanks"
    ) -> String {
        [subject, to.joined(separator: "\u{1E}"), cc.joined(separator: "\u{1E}"), sender, received, original]
            .joined(separator: "\u{1D}")
    }

    func testSendEmailWithoutConfirmationOnlyReadsTheSenderAndPreviewsExactlyWhatWouldGoOut() throws {
        harness.executor.reply("Anna Nowak <anna@work.example>")

        let result = try harness.call("send_email", message)

        XCTAssertEqual(harness.executor.calls.count, 1)
        let script = harness.executor.calls[0].script
        XCTAssertTrue(script.contains("set spwPrimary to primary email"), script)
        XCTAssertTrue(script.contains("return my spwClean(spwSender)"), script)
        XCTAssertFalse(script.contains("outgoing message"), script)
        XCTAssertFalse(script.contains("send "), script)
        XCTAssertEqual(result["status"] as? String, "confirmation_required")
        XCTAssertEqual(result["confirm_param"] as? String, "confirm_send")
        let instruction = try XCTUnwrap(result["instruction"] as? String)
        XCTAssertTrue(instruction.contains("sendEmail"), instruction)
        XCTAssertTrue(instruction.contains("confirm_send: true"), instruction)
        XCTAssertEqual(result["from"] as? String, "Anna Nowak <anna@work.example>")
        XCTAssertNil(result["account"])
        XCTAssertEqual(result["to"] as? [String], ["alice@example.com", "bob@example.com"])
        XCTAssertEqual(result["cc"] as? [String], ["carol@example.com"])
        XCTAssertEqual(result["bcc"] as? [String], ["dave@example.com"])
        XCTAssertEqual(result["subject"] as? String, "Q4 report")
        XCTAssertEqual(result["body"] as? String, "Hi all,\nsee the numbers.")
        XCTAssertNil(result["attachments"])
    }

    func testWithoutAnAccountTheSenderIsMailsPrimaryAddressOrElseTheFirstAddressOfATurnedOnAccount() throws {
        _ = try harness.call("send_email", message)

        let script = harness.executor.calls[0].script
        XCTAssertTrue(script.contains("repeat with spwCandidate in accounts"), script)
        XCTAssertTrue(script.contains("if enabled of spwCandidate then"), script)
        XCTAssertTrue(script.contains("if spwCandidateAddresses contains spwPrimary then"), script)
        XCTAssertTrue(script.contains("if spwAddress is \"\" then error \"\(noSenderMarker)\""), script)
        XCTAssertTrue(
            script.contains("if spwName is not \"\" then set spwSender to spwName & \" <\" & spwAddress & \">\""),
            script)
    }

    func testSendEmailFromAnAccountPreviewsTheAddressOfThatAccount() throws {
        harness.executor.reply("Work Me <me@work.example>")

        let result = try harness.call("send_email", message.merging(["account": "Work \"EU\""]) { $1 })

        XCTAssertEqual(harness.executor.calls.count, 1)
        let script = harness.executor.calls[0].script
        XCTAssertTrue(
            script.contains("if not (exists account \"Work \\\"EU\\\"\") then error \"\(accountNotFoundMarker)\""),
            script)
        XCTAssertTrue(script.contains("if not (enabled of spwAccount) then error \"\(accountDisabledMarker)\""), script)
        XCTAssertFalse(script.contains("primary email"), script)
        XCTAssertFalse(script.contains("outgoing message"), script)
        XCTAssertEqual(result["from"] as? String, "Work Me <me@work.example>")
        XCTAssertEqual(result["account"] as? String, "Work \"EU\"")
    }

    func testSendEmailFromAnUnknownOrTurnedOffAccountIsRefusedByName() {
        harness.executor.fail(ScriptError.scriptFailed("execution error: \(accountNotFoundMarker) (-2700)"))
        harness.executor.fail(ScriptError.scriptFailed("execution error: \(accountDisabledMarker) (-2700)"))

        let unknown = harness.callFailing("send_email", message.merging(["account": "Nope"]) { $1 })
        let disabled = harness.callFailing(
            "send_email", message.merging(["account": "Google", "confirm_send": true]) { $1 })

        XCTAssertEqual(unknown as? MailFailure, .accountNotFound("Nope"))
        XCTAssertEqual(disabled as? MailFailure, .accountDisabled("Google"))
    }

    func testAMailWithoutAnyAddressToSendFromIsReportedAsNoSender() {
        harness.executor.fail(ScriptError.scriptFailed("execution error: \(noSenderMarker) (-2700)"))

        let error = harness.callFailing("send_email", message)

        XCTAssertEqual(error as? MailFailure, .noSender)
        XCTAssertTrue((error as? MailFailure)?.errorDescription?.hasPrefix("MAIL_NO_SENDER: ") == true)
    }

    func testConfirmedSendGoesFromTheSenderItReadsAndReportsIt() throws {
        harness.executor.reply("Work Me <me@work.example>")

        let result = try harness.call(
            "send_email", message.merging(["account": "Work", "confirm_send": true]) { $1 })

        XCTAssertEqual(harness.executor.calls.count, 1)
        let script = harness.executor.calls[0].script
        let read = try XCTUnwrap(script.range(of: "set spwAddresses to email addresses of spwAccount"))
        let make = try XCTUnwrap(script.range(of: "make new outgoing message"))
        let sender = try XCTUnwrap(script.range(of: "set sender of spwMsg to spwSender"))
        let send = try XCTUnwrap(script.range(of: "send spwMsg"))
        let report = try XCTUnwrap(script.range(of: "return my spwClean(spwSender)"))
        XCTAssertLessThan(read.lowerBound, make.lowerBound)
        XCTAssertLessThan(make.lowerBound, sender.lowerBound)
        XCTAssertLessThan(sender.lowerBound, send.lowerBound)
        XCTAssertLessThan(send.lowerBound, report.lowerBound)
        XCTAssertEqual(result["status"] as? String, "sent")
        XCTAssertEqual(result["from"] as? String, "Work Me <me@work.example>")
        XCTAssertEqual(result["account"] as? String, "Work")
    }

    func testSendEmailWithoutCcOrBccPreviewsEmptyLists() throws {
        let result = try harness.call("send_email", ["to": "alice@example.com", "subject": "S", "body": "B"])

        XCTAssertEqual(result["cc"] as? [String], [])
        XCTAssertEqual(result["bcc"] as? [String], [])
    }

    func testSendConfirmationMustBeTheBooleanTrue() throws {
        for flag in ["true", 1, false] as [Any] {
            let result = try harness.call("send_email", message.merging(["confirm_send": flag]) { $1 })
            XCTAssertEqual(result["status"] as? String, "confirmation_required")
        }
        XCTAssertEqual(harness.executor.calls.count, 3)
        XCTAssertFalse(harness.executor.calls.contains { $0.script.contains("outgoing message") })
    }

    func testConfirmedSendEmailSendsToEveryRecipientAndReportsWhatWentOut() throws {
        let result = try harness.call("send_email", message.merging(["confirm_send": true]) { $1 })

        XCTAssertEqual(harness.executor.calls.count, 1)
        let script = harness.executor.calls[0].script
        for (kind, address) in [
            ("to", "alice@example.com"), ("to", "bob@example.com"), ("cc", "carol@example.com"),
            ("bcc", "dave@example.com"),
        ] {
            XCTAssertTrue(
                script.contains("make new \(kind) recipient at end of \(kind) recipients with properties {address:\"\(address)\"}"),
                script)
        }
        XCTAssertTrue(script.contains("if not (send spwMsg) then error \"\(sendFailedMarker)\""), script)
        XCTAssertEqual(result["status"] as? String, "sent")
        XCTAssertNil(result["confirm_param"])
        XCTAssertNil(result["instruction"])
        XCTAssertEqual(result["to"] as? [String], ["alice@example.com", "bob@example.com"])
        XCTAssertEqual(result["subject"] as? String, "Q4 report")
    }

    func testSendEmailKeepsLineBreaksTabsQuotesAndBackslashesOfTheText() throws {
        _ = try harness.call(
            "send_email",
            [
                "to": "alice@example.com",
                "subject": "Say \"hi\"\n",
                "body": "Line \"one\"\r\nC:\\temp\tdone\rlast\u{07}",
                "confirm_send": true,
            ])

        let script = harness.executor.calls[0].script
        XCTAssertTrue(script.contains("subject:\"Say \\\"hi\\\"\""), script)
        XCTAssertTrue(script.contains("content:\"Line \\\"one\\\"\\nC:\\\\temp\\tdone\\nlast\""), script)
    }

    func testSendEmailThatMailDidNotSendIsReportedAsSendFailed() throws {
        harness.executor.fail(ScriptError.scriptFailed("execution error: \(sendFailedMarker) (-2700)"))

        let error = harness.callFailing("send_email", message.merging(["confirm_send": true]) { $1 })

        XCTAssertEqual(error as? MailFailure, .sendFailed)
        XCTAssertTrue((error as? MailFailure)?.errorDescription?.hasPrefix("MAIL_SEND_FAILED: ") == true)
    }

    func testReplyWithoutConfirmationReadsTheReplyMailWouldSendAndSendsNothing() throws {
        harness.executor.reply(replyRead(to: ["anna@x"], cc: ["ewa@x"]))

        let result = try harness.call("reply_to_email", ["id": archived.encoded, "body": "Paid today."])

        XCTAssertEqual(harness.executor.calls.count, 1)
        let script = harness.executor.calls[0].script
        XCTAssertTrue(script.contains("set mb to item 1 of spwMatches"), script)
        XCTAssertTrue(script.contains("mailbox \"Archive/2026\" of spwAcct"), script)
        XCTAssertTrue(script.contains("{account \"Work\"}"), script)
        XCTAssertTrue(script.contains("whose message id is \"<a@x>\""), script)
        XCTAssertFalse(script.contains("of inbox"), script)
        XCTAssertTrue(script.contains("set spwReply to reply m opening window false reply to all false"), script)
        XCTAssertTrue(script.contains("close spwReply saving no"), script)
        XCTAssertFalse(script.contains("send spwReply"), script)
        XCTAssertEqual(result["status"] as? String, "confirmation_required")
        XCTAssertEqual(result["confirm_param"] as? String, "confirm_send")
        XCTAssertTrue((result["instruction"] as? String)?.contains("replyToEmail") == true)
        XCTAssertEqual(result["to"] as? [String], ["anna@x"])
        XCTAssertEqual(result["cc"] as? [String], ["ewa@x"])
        XCTAssertEqual(result["bcc"] as? [String], [])
        XCTAssertFalse(script.contains("make new"), script)
        XCTAssertEqual(result["subject"] as? String, "Re: Invoice 12")
        XCTAssertEqual(
            result["body"] as? String,
            "Paid today.\n\nOn 20 Oct 2026 at 09:15, Anna <anna@x> wrote:\n\n> Please pay.\n>\n> Thanks\n")
    }

    func testReplyAllAsksMailForTheReplyToAll() throws {
        harness.executor.reply(replyRead(to: ["anna@x", "bob@x"]))

        let result = try harness.call(
            "reply_to_email", ["id": archived.encoded, "body": "Paid.", "reply_all": true])

        XCTAssertTrue(harness.executor.calls[0].script.contains("reply to all true"))
        XCTAssertEqual(result["to"] as? [String], ["anna@x", "bob@x"])
    }

    func testConfirmedReplySendsTheReplyWithTheTextOfThePreview() throws {
        harness.executor.reply(replyRead(original: "Say \"yes\""))

        let result = try harness.call(
            "reply_to_email", ["id": archived.encoded, "body": "Yes.\n", "confirm_send": true])

        XCTAssertEqual(harness.executor.calls.count, 2)
        let send = harness.executor.calls[1].script
        XCTAssertTrue(send.contains("whose message id is \"<a@x>\""), send)
        XCTAssertTrue(send.contains("set spwReply to reply m opening window false reply to all false"), send)
        XCTAssertTrue(
            send.contains(
                "set content of spwReply to \"Yes.\\n\\nOn 20 Oct 2026 at 09:15, Anna <anna@x> wrote:\\n\\n> Say \\\"yes\\\"\\n\""),
            send)
        XCTAssertTrue(send.contains("if not (send spwReply) then error \"\(sendFailedMarker)\""), send)
        XCTAssertEqual(result["status"] as? String, "sent")
        XCTAssertEqual(result["body"] as? String, "Yes.\n\nOn 20 Oct 2026 at 09:15, Anna <anna@x> wrote:\n\n> Say \"yes\"\n")
    }

    func testReplyPreviewAddsTheGivenCcAndBccToTheRecipientsMailChose() throws {
        harness.executor.reply(replyRead(to: ["anna@x"], cc: ["ewa@x"]))

        let result = try harness.call(
            "reply_to_email",
            ["id": archived.encoded, "body": "Ok", "cc": "jan@x, ANNA@x, Ewa@x, jan@x", "bcc": "boss@x"])

        XCTAssertEqual(harness.executor.calls.count, 1)
        XCTAssertFalse(harness.executor.calls[0].script.contains("make new"))
        XCTAssertEqual(result["to"] as? [String], ["anna@x"])
        XCTAssertEqual(result["cc"] as? [String], ["ewa@x", "jan@x"])
        XCTAssertEqual(result["bcc"] as? [String], ["boss@x"])
    }

    func testConfirmedReplyAddsTheSameCcAndBccThePreviewShowed() throws {
        harness.executor.reply(replyRead(to: ["anna@x"], cc: ["ewa@x"]))

        let result = try harness.call(
            "reply_to_email",
            ["id": archived.encoded, "body": "Ok", "cc": "jan@x, ewa@x", "bcc": "boss@x", "confirm_send": true])

        XCTAssertEqual(harness.executor.calls.count, 2)
        let send = harness.executor.calls[1].script
        let reply = try XCTUnwrap(send.range(of: "set spwReply to reply m"))
        let cc = try XCTUnwrap(
            send.range(of: "make new cc recipient at end of cc recipients with properties {address:\"jan@x\"}"))
        let bcc = try XCTUnwrap(
            send.range(of: "make new bcc recipient at end of bcc recipients with properties {address:\"boss@x\"}"))
        let sending = try XCTUnwrap(send.range(of: "send spwReply"))
        XCTAssertLessThan(reply.lowerBound, cc.lowerBound)
        XCTAssertLessThan(cc.lowerBound, bcc.lowerBound)
        XCTAssertLessThan(bcc.lowerBound, sending.lowerBound)
        XCTAssertTrue(send.contains("tell spwReply\n"), send)
        XCTAssertFalse(send.contains("{address:\"ewa@x\"}"), send)
        XCTAssertEqual(result["status"] as? String, "sent")
        XCTAssertEqual(result["cc"] as? [String], ["ewa@x", "jan@x"])
        XCTAssertEqual(result["bcc"] as? [String], ["boss@x"])
    }

    func testConfirmedReplyWithoutExtraRecipientsAddsNone() throws {
        harness.executor.reply(replyRead())

        _ = try harness.call("reply_to_email", ["id": archived.encoded, "body": "Ok", "confirm_send": true])

        XCTAssertFalse(harness.executor.calls[1].script.contains("make new"))
    }

    func testReplyRefusesAnEmptyCcOrBccBeforeRunningAScript() {
        for field in ["cc", "bcc"] {
            let error = harness.callFailing("reply_to_email", ["id": archived.encoded, "body": "Ok", field: " , "])
            guard case MailError.emptyRecipients(field) = error else {
                return XCTFail("expected emptyRecipients(\(field)), got \(error)")
            }
        }
        XCTAssertTrue(harness.executor.calls.isEmpty)
    }

    func testAReplyToAMailWithoutADateQuotesOnlyTheSender() {
        XCTAssertEqual(
            MailSending.replyText(body: "Ok", sender: "Anna", received: nil, original: "Hi\r\nthere\r\n"),
            "Ok\n\nAnna wrote:\n\n> Hi\n> there\n")
    }

    func testAReplyToAnEmptyMailQuotesNothing() {
        XCTAssertEqual(
            MailSending.replyText(body: "Ok", sender: "Anna", received: nil, original: ""),
            "Ok\n\nAnna wrote:\n")
    }

    func testReplyRefusesAMissingBodyBeforeRunningAScript() {
        let error = harness.callFailing("reply_to_email", ["id": archived.encoded])

        guard case MailError.missingField("body") = error else {
            return XCTFail("expected missingField(body), got \(error)")
        }
        XCTAssertTrue(harness.executor.calls.isEmpty)
    }

    func testAnUnexpectedReplyReadFailsWithoutSending() {
        harness.executor.reply("garbage")

        let error = harness.callFailing("reply_to_email", ["id": archived.encoded, "body": "B", "confirm_send": true])

        guard case ScriptError.scriptFailed = error else {
            return XCTFail("expected scriptFailed, got \(error)")
        }
        XCTAssertEqual(harness.executor.calls.count, 1)
    }
}
