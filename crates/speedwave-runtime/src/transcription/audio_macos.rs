//! macOS audio capture: spawns bundled `audio-capture-cli` (CoreAudio process taps, macOS 14.4+)
//! and parses its framed stdout protocol (frozen — matches AudioCaptureCLI.swift, ADR-056/049).

use std::io::{BufRead, BufReader, Read};
use std::process::{Child, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender};
use std::time::Duration;

use serde::Deserialize;

use super::audio::{
    AudioCapture, AudioChunk, AudioSource, AudioSourceInfo, AudioStream, CaptureCapabilities,
    CaptureError,
};
use super::mix::{MixBuffer, MixSource, PairedPcm, CHUNK_SAMPLES, KEEPALIVE_AFTER, STALL_GIVE_UP};

/// Name of the bundled CLI (resolved via `binary::command`).
const CLI_NAME: &str = "audio-capture-cli";

/// macOS capture backend. Stateless — each `start()` spawns a fresh CLI child.
pub struct MacOsAudioCapture;

impl MacOsAudioCapture {
    /// Constructs the backend. Cheap; does not touch CoreAudio.
    pub fn new() -> Self {
        Self
    }
}

impl Default for MacOsAudioCapture {
    fn default() -> Self {
        Self::new()
    }
}

/// One entry from `audio-capture-cli --list-mics` — an input device's CoreAudio `uid` (the
/// selector `--mic` understands), display `name`, and whether it is the system default.
#[derive(Debug, Deserialize)]
struct MicListEntry {
    uid: String,
    name: String,
    default: bool,
}

/// Header line emitted once at the start of a `--record` stream. `streams` tells us whether the
/// CLI is emitting a mic stream alongside the system one; `started_at_ns` is informational only.
#[derive(Debug, Deserialize)]
struct StreamHeader {
    sample_rate: u32,
    channels: u32,
    format: String,
    streams: Vec<String>,
    #[serde(rename = "started_at_ns")]
    _started_at_ns: u64,
}

impl AudioCapture for MacOsAudioCapture {
    fn capabilities(&self) -> CaptureCapabilities {
        // The CLI enforces macOS 14.4 and surfaces a clean error on older
        // systems (ADR-056 decision 2/3 for the permission model).
        CaptureCapabilities {
            supports_system_audio: true,
            supports_microphone: true,
            note: Some(
                "Requires macOS 14.4+. macOS will ask for Microphone and System Audio Recording permission the first time you record."
                    .to_string(),
            ),
        }
    }

    fn enumerate_sources(&self) -> Result<Vec<AudioSourceInfo>, CaptureError> {
        // Three curated sources: "Whole meeting" (system + mic, the product
        // default), system-only, then one entry per real input device.
        let mut sources = vec![
            AudioSourceInfo {
                source: AudioSource::Mixed { mic: None },
                label: super::audio::DEFAULT_MIXED_SOURCE_LABEL.to_string(),
            },
            AudioSourceInfo {
                source: AudioSource::SystemWide,
                label: "System (everything)".to_string(),
            },
        ];
        // Named input devices (default flagged); generic fallback if it fails.
        match list_microphones() {
            Ok(mics) if !mics.is_empty() => {
                for m in mics {
                    let label = if m.default {
                        format!("Microphone: {} (default)", m.name)
                    } else {
                        format!("Microphone: {}", m.name)
                    };
                    sources.push(AudioSourceInfo {
                        source: AudioSource::Microphone {
                            device: Some(m.uid),
                        },
                        label,
                    });
                }
            }
            Ok(_) => sources.push(generic_default_mic()),
            Err(e) => {
                log::warn!(target: "transcription::capture", "mic enumeration failed, using the default mic: {e}");
                sources.push(generic_default_mic());
            }
        }
        Ok(sources)
    }

