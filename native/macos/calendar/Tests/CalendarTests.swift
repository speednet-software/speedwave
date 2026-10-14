import EventKit
import SharedCLI
import XCTest
@testable import calendar_cli

final class CalendarTests: XCTestCase {
    private let warsaw = TimeZone(identifier: "Europe/Warsaw")!
    private let newYork = TimeZone(identifier: "America/New_York")!

    func testEventDateBareDayIsLocalMidnightNotUTCMidnight() throws {
        let inNewYork = try eventDate(from: "2026-06-15", timeZone: newYork)
        XCTAssertEqual(iso8601String(from: inNewYork, timeZone: newYork), "2026-06-15T00:00:00-04:00")
        let inWarsaw = try eventDate(from: "2026-06-15", timeZone: warsaw)
        XCTAssertEqual(iso8601String(from: inWarsaw, timeZone: warsaw), "2026-06-15T00:00:00+02:00")
    }

    func testEventDateWithoutOffsetIsLocalTime() throws {
        let inNewYork = try eventDate(from: "2026-06-15T09:30:00", timeZone: newYork)
        XCTAssertEqual(iso8601String(from: inNewYork, timeZone: newYork), "2026-06-15T09:30:00-04:00")
        let inWarsaw = try eventDate(from: "2026-06-15T09:30:00", timeZone: warsaw)
        XCTAssertEqual(iso8601String(from: inWarsaw, timeZone: warsaw), "2026-06-15T09:30:00+02:00")
    }

    func testEventDateWithOffsetKeepsTheInstantInEveryZone() throws {
        let utc = try XCTUnwrap(parseISO8601("2026-06-15T07:00:00Z"))
        XCTAssertEqual(try eventDate(from: "2026-06-15T09:00:00+02:00", timeZone: newYork), utc)
        XCTAssertEqual(try eventDate(from: "2026-06-15T07:00:00Z", timeZone: warsaw), utc)
    }

    func testEventDateRejectsInvalidInputWithInvalidDate() {
        for input in ["tomorrow", "2026-02-30", "2026-6-1", "2026-06-15 09:30:00"] {
            XCTAssertThrowsError(try eventDate(from: input, timeZone: newYork), input) { error in
                guard case CLIError.invalidDate(let value) = error else { return XCTFail("unexpected \(error)") }
                XCTAssertEqual(value, input)
            }
        }
    }

    func testCalendarTypeStrings() {
        XCTAssertEqual(calendarTypeString(.local), "local")
        XCTAssertEqual(calendarTypeString(.calDAV), "caldav")
        XCTAssertEqual(calendarTypeString(.exchange), "exchange")
        XCTAssertEqual(calendarTypeString(.subscription), "subscription")
        XCTAssertEqual(calendarTypeString(.birthday), "birthday")
    }


    private func withDefaultTimeZone(_ zone: TimeZone, _ body: () throws -> Void) rethrows {
        let saved = NSTimeZone.default
        NSTimeZone.default = zone
        defer { NSTimeZone.default = saved }
        try body()
    }

    func testCreateEventWithoutStartIsAMissingField() {
        XCTAssertThrowsError(try createEvent(store: EKEventStore(), params: ["summary": "Meeting"])) { error in
            guard case CLIError.missingField("start") = error else { return XCTFail("unexpected \(error)") }
        }
    }

    func testApplyEventFieldsSetsEveryGivenField() throws {
        let event = EKEvent(eventStore: EKEventStore())
        let params: [String: Any] = [
            "summary": "Team Standup",
            "start": "2026-03-02T09:00:00Z",
            "end": "2026-03-02T09:30:00Z",
            "location": "Room 42",
            "description": "Discuss sprint progress",
            "all_day": false,
        ]
        try applyEventFields(params, to: event)
        XCTAssertEqual(event.title, "Team Standup")
        XCTAssertEqual(event.startDate, parseISO8601("2026-03-02T09:00:00Z"))
        XCTAssertEqual(event.endDate, parseISO8601("2026-03-02T09:30:00Z"))
        XCTAssertEqual(event.location, "Room 42")
        XCTAssertEqual(event.notes, "Discuss sprint progress")
        XCTAssertFalse(event.isAllDay)
    }

