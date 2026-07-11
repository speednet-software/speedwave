//! Per-recording session: status, segments, on-disk persistence.

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::transcription::audio::AudioSourceInfo;
use crate::transcription::transcriber::{Language, Segment};

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

/// Which Whisper model was used for each pass.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ModelsUsed {
    /// Whisper catalogue key used for the live pass.
    pub live: Option<String>,
    /// Whisper catalogue key used for the higher-quality offline pass.
    pub finalize: Option<String>,
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
    /// On-disk audio file (`None` if missing/never recorded).
    pub audio_path: Option<PathBuf>,
    /// What models were used for each pass.
    pub models_used: ModelsUsed,
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
            models_used: ModelsUsed::default(),
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

    /// Installs `final_segments` from the higher-quality offline pass.
    pub fn set_final_segments(&mut self, final_segs: Vec<Segment>) {
        self.final_segments = Some(final_segs);
    }

    /// Renders the transcript as markdown: a header plus one timestamped line
    /// per segment. (Speaker labels were removed — ADR-075.)
    pub fn to_markdown(&self) -> String {
        let mut s = String::new();
        s.push_str(&format!("# Meeting transcript ({})\n\n", self.created_at));
        s.push_str(&format!("- Language: `{}`\n", self.language.code()));
        s.push_str(&format!("- Source: {}\n", self.audio_source.label));
        s.push_str(&format!("- Status: {}\n\n", status_label(&self.status)));
        for seg in self.effective_segments() {
            let text = seg.text.trim();
            if text.is_empty() {
                continue;
            }
            s.push_str(&format!("**({})** {text}\n\n", fmt_ts(seg.start)));
        }
        s.push_str("---\n");
        s.push_str("_Transcript generated locally by Speedwave._\n");
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

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code: unwrap on fixtures is the sanctioned boundary"
)]
mod tests {
    use super::*;
    use crate::transcription::audio::AudioSource;
    use std::time::Duration;

    fn mk_source() -> AudioSourceInfo {
        AudioSourceInfo {
            source: AudioSource::SystemWide,
            label: "System (everything)".to_string(),
        }
    }
    fn seg(start_s: f32, end_s: f32, text: &str) -> Segment {
        Segment {
            start: Duration::from_secs_f32(start_s),
            end: Duration::from_secs_f32(end_s),
            text: text.to_string(),
            words: vec![],
        }
    }

    #[test]
    fn new_session_starts_in_recording_with_an_audio_path_and_no_segments() {
        let s = TranscriptSession::new(Language::Pl, mk_source(), PathBuf::from("/tmp/a.wav"));
        assert!(matches!(s.status, TranscriptStatus::Recording));
        assert_eq!(s.language, Language::Pl);
        assert!(s.live_segments.is_empty());
        assert!(s.final_segments.is_none());
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
        s.live_segments = vec![seg(0.0, 1.0, "live")];
        assert_eq!(s.effective_segments().len(), 1);
        assert_eq!(s.effective_segments()[0].text, "live");
        s.set_final_segments(vec![seg(0.0, 2.0, "final")]);
        assert_eq!(s.effective_segments().len(), 1);
        assert_eq!(s.effective_segments()[0].text, "final");
    }

    #[test]
    fn to_markdown_renders_timestamps_text_and_the_footer() {
        let mut s = TranscriptSession::new(Language::Pl, mk_source(), PathBuf::from("/a.wav"));
        s.live_segments = vec![
            seg(0.0, 2.5, "Cześć!"),
            seg(2.5, 5.0, "Witaj."),
            seg(5.0, 7.0, "   "), // blank → skipped
        ];
        let md = s.to_markdown();
        assert!(md.starts_with("# Meeting transcript ("));
        assert!(md.contains("Language: `pl`"));
        assert!(md.contains("**(00:00.00)** Cześć!"));
        assert!(md.contains("**(00:02.50)** Witaj."));
        assert!(!md.contains("Speaker"), "no speaker labels after ADR-075");
        assert!(md.ends_with("_Transcript generated locally by Speedwave._\n"));
    }

    #[test]
    fn old_transcript_json_with_speaker_fields_still_loads() {
        // Backward compat (ADR-075): a pre-removal transcript.json carried
        // `speaker_names`, `expected_speakers`, per-segment `speaker`, and
        // `models_used.diarization_*`. Loading must ignore them (serde drops
        // unknown keys) and re-save in the new shape.
        let dir = tempfile::tempdir().unwrap();
        let legacy = r#"{
            "id":"00000000-0000-4000-8000-000000000000",
            "created_at":"2026-01-01T00:00:00Z",
            "language":"pl",
            "audio_source":{"source":{"kind":"system_wide"},"label":"System","app_id":null},
            "status":{"state":"done"},
            "live_segments":[{"start":{"secs":0,"nanos":0},"end":{"secs":1,"nanos":0},
                "text":"hej","words":[],"speaker":2}],
            "final_segments":null,
            "audio_path":null,
            "speaker_names":[[0,"Ola"]],
            "models_used":{"live":"small","finalize":null,
                "diarization_segmentation":"pyannote","diarization_embedding":"campplus"},
            "expected_speakers":3,
            "last_seq":7
        }"#;
        std::fs::write(dir.path().join(TRANSCRIPT_JSON), legacy).unwrap();
        let s = TranscriptSession::load(dir.path()).unwrap();
        assert_eq!(s.live_segments.len(), 1);
        assert_eq!(s.live_segments[0].text, "hej");
        assert_eq!(s.models_used.live.as_deref(), Some("small"));
        assert_eq!(s.last_seq, 7);
        // Re-saving produces the new shape with no diarization keys.
        s.save(dir.path()).unwrap();
        let body = std::fs::read_to_string(dir.path().join(TRANSCRIPT_JSON)).unwrap();
        assert!(!body.contains("speaker_names"));
        assert!(!body.contains("diarization"));
        assert!(!body.contains("expected_speakers"));
    }

    #[test]
    fn save_and_load_round_trip_with_atomic_write_and_restricted_perms() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = TranscriptSession::new(Language::En, mk_source(), PathBuf::from("/a.wav"));
        s.live_segments = vec![seg(0.0, 1.0, "hi")];
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
        // 2000-02-29 (leap day) at 12:34:56: precompute the exact seconds.
        // Use the algorithm itself to derive — but we can pick a known date:
        // 2024-01-01T00:00:00Z = 1_704_067_200.
        assert_eq!(secs_to_ymd_hms(1_704_067_200), (2024, 1, 1, 0, 0, 0));
        // 2024-12-31T23:59:59Z = 1_735_689_599.
        assert_eq!(secs_to_ymd_hms(1_735_689_599), (2024, 12, 31, 23, 59, 59));
    }
}
