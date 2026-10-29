import AVFoundation
import CoreAudio
import Foundation
import SafeAudioTap
import SharedCLI


/// 16 kHz mono float32 — the only output format. Whisper expects this rate.
let kSampleRate: Double = 16_000.0

/// Delay that coalesces a burst of configuration-change notifications into one mic restart.
let micRestartDebounce: TimeInterval = 0.2

/// Wait before the first retry of a mic that failed to start; doubles with every further failure.
let micRetryBaseDelay: TimeInterval = 1

/// Longest wait between two retries of a mic that failed to start.
let micRetryMaxDelay: TimeInterval = 30

/// Runs a body after a delay; `RecordSession.scheduleMicRestart` in production, a recorder in tests.
typealias MicRestartScheduler = (TimeInterval, @escaping () -> Void) -> Void

/// What asked for a mic restart; logged with every restart so a storm shows its driver.
enum MicRestartTrigger: CustomStringConvertible {
    case engineConfigurationChange
    case defaultInputDeviceChange
    case inputDeviceListChange
    case retryAfterFailedStart

    var description: String {
        switch self {
        case .engineConfigurationChange: return "an engine configuration change"
        case .defaultInputDeviceChange: return "a default input device change"
        case .inputDeviceListChange: return "an input device list change"
        case .retryAfterFailedStart: return "a retry of a failed start"
        }
    }
}

/// Owns all stdout writes (header + binary chunks). CoreAudio IOProc threads and the mic-engine tap
/// only hand it already-copied raw frames; resample + write happen here, never on the real-time audio thread.
final class WriterQueue {
    static let shared = WriterQueue()
    private let queue = DispatchQueue(label: "pl.speedwave.audio-capture.writer")
    /// One AVAudioConverter per stream (0 = app, 1 = mic), created lazily from the first
    /// frame's format. Lives on the writer queue — single-threaded.
    private var converters: [Int: AVAudioConverter] = [:]
    /// 16 kHz mono float32 — the target for every stream.
    private let outFormat = AVAudioFormat(
        commonFormat: .pcmFormatFloat32, sampleRate: kSampleRate, channels: 1, interleaved: false)!