    fn start(&self, source: AudioSource) -> Result<Box<dyn AudioStream>, CaptureError> {
        let (source_arg, mic_arg) = source_to_cli_args(&source)?;
        let mut child = super::super::binary::command(CLI_NAME)
            .arg("--record")
            .arg("--source")
            .arg(&source_arg)
            .arg("--mic")
            .arg(&mic_arg)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| CaptureError::Failed(format!("spawn {CLI_NAME} --record: {e}")))?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| CaptureError::Failed("capture CLI stdout not piped".to_string()))?;
        let stderr = super::audio::drain_child_stderr(&mut child, CLI_NAME);

        let mut reader = BufReader::new(stdout);
        // First: the JSON header line.
        let mut header_line = String::new();
        let n = reader
            .read_line(&mut header_line)
            .map_err(|e| CaptureError::Failed(format!("read capture header: {e}")))?;
        if n == 0 {
            // CLI exited before emitting anything — usually permission denial
            // or old OS. Reap it to read the exit code, then classify.
            let code = child.wait().ok().and_then(|s| s.code());
            let detail = stderr.wait_snapshot(Duration::from_millis(300));
            return Err(classify_early_exit(code, &detail));
        }
        let header: StreamHeader = serde_json::from_str(header_line.trim()).map_err(|e| {
            CaptureError::Failed(format!("parse capture header {header_line:?}: {e}"))
        })?;
        if header.sample_rate != super::audio::SAMPLE_RATE_HZ
            || header.channels != 1
            || header.format != "f32le"
        {
            let _ = child.kill();
            return Err(CaptureError::Failed(format!(
                "unexpected capture format: rate={} ch={} fmt={}",
                header.sample_rate, header.channels, header.format
            )));
        }
        let raw = CliRawReader::new(child, reader)?;
        // `["app","mic"]` → the CLI is emitting two streams to be summed; any
        // single-stream layout (`["app"]`, `["mic"]`) is passed through as-is.
        if header.streams.len() > 1 {
            Ok(Box::new(MixedCliStream {
                raw,
                mix: MixBuffer::new(),
            }))
        } else {
            // Zero-detect only when the single stream is system audio ("app").
            let is_system = header.streams.first().is_some_and(|s| s == "app");
            Ok(Box::new(PassthroughCliStream {
                raw,
                zero: is_system.then(super::audio::ZeroStreakDetector::default),
                health: Vec::new(),
            }))
        }
    }
}

/// Reads the CLI child's framed stdout: a JSON header (consumed by `start()`), then `<u32 stream>
/// <u32 nframes> <u64 offset_ns> <f32*nframes>` chunks. The blocking pipe reads run on their own
/// thread so `read_frame` stays bounded (`next_chunk` must honour stop even when the CLI goes
/// silent without closing stdout). On drop, killed gracefully then SIGKILL.
struct CliRawReader {
    child: Child,
    rx: Receiver<RawEvent>,
    done: bool,
}

/// What the reader thread publishes: parsed frames, then exactly one terminal event.
enum RawEvent {
    Frame(u32, u64, Vec<f32>),
    Eof,
    Failed(CaptureError),
}

/// One bounded `read_frame` result. `Pending` = nothing arrived within [`KEEPALIVE_AFTER`].
#[derive(Debug)]
enum RawRead {
    Frame(u32, u64, Vec<f32>),
    Pending,
    Eof,
}

/// Frames in flight from the reader thread — a few seconds of audio; a full channel blocks the
/// reader (pipe backpressure), never grows unbounded.
const READER_CHANNEL_DEPTH: usize = 32;

/// A `nframes`/`offset_ns` past this is a desynced or corrupt stream — kill the CLI rather than
/// allocate gigabytes or buffer hours of silence. 5 s/16 kHz is a generous chunk; 24 h a session.
const MAX_FRAME_SAMPLES: usize = super::audio::SAMPLE_RATE_HZ as usize * 5;
const MAX_SESSION_NS: u64 = 24 * 3600 * 1_000_000_000;

impl CliRawReader {
    fn new(
        child: Child,
        reader: BufReader<std::process::ChildStdout>,
    ) -> Result<Self, CaptureError> {
        let (tx, rx) = mpsc::sync_channel(READER_CHANNEL_DEPTH);
        std::thread::Builder::new()
            .name("capture-cli-reader".to_string())
            .spawn(move || reader_thread(reader, &tx))
            .map_err(|e| CaptureError::Failed(format!("spawn capture reader thread: {e}")))?;
        Ok(Self {
            child,
            rx,
            done: false,
        })
    }

