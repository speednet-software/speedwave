import Foundation
import XCTest
@testable import mail_cli

final class ScriptCompileTests: XCTestCase {
    private static let mailInfoPlist = URL(fileURLWithPath: "/System/Applications/Mail.app/Contents/Info.plist")
    private static let compileTimeout: TimeInterval = 60

    private func compileError(_ script: String) throws -> String? {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let source = directory.appendingPathComponent("script.applescript")
        try script.write(to: source, atomically: true, encoding: .utf8)
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/osacompile")
        process.arguments = ["-o", directory.appendingPathComponent("script.scpt").path, source.path]
        let stderr = Pipe()
        process.standardError = stderr
        let finished = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in finished.signal() }
        try process.run()
        guard finished.wait(timeout: .now() + Self.compileTimeout) == .success else {
            process.terminate()
            return "osacompile did not finish within \(Int(Self.compileTimeout)) s"
        }
        let message = String(data: stderr.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        return process.terminationStatus == 0 ? nil : message
    }

    func testMailShipsAStaticDictionarySoCompilingReadsItFromTheBundleWithoutLaunchingMail() throws {
        let data = try Data(contentsOf: Self.mailInfoPlist)
        let info = try XCTUnwrap(
            try PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])
        let sdef = try XCTUnwrap(info["OSAScriptingDefinition"] as? String)
        XCTAssertTrue(
            FileManager.default.fileExists(
                atPath: "/System/Applications/Mail.app/Contents/Resources/\(sdef)"), sdef)
    }

    func testEveryScriptOfEveryCommandCompilesAgainstMailsDictionary() throws {
        for call in MailCommandCall.all {
            let scripts = try call.scripts()
            XCTAssertFalse(scripts.isEmpty, call.command)
            for script in scripts {
                XCTAssertNil(try compileError(script), "\(call.command):\n\(script)")
            }
        }
    }
}