    /// Writes the JSON header line synchronously (called once, before any chunk).
    func writeHeader(streams: [String]) {
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

    /// Hands a raw interleaved-float buffer (in `format`) for `streamIndex` to the writer queue:
    /// down-mix + resample to 16 kHz mono, frame, write. Non-blocking from the caller's side.
    func enqueue(
        streamIndex: UInt32, interleaved: [Float], format: AVAudioFormat, offsetNs: UInt64
    ) {
        queue.async { [self] in
            let idx = Int(streamIndex)
            if let cached = converters[idx], cached.inputFormat != format {
                logErr(
                    "stream \(idx) input format changed (\(cached.inputFormat.sampleRate) Hz → \(format.sampleRate) Hz); rebuilding converter"
                )
                converters[idx] = nil
            }
            guard let converter = converters[idx]
                ?? AVAudioConverter(from: format, to: outFormat)
            else { return }
            converters[idx] = converter

            let inFrames = AVAudioFrameCount(interleaved.count) / max(1, format.channelCount)
            guard inFrames > 0,
                  let inBuf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: inFrames)
            else { return }
            inBuf.frameLength = inFrames
            if format.isInterleaved {
                if let dst = inBuf.floatChannelData?[0] {
                    interleaved.withUnsafeBufferPointer { src in
                        guard let base = src.baseAddress else { return }
                        dst.update(from: base, count: interleaved.count)
                    }
                }
            } else if let dst = inBuf.floatChannelData {
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

    /// Flushes each converter's resampler tail, then drains queued writes, so a
    /// graceful stop is not truncated. Best-effort, used on shutdown.
    func flush(offsetNs: UInt64) {
        queue.sync { [self] in
            for (idx, converter) in converters {
                drainConverterTail(streamIndex: UInt32(idx), converter: converter, offsetNs: offsetNs)
            }
        }
    }

    /// Feeds `.endOfStream` to one converter and writes its tail. On `queue` only.
    private func drainConverterTail(
        streamIndex: UInt32, converter: AVAudioConverter, offsetNs: UInt64
    ) {
        guard let outBuf = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: 4096) else {
            return
        }
        var convErr: NSError?
        converter.convert(to: outBuf, error: &convErr) { _, status in
            status.pointee = .endOfStream
            return nil
        }
        if convErr != nil { return }
        let n = Int(outBuf.frameLength)
        guard n > 0, let raw = outBuf.floatChannelData else { return }
        let mono = Array(UnsafeBufferPointer(start: raw[0], count: n))
        writeChunk(streamIndex: streamIndex, samples: mono, offsetNs: offsetNs)
    }
}

/// Writes a diagnostic line to stderr — never stdout.
func logErr(_ message: String) {
    if let data = "\(message)\n".data(using: .utf8) {
        FileHandle.standardError.write(data)
    }
}


/// Source for `--record --source`. `all` = system-wide tap; `mic-only` = no system tap, just the mic
/// (uses the public AVCaptureDevice consent API, so the OS prompt fires — unlike CoreAudio process taps).
enum AudioSource {
    case all
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

/// A mic engine that could not start; the message names the device and the reason.
struct MicStartError: LocalizedError {
    let errorDescription: String?

    init(_ message: String) {
        errorDescription = message
    }
}

/// The mic selector for a `mic-only[:uid]` source: the named device, or default.
func micSelector(forMicOnly uid: String?) -> MicSelector {
    uid.map { .device($0) } ?? .defaultDevice
}

/// Parses `--record --source <s> [--mic <m>]` from argv (after the subcommand). `--mic` is optional
/// and defaults to `none`. Returns `nil` if any flag is missing or malformed — caller exits with usage.
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
    if count > 0 {
        let status = ids.withUnsafeMutableBufferPointer { buf -> OSStatus in
            guard let base = buf.baseAddress else { return kAudioHardwareUnspecifiedError }
            return AudioObjectGetPropertyData(
                AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &dataSize, base)
        }
        guard status == noErr else {
            throw NSError(
                domain: "AudioCapture", code: Int(status),
                userInfo: [NSLocalizedDescriptionKey: "device list query failed"])
        }
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


/// audio-capture-cli <command> [args]. Commands: --list-mics (enumerate input devices, JSON stdout);
/// --record --source <all|mic-only[:uid]> --mic <none|default|<uid>> (stream framed PCM to stdout).
@main
struct AudioCaptureCLI {
    static func main() {
        let args = CommandLine.arguments
        guard args.count >= 2 else {
            exitWithError(
                "Usage: audio-capture-cli --list-mics | --record --source <all|mic-only[:uid]> --mic <none|default|<uid>>"
            )
        }

        guard #available(macOS 14.4, *) else {
            exitWithError(
                "audio-capture-cli requires macOS 14.4 or newer (CoreAudio process taps)")
        }

        switch args[1] {
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
                    "Bad --record flags. Need --source <all|mic-only[:uid]> --mic <none|default|<uid>>"
                )
            }
            runRecord(opts)

        default:
            exitWithError("Unknown command: \(args[1]). Use --list-mics or --record.")
        }
    }
}


/// Owns the active capture session (process tap, aggregate device, IOProc id, optional AVAudioEngine
/// for the mic). Held in a global so the signal handler can tear it down on SIGTERM/SIGINT.
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
    /// Pending mic restart: the debounce of a burst of config changes, or the retry after a failed start.
    var micRestartWork: DispatchWorkItem?
    /// Mic starts that failed since the mic last started; sets the next retry's delay.
    var micRestartFailures = 0
    /// When the running mic engine started; logged as its lifetime when the next restart stops it.
    var micEngineStartedAt: Date?
    /// Monotonic nanoseconds reference for `offset_ns`.
    let startMachAbs: UInt64 = mach_absolute_time()

