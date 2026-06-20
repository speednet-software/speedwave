//! Opt-in E2E: capture → live → finalize → markdown with a real Whisper model.
//! Gated by env (normal `make test` skips it): `RUN_STT_E2E=1`,
//! `STT_E2E_MODEL` (default "small"), `STT_E2E_WAV` (else a synthetic tone),
//! `STT_E2E_EXPECT` (markdown substring assertion, requires STT_E2E_WAV).

#![cfg(feature = "audio-transcription")]

use std::path::PathBuf;
use std::sync::Arc;

use speedwave_runtime::transcription::{
    run_finalize, AudioCapture, AudioSource, AudioSourceInfo, DriverConfig, FileAudioCapture,
    FinalizeConfig, Language, ModelStore, StopSignal, TranscribeOptions, TranscriptDriver,
    TranscriptSession, TranscriptStore, WhisperCppTranscriber,
};

fn env(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.is_empty())
}

/// Writes a synthetic 16 kHz mono WAV (a quiet tone) — exercises the pipeline
/// plumbing when no real-speech clip is provided.
fn synth_wav(dir: &std::path::Path, secs: f32) -> PathBuf {
    let path = dir.join("synth.wav");
    let mut w = hound::WavWriter::create(
        &path,
        hound::WavSpec {
            channels: 1,
            sample_rate: 16_000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        },
    )
    .expect("create synth wav");
    let n = (secs * 16_000.0) as usize;
    for i in 0..n {
        let v = (0.05 * (2.0 * std::f32::consts::PI * 220.0 * i as f32 / 16_000.0).sin() * 32_767.0)
            as i16;
        w.write_sample(v).expect("write sample");
    }
    w.finalize().expect("finalize wav");
    path
}

#[test]
fn full_pipeline_capture_transcribe_finalize_markdown() {
    if env("RUN_STT_E2E").is_none() {
        eprintln!("skipping: set RUN_STT_E2E=1 to run the STT pipeline E2E test");
        return;
    }
    let model_key = env("STT_E2E_MODEL").unwrap_or_else(|| "small".to_string());

    // Resolve the model — it must already be downloaded (the E2E VM pre-fetches
    // it; we never auto-download a multi-hundred-MB model from a test).
    let models = ModelStore::new();
    let model_path = models
        .ensure_model(&model_key, &mut |_| {})
        .unwrap_or_else(|e| panic!("model {model_key} must be downloaded for the E2E test: {e}"));

    let work = tempfile::tempdir().expect("tempdir");
    let store = Arc::new(TranscriptStore::with_root(work.path()));

    // Either a caller-supplied real-speech clip, or a synthetic tone.
    let wav = match env("STT_E2E_WAV") {
        Some(p) => PathBuf::from(p),
        None => synth_wav(work.path(), 6.0),
    };

    // Choose the session id up front so the audio.wav path under <root>/<id>/
    // is correct from the first write (mirrors the Tauri start command).
    let id = uuid::Uuid::new_v4();
    let audio_wav = store.session_dir(id).join("audio.wav");
    let session = TranscriptSession::new_with_id(
        id,
        Language::En,
        AudioSourceInfo {
            source: AudioSource::SystemWide,
            label: "E2E".to_string(),
            app_id: None,
        },
        audio_wav.clone(),
    );
    store.create(session).expect("create session");

    // Live pass: FileAudioCapture replays the WAV (the production file path is
    // passed per-call as a Microphone source) → driver writes audio.wav + live
    // segments.
    let stream = FileAudioCapture::new()
        .start(AudioSource::Microphone {
            device: Some(wav.to_string_lossy().into_owned()),
        })
        .expect("file capture start");
    let transcriber =
        WhisperCppTranscriber::load(&model_path, model_key.clone()).expect("load whisper");
    let driver = TranscriptDriver::new(DriverConfig {
        id,
        store: store.clone(),
        audio: stream,
        transcriber: Box::new(transcriber),
        transcribe_opts: TranscribeOptions::for_language(Language::En),
        stop: StopSignal::new(),
    });
    driver.run(&audio_wav).expect("live driver run");
    assert!(audio_wav.is_file(), "live pass must write audio.wav");

    // Offline finalize: re-transcribe the recorded WAV at higher quality.
    let finalize_transcriber =
        WhisperCppTranscriber::load(&model_path, model_key.clone()).expect("reload whisper");
    run_finalize(FinalizeConfig {
        id,
        store: store.clone(),
        audio_path: audio_wav,
        transcriber: Box::new(finalize_transcriber),
        transcribe_opts: TranscribeOptions::for_language(Language::En),
    })
    .expect("finalize run");

    let session = store.get(id).expect("get finalized session");
    let md = session.to_markdown();
    assert!(
        md.starts_with("# Meeting transcript ("),
        "markdown must have the header, got:\n{md}"
    );

    if let Some(expect) = env("STT_E2E_EXPECT") {
        assert!(
            md.to_lowercase().contains(&expect.to_lowercase()),
            "transcript markdown must contain {expect:?}; got:\n{md}"
        );
    }
}
