//! Background task pumping AudioStream → Transcriber → Diarizer → TranscriptStore.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use uuid::Uuid;

use crate::transcription::audio::{AudioStream, SAMPLE_RATE_HZ};
use crate::transcription::diarizer::{DiarizeOptions, Diarizer};
use crate::transcription::transcriber::{Segment, TranscribeOptions, Transcriber};
use crate::transcription::transcript::TranscriptStatus;
use crate::transcription::transcript_store::TranscriptStore;

/// Live sliding-window length (seconds): how much trailing audio we re-feed
/// to the transcriber to give it context. Longer = more accurate trailing
/// words but more recompute per chunk.
const LIVE_WINDOW_SECS: f32 = 12.0;

/// Replace the trailing N segments from the previous decode each time the
/// window re-decodes. (Whisper's last few segments are the least stable; the
/// driver presents them as "tentative" until they fall out of the window.)
const TENTATIVE_TAIL: usize = 2;

/// How often (in seconds of audio accumulated) the live transcriber re-decodes.
const LIVE_DECODE_EVERY_SECS: f32 = 5.0;

/// Diarize the live buffer every N seconds of audio (cheaper than per-chunk).
const LIVE_DIARIZE_EVERY_SECS: f32 = 10.0;

/// A stop signal shared with the driver task; flip it to `true` to ask the
/// driver to wind down at the next chunk boundary.
#[derive(Debug, Clone, Default)]
pub struct StopSignal {
    stopped: Arc<AtomicBool>,
}

