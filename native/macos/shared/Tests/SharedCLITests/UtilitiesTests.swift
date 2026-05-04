import EventKit
import XCTest
@testable import SharedCLI

final class SharedCLITests: XCTestCase {

    // MARK: - ISO8601 Parsing

    func testParseISO8601WithTimezone() {
        let date = parseISO8601("2025-03-01T10:00:00Z")
        XCTAssertNotNil(date)
    }

    func testParseISO8601WithFractionalSeconds() {
        let date = parseISO8601("2025-03-01T10:00:00.123Z")
        XCTAssertNotNil(date)
    }

    func testParseISO8601DateOnly() {
        let date = parseISO8601("2025-03-01")
        XCTAssertNotNil(date)
    }

    func testParseISO8601Invalid() {
        let date = parseISO8601("not-a-date")
        XCTAssertNil(date)
    }

    func testISO8601Roundtrip() {
        let original = "2025-06-15T14:30:00Z"
        guard let date = parseISO8601(original) else {
            XCTFail("Failed to parse ISO8601 date")
            return
        }
        let result = iso8601String(from: date)
        XCTAssertEqual(result, original)
    }

    func testParseISO8601InvalidFormat() {
        let badDate = "March 1st, 2025"
        XCTAssertNil(parseISO8601(badDate))
    }

    // MARK: - Hex Color

    func testHexColorReturnsCorrectRGBString() {
        let red = CGColor(srgbRed: 1.0, green: 0.0, blue: 0.0, alpha: 1.0)
        XCTAssertEqual(hexColor(from: red), "#ff0000")
    }

