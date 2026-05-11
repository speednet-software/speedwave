//! Host-side meeting transcription — SSOT layer (ADR-056). Capture +
//! Whisper + sherpa-onnx + model store; gated behind the `audio-transcription`
//! feature (CLI never enables it).

pub mod accel;
pub mod audio;
pub mod diarizer;
pub mod model_catalog;
pub mod model_store;
pub mod transcriber;

pub use accel::{compiled_backends, has_gpu_backend, recommended_live_model, Backend};
pub use audio::{
    AudioCapture, AudioChunk, AudioSource, AudioSourceInfo, AudioStream, CaptureCapabilities,
    CaptureError, FileAudioCapture, ProcessSelector, CHUNK_DURATION, SAMPLE_RATE_HZ,
};
pub use diarizer::{DiarizeError, DiarizeOptions, Diarizer, SherpaDiarizer, SpeakerTurn};
pub use model_catalog::{
    default_diarization_model, diarization_model, whisper_model, DiarizationModelInfo,
    DiarizationModelKind, ModelRole, Quantization, WhisperModelInfo, DIARIZATION_MODELS,
    WHISPER_MODELS,
};
pub use model_store::{
    no_progress, DiarizationModelPaths, DownloadProgress, ModelStatusEntry, ModelStore,
    ModelStoreError,
};
pub use transcriber::{
    Language, Segment, SpeakerId, TranscribeError, TranscribeOptions, Transcriber,
    WhisperCppTranscriber, Word,
};

use std::path::PathBuf;

/// `<data_dir>/transcripts/` (perms 0o700, files 0o600 — contains audio).
pub fn transcripts_dir() -> PathBuf {
    crate::consts::data_dir().join(crate::consts::TRANSCRIPTS_SUBDIR)
}

/// `<data_dir>/models/` (whisper/ + diarization/).
pub fn models_dir() -> PathBuf {
    crate::consts::data_dir().join(crate::consts::MODELS_SUBDIR)
}

/// Resolves the `AudioCapture` backend for this host. Phase 1a:
/// `FileAudioCapture` everywhere; Phase 4 adds the real per-OS backends.
pub fn detect_audio_capture() -> Box<dyn AudioCapture> {
    Box::new(FileAudioCapture::new())
}

/// Orchestration facade — owns the capture backend (+ later, a transcriber /
/// diarizer / `ModelStore`).
pub struct TranscriptionEngine {
    capture: Box<dyn AudioCapture>,
}

impl TranscriptionEngine {
    /// Uses the host's `AudioCapture` backend.
    pub fn new() -> Self {
        Self {
            capture: detect_audio_capture(),
        }
    }

    /// Injects an explicit capture backend (for tests).
    pub fn with_capture(capture: Box<dyn AudioCapture>) -> Self {
        Self { capture }
    }

    /// Capabilities of the host's capture backend.
    pub fn capture_capabilities(&self) -> CaptureCapabilities {
        self.capture.capabilities()
    }

    /// Sources the user can pick from.
    pub fn list_audio_sources(&self) -> Result<Vec<AudioSourceInfo>, CaptureError> {
        self.capture.enumerate_sources()
    }

    /// Starts capturing `source`. (Phase 1d wires this into a `TranscriptDriver`.)
    pub fn start_capture(&self, source: AudioSource) -> Result<Box<dyn AudioStream>, CaptureError> {
        self.capture.start(source)
    }
}

impl Default for TranscriptionEngine {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn dirs_are_under_the_data_dir() {
        let data = crate::consts::data_dir();
        assert!(
            transcripts_dir().starts_with(data),
            "transcripts dir must be under data_dir"
        );
        assert!(
            models_dir().starts_with(data),
            "models dir must be under data_dir"
        );
        assert!(transcripts_dir().ends_with(crate::consts::TRANSCRIPTS_SUBDIR));
        assert!(models_dir().ends_with(crate::consts::MODELS_SUBDIR));
    }

    #[test]
    fn detect_audio_capture_returns_the_file_backend_for_now() {
        let cap = detect_audio_capture();
        // Phase 1a: every platform gets FileAudioCapture (file input only).
        assert!(!cap.capabilities().supports_system_audio);
        assert!(!cap.capabilities().supports_per_process);
    }

    #[test]
    fn engine_exposes_capture_through_an_injected_backend() {
        // Drive a WAV fixture through the engine via an injected FileAudioCapture.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("e.wav");
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 16_000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut w = hound::WavWriter::create(&path, spec).unwrap();
        for i in 0..16_000 {
            // 1 s
            let v = (0.2
                * (2.0 * std::f32::consts::PI * 200.0 * i as f32 / 16_000.0).sin()
                * 32_767.0) as i16;
            w.write_sample(v).unwrap();
        }
        w.finalize().unwrap();

        let engine = TranscriptionEngine::with_capture(Box::new(FileAudioCapture::for_file(&path)));
        assert!(engine.capture_capabilities().note.is_some());
        let sources = engine.list_audio_sources().unwrap();
        assert_eq!(
            sources.len(),
            1,
            "the bound file shows up as the one source"
        );
        let mut stream = engine.start_capture(AudioSource::SystemWide).unwrap();
        let mut total = 0;
        while let Some(c) = stream.next_chunk().unwrap() {
            total += c.samples.len();
        }
        assert_eq!(total, 16_000);
    }

    #[test]
    fn engine_default_uses_the_host_backend() {
        let engine = TranscriptionEngine::default();
        // With the file backend, capturing without a path fails cleanly.
        // (`Box<dyn AudioStream>` has no Debug, so match the error out.)
        match engine.start_capture(AudioSource::SystemWide) {
            Ok(_) => panic!("expected capture to fail with the file backend and no path"),
            Err(e) => assert!(
                matches!(e, CaptureError::Unsupported(_)),
                "expected Unsupported, got {e:?}"
            ),
        }
    }
}
