//! Background task pumping AudioStream → Transcriber → TranscriptStore.

use std::collections::VecDeque;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use uuid::Uuid;

use crate::transcription::audio::{AudioStream, CaptureHealth, CaptureWarning, SAMPLE_RATE_HZ};
use crate::transcription::diarizer::{label_speakers, DiarizeError, DiarizerLoader};
use crate::transcription::model_catalog::DIARIZATION_MODEL;
use crate::transcription::transcriber::{
    Segment, TranscribeOptions, Transcriber, TranscriptSource,
};
use crate::transcription::transcript::{DiarizationRecord, TranscriptStatus};
use crate::transcription::transcript_store::{OfflinePass, StoreError, TranscriptStore};

/// Live sliding-window length (seconds): trailing audio re-fed to the transcriber for context.
/// Longer = more accurate trailing words but more recompute per chunk.
const LIVE_WINDOW_SECS: f32 = 12.0;

/// How often (in seconds of captured audio) the live transcriber re-decodes.
const LIVE_DECODE_EVERY_SECS: f32 = 5.0;

/// Ring headroom past the live window: the live pass abandons audio it never reached once its
/// lag exceeds `LIVE_WINDOW_SECS + LIVE_LAG_TOLERANCE_SECS` (the ring size); the WAV keeps all.
const LIVE_LAG_TOLERANCE_SECS: f32 = 30.0;

/// Poll cadence while the decode loop waits for the next window — well under
/// [`LIVE_DECODE_EVERY_SECS`], so a caught-up decoder still reacts promptly to `stop`.
const DECODE_POLL_INTERVAL: Duration = Duration::from_millis(50);

/// Cap on one honoured capture gap: a real idle stretch pads up to this much silence; a larger
/// jump is a corrupt offset and splices without padding (it must not snowball pad per chunk).
const MAX_GAP_SAMPLES: u64 = SAMPLE_RATE_HZ as u64 * 3600;

/// One silence block per `stop` check while honouring a gap, so a Stop lands within a block
/// instead of waiting out the whole pad.
const SILENCE_BLOCK_FRAMES: u64 = SAMPLE_RATE_HZ as u64;

/// Cadence of `TranscriptEvent::AudioLevel` while chunks flow — fast enough for a lively meter,
/// slow enough to stay negligible next to the ~200 ms capture chunks (ADR-056 Am. 13).
const LEVEL_EMIT_INTERVAL: Duration = Duration::from_millis(250);

/// A stop signal shared with the driver task; flip to `true` to wind down at the next chunk
/// boundary or mid-pad. A `Notify` pulses on `run()` exit, so callers `await` instead of polling.
#[derive(Debug, Clone, Default)]
pub struct StopSignal {
    stopped: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
    finished: Arc<tokio::sync::Notify>,
}

impl StopSignal {
    /// A new, un-tripped signal.
    pub fn new() -> Self {
        Self {
            stopped: Arc::new(AtomicBool::new(false)),
            paused: Arc::new(AtomicBool::new(false)),
            finished: Arc::new(tokio::sync::Notify::new()),
        }
    }

    /// Trip the signal.
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
    }

    /// `true` once `stop()` was called.
    pub fn is_stopped(&self) -> bool {
        self.stopped.load(Ordering::SeqCst)
    }

    /// Trip the signal as a pause: the driver ends the capture like a stop, but leaves the
    /// session `Paused` instead of handing it to the offline pass.
    pub fn pause(&self) {
        self.paused.store(true, Ordering::SeqCst);
        self.stop();
    }

    /// `true` once `pause()` was called.
    pub fn is_paused(&self) -> bool {
        self.paused.load(Ordering::SeqCst)
    }

    /// The driver host calls this once `run()` has exited, releasing any
    /// `await_finished()` waiters. Idempotent — wakes everyone permitted.
    pub fn signal_finished(&self) {
        self.finished.notify_waiters();
    }

    /// Resolves once `signal_finished()` is called. Callers should add a
    /// timeout (`tokio::time::timeout`) so a wedged driver can't hang them.
    pub async fn await_finished(&self) {
        self.finished.notified().await;
    }

    /// `true` when both handles belong to the same signal instance — registry
    /// cleanups must only remove their own entry (session ids recur on resume).
    pub fn same_as(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.stopped, &other.stopped)
    }
}

/// Driver errors.
#[derive(Debug, thiserror::Error)]
pub enum DriverError {
    /// Capture failed.
    #[error("audio capture failed: {0}")]
    Capture(String),
    /// Transcription failed.
    #[error("transcription failed: {0}")]
    Transcribe(String),
    /// WAV writer failed.
    #[error("audio write failed: {0}")]
    AudioWrite(String),
    /// Store mutator failed.
    #[error("transcript store failed: {0}")]
    Store(String),
    /// The session was deleted while the offline pass ran.
    #[error("transcript session was deleted")]
    Deleted,
    /// The user put the offline pass off, or a newer pass replaced it.
    #[error("the offline pass was put off or replaced")]
    Superseded,
}

/// Driver construction config (keeps `new()` under clippy's 7-arg cap).
pub struct DriverConfig {
    /// Session id (must already exist in the store).
    pub id: Uuid,
    /// The session store.
    pub store: Arc<TranscriptStore>,
    /// The capture stream.
    pub audio: Box<dyn AudioStream>,
    /// Whisper transcriber (one per recording), or `None` for a record-only session — the live
    /// pass is skipped entirely and the transcript comes from the offline pass (ADR-056 Am. 13).
    pub transcriber: Option<Box<dyn Transcriber>>,
    /// Forced language + word-timestamps toggle.
    pub transcribe_opts: TranscribeOptions,
    /// Shared stop flag.
    pub stop: StopSignal,
    /// Offset added to committed segment times — the total duration of earlier
    /// audio parts when resuming a session (`ZERO` for a fresh recording).
    pub time_base: Duration,
}

/// Per-channel commit bookkeeping for the live pass: one lane for mono captures, two (system +
/// mic) for paired captures — each channel is decoded separately (Amendment 9).
struct Lane {
    /// Channel tag stamped on this lane's segments (`None` = single-channel).
    source: Option<TranscriptSource>,
    /// End of the last committed live segment; the live view is append-only.
    published_until: Duration,
    /// Text of the last committed segment — a wordless jittered re-decode
    /// repeating it verbatim at the horizon is a duplicate, not new speech.
    last_committed_text: String,
}

/// Channel→source tagging shared by the live and offline passes: a stereo
/// capture is [system, mic]; anything else stays untagged.
fn lane_sources(channel_count: usize) -> Vec<Option<TranscriptSource>> {
    match channel_count {
        2 => vec![Some(TranscriptSource::System), Some(TranscriptSource::Mic)],
        n => vec![None; n],
    }
}

impl Lane {
    fn new(source: Option<TranscriptSource>) -> Self {
        Self {
            source,
            published_until: Duration::ZERO,
            last_committed_text: String::new(),
        }
    }
}

/// One lane's bounded ring of recent PCM, addressed by absolute sample index: the live pass
/// reads only a trailing window, so older audio drops (the offline pass re-reads the WAV).
struct LaneRing {
    buf: VecDeque<f32>,
    /// Absolute index of `buf.front()`; kept equal to `filled - buf.len()`.
    base: u64,
    /// Absolute index one past the newest sample appended.
    filled: u64,
    capacity: usize,
}

impl LaneRing {
    fn new(capacity: usize) -> Self {
        let capacity = capacity.max(1);
        Self {
            buf: VecDeque::with_capacity(capacity),
            base: 0,
            filled: 0,
            capacity,
        }
    }

    /// Appends `samples`, dropping the oldest audio once past `capacity`.
    fn push(&mut self, samples: &[f32]) {
        self.buf.extend(samples.iter().copied());
        self.filled += samples.len() as u64;
        self.trim();
    }

    /// Appends `count` silent samples for an honoured capture gap. Only the trailing `capacity`
    /// of a long gap is materialised; the rest just advances the head.
    fn push_silence(&mut self, count: u64) {
        if count == 0 {
            return;
        }
        let keep = count.min(self.capacity as u64) as usize;
        self.buf.extend((0..keep).map(|_| 0.0));
        self.filled += count;
        self.trim();
    }

    fn trim(&mut self) {
        let over = self.buf.len().saturating_sub(self.capacity);
        if over > 0 {
            self.buf.drain(..over);
        }
        self.base = self.filled - self.buf.len() as u64;
    }

    /// The up-to-`want`-long window ending at absolute index `end`, plus its absolute start.
    /// Empty when `end` sits at or behind the oldest sample still held.
    fn window_ending_at(&self, end: u64, want: usize) -> (u64, Vec<f32>) {
        let end = end.min(self.filled);
        if end <= self.base {
            return (end, Vec::new());
        }
        let start = end.saturating_sub(want as u64).max(self.base);
        let from = (start - self.base) as usize;
        let to = (end - self.base) as usize;
        (start, self.buf.range(from..to).copied().collect())
    }
}

/// What the ingest thread publishes to the decode side. The ingest owns the WAV and the rings and
/// the decode side owns commit bookkeeping, so a slow transcriber can never stall capture.
struct Ingest {
    /// Per-channel rings; empty until the first chunk fixes the channel count.
    lanes: Vec<LaneRing>,
    /// Capture-health transitions not yet forwarded to the store.
    health: Vec<CaptureHealth>,
    /// Capture or WAV failure that ended the ingest.
    error: Option<DriverError>,
    /// Set once the ingest has stopped, for any reason.
    finished: bool,
}

impl Ingest {
    fn new() -> Self {
        Self {
            lanes: Vec::new(),
            health: Vec::new(),
            error: None,
            finished: false,
        }
    }

    /// Absolute index one past the newest sample any lane holds.
    fn head(&self) -> u64 {
        self.lanes.iter().map(|l| l.filled).max().unwrap_or(0)
    }
}

/// Locks the shared ingest state, recovering a poisoned mutex — a panicked peer thread must not
/// strand a recording that is otherwise fine (the join-side check still fails the session).
fn lock_ingest(shared: &Mutex<Ingest>) -> std::sync::MutexGuard<'_, Ingest> {
    shared.lock().unwrap_or_else(|poisoned| {
        static POISON_WARNED: std::sync::Once = std::sync::Once::new();
        POISON_WARNED.call_once(|| {
            log::warn!(target: "transcription::driver", "ingest state mutex poisoned by a panicked peer thread — recovering");
        });
        poisoned.into_inner()
    })
}

/// Ring size per lane: the live window plus the lag the live pass may absorb before it skips.
fn ring_capacity_samples() -> usize {
    ((LIVE_WINDOW_SECS + LIVE_LAG_TOLERANCE_SECS) * SAMPLE_RATE_HZ as f32) as usize
}

/// The absolute sample index a chunk offset lands on.
fn offset_to_samples(offset: Duration) -> u64 {
    (offset.as_nanos() as u64).saturating_mul(SAMPLE_RATE_HZ as u64) / 1_000_000_000
}

/// Everything the ingest loop shares with its driver: the rings, stop signal, WAV target,
/// and the store identity the loudness meter publishes under.
#[derive(Clone, Copy)]
struct IngestEnv<'a> {
    shared: &'a Mutex<Ingest>,
    stop: &'a StopSignal,
    wav_path: &'a Path,
    ring_capacity: usize,
    store: &'a Arc<TranscriptStore>,
    id: Uuid,
}

/// The ingest thread body: capture chunks → WAV + lane rings, until `stop` or end of stream. The
/// WAV is finalized here so the offline pass never reads a header that still claims zero samples.
fn run_ingest(
    mut audio: Box<dyn AudioStream>,
    shared: &Mutex<Ingest>,
    stop: &StopSignal,
    wav_path: &Path,
    ring_capacity: usize,
    store: &Arc<TranscriptStore>,
    id: Uuid,
) {
    let env = IngestEnv {
        shared,
        stop,
        wav_path,
        ring_capacity,
        store,
        id,
    };
    let mut wav: Option<WavWriter> = None;
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        ingest_loop(audio.as_mut(), &env, &mut wav)
    }))
    .unwrap_or_else(|p| {
        let msg = p
            .downcast_ref::<&str>()
            .map(|s| (*s).to_string())
            .or_else(|| p.downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "unknown panic".to_string());
        Err(DriverError::Capture(format!(
            "the capture thread panicked: {msg}"
        )))
    });
    let finalized = match wav {
        Some(w) => w.finalize(),
        None => Ok(()),
    };
    if let Err(e) = &finalized {
        log::warn!("failed to finalize the recorded WAV: {e}");
    }
    let mut g = lock_ingest(shared);
    g.finished = true;
    if let Err(e) = result.and(finalized) {
        g.error = Some(e);
    }
}
/// Pumps capture chunks into `wav` and the shared rings; each lands at the position its offset
/// declares, so an idle source leaves silence, and a `stop` mid-pad truncates that silence.
fn ingest_loop(
    audio: &mut dyn AudioStream,
    env: &IngestEnv<'_>,
    wav: &mut Option<WavWriter>,
) -> Result<(), DriverError> {
    let IngestEnv {
        shared,
        stop,
        wav_path,
        ring_capacity,
        store,
        id,
    } = *env;
    let mut written: u64 = 0;
    let mut last_level_emit: Option<std::time::Instant> = None;
    let mut corrupt_offset_reported = false;
    loop {
        if stop.is_stopped() {
            return Ok(());
        }
        let next = audio.next_chunk();
        let health = audio.take_health();
        if !health.is_empty() {
            lock_ingest(shared).health.extend(health);
        }
        let chunk = match next {
            Ok(Some(c)) => c,
            Ok(None) => return Ok(()),
            Err(e) => return Err(DriverError::Capture(e.to_string())),
        };
        if chunk.is_keepalive() {
            continue;
        }
        let channels = if chunk.mic.is_some() { 2 } else { 1 };
        {
            let mut g = lock_ingest(shared);
            if g.lanes.is_empty() {
                g.lanes = (0..channels)
                    .map(|_| LaneRing::new(ring_capacity))
                    .collect();
            } else if g.lanes.len() != channels {
                return Err(DriverError::Capture(format!(
                    "audio stream changed shape mid-recording: started with {} channel(s), got a chunk with {}",
                    g.lanes.len(),
                    channels,
                )));
            }
        }
        if let Some(mic) = &chunk.mic {
            if mic.len() != chunk.samples.len() {
                return Err(DriverError::Capture(format!(
                    "paired audio chunk is misaligned: {} system samples vs {} mic samples",
                    chunk.samples.len(),
                    mic.len(),
                )));
            }
        }
        let writer = match wav {
            Some(w) => w,
            None => wav.insert(WavWriter::create(wav_path, channels as u16)?),
        };
        let start = offset_to_samples(chunk.offset);
        let gap = start.saturating_sub(written);
        if gap > MAX_GAP_SAMPLES {
            if !corrupt_offset_reported {
                corrupt_offset_reported = true;
                log::error!(
                    "capture offset implies a {gap}-sample gap — spliced without padding; timestamps past this point shift"
                );
            }
        } else if gap > 0 {
            let had_frames = written > 0;
            let mut padded: u64 = 0;
            while padded < gap && !stop.is_stopped() {
                let block = SILENCE_BLOCK_FRAMES.min(gap - padded);
                writer.write_silence(block, channels as u16)?;
                padded += block;
            }
            written += padded;
            let mut g = lock_ingest(shared);
            for lane in g.lanes.iter_mut() {
                lane.push_silence(padded);
            }
            if padded < gap {
                log::warn!(
                    "stop cut a capture-gap pad short: padded {padded} of {gap} frames — the recording ends here"
                );
                if had_frames {
                    return Ok(());
                }
            }
            log::debug!(
                "padded {:.1}s of silence for a capture gap",
                padded as f32 / SAMPLE_RATE_HZ as f32
            );
        }
        let skip = written
            .saturating_sub(start)
            .min(chunk.samples.len() as u64) as usize;
        if skip >= chunk.samples.len() {
            continue;
        }
        let sys = &chunk.samples[skip..];
        match &chunk.mic {
            Some(mic) => writer.write_stereo(sys, &mic[skip..])?,
            None => writer.write(sys)?,
        }
        written += sys.len() as u64;
        {
            let mut g = lock_ingest(shared);
            if let Some(lane) = g.lanes.first_mut() {
                lane.push(sys);
            }
            if let (Some(mic), Some(lane)) = (&chunk.mic, g.lanes.get_mut(1)) {
                lane.push(&mic[skip..]);
            }
        }
        if last_level_emit.is_none_or(|t| t.elapsed() >= LEVEL_EMIT_INTERVAL) {
            last_level_emit = Some(std::time::Instant::now());
            let mut levels = vec![crate::transcription::audio::rms(sys)];
            if let Some(mic) = &chunk.mic {
                levels.push(crate::transcription::audio::rms(&mic[skip..]));
            }
            let _ = store.audio_level(id, levels);
        }
    }
}
/// Drives one recording. Owned by the background task.
pub struct TranscriptDriver {
    id: Uuid,
    store: Arc<TranscriptStore>,
    /// Handed to the ingest thread by `run()`.
    audio: Option<Box<dyn AudioStream>>,
    /// `None` = record-only: no live pass, transcript comes from the offline pass.
    transcriber: Option<Box<dyn Transcriber>>,
    transcribe_opts: TranscribeOptions,
    stop: StopSignal,
    /// Shared with the ingest thread: the recorded rings plus its health and error reports.
    ingest: Arc<Mutex<Ingest>>,
    /// Per-channel commit state; sized once the ingest reports the channel count.
    lanes: Vec<Lane>,
    /// Committed-segment time offset (total duration of earlier parts on resume).
    time_base: Duration,
    /// Seconds of captured audio the live pass has decoded up to.
    last_decode_at: f32,
    /// Draft (uncommitted tail) last published to the store.
    last_draft: String,
}

impl TranscriptDriver {
    /// Builds a driver. The caller spawns `run()` on a background task.
    pub fn new(cfg: DriverConfig) -> Self {
        Self {
            id: cfg.id,
            store: cfg.store,
            audio: Some(cfg.audio),
            transcriber: cfg.transcriber,
            transcribe_opts: cfg.transcribe_opts,
            stop: cfg.stop,
            ingest: Arc::new(Mutex::new(Ingest::new())),
            lanes: Vec::new(),
            time_base: cfg.time_base,
            last_decode_at: 0.0,
            last_draft: String::new(),
        }
    }

    /// Runs the driver to completion (until the stream ends or `stop` trips), writing a WAV at
    /// `audio_wav_path`. On error the session flips to `Failed{reason}` and the WAV is closed.
    pub fn run(mut self, audio_wav_path: &Path) -> Result<(), DriverError> {
        let _ = self.store.set_status(self.id, TranscriptStatus::Recording);
        let Some(audio) = self.audio.take() else {
            return Err(DriverError::Capture(
                "driver started without a capture stream".to_string(),
            ));
        };
        let shared = Arc::clone(&self.ingest);
        let stop = self.stop.clone();
        let wav_path = audio_wav_path.to_path_buf();
        let capacity = ring_capacity_samples();
        let ingest = std::thread::Builder::new()
            .name("transcript-ingest".to_string())
            .spawn({
                let store = Arc::clone(&self.store);
                let id = self.id;
                move || run_ingest(audio, &shared, &stop, &wav_path, capacity, &store, id)
            })
            .map_err(|e| DriverError::Capture(format!("spawn ingest thread: {e}")))?;

        let result = self.decode_loop();
        self.stop.stop();
        let joined = ingest.join();
        {
            let health = std::mem::take(&mut lock_ingest(&self.ingest).health);
            self.forward_health(health);
        }
        let result = result.and_then(|()| {
            if joined.is_err() {
                return Err(DriverError::Capture(
                    "the capture thread panicked".to_string(),
                ));
            }
            match lock_ingest(&self.ingest).error.take() {
                Some(e) => Err(e),
                None => Ok(()),
            }
        });

        match result {
            Ok(()) => {
                if self.transcriber.is_some() {
                    let _ = self.decode_final_window();
                }
                let next = if self.stop.is_paused() {
                    let _ = self.store.live_draft(self.id, String::new());
                    TranscriptStatus::Paused
                } else {
                    TranscriptStatus::Finalizing { progress: 0.0 }
                };
                let _ = self.store.set_status(self.id, next);
                Ok(())
            }
            Err(e) => {
                let _ = self.store.live_draft(self.id, String::new());
                let _ = self.store.set_status(
                    self.id,
                    TranscriptStatus::Failed {
                        reason: e.to_string(),
                    },
                );
                Err(e)
            }
        }
    }

