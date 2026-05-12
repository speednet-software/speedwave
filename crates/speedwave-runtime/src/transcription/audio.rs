//! The `AudioCapture` trait and its `FileAudioCapture` test/dev implementation.
//!
//! `AudioCapture` is the seam between the OS-specific capture backends (Windows
//! WASAPI loopback, macOS CoreAudio process taps, Linux `pw-record`/`parec`) and
//! the rest of the engine — the same shape as `ContainerRuntime` →
//! `LimaRuntime`/`NerdctlRuntime`/`WslRuntime`. `FileAudioCapture` "plays back" a
//! 16 kHz mono WAV in fixed chunks so the orchestration (the transcriber, the
//! diarizer, the driver) can be exercised without a real device — and doubles as
//! the dev affordance ("transcribe a WAV file").

use std::path::{Path, PathBuf};
use std::time::Duration;

/// Sample rate every `AudioStream` delivers — Whisper's input rate. Capture
/// backends resample their device-native rate down to this.
pub const SAMPLE_RATE_HZ: u32 = 16_000;

/// Chunk granularity `FileAudioCapture` delivers (and the rough cadence the
/// real backends aim for — the macOS CLI's framed stdout protocol uses ~200 ms
/// chunks, per ADR-056). Smaller = lower live latency but more per-chunk
/// overhead; this is a reasonable default.
pub const CHUNK_DURATION: Duration = Duration::from_millis(200);

/// What to capture.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum AudioSource {
    /// All system audio output (the "everything" loopback). Always available.
    SystemWide,
    /// A specific process's audio (e.g. just Teams). Requires per-process
    /// capture support — `CaptureCapabilities::supports_per_process` (Windows
    /// build 20348+, macOS 14.4+, PipeWire on Linux).
    Process {
        /// Process selector — a PID on Windows/macOS, a node/sink-input id on
        /// Linux (the backend interprets it).
        selector: ProcessSelector,
    },
    /// A specific microphone input device (the user's own voice).
    Microphone {
        /// Device id (`None` = system default input).
        device: Option<String>,
    },
    /// Both `system` and `mic` captured together as two timestamped streams —
    /// the "meeting transcription" default (the "poor man's diarization" angle:
    /// the mic is "[You]", the loopback is "[Meeting]"). The backend mixes or
    /// keeps them separate as the engine requests.
    Mixed {
        /// What to capture for the "other side" (typically `SystemWide` or a
        /// `Process`).
        system: Box<AudioSource>,
        /// The microphone device for "your side" (`None` = default input).
        mic: Option<String>,
    },
}

/// How a process to capture is identified. Boxed inside `AudioSource::Process`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case", tag = "by")]
pub enum ProcessSelector {
    /// Operating-system process id (Windows/macOS).
    Pid {
        /// The PID.
        pid: i32,
    },
    /// An opaque backend-specific node/stream id (Linux PipeWire/PulseAudio).
    NodeId {
        /// The node id, stringified.
        id: String,
    },
}

/// A capturable source the UI can offer the user, as returned by
/// `AudioCapture::enumerate_sources()`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct AudioSourceInfo {
    /// The source to pass to `start()` if the user picks this entry.
    pub source: AudioSource,
    /// Human-readable label (e.g. `"Microsoft Teams"`, `"System (everything)"`,
    /// `"Built-in Microphone"`).
    pub label: String,
    /// Best-effort bundle/app identifier when this is a process source
    /// (e.g. `"com.microsoft.teams2"`), else `None`.
    pub app_id: Option<String>,
}

/// What a capture backend on this host can do — surfaced to the UI so it knows
/// e.g. whether to offer a process picker.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct CaptureCapabilities {
    /// `true` if the backend can capture a single process's audio (Windows
    /// build 20348+, macOS 14.4+, Linux PipeWire). When `false`, only
    /// `SystemWide` (+ `Microphone`) is offered, with a tooltip explaining
    /// the OS requirement.
    pub supports_per_process: bool,
    /// `true` if capturing the system loopback at all is possible on this host
    /// (e.g. `false` on macOS < 14.2, or Linux with no usable sound server).
    pub supports_system_audio: bool,
    /// `true` if a microphone input is available.
    pub supports_microphone: bool,
    /// Short human-readable note for the UI when something is limited
    /// (e.g. `"Per-app capture requires macOS 14.4+"`), else `None`.
    pub note: Option<String>,
}

