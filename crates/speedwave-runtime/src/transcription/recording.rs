//! Playback spans of a recording.

use std::io::{BufReader, Cursor};
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::audio::SAMPLE_RATE_HZ;
use super::transcriber::TranscriptSource;

/// Message for a missing recording.
pub const RECORDING_UNAVAILABLE: &str =
    "Recording file not found. It was moved or deleted, so lines can't be played.";

const CLIP_PADDING: Duration = Duration::from_millis(250);

const MAX_CLIP: Duration = Duration::from_secs(60);

struct ReadablePart<'a> {
    path: &'a Path,
    start: Duration,
    end: Duration,
}

/// Clip error.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ClipError {
    /// The audio is missing.
    #[error("{RECORDING_UNAVAILABLE}")]
    Unavailable,
    /// The span is invalid.
    #[error("invalid span: {0}")]
    InvalidSpan(String),
    /// Reading failed.
    #[error("could not read the recording: {0}")]
    Read(String),
}

/// Playable length of the recording.
pub fn playable_until(parts: &[PathBuf]) -> Duration {
    readable_parts(parts)
        .last()
        .map_or(Duration::ZERO, |p| p.end)
}

/// WAV of a span of the recording.
pub fn clip(
    parts: &[PathBuf],
    start: Duration,
    end: Duration,
    source: Option<TranscriptSource>,
) -> Result<Vec<u8>, ClipError> {
    if end <= start {
        return Err(ClipError::InvalidSpan(format!(
            "end {end:?} is not after start {start:?}"
        )));
    }
    let readable = readable_parts(parts);
    let known_end = readable.last().map_or(Duration::ZERO, |p| p.end);
    if start >= known_end {
        return Err(ClipError::Unavailable);
    }
    let from = start.saturating_sub(CLIP_PADDING);
    let to = end
        .saturating_add(CLIP_PADDING)
        .min(from + MAX_CLIP)
        .min(known_end);
    let mut samples: Vec<i16> = Vec::new();
    for part in readable.iter().filter(|p| p.start < to && p.end > from) {
        read_span(part, from, to, source, &mut samples)?;
    }
    encode_wav(&samples)
}

fn readable_parts(parts: &[PathBuf]) -> Vec<ReadablePart<'_>> {
    let mut out = Vec::new();
    let mut base = Duration::ZERO;
    for path in parts {
        let Ok(reader) = hound::WavReader::open(path) else {
            break;
        };
        let spec = reader.spec();
        let frames = u64::from(reader.duration());
        if spec.sample_rate == 0 || frames == 0 {
            continue;
        }
        let len = Duration::from_secs_f64(frames as f64 / f64::from(spec.sample_rate));
        out.push(ReadablePart {
            path,
            start: base,
            end: base + len,
        });
        base += len;
    }
    out
}

fn read_span(
    part: &ReadablePart<'_>,
    from: Duration,
    to: Duration,
    source: Option<TranscriptSource>,
    out: &mut Vec<i16>,
) -> Result<(), ClipError> {
    let read_err =
        |e: &dyn std::fmt::Display| ClipError::Read(format!("{}: {e}", part.path.display()));
    let mut reader = hound::WavReader::open(part.path).map_err(|e| read_err(&e))?;
    let spec = reader.spec();
    if spec.sample_rate != SAMPLE_RATE_HZ {
        return Err(ClipError::Read(format!(
            "{}: sample rate {} Hz, expected {SAMPLE_RATE_HZ} Hz",
            part.path.display(),
            spec.sample_rate
        )));
    }
    let frames = reader.duration();
    let first = frame_at(from.saturating_sub(part.start)).min(frames);
    let last = frame_at(to.saturating_sub(part.start)).min(frames);
    if last <= first {
        return Ok(());
    }
    reader.seek(first).map_err(|e| read_err(&e))?;
    let channels = usize::from(spec.channels.max(1));
    let count = (last - first) as usize * channels;
    let interleaved = read_samples(&mut reader, spec, count).map_err(|e| read_err(&e))?;
    out.extend(
        interleaved
            .chunks_exact(channels)
            .map(|frame| pick_channel(frame, source)),
    );
    Ok(())
}

fn frame_at(offset: Duration) -> u32 {
    let frames = (offset.as_secs_f64() * f64::from(SAMPLE_RATE_HZ)).round();
    if frames >= f64::from(u32::MAX) {
        u32::MAX
    } else {
        frames as u32
    }
}