    /// Forwards queued capture-health transitions to the store. A store rejection must leave
    /// a trace — the warning would otherwise vanish without reaching the UI or the log.
    fn forward_health(&self, health: Vec<CaptureHealth>) {
        for t in health {
            let res = match t {
                CaptureHealth::Raised(w) => self.store.capture_warning(self.id, w),
                CaptureHealth::Cleared(w) => self.store.capture_warning_cleared(self.id, w),
            };
            if let Err(e) = res {
                log::warn!(
                    target: "transcription::driver",
                    "a capture-health event was dropped — the store rejected it: {e}"
                );
            }
        }
    }

    /// The live pass: decode the next window once the ingest has captured enough. `Ok` on end
    /// of stream or `stop`; `Err` on any failure (the caller flips the session to `Failed`).
    fn decode_loop(&mut self) -> Result<(), DriverError> {
        loop {
            if self.stop.is_stopped() {
                return Ok(());
            }
            let (head, lane_count, finished, error, health) = {
                let mut g = lock_ingest(&self.ingest);
                (
                    g.head(),
                    g.lanes.len(),
                    g.finished,
                    g.error.take(),
                    std::mem::take(&mut g.health),
                )
            };
            self.forward_health(health);
            if let Some(e) = error {
                return Err(e);
            }
            if lane_count == 0 || self.transcriber.is_none() {
                if finished {
                    return Ok(());
                }
                std::thread::sleep(DECODE_POLL_INTERVAL);
                continue;
            }
            let head_secs = head as f32 / SAMPLE_RATE_HZ as f32;
            let due = self.last_decode_at + LIVE_DECODE_EVERY_SECS;
            if head_secs >= due {
                self.decode_window_ending(due, false)?;
            } else if finished {
                if head_secs > self.last_decode_at {
                    self.decode_window_ending(head_secs, false)?;
                }
                return Ok(());
            } else {
                std::thread::sleep(DECODE_POLL_INTERVAL);
            }
        }
    }

    /// Decodes the newest window with the flush semantics the wind-down needs: the held-back
    /// tails commit, because nothing after this pass will confirm them.
    fn decode_final_window(&mut self) -> Result<(), DriverError> {
        let head = lock_ingest(&self.ingest).head();
        self.decode_window_ending(head as f32 / SAMPLE_RATE_HZ as f32, true)
    }

    /// Re-decodes the [`LIVE_WINDOW_SECS`] ending at `end_secs` per lane, committing only past
    /// [`LIVE_COMMIT_HOLDBACK`] (the unstable tail streams as a replace-only draft instead).
    fn decode_window_ending(&mut self, end_secs: f32, flush: bool) -> Result<(), DriverError> {
        let want = (LIVE_WINDOW_SECS * SAMPLE_RATE_HZ as f32) as usize;
        let requested = (end_secs.max(0.0) * SAMPLE_RATE_HZ as f32) as u64;
        let (windows, end) = {
            let g = lock_ingest(&self.ingest);
            let head = g.head();
            let oldest = g.lanes.iter().map(|l| l.base).max().unwrap_or(0);
            let mut end = requested.min(head);
            if end <= oldest && head > oldest {
                end = head;
            }
            let windows: Vec<(u64, Vec<f32>)> = g
                .lanes
                .iter()
                .map(|l| l.window_ending_at(end, want))
                .collect();
            (windows, end)
        };
        if end > requested {
            log::warn!(
                "live transcription fell {:.0}s behind capture — skipping ahead; the recording keeps every sample and the offline pass covers the gap",
                (end - requested) as f32 / SAMPLE_RATE_HZ as f32
            );
        }
        self.last_decode_at = end as f32 / SAMPLE_RATE_HZ as f32;
        if windows.iter().all(|(_, w)| w.is_empty()) {
            return Ok(());
        }
        if self.lanes.len() != windows.len() {
            self.lanes = lane_sources(windows.len())
                .into_iter()
                .map(Lane::new)
                .collect();
        }
        let horizon =
            Duration::from_secs_f32(self.last_decode_at).saturating_sub(LIVE_COMMIT_HOLDBACK);

        let mut batch = Vec::new();
        let mut drafts = Vec::new();
        for (lane_idx, (win_start, window)) in windows.iter().enumerate() {
            let source = self.lanes[lane_idx].source;
            let window_start = Duration::from_secs_f32(*win_start as f32 / SAMPLE_RATE_HZ as f32);
            let (mut lane_batch, draft) =
                self.decode_lane_window(lane_idx, window, window_start, flush, horizon)?;
            batch.append(&mut lane_batch);
            if !draft.is_empty() {
                drafts.push(match source {
                    Some(src) => format!("{}: {draft}", src.label()),
                    None => draft,
                });
            }
        }
        batch.sort_by_key(|s| s.start);
        for s in &mut batch {
            s.start += self.time_base;
            s.end += self.time_base;
        }
        let draft = drafts.join("\n");
        if !batch.is_empty() {
            self.store
                .append_segments(self.id, batch)
                .map_err(|e| DriverError::Store(e.to_string()))?;
        }
        if draft != self.last_draft {
            self.store
                .live_draft(self.id, draft.clone())
                .map_err(|e| DriverError::Store(e.to_string()))?;
            self.last_draft = draft;
        }
        Ok(())
    }

    /// One lane's window decode; returns its ripe commits and its draft tail. `window_start` is the
    /// absolute position of `window[0]`, so segment times land on the session timeline.
    fn decode_lane_window(
        &mut self,
        lane_idx: usize,
        window: &[f32],
        window_start: Duration,
        flush: bool,
        horizon: Duration,
    ) -> Result<(Vec<Segment>, String), DriverError> {
        if window.is_empty() {
            return Ok((Vec::new(), String::new()));
        }
        let source = self.lanes[lane_idx].source;
        let Some(transcriber) = self.transcriber.as_mut() else {
            return Err(DriverError::Transcribe(
                "decode reached on a record-only session (driver bug)".to_string(),
            ));
        };
        let segs = transcriber
            .feed(window, &self.transcribe_opts)
            .map_err(|e| DriverError::Transcribe(e.to_string()))?;
        let absolute: Vec<Segment> = segs
            .into_iter()
            .map(|s| Segment {
                start: window_start + s.start,
                end: window_start + s.end,
                text: s.text,
                words: s.words,
                source,
                speaker_id: None,
            })
            .collect();

        let lane = &mut self.lanes[lane_idx];
        let mut lane_batch = Vec::new();
        let mut draft = String::new();
        for seg in uncommitted(&absolute, lane.published_until) {
            if flush || seg.end <= horizon {
                let Some(seg) = trim_committed_overlap(seg, lane.published_until) else {
                    continue;
                };
                if seg.words.is_empty()
                    && seg.start <= lane.published_until + BOUNDARY_JITTER
                    && seg.text == lane.last_committed_text
                {
                    lane.published_until = lane.published_until.max(seg.end);
                    continue;
                }
                lane.published_until = seg.end;
                lane.last_committed_text = seg.text.clone();
                lane_batch.push(seg);
            } else {
                let Some(seg) = trim_committed_overlap(seg, lane.published_until) else {
                    continue;
                };
                if !draft.is_empty() {
                    draft.push(' ');
                }
                draft.push_str(&seg.text);
            }
        }
        Ok((lane_batch, draft))
    }
}

/// Clamps a jittered segment's `start` to `published_until`, dropping any leading words already
/// shown; returns `None` when it's a pure re-narration of already-committed audio.
fn trim_committed_overlap(mut seg: Segment, published_until: Duration) -> Option<Segment> {
    if seg.start >= published_until {
        return Some(seg);
    }
    if seg.end <= published_until {
        return None;
    }
    if !seg.words.is_empty() {
        seg.words.retain(|w| w.end > published_until);
        seg.text = seg
            .words
            .iter()
            .map(|w| w.text.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        if seg.text.is_empty() {
            return None;
        }
    }
    seg.start = published_until;
    Some(seg)
}

/// A live segment is published once it is at least this much older than the
/// newest captured audio; anything younger may still be re-segmented.
const LIVE_COMMIT_HOLDBACK: Duration = Duration::from_secs(5);

/// Boundary jitter tolerated at the committed edge — window re-decodes shift
/// segment starts slightly between passes.
const BOUNDARY_JITTER: Duration = Duration::from_secs(1);

/// Segments not yet committed: those starting at/past the committed horizon
/// (within [`BOUNDARY_JITTER`]); merged re-decodes of committed audio are out.
fn uncommitted(segs: &[Segment], published_until: Duration) -> Vec<Segment> {
    segs.iter()
        .filter(|s| s.start + BOUNDARY_JITTER >= published_until)
        .cloned()
        .collect()
}

/// Inputs for the offline finalize pass — built by the caller (Tauri layer)
/// after `stop_transcription`, once it has loaded the higher-quality model.
pub struct FinalizeConfig {
    /// Session id (must already be in the store, in `Finalizing` state).
    pub id: Uuid,
    /// The session store.
    pub store: Arc<TranscriptStore>,
    /// Recorded audio parts in order (`audio.wav`, then `audio-N.wav` from
    /// resumes). `run_finalize` fails when none carries samples.
    pub audio_paths: Vec<std::path::PathBuf>,
    /// Higher-quality transcriber (e.g. `large-v3`).
    pub transcriber: Box<dyn Transcriber>,
    /// Forced language + word-timestamps toggle.
    pub transcribe_opts: TranscribeOptions,
    /// This pass's claim on the session ([`TranscriptStore::begin_offline_pass`]).
    pub pass: OfflinePass,
    /// Loads the speaker diarizer of the meeting channel (ADR-098) once Whisper is done and
    /// released; `None` leaves the transcript without speaker labels.
    pub diarizer: Option<DiarizerLoader>,
}

/// Offline-pass decode window (seconds); transcribed per-window so the progress bar can move.
/// A short overlap (below) keeps utterances that straddle a boundary intact.
const FINALIZE_WINDOW_SECS: f32 = 30.0;

/// Overlap (seconds) between consecutive offline-pass windows. Segments starting inside the
/// *next* window's overlap are dropped from the previous window's output to avoid duplicates.
const FINALIZE_WINDOW_OVERLAP_SECS: f32 = 3.0;

const FINALIZE_DECODE_START_PROGRESS: f32 = 0.05;
const FINALIZE_DECODE_DONE_PROGRESS: f32 = 0.60;
const FINALIZE_DIARIZE_START_PROGRESS: f32 = 0.62;
const FINALIZE_DIARIZE_DONE_PROGRESS: f32 = 0.85;
const FINALIZE_RESULT_PROGRESS: f32 = 0.9;

/// Runs the offline pass: transcribes the recorded WAV, diarizes the meeting channel when a loader
/// is given (a failure there only warns), installs `final_segments` and marks `Done`; a cancelled
/// `pass` writes nothing more and returns [`DriverError::Superseded`] or [`DriverError::Deleted`].
pub fn run_finalize(cfg: FinalizeConfig) -> Result<(), DriverError> {
    let FinalizeConfig {
        id,
        store,
        audio_paths,
        mut transcriber,
        mut transcribe_opts,
        pass,
        diarizer,
    } = cfg;
    transcribe_opts.cancel = Some(pass.decode_cancel());

    let fail = |store: &TranscriptStore, reason: String| -> DriverError {
        store
            .fail_pass(id, &pass, reason.clone())
            .err()
            .and_then(|e| pass_stopped(&e))
            .unwrap_or(DriverError::Transcribe(reason))
    };
    if let Err(StoreError::NotFound(_)) = store.get(id) {
        return Err(DriverError::Deleted);
    }
    if pass.cancelled() {
        return Err(DriverError::Superseded);
    }

    const NO_AUDIO: &str =
        "no audio was captured — check that audio was playing and that microphone / \
         system-audio recording permission is granted";

    struct PartPlan<'a> {
        path: &'a Path,
        part_base: Duration,
        /// Frames of the part: the samples of one channel.
        frames: u64,
        /// Frames × channels — this part's share of the progress band.
        samples: u64,
        channels: usize,
    }
    let mut plans: Vec<PartPlan> = Vec::new();
    let mut part_base = Duration::ZERO;
    let mut skipped = 0usize;
    let mut first_read_error: Option<String> = None;
    for path in &audio_paths {
        let reason = match hound::WavReader::open(path) {
            Ok(reader) => {
                let spec = reader.spec();
                let frames = u64::from(reader.duration());
                if spec.sample_rate > 0 && frames > 0 {
                    plans.push(PartPlan {
                        path,
                        part_base,
                        frames,
                        samples: frames * u64::from(spec.channels.max(1)),
                        channels: usize::from(spec.channels),
                    });
                    part_base +=
                        Duration::from_secs_f64(frames as f64 / f64::from(spec.sample_rate));
                    continue;
                }
                "carries no samples".to_string()
            }
            Err(e) => {
                let header_only = std::fs::metadata(path)
                    .map(|m| m.len() <= 44)
                    .unwrap_or(false);
                if !path.exists() {
                    "was never recorded".to_string()
                } else if header_only {
                    "carries no samples".to_string()
                } else {
                    first_read_error.get_or_insert_with(|| format!("read audio: {e}"));
                    format!("is unreadable: {e}")
                }
            }
        };
        skipped += 1;
        log::warn!(
            "transcript {id} audio part {} {reason} — skipping it in the offline pass",
            path.display()
        );
    }
    if plans.is_empty() {
        return Err(fail(
            &store,
            first_read_error.unwrap_or_else(|| NO_AUDIO.to_string()),
        ));
    }
    let mut part_missing_warned = skipped > 0;
    if part_missing_warned {
        let _ = store.capture_warning(
            id,
            crate::transcription::audio::CaptureWarning::RecordingPartMissing,
        );
    }

    let report = |progress: f32| match store.finalize_progress(id, &pass, progress) {
        Err(e) => pass_stopped(&e).map_or(Ok(()), Err),
        Ok(_) => Ok(()),
    };
    report(FINALIZE_DECODE_START_PROGRESS)?;
    let total_samples: u64 = plans.iter().map(|p| p.samples).sum();
    let mut final_segs: Vec<Segment> = Vec::new();
    let mut meeting_parts: Vec<&PartPlan> = Vec::new();
    let mut done_samples: u64 = 0;
    let mut loaded_any = false;
    for plan in &plans {
        let channels = match super::audio::parse_wav_to_channels_f32(plan.path) {
            Ok((chs, _rate)) => chs,
            Err(e) => {
                log::warn!(
                    "transcript {id} audio part {} is unreadable: {e} — skipping it in the offline pass",
                    plan.path.display()
                );
                first_read_error.get_or_insert_with(|| format!("read audio: {e}"));
                if !part_missing_warned {
                    part_missing_warned = true;
                    let _ = store.capture_warning(
                        id,
                        crate::transcription::audio::CaptureWarning::RecordingPartMissing,
                    );
                }
                done_samples += plan.samples;
                continue;
            }
        };
        let sources = lane_sources(channels.len());
        for (source, pcm) in sources
            .iter()
            .copied()
            .zip(channels.iter().map(Vec::as_slice))
        {
            let lane_share = pcm.len() as f32 / total_samples.max(1) as f32;
            let done_frac = done_samples as f32 / total_samples.max(1) as f32;
            let segs = match transcribe_chunked(
                transcriber.as_mut(),
                pcm,
                &transcribe_opts,
                source,
                |frac| {
                    report(
                        FINALIZE_DECODE_START_PROGRESS
                            + (FINALIZE_DECODE_DONE_PROGRESS - FINALIZE_DECODE_START_PROGRESS)
                                * (done_frac + frac * lane_share),
                    )
                },
            ) {
                Ok(s) => s,
                Err(e @ (DriverError::Deleted | DriverError::Superseded)) => return Err(e),
                Err(_) if pass.cancelled() => return Err(stopped_pass_error(&store, id)),
                Err(e) => return Err(fail(&store, format!("offline transcribe: {e}"))),
            };
            final_segs.extend(segs.into_iter().map(|mut s| {
                s.start += plan.part_base;
                s.end += plan.part_base;
                s
            }));
            done_samples += pcm.len() as u64;
        }
        if sources.first() == Some(&Some(TranscriptSource::System)) {
            meeting_parts.push(plan);
        }
        loaded_any = true;
    }
    if !loaded_any {
        return Err(fail(
            &store,
            first_read_error.unwrap_or_else(|| NO_AUDIO.to_string()),
        ));
    }
    report(FINALIZE_DECODE_DONE_PROGRESS)?;
    final_segs.sort_by_key(|s| s.start);

    drop(transcriber);
    let meeting_speech = final_segs
        .iter()
        .any(|s| s.source == Some(TranscriptSource::System));
    let read_meeting_channel = || -> Result<Vec<f32>, DiarizeError> {
        let end = meeting_parts
            .iter()
            .map(|p| system_pcm_end(p.part_base, p.frames, p.channels))
            .max()
            .unwrap_or(0);
        let mut system_pcm = Vec::with_capacity(usize::try_from(end).unwrap_or(usize::MAX));
        for part in &meeting_parts {
            if pass.cancelled() {
                return Err(DiarizeError::Inference(
                    "cancelled while reading the meeting channel".to_string(),
                ));
            }
            system_pcm.resize(frame_at(part.part_base), 0.0);
            let frames = super::audio::append_wav_channel_f32(part.path, 0, &mut system_pcm)
                .map_err(|e| DiarizeError::InvalidAudio(e.to_string()))?;
            if frames as u64 != part.frames {
                return Err(DiarizeError::InvalidAudio(format!(
                    "{} holds {frames} frames, not the {} the transcription read",
                    part.path.display(),
                    part.frames
                )));
            }
        }
        Ok(system_pcm)
    };
    let diarization = match diarizer.filter(|_| meeting_speech) {
        Some(load) => diarize_meeting_channel(
            &store,
            id,
            &pass,
            load,
            read_meeting_channel,
            &mut final_segs,
            &report,
        )?,
        None => None,
    };
    report(FINALIZE_RESULT_PROGRESS)?;

    if let Err(e) = store.set_final_segments(id, &pass, final_segs, diarization) {
        return Err(pass_stopped(&e)
            .unwrap_or_else(|| fail(&store, format!("install final segments: {e}"))));
    }

    store
        .finish(id, &pass)
        .map_err(|e| pass_stopped(&e).unwrap_or_else(|| DriverError::Store(e.to_string())))?;
    Ok(())
}

fn diarize_meeting_channel(
    store: &TranscriptStore,
    id: Uuid,
    pass: &OfflinePass,
    load: DiarizerLoader,
    read_meeting_channel: impl FnOnce() -> Result<Vec<f32>, DiarizeError>,
    final_segs: &mut [Segment],
    report: &dyn Fn(f32) -> Result<(), DriverError>,
) -> Result<Option<DiarizationRecord>, DriverError> {
    report(FINALIZE_DIARIZE_START_PROGRESS)?;
    let started = Instant::now();
    let result = load().and_then(|mut diarizer| {
        let system_pcm = read_meeting_channel()?;
        diarizer.diarize(&system_pcm, &pass.decode_cancel())
    });
    if pass.cancelled() {
        return Err(stopped_pass_error(store, id));
    }
    let record = match result {
        Ok(turns) => {
            label_speakers(final_segs, &turns);
            let secs = started.elapsed().as_secs_f64();
            let speakers = final_segs
                .iter()
                .filter_map(|seg| seg.speaker_id)
                .max()
                .unwrap_or(0);
            log::info!(
                "speaker diarization of transcript {id} labelled {speakers} speakers from {} turns in {secs:.1} s",
                turns.len()
            );
            Some(DiarizationRecord {
                model: DIARIZATION_MODEL.key.to_string(),
                secs,
            })
        }
        Err(e) => {
            let warning = match e {
                DiarizeError::ModelMissing(_) => CaptureWarning::SpeakerModelMissing,
                _ => CaptureWarning::SpeakerAttributionFailed,
            };
            log::warn!(
                "speaker diarization of transcript {id} did not run to the end: {e}; the transcript keeps no speaker labels"
            );
            if let Err(e) = store.capture_warning(id, warning) {
                log::warn!("transcript {id} could not record its speaker warning: {e}");
            }
            None
        }
    };
    report(FINALIZE_DIARIZE_DONE_PROGRESS)?;
    Ok(record)
}

