import Foundation

/// The output the read script of `reply_to_email` prints for an original mail with these fields, read in an account
/// whose name is `fromName` and whose addresses are `fromAddresses`, with `own` every address of every account.
func replyRead(
    subject: String = "Invoice 12",
    sender: String = "Anna <anna@x>",
    replyTo: String = "",
    to: [String] = ["me@work.example"],
    cc: [String] = [],
    received: String = "2026-10-20T09:15:00",
    original: String = "Please pay.\n\nThanks",
    own: [String] = ["me@work.example", "me@home.example"],
    fromName: String = "Me",
    fromAddresses: [String] = ["me@work.example"]
) -> String {
    [
        subject, sender, replyTo, items(to), items(cc), received, original, items(own), fromName, items(fromAddresses),
    ].joined(separator: "\u{1D}")
}

/// The output the read script of `forward_email` prints for an original mail with these fields.
func forwardRead(
    subject: String = "Invoice 12",
    sender: String = "Anna <anna@x>",
    received: String = "2026-10-20T09:15:00",
    attachments: [String] = ["invoice.pdf", "terms.pdf"],
    to: [String] = ["me@work.example"],
    cc: [String] = [],
    fromName: String = "Me",
    fromAddresses: [String] = ["me@work.example"]
) -> String {
    [subject, sender, received, items(attachments), items(to), items(cc), fromName, items(fromAddresses)]
        .joined(separator: "\u{1D}")
}

/// The output the read script of `redirect_email` prints: the subject and sender of Mail's redirect and the
/// original's subject, sender, date and attachment names.
func redirectRead(
    subject: String = "Invoice 12",
    sender: String = "Anna <anna@x>",
    received: String = "2026-10-20T09:15:00",
    attachments: [String] = ["invoice.pdf", "terms.pdf"],
    from: String = "Me <me@work.example>"
) -> String {
    [subject, subject, sender, received, items(attachments), from].joined(separator: "\u{1D}")
}

private func items(_ values: [String]) -> String {
    values.joined(separator: "\u{1E}")
}