    /// Bounded read of the next parsed frame. An error kills the CLI and marks the reader
    /// `done` so a retry doesn't consume past a desynced stream.
    fn read_frame(&mut self) -> Result<RawRead, CaptureError> {
        match self.rx.recv_timeout(KEEPALIVE_AFTER) {
            Ok(RawEvent::Frame(idx, off, samples)) => Ok(RawRead::Frame(idx, off, samples)),
            Ok(RawEvent::Eof) | Err(RecvTimeoutError::Disconnected) => Ok(RawRead::Eof),
            Ok(RawEvent::Failed(e)) => {
                self.done = true;
                let _ = self.child.kill();
                Err(e)
            }
            Err(RecvTimeoutError::Timeout) => Ok(RawRead::Pending),
        }
    }
}

/// The reader-thread body: a blocking parse loop over the CLI's stdout. Exits on EOF, the first
/// parse/IO error, or the consumer dropping its receiver.
fn reader_thread(mut reader: BufReader<std::process::ChildStdout>, tx: &SyncSender<RawEvent>) {
    loop {
        match read_frame_blocking(&mut reader) {
            Ok(Some((idx, off, samples))) => {
                if tx.send(RawEvent::Frame(idx, off, samples)).is_err() {
                    return;
                }
            }
            Ok(None) => {
                let _ = tx.send(RawEvent::Eof);
                return;
            }
            Err(e) => {
                let _ = tx.send(RawEvent::Failed(e));
                return;
            }
        }
    }
}

/// Reads exactly `buf.len()` bytes or returns `Ok(false)` on clean EOF.
fn read_exact_or_eof(reader: &mut impl Read, buf: &mut [u8]) -> Result<bool, CaptureError> {
    let mut filled = 0;
    while filled < buf.len() {
        let n = reader
            .read(&mut buf[filled..])
            .map_err(|e| CaptureError::Failed(format!("read capture chunk: {e}")))?;
        if n == 0 {
            if filled == 0 {
                return Ok(false); // clean EOF on a frame boundary
            }
            return Err(CaptureError::Failed(
                "capture stream ended mid-chunk".to_string(),
            ));
        }
        filled += n;
    }
    Ok(true)
}

/// Reads one framed chunk: `(stream_index, offset_ns, samples)`. `Ok(None)` = clean EOF on a
/// frame boundary.
fn read_frame_blocking(
    reader: &mut impl Read,
) -> Result<Option<(u32, u64, Vec<f32>)>, CaptureError> {
    let mut hdr = [0u8; 16];
    if !read_exact_or_eof(reader, &mut hdr)? {
        return Ok(None);
    }
    let stream_index = u32::from_le_bytes([hdr[0], hdr[1], hdr[2], hdr[3]]);
    let nframes = u32::from_le_bytes([hdr[4], hdr[5], hdr[6], hdr[7]]) as usize;
    let offset_ns = u64::from_le_bytes([
        hdr[8], hdr[9], hdr[10], hdr[11], hdr[12], hdr[13], hdr[14], hdr[15],
    ]);
    if nframes > MAX_FRAME_SAMPLES || offset_ns > MAX_SESSION_NS {
        return Err(CaptureError::Failed(format!(
            "implausible frame (nframes={nframes}, offset_ns={offset_ns}) — capture stream desynced"
        )));
    }
    let mut raw = vec![0u8; nframes * 4];
    if !read_exact_or_eof(reader, &mut raw)? {
        return Err(CaptureError::Failed(
            "capture stream ended mid-chunk payload".to_string(),
        ));
    }
    Ok(Some((
        stream_index,
        offset_ns,
        super::audio::bytes_to_f32_samples(&raw),
    )))
}

impl Drop for CliRawReader {
    fn drop(&mut self) {
        // CLI's own SIGTERM handler does the graceful CoreAudio teardown;
        // SIGKILL only if it didn't exit on its own.
        super::audio::kill_child_gracefully(&mut self.child);
    }
}

/// `AudioStream` for a single-stream CLI run: forwards stream 0, ignores any
/// other stream index (defensive — a single-stream run only ever emits 0).
struct PassthroughCliStream {
    raw: CliRawReader,
    /// Silence detector — present only when stream 0 is system audio.
    zero: Option<super::audio::ZeroStreakDetector>,
    health: Vec<super::audio::CaptureHealth>,
}

