import AppKit
import CoreServices
import Foundation

/// Permission gate for AppleEvents-based integrations (Mail, Notes).
/// Two-stage authorization (NSWorkspace pid → `typeKernelProcessID` AEAddressDesc).
/// See docs/adr/ADR-070-appleevents-kernel-process-id-gate.md.
public struct AppleEventsGate: PermissionGate {
    public let targetBundleId: String
    public let dataAccessScript: String?
    public let dataAccessTimeout: TimeInterval
    let pidResolver: PidResolver
    let appLauncher: AppLauncher

    /// Pass `NeverLaunchAppLauncher()` to disable auto-launch in passive flows;
    /// the default `NSWorkspaceAppLauncher` auto-launches on toggle clicks.
    public init(
        targetBundleId: String,
        dataAccessScript: String? = nil,
        dataAccessTimeout: TimeInterval = 15,
        pidResolver: PidResolver = NSWorkspacePidResolver(),
        appLauncher: AppLauncher = NSWorkspaceAppLauncher()
    ) {
        self.targetBundleId = targetBundleId
        self.dataAccessScript = dataAccessScript
        self.dataAccessTimeout = dataAccessTimeout
        self.pidResolver = pidResolver
        self.appLauncher = appLauncher
    }

    public func authorizationStatus() -> RawAuthorizationStatus {
        determineStatus(askUserIfNeeded: false)
    }

    public func requestAccess(completion: @escaping (Bool, Error?) -> Void) {
        // askUserIfNeeded=true triggers the TCC consent dialog.
        DispatchQueue.global().async {
            let status = self.determineStatus(askUserIfNeeded: true)
            completion(status == .granted, nil)
        }
    }

    public func verifyDataAccess() -> String? {
        guard let script = dataAccessScript else { return nil }
        do {
            _ = try ScriptRunner.run(script, timeout: dataAccessTimeout)
            return nil
        } catch let err as ScriptError {
            return err.errorDescription ?? "\(err)"
        } catch {
            return error.localizedDescription
        }
    }

    /// Two-stage authorization status check with optional auto-launch.
    /// `askUserIfNeeded=true` (toggle click) auto-launches the target app
    /// if it is not running; `false` (startup validator) does not.
    func determineStatus(askUserIfNeeded: Bool) -> RawAuthorizationStatus {
        logTrace("AEDETERMINE start target=\(targetBundleId) askUserIfNeeded=\(askUserIfNeeded)")

        var resolved = pidResolver.pid(for: targetBundleId)
        if resolved == nil && askUserIfNeeded {
            resolved = launchAndAwaitPid()
        }
        guard let pid = resolved else {
            logTrace(
                "AEDETERMINE skip target=\(targetBundleId) — process not running per NSWorkspace"
            )
            return .targetNotRunning(bundleId: targetBundleId)
        }
        logTrace("AEDETERMINE host-pid target=\(targetBundleId) pid=\(pid)")

        // Stage 2: AEAddressDesc with typeKernelProcessID (4-byte pid_t).
        var pidValue: pid_t = pid
        var target = AEAddressDesc()
        let createStatus: OSStatus = withUnsafePointer(to: &pidValue) { ptr in
            OSStatus(
                AECreateDesc(
                    typeKernelProcessID,
                    ptr,
                    MemoryLayout<pid_t>.size,
                    &target
                )
            )
        }
        guard createStatus == noErr else {
            logTrace(
                "AECreateDesc(typeKernelProcessID, pid=\(pid)) failed status=\(createStatus) → .unknown"
            )
            return .unknown
        }
        defer { AEDisposeDesc(&target) }

        let status = AEDeterminePermissionToAutomateTarget(
            &target,
            typeWildCard,
            typeWildCard,
            askUserIfNeeded
        )
        let raw = mapAEStatusToRaw(status, targetBundleId: targetBundleId)
        logTrace(
            "AEDETERMINE done target=\(targetBundleId) pid=\(pid) askUserIfNeeded=\(askUserIfNeeded) OSStatus=\(status) → \(describeRaw(raw))"
        )
        return raw
    }

    /// Launches the target app via the injected `appLauncher` and resolves
    /// its PID. Tests inject `NeverLaunchAppLauncher` to skip real launch.
    private func launchAndAwaitPid() -> pid_t? {
        switch appLauncher.launch(bundleId: targetBundleId) {
        case .succeeded(let pid):
            logTrace("AELAUNCH ok target=\(targetBundleId) pid=\(pid)")
            return pid
        case .failed(let reason):
            logTrace("AELAUNCH failed target=\(targetBundleId) — \(reason)")
            return nil
        case .notSupported:
            logTrace("AELAUNCH not supported for target=\(targetBundleId)")
            return nil
        }
    }
}

