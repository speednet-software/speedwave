import Foundation
import SharedCLI

/// One `make new <kind> recipient...` AppleScript line per comma-separated address.
/// `addressProperty` renders the escaped address into each client's property clause.
func makeRecipientClauses(
    _ addresses: String,
    kind: String,
    addressProperty: (String) -> String
) -> String {
    splitAddressList(addresses)
        .map { addr in
            "        make new \(kind) recipient at end of \(kind) recipients "
                + "with properties {\(addressProperty(escapeAppleScript(addr)))}"
        }
        .joined(separator: "\n")
}

/// Runs a mailbox-scoped AppleScript. A -1728 "Can't get" failure maps to a mailbox
/// teaching error only when `mailboxMissing` confirms the scoped mailbox is absent, so a
/// per-message property read failure inside an existing mailbox surfaces its real cause.
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
