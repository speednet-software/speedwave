import Foundation
import SharedCLI

// MARK: - CLI Entry Point

/// mail-cli <command> [json-args]
/// Commands: check_permission, detect_clients, list_mailboxes, list_emails, get_email, search_emails, send_email, reply_to_email
@main
struct MailCLI {
    static let commandList =
        "check_permission, detect_clients, list_mailboxes, list_emails, get_email, search_emails, send_email, reply_to_email"

    static func main() {
        // check_permission validates Apple Mail automation via AppleEventsGate; Outlook is checked by resolveClient.
        runCLI(
            cliName: "mail-cli",
            commandList: commandList,
            entity: .mail,
            checkPermissionGate: { args in
                let allowLaunch = args.contains("--launch")
                return AppleEventsGate(
                    targetBundleId: "com.apple.mail",
                    dataAccessScript: permissionCheckScript,
                    dataAccessTimeout: 15,
                    pidResolver: NSWorkspacePidResolver(),
                    appLauncher: allowLaunch ? NSWorkspaceAppLauncher() : NeverLaunchAppLauncher()
                )
            },
            commands: [
                "detect_clients": { _ in detectClients() },
                "list_mailboxes": { try listMailboxes(params: $0) },
                "list_emails": { try listEmails(params: $0) },
                "get_email": { try getEmail(params: $0) },
                "search_emails": { try searchEmails(params: $0) },
                "send_email": { try sendEmail(params: $0) },
                "reply_to_email": { try replyToEmail(params: $0) },
            ]
        )
    }
}

// MARK: - Client Resolution

func resolveClient(preferred: String?) throws -> String {
    if let preferred = preferred {
        switch preferred.lowercased() {
        case "outlook", "microsoft outlook":
            // A thrown ScriptError (permission/timeout) propagates verbatim so the
            // user sees the real cause, not a misleading "not running" message.
            guard try OutlookClient.isAvailable() else {
                throw MailError.clientNotAvailable("Microsoft Outlook")
            }
            return "outlook"
        case "mail", "apple mail":
            return "mail"
        default:
            throw MailError.unknownClient(preferred)
        }
    }
    // Default: Apple Mail (always available on macOS)
    return "mail"
}

// MARK: - Commands

func detectClients() -> [String: Any] {
    var clients: [[String: Any]] = [
        ["name": AppleMailClient.name, "available": true, "default": true]
    ]
    // A permission/timeout error is NOT "Outlook not installed" — surface it in
    // an `error` field so the UI distinguishes a denial from a genuine absence.
    var outlook: [String: Any] = ["name": OutlookClient.name, "default": false]
    do {
        outlook["available"] = try OutlookClient.isAvailable()
    } catch {
        outlook["available"] = false
        outlook["error"] = error.localizedDescription
    }
    clients.append(outlook)
    return ["clients": clients]
}

func listMailboxes(params: [String: Any]) throws -> [String: Any] {
    let client = try resolveClient(preferred: params["client"] as? String)
    let mailboxes: [[String: Any]]
    switch client {
    case "outlook":
        mailboxes = try OutlookClient.listMailboxes()
    default:
        mailboxes = try AppleMailClient.listMailboxes()
    }
    return ["mailboxes": mailboxes]
}

func listEmails(params: [String: Any]) throws -> [String: Any] {
    let client = try resolveClient(preferred: params["client"] as? String)
    let limit = params["limit"] as? Int ?? 10
    let mailbox = params["mailbox"] as? String

    let emails: [[String: Any]]
    switch client {
    case "outlook":
        emails = try OutlookClient.listEmails(limit: limit, mailbox: mailbox)
    default:
        emails = try AppleMailClient.listEmails(limit: limit, mailbox: mailbox)
    }
    return ["emails": emails]
}

func getEmail(params: [String: Any]) throws -> [String: Any] {
    guard let id = params["id"] as? String else {
        throw MailError.missingField("id")
    }
    let client = try resolveClient(preferred: params["client"] as? String)

    let email: [String: Any]
    switch client {
    case "outlook":
        email = try OutlookClient.getEmail(id: id)
    default:
        email = try AppleMailClient.getEmail(id: id)
    }
    return ["email": email]
}

func searchEmails(params: [String: Any]) throws -> [String: Any] {
    guard let query = params["query"] as? String else {
        throw MailError.missingField("query")
    }
    let client = try resolveClient(preferred: params["client"] as? String)
    let limit = params["limit"] as? Int ?? 10

    let emails: [[String: Any]]
    switch client {
    case "outlook":
        emails = try OutlookClient.searchEmails(query: query, limit: limit)
    default:
        emails = try AppleMailClient.searchEmails(query: query, limit: limit)
    }
    return ["emails": emails]
}

func sendEmail(params: [String: Any]) throws -> [String: Any] {
    guard let to = params["to"] as? String else {
        throw MailError.missingField("to")
    }
    guard !to.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
        throw MailError.emptyRecipients
    }
    guard let subject = params["subject"] as? String else {
        throw MailError.missingField("subject")
    }
    guard let body = params["body"] as? String else {
        throw MailError.missingField("body")
    }
    guard params["confirm_send"] as? Bool == true else {
        throw MailError.confirmRequired
    }

    let client = try resolveClient(preferred: params["client"] as? String)
    let cc = params["cc"] as? String
    let bcc = params["bcc"] as? String

    switch client {
    case "outlook":
        return try OutlookClient.sendEmail(to: to, subject: subject, body: body, cc: cc, bcc: bcc)
    default:
        return try AppleMailClient.sendEmail(to: to, subject: subject, body: body, cc: cc, bcc: bcc)
    }
}

func replyToEmail(params: [String: Any]) throws -> [String: Any] {
    guard let id = params["id"] as? String else {
        throw MailError.missingField("id")
    }
    guard let body = params["body"] as? String else {
        throw MailError.missingField("body")
    }
    guard params["confirm_send"] as? Bool == true else {
        throw MailError.confirmRequired
    }

    let client = try resolveClient(preferred: params["client"] as? String)
    let replyAll = params["reply_all"] as? Bool ?? false

    switch client {
    case "outlook":
        return try OutlookClient.replyToEmail(id: id, body: body, replyAll: replyAll)
    default:
        return try AppleMailClient.replyToEmail(id: id, body: body, replyAll: replyAll)
    }
}

// MARK: - Error Handling

enum MailError: LocalizedError {
    case missingField(String)
    case clientNotAvailable(String)
    case unknownClient(String)
    case confirmRequired
    case emptyRecipients

    var errorDescription: String? {
        switch self {
        case .missingField(let field):
            return "Missing required field: \(field)"
        case .clientNotAvailable(let client):
            return "\(client) is not running. Start it or omit the 'client' parameter to use Apple Mail."
        case .unknownClient(let client):
            return "Unknown mail client: \(client). Available: mail, outlook"
        case .confirmRequired:
            return "Send confirmation required. Set confirm_send: true to send the email."
        case .emptyRecipients:
            return "The 'to' field is empty. Provide at least one recipient email address."
        }
    }
}

// MARK: - Permission Helpers

/// AppleScript for check_permission; must access real data to trigger the macOS Automation prompt.
// SYNC: permissionCheckScript rationale must match notes/Sources/NotesCLI.swift
let permissionCheckScript = "tell application \"Mail\" to count of accounts"
