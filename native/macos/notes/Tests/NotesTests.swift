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
        let params: [String: Any] = ["folder_id": "Work", "limit": 5]
        XCTAssertEqual(params["folder_id"] as? String, "Work")
        XCTAssertEqual(params["limit"] as? Int, 5)
    }

    // MARK: - folderClause (NotesClient)

    func testFolderClauseNilReturnsEmptyString() {
        XCTAssertEqual(NotesClient.folderClause(nil), "")
    }

    func testFolderClauseWrapsNameInOfFolderClause() {
        XCTAssertEqual(NotesClient.folderClause("Work"), "of folder \"Work\"")
    }

    func testFolderClauseEscapesQuotes() {
        XCTAssertEqual(NotesClient.folderClause("Bob\"s Notes"), "of folder \"Bob\\\"s Notes\"")
    }

    // MARK: - list_notes / search_notes / create_note read folder_id (not folder)

    func testListNotesArgsHonorFolderIdKey() {
        let args = NotesCLI.listNotesArgs(["folder_id": "Work", "limit": 5])
        XCTAssertEqual(args.folder, "Work")
        XCTAssertEqual(args.limit, 5)
    }

    func testListNotesArgsIgnoreLegacyFolderKey() {
        // The legacy "folder" key must NOT scope the query; only "folder_id" does.
        let args = NotesCLI.listNotesArgs(["folder": "Work", "limit": 5])
        XCTAssertNil(args.folder)
    }

    func testListNotesArgsDefaultLimit() {
        XCTAssertEqual(NotesCLI.listNotesArgs([:]).limit, 20)
    }

    func testSearchNotesCommandAcceptsFolderIdKey() {
        let handler = NotesCLI.commands["search_notes"]!
        // Missing "query" must still be rejected even when folder_id is present,
        // proving folder_id no longer bypasses required-field validation.
        XCTAssertThrowsError(try handler(["folder_id": "Work"])) { error in
            guard case NotesCLIError.missingField("query") = error else {
                return XCTFail("expected missingField(query), got \(error)")
            }
        }
    }

    func testCreateNoteCommandAcceptsFolderIdKey() {
        let handler = NotesCLI.commands["create_note"]!
        XCTAssertThrowsError(try handler(["folder_id": "Work"])) { error in
            guard case NotesCLIError.missingField("title") = error else {
                return XCTFail("expected missingField(title), got \(error)")
            }
        }
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
        // script must access data to trigger TCC prompt, not 'to name'
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
        // denied error must point to System Settings > Automation
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

    // MARK: - runNoteScript (real function, via osascript)

    func testRunNoteScriptWrapsTimeoutWithHint() {
        // osascript `delay` guarantees a real .timeout is thrown by ScriptRunner.
        let script = "delay 2"
        XCTAssertThrowsError(try runNoteScript(script, timeout: 0.05)) { error in
            guard case ScriptError.timeout(_, let hint) = error else {
                return XCTFail("expected .timeout, got \(error)")
            }
            XCTAssertEqual(hint, "note may contain large attachments")
        }
    }

    func testRunNoteScriptPassesThroughAutomationPermission() {
        // Empty stderr classifies as .scriptFailed regardless of syntax; force a real
        // permission-shaped stderr via a script guaranteed to be rejected as automation.
        XCTAssertThrowsError(try runNoteScript("error \"not allowed to send Apple events\"", timeout: 5)) { error in
            guard case ScriptError.automationPermission = error else {
                return XCTFail("expected .automationPermission, got \(error)")
            }
        }
    }

    func testRunNoteScriptMapsFolderNotFoundToTeachingErrorWhenFolderPassed() {
        // Real osascript wording (curly apostrophe) for a nonexistent folder, with a
        // folder actually supplied, must map to the folder teaching error.
        let script = "error \"Notes got an error: Can\u{2019}t get folder \\\"Nope\\\". (-1728)\""
        XCTAssertThrowsError(try runNoteScript(script, timeout: 5, folder: "Nope")) { error in
            guard case CLIError.notFound(let msg) = error else {
                return XCTFail("expected CLIError.notFound, got \(error)")
            }
            XCTAssertTrue(msg.contains("listNoteFolders"))
        }
    }

    func testRunNoteScriptMapsStaleNoteIdToNoteNotFoundWhenNoFolderPassed() {
        // Same -1728 wording but no folder was passed (an id-scoped lookup like
        // getNote/updateNote/deleteNote) must yield the note-not-found teaching error.
        let script = "error \"Notes got an error: Can\u{2019}t get note id \\\"stale-id\\\". (-1728)\""
        XCTAssertThrowsError(try runNoteScript(script, timeout: 5)) { error in
            guard case CLIError.notFound(let msg) = error else {
                return XCTFail("expected CLIError.notFound, got \(error)")
            }
            XCTAssertTrue(msg.contains("listNotes/searchNotes"))
            XCTAssertFalse(msg.contains("listNoteFolders"), "stale note id must not surface the folder message")
        }
    }

    func testRunNoteScriptPassesThroughGenericScriptFailed() {
        // A syntax error (not -1728-shaped) must surface as the raw .scriptFailed,
        // not get rewritten into either teaching error.
        XCTAssertThrowsError(try runNoteScript("this is not valid AppleScript", timeout: 5, folder: "Work")) { error in
            guard case ScriptError.scriptFailed = error else {
                return XCTFail("expected .scriptFailed, got \(error)")
            }
        }
    }

    func testRunNoteScriptPreservesTimeoutSecondsValue() {
        XCTAssertThrowsError(try runNoteScript("delay 2", timeout: 0.05)) { error in
            guard case ScriptError.timeout(let seconds, _) = error else {
                return XCTFail("expected .timeout")
            }
            XCTAssertEqual(seconds, 0.05, "seconds value must be preserved across rewrap")
        }
    }

    // MARK: - AppleEventsGate end-to-end through performCheckPermission

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
        // post-status must remain .targetNotRunning — gate may auto-launch
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
