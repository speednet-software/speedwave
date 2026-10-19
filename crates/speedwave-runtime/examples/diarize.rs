//! Development tool for the SPEED-727 round 3 comparison: runs `NemotronDiarizer` on a 16 kHz
//! WAV with the command line and output of the `diarize` example from whisper.cpp PR #4095.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Instant;

use speedwave_runtime::transcription::{
    decode_threads, Diarizer, GpuClass, NemotronDiarizer, SAMPLE_RATE_HZ,
};

const USAGE: &str = "usage: diarize -m MODEL [-t THREADS] [--gpu] AUDIO_FILE";

#[derive(Debug, PartialEq)]
struct Args {
    model: PathBuf,
    threads: i32,
    gpu: bool,
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
    let mut out = std::io::stdout().lock();
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

fn parse_args(mut argv: impl Iterator<Item = String>) -> Result<Args, String> {
    let (mut model, mut audio, mut threads, mut gpu) = (None, None, decode_threads(), false);
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
            other if !other.starts_with('-') => audio = Some(PathBuf::from(other)),
            other => return Err(format!("unknown argument: {other}\n{USAGE}")),
        }
    }
    Ok(Args {
        model: model.ok_or_else(|| format!("model path is required (-m)\n{USAGE}"))?,
        threads,
        gpu,
        audio: audio.ok_or_else(|| format!("audio file is required\n{USAGE}"))?,
    })
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
    fn parses_the_round_3_command_line() {
        assert_eq!(
            args(&["-m", "m.gguf", "-t", "6", "--gpu", "a.wav"]).unwrap(),
            Args {
                model: "m.gguf".into(),
                threads: 6,
                gpu: true,
                audio: "a.wav".into()
            }
        );
        let defaults = args(&["--model", "m.gguf", "a.wav"]).unwrap();
        assert_eq!(defaults.threads, decode_threads());
        assert!(!defaults.gpu);
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
