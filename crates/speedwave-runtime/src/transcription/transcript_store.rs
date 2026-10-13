//! Per-session state store + live event stream (snapshot + seq, like ADR-043's
//! history_plus_stream). Mutators atomically: update session, bump seq, push event, persist.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use dashmap::DashMap;
use parking_lot::RwLock;
use tokio::sync::broadcast;
use uuid::Uuid;

use crate::transcription::transcriber::Segment;
use crate::transcription::transcript::{
    normalize_title, TranscriptSession, TranscriptStatus, TranscriptSummary,
};

/// Capacity of each session's `broadcast` channel — generous enough that a slow subscriber
/// falls behind only after thousands of events; if it does, it re-subscribes via the snapshot.
const CHANNEL_CAPACITY: usize = 4096;

/// Capacity of the store-wide change channel; a lagging listener just re-reads the list.
const CHANGES_CAPACITY: usize = 256;

/// Failure reason of a session the app closed while it was recording or transcribing.
pub const INTERRUPTED_REASON: &str =
    "interrupted: Speedwave closed before this recording was transcribed";

/// Live events on a transcript stream. Every event carries a `seq` (1-indexed, monotonic per
/// session). Consumers apply events idempotently: ignore `seq <= last_applied`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum TranscriptEvent {
    /// A new live segment was decoded.
    SegmentAppended {
        /// Monotonic seq.
        seq: u64,
        /// The segment.
        segment: Segment,
    },
    /// The not-yet-committed tail of the latest live decode — replace-only
    /// display state; an empty string clears it.
    LiveDraft {
        /// Monotonic seq.
        seq: u64,
        /// The draft text.
        text: String,
    },
    /// The lifecycle status changed.
    StatusChanged {
        /// Monotonic seq.
        seq: u64,
        /// New status.
        status: TranscriptStatus,
    },
    /// Progress signal during the offline pass.
    FinalizeProgress {
        /// Monotonic seq.
        seq: u64,
        /// 0.0 → 1.0.
        progress: f32,
    },
    /// The offline pass produced `final_segments`; the UI swaps the live
    /// transcript for this higher-quality set.
    FinalSegmentsReady {
        /// Monotonic seq.
        seq: u64,
        /// The higher-quality offline segments.
        segments: Vec<Segment>,
    },
    /// The session reached `Done`; the snapshot reflects the final state.
    Finished {
        /// Monotonic seq.
        seq: u64,
    },
    /// A non-fatal capture-health warning (silent tap, one side stalled).
    CaptureWarning {
        /// Monotonic seq.
        seq: u64,
        /// What degraded.
        warning: crate::transcription::CaptureWarning,
    },
    /// A previously-raised capture-health warning recovered.
    CaptureWarningCleared {
        /// Monotonic seq.
        seq: u64,
        /// What recovered.
        warning: crate::transcription::CaptureWarning,
    },
    /// Throttled capture loudness (replace-only display state, never persisted): RMS 0..1 per
    /// channel, `[system, mic]` on paired captures, one entry on mono ones (ADR-056 Am. 13).
    AudioLevel {
        /// Monotonic seq.
        seq: u64,
        /// Latest per-channel RMS.
        levels: Vec<f32>,
    },
}

impl TranscriptEvent {
    /// `seq` carried by this event.
    pub fn seq(&self) -> u64 {
        match self {
            TranscriptEvent::SegmentAppended { seq, .. }
            | TranscriptEvent::LiveDraft { seq, .. }
            | TranscriptEvent::StatusChanged { seq, .. }
            | TranscriptEvent::FinalizeProgress { seq, .. }
            | TranscriptEvent::FinalSegmentsReady { seq, .. }
            | TranscriptEvent::Finished { seq, .. }
            | TranscriptEvent::CaptureWarning { seq, .. }
            | TranscriptEvent::CaptureWarningCleared { seq, .. }
            | TranscriptEvent::AudioLevel { seq, .. } => *seq,
        }
    }
}

/// What `subscribe()` returns: a current-state snapshot plus a stream of future events.
/// Consumers replay the snapshot first, then apply events with `seq > snapshot.last_seq`.
#[derive(Debug)]
pub struct Subscription {
    /// Current session state.
    pub snapshot: TranscriptSession,
    /// Stream of future events.
    pub events: broadcast::Receiver<TranscriptEvent>,
}

/// Errors the store can surface.
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    /// No such session id.
    #[error("no such transcript session: {0}")]
    NotFound(Uuid),
    /// The session's current state forbids the requested transition.
    #[error("invalid transcript state: {0}")]
    InvalidState(String),
    /// Filesystem error.
    #[error("transcript store I/O error: {0}")]
    Io(#[from] std::io::Error),
}

/// Per-session: the live session struct + its broadcast channel.
struct Entry {
    session: Arc<RwLock<TranscriptSession>>,
    tx: broadcast::Sender<TranscriptEvent>,
}

/// Per-session state store + live event stream: `<root>/<uuid>/{transcript.json,audio.wav}`.
/// Caches active sessions (`list()` walks disk for inactive); mutators bump seq, emit, persist.
pub struct TranscriptStore {
    root: PathBuf,
    sessions: Arc<DashMap<Uuid, Entry>>,
    changes: broadcast::Sender<Uuid>,
    queued: parking_lot::Mutex<std::collections::HashSet<Uuid>>,
}

/// Drains the raised capture warnings into one recovery event each, starting at `next_seq` —
/// the set retires through the stream, not just in the snapshot.
fn drain_capture_warnings(s: &mut TranscriptSession, next_seq: u64) -> Vec<TranscriptEvent> {
    std::mem::take(&mut s.active_warnings)
        .into_iter()
        .enumerate()
        .map(|(i, warning)| TranscriptEvent::CaptureWarningCleared {
            seq: next_seq + i as u64,
            warning,
        })
        .collect()
}

impl TranscriptStore {
    /// A store rooted at `<data_dir>/transcripts/`.
    pub fn new() -> Self {
        Self::with_root(crate::transcription::transcripts_dir())
    }

    /// A store rooted at an arbitrary directory.
    pub fn with_root(root: impl Into<PathBuf>) -> Self {
        let (changes, _) = broadcast::channel(CHANGES_CAPACITY);
        Self {
            root: root.into(),
            sessions: Arc::new(DashMap::new()),
            changes,
            queued: parking_lot::Mutex::new(std::collections::HashSet::new()),
        }
    }

    /// Ids of sessions whose recordings-list row changed (created, renamed, deleted, or a new
    /// status or progress), so the list refreshes on change instead of polling.
    pub fn watch(&self) -> broadcast::Receiver<Uuid> {
        self.changes.subscribe()
    }

    /// Per-session directory `<root>/<id>/`.
    pub fn session_dir(&self, id: Uuid) -> PathBuf {
        self.root.join(id.to_string())
    }

    /// Inserts `session` (creating its directory and persisting `transcript.json`).
    /// Returns its id (already on `session.id`).
    pub fn create(&self, session: TranscriptSession) -> Result<Uuid, StoreError> {
        let id = session.id;
        let dir = self.session_dir(id);
        std::fs::create_dir_all(&dir)?;
        restrict_dir_perms(&dir);
        session.save(&dir)?;
        let (tx, _) = broadcast::channel(CHANNEL_CAPACITY);
        self.sessions.insert(
            id,
            Entry {
                session: Arc::new(RwLock::new(session)),
                tx,
            },
        );
        self.notify(id);
        Ok(id)
    }

    /// Returns a snapshot of session `id` (loads from disk if not in cache).
    pub fn get(&self, id: Uuid) -> Result<TranscriptSession, StoreError> {
        if let Some(e) = self.sessions.get(&id) {
            return Ok(e.session.read().clone());
        }
        let dir = self.session_dir(id);
        if !dir.is_dir() {
            return Err(StoreError::NotFound(id));
        }
        Ok(TranscriptSession::load(&dir)?)
    }

    /// One summary per session directory, newest first. Corrupt `transcript.json` files are
    /// skipped (logged warn — runtime recovery, not panic).
    pub fn list(&self) -> Vec<TranscriptSummary> {
        let queued = self.queued.lock().clone();
        self.sessions_on_disk()
            .iter()
            .map(|s| {
                let mut row = s.summary(&self.session_dir(s.id));
                row.queued = queued.contains(&s.id);
                row
            })
            .collect()
    }

    /// Marks whether a session's offline pass waits for another one; the list row shows it.
    pub fn set_queued(&self, id: Uuid, queued: bool) {
        let changed = {
            let mut set = self.queued.lock();
            if queued {
                set.insert(id)
            } else {
                set.remove(&id)
            }
        };
        if changed {
            self.notify(id);
        }
    }

    /// Records the model the offline pass runs with, before it starts, so the UI can say which.
    pub fn set_finalize_model(&self, id: Uuid, model: &str) -> Result<(), StoreError> {
        self.with_session_batch(id, |s, _| {
            s.models_used.finalize = Some(model.to_string());
            Vec::new()
        })?;
        self.notify(id);
        Ok(())
    }

