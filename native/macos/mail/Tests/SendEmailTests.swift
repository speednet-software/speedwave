import SharedCLI
import XCTest
@testable import mail_cli

final class SendEmailTests: XCTestCase {
    private let harness = MailCommandHarness()

    private let archived = MailId(accountId: "Work-ID", account: "Work", mailbox: "Archive/2026", messageId: "<a@x>")

    private let message: [String: Any] = [
        "to": "alice@example.com, bob@example.com",
        "cc": "carol@example.com",
        "bcc": "dave@example.com",
        "subject": "Q4 report",
        "body": "Hi all,\nsee the numbers.",
    ]

    func testSendEmailWithoutConfirmationOnlyReadsTheSenderAndPreviewsExactlyWhatWouldGoOut() throws {
        harness.executor.reply("Anna Nowak <anna@work.example>")

        let result = try harness.call("send_email", message)

        XCTAssertEqual(harness.executor.calls.count, 1)
        let script = harness.executor.calls[0].script
        XCTAssertNotNil(script.range(of: #"try\s+set spwPrimary to primary email\s+end try"#, options: .regularExpression), script)
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
        XCTAssertTrue(script.contains("set spwNamed to (every account whose name is \"Work \\\"EU\\\"\")"), script)
        XCTAssertTrue(script.contains("if (count of spwNamed) is 0 then error \"\(accountNotFoundMarker)\""), script)
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

    func testReplyPreviewOnlyReadsTheOriginalAndMakesNoMessageInMail() throws {
        harness.executor.reply(replyRead())

        let result = try harness.call("reply_to_email", ["id": archived.encoded, "body": "Paid today."])

        XCTAssertEqual(harness.executor.calls.count, 1)
        let script = harness.executor.calls[0].script
        XCTAssertTrue(script.contains("set mb to mailbox \"Archive/2026\" of spwAcct"), script)
        XCTAssertTrue(script.contains("set spwAcct to account id \"Work-ID\""), script)
        XCTAssertTrue(script.contains("whose message id is \"<a@x>\""), script)
        XCTAssertTrue(script.contains("reply to of m"), script)
        XCTAssertFalse(script.contains("of inbox"), script)
        XCTAssertFalse(script.contains("reply m"), script)
        XCTAssertFalse(script.contains("opening window"), script)
        XCTAssertFalse(script.contains("outgoing message"), script)
        XCTAssertFalse(script.contains("make new"), script)
        XCTAssertFalse(script.contains("send "), script)
        XCTAssertEqual(result["status"] as? String, "confirmation_required")
        XCTAssertEqual(result["confirm_param"] as? String, "confirm_send")
        XCTAssertTrue((result["instruction"] as? String)?.contains("replyToEmail") == true)
        XCTAssertEqual(result["to"] as? [String], ["anna@x"])
        XCTAssertEqual(result["cc"] as? [String], [])
        XCTAssertEqual(result["bcc"] as? [String], [])
        XCTAssertEqual(result["subject"] as? String, "Re: Invoice 12")
        XCTAssertEqual(result["from"] as? String, "Me <me@work.example>")
        XCTAssertEqual(
            result["body"] as? String,
            "Paid today.\n\nOn 20 Oct 2026 at 09:15, Anna <anna@x> wrote:\n\n> Please pay.\n>\n> Thanks\n")
    }

    func testAReplyGoesToTheReplyToAddressesOfTheOriginalWhenItHasThem() throws {
        harness.executor.reply(replyRead(replyTo: "Billing <billing@x>, \"Help, desk\" <help@x>, Billing@X"))

        let result = try harness.call("reply_to_email", ["id": archived.encoded, "body": "Ok"])

        XCTAssertEqual(result["to"] as? [String], ["billing@x", "help@x"])
    }

    func testAReplyToASenderWithoutANameGoesToItsAddress() throws {
        harness.executor.reply(replyRead(sender: "  zoë@przykład.pl "))

        let result = try harness.call("reply_to_email", ["id": archived.encoded, "body": "Ok"])

        XCTAssertEqual(result["to"] as? [String], ["zoë@przykład.pl"])
    }

    func testAPlainReplyLeavesTheOtherRecipientsOfTheOriginalOut() throws {
        harness.executor.reply(replyRead(to: ["me@work.example", "bob@x"], cc: ["carol@x"]))

        let result = try harness.call("reply_to_email", ["id": archived.encoded, "body": "Ok"])

        XCTAssertEqual(result["to"] as? [String], ["anna@x"])
        XCTAssertEqual(result["cc"] as? [String], [])
    }

    func testReplyAllCopiesTheOriginalsOtherToAndCcRecipientsWithoutTheUsersOwnAddressesOrRepeatsIgnoringCase() throws {
        harness.executor.reply(
            replyRead(
                sender: "Anna <Anna@x>",
                to: ["ME@work.example", "Bob <bob@x>", "anna@X", "Zoë <zoë@x>"],
                cc: ["carol@x", "me@HOME.example", "BOB@x", "carol@x"]))

        let result = try harness.call("reply_to_email", ["id": archived.encoded, "body": "Ok", "reply_all": true])

        XCTAssertEqual(result["to"] as? [String], ["Anna@x"])
        XCTAssertEqual(result["cc"] as? [String], ["bob@x", "zoë@x", "carol@x"])
    }

    func testAReplyToAMailTheUserSentGoesToItsRecipientsInsteadOfBackToTheUser() throws {
        harness.executor.reply(
            replyRead(sender: "Me <ME@home.example>", to: ["bob@x", "me@work.example"], cc: ["carol@x"]))
        let plain = try harness.call("reply_to_email", ["id": archived.encoded, "body": "Ok"])
        harness.executor.reply(
            replyRead(sender: "Me <ME@home.example>", to: ["bob@x", "me@work.example"], cc: ["carol@x"]))
        let all = try harness.call("reply_to_email", ["id": archived.encoded, "body": "Ok", "reply_all": true])

        XCTAssertEqual(plain["to"] as? [String], ["bob@x"])
        XCTAssertEqual(plain["cc"] as? [String], [])
        XCTAssertEqual(all["to"] as? [String], ["bob@x"])
        XCTAssertEqual(all["cc"] as? [String], ["carol@x"])
    }

    func testAReplyToAMailTheUserSentWithAReplyToGoesThere() throws {
        harness.executor.reply(replyRead(sender: "me@home.example", replyTo: "list@x", to: ["bob@x"]))

        let result = try harness.call("reply_to_email", ["id": archived.encoded, "body": "Ok"])

        XCTAssertEqual(result["to"] as? [String], ["list@x"])
    }

    func testAReplySubjectGetsOneRePrefixWhateverItsCase() throws {
        let cases = [
            ("Invoice 12", "Re: Invoice 12"),
            ("RE: Invoice 12", "RE: Invoice 12"),
            ("re:Invoice 12", "re:Invoice 12"),
            ("  Re: Invoice", "  Re: Invoice"),
            ("Fwd: Zażółć", "Re: Fwd: Zażółć"),
            ("Reminder", "Re: Reminder"),
            ("", "Re: "),
        ]
        for (original, expected) in cases {
            let probe = MailCommandHarness()
            probe.executor.reply(replyRead(subject: original))
            let result = try probe.call("reply_to_email", ["id": archived.encoded, "body": "Ok"])
            XCTAssertEqual(result["subject"] as? String, expected, original)
        }
    }

    func testAReplyGoesFromTheAddressOfTheAccountTheOriginalWasSentTo() throws {
        let addresses = ["me@work.example", "sales@work.example"]
        let cases: [([String], [String], String, String)] = [
            (["SALES@work.example"], [], "Work Me", "Work Me <sales@work.example>"),
            (["bob@x"], ["sales@work.example"], "Work Me", "Work Me <sales@work.example>"),
            (["bob@x"], [], "Work Me", "Work Me <me@work.example>"),
            (["sales@work.example"], [], "", "sales@work.example"),
        ]
        for (to, cc, name, from) in cases {
            let probe = MailCommandHarness()
            probe.executor.reply(replyRead(to: to, cc: cc, fromName: name, fromAddresses: addresses))
            let result = try probe.call("reply_to_email", ["id": archived.encoded, "body": "Ok"])
            XCTAssertEqual(result["from"] as? String, from, "\(to) \(cc)")
        }
    }

    func testAReplyFromAnAccountWithoutAnAddressIsReportedAsNoSender() {
        harness.executor.reply(replyRead(fromAddresses: []))

        let error = harness.callFailing("reply_to_email", ["id": archived.encoded, "body": "Ok", "confirm_send": true])

        XCTAssertEqual(error as? MailFailure, .noSender)
        XCTAssertEqual(harness.executor.calls.count, 1)
    }

    func testAReplyToAnOnMyMacMailGoesFromMailsDefaultSender() throws {
        let local = MailId(accountId: "", account: "On My Mac", mailbox: "Speedwave-Test", messageId: "<a@x>")
        harness.executor.reply(replyRead(fromName: "Me", fromAddresses: ["me@home.example"]))

        let result = try harness.call("reply_to_email", ["id": local.encoded, "body": "Ok"])

        let script = harness.executor.calls[0].script
        XCTAssertTrue(script.contains("set spwPrimary to primary email"), script)
        XCTAssertFalse(script.contains("email addresses of spwAcct"), script)
        XCTAssertEqual(result["from"] as? String, "Me <me@home.example>")
    }

    func testConfirmedReplySendsMailsReplyOnlyWhenItMatchesThePreviewAndWithThePreviewedText() throws {
        harness.executor.reply(replyRead(original: "Say \"yes\""))

        let result = try harness.call(
            "reply_to_email", ["id": archived.encoded, "body": "Yes.\n", "confirm_send": true])

        XCTAssertEqual(harness.executor.calls.count, 2)
        XCTAssertFalse(harness.executor.calls[0].script.contains("reply m"))
        let send = harness.executor.calls[1].script
        XCTAssertTrue(send.contains("whose message id is \"<a@x>\""), send)
        XCTAssertTrue(send.contains("set spwReply to reply m opening window false reply to all false"), send)
        let steps = [
            "set subject of spwReply to \"Re: Invoice 12\"",
            "set sender of spwReply to \"Me <me@work.example>\"",
            "if not my spwSameAddresses(spwSeenTo, {\"anna@x\"}) then error \"\(previewChangedMarker)\"",
            "if not my spwSameAddresses(spwSeenCc, {}) then error \"\(previewChangedMarker)\"",
            "if (extract address from (sender of spwReply)) is not \"me@work.example\" then error \"\(previewChangedMarker)\"",
            "set content of spwReply",
        ]
        let positions = try steps.map { step in
            try XCTUnwrap(send.range(of: step), "\(step)\n\(send)").lowerBound
        }
        XCTAssertEqual(positions, positions.sorted(), send)
        XCTAssertFalse(send.contains("subject of spwReply) is not"), send)
        XCTAssertTrue(
            send.contains(
                "set content of spwReply to \"Yes.\\n\\nOn 20 Oct 2026 at 09:15, Anna <anna@x> wrote:\\n\\n> Say \\\"yes\\\"\\n\""),
            send)
        XCTAssertTrue(send.contains("if not (send spwReply) then error \"\(sendFailedMarker)\""), send)
        XCTAssertEqual(result["status"] as? String, "sent")
        XCTAssertEqual(result["body"] as? String, "Yes.\n\nOn 20 Oct 2026 at 09:15, Anna <anna@x> wrote:\n\n> Say \"yes\"\n")
    }

    func testConfirmedReplyAllChecksMailsReplyAgainstTheRecipientsOfThePreview() throws {
        harness.executor.reply(replyRead(to: ["me@work.example", "bob@x"], cc: ["carol@x"]))

        _ = try harness.call(
            "reply_to_email", ["id": archived.encoded, "body": "Ok", "reply_all": true, "confirm_send": true])

        let send = harness.executor.calls[1].script
        XCTAssertTrue(send.contains("reply to all true"), send)
        XCTAssertTrue(send.contains("spwSameAddresses(spwSeenTo, {\"anna@x\"})"), send)
        XCTAssertTrue(send.contains("spwSameAddresses(spwSeenCc, {\"bob@x\", \"carol@x\"})"), send)
    }

    func testAReplyMailWouldSendOtherwiseThanPreviewedIsReportedAsPreviewChanged() {
        harness.executor.reply(replyRead())
        harness.executor.fail(ScriptError.scriptFailed("execution error: \(previewChangedMarker) (-2700)"))

        let error = harness.callFailing("reply_to_email", ["id": archived.encoded, "body": "Ok", "confirm_send": true])

        XCTAssertEqual(error as? MailFailure, .previewChanged)
        XCTAssertTrue((error as? MailFailure)?.errorDescription?.hasPrefix("MAIL_PREVIEW_CHANGED: ") == true)
    }

    func testReplyPreviewAddsTheGivenCcAndBccToTheRecipientsOfTheReply() throws {
        harness.executor.reply(replyRead(cc: ["ewa@x"]))

        let result = try harness.call(
            "reply_to_email",
            [
                "id": archived.encoded, "body": "Ok", "reply_all": true,
                "cc": "jan@x, ANNA@x, Ewa@x, jan@x", "bcc": "boss@x",
            ])

        XCTAssertEqual(harness.executor.calls.count, 1)
        XCTAssertEqual(result["to"] as? [String], ["anna@x"])
        XCTAssertEqual(result["cc"] as? [String], ["ewa@x", "jan@x"])
        XCTAssertEqual(result["bcc"] as? [String], ["boss@x"])
    }

    func testConfirmedReplyAddsTheSameCcAndBccThePreviewShowedAfterTheCheck() throws {
        harness.executor.reply(replyRead(cc: ["ewa@x"]))

        let result = try harness.call(
            "reply_to_email",
            [
                "id": archived.encoded, "body": "Ok", "reply_all": true, "cc": "jan@x, ewa@x", "bcc": "boss@x",
                "confirm_send": true,
            ])

        XCTAssertEqual(harness.executor.calls.count, 2)
        let send = harness.executor.calls[1].script
        let reply = try XCTUnwrap(send.range(of: "set spwReply to reply m"))
        let check = try XCTUnwrap(send.range(of: "spwSameAddresses(spwSeenCc, {\"ewa@x\"})"))
        let cc = try XCTUnwrap(
            send.range(of: "make new cc recipient at end of cc recipients with properties {address:\"jan@x\"}"))
        let bcc = try XCTUnwrap(
            send.range(of: "make new bcc recipient at end of bcc recipients with properties {address:\"boss@x\"}"))
        let sending = try XCTUnwrap(send.range(of: "send spwReply"))
        XCTAssertLessThan(reply.lowerBound, check.lowerBound)
        XCTAssertLessThan(check.lowerBound, cc.lowerBound)
        XCTAssertLessThan(cc.lowerBound, bcc.lowerBound)
        XCTAssertLessThan(bcc.lowerBound, sending.lowerBound)
        XCTAssertTrue(send.contains("tell spwReply\n"), send)
        XCTAssertFalse(send.contains("{address:\"ewa@x\"}"), send)
        XCTAssertEqual(result["status"] as? String, "sent")
        XCTAssertEqual(result["cc"] as? [String], ["ewa@x", "jan@x"])
        XCTAssertEqual(result["bcc"] as? [String], ["boss@x"])
    }

    func testReplyBccLeavesOutAddressesAlreadyInToOrCcAndRepeatsIgnoringCase() throws {
        harness.executor.reply(replyRead(cc: ["ewa@x"]))

        let result = try harness.call(
            "reply_to_email",
            [
                "id": archived.encoded, "body": "Ok", "reply_all": true, "cc": "jan@x",
                "bcc": "Anna@x, EWA@x, JAN@x, boss@x, Boss@x",
            ])

        XCTAssertEqual(result["cc"] as? [String], ["ewa@x", "jan@x"])
        XCTAssertEqual(result["bcc"] as? [String], ["boss@x"])
    }

    func testConfirmedReplyAddsOnlyTheBccThePreviewShowed() throws {
        harness.executor.reply(replyRead())

        let result = try harness.call(
            "reply_to_email",
            ["id": archived.encoded, "body": "Ok", "bcc": "ANNA@x, boss@x, boss@x", "confirm_send": true])

        let send = harness.executor.calls[1].script
        XCTAssertEqual(send.components(separatedBy: "make new bcc recipient").count - 1, 1, send)
        XCTAssertTrue(send.contains("{address:\"boss@x\"}"), send)
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
