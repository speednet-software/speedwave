//! Per-session state store + live event stream (snapshot + seq, like
//! ADR-043's history_plus_stream). Mutators atomically: update session, bump
//! seq, push event, persist.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use dashmap::DashMap;
use parking_lot::RwLock;
use tokio::sync::broadcast;
use uuid::Uuid;

use crate::transcription::transcriber::Segment;
use crate::transcription::transcript::{TranscriptSession, TranscriptStatus};

/// Capacity of each session's `broadcast` channel — generous enough that a
/// slow subscriber falls behind only after thousands of events; if it does,
/// it re-subscribes via the snapshot path.
const CHANNEL_CAPACITY: usize = 4096;

/// Live events on a transcript stream. Every event carries a `seq` (1-indexed,
/// monotonic per session). Consumers apply events idempotently: ignore
/// `seq <= last_applied`.
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
    /// The sliding window re-decoded its tail; replace the trailing range.
    SegmentsReplaced {
        /// Monotonic seq.
        seq: u64,
        /// Index in `live_segments` at which to splice in `segments`.
        from_index: usize,
        /// The replacement segments.
        segments: Vec<Segment>,
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
}

impl TranscriptEvent {
    /// `seq` carried by this event.
    pub fn seq(&self) -> u64 {
        match self {
            TranscriptEvent::SegmentAppended { seq, .. }
            | TranscriptEvent::SegmentsReplaced { seq, .. }
            | TranscriptEvent::StatusChanged { seq, .. }
            | TranscriptEvent::FinalizeProgress { seq, .. }
            | TranscriptEvent::FinalSegmentsReady { seq, .. }
            | TranscriptEvent::Finished { seq, .. } => *seq,
        }
    }
}

/// What `subscribe()` returns: a current-state snapshot plus a stream of
/// future events. Consumers replay the snapshot first, then apply events with
/// `seq > snapshot.last_seq` idempotently.
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
    /// Filesystem error.
    #[error("transcript store I/O error: {0}")]
    Io(#[from] std::io::Error),
}

/// Per-session: the live session struct + its broadcast channel.
struct Entry {
    session: Arc<RwLock<TranscriptSession>>,
    tx: broadcast::Sender<TranscriptEvent>,
}

/// Per-session state store + live event stream.
///
/// `<root>/<uuid>/transcript.json` + `<root>/<uuid>/audio.wav`. The store
/// caches the active session in memory; `list()` walks the disk for inactive
/// ones. `subscribe()` returns a snapshot + receiver — mutators bump seq,
/// emit, and persist atomically so the snapshot, the stream, and the disk
/// state never drift.
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

    /// Walks `<root>/` and returns one snapshot per session directory.
    /// Corrupt `transcript.json` files are skipped (logged warn — runtime
    /// recovery, not panic).
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

    /// Loads `id` into cache if needed; returns its `Entry`. Atomic against
    /// concurrent callers: the entry actually living in `sessions` is the one
    /// returned, so subscribers can never end up holding an orphaned `tx`.
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
        // `activate` loads from disk on a cache miss, so mutators work on
        // sessions persisted by an earlier run (a cache-only lookup returned
        // NotFound for them — the "no such transcript session" on any mutator).
        let h = self.activate(id)?;
        let dir = self.session_dir(id);
        let event;
        {
            let mut s = h.session.write();
            s.last_seq += 1;
            let seq = s.last_seq;
            event = mutate(&mut s, seq);
            s.save(&dir)?;
        }
        let _ = h.tx.send(event);
        Ok(())
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

    /// Splice point for a window re-decode: first segment overlapping the
    /// window (`end > threshold`). Keying on `end` (not `start`) drops segments
    /// whose text runs into the window, which would otherwise duplicate.
    pub fn live_splice_at(&self, id: Uuid, threshold: Duration) -> Result<usize, StoreError> {
        let entry = self.sessions.get(&id).ok_or(StoreError::NotFound(id))?;
        let session = entry.session.read();
        Ok(session
            .live_segments
            .iter()
            .position(|s| s.end > threshold)
            .unwrap_or(session.live_segments.len()))
    }

    /// Replaces the tail of `live_segments` starting at `from_index`.
    pub fn replace_segments(
        &self,
        id: Uuid,
        from_index: usize,
        segments: Vec<Segment>,
    ) -> Result<u64, StoreError> {
        let mut seq_out = 0;
        self.with_session(id, |s, seq| {
            seq_out = seq;
            s.live_segments.truncate(from_index);
            s.live_segments.extend(segments.iter().cloned());
            TranscriptEvent::SegmentsReplaced {
                seq,
                from_index,
                segments,
            }
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

    /// Installs the offline pass's `final_segments` and emits
    /// `FinalSegmentsReady` so an open UI swaps the live transcript for the
    /// higher-quality one.
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
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    }
    #[cfg(not(unix))]
    let _ = dir;
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
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
        }
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
    async fn every_mutator_bumps_seq_and_persists_and_emits() {
        let dir = tempfile::tempdir().unwrap();
        let store = TranscriptStore::with_root(dir.path());
        let id = store.create(mk_session(&dir.path().join("a.wav"))).unwrap();
        let mut rx = store.subscribe(id).unwrap().events;
        let s1 = store.append_segment(id, seg(0.0, 1.0, "a")).unwrap();
        let s2 = store
            .replace_segments(id, 0, vec![seg(0.0, 1.0, "A")])
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
        assert_eq!(snap.live_segments[0].text, "A");
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

    /// Regression: a session persisted by an earlier run (on disk, never in
    /// this store's cache) is still mutable. Cache-only lookup returned
    /// NotFound — the "no such transcript session" on a mutator.
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
        // Guards against the previous activate() race: two concurrent
        // subscribers used to load the session twice and the first caller
        // could end up holding a tx that was not the one in the map.
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
            TranscriptEvent::SegmentsReplaced {
                seq: 2,
                from_index: 0,
                segments: vec![],
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
        ] {
            let expected = match &ev {
                TranscriptEvent::SegmentAppended { seq, .. } => *seq,
                TranscriptEvent::SegmentsReplaced { seq, .. } => *seq,
                TranscriptEvent::StatusChanged { seq, .. } => *seq,
                TranscriptEvent::FinalizeProgress { seq, .. } => *seq,
                TranscriptEvent::FinalSegmentsReady { seq, .. } => *seq,
                TranscriptEvent::Finished { seq } => *seq,
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

    /// Regression: a kept segment whose text spans into the re-decode window
    /// (start before threshold, end after) must be spliced out so the fresh
    /// decode doesn't duplicate it. Splicing on `start` wrongly kept it.
    #[tokio::test]
    async fn live_splice_drops_segment_overlapping_the_window() {
        let dir = tempfile::tempdir().unwrap();
        let store = TranscriptStore::with_root(dir.path());
        let id = store.create(mk_session(&dir.path().join("a.wav"))).unwrap();
        store
            .append_segment(id, seg(0.0, 10.0, "long packed"))
            .unwrap();
        store.append_segment(id, seg(10.0, 12.0, "after")).unwrap();
        let at = store.live_splice_at(id, Duration::from_secs(8)).unwrap();
        assert_eq!(at, 0, "segment overlapping the window must be spliced out");
        store
            .replace_segments(id, 0, vec![seg(0.0, 8.0, "kept")])
            .unwrap();
        let at2 = store.live_splice_at(id, Duration::from_secs(8)).unwrap();
        assert_eq!(at2, 1, "a segment ending exactly at the threshold is kept");
    }
}
