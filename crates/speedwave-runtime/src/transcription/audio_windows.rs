//! Windows audio capture (ADR-056): system audio via the `wasapi` crate
//! (cpal's loopback is unreliable — RustAudio/cpal#476), microphone via cpal.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, SyncSender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

use super::audio::{
    AudioCapture, AudioChunk, AudioSource, AudioSourceInfo, AudioStream, CaptureCapabilities,
    CaptureError, DEFAULT_MIXED_SOURCE_LABEL, SAMPLE_RATE_HZ,
};
use super::mix::{poll_mixed_chunk, MixBuffer, MixSource, CHUNK_SAMPLES};

/// How long the wasapi capture loop waits for the buffer-ready event before
/// looping back to re-check the stop flag. Short enough that teardown is snappy
/// on a silent endpoint, long enough not to busy-spin.
const WASAPI_POLL_TIMEOUT: Duration = Duration::from_millis(100);

/// Channel depth for chunks in flight from the capture thread to the consumer.
/// A few seconds of audio — enough to absorb a slow consumer without unbounded
/// memory growth (a full channel drops the oldest, see the send site).
const CHANNEL_DEPTH: usize = 32;

/// Windows capture backend. Stateless; `start()` opens a fresh cpal stream.
pub struct WasapiAudioCapture;

impl WasapiAudioCapture {
    /// Constructs the backend.
    pub fn new() -> Self {
        Self
    }
}

impl Default for WasapiAudioCapture {
    fn default() -> Self {
        Self::new()
    }
}

impl AudioCapture for WasapiAudioCapture {
    fn capabilities(&self) -> CaptureCapabilities {
        let host = cpal::default_host();
        // System audio is captured via wasapi (not cpal), but cpal's device
        // enumeration is a reliable proxy for "is there a default render
        // endpoint?" without opening a wasapi client here.
        let has_output = host.default_output_device().is_some();
        let has_input = host.default_input_device().is_some();
        CaptureCapabilities {
            supports_system_audio: has_output,
            supports_microphone: has_input,
            note: Some("WASAPI loopback (system-wide).".to_string()),
        }
    }