impl AudioStream for PassthroughCliStream {
    fn next_chunk(&mut self) -> Result<Option<AudioChunk>, CaptureError> {
        if self.raw.done {
            return Ok(None);
        }
        loop {
            match self.raw.read_frame()? {
                // Alive but silent — keepalive keeps the ingest loop's stop check responsive.
                RawRead::Pending => return Ok(Some(AudioChunk::keepalive())),
                RawRead::Eof => {
                    self.raw.done = true;
                    let _ = self.raw.child.wait();
                    return Ok(None);
                }
                RawRead::Frame(0, offset_ns, samples) => {
                    if let Some(t) = self.zero.as_mut().and_then(|z| z.feed(&samples)) {
                        self.health.push(t);
                    }
                    return Ok(Some(AudioChunk {
                        samples,
                        mic: None,
                        offset: Duration::from_nanos(offset_ns),
                    }));
                }
                RawRead::Frame(..) => continue,
            }
        }
    }

    fn take_health(&mut self) -> Vec<super::audio::CaptureHealth> {
        std::mem::take(&mut self.health)
    }
}

/// `AudioStream` for a mixed CLI run: `raw` feeds frames (stream 0 = system,
/// 1 = mic) into `mix`, which pairs them into aligned channels (ADR-056 Am. 9).
struct MixedCliStream {
    raw: CliRawReader,
    mix: MixBuffer,
}

impl AudioStream for MixedCliStream {
    fn take_health(&mut self) -> Vec<super::audio::CaptureHealth> {
        self.mix.take_health()
    }

    fn next_chunk(&mut self) -> Result<Option<AudioChunk>, CaptureError> {
        if self.raw.done {
            return Ok(None);
        }
        let want = CHUNK_SAMPLES;
        loop {
            let start_ns = self.mix.offset_ns();
            if let Some(PairedPcm { system: sys, mic }) = self.mix.pop_pair(1, want) {
                return Ok(Some(AudioChunk {
                    samples: sys,
                    mic: Some(mic),
                    offset: Duration::from_nanos(start_ns),
                }));
            }
            match self.raw.read_frame()? {
                RawRead::Pending => {
                    // A CLI that stopped emitting without closing stdout must not leave the
                    // session in Recording forever — same give-up as the Windows mixed path.
                    if self.mix.stalled_for() >= STALL_GIVE_UP {
                        return Err(CaptureError::Failed(
                            "audio capture stalled — the capture CLI stopped emitting without a clean end-of-stream"
                                .to_string(),
                        ));
                    }
                    return Ok(Some(AudioChunk::keepalive()));
                }
                RawRead::Eof => {
                    let start_ns = self.mix.offset_ns();
                    self.mix.finish();
                    if let Some(PairedPcm { system: sys, mic }) = self.mix.pop_pair(1, usize::MAX) {
                        return Ok(Some(AudioChunk {
                            samples: sys,
                            mic: Some(mic),
                            offset: Duration::from_nanos(start_ns),
                        }));
                    }
                    self.raw.done = true;
                    let _ = self.raw.child.wait();
                    return Ok(None);
                }
                RawRead::Frame(idx, off, samples) => {
                    let src = if idx == 0 {
                        MixSource::System
                    } else {
                        MixSource::Mic
                    };
                    self.mix.push(src, off, &samples);
                }
            }
        }
    }
}

/// Maps an early CLI exit to a precise error (exit 2 = a permission denial;
/// the CLI's stderr says which permission and how to grant it).
fn classify_early_exit(code: Option<i32>, detail: &str) -> CaptureError {
    let detail = if detail.is_empty() {
        "capture CLI produced no output (check Privacy & Security → Microphone / System Audio Recording)"
    } else {
        detail
    };
    match code {
        Some(2) => CaptureError::PermissionDenied(detail.to_string()),
        _ => CaptureError::Failed(format!(
            "capture CLI exited early (code {}): {detail}",
            code.map_or("killed".to_string(), |c| c.to_string())
        )),
    }
}

/// The fallback picker entry when device enumeration yields nothing/errors.
fn generic_default_mic() -> AudioSourceInfo {
    AudioSourceInfo {
        source: AudioSource::Microphone { device: None },
        label: "Microphone (default input)".to_string(),
    }
}

/// Lists input devices via `audio-capture-cli --list-mics` (uid, name, default).
fn list_microphones() -> Result<Vec<MicListEntry>, CaptureError> {
    let output = super::super::binary::command(CLI_NAME)
        .arg("--list-mics")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| CaptureError::Failed(format!("spawn {CLI_NAME} --list-mics: {e}")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(CaptureError::Failed(format!(
            "{CLI_NAME} --list-mics exited {:?}: {}",
            output.status.code(),
            stderr.trim()
        )));
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|e| CaptureError::Failed(format!("parse --list-mics JSON: {e}")))
}

