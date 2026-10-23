import XCTest
@testable import mail_cli

final class MailIdTests: XCTestCase {
    func testAnEncodedIdDecodesToTheSameAccountMailboxAndMessageId() throws {
        let id = MailId(accountId: "Exchange-ID", account: "Exchange", mailbox: "Inbox/Clients", messageId: "<a1@example.com>")

        XCTAssertEqual(try MailId(decoding: id.encoded), id)
    }

    func testSpecialCharactersAndUnicodeSurviveTheRoundTrip() throws {
        let id = MailId(
            accountId: "8F1C-ż🐢",
            account: "Praca \"Firma\" || ż\u{f3}łw 🐢",
            mailbox: "Skrzynka/Zażółć\\gęślą/\u{1E}x",
            messageId: "<\"quoted\"||id+/=@host>")

        XCTAssertEqual(try MailId(decoding: id.encoded), id)
    }

    func testTheEncodedIdIsOneOpaqueTokenWithoutSpacesOrDelimiters() {
        let encoded = MailId(accountId: "", account: "On My Mac", mailbox: "Speedwave Test", messageId: "<a b@x>").encoded

        XCTAssertTrue(encoded.hasPrefix(MailId.prefix), encoded)
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.")
        XCTAssertTrue(encoded.unicodeScalars.allSatisfy { allowed.contains($0) }, encoded)
    }

    func testTheSameMessageInTwoAccountsHasTwoIds() {
        let work = MailId(accountId: "Work-ID", account: "Work", mailbox: "INBOX", messageId: "<a@x>")
        let home = MailId(accountId: "Home-ID", account: "Home", mailbox: "INBOX", messageId: "<a@x>")

        XCTAssertNotEqual(work.encoded, home.encoded)
    }

    func testAnIdThatIsNotAMailIdIsRefusedNamingIt() {
        let bad = [
            "",
            "<a1@example.com>",
            "mail2.",
            "mail2.!!!",
            "mail1." + Data("[\"Work\",\"INBOX\",\"<x>\"]".utf8).base64EncodedString(),
            "mail2." + Data("[\"Work\",\"INBOX\",\"<x>\"]".utf8).base64EncodedString(),
            "mail2." + Data("[\"id\",\"a\",\"\",\"<x>\"]".utf8).base64EncodedString(),
            "mail2." + Data("[\"id\",\"\",\"INBOX\",\"<x>\"]".utf8).base64EncodedString(),
            "mail2." + Data("{\"a\":1}".utf8).base64EncodedString(),
        ]
        for id in bad {
            XCTAssertThrowsError(try MailId(decoding: id), id) { error in
                XCTAssertEqual(error as? MailFailure, .invalidMailId(id))
            }
        }
    }

    func testAnInvalidIdFailureTeachesWhereIdsComeFrom() {
        let failure = MailFailure.invalidMailId("msg-1")

        XCTAssertEqual(failure.code, "MAIL_INVALID_ID")
        XCTAssertEqual(
            failure.errorDescription,
            "MAIL_INVALID_ID: 'msg-1' is not a mail id. Take the id from listEmails or searchEmails.")
    }
}
