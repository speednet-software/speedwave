import SharedCLI
import XCTest
@testable import mail_cli

final class MailTests: XCTestCase {

    // MARK: - Client Detection

    func testAppleMailAlwaysAvailable() {
        XCTAssertTrue(AppleMailClient.isAvailable())
    }

    // MARK: - detectClients structure + permission/absence distinction

    func testDetectClientsHasMailAndOutlookEntries() {
        let result = detectClients()
        let clients = result["clients"] as? [[String: Any]] ?? []
        XCTAssertEqual(clients.count, 2, "must list Apple Mail + Outlook")
        XCTAssertEqual(clients.first?["name"] as? String, AppleMailClient.name)
        XCTAssertEqual(clients.first?["available"] as? Bool, true)
        let outlook = clients.last
        XCTAssertEqual(outlook?["name"] as? String, OutlookClient.name)
        XCTAssertNotNil(outlook?["available"], "Outlook entry must always carry an availability flag")
        // An `error` must pair with available=false.
        if let err = outlook?["error"] as? String {
            XCTAssertEqual(outlook?["available"] as? Bool, false,
                           "an Outlook error must pair with available=false")
            XCTAssertFalse(err.isEmpty)
        }
    }

    func testOutlookAvailabilityRethrowsPermissionAndTimeoutErrors() {
        let permission = ScriptError.automationPermission("not allowed")
        let timeout = ScriptError.timeout(5, nil)
        let scriptFailed = ScriptError.scriptFailed("syntax error")

        func classify(_ e: ScriptError) -> Bool {
            // true = rethrown (ambiguous, surface to user); false = treated as not-available
            switch e {
            case .automationPermission, .timeout: return true
            case .scriptFailed: return false
            }
        }
        XCTAssertTrue(classify(permission), "permission denial must be surfaced, not swallowed")
        XCTAssertTrue(classify(timeout), "timeout must be surfaced, not swallowed")
        XCTAssertFalse(classify(scriptFailed), "a generic failure means Outlook is simply not available")
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
        // "to name" does NOT require Automation permission.
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
        // Denied error must guide to System Settings > Automation.
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

    // MARK: - AppleEventsGate end-to-end through performCheckPermission

    final class FakeMailGate: PermissionGate {
        var initialStatus: RawAuthorizationStatus = .notDetermined
        var postRequestStatus: RawAuthorizationStatus = .notDetermined
        var requestGranted: Bool = false
        var dataAccessError: String? = nil
        var queryCount = 0
        func authorizationStatus() -> RawAuthorizationStatus {
            queryCount += 1
            return queryCount == 1 ? initialStatus : postRequestStatus
        }
        func requestAccess(completion: @escaping (Bool, Error?) -> Void) {
            completion(requestGranted, nil)
        }
        func verifyDataAccess() -> String? { dataAccessError }
    }

    func testCheckPermissionGrantedWhenAEReturnsNoErr() {
        // Initial status .granted (AE returned noErr) and data access succeeds → granted.
        let gate = FakeMailGate()
        gate.initialStatus = .granted
        let result = performCheckPermission(gate: gate, entity: .mail)
        let parsed = try! JSONSerialization.jsonObject(with: result.data(using: .utf8)!) as! [String: Any]
        XCTAssertEqual(parsed["granted"] as? Bool, true)
        XCTAssertEqual(parsed["status"] as? String, "granted")
    }

    func testCheckPermissionDeniedReturnsAppleEventsTccutil() {
        // Mail uses kTCCServiceAppleEvents, so denied must reset AppleEvents, not Mail.
        let gate = FakeMailGate()
        gate.initialStatus = .denied
        let result = performCheckPermission(gate: gate, entity: .mail)
        let parsed = try! JSONSerialization.jsonObject(with: result.data(using: .utf8)!) as! [String: Any]
        XCTAssertEqual(parsed["status"] as? String, "denied")
        let error = parsed["error"] as? String ?? ""
        XCTAssertTrue(error.contains("tccutil reset AppleEvents pl.speedwave.desktop.mail"),
                      "Mail denied must use AppleEvents service + sub-identifier, got: \(error)")
        XCTAssertFalse(error.contains("tccutil reset Mail"),
                       "Mail must NOT use 'tccutil reset Mail' (no such TCC service), got: \(error)")
    }

    func testCheckPermissionTargetNotRunningOnProcNotFound() {
        // post-status must also be .targetNotRunning (no short-circuit on initial).
        let gate = FakeMailGate()
        gate.initialStatus = .targetNotRunning(bundleId: "com.apple.mail")
        gate.postRequestStatus = .targetNotRunning(bundleId: "com.apple.mail")
        let result = performCheckPermission(gate: gate, entity: .mail)
        let parsed = try! JSONSerialization.jsonObject(with: result.data(using: .utf8)!) as! [String: Any]
        XCTAssertEqual(parsed["status"] as? String, "targetNotRunning")
        let error = parsed["error"] as? String ?? ""
        XCTAssertFalse(error.lowercased().contains("tccutil"),
                       "targetNotRunning must NOT recommend tccutil")
        XCTAssertTrue(error.contains("Mail.app"),
                      "Mail targetNotRunning must mention Mail.app")
    }

    func testCheckPermissionSilentRejectWhenNotDeterminedTwice() {
        // .notDetermined unchanged after request maps to .silentReject.
        let gate = FakeMailGate()
        gate.initialStatus = .notDetermined
        gate.postRequestStatus = .notDetermined
        gate.requestGranted = false
        let result = performCheckPermission(gate: gate, entity: .mail)
        let parsed = try! JSONSerialization.jsonObject(with: result.data(using: .utf8)!) as! [String: Any]
        XCTAssertEqual(parsed["status"] as? String, "silentReject")
        let error = parsed["error"] as? String ?? ""
        XCTAssertTrue(error.contains("reinstall"),
                      "silentReject must mention reinstall (signing/entitlement guidance)")
    }

    func testCheckPermissionGrantedButDataAccessFails() {
        // .granted but data-access probe fails downgrades to silentReject.
        let gate = FakeMailGate()
        gate.initialStatus = .granted
        gate.dataAccessError = "AppleScript error: cannot read mailboxes"
        let result = performCheckPermission(gate: gate, entity: .mail)
        let parsed = try! JSONSerialization.jsonObject(with: result.data(using: .utf8)!) as! [String: Any]
        XCTAssertEqual(parsed["granted"] as? Bool, false,
                       "Data-access failure must downgrade granted=true")
        XCTAssertEqual(parsed["status"] as? String, "silentReject")
        let error = parsed["error"] as? String ?? ""
        XCTAssertTrue(error.contains("data access failed"),
                      "Error must explain data-access layer failure")
        XCTAssertTrue(error.contains("cannot read mailboxes"),
                      "Underlying probe error must be included")
    }
}
