import Foundation

// MARK: - CLI Entry Point

/// mail-cli <command> [json-args]
/// Commands: detect_clients, list_mailboxes, list_emails, get_email, search_emails, send_email, reply_to_email
@main
struct MailCLI {
    static func main() {
        let args = CommandLine.arguments
        guard args.count >= 2 else {
            exitWithError("Usage: mail-cli <command> [json-args]\nCommands: detect_clients, list_mailboxes, list_emails, get_email, search_emails, send_email, reply_to_email")
        }

        let command = args[1]
        let jsonArgs = args.count >= 3 ? args[2] : "{}"

        guard let argsData = jsonArgs.data(using: .utf8),
              let params = try? JSONSerialization.jsonObject(with: argsData) as? [String: Any]
        else {
            exitWithError("Invalid JSON arguments: \(jsonArgs)")
        }

        do {
            let result: Any
            switch command {
            case "detect_clients":
                result = detectClients()
            case "list_mailboxes":
                result = try listMailboxes(params: params)
            case "list_emails":
                result = try listEmails(params: params)
            case "get_email":
                result = try getEmail(params: params)
            case "search_emails":
                result = try searchEmails(params: params)
            case "send_email":
                result = try sendEmail(params: params)
            case "reply_to_email":
                result = try replyToEmail(params: params)
            default:
                exitWithError("Unknown command: \(command)\nAvailable: detect_clients, list_mailboxes, list_emails, get_email, search_emails, send_email, reply_to_email")
            }

            let data = try JSONSerialization.data(
                withJSONObject: result,
                options: [.prettyPrinted, .sortedKeys]
            )
            if let json = String(data: data, encoding: .utf8) {
                print(json)
            }
        } catch {
            exitWithError(error.localizedDescription)
        }
    }
}

// MARK: - Client Resolution

func resolveClient(preferred: String?) throws -> String {
    if let preferred = preferred {
        switch preferred.lowercased() {
        case "outlook", "microsoft outlook":
            guard OutlookClient.isAvailable() else {
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
    clients.append([
        "name": OutlookClient.name,
        "available": OutlookClient.isAvailable(),
        "default": false,
    ])
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

    switch client {
    case "outlook":
        return try OutlookClient.sendEmail(to: to, subject: subject, body: body, cc: cc)
    default:
        return try AppleMailClient.sendEmail(to: to, subject: subject, body: body, cc: cc)
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
        }
    }
}

func exitWithError(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}
