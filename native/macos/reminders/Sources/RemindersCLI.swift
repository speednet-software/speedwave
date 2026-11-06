import EventKit
import Foundation
import SharedCLI

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


/// reminders-cli <command> [json-args]
/// Commands: check_permission, list_lists, list_reminders, get_reminder, create_reminder, update_reminder, complete_reminder, delete_reminder
@main
struct RemindersCLI {
    static let commandList =
        "check_permission, list_lists, list_reminders, get_reminder, create_reminder, update_reminder, complete_reminder, delete_reminder"

    static func main() {
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
                "delete_reminder": { try deleteReminder(store: store, params: $0) },
            ]
        )
    }
}


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

enum ReminderSort: String {
    case dueDate = "due_date"
    case created
    case name
}

/// The parsed `list_reminders` filters; `dueTo` is an exclusive upper bound.
struct ListQuery {
    var dueFrom: Date?
    var dueTo: Date?
    var overdue = false
    var search: String?
    var sort = ReminderSort.dueDate
    var limit = 50
    var now = Date()
    var timeZone = TimeZone.current

    var hasDueRange: Bool { dueFrom != nil || dueTo != nil }

    /// EventKit's handling of all-day due dates and bound inclusivity is undocumented, so both bounds
    /// are widened by a day; `applyListQuery` makes the exact cut.
    var predicateStart: Date? { dueFrom.map { addingDays(-1, to: $0, in: timeZone) } }

    var predicateEnd: Date? {
        let end = overdue ? (dueTo.map { min($0, now) } ?? now) : dueTo
        return end.map { addingDays(1, to: $0, in: timeZone) }
    }
}

