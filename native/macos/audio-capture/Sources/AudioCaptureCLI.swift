import AVFoundation
import CoreAudio
import Foundation
import SharedCLI

// MARK: - Framed PCM protocol (ADR-056, frozen by spike 0B)
//
// Stdout carries one JSON header line (UTF-8, newline-terminated) followed by
// a stream of length-prefixed binary chunks:
//
//   <u32_le stream_index>     // 0 = system audio, 1 = microphone
//   <u32_le nframes>          // sample count in this chunk (per channel)
//   <u64_le offset_ns>        // monotonic offset from session start
//   <f32_le samples * nframes> // 16 kHz mono interleaved (always mono = 1ch)
//
// Header schema:
//   { "sample_rate": 16000, "channels": 1, "format": "f32le",
//     "streams": ["app", "mic"], "started_at_ns": <u64> }
//
// Logs and errors go to stderr — never stdout. stdout is binary data.

/// 16 kHz mono float32 — the only output format. Whisper expects this rate.
let kSampleRate: Double = 16_000.0

/// Owns all stdout writes (header + binary chunks). CoreAudio IOProc threads
/// and the mic-engine tap only hand it already-copied raw frames and let the
/// resample + write happen here — never on a real-time audio thread (a full
/// stdout pipe blocking the audio path would glitch the whole system).
final class WriterQueue {
    static let shared = WriterQueue()
    private let queue = DispatchQueue(label: "pl.speedwave.audio-capture.writer")
    /// One AVAudioConverter per stream (0 = app, 1 = mic), created lazily from
    /// the first frame's actual format. Lives on the writer queue — single-threaded.
    private var converters: [Int: AVAudioConverter] = [:]
    /// 16 kHz mono float32 — the target for every stream.
    private let outFormat = AVAudioFormat(
        commonFormat: .pcmFormatFloat32, sampleRate: kSampleRate, channels: 1, interleaved: false)!

    /// Writes the JSON header line synchronously (called once, before any chunk).
    func writeHeader(streams: [String]) {
        // `started_at_ns` uses wall-clock; per-chunk `offset_ns` is a monotonic
        // mach-time delta. They are in different clock domains — the Rust reader
        // ignores `started_at_ns`, so this is informational only.
        let startedAtNs = UInt64(Date().timeIntervalSince1970 * 1_000_000_000)
        let header: [String: Any] = [
            "sample_rate": Int(kSampleRate), "channels": 1, "format": "f32le",
            "streams": streams, "started_at_ns": startedAtNs,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: header),
              var line = String(data: data, encoding: .utf8)
        else { exitWithError("Failed to serialize header") }
        line.append("\n")
        if let payload = line.data(using: .utf8) {
            FileHandle.standardOutput.write(payload)
        }
    }

