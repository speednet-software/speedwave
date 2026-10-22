import SharedCLI
import XCTest
@testable import mail_cli

final class ReplyScriptTests: XCTestCase {
    private let mail = MailId(accountId: "Work-ID", account: "Work", mailbox: "INBOX", messageId: "<a@x>")

    private let syntheticDate = """
        set spwDate to current date
        set day of spwDate to 1
        set year of spwDate to 2026
        set month of spwDate to October
        set day of spwDate to 20
        set time of spwDate to 9 * hours + 15 * minutes
        """

    private func scripts(_ command: String, _ params: [String: Any], reply: String) throws -> [String] {
        let harness = MailCommandHarness()
        harness.executor.reply(reply)
        _ = try harness.call(command, params)
        return harness.executor.calls.map(\.script)
    }

    private func tail(_ script: String) throws -> String {
        let end = try XCTUnwrap(script.range(of: "end tell", options: .backwards))
        return String(script[end.upperBound...])
    }

    func testTheSendCheckComparesAddressListsInAnyCaseAndOrderAndCountsThem() throws {
        let send = try XCTUnwrap(
            try scripts("reply_to_email", ["id": mail.encoded, "body": "b", "confirm_send": true], reply: replyRead())
                .last)
        let handler = try XCTUnwrap(send.components(separatedBy: "tell application \"Mail\"").first)
        let cases = """
            return {my spwSameAddresses({"Anna@X", "bob@x"}, {"bob@x", "anna@x"}), ¬
                my spwSameAddresses({"anna@x"}, {"anna@x", "bob@x"}), ¬
                my spwSameAddresses({"anna@x", "bob@x"}, {"anna@x"}), ¬
                my spwSameAddresses({}, {}), ¬
                my spwSameAddresses({"zoë@przykład.pl"}, {"ZOË@PRZYKŁAD.PL"}), ¬
                my spwSameAddresses({"a@x"}, {"b@x"})}
            """

        let output = try osascriptExecutor(handler + "\n" + cases, 15)

        XCTAssertEqual(output, "true, false, false, true, true, false")
    }

    func testTheReplyReadJoinsEveryFieldThePreviewReadsInRealAppleScript() throws {
        let read = try XCTUnwrap(
            try scripts("reply_to_email", ["id": mail.encoded, "body": "b"], reply: replyRead()).first)
        let values = syntheticDate + """

            set spwSubject to "Zażółć \\"q\\""
            set spwOriginalSender to "Anna <anna@x>"
            set spwReplyTo to "Billing <billing@x>"
            set spwTo to {"me@work.example", "bob@x"}
            set spwCc to {"carol@x"}
            set spwOriginal to "Hi" & linefeed & "there"
            set spwOwn to {"me@work.example", "me@home.example"}
            set spwFromName to "Me"
            set spwFromAddresses to {"me@home.example", "me@work.example"}
            """
        let output = try osascriptExecutor(values + (try tail(read)), 15)
        let harness = MailCommandHarness()
        harness.executor.reply(output)

        let result = try harness.call("reply_to_email", ["id": mail.encoded, "body": "Ok", "reply_all": true])

        XCTAssertEqual(result["subject"] as? String, "Re: Zażółć \"q\"")
        XCTAssertEqual(result["to"] as? [String], ["billing@x", "bob@x"])
        XCTAssertEqual(result["cc"] as? [String], ["carol@x"])
        XCTAssertEqual(result["from"] as? String, "Me <me@work.example>")
        XCTAssertEqual(
            result["body"] as? String, "Ok\n\nOn 20 Oct 2026 at 09:15, Anna <anna@x> wrote:\n\n> Hi\n> there\n")
    }

    func testTheForwardReadJoinsEveryFieldThePreviewReadsInRealAppleScript() throws {
        let read = try XCTUnwrap(
            try scripts("forward_email", ["id": mail.encoded, "to": "bob@x"], reply: forwardRead()).first)
        let values = syntheticDate + """

            set spwSubject to "Faktura 12"
            set spwOriginalSender to "Anna <anna@x>"
            set spwNames to {"faktura.pdf", "regulamin.pdf"}
            set spwTo to {"sales@work.example"}
            set spwCc to {}
            set spwFromName to ""
            set spwFromAddresses to {"me@work.example", "sales@work.example"}
            """
        let output = try osascriptExecutor(values + (try tail(read)), 15)
        let harness = MailCommandHarness()
        harness.executor.reply(output)

        let result = try harness.call("forward_email", ["id": mail.encoded, "to": "bob@x"])

        XCTAssertEqual(result["subject"] as? String, "Fwd: Faktura 12")
        XCTAssertEqual(result["from"] as? String, "sales@work.example")
        XCTAssertEqual(result["attachments"] as? [String], ["faktura.pdf", "regulamin.pdf"])
        let original = try XCTUnwrap(result["original"] as? [String: Any])
        XCTAssertEqual(original["subject"] as? String, "Faktura 12")
        XCTAssertTrue((original["date"] as? String)?.hasPrefix("2026-10-20T09:15:00") == true, "\(original)")
    }
}
