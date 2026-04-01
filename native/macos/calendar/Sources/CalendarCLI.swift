import EventKit
import Foundation

// MARK: - CLI Entry Point

/// calendar-cli <command> [json-args]
/// Commands: check_permission, list_calendars, list_events, get_event, create_event, update_event, delete_event
@main
struct CalendarCLI {
    static func main() {
        let args = CommandLine.arguments
        guard args.count >= 2 else {
            exitWithError("Usage: calendar-cli <command> [json-args]\nCommands: check_permission, list_calendars, list_events, get_event, create_event, update_event, delete_event")
        }

        let command = args[1]

        // check_permission: verify macOS TCC access without performing any operation.
        // Returns JSON {"granted": true/false} on stdout, always exits 0.
        // Pattern: see also reminders/Sources/RemindersCLI.swift check_permission
        if command == "check_permission" {
            let store = EKEventStore()
            let (granted, error) = requestCalendarAccess(store: store, timeout: 65)
            if granted {
                print(formatPermissionResult(granted: true, error: nil))
            } else {
                let msg = error?.localizedDescription ?? "Unknown error"
                let detail = "Calendar access denied: \(msg)\nGrant access in System Settings > Privacy & Security > Calendars"
                print(formatPermissionResult(granted: false, error: detail))
            }
            return
        }

        let jsonArgs = args.count >= 3 ? args[2] : "{}"

        guard let argsData = jsonArgs.data(using: .utf8),
              let params = try? JSONSerialization.jsonObject(with: argsData) as? [String: Any]
        else {
            exitWithError("Invalid JSON arguments: \(jsonArgs)")
        }

        let store = EKEventStore()
        let (accessGranted, accessError) = requestCalendarAccess(store: store)

        guard accessGranted else {
            let msg = accessError?.localizedDescription ?? "Unknown error"
            exitWithError("Calendar access denied: \(msg)\nGrant access in System Settings > Privacy & Security > Calendars")
        }

        do {
            let result: Any
            switch command {
            case "list_calendars":
                result = try listCalendars(store: store)
            case "list_events":
                result = try listEvents(store: store, params: params)
            case "get_event":
                result = try getEvent(store: store, params: params)
            case "create_event":
                result = try createEvent(store: store, params: params)
            case "update_event":
                result = try updateEvent(store: store, params: params)
            case "delete_event":
                result = try deleteEvent(store: store, params: params)
            default:
                exitWithError("Unknown command: \(command)\nAvailable: check_permission, list_calendars, list_events, get_event, create_event, update_event, delete_event")
            }

            let data = try JSONSerialization.data(
                withJSONObject: result,
                options: [.prettyPrinted, .sortedKeys]
            )
            if let json = String(data: data, encoding: .utf8) {
                print(json)
            }
        } catch {
            exitWithError(error.localizedDescription)
        }
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

/// Serializes a permission check result as JSON.
/// Output contract: {"granted": true} or {"granted": false, "error": "..."}
// SYNC: formatPermissionResult must match reminders/Sources/RemindersCLI.swift
func formatPermissionResult(granted: Bool, error: String?) -> String {
    var dict: [String: Any] = ["granted": granted]
    if let error = error {
        dict["error"] = error
    }
    guard let data = try? JSONSerialization.data(withJSONObject: dict, options: [.sortedKeys]),
          let json = String(data: data, encoding: .utf8) else {
        return #"{"granted": false, "error": "Failed to serialize permission result"}"#
    }
    return json
}

// MARK: - Calendar Resolution

/// Resolves calendars by ID first, falling back to name match.
/// Returns all matches — caller decides usage (filter predicate vs single pick).
/// If multiple calendars share the same name, all are returned; createEvent uses [0].
/// Throws CLIError.notFound if filter matches nothing.
func resolveCalendars(
    for entityType: EKEntityType,
    filter: String,
    store: EKEventStore
) throws -> [EKCalendar] {
    let all = store.calendars(for: entityType)
    let byId = all.filter { $0.calendarIdentifier == filter }
    if !byId.isEmpty { return byId }
    let byName = all.filter { $0.title == filter }
    if !byName.isEmpty { return byName }
    let label = entityType == .reminder ? "Reminder list" : "Calendar"
    throw CLIError.notFound("\(label) '\(filter)' not found")
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

func parseISO8601(_ string: String) -> Date? {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = formatter.date(from: string) {
        return date
    }
    formatter.formatOptions = [.withInternetDateTime]
    if let date = formatter.date(from: string) {
        return date
    }
    formatter.formatOptions = [.withFullDate]
    return formatter.date(from: string)
}

func iso8601String(from date: Date) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime]
    return formatter.string(from: date)
}

func hexColor(from cgColor: CGColor) -> String? {
    guard let components = cgColor.components, components.count >= 3 else {
        return nil
    }
    let r = Int(components[0] * 255)
    let g = Int(components[1] * 255)
    let b = Int(components[2] * 255)
    return String(format: "#%02x%02x%02x", r, g, b)
}

// MARK: - Error Handling

enum CLIError: LocalizedError {
    case missingField(String)
    case notFound(String)
    case invalidDate(String)

    var errorDescription: String? {
        switch self {
        case .missingField(let field):
            return "Missing required field: \(field)"
        case .notFound(let msg):
            return msg
        case .invalidDate(let date):
            return "Invalid ISO8601 date: \(date). Expected format: 2025-03-01T10:00:00Z"
        }
    }
}

func exitWithError(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}