    /// Marks every session left `Recording` or `Finalizing` by an earlier run as failed with
    /// [`INTERRUPTED_REASON`], after repairing the WAV headers its unfinished writer left at zero,
    /// so the offline pass can transcribe it again. Run once at startup, before any recording.
    pub fn reconcile_interrupted(&self) -> usize {
        let mut reconciled = 0;
        for session in self.sessions_on_disk() {
            if !matches!(
                session.status,
                TranscriptStatus::Recording | TranscriptStatus::Finalizing { .. }
            ) || self.sessions.contains_key(&session.id)
            {
                continue;
            }
            for part in session.all_audio_parts() {
                if let Err(e) = crate::transcription::audio::repair_wav_header(&part) {
                    if e.kind() != std::io::ErrorKind::NotFound {
                        log::warn!("transcript {}: WAV header repair failed: {e}", session.id);
                    }
                }
            }
            let failed = TranscriptStatus::Failed {
                reason: INTERRUPTED_REASON.to_string(),
            };
            match self.set_status(session.id, failed) {
                Ok(_) => reconciled += 1,
                Err(e) => log::warn!("transcript {}: reconcile failed: {e}", session.id),
            }
        }
        reconciled
    }

    /// Every session on disk (in-memory copy for active ones), newest first.
    fn sessions_on_disk(&self) -> Vec<TranscriptSession> {
        let Ok(entries) = std::fs::read_dir(&self.root) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for entry in entries.flatten() {
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let Some(name) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            let Ok(id) = Uuid::parse_str(&name) else {
                continue;
            };
            if let Some(e) = self.sessions.get(&id) {
                out.push(e.session.read().clone());
                continue;
            }
            match TranscriptSession::load(&entry.path()) {
                Ok(s) => out.push(s),
                Err(e) => log::warn!("transcript {id}: load failed, skipping: {e}"),
            }
        }
        out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        out
    }

    /// Removes the session directory + drops the in-memory entry.
    pub fn delete(&self, id: Uuid) -> Result<(), StoreError> {
        use dashmap::mapref::entry::Entry as MapEntry;
        let dir = self.session_dir(id);
        let remove_dir = || -> std::io::Result<()> {
            if dir.exists() {
                std::fs::remove_dir_all(&dir)?;
            }
            Ok(())
        };
        match self.sessions.entry(id) {
            MapEntry::Occupied(e) => {
                let session = e.get().session.clone();
                let _locked = session.write();
                remove_dir()?;
                e.remove();
            }
            MapEntry::Vacant(_) => remove_dir()?,
        }
        self.notify(id);
        Ok(())
    }

    /// Renames a session; a blank title clears it. Returns the stored (normalised) title.
    pub fn rename(&self, id: Uuid, title: &str) -> Result<Option<String>, StoreError> {
        let title = normalize_title(title);
        self.with_session_batch(id, |s, _| {
            s.title = title.clone();
            Vec::new()
        })?;
        self.notify(id);
        Ok(title)
    }

    /// Moves a `Failed` or `Done` session to `Finalizing` for another offline pass over its
    /// recorded parts, retiring its warnings; refuses any other state so two runs never overlap.
    pub fn begin_retranscribe(&self, id: Uuid) -> Result<u64, StoreError> {
        let mut seq_out = 0;
        let mut allowed = false;
        self.with_session_batch(id, |s, next_seq| {
            if !matches!(
                s.status,
                TranscriptStatus::Failed { .. } | TranscriptStatus::Done
            ) {
                return Vec::new();
            }
            allowed = true;
            let mut events = drain_capture_warnings(s, next_seq);
            let status = TranscriptStatus::Finalizing { progress: 0.0 };
            s.status = status.clone();
            seq_out = next_seq + events.len() as u64;
            events.push(TranscriptEvent::StatusChanged {
                seq: seq_out,
                status,
            });
            events
        })?;
        if !allowed {
            return Err(StoreError::InvalidState(
                "only a finished or failed recording can be transcribed again".to_string(),
            ));
        }
        self.notify(id);
        Ok(seq_out)
    }

    /// Snapshot + future-event stream. Activates the session in cache if it
    /// was only on disk so far (so subsequent mutators have a broadcast channel).
    pub fn subscribe(&self, id: Uuid) -> Result<Subscription, StoreError> {
        let entry = self.activate(id)?;
        let snapshot = entry.session.read().clone();
        let events = entry.tx.subscribe();
        Ok(Subscription { snapshot, events })
    }

    /// Number of in-memory active sessions (for tests).
    #[cfg(test)]
    pub fn active_count(&self) -> usize {
        self.sessions.len()
    }

    /// Loads `id` into cache if needed; returns its `Entry`. Atomic against concurrent callers:
    /// the entry living in `sessions` is the one returned, so no subscriber holds an orphaned `tx`.
    fn activate(&self, id: Uuid) -> Result<EntryHandle, StoreError> {
        use dashmap::mapref::entry::Entry as MapEntry;
        match self.sessions.entry(id) {
            MapEntry::Occupied(e) => Ok(EntryHandle {
                session: e.get().session.clone(),
                tx: e.get().tx.clone(),
            }),
            MapEntry::Vacant(slot) => {
                let dir = self.session_dir(id);
                if !dir.is_dir() {
                    return Err(StoreError::NotFound(id));
                }
                let session = TranscriptSession::load(&dir)?;
                let (tx, _) = broadcast::channel(CHANNEL_CAPACITY);
                let entry = Entry {
                    session: Arc::new(RwLock::new(session)),
                    tx,
                };
                let handle = EntryHandle {
                    session: entry.session.clone(),
                    tx: entry.tx.clone(),
                };
                slot.insert(entry);
                Ok(handle)
            }
        }
    }

    /// Helper: lock-mutate-persist-emit. Bumps `last_seq`, runs `mutate` with
    /// the new seq (so it can attach it to the event), persists, and emits.
    fn with_session<F>(&self, id: Uuid, mutate: F) -> Result<(), StoreError>
    where
        F: FnOnce(&mut TranscriptSession, u64) -> TranscriptEvent,
    {
        self.with_session_batch(id, |s, next_seq| vec![mutate(s, next_seq)])
            .map(|_| ())
    }

    /// Like [`Self::with_session`], but `mutate` (called with the next seq) returns every event
    /// to emit for one lock + save — one fsync'd write for the whole batch.
    fn with_session_batch<F>(&self, id: Uuid, mutate: F) -> Result<Vec<TranscriptEvent>, StoreError>
    where
        F: FnOnce(&mut TranscriptSession, u64) -> Vec<TranscriptEvent>,
    {
        self.with_session_inner(id, true, mutate)
    }

    /// Like [`Self::with_session`], but never touches disk — for `#[serde(skip)]` fields (e.g.
    /// `live_draft`) where a save would persist nothing. Seq still bumps in-memory and broadcasts.
    fn with_session_no_save<F>(&self, id: Uuid, mutate: F) -> Result<(), StoreError>
    where
        F: FnOnce(&mut TranscriptSession, u64) -> TranscriptEvent,
    {
        self.with_session_inner(id, false, |s, next_seq| vec![mutate(s, next_seq)])
            .map(|_| ())
    }

    /// Shared lock-mutate-persist-emit body; `save` toggles the disk write.
    fn with_session_inner<F>(
        &self,
        id: Uuid,
        save: bool,
        mutate: F,
    ) -> Result<Vec<TranscriptEvent>, StoreError>
    where
        F: FnOnce(&mut TranscriptSession, u64) -> Vec<TranscriptEvent>,
    {
        let h = self.activate(id)?;
        let dir = self.session_dir(id);
        let events;
        {
            let mut s = h.session.write();
            if save && !dir.is_dir() {
                return Err(StoreError::NotFound(id));
            }
            let next_seq = s.last_seq + 1;
            events = mutate(&mut s, next_seq);
            s.last_seq += events.len() as u64;
            if save {
                s.save(&dir)?;
            }
            for event in &events {
                let _ = h.tx.send(event.clone());
            }
        }
        Ok(events)
    }

    /// Appends a new live segment.
    pub fn append_segment(&self, id: Uuid, segment: Segment) -> Result<u64, StoreError> {
        let mut seq_out = 0;
        self.with_session(id, |s, seq| {
            seq_out = seq;
            s.live_segments.push(segment.clone());
            TranscriptEvent::SegmentAppended { seq, segment }
        })?;
        Ok(seq_out)
    }

    /// Appends multiple live segments as a single fsync'd save (one decode-window's commits at
    /// once). Returns each segment's assigned seq, in order; a no-op when `segments` is empty.
    pub fn append_segments(
        &self,
        id: Uuid,
        segments: Vec<Segment>,
    ) -> Result<Vec<u64>, StoreError> {
        if segments.is_empty() {
            return Ok(Vec::new());
        }
        let events = self.with_session_batch(id, |s, first_seq| {
            segments
                .into_iter()
                .enumerate()
                .map(|(i, segment)| {
                    let seq = first_seq + i as u64;
                    s.live_segments.push(segment.clone());
                    TranscriptEvent::SegmentAppended { seq, segment }
                })
                .collect()
        })?;
        Ok(events.iter().map(TranscriptEvent::seq).collect())
    }

    /// Publishes the uncommitted live-decode tail (replace-only; `""` clears it). Called on every
    /// ~5s decode cycle while the draft churns, so this never hits disk — see `with_session_no_save`.
    pub fn live_draft(&self, id: Uuid, text: String) -> Result<u64, StoreError> {
        let mut seq_out = 0;
        self.with_session_no_save(id, |s, seq| {
            seq_out = seq;
            s.live_draft = text.clone();
            TranscriptEvent::LiveDraft { seq, text }
        })?;
        Ok(seq_out)
    }

    /// Broadcasts the latest capture loudness (display state only — never hits disk) without
    /// waiting for the session lock: a skipped frame (`Ok(0)`) beats stalling the ingest thread.
    pub fn audio_level(&self, id: Uuid, levels: Vec<f32>) -> Result<u64, StoreError> {
        let h = self.activate(id)?;
        let Some(mut s) = h.session.try_write() else {
            return Ok(0);
        };
        let seq = s.last_seq + 1;
        s.last_seq = seq;
        let _ = h.tx.send(TranscriptEvent::AudioLevel { seq, levels });
        drop(s);
        Ok(seq)
    }

