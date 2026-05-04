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
}

public enum PermissionEntity: String {
    case calendar
    case reminders
}

/// SSOT: bundle identifier literal. Must match `desktop/src-tauri/tauri.conf.json::identifier`.
/// A bats test (`bundle ID in tauri.conf.json matches Swift literal`) guards drift.
public let speedwaveBundleIdentifier: String = "pl.speedwave.desktop"

/// Returns `Bundle.main.bundleIdentifier` when launched from the parent .app,
/// otherwise falls back to `speedwaveBundleIdentifier`. The internal variant
/// accepts an explicit input for testability — production calls use the no-arg
/// overload, which always reads from `Bundle.main`.
public func resolvedBundleIdentifier() -> String {
    resolvedBundleIdentifier(from: Bundle.main.bundleIdentifier)
}

public func resolvedBundleIdentifier(from rawBundleId: String?) -> String {
    rawBundleId ?? speedwaveBundleIdentifier
}

/// Backward-compatible overload for callers that don't have a PermissionStatus
/// (e.g. mail-cli and notes-cli which use Apple Events, not EventKit).
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
        return #"{"granted": false, "status": "silentReject", "error": "Failed to serialize permission result"}"#
    }
    return json
}

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

public func composeErrorMessage(
    status: PermissionStatus,
    entity: PermissionEntity,
    bundleId: String = resolvedBundleIdentifier()
) -> String {
    // (M1) Use enum rawValue.capitalized — eliminates ternary, single source.
    let entityName = entity.rawValue.capitalized
    let resetCmd = "tccutil reset \(entityName) \(bundleId)"
    let settingsPath = "System Settings > Privacy & Security > \(entityName)"
    switch status {
    case .granted:
        return ""  // never composed for granted
    case .denied:
        // (H3 v1 carryover) explicit recovery: Apple removed the + button on macOS 14+,
        // so users cannot re-add Speedwave from Settings UI; tccutil reset is the only path.
        return "\(entityName) access was previously denied. Open Terminal and run:\n\(resetCmd)\nThen click the toggle again."
    case .restricted:
        return "\(entityName) access restricted by your administrator or parental controls."
    case .notDetermined:
        // (M4) Defensive: unreachable in current performCheckPermission flow (status-before-request
        // gate plus post-request remap of .notDetermined to .silentReject), but kept for exhaustive
        // switch coverage and future direct callers. The parametric
        // testGrantedFalseAlwaysCarriesNonEmptyError test relies on this case returning non-empty.
        return "\(entityName) permission was not requested. Quit Speedwave and reopen, then click the toggle again."
    case .writeOnly:
        return "Speedwave has write-only \(entityName) access. Open \(settingsPath) and grant Full Access for read support."
    case .silentReject:
        return "\(entityName) permission was silently rejected by macOS. This usually means a signing or entitlement problem — please reinstall Speedwave from a fresh download."
    }
}

public protocol PermissionGate {
    func authorizationStatus() -> EKAuthorizationStatus
    func requestAccess(completion: @escaping (Bool, Error?) -> Void)
}

public func performCheckPermission(gate: PermissionGate, entity: PermissionEntity, timeout: TimeInterval = 65) -> String {
    let initial = mapAuthorizationStatus(gate.authorizationStatus())

    // Already in a terminal state — don't trigger a request that would return
    // the cached value silently. This is the core fix for the bug where
    // requestFullAccessToEvents returns granted=false without prompting when
    // current status is .denied.
    if initial != .notDetermined {
        let granted = (initial == .granted)
        let err = granted ? nil : composeErrorMessage(status: initial, entity: entity)
        return formatPermissionResult(granted: granted, status: initial, error: err)
    }

    // Status is .notDetermined — fire the request and wait for the prompt.
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
        return formatPermissionResult(
            granted: false,
            status: .silentReject,
            error: "\(entity.rawValue.capitalized) permission dialog timed out after \(Int(timeout))s. The TCC system is unresponsive — please retry or reboot."
        )
    }

    // Re-query status to disambiguate "user clicked Don't Allow" from "TCC silently rejected"
    // and to enforce the invariant that the post-status is the source of truth (a request
    // can return granted=true while a stale TCC entry remains denied; we trust post-status).
    let postStatus = mapAuthorizationStatus(gate.authorizationStatus())
    let final: PermissionStatus
    if requestGranted && postStatus == .granted {
        final = .granted
    } else if postStatus == .notDetermined {
        // Prompt never fired. Almost always usage-description / entitlement / signing.
        final = .silentReject
    } else {
        // Post-status trumps requestGranted — covers the (rare) case where the request
        // returned granted=true but TCC.db settled to a different state.
        final = postStatus
    }
    let err: String?
    if final == .granted {
        err = nil
    } else if let underlying = requestError {
        // Prefer Apple's localized description if present (legacy parity), but always non-nil.
        err = "\(composeErrorMessage(status: final, entity: entity))\n[underlying: \(underlying.localizedDescription)]"
    } else {
        err = composeErrorMessage(status: final, entity: entity)
    }
    return formatPermissionResult(granted: final == .granted, status: final, error: err)
}
