//! Detection pipeline: tokenize, window, run the classifier, decode BIOES, post-process.

pub(crate) mod bioes;
pub(crate) mod merge;
pub(crate) mod snap;
pub(crate) mod tokenize;
pub(crate) mod windows;

use std::ops::Range;
use std::path::Path;

use burn::tensor::backend::Backend;
use burn::tensor::{Int, Tensor, TensorData};

use crate::artifact::Artifact;
use crate::backend::Device;
use crate::error::{DetectError, LoadError};
use crate::label::{LabelSet, Tag};
use crate::model::{build_model, BertConfig, BertTokenClassifier};
use crate::span::{DetectOptions, Span, SEQ_LEN};
use crate::Detect;
use bioes::{bioes_to_spans, RawSpan};
use merge::{dedupe_best, merge_same_label};
use snap::snap_to_words;
use tokenize::{Token, TokenizerWrapper};
use windows::{encode_window, window_ranges, Window};

/// A ready model on one backend.
pub struct Detector<B: Backend> {
    model: BertTokenClassifier<B>,
    tokenizer: TokenizerWrapper,
    labels: LabelSet,
    config: BertConfig,
    low_score: f32,
    device: B::Device,
    device_kind: Device,
    description: String,
}

/// One token of the input with its UTF-8 byte offsets.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct TokenInfo {
    /// Vocabulary id.
    pub id: u32,
    /// First byte in the input.
    pub start: usize,
    /// One past the last byte in the input.
    pub end: usize,
}

/// Raw classifier output for one window, before BIOES decoding.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct WindowPrediction {
    /// Token indices this window covers.
    pub token_range: Range<usize>,
    /// Positions filled with real tokens, including `<s>` and `</s>`.
    pub real_len: usize,
    /// Best class per real position.
    pub classes: Vec<usize>,
    /// Softmax probability of the best class per real position.
    pub probs: Vec<f32>,
}

struct Job {
    text: usize,
    range: Range<usize>,
    window: Window,
}

impl<B: Backend> Detector<B> {
    /// Loads the artifact directory onto `device`.
    pub fn load(
        artifact_dir: &Path,
        device: B::Device,
        device_kind: Device,
    ) -> Result<Self, LoadError> {
        let artifact = Artifact::open(artifact_dir)?;
        let config = BertConfig::from_manifest(&artifact.manifest.config)?;
        let labels = LabelSet::from_names(&artifact.manifest.labels)?;
        if labels.len() != config.num_labels {
            return Err(LoadError::Labels(format!(
                "{} labels for {} classes",
                labels.len(),
                config.num_labels
            )));
        }
        let weights = artifact.weights()?;
        let model = build_model::<B>(&weights, &config, &device)?;
        let tokenizer = TokenizerWrapper::from_file(&artifact.tokenizer_path)?;
        let info = &artifact.manifest.model;
        let description = format!(
            "{} {} ({}, {} parameters)",
            info.name, info.version, info.revision, info.param_count
        );
        Ok(Self {
            model,
            tokenizer,
            labels,
            config,
            low_score: artifact.manifest.pipeline.low_score,
            device,
            device_kind,
            description,
        })
    }

    /// Model name, version and size, for logs and diagnostics.
    pub fn description(&self) -> &str {
        &self.description
    }

    /// Which device class runs this detector.
    pub fn device_kind(&self) -> Device {
        self.device_kind
    }

    /// Tokens of `text` with byte offsets.
    pub fn tokenize(&self, text: &str) -> Result<Vec<TokenInfo>, DetectError> {
        Ok(self
            .tokenizer
            .encode(text)?
            .into_iter()
            .map(|t| TokenInfo {
                id: t.id,
                start: t.start,
                end: t.end,
            })
            .collect())
    }

    /// Raw per-window classifier output for one text; the diagnostic view behind `detect`.
    pub fn predict_windows(
        &self,
        text: &str,
        opts: &DetectOptions,
    ) -> Result<Vec<WindowPrediction>, DetectError> {
        let tokens = self.tokenizer.encode(text)?;
        let jobs = self.jobs_for(0, &tokens);
        self.predict_jobs(&jobs, opts)
    }

    /// Spans from classifier output for `text`, as produced by `predict_windows`; `detect` is
    /// `predict_windows` followed by this step.
    pub fn spans_from_windows(
        &self,
        text: &str,
        windows: &[WindowPrediction],
        opts: &DetectOptions,
    ) -> Result<Vec<Span>, DetectError> {
        let tokens = self.tokenizer.encode(text)?;
        self.postprocess(text, &tokens, windows, opts)
    }