    /// Sets the status; leaving `Recording` retires the raised capture warnings, emitting a
    /// recovery event for each so subscribers converge on what the snapshot reports.
    pub fn set_status(&self, id: Uuid, status: TranscriptStatus) -> Result<u64, StoreError> {
        let mut seq_out = 0;
        self.with_session_batch(id, |s, next_seq| {
            let leaving_capture = matches!(s.status, TranscriptStatus::Recording)
                && !matches!(status, TranscriptStatus::Recording);
            let mut events = if leaving_capture {
                drain_capture_warnings(s, next_seq)
            } else {
                Vec::new()
            };
            s.status = status.clone();
            seq_out = next_seq + events.len() as u64;
            events.push(TranscriptEvent::StatusChanged {
                seq: seq_out,
                status,
            });
            events
        })?;
        self.notify(id);
        Ok(seq_out)
    }

    /// Reopens a `Done` session for more recording (ADR-056 Am. 10): finals become the live
    /// baseline, a new part registers, and `models_used.live` = `live_model` (UI keys on it).
    pub fn resume(
        &self,
        id: Uuid,
        next_part: std::path::PathBuf,
        live_model: Option<String>,
    ) -> Result<u64, StoreError> {
        let mut seq_out = 0;
        let mut resumable = false;
        self.with_session_batch(id, |s, seq| {
            if !matches!(s.status, TranscriptStatus::Done) {
                return Vec::new();
            }
            resumable = true;
            s.prior_active_warnings = s.active_warnings.clone();
            let mut events = drain_capture_warnings(s, seq);
            if let Some(finals) = s.final_segments.take() {
                s.live_segments = finals;
            }
            s.audio_parts.push(next_part.clone());
            s.prior_live_model = s.models_used.live.take();
            s.models_used.live = live_model.clone();
            s.status = TranscriptStatus::Recording;
            seq_out = seq + events.len() as u64;
            events.push(TranscriptEvent::StatusChanged {
                seq: seq_out,
                status: TranscriptStatus::Recording,
            });
            events
        })?;
        if !resumable {
            return Err(StoreError::InvalidState(
                "only a finished recording can be resumed".to_string(),
            ));
        }
        self.notify(id);
        Ok(seq_out)
    }

    /// Reverts a [`Self::resume`] whose capture never started: drops the just-registered
    /// part, restores the finals baseline, live model and capture warnings, and returns to `Done`.
    pub fn rollback_resume(&self, id: Uuid, expected_part: &Path) -> Result<u64, StoreError> {
        let mut seq_out = 0;
        let mut rolled_back = false;
        self.with_session_batch(id, |s, seq| {
            if !matches!(s.status, TranscriptStatus::Recording)
                || s.audio_parts.last().map(PathBuf::as_path) != Some(expected_part)
            {
                return Vec::new();
            }
            rolled_back = true;
            s.audio_parts.pop();
            s.final_segments = Some(std::mem::take(&mut s.live_segments));
            s.models_used.live = s.prior_live_model.take();
            s.active_warnings = std::mem::take(&mut s.prior_active_warnings);
            s.status = TranscriptStatus::Done;
            let mut events: Vec<TranscriptEvent> = s
                .active_warnings
                .iter()
                .enumerate()
                .map(|(i, warning)| TranscriptEvent::CaptureWarning {
                    seq: seq + i as u64,
                    warning: *warning,
                })
                .collect();
            seq_out = seq + events.len() as u64;
            events.push(TranscriptEvent::StatusChanged {
                seq: seq_out,
                status: TranscriptStatus::Done,
            });
            events
        })?;
        if !rolled_back {
            return Err(StoreError::InvalidState(
                "session is not in a just-resumed state".to_string(),
            ));
        }
        self.notify(id);
        Ok(seq_out)
    }

    /// Records a raised capture-health warning on the session and emits its event.
    pub fn capture_warning(
        &self,
        id: Uuid,
        warning: crate::transcription::CaptureWarning,
    ) -> Result<u64, StoreError> {
        let mut seq_out = 0;
        self.with_session(id, |s, seq| {
            seq_out = seq;
            if !s.active_warnings.contains(&warning) {
                s.active_warnings.push(warning);
            }
            TranscriptEvent::CaptureWarning { seq, warning }
        })?;
        Ok(seq_out)
    }

    /// Clears one raised capture-health warning from the session and emits its recovery event.
    pub fn capture_warning_cleared(
        &self,
        id: Uuid,
        warning: crate::transcription::CaptureWarning,
    ) -> Result<u64, StoreError> {
        let mut seq_out = 0;
        self.with_session(id, |s, seq| {
            seq_out = seq;
            s.active_warnings.retain(|w| *w != warning);
            TranscriptEvent::CaptureWarningCleared { seq, warning }
        })?;
        Ok(seq_out)
    }

    /// Finalize-progress signal.
    pub fn finalize_progress(&self, id: Uuid, progress: f32) -> Result<u64, StoreError> {
        let mut seq_out = 0;
        self.with_session(id, |s, seq| {
            seq_out = seq;
            s.status = TranscriptStatus::Finalizing { progress };
            TranscriptEvent::FinalizeProgress { seq, progress }
        })?;
        self.notify(id);
        Ok(seq_out)
    }

    /// Installs the offline pass's `final_segments` and emits `FinalSegmentsReady` so an open
    /// UI swaps the live transcript for the higher-quality one.
    pub fn set_final_segments(
        &self,
        id: Uuid,
        final_segs: Vec<Segment>,
    ) -> Result<u64, StoreError> {
        let mut seq_out = 0;
        self.with_session(id, |s, seq| {
            seq_out = seq;
            s.set_final_segments(final_segs);
            let segments = s.final_segments.clone().unwrap_or_default();
            TranscriptEvent::FinalSegmentsReady { seq, segments }
        })?;
        self.notify(id);
        Ok(seq_out)
    }

    /// Marks a session done and returns the emitted event sequence number.
    pub fn finish(&self, id: Uuid) -> Result<u64, StoreError> {
        let mut seq_out = 0;
        self.with_session(id, |s, seq| {
            seq_out = seq;
            s.status = TranscriptStatus::Done;
            TranscriptEvent::Finished { seq }
        })?;
        self.notify(id);
        Ok(seq_out)
    }

    fn notify(&self, id: Uuid) {
        let _ = self.changes.send(id);
    }
}

impl Default for TranscriptStore {
    fn default() -> Self {
        Self::new()
    }
}

struct EntryHandle {
    session: Arc<RwLock<TranscriptSession>>,
    tx: broadcast::Sender<TranscriptEvent>,
}

fn restrict_dir_perms(dir: &Path) {
    if let Err(e) = crate::fs_perms::set_owner_only_dir(dir) {
        log::warn!("failed to restrict permissions on {}: {e}", dir.display());
    }
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code: unwrap on fixtures is the sanctioned boundary"
)]
mod tests {
    use super::*;
    use crate::transcription::audio::{AudioSource, AudioSourceInfo};
    use crate::transcription::transcriber::Language;
    use std::time::Duration;

    fn mk_session(audio_path: &Path) -> TranscriptSession {
        TranscriptSession::new(
            Language::Pl,
            AudioSourceInfo {
                source: AudioSource::SystemWide,
                label: "System".to_string(),
            },
            audio_path.to_path_buf(),
        )
    }
    fn seg(start_s: f32, end_s: f32, text: &str) -> Segment {
        Segment {
            start: Duration::from_secs_f32(start_s),
            end: Duration::from_secs_f32(end_s),
            text: text.to_string(),
            words: vec![],
            source: None,
        }
    }

    #[tokio::test]
    async fn capture_warning_bumps_seq_broadcasts_and_persists_last_seq() {
        let dir = tempfile::tempdir().unwrap();
        let store = TranscriptStore::with_root(dir.path());
        let id = store.create(mk_session(&dir.path().join("a.wav"))).unwrap();
        let mut sub = store.subscribe(id).unwrap();
        let seq = store
            .capture_warning(id, crate::transcription::CaptureWarning::MicrophoneStalled)
            .unwrap();
        assert_eq!(seq, 1);
        match sub.events.try_recv().unwrap() {
            TranscriptEvent::CaptureWarning { seq: s, warning } => {
                assert_eq!(s, seq);
                assert_eq!(
                    warning,
                    crate::transcription::CaptureWarning::MicrophoneStalled
                );
            }
            other => panic!("unexpected event: {other:?}"),
        }
        let snap = store.get(id).unwrap();
        assert_eq!(snap.last_seq, seq);
        assert_eq!(
            snap.active_warnings,
            vec![crate::transcription::CaptureWarning::MicrophoneStalled]
        );
        assert!(snap.live_segments.is_empty());
    }

