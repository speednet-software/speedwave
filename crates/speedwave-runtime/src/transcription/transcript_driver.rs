//! Background task pumping AudioStream → Transcriber → TranscriptStore.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
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

/// How often (in seconds of audio accumulated) the live transcriber re-decodes.
const LIVE_DECODE_EVERY_SECS: f32 = 5.0;

/// Log a `warn` for every multiple of this many seconds of accumulated audio — long meetings
/// keep the whole PCM buffer in RAM (`~115 MB / hour` at 16 kHz mono f32), worth a hint.
const PCM_WARN_STEP_SECS: f32 = 30.0 * 60.0;

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
    /// Whisper transcriber (one per recording).
    pub transcriber: Box<dyn Transcriber>,
    /// Forced language + word-timestamps toggle.
    pub transcribe_opts: TranscribeOptions,
    /// Shared stop flag.
    pub stop: StopSignal,
}

/// Per-channel decode/commit state: one lane for mono captures, two (system +
/// mic) for paired captures — each channel is decoded separately (Amendment 9).
struct Lane {
    /// Channel tag stamped on this lane's segments (`None` = single-channel).
    source: Option<TranscriptSource>,
    /// This lane's audio accumulated so far (mono 16 kHz `f32`).
    pcm: Vec<f32>,
    /// End of the last committed live segment; the live view is append-only.
    published_until: Duration,
    /// Text of the last committed segment — a wordless jittered re-decode
    /// repeating it verbatim at the horizon is a duplicate, not new speech.
    last_committed_text: String,
}

impl Lane {
    fn new(source: Option<TranscriptSource>) -> Self {
        Self {
            source,
            pcm: Vec::new(),
            published_until: Duration::ZERO,
            last_committed_text: String::new(),
        }
    }
}

/// Drives one recording. Owned by the background task.
pub struct TranscriptDriver {
    id: Uuid,
    store: Arc<TranscriptStore>,
    audio: Box<dyn AudioStream>,
    transcriber: Box<dyn Transcriber>,
    transcribe_opts: TranscribeOptions,
    stop: StopSignal,
    /// Per-channel state; sized from the first chunk (1 = mono, 2 = system+mic).
    lanes: Vec<Lane>,
    last_decode_at: f32,
    /// Last logged "PCM is big" threshold (in seconds), so we warn once per
    /// step instead of every chunk.
    next_pcm_warn_at: f32,
    /// Draft (uncommitted tail) last published to the store.
    last_draft: String,
}

impl TranscriptDriver {
    /// Builds a driver. The caller spawns `run()` on a background task.
    pub fn new(cfg: DriverConfig) -> Self {
        Self {
            id: cfg.id,
            store: cfg.store,
            audio: cfg.audio,
            transcriber: cfg.transcriber,
            transcribe_opts: cfg.transcribe_opts,
            stop: cfg.stop,
            lanes: Vec::new(),
            last_decode_at: 0.0,
            next_pcm_warn_at: PCM_WARN_STEP_SECS,
            last_draft: String::new(),
        }
    }

