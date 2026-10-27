//! Audio-file import (SPEED-462): decodes a recording made outside Speedwave into the 16 kHz
//! mono WAV the offline pass reads, streaming, so memory does not grow with the file's length.

use std::path::Path;

use symphonia::core::codecs::audio::AudioDecoderOptions;
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, TrackType};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;

use super::audio::SAMPLE_RATE_HZ;

/// File extensions an import accepts, lower case, in the order the UI lists them.
pub const IMPORT_EXTENSIONS: &[&str] = &["wav", "mp3", "m4a", "mp4", "flac", "ogg"];

const SUPPORTED_CODECS: &str = "PCM, MP3, AAC-LC, FLAC and Vorbis";

/// Why a file could not be imported; the text is shown to the user after the file name.
#[derive(Debug, thiserror::Error)]
pub enum ImportError {
    /// The extension is not in [`IMPORT_EXTENSIONS`].
    #[error("this file type is not supported; use {}", supported_formats())]
    UnsupportedFormat,
    /// No reader takes the content as the format its extension names: damaged, or renamed.
    #[error(
        "it is not a readable {0} file; it may be damaged, or be another format under that \
         name; use {fmts}",
        fmts = supported_formats()
    )]
    NotReadable(String),
    /// The container holds no audio track, or one in a codec the decoder lacks (Opus, HE-AAC).
    #[error("its audio is in a codec this app cannot decode; supported are {SUPPORTED_CODECS}")]
    UnsupportedAudio,
    /// The file is damaged: its container or its audio stopped decoding.
    #[error("the file is damaged and could not be decoded ({0})")]
    Damaged(String),
    /// The file decoded to no samples at all.
    #[error("the file holds no audio")]
    Empty,
    /// The file could not be opened or read.
    #[error("the file could not be read ({0})")]
    Read(std::io::Error),
    /// The decoded audio could not be written to the recording.
    #[error("the imported audio could not be saved ({0})")]
    Write(String),
}

/// The supported formats as the UI names them: "WAV, MP3, M4A, MP4, FLAC or OGG".
pub fn supported_formats() -> String {
    let upper: Vec<String> = IMPORT_EXTENSIONS
        .iter()
        .map(|ext| ext.to_ascii_uppercase())
        .collect();
    match upper.split_last() {
        Some((last, rest)) if !rest.is_empty() => format!("{} or {last}", rest.join(", ")),
        Some((last, _)) => last.clone(),
        None => String::new(),
    }
}

