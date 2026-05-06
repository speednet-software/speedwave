import XCTest
@testable import SharedCLI

/// Tests for `AppleEventsGate`'s two-stage authorization flow.
///
/// Real `NSWorkspacePidResolver` is not exercised here because it depends on
/// the host's running-application list (non-deterministic in unit tests).
/// Instead a `FakePidResolver` injects scripted PID values, which lets us
/// verify that:
///   - When the resolver returns `nil`, the gate short-circuits with
///     `.targetNotRunning(bundleId:)` *without* invoking the real AE call.
///     This is the new behaviour that the procNotFound bug-fix relies on.
///   - When the resolver returns a PID, the gate proceeds to `AECreateDesc` +
///     `AEDeterminePermissionToAutomateTarget`. The OSStatus that comes back
///     is platform-dependent (depends on whether the calling test process is
///     authorized to send events to the target), so we assert on the
///     *category* of result (one of the documented `RawAuthorizationStatus`
///     cases) rather than on a specific value.
///
/// The OSStatus → RawAuthorizationStatus mapping itself is tested separately
/// in `UtilitiesTests.swift::testMapAEStatus*`.
final class AppleEventsGateTests: XCTestCase {

    /// Records how many times `pid(for:)` was called and with which bundle ids,
    /// returning a scripted result. Used to assert that the gate consults the
    /// resolver before the AE call, and that the gate caches/reuses the value
    /// correctly across `authorizationStatus()` and `requestAccess`.
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

    // MARK: - Stage 1: NSWorkspace short-circuit

    func testTargetNotRunningWhenResolverReturnsNil() {
        // The resolver maps no bundle ids → first stage returns nil → the gate
        // must short-circuit *without* calling AE. This is what gives users the
        // correct "open the app" hint instead of a misleading TCC reset
        // suggestion when the target really isn't running.
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
        // Even when the resolver does have an entry, the gate must consult it
        // first so that we never make an AE call against a stale ASN. We
        // assert the resolver was invoked; the AE call's outcome is platform-
        // dependent and not asserted on (covered by mapAEStatusToRaw tests).
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
        // The .targetNotRunning case must propagate the *queried* bundle id
        // (not, say, a hard-coded com.apple.mail). Composer messages and the
        // unified logs ZIP rely on this for accurate user-facing copy.
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

    // MARK: - Stage 2: PID-based AEAddressDesc

    func testProducesValidStatusWhenResolverReturnsPidForCallingProcess() throws {
        // Use the test process's own PID — guaranteed to be running, so
        // AECreateDesc + AEDeterminePermissionToAutomateTarget will see a live
        // ASN. We can't predict whether xctest is authorized to send events
        // to itself (depends on TCC.db state of the test runner), so we
        // assert only that the result is one of the documented enum cases —
        // never `.targetNotRunning` (which is the bug we're guarding against).
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

        // The exact value is non-deterministic across CI environments, but it
        // must NOT be .targetNotRunning — the resolver returned a live PID, so
        // the gate must have proceeded to AE and got *some* outcome.
        if case .targetNotRunning = raw {
            XCTFail(
                "Gate must NOT return .targetNotRunning when resolver gave a PID — that would indicate the bug is back. Got \(raw)"
            )
        }
    }

    // MARK: - requestAccess delegates to determineStatus(askUserIfNeeded: true)

    func testRequestAccessShortCircuitsWhenResolverReturnsNil() {
        // requestAccess shares the determineStatus pipeline. With a nil
        // resolver, the request completion fires with granted=false (because
        // .targetNotRunning is not granted) but no AE call happens.
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

    // MARK: - NSWorkspacePidResolver real-impl smoke

    func testNSWorkspacePidResolverReturnsNilForUnknownBundleId() {
        // The production resolver returns nil for a bundle id that LaunchServices
        // does not know about. Use a synthetic value that cannot collide with any
        // running app. This validates the resolver's nil path against the real
        // NSWorkspace API without depending on what's installed on CI.
        let resolver = NSWorkspacePidResolver()

        let pid = resolver.pid(for: "pl.speedwave.testing.does-not-exist-\(UUID().uuidString)")

        XCTAssertNil(pid, "Production resolver must return nil for unknown bundle ids")
    }

    func testNSWorkspacePidResolverReturnsPositivePidForRunningApp() throws {
        // The production resolver should match at least one running app — the
        // test runner itself. We use Bundle.main as a stable, always-running
        // reference. Skip if Bundle.main lacks a bundle id (Linux CI guard,
        // even though this whole test target is macOS-only).
        guard let ownBundle = Bundle.main.bundleIdentifier else {
            throw XCTSkip("Bundle.main has no identifier in this test runner")
        }
        let resolver = NSWorkspacePidResolver()

        let pid = resolver.pid(for: ownBundle)

        // pid may be nil if the test runner happens to run as a non-NSApplication
        // process (e.g. swift test from the CLI). In that case we cannot validate
        // a positive match without spawning a helper app — accept skip rather
        // than a flaky failure.
        if pid == nil {
            throw XCTSkip(
                "Test runner has no NSRunningApplication entry for \(ownBundle); positive resolver path is covered by manual smoke"
            )
        }
        XCTAssertGreaterThan(pid!, 0, "Resolved PID must be a positive integer")
    }
}
