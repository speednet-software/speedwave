//! Host-side meeting transcription — SSOT layer (ADR-056). Capture +
//! Whisper + sherpa-onnx + model store; gated behind the `audio-transcription`
//! feature (CLI never enables it).

pub mod accel;
pub mod audio;
#[cfg(target_os = "linux")]
pub mod audio_linux;
#[cfg(target_os = "macos")]
pub mod audio_macos;
#[cfg(windows)]
pub mod audio_windows;
pub mod diarizer;
pub mod mix;
pub mod model_catalog;
pub mod model_store;
pub mod transcriber;
pub mod transcript;
pub mod transcript_driver;
pub mod transcript_store;

pub use accel::{compiled_backends, has_gpu_backend, recommended_live_model, Backend};
pub use audio::{
    AudioCapture, AudioChunk, AudioSource, AudioSourceInfo, AudioStream, CaptureCapabilities,
    CaptureError, FileAudioCapture, ProcessSelector, CHUNK_DURATION, DEFAULT_MIXED_SOURCE_LABEL,
    SAMPLE_RATE_HZ,
};
pub use diarizer::{DiarizeError, DiarizeOptions, Diarizer, SherpaDiarizer, SpeakerTurn};
pub use mix::{chunk_samples, poll_mixed_chunk, MixBuffer, MixSource};
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
pub use transcript::{ModelsUsed, TranscriptSession, TranscriptStatus};
pub use transcript_driver::{
    run_finalize, DriverConfig, DriverError, FinalizeConfig, StopSignal, TranscriptDriver,
};
pub use transcript_store::{StoreError, Subscription, TranscriptEvent, TranscriptStore};

use std::path::PathBuf;

/// `<data_dir>/transcripts/` (perms 0o700, files 0o600 — contains audio).
pub fn transcripts_dir() -> PathBuf {
    crate::consts::data_dir().join(crate::consts::TRANSCRIPTS_SUBDIR)
}

/// `<data_dir>/models/` (whisper/ + diarization/).
pub fn models_dir() -> PathBuf {
    crate::consts::data_dir().join(crate::consts::MODELS_SUBDIR)
}

/// Resolves the `AudioCapture` backend for this host: macOS = the bundled
/// `audio-capture-cli` (CoreAudio process taps); Linux = shell-out to
/// `pw-record` / `parec`; Windows = WASAPI loopback via cpal; anything else =
/// `FileAudioCapture` (file input only).
pub fn detect_audio_capture() -> Box<dyn AudioCapture> {
    #[cfg(target_os = "macos")]
    {
        Box::new(audio_macos::MacOsAudioCapture::new())
    }
    #[cfg(target_os = "linux")]
    {
        Box::new(audio_linux::LinuxAudioCapture::new())
    }
    #[cfg(windows)]
    {
        Box::new(audio_windows::WasapiAudioCapture::new())
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
    {
        Box::new(FileAudioCapture::new())
    }
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

    /// Starts capturing `source`; the returned stream is what `TranscriptDriver`
    /// pumps.
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
    fn detect_audio_capture_picks_the_host_backend() {
        let caps = detect_audio_capture().capabilities();
        // macOS always has a real backend (the audio-capture-cli enforces
        // 14.4 itself, so we assume taps are available). Linux depends on a
        // running sound server, and Windows on a present output device — both
        // true on a dev box, possibly false on a bare CI runner — so we don't
        // assert their flags here. Other OSes fall back to FileAudioCapture.
        if cfg!(target_os = "macos") {
            assert!(caps.supports_system_audio);
            assert!(caps.supports_per_process);
        } else if cfg!(target_os = "linux") || cfg!(windows) {
            // A real backend or its degraded state — both valid; just require
            // the UI note (and per-process must be off on Windows in v1).
            if cfg!(windows) {
                assert!(!caps.supports_per_process, "no per-app on Windows in v1");
            }
        } else {
            assert!(!caps.supports_system_audio);
            assert!(!caps.supports_per_process);
        }
        // Every backend annotates a UI note.
        assert!(caps.note.is_some());
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
    #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
    fn engine_default_uses_the_file_backend_on_unsupported_os() {
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

    #[test]
    #[cfg(windows)]
    fn engine_default_uses_the_windows_backend() {
        // On Windows the default engine wraps the WASAPI-loopback capture; we
        // only assert it has a UI note and never advertises per-process in v1
        // (a CI runner may have no audio device, so other flags aren't asserted).
        let engine = TranscriptionEngine::default();
        let caps = engine.capture_capabilities();
        assert!(caps.note.is_some());
        assert!(!caps.supports_per_process);
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn engine_default_uses_the_linux_backend() {
        // On Linux the default engine wraps the shell-out capture; we only
        // assert it has a UI note (the rest depends on whether a sound server
        // is running, which a CI runner usually lacks).
        let engine = TranscriptionEngine::default();
        assert!(engine.capture_capabilities().note.is_some());
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn engine_default_uses_the_macos_backend() {
        // On macOS the default engine wraps the real CLI-backed capture; we
        // only assert the capability shape here — spawning the CLID is an
        // integration concern (and may need TCC), not a unit test.
        let engine = TranscriptionEngine::default();
        let caps = engine.capture_capabilities();
        assert!(caps.supports_system_audio);
        assert!(caps.supports_per_process);
    }
}
