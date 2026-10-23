import Foundation
import SharedCLI
import XCTest
@testable import mail_cli

final class FakeScriptExecutor {
    struct Call {
        let script: String
        let timeout: TimeInterval
    }

    private(set) var calls: [Call] = []
    private var replies: [Result<String, Error>] = []

    func reply(_ output: String) {
        replies.append(.success(output))
    }

    func fail(_ error: Error) {
        replies.append(.failure(error))
    }

    func execute(_ script: String, _ timeout: TimeInterval) throws -> String {
        calls.append(Call(script: script, timeout: timeout))
        guard !replies.isEmpty else { return "" }
        return try replies.removeFirst().get()
    }
}

enum HarnessError: Error {
    case unknownCommand(String)
    case succeeded(String)
}

struct MailCommandHarness {
    static let scriptTimeoutMs = 25_000

    let executor = FakeScriptExecutor()

    func call(_ command: String, _ params: [String: Any] = [:]) throws -> [String: Any] {
        let commands = mailCommands(executor: executor.execute)
        guard let handler = commands[command] else {
            throw HarnessError.unknownCommand(command)
        }
        var withBudget = params
        if withBudget[scriptTimeoutParam] == nil {
            withBudget[scriptTimeoutParam] = Self.scriptTimeoutMs
        }
        let result = try handler(withBudget)
        let data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    func callFailing(_ command: String, _ params: [String: Any] = [:]) -> Error {
        do {
            _ = try call(command, params)
            return HarnessError.succeeded(command)
        } catch {
            return error
        }
    }
}
