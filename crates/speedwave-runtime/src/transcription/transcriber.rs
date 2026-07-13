//! Whisper speech-to-text: the `Transcriber` trait and `WhisperCppTranscriber`
//! (whisper.cpp via `whisper-rs`). Language is always forced, never auto-detected.

use std::path::Path;
use std::time::Duration;

use super::audio::{rms, SAMPLE_RATE_HZ};

/// Languages this feature transcribes (forced into Whisper).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Language {
    /// Polish.
    Pl,
    /// English.
    En,
}

impl Language {
    /// Whisper language code (`"pl"` / `"en"`).
    pub fn code(self) -> &'static str {
        match self {
            Language::Pl => "pl",
            Language::En => "en",
        }
    }
}

/// Options for a transcription run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranscribeOptions {
    /// Forced language.
    pub language: Language,
    /// Ask Whisper for word-level timestamps (slower; fills `Segment::words`).
    pub word_timestamps: bool,
    /// Translate to English instead of transcribing. Always `false` in v1.
    pub translate: bool,
}

impl TranscribeOptions {
    /// Transcribe `language`, no word timestamps.
    pub fn for_language(language: Language) -> Self {
        Self {
            language,
            word_timestamps: false,
            translate: false,
        }
    }
}

/// A word with its time span (populated only when `word_timestamps` is set).
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Word {
    /// Word text.
    pub text: String,
    /// Start offset from the start of the audio.
    pub start: Duration,
    /// End offset.
    pub end: Duration,
}

/// One transcript segment: a span of audio, its text, and optional per-word
/// timings. (Speaker diarization was removed — ADR-075.)
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Segment {
    /// Start offset from the start of the audio.
    pub start: Duration,
    /// End offset.
    pub end: Duration,
    /// Segment text (trimmed).
    pub text: String,
    /// Per-word timings (empty unless requested).
    pub words: Vec<Word>,
}

/// Transcriber errors.
#[derive(Debug, thiserror::Error)]
pub enum TranscribeError {
    /// The Whisper model file couldn't be loaded.
    #[error("failed to load Whisper model {model}: {detail}")]
    ModelLoad {
        /// Catalogue key or path.
        model: String,
        /// Underlying error.
        detail: String,
    },
    /// The model isn't downloaded — fetch it via `ModelStore` first. A valid
    /// state (the UI prompts a download), not a bug.
    #[error("Whisper model {0} is not downloaded")]
    ModelMissing(String),
    /// Whisper inference failed.
    #[error("Whisper inference failed: {0}")]
    Inference(String),
    /// Unusable input PCM.
    #[error("invalid audio for transcription: {0}")]
    InvalidAudio(String),
}

/// A speech-to-text engine. `transcribe()` is the offline/finalize path (whole buffer); `feed()`
/// is the live path (a growing decode window, tail segments may change). One per recording.
pub trait Transcriber: Send {
    /// Transcribe `pcm` (16 kHz mono `f32`, `[-1, 1]`) in one shot.
    fn transcribe(
        &mut self,
        pcm: &[f32],
        opts: &TranscribeOptions,
    ) -> Result<Vec<Segment>, TranscribeError>;

    /// Decode the current live window. Default = `transcribe(window)`; `WhisperCppTranscriber`
    /// uses the same (window policy lives in the driver).
    fn feed(
        &mut self,
        pcm_window: &[f32],
        opts: &TranscribeOptions,
    ) -> Result<Vec<Segment>, TranscribeError> {
        self.transcribe(pcm_window, opts)
    }
}

/// Tolerance when matching a decoded segment against VAD speech spans — VAD
/// edges and Whisper timestamps disagree by up to a few hundred ms.
const VAD_OVERLAP_TOLERANCE: Duration = Duration::from_millis(200);

/// Standalone Silero VAD (whisper.cpp GGML build). Runs on the raw decode
/// window, so Whisper timestamps are never remapped (ADR-056 Amendment 8).
struct SileroVad {
    ctx: whisper_rs::WhisperVadContext,
}

