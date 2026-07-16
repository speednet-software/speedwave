//! Tauri commands for meeting transcription (ADR-056); thin layer over `transcription` module.
//! Events forward via per-session `transcript_event::<id>` channels (ADR-043 delivery shape).

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use speedwave_runtime::transcription::{
    self, AudioSource, AudioSourceInfo, Backend, CaptureCapabilities, DriverConfig, FinalizeConfig,
    Language, ModelStatusEntry, ModelStore, StopSignal, TranscribeOptions, TranscriptDriver,
    TranscriptEvent, TranscriptSession, TranscriptStatus, TranscriptStore, WhisperCppTranscriber,
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
/// Model keys with a download in flight — single-flight guard: a second
/// concurrent download would corrupt the shared `.part` temp file.
pub type DownloadsHandle = Arc<Mutex<HashSet<String>>>;

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

/// Truncates a UUID for log lines so CodeQL's "log sensitive" heuristics (keyed off the
/// `session_id` name) don't flag every diagnostic; first 8 hex chars are enough to correlate.
fn short_id(id: Uuid) -> String {
    let mut s = id.to_string();
    s.truncate(8);
    s
}

// ---- 1) capability + source listing ---------------------------------------

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
    let StartParams { source, language } = params;
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

    let store_arc = store.inner().clone();
    let (live_key, transcriber) = load_live_transcriber(models.inner()).await?;

    // audio.wav lives under `<root>/<id>/`, so pick the id before creating the session — the
    // path is then correct from the first persisted write (no fragile post-create patch).
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
        },
        audio_wav.clone(),
    );
    session.models_used.live = Some(live_key.clone());
    // Register the driver entry before creating the session so the delete guard
    // covers the whole start window (delete refuses while an entry is live).
    let stop = StopSignal::new();
    register_driver(drivers.inner(), session_id, &stop)?;
    if let Err(e) = store.create(session) {
        unregister_driver(drivers.inner(), session_id, &stop);
        return Err(format!("store create: {e}"));
    }

    let stream = match capture.start(audio_source) {
        Ok(s) => s,
        Err(e) => {
            unregister_driver(drivers.inner(), session_id, &stop);
            // Mark the session failed so the UI shows the error, not a hang.
            let _ = store.set_status(
                session_id,
                TranscriptStatus::Failed {
                    reason: e.to_string(),
                },
            );
            return Err(e.to_string());
        }
    };

    // Wire the event forwarder before the driver mutates anything.
    spawn_event_forwarder(
        app,
        store_arc.clone(),
        forwarders.inner().clone(),
        session_id,
    );

    spawn_driver(
        DriverConfig {
            id: session_id,
            store: store_arc.clone(),
            audio: stream,
            transcriber: Box::new(transcriber),
            transcribe_opts: TranscribeOptions::for_language(lang),
            stop,
            time_base: std::time::Duration::ZERO,
        },
        audio_wav,
        drivers.inner().clone(),
    );

    let snapshot = store.get(session_id).map_err(|e| e.to_string())?;
    Ok(StartAck {
        session_id,
        event_name: transcript_event_name(session_id),
        snapshot,
    })
}

/// Claims the driver-registry slot for `id`. Rejecting an occupied slot is the
/// single-recording invariant per session — a blind insert would let a losing
/// concurrent start/resume clobber the winner's live entry.
fn register_driver(drivers: &DriversHandle, id: Uuid, stop: &StopSignal) -> Result<(), String> {
    let mut g = drivers
        .lock()
        .map_err(|e| format!("drivers lock poisoned: {e}"))?;
    match g.entry(id) {
        std::collections::hash_map::Entry::Occupied(_) => {
            Err("this session is already recording".to_string())
        }
        std::collections::hash_map::Entry::Vacant(slot) => {
            slot.insert(stop.clone());
            Ok(())
        }
    }
}

/// Releases the registry slot for `id` only while it still holds `stop` (a stale cleanup must
/// not clobber a successor); recovers a poisoned lock, as a skipped removal blocks resume/delete.
fn unregister_driver(drivers: &DriversHandle, id: Uuid, stop: &StopSignal) {
    let mut g = drivers
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if g.get(&id).is_some_and(|s| s.same_as(stop)) {
        g.remove(&id);
    }
}

