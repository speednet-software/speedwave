//! Per-session state store + live event stream (snapshot + seq, like ADR-043's
//! history_plus_stream). Mutators atomically: update session, bump seq, push event, persist.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use dashmap::DashMap;
use parking_lot::RwLock;
use tokio::sync::broadcast;
use uuid::Uuid;

use crate::transcription::transcriber::Segment;
use crate::transcription::transcript::{TranscriptSession, TranscriptStatus};

/// Capacity of each session's `broadcast` channel — generous enough that a slow subscriber
/// falls behind only after thousands of events; if it does, it re-subscribes via the snapshot.
const CHANNEL_CAPACITY: usize = 4096;

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
            | TranscriptEvent::CaptureWarningCleared { seq, .. } => *seq,
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
}

impl TranscriptStore {
    /// A store rooted at `<data_dir>/transcripts/`.
    pub fn new() -> Self {
        Self::with_root(crate::transcription::transcripts_dir())
    }

    /// A store rooted at an arbitrary directory.
    pub fn with_root(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            sessions: Arc::new(DashMap::new()),
        }
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

    /// Walks `<root>/` and returns one snapshot per session directory. Corrupt
    /// `transcript.json` files are skipped (logged warn — runtime recovery, not panic).
    pub fn list(&self) -> Vec<TranscriptSession> {
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
        out.sort_by(|a, b| b.created_at.cmp(&a.created_at)); // newest first
        out
    }