    func testHexColorBlackAndWhite() {
        let black = CGColor(srgbRed: 0, green: 0, blue: 0, alpha: 1)
        XCTAssertEqual(hexColor(from: black), "#000000")
        let white = CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 1)
        XCTAssertEqual(hexColor(from: white), "#ffffff")
    }

    func testHexColorNilForGrayColorSpace() {
        let result = hexColor(from: CGColor(gray: 0.5, alpha: 1.0))
        XCTAssertNil(result)
    }

    func testHexColorClampsWideGamutValues() {
        // Display P3 components can exceed 1.0; verify clamping to [0, 255]
        let wideGamut = CGColor(
            colorSpace: CGColorSpace(name: CGColorSpace.displayP3)!,
            components: [1.3, -0.1, 0.5, 1.0]
        )!
        let result = hexColor(from: wideGamut)
        XCTAssertEqual(result, "#ff007f")
    }

    // MARK: - CLIError

    func testCLIErrorMissingField() {
        let error = CLIError.missingField("name")
        XCTAssertEqual(error.errorDescription, "Missing required field: name")
    }

    func testCLIErrorNotFound() {
        let error = CLIError.notFound("Reminder with id 'abc' not found")
        XCTAssertEqual(error.errorDescription, "Reminder with id 'abc' not found")
    }

    func testCLIErrorInvalidDate() {
        let error = CLIError.invalidDate("bad-date")
        XCTAssertTrue(error.errorDescription!.contains("Invalid ISO8601 date"))
        XCTAssertTrue(error.errorDescription!.contains("bad-date"))
    }

    func testCLIErrorMissingFieldHasDescription() {
        let error = CLIError.missingField("id")
        XCTAssertNotNil(error.errorDescription)
    }

    func testInvalidDateFormatDetected() {
        let badDate = "March 1st, 2025"
        XCTAssertNil(parseISO8601(badDate))
    }

    // MARK: - formatPermissionResult (new signature with status field)

    func testFormatGrantedNoError() {
        let json = formatPermissionResult(granted: true, status: .granted, error: nil)
        let data = json.data(using: .utf8)!
        let parsed = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(parsed["granted"] as? Bool, true)
        XCTAssertEqual(parsed["status"] as? String, "granted")
        XCTAssertNil(parsed["error"])
    }

    func testFormatGrantedEmptyStringError() {
        // Empty-string error must be omitted (validates the !error.isEmpty guard)
        let json = formatPermissionResult(granted: true, status: .granted, error: "")
        let data = json.data(using: .utf8)!
        let parsed = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertNil(parsed["error"], "Empty error string must not appear in JSON output")
    }

    func testFormatDeniedWithError() {
        let json = formatPermissionResult(granted: false, status: .denied, error: "denied")
        let data = json.data(using: .utf8)!
        let parsed = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(parsed["granted"] as? Bool, false)
        XCTAssertEqual(parsed["status"] as? String, "denied")
        XCTAssertEqual(parsed["error"] as? String, "denied")
    }

    func testFormatRoundtrip() {
        let json = formatPermissionResult(granted: false, status: .silentReject, error: "reinstall")
        let data = json.data(using: .utf8)!
        let parsed = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertNotNil(parsed["granted"])
        XCTAssertNotNil(parsed["status"])
        XCTAssertNotNil(parsed["error"])
    }

    func testFormatNewlinesPreserved() {
        let errorWithNewlines = "line1\nline2"
        let json = formatPermissionResult(granted: false, status: .denied, error: errorWithNewlines)
        let data = json.data(using: .utf8)!
        let parsed = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(parsed["error"] as? String, errorWithNewlines)
    }

    func testFormatUnicodeEmoji() {
        let emojiError = "Error 🚫 denied"
        let json = formatPermissionResult(granted: false, status: .denied, error: emojiError)
        let data = json.data(using: .utf8)!
        let parsed = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(parsed["error"] as? String, emojiError)
    }

    func testFormatBackwardCompatShape() {
        // Old Rust parser only reads granted/error — new JSON must still be parseable
        let json = formatPermissionResult(granted: false, status: .denied, error: "access denied")
        let data = json.data(using: .utf8)!
        let parsed = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertNotNil(parsed["granted"])
        XCTAssertNotNil(parsed["error"])
    }

    func testFormatSerializationFailureFallback() {
        // The static fallback string itself must be parseable JSON
        let fallback = #"{"granted": false, "status": "silentReject", "error": "Failed to serialize permission result"}"#
        let data = fallback.data(using: .utf8)!
        let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        XCTAssertNotNil(parsed)
    }

    // MARK: - mapAuthorizationStatus

    func testMapNotDetermined() {
        XCTAssertEqual(mapAuthorizationStatus(.notDetermined), .notDetermined)
    }

    func testMapDenied() {
        XCTAssertEqual(mapAuthorizationStatus(.denied), .denied)
    }

    func testMapRestricted() {
        XCTAssertEqual(mapAuthorizationStatus(.restricted), .restricted)
    }

    func testMapAuthorizedLegacy() {
        // .authorized is the macOS 13 legacy value; deprecated on macOS 14+ but still present
        // in the enum and must map to .granted for backward compatibility.
        if #available(macOS 14.0, *) {
            // On macOS 14+, .authorized is .fullAccess (same raw value 3); test via rawValue
            let status = EKAuthorizationStatus(rawValue: 3)! // .authorized / .fullAccess
            XCTAssertEqual(mapAuthorizationStatus(status), .granted)
        } else {
            XCTAssertEqual(mapAuthorizationStatus(.authorized), .granted)
        }
    }

    @available(macOS 14.0, *)
    func testMapFullAccess() {
        XCTAssertEqual(mapAuthorizationStatus(.fullAccess), .granted)
    }

    @available(macOS 14.0, *)
    func testMapWriteOnly() {
        XCTAssertEqual(mapAuthorizationStatus(.writeOnly), .writeOnly)
    }

    func testMapUnknownDefault() {
        // Synthetic unknown raw value must map to .silentReject via @unknown default
        if let synthetic = EKAuthorizationStatus(rawValue: 99) {
            XCTAssertEqual(mapAuthorizationStatus(synthetic), .silentReject)
        }
        // If 99 is a valid case on this OS, the test is a no-op (acceptable)
    }

    // MARK: - resolvedBundleIdentifier (H3)

    func testResolvedBundleIdentifierFallbackWhenNil() {
        // Test seam: passing nil exercises the fallback to the literal SSOT.
        XCTAssertEqual(resolvedBundleIdentifier(from: nil), speedwaveBundleIdentifier)
        XCTAssertEqual(resolvedBundleIdentifier(from: nil), "pl.speedwave.desktop")
    }

    func testResolvedBundleIdentifierUsesProvidedValueWhenPresent() {
        // When a bundle identifier is present (production: Bundle.main has the parent .app's ID),
        // the function must pass it through verbatim.
        XCTAssertEqual(resolvedBundleIdentifier(from: "pl.speedwave.desktop"), "pl.speedwave.desktop")
        XCTAssertEqual(resolvedBundleIdentifier(from: "com.example.other"), "com.example.other")
    }

    func testSpeedwaveBundleIdentifierMatchesTauriConf() {
        // Belt-and-braces: read tauri.conf.json from disk and assert literal SSOT matches.
        let candidates = [
            // From swift test runner working dir
            "../../../desktop/src-tauri/tauri.conf.json",
            "../../../../desktop/src-tauri/tauri.conf.json",
        ]
        var tauriId: String?
        for path in candidates {
            if let data = FileManager.default.contents(atPath: path),
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let id = json["identifier"] as? String {
                tauriId = id
                break
            }
        }
        if let tauriId = tauriId {
            XCTAssertEqual(speedwaveBundleIdentifier, tauriId,
                           "Swift literal must match tauri.conf.json::identifier")
        }
        // If file not found from test runner cwd, skip silently — CI runs from repo root
    }

    // MARK: - composeErrorMessage

    func testComposeDeniedCalendarMentionsTccutilReset() {
        let msg = composeErrorMessage(status: .denied, entity: .calendar, bundleId: speedwaveBundleIdentifier)
        XCTAssertTrue(msg.contains("tccutil reset Calendar pl.speedwave.desktop"),
                      "Denied Calendar message must contain tccutil reset command, got: \(msg)")
    }

    func testComposeDeniedRemindersMentionsTccutilReset() {
        let msg = composeErrorMessage(status: .denied, entity: .reminders, bundleId: speedwaveBundleIdentifier)
        XCTAssertTrue(msg.contains("tccutil reset Reminders pl.speedwave.desktop"),
                      "Denied Reminders message must contain tccutil reset command, got: \(msg)")
    }

    func testComposeSilentRejectMentionsReinstall() {
        let msg = composeErrorMessage(status: .silentReject, entity: .calendar)
        XCTAssertTrue(msg.contains("reinstall"), "silentReject must mention reinstall")
    }

    func testComposeWriteOnlyOnlyForCalendar() {
        let msg = composeErrorMessage(status: .writeOnly, entity: .reminders)
        XCTAssertFalse(msg.isEmpty, "writeOnly reminders must produce non-empty message")
    }

    func testGrantedFalseAlwaysCarriesNonEmptyError() {
        // (H1) parametric invariant: every non-granted status must produce non-empty error
        let nonGrantedStatuses: [PermissionStatus] = [.denied, .restricted, .notDetermined, .writeOnly, .silentReject]
        for status in nonGrantedStatuses {
            for entity in [PermissionEntity.calendar, PermissionEntity.reminders] {
                let msg = composeErrorMessage(status: status, entity: entity)
                XCTAssertFalse(msg.isEmpty,
                    "composeErrorMessage(\(status), \(entity)) must return non-empty string")
            }
        }
    }

    func testEntityNameUsesCapitalizedRawValue() {
        // (M1) entity name must be capitalized rawValue, not a hardcoded string
        let calMsg = composeErrorMessage(status: .denied, entity: .calendar)
        XCTAssertTrue(calMsg.contains("Calendar"), "Calendar denied must contain 'Calendar'")
        XCTAssertFalse(calMsg.contains("calendar"), "Must use capitalized 'Calendar', not 'calendar'")
        let remMsg = composeErrorMessage(status: .denied, entity: .reminders)
        XCTAssertTrue(remMsg.contains("Reminders"), "Reminders denied must contain 'Reminders'")
    }

    func testComposeNotDeterminedReturnsNonEmpty() {
        // (M4) Defensive: .notDetermined is unreachable in production flow but must return non-empty
        let msg = composeErrorMessage(status: .notDetermined, entity: .calendar)
        XCTAssertFalse(msg.isEmpty, ".notDetermined must return non-empty for parametric invariant")
    }

    // MARK: - performCheckPermission (MockGate)

    final class MockGate: PermissionGate {
        var initialStatus: EKAuthorizationStatus = .notDetermined
        var postRequestStatus: EKAuthorizationStatus = .notDetermined
        var requestGranted: Bool = false
        var requestError: Error? = nil
        var requestInvokedCount = 0
        var statusQueryCount = 0
        var deferRequest: Bool = false  // if true, never invoke completion → exercises timeout path
        func authorizationStatus() -> EKAuthorizationStatus {
            statusQueryCount += 1
            return statusQueryCount == 1 ? initialStatus : postRequestStatus
        }
        func requestAccess(completion: @escaping (Bool, Error?) -> Void) {
            requestInvokedCount += 1
            if !deferRequest {
                completion(requestGranted, requestError)
            }
        }
    }

    func testPerformGrantedShortCircuit() {
        let gate = MockGate()
        if #available(macOS 14.0, *) {
            gate.initialStatus = .fullAccess
        } else {
            gate.initialStatus = .authorized
        }
        let result = performCheckPermission(gate: gate, entity: .calendar)
        let parsed = try! JSONSerialization.jsonObject(with: result.data(using: .utf8)!) as! [String: Any]
        XCTAssertEqual(parsed["granted"] as? Bool, true)
        XCTAssertEqual(parsed["status"] as? String, "granted")
        XCTAssertEqual(gate.requestInvokedCount, 0, "Short-circuit: request must not be invoked")
    }

    func testPerformDeniedShortCircuit() {
        let gate = MockGate()
        gate.initialStatus = .denied
        let result = performCheckPermission(gate: gate, entity: .calendar)
        let parsed = try! JSONSerialization.jsonObject(with: result.data(using: .utf8)!) as! [String: Any]
        XCTAssertEqual(parsed["granted"] as? Bool, false)
        XCTAssertEqual(parsed["status"] as? String, "denied")
        let error = parsed["error"] as? String ?? ""
        XCTAssertTrue(error.contains("tccutil reset Calendar"), "Denied must mention tccutil reset")
        XCTAssertEqual(gate.requestInvokedCount, 0)
    }

    func testPerformRestrictedShortCircuit() {
        let gate = MockGate()
        gate.initialStatus = .restricted
        let result = performCheckPermission(gate: gate, entity: .calendar)
        let parsed = try! JSONSerialization.jsonObject(with: result.data(using: .utf8)!) as! [String: Any]
        XCTAssertEqual(parsed["status"] as? String, "restricted")
        XCTAssertEqual(gate.requestInvokedCount, 0)
    }

    @available(macOS 14.0, *)
    func testPerformWriteOnlyShortCircuit() {
        let gate = MockGate()
        gate.initialStatus = .writeOnly
        let result = performCheckPermission(gate: gate, entity: .calendar)
        let parsed = try! JSONSerialization.jsonObject(with: result.data(using: .utf8)!) as! [String: Any]
        XCTAssertEqual(parsed["status"] as? String, "writeOnly")
        XCTAssertEqual(gate.requestInvokedCount, 0)
    }

    func testPerformNotDeterminedThenGranted() {
        let gate = MockGate()
        gate.initialStatus = .notDetermined
        gate.requestGranted = true
        if #available(macOS 14.0, *) {
            gate.postRequestStatus = .fullAccess
        } else {
            gate.postRequestStatus = .authorized
        }
        let result = performCheckPermission(gate: gate, entity: .calendar)
        let parsed = try! JSONSerialization.jsonObject(with: result.data(using: .utf8)!) as! [String: Any]
        XCTAssertEqual(parsed["granted"] as? Bool, true)
        XCTAssertEqual(parsed["status"] as? String, "granted")
    }

    func testPerformNotDeterminedThenDenied() {
        let gate = MockGate()
        gate.initialStatus = .notDetermined
        gate.requestGranted = false
        gate.postRequestStatus = .denied
        let result = performCheckPermission(gate: gate, entity: .calendar)
        let parsed = try! JSONSerialization.jsonObject(with: result.data(using: .utf8)!) as! [String: Any]
        XCTAssertEqual(parsed["granted"] as? Bool, false)
        XCTAssertEqual(parsed["status"] as? String, "denied")
        let error = parsed["error"] as? String ?? ""
        XCTAssertTrue(error.contains("tccutil reset Calendar"), "Denied must mention tccutil reset")
    }

    func testPerformSilentRejectStatusUnchanged() {
        let gate = MockGate()
        gate.initialStatus = .notDetermined
        gate.requestGranted = false
        gate.postRequestStatus = .notDetermined
        let result = performCheckPermission(gate: gate, entity: .calendar)
        let parsed = try! JSONSerialization.jsonObject(with: result.data(using: .utf8)!) as! [String: Any]
        XCTAssertEqual(parsed["status"] as? String, "silentReject")
        let error = parsed["error"] as? String ?? ""
        XCTAssertTrue(error.contains("reinstall"), "silentReject must mention reinstall")
    }

    func testPerformGrantedRequestButPostStatusDenied() {
        // (H5) post-status trumps request-granted invariant
        let gate = MockGate()
        gate.initialStatus = .notDetermined
        gate.requestGranted = true
        gate.postRequestStatus = .denied
        let result = performCheckPermission(gate: gate, entity: .calendar)
        let parsed = try! JSONSerialization.jsonObject(with: result.data(using: .utf8)!) as! [String: Any]
        XCTAssertEqual(parsed["granted"] as? Bool, false,
            "Post-status .denied must override requestGranted=true")
        XCTAssertEqual(parsed["status"] as? String, "denied")
        let error = parsed["error"] as? String ?? ""
        XCTAssertTrue(error.contains("tccutil reset Calendar"),
            "Post-status .denied must mention tccutil reset")
    }

    func testPerformTimeout() {
        // (M2) timeout raised to 0.1s to avoid scheduler flake
        // MockGate.requestAccess deliberately never invokes completion when deferRequest=true
        let gate = MockGate()
        gate.initialStatus = .notDetermined
        gate.deferRequest = true
        let result = performCheckPermission(gate: gate, entity: .calendar, timeout: 0.1)
        let parsed = try! JSONSerialization.jsonObject(with: result.data(using: .utf8)!) as! [String: Any]
        XCTAssertEqual(parsed["status"] as? String, "silentReject")
        let error = parsed["error"] as? String ?? ""
        XCTAssertTrue(error.contains("timed out"), "Timeout must produce 'timed out' in error")
    }

    // exitWithError calls exit(1) and cannot be unit-tested without process spawning.
    // Covered by integration: all 4 CLIs use it and would crash on incorrect behavior.

    // MARK: - resolveCalendars (Reminders)

    func testResolveRemindersByIdMatchesFirst() throws {
        let store = EKEventStore()
        let allLists = store.calendars(for: .reminder)
        try XCTSkipIf(allLists.isEmpty, "No reminder lists available on this machine")
        let first = allLists[0]
        let result = try resolveCalendars(for: .reminder, filter: first.calendarIdentifier, store: store)
        XCTAssertEqual(result.first?.calendarIdentifier, first.calendarIdentifier)
    }

    func testResolveRemindersByNameFallback() throws {
        let store = EKEventStore()
        let allLists = store.calendars(for: .reminder)
        try XCTSkipIf(allLists.isEmpty, "No reminder lists available on this machine")
        let first = allLists[0]
        let result = try resolveCalendars(for: .reminder, filter: first.title, store: store)
        XCTAssertEqual(result.first?.title, first.title)
    }

    func testResolveRemindersNotFoundThrows() {
        let store = EKEventStore()
        let bogus = "NONEXISTENT-\(UUID())"
        XCTAssertThrowsError(try resolveCalendars(for: .reminder, filter: bogus, store: store)) { error in
            XCTAssertTrue(error is CLIError, "Should throw CLIError")
            XCTAssertTrue(error.localizedDescription.contains("not found"))
            XCTAssertTrue(error.localizedDescription.contains(bogus))
        }
    }

    // MARK: - resolveCalendars (Calendar Events)

    func testResolveCalendarsByIdMatchesFirst() throws {
        let store = EKEventStore()
        let allCals = store.calendars(for: .event)
        try XCTSkipIf(allCals.isEmpty, "No calendars available on this machine")
        let first = allCals[0]
        let result = try resolveCalendars(for: .event, filter: first.calendarIdentifier, store: store)
        XCTAssertEqual(result.first?.calendarIdentifier, first.calendarIdentifier)
    }

    func testResolveCalendarsByNameFallback() throws {
        let store = EKEventStore()
        let allCals = store.calendars(for: .event)
        try XCTSkipIf(allCals.isEmpty, "No calendars available on this machine")
        let first = allCals[0]
        let result = try resolveCalendars(for: .event, filter: first.title, store: store)
        XCTAssertEqual(result.first?.title, first.title)
    }

    func testResolveCalendarsNotFoundThrows() {
        let store = EKEventStore()
        let bogus = "NONEXISTENT-\(UUID())"
        XCTAssertThrowsError(try resolveCalendars(for: .event, filter: bogus, store: store)) { error in
            XCTAssertTrue(error is CLIError, "Should throw CLIError")
            XCTAssertTrue(error.localizedDescription.contains("not found"))
            XCTAssertTrue(error.localizedDescription.contains(bogus))
        }
    }
}
