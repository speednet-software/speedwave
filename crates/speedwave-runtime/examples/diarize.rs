//! Development tool: runs `NemotronDiarizer` on a 16 kHz WAV and prints one line per speaker turn,
//! optionally for a grid of activation thresholds, with a dump of the model's probabilities.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Instant;

use speedwave_runtime::transcription::{
    decode_threads, ActivationThresholds, Diarizer, GpuClass, NemotronDiarizer, SpeakerTurn,
    SAMPLE_RATE_HZ,
};

const USAGE: &str = "usage: diarize -m MODEL [-t THREADS] [--gpu] \
                     [--thresholds START/STOP[,START/STOP...]] [--probs FILE] AUDIO_FILE";

#[derive(Debug, PartialEq)]
struct Args {
    model: PathBuf,
    threads: i32,
    gpu: bool,
    thresholds: Option<Vec<ActivationThresholds>>,
    probs: Option<PathBuf>,
    audio: PathBuf,
}

fn main() -> ExitCode {
    match run(std::env::args().skip(1)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            let _ = writeln!(std::io::stderr(), "error: {e}");
            ExitCode::FAILURE
        }
    }
}

fn run(argv: impl Iterator<Item = String>) -> Result<(), String> {
    let args = parse_args(argv)?;
    let pcm = read_wav(&args.audio)?;
    let class = if args.gpu {
        GpuClass::Discrete
    } else {
        GpuClass::None
    };

    let t_load = Instant::now();
    let mut diarizer = NemotronDiarizer::load_with_threads(&args.model, class, args.threads)
        .map_err(|e| e.to_string())?;
    let t_process = Instant::now();
    let turns = diarizer.diarize(&pcm).map_err(|e| e.to_string())?;
    let t_done = Instant::now();

    writeln!(
        std::io::stderr(),
        "timing: load_ms={:.1} process_ms={:.1} audio_s={:.3}",
        (t_process - t_load).as_secs_f64() * 1000.0,
        (t_done - t_process).as_secs_f64() * 1000.0,
        pcm.len() as f64 / f64::from(SAMPLE_RATE_HZ)
    )
    .map_err(|e| e.to_string())?;
    if let Some(path) = &args.probs {
        let probs = diarizer.probabilities();
        write_probs(path, &probs.values)?;
        writeln!(
            std::io::stderr(),
            "probs: frames={} speakers={} file={}",
            probs
                .values
                .len()
                .checked_div(probs.n_speakers)
                .unwrap_or(0),
            probs.n_speakers,
            path.display()
        )
        .map_err(|e| e.to_string())?;
    }
    let mut out = std::io::stdout().lock();
    match &args.thresholds {
        None => write_turns(&mut out, &turns),
        Some(grid) => {
            for &t in grid {
                writeln!(out, "# thresholds start={} stop={}", t.start, t.stop)
                    .map_err(|e| e.to_string())?;
                let turns = diarizer.turns(t).map_err(|e| e.to_string())?;
                write_turns(&mut out, &turns)?;
            }
            Ok(())
        }
    }
}