impl SileroVad {
    /// Loads the GGML Silero model at `model_path`.
    fn load(model_path: &Path) -> Result<Self, TranscribeError> {
        let path = model_path
            .to_str()
            .ok_or_else(|| TranscribeError::ModelLoad {
                model: "silero-vad".to_string(),
                detail: "non-UTF-8 model path".to_string(),
            })?;
        if !model_path.is_file() {
            return Err(TranscribeError::ModelMissing("silero-vad".to_string()));
        }
        let ctx = whisper_rs::WhisperVadContext::new(
            path,
            whisper_rs::WhisperVadContextParams::default(),
        )
        .map_err(|e| TranscribeError::ModelLoad {
            model: "silero-vad".to_string(),
            detail: e.to_string(),
        })?;
        Ok(Self { ctx })
    }

    /// Speech spans in `pcm` (16 kHz mono), window-relative. Whisper.cpp default
    /// tuning: threshold 0.5, min speech 250 ms, min silence 100 ms, pad 30 ms.
    fn speech_spans(&mut self, pcm: &[f32]) -> Result<Vec<(Duration, Duration)>, TranscribeError> {
        let segments = self
            .ctx
            .segments_from_samples(whisper_rs::WhisperVadParams::default(), pcm)
            .map_err(|e| TranscribeError::Inference(format!("silero vad: {e}")))?;
        // whisper.cpp VAD timestamps are centiseconds.
        Ok(segments
            .map(|s| {
                (
                    Duration::from_secs_f32(s.start.max(0.0) / 100.0),
                    Duration::from_secs_f32(s.end.max(0.0) / 100.0),
                )
            })
            .collect())
    }
}

/// `true` when `[start, end]` overlaps any VAD speech span, padded by
/// [`VAD_OVERLAP_TOLERANCE`] on both edges.
fn overlaps_speech(spans: &[(Duration, Duration)], start: Duration, end: Duration) -> bool {
    spans
        .iter()
        .any(|(s, e)| start < *e + VAD_OVERLAP_TOLERANCE && *s < end + VAD_OVERLAP_TOLERANCE)
}

/// Whisper speech-to-text via whisper.cpp. Holds a loaded context for one
/// model; create one per recording.
pub struct WhisperCppTranscriber {
    ctx: whisper_rs::WhisperContext,
    vad: Option<SileroVad>,
    model_label: String,
}

impl WhisperCppTranscriber {
    /// Loads the GGML model at `model_path`. `model_label` is for error messages.
    pub fn load(
        model_path: &Path,
        model_label: impl Into<String>,
    ) -> Result<Self, TranscribeError> {
        let label = model_label.into();
        if !model_path.is_file() {
            return Err(TranscribeError::ModelMissing(label));
        }
        let ctx = whisper_rs::WhisperContext::new_with_params(
            model_path,
            whisper_rs::WhisperContextParameters::default(),
        )
        .map_err(|e| TranscribeError::ModelLoad {
            model: label.clone(),
            detail: e.to_string(),
        })?;
        Ok(Self {
            ctx,
            vad: None,
            model_label: label,
        })
    }

    /// Attaches the Silero VAD gate (ADR-056 Amendment 8). Without it the
    /// transcriber falls back to the signal-only hallucination gates below.
    pub fn enable_vad(&mut self, vad_model_path: &Path) -> Result<(), TranscribeError> {
        self.vad = Some(SileroVad::load(vad_model_path)?);
        Ok(())
    }

    /// Loads catalogue model `key` from `whisper_dir`; `ModelMissing` if absent.
    /// Test-only: production resolves the model path itself and calls `load`.
    #[cfg(test)]
    pub fn load_catalogue_model(key: &str, whisper_dir: &Path) -> Result<Self, TranscribeError> {
        use crate::transcription::model_catalog::{whisper_model, WhisperModelInfo};
        let info: &WhisperModelInfo =
            whisper_model(key).ok_or_else(|| TranscribeError::ModelMissing(key.to_string()))?;
        Self::load(&whisper_dir.join(info.file), key)
    }

    /// Catalogue key / path this transcriber was loaded with.
    pub fn model_label(&self) -> &str {
        &self.model_label
    }

