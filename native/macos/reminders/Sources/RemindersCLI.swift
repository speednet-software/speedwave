import EventKit
import Foundation
import SharedCLI

// File-scope so tests can reach it via @testable import reminders_cli.
struct EventStoreGate: PermissionGate {
    let store: EKEventStore
    func authorizationStatus() -> RawAuthorizationStatus {
        mapEventKitStatusToRaw(EKEventStore.authorizationStatus(for: .reminder))
    }
    func requestAccess(completion: @escaping (Bool, Error?) -> Void) {
        if #available(macOS 14.0, *) {
            store.requestFullAccessToReminders(completion: completion)
        } else {
            store.requestAccess(to: .reminder, completion: completion)
        }
    }
}

// MARK: - CLI Entry Point

/// reminders-cli <command> [json-args]
/// Commands: check_permission, list_lists, list_reminders, get_reminder, create_reminder, update_reminder, complete_reminder
@main
struct RemindersCLI {
    static let commandList =
        "check_permission, list_lists, list_reminders, get_reminder, create_reminder, update_reminder, complete_reminder"

    static func main() {
        // Shared store; check_permission uses its own gate.
        let store = EKEventStore()
        runCLI(
            cliName: "reminders-cli",
            commandList: commandList,
            entity: .reminders,
            checkPermissionGate: { _ in EventStoreGate(store: EKEventStore()) },
            accessGuard: {
                let (granted, error) = requestReminderAccess(store: store)
                guard granted else {
                    let msg = error?.localizedDescription ?? "Unknown error"
                    return "Reminders access denied: \(msg)\nGrant access in System Settings > Privacy & Security > Reminders"
                }
                return nil
            },
            commands: [
                "list_lists": { _ in try listLists(store: store) },
                "list_reminders": { try listReminders(store: store, params: $0) },
                "get_reminder": { try getReminder(store: store, params: $0) },
                "create_reminder": { try createReminder(store: store, params: $0) },
                "update_reminder": { try updateReminder(store: store, params: $0) },
                "complete_reminder": { try completeReminder(store: store, params: $0) },
            ]
        )
    }
}

// MARK: - Permission Helpers

/// Requests Reminders access from EventKit. Uses the macOS 14+ full-access API
/// when available, falling back to the legacy requestAccess(to:) API.
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

    // TCC-gated: show_completed dual-fetch path cannot be unit-tested without Reminders permission
    let showCompleted = params["show_completed"] as? Bool ?? false

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
        let semaphore = DispatchSemaphore(value: 0)
        let predicate = store.predicateForIncompleteReminders(
            withDueDateStarting: nil, ending: nil, calendars: calendars
        )
        store.fetchReminders(matching: predicate) { reminders in
            fetchedReminders = reminders
            semaphore.signal()
        }
        let waitResult = semaphore.wait(timeout: .now() + 10)
        if waitResult == .timedOut {
            exitWithError("Timed out fetching reminders after 10s")
        }
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
        guard let components = dueDateComponents(from: dueDateStr) else {
            throw CLIError.invalidDate(dueDateStr)
        }
        reminder.dueDateComponents = components
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