/// Maps an `AudioSource` to the CLI's `--source`/`--mic` args. `SystemWide` → `all`,
/// `Microphone` → `mic-only[:uid]`, `Mixed` → `all` + mic uid (CLI emits stream 0/1, summed).
fn source_to_cli_args(source: &AudioSource) -> Result<(String, String), CaptureError> {
    match source {
        AudioSource::SystemWide => Ok(("all".to_string(), "none".to_string())),
        AudioSource::Microphone { device } => {
            let src = match device {
                Some(uid) => format!("mic-only:{uid}"),
                None => "mic-only".to_string(),
            };
            Ok((src, "none".to_string()))
        }
        AudioSource::Mixed { mic } => {
            let mic_arg = match mic {
                Some(uid) => uid.clone(),
                None => "default".to_string(),
            };
            Ok(("all".to_string(), mic_arg))
        }
    }
}

#[cfg(test)]
#[expect(clippy::unwrap_used, reason = "test code")]
mod tests {
    use super::*;

    #[test]
    fn capabilities_advertise_system_and_microphone_on_macos() {
        let caps = MacOsAudioCapture::new().capabilities();
        assert!(caps.supports_system_audio);
        assert!(
            caps.supports_microphone,
            "mic capture works via AVCaptureDevice"
        );
        assert!(caps.note.as_deref().unwrap().contains("14.4"));
    }

    #[test]
    fn system_wide_maps_to_all_none() {
        let (s, m) = source_to_cli_args(&AudioSource::SystemWide).unwrap();
        assert_eq!(s, "all");
        assert_eq!(m, "none");
    }

    #[test]
    fn mixed_system_plus_mic_maps_to_source_and_mic_args() {
        // Mixed + default mic → ("all", "default").
        let (s, m) = source_to_cli_args(&AudioSource::Mixed { mic: None }).unwrap();
        assert_eq!(s, "all");
        assert_eq!(m, "default");
        // Mixed + a named mic → ("all", "<uid>").
        let (s2, m2) = source_to_cli_args(&AudioSource::Mixed {
            mic: Some("BuiltInMic".to_string()),
        })
        .unwrap();
        assert_eq!(s2, "all");
        assert_eq!(m2, "BuiltInMic");
    }