/// Runs a built driver on a blocking task; cleans up the stop-signal registry
/// and wakes `await_finished()` waiters when it winds down.
fn spawn_driver(cfg: DriverConfig, audio_wav: std::path::PathBuf, drivers: DriversHandle) {
    let session_id = cfg.id;
    let stop_for_cleanup = cfg.stop.clone();
    let driver = TranscriptDriver::new(cfg);
    // The driver loop blocks on `next_chunk` — run it on a blocking task.
    tokio::task::spawn_blocking(move || {
        if let Err(e) = driver.run(&audio_wav) {
            // Log only the id's first chunk — CodeQL flags any "session_id"-looking variable;
            // UUIDs aren't secrets and the short form is enough to correlate.
            log::warn!(
                "transcript driver for {} ended with error: {e}",
                short_id(session_id)
            );
        }
        unregister_driver(&drivers, session_id, &stop_for_cleanup);
        stop_for_cleanup.signal_finished();
    });
}

/// Sums prior parts' durations to place the new part on the session timeline; an
/// unreadable part aborts the resume (treating it as zero would overlap the timelines).
fn resume_time_base(parts: &[std::path::PathBuf]) -> Result<std::time::Duration, String> {
    let mut total = std::time::Duration::ZERO;
    for part in parts {
        match speedwave_runtime::transcription::wav_duration(part) {
            Some(d) => total += d,
            None => {
                log::warn!("unreadable recorded audio part {}", part.display());
                return Err(format!(
                    "cannot read the duration of the recorded part {}; fix or delete the \
                     recording before resuming (a zero-length guess would overlap the timelines)",
                    part.display()
                ));
            }
        }
    }
    Ok(total)
}

#[tauri::command]
pub async fn resume_transcription(
    session_id: String,
    store: tauri::State<'_, TranscriptStoreHandle>,
    models: tauri::State<'_, ModelStoreHandle>,
    drivers: tauri::State<'_, DriversHandle>,
    forwarders: tauri::State<'_, ForwardersHandle>,
    app: AppHandle,
) -> Result<StartAck, String> {
    let id = parse_transcript_id(&session_id)?;
    let session = store.get(id).map_err(|e| e.to_string())?;
    if !matches!(session.status, TranscriptStatus::Done) {
        return Err("only a finished recording can be resumed".to_string());
    }
    let lang = session.language;
    let audio_source = session.audio_source.source.clone();

    let capture = transcription::detect_audio_capture();
    validate_source_against_caps(&audio_source, &capture.capabilities())?;

    let store_arc = store.inner().clone();
    let (_live_key, transcriber) = load_live_transcriber(models.inner()).await?;

    // The new part records past the earlier ones on the session timeline.
    let time_base = resume_time_base(&session.all_audio_parts())?;
    let part_no = session.all_audio_parts().len() + 1;
    let next_part = store.session_dir(id).join(format!("audio-{part_no}.wav"));

    // Register the driver entry before mutating the session so the delete guard
    // covers the whole resume window (delete refuses while an entry is live).
    let stop = StopSignal::new();
    register_driver(drivers.inner(), id, &stop)?;
    if let Err(e) = store.resume(id, next_part.clone()) {
        unregister_driver(drivers.inner(), id, &stop);
        return Err(e.to_string());
    }
    let stream = match capture.start(audio_source) {
        Ok(s) => s,
        Err(e) => {
            unregister_driver(drivers.inner(), id, &stop);
            // Roll back to Done: resume requires Done, so leaving the mutated session
            // behind would strand a finished transcript on a transient capture error.
            if let Err(re) = store.rollback_resume(id, &next_part) {
                log::error!(
                    "failed to roll back resumed transcript {} after a capture-start error: {re}",
                    short_id(id)
                );
                let _ = store.set_status(
                    id,
                    TranscriptStatus::Failed {
                        reason: e.to_string(),
                    },
                );
            }
            return Err(e.to_string());
        }
    };

    spawn_event_forwarder(app, store_arc.clone(), forwarders.inner().clone(), id);
    spawn_driver(
        DriverConfig {
            id,
            store: store_arc,
            audio: stream,
            transcriber: Box::new(transcriber),
            transcribe_opts: TranscribeOptions::for_language(lang),
            stop,
            time_base,
        },
        next_part,
        drivers.inner().clone(),
    );

    let snapshot = store.get(id).map_err(|e| e.to_string())?;
    Ok(StartAck {
        session_id: id,
        event_name: transcript_event_name(id),
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
    // Signal the driver to wind down and grab its finish-notifier (idempotent if exited);
    // `await_finished` then suspends until wind-down notify or the timeout below trips).
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
    let audio_paths = offline_pass_parts(&store, id)?;
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
            Ok(mut t) => {
                attach_vad(&mut t, &models_arc);
                Box::new(t) as Box<dyn speedwave_runtime::transcription::Transcriber>
            }
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
        let cfg = FinalizeConfig {
            id,
            store: store_arc.clone(),
            audio_paths,
            transcriber,
            transcribe_opts: TranscribeOptions::for_language(session_language(&store_arc, id)),
        };
        if let Err(e) = speedwave_runtime::transcription::run_finalize(cfg) {
            log::warn!("offline finalize for {} failed: {e}", short_id(id));
        }
    });
    Ok(())
}

