//! Background task pumping AudioStream → Transcriber → TranscriptStore.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use uuid::Uuid;

use crate::transcription::audio::{AudioStream, CaptureHealth, SAMPLE_RATE_HZ};
use crate::transcription::transcriber::{Segment, TranscribeOptions, Transcriber};
use crate::transcription::transcript::TranscriptStatus;
use crate::transcription::transcript_store::TranscriptStore;

/// Live sliding-window length (seconds): how much trailing audio we re-feed
/// to the transcriber to give it context. Longer = more accurate trailing
/// words but more recompute per chunk.
const LIVE_WINDOW_SECS: f32 = 12.0;

/// How often (in seconds of audio accumulated) the live transcriber re-decodes.
const LIVE_DECODE_EVERY_SECS: f32 = 5.0;

/// Log a `warn` for every multiple of this many seconds of accumulated audio
/// — long meetings keep the whole PCM buffer in RAM (`~115 MB / hour` at
/// 16 kHz mono f32) and operators want a hint when something's running long.
const PCM_WARN_STEP_SECS: f32 = 30.0 * 60.0;

/// A stop signal shared with the driver task; flip it to `true` to ask the
/// driver to wind down at the next chunk boundary. Carries a `Notify` the
/// driver host can pulse once `run()` has actually exited, so the Tauri
/// `stop_transcription` callsite can `await` the wind-down instead of
/// spin-polling.
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

/// Drives one recording. Owned by the background task.
pub struct TranscriptDriver {
    id: Uuid,
    store: Arc<TranscriptStore>,
    audio: Box<dyn AudioStream>,
    transcriber: Box<dyn Transcriber>,
    transcribe_opts: TranscribeOptions,
    stop: StopSignal,
    /// All audio accumulated so far (mono 16 kHz `f32`).
    pcm: Vec<f32>,
    last_decode_at: f32,
    /// Last logged "PCM is big" threshold (in seconds), so we warn once per
    /// step instead of every chunk.
    next_pcm_warn_at: f32,
    /// Previous live decode (absolute timestamps) — the agreement reference.
    last_live_decode: Vec<Segment>,
    /// End of the last committed live segment; the live view is append-only.
    published_until: Duration,
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
            pcm: Vec::new(),
            last_decode_at: 0.0,
            next_pcm_warn_at: PCM_WARN_STEP_SECS,
            last_live_decode: Vec::new(),
            published_until: Duration::ZERO,
        }
    }

    /// Runs the driver to completion (until the audio stream ends or `stop`
    /// is tripped). Writes a WAV at `audio_wav_path` along the way. On any error
    /// the session is flipped to `Failed{reason}` and the (partial) WAV is
    /// closed before the error propagates.
    pub fn run(mut self, audio_wav_path: &Path) -> Result<(), DriverError> {
        let mut wav = WavWriter::create(audio_wav_path)?;
        // Mark the session as Recording (a no-op transition from new()).
        let _ = self.store.set_status(self.id, TranscriptStatus::Recording);

        let result = self.pump_loop(&mut wav);
        // Always close the WAV — even on error, a partial recording is better
        // than a truncated/locked file.
        let _ = wav.finalize();

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

    /// The capture→transcribe loop. Returns `Ok` when the stream ends or `stop`
    /// is tripped; `Err` on a capture, transcribe, WAV, or store failure (the
    /// caller flips the session to `Failed`).
    fn pump_loop(&mut self, wav: &mut WavWriter) -> Result<(), DriverError> {
        loop {
            if self.stop.is_stopped() {
                return Ok(());
            }
            let chunk = match self.audio.next_chunk() {
                Ok(Some(c)) => c,
                Ok(None) => return Ok(()), // stream ended
                Err(e) => return Err(DriverError::Capture(e.to_string())),
            };
            for t in self.audio.take_health() {
                let _ = match t {
                    CaptureHealth::Raised(w) => self.store.capture_warning(self.id, w),
                    CaptureHealth::Cleared(w) => self.store.capture_warning_cleared(self.id, w),
                };
            }
            wav.write(&chunk.samples)?;
            self.pcm.extend_from_slice(&chunk.samples);

            let accumulated_secs = self.pcm.len() as f32 / SAMPLE_RATE_HZ as f32;
            if accumulated_secs >= self.next_pcm_warn_at {
                let mb = (self.pcm.len() * std::mem::size_of::<f32>()) / 1_000_000;
                log::warn!(
                    "transcript {} has accumulated {:.0} min of audio (~{mb} MB in RAM); \
                     long meetings can pressure memory during the offline finalize pass",
                    self.id,
                    accumulated_secs / 60.0
                );
                self.next_pcm_warn_at += PCM_WARN_STEP_SECS;
            }
            if accumulated_secs - self.last_decode_at >= LIVE_DECODE_EVERY_SECS {
                self.decode_window(false)?;
                self.last_decode_at = accumulated_secs;
            }
        }
    }

    /// Re-decodes the trailing `LIVE_WINDOW_SECS` of `pcm` and appends only
    /// segments two consecutive decodes agree on (LocalAgreement) — the live
    /// view is append-only, so shown text never flickers away. `flush` commits
    /// the unconfirmed tail (used for the last decode before finalize).
    fn decode_window(&mut self, flush: bool) -> Result<(), DriverError> {
        if self.pcm.is_empty() {
            return Ok(());
        }
        let win_samples = (LIVE_WINDOW_SECS * SAMPLE_RATE_HZ as f32) as usize;
        let win_start_idx = self.pcm.len().saturating_sub(win_samples);
        let window = &self.pcm[win_start_idx..];
        let window_start = Duration::from_secs_f32(win_start_idx as f32 / SAMPLE_RATE_HZ as f32);

        let segs = self
            .transcriber
            .feed(window, &self.transcribe_opts)
            .map_err(|e| DriverError::Transcribe(e.to_string()))?;
        // Window-relative timestamps → absolute.
        let absolute: Vec<Segment> = segs
            .into_iter()
            .map(|s| Segment {
                start: window_start + s.start,
                end: window_start + s.end,
                text: s.text,
                words: s.words,
            })
            .collect();

        let candidates: Vec<Segment> = uncommitted(&absolute, self.published_until);
        let commit: Vec<Segment> = if flush {
            candidates
        } else {
            let prev = uncommitted(&self.last_live_decode, self.published_until);
            agreed_prefix(&prev, &candidates)
        };
        for seg in commit {
            self.published_until = seg.end;
            self.store
                .append_segment(self.id, seg)
                .map_err(|e| DriverError::Store(e.to_string()))?;
        }
        self.last_live_decode = absolute;
        Ok(())
    }
}