pub(crate) fn decode_to_wav(src: &Path, dst: &Path) -> Result<(), ImportError> {
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .filter(|e| IMPORT_EXTENSIONS.contains(&e.as_str()))
        .ok_or(ImportError::UnsupportedFormat)?;
    let file = std::fs::File::open(src).map_err(ImportError::Read)?;
    let stream = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    hint.with_extension(&ext);
    let mut format = symphonia::default::get_probe()
        .probe(
            &hint,
            stream,
            FormatOptions::default(),
            MetadataOptions::default(),
        )
        .map_err(|e| match e {
            SymphoniaError::IoError(io) if io.kind() != std::io::ErrorKind::UnexpectedEof => {
                ImportError::Read(io)
            }
            _ => ImportError::NotReadable(ext.to_ascii_uppercase()),
        })?;
    let track = format
        .default_track(TrackType::Audio)
        .ok_or(ImportError::UnsupportedAudio)?;
    let track_id = track.id;
    let params = track
        .codec_params
        .as_ref()
        .and_then(|p| p.audio())
        .ok_or(ImportError::UnsupportedAudio)?;
    let mut decoder = symphonia::default::get_codecs()
        .make_audio_decoder(params, &AudioDecoderOptions::default())
        .map_err(|_| ImportError::UnsupportedAudio)?;

    let mut writer = MonoWavWriter::create(dst)?;
    let mut resampler: Option<AreaResampler> = None;
    let mut interleaved: Vec<f32> = Vec::new();
    let mut mono: Vec<f32> = Vec::new();
    let mut resampled: Vec<f32> = Vec::new();
    let mut decoded_any = false;
    let mut skipped_packets = 0usize;
    let mut first_skip: Option<&'static str> = None;
    loop {
        let packet = match format.next_packet() {
            Ok(Some(packet)) => packet,
            Ok(None) => break,
            Err(SymphoniaError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                if decoded_any {
                    log::warn!("the imported file ends early; keeping the audio decoded so far");
                }
                break;
            }
            Err(SymphoniaError::IoError(e)) => return Err(ImportError::Read(e)),
            Err(SymphoniaError::ResetRequired) => {
                return Err(ImportError::Damaged(
                    "its audio changes format part way through".to_string(),
                ))
            }
            Err(e) => return Err(ImportError::Damaged(e.to_string())),
        };
        if packet.track_id != track_id {
            continue;
        }
        let buffer = match decoder.decode(&packet) {
            Ok(buffer) => buffer,
            Err(SymphoniaError::DecodeError(e)) => {
                skipped_packets += 1;
                first_skip.get_or_insert(e);
                continue;
            }
            Err(e) => return Err(ImportError::Damaged(e.to_string())),
        };
        let channels = buffer.num_planes().max(1);
        let rate = buffer.spec().rate();
        if rate == 0 || buffer.frames() == 0 {
            continue;
        }
        decoded_any = true;
        buffer.copy_to_vec_interleaved(&mut interleaved);
        mono.clear();
        mono.extend(
            interleaved
                .chunks_exact(channels)
                .map(|frame| frame.iter().sum::<f32>() / channels as f32),
        );
        if resampler.as_ref().map(|rs| rs.from) != Some(u64::from(rate)) {
            if let Some(old) = resampler.take() {
                resampled.clear();
                old.finish(&mut resampled);
                writer.write(&resampled)?;
            }
            resampler = Some(AreaResampler::new(rate, SAMPLE_RATE_HZ));
        }
        if let Some(rs) = resampler.as_mut() {
            resampled.clear();
            rs.push(&mono, &mut resampled);
            writer.write(&resampled)?;
        }
    }
    if let Some(rs) = resampler.take() {
        resampled.clear();
        rs.finish(&mut resampled);
        writer.write(&resampled)?;
    }
    if !decoded_any {
        return Err(match first_skip {
            Some(e) => ImportError::Damaged(e.to_string()),
            None => ImportError::Empty,
        });
    }
    if let Some(e) = first_skip {
        log::warn!(
            "skipped {skipped_packets} damaged packets of the imported file, the first: {e}"
        );
    }
    if writer.finalize()? == 0 {
        return Err(ImportError::Empty);
    }
    Ok(())
}

struct MonoWavWriter {
    inner: hound::WavWriter<std::io::BufWriter<std::fs::File>>,
    file: std::fs::File,
}

impl MonoWavWriter {
    fn create(path: &Path) -> Result<Self, ImportError> {
        let write_error = |e: &dyn std::fmt::Display| ImportError::Write(e.to_string());
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: SAMPLE_RATE_HZ,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let file = std::fs::File::create(path).map_err(|e| write_error(&e))?;
        let sync = file.try_clone().map_err(|e| write_error(&e))?;
        let inner = hound::WavWriter::new(std::io::BufWriter::new(file), spec)
            .map_err(|e| write_error(&e))?;
        Ok(Self { inner, file: sync })
    }

    fn write(&mut self, samples: &[f32]) -> Result<(), ImportError> {
        for s in samples {
            let v = (s.clamp(-1.0, 1.0) * 32_767.0) as i16;
            self.inner
                .write_sample(v)
                .map_err(|e| ImportError::Write(e.to_string()))?;
        }
        Ok(())
    }

