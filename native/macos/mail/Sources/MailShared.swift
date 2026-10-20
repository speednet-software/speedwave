import Foundation
import SharedCLI

let mailboxNotFoundMarker = "SPW_MAILBOX_NOT_FOUND"
let mailboxAmbiguousMarker = "SPW_MAILBOX_AMBIGUOUS:"
let accountNotFoundMarker = "SPW_ACCOUNT_NOT_FOUND"
let mailNotFoundMarker = "SPW_MAIL_NOT_FOUND"

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
    case invalidMailId(String)
    case mailboxChanged(mailbox: String)
    case mailNotFound(mailbox: String, account: String)
    case batchTooLarge(count: Int, limit: Int)
    case trashNotFound(account: String)
    case alreadyInTrash
    case junkNotFound(account: String)
    case alreadyInJunk
    case archiveNotFound(account: String)
    case alreadyArchived
    case mailboxExists(mailbox: String, account: String)

    var code: String {
        switch self {
        case .timeout: return "MAIL_TIMEOUT"
        case .automationDenied: return "MAIL_AUTOMATION_DENIED"
        case .mailboxNotFound: return "MAIL_MAILBOX_NOT_FOUND"
        case .accountNotFound: return "MAIL_ACCOUNT_NOT_FOUND"
        case .mailboxAmbiguous: return "MAIL_MAILBOX_AMBIGUOUS"
        case .invalidMailId: return "MAIL_INVALID_ID"
        case .mailboxChanged: return "MAIL_MAILBOX_CHANGED"
        case .mailNotFound: return "MAIL_NOT_FOUND"
        case .batchTooLarge: return "MAIL_BATCH_TOO_LARGE"
        case .trashNotFound: return "MAIL_TRASH_NOT_FOUND"
        case .alreadyInTrash: return "MAIL_ALREADY_IN_TRASH"
        case .junkNotFound: return "MAIL_JUNK_NOT_FOUND"
        case .alreadyInJunk: return "MAIL_ALREADY_IN_JUNK"
        case .archiveNotFound: return "MAIL_ARCHIVE_NOT_FOUND"
        case .alreadyArchived: return "MAIL_ALREADY_ARCHIVED"
        case .mailboxExists: return "MAIL_MAILBOX_EXISTS"
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
        case .invalidMailId(let id):
            return "'\(id)' is not a mail id. Take the id from listEmails or searchEmails."
        case .mailboxChanged(let mailbox):
            return "Mailbox '\(mailbox)' changed while it was being read."
        case .mailNotFound(let mailbox, let account):
            return "No email with this id in mailbox '\(mailbox)' of account '\(account)'; it was moved or deleted."
        case .batchTooLarge(let count, let limit):
            return "\(count) mail ids given, but one call takes at most \(limit). "
                + "Split them into batches of at most \(limit) and confirm each batch with the user separately."
        case .trashNotFound(let account):
            return "Account '\(account)' has no Trash mailbox, so the email was left where it is."
        case .alreadyInTrash:
            return "The email is already in the Trash; no tool deletes an email permanently."
        case .junkNotFound(let account):
            return "Account '\(account)' has no Junk mailbox, so the email was left where it is."
        case .alreadyInJunk:
            return "The email is already in the Junk mailbox."
        case .archiveNotFound(let account):
            return "Account '\(account)' has no Archive mailbox, so the email was left where it is. "
                + "Ask the user where to keep it and move it there with moveEmails, or create the mailbox first."
        case .alreadyArchived:
            return "The email is already in the Archive mailbox."
        case .mailboxExists(let mailbox, let account):
            return "Mailbox '\(mailbox)' already exists in account '\(account)'; move emails to it as it is."
        }
    }
}

/// A mail's opaque id: its account, the mailbox path inside that account and its RFC Message-ID, encoded together
/// as `mail1.` + unpadded base64url of the JSON array `[account, mailbox, messageId]`.
struct MailId: Equatable {
    static let prefix = "mail1."

    let account: String
    let mailbox: String
    let messageId: String

    var encoded: String {
        let json = (try? JSONEncoder().encode([account, mailbox, messageId])) ?? Data()
        let base64url = json.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        return Self.prefix + base64url
    }

    init(account: String, mailbox: String, messageId: String) {
        self.account = account
        self.mailbox = mailbox
        self.messageId = messageId
    }

    init(decoding id: String) throws {
        guard id.hasPrefix(Self.prefix) else { throw MailFailure.invalidMailId(id) }
        var base64 = String(id.dropFirst(Self.prefix.count))
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
        guard let data = Data(base64Encoded: base64),
              let parts = try? JSONDecoder().decode([String].self, from: data),
              parts.count == 3,
              parts.allSatisfy({ !$0.isEmpty })
        else {
            throw MailFailure.invalidMailId(id)
        }
        self.init(account: parts[0], mailbox: parts[1], messageId: parts[2])
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

    static func failure(
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
        if detail.contains(mailboxExistsMarker) {
            return .mailboxExists(mailbox: mailbox ?? "", account: account ?? "")
        }
        if detail.contains(mailNotFoundMarker) {
            return .mailNotFound(mailbox: mailbox ?? "", account: account ?? "")
        }
        if detail.contains(mailboxNotFoundMarker) {
            return .mailboxNotFound(mailbox: mailbox ?? "", account: account)
        }
        return nil
    }
}