    /// Hands a raw interleaved-float buffer (in `format`) for `streamIndex` to
    /// the writer queue: down-mix + resample to 16 kHz mono, frame, write.
    /// Non-blocking from the caller's side.
    func enqueue(
        streamIndex: UInt32, interleaved: [Float], format: AVAudioFormat, offsetNs: UInt64
    ) {
        queue.async { [self] in
            let idx = Int(streamIndex)
            guard let converter = converters[idx]
                ?? AVAudioConverter(from: format, to: outFormat)
            else { return }
            converters[idx] = converter

            let inFrames = AVAudioFrameCount(interleaved.count) / max(1, format.channelCount)
            guard inFrames > 0,
                  let inBuf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: inFrames)
            else { return }
            inBuf.frameLength = inFrames
            // Copy the raw interleaved samples into the input buffer. The input
            // format we hand the converter is always non-interleaved float (we
            // build it that way in the callers), so write one channel at a time.
            if format.isInterleaved {
                if let dst = inBuf.floatChannelData?[0] {
                    interleaved.withUnsafeBufferPointer { src in
                        guard let base = src.baseAddress else { return }
                        dst.update(from: base, count: interleaved.count)
                    }
                }
            } else if let dst = inBuf.floatChannelData {
                // De-interleave into per-channel planes.
                let ch = Int(format.channelCount)
                for f in 0..<Int(inFrames) {
                    for c in 0..<ch { dst[c][f] = interleaved[f * ch + c] }
                }
            }

            let ratio = kSampleRate / format.sampleRate
            let outCap = AVAudioFrameCount(Double(inFrames) * ratio + 16)
            guard let outBuf = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: outCap)
            else { return }
            var consumed = false
            var convErr: NSError?
            converter.convert(to: outBuf, error: &convErr) { _, status in
                if consumed {
                    status.pointee = .noDataNow
                    return nil
                }
                consumed = true
                status.pointee = .haveData
                return inBuf
            }
            if convErr != nil { return }
            let n = Int(outBuf.frameLength)
            guard n > 0, let raw = outBuf.floatChannelData else { return }
            let mono = Array(UnsafeBufferPointer(start: raw[0], count: n))
            writeChunk(streamIndex: streamIndex, samples: mono, offsetNs: offsetNs)
        }
    }

    /// Frames + writes one chunk to stdout. Only ever called on `queue`.
    private func writeChunk(streamIndex: UInt32, samples: [Float], offsetNs: UInt64) {
        var idx = streamIndex.littleEndian
        var n = UInt32(samples.count).littleEndian
        var off = offsetNs.littleEndian
        let stdout = FileHandle.standardOutput
        stdout.write(Data(bytes: &idx, count: 4))
        stdout.write(Data(bytes: &n, count: 4))
        stdout.write(Data(bytes: &off, count: 8))
        samples.withUnsafeBufferPointer { buf in stdout.write(Data(buffer: buf)) }
    }

    /// Drains any queued writes (best-effort, used on shutdown).
    func flush() { queue.sync {} }
}

/// Writes a diagnostic line to stderr — never stdout.
func logErr(_ message: String) {
    if let data = "\(message)\n".data(using: .utf8) {
        FileHandle.standardError.write(data)
    }
}

// MARK: - Argument parsing

/// Source for `--record --source`. `all` = system-wide tap; `pid:N` = single
/// process; `all-except:N` = system minus one process; `mic-only` = no system
/// tap at all, just the microphone (uses the public AVCaptureDevice consent
/// API, so the OS prompt fires — unlike CoreAudio process taps).
enum AudioSource {
    case all
    case pid(pid_t)
    case allExcept(pid_t)
    /// Microphone only, no system tap. Optional device UID (`nil` = default input).
    case micOnly(String?)
}

/// Microphone selector for `--mic` (mixes the mic in alongside a system tap).
/// `none` keeps the second stream omitted entirely.
enum MicSelector {
    case none
    case defaultDevice
    case device(String)
}

/// Parsed `--record` options. argv parser is unit-tested in `Tests/`.
struct RecordOptions {
    let source: AudioSource
    let mic: MicSelector
}

/// Parses `--record --source <s> [--mic <m>]` from argv (after the subcommand).
/// `--mic` is optional and defaults to `none`. Returns `nil` if any flag is
/// missing or malformed — caller exits with usage.
func parseRecordOptions(_ args: [String]) -> RecordOptions? {
    var source: AudioSource?
    var mic: MicSelector = .none
    var i = 0
    while i < args.count {
        let flag = args[i]
        guard i + 1 < args.count else { return nil }
        let val = args[i + 1]
        switch flag {
        case "--source":
            if val == "all" {
                source = .all
            } else if val == "mic-only" {
                source = .micOnly(nil)
            } else if val.hasPrefix("mic-only:") {
                source = .micOnly(String(val.dropFirst("mic-only:".count)))
            } else if val.hasPrefix("pid:") {
                guard let p = pid_t(val.dropFirst(4)) else { return nil }
                source = .pid(p)
            } else if val.hasPrefix("all-except:") {
                guard let p = pid_t(val.dropFirst("all-except:".count)) else { return nil }
                source = .allExcept(p)
            } else {
                return nil
            }
        case "--mic":
            if val == "none" {
                mic = .none
            } else if val == "default" {
                mic = .defaultDevice
            } else {
                mic = .device(val)
            }
        default:
            return nil
        }
        i += 2
    }
    guard let s = source else { return nil }
    return RecordOptions(source: s, mic: mic)
}

// MARK: - Process enumeration (--list)

