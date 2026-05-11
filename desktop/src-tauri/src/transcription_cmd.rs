//! Tauri commands for the meeting-transcription feature (ADR-056 Phase 2).
//!
//! Thin layer over `speedwave_runtime::transcription`: stores live in Tauri
//! managed state; events forwarded via per-session `transcript_event::<id>`
//! Tauri event channels (subscribe returns `{event_name, snapshot}` so a late
//! subscriber doesn't miss what already happened — ADR-043 delivery shape).

use std::sync::Arc;

use serde::Serialize;
use speedwave_runtime::transcription::{
    self, AudioSourceInfo, Backend, CaptureCapabilities, Language, ModelStatusEntry, ModelStore,
    SpeakerId, TranscriptEvent, TranscriptSession, TranscriptStore,
};
use tauri::{AppHandle, Emitter};
use tokio::sync::broadcast;
use uuid::Uuid;

/// Tauri-managed `TranscriptStore`.
pub type TranscriptStoreHandle = Arc<TranscriptStore>;
/// Tauri-managed `ModelStore`.
pub type ModelStoreHandle = Arc<ModelStore>;

/// Per-session event name. Mirror of `subscribe_cmd::patch_event_name`.
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

fn cap_name(name: &str) -> String {
    name.trim().chars().take(MAX_SPEAKER_NAME_LEN).collect()
}

// ---- 1) feature-toggle commands (top-level user config, ADR-056 §13) ------

#[tauri::command]
pub async fn transcription_enabled() -> Result<bool, String> {
    let cfg = speedwave_runtime::config::load_user_config().map_err(|e| e.to_string())?;
    Ok(cfg.transcription_enabled())
}

#[tauri::command]
pub async fn set_transcription_enabled(enabled: bool) -> Result<(), String> {
    let mut cfg = speedwave_runtime::config::load_user_config().map_err(|e| e.to_string())?;
    let mut tr = cfg.transcription.unwrap_or_default();
    tr.enabled = Some(enabled);
    cfg.transcription = Some(tr);
    speedwave_runtime::config::save_user_config(&cfg).map_err(|e| e.to_string())
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

#[tauri::command]
pub async fn start_transcription(
    _source: serde_json::Value, // Phase 4 plumbs the real selector through; for now ignored
    language: String,
    _live_model_override: Option<String>,
    store: tauri::State<'_, TranscriptStoreHandle>,
    app: AppHandle,
) -> Result<StartAck, String> {
    // Force-language is enum-validated at the Rust boundary.
    let lang = match language.as_str() {
        "pl" => Language::Pl,
        "en" => Language::En,
        other => return Err(format!("unsupported language: {other}")),
    };
    // Phase 2 uses a placeholder audio source — real capture lands in Phase 4.
    let audio_source = AudioSourceInfo {
        source: speedwave_runtime::transcription::AudioSource::SystemWide,
        label: "(placeholder — capture lands in Phase 4)".to_string(),
        app_id: None,
    };
    let session_dir_seed = transcription::transcripts_dir().join("pending");
    let session = TranscriptSession::new(lang, audio_source, session_dir_seed.join("audio.wav"));
    let session_id = session.id;
    store
        .create(session)
        .map_err(|e| format!("store create: {e}"))?;
    // Spawn the event forwarder so the frontend doesn't race a status update.
    spawn_event_forwarder(app, store.inner_clone(), session_id);
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
) -> Result<(), String> {
    let id = parse_transcript_id(&session_id)?;
    // Phase 4 will signal the real driver; Phase 2 just transitions status.
    store
        .set_status(
            id,
            speedwave_runtime::transcription::TranscriptStatus::Finalizing { progress: 0.0 },
        )
        .map_err(|e| e.to_string())?;
    Ok(())
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
    app: AppHandle,
) -> Result<SubscribeAck, String> {
    let id = parse_transcript_id(&session_id)?;
    let snapshot = store.get(id).map_err(|e| e.to_string())?;
    spawn_event_forwarder(app, store.inner_clone(), id);
    Ok(SubscribeAck {
        event_name: transcript_event_name(id),
        snapshot,
    })
}

/// Drains a session's broadcast into Tauri events. Detached task.
fn spawn_event_forwarder(app: AppHandle, store: Arc<TranscriptStore>, id: Uuid) {
    let sub = match store.subscribe(id) {
        Ok(s) => s,
        Err(e) => {
            log::warn!("subscribe_transcript: {e}");
            return;
        }
    };
    let event_name = transcript_event_name(id);
    tauri::async_runtime::spawn(async move {
        forward_events(app, event_name, sub.events).await;
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
    // Pull, mutate locally, save. (Driver isn't running here in Phase 2.)
    let mut s = store.get(id).map_err(|e| e.to_string())?;
    s.discard_audio().map_err(|e| e.to_string())?;
    let dir = store.session_dir(id);
    s.save(&dir).map_err(|e| e.to_string())?;
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
    let key = model_id;
    let models = models.inner_clone();
    // Long-blocking download — off the async runtime.
    tokio::task::spawn_blocking(move || {
        models.ensure_model(&key, &mut |p| {
            let _ = app.emit(MODEL_PROGRESS_EVENT, &p);
        })
    })
    .await
    .map_err(|e| format!("download task panicked: {e}"))?
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn delete_transcription_model(
    model_id: String,
    models: tauri::State<'_, ModelStoreHandle>,
) -> Result<(), String> {
    models.delete_model(&model_id).map_err(|e| e.to_string())
}

// ---- tiny inherent helper so we don't expose `Arc` cloning everywhere -----

/// Clones the inner `Arc<T>` out of a Tauri `State<'_, Arc<T>>`.
trait ArcExt<T: Send + Sync + 'static> {
    fn inner_clone(&self) -> Arc<T>;
}
impl<T: Send + Sync + 'static> ArcExt<T> for tauri::State<'_, Arc<T>> {
    fn inner_clone(&self) -> Arc<T> {
        Arc::clone(self.inner())
    }
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
}
