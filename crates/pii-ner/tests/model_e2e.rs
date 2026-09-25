//! Compares the burn port against reference outputs of the original tflite model.
//!
//! Fixtures in `tests/fixtures/` are produced by `tools/gen_fixtures.py`; the artifact
//! directory comes from `SPEEDWAVE_PII_NER_ARTIFACT` (see `make test-pii-ner-model`).
//!
//! Three gates per fixture: tokens are identical, classifier output is close (int8 weights
//! and a different kernel order move probabilities by a few hundredths, so spans that sit
//! on a threshold may flip), post-processing of the reference windows is identical, and
//! `detect` equals `predict_windows` followed by `spans_from_windows`.

#![expect(
    clippy::expect_used,
    reason = "fixture and artifact setup; a failure here must abort the test"
)]

use std::path::{Path, PathBuf};

use speedwave_pii_ner::{
    CpuBackend, Detect, DetectOptions, Detector, Device, Label, Span, WindowPrediction,
};

#[derive(serde::Deserialize)]
struct Fixture {
    text: String,
    min_score: f32,
    tokens: Vec<FixtureToken>,
    windows: Vec<FixtureWindow>,
    expected_spans: Vec<FixtureSpan>,
}

#[derive(serde::Deserialize)]
struct FixtureToken {
    id: u32,
    start: usize,
    end: usize,
}

#[derive(serde::Deserialize)]
struct FixtureWindow {
    token_range: [usize; 2],
    real_len: usize,
    argmax: Vec<usize>,
    max_prob: Vec<f32>,
}

impl FixtureWindow {
    fn to_prediction(&self) -> WindowPrediction {
        WindowPrediction {
            token_range: self.token_range[0]..self.token_range[1],
            real_len: self.real_len,
            classes: self.argmax.clone(),
            probs: self.max_prob.clone(),
        }
    }
}

#[derive(serde::Deserialize, Debug, PartialEq)]
struct FixtureSpan {
    start: usize,
    end: usize,
    label: Label,
}

impl From<&Span> for FixtureSpan {
    fn from(span: &Span) -> Self {
        Self {
            start: span.start,
            end: span.end,
            label: span.label,
        }
    }
}

const ARGMAX_AGREEMENT: f64 = 0.98;
const PROB_TOLERANCE: f32 = 0.08;
const CONFIDENCE_EPSILON: f32 = 1e-5;

fn artifact_dir() -> PathBuf {
    let raw = std::env::var("SPEEDWAVE_PII_NER_ARTIFACT")
        .expect("SPEEDWAVE_PII_NER_ARTIFACT must point at the converted artifact directory");
    PathBuf::from(raw)
}

fn fixtures() -> Vec<(PathBuf, Fixture)> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    let mut entries: Vec<PathBuf> = std::fs::read_dir(&dir)
        .expect("tests/fixtures must exist")
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|ext| ext == "json"))
        .collect();
    entries.sort();
    assert!(!entries.is_empty(), "no fixtures in {}", dir.display());
    entries
        .into_iter()
        .map(|path| {
            let text = std::fs::read_to_string(&path).expect("fixture readable");
            let fixture: Fixture = serde_json::from_str(&text).expect("fixture parses");
            (path, fixture)
        })
        .collect()
}

fn assert_tokens_identical(detector: &Detector<CpuBackend>, fixture: &Fixture, name: &str) {
    let tokens = detector.tokenize(&fixture.text).expect("tokenizes");
    let got: Vec<(u32, usize, usize)> = tokens.iter().map(|t| (t.id, t.start, t.end)).collect();
    let want: Vec<(u32, usize, usize)> = fixture
        .tokens
        .iter()
        .map(|t| (t.id, t.start, t.end))
        .collect();
    assert_eq!(got, want, "{name}: token ids or offsets differ");
}

fn assert_windows_close(got: &[WindowPrediction], want: &[FixtureWindow], name: &str) {
    assert_eq!(got.len(), want.len(), "{name}: window count differs");
    for (i, (got, want)) in got.iter().zip(want).enumerate() {
        assert_eq!(
            [got.token_range.start, got.token_range.end],
            want.token_range,
            "{name} window {i}"
        );
        assert_eq!(got.real_len, want.real_len, "{name} window {i}");
        let agree = got
            .classes
            .iter()
            .zip(&want.argmax)
            .filter(|(a, b)| a == b)
            .count();
        let ratio = agree as f64 / want.argmax.len() as f64;
        assert!(
            ratio >= ARGMAX_AGREEMENT,
            "{name} window {i}: argmax agreement {ratio:.3}"
        );
        for (k, ((gc, gp), (wc, wp))) in got
            .classes
            .iter()
            .zip(&got.probs)
            .zip(want.argmax.iter().zip(&want.max_prob))
            .enumerate()
        {
            if gc == wc {
                assert!(
                    (gp - wp).abs() <= PROB_TOLERANCE,
                    "{name} window {i} token {k}: prob {gp} vs {wp}"
                );
            }
        }
    }
}

fn assert_spans_identical(got: &[Span], want: &[Span], name: &str) {
    let got_shape: Vec<FixtureSpan> = got.iter().map(FixtureSpan::from).collect();
    let want_shape: Vec<FixtureSpan> = want.iter().map(FixtureSpan::from).collect();
    assert_eq!(got_shape, want_shape, "{name}: spans differ");
    for (g, w) in got.iter().zip(want) {
        assert!(
            (g.confidence - w.confidence).abs() <= CONFIDENCE_EPSILON,
            "{name}: confidence {} vs {} at {}..{}",
            g.confidence,
            w.confidence,
            g.start,
            g.end
        );
    }
}

#[test]
fn burn_port_matches_reference_tflite_outputs() {
    let detector = Detector::<CpuBackend>::load(&artifact_dir(), Default::default(), Device::Cpu)
        .expect("artifact loads");
    for (path, fixture) in fixtures() {
        let name = path.display().to_string();
        let opts = DetectOptions {
            min_score: fixture.min_score,
            ..DetectOptions::default()
        };

        assert_tokens_identical(&detector, &fixture, &name);

        let windows = detector
            .predict_windows(&fixture.text, &opts)
            .expect("predicts");
        assert_windows_close(&windows, &fixture.windows, &name);

        let reference: Vec<WindowPrediction> = fixture
            .windows
            .iter()
            .map(FixtureWindow::to_prediction)
            .collect();
        let decoded = detector
            .spans_from_windows(&fixture.text, &reference, &opts)
            .expect("decodes the reference windows");
        let decoded_shape: Vec<FixtureSpan> = decoded.iter().map(FixtureSpan::from).collect();
        assert_eq!(
            decoded_shape, fixture.expected_spans,
            "{name}: post-processing of the reference windows differs"
        );

        let detected = detector.detect(&fixture.text, &opts).expect("detects");
        let composed = detector
            .spans_from_windows(&fixture.text, &windows, &opts)
            .expect("decodes own windows");
        assert_spans_identical(&detected, &composed, &name);
    }
}
