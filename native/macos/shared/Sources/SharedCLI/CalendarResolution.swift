import EventKit

/// Resolves calendars by ID first, falling back to name match.
/// Returns all matches; throws CLIError.notFound if filter matches nothing.
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

/// One calendar by ID or exact name; a name shared by several calendars is refused rather than picked blindly.
public func resolveSingleCalendar(
    for entityType: EKEntityType,
    filter: String,
    store: EKEventStore
) throws -> EKCalendar {
    try singleCalendarMatch(
        resolveCalendars(for: entityType, filter: filter, store: store),
        filter: filter,
        entityType: entityType
    )
}

func singleCalendarMatch(_ matches: [EKCalendar], filter: String, entityType: EKEntityType) throws -> EKCalendar {
    guard matches.count == 1 else {
        let (label, kind) = entityType == .reminder ? ("Reminder list", "list") : ("Calendar", "calendar")
        throw CLIError.ambiguous("\(label) '\(filter)' matches \(matches.count) \(kind)s; pass the \(kind) id instead")
    }
    return matches[0]
}
