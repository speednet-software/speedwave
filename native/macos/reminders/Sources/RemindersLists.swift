import EventKit
import Foundation
import SharedCLI

func createList(store: EKEventStore, params: [String: Any]) throws -> [String: Any] {
    let name = try requiredListName(params)
    let color = try listColor(params)

    let list = EKCalendar(for: .reminder, eventStore: store)
    list.title = name
    list.source = try newListSource(store: store)
    if let color = color {
        list.cgColor = color
    }
    try store.saveCalendar(list, commit: true)

    return [
        "id": list.calendarIdentifier,
        "status": "created",
    ]
}

func requiredListName(_ params: [String: Any]) throws -> String {
    guard let name = params["name"] as? String,
          !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
        throw CLIError.missingField("name")
    }
    return name
}

func listColor(_ params: [String: Any]) throws -> CGColor? {
    guard let hex = params["color"] as? String else { return nil }
    guard let color = parseHexColor(hex) else {
        throw CLIError.invalidValue("Invalid color '\(hex)'. Expected #RRGGBB")
    }
    return color
}

/// The account of the default list for new reminders, else the first account that already holds reminder lists.
func newListSource(store: EKEventStore) throws -> EKSource {
    if let source = store.defaultCalendarForNewReminders()?.source {
        return source
    }
    if let source = store.sources.first(where: { !$0.calendars(for: .reminder).isEmpty }) {
        return source
    }
    throw CLIError.notFound("No account that supports reminder lists was found")
}

func updateList(store: EKEventStore, params: [String: Any]) throws -> [String: Any] {
    guard let filter = params["list_id"] as? String else {
        throw CLIError.missingField("list_id")
    }
    var name: String?
    if params["name"] != nil {
        name = try requiredListName(params)
    }
    let color = try listColor(params)
    guard name != nil || color != nil else {
        throw CLIError.missingField("name or color")
    }

    let list = try resolveSingleCalendar(for: .reminder, filter: filter, store: store)
    try ensureListWritable(list)
    if let name = name {
        list.title = name
    }
    if let color = color {
        list.cgColor = color
    }
    try store.saveCalendar(list, commit: true)

    return ["status": "updated"]
}

func ensureListWritable(_ list: EKCalendar) throws {
    if let message = listWriteBlocker(
        name: list.title,
        allowsContentModifications: list.allowsContentModifications,
        isImmutable: list.isImmutable
    ) {
        throw CLIError.invalidValue(message)
    }
}

func listWriteBlocker(name: String, allowsContentModifications: Bool, isImmutable: Bool) -> String? {
    guard allowsContentModifications, !isImmutable else {
        return "Reminder list '\(name)' is read-only and cannot be changed or deleted"
    }
    return nil
}

func deleteList(store: EKEventStore, params: [String: Any]) throws -> [String: Any] {
    guard let filter = params["list_id"] as? String else {
        throw CLIError.missingField("list_id")
    }
    let force = params["force"] as? Bool ?? false

    let list = try resolveSingleCalendar(for: .reminder, filter: filter, store: store)
    try ensureListWritable(list)
    let count = try reminderCount(in: list, store: store)
    if count > 0 && !force {
        throw CLIError.invalidValue(nonEmptyListMessage(name: list.title, reminderCount: count))
    }
    try store.removeCalendar(list, commit: true)

    return [
        "status": "deleted",
        "deleted_reminders": count,
    ]
}

func reminderCount(in list: EKCalendar, store: EKEventStore) throws -> Int {
    let semaphore = DispatchSemaphore(value: 0)
    var fetched: [EKReminder]?
    store.fetchReminders(matching: store.predicateForReminders(in: [list])) { reminders in
        fetched = reminders
        semaphore.signal()
    }
    guard semaphore.wait(timeout: .now() + 10) == .success else {
        throw CLIError.invalidValue("Timed out counting the reminders of list '\(list.title)' after 10s")
    }
    return try countFetched(fetched, listName: list.title)
}

/// A fetch that completed with nil is an error: reading it as 0 would let a non-empty list be deleted without force.
func countFetched(_ fetched: [EKReminder]?, listName: String) throws -> Int {
    guard let fetched = fetched else {
        throw CLIError.invalidValue("Could not count the reminders of list '\(listName)': the fetch returned no result")
    }
    return fetched.count
}

func nonEmptyListMessage(name: String, reminderCount: Int) -> String {
    let noun = reminderCount == 1 ? "reminder" : "reminders"
    return "Reminder list '\(name)' still holds \(reminderCount) \(noun). "
        + "Pass force: true to delete the list together with its reminders; this cannot be undone"
}
