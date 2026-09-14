//! Compares the burn port against reference outputs of the original tflite model.
//!
//! Fixtures in `tests/fixtures/` are produced by `tools/gen_fixtures.py`; the artifact
//! directory comes from `SPEEDWAVE_PII_NER_ARTIFACT` (see `make test-pii-ner-model`).

use std::path::{Path, PathBuf};

use speedwave_pii_ner::{CpuBackend, Detect, DetectOptions, Detector, Device, Label};

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

#[derive(serde::Deserialize, Debug, PartialEq)]
struct FixtureSpan {
    start: usize,
    end: usize,
    label: Label,
}

const ARGMAX_AGREEMENT: f64 = 0.98;
const PROB_TOLERANCE: f32 = 0.08;

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

#[test]
fn burn_port_matches_reference_tflite_outputs() {
    let detector = Detector::<CpuBackend>::load(&artifact_dir(), Default::default(), Device::Cpu)
        .expect("artifact loads");
    for (path, fixture) in fixtures() {
        let name = path.display();
        let tokens = detector.tokenize(&fixture.text).expect("tokenizes");
        let got: Vec<(u32, usize, usize)> = tokens.iter().map(|t| (t.id, t.start, t.end)).collect();
        let want: Vec<(u32, usize, usize)> = fixture
            .tokens
            .iter()
            .map(|t| (t.id, t.start, t.end))
            .collect();
        assert_eq!(got, want, "{name}: token ids or offsets differ");

        let opts = DetectOptions {
            min_score: fixture.min_score,
            ..DetectOptions::default()
        };
        let windows = detector
            .predict_windows(&fixture.text, &opts)
            .expect("predicts");
        assert_eq!(
            windows.len(),
            fixture.windows.len(),
            "{name}: window count differs"
        );
        for (i, (got, want)) in windows.iter().zip(&fixture.windows).enumerate() {
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

        let spans = detector.detect(&fixture.text, &opts).expect("detects");
        let got: Vec<FixtureSpan> = spans
            .iter()
            .map(|s| FixtureSpan {
                start: s.start,
                end: s.end,
                label: s.label,
            })
            .collect();
        assert_eq!(got, fixture.expected_spans, "{name}: spans differ");
    }
}
