import Foundation
import XCTest
@testable import mail_cli

final class ScriptCompileTests: XCTestCase {
    private let mailId = MailId(account: "Work", mailbox: "INBOX", messageId: "<a@x>").encoded

    private var batchRow: String {
        ["ok", "", "", "", ""].joined(separator: MailBatch.fieldSeparator)
    }

    private func scripts(of command: String, _ params: [String: Any], replies: [String]) -> [String] {
        let harness = MailCommandHarness()
        replies.forEach(harness.executor.reply)
        _ = try? harness.call(command, params)
        return harness.executor.calls.map(\.script)
    }

    private func compileError(_ script: String) throws -> String? {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let source = directory.appendingPathComponent("script.applescript")
        try script.write(to: source, atomically: true, encoding: .utf8)
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/osacompile")
        process.arguments = ["-o", directory.appendingPathComponent("script.scpt").path, source.path]
        let stderr = Pipe()
        process.standardError = stderr
        try process.run()
        process.waitUntilExit()
        let message = String(data: stderr.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        return process.terminationStatus == 0 ? nil : message
    }

    func testEveryScriptOfEveryCommandCompilesAgainstMailsDictionary() throws {
        let read = String(repeating: "\u{1D}", count: 4)
        let calls: [(String, [String: Any], [String])] = [
            ("list_mailboxes", [:], []),
            ("list_emails", ["mailbox": "INBOX", "account": "Work"], []),
            ("list_emails", ["mailbox": "Speedwave-Test", "account": AppleMailClient.localAccountName], []),
            ("search_emails", ["mailbox": "INBOX", "query": "x", "since": "2026-01-01", "search_body": true], []),
            ("get_email", ["id": mailId, "include_headers": true, "include_source": true], []),
            ("send_email", ["to": "a@x", "subject": "S", "body": "B", "signature": "Sig", "confirm_send": true], []),
            ("save_draft", ["to": "a@x", "subject": "S", "body": "B", "signature": "Sig", "account": "Work"], []),
            ("reply_to_email", ["id": mailId, "body": "B", "signature": "Sig", "confirm_send": true],
             [String(repeating: "\u{1D}", count: 5)]),
            ("forward_email", ["id": mailId, "to": "a@x", "cc": "b@x", "confirm_send": true], [read]),
            ("redirect_email", ["id": mailId, "to": "a@x", "confirm_send": true], [read]),
            ("list_signatures", [:], []),
            ("list_rules", [:], []),
            ("check_mail", ["account": "Work"], []),
            ("delete_emails", ["ids": [mailId], "confirm_delete": true], [batchRow]),
            ("mark_emails_read", ["ids": [mailId], "read": true], [batchRow]),
            ("flag_emails", ["ids": [mailId], "flag": "blue"], [batchRow]),
            ("flag_emails", ["ids": [mailId], "flag": "none"], [batchRow]),
            ("move_emails", ["ids": [mailId], "mailbox": "Done", "account": "Work"], [batchRow]),
            ("copy_emails", ["ids": [mailId], "mailbox": "Done", "account": "Work"], [batchRow]),
            ("archive_emails", ["ids": [mailId]], [batchRow]),
            ("create_mailbox", ["name": "Clients/2026", "account": "Work"], []),
            ("mark_emails_spam", ["ids": [mailId], "confirm_spam": true], [batchRow]),
        ]
        for (command, params, replies) in calls {
            let scripts = scripts(of: command, params, replies: replies)
            XCTAssertFalse(scripts.isEmpty, command)
            for script in scripts {
                XCTAssertNil(try compileError(script), "\(command):\n\(script)")
            }
        }
    }
}
