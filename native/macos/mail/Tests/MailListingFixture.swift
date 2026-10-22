import Foundation

struct ListingRow {
    let messageId: String
    let subject: String
    let sender: String
    let received: String
    let read: Bool
    var flag = -1
    var attachments = 0
}

/// The output a listing script prints for `rows` of a mailbox the lookup resolved to `account`, whose Mail id is
/// `<account>-ID` (empty for On My Mac); `matchedIds`
/// adds the ids a body search matched.
func mailListing(account: String, _ rows: [ListingRow], matchedIds: [String]? = nil) -> String {
    let field = { (value: (ListingRow) -> String) in rows.map(value).joined(separator: "\u{1E}") }
    var fields = [
        account,
        account == "On My Mac" ? "" : "\(account)-ID",
        field(\.messageId),
        field(\.subject),
        field(\.sender),
        field(\.received),
        field { $0.read ? "true" : "false" },
        field { "\($0.flag)" },
        field { "\($0.attachments)" },
    ]
    if let matchedIds {
        fields.append(matchedIds.joined(separator: "\u{1E}"))
    }
    return fields.joined(separator: "\u{1D}")
}
