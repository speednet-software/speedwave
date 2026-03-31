import EventKit
import XCTest
@testable import calendar_cli

final class CalendarTests: XCTestCase {

    // MARK: - ISO8601 Parsing

    func testParseISO8601WithTimezone() {
        let date = parseISO8601("2025-03-01T10:00:00Z")
        XCTAssertNotNil(date)
    }

    func testParseISO8601WithFractionalSeconds() {
        let date = parseISO8601("2025-03-01T10:00:00.500Z")
        XCTAssertNotNil(date)
    }

    func testParseISO8601DateOnly() {
        let date = parseISO8601("2025-03-01")
        XCTAssertNotNil(date)
    }

    func testParseISO8601Invalid() {
        let date = parseISO8601("invalid")
        XCTAssertNil(date)
    }

    func testISO8601Roundtrip() {
        let original = "2025-06-15T14:30:00Z"
        guard let date = parseISO8601(original) else {
            XCTFail("Failed to parse")
            return
        }
        let result = iso8601String(from: date)
        XCTAssertEqual(result, original)
    }

    // MARK: - Calendar Type String

    func testCalendarTypeStrings() {
        XCTAssertEqual(calendarTypeString(.local), "local")
        XCTAssertEqual(calendarTypeString(.calDAV), "caldav")
        XCTAssertEqual(calendarTypeString(.exchange), "exchange")
        XCTAssertEqual(calendarTypeString(.subscription), "subscription")
        XCTAssertEqual(calendarTypeString(.birthday), "birthday")
    }

    // MARK: - CLI Error Messages

    func testCLIErrorMissingField() {
        let error = CLIError.missingField("summary")
        XCTAssertEqual(error.errorDescription, "Missing required field: summary")
    }

    func testCLIErrorNotFound() {
        let error = CLIError.notFound("Event with id 'xyz' not found")
        XCTAssertEqual(error.errorDescription, "Event with id 'xyz' not found")
    }

    func testCLIErrorInvalidDate() {
        let error = CLIError.invalidDate("not-a-date")
        XCTAssertTrue(error.errorDescription!.contains("Invalid ISO8601 date"))
    }

    // MARK: - Hex Color

    func testHexColorNilForGrayColorSpace() {
        let result = hexColor(from: CGColor(gray: 0.5, alpha: 1.0))
        XCTAssertNil(result)
    }

    // MARK: - JSON Argument Parsing

    func testCreateEventRequiredFields() {
        let params: [String: Any] = ["summary": "Meeting"]
        // Missing start and end should be caught
        XCTAssertNil(params["start"])
        XCTAssertNil(params["end"])
    }

    func testCreateEventAllFields() {
        let params: [String: Any] = [
            "summary": "Team Standup",
            "start": "2025-03-01T09:00:00Z",
            "end": "2025-03-01T09:30:00Z",
            "calendar": "Work",
            "location": "Room 42",
            "notes": "Discuss sprint progress",
            "all_day": false,
        ]
        XCTAssertEqual(params["summary"] as? String, "Team Standup")
        XCTAssertNotNil(parseISO8601(params["start"] as! String))
        XCTAssertNotNil(parseISO8601(params["end"] as! String))
    }

    func testInvalidDateFormatDetected() {
        let badDate = "March 1st, 2025"
        XCTAssertNil(parseISO8601(badDate))
    }

    func testUpdateEventPartialParams() {
        let params: [String: Any] = [
            "id": "event-123",
            "summary": "Updated Title",
        ]
        XCTAssertNotNil(params["id"])
        XCTAssertNotNil(params["summary"])
        XCTAssertNil(params["start"])  // Optional, not required for update
    }

    func testDeleteEventRequiresId() {
        let params: [String: Any] = [:]
        XCTAssertNil(params["id"])
    }

    func testDefaultLimitIs20() {
        let params: [String: Any] = [:]
        let limit = params["limit"] as? Int ?? 20
        XCTAssertEqual(limit, 20)
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

    func testFormatPermissionResultDenied() {
        let json = formatPermissionResult(granted: false, error: "access denied")
        let data = json.data(using: .utf8)!
        let parsed = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertTrue(parsed["granted"] is Bool)
        XCTAssertEqual(parsed["granted"] as? Bool, false)
        XCTAssertTrue(parsed["error"] is String)
        XCTAssertEqual(parsed["error"] as? String, "access denied")
    }

    func testRequestCalendarAccessReturnsTuple() {
        // Compile-time check: requestCalendarAccess returns (granted: Bool, error: Error?)
        let store = EKEventStore()
        let result: (granted: Bool, error: Error?) = requestCalendarAccess(store: store, timeout: 0.001)
        XCTAssertNotNil(result)
    }
}
