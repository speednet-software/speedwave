import Foundation

public enum CLIError: LocalizedError {
    case missingField(String)
    case notFound(String)
    case ambiguous(String)
    case invalidDate(String)

    public var errorDescription: String? {
        switch self {
        case .missingField(let field):
            return "Missing required field: \(field)"
        case .notFound(let msg), .ambiguous(let msg):
            return msg
        case .invalidDate(let date):
            return "Invalid ISO8601 date: \(date). Expected YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS (local time), optionally with Z or ±HH:MM"
        }
    }
}