func updateReminder(store: EKEventStore, params: [String: Any]) throws -> [String: Any] {
    guard let id = params["id"] as? String else {
        throw CLIError.missingField("id")
    }

    guard let reminder = store.calendarItem(withIdentifier: id) as? EKReminder else {
        throw CLIError.notFound("Reminder with id '\(id)' not found")
    }

    if let name = params["name"] as? String {
        reminder.title = name
    }

    if let filter = params["list_id"] as? String {
        let matches = try resolveCalendars(for: .reminder, filter: filter, store: store)
        reminder.calendar = matches[0]
    }

    if params["due_date"] is NSNull {
        // EventKit refuses a recurring reminder without a due date, so the rules go with it.
        reminder.dueDateComponents = nil
        reminder.recurrenceRules = nil
    } else if let dueDateStr = params["due_date"] as? String {
        guard let components = dueDateComponents(from: dueDateStr) else {
            throw CLIError.invalidDate(dueDateStr)
        }
        reminder.dueDateComponents = components
    }

    if let priority = params["priority"] as? Int {
        reminder.priority = priority
    }

    if let completed = params["completed"] as? Bool {
        reminder.isCompleted = completed
        reminder.completionDate = completed ? Date() : nil
    }

    // Notes and tags share one EventKit field: only recombine when the caller touches either.
    if params["notes"] != nil || params["tags"] != nil {
        let rawNotes = reminder.notes ?? ""
        let newNotes = params["notes"] as? String ?? stripTags(from: rawNotes)
        let newTags = params["tags"] as? [String] ?? extractTags(from: rawNotes)
        reminder.notes = combineTags(newTags, with: newNotes)
    }

    try store.save(reminder, commit: true)

    return ["status": "updated"]
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

    if let due = r.dueDateComponents, let dueDate = dueDateString(from: due) {
        dict["due_date"] = dueDate
        dict["all_day"] = due.hour == nil
    }

    if let completionDate = r.completionDate {
        dict["completed_date"] = localISO8601String(from: completionDate, timeZone: .current)
    }

    if !cleanNotes.isEmpty {
        dict["notes"] = cleanNotes
    }

    return dict
}

// MARK: - Due Date Helpers

private let gregorian = Calendar(identifier: .gregorian)

private let dateOnlyPattern = #"^\d{4}-\d{2}-\d{2}$"#
private let wallClockPattern = #"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$"#
private let offsetPattern = #"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$"#

/// Floating Gregorian components (EventKit requires that calendar): a bare date is all-day,
/// a time with offset/`Z` becomes the host's wall clock, a time without offset is wall clock as given.
func dueDateComponents(from string: String) -> DateComponents? {
    if string.range(of: dateOnlyPattern, options: .regularExpression) != nil {
        let parts = string.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        let components = DateComponents(calendar: gregorian, year: parts[0], month: parts[1], day: parts[2])
        return components.isValidDate ? components : nil
    }

    let date: Date?
    if string.range(of: wallClockPattern, options: .regularExpression) != nil {
        let formatter = DateFormatter()
        formatter.calendar = gregorian
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = .current
        formatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ss"
        date = formatter.date(from: string.replacingOccurrences(of: #"\.\d+$"#, with: "", options: .regularExpression))
    } else if string.range(of: offsetPattern, options: .regularExpression) != nil {
        date = parseISO8601(string)
    } else {
        // Foundation's date-only fallback accepts unpadded "2026-6-1" as a timed UTC midnight; refuse it.
        return nil
    }
    guard let date else { return nil }

    var local = gregorian
    local.timeZone = .current
    var components = local.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
    components.calendar = gregorian
    components.timeZone = nil
    return components
}

/// Formats due date components: all-day as `yyyy-MM-dd`, timed as local time with UTC offset.
func dueDateString(from components: DateComponents) -> String? {
    guard let year = components.year, let month = components.month, let day = components.day else {
        return nil
    }
    if components.hour == nil {
        return String(format: "%04d-%02d-%02d", year, month, day)
    }
    var resolved = components
    if resolved.calendar == nil {
        resolved.calendar = gregorian
    }
    let timeZone = components.timeZone ?? .current
    resolved.timeZone = timeZone
    guard let date = resolved.date else { return nil }
    return localISO8601String(from: date, timeZone: timeZone)
}

func localISO8601String(from date: Date, timeZone: TimeZone) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime]
    formatter.timeZone = timeZone
    return formatter.string(from: date)
}

// MARK: - Tag Helpers

/// Tags are stored in the notes field using `[#tag]` format, e.g. `[#work] [#urgent]\nActual notes`.
/// Pattern is a compile-time constant; a failure here is a programmer error, not runtime input.
private let tagRegex: NSRegularExpression = {
    let pattern = #"\[#([^\]]+)\]"#
    guard let regex = try? NSRegularExpression(pattern: pattern) else {
        fatalError("tagRegex pattern failed to compile (compile-time constant): \(pattern)")
    }
    return regex
}()

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

