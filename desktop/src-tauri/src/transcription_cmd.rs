//! Tauri commands for meeting transcription (ADR-056); thin layer over `transcription` module.
//! Events forward via per-session `transcript_event::<id>` channels (ADR-043 delivery shape).

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use speedwave_runtime::transcription::{
    self, AudioSource, AudioSourceInfo, CaptureCapabilities, Diarizer, DiarizerLoader,
    DriverConfig, DriverError, FinalizeConfig, GpuClass, Language, ModelStatusEntry, ModelStore,
    NemotronDiarizer, StopSignal, StoreError, TranscribeOptions, TranscriptDriver, TranscriptEvent,
    TranscriptSession, TranscriptStatus, TranscriptStore, TranscriptSummary, WhisperCppTranscriber,
    DIARIZATION_MODEL, IMPORTED_FILE_NOT_CAPTURED, IMPORT_EXTENSIONS,
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

/// App-wide event carrying the id of a session whose recordings-list row changed.
pub const TRANSCRIPTS_CHANGED_EVENT: &str = "transcripts_changed";

/// Refusal of a start, resume or import while no Whisper model is on disk.
const NO_WHISPER_MODEL: &str =
    "no Whisper model is downloaded; download it in Settings → Meeting transcription";

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

#[tauri::command]
pub async fn list_audio_sources() -> Result<Vec<AudioSourceInfo>, String> {
    transcription::detect_audio_capture()
        .enumerate_sources()
        .map_err(|e| e.to_string())
}

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
    /// `false` = record-only: skip the live pass entirely; the transcript comes from the
    /// offline pass after stop (ADR-056 Am. 13). Defaults on for older frontends.
    #[serde(default = "default_live")]
    pub live: bool,
}

/// Serde default for [`StartParams::live`].
fn default_live() -> bool {
    true
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
        live,
    } = params;
    let lang = match language.as_str() {
        "pl" => Language::Pl,
        "en" => Language::En,
        other => return Err(format!("unsupported language: {other}")),
    };
    let audio_source: AudioSource =
        serde_json::from_value(source).map_err(|e| format!("invalid audio source: {e}"))?;

    let capture = transcription::detect_audio_capture();
    let caps = capture.capabilities();
    validate_source_against_caps(&audio_source, &caps)?;

    let store_arc = store.inner().clone();
    let live_transcriber = prepare_live_transcriber(live, models.inner()).await?;

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
    session.models_used.live = live_transcriber.as_ref().map(|(key, _)| key.clone());
    let stop = StopSignal::new();
    register_driver_and_repaint_tray(&app, drivers.inner(), session_id, &stop)?;
    if let Err(e) = store.create(session) {
        unregister_driver_and_repaint_tray(&app, drivers.inner(), session_id, &stop);
        return Err(format!("store create: {e}"));
    }

    let stream = match capture.start(audio_source) {
        Ok(s) => s,
        Err(e) => {
            unregister_driver_and_repaint_tray(&app, drivers.inner(), session_id, &stop);
            let _ = store.set_status(
                session_id,
                TranscriptStatus::Failed {
                    reason: e.to_string(),
                },
            );
            return Err(e.to_string());
        }
    };

    spawn_event_forwarder(
        app.clone(),
        store_arc.clone(),
        forwarders.inner().clone(),
        session_id,
    );

    spawn_driver(
        DriverConfig {
            id: session_id,
            store: store_arc.clone(),
            audio: stream,
            transcriber: live_transcriber.map(|(_, t)| Box::new(t) as _),
            transcribe_opts: TranscribeOptions::for_language(lang),
            stop,
            time_base: std::time::Duration::ZERO,
        },
        audio_wav,
        app,
        drivers.inner().clone(),
    );

    let snapshot = store.get(session_id).map_err(|e| e.to_string())?;
    Ok(StartAck {
        session_id,
        event_name: transcript_event_name(session_id),
        snapshot,
    })
}

/// Claims the driver-registry slot for `id`; rejecting an occupied slot is the one-recording-
/// per-session invariant (a blind insert would let a losing start/resume clobber the winner).
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

pub fn is_recording(drivers: &DriversHandle) -> bool {
    !drivers
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .is_empty()
}

fn register_driver_and_repaint_tray(
    app: &AppHandle,
    drivers: &DriversHandle,
    id: Uuid,
    stop: &StopSignal,
) -> Result<(), String> {
    register_driver(drivers, id, stop)?;
    crate::tray::refresh_tray_icon(app);
    Ok(())
}

fn unregister_driver_and_repaint_tray(
    app: &AppHandle,
    drivers: &DriversHandle,
    id: Uuid,
    stop: &StopSignal,
) {
    unregister_driver(drivers, id, stop);
    crate::tray::refresh_tray_icon(app);
}

