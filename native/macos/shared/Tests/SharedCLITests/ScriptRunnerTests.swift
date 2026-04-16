import XCTest
@testable import SharedCLI

final class ScriptRunnerTests: XCTestCase {

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

    func testEscapeAppleScriptPreservesAllPrintableASCII() {
        for v in 0x20...0x7E where v != 0x22 && v != 0x5C {
            let ch = String(UnicodeScalar(v)!)
            let result = escapeAppleScript(ch)
            XCTAssertEqual(result, ch, "printable ASCII U+\(String(format: "%04X", v)) should pass through unchanged")
        }
    }

    // MARK: - Boundary conditions for escapeAppleScript

    func testEscapeAppleScriptBoundaryC0() {
        for v: UInt32 in 0x00...0x1F {
            let ch = String(UnicodeScalar(v)!)
            let result = escapeAppleScript(ch)
            XCTAssertEqual(result, "", "C0 U+\(String(format: "%04X", v)) should be stripped")
        }
        let del = String(UnicodeScalar(0x7F)!)
        XCTAssertEqual(escapeAppleScript(del), "", "DEL U+007F should be stripped")
    }

    func testEscapeAppleScriptBoundaryLineSep() {
        XCTAssertEqual(escapeAppleScript(String(UnicodeScalar(0x85)!)), "", "NEL U+0085 should be stripped")
        XCTAssertEqual(escapeAppleScript(String(UnicodeScalar(0x2028)!)), "", "U+2028 should be stripped")
        XCTAssertEqual(escapeAppleScript(String(UnicodeScalar(0x2029)!)), "", "U+2029 should be stripped")
        // Adjacent scalars are preserved
        XCTAssertEqual(escapeAppleScript(String(UnicodeScalar(0x86)!)), String(UnicodeScalar(0x86)!), "U+0086 should be preserved")
        XCTAssertEqual(escapeAppleScript(String(UnicodeScalar(0x2027)!)), String(UnicodeScalar(0x2027)!), "U+2027 should be preserved")
        XCTAssertEqual(escapeAppleScript(String(UnicodeScalar(0x202A)!)), String(UnicodeScalar(0x202A)!), "U+202A should be preserved")
    }

    // MARK: - Parse Delimited

    func testParseDelimitedBasic4Field() {
        let output = "id1||Note One||2024-01-01||Notes\nid2||Note Two||2024-01-02||Work\n"
        let result = parseDelimited(output, fields: ["id", "name", "modified", "folder"])
        XCTAssertEqual(result.count, 2)
        XCTAssertEqual(result[0]["id"] as? String, "id1")
        XCTAssertEqual(result[0]["name"] as? String, "Note One")
        XCTAssertEqual(result[0]["folder"] as? String, "Notes")
        XCTAssertEqual(result[1]["id"] as? String, "id2")
        XCTAssertEqual(result[1]["folder"] as? String, "Work")
    }

    func testParseDelimitedBasic3Field() {
        let output = "Alice||Hello||2024-01-01\nBob||World||2024-01-02\n"
        let result = parseDelimited(output, fields: ["from", "subject", "date"])
        XCTAssertEqual(result.count, 2)
        XCTAssertEqual(result[0]["from"] as? String, "Alice")
        XCTAssertEqual(result[0]["subject"] as? String, "Hello")
        XCTAssertEqual(result[1]["from"] as? String, "Bob")
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

    func testParseDelimitedDropsRowsWithLiteralDelimiterInValue() {
        // A row whose field count after splitting on "||" doesn't match fields is silently dropped.
        // "foo||bar||baz" splits into 3 parts but only 2 fields → dropped.
        let result = parseDelimited("foo||bar||baz", fields: ["x", "y"])
        XCTAssertEqual(result.count, 0)
    }

    // MARK: - Boundary conditions for parseDelimited

    func testParseDelimitedSingleRow() {
        let result = parseDelimited("a||b", fields: ["x", "y"])
        XCTAssertEqual(result.count, 1)
        XCTAssertEqual(result[0]["x"] as? String, "a")
    }

    func testParseDelimitedMoreFieldsThanData() {
        let result = parseDelimited("a||b", fields: ["x", "y", "z"])
        XCTAssertEqual(result.count, 0)
    }

    func testParseDelimitedFewerFieldsThanData() {
        let result = parseDelimited("a||b||c", fields: ["x"])
        XCTAssertEqual(result.count, 0)
    }

    // MARK: - ScriptError Descriptions

    func testScriptErrorFailedDescription() {
        let err = ScriptError.scriptFailed("x")
        XCTAssertEqual(err.errorDescription, "AppleScript error: x")
    }

    func testScriptErrorAutomationPermissionDescription() {
        let err = ScriptError.automationPermission("not allowed")
        XCTAssertTrue(err.errorDescription!.contains("Automation permission denied"))
        XCTAssertTrue(err.errorDescription!.contains("System Settings"))
    }

    func testScriptErrorTimeoutDescriptionWithoutHint() {
        let err = ScriptError.timeout(15, nil)
        XCTAssertEqual(err.errorDescription, "AppleScript timed out after 15s")
    }

    func testScriptErrorTimeoutDescriptionWithHint() {
        let err = ScriptError.timeout(30, "note may contain large attachments")
        XCTAssertEqual(err.errorDescription, "AppleScript timed out after 30s — note may contain large attachments")
    }

    func testScriptErrorTimeoutWithZeroSeconds() {
        let err = ScriptError.timeout(0, nil)
        XCTAssertEqual(err.errorDescription, "AppleScript timed out after 0s")
    }

    // MARK: - Classifier Tests

    // These fixtures verify the classifier's substring-match invariant, not production TCC stderr strings.
    // Actual macOS stderr for TCC denials (e.g. "execution error: Not authorized to send Apple events to Mail. (-1743)")
    // is NOT matched by the current "not allowed" / "not permitted" / "assistive access" substrings —
    // a pre-existing gap in macOS TCC stderr coverage that predates and is independent of this refactor.
    // Tracking and closing that gap is out of scope here.

    func testClassifyFailureNotAllowed() {
        let err = ScriptRunner.classifyFailure(stderr: "osascript: not allowed to send Apple events")
        guard case .automationPermission = err else { return XCTFail("expected .automationPermission") }
    }

    func testClassifyFailureNotPermitted() {
        let err = ScriptRunner.classifyFailure(stderr: "operation not permitted")
        guard case .automationPermission = err else { return XCTFail("expected .automationPermission") }
    }

    func testClassifyFailureAssistiveAccess() {
        let err = ScriptRunner.classifyFailure(stderr: "assistive access required")
        guard case .automationPermission = err else { return XCTFail("expected .automationPermission") }
    }

    func testClassifyFailureGenericScriptError() {
        let err = ScriptRunner.classifyFailure(stderr: "syntax error: expected end of line")
        guard case .scriptFailed = err else { return XCTFail("expected .scriptFailed") }
    }

    func testClassifyFailureEmptyStderr() {
        let err = ScriptRunner.classifyFailure(stderr: "")
        guard case .scriptFailed = err else { return XCTFail("expected .scriptFailed") }
    }
}
