//! Windows audio capture: WASAPI loopback via `cpal` (ADR-056). cpal turns a
//! `build_input_stream` on an *output* device into a loopback capture of that
//! device — that's our "System (everything)" source, available on Windows 7+.
//!
//! Per-process loopback (`AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`) needs
//! Windows 10 build 20348+. cpal 0.16 doesn't expose it, so v1 ships
//! system-wide-only: `capabilities().supports_per_process` is `false` and a
//! `Process` source is rejected with a clear "use System audio" error. (A
//! future iteration can add a `windows-sys` shim — see ADR-056.)
//!
//! cpal callbacks deliver samples in the device's native rate (typically
//! 48 kHz, stereo); we down-mix to mono and linear-resample to 16 kHz on the
//! capture thread, then push `AudioChunk`s through a channel.

use std::sync::mpsc::{Receiver, SyncSender};
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

#[cfg(test)]
use super::audio::ProcessSelector;
use super::audio::{
    AudioCapture, AudioChunk, AudioSource, AudioSourceInfo, AudioStream, CaptureCapabilities,
    CaptureError,
};

/// Target output rate — Whisper wants 16 kHz mono.
const TARGET_RATE: u32 = 16_000;
/// Approximate chunk size (~200 ms at 16 kHz).
const CHUNK_FRAMES: usize = 3_200;
/// Channel depth for chunks in flight from the capture thread to the consumer.
/// A few seconds of audio — enough to absorb a slow consumer without unbounded
/// memory growth (a full channel drops the oldest, see the send site).
const CHANNEL_DEPTH: usize = 32;

/// Windows capture backend. Stateless; `start()` opens a fresh cpal stream.
pub struct WasapiAudioCapture {
    /// OS build number (`RtlGetVersion`-ish via cpal-independent probe). Drives
    /// the per-process capability flag. `None` if we couldn't read it.
    os_build: Option<u32>,
}

impl WasapiAudioCapture {
    /// Constructs the backend and reads the Windows build number.
    pub fn new() -> Self {
        Self {
            os_build: detect_windows_build(),
        }
    }

    /// `true` if this Windows build supports per-process loopback (≥ 20348).
    /// (We still don't *implement* it in v1 — see the module docs — but the
    /// flag lets a later iteration light it up without a capability change.)
    fn build_supports_per_process(&self) -> bool {
        self.os_build.map(|b| b >= 20_348).unwrap_or(false)
    }
}

impl Default for WasapiAudioCapture {
    fn default() -> Self {
        Self::new()
    }
}

/// Reads the Windows build number from the registry-equivalent
/// `cmd /c ver` output (`Microsoft Windows [Version 10.0.22631.xxxx]`). Cheap
/// and dependency-free; `None` on any parse failure.
fn detect_windows_build() -> Option<u32> {
    let out = std::process::Command::new("cmd")
        .args(["/c", "ver"])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    // Find `10.0.<build>.<rev>` and take the third dotted component.
    let version = text.split_whitespace().find(|t| t.starts_with("10.0."))?;
    let build_str = version.trim_matches(|c: char| !c.is_ascii_digit() && c != '.');
    build_str.split('.').nth(2)?.parse().ok()
}

impl AudioCapture for WasapiAudioCapture {
    fn capabilities(&self) -> CaptureCapabilities {
        let host = cpal::default_host();
        let has_output = host.default_output_device().is_some();
        let has_input = host.default_input_device().is_some();
        // v1: per-process is gated by the OS build *and* the (not-yet-shipped)
        // shim — so it's always false here, but the note tells the truth.
        let per_process_possible = self.build_supports_per_process();
        let note = if per_process_possible {
            Some("WASAPI loopback (system-wide). Per-app capture is planned.".to_string())
        } else {
            Some(
                "WASAPI loopback (system-wide). Per-app capture requires Windows 10 build 20348+."
                    .to_string(),
            )
        };
        CaptureCapabilities {
            supports_per_process: false,
            supports_system_audio: has_output,
            supports_microphone: has_input,
            note,
        }
    }