    #[tokio::test]
    async fn concurrent_warnings_accumulate_and_clear_one_at_a_time() {
        use crate::transcription::CaptureWarning;
        let dir = tempfile::tempdir().unwrap();
        let store = TranscriptStore::with_root(dir.path());
        let id = store.create(mk_session(&dir.path().join("a.wav"))).unwrap();

        store
            .capture_warning(id, CaptureWarning::MicrophoneStalled)
            .unwrap();
        store
            .capture_warning(id, CaptureWarning::AudioDropped)
            .unwrap();
        assert_eq!(
            store.get(id).unwrap().active_warnings,
            vec![
                CaptureWarning::MicrophoneStalled,
                CaptureWarning::AudioDropped
            ],
            "both conditions are live at once, in arrival order"
        );

        store
            .capture_warning(id, CaptureWarning::MicrophoneStalled)
            .unwrap();
        assert_eq!(
            store.get(id).unwrap().active_warnings,
            vec![
                CaptureWarning::MicrophoneStalled,
                CaptureWarning::AudioDropped
            ]
        );

        store
            .capture_warning_cleared(id, CaptureWarning::AudioDropped)
            .unwrap();
        assert_eq!(
            store.get(id).unwrap().active_warnings,
            vec![CaptureWarning::MicrophoneStalled],
            "a recovery clears only its own variant"
        );

        store
            .capture_warning_cleared(id, CaptureWarning::SystemAudioSilent)
            .unwrap();
        assert_eq!(
            store.get(id).unwrap().active_warnings,
            vec![CaptureWarning::MicrophoneStalled]
        );
    }

    #[tokio::test]
    async fn leaving_recording_retires_the_warnings_through_the_event_stream() {
        use crate::transcription::CaptureWarning;
        let dir = tempfile::tempdir().unwrap();
        let store = TranscriptStore::with_root(dir.path());
        let id = store.create(mk_session(&dir.path().join("a.wav"))).unwrap();
        store
            .capture_warning(id, CaptureWarning::SystemAudioStalled)
            .unwrap();
        let reloaded = TranscriptStore::with_root(dir.path());
        assert_eq!(
            reloaded.get(id).unwrap().active_warnings,
            vec![CaptureWarning::SystemAudioStalled]
        );

        let mut sub = store.subscribe(id).unwrap();
        store
            .set_status(id, TranscriptStatus::Finalizing { progress: 0.0 })
            .unwrap();
        assert!(store.get(id).unwrap().active_warnings.is_empty());
        match sub.events.try_recv().unwrap() {
            TranscriptEvent::CaptureWarningCleared { warning, .. } => {
                assert_eq!(warning, CaptureWarning::SystemAudioStalled);
            }
            other => panic!("expected the warning to be retired first, got {other:?}"),
        }
        match sub.events.try_recv().unwrap() {
            TranscriptEvent::StatusChanged { .. } => {}
            other => panic!("unexpected event: {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_warning_raised_by_the_offline_pass_survives_to_done() {
        use crate::transcription::CaptureWarning;
        let dir = tempfile::tempdir().unwrap();
        let store = TranscriptStore::with_root(dir.path());
        let id = store.create(mk_session(&dir.path().join("a.wav"))).unwrap();
        store
            .set_status(id, TranscriptStatus::Finalizing { progress: 0.0 })
            .unwrap();
        store
            .capture_warning(id, CaptureWarning::RecordingPartMissing)
            .unwrap();
        store.set_status(id, TranscriptStatus::Done).unwrap();
        assert_eq!(
            store.get(id).unwrap().active_warnings,
            vec![CaptureWarning::RecordingPartMissing]
        );
    }

    #[tokio::test]
    async fn a_resumed_session_starts_with_no_raised_warnings() {
        use crate::transcription::CaptureWarning;
        let dir = tempfile::tempdir().unwrap();
        let store = TranscriptStore::with_root(dir.path());
        let id = store.create(mk_session(&dir.path().join("a.wav"))).unwrap();
        store
            .set_status(id, TranscriptStatus::Finalizing { progress: 0.0 })
            .unwrap();
        store
            .capture_warning(id, CaptureWarning::RecordingPartMissing)
            .unwrap();
        store.set_status(id, TranscriptStatus::Done).unwrap();

        store
            .resume(
                id,
                dir.path().join("audio-2.wav"),
                Some("small".to_string()),
            )
            .unwrap();
        assert!(
            store.get(id).unwrap().active_warnings.is_empty(),
            "nothing retracts RecordingPartMissing, so a new capture would carry it forever"
        );
    }

    #[tokio::test]
    async fn rolling_back_a_resume_restores_the_warnings_it_drained() {
        use crate::transcription::CaptureWarning;
        let dir = tempfile::tempdir().unwrap();
        let store = TranscriptStore::with_root(dir.path());
        let id = store.create(mk_session(&dir.path().join("a.wav"))).unwrap();
        store
            .set_status(id, TranscriptStatus::Finalizing { progress: 0.0 })
            .unwrap();
        store
            .capture_warning(id, CaptureWarning::RecordingPartMissing)
            .unwrap();
        store.set_status(id, TranscriptStatus::Done).unwrap();

        let part2 = dir.path().join("audio-2.wav");
        store.resume(id, part2.clone(), None).unwrap();
        let mut sub = store.subscribe(id).unwrap();
        store.rollback_resume(id, &part2).unwrap();

        assert_eq!(
            store.get(id).unwrap().active_warnings,
            vec![CaptureWarning::RecordingPartMissing]
        );
        match sub.events.try_recv().unwrap() {
            TranscriptEvent::CaptureWarning { warning, .. } => {
                assert_eq!(warning, CaptureWarning::RecordingPartMissing);
            }
            other => panic!("expected the warning to be re-raised first, got {other:?}"),
        }
        match sub.events.try_recv().unwrap() {
            TranscriptEvent::StatusChanged { status, .. } => {
                assert!(matches!(status, TranscriptStatus::Done));
            }
            other => panic!("unexpected event: {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_rolled_back_resume_does_not_re_raise_on_a_healthy_session() {
        let dir = tempfile::tempdir().unwrap();
        let store = TranscriptStore::with_root(dir.path());
        let id = store.create(mk_session(&dir.path().join("a.wav"))).unwrap();
        store.set_status(id, TranscriptStatus::Done).unwrap();

        let part2 = dir.path().join("audio-2.wav");
        store.resume(id, part2.clone(), None).unwrap();
        let mut sub = store.subscribe(id).unwrap();
        store.rollback_resume(id, &part2).unwrap();

        assert!(store.get(id).unwrap().active_warnings.is_empty());
        match sub.events.try_recv().unwrap() {
            TranscriptEvent::StatusChanged { status, .. } => {
                assert!(matches!(status, TranscriptStatus::Done));
            }
            other => panic!("a healthy session must emit no warning, got {other:?}"),
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn create_sets_owner_only_perms_on_session_dir() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let store = TranscriptStore::with_root(dir.path());
        let id = store.create(mk_session(&dir.path().join("a.wav"))).unwrap();

        let mode = std::fs::metadata(store.session_dir(id))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o700, "expected 0o700, got 0o{mode:o}");
    }

    #[tokio::test]
    async fn create_get_list_delete_round_trip_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let store = TranscriptStore::with_root(dir.path());
        let id = store.create(mk_session(&dir.path().join("a.wav"))).unwrap();
        assert_eq!(store.get(id).unwrap().id, id);
        let listed = store.list();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, id);
        store.delete(id).unwrap();
        assert!(matches!(
            store.get(id).unwrap_err(),
            StoreError::NotFound(_)
        ));
        assert!(store.list().is_empty());
    }

    #[tokio::test]
    async fn get_after_dropping_cache_loads_from_disk() {
        let dir = tempfile::tempdir().unwrap();
        let store = TranscriptStore::with_root(dir.path());
        let id = store.create(mk_session(&dir.path().join("a.wav"))).unwrap();
        store.sessions.remove(&id);
        assert_eq!(store.active_count(), 0);
        let loaded = store.get(id).unwrap();
        assert_eq!(loaded.id, id);
    }

    #[tokio::test]
    async fn subscribe_after_some_events_returns_a_snapshot_plus_future_events() {
        let dir = tempfile::tempdir().unwrap();
        let store = TranscriptStore::with_root(dir.path());
        let id = store.create(mk_session(&dir.path().join("a.wav"))).unwrap();
        let seq1 = store.append_segment(id, seg(0.0, 1.0, "first")).unwrap();
        let seq2 = store.append_segment(id, seg(1.0, 2.0, "second")).unwrap();
        let sub = store.subscribe(id).unwrap();
        assert_eq!(sub.snapshot.live_segments.len(), 2);
        assert_eq!(sub.snapshot.last_seq, seq2);
        assert_eq!(seq2, seq1 + 1, "seq is monotonic");
        let mut rx = sub.events;
        let seq3 = store.append_segment(id, seg(2.0, 3.0, "third")).unwrap();
        let ev = rx.recv().await.unwrap();
        assert_eq!(ev.seq(), seq3);
        match ev {
            TranscriptEvent::SegmentAppended { segment, .. } => {
                assert_eq!(segment.text, "third");
            }
            other => panic!("expected SegmentAppended, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn append_segments_persists_a_whole_batch_as_one_save_with_monotonic_seqs() {
        let dir = tempfile::tempdir().unwrap();
        let store = TranscriptStore::with_root(dir.path());
        let id = store.create(mk_session(&dir.path().join("a.wav"))).unwrap();
        let mut rx = store.subscribe(id).unwrap().events;

        let seqs = store
            .append_segments(
                id,
                vec![
                    seg(0.0, 1.0, "one"),
                    seg(1.0, 2.0, "two"),
                    seg(2.0, 3.0, "three"),
                ],
            )
            .unwrap();
        assert_eq!(seqs, vec![1, 2, 3]);

        let snap = store.get(id).unwrap();
        assert_eq!(snap.last_seq, 3);
        let texts: Vec<&str> = snap.live_segments.iter().map(|s| s.text.as_str()).collect();
        assert_eq!(texts, vec!["one", "two", "three"]);

        for (expected_seq, expected_text) in [(1, "one"), (2, "two"), (3, "three")] {
            let ev = rx.recv().await.unwrap();
            match ev {
                TranscriptEvent::SegmentAppended { seq, segment } => {
                    assert_eq!(seq, expected_seq);
                    assert_eq!(segment.text, expected_text);
                }
                other => panic!("expected SegmentAppended, got {other:?}"),
            }
        }
    }

    #[tokio::test]
    async fn append_segments_with_an_empty_batch_is_a_noop() {
        let dir = tempfile::tempdir().unwrap();
        let store = TranscriptStore::with_root(dir.path());
        let id = store.create(mk_session(&dir.path().join("a.wav"))).unwrap();

        let seqs = store.append_segments(id, vec![]).unwrap();
        assert!(seqs.is_empty());
        assert_eq!(store.get(id).unwrap().last_seq, 0);
    }

    #[tokio::test]
    async fn append_segments_continues_the_seq_sequence_from_a_prior_mutator() {
        let dir = tempfile::tempdir().unwrap();
        let store = TranscriptStore::with_root(dir.path());
        let id = store.create(mk_session(&dir.path().join("a.wav"))).unwrap();
        let seq0 = store.append_segment(id, seg(0.0, 1.0, "zero")).unwrap();
        assert_eq!(seq0, 1);

        let seqs = store
            .append_segments(id, vec![seg(1.0, 2.0, "a"), seg(2.0, 3.0, "b")])
            .unwrap();
        assert_eq!(seqs, vec![2, 3]);
        assert_eq!(store.get(id).unwrap().last_seq, 3);
    }

    #[tokio::test]
    async fn every_mutator_bumps_seq_and_persists_and_emits() {
        let dir = tempfile::tempdir().unwrap();
        let store = TranscriptStore::with_root(dir.path());
        let id = store.create(mk_session(&dir.path().join("a.wav"))).unwrap();
        let mut rx = store.subscribe(id).unwrap().events;
        let s1 = store.append_segment(id, seg(0.0, 1.0, "a")).unwrap();
        let s2 = store
            .capture_warning(id, crate::transcription::CaptureWarning::SystemAudioSilent)
            .unwrap();
        let s3 = store
            .set_status(id, TranscriptStatus::Finalizing { progress: 0.5 })
            .unwrap();
        let s4 = store.finalize_progress(id, 0.75).unwrap();
        let s5 = store.finish(id).unwrap();
        let mut got = Vec::new();
        for _ in 0..6 {
            got.push(rx.recv().await.unwrap().seq());
        }
        assert_eq!(
            got,
            vec![1, 2, 3, 4, 5, 6],
            "seqs must be dense, got {got:?}"
        );
        assert_eq!([s1, s2, s3, s4, s5], [1, 2, 4, 5, 6]);
        let snap = store.get(id).unwrap();
        assert_eq!(snap.last_seq, s5);
        assert!(matches!(snap.status, TranscriptStatus::Done));
        assert_eq!(snap.live_segments[0].text, "a");
        let loaded = TranscriptSession::load(&store.session_dir(id)).unwrap();
        assert_eq!(loaded.last_seq, s5);
        assert!(matches!(loaded.status, TranscriptStatus::Done));
    }

    #[tokio::test]
    async fn concurrent_mutators_produce_dense_monotonic_seqs() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(dir.path()));
        let id = store.create(mk_session(&dir.path().join("a.wav"))).unwrap();
        let mut rx = store.subscribe(id).unwrap().events;
        let mut handles = Vec::new();
        for _ in 0..4 {
            let s = store.clone();
            handles.push(tokio::task::spawn(async move {
                for _ in 0..8 {
                    let _ = s.append_segment(id, seg(0.0, 0.1, "x"));
                }
            }));
        }
        for h in handles {
            h.await.unwrap();
        }
        let mut seen: std::collections::BTreeSet<u64> = std::collections::BTreeSet::new();
        for _ in 0..32 {
            let ev = rx.recv().await.unwrap();
            assert!(seen.insert(ev.seq()), "duplicate seq {}", ev.seq());
        }
        assert_eq!(seen.first().copied(), Some(1));
        assert_eq!(seen.last().copied(), Some(32));
        assert_eq!(store.get(id).unwrap().last_seq, 32);
    }

    #[tokio::test]
    async fn list_skips_a_corrupt_session_directory() {
        let dir = tempfile::tempdir().unwrap();
        let store = TranscriptStore::with_root(dir.path());
        let id_good = store.create(mk_session(&dir.path().join("a.wav"))).unwrap();
        let bad_id = Uuid::new_v4();
        let bad_dir = dir.path().join(bad_id.to_string());
        std::fs::create_dir_all(&bad_dir).unwrap();
        std::fs::write(bad_dir.join("transcript.json"), b"{ broken").unwrap();
        let listed = store.list();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, id_good);
    }

    #[tokio::test]
    async fn delete_unknown_id_is_a_noop() {
        let dir = tempfile::tempdir().unwrap();
        let store = TranscriptStore::with_root(dir.path());
        store.delete(Uuid::new_v4()).unwrap();
    }

    #[tokio::test]
    async fn rename_persists_a_normalised_title_and_a_blank_one_clears_it() {
        let dir = tempfile::tempdir().unwrap();
        let store = TranscriptStore::with_root(dir.path());
        let id = store.create(mk_session(&dir.path().join("a.wav"))).unwrap();
        let seq_before = store.get(id).unwrap().last_seq;

        assert_eq!(
            store.rename(id, "  Planning\n call ").unwrap().as_deref(),
            Some("Planning call")
        );
        assert_eq!(
            TranscriptSession::load(&store.session_dir(id))
                .unwrap()
                .title
                .as_deref(),
            Some("Planning call")
        );
        assert_eq!(store.list()[0].title.as_deref(), Some("Planning call"));
        assert_eq!(
            store.get(id).unwrap().last_seq,
            seq_before,
            "a rename emits no stream event"
        );

        assert_eq!(store.rename(id, "   ").unwrap(), None);
        assert_eq!(store.get(id).unwrap().title, None);
    }

    #[tokio::test]
    async fn rename_of_an_unknown_session_is_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let store = TranscriptStore::with_root(dir.path());
        assert!(matches!(
            store.rename(Uuid::new_v4(), "x").unwrap_err(),
            StoreError::NotFound(_)
        ));
    }