impl CaptureCapabilities {
    /// The capabilities of `FileAudioCapture` / a dev environment: it can
    /// "capture" from a file path only; nothing real.
    pub fn file_only() -> Self {
        Self {
            supports_per_process: false,
            supports_system_audio: false,
            supports_microphone: false,
            note: Some("File input only (no live capture backend on this build/OS)".to_string()),
        }
    }
}

/// One chunk of captured PCM: 16 kHz mono `f32` samples in `[-1.0, 1.0]`, plus
/// the offset of this chunk's first sample from the start of the recording.
/// (When the source is `Mixed`, the backend has already mixed or the engine
/// requested a single mixed stream — multi-stream interleaving is a backend
/// detail; the engine only ever sees one mono stream here.)
#[derive(Debug, Clone)]
pub struct AudioChunk {
    /// 16 kHz mono samples, `[-1.0, 1.0]`.
    pub samples: Vec<f32>,
    /// Offset of `samples[0]` from the start of capture.
    pub offset: Duration,
}

/// Errors a capture backend can produce.
#[derive(Debug, thiserror::Error)]
pub enum CaptureError {
    /// The requested source isn't supported on this host (e.g. per-process on
    /// an old OS, or a missing sound server).
    #[error("audio source not supported on this host: {0}")]
    Unsupported(String),
    /// The OS denied the recording permission (or, on macOS system audio,
    /// the tap silently delivered only silence — detected by the backend).
    #[error("audio recording permission denied: {0}")]
    PermissionDenied(String),
    /// No capture device available (no input device, no audio device on a CI
    /// runner, etc.).
    #[error("no audio device available: {0}")]
    NoDevice(String),
    /// The capture child process / API failed.
    #[error("audio capture failed: {0}")]
    Failed(String),
    /// I/O error (reading a WAV file, a pipe, …).
    #[error("audio I/O error: {0}")]
    Io(#[from] std::io::Error),
}

/// A live (or file-backed) stream of `AudioChunk`s. `next_chunk()` returns
/// `Ok(None)` at end of stream (for `FileAudioCapture` that is end of file;
/// for a live backend it doesn't normally end until `stop()` — represented by
/// dropping the stream / the backend's own stop signal). Implementations are
/// `Send` so the driver can pump them from a background task.
pub trait AudioStream: Send {
    /// Block for the next chunk. `Ok(None)` = stream finished. `Err(_)` = the
    /// capture broke (the driver flips the session to `Failed`).
    fn next_chunk(&mut self) -> Result<Option<AudioChunk>, CaptureError>;
}

/// A host audio-capture backend. Resolved per-OS at runtime (the same pattern
/// as `ContainerRuntime`); `FileAudioCapture` is the dev/test implementor.
pub trait AudioCapture: Send + Sync {
    /// What this backend can do on this host.
    fn capabilities(&self) -> CaptureCapabilities;

    /// List the sources the user can pick from (running audio apps, input
    /// devices, "System (everything)"). May be empty (no devices / nothing
    /// playing yet).
    fn enumerate_sources(&self) -> Result<Vec<AudioSourceInfo>, CaptureError>;

    /// Start capturing `source`. Returns a stream of `AudioChunk`s. Validation
    /// of `source` against `capabilities()` is the caller's job, but a backend
    /// may also reject an unsupported source here with `CaptureError::Unsupported`.
    fn start(&self, source: AudioSource) -> Result<Box<dyn AudioStream>, CaptureError>;
}

// --- FileAudioCapture: the dev/test backend ---------------------------------

/// "Captures" from a WAV file by streaming it back in [`CHUNK_DURATION`] chunks.
///
/// It accepts the file path either at construction (for the dev "transcribe
/// this file" affordance — the path is fixed) or via the `source` argument as
/// a `Microphone { device: Some("<path>") }` overload (a convenience for tests
/// that want to drive different fixtures through the same `Box<dyn AudioCapture>`).
/// The WAV must be 16-bit-int or 32-bit-float PCM; any sample rate / channel
/// count is accepted and converted to 16 kHz mono `f32` here.
pub struct FileAudioCapture {
    /// Default path used when `start()` is called with a non-path source.
    default_path: Option<PathBuf>,
}

impl FileAudioCapture {
    /// A `FileAudioCapture` with no fixed path — `start()` must be given the
    /// path via `Microphone { device: Some("<path>") }`.
    pub fn new() -> Self {
        Self { default_path: None }
    }

