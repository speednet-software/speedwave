import EventKit
import Foundation

// MARK: - CLI Entry Point

/// reminders-cli <command> [json-args]
/// Commands: check_permission, list_lists, list_reminders, get_reminder, create_reminder, complete_reminder
@main
struct RemindersCLI {
    static func main() {
        let args = CommandLine.arguments
        guard args.count >= 2 else {
            exitWithError("Usage: reminders-cli <command> [json-args]\nCommands: check_permission, list_lists, list_reminders, get_reminder, create_reminder, complete_reminder")
        }

        let command = args[1]

        // check_permission: verify macOS TCC access without performing any operation.
        // Returns JSON {"granted": true/false} on stdout, always exits 0.
        // Pattern: see also calendar/Sources/CalendarCLI.swift check_permission
        if command == "check_permission" {
            let store = EKEventStore()
            let (granted, error) = requestReminderAccess(store: store, timeout: 65)
            if granted {
                print(formatPermissionResult(granted: true, error: nil))
            } else {
                let msg = error?.localizedDescription ?? "Unknown error"
                let detail = "Reminders access denied: \(msg)\nGrant access in System Settings > Privacy & Security > Reminders"
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
        let (accessGranted, accessError) = requestReminderAccess(store: store)

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
                exitWithError("Unknown command: \(command)\nAvailable: check_permission, list_lists, list_reminders, get_reminder, create_reminder, complete_reminder")
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

/// Requests Reminders access from EventKit. Uses the macOS 14+ full-access API
/// when available, falling back to the legacy requestAccess(to:) API.
/// The optional timeout (default: unbounded) is a safety net for check_permission.
func requestReminderAccess(store: EKEventStore, timeout: TimeInterval? = nil) -> (granted: Bool, error: Error?) {
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

    if let timeout = timeout {
        let result = semaphore.wait(timeout: .now() + timeout)
        if result == .timedOut {
            return (false, NSError(domain: "RemindersCLI", code: 1, userInfo: [
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
// SYNC: formatPermissionResult must match calendar/Sources/CalendarCLI.swift
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
/// If multiple calendars share the same name, all are returned; createReminder uses [0].
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
    var calendars: [EKCalendar]?
    if let filter = params["list_id"] as? String {
        calendars = try resolveCalendars(for: .reminder, filter: filter, store: store)
    }

    // show_completed: verified only by manual testing (TCC-dependent, see Task 9 Step 4 item 4)
    let showCompleted = params["show_completed"] as? Bool ?? false

    let semaphore = DispatchSemaphore(value: 0)
    var fetchedReminders: [EKReminder]?

    if showCompleted {
        let group = DispatchGroup()
        var incompleteResults: [EKReminder]?
        var completedResults: [EKReminder]?

        let incompletePred = store.predicateForIncompleteReminders(
            withDueDateStarting: nil, ending: nil, calendars: calendars
        )
        group.enter()
        store.fetchReminders(matching: incompletePred) { reminders in
            incompleteResults = reminders
            group.leave()
        }

        let completedPred = store.predicateForCompletedReminders(
            withCompletionDateStarting: nil, ending: nil, calendars: calendars
        )
        group.enter()
        store.fetchReminders(matching: completedPred) { reminders in
            completedResults = reminders
            group.leave()
        }

        let result = group.wait(timeout: .now() + 10)
        if result == .timedOut {
            exitWithError("Timed out fetching reminders after 10s")
        }
        fetchedReminders = (incompleteResults ?? []) + (completedResults ?? [])
    } else {
        let predicate = store.predicateForIncompleteReminders(
            withDueDateStarting: nil, ending: nil, calendars: calendars
        )
        store.fetchReminders(matching: predicate) { reminders in
            fetchedReminders = reminders
            semaphore.signal()
        }
        semaphore.wait()
    }

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

    return reminderToDict(item)
}

func createReminder(store: EKEventStore, params: [String: Any]) throws -> [String: Any] {
    guard let name = params["name"] as? String else {
        throw CLIError.missingField("name")
    }

    let reminder = EKReminder(eventStore: store)
    reminder.title = name

    if let filter = params["list_id"] as? String {
        let matches = try resolveCalendars(for: .reminder, filter: filter, store: store)
        reminder.calendar = matches[0]
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

    let userNotes = params["notes"] as? String
    let tags = params["tags"] as? [String] ?? []
    reminder.notes = combineTags(tags, with: userNotes)

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
    let rawNotes = r.notes ?? ""
    let tags = extractTags(from: rawNotes)
    let cleanNotes = stripTags(from: rawNotes)

    var dict: [String: Any] = [
        "id": r.calendarItemIdentifier,
        "name": r.title ?? "",
        "completed": r.isCompleted,
        "priority": r.priority,
        "list_id": r.calendar?.calendarIdentifier ?? "",
        "list_name": r.calendar?.title ?? "",
    ]

    if !tags.isEmpty {
        dict["tags"] = tags
    }

    if let dueDate = r.dueDateComponents?.date {
        dict["due_date"] = iso8601String(from: dueDate)
    }

    if let completionDate = r.completionDate {
        dict["completed_date"] = iso8601String(from: completionDate)
    }

    if !cleanNotes.isEmpty {
        dict["notes"] = cleanNotes
    }

    return dict
}

// MARK: - Tag Helpers

/// Tags are stored in the notes field using `[#tag]` format, e.g. `[#work] [#urgent]\nActual notes`.
private let tagRegex = try! NSRegularExpression(pattern: #"\[#([^\]]+)\]"#)

/// Extract tag names from notes content.
func extractTags(from notes: String) -> [String] {
    let range = NSRange(notes.startIndex..., in: notes)
    let matches = tagRegex.matches(in: notes, range: range)
    var tags: [String] = []
    for match in matches {
        if let tagRange = Range(match.range(at: 1), in: notes) {
            let tag = String(notes[tagRange]).trimmingCharacters(in: .whitespaces).lowercased()
            if !tag.isEmpty && !tags.contains(tag) {
                tags.append(tag)
            }
        }
    }
    return tags
}

/// Remove `[#tag]` markers from notes, returning clean content.
func stripTags(from notes: String) -> String {
    let range = NSRange(notes.startIndex..., in: notes)
    return tagRegex.stringByReplacingMatches(in: notes, range: range, withTemplate: "")
        .trimmingCharacters(in: .whitespacesAndNewlines)
        .replacingOccurrences(of: "\n{3,}", with: "\n\n", options: .regularExpression)
}

/// Format tags as `[#tag]` markers and combine with notes.
func combineTags(_ tags: [String], with notes: String?) -> String? {
    var seen = Set<String>()
    let normalized = tags
        .map { $0.trimmingCharacters(in: .whitespaces).lowercased() }
        .filter { !$0.isEmpty && seen.insert($0).inserted }
    let formatted = normalized
        .map { "[#\($0)]" }
        .joined(separator: " ")
    let clean = notes?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""

    if formatted.isEmpty && clean.isEmpty { return nil }
    if formatted.isEmpty { return clean }
    if clean.isEmpty { return formatted }
    return "\(formatted)\n\(clean)"
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