    #[tokio::test]
    async fn list_returns_summaries_newest_first() {
        let dir = tempfile::tempdir().unwrap();
        let store = TranscriptStore::with_root(dir.path());
        let mut old = mk_session(&dir.path().join("old.wav"));
        old.created_at = "2026-01-01T00:00:00Z".to_string();
        old.set_final_segments(vec![seg(0.0, 1.0, "stare")]);
        let old_id = store.create(old).unwrap();
        let mut new = mk_session(&dir.path().join("new.wav"));
        new.created_at = "2026-02-01T00:00:00Z".to_string();
        let new_id = store.create(new).unwrap();

        let listed = store.list();
        assert_eq!(
            listed.iter().map(|s| s.id).collect::<Vec<_>>(),
            vec![new_id, old_id]
        );
        assert_eq!(listed[1].segment_count, 1);
        assert_eq!(listed[1].preview.as_deref(), Some("stare"));
        assert!(listed[1].size_bytes > 0, "transcript.json is on disk");
    }

    #[tokio::test]
    async fn watch_reports_list_changes_but_not_segments_or_levels() {
        let dir = tempfile::tempdir().unwrap();
        let store = TranscriptStore::with_root(dir.path());
        let mut changes = store.watch();
        let id = store.create(mk_session(&dir.path().join("a.wav"))).unwrap();
        assert_eq!(changes.try_recv().unwrap(), id);

        store.append_segment(id, seg(0.0, 1.0, "x")).unwrap();
        store.audio_level(id, vec![0.1]).unwrap();
        store.live_draft(id, "y".to_string()).unwrap();
        store
            .capture_warning(id, crate::transcription::CaptureWarning::AudioDropped)
            .unwrap();
        assert!(changes.try_recv().is_err(), "per-segment traffic stays off");

        store
            .set_status(id, TranscriptStatus::Finalizing { progress: 0.0 })
            .unwrap();
        store.finalize_progress(id, 0.5).unwrap();
        store.set_final_segments(id, vec![]).unwrap();
        store.finish(id).unwrap();
        store.rename(id, "t").unwrap();
        store.delete(id).unwrap();
        let mut seen = 0;
        while let Ok(changed) = changes.try_recv() {
            assert_eq!(changed, id);
            seen += 1;
        }
        assert_eq!(seen, 6);
    }

    #[tokio::test]
    async fn begin_retranscribe_moves_only_a_failed_or_finished_session_to_finalizing() {
        use crate::transcription::CaptureWarning;
        let dir = tempfile::tempdir().unwrap();
        let store = TranscriptStore::with_root(dir.path());
        let id = store.create(mk_session(&dir.path().join("a.wav"))).unwrap();
        assert!(matches!(
            store.begin_retranscribe(id).unwrap_err(),
            StoreError::InvalidState(_)
        ));

        store
            .set_status(
                id,
                TranscriptStatus::Failed {
                    reason: "no model".to_string(),
                },
            )
            .unwrap();
        store
            .capture_warning(id, CaptureWarning::RecordingPartMissing)
            .unwrap();
        let mut sub = store.subscribe(id).unwrap();

        let seq = store.begin_retranscribe(id).unwrap();
        let snap = store.get(id).unwrap();
        assert_eq!(snap.status, TranscriptStatus::Finalizing { progress: 0.0 });
        assert!(snap.active_warnings.is_empty());
        assert_eq!(snap.last_seq, seq);
        assert!(matches!(
            sub.events.try_recv().unwrap(),
            TranscriptEvent::CaptureWarningCleared { .. }
        ));
        assert!(matches!(
            sub.events.try_recv().unwrap(),
            TranscriptEvent::StatusChanged {
                status: TranscriptStatus::Finalizing { .. },
                ..
            }
        ));
        assert!(
            matches!(
                store.begin_retranscribe(id).unwrap_err(),
                StoreError::InvalidState(_)
            ),
            "a second click while the first run is going is refused"
        );
    }