/// Looks up `kAudioHardwarePropertyProcessObjectList` and emits a JSON array
/// of running audio processes on stdout, one element per pid that the OS
/// currently treats as an "audio object". Used by the Desktop UI to populate
/// the per-app source picker.
@available(macOS 14.4, *)
func listAudioProcesses() throws -> Data {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyProcessObjectList,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )

    var dataSize: UInt32 = 0
    let sizeStatus = AudioObjectGetPropertyDataSize(
        AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &dataSize)
    guard sizeStatus == noErr else {
        throw NSError(
            domain: "AudioCapture", code: Int(sizeStatus),
            userInfo: [NSLocalizedDescriptionKey: "ProcessObjectList size query failed"])
    }

    let count = Int(dataSize) / MemoryLayout<AudioObjectID>.size
    var ids = [AudioObjectID](repeating: 0, count: count)
    let getStatus = ids.withUnsafeMutableBufferPointer { buf -> OSStatus in
        guard let base = buf.baseAddress else { return kAudioHardwareUnspecifiedError }
        return AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &dataSize, base)
    }
    guard getStatus == noErr else {
        throw NSError(
            domain: "AudioCapture", code: Int(getStatus),
            userInfo: [NSLocalizedDescriptionKey: "ProcessObjectList fetch failed"])
    }

    var out: [[String: Any]] = []
    for id in ids {
        guard let pid = pidForAudioProcess(id) else { continue }
        let bundleId = bundleIdForAudioProcess(id) ?? ""
        out.append([
            "pid": Int(pid),
            "bundle_id": bundleId,
            "object_id": Int(id),
        ])
    }
    return try JSONSerialization.data(withJSONObject: out, options: [.sortedKeys])
}

/// Reads the `kAudioProcessPropertyPID` of an audio process object.
@available(macOS 14.4, *)
func pidForAudioProcess(_ object: AudioObjectID) -> pid_t? {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioProcessPropertyPID,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var pid: pid_t = -1
    var size = UInt32(MemoryLayout<pid_t>.size)
    let status = AudioObjectGetPropertyData(object, &addr, 0, nil, &size, &pid)
    return status == noErr && pid > 0 ? pid : nil
}

/// Reads the bundle identifier of an audio process object (often empty for
/// background processes and helpers).
@available(macOS 14.4, *)
func bundleIdForAudioProcess(_ object: AudioObjectID) -> String? {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioProcessPropertyBundleID,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    // The selector returns a +1-retained CFString; receive it via an opaque
    // pointer slot, then take ownership through Unmanaged so ARC balances it.
    var sz = UInt32(MemoryLayout<CFString?>.size)
    var raw: Unmanaged<CFString>?
    let status = withUnsafeMutablePointer(to: &raw) { ptr -> OSStatus in
        AudioObjectGetPropertyData(object, &addr, 0, nil, &sz, ptr)
    }
    guard status == noErr, let cf = raw?.takeRetainedValue() else { return nil }
    let s = cf as String
    return s.isEmpty ? nil : s
}

// MARK: - Input device enumeration (--list-mics)

/// Emits a JSON array of input-capable audio devices (`{uid, name, default}`)
/// on stdout so the UI can offer a microphone picker.
@available(macOS 14.4, *)
func listInputDevices() throws -> Data {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var dataSize: UInt32 = 0
    guard
        AudioObjectGetPropertyDataSize(
            AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &dataSize) == noErr
    else {
        throw NSError(
            domain: "AudioCapture", code: -1,
            userInfo: [NSLocalizedDescriptionKey: "device list size query failed"])
    }
    let count = Int(dataSize) / MemoryLayout<AudioObjectID>.size
    var ids = [AudioObjectID](repeating: 0, count: count)
    _ = ids.withUnsafeMutableBufferPointer { buf in
        AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &dataSize,
            buf.baseAddress!)
    }
    let defaultId = defaultInputDevice()
    var out: [[String: Any]] = []
    for id in ids where deviceHasInput(id) {
        guard let uid = deviceStringProperty(id, kAudioDevicePropertyDeviceUID) else { continue }
        let name = deviceStringProperty(id, kAudioObjectPropertyName) ?? uid
        out.append(["uid": uid, "name": name, "default": id == defaultId])
    }
    return try JSONSerialization.data(withJSONObject: out, options: [.sortedKeys])
}

