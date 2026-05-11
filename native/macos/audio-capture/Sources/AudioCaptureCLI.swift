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
/// Approximate chunk size (~200 ms) — kept small so the parent's reader
/// surfaces audio promptly while staying well above pipe buffer overhead.
let kChunkFrames: Int = 3200

/// Writes a single binary chunk to stdout in the framed protocol.
func writeChunk(streamIndex: UInt32, samples: [Float], offsetNs: UInt64) {
    var idx = streamIndex.littleEndian
    var n = UInt32(samples.count).littleEndian
    var off = offsetNs.littleEndian

    let stdout = FileHandle.standardOutput
    stdout.write(Data(bytes: &idx, count: 4))
    stdout.write(Data(bytes: &n, count: 4))
    stdout.write(Data(bytes: &off, count: 8))
    samples.withUnsafeBufferPointer { buf in
        stdout.write(Data(buffer: buf))
    }
}

/// Writes the JSON header line. Called once at session start.
func writeHeader(streams: [String]) {
    let startedAtNs = UInt64(Date().timeIntervalSince1970 * 1_000_000_000)
    let header: [String: Any] = [
        "sample_rate": Int(kSampleRate),
        "channels": 1,
        "format": "f32le",
        "streams": streams,
        "started_at_ns": startedAtNs,
    ]
    guard let data = try? JSONSerialization.data(withJSONObject: header),
          var line = String(data: data, encoding: .utf8)
    else {
        exitWithError("Failed to serialize header")
    }
    line.append("\n")
    if let payload = line.data(using: .utf8) {
        FileHandle.standardOutput.write(payload)
    }
}

/// Writes a diagnostic line to stderr — never stdout.
func logErr(_ message: String) {
    if let data = "\(message)\n".data(using: .utf8) {
        FileHandle.standardError.write(data)
    }
}

// MARK: - Argument parsing

/// Source for `--record --source`. `all` = system-wide tap; `pid:N` = single
/// process; `all-except:N` = system minus one process (e.g. excluding the
/// speaker so we don't double-capture our own output).
enum AudioSource {
    case all
    case pid(pid_t)
    case allExcept(pid_t)
}

/// Microphone selector for `--mic`. `none` keeps the stream omitted entirely.
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

/// Parses `--record --source <s> --mic <m>` from argv (after the subcommand).
/// Returns `nil` if any flag is missing or malformed — caller exits with usage.
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
    // Flush stdout so the parent doesn't see a truncated chunk.
    fflush(stdout)
    _exit(0)
}

