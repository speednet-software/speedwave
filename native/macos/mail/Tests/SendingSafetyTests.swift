import SharedCLI
import XCTest
@testable import mail_cli

final class SendingSafetyTests: XCTestCase {
    private let harness = MailCommandHarness()
    private let mail = MailId(accountId: "W-1", account: "Work", mailbox: "INBOX", messageId: "<a@x>")
    private let from = "Me <me@work.example>"

    private func assertClosesOnError(_ script: String, _ message: String, file: StaticString = #filePath, line: UInt = #line) {
        let cleanup = """
            on error spwErr number spwNum
                    try
                        close \(message) saving no
                    end try
                    error spwErr number spwNum
            """
        XCTAssertTrue(script.contains(cleanup), script, file: file, line: line)
    }

    func testEveryScriptThatMakesAnOutgoingMessageClosesItUnsavedWhenAnythingFailsBeforeItIsSentAndReraises() throws {
        let calls: [(String, [String: Any], [String], String)] = [
            ("reply_to_email", ["id": mail.encoded, "body": "b", "confirm_send": true], [replyRead()], "spwReply"),
            ("forward_email", ["id": mail.encoded, "to": "b@x", "confirm_send": true], [forwardRead()], "spwOut"),
            ("redirect_email", ["id": mail.encoded, "to": "b@x"], [redirectRead()], "spwOut"),
            ("redirect_email", ["id": mail.encoded, "to": "b@x", "confirm_send": true], [redirectRead()], "spwOut"),
            ("send_email", ["to": "a@x", "subject": "s", "body": "b", "confirm_send": true], [], "spwMsg"),
            ("save_draft", ["subject": "s"], [], "spwMsg"),
        ]
        for (command, params, replies, message) in calls {
            let probe = MailCommandHarness()
            replies.forEach(probe.executor.reply)
            _ = try probe.call(command, params)
            let makers = probe.executor.calls.map(\.script).filter {
                $0.contains("opening window false") || $0.contains("make new outgoing message")
            }
            XCTAssertFalse(makers.isEmpty, command)
            makers.forEach { assertClosesOnError($0, message) }
            for script in makers where script.contains("send \(message)") {
                let guarded = try XCTUnwrap(script.range(of: "error spwErr number spwNum"))
                let send = try XCTUnwrap(script.range(of: "send \(message)"))
                XCTAssertLessThan(guarded.lowerBound, send.lowerBound, "\(command): the send is outside the guard")
            }
        }
    }

    func testAReplyOrForwardPreviewMakesNoMessageInMailWhileARedirectPreviewNamesTheSenderOfMailsRedirect() throws {
        let previews: [(String, [String: Any], String)] = [
            ("reply_to_email", ["id": mail.encoded, "body": "b"], replyRead()),
            ("reply_to_email", ["id": mail.encoded, "body": "b", "reply_all": true], replyRead()),
            ("forward_email", ["id": mail.encoded, "to": "b@x"], forwardRead()),
        ]
        for (command, params, read) in previews {
            let probe = MailCommandHarness()
            probe.executor.reply(read)

            let result = try probe.call(command, params)

            XCTAssertEqual(result["from"] as? String, from, command)
            let script = try XCTUnwrap(probe.executor.calls.first?.script)
            XCTAssertEqual(probe.executor.calls.count, 1, command)
            for maker in ["reply m", "forward m", "redirect m", "opening window", "outgoing message", "make new"] {
                XCTAssertFalse(script.contains(maker), "\(command): \(maker)\n\(script)")
            }
        }

        harness.executor.reply(redirectRead())
        let result = try harness.call("redirect_email", ["id": mail.encoded, "to": "b@x"])
        XCTAssertEqual(result["from"] as? String, from)
        let script = try XCTUnwrap(harness.executor.calls.first?.script)
        XCTAssertTrue(script.contains("redirect m opening window false"), script)
        XCTAssertTrue(script.contains("sender of spwOut"), script)
    }

    func testAReplyForwardOrRedirectOfAMailInATurnedOffAccountIsRefusedBeforeAnythingIsMade() throws {
        let calls: [(String, [String: Any])] = [
            ("reply_to_email", ["id": mail.encoded, "body": "b"]),
            ("forward_email", ["id": mail.encoded, "to": "b@x"]),
            ("redirect_email", ["id": mail.encoded, "to": "b@x"]),
        ]
        for (command, params) in calls {
            let probe = MailCommandHarness()
            probe.executor.fail(ScriptError.scriptFailed("\(accountDisabledMarker) (-2700)"))

            let error = probe.callFailing(command, params)

            XCTAssertEqual(error as? MailFailure, .accountDisabled("Work"), command)
            XCTAssertEqual(probe.executor.calls.count, 1, command)
            let script = try XCTUnwrap(probe.executor.calls.first?.script)
            let check = try XCTUnwrap(script.range(of: "if not (enabled of spwAcct) then error \"\(accountDisabledMarker)\""))
            if let make = script.range(of: "opening window false") {
                XCTAssertLessThan(check.lowerBound, make.lowerBound, command)
            }
        }
    }

    func testARecipientWithALineSeparatorIsPreviewedExactlyAsItIsSent() throws {
        harness.executor.reply(from)

        let result = try harness.call("send_email", ["to": "anna@x\u{2028}.com, bob@x", "subject": "s", "body": "b"])

        XCTAssertEqual(result["to"] as? [String], ["anna@x.com", "bob@x"])
    }

    func testOnMyMacIsRefusedAsTheAccountOfASendADraftOrAFetchBeforeAnyScriptRuns() {
        let calls: [(String, [String: Any])] = [
            ("send_email", ["to": "a@x", "subject": "s", "body": "b", "account": "On My Mac"]),
            ("save_draft", ["subject": "s", "account": "On My Mac"]),
            ("check_mail", ["account": "On My Mac"]),
        ]
        for (command, params) in calls {
            let error = harness.callFailing(command, params)
            XCTAssertTrue(error.localizedDescription.contains("On My Mac has no mail server"), "\(command): \(error)")
        }
        XCTAssertTrue(harness.executor.calls.isEmpty)
    }
}