fn read_samples(
    reader: &mut hound::WavReader<BufReader<std::fs::File>>,
    spec: hound::WavSpec,
    count: usize,
) -> Result<Vec<i16>, hound::Error> {
    match (spec.bits_per_sample, spec.sample_format) {
        (16, hound::SampleFormat::Int) => reader.samples::<i16>().take(count).collect(),
        (32, hound::SampleFormat::Float) => reader
            .samples::<f32>()
            .take(count)
            .map(|s| s.map(f32_to_i16))
            .collect(),
        _ => Err(hound::Error::Unsupported),
    }
}

fn f32_to_i16(s: f32) -> i16 {
    (s.clamp(-1.0, 1.0) * f32::from(i16::MAX)).round() as i16
}

fn pick_channel(frame: &[i16], source: Option<TranscriptSource>) -> i16 {
    match (frame, source) {
        ([only], _) => *only,
        ([system, _], Some(TranscriptSource::System)) => *system,
        ([_, mic], Some(TranscriptSource::Mic)) => *mic,
        _ => {
            let sum: i32 = frame.iter().map(|&s| i32::from(s)).sum();
            (sum / frame.len().max(1) as i32) as i16
        }
    }
}

fn encode_wav(samples: &[i16]) -> Result<Vec<u8>, ClipError> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: SAMPLE_RATE_HZ,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let encode_err = |e: hound::Error| ClipError::Read(format!("could not encode the clip: {e}"));
    let mut cursor = Cursor::new(Vec::new());
    let mut writer = hound::WavWriter::new(&mut cursor, spec).map_err(encode_err)?;
    for &s in samples {
        writer.write_sample(s).map_err(encode_err)?;
    }
    writer.finalize().map_err(encode_err)?;
    Ok(cursor.into_inner())
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code: unwrap on fixtures is the sanctioned boundary"
)]
mod tests {
    use super::*;

    const RATE: usize = SAMPLE_RATE_HZ as usize;

