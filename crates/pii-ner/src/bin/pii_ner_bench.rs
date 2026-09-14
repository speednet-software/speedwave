//! Measures load and inference time of the PII detector on the CPU and GPU.

use std::path::PathBuf;
use std::time::Instant;

use speedwave_pii_ner::{load_auto, DetectOptions, DevicePreference, Span, MAX_CONTENT};

const SAMPLES: &[&str] = &[
    "Jan Kowalski, PESEL 44051401359, mieszka przy ul. Długiej 5, 00-001 Warszawa, tel. 601 234 567, jan.kowalski@example.com.",
    "Anna Nowak-Wiśniewska (ur. 1985) pracuje w firmie Speednet w Gdańsku; jej NIP to 583-000-00-00, a konto PL61 1090 1014 0000 0712 1981 2874.",
    "Please ship the parcel to Michael O'Brien, 221B Baker Street, London NW1 6XE, United Kingdom, and call +44 20 7946 0958 on arrival.",
    "fn main() { let user = User { name: \"anna\", email: \"anna@example.org\" }; println!(\"{}\", user.name); }",
    "2026-09-14T10:15:32.412+02:00 [INFO][proxy] request from 10.0.0.12 forwarded to https://api.anthropic.com/v1/messages in 812 ms",
];

struct Args {
    artifact: PathBuf,
    device: DevicePreference,
    iterations: usize,
    batch: usize,
    texts: Vec<String>,
}

fn parse_args() -> Result<Args, String> {
    let mut args = Args {
        artifact: PathBuf::from("desktop/src-tauri/pii-ner"),
        device: DevicePreference::Auto,
        iterations: 20,
        batch: 16,
        texts: Vec::new(),
    };
    let mut iter = std::env::args().skip(1);
    while let Some(flag) = iter.next() {
        let value = iter.next().ok_or_else(|| format!("{flag} needs a value"))?;
        match flag.as_str() {
            "--artifact" => args.artifact = PathBuf::from(value),
            "--device" => {
                args.device = match value.as_str() {
                    "auto" => DevicePreference::Auto,
                    "cpu" => DevicePreference::Cpu,
                    "gpu" => DevicePreference::Gpu,
                    other => return Err(format!("unknown device {other}")),
                }
            }
            "--iterations" => {
                args.iterations = value.parse().map_err(|e| format!("--iterations: {e}"))?
            }
            "--batch" => args.batch = value.parse().map_err(|e| format!("--batch: {e}"))?,
            "--file" => {
                let text = std::fs::read_to_string(&value).map_err(|e| format!("{value}: {e}"))?;
                args.texts.push(text);
            }
            "--text" => args.texts.push(value),
            other => return Err(format!("unknown flag {other}")),
        }
    }
    if args.texts.is_empty() {
        args.texts = SAMPLES.iter().map(|s| s.to_string()).collect();
        let long: String = SAMPLES
            .iter()
            .cycle()
            .take(12)
            .copied()
            .collect::<Vec<_>>()
            .join(" ");
        args.texts.push(long);
    }
    if args.iterations == 0 || args.batch == 0 {
        return Err("--iterations and --batch must be positive".to_string());
    }
    Ok(args)
}

#[expect(clippy::print_stdout, reason = "bench binary's single output sink")]
fn emit(line: &str) {
    println!("{line}");
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let idx = ((sorted.len() - 1) as f64 * p).round() as usize;
    sorted[idx.min(sorted.len() - 1)]
}

fn describe(text: &str, spans: &[Span]) -> String {
    spans
        .iter()
        .map(|s| {
            format!(
                "{}={:?}@{:.2}",
                s.label,
                &text[s.start..s.end],
                s.confidence
            )
        })
        .collect::<Vec<_>>()
        .join(", ")
}

fn run() -> Result<(), String> {
    let args = parse_args()?;
    let opts = DetectOptions {
        batch_windows: std::num::NonZeroUsize::new(args.batch).ok_or("batch must be positive")?,
        ..DetectOptions::default()
    };
    let started = Instant::now();
    let detector = load_auto(&args.artifact, args.device).map_err(|e| e.to_string())?;
    emit(&format!(
        "loaded {} on {:?} in {:.0} ms",
        detector.description(),
        detector.device(),
        started.elapsed().as_secs_f64() * 1000.0
    ));
    let refs: Vec<&str> = args.texts.iter().map(String::as_str).collect();
    let first = Instant::now();
    let spans = detector
        .detect_batch(&refs, &opts)
        .map_err(|e| e.to_string())?;
    emit(&format!(
        "first call (includes shader compilation on GPU): {:.1} ms",
        first.elapsed().as_secs_f64() * 1000.0
    ));
    let mut per_call = Vec::with_capacity(args.iterations);
    for _ in 0..args.iterations {
        let t = Instant::now();
        detector
            .detect_batch(&refs, &opts)
            .map_err(|e| e.to_string())?;
        per_call.push(t.elapsed().as_secs_f64() * 1000.0);
    }
    per_call.sort_by(f64::total_cmp);
    let approx_windows: usize = args
        .texts
        .iter()
        .map(|t| {
            (t.split_whitespace().count() * 2)
                .max(1)
                .div_ceil(MAX_CONTENT)
        })
        .sum();
    let p50 = percentile(&per_call, 0.5);
    emit(&format!(
        "{} texts, about {} windows per call: p50 {:.1} ms, p95 {:.1} ms, {:.1} windows/s",
        args.texts.len(),
        approx_windows,
        p50,
        percentile(&per_call, 0.95),
        approx_windows as f64 / (p50 / 1000.0)
    ));
    for (text, spans) in args.texts.iter().zip(&spans) {
        let preview: String = text.chars().take(60).collect();
        emit(&format!("- {preview:?}: {}", describe(text, spans)));
    }
    Ok(())
}

fn main() {
    if let Err(message) = run() {
        emit(&format!("error: {message}"));
        std::process::exit(1);
    }
}
