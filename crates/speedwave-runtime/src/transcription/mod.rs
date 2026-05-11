//! Host-side meeting transcription — the SSOT layer (ADR-056).
//!
//! This module owns everything that is *not* UI: audio capture (a per-OS
//! `AudioCapture` trait — Phase 1a ships only `FileAudioCapture`), the model
//! catalogue (`model_catalog`), and — added in later phases — the model store
//! (download-on-demand, SHA256-verified), the Whisper transcriber, the
//! sherpa-onnx diarizer, and the per-recording session/store/driver. The Tauri
//! command layer (`desktop/src-tauri/src/transcription_cmd.rs`) is a thin
//! wrapper over this; the CLI never enables the `audio-transcription` feature
//! and so never compiles this module.
//!
//! Submodules land across Phase 1's four PRs:
//! - 1a (this PR): `audio` (trait + `FileAudioCapture`), `model_catalog` (SSOT).
//! - 1b: `model_store` (download/verify/cache).
//! - 1c: `transcriber` (Whisper via `whisper-rs`), `diarizer` (sherpa-onnx),
//!   `accel` (which backends were compiled in).
//! - 1d: `transcript` (`TranscriptSession`), `transcript_store`, `transcript_driver`.

pub mod audio;
pub mod model_catalog;

pub use audio::{
    AudioCapture, AudioChunk, AudioSource, AudioSourceInfo, AudioStream, CaptureCapabilities,
    CaptureError, FileAudioCapture, ProcessSelector, CHUNK_DURATION, SAMPLE_RATE_HZ,
};
pub use model_catalog::{
    default_diarization_model, diarization_model, whisper_model, DiarizationModelInfo,
    DiarizationModelKind, ModelRole, Quantization, WhisperModelInfo, DIARIZATION_MODELS,
    WHISPER_MODELS,
};

use std::path::PathBuf;

/// Path to the transcripts directory under `data_dir()`
/// (`<data_dir>/transcripts/`). Created on demand by the session store; perms
/// `0o700` (it contains microphone/system audio).
pub fn transcripts_dir() -> PathBuf {
    crate::consts::data_dir().join(crate::consts::TRANSCRIPTS_SUBDIR)
}

/// Path to the downloaded-models directory under `data_dir()`
/// (`<data_dir>/models/`). Whisper models go under `whisper/`, diarization
/// models under `diarization/`. Created on demand by the model store; perms
/// `0o700`.
pub fn models_dir() -> PathBuf {
    crate::consts::data_dir().join(crate::consts::MODELS_SUBDIR)
}

/// Resolves the `AudioCapture` backend for this host.
///
/// Phase 1a returns `FileAudioCapture` on every platform — the only thing it
/// can "capture" is a WAV file path passed to `start()` (the dev affordance,
/// and the substrate every Phase 1 test runs on). Phase 4 replaces this with
/// `#[cfg(windows)] WasapiAudioCapture`, `#[cfg(target_os = "macos")]
/// MacOsAudioCapture`, `#[cfg(target_os = "linux")] LinuxAudioCapture` —
/// the same `Box<dyn …>` seam as `runtime::detect_runtime()`.
pub fn detect_audio_capture() -> Box<dyn AudioCapture> {
    Box::new(FileAudioCapture::new())
}

/// The orchestration facade — owns the capture backend and (in later phases) a
/// transcriber, a diarizer, and a reference to the model store. Phase 1a is a
/// thin shell; 1c/1d flesh it out. Kept deliberately small (it's the "thin
/// orchestration layer" — the heavy lifting is in `whisper-rs` / `sherpa-onnx`).
pub struct TranscriptionEngine {
    capture: Box<dyn AudioCapture>,
}

impl TranscriptionEngine {
    /// Builds an engine using the host's `AudioCapture` backend.
    pub fn new() -> Self {
        Self {
            capture: detect_audio_capture(),
        }
    }

    /// Builds an engine with an explicit capture backend (used by tests to
    /// inject `FileAudioCapture` bound to a fixture).
    pub fn with_capture(capture: Box<dyn AudioCapture>) -> Self {
        Self { capture }
    }

    /// What the host's capture backend can do.
    pub fn capture_capabilities(&self) -> CaptureCapabilities {
        self.capture.capabilities()
    }

    /// Audio sources the user can pick from.
    pub fn list_audio_sources(&self) -> Result<Vec<AudioSourceInfo>, CaptureError> {
        self.capture.enumerate_sources()
    }

    /// Start capturing `source`. (Phase 1d wires this into a `TranscriptDriver`
    /// that pumps the resulting stream through the transcriber and diarizer; for
    /// now this just exposes the raw stream so 1a's tests can exercise capture.)
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