impl StopSignal {
    /// A new, un-tripped signal.
    pub fn new() -> Self {
        Self {
            stopped: Arc::new(AtomicBool::new(false)),
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
    /// Diarization failed (non-fatal — we keep the live transcript, no labels).
    #[error("diarization failed: {0}")]
    Diarize(String),
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
    /// Optional diarizer (no labels if `None`).
    pub diarizer: Option<Box<dyn Diarizer>>,
    /// Forced language + word-timestamps toggle.
    pub transcribe_opts: TranscribeOptions,
    /// Diarization clustering options.
    pub diarize_opts: DiarizeOptions,
    /// Shared stop flag.
    pub stop: StopSignal,
}

/// Drives one recording. Owned by the background task.
pub struct TranscriptDriver {
    id: Uuid,
    store: Arc<TranscriptStore>,
    audio: Box<dyn AudioStream>,
    transcriber: Box<dyn Transcriber>,
    diarizer: Option<Box<dyn Diarizer>>,
    transcribe_opts: TranscribeOptions,
    diarize_opts: DiarizeOptions,
    stop: StopSignal,
    /// All audio accumulated so far (mono 16 kHz `f32`).
    pcm: Vec<f32>,
    last_decode_at: f32,
    last_diarize_at: f32,
    /// Index in `live_segments` where the "tentative tail" starts.
    tail_start: usize,
}

impl TranscriptDriver {
    /// Builds a driver. The caller spawns `run()` on a background task.
    pub fn new(cfg: DriverConfig) -> Self {
        Self {
            id: cfg.id,
            store: cfg.store,
            audio: cfg.audio,
            transcriber: cfg.transcriber,
            diarizer: cfg.diarizer,
            transcribe_opts: cfg.transcribe_opts,
            diarize_opts: cfg.diarize_opts,
            stop: cfg.stop,
            pcm: Vec::new(),
            last_decode_at: 0.0,
            last_diarize_at: 0.0,
            tail_start: 0,
        }
    }

    /// Runs the driver to completion (until the audio stream ends or `stop`
    /// is tripped). Writes a WAV at `audio_wav_path` along the way.
    pub fn run(mut self, audio_wav_path: &Path) -> Result<(), DriverError> {
        let mut wav = WavWriter::create(audio_wav_path)?;
        // Mark the session as Recording (a no-op transition from new()).
        let _ = self.store.set_status(self.id, TranscriptStatus::Recording);

        loop {
            if self.stop.is_stopped() {
                break;
            }
            let chunk = match self.audio.next_chunk() {
                Ok(Some(c)) => c,
                Ok(None) => break, // stream ended
                Err(e) => {
                    let _ = self.store.set_status(
                        self.id,
                        TranscriptStatus::Failed {
                            reason: format!("capture: {e}"),
                        },
                    );
                    return Err(DriverError::Capture(e.to_string()));
                }
            };
            wav.write(&chunk.samples)?;
            self.pcm.extend_from_slice(&chunk.samples);

            let accumulated_secs = self.pcm.len() as f32 / SAMPLE_RATE_HZ as f32;
            if accumulated_secs - self.last_decode_at >= LIVE_DECODE_EVERY_SECS {
                self.decode_window()?;
                self.last_decode_at = accumulated_secs;
            }
            if let Some(d) = self.diarizer.as_mut() {
                if accumulated_secs - self.last_diarize_at >= LIVE_DIARIZE_EVERY_SECS {
                    if let Err(e) =
                        run_diarize_pass(d, &self.diarize_opts, &self.pcm, &self.store, self.id)
                    {
                        // Non-fatal: log + keep going (the transcript without
                        // labels is still useful).
                        log::warn!("diarization pass failed: {e}");
                    }
                    self.last_diarize_at = accumulated_secs;
                }
            }
        }

        wav.finalize()?;
        // Final live decode over what's left (so the user sees the last chunk).
        let _ = self.decode_window();
        // Hand-off: flip to Finalizing; the finalize task (Phase 5) takes over.
        let _ = self
            .store
            .set_status(self.id, TranscriptStatus::Finalizing { progress: 0.0 });
        Ok(())
    }

    /// Decodes the trailing `LIVE_WINDOW_SECS` of `pcm` and splices the result
    /// into `live_segments` from `tail_start` onwards (the tentative tail).
    fn decode_window(&mut self) -> Result<(), DriverError> {
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
                speaker: s.speaker,
            })
            .collect();
        // Splice: drop the tentative tail from last time, append the new decode.
        self.store
            .replace_segments(self.id, self.tail_start, absolute.clone())
            .map_err(|e| DriverError::Store(e.to_string()))?;
        // Next time, the tentative tail is the trailing N segments of *this* decode.
        let now_len = self.tail_start + absolute.len();
        self.tail_start = now_len.saturating_sub(TENTATIVE_TAIL);
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Phase 5: higher-quality offline pass
// ---------------------------------------------------------------------------

/// Inputs for the offline finalize pass — built by the caller (Tauri layer)
/// after `stop_transcription`, once it has loaded the higher-quality model.
pub struct FinalizeConfig {
    /// Session id (must already be in the store, in `Finalizing` state).
    pub id: Uuid,
    /// The session store.
    pub store: Arc<TranscriptStore>,
    /// Recorded audio (`<session_dir>/audio.wav`). Must exist — if the user
    /// discarded the audio, the caller shouldn't reach here (and `run_finalize`
    /// returns `Failed` if it's missing).
    pub audio_path: std::path::PathBuf,
    /// Higher-quality transcriber (e.g. `large-v3`).
    pub transcriber: Box<dyn Transcriber>,
    /// Optional diarizer for the whole-recording pass (better clustering with
    /// full context — but the clusters may differ from the live pass).
    pub diarizer: Option<Box<dyn Diarizer>>,
    /// Forced language + word-timestamps toggle.
    pub transcribe_opts: TranscribeOptions,
    /// Diarization clustering options.
    pub diarize_opts: DiarizeOptions,
    /// The diarizer turns from the live pass — used to remap speaker IDs so
    /// user relabels survive (`TranscriptStore::merge_final_segments`).
    pub live_turns: Vec<crate::transcription::diarizer::SpeakerTurn>,
}

/// Granularity (seconds) for the `FinalizeProgress` ticks — we transcribe the
/// whole recording in one shot (Whisper handles long audio internally), so the
/// progress signal is just "we're working" at this cadence.
const FINALIZE_PROGRESS_TICK_SECS: f32 = 30.0;

/// Runs the offline pass: load the recorded WAV, transcribe it with the
/// higher-quality model, (optionally) re-diarize the whole recording, merge the
/// result preserving user speaker relabels, and mark the session `Done`. On
/// failure the session is flipped to `Failed{reason}` and the error returned —
/// the caller can still fall back to the live transcript (it's untouched).
pub fn run_finalize(cfg: FinalizeConfig) -> Result<(), DriverError> {
    let FinalizeConfig {
        id,
        store,
        audio_path,
        mut transcriber,
        mut diarizer,
        transcribe_opts,
        diarize_opts,
        live_turns,
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

    // 1) Load the recorded audio.
    if !audio_path.exists() {
        return Err(fail(
            &store,
            format!("recorded audio missing at {}", audio_path.display()),
        ));
    }
    let pcm = match read_wav_to_mono_f32(&audio_path) {
        Ok(p) if !p.is_empty() => p,
        Ok(_) => return Err(fail(&store, "recorded audio is empty".to_string())),
        Err(e) => return Err(fail(&store, format!("read audio: {e}"))),
    };
    let total_secs = pcm.len() as f32 / SAMPLE_RATE_HZ as f32;

    // 2) Progress: tick to ~50% before the (single) transcribe call, then to
    //    ~90% after — the heavy lifting is opaque inside Whisper. (We avoid
    //    chunked decoding here on purpose: a whole-recording pass yields better
    //    cross-utterance context than the live sliding window.)
    let _ = store.finalize_progress(id, 0.05);
    // Cap the visible ticks at 9 so the bar moves a bounded number of times.
    let ticks = (total_secs / FINALIZE_PROGRESS_TICK_SECS).ceil().max(1.0) as u32;
    let visible_ticks = ticks.clamp(1, 9);
    for t in 1..=visible_ticks {
        // Pre-transcribe progress fills the 5%..45% band so the bar moves even
        // for long recordings before the (single) decode returns.
        let p = 0.05 + 0.40 * (t as f32 / visible_ticks as f32);
        let _ = store.finalize_progress(id, p);
    }

    // 3) The higher-quality transcription (whole buffer, no sliding window).
    let final_segs = match transcriber.transcribe(&pcm, &transcribe_opts) {
        Ok(s) => s,
        Err(e) => return Err(fail(&store, format!("offline transcribe: {e}"))),
    };
    let _ = store.finalize_progress(id, 0.65);

    // 4) Optional re-diarization over the whole recording. Best-effort: a
    //    failure here keeps the (un-labelled-by-this-pass) final segments.
    let (final_segs, final_turns) = match diarizer.as_mut() {
        Some(d) => match d.diarize(&pcm, &diarize_opts) {
            Ok(turns) if !turns.is_empty() => {
                let mut segs = final_segs;
                crate::transcription::diarizer::assign_speakers_by_overlap(&mut segs, &turns);
                (segs, turns)
            }
            Ok(_) => (final_segs, Vec::new()),
            Err(e) => {
                log::warn!(target: "transcription::finalize", "offline diarization failed: {e}");
                (final_segs, Vec::new())
            }
        },
        None => (final_segs, Vec::new()),
    };
    let _ = store.finalize_progress(id, 0.9);

    // 5) Merge: install final_segments, remapping speaker IDs to preserve
    //    user relabels by overlap against the live turns.
    if let Err(e) = store.merge_final_segments(id, final_segs, &final_turns, &live_turns) {
        return Err(fail(&store, format!("merge final segments: {e}")));
    }

    // 6) Done.
    store
        .finish(id)
        .map_err(|e| DriverError::Store(e.to_string()))?;
    Ok(())
}

/// Reads a 16 kHz WAV (the format `WavWriter` above produces) into mono `f32`
/// samples in `[-1, 1]`. Tolerates int16 (our writer) and float32; down-mixes
/// to mono if the file is multi-channel (it shouldn't be).
fn read_wav_to_mono_f32(path: &Path) -> Result<Vec<f32>, String> {
    let mut reader = hound::WavReader::open(path).map_err(|e| e.to_string())?;
    let spec = reader.spec();
    let channels = spec.channels.max(1) as usize;
    let raw: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Int => match spec.bits_per_sample {
            16 => reader
                .samples::<i16>()
                .map(|s| s.map(|v| v as f32 / 32_768.0))
                .collect::<Result<_, _>>()
                .map_err(|e| e.to_string())?,
            other => return Err(format!("unsupported int WAV bit depth {other}")),
        },
        hound::SampleFormat::Float => reader
            .samples::<f32>()
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?,
    };
    if channels == 1 {
        return Ok(raw);
    }
    // Average channels into mono.
    let frames = raw.len() / channels;
    let mut mono = Vec::with_capacity(frames);
    for i in 0..frames {
        let mut acc = 0.0f32;
        for c in 0..channels {
            acc += raw[i * channels + c];
        }
        mono.push(acc / channels as f32);
    }
    Ok(mono)
}

/// One diarization pass over the live buffer; stamps speakers on the latest
/// segments in the store (by index). Best-effort — failures are logged, not
/// propagated.
fn run_diarize_pass(
    diarizer: &mut Box<dyn Diarizer>,
    opts: &DiarizeOptions,
    pcm: &[f32],
    store: &TranscriptStore,
    id: Uuid,
) -> Result<(), DriverError> {
    let turns = diarizer
        .diarize(pcm, opts)
        .map_err(|e| DriverError::Diarize(e.to_string()))?;
    if turns.is_empty() {
        return Ok(());
    }
    // Pull the current live_segments snapshot, assign speakers locally,
    // then emit per-segment SpeakerAssigned events for any changes.
    let snap = store
        .get(id)
        .map_err(|e| DriverError::Store(e.to_string()))?;
    let mut segs = snap.live_segments.clone();
    crate::transcription::diarizer::assign_speakers_by_overlap(&mut segs, &turns);
    for (i, new_seg) in segs.iter().enumerate() {
        let old_speaker = snap.live_segments.get(i).and_then(|s| s.speaker);
        if let Some(new_spk) = new_seg.speaker {
            if old_speaker != Some(new_spk) {
                store
                    .assign_speaker(id, i, new_spk)
                    .map_err(|e| DriverError::Store(e.to_string()))?;
            }
        }
    }
    Ok(())
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
    use crate::transcription::diarizer::MockDiarizer;
    use crate::transcription::transcriber::{Language, MockTranscriber};
    use std::path::PathBuf;

    fn mk_session(store: &TranscriptStore, audio_path: &Path) -> Uuid {
        let s = crate::transcription::transcript::TranscriptSession::new(
            Language::Pl,
            AudioSourceInfo {
                source: AudioSource::SystemWide,
                label: "System".to_string(),
                app_id: None,
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
    fn happy_path_with_file_capture_mock_transcriber_no_diarizer() {
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
            diarizer: None,
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
            diarize_opts: DiarizeOptions::default(),
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

        // The session is now in Finalizing (hand-off to Phase 5).
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
    fn diarizer_assigns_speakers_to_live_segments() {
        let (_fixture_guard, fixture) = make_fixture_wav(15.0);
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let id = mk_session(&store, &store_dir.path().join("ignored.wav"));

        let driver = TranscriptDriver::new(DriverConfig {
            id,
            store: store.clone(),
            audio: stream_from(&fixture),
            // One segment per 3 s → 5 segments over 15 s.
            transcriber: Box::new(MockTranscriber {
                seg_secs: 3.0,
                text_template: "s{n}".to_string(),
            }),
            // Two speakers, equal halves.
            diarizer: Some(Box::new(MockDiarizer::new(2))),
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
            diarize_opts: DiarizeOptions::default(),
            stop: StopSignal::new(),
        });
        let out_wav = store.session_dir(id).join("audio.wav");
        driver.run(&out_wav).unwrap();

        let snap = store.get(id).unwrap();
        assert!(!snap.live_segments.is_empty());
        // At least one segment got a speaker stamped by the diarizer.
        assert!(
            snap.live_segments.iter().any(|s| s.speaker.is_some()),
            "diarizer should have stamped at least one segment"
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
            diarizer: None,
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
            diarize_opts: DiarizeOptions::default(),
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
            diarizer: None,
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
            diarize_opts: DiarizeOptions::default(),
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

    #[test]
    fn stop_signal_helpers() {
        let s = StopSignal::new();
        assert!(!s.is_stopped());
        let s2 = s.clone();
        s2.stop();
        assert!(s.is_stopped(), "stop() should be visible across clones");
    }

    // --- Phase 5: offline finalize pass ------------------------------------

    use crate::transcription::diarizer::SpeakerTurn;
    use crate::transcription::transcriber::SpeakerId;

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
            diarizer: None,
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
            diarize_opts: DiarizeOptions::default(),
            live_turns: vec![],
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
    fn finalize_preserves_user_relabels_via_overlap() {
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let (id, wav) = seed_finalizing_session(&store, 12.0);
        // User named the live speakers.
        store.relabel_speaker(id, SpeakerId(0), "Ola").unwrap();
        store.relabel_speaker(id, SpeakerId(1), "Bartek").unwrap();
        // Live turns: speaker 0 first half, speaker 1 second half.
        let live_turns = vec![
            SpeakerTurn {
                start: Duration::from_secs(0),
                end: Duration::from_secs(6),
                speaker: SpeakerId(0),
            },
            SpeakerTurn {
                start: Duration::from_secs(6),
                end: Duration::from_secs(12),
                speaker: SpeakerId(1),
            },
        ];

        run_finalize(FinalizeConfig {
            id,
            store: store.clone(),
            audio_path: wav,
            transcriber: Box::new(MockTranscriber {
                seg_secs: 6.0,
                text_template: "f{n}".to_string(),
            }),
            // 2 speakers, equal halves → MockDiarizer flips ids relative to live.
            diarizer: Some(Box::new(MockDiarizer::new(2))),
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
            diarize_opts: DiarizeOptions::default(),
            live_turns,
        })
        .unwrap();

        let snap = store.get(id).unwrap();
        let finals = snap.final_segments.as_ref().unwrap();
        // Whatever speaker IDs the offline diarizer used, they were remapped to
        // the live IDs (0 and 1), so the user names still resolve.
        let used: std::collections::BTreeSet<_> = finals.iter().filter_map(|s| s.speaker).collect();
        assert!(used.contains(&SpeakerId(0)) || used.contains(&SpeakerId(1)));
        assert_eq!(snap.speaker_label(SpeakerId(0)), "Ola");
        assert_eq!(snap.speaker_label(SpeakerId(1)), "Bartek");
    }

    #[test]
    fn finalize_with_missing_audio_flips_to_failed() {
        let store_dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(store_dir.path()));
        let (id, _wav) = seed_finalizing_session(&store, 4.0);
        // Delete the audio after seeding (simulates "discard audio" / corruption).
        let _ = std::fs::remove_file(store.session_dir(id).join("audio.wav"));

        let err = run_finalize(FinalizeConfig {
            id,
            store: store.clone(),
            audio_path: store.session_dir(id).join("audio.wav"),
            transcriber: Box::new(MockTranscriber::new()),
            diarizer: None,
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
            diarize_opts: DiarizeOptions::default(),
            live_turns: vec![],
        })
        .unwrap_err();
        assert!(matches!(err, DriverError::Transcribe(_)), "got {err:?}");
        let snap = store.get(id).unwrap();
        assert!(matches!(snap.status, TranscriptStatus::Failed { .. }));
        // The live transcript (such as it is) is untouched.
        assert!(snap.final_segments.is_none());
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
            diarizer: None,
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
            diarize_opts: DiarizeOptions::default(),
            live_turns: vec![],
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
            diarizer: None,
            transcribe_opts: TranscribeOptions::for_language(Language::Pl),
            diarize_opts: DiarizeOptions::default(),
            live_turns: vec![],
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
}
