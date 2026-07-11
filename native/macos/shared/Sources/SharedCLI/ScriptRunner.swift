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

/// True if `stderr` is AppleScript's "Can't get <noun> ..." (-1728), i.e. a name-lookup miss.
/// Callers rethrow a domain-specific `CLIError.notFound` instead of the raw AppleScript text.
public func isAppleScriptNotFoundError(_ stderr: String) -> Bool {
    stderr.contains("Can\u{2019}t get") || stderr.contains("(-1728)")
}

/// True when `stderr` is a -1728 miss that names `specifier`, so a not-found rewrite
/// fires only for the scoped folder/note, not an unrelated element in the same script.
public func appleScriptNotFoundNames(_ stderr: String, _ specifier: String) -> Bool {
    !specifier.isEmpty && isAppleScriptNotFoundError(stderr) && stderr.contains(specifier)
}

/// Split a comma-separated address list into trimmed, non-empty addresses. Quote-aware: commas inside
/// a double-quoted span don't split; an unbalanced quote count falls back to a naive comma split.
public func splitAddressList(_ addresses: String) -> [String] {
    var entries: [String] = []
    var current = ""
    var insideQuotes = false

    for char in addresses {
        if char == "\"" {
            insideQuotes.toggle()
            current.append(char)
        } else if char == "," && !insideQuotes {
            entries.append(current)
            current = ""
        } else {
            current.append(char)
        }
    }
    entries.append(current)

    if insideQuotes {
        entries = addresses.components(separatedBy: ",")
    }

    return entries
        .map { $0.trimmingCharacters(in: .whitespaces) }
        .filter { !$0.isEmpty }
}

/// Escape AppleScript string literals; strips C0/DEL/line-separator scalars first.
public func escapeAppleScript(_ s: String) -> String {
    let safe = String(s.unicodeScalars.filter { scalar in
        let v = scalar.value
        return v > 0x1F && v != 0x7F && v != 0x85 && v != 0x2028 && v != 0x2029
    })
    return safe
        .replacingOccurrences(of: "\\", with: "\\\\")
        .replacingOccurrences(of: "\"", with: "\\\"")
}

/// Parse `||`-delimited email row (subject||sender||date||read||to-list||body); throws if <6 fields.
public func parseEmailDetail(_ output: String, id: String) throws -> [String: Any] {
    let parts = output.components(separatedBy: "||")
    guard parts.count >= 6 else {
        throw ScriptError.scriptFailed("Unexpected email format")
    }
    return [
        "id": id,
        "subject": parts[0].trimmingCharacters(in: .whitespaces),
        "sender": parts[1].trimmingCharacters(in: .whitespaces),
        "date": parts[2].trimmingCharacters(in: .whitespaces),
        "read": parts[3].trimmingCharacters(in: .whitespaces) == "true",
        "to": parts[4]
            .components(separatedBy: ",")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty },
        "body": parts[5...].joined(separator: "||").trimmingCharacters(in: .whitespaces),
    ]
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