    fn run(
        &mut self,
        pcm: &[f32],
        opts: &TranscribeOptions,
    ) -> Result<Vec<Segment>, TranscribeError> {
        // Near-silent input makes Whisper emit trained-in filler ("Dziękuję"/"Thank you") — skip.
        if pcm.is_empty() || is_silent(pcm) {
            return Ok(Vec::new());
        }
        // VAD gate: no speech in the window = no decode. A VAD failure degrades
        // to the signal-only gates rather than killing the recording.
        let speech_spans = match self.vad.as_mut().map(|v| v.speech_spans(pcm)) {
            Some(Ok(spans)) if spans.is_empty() => return Ok(Vec::new()),
            Some(Ok(spans)) => Some(spans),
            Some(Err(e)) => {
                log::warn!(
                    target: "transcription::transcriber",
                    "silero vad failed ({e}) — continuing without the VAD gate"
                );
                self.vad = None;
                None
            }
            None => None,
        };
        let mut state = self
            .ctx
            .create_state()
            .map_err(|e| TranscribeError::Inference(format!("create state: {e}")))?;
        let mut params =
            whisper_rs::FullParams::new(whisper_rs::SamplingStrategy::Greedy { best_of: 1 });
        params.set_language(Some(opts.language.code())); // forced, never auto
        params.set_translate(opts.translate);
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        // Anti-hallucination: no cross-window context, deterministic decoding, blank/nst suppress.
        // `no_speech_thold` is a no-op in whisper.cpp — we gate on per-segment prob below instead.
        params.set_no_context(true);
        params.set_temperature(0.0);
        params.set_suppress_blank(true);
        params.set_suppress_nst(true);
        params.set_entropy_thold(2.4);
        params.set_logprob_thold(-1.0);
        if opts.word_timestamps {
            params.set_token_timestamps(true);
            params.set_max_len(1); // one token per segment → segment ts == word ts
        }
        state
            .full(params, pcm)
            .map_err(|e| TranscribeError::Inference(format!("whisper_full: {e}")))?;

        let n = state.full_n_segments();
        let mut out = Vec::with_capacity(n.max(0) as usize);
        for i in 0..n {
            let Some(seg) = state.get_segment(i) else {
                continue;
            };
            let no_speech = seg.no_speech_probability();
            let seg_rms = rms(segment_pcm(pcm, seg.start_timestamp(), seg.end_timestamp()));
            // Metrics only — segment text must stay out of the logs.
            log::debug!(
                target: "transcription::transcriber",
                "segment {}..{}cs rms={seg_rms:.5} no_speech={no_speech:.2}",
                seg.start_timestamp(),
                seg.end_timestamp()
            );
            // whisper_rs timestamps are centiseconds.
            let start = cs_to_duration(seg.start_timestamp());
            let end = cs_to_duration(seg.end_timestamp());
            if is_hallucinated(no_speech, seg_rms) {
                continue;
            }
            // A segment over a span VAD heard no speech in is a hallucination,
            // whatever its text — drop it.
            if let Some(spans) = &speech_spans {
                if !overlaps_speech(spans, start, end) {
                    continue;
                }
            }
            let text = format!("{seg}").trim().to_string();
            if text.is_empty() {
                continue;
            }
            out.push(Segment {
                start,
                end,
                text,
                words: Vec::new(),
            });
        }
        if opts.word_timestamps {
            for seg in &mut out {
                seg.words = vec![Word {
                    text: seg.text.clone(),
                    start: seg.start,
                    end: seg.end,
                }];
            }
        }
        Ok(out)
    }
}

impl Transcriber for WhisperCppTranscriber {
    fn transcribe(
        &mut self,
        pcm: &[f32],
        opts: &TranscribeOptions,
    ) -> Result<Vec<Segment>, TranscribeError> {
        self.run(pcm, opts)
    }

    fn feed(
        &mut self,
        pcm_window: &[f32],
        opts: &TranscribeOptions,
    ) -> Result<Vec<Segment>, TranscribeError> {
        self.run(pcm_window, opts)
    }
}

fn cs_to_duration(centiseconds: i64) -> Duration {
    Duration::from_millis(centiseconds.max(0) as u64 * 10)
}

/// RMS below this (−60 dBFS) is treated as silence and skips the decode. Only a
/// true noise floor gates; quiet speech goes to Whisper's no-speech filter.
const SILENCE_RMS: f32 = 0.001;

