//! Speaker diarization: the `Diarizer` trait and `SherpaDiarizer` (sherpa-onnx,
//! pyannote segmentation + the default embedding from the catalogue — 3D-Speaker
//! CAM++ today, see `model_catalog.rs`). Labels are provisional (ADR-056 §7) —
//! not stable across runs.

use std::path::Path;
use std::time::Duration;

use crate::transcription::transcriber::{Segment, SpeakerId};

/// One stretch of audio attributed to a speaker.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct SpeakerTurn {
    /// Start offset from the start of the audio.
    pub start: Duration,
    /// End offset.
    pub end: Duration,
    /// Speaker for this turn.
    pub speaker: SpeakerId,
}

impl SpeakerTurn {
    /// Overlap (in seconds) of this turn with `[seg_start, seg_end]`.
    fn overlap_secs(&self, seg_start: Duration, seg_end: Duration) -> f64 {
        let a = self.start.max(seg_start).as_secs_f64();
        let b = self.end.min(seg_end).as_secs_f64();
        (b - a).max(0.0)
    }
}

/// Diarization options.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DiarizeOptions {
    /// Fixed speaker count if known; `None` = auto-estimate via threshold.
    pub num_speakers: Option<usize>,
    /// Clustering similarity threshold (used when `num_speakers` is `None`).
    pub threshold: f32,
    /// Minimum on-speech duration (seconds) the segmentation model keeps.
    pub min_duration_on: f32,
    /// Minimum off-speech (gap) duration (seconds).
    pub min_duration_off: f32,
}

impl Default for DiarizeOptions {
    fn default() -> Self {
        Self {
            num_speakers: None,
            threshold: 0.5,
            min_duration_on: 0.3,
            min_duration_off: 0.5,
        }
    }
}

/// Diarizer errors.
#[derive(Debug, thiserror::Error)]
pub enum DiarizeError {
    /// A required ONNX model file is missing — fetch via `ModelStore` first.
    #[error("diarization model file not found: {0}")]
    ModelMissing(String),
    /// sherpa-onnx couldn't build the pipeline (bad model paths/format).
    #[error("failed to create the diarization pipeline: {0}")]
    PipelineCreate(String),
    /// Diarization inference failed.
    #[error("diarization failed: {0}")]
    Inference(String),
    /// Unusable input PCM.
    #[error("invalid audio for diarization: {0}")]
    InvalidAudio(String),
}

/// A speaker-diarization engine. `diarize()` clusters a whole 16 kHz mono
/// buffer into speaker turns; `assign_speakers()` stamps each transcript
/// segment with the speaker whose turn overlaps it most. One per recording.
pub trait Diarizer: Send {
    /// Cluster `pcm` (16 kHz mono `f32`, `[-1, 1]`) into speaker turns.
    fn diarize(
        &mut self,
        pcm: &[f32],
        opts: &DiarizeOptions,
    ) -> Result<Vec<SpeakerTurn>, DiarizeError>;

    /// Stamp each segment with the speaker of the turn it overlaps most. A
    /// segment with no overlap is left as `None`. Default impl; not usually
    /// overridden.
    fn assign_speakers(&self, segments: &mut [Segment], turns: &[SpeakerTurn]) {
        assign_speakers_by_overlap(segments, turns);
    }
}

/// Each segment gets the speaker of the turn covering the most of it; ties
/// resolved by smaller `SpeakerId` (deterministic); no overlap → unchanged.
pub fn assign_speakers_by_overlap(segments: &mut [Segment], turns: &[SpeakerTurn]) {
    for seg in segments.iter_mut() {
        let mut best: Option<(SpeakerId, f64)> = None;
        for t in turns {
            let ov = t.overlap_secs(seg.start, seg.end);
            if ov <= 0.0 {
                continue;
            }
            match best {
                Some((id, cur)) if ov < cur || (ov == cur && t.speaker.0 >= id.0) => {}
                _ => best = Some((t.speaker, ov)),
            }
        }
        if let Some((id, _)) = best {
            seg.speaker = Some(id);
        }
    }
}

/// Speaker diarization via sherpa-onnx (pyannote segmentation + the catalogue's
/// default embedding model, FastClustering). Holds the loaded pipeline; create
/// one per recording.
pub struct SherpaDiarizer {
    inner: sherpa_onnx::OfflineSpeakerDiarization,
}