/// `true` if `device` has at least one input channel.
@available(macOS 14.4, *)
func deviceHasInput(_ device: AudioObjectID) -> Bool {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyStreamConfiguration,
        mScope: kAudioObjectPropertyScopeInput,
        mElement: kAudioObjectPropertyElementMain
    )
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(device, &addr, 0, nil, &size) == noErr, size > 0 else {
        return false
    }
    let buf = UnsafeMutableRawPointer.allocate(
        byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
    defer { buf.deallocate() }
    guard AudioObjectGetPropertyData(device, &addr, 0, nil, &size, buf) == noErr else {
        return false
    }
    let list = buf.assumingMemoryBound(to: AudioBufferList.self)
    let abl = UnsafeMutableAudioBufferListPointer(list)
    return abl.contains { $0.mNumberChannels > 0 }
}

/// The system default input device id, or `0` if unavailable.
@available(macOS 14.4, *)
func defaultInputDevice() -> AudioObjectID {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultInputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var id: AudioObjectID = 0
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    _ = AudioObjectGetPropertyData(
        AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &id)
    return id
}

/// Reads a CFString device property (e.g. UID or name) as a Swift `String`.
@available(macOS 14.4, *)
func deviceStringProperty(_ device: AudioObjectID, _ selector: AudioObjectPropertySelector)
    -> String?
{
    var addr = AudioObjectPropertyAddress(
        mSelector: selector,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var sz = UInt32(MemoryLayout<CFString?>.size)
    var raw: Unmanaged<CFString>?
    let status = withUnsafeMutablePointer(to: &raw) { ptr -> OSStatus in
        AudioObjectGetPropertyData(device, &addr, 0, nil, &sz, ptr)
    }
    guard status == noErr, let cf = raw?.takeRetainedValue() else { return nil }
    let s = cf as String
    return s.isEmpty ? nil : s
}

// MARK: - CLI entry point

/// audio-capture-cli <command> [args]
/// Commands:
///   --list                                     enumerate audio processes (JSON, stdout)
///   --record --source <all|pid:N|all-except:N> --mic <none|default|<uid>>
///                                              stream framed PCM to stdout
@main
struct AudioCaptureCLI {
    static func main() {
        let args = CommandLine.arguments
        guard args.count >= 2 else {
            exitWithError(
                "Usage: audio-capture-cli --list | --record --source <all|pid:N|all-except:N> --mic <none|default|<uid>>"
            )
        }

        // Both subcommands need macOS 14.4 (process taps API). Fail fast and
        // honestly on older systems — Rust caller surfaces a friendly message.
        guard #available(macOS 14.4, *) else {
            exitWithError(
                "audio-capture-cli requires macOS 14.4 or newer (CoreAudio process taps)")
        }

        switch args[1] {
        case "--list":
            do {
                let data = try listAudioProcesses()
                if let s = String(data: data, encoding: .utf8) { print(s) }
            } catch {
                exitWithError("list failed: \(error.localizedDescription)")
            }

        case "--list-mics":
            do {
                let data = try listInputDevices()
                if let s = String(data: data, encoding: .utf8) { print(s) }
            } catch {
                exitWithError("list-mics failed: \(error.localizedDescription)")
            }

        case "--record":
            let tail = Array(args.dropFirst(2))
            guard let opts = parseRecordOptions(tail) else {
                exitWithError(
                    "Bad --record flags. Need --source <all|pid:N|all-except:N> --mic <none|default|<uid>>"
                )
            }
            runRecord(opts)

        default:
            exitWithError("Unknown command: \(args[1]). Use --list or --record.")
        }
    }
}

// MARK: - Record session

/// Owns the active capture session (process tap, aggregate device, IOProc id,
/// optional AVAudioEngine for the mic). Held in a global so the signal handler
/// can tear it down cleanly on SIGTERM/SIGINT.
@available(macOS 14.4, *)
final class RecordSession {
    /// CoreAudio object id of the process tap.
    var tapId: AudioObjectID = 0
    /// CoreAudio object id of the aggregate device wrapping the tap.
    var aggregateId: AudioObjectID = 0
    /// IOProc handle so we can `AudioDeviceStop` + `AudioDeviceDestroyIOProcID`.
    var ioProcId: AudioDeviceIOProcID?
    /// Optional mic engine; nil when --mic none.
    var micEngine: AVAudioEngine?
    /// Monotonic nanoseconds reference for `offset_ns`.
    let startMachAbs: UInt64 = mach_absolute_time()

