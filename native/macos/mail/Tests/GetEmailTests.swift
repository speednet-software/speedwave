import SharedCLI
import XCTest
@testable import mail_cli

final class GetEmailTests: XCTestCase {
    private let harness = MailCommandHarness()
    private let mailId = MailId(account: "Work", mailbox: "Archive/2026", messageId: "<a@x>")

    private struct Reply {
        var subject = "Quarterly report"
        var sender = "Anna <anna@x>"
        var received = "2026-10-20T09:15:00"
        var read = true
        var to = ["me@x", "bob@x"]
        var cc = ["ewa@x"]
        var attachments: [[String]] = [["report.pdf", "48213", "application/pdf"], ["logo.png", "", "image/png"]]
        var headers = ""
        var headersTruncated = false
        var source = ""
        var sourceTruncated = false
        var flag = "-1"
        var body = "Hello,\nsee attached."

        var output: String {
            [
                subject,
                sender,
                received,
                read ? "true" : "false",
                to.joined(separator: "\u{1E}"),
                cc.joined(separator: "\u{1E}"),
                attachments.map { $0.joined(separator: "\u{1F}") }.joined(separator: "\u{1E}"),
                headers,
                headersTruncated ? "true" : "false",
                source,
                sourceTruncated ? "true" : "false",
                flag,
                body,
            ].joined(separator: "\u{1D}")
        }
    }

    private func email(_ params: [String: Any] = [:], reply: Reply = Reply()) throws -> [String: Any] {
        harness.executor.reply(reply.output)
        let result = try harness.call("get_email", params.merging(["id": mailId.encoded]) { $1 })
        return try XCTUnwrap(result["email"] as? [String: Any])
    }

    private func script() throws -> String {
        try XCTUnwrap(harness.executor.calls.first?.script)
    }

