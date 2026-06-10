import Foundation

/// Shared `main()` scaffold for the native macOS CLIs (calendar/reminders/mail/notes).
///
/// Handles the identical skeleton: arg-count check, `check_permission`
/// short-circuit, JSON-args decode, optional access-gate guard, command
/// dispatch, and pretty-printed JSON output. Each CLI supplies only its name,
/// command list, permission gate, optional access guard, and command table.
///
/// - `checkPermissionGate`: receives the full argv (so AppleEvents CLIs can read
///   the `--launch` flag) and returns the gate used for `check_permission`.
/// - `accessGuard`: runs once before dispatch for non-`check_permission`
///   commands; returns `nil` on success or an error message to exit with.
///   Defaults to a no-op (mail/notes have no EventKit access gate).
/// - `commands`: maps command name to a handler producing a JSON-serializable value.
public func runCLI(
    arguments: [String] = CommandLine.arguments,
    cliName: String,
    commandList: String,
    entity: PermissionEntity,
    checkPermissionGate: (_ arguments: [String]) -> PermissionGate,
    accessGuard: () -> String? = { nil },
    commands: [String: (_ params: [String: Any]) throws -> Any]
) -> Never {
    guard arguments.count >= 2 else {
        exitWithError("Usage: \(cliName) <command> [json-args]\nCommands: \(commandList)")
    }

    let command = arguments[1]

    if command == "check_permission" {
        print(performCheckPermission(gate: checkPermissionGate(arguments), entity: entity))
        exit(0)
    }

    let jsonArgs = arguments.count >= 3 ? arguments[2] : "{}"
    guard let argsData = jsonArgs.data(using: .utf8),
          let params = try? JSONSerialization.jsonObject(with: argsData) as? [String: Any]
    else {
        exitWithError("Invalid JSON arguments: \(jsonArgs)")
    }

    if let accessError = accessGuard() {
        exitWithError(accessError)
    }

    guard let handler = commands[command] else {
        exitWithError("Unknown command: \(command)\nAvailable: \(commandList)")
    }

    do {
        let result = try handler(params)
        let data = try JSONSerialization.data(
            withJSONObject: result,
            options: [.prettyPrinted, .sortedKeys]
        )
        if let json = String(data: data, encoding: .utf8) {
            print(json)
        }
    } catch {
        exitWithError(error.localizedDescription)
    }
    exit(0)
}