/// Segments whose midpoint lies past the committed horizon (midpoint, not
/// start: window re-decodes jitter boundaries of the already-committed edge).
fn uncommitted(segs: &[Segment], published_until: Duration) -> Vec<Segment> {
    segs.iter()
        .filter(|s| s.start + (s.end.saturating_sub(s.start)) / 2 >= published_until)
        .cloned()
        .collect()
}

/// Two decodes agree on a segment when the text matches and the start drifted
/// less than [`AGREEMENT_START_TOLERANCE`] between passes.
const AGREEMENT_START_TOLERANCE: Duration = Duration::from_secs(1);

/// Longest prefix of `cur` that agrees, pairwise, with `prev` (LocalAgreement).
fn agreed_prefix(prev: &[Segment], cur: &[Segment]) -> Vec<Segment> {
    cur.iter()
        .zip(prev.iter())
        .take_while(|(c, p)| {
            c.text.trim() == p.text.trim() && c.start.abs_diff(p.start) <= AGREEMENT_START_TOLERANCE
        })
        .map(|(c, _)| c.clone())
        .collect()
}

// ---------------------------------------------------------------------------
// Higher-quality offline pass (runs after stop, on the recorded WAV)
// ---------------------------------------------------------------------------

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

/// Offline-pass decode window (seconds). The recording is transcribed in
/// windows of this length so the progress bar can move per-window; a short
/// overlap (below) keeps utterances that straddle a boundary intact.
const FINALIZE_WINDOW_SECS: f32 = 30.0;

/// Overlap (seconds) between consecutive offline-pass windows. Segments that
/// start inside the overlap of the *next* window are dropped from the previous
/// window's output to avoid duplicates.
const FINALIZE_WINDOW_OVERLAP_SECS: f32 = 3.0;

