import Foundation

public func exitWithError(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

public func formatPermissionResult(granted: Bool, error: String?) -> String {
    var dict: [String: Any] = ["granted": granted]
    if let error = error {
        dict["error"] = error
    }
    guard let data = try? JSONSerialization.data(withJSONObject: dict, options: [.sortedKeys]),
          let json = String(data: data, encoding: .utf8) else {
        return #"{"granted": false, "error": "Failed to serialize permission result"}"#
    }
    return json
}
