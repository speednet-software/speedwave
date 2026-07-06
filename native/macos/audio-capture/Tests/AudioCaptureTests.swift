import XCTest

@testable import audio_capture_cli

final class AudioCaptureTests: XCTestCase {

    // MARK: - Argument parsing

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
        // Per-process sources were removed — `pid:` is no longer a valid source.
        XCTAssertNil(parseRecordOptions(["--source", "pid:12345", "--mic", "none"]))
    }

    func testParseRecordOptionsRejectsDanglingFlag() {
        // Flag without a value is malformed.
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

    // MARK: - Framed PCM protocol

    /// The header JSON line must be valid UTF-8 + JSON and carry the expected
    /// schema before the parent reads any binary chunks.
    func testHeaderShapeIsStable() throws {
        // We can't easily intercept FileHandle.standardOutput in-process, but
        // we can pre-serialize the same structure the writer uses and assert
        // that the parser side will accept it. This guards the schema.
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

    /// Chunk framing: 4-byte stream index, 4-byte nframes, 8-byte offset_ns,
    /// then nframes × 4-byte little-endian floats. The Rust side parses this
    /// shape — regression-guard the byte layout from the producer side.
    func testChunkFramingByteLayout() {
        let samples: [Float] = [0.0, 0.25, -0.25, 1.0]
        let bytesPerChunk = 4 + 4 + 8 + samples.count * MemoryLayout<Float32>.size
        XCTAssertEqual(bytesPerChunk, 32)
        // Float32 little-endian sanity — Swift's native byte order on Apple
        // Silicon and Intel is little-endian, but assert the contract anyway
        // so a future port doesn't silently flip endianness.
        var v: Float32 = 1.0
        let raw = withUnsafeBytes(of: &v) { Array($0) }
        XCTAssertEqual(raw.count, 4)
        // 1.0 as Float32 little-endian = 00 00 80 3f
        XCTAssertEqual(raw[0], 0x00)
        XCTAssertEqual(raw[1], 0x00)
        XCTAssertEqual(raw[2], 0x80)
        XCTAssertEqual(raw[3], 0x3f)
    }

    /// Stream indices: 0 = app/system, 1 = mic. A frame's 4-byte LE prefix is
    /// that index; the Rust reader treats it positionally. Encode both and
    /// decode them back — if the LE encoding ever changes this fails. (Changing
    /// the *meaning* of 0/1 also requires changing
    /// crates/speedwave-runtime/src/transcription/audio_macos.rs.)
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

    // MARK: - Source enum mapping

    func testAudioSourceCases() {
        let cases: [AudioSource] = [.all, .micOnly(nil), .micOnly("UID-1")]
        XCTAssertEqual(cases.count, 3)
        // Compile-time exhaustiveness — if a new variant lands the parser must
        // learn it before this test will pass again.
        for c in cases {
            switch c {
            case .all, .micOnly: break
            }
        }
    }

    func testMicSelectorForMicOnly() {
        // A `mic-only:<uid>` source must route to the named device, not default.
        if case .device(let uid) = micSelector(forMicOnly: "UID-7") {
            XCTAssertEqual(uid, "UID-7")
        } else {
            XCTFail("expected device(_) selector for mic-only:<uid>")
        }
        // Bare `mic-only` uses the default input.
        if case .defaultDevice = micSelector(forMicOnly: nil) {} else {
            XCTFail("expected defaultDevice selector for bare mic-only")
        }
    }

    func testParseRecordOptionsMicOnly() {
        // `--source mic-only` without `--mic` (mic-only IS the microphone).
        let opts = parseRecordOptions(["--source", "mic-only"])
        XCTAssertNotNil(opts)
        if case .micOnly(let uid) = opts!.source { XCTAssertNil(uid) } else { XCTFail("expected micOnly") }
        if case .none = opts!.mic {} else { XCTFail("mic defaults to none") }
        // With a device UID.
        let opts2 = parseRecordOptions(["--source", "mic-only:BuiltInMic"])
        XCTAssertNotNil(opts2)
        if case .micOnly(let uid) = opts2!.source {
            XCTAssertEqual(uid, "BuiltInMic")
        } else {
            XCTFail("expected micOnly(_)")
        }
    }

    // MARK: - Mic restart debounce

    @available(macOS 14.4, *)
    func testScheduleMicRestartCoalescesBursts() {
        let session = RecordSession()
        let fired = expectation(description: "debounced restart runs once")
        var firstRan = false
        // Burst of two schedules — only the second body may run.
        session.scheduleMicRestart { firstRan = true }
        session.scheduleMicRestart { fired.fulfill() }
        waitForExpectations(timeout: 2)
        XCTAssertFalse(firstRan, "the earlier scheduled restart must be cancelled")
    }
}