    /// Removes the session directory + drops the in-memory entry.
    pub fn delete(&self, id: Uuid) -> Result<(), StoreError> {
        self.sessions.remove(&id);
        let dir = self.session_dir(id);
        if dir.exists() {
            std::fs::remove_dir_all(&dir)?;
        }
        Ok(())
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
        // `activate` loads from disk on a cache miss, so mutators work on sessions persisted
        // by an earlier run (a cache-only lookup would return NotFound for them).
        let h = self.activate(id)?;
        let dir = self.session_dir(id);
        let events;
        {
            let mut s = h.session.write();
            let next_seq = s.last_seq + 1;
            events = mutate(&mut s, next_seq);
            s.last_seq += events.len() as u64;
            if save {
                s.save(&dir)?;
            }
        }
        for event in &events {
            let _ = h.tx.send(event.clone());
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

    /// Sets the status.
    pub fn set_status(&self, id: Uuid, status: TranscriptStatus) -> Result<u64, StoreError> {
        let mut seq_out = 0;
        self.with_session(id, |s, seq| {
            seq_out = seq;
            s.status = status.clone();
            TranscriptEvent::StatusChanged { seq, status }
        })?;
        Ok(seq_out)
    }

    /// Reopens a `Done` session for more recording: the offline pass becomes the
    /// live baseline and a new audio part is registered (ADR-056 Amendment 10).
    pub fn resume(&self, id: Uuid, next_part: std::path::PathBuf) -> Result<u64, StoreError> {
        let mut seq_out = 0;
        // The status gate runs under the session lock — a caller-side pre-check
        // alone would race concurrent stop/start/delete (TOCTOU).
        let mut resumable = false;
        self.with_session_batch(id, |s, seq| {
            if !matches!(s.status, TranscriptStatus::Done) {
                return Vec::new();
            }
            resumable = true;
            seq_out = seq;
            if let Some(finals) = s.final_segments.take() {
                s.live_segments = finals;
            }
            s.audio_parts.push(next_part.clone());
            s.status = TranscriptStatus::Recording;
            vec![TranscriptEvent::StatusChanged {
                seq,
                status: TranscriptStatus::Recording,
            }]
        })?;
        if !resumable {
            return Err(StoreError::InvalidState(
                "only a finished recording can be resumed".to_string(),
            ));
        }
        Ok(seq_out)
    }

    /// Emits a capture-health warning event (session state is unchanged).
    pub fn capture_warning(
        &self,
        id: Uuid,
        warning: crate::transcription::CaptureWarning,
    ) -> Result<u64, StoreError> {
        let mut seq_out = 0;
        self.with_session(id, |_s, seq| {
            seq_out = seq;
            TranscriptEvent::CaptureWarning { seq, warning }
        })?;
        Ok(seq_out)
    }

    /// Emits a capture-health recovery event (session state is unchanged).
    pub fn capture_warning_cleared(
        &self,
        id: Uuid,
        warning: crate::transcription::CaptureWarning,
    ) -> Result<u64, StoreError> {
        let mut seq_out = 0;
        self.with_session(id, |_s, seq| {
            seq_out = seq;
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
        Ok(seq_out)
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
        // Session state is untouched apart from the persisted seq.
        let snap = store.get(id).unwrap();
        assert_eq!(snap.last_seq, seq);
        assert!(snap.live_segments.is_empty());
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
        // get from cache
        assert_eq!(store.get(id).unwrap().id, id);
        // list finds it
        let listed = store.list();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, id);
        // delete removes the dir and the cache entry
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
        // Drop the in-memory entry to force a disk reload.
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
        // Two events before subscribing.
        let seq1 = store.append_segment(id, seg(0.0, 1.0, "first")).unwrap();
        let seq2 = store.append_segment(id, seg(1.0, 2.0, "second")).unwrap();
        // Subscribe — the snapshot must reflect both, and `last_seq` advanced.
        let sub = store.subscribe(id).unwrap();
        assert_eq!(sub.snapshot.live_segments.len(), 2);
        assert_eq!(sub.snapshot.last_seq, seq2);
        assert_eq!(seq2, seq1 + 1, "seq is monotonic");
        // A subsequent event arrives on the receiver.
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

        // All three segments landed, in order, on disk in a single save.
        let snap = store.get(id).unwrap();
        assert_eq!(snap.last_seq, 3);
        let texts: Vec<&str> = snap.live_segments.iter().map(|s| s.text.as_str()).collect();
        assert_eq!(texts, vec!["one", "two", "three"]);

        // And each segment still emitted its own event, in order, on the broadcast stream.
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
        // last_seq untouched — no save, no event.
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
        // Monotonic seqs.
        let seqs = [s1, s2, s3, s4, s5];
        for w in seqs.windows(2) {
            assert_eq!(
                w[1],
                w[0] + 1,
                "seqs must be monotonic + dense, got {seqs:?}"
            );
        }
        // Each event arrived on the receiver, in order.
        for expected in seqs {
            let ev = rx.recv().await.unwrap();
            assert_eq!(ev.seq(), expected, "out of order: {seqs:?}");
        }
        // The snapshot reflects the cumulative changes (last_seq = s5).
        let snap = store.get(id).unwrap();
        assert_eq!(snap.last_seq, s5);
        assert!(matches!(snap.status, TranscriptStatus::Done));
        assert_eq!(snap.live_segments[0].text, "a");
        // Persisted on disk (cache-independent).
        let loaded = TranscriptSession::load(&store.session_dir(id)).unwrap();
        assert_eq!(loaded.last_seq, s5);
        assert!(matches!(loaded.status, TranscriptStatus::Done));
    }

    #[tokio::test]
    async fn concurrent_mutators_produce_dense_monotonic_seqs() {
        // 4 tasks * 8 ops each → 32 events with no gaps and no duplicates.
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
        // Collect all 32 events and check the seq set is exactly {1..=32}.
        let mut seen: std::collections::BTreeSet<u64> = std::collections::BTreeSet::new();
        for _ in 0..32 {
            let ev = rx.recv().await.unwrap();
            assert!(seen.insert(ev.seq()), "duplicate seq {}", ev.seq());
        }
        assert_eq!(seen.first().copied(), Some(1));
        assert_eq!(seen.last().copied(), Some(32));
        // The snapshot last_seq must equal the max.
        assert_eq!(store.get(id).unwrap().last_seq, 32);
    }

    #[tokio::test]
    async fn list_skips_a_corrupt_session_directory() {
        let dir = tempfile::tempdir().unwrap();
        let store = TranscriptStore::with_root(dir.path());
        let id_good = store.create(mk_session(&dir.path().join("a.wav"))).unwrap();
        // Drop a directory with a bad transcript.json.
        let bad_id = Uuid::new_v4();
        let bad_dir = dir.path().join(bad_id.to_string());
        std::fs::create_dir_all(&bad_dir).unwrap();
        std::fs::write(bad_dir.join("transcript.json"), b"{ broken").unwrap();
        let listed = store.list();
        // Only the good one is returned.
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, id_good);
    }

    #[tokio::test]
    async fn delete_unknown_id_is_a_noop() {
        let dir = tempfile::tempdir().unwrap();
        let store = TranscriptStore::with_root(dir.path());
        store.delete(Uuid::new_v4()).unwrap(); // no error
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
        // First store persists the session, then is dropped (cache gone).
        let id = {
            let s1 = TranscriptStore::with_root(dir.path());
            s1.create(mk_session(&dir.path().join("a.wav"))).unwrap()
        };
        // A fresh store has an empty cache but sees the dir on disk.
        let s2 = TranscriptStore::with_root(dir.path());
        assert!(s2.finish(id).is_ok(), "disk-only session must be mutable");
        assert!(matches!(s2.get(id).unwrap().status, TranscriptStatus::Done));
    }

    #[tokio::test]
    async fn concurrent_subscribe_on_a_disk_only_session_yields_a_single_entry() {
        // Guards against the previous activate() race: two concurrent subscribers used to load
        // the session twice, and the first caller could hold a tx that wasn't the one in the map.
        let dir = tempfile::tempdir().unwrap();
        let store = TranscriptStore::with_root(dir.path());
        let id = store.create(mk_session(&dir.path().join("a.wav"))).unwrap();
        // Evict from cache so the next subscribe goes through `activate`.
        store.sessions.remove(&id);

        let store = Arc::new(store);
        let s1 = store.clone();
        let s2 = store.clone();
        let h1 = tokio::task::spawn_blocking(move || s1.subscribe(id));
        let h2 = tokio::task::spawn_blocking(move || s2.subscribe(id));
        let Subscription { events: mut e1, .. } = h1.await.unwrap().unwrap();
        let Subscription { events: mut e2, .. } = h2.await.unwrap().unwrap();

        // Emit one event and require *both* subscribers to see it.
        store.set_status(id, TranscriptStatus::Recording).unwrap();
        let ev1 = e1.recv().await.unwrap();
        let ev2 = e2.recv().await.unwrap();
        assert_eq!(ev1.seq(), ev2.seq());
        // And only one Entry survives.
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

        // Two events: FinalizeProgress then Finished, monotonic seq.
        let e1 = sub.events.try_recv().unwrap();
        let e2 = sub.events.try_recv().unwrap();
        assert!(matches!(
            e1,
            TranscriptEvent::FinalizeProgress { progress, .. } if (progress - 0.5).abs() < 1e-4
        ));
        assert!(matches!(e2, TranscriptEvent::Finished { .. }));
        assert!(e2.seq() > e1.seq());
        // Status is Done; status persisted.
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

        // The event carries the merged segments.
        let ev = sub.events.try_recv().unwrap();
        match ev {
            TranscriptEvent::FinalSegmentsReady { segments, .. } => {
                assert_eq!(segments.len(), 1);
                assert_eq!(segments[0].text, "hi");
            }
            other => panic!("expected FinalSegmentsReady, got {other:?}"),
        }
        // And the session now reports final_segments + effective_segments.
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
        store.resume(id, part2.clone()).unwrap();

        let snap = store.get(id).unwrap();
        assert!(matches!(snap.status, TranscriptStatus::Recording));
        // The offline pass became the live baseline; finals cleared for the re-pass.
        assert_eq!(snap.live_segments.len(), 1);
        assert_eq!(snap.live_segments[0].text, "final v1");
        assert!(snap.final_segments.is_none());
        assert_eq!(snap.audio_parts, vec![part2.clone()]);
        assert_eq!(
            snap.all_audio_parts(),
            vec![dir.path().join("a.wav"), part2]
        );
        // The transition streams as a StatusChanged event.
        match sub.events.try_recv().unwrap() {
            TranscriptEvent::StatusChanged { status, .. } => {
                assert!(matches!(status, TranscriptStatus::Recording));
            }
            other => panic!("expected StatusChanged, got {other:?}"),
        }
        // And it survives a reload from disk.
        store.sessions.remove(&id);
        let reloaded = store.get(id).unwrap();
        assert_eq!(reloaded.audio_parts.len(), 1);
        assert_eq!(reloaded.live_segments[0].text, "final v1");
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
        store.resume(id, dir.path().join("audio-2.wav")).unwrap();
        let snap = store.get(id).unwrap();
        assert_eq!(snap.live_segments.len(), 1);
        assert_eq!(snap.live_segments[0].text, "live only");
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
                .resume(id, dir.path().join("audio-2.wav"))
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
        // Snapshot carries the draft for late subscribers…
        assert_eq!(store.get(id).unwrap().live_draft, "not yet committed");
        // …but the durable transcript.json is untouched — no rewrite, no fsync.
        let after = std::fs::read_to_string(&json_path).unwrap();
        let mtime_after = std::fs::metadata(&json_path).unwrap().modified().unwrap();
        assert_eq!(after, before, "live_draft must not rewrite transcript.json");
        assert_eq!(
            mtime_after, mtime_before,
            "live_draft must not touch the file's mtime"
        );
        assert!(!after.contains("live_draft"));
        assert!(!after.contains("not yet committed"));
        // A fresh store (app restart) reloads without any draft.
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
        // The saved mutator after the drafts still persists the cumulative last_seq.
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
}
