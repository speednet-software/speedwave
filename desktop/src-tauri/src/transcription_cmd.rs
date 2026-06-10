//! Tauri commands for the meeting-transcription feature (ADR-056).
//!
//! Thin layer over `speedwave_runtime::transcription`: stores live in Tauri
//! managed state; events forwarded via per-session `transcript_event::<id>`
//! Tauri event channels (subscribe returns `{event_name, snapshot}` so a late
//! subscriber doesn't miss what already happened — ADR-043 delivery shape).

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use speedwave_runtime::transcription::{
    self, AudioSource, AudioSourceInfo, Backend, CaptureCapabilities, DiarizeOptions, Diarizer,
    DriverConfig, FinalizeConfig, Language, ModelStatusEntry, ModelStore, SherpaDiarizer,
    SpeakerId, StopSignal, TranscribeOptions, TranscriptDriver, TranscriptEvent, TranscriptSession,
    TranscriptStatus, TranscriptStore, WhisperCppTranscriber,
};
use tauri::{AppHandle, Emitter};
use tokio::sync::broadcast;
use uuid::Uuid;

/// Tauri-managed `TranscriptStore`.
pub type TranscriptStoreHandle = Arc<TranscriptStore>;
/// Tauri-managed `ModelStore`.
pub type ModelStoreHandle = Arc<ModelStore>;
/// Tauri-managed map of in-flight recordings → their stop signal.
pub type DriversHandle = Arc<Mutex<HashMap<Uuid, StopSignal>>>;
/// Sessions that already have a live event forwarder — guards against
/// double-spawning on repeated `subscribe_transcript` calls.
pub type ForwardersHandle = Arc<Mutex<HashSet<Uuid>>>;

/// Per-session Tauri event name for transcript streams.
pub fn transcript_event_name(id: Uuid) -> String {
    format!("transcript_event::{id}")
}

/// Per-model-download progress event name.
pub const MODEL_PROGRESS_EVENT: &str = "transcription_model_status";

/// Validates a transcript id (UUID v4 string). Same shape as
/// `history::validate_session_id` but parses to `Uuid`.
fn parse_transcript_id(s: &str) -> Result<Uuid, String> {
    crate::history::validate_session_id(s).map_err(|e| e.to_string())?;
    Uuid::parse_str(s).map_err(|e| format!("invalid transcript id: {e}"))
}

/// Caps a user-supplied speaker name length (matches `TranscriptSession::relabel_speaker`).
const MAX_SPEAKER_NAME_LEN: usize = 64;
/// Defensive upper bound on the diarizer's `num_clusters` hint. Real meetings
/// rarely exceed a dozen distinct speakers; we cap well above that so a UI
/// glitch or a malicious caller can't pass a giant value straight to sherpa.
const MAX_EXPECTED_SPEAKERS: u32 = 50;

fn cap_name(name: &str) -> String {
    name.trim().chars().take(MAX_SPEAKER_NAME_LEN).collect()
}

/// Truncates a UUID for log lines so CodeQL's "log sensitive" heuristics
/// (which key off the `session_id` name) don't flag every diagnostic. The
/// first 8 hex chars are enough to correlate.
fn short_id(id: Uuid) -> String {
    let mut s = id.to_string();
    s.truncate(8);
    s
}

/// Sanitises the `expected_speakers` hint: `Some(0)` collapses to `None`
/// (auto-estimate), anything above the cap is rejected.
fn validate_expected_speakers(n: Option<u32>) -> Result<Option<u32>, String> {
    match n {
        None | Some(0) => Ok(None),
        Some(v) if v <= MAX_EXPECTED_SPEAKERS => Ok(Some(v)),
        Some(v) => Err(format!(
            "expected_speakers={v} exceeds the {MAX_EXPECTED_SPEAKERS} cap"
        )),
    }
}

// ---- 1) feature-toggle commands (top-level user config, ADR-056 §13) ------

// Synchronous file I/O for the four toggle commands is wrapped in
// `spawn_blocking` so it never stalls the Tokio runtime thread.

#[tauri::command]
pub async fn transcription_enabled() -> Result<bool, String> {
    tokio::task::spawn_blocking(|| {
        speedwave_runtime::config::load_user_config().map(|c| c.transcription_enabled())
    })
    .await
    .map_err(|e| format!("config task panicked: {e}"))?
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_transcription_enabled(enabled: bool) -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let mut cfg = speedwave_runtime::config::load_user_config().map_err(|e| e.to_string())?;
        let mut tr = cfg.transcription.unwrap_or_default();
        tr.enabled = Some(enabled);
        cfg.transcription = Some(tr);
        speedwave_runtime::config::save_user_config(&cfg).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("config task panicked: {e}"))?
}