    #[tokio::test]
    async fn begin_retranscribe_keeps_a_finished_transcript_on_screen_while_it_runs() {
        let dir = tempfile::tempdir().unwrap();
        let store = TranscriptStore::with_root(dir.path());
        let id = store.create(mk_session(&dir.path().join("a.wav"))).unwrap();
        store
            .set_status(id, TranscriptStatus::Finalizing { progress: 0.0 })
            .unwrap();
        store
            .set_final_segments(id, vec![seg(0.0, 1.0, "gotowe")])
            .unwrap();
        store.finish(id).unwrap();

        store.begin_retranscribe(id).unwrap();
        let snap = store.get(id).unwrap();
        assert_eq!(snap.status, TranscriptStatus::Finalizing { progress: 0.0 });
        assert_eq!(snap.effective_segments()[0].text, "gotowe");
    }

    #[tokio::test]
    async fn set_queued_shows_on_the_list_row_and_notifies_only_on_change() {
        let dir = tempfile::tempdir().unwrap();
        let store = TranscriptStore::with_root(dir.path());
        let id = store.create(mk_session(&dir.path().join("a.wav"))).unwrap();
        let mut changes = store.watch();
        assert!(!store.list()[0].queued);

        store.set_queued(id, true);
        store.set_queued(id, true);
        assert!(store.list()[0].queued);
        assert_eq!(changes.try_recv().unwrap(), id);
        assert!(changes.try_recv().is_err(), "a repeated mark is no change");

        store.set_queued(id, false);
        assert!(!store.list()[0].queued);
        assert_eq!(changes.try_recv().unwrap(), id);
        store.set_queued(Uuid::new_v4(), false);
        assert!(
            changes.try_recv().is_err(),
            "clearing an unmarked id is no change"
        );
    }

    #[tokio::test]
    async fn set_finalize_model_persists_and_reaches_the_list_row() {
        let dir = tempfile::tempdir().unwrap();
        let store = TranscriptStore::with_root(dir.path());
        let id = store.create(mk_session(&dir.path().join("a.wav"))).unwrap();
        let seq_before = store.get(id).unwrap().last_seq;

        store.set_finalize_model(id, "large-v3-turbo").unwrap();

        let on_disk = TranscriptSession::load(&store.session_dir(id)).unwrap();
        assert_eq!(
            on_disk.models_used.finalize.as_deref(),
            Some("large-v3-turbo")
        );
        assert_eq!(on_disk.last_seq, seq_before, "no event is emitted");
        assert_eq!(
            store.list()[0].finalize_model.as_deref(),
            Some("large-v3-turbo")
        );
        assert!(matches!(
            store.set_finalize_model(Uuid::new_v4(), "x").unwrap_err(),
            StoreError::NotFound(_)
        ));
    }

    fn write_unfinalized_wav(path: &Path, frames: u32) {
        let mut b = Vec::new();
        b.extend_from_slice(b"RIFF");
        b.extend_from_slice(&0u32.to_le_bytes());
        b.extend_from_slice(b"WAVE");
        b.extend_from_slice(b"fmt ");
        b.extend_from_slice(&16u32.to_le_bytes());
        b.extend_from_slice(&1u16.to_le_bytes());
        b.extend_from_slice(&1u16.to_le_bytes());
        b.extend_from_slice(&16_000u32.to_le_bytes());
        b.extend_from_slice(&32_000u32.to_le_bytes());
        b.extend_from_slice(&2u16.to_le_bytes());
        b.extend_from_slice(&16u16.to_le_bytes());
        b.extend_from_slice(b"data");
        b.extend_from_slice(&0u32.to_le_bytes());
        b.resize(b.len() + frames as usize * 2, 0);
        std::fs::write(path, b).unwrap();
    }

    #[tokio::test]
    async fn reconcile_fails_interrupted_sessions_and_repairs_their_audio() {
        let dir = tempfile::tempdir().unwrap();
        let writer = TranscriptStore::with_root(dir.path());
        let recording_id = Uuid::new_v4();
        let wav = writer.session_dir(recording_id).join("audio.wav");
        let mut recording = mk_session(&wav);
        recording.id = recording_id;
        writer.create(recording).unwrap();
        write_unfinalized_wav(&wav, 16_000);
        let finalizing = writer
            .create(mk_session(&dir.path().join("gone.wav")))
            .unwrap();
        writer
            .set_status(finalizing, TranscriptStatus::Finalizing { progress: 0.6 })
            .unwrap();
        let done = writer
            .create(mk_session(&dir.path().join("d.wav")))
            .unwrap();
        writer.finish(done).unwrap();
        drop(writer);

        let store = TranscriptStore::with_root(dir.path());
        assert_eq!(store.reconcile_interrupted(), 2);
        for id in [recording_id, finalizing] {
            assert_eq!(
                TranscriptSession::load(&store.session_dir(id))
                    .unwrap()
                    .status,
                TranscriptStatus::Failed {
                    reason: INTERRUPTED_REASON.to_string()
                }
            );
        }
        assert_eq!(store.get(done).unwrap().status, TranscriptStatus::Done);
        assert_eq!(
            crate::transcription::audio::wav_duration(&wav),
            Some(Duration::from_secs(1)),
            "the offline pass can read the recovered audio"
        );
        assert_eq!(store.reconcile_interrupted(), 0, "idempotent");
    }

    #[tokio::test]
    async fn reconcile_leaves_a_session_this_run_is_recording_alone() {
        let dir = tempfile::tempdir().unwrap();
        let store = TranscriptStore::with_root(dir.path());
        let id = store.create(mk_session(&dir.path().join("a.wav"))).unwrap();
        assert_eq!(store.reconcile_interrupted(), 0);
        assert_eq!(store.get(id).unwrap().status, TranscriptStatus::Recording);
    }

    #[test]
    fn a_cached_session_whose_directory_is_gone_is_not_written_back() {
        let dir = tempfile::tempdir().unwrap();
        let store = TranscriptStore::with_root(dir.path());
        let id = store.create(mk_session(&dir.path().join("a.wav"))).unwrap();
        std::fs::remove_dir_all(store.session_dir(id)).unwrap();
        assert!(matches!(
            store.finalize_progress(id, 0.5).unwrap_err(),
            StoreError::NotFound(_)
        ));
        assert!(!store.session_dir(id).exists());
    }