/// Drop a segment whose no-speech probability exceeds this — whisper.cpp's own
/// estimate that the span is not speech (the filler-on-silence signature).
const NO_SPEECH_MAX: f32 = 0.6;

/// A merely-elevated no-speech probability drops the segment only when the
/// audio under it also sits below [`SPEECH_RMS_FLOOR`] (two signals agree).
const NO_SPEECH_SUSPECT: f32 = 0.3;

/// RMS below this (−45 dBFS) cannot be intelligible speech.
const SPEECH_RMS_FLOOR: f32 = 0.0055;

/// `true` if `pcm` is quiet enough to be silence (empty counts as silent).
fn is_silent(pcm: &[f32]) -> bool {
    rms(pcm) < SILENCE_RMS
}

/// The window samples under a whisper segment (centisecond timestamps, 16 kHz).
fn segment_pcm(pcm: &[f32], start_cs: i64, end_cs: i64) -> &[f32] {
    const SAMPLES_PER_CS: i64 = SAMPLE_RATE_HZ as i64 / 100;
    let a = (start_cs.max(0).saturating_mul(SAMPLES_PER_CS)).min(pcm.len() as i64) as usize;
    let b = (end_cs.max(0).saturating_mul(SAMPLES_PER_CS)).min(pcm.len() as i64) as usize;
    &pcm[a..b.max(a)]
}

/// Signal-driven hallucination verdict for one decoded segment.
fn is_hallucinated(no_speech: f32, seg_rms: f32) -> bool {
    no_speech > NO_SPEECH_MAX || (no_speech > NO_SPEECH_SUSPECT && seg_rms < SPEECH_RMS_FLOOR)
}

/// Deterministic fake transcriber for orchestration tests — one segment per
/// `seg_secs` of audio with placeholder text. `#[cfg(test)]` only.
#[cfg(test)]
pub struct MockTranscriber {
    /// Seconds of audio per emitted segment.
    pub seg_secs: f32,
    /// Text template; `{n}` → segment index.
    pub text_template: String,
}

#[cfg(test)]
impl MockTranscriber {
    /// Creates a mock transcriber with default segment length and template.
    pub fn new() -> Self {
        Self {
            seg_secs: 5.0,
            text_template: "segment {n}".to_string(),
        }
    }
}

#[cfg(test)]
impl Default for MockTranscriber {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
impl Transcriber for MockTranscriber {
    fn transcribe(
        &mut self,
        pcm: &[f32],
        _opts: &TranscribeOptions,
    ) -> Result<Vec<Segment>, TranscribeError> {
        if pcm.is_empty() {
            return Ok(Vec::new());
        }
        let total = pcm.len() as f32 / 16_000.0;
        let n = (total / self.seg_secs).ceil().max(1.0) as usize;
        Ok((0..n)
            .map(|i| Segment {
                start: Duration::from_secs_f32(i as f32 * self.seg_secs),
                end: Duration::from_secs_f32(((i + 1) as f32 * self.seg_secs).min(total)),
                text: self.text_template.replace("{n}", &i.to_string()),
                words: Vec::new(),
            })
            .collect())
    }
}

#[cfg(test)]
#[expect(clippy::unwrap_used, reason = "test code")]
mod tests {
    use super::*;

    // `WhisperCppTranscriber` has no `Debug`, so `unwrap_err()` won't compile — pattern-match it.
    fn load_err(path: &Path, label: &str) -> TranscribeError {
        match WhisperCppTranscriber::load(path, label) {
            Ok(_) => panic!("expected load() to fail"),
            Err(e) => e,
        }
    }
    fn load_catalogue_err(key: &str, dir: &Path) -> TranscribeError {
        match WhisperCppTranscriber::load_catalogue_model(key, dir) {
            Ok(_) => panic!("expected load_catalogue_model() to fail"),
            Err(e) => e,
        }
    }

    #[test]
    fn language_codes() {
        assert_eq!(Language::Pl.code(), "pl");
        assert_eq!(Language::En.code(), "en");
    }

    #[test]
    fn cs_to_duration_converts_centiseconds() {
        assert_eq!(cs_to_duration(0), Duration::ZERO);
        assert_eq!(cs_to_duration(150), Duration::from_millis(1500));
        assert_eq!(cs_to_duration(-5), Duration::ZERO);
    }