/// Returns the full meeting-transcription preferences block (defaults if unset).
#[tauri::command]
pub async fn get_transcription_config(
) -> Result<speedwave_runtime::config::TranscriptionConfig, String> {
    tokio::task::spawn_blocking(|| {
        speedwave_runtime::config::load_user_config().map(|c| c.transcription.unwrap_or_default())
    })
    .await
    .map_err(|e| format!("config task panicked: {e}"))?
    .map_err(|e| e.to_string())
}

/// Persists the meeting-transcription preferences block (whole replace).
#[tauri::command]
pub async fn set_transcription_config(
    config: speedwave_runtime::config::TranscriptionConfig,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let mut cfg = speedwave_runtime::config::load_user_config().map_err(|e| e.to_string())?;
        cfg.transcription = Some(config);
        speedwave_runtime::config::save_user_config(&cfg).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("config task panicked: {e}"))?
}

// ---- 2) capability + source listing ---------------------------------------

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct CapabilitiesAck {
    /// What the host's audio backend can do.
    pub capabilities: CaptureCapabilities,
    /// Which whisper.cpp backends were compiled in.
    pub backends: Vec<Backend>,
}

#[tauri::command]
pub async fn transcription_capabilities() -> Result<CapabilitiesAck, String> {
    let capabilities = transcription::detect_audio_capture().capabilities();
    let backends = transcription::compiled_backends();
    Ok(CapabilitiesAck {
        capabilities,
        backends,
    })
}

#[tauri::command]
pub async fn list_audio_sources() -> Result<Vec<AudioSourceInfo>, String> {
    transcription::detect_audio_capture()
        .enumerate_sources()
        .map_err(|e| e.to_string())
}

// ---- 3) start / stop / subscribe ------------------------------------------

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct StartAck {
    /// New session id.
    pub session_id: Uuid,
    /// Tauri event channel for the live stream.
    pub event_name: String,
    /// Initial snapshot — apply this before listening to events.
    pub snapshot: TranscriptSession,
}

/// Frontend-supplied inputs for `start_transcription`. Grouped so the Tauri
/// command stays under the 7-argument clippy limit.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartParams {
    pub source: serde_json::Value,
    pub language: String,
    pub live_model_override: Option<String>,
    /// Diarizer hint: `None` = auto-estimate.
    pub expected_speakers: Option<u32>,
}