    /// Converts a mach absolute time delta to nanoseconds. Cached timebase.
    func offsetNs() -> UInt64 {
        var info = mach_timebase_info_data_t()
        mach_timebase_info(&info)
        let delta = mach_absolute_time() - startMachAbs
        return delta &* UInt64(info.numer) / UInt64(info.denom)
    }

    /// Tears down everything in the safe order. Idempotent — safe from a
    /// signal handler that may fire after a normal exit path already ran.
    func teardown() {
        if let proc = ioProcId, aggregateId != 0 {
            AudioDeviceStop(aggregateId, proc)
            AudioDeviceDestroyIOProcID(aggregateId, proc)
            ioProcId = nil
        }
        if aggregateId != 0 {
            AudioHardwareDestroyAggregateDevice(aggregateId)
            aggregateId = 0
        }
        if tapId != 0 {
            AudioHardwareDestroyProcessTap(tapId)
            tapId = 0
        }
        micEngine?.stop()
        micEngine = nil
    }
}

/// Stored as a global so the signal handler (a C-style trampoline) can find
/// the in-flight session — `signal(2)` handlers cannot capture context.
@available(macOS 14.4, *)
var activeSession: RecordSession?

/// SIGTERM/SIGINT handler — installed once at record start.
let cleanupHandler: @convention(c) (Int32) -> Void = { _ in
    if #available(macOS 14.4, *) {
        activeSession?.teardown()
    }
    // Drain any frames still queued on the writer thread, then flush the C
    // stdio buffer so the parent doesn't see a truncated chunk.
    WriterQueue.shared.flush()
    fflush(stdout)
    _exit(0)
}

@available(macOS 14.4, *)
func runRecord(_ opts: RecordOptions) {
    let session = RecordSession()
    activeSession = session

    signal(SIGTERM, cleanupHandler)
    signal(SIGINT, cleanupHandler)

    // mic-only: no system tap, just the microphone on stream 0. Uses the public
    // AVCaptureDevice consent API so the OS prompt fires.
    if case .micOnly = opts.source {
        guard requestMicrophoneAccess() else {
            logErr(
                "microphone access denied — grant it in System Settings → Privacy & Security → Microphone")
            exit(2)
        }
        WriterQueue.shared.writeHeader(streams: ["mic"])
        do {
            try startMicEngine(session: session, selector: .defaultDevice, streamIndex: 0)
        } catch {
            logErr("mic record start failed: \(error.localizedDescription)")
            session.teardown()
            exit(1)
        }
        RunLoop.main.run()
        return
    }

    // System tap path. The system-audio TCC prompt has no public trigger, so
    // request it via the private API first — without it the tap silently
    // delivers zeroed buffers (ADR-056 decision 3).
    guard preflightSystemAudioConsent() else {
        logErr(
            "system audio recording permission denied — grant it in System Settings → Privacy & Security → System Audio Recording Only")
        exit(2)
    }

    // System tap (+ optionally the mic mixed in as stream 1; the Rust side
    // sums streams 0 and 1 into one mono stream — see CliAudioStream).
    let streams: [String]
    switch opts.mic {
    case .none: streams = ["app"]
    default: streams = ["app", "mic"]
    }
    WriterQueue.shared.writeHeader(streams: streams)

    do {
        try startSystemTap(session: session, source: opts.source)
        if case .none = opts.mic {} else {
            // The mic prompt fires here too (public API), so a mixed capture
            // gets at least the mic if the system-tap permission is missing.
            if requestMicrophoneAccess() {
                try startMicEngine(session: session, selector: opts.mic, streamIndex: 1)
            } else {
                logErr("microphone access denied — recording system audio only")
            }
        }
    } catch {
        logErr("record start failed: \(error.localizedDescription)")
        session.teardown()
        exit(1)
    }

    // Park the main thread; IOProc + AVAudioEngine push samples from CoreAudio
    // threads. RunLoop.main.run() never returns until cleanupHandler exits.
    RunLoop.main.run()
}

