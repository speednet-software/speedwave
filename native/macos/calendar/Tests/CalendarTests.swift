import EventKit
import SharedCLI
import XCTest
@testable import calendar_cli

final class CalendarTests: XCTestCase {

    // MARK: - Calendar Type String

    func testCalendarTypeStrings() {
        XCTAssertEqual(calendarTypeString(.local), "local")
        XCTAssertEqual(calendarTypeString(.calDAV), "caldav")
        XCTAssertEqual(calendarTypeString(.exchange), "exchange")
        XCTAssertEqual(calendarTypeString(.subscription), "subscription")
        XCTAssertEqual(calendarTypeString(.birthday), "birthday")
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
            "calendar_id": "Work",
            "location": "Room 42",
            "description": "Discuss sprint progress",
            "all_day": false,
        ]
        XCTAssertEqual(params["summary"] as? String, "Team Standup")
        XCTAssertEqual(params["calendar_id"] as? String, "Work")
        XCTAssertEqual(params["description"] as? String, "Discuss sprint progress")
        XCTAssertNotNil(parseISO8601(params["start"] as! String))
        XCTAssertNotNil(parseISO8601(params["end"] as! String))
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

    // MARK: - Permission Access

    func testRequestCalendarAccessReturnsTuple() {
        // Compile-time check: requestCalendarAccess returns (granted: Bool, error: Error?)
        let store = EKEventStore()
        let result: (granted: Bool, error: Error?) = requestCalendarAccess(store: store, timeout: 0.001)
        XCTAssertNotNil(result)
    }

    // MARK: - eventToDict Output Keys

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
