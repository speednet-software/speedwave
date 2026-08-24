//! The `AudioCapture` trait: the seam between OS-specific backends (Windows WASAPI, macOS
//! CoreAudio taps) and the engine, plus `FileAudioCapture`, its WAV-backed test/dev impl.

use std::path::{Path, PathBuf};
use std::time::Duration;

/// Sample rate every `AudioStream` delivers — Whisper's input rate. Capture
/// backends resample their device-native rate down to this.
pub const SAMPLE_RATE_HZ: u32 = 16_000;

/// Chunk granularity `FileAudioCapture` delivers (and the rough cadence real backends aim for —
/// the macOS CLI's framed stdout protocol uses ~200 ms chunks, ADR-056). A reasonable default.
pub const CHUNK_DURATION: Duration = Duration::from_millis(200);

/// UI label for the default "system loopback + your microphone" source every backend offers
/// first (ADR-056 dec. 15). Single source so all backends and the Angular fixture agree.
pub const DEFAULT_MIXED_SOURCE_LABEL: &str = "Whole meeting (system audio + your microphone)";

/// What to capture.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum AudioSource {
    /// All system audio output (the "everything" loopback). Always available.
    SystemWide,
    /// A specific microphone input device (the user's own voice).
    Microphone {
        /// Device id (`None` = system default input).
        device: Option<String>,
    },
    /// System audio + your microphone, mixed into one mono stream (the meeting
    /// default). The system side is always the full loopback.
    Mixed {
        /// The microphone device for "your side" (`None` = default input).
        mic: Option<String>,
    },
}

/// A capturable source the UI can offer the user, as returned by
/// `AudioCapture::enumerate_sources()`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct AudioSourceInfo {
    /// The source to pass to `start()` if the user picks this entry.
    pub source: AudioSource,
    /// Human-readable label (e.g. `"System (everything)"`, `"Microphone: …"`).
    pub label: String,
}

/// What a capture backend on this host can do — surfaced to the UI.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct CaptureCapabilities {
    /// `true` if capturing the system loopback at all is possible on this host
    /// (e.g. `false` on macOS < 14.2).
    pub supports_system_audio: bool,
    /// `true` if a microphone input is available.
    pub supports_microphone: bool,
    /// Short human-readable note for the UI when something is limited, else `None`.
    pub note: Option<String>,
}

impl CaptureCapabilities {
    /// The capabilities of `FileAudioCapture` / a dev environment: it can
    /// "capture" from a file path only; nothing real.
    pub fn file_only() -> Self {
        Self {
            supports_system_audio: false,
            supports_microphone: false,
            note: Some("File input only (no live capture backend on this build/OS)".to_string()),
        }
    }
}

/// One chunk of captured PCM: 16 kHz `f32` samples in `[-1.0, 1.0]`, plus the offset of this
/// chunk's first sample from recording start. `Mixed` sources deliver both channels, paired.
#[derive(Debug, Clone)]
pub struct AudioChunk {
    /// 16 kHz mono samples: the only channel, or the system side when `mic` is set.
    pub samples: Vec<f32>,
    /// Mic-side samples index-aligned with `samples` (`Mixed` captures only) —
    /// decoded separately so quiet speech never competes with loud playback.
    pub mic: Option<Vec<f32>>,
    /// Offset of `samples[0]` from the start of capture.
    pub offset: Duration,
}

/// Errors a capture backend can produce.
#[derive(Debug, thiserror::Error)]
pub enum CaptureError {
    /// The requested source isn't supported on this host (e.g. system loopback
    /// on macOS < 14.2, or a missing sound server).
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

/// Non-fatal capture-health warnings a backend surfaces to the UI (ADR-056:
/// a consent-broken tap delivers silence, not an error — detect and say so).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptureWarning {
    /// The system-audio side has produced only digital silence since start.
    SystemAudioSilent,
    /// The mic stopped delivering; recording continues with system audio only.
    MicrophoneStalled,
    /// System audio stopped delivering; recording continues with the mic only.
    SystemAudioStalled,
    /// Captured audio was dropped before it reached the recording — that span is missing from
    /// both the WAV and the transcript.
    AudioDropped,
    /// A registered audio part contributed nothing to the offline pass — the
    /// finalized transcript is missing that span (resumed parts, ADR-056 Am. 10).
    RecordingPartMissing,
}