    #[test]
    fn delete_waits_for_a_mutation_in_flight_and_leaves_no_directory() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::with_root(dir.path()));
        let id = store.create(mk_session(&dir.path().join("a.wav"))).unwrap();
        let session = store.sessions.get(&id).unwrap().session.clone();
        let in_flight = session.write();
        let deleting = {
            let store = store.clone();
            std::thread::spawn(move || store.delete(id))
        };
        std::thread::sleep(Duration::from_millis(50));
        assert!(
            store.session_dir(id).exists(),
            "delete must wait for the session lock"
        );
        drop(in_flight);
        deleting.join().unwrap().unwrap();
        assert!(!store.session_dir(id).exists());
        assert!(matches!(
            store.finalize_progress(id, 0.5).unwrap_err(),
            StoreError::NotFound(_)
        ));
    }

    #[tokio::test]
    async fn finish_on_unknown_id_is_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let store = TranscriptStore::with_root(dir.path());
        assert!(matches!(
            store.finish(Uuid::new_v4()).unwrap_err(),
            StoreError::NotFound(_)
        ));
    }

    /// Regression: a session persisted by an earlier run (on disk, never in this store's cache)
    /// is still mutable — a cache-only lookup used to return NotFound for it.
    #[tokio::test]
    async fn mutators_work_on_a_disk_only_session() {
        let dir = tempfile::tempdir().unwrap();
        let id = {
            let s1 = TranscriptStore::with_root(dir.path());
            s1.create(mk_session(&dir.path().join("a.wav"))).unwrap()
        };
        let s2 = TranscriptStore::with_root(dir.path());
        assert!(s2.finish(id).is_ok(), "disk-only session must be mutable");
        assert!(matches!(s2.get(id).unwrap().status, TranscriptStatus::Done));
    }

    #[tokio::test]
    async fn concurrent_subscribe_on_a_disk_only_session_yields_a_single_entry() {
        let dir = tempfile::tempdir().unwrap();
        let store = TranscriptStore::with_root(dir.path());
        let id = store.create(mk_session(&dir.path().join("a.wav"))).unwrap();
        store.sessions.remove(&id);

        let store = Arc::new(store);
        let s1 = store.clone();
        let s2 = store.clone();
        let h1 = tokio::task::spawn_blocking(move || s1.subscribe(id));
        let h2 = tokio::task::spawn_blocking(move || s2.subscribe(id));
        let Subscription { events: mut e1, .. } = h1.await.unwrap().unwrap();
        let Subscription { events: mut e2, .. } = h2.await.unwrap().unwrap();

        store.set_status(id, TranscriptStatus::Recording).unwrap();
        let ev1 = e1.recv().await.unwrap();
        let ev2 = e2.recv().await.unwrap();
        assert_eq!(ev1.seq(), ev2.seq());
        assert_eq!(store.active_count(), 1);
    }

    #[tokio::test]
    async fn mutators_on_an_unknown_id_return_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let store = TranscriptStore::with_root(dir.path());
        let id = Uuid::new_v4();
        assert!(matches!(
            store.append_segment(id, seg(0.0, 1.0, "x")).unwrap_err(),
            StoreError::NotFound(_)
        ));
        assert!(matches!(
            store.set_status(id, TranscriptStatus::Done).unwrap_err(),
            StoreError::NotFound(_)
        ));
    }

    #[test]
    fn event_seq_helper_matches_each_variant() {
        for ev in [
            TranscriptEvent::SegmentAppended {
                seq: 1,
                segment: seg(0.0, 1.0, "x"),
            },
            TranscriptEvent::LiveDraft {
                seq: 2,
                text: "tail".to_string(),
            },
            TranscriptEvent::StatusChanged {
                seq: 4,
                status: TranscriptStatus::Done,
            },
            TranscriptEvent::FinalizeProgress {
                seq: 6,
                progress: 0.5,
            },
            TranscriptEvent::FinalSegmentsReady {
                seq: 7,
                segments: vec![seg(0.0, 1.0, "f")],
            },
            TranscriptEvent::Finished { seq: 9 },
            TranscriptEvent::CaptureWarning {
                seq: 11,
                warning: crate::transcription::CaptureWarning::SystemAudioSilent,
            },
            TranscriptEvent::CaptureWarningCleared {
                seq: 12,
                warning: crate::transcription::CaptureWarning::SystemAudioSilent,
            },
            TranscriptEvent::AudioLevel {
                seq: 13,
                levels: vec![0.1, 0.02],
            },
        ] {
            let expected = match &ev {
                TranscriptEvent::SegmentAppended { seq, .. } => *seq,
                TranscriptEvent::LiveDraft { seq, .. } => *seq,
                TranscriptEvent::StatusChanged { seq, .. } => *seq,
                TranscriptEvent::FinalizeProgress { seq, .. } => *seq,
                TranscriptEvent::FinalSegmentsReady { seq, .. } => *seq,
                TranscriptEvent::Finished { seq } => *seq,
                TranscriptEvent::CaptureWarning { seq, .. } => *seq,
                TranscriptEvent::CaptureWarningCleared { seq, .. } => *seq,
                TranscriptEvent::AudioLevel { seq, .. } => *seq,
            };
            assert_eq!(ev.seq(), expected);
        }
    }

    #[test]
    fn event_serde_round_trip() {
        let ev = TranscriptEvent::SegmentAppended {
            seq: 42,
            segment: seg(0.5, 1.5, "hi"),
        };
        assert_eq!(
            serde_json::from_str::<TranscriptEvent>(&serde_json::to_string(&ev).unwrap()).unwrap(),
            ev
        );
    }

    #[test]
    fn finalize_progress_then_finish_emits_progress_and_finished() {
        use crate::transcription::transcript::TranscriptStatus;
        let dir = tempfile::tempdir().unwrap();
        let store = TranscriptStore::with_root(dir.path());
        let id = store.create(mk_session(&dir.path().join("a.wav"))).unwrap();
        let mut sub = store.subscribe(id).unwrap();

        store.finalize_progress(id, 0.5).unwrap();
        store.finish(id).unwrap();

        let e1 = sub.events.try_recv().unwrap();
        let e2 = sub.events.try_recv().unwrap();
        assert!(matches!(
            e1,
            TranscriptEvent::FinalizeProgress { progress, .. } if (progress - 0.5).abs() < 1e-4
        ));
        assert!(matches!(e2, TranscriptEvent::Finished { .. }));
        assert!(e2.seq() > e1.seq());
        assert!(matches!(
            store.get(id).unwrap().status,
            TranscriptStatus::Done
        ));
    }

    #[test]
    fn set_final_segments_installs_finals_and_emits_ready() {
        let dir = tempfile::tempdir().unwrap();
        let store = TranscriptStore::with_root(dir.path());
        let id = store.create(mk_session(&dir.path().join("a.wav"))).unwrap();
        let mut sub = store.subscribe(id).unwrap();

        store
            .set_final_segments(id, vec![seg(2.0, 4.0, "hi")])
            .unwrap();

        let ev = sub.events.try_recv().unwrap();
        match ev {
            TranscriptEvent::FinalSegmentsReady { segments, .. } => {
                assert_eq!(segments.len(), 1);
                assert_eq!(segments[0].text, "hi");
            }
            other => panic!("expected FinalSegmentsReady, got {other:?}"),
        }
        let snap = store.get(id).unwrap();
        assert!(snap.final_segments.is_some());
        assert_eq!(snap.effective_segments().len(), 1);
        assert_eq!(snap.effective_segments()[0].text, "hi");
    }

    #[test]
    fn resume_reopens_a_done_session_with_finals_as_the_live_baseline() {
        let dir = tempfile::tempdir().unwrap();
        let store = TranscriptStore::with_root(dir.path());
        let id = store.create(mk_session(&dir.path().join("a.wav"))).unwrap();
        store.append_segment(id, seg(0.0, 1.0, "live v1")).unwrap();
        store
            .set_final_segments(id, vec![seg(0.0, 1.0, "final v1")])
            .unwrap();
        store.finish(id).unwrap();

        let mut sub = store.subscribe(id).unwrap();
        let part2 = dir.path().join("audio-2.wav");
        store.resume(id, part2.clone(), None).unwrap();

        let snap = store.get(id).unwrap();
        assert!(matches!(snap.status, TranscriptStatus::Recording));
        assert_eq!(snap.live_segments.len(), 1);
        assert_eq!(snap.live_segments[0].text, "final v1");
        assert!(snap.final_segments.is_none());
        assert_eq!(snap.audio_parts, vec![part2.clone()]);
        assert_eq!(
            snap.all_audio_parts(),
            vec![dir.path().join("a.wav"), part2]
        );
        match sub.events.try_recv().unwrap() {
            TranscriptEvent::StatusChanged { status, .. } => {
                assert!(matches!(status, TranscriptStatus::Recording));
            }
            other => panic!("expected StatusChanged, got {other:?}"),
        }
        store.sessions.remove(&id);
        let reloaded = store.get(id).unwrap();
        assert_eq!(reloaded.audio_parts.len(), 1);
        assert_eq!(reloaded.live_segments[0].text, "final v1");
    }

    #[test]
    fn resume_records_the_new_parts_live_model_and_rollback_restores_the_prior_one() {
        let dir = tempfile::tempdir().unwrap();
        let store = TranscriptStore::with_root(dir.path());
        let mut session = mk_session(&dir.path().join("a.wav"));
        session.models_used.live = Some("small".to_string());
        let id = store.create(session).unwrap();
        store.finish(id).unwrap();

        let part2 = dir.path().join("audio-2.wav");
        store.resume(id, part2.clone(), None).unwrap();
        assert_eq!(store.get(id).unwrap().models_used.live, None);

        store.rollback_resume(id, &part2).unwrap();
        assert_eq!(
            store.get(id).unwrap().models_used.live.as_deref(),
            Some("small")
        );

        let part2 = dir.path().join("audio-2.wav");
        store
            .resume(id, part2, Some("large-v3".to_string()))
            .unwrap();
        assert_eq!(
            store.get(id).unwrap().models_used.live.as_deref(),
            Some("large-v3")
        );
    }

    #[test]
    fn resume_on_a_session_without_finals_keeps_the_live_segments() {
        let dir = tempfile::tempdir().unwrap();
        let store = TranscriptStore::with_root(dir.path());
        let id = store.create(mk_session(&dir.path().join("a.wav"))).unwrap();
        store
            .append_segment(id, seg(0.0, 1.0, "live only"))
            .unwrap();
        store.set_status(id, TranscriptStatus::Done).unwrap();
        store
            .resume(id, dir.path().join("audio-2.wav"), None)
            .unwrap();
        let snap = store.get(id).unwrap();
        assert_eq!(snap.live_segments.len(), 1);
        assert_eq!(snap.live_segments[0].text, "live only");
    }

    #[test]
    fn rollback_resume_restores_done_and_drops_the_phantom_part() {
        let dir = tempfile::tempdir().unwrap();
        let store = TranscriptStore::with_root(dir.path());
        let id = store.create(mk_session(&dir.path().join("a.wav"))).unwrap();
        store.append_segment(id, seg(0.0, 1.0, "live v1")).unwrap();
        store
            .set_final_segments(id, vec![seg(0.0, 1.0, "final v1")])
            .unwrap();
        store.finish(id).unwrap();
        let before = store.get(id).unwrap();

        let part2 = dir.path().join("audio-2.wav");
        store.resume(id, part2.clone(), None).unwrap();
        let mut sub = store.subscribe(id).unwrap();
        store.rollback_resume(id, &part2).unwrap();

        let after = store.get(id).unwrap();
        assert!(matches!(after.status, TranscriptStatus::Done));
        assert!(after.audio_parts.is_empty(), "phantom part must be dropped");
        assert_eq!(after.final_segments, before.final_segments);
        assert_eq!(after.effective_segments(), before.effective_segments());
        match sub.events.try_recv().unwrap() {
            TranscriptEvent::StatusChanged { status, .. } => {
                assert!(matches!(status, TranscriptStatus::Done));
            }
            other => panic!("expected StatusChanged, got {other:?}"),
        }
        store.sessions.remove(&id);
        let reloaded = store.get(id).unwrap();
        assert!(matches!(reloaded.status, TranscriptStatus::Done));
        assert!(reloaded.audio_parts.is_empty());
        store.resume(id, part2.clone(), None).unwrap();
        let snap = store.get(id).unwrap();
        assert!(matches!(snap.status, TranscriptStatus::Recording));
        assert_eq!(snap.audio_parts, vec![part2]);
        assert_eq!(snap.live_segments[0].text, "final v1");
    }

    #[test]
    fn rollback_resume_keeps_content_when_the_session_had_no_finals() {
        let dir = tempfile::tempdir().unwrap();
        let store = TranscriptStore::with_root(dir.path());
        let id = store.create(mk_session(&dir.path().join("a.wav"))).unwrap();
        store
            .append_segment(id, seg(0.0, 1.0, "live only"))
            .unwrap();
        store.set_status(id, TranscriptStatus::Done).unwrap();
        let part2 = dir.path().join("audio-2.wav");
        store.resume(id, part2.clone(), None).unwrap();

        store.rollback_resume(id, &part2).unwrap();

        let after = store.get(id).unwrap();
        assert!(matches!(after.status, TranscriptStatus::Done));
        assert!(after.audio_parts.is_empty());
        assert_eq!(after.effective_segments().len(), 1);
        assert_eq!(after.effective_segments()[0].text, "live only");
        store.resume(id, part2, None).unwrap();
        assert_eq!(store.get(id).unwrap().live_segments[0].text, "live only");
    }

    #[test]
    fn rollback_resume_rejects_sessions_not_in_the_just_resumed_shape() {
        let dir = tempfile::tempdir().unwrap();
        let store = TranscriptStore::with_root(dir.path());
        let id = store.create(mk_session(&dir.path().join("a.wav"))).unwrap();
        let part2 = dir.path().join("audio-2.wav");
        assert!(matches!(
            store.rollback_resume(id, &part2).unwrap_err(),
            StoreError::InvalidState(_)
        ));
        store.set_status(id, TranscriptStatus::Done).unwrap();
        assert!(matches!(
            store.rollback_resume(id, &part2).unwrap_err(),
            StoreError::InvalidState(_)
        ));
        store.resume(id, part2.clone(), None).unwrap();
        let err = store
            .rollback_resume(id, &dir.path().join("other.wav"))
            .unwrap_err();
        assert!(matches!(err, StoreError::InvalidState(_)));
        let snap = store.get(id).unwrap();
        assert!(matches!(snap.status, TranscriptStatus::Recording));
        assert_eq!(snap.audio_parts, vec![part2.clone()]);
        assert!(matches!(
            store.rollback_resume(Uuid::new_v4(), &part2).unwrap_err(),
            StoreError::NotFound(_)
        ));
    }

    #[test]
    fn resume_rejects_a_session_that_is_not_done_and_leaves_it_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let store = TranscriptStore::with_root(dir.path());
        let id = store.create(mk_session(&dir.path().join("a.wav"))).unwrap();
        for status in [
            TranscriptStatus::Recording,
            TranscriptStatus::Finalizing { progress: 0.3 },
            TranscriptStatus::Failed {
                reason: "x".to_string(),
            },
        ] {
            store.set_status(id, status.clone()).unwrap();
            let err = store
                .resume(id, dir.path().join("audio-2.wav"), None)
                .unwrap_err();
            assert!(
                matches!(err, StoreError::InvalidState(_)),
                "expected InvalidState for {status:?}, got {err:?}"
            );
            let snap = store.get(id).unwrap();
            assert_eq!(snap.status, status, "a rejected resume must not mutate");
            assert!(snap.audio_parts.is_empty(), "no phantom part registered");
        }
    }

    #[test]
    fn final_segments_ready_serde_round_trip() {
        let ev = TranscriptEvent::FinalSegmentsReady {
            seq: 7,
            segments: vec![seg(0.0, 1.0, "f")],
        };
        assert_eq!(
            serde_json::from_str::<TranscriptEvent>(&serde_json::to_string(&ev).unwrap()).unwrap(),
            ev
        );
    }

    #[test]
    fn live_draft_emits_sets_snapshot_and_never_persists() {
        let dir = tempfile::tempdir().unwrap();
        let store = TranscriptStore::with_root(dir.path());
        let id = store.create(mk_session(&dir.path().join("a.wav"))).unwrap();
        let mut sub = store.subscribe(id).unwrap();
        let json_path = store.session_dir(id).join("transcript.json");
        let before = std::fs::read_to_string(&json_path).unwrap();
        let mtime_before = std::fs::metadata(&json_path).unwrap().modified().unwrap();

        store
            .live_draft(id, "not yet committed".to_string())
            .unwrap();

        let ev = sub.events.try_recv().unwrap();
        match &ev {
            TranscriptEvent::LiveDraft { text, .. } => assert_eq!(text, "not yet committed"),
            other => panic!("expected LiveDraft, got {other:?}"),
        }
        assert_eq!(store.get(id).unwrap().live_draft, "not yet committed");
        let after = std::fs::read_to_string(&json_path).unwrap();
        let mtime_after = std::fs::metadata(&json_path).unwrap().modified().unwrap();
        assert_eq!(after, before, "live_draft must not rewrite transcript.json");
        assert_eq!(
            mtime_after, mtime_before,
            "live_draft must not touch the file's mtime"
        );
        assert!(!after.contains("live_draft"));
        assert!(!after.contains("not yet committed"));
        let store2 = TranscriptStore::with_root(dir.path());
        assert_eq!(store2.get(id).unwrap().live_draft, "");
    }

    #[test]
    fn live_draft_still_bumps_seq_monotonically_alongside_saved_mutators() {
        let dir = tempfile::tempdir().unwrap();
        let store = TranscriptStore::with_root(dir.path());
        let id = store.create(mk_session(&dir.path().join("a.wav"))).unwrap();

        let seq1 = store.append_segment(id, seg(0.0, 1.0, "a")).unwrap();
        let seq2 = store.live_draft(id, "tail".to_string()).unwrap();
        let seq3 = store.live_draft(id, "longer tail".to_string()).unwrap();
        let seq4 = store.append_segment(id, seg(1.0, 2.0, "b")).unwrap();

        assert_eq!(
            [seq1, seq2, seq3, seq4],
            [1, 2, 3, 4],
            "seq stays dense and monotonic"
        );
        let loaded = TranscriptSession::load(&store.session_dir(id)).unwrap();
        assert_eq!(loaded.last_seq, 4);
    }

    #[test]
    fn live_draft_serde_round_trip_and_ts_mirror() {
        let ev = TranscriptEvent::LiveDraft {
            seq: 9,
            text: "tail".to_string(),
        };
        let json = serde_json::to_string(&ev).unwrap();
        assert!(json.contains("\"kind\":\"live_draft\""));
        assert_eq!(serde_json::from_str::<TranscriptEvent>(&json).unwrap(), ev);
        let src = include_str!("../../../../desktop/src/src/app/models/transcript.ts");
        assert!(
            src.contains("kind: 'live_draft'"),
            "TS TranscriptEvent union must carry the live_draft kind"
        );
    }

    #[test]
    fn audio_level_broadcasts_without_persisting_or_touching_the_session() {
        let dir = tempfile::tempdir().unwrap();
        let store = TranscriptStore::with_root(dir.path());
        let id = store.create(mk_session(&dir.path().join("a.wav"))).unwrap();
        let mut sub = store.subscribe(id).unwrap();
        let json_path = store.session_dir(id).join("transcript.json");
        let before = std::fs::read_to_string(&json_path).unwrap();

        let seq = store.audio_level(id, vec![0.12, 0.03]).unwrap();
        assert_eq!(seq, 1, "level events share the monotonic seq space");

        match sub.events.try_recv().unwrap() {
            TranscriptEvent::AudioLevel { levels, .. } => assert_eq!(levels, vec![0.12, 0.03]),
            other => panic!("expected AudioLevel, got {other:?}"),
        }
        assert_eq!(std::fs::read_to_string(&json_path).unwrap(), before);
        let store2 = TranscriptStore::with_root(dir.path());
        assert_eq!(store2.get(id).unwrap().last_seq, 0);
        assert!(store.audio_level(Uuid::new_v4(), vec![0.5]).is_err());
    }

    #[test]
    fn audio_level_skips_the_frame_instead_of_waiting_on_a_contended_session_lock() {
        let dir = tempfile::tempdir().unwrap();
        let store = TranscriptStore::with_root(dir.path());
        let id = store.create(mk_session(&dir.path().join("a.wav"))).unwrap();
        let mut sub = store.subscribe(id).unwrap();
        let entry_session = store.sessions.get(&id).unwrap().session.clone();
        let guard = entry_session.write();
        assert_eq!(store.audio_level(id, vec![0.5]).unwrap(), 0);
        assert!(
            sub.events.try_recv().is_err(),
            "skipped frame emits nothing"
        );
        drop(guard);
        assert_eq!(store.audio_level(id, vec![0.5]).unwrap(), 1);
        assert!(matches!(
            sub.events.try_recv().unwrap(),
            TranscriptEvent::AudioLevel { seq: 1, .. }
        ));
    }

    #[test]
    fn audio_level_serde_round_trip_and_ts_mirror() {
        let ev = TranscriptEvent::AudioLevel {
            seq: 3,
            levels: vec![0.5],
        };
        let json = serde_json::to_string(&ev).unwrap();
        assert!(json.contains("\"kind\":\"audio_level\""));
        assert_eq!(serde_json::from_str::<TranscriptEvent>(&json).unwrap(), ev);
        let src = include_str!("../../../../desktop/src/src/app/models/transcript.ts");
        assert!(
            src.contains("kind: 'audio_level'"),
            "TS TranscriptEvent union must carry the audio_level kind"
        );
    }
}