    fn write_stereo(path: &Path, frames: &[(i16, i16)]) {
        let spec = hound::WavSpec {
            channels: 2,
            sample_rate: SAMPLE_RATE_HZ,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut w = hound::WavWriter::create(path, spec).unwrap();
        for &(system, mic) in frames {
            w.write_sample(system).unwrap();
            w.write_sample(mic).unwrap();
        }
        w.finalize().unwrap();
    }

    fn write_mono(path: &Path, samples: &[i16]) {
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: SAMPLE_RATE_HZ,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut w = hound::WavWriter::create(path, spec).unwrap();
        for &s in samples {
            w.write_sample(s).unwrap();
        }
        w.finalize().unwrap();
    }

    fn ramp(secs: usize, offset: i16) -> Vec<i16> {
        (0..secs * RATE)
            .map(|i| offset.wrapping_add((i / RATE) as i16))
            .collect()
    }

    fn decode(bytes: &[u8]) -> (hound::WavSpec, Vec<i16>) {
        let mut reader = hound::WavReader::new(Cursor::new(bytes)).unwrap();
        let spec = reader.spec();
        let samples = reader.samples::<i16>().map(Result::unwrap).collect();
        (spec, samples)
    }

    fn secs(s: f64) -> Duration {
        Duration::from_secs_f64(s)
    }

    #[test]
    fn a_span_in_one_part_is_padded_on_both_sides_and_comes_back_as_16_khz_mono() {
        let dir = tempfile::tempdir().unwrap();
        let wav = dir.path().join("audio.wav");
        write_mono(&wav, &ramp(10, 0));

        let (spec, samples) = decode(&clip(&[wav], secs(3.0), secs(5.0), None).unwrap());

        assert_eq!(spec.channels, 1);
        assert_eq!(spec.sample_rate, SAMPLE_RATE_HZ);
        assert_eq!(spec.bits_per_sample, 16);
        assert_eq!(samples.len(), RATE * 25 / 10);
        assert_eq!(samples.first(), Some(&2));
        assert_eq!(samples.last(), Some(&5));
    }

    #[test]
    fn the_padding_stops_at_the_start_and_the_end_of_the_recording() {
        let dir = tempfile::tempdir().unwrap();
        let wav = dir.path().join("audio.wav");
        write_mono(&wav, &ramp(4, 0));

        let (_, head) =
            decode(&clip(std::slice::from_ref(&wav), secs(0.1), secs(1.0), None).unwrap());
        assert_eq!(head.len(), RATE * 125 / 100);
        assert_eq!(head.first(), Some(&0));

        let (_, tail) = decode(&clip(&[wav], secs(3.0), secs(4.0), None).unwrap());
        assert_eq!(tail.len(), RATE * 125 / 100);
        assert_eq!(tail.last(), Some(&3));
    }

    #[test]
    fn a_span_across_two_parts_joins_the_end_of_one_with_the_start_of_the_next() {
        let dir = tempfile::tempdir().unwrap();
        let first = dir.path().join("audio.wav");
        let second = dir.path().join("audio-2.wav");
        write_mono(&first, &ramp(3, 0));
        write_mono(&second, &ramp(3, 100));

        let (_, samples) = decode(&clip(&[first, second], secs(2.5), secs(3.5), None).unwrap());

        assert_eq!(samples.len(), RATE * 15 / 10);
        assert_eq!(samples.first(), Some(&2));
        assert_eq!(samples.last(), Some(&100));
        assert!(samples.contains(&2) && samples.contains(&100));
    }

    #[test]
    fn a_span_in_a_later_part_is_placed_after_every_earlier_part() {
        let dir = tempfile::tempdir().unwrap();
        let first = dir.path().join("audio.wav");
        let second = dir.path().join("audio-2.wav");
        write_mono(&first, &ramp(2, 0));
        write_mono(&second, &ramp(3, 100));

        let (_, samples) = decode(&clip(&[first, second], secs(3.5), secs(4.0), None).unwrap());

        assert!(samples.iter().all(|&s| s == 101 || s == 102));
    }

    #[test]
    fn a_meeting_span_plays_the_system_channel_and_a_you_span_the_microphone() {
        let dir = tempfile::tempdir().unwrap();
        let wav = dir.path().join("audio.wav");
        write_stereo(&wav, &vec![(1000, -1000); 3 * RATE]);
        let parts = [wav];

        let (_, system) =
            decode(&clip(&parts, secs(1.0), secs(2.0), Some(TranscriptSource::System)).unwrap());
        let (_, mic) =
            decode(&clip(&parts, secs(1.0), secs(2.0), Some(TranscriptSource::Mic)).unwrap());
        let (_, untagged) = decode(&clip(&parts, secs(1.0), secs(2.0), None).unwrap());

        assert!(system.iter().all(|&s| s == 1000));
        assert!(mic.iter().all(|&s| s == -1000));
        assert!(untagged.iter().all(|&s| s == 0));
    }

    #[test]
    fn a_mono_part_plays_its_one_channel_whatever_the_source() {
        let dir = tempfile::tempdir().unwrap();
        let wav = dir.path().join("audio.wav");
        write_mono(&wav, &vec![42; 2 * RATE]);

        let (_, samples) =
            decode(&clip(&[wav], secs(0.5), secs(1.0), Some(TranscriptSource::Mic)).unwrap());

        assert!(samples.iter().all(|&s| s == 42));
    }

    #[test]
    fn a_float_part_is_read_as_16_bit() {
        let dir = tempfile::tempdir().unwrap();
        let wav = dir.path().join("audio.wav");
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: SAMPLE_RATE_HZ,
            bits_per_sample: 32,
            sample_format: hound::SampleFormat::Float,
        };
        let mut w = hound::WavWriter::create(&wav, spec).unwrap();
        for _ in 0..RATE {
            w.write_sample(0.5f32).unwrap();
        }
        w.finalize().unwrap();

        let (_, samples) = decode(&clip(&[wav], secs(0.3), secs(0.6), None).unwrap());

        assert!(samples.iter().all(|&s| s == 16384));
    }

    #[test]
    fn a_clip_is_capped_at_the_longest_span() {
        let dir = tempfile::tempdir().unwrap();
        let wav = dir.path().join("audio.wav");
        write_mono(&wav, &vec![1; 70 * RATE]);

        let (_, samples) = decode(&clip(&[wav], secs(1.0), secs(69.0), None).unwrap());

        assert_eq!(samples.len(), MAX_CLIP.as_secs() as usize * RATE);
    }

    #[test]
    fn a_missing_recording_is_unavailable_with_the_message_the_user_reads() {
        let dir = tempfile::tempdir().unwrap();
        let gone = dir.path().join("audio.wav");

        let err = clip(std::slice::from_ref(&gone), secs(1.0), secs(2.0), None).unwrap_err();

        assert_eq!(err, ClipError::Unavailable);
        assert_eq!(err.to_string(), RECORDING_UNAVAILABLE);
        assert_eq!(playable_until(&[gone]), Duration::ZERO);
        assert_eq!(playable_until(&[]), Duration::ZERO);
    }