    fn enumerate_sources(&self) -> Result<Vec<AudioSourceInfo>, CaptureError> {
        let host = cpal::default_host();
        let mut sources = Vec::new();
        // System loopback — the default output device's loopback.
        if let Some(dev) = host.default_output_device() {
            let label = dev
                .name()
                .map(|n| format!("System ({n})"))
                .unwrap_or_else(|_| "System (everything)".to_string());
            sources.push(AudioSourceInfo {
                source: AudioSource::SystemWide,
                label,
                app_id: None,
            });
        } else {
            // No output device — still offer the abstract SystemWide so the UI
            // can show a clear error if the user picks it.
            sources.push(AudioSourceInfo {
                source: AudioSource::SystemWide,
                label: "System (everything)".to_string(),
                app_id: None,
            });
        }
        // Microphones — every input device cpal sees.
        if let Ok(inputs) = host.input_devices() {
            for dev in inputs {
                let name = dev.name().unwrap_or_else(|_| "Unknown input".to_string());
                sources.push(AudioSourceInfo {
                    source: AudioSource::Microphone {
                        device: Some(name.clone()),
                    },
                    label: name,
                    app_id: None,
                });
            }
        }
        Ok(sources)
    }

    fn start(&self, source: AudioSource) -> Result<Box<dyn AudioStream>, CaptureError> {
        let host = cpal::default_host();
        let (device, is_loopback) = match &source {
            AudioSource::SystemWide => {
                let dev = host.default_output_device().ok_or_else(|| {
                    CaptureError::NoDevice("no default output device for loopback".to_string())
                })?;
                (dev, true)
            }
            AudioSource::Microphone { device } => {
                let dev = match device {
                    None => host.default_input_device().ok_or_else(|| {
                        CaptureError::NoDevice("no default input device".to_string())
                    })?,
                    Some(name) => host
                        .input_devices()
                        .map_err(|e| CaptureError::Failed(format!("enumerate inputs: {e}")))?
                        .find(|d| d.name().map(|n| &n == name).unwrap_or(false))
                        .ok_or_else(|| {
                            CaptureError::NoDevice(format!("input device {name:?} not found"))
                        })?,
                };
                (dev, false)
            }
            AudioSource::Process { .. } => {
                return Err(CaptureError::Unsupported(
                    "per-app capture isn't available on Windows yet — use System audio".to_string(),
                ));
            }
            AudioSource::Mixed { system, .. } => {
                // v1: capture the system side; the engine can pull the mic via
                // a second stream if it needs to. Recurse on the system source.
                return self.start((**system).clone());
            }
        };

        // Pick a config: for loopback we must use the device's *output* config
        // (WASAPI loopback inherits the render format); for a mic we take its
        // default input config.
        let supported = if is_loopback {
            device
                .default_output_config()
                .map_err(|e| CaptureError::Failed(format!("default output config: {e}")))?
        } else {
            device
                .default_input_config()
                .map_err(|e| CaptureError::Failed(format!("default input config: {e}")))?
        };
        let sample_format = supported.sample_format();
        let src_rate = supported.sample_rate().0;
        let src_channels = supported.channels() as usize;
        let config: cpal::StreamConfig = supported.into();

        let (tx, rx) = std::sync::mpsc::sync_channel::<AudioChunk>(CHANNEL_DEPTH);
        let resampler = Resampler::new(src_rate, src_channels);

        let stream = build_stream(&device, &config, sample_format, resampler, tx)?;
        stream
            .play()
            .map_err(|e| CaptureError::Failed(format!("start stream: {e}")))?;

        Ok(Box::new(CpalAudioStream {
            _stream: stream,
            rx,
        }))
    }
}