impl SherpaDiarizer {
    /// Builds the pipeline from a segmentation `.onnx` and an embedding `.onnx`
    /// (typically from `ModelStore::ensure_diarization_models`).
    pub fn load(
        segmentation_onnx: &Path,
        embedding_onnx: &Path,
        opts: &DiarizeOptions,
    ) -> Result<Self, DiarizeError> {
        if !segmentation_onnx.is_file() {
            return Err(DiarizeError::ModelMissing(
                segmentation_onnx.display().to_string(),
            ));
        }
        if !embedding_onnx.is_file() {
            return Err(DiarizeError::ModelMissing(
                embedding_onnx.display().to_string(),
            ));
        }
        let config = sherpa_onnx::OfflineSpeakerDiarizationConfig {
            segmentation: sherpa_onnx::OfflineSpeakerSegmentationModelConfig {
                pyannote: sherpa_onnx::OfflineSpeakerSegmentationPyannoteModelConfig {
                    model: Some(segmentation_onnx.to_string_lossy().into_owned()),
                },
                num_threads: 2,
                debug: false,
                provider: Some("cpu".to_string()),
            },
            embedding: sherpa_onnx::SpeakerEmbeddingExtractorConfig {
                model: Some(embedding_onnx.to_string_lossy().into_owned()),
                num_threads: 2,
                debug: false,
                provider: Some("cpu".to_string()),
            },
            clustering: sherpa_onnx::FastClusteringConfig {
                num_clusters: opts.num_speakers.map(|n| n as i32).unwrap_or(-1),
                threshold: opts.threshold,
            },
            min_duration_on: opts.min_duration_on,
            min_duration_off: opts.min_duration_off,
        };
        let inner = sherpa_onnx::OfflineSpeakerDiarization::create(&config).ok_or_else(|| {
            DiarizeError::PipelineCreate(
                "sherpa-onnx returned null (check model paths/format)".to_string(),
            )
        })?;
        Ok(Self { inner })
    }

    /// Sample rate the segmentation model expects (should be 16 kHz).
    pub fn sample_rate(&self) -> i32 {
        self.inner.sample_rate()
    }
}

impl Diarizer for SherpaDiarizer {
    fn diarize(
        &mut self,
        pcm: &[f32],
        _opts: &DiarizeOptions,
    ) -> Result<Vec<SpeakerTurn>, DiarizeError> {
        if pcm.is_empty() {
            return Ok(Vec::new());
        }
        let res = self.inner.process(pcm).ok_or_else(|| {
            DiarizeError::Inference("sherpa-onnx process() returned null".to_string())
        })?;
        Ok(res
            .sort_by_start_time()
            .into_iter()
            .map(|s| SpeakerTurn {
                start: Duration::from_secs_f32(s.start.max(0.0)),
                end: Duration::from_secs_f32(s.end.max(0.0)),
                speaker: SpeakerId(s.speaker.max(0) as u32),
            })
            .collect())
    }
}

/// Deterministic fake diarizer for orchestration tests — splits the buffer
/// into `n_speakers` equal slices, one speaker each, round-robin. `#[cfg(test)]`.
#[cfg(test)]
pub struct MockDiarizer {
    /// Number of speakers to produce.
    pub n_speakers: u32,
}

#[cfg(test)]
impl MockDiarizer {
    /// Creates a mock diarizer producing `n_speakers` (min 1) speakers.
    pub fn new(n_speakers: u32) -> Self {
        Self {
            n_speakers: n_speakers.max(1),
        }
    }
}

