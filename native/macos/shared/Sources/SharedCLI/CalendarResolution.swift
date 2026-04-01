import EventKit

/// Resolves calendars by ID first, falling back to name match.
/// Returns all matches — caller decides usage (filter predicate vs single pick).
/// If multiple calendars share the same name, all are returned; create operations use [0].
/// Throws CLIError.notFound if filter matches nothing.
public func resolveCalendars(
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