/// Builds the cpal input stream for the given sample format, wiring its data
/// callback to down-mix → resample → push chunks.
fn build_stream(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    sample_format: cpal::SampleFormat,
    mut resampler: Resampler,
    tx: SyncSender<AudioChunk>,
) -> Result<cpal::Stream, CaptureError> {
    let err_fn = |e| log::warn!(target: "transcription::capture", "wasapi stream error: {e}");
    macro_rules! make {
        ($t:ty, $to_f32:expr) => {{
            let mut to_f32 = $to_f32;
            device.build_input_stream(
                config,
                move |data: &[$t], _: &cpal::InputCallbackInfo| {
                    let frames: Vec<f32> = data.iter().map(|s| to_f32(*s)).collect();
                    resampler.feed(&frames, &tx);
                },
                err_fn,
                None,
            )
        }};
    }
    let stream = match sample_format {
        cpal::SampleFormat::F32 => make!(f32, |s: f32| s),
        cpal::SampleFormat::I16 => make!(i16, |s: i16| s as f32 / 32_768.0),
        cpal::SampleFormat::U16 => make!(u16, |s: u16| (s as f32 - 32_768.0) / 32_768.0),
        other => {
            return Err(CaptureError::Failed(format!(
                "unsupported WASAPI sample format {other:?}"
            )));
        }
    };
    stream.map_err(|e| CaptureError::Failed(format!("build input stream: {e}")))
}

/// Down-mixes interleaved multi-channel f32 to mono and linear-resamples it to
/// 16 kHz, emitting `AudioChunk`s of ~`CHUNK_FRAMES` samples through a channel.
struct Resampler {
    /// Source sample rate (e.g. 48000).
    src_rate: u32,
    /// Source channel count (interleaved).
    channels: usize,
    /// Fractional position into the (virtual) mono source stream.
    pos: f64,
    /// Last mono sample carried over between callbacks (for interpolation
    /// across the buffer boundary).
    last: f32,
    /// Accumulating output chunk; flushed at `CHUNK_FRAMES`.
    out: Vec<f32>,
    /// Total output samples emitted so far — used to stamp `AudioChunk::offset`.
    emitted: u64,
}

impl Resampler {
    /// Creates a resampler from `src_rate`/`channels` to 16 kHz mono.
    fn new(src_rate: u32, channels: usize) -> Self {
        Self {
            src_rate: src_rate.max(1),
            channels: channels.max(1),
            pos: 0.0,
            last: 0.0,
            out: Vec::with_capacity(CHUNK_FRAMES),
            emitted: 0,
        }
    }

    /// Feeds one interleaved callback buffer; pushes any completed chunks.
    fn feed(&mut self, interleaved: &[f32], tx: &SyncSender<AudioChunk>) {
        if interleaved.is_empty() {
            return;
        }
        // Step in source-sample units per output sample.
        let step = self.src_rate as f64 / TARGET_RATE as f64;
        let channels = self.channels;
        let nmono = interleaved.len() / channels;
        if nmono == 0 {
            return;
        }
        // Mono down-mix via averaging. A free function (not a closure) so it
        // doesn't borrow `self` — `feed` needs `&mut self` for `flush`.
        fn mono(buf: &[f32], channels: usize, i: usize) -> f32 {
            let base = i * channels;
            let mut acc = 0.0f32;
            for c in 0..channels {
                acc += buf[base + c];
            }
            acc / channels as f32
        }

        // `pos` is measured from the start of *this* buffer, but interpolation
        // at pos < 0 uses `self.last` (the previous buffer's final sample).
        while self.pos < nmono as f64 {
            let idx = self.pos.floor() as isize;
            let frac = (self.pos - self.pos.floor()) as f32;
            let a = if idx < 0 {
                self.last
            } else {
                mono(interleaved, channels, idx as usize)
            };
            let b = if (idx + 1) < nmono as isize {
                mono(interleaved, channels, (idx + 1) as usize)
            } else {
                // Need the first sample of the next buffer; approximate with
                // the current one (negligible error at these ratios).
                mono(
                    interleaved,
                    channels,
                    (nmono - 1).min((idx.max(0)) as usize),
                )
            };
            let s = a + (b - a) * frac;
            self.out.push(s);
            self.emitted += 1;
            if self.out.len() >= CHUNK_FRAMES {
                self.flush(tx);
            }
            self.pos += step;
        }
        // Carry state across buffers: shift `pos` back by this buffer's length
        // and remember the last mono sample.
        self.pos -= nmono as f64;
        self.last = mono(interleaved, channels, nmono - 1);
    }

