import EventKit
import Foundation
import SharedCLI

// File-scope so tests can reach it via @testable import calendar_cli.
struct EventStoreGate: PermissionGate {
    let store: EKEventStore
    func authorizationStatus() -> RawAuthorizationStatus {
        mapEventKitStatusToRaw(EKEventStore.authorizationStatus(for: .event))
    }
    func requestAccess(completion: @escaping (Bool, Error?) -> Void) {
        if #available(macOS 14.0, *) {
            store.requestFullAccessToEvents(completion: completion)
        } else {
            store.requestAccess(to: .event, completion: completion)
        }
    }
}

// MARK: - CLI Entry Point

/// calendar-cli <command> [json-args]
/// Commands: check_permission, list_calendars, list_events, get_event, create_event, update_event, delete_event
@main
struct CalendarCLI {
    static let commandList =
        "check_permission, list_calendars, list_events, get_event, create_event, update_event, delete_event"

    static func main() {
        // Shared store for access guard and handlers; check_permission uses its own gate.
        let store = EKEventStore()
        runCLI(
            cliName: "calendar-cli",
            commandList: commandList,
            entity: .calendar,
            checkPermissionGate: { _ in EventStoreGate(store: EKEventStore()) },
            accessGuard: {
                let (granted, error) = requestCalendarAccess(store: store)
                guard granted else {
                    let msg = error?.localizedDescription ?? "Unknown error"
                    return "Calendar access denied: \(msg)\nGrant access in System Settings > Privacy & Security > Calendars"
                }
                return nil
            },
            commands: [
                "list_calendars": { _ in try listCalendars(store: store) },
                "list_events": { try listEvents(store: store, params: $0) },
                "get_event": { try getEvent(store: store, params: $0) },
                "create_event": { try createEvent(store: store, params: $0) },
                "update_event": { try updateEvent(store: store, params: $0) },
                "delete_event": { try deleteEvent(store: store, params: $0) },
            ]
        )
    }
}

// MARK: - Permission Helpers

/// Requests Calendar access from EventKit. Uses the macOS 14+ full-access API
/// when available, falling back to the legacy requestAccess(to:) API.
/// The optional timeout (default: unbounded) is a safety net for check_permission.
func requestCalendarAccess(store: EKEventStore, timeout: TimeInterval? = nil) -> (granted: Bool, error: Error?) {
    let semaphore = DispatchSemaphore(value: 0)
    var accessGranted = false
    var accessError: Error?

    if #available(macOS 14.0, *) {
        store.requestFullAccessToEvents { granted, error in
            accessGranted = granted
            accessError = error
            semaphore.signal()
        }
    } else {
        store.requestAccess(to: .event) { granted, error in
            accessGranted = granted
            accessError = error
            semaphore.signal()
        }
    }

    if let timeout = timeout {
        let result = semaphore.wait(timeout: .now() + timeout)
        if result == .timedOut {
            return (false, NSError(domain: "CalendarCLI", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "Permission dialog timed out after \(Int(timeout))s",
            ]))
        }
    } else {
        semaphore.wait()
    }

    return (accessGranted, accessError)
}

// MARK: - Commands

func listCalendars(store: EKEventStore) throws -> [String: Any] {
    let calendars = store.calendars(for: .event)
    let list: [[String: Any]] = calendars.map { cal in
        [
            "id": cal.calendarIdentifier,
            "name": cal.title,
            "type": calendarTypeString(cal.type),
            "color": cal.cgColor.flatMap { hexColor(from: $0) } ?? "#000000",
            "allows_modifications": cal.allowsContentModifications,
        ]
    }
    return ["calendars": list]
}

func listEvents(store: EKEventStore, params: [String: Any]) throws -> [String: Any] {
    let limit = params["limit"] as? Int ?? 20

    let now = Date()
    let defaultEnd = Calendar.current.date(byAdding: .day, value: 7, to: now)!

    let startDate: Date
    if let startStr = params["start"] as? String {
        guard let date = parseISO8601(startStr) else {
            throw CLIError.invalidDate(startStr)
        }
        startDate = date
    } else {
        startDate = now
    }

    let endDate: Date
    if let endStr = params["end"] as? String {
        guard let date = parseISO8601(endStr) else {
            throw CLIError.invalidDate(endStr)
        }
        endDate = date
    } else {
        endDate = defaultEnd
    }

    var calendars: [EKCalendar]?
    if let filter = params["calendar_id"] as? String {
        calendars = try resolveCalendars(for: .event, filter: filter, store: store)
    }

    let predicate = store.predicateForEvents(withStart: startDate, end: endDate, calendars: calendars)
    let events = store.events(matching: predicate)
        .prefix(limit)
        .map { eventToDict($0) }

    return ["events": Array(events)]
}

