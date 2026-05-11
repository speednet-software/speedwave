//! Per-session state store + live event stream (snapshot + seq, like
//! ADR-043's history_plus_stream). Mutators atomically: update session, bump
//! seq, push event, persist.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use dashmap::DashMap;
use parking_lot::RwLock;
use tokio::sync::broadcast;
use uuid::Uuid;

use crate::transcription::transcriber::{Segment, SpeakerId};
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
    /// The diarizer stamped a speaker onto a segment.
    SpeakerAssigned {
        /// Monotonic seq.
        seq: u64,
        /// Index in the effective segment list.
        segment_index: usize,
        /// Speaker id.
        speaker: SpeakerId,
    },
    /// The lifecycle status changed.
    StatusChanged {
        /// Monotonic seq.
        seq: u64,
        /// New status.
        status: TranscriptStatus,
    },
    /// The user (or driver) renamed a speaker. Carries the full updated map.
    SpeakerRelabeled {
        /// Monotonic seq.
        seq: u64,
        /// Updated `speaker_id → name` map.
        #[serde(with = "speaker_name_map")]
        speaker_names: HashMap<SpeakerId, String>,
    },
    /// Progress signal during the offline pass.
    FinalizeProgress {
        /// Monotonic seq.
        seq: u64,
        /// 0.0 → 1.0.
        progress: f32,
    },
    /// The offline pass produced `final_segments` (with speaker IDs already
    /// remapped to preserve user relabels). The UI swaps the live transcript
    /// for this set; `speaker_names` may also have shifted, so it's resent.
    FinalSegmentsReady {
        /// Monotonic seq.
        seq: u64,
        /// The higher-quality offline segments.
        segments: Vec<Segment>,
        /// Updated `speaker_id → name` map (same map, resent for convenience).
        #[serde(with = "speaker_name_map")]
        speaker_names: HashMap<SpeakerId, String>,
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
            | TranscriptEvent::SpeakerAssigned { seq, .. }
            | TranscriptEvent::StatusChanged { seq, .. }
            | TranscriptEvent::SpeakerRelabeled { seq, .. }
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

    /// Loads `id` into cache if needed; returns its `Entry`.
    fn activate(&self, id: Uuid) -> Result<EntryHandle, StoreError> {
        if let Some(e) = self.sessions.get(&id) {
            return Ok(EntryHandle {
                session: e.session.clone(),
                tx: e.tx.clone(),
            });
        }
        let session = TranscriptSession::load(&self.session_dir(id))?;
        let (tx, _) = broadcast::channel(CHANNEL_CAPACITY);
        self.sessions.insert(
            id,
            Entry {
                session: Arc::new(RwLock::new(session.clone())),
                tx: tx.clone(),
            },
        );
        Ok(EntryHandle {
            session: Arc::new(RwLock::new(session)),
            tx,
        })
    }

    fn entry(&self, id: Uuid) -> Result<EntryHandle, StoreError> {
        self.sessions
            .get(&id)
            .map(|e| EntryHandle {
                session: e.session.clone(),
                tx: e.tx.clone(),
            })
            .ok_or(StoreError::NotFound(id))
    }

    /// Helper: lock-mutate-persist-emit. Bumps `last_seq`, runs `mutate` with
    /// the new seq (so it can attach it to the event), persists, and emits.
    fn with_session<F>(&self, id: Uuid, mutate: F) -> Result<(), StoreError>
    where
        F: FnOnce(&mut TranscriptSession, u64) -> TranscriptEvent,
    {
        let h = self.entry(id)?;
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

    /// Stamps a speaker on the segment at `segment_index` of the effective list.
    pub fn assign_speaker(
        &self,
        id: Uuid,
        segment_index: usize,
        speaker: SpeakerId,
    ) -> Result<u64, StoreError> {
        let mut seq_out = 0;
        self.with_session(id, |s, seq| {
            seq_out = seq;
            // Apply to live by default; if final exists, apply there too.
            if let Some(seg) = s.live_segments.get_mut(segment_index) {
                seg.speaker = Some(speaker);
            }
            if let Some(finals) = s.final_segments.as_mut() {
                if let Some(seg) = finals.get_mut(segment_index) {
                    seg.speaker = Some(speaker);
                }
            }
            TranscriptEvent::SpeakerAssigned {
                seq,
                segment_index,
                speaker,
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

    /// User-supplied speaker name.
    pub fn relabel_speaker(
        &self,
        id: Uuid,
        speaker: SpeakerId,
        name: &str,
    ) -> Result<u64, StoreError> {
        let mut seq_out = 0;
        self.with_session(id, |s, seq| {
            seq_out = seq;
            s.relabel_speaker(speaker, name);
            TranscriptEvent::SpeakerRelabeled {
                seq,
                speaker_names: s.speaker_names.clone(),
            }
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

    /// Installs the offline pass's `final_segments`, remapping speaker IDs to
    /// preserve user relabels by max-overlap against the live turns
    /// (`TranscriptSession::merge_live_into_final`). Emits `FinalSegmentsReady`
    /// so an open UI swaps the live transcript for the higher-quality one.
    pub fn merge_final_segments(
        &self,
        id: Uuid,
        final_segs: Vec<Segment>,
        final_turns: &[crate::transcription::diarizer::SpeakerTurn],
        live_turns: &[crate::transcription::diarizer::SpeakerTurn],
    ) -> Result<u64, StoreError> {
        let mut seq_out = 0;
        self.with_session(id, |s, seq| {
            seq_out = seq;
            s.merge_live_into_final(final_segs, final_turns, live_turns);
            let segments = s.final_segments.clone().unwrap_or_default();
            TranscriptEvent::FinalSegmentsReady {
                seq,
                segments,
                speaker_names: s.speaker_names.clone(),
            }
        })?;
        Ok(seq_out)
    }

    /// Marks the session `Done` and emits `Finished`.
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

/// Serde adapter for `HashMap<SpeakerId, String>` inside an internally-tagged
/// enum. serde_json's "parse numeric map key from string" shortcut doesn't fire
/// through the `Content` buffer that internal tagging uses, so we serialize the
/// map as a `Vec<(u32, String)>` of pairs instead.
mod speaker_name_map {
    use super::SpeakerId;
    use serde::{Deserialize, Deserializer, Serialize, Serializer};
    use std::collections::HashMap;

    /// Serializes the map as a list of `(speaker_id, name)` pairs.
    pub fn serialize<S: Serializer>(
        map: &HashMap<SpeakerId, String>,
        s: S,
    ) -> Result<S::Ok, S::Error> {
        let mut pairs: Vec<(u32, &String)> = map.iter().map(|(k, v)| (k.0, v)).collect();
        pairs.sort_by_key(|(id, _)| *id);
        pairs.serialize(s)
    }

    /// Deserializes a list of `(speaker_id, name)` pairs back into the map.
    pub fn deserialize<'de, D: Deserializer<'de>>(
        d: D,
    ) -> Result<HashMap<SpeakerId, String>, D::Error> {
        let pairs: Vec<(u32, String)> = Vec::deserialize(d)?;
        Ok(pairs
            .into_iter()
            .map(|(id, name)| (SpeakerId(id), name))
            .collect())
    }
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
                app_id: None,
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
            speaker: None,
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
        let s3 = store.assign_speaker(id, 0, SpeakerId(0)).unwrap();
        let s4 = store
            .set_status(id, TranscriptStatus::Finalizing { progress: 0.5 })
            .unwrap();
        let s5 = store.relabel_speaker(id, SpeakerId(0), "Alice").unwrap();
        let s6 = store.finalize_progress(id, 0.75).unwrap();
        let s7 = store.finish(id).unwrap();
        // Monotonic seqs.
        let seqs = [s1, s2, s3, s4, s5, s6, s7];
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
        // The snapshot reflects the cumulative changes (last_seq = s7).
        let snap = store.get(id).unwrap();
        assert_eq!(snap.last_seq, s7);
        assert!(matches!(snap.status, TranscriptStatus::Done));
        assert_eq!(
            snap.speaker_names.get(&SpeakerId(0)).map(String::as_str),
            Some("Alice")
        );
        assert_eq!(snap.live_segments[0].speaker, Some(SpeakerId(0)));
        // Persisted on disk (cache-independent).
        let loaded = TranscriptSession::load(&store.session_dir(id)).unwrap();
        assert_eq!(loaded.last_seq, s7);
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
            TranscriptEvent::SpeakerAssigned {
                seq: 3,
                segment_index: 0,
                speaker: SpeakerId(0),
            },
            TranscriptEvent::StatusChanged {
                seq: 4,
                status: TranscriptStatus::Done,
            },
            TranscriptEvent::SpeakerRelabeled {
                seq: 5,
                speaker_names: HashMap::new(),
            },
            TranscriptEvent::FinalizeProgress {
                seq: 6,
                progress: 0.5,
            },
            TranscriptEvent::FinalSegmentsReady {
                seq: 7,
                segments: vec![seg(0.0, 1.0, "f")],
                speaker_names: HashMap::new(),
            },
            TranscriptEvent::Finished { seq: 8 },
        ] {
            let expected = match &ev {
                TranscriptEvent::SegmentAppended { seq, .. } => *seq,
                TranscriptEvent::SegmentsReplaced { seq, .. } => *seq,
                TranscriptEvent::SpeakerAssigned { seq, .. } => *seq,
                TranscriptEvent::StatusChanged { seq, .. } => *seq,
                TranscriptEvent::SpeakerRelabeled { seq, .. } => *seq,
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
    fn merge_final_segments_installs_finals_and_remaps_speakers() {
        use crate::transcription::diarizer::SpeakerTurn;
        let dir = tempfile::tempdir().unwrap();
        let store = TranscriptStore::with_root(dir.path());
        let id = store.create(mk_session(&dir.path().join("a.wav"))).unwrap();
        // User named the live speaker 0.
        store.relabel_speaker(id, SpeakerId(0), "Ola").unwrap();
        let mut sub = store.subscribe(id).unwrap();

        // Live turns: speaker 0 over 0..10. Final pass used id 5 over the same.
        let live_turns = vec![SpeakerTurn {
            start: Duration::from_secs(0),
            end: Duration::from_secs(10),
            speaker: SpeakerId(0),
        }];
        let final_turns = vec![SpeakerTurn {
            start: Duration::from_secs(0),
            end: Duration::from_secs(10),
            speaker: SpeakerId(5),
        }];
        let mut s = seg(2.0, 4.0, "hi");
        s.speaker = Some(SpeakerId(5));
        store
            .merge_final_segments(id, vec![s], &final_turns, &live_turns)
            .unwrap();

        // The event carries the merged segments + speaker_names.
        let ev = sub.events.try_recv().unwrap();
        match ev {
            TranscriptEvent::FinalSegmentsReady {
                segments,
                speaker_names,
                ..
            } => {
                assert_eq!(segments.len(), 1);
                // Final-5 → live-0 (max overlap) → name "Ola" still resolves.
                assert_eq!(segments[0].speaker, Some(SpeakerId(0)));
                assert_eq!(
                    speaker_names.get(&SpeakerId(0)).map(String::as_str),
                    Some("Ola")
                );
            }
            other => panic!("expected FinalSegmentsReady, got {other:?}"),
        }
        // And the session now reports final_segments + effective_segments.
        let snap = store.get(id).unwrap();
        assert!(snap.final_segments.is_some());
        assert_eq!(snap.effective_segments().len(), 1);
        assert_eq!(snap.effective_segments()[0].speaker, Some(SpeakerId(0)));
    }

    #[test]
    fn final_segments_ready_serde_round_trip() {
        let ev = TranscriptEvent::FinalSegmentsReady {
            seq: 7,
            segments: vec![seg(0.0, 1.0, "f")],
            speaker_names: {
                let mut m = HashMap::new();
                m.insert(SpeakerId(0), "Ola".to_string());
                m
            },
        };
        assert_eq!(
            serde_json::from_str::<TranscriptEvent>(&serde_json::to_string(&ev).unwrap()).unwrap(),
            ev
        );
    }
}
