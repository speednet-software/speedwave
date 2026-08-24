//! Host-side meeting transcription — SSOT layer (ADR-056). Capture + Whisper + model store;
//! gated behind `audio-transcription` (CLI never enables it). Diarization removed (ADR-075).

pub mod accel;
pub mod audio;
#[cfg(target_os = "macos")]
pub mod audio_macos;
#[cfg(windows)]
pub mod audio_windows;
mod gpu_probe;
pub mod mix;
pub mod model_catalog;
pub mod model_store;
pub mod transcriber;
pub mod transcript;
pub mod transcript_driver;
pub mod transcript_store;

pub use accel::{
    accel_label, compiled_backends, decode_threads, finalize_model_for_this_build, gpu_class,
    has_gpu_backend, live_model_for_this_build, Backend, GpuClass,
};
pub use audio::{
    bytes_to_f32_samples, drain_child_stderr, kill_child_gracefully, parse_wav_to_mono_f32,
    wav_duration, AudioCapture, AudioChunk, AudioSource, AudioSourceInfo, AudioStream,
    CaptureCapabilities, CaptureError, CaptureWarning, FileAudioCapture, CHUNK_DURATION,
    DEFAULT_MIXED_SOURCE_LABEL, SAMPLE_RATE_HZ,
};
pub use mix::{poll_paired_chunk, MixBuffer, MixSource, CHUNK_SAMPLES};
pub use model_catalog::{whisper_model, ModelRole, Quantization, WhisperModelInfo, WHISPER_MODELS};
pub use model_store::{
    no_progress, DownloadProgress, ModelStatusEntry, ModelStore, ModelStoreError,
};
pub use transcriber::{
    Language, Segment, TranscribeError, TranscribeOptions, Transcriber, WhisperCppTranscriber, Word,
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

/// `<data_dir>/models/` (whisper/).
pub fn models_dir() -> PathBuf {
    crate::consts::data_dir().join(crate::consts::MODELS_SUBDIR)
}

/// Resolves the `AudioCapture` backend for this host: macOS = bundled `audio-capture-cli`
/// (CoreAudio taps); Windows = WASAPI loopback via `wasapi` (mic via cpal); else = file input.
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
mod tests {
    use super::*;

    #[test]
    fn dirs_are_under_the_data_dir() {
        // Structural invariant only — both dirs share one data-dir parent, without naming the
        // production `data_dir()` singleton, so it holds under any isolated tempdir.
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
        // Windows flags are host-dependent (output device); other OSes use
        // FileAudioCapture.
        if cfg!(target_os = "macos") {
            assert!(caps.supports_system_audio);
        } else if cfg!(windows) {
            assert!(caps.note.is_some());
        } else {
            assert!(!caps.supports_system_audio);
        }
        // Every backend annotates a UI note.
        assert!(caps.note.is_some());
    }
}
