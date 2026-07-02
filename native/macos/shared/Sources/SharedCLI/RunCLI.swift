import Foundation

/// Shared `main()` scaffold for the native macOS CLIs: arg parsing, permission
/// check, optional access guard, command dispatch, and JSON output.
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
