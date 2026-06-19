//! Per-recording session: status, segments, speaker names, on-disk persistence.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::transcription::audio::AudioSourceInfo;
use crate::transcription::diarizer::SpeakerTurn;
use crate::transcription::transcriber::{Language, Segment, SpeakerId};

/// On-disk filename for the persisted session.
pub const TRANSCRIPT_JSON: &str = "transcript.json";

/// On-disk filename for the recorded audio.
pub const AUDIO_WAV: &str = "audio.wav";

/// Lifecycle status of a recording.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "state")]
pub enum TranscriptStatus {
    /// Capturing audio + live transcription.
    Recording,
    /// Stopped; running the higher-quality offline pass.
    Finalizing {
        /// 0.0 → 1.0 (driver-reported).
        progress: f32,
    },
    /// Done — `effective_segments()` returns the final pass if it ran.
    Done,
    /// Failed at some stage.
    Failed {
        /// Human-readable reason.
        reason: String,
    },
}

/// Which Whisper / diarization model was used for each pass.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ModelsUsed {
    /// Whisper catalogue key used for the live pass.
    pub live: Option<String>,
    /// Whisper catalogue key used for the higher-quality offline pass.
    pub finalize: Option<String>,
    /// Diarization segmentation model key.
    pub diarization_segmentation: Option<String>,
    /// Diarization embedding model key.
    pub diarization_embedding: Option<String>,
}

/// One transcript session — the persisted artifact.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TranscriptSession {
    /// Stable id (the directory name under `<data_dir>/transcripts/`).
    pub id: Uuid,
    /// Created-at, RFC 3339 string (serde-friendly across platforms).
    pub created_at: String,
    /// Forced language for this session.
    pub language: Language,
    /// What was captured.
    pub audio_source: AudioSourceInfo,
    /// Lifecycle.
    pub status: TranscriptStatus,
    /// Segments from the live pass (may be empty before transcription starts).
    pub live_segments: Vec<Segment>,
    /// Segments from the higher-quality offline pass; `None` until it runs.
    pub final_segments: Option<Vec<Segment>>,
    /// On-disk audio file (`None` once "discard audio" was applied).
    pub audio_path: Option<PathBuf>,
    /// User-supplied speaker names (`SpeakerId → "Alice"`). Empty by default.
    pub speaker_names: HashMap<SpeakerId, String>,
    /// What models were used for each pass.
    pub models_used: ModelsUsed,
    /// User hint for the diarizer (`None` = auto-estimate, default).
    #[serde(default)]
    pub expected_speakers: Option<u32>,
    /// Last event seq emitted for this session — for snapshot+stream resume.
    pub last_seq: u64,
}

impl TranscriptSession {
    /// A new session in `Recording` state.
    pub fn new(language: Language, audio_source: AudioSourceInfo, audio_path: PathBuf) -> Self {
        Self::new_with_id(Uuid::new_v4(), language, audio_source, audio_path)
    }

    /// Like `new`, but with a caller-chosen id — used when the audio-file path
    /// (which lives under `<root>/<id>/`) must be known *before* the session is
    /// created (so it's correct from the first persisted write).
    pub fn new_with_id(
        id: Uuid,
        language: Language,
        audio_source: AudioSourceInfo,
        audio_path: PathBuf,
    ) -> Self {
        Self {
            id,
            created_at: rfc3339_now(),
            language,
            audio_source,
            status: TranscriptStatus::Recording,
            live_segments: Vec::new(),
            final_segments: None,
            audio_path: Some(audio_path),
            speaker_names: HashMap::new(),
            models_used: ModelsUsed::default(),
            expected_speakers: None,
            last_seq: 0,
        }
    }

    /// `final_segments` if the offline pass ran, else `live_segments`.
    pub fn effective_segments(&self) -> &[Segment] {
        match &self.final_segments {
            Some(s) => s.as_slice(),
            None => self.live_segments.as_slice(),
        }
    }

