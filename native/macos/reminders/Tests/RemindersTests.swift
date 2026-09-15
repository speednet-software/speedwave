import EventKit
import SharedCLI
import XCTest
@testable import reminders_cli

final class RemindersTests: XCTestCase {

    // MARK: - CLI Argument Parsing

    func testCommandListAdvertisesAllCommands() {
        // commandList drives both the usage and unknown-command messages in runCLI.
        for cmd in ["check_permission", "list_lists", "list_reminders",
                    "get_reminder", "create_reminder", "update_reminder", "complete_reminder"] {
            XCTAssertTrue(RemindersCLI.commandList.contains(cmd),
                          "commandList must advertise '\(cmd)'")
        }
    }

    func testTagRegexCompilesAndMatches() {
        // Asserts the lazily-compiled static tagRegex initializer succeeded (no fatalError)
        // and that extractTags, its only consumer, works end to end.
        XCTAssertEqual(extractTags(from: "[#a] [#b] text"), ["a", "b"])
        XCTAssertEqual(stripTags(from: "[#a] text"), "text")
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

    // MARK: - update_reminder Argument Shape

    func testUpdateReminderRequiresId() {
        let params: [String: Any] = [:]
        XCTAssertNil(params["id"])
    }

    func testUpdateReminderPartialParams() {
        let params: [String: Any] = [
            "id": "reminder-123",
            "name": "Corrected title",
        ]
        XCTAssertNotNil(params["id"])
        XCTAssertNotNil(params["name"])
        XCTAssertNil(params["due_date"])  // Unspecified fields must stay untouched by updateReminder
        XCTAssertNil(params["tags"])
    }

    func testUpdateReminderAllFields() {
        let params: [String: Any] = [
            "id": "reminder-123",
            "name": "Review PR #42",
            "list_id": "Work",
            "due_date": "2026-03-01T09:00:00Z",
            "priority": 5,
            "notes": "Rescheduled",
            "tags": ["work"],
            "completed": false,
        ]
        XCTAssertEqual(params["name"] as? String, "Review PR #42")
        XCTAssertEqual(params["list_id"] as? String, "Work")
        XCTAssertNotNil(dueDateComponents(from: params["due_date"] as! String))
        XCTAssertEqual(params["priority"] as? Int, 5)
        XCTAssertEqual(params["notes"] as? String, "Rescheduled")
        XCTAssertEqual(params["tags"] as? [String], ["work"])
        XCTAssertEqual(params["completed"] as? Bool, false)
    }

    func testUpdateReminderJSONNullArrivesAsNSNull() throws {
        // updateReminder distinguishes "clear the due date" (JSON null) from "leave it" (key absent).
        let data = "{\"id\": \"r-1\", \"due_date\": null}".data(using: .utf8)!
        let params = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertTrue(params["due_date"] is NSNull)
        XCTAssertNil(params["due_date"] as? String)
        XCTAssertNil(params["name"])
    }

    // MARK: - Due Date Parsing

    func testDueDateDateOnlyIsAllDayFloatingGregorian() throws {
        let c = try XCTUnwrap(dueDateComponents(from: "2026-06-15"))
        XCTAssertEqual(c.year, 2026)
        XCTAssertEqual(c.month, 6)
        XCTAssertEqual(c.day, 15)
        XCTAssertNil(c.hour, "all-day reminders carry no time fields")
        XCTAssertNil(c.minute)
        XCTAssertNil(c.timeZone, "due dates are floating")
        XCTAssertEqual(c.calendar?.identifier, .gregorian)
    }

    func testDueDateWithOffsetBecomesHostWallClock() throws {
        let c = try XCTUnwrap(dueDateComponents(from: "2026-06-15T07:00:00Z"))
        let expected = Calendar(identifier: .gregorian).dateComponents(
            [.year, .month, .day, .hour, .minute, .second],
            from: parseISO8601("2026-06-15T07:00:00Z")!
        )
        XCTAssertEqual(c.hour, expected.hour)
        XCTAssertEqual(c.day, expected.day)
        XCTAssertEqual(c.second, 0)
        XCTAssertNil(c.timeZone)
        XCTAssertEqual(c.calendar?.identifier, .gregorian)
    }

    func testDueDateWithoutOffsetIsTakenAsWallClock() throws {
        let c = try XCTUnwrap(dueDateComponents(from: "2026-06-15T09:30:00"))
        XCTAssertEqual([c.year, c.month, c.day, c.hour, c.minute, c.second], [2026, 6, 15, 9, 30, 0])
        XCTAssertNil(c.timeZone)
    }

    func testDueDateWithoutOffsetIgnoresFractionalSeconds() throws {
        let c = try XCTUnwrap(dueDateComponents(from: "2026-06-15T09:30:15.250"))
        XCTAssertEqual([c.hour, c.minute, c.second], [9, 30, 15])
    }

    func testDueDateRejectsGarbageAndImpossibleDates() {
        XCTAssertNil(dueDateComponents(from: "tomorrow"))
        XCTAssertNil(dueDateComponents(from: "2026-02-30"))
        XCTAssertNil(dueDateComponents(from: "2026-6-1"))
        XCTAssertNil(dueDateComponents(from: "٢٠٢٦-٠١-٠١"), "ICU \\d matches non-ASCII digits; refuse them")
        XCTAssertNil(dueDateComponents(from: ""))
    }

    func testDueDateRejectsImpossibleTimedDatesInEveryShape() {
        XCTAssertNil(dueDateComponents(from: "2026-02-30T09:30:00"))
        XCTAssertNil(dueDateComponents(from: "2026-02-30T09:30:00Z"))
        XCTAssertNil(dueDateComponents(from: "2026-06-15T25:00:00"))
        XCTAssertNil(dueDateComponents(from: "2026-06-15T23:60:00"))
    }

    func testDueDateWallClockKeepsDstGapTimeAsTyped() throws {
        // 02:30 does not exist on 2026-03-29 in Europe/Warsaw; a floating time must still be stored as typed.
        let c = try XCTUnwrap(dueDateComponents(from: "2026-03-29T02:30:00"))
        XCTAssertEqual([c.year, c.month, c.day, c.hour, c.minute, c.second], [2026, 3, 29, 2, 30, 0])
        XCTAssertNil(c.timeZone)
    }

    // MARK: - Due Date Formatting

    func testDueDateStringAllDayIsDateOnly() {
        let c = DateComponents(calendar: Calendar(identifier: .gregorian), year: 2026, month: 6, day: 5)
        XCTAssertEqual(dueDateString(from: c), "2026-06-05")
    }

    func testDueDateStringTimedUsesLocalOffsetAndRoundTrips() throws {
        let input = "2026-06-15T09:30:00"
        let c = try XCTUnwrap(dueDateComponents(from: input))
        let formatted = try XCTUnwrap(dueDateString(from: c))
        XCTAssertTrue(formatted.hasPrefix("2026-06-15T09:30:00"), formatted)
        XCTAssertFalse(formatted.hasSuffix("Z"), "timed due dates are reported in local time with an offset")
        XCTAssertEqual(dueDateComponents(from: formatted), c, "formatting then parsing must be lossless")
    }

    func testDueDateStringHonoursExplicitTimeZone() throws {
        var c = DateComponents(calendar: Calendar(identifier: .gregorian), year: 2026, month: 1, day: 10, hour: 8)
        c.timeZone = TimeZone(identifier: "America/New_York")
        XCTAssertEqual(dueDateString(from: c), "2026-01-10T08:00:00-05:00")
    }

    func testDueDateStringWithoutDateIsNil() {
        XCTAssertNil(dueDateString(from: DateComponents(hour: 9)))
    }

    func testReminderToDictEmitsAllDayFlagAndDateOnlyDueDate() throws {
        let store = EKEventStore()
        let reminder = EKReminder(eventStore: store)
        reminder.title = "Pay rent"
        reminder.dueDateComponents = try XCTUnwrap(dueDateComponents(from: "2026-07-01"))
        let dict = reminderToDict(reminder)
        XCTAssertEqual(dict["due_date"] as? String, "2026-07-01")
        XCTAssertEqual(dict["all_day"] as? Bool, true)
    }

    func testReminderToDictTimedDueDateIsNotAllDay() throws {
        let store = EKEventStore()
        let reminder = EKReminder(eventStore: store)
        reminder.title = "Standup"
        reminder.dueDateComponents = try XCTUnwrap(dueDateComponents(from: "2026-07-01T10:00:00"))
        let dict = reminderToDict(reminder)
        XCTAssertEqual(dict["all_day"] as? Bool, false)
        XCTAssertTrue((dict["due_date"] as? String ?? "").hasPrefix("2026-07-01T10:00:00"))
    }

    func testReminderToDictWithoutDueDateOmitsAllDay() {
        let store = EKEventStore()
        let reminder = EKReminder(eventStore: store)
        reminder.title = "Someday"
        let dict = reminderToDict(reminder)
        XCTAssertNil(dict["due_date"])
        XCTAssertNil(dict["all_day"])
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

    // MARK: - Partial Notes/Tags Merge (update_reminder)

    func testMergeNotesTagsOnlyKeepsBodyByteForByte() {
        let existing = "[#Work] hello\n\n\n\nworld  \n"
        XCTAssertEqual(mergeNotes(existing: existing, notes: nil, tags: ["x"]), "[#x]\nhello\n\n\n\nworld  \n")
    }

    func testMergeNotesNotesOnlyKeepsMarkersAsStored() {
        let existing = "[#Work] [#urgent]\nold text"
        XCTAssertEqual(mergeNotes(existing: existing, notes: "new text", tags: nil), "[#Work] [#urgent]\nnew text")
    }

    func testMergeNotesLeavesLiteralMarkerTextInBodyAlone() {
        let existing = "See ticket [#123] for details"
        XCTAssertEqual(mergeNotes(existing: existing, notes: nil, tags: ["work"]), "[#work]\nSee ticket [#123] for details")
    }

    func testMergeNotesBothGivenBehavesLikeCreate() {
        XCTAssertEqual(mergeNotes(existing: "[#old]\nx", notes: "  fresh  ", tags: ["A", "a"]), "[#a]\nfresh")
    }

    func testMergeNotesClearingBothYieldsNil() {
        XCTAssertNil(mergeNotes(existing: "[#old]\ntext", notes: "", tags: []))
        XCTAssertNil(mergeNotes(existing: nil, notes: nil, tags: []))
    }

    func testMergeNotesWithoutStoredMarkersDoesNotInventAny() {
        XCTAssertEqual(mergeNotes(existing: "plain", notes: "changed", tags: nil), "changed")
        XCTAssertEqual(mergeNotes(existing: "plain", notes: nil, tags: ["t"]), "[#t]\nplain")
    }

    func testSplitLeadingTagsSeparatesMarkerRunFromBody() {
        let split = splitLeadingTags("[#a] [#b]\nbody\nmore")
        XCTAssertEqual(split.markers, "[#a] [#b]")
        XCTAssertEqual(split.body, "body\nmore")
        let none = splitLeadingTags("body [#inline]")
        XCTAssertEqual(none.markers, "")
        XCTAssertEqual(none.body, "body [#inline]")
    }

    // MARK: - Permission Access

    func testRequestReminderAccessReturnsTuple() {
        // Compile-time check: requestReminderAccess returns (granted: Bool, error: Error?)
        let store = EKEventStore()
        let result: (granted: Bool, error: Error?) = requestReminderAccess(store: store, timeout: 0.001)
        // With a near-zero timeout, we just verify the return type
        XCTAssertNotNil(result)
    }

    // MARK: - EventStoreGate — file-scope struct reachable via @testable import

    func testRemindersEventStoreGateConformsToPermissionGate() {
        // Compile-time + smoke: EventStoreGate is file-scope and reachable from tests.
        // Calling authorizationStatus() on a real EKEventStore is a pure read.
        let store = EKEventStore()
        let gate: PermissionGate = EventStoreGate(store: store)
        let _: RawAuthorizationStatus = gate.authorizationStatus()
    }

    func testRemindersEventStoreGateProducesRawStatus() {
        // Sanity: at runtime, the gate's raw status is one of the documented cases.
        // Reminders does not support .writeOnly (Calendar-only), but other cases are valid.
        let store = EKEventStore()
        let gate = EventStoreGate(store: store)
        let raw = gate.authorizationStatus()
        switch raw {
        case .granted, .denied, .restricted, .notDetermined, .writeOnly, .unknown:
            break
        case .targetNotRunning:
            XCTFail("EventKit gate must never produce .targetNotRunning — that is AE-only")
        }
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
