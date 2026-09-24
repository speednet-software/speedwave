import XCTest
@testable import SharedCLI

/// Tests for `AppleEventsGate`'s two-stage authorization flow.
final class AppleEventsGateTests: XCTestCase {

    /// Records each `pid(for:)` call and returns a scripted PID.
    final class FakePidResolver: PidResolver {
        var pidByBundleId: [String: pid_t]
        private(set) var calls: [String] = []

        init(pidByBundleId: [String: pid_t] = [:]) {
            self.pidByBundleId = pidByBundleId
        }

        func pid(for bundleId: String) -> pid_t? {
            calls.append(bundleId)
            return pidByBundleId[bundleId]
        }
    }


    func testTargetNotRunningWhenResolverReturnsNil() {
        let resolver = FakePidResolver(pidByBundleId: [:])
        let gate = AppleEventsGate(
            targetBundleId: "com.apple.mail",
            dataAccessScript: nil,
            dataAccessTimeout: 1,
            pidResolver: resolver,
            appLauncher: NeverLaunchAppLauncher()
        )

        let raw = gate.authorizationStatus()

        guard case .targetNotRunning(let bid) = raw else {
            XCTFail("Expected .targetNotRunning when resolver returns nil, got \(raw)")
            return
        }
        XCTAssertEqual(bid, "com.apple.mail")
        XCTAssertEqual(resolver.calls, ["com.apple.mail"],
                       "Resolver must be queried exactly once per authorizationStatus()")
    }

    func testResolverIsConsultedBeforeAECall() {
        let resolver = FakePidResolver(pidByBundleId: ["com.apple.mail": 12345])
        let gate = AppleEventsGate(
            targetBundleId: "com.apple.mail",
            dataAccessScript: nil,
            dataAccessTimeout: 1,
            pidResolver: resolver,
            appLauncher: NeverLaunchAppLauncher()
        )

        _ = gate.authorizationStatus()

        XCTAssertEqual(resolver.calls.count, 1)
        XCTAssertEqual(resolver.calls.first, "com.apple.mail")
    }

    func testTargetNotRunningCarriesQueriedBundleId() {
        let resolver = FakePidResolver(pidByBundleId: [:])
        let gate = AppleEventsGate(
            targetBundleId: "com.apple.Notes",
            dataAccessScript: nil,
            dataAccessTimeout: 1,
            pidResolver: resolver,
            appLauncher: NeverLaunchAppLauncher()
        )

        let raw = gate.authorizationStatus()

        guard case .targetNotRunning(let bid) = raw else {
            XCTFail("Expected .targetNotRunning, got \(raw)")
            return
        }
        XCTAssertEqual(bid, "com.apple.Notes")
    }


    func testProducesValidStatusWhenResolverReturnsPidForCallingProcess() throws {
        let ownPid: pid_t = ProcessInfo.processInfo.processIdentifier
        let ownBundle = Bundle.main.bundleIdentifier ?? "test.process"
        let resolver = FakePidResolver(pidByBundleId: [ownBundle: ownPid])
        let gate = AppleEventsGate(
            targetBundleId: ownBundle,
            dataAccessScript: nil,
            dataAccessTimeout: 1,
            pidResolver: resolver,
            appLauncher: NeverLaunchAppLauncher()
        )

        let raw = gate.authorizationStatus()

        if case .targetNotRunning = raw {
            XCTFail(
                "Gate must NOT return .targetNotRunning when resolver gave a PID — that would indicate the bug is back. Got \(raw)"
            )
        }
    }


    func testRequestAccessShortCircuitsWhenResolverReturnsNil() {
        let resolver = FakePidResolver(pidByBundleId: [:])
        let gate = AppleEventsGate(
            targetBundleId: "com.apple.mail",
            dataAccessScript: nil,
            dataAccessTimeout: 1,
            pidResolver: resolver,
            appLauncher: NeverLaunchAppLauncher()
        )

        let exp = expectation(description: "requestAccess completes")
        var completionGranted: Bool?
        gate.requestAccess { granted, _ in
            completionGranted = granted
            exp.fulfill()
        }
        wait(for: [exp], timeout: 5)

        XCTAssertEqual(completionGranted, false,
                       "requestAccess for not-running target must complete with granted=false")
    }


    func testNSWorkspacePidResolverReturnsNilForUnknownBundleId() {
        let resolver = NSWorkspacePidResolver()

        let pid = resolver.pid(for: "pl.speedwave.testing.does-not-exist-\(UUID().uuidString)")

        XCTAssertNil(pid, "Production resolver must return nil for unknown bundle ids")
    }

    func testNSWorkspacePidResolverReturnsPositivePidForRunningApp() throws {
        guard let ownBundle = Bundle.main.bundleIdentifier else {
            throw XCTSkip("Bundle.main has no identifier in this test runner")
        }
        let resolver = NSWorkspacePidResolver()

        let pid = resolver.pid(for: ownBundle)

        if pid == nil {
            throw XCTSkip(
                "Test runner has no NSRunningApplication entry for \(ownBundle); positive resolver path is covered by manual smoke"
            )
        }
        XCTAssertGreaterThan(pid!, 0, "Resolved PID must be a positive integer")
    }
}