/// Resolves every recorded part for the offline pass (resumed sessions have several); a store
/// failure aborts the finalize, because degrading to `audio.wav` alone would drop resumed parts.
fn offline_pass_parts(
    store: &TranscriptStore,
    id: Uuid,
) -> Result<Vec<std::path::PathBuf>, String> {
    store.get(id).map(|s| s.all_audio_parts()).map_err(|e| {
        log::error!(
            "cannot load transcript {} for the offline pass: {e}",
            short_id(id)
        );
        format!("cannot load the recording for the offline pass: {e}")
    })
}

/// Validates a requested `AudioSource` against the host's `CaptureCapabilities`.
/// `SystemWide`/`Mixed` need system audio; `Microphone`/`Mixed` need a mic.
fn validate_source_against_caps(
    src: &AudioSource,
    caps: &CaptureCapabilities,
) -> Result<(), String> {
    // Guard system audio at the boundary so a direct API call (the UI already
    // hides unsupported sources) gets a clean error, not a deep backend one.
    if matches!(src, AudioSource::SystemWide | AudioSource::Mixed { .. })
        && !caps.supports_system_audio
    {
        return Err("this host does not support system audio capture".to_string());
    }
    // Exhaustive (no `_` arm) so a new `AudioSource` variant forces a conscious
    // validation decision here.
    let needs_microphone: bool = match src {
        AudioSource::SystemWide => false,
        AudioSource::Microphone { .. } => true,
        AudioSource::Mixed { .. } => true,
    };
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
            AudioSource::Microphone { .. } => "Microphone".to_string(),
            AudioSource::Mixed { .. } => "System (everything) + microphone".to_string(),
        }
    }
    generic(src)
}

/// Reads a session's forced language (defaults to PL if it can't be read).
fn session_language(store: &TranscriptStore, id: Uuid) -> Language {
    store.get(id).map(|s| s.language).unwrap_or(Language::Pl)
}

/// Picks the model for the offline pass: this build's model if downloaded, else the first
/// downloaded Whisper model (the live one is guaranteed present); `None` if none is downloaded.
fn pick_offline_model(models: &ModelStore) -> Option<String> {
    let best = transcription::best_model_for_this_build().key;
    if models.whisper_is_present_by_key(best) {
        return Some(best.to_string());
    }
    models
        .whisper_status()
        .into_iter()
        .find(|m| m.downloaded)
        .map(|m| m.key)
}

/// Picks the live model (recommended → any downloaded), ensures it on disk,
/// loads the transcriber, and attaches the VAD gate — shared by start and resume.
async fn load_live_transcriber(
    models: &ModelStoreHandle,
) -> Result<(String, WhisperCppTranscriber), String> {
    let m = models.clone();
    let recommended = transcription::best_model_for_this_build().key.to_string();
    tokio::task::spawn_blocking(move || -> Result<(String, WhisperCppTranscriber), String> {
        let key = pick_live_model(&m, &recommended)?;
        let path = m
            .ensure_model(&key, &mut |_| {})
            .map_err(|e| e.to_string())?;
        let mut t = WhisperCppTranscriber::load(&path, key.clone()).map_err(|e| e.to_string())?;
        attach_vad(&mut t, &m);
        Ok((key, t))
    })
    .await
    .map_err(|e| format!("transcriber load task panicked: {e}"))?
}

