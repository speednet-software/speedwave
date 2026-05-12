//! macOS audio capture: spawns the bundled `audio-capture-cli` (CoreAudio
//! process taps, macOS 14.4+) and parses its framed stdout protocol. The CLI
//! ships its own embedded Info.plist so TCC sees `NSAudioCaptureUsageDescription`
//! / `NSMicrophoneUsageDescription` when we spawn it (ADR-056, ADR-049 lesson).
//!
//! Protocol (frozen — must match `native/macos/audio-capture/Sources/AudioCaptureCLI.swift`):
//!   one UTF-8 JSON header line, then length-prefixed chunks:
//!   `<u32_le stream> <u32_le nframes> <u64_le offset_ns> <f32_le * nframes>`
//!   stream 0 = system/app, stream 1 = microphone. Logs go to the CLI's stderr.

use std::io::{BufRead, BufReader, Read};
use std::process::{Child, Stdio};
use std::time::Duration;

use serde::Deserialize;

use super::audio::{
    AudioCapture, AudioChunk, AudioSource, AudioSourceInfo, AudioStream, CaptureCapabilities,
    CaptureError, ProcessSelector,
};
use super::mix::{MixBuffer, MixSource, CHUNK_SAMPLES};

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

/// One entry from `audio-capture-cli --list`. `object_id` is part of the CLI's
/// JSON contract but the Rust side keys on `pid` only — kept as `_object_id`
/// so serde still accepts the field without a dead-code warning.
#[derive(Debug, Deserialize)]
struct ProcessListEntry {
    pid: i32,
    bundle_id: String,
    #[serde(rename = "object_id")]
    _object_id: i64,
}

/// Header line emitted once at the start of a `--record` stream. `streams` tells
/// us whether the CLI is emitting a mic stream alongside the system one (so we
/// know to mix); `started_at_ns` is informational (offsets are relative) — kept
/// underscored so serde accepts it.
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
            supports_per_process: true,
            supports_system_audio: true,
            supports_microphone: true,
            note: Some(
                "Requires macOS 14.4+. macOS will ask for Microphone and System Audio Recording permission the first time you record."
                    .to_string(),
            ),
        }
    }

    fn enumerate_sources(&self) -> Result<Vec<AudioSourceInfo>, CaptureError> {
        let output = super::super::binary::command(CLI_NAME)
            .arg("--list")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .map_err(|e| CaptureError::Failed(format!("spawn {CLI_NAME} --list: {e}")))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            // The CLI prints "requires macOS 14.4" on old systems.
            if stderr.contains("14.4") {
                return Err(CaptureError::Unsupported(stderr.trim().to_string()));
            }
            return Err(CaptureError::Failed(format!(
                "{CLI_NAME} --list exited {:?}: {}",
                output.status.code(),
                stderr.trim()
            )));
        }

        let entries: Vec<ProcessListEntry> = serde_json::from_slice(&output.stdout)
            .map_err(|e| CaptureError::Failed(format!("parse --list JSON: {e}")))?;

        let mut sources = Vec::with_capacity(entries.len() + 3);
        // "Whole meeting" (system + mic, the product default) first, then the
        // system-only and mic-only options.
        sources.push(AudioSourceInfo {
            source: AudioSource::Mixed {
                system: Box::new(AudioSource::SystemWide),
                mic: None,
            },
            label: super::audio::DEFAULT_MIXED_SOURCE_LABEL.to_string(),
            app_id: None,
        });
        sources.push(AudioSourceInfo {
            source: AudioSource::SystemWide,
            label: "System (everything)".to_string(),
            app_id: None,
        });
        sources.push(AudioSourceInfo {
            source: AudioSource::Microphone { device: None },
            label: "Microphone (default input)".to_string(),
            app_id: None,
        });
        for e in entries {
            // Skip our own helpers and the obvious system daemons that have no
            // bundle id — they're noise in the picker.
            if e.bundle_id.is_empty() {
                continue;
            }
            let label = friendly_app_label(&e.bundle_id);
            sources.push(AudioSourceInfo {
                source: AudioSource::Process {
                    selector: ProcessSelector::Pid { pid: e.pid },
                },
                label,
                app_id: Some(e.bundle_id),
            });
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
        super::audio::drain_child_stderr(&mut child, CLI_NAME);

        let mut reader = BufReader::new(stdout);
        // First: the JSON header line.
        let mut header_line = String::new();
        let n = reader
            .read_line(&mut header_line)
            .map_err(|e| CaptureError::Failed(format!("read capture header: {e}")))?;
        if n == 0 {
            // CLI exited before emitting anything — usually permission denial
            // or old OS. Reap it to read the exit code, then classify.
            let _ = child.wait();
            return Err(CaptureError::PermissionDenied(
                "capture CLI produced no output (check Privacy & Security → Microphone / Audio Recording)".to_string(),
            ));
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
        let raw = CliRawReader {
            child,
            reader,
            done: false,
        };
        // `["app","mic"]` → the CLI is emitting two streams to be summed; any
        // single-stream layout (`["app"]`, `["mic"]`) is passed through as-is.
        if header.streams.len() > 1 {
            Ok(Box::new(MixedCliStream {
                raw,
                mix: MixBuffer::new(),
            }))
        } else {
            Ok(Box::new(PassthroughCliStream { raw }))
        }
    }
}

