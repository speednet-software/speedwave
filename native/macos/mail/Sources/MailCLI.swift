import AppKit
import Foundation
import SharedCLI


private let outlookName = "Microsoft Outlook"

private let outlookBundleId = "com.microsoft.Outlook"

private let outlookUnsupportedInstructions =
    "\(outlookName) is not supported: New Outlook has no AppleScript and Legacy Outlook no longer connects to Exchange Online. "
    + "Add the account to Apple Mail (System Settings > Internet Accounts, or Mail > Add Account) and the mail tools will reach it there."


/// mail-cli <command> [json-args]
/// Commands: check_permission, detect_clients, list_mailboxes, list_emails, get_email, search_emails, send_email, reply_to_email, forward_email, redirect_email, list_rules, check_mail, delete_emails, mark_emails_read, flag_emails, move_emails, copy_emails, archive_emails, create_mailbox, mark_emails_spam, mark_emails_not_spam, rename_mailbox, save_draft, list_signatures
@main
struct MailCLI {
    static let commandList =
        "check_permission, detect_clients, list_mailboxes, list_emails, get_email, search_emails, send_email, reply_to_email, forward_email, redirect_email, list_rules, check_mail, delete_emails, mark_emails_read, flag_emails, move_emails, copy_emails, archive_emails, create_mailbox, mark_emails_spam, mark_emails_not_spam, rename_mailbox, save_draft, list_signatures"

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
            commands: mailCommands(executor: osascriptExecutor)
        )
    }
}


