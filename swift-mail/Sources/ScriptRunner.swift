import Foundation

/// Executes AppleScript via osascript subprocess with timeout support.
enum ScriptRunner {
    /// Run an AppleScript and return stdout. Throws on non-zero exit or timeout.
    /// Default timeout is 15s (shorter than swift-notes' 30s because mail operations rarely involve large attachments).
    static func run(_ script: String, timeout: TimeInterval = 15) throws -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        process.arguments = ["-e", script]

        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe

        try process.run()

        let deadline = Date().addingTimeInterval(timeout)
        while process.isRunning && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.1)
        }

        if process.isRunning {
            process.terminate()
            process.waitUntilExit()
            throw ScriptError.timeout(timeout)
        }

        process.waitUntilExit()

        let stdoutData = stdoutPipe.fileHandleForReading.readDataToEndOfFile()
        let stderrData = stderrPipe.fileHandleForReading.readDataToEndOfFile()
        let stdout = String(data: stdoutData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let stderr = String(data: stderrData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""

        guard process.terminationStatus == 0 else {
            if stderr.contains("not allowed") || stderr.contains("not permitted") || stderr.contains("assistive access") {
                throw ScriptError.automationPermission(stderr)
            }
            throw ScriptError.scriptFailed(stderr)
        }

        return stdout
    }
}

enum ScriptError: LocalizedError {
    case scriptFailed(String)
    case automationPermission(String)
    case timeout(TimeInterval)

    var errorDescription: String? {
        switch self {
        case .scriptFailed(let msg):
            return "AppleScript error: \(msg)"
        case .automationPermission(let msg):
            return "Automation permission denied: \(msg)\nGrant access in System Settings > Privacy & Security > Automation"
        case .timeout(let seconds):
            return "AppleScript timed out after \(Int(seconds))s"
        }
    }
}

/// Escape special characters for AppleScript string literals.
/// Strips C0 control characters (U+0000–U+001F), DEL (U+007F), and Unicode
/// line separators (U+0085 NEL, U+2028, U+2029) before escaping.
/// Prevents injection via newline/CR-based script breakout.
func escapeAppleScript(_ s: String) -> String {
    let safe = String(s.unicodeScalars.filter { scalar in
        let v = scalar.value
        return v > 0x1F && v != 0x7F && v != 0x85 && v != 0x2028 && v != 0x2029
    })
    return safe
        .replacingOccurrences(of: "\\", with: "\\\\")
        .replacingOccurrences(of: "\"", with: "\\\"")
}
