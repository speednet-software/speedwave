//! Background task pumping AudioStream → Transcriber → TranscriptStore.

use std::collections::VecDeque;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use uuid::Uuid;

use crate::transcription::audio::{AudioStream, CaptureHealth, SAMPLE_RATE_HZ};
use crate::transcription::transcriber::{
    Segment, TranscribeOptions, Transcriber, TranscriptSource,
};
use crate::transcription::transcript::TranscriptStatus;
use crate::transcription::transcript_store::TranscriptStore;

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

/// Cadence of `TranscriptEvent::AudioLevel` while chunks flow — fast enough for a lively meter,
/// slow enough to stay negligible next to the ~200 ms capture chunks (ADR-056 Am. 13).
const LEVEL_EMIT_INTERVAL: Duration = Duration::from_millis(250);

/// A stop signal shared with the driver task; flip to `true` to wind down at the next chunk
/// boundary. Carries a `Notify` pulsed on `run()` exit, so callers `await` instead of spin-polling.
#[derive(Debug, Clone, Default)]
pub struct StopSignal {
    stopped: Arc<AtomicBool>,
    finished: Arc<tokio::sync::Notify>,
}

impl StopSignal {
    /// A new, un-tripped signal.
    pub fn new() -> Self {
        Self {
            stopped: Arc::new(AtomicBool::new(false)),
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
        // Once per process: the mutex stays poisoned, and this is called on every loop tick.
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
    // A panicking loop must still flip `finished` and surface an error — otherwise the decode
    // loop polls a dead capture forever and the session reports success (silently truncated).
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
    // A broken WAV breaks the offline pass too — a finalize failure is a session error.
    if let Err(e) = result.and(finalized) {
        g.error = Some(e);
    }
}
/// Pumps capture chunks into `wav` and the shared rings. Every chunk is placed at the absolute
/// position its offset declares, so a source that went idle leaves silence rather than a splice.
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
    // Frames already written to the WAV — the absolute timeline every chunk offset lands on.
    let mut written: u64 = 0;
    // `None` until the first chunk: the meter shows up immediately, then throttles.
    let mut last_level_emit: Option<std::time::Instant> = None;
    // One-shot: a corrupt offset repeats on every following chunk — log the splice once.
    let mut corrupt_offset_reported = false;
    loop {
        if stop.is_stopped() {
            return Ok(());
        }
        let next = audio.next_chunk();
        // Drain queued health before matching `next` — a stall that ends the stream with `Err`
        // may have queued its warning on the same call.
        let health = audio.take_health();
        if !health.is_empty() {
            lock_ingest(shared).health.extend(health);
        }
        let chunk = match next {
            Ok(Some(c)) => c,
            Ok(None) => return Ok(()), // stream ended
            Err(e) => return Err(DriverError::Capture(e.to_string())),
        };
        // Idle keepalive: nothing to place — loop back so `stop` is re-checked. Must stay
        // above the channel-count check (a keepalive has `mic: None` on any stream shape).
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
                // The lane count (and the WAV's channel layout) is fixed by the first chunk;
                // a mid-stream mic flip would corrupt the WAV or silently drop mic PCM.
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
            // Corrupt offset: splice at `written` with no padding — clamping would re-pad the
            // remainder on every following chunk and snowball hours of silence.
            if !corrupt_offset_reported {
                corrupt_offset_reported = true;
                log::error!(
                    "capture offset implies a {gap}-sample gap — spliced without padding; timestamps past this point shift"
                );
            }
        } else if gap > 0 {
            log::debug!(
                "padding {:.1}s of silence for a capture gap",
                gap as f32 / SAMPLE_RATE_HZ as f32
            );
            writer.write_silence(gap, channels as u16)?;
            written += gap;
            let mut g = lock_ingest(shared);
            for lane in g.lanes.iter_mut() {
                lane.push_silence(gap);
            }
        }
        // A backwards offset correction re-declares audio already written; only its tail is new.
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
        // Loudness meter: emitted from this thread — the decode side blocks inside whisper for
        // seconds at a time and would freeze the meter exactly when reassurance matters.
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
        // Mark the session as Recording (a no-op transition from new()).
        let _ = self.store.set_status(self.id, TranscriptStatus::Recording);
        let Some(audio) = self.audio.take() else {
            return Err(DriverError::Capture(
                "driver started without a capture stream".to_string(),
            ));
        };
        // Capture runs on its own thread: the recording must stay complete and its WAV finalized
        // even when the transcriber is far behind (the offline pass reads it right after stop).
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
        // Wind the ingest down and wait for the WAV to be finalized before reporting anything.
        self.stop.stop();
        let joined = ingest.join();
        // Health queued after the decode loop's last poll (e.g. during a long final decode or
        // the wind-down itself) — including the one-shot AudioDropped — must still land.
        {
            let health = std::mem::take(&mut lock_ingest(&self.ingest).health);
            self.forward_health(health);
        }
        // An ingest failure landing after the decode loop's last poll (or during wind-down,
        // e.g. WAV finalize) must not let a broken recording report success.
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
                // Final live decode flushes the not-yet-agreed tail (no further
                // pass will confirm it), then hand off to the finalize pass.
                if self.transcriber.is_some() {
                    let _ = self.decode_final_window();
                }
                let _ = self
                    .store
                    .set_status(self.id, TranscriptStatus::Finalizing { progress: 0.0 });
                Ok(())
            }
            Err(e) => {
                // Retract a stale draft before flipping to Failed — nothing will flush it now.
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
            // Nothing to decode yet (no lanes) or record-only (no live transcriber):
            // capture health and lifecycle only.
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
                // Drain the last partial window so a short recording still gets decoded.
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
        // Copy every lane's window under one lock so the channels stay aligned, then decode
        // outside it — whisper must never hold up the ingest thread.
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

        // Collect every ripe commit first — one fsync'd save for the cycle, not one durable
        // write per segment; unripe tails stream separately as a replace-only draft.
        let mut batch = Vec::new();
        let mut drafts = Vec::new();
        for (lane_idx, (win_start, window)) in windows.iter().enumerate() {
            let source = self.lanes[lane_idx].source;
            let window_start = Duration::from_secs_f32(*win_start as f32 / SAMPLE_RATE_HZ as f32);
            let (mut lane_batch, draft) =
                self.decode_lane_window(lane_idx, window, window_start, flush, horizon)?;
            batch.append(&mut lane_batch);
            if !draft.is_empty() {
                // Label paired-capture drafts like committed lines and markdown.
                drafts.push(match source {
                    Some(src) => format!("{}: {draft}", src.label()),
                    None => draft,
                });
            }
        }
        // Cross-lane commits interleave chronologically within the cycle; on a
        // resumed session times shift past the earlier parts.
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
            // Unreachable by construction (every decode path is gated on a live transcriber) —
            // fail loud instead of silently decoding nothing if a future gating bug lands here.
            return Err(DriverError::Transcribe(
                "decode reached on a record-only session (driver bug)".to_string(),
            ));
        };
        let segs = transcriber
            .feed(window, &self.transcribe_opts)
            .map_err(|e| DriverError::Transcribe(e.to_string()))?;
        // Window-relative timestamps → absolute, tagged with the lane's channel.
        let absolute: Vec<Segment> = segs
            .into_iter()
            .map(|s| Segment {
                start: window_start + s.start,
                end: window_start + s.end,
                text: s.text,
                words: s.words,
                source,
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
                // Without word timestamps trim cannot shorten the text; a verbatim
                // repeat hugging the horizon is a jittered re-decode, not new speech.
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

// ── Higher-quality offline pass (after stop, on the recorded WAV) ──────

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
}

/// Offline-pass decode window (seconds); transcribed per-window so the progress bar can move.
/// A short overlap (below) keeps utterances that straddle a boundary intact.
const FINALIZE_WINDOW_SECS: f32 = 30.0;

/// Overlap (seconds) between consecutive offline-pass windows. Segments starting inside the
/// *next* window's overlap are dropped from the previous window's output to avoid duplicates.
const FINALIZE_WINDOW_OVERLAP_SECS: f32 = 3.0;

/// Runs the offline pass: load the recorded WAV, transcribe with the higher-quality model,
/// install `final_segments`, mark `Done`. On failure flips to `Failed`; live transcript untouched.
pub fn run_finalize(cfg: FinalizeConfig) -> Result<(), DriverError> {
    let FinalizeConfig {
        id,
        store,
        audio_paths,
        mut transcriber,
        transcribe_opts,
    } = cfg;

    // Helper to flip the session to Failed before returning an error.
    let fail = |store: &TranscriptStore, reason: String| -> DriverError {
        let _ = store.set_status(
            id,
            TranscriptStatus::Failed {
                reason: reason.clone(),
            },
        );
        DriverError::Transcribe(reason)
    };

    // A capture that produced no samples (mic denied + nothing playing, a dead tap) leaves an
    // empty/header-only WAV — surface one actionable reason, not a cryptic hound read error.
    const NO_AUDIO: &str =
        "no audio was captured — check that audio was playing and that microphone / \
         system-audio recording permission is granted";

    // 1) Cheap header pass: timeline bases + progress weights without loading PCM. A part that
    //    never got audio has no file (lazy WAV) — skipped rather than failing the good parts.
    struct PartPlan<'a> {
        path: &'a Path,
        part_base: Duration,
        /// Frames × channels — this part's share of the progress band.
        samples: u64,
    }
    let mut plans: Vec<PartPlan> = Vec::new();
    let mut part_base = Duration::ZERO;
    let mut skipped = 0usize;
    let mut first_read_error: Option<String> = None;
    for path in &audio_paths {
        // A lost part must not discard the good ones, but it must never vanish
        // silently either: warn + a RecordingPartMissing event below.
        let reason = match hound::WavReader::open(path) {
            Ok(reader) => {
                let spec = reader.spec();
                let frames = u64::from(reader.duration());
                if spec.sample_rate > 0 && frames > 0 {
                    plans.push(PartPlan {
                        path,
                        part_base,
                        samples: frames * u64::from(spec.channels.max(1)),
                    });
                    part_base +=
                        Duration::from_secs_f64(frames as f64 / f64::from(spec.sample_rate));
                    continue;
                }
                "carries no samples".to_string()
            }
            Err(e) => {
                // ≤44 bytes = a header-only/empty capture, not a corrupt file.
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

    // 2) + 3) Load, transcribe, and drop ONE part at a time (~30 s overlapped windows; progress
    //    fills 5%..60%; merged by start time) — peak memory stays one part's PCM.
    let _ = store.finalize_progress(id, 0.05);
    let total_samples: u64 = plans.iter().map(|p| p.samples).sum();
    let mut final_segs: Vec<Segment> = Vec::new();
    let mut done_samples: u64 = 0;
    let mut loaded_any = false;
    for plan in &plans {
        let channels = match super::audio::parse_wav_to_channels_f32(plan.path) {
            Ok((chs, _rate)) => chs,
            Err(e) => {
                // Header parsed but the samples didn't (unsupported encoding, truncation
                // since the header pass) — skip the part like a header-pass skip.
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
        for (source, pcm) in lane_sources(channels.len())
            .into_iter()
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
                    let _ =
                        store.finalize_progress(id, 0.05 + 0.55 * (done_frac + frac * lane_share));
                },
            ) {
                Ok(s) => s,
                Err(e) => return Err(fail(&store, format!("offline transcribe: {e}"))),
            };
            final_segs.extend(segs.into_iter().map(|mut s| {
                s.start += plan.part_base;
                s.end += plan.part_base;
                s
            }));
            done_samples += pcm.len() as u64;
        }
        loaded_any = true;
    }
    if !loaded_any {
        return Err(fail(
            &store,
            first_read_error.unwrap_or_else(|| NO_AUDIO.to_string()),
        ));
    }
    final_segs.sort_by_key(|s| s.start);
    let _ = store.finalize_progress(id, 0.9);

    // 4) Install the higher-quality segments as final_segments.
    if let Err(e) = store.set_final_segments(id, final_segs) {
        return Err(fail(&store, format!("install final segments: {e}")));
    }

    // 5) Done.
    store
        .finish(id)
        .map_err(|e| DriverError::Store(e.to_string()))?;
    Ok(())
}

/// Transcribes `pcm` in `FINALIZE_WINDOW_SECS` windows with `FINALIZE_WINDOW_OVERLAP_SECS`
/// overlap, stitched to one absolute list tagged `source`; `progress` fires 0.0→1.0/window.
fn transcribe_chunked(
    transcriber: &mut dyn Transcriber,
    pcm: &[f32],
    opts: &TranscribeOptions,
    source: Option<TranscriptSource>,
    mut progress: impl FnMut(f32),
) -> Result<Vec<Segment>, DriverError> {
    let rate = SAMPLE_RATE_HZ as usize;
    let win = (FINALIZE_WINDOW_SECS * SAMPLE_RATE_HZ as f32) as usize;
    let overlap = (FINALIZE_WINDOW_OVERLAP_SECS * SAMPLE_RATE_HZ as f32) as usize;
    let step = win.saturating_sub(overlap).max(1);
    let total = pcm.len();

    // Short recording: one window, no stitching.
    if total <= win {
        let mut segs = transcriber
            .transcribe(pcm, opts)
            .map_err(|e| DriverError::Transcribe(e.to_string()))?;
        for s in &mut segs {
            s.source = source;
        }
        progress(1.0);
        return Ok(segs);
    }

    let mut out: Vec<Segment> = Vec::new();
    let mut start = 0usize;
    while start < total {
        let end = (start + win).min(total);
        let is_last = end >= total;
        let window = &pcm[start..end];
        let window_start = Duration::from_secs_f64(start as f64 / rate as f64);
        // Window-relative-end below which segments are *kept*: everything on the last window,
        // else up to where the next window starts, so straddling segments come from one window.
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
            });
        }
        progress((end as f32 / total as f32).min(1.0));
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
    /// length keeps matching the wall-clock length of the recording.
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
    use crate::transcription::transcriber::{Language, MockTranscriber};
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
        // 20 s at 16 kHz → at LIVE_DECODE_EVERY_SECS=5 s, ~3 decodes + final flush.
        // MockTranscriber emits one segment per `seg_secs`, giving live_segments to inspect.
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

        // The WAV was written.
        assert!(out_wav.is_file());
        let on_disk = hound::WavReader::open(&out_wav).unwrap();
        assert_eq!(on_disk.spec().sample_rate, 16_000);
        assert_eq!(on_disk.spec().channels, 1);
        // ~20 s ± one chunk of slop.
        let frames = on_disk.into_samples::<i16>().count();
        assert!(
            (frames as i32 - 20 * 16_000).abs() < 16_000 / 4,
            "expected ~20 s of frames, got {frames}"
        );

        // The session is now in Finalizing (hand-off to the offline pass).
        let snap = store.get(id).unwrap();
        assert!(matches!(snap.status, TranscriptStatus::Finalizing { .. }));
        // And we got some live segments.
        assert!(
            !snap.live_segments.is_empty(),
            "should have decoded *some* live segments"
        );
        // Seq monotonic and > 0.
        assert!(snap.last_seq > 0);
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

        // Stereo WAV: channel 0 = system (0.5), channel 1 = mic (0.25).
        let mut on_disk = hound::WavReader::open(&out_wav).unwrap();
        assert_eq!(on_disk.spec().channels, 2);
        let first_frame: Vec<i16> = on_disk
            .samples::<i16>()
            .take(2)
            .map(|s| s.unwrap())
            .collect();
        assert!((first_frame[0] as f32 / 32_767.0 - 0.5).abs() < 0.01);
        assert!((first_frame[1] as f32 / 32_767.0 - 0.25).abs() < 0.01);

        // Both channels decoded: segments tagged with each source, chronological.
        let snap = store.get(id).unwrap();
        use crate::transcription::transcriber::TranscriptSource;
        let sources: Vec<_> = snap.live_segments.iter().map(|s| s.source).collect();
        assert!(sources.contains(&Some(TranscriptSource::System)));
        assert!(sources.contains(&Some(TranscriptSource::Mic)));
        assert!(!sources.contains(&None));
        // Each lane's own commits stay monotonic (append-only per channel).
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
        // Mono start, then a chunk suddenly carrying a mic lane.
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

        // The reverse flip: paired start, then a mic-less chunk.
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
    }
    impl AudioStream for KeepaliveStream {
        fn next_chunk(
            &mut self,
        ) -> Result<Option<crate::transcription::audio::AudioChunk>, CaptureError> {
            if !self.sent_real {
                self.sent_real = true;
                return Ok(Some(chunk_at(0, 1600, None)));
            }
            std::thread::sleep(Duration::from_millis(5));
            Ok(Some(crate::transcription::audio::AudioChunk::keepalive()))
        }
    }

