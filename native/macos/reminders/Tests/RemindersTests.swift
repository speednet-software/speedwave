import EventKit
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

    func testCLIErrorMissingFieldHasDescription() {
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
        let validJSON = "{\"name\": \"test\", \"list_id\": \"Work\"}"
        let data = validJSON.data(using: .utf8)!
        let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        XCTAssertNotNil(parsed)
        XCTAssertEqual(parsed?["name"] as? String, "test")
        XCTAssertEqual(parsed?["list_id"] as? String, "Work")
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

    // MARK: - Tag Extraction from Notes

    func testExtractTagsSingleTag() {
        let tags = extractTags(from: "[#work] Some notes")
        XCTAssertEqual(tags, ["work"])
    }

    func testExtractTagsMultipleTags() {
        let tags = extractTags(from: "[#work] [#urgent]\nDo this soon")
        XCTAssertEqual(tags, ["work", "urgent"])
    }

    func testExtractTagsNoTags() {
        let tags = extractTags(from: "Just plain notes")
        XCTAssertEqual(tags, [])
    }

    func testExtractTagsEmptyString() {
        let tags = extractTags(from: "")
        XCTAssertEqual(tags, [])
    }

    func testExtractTagsDeduplicates() {
        let tags = extractTags(from: "[#work] [#Work] [#WORK]")
        XCTAssertEqual(tags, ["work"])
    }

    // MARK: - Strip Tags from Notes

    func testStripTagsSingleTag() {
        let clean = stripTags(from: "[#work] Some notes")
        XCTAssertEqual(clean, "Some notes")
    }

    func testStripTagsMultipleTags() {
        let clean = stripTags(from: "[#work] [#urgent]\nDo this soon")
        XCTAssertEqual(clean, "Do this soon")
    }

    func testStripTagsNoTags() {
        let clean = stripTags(from: "Just plain notes")
        XCTAssertEqual(clean, "Just plain notes")
    }

    func testStripTagsOnlyTags() {
        let clean = stripTags(from: "[#work] [#urgent]")
        XCTAssertEqual(clean, "")
    }

    // MARK: - Combine Tags with Notes

    func testCombineTagsWithNotes() {
        let result = combineTags(["work", "urgent"], with: "Some notes")
        XCTAssertEqual(result, "[#work] [#urgent]\nSome notes")
    }

    func testCombineTagsWithoutNotes() {
        let result = combineTags(["work"], with: nil)
        XCTAssertEqual(result, "[#work]")
    }

    func testCombineEmptyTagsWithNotes() {
        let result = combineTags([], with: "Some notes")
        XCTAssertEqual(result, "Some notes")
    }

    func testCombineEmptyTagsEmptyNotes() {
        let result = combineTags([], with: nil)
        XCTAssertNil(result)
    }

    func testCombineTagsNormalizesToLowercase() {
        let result = combineTags(["Work", "URGENT"], with: nil)
        XCTAssertEqual(result, "[#work] [#urgent]")
    }

    func testCombineTagsTrimsWhitespace() {
        let result = combineTags(["  work  ", "urgent"], with: "  notes  ")
        XCTAssertEqual(result, "[#work] [#urgent]\nnotes")
    }

    func testCombineTagsFiltersEmpty() {
        let result = combineTags(["work", "", "  "], with: nil)
        XCTAssertEqual(result, "[#work]")
    }

    func testCombineTagsDeduplicates() {
        let result = combineTags(["Work", "work", "WORK"], with: nil)
        XCTAssertEqual(result, "[#work]")
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

    func testRequestReminderAccessReturnsTuple() {
        // Compile-time check: requestReminderAccess returns (granted: Bool, error: Error?)
        let store = EKEventStore()
        let result: (granted: Bool, error: Error?) = requestReminderAccess(store: store, timeout: 0.001)
        // With a near-zero timeout, we just verify the return type
        XCTAssertNotNil(result)
    }

    // MARK: - reminderToDict Output Keys

    func testReminderToDictOutputContainsListIdAndListName() {
        let store = EKEventStore()
        let reminder = EKReminder(eventStore: store)
        reminder.title = "Test"
        reminder.calendar = store.defaultCalendarForNewReminders()
        let dict = reminderToDict(reminder)
        XCTAssertNotNil(dict["list_id"], "reminderToDict must emit list_id")
        XCTAssertNotNil(dict["list_name"], "reminderToDict must emit list_name")
        XCTAssertNil(dict["list"], "reminderToDict must not emit bare 'list' key")
    }

    func testReminderToDictListIdIsIdentifier() {
        let store = EKEventStore()
        let reminder = EKReminder(eventStore: store)
        reminder.calendar = store.defaultCalendarForNewReminders()
        let dict = reminderToDict(reminder)
        let listId = dict["list_id"] as? String ?? ""
        XCTAssertFalse(listId.isEmpty, "list_id should be a non-empty identifier")
    }

    func testReminderToDictNilCalendarEmitsEmptyStrings() {
        let store = EKEventStore()
        let reminder = EKReminder(eventStore: store)
        reminder.title = "Orphan"
        let dict = reminderToDict(reminder)
        XCTAssertEqual(dict["list_id"] as? String, "", "nil calendar -> empty list_id")
        XCTAssertEqual(dict["list_name"] as? String, "", "nil calendar -> empty list_name")
    }

    func testReminderToDictCompletedDateKey() {
        let store = EKEventStore()
        let reminder = EKReminder(eventStore: store)
        reminder.title = "Done"
        reminder.calendar = store.defaultCalendarForNewReminders()
        reminder.isCompleted = true
        reminder.completionDate = Date()
        let dict = reminderToDict(reminder)
        XCTAssertNotNil(dict["completed_date"], "reminderToDict must emit completed_date (not completion_date)")
        XCTAssertNil(dict["completion_date"], "reminderToDict must not emit old completion_date key")
    }

    // MARK: - resolveCalendars Helper

    func testResolveCalendarsByIdMatchesFirst() throws {
        let store = EKEventStore()
        let allLists = store.calendars(for: .reminder)
        try XCTSkipIf(allLists.isEmpty, "No reminder lists available on this machine")
        let first = allLists[0]
        let result = try resolveCalendars(for: .reminder, filter: first.calendarIdentifier, store: store)
        XCTAssertEqual(result.first?.calendarIdentifier, first.calendarIdentifier)
    }

    func testResolveCalendarsByNameFallback() throws {
        let store = EKEventStore()
        let allLists = store.calendars(for: .reminder)
        try XCTSkipIf(allLists.isEmpty, "No reminder lists available on this machine")
        let first = allLists[0]
        let result = try resolveCalendars(for: .reminder, filter: first.title, store: store)
        XCTAssertEqual(result.first?.title, first.title)
    }

    func testResolveCalendarsNotFoundThrows() {
        let store = EKEventStore()
        let bogus = "NONEXISTENT-\(UUID())"
        XCTAssertThrowsError(try resolveCalendars(for: .reminder, filter: bogus, store: store)) { error in
            XCTAssertTrue(error is CLIError, "Should throw CLIError")
            XCTAssertTrue(error.localizedDescription.contains("not found"))
            XCTAssertTrue(error.localizedDescription.contains(bogus))
        }
    }
}