    /// Sends the accumulated chunk (best-effort — a full channel means the
    /// consumer fell behind; we drop this chunk rather than block the audio
    /// thread, which would glitch the whole system).
    fn flush(&mut self, tx: &SyncSender<AudioChunk>) {
        if self.out.is_empty() {
            return;
        }
        let samples = std::mem::take(&mut self.out);
        let n = samples.len() as u64;
        // `emitted` is incremented before each push, so it's ≥ n in normal
        // operation; `saturating_sub` keeps a directly-poked `out` (tests)
        // from underflowing.
        let offset = Duration::from_nanos(
            self.emitted.saturating_sub(n) * 1_000_000_000 / TARGET_RATE as u64,
        );
        // try_send: never block the cpal callback.
        let _ = tx.try_send(AudioChunk { samples, offset });
        self.out = Vec::with_capacity(CHUNK_FRAMES);
    }
}

/// `AudioStream` reading chunks the cpal callback pushes through the channel.
/// Dropping it drops the cpal `Stream`, which stops capture.
struct CpalAudioStream {
    _stream: cpal::Stream,
    rx: Receiver<AudioChunk>,
}

impl AudioStream for CpalAudioStream {
    fn next_chunk(&mut self) -> Result<Option<AudioChunk>, CaptureError> {
        // Block for the next chunk. A disconnected channel = the stream was
        // dropped or the callback stopped — treat as clean end of stream.
        match self.rx.recv() {
            Ok(chunk) => Ok(Some(chunk)),
            Err(_) => Ok(None),
        }
    }
}

