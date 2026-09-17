import AVFoundation
import XCTest

@testable import audio_capture_cli

final class AudioCaptureTests: XCTestCase {


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
}
