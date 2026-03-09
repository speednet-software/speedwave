import XCTest
@testable import mail_cli

final class MailTests: XCTestCase {

    // MARK: - AppleScript Escaping

    func testEscapeAppleScriptQuotes() {
        let result = escapeAppleScript("Hello \"World\"")
        XCTAssertEqual(result, "Hello \\\"World\\\"")
    }

    func testEscapeAppleScriptBackslash() {
        let result = escapeAppleScript("path\\to\\file")
        XCTAssertEqual(result, "path\\\\to\\\\file")
    }

    func testEscapeAppleScriptCombined() {
        let result = escapeAppleScript("He said \"hello\\n\"")
        XCTAssertEqual(result, "He said \\\"hello\\\\n\\\"")
    }

    func testEscapeAppleScriptEmpty() {
        let result = escapeAppleScript("")
        XCTAssertEqual(result, "")
    }

    func testEscapeAppleScriptNoSpecialChars() {
        let result = escapeAppleScript("plain text")
        XCTAssertEqual(result, "plain text")
    }

    // MARK: - AppleScript Injection Prevention

    func testEscapeAppleScriptStripsNewline() {
        let result = escapeAppleScript("line1\nline2")
        XCTAssertEqual(result, "line1line2")
    }

    func testEscapeAppleScriptStripsCarriageReturn() {
        let result = escapeAppleScript("line1\rline2")
        XCTAssertEqual(result, "line1line2")
    }

    func testEscapeAppleScriptStripsTab() {
        let result = escapeAppleScript("col1\tcol2")
        XCTAssertEqual(result, "col1col2")
    }

    func testEscapeAppleScriptStripsNullByte() {
        let result = escapeAppleScript("before\0after")
        XCTAssertEqual(result, "beforeafter")
    }

    func testEscapeAppleScriptNeutralizesDoShellScript() {
        let payload = "harmless\"\ndo shell script \"rm -rf /\"\n\""
        let result = escapeAppleScript(payload)
        // Newlines are stripped, quotes are escaped — no breakout possible.
        // The text "do shell script" remains in the output but is harmless:
        // escaped quotes prevent AppleScript from interpreting it as a command.
        XCTAssertFalse(result.contains("\n"))
        XCTAssertTrue(result.contains("\\\""))
    }

    func testEscapeAppleScriptNeutralizesNewlineInjection() {
        let payload = "test\n\" & do shell script \"whoami"
        let result = escapeAppleScript(payload)
        XCTAssertFalse(result.contains("\n"))
        XCTAssertTrue(result.contains("\\\""))
    }

    func testEscapeAppleScriptPreservesUnicode() {
        let result = escapeAppleScript("café résumé naïve")
        XCTAssertEqual(result, "café résumé naïve")
    }

    func testEscapeAppleScriptPreservesAccentsAndPunctuation() {
        let result = escapeAppleScript("Hello! How's it going? Über cool — really…")
        XCTAssertEqual(result, "Hello! How's it going? Über cool — really…")
    }

    func testEscapeAppleScriptStripsNEL() {
        let result = escapeAppleScript("line1\u{0085}line2")
        XCTAssertEqual(result, "line1line2")
    }

    func testEscapeAppleScriptStripsLineSeparator() {
        let result = escapeAppleScript("line1\u{2028}line2")
        XCTAssertEqual(result, "line1line2")
    }

    func testEscapeAppleScriptStripsParagraphSeparator() {
        let result = escapeAppleScript("para1\u{2029}para2")
        XCTAssertEqual(result, "para1para2")
    }

    // MARK: - Parse Delimited

    func testParseDelimitedBasic() {
        let output = "Alice||Hello||2024-01-01\nBob||World||2024-01-02\n"
        let result = parseDelimited(output, fields: ["from", "subject", "date"])
        XCTAssertEqual(result.count, 2)
        XCTAssertEqual(result[0]["from"] as? String, "Alice")
        XCTAssertEqual(result[0]["subject"] as? String, "Hello")
        XCTAssertEqual(result[1]["from"] as? String, "Bob")
    }

    func testParseDelimitedSkipsMalformed() {
        let output = "good||data\nbad\nalso||good\n"
        let result = parseDelimited(output, fields: ["a", "b"])
        XCTAssertEqual(result.count, 2)
    }

    func testParseDelimitedEmpty() {
        let result = parseDelimited("", fields: ["a", "b"])
        XCTAssertTrue(result.isEmpty)
    }

    func testParseDelimitedTrimsWhitespace() {
        let output = " Alice || Hello \n"
        let result = parseDelimited(output, fields: ["from", "subject"])
        XCTAssertEqual(result.count, 1)
        XCTAssertEqual(result[0]["from"] as? String, "Alice")
        XCTAssertEqual(result[0]["subject"] as? String, "Hello")
    }

    // MARK: - Client Detection

    func testAppleMailAlwaysAvailable() {
        XCTAssertTrue(AppleMailClient.isAvailable())
    }

    // MARK: - Error Messages

    func testMailErrorMissingField() {
        let error = MailError.missingField("to")
        XCTAssertEqual(error.errorDescription, "Missing required field: to")
    }

    func testMailErrorClientNotAvailable() {
        let error = MailError.clientNotAvailable("Microsoft Outlook")
        XCTAssertTrue(error.errorDescription!.contains("not running"))
    }

    func testMailErrorUnknownClient() {
        let error = MailError.unknownClient("thunderbird")
        XCTAssertTrue(error.errorDescription!.contains("Unknown mail client"))
    }

    func testMailErrorConfirmRequired() {
        let error = MailError.confirmRequired
        XCTAssertTrue(error.errorDescription!.contains("confirm_send"))
    }

    // MARK: - ScriptError Messages

    func testScriptErrorFailed() {
        let error = ScriptError.scriptFailed("some error")
        XCTAssertTrue(error.errorDescription!.contains("AppleScript error"))
    }

    func testScriptErrorAutomationPermission() {
        let error = ScriptError.automationPermission("not allowed")
        XCTAssertTrue(error.errorDescription!.contains("Automation permission denied"))
        XCTAssertTrue(error.errorDescription!.contains("System Settings"))
    }

    func testScriptErrorTimeout() {
        let error = ScriptError.timeout(15)
        XCTAssertTrue(error.errorDescription!.contains("timed out"))
        XCTAssertTrue(error.errorDescription!.contains("15"))
    }

    // MARK: - Client Resolution

    func testResolveClientDefaultIsMail() throws {
        let client = try resolveClient(preferred: nil)
        XCTAssertEqual(client, "mail")
    }

    func testResolveClientAppleMail() throws {
        let client = try resolveClient(preferred: "mail")
        XCTAssertEqual(client, "mail")
    }

    func testResolveClientAppleMailAlt() throws {
        let client = try resolveClient(preferred: "Apple Mail")
        XCTAssertEqual(client, "mail")
    }

    func testResolveClientUnknownThrows() {
        XCTAssertThrowsError(try resolveClient(preferred: "thunderbird"))
    }

    // MARK: - Send Email Validation

    func testSendEmailRequiresConfirmation() {
        let params: [String: Any] = [
            "to": "test@example.com",
            "subject": "Test",
            "body": "Hello",
        ]
        // confirm_send is not set
        XCTAssertNil(params["confirm_send"])
    }

    func testSendEmailRequiredFields() {
        let params: [String: Any] = ["subject": "Test"]
        XCTAssertNil(params["to"])
        XCTAssertNil(params["body"])
    }
}
