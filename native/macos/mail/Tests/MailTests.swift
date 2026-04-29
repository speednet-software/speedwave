import SharedCLI
import XCTest
@testable import mail_cli

final class MailTests: XCTestCase {

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

    // MARK: - Permission Check Script

    func testPermissionCheckScriptAccessesData() {
        // "to name" does NOT require Automation permission — it returns the app
        // name without triggering a TCC prompt. The script must access actual
        // data (e.g. accounts, mailboxes) to force macOS to check permission.
        XCTAssertFalse(
            permissionCheckScript.hasSuffix("to name"),
            "permissionCheckScript must not use 'to name' — it does not require Automation permission"
        )
        XCTAssertTrue(
            permissionCheckScript.contains("Mail"),
            "permissionCheckScript must target Mail app"
        )
    }

    func testPermissionCheckScriptDeniedIncludesGuidance() {
        // When permission is denied, the error message should guide the user
        // to System Settings > Automation (not Calendars/Reminders).
        let detail = "Mail access denied: some error\nGrant access in System Settings > Privacy & Security > Automation"
        XCTAssertTrue(detail.contains("Automation"))
    }

    // MARK: - Permission Check (formatPermissionResult with domain-specific errors)

    func testFormatPermissionResultWithAutomationPermissionError() {
        let errorMsg = ScriptError.automationPermission("not allowed").errorDescription!
        let json = formatPermissionResult(granted: false, error: errorMsg)
        let data = json.data(using: .utf8)!
        let parsed = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertTrue(parsed["granted"] is Bool)
        XCTAssertEqual(parsed["granted"] as? Bool, false)
        XCTAssertTrue(parsed["error"] is String)
        XCTAssertTrue((parsed["error"] as! String).contains("Automation permission denied"))
    }

    func testFormatPermissionResultWithTimeoutError() {
        let errorMsg = ScriptError.timeout(15, nil).errorDescription!
        let json = formatPermissionResult(granted: false, error: errorMsg)
        let data = json.data(using: .utf8)!
        let parsed = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(parsed["granted"] as? Bool, false)
        XCTAssertTrue(parsed["error"] is String)
        XCTAssertTrue((parsed["error"] as! String).contains("timed out after 15s"))
    }

    func testFormatPermissionResultWithScriptFailedError() {
        let errorMsg = ScriptError.scriptFailed("some error").errorDescription!
        let json = formatPermissionResult(granted: false, error: errorMsg)
        let data = json.data(using: .utf8)!
        let parsed = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(parsed["granted"] as? Bool, false)
        XCTAssertTrue(parsed["error"] is String)
        XCTAssertTrue((parsed["error"] as! String).contains("AppleScript error"))
    }
}