/// Translates a Unix pid to the matching CoreAudio process object id.
/// Returns 0 if the pid does not currently own an audio process object.
@available(macOS 14.4, *)
func translatePidToProcessObject(_ pid: pid_t) -> AudioObjectID {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyTranslatePIDToProcessObject,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var inPid = pid
    var outObject: AudioObjectID = 0
    let inSize = UInt32(MemoryLayout<pid_t>.size)
    var outSize = UInt32(MemoryLayout<AudioObjectID>.size)
    let status = AudioObjectGetPropertyData(
        AudioObjectID(kAudioObjectSystemObject), &addr,
        inSize, &inPid, &outSize, &outObject)
    return status == noErr ? outObject : 0
}

/// Creates the process tap + aggregate device and starts an IOProc that emits
/// stream 0 ("app"). Falls through to the caller on success; throws on error.
@available(macOS 14.4, *)
func startSystemTap(session: RecordSession, source: AudioSource) throws {
    let description = CATapDescription()
    description.isMixdown = true
    description.isMono = false
    switch source {
    case .all:
        description.processes = []
        description.isExclusive = true  // empty exclude-list = capture everything
    case .pid(let p):
        let obj = translatePidToProcessObject(p)
        guard obj != 0 else {
            throw NSError(
                domain: "AudioCapture", code: -1,
                userInfo: [NSLocalizedDescriptionKey: "pid \(p) has no audio process object"])
        }
        description.processes = [obj]
        description.isExclusive = false  // include-only this pid
    case .allExcept(let p):
        let obj = translatePidToProcessObject(p)
        guard obj != 0 else {
            throw NSError(
                domain: "AudioCapture", code: -1,
                userInfo: [NSLocalizedDescriptionKey: "pid \(p) has no audio process object"])
        }
        description.processes = [obj]
        description.isExclusive = true
    case .micOnly:
        // Unreachable — runRecord handles mic-only before getting here.
        throw NSError(
            domain: "AudioCapture", code: -1,
            userInfo: [NSLocalizedDescriptionKey: "mic-only must not reach startSystemTap"])
    }
    description.uuid = UUID()
    description.muteBehavior = .unmuted

    var tapId: AudioObjectID = 0
    let tapStatus = AudioHardwareCreateProcessTap(description, &tapId)
    guard tapStatus == noErr, tapId != 0 else {
        throw NSError(
            domain: "AudioCapture", code: Int(tapStatus),
            userInfo: [NSLocalizedDescriptionKey: "AudioHardwareCreateProcessTap failed"])
    }
    session.tapId = tapId

    // Wrap the tap in a private aggregate device so we can attach an IOProc
    // (taps are not directly addressable as IO targets).
    let aggUid = "pl.speedwave.audio-capture.\(UUID().uuidString)"
    let aggDescription: [String: Any] = [
        kAudioAggregateDeviceNameKey: "Speedwave Audio Capture",
        kAudioAggregateDeviceUIDKey: aggUid,
        kAudioAggregateDeviceIsPrivateKey: 1,
        kAudioAggregateDeviceIsStackedKey: 0,
        kAudioAggregateDeviceTapAutoStartKey: 1,
        kAudioAggregateDeviceTapListKey: [
            [
                kAudioSubTapUIDKey: description.uuid.uuidString,
                kAudioSubTapDriftCompensationKey: 1,
            ]
        ],
    ]
    var aggId: AudioObjectID = 0
    let aggStatus = AudioHardwareCreateAggregateDevice(aggDescription as CFDictionary, &aggId)
    guard aggStatus == noErr, aggId != 0 else {
        throw NSError(
            domain: "AudioCapture", code: Int(aggStatus),
            userInfo: [NSLocalizedDescriptionKey: "AudioHardwareCreateAggregateDevice failed"])
    }
    session.aggregateId = aggId

    // The aggregate device's input stream format tells us the *real* sample
    // rate + channel count CoreAudio will deliver — never assume 48 kHz. A tap
    // mixdown arrives as one interleaved float buffer, so we hand the writer
    // queue an interleaved float format matching it.
    let inputFormat = inputStreamFormat(of: aggId)
    let inChannels = max(1, inputFormat.mChannelsPerFrame)
    guard let avInFormat = AVAudioFormat(
        commonFormat: .pcmFormatFloat32, sampleRate: inputFormat.mSampleRate,
        channels: AVAudioChannelCount(inChannels), interleaved: true)
    else {
        throw NSError(
            domain: "AudioCapture", code: -1,
            userInfo: [NSLocalizedDescriptionKey: "could not build input AVAudioFormat (rate \(inputFormat.mSampleRate))"])
    }

    // IOProc runs on a real-time CoreAudio thread: it only copies the buffer's
    // float samples into a Swift array and hands them to the writer queue. No
    // resampling, no stdout, no locking on the audio path.
    var procId: AudioDeviceIOProcID?
    let procStatus = AudioDeviceCreateIOProcIDWithBlock(
        &procId, aggId, nil
    ) { _, inputData, _, _, _ in
        let abl = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inputData))
        guard let first = abl.first, let mData = first.mData else { return }
        let count = Int(first.mDataByteSize) / MemoryLayout<Float32>.size
        guard count > 0 else { return }
        let interleaved = [Float](
            unsafeUninitializedCapacity: count
        ) { buf, initialized in
            mData.withMemoryRebound(to: Float32.self, capacity: count) { src in
                buf.baseAddress?.update(from: src, count: count)
            }
            initialized = count
        }
        let offset = activeSession?.offsetNs() ?? 0
        WriterQueue.shared.enqueue(
            streamIndex: 0, interleaved: interleaved, format: avInFormat, offsetNs: offset)
    }
    guard procStatus == noErr, let proc = procId else {
        throw NSError(
            domain: "AudioCapture", code: Int(procStatus),
            userInfo: [NSLocalizedDescriptionKey: "IOProc create failed"])
    }
    session.ioProcId = proc

    let startStatus = AudioDeviceStart(aggId, proc)
    guard startStatus == noErr else {
        throw NSError(
            domain: "AudioCapture", code: Int(startStatus),
            userInfo: [NSLocalizedDescriptionKey: "AudioDeviceStart failed"])
    }
}