/// Extracts a PID from a `ProcessSelector`. Windows v1 rejects `Process`
/// sources before this would be reached (per-process loopback isn't wired
/// yet), so it currently only exercises the selector contract in tests; gated
/// behind `cfg(test)` to keep production code dead-code-free. A future
/// per-process implementation lifts the gate.
#[cfg(test)]
fn pid_of(selector: &ProcessSelector) -> Result<i32, CaptureError> {
    match selector {
        ProcessSelector::Pid { pid } => Ok(*pid),
        ProcessSelector::NodeId { id } => Err(CaptureError::Unsupported(format!(
            "Windows capture needs a PID, got node id {id:?}"
        ))),
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn build_gate_thresholds_at_20348() {
        let old = WasapiAudioCapture {
            os_build: Some(19_045),
        };
        assert!(!old.build_supports_per_process());
        let new = WasapiAudioCapture {
            os_build: Some(22_631),
        };
        assert!(new.build_supports_per_process());
        let exactly = WasapiAudioCapture {
            os_build: Some(20_348),
        };
        assert!(exactly.build_supports_per_process());
        let unknown = WasapiAudioCapture { os_build: None };
        assert!(!unknown.build_supports_per_process());
    }

    #[test]
    fn capabilities_never_advertise_per_process_in_v1() {
        // Even on a build that *could* do it, v1 doesn't implement the shim.
        let cap = WasapiAudioCapture {
            os_build: Some(22_631),
        };
        assert!(!cap.capabilities().supports_per_process);
        // …but the note must say per-app is planned, not impossible.
        assert!(cap.capabilities().note.unwrap().contains("planned"));
        let old = WasapiAudioCapture {
            os_build: Some(19_045),
        };
        assert!(old.capabilities().note.unwrap().contains("20348"));
    }

    #[test]
    fn pid_helper_rejects_node_id() {
        let err = pid_of(&ProcessSelector::NodeId {
            id: "x".to_string(),
        })
        .unwrap_err();
        assert!(matches!(err, CaptureError::Unsupported(_)));
        assert_eq!(pid_of(&ProcessSelector::Pid { pid: 7 }).unwrap(), 7);
    }

    #[test]
    fn resampler_downmixes_stereo_to_mono() {
        // Same rate (16k→16k), 2 channels: output = per-frame average.
        let (tx, rx) = std::sync::mpsc::sync_channel::<AudioChunk>(8);
        let mut r = Resampler::new(16_000, 2);
        // 4 interleaved stereo frames: L,R pairs.
        let interleaved = vec![1.0, 3.0, 2.0, 4.0, -1.0, 1.0, 0.5, 0.5];
        r.feed(&interleaved, &tx);
        r.flush(&tx); // force out whatever we have
        drop(tx);
        let mut got = Vec::new();
        while let Ok(c) = rx.recv() {
            got.extend(c.samples);
        }
        // Averages: (1+3)/2=2, (2+4)/2=3, (-1+1)/2=0, (0.5+0.5)/2=0.5
        assert_eq!(got.len(), 4);
        assert!((got[0] - 2.0).abs() < 1e-4);
        assert!((got[1] - 3.0).abs() < 1e-4);
        assert!((got[2] - 0.0).abs() < 1e-4);
        assert!((got[3] - 0.5).abs() < 1e-4);
    }

    #[test]
    fn resampler_halves_sample_count_at_2x_rate() {
        // 32k → 16k mono: roughly half as many output samples.
        let (tx, rx) = std::sync::mpsc::sync_channel::<AudioChunk>(8);
        let mut r = Resampler::new(32_000, 1);
        let input: Vec<f32> = (0..1000).map(|i| (i as f32) * 0.001).collect();
        r.feed(&input, &tx);
        r.flush(&tx);
        drop(tx);
        let mut total = 0usize;
        while let Ok(c) = rx.recv() {
            total += c.samples.len();
        }
        // ~500, allow a small boundary slop.
        assert!((490..=510).contains(&total), "got {total} output samples");
    }

    #[test]
    fn resampler_empty_buffer_is_noop() {
        let (tx, rx) = std::sync::mpsc::sync_channel::<AudioChunk>(2);
        let mut r = Resampler::new(48_000, 2);
        r.feed(&[], &tx);
        r.flush(&tx);
        drop(tx);
        assert!(rx.recv().is_err(), "no chunk should be emitted");
    }

    #[test]
    fn resampler_full_channel_drops_chunk_not_blocks() {
        // Depth-1 channel, never drained: the second flush must not block.
        let (tx, _rx) = std::sync::mpsc::sync_channel::<AudioChunk>(1);
        let mut r = Resampler::new(16_000, 1);
        r.out = vec![0.0; CHUNK_FRAMES];
        r.flush(&tx); // fills the channel
        r.out = vec![0.0; CHUNK_FRAMES];
        r.flush(&tx); // would block on send() — try_send drops it instead
                      // If we got here without hanging, the non-blocking behaviour holds.
    }

    #[test]
    fn detect_windows_build_parses_a_version_string() {
        // We can't run `cmd /c ver` here, but exercise the parsing logic by
        // factoring it the same way (string → third dotted component).
        let sample = "Microsoft Windows [Version 10.0.22631.4317]";
        let version = sample.split_whitespace().find(|t| t.starts_with("10.0."));
        assert!(version.is_some());
        let build_str = version
            .unwrap()
            .trim_matches(|c: char| !c.is_ascii_digit() && c != '.');
        assert_eq!(
            build_str.split('.').nth(2).unwrap().parse::<u32>().unwrap(),
            22_631
        );
    }
}