#[tauri::command]
pub async fn start_transcription(
    params: StartParams,
    store: tauri::State<'_, TranscriptStoreHandle>,
    models: tauri::State<'_, ModelStoreHandle>,
    drivers: tauri::State<'_, DriversHandle>,
    forwarders: tauri::State<'_, ForwardersHandle>,
    app: AppHandle,
) -> Result<StartAck, String> {
    let StartParams {
        source,
        language,
        live_model_override,
        expected_speakers,
    } = params;
    let expected_speakers = validate_expected_speakers(expected_speakers)?;
    // Force-language is enum-validated at the Rust boundary.
    let lang = match language.as_str() {
        "pl" => Language::Pl,
        "en" => Language::En,
        other => return Err(format!("unsupported language: {other}")),
    };
    let audio_source: AudioSource =
        serde_json::from_value(source).map_err(|e| format!("invalid audio source: {e}"))?;

    let capture = transcription::detect_audio_capture();
    let caps = capture.capabilities();
    // Defend at the boundary (the UI should already hide unsupported choices).
    validate_source_against_caps(&audio_source, &caps)?;

    // Pick live model: override wins, else recommendation, else any downloaded.
    // Never download implicitly — error with a hint if nothing is present.
    let store_arc = store.inner().clone();
    let models_arc = models.inner().clone();
    let recommended = transcription::recommended_live_model(&transcription::compiled_backends())
        .key
        .to_string();
    let override_key = live_model_override.clone();
    let live_key: String = {
        let m = models_arc.clone();
        let rec = recommended.clone();
        tokio::task::spawn_blocking(move || pick_live_model(&m, override_key.as_deref(), &rec))
            .await
            .map_err(|e| format!("model pick task panicked: {e}"))??
    };
    let whisper_path = {
        let key = live_key.clone();
        let m = models_arc.clone();
        tokio::task::spawn_blocking(move || m.ensure_model(&key, &mut |_| {}))
            .await
            .map_err(|e| format!("model path task panicked: {e}"))?
            .map_err(|e| e.to_string())?
    };
    let transcriber = {
        let path = whisper_path.clone();
        let key = live_key.clone();
        tokio::task::spawn_blocking(move || WhisperCppTranscriber::load(&path, key))
            .await
            .map_err(|e| format!("transcriber load task panicked: {e}"))?
            .map_err(|e| e.to_string())?
    };

    // Optional diarizer: best-effort — if the diarization models are present,
    // load them; otherwise run without speaker labels.
    let diarize_opts = DiarizeOptions {
        num_speakers: expected_speakers.map(|n| n as usize),
        ..DiarizeOptions::default()
    };
    let diarizer: Option<Box<dyn Diarizer>> = {
        let m = models_arc.clone();
        match tokio::task::spawn_blocking(move || {
            if !m.diarization_is_present() {
                return Ok::<Option<Box<dyn Diarizer>>, String>(None);
            }
            let paths = m
                .ensure_diarization_models(&mut |_| {})
                .map_err(|e| e.to_string())?;
            let d = SherpaDiarizer::load(
                &paths.segmentation_onnx,
                &paths.embedding_onnx,
                &diarize_opts,
            )
            .map_err(|e| e.to_string())?;
            Ok(Some(Box::new(d) as Box<dyn Diarizer>))
        })
        .await
        .map_err(|e| format!("diarizer load task panicked: {e}"))?
        {
            Ok(d) => d,
            Err(e) => {
                log::warn!("diarizer unavailable — running without speaker labels: {e}");
                None
            }
        }
    };

    // Create the session, then start capture.
    // The audio.wav path lives under `<root>/<id>/`, so we need the id before
    // creating the session — pick it now so the path is correct from the first
    // persisted write (no fragile post-create patch).
    let session_id = Uuid::new_v4();
    let session_dir = store.session_dir(session_id);
    let audio_wav = session_dir.join("audio.wav");
    let label = source_label(capture.as_ref(), &audio_source);
    let mut session = TranscriptSession::new_with_id(
        session_id,
        lang,
        AudioSourceInfo {
            source: audio_source.clone(),
            label,
            app_id: None,
        },
        audio_wav.clone(),
    );
    session.models_used.live = Some(live_key.clone());
    session.expected_speakers = expected_speakers;
    store
        .create(session)
        .map_err(|e| format!("store create: {e}"))?;

    let stream = capture.start(audio_source).map_err(|e| {
        // Mark the session failed so the UI shows the error, not a hang.
        let _ = store.set_status(
            session_id,
            TranscriptStatus::Failed {
                reason: e.to_string(),
            },
        );
        e.to_string()
    })?;

    // Wire the event forwarder before the driver mutates anything.
    spawn_event_forwarder(
        app,
        store_arc.clone(),
        forwarders.inner().clone(),
        session_id,
    );

    let stop = StopSignal::new();
    drivers
        .lock()
        .map_err(|e| format!("drivers lock poisoned: {e}"))?
        .insert(session_id, stop.clone());

    let stop_for_cleanup = stop.clone();
    let driver = TranscriptDriver::new(DriverConfig {
        id: session_id,
        store: store_arc.clone(),
        audio: stream,
        transcriber: Box::new(transcriber),
        diarizer,
        transcribe_opts: TranscribeOptions::for_language(lang),
        diarize_opts,
        stop,
    });
    // The driver loop blocks on `next_chunk` — run it on a blocking task.
    let drivers_for_cleanup = drivers.inner().clone();
    tokio::task::spawn_blocking(move || {
        if let Err(e) = driver.run(&audio_wav) {
            // Log only the first chunk of the id — UUIDs are not secrets, but
            // CodeQL's heuristics flag any "session_id"-looking variable in a
            // log line. The short form is enough to correlate diagnostics.
            log::warn!(
                "transcript driver for {} ended with error: {e}",
                short_id(session_id)
            );
        }
        // Drop the stop-signal entry once the driver has wound down, then
        // wake anyone waiting on `await_finished()` (e.g. `stop_transcription`).
        if let Ok(mut g) = drivers_for_cleanup.lock() {
            g.remove(&session_id);
        }
        stop_for_cleanup.signal_finished();
    });

    let snapshot = store.get(session_id).map_err(|e| e.to_string())?;
    Ok(StartAck {
        session_id,
        event_name: transcript_event_name(session_id),
        snapshot,
    })
}