/// Reads the input-scope stream format (`AudioStreamBasicDescription`) of a
/// device. Falls back to a 48 kHz stereo float layout only if the query fails
/// (it shouldn't for an aggregate device we just created).
@available(macOS 14.4, *)
func inputStreamFormat(of device: AudioObjectID) -> AudioStreamBasicDescription {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyStreamFormat,
        mScope: kAudioDevicePropertyScopeInput,
        mElement: kAudioObjectPropertyElementMain)
    var asbd = AudioStreamBasicDescription()
    var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
    let status = AudioObjectGetPropertyData(device, &addr, 0, nil, &size, &asbd)
    if status == noErr, asbd.mSampleRate > 0 {
        return asbd
    }
    var fallback = AudioStreamBasicDescription()
    fallback.mSampleRate = 48_000
    fallback.mChannelsPerFrame = 2
    fallback.mFormatID = kAudioFormatLinearPCM
    return fallback
}

/// Requests the "System Audio Recording" (TCC `kTCCServiceAudioCapture`) consent
/// via the private `TCCAccessRequest` API — there is no public trigger for this
/// prompt (decision 3, ADR-056). `dlopen`/`dlsym`-guarded: if the symbol is
/// missing on a future macOS, returns `false` and the caller exits "permission
/// unavailable" (the UI then deep-links the user to System Settings) — it does
/// not crash. Blocks for the prompt result. Returns `true` if granted.
func preflightSystemAudioConsent() -> Bool {
    // `TCCAccessRequest(service, options, completion)` — 3 args; the nullable
    // options dictionary must be passed or TCC treats the block as the options
    // and crashes with `-[__NSMallocBlock__ objectForKey:]`.
    typealias TCCRequestFn = @convention(c) (
        CFString, CFDictionary?, @escaping @convention(block) (Bool) -> Void
    ) -> Void
    guard let handle = dlopen(
        "/System/Library/PrivateFrameworks/TCC.framework/TCC", RTLD_NOW)
    else {
        logErr("TCC.framework unavailable — cannot prompt for System Audio Recording")
        return false
    }
    defer { dlclose(handle) }
    guard let sym = dlsym(handle, "TCCAccessRequest") else {
        logErr("TCCAccessRequest unavailable — cannot prompt for System Audio Recording")
        return false
    }
    let request = unsafeBitCast(sym, to: TCCRequestFn.self)
    let service = "kTCCServiceAudioCapture" as CFString
    let sema = DispatchSemaphore(value: 0)
    var granted = false
    request(service, nil) { ok in
        granted = ok
        sema.signal()
    }
    sema.wait()
    return granted
}