    #[test]
    fn hallucination_guard_needs_both_signals_to_agree() {
        // Model certain the span is not speech — dropped regardless of energy.
        assert!(is_hallucinated(0.7, 0.5));
        // Model unsure AND audio below the speech floor — dropped.
        assert!(is_hallucinated(0.4, 0.001));
        // Model unsure but the audio is loud — kept (real sound, model's call).
        assert!(!is_hallucinated(0.4, 0.05));
        // Model confident it is speech — kept even when quiet.
        assert!(!is_hallucinated(0.1, 0.001));
        // Thresholds are strict: exactly-at values are kept.
        assert!(!is_hallucinated(0.3, 0.001));
        assert!(!is_hallucinated(0.6, 0.0055));
    }

    #[test]
    fn overlaps_speech_matches_within_tolerance_only() {
        let spans = vec![
            (Duration::from_secs(1), Duration::from_secs(3)),
            (Duration::from_secs(10), Duration::from_secs(12)),
        ];
        // Fully inside a span.
        assert!(overlaps_speech(
            &spans,
            Duration::from_millis(1500),
            Duration::from_millis(2500)
        ));
        // Straddling a span edge.
        assert!(overlaps_speech(
            &spans,
            Duration::from_millis(2500),
            Duration::from_millis(4000)
        ));
        // Within the 200 ms tolerance before a span starts.
        assert!(overlaps_speech(
            &spans,
            Duration::from_millis(700),
            Duration::from_millis(900)
        ));
        // In the silence gap, farther than the tolerance from both spans.
        assert!(!overlaps_speech(
            &spans,
            Duration::from_millis(5000),
            Duration::from_millis(8000)
        ));
        // Past the last span.
        assert!(!overlaps_speech(
            &spans,
            Duration::from_secs(20),
            Duration::from_secs(21)
        ));
        // No spans at all never matches.
        assert!(!overlaps_speech(
            &[],
            Duration::ZERO,
            Duration::from_secs(1)
        ));
        // A zero-length segment inside a span still matches.
        assert!(overlaps_speech(
            &spans,
            Duration::from_secs(2),
            Duration::from_secs(2)
        ));
    }

    #[test]
    fn silero_vad_load_reports_missing_and_corrupt_models() {
        let err = match SileroVad::load(Path::new("/no/such/vad.bin")) {
            Ok(_) => panic!("expected load to fail"),
            Err(e) => e,
        };
        assert!(
            matches!(err, TranscribeError::ModelMissing(ref m) if m == "silero-vad"),
            "got {err}"
        );
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vad.bin");
        std::fs::write(&path, b"not a ggml vad model").unwrap();
        let err = match SileroVad::load(&path) {
            Ok(_) => panic!("expected load to fail"),
            Err(e) => e,
        };
        assert!(
            matches!(err, TranscribeError::ModelLoad { ref model, .. } if model == "silero-vad"),
            "got {err}"
        );
    }

    #[test]
    fn segment_pcm_maps_centiseconds_and_clamps() {
        let pcm: Vec<f32> = (0..16_000).map(|i| i as f32).collect(); // 1 s at 16 kHz
        assert_eq!(segment_pcm(&pcm, 10, 20), &pcm[1_600..3_200]);
        // An end past the window clamps to the window.
        assert_eq!(segment_pcm(&pcm, 90, 500), &pcm[14_400..]);
        // Degenerate, reversed, and out-of-window spans yield an empty slice.
        assert!(segment_pcm(&pcm, 50, 50).is_empty());
        assert!(segment_pcm(&pcm, 60, 40).is_empty());
        assert!(segment_pcm(&pcm, 200, 300).is_empty());
        // Negative timestamps clamp to the start.
        assert_eq!(segment_pcm(&pcm, -5, 10), &pcm[0..1_600]);
    }

    #[test]
    fn is_silent_flags_quiet_and_empty_but_not_speech() {
        assert!(is_silent(&[]));
        assert!(is_silent(&vec![0.0f32; 16_000]));
        // A near-noise-floor level (−66 dBFS) is still silence.
        assert!(is_silent(&vec![0.0005f32; 16_000]));
        // Quiet real speech (−54 dBFS: low OS input volume + 0.5 mix gain) must
        // reach the decoder — Whisper's no-speech filter owns that judgement.
        assert!(!is_silent(&vec![0.002f32; 16_000]));
        // A half-scale tone is clearly not silence.
        let tone: Vec<f32> = (0..16_000)
            .map(|i| 0.5 * (2.0 * std::f32::consts::PI * 220.0 * i as f32 / 16_000.0).sin())
            .collect();
        assert!(!is_silent(&tone));
    }