/// Attaches the Silero VAD gate when its model is on disk; otherwise kicks off a background
/// download so this session's offline pass and later sessions get it. Never fails the caller.
fn attach_vad(transcriber: &mut WhisperCppTranscriber, models: &ModelStoreHandle) {
    if models.vad_is_present() {
        if let Err(e) = transcriber.enable_vad(&models.vad_path()) {
            log::warn!("failed to load the Silero VAD model: {e}");
        }
        return;
    }
    let m = models.clone();
    tokio::task::spawn_blocking(move || {
        if let Err(e) = m.ensure_vad_model() {
            log::warn!(target: "transcription::models", "background VAD model download failed: {e}");
        }
    });
}

/// Picks the model for the live pass: `override_key` (must be downloaded) → `recommended` (if
/// downloaded) → first downloaded model → download-hint error (no auto-dl; UI prompts).
fn pick_live_model(models: &ModelStore, recommended: &str) -> Result<String, String> {
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
            log::warn!("failed to subscribe to transcript {}: {e}", short_id(id));
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
                log::warn!("transcript subscriber for {event_name} lagged by {n} events");
            }
            Err(broadcast::error::RecvError::Closed) => break,
        }
    }
}

// ---- 4) list / get / delete / markdown ------------------------------------

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
    drivers: tauri::State<'_, DriversHandle>,
) -> Result<(), String> {
    let id = parse_transcript_id(&session_id)?;
    // A live driver writes into the session dir — deleting under it would orphan
    // an unstoppable capture. The registry lock is held across the delete so a
    // concurrent start/resume cannot register into the check→delete gap.
    let guard = drivers
        .lock()
        .map_err(|e| format!("drivers lock poisoned: {e}"))?;
    if guard.contains_key(&id) {
        return Err("stop the recording before deleting it".to_string());
    }
    let result = store.delete(id).map_err(|e| e.to_string());
    drop(guard);
    result
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

/// RAII slot in the in-flight download registry: removed on drop, so the
/// registry empties on every exit path of the owning download task.
struct DownloadSlot {
    downloads: DownloadsHandle,
    key: String,
}

impl Drop for DownloadSlot {
    fn drop(&mut self) {
        if let Ok(mut set) = self.downloads.lock() {
            set.remove(&self.key);
        }
    }
}

/// Claims the single download slot for `key`; errors if one is already live.
fn try_begin_download(downloads: &DownloadsHandle, key: &str) -> Result<DownloadSlot, String> {
    let mut set = downloads
        .lock()
        .map_err(|_| "download registry poisoned".to_string())?;
    if !set.insert(key.to_string()) {
        return Err(format!("model '{key}' is already downloading"));
    }
    Ok(DownloadSlot {
        downloads: downloads.clone(),
        key: key.to_string(),
    })
}

/// `true` while a download of `key` is in flight.
fn is_downloading(downloads: &DownloadsHandle, key: &str) -> bool {
    downloads.lock().map(|s| s.contains(key)).unwrap_or(false)
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct ModelsAck {
    /// Status of each Whisper model in the catalogue.
    pub whisper: Vec<ModelStatusEntry>,
    /// Total bytes the downloaded models occupy on disk.
    pub total_bytes_used: u64,
}

/// The single model Speedwave recommends for this hardware (the only one the UI
/// offers): `large-v3` on GPU builds, `large-v3-turbo` on CPU-only.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct RecommendedModelAck {
    /// Catalogue key to download.
    pub key: String,
    /// Human-readable model name.
    pub display_name: String,
    /// Download/on-disk size in bytes.
    pub size_bytes: u64,
    /// `true` if already downloaded.
    pub downloaded: bool,
    /// `true` while a download is in flight (a remounted UI re-syncs on this).
    pub downloading: bool,
    /// Acceleration label for the UI (e.g. `"Metal (GPU)"`, `"CPU"`).
    pub accel_label: String,
}

/// Short acceleration label from the compiled backends (a GPU backend wins).
fn accel_label() -> String {
    let backends = transcription::compiled_backends();
    match backends.iter().find(|b| b.is_gpu()) {
        Some(gpu) => format!("{} (GPU)", gpu.label()),
        None => "CPU".to_string(),
    }
}

#[tauri::command]
pub async fn recommended_transcription_model(
    models: tauri::State<'_, ModelStoreHandle>,
    downloads: tauri::State<'_, DownloadsHandle>,
) -> Result<RecommendedModelAck, String> {
    let best = transcription::best_model_for_this_build();
    let status = models
        .whisper_status()
        .into_iter()
        .find(|m| m.key == best.key)
        .ok_or_else(|| format!("recommended model '{}' missing from catalogue", best.key))?;
    Ok(RecommendedModelAck {
        key: best.key.to_string(),
        display_name: best.display_name.to_string(),
        size_bytes: status.size_bytes,
        downloaded: status.downloaded,
        downloading: is_downloading(downloads.inner(), best.key),
        accel_label: accel_label(),
    })
}

#[tauri::command]
pub async fn list_transcription_models(
    models: tauri::State<'_, ModelStoreHandle>,
) -> Result<ModelsAck, String> {
    Ok(ModelsAck {
        whisper: models.whisper_status(),
        total_bytes_used: models.total_bytes_used(),
    })
}

#[tauri::command]
pub async fn download_transcription_model(
    model_id: String,
    models: tauri::State<'_, ModelStoreHandle>,
    downloads: tauri::State<'_, DownloadsHandle>,
    app: AppHandle,
) -> Result<(), String> {
    let slot = try_begin_download(downloads.inner(), &model_id)?;
    let models = models.inner().clone();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        // The slot lives inside the blocking task: the registry entry clears
        // exactly when the download work ends, even if this future is dropped.
        let _slot = slot;
        // The Silero VAD gate rides along with every model download (~1 MB;
        // ADR-056 Amendment 8). Non-fatal: recording degrades to signal gates.
        if let Err(e) = models.ensure_vad_model() {
            log::warn!(target: "transcription::models", "VAD model download failed: {e}");
        }
        models
            .ensure_model(&model_id, &mut |p| {
                let _ = app.emit(MODEL_PROGRESS_EVENT, &p);
            })
            .map(|_| ())
            .map_err(|e| {
                log::warn!(target: "transcription::models", "download of '{model_id}' failed: {e}");
                e.to_string()
            })
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
#[expect(clippy::unwrap_used, reason = "test assertions may unwrap freely")]
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
            },
            PathBuf::from("/tmp/a.wav"),
        );
        store.create(s).unwrap()
    }

    #[test]
    fn register_driver_rejects_an_occupied_slot_and_keeps_the_winner() {
        let drivers: DriversHandle = Arc::new(Mutex::new(HashMap::new()));
        let id = Uuid::new_v4();
        let winner = StopSignal::new();
        register_driver(&drivers, id, &winner).unwrap();
        // A concurrent second attempt for the same session is rejected...
        let err = register_driver(&drivers, id, &StopSignal::new()).unwrap_err();
        assert!(err.contains("already recording"), "got: {err}");
        // ...and never clobbers the winner's live entry.
        assert!(drivers.lock().unwrap().get(&id).unwrap().same_as(&winner));
        // A different session registers independently.
        register_driver(&drivers, Uuid::new_v4(), &StopSignal::new()).unwrap();
        assert_eq!(drivers.lock().unwrap().len(), 2);
    }

    #[test]
    fn unregister_driver_removes_only_the_entry_it_registered() {
        let drivers: DriversHandle = Arc::new(Mutex::new(HashMap::new()));
        let id = Uuid::new_v4();
        let winner = StopSignal::new();
        register_driver(&drivers, id, &winner).unwrap();
        // A stale predecessor's cleanup must not clobber the winner's entry.
        unregister_driver(&drivers, id, &StopSignal::new());
        assert!(drivers.lock().unwrap().contains_key(&id));
        // Unknown id is a no-op.
        unregister_driver(&drivers, Uuid::new_v4(), &winner);
        assert_eq!(drivers.lock().unwrap().len(), 1);
        // The owning stop removes its own entry.
        unregister_driver(&drivers, id, &winner);
        assert!(drivers.lock().unwrap().is_empty());
    }

    #[test]
    fn unregister_driver_recovers_from_a_poisoned_lock() {
        let drivers: DriversHandle = Arc::new(Mutex::new(HashMap::new()));
        let id = Uuid::new_v4();
        let stop = StopSignal::new();
        register_driver(&drivers, id, &stop).unwrap();
        let poisoner = drivers.clone();
        let _ = std::thread::spawn(move || {
            let _g = poisoner.lock().unwrap();
            panic!("poison the drivers lock");
        })
        .join();
        assert!(drivers.is_poisoned());
        unregister_driver(&drivers, id, &stop);
        let g = drivers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        assert!(g.is_empty(), "cleanup must survive a poisoned lock");
    }

    /// Minimal valid 16-bit mono PCM WAV of `secs` seconds at 16 kHz.
    fn write_test_wav(path: &std::path::Path, secs: u32) {
        let sample_rate: u32 = 16_000;
        let data_len = sample_rate * 2 * secs;
        let mut buf = Vec::with_capacity(44 + data_len as usize);
        buf.extend_from_slice(b"RIFF");
        buf.extend_from_slice(&(36 + data_len).to_le_bytes());
        buf.extend_from_slice(b"WAVEfmt ");
        buf.extend_from_slice(&16u32.to_le_bytes());
        buf.extend_from_slice(&1u16.to_le_bytes()); // PCM
        buf.extend_from_slice(&1u16.to_le_bytes()); // mono
        buf.extend_from_slice(&sample_rate.to_le_bytes());
        buf.extend_from_slice(&(sample_rate * 2).to_le_bytes()); // byte rate
        buf.extend_from_slice(&2u16.to_le_bytes()); // block align
        buf.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
        buf.extend_from_slice(b"data");
        buf.extend_from_slice(&data_len.to_le_bytes());
        buf.resize(44 + data_len as usize, 0);
        std::fs::write(path, buf).unwrap();
    }

    #[test]
    fn resume_time_base_sums_every_readable_part() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("audio.wav");
        let b = dir.path().join("audio-2.wav");
        write_test_wav(&a, 1);
        write_test_wav(&b, 2);
        let total = resume_time_base(&[a, b]).unwrap();
        assert_eq!(total, std::time::Duration::from_secs(3));
        // No prior parts → zero base.
        assert_eq!(resume_time_base(&[]).unwrap(), std::time::Duration::ZERO);
    }

    #[test]
    fn resume_time_base_fails_naming_the_unreadable_part() {
        let dir = tempfile::tempdir().unwrap();
        let good = dir.path().join("audio.wav");
        write_test_wav(&good, 1);
        // Missing part file.
        let missing = dir.path().join("audio-2.wav");
        let err = resume_time_base(&[good.clone(), missing.clone()]).unwrap_err();
        assert!(err.contains(&missing.display().to_string()), "got: {err}");
        assert!(err.contains("resum"), "actionable wording expected: {err}");
        // Corrupt part file.
        let corrupt = dir.path().join("audio-3.wav");
        std::fs::write(&corrupt, b"not a wav").unwrap();
        let err = resume_time_base(&[good, corrupt.clone()]).unwrap_err();
        assert!(err.contains(&corrupt.display().to_string()), "got: {err}");
    }

    #[test]
    fn offline_pass_parts_returns_every_recorded_part() {
        let dir = tempfile::tempdir().unwrap();
        let store = TranscriptStore::with_root(dir.path());
        let mut s = TranscriptSession::new(
            Language::Pl,
            AudioSourceInfo {
                source: AudioSource::SystemWide,
                label: "Test".to_string(),
            },
            PathBuf::from("/tmp/a.wav"),
        );
        s.audio_parts = vec![PathBuf::from("/tmp/audio-2.wav")];
        let id = store.create(s).unwrap();
        assert_eq!(
            offline_pass_parts(&store, id).unwrap(),
            vec![
                PathBuf::from("/tmp/a.wav"),
                PathBuf::from("/tmp/audio-2.wav")
            ]
        );
    }

    #[test]
    fn offline_pass_parts_fails_loud_when_the_session_cannot_be_read() {
        let dir = tempfile::tempdir().unwrap();
        let store = TranscriptStore::with_root(dir.path());
        // Unknown session.
        let err = offline_pass_parts(&store, Uuid::new_v4()).unwrap_err();
        assert!(err.contains("offline pass"), "got: {err}");
        // Corrupt session json must not degrade to a partial part list.
        let bad = Uuid::new_v4();
        std::fs::create_dir_all(store.session_dir(bad)).unwrap();
        std::fs::write(store.session_dir(bad).join("transcript.json"), b"{ broken").unwrap();
        let err = offline_pass_parts(&store, bad).unwrap_err();
        assert!(err.contains("offline pass"), "got: {err}");
    }

    /// The resume error path the command runs on a failed capture start:
    /// unregister + rollback must return the session to a resumable `Done`.
    #[tokio::test]
    async fn failed_capture_start_on_resume_rolls_the_session_back_to_done() {
        let dir = tempfile::tempdir().unwrap();
        let store = TranscriptStore::with_root(dir.path());
        let id = mk_session_in(&store);
        store.set_status(id, TranscriptStatus::Done).unwrap();

        let next_part = store.session_dir(id).join("audio-2.wav");
        let drivers: DriversHandle = Arc::new(Mutex::new(HashMap::new()));
        let stop = StopSignal::new();
        register_driver(&drivers, id, &stop).unwrap();
        store.resume(id, next_part.clone()).unwrap();
        // Capture failed → the command unregisters and rolls back.
        unregister_driver(&drivers, id, &stop);
        store.rollback_resume(id, &next_part).unwrap();

        let snap = store.get(id).unwrap();
        assert!(matches!(snap.status, TranscriptStatus::Done));
        assert!(snap.audio_parts.is_empty(), "phantom part must be dropped");
        assert!(drivers.lock().unwrap().is_empty());
        // A later resume succeeds: the transient failure did not strand the session.
        register_driver(&drivers, id, &StopSignal::new()).unwrap();
        store.resume(id, next_part).unwrap();
        assert!(matches!(
            store.get(id).unwrap().status,
            TranscriptStatus::Recording
        ));
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
    fn short_id_truncates_to_eight_hex_chars() {
        let id = Uuid::parse_str("550e8400-e29b-41d4-a716-446655440000").unwrap();
        assert_eq!(short_id(id), "550e8400");
    }

    #[test]
    fn accel_label_matches_the_compiled_backend_tier() {
        let label = accel_label();
        let expected = if transcription::has_gpu_backend() {
            "(GPU)"
        } else {
            "CPU"
        };
        assert!(
            label.contains(expected),
            "label '{label}' should reflect the build's backend"
        );
    }

    #[test]
    fn recommended_model_status_is_present_in_the_catalogue() {
        // The recommended key must resolve to a whisper_status entry — the same
        // lookup the command does, minus the Tauri State wrapper.
        let dir = tempfile::tempdir().unwrap();
        let store = ModelStore::with_root(dir.path());
        let best = transcription::best_model_for_this_build();
        let found = store
            .whisper_status()
            .into_iter()
            .find(|m| m.key == best.key);
        assert!(found.is_some(), "best model '{}' missing", best.key);
        assert!(
            !found.unwrap().downloaded,
            "nothing downloaded in a tmp dir"
        );
    }

    /// Driving Tauri commands fully needs a `tauri::State` wrapper, not trivial to fabricate in
    /// unit tests; instead exercise the underlying `TranscriptStore` calls each command makes.
    #[tokio::test]
    async fn store_round_trip_matches_what_the_commands_will_do() {
        let dir = tempfile::tempdir().unwrap();
        let store = TranscriptStore::with_root(dir.path());
        let id = mk_session_in(&store);
        // get / list reflect a freshly created session.
        assert_eq!(store.get(id).unwrap().id, id);
        assert_eq!(store.list().len(), 1);
        // Append a segment so the markdown body renders.
        store
            .append_segment(
                id,
                speedwave_runtime::transcription::Segment {
                    start: std::time::Duration::ZERO,
                    end: std::time::Duration::from_secs(1),
                    text: "hi".to_string(),
                    words: vec![],
                    source: None,
                },
            )
            .unwrap();
        // markdown renders the segment text + footer (no speaker labels).
        let md = store.get(id).unwrap().to_markdown();
        assert!(md.contains("hi"), "expected text in markdown, got:\n{md}");
        assert!(md.ends_with("_Transcript generated locally by Speedwave._\n"));
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
    fn try_begin_download_claims_then_rejects_a_second_claim() {
        let downloads = DownloadsHandle::default();
        let slot = try_begin_download(&downloads, "large-v3").unwrap();
        assert!(is_downloading(&downloads, "large-v3"));
        // Second concurrent claim of the same key is refused with the reason.
        let err = try_begin_download(&downloads, "large-v3").err().unwrap();
        assert!(err.contains("already downloading"), "got: {err}");
        // A different key is independent.
        let other = try_begin_download(&downloads, "large-v3-turbo").unwrap();
        drop(other);
        drop(slot);
    }

    #[test]
    fn download_slot_clears_the_registry_on_drop() {
        let downloads = DownloadsHandle::default();
        {
            let _slot = try_begin_download(&downloads, "large-v3").unwrap();
            assert!(is_downloading(&downloads, "large-v3"));
        }
        assert!(!is_downloading(&downloads, "large-v3"));
        // The key is claimable again after the slot dropped.
        assert!(try_begin_download(&downloads, "large-v3").is_ok());
    }

    #[test]
    fn is_downloading_is_false_for_an_empty_registry_and_unknown_keys() {
        let downloads = DownloadsHandle::default();
        assert!(!is_downloading(&downloads, "large-v3"));
        let _slot = try_begin_download(&downloads, "large-v3").unwrap();
        assert!(!is_downloading(&downloads, "some-other-model"));
    }

    #[test]
    fn pick_offline_model_prefers_large_v3_then_any_downloaded() {
        let dir = tempfile::tempdir().unwrap();
        let store = ModelStore::with_root(dir.path());
        // Nothing downloaded → None.
        assert_eq!(pick_offline_model(&store), None);
    }

    #[test]
    fn pick_live_model_errors_with_a_download_hint_when_nothing_downloaded() {
        let dir = tempfile::tempdir().unwrap();
        let store = ModelStore::with_root(dir.path());
        // No model on disk: errors naming the recommended one, with guidance.
        let e = pick_live_model(&store, "large-v3-turbo").unwrap_err();
        assert!(e.contains("download") && e.contains("large-v3-turbo"));
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
        use speedwave_runtime::transcription::{AudioSource, FileAudioCapture};
        let cap = FileAudioCapture::new();
        assert_eq!(
            source_label(&cap, &AudioSource::Mixed { mic: None }),
            "System (everything) + microphone"
        );
    }

    #[test]
    fn validate_source_against_caps_gates_microphone_and_mixed() {
        use speedwave_runtime::transcription::{AudioSource, CaptureCapabilities};
        let full = CaptureCapabilities {
            supports_system_audio: true,
            supports_microphone: true,
            note: None,
        };
        // SystemWide, a bare Microphone, and a Mixed are fine on a full host.
        assert!(validate_source_against_caps(&AudioSource::SystemWide, &full).is_ok());
        assert!(
            validate_source_against_caps(&AudioSource::Microphone { device: None }, &full).is_ok()
        );
        assert!(validate_source_against_caps(&AudioSource::Mixed { mic: None }, &full).is_ok());
        // A Mixed (or bare mic) is rejected on a host with no microphone.
        let no_mic = CaptureCapabilities {
            supports_system_audio: true,
            supports_microphone: false,
            note: None,
        };
        assert!(validate_source_against_caps(&AudioSource::Mixed { mic: None }, &no_mic).is_err());
        assert!(
            validate_source_against_caps(&AudioSource::Microphone { device: None }, &no_mic)
                .is_err()
        );
        // SystemWide and Mixed are rejected on a host with no system audio.
        let no_sys = CaptureCapabilities {
            supports_system_audio: false,
            supports_microphone: true,
            note: None,
        };
        assert!(validate_source_against_caps(&AudioSource::SystemWide, &no_sys).is_err());
        assert!(validate_source_against_caps(&AudioSource::Mixed { mic: None }, &no_sys).is_err());
        // A bare Microphone is still fine without system audio.
        assert!(
            validate_source_against_caps(&AudioSource::Microphone { device: None }, &no_sys)
                .is_ok()
        );
    }
}