    fn jobs_for(&self, text: usize, tokens: &[Token]) -> Vec<Job> {
        window_ranges(tokens.len())
            .into_iter()
            .map(|range| Job {
                text,
                window: encode_window(&tokens[range.clone()], &self.config),
                range,
            })
            .collect()
    }

    fn predict_jobs(
        &self,
        jobs: &[Job],
        opts: &DetectOptions,
    ) -> Result<Vec<WindowPrediction>, DetectError> {
        let mut out = Vec::with_capacity(jobs.len());
        for batch in jobs.chunks(opts.batch_windows.get()) {
            let (classes, probs) = self.run_batch(batch)?;
            for (i, job) in batch.iter().enumerate() {
                let base = i * SEQ_LEN;
                out.push(WindowPrediction {
                    token_range: job.range.clone(),
                    real_len: job.window.real_len,
                    classes: classes[base..base + job.window.real_len].to_vec(),
                    probs: probs[base..base + job.window.real_len].to_vec(),
                });
            }
        }
        Ok(out)
    }

    fn run_batch(&self, batch: &[Job]) -> Result<(Vec<usize>, Vec<f32>), DetectError> {
        let n = batch.len();
        let ids: Vec<i32> = batch
            .iter()
            .flat_map(|j| j.window.ids.iter().copied())
            .collect();
        let mask: Vec<i32> = batch
            .iter()
            .flat_map(|j| j.window.mask.iter().copied())
            .collect();
        let ids = Tensor::<B, 2, Int>::from_data(TensorData::new(ids, [n, SEQ_LEN]), &self.device);
        let mask =
            Tensor::<B, 2, Int>::from_data(TensorData::new(mask, [n, SEQ_LEN]), &self.device);
        let (classes, probs) = self.model.predict(ids, mask.equal_elem(0));
        let classes: Vec<usize> = classes
            .into_data()
            .iter::<i64>()
            .map(|c| usize::try_from(c).unwrap_or(0))
            .collect();
        let probs: Vec<f32> = probs.into_data().iter::<f32>().collect();
        if classes.len() != n * SEQ_LEN || probs.len() != n * SEQ_LEN {
            return Err(DetectError::Model(format!(
                "expected {} predictions, got {} classes and {} probabilities",
                n * SEQ_LEN,
                classes.len(),
                probs.len()
            )));
        }
        Ok((classes, probs))
    }

    fn window_offsets(
        tokens: &[Token],
        window: &WindowPrediction,
    ) -> Result<Vec<(usize, usize)>, DetectError> {
        let chunk = tokens.get(window.token_range.clone()).ok_or_else(|| {
            DetectError::Model(format!(
                "window {:?} lies outside the {} tokens of the text",
                window.token_range,
                tokens.len()
            ))
        })?;
        let real_len = chunk.len() + 2;
        if window.real_len != real_len
            || window.classes.len() != real_len
            || window.probs.len() != real_len
        {
            return Err(DetectError::Model(format!(
                "window {:?} carries {} classes and {} probabilities for {} positions",
                window.token_range,
                window.classes.len(),
                window.probs.len(),
                real_len
            )));
        }
        let mut offsets = Vec::with_capacity(real_len);
        offsets.push((0, 0));
        offsets.extend(chunk.iter().map(|t| (t.start, t.end)));
        offsets.push((0, 0));
        Ok(offsets)
    }

    fn decode(
        &self,
        offsets: &[(usize, usize)],
        window: &WindowPrediction,
        low: f32,
    ) -> Vec<(RawSpan, f32)> {
        let tags: Vec<Tag> = window
            .classes
            .iter()
            .zip(&window.probs)
            .map(|(&class, &prob)| {
                if prob >= low {
                    self.labels.tag(class).unwrap_or(Tag::Outside)
                } else {
                    Tag::Outside
                }
            })
            .collect();
        bioes_to_spans(&tags, offsets)
            .into_iter()
            .map(|span| {
                let score = offsets
                    .iter()
                    .zip(&window.probs)
                    .filter(|(&(s, e), _)| e > s && s < span.end && span.start < e)
                    .map(|(_, &p)| p)
                    .fold(0.0_f32, f32::max);
                (span, score)
            })
            .collect()
    }

