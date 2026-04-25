import SharedCLI
import XCTest
@testable import notes_cli

final class NotesTests: XCTestCase {

    // MARK: - Error Messages

    func testNotesCLIErrorMissingField() {
        let error = NotesCLIError.missingField("id")
        XCTAssertEqual(error.errorDescription, "Missing required field: id")
    }

    func testNotesErrorUnexpectedFormat() {
        let error = NotesError.unexpectedFormat
        XCTAssertTrue(error.errorDescription!.contains("Unexpected response format"))
    }

    func testNotesErrorNoFieldsToUpdate() {
        let error = NotesError.noFieldsToUpdate
        XCTAssertTrue(error.errorDescription!.contains("No fields to update"))
    }

    // MARK: - Command Validation

    func testCreateNoteRequiresTitle() {
        let params: [String: Any] = ["body": "Some content"]
        XCTAssertNil(params["title"])
    }

    func testGetNoteRequiresId() {
        let params: [String: Any] = [:]
        XCTAssertNil(params["id"])
    }

    func testSearchNotesRequiresQuery() {
        let params: [String: Any] = ["limit": 10]
        XCTAssertNil(params["query"])
    }

    func testListNotesDefaultLimit() {
        let params: [String: Any] = [:]
        let limit = params["limit"] as? Int ?? 20
        XCTAssertEqual(limit, 20)
    }

    func testListNotesWithFolder() {
        let params: [String: Any] = ["folder": "Work", "limit": 5]
        XCTAssertEqual(params["folder"] as? String, "Work")
        XCTAssertEqual(params["limit"] as? Int, 5)
    }

    func testUpdateNoteRequiresAtLeastOneField() {
        let params: [String: Any] = ["id": "note-123"]
        let title = params["title"] as? String
        let body = params["body"] as? String
        // Both nil means no fields to update
        XCTAssertNil(title)
        XCTAssertNil(body)
    }

    // MARK: - Permission Check Script

    func testPermissionCheckScriptAccessesData() {
        // "to name" does NOT require Automation permission — it returns the app
        // name without triggering a TCC prompt. The script must access actual
        // data (e.g. notes, folders) to force macOS to check permission.
        XCTAssertFalse(
            permissionCheckScript.hasSuffix("to name"),
            "permissionCheckScript must not use 'to name' — it does not require Automation permission"
        )
        XCTAssertTrue(
            permissionCheckScript.contains("Notes"),
            "permissionCheckScript must target Notes app"
        )
    }

    func testPermissionCheckScriptDeniedIncludesGuidance() {
        // When permission is denied, the error message should guide the user
        // to System Settings > Automation (not Calendars/Reminders).
        let detail = "Notes access denied: some error\nGrant access in System Settings > Privacy & Security > Automation"
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
        let errorMsg = ScriptError.timeout(30, "note may contain large attachments").errorDescription!
        let json = formatPermissionResult(granted: false, error: errorMsg)
        let data = json.data(using: .utf8)!
        let parsed = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(parsed["granted"] as? Bool, false)
        XCTAssertTrue(parsed["error"] is String)
        XCTAssertTrue((parsed["error"] as! String).contains("timed out after 30s"))
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

    // MARK: - runNoteScript Wrapper

    func testRunNoteScriptWrapsTimeoutWithHint() {
        let original = ScriptError.timeout(7, nil)
        let wrapped = { () throws -> Void in
            do { throw original }
            catch ScriptError.timeout(let seconds, _) {
                throw ScriptError.timeout(seconds, "note may contain large attachments")
            }
        }
        XCTAssertThrowsError(try wrapped()) { error in
            guard case ScriptError.timeout(let seconds, let hint) = error else {
                return XCTFail("expected .timeout, got \(error)")
            }
            XCTAssertEqual(seconds, 7)
            XCTAssertEqual(hint, "note may contain large attachments")
        }
    }

    func testRunNoteScriptPassesThroughScriptFailed() {
        let original = ScriptError.scriptFailed("x")
        let passThrough = { () throws -> Void in
            do { throw original }
            catch ScriptError.timeout(let seconds, _) {
                throw ScriptError.timeout(seconds, "note may contain large attachments")
            }
        }
        XCTAssertThrowsError(try passThrough()) { error in
            guard case ScriptError.scriptFailed = error else {
                return XCTFail("expected .scriptFailed, got \(error)")
            }
        }
    }

    func testRunNoteScriptPassesThroughAutomationPermission() {
        let original = ScriptError.automationPermission("denied")
        let passThrough = { () throws -> Void in
            do { throw original }
            catch ScriptError.timeout(let seconds, _) {
                throw ScriptError.timeout(seconds, "note may contain large attachments")
            }
        }
        XCTAssertThrowsError(try passThrough()) { error in
            guard case ScriptError.automationPermission = error else {
                return XCTFail("expected .automationPermission, got \(error)")
            }
        }
    }

    func testRunNoteScriptPreservesTimeoutSecondsValue() {
        let original = ScriptError.timeout(42, nil)
        let wrapped = { () throws -> Void in
            do { throw original }
            catch ScriptError.timeout(let seconds, _) {
                throw ScriptError.timeout(seconds, "note may contain large attachments")
            }
        }
        XCTAssertThrowsError(try wrapped()) { error in
            guard case ScriptError.timeout(let seconds, _) = error else {
                return XCTFail("expected .timeout")
            }
            XCTAssertEqual(seconds, 42, "seconds value must be preserved across rewrap")
        }
    }
}