    /// A `FileAudioCapture` bound to `path` — `start()` ignores its `source`
    /// argument and replays this file.
    pub fn for_file(path: impl AsRef<Path>) -> Self {
        Self {
            default_path: Some(path.as_ref().to_path_buf()),
        }
    }

    fn resolve_path(&self, source: &AudioSource) -> Result<PathBuf, CaptureError> {
        if let Some(p) = &self.default_path {
            return Ok(p.clone());
        }
        match source {
            AudioSource::Microphone { device: Some(path) } => Ok(PathBuf::from(path)),
            other => Err(CaptureError::Unsupported(format!(
                "FileAudioCapture needs a file path (set at construction, or pass Microphone{{device:Some(path)}}); got {other:?}"
            ))),
        }
    }
}

impl Default for FileAudioCapture {
    fn default() -> Self {
        Self::new()
    }
}

impl AudioCapture for FileAudioCapture {
    fn capabilities(&self) -> CaptureCapabilities {
        CaptureCapabilities::file_only()
    }

    fn enumerate_sources(&self) -> Result<Vec<AudioSourceInfo>, CaptureError> {
        // The only "source" is the configured file, if any.
        Ok(self
            .default_path
            .iter()
            .map(|p| AudioSourceInfo {
                source: AudioSource::Microphone {
                    device: Some(p.to_string_lossy().into_owned()),
                },
                label: format!("File: {}", p.display()),
                app_id: None,
            })
            .collect())
    }

    fn start(&self, source: AudioSource) -> Result<Box<dyn AudioStream>, CaptureError> {
        let path = self.resolve_path(&source)?;
        let mono16k = read_wav_as_mono_16k(&path)?;
        let frames_per_chunk =
            (SAMPLE_RATE_HZ as u128 * CHUNK_DURATION.as_millis() / 1000) as usize;
        Ok(Box::new(FilePlaybackStream {
            samples: mono16k,
            pos: 0,
            frames_per_chunk: frames_per_chunk.max(1),
        }))
    }
}

/// The `AudioStream` returned by `FileAudioCapture::start()`.
struct FilePlaybackStream {
    samples: Vec<f32>,
    pos: usize,
    frames_per_chunk: usize,
}

impl AudioStream for FilePlaybackStream {
    fn next_chunk(&mut self) -> Result<Option<AudioChunk>, CaptureError> {
        if self.pos >= self.samples.len() {
            return Ok(None);
        }
        let end = (self.pos + self.frames_per_chunk).min(self.samples.len());
        let chunk = AudioChunk {
            samples: self.samples[self.pos..end].to_vec(),
            offset: Duration::from_micros(
                (self.pos as u128 * 1_000_000 / SAMPLE_RATE_HZ as u128) as u64,
            ),
        };
        self.pos = end;
        Ok(Some(chunk))
    }
}

/// Reads a WAV file and returns 16 kHz mono `f32` samples in `[-1.0, 1.0]`.
/// Channels are downmixed by averaging. Sample rates other than 16 kHz are
/// resampled by simple linear interpolation (good enough for a file-backed
/// dev path — the real backends resample with proper resamplers).
fn read_wav_as_mono_16k(path: &Path) -> Result<Vec<f32>, CaptureError> {
    let mut reader = hound::WavReader::open(path)
        .map_err(|e| CaptureError::Failed(format!("open WAV {}: {e}", path.display())))?;
    let spec = reader.spec();
    let interleaved: Vec<f32> = match (spec.bits_per_sample, spec.sample_format) {
        (16, hound::SampleFormat::Int) => reader
            .samples::<i16>()
            .map(|s| s.map(|v| v as f32 / 32_768.0))
            .collect::<Result<_, _>>()
            .map_err(|e| CaptureError::Failed(format!("read i16 samples: {e}")))?,
        (32, hound::SampleFormat::Float) => reader
            .samples::<f32>()
            .collect::<Result<_, _>>()
            .map_err(|e| CaptureError::Failed(format!("read f32 samples: {e}")))?,
        (bits, fmt) => {
            return Err(CaptureError::Failed(format!(
                "unsupported WAV format ({bits}-bit {fmt:?}) — need 16-bit int or 32-bit float"
            )))
        }
    };
    let channels = spec.channels.max(1) as usize;
    let mono: Vec<f32> = if channels == 1 {
        interleaved
    } else {
        interleaved
            .chunks(channels)
            .map(|frame| frame.iter().copied().sum::<f32>() / frame.len() as f32)
            .collect()
    };
    Ok(resample_linear(&mono, spec.sample_rate, SAMPLE_RATE_HZ))
}

/// Linear-interpolation resampler. `src` is mono. Returns `src` unchanged when
/// `from == to`. (Deliberately simple — the production capture backends use
/// real resamplers; this is only on the file-input dev/test path.)
fn resample_linear(src: &[f32], from: u32, to: u32) -> Vec<f32> {
    if from == to || src.is_empty() {
        return src.to_vec();
    }
    let ratio = to as f64 / from as f64;
    let out_len = ((src.len() as f64) * ratio).round() as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src_pos = i as f64 / ratio;
        let i0 = src_pos.floor() as usize;
        let i1 = (i0 + 1).min(src.len() - 1);
        let frac = (src_pos - i0 as f64) as f32;
        let s0 = src[i0.min(src.len() - 1)];
        let s1 = src[i1];
        out.push(s0 + (s1 - s0) * frac);
    }
    out
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    /// Writes a 16-bit-int WAV to a temp dir from mono samples at `rate`, with
    /// `channels` (the mono sample is duplicated across channels). Returns the
    /// `TempDir` guard (keeps the file alive for the test) and the WAV path.
    fn write_temp_wav(
        samples_mono: &[f32],
        rate: u32,
        channels: u16,
    ) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("fixture.wav");
        let spec = hound::WavSpec {
            channels,
            sample_rate: rate,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut w = hound::WavWriter::create(&path, spec).unwrap();
        for &s in samples_mono {
            let v = (s.clamp(-1.0, 1.0) * 32_767.0) as i16;
            for _ in 0..channels {
                w.write_sample(v).unwrap();
            }
        }
        w.finalize().unwrap();
        (dir, path)
    }

