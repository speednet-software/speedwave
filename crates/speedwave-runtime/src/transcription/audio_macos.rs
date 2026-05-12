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
    CaptureError, ProcessSelector, CHUNK_DURATION,
};
use super::mix::{MixBuffer, MixSource};

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
        // The CLI enforces macOS 14.4; on macOS the safe assumption is "process
        // taps available" — the CLI returns a clean error on older systems and
        // `start()` surfaces it. Microphone uses the public AVCaptureDevice API
        // (the OS prompt fires); system audio uses the private TCC API to
        // request the "System Audio Recording" permission (ADR-056 decision 3) —
        // also a prompt. A mixed capture triggers both prompts the first time.
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
            label: "Whole meeting (system audio + your microphone)".to_string(),
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
        // Drain stderr in the background so a noisy CLI can't deadlock on a
        // full pipe. We log nothing here — diagnostics live in the CLI itself;
        // a real failure shows up as the stream ending.
        if let Some(stderr) = child.stderr.take() {
            std::thread::spawn(move || {
                let reader = BufReader::new(stderr);
                for line in reader.lines().map_while(Result::ok) {
                    log::debug!(target: "transcription::capture", "{CLI_NAME}: {line}");
                }
            });
        }

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
        if header.sample_rate != 16_000 || header.channels != 1 || header.format != "f32le" {
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
        let stream = if header.streams.len() > 1 {
            CliAudioStream::Mixed {
                raw,
                mix: MixBuffer::new(true),
            }
        } else {
            CliAudioStream::Passthrough(raw)
        };
        Ok(Box::new(stream))
    }
}

/// Reads the CLI child's framed stdout: a JSON header (already consumed by
/// `start()`), then `<u32 stream> <u32 nframes> <u64 offset_ns> <f32 * nframes>`
/// chunks. Owns the child so it can SIGKILL it on drop.
struct CliRawReader {
    child: Child,
    reader: BufReader<std::process::ChildStdout>,
    done: bool,
}

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
    /// = clean EOF on a frame boundary. On a desync (implausible length) the CLI
    /// is killed and an error returned.
    fn read_frame(&mut self) -> Result<Option<(u32, u64, Vec<f32>)>, CaptureError> {
        let mut hdr = [0u8; 16];
        if !self.read_exact_or_eof(&mut hdr)? {
            return Ok(None);
        }
        let stream_index = u32::from_le_bytes([hdr[0], hdr[1], hdr[2], hdr[3]]);
        let nframes = u32::from_le_bytes([hdr[4], hdr[5], hdr[6], hdr[7]]) as usize;
        let offset_ns = u64::from_le_bytes([
            hdr[8], hdr[9], hdr[10], hdr[11], hdr[12], hdr[13], hdr[14], hdr[15],
        ]);
        if nframes > 16_000 * 5 {
            self.done = true;
            let _ = self.child.kill();
            return Err(CaptureError::Failed(format!(
                "implausible chunk size {nframes} frames — capture stream desynced"
            )));
        }
        let mut raw = vec![0u8; nframes * 4];
        if !self.read_exact_or_eof(&mut raw)? {
            self.done = true;
            return Err(CaptureError::Failed(
                "capture stream ended mid-chunk payload".to_string(),
            ));
        }
        let mut samples = Vec::with_capacity(nframes);
        for f in raw.chunks_exact(4) {
            samples.push(f32::from_le_bytes([f[0], f[1], f[2], f[3]]));
        }
        Ok(Some((stream_index, offset_ns, samples)))
    }
}

impl Drop for CliRawReader {
    fn drop(&mut self) {
        // Best-effort: SIGKILL the CLI if it's still running. The CLI's own
        // SIGTERM handler does the graceful CoreAudio teardown; kill() sends
        // SIGKILL, so we first try a polite kill via `try_wait`.
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

/// `AudioStream` over the CLI's framed stdout. Either passes stream 0 straight
/// through, or — when the CLI emits both a system and a mic stream — sums them
/// into one mono stream via a `MixBuffer` (ADR-056 decision 15).
enum CliAudioStream {
    /// Single-stream capture: forward stream 0; ignore anything else.
    Passthrough(CliRawReader),
    /// Mixed capture: `raw` feeds frames (stream 0 = system, 1 = mic) into `mix`.
    Mixed { raw: CliRawReader, mix: MixBuffer },
}

impl AudioStream for CliAudioStream {
    fn next_chunk(&mut self) -> Result<Option<AudioChunk>, CaptureError> {
        match self {
            CliAudioStream::Passthrough(raw) => {
                if raw.done {
                    return Ok(None);
                }
                loop {
                    match raw.read_frame()? {
                        None => {
                            raw.done = true;
                            let _ = raw.child.wait();
                            return Ok(None);
                        }
                        Some((0, offset_ns, samples)) => {
                            return Ok(Some(AudioChunk {
                                samples,
                                offset: Duration::from_nanos(offset_ns),
                            }));
                        }
                        Some(_) => continue, // defensive: a single-stream run only emits 0
                    }
                }
            }
            CliAudioStream::Mixed { raw, mix } => {
                if raw.done {
                    return Ok(None);
                }
                // Roughly one CHUNK_DURATION of samples per emitted chunk.
                let want = ((16_000u128 * CHUNK_DURATION.as_millis() / 1000) as usize).max(1);
                loop {
                    let start_ns = mix.offset_ns();
                    if let Some(samples) = mix.pop(1, want) {
                        return Ok(Some(AudioChunk {
                            samples,
                            offset: Duration::from_nanos(start_ns),
                        }));
                    }
                    match raw.read_frame()? {
                        None => {
                            let start_ns = mix.offset_ns();
                            mix.finish();
                            if let Some(samples) = mix.pop(1, usize::MAX) {
                                return Ok(Some(AudioChunk {
                                    samples,
                                    offset: Duration::from_nanos(start_ns),
                                }));
                            }
                            raw.done = true;
                            let _ = raw.child.wait();
                            return Ok(None);
                        }
                        Some((idx, off, samples)) => {
                            let src = if idx == 0 {
                                MixSource::System
                            } else {
                                MixSource::Mic
                            };
                            mix.push(src, off, &samples);
                        }
                    }
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
}