    #[test]
    fn transcribe_options_for_language_never_translates() {
        let o = TranscribeOptions::for_language(Language::Pl);
        assert_eq!(o.language, Language::Pl);
        assert!(!o.translate && !o.word_timestamps);
    }

    #[test]
    fn whisper_load_reports_model_missing_for_a_nonexistent_path() {
        let err = load_err(Path::new("/no/such/model.bin"), "ghost");
        assert!(
            matches!(err, TranscribeError::ModelMissing(ref m) if m == "ghost"),
            "got {err:?}"
        );
    }

    #[test]
    fn whisper_load_catalogue_model_reports_missing_when_not_downloaded_or_unknown() {
        let dir = tempfile::tempdir().unwrap();
        assert!(matches!(
            load_catalogue_err("tiny", dir.path()),
            TranscribeError::ModelMissing(_)
        ));
        assert!(matches!(
            load_catalogue_err("not-a-model", dir.path()),
            TranscribeError::ModelMissing(_)
        ));
    }

    #[test]
    fn whisper_load_reports_model_load_for_a_corrupt_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("corrupt.bin");
        std::fs::write(&path, b"this is not a GGML model at all").unwrap();
        assert!(matches!(
            load_err(&path, "corrupt"),
            TranscribeError::ModelLoad { .. }
        ));
    }

    #[test]
    fn mock_transcriber_segments_by_duration() {
        let mut t = MockTranscriber {
            seg_secs: 2.0,
            text_template: "s{n}".to_string(),
        };
        let opts = TranscribeOptions::for_language(Language::Pl);
        let pcm = vec![0.0f32; 5 * 16_000]; // 5 s
        let segs = t.transcribe(&pcm, &opts).unwrap();
        assert_eq!(segs.len(), 3); // 2 + 2 + 1
        assert_eq!(segs[0].text, "s0");
        assert_eq!(segs[2].text, "s2");
        assert!((segs[1].start.as_secs_f32() - 2.0).abs() < 0.01);
        assert!((segs[2].end.as_secs_f32() - 5.0).abs() < 0.01);
        assert!(segs.iter().all(|s| s.words.is_empty()));
        assert!(t.transcribe(&[], &opts).unwrap().is_empty());
        assert_eq!(t.feed(&pcm, &opts).unwrap().len(), 3);
    }

    #[test]
    fn segment_and_language_round_trip_through_serde() {
        let seg = Segment {
            start: Duration::from_millis(1230),
            end: Duration::from_millis(4560),
            text: "cześć świat".to_string(),
            words: vec![Word {
                text: "cześć".into(),
                start: Duration::from_millis(1230),
                end: Duration::from_millis(2000),
            }],
        };
        assert_eq!(
            serde_json::from_str::<Segment>(&serde_json::to_string(&seg).unwrap()).unwrap(),
            seg
        );
        for l in [Language::Pl, Language::En] {
            assert_eq!(
                serde_json::from_str::<Language>(&serde_json::to_string(&l).unwrap()).unwrap(),
                l
            );
        }
    }

    #[test]
    fn old_segment_json_with_a_speaker_field_still_deserializes() {
        // Backward compat (ADR-075): pre-removal transcripts carried a `speaker` field on each
        // segment; serde ignores the unknown key so existing transcript.json files still load.
        let legacy = r#"{"start":{"secs":1,"nanos":0},"end":{"secs":2,"nanos":0},
            "text":"hej","words":[],"speaker":3}"#;
        let seg: Segment = serde_json::from_str(legacy).unwrap();
        assert_eq!(seg.text, "hej");
        assert_eq!(seg.start, Duration::from_secs(1));
    }

    // Real whisper.cpp inference (needs a ≥75 MiB model + the C++ engine) is an
    // opt-in CI job, not a unit test — verified end-to-end in ADR-056 spike 0A.
}
