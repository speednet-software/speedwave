import Foundation
import SharedCLI

let mailboxNotFoundMarker = "SPW_MAILBOX_NOT_FOUND"
let mailboxAmbiguousMarker = "SPW_MAILBOX_AMBIGUOUS:"
let accountNotFoundMarker = "SPW_ACCOUNT_NOT_FOUND"

/// Runs a script built on `AppleMailClient.mailboxLookup` and turns its lookup markers into teaching errors;
/// any other failure keeps its real cause.
func runMailboxScript(
    _ script: String,
    timeout: TimeInterval,
    mailbox: String?,
    account: String?
) throws -> String {
    do { return try ScriptRunner.run(script, timeout: timeout) }
    catch ScriptError.scriptFailed(let msg) where msg.contains(accountNotFoundMarker) {
        throw CLIError.notFound(
            "Account '\(account ?? "")' not found. Use the account field from listMailboxes."
        )
    }
    catch ScriptError.scriptFailed(let msg) where msg.contains(mailboxAmbiguousMarker) {
        let accounts = msg.components(separatedBy: mailboxAmbiguousMarker).last?
            .components(separatedBy: ", ")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty && !$0.hasPrefix("(") }
            .joined(separator: ", ") ?? ""
        throw CLIError.ambiguous(
            "Mailbox '\(mailbox ?? "")' exists in several accounts: \(accounts). "
                + "Pass account with the account field from listMailboxes."
        )
    }
    catch ScriptError.scriptFailed(let msg) where msg.contains(mailboxNotFoundMarker) {
        let scope = account.map { "account '\($0)'" } ?? "any account"
        throw CLIError.notFound(
            "Mailbox '\(mailbox ?? "")' not found in \(scope). "
                + "List valid mailboxes via listMailboxes and use their name and account fields."
        )
    }
}
