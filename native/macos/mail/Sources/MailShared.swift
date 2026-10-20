import Foundation
import SharedCLI

let mailboxNotFoundMarker = "SPW_MAILBOX_NOT_FOUND"
let mailboxAmbiguousMarker = "SPW_MAILBOX_AMBIGUOUS:"
let accountNotFoundMarker = "SPW_ACCOUNT_NOT_FOUND"

/// The JSON argument carrying the script time budget in milliseconds, set by the mail tools of the os worker.
let scriptTimeoutParam = "script_timeout_ms"

/// Runs one AppleScript within `timeout` seconds and returns its stdout, or throws a `ScriptError`.
typealias ScriptExecutor = (_ script: String, _ timeout: TimeInterval) throws -> String

/// The production executor: a separate `osascript` process per script.
let osascriptExecutor: ScriptExecutor = { script, timeout in
    try ScriptRunner.run(script, timeout: timeout)
}

/// A failure the mail tools turn into a teaching error; `code` is the stable prefix of its description.
enum MailFailure: LocalizedError, Equatable {
    case timeout(seconds: TimeInterval)
    case automationDenied(String)
    case mailboxNotFound(mailbox: String, account: String?)
    case accountNotFound(String)
    case mailboxAmbiguous(mailbox: String, accounts: [String])

    var code: String {
        switch self {
        case .timeout: return "MAIL_TIMEOUT"
        case .automationDenied: return "MAIL_AUTOMATION_DENIED"
        case .mailboxNotFound: return "MAIL_MAILBOX_NOT_FOUND"
        case .accountNotFound: return "MAIL_ACCOUNT_NOT_FOUND"
        case .mailboxAmbiguous: return "MAIL_MAILBOX_AMBIGUOUS"
        }
    }

    var errorDescription: String? {
        "\(code): \(message)"
    }

    private var message: String {
        switch self {
        case .timeout(let seconds):
            return "Mail.app did not answer within \(Int(seconds)) s."
        case .automationDenied(let detail):
            return "Speedwave is not allowed to control Mail.app (\(detail))."
        case .mailboxNotFound(let mailbox, let account):
            let scope = account.map { "account '\($0)'" } ?? "any account"
            return "Mailbox '\(mailbox)' not found in \(scope)."
        case .accountNotFound(let account):
            return "Account '\(account)' not found."
        case .mailboxAmbiguous(let mailbox, let accounts):
            return "Mailbox '\(mailbox)' exists in several accounts: \(accounts.joined(separator: ", "))."
        }
    }
}

/// The script seam of one mail command: every script runs through `execute` within the command's time budget,
/// and a timeout, a denied Automation permission or a failed mailbox lookup comes back as a `MailFailure`.
struct MailScripts {
    let execute: ScriptExecutor
    let timeout: TimeInterval

    init(execute: @escaping ScriptExecutor, params: [String: Any]) throws {
        guard let milliseconds = params[scriptTimeoutParam] as? Int, milliseconds > 0 else {
            throw CLIError.missingField(scriptTimeoutParam)
        }
        self.execute = execute
        self.timeout = TimeInterval(milliseconds) / 1000
    }

    func run(_ script: String, mailbox: String? = nil, account: String? = nil) throws -> String {
        do {
            return try execute(script, timeout)
        } catch ScriptError.timeout {
            throw MailFailure.timeout(seconds: timeout)
        } catch ScriptError.automationPermission(let detail) {
            throw MailFailure.automationDenied(detail)
        } catch ScriptError.scriptFailed(let detail) {
            throw Self.failure(detail, mailbox: mailbox, account: account, timeout: timeout)
                ?? ScriptError.scriptFailed(detail)
        }
    }

    private static func failure(
        _ detail: String,
        mailbox: String?,
        account: String?,
        timeout: TimeInterval
    ) -> MailFailure? {
        if detail.contains("(-1743)") {
            return .automationDenied(detail)
        }
        if detail.contains("(-1712)") {
            return .timeout(seconds: timeout)
        }
        if detail.contains(accountNotFoundMarker) {
            return .accountNotFound(account ?? "")
        }
        if detail.contains(mailboxAmbiguousMarker) {
            let accounts = detail.components(separatedBy: mailboxAmbiguousMarker).last?
                .components(separatedBy: ", ")
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty && !$0.hasPrefix("(") } ?? []
            return .mailboxAmbiguous(mailbox: mailbox ?? "", accounts: accounts)
        }
        if detail.contains(mailboxNotFoundMarker) {
            return .mailboxNotFound(mailbox: mailbox ?? "", account: account)
        }
        return nil
    }
}
