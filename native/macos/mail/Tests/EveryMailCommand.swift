import Foundation
import XCTest
@testable import mail_cli

/// One call of every script-running mail command, with the script outputs it needs to finish, so a test can read
/// every script the command runs.
struct MailCommandCall {
    let command: String
    let params: [String: Any]
    let replies: [String]

    static let mailId = MailId(account: "Work", mailbox: "INBOX", messageId: "<a@x>").encoded

    private static let batchRow = ["ok", "", "", "", ""].joined(separator: MailBatch.fieldSeparator)
    private static let listing = "Work" + String(repeating: "\u{1D}", count: 6)
    private static let originalRead = String(repeating: "\u{1D}", count: 4)

    static let all: [MailCommandCall] = [
        MailCommandCall(command: "list_mailboxes", params: [:], replies: []),
        MailCommandCall(command: "list_emails", params: ["mailbox": "INBOX", "account": "Work"], replies: [listing]),
        MailCommandCall(
            command: "list_emails",
            params: ["mailbox": "Speedwave-Test", "account": AppleMailClient.localAccountName, "flagged_only": true],
            replies: [listing]),
        MailCommandCall(
            command: "search_emails",
            params: ["mailbox": "INBOX", "query": "x", "since": "2026-01-01", "search_body": true, "flagged_only": true],
            replies: [listing + "\u{1D}"]),
        MailCommandCall(
            command: "get_email",
            params: ["id": mailId, "include_headers": true, "include_source": true],
            replies: [String(repeating: "\u{1D}", count: 12)]),
        MailCommandCall(
            command: "send_email",
            params: ["to": "a@x", "subject": "S", "body": "B", "signature": "Sig", "confirm_send": true],
            replies: []),
        MailCommandCall(command: "send_email", params: ["to": "a@x", "subject": "S", "body": "B"], replies: []),
        MailCommandCall(
            command: "send_email", params: ["to": "a@x", "subject": "S", "body": "B", "account": "Work"], replies: []),
        MailCommandCall(command: "save_draft", params: ["subject": "S"], replies: []),
        MailCommandCall(
            command: "save_draft",
            params: ["to": "a@x", "subject": "S", "body": "B", "signature": "Sig", "account": "Work"],
            replies: []),
        MailCommandCall(
            command: "reply_to_email",
            params: ["id": mailId, "body": "B", "signature": "Sig", "confirm_send": true],
            replies: [String(repeating: "\u{1D}", count: 5)]),
        MailCommandCall(
            command: "reply_to_email",
            params: ["id": mailId, "body": "B", "cc": "c@x", "bcc": "d@x", "confirm_send": true],
            replies: [String(repeating: "\u{1D}", count: 5)]),
        MailCommandCall(
            command: "forward_email",
            params: ["id": mailId, "to": "a@x", "cc": "b@x", "confirm_send": true],
            replies: [originalRead]),
        MailCommandCall(
            command: "redirect_email", params: ["id": mailId, "to": "a@x", "confirm_send": true],
            replies: [originalRead]),
        MailCommandCall(command: "list_signatures", params: [:], replies: []),
        MailCommandCall(command: "list_rules", params: [:], replies: []),
        MailCommandCall(command: "check_mail", params: ["account": "Work"], replies: []),
        MailCommandCall(command: "delete_emails", params: ["ids": [mailId], "confirm_delete": true], replies: [batchRow]),
        MailCommandCall(command: "mark_emails_read", params: ["ids": [mailId], "read": true], replies: [batchRow]),
        MailCommandCall(command: "flag_emails", params: ["ids": [mailId], "flag": "blue"], replies: [batchRow]),
        MailCommandCall(command: "flag_emails", params: ["ids": [mailId], "flag": "none"], replies: [batchRow]),
        MailCommandCall(
            command: "move_emails", params: ["ids": [mailId], "mailbox": "Done", "account": "Work"], replies: [batchRow]),
        MailCommandCall(
            command: "copy_emails", params: ["ids": [mailId], "mailbox": "Done", "account": "Work"], replies: [batchRow]),
        MailCommandCall(command: "archive_emails", params: ["ids": [mailId]], replies: [batchRow]),
        MailCommandCall(command: "create_mailbox", params: ["name": "Clients/2026", "account": "Work"], replies: []),
        MailCommandCall(command: "mark_emails_spam", params: ["ids": [mailId], "confirm_spam": true], replies: [batchRow]),
    ]

    /// Every script the command ran; a command that fails part way fails the calling test.
    func scripts(file: StaticString = #filePath, line: UInt = #line) throws -> [String] {
        let harness = MailCommandHarness()
        replies.forEach(harness.executor.reply)
        do {
            _ = try harness.call(command, params)
        } catch {
            XCTFail("\(command) failed after \(harness.executor.calls.count) script(s): \(error)", file: file, line: line)
            throw error
        }
        return harness.executor.calls.map(\.script)
    }
}