    fn postprocess(
        &self,
        text: &str,
        tokens: &[Token],
        windows: &[WindowPrediction],
        opts: &DetectOptions,
    ) -> Result<Vec<Span>, DetectError> {
        let min_score = opts.effective_min_score();
        let low = self.low_score.min(min_score);
        let mut scored = Vec::new();
        for window in windows {
            let offsets = Self::window_offsets(tokens, window)?;
            scored.extend(self.decode(&offsets, window, low));
        }
        let kept: Vec<Span> = dedupe_best(scored)
            .into_iter()
            .filter(|(_, score)| *score >= min_score)
            .map(|(raw, score)| Span {
                start: raw.start,
                end: raw.end,
                label: raw.label,
                confidence: score,
            })
            .collect();
        let mut spans = snap_to_words(text, merge_same_label(kept));
        spans.sort_by(|a, b| {
            a.start
                .cmp(&b.start)
                .then(a.end.cmp(&b.end))
                .then_with(|| a.label.as_str().cmp(b.label.as_str()))
        });
        Ok(spans)
    }

    fn detect_all(
        &self,
        texts: &[&str],
        opts: &DetectOptions,
    ) -> Result<Vec<Vec<Span>>, DetectError> {
        let mut tokens = Vec::with_capacity(texts.len());
        let mut jobs = Vec::new();
        for (index, text) in texts.iter().enumerate() {
            let text_tokens = self.tokenizer.encode(text)?;
            jobs.extend(self.jobs_for(index, &text_tokens));
            tokens.push(text_tokens);
        }
        let mut windows: Vec<Vec<WindowPrediction>> = vec![Vec::new(); texts.len()];
        for (job, prediction) in jobs.iter().zip(self.predict_jobs(&jobs, opts)?) {
            windows[job.text].push(prediction);
        }
        texts
            .iter()
            .zip(&tokens)
            .zip(&windows)
            .map(|((text, tokens), windows)| self.postprocess(text, tokens, windows, opts))
            .collect()
    }
}

