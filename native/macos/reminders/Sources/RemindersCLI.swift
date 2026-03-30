import EventKit
import Foundation

// MARK: - CLI Entry Point

/// reminders-cli <command> [json-args]
/// Commands: list_lists, list_reminders, get_reminder, create_reminder, complete_reminder
@main
struct RemindersCLI {
    static func main() {
        let args = CommandLine.arguments
        guard args.count >= 2 else {
            exitWithError("Usage: reminders-cli <command> [json-args]\nCommands: list_lists, list_reminders, get_reminder, create_reminder, complete_reminder")
        }

        let command = args[1]
        let jsonArgs = args.count >= 3 ? args[2] : "{}"

        guard let argsData = jsonArgs.data(using: .utf8),
              let params = try? JSONSerialization.jsonObject(with: argsData) as? [String: Any]
        else {
            exitWithError("Invalid JSON arguments: \(jsonArgs)")
        }

        let store = EKEventStore()

        let semaphore = DispatchSemaphore(value: 0)
        var accessGranted = false
        var accessError: Error?

        if #available(macOS 14.0, *) {
            store.requestFullAccessToReminders { granted, error in
                accessGranted = granted
                accessError = error
                semaphore.signal()
            }
        } else {
            store.requestAccess(to: .reminder) { granted, error in
                accessGranted = granted
                accessError = error
                semaphore.signal()
            }
        }

        semaphore.wait()

        guard accessGranted else {
            let msg = accessError?.localizedDescription ?? "Unknown error"
            exitWithError("Reminders access denied: \(msg)\nGrant access in System Settings > Privacy & Security > Reminders")
        }

        do {
            let result: Any
            switch command {
            case "list_lists":
                result = try listLists(store: store)
            case "list_reminders":
                result = try listReminders(store: store, params: params)
            case "get_reminder":
                result = try getReminder(store: store, params: params)
            case "create_reminder":
                result = try createReminder(store: store, params: params)
            case "complete_reminder":
                result = try completeReminder(store: store, params: params)
            default:
                exitWithError("Unknown command: \(command)\nAvailable: list_lists, list_reminders, get_reminder, create_reminder, complete_reminder")
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

// MARK: - Commands

func listLists(store: EKEventStore) throws -> [String: Any] {
    let calendars = store.calendars(for: .reminder)
    let lists: [[String: Any]] = calendars.map { cal in
        [
            "id": cal.calendarIdentifier,
            "name": cal.title,
            "color": cal.cgColor.flatMap { hexColor(from: $0) } ?? "#000000",
        ]
    }
    return ["lists": lists]
}

func listReminders(store: EKEventStore, params: [String: Any]) throws -> [String: Any] {
    let limit = params["limit"] as? Int ?? 20
    let listName = params["list"] as? String

    var calendars: [EKCalendar]?
    if let name = listName {
        calendars = store.calendars(for: .reminder).filter { $0.title == name }
        if calendars?.isEmpty == true {
            throw CLIError.notFound("Reminder list '\(name)' not found")
        }
    }

    let predicate = store.predicateForIncompleteReminders(
        withDueDateStarting: nil,
        ending: nil,
        calendars: calendars
    )

    let semaphore = DispatchSemaphore(value: 0)
    var fetchedReminders: [EKReminder]?

    store.fetchReminders(matching: predicate) { reminders in
        fetchedReminders = reminders
        semaphore.signal()
    }

    semaphore.wait()

    let reminders = (fetchedReminders ?? []).prefix(limit).map { r in
        reminderToDict(r)
    }

    return ["reminders": Array(reminders)]
}

func getReminder(store: EKEventStore, params: [String: Any]) throws -> [String: Any] {
    guard let id = params["id"] as? String else {
        throw CLIError.missingField("id")
    }

    guard let item = store.calendarItem(withIdentifier: id) as? EKReminder else {
        throw CLIError.notFound("Reminder with id '\(id)' not found")
    }

    return ["reminder": reminderToDict(item)]
}

func createReminder(store: EKEventStore, params: [String: Any]) throws -> [String: Any] {
    guard let name = params["name"] as? String else {
        throw CLIError.missingField("name")
    }

    let reminder = EKReminder(eventStore: store)
    reminder.title = name

    if let listName = params["list"] as? String {
        guard let calendar = store.calendars(for: .reminder).first(where: { $0.title == listName }) else {
            throw CLIError.notFound("Reminder list '\(listName)' not found")
        }
        reminder.calendar = calendar
    } else {
        reminder.calendar = store.defaultCalendarForNewReminders()
    }

    if let dueDateStr = params["due_date"] as? String {
        guard let date = parseISO8601(dueDateStr) else {
            throw CLIError.invalidDate(dueDateStr)
        }
        reminder.dueDateComponents = Calendar.current.dateComponents(
            [.year, .month, .day, .hour, .minute, .second],
            from: date
        )
    }

    if let priority = params["priority"] as? Int {
        reminder.priority = priority
    }

    if let notes = params["notes"] as? String {
        reminder.notes = notes
    }

    if #available(macOS 15.0, *) {
        if let tags = params["tags"] as? [String], !tags.isEmpty {
            reminder.tags = tags
        }
    }

    try store.save(reminder, commit: true)

    return [
        "id": reminder.calendarItemIdentifier,
        "status": "created",
    ]
}

func completeReminder(store: EKEventStore, params: [String: Any]) throws -> [String: Any] {
    guard let id = params["id"] as? String else {
        throw CLIError.missingField("id")
    }

    guard let reminder = store.calendarItem(withIdentifier: id) as? EKReminder else {
        throw CLIError.notFound("Reminder with id '\(id)' not found")
    }

    reminder.isCompleted = true
    reminder.completionDate = Date()

    try store.save(reminder, commit: true)

    return ["status": "completed"]
}

// MARK: - Helpers

func reminderToDict(_ r: EKReminder) -> [String: Any] {
    var dict: [String: Any] = [
        "id": r.calendarItemIdentifier,
        "name": r.title ?? "",
        "completed": r.isCompleted,
        "priority": r.priority,
        "list": r.calendar?.title ?? "",
    ]

    if let dueDate = r.dueDateComponents?.date {
        dict["due_date"] = iso8601String(from: dueDate)
    }

    if let completionDate = r.completionDate {
        dict["completion_date"] = iso8601String(from: completionDate)
    }

    if let notes = r.notes, !notes.isEmpty {
        dict["notes"] = notes
    }

    if #available(macOS 15.0, *) {
        let tags = r.tags
        if !tags.isEmpty {
            dict["tags"] = tags
        }
    }

    return dict
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
    // Try date-only format
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
