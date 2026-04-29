import Foundation

/// Executes AppleScript via osascript subprocess with timeout support.
public enum ScriptRunner {
    /// Run an AppleScript and return stdout. Throws on non-zero exit or timeout.
    public static func run(_ script: String, timeout: TimeInterval = 15) throws -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        process.arguments = ["-e", script]

        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe

        let semaphore = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in semaphore.signal() }

        try process.run()

        if semaphore.wait(timeout: .now() + timeout) == .timedOut {
            process.terminate()
            process.waitUntilExit()
            throw ScriptError.timeout(timeout, nil)
        }

        let stdoutData = stdoutPipe.fileHandleForReading.readDataToEndOfFile()
        let stderrData = stderrPipe.fileHandleForReading.readDataToEndOfFile()
        let stdout = String(data: stdoutData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let stderr = String(data: stderrData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""

        guard process.terminationStatus == 0 else {
            throw classifyFailure(stderr: stderr)
        }

        return stdout
    }

    /// Classify a non-zero osascript exit into the appropriate ScriptError case.
    static func classifyFailure(stderr: String) -> ScriptError {
        if stderr.contains("not allowed") || stderr.contains("not permitted") || stderr.contains("assistive access") {
            return .automationPermission(stderr)
        }
        return .scriptFailed(stderr)
    }
}

public enum ScriptError: LocalizedError {
    case scriptFailed(String)
    case automationPermission(String)
    case timeout(TimeInterval, String? = nil)

    public var errorDescription: String? {
        switch self {
        case .scriptFailed(let msg):
            return "AppleScript error: \(msg)"
        case .automationPermission(let msg):
            return "Automation permission denied: \(msg)\nGrant access in System Settings > Privacy & Security > Automation"
        case .timeout(let seconds, .none):
            return "AppleScript timed out after \(Int(seconds))s"
        case .timeout(let seconds, .some(let hint)):
            return "AppleScript timed out after \(Int(seconds))s — \(hint)"
        }
    }
}

/// Escape special characters for AppleScript string literals.
/// Strips C0 control characters (U+0000–U+001F), DEL (U+007F), and Unicode
/// line separators (U+0085 NEL, U+2028, U+2029) before escaping.
/// Prevents injection via newline/CR-based script breakout.
public func escapeAppleScript(_ s: String) -> String {
    let safe = String(s.unicodeScalars.filter { scalar in
        let v = scalar.value
        return v > 0x1F && v != 0x7F && v != 0x85 && v != 0x2028 && v != 0x2029
    })
    return safe
        .replacingOccurrences(of: "\\", with: "\\\\")
        .replacingOccurrences(of: "\"", with: "\\\"")
}

/// Parse `||`-delimited AppleScript output into array of dictionaries.
public func parseDelimited(_ output: String, fields: [String]) -> [[String: Any]] {
    output
        .components(separatedBy: .newlines)
        .filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
        .compactMap { line in
            let parts = line.components(separatedBy: "||")
            guard parts.count == fields.count else { return nil }
            var dict: [String: Any] = [:]
            for (key, val) in zip(fields, parts) {
                dict[key] = val.trimmingCharacters(in: .whitespaces)
            }
            return dict
        }
}
