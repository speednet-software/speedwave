//! Host-side meeting transcription — SSOT layer (ADR-056). Capture +
//! Whisper + sherpa-onnx + model store; gated behind the `audio-transcription`
//! feature (CLI never enables it).

pub mod accel;
pub mod audio;
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
    bytes_to_f32_samples, drain_child_stderr, kill_child_gracefully, parse_wav_to_mono_f32,
    AudioCapture, AudioChunk, AudioSource, AudioSourceInfo, AudioStream, CaptureCapabilities,
    CaptureError, FileAudioCapture, ProcessSelector, CHUNK_DURATION, DEFAULT_MIXED_SOURCE_LABEL,
    SAMPLE_RATE_HZ,
};
pub use diarizer::{DiarizeError, DiarizeOptions, Diarizer, SherpaDiarizer, SpeakerTurn};
pub use mix::{poll_mixed_chunk, MixBuffer, MixSource, CHUNK_SAMPLES};
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
/// `audio-capture-cli` (CoreAudio process taps); Windows = WASAPI loopback via
/// cpal; anything else = `FileAudioCapture` (file input only).
pub fn detect_audio_capture() -> Box<dyn AudioCapture> {
    #[cfg(target_os = "macos")]
    {
        Box::new(audio_macos::MacOsAudioCapture::new())
    }
    #[cfg(windows)]
    {
        Box::new(audio_windows::WasapiAudioCapture::new())
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        Box::new(FileAudioCapture::new())
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn dirs_are_under_the_data_dir() {
        // Both dirs share one data-dir parent and end with their subdir.
        let transcripts = transcripts_dir();
        let models = models_dir();
        assert!(transcripts.ends_with(crate::consts::TRANSCRIPTS_SUBDIR));
        assert!(models.ends_with(crate::consts::MODELS_SUBDIR));
        assert_eq!(
            transcripts.parent(),
            models.parent(),
            "both dirs must live directly under the same data_dir"
        );
        assert!(
            transcripts
                .parent()
                .is_some_and(|p| p.file_name().is_some()),
            "data-dir parent must be non-empty"
        );
    }

    #[test]
    fn detect_audio_capture_picks_the_host_backend() {
        let caps = detect_audio_capture().capabilities();
        if cfg!(target_os = "macos") {
            assert!(caps.supports_system_audio);
            assert!(caps.supports_per_process);
        } else if cfg!(windows) {
            assert!(!caps.supports_per_process, "no per-app on Windows in v1");
        } else {
            assert!(!caps.supports_system_audio);
            assert!(!caps.supports_per_process);
        }
        // Every backend annotates a UI note.
        assert!(caps.note.is_some());
    }
}