    /// Coalesces burst config-change notifications and pending retries into one restart.
    func scheduleMicRestart(after delay: TimeInterval = micRestartDebounce, _ body: @escaping () -> Void) {
        micRestartWork?.cancel()
        let work = DispatchWorkItem(block: body)
        micRestartWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

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
    var tailOffset: UInt64 = 0
    if #available(macOS 14.4, *) {
        tailOffset = activeSession?.offsetNs() ?? 0
        activeSession?.teardown()
    }
    WriterQueue.shared.flush(offsetNs: tailOffset)
    fflush(stdout)
    _exit(0)
}

@available(macOS 14.4, *)
func runRecord(_ opts: RecordOptions) {
    let session = RecordSession()
    activeSession = session

    signal(SIGTERM, cleanupHandler)
    signal(SIGINT, cleanupHandler)

    if case .micOnly(let uid) = opts.source {
        guard requestMicrophoneAccess() else {
            logErr(
                "microphone access denied — grant it in System Settings → Privacy & Security → Microphone")
            exit(2)
        }
        let selector = micSelector(forMicOnly: uid)
        WriterQueue.shared.writeHeader(streams: ["mic"])
        do {
            try startMicEngine(session: session, selector: selector, streamIndex: 0)
        } catch {
            logErr("mic record start failed: \(error.localizedDescription)")
            session.teardown()
            exit(1)
        }
        installMicRestartTriggers(session: session, selector: selector, streamIndex: 0)
        RunLoop.main.run()
        return
    }

    guard preflightSystemAudioConsent() else {
        logErr(
            "system audio recording permission denied — grant it in System Settings → Privacy & Security → System Audio Recording Only")
        exit(2)
    }

    let micGranted: Bool
    if case .none = opts.mic {
        micGranted = false
    } else {
        micGranted = requestMicrophoneAccess()
        if !micGranted { logErr("microphone access denied — recording system audio only") }
    }
    WriterQueue.shared.writeHeader(streams: micGranted ? ["app", "mic"] : ["app"])

    do {
        try startSystemTap(session: session, source: opts.source)
    } catch {
        logErr("record start failed: \(error.localizedDescription)")
        session.teardown()
        exit(1)
    }
    if micGranted {
        startMicOrRetry(session: session, selector: opts.mic, streamIndex: 1)
        installMicRestartTriggers(session: session, selector: opts.mic, streamIndex: 1)
    }

    RunLoop.main.run()
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
        description.isExclusive = true  
    case .micOnly:
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

/// Reads the input-scope stream format (`AudioStreamBasicDescription`) of a device. Falls back to a
/// 48 kHz stereo float layout only if the query fails (shouldn't for an aggregate device we just created).
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

/// Requests "System Audio Recording" (TCC `kTCCServiceAudioCapture`) consent via the private
/// `TCCAccessRequest` API — no public trigger exists (ADR-056 decision 3). `dlopen`/`dlsym`-guarded: a missing symbol returns `false` (never crashes). Blocks; returns `true` if granted.
func preflightSystemAudioConsent() -> Bool {
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

/// Requests microphone consent via the public `AVCaptureDevice` API — shows the macOS consent prompt
/// (`NSMicrophoneUsageDescription`), unlike CoreAudio process taps. Blocks; returns `true` if granted.
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

/// Spins up an AVAudioEngine on the default microphone and tees its frames into stream `streamIndex`.
/// The tap goes through `SPWSafeTap`, so AVFoundation's format-mismatch exception is a thrown error.
@available(macOS 14.4, *)
func startMicEngine(session: RecordSession, selector: MicSelector, streamIndex: UInt32) throws {
    let engine = AVAudioEngine()
    let inputNode = engine.inputNode

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
    let device = describeDevice(inputNode.auAudioUnit.deviceID)
    let format = inputNode.outputFormat(forBus: 0)
    let hardwareFormat = inputNode.inputFormat(forBus: 0)
    if let problem = micFormatProblem(
        sampleRate: format.sampleRate, channels: format.channelCount,
        hardwareSampleRate: hardwareFormat.sampleRate)
    {
        throw MicStartError("\(device): \(problem)")
    }

    let tap: AVAudioNodeTapBlock = { buf, _ in
        let frames = Int(buf.frameLength)
        let channels = Int(buf.format.channelCount)
        guard frames > 0, let chan = buf.floatChannelData else { return }
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
    do {
        try SPWSafeTap.install(on: inputNode, bus: 0, bufferSize: 4096, format: format, block: tap)
    } catch {
        throw MicStartError("\(device): \(error.localizedDescription)")
    }

    engine.prepare()
    do {
        try engine.start()
    } catch {
        stopCapture(on: engine)
        throw MicStartError("\(device): \(error.localizedDescription)")
    }
    logErr(
        "microphone capture started on \(device): tap \(describeFormat(format)), hardware \(describeFormat(hardwareFormat))"
    )
    session.micEngine = engine
    session.micEngineStartedAt = Date()
}

/// `Name (UID)` of an audio device for the log, or what is known of it.
@available(macOS 14.4, *)
func describeDevice(_ device: AudioObjectID) -> String {
    let uid = deviceStringProperty(device, kAudioDevicePropertyDeviceUID) ?? "unknown UID"
    let name = deviceStringProperty(device, kAudioObjectPropertyName) ?? "unknown device"
    return "\(name) (\(uid))"
}

/// `48000 Hz 2 ch` for the log.
func describeFormat(_ format: AVAudioFormat) -> String {
    "\(Int(format.sampleRate)) Hz \(format.channelCount) ch"
}

/// The log line of a restart: its trigger and how long the engine it stops has run.
func describeMicRestart(trigger: MicRestartTrigger, engineStartedAt: Date?, now: Date = Date()) -> String {
    guard let startedAt = engineStartedAt else {
        return "restarting the microphone capture on \(trigger); no engine was running"
    }
    let lifetime = String(format: "%.1f", now.timeIntervalSince(startedAt))
    return "restarting the microphone capture on \(trigger); the engine ran \(lifetime) s"
}

/// Why the input node's format cannot carry a tap, or `nil` when it can. AVFoundation raises an
/// exception when the tap's sample rate differs from the hardware's or the format is empty.
func micFormatProblem(
    sampleRate: Double, channels: AVAudioChannelCount, hardwareSampleRate: Double
) -> String? {
    if channels == 0 || sampleRate <= 0 {
        return "the input reports no usable format (\(channels) ch, \(Int(sampleRate)) Hz)"
    }
    if sampleRate != hardwareSampleRate {
        return "the input format changed while starting (tap \(Int(sampleRate)) Hz, hardware \(Int(hardwareSampleRate)) Hz)"
    }
    return nil
}

/// Removes the tap and stops the engine.
@available(macOS 14.4, *)
func stopCapture(on engine: AVAudioEngine) {
    engine.inputNode.removeTap(onBus: 0)
    engine.stop()
}

/// A real configuration change stops the engine (AVAudioEngine contract); binding
/// a named device posts a spurious startup notification with the engine still running.
@available(macOS 14.4, *)
func micRestartNeeded(_ engine: AVAudioEngine?) -> Bool {
    !(engine?.isRunning ?? false)
}

/// Restarts on a configuration change of the engine the session runs. A notification from an engine
/// that failed to start or was replaced must not cut a pending retry short.
@available(macOS 14.4, *)
func onMicEngineConfigurationChange(
    _ notificationObject: Any?, session: RecordSession, restart: (MicRestartTrigger) -> Void
) {
    if (notificationObject as? AVAudioEngine) === session.micEngine {
        restart(.engineConfigurationChange)
    }
}

/// Restarts on a change of the default input device or the device list while the mic is down.
@available(macOS 14.4, *)
func onInputDeviceChange(
    _ trigger: MicRestartTrigger, session: RecordSession, restart: (MicRestartTrigger) -> Void
) {
    if micRestartNeeded(session.micEngine) { restart(trigger) }
}

/// Delay before the next try after `failures` failed mic starts in a row: `micRetryBaseDelay`,
/// doubled per further failure, at most `micRetryMaxDelay`.
func micRetryDelay(afterFailures failures: Int) -> TimeInterval {
    min(micRetryMaxDelay, micRetryBaseDelay * pow(2, Double(max(0, failures - 1))))
}

/// Restarts the mic engine after the audio configuration or the input devices changed.
@available(macOS 14.4, *)
func restartMicEngine(
    session: RecordSession, selector: MicSelector, streamIndex: UInt32,
    trigger: MicRestartTrigger,
    start: @escaping (RecordSession, MicSelector, UInt32) throws -> Void = startMicEngine,
    schedule: MicRestartScheduler? = nil
) {
    guard activeSession === session else { return }
    guard micRestartNeeded(session.micEngine) else {
        logErr("\(trigger) ignored - the microphone engine is still running")
        return
    }
    logErr(describeMicRestart(trigger: trigger, engineStartedAt: session.micEngineStartedAt))
    if let engine = session.micEngine {
        stopCapture(on: engine)
        session.micEngine = nil
        session.micEngineStartedAt = nil
    }
    startMicOrRetry(
        session: session, selector: selector, streamIndex: streamIndex, start: start, schedule: schedule)
}

/// Starts the mic; a failure leaves the other stream recording and schedules `restartMicEngine` after
/// `micRetryDelay`, which an input device change cuts short.
@available(macOS 14.4, *)
func startMicOrRetry(
    session: RecordSession, selector: MicSelector, streamIndex: UInt32,
    start: @escaping (RecordSession, MicSelector, UInt32) throws -> Void = startMicEngine,
    schedule: MicRestartScheduler? = nil
) {
    do {
        try start(session, selector, streamIndex)
        session.micRestartFailures = 0
    } catch {
        session.micRestartFailures += 1
        let delay = micRetryDelay(afterFailures: session.micRestartFailures)
        logErr(
            "mic start failed: \(error.localizedDescription) - retrying in \(Int(delay)) s or on the next input device change")
        let retry = {
            restartMicEngine(
                session: session, selector: selector, streamIndex: streamIndex,
                trigger: .retryAfterFailedStart, start: start, schedule: schedule)
        }
        if let schedule {
            schedule(delay, retry)
        } else {
            session.scheduleMicRestart(after: delay, retry)
        }
    }
}

/// Debounced mic restart on configuration changes of the session's engine and on changes of the
/// default input device or the device list. The CoreAudio listeners fire with no engine at all, so a mic
/// that failed to restart comes back on the next device change. Process-lifetime: the CLI records one
/// session and exits.
@available(macOS 14.4, *)
func installMicRestartTriggers(
    session: RecordSession, selector: MicSelector, streamIndex: UInt32
) {
    let scheduleRestart = { (trigger: MicRestartTrigger) in
        session.scheduleMicRestart {
            restartMicEngine(
                session: session, selector: selector, streamIndex: streamIndex, trigger: trigger)
        }
    }
    _ = NotificationCenter.default.addObserver(
        forName: .AVAudioEngineConfigurationChange, object: nil, queue: .main
    ) { note in
        onMicEngineConfigurationChange(note.object, session: session, restart: scheduleRestart)
    }
    let listeners: [(AudioObjectPropertySelector, MicRestartTrigger)] = [
        (kAudioHardwarePropertyDefaultInputDevice, .defaultInputDeviceChange),
        (kAudioHardwarePropertyDevices, .inputDeviceListChange),
    ]
    for (property, trigger) in listeners {
        var addr = AudioObjectPropertyAddress(
            mSelector: property,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        let status = AudioObjectAddPropertyListenerBlock(
            AudioObjectID(kAudioObjectSystemObject), &addr, DispatchQueue.main
        ) { _, _ in
            if case .defaultInputDeviceChange = trigger {
                logErr("default input device is now \(describeDevice(defaultInputDevice()))")
            }
            onInputDeviceChange(trigger, session: session, restart: scheduleRestart)
        }
        if status != noErr {
            logErr("input device listener could not be installed (OSStatus \(status))")
        }
    }
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
    guard count > 0 else { return nil }
    var ids = [AudioObjectID](repeating: 0, count: count)
    let status = ids.withUnsafeMutableBufferPointer { buf -> OSStatus in
        guard let base = buf.baseAddress else { return kAudioHardwareUnspecifiedError }
        return AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, base)
    }
    guard status == noErr else { return nil }
    return ids.first { deviceHasInput($0) && deviceStringProperty($0, kAudioDevicePropertyDeviceUID) == uid }
}
