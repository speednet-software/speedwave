import EventKit
import XCTest
@testable import SharedCLI

final class SharedCLITests: XCTestCase {

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

    func testParseISO8601InvalidFormat() {
        let badDate = "March 1st, 2025"
        XCTAssertNil(parseISO8601(badDate))
    }

    // MARK: - Hex Color

    func testHexColorReturnsCorrectRGBString() {
        let red = CGColor(srgbRed: 1.0, green: 0.0, blue: 0.0, alpha: 1.0)
        XCTAssertEqual(hexColor(from: red), "#ff0000")
    }

    func testHexColorBlackAndWhite() {
        let black = CGColor(srgbRed: 0, green: 0, blue: 0, alpha: 1)
        XCTAssertEqual(hexColor(from: black), "#000000")
        let white = CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 1)
        XCTAssertEqual(hexColor(from: white), "#ffffff")
    }

    func testHexColorNilForGrayColorSpace() {
        let result = hexColor(from: CGColor(gray: 0.5, alpha: 1.0))
        XCTAssertNil(result)
    }

    // MARK: - CLIError

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

    func testCLIErrorMissingFieldHasDescription() {
        let error = CLIError.missingField("id")
        XCTAssertNotNil(error.errorDescription)
    }

    func testInvalidDateFormatDetected() {
        let badDate = "March 1st, 2025"
        XCTAssertNil(parseISO8601(badDate))
    }

    // MARK: - formatPermissionResult

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
        XCTAssertEqual(parsed["granted"] as? Bool, false)
        XCTAssertEqual(parsed["error"] as? String, "access denied")
    }

    // exitWithError calls exit(1) and cannot be unit-tested without process spawning.
    // Covered by integration: all 4 CLIs use it and would crash on incorrect behavior.

    // MARK: - resolveCalendars (Reminders)

    func testResolveRemindersByIdMatchesFirst() throws {
        let store = EKEventStore()
        let allLists = store.calendars(for: .reminder)
        try XCTSkipIf(allLists.isEmpty, "No reminder lists available on this machine")
        let first = allLists[0]
        let result = try resolveCalendars(for: .reminder, filter: first.calendarIdentifier, store: store)
        XCTAssertEqual(result.first?.calendarIdentifier, first.calendarIdentifier)
    }

    func testResolveRemindersByNameFallback() throws {
        let store = EKEventStore()
        let allLists = store.calendars(for: .reminder)
        try XCTSkipIf(allLists.isEmpty, "No reminder lists available on this machine")
        let first = allLists[0]
        let result = try resolveCalendars(for: .reminder, filter: first.title, store: store)
        XCTAssertEqual(result.first?.title, first.title)
    }

    func testResolveRemindersNotFoundThrows() {
        let store = EKEventStore()
        let bogus = "NONEXISTENT-\(UUID())"
        XCTAssertThrowsError(try resolveCalendars(for: .reminder, filter: bogus, store: store)) { error in
            XCTAssertTrue(error is CLIError, "Should throw CLIError")
            XCTAssertTrue(error.localizedDescription.contains("not found"))
            XCTAssertTrue(error.localizedDescription.contains(bogus))
        }
    }

    // MARK: - resolveCalendars (Calendar Events)

    func testResolveCalendarsByIdMatchesFirst() throws {
        let store = EKEventStore()
        let allCals = store.calendars(for: .event)
        try XCTSkipIf(allCals.isEmpty, "No calendars available on this machine")
        let first = allCals[0]
        let result = try resolveCalendars(for: .event, filter: first.calendarIdentifier, store: store)
        XCTAssertEqual(result.first?.calendarIdentifier, first.calendarIdentifier)
    }

    func testResolveCalendarsByNameFallback() throws {
        let store = EKEventStore()
        let allCals = store.calendars(for: .event)
        try XCTSkipIf(allCals.isEmpty, "No calendars available on this machine")
        let first = allCals[0]
        let result = try resolveCalendars(for: .event, filter: first.title, store: store)
        XCTAssertEqual(result.first?.title, first.title)
    }

    func testResolveCalendarsNotFoundThrows() {
        let store = EKEventStore()
        let bogus = "NONEXISTENT-\(UUID())"
        XCTAssertThrowsError(try resolveCalendars(for: .event, filter: bogus, store: store)) { error in
            XCTAssertTrue(error is CLIError, "Should throw CLIError")
            XCTAssertTrue(error.localizedDescription.contains("not found"))
            XCTAssertTrue(error.localizedDescription.contains(bogus))
        }
    }
}