func listReminders(store: EKEventStore, params: [String: Any]) throws -> [String: Any] {
    let query = try parseListQuery(params)
    var calendars: [EKCalendar]?
    if let filter = params["list_id"] as? String {
        calendars = try resolveCalendars(for: .reminder, filter: filter, store: store)
    }

    let showCompleted = !query.overdue && (params["show_completed"] as? Bool ?? false)

    var fetchedReminders: [EKReminder]?

    if showCompleted {
        let group = DispatchGroup()
        var incompleteResults: [EKReminder]?
        var completedResults: [EKReminder]?

        let incompletePred = store.predicateForIncompleteReminders(
            withDueDateStarting: query.predicateStart, ending: query.predicateEnd, calendars: calendars
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
            withDueDateStarting: query.predicateStart, ending: query.predicateEnd, calendars: calendars
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

    return listResponse(applyListQuery(query, to: fetchedReminders ?? []), limit: query.limit)
}

func parseListQuery(_ params: [String: Any], now: Date = Date(), timeZone: TimeZone = .current) throws -> ListQuery {
    var query = ListQuery(now: now, timeZone: timeZone)
    query.limit = params["limit"] as? Int ?? query.limit
    query.overdue = params["overdue"] as? Bool ?? false
    query.search = params["search"] as? String
    if let raw = params["sort"] as? String {
        guard let sort = ReminderSort(rawValue: raw) else {
            throw CLIError.invalidValue("Invalid sort: \(raw). Expected due_date, created or name")
        }
        query.sort = sort
    }
    if let raw = params["due_from"] as? String {
        query.dueFrom = try parseDueBound(raw, in: timeZone).date
    }
    if let raw = params["due_to"] as? String {
        let bound = try parseDueBound(raw, in: timeZone)
        query.dueTo = upperBound(of: bound.input, at: bound.date, in: timeZone)
    }
    return query
}

private func parseDueBound(_ raw: String, in timeZone: TimeZone) throws -> (input: ISODateInput, date: Date) {
    guard let input = parseISODateInput(raw), let date = input.date(in: timeZone) else {
        throw CLIError.invalidDate(raw)
    }
    return (input, date)
}

/// A bare day ends after that whole day; a time is included itself.
private func upperBound(of input: ISODateInput, at date: Date, in timeZone: TimeZone) -> Date {
    if case .day = input {
        return addingDays(1, to: date, in: timeZone)
    }
    return Date(timeIntervalSinceReferenceDate: date.timeIntervalSinceReferenceDate.nextUp)
}

private func addingDays(_ days: Int, to date: Date, in timeZone: TimeZone) -> Date {
    var calendar = gregorian
    calendar.timeZone = timeZone
    return calendar.date(byAdding: .day, value: days, to: date) ?? date
}

/// Due filter, overdue, search and sort, in that order; the caller truncates.
func applyListQuery(_ query: ListQuery, to reminders: [EKReminder]) -> [EKReminder] {
    let filtered = reminders.filter { reminder in
        matchesDueFilter(reminder, query) && matchesSearch(reminder, query.search)
    }
    return sortReminders(filtered, by: query.sort, timeZone: query.timeZone)
}

private func matchesDueFilter(_ reminder: EKReminder, _ query: ListQuery) -> Bool {
    guard query.hasDueRange || query.overdue else { return true }
    guard let due = dueWindow(of: reminder, timeZone: query.timeZone) else { return false }
    if let from = query.dueFrom, due.start < from { return false }
    if let to = query.dueTo, due.start >= to { return false }
    guard query.overdue else { return true }
    return !reminder.isCompleted && due.end <= query.now
}

private func matchesSearch(_ reminder: EKReminder, _ search: String?) -> Bool {
    guard let search else { return true }
    let options: String.CompareOptions = [.caseInsensitive, .diacriticInsensitive]
    return (reminder.title ?? "").range(of: search, options: options) != nil
        || stripTags(from: reminder.notes ?? "").range(of: search, options: options) != nil
}

/// When a reminder is due: `start` is its moment (local midnight when all-day), `end` is when it counts as overdue.
func dueWindow(of reminder: EKReminder, timeZone: TimeZone = .current) -> (start: Date, end: Date)? {
    guard var components = reminder.dueDateComponents else { return nil }
    var calendar = gregorian
    calendar.timeZone = components.timeZone ?? timeZone
    components.calendar = calendar
    components.timeZone = calendar.timeZone
    guard let start = components.date else { return nil }
    guard isAllDay(components) else { return (start, start) }
    return (start, calendar.date(byAdding: .day, value: 1, to: start) ?? start)
}

func sortReminders(
    _ reminders: [EKReminder],
    by sort: ReminderSort,
    timeZone: TimeZone = .current,
    creationDate: (EKReminder) -> Date? = { $0.creationDate }
) -> [EKReminder] {
    func primary(_ a: EKReminder, _ b: EKReminder) -> ComparisonResult {
        switch sort {
        case .dueDate:
            return compareLastWhenNil(dueWindow(of: a, timeZone: timeZone)?.start, dueWindow(of: b, timeZone: timeZone)?.start)
        case .created:
            return compareLastWhenNil(creationDate(a), creationDate(b))
        case .name:
            return .orderedSame
        }
    }
    return reminders.sorted { a, b in
        let byKey = primary(a, b)
        if byKey != .orderedSame { return byKey == .orderedAscending }
        let byName = (a.title ?? "").localizedStandardCompare(b.title ?? "")
        if byName != .orderedSame { return byName == .orderedAscending }
        return a.calendarItemIdentifier < b.calendarItemIdentifier
    }
}

private func compareLastWhenNil(_ a: Date?, _ b: Date?) -> ComparisonResult {
    switch (a, b) {
    case let (a?, b?): return a < b ? .orderedAscending : (a > b ? .orderedDescending : .orderedSame)
    case (nil, nil): return .orderedSame
    case (nil, _): return .orderedDescending
    case (_, nil): return .orderedAscending
    }
}

/// The first `limit` reminders plus `total` (the count before truncating) and whether anything was cut.
func listResponse(_ matched: [EKReminder], limit: Int) -> [String: Any] {
    [
        "reminders": matched.prefix(limit).map { reminderToDict($0) },
        "total": matched.count,
        "truncated": matched.count > limit,
    ]
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
        reminder.calendar = try resolveSingleCalendar(for: .reminder, filter: filter, store: store)
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

    try applyReminderUpdate(params, to: reminder, store: store)
    try store.save(reminder, commit: true)

    return ["status": "updated"]
}

func applyReminderUpdate(_ params: [String: Any], to reminder: EKReminder, store: EKEventStore) throws {
    if let name = params["name"] as? String {
        reminder.title = name
    }

    if let filter = params["list_id"] as? String {
        reminder.calendar = try resolveSingleCalendar(for: .reminder, filter: filter, store: store)
    }

    if params["due_date"] is NSNull {
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

    if params["notes"] != nil || params["tags"] != nil {
        reminder.notes = mergeNotes(
            existing: reminder.notes,
            notes: params["notes"] as? String,
            tags: params["tags"] as? [String]
        )
    }
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

func deleteReminder(store: EKEventStore, params: [String: Any]) throws -> [String: Any] {
    guard let id = params["id"] as? String else {
        throw CLIError.missingField("id")
    }

    guard let reminder = store.calendarItem(withIdentifier: id) as? EKReminder else {
        throw CLIError.notFound("Reminder with id '\(id)' not found")
    }

    try store.remove(reminder, commit: true)

    return ["status": "deleted"]
}


func reminderToDict(_ r: EKReminder, timeZone: TimeZone = .current) -> [String: Any] {
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

    if let due = r.dueDateComponents, let dueDate = dueDateString(from: due, timeZone: timeZone) {
        dict["due_date"] = dueDate
        dict["all_day"] = isAllDay(due)
    }

    if let completionDate = r.completionDate {
        dict["completed_date"] = iso8601String(from: completionDate, timeZone: timeZone)
    }

    if !cleanNotes.isEmpty {
        dict["notes"] = cleanNotes
    }

    return dict
}


private let gregorian = Calendar(identifier: .gregorian)

func isAllDay(_ components: DateComponents) -> Bool {
    components.hour == nil
}

/// Floating Gregorian components (EventKit requires that calendar): a bare date is all-day, a time
/// without offset is kept as typed (never DST-adjusted), a time with offset/`Z` becomes `timeZone`'s wall clock.
func dueDateComponents(from string: String, timeZone: TimeZone = .current) -> DateComponents? {
    switch parseISODateInput(string) {
    case .day(let components)?, .wallClock(let components)?:
        return components
    case .instant(let date)?:
        var zoned = gregorian
        zoned.timeZone = timeZone
        var components = zoned.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
        components.calendar = gregorian
        return components
    case nil:
        return nil
    }
}

/// Formats due date components: all-day as `yyyy-MM-dd`, timed as wall-clock time with UTC offset
/// in the components' own zone, else `timeZone`.
func dueDateString(from components: DateComponents, timeZone: TimeZone = .current) -> String? {
    guard let year = components.year, let month = components.month, let day = components.day else {
        return nil
    }
    if isAllDay(components) {
        return String(format: "%04d-%02d-%02d", year, month, day)
    }
    var resolved = components
    resolved.calendar = resolved.calendar ?? gregorian
    let zone = components.timeZone ?? timeZone
    resolved.timeZone = zone
    guard let date = resolved.date else { return nil }
    return iso8601String(from: date, timeZone: zone)
}


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

/// Format tags as `[#tag]` markers: trimmed, lowercased, deduplicated, space-separated.
func formatTags(_ tags: [String]) -> String {
    var seen = Set<String>()
    return tags
        .map { $0.trimmingCharacters(in: .whitespaces).lowercased() }
        .filter { !$0.isEmpty && seen.insert($0).inserted }
        .map { "[#\($0)]" }
        .joined(separator: " ")
}

/// Format tags as `[#tag]` markers and combine with notes.
func combineTags(_ tags: [String], with notes: String?) -> String? {
    joinTags(formatTags(tags), with: notes?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "")
}

private func joinTags(_ markers: String, with body: String) -> String? {
    if markers.isEmpty && body.isEmpty { return nil }
    if markers.isEmpty { return body }
    if body.isEmpty { return markers }
    return "\(markers)\n\(body)"
}

/// Splits the marker run `combineTags` writes at the start of the notes from the text after it.
func splitLeadingTags(_ notes: String) -> (markers: String, body: String) {
    let pattern = #"^(?:\[#[^\]]+\][ \t]*)+\n?"#
    guard let range = notes.range(of: pattern, options: .regularExpression) else {
        return ("", notes)
    }
    let markers = notes[range].trimmingCharacters(in: .whitespacesAndNewlines)
    return (markers, String(notes[range.upperBound...]))
}

/// PATCH merge for the shared notes field: a side the caller omits is kept byte-for-byte.
func mergeNotes(existing: String?, notes: String?, tags: [String]?) -> String? {
    let current = splitLeadingTags(existing ?? "")
    let markers = tags.map(formatTags) ?? current.markers
    let body = notes.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) } ?? current.body
    return joinTags(markers, with: body)
}