/// Reads the CLI child's framed stdout: a JSON header (already consumed by
/// `start()`), then `<u32 stream> <u32 nframes> <u64 offset_ns> <f32 * nframes>`
/// chunks. Owns the child; on drop it's killed (graceful via `try_wait` first,
/// then SIGKILL if still running).
struct CliRawReader {
    child: Child,
    reader: BufReader<std::process::ChildStdout>,
    done: bool,
}

/// A `nframes`/`offset_ns` past this is a desynced or corrupt stream — kill the
/// CLI rather than try to allocate gigabytes (`nframes`) or buffer hours of
/// silence (`offset_ns` → see `MixBuffer`'s own cap). 5 s of 16 kHz audio is a
/// generous upper bound on a single chunk; 24 h is a generous session length.
const MAX_FRAME_SAMPLES: usize = super::audio::SAMPLE_RATE_HZ as usize * 5;
const MAX_SESSION_NS: u64 = 24 * 3600 * 1_000_000_000;

impl CliRawReader {
    /// Reads exactly `buf.len()` bytes or returns `Ok(false)` on clean EOF.
    fn read_exact_or_eof(&mut self, buf: &mut [u8]) -> Result<bool, CaptureError> {
        let mut filled = 0;
        while filled < buf.len() {
            let n = self
                .reader
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

    /// Reads one framed chunk: `(stream_index, offset_ns, samples)`. `Ok(None)`
    /// = clean EOF on a frame boundary. Any error (desync, truncation, I/O)
    /// marks the reader `done` so a retry doesn't read a half-frame.
    fn read_frame(&mut self) -> Result<Option<(u32, u64, Vec<f32>)>, CaptureError> {
        let r = self.read_frame_inner();
        if r.is_err() {
            self.done = true;
            let _ = self.child.kill();
        }
        r
    }

    fn read_frame_inner(&mut self) -> Result<Option<(u32, u64, Vec<f32>)>, CaptureError> {
        let mut hdr = [0u8; 16];
        if !self.read_exact_or_eof(&mut hdr)? {
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
        if !self.read_exact_or_eof(&mut raw)? {
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
}

impl AudioStream for PassthroughCliStream {
    fn next_chunk(&mut self) -> Result<Option<AudioChunk>, CaptureError> {
        if self.raw.done {
            return Ok(None);
        }
        loop {
            match self.raw.read_frame()? {
                None => {
                    self.raw.done = true;
                    let _ = self.raw.child.wait();
                    return Ok(None);
                }
                Some((0, offset_ns, samples)) => {
                    return Ok(Some(AudioChunk {
                        samples,
                        offset: Duration::from_nanos(offset_ns),
                    }));
                }
                Some(_) => continue,
            }
        }
    }
}

/// `AudioStream` for a mixed CLI run: `raw` feeds frames (stream 0 = system,
/// 1 = mic) into `mix`, which sums them into one mono stream (ADR-056 dec. 15).
struct MixedCliStream {
    raw: CliRawReader,
    mix: MixBuffer,
}

impl AudioStream for MixedCliStream {
    fn next_chunk(&mut self) -> Result<Option<AudioChunk>, CaptureError> {
        if self.raw.done {
            return Ok(None);
        }
        let want = CHUNK_SAMPLES;
        loop {
            let start_ns = self.mix.offset_ns();
            if let Some(samples) = self.mix.pop(1, want) {
                return Ok(Some(AudioChunk {
                    samples,
                    offset: Duration::from_nanos(start_ns),
                }));
            }
            match self.raw.read_frame()? {
                None => {
                    let start_ns = self.mix.offset_ns();
                    self.mix.finish();
                    if let Some(samples) = self.mix.pop(1, usize::MAX) {
                        return Ok(Some(AudioChunk {
                            samples,
                            offset: Duration::from_nanos(start_ns),
                        }));
                    }
                    self.raw.done = true;
                    let _ = self.raw.child.wait();
                    return Ok(None);
                }
                Some((idx, off, samples)) => {
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

/// Maps an `AudioSource` to the CLI's `--source` / `--mic` argument strings.
/// `Microphone` → `mic-only` (the CLI uses the public AVCaptureDevice consent
/// API and emits the mic on stream 0). `SystemWide`/`Process` tap the system
/// with `--mic none`. `Mixed { system, mic }` taps `system` and adds `--mic`,
/// so the CLI emits stream 0 (system) + stream 1 (mic); `CliAudioStream` sums
/// them. The inner `system` must itself be `SystemWide`/`Process` (not a nested
/// `Mixed` or a `Microphone`).
fn source_to_cli_args(source: &AudioSource) -> Result<(String, String), CaptureError> {
    match source {
        AudioSource::SystemWide => Ok(("all".to_string(), "none".to_string())),
        AudioSource::Process { selector } => {
            let pid = pid_of(selector)?;
            Ok((format!("pid:{pid}"), "none".to_string()))
        }
        AudioSource::Microphone { device } => {
            let src = match device {
                Some(uid) => format!("mic-only:{uid}"),
                None => "mic-only".to_string(),
            };
            Ok((src, "none".to_string()))
        }
        AudioSource::Mixed { system, mic } => {
            let source_arg = match system.as_ref() {
                AudioSource::SystemWide => "all".to_string(),
                AudioSource::Process { selector } => format!("pid:{}", pid_of(selector)?),
                other => {
                    return Err(CaptureError::Unsupported(format!(
                        "mixed capture's system source must be System or a process, got {other:?}"
                    )))
                }
            };
            let mic_arg = match mic {
                Some(uid) => uid.clone(),
                None => "default".to_string(),
            };
            Ok((source_arg, mic_arg))
        }
    }
}

/// Extracts a PID from a `ProcessSelector`, rejecting Linux-style node ids.
fn pid_of(selector: &ProcessSelector) -> Result<i32, CaptureError> {
    match selector {
        ProcessSelector::Pid { pid } => Ok(*pid),
        ProcessSelector::NodeId { id } => Err(CaptureError::Unsupported(format!(
            "macOS capture needs a PID, got node id {id:?}"
        ))),
    }
}

/// Turns a reverse-DNS bundle id into a friendlier label for the source picker
/// (`com.microsoft.teams2` → `teams2`). Best-effort — the raw id is kept as
/// `app_id` regardless.
fn friendly_app_label(bundle_id: &str) -> String {
    bundle_id
        .rsplit('.')
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or(bundle_id)
        .to_string()
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn capabilities_advertise_per_process_and_microphone_on_macos() {
        let caps = MacOsAudioCapture::new().capabilities();
        assert!(caps.supports_per_process);
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
    fn process_maps_to_pid_arg() {
        let src = AudioSource::Process {
            selector: ProcessSelector::Pid { pid: 4242 },
        };
        let (s, m) = source_to_cli_args(&src).unwrap();
        assert_eq!(s, "pid:4242");
        assert_eq!(m, "none");
    }

    #[test]
    fn mixed_system_plus_mic_maps_to_source_and_mic_args() {
        // SystemWide + default mic → ("all", "default").
        let (s, m) = source_to_cli_args(&AudioSource::Mixed {
            system: Box::new(AudioSource::SystemWide),
            mic: None,
        })
        .unwrap();
        assert_eq!(s, "all");
        assert_eq!(m, "default");
        // A process + a named mic → ("pid:N", "<uid>").
        let (s2, m2) = source_to_cli_args(&AudioSource::Mixed {
            system: Box::new(AudioSource::Process {
                selector: ProcessSelector::Pid { pid: 99 },
            }),
            mic: Some("BuiltInMic".to_string()),
        })
        .unwrap();
        assert_eq!(s2, "pid:99");
        assert_eq!(m2, "BuiltInMic");
    }

    #[test]
    fn mixed_with_a_nonsensical_system_source_is_rejected() {
        // Inner system can't be a microphone or another Mixed.
        let mic_as_system = AudioSource::Mixed {
            system: Box::new(AudioSource::Microphone { device: None }),
            mic: None,
        };
        assert!(matches!(
            source_to_cli_args(&mic_as_system).unwrap_err(),
            CaptureError::Unsupported(_)
        ));
        let nested = AudioSource::Mixed {
            system: Box::new(AudioSource::Mixed {
                system: Box::new(AudioSource::SystemWide),
                mic: None,
            }),
            mic: None,
        };
        assert!(matches!(
            source_to_cli_args(&nested).unwrap_err(),
            CaptureError::Unsupported(_)
        ));
        // A node-id inside Mixed → still rejected (macOS needs a PID).
        let node = AudioSource::Mixed {
            system: Box::new(AudioSource::Process {
                selector: ProcessSelector::NodeId {
                    id: "7".to_string(),
                },
            }),
            mic: None,
        };
        assert!(matches!(
            source_to_cli_args(&node).unwrap_err(),
            CaptureError::Unsupported(_)
        ));
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
    fn node_id_selector_is_rejected_on_macos() {
        let src = AudioSource::Process {
            selector: ProcessSelector::NodeId {
                id: "42".to_string(),
            },
        };
        let err = source_to_cli_args(&src).unwrap_err();
        assert!(matches!(err, CaptureError::Unsupported(_)));
    }

    #[test]
    fn friendly_label_strips_reverse_dns() {
        assert_eq!(friendly_app_label("com.microsoft.teams2"), "teams2");
        assert_eq!(friendly_app_label("org.mozilla.firefox"), "firefox");
        // Degenerate inputs fall back to the raw id.
        assert_eq!(friendly_app_label("noslasheshere"), "noslasheshere");
        assert_eq!(friendly_app_label("trailing."), "trailing.");
    }

    #[test]
    fn process_list_entry_parses_cli_json() {
        let json = r#"[{"pid":524,"bundle_id":"com.apple.mediaremoted","object_id":84}]"#;
        let entries: Vec<ProcessListEntry> = serde_json::from_str(json).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].pid, 524);
        assert_eq!(entries[0].bundle_id, "com.apple.mediaremoted");
        assert_eq!(entries[0]._object_id, 84);
    }

    #[test]
    fn stream_header_parses_and_signals_mixing_by_stream_count() {
        let two = r#"{"sample_rate":16000,"channels":1,"format":"f32le","streams":["app","mic"],"started_at_ns":123}"#;
        let h: StreamHeader = serde_json::from_str(two).unwrap();
        assert_eq!(h.sample_rate, 16_000);
        assert_eq!(h.channels, 1);
        assert_eq!(h.format, "f32le");
        assert_eq!(h.streams, &["app".to_string(), "mic".to_string()]);
        assert!(h.streams.len() > 1, "two streams → CliAudioStream mixes");
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

    /// Builds a `CliRawReader` whose stdout is `bytes`, by piping a tiny `cat`
    /// over a temp file (no real `audio-capture-cli` needed). The JSON header is
    /// NOT included — these tests exercise `read_frame`, which is called *after*
    /// `start()` has consumed the header.
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
        CliRawReader {
            child,
            reader,
            done: false,
        }
    }

    #[test]
    fn read_frame_parses_chunks_then_returns_none_at_clean_eof() {
        let mut bytes = frame(0, 0, &[1.0, 2.0]);
        bytes.extend_from_slice(&frame(1, 1_000_000, &[3.0]));
        let mut r = raw_reader_over(&bytes);
        let (idx, off, s) = r.read_frame().unwrap().unwrap();
        assert_eq!((idx, off, s), (0, 0, vec![1.0, 2.0]));
        let (idx, off, s) = r.read_frame().unwrap().unwrap();
        assert_eq!((idx, off, s), (1, 1_000_000, vec![3.0]));
        // Clean EOF on a frame boundary.
        assert!(r.read_frame().unwrap().is_none());
    }

    #[test]
    fn read_frame_rejects_an_implausible_frame() {
        // A header claiming a billion samples — well past MAX_FRAME_SAMPLES.
        let mut hdr = Vec::new();
        hdr.extend_from_slice(&0u32.to_le_bytes()); // stream
        hdr.extend_from_slice(&1_000_000_000u32.to_le_bytes()); // nframes
        hdr.extend_from_slice(&0u64.to_le_bytes()); // offset_ns
        let mut r = raw_reader_over(&hdr);
        let err = r.read_frame().unwrap_err();
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
            r2.read_frame().unwrap_err(),
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
        let err = r.read_frame().unwrap_err();
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
        };
        let c1 = stream.next_chunk().unwrap().unwrap();
        assert_eq!(c1.samples, vec![1.0, 2.0]);
        assert_eq!(c1.offset, Duration::from_nanos(100));
        let c2 = stream.next_chunk().unwrap().unwrap();
        assert_eq!(c2.samples, vec![3.0]);
        assert!(stream.next_chunk().unwrap().is_none());
        // Subsequent calls keep returning None.
        assert!(stream.next_chunk().unwrap().is_none());
    }

    #[test]
    fn mixed_stream_sums_stream_0_and_stream_1_then_drains_at_eof() {
        // Two equal-length runs at offset 0 → 0.5·sys + 0.5·mic.
        let mut bytes = frame(0, 0, &[1.0; 4]);
        bytes.extend_from_slice(&frame(1, 0, &[1.0; 4]));
        // A tail on the system side only — drained at EOF as silence-padded mic.
        bytes.extend_from_slice(&frame(0, 250_000, &[0.6; 4])); // 250µs → index 4
        let mut stream = MixedCliStream {
            raw: raw_reader_over(&bytes),
            mix: MixBuffer::new(),
        };
        // First chunk: the aligned 4 samples (both sides), summed to 1.0.
        let c1 = stream.next_chunk().unwrap().unwrap();
        assert_eq!(c1.samples.len(), 4);
        assert!(c1.samples.iter().all(|&s| (s - 1.0).abs() < 1e-5));
        assert_eq!(c1.offset, Duration::from_nanos(0));
        // Next: EOF → finish() → drains the system-only tail (0.5·0.6 = 0.3).
        let c2 = stream.next_chunk().unwrap().unwrap();
        assert_eq!(c2.samples.len(), 4);
        assert!(c2.samples.iter().all(|&s| (s - 0.3).abs() < 1e-5));
        assert!(stream.next_chunk().unwrap().is_none());
    }
}