    fn sine(n: usize, rate: u32, freq: f32) -> Vec<f32> {
        (0..n)
            .map(|i| 0.3 * (2.0 * std::f32::consts::PI * freq * i as f32 / rate as f32).sin())
            .collect()
    }

    #[test]
    fn file_capture_streams_a_16k_mono_wav_in_chunks() {
        let samples = sine(16_000, 16_000, 220.0); // exactly 1 s
        let (_guard, path) = write_temp_wav(&samples, 16_000, 1);
        let cap = FileAudioCapture::for_file(&path);
        assert_eq!(
            cap.capabilities().note.as_deref(),
            Some("File input only (no live capture backend on this build/OS)")
        );
        let mut stream = cap.start(AudioSource::SystemWide).unwrap();
        let mut total = 0usize;
        let mut last_offset = Duration::ZERO;
        let mut chunks = 0;
        while let Some(c) = stream.next_chunk().unwrap() {
            assert!(
                c.samples.len() <= 16_000 / 5,
                "chunk should be ≤ 200 ms ({} frames)",
                c.samples.len()
            );
            assert!(c.offset >= last_offset, "offsets must be monotonic");
            last_offset = c.offset;
            total += c.samples.len();
            chunks += 1;
        }
        assert_eq!(total, 16_000, "all samples delivered");
        assert_eq!(chunks, 5, "1 s of audio at 200 ms chunks = 5 chunks");
        assert!(
            stream.next_chunk().unwrap().is_none(),
            "stream stays exhausted"
        );
    }

    #[test]
    fn file_capture_downmixes_stereo_and_resamples() {
        // 48 kHz stereo, 0.5 s → expect ~8000 frames of 16 kHz mono.
        let samples = sine(24_000, 48_000, 440.0);
        let (_guard, path) = write_temp_wav(&samples, 48_000, 2);
        let cap = FileAudioCapture::for_file(&path);
        let mut stream = cap.start(AudioSource::SystemWide).unwrap();
        let mut total = 0usize;
        while let Some(c) = stream.next_chunk().unwrap() {
            for s in &c.samples {
                assert!(s.is_finite() && s.abs() <= 1.0, "samples stay in range");
            }
            total += c.samples.len();
        }
        let expected = 16_000 / 2; // 0.5 s @ 16 kHz
        assert!(
            (total as i64 - expected as i64).abs() <= 8,
            "resampled length ~{expected}, got {total}"
        );
    }