    #[test]
    fn list_mics_json_parses_uid_name_default() {
        let json = br#"[
            {"uid":"BuiltInMicrophoneDevice","name":"MacBook Pro Microphone","default":true},
            {"uid":"AppleUSBAudioEngine:USB MIC:1","name":"USB MIC","default":false}
        ]"#;
        let mics: Vec<MicListEntry> = serde_json::from_slice(json).unwrap();
        assert_eq!(mics.len(), 2);
        assert_eq!(mics[0].uid, "BuiltInMicrophoneDevice");
        assert_eq!(mics[0].name, "MacBook Pro Microphone");
        assert!(mics[0].default);
        assert!(!mics[1].default);
    }

    #[test]
    fn list_mics_rejects_malformed_json() {
        let mics: Result<Vec<MicListEntry>, _> = serde_json::from_slice(b"{not json}");
        assert!(mics.is_err());
    }

    #[test]
    fn microphone_maps_to_mic_only() {
        let (s, m) = source_to_cli_args(&AudioSource::Microphone { device: None }).unwrap();
        assert_eq!(s, "mic-only");
        assert_eq!(m, "none");
        let (s2, _) = source_to_cli_args(&AudioSource::Microphone {
            device: Some("BuiltInMicrophoneDevice".to_string()),
        })
        .unwrap();
        assert_eq!(s2, "mic-only:BuiltInMicrophoneDevice");
    }

    #[test]
    fn stream_header_parses_and_signals_mixing_by_stream_count() {
        let two = r#"{"sample_rate":16000,"channels":1,"format":"f32le","streams":["app","mic"],"started_at_ns":123}"#;
        let h: StreamHeader = serde_json::from_str(two).unwrap();
        assert_eq!(h.sample_rate, 16_000);
        assert_eq!(h.channels, 1);
        assert_eq!(h.format, "f32le");
        assert_eq!(h.streams, &["app".to_string(), "mic".to_string()]);
        assert!(h.streams.len() > 1, "two streams → MixedCliStream mixes");
        assert_eq!(h._started_at_ns, 123);

        let one = r#"{"sample_rate":16000,"channels":1,"format":"f32le","streams":["mic"],"started_at_ns":0}"#;
        let h1: StreamHeader = serde_json::from_str(one).unwrap();
        assert_eq!(
            h1.streams.len(),
            1,
            "single stream → passthrough, no mixing"
        );
    }

    // --- Framing / stream tests over a synthetic stdout -----------------------

    /// Frames one `(stream, nframes, offset_ns, samples)` chunk into the wire
    /// format the CLI emits.
    fn frame(stream: u32, offset_ns: u64, samples: &[f32]) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&stream.to_le_bytes());
        out.extend_from_slice(&(samples.len() as u32).to_le_bytes());
        out.extend_from_slice(&offset_ns.to_le_bytes());
        for &s in samples {
            out.extend_from_slice(&s.to_le_bytes());
        }
        out
    }

    /// Builds a `CliRawReader` whose stdout is `bytes`, via a tiny `cat` over a temp file (no real
    /// CLI needed). No JSON header — these tests exercise `read_frame`, called after `start()`.
    fn raw_reader_over(bytes: &[u8]) -> CliRawReader {
        use std::io::Write;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("frames.bin");
        std::fs::File::create(&path)
            .unwrap()
            .write_all(bytes)
            .unwrap();
        // Keep the tempdir alive for the child's lifetime by leaking it — the
        // process exits at end of test, the OS reclaims it.
        std::mem::forget(dir);
        let mut child = std::process::Command::new("cat")
            .arg(&path)
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let reader = BufReader::new(child.stdout.take().unwrap());
        CliRawReader::new(child, reader).unwrap()
    }

    /// A `CliRawReader` over a child that stays alive but never writes — the silent-CLI case.
    fn raw_reader_silent() -> CliRawReader {
        let mut child = std::process::Command::new("sleep")
            .arg("30")
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let reader = BufReader::new(child.stdout.take().unwrap());
        CliRawReader::new(child, reader).unwrap()
    }

    /// Polls `read_frame` past transient `Pending`s (the reader thread needs a moment to
    /// parse), bounded so a broken stream fails the test instead of hanging it.
    fn read_settled(r: &mut CliRawReader) -> Result<RawRead, CaptureError> {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            match r.read_frame() {
                Ok(RawRead::Pending) => {
                    assert!(std::time::Instant::now() < deadline, "no frame within 5 s");
                }
                other => return other,
            }
        }
    }

    /// Skips keepalive chunks from `next_chunk`, bounded like `read_settled`.
    fn next_real_chunk(stream: &mut dyn AudioStream) -> Result<Option<AudioChunk>, CaptureError> {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            match stream.next_chunk() {
                Ok(Some(c)) if c.samples.is_empty() => {
                    assert!(
                        std::time::Instant::now() < deadline,
                        "no real chunk within 5 s"
                    );
                }
                other => return other,
            }
        }
    }

    #[test]
    fn read_frame_parses_chunks_then_returns_none_at_clean_eof() {
        let mut bytes = frame(0, 0, &[1.0, 2.0]);
        bytes.extend_from_slice(&frame(1, 1_000_000, &[3.0]));
        let mut r = raw_reader_over(&bytes);
        let RawRead::Frame(idx, off, s) = read_settled(&mut r).unwrap() else {
            panic!("expected the first frame");
        };
        assert_eq!((idx, off, s), (0, 0, vec![1.0, 2.0]));
        let RawRead::Frame(idx, off, s) = read_settled(&mut r).unwrap() else {
            panic!("expected the second frame");
        };
        assert_eq!((idx, off, s), (1, 1_000_000, vec![3.0]));
        // Clean EOF on a frame boundary.
        assert!(matches!(read_settled(&mut r).unwrap(), RawRead::Eof));
    }

    #[test]
    fn read_frame_yields_pending_while_the_cli_is_alive_but_silent() {
        let mut r = raw_reader_silent();
        // Bounded: returns Pending after the keepalive window instead of blocking on the pipe.
        assert!(matches!(r.read_frame().unwrap(), RawRead::Pending));
    }

    #[test]
    fn read_frame_rejects_an_implausible_frame() {
        // A header claiming a billion samples — well past MAX_FRAME_SAMPLES.
        let mut hdr = Vec::new();
        hdr.extend_from_slice(&0u32.to_le_bytes()); // stream
        hdr.extend_from_slice(&1_000_000_000u32.to_le_bytes()); // nframes
        hdr.extend_from_slice(&0u64.to_le_bytes()); // offset_ns
        let mut r = raw_reader_over(&hdr);
        let err = read_settled(&mut r).unwrap_err();
        assert!(matches!(err, CaptureError::Failed(_)));
        assert!(r.done);
        // An offset past MAX_SESSION_NS (>24 h) is also rejected.
        let mut hdr2 = Vec::new();
        hdr2.extend_from_slice(&0u32.to_le_bytes());
        hdr2.extend_from_slice(&1u32.to_le_bytes());
        hdr2.extend_from_slice(&(48u64 * 3600 * 1_000_000_000).to_le_bytes());
        hdr2.extend_from_slice(&1.0f32.to_le_bytes());
        let mut r2 = raw_reader_over(&hdr2);
        assert!(matches!(
            read_settled(&mut r2).unwrap_err(),
            CaptureError::Failed(_)
        ));
    }

    #[test]
    fn read_frame_errors_on_a_truncated_payload() {
        // Header says 4 samples (16 bytes) but only 8 bytes follow.
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&0u32.to_le_bytes());
        bytes.extend_from_slice(&4u32.to_le_bytes());
        bytes.extend_from_slice(&0u64.to_le_bytes());
        bytes.extend_from_slice(&1.0f32.to_le_bytes());
        bytes.extend_from_slice(&2.0f32.to_le_bytes()); // only 2 of 4 samples
        let mut r = raw_reader_over(&bytes);
        let err = read_settled(&mut r).unwrap_err();
        assert!(matches!(err, CaptureError::Failed(_)));
        assert!(r.done);
    }

    #[test]
    fn passthrough_stream_forwards_stream_0_and_skips_others() {
        let mut bytes = frame(1, 0, &[9.9]); // a stray stream-1 frame — ignored
        bytes.extend_from_slice(&frame(0, 100, &[1.0, 2.0]));
        bytes.extend_from_slice(&frame(2, 200, &[8.8])); // stray stream-2 — ignored
        bytes.extend_from_slice(&frame(0, 300, &[3.0]));
        let mut stream = PassthroughCliStream {
            raw: raw_reader_over(&bytes),
            zero: None,
            health: Vec::new(),
        };
        let c1 = next_real_chunk(&mut stream).unwrap().unwrap();
        assert_eq!(c1.samples, vec![1.0, 2.0]);
        assert_eq!(c1.offset, Duration::from_nanos(100));
        let c2 = next_real_chunk(&mut stream).unwrap().unwrap();
        assert_eq!(c2.samples, vec![3.0]);
        assert!(next_real_chunk(&mut stream).unwrap().is_none());
        // Subsequent calls keep returning None.
        assert!(stream.next_chunk().unwrap().is_none());
    }

    #[test]
    fn passthrough_stream_keepalives_while_the_cli_is_alive_but_silent() {
        let mut stream = PassthroughCliStream {
            raw: raw_reader_silent(),
            zero: None,
            health: Vec::new(),
        };
        // Bounded next_chunk: an empty keepalive hands control back so stop stays honoured.
        let c = stream.next_chunk().unwrap().unwrap();
        assert!(c.samples.is_empty());
    }

    #[test]
    fn mixed_stream_errors_after_a_sustained_stall() {
        let mut stream = MixedCliStream {
            raw: raw_reader_silent(),
            mix: MixBuffer::new(),
        };
        // Keepalives while inside the give-up window, then a hard error — the session
        // must flip to Failed instead of sitting in Recording forever.
        let deadline = std::time::Instant::now() + STALL_GIVE_UP + Duration::from_secs(5);
        loop {
            match stream.next_chunk() {
                Ok(Some(c)) => {
                    assert!(c.samples.is_empty(), "no real audio exists in this test");
                    assert!(std::time::Instant::now() < deadline, "stall never errored");
                }
                Ok(None) => panic!("silent CLI must not look like a clean EOF"),
                Err(e) => {
                    assert!(e.to_string().contains("stalled"), "got: {e}");
                    break;
                }
            }
        }
    }

    #[test]
    fn classify_early_exit_maps_exit_2_to_permission_denied_with_the_cli_reason() {
        let e = classify_early_exit(
            Some(2),
            "system audio recording permission denied — grant it in System Settings",
        );
        assert!(matches!(e, CaptureError::PermissionDenied(_)));
        assert!(e.to_string().contains("System Settings"), "got: {e}");
    }

    #[test]
    fn classify_early_exit_falls_back_to_a_generic_hint_without_stderr() {
        let e = classify_early_exit(Some(2), "");
        assert!(matches!(e, CaptureError::PermissionDenied(_)));
        assert!(e.to_string().contains("Privacy & Security"), "got: {e}");
    }

    #[test]
    fn classify_early_exit_treats_other_codes_as_failures_with_detail() {
        let e = classify_early_exit(Some(1), "record start failed: boom");
        assert!(matches!(e, CaptureError::Failed(_)));
        assert!(e.to_string().contains("code 1") && e.to_string().contains("boom"));
        let killed = classify_early_exit(None, "");
        assert!(killed.to_string().contains("killed"), "got: {killed}");
    }

    #[test]
    fn drain_child_stderr_collects_lines_for_error_details() {
        let mut child = std::process::Command::new("sh")
            .arg("-c")
            .arg("echo 'permission denied — grant it' >&2; exit 2")
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let stderr = super::super::audio::drain_child_stderr(&mut child, "test-cli");
        let _ = child.wait();
        let detail = stderr.wait_snapshot(Duration::from_secs(2));
        assert!(detail.contains("permission denied"), "got: {detail:?}");
    }

    #[test]
    fn passthrough_system_stream_warns_after_sustained_silence() {
        // > 15 s of all-zero system audio in one frame batch (5 s frames × 4).
        let zeros = vec![0.0f32; super::super::audio::SAMPLE_RATE_HZ as usize * 5];
        let mut bytes = Vec::new();
        for i in 0..4u64 {
            bytes.extend_from_slice(&frame(0, i * 5_000_000_000, &zeros));
        }
        let mut stream = PassthroughCliStream {
            raw: raw_reader_over(&bytes),
            zero: Some(super::super::audio::ZeroStreakDetector::default()),
            health: Vec::new(),
        };
        for _ in 0..4 {
            let _ = next_real_chunk(&mut stream).unwrap().unwrap();
        }
        assert_eq!(
            stream.take_health(),
            vec![super::super::audio::CaptureHealth::Raised(
                super::super::audio::CaptureWarning::SystemAudioSilent
            )]
        );
        assert_eq!(stream.take_health(), vec![]);
    }

    #[test]
    fn mixed_stream_pairs_stream_0_and_stream_1_then_drains_at_eof() {
        // Two equal-length runs at offset 0 → an aligned (system, mic) pair.
        let mut bytes = frame(0, 0, &[1.0; 4]);
        bytes.extend_from_slice(&frame(1, 0, &[1.0; 4]));
        // A tail on the system side only — drained at EOF with a zero-padded mic.
        bytes.extend_from_slice(&frame(0, 250_000, &[0.6; 4])); // 250µs → index 4
        let mut stream = MixedCliStream {
            raw: raw_reader_over(&bytes),
            mix: MixBuffer::new(),
        };
        // First chunk: the aligned 4 samples on each channel, unmixed.
        let c1 = next_real_chunk(&mut stream).unwrap().unwrap();
        assert_eq!(c1.samples.len(), 4);
        assert!(c1.samples.iter().all(|&s| (s - 1.0).abs() < 1e-5));
        // Paired capture always carries the mic channel.
        let mic1 = c1.mic.unwrap();
        assert!(mic1.iter().all(|&s| (s - 1.0).abs() < 1e-5));
        assert_eq!(c1.offset, Duration::from_nanos(0));
        // Next: EOF → finish() → drains the system-only tail; mic pads as zeros.
        let c2 = next_real_chunk(&mut stream).unwrap().unwrap();
        assert_eq!(c2.samples.len(), 4);
        assert!(c2.samples.iter().all(|&s| (s - 0.6).abs() < 1e-5));
        let mic2 = c2.mic.unwrap(); // present even when zero-padded
        assert!(mic2.iter().all(|&s| s.abs() < 1e-6));
        assert!(next_real_chunk(&mut stream).unwrap().is_none());
    }
}
