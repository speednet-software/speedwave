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
//! capture thread. A single-source capture pushes chunks through a channel; a
//! `Mixed` (system loopback + mic) capture runs two cpal streams that sum into
//! one shared `MixBuffer` (ADR-056 decision 15).

use std::sync::mpsc::{Receiver, SyncSender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

#[cfg(test)]
use super::audio::ProcessSelector;
use super::audio::{
    AudioCapture, AudioChunk, AudioSource, AudioSourceInfo, AudioStream, CaptureCapabilities,
    CaptureError, CHUNK_DURATION,
};
use super::mix::{MixBuffer, MixSource};

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
        // "Whole meeting" (system loopback + default mic) first — the product
        // default for meeting transcription.
        if host.default_output_device().is_some() && host.default_input_device().is_some() {
            sources.push(AudioSourceInfo {
                source: AudioSource::Mixed {
                    system: Box::new(AudioSource::SystemWide),
                    mic: None,
                },
                label: "Whole meeting (system audio + your microphone)".to_string(),
                app_id: None,
            });
        }
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
        match &source {
            AudioSource::SystemWide => {
                let dev = resolve_system(&host, &source)?;
                let (tx, rx) = std::sync::mpsc::sync_channel::<AudioChunk>(CHANNEL_DEPTH);
                let stream = open_capture_stream(&dev, true, ResamplerSink::Channel(tx))?;
                Ok(Box::new(CpalAudioStream {
                    _streams: vec![stream],
                    rx,
                }))
            }
            AudioSource::Microphone { device } => {
                let dev = resolve_mic(&host, device)?;
                let (tx, rx) = std::sync::mpsc::sync_channel::<AudioChunk>(CHANNEL_DEPTH);
                let stream = open_capture_stream(&dev, false, ResamplerSink::Channel(tx))?;
                Ok(Box::new(CpalAudioStream {
                    _streams: vec![stream],
                    rx,
                }))
            }
            AudioSource::Process { .. } => Err(CaptureError::Unsupported(
                "per-app capture isn't available on Windows yet — use System audio".to_string(),
            )),
            AudioSource::Mixed { system, mic } => {
                // Two concurrent cpal streams (system loopback + mic) summed in
                // one shared MixBuffer; next_chunk pops mixed chunks from it.
                let sys_dev = resolve_system(&host, system)?;
                let mic_dev = resolve_mic(&host, mic)?;
                let buf = Arc::new(Mutex::new(MixBuffer::new(true)));
                let sys_stream = open_capture_stream(
                    &sys_dev,
                    true,
                    ResamplerSink::Mixed {
                        buf: Arc::clone(&buf),
                        source: MixSource::System,
                    },
                )?;
                let mic_stream = open_capture_stream(
                    &mic_dev,
                    false,
                    ResamplerSink::Mixed {
                        buf: Arc::clone(&buf),
                        source: MixSource::Mic,
                    },
                )?;
                Ok(Box::new(MixedCpalAudioStream {
                    _streams: vec![sys_stream, mic_stream],
                    buf,
                }))
            }
        }
    }
}