    #[test]
    fn file_capture_can_take_the_path_via_the_source_argument() {
        let samples = sine(8_000, 16_000, 330.0); // 0.5 s
        let (_guard, path) = write_temp_wav(&samples, 16_000, 1);
        let cap = FileAudioCapture::new(); // no fixed path
                                           // enumerate_sources is empty when there's no fixed path
        assert!(cap.enumerate_sources().unwrap().is_empty());
        let mut stream = cap
            .start(AudioSource::Microphone {
                device: Some(path.to_string_lossy().into_owned()),
            })
            .unwrap();
        let mut total = 0;
        while let Some(c) = stream.next_chunk().unwrap() {
            total += c.samples.len();
        }
        assert_eq!(total, 8_000);
    }

    /// `start()` returns `Result<Box<dyn AudioStream>, CaptureError>` and
    /// `Box<dyn AudioStream>` has no `Debug`, so `unwrap_err()` won't compile —
    /// pattern-match the error out instead.
    fn start_err(cap: &dyn AudioCapture, source: AudioSource) -> CaptureError {
        match cap.start(source) {
            Ok(_) => panic!("expected start() to fail"),
            Err(e) => e,
        }
    }

    #[test]
    fn file_capture_rejects_a_non_path_source_when_unbound() {
        let cap = FileAudioCapture::new();
        let err = start_err(&cap, AudioSource::SystemWide);
        assert!(
            matches!(err, CaptureError::Unsupported(_)),
            "expected Unsupported, got {err:?}"
        );
    }

    #[test]
    fn file_capture_errors_cleanly_on_a_missing_file() {
        let cap = FileAudioCapture::for_file("/nonexistent/definitely/not/here.wav");
        let err = start_err(&cap, AudioSource::SystemWide);
        assert!(
            matches!(err, CaptureError::Failed(_)),
            "expected Failed, got {err:?}"
        );
    }

    #[test]
    fn file_capture_errors_cleanly_on_a_corrupt_wav() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("corrupt.wav");
        std::fs::write(&path, b"RIFF\x00\x00\x00\x00not a real wav at all").unwrap();
        let cap = FileAudioCapture::for_file(&path);
        let err = start_err(&cap, AudioSource::SystemWide);
        assert!(
            matches!(err, CaptureError::Failed(_)),
            "expected Failed, got {err:?}"
        );
    }

    #[test]
    fn empty_wav_yields_an_empty_stream() {
        let (_guard, path) = write_temp_wav(&[], 16_000, 1);
        let cap = FileAudioCapture::for_file(&path);
        let mut stream = cap.start(AudioSource::SystemWide).unwrap();
        assert!(
            stream.next_chunk().unwrap().is_none(),
            "no samples → no chunks"
        );
    }

    #[test]
    fn resample_linear_is_identity_when_rates_match() {
        let v = sine(100, 16_000, 100.0);
        assert_eq!(resample_linear(&v, 16_000, 16_000), v);
        assert!(resample_linear(&[], 48_000, 16_000).is_empty());
    }

    #[test]
    fn audio_source_round_trips_through_serde() {
        let cases = [
            AudioSource::SystemWide,
            AudioSource::Process {
                selector: ProcessSelector::Pid { pid: 1234 },
            },
            AudioSource::Process {
                selector: ProcessSelector::NodeId {
                    id: "node-42".into(),
                },
            },
            AudioSource::Microphone { device: None },
            AudioSource::Microphone {
                device: Some("/tmp/x.wav".into()),
            },
            AudioSource::Mixed {
                system: Box::new(AudioSource::Process {
                    selector: ProcessSelector::Pid { pid: 9 },
                }),
                mic: Some("default".into()),
            },
        ];
        for c in cases {
            let j = serde_json::to_string(&c).unwrap();
            let back: AudioSource = serde_json::from_str(&j).unwrap();
            assert_eq!(back, c, "round-trip failed for {c:?} (json: {j})");
        }
        // Spot-check the wire shape so a frontend mirroring this type knows it.
        let j = serde_json::to_value(AudioSource::Process {
            selector: ProcessSelector::Pid { pid: 7 },
        })
        .unwrap();
        assert_eq!(j["kind"], "process");
        assert_eq!(j["selector"]["by"], "pid");
        assert_eq!(j["selector"]["pid"], 7);
    }

    #[test]
    fn capabilities_round_trip_through_serde() {
        let c = CaptureCapabilities {
            supports_per_process: true,
            supports_system_audio: true,
            supports_microphone: false,
            note: Some("x".into()),
        };
        let back: CaptureCapabilities =
            serde_json::from_str(&serde_json::to_string(&c).unwrap()).unwrap();
        assert_eq!(back, c);
        assert!(!CaptureCapabilities::file_only().supports_per_process);
    }
}
