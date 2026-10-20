import AppKit
import Foundation
import SharedCLI


private let outlookName = "Microsoft Outlook"

private let outlookBundleId = "com.microsoft.Outlook"

private let outlookUnsupportedInstructions =
    "\(outlookName) is not supported: New Outlook has no AppleScript and Legacy Outlook no longer connects to Exchange Online. "
    + "Add the account to Apple Mail (System Settings > Internet Accounts, or Mail > Add Account) and the mail tools will reach it there."


/// mail-cli <command> [json-args]
/// Commands: check_permission, detect_clients, list_mailboxes, list_emails, get_email, search_emails, send_email, reply_to_email
@main
struct MailCLI {
    static let commandList =
        "check_permission, detect_clients, list_mailboxes, list_emails, get_email, search_emails, send_email, reply_to_email"

    static func main() {
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
                "list_mailboxes": { _ in try listMailboxes() },
                "list_emails": { try listEmails(params: $0) },
                "get_email": { try getEmail(params: $0) },
                "search_emails": { try searchEmails(params: $0) },
                "send_email": { try sendEmail(params: $0) },
                "reply_to_email": { try replyToEmail(params: $0) },
            ]
        )
    }
}


func detectClients(
    outlookInstalled: () -> Bool = {
        NSWorkspace.shared.urlForApplication(withBundleIdentifier: outlookBundleId) != nil
    }
) -> [String: Any] {
    var clients: [[String: Any]] = [["name": AppleMailClient.name, "supported": true]]
    if outlookInstalled() {
        clients.append([
            "name": outlookName,
            "supported": false,
            "instructions": outlookUnsupportedInstructions,
        ])
    }
    return ["clients": clients]
}

func listMailboxes() throws -> [String: Any] {
    return ["mailboxes": try AppleMailClient.listMailboxes()]
}

func listEmails(params: [String: Any]) throws -> [String: Any] {
    let limit = params["limit"] as? Int ?? 10
    let mailbox = params["mailbox"] as? String
    return ["emails": try AppleMailClient.listEmails(limit: limit, mailbox: mailbox)]
}

func getEmail(params: [String: Any]) throws -> [String: Any] {
    guard let id = params["id"] as? String else {
        throw MailError.missingField("id")
    }
    return ["email": try AppleMailClient.getEmail(id: id)]
}

func searchEmails(params: [String: Any]) throws -> [String: Any] {
    guard let query = params["query"] as? String else {
        throw MailError.missingField("query")
    }
    let limit = params["limit"] as? Int ?? 10
    let mailbox = params["mailbox"] as? String
    return ["emails": try AppleMailClient.searchEmails(query: query, limit: limit, mailbox: mailbox)]
}

func sendEmail(params: [String: Any]) throws -> [String: Any] {
    guard let to = params["to"] as? String else {
        throw MailError.missingField("to")
    }
    guard !splitAddressList(to).isEmpty else {
        throw MailError.emptyRecipients("to")
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

    let cc = params["cc"] as? String
    let bcc = params["bcc"] as? String
    if let cc = cc, splitAddressList(cc).isEmpty {
        throw MailError.emptyRecipients("cc")
    }
    if let bcc = bcc, splitAddressList(bcc).isEmpty {
        throw MailError.emptyRecipients("bcc")
    }

    return try AppleMailClient.sendEmail(to: to, subject: subject, body: body, cc: cc, bcc: bcc)
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

    let replyAll = params["reply_all"] as? Bool ?? false
    return try AppleMailClient.replyToEmail(id: id, body: body, replyAll: replyAll)
}


enum MailError: LocalizedError {
    case missingField(String)
    case confirmRequired
    case emptyRecipients(String)

    var errorDescription: String? {
        switch self {
        case .missingField(let field):
            return "Missing required field: \(field)"
        case .confirmRequired:
            return "Send confirmation required. Set confirm_send: true to send the email."
        case .emptyRecipients(let field):
            return "The '\(field)' field is empty. Provide at least one recipient email address."
        }
    }
}


/// AppleScript for check_permission; must access real data to trigger the macOS Automation prompt.
let permissionCheckScript = "tell application \"Mail\" to count of accounts"