/// A capture-health transition: a warning raised, or a prior one recovered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptureHealth {
    /// The degradation began.
    Raised(CaptureWarning),
    /// The degraded side recovered.
    Cleared(CaptureWarning),
}

/// A live (or file-backed) stream of `AudioChunk`s. `next_chunk()` returns `Ok(None)` at end of
/// stream (EOF for a file; a live backend ends via dropping it). `Send` for background pumping.
pub trait AudioStream: Send {
    /// Block for the next chunk. `Ok(None)` = stream finished. `Err(_)` = the
    /// capture broke (the driver flips the session to `Failed`).
    fn next_chunk(&mut self) -> Result<Option<AudioChunk>, CaptureError>;

    /// Drains capture-health transitions since the last call (default: none).
    fn take_health(&mut self) -> Vec<CaptureHealth> {
        Vec::new()
    }
}

/// RMS of a PCM span (0.0 for an empty span).
pub fn rms(pcm: &[f32]) -> f32 {
    if pcm.is_empty() {
        return 0.0;
    }
    let sum_sq: f64 = pcm.iter().map(|&s| (s as f64) * (s as f64)).sum();
    (sum_sq / pcm.len() as f64).sqrt() as f32
}

/// Flags a system-audio stream that has been pure digital silence since start
/// (the signature of a consent-broken CoreAudio tap or a wrong loopback device).
#[derive(Debug, Default)]
pub struct ZeroStreakDetector {
    samples_seen: u64,
    nonzero_seen: bool,
    reported: bool,
}

/// Silence-warning threshold: this much all-zero audio from the start.
pub(crate) const SILENT_AFTER_SAMPLES: u64 = SAMPLE_RATE_HZ as u64 * 15;

impl ZeroStreakDetector {
    /// Feeds samples; one-shot `Raised` after [`SILENT_AFTER_SAMPLES`] of pure
    /// zeros, one-shot `Cleared` if signal arrives after the warning fired.
    pub fn feed(&mut self, samples: &[f32]) -> Option<CaptureHealth> {
        if self.nonzero_seen {
            return None;
        }
        if samples.iter().any(|&s| s != 0.0) {
            self.nonzero_seen = true;
            if self.reported {
                log::info!(
                    target: "transcription::capture",
                    "system audio started delivering signal after the silent-start warning"
                );
                return Some(CaptureHealth::Cleared(CaptureWarning::SystemAudioSilent));
            }
            return None;
        }
        if self.reported {
            return None;
        }
        self.samples_seen += samples.len() as u64;
        if self.samples_seen >= SILENT_AFTER_SAMPLES {
            self.reported = true;
            log::warn!(
                target: "transcription::capture",
                "system audio has been pure silence since capture start — likely a missing/broken System Audio Recording permission"
            );
            return Some(CaptureHealth::Raised(CaptureWarning::SystemAudioSilent));
        }
        None
    }
}

/// A host audio-capture backend. Resolved per-OS at runtime (the same pattern
/// as `ContainerRuntime`); `FileAudioCapture` is the dev/test implementor.
pub trait AudioCapture: Send + Sync {
    /// What this backend can do on this host.
    fn capabilities(&self) -> CaptureCapabilities;

    /// List the sources the user can pick from (input devices, "System (everything)"). May be
    /// empty (no devices / nothing playing yet).
    fn enumerate_sources(&self) -> Result<Vec<AudioSourceInfo>, CaptureError>;

    /// Start capturing `source`. Validation against `capabilities()` is the caller's job, but a
    /// backend may also reject an unsupported source with `CaptureError::Unsupported`.
    fn start(&self, source: AudioSource) -> Result<Box<dyn AudioStream>, CaptureError>;
}

// --- FileAudioCapture: the dev/test backend ---------------------------------

/// "Captures" from a WAV file by streaming it back in [`CHUNK_DURATION`] chunks (file path at
/// construction or via `Microphone{device:Some("<path>")}`); any rate/format converts to 16 kHz.
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

    /// A `FileAudioCapture` bound to `path` — `start()` ignores its `source` and replays this
    /// file. Test-only: production passes the path per-call via `Microphone{device:Some(path)}`.
    #[cfg(test)]
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
            mic: None,
            offset: Duration::from_micros(
                (self.pos as u128 * 1_000_000 / SAMPLE_RATE_HZ as u128) as u64,
            ),
        };
        self.pos = end;
        Ok(Some(chunk))
    }
}