#[cfg(test)]
impl Diarizer for MockDiarizer {
    fn diarize(
        &mut self,
        pcm: &[f32],
        _opts: &DiarizeOptions,
    ) -> Result<Vec<SpeakerTurn>, DiarizeError> {
        if pcm.is_empty() {
            return Ok(Vec::new());
        }
        let total = pcm.len() as f32 / 16_000.0;
        let slice = total / self.n_speakers as f32;
        Ok((0..self.n_speakers)
            .map(|i| SpeakerTurn {
                start: Duration::from_secs_f32(i as f32 * slice),
                end: Duration::from_secs_f32(((i + 1) as f32 * slice).min(total)),
                speaker: SpeakerId(i),
            })
            .collect())
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    fn seg(start_s: f32, end_s: f32) -> Segment {
        Segment {
            start: Duration::from_secs_f32(start_s),
            end: Duration::from_secs_f32(end_s),
            text: format!("[{start_s}-{end_s}]"),
            words: vec![],
            speaker: None,
        }
    }

    fn turn(start_s: f32, end_s: f32, spk: u32) -> SpeakerTurn {
        SpeakerTurn {
            start: Duration::from_secs_f32(start_s),
            end: Duration::from_secs_f32(end_s),
            speaker: SpeakerId(spk),
        }
    }

    #[test]
    fn assign_speakers_picks_the_turn_with_the_most_overlap() {
        // Segment 2..6; speaker 0 covers 0..3 (1 s overlap), speaker 1 covers 3..10 (3 s) → 1.
        let mut segs = vec![seg(2.0, 6.0)];
        assign_speakers_by_overlap(&mut segs, &[turn(0.0, 3.0, 0), turn(3.0, 10.0, 1)]);
        assert_eq!(segs[0].speaker, Some(SpeakerId(1)));
    }

    #[test]
    fn assign_speakers_leaves_segments_with_no_overlap_alone() {
        let mut segs = vec![seg(20.0, 25.0)];
        assign_speakers_by_overlap(&mut segs, &[turn(0.0, 5.0, 0)]);
        assert_eq!(segs[0].speaker, None);
        // Empty turns → nothing assigned.
        let mut segs2 = vec![seg(0.0, 5.0)];
        assign_speakers_by_overlap(&mut segs2, &[]);
        assert_eq!(segs2[0].speaker, None);
    }

    #[test]
    fn assign_speakers_breaks_ties_by_smaller_speaker_id() {
        // Segment 0..2; speaker 0 covers 0..1, speaker 1 covers 1..2 — equal 1 s each → 0.
        let mut segs = vec![seg(0.0, 2.0)];
        assign_speakers_by_overlap(&mut segs, &[turn(0.0, 1.0, 0), turn(1.0, 2.0, 1)]);
        assert_eq!(segs[0].speaker, Some(SpeakerId(0)));
        // Order of turns must not matter.
        let mut segs2 = vec![seg(0.0, 2.0)];
        assign_speakers_by_overlap(&mut segs2, &[turn(1.0, 2.0, 1), turn(0.0, 1.0, 0)]);
        assert_eq!(segs2[0].speaker, Some(SpeakerId(0)));
    }

    #[test]
    fn assign_speakers_handles_many_segments() {
        let mut segs = vec![seg(0.0, 4.0), seg(4.0, 8.0), seg(8.0, 12.0)];
        assign_speakers_by_overlap(&mut segs, &[turn(0.0, 5.0, 0), turn(5.0, 12.0, 1)]);
        assert_eq!(segs[0].speaker, Some(SpeakerId(0))); // 0..4 fully in spk0
        assert_eq!(segs[1].speaker, Some(SpeakerId(1))); // 4..8: 1 s spk0 vs 3 s spk1 → spk1
        assert_eq!(segs[2].speaker, Some(SpeakerId(1))); // 8..12 fully in spk1
    }

    #[test]
    fn mock_diarizer_splits_into_equal_turns() {
        let mut d = MockDiarizer::new(3);
        let pcm = vec![0.0f32; 9 * 16_000]; // 9 s → 3 × 3 s
        let turns = d.diarize(&pcm, &DiarizeOptions::default()).unwrap();
        assert_eq!(turns.len(), 3);
        assert_eq!(turns[0].speaker, SpeakerId(0));
        assert_eq!(turns[2].speaker, SpeakerId(2));
        assert!((turns[1].start.as_secs_f32() - 3.0).abs() < 0.01);
        assert!((turns[2].end.as_secs_f32() - 9.0).abs() < 0.01);
        assert!(d
            .diarize(&[], &DiarizeOptions::default())
            .unwrap()
            .is_empty());
    }

    #[test]
    fn diarize_options_default() {
        let o = DiarizeOptions::default();
        assert!(o.num_speakers.is_none());
        assert!((o.threshold - 0.5).abs() < 1e-6);
    }

    #[test]
    fn sherpa_load_reports_model_missing() {
        // `SherpaDiarizer` has no `Debug` — match the error out instead of unwrap_err.
        fn load_err(seg: &Path, emb: &Path) -> DiarizeError {
            match SherpaDiarizer::load(seg, emb, &DiarizeOptions::default()) {
                Ok(_) => panic!("expected load() to fail"),
                Err(e) => e,
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let absent = dir.path().join("nope.onnx");
        let present = dir.path().join("present.onnx");
        std::fs::write(&present, b"x").unwrap();
        assert!(matches!(
            load_err(&absent, &present),
            DiarizeError::ModelMissing(_)
        ));
        assert!(matches!(
            load_err(&present, &absent),
            DiarizeError::ModelMissing(_)
        ));
    }

    #[test]
    fn speaker_turn_round_trips_through_serde() {
        let t = turn(1.5, 4.25, 3);
        assert_eq!(
            serde_json::from_str::<SpeakerTurn>(&serde_json::to_string(&t).unwrap()).unwrap(),
            t
        );
    }

    // Real sherpa-onnx diarization (needs the ONNX models + the ONNX runtime)
    // is an opt-in CI job, not a unit test — verified in ADR-056 spike 0A/0B.
}