    private func localISO(_ year: Int, _ month: Int, _ day: Int, _ hour: Int, _ minute: Int) throws -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .current
        let date = try XCTUnwrap(
            calendar.date(from: DateComponents(year: year, month: month, day: day, hour: hour, minute: minute)))
        return iso8601String(from: date, timeZone: .current)
    }

    func testReadsTheRecipientsCcIsoDateBodyAndAttachmentsOfTheMailInItsMailbox() throws {
        let email = try email()

        XCTAssertEqual(email["id"] as? String, mailId.encoded)
        XCTAssertEqual(email["subject"] as? String, "Quarterly report")
        XCTAssertEqual(email["sender"] as? String, "Anna <anna@x>")
        XCTAssertEqual(email["to"] as? [String], ["me@x", "bob@x"])
        XCTAssertEqual(email["cc"] as? [String], ["ewa@x"])
        XCTAssertEqual(email["date"] as? String, try localISO(2026, 10, 20, 9, 15))
        XCTAssertEqual(email["read"] as? Bool, true)
        XCTAssertEqual(email["body"] as? String, "Hello,\nsee attached.")
        XCTAssertEqual(email["mailbox"] as? String, "Archive/2026")
        XCTAssertEqual(email["account"] as? String, "Work")
        let attachments = try XCTUnwrap(email["attachments"] as? [[String: Any]])
        XCTAssertEqual(attachments.count, 2)
        XCTAssertEqual(attachments[0]["index"] as? Int, 1)
        XCTAssertEqual(attachments[0]["name"] as? String, "report.pdf")
        XCTAssertEqual(attachments[0]["size"] as? Int, 48213)
        XCTAssertEqual(attachments[0]["mime_type"] as? String, "application/pdf")
        XCTAssertEqual(attachments[1]["index"] as? Int, 2)
        XCTAssertNil(attachments[1]["size"])
        let script = try script()
        XCTAssertTrue(script.contains("mailbox \"Archive/2026\" of spwAcct"), script)
        XCTAssertTrue(script.contains("whose message id is \"<a@x>\""), script)
        XCTAssertTrue(script.contains("cc recipients of m"), script)
        XCTAssertTrue(script.contains("mail attachments of m"), script)
    }

    func testReportsTheFlagColorOfAFlaggedMailAndNoneOfAnUnflaggedOne() throws {
        for (index, flag) in [("4", "blue"), ("0", "red"), ("6", "gray"), ("-1", "none"), ("9", "none")] {
            var reply = Reply()
            reply.flag = index

            XCTAssertEqual(try email(reply: reply)["flag"] as? String, flag, index)
        }
        XCTAssertTrue(try script().contains("set spwFlag to flag index of m\n"))
    }

    func testAPlainReadAsksMailForNeitherHeadersNorSource() throws {
        let email = try email()

        XCTAssertNil(email["headers"])
        XCTAssertNil(email["headers_truncated"])
        XCTAssertNil(email["source"])
        XCTAssertNil(email["source_truncated"])
        let script = try script()
        XCTAssertFalse(script.contains("all headers of m"), script)
        XCTAssertFalse(script.contains("source of m"), script)
    }

    func testReturnsTheFullHeadersOnRequest() throws {
        var reply = Reply()
        reply.headers = "Received: from mx.example\nX-Spam-Score: 7.1"

        let email = try email(["include_headers": true], reply: reply)

        XCTAssertEqual(email["headers"] as? String, "Received: from mx.example\nX-Spam-Score: 7.1")
        XCTAssertEqual(email["headers_truncated"] as? Bool, false)
        XCTAssertNil(email["source"])
        XCTAssertTrue(try script().contains("set spwHeaders to all headers of m"))
    }

    func testCutsALargeSourceAtTheLimitAndSaysSo() throws {
        var reply = Reply()
        reply.source = "Received: from mx.example"
        reply.sourceTruncated = true

        let email = try email(["include_source": true], reply: reply)

        XCTAssertEqual(email["source"] as? String, "Received: from mx.example")
        XCTAssertEqual(email["source_truncated"] as? Bool, true)
        XCTAssertNil(email["headers"])
        let script = try script()
        XCTAssertTrue(script.contains("set spwSource to source of m"), script)
        XCTAssertTrue(script.contains("text 1 thru \(MailReading.rawTextLimit) of t"), script)
    }

    func testAMailWithoutCcAttachmentsOrDateHasEmptyListsAndNoDate() throws {
        var reply = Reply()
        reply.cc = []
        reply.attachments = []
        reply.received = ""
        reply.body = ""

        let email = try email(reply: reply)

        XCTAssertEqual(email["cc"] as? [String], [])
        XCTAssertEqual((email["attachments"] as? [[String: Any]])?.count, 0)
        XCTAssertNil(email["date"])
        XCTAssertEqual(email["body"] as? String, "")
    }

    func testFreeTextIsStrippedOfTheFieldSeparatorsBeforeItIsPrinted() throws {
        _ = try email()

        let script = try script()
        XCTAssertTrue(script.contains("set spwBody to my spwClean(spwBody)"), script)
        XCTAssertTrue(script.contains("set spwSubject to my spwClean(spwSubject)"), script)
        XCTAssertTrue(script.contains("my spwClean(name of spwAttachment)"), script)
    }

    func testAnOutputWithTheWrongNumberOfFieldsIsAnError() {
        harness.executor.reply("Subject\u{1D}Sender")

        let error = harness.callFailing("get_email", ["id": mailId.encoded])

        guard case ScriptError.scriptFailed(let detail) = error else {
            return XCTFail("expected scriptFailed, got \(error)")
        }
        XCTAssertEqual(detail, "Unexpected email from Mail.app")
    }

    func testAMailNoLongerInItsMailboxIsReportedAsMailNotFoundNamingTheMailbox() throws {
        harness.executor.fail(ScriptError.scriptFailed("execution error: SPW_MAIL_NOT_FOUND (-2700)"))

        let error = harness.callFailing("get_email", ["id": mailId.encoded])

        let failure = try XCTUnwrap(error as? MailFailure, "expected a MailFailure, got \(error)")
        XCTAssertEqual(failure, .mailNotFound(mailbox: "Archive/2026", account: "Work"))
        XCTAssertEqual(
            failure.errorDescription,
            "MAIL_NOT_FOUND: No email with this id in mailbox 'Archive/2026' of account 'Work'; "
                + "it was moved or deleted.")
        XCTAssertTrue(try script().contains("error \"SPW_MAIL_NOT_FOUND\""))
    }
}