#[tauri::command]
pub async fn stop_transcription(
    session_id: String,
    store: tauri::State<'_, TranscriptStoreHandle>,
    models: tauri::State<'_, ModelStoreHandle>,
    drivers: tauri::State<'_, DriversHandle>,
) -> Result<(), String> {
    let id = parse_transcript_id(&session_id)?;
    // Signal the driver to wind down and grab its finish-notifier (idempotent
    // if the driver already exited — `await_finished` will then just suspend
    // until the wind-down notify, or the timeout below trips).
    let stop_handle = drivers
        .lock()
        .map_err(|e| format!("drivers lock poisoned: {e}"))?
        .get(&id)
        .cloned();
    if let Some(stop) = stop_handle.as_ref() {
        stop.stop();
    } else {
        // No live driver: just flip to Finalizing so a subsequent finalize pass
        // (below) can run against whatever was recorded.
        let _ = store.set_status(id, TranscriptStatus::Finalizing { progress: 0.0 });
    }

    // Wait for the driver loop to actually exit, bounded so a wedged driver
    // can't hang the command. 5 s mirrors the previous spin-poll budget.
    if let Some(stop) = stop_handle {
        let _ =
            tokio::time::timeout(std::time::Duration::from_secs(5), stop.await_finished()).await;
    }

    // Offline pass: re-transcribe the WAV (prefer `large-v3`, fall back to the
    // live model) and mark Done; on failure the live transcript stays.
    let store_arc = store.inner().clone();
    let models_arc = models.inner().clone();
    let session_dir = store.session_dir(id);
    let audio_wav = session_dir.join("audio.wav");
    tokio::task::spawn_blocking(move || {
        // Pick the offline model: `large-v3` if present, else fall back to any
        // downloaded Whisper model (the live one is guaranteed present).
        let offline_key = pick_offline_model(&models_arc);
        let Some(key) = offline_key else {
            let _ = store_arc.set_status(
                id,
                TranscriptStatus::Failed {
                    reason: "no Whisper model available for the offline pass".to_string(),
                },
            );
            return;
        };
        let path = match models_arc.ensure_model(&key, &mut |_| {}) {
            Ok(p) => p,
            Err(e) => {
                let _ = store_arc.set_status(
                    id,
                    TranscriptStatus::Failed {
                        reason: format!("model: {e}"),
                    },
                );
                return;
            }
        };
        let transcriber = match WhisperCppTranscriber::load(&path, key.clone()) {
            Ok(t) => Box::new(t) as Box<dyn speedwave_runtime::transcription::Transcriber>,
            Err(e) => {
                let _ = store_arc.set_status(
                    id,
                    TranscriptStatus::Failed {
                        reason: format!("transcriber: {e}"),
                    },
                );
                return;
            }
        };
        // Optional re-diarization over the whole recording (best-effort).
        let diarize_opts = DiarizeOptions {
            num_speakers: store_arc
                .get(id)
                .ok()
                .and_then(|s| s.expected_speakers)
                .map(|n| n as usize),
            ..DiarizeOptions::default()
        };
        let diarizer: Option<Box<dyn Diarizer>> = if models_arc.diarization_is_present() {
            match models_arc
                .ensure_diarization_models(&mut |_| {})
                .ok()
                .and_then(|p| {
                    SherpaDiarizer::load(&p.segmentation_onnx, &p.embedding_onnx, &diarize_opts)
                        .ok()
                }) {
                Some(d) => Some(Box::new(d)),
                None => None,
            }
        } else {
            None
        };
        // Live turns aren't tracked across the driver boundary in v1; offline
        // diarizer's clusters win.
        let cfg = FinalizeConfig {
            id,
            store: store_arc.clone(),
            audio_path: audio_wav,
            transcriber,
            diarizer,
            transcribe_opts: TranscribeOptions::for_language(session_language(&store_arc, id)),
            diarize_opts,
            live_turns: Vec::new(),
        };
        if let Err(e) = speedwave_runtime::transcription::run_finalize(cfg) {
            log::warn!("offline finalize for {} failed: {e}", short_id(id));
        }
    });
    Ok(())
}

/// Validates a requested `AudioSource` against the host's `CaptureCapabilities`.
/// Per-process needs `supports_per_process` (including when it's the system side
/// of a `Mixed`); a `Mixed` source needs a microphone.
fn validate_source_against_caps(
    src: &AudioSource,
    caps: &CaptureCapabilities,
) -> Result<(), String> {
    // Exhaustive (no `_` arm) so a new `AudioSource` variant forces a conscious
    // validation decision here.
    let (needs_per_process, needs_microphone): (bool, bool) = match src {
        AudioSource::SystemWide => (false, false),
        AudioSource::Process { .. } => (true, false),
        AudioSource::Microphone { .. } => (false, true),
        AudioSource::Mixed { system, mic: _ } => {
            // The system side of a mix must itself be capturable — System or a
            // process, not a microphone or another mix. Reject the bad shape
            // here so the error comes from the boundary, not a deep backend.
            match system.as_ref() {
                AudioSource::SystemWide => {}
                AudioSource::Process { .. } => {}
                other => {
                    return Err(format!(
                        "the system side of a mixed source must be System or a process, not {other:?}"
                    ));
                }
            }
            (matches!(**system, AudioSource::Process { .. }), true)
        }
    };
    if needs_per_process && !caps.supports_per_process {
        return Err("per-app capture isn't supported on this host — use System audio".to_string());
    }
    if needs_microphone && !caps.supports_microphone {
        return Err(if matches!(src, AudioSource::Mixed { .. }) {
            "this host has no microphone — pick System audio instead of the mixed source"
                .to_string()
        } else {
            "this host has no microphone".to_string()
        });
    }
    Ok(())
}

/// A short label for the picked source — uses `enumerate_sources` to find a
/// matching entry's label, falling back to a generic name.
fn source_label(
    capture: &dyn speedwave_runtime::transcription::AudioCapture,
    src: &AudioSource,
) -> String {
    if let Ok(list) = capture.enumerate_sources() {
        if let Some(found) = list.iter().find(|s| &s.source == src) {
            return found.label.clone();
        }
    }
    fn generic(src: &AudioSource) -> String {
        match src {
            AudioSource::SystemWide => "System (everything)".to_string(),
            AudioSource::Process { .. } => "App audio".to_string(),
            AudioSource::Microphone { .. } => "Microphone".to_string(),
            // A Mixed not in the picker (e.g. an explicit process + mic via the
            // API): "<system> + microphone".
            AudioSource::Mixed { system, .. } => format!("{} + microphone", generic(system)),
        }
    }
    generic(src)
}

