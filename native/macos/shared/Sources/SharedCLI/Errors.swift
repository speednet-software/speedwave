import Foundation

public enum CLIError: LocalizedError {
    case missingField(String)
    case notFound(String)
    case invalidDate(String)

    public var errorDescription: String? {
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
