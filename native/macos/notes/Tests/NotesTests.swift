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

    // MARK: - runCLI command table (NotesCLI.commands)

    func testCommandTableHasAllExpectedKeys() {
        let expected: Set<String> = [
            "list_folders", "list_notes", "get_note", "search_notes",
            "create_note", "update_note", "delete_note",
        ]
        XCTAssertEqual(Set(NotesCLI.commands.keys), expected,
                       "command table must dispatch exactly the documented commands (minus check_permission)")
    }

    func testCommandTableKeysAreSubsetOfCommandList() {
        // Each dispatch key (plus check_permission) must appear in the advertised command list.
        for key in NotesCLI.commands.keys {
            XCTAssertTrue(NotesCLI.commandList.contains(key),
                          "command '\(key)' missing from advertised commandList")
        }
        XCTAssertTrue(NotesCLI.commandList.contains("check_permission"))
    }

    func testGetNoteCommandThrowsMissingIdBeforeScriptRuns() {
        // Required-field validation must fire before any AppleScript is spawned.
        let handler = NotesCLI.commands["get_note"]!
        XCTAssertThrowsError(try handler([:])) { error in
            guard case NotesCLIError.missingField(let f) = error else {
                return XCTFail("expected missingField, got \(error)")
            }
            XCTAssertEqual(f, "id")
        }
    }

    func testSearchNotesCommandThrowsMissingQuery() {
        let handler = NotesCLI.commands["search_notes"]!
        XCTAssertThrowsError(try handler(["limit": 5])) { error in
            guard case NotesCLIError.missingField("query") = error else {
                return XCTFail("expected missingField(query), got \(error)")
            }
        }
    }

    func testCreateNoteCommandThrowsMissingTitle() {
        let handler = NotesCLI.commands["create_note"]!
        XCTAssertThrowsError(try handler(["body": "x"])) { error in
            guard case NotesCLIError.missingField("title") = error else {
                return XCTFail("expected missingField(title), got \(error)")
            }
        }
    }

    func testUpdateNoteCommandThrowsMissingId() {
        let handler = NotesCLI.commands["update_note"]!
        XCTAssertThrowsError(try handler(["title": "x"])) { error in
            guard case NotesCLIError.missingField("id") = error else {
                return XCTFail("expected missingField(id), got \(error)")
            }
        }
    }

    func testDeleteNoteCommandThrowsMissingId() {
        let handler = NotesCLI.commands["delete_note"]!
        XCTAssertThrowsError(try handler([:])) { error in
            guard case NotesCLIError.missingField("id") = error else {
                return XCTFail("expected missingField(id), got \(error)")
            }
        }
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

    // MARK: - AppleEventsGate end-to-end through performCheckPermission
    //
    // Mirrors MailTests AppleEventsGate suite — same pattern, with .notes entity
    // and com.apple.Notes target bundle. Verifies that the notes-cli check_permission
    // path produces status-aware output identical to mail-cli, which is the
    // unification goal of this change.

    final class FakeNotesGate: PermissionGate {
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
        let gate = FakeNotesGate()
        gate.initialStatus = .granted
        let result = performCheckPermission(gate: gate, entity: .notes)
        let parsed = try! JSONSerialization.jsonObject(with: result.data(using: .utf8)!) as! [String: Any]
        XCTAssertEqual(parsed["granted"] as? Bool, true)
        XCTAssertEqual(parsed["status"] as? String, "granted")
    }

    func testCheckPermissionDeniedReturnsAppleEventsTccutil() {
        let gate = FakeNotesGate()
        gate.initialStatus = .denied
        let result = performCheckPermission(gate: gate, entity: .notes)
        let parsed = try! JSONSerialization.jsonObject(with: result.data(using: .utf8)!) as! [String: Any]
        XCTAssertEqual(parsed["status"] as? String, "denied")
        let error = parsed["error"] as? String ?? ""
        XCTAssertTrue(error.contains("tccutil reset AppleEvents pl.speedwave.desktop.notes"),
                      "Notes denied must use AppleEvents service + sub-identifier, got: \(error)")
        XCTAssertFalse(error.contains("tccutil reset Notes"),
                       "Notes must NOT use 'tccutil reset Notes' (no such TCC service), got: \(error)")
    }

    func testCheckPermissionTargetNotRunningOnProcNotFound() {
        // post-status must also be .targetNotRunning — orchestrator no longer
        // short-circuits on initial .targetNotRunning (gate may auto-launch).
        let gate = FakeNotesGate()
        gate.initialStatus = .targetNotRunning(bundleId: "com.apple.Notes")
        gate.postRequestStatus = .targetNotRunning(bundleId: "com.apple.Notes")
        let result = performCheckPermission(gate: gate, entity: .notes)
        let parsed = try! JSONSerialization.jsonObject(with: result.data(using: .utf8)!) as! [String: Any]
        XCTAssertEqual(parsed["status"] as? String, "targetNotRunning")
        let error = parsed["error"] as? String ?? ""
        XCTAssertFalse(error.lowercased().contains("tccutil"),
                       "targetNotRunning must NOT recommend tccutil")
        XCTAssertTrue(error.contains("Notes.app"),
                      "Notes targetNotRunning must mention Notes.app")
    }

    func testCheckPermissionSilentRejectWhenNotDeterminedTwice() {
        let gate = FakeNotesGate()
        gate.initialStatus = .notDetermined
        gate.postRequestStatus = .notDetermined
        gate.requestGranted = false
        let result = performCheckPermission(gate: gate, entity: .notes)
        let parsed = try! JSONSerialization.jsonObject(with: result.data(using: .utf8)!) as! [String: Any]
        XCTAssertEqual(parsed["status"] as? String, "silentReject")
        let error = parsed["error"] as? String ?? ""
        XCTAssertTrue(error.contains("reinstall"))
    }

    func testCheckPermissionGrantedButDataAccessFails() {
        let gate = FakeNotesGate()
        gate.initialStatus = .granted
        gate.dataAccessError = "AppleScript error: cannot read notes"
        let result = performCheckPermission(gate: gate, entity: .notes)
        let parsed = try! JSONSerialization.jsonObject(with: result.data(using: .utf8)!) as! [String: Any]
        XCTAssertEqual(parsed["granted"] as? Bool, false)
        XCTAssertEqual(parsed["status"] as? String, "silentReject")
        let error = parsed["error"] as? String ?? ""
        XCTAssertTrue(error.contains("data access failed"))
        XCTAssertTrue(error.contains("cannot read notes"))
    }
}
