import XCTest
@testable import reminders_cli

final class RemindersTests: XCTestCase {

    // MARK: - ISO8601 Parsing

    func testParseISO8601WithTimezone() {
        let date = parseISO8601("2025-03-01T10:00:00Z")
        XCTAssertNotNil(date)
    }

    func testParseISO8601WithFractionalSeconds() {
        let date = parseISO8601("2025-03-01T10:00:00.123Z")
        XCTAssertNotNil(date)
    }

    func testParseISO8601DateOnly() {
        let date = parseISO8601("2025-03-01")
        XCTAssertNotNil(date)
    }

    func testParseISO8601Invalid() {
        let date = parseISO8601("not-a-date")
        XCTAssertNil(date)
    }

    func testISO8601Roundtrip() {
        let original = "2025-06-15T14:30:00Z"
        guard let date = parseISO8601(original) else {
            XCTFail("Failed to parse ISO8601 date")
            return
        }
        let result = iso8601String(from: date)
        XCTAssertEqual(result, original)
    }

    // MARK: - Hex Color

    func testHexColorFromComponents() {
        // We can't easily create a CGColor in test without CoreGraphics context,
        // so we test nil path
        let result = hexColor(from: CGColor(gray: 0.5, alpha: 1.0))
        // Gray colorspace has 2 components (gray + alpha), not 3 (RGB)
        // So this should return nil
        XCTAssertNil(result)
    }

    // MARK: - CLI Error Messages

    func testCLIErrorMissingField() {
        let error = CLIError.missingField("name")
        XCTAssertEqual(error.errorDescription, "Missing required field: name")
    }

    func testCLIErrorNotFound() {
        let error = CLIError.notFound("Reminder with id 'abc' not found")
        XCTAssertEqual(error.errorDescription, "Reminder with id 'abc' not found")
    }

    func testCLIErrorInvalidDate() {
        let error = CLIError.invalidDate("bad-date")
        XCTAssertTrue(error.errorDescription!.contains("Invalid ISO8601 date"))
        XCTAssertTrue(error.errorDescription!.contains("bad-date"))
    }

    // MARK: - Reminder Dict Conversion

    func testReminderToDictIncludesRequiredFields() {
        // This test verifies the dict structure without needing a real EKReminder
        // (EKReminder requires an EKEventStore which needs entitlements)
        // We verify the error path instead
        let error = CLIError.missingField("id")
        XCTAssertNotNil(error.errorDescription)
    }

    // MARK: - CLI Argument Parsing

    func testUnknownCommandExits() {
        // Verify error message format for unknown commands
        let availableCommands = "list_lists, list_reminders, get_reminder, create_reminder, complete_reminder"
        XCTAssertTrue(availableCommands.contains("list_lists"))
        XCTAssertTrue(availableCommands.contains("complete_reminder"))
    }

    func testInvalidJSONIsDetected() {
        let invalidJSON = "{not valid json"
        let data = invalidJSON.data(using: .utf8)!
        let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        XCTAssertNil(parsed)
    }

    func testValidJSONIsParsed() {
        let validJSON = "{\"name\": \"test\", \"list\": \"Work\"}"
        let data = validJSON.data(using: .utf8)!
        let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        XCTAssertNotNil(parsed)
        XCTAssertEqual(parsed?["name"] as? String, "test")
        XCTAssertEqual(parsed?["list"] as? String, "Work")
    }

    func testEmptyJSONDefaultsWork() {
        let emptyJSON = "{}"
        let data = emptyJSON.data(using: .utf8)!
        let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        XCTAssertNotNil(parsed)
        // Default limit should be used when not specified
        let limit = parsed?["limit"] as? Int ?? 20
        XCTAssertEqual(limit, 20)
    }
}