/// Parses a WAV file into mono `f32` samples (no resampling). Returns the downmixed samples and
/// the file's sample rate so callers can choose to resample or trust it.
pub fn parse_wav_to_mono_f32(path: &Path) -> Result<(Vec<f32>, u32), CaptureError> {
    let (channels, rate) = parse_wav_to_channels_f32(path)?;
    let mono = match channels.len() {
        0 => Vec::new(),
        1 => channels.into_iter().next().unwrap_or_default(),
        n => {
            let len = channels.iter().map(Vec::len).min().unwrap_or(0);
            (0..len)
                .map(|i| channels.iter().map(|ch| ch[i]).sum::<f32>() / n as f32)
                .collect()
        }
    };
    Ok((mono, rate))
}

/// Parses a WAV file into per-channel `f32` samples (no resampling, no downmix).
/// Returns one `Vec` per channel plus the file's sample rate.
pub fn parse_wav_to_channels_f32(path: &Path) -> Result<(Vec<Vec<f32>>, u32), CaptureError> {
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
    let mut out = vec![Vec::with_capacity(interleaved.len() / channels); channels];
    for frame in interleaved.chunks(channels) {
        for (ch, &s) in frame.iter().enumerate() {
            out[ch].push(s);
        }
    }
    Ok((out, spec.sample_rate))
}

/// Duration of a WAV file from its header (`None` when unreadable or the header
/// carries a zero sample rate). Never decodes samples — cheap on long recordings.
pub fn wav_duration(path: &Path) -> Option<Duration> {
    let reader = hound::WavReader::open(path).ok()?;
    let rate = reader.spec().sample_rate;
    if rate == 0 {
        return None;
    }
    Some(Duration::from_secs_f64(
        f64::from(reader.duration()) / f64::from(rate),
    ))
}

/// File-backed dev path: parse + resample to 16 kHz.
fn read_wav_as_mono_16k(path: &Path) -> Result<Vec<f32>, CaptureError> {
    let (mono, rate) = parse_wav_to_mono_f32(path)?;
    Ok(resample_linear(&mono, rate, SAMPLE_RATE_HZ))
}

/// Decodes raw little-endian f32 bytes into samples. Trailing bytes (`len % 4`)
/// are silently truncated — the caller already aligns to 4-byte frames.
pub fn bytes_to_f32_samples(raw: &[u8]) -> Vec<f32> {
    raw.chunks_exact(4)
        .map(|f| f32::from_le_bytes([f[0], f[1], f[2], f[3]]))
        .collect()
}

/// Spawns a background thread draining a child's stderr into the log so it can't deadlock on a
/// full pipe. `target` distinguishes log lines per capture backend.
pub fn drain_child_stderr(child: &mut std::process::Child, target: &'static str) -> ChildStderr {
    use std::io::BufRead;
    let collected = ChildStderr::default();
    if let Some(stderr) = child.stderr.take() {
        let sink = collected.clone();
        std::thread::spawn(move || {
            let reader = std::io::BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                // Denials must be visible in logs, not buried at debug.
                if line.to_ascii_lowercase().contains("denied") {
                    log::warn!(target: "transcription::capture", "{target}: {line}");
                } else {
                    log::debug!(target: "transcription::capture", "{target}: {line}");
                }
                if let Ok(mut lines) = sink.lines.lock() {
                    if lines.len() < MAX_STDERR_LINES {
                        lines.push(line);
                    }
                }
            }
            sink.done.store(true, std::sync::atomic::Ordering::SeqCst);
        });
    } else {
        collected
            .done
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }
    collected
}

/// Cap on buffered child-stderr lines (diagnostics only).
const MAX_STDERR_LINES: usize = 50;