    fn finalize(self) -> Result<u32, ImportError> {
        let frames = self.inner.len();
        self.inner
            .finalize()
            .map_err(|e| ImportError::Write(e.to_string()))?;
        crate::fs_perms::fsync_file_durable(&self.file)
            .map_err(|e| ImportError::Write(e.to_string()))?;
        Ok(frames)
    }
}

struct AreaResampler {
    from: u64,
    to: u64,
    acc: f64,
    filled: u64,
}

impl AreaResampler {
    fn new(from: u32, to: u32) -> Self {
        Self {
            from: u64::from(from),
            to: u64::from(to),
            acc: 0.0,
            filled: 0,
        }
    }

    fn push(&mut self, input: &[f32], out: &mut Vec<f32>) {
        for &x in input {
            let mut left = self.to;
            while left > 0 {
                let take = (self.from - self.filled).min(left);
                self.acc += f64::from(x) * take as f64;
                self.filled += take;
                left -= take;
                if self.filled == self.from {
                    out.push((self.acc / self.from as f64) as f32);
                    self.acc = 0.0;
                    self.filled = 0;
                }
            }
        }
    }

    fn finish(self, out: &mut Vec<f32>) {
        if self.filled > 0 {
            out.push((self.acc / self.filled as f64) as f32);
        }
    }
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code: unwrap on fixtures is the sanctioned boundary"
)]
mod tests {
    use super::*;

    fn write_wav(path: &Path, rate: u32, channels: u16, frames: &[Vec<f32>]) {
        let spec = hound::WavSpec {
            channels,
            sample_rate: rate,
            bits_per_sample: 32,
            sample_format: hound::SampleFormat::Float,
        };
        let mut w = hound::WavWriter::create(path, spec).unwrap();
        for frame in frames {
            for &s in frame {
                w.write_sample(s).unwrap();
            }
        }
        w.finalize().unwrap();
    }

    fn read_mono(path: &Path) -> (hound::WavSpec, Vec<i16>) {
        let mut r = hound::WavReader::open(path).unwrap();
        let spec = r.spec();
        let samples = r.samples::<i16>().map(Result::unwrap).collect();
        (spec, samples)
    }

    fn tone(rate: u32, secs: f32) -> Vec<f32> {
        let n = (rate as f32 * secs) as usize;
        (0..n)
            .map(|i| (i as f32 * 440.0 * std::f32::consts::TAU / rate as f32).sin() * 0.5)
            .collect()
    }

    #[test]
    fn a_48k_stereo_wav_becomes_16k_mono_of_the_same_length() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("meeting.wav");
        let left = tone(48_000, 1.5);
        let frames: Vec<Vec<f32>> = left.iter().map(|&s| vec![s, s]).collect();
        write_wav(&src, 48_000, 2, &frames);
        let dst = dir.path().join("audio.wav");

        decode_to_wav(&src, &dst).unwrap();