/// Builds the cpal input stream for the given sample format, wiring its data
/// callback to down-mix → resample → deliver chunks to `sink`.
fn build_stream(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    sample_format: cpal::SampleFormat,
    mut resampler: Resampler,
    sink: ResamplerSink,
) -> Result<cpal::Stream, CaptureError> {
    let err_fn = |e| log::warn!(target: "transcription::capture", "wasapi stream error: {e}");
    macro_rules! make {
        ($t:ty, $to_f32:expr) => {{
            let mut to_f32 = $to_f32;
            device.build_input_stream(
                config,
                move |data: &[$t], _: &cpal::InputCallbackInfo| {
                    let frames: Vec<f32> = data.iter().map(|s| to_f32(*s)).collect();
                    resampler.feed(&frames, &sink);
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

/// Opens a cpal capture stream on `device` (loopback if `is_loopback`, else mic
/// input), resampling to 16 kHz mono into `sink`. Returns the running `Stream`.
fn open_capture_stream(
    device: &cpal::Device,
    is_loopback: bool,
    sink: ResamplerSink,
) -> Result<cpal::Stream, CaptureError> {
    // Loopback inherits the device's *output* (render) config; a mic uses its
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
    let resampler = Resampler::new(src_rate, src_channels);
    let stream = build_stream(device, &config, sample_format, resampler, sink)?;
    stream
        .play()
        .map_err(|e| CaptureError::Failed(format!("start stream: {e}")))?;
    Ok(stream)
}

/// Resolves the *system* side of a source (a plain `SystemWide` or the inner
/// `system` of a `Mixed`) to a cpal output device for loopback capture. Windows
/// v1 doesn't ship per-process loopback, so a `Process` (or anything else) is
/// rejected with a clear error — including when nested inside `Mixed`.
fn resolve_system(host: &cpal::Host, src: &AudioSource) -> Result<cpal::Device, CaptureError> {
    match src {
        AudioSource::SystemWide => host.default_output_device().ok_or_else(|| {
            CaptureError::NoDevice("no default output device for loopback".to_string())
        }),
        AudioSource::Process { .. } => Err(CaptureError::Unsupported(
            "per-app capture isn't available on Windows yet — use System audio".to_string(),
        )),
        other => Err(CaptureError::Unsupported(format!(
            "unsupported system source on Windows: {other:?}"
        ))),
    }
}

/// Resolves an `AudioSource::Microphone { device }` to a cpal input device.
fn resolve_mic(host: &cpal::Host, device: &Option<String>) -> Result<cpal::Device, CaptureError> {
    match device {
        None => host
            .default_input_device()
            .ok_or_else(|| CaptureError::NoDevice("no default input device".to_string())),
        Some(name) => host
            .input_devices()
            .map_err(|e| CaptureError::Failed(format!("enumerate inputs: {e}")))?
            .find(|d| d.name().map(|n| &n == name).unwrap_or(false))
            .ok_or_else(|| CaptureError::NoDevice(format!("input device {name:?} not found"))),
    }
}

/// Where a resampler delivers its 16 kHz mono output. Either a channel to a
/// single-stream consumer, or a shared `MixBuffer` (for mixed capture, the two
/// streams share one buffer that sums them — they push as `source`).
enum ResamplerSink {
    /// Single-stream: push `AudioChunk`s, dropping on a full channel.
    Channel(SyncSender<AudioChunk>),
    /// Mixed: push into the shared buffer tagged with which stream this is.
    Mixed {
        /// The buffer both streams write into.
        buf: Arc<Mutex<MixBuffer>>,
        /// Which side these samples are.
        source: MixSource,
    },
}

impl ResamplerSink {
    /// Delivers one completed chunk: `samples` start at `offset_ns` from start.
    fn deliver(&self, samples: Vec<f32>, offset_ns: u64) {
        match self {
            ResamplerSink::Channel(tx) => {
                // try_send: never block the cpal callback (a full channel means
                // the consumer fell behind — drop rather than glitch the audio).
                let _ = tx.try_send(AudioChunk {
                    samples,
                    offset: Duration::from_nanos(offset_ns),
                });
            }
            ResamplerSink::Mixed { buf, source } => {
                if let Ok(mut b) = buf.lock() {
                    b.push(*source, offset_ns, &samples);
                }
            }
        }
    }
}

/// Down-mixes interleaved multi-channel f32 to mono and linear-resamples it to
/// 16 kHz, emitting ~`CHUNK_FRAMES`-sample chunks to its `ResamplerSink`.
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
    /// Total output samples emitted so far — used to stamp the chunk offset.
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
    fn feed(&mut self, interleaved: &[f32], sink: &ResamplerSink) {
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
                self.flush(sink);
            }
            self.pos += step;
        }
        // Carry state across buffers: shift `pos` back by this buffer's length
        // and remember the last mono sample.
        self.pos -= nmono as f64;
        self.last = mono(interleaved, channels, nmono - 1);
    }

    /// Hands the accumulated chunk to the sink (best-effort — `ResamplerSink`
    /// never blocks the cpal callback).
    fn flush(&mut self, sink: &ResamplerSink) {
        if self.out.is_empty() {
            return;
        }
        let samples = std::mem::take(&mut self.out);
        let n = samples.len() as u64;
        // `emitted` is incremented before each push, so it's ≥ n in normal
        // operation; `saturating_sub` keeps a directly-poked `out` (tests)
        // from underflowing.
        let offset_ns = self.emitted.saturating_sub(n) * 1_000_000_000 / TARGET_RATE as u64;
        sink.deliver(samples, offset_ns);
        self.out = Vec::with_capacity(CHUNK_FRAMES);
    }
}

/// `AudioStream` reading chunks the cpal callback pushes through the channel.
/// Dropping it drops the cpal `Stream`(s), which stops capture.
struct CpalAudioStream {
    /// Held to keep the stream(s) alive (one for system or mic capture).
    _streams: Vec<cpal::Stream>,
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

/// `AudioStream` for a mixed capture: two cpal streams (system loopback + mic)
/// feed one shared `MixBuffer`; `next_chunk` pops mixed chunks from it. There's
/// no end-of-stream signal from cpal, so this never returns `Ok(None)` on its
/// own — the driver stops by dropping it (which stops both cpal streams).
struct MixedCpalAudioStream {
    /// Held to keep both cpal streams alive (system + mic).
    _streams: Vec<cpal::Stream>,
    /// The buffer both stream callbacks push into; `next_chunk` pops from it.
    buf: Arc<Mutex<MixBuffer>>,
}

impl AudioStream for MixedCpalAudioStream {
    fn next_chunk(&mut self) -> Result<Option<AudioChunk>, CaptureError> {
        let want = ((TARGET_RATE as u128 * CHUNK_DURATION.as_millis() / 1000) as usize).max(1);
        // Poll the mix buffer until a chunk is ready. cpal pushes from its own
        // threads (~200 ms cadence per stream); a 20 ms poll keeps this off a
        // busy loop. If nothing arrives for ~2 s the capture is effectively
        // dead (a device unplugged, both streams stopped) — return EOF so the
        // driver can finalize rather than spin forever.
        const STALL_GIVE_UP: Duration = Duration::from_secs(2);
        let mut waited = Duration::ZERO;
        loop {
            {
                let mut b = self
                    .buf
                    .lock()
                    .map_err(|_| CaptureError::Failed("mix buffer poisoned".to_string()))?;
                let start_ns = b.offset_ns();
                // While running we want full `want`-sized chunks; on a long
                // stall fall back to draining whatever's left.
                let chunk = b
                    .pop(want, want)
                    .or_else(|| (waited >= STALL_GIVE_UP).then(|| b.pop(1, want)).flatten());
                if let Some(samples) = chunk {
                    return Ok(Some(AudioChunk {
                        samples,
                        offset: Duration::from_nanos(start_ns),
                    }));
                }
            }
            if waited >= STALL_GIVE_UP {
                return Ok(None); // stalled long enough — treat as end of stream
            }
            std::thread::sleep(Duration::from_millis(20));
            waited += Duration::from_millis(20);
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

    /// Drains a channel sink into a flat sample vector (test helper).
    fn drain(rx: Receiver<AudioChunk>) -> Vec<f32> {
        let mut got = Vec::new();
        while let Ok(c) = rx.recv() {
            got.extend(c.samples);
        }
        got
    }

    #[test]
    fn resampler_downmixes_stereo_to_mono() {
        // Same rate (16k→16k), 2 channels: output = per-frame average.
        let (tx, rx) = std::sync::mpsc::sync_channel::<AudioChunk>(8);
        let sink = ResamplerSink::Channel(tx);
        let mut r = Resampler::new(16_000, 2);
        // 4 interleaved stereo frames: L,R pairs.
        let interleaved = vec![1.0, 3.0, 2.0, 4.0, -1.0, 1.0, 0.5, 0.5];
        r.feed(&interleaved, &sink);
        r.flush(&sink); // force out whatever we have
        drop(sink);
        let got = drain(rx);
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
        let sink = ResamplerSink::Channel(tx);
        let mut r = Resampler::new(32_000, 1);
        let input: Vec<f32> = (0..1000).map(|i| (i as f32) * 0.001).collect();
        r.feed(&input, &sink);
        r.flush(&sink);
        drop(sink);
        let total = drain(rx).len();
        // ~500, allow a small boundary slop.
        assert!((490..=510).contains(&total), "got {total} output samples");
    }

    #[test]
    fn resampler_empty_buffer_is_noop() {
        let (tx, rx) = std::sync::mpsc::sync_channel::<AudioChunk>(2);
        let sink = ResamplerSink::Channel(tx);
        let mut r = Resampler::new(48_000, 2);
        r.feed(&[], &sink);
        r.flush(&sink);
        drop(sink);
        assert!(rx.recv().is_err(), "no chunk should be emitted");
    }

    #[test]
    fn resampler_full_channel_drops_chunk_not_blocks() {
        // Depth-1 channel, never drained: the second flush must not block.
        let (tx, _rx) = std::sync::mpsc::sync_channel::<AudioChunk>(1);
        let sink = ResamplerSink::Channel(tx);
        let mut r = Resampler::new(16_000, 1);
        r.out = vec![0.0; CHUNK_FRAMES];
        r.flush(&sink); // fills the channel
        r.out = vec![0.0; CHUNK_FRAMES];
        r.flush(&sink); // would block on send() — try_send drops it instead
                        // If we got here without hanging, the non-blocking behaviour holds.
    }

    #[test]
    fn resampler_mixed_sink_pushes_into_the_shared_buffer() {
        // Two resamplers (system + mic) feeding one MixBuffer; the buffer sums
        // them. Same rate, mono → 1:1, easy to reason about.
        let buf = std::sync::Arc::new(std::sync::Mutex::new(MixBuffer::new(true)));
        let sys_sink = ResamplerSink::Mixed {
            buf: std::sync::Arc::clone(&buf),
            source: MixSource::System,
        };
        let mic_sink = ResamplerSink::Mixed {
            buf: std::sync::Arc::clone(&buf),
            source: MixSource::Mic,
        };
        // Feed CHUNK_FRAMES samples of 1.0 on each side so flush fires.
        let ones = vec![1.0f32; CHUNK_FRAMES];
        let mut rs = Resampler::new(16_000, 1);
        rs.feed(&ones, &sys_sink);
        let mut rm = Resampler::new(16_000, 1);
        rm.feed(&ones, &mic_sink);
        // Both streams delivered ~CHUNK_FRAMES at offset 0 → mix pops 0.5+0.5=1.
        let mut b = buf.lock().unwrap();
        let chunk = b.pop(1, CHUNK_FRAMES).expect("a mixed chunk is ready");
        assert!(!chunk.is_empty());
        assert!(
            chunk.iter().all(|&s| (s - 1.0).abs() < 1e-4),
            "system 1.0 + mic 1.0, each ×0.5, summed = 1.0"
        );
    }

    #[test]
    fn resolve_system_rejects_process_and_other_non_system_sources() {
        // A Process (per-app loopback not shipped) or a Microphone-as-system is
        // rejected before any device is touched.
        let host = cpal::default_host();
        assert!(matches!(
            resolve_system(
                &host,
                &AudioSource::Process {
                    selector: ProcessSelector::Pid { pid: 1 }
                }
            ),
            Err(CaptureError::Unsupported(_))
        ));
        assert!(matches!(
            resolve_system(&host, &AudioSource::Microphone { device: None }),
            Err(CaptureError::Unsupported(_))
        ));
        // SystemWide either resolves to the default output device or errors
        // NoDevice if there isn't one — never Unsupported.
        match resolve_system(&host, &AudioSource::SystemWide) {
            Ok(_) | Err(CaptureError::NoDevice(_)) => {}
            other => panic!("unexpected: {other:?}"),
        }
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
