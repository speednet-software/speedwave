//! Whisper speech-to-text: the `Transcriber` trait and `WhisperCppTranscriber`
//! (whisper.cpp via `whisper-rs`). Language is always forced, never auto-detected.

use std::path::Path;
use std::time::Duration;

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

/// A speech-to-text engine. `transcribe()` is the offline/finalize path (whole
/// buffer); `feed()` is the live path (a growing decode window — tail segments
/// may change as more context arrives). One transcriber per recording (Whisper
/// state is single-threaded).
pub trait Transcriber: Send {
    /// Transcribe `pcm` (16 kHz mono `f32`, `[-1, 1]`) in one shot.
    fn transcribe(
        &mut self,
        pcm: &[f32],
        opts: &TranscribeOptions,
    ) -> Result<Vec<Segment>, TranscribeError>;

    /// Decode the current live window. Default = `transcribe(window)`;
    /// `WhisperCppTranscriber` uses the same (the window policy lives in the
    /// driver).
    fn feed(
        &mut self,
        pcm_window: &[f32],
        opts: &TranscribeOptions,
    ) -> Result<Vec<Segment>, TranscribeError> {
        self.transcribe(pcm_window, opts)
    }
}

/// Whisper speech-to-text via whisper.cpp. Holds a loaded context for one
/// model; create one per recording.
pub struct WhisperCppTranscriber {
    ctx: whisper_rs::WhisperContext,
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
            model_label: label,
        })
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
        // Near-silent input makes Whisper emit trained-in filler ("Dziękuję" /
        // "Thank you") — skip it instead of transcribing hallucinations.
        if pcm.is_empty() || is_silent(pcm) {
            return Ok(Vec::new());
        }
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
        // Anti-hallucination: no cross-window context (a hallucinated segment
        // would otherwise seed the next window), deterministic decoding, and
        // whisper.cpp's blank/non-speech-token suppression. (`no_speech_thold`
        // is a no-op in whisper.cpp; we gate on per-segment prob below instead.)
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
            // The model's own no-speech probability drops silence-hallucinated
            // segments by signal, not by matching text (which would eat real
            // short utterances).
            if seg.no_speech_probability() > NO_SPEECH_MAX {
                continue;
            }
            // whisper_rs timestamps are centiseconds.
            let start = cs_to_duration(seg.start_timestamp());
            let end = cs_to_duration(seg.end_timestamp());
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

/// `true` if `pcm` is quiet enough to be silence (empty counts as silent).
fn is_silent(pcm: &[f32]) -> bool {
    if pcm.is_empty() {
        return true;
    }
    let sum_sq: f64 = pcm.iter().map(|&s| (s as f64) * (s as f64)).sum();
    ((sum_sq / pcm.len() as f64).sqrt() as f32) < SILENCE_RMS
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
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    // `WhisperCppTranscriber` has no `Debug` (it wraps a `WhisperContext`), so
    // `unwrap_err()` won't compile — pattern-match the error out.
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
        // Backward compat (ADR-075): pre-removal transcripts carried a
        // `speaker` field on each segment. Removing it must not break loading
        // existing `transcript.json` files — serde ignores the unknown key.
        let legacy = r#"{"start":{"secs":1,"nanos":0},"end":{"secs":2,"nanos":0},
            "text":"hej","words":[],"speaker":3}"#;
        let seg: Segment = serde_json::from_str(legacy).unwrap();
        assert_eq!(seg.text, "hej");
        assert_eq!(seg.start, Duration::from_secs(1));
    }

    // Real whisper.cpp inference (needs a ≥75 MiB model + the C++ engine) is an
    // opt-in CI job, not a unit test — verified end-to-end in ADR-056 spike 0A.
}