    #[test]
    fn stop_unwedges_an_idle_source_and_keepalives_leave_no_trace_in_the_wav() {
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let id = mk_session(&store, &store_dir.path().join("ignored.wav"));
        let stop = StopSignal::new();
        let driver = TranscriptDriver::new(DriverConfig {
            id,
            store: store.clone(),
            audio: Box::new(KeepaliveStream { sent_real: false }),
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
        std::thread::sleep(Duration::from_millis(150));
        stop.stop();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !runner.is_finished() {
            assert!(
                std::time::Instant::now() < deadline,
                "driver.run() must return after stop despite an idle (keepalive-only) source"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        runner.join().unwrap().unwrap();
        // Keepalives must not pad the timeline: the WAV holds exactly the one real chunk.
        let reader = hound::WavReader::open(&out_wav).unwrap();
        assert_eq!(reader.duration(), 1600);
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

        // Resume base: 100 s of earlier parts already on the timeline.
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
        // Every committed segment sits past the 100 s base, never inside part 1.
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

        // Part 1: 4 s mono; part 2: 2 s mono; a missing part in between is skipped.
        let (_g1, part1) = make_fixture_wav(4.0);
        let (_g2, part2) = make_fixture_wav(2.0);
        let mut sub = store.subscribe(id).unwrap();
        run_finalize(FinalizeConfig {
            id,
            store: store.clone(),
            audio_paths: vec![part1, store_dir.path().join("never-recorded.wav"), part2],
            transcriber: Box::new(MockTranscriber {
                seg_secs: 2.0,
                text_template: "f{n}".to_string(),
            }),
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
        })
        .unwrap();

        // The skipped part surfaces as a RecordingPartMissing warning, not silence.
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
        // 2 segments from part 1 + 1 from part 2, on one continuous timeline.
        assert_eq!(finals.len(), 3);
        assert!(finals.windows(2).all(|w| w[0].start <= w[1].start));
        // Part 2's segment starts at the 4 s boundary, not at zero.
        assert!(finals[2].start >= Duration::from_secs(4));
        assert!(finals[2].end <= Duration::from_secs(7));
    }

    #[test]
    fn run_finalize_fails_with_no_audio_when_no_part_exists() {
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let id = mk_session(&store, &store_dir.path().join("a.wav"));
        let err = run_finalize(FinalizeConfig {
            id,
            store: store.clone(),
            audio_paths: vec![store_dir.path().join("missing.wav")],
            transcriber: Box::new(MockTranscriber::new()),
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
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

        // 4 s stereo WAV (both channels a quiet tone).
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
            id,
            store: store.clone(),
            audio_paths: vec![wav],
            transcriber: Box::new(MockTranscriber {
                seg_secs: 2.0,
                text_template: "f{n}".to_string(),
            }),
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
        })
        .unwrap();

        let snap = store.get(id).unwrap();
        assert!(matches!(snap.status, TranscriptStatus::Done));
        let finals = snap.final_segments.unwrap();
        use crate::transcription::transcriber::TranscriptSource;
        // 2 segments per channel (4 s / 2 s), tagged and merged by start time.
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
            id,
            store: store.clone(),
            audio_paths: vec![good, undecodable],
            transcriber: Box::new(MockTranscriber {
                seg_secs: 2.0,
                text_template: "f{n}".to_string(),
            }),
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
        })
        .unwrap();

        // The good part survived; the undecodable one raised the missing-part warning.
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
            id,
            store: store.clone(),
            audio_paths: vec![undecodable],
            transcriber: Box::new(MockTranscriber::new()),
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
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
        // The held-back tail reaches the UI as a draft well before commit…
        assert!(
            drafts.iter().any(|d| !d.is_empty()),
            "expected at least one non-empty draft, got {drafts:?}"
        );
        // …and the stop flush commits everything, clearing the draft.
        assert_eq!(drafts.last().map(String::as_str), Some(""));
        assert_eq!(store.get(id).unwrap().live_draft, "");
    }

    #[test]
    fn live_segments_stay_monotonic_and_unique_across_re_decodes() {
        // 30 s at 16 kHz: LIVE_DECODE_EVERY_SECS=5 re-decodes ~6 times, sliding past
        // LIVE_WINDOW_SECS; append-only commits must stay monotonic and never duplicate.
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
        // Timestamps non-decreasing.
        for w in segs.windows(2) {
            assert!(
                w[1].start >= w[0].start,
                "segment starts went backwards: {:?} then {:?}",
                w[0].start,
                w[1].start
            );
        }
        // ~30 s / 2 s ≈ 15 segments, give or take one window's worth — and
        // definitely not the ~25+ a duplicating splice would produce.
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
        }
    }

    #[test]
    fn live_view_is_append_only_and_holds_back_the_unstable_tail() {
        // 15 s fixture → decodes at ~5 s (win 0-5), ~10 s (win 0-10), ~15 s
        // (win 3-15), then the final flush (win 3-15 again).
        let (_fixture_guard, fixture) = make_fixture_wav(15.0);
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let id = mk_session(&store, &store_dir.path().join("ignored.wav"));
        let sub = store.subscribe(id).unwrap();

        let script = vec![
            // Decode 1 (horizon ≈ 0): a mid-utterance misread sits in the
            // held-back tail and must never be published.
            vec![seg_at(0.0, 2.0, "ala"), seg_at(3.0, 5.0, "mo kata")],
            // Decode 2 (horizon ≈ 5): both ripe segments commit, with the
            // corrected tail text.
            vec![seg_at(0.0, 2.0, "ala"), seg_at(3.0, 5.0, "ma kota")],
            // Decode 3 (window starts at 3 s): committed audio re-decodes (filtered out);
            // "i psa" (rel 9-11, abs 12-14) is younger than the holdback → held.
            vec![seg_at(0.0, 2.0, "ma kota"), seg_at(9.0, 11.0, "i psa")],
            // Final flush publishes the held-back tail.
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

        // The misread tail was never published, and nothing was ever replaced:
        // the whole live stream is SegmentAppended events.
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
        // Decode 2 below commits two segments ("ala" and "ma kota") in one decode_window call —
        // a batched persist must assign both consecutive seqs, not drop or reorder either.
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
        // Draft events share the seq counter, so committed seqs are strictly
        // increasing but not dense.
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
        // Committed horizon at 4 s: a segment reaching back to 0 is a re-decode
        // of committed audio; one starting within the jitter tolerance stays.
        let rest = uncommitted(&segs, Duration::from_secs(4));
        let texts: Vec<&str> = rest.iter().map(|s| s.text.as_str()).collect();
        assert_eq!(texts, vec!["jittered boundary", "fresh"]);
    }

    #[test]
    fn trim_committed_overlap_drops_a_segment_fully_covered_by_the_horizon() {
        // A jittered segment that never reaches past published_until is pure
        // re-narration of already-shown audio — must not be re-appended.
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
        // Decode 2 commits "ala ma kota" (published_until → 5.0). Decode 3 re-decodes it from
        // 4.5 s (inside BOUNDARY_JITTER) but no further — must drop it, not duplicate it.
        let (_fixture_guard, fixture) = make_fixture_wav(15.0);
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let id = mk_session(&store, &store_dir.path().join("ignored.wav"));

        let script = vec![
            vec![seg_at(0.0, 4.5, "ala ma kota")],
            vec![seg_at(0.0, 5.0, "ala ma kota")],
            // Decodes 3-4 run with window_start ≈ 3 s → abs 4.5-5.2 s: a wordless verbatim
            // re-decode jittered across the 5.0 s horizon; trim can't shorten it, the guard drops it.
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
        // "ala ma kota" appears exactly once — the jittered re-decode did not
        // re-append it a second time.
        assert_eq!(
            texts.iter().filter(|t| t.as_str() == "ala ma kota").count(),
            1,
            "got: {texts:?}"
        );
    }

    #[test]
    fn draft_trims_the_committed_prefix_of_a_jittered_re_decode() {
        // Decode 1 commits "ala ma" (published_until -> 4.0 s). Decode 2's still-unripe tail
        // re-decodes "ma" (jittered, with word timestamps) — the draft must drop it, not repeat it.
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
        };
        let script = vec![
            vec![seg_at(0.0, 4.0, "ala ma")],
            vec![seg_at(0.0, 4.0, "ala ma"), jittered_tail],
            // Decode 3 + flush run at a shifted window (window_start slides forward); an
            // empty result keeps this test isolated to the decode-1/decode-2 interaction.
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
        // Decode 1's pre-commit draft may show "ala ma" (nothing committed yet);
        // once decode 2 commits it, the jittered tail's "ma" is trimmed away.
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
        let (_fixture_guard, fixture) = make_fixture_wav(30.0); // long fixture
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let id = mk_session(&store, &store_dir.path().join("ignored.wav"));

        let stop = StopSignal::new();
        stop.stop(); // tripped before run() — should exit on the *first* chunk check
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
        // Status flipped to Finalizing as part of the clean wind-down.
        assert!(matches!(
            store.get(id).unwrap().status,
            TranscriptStatus::Finalizing { .. }
        ));
        // No chunk ever arrived, so no WAV is created (finalize reports no-audio).
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
        // Seed a stale draft, as a real decode would leave one mid-recording.
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
        // Status is now Failed (the driver flipped it before propagating).
        let snap = store.get(id).unwrap();
        assert!(
            matches!(snap.status, TranscriptStatus::Failed { .. }),
            "got {:?}",
            snap.status
        );
        // The stale draft was retracted — nothing left to display for a failed session.
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

    // --- offline finalize pass ---------------------------------------------

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
            id,
            store: store.clone(),
            audio_paths: vec![wav],
            transcriber: Box::new(MockTranscriber {
                seg_secs: 4.0,
                text_template: "f{n}".to_string(),
            }),
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
        })
        .unwrap();

        let snap = store.get(id).unwrap();
        assert!(matches!(snap.status, TranscriptStatus::Done));
        let finals = snap.final_segments.as_ref().expect("final segments set");
        assert!(!finals.is_empty(), "offline pass should have segments");
        // effective_segments now returns the final set.
        assert_eq!(snap.effective_segments().len(), finals.len());
        // Progress climbed past 0 (we don't pin exact values).
        assert!(snap.last_seq > 0);
    }

    #[test]
    fn finalize_with_missing_audio_flips_to_failed() {
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let (id, _wav) = seed_finalizing_session(&store, 4.0);
        // Delete the audio after seeding (simulates a missing/corrupt WAV).
        let _ = std::fs::remove_file(store.session_dir(id).join("audio.wav"));

        let err = run_finalize(FinalizeConfig {
            id,
            store: store.clone(),
            audio_paths: vec![store.session_dir(id).join("audio.wav")],
            transcriber: Box::new(MockTranscriber::new()),
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
        })
        .unwrap_err();
        assert!(matches!(err, DriverError::Transcribe(_)), "got {err:?}");
        let snap = store.get(id).unwrap();
        assert!(matches!(snap.status, TranscriptStatus::Failed { .. }));
        // The live transcript (such as it is) is untouched.
        assert!(snap.final_segments.is_none());
    }

    #[test]
    fn finalize_with_a_zero_byte_wav_reports_no_audio_not_a_hound_error() {
        // A capture that produced nothing (mic denied + silence) leaves a
        // 0-byte / header-only WAV; the user should see an actionable reason.
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let (id, wav) = seed_finalizing_session(&store, 4.0);
        std::fs::write(&wav, b"").unwrap(); // truncate to 0 bytes

        let err = run_finalize(FinalizeConfig {
            id,
            store: store.clone(),
            audio_paths: vec![wav],
            transcriber: Box::new(MockTranscriber::new()),
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
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
        // A file well past the 44-byte header threshold that is unparseable (crash mid-write)
        // must surface the real cause, not the generic "no audio was captured" message.
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let (id, wav) = seed_finalizing_session(&store, 4.0);
        std::fs::write(&wav, vec![0xAAu8; 200]).unwrap(); // garbage, not a WAV header

        let err = run_finalize(FinalizeConfig {
            id,
            store: store.clone(),
            audio_paths: vec![wav],
            transcriber: Box::new(MockTranscriber::new()),
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
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
            id,
            store: store.clone(),
            audio_paths: vec![wav],
            transcriber: Box::new(FailingTranscriber),
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
        })
        .unwrap_err();
        assert!(matches!(err, DriverError::Transcribe(_)), "got {err:?}");
        assert!(matches!(
            store.get(id).unwrap().status,
            TranscriptStatus::Failed { .. }
        ));
    }

    #[test]
    fn finalize_with_empty_wav_flips_to_failed() {
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let id = mk_session(&store, &PathBuf::from("/x.wav"));
        let dir = store.session_dir(id);
        std::fs::create_dir_all(&dir).unwrap();
        let wav = dir.join("audio.wav");
        // Header-only WAV (zero samples).
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
            id,
            store: store.clone(),
            audio_paths: vec![wav],
            transcriber: Box::new(MockTranscriber::new()),
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
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
        // int16
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
        // float32 stereo → mono average
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
        // 2 stereo frames: (1.0, 0.0), (0.5, 0.5) → mono 0.5, 0.5
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
        // 10 s < FINALIZE_WINDOW_SECS (30 s): one transcribe call, progress→1.0.
        let pcm = vec![0.01f32; 10 * 16_000];
        let mut tr = MockTranscriber {
            seg_secs: 2.0,
            text_template: "s{n}".to_string(),
        };
        let mut last_progress = 0.0;
        let opts = TranscribeOptions::for_language(Language::Pl);
        let segs = transcribe_chunked(&mut tr, &pcm, &opts, None, |p| last_progress = p).unwrap();
        assert_eq!(segs.len(), 5); // 10 s / 2 s
        assert!((last_progress - 1.0).abs() < 1e-6);
        // Timestamps are window-absolute (= recording-absolute for one window).
        assert_eq!(segs[0].start, Duration::ZERO);
        assert_eq!(segs[4].start, Duration::from_secs_f32(8.0));
    }

    #[test]
    fn transcribe_chunked_stitches_overlapping_windows_without_duplicates() {
        // 70 s, 30 s windows, 3 s overlap, 27 s step → 3 windows (0..30, 27..57, 54..70).
        // Segments must be monotonic, recording-absolute, and overlap zones not double-counted.
        let pcm = vec![0.01f32; 70 * 16_000];
        let mut tr = MockTranscriber {
            seg_secs: 5.0,
            text_template: "s{n}".to_string(),
        };
        let mut ticks: Vec<f32> = Vec::new();
        let opts = TranscribeOptions::for_language(Language::En);
        let segs = transcribe_chunked(&mut tr, &pcm, &opts, None, |p| ticks.push(p)).unwrap();
        assert!(!segs.is_empty());
        // Monotonic, non-overlapping starts.
        for w in segs.windows(2) {
            assert!(w[1].start >= w[0].start, "starts went backwards");
        }
        // Last segment ends at ~70 s (the recording length), not 30 s or beyond.
        let last_end = segs.last().unwrap().end.as_secs_f32();
        assert!(
            (60.0..=71.0).contains(&last_end),
            "last segment ends at {last_end}, expected ≈70"
        );
        // Progress was reported per window and reached 1.0 on the last.
        assert!(
            ticks.len() >= 3,
            "expected ≥3 progress ticks, got {}",
            ticks.len()
        );
        assert!((ticks.last().copied().unwrap() - 1.0).abs() < 1e-6);
        // Ticks are non-decreasing.
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
        let err = transcribe_chunked(&mut Boom, &pcm, &opts, None, |_| {}).unwrap_err();
        assert!(matches!(err, DriverError::Transcribe(_)));
    }

    #[test]
    fn lane_ring_keeps_only_the_trailing_window_and_tracks_absolute_indices() {
        let mut ring = LaneRing::new(10);
        ring.push(&[1.0, 2.0, 3.0]);
        assert_eq!((ring.base, ring.filled), (0, 3));
        let (start, win) = ring.window_ending_at(3, 2);
        assert_eq!((start, win), (1, vec![2.0, 3.0]));
        // Past capacity the oldest samples go; absolute indices keep counting.
        ring.push(&[4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0, 11.0, 12.0]);
        assert_eq!((ring.base, ring.filled), (2, 12));
        let (start, win) = ring.window_ending_at(12, 3);
        assert_eq!((start, win), (9, vec![10.0, 11.0, 12.0]));
        // A window that has aged out reports empty, so the caller can skip ahead.
        assert_eq!(ring.window_ending_at(2, 4), (2, Vec::new()));
        // An end past the head clamps to what was actually captured.
        let (_, win) = ring.window_ending_at(99, 2);
        assert_eq!(win, vec![11.0, 12.0]);
    }

    #[test]
    fn lane_ring_silence_advances_the_head_without_materialising_a_long_gap() {
        let mut ring = LaneRing::new(4);
        ring.push(&[1.0]);
        // A 1000-sample gap only ever keeps `capacity` zeros, but the head jumps the full gap.
        ring.push_silence(1_000);
        assert_eq!(ring.filled, 1_001);
        assert_eq!(ring.base, 997);
        let (start, win) = ring.window_ending_at(1_001, 4);
        assert_eq!(start, 997);
        assert_eq!(win, vec![0.0, 0.0, 0.0, 0.0]);
        // Zero is a no-op.
        ring.push_silence(0);
        assert_eq!(ring.filled, 1_001);
    }

    #[test]
    fn an_idle_capture_gap_is_padded_so_the_wav_keeps_its_real_length() {
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let wav = store_dir.path().join("gapped.wav");
        let id = mk_session(&store, &wav);
        // 200 ms at offset 0, then 200 ms declared 10 s in: an idle WASAPI loopback delivers
        // nothing while nothing plays, so that gap is real recording time, not a splice.
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
        // 200 ms at offset 0, then two chunks declared 2 h in: the gap exceeds MAX_GAP_SAMPLES,
        // so both splice at the write head — no padding at all, and no per-chunk re-padding.
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
        // 60 s captured into the production-sized ring (42 s): everything before
        // `oldest` (18 s) is evicted, and the decoder is far behind at 5 s.
        {
            let mut g = lock_ingest(&driver.ingest);
            g.lanes = vec![LaneRing::new(ring_capacity_samples())];
            g.lanes[0].push(&vec![0.1; SAMPLE_RATE_HZ as usize * 60]);
        }
        driver.decode_window_ending(5.0, false).unwrap();
        // The Am. 11 lag skip: jump to the head instead of decoding evicted
        // (empty) windows for the rest of the meeting.
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
        // The WAV written before the panic is still finalized (readable header).
        assert!(crate::transcription::audio::wav_duration(&wav).is_some());
    }

    /// One chunk, then blocks until `stop` trips and only then errors — a failure landing
    /// after the decode loop's last poll (the decode side exits on stop, never seeing it).
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
            while !self.stop.is_stopped() {
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(CaptureError::Failed("device vanished".to_string()))
        }
    }

    /// One chunk after `stop` trips, with a warning queued on it — health landing after the
    /// decode loop's last drain (the wind-down path must forward it).
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
            while !self.stop.is_stopped() {
                std::thread::sleep(Duration::from_millis(5));
            }
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
        let runner = std::thread::spawn({
            let wav = wav.clone();
            move || driver.run(&wav)
        });
        std::thread::sleep(Duration::from_millis(150));
        stop.stop();
        runner.join().unwrap().unwrap();
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
        let runner = std::thread::spawn({
            let wav = wav.clone();
            move || driver.run(&wav)
        });
        std::thread::sleep(Duration::from_millis(150));
        stop.stop();
        let err = runner.join().unwrap().unwrap_err();
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
        // The second chunk re-declares 100 ms already written (a drift correction) plus 100 ms new.
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
        // Chunks carry paired system+mic lanes (via stereo_chunk_at): `write_silence(gap,
        // channels)` is where a frame/sample mix-up would desync the two WAV channels for good.
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
        // 0.2 s + 9.8 s gap + 0.2 s at 16 kHz.
        assert!(
            (frames as f32 / 16_000.0 - 10.2).abs() < 0.05,
            "expected ~10.2 s of frames per channel, got {frames}"
        );
        // Post-gap audio still lands channel-aligned: sys 0.1, mic 0.3 in the final chunk.
        let tail = frames - 1_600;
        assert!(
            (channels[0][tail] - 0.1).abs() < 0.02,
            "sys channel desynced after the gap"
        );
        assert!(
            (channels[1][tail] - 0.3).abs() < 0.02,
            "mic channel desynced after the gap"
        );
        // The gap itself is silence on both channels.
        assert!(channels[0][frames / 2].abs() < 1e-6);
        assert!(channels[1][frames / 2].abs() < 1e-6);
    }

    #[test]
    fn a_backwards_offset_correction_keeps_paired_channels_aligned() {
        // The mic tail is written as `&mic[skip..]`: a wrong skip would shift the mic channel
        // against the system channel from this chunk on.
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
        // Every frame keeps its channel identity — no zero-padding or swap anywhere.
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

        // Once the decoder is stuck inside a decode, ingestion must keep advancing — that is the
        // whole point of the split: a slow transcriber may cost live text, never recorded audio.
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
        // Paired chunks: the meter must report one level per channel.
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

        // The recording is complete and hands off to the offline pass...
        let snap = store.get(id).unwrap();
        assert!(matches!(snap.status, TranscriptStatus::Finalizing { .. }));
        assert_eq!(
            crate::transcription::audio::wav_duration(&wav),
            Some(Duration::from_millis(400))
        );
        // ...with no live output of any kind (nothing decoded it).
        assert!(snap.live_segments.is_empty());
        assert_eq!(snap.live_draft, "");
        // The loudness meter fired, with one entry per channel, values in range.
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
}