    /// Runs the driver to completion (until the stream ends or `stop` trips), writing a WAV at
    /// `audio_wav_path`. On error the session flips to `Failed{reason}` and the WAV is closed.
    pub fn run(mut self, audio_wav_path: &Path) -> Result<(), DriverError> {
        // The WAV is created lazily on the first chunk — its channel count
        // (mono vs stereo system+mic) is only known once audio arrives.
        let mut wav: Option<WavWriter> = None;
        // Mark the session as Recording (a no-op transition from new()).
        let _ = self.store.set_status(self.id, TranscriptStatus::Recording);

        let result = self.pump_loop(&mut wav, audio_wav_path);
        // Always close the WAV — even on error, a partial recording is better
        // than a truncated/locked file.
        if let Some(w) = wav {
            let _ = w.finalize();
        }

        match result {
            Ok(()) => {
                // Final live decode flushes the not-yet-agreed tail (no further
                // pass will confirm it), then hand off to the finalize pass.
                let _ = self.decode_window(true);
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

    /// The capture→transcribe loop. `Ok` when the stream ends or `stop` trips; `Err` on a
    /// capture, transcribe, WAV, or store failure (caller flips the session to `Failed`).
    fn pump_loop(
        &mut self,
        wav: &mut Option<WavWriter>,
        wav_path: &Path,
    ) -> Result<(), DriverError> {
        loop {
            if self.stop.is_stopped() {
                return Ok(());
            }
            let next = self.audio.next_chunk();
            // Drain queued health transitions before matching `next` — a stall that ends the
            // stream with `Err` may have queued its warning on the same call.
            self.forward_capture_health();
            let chunk = match next {
                Ok(Some(c)) => c,
                Ok(None) => return Ok(()), // stream ended
                Err(e) => return Err(DriverError::Capture(e.to_string())),
            };
            if self.lanes.is_empty() {
                self.lanes = match &chunk.mic {
                    Some(_) => vec![
                        Lane::new(Some(TranscriptSource::System)),
                        Lane::new(Some(TranscriptSource::Mic)),
                    ],
                    None => vec![Lane::new(None)],
                };
            }
            let writer = match wav {
                Some(w) => w,
                None => wav.insert(WavWriter::create(wav_path, self.lanes.len() as u16)?),
            };
            match &chunk.mic {
                Some(mic) => writer.write_stereo(&chunk.samples, mic)?,
                None => writer.write(&chunk.samples)?,
            }
            self.lanes[0].pcm.extend_from_slice(&chunk.samples);
            if let (Some(mic), Some(lane)) = (&chunk.mic, self.lanes.get_mut(1)) {
                lane.pcm.extend_from_slice(mic);
            }

            let accumulated_secs = self.lanes[0].pcm.len() as f32 / SAMPLE_RATE_HZ as f32;
            if accumulated_secs >= self.next_pcm_warn_at {
                let bytes: usize = self.lanes.iter().map(|l| l.pcm.len()).sum::<usize>()
                    * std::mem::size_of::<f32>();
                log::warn!(
                    "transcript {} has accumulated {:.0} min of audio (~{} MB in RAM); \
                     long meetings can pressure memory during the offline finalize pass",
                    self.id,
                    accumulated_secs / 60.0,
                    bytes / 1_000_000
                );
                self.next_pcm_warn_at += PCM_WARN_STEP_SECS;
            }
            if accumulated_secs - self.last_decode_at >= LIVE_DECODE_EVERY_SECS {
                self.decode_window(false)?;
                self.last_decode_at = accumulated_secs;
            }
        }
    }

    /// Drains and forwards any capture-health transitions queued since the last call.
    fn forward_capture_health(&mut self) {
        for t in self.audio.take_health() {
            let _ = match t {
                CaptureHealth::Raised(w) => self.store.capture_warning(self.id, w),
                CaptureHealth::Cleared(w) => self.store.capture_warning_cleared(self.id, w),
            };
        }
    }

    /// Re-decodes the trailing `LIVE_WINDOW_SECS` of each lane and appends only
    /// segments older than [`LIVE_COMMIT_HOLDBACK`] — the window tail is still
    /// unstable between passes, so the live view stays append-only and never
    /// flickers. The held-back tails go out as a replace-only draft so the UI
    /// shows text within one decode. `flush` commits the tails before finalize.
    fn decode_window(&mut self, flush: bool) -> Result<(), DriverError> {
        if self.lanes.iter().all(|l| l.pcm.is_empty()) {
            return Ok(());
        }
        let total_len = self.lanes.iter().map(|l| l.pcm.len()).max().unwrap_or(0);
        let total = Duration::from_secs_f32(total_len as f32 / SAMPLE_RATE_HZ as f32);
        let horizon = total.saturating_sub(LIVE_COMMIT_HOLDBACK);

        // Collect every lane's ripe commits first, so they persist as one fsync'd
        // save instead of one durable write per segment; the still-unstable tails
        // (not yet ripe to commit) stream out separately as a replace-only draft.
        let mut batch = Vec::new();
        let mut drafts = Vec::new();
        for lane_idx in 0..self.lanes.len() {
            let (mut lane_batch, draft) = self.decode_lane_window(lane_idx, flush, horizon)?;
            batch.append(&mut lane_batch);
            if !draft.is_empty() {
                drafts.push(draft);
            }
        }
        // Cross-lane commits interleave chronologically within the cycle.
        batch.sort_by_key(|s| s.start);
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

    /// One lane's window decode; returns its ripe commits and its draft tail.
    fn decode_lane_window(
        &mut self,
        lane_idx: usize,
        flush: bool,
        horizon: Duration,
    ) -> Result<(Vec<Segment>, String), DriverError> {
        let win_samples = (LIVE_WINDOW_SECS * SAMPLE_RATE_HZ as f32) as usize;
        let source = self.lanes[lane_idx].source;
        let win_start_idx = self.lanes[lane_idx].pcm.len().saturating_sub(win_samples);
        if self.lanes[lane_idx].pcm.is_empty() {
            return Ok((Vec::new(), String::new()));
        }
        let window_start = Duration::from_secs_f32(win_start_idx as f32 / SAMPLE_RATE_HZ as f32);
        let segs = {
            let window = &self.lanes[lane_idx].pcm[win_start_idx..];
            self.transcriber
                .feed(window, &self.transcribe_opts)
                .map_err(|e| DriverError::Transcribe(e.to_string()))?
        };
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
    /// Recorded audio (`<session_dir>/audio.wav`). `run_finalize` returns
    /// `Failed` if it's missing.
    pub audio_path: std::path::PathBuf,
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
        audio_path,
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

    // 1) Load the recorded audio (one lane per WAV channel; stereo = system+mic).
    if !audio_path.exists() {
        return Err(fail(&store, NO_AUDIO.to_string()));
    }
    let channels = match super::audio::parse_wav_to_channels_f32(&audio_path) {
        Ok((chs, _rate)) if chs.iter().any(|c| !c.is_empty()) => chs,
        Ok(_) => return Err(fail(&store, NO_AUDIO.to_string())),
        // A 0-byte / truncated WAV fails the hound header read — same cause.
        Err(_) if wav_has_no_samples(&audio_path) => {
            return Err(fail(&store, NO_AUDIO.to_string()))
        }
        Err(e) => return Err(fail(&store, format!("read audio: {e}"))),
    };
    let lanes: Vec<(Option<TranscriptSource>, &[f32])> = match channels.as_slice() {
        [sys, mic] => vec![
            (Some(TranscriptSource::System), sys.as_slice()),
            (Some(TranscriptSource::Mic), mic.as_slice()),
        ],
        chs => chs.iter().map(|c| (None, c.as_slice())).collect(),
    };

    // 2) + 3) Transcribe each lane in ~30 s windows with overlap, stitching + emitting
    //    per-window progress (fills the 5%..60% band); lanes merge by start time.
    let _ = store.finalize_progress(id, 0.05);
    let mut final_segs: Vec<Segment> = Vec::new();
    let lane_count = lanes.len() as f32;
    for (lane_idx, (source, pcm)) in lanes.into_iter().enumerate() {
        let base = lane_idx as f32 / lane_count;
        let segs = match transcribe_chunked(
            transcriber.as_mut(),
            pcm,
            &transcribe_opts,
            source,
            |frac| {
                let _ = store.finalize_progress(id, 0.05 + 0.55 * (base + frac / lane_count));
            },
        ) {
            Ok(s) => s,
            Err(e) => return Err(fail(&store, format!("offline transcribe: {e}"))),
        };
        final_segs.extend(segs);
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

/// `true` when the file is too small to hold any PCM (0-byte or header-only).
/// `false` when the size can't even be read, so that failure isn't masked as "no audio captured".
fn wav_has_no_samples(path: &Path) -> bool {
    // A canonical 16 kHz mono int16 WAV header is 44 bytes; anything at or
    // below that carries no samples.
    std::fs::metadata(path)
        .map(|m| m.len() <= 44)
        .unwrap_or(false)
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
            transcriber: Box::new(MockTranscriber {
                seg_secs: 2.0,
                text_template: "s{n}".to_string(),
            }),
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
            stop: StopSignal::new(),
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
            transcriber: Box::new(MockTranscriber {
                seg_secs: 2.0,
                text_template: "s{n}".to_string(),
            }),
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
            stop: StopSignal::new(),
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
            audio_path: wav,
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
            transcriber: Box::new(MockTranscriber {
                seg_secs: 2.0,
                text_template: "s{n}".to_string(),
            }),
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
            stop: StopSignal::new(),
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
            transcriber: Box::new(MockTranscriber {
                seg_secs: 2.0,
                text_template: "s{n}".to_string(),
            }),
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
            stop: StopSignal::new(),
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
            transcriber: Box::new(ScriptedTranscriber { script, call: 0 }),
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
            stop: StopSignal::new(),
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
            transcriber: Box::new(ScriptedTranscriber { script, call: 0 }),
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
            stop: StopSignal::new(),
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
            // Decodes 3-4 run with window_start ≈ 3 s, so these window-relative
            // times land at abs 4.5-5.2 s: a wordless verbatim re-decode jittered
            // across the 5.0 s horizon — trim can't shorten it, the guard drops it.
            vec![seg_at(1.5, 2.2, "ala ma kota")],
            vec![seg_at(1.5, 2.2, "ala ma kota")],
        ];
        let driver = TranscriptDriver::new(DriverConfig {
            id,
            store: store.clone(),
            audio: stream_from(&fixture),
            transcriber: Box::new(ScriptedTranscriber { script, call: 0 }),
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
            stop: StopSignal::new(),
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
            transcriber: Box::new(ScriptedTranscriber { script, call: 0 }),
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
            stop: StopSignal::new(),
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
            transcriber: Box::new(MockTranscriber::new()),
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
            stop,
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
            transcriber: Box::new(MockTranscriber::new()),
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
            stop: StopSignal::new(),
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
            transcriber: Box::new(MockTranscriber::new()),
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
            stop: StopSignal::new(),
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
            transcriber: Box::new(MockTranscriber::new()),
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
            stop: StopSignal::new(),
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
            audio_path: wav,
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
            audio_path: store.session_dir(id).join("audio.wav"),
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
            audio_path: wav,
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
            audio_path: wav,
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

    #[test]
    fn wav_has_no_samples_is_true_for_a_small_file_and_false_when_unreadable() {
        let dir = tempfile::tempdir().unwrap();
        let small = dir.path().join("small.wav");
        std::fs::write(&small, vec![0u8; 10]).unwrap();
        assert!(wav_has_no_samples(&small));

        let big = dir.path().join("big.wav");
        std::fs::write(&big, vec![0u8; 200]).unwrap();
        assert!(!wav_has_no_samples(&big));

        // A path whose metadata can't be read must not be reported as "no samples" —
        // the caller falls through to the real I/O error instead.
        let missing = dir.path().join("missing.wav");
        assert!(!wav_has_no_samples(&missing));
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
            audio_path: wav,
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
            audio_path: wav,
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
}