    /// Sets a user-supplied display name for `speaker`. Empty string clears it.
    pub fn relabel_speaker(&mut self, speaker: SpeakerId, name: &str) {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            self.speaker_names.remove(&speaker);
        } else {
            // Cap label length defensively — matches the Tauri command's cap.
            let capped: String = trimmed.chars().take(64).collect();
            self.speaker_names.insert(speaker, capped);
        }
    }

    /// Display label for a speaker — the user-supplied name if any, else
    /// `Speaker N` (1-indexed).
    pub fn speaker_label(&self, speaker: SpeakerId) -> String {
        self.speaker_names
            .get(&speaker)
            .cloned()
            .unwrap_or_else(|| speaker.display_label())
    }

    /// Merges `final_segments` from the offline pass; remaps speaker IDs to
    /// preserve user-supplied names by max-overlap against the live turns.
    /// `final_turns` and `live_turns` are the diarizer outputs from each pass.
    pub fn merge_live_into_final(
        &mut self,
        mut final_segs: Vec<Segment>,
        final_turns: &[SpeakerTurn],
        live_turns: &[SpeakerTurn],
    ) {
        let remap = remap_speakers_by_overlap(final_turns, live_turns);
        for seg in &mut final_segs {
            if let Some(s) = seg.speaker {
                seg.speaker = remap.get(&s).copied().or(seg.speaker);
            }
        }
        self.final_segments = Some(final_segs);
    }

    /// Drops the recorded audio file (best-effort) and clears `audio_path`.
    /// After this, re-transcription is impossible.
    pub fn discard_audio(&mut self) -> std::io::Result<()> {
        if let Some(p) = self.audio_path.take() {
            if p.exists() {
                std::fs::remove_file(&p)?;
            }
        }
        Ok(())
    }

    /// Renders the transcript as markdown with `[Speaker N]` (or the user-supplied
    /// name) per segment, plus a header and an "approximate labels" footer.
    pub fn to_markdown(&self) -> String {
        let mut s = String::new();
        s.push_str(&format!("# Meeting transcript ({})\n\n", self.created_at));
        s.push_str(&format!("- Language: `{}`\n", self.language.code()));
        s.push_str(&format!("- Source: {}\n", self.audio_source.label));
        s.push_str(&format!("- Status: {}\n\n", status_label(&self.status)));
        let mut last_speaker: Option<SpeakerId> = None;
        for seg in self.effective_segments() {
            if seg.speaker != last_speaker {
                let label = match seg.speaker {
                    Some(id) => self.speaker_label(id),
                    None => "Speaker ?".to_string(),
                };
                s.push_str(&format!("\n**{label}** ({}):\n", fmt_ts(seg.start)));
                last_speaker = seg.speaker;
            }
            s.push_str(seg.text.trim());
            s.push('\n');
        }
        s.push_str("\n---\n");
        s.push_str(
            "_Transcript generated locally by Speedwave; speaker labels are approximate._\n",
        );
        s
    }

    /// Loads a session from `<dir>/transcript.json`.
    pub fn load(dir: &Path) -> std::io::Result<Self> {
        let s = std::fs::read_to_string(dir.join(TRANSCRIPT_JSON))?;
        serde_json::from_str(&s)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
    }

    /// Saves this session to `<dir>/transcript.json` (atomic write + 0o600).
    pub fn save(&self, dir: &Path) -> std::io::Result<()> {
        std::fs::create_dir_all(dir)?;
        let final_path = dir.join(TRANSCRIPT_JSON);
        let tmp_path = dir.join(format!(".{TRANSCRIPT_JSON}.part"));
        let body = serde_json::to_string_pretty(self)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        std::fs::write(&tmp_path, body)?;
        std::fs::rename(&tmp_path, &final_path)?;
        restrict_file_perms(&final_path);
        Ok(())
    }
}

/// Time spent string `MM:SS.cs`.
fn fmt_ts(d: std::time::Duration) -> String {
    let secs = d.as_secs();
    let cs = d.subsec_millis() / 10;
    format!("{:02}:{:02}.{:02}", secs / 60, secs % 60, cs)
}

fn status_label(s: &TranscriptStatus) -> &'static str {
    match s {
        TranscriptStatus::Recording => "recording",
        TranscriptStatus::Finalizing { .. } => "finalizing",
        TranscriptStatus::Done => "done",
        TranscriptStatus::Failed { .. } => "failed",
    }
}

fn rfc3339_now() -> String {
    let secs = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let (y, mo, d, h, mi, s) = secs_to_ymd_hms(secs);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}