/// Handle to a capture child's collected stderr (see [`drain_child_stderr`]).
#[derive(Clone, Debug, Default)]
pub struct ChildStderr {
    lines: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
    done: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl ChildStderr {
    /// Joined stderr lines; waits up to `timeout` for the drain to finish
    /// (the child must already have exited, else this just times out).
    pub fn wait_snapshot(&self, timeout: Duration) -> String {
        let deadline = std::time::Instant::now() + timeout;
        while !self.done.load(std::sync::atomic::Ordering::SeqCst)
            && std::time::Instant::now() < deadline
        {
            std::thread::sleep(Duration::from_millis(10));
        }
        self.lines.lock().map(|l| l.join("; ")).unwrap_or_default()
    }
}

/// Best-effort graceful kill: skip if already exited, else SIGKILL + reap.
pub fn kill_child_gracefully(child: &mut std::process::Child) {
    if child.try_wait().ok().flatten().is_none() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// Linear-interpolation resampler. `src` is mono; returns unchanged when `from == to`.
/// Deliberately simple — production backends use real resamplers; this is dev/test-only.
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
#[expect(clippy::unwrap_used, reason = "test code")]
mod tests {
    use super::*;

    #[test]
    fn rms_of_known_signals() {
        assert_eq!(rms(&[]), 0.0);
        assert!((rms(&vec![0.5f32; 100]) - 0.5).abs() < 1e-6);
        assert!((rms(&vec![-0.5f32; 100]) - 0.5).abs() < 1e-6);
    }

    #[test]
    fn capture_warning_variants_match_ts_union() {
        let src = include_str!("../../../../desktop/src/src/app/models/transcript.ts");
        for (variant, json) in [
            (CaptureWarning::SystemAudioSilent, "system_audio_silent"),
            (CaptureWarning::MicrophoneStalled, "microphone_stalled"),
            (CaptureWarning::SystemAudioStalled, "system_audio_stalled"),
            (CaptureWarning::AudioDropped, "audio_dropped"),
            (
                CaptureWarning::RecordingPartMissing,
                "recording_part_missing",
            ),
        ] {
            assert_eq!(
                serde_json::to_string(&variant).unwrap(),
                format!("\"{json}\"")
            );
            assert!(
                src.contains(json),
                "models/transcript.ts must carry '{json}'"
            );
        }
        assert!(
            src.contains("kind: 'capture_warning'"),
            "TS TranscriptEvent union must carry the capture_warning kind"
        );
        assert!(
            src.contains("kind: 'capture_warning_cleared'"),
            "TS TranscriptEvent union must carry the capture_warning_cleared kind"
        );
    }

    #[test]
    fn zero_streak_detector_fires_once_only_for_pure_silence() {
        let mut z = ZeroStreakDetector::default();
        let five_secs = vec![0.0f32; SAMPLE_RATE_HZ as usize * 5];
        assert_eq!(z.feed(&five_secs), None);
        assert_eq!(z.feed(&five_secs), None);
        assert_eq!(
            z.feed(&five_secs),
            Some(CaptureHealth::Raised(CaptureWarning::SystemAudioSilent))
        );
        assert_eq!(z.feed(&five_secs), None); // one-shot
                                              // Any non-zero sample disarms it for good.
        let mut z2 = ZeroStreakDetector::default();
        assert_eq!(z2.feed(&[0.0, 0.001]), None);
        assert_eq!(
            z2.feed(&vec![0.0f32; SAMPLE_RATE_HZ as usize * 20]),
            None,
            "signal was seen — never warn"
        );
    }

    #[test]
    fn zero_streak_detector_clears_once_when_signal_finally_arrives() {
        let mut z = ZeroStreakDetector::default();
        let five_secs = vec![0.0f32; SAMPLE_RATE_HZ as usize * 5];
        for _ in 0..3 {
            let _ = z.feed(&five_secs);
        }
        // Warned already; the first real sample recovers the banner exactly once.
        assert_eq!(
            z.feed(&[0.0, 0.2]),
            Some(CaptureHealth::Cleared(CaptureWarning::SystemAudioSilent))
        );
        assert_eq!(z.feed(&[0.3]), None);
        assert_eq!(z.feed(&five_secs), None, "disarmed for good after signal");
    }

    /// Writes a 16-bit-int WAV to a temp dir from mono samples at `rate`/`channels` (duplicated
    /// across channels). Returns the `TempDir` guard (keeps the file alive) and the WAV path.
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

    /// `Box<dyn AudioStream>` has no `Debug`, so `unwrap_err()` won't compile — pattern-match.
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

    /// Hand-crafts a minimal 16-bit mono PCM WAV so headers hound's writer
    /// refuses (e.g. a zero sample rate) can still be planted.
    fn write_raw_wav(path: &Path, rate: u32, frames: u32) {
        let data_len = frames * 2;
        let mut b = Vec::new();
        b.extend_from_slice(b"RIFF");
        b.extend_from_slice(&(36 + data_len).to_le_bytes());
        b.extend_from_slice(b"WAVE");
        b.extend_from_slice(b"fmt ");
        b.extend_from_slice(&16u32.to_le_bytes());
        b.extend_from_slice(&1u16.to_le_bytes()); // PCM
        b.extend_from_slice(&1u16.to_le_bytes()); // mono
        b.extend_from_slice(&rate.to_le_bytes());
        b.extend_from_slice(&rate.saturating_mul(2).to_le_bytes()); // byte rate
        b.extend_from_slice(&2u16.to_le_bytes()); // block align
        b.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
        b.extend_from_slice(b"data");
        b.extend_from_slice(&data_len.to_le_bytes());
        b.resize(b.len() + data_len as usize, 0);
        std::fs::write(path, b).unwrap();
    }

    #[test]
    fn wav_duration_reads_the_header_of_a_valid_file() {
        // 0.5 s mono at 16 kHz, and 0.25 s stereo (duration is per channel).
        let (_g1, mono) = write_temp_wav(&vec![0.1f32; 8_000], 16_000, 1);
        assert_eq!(wav_duration(&mono), Some(Duration::from_millis(500)));
        let (_g2, stereo) = write_temp_wav(&vec![0.1f32; 4_000], 16_000, 2);
        assert_eq!(wav_duration(&stereo), Some(Duration::from_millis(250)));
        // A header-only WAV is a valid zero-length recording.
        let (_g3, empty) = write_temp_wav(&[], 16_000, 1);
        assert_eq!(wav_duration(&empty), Some(Duration::ZERO));
    }

    #[test]
    fn wav_duration_rejects_a_zero_sample_rate() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("zero-rate.wav");
        write_raw_wav(&path, 0, 100);
        assert_eq!(wav_duration(&path), None, "rate 0 must never divide");
        // Sanity: the same raw shape with a real rate parses.
        let ok = dir.path().join("ok.wav");
        write_raw_wav(&ok, 16_000, 8_000);
        assert_eq!(wav_duration(&ok), Some(Duration::from_millis(500)));
    }

    #[test]
    fn wav_duration_is_none_for_unreadable_or_corrupt_files() {
        assert_eq!(wav_duration(Path::new("/no/such/file.wav")), None);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("garbage.wav");
        std::fs::write(&path, vec![0xAAu8; 200]).unwrap();
        assert_eq!(wav_duration(&path), None);
    }

    #[test]
    fn bytes_to_f32_decodes_le_and_drops_a_trailing_partial_sample() {
        // 2 full f32s + 3 trailing bytes — chunks_exact drops the partial.
        let mut raw = Vec::new();
        raw.extend_from_slice(&1.0f32.to_le_bytes());
        raw.extend_from_slice(&(-0.5f32).to_le_bytes());
        raw.extend_from_slice(&[0xAA, 0xBB, 0xCC]);
        assert_eq!(bytes_to_f32_samples(&raw), vec![1.0, -0.5]);
        assert!(bytes_to_f32_samples(&[]).is_empty());
        assert!(bytes_to_f32_samples(&[1, 2, 3]).is_empty());
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
            AudioSource::Microphone { device: None },
            AudioSource::Microphone {
                device: Some("/tmp/x.wav".into()),
            },
            AudioSource::Mixed {
                mic: Some("default".into()),
            },
        ];
        for c in cases {
            let j = serde_json::to_string(&c).unwrap();
            let back: AudioSource = serde_json::from_str(&j).unwrap();
            assert_eq!(back, c, "round-trip failed for {c:?} (json: {j})");
        }
        // Backward compat: an old Mixed with the retired `system` field still
        // loads (serde ignores the unknown key) into the new shape.
        let old = r#"{"kind":"mixed","system":{"kind":"system_wide"},"mic":null}"#;
        assert_eq!(
            serde_json::from_str::<AudioSource>(old).unwrap(),
            AudioSource::Mixed { mic: None }
        );
        // Spot-check the wire shape so a frontend mirroring this type knows it.
        let j = serde_json::to_value(AudioSource::Microphone { device: None }).unwrap();
        assert_eq!(j["kind"], "microphone");
    }

    #[test]
    fn capabilities_round_trip_through_serde() {
        let c = CaptureCapabilities {
            supports_system_audio: true,
            supports_microphone: false,
            note: Some("x".into()),
        };
        let back: CaptureCapabilities =
            serde_json::from_str(&serde_json::to_string(&c).unwrap()).unwrap();
        assert_eq!(back, c);
        assert!(!CaptureCapabilities::file_only().supports_system_audio);
    }
}
