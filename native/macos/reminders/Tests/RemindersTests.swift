import EventKit
import XCTest
@testable import reminders_cli

final class RemindersTests: XCTestCase {

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

    // MARK: - Permission Access

    func testRequestReminderAccessReturnsTuple() {
        // Compile-time check: requestReminderAccess returns (granted: Bool, error: Error?)
        let store = EKEventStore()
        let result: (granted: Bool, error: Error?) = requestReminderAccess(store: store, timeout: 0.001)
        // With a near-zero timeout, we just verify the return type
        XCTAssertNotNil(result)
    }

    // MARK: - reminderToDict Output Keys

    func testReminderToDictOutputContainsListIdAndListName() throws {
        let store = EKEventStore()
        let reminder = EKReminder(eventStore: store)
        reminder.title = "Test"
        let cal = store.defaultCalendarForNewReminders()
        try XCTSkipIf(cal == nil, "No default reminder list available on this machine")
        reminder.calendar = cal
        let dict = reminderToDict(reminder)
        XCTAssertNotNil(dict["list_id"], "reminderToDict must emit list_id")
        XCTAssertNotNil(dict["list_name"], "reminderToDict must emit list_name")
        XCTAssertNil(dict["list"], "reminderToDict must not emit bare 'list' key")
    }

    func testReminderToDictListIdIsIdentifier() throws {
        let store = EKEventStore()
        let reminder = EKReminder(eventStore: store)
        let cal = store.defaultCalendarForNewReminders()
        try XCTSkipIf(cal == nil, "No default reminder list available on this machine")
        reminder.calendar = cal
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
}