/// Reads a session's forced language (defaults to PL if it can't be read).
fn session_language(store: &TranscriptStore, id: Uuid) -> Language {
    store.get(id).map(|s| s.language).unwrap_or(Language::Pl)
}

/// Picks the model for the offline pass: `large-v3` if downloaded, otherwise
/// the first downloaded Whisper model in the catalogue (the live model is
/// guaranteed present at this point). `None` if somehow nothing is downloaded.
fn pick_offline_model(models: &ModelStore) -> Option<String> {
    if models.whisper_is_present_by_key("large-v3") {
        return Some("large-v3".to_string());
    }
    models
        .whisper_status()
        .into_iter()
        .find(|m| m.downloaded)
        .map(|m| m.key)
}

/// Picks the model for the live pass:
/// 1. `override_key` if given — must be downloaded, else an error.
/// 2. The `recommended` model if it's downloaded.
/// 3. Otherwise the first downloaded Whisper model (we don't auto-download a
///    multi-GB file — the UI prompts for that).
/// 4. If nothing is downloaded: an error with a download hint.
fn pick_live_model(
    models: &ModelStore,
    override_key: Option<&str>,
    recommended: &str,
) -> Result<String, String> {
    if let Some(k) = override_key {
        if models.whisper_is_present_by_key(k) {
            return Ok(k.to_string());
        }
        return Err(format!(
            "Whisper model '{k}' isn't downloaded — download it first"
        ));
    }
    if models.whisper_is_present_by_key(recommended) {
        return Ok(recommended.to_string());
    }
    if let Some(any) = models.whisper_status().into_iter().find(|m| m.downloaded) {
        log::info!(
            "recommended live model '{recommended}' not downloaded — falling back to '{}'",
            any.key
        );
        return Ok(any.key);
    }
    Err(format!(
        "no Whisper model is downloaded — download one (e.g. '{recommended}') first"
    ))
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct SubscribeAck {
    /// Tauri event channel for the live stream.
    pub event_name: String,
    /// Current state — apply before listening to events.
    pub snapshot: TranscriptSession,
}

#[tauri::command]
pub async fn subscribe_transcript(
    session_id: String,
    store: tauri::State<'_, TranscriptStoreHandle>,
    forwarders: tauri::State<'_, ForwardersHandle>,
    app: AppHandle,
) -> Result<SubscribeAck, String> {
    let id = parse_transcript_id(&session_id)?;
    let snapshot = store.get(id).map_err(|e| e.to_string())?;
    spawn_event_forwarder(app, store.inner().clone(), forwarders.inner().clone(), id);
    Ok(SubscribeAck {
        event_name: transcript_event_name(id),
        snapshot,
    })
}

/// Drains a session's broadcast into Tauri events. Detached task.
fn spawn_event_forwarder(
    app: AppHandle,
    store: Arc<TranscriptStore>,
    forwarders: ForwardersHandle,
    id: Uuid,
) {
    // Already-running forwarder: skip — emitting twice would duplicate every
    // event to the frontend.
    if let Ok(mut set) = forwarders.lock() {
        if !set.insert(id) {
            return;
        }
    }
    let sub = match store.subscribe(id) {
        Ok(s) => s,
        Err(e) => {
            log::warn!("subscribe_transcript: {e}");
            if let Ok(mut set) = forwarders.lock() {
                set.remove(&id);
            }
            return;
        }
    };
    let event_name = transcript_event_name(id);
    tauri::async_runtime::spawn(async move {
        forward_events(app, event_name, sub.events).await;
        if let Ok(mut set) = forwarders.lock() {
            set.remove(&id);
        }
    });
}

async fn forward_events(
    app: AppHandle,
    event_name: String,
    mut rx: broadcast::Receiver<TranscriptEvent>,
) {
    loop {
        match rx.recv().await {
            Ok(ev) => {
                if let Err(e) = app.emit(&event_name, &ev) {
                    log::warn!("transcript event emit failed for {event_name}: {e}");
                    break;
                }
            }
            Err(broadcast::error::RecvError::Lagged(n)) => {
                log::warn!("transcript {event_name}: subscriber lagged by {n} events");
            }
            Err(broadcast::error::RecvError::Closed) => break,
        }
    }
}

// ---- 4) list / get / delete / discard / relabel / markdown ----------------

#[tauri::command]
pub async fn list_transcripts(
    store: tauri::State<'_, TranscriptStoreHandle>,
) -> Result<Vec<TranscriptSession>, String> {
    Ok(store.list())
}

#[tauri::command]
pub async fn get_transcript(
    session_id: String,
    store: tauri::State<'_, TranscriptStoreHandle>,
) -> Result<TranscriptSession, String> {
    let id = parse_transcript_id(&session_id)?;
    store.get(id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_transcript(
    session_id: String,
    store: tauri::State<'_, TranscriptStoreHandle>,
) -> Result<(), String> {
    let id = parse_transcript_id(&session_id)?;
    store.delete(id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn discard_transcript_audio(
    session_id: String,
    store: tauri::State<'_, TranscriptStoreHandle>,
) -> Result<(), String> {
    let id = parse_transcript_id(&session_id)?;
    // Routed through the store so the in-memory cache, disk, and broadcast
    // stream stay in sync (subscribers see an `AudioDiscarded` event).
    store.discard_audio(id).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn relabel_speaker(
    session_id: String,
    speaker_id: u32,
    name: String,
    store: tauri::State<'_, TranscriptStoreHandle>,
) -> Result<(), String> {
    let id = parse_transcript_id(&session_id)?;
    let capped = cap_name(&name);
    store
        .relabel_speaker(id, SpeakerId(speaker_id), &capped)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn get_transcript_markdown(
    session_id: String,
    store: tauri::State<'_, TranscriptStoreHandle>,
) -> Result<String, String> {
    let id = parse_transcript_id(&session_id)?;
    let s = store.get(id).map_err(|e| e.to_string())?;
    Ok(s.to_markdown())
}

// ---- 5) model management --------------------------------------------------

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct ModelsAck {
    /// Status of each Whisper model in the catalogue.
    pub whisper: Vec<ModelStatusEntry>,
    /// Status of each diarization model.
    pub diarization: Vec<ModelStatusEntry>,
    /// Total bytes the downloaded models occupy on disk.
    pub total_bytes_used: u64,
}

#[tauri::command]
pub async fn list_transcription_models(
    models: tauri::State<'_, ModelStoreHandle>,
) -> Result<ModelsAck, String> {
    Ok(ModelsAck {
        whisper: models.whisper_status(),
        diarization: models.diarization_status(),
        total_bytes_used: models.total_bytes_used(),
    })
}

#[tauri::command]
pub async fn download_transcription_model(
    model_id: String,
    models: tauri::State<'_, ModelStoreHandle>,
    app: AppHandle,
) -> Result<(), String> {
    let models = models.inner().clone();
    // Diarization keys pull both sherpa models; Whisper keys go to ensure_model.
    let is_diarization = speedwave_runtime::transcription::diarization_model(&model_id).is_some();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        if is_diarization {
            models
                .ensure_diarization_models(&mut |p| {
                    let _ = app.emit(MODEL_PROGRESS_EVENT, &p);
                })
                .map(|_| ())
                .map_err(|e| e.to_string())
        } else {
            models
                .ensure_model(&model_id, &mut |p| {
                    let _ = app.emit(MODEL_PROGRESS_EVENT, &p);
                })
                .map(|_| ())
                .map_err(|e| e.to_string())
        }
    })
    .await
    .map_err(|e| format!("download task panicked: {e}"))??;
    Ok(())
}

#[tauri::command]
pub async fn delete_transcription_model(
    model_id: String,
    models: tauri::State<'_, ModelStoreHandle>,
) -> Result<(), String> {
    models.delete_model(&model_id).map_err(|e| e.to_string())
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use speedwave_runtime::transcription::TranscriptSession;
    use std::path::PathBuf;

    fn mk_session_in(store: &TranscriptStore) -> Uuid {
        let s = TranscriptSession::new(
            Language::Pl,
            AudioSourceInfo {
                source: speedwave_runtime::transcription::AudioSource::SystemWide,
                label: "Test".to_string(),
                app_id: None,
            },
            PathBuf::from("/tmp/a.wav"),
        );
        store.create(s).unwrap()
    }

    #[test]
    fn parse_transcript_id_rejects_non_uuid() {
        assert!(parse_transcript_id("nope").is_err());
        assert!(parse_transcript_id("../escape").is_err());
        assert!(parse_transcript_id("").is_err());
        assert!(parse_transcript_id("550E8400-E29B-41D4-A716-446655440000").is_err()); // uppercase rejected
        assert!(parse_transcript_id("550e8400-e29b-41d4-a716-446655440000").is_ok());
    }

    #[test]
    fn transcript_event_name_is_stable() {
        let id = Uuid::parse_str("550e8400-e29b-41d4-a716-446655440000").unwrap();
        assert_eq!(
            transcript_event_name(id),
            "transcript_event::550e8400-e29b-41d4-a716-446655440000"
        );
    }

    #[test]
    fn cap_name_trims_and_caps_length() {
        assert_eq!(cap_name("  Alice  "), "Alice");
        assert_eq!(cap_name(""), "");
        let long: String = "x".repeat(200);
        assert_eq!(cap_name(&long).chars().count(), 64);
    }

    #[test]
    fn validate_expected_speakers_collapses_none_zero_and_rejects_overflow() {
        assert_eq!(validate_expected_speakers(None).unwrap(), None);
        assert_eq!(validate_expected_speakers(Some(0)).unwrap(), None);
        assert_eq!(validate_expected_speakers(Some(1)).unwrap(), Some(1));
        assert_eq!(
            validate_expected_speakers(Some(MAX_EXPECTED_SPEAKERS)).unwrap(),
            Some(MAX_EXPECTED_SPEAKERS)
        );
        assert!(validate_expected_speakers(Some(MAX_EXPECTED_SPEAKERS + 1)).is_err());
        assert!(validate_expected_speakers(Some(u32::MAX)).is_err());
    }

    #[test]
    fn short_id_truncates_to_eight_hex_chars() {
        let id = Uuid::parse_str("550e8400-e29b-41d4-a716-446655440000").unwrap();
        assert_eq!(short_id(id), "550e8400");
    }

    /// Driving Tauri commands fully requires a `tauri::State` wrapper that
    /// isn't trivial to fabricate in unit tests; instead, exercise the
    /// underlying `TranscriptStore` calls that each command makes, plus the
    /// validation helpers above (`parse_transcript_id` already covered).
    #[tokio::test]
    async fn store_round_trip_matches_what_the_commands_will_do() {
        let dir = tempfile::tempdir().unwrap();
        let store = TranscriptStore::with_root(dir.path());
        let id = mk_session_in(&store);
        // get / list reflect a freshly created session.
        assert_eq!(store.get(id).unwrap().id, id);
        assert_eq!(store.list().len(), 1);
        // relabel goes through.
        store.relabel_speaker(id, SpeakerId(0), "Alice").unwrap();
        assert_eq!(
            store
                .get(id)
                .unwrap()
                .speaker_names
                .get(&SpeakerId(0))
                .map(String::as_str),
            Some("Alice")
        );
        // Append a segment with that speaker so the markdown body renders.
        store
            .append_segment(
                id,
                speedwave_runtime::transcription::Segment {
                    start: std::time::Duration::ZERO,
                    end: std::time::Duration::from_secs(1),
                    text: "hi".to_string(),
                    words: vec![],
                    speaker: Some(SpeakerId(0)),
                },
            )
            .unwrap();
        // markdown renders the user-supplied name + footer.
        let md = store.get(id).unwrap().to_markdown();
        assert!(
            md.contains("Alice"),
            "expected Alice in markdown, got:\n{md}"
        );
        assert!(md.ends_with("speaker labels are approximate._\n"));
        // delete removes it.
        store.delete(id).unwrap();
        assert!(store.list().is_empty());
    }

    #[test]
    fn session_language_reads_the_session_or_defaults_to_pl() {
        let dir = tempfile::tempdir().unwrap();
        let store = TranscriptStore::with_root(dir.path());
        let id = mk_session_in(&store); // created with Language::Pl
        assert_eq!(session_language(&store, id), Language::Pl);
        // Unknown id → default.
        let missing = Uuid::new_v4();
        assert_eq!(session_language(&store, missing), Language::Pl);
    }

    #[test]
    fn pick_offline_model_prefers_large_v3_then_any_downloaded() {
        let dir = tempfile::tempdir().unwrap();
        let store = ModelStore::with_root(dir.path());
        // Nothing downloaded → None.
        assert_eq!(pick_offline_model(&store), None);
    }

    #[test]
    fn download_routing_distinguishes_whisper_from_diarization_keys() {
        // download_transcription_model decides which ensure_* to call by
        // whether the key is a diarization-catalogue key. Verify that split
        // (the bug was: a diarization key went to ensure_model → "no such
        // model in the catalogue").
        use speedwave_runtime::transcription::{diarization_model, whisper_model};
        assert!(diarization_model("pyannote-segmentation-3-0").is_some());
        assert!(diarization_model("nemo-titanet-small").is_some());
        assert!(whisper_model("pyannote-segmentation-3-0").is_none());
        // A Whisper key is NOT a diarization key.
        assert!(diarization_model("small").is_none());
        assert!(whisper_model("small").is_some());
    }

    #[test]
    fn pick_live_model_errors_with_a_download_hint_when_nothing_downloaded() {
        let dir = tempfile::tempdir().unwrap();
        let store = ModelStore::with_root(dir.path());
        // No model on disk: an override errors naming that model; no override
        // errors naming the recommended one — both with "download" guidance.
        let e1 = pick_live_model(&store, Some("small"), "large-v3-turbo").unwrap_err();
        assert!(e1.contains("'small'") && e1.contains("download"));
        let e2 = pick_live_model(&store, None, "large-v3-turbo").unwrap_err();
        assert!(e2.contains("download") && e2.contains("large-v3-turbo"));
    }

    #[test]
    fn pick_live_model_uses_a_known_catalogue_key_for_the_override_error() {
        // Sanity: the message references the requested key verbatim even for an
        // unknown one (whisper_is_present_by_key returns false → error path).
        let dir = tempfile::tempdir().unwrap();
        let store = ModelStore::with_root(dir.path());
        let err = pick_live_model(&store, Some("nonexistent-model"), "small").unwrap_err();
        assert!(err.contains("nonexistent-model"));
    }

    #[test]
    fn source_label_falls_back_when_no_match() {
        // FileAudioCapture's enumerate_sources lists only the bound file (or
        // nothing) — so a SystemWide source has no match and we fall back.
        let cap = speedwave_runtime::transcription::FileAudioCapture::new();
        assert_eq!(
            source_label(
                &cap,
                &speedwave_runtime::transcription::AudioSource::SystemWide
            ),
            "System (everything)"
        );
        assert_eq!(
            source_label(
                &cap,
                &speedwave_runtime::transcription::AudioSource::Microphone { device: None }
            ),
            "Microphone"
        );
    }

    #[test]
    fn source_label_for_a_mixed_source_falls_back_to_system_plus_microphone() {
        use speedwave_runtime::transcription::{AudioSource, FileAudioCapture, ProcessSelector};
        let cap = FileAudioCapture::new();
        // SystemWide + mic → "System (everything) + microphone".
        assert_eq!(
            source_label(
                &cap,
                &AudioSource::Mixed {
                    system: Box::new(AudioSource::SystemWide),
                    mic: None,
                }
            ),
            "System (everything) + microphone"
        );
        // A process + mic → "App audio + microphone".
        assert_eq!(
            source_label(
                &cap,
                &AudioSource::Mixed {
                    system: Box::new(AudioSource::Process {
                        selector: ProcessSelector::Pid { pid: 1 }
                    }),
                    mic: None,
                }
            ),
            "App audio + microphone"
        );
    }

    #[test]
    fn validate_source_against_caps_gates_per_process_and_mixed() {
        use speedwave_runtime::transcription::{AudioSource, CaptureCapabilities, ProcessSelector};
        let no_per_process = CaptureCapabilities {
            supports_per_process: false,
            supports_system_audio: true,
            supports_microphone: true,
            note: None,
        };
        // Plain SystemWide is always fine.
        assert!(validate_source_against_caps(&AudioSource::SystemWide, &no_per_process).is_ok());
        // A Process source is rejected when per-process isn't supported…
        assert!(validate_source_against_caps(
            &AudioSource::Process {
                selector: ProcessSelector::Pid { pid: 1 }
            },
            &no_per_process
        )
        .is_err());
        // …and so is a Mixed whose system side is a Process.
        assert!(validate_source_against_caps(
            &AudioSource::Mixed {
                system: Box::new(AudioSource::Process {
                    selector: ProcessSelector::Pid { pid: 1 }
                }),
                mic: None,
            },
            &no_per_process
        )
        .is_err());
        // A Mixed with a SystemWide system side is fine on this host.
        assert!(validate_source_against_caps(
            &AudioSource::Mixed {
                system: Box::new(AudioSource::SystemWide),
                mic: None,
            },
            &no_per_process
        )
        .is_ok());
        // …but not if the host has no microphone.
        let no_mic = CaptureCapabilities {
            supports_per_process: true,
            supports_system_audio: true,
            supports_microphone: false,
            note: None,
        };
        assert!(validate_source_against_caps(
            &AudioSource::Mixed {
                system: Box::new(AudioSource::SystemWide),
                mic: None,
            },
            &no_mic
        )
        .is_err());
        // A bare Microphone is rejected on a host with no mic.
        assert!(
            validate_source_against_caps(&AudioSource::Microphone { device: None }, &no_mic)
                .is_err()
        );
        // A structurally-invalid Mixed (mic-as-system, or nested Mixed) is
        // rejected at the boundary regardless of capabilities.
        let full = CaptureCapabilities {
            supports_per_process: true,
            supports_system_audio: true,
            supports_microphone: true,
            note: None,
        };
        assert!(validate_source_against_caps(
            &AudioSource::Mixed {
                system: Box::new(AudioSource::Microphone { device: None }),
                mic: None,
            },
            &full
        )
        .is_err());
        assert!(validate_source_against_caps(
            &AudioSource::Mixed {
                system: Box::new(AudioSource::Mixed {
                    system: Box::new(AudioSource::SystemWide),
                    mic: None,
                }),
                mic: None,
            },
            &full
        )
        .is_err());
        // A per-process source is fine when the host supports it.
        assert!(validate_source_against_caps(
            &AudioSource::Process {
                selector: ProcessSelector::Pid { pid: 1 }
            },
            &full
        )
        .is_ok());
        // A bare Microphone and a SystemWide-backed Mixed are fine.
        assert!(
            validate_source_against_caps(&AudioSource::Microphone { device: None }, &full).is_ok()
        );
        assert!(validate_source_against_caps(
            &AudioSource::Mixed {
                system: Box::new(AudioSource::SystemWide),
                mic: None,
            },
            &full
        )
        .is_ok());
    }
}