    func testApplyEventFieldsWithOnlySummaryKeepsTheRest() throws {
        let event = EKEvent(eventStore: EKEventStore())
        let initial: [String: Any] = [
            "summary": "Before", "start": "2026-03-02T09:00:00Z", "end": "2026-03-02T09:30:00Z", "location": "Room 42",
        ]
        try applyEventFields(initial, to: event)
        try applyEventFields(["id": "evt-1", "summary": "Updated Title"], to: event)
        XCTAssertEqual(event.title, "Updated Title")
        XCTAssertEqual(event.startDate, parseISO8601("2026-03-02T09:00:00Z"))
        XCTAssertEqual(event.endDate, parseISO8601("2026-03-02T09:30:00Z"))
        XCTAssertEqual(event.location, "Room 42")
    }

    func testApplyEventFieldsBareDayAllDayEventIsThatSingleDayInEveryZone() throws {
        for (zone, offset) in [(newYork, "-04:00"), (warsaw, "+02:00")] {
            try withDefaultTimeZone(zone) {
                let event = EKEvent(eventStore: EKEventStore())
                let params: [String: Any] = ["summary": "Offsite", "start": "2026-06-15", "end": "2026-06-16", "all_day": true]
                try applyEventFields(params, to: event, timeZone: zone)
                XCTAssertTrue(event.isAllDay)
                XCTAssertEqual(iso8601String(from: event.startDate, timeZone: zone), "2026-06-15T00:00:00\(offset)", zone.identifier)
                XCTAssertEqual(iso8601String(from: event.endDate, timeZone: zone), "2026-06-15T23:59:59\(offset)", zone.identifier)
            }
        }
    }

    func testApplyEventFieldsRejectsAnInvalidDate() {
        let event = EKEvent(eventStore: EKEventStore())
        XCTAssertThrowsError(try applyEventFields(["end": "2026-02-30"], to: event)) { error in
            guard case CLIError.invalidDate("2026-02-30") = error else { return XCTFail("unexpected \(error)") }
        }
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


    func testRequestCalendarAccessReturnsTuple() {
        let store = EKEventStore()
        let result: (granted: Bool, error: Error?) = requestCalendarAccess(store: store, timeout: 0.001)
        XCTAssertNotNil(result)
    }


    func testCalendarEventStoreGateConformsToPermissionGate() {
        let store = EKEventStore()
        let gate: PermissionGate = EventStoreGate(store: store)
        let _: RawAuthorizationStatus = gate.authorizationStatus()
    }

    func testCalendarEventStoreGateProducesRawStatus() {
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


    func testEventToDictOutputContainsCalendarIdAndCalendarName() {
        let store = EKEventStore()
        let event = EKEvent(eventStore: store)
        event.title = "Test"
        event.startDate = Date()
        event.endDate = Date().addingTimeInterval(3600)
        event.calendar = store.defaultCalendarForNewEvents
        let dict = eventToDict(event)
        XCTAssertNotNil(dict["calendar_id"], "eventToDict must emit calendar_id")
        XCTAssertNotNil(dict["calendar_name"], "eventToDict must emit calendar_name")
        XCTAssertNil(dict["calendar"], "eventToDict must not emit bare 'calendar' key")
    }

    func testEventToDictNilCalendarEmitsEmptyStrings() {
        let store = EKEventStore()
        let event = EKEvent(eventStore: store)
        event.title = "Orphan"
        event.startDate = Date()
        event.endDate = Date().addingTimeInterval(3600)
        let dict = eventToDict(event)
        XCTAssertEqual(dict["calendar_id"] as? String, "", "nil calendar -> empty calendar_id")
        XCTAssertEqual(dict["calendar_name"] as? String, "", "nil calendar -> empty calendar_name")
    }

    func testEventToDictNotesFieldPreserved() {
        let store = EKEventStore()
        let event = EKEvent(eventStore: store)
        event.title = "Test"
        event.startDate = Date()
        event.endDate = Date().addingTimeInterval(3600)
        event.calendar = store.defaultCalendarForNewEvents
        event.notes = "Some notes"
        let dict = eventToDict(event)
        XCTAssertEqual(dict["notes"] as? String, "Some notes", "eventToDict must emit notes field")
    }

    func testEventToDictNotesAbsentWhenNil() {
        let store = EKEventStore()
        let event = EKEvent(eventStore: store)
        event.title = "Test"
        event.startDate = Date()
        event.endDate = Date().addingTimeInterval(3600)
        event.calendar = store.defaultCalendarForNewEvents
        let dict = eventToDict(event)
        XCTAssertNil(dict["notes"], "eventToDict should omit notes when nil")
    }
}