/// Runs the offline pass: load the recorded WAV, transcribe it with the
/// higher-quality model, install the result as `final_segments`, and mark the
/// session `Done`. On failure the session is flipped to `Failed{reason}` and
/// the error returned — the caller can still fall back to the live transcript
/// (it's untouched).
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

    // A capture that produced no samples (mic denied + nothing playing, a dead
    // tap) leaves an empty or header-only WAV. Both mean the same actionable
    // thing to the user, not a cryptic "Failed to read enough bytes".
    const NO_AUDIO: &str =
        "no audio was captured — check that audio was playing and that microphone / \
         system-audio recording permission is granted";

    // 1) Load the recorded audio.
    if !audio_path.exists() {
        return Err(fail(&store, NO_AUDIO.to_string()));
    }
    let pcm = match read_wav_to_mono_f32(&audio_path) {
        Ok(p) if !p.is_empty() => p,
        Ok(_) => return Err(fail(&store, NO_AUDIO.to_string())),
        // A 0-byte / truncated WAV fails the hound header read — same cause.
        Err(_) if wav_has_no_samples(&audio_path) => {
            return Err(fail(&store, NO_AUDIO.to_string()))
        }
        Err(e) => return Err(fail(&store, format!("read audio: {e}"))),
    };

    // 2) + 3) Transcribe in ~30 s windows with a short overlap, stitching the
    //    results and emitting real per-window progress. Chunking (vs one
    //    whole-recording call) loses a little cross-utterance context but lets
    //    the progress bar actually move; the overlap + de-dup keeps boundaries
    //    clean. Progress here fills the 5%..60% band.
    let _ = store.finalize_progress(id, 0.05);
    let final_segs =
        match transcribe_chunked(transcriber.as_mut(), &pcm, &transcribe_opts, |frac| {
            let _ = store.finalize_progress(id, 0.05 + 0.55 * frac);
        }) {
            Ok(s) => s,
            Err(e) => return Err(fail(&store, format!("offline transcribe: {e}"))),
        };
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