    fn enumerate_sources(&self) -> Result<Vec<AudioSourceInfo>, CaptureError> {
        let host = cpal::default_host();
        let mut sources = Vec::new();
        // "Whole meeting" (system loopback + default mic) first — the product
        // default for meeting transcription.
        if host.default_output_device().is_some() && host.default_input_device().is_some() {
            sources.push(AudioSourceInfo {
                source: AudioSource::Mixed { mic: None },
                label: DEFAULT_MIXED_SOURCE_LABEL.to_string(),
                app_id: None,
            });
        }
        // System loopback — the default output device's loopback.
        if let Some(dev) = host.default_output_device() {
            let label = device_name(&dev)
                .map(|n| format!("System ({n})"))
                .unwrap_or_else(|| "System (everything)".to_string());
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
                let name = device_name(&dev).unwrap_or_else(|| "Unknown input".to_string());
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
            // System audio → wasapi loopback.
            AudioSource::SystemWide => {
                let (tx, rx) = std::sync::mpsc::sync_channel::<AudioChunk>(CHANNEL_DEPTH);
                let stop = Arc::new(AtomicBool::new(false));
                let handle = spawn_wasapi_loopback(ResamplerSink::Channel(tx), &stop)?;
                Ok(Box::new(WasapiLoopbackStream {
                    rx,
                    _handle: handle,
                }))
            }
            AudioSource::Microphone { device } => {
                let dev = resolve_mic(&host, device)?;
                let (tx, rx) = std::sync::mpsc::sync_channel::<AudioChunk>(CHANNEL_DEPTH);
                let stream = open_capture_stream(&dev, ResamplerSink::Channel(tx))?;
                Ok(Box::new(CpalAudioStream {
                    _streams: vec![stream],
                    rx,
                }))
            }
            AudioSource::Mixed { mic } => {
                // System loopback (wasapi, on its own thread) + mic (cpal stream)
                // sum into one shared MixBuffer; next_chunk pops mixed chunks.
                let mic_dev = resolve_mic(&host, mic)?;
                let buf = Arc::new(Mutex::new(MixBuffer::new()));
                let stop = Arc::new(AtomicBool::new(false));
                let handle = spawn_wasapi_loopback(
                    ResamplerSink::Mixed {
                        buf: Arc::clone(&buf),
                        source: MixSource::System,
                    },
                    &stop,
                )?;
                let mic_stream = open_capture_stream(
                    &mic_dev,
                    ResamplerSink::Mixed {
                        buf: Arc::clone(&buf),
                        source: MixSource::Mic,
                    },
                )?;
                Ok(Box::new(MixedWasapiAudioStream {
                    buf,
                    handle: Some(handle),
                    _mic: mic_stream,
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
            let to_f32 = $to_f32;
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

/// Opens a cpal capture stream on a microphone `device`, resampling to 16 kHz
/// mono into `sink`. Returns the running `Stream` (dropping it stops capture).
fn open_capture_stream(
    device: &cpal::Device,
    sink: ResamplerSink,
) -> Result<cpal::Stream, CaptureError> {
    let supported = device
        .default_input_config()
        .map_err(|e| CaptureError::Failed(format!("default input config: {e}")))?;
    let sample_format = supported.sample_format();
    let src_rate = supported.sample_rate();
    let src_channels = supported.channels() as usize;
    let config: cpal::StreamConfig = supported.into();
    let resampler = Resampler::new(src_rate, src_channels);
    let stream = build_stream(device, &config, sample_format, resampler, sink)?;
    stream
        .play()
        .map_err(|e| CaptureError::Failed(format!("start stream: {e}")))?;
    Ok(stream)
}

/// Resolves a mic device name (`None` = default input) to a cpal input device.
fn resolve_mic(host: &cpal::Host, device: &Option<String>) -> Result<cpal::Device, CaptureError> {
    match device {
        None => host
            .default_input_device()
            .ok_or_else(|| CaptureError::NoDevice("no default input device".to_string())),
        Some(name) => host
            .input_devices()
            .map_err(|e| CaptureError::Failed(format!("enumerate inputs: {e}")))?
            .find(|d| device_name(d).as_deref() == Some(name.as_str()))
            .ok_or_else(|| CaptureError::NoDevice(format!("input device {name:?} not found"))),
    }
}

/// The human-readable name of a cpal device, or `None` if it can't be read.
/// Wraps the (non-deprecated) `description()` API so the call sites stay clean
/// and the enumerate/resolve round-trip uses one consistent naming source.
fn device_name(dev: &cpal::Device) -> Option<String> {
    dev.description().ok().map(|d| d.name().to_string())
}

/// Handle to a running wasapi capture thread. Dropping it signals the stop flag
/// and joins the thread, so capture stops deterministically. `failed` is set by
/// the thread if it dies on a device-read error (vs. a clean stop).
struct WasapiCaptureHandle {
    stop: Arc<AtomicBool>,
    failed: Arc<AtomicBool>,
    join: Option<std::thread::JoinHandle<()>>,
}

impl WasapiCaptureHandle {
    /// `true` if the capture thread aborted on an error rather than a clean stop.
    fn aborted(&self) -> bool {
        self.failed.load(Ordering::SeqCst)
    }
}

impl Drop for WasapiCaptureHandle {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(j) = self.join.take() {
            let _ = j.join();
        }
    }
}

/// Spawns the wasapi system-loopback capture thread, delivering 16 kHz mono
/// chunks into `sink` until `stop` is set. Reports setup success/failure back
/// through a one-shot channel so a bad endpoint fails `start()` cleanly.
fn spawn_wasapi_loopback(
    sink: ResamplerSink,
    stop: &Arc<AtomicBool>,
) -> Result<WasapiCaptureHandle, CaptureError> {
    // COM objects are apartment-bound, so the capture thread creates them.
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();
    let stop_thread = Arc::clone(stop);
    let failed = Arc::new(AtomicBool::new(false));
    let failed_thread = Arc::clone(&failed);
    let join = std::thread::Builder::new()
        .name("wasapi-loopback".to_string())
        .spawn(move || {
            run_wasapi_loopback(sink, &stop_thread, &failed_thread, ready_tx);
        })
        .map_err(|e| CaptureError::Failed(format!("spawn wasapi capture thread: {e}")))?;
    // Wait for the thread's setup result (bounded — a wedged COM init shouldn't
    // hang start() forever).
    match ready_rx.recv_timeout(Duration::from_secs(5)) {
        Ok(Ok(())) => Ok(WasapiCaptureHandle {
            stop: Arc::clone(stop),
            failed,
            join: Some(join),
        }),
        Ok(Err(e)) => {
            stop.store(true, Ordering::SeqCst);
            let _ = join.join();
            Err(CaptureError::Failed(format!("wasapi loopback init: {e}")))
        }
        Err(_) => {
            stop.store(true, Ordering::SeqCst);
            let _ = join.join();
            Err(CaptureError::Failed(
                "wasapi loopback init timed out".to_string(),
            ))
        }
    }
}

/// The wasapi capture thread body: init COM, open the loopback capture client,
/// signal readiness, then pump frames → `Resampler` → `sink` until `stop`.
#[cfg(windows)]
fn run_wasapi_loopback(
    sink: ResamplerSink,
    stop: &AtomicBool,
    failed: &AtomicBool,
    ready: std::sync::mpsc::Sender<Result<(), String>>,
) {
    use std::collections::VecDeque;
    use wasapi::{DeviceEnumerator, Direction, SampleType, StreamMode};

    // COM must be initialised on the capturing thread (MTA so the realtime
    // capture isn't bound to a UI message pump).
    if let Err(e) = wasapi::initialize_mta().ok() {
        let _ = ready.send(Err(format!("CoInitializeEx(MTA): {e:?}")));
        return;
    }

    // System loopback captures the default *render* endpoint in loopback mode.
    let client_res = DeviceEnumerator::new()
        .and_then(|e| e.get_default_device(&Direction::Render))
        .and_then(|d| d.get_iaudioclient());
    let mut client = match client_res {
        Ok(c) => c,
        Err(e) => {
            let _ = ready.send(Err(format!("open audio client: {e:?}")));
            return;
        }
    };

    // The device mix format is authoritative.
    let format = match client.get_mixformat() {
        Ok(f) => f,
        Err(e) => {
            let _ = ready.send(Err(format!("get_mixformat: {e:?}")));
            return;
        }
    };
    let src_rate = format.get_samplespersec();
    let src_channels = format.get_nchannels() as usize;
    let block_align = format.get_blockalign() as usize;
    let bytes_per_sample = block_align / src_channels.max(1);
    let is_float = matches!(format.get_subformat(), Ok(SampleType::Float));

    // Loopback always captures in shared, event-driven mode. `autoconvert`
    // lets WASAPI resample to our requested format where it can.
    if let Err(e) = client.initialize_client(
        &format,
        &Direction::Capture,
        &StreamMode::EventsShared {
            autoconvert: true,
            buffer_duration_hns: 0,
        },
    ) {
        let _ = ready.send(Err(format!("initialize_client: {e:?}")));
        return;
    }
    let event = match client.set_get_eventhandle() {
        Ok(h) => h,
        Err(e) => {
            let _ = ready.send(Err(format!("event handle: {e:?}")));
            return;
        }
    };
    let capture = match client.get_audiocaptureclient() {
        Ok(c) => c,
        Err(e) => {
            let _ = ready.send(Err(format!("get_audiocaptureclient: {e:?}")));
            return;
        }
    };
    if let Err(e) = client.start_stream() {
        let _ = ready.send(Err(format!("start_stream: {e:?}")));
        return;
    }

    // Setup OK — let start() return.
    let _ = ready.send(Ok(()));

    let mut resampler = Resampler::new(src_rate, src_channels);
    let mut queue: VecDeque<u8> = VecDeque::new();
    let timeout_ms = WASAPI_POLL_TIMEOUT.as_millis() as u32;

    while !stop.load(Ordering::SeqCst) {
        // Wait for the buffer-ready event, but time out so we re-check `stop`
        // on a silent endpoint (teardown stays snappy).
        if event.wait_for_event(timeout_ms).is_err() {
            continue;
        }
        if let Err(e) = capture.read_from_device_to_deque(&mut queue) {
            log::warn!(target: "transcription::capture", "wasapi read error: {e:?}");
            failed.store(true, Ordering::SeqCst);
            break;
        }
        if queue.is_empty() {
            continue;
        }
        let bytes: Vec<u8> = queue.drain(..).collect();
        let frames = decode_pcm_to_f32(&bytes, bytes_per_sample, is_float);
        resampler.feed(&frames, &sink);
    }

    let _ = client.stop_stream();
    wasapi::deinitialize();
}

/// Decodes a raw interleaved WASAPI byte buffer into `f32` samples. Handles
/// 32-bit float and 16/32-bit int (the shared-mode mix formats we accept).
/// Platform-agnostic (pure byte math) so it's unit-tested on any host.
fn decode_pcm_to_f32(raw: &[u8], bytes_per_sample: usize, is_float: bool) -> Vec<f32> {
    if bytes_per_sample == 0 {
        return Vec::new();
    }
    // Unsupported formats (e.g. 24-bit int) decode to silence — warn once so the
    // "records but silent" symptom is diagnosable, rather than per-sample spam.
    if !matches!(
        (is_float, bytes_per_sample),
        (true, 4) | (false, 2) | (false, 4)
    ) {
        log::warn!(target: "transcription::capture", "unsupported WASAPI format (float={is_float}, bps={bytes_per_sample}) — decoding as silence");
    }
    let n = raw.len() / bytes_per_sample;
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let off = i * bytes_per_sample;
        let s = match (is_float, bytes_per_sample) {
            (true, 4) => f32::from_le_bytes([raw[off], raw[off + 1], raw[off + 2], raw[off + 3]]),
            (false, 2) => i16::from_le_bytes([raw[off], raw[off + 1]]) as f32 / 32_768.0,
            (false, 4) => {
                i32::from_le_bytes([raw[off], raw[off + 1], raw[off + 2], raw[off + 3]]) as f32
                    / 2_147_483_648.0
            }
            _ => 0.0,
        };
        out.push(s);
    }
    out
}

/// On non-Windows targets the wasapi thread body is never reached (the whole
/// module is `#[cfg(windows)]` in production), but the cross-target test build
/// of the surrounding logic needs the symbol to resolve.
#[cfg(not(windows))]
fn run_wasapi_loopback(
    _sink: ResamplerSink,
    _stop: &AtomicBool,
    _failed: &AtomicBool,
    ready: std::sync::mpsc::Sender<Result<(), String>>,
) {
    let _ = ready.send(Err("wasapi loopback is Windows-only".to_string()));
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
/// 16 kHz, emitting ~`CHUNK_SAMPLES`-sized chunks to its `ResamplerSink`.
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
    /// Accumulating output chunk; flushed at `CHUNK_SAMPLES`.
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
            out: Vec::with_capacity(CHUNK_SAMPLES),
            emitted: 0,
        }
    }

    /// Feeds one interleaved callback buffer; pushes any completed chunks.
    fn feed(&mut self, interleaved: &[f32], sink: &ResamplerSink) {
        if interleaved.is_empty() {
            return;
        }
        // Step in source-sample units per output sample.
        let step = self.src_rate as f64 / SAMPLE_RATE_HZ as f64;
        let want = CHUNK_SAMPLES;
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
            if self.out.len() >= want {
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
        let offset_ns = self.emitted.saturating_sub(n) * 1_000_000_000 / SAMPLE_RATE_HZ as u64;
        sink.deliver(samples, offset_ns);
        self.out = Vec::with_capacity(CHUNK_SAMPLES);
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

/// `AudioStream` for a system-audio capture: the wasapi capture thread pushes
/// chunks through the channel. The held `WasapiCaptureHandle` stops + joins the
/// thread on drop.
struct WasapiLoopbackStream {
    rx: Receiver<AudioChunk>,
    /// Held to keep the capture thread alive; its `Drop` winds the thread down.
    _handle: WasapiCaptureHandle,
}

impl AudioStream for WasapiLoopbackStream {
    fn next_chunk(&mut self) -> Result<Option<AudioChunk>, CaptureError> {
        // `recv` blocks until a chunk, or until the thread drops the sender. A
        // disconnect after an abort (device-read error) is an error, not EOF.
        match self.rx.recv() {
            Ok(chunk) => Ok(Some(chunk)),
            Err(_) if self._handle.aborted() => Err(CaptureError::Failed(
                "wasapi capture stopped on a device-read error".to_string(),
            )),
            Err(_) => Ok(None),
        }
    }
}

/// `AudioStream` for a mixed capture: the wasapi system-loopback thread + a cpal
/// mic stream feed one shared `MixBuffer` polled by `next_chunk`. Dropping it
/// stops both.
struct MixedWasapiAudioStream {
    /// The buffer both sides push into; `next_chunk` pops from it.
    buf: Arc<Mutex<MixBuffer>>,
    /// Held to keep the wasapi capture thread alive; its `Drop` stops + joins.
    handle: Option<WasapiCaptureHandle>,
    /// Held to keep the cpal mic stream alive.
    _mic: cpal::Stream,
}

impl MixedWasapiAudioStream {
    /// `true` if the wasapi capture thread aborted on a device-read error.
    fn aborted(&self) -> bool {
        self.handle.as_ref().is_some_and(|h| h.aborted())
    }

    /// The error surfaced when the wasapi thread aborted mid-recording.
    fn abort_err() -> CaptureError {
        CaptureError::Failed("wasapi capture stopped on a device-read error".to_string())
    }
}

impl AudioStream for MixedWasapiAudioStream {
    fn next_chunk(&mut self) -> Result<Option<AudioChunk>, CaptureError> {
        // A wasapi-thread device-read abort surfaces as an error, not a quietly
        // truncated "complete" recording. Re-check after a poll stall so the
        // message is the precise abort, not the generic stall.
        if self.aborted() {
            return Err(Self::abort_err());
        }
        let res = poll_mixed_chunk(&self.buf);
        if res.is_err() && self.aborted() {
            return Err(Self::abort_err());
        }
        res
    }
}

impl Drop for MixedWasapiAudioStream {
    fn drop(&mut self) {
        // Stop the wasapi thread first (the cpal stream stops when `_mic` drops),
        // then mark the buffer finished so any final poll returns EOF.
        self.handle.take();
        if let Ok(mut b) = self.buf.lock() {
            b.finish();
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn decode_pcm_handles_float_and_int_formats() {
        // 32-bit float: round-trips bit-exact.
        let f = [1.0f32, -0.5];
        let mut bytes = Vec::new();
        for s in f {
            bytes.extend_from_slice(&s.to_le_bytes());
        }
        let got = decode_pcm_to_f32(&bytes, 4, true);
        assert_eq!(got.len(), 2);
        assert!((got[0] - 1.0).abs() < 1e-6);
        assert!((got[1] + 0.5).abs() < 1e-6);
        // 16-bit int: full-scale maps to ~1.0.
        let i = [i16::MAX, 0, i16::MIN];
        let mut ib = Vec::new();
        for s in i {
            ib.extend_from_slice(&s.to_le_bytes());
        }
        let gi = decode_pcm_to_f32(&ib, 2, false);
        assert_eq!(gi.len(), 3);
        assert!((gi[0] - 1.0).abs() < 1e-3);
        assert!(gi[1].abs() < 1e-6);
        assert!((gi[2] + 1.0).abs() < 1e-3);
        // Zero bytes-per-sample is a safe no-op.
        assert!(decode_pcm_to_f32(&[0, 1, 2, 3], 0, true).is_empty());
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
        r.out = vec![0.0; CHUNK_SAMPLES];
        r.flush(&sink); // fills the channel
        r.out = vec![0.0; CHUNK_SAMPLES];
        r.flush(&sink); // would block on send() — try_send drops it instead
                        // If we got here without hanging, the non-blocking behaviour holds.
    }

    #[test]
    fn resampler_mixed_sink_pushes_into_the_shared_buffer() {
        // Two resamplers (system + mic) feeding one MixBuffer; the buffer sums
        // them. Same rate, mono → 1:1, easy to reason about.
        let buf = std::sync::Arc::new(std::sync::Mutex::new(MixBuffer::new()));
        let sys_sink = ResamplerSink::Mixed {
            buf: std::sync::Arc::clone(&buf),
            source: MixSource::System,
        };
        let mic_sink = ResamplerSink::Mixed {
            buf: std::sync::Arc::clone(&buf),
            source: MixSource::Mic,
        };
        // Feed one chunk's worth of 1.0 on each side so flush fires.
        let ones = vec![1.0f32; CHUNK_SAMPLES];
        let mut rs = Resampler::new(16_000, 1);
        rs.feed(&ones, &sys_sink);
        let mut rm = Resampler::new(16_000, 1);
        rm.feed(&ones, &mic_sink);
        // Both streams delivered ~CHUNK_SAMPLES at offset 0 → mix pops 0.5+0.5=1.
        let mut b = buf.lock().unwrap();
        let chunk = b.pop(1, CHUNK_SAMPLES).expect("a mixed chunk is ready");
        assert!(!chunk.is_empty());
        assert!(
            chunk.iter().all(|&s| (s - 1.0).abs() < 1e-4),
            "system 1.0 + mic 1.0, each ×0.5, summed = 1.0"
        );
    }
}
