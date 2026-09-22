import Foundation

public func parseISO8601(_ string: String) -> Date? {
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