func getEvent(store: EKEventStore, params: [String: Any]) throws -> [String: Any] {
    guard let id = params["id"] as? String else {
        throw CLIError.missingField("id")
    }

    guard let event = store.calendarItem(withIdentifier: id) as? EKEvent else {
        throw CLIError.notFound("Event with id '\(id)' not found")
    }

    return eventToDict(event)
}

func createEvent(store: EKEventStore, params: [String: Any]) throws -> [String: Any] {
    guard let summary = params["summary"] as? String else {
        throw CLIError.missingField("summary")
    }
    guard let startStr = params["start"] as? String else {
        throw CLIError.missingField("start")
    }
    guard let endStr = params["end"] as? String else {
        throw CLIError.missingField("end")
    }

    guard let startDate = parseISO8601(startStr) else {
        throw CLIError.invalidDate(startStr)
    }
    guard let endDate = parseISO8601(endStr) else {
        throw CLIError.invalidDate(endStr)
    }

    let event = EKEvent(eventStore: store)
    event.title = summary
    event.startDate = startDate
    event.endDate = endDate

    if let filter = params["calendar_id"] as? String {
        let matches = try resolveCalendars(for: .event, filter: filter, store: store)
        event.calendar = matches[0]
    } else {
        event.calendar = store.defaultCalendarForNewEvents
    }

    if let location = params["location"] as? String {
        event.location = location
    }

    if let description = params["description"] as? String {
        event.notes = description
    }

    if let allDay = params["all_day"] as? Bool {
        event.isAllDay = allDay
    }

    try store.save(event, span: .thisEvent)

    return [
        "id": event.calendarItemIdentifier,
        "status": "created",
    ]
}

func updateEvent(store: EKEventStore, params: [String: Any]) throws -> [String: Any] {
    guard let id = params["id"] as? String else {
        throw CLIError.missingField("id")
    }

    guard let event = store.calendarItem(withIdentifier: id) as? EKEvent else {
        throw CLIError.notFound("Event with id '\(id)' not found")
    }

    if let summary = params["summary"] as? String {
        event.title = summary
    }

    if let startStr = params["start"] as? String {
        guard let date = parseISO8601(startStr) else {
            throw CLIError.invalidDate(startStr)
        }
        event.startDate = date
    }

    if let endStr = params["end"] as? String {
        guard let date = parseISO8601(endStr) else {
            throw CLIError.invalidDate(endStr)
        }
        event.endDate = date
    }

    if let location = params["location"] as? String {
        event.location = location
    }

    if let description = params["description"] as? String {
        event.notes = description
    }

    if let allDay = params["all_day"] as? Bool {
        event.isAllDay = allDay
    }

    try store.save(event, span: .thisEvent)

    return ["status": "updated"]
}

func deleteEvent(store: EKEventStore, params: [String: Any]) throws -> [String: Any] {
    guard let id = params["id"] as? String else {
        throw CLIError.missingField("id")
    }

    guard let event = store.calendarItem(withIdentifier: id) as? EKEvent else {
        throw CLIError.notFound("Event with id '\(id)' not found")
    }

    try store.remove(event, span: .thisEvent)

    return ["status": "deleted"]
}

// MARK: - Helpers

func eventToDict(_ e: EKEvent) -> [String: Any] {
    var dict: [String: Any] = [
        "id": e.calendarItemIdentifier,
        "summary": e.title ?? "",
        "start": iso8601String(from: e.startDate),
        "end": iso8601String(from: e.endDate),
        "all_day": e.isAllDay,
        "calendar_id": e.calendar?.calendarIdentifier ?? "",
        "calendar_name": e.calendar?.title ?? "",
    ]

    if let location = e.location, !location.isEmpty {
        dict["location"] = location
    }

    if let notes = e.notes, !notes.isEmpty {
        dict["notes"] = notes
    }

    if let url = e.url {
        dict["url"] = url.absoluteString
    }

    return dict
}

func calendarTypeString(_ type: EKCalendarType) -> String {
    switch type {
    case .local: return "local"
    case .calDAV: return "caldav"
    case .exchange: return "exchange"
    case .subscription: return "subscription"
    case .birthday: return "birthday"
    @unknown default: return "unknown"
    }
}

