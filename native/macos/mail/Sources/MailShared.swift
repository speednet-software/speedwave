import Foundation
import SharedCLI

/// Runs a mailbox-scoped AppleScript. A -1728 "Can't get" failure maps to a mailbox teaching error
/// only when `mailboxMissing` confirms it's absent — a per-message read failure keeps its real cause.
func runMailScript(
    _ script: String,
    timeout: TimeInterval,
    mailbox: String?,
    mailboxMissing: () -> Bool = { false }
) throws -> String {
    do { return try ScriptRunner.run(script, timeout: timeout) }
    catch ScriptError.scriptFailed(let msg)
        where mailbox != nil && isAppleScriptNotFoundError(msg) && mailboxMissing()
    {
        throw CLIError.notFound(
            "Mailbox '\(mailbox!)' not found. List valid mailboxes via listMailboxes and use their name field."
        )
    }
}