    #[test]
    fn a_missing_part_makes_it_and_every_later_part_unavailable() {
        let dir = tempfile::tempdir().unwrap();
        let first = dir.path().join("audio.wav");
        let gone = dir.path().join("audio-2.wav");
        let third = dir.path().join("audio-3.wav");
        write_mono(&first, &ramp(2, 0));
        write_mono(&third, &ramp(2, 100));
        let parts = [first, gone, third];

        assert_eq!(playable_until(&parts), secs(2.0));
        assert!(clip(&parts, secs(0.5), secs(1.5), None).is_ok());
        assert_eq!(
            clip(&parts, secs(2.5), secs(3.0), None).unwrap_err(),
            ClipError::Unavailable
        );
        let (_, cut) = decode(&clip(&parts, secs(1.5), secs(2.5), None).unwrap());
        assert_eq!(cut.len(), RATE * 75 / 100);
    }

    #[test]
    fn an_empty_part_takes_no_time_on_the_timeline() {
        let dir = tempfile::tempdir().unwrap();
        let empty = dir.path().join("audio.wav");
        let second = dir.path().join("audio-2.wav");
        write_mono(&empty, &[]);
        write_mono(&second, &ramp(2, 100));
        let parts = [empty, second];

        assert_eq!(playable_until(&parts), secs(2.0));
        let (_, samples) = decode(&clip(&parts, secs(0.5), secs(0.6), None).unwrap());
        assert!(samples.iter().all(|&s| s == 100));
    }

    #[test]
    fn a_damaged_file_is_unavailable() {
        let dir = tempfile::tempdir().unwrap();
        let wav = dir.path().join("audio.wav");
        std::fs::write(&wav, vec![0xAAu8; 200]).unwrap();

        assert_eq!(
            clip(&[wav], secs(0.0), secs(1.0), None).unwrap_err(),
            ClipError::Unavailable
        );
    }

    #[test]
    fn a_span_that_does_not_move_forward_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let wav = dir.path().join("audio.wav");
        write_mono(&wav, &ramp(2, 0));

        assert!(matches!(
            clip(std::slice::from_ref(&wav), secs(1.0), secs(1.0), None),
            Err(ClipError::InvalidSpan(_))
        ));
        assert!(matches!(
            clip(&[wav], secs(1.5), secs(1.0), None),
            Err(ClipError::InvalidSpan(_))
        ));
    }

    #[test]
    fn a_span_ending_at_the_largest_time_is_cut_at_the_end_of_the_recording() {
        let dir = tempfile::tempdir().unwrap();
        let wav = dir.path().join("audio.wav");
        write_mono(&wav, &ramp(2, 0));

        let (_, samples) = decode(&clip(&[wav], secs(1.0), Duration::MAX, None).unwrap());

        assert_eq!(samples.len(), RATE * 125 / 100);
    }

    #[test]
    fn a_span_past_the_end_of_the_recording_is_unavailable() {
        let dir = tempfile::tempdir().unwrap();
        let wav = dir.path().join("audio.wav");
        write_mono(&wav, &ramp(2, 0));

        assert_eq!(
            clip(&[wav], secs(2.0), secs(3.0), None).unwrap_err(),
            ClipError::Unavailable
        );
    }

    #[test]
    fn a_part_at_another_sample_rate_is_a_read_error() {
        let dir = tempfile::tempdir().unwrap();
        let wav = dir.path().join("audio.wav");
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 44_100,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut w = hound::WavWriter::create(&wav, spec).unwrap();
        for _ in 0..44_100 {
            w.write_sample(0i16).unwrap();
        }
        w.finalize().unwrap();

        assert!(matches!(
            clip(&[wav], secs(0.1), secs(0.2), None),
            Err(ClipError::Read(_))
        ));
    }

    #[test]
    fn recording_unavailable_matches_ts_mirror() {
        let src = include_str!("../../../../desktop/src/src/app/models/transcript.ts");
        assert!(
            src.contains(&format!("'{RECORDING_UNAVAILABLE}'"))
                || src.contains(&format!("\"{RECORDING_UNAVAILABLE}\"")),
            "models/transcript.ts must carry RECORDING_UNAVAILABLE verbatim"
        );
    }
}
