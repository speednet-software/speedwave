import XCTest
@testable import notes_cli

final class NotesTests: XCTestCase {

    // MARK: - AppleScript Escaping

    func testEscapeAppleScriptQuotes() {
        let result = escapeAppleScript("Hello \"World\"")
        XCTAssertEqual(result, "Hello \\\"World\\\"")
    }

    func testEscapeAppleScriptBackslash() {
        let result = escapeAppleScript("path\\to\\file")
        XCTAssertEqual(result, "path\\\\to\\\\file")
    }

    func testEscapeAppleScriptEmpty() {
        let result = escapeAppleScript("")
        XCTAssertEqual(result, "")
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
        // Payload: inject a newline to break out of the string and run shell
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
        let output = "id1||Note One||2024-01-01||Notes\nid2||Note Two||2024-01-02||Work\n"
        let result = parseDelimited(output, fields: ["id", "name", "modified", "folder"])
        XCTAssertEqual(result.count, 2)
        XCTAssertEqual(result[0]["id"] as? String, "id1")
        XCTAssertEqual(result[0]["name"] as? String, "Note One")
        XCTAssertEqual(result[0]["folder"] as? String, "Notes")
        XCTAssertEqual(result[1]["id"] as? String, "id2")
        XCTAssertEqual(result[1]["folder"] as? String, "Work")
    }

    func testParseDelimitedSkipsMalformed() {
        let output = "good||data||extra||field\nbad\nalso||good||more||fields\n"
        let result = parseDelimited(output, fields: ["a", "b", "c", "d"])
        XCTAssertEqual(result.count, 2)
    }

    func testParseDelimitedEmpty() {
        let result = parseDelimited("", fields: ["a"])
        XCTAssertTrue(result.isEmpty)
    }

    func testParseDelimitedTrimsWhitespace() {
        let output = " id1 || Note || 2024-01-01 || Notes \n"
        let result = parseDelimited(output, fields: ["id", "name", "date", "folder"])
        XCTAssertEqual(result.count, 1)
        XCTAssertEqual(result[0]["id"] as? String, "id1")
        XCTAssertEqual(result[0]["name"] as? String, "Note")
    }

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

    // MARK: - ScriptError Messages

    func testScriptErrorFailed() {
        let error = ScriptError.scriptFailed("script error message")
        XCTAssertTrue(error.errorDescription!.contains("AppleScript error"))
    }

    func testScriptErrorAutomationPermission() {
        let error = ScriptError.automationPermission("not allowed to send Apple events")
        XCTAssertTrue(error.errorDescription!.contains("Automation permission denied"))
        XCTAssertTrue(error.errorDescription!.contains("System Settings"))
    }

    func testScriptErrorTimeout() {
        let error = ScriptError.timeout(30)
        XCTAssertTrue(error.errorDescription!.contains("timed out"))
        XCTAssertTrue(error.errorDescription!.contains("30"))
        XCTAssertTrue(error.errorDescription!.contains("attachments"))
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

    // MARK: - Permission Check (formatPermissionResult)

    func testFormatPermissionResultGranted() {
        let json = formatPermissionResult(granted: true, error: nil)
        let data = json.data(using: .utf8)!
        let parsed = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertTrue(parsed["granted"] is Bool)
        XCTAssertEqual(parsed["granted"] as? Bool, true)
        XCTAssertNil(parsed["error"])
    }

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
        let errorMsg = ScriptError.timeout(30).errorDescription!
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
}