fn write_turns(out: &mut impl Write, turns: &[SpeakerTurn]) -> Result<(), String> {
    for turn in turns {
        writeln!(
            out,
            "speaker {}  [{:6.2} -> {:6.2}]",
            turn.speaker,
            turn.start.as_secs_f64(),
            turn.end.as_secs_f64()
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn write_probs(path: &Path, values: &[f32]) -> Result<(), String> {
    let bytes: Vec<u8> = values.iter().flat_map(|v| v.to_le_bytes()).collect();
    std::fs::write(path, bytes).map_err(|e| format!("{}: {e}", path.display()))
}

fn parse_args(mut argv: impl Iterator<Item = String>) -> Result<Args, String> {
    let (mut model, mut audio, mut threads, mut gpu) = (None, None, decode_threads(), false);
    let (mut thresholds, mut probs) = (None, None);
    while let Some(arg) = argv.next() {
        match arg.as_str() {
            "-m" | "--model" => model = Some(PathBuf::from(value_of(&arg, argv.next())?)),
            "-t" | "--threads" => {
                let value = value_of(&arg, argv.next())?;
                threads = value
                    .parse()
                    .map_err(|_| format!("invalid thread count: {value}"))?;
            }
            "--gpu" => gpu = true,
            "--thresholds" => thresholds = Some(parse_grid(&value_of(&arg, argv.next())?)?),
            "--probs" => probs = Some(PathBuf::from(value_of(&arg, argv.next())?)),
            other if !other.starts_with('-') => audio = Some(PathBuf::from(other)),
            other => return Err(format!("unknown argument: {other}\n{USAGE}")),
        }
    }
    Ok(Args {
        model: model.ok_or_else(|| format!("model path is required (-m)\n{USAGE}"))?,
        threads,
        gpu,
        thresholds,
        probs,
        audio: audio.ok_or_else(|| format!("audio file is required\n{USAGE}"))?,
    })
}

fn parse_grid(value: &str) -> Result<Vec<ActivationThresholds>, String> {
    value
        .split(',')
        .map(|pair| {
            let (start, stop) = pair
                .split_once('/')
                .ok_or_else(|| format!("expected START/STOP, got {pair:?}"))?;
            let number = |v: &str| {
                v.trim()
                    .parse::<f32>()
                    .map_err(|_| format!("invalid threshold {v:?} in {pair:?}"))
            };
            ActivationThresholds {
                start: number(start)?,
                stop: number(stop)?,
            }
            .validated()
            .map_err(|e| e.to_string())
        })
        .collect()
}

fn value_of(flag: &str, value: Option<String>) -> Result<String, String> {
    value.ok_or_else(|| format!("{flag} needs a value\n{USAGE}"))
}

fn read_wav(path: &Path) -> Result<Vec<f32>, String> {
    let mut reader =
        hound::WavReader::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let spec = reader.spec();
    if spec.sample_rate != SAMPLE_RATE_HZ {
        return Err(format!(
            "{}: {} Hz, expected {SAMPLE_RATE_HZ} Hz",
            path.display(),
            spec.sample_rate
        ));
    }
    let channels = usize::from(spec.channels.max(1));
    let samples: Vec<f32> = match (spec.sample_format, spec.bits_per_sample) {
        (hound::SampleFormat::Int, 16) => reader
            .samples::<i16>()
            .map(|s| s.map(|v| f32::from(v) / 32768.0))
            .collect::<Result<_, _>>(),
        (hound::SampleFormat::Float, 32) => reader.samples::<f32>().collect::<Result<_, _>>(),
        (format, bits) => {
            return Err(format!(
                "{}: {bits}-bit {format:?} samples, expected 16-bit int or 32-bit float",
                path.display()
            ))
        }
    }
    .map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(samples.into_iter().step_by(channels).collect())
}

#[cfg(test)]
#[expect(clippy::unwrap_used, reason = "test code")]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Result<Args, String> {
        parse_args(list.iter().map(|s| (*s).to_string()))
    }

    fn write_wav(path: &Path, channels: u16, rate: u32, frames: &[[i16; 2]]) {
        let spec = hound::WavSpec {
            channels,
            sample_rate: rate,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut w = hound::WavWriter::create(path, spec).unwrap();
        for frame in frames {
            for &s in &frame[..usize::from(channels)] {
                w.write_sample(s).unwrap();
            }
        }
        w.finalize().unwrap();
    }

    #[test]
    fn parses_the_full_command_line_and_its_defaults() {
        assert_eq!(
            args(&["-m", "m.gguf", "-t", "6", "--gpu", "a.wav"]).unwrap(),
            Args {
                model: "m.gguf".into(),
                threads: 6,
                gpu: true,
                thresholds: None,
                probs: None,
                audio: "a.wav".into()
            }
        );
        let defaults = args(&["--model", "m.gguf", "a.wav"]).unwrap();
        assert_eq!(defaults.threads, decode_threads());
        assert!(!defaults.gpu);
    }

    #[test]
    fn parses_a_threshold_grid_and_a_probability_file() {
        let a = args(&[
            "-m",
            "m.gguf",
            "--thresholds",
            "0.641/0.561, 0.55/0.47",
            "--probs",
            "p.f32",
            "a.wav",
        ])
        .unwrap();
        assert_eq!(
            a.thresholds.unwrap(),
            vec![
                ActivationThresholds {
                    start: 0.641,
                    stop: 0.561
                },
                ActivationThresholds {
                    start: 0.55,
                    stop: 0.47
                },
            ]
        );
        assert_eq!(a.probs.unwrap(), PathBuf::from("p.f32"));
    }

    #[test]
    fn rejects_a_malformed_or_invalid_threshold_grid() {
        for (grid, message) in [
            ("0.6", "expected START/STOP"),
            ("0.6/x", "invalid threshold"),
            ("0.5/0.6", "invalid activation thresholds"),
            ("1.2/0.5", "invalid activation thresholds"),
            ("0.6/0.5,", "expected START/STOP"),
        ] {
            let err = args(&["-m", "m", "--thresholds", grid, "a.wav"]).unwrap_err();
            assert!(err.contains(message), "{grid}: {err}");
        }
        assert!(args(&["-m", "m", "--thresholds"])
            .unwrap_err()
            .contains("needs a value"));
    }

    #[test]
    fn writes_probabilities_as_little_endian_f32() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("p.f32");
        write_probs(&path, &[0.25, -1.0]).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(
            bytes,
            [0.25f32.to_le_bytes(), (-1.0f32).to_le_bytes()].concat()
        );
        write_probs(&path, &[]).unwrap();
        assert!(std::fs::read(&path).unwrap().is_empty());
        assert!(write_probs(&dir.path().join("absent/p.f32"), &[1.0]).is_err());
    }

    #[test]
    fn writes_one_line_per_turn_with_centiseconds() {
        let mut out = Vec::new();
        write_turns(
            &mut out,
            &[SpeakerTurn {
                start: std::time::Duration::from_millis(1500),
                end: std::time::Duration::from_millis(12_340),
                speaker: 2,
            }],
        )
        .unwrap();
        assert_eq!(
            String::from_utf8(out).unwrap(),
            "speaker 2  [  1.50 ->  12.34]\n"
        );
    }

    #[test]
    fn rejects_missing_and_unknown_arguments() {
        assert!(args(&["a.wav"]).unwrap_err().contains("-m"));
        assert!(args(&["-m", "m.gguf"]).unwrap_err().contains("audio file"));
        assert!(args(&["-m"]).unwrap_err().contains("needs a value"));
        assert!(args(&["-m", "m", "-t", "x", "a.wav"])
            .unwrap_err()
            .contains("invalid thread count"));
        assert!(args(&["-m", "m", "--fast", "a.wav"])
            .unwrap_err()
            .contains("unknown argument: --fast"));
    }

    #[test]
    fn reads_channel_zero_of_a_stereo_file_and_a_mono_file_whole() {
        let dir = tempfile::tempdir().unwrap();
        let frames = [[16384, -16384], [-32768, 0]];
        let stereo = dir.path().join("stereo.wav");
        write_wav(&stereo, 2, SAMPLE_RATE_HZ, &frames);
        assert_eq!(read_wav(&stereo).unwrap(), vec![0.5, -1.0]);
        let mono = dir.path().join("mono.wav");
        write_wav(&mono, 1, SAMPLE_RATE_HZ, &frames);
        assert_eq!(read_wav(&mono).unwrap(), vec![0.5, -1.0]);
    }

    #[test]
    fn rejects_a_file_that_is_not_16_khz() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cd.wav");
        write_wav(&path, 1, 44_100, &[[0, 0]]);
        assert!(read_wav(&path).unwrap_err().contains("44100 Hz"));
        assert!(read_wav(&dir.path().join("absent.wav")).is_err());
    }
}