impl<B: Backend> Detect for Detector<B>
where
    Self: Send + Sync,
{
    fn detect(&self, text: &str, opts: &DetectOptions) -> Result<Vec<Span>, DetectError> {
        Ok(self.detect_all(&[text], opts)?.pop().unwrap_or_default())
    }

    fn detect_batch(
        &self,
        texts: &[&str],
        opts: &DetectOptions,
    ) -> Result<Vec<Vec<Span>>, DetectError> {
        self.detect_all(texts, opts)
    }

    fn device(&self) -> Device {
        self.device_kind
    }

    fn description(&self) -> &str {
        &self.description
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use std::path::Path;

    use crate::artifact::manifest::sample_manifest_json;
    use crate::artifact::sha256_hex;
    use crate::artifact::weights::test_support::serialize;
    use crate::model::build::test_support::{tiny_config, tiny_weights};

    use super::tokenize::test_support::TINY_TOKENIZER_JSON;

    pub(crate) const TINY_LABELS: &[&str] = &[
        "O",
        "B-GIVEN_NAME",
        "I-GIVEN_NAME",
        "E-GIVEN_NAME",
        "S-GIVEN_NAME",
    ];

    /// Writes a complete tiny artifact (manifest, weights, tokenizer) into `dir`.
    #[expect(clippy::unwrap_used, reason = "test code")]
    pub(crate) fn write_tiny_artifact(dir: &Path) {
        let cfg = tiny_config(12, TINY_LABELS.len());
        let stored = tiny_weights(&cfg);
        let refs: Vec<(&str, _)> = stored
            .iter()
            .map(|(k, v)| (k.as_str(), v.clone()))
            .collect();
        let weights = serialize(&refs);
        let tokenizer = TINY_TOKENIZER_JSON.as_bytes();
        let manifest = sample_manifest_json(
            TINY_LABELS,
            cfg.hidden,
            cfg.heads,
            cfg.layers,
            cfg.intermediate,
            cfg.vocab,
        )
        .replace(
            "\"weights_sha256\": \"\"",
            &format!("\"weights_sha256\": \"{}\"", sha256_hex(&weights)),
        )
        .replace(
            "\"tokenizer_sha256\": \"\"",
            &format!("\"tokenizer_sha256\": \"{}\"", sha256_hex(tokenizer)),
        );
        std::fs::write(dir.join("manifest.json"), manifest).unwrap();
        std::fs::write(dir.join("w.safetensors"), weights).unwrap();
        std::fs::write(dir.join("tokenizer.json"), tokenizer).unwrap();
    }
}

#[cfg(test)]
#[expect(clippy::unwrap_used, reason = "test code")]
mod tests {
    use super::test_support::write_tiny_artifact;
    use super::*;
    use crate::backend::CpuBackend;

    fn detector() -> (tempfile::TempDir, Detector<CpuBackend>) {
        let dir = tempfile::tempdir().unwrap();
        write_tiny_artifact(dir.path());
        let detector =
            Detector::<CpuBackend>::load(dir.path(), Default::default(), Device::Cpu).unwrap();
        (dir, detector)
    }

    #[test]
    fn loads_tiny_artifact_and_reports_description() {
        let (_dir, detector) = detector();
        assert!(detector.description().starts_with("test 0"));
        assert_eq!(detector.device_kind(), Device::Cpu);
    }

    #[test]
    fn empty_text_yields_no_windows_and_no_spans() {
        let (_dir, detector) = detector();
        let opts = DetectOptions::default();
        assert!(detector.predict_windows("", &opts).unwrap().is_empty());
        assert!(detector.detect("", &opts).unwrap().is_empty());
    }

    #[test]
    fn predictions_cover_every_real_position() {
        let (_dir, detector) = detector();
        let windows = detector
            .predict_windows("anna kowalski mieszka w łodzi", &DetectOptions::default())
            .unwrap();
        assert_eq!(windows.len(), 1);
        let w = &windows[0];
        assert_eq!(w.token_range, 0..5);
        assert_eq!(w.real_len, 7);
        assert_eq!(w.classes.len(), 7);
        assert!(w.probs.iter().all(|p| (0.0..=1.0).contains(p)));
        assert!(w.classes.iter().all(|&c| c < 5));
    }

    #[test]
    fn batch_preserves_order_and_spans_stay_inside_their_text() {
        let (_dir, detector) = detector();
        let texts = ["anna kowalski", "", "w łodzi a b c"];
        let opts = DetectOptions {
            min_score: 0.0,
            ..Default::default()
        };
        let batches = detector.detect_batch(&texts, &opts).unwrap();
        assert_eq!(batches.len(), 3);
        assert!(batches[1].is_empty());
        for (spans, text) in batches.iter().zip(texts) {
            for span in spans {
                assert!(span.end <= text.len() && span.start < span.end, "{span:?}");
                assert!(text.is_char_boundary(span.start) && text.is_char_boundary(span.end));
            }
            for pair in spans.windows(2) {
                assert!(pair[0].start <= pair[1].start);
            }
        }
        let single = detector.detect(texts[2], &opts).unwrap();
        assert_eq!(single, batches[2]);
    }

    #[test]
    fn detect_is_predict_windows_followed_by_spans_from_windows() {
        let (_dir, detector) = detector();
        let text = "anna kowalski mieszka w łodzi";
        let opts = DetectOptions {
            min_score: 0.0,
            ..Default::default()
        };
        let windows = detector.predict_windows(text, &opts).unwrap();
        let composed = detector.spans_from_windows(text, &windows, &opts).unwrap();
        assert_eq!(composed, detector.detect(text, &opts).unwrap());
    }

    #[test]
    fn spans_from_windows_rejects_windows_that_do_not_fit_the_text() {
        let (_dir, detector) = detector();
        let text = "anna kowalski";
        let opts = DetectOptions::default();
        let mut windows = detector.predict_windows(text, &opts).unwrap();
        windows[0].probs.pop();
        let err = detector
            .spans_from_windows(text, &windows, &opts)
            .unwrap_err();
        assert!(matches!(err, DetectError::Model(_)), "{err}");
        let err = detector
            .spans_from_windows(
                "anna",
                &detector.predict_windows(text, &opts).unwrap(),
                &opts,
            )
            .unwrap_err();
        assert!(matches!(err, DetectError::Model(_)), "{err}");
    }

    #[test]
    fn min_score_one_filters_everything() {
        let (_dir, detector) = detector();
        let opts = DetectOptions {
            min_score: 1.0,
            ..Default::default()
        };
        assert!(detector
            .detect("anna kowalski mieszka", &opts)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn corrupt_weights_are_rejected_at_load() {
        let dir = tempfile::tempdir().unwrap();
        write_tiny_artifact(dir.path());
        std::fs::write(dir.path().join("w.safetensors"), b"garbage").unwrap();
        let err = Detector::<CpuBackend>::load(dir.path(), Default::default(), Device::Cpu)
            .map(|_| ())
            .unwrap_err();
        assert!(matches!(err, LoadError::Checksum { .. }), "{err}");
    }
}