// MARK: - PID resolver (LaunchServices abstraction)

/// Resolves a bundle identifier to the running process's PID, or `nil` when
/// the target app is not currently running.
public protocol PidResolver {
    func pid(for bundleId: String) -> pid_t?
}

/// Production resolver. Uses `NSRunningApplication.runningApplications(withBundleIdentifier:)`
/// (per-call snapshot — `NSWorkspace.shared.runningApplications` would cache
/// until the next NSRunLoop turn, which never happens in a CLI process).
public struct NSWorkspacePidResolver: PidResolver {
    public init() {}

    public func pid(for bundleId: String) -> pid_t? {
        NSRunningApplication.runningApplications(withBundleIdentifier: bundleId)
            .first?.processIdentifier
    }
}

// MARK: - App launcher (NSWorkspace.openApplication abstraction)

public enum AppLaunchOutcome {
    case succeeded(pid_t)
    case failed(String)
    case notSupported  // urlForApplication returned nil — bundle id not installed
}

/// Launches a macOS app by bundle id. Abstracted as a protocol so unit tests
/// can avoid actually opening Mail.app / Notes.app on the developer's machine.
public protocol AppLauncher {
    func launch(bundleId: String) -> AppLaunchOutcome
}

/// Production launcher — uses `NSWorkspace.openApplication`.
public struct NSWorkspaceAppLauncher: AppLauncher {
    public init() {}

    public func launch(bundleId: String) -> AppLaunchOutcome {
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) else {
            return .notSupported
        }
        let semaphore = DispatchSemaphore(value: 0)
        var launchError: Error?
        var launchedPid: pid_t?
        let cfg = NSWorkspace.OpenConfiguration()
        cfg.activates = true
        NSWorkspace.shared.openApplication(at: url, configuration: cfg) { app, error in
            launchError = error
            launchedPid = app?.processIdentifier
            semaphore.signal()
        }
        _ = semaphore.wait(timeout: .now() + 10)
        if let err = launchError {
            return .failed(err.localizedDescription)
        }
        if let pid = launchedPid {
            return .succeeded(pid)
        }
        return .failed("openApplication completion returned no NSRunningApplication")
    }
}

/// Passive-mode launcher: declines launch by design, returning `.notSupported`
/// (used in CLI's `check_permission` without `--launch`, and in tests).
public struct NeverLaunchAppLauncher: AppLauncher {
    public init() {}
    public func launch(bundleId _: String) -> AppLaunchOutcome {
        .notSupported
    }
}

// MARK: - stderr trace + RawAuthorizationStatus debug helpers

/// Writes a `[SHARED]`-prefixed trace line to stderr, collected by the Rust
/// parent's `check_os_permission` and forwarded to the unified log.
public func logTrace(_ message: String) {
    let line = "[SHARED] \(message)\n"
    FileHandle.standardError.write(Data(line.utf8))
}

private func describeRaw(_ raw: RawAuthorizationStatus) -> String {
    switch raw {
    case .granted: return "granted"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "notDetermined"
    case .writeOnly: return "writeOnly"
    case .targetNotRunning(let bid): return "targetNotRunning(\(bid))"
    case .unknown: return "unknown"
    }
}

// MARK: - OSStatus mapping

/// SSOT mapping for AEDeterminePermissionToAutomateTarget OSStatus → RawAuthorizationStatus.
/// - `noErr (0)`: granted
/// - `errAEEventNotPermitted (-1743)`: denied
/// - `errAEEventWouldRequireUserConsent (-1744)`: not yet prompted (askUserIfNeeded=false)
/// - `procNotFound (-600)`: target app not running
public func mapAEStatusToRaw(_ status: OSStatus, targetBundleId: String) -> RawAuthorizationStatus {
    switch Int(status) {
    case 0:                                       // noErr
        return .granted
    case -1743:                                   // errAEEventNotPermitted
        return .denied
    case -1744:                                   // errAEEventWouldRequireUserConsent
        return .notDetermined
    case -600:                                    // procNotFound
        return .targetNotRunning(bundleId: targetBundleId)
    default:
        return .unknown
    }
}