/// Transcribes `pcm` (16 kHz mono) in `FINALIZE_WINDOW_SECS` windows with a
/// `FINALIZE_WINDOW_OVERLAP_SECS` overlap, stitching the per-window segments
/// into one absolute-timestamped list. Calls `progress` with a 0.0→1.0 fraction
/// after each window so a UI bar can move. Segments whose start falls inside the
/// *next* window's overlap are dropped to de-dup the boundary.
fn transcribe_chunked(
    transcriber: &mut dyn Transcriber,
    pcm: &[f32],
    opts: &TranscribeOptions,
    mut progress: impl FnMut(f32),
) -> Result<Vec<Segment>, DriverError> {
    let rate = SAMPLE_RATE_HZ as usize;
    let win = (FINALIZE_WINDOW_SECS * SAMPLE_RATE_HZ as f32) as usize;
    let overlap = (FINALIZE_WINDOW_OVERLAP_SECS * SAMPLE_RATE_HZ as f32) as usize;
    let step = win.saturating_sub(overlap).max(1);
    let total = pcm.len();

    // Short recording: one window, no stitching.
    if total <= win {
        let segs = transcriber
            .transcribe(pcm, opts)
            .map_err(|e| DriverError::Transcribe(e.to_string()))?;
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
        // Window-relative-end below which we *keep* segments: everything for the
        // last window; up to where the next window starts (its overlap zone) for
        // earlier windows, so straddling segments come from exactly one window.
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

/// Reads a 16 kHz WAV (the format `WavWriter` above produces) into mono `f32`.
/// Delegates to the shared `audio::parse_wav_to_mono_f32`.
fn read_wav_to_mono_f32(path: &Path) -> Result<Vec<f32>, String> {
    super::audio::parse_wav_to_mono_f32(path)
        .map(|(mono, _rate)| mono)
        .map_err(|e| e.to_string())
}

/// `true` when the file is too small to hold any PCM (0-byte or header-only) —
/// the signature of a recording that captured nothing.
fn wav_has_no_samples(path: &Path) -> bool {
    // A canonical 16 kHz mono int16 WAV header is 44 bytes; anything at or
    // below that carries no samples.
    std::fs::metadata(path)
        .map(|m| m.len() <= 44)
        .unwrap_or(true)
}

/// Tiny `hound`-backed WAV writer (16 kHz mono int16 — Whisper's canonical
/// fixture format; the driver receives `f32` and quantises).
struct WavWriter {
    inner: hound::WavWriter<std::io::BufWriter<std::fs::File>>,
}

impl WavWriter {
    fn create(path: &Path) -> Result<Self, DriverError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| DriverError::AudioWrite(e.to_string()))?;
        }
        let spec = hound::WavSpec {
            channels: 1,
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

    fn finalize(self) -> Result<(), DriverError> {
        self.inner
            .finalize()
            .map_err(|e| DriverError::AudioWrite(e.to_string()))
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
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
        // 20 s of audio at 16 kHz → at LIVE_DECODE_EVERY_SECS=5 s, ~3 decodes
        // (plus the final flush). MockTranscriber emits one segment per
        // `seg_secs`, so we get sensible live_segments to inspect.
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

    #[test]
    fn live_segments_stay_monotonic_and_unique_across_re_decodes() {
        // 30 s of audio at 16 kHz: with LIVE_DECODE_EVERY_SECS=5, the sliding
        // window re-decodes ~6 times and (since the recording exceeds
        // LIVE_WINDOW_SECS) the window slides forward. Append-only commits must
        // keep timestamps monotonic and never duplicate the earlier segments.
        // MockTranscriber emits one segment per 2 s.
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
        }
    }

    #[test]
    fn live_view_is_append_only_and_holds_back_disagreeing_tails() {
        // 15 s fixture → decodes at 5 s (win 0-5), 10 s (win 0-10), 15 s
        // (win 3-15), then the final flush (win 3-15 again).
        let (_fixture_guard, fixture) = make_fixture_wav(15.0);
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let id = mk_session(&store, &store_dir.path().join("ignored.wav"));
        let sub = store.subscribe(id).unwrap();

        let script = vec![
            // Decode 1: "ala" plus a mid-utterance misread of the tail.
            vec![seg_at(0.0, 2.0, "ala"), seg_at(3.0, 5.0, "mo kata")],
            // Decode 2 fixes the tail: "ala" agrees → committed; "ma kota" not yet.
            vec![seg_at(0.0, 2.0, "ala"), seg_at(3.0, 5.0, "ma kota")],
            // Decode 3 (window starts at 3 s, window-relative times): "ma kota"
            // now agrees at abs 3-5 (rel 0-2); "i psa" appears (rel 9-11).
            vec![seg_at(0.0, 2.0, "ma kota"), seg_at(9.0, 11.0, "i psa")],
            // Final flush: same decode — "i psa" is committed without agreement.
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
                    "unconfirmed text must never be shown"
                );
            }
        }
    }

    #[test]
    fn agreed_prefix_needs_matching_text_and_stable_starts() {
        let prev = vec![seg_at(0.0, 2.0, "ala"), seg_at(3.0, 5.0, "mo kata")];
        let cur = vec![seg_at(0.2, 2.0, "ala"), seg_at(3.0, 5.0, "ma kota")];
        let agreed = agreed_prefix(&prev, &cur);
        assert_eq!(agreed.len(), 1, "tolerant start drift, strict text");
        assert_eq!(agreed[0].text, "ala");
        // A start that drifted more than the tolerance is not the same segment.
        let drifted = vec![seg_at(4.0, 6.0, "ala")];
        assert!(agreed_prefix(&prev, &drifted).is_empty());
        // No previous decode → nothing agreed yet.
        assert!(agreed_prefix(&[], &cur).is_empty());
    }

    #[test]
    fn uncommitted_filters_by_midpoint_not_start() {
        let segs = vec![seg_at(0.0, 2.0, "done"), seg_at(3.0, 7.0, "fresh")];
        // Horizon at 4 s: "done" (mid 1 s) is out; "fresh" (mid 5 s) stays even
        // though its start (3 s) sits before the horizon.
        let rest = uncommitted(&segs, Duration::from_secs(4));
        assert_eq!(rest.len(), 1);
        assert_eq!(rest[0].text, "fresh");
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
        // We may have written a tiny header-only WAV — but `audio.wav` exists.
        assert!(out_wav.exists());
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
        let s16 = read_wav_to_mono_f32(&p16).unwrap();
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
        let sf = read_wav_to_mono_f32(&pf).unwrap();
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
        let segs = transcribe_chunked(&mut tr, &pcm, &opts, |p| last_progress = p).unwrap();
        assert_eq!(segs.len(), 5); // 10 s / 2 s
        assert!((last_progress - 1.0).abs() < 1e-6);
        // Timestamps are window-absolute (= recording-absolute for one window).
        assert_eq!(segs[0].start, Duration::ZERO);
        assert_eq!(segs[4].start, Duration::from_secs_f32(8.0));
    }

    #[test]
    fn transcribe_chunked_stitches_overlapping_windows_without_duplicates() {
        // 70 s of audio, 30 s windows, 3 s overlap, 27 s step → 3 windows
        // (0..30, 27..57, 54..70). MockTranscriber emits one 5 s segment per
        // window-slice. Segments must be monotonic, recording-absolute, and the
        // overlap zones must not be double-counted.
        let pcm = vec![0.01f32; 70 * 16_000];
        let mut tr = MockTranscriber {
            seg_secs: 5.0,
            text_template: "s{n}".to_string(),
        };
        let mut ticks: Vec<f32> = Vec::new();
        let opts = TranscribeOptions::for_language(Language::En);
        let segs = transcribe_chunked(&mut tr, &pcm, &opts, |p| ticks.push(p)).unwrap();
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
        let err = transcribe_chunked(&mut Boom, &pcm, &opts, |_| {}).unwrap_err();
        assert!(matches!(err, DriverError::Transcribe(_)));
    }
}
