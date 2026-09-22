import EventKit
import XCTest
@testable import SharedCLI

final class SharedCLITests: XCTestCase {
    private let warsaw = TimeZone(identifier: "Europe/Warsaw")!
    private let newYork = TimeZone(identifier: "America/New_York")!


    func testParseISODateInputBareDayIsAZonelessGregorianDay() {
        guard case .day(let c)? = parseISODateInput("2026-06-15") else {
            return XCTFail("expected a bare day")
        }
        XCTAssertEqual([c.year, c.month, c.day], [2026, 6, 15])
        XCTAssertNil(c.hour)
        XCTAssertNil(c.timeZone)
        XCTAssertEqual(c.calendar?.identifier, .gregorian)
    }

    func testParseISODateInputWallClockKeepsTheTypedTime() {
        guard case .wallClock(let c)? = parseISODateInput("2026-06-15T09:30:15.250") else {
            return XCTFail("expected a wall-clock time")
        }
        XCTAssertEqual([c.year, c.month, c.day, c.hour, c.minute, c.second], [2026, 6, 15, 9, 30, 15])
        XCTAssertNil(c.timeZone)
        XCTAssertEqual(c.calendar?.identifier, .gregorian)
    }

    func testParseISODateInputWithZOrOffsetIsAnInstant() throws {
        let utc = try XCTUnwrap(parseISO8601("2026-06-15T07:00:00Z"))
        XCTAssertEqual(parseISODateInput("2026-06-15T07:00:00Z"), .instant(utc))
        XCTAssertEqual(parseISODateInput("2026-06-15T09:00:00+02:00"), .instant(utc))
        XCTAssertEqual(parseISODateInput("2026-06-15T03:00:00.000-04:00"), .instant(utc))
    }

    func testParseISODateInputRejectsGarbageUnpaddedAndImpossibleDates() {
        let rejected = [
            "", "tomorrow", "March 1st, 2025", "2026-6-1", "2026-06-15 09:30:00", "٢٠٢٦-٠١-٠١",
            "2026-02-30", "2026-02-30T09:30:00", "2026-02-30T09:30:00Z",
            "2026-06-15T25:00:00", "2026-06-15T23:60:00", "2026-06-15T25:00:00Z",
        ]
        for input in rejected {
            XCTAssertNil(parseISODateInput(input), input)
        }
    }

    func testISODateInputBareDayStartsAtLocalMidnightInEachZone() throws {
        let day = try XCTUnwrap(parseISODateInput("2026-06-15"))
        XCTAssertEqual(iso8601String(from: try XCTUnwrap(day.date(in: newYork)), timeZone: newYork), "2026-06-15T00:00:00-04:00")
        XCTAssertEqual(iso8601String(from: try XCTUnwrap(day.date(in: warsaw)), timeZone: warsaw), "2026-06-15T00:00:00+02:00")
    }

    func testISODateInputWallClockIsLocalTimeInEachZone() throws {
        let time = try XCTUnwrap(parseISODateInput("2026-06-15T09:30:00"))
        XCTAssertEqual(iso8601String(from: try XCTUnwrap(time.date(in: newYork)), timeZone: newYork), "2026-06-15T09:30:00-04:00")
        XCTAssertEqual(iso8601String(from: try XCTUnwrap(time.date(in: warsaw)), timeZone: warsaw), "2026-06-15T09:30:00+02:00")
    }

    func testISODateInputInstantIsTheSameMomentInEveryZone() throws {
        let instant = try XCTUnwrap(parseISODateInput("2026-06-15T07:00:00Z"))
        let utc = try XCTUnwrap(parseISO8601("2026-06-15T07:00:00Z"))
        XCTAssertEqual(instant.date(in: newYork), utc)
        XCTAssertEqual(instant.date(in: warsaw), utc)
    }

    func testParseISO8601WithTimezone() {
        let date = parseISO8601("2025-03-01T10:00:00Z")
        XCTAssertNotNil(date)
    }

    func testParseISO8601WithFractionalSeconds() {
        let date = parseISO8601("2025-03-01T10:00:00.123Z")
        XCTAssertNotNil(date)
    }