fn stopped_pass_error(store: &TranscriptStore, id: Uuid) -> DriverError {
    match store.get(id) {
        Err(e) => pass_stopped(&e).unwrap_or(DriverError::Superseded),
        Ok(_) => DriverError::Superseded,
    }
}

fn system_pcm_end(part_base: Duration, frames: u64, channels: usize) -> u64 {
    if lane_sources(channels).first() == Some(&Some(TranscriptSource::System)) {
        frame_at(part_base) as u64 + frames
    } else {
        0
    }
}

fn frame_at(offset: Duration) -> usize {
    (offset.as_secs_f64() * f64::from(SAMPLE_RATE_HZ)).round() as usize
}

/// How a refused offline-pass write ends the pass: `Deleted` for a deleted session, `Superseded`
/// for a claim that was put off or replaced; `None` for a real store failure.
fn pass_stopped(e: &StoreError) -> Option<DriverError> {
    match e {
        StoreError::NotFound(_) => Some(DriverError::Deleted),
        StoreError::PassEnded(_) => Some(DriverError::Superseded),
        _ => None,
    }
}

/// Transcribes `pcm` in `FINALIZE_WINDOW_SECS` windows with `FINALIZE_WINDOW_OVERLAP_SECS`
/// overlap, stitched to one absolute list tagged `source`; `progress` fires 0.0→1.0/window,
/// and an error it returns stops the decode before the next window.
fn transcribe_chunked(
    transcriber: &mut dyn Transcriber,
    pcm: &[f32],
    opts: &TranscribeOptions,
    source: Option<TranscriptSource>,
    mut progress: impl FnMut(f32) -> Result<(), DriverError>,
) -> Result<Vec<Segment>, DriverError> {
    let rate = SAMPLE_RATE_HZ as usize;
    let win = (FINALIZE_WINDOW_SECS * SAMPLE_RATE_HZ as f32) as usize;
    let overlap = (FINALIZE_WINDOW_OVERLAP_SECS * SAMPLE_RATE_HZ as f32) as usize;
    let step = win.saturating_sub(overlap).max(1);
    let total = pcm.len();

    if total <= win {
        let mut segs = transcriber
            .transcribe(pcm, opts)
            .map_err(|e| DriverError::Transcribe(e.to_string()))?;
        for s in &mut segs {
            s.source = source;
        }
        progress(1.0)?;
        return Ok(segs);
    }

    let mut out: Vec<Segment> = Vec::new();
    let mut start = 0usize;
    while start < total {
        let end = (start + win).min(total);
        let is_last = end >= total;
        let window = &pcm[start..end];
        let window_start = Duration::from_secs_f64(start as f64 / rate as f64);
        let keep_until = if is_last {
            Duration::from_secs_f64(window.len() as f64 / rate as f64)
        } else {
            Duration::from_secs_f64(step as f64 / rate as f64)
        };

        let segs = transcriber
            .transcribe(window, opts)
            .map_err(|e| DriverError::Transcribe(e.to_string()))?;
        for s in segs {
            if s.start >= keep_until {
                continue;
            }
            out.push(Segment {
                start: window_start + s.start,
                end: window_start + s.end,
                text: s.text,
                words: s.words,
                source,
                speaker_id: None,
            });
        }
        progress((end as f32 / total as f32).min(1.0))?;
        if is_last {
            break;
        }
        start += step;
    }
    Ok(out)
}

/// Tiny `hound`-backed WAV writer (16 kHz int16; mono, or stereo with
/// channel 0 = system / channel 1 = mic). The driver receives `f32` and quantises.
struct WavWriter {
    inner: hound::WavWriter<std::io::BufWriter<std::fs::File>>,
}

impl WavWriter {
    fn create(path: &Path, channels: u16) -> Result<Self, DriverError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| DriverError::AudioWrite(e.to_string()))?;
        }
        let spec = hound::WavSpec {
            channels,
            sample_rate: SAMPLE_RATE_HZ,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let inner = hound::WavWriter::create(path, spec)
            .map_err(|e| DriverError::AudioWrite(e.to_string()))?;
        Ok(Self { inner })
    }

    fn write(&mut self, samples: &[f32]) -> Result<(), DriverError> {
        for s in samples {
            let v = (s.clamp(-1.0, 1.0) * 32_767.0) as i16;
            self.inner
                .write_sample(v)
                .map_err(|e| DriverError::AudioWrite(e.to_string()))?;
        }
        Ok(())
    }

    /// Writes one interleaved stereo frame per index (missing samples pad as 0).
    fn write_stereo(&mut self, sys: &[f32], mic: &[f32]) -> Result<(), DriverError> {
        for i in 0..sys.len().max(mic.len()) {
            for side in [sys.get(i), mic.get(i)] {
                let v = (side.copied().unwrap_or(0.0).clamp(-1.0, 1.0) * 32_767.0) as i16;
                self.inner
                    .write_sample(v)
                    .map_err(|e| DriverError::AudioWrite(e.to_string()))?;
            }
        }
        Ok(())
    }

    /// Writes `frames` silent frames across `channels` — an honoured capture gap, so the file
    /// length keeps matching wall-clock time unless a stop cuts the pad short.
    fn write_silence(&mut self, frames: u64, channels: u16) -> Result<(), DriverError> {
        let samples = frames.saturating_mul(u64::from(channels.max(1)));
        for _ in 0..samples {
            self.inner
                .write_sample(0i16)
                .map_err(|e| DriverError::AudioWrite(e.to_string()))?;
        }
        Ok(())
    }

    fn finalize(self) -> Result<(), DriverError> {
        self.inner
            .finalize()
            .map_err(|e| DriverError::AudioWrite(e.to_string()))
    }
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "test code: unwrap/expect on fixtures is the sanctioned boundary"
)]
mod tests {
    use super::*;
    use crate::transcription::audio::{
        AudioCapture, AudioSource, AudioSourceInfo, CaptureError, FileAudioCapture,
    };
    use crate::transcription::transcriber::DecodeCancel;
    use crate::transcription::transcriber::{Language, MockTranscriber};
    use crate::transcription::transcript::TranscriptSession;
    use std::path::PathBuf;

    fn mk_session(store: &TranscriptStore, audio_path: &Path) -> Uuid {
        let s = crate::transcription::transcript::TranscriptSession::new(
            Language::Pl,
            AudioSourceInfo {
                source: AudioSource::SystemWide,
                label: "System".to_string(),
            },
            audio_path.to_path_buf(),
        );
        store.create(s).unwrap()
    }

    #[test]
    fn finalize_progress_bands_match_ts_mirror() {
        let pane = include_str!(
            "../../../../desktop/src/src/app/meeting-transcription/live-transcript/live-transcript.component.ts"
        );
        for (name, value) in [
            ("DECODE_START_PROGRESS", FINALIZE_DECODE_START_PROGRESS),
            ("DECODE_DONE_PROGRESS", FINALIZE_DECODE_DONE_PROGRESS),
            ("DIARIZE_START_PROGRESS", FINALIZE_DIARIZE_START_PROGRESS),
            ("DIARIZE_DONE_PROGRESS", FINALIZE_DIARIZE_DONE_PROGRESS),
        ] {
            let prefix = format!("const {name} = ");
            let line = pane
                .lines()
                .find(|l| l.starts_with(&prefix))
                .unwrap_or_else(|| panic!("live-transcript.component.ts must declare `{prefix}`"));
            let ts: f32 = line[prefix.len()..]
                .trim_end_matches(';')
                .parse()
                .unwrap_or_else(|e| {
                    panic!("{name} in live-transcript.component.ts is not a number: {e}")
                });
            assert!(
                (ts - value).abs() < 1e-6,
                "{name} is {ts} in live-transcript.component.ts and {value} in transcript_driver.rs"
            );
        }
    }

    #[test]
    fn run_finalize_reports_the_decode_done_band_exactly_between_the_lanes_and_the_result() {
        use crate::transcription::transcript_store::TranscriptEvent;
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let id = mk_session(&store, &store_dir.path().join("a.wav"));
        let _ = store.set_status(id, TranscriptStatus::Finalizing { progress: 0.0 });
        let wav = store_dir.path().join("stereo.wav");
        let mut w = hound::WavWriter::create(
            &wav,
            hound::WavSpec {
                channels: 2,
                sample_rate: 16_000,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            },
        )
        .unwrap();
        for i in 0..(70 * 16_000) {
            let v = (0.1
                * (2.0 * std::f32::consts::PI * 220.0 * i as f32 / 16_000.0).sin()
                * 32_767.0) as i16;
            w.write_sample(v).unwrap();
            w.write_sample(v).unwrap();
        }
        w.finalize().unwrap();
        let mut sub = store.subscribe(id).unwrap();

        run_finalize(FinalizeConfig {
            pass: store.claim_finalizing(id),
            id,
            store: store.clone(),
            audio_paths: vec![wav],
            transcriber: Box::new(MockTranscriber {
                seg_secs: 2.0,
                text_template: "f{n}".to_string(),
            }),
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
            diarizer: None,
        })
        .unwrap();

        let mut reported = Vec::new();
        while let Ok(event) = sub.events.try_recv() {
            if let TranscriptEvent::FinalizeProgress { progress, .. } = event {
                reported.push(progress);
            }
        }
        assert_eq!(reported.first(), Some(&FINALIZE_DECODE_START_PROGRESS));
        assert!(reported.windows(2).all(|w| w[0] <= w[1]), "{reported:?}");
        let done = reported
            .iter()
            .rposition(|p| p.to_bits() == FINALIZE_DECODE_DONE_PROGRESS.to_bits())
            .unwrap_or_else(|| panic!("no exact decode-done report in {reported:?}"));
        assert!(done > 2, "{reported:?}");
        assert_eq!(reported[done + 1..], [FINALIZE_RESULT_PROGRESS]);
    }

    #[test]
    fn forward_health_survives_a_store_rejection_and_keeps_the_store_usable() {
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let wav = store_dir.path().join("unused.wav");
        let known = mk_session(&store, &wav);
        let driver = TranscriptDriver::new(DriverConfig {
            id: Uuid::new_v4(),
            store: store.clone(),
            audio: Box::new(ScriptedChunkStream { chunks: vec![] }),
            transcriber: None,
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
            stop: StopSignal::new(),
            time_base: Duration::ZERO,
        });
        driver.forward_health(vec![
            CaptureHealth::Raised(crate::transcription::audio::CaptureWarning::AudioDropped),
            CaptureHealth::Cleared(crate::transcription::audio::CaptureWarning::AudioDropped),
        ]);
        assert!(store
            .capture_warning(
                known,
                crate::transcription::audio::CaptureWarning::AudioDropped
            )
            .is_ok());
    }