/// The mail-cli command boundary: command name to handler, every script run through `executor`.
func mailCommands(executor: @escaping ScriptExecutor) -> [String: (_ params: [String: Any]) throws -> Any] {
    func scripted(
        _ handler: @escaping (_ params: [String: Any], _ scripts: MailScripts) throws -> Any
    ) -> (_ params: [String: Any]) throws -> Any {
        { params in try handler(params, try MailScripts(execute: executor, params: params)) }
    }
    return [
        "detect_clients": { _ in detectClients() },
        "list_mailboxes": scripted { _, scripts in try listMailboxes(scripts: scripts) },
        "list_emails": scripted(listEmails),
        "get_email": scripted(getEmail),
        "search_emails": scripted(searchEmails),
        "send_email": scripted(MailSending.sendEmail),
        "reply_to_email": scripted(MailSending.replyToEmail),
        "forward_email": scripted(MailSending.forwardEmail),
        "redirect_email": scripted(MailSending.redirectEmail),
        "save_draft": scripted(MailSending.saveDraft),
        "list_signatures": scripted { _, scripts in try MailSending.listSignatures(scripts: scripts) },
        "list_rules": scripted { _, scripts in ["rules": try MailRules.listRules(scripts: scripts)] },
        "check_mail": scripted { params, scripts in
            let account = params["account"] as? String
            guard account != AppleMailClient.localAccountName else {
                throw MailError.invalidValue(
                    "account",
                    "On My Mac has no mail server, so there is no new mail to fetch for it; leave account out to "
                        + "check every account")
            }
            return try MailRules.checkMail(scripts: scripts, account: account)
        },
        "delete_emails": scripted(deleteEmails),
        "mark_emails_read": scripted(markEmailsRead),
        "flag_emails": scripted(flagEmails),
        "move_emails": scripted(moveEmails),
        "copy_emails": scripted(copyEmails),
        "archive_emails": scripted(archiveEmails),
        "create_mailbox": scripted(createMailbox),
        "mark_emails_spam": scripted(markEmailsSpam),
        "mark_emails_not_spam": scripted(markEmailsNotSpam),
        "rename_mailbox": scripted(renameMailbox),
    ]
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

func listMailboxes(scripts: MailScripts) throws -> [String: Any] {
    return ["mailboxes": try AppleMailClient.listMailboxes(scripts: scripts)]
}

func listEmails(params: [String: Any], scripts: MailScripts) throws -> [String: Any] {
    let (mailbox, account) = try mailboxParams(params)
    let (offset, limit) = try pageParams(params)
    let filter = AppleMailClient.MessageFilter(
        unreadOnly: params["unread_only"] as? Bool ?? false,
        flaggedOnly: params["flagged_only"] as? Bool ?? false
    )
    return try AppleMailClient.listEmails(
        scripts: scripts, mailbox: mailbox, account: account, filter: filter, offset: offset, limit: limit)
}

func getEmail(params: [String: Any], scripts: MailScripts) throws -> [String: Any] {
    guard let id = params["id"] as? String else {
        throw MailError.missingField("id")
    }
    return [
        "email": try MailReading.getEmail(
            scripts: scripts,
            id: id,
            includeHeaders: params["include_headers"] as? Bool ?? false,
            includeSource: params["include_source"] as? Bool ?? false
        ),
    ]
}

func searchEmails(params: [String: Any], scripts: MailScripts) throws -> [String: Any] {
    for text in ["query", "recipient"] where (params[text] as? String)?.isEmpty == true {
        throw MailError.invalidValue(text, "must not be empty")
    }
    let mailbox = params["mailbox"] as? String
    let account = params["account"] as? String
    let (offset, limit) = try pageParams(params)
    let filter = AppleMailClient.MessageFilter(
        unreadOnly: params["unread_only"] as? Bool ?? false,
        flaggedOnly: params["flagged_only"] as? Bool ?? false,
        sender: params["sender"] as? String,
        recipient: params["recipient"] as? String,
        since: try dateParam(params, "since"),
        before: try dateParam(params, "before"),
        query: params["query"] as? String,
        searchBody: params["search_body"] as? Bool ?? false
    )
    guard filter.narrows else {
        throw MailError.noSearchFilter
    }
    guard !filter.searchBody || filter.query != nil else {
        throw MailError.missingField("query")
    }
    guard !filter.searchBody || mailbox != nil else {
        throw MailError.missingField("mailbox")
    }
    return try AppleMailClient.listEmails(
        scripts: scripts, mailbox: mailbox, account: account, filter: filter, offset: offset, limit: limit)
}

/// The page of a listing: `offset` newest messages skipped (default 0), at most `limit` returned (default 10).
func pageParams(_ params: [String: Any]) throws -> (offset: Int, limit: Int) {
    let limit = try wholeNumberParam(params, "limit") ?? 10
    let offset = try wholeNumberParam(params, "offset") ?? 0
    guard limit > 0 else {
        throw MailError.invalidValue("limit", "must be at least 1")
    }
    guard offset >= 0 else {
        throw MailError.invalidValue("offset", "must not be negative")
    }
    return (offset, limit)
}

/// A JSON number parameter that must be a whole number; nil when absent, refused when fractional, text or boolean.
func wholeNumberParam(_ params: [String: Any], _ name: String) throws -> Int? {
    guard let raw = params[name] else { return nil }
    guard let number = raw as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
          let value = Int(exactly: number.doubleValue)
    else {
        throw MailError.invalidValue(name, "must be a whole number")
    }
    return value
}

/// A date parameter as the instant it names on this Mac; a bare day starts at local midnight.
func dateParam(_ params: [String: Any], _ name: String) throws -> Date? {
    guard let raw = params[name] else { return nil }
    guard let text = raw as? String, let date = parseISODateInput(text)?.date(in: .current) else {
        throw MailError.invalidValue(
            name, "must be an ISO 8601 day (2026-10-20) or date-time (2026-10-20T09:00:00 or 2026-10-20T09:00:00+02:00)")
    }
    return date
}

/// The mailbox name and its account, which may be left out when one account alone has the mailbox.
func mailboxParams(_ params: [String: Any]) throws -> (mailbox: String, account: String?) {
    guard let mailbox = params["mailbox"] as? String else {
        throw CLIError.missingField("mailbox")
    }
    return (mailbox, params["account"] as? String)
}

enum MailError: LocalizedError {
    case missingField(String)
    case emptyRecipients(String)
    case invalidValue(String, String)
    case noSearchFilter

    var errorDescription: String? {
        switch self {
        case .missingField(let field):
            return "Missing required field: \(field)"
        case .emptyRecipients(let field):
            return "The '\(field)' field is empty. Provide at least one recipient email address."
        case .invalidValue(let field, let rule):
            return "Invalid \(field): \(rule)."
        case .noSearchFilter:
            return "A search needs at least one of query, sender, recipient, since, before, unread_only or "
                + "flagged_only; list a whole mailbox with list_emails."
        }
    }
}


/// AppleScript for check_permission; must access real data to trigger the macOS Automation prompt.
let permissionCheckScript = "tell application \"Mail\" to count of accounts"