/// Quick UNIX-seconds → calendar (Gregorian, UTC, post-1970, ignoring leap seconds).
fn secs_to_ymd_hms(mut t: u64) -> (i32, u32, u32, u32, u32, u32) {
    let s = (t % 60) as u32;
    t /= 60;
    let mi = (t % 60) as u32;
    t /= 60;
    let h = (t % 24) as u32;
    t /= 24;
    let mut days = t as i64;
    let mut y: i32 = 1970;
    loop {
        let dy = if is_leap(y) { 366 } else { 365 };
        if days < dy {
            break;
        }
        days -= dy;
        y += 1;
    }
    let mdays = [
        31,
        if is_leap(y) { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let mut mo: u32 = 1;
    for &md in &mdays {
        if days < md {
            break;
        }
        days -= md;
        mo += 1;
    }
    (y, mo, (days + 1) as u32, h, mi, s)
}

fn is_leap(y: i32) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

fn restrict_file_perms(p: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    let _ = p;
}

/// Builds a `live-speaker → final-speaker` remap by finding, for each final
/// speaker, the live speaker whose turns overlap most.
fn remap_speakers_by_overlap(
    final_turns: &[SpeakerTurn],
    live_turns: &[SpeakerTurn],
) -> HashMap<SpeakerId, SpeakerId> {
    let mut overlap: HashMap<(SpeakerId, SpeakerId), f64> = HashMap::new();
    for f in final_turns {
        for l in live_turns {
            let a = f.start.max(l.start).as_secs_f64();
            let b = f.end.min(l.end).as_secs_f64();
            let ov = (b - a).max(0.0);
            if ov > 0.0 {
                *overlap.entry((f.speaker, l.speaker)).or_insert(0.0) += ov;
            }
        }
    }
    let final_ids: std::collections::BTreeSet<SpeakerId> =
        final_turns.iter().map(|t| t.speaker).collect();
    let mut out: HashMap<SpeakerId, SpeakerId> = HashMap::new();
    for f in final_ids {
        let mut best: Option<(SpeakerId, f64)> = None;
        for ((ff, ll), ov) in overlap.iter() {
            if *ff != f {
                continue;
            }
            match best {
                Some((_, cur)) if *ov < cur => {}
                Some((id, cur)) if (*ov - cur).abs() < 1e-9 && ll.0 >= id.0 => {}
                _ => best = Some((*ll, *ov)),
            }
        }
        if let Some((live_id, _)) = best {
            out.insert(f, live_id);
        }
    }
    out
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use crate::transcription::audio::AudioSource;
    use std::time::Duration;

    fn mk_source() -> AudioSourceInfo {
        AudioSourceInfo {
            source: AudioSource::SystemWide,
            label: "System (everything)".to_string(),
            app_id: None,
        }
    }
    fn seg(start_s: f32, end_s: f32, text: &str, spk: Option<u32>) -> Segment {
        Segment {
            start: Duration::from_secs_f32(start_s),
            end: Duration::from_secs_f32(end_s),
            text: text.to_string(),
            words: vec![],
            speaker: spk.map(SpeakerId),
        }
    }
    fn turn(start_s: f32, end_s: f32, spk: u32) -> SpeakerTurn {
        SpeakerTurn {
            start: Duration::from_secs_f32(start_s),
            end: Duration::from_secs_f32(end_s),
            speaker: SpeakerId(spk),
        }
    }

    #[test]
    fn new_session_starts_in_recording_with_an_audio_path_and_no_segments() {
        let s = TranscriptSession::new(Language::Pl, mk_source(), PathBuf::from("/tmp/a.wav"));
        assert!(matches!(s.status, TranscriptStatus::Recording));
        assert_eq!(s.language, Language::Pl);
        assert!(s.live_segments.is_empty());
        assert!(s.final_segments.is_none());
        assert!(s.speaker_names.is_empty());
        assert_eq!(s.last_seq, 0);
        assert_eq!(s.audio_path, Some(PathBuf::from("/tmp/a.wav")));
        // created_at parses as RFC 3339-ish (YYYY-MM-DDTHH:MM:SSZ).
        assert!(s.created_at.ends_with('Z') && s.created_at.len() == 20);
    }

    #[test]
    fn new_with_id_uses_the_caller_supplied_id_and_path() {
        let id = Uuid::new_v4();
        let s = TranscriptSession::new_with_id(
            id,
            Language::En,
            mk_source(),
            PathBuf::from("/data/transcripts/x/audio.wav"),
        );
        assert_eq!(s.id, id);
        assert_eq!(
            s.audio_path,
            Some(PathBuf::from("/data/transcripts/x/audio.wav"))
        );
        assert!(matches!(s.status, TranscriptStatus::Recording));
        // `new` delegates to it with a fresh id.
        let s2 = TranscriptSession::new(Language::Pl, mk_source(), PathBuf::from("/a.wav"));
        assert_ne!(s2.id, id);
    }

    #[test]
    fn effective_segments_prefers_final_when_present() {
        let mut s = TranscriptSession::new(Language::En, mk_source(), PathBuf::from("/a.wav"));
        s.live_segments = vec![seg(0.0, 1.0, "live", None)];
        assert_eq!(s.effective_segments().len(), 1);
        assert_eq!(s.effective_segments()[0].text, "live");
        s.final_segments = Some(vec![seg(0.0, 2.0, "final", None)]);
        assert_eq!(s.effective_segments().len(), 1);
        assert_eq!(s.effective_segments()[0].text, "final");
    }

    #[test]
    fn relabel_speaker_sets_clears_and_caps_length() {
        let mut s = TranscriptSession::new(Language::Pl, mk_source(), PathBuf::from("/a.wav"));
        s.relabel_speaker(SpeakerId(0), "  Alice  ");
        assert_eq!(
            s.speaker_names.get(&SpeakerId(0)).map(String::as_str),
            Some("Alice")
        );
        // Empty / whitespace clears.
        s.relabel_speaker(SpeakerId(0), "   ");
        assert!(!s.speaker_names.contains_key(&SpeakerId(0)));
        // Long names are capped (defensively).
        let long = "x".repeat(200);
        s.relabel_speaker(SpeakerId(1), &long);
        assert_eq!(
            s.speaker_names.get(&SpeakerId(1)).unwrap().chars().count(),
            64
        );
    }

    #[test]
    fn speaker_label_uses_user_name_else_default() {
        let mut s = TranscriptSession::new(Language::Pl, mk_source(), PathBuf::from("/a.wav"));
        assert_eq!(s.speaker_label(SpeakerId(0)), "Speaker 1");
        s.relabel_speaker(SpeakerId(0), "Alice");
        assert_eq!(s.speaker_label(SpeakerId(0)), "Alice");
        assert_eq!(s.speaker_label(SpeakerId(1)), "Speaker 2"); // unset → default
    }

    #[test]
    fn merge_live_into_final_preserves_user_relabels_via_overlap() {
        let mut s = TranscriptSession::new(Language::Pl, mk_source(), PathBuf::from("/a.wav"));
        // Live: Alice = SpeakerId(0) from 0..10; Bob = SpeakerId(1) from 10..20.
        s.relabel_speaker(SpeakerId(0), "Alice");
        s.relabel_speaker(SpeakerId(1), "Bob");
        let live_turns = vec![turn(0.0, 10.0, 0), turn(10.0, 20.0, 1)];
        // Final pass re-clustered with the same boundaries but flipped ids.
        let final_turns = vec![turn(0.0, 10.0, 7), turn(10.0, 20.0, 3)];
        let final_segs = vec![
            seg(2.0, 4.0, "hi", Some(7)),
            seg(12.0, 14.0, "hey", Some(3)),
        ];
        s.merge_live_into_final(final_segs, &final_turns, &live_turns);
        let merged = s.final_segments.as_ref().unwrap();
        // Final-7 had max overlap with live-0 → remapped to SpeakerId(0) = "Alice".
        assert_eq!(merged[0].speaker, Some(SpeakerId(0)));
        // Final-3 had max overlap with live-1 → remapped to SpeakerId(1) = "Bob".
        assert_eq!(merged[1].speaker, Some(SpeakerId(1)));
        // And speaker_label still resolves the user-supplied names.
        assert_eq!(s.speaker_label(SpeakerId(0)), "Alice");
        assert_eq!(s.speaker_label(SpeakerId(1)), "Bob");
    }

    #[test]
    fn merge_with_no_overlap_leaves_final_speakers_unmapped() {
        let mut s = TranscriptSession::new(Language::Pl, mk_source(), PathBuf::from("/a.wav"));
        let live_turns = vec![turn(0.0, 5.0, 0)];
        // Final turns completely disjoint from live.
        let final_turns = vec![turn(100.0, 105.0, 9)];
        let final_segs = vec![seg(101.0, 102.0, "x", Some(9))];
        s.merge_live_into_final(final_segs, &final_turns, &live_turns);
        // No mapping — speaker stays as-is (the final pass's own id).
        assert_eq!(
            s.final_segments.as_ref().unwrap()[0].speaker,
            Some(SpeakerId(9))
        );
    }

    #[test]
    fn discard_audio_clears_path_and_removes_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.wav");
        std::fs::write(&path, b"fake wav").unwrap();
        let mut s = TranscriptSession::new(Language::Pl, mk_source(), path.clone());
        s.discard_audio().unwrap();
        assert!(s.audio_path.is_none());
        assert!(!path.exists());
        // Idempotent — a second call is a no-op.
        s.discard_audio().unwrap();
    }

    #[test]
    fn to_markdown_renders_speakers_timestamps_and_the_footer() {
        let mut s = TranscriptSession::new(Language::Pl, mk_source(), PathBuf::from("/a.wav"));
        s.live_segments = vec![
            seg(0.0, 2.5, "Cześć!", Some(0)),
            seg(2.5, 5.0, "Witaj.", Some(1)),
            seg(5.0, 7.0, "Co słychać?", Some(0)),
        ];
        s.relabel_speaker(SpeakerId(0), "Ola");
        let md = s.to_markdown();
        assert!(md.starts_with("# Meeting transcript ("));
        assert!(md.contains("Language: `pl`"));
        assert!(md.contains("**Ola** (00:00.00):"));
        assert!(md.contains("**Speaker 2** (00:02.50):"));
        assert!(md.contains("Cześć!"));
        assert!(md.ends_with("speaker labels are approximate._\n"));
    }

    #[test]
    fn save_and_load_round_trip_with_atomic_write_and_restricted_perms() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = TranscriptSession::new(Language::En, mk_source(), PathBuf::from("/a.wav"));
        s.live_segments = vec![seg(0.0, 1.0, "hi", Some(0))];
        s.relabel_speaker(SpeakerId(0), "Alice");
        s.last_seq = 42;
        s.save(dir.path()).unwrap();
        // No leftover .part temp.
        assert!(!dir.path().join(format!(".{TRANSCRIPT_JSON}.part")).exists());
        let loaded = TranscriptSession::load(dir.path()).unwrap();
        assert_eq!(loaded, s);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.path().join(TRANSCRIPT_JSON))
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600, "transcript.json must be 0600");
        }
    }

    #[test]
    fn load_reports_a_clean_error_on_corrupt_json() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(TRANSCRIPT_JSON), b"{ not json").unwrap();
        let err = TranscriptSession::load(dir.path()).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidData);
    }

    #[test]
    fn status_serde_round_trip() {
        for s in [
            TranscriptStatus::Recording,
            TranscriptStatus::Finalizing { progress: 0.42 },
            TranscriptStatus::Done,
            TranscriptStatus::Failed {
                reason: "oops".to_string(),
            },
        ] {
            let j = serde_json::to_string(&s).unwrap();
            assert_eq!(serde_json::from_str::<TranscriptStatus>(&j).unwrap(), s);
        }
    }

    #[test]
    fn rfc3339_now_format_sanity() {
        // Year is plausible (post-2020) and the shape matches YYYY-MM-DDTHH:MM:SSZ.
        let s = rfc3339_now();
        assert_eq!(s.len(), 20);
        assert!(s.ends_with('Z'));
        let year: i32 = s[..4].parse().unwrap();
        assert!((2020..2100).contains(&year), "year {year} not plausible");
    }

    #[test]
    fn ymd_hms_known_epochs() {
        // 1970-01-01T00:00:00Z
        assert_eq!(secs_to_ymd_hms(0), (1970, 1, 1, 0, 0, 0));
        // 2024-01-01T00:00:00Z = 1_704_067_200.
        assert_eq!(secs_to_ymd_hms(1_704_067_200), (2024, 1, 1, 0, 0, 0));
        // 2024-12-31T23:59:59Z = 1_735_689_599.
        assert_eq!(secs_to_ymd_hms(1_735_689_599), (2024, 12, 31, 23, 59, 59));
    }
}