        let (spec, samples) = read_mono(&dst);
        assert_eq!(spec.channels, 1);
        assert_eq!(spec.sample_rate, SAMPLE_RATE_HZ);
        assert_eq!(spec.bits_per_sample, 16);
        assert_eq!(samples.len(), 24_000);
        assert!(samples.iter().any(|&s| s.unsigned_abs() > 10_000));
    }

    #[test]
    fn the_channels_are_averaged() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("split.wav");
        let frames: Vec<Vec<f32>> = (0..1600).map(|_| vec![0.5, -0.5]).collect();
        write_wav(&src, SAMPLE_RATE_HZ, 2, &frames);
        let dst = dir.path().join("audio.wav");

        decode_to_wav(&src, &dst).unwrap();

        let (_, samples) = read_mono(&dst);
        assert_eq!(samples.len(), 1600);
        assert!(samples.iter().all(|&s| s == 0));
    }

    #[test]
    fn an_upper_case_extension_is_accepted() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("Nagranie Zespołu.WAV");
        let frames: Vec<Vec<f32>> = tone(8_000, 0.5).into_iter().map(|s| vec![s]).collect();
        write_wav(&src, 8_000, 1, &frames);
        let dst = dir.path().join("audio.wav");

        decode_to_wav(&src, &dst).unwrap();

        assert_eq!(read_mono(&dst).1.len(), 8_000);
    }

    #[test]
    fn an_unsupported_extension_is_refused_before_the_file_is_read() {
        let dir = tempfile::tempdir().unwrap();
        let dst = dir.path().join("audio.wav");

        let err = decode_to_wav(&dir.path().join("missing.wma"), &dst).unwrap_err();

        assert!(matches!(err, ImportError::UnsupportedFormat), "{err:?}");
        assert!(err.to_string().contains("WAV, MP3, M4A, MP4, FLAC or OGG"));
    }

    #[test]
    fn a_file_without_an_extension_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("recording");
        std::fs::write(&src, b"RIFF").unwrap();

        let err = decode_to_wav(&src, &dir.path().join("audio.wav")).unwrap_err();

        assert!(matches!(err, ImportError::UnsupportedFormat), "{err:?}");
    }

    #[test]
    fn a_missing_file_is_a_read_error() {
        let dir = tempfile::tempdir().unwrap();

        let err =
            decode_to_wav(&dir.path().join("gone.mp3"), &dir.path().join("audio.wav")).unwrap_err();

        assert!(matches!(err, ImportError::Read(_)), "{err:?}");
    }

    #[test]
    fn garbage_with_an_audio_extension_is_not_readable() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("broken.m4a");
        std::fs::write(&src, vec![0x5au8; 4096]).unwrap();
        let dst = dir.path().join("audio.wav");

        let err = decode_to_wav(&src, &dst).unwrap_err();

        assert!(matches!(err, ImportError::NotReadable(_)), "{err:?}");
        assert!(err.to_string().contains("not a readable M4A file"), "{err}");
        assert!(
            err.to_string().contains("WAV, MP3, M4A, MP4, FLAC or OGG"),
            "{err}"
        );
    }

    #[test]
    fn an_m4a_cut_before_its_index_is_not_readable() {
        let dir = tempfile::tempdir().unwrap();
        let whole = std::fs::read(fixture("tone.m4a")).unwrap();
        let src = dir.path().join("cut.m4a");
        std::fs::write(&src, &whole[..whole.len() / 2]).unwrap();
        let dst = dir.path().join("audio.wav");

        let err = decode_to_wav(&src, &dst).unwrap_err();

        assert!(matches!(err, ImportError::NotReadable(_)), "{err:?}");
        assert!(err.to_string().contains("may be damaged"), "{err}");
    }

    #[test]
    fn an_mp3_cut_short_keeps_the_audio_before_the_cut() {
        let dir = tempfile::tempdir().unwrap();
        let whole = std::fs::read(fixture("tone.mp3")).unwrap();
        let src = dir.path().join("cut.mp3");
        std::fs::write(&src, &whole[..whole.len() / 2]).unwrap();
        let dst = dir.path().join("audio.wav");

        decode_to_wav(&src, &dst).unwrap();

        let secs = read_mono(&dst).1.len() as f64 / f64::from(SAMPLE_RATE_HZ);
        assert!((0.2..0.8).contains(&secs), "{secs} s");
    }

    #[test]
    fn a_wav_without_samples_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("silent.wav");
        write_wav(&src, 44_100, 1, &[]);
        let dst = dir.path().join("audio.wav");

        let err = decode_to_wav(&src, &dst).unwrap_err();

        assert!(matches!(err, ImportError::Empty), "{err:?}");
    }

    fn fixture(name: &str) -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/import")
            .join(name)
    }

    #[test]
    fn every_supported_container_decodes_to_its_length() {
        let dir = tempfile::tempdir().unwrap();
        for name in [
            "tone.mp3",
            "tone.m4a",
            "tone-with-video.mp4",
            "tone.flac",
            "tone.ogg",
        ] {
            let dst = dir.path().join(format!("{name}.wav"));

            decode_to_wav(&fixture(name), &dst).unwrap_or_else(|e| panic!("{name}: {e}"));

            let (spec, samples) = read_mono(&dst);
            assert_eq!(
                (spec.channels, spec.sample_rate),
                (1, SAMPLE_RATE_HZ),
                "{name}"
            );
            let secs = samples.len() as f64 / f64::from(SAMPLE_RATE_HZ);
            assert!((0.95..1.1).contains(&secs), "{name}: {secs} s");
            assert!(
                samples.iter().any(|&s| s.unsigned_abs() > 1_000),
                "{name}: the tone is missing"
            );
        }
    }

    #[test]
    fn opus_audio_is_refused_as_an_unsupported_codec() {
        let dir = tempfile::tempdir().unwrap();
        let dst = dir.path().join("audio.wav");

        let err = decode_to_wav(&fixture("opus.ogg"), &dst).unwrap_err();

        assert!(matches!(err, ImportError::UnsupportedAudio), "{err:?}");
        assert!(err.to_string().contains("AAC-LC"), "{err}");
    }

    #[test]
    fn supported_formats_names_every_extension_once() {
        assert_eq!(supported_formats(), "WAV, MP3, M4A, MP4, FLAC or OGG");
    }

    #[test]
    fn supported_formats_matches_ts_mirror() {
        let src = include_str!("../../../../desktop/src/src/app/models/transcript.ts");
        assert!(
            src.contains(&format!(
                "export const IMPORT_FORMATS_LABEL = '{}';",
                supported_formats()
            )),
            "models/transcript.ts IMPORT_FORMATS_LABEL must equal supported_formats()"
        );
    }

    #[test]
    fn the_resampler_keeps_16k_untouched() {
        let mut rs = AreaResampler::new(16_000, 16_000);
        let mut out = Vec::new();
        rs.push(&[0.1, -0.2, 0.3], &mut out);
        rs.finish(&mut out);
        assert_eq!(out, vec![0.1, -0.2, 0.3]);
    }

    #[test]
    fn the_resampler_averages_each_output_period_across_pushes() {
        let mut rs = AreaResampler::new(48_000, 16_000);
        let mut out = Vec::new();
        rs.push(&[0.3, 0.6], &mut out);
        assert!(out.is_empty());
        rs.push(&[0.9, 0.0, 0.0, 0.3], &mut out);
        rs.finish(&mut out);
        assert_eq!(out.len(), 2);
        assert!((out[0] - 0.6).abs() < 1e-6);
        assert!((out[1] - 0.1).abs() < 1e-6);
    }

    #[test]
    fn the_resampler_weights_a_fractional_ratio_exactly() {
        let mut rs = AreaResampler::new(44_100, 16_000);
        let mut out = Vec::new();
        rs.push(&vec![0.25; 44_100], &mut out);
        rs.finish(&mut out);
        assert_eq!(out.len(), 16_000);
        assert!(out.iter().all(|&s| (s - 0.25).abs() < 1e-6));
    }

    #[test]
    fn the_resampler_holds_each_sample_when_growing_the_rate() {
        let mut rs = AreaResampler::new(8_000, 16_000);
        let mut out = Vec::new();
        rs.push(&[0.5, -0.5], &mut out);
        rs.finish(&mut out);
        assert_eq!(out, vec![0.5, 0.5, -0.5, -0.5]);
    }

    #[test]
    fn the_resampler_flushes_a_partial_period_at_the_end() {
        let mut rs = AreaResampler::new(48_000, 16_000);
        let mut out = Vec::new();
        rs.push(&[0.4], &mut out);
        rs.finish(&mut out);
        assert_eq!(out.len(), 1);
        assert!((out[0] - 0.4).abs() < 1e-6);
    }
}