@available(macOS 14.4, *)
func runRecord(_ opts: RecordOptions) {
    let session = RecordSession()
    activeSession = session

    signal(SIGTERM, cleanupHandler)
    signal(SIGINT, cleanupHandler)

    let streams: [String]
    switch opts.mic {
    case .none: streams = ["app"]
    default: streams = ["app", "mic"]
    }
    writeHeader(streams: streams)

    do {
        try startSystemTap(session: session, source: opts.source)
        if case .none = opts.mic {} else {
            try startMicEngine(session: session, selector: opts.mic)
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

    // IOProc receives interleaved float samples in the device's native rate;
    // we resample to 16 kHz mono on the fly with AVAudioConverter (set up
    // lazily on the first callback once we know the input format).
    var procId: AudioDeviceIOProcID?
    let procStatus = AudioDeviceCreateIOProcIDWithBlock(
        &procId, aggId, nil
    ) { _, inputData, _, _, _ in
        ioProcCallback(streamIndex: 0, inputData: inputData)
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

/// Per-stream resampler state. We keep one converter per stream so the input
/// format probe happens once. Indexed by stream id (0 = app, 1 = mic).
final class StreamResampler {
    var converter: AVAudioConverter?
    var outputFormat: AVAudioFormat
    init() {
        outputFormat = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: kSampleRate,
            channels: 1,
            interleaved: false)!
    }
}
/// One resampler per stream. The IOProc callback resolves which slot to use
/// from the `streamIndex` argument.
var resamplers: [Int: StreamResampler] = [0: StreamResampler(), 1: StreamResampler()]

/// Shared IOProc callback for both the tap-aggregate and the mic engine.
/// Pulls samples out of the AudioBufferList, runs them through the per-stream
/// AVAudioConverter (resample → 16 kHz mono), and writes one binary chunk.
@available(macOS 14.4, *)
func ioProcCallback(streamIndex: UInt32, inputData: UnsafePointer<AudioBufferList>) {
    guard let resampler = resamplers[Int(streamIndex)] else { return }
    let ablPointer = UnsafeMutableAudioBufferListPointer(
        UnsafeMutablePointer(mutating: inputData))
    guard let first = ablPointer.first,
          let mData = first.mData
    else { return }

    // Treat the input as float interleaved at whatever rate CoreAudio gives
    // us; the converter handles the deinterleave + resample.
    let inputBytes = Int(first.mDataByteSize)
    let inputFrames = inputBytes / (MemoryLayout<Float32>.size * Int(first.mNumberChannels))
    guard inputFrames > 0 else { return }

    // Lazy-init the converter on the first callback (we don't know the device
    // native format up front for the aggregate device).
    if resampler.converter == nil {
        guard let inputFormat = AVAudioFormat(
            standardFormatWithSampleRate: 48_000.0,
            channels: AVAudioChannelCount(first.mNumberChannels)),
              let conv = AVAudioConverter(from: inputFormat, to: resampler.outputFormat)
        else {
            return
        }
        resampler.converter = conv
    }
    guard let converter = resampler.converter,
          let inputBuf = AVAudioPCMBuffer(
            pcmFormat: converter.inputFormat,
            frameCapacity: AVAudioFrameCount(inputFrames))
    else { return }
    inputBuf.frameLength = AVAudioFrameCount(inputFrames)
    if let raw = inputBuf.floatChannelData {
        memcpy(raw[0], mData, inputBytes)
    }

    let outFrames = AVAudioFrameCount(
        Double(inputFrames) * kSampleRate / converter.inputFormat.sampleRate + 1)
    guard let outputBuf = AVAudioPCMBuffer(
        pcmFormat: resampler.outputFormat, frameCapacity: outFrames)
    else { return }
    var err: NSError?
    converter.convert(to: outputBuf, error: &err) { _, status in
        status.pointee = .haveData
        return inputBuf
    }
    if err != nil { return }

    let n = Int(outputBuf.frameLength)
    guard n > 0, let raw = outputBuf.floatChannelData else { return }
    let samples = Array(UnsafeBufferPointer(start: raw[0], count: n))

    let offset = activeSession?.offsetNs() ?? 0
    writeChunk(streamIndex: streamIndex, samples: samples, offsetNs: offset)
}

/// Spins up an AVAudioEngine on the default (or named) microphone and tees
/// resampled mono float frames into the framed protocol as stream 1.
@available(macOS 14.4, *)
func startMicEngine(session: RecordSession, selector: MicSelector) throws {
    let engine = AVAudioEngine()
    let inputNode = engine.inputNode
    let format = inputNode.outputFormat(forBus: 0)

    inputNode.installTap(onBus: 0, bufferSize: 4096, format: format) { buf, _ in
        guard let resampler = resamplers[1],
              let inputBuf = AVAudioPCMBuffer(
                pcmFormat: buf.format, frameCapacity: buf.frameLength)
        else { return }
        if let src = buf.floatChannelData, let dst = inputBuf.floatChannelData {
            memcpy(dst[0], src[0], Int(buf.frameLength) * MemoryLayout<Float32>.size)
            inputBuf.frameLength = buf.frameLength
        }
        if resampler.converter == nil,
           let conv = AVAudioConverter(from: buf.format, to: resampler.outputFormat) {
            resampler.converter = conv
        }
        guard let converter = resampler.converter else { return }
        let outFrames = AVAudioFrameCount(
            Double(buf.frameLength) * kSampleRate / buf.format.sampleRate + 1)
        guard let outBuf = AVAudioPCMBuffer(
            pcmFormat: resampler.outputFormat, frameCapacity: outFrames)
        else { return }
        var err: NSError?
        converter.convert(to: outBuf, error: &err) { _, status in
            status.pointee = .haveData
            return inputBuf
        }
        if err != nil { return }
        let n = Int(outBuf.frameLength)
        guard n > 0, let raw = outBuf.floatChannelData else { return }
        let samples = Array(UnsafeBufferPointer(start: raw[0], count: n))
        let offset = activeSession?.offsetNs() ?? 0
        writeChunk(streamIndex: 1, samples: samples, offsetNs: offset)
    }

    // The `selector` is plumbed so a future iteration can route to a named
    // device UID via `kAudioDevicePropertyDeviceUID`; today we honor the
    // engine default. We log the selector for transparency.
    switch selector {
    case .device(let uid):
        logErr("mic selector device='\(uid)' (default device used; named routing not yet wired)")
    case .defaultDevice, .none:
        break
    }

    engine.prepare()
    try engine.start()
    session.micEngine = engine
}
