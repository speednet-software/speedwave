import Foundation

/// An instant written with `Z` or a `±HH:MM` offset; a bare day or a time without an offset is not an instant.
public func parseISO8601(_ string: String) -> Date? {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = formatter.date(from: string) {
        return date
    }
    formatter.formatOptions = [.withInternetDateTime]
    return formatter.date(from: string)
}

/// A strict ISO 8601 input: a bare day, a wall-clock time without offset, or an instant with `Z`/`±HH:MM`.
public enum ISODateInput: Equatable {
    case day(DateComponents)
    case wallClock(DateComponents)
    case instant(Date)

    /// The moment this input names in `timeZone`; a bare day starts at local midnight.
    public func date(in timeZone: TimeZone) -> Date? {
        switch self {
        case .instant(let date):
            return date
        case .day(let components), .wallClock(let components):
            var calendar = gregorian
            calendar.timeZone = timeZone
            return calendar.date(from: components)
        }
    }
}

private let gregorian = Calendar(identifier: .gregorian)

private let zonelessGregorian: Calendar = {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(secondsFromGMT: 0)!
    return calendar
}()

private let dayPattern = #"^\d{4}-\d{2}-\d{2}$"#
private let wallClockPattern = #"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$"#
private let offsetPattern = #"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$"#

/// Parses zero-padded `YYYY-MM-DD`, `YYYY-MM-DDTHH:MM:SS[.fff]` or the same with `Z`/`±HH:MM`; anything else,
/// including impossible dates, is nil. Day and wall-clock components carry the Gregorian calendar and no zone.
public func parseISODateInput(_ string: String) -> ISODateInput? {
    func matches(_ pattern: String) -> Bool {
        string.range(of: pattern, options: .regularExpression) != nil
    }
    let day = matches(dayPattern)
    let wallClock = matches(wallClockPattern)
    guard day || wallClock || matches(offsetPattern) else { return nil }

    let ymd = string.prefix(10).split(separator: "-").compactMap { Int($0) }
    guard ymd.count == 3 else { return nil }
    var components = DateComponents(calendar: gregorian, year: ymd[0], month: ymd[1], day: ymd[2])
    guard components.isValidDate(in: zonelessGregorian) else { return nil }
    if day { return .day(components) }

    if wallClock {
        let hms = string.dropFirst(11).prefix(8).split(separator: ":").compactMap { Int($0) }
        guard hms.count == 3 else { return nil }
        components.hour = hms[0]
        components.minute = hms[1]
        components.second = hms[2]
        return components.isValidDate(in: zonelessGregorian) ? .wallClock(components) : nil
    }

    return parseISO8601(string).map(ISODateInput.instant)
}

private let utcFormatter: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime]
    return formatter
}()

private let offsetFormatter: DateFormatter = {
    let formatter = DateFormatter()
    formatter.calendar = Calendar(identifier: .gregorian)
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ssxxxxx"
    return formatter
}()

/// UTC instant with `Z` by default; given a zone, that zone's wall-clock time with an explicit `±HH:MM` offset.
public func iso8601String(from date: Date, timeZone: TimeZone? = nil) -> String {
    guard let timeZone else { return utcFormatter.string(from: date) }
    offsetFormatter.timeZone = timeZone
    return offsetFormatter.string(from: date)
}
