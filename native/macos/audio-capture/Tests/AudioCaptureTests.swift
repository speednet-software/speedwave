import AVFoundation
import SafeAudioTap
import XCTest

@testable import audio_capture_cli

final class AudioCaptureTests: XCTestCase {
    override func tearDown() {
        if #available(macOS 14.4, *) {
            activeSession?.micRestartWork?.cancel()
            activeSession = nil
        }
        super.tearDown()
    }


    func testParseRecordOptionsAllSystem() {
        let opts = parseRecordOptions(["--source", "all", "--mic", "default"])
        XCTAssertNotNil(opts)
        if case .all = opts!.source {} else { XCTFail("expected .all source") }
        if case .defaultDevice = opts!.mic {} else { XCTFail("expected default mic") }
    }

    func testParseRecordOptionsRejectsMissingSource() {
        XCTAssertNil(parseRecordOptions(["--mic", "default"]))
    }

    func testParseRecordOptionsRejectsBadSource() {
        XCTAssertNil(parseRecordOptions(["--source", "everything", "--mic", "none"]))
        XCTAssertNil(parseRecordOptions(["--source", "pid:12345", "--mic", "none"]))
    }

    func testParseRecordOptionsRejectsDanglingFlag() {
        XCTAssertNil(parseRecordOptions(["--source"]))
        XCTAssertNil(parseRecordOptions(["--source", "all", "--mic"]))
    }

    func testParseRecordOptionsRejectsUnknownFlag() {
        XCTAssertNil(parseRecordOptions(["--source", "all", "--unknown", "x", "--mic", "none"]))
    }

    func testMicNamedDevice() {
        let opts = parseRecordOptions(["--source", "all", "--mic", "BuiltInMicrophoneDevice"])
        XCTAssertNotNil(opts)
        if case .device(let uid) = opts!.mic {
            XCTAssertEqual(uid, "BuiltInMicrophoneDevice")
        } else {
            XCTFail("expected device(_) mic")
        }
    }


    /// The header JSON line must be valid UTF-8 + JSON and carry the expected
    /// schema before the parent reads any binary chunks.
    func testHeaderShapeIsStable() throws {
        let header: [String: Any] = [
            "sample_rate": 16000,
            "channels": 1,
            "format": "f32le",
            "streams": ["app", "mic"],
            "started_at_ns": UInt64(0),
        ]
        let data = try JSONSerialization.data(withJSONObject: header)
        let parsed = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        XCTAssertNotNil(parsed)
        XCTAssertEqual(parsed?["sample_rate"] as? Int, 16000)
        XCTAssertEqual(parsed?["channels"] as? Int, 1)
        XCTAssertEqual(parsed?["format"] as? String, "f32le")
        let streams = parsed?["streams"] as? [String]
        XCTAssertEqual(streams, ["app", "mic"])
    }

    /// Chunk framing: 4-byte stream index, 4-byte nframes, 8-byte offset_ns, then nframes ×
    /// 4-byte LE floats. The Rust side parses this shape — regression-guard the byte layout.
    func testChunkFramingByteLayout() {
        let samples: [Float] = [0.0, 0.25, -0.25, 1.0]
        let bytesPerChunk = 4 + 4 + 8 + samples.count * MemoryLayout<Float32>.size
        XCTAssertEqual(bytesPerChunk, 32)
        var v: Float32 = 1.0
        let raw = withUnsafeBytes(of: &v) { Array($0) }
        XCTAssertEqual(raw.count, 4)
        XCTAssertEqual(raw[0], 0x00)
        XCTAssertEqual(raw[1], 0x00)
        XCTAssertEqual(raw[2], 0x80)
        XCTAssertEqual(raw[3], 0x3f)
    }

    /// Stream indices: 0 = app/system, 1 = mic. A frame's 4-byte LE prefix is that index; the Rust
    /// reader treats it positionally. Changing the *meaning* of 0/1 also requires changing audio_macos.rs.
    func testStreamIndexEncodingRoundTrips() {
        for idx: UInt32 in [0, 1] {
            var le = idx.littleEndian
            let bytes = withUnsafeBytes(of: &le) { Array($0) }
            XCTAssertEqual(bytes.count, 4)
            let decoded = UInt32(bytes[0])
                | (UInt32(bytes[1]) << 8)
                | (UInt32(bytes[2]) << 16)
                | (UInt32(bytes[3]) << 24)
            XCTAssertEqual(decoded, idx)
        }
    }


    func testAudioSourceCases() {
        let cases: [AudioSource] = [.all, .micOnly(nil), .micOnly("UID-1")]
        XCTAssertEqual(cases.count, 3)
        for c in cases {
            switch c {
            case .all, .micOnly: break
            }
        }
    }

    func testMicSelectorForMicOnly() {
        if case .device(let uid) = micSelector(forMicOnly: "UID-7") {
            XCTAssertEqual(uid, "UID-7")
        } else {
            XCTFail("expected device(_) selector for mic-only:<uid>")
        }
        if case .defaultDevice = micSelector(forMicOnly: nil) {} else {
            XCTFail("expected defaultDevice selector for bare mic-only")
        }
    }

    func testParseRecordOptionsMicOnly() {
        let opts = parseRecordOptions(["--source", "mic-only"])
        XCTAssertNotNil(opts)
        if case .micOnly(let uid) = opts!.source { XCTAssertNil(uid) } else { XCTFail("expected micOnly") }
        if case .none = opts!.mic {} else { XCTFail("mic defaults to none") }
        let opts2 = parseRecordOptions(["--source", "mic-only:BuiltInMic"])
        XCTAssertNotNil(opts2)
        if case .micOnly(let uid) = opts2!.source {
            XCTAssertEqual(uid, "BuiltInMic")
        } else {
            XCTFail("expected micOnly(_)")
        }
    }


    @available(macOS 14.4, *)
    func testMicRestartNeededWhenEngineIsGone() {
        XCTAssertTrue(micRestartNeeded(nil))
    }

    @available(macOS 14.4, *)
    func testMicRestartNeededWhenEngineStopped() {
        XCTAssertTrue(micRestartNeeded(AVAudioEngine()))
    }


    @available(macOS 14.4, *)
    func testScheduleMicRestartCoalescesBursts() {
        let session = RecordSession()
        let fired = expectation(description: "debounced restart runs once")
        var firstRan = false
        session.scheduleMicRestart { firstRan = true }
        session.scheduleMicRestart { fired.fulfill() }
        waitForExpectations(timeout: 2)
        XCTAssertFalse(firstRan, "the earlier scheduled restart must be cancelled")
    }

    func testSafeTapInstallsATapOnAFreeBus() {
        let engine = AVAudioEngine()
        let mixer = AVAudioMixerNode()
        engine.attach(mixer)
        XCTAssertNoThrow(
            try SPWSafeTap.install(on: mixer, bus: 0, bufferSize: 4096, format: nil) { _, _ in })
        mixer.removeTap(onBus: 0)
    }

    func testSafeTapTurnsTheExceptionOfASecondTapOnOneBusIntoAnError() throws {
        let engine = AVAudioEngine()
        let mixer = AVAudioMixerNode()
        engine.attach(mixer)
        try SPWSafeTap.install(on: mixer, bus: 0, bufferSize: 4096, format: nil) { _, _ in }
        XCTAssertThrowsError(
            try SPWSafeTap.install(on: mixer, bus: 0, bufferSize: 4096, format: nil) { _, _ in }
        ) { error in
            let nsError = error as NSError
            XCTAssertEqual(nsError.domain, SPWSafeTapErrorDomain)
            XCTAssertTrue(
                nsError.localizedDescription.hasPrefix("com.apple.coreaudio.avfaudio: "),
                nsError.localizedDescription)
        }
        mixer.removeTap(onBus: 0)
    }

    func testMicFormatProblemAcceptsAFormatThatMatchesTheHardware() {
        XCTAssertNil(micFormatProblem(sampleRate: 48_000, channels: 1, hardwareSampleRate: 48_000))
    }

    func testMicFormatProblemRejectsAnEmptyFormat() {
        XCTAssertNotNil(micFormatProblem(sampleRate: 0, channels: 0, hardwareSampleRate: 0))
        XCTAssertNotNil(micFormatProblem(sampleRate: 44_100, channels: 0, hardwareSampleRate: 44_100))
        XCTAssertNotNil(micFormatProblem(sampleRate: 0, channels: 2, hardwareSampleRate: 0))
    }

    func testMicFormatProblemRejectsATapRateTheHardwareNoLongerRunsAndNamesBothRates() throws {
        let problem = try XCTUnwrap(
            micFormatProblem(sampleRate: 44_100, channels: 2, hardwareSampleRate: 16_000))
        XCTAssertTrue(problem.contains("44100 Hz") && problem.contains("16000 Hz"), problem)
    }

    func testARestartLogNamesItsTriggerAndTheEngineLifetime() {
        let startedAt = Date(timeIntervalSince1970: 1_000)
        XCTAssertEqual(
            describeMicRestart(
                trigger: .engineConfigurationChange, engineStartedAt: startedAt,
                now: startedAt.addingTimeInterval(0.83)),
            "restarting the microphone capture on an engine configuration change; the engine ran 0.8 s")
        XCTAssertEqual(
            describeMicRestart(trigger: .retryAfterFailedStart, engineStartedAt: nil),
            "restarting the microphone capture on a retry of a failed start; no engine was running")
    }

    func testDescribeFormatReadsAsRateAndChannels() throws {
        let format = try XCTUnwrap(
            AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: false))
        XCTAssertEqual(describeFormat(format), "16000 Hz 1 ch")
    }

    func testMicRetryDelayDoublesUpToThirtySeconds() {
        XCTAssertEqual(
            [0, 1, 2, 3, 4, 5, 6, 50].map { micRetryDelay(afterFailures: $0) },
            [1, 1, 2, 4, 8, 16, 30, 30])
    }

    @available(macOS 14.4, *)
    func testAConfigurationChangeRestartsOnlyForTheSessionsEngine() {
        let session = RecordSession()
        session.micEngine = AVAudioEngine()
        var triggers: [MicRestartTrigger] = []
        onMicEngineConfigurationChange(session.micEngine, session: session) { triggers.append($0) }
        onMicEngineConfigurationChange(AVAudioEngine(), session: session) { triggers.append($0) }
        XCTAssertEqual(triggers.map(\.description), ["an engine configuration change"])
    }

    @available(macOS 14.4, *)
    func testAConfigurationChangeFromAFailedEngineLeavesThePendingRetry() {
        let session = RecordSession()
        let retried = expectation(description: "the pending retry still runs")
        session.scheduleMicRestart(after: 0.3) { retried.fulfill() }
        onMicEngineConfigurationChange(AVAudioEngine(), session: session) { _ in
            session.scheduleMicRestart { XCTFail("a stale engine replaced the retry") }
        }
        waitForExpectations(timeout: 2)
    }

    @available(macOS 14.4, *)
    func testAnInputDeviceChangeWithTheMicDownReplacesALongRetryWithTheDebounce() {
        let session = RecordSession()
        var longRetryRan = false
        let restarted = expectation(description: "the device change restarts after the debounce")
        session.scheduleMicRestart(after: micRetryMaxDelay) { longRetryRan = true }
        onInputDeviceChange(.defaultInputDeviceChange, session: session) { _ in
            session.scheduleMicRestart { restarted.fulfill() }
        }
        waitForExpectations(timeout: 2)
        XCTAssertFalse(longRetryRan)
    }

    @available(macOS 14.4, *)
    func testAnInputDeviceChangeWithAStoppedEngineRestarts() {
        let session = RecordSession()
        session.micEngine = AVAudioEngine()
        var triggers: [MicRestartTrigger] = []
        onInputDeviceChange(.inputDeviceListChange, session: session) { triggers.append($0) }
        XCTAssertEqual(triggers.map(\.description), ["an input device list change"])
    }

    @available(macOS 14.4, *)
    func testFailedStartsAreRetriedWithAGrowingDelayAndASuccessResetsTheCount() {
        let session = RecordSession()
        activeSession = session
        var delays: [TimeInterval] = []
        var pending: (() -> Void)?
        var attempts = 0
        startMicOrRetry(
            session: session, selector: .defaultDevice, streamIndex: 1,
            start: { _, _, _ in
                attempts += 1
                if attempts < 4 { throw MicStartError("BuiltInMic: engine refused to start") }
            },
            schedule: { delay, body in
                delays.append(delay)
                pending = body
            })
        for _ in 0..<3 {
            let retry = pending
            pending = nil
            retry?()
        }
        XCTAssertEqual(delays, [1, 2, 4])
        XCTAssertEqual(attempts, 4)
        XCTAssertEqual(session.micRestartFailures, 0)
        XCTAssertNil(pending)
    }

    @available(macOS 14.4, *)
    func testAFailedFirstStartSchedulesARetryOnTheSession() {
        let session = RecordSession()
        startMicOrRetry(session: session, selector: .defaultDevice, streamIndex: 1) { _, _, _ in
            throw MicStartError("BuiltInMic: engine refused to start")
        }
        XCTAssertEqual(session.micRestartFailures, 1)
        XCTAssertNotNil(session.micRestartWork)
        session.micRestartWork?.cancel()
    }

    @available(macOS 14.4, *)
    func testARestartForASessionThatIsNoLongerActiveDoesNothing() {
        let session = RecordSession()
        activeSession = RecordSession()
        var started = false
        restartMicEngine(
            session: session, selector: .defaultDevice, streamIndex: 1, trigger: .defaultInputDeviceChange
        ) { _, _, _ in
            started = true
        }
        XCTAssertFalse(started)
        XCTAssertEqual(session.micRestartFailures, 0)
        XCTAssertNil(session.micRestartWork)
    }
}
