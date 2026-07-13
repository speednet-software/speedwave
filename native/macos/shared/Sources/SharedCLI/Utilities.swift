import EventKit
import Foundation

public func exitWithError(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

public enum PermissionStatus: String {
    case granted          // .fullAccess (macOS 14+) or .authorized (macOS 13)
    case denied           // .denied — user explicitly denied; tccutil reset required
    case restricted       // .restricted — parental controls / MDM
    case notDetermined    // .notDetermined — first-run; consent prompt should appear next launch
    case writeOnly        // .writeOnly — partial access (Calendars only, macOS 14+)
    case silentReject     // status remained .notDetermined after request, OR @unknown raw value
    case targetNotRunning // AE-only: target app (Mail/Notes) not running, not a TCC issue
}

/// Internal status produced by gates (EventKit gates map EKAuthorizationStatus, AppleEvents gates map OSStatus).
/// `mapRawToPermissionStatus` projects this onto the public `PermissionStatus`.
public enum RawAuthorizationStatus: Equatable {
    case granted
    case denied
    case restricted
    case notDetermined
    case writeOnly                            // EventKit-only (Calendar)
    case targetNotRunning(bundleId: String)   // AppleEvents-only: procNotFound (-600)
    case unknown                              // @unknown EK / unmapped OSStatus
}

public enum PermissionEntity: String {
    case calendar
    case reminders
    case mail
    case notes
}

/// SSOT: parent bundle identifier literal. Must match `desktop/src-tauri/tauri.conf.json::identifier`
/// (drift-guarded by a bats test). Per-CLI binaries embed `pl.speedwave.desktop.<entity>` via `subBundleIdentifier(for:)`.
public let speedwaveBundleIdentifier: String = "pl.speedwave.desktop"

/// Per-entity sub-identifier used as `CFBundleIdentifier` of each CLI binary's embedded
/// Info.plist. TCC binds to this identifier, so `tccutil reset` targets the correct row.
public func subBundleIdentifier(for entity: PermissionEntity) -> String {
    "\(speedwaveBundleIdentifier).\(entity.rawValue)"
}

/// kTCCService name used by the `tccutil reset <service> <bundleId>` command.
/// Calendar/Reminders have dedicated TCC services; Mail and Notes both use AppleEvents.
public func tccServiceName(for entity: PermissionEntity) -> String {
    switch entity {
    case .calendar: return "Calendar"
    case .reminders: return "Reminders"
    case .mail, .notes: return "AppleEvents"
    }
}

/// Returns `Bundle.main.bundleIdentifier` when launched from the parent .app,
/// otherwise falls back to `speedwaveBundleIdentifier`.
public func resolvedBundleIdentifier() -> String {
    resolvedBundleIdentifier(from: Bundle.main.bundleIdentifier)
}

public func resolvedBundleIdentifier(from rawBundleId: String?) -> String {
    rawBundleId ?? speedwaveBundleIdentifier
}

/// Backward-compatible overload for callers that don't have a PermissionStatus.
/// Infers status from granted flag; denied case uses .silentReject as a conservative default.
public func formatPermissionResult(granted: Bool, error: String?) -> String {
    let status: PermissionStatus = granted ? .granted : .silentReject
    return formatPermissionResult(granted: granted, status: status, error: error)
}

public func formatPermissionResult(granted: Bool, status: PermissionStatus, error: String?) -> String {
    var dict: [String: Any] = ["granted": granted, "status": status.rawValue]
    if let error = error, !error.isEmpty {
        dict["error"] = error
    }
    guard let data = try? JSONSerialization.data(withJSONObject: dict, options: [.sortedKeys]),
          let json = String(data: data, encoding: .utf8) else {
        return #"{"error":"Failed to serialize permission result","granted":false,"status":"silentReject"}"#
    }
    return json
}

/// Public legacy mapping kept for direct callers (existing tests cover all branches).
/// New gates produce `RawAuthorizationStatus` via `mapEventKitStatusToRaw` / OSStatus mapping.
public func mapAuthorizationStatus(_ raw: EKAuthorizationStatus) -> PermissionStatus {
    switch raw {
    case .notDetermined: return .notDetermined
    case .restricted: return .restricted
    case .denied: return .denied
    case .authorized: return .granted              // macOS 13 legacy
    case .fullAccess: return .granted              // macOS 14+
    case .writeOnly: return .writeOnly             // macOS 14+, Calendar only
    @unknown default: return .silentReject         // explicit @unknown default
    }
}

public func mapEventKitStatusToRaw(_ raw: EKAuthorizationStatus) -> RawAuthorizationStatus {
    switch raw {
    case .notDetermined: return .notDetermined
    case .restricted: return .restricted
    case .denied: return .denied
    case .authorized: return .granted
    case .fullAccess: return .granted
    case .writeOnly: return .writeOnly
    @unknown default: return .unknown
    }
}

public func mapRawToPermissionStatus(_ raw: RawAuthorizationStatus) -> PermissionStatus {
    switch raw {
    case .granted: return .granted
    case .denied: return .denied
    case .restricted: return .restricted
    case .notDetermined: return .notDetermined
    case .writeOnly: return .writeOnly
    case .targetNotRunning: return .targetNotRunning
    case .unknown: return .silentReject
    }
}

public func composeErrorMessage(
    status: PermissionStatus,
    entity: PermissionEntity,
    bundleId: String? = nil
) -> String {
    let resolvedBundleId = bundleId ?? subBundleIdentifier(for: entity)
    let entityName = entity.rawValue.capitalized
    let serviceName = tccServiceName(for: entity)
    let resetCmd = "tccutil reset \(serviceName) \(resolvedBundleId)"
    let settingsPath = "System Settings > Privacy & Security > \(entityName)"
    switch status {
    case .granted:
        return ""
    case .denied:
        // macOS 14+ has no + button to re-add Speedwave; tccutil reset is the only recovery path.
        return "\(entityName) access was previously denied. Open Terminal and run:\n\(resetCmd)\nThen click the toggle again."
    case .restricted:
        return "\(entityName) access restricted by your administrator or parental controls."
    case .notDetermined:
        // Unreachable from performCheckPermission; kept for exhaustive switch coverage.
        return "\(entityName) permission was not requested. Quit Speedwave and reopen, then click the toggle again."
    case .writeOnly:
        return "Speedwave has write-only \(entityName) access. Open \(settingsPath) and grant Full Access for read support."
    case .silentReject:
        return "\(entityName) permission was silently rejected by macOS. This usually means a signing or entitlement problem — please reinstall Speedwave from a fresh download."
    case .targetNotRunning:
        // AE-only path (mail/notes). Not a TCC issue — do NOT mention tccutil here.
        return "\(entityName).app is not running. Open \(entityName).app and try again — this is not a permission problem."
    }
}

public protocol PermissionGate {
    func authorizationStatus() -> RawAuthorizationStatus
    func requestAccess(completion: @escaping (Bool, Error?) -> Void)
    /// Second-phase verification after TCC reports `.granted`.
    /// Returns nil on success, or an error string when TCC-granted but data is inaccessible.
    func verifyDataAccess() -> String?
}

public extension PermissionGate {
    func verifyDataAccess() -> String? { nil }
}

/// Inner timeout (default 55s) is shorter than the outer Rust 60s timeout
/// so Swift emits a structured timeout message before the parent kills it.
public func performCheckPermission(gate: PermissionGate, entity: PermissionEntity, timeout: TimeInterval = 55) -> String {
    logTrace("performCheckPermission start entity=\(entity.rawValue) timeout=\(Int(timeout))s")
    let initialRaw = gate.authorizationStatus()
    let initial = mapRawToPermissionStatus(initialRaw)
    logTrace("performCheckPermission initial entity=\(entity.rawValue) status=\(initial.rawValue)")

    // Short-circuit terminal states; `.targetNotRunning` falls through so requestAccess can auto-launch the target.
    if initial != .notDetermined && initial != .targetNotRunning {
        logTrace("performCheckPermission terminal-state short-circuit entity=\(entity.rawValue) final=\(initial.rawValue)")
        return finalizeResult(status: initial, entity: entity, gate: gate)
    }

    // Status is .notDetermined or .targetNotRunning — fire the request and wait.
    logTrace("performCheckPermission firing requestAccess entity=\(entity.rawValue)")
    let semaphore = DispatchSemaphore(value: 0)
    var requestGranted = false
    var requestError: Error?
    gate.requestAccess { granted, error in
        requestGranted = granted
        requestError = error
        semaphore.signal()
    }
    let waitResult = semaphore.wait(timeout: .now() + timeout)
    if waitResult == .timedOut {
        logTrace("performCheckPermission TIMEOUT entity=\(entity.rawValue) after=\(Int(timeout))s")
        return formatPermissionResult(
            granted: false,
            status: .silentReject,
            error: "\(entity.rawValue.capitalized) permission dialog timed out after \(Int(timeout))s. The TCC system is unresponsive — please retry or reboot."
        )
    }
    logTrace("performCheckPermission requestAccess returned entity=\(entity.rawValue) granted=\(requestGranted) error=\(requestError?.localizedDescription ?? "nil")")

    // Re-query status to disambiguate user-denied from silent-reject; post-status is source of truth.
    let postStatus = mapRawToPermissionStatus(gate.authorizationStatus())
    logTrace("performCheckPermission post-status entity=\(entity.rawValue) status=\(postStatus.rawValue)")
    let final: PermissionStatus
    if requestGranted && postStatus == .granted {
        final = .granted
    } else if postStatus == .notDetermined {
        // Prompt never fired. Almost always usage-description / entitlement / signing.
        final = .silentReject
        logTrace("performCheckPermission SILENT REJECT entity=\(entity.rawValue) — post-status remained notDetermined; check Info.plist usage description and code signature")
    } else {
        // Post-status trumps requestGranted (request can return granted=true while TCC.db settled to a different state).
        final = postStatus
    }
    logTrace("performCheckPermission done entity=\(entity.rawValue) final=\(final.rawValue)")
    return finalizeResult(status: final, entity: entity, gate: gate, requestError: requestError)
}

/// Builds the final JSON response, optionally running `gate.verifyDataAccess()` when status is `.granted`
/// (Mail/Notes data-access invariant), downgrading to `.silentReject` when data access fails despite TCC granting.
private func finalizeResult(
    status: PermissionStatus,
    entity: PermissionEntity,
    gate: PermissionGate,
    requestError: Error? = nil
) -> String {
    if status == .granted {
        logTrace("finalizeResult entity=\(entity.rawValue) status=granted — running verifyDataAccess()")
        if let dataAccessError = gate.verifyDataAccess() {
            // Granted by TCC but data access fails — surface as silentReject with gate-specific error.
            logTrace("finalizeResult entity=\(entity.rawValue) verifyDataAccess FAILED — downgrading granted→silentReject error=\(dataAccessError)")
            return formatPermissionResult(
                granted: false,
                status: .silentReject,
                error: "\(entity.rawValue.capitalized) permission granted by macOS but data access failed: \(dataAccessError)"
            )
        }
        logTrace("finalizeResult entity=\(entity.rawValue) GRANTED + data access OK")
        return formatPermissionResult(granted: true, status: .granted, error: nil)
    }

    let baseMessage = composeErrorMessage(status: status, entity: entity)
    let err: String
    if let underlying = requestError {
        err = "\(baseMessage)\n[underlying: \(underlying.localizedDescription)]"
    } else {
        err = baseMessage
    }
    logTrace("finalizeResult entity=\(entity.rawValue) status=\(status.rawValue) emitting error message")
    return formatPermissionResult(granted: false, status: status, error: err)
}