/// Runs a built driver on a blocking task; cleans up the stop-signal registry
/// and wakes `await_finished()` waiters when it winds down.
fn spawn_driver(
    cfg: DriverConfig,
    audio_wav: std::path::PathBuf,
    app: AppHandle,
    drivers: DriversHandle,
) {
    let session_id = cfg.id;
    let stop_for_cleanup = cfg.stop.clone();
    let driver = TranscriptDriver::new(cfg);
    tokio::task::spawn_blocking(move || {
        if let Err(e) = driver.run(&audio_wav) {
            log::warn!(
                "transcript driver for {} ended with error: {e}",
                short_id(session_id)
            );
        }
        unregister_driver_and_repaint_tray(&app, &drivers, session_id, &stop_for_cleanup);
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
    live: Option<bool>,
    store: tauri::State<'_, TranscriptStoreHandle>,
    models: tauri::State<'_, ModelStoreHandle>,
    drivers: tauri::State<'_, DriversHandle>,
    forwarders: tauri::State<'_, ForwardersHandle>,
    app: AppHandle,
) -> Result<StartAck, String> {
    let id = parse_transcript_id(&session_id)?;
    let session = store.get(id).map_err(|e| e.to_string())?;
    if !matches!(
        session.status,
        TranscriptStatus::Done | TranscriptStatus::Paused
    ) {
        return Err("only a finished or paused recording can be resumed".to_string());
    }
    let lang = session.language;
    let audio_source = session.audio_source.source.clone();

    let capture = transcription::detect_audio_capture();
    validate_source_against_caps(&audio_source, &capture.capabilities())?;

    let store_arc = store.inner().clone();
    let live_transcriber =
        prepare_live_transcriber(live.unwrap_or_else(default_live), models.inner()).await?;

    let time_base = resume_time_base(&session.all_audio_parts())?;
    let part_no = session.all_audio_parts().len() + 1;
    let next_part = store.session_dir(id).join(format!("audio-{part_no}.wav"));

    let stop = StopSignal::new();
    register_driver_and_repaint_tray(&app, drivers.inner(), id, &stop)?;
    let resumed_live_model = live_transcriber.as_ref().map(|(key, _)| key.clone());
    if let Err(e) = store.resume(id, next_part.clone(), resumed_live_model) {
        unregister_driver_and_repaint_tray(&app, drivers.inner(), id, &stop);
        return Err(e.to_string());
    }
    let stream = match capture.start(audio_source) {
        Ok(s) => s,
        Err(e) => {
            unregister_driver_and_repaint_tray(&app, drivers.inner(), id, &stop);
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

    spawn_event_forwarder(
        app.clone(),
        store_arc.clone(),
        forwarders.inner().clone(),
        id,
    );
    spawn_driver(
        DriverConfig {
            id,
            store: store_arc,
            audio: stream,
            transcriber: live_transcriber.map(|(_, t)| Box::new(t) as _),
            transcribe_opts: TranscribeOptions::for_language(lang),
            stop,
            time_base,
        },
        next_part,
        app,
        drivers.inner().clone(),
    );

    let snapshot = store.get(id).map_err(|e| e.to_string())?;
    Ok(StartAck {
        session_id: id,
        event_name: transcript_event_name(id),
        snapshot,
    })
}

/// Pauses a running recording: the capture ends and its part is closed like on Stop, the
/// microphone is released, and the session waits as `Paused` for Resume or Stop.
#[tauri::command]
pub async fn pause_transcription(
    session_id: String,
    drivers: tauri::State<'_, DriversHandle>,
) -> Result<(), String> {
    let id = parse_transcript_id(&session_id)?;
    let stop = drivers
        .lock()
        .map_err(|e| format!("drivers lock poisoned: {e}"))?
        .get(&id)
        .cloned()
        .ok_or_else(|| "this recording is not capturing".to_string())?;
    stop.pause();
    let _ = tokio::time::timeout(std::time::Duration::from_secs(5), stop.await_finished()).await;
    Ok(())
}

/// Stops a capture and starts its offline pass; `speaker_mode` is the Settings switch "Tell
/// speakers apart in the meeting audio" as it stands now (ADR-098, read at the pass's start).
#[tauri::command]
pub async fn stop_transcription(
    session_id: String,
    speaker_mode: bool,
    store: tauri::State<'_, TranscriptStoreHandle>,
    models: tauri::State<'_, ModelStoreHandle>,
    drivers: tauri::State<'_, DriversHandle>,
) -> Result<(), String> {
    let id = parse_transcript_id(&session_id)?;
    let stop_handle = drivers
        .lock()
        .map_err(|e| format!("drivers lock poisoned: {e}"))?
        .get(&id)
        .cloned();
    if let Some(stop) = stop_handle.as_ref() {
        stop.stop();
    } else {
        store
            .set_status(id, TranscriptStatus::Finalizing { progress: 0.0 })
            .map_err(|e| e.to_string())?;
    }

    if let Some(stop) = stop_handle {
        let _ =
            tokio::time::timeout(std::time::Duration::from_secs(5), stop.await_finished()).await;
    }

    let audio_paths = offline_pass_parts(&store, id)?;
    spawn_offline_pass(
        store.inner().clone(),
        models.inner().clone(),
        id,
        audio_paths,
        speaker_mode,
    );
    Ok(())
}

/// Runs the offline pass again over a session's recorded parts: a failed one (an interrupted
/// recording, or a model missing at Stop), a finished one made with a smaller model, or one the
/// user put off. The session goes back to `Finalizing` and ends `Done`, `Failed`, or `Postponed`
/// when it is put off again. `speaker_mode` is as in `stop_transcription`.
#[tauri::command]
pub async fn transcribe_transcript(
    session_id: String,
    speaker_mode: bool,
    store: tauri::State<'_, TranscriptStoreHandle>,
    models: tauri::State<'_, ModelStoreHandle>,
    drivers: tauri::State<'_, DriversHandle>,
) -> Result<(), String> {
    let id = parse_transcript_id(&session_id)?;
    if drivers
        .lock()
        .map_err(|e| format!("drivers lock poisoned: {e}"))?
        .contains_key(&id)
    {
        return Err("this recording is still capturing; stop it first".to_string());
    }
    let audio_paths = offline_pass_parts(&store, id)?;
    store.begin_retranscribe(id).map_err(|e| e.to_string())?;
    spawn_offline_pass(
        store.inner().clone(),
        models.inner().clone(),
        id,
        audio_paths,
        speaker_mode,
    );
    Ok(())
}

/// Puts off a running or queued offline pass ("Later"): a running decode is aborted and its
/// progress is lost, and the session waits as `Postponed` until `transcribe_transcript`.
#[tauri::command]
pub async fn postpone_transcription(
    session_id: String,
    store: tauri::State<'_, TranscriptStoreHandle>,
) -> Result<(), String> {
    let id = parse_transcript_id(&session_id)?;
    store.postpone(id).map(|_| ()).map_err(|e| e.to_string())
}

/// Asks for an audio file on this machine and transcribes it like a stopped recording (SPEED-462);
/// `None` when the picker is closed. A file that cannot be decoded leaves no session.
#[tauri::command]
pub async fn import_transcription(
    language: Language,
    store: tauri::State<'_, TranscriptStoreHandle>,
    models: tauri::State<'_, ModelStoreHandle>,
    app: AppHandle,
) -> Result<Option<Uuid>, String> {
    use tauri_plugin_dialog::DialogExt;
    let store_arc = store.inner().clone();
    let models_arc = models.inner().clone();
    let picked = {
        let store = store_arc.clone();
        let models = models_arc.clone();
        tokio::task::spawn_blocking(move || -> Result<Option<TranscriptSession>, String> {
            if pick_offline_model(&models).is_none() {
                return Err(NO_WHISPER_MODEL.to_string());
            }
            let Some(file) = app
                .dialog()
                .file()
                .set_title("Import an audio file")
                .add_filter(
                    format!("Audio ({})", transcription::supported_formats()),
                    IMPORT_EXTENSIONS,
                )
                .blocking_pick_file()
            else {
                return Ok(None);
            };
            let src = file
                .into_path()
                .map_err(|e| format!("unsupported file location: {e}"))?;
            import_audio_file(&store, &src, language).map(Some)
        })
        .await
        .map_err(|e| format!("import task panicked: {e}"))??
    };
    let Some(session) = picked else {
        return Ok(None);
    };
    spawn_offline_pass(
        store_arc,
        models_arc,
        session.id,
        session.all_audio_parts(),
        false,
    );
    Ok(Some(session.id))
}

/// Decodes `src` into a new session named after the file, waiting for its offline pass.
fn import_audio_file(
    store: &TranscriptStore,
    src: &std::path::Path,
    language: Language,
) -> Result<TranscriptSession, String> {
    let file_name = src
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let title = src
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_default();
    let source = AudioSourceInfo {
        source: AudioSource::ImportedFile,
        label: format!("Imported file: {file_name}"),
    };
    let session = store.import(src, language, source, &title).map_err(|e| {
        log::info!("audio file import refused: {e}");
        format!("Could not import \"{file_name}\": {e}")
    })?;
    log::info!(
        "imported an audio file as transcript {}",
        short_id(session.id)
    );
    Ok(session)
}

/// One offline pass at a time: two passes loading two large models side by side can exhaust the
/// memory of a 16 GiB host, so a second Stop waits its turn (the list row says "queued").
static OFFLINE_PASS_TURN: Mutex<()> = Mutex::new(());

/// Waits for the offline-pass turn, marking the session queued while another pass holds it.
fn take_offline_pass_turn(store: &TranscriptStore, id: Uuid) -> std::sync::MutexGuard<'static, ()> {
    match OFFLINE_PASS_TURN.try_lock() {
        Ok(turn) => turn,
        Err(std::sync::TryLockError::Poisoned(p)) => p.into_inner(),
        Err(std::sync::TryLockError::WouldBlock) => {
            store.set_queued(id, true);
            let turn = OFFLINE_PASS_TURN
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            store.set_queued(id, false);
            turn
        }
    }
}

/// Loads the offline-pass model and transcribes `audio_paths` on a blocking task, one pass at a
/// time; every failure lands on the session as `Failed`, so the UI always learns how it ended. It
/// first waits for a capture driver still winding down after Stop, and a pass whose recording was
/// put off or deleted meanwhile ends without touching it. With `speaker_mode` it also tells the
/// meeting-channel speakers apart when the diarization model loads.
fn spawn_offline_pass(
    store_arc: TranscriptStoreHandle,
    models_arc: ModelStoreHandle,
    id: Uuid,
    audio_paths: Vec<std::path::PathBuf>,
    speaker_mode: bool,
) {
    tokio::task::spawn_blocking(move || {
        match store_arc.wait_while_recording(id) {
            Ok(TranscriptStatus::Finalizing { .. }) => {}
            Ok(status) => {
                log::info!(
                    "offline pass for {} not started: the recording ended as {status:?}",
                    short_id(id)
                );
                return;
            }
            Err(e) => {
                log_pass_store_error(id, "not started", &e);
                return;
            }
        }
        let _turn = take_offline_pass_turn(&store_arc, id);
        let pass = match store_arc.begin_offline_pass(id) {
            Ok(pass) => pass,
            Err(e) => {
                log_pass_store_error(id, "not started", &e);
                return;
            }
        };
        let fail = |reason: String| {
            if let Err(e) = store_arc.fail_pass(id, &pass, reason) {
                log_pass_store_error(id, "could not record its failure", &e);
            }
        };
        let offline_key = pick_offline_model(&models_arc);
        let Some(key) = offline_key else {
            fail("no Whisper model available for the offline pass".to_string());
            return;
        };
        if let Err(e) = store_arc.set_finalize_model(id, &pass, &key) {
            log_pass_store_error(id, "stopped before loading its model", &e);
            if pass.cancelled() {
                return;
            }
        }
        let path = match models_arc.ensure_model(&key, &mut |_| {}) {
            Ok(p) => p,
            Err(e) => {
                fail(format!("model: {e}"));
                return;
            }
        };
        if pass.cancelled() {
            log::info!(
                "offline pass for {} stopped before loading its model: put off or replaced",
                short_id(id)
            );
            return;
        }
        let transcriber =
            match WhisperCppTranscriber::load(&path, key.clone(), transcription::gpu_class()) {
                Ok(mut t) => {
                    attach_vad(&mut t, &models_arc);
                    Box::new(t) as Box<dyn speedwave_runtime::transcription::Transcriber>
                }
                Err(e) => {
                    fail(format!("transcriber: {e}"));
                    return;
                }
            };
        let diarizer = offline_diarizer(&models_arc, speaker_mode, transcription::gpu_class());
        let cfg = FinalizeConfig {
            id,
            store: store_arc.clone(),
            audio_paths,
            transcriber,
            transcribe_opts: TranscribeOptions::for_language(session_language(&store_arc, id)),
            pass,
            diarizer,
        };
        match speedwave_runtime::transcription::run_finalize(cfg) {
            Ok(()) => {}
            Err(DriverError::Deleted) => {
                log::info!(
                    "offline finalize for {} stopped: session deleted",
                    short_id(id)
                );
            }
            Err(DriverError::Superseded) => {
                log::info!(
                    "offline finalize for {} stopped: put off or replaced",
                    short_id(id)
                );
            }
            Err(e) => log::warn!("offline finalize for {} failed: {e}", short_id(id)),
        }
    });
}

fn offline_diarizer(
    models: &ModelStore,
    speaker_mode: bool,
    class: GpuClass,
) -> Option<DiarizerLoader> {
    if !speaker_mode {
        return None;
    }
    let models = models.clone();
    Some(Box::new(move || {
        if !models.diarization_is_present() {
            return Err(transcription::DiarizeError::ModelMissing(
                DIARIZATION_MODEL.file.to_string(),
            ));
        }
        NemotronDiarizer::load(&models.diarization_path(), class)
            .map(|d| Box::new(d) as Box<dyn Diarizer>)
    }))
}

/// Logs a store refusal of an offline pass: a recording the user put off, replaced or deleted is
/// expected and logged at info; any other store failure is a fault and logged at warn.
fn log_pass_store_error(id: Uuid, what: &str, e: &StoreError) {
    match e {
        StoreError::PassEnded(_) | StoreError::InvalidState(_) | StoreError::NotFound(_) => {
            log::info!("offline pass for {} {what}: {e}", short_id(id));
        }
        _ => log::warn!("offline pass for {} {what}: {e}", short_id(id)),
    }
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
    if matches!(src, AudioSource::SystemWide | AudioSource::Mixed { .. })
        && !caps.supports_system_audio
    {
        return Err("this host does not support system audio capture".to_string());
    }
    let needs_microphone: bool = match src {
        AudioSource::ImportedFile => return Err(IMPORTED_FILE_NOT_CAPTURED.to_string()),
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
            AudioSource::ImportedFile => "Imported file".to_string(),
        }
    }
    generic(src)
}

/// Reads a session's forced language (defaults to PL if it can't be read).
fn session_language(store: &TranscriptStore, id: Uuid) -> Language {
    store.get(id).map(|s| s.language).unwrap_or(Language::Pl)
}

/// Picks the model for the offline pass: this build's finalize model if downloaded, else the
/// first downloaded one; `None` when nothing is (record-only sessions load no live model).
fn pick_offline_model(models: &ModelStore) -> Option<String> {
    let best = transcription::finalize_model_for_this_build().key;
    if models.whisper_is_present_by_key(best) {
        return Some(best.to_string());
    }
    models
        .whisper_status()
        .into_iter()
        .find(|m| m.downloaded)
        .map(|m| m.key)
}

/// The shared start/resume gate (ADR-056 Am. 13): loads the live transcriber, or for record-only
/// verifies the offline pass has a model — fail at Start (actionable), not at Stop.
async fn prepare_live_transcriber(
    live: bool,
    models: &ModelStoreHandle,
) -> Result<Option<(String, WhisperCppTranscriber)>, String> {
    if live {
        return Ok(Some(load_live_transcriber(models).await?));
    }
    let m = models.clone();
    tokio::task::spawn_blocking(move || {
        if pick_offline_model(&m).is_none() {
            return Err(NO_WHISPER_MODEL.to_string());
        }
        Ok(None)
    })
    .await
    .map_err(|e| format!("model check task panicked: {e}"))?
}

/// Picks the live model (recommended → any downloaded), ensures it on disk,
/// loads the transcriber, and attaches the VAD gate — shared by start and resume.
async fn load_live_transcriber(
    models: &ModelStoreHandle,
) -> Result<(String, WhisperCppTranscriber), String> {
    let m = models.clone();
    tokio::task::spawn_blocking(move || -> Result<(String, WhisperCppTranscriber), String> {
        let recommended = transcription::live_model_for_this_build().key.to_string();
        let class = transcription::gpu_class();
        let key = pick_live_model(&m, &recommended, class)?;
        let path = m
            .ensure_model(&key, &mut |_| {})
            .map_err(|e| e.to_string())?;
        let mut t =
            WhisperCppTranscriber::load(&path, key.clone(), class).map_err(|e| e.to_string())?;
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

/// Picks the model for the live pass: `recommended` (if downloaded) → first downloaded model
/// live-capable on this host's `class` → download-hint error (no auto-dl; UI prompts).
fn pick_live_model(
    models: &ModelStore,
    recommended: &str,
    class: transcription::GpuClass,
) -> Result<String, String> {
    if models.whisper_is_present_by_key(recommended) {
        return Ok(recommended.to_string());
    }
    if let Some(any) = models
        .whisper_status()
        .into_iter()
        .filter(|m| m.downloaded)
        .find(|m| transcription::whisper_model(&m.key).is_some_and(|i| i.live_capable_on(class)))
    {
        log::info!(
            "recommended live model '{recommended}' not downloaded — falling back to '{}'",
            any.key
        );
        return Ok(any.key);
    }
    Err(
        "no downloaded model is live-capable on this hardware — download one in Settings → Meeting transcription"
            .to_string(),
    )
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

#[tauri::command]
pub async fn list_transcripts(
    store: tauri::State<'_, TranscriptStoreHandle>,
) -> Result<Vec<TranscriptSummary>, String> {
    let store = store.inner().clone();
    tokio::task::spawn_blocking(move || store.list())
        .await
        .map_err(|e| format!("list task panicked: {e}"))
}

/// Forwards the store's change channel as [`TRANSCRIPTS_CHANGED_EVENT`] for the whole app run,
/// so the recordings list refreshes on change instead of polling.
pub fn spawn_change_forwarder(app: AppHandle, store: TranscriptStoreHandle) {
    let mut changes = store.watch();
    tauri::async_runtime::spawn(async move {
        loop {
            match changes.recv().await {
                Ok(id) => {
                    if let Err(e) = app.emit(TRANSCRIPTS_CHANGED_EVENT, id.to_string()) {
                        log::warn!("failed to emit a transcripts change: {e}");
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    let _ = app.emit(TRANSCRIPTS_CHANGED_EVENT, String::new());
                }
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });
}

/// Renames a session; a blank title restores the default name. Returns the stored title.
#[tauri::command]
pub async fn rename_transcript(
    session_id: String,
    title: String,
    store: tauri::State<'_, TranscriptStoreHandle>,
) -> Result<Option<String>, String> {
    let id = parse_transcript_id(&session_id)?;
    store.rename(id, &title).map_err(|e| e.to_string())
}

/// Saves the session's markdown transcript where the user picks in a native save dialog.
/// Returns `false` when the user cancels.
#[tauri::command]
pub async fn export_transcript(
    session_id: String,
    store: tauri::State<'_, TranscriptStoreHandle>,
    app: AppHandle,
) -> Result<bool, String> {
    use tauri_plugin_dialog::DialogExt;
    let id = parse_transcript_id(&session_id)?;
    let session = store.get(id).map_err(|e| e.to_string())?;
    let markdown = session.to_markdown();
    let file_name = export_file_name(&session);
    tokio::task::spawn_blocking(move || {
        let Some(picked) = app
            .dialog()
            .file()
            .set_file_name(file_name)
            .add_filter("Markdown", &["md"])
            .blocking_save_file()
        else {
            return Ok(false);
        };
        let path = picked
            .into_path()
            .map_err(|e| format!("unsupported save location: {e}"))?;
        std::fs::write(&path, markdown)
            .map_err(|e| format!("could not save the transcript: {e}"))?;
        Ok(true)
    })
    .await
    .map_err(|e| format!("export task panicked: {e}"))?
}

/// Default export file name: the title (or the start date) made safe for every filesystem.
fn export_file_name(session: &TranscriptSession) -> String {
    let base = session.title.clone().unwrap_or_else(|| {
        let day = session.created_at.get(..10).unwrap_or(&session.created_at);
        format!("Meeting {day}")
    });
    let safe: String = base
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '-',
            c if c.is_control() => '-',
            c => c,
        })
        .collect();
    let trimmed = safe.trim().trim_end_matches('.');
    if trimmed.is_empty() {
        "Meeting transcript.md".to_string()
    } else {
        format!("{trimmed}.md")
    }
}

/// Shows the session's audio in Finder (macOS) or Explorer (Windows).
#[tauri::command]
pub async fn reveal_transcript_audio(
    session_id: String,
    store: tauri::State<'_, TranscriptStoreHandle>,
) -> Result<(), String> {
    let id = parse_transcript_id(&session_id)?;
    let session = store.get(id).map_err(|e| e.to_string())?;
    let target = session
        .audio_path
        .filter(|p| p.exists())
        .unwrap_or_else(|| store.session_dir(id));
    reveal_in_file_manager(&target)
}

#[cfg(target_os = "macos")]
fn reveal_in_file_manager(path: &std::path::Path) -> Result<(), String> {
    speedwave_runtime::binary::system_command("open")
        .arg("-R")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("could not open Finder: {e}"))
}

#[cfg(target_os = "windows")]
fn reveal_in_file_manager(path: &std::path::Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    speedwave_runtime::binary::system_command("explorer.exe")
        .raw_arg(format!("/select,\"{}\"", path.display()))
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("could not open Explorer: {e}"))
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

/// One model the pipeline needs, with its on-disk state.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct RecommendedModelEntry {
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
}

/// The models Speedwave needs on this hardware: one for the live pass and, when they differ,
/// one for the higher-quality offline pass, plus the optional speaker-diarization model. The UI
/// offers exactly these, with no picker.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct RecommendedModelAck {
    /// The live-pass model.
    pub live: RecommendedModelEntry,
    /// The offline-pass model, or `None` when the live model serves both passes.
    pub finalize: Option<RecommendedModelEntry>,
    /// The speaker-diarization model; Settings offers its download next to the switch.
    pub diarization: RecommendedModelEntry,
    /// Acceleration label for the UI (e.g. `"Metal (GPU)"`, `"CPU"`).
    pub accel_label: String,
    /// The host's GPU class, for the Settings text on what diarization costs here.
    pub gpu_class: GpuClass,
}

/// Resolves one catalogue model to its UI entry (on-disk state plus any in-flight download).
/// `status` is a pre-scanned `whisper_status()` list — the Settings UI polls this every 2 s,
/// so the directory is scanned once per call, not once per entry.
fn model_entry(
    info: &transcription::WhisperModelInfo,
    status: &[ModelStatusEntry],
    downloads: &DownloadsHandle,
) -> Result<RecommendedModelEntry, String> {
    let status = status
        .iter()
        .find(|m| m.key == info.key)
        .ok_or_else(|| format!("model '{}' missing from catalogue", info.key))?;
    Ok(RecommendedModelEntry {
        key: info.key.to_string(),
        display_name: info.display_name.to_string(),
        size_bytes: status.size_bytes,
        downloaded: status.downloaded,
        downloading: is_downloading(downloads, info.key),
    })
}

fn diarization_entry(models: &ModelStore, downloads: &DownloadsHandle) -> RecommendedModelEntry {
    let status = models.diarization_status();
    RecommendedModelEntry {
        key: status.key,
        display_name: DIARIZATION_MODEL.display_name.to_string(),
        size_bytes: status.size_bytes,
        downloaded: status.downloaded,
        downloading: is_downloading(downloads, DIARIZATION_MODEL.key),
    }
}

#[tauri::command]
pub async fn recommended_transcription_model(
    models: tauri::State<'_, ModelStoreHandle>,
    downloads: tauri::State<'_, DownloadsHandle>,
) -> Result<RecommendedModelAck, String> {
    let models = models.inner().clone();
    let downloads = downloads.inner().clone();
    tokio::task::spawn_blocking(move || {
        let live_info = transcription::live_model_for_this_build();
        let finalize_info = transcription::finalize_model_for_this_build();
        let status = models.whisper_status();
        let live = model_entry(live_info, &status, &downloads)?;
        let finalize = if finalize_info.key == live_info.key {
            None
        } else {
            Some(model_entry(finalize_info, &status, &downloads)?)
        };
        Ok(RecommendedModelAck {
            live,
            finalize,
            diarization: diarization_entry(&models, &downloads),
            accel_label: transcription::accel_label(),
            gpu_class: transcription::gpu_class(),
        })
    })
    .await
    .map_err(|e| format!("recommended-model task panicked: {e}"))?
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
        let _slot = slot;
        let mut progress = |p: transcription::DownloadProgress| {
            let _ = app.emit(MODEL_PROGRESS_EVENT, &p);
        };
        let result = download_model_by_key(&models, &model_id, &mut progress);
        result.map(|_| ()).map_err(|e| {
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

fn download_model_by_key(
    models: &ModelStore,
    key: &str,
    progress: &mut dyn FnMut(transcription::DownloadProgress),
) -> Result<std::path::PathBuf, transcription::ModelStoreError> {
    if matches!(
        transcription::catalog_model(key),
        Some(transcription::CatalogModel::Whisper(_))
    ) {
        if let Err(e) = models.ensure_vad_model() {
            log::warn!(target: "transcription::models", "VAD model download failed: {e}");
        }
    }
    models.ensure_model(key, progress)
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "test assertions may unwrap freely"
)]
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
        let err = register_driver(&drivers, id, &StopSignal::new()).unwrap_err();
        assert!(err.contains("already recording"), "got: {err}");
        assert!(drivers.lock().unwrap().get(&id).unwrap().same_as(&winner));
        register_driver(&drivers, Uuid::new_v4(), &StopSignal::new()).unwrap();
        assert_eq!(drivers.lock().unwrap().len(), 2);
    }

    #[test]
    fn unregister_driver_removes_only_the_entry_it_registered() {
        let drivers: DriversHandle = Arc::new(Mutex::new(HashMap::new()));
        let id = Uuid::new_v4();
        let winner = StopSignal::new();
        register_driver(&drivers, id, &winner).unwrap();
        unregister_driver(&drivers, id, &StopSignal::new());
        assert!(drivers.lock().unwrap().contains_key(&id));
        unregister_driver(&drivers, Uuid::new_v4(), &winner);
        assert_eq!(drivers.lock().unwrap().len(), 1);
        unregister_driver(&drivers, id, &winner);
        assert!(drivers.lock().unwrap().is_empty());
    }

    #[test]
    fn is_recording_follows_register_and_unregister() {
        let drivers: DriversHandle = Arc::new(Mutex::new(HashMap::new()));
        assert!(
            !is_recording(&drivers),
            "an empty registry is not recording"
        );

        let first = StopSignal::new();
        let first_id = Uuid::new_v4();
        register_driver(&drivers, first_id, &first).unwrap();
        assert!(is_recording(&drivers));

        let second = StopSignal::new();
        let second_id = Uuid::new_v4();
        register_driver(&drivers, second_id, &second).unwrap();
        unregister_driver(&drivers, first_id, &first);
        assert!(is_recording(&drivers));

        unregister_driver(&drivers, second_id, &second);
        assert!(!is_recording(&drivers));
    }

    #[test]
    fn is_recording_reads_through_a_poisoned_lock() {
        let drivers: DriversHandle = Arc::new(Mutex::new(HashMap::new()));
        let poisoner = drivers.clone();
        let _ = std::thread::spawn(move || {
            let _g = poisoner.lock().unwrap();
            panic!("poison the drivers lock");
        })
        .join();
        assert!(drivers.is_poisoned());
        assert!(!is_recording(&drivers));
    }

    #[test]
    fn every_registry_mutation_repaints_the_tray() {
        let source = include_str!("transcription_cmd.rs");
        let production = &source[..source.find("#[cfg(test)]").expect("test module must exist")];

        for (raw, wrapper) in [
            ("register_driver", "register_driver_and_repaint_tray"),
            ("unregister_driver", "unregister_driver_and_repaint_tray"),
        ] {
            let body = fn_body(production, wrapper);
            assert!(
                body.contains("refresh_tray_icon"),
                "{wrapper} must repaint the tray"
            );
            assert!(
                body.contains(&format!("{raw}(")),
                "{wrapper} must delegate to {raw}"
            );
            assert_eq!(
                count_calls(production, raw),
                2,
                "`{raw}` must appear only at its definition and inside {wrapper}; a direct \
                 call elsewhere leaves the tray disagreeing with the registry"
            );
        }
    }

    fn fn_body<'a>(source: &'a str, name: &str) -> &'a str {
        let start = source
            .find(&format!("fn {name}("))
            .unwrap_or_else(|| panic!("{name} must exist"));
        let rest = &source[start..];
        &rest[..rest.find("\n}\n").unwrap_or(rest.len())]
    }

    fn count_calls(source: &str, name: &str) -> usize {
        let needle = format!("{name}(");
        source
            .match_indices(&needle)
            .filter(|(idx, _)| {
                source[..*idx]
                    .chars()
                    .next_back()
                    .is_none_or(|c| !c.is_alphanumeric() && c != '_')
            })
            .count()
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
        buf.extend_from_slice(&1u16.to_le_bytes());
        buf.extend_from_slice(&1u16.to_le_bytes());
        buf.extend_from_slice(&sample_rate.to_le_bytes());
        buf.extend_from_slice(&(sample_rate * 2).to_le_bytes());
        buf.extend_from_slice(&2u16.to_le_bytes());
        buf.extend_from_slice(&16u16.to_le_bytes());
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
        assert_eq!(resume_time_base(&[]).unwrap(), std::time::Duration::ZERO);
    }

    #[test]
    fn resume_time_base_fails_naming_the_unreadable_part() {
        let dir = tempfile::tempdir().unwrap();
        let good = dir.path().join("audio.wav");
        write_test_wav(&good, 1);
        let missing = dir.path().join("audio-2.wav");
        let err = resume_time_base(&[good.clone(), missing.clone()]).unwrap_err();
        assert!(err.contains(&missing.display().to_string()), "got: {err}");
        assert!(err.contains("resum"), "actionable wording expected: {err}");
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
        let err = offline_pass_parts(&store, Uuid::new_v4()).unwrap_err();
        assert!(err.contains("offline pass"), "got: {err}");
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
        store
            .resume(id, next_part.clone(), Some("small".to_string()))
            .unwrap();
        unregister_driver(&drivers, id, &stop);
        store.rollback_resume(id, &next_part).unwrap();

        let snap = store.get(id).unwrap();
        assert!(matches!(snap.status, TranscriptStatus::Done));
        assert!(snap.audio_parts.is_empty(), "phantom part must be dropped");
        assert!(drivers.lock().unwrap().is_empty());
        register_driver(&drivers, id, &StopSignal::new()).unwrap();
        store.resume(id, next_part, None).unwrap();
        assert!(matches!(
            store.get(id).unwrap().status,
            TranscriptStatus::Recording
        ));
    }

    #[test]
    #[serial_test::serial(offline_pass_turn)]
    fn a_second_offline_pass_waits_its_turn_and_shows_as_queued() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(dir.path()));
        let first = mk_session_in(&store);
        let second = mk_session_in(&store);
        let queued = |id: Uuid| store.list().iter().any(|r| r.id == id && r.queued);

        let held = take_offline_pass_turn(&store, first);
        assert!(!queued(first), "the first pass runs at once");
        let waiter = std::thread::spawn({
            let store = store.clone();
            move || drop(take_offline_pass_turn(&store, second))
        });
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !queued(second) {
            assert!(
                std::time::Instant::now() < deadline,
                "second pass never queued"
            );
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        drop(held);
        waiter.join().unwrap();
        assert!(
            !queued(second),
            "the mark clears once the pass gets its turn"
        );
    }

    fn titled(title: Option<&str>, created_at: &str) -> TranscriptSession {
        let mut s = TranscriptSession::new(
            Language::Pl,
            AudioSourceInfo {
                source: speedwave_runtime::transcription::AudioSource::SystemWide,
                label: "Test".to_string(),
            },
            PathBuf::from("/tmp/a.wav"),
        );
        s.title = title.map(str::to_string);
        s.created_at = created_at.to_string();
        s
    }

    #[test]
    fn export_file_name_uses_the_title_or_the_start_day() {
        assert_eq!(
            export_file_name(&titled(Some("Sprint review"), "2026-10-12T07:28:04Z")),
            "Sprint review.md"
        );
        assert_eq!(
            export_file_name(&titled(None, "2026-10-12T07:28:04Z")),
            "Meeting 2026-10-12.md"
        );
        assert_eq!(
            export_file_name(&titled(Some("Spotkanie zespołu"), "x")),
            "Spotkanie zespołu.md"
        );
    }

    #[test]
    fn export_file_name_strips_characters_no_filesystem_accepts() {
        assert_eq!(
            export_file_name(&titled(Some("Q3: plan/budget <draft>?"), "2026-01-01")),
            "Q3- plan-budget -draft--.md"
        );
        assert_eq!(
            export_file_name(&titled(Some("notes..."), "2026-01-01")),
            "notes.md"
        );
        assert_eq!(
            export_file_name(&titled(Some(" ... "), "2026-01-01")),
            "Meeting transcript.md"
        );
        assert_eq!(
            export_file_name(&titled(None, "bad")),
            "Meeting bad.md",
            "a short created_at never panics on the slice"
        );
    }

    #[test]
    fn transcripts_changed_event_matches_ts() {
        let src = include_str!("../../src/src/app/services/transcription.service.ts");
        assert!(
            src.contains(&format!(
                "const TRANSCRIPTS_CHANGED_EVENT = '{TRANSCRIPTS_CHANGED_EVENT}';"
            )),
            "transcription.service.ts must listen on the event the backend emits"
        );
    }

    #[test]
    fn stop_and_transcribe_share_the_one_offline_pass_spawner() {
        let src = include_str!("transcription_cmd.rs");
        for name in ["stop_transcription", "transcribe_transcript"] {
            assert_eq!(
                count_calls(fn_body(src, name), "spawn_offline_pass"),
                1,
                "{name} must start the offline pass through spawn_offline_pass"
            );
        }
        assert_eq!(
            count_calls(src, "run_finalize"),
            1,
            "run_finalize has exactly one caller, spawn_offline_pass"
        );
    }

    #[test]
    fn the_offline_pass_claims_its_session_before_it_loads_a_model_and_writes_only_through_it() {
        let src = include_str!("transcription_cmd.rs");
        let body = fn_body(src, "spawn_offline_pass");
        let claim = body
            .find("begin_offline_pass")
            .expect("the pass must claim its session");
        let turn = body.find("take_offline_pass_turn").expect("turn");
        assert!(
            body.find("wait_while_recording")
                .expect("driver wind-down wait")
                < turn,
            "the pass must wait for a driver still winding down after Stop, outside the turn"
        );
        assert!(claim > turn);
        assert!(claim < body.find("pick_offline_model").expect("model pick"));
        assert!(
            body.contains("set_finalize_model(id, &pass,"),
            "recording the model is a pass write"
        );
        assert!(
            body.find("pass.cancelled()").expect("cancel check")
                < body
                    .find("WhisperCppTranscriber::load")
                    .expect("model load"),
            "a put-off pass must not load the model"
        );
        assert!(
            !body.contains("set_status("),
            "a put-off pass must never overwrite the session's status"
        );
        assert_eq!(count_calls(body, "fail_pass"), 1);
    }

    #[test]
    fn stop_reports_a_session_it_cannot_hand_to_the_offline_pass() {
        let src = include_str!("transcription_cmd.rs");
        assert!(!fn_body(src, "stop_transcription").contains("let _ = store.set_status"));
    }

    #[test]
    fn later_puts_the_pass_off_through_the_store() {
        let src = include_str!("transcription_cmd.rs");
        assert_eq!(
            count_calls(fn_body(src, "postpone_transcription"), "postpone"),
            1
        );
    }

    #[test]
    fn parse_transcript_id_rejects_non_uuid() {
        assert!(parse_transcript_id("nope").is_err());
        assert!(parse_transcript_id("../escape").is_err());
        assert!(parse_transcript_id("").is_err());
        assert!(parse_transcript_id("550E8400-E29B-41D4-A716-446655440000").is_err());
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
    fn both_recommended_models_resolve_in_the_catalogue() {
        let dir = tempfile::tempdir().unwrap();
        let store = ModelStore::with_root(dir.path());
        for info in [
            transcription::live_model_for_this_build(),
            transcription::finalize_model_for_this_build(),
        ] {
            let found = store
                .whisper_status()
                .into_iter()
                .find(|m| m.key == info.key);
            assert!(found.is_some(), "model '{}' missing", info.key);
            assert!(
                !found.unwrap().downloaded,
                "nothing downloaded in a tmp dir"
            );
        }
    }

    #[test]
    fn the_live_pass_never_asks_for_the_offline_only_model() {
        assert!(
            transcription::live_model_for_this_build().live_capable_on(transcription::gpu_class())
        );
    }

    /// Driving Tauri commands fully needs a `tauri::State` wrapper, not trivial to fabricate in
    /// unit tests; instead exercise the underlying `TranscriptStore` calls each command makes.
    #[tokio::test]
    async fn store_round_trip_matches_what_the_commands_will_do() {
        let dir = tempfile::tempdir().unwrap();
        let store = TranscriptStore::with_root(dir.path());
        let id = mk_session_in(&store);
        assert_eq!(store.get(id).unwrap().id, id);
        assert_eq!(store.list().len(), 1);
        store
            .append_segment(
                id,
                speedwave_runtime::transcription::Segment {
                    start: std::time::Duration::ZERO,
                    end: std::time::Duration::from_secs(1),
                    text: "hi".to_string(),
                    words: vec![],
                    source: None,
                    speaker_id: None,
                },
            )
            .unwrap();
        let md = store.get(id).unwrap().to_markdown();
        assert!(md.contains("hi"), "expected text in markdown, got:\n{md}");
        assert!(md.ends_with("_Transcript generated locally by Speedwave._\n"));
        store.delete(id).unwrap();
        assert!(store.list().is_empty());
    }

    #[test]
    fn session_language_reads_the_session_or_defaults_to_pl() {
        let dir = tempfile::tempdir().unwrap();
        let store = TranscriptStore::with_root(dir.path());
        let id = mk_session_in(&store);
        assert_eq!(session_language(&store, id), Language::Pl);
        let missing = Uuid::new_v4();
        assert_eq!(session_language(&store, missing), Language::Pl);
    }

    fn write_sparse_diarization_model(models: &ModelStore) {
        let path = models.diarization_path();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::File::create(&path)
            .unwrap()
            .set_len(DIARIZATION_MODEL.approx_bytes)
            .unwrap();
    }

    #[test]
    fn offline_diarizer_is_off_without_speaker_mode() {
        let dir = tempfile::tempdir().unwrap();
        let models = ModelStore::with_root(dir.path().join("m"));
        write_sparse_diarization_model(&models);
        assert!(offline_diarizer(&models, false, GpuClass::None).is_none());
    }

    #[test]
    fn offline_diarizer_hands_the_pass_a_loader_that_reports_a_missing_model_only_when_run() {
        let dir = tempfile::tempdir().unwrap();
        let models = ModelStore::with_root(dir.path().join("m"));
        let load = offline_diarizer(&models, true, GpuClass::None)
            .expect("the switch alone yields a loader");
        assert!(matches!(
            load().map(|_| ()),
            Err(transcription::DiarizeError::ModelMissing(ref model)) if model == DIARIZATION_MODEL.file
        ));
    }

    #[test]
    fn offline_diarizer_reports_a_truncated_model_as_missing_like_settings_does() {
        let dir = tempfile::tempdir().unwrap();
        let models = ModelStore::with_root(dir.path().join("m"));
        let path = models.diarization_path();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::File::create(&path)
            .unwrap()
            .set_len(DIARIZATION_MODEL.approx_bytes / 2)
            .unwrap();
        assert!(!models.diarization_is_present());
        let load = offline_diarizer(&models, true, GpuClass::None).unwrap();
        assert!(matches!(
            load().map(|_| ()),
            Err(transcription::DiarizeError::ModelMissing(ref model)) if model == DIARIZATION_MODEL.file
        ));
    }

    #[test]
    fn offline_diarizer_hands_the_pass_a_loader_that_reports_a_model_that_does_not_load() {
        let dir = tempfile::tempdir().unwrap();
        let models = ModelStore::with_root(dir.path().join("m"));
        write_sparse_diarization_model(&models);
        let load = offline_diarizer(&models, true, GpuClass::None)
            .expect("a present model yields a loader");
        assert!(matches!(
            load().map(|_| ()),
            Err(transcription::DiarizeError::ModelLoad { ref model, .. }) if model == DIARIZATION_MODEL.file
        ));
    }

    #[test]
    fn diarization_entry_reports_the_download_state() {
        let dir = tempfile::tempdir().unwrap();
        let models = ModelStore::with_root(dir.path());
        let downloads = DownloadsHandle::default();
        let entry = diarization_entry(&models, &downloads);
        assert_eq!(entry.key, DIARIZATION_MODEL.key);
        assert_eq!(entry.display_name, DIARIZATION_MODEL.display_name);
        assert_eq!(entry.size_bytes, DIARIZATION_MODEL.approx_bytes);
        assert!(!entry.downloaded && !entry.downloading);

        let slot = try_begin_download(&downloads, DIARIZATION_MODEL.key).unwrap();
        assert!(diarization_entry(&models, &downloads).downloading);
        drop(slot);
        write_sparse_diarization_model(&models);
        let entry = diarization_entry(&models, &downloads);
        assert!(entry.downloaded && !entry.downloading);
    }

    #[test]
    fn download_model_by_key_fetches_the_vad_model_only_beside_a_whisper_model() {
        let dir = tempfile::tempdir().unwrap();
        let models = ModelStore::with_root(dir.path());
        write_sparse_diarization_model(&models);
        let path = download_model_by_key(&models, DIARIZATION_MODEL.key, &mut |_| {}).unwrap();
        assert_eq!(path, models.diarization_path());
        assert!(
            !models.vad_is_present(),
            "the diarization model is downloaded without the VAD model"
        );
        assert!(matches!(
            download_model_by_key(&models, "nope", &mut |_| {}).unwrap_err(),
            transcription::ModelStoreError::UnknownModel(_)
        ));
        assert!(
            !models.vad_is_present(),
            "an unknown key is refused before any download"
        );
    }

    #[test]
    fn recommended_model_ack_fields_match_ts_mirror() {
        let src = include_str!("../../src/src/app/models/transcript.ts");
        let entry = RecommendedModelEntry {
            key: "k".to_string(),
            display_name: "K".to_string(),
            size_bytes: 1,
            downloaded: false,
            downloading: false,
        };
        let ack = RecommendedModelAck {
            live: entry.clone(),
            finalize: None,
            diarization: entry,
            accel_label: "CPU".to_string(),
            gpu_class: GpuClass::None,
        };
        assert_eq!(
            crate::ts_mirror::rust_fields(&ack),
            crate::ts_mirror::ts_interface_fields(src, "RecommendedModelAck"),
            "models/transcript.ts RecommendedModelAck must carry exactly the Rust fields"
        );
        for class in [GpuClass::None, GpuClass::Integrated, GpuClass::Discrete] {
            let wire = serde_json::to_string(&class).unwrap();
            let wire = wire.trim_matches('"');
            assert!(
                src.contains(&format!("'{wire}'")),
                "models/transcript.ts GpuClass must carry '{wire}'"
            );
        }
        assert!(src.contains("export type GpuClass = 'none' | 'integrated' | 'discrete';"));
    }

    #[test]
    fn stop_and_transcribe_hand_the_speaker_mode_to_the_offline_pass() {
        let src = include_str!("transcription_cmd.rs");
        for name in ["stop_transcription", "transcribe_transcript"] {
            assert!(
                fn_body(src, name).contains("speaker_mode,\n"),
                "{name} must pass the Settings speaker mode to spawn_offline_pass"
            );
        }
        let body = fn_body(src, "spawn_offline_pass");
        assert!(
            body.find("WhisperCppTranscriber::load").unwrap() < body.find("offline_diarizer(").unwrap(),
            "the diarizer is handed over only after the pass survived the cancel check and loaded Whisper"
        );
    }

    #[test]
    fn try_begin_download_claims_then_rejects_a_second_claim() {
        let downloads = DownloadsHandle::default();
        let slot = try_begin_download(&downloads, "large-v3").unwrap();
        assert!(is_downloading(&downloads, "large-v3"));
        let err = try_begin_download(&downloads, "large-v3").err().unwrap();
        assert!(err.contains("already downloading"), "got: {err}");
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
    fn pick_offline_model_prefers_the_builds_finalize_model_then_any_downloaded() {
        let dir = tempfile::tempdir().unwrap();
        let store = ModelStore::with_root(dir.path());
        assert_eq!(pick_offline_model(&store), None);
        plant_model(dir.path(), "tiny");
        assert_eq!(pick_offline_model(&store).as_deref(), Some("tiny"));
        let best = speedwave_runtime::transcription::finalize_model_for_this_build().key;
        plant_model(dir.path(), best);
        assert_eq!(pick_offline_model(&store).as_deref(), Some(best));
    }

    #[tokio::test]
    async fn record_only_start_gate_requires_some_downloaded_model() {
        let dir = tempfile::tempdir().unwrap();
        let store: ModelStoreHandle = Arc::new(ModelStore::with_root(dir.path()));
        let e = match prepare_live_transcriber(false, &store).await {
            Ok(_) => panic!("expected the record-only gate to fail without a model"),
            Err(e) => e,
        };
        assert!(
            e.contains("no Whisper model") && e.contains("Settings"),
            "got: {e}"
        );
        plant_model(dir.path(), "tiny");
        assert!(prepare_live_transcriber(false, &store)
            .await
            .unwrap()
            .is_none());
    }

    #[test]
    fn pick_live_model_errors_with_a_download_hint_when_nothing_downloaded() {
        let dir = tempfile::tempdir().unwrap();
        let store = ModelStore::with_root(dir.path());
        let e = pick_live_model(
            &store,
            "large-v3-turbo",
            speedwave_runtime::transcription::GpuClass::Discrete,
        )
        .unwrap_err();
        assert!(
            e.contains("live-capable") && e.contains("Settings"),
            "got: {e}"
        );
        assert!(!e.contains("large-v3-turbo"));
    }

    /// Plants a catalogue model as "downloaded" (a sparse file of the expected size —
    /// presence checks are size-window based, the SHA runs only at download time).
    fn plant_model(root: &std::path::Path, key: &str) {
        let info = speedwave_runtime::transcription::whisper_model(key).unwrap();
        let dir = root.join("whisper");
        std::fs::create_dir_all(&dir).unwrap();
        let f = std::fs::File::create(dir.join(info.file)).unwrap();
        f.set_len(info.approx_bytes).unwrap();
    }

    #[test]
    fn pick_live_model_falls_back_only_to_models_live_capable_on_the_host_class() {
        use speedwave_runtime::transcription::GpuClass;
        let dir = tempfile::tempdir().unwrap();
        let store = ModelStore::with_root(dir.path());
        plant_model(dir.path(), "large-v3");
        let e = pick_live_model(&store, "large-v3-turbo", GpuClass::Discrete).unwrap_err();
        assert!(e.contains("live-capable"), "got: {e}");
        plant_model(dir.path(), "large-v3-turbo-q5_0");
        let e = pick_live_model(&store, "small", GpuClass::None).unwrap_err();
        assert!(e.contains("live-capable"), "got: {e}");
        plant_model(dir.path(), "small");
        assert_eq!(
            pick_live_model(&store, "large-v3-turbo", GpuClass::Discrete).unwrap(),
            "small"
        );
        assert_eq!(
            pick_live_model(&store, "medium", GpuClass::None).unwrap(),
            "small"
        );
    }

    #[test]
    fn source_label_falls_back_when_no_match() {
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
    fn an_imported_file_becomes_a_session_named_after_it_waiting_for_its_pass() {
        let src_dir = tempfile::tempdir().unwrap();
        let src = src_dir.path().join("Spotkanie zespołu Q4.wav");
        write_test_wav(&src, 1);
        let root = tempfile::tempdir().unwrap();
        let store = TranscriptStore::with_root(root.path());

        let session = import_audio_file(&store, &src, Language::En).unwrap();

        assert_eq!(store.get(session.id).unwrap(), session);
        assert_eq!(session.title.as_deref(), Some("Spotkanie zespołu Q4"));
        assert_eq!(session.language, Language::En);
        assert_eq!(session.audio_source.source, AudioSource::ImportedFile);
        assert_eq!(
            session.audio_source.label,
            "Imported file: Spotkanie zespołu Q4.wav"
        );
        assert_eq!(
            session.status,
            TranscriptStatus::Finalizing { progress: 0.0 }
        );
        assert_eq!(
            offline_pass_parts(&store, session.id).unwrap(),
            session.all_audio_parts()
        );
    }

    #[test]
    fn an_unreadable_import_names_the_file_and_leaves_no_session() {
        let src_dir = tempfile::tempdir().unwrap();
        let src = src_dir.path().join("voice memo.m4a");
        std::fs::write(&src, b"definitely not an mp4 container").unwrap();
        let root = tempfile::tempdir().unwrap();
        let store = TranscriptStore::with_root(root.path());

        let err = import_audio_file(&store, &src, Language::Pl).unwrap_err();

        assert!(
            err.starts_with("Could not import \"voice memo.m4a\": "),
            "{err}"
        );
        assert!(err.contains("not a readable M4A file"), "{err}");
        assert!(store.list().is_empty());
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
    }

    #[test]
    fn an_unsupported_import_lists_the_formats_it_takes() {
        let src_dir = tempfile::tempdir().unwrap();
        let src = src_dir.path().join("call.wma");
        std::fs::write(&src, b"whatever").unwrap();
        let root = tempfile::tempdir().unwrap();
        let store = TranscriptStore::with_root(root.path());

        let err = import_audio_file(&store, &src, Language::Pl).unwrap_err();

        assert!(err.contains("WAV, MP3, M4A, MP4, FLAC or OGG"), "{err}");
        assert!(store.list().is_empty());
    }

    #[test]
    fn the_import_command_takes_the_language_as_its_wire_name() {
        assert_eq!(
            serde_json::from_value::<Language>(serde_json::json!("pl")).unwrap(),
            Language::Pl
        );
        assert_eq!(
            serde_json::from_value::<Language>(serde_json::json!("en")).unwrap(),
            Language::En
        );
        assert!(serde_json::from_value::<Language>(serde_json::json!("de")).is_err());
    }

    #[test]
    fn an_imported_file_is_never_captured_or_continued() {
        use speedwave_runtime::transcription::CaptureCapabilities;
        let full = CaptureCapabilities {
            supports_system_audio: true,
            supports_microphone: true,
            note: None,
        };
        assert_eq!(
            validate_source_against_caps(&AudioSource::ImportedFile, &full).unwrap_err(),
            IMPORTED_FILE_NOT_CAPTURED
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
        assert!(validate_source_against_caps(&AudioSource::SystemWide, &full).is_ok());
        assert!(
            validate_source_against_caps(&AudioSource::Microphone { device: None }, &full).is_ok()
        );
        assert!(validate_source_against_caps(&AudioSource::Mixed { mic: None }, &full).is_ok());
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
        let no_sys = CaptureCapabilities {
            supports_system_audio: false,
            supports_microphone: true,
            note: None,
        };
        assert!(validate_source_against_caps(&AudioSource::SystemWide, &no_sys).is_err());
        assert!(validate_source_against_caps(&AudioSource::Mixed { mic: None }, &no_sys).is_err());
        assert!(
            validate_source_against_caps(&AudioSource::Microphone { device: None }, &no_sys)
                .is_ok()
        );
    }

    #[test]
    fn start_params_live_defaults_on_for_older_frontends() {
        let old: StartParams =
            serde_json::from_str(r#"{"source":{"kind":"system_wide"},"language":"pl"}"#).unwrap();
        assert!(old.live);
        let off: StartParams = serde_json::from_str(
            r#"{"source":{"kind":"system_wide"},"language":"pl","live":false}"#,
        )
        .unwrap();
        assert!(!off.live);
    }
}