/// Requests microphone consent via the public `AVCaptureDevice` API. This DOES
/// show the macOS consent prompt (the embedded `NSMicrophoneUsageDescription`
/// supplies the text) — unlike CoreAudio process taps, which have no public
/// trigger. Blocks until the user responds (or, if already decided, returns
/// immediately). Returns `true` if access is granted.
func requestMicrophoneAccess() -> Bool {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized:
        return true
    case .denied, .restricted:
        return false
    case .notDetermined:
        let sema = DispatchSemaphore(value: 0)
        var granted = false
        AVCaptureDevice.requestAccess(for: .audio) { ok in
            granted = ok
            sema.signal()
        }
        sema.wait()
        return granted
    @unknown default:
        return false
    }
}

/// Spins up an AVAudioEngine on the default microphone and tees its frames into
/// the framed protocol on `streamIndex` (0 for mic-only, 1 when mixed alongside
/// a system tap) — via the writer queue, not on the engine's tap thread.
@available(macOS 14.4, *)
func startMicEngine(session: RecordSession, selector: MicSelector, streamIndex: UInt32) throws {
    let engine = AVAudioEngine()
    let inputNode = engine.inputNode

    // Route to a named device before reading the format — the engine's input
    // format follows the bound device. A missing/unknown UID falls back to the
    // system default (logged), so a stale picked device never fails capture.
    if case .device(let uid) = selector {
        if let deviceId = inputDeviceId(forUID: uid) {
            do {
                try inputNode.auAudioUnit.setDeviceID(deviceId)
            } catch {
                logErr("mic device '\(uid)' could not be set (\(error)); using default")
            }
        } else {
            logErr("mic device UID '\(uid)' not found; using default")
        }
    }
    let format = inputNode.outputFormat(forBus: 0)

    inputNode.installTap(onBus: 0, bufferSize: 4096, format: format) { buf, _ in
        let frames = Int(buf.frameLength)
        let channels = Int(buf.format.channelCount)
        guard frames > 0, let chan = buf.floatChannelData else { return }
        // Interleave the engine's non-interleaved channels into one array, then
        // hand a matching interleaved format to the writer queue (which will
        // deinterleave + down-mix + resample). Keeping it simple: the engine's
        // float format is what we pass through unchanged otherwise.
        var interleaved = [Float](repeating: 0, count: frames * channels)
        for f in 0..<frames {
            for c in 0..<channels { interleaved[f * channels + c] = chan[c][f] }
        }
        guard let interleavedFmt = AVAudioFormat(
            commonFormat: .pcmFormatFloat32, sampleRate: buf.format.sampleRate,
            channels: AVAudioChannelCount(channels), interleaved: true)
        else { return }
        let offset = activeSession?.offsetNs() ?? 0
        WriterQueue.shared.enqueue(
            streamIndex: streamIndex, interleaved: interleaved, format: interleavedFmt,
            offsetNs: offset)
    }

    engine.prepare()
    try engine.start()
    session.micEngine = engine
}

/// Resolves a device UID string to its `AudioDeviceID`, or `nil` if no input
/// device matches (the UID is stale or the device was unplugged).
@available(macOS 14.4, *)
func inputDeviceId(forUID uid: String) -> AudioDeviceID? {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var size: UInt32 = 0
    guard
        AudioObjectGetPropertyDataSize(
            AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size) == noErr
    else { return nil }
    let count = Int(size) / MemoryLayout<AudioObjectID>.size
    var ids = [AudioObjectID](repeating: 0, count: count)
    _ = ids.withUnsafeMutableBufferPointer { buf in
        AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, buf.baseAddress!)
    }
    return ids.first { deviceHasInput($0) && deviceStringProperty($0, kAudioDevicePropertyDeviceUID) == uid }
}