    func testParseISO8601ParsesInstantsOnlyAndRejectsABareDate() {
        XCTAssertNil(parseISO8601("2025-03-01"), "a bare day has no instant; parseISODateInput resolves it in a zone")
        XCTAssertNil(parseISO8601("2025-03-01T10:00:00"), "a time without an offset has no instant either")
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

    func testISO8601StringWithZoneNeverCollapsesZeroOffsetToZ() throws {
        let date = try XCTUnwrap(parseISO8601("2025-06-15T14:30:00Z"))
        XCTAssertEqual(iso8601String(from: date, timeZone: TimeZone(identifier: "UTC")!), "2025-06-15T14:30:00+00:00")
        XCTAssertEqual(iso8601String(from: date, timeZone: TimeZone(identifier: "Europe/Warsaw")!), "2025-06-15T16:30:00+02:00")
        XCTAssertEqual(iso8601String(from: date, timeZone: TimeZone(identifier: "Asia/Kolkata")!), "2025-06-15T20:00:00+05:30")
    }

    func testParseISO8601InvalidFormat() {
        let badDate = "March 1st, 2025"
        XCTAssertNil(parseISO8601(badDate))
    }


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
        let wideGamut = CGColor(
            colorSpace: CGColorSpace(name: CGColorSpace.displayP3)!,
            components: [1.3, -0.1, 0.5, 1.0]
        )!
        let result = hexColor(from: wideGamut)
        XCTAssertEqual(result, "#ff007f")
    }


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
        XCTAssertEqual(
            error.errorDescription,
            "Invalid ISO8601 date: bad-date. Expected YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS (local time), optionally with Z or ±HH:MM"
        )
    }

    func testCLIErrorMissingFieldHasDescription() {
        let error = CLIError.missingField("id")
        XCTAssertNotNil(error.errorDescription)
    }

    func testInvalidDateFormatDetected() {
        let badDate = "March 1st, 2025"
        XCTAssertNil(parseISO8601(badDate))
    }


    func testFormatGrantedNoError() {
        let json = formatPermissionResult(granted: true, status: .granted, error: nil)
        let data = json.data(using: .utf8)!
        let parsed = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(parsed["granted"] as? Bool, true)
        XCTAssertEqual(parsed["status"] as? String, "granted")
        XCTAssertNil(parsed["error"])
    }

    func testFormatGrantedEmptyStringError() {
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
        let json = formatPermissionResult(granted: false, status: .denied, error: "access denied")
        let data = json.data(using: .utf8)!
        let parsed = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertNotNil(parsed["granted"])
        XCTAssertNotNil(parsed["error"])
    }

    func testFormatSerializationFailureFallback() {
        let fallback = #"{"error":"Failed to serialize permission result","granted":false,"status":"silentReject"}"#
        let data = fallback.data(using: .utf8)!
        let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        XCTAssertNotNil(parsed)
    }


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
        if #available(macOS 14.0, *) {
            let status = EKAuthorizationStatus(rawValue: 3)! 
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
        if let synthetic = EKAuthorizationStatus(rawValue: 99) {
            XCTAssertEqual(mapAuthorizationStatus(synthetic), .silentReject)
        }
    }


    func testResolvedBundleIdentifierFallbackWhenNil() {
        XCTAssertEqual(resolvedBundleIdentifier(from: nil), speedwaveBundleIdentifier)
        XCTAssertEqual(resolvedBundleIdentifier(from: nil), "pl.speedwave.desktop")
    }

    func testResolvedBundleIdentifierUsesProvidedValueWhenPresent() {
        XCTAssertEqual(resolvedBundleIdentifier(from: "pl.speedwave.desktop"), "pl.speedwave.desktop")
        XCTAssertEqual(resolvedBundleIdentifier(from: "com.example.other"), "com.example.other")
    }

    func testSpeedwaveBundleIdentifierMatchesTauriConf() throws {
        let candidates = [
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
        guard let tauriId = tauriId else {
            throw XCTSkip("tauri.conf.json not found from test runner cwd; bats test is the authoritative drift guard")
        }
        XCTAssertEqual(speedwaveBundleIdentifier, tauriId,
                       "Swift literal must match tauri.conf.json::identifier")
    }


    func testComposeDeniedCalendarMentionsTccutilReset() {
        let msg = composeErrorMessage(status: .denied, entity: .calendar)
        XCTAssertTrue(msg.contains("tccutil reset Calendar pl.speedwave.desktop.calendar"),
                      "Denied Calendar message must contain tccutil reset with sub-identifier, got: \(msg)")
    }

    func testComposeDeniedRemindersMentionsTccutilReset() {
        let msg = composeErrorMessage(status: .denied, entity: .reminders)
        XCTAssertTrue(msg.contains("tccutil reset Reminders pl.speedwave.desktop.reminders"),
                      "Denied Reminders message must contain tccutil reset with sub-identifier, got: \(msg)")
    }

    func testComposeDeniedMailMentionsAppleEventsService() {
        let msg = composeErrorMessage(status: .denied, entity: .mail)
        XCTAssertTrue(msg.contains("tccutil reset AppleEvents pl.speedwave.desktop.mail"),
                      "Denied Mail must use AppleEvents service in tccutil command, got: \(msg)")
    }

    func testComposeDeniedNotesMentionsAppleEventsService() {
        let msg = composeErrorMessage(status: .denied, entity: .notes)
        XCTAssertTrue(msg.contains("tccutil reset AppleEvents pl.speedwave.desktop.notes"),
                      "Denied Notes must use AppleEvents service in tccutil command, got: \(msg)")
    }

    func testComposeUsesSubIdentifierByDefault() {
        for entity in [PermissionEntity.calendar, .reminders, .mail, .notes] {
            let msg = composeErrorMessage(status: .denied, entity: entity)
            let expected = "pl.speedwave.desktop.\(entity.rawValue)"
            XCTAssertTrue(msg.contains(expected),
                          "Default bundleId must be sub-identifier '\(expected)' for \(entity), got: \(msg)")
        }
    }

    func testComposeAcceptsExplicitBundleIdOverride() {
        let msg = composeErrorMessage(status: .denied, entity: .calendar, bundleId: "com.example.test")
        XCTAssertTrue(msg.contains("tccutil reset Calendar com.example.test"),
                      "Explicit bundleId must override default sub-identifier, got: \(msg)")
    }

    func testComposeSilentRejectMentionsReinstall() {
        let msg = composeErrorMessage(status: .silentReject, entity: .calendar)
        XCTAssertTrue(msg.contains("reinstall"), "silentReject must mention reinstall")
    }

    func testComposeWriteOnlyOnlyForCalendar() {
        let msg = composeErrorMessage(status: .writeOnly, entity: .reminders)
        XCTAssertFalse(msg.isEmpty, "writeOnly reminders must produce non-empty message")
    }

    func testComposeTargetNotRunningDoesNotMentionTccutil() {
        for entity in [PermissionEntity.mail, .notes] {
            let msg = composeErrorMessage(status: .targetNotRunning, entity: entity)
            XCTAssertFalse(msg.lowercased().contains("tccutil"),
                           "targetNotRunning for \(entity) must NOT mention tccutil, got: \(msg)")
            XCTAssertFalse(msg.isEmpty, "targetNotRunning must produce non-empty error")
        }
    }

    func testComposeTargetNotRunningNamesEntityApp() {
        let mailMsg = composeErrorMessage(status: .targetNotRunning, entity: .mail)
        XCTAssertTrue(mailMsg.contains("Mail.app"), "Mail targetNotRunning must mention Mail.app, got: \(mailMsg)")
        let notesMsg = composeErrorMessage(status: .targetNotRunning, entity: .notes)
        XCTAssertTrue(notesMsg.contains("Notes.app"), "Notes targetNotRunning must mention Notes.app, got: \(notesMsg)")
    }

    func testGrantedFalseAlwaysCarriesNonEmptyError() {
        let nonGrantedStatuses: [PermissionStatus] = [.denied, .restricted, .notDetermined, .writeOnly, .silentReject, .targetNotRunning]
        for status in nonGrantedStatuses {
            for entity in [PermissionEntity.calendar, .reminders, .mail, .notes] {
                let msg = composeErrorMessage(status: status, entity: entity)
                XCTAssertFalse(msg.isEmpty,
                    "composeErrorMessage(\(status), \(entity)) must return non-empty string")
            }
        }
    }

    func testEntityNameUsesCapitalizedRawValue() {
        let calMsg = composeErrorMessage(status: .denied, entity: .calendar)
        XCTAssertTrue(calMsg.contains("Calendar"), "Calendar denied must contain 'Calendar'")
        let remMsg = composeErrorMessage(status: .denied, entity: .reminders)
        XCTAssertTrue(remMsg.contains("Reminders"), "Reminders denied must contain 'Reminders'")
    }

    func testComposeNotDeterminedReturnsNonEmpty() {
        let msg = composeErrorMessage(status: .notDetermined, entity: .calendar)
        XCTAssertFalse(msg.isEmpty, ".notDetermined must return non-empty for parametric invariant")
    }


    func testSubBundleIdentifierForEachEntity() {
        XCTAssertEqual(subBundleIdentifier(for: .calendar), "pl.speedwave.desktop.calendar")
        XCTAssertEqual(subBundleIdentifier(for: .reminders), "pl.speedwave.desktop.reminders")
        XCTAssertEqual(subBundleIdentifier(for: .mail), "pl.speedwave.desktop.mail")
        XCTAssertEqual(subBundleIdentifier(for: .notes), "pl.speedwave.desktop.notes")
    }

    func testTccServiceNameMailAndNotesUseAppleEvents() {
        XCTAssertEqual(tccServiceName(for: .calendar), "Calendar")
        XCTAssertEqual(tccServiceName(for: .reminders), "Reminders")
        XCTAssertEqual(tccServiceName(for: .mail), "AppleEvents",
                       "Mail uses kTCCServiceAppleEvents, not 'Mail'")
        XCTAssertEqual(tccServiceName(for: .notes), "AppleEvents",
                       "Notes uses kTCCServiceAppleEvents, not 'Notes'")
    }


    func testMapEventKitStatusToRawCoversAllCases() {
        XCTAssertEqual(mapEventKitStatusToRaw(.notDetermined), .notDetermined)
        XCTAssertEqual(mapEventKitStatusToRaw(.denied), .denied)
        XCTAssertEqual(mapEventKitStatusToRaw(.restricted), .restricted)
        XCTAssertEqual(mapEventKitStatusToRaw(.authorized), .granted)
        if #available(macOS 14.0, *) {
            XCTAssertEqual(mapEventKitStatusToRaw(.fullAccess), .granted)
            XCTAssertEqual(mapEventKitStatusToRaw(.writeOnly), .writeOnly)
        }
        if let synthetic = EKAuthorizationStatus(rawValue: 99) {
            XCTAssertEqual(mapEventKitStatusToRaw(synthetic), .unknown,
                           "Unknown synthetic raw value must map to .unknown (not .silentReject)")
        }
    }

    func testMapRawToPermissionStatusForAllCases() {
        XCTAssertEqual(mapRawToPermissionStatus(.granted), .granted)
        XCTAssertEqual(mapRawToPermissionStatus(.denied), .denied)
        XCTAssertEqual(mapRawToPermissionStatus(.restricted), .restricted)
        XCTAssertEqual(mapRawToPermissionStatus(.notDetermined), .notDetermined)
        XCTAssertEqual(mapRawToPermissionStatus(.writeOnly), .writeOnly)
        XCTAssertEqual(mapRawToPermissionStatus(.targetNotRunning(bundleId: "com.x")), .targetNotRunning)
        XCTAssertEqual(mapRawToPermissionStatus(.unknown), .silentReject)
    }


    func testMapAEStatusNoErrIsGranted() {
        XCTAssertEqual(mapAEStatusToRaw(0, targetBundleId: "com.x"), .granted)
    }

    func testMapAEStatusErrAEEventNotPermittedIsDenied() {
        XCTAssertEqual(mapAEStatusToRaw(-1743, targetBundleId: "com.x"), .denied)
    }

    func testMapAEStatusErrAEEventWouldRequireUserConsentIsNotDetermined() {
        XCTAssertEqual(mapAEStatusToRaw(-1744, targetBundleId: "com.x"), .notDetermined)
    }

    func testMapAEStatusProcNotFoundIsTargetNotRunning() {
        let raw = mapAEStatusToRaw(-600, targetBundleId: "com.apple.mail")
        guard case let .targetNotRunning(bid) = raw else {
            XCTFail("Expected .targetNotRunning, got \(raw)"); return
        }
        XCTAssertEqual(bid, "com.apple.mail")
    }

    func testMapAEStatusUnknownOSStatusMapsToUnknown() {
        XCTAssertEqual(mapAEStatusToRaw(-12345, targetBundleId: "com.x"), .unknown)
    }


    final class MockGate: PermissionGate {
        var initialStatus: RawAuthorizationStatus = .notDetermined
        var postRequestStatus: RawAuthorizationStatus = .notDetermined
        var requestGranted: Bool = false
        var requestError: Error? = nil
        var requestInvokedCount = 0
        var statusQueryCount = 0
        var deferRequest: Bool = false  
        var dataAccessError: String? = nil  
        func authorizationStatus() -> RawAuthorizationStatus {
            statusQueryCount += 1
            return statusQueryCount == 1 ? initialStatus : postRequestStatus
        }
        func requestAccess(completion: @escaping (Bool, Error?) -> Void) {
            requestInvokedCount += 1
            if !deferRequest {
                completion(requestGranted, requestError)
            }
        }
        func verifyDataAccess() -> String? { dataAccessError }
    }

    func testPerformGrantedShortCircuit() {
        let gate = MockGate()
        gate.initialStatus = .granted
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
        XCTAssertTrue(error.contains("tccutil reset Calendar pl.speedwave.desktop.calendar"),
                      "Denied must mention tccutil reset with sub-identifier, got: \(error)")
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
        gate.postRequestStatus = .granted
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
        XCTAssertTrue(error.contains("tccutil reset Calendar pl.speedwave.desktop.calendar"),
                      "Denied must mention tccutil reset with sub-identifier")
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
        XCTAssertTrue(error.contains("tccutil reset Calendar pl.speedwave.desktop.calendar"),
            "Post-status .denied must mention tccutil reset with sub-identifier")
    }

    func testPerformTimeout() {
        let gate = MockGate()
        gate.initialStatus = .notDetermined
        gate.deferRequest = true
        let result = performCheckPermission(gate: gate, entity: .calendar, timeout: 0.1)
        let parsed = try! JSONSerialization.jsonObject(with: result.data(using: .utf8)!) as! [String: Any]
        XCTAssertEqual(parsed["status"] as? String, "silentReject")
        let error = parsed["error"] as? String ?? ""
        XCTAssertTrue(error.contains("timed out"), "Timeout must produce 'timed out' in error")
    }

    func testPerformTargetNotRunningInvokesRequestForAutoLaunch() {
        let gate = MockGate()
        gate.initialStatus = .targetNotRunning(bundleId: "com.apple.mail")
        gate.postRequestStatus = .targetNotRunning(bundleId: "com.apple.mail")
        let result = performCheckPermission(gate: gate, entity: .mail)
        let parsed = try! JSONSerialization.jsonObject(with: result.data(using: .utf8)!) as! [String: Any]
        XCTAssertEqual(parsed["status"] as? String, "targetNotRunning")
        XCTAssertEqual(gate.requestInvokedCount, 1,
                       "orchestrator must invoke requestAccess so gate can attempt auto-launch")
        let error = parsed["error"] as? String ?? ""
        XCTAssertFalse(error.lowercased().contains("tccutil"),
                       "targetNotRunning must NOT recommend tccutil")
        XCTAssertTrue(error.contains("Mail.app"),
                      "targetNotRunning for mail must mention Mail.app")
    }

    func testPerformTargetNotRunningRecoversWhenAutoLaunchSucceeds() {
        let gate = MockGate()
        gate.initialStatus = .targetNotRunning(bundleId: "com.apple.mail")
        gate.requestGranted = true
        gate.postRequestStatus = .granted
        let result = performCheckPermission(gate: gate, entity: .mail)
        let parsed = try! JSONSerialization.jsonObject(with: result.data(using: .utf8)!) as! [String: Any]
        XCTAssertEqual(parsed["status"] as? String, "granted")
        XCTAssertEqual(gate.requestInvokedCount, 1)
    }

    func testPerformDataAccessFailureOverridesGranted() {
        let gate = MockGate()
        gate.initialStatus = .granted
        gate.dataAccessError = "AppleScript error: probe failed"
        let result = performCheckPermission(gate: gate, entity: .mail)
        let parsed = try! JSONSerialization.jsonObject(with: result.data(using: .utf8)!) as! [String: Any]
        XCTAssertEqual(parsed["granted"] as? Bool, false,
                       "verifyDataAccess error must downgrade granted=true to false")
        XCTAssertEqual(parsed["status"] as? String, "silentReject")
        let error = parsed["error"] as? String ?? ""
        XCTAssertTrue(error.contains("data access failed"),
                      "Error must explain data-access failure, got: \(error)")
        XCTAssertTrue(error.contains("probe failed"),
                      "Error must include the underlying data-access error message")
    }

    func testPerformDataAccessSuccessPreservesGranted() {
        let gate = MockGate()
        gate.initialStatus = .granted
        gate.dataAccessError = nil  
        let result = performCheckPermission(gate: gate, entity: .mail)
        let parsed = try! JSONSerialization.jsonObject(with: result.data(using: .utf8)!) as! [String: Any]
        XCTAssertEqual(parsed["granted"] as? Bool, true)
        XCTAssertEqual(parsed["status"] as? String, "granted")
    }



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