    /// Builds a fixture WAV of `secs` seconds of a quiet 220 Hz tone (16 kHz
    /// mono int16) and returns its path + the directory guard.
    fn make_fixture_wav(secs: f32) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("fixture.wav");
        let mut w = hound::WavWriter::create(
            &path,
            hound::WavSpec {
                channels: 1,
                sample_rate: 16_000,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            },
        )
        .unwrap();
        let n = (secs * 16_000.0) as usize;
        for i in 0..n {
            let v = (0.05
                * (2.0 * std::f32::consts::PI * 220.0 * i as f32 / 16_000.0).sin()
                * 32_767.0) as i16;
            w.write_sample(v).unwrap();
        }
        w.finalize().unwrap();
        (dir, path)
    }

    /// Wraps a test transcriber for the live slot (record-only tests pass `None` directly).
    fn live<T: Transcriber + 'static>(t: T) -> Option<Box<dyn Transcriber>> {
        Some(Box::new(t))
    }

    fn stream_from(path: &Path) -> Box<dyn AudioStream> {
        FileAudioCapture::for_file(path)
            .start(AudioSource::SystemWide)
            .unwrap()
    }

    #[test]
    fn happy_path_with_file_capture_mock_transcriber() {
        let (_fixture_guard, fixture) = make_fixture_wav(20.0);
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let id = mk_session(&store, &store_dir.path().join("ignored.wav"));

        let driver = TranscriptDriver::new(DriverConfig {
            id,
            store: store.clone(),
            audio: stream_from(&fixture),
            transcriber: live(MockTranscriber {
                seg_secs: 2.0,
                text_template: "s{n}".to_string(),
            }),
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
            stop: StopSignal::new(),
            time_base: Duration::ZERO,
        });
        let out_wav = store.session_dir(id).join("audio.wav");
        driver.run(&out_wav).unwrap();

        assert!(out_wav.is_file());
        let on_disk = hound::WavReader::open(&out_wav).unwrap();
        assert_eq!(on_disk.spec().sample_rate, 16_000);
        assert_eq!(on_disk.spec().channels, 1);
        let frames = on_disk.into_samples::<i16>().count();
        assert!(
            (frames as i32 - 20 * 16_000).abs() < 16_000 / 4,
            "expected ~20 s of frames, got {frames}"
        );

        let snap = store.get(id).unwrap();
        assert!(matches!(snap.status, TranscriptStatus::Finalizing { .. }));
        assert!(
            !snap.live_segments.is_empty(),
            "should have decoded *some* live segments"
        );
        assert!(snap.last_seq > 0);
    }

    #[test]
    fn a_paused_capture_leaves_the_session_paused_not_finalizing() {
        let (_fixture_guard, fixture) = make_fixture_wav(5.0);
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let id = mk_session(&store, &store_dir.path().join("ignored.wav"));
        let stop = StopSignal::new();
        stop.pause();
        assert!(stop.is_stopped(), "a pause ends the capture like a stop");
        assert!(stop.is_paused());

        let driver = TranscriptDriver::new(DriverConfig {
            id,
            store: store.clone(),
            audio: stream_from(&fixture),
            transcriber: None,
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
            stop,
            time_base: Duration::ZERO,
        });
        let out_wav = store.session_dir(id).join("audio.wav");
        driver.run(&out_wav).unwrap();

        let snap = store.get(id).unwrap();
        assert_eq!(snap.status, TranscriptStatus::Paused);
        assert!(snap.live_draft.is_empty());
    }

    #[test]
    fn a_plain_stop_is_not_a_pause() {
        let stop = StopSignal::new();
        stop.stop();
        assert!(stop.is_stopped());
        assert!(!stop.is_paused());
    }

    /// A paired (system+mic) stream: `secs` seconds in 200 ms chunks; system
    /// carries a tone, the mic a quieter one, so the channels are tellable apart.
    struct DualToneStream {
        pos: usize,
        total: usize,
    }
    impl DualToneStream {
        fn new(secs: f32) -> Self {
            Self {
                pos: 0,
                total: (secs * 16_000.0) as usize,
            }
        }
    }
    impl AudioStream for DualToneStream {
        fn next_chunk(
            &mut self,
        ) -> Result<Option<crate::transcription::audio::AudioChunk>, CaptureError> {
            if self.pos >= self.total {
                return Ok(None);
            }
            let n = 3200.min(self.total - self.pos);
            let offset = Duration::from_secs_f64(self.pos as f64 / 16_000.0);
            self.pos += n;
            Ok(Some(crate::transcription::audio::AudioChunk {
                samples: vec![0.5; n],
                mic: Some(vec![0.25; n]),
                offset,
            }))
        }
    }

    #[test]
    fn paired_capture_writes_stereo_and_tags_segments_per_channel() {
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let id = mk_session(&store, &store_dir.path().join("ignored.wav"));

        let driver = TranscriptDriver::new(DriverConfig {
            id,
            store: store.clone(),
            audio: Box::new(DualToneStream::new(12.0)),
            transcriber: live(MockTranscriber {
                seg_secs: 2.0,
                text_template: "s{n}".to_string(),
            }),
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
            stop: StopSignal::new(),
            time_base: Duration::ZERO,
        });
        let out_wav = store.session_dir(id).join("audio.wav");
        driver.run(&out_wav).unwrap();

        let mut on_disk = hound::WavReader::open(&out_wav).unwrap();
        assert_eq!(on_disk.spec().channels, 2);
        let first_frame: Vec<i16> = on_disk
            .samples::<i16>()
            .take(2)
            .map(|s| s.unwrap())
            .collect();
        assert!((first_frame[0] as f32 / 32_767.0 - 0.5).abs() < 0.01);
        assert!((first_frame[1] as f32 / 32_767.0 - 0.25).abs() < 0.01);

        let snap = store.get(id).unwrap();
        use crate::transcription::transcriber::TranscriptSource;
        let sources: Vec<_> = snap.live_segments.iter().map(|s| s.source).collect();
        assert!(sources.contains(&Some(TranscriptSource::System)));
        assert!(sources.contains(&Some(TranscriptSource::Mic)));
        assert!(!sources.contains(&None));
        for src in [Some(TranscriptSource::System), Some(TranscriptSource::Mic)] {
            let lane: Vec<_> = snap
                .live_segments
                .iter()
                .filter(|s| s.source == src)
                .collect();
            assert!(!lane.is_empty());
            assert!(lane
                .windows(2)
                .all(|w| w[0].end <= w[1].start + Duration::from_secs(1)));
        }
    }

    /// A stream whose chunks come from a canned script — for shape-violation tests.
    struct ScriptedChunkStream {
        chunks: Vec<crate::transcription::audio::AudioChunk>,
    }
    impl AudioStream for ScriptedChunkStream {
        fn next_chunk(
            &mut self,
        ) -> Result<Option<crate::transcription::audio::AudioChunk>, CaptureError> {
            if self.chunks.is_empty() {
                return Ok(None);
            }
            Ok(Some(self.chunks.remove(0)))
        }
    }

    fn chunk_at(
        ms: u64,
        samples: usize,
        mic: Option<usize>,
    ) -> crate::transcription::audio::AudioChunk {
        crate::transcription::audio::AudioChunk {
            samples: vec![0.1; samples],
            mic: mic.map(|n| vec![0.1; n]),
            offset: Duration::from_millis(ms),
        }
    }

    /// Offset in ms implying half the gap cap: comfortably inside the honoured-pad branch, so
    /// these tests keep testing padding rather than splicing if `MAX_GAP_SAMPLES` moves.
    fn half_gap_cap_ms() -> u64 {
        (MAX_GAP_SAMPLES / 2) * 1000 / SAMPLE_RATE_HZ as u64
    }

    fn run_driver_expecting_capture_error(
        chunks: Vec<crate::transcription::audio::AudioChunk>,
    ) -> (Arc<TranscriptStore>, Uuid, DriverError) {
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let id = mk_session(&store, &store_dir.path().join("ignored.wav"));
        let driver = TranscriptDriver::new(DriverConfig {
            id,
            store: store.clone(),
            audio: Box::new(ScriptedChunkStream { chunks }),
            transcriber: live(MockTranscriber::new()),
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
            stop: StopSignal::new(),
            time_base: Duration::ZERO,
        });
        let out_wav = store.session_dir(id).join("audio.wav");
        let err = driver.run(&out_wav).unwrap_err();
        (store, id, err)
    }

    #[test]
    fn a_mid_stream_mic_flip_aborts_with_a_capture_error() {
        let (store, id, err) = run_driver_expecting_capture_error(vec![
            chunk_at(0, 1600, None),
            chunk_at(100, 1600, Some(1600)),
        ]);
        assert!(matches!(err, DriverError::Capture(_)), "got {err:?}");
        assert!(err.to_string().contains("mid-recording"), "got: {err}");
        assert!(matches!(
            store.get(id).unwrap().status,
            TranscriptStatus::Failed { .. }
        ));

        let (_store, _id, err) = run_driver_expecting_capture_error(vec![
            chunk_at(0, 1600, Some(1600)),
            chunk_at(100, 1600, None),
        ]);
        assert!(matches!(err, DriverError::Capture(_)), "got {err:?}");
        assert!(err.to_string().contains("mid-recording"), "got: {err}");
    }

    #[test]
    fn a_misaligned_paired_chunk_aborts_with_a_capture_error() {
        let (store, id, err) = run_driver_expecting_capture_error(vec![
            chunk_at(0, 1600, Some(1600)),
            chunk_at(100, 1600, Some(800)),
        ]);
        assert!(matches!(err, DriverError::Capture(_)), "got {err:?}");
        assert!(err.to_string().contains("misaligned"), "got: {err}");
        assert!(matches!(
            store.get(id).unwrap().status,
            TranscriptStatus::Failed { .. }
        ));
    }

    /// One real chunk, then endless idle keepalives — a silent source that never ends its stream.
    struct KeepaliveStream {
        sent_real: bool,
        /// Signalled once, on the first keepalive pull; the real chunk is in the WAV by then.
        idle: Option<std::sync::mpsc::Sender<()>>,
    }
    impl AudioStream for KeepaliveStream {
        fn next_chunk(
            &mut self,
        ) -> Result<Option<crate::transcription::audio::AudioChunk>, CaptureError> {
            if !self.sent_real {
                self.sent_real = true;
                return Ok(Some(chunk_at(0, 1600, None)));
            }
            if let Some(idle) = self.idle.take() {
                let _ = idle.send(());
            }
            std::thread::sleep(Duration::from_millis(5));
            Ok(Some(crate::transcription::audio::AudioChunk::keepalive()))
        }
    }

    /// Trips `stop` once the fixture signals it reached the pull under test: a stop that lands any
    /// earlier ends the ingest before that pull ever runs.
    fn stop_when(reached: &std::sync::mpsc::Receiver<()>, stop: &StopSignal) {
        let handshake = reached.recv_timeout(Duration::from_secs(10));
        stop.stop();
        handshake.expect("the capture fixture never reached the pull the stop must land in");
    }

    #[test]
    fn stop_unwedges_an_idle_source_and_keepalives_leave_no_trace_in_the_wav() {
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let id = mk_session(&store, &store_dir.path().join("ignored.wav"));
        let stop = StopSignal::new();
        let (idle_tx, idle) = std::sync::mpsc::channel::<()>();
        let driver = TranscriptDriver::new(DriverConfig {
            id,
            store: store.clone(),
            audio: Box::new(KeepaliveStream {
                sent_real: false,
                idle: Some(idle_tx),
            }),
            transcriber: None,
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
            stop: stop.clone(),
            time_base: Duration::ZERO,
        });
        let out_wav = store.session_dir(id).join("audio.wav");
        let runner = std::thread::spawn({
            let out_wav = out_wav.clone();
            move || driver.run(&out_wav)
        });
        stop_when(&idle, &stop);
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !runner.is_finished() {
            assert!(
                std::time::Instant::now() < deadline,
                "driver.run() must return after stop despite an idle (keepalive-only) source"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        runner.join().unwrap().unwrap();
        let reader = hound::WavReader::open(&out_wav).unwrap();
        assert_eq!(reader.duration(), 1600);
    }

    /// Two chunks with a long declared gap between them; `stop` trips as the second is handed
    /// over, so ingest meets the pad with a Stop already pending.
    struct GapWithStopStream {
        chunks: Vec<crate::transcription::audio::AudioChunk>,
        stop: StopSignal,
    }
    impl AudioStream for GapWithStopStream {
        fn next_chunk(
            &mut self,
        ) -> Result<Option<crate::transcription::audio::AudioChunk>, CaptureError> {
            if self.chunks.is_empty() {
                return Ok(None);
            }
            let chunk = self.chunks.remove(0);
            if self.chunks.is_empty() {
                self.stop.stop();
            }
            Ok(Some(chunk))
        }
    }

    #[test]
    fn a_stop_pending_when_a_gap_pad_begins_writes_no_silence_at_all() {
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let id = mk_session(&store, &store_dir.path().join("ignored.wav"));
        let stop = StopSignal::new();
        let driver = TranscriptDriver::new(DriverConfig {
            id,
            store: store.clone(),
            audio: Box::new(GapWithStopStream {
                chunks: vec![
                    chunk_at(0, 3_200, None),
                    chunk_at(half_gap_cap_ms(), 3_200, None),
                ],
                stop: stop.clone(),
            }),
            transcriber: None,
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
            stop: stop.clone(),
            time_base: Duration::ZERO,
        });
        let out_wav = store.session_dir(id).join("audio.wav");
        let runner = std::thread::spawn({
            let out_wav = out_wav.clone();
            move || driver.run(&out_wav)
        });
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !runner.is_finished() {
            assert!(
                std::time::Instant::now() < deadline,
                "driver.run() must return without writing out the whole pad"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        runner.join().unwrap().unwrap();
        let reader = hound::WavReader::open(&out_wav).unwrap();
        assert_eq!(reader.duration(), 3_200);
        assert!(matches!(
            store.get(id).unwrap().status,
            TranscriptStatus::Finalizing { .. }
        ));
    }

    #[test]
    fn a_stop_pending_before_the_first_chunk_still_leaves_that_chunk_in_the_wav() {
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let id = mk_session(&store, &store_dir.path().join("ignored.wav"));
        let stop = StopSignal::new();
        let driver = TranscriptDriver::new(DriverConfig {
            id,
            store: store.clone(),
            audio: Box::new(GapWithStopStream {
                chunks: vec![chunk_at(half_gap_cap_ms(), 3_200, None)],
                stop: stop.clone(),
            }),
            transcriber: None,
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
            stop: stop.clone(),
            time_base: Duration::ZERO,
        });
        let out_wav = store.session_dir(id).join("audio.wav");
        let runner = std::thread::spawn({
            let out_wav = out_wav.clone();
            move || driver.run(&out_wav)
        });
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !runner.is_finished() {
            assert!(
                std::time::Instant::now() < deadline,
                "driver.run() must return without writing out the whole pad"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        runner.join().unwrap().unwrap();
        let reader = hound::WavReader::open(&out_wav).unwrap();
        assert_eq!(reader.duration(), 3_200);
        assert!(matches!(
            store.get(id).unwrap().status,
            TranscriptStatus::Finalizing { .. }
        ));
    }

    #[test]
    fn a_stop_mid_pad_truncates_on_a_block_boundary() {
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let id = mk_session(&store, &store_dir.path().join("ignored.wav"));
        let stop = StopSignal::new();
        let driver = TranscriptDriver::new(DriverConfig {
            id,
            store: store.clone(),
            audio: Box::new(ScriptedChunkStream {
                chunks: vec![
                    chunk_at(0, 3_200, None),
                    chunk_at(half_gap_cap_ms(), 3_200, None),
                ],
            }),
            transcriber: None,
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
            stop: stop.clone(),
            time_base: Duration::ZERO,
        });
        let out_wav = store.session_dir(id).join("audio.wav");
        let runner = std::thread::spawn({
            let out_wav = out_wav.clone();
            move || driver.run(&out_wav)
        });
        let padding_started = wait_until(Duration::from_secs(10), || {
            std::fs::metadata(&out_wav).map(|m| m.len()).unwrap_or(0) > 200_000
        });
        assert!(padding_started, "the gap pad never started writing");
        stop.stop();
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while !runner.is_finished() {
            assert!(
                std::time::Instant::now() < deadline,
                "driver.run() must return shortly after a stop issued mid-pad"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        runner.join().unwrap().unwrap();
        let full_gap = offset_to_samples(Duration::from_millis(half_gap_cap_ms())) - 3_200;
        let padded = u64::from(hound::WavReader::open(&out_wav).unwrap().duration()) - 3_200;
        assert!(padded > 0, "some silence must have been written");
        assert!(
            padded < full_gap,
            "the pad must stop short of the declared gap, padded {padded} of {full_gap}"
        );
        assert_eq!(padded % SILENCE_BLOCK_FRAMES, 0, "padded {padded} frames");
    }

    #[test]
    fn a_stop_mid_pad_before_the_first_chunk_still_leaves_that_chunk_in_the_wav() {
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let id = mk_session(&store, &store_dir.path().join("ignored.wav"));
        let stop = StopSignal::new();
        let driver = TranscriptDriver::new(DriverConfig {
            id,
            store: store.clone(),
            audio: Box::new(ScriptedChunkStream {
                chunks: vec![chunk_at(half_gap_cap_ms(), 3_200, None)],
            }),
            transcriber: None,
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
            stop: stop.clone(),
            time_base: Duration::ZERO,
        });
        let out_wav = store.session_dir(id).join("audio.wav");
        let runner = std::thread::spawn({
            let out_wav = out_wav.clone();
            move || driver.run(&out_wav)
        });
        let padding_started = wait_until(Duration::from_secs(10), || {
            std::fs::metadata(&out_wav).map(|m| m.len()).unwrap_or(0) > 200_000
        });
        assert!(padding_started, "the gap pad never started writing");
        stop.stop();
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while !runner.is_finished() {
            assert!(
                std::time::Instant::now() < deadline,
                "driver.run() must return shortly after a stop issued mid-pad"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        runner.join().unwrap().unwrap();
        let full_gap = offset_to_samples(Duration::from_millis(half_gap_cap_ms()));
        let duration = u64::from(hound::WavReader::open(&out_wav).unwrap().duration());
        assert!(
            duration < full_gap,
            "the pad must stop short of the declared gap, wrote {duration} of {full_gap}"
        );
        assert_eq!(
            duration % SILENCE_BLOCK_FRAMES,
            3_200,
            "the chunk in hand must sit on top of whole silence blocks, got {duration} frames"
        );
    }

    #[test]
    fn stop_signal_same_as_distinguishes_instances_from_clones() {
        let a = StopSignal::new();
        let a2 = a.clone();
        let b = StopSignal::new();
        assert!(a.same_as(&a2), "a clone shares the instance");
        assert!(!a.same_as(&b), "distinct signals never match");
    }

    #[test]
    fn a_resumed_part_commits_segments_shifted_past_the_earlier_parts() {
        let (_fixture_guard, fixture) = make_fixture_wav(12.0);
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let id = mk_session(&store, &store_dir.path().join("ignored.wav"));

        let driver = TranscriptDriver::new(DriverConfig {
            id,
            store: store.clone(),
            audio: stream_from(&fixture),
            transcriber: live(MockTranscriber {
                seg_secs: 2.0,
                text_template: "s{n}".to_string(),
            }),
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
            stop: StopSignal::new(),
            time_base: Duration::from_secs(100),
        });
        let out_wav = store.session_dir(id).join("audio-2.wav");
        driver.run(&out_wav).unwrap();

        let snap = store.get(id).unwrap();
        assert!(!snap.live_segments.is_empty());
        assert!(snap
            .live_segments
            .iter()
            .all(|s| s.start >= Duration::from_secs(100)));
        assert!(snap
            .live_segments
            .iter()
            .all(|s| s.end <= Duration::from_secs(113)));
    }

    #[test]
    fn run_finalize_stitches_multiple_parts_on_one_timeline() {
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let id = mk_session(&store, &store_dir.path().join("a.wav"));
        let _ = store.set_status(id, TranscriptStatus::Finalizing { progress: 0.0 });

        let (_g1, part1) = make_fixture_wav(4.0);
        let (_g2, part2) = make_fixture_wav(2.0);
        let mut sub = store.subscribe(id).unwrap();
        run_finalize(FinalizeConfig {
            pass: store.claim_finalizing(id),
            id,
            store: store.clone(),
            audio_paths: vec![part1, store_dir.path().join("never-recorded.wav"), part2],
            transcriber: Box::new(MockTranscriber {
                seg_secs: 2.0,
                text_template: "f{n}".to_string(),
            }),
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
            diarizer: None,
        })
        .unwrap();

        let mut saw_missing_warning = false;
        while let Ok(ev) = sub.events.try_recv() {
            if let crate::transcription::transcript_store::TranscriptEvent::CaptureWarning {
                warning: crate::transcription::audio::CaptureWarning::RecordingPartMissing,
                ..
            } = ev
            {
                saw_missing_warning = true;
            }
        }
        assert!(saw_missing_warning, "a skipped part must raise a warning");

        let snap = store.get(id).unwrap();
        assert!(matches!(snap.status, TranscriptStatus::Done));
        let finals = snap.final_segments.unwrap();
        assert_eq!(finals.len(), 3);
        assert!(finals.windows(2).all(|w| w[0].start <= w[1].start));
        assert!(finals[2].start >= Duration::from_secs(4));
        assert!(finals[2].end <= Duration::from_secs(7));
    }

    #[test]
    fn run_finalize_fails_with_no_audio_when_no_part_exists() {
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let id = mk_session(&store, &store_dir.path().join("a.wav"));
        let err = run_finalize(FinalizeConfig {
            pass: store.claim_finalizing(id),
            id,
            store: store.clone(),
            audio_paths: vec![store_dir.path().join("missing.wav")],
            transcriber: Box::new(MockTranscriber::new()),
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
            diarizer: None,
        })
        .unwrap_err();
        assert!(err.to_string().contains("no audio was captured"));
        assert!(matches!(
            store.get(id).unwrap().status,
            TranscriptStatus::Failed { .. }
        ));
    }

    #[test]
    fn run_finalize_on_a_stereo_wav_tags_channels_and_merges_by_time() {
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let id = mk_session(&store, &store_dir.path().join("a.wav"));
        let _ = store.set_status(id, TranscriptStatus::Finalizing { progress: 0.0 });

        let wav = store_dir.path().join("stereo.wav");
        let mut w = hound::WavWriter::create(
            &wav,
            hound::WavSpec {
                channels: 2,
                sample_rate: 16_000,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            },
        )
        .unwrap();
        for i in 0..(4 * 16_000) {
            let v = (0.1
                * (2.0 * std::f32::consts::PI * 220.0 * i as f32 / 16_000.0).sin()
                * 32_767.0) as i16;
            w.write_sample(v).unwrap();
            w.write_sample(v).unwrap();
        }
        w.finalize().unwrap();

        run_finalize(FinalizeConfig {
            pass: store.claim_finalizing(id),
            id,
            store: store.clone(),
            audio_paths: vec![wav],
            transcriber: Box::new(MockTranscriber {
                seg_secs: 2.0,
                text_template: "f{n}".to_string(),
            }),
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
            diarizer: None,
        })
        .unwrap();

        let snap = store.get(id).unwrap();
        assert!(matches!(snap.status, TranscriptStatus::Done));
        let finals = snap.final_segments.unwrap();
        use crate::transcription::transcriber::TranscriptSource;
        assert_eq!(finals.len(), 4);
        assert!(finals
            .iter()
            .any(|s| s.source == Some(TranscriptSource::System)));
        assert!(finals
            .iter()
            .any(|s| s.source == Some(TranscriptSource::Mic)));
        assert!(finals.windows(2).all(|w| w[0].start <= w[1].start));
    }

    /// A WAV whose header parses (hound reads 24-bit) but whose samples the
    /// decode pass rejects (`parse_wav_to_channels_f32` supports 16-bit/f32 only).
    fn make_24bit_wav(dir: &Path, secs: f32) -> PathBuf {
        let path = dir.join("part-24bit.wav");
        let mut w = hound::WavWriter::create(
            &path,
            hound::WavSpec {
                channels: 1,
                sample_rate: 16_000,
                bits_per_sample: 24,
                sample_format: hound::SampleFormat::Int,
            },
        )
        .unwrap();
        for _ in 0..(secs * 16_000.0) as usize {
            w.write_sample(1000i32).unwrap();
        }
        w.finalize().unwrap();
        path
    }

    #[test]
    fn run_finalize_skips_a_part_that_fails_to_decode_after_the_header_check() {
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let id = mk_session(&store, &store_dir.path().join("a.wav"));
        let _ = store.set_status(id, TranscriptStatus::Finalizing { progress: 0.0 });

        let (_g1, good) = make_fixture_wav(4.0);
        let undecodable = make_24bit_wav(store_dir.path(), 2.0);
        let mut sub = store.subscribe(id).unwrap();
        run_finalize(FinalizeConfig {
            pass: store.claim_finalizing(id),
            id,
            store: store.clone(),
            audio_paths: vec![good, undecodable],
            transcriber: Box::new(MockTranscriber {
                seg_secs: 2.0,
                text_template: "f{n}".to_string(),
            }),
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
            diarizer: None,
        })
        .unwrap();

        let snap = store.get(id).unwrap();
        assert!(matches!(snap.status, TranscriptStatus::Done));
        assert_eq!(
            snap.final_segments.unwrap().len(),
            2,
            "4 s / 2 s from part 1"
        );
        let mut saw_missing_warning = false;
        while let Ok(ev) = sub.events.try_recv() {
            if let crate::transcription::transcript_store::TranscriptEvent::CaptureWarning {
                warning: crate::transcription::audio::CaptureWarning::RecordingPartMissing,
                ..
            } = ev
            {
                saw_missing_warning = true;
            }
        }
        assert!(
            saw_missing_warning,
            "a load-skipped part must raise a warning"
        );
    }

    #[test]
    fn run_finalize_fails_when_every_part_fails_to_decode() {
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let id = mk_session(&store, &store_dir.path().join("a.wav"));
        let _ = store.set_status(id, TranscriptStatus::Finalizing { progress: 0.0 });

        let undecodable = make_24bit_wav(store_dir.path(), 2.0);
        let err = run_finalize(FinalizeConfig {
            pass: store.claim_finalizing(id),
            id,
            store: store.clone(),
            audio_paths: vec![undecodable],
            transcriber: Box::new(MockTranscriber::new()),
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
            diarizer: None,
        })
        .unwrap_err();
        assert!(
            err.to_string().contains("read audio:"),
            "the real decode error must surface, got: {err}"
        );
        assert!(matches!(
            store.get(id).unwrap().status,
            TranscriptStatus::Failed { .. }
        ));
    }

    #[test]
    fn draft_events_stream_the_held_back_tail_and_clear_on_flush() {
        let (_fixture_guard, fixture) = make_fixture_wav(20.0);
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let id = mk_session(&store, &store_dir.path().join("ignored.wav"));
        let mut sub = store.subscribe(id).unwrap();

        let driver = TranscriptDriver::new(DriverConfig {
            id,
            store: store.clone(),
            audio: stream_from(&fixture),
            transcriber: live(MockTranscriber {
                seg_secs: 2.0,
                text_template: "s{n}".to_string(),
            }),
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
            stop: StopSignal::new(),
            time_base: Duration::ZERO,
        });
        driver
            .run(&store.session_dir(id).join("audio.wav"))
            .unwrap();

        let mut drafts = Vec::new();
        while let Ok(ev) = sub.events.try_recv() {
            if let crate::transcription::transcript_store::TranscriptEvent::LiveDraft {
                text, ..
            } = ev
            {
                drafts.push(text);
            }
        }
        assert!(
            drafts.iter().any(|d| !d.is_empty()),
            "expected at least one non-empty draft, got {drafts:?}"
        );
        assert_eq!(drafts.last().map(String::as_str), Some(""));
        assert_eq!(store.get(id).unwrap().live_draft, "");
    }

    #[test]
    fn live_segments_stay_monotonic_and_unique_across_re_decodes() {
        let (_fixture_guard, fixture) = make_fixture_wav(30.0);
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let id = mk_session(&store, &store_dir.path().join("ignored.wav"));

        let driver = TranscriptDriver::new(DriverConfig {
            id,
            store: store.clone(),
            audio: stream_from(&fixture),
            transcriber: live(MockTranscriber {
                seg_secs: 2.0,
                text_template: "s{n}".to_string(),
            }),
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
            stop: StopSignal::new(),
            time_base: Duration::ZERO,
        });
        let out_wav = store.session_dir(id).join("audio.wav");
        driver.run(&out_wav).unwrap();

        let snap = store.get(id).unwrap();
        let segs = &snap.live_segments;
        assert!(!segs.is_empty());
        for w in segs.windows(2) {
            assert!(
                w[1].start >= w[0].start,
                "segment starts went backwards: {:?} then {:?}",
                w[0].start,
                w[1].start
            );
        }
        assert!(
            segs.len() <= 18,
            "too many segments ({}) — the splice is duplicating",
            segs.len()
        );
    }

    /// Returns canned window-relative segment lists, one per `feed()` call
    /// (the last list repeats once the script runs out).
    struct ScriptedTranscriber {
        script: Vec<Vec<Segment>>,
        call: usize,
    }
    impl crate::transcription::transcriber::Transcriber for ScriptedTranscriber {
        fn transcribe(
            &mut self,
            _pcm: &[f32],
            _opts: &TranscribeOptions,
        ) -> Result<Vec<Segment>, crate::transcription::transcriber::TranscribeError> {
            let idx = self.call.min(self.script.len().saturating_sub(1));
            self.call += 1;
            Ok(self.script[idx].clone())
        }
    }

    fn seg_at(start_s: f32, end_s: f32, text: &str) -> Segment {
        Segment {
            start: Duration::from_secs_f32(start_s),
            end: Duration::from_secs_f32(end_s),
            text: text.to_string(),
            words: Vec::new(),
            source: None,
            speaker_id: None,
        }
    }

    #[test]
    fn live_view_is_append_only_and_holds_back_the_unstable_tail() {
        let (_fixture_guard, fixture) = make_fixture_wav(15.0);
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let id = mk_session(&store, &store_dir.path().join("ignored.wav"));
        let sub = store.subscribe(id).unwrap();

        let script = vec![
            vec![seg_at(0.0, 2.0, "ala"), seg_at(3.0, 5.0, "mo kata")],
            vec![seg_at(0.0, 2.0, "ala"), seg_at(3.0, 5.0, "ma kota")],
            vec![seg_at(0.0, 2.0, "ma kota"), seg_at(9.0, 11.0, "i psa")],
            vec![seg_at(0.0, 2.0, "ma kota"), seg_at(9.0, 11.0, "i psa")],
        ];
        let driver = TranscriptDriver::new(DriverConfig {
            id,
            store: store.clone(),
            audio: stream_from(&fixture),
            transcriber: live(ScriptedTranscriber { script, call: 0 }),
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
            stop: StopSignal::new(),
            time_base: Duration::ZERO,
        });
        let out_wav = store.session_dir(id).join("audio.wav");
        driver.run(&out_wav).unwrap();

        let texts: Vec<String> = store
            .get(id)
            .unwrap()
            .live_segments
            .iter()
            .map(|s| s.text.clone())
            .collect();
        assert_eq!(texts, vec!["ala", "ma kota", "i psa"]);

        let mut rx = sub.events;
        while let Ok(ev) = rx.try_recv() {
            if let crate::transcription::TranscriptEvent::SegmentAppended { segment, .. } = ev {
                assert_ne!(
                    segment.text, "mo kata",
                    "held-back text must never be shown"
                );
            }
        }
    }

    #[test]
    fn a_decode_cycle_committing_several_segments_assigns_them_consecutive_seqs() {
        let (_fixture_guard, fixture) = make_fixture_wav(15.0);
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let id = mk_session(&store, &store_dir.path().join("ignored.wav"));
        let sub = store.subscribe(id).unwrap();

        let script = vec![
            vec![seg_at(0.0, 2.0, "ala"), seg_at(3.0, 5.0, "mo kata")],
            vec![seg_at(0.0, 2.0, "ala"), seg_at(3.0, 5.0, "ma kota")],
            vec![seg_at(0.0, 2.0, "ma kota"), seg_at(9.0, 11.0, "i psa")],
            vec![seg_at(0.0, 2.0, "ma kota"), seg_at(9.0, 11.0, "i psa")],
        ];
        let driver = TranscriptDriver::new(DriverConfig {
            id,
            store: store.clone(),
            audio: stream_from(&fixture),
            transcriber: live(ScriptedTranscriber { script, call: 0 }),
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
            stop: StopSignal::new(),
            time_base: Duration::ZERO,
        });
        let out_wav = store.session_dir(id).join("audio.wav");
        driver.run(&out_wav).unwrap();

        let mut rx = sub.events;
        let mut seqs = Vec::new();
        while let Ok(ev) = rx.try_recv() {
            if let crate::transcription::TranscriptEvent::SegmentAppended { seq, .. } = ev {
                seqs.push(seq);
            }
        }
        assert_eq!(seqs.len(), 3, "ala, ma kota, i psa");
        for w in seqs.windows(2) {
            assert!(w[1] > w[0], "seqs must be strictly increasing: {seqs:?}");
        }
        assert!(store.get(id).unwrap().last_seq >= *seqs.last().unwrap());
    }

    #[test]
    fn uncommitted_tolerates_boundary_jitter_but_drops_committed_redecodes() {
        let segs = vec![
            seg_at(0.0, 4.0, "merged redecode of committed audio"),
            seg_at(3.5, 6.0, "jittered boundary"),
            seg_at(6.0, 8.0, "fresh"),
        ];
        let rest = uncommitted(&segs, Duration::from_secs(4));
        let texts: Vec<&str> = rest.iter().map(|s| s.text.as_str()).collect();
        assert_eq!(texts, vec!["jittered boundary", "fresh"]);
    }

    #[test]
    fn trim_committed_overlap_drops_a_segment_fully_covered_by_the_horizon() {
        let seg = seg_at(3.5, 4.0, "jittered boundary");
        assert!(trim_committed_overlap(seg, Duration::from_secs(4)).is_none());
    }

    #[test]
    fn trim_committed_overlap_clamps_start_when_it_extends_past_the_horizon() {
        let seg = seg_at(3.5, 6.0, "jittered boundary");
        let trimmed = trim_committed_overlap(seg, Duration::from_secs(4)).unwrap();
        assert_eq!(trimmed.start, Duration::from_secs(4));
        assert_eq!(trimmed.end, Duration::from_secs(6));
    }

    #[test]
    fn trim_committed_overlap_passes_through_a_segment_at_or_past_the_horizon() {
        let seg = seg_at(4.0, 6.0, "fresh");
        let trimmed = trim_committed_overlap(seg.clone(), Duration::from_secs(4)).unwrap();
        assert_eq!(trimmed, seg);
    }

    #[test]
    fn trim_committed_overlap_drops_leading_words_when_word_timestamps_are_present() {
        use crate::transcription::transcriber::Word;
        let seg = Segment {
            start: Duration::from_secs_f32(3.5),
            end: Duration::from_secs_f32(6.0),
            text: "ma kota i psa".to_string(),
            words: vec![
                Word {
                    text: "ma".to_string(),
                    start: Duration::from_secs_f32(3.5),
                    end: Duration::from_secs_f32(3.8),
                },
                Word {
                    text: "kota".to_string(),
                    start: Duration::from_secs_f32(3.8),
                    end: Duration::from_secs_f32(4.2),
                },
                Word {
                    text: "i".to_string(),
                    start: Duration::from_secs_f32(4.2),
                    end: Duration::from_secs_f32(4.4),
                },
                Word {
                    text: "psa".to_string(),
                    start: Duration::from_secs_f32(4.4),
                    end: Duration::from_secs_f32(5.0),
                },
            ],
            source: None,
            speaker_id: None,
        };
        let trimmed = trim_committed_overlap(seg, Duration::from_secs(4)).unwrap();
        assert_eq!(trimmed.start, Duration::from_secs(4));
        assert_eq!(
            trimmed.text, "kota i psa",
            "the fully-past word 'ma' is dropped"
        );
        assert_eq!(trimmed.words.len(), 3);
    }

    #[test]
    fn decode_window_does_not_duplicate_text_when_a_redecode_lands_in_the_jitter_window() {
        let (_fixture_guard, fixture) = make_fixture_wav(15.0);
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let id = mk_session(&store, &store_dir.path().join("ignored.wav"));

        let script = vec![
            vec![seg_at(0.0, 4.5, "ala ma kota")],
            vec![seg_at(0.0, 5.0, "ala ma kota")],
            vec![seg_at(1.5, 2.2, "ala ma kota")],
            vec![seg_at(1.5, 2.2, "ala ma kota")],
        ];
        let driver = TranscriptDriver::new(DriverConfig {
            id,
            store: store.clone(),
            audio: stream_from(&fixture),
            transcriber: live(ScriptedTranscriber { script, call: 0 }),
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
            stop: StopSignal::new(),
            time_base: Duration::ZERO,
        });
        let out_wav = store.session_dir(id).join("audio.wav");
        driver.run(&out_wav).unwrap();

        let texts: Vec<String> = store
            .get(id)
            .unwrap()
            .live_segments
            .iter()
            .map(|s| s.text.clone())
            .collect();
        assert_eq!(
            texts.iter().filter(|t| t.as_str() == "ala ma kota").count(),
            1,
            "got: {texts:?}"
        );
    }

    #[test]
    fn draft_trims_the_committed_prefix_of_a_jittered_re_decode() {
        use crate::transcription::transcriber::Word;
        let (_fixture_guard, fixture) = make_fixture_wav(15.0);
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let id = mk_session(&store, &store_dir.path().join("ignored.wav"));
        let sub = store.subscribe(id).unwrap();

        let jittered_tail = Segment {
            start: Duration::from_secs_f32(3.5),
            end: Duration::from_secs_f32(6.0),
            text: "ma kota i psa".to_string(),
            words: vec![
                Word {
                    text: "ma".to_string(),
                    start: Duration::from_secs_f32(3.5),
                    end: Duration::from_secs_f32(3.8),
                },
                Word {
                    text: "kota".to_string(),
                    start: Duration::from_secs_f32(3.8),
                    end: Duration::from_secs_f32(4.2),
                },
                Word {
                    text: "i".to_string(),
                    start: Duration::from_secs_f32(4.2),
                    end: Duration::from_secs_f32(4.4),
                },
                Word {
                    text: "psa".to_string(),
                    start: Duration::from_secs_f32(4.4),
                    end: Duration::from_secs_f32(6.0),
                },
            ],
            source: None,
            speaker_id: None,
        };
        let script = vec![
            vec![seg_at(0.0, 4.0, "ala ma")],
            vec![seg_at(0.0, 4.0, "ala ma"), jittered_tail],
            vec![],
        ];
        let driver = TranscriptDriver::new(DriverConfig {
            id,
            store: store.clone(),
            audio: stream_from(&fixture),
            transcriber: live(ScriptedTranscriber { script, call: 0 }),
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
            stop: StopSignal::new(),
            time_base: Duration::ZERO,
        });
        let out_wav = store.session_dir(id).join("audio.wav");
        driver.run(&out_wav).unwrap();

        let mut drafts = Vec::new();
        let mut rx = sub.events;
        while let Ok(ev) = rx.try_recv() {
            if let crate::transcription::transcript_store::TranscriptEvent::LiveDraft {
                text, ..
            } = ev
            {
                drafts.push(text);
            }
        }
        assert_eq!(
            drafts,
            vec![
                "ala ma".to_string(),
                "kota i psa".to_string(),
                String::new()
            ],
            "draft sequence mismatch"
        );
    }

    #[test]
    fn stop_signal_winds_down_at_the_next_chunk_boundary() {
        let (_fixture_guard, fixture) = make_fixture_wav(30.0);
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let id = mk_session(&store, &store_dir.path().join("ignored.wav"));

        let stop = StopSignal::new();
        stop.stop();
        let driver = TranscriptDriver::new(DriverConfig {
            id,
            store: store.clone(),
            audio: stream_from(&fixture),
            transcriber: live(MockTranscriber::new()),
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
            stop,
            time_base: Duration::ZERO,
        });
        let out_wav = store.session_dir(id).join("audio.wav");
        driver.run(&out_wav).unwrap();
        assert!(matches!(
            store.get(id).unwrap().status,
            TranscriptStatus::Finalizing { .. }
        ));
        assert!(!out_wav.exists());
    }

    /// An `AudioStream` that returns an error on its first `next_chunk()`.
    struct FailingStream;
    impl AudioStream for FailingStream {
        fn next_chunk(
            &mut self,
        ) -> Result<Option<crate::transcription::audio::AudioChunk>, CaptureError> {
            Err(CaptureError::Failed("device unplugged".to_string()))
        }
    }

    #[test]
    fn capture_failure_flips_to_failed_status_and_returns_error() {
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let id = mk_session(&store, &store_dir.path().join("ignored.wav"));
        store
            .live_draft(id, "not yet committed".to_string())
            .unwrap();

        let driver = TranscriptDriver::new(DriverConfig {
            id,
            store: store.clone(),
            audio: Box::new(FailingStream),
            transcriber: live(MockTranscriber::new()),
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
            stop: StopSignal::new(),
            time_base: Duration::ZERO,
        });
        let out_wav = store.session_dir(id).join("audio.wav");
        let err = driver.run(&out_wav).unwrap_err();
        assert!(matches!(err, DriverError::Capture(_)), "got {err:?}");
        let snap = store.get(id).unwrap();
        assert!(
            matches!(snap.status, TranscriptStatus::Failed { .. }),
            "got {:?}",
            snap.status
        );
        assert_eq!(
            snap.live_draft, "",
            "stale draft must be cleared on failure"
        );
    }

    /// An `AudioStream` that queues a stall warning on the same call that then
    /// fails — the health transition must still reach the store.
    struct StallThenFailStream;
    impl AudioStream for StallThenFailStream {
        fn next_chunk(
            &mut self,
        ) -> Result<Option<crate::transcription::audio::AudioChunk>, CaptureError> {
            Err(CaptureError::Failed("both streams stalled".to_string()))
        }

        fn take_health(&mut self) -> Vec<CaptureHealth> {
            vec![CaptureHealth::Raised(
                crate::transcription::CaptureWarning::SystemAudioStalled,
            )]
        }
    }

    #[test]
    fn capture_health_queued_alongside_a_failing_chunk_still_reaches_the_store() {
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let id = mk_session(&store, &store_dir.path().join("ignored.wav"));
        let sub = store.subscribe(id).unwrap();

        let driver = TranscriptDriver::new(DriverConfig {
            id,
            store: store.clone(),
            audio: Box::new(StallThenFailStream),
            transcriber: live(MockTranscriber::new()),
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
            stop: StopSignal::new(),
            time_base: Duration::ZERO,
        });
        let out_wav = store.session_dir(id).join("audio.wav");
        let err = driver.run(&out_wav).unwrap_err();
        assert!(matches!(err, DriverError::Capture(_)), "got {err:?}");

        let mut rx = sub.events;
        let mut saw_raised = false;
        while let Ok(ev) = rx.try_recv() {
            if let crate::transcription::TranscriptEvent::CaptureWarning {
                warning: crate::transcription::CaptureWarning::SystemAudioStalled,
                ..
            } = ev
            {
                saw_raised = true;
            }
        }
        assert!(
            saw_raised,
            "the stall warning queued alongside the Err chunk must still be forwarded"
        );
    }

    /// An `AudioStream` emitting `chunks_left` short chunks; the first chunk
    /// raises the silent warning, the second clears it.
    struct WarningStream {
        chunks_left: usize,
        emitted: usize,
    }
    impl AudioStream for WarningStream {
        fn next_chunk(
            &mut self,
        ) -> Result<Option<crate::transcription::audio::AudioChunk>, CaptureError> {
            if self.chunks_left == 0 {
                return Ok(None);
            }
            self.chunks_left -= 1;
            Ok(Some(crate::transcription::audio::AudioChunk {
                samples: vec![0.0; 1600],
                mic: None,
                offset: Duration::ZERO,
            }))
        }

        fn take_health(&mut self) -> Vec<CaptureHealth> {
            self.emitted += 1;
            match self.emitted {
                1 => vec![CaptureHealth::Raised(
                    crate::transcription::CaptureWarning::SystemAudioSilent,
                )],
                2 => vec![CaptureHealth::Cleared(
                    crate::transcription::CaptureWarning::SystemAudioSilent,
                )],
                _ => Vec::new(),
            }
        }
    }

    #[test]
    fn capture_warnings_are_forwarded_as_store_events() {
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let id = mk_session(&store, &store_dir.path().join("ignored.wav"));
        let sub = store.subscribe(id).unwrap();

        let driver = TranscriptDriver::new(DriverConfig {
            id,
            store: store.clone(),
            audio: Box::new(WarningStream {
                chunks_left: 2,
                emitted: 0,
            }),
            transcriber: live(MockTranscriber::new()),
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
            stop: StopSignal::new(),
            time_base: Duration::ZERO,
        });
        let out_wav = store.session_dir(id).join("audio.wav");
        driver.run(&out_wav).unwrap();

        let mut rx = sub.events;
        let mut saw_raised = false;
        let mut saw_cleared = false;
        while let Ok(ev) = rx.try_recv() {
            match ev {
                crate::transcription::TranscriptEvent::CaptureWarning {
                    warning: crate::transcription::CaptureWarning::SystemAudioSilent,
                    ..
                } => saw_raised = true,
                crate::transcription::TranscriptEvent::CaptureWarningCleared {
                    warning: crate::transcription::CaptureWarning::SystemAudioSilent,
                    ..
                } => {
                    assert!(saw_raised, "cleared must follow the raise");
                    saw_cleared = true;
                }
                _ => {}
            }
        }
        assert!(saw_raised, "the warning should reach store subscribers");
        assert!(saw_cleared, "the recovery should reach store subscribers");
    }

    #[test]
    fn stop_signal_helpers() {
        let s = StopSignal::new();
        assert!(!s.is_stopped());
        let s2 = s.clone();
        s2.stop();
        assert!(s.is_stopped(), "stop() should be visible across clones");
    }

    /// Records a recorded WAV under `<session_dir>/audio.wav` with `secs` of a
    /// quiet tone, leaving the session in Finalizing state (the post-stop state).
    fn seed_finalizing_session(
        store: &Arc<TranscriptStore>,
        secs: f32,
    ) -> (Uuid, std::path::PathBuf) {
        let id = mk_session(store, &PathBuf::from("/will-be-overwritten.wav"));
        let dir = store.session_dir(id);
        std::fs::create_dir_all(&dir).unwrap();
        let wav = dir.join("audio.wav");
        let mut w = hound::WavWriter::create(
            &wav,
            hound::WavSpec {
                channels: 1,
                sample_rate: 16_000,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            },
        )
        .unwrap();
        let n = (secs * 16_000.0) as usize;
        for i in 0..n {
            let v = (0.05
                * (2.0 * std::f32::consts::PI * 220.0 * i as f32 / 16_000.0).sin()
                * 32_767.0) as i16;
            w.write_sample(v).unwrap();
        }
        w.finalize().unwrap();
        store
            .set_status(id, TranscriptStatus::Finalizing { progress: 0.0 })
            .unwrap();
        (id, wav)
    }

    #[test]
    fn finalize_produces_final_segments_and_marks_done() {
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let (id, wav) = seed_finalizing_session(&store, 12.0);

        run_finalize(FinalizeConfig {
            pass: store.claim_finalizing(id),
            id,
            store: store.clone(),
            audio_paths: vec![wav],
            transcriber: Box::new(MockTranscriber {
                seg_secs: 4.0,
                text_template: "f{n}".to_string(),
            }),
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
            diarizer: None,
        })
        .unwrap();

        let snap = store.get(id).unwrap();
        assert!(matches!(snap.status, TranscriptStatus::Done));
        let finals = snap.final_segments.as_ref().expect("final segments set");
        assert!(!finals.is_empty(), "offline pass should have segments");
        assert_eq!(snap.effective_segments().len(), finals.len());
        assert!(snap.last_seq > 0);
    }

    #[test]
    fn finalize_with_missing_audio_flips_to_failed() {
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let (id, _wav) = seed_finalizing_session(&store, 4.0);
        let _ = std::fs::remove_file(store.session_dir(id).join("audio.wav"));

        let err = run_finalize(FinalizeConfig {
            pass: store.claim_finalizing(id),
            id,
            store: store.clone(),
            audio_paths: vec![store.session_dir(id).join("audio.wav")],
            transcriber: Box::new(MockTranscriber::new()),
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
            diarizer: None,
        })
        .unwrap_err();
        assert!(matches!(err, DriverError::Transcribe(_)), "got {err:?}");
        let snap = store.get(id).unwrap();
        assert!(matches!(snap.status, TranscriptStatus::Failed { .. }));
        assert!(snap.final_segments.is_none());
    }

    #[test]
    fn finalize_with_a_zero_byte_wav_reports_no_audio_not_a_hound_error() {
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let (id, wav) = seed_finalizing_session(&store, 4.0);
        std::fs::write(&wav, b"").unwrap();

        let err = run_finalize(FinalizeConfig {
            pass: store.claim_finalizing(id),
            id,
            store: store.clone(),
            audio_paths: vec![wav],
            transcriber: Box::new(MockTranscriber::new()),
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
            diarizer: None,
        })
        .unwrap_err();
        let DriverError::Transcribe(reason) = err else {
            panic!("expected Transcribe, got {err:?}")
        };
        assert!(reason.contains("no audio was captured"), "got: {reason}");
        assert!(
            !reason.contains("read enough bytes"),
            "must not leak the raw hound error: {reason}"
        );
    }

    #[test]
    fn finalize_with_a_corrupt_but_non_empty_wav_reports_the_real_read_error() {
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let (id, wav) = seed_finalizing_session(&store, 4.0);
        std::fs::write(&wav, vec![0xAAu8; 200]).unwrap();

        let err = run_finalize(FinalizeConfig {
            pass: store.claim_finalizing(id),
            id,
            store: store.clone(),
            audio_paths: vec![wav],
            transcriber: Box::new(MockTranscriber::new()),
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
            diarizer: None,
        })
        .unwrap_err();
        let DriverError::Transcribe(reason) = err else {
            panic!("expected Transcribe, got {err:?}")
        };
        assert!(
            reason.starts_with("read audio:"),
            "expected the real read error, got: {reason}"
        );
        assert!(
            !reason.contains("no audio was captured"),
            "must not mask a corrupt-file error as the empty-capture message: {reason}"
        );
    }

    /// A transcriber that always errors — to exercise the offline-decode failure
    /// path.
    struct FailingTranscriber;
    impl Transcriber for FailingTranscriber {
        fn transcribe(
            &mut self,
            _pcm: &[f32],
            _opts: &TranscribeOptions,
        ) -> Result<Vec<Segment>, crate::transcription::transcriber::TranscribeError> {
            Err(
                crate::transcription::transcriber::TranscribeError::Inference(
                    "model exploded".to_string(),
                ),
            )
        }
    }

    #[test]
    fn finalize_with_failing_transcriber_flips_to_failed() {
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let (id, wav) = seed_finalizing_session(&store, 8.0);

        let err = run_finalize(FinalizeConfig {
            pass: store.claim_finalizing(id),
            id,
            store: store.clone(),
            audio_paths: vec![wav],
            transcriber: Box::new(FailingTranscriber),
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
            diarizer: None,
        })
        .unwrap_err();
        assert!(matches!(err, DriverError::Transcribe(_)), "got {err:?}");
        assert!(matches!(
            store.get(id).unwrap().status,
            TranscriptStatus::Failed { .. }
        ));
    }

    /// Deletes its own session from inside `transcribe`, as a user deleting it mid offline pass;
    /// `fail` makes that window's decode fail too.
    struct DeletingTranscriber {
        store: Arc<TranscriptStore>,
        id: Uuid,
        calls: Arc<std::sync::atomic::AtomicUsize>,
        fail: bool,
    }
    impl Transcriber for DeletingTranscriber {
        fn transcribe(
            &mut self,
            _pcm: &[f32],
            _opts: &TranscribeOptions,
        ) -> Result<Vec<Segment>, crate::transcription::transcriber::TranscribeError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.store.delete(self.id).unwrap();
            if self.fail {
                return Err(
                    crate::transcription::transcriber::TranscribeError::Inference(
                        "model exploded".to_string(),
                    ),
                );
            }
            Ok(Vec::new())
        }
    }

    #[test]
    fn finalize_stops_after_the_window_in_which_the_session_was_deleted() {
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let (id, wav) = seed_finalizing_session(&store, 70.0);
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));

        let err = run_finalize(FinalizeConfig {
            pass: store.claim_finalizing(id),
            id,
            store: store.clone(),
            audio_paths: vec![wav],
            transcriber: Box::new(DeletingTranscriber {
                store: store.clone(),
                id,
                calls: calls.clone(),
                fail: false,
            }),
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
            diarizer: None,
        })
        .unwrap_err();
        assert!(matches!(err, DriverError::Deleted), "got {err:?}");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(!store.session_dir(id).exists());
    }

    /// Puts its own session off from inside `transcribe`, as a user clicking "Later" mid offline
    /// pass, and records whether the decode was handed a raised cancel flag afterwards.
    struct PostponingTranscriber {
        store: Arc<TranscriptStore>,
        id: Uuid,
        calls: Arc<std::sync::atomic::AtomicUsize>,
        fail: bool,
        cancel_seen: Arc<Mutex<Option<DecodeCancel>>>,
    }
    impl Transcriber for PostponingTranscriber {
        fn transcribe(
            &mut self,
            _pcm: &[f32],
            opts: &TranscribeOptions,
        ) -> Result<Vec<Segment>, crate::transcription::transcriber::TranscribeError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            *self.cancel_seen.lock().unwrap() = opts.cancel.clone();
            self.store.postpone(self.id).unwrap();
            if self.fail {
                return Err(
                    crate::transcription::transcriber::TranscribeError::Inference(
                        "whisper_full: aborted".to_string(),
                    ),
                );
            }
            Ok(vec![Segment {
                start: Duration::ZERO,
                end: Duration::from_secs(1),
                text: "never installed".to_string(),
                words: vec![],
                source: None,
                speaker_id: None,
            }])
        }
    }

    /// Runs the offline pass over a 70 s recording with a transcriber that puts it off.
    fn finalize_postponed_midway(fail: bool) -> (DriverError, usize, TranscriptSession, bool) {
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let (id, wav) = seed_finalizing_session(&store, 70.0);
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let cancel_seen = Arc::new(Mutex::new(None));
        let pass = store.claim_finalizing(id);
        let err = run_finalize(FinalizeConfig {
            pass: pass.clone(),
            id,
            store: store.clone(),
            audio_paths: vec![wav],
            transcriber: Box::new(PostponingTranscriber {
                store: store.clone(),
                id,
                calls: calls.clone(),
                fail,
                cancel_seen: cancel_seen.clone(),
            }),
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
            diarizer: None,
        })
        .unwrap_err();
        let handed_the_pass_flag =
            cancel_seen.lock().unwrap().as_ref() == Some(&pass.decode_cancel());
        (
            err,
            calls.load(Ordering::SeqCst),
            store.get(id).unwrap(),
            handed_the_pass_flag,
        )
    }

    #[test]
    fn a_pass_put_off_mid_decode_stops_after_that_window_and_writes_nothing() {
        let (err, calls, snap, handed_the_pass_flag) = finalize_postponed_midway(false);
        assert!(matches!(err, DriverError::Superseded), "got {err:?}");
        assert_eq!(calls, 1, "no window may start after the pass was put off");
        assert_eq!(snap.status, TranscriptStatus::Postponed);
        assert!(snap.final_segments.is_none());
        assert!(
            handed_the_pass_flag,
            "Whisper must poll the pass's own cancel flag"
        );
    }

    #[test]
    fn a_decode_aborted_by_later_is_not_reported_as_a_failure() {
        let (err, calls, snap, _) = finalize_postponed_midway(true);
        assert!(matches!(err, DriverError::Superseded), "got {err:?}");
        assert_eq!(calls, 1);
        assert_eq!(snap.status, TranscriptStatus::Postponed);
    }

    #[test]
    fn a_pass_put_off_before_it_starts_writes_nothing() {
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let (id, wav) = seed_finalizing_session(&store, 8.0);
        let pass = store.claim_finalizing(id);
        store.postpone(id).unwrap();
        let seq = store.get(id).unwrap().last_seq;

        let err = run_finalize(FinalizeConfig {
            pass,
            id,
            store: store.clone(),
            audio_paths: vec![wav],
            transcriber: Box::new(FailingTranscriber),
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
            diarizer: None,
        })
        .unwrap_err();
        assert!(matches!(err, DriverError::Superseded), "got {err:?}");
        let snap = store.get(id).unwrap();
        assert_eq!(snap.status, TranscriptStatus::Postponed);
        assert_eq!(snap.last_seq, seq);
    }

    #[test]
    fn a_replaced_pass_writes_nothing_and_leaves_the_newer_pass_its_session() {
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let (id, wav) = seed_finalizing_session(&store, 8.0);
        let old = store.claim_finalizing(id);
        let new = store.begin_offline_pass(id).unwrap();
        let seq = store.get(id).unwrap().last_seq;

        let err = run_finalize(FinalizeConfig {
            pass: old,
            id,
            store: store.clone(),
            audio_paths: vec![wav],
            transcriber: Box::new(FailingTranscriber),
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
            diarizer: None,
        })
        .unwrap_err();
        assert!(matches!(err, DriverError::Superseded), "got {err:?}");
        assert_eq!(store.get(id).unwrap().last_seq, seq);
        store.finish(id, &new).unwrap();
    }

    #[test]
    fn a_refused_pass_write_ends_the_pass_quietly_and_a_store_fault_does_not() {
        let id = Uuid::new_v4();
        assert!(matches!(
            pass_stopped(&StoreError::PassEnded(id)),
            Some(DriverError::Superseded)
        ));
        assert!(matches!(
            pass_stopped(&StoreError::NotFound(id)),
            Some(DriverError::Deleted)
        ));
        assert!(pass_stopped(&StoreError::InvalidState("x".to_string())).is_none());
        assert!(pass_stopped(&StoreError::Io(std::io::Error::other("disk full"))).is_none());
    }

    #[test]
    fn finalize_reports_deleted_when_the_failing_window_deleted_the_session() {
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let (id, wav) = seed_finalizing_session(&store, 8.0);

        let err = run_finalize(FinalizeConfig {
            pass: store.claim_finalizing(id),
            id,
            store: store.clone(),
            audio_paths: vec![wav],
            transcriber: Box::new(DeletingTranscriber {
                store: store.clone(),
                id,
                calls: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
                fail: true,
            }),
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
            diarizer: None,
        })
        .unwrap_err();
        assert!(matches!(err, DriverError::Deleted), "got {err:?}");
        assert!(!store.session_dir(id).exists());
    }

    #[test]
    fn finalize_of_a_session_deleted_before_it_starts_reports_deleted() {
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let (id, wav) = seed_finalizing_session(&store, 8.0);
        let pass = store.claim_finalizing(id);
        store.delete(id).unwrap();

        let err = run_finalize(FinalizeConfig {
            pass,
            id,
            store: store.clone(),
            audio_paths: vec![wav],
            transcriber: Box::new(FailingTranscriber),
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
            diarizer: None,
        })
        .unwrap_err();
        assert!(matches!(err, DriverError::Deleted), "got {err:?}");
        assert!(!store.session_dir(id).exists());
    }

    #[test]
    fn finalize_with_empty_wav_flips_to_failed() {
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let id = mk_session(&store, &PathBuf::from("/x.wav"));
        let dir = store.session_dir(id);
        std::fs::create_dir_all(&dir).unwrap();
        let wav = dir.join("audio.wav");
        hound::WavWriter::create(
            &wav,
            hound::WavSpec {
                channels: 1,
                sample_rate: 16_000,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            },
        )
        .unwrap()
        .finalize()
        .unwrap();
        store
            .set_status(id, TranscriptStatus::Finalizing { progress: 0.0 })
            .unwrap();

        let err = run_finalize(FinalizeConfig {
            pass: store.claim_finalizing(id),
            id,
            store: store.clone(),
            audio_paths: vec![wav],
            transcriber: Box::new(MockTranscriber::new()),
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
            diarizer: None,
        })
        .unwrap_err();
        assert!(matches!(err, DriverError::Transcribe(_)));
        assert!(matches!(
            store.get(id).unwrap().status,
            TranscriptStatus::Failed { .. }
        ));
    }

    #[test]
    fn read_wav_to_mono_handles_int16_and_float32() {
        let dir = tempfile::tempdir().unwrap();
        let p16 = dir.path().join("i16.wav");
        let mut w = hound::WavWriter::create(
            &p16,
            hound::WavSpec {
                channels: 1,
                sample_rate: 16_000,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            },
        )
        .unwrap();
        for v in [0i16, 16_384, -16_384, 32_767] {
            w.write_sample(v).unwrap();
        }
        w.finalize().unwrap();
        let (s16, _) = super::super::audio::parse_wav_to_mono_f32(&p16).unwrap();
        assert_eq!(s16.len(), 4);
        assert!((s16[0] - 0.0).abs() < 1e-4);
        assert!((s16[1] - 0.5).abs() < 1e-3);
        let pf = dir.path().join("f32.wav");
        let mut wf = hound::WavWriter::create(
            &pf,
            hound::WavSpec {
                channels: 2,
                sample_rate: 16_000,
                bits_per_sample: 32,
                sample_format: hound::SampleFormat::Float,
            },
        )
        .unwrap();
        for v in [1.0f32, 0.0, 0.5, 0.5] {
            wf.write_sample(v).unwrap();
        }
        wf.finalize().unwrap();
        let (sf, _) = super::super::audio::parse_wav_to_mono_f32(&pf).unwrap();
        assert_eq!(sf.len(), 2);
        assert!((sf[0] - 0.5).abs() < 1e-4);
        assert!((sf[1] - 0.5).abs() < 1e-4);
    }

    #[test]
    fn transcribe_chunked_short_recording_is_one_window() {
        let pcm = vec![0.01f32; 10 * 16_000];
        let mut tr = MockTranscriber {
            seg_secs: 2.0,
            text_template: "s{n}".to_string(),
        };
        let mut last_progress = 0.0;
        let opts = TranscribeOptions::for_language(Language::Pl);
        let segs = transcribe_chunked(&mut tr, &pcm, &opts, None, |p| {
            last_progress = p;
            Ok(())
        })
        .unwrap();
        assert_eq!(segs.len(), 5);
        assert!((last_progress - 1.0).abs() < 1e-6);
        assert_eq!(segs[0].start, Duration::ZERO);
        assert_eq!(segs[4].start, Duration::from_secs_f32(8.0));
    }

    #[test]
    fn transcribe_chunked_stitches_overlapping_windows_without_duplicates() {
        let pcm = vec![0.01f32; 70 * 16_000];
        let mut tr = MockTranscriber {
            seg_secs: 5.0,
            text_template: "s{n}".to_string(),
        };
        let mut ticks: Vec<f32> = Vec::new();
        let opts = TranscribeOptions::for_language(Language::En);
        let segs = transcribe_chunked(&mut tr, &pcm, &opts, None, |p| {
            ticks.push(p);
            Ok(())
        })
        .unwrap();
        assert!(!segs.is_empty());
        for w in segs.windows(2) {
            assert!(w[1].start >= w[0].start, "starts went backwards");
        }
        let last_end = segs.last().unwrap().end.as_secs_f32();
        assert!(
            (60.0..=71.0).contains(&last_end),
            "last segment ends at {last_end}, expected ≈70"
        );
        assert!(
            ticks.len() >= 3,
            "expected ≥3 progress ticks, got {}",
            ticks.len()
        );
        assert!((ticks.last().copied().unwrap() - 1.0).abs() < 1e-6);
        for w in ticks.windows(2) {
            assert!(w[1] >= w[0]);
        }
    }

    #[test]
    fn transcribe_chunked_propagates_transcriber_errors() {
        struct Boom;
        impl Transcriber for Boom {
            fn transcribe(
                &mut self,
                _pcm: &[f32],
                _opts: &TranscribeOptions,
            ) -> Result<Vec<Segment>, crate::transcription::transcriber::TranscribeError>
            {
                Err(
                    crate::transcription::transcriber::TranscribeError::Inference(
                        "kaboom".to_string(),
                    ),
                )
            }
        }
        let pcm = vec![0.0f32; 5 * 16_000];
        let opts = TranscribeOptions::for_language(Language::Pl);
        let err = transcribe_chunked(&mut Boom, &pcm, &opts, None, |_| Ok(())).unwrap_err();
        assert!(matches!(err, DriverError::Transcribe(_)));
    }

    #[test]
    fn lane_ring_keeps_only_the_trailing_window_and_tracks_absolute_indices() {
        let mut ring = LaneRing::new(10);
        ring.push(&[1.0, 2.0, 3.0]);
        assert_eq!((ring.base, ring.filled), (0, 3));
        let (start, win) = ring.window_ending_at(3, 2);
        assert_eq!((start, win), (1, vec![2.0, 3.0]));
        ring.push(&[4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0, 11.0, 12.0]);
        assert_eq!((ring.base, ring.filled), (2, 12));
        let (start, win) = ring.window_ending_at(12, 3);
        assert_eq!((start, win), (9, vec![10.0, 11.0, 12.0]));
        assert_eq!(ring.window_ending_at(2, 4), (2, Vec::new()));
        let (_, win) = ring.window_ending_at(99, 2);
        assert_eq!(win, vec![11.0, 12.0]);
    }

    #[test]
    fn lane_ring_silence_advances_the_head_without_materialising_a_long_gap() {
        let mut ring = LaneRing::new(4);
        ring.push(&[1.0]);
        ring.push_silence(1_000);
        assert_eq!(ring.filled, 1_001);
        assert_eq!(ring.base, 997);
        let (start, win) = ring.window_ending_at(1_001, 4);
        assert_eq!(start, 997);
        assert_eq!(win, vec![0.0, 0.0, 0.0, 0.0]);
        ring.push_silence(0);
        assert_eq!(ring.filled, 1_001);
    }

    #[test]
    fn an_idle_capture_gap_is_padded_so_the_wav_keeps_its_real_length() {
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let wav = store_dir.path().join("gapped.wav");
        let id = mk_session(&store, &wav);
        let driver = TranscriptDriver::new(DriverConfig {
            id,
            store: store.clone(),
            audio: Box::new(ScriptedChunkStream {
                chunks: vec![chunk_at(0, 3_200, None), chunk_at(10_000, 3_200, None)],
            }),
            transcriber: live(MockTranscriber::new()),
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
            stop: StopSignal::new(),
            time_base: Duration::ZERO,
        });
        driver.run(&wav).unwrap();
        let secs = crate::transcription::audio::wav_duration(&wav)
            .expect("the padded WAV must be readable")
            .as_secs_f32();
        assert!(
            (secs - 10.2).abs() < 0.05,
            "expected ~10.2 s (0.2 + 9.8 gap + 0.2), got {secs}"
        );
    }

    #[test]
    fn a_corrupt_offset_past_the_gap_cap_splices_without_padding() {
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let wav = store_dir.path().join("corrupt.wav");
        let id = mk_session(&store, &wav);
        let two_hours_ms = 2 * 3600 * 1000;
        let driver = TranscriptDriver::new(DriverConfig {
            id,
            store: store.clone(),
            audio: Box::new(ScriptedChunkStream {
                chunks: vec![
                    chunk_at(0, 3_200, None),
                    chunk_at(two_hours_ms, 3_200, None),
                    chunk_at(two_hours_ms + 200, 3_200, None),
                ],
            }),
            transcriber: live(MockTranscriber::new()),
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
            stop: StopSignal::new(),
            time_base: Duration::ZERO,
        });
        driver.run(&wav).unwrap();
        let secs = crate::transcription::audio::wav_duration(&wav)
            .expect("the spliced WAV must be readable")
            .as_secs_f32();
        assert!(
            (secs - 0.6).abs() < 0.02,
            "expected 0.6 s (three 0.2 s chunks, zero padding), got {secs}"
        );
    }

    #[test]
    fn a_lagging_live_pass_skips_ahead_when_the_ring_evicted_its_window() {
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let id = mk_session(&store, &store_dir.path().join("a.wav"));
        let mut driver = TranscriptDriver::new(DriverConfig {
            id,
            store: store.clone(),
            audio: Box::new(ScriptedChunkStream { chunks: vec![] }),
            transcriber: live(MockTranscriber {
                seg_secs: 2.0,
                text_template: "s{n}".to_string(),
            }),
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
            stop: StopSignal::new(),
            time_base: Duration::ZERO,
        });
        {
            let mut g = lock_ingest(&driver.ingest);
            g.lanes = vec![LaneRing::new(ring_capacity_samples())];
            g.lanes[0].push(&vec![0.1; SAMPLE_RATE_HZ as usize * 60]);
        }
        driver.decode_window_ending(5.0, false).unwrap();
        assert!(
            (driver.last_decode_at - 60.0).abs() < 0.01,
            "expected the decode cursor at the head (60 s), got {}",
            driver.last_decode_at
        );
        let snap = store.get(id).unwrap();
        assert!(
            !snap.live_segments.is_empty(),
            "the skipped-ahead window must decode real audio"
        );
    }

    /// Panics on the second pull — a capture backend blowing up mid-recording.
    struct PanickingStream {
        pulled: bool,
    }
    impl AudioStream for PanickingStream {
        fn next_chunk(
            &mut self,
        ) -> Result<Option<crate::transcription::audio::AudioChunk>, CaptureError> {
            if !self.pulled {
                self.pulled = true;
                return Ok(Some(chunk_at(0, 1600, None)));
            }
            panic!("capture backend blew up");
        }
    }

    #[test]
    fn an_ingest_panic_fails_the_session_instead_of_reporting_success() {
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let wav = store_dir.path().join("panic.wav");
        let id = mk_session(&store, &wav);
        let driver = TranscriptDriver::new(DriverConfig {
            id,
            store: store.clone(),
            audio: Box::new(PanickingStream { pulled: false }),
            transcriber: live(MockTranscriber::new()),
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
            stop: StopSignal::new(),
            time_base: Duration::ZERO,
        });
        let err = driver.run(&wav).unwrap_err();
        assert!(err.to_string().contains("panicked"), "got: {err}");
        assert!(matches!(
            store.get(id).unwrap().status,
            TranscriptStatus::Failed { .. }
        ));
        assert!(crate::transcription::audio::wav_duration(&wav).is_some());
    }

    /// One chunk, then trips `stop` and errors on the next pull — a failure landing after the
    /// decode loop's last poll (the decode side exits on stop, never seeing it).
    struct LateErrorStream {
        pulled: bool,
        stop: StopSignal,
    }
    impl AudioStream for LateErrorStream {
        fn next_chunk(
            &mut self,
        ) -> Result<Option<crate::transcription::audio::AudioChunk>, CaptureError> {
            if !self.pulled {
                self.pulled = true;
                return Ok(Some(chunk_at(0, 1600, None)));
            }
            self.stop.stop();
            Err(CaptureError::Failed("device vanished".to_string()))
        }
    }

    /// Trips `stop` as it hands over its only chunk, with a warning queued on it — health landing
    /// after the decode loop's last drain (the wind-down path must forward it).
    struct LateHealthStream {
        pulled: bool,
        stop: StopSignal,
    }
    impl AudioStream for LateHealthStream {
        fn next_chunk(
            &mut self,
        ) -> Result<Option<crate::transcription::audio::AudioChunk>, CaptureError> {
            if self.pulled {
                return Ok(None);
            }
            self.stop.stop();
            self.pulled = true;
            Ok(Some(chunk_at(0, 1600, None)))
        }

        fn take_health(&mut self) -> Vec<CaptureHealth> {
            if self.pulled {
                vec![CaptureHealth::Raised(
                    crate::transcription::CaptureWarning::AudioDropped,
                )]
            } else {
                Vec::new()
            }
        }
    }

    #[test]
    fn health_queued_after_the_decode_loops_last_poll_still_reaches_the_store() {
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let wav = store_dir.path().join("late-health.wav");
        let id = mk_session(&store, &wav);
        let sub = store.subscribe(id).unwrap();
        let stop = StopSignal::new();
        let driver = TranscriptDriver::new(DriverConfig {
            id,
            store: store.clone(),
            audio: Box::new(LateHealthStream {
                pulled: false,
                stop: stop.clone(),
            }),
            transcriber: live(MockTranscriber::new()),
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
            stop: stop.clone(),
            time_base: Duration::ZERO,
        });
        driver.run(&wav).unwrap();
        let mut rx = sub.events;
        let mut saw = false;
        while let Ok(ev) = rx.try_recv() {
            if let crate::transcription::TranscriptEvent::CaptureWarning {
                warning: crate::transcription::CaptureWarning::AudioDropped,
                ..
            } = ev
            {
                saw = true;
            }
        }
        assert!(
            saw,
            "the AudioDropped raised after the decode loop exited must still be forwarded"
        );
    }

    #[test]
    fn a_capture_error_landing_after_the_decode_loop_exits_still_fails_the_session() {
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let wav = store_dir.path().join("late-error.wav");
        let id = mk_session(&store, &wav);
        let stop = StopSignal::new();
        let driver = TranscriptDriver::new(DriverConfig {
            id,
            store: store.clone(),
            audio: Box::new(LateErrorStream {
                pulled: false,
                stop: stop.clone(),
            }),
            transcriber: live(MockTranscriber::new()),
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
            stop: stop.clone(),
            time_base: Duration::ZERO,
        });
        let err = driver.run(&wav).unwrap_err();
        assert!(err.to_string().contains("device vanished"), "got: {err}");
        assert!(matches!(
            store.get(id).unwrap().status,
            TranscriptStatus::Failed { .. }
        ));
    }

    #[test]
    fn a_backwards_offset_correction_contributes_only_its_unwritten_tail() {
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let wav = store_dir.path().join("overlap.wav");
        let id = mk_session(&store, &wav);
        let driver = TranscriptDriver::new(DriverConfig {
            id,
            store: store.clone(),
            audio: Box::new(ScriptedChunkStream {
                chunks: vec![chunk_at(0, 3_200, None), chunk_at(100, 3_200, None)],
            }),
            transcriber: live(MockTranscriber::new()),
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
            stop: StopSignal::new(),
            time_base: Duration::ZERO,
        });
        driver.run(&wav).unwrap();
        let secs = crate::transcription::audio::wav_duration(&wav)
            .expect("the WAV must be readable")
            .as_secs_f32();
        assert!(
            (secs - 0.3).abs() < 0.02,
            "expected 0.3 s (0.2 plus the 0.1 s tail), got {secs}"
        );
    }

    /// A paired chunk with distinct per-channel amplitudes, so a channel swap or
    /// desync is visible in the written WAV.
    fn stereo_chunk_at(ms: u64, samples: usize) -> crate::transcription::audio::AudioChunk {
        crate::transcription::audio::AudioChunk {
            samples: vec![0.1; samples],
            mic: Some(vec![0.3; samples]),
            offset: Duration::from_millis(ms),
        }
    }

    #[test]
    fn a_capture_gap_on_a_paired_capture_pads_both_channels_in_lockstep() {
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let wav = store_dir.path().join("gapped-stereo.wav");
        let id = mk_session(&store, &wav);
        let driver = TranscriptDriver::new(DriverConfig {
            id,
            store: store.clone(),
            audio: Box::new(ScriptedChunkStream {
                chunks: vec![stereo_chunk_at(0, 3_200), stereo_chunk_at(10_000, 3_200)],
            }),
            transcriber: live(MockTranscriber::new()),
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
            stop: StopSignal::new(),
            time_base: Duration::ZERO,
        });
        driver.run(&wav).unwrap();
        let (channels, _) = crate::transcription::audio::parse_wav_to_channels_f32(&wav).unwrap();
        assert_eq!(channels.len(), 2);
        let frames = channels[0].len();
        assert_eq!(frames, channels[1].len());
        assert!(
            (frames as f32 / 16_000.0 - 10.2).abs() < 0.05,
            "expected ~10.2 s of frames per channel, got {frames}"
        );
        let tail = frames - 1_600;
        assert!(
            (channels[0][tail] - 0.1).abs() < 0.02,
            "sys channel desynced after the gap"
        );
        assert!(
            (channels[1][tail] - 0.3).abs() < 0.02,
            "mic channel desynced after the gap"
        );
        assert!(channels[0][frames / 2].abs() < 1e-6);
        assert!(channels[1][frames / 2].abs() < 1e-6);
    }

    #[test]
    fn a_backwards_offset_correction_keeps_paired_channels_aligned() {
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let wav = store_dir.path().join("overlap-stereo.wav");
        let id = mk_session(&store, &wav);
        let driver = TranscriptDriver::new(DriverConfig {
            id,
            store: store.clone(),
            audio: Box::new(ScriptedChunkStream {
                chunks: vec![stereo_chunk_at(0, 3_200), stereo_chunk_at(100, 3_200)],
            }),
            transcriber: live(MockTranscriber::new()),
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
            stop: StopSignal::new(),
            time_base: Duration::ZERO,
        });
        driver.run(&wav).unwrap();
        let (channels, _) = crate::transcription::audio::parse_wav_to_channels_f32(&wav).unwrap();
        assert_eq!(channels.len(), 2);
        let frames = channels[0].len();
        assert_eq!(frames, channels[1].len());
        assert!(
            (frames as f32 / 16_000.0 - 0.3).abs() < 0.02,
            "expected 0.3 s per channel, got {frames} frames"
        );
        assert!(channels[0].iter().all(|&s| (s - 0.1).abs() < 0.02));
        assert!(channels[1].iter().all(|&s| (s - 0.3).abs() < 0.02));
    }

    /// Endless 200 ms chunks, counting what the driver has pulled. The small sleep keeps the
    /// generated WAV to a sane size while still outrunning any blocked decoder.
    struct CountingStream {
        pulled: Arc<std::sync::atomic::AtomicUsize>,
        next_offset_ms: u64,
    }

    impl AudioStream for CountingStream {
        fn next_chunk(
            &mut self,
        ) -> Result<Option<crate::transcription::audio::AudioChunk>, CaptureError> {
            std::thread::sleep(Duration::from_millis(1));
            let chunk = chunk_at(self.next_offset_ms, 3_200, None);
            self.next_offset_ms += 200;
            self.pulled.fetch_add(1, Ordering::SeqCst);
            Ok(Some(chunk))
        }
    }

    /// Blocks inside `transcribe` until the test releases it, standing in for a host where the
    /// whisper decode takes far longer than the audio it covers.
    struct GatedTranscriber {
        entered: Arc<std::sync::atomic::AtomicUsize>,
        gate: std::sync::mpsc::Receiver<()>,
    }

    impl Transcriber for GatedTranscriber {
        fn transcribe(
            &mut self,
            _pcm: &[f32],
            _opts: &TranscribeOptions,
        ) -> Result<Vec<Segment>, crate::transcription::transcriber::TranscribeError> {
            self.entered.fetch_add(1, Ordering::SeqCst);
            let _ = self.gate.recv();
            Ok(Vec::new())
        }
    }

    /// Spins until `probe` holds or the deadline passes; reports whether it ever held.
    fn wait_until(deadline: Duration, mut probe: impl FnMut() -> bool) -> bool {
        let start = std::time::Instant::now();
        while start.elapsed() < deadline {
            if probe() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        probe()
    }

    #[test]
    fn capture_keeps_being_ingested_while_the_transcriber_is_blocked() {
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let wav = store_dir.path().join("decoupled.wav");
        let id = mk_session(&store, &wav);
        let pulled = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let entered = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let (release, gate) = std::sync::mpsc::channel::<()>();
        let stop = StopSignal::new();
        let driver = TranscriptDriver::new(DriverConfig {
            id,
            store: store.clone(),
            audio: Box::new(CountingStream {
                pulled: Arc::clone(&pulled),
                next_offset_ms: 0,
            }),
            transcriber: live(GatedTranscriber {
                entered: Arc::clone(&entered),
                gate,
            }),
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
            stop: stop.clone(),
            time_base: Duration::ZERO,
        });
        let run_wav = wav.clone();
        let handle = std::thread::spawn(move || driver.run(&run_wav));

        assert!(
            wait_until(Duration::from_secs(10), || entered.load(Ordering::SeqCst)
                >= 1),
            "the transcriber should have been called"
        );
        let at_block = pulled.load(Ordering::SeqCst);
        assert!(
            wait_until(Duration::from_secs(10), || pulled.load(Ordering::SeqCst)
                >= at_block + 20),
            "ingestion stalled behind the blocked transcriber (pulled stuck at {at_block})"
        );

        stop.stop();
        drop(release);
        let _ = handle.join().expect("the driver thread must not panic");
        assert!(
            crate::transcription::audio::wav_duration(&wav).is_some_and(|d| d > Duration::ZERO),
            "the recording must be finalized and non-empty"
        );
    }

    #[test]
    fn record_only_session_records_levels_and_finalizes_without_a_transcriber() {
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let wav = store_dir.path().join("record-only.wav");
        let id = mk_session(&store, &wav);
        let mut sub = store.subscribe(id).unwrap();
        let driver = TranscriptDriver::new(DriverConfig {
            id,
            store: store.clone(),
            audio: Box::new(ScriptedChunkStream {
                chunks: vec![
                    chunk_at(0, 3_200, Some(3_200)),
                    chunk_at(200, 3_200, Some(3_200)),
                ],
            }),
            transcriber: None,
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
            stop: StopSignal::new(),
            time_base: Duration::ZERO,
        });
        driver.run(&wav).unwrap();

        let snap = store.get(id).unwrap();
        assert!(matches!(snap.status, TranscriptStatus::Finalizing { .. }));
        assert_eq!(
            crate::transcription::audio::wav_duration(&wav),
            Some(Duration::from_millis(400))
        );
        assert!(snap.live_segments.is_empty());
        assert_eq!(snap.live_draft, "");
        let mut level_events = 0;
        while let Ok(ev) = sub.events.try_recv() {
            if let crate::transcription::TranscriptEvent::AudioLevel { levels, .. } = ev {
                level_events += 1;
                assert_eq!(levels.len(), 2, "paired capture reports [system, mic]");
                assert!(levels.iter().all(|l| (0.0..=1.0).contains(l)));
            }
        }
        assert!(level_events >= 1, "the first chunk must emit a level");
    }

    fn write_test_wav(path: &Path, channels: u16, secs: f32) {
        let mut w = hound::WavWriter::create(
            path,
            hound::WavSpec {
                channels,
                sample_rate: 16_000,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            },
        )
        .unwrap();
        for i in 0..(secs * 16_000.0) as usize {
            let v = (0.1
                * (2.0 * std::f32::consts::PI * 220.0 * i as f32 / 16_000.0).sin()
                * 32_767.0) as i16;
            for _ in 0..channels {
                w.write_sample(v).unwrap();
            }
        }
        w.finalize().unwrap();
    }

    use crate::transcription::diarizer::Diarizer;

    type OnDiarize = Box<dyn FnMut(&DecodeCancel) + Send>;

    struct ScriptedDiarizer {
        result: Result<Vec<crate::transcription::diarizer::SpeakerTurn>, String>,
        received: Arc<Mutex<Vec<usize>>>,
        on_diarize: Option<OnDiarize>,
    }

    impl ScriptedDiarizer {
        fn new(
            result: Result<Vec<crate::transcription::diarizer::SpeakerTurn>, String>,
        ) -> (Self, Arc<Mutex<Vec<usize>>>) {
            let received = Arc::new(Mutex::new(Vec::new()));
            (
                Self {
                    result,
                    received: received.clone(),
                    on_diarize: None,
                },
                received,
            )
        }
    }

    impl Diarizer for ScriptedDiarizer {
        fn diarize(
            &mut self,
            pcm: &[f32],
            cancel: &DecodeCancel,
        ) -> Result<
            Vec<crate::transcription::diarizer::SpeakerTurn>,
            crate::transcription::diarizer::DiarizeError,
        > {
            self.received.lock().unwrap().push(pcm.len());
            if let Some(f) = self.on_diarize.as_mut() {
                f(cancel);
            }
            self.result
                .clone()
                .map_err(crate::transcription::diarizer::DiarizeError::Inference)
        }
    }

    fn turn_secs(
        start: u64,
        end: u64,
        speaker: u32,
    ) -> crate::transcription::diarizer::SpeakerTurn {
        crate::transcription::diarizer::SpeakerTurn {
            start: Duration::from_secs(start),
            end: Duration::from_secs(end),
            speaker,
        }
    }

    fn loader(diarizer: impl Diarizer + 'static) -> Option<DiarizerLoader> {
        Some(Box::new(
            move || Ok(Box::new(diarizer) as Box<dyn Diarizer>),
        ))
    }

    fn finalize_with(
        store: &Arc<TranscriptStore>,
        id: Uuid,
        audio_paths: Vec<PathBuf>,
        diarizer: Option<DiarizerLoader>,
    ) -> Result<(), DriverError> {
        finalize_with_transcriber(
            store,
            id,
            audio_paths,
            Box::new(MockTranscriber {
                seg_secs: 2.0,
                text_template: "f{n}".to_string(),
            }),
            diarizer,
        )
    }

    fn finalize_with_transcriber(
        store: &Arc<TranscriptStore>,
        id: Uuid,
        audio_paths: Vec<PathBuf>,
        transcriber: Box<dyn Transcriber>,
        diarizer: Option<DiarizerLoader>,
    ) -> Result<(), DriverError> {
        run_finalize(FinalizeConfig {
            pass: store.claim_finalizing(id),
            id,
            store: store.clone(),
            audio_paths,
            transcriber,
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
            diarizer,
        })
    }

    struct OnDropTranscriber {
        inner: MockTranscriber,
        on_drop: Option<Box<dyn FnOnce() + Send>>,
    }

    impl OnDropTranscriber {
        fn boxed(on_drop: impl FnOnce() + Send + 'static) -> Box<dyn Transcriber> {
            Box::new(Self {
                inner: MockTranscriber {
                    seg_secs: 2.0,
                    text_template: "f{n}".to_string(),
                },
                on_drop: Some(Box::new(on_drop)),
            })
        }
    }

    impl Transcriber for OnDropTranscriber {
        fn transcribe(
            &mut self,
            pcm: &[f32],
            opts: &TranscribeOptions,
        ) -> Result<Vec<Segment>, crate::transcription::transcriber::TranscribeError> {
            self.inner.transcribe(pcm, opts)
        }
    }

    impl Drop for OnDropTranscriber {
        fn drop(&mut self) {
            if let Some(on_drop) = self.on_drop.take() {
                on_drop();
            }
        }
    }

    struct CapturingDiarizer(Arc<Mutex<Option<Vec<f32>>>>);

    impl Diarizer for CapturingDiarizer {
        fn diarize(
            &mut self,
            pcm: &[f32],
            _cancel: &DecodeCancel,
        ) -> Result<
            Vec<crate::transcription::diarizer::SpeakerTurn>,
            crate::transcription::diarizer::DiarizeError,
        > {
            *self.0.lock().unwrap() = Some(pcm.to_vec());
            Ok(vec![turn_secs(0, 2, 0)])
        }
    }

    fn write_stereo_wav(path: &Path, frames: &[(i16, i16)]) {
        let spec = hound::WavSpec {
            channels: 2,
            sample_rate: SAMPLE_RATE_HZ,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut w = hound::WavWriter::create(path, spec).unwrap();
        for &(meeting, mic) in frames {
            w.write_sample(meeting).unwrap();
            w.write_sample(mic).unwrap();
        }
        w.finalize().unwrap();
    }

    fn tone_frames(secs: u32, meeting: i16, mic: i16) -> Vec<(i16, i16)> {
        (0..secs * SAMPLE_RATE_HZ)
            .map(|i| {
                let sign = if i % 2 == 0 { 1 } else { -1 };
                (sign * meeting, sign * mic)
            })
            .collect()
    }

    fn speakers_by_source(
        segs: &[Segment],
    ) -> Vec<(Duration, Option<TranscriptSource>, Option<u32>)> {
        segs.iter()
            .map(|s| (s.start, s.source, s.speaker_id))
            .collect()
    }

    #[test]
    fn run_finalize_labels_meeting_segments_with_speakers_and_records_the_diarization() {
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let id = mk_session(&store, &store_dir.path().join("a.wav"));
        let wav = store_dir.path().join("stereo.wav");
        write_test_wav(&wav, 2, 4.0);

        finalize_with(
            &store,
            id,
            vec![wav],
            loader(crate::transcription::diarizer::MockDiarizer::new(2)),
        )
        .unwrap();

        let snap = store.get(id).unwrap();
        assert!(matches!(snap.status, TranscriptStatus::Done));
        let finals = snap.final_segments.clone().unwrap();
        for seg in &finals {
            match seg.source {
                Some(TranscriptSource::System) => assert!(seg.speaker_id.is_some()),
                _ => assert_eq!(seg.speaker_id, None, "microphone segments stay unlabelled"),
            }
        }
        let system: Vec<Option<u32>> = finals
            .iter()
            .filter(|s| s.source == Some(TranscriptSource::System))
            .map(|s| s.speaker_id)
            .collect();
        assert_eq!(system, vec![Some(1), Some(2)]);
        assert_eq!(
            snap.models_used.diarization.as_deref(),
            Some(DIARIZATION_MODEL.key)
        );
        assert!(snap.diarization_secs.is_some_and(|s| s >= 0.0));
        assert!(snap.active_warnings.is_empty());
    }

    #[test]
    fn run_finalize_never_calls_the_diarizer_on_a_mono_recording() {
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let id = mk_session(&store, &store_dir.path().join("a.wav"));
        let (_g, wav) = make_fixture_wav(4.0);
        let (diarizer, received) = ScriptedDiarizer::new(Ok(vec![turn_secs(0, 4, 0)]));

        finalize_with(&store, id, vec![wav], loader(diarizer)).unwrap();

        assert!(received.lock().unwrap().is_empty());
        let snap = store.get(id).unwrap();
        assert!(matches!(snap.status, TranscriptStatus::Done));
        assert!(snap
            .final_segments
            .unwrap()
            .iter()
            .all(|s| s.speaker_id.is_none()));
        assert_eq!(snap.models_used.diarization, None);
        assert!(snap.active_warnings.is_empty());
    }

    #[test]
    fn run_finalize_never_calls_the_diarizer_when_whisper_heard_nothing_on_the_meeting_channel() {
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let id = mk_session(&store, &store_dir.path().join("a.wav"));
        let wav = store_dir.path().join("stereo.wav");
        write_test_wav(&wav, 2, 4.0);
        let (diarizer, received) = ScriptedDiarizer::new(Ok(vec![turn_secs(0, 4, 0)]));
        let loaded = Arc::new(AtomicBool::new(false));
        let loaded_flag = loaded.clone();
        let load: DiarizerLoader = Box::new(move || {
            loaded_flag.store(true, Ordering::SeqCst);
            Ok(Box::new(diarizer) as Box<dyn Diarizer>)
        });
        let transcriber = ScriptedTranscriber {
            script: vec![Vec::new(), vec![seg_at(0.0, 2.0, "mic")]],
            call: 0,
        };

        finalize_with_transcriber(&store, id, vec![wav], Box::new(transcriber), Some(load))
            .unwrap();

        assert!(!loaded.load(Ordering::SeqCst), "the model is never loaded");
        assert!(received.lock().unwrap().is_empty());
        let snap = store.get(id).unwrap();
        assert!(matches!(snap.status, TranscriptStatus::Done));
        assert_eq!(
            speakers_by_source(&snap.final_segments.unwrap()),
            vec![(Duration::ZERO, Some(TranscriptSource::Mic), None)]
        );
        assert_eq!(snap.models_used.diarization, None);
        assert_eq!(snap.diarization_secs, None);
        assert!(snap.active_warnings.is_empty());
    }

    #[test]
    fn a_failed_diarization_finishes_the_transcript_without_labels_and_warns() {
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let id = mk_session(&store, &store_dir.path().join("a.wav"));
        let wav = store_dir.path().join("stereo.wav");
        write_test_wav(&wav, 2, 4.0);
        let (diarizer, received) = ScriptedDiarizer::new(Err("gpu lost".to_string()));

        finalize_with(&store, id, vec![wav], loader(diarizer)).unwrap();

        assert_eq!(received.lock().unwrap().len(), 1);
        let snap = store.get(id).unwrap();
        assert!(matches!(snap.status, TranscriptStatus::Done));
        let finals = snap.final_segments.unwrap();
        assert_eq!(finals.len(), 4);
        assert!(finals.iter().all(|s| s.speaker_id.is_none()));
        assert_eq!(snap.models_used.diarization, None);
        assert_eq!(snap.diarization_secs, None);
        assert_eq!(
            snap.active_warnings,
            vec![CaptureWarning::SpeakerAttributionFailed]
        );
    }

    #[test]
    fn diarization_sees_every_part_on_the_transcript_timeline() {
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let id = mk_session(&store, &store_dir.path().join("a.wav"));
        let part1 = store_dir.path().join("audio.wav");
        let part2 = store_dir.path().join("audio-2.wav");
        let part3 = store_dir.path().join("audio-3.wav");
        write_test_wav(&part1, 2, 2.0);
        write_test_wav(&part2, 1, 2.0);
        write_test_wav(&part3, 2, 2.0);
        let (diarizer, received) =
            ScriptedDiarizer::new(Ok(vec![turn_secs(0, 2, 9), turn_secs(4, 6, 4)]));

        finalize_with(&store, id, vec![part1, part2, part3], loader(diarizer)).unwrap();

        assert_eq!(
            *received.lock().unwrap(),
            vec![6 * 16_000],
            "the meeting channel spans all three parts, the mono one as silence"
        );
        let finals = store.get(id).unwrap().final_segments.unwrap();
        assert_eq!(
            speakers_by_source(&finals),
            vec![
                (Duration::ZERO, Some(TranscriptSource::System), Some(1)),
                (Duration::ZERO, Some(TranscriptSource::Mic), None),
                (Duration::from_secs(2), None, None),
                (
                    Duration::from_secs(4),
                    Some(TranscriptSource::System),
                    Some(2)
                ),
                (Duration::from_secs(4), Some(TranscriptSource::Mic), None),
            ]
        );
    }

    #[test]
    fn a_pass_put_off_during_diarization_writes_nothing() {
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let id = mk_session(&store, &store_dir.path().join("a.wav"));
        let wav = store_dir.path().join("stereo.wav");
        write_test_wav(&wav, 2, 4.0);
        let (mut diarizer, received) = ScriptedDiarizer::new(Ok(vec![turn_secs(0, 4, 0)]));
        let postpone_from = store.clone();
        diarizer.on_diarize = Some(Box::new(move |cancel| {
            assert!(!cancel.is_cancelled());
            postpone_from.postpone(id).unwrap();
            assert!(
                cancel.is_cancelled(),
                "the cancel flag the diarizer polls is the pass's own"
            );
        }));

        let err = finalize_with(&store, id, vec![wav], loader(diarizer)).unwrap_err();

        assert!(matches!(err, DriverError::Superseded), "{err:?}");
        assert_eq!(received.lock().unwrap().len(), 1);
        let snap = store.get(id).unwrap();
        assert!(matches!(snap.status, TranscriptStatus::Postponed));
        assert_eq!(snap.final_segments, None);
        assert_eq!(snap.models_used.diarization, None);
    }

    #[test]
    fn transcribing_again_without_diarization_drops_the_speaker_labels() {
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let id = mk_session(&store, &store_dir.path().join("a.wav"));
        let wav = store_dir.path().join("stereo.wav");
        write_test_wav(&wav, 2, 4.0);
        finalize_with(
            &store,
            id,
            vec![wav.clone()],
            loader(crate::transcription::diarizer::MockDiarizer::new(2)),
        )
        .unwrap();
        assert!(store.get(id).unwrap().models_used.diarization.is_some());

        finalize_with(&store, id, vec![wav], None).unwrap();

        let snap = store.get(id).unwrap();
        assert!(matches!(snap.status, TranscriptStatus::Done));
        assert!(snap
            .final_segments
            .unwrap()
            .iter()
            .all(|s| s.speaker_id.is_none()));
        assert_eq!(snap.models_used.diarization, None);
        assert_eq!(snap.diarization_secs, None);
    }

    #[test]
    fn the_diarizer_loads_only_after_whisper_finished_and_a_failed_load_only_warns() {
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let id = mk_session(&store, &store_dir.path().join("a.wav"));
        let wav = store_dir.path().join("stereo.wav");
        write_test_wav(&wav, 2, 4.0);
        let whisper_dropped = Arc::new(AtomicBool::new(false));
        let dropped_at_load = Arc::new(AtomicBool::new(false));
        let (seen_dropped, seen) = (whisper_dropped.clone(), dropped_at_load.clone());
        let mark_dropped = whisper_dropped.clone();
        let store_for_load = store.clone();
        let load: DiarizerLoader = Box::new(move || {
            match store_for_load.get(id).unwrap().status {
                TranscriptStatus::Finalizing { .. } => {}
                other => panic!("loaded outside the pass: {other:?}"),
            }
            seen.store(seen_dropped.load(Ordering::SeqCst), Ordering::SeqCst);
            Err(DiarizeError::ModelLoad {
                model: "m.gguf".to_string(),
                detail: "no metal device".to_string(),
            })
        });
        let transcriber =
            OnDropTranscriber::boxed(move || mark_dropped.store(true, Ordering::SeqCst));

        finalize_with_transcriber(&store, id, vec![wav], transcriber, Some(load)).unwrap();

        assert!(
            dropped_at_load.load(Ordering::SeqCst),
            "the diarizer loaded while Whisper was still held"
        );
        let snap = store.get(id).unwrap();
        assert!(matches!(snap.status, TranscriptStatus::Done));
        assert!(snap
            .final_segments
            .unwrap()
            .iter()
            .all(|s| s.speaker_id.is_none()));
        assert_eq!(snap.models_used.diarization, None);
        assert_eq!(
            snap.active_warnings,
            vec![CaptureWarning::SpeakerAttributionFailed]
        );
    }

    #[test]
    fn a_missing_model_at_load_raises_the_model_missing_warning_and_the_pass_still_ends_done() {
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let id = mk_session(&store, &store_dir.path().join("a.wav"));
        let wav = store_dir.path().join("stereo.wav");
        write_test_wav(&wav, 2, 4.0);
        let load: DiarizerLoader =
            Box::new(|| Err(DiarizeError::ModelMissing("m.gguf".to_string())));

        finalize_with(&store, id, vec![wav], Some(load)).unwrap();

        let snap = store.get(id).unwrap();
        assert!(matches!(snap.status, TranscriptStatus::Done));
        assert_eq!(
            snap.active_warnings,
            vec![CaptureWarning::SpeakerModelMissing]
        );
        assert_eq!(snap.models_used.diarization, None);
    }

    #[test]
    fn a_session_deleted_during_diarization_ends_the_pass_as_deleted_and_writes_nothing() {
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let id = mk_session(&store, &store_dir.path().join("a.wav"));
        let wav = store_dir.path().join("stereo.wav");
        write_test_wav(&wav, 2, 4.0);
        let (mut diarizer, _received) = ScriptedDiarizer::new(Ok(vec![turn_secs(0, 4, 0)]));
        let delete_from = store.clone();
        diarizer.on_diarize = Some(Box::new(move |_| delete_from.delete(id).unwrap()));

        let result = finalize_with(&store, id, vec![wav], loader(diarizer));

        assert!(matches!(result, Err(DriverError::Deleted)), "{result:?}");
        assert!(matches!(store.get(id), Err(StoreError::NotFound(_))));
    }

    #[test]
    fn the_diarizer_receives_channel_zero_of_the_stereo_parts_on_the_transcript_timeline() {
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let id = mk_session(&store, &store_dir.path().join("a.wav"));
        let part1 = store_dir.path().join("audio.wav");
        let part2 = store_dir.path().join("audio-2.wav");
        let part3 = store_dir.path().join("audio-3.wav");
        write_stereo_wav(&part1, &tone_frames(2, 8_192, 1_000));
        write_test_wav(&part2, 1, 2.0);
        write_stereo_wav(&part3, &tone_frames(2, -16_384, 2_000));
        let received = Arc::new(Mutex::new(None));

        finalize_with(
            &store,
            id,
            vec![part1, part2, part3],
            loader(CapturingDiarizer(received.clone())),
        )
        .unwrap();

        let frames = 2 * SAMPLE_RATE_HZ as usize;
        let alternating = |amp: f32| (0..frames).map(move |i| if i % 2 == 0 { amp } else { -amp });
        let expected: Vec<f32> = alternating(0.25)
            .chain(std::iter::repeat_n(0.0, frames))
            .chain(alternating(-0.5))
            .collect();
        assert_eq!(
            received.lock().unwrap().as_deref(),
            Some(expected.as_slice()),
            "the meeting channel of both stereo parts, the mono part as silence between them"
        );
    }

    #[test]
    fn the_meeting_channel_is_read_only_after_whisper_is_released() {
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let id = mk_session(&store, &store_dir.path().join("a.wav"));
        let wav = store_dir.path().join("stereo.wav");
        write_stereo_wav(&wav, &tone_frames(4, 8_192, 1_000));
        let rewrite = wav.clone();
        let transcriber = OnDropTranscriber::boxed(move || {
            write_stereo_wav(&rewrite, &tone_frames(4, 16_384, 1_000));
        });
        let received = Arc::new(Mutex::new(None));

        finalize_with_transcriber(
            &store,
            id,
            vec![wav],
            transcriber,
            loader(CapturingDiarizer(received.clone())),
        )
        .unwrap();

        let pcm = received.lock().unwrap().take().unwrap();
        assert_eq!(pcm.len(), 4 * SAMPLE_RATE_HZ as usize);
        assert!(
            pcm.iter().all(|s| s.abs() == 0.5),
            "the diarizer got the meeting channel as it was on disk after Whisper was dropped"
        );
    }

    #[test]
    fn a_meeting_part_unreadable_after_whisper_leaves_the_transcript_done_without_labels() {
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let id = mk_session(&store, &store_dir.path().join("a.wav"));
        let wav = store_dir.path().join("stereo.wav");
        write_test_wav(&wav, 2, 4.0);
        let remove = wav.clone();
        let transcriber = OnDropTranscriber::boxed(move || std::fs::remove_file(&remove).unwrap());
        let (diarizer, received) = ScriptedDiarizer::new(Ok(vec![turn_secs(0, 4, 0)]));

        finalize_with_transcriber(&store, id, vec![wav], transcriber, loader(diarizer)).unwrap();

        assert!(received.lock().unwrap().is_empty());
        let snap = store.get(id).unwrap();
        assert!(matches!(snap.status, TranscriptStatus::Done));
        assert!(snap
            .final_segments
            .unwrap()
            .iter()
            .all(|s| s.speaker_id.is_none()));
        assert_eq!(snap.models_used.diarization, None);
        assert_eq!(
            snap.active_warnings,
            vec![CaptureWarning::SpeakerAttributionFailed]
        );
    }

    #[test]
    fn a_missing_model_is_reported_before_the_meeting_channel_is_read() {
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let id = mk_session(&store, &store_dir.path().join("a.wav"));
        let wav = store_dir.path().join("stereo.wav");
        write_test_wav(&wav, 2, 4.0);
        let remove = wav.clone();
        let transcriber = OnDropTranscriber::boxed(move || std::fs::remove_file(&remove).unwrap());
        let load: DiarizerLoader =
            Box::new(|| Err(DiarizeError::ModelMissing("m.gguf".to_string())));

        finalize_with_transcriber(&store, id, vec![wav], transcriber, Some(load)).unwrap();

        assert_eq!(
            store.get(id).unwrap().active_warnings,
            vec![CaptureWarning::SpeakerModelMissing],
            "an unreadable part must not hide that the model is not downloaded"
        );
    }

    #[test]
    fn a_meeting_part_whose_length_changed_after_whisper_is_not_diarized() {
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let id = mk_session(&store, &store_dir.path().join("a.wav"));
        let wav = store_dir.path().join("stereo.wav");
        write_stereo_wav(&wav, &tone_frames(4, 8_192, 1_000));
        let rewrite = wav.clone();
        let transcriber = OnDropTranscriber::boxed(move || {
            write_stereo_wav(&rewrite, &tone_frames(3, 8_192, 1_000));
        });
        let (diarizer, received) = ScriptedDiarizer::new(Ok(vec![turn_secs(0, 4, 0)]));

        finalize_with_transcriber(&store, id, vec![wav], transcriber, loader(diarizer)).unwrap();

        assert!(received.lock().unwrap().is_empty());
        let snap = store.get(id).unwrap();
        assert!(matches!(snap.status, TranscriptStatus::Done));
        assert_eq!(snap.models_used.diarization, None);
        assert_eq!(
            snap.active_warnings,
            vec![CaptureWarning::SpeakerAttributionFailed]
        );
    }

    #[test]
    fn a_pass_put_off_before_the_meeting_channel_is_read_never_diarizes() {
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let id = mk_session(&store, &store_dir.path().join("a.wav"));
        let wav = store_dir.path().join("stereo.wav");
        write_test_wav(&wav, 2, 4.0);
        let (diarizer, received) = ScriptedDiarizer::new(Ok(vec![turn_secs(0, 4, 0)]));
        let postpone_from = store.clone();
        let load: DiarizerLoader = Box::new(move || {
            postpone_from.postpone(id).unwrap();
            Ok(Box::new(diarizer) as Box<dyn Diarizer>)
        });

        let err = finalize_with(&store, id, vec![wav], Some(load)).unwrap_err();

        assert!(matches!(err, DriverError::Superseded), "{err:?}");
        assert!(received.lock().unwrap().is_empty());
        let snap = store.get(id).unwrap();
        assert!(matches!(snap.status, TranscriptStatus::Postponed));
        assert_eq!(snap.final_segments, None);
    }

    #[test]
    fn the_meeting_buffer_reserves_up_to_the_end_of_the_last_stereo_part_and_nothing_for_mono() {
        let rate = u64::from(SAMPLE_RATE_HZ);
        assert_eq!(system_pcm_end(Duration::ZERO, 5 * rate, 1), 0);
        assert_eq!(system_pcm_end(Duration::from_secs(3), 5 * rate, 1), 0);
        assert_eq!(system_pcm_end(Duration::ZERO, 0, 2), 0);
        assert_eq!(
            system_pcm_end(Duration::from_millis(2500), 4 * rate, 2),
            (2.5 * rate as f64) as u64 + 4 * rate
        );

        let parts = [
            (Duration::ZERO, 3 * rate, 1),
            (Duration::from_secs(3), 2 * rate, 2),
            (Duration::from_secs(5), 7 * rate, 1),
        ];
        let reserved = parts
            .iter()
            .map(|&(base, frames, channels)| system_pcm_end(base, frames, channels))
            .max()
            .unwrap_or(0);
        assert_eq!(reserved, frame_at(Duration::from_secs(3)) as u64 + 2 * rate);
    }
}
