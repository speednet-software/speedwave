import EventKit
import SharedCLI
import XCTest
@testable import reminders_cli

final class RemindersTests: XCTestCase {
    private let warsaw = TimeZone(identifier: "Europe/Warsaw")!
    private let newYork = TimeZone(identifier: "America/New_York")!

    private func wallClock(_ c: DateComponents) -> [Int?] {
        [c.year, c.month, c.day, c.hour, c.minute, c.second]
    }


    func testCommandListAdvertisesAllCommands() {
        for cmd in ["check_permission", "list_lists", "list_reminders",
                    "get_reminder", "create_reminder", "update_reminder", "complete_reminder", "delete_reminder",
                    "create_list", "update_list", "delete_list"] {
            XCTAssertTrue(RemindersCLI.commandList.contains(cmd),
                          "commandList must advertise '\(cmd)'")
        }
    }

    func testTagRegexCompilesAndMatches() {
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

    func testEmptyParamsDefaultToFiftyAndDueDateSort() throws {
        let query = try parseListQuery([:])
        XCTAssertEqual(query.limit, 50)
        XCTAssertEqual(query.sort, .dueDate)
        XCTAssertFalse(query.overdue)
        XCTAssertFalse(query.hasDueRange)
        XCTAssertNil(query.search)
    }

    private let now = parseISO8601("2026-06-15T12:00:00+02:00")!

    private func reminder(
        _ title: String, due: String? = nil, notes: String? = nil, completed: Bool = false
    ) throws -> EKReminder {
        let item = EKReminder(eventStore: EKEventStore())
        item.title = title
        item.notes = notes
        item.isCompleted = completed
        if let due { item.dueDateComponents = try XCTUnwrap(dueDateComponents(from: due, timeZone: warsaw)) }
        return item
    }

    private func titles(_ query: ListQuery, _ reminders: [EKReminder]) -> [String] {
        applyListQuery(query, to: reminders).map { $0.title ?? "" }
    }

    private func query(_ params: [String: Any]) throws -> ListQuery {
        try parseListQuery(params, now: now, timeZone: warsaw)
    }

    func testParseListQueryReadsEveryParameter() throws {
        let parsed = try query([
            "limit": 5, "overdue": true, "search": "faktura", "sort": "name",
            "due_from": "2026-06-15", "due_to": "2026-06-15",
        ])
        XCTAssertEqual(parsed.limit, 5)
        XCTAssertTrue(parsed.overdue)
        XCTAssertEqual(parsed.search, "faktura")
        XCTAssertEqual(parsed.sort, .name)
        XCTAssertEqual(parsed.dueFrom, parseISO8601("2026-06-14T22:00:00Z"))
        XCTAssertEqual(parsed.dueTo, parseISO8601("2026-06-15T22:00:00Z"))
    }

    func testParseListQueryTimedDueToIsIncludedItself() throws {
        let parsed = try query(["due_to": "2026-06-15T10:00:00"])
        let end = try XCTUnwrap(parsed.dueTo)
        let at = try XCTUnwrap(parseISO8601("2026-06-15T10:00:00+02:00"))
        XCTAssertGreaterThan(end, at)
        XCTAssertLessThan(end.timeIntervalSince(at), 0.001)
    }

    func testParseListQueryOffsetKeepsTheInstant() throws {
        let parsed = try query(["due_from": "2026-06-15T10:00:00Z"])
        XCTAssertEqual(parsed.dueFrom, parseISO8601("2026-06-15T10:00:00Z"))
    }

    func testParseListQueryRejectsBadDatesAndSort() {
        for key in ["due_from", "due_to"] {
            XCTAssertThrowsError(try query([key: "2026-02-30"])) { error in
                guard case CLIError.invalidDate("2026-02-30") = error else { return XCTFail("unexpected \(error)") }
            }
        }
        XCTAssertThrowsError(try query(["sort": "priority"])) { error in
            guard case CLIError.invalidValue(let message) = error else { return XCTFail("unexpected \(error)") }
            XCTAssertTrue(message.contains("priority"), message)
        }
    }

    func testPredicateBoundsAreWidenedByADayAndOverdueEndsAtNow() throws {
        let none = try query([:])
        XCTAssertNil(none.predicateStart)
        XCTAssertNil(none.predicateEnd)
        XCTAssertEqual(try query(["due_from": "2026-06-15"]).predicateStart, parseISO8601("2026-06-13T22:00:00Z"))
        XCTAssertEqual(try query(["due_to": "2030-01-01"]).predicateEnd, parseISO8601("2030-01-02T23:00:00Z"))
        XCTAssertEqual(try query(["overdue": true]).predicateEnd, parseISO8601("2026-06-16T10:00:00Z"))
        XCTAssertEqual(
            try query(["overdue": true, "due_to": "2030-01-01"]).predicateEnd, parseISO8601("2026-06-16T10:00:00Z")
        )
        XCTAssertEqual(
            try query(["overdue": true, "due_to": "2020-01-01"]).predicateEnd, parseISO8601("2020-01-02T23:00:00Z")
        )
    }

    func testAnAllDayReminderMatchesItsOwnDayRange() throws {
        let items = [
            try reminder("on the day", due: "2026-06-15"),
            try reminder("day before", due: "2026-06-14"),
            try reminder("day after", due: "2026-06-16"),
            try reminder("undated"),
        ]
        XCTAssertEqual(titles(try query(["due_from": "2026-06-15", "due_to": "2026-06-15"]), items), ["on the day"])
    }

    func testDueRangeBoundsForTimedReminders() throws {
        let items = [
            try reminder("early", due: "2026-06-15T08:00:00"),
            try reminder("at end", due: "2026-06-15T10:00:00"),
            try reminder("late", due: "2026-06-15T10:00:01"),
        ]
        XCTAssertEqual(titles(try query(["due_to": "2026-06-15T10:00:00"]), items), ["early", "at end"])
        XCTAssertEqual(titles(try query(["due_from": "2026-06-15T10:00:00"]), items), ["at end", "late"])
    }

    func testNoRangeKeepsUndatedAndAnyRangeDropsThem() throws {
        let items = [try reminder("dated", due: "2026-06-15"), try reminder("undated")]
        XCTAssertEqual(Set(titles(try query([:]), items)), ["dated", "undated"])
        XCTAssertEqual(titles(try query(["due_to": "2030-01-01"]), items), ["dated"])
        XCTAssertEqual(titles(try query(["due_from": "2000-01-01"]), items), ["dated"])
    }

    func testRangeAppliesToCompletedRemindersByTheirDueDate() throws {
        let items = [
            try reminder("done in range", due: "2026-06-15", completed: true),
            try reminder("done out of range", due: "2026-01-01", completed: true),
        ]
        XCTAssertEqual(titles(try query(["due_from": "2026-06-01", "due_to": "2026-06-30"]), items), ["done in range"])
    }

    func testOverdueKeepsOnlyIncompleteRemindersPastDue() throws {
        let items = [
            try reminder("timed past", due: "2026-06-15T09:00:00"),
            try reminder("timed future", due: "2026-06-15T13:00:00"),
            try reminder("all-day yesterday", due: "2026-06-14"),
            try reminder("all-day today", due: "2026-06-15"),
            try reminder("completed past", due: "2026-06-10", completed: true),
            try reminder("undated"),
        ]
        XCTAssertEqual(titles(try query(["overdue": true]), items), ["all-day yesterday", "timed past"])
    }

    func testOverdueIntersectsWithTheDueRange() throws {
        let items = [
            try reminder("old", due: "2026-06-01"),
            try reminder("recent", due: "2026-06-14"),
        ]
        XCTAssertEqual(titles(try query(["overdue": true, "due_from": "2026-06-10"]), items), ["recent"])
    }

    func testDueWindowOfAllDayReminderSpansItsLocalDay() throws {
        let window = try XCTUnwrap(dueWindow(of: reminder("x", due: "2026-06-15"), timeZone: warsaw))
        XCTAssertEqual(window.start, parseISO8601("2026-06-14T22:00:00Z"))
        XCTAssertEqual(window.end, parseISO8601("2026-06-15T22:00:00Z"))
    }

    func testDueWindowOfTimedReminderIsItsMomentAndUndatedIsNil() throws {
        let window = try XCTUnwrap(dueWindow(of: reminder("x", due: "2026-06-15T09:30:00"), timeZone: warsaw))
        XCTAssertEqual(window.start, parseISO8601("2026-06-15T07:30:00Z"))
        XCTAssertEqual(window.end, window.start)
        XCTAssertNil(dueWindow(of: try reminder("x"), timeZone: warsaw))
    }

    func testSearchFoldsCaseAndDiacriticsInNameAndNotes() throws {
        let items = [
            try reminder("FAKTURA za maj"),
            try reminder("Faktúra"),
            try reminder("Zapłać", notes: "[#fin]\nfaktura od Żabki"),
            try reminder("Other", notes: "nothing here"),
        ]
        XCTAssertEqual(
            Set(titles(try query(["search": "faktura"]), items)), ["FAKTURA za maj", "Faktúra", "Zapłać"]
        )
        XCTAssertEqual(titles(try query(["search": "FAKTÚRA"]), items).count, 3)
        XCTAssertEqual(titles(try query(["search": "zabki"]), items), ["Zapłać"])
    }

    func testSearchDoesNotMatchTagMarkers() throws {
        let items = [try reminder("Pay", notes: "[#invoice]\nrent")]
        XCTAssertEqual(titles(try query(["search": "invoice"]), items), [])
        XCTAssertEqual(titles(try query(["search": "rent"]), items), ["Pay"])
    }

    func testDefaultSortIsDueAscendingWithUndatedLast() throws {
        let items = [
            try reminder("undated"),
            try reminder("later", due: "2026-07-01T09:00:00"),
            try reminder("all-day", due: "2026-06-20"),
            try reminder("sooner", due: "2026-06-16T09:00:00"),
        ]
        XCTAssertEqual(titles(try query([:]), items), ["sooner", "all-day", "later", "undated"])
    }

    func testSortByNameIsAlphabeticalAndLocaleAware() throws {
        let items = [try reminder("Zebra"), try reminder("Ćma"), try reminder("apple"), try reminder("Banana")]
        XCTAssertEqual(titles(try query(["sort": "name"]), items), ["apple", "Banana", "Ćma", "Zebra"])
    }

    func testEqualKeysFallBackToNameForADeterministicOrder() throws {
        let items = [try reminder("b", due: "2026-06-20"), try reminder("a", due: "2026-06-20")]
        XCTAssertEqual(titles(try query([:]), items), ["a", "b"])
    }

    func testSortByCreatedIsAscendingWithMissingLast() throws {
        let items = [try reminder("none"), try reminder("new"), try reminder("old")]
        let created: [String: Date] = [
            "new": Date(timeIntervalSince1970: 2_000), "old": Date(timeIntervalSince1970: 1_000),
        ]
        let sorted = sortReminders(items, by: .created, creationDate: { created[$0.title ?? ""] })
        XCTAssertEqual(sorted.map { $0.title ?? "" }, ["old", "new", "none"])
    }

    func testListResponseReportsTotalAndTruncatedWhenTheLimitCuts() throws {
        let items = [try reminder("a"), try reminder("b"), try reminder("c")]
        let cut = listResponse(items, limit: 2)
        XCTAssertEqual((cut["reminders"] as? [[String: Any]])?.map { $0["name"] as? String }, ["a", "b"])
        XCTAssertEqual(cut["total"] as? Int, 3)
        XCTAssertEqual(cut["truncated"] as? Bool, true)
    }

    func testListResponseIsNotTruncatedWhenEverythingFits() throws {
        let items = [try reminder("a"), try reminder("b")]
        for limit in [2, 50] {
            let whole = listResponse(items, limit: limit)
            XCTAssertEqual((whole["reminders"] as? [[String: Any]])?.count, 2)
            XCTAssertEqual(whole["total"] as? Int, 2)
            XCTAssertEqual(whole["truncated"] as? Bool, false)
        }
    }

    private func typoReminder(_ store: EKEventStore) throws -> EKReminder {
        let reminder = EKReminder(eventStore: store)
        reminder.title = "KAcper chce na uop"
        reminder.dueDateComponents = try XCTUnwrap(dueDateComponents(from: "2026-07-01T10:00:00"))
        reminder.priority = 5
        reminder.notes = "[#hr]\nAsk about the start date"
        return reminder
    }

    func testUpdateReminderWithoutIdIsAMissingField() {
        XCTAssertThrowsError(try updateReminder(store: EKEventStore(), params: [:])) { error in
            guard case CLIError.missingField("id") = error else { return XCTFail("unexpected \(error)") }
        }
    }

    func testUpdateReminderWithUnknownIdIsNotFoundInsteadOfSilentSuccess() {
        let params: [String: Any] = ["id": "speedwave-test-no-such-reminder", "name": "x"]
        XCTAssertThrowsError(try updateReminder(store: EKEventStore(), params: params)) { error in
            guard case CLIError.notFound(let message) = error else { return XCTFail("unexpected \(error)") }
            XCTAssertTrue(message.contains("speedwave-test-no-such-reminder"), message)
        }
    }

    func testDeleteReminderWithoutIdIsAMissingField() {
        XCTAssertThrowsError(try deleteReminder(store: EKEventStore(), params: [:])) { error in
            guard case CLIError.missingField("id") = error else { return XCTFail("unexpected \(error)") }
        }
    }

    func testDeleteReminderWithUnknownIdIsNotFoundInsteadOfSilentSuccess() {
        let params: [String: Any] = ["id": "speedwave-test-no-such-reminder"]
        XCTAssertThrowsError(try deleteReminder(store: EKEventStore(), params: params)) { error in
            guard case CLIError.notFound(let message) = error else { return XCTFail("unexpected \(error)") }
            XCTAssertTrue(message.contains("speedwave-test-no-such-reminder"), message)
        }
    }

    func testCreateListWithoutNameIsAMissingField() {
        for params in [[:], ["name": ""], ["name": "  "]] as [[String: Any]] {
            XCTAssertThrowsError(try createList(store: EKEventStore(), params: params)) { error in
                guard case CLIError.missingField("name") = error else { return XCTFail("unexpected \(error)") }
            }
        }
    }

    func testCreateListWithMalformedColorIsRejectedBeforeAnythingIsSaved() {
        let params: [String: Any] = ["name": "Home", "color": "green"]
        XCTAssertThrowsError(try createList(store: EKEventStore(), params: params)) { error in
            guard case CLIError.invalidValue(let message) = error else { return XCTFail("unexpected \(error)") }
            XCTAssertTrue(message.contains("#RRGGBB"), message)
        }
    }

    func testUpdateListWithoutListIdIsAMissingField() {
        XCTAssertThrowsError(try updateList(store: EKEventStore(), params: ["name": "x"])) { error in
            guard case CLIError.missingField("list_id") = error else { return XCTFail("unexpected \(error)") }
        }
    }

    func testUpdateListWithNothingToChangeIsAMissingField() {
        XCTAssertThrowsError(try updateList(store: EKEventStore(), params: ["list_id": "x"])) { error in
            guard case CLIError.missingField("name or color") = error else { return XCTFail("unexpected \(error)") }
        }
    }

    func testUpdateListWithBlankNameIsAMissingField() {
        let params: [String: Any] = ["list_id": "x", "name": " "]
        XCTAssertThrowsError(try updateList(store: EKEventStore(), params: params)) { error in
            guard case CLIError.missingField("name") = error else { return XCTFail("unexpected \(error)") }
        }
    }

    func testUpdateListWithUnknownListIsNotFound() {
        let params: [String: Any] = ["list_id": "speedwave-test-no-such-list", "name": "x"]
        XCTAssertThrowsError(try updateList(store: EKEventStore(), params: params)) { error in
            guard case CLIError.notFound(let message) = error else { return XCTFail("unexpected \(error)") }
            XCTAssertTrue(message.contains("speedwave-test-no-such-list"), message)
        }
    }

    func testDeleteListWithoutListIdIsAMissingField() {
        XCTAssertThrowsError(try deleteList(store: EKEventStore(), params: [:])) { error in
            guard case CLIError.missingField("list_id") = error else { return XCTFail("unexpected \(error)") }
        }
    }

    func testDeleteListWithUnknownListIsNotFound() {
        let params: [String: Any] = ["list_id": "speedwave-test-no-such-list", "force": true]
        XCTAssertThrowsError(try deleteList(store: EKEventStore(), params: params)) { error in
            guard case CLIError.notFound(let message) = error else { return XCTFail("unexpected \(error)") }
            XCTAssertTrue(message.contains("speedwave-test-no-such-list"), message)
        }
    }

    func testNonEmptyListMessageGivesTheReminderCountAndNamesForce() {
        XCTAssertEqual(
            nonEmptyListMessage(name: "Work", reminderCount: 3),
            "Reminder list 'Work' still holds 3 reminders. "
                + "Pass force: true to delete the list together with its reminders; this cannot be undone"
        )
    }

    func testNonEmptyListMessageUsesTheSingularForOneReminder() {
        XCTAssertTrue(nonEmptyListMessage(name: "Work", reminderCount: 1).contains("holds 1 reminder."))
    }

    func testListWriteBlockerRefusesReadOnlyAndImmutableLists() {
        let expected = "Reminder list 'Siri' is read-only and cannot be changed or deleted"
        XCTAssertEqual(
            listWriteBlocker(name: "Siri", allowsContentModifications: false, isImmutable: false), expected)
        XCTAssertEqual(
            listWriteBlocker(name: "Siri", allowsContentModifications: true, isImmutable: true), expected)
    }

    func testListWriteBlockerAllowsAWritableList() {
        XCTAssertNil(listWriteBlocker(name: "Work", allowsContentModifications: true, isImmutable: false))
    }

    func testListColorParsesTheFormatListReminderListsReturns() throws {
        let color = try XCTUnwrap(try listColor(["color": "#34c759"]))
        XCTAssertEqual(hexColor(from: color), "#34c759")
        XCTAssertNil(try listColor([:]))
    }

    func testApplyReminderUpdateWithOnlyNameKeepsEveryOtherField() throws {
        let store = EKEventStore()
        let reminder = try typoReminder(store)
        let dueBefore = reminder.dueDateComponents
        try applyReminderUpdate(["id": "r-1", "name": "Kacper chce na UoP"], to: reminder, store: store)
        XCTAssertEqual(reminder.title, "Kacper chce na UoP")
        XCTAssertEqual(reminder.dueDateComponents, dueBefore)
        XCTAssertEqual(reminder.priority, 5)
        XCTAssertEqual(reminder.notes, "[#hr]\nAsk about the start date")
        XCTAssertFalse(reminder.isCompleted)
    }

    func testApplyReminderUpdateChangesPriorityAndDueDate() throws {
        let store = EKEventStore()
        let reminder = try typoReminder(store)
        try applyReminderUpdate(["id": "r-1", "priority": 1, "due_date": "2026-08-01"], to: reminder, store: store)
        XCTAssertEqual(reminder.priority, 1)
        let due = try XCTUnwrap(reminder.dueDateComponents)
        XCTAssertEqual([due.year, due.month, due.day], [2026, 8, 1])
        XCTAssertTrue(isAllDay(due))
        XCTAssertEqual(reminder.title, "KAcper chce na uop")
    }

    func testApplyReminderUpdateNullDueDateAlsoDropsRecurrence() throws {
        let store = EKEventStore()
        let reminder = try typoReminder(store)
        reminder.addRecurrenceRule(EKRecurrenceRule(recurrenceWith: .weekly, interval: 1, end: nil))
        XCTAssertTrue(reminder.hasRecurrenceRules)
        try applyReminderUpdate(["id": "r-1", "due_date": NSNull()], to: reminder, store: store)
        XCTAssertNil(reminder.dueDateComponents)
        XCTAssertFalse(reminder.hasRecurrenceRules)
        XCTAssertEqual(reminder.title, "KAcper chce na uop")
    }

    func testApplyReminderUpdateRejectsAnImpossibleDueDate() throws {
        let store = EKEventStore()
        let reminder = try typoReminder(store)
        XCTAssertThrowsError(try applyReminderUpdate(["id": "r-1", "due_date": "2026-02-30"], to: reminder, store: store)) { error in
            guard case CLIError.invalidDate("2026-02-30") = error else { return XCTFail("unexpected \(error)") }
        }
    }

    func testApplyReminderUpdateToAnUnknownListIsNotFound() throws {
        let store = EKEventStore()
        let reminder = try typoReminder(store)
        let params: [String: Any] = ["id": "r-1", "list_id": "speedwave-test-no-such-list"]
        XCTAssertThrowsError(try applyReminderUpdate(params, to: reminder, store: store)) { error in
            guard case CLIError.notFound(let message) = error else { return XCTFail("unexpected \(error)") }
            XCTAssertTrue(message.contains("speedwave-test-no-such-list"), message)
        }
    }

    func testApplyReminderUpdateCompletedFalseReopensAndClearsTheCompletionDate() throws {
        let store = EKEventStore()
        let reminder = try typoReminder(store)
        reminder.isCompleted = true
        reminder.completionDate = Date()
        try applyReminderUpdate(["id": "r-1", "completed": false], to: reminder, store: store)
        XCTAssertFalse(reminder.isCompleted)
        XCTAssertNil(reminder.completionDate)
        XCTAssertNil(reminderToDict(reminder)["completed_date"])
    }

    func testApplyReminderUpdateTagsAndNotesEachKeepTheOther() throws {
        let store = EKEventStore()
        let reminder = try typoReminder(store)
        try applyReminderUpdate(["id": "r-1", "tags": ["hr", "urgent"]], to: reminder, store: store)
        XCTAssertEqual(reminder.notes, "[#hr] [#urgent]\nAsk about the start date")
        try applyReminderUpdate(["id": "r-1", "notes": "Start in October"], to: reminder, store: store)
        XCTAssertEqual(reminder.notes, "[#hr] [#urgent]\nStart in October")
        try applyReminderUpdate(["id": "r-1", "tags": [String]()], to: reminder, store: store)
        XCTAssertEqual(reminder.notes, "Start in October")
    }

    func testUpdateReminderJSONNullArrivesAsNSNull() throws {
        let data = "{\"id\": \"r-1\", \"due_date\": null}".data(using: .utf8)!
        let params = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertTrue(params["due_date"] is NSNull)
        XCTAssertNil(params["due_date"] as? String)
        XCTAssertNil(params["name"])
    }


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

    func testDueDateWithOffsetBecomesTheWallClockOfEachZone() throws {
        let inWarsaw = try XCTUnwrap(dueDateComponents(from: "2026-06-15T07:00:00Z", timeZone: warsaw))
        let inNewYork = try XCTUnwrap(dueDateComponents(from: "2026-06-15T07:00:00Z", timeZone: newYork))
        XCTAssertEqual(wallClock(inWarsaw), [2026, 6, 15, 9, 0, 0])
        XCTAssertEqual(wallClock(inNewYork), [2026, 6, 15, 3, 0, 0])
        for c in [inWarsaw, inNewYork] {
            XCTAssertNil(c.timeZone)
            XCTAssertEqual(c.calendar?.identifier, .gregorian)
        }
    }

    func testDueDateWithNumericOffsetCanLandOnThePreviousLocalDay() throws {
        let c = try XCTUnwrap(dueDateComponents(from: "2026-06-15T01:30:00+02:00", timeZone: newYork))
        XCTAssertEqual(wallClock(c), [2026, 6, 14, 19, 30, 0])
    }

    func testDueDateWithoutOffsetIsTheSameWallClockInEveryZone() throws {
        for zone in [warsaw, newYork] {
            let c = try XCTUnwrap(dueDateComponents(from: "2026-06-15T09:30:00", timeZone: zone))
            XCTAssertEqual(wallClock(c), [2026, 6, 15, 9, 30, 0], zone.identifier)
            XCTAssertNil(c.timeZone)
        }
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
        let c = try XCTUnwrap(dueDateComponents(from: "2026-03-29T02:30:00"))
        XCTAssertEqual([c.year, c.month, c.day, c.hour, c.minute, c.second], [2026, 3, 29, 2, 30, 0])
        XCTAssertNil(c.timeZone)
    }


    func testDueDateStringAllDayIsDateOnly() {
        let c = DateComponents(calendar: Calendar(identifier: .gregorian), year: 2026, month: 6, day: 5)
        XCTAssertEqual(dueDateString(from: c), "2026-06-05")
    }

    func testDueDateStringFormatsFloatingTimeInTheGivenZone() throws {
        let c = try XCTUnwrap(dueDateComponents(from: "2026-06-15T09:30:00"))
        XCTAssertEqual(dueDateString(from: c, timeZone: warsaw), "2026-06-15T09:30:00+02:00")
        XCTAssertEqual(dueDateString(from: c, timeZone: newYork), "2026-06-15T09:30:00-04:00")
        XCTAssertEqual(dueDateString(from: c, timeZone: TimeZone(identifier: "UTC")!), "2026-06-15T09:30:00+00:00")
    }

    func testDueDateFormatThenParseIsLosslessForEveryInputShape() throws {
        let inputs = ["2026-06-15", "2026-06-15T09:30:00", "2026-06-15T07:00:00Z", "2026-12-31T23:30:00+02:00"]
        for zone in [warsaw, newYork] {
            for input in inputs {
                let c = try XCTUnwrap(dueDateComponents(from: input, timeZone: zone), input)
                let formatted = try XCTUnwrap(dueDateString(from: c, timeZone: zone), input)
                XCTAssertEqual(
                    dueDateComponents(from: formatted, timeZone: zone), c,
                    "\(input) in \(zone.identifier) via \(formatted)"
                )
            }
        }
    }

    func testDueDateStringPrefersTheZoneStoredOnTheComponents() throws {
        var c = DateComponents(calendar: Calendar(identifier: .gregorian), year: 2026, month: 1, day: 10, hour: 8)
        c.timeZone = newYork
        XCTAssertEqual(dueDateString(from: c, timeZone: warsaw), "2026-01-10T08:00:00-05:00")
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
        let dict = reminderToDict(reminder, timeZone: warsaw)
        XCTAssertEqual(dict["all_day"] as? Bool, false)
        XCTAssertEqual(dict["due_date"] as? String, "2026-07-01T10:00:00+02:00")
    }

    func testReminderToDictWithoutDueDateOmitsAllDay() {
        let store = EKEventStore()
        let reminder = EKReminder(eventStore: store)
        reminder.title = "Someday"
        let dict = reminderToDict(reminder)
        XCTAssertNil(dict["due_date"])
        XCTAssertNil(dict["all_day"])
    }


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

    func testMergeNotesEmptyTagsAloneClearTheTagsAndKeepTheBody() {
        XCTAssertEqual(mergeNotes(existing: "[#work] [#urgent]\nbody", notes: nil, tags: []), "body")
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


    func testRequestReminderAccessReturnsTuple() {
        let store = EKEventStore()
        let result: (granted: Bool, error: Error?) = requestReminderAccess(store: store, timeout: 0.001)
        XCTAssertNotNil(result)
    }


    func testRemindersEventStoreGateConformsToPermissionGate() {
        let store = EKEventStore()
        let gate: PermissionGate = EventStoreGate(store: store)
        let _: RawAuthorizationStatus = gate.authorizationStatus()
    }

    func testRemindersEventStoreGateProducesRawStatus() {
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

    func testReminderToDictCompletedDateIsLocalTimeWithOffset() throws {
        let store = EKEventStore()
        let reminder = EKReminder(eventStore: store)
        reminder.title = "Done"
        reminder.calendar = store.defaultCalendarForNewReminders()
        reminder.isCompleted = true
        reminder.completionDate = try XCTUnwrap(parseISO8601("2026-06-15T07:00:00Z"))
        let inWarsaw = reminderToDict(reminder, timeZone: warsaw)
        XCTAssertEqual(inWarsaw["completed_date"] as? String, "2026-06-15T09:00:00+02:00")
        XCTAssertEqual(reminderToDict(reminder, timeZone: newYork)["completed_date"] as? String, "2026-06-15T03:00:00-04:00")
        XCTAssertNil(inWarsaw["completion_date"], "reminderToDict must not emit old completion_date key")
    }
}
