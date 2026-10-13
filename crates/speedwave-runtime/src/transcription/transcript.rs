//! Per-recording session: status, segments, on-disk persistence.

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::transcription::audio::{AudioSourceInfo, CaptureWarning};
use crate::transcription::transcriber::{Language, Segment};

/// On-disk filename for the persisted session.
pub const TRANSCRIPT_JSON: &str = "transcript.json";

/// On-disk filename for the recorded audio.
pub const AUDIO_WAV: &str = "audio.wav";

/// Longest title a user can give a recording, in characters.
pub const TITLE_MAX_CHARS: usize = 120;

/// Longest transcript preview the recordings list carries, in characters.
const PREVIEW_MAX_CHARS: usize = 140;

/// Lifecycle status of a recording.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "state")]
pub enum TranscriptStatus {
    /// Capturing audio + live transcription.
    Recording,
    /// Capture paused by the user: every part so far is closed, the microphone is released, and
    /// nothing is transcribed until a resume adds a part or a stop starts the offline pass.
    Paused,
    /// Stopped; running the higher-quality offline pass.
    Finalizing {
        /// 0.0 → 1.0 (driver-reported).
        progress: f32,
    },
    /// Done — `effective_segments()` returns the final pass if it ran.
    Done,
    /// The user put the offline pass off ("Later"): the audio is kept untranscribed until they
    /// start the pass again, so it does not load the machine during their next meeting.
    Postponed,
    /// Failed at some stage.
    Failed {
        /// Human-readable reason.
        reason: String,
    },
}

/// Which Whisper model was used for each pass.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ModelsUsed {
    /// Whisper catalogue key used for the live pass; `None` = record-only (no live pass ran
    /// for the current part — the UI keys record-only rendering on it, ADR-056 Am. 13).
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
    /// User-given name; `None` until renamed (the UI then shows the local start time).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
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
    /// Audio files recorded by later resumes (`audio-2.wav`, …), in order,
    /// after `audio_path` (ADR-056 Amendment 10). Empty on never-resumed sessions.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub audio_parts: Vec<PathBuf>,
    /// Capture warnings raised for this session, in arrival order (ADR-056 Am. 16). Retired when
    /// a capture ends; one raised by the offline pass afterwards stays on the finished session.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub active_warnings: Vec<CaptureWarning>,
    /// What models were used for each pass.
    pub models_used: ModelsUsed,
    /// Last event seq emitted for this session — for snapshot+stream resume.
    pub last_seq: u64,
    /// Uncommitted tail of the latest live decode — replace-only display state,
    /// never persisted and never part of `effective_segments`.
    #[serde(skip, default)]
    pub live_draft: String,
    /// `models_used.live` as it was before the in-flight resume — consumed by
    /// `rollback_resume` so the invariant lives in the store, not at call sites.
    #[serde(skip, default)]
    pub(crate) prior_live_model: Option<String>,
    #[serde(skip, default)]
    pub(crate) prior_active_warnings: Vec<CaptureWarning>,
    /// Whether the in-flight resume reopened a paused session, so a rollback returns it there.
    #[serde(skip, default)]
    pub(crate) resumed_from_pause: bool,
    /// The offline pass allowed to write this session; a postponed or replaced one writes nothing.
    #[serde(skip, default)]
    pub(crate) offline_pass: Option<super::transcript_store::OfflinePass>,
}

/// One row of the recordings list: everything but the segments.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TranscriptSummary {
    /// Session id.
    pub id: Uuid,
    /// Created-at, RFC 3339 UTC.
    pub created_at: String,
    /// User-given name, if any.
    pub title: Option<String>,
    /// Forced language.
    pub language: Language,
    /// Label of the captured source.
    pub source_label: String,
    /// Lifecycle.
    pub status: TranscriptStatus,
    /// Recorded audio across every part, from the WAV headers (0 while a part is still open).
    pub duration_secs: f64,
    /// Segments in the transcript the user sees (`effective_segments`).
    pub segment_count: usize,
    /// First non-empty line of that transcript, shortened.
    pub preview: Option<String>,
    /// Bytes the session directory takes on disk (audio and transcript).
    pub size_bytes: u64,
    /// Whisper catalogue key of the offline pass that made (or is making) the transcript.
    pub finalize_model: Option<String>,
    /// `true` while the offline pass waits for another recording's pass to finish.
    pub queued: bool,
}

impl TranscriptSession {
    /// A new session in `Recording` state.
    pub fn new(language: Language, audio_source: AudioSourceInfo, audio_path: PathBuf) -> Self {
        Self::new_with_id(Uuid::new_v4(), language, audio_source, audio_path)
    }

    /// Like `new`, but with a caller-chosen id — for when the audio-file path (under
    /// `<root>/<id>/`) must be known before the session is created.
    pub fn new_with_id(
        id: Uuid,
        language: Language,
        audio_source: AudioSourceInfo,
        audio_path: PathBuf,
    ) -> Self {
        Self {
            id,
            created_at: rfc3339_now(),
            title: None,
            language,
            audio_source,
            status: TranscriptStatus::Recording,
            live_segments: Vec::new(),
            final_segments: None,
            audio_path: Some(audio_path),
            audio_parts: Vec::new(),
            active_warnings: Vec::new(),
            models_used: ModelsUsed::default(),
            last_seq: 0,
            live_draft: String::new(),
            prior_live_model: None,
            prior_active_warnings: Vec::new(),
            resumed_from_pause: false,
            offline_pass: None,
        }
    }

    /// Every audio part in recording order: `audio_path` then `audio_parts`.
    pub fn all_audio_parts(&self) -> Vec<PathBuf> {
        self.audio_path
            .iter()
            .chain(self.audio_parts.iter())
            .cloned()
            .collect()
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

    /// The recordings-list row for this session; `dir` is its directory, read for the audio
    /// duration (WAV headers only) and the size on disk.
    pub fn summary(&self, dir: &Path) -> TranscriptSummary {
        let duration_secs = self
            .all_audio_parts()
            .iter()
            .filter_map(|p| crate::transcription::audio::wav_duration(p))
            .map(|d| d.as_secs_f64())
            .sum();
        let size_bytes = std::fs::read_dir(dir)
            .map(|entries| {
                entries
                    .flatten()
                    .filter_map(|e| e.metadata().ok())
                    .filter(std::fs::Metadata::is_file)
                    .map(|m| m.len())
                    .sum()
            })
            .unwrap_or(0);
        let mut segments: Vec<&Segment> = self.effective_segments().iter().collect();
        segments.sort_by_key(|seg| seg.start);
        let preview = segments
            .iter()
            .map(|seg| seg.text.trim())
            .find(|text| !text.is_empty())
            .map(|text| truncate_chars(text, PREVIEW_MAX_CHARS));
        TranscriptSummary {
            id: self.id,
            created_at: self.created_at.clone(),
            title: self.title.clone(),
            language: self.language,
            source_label: self.audio_source.label.clone(),
            status: self.status.clone(),
            duration_secs,
            segment_count: segments.len(),
            preview,
            size_bytes,
            finalize_model: self.models_used.finalize.clone(),
            queued: false,
        }
    }

    /// Renders the transcript as markdown: a header plus one timestamped line per segment,
    /// channel-labelled on paired captures (channel attribution, not diarization — ADR-075).
    pub fn to_markdown(&self) -> String {
        let mut s = String::new();
        match &self.title {
            Some(title) => {
                s.push_str(&format!("# {title}\n\n"));
                s.push_str(&format!("- Recorded: {}\n", self.created_at));
            }
            None => s.push_str(&format!("# Meeting transcript ({})\n\n", self.created_at)),
        }
        s.push_str(&format!("- Language: `{}`\n", self.language.code()));
        s.push_str(&format!("- Source: {}\n", self.audio_source.label));
        s.push_str(&format!("- Status: {}\n\n", status_label(&self.status)));
        let mut segments: Vec<&Segment> = self.effective_segments().iter().collect();
        segments.sort_by_key(|seg| seg.start);
        for seg in segments {
            let text = seg.text.trim();
            if text.is_empty() {
                continue;
            }
            let label = match seg.source {
                Some(src) => format!(" {}:", src.label()),
                None => String::new(),
            };
            s.push_str(&format!("**({}){label}** {text}\n\n", fmt_ts(seg.start)));
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

    /// Saves this session to `<dir>/transcript.json` (durable atomic write + owner-only perms).
    pub fn save(&self, dir: &Path) -> std::io::Result<()> {
        std::fs::create_dir_all(dir)?;
        let final_path = dir.join(TRANSCRIPT_JSON);
        let body = serde_json::to_string_pretty(self)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        crate::fs_perms::write_restricted_file_atomic(&final_path, &body)
            .map_err(|e| std::io::Error::other(e.to_string()))
    }
}

/// Normalises a user-typed title: control characters dropped, whitespace runs collapsed, cut to
/// [`TITLE_MAX_CHARS`]; `None` when nothing is left (the session goes back to its default name).
pub fn normalize_title(raw: &str) -> Option<String> {
    let cleaned: String = raw
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        return None;
    }
    Some(collapsed.chars().take(TITLE_MAX_CHARS).collect())
}

fn truncate_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut cut: String = text.chars().take(max - 1).collect();
    cut.push('…');
    cut
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
        TranscriptStatus::Paused => "paused",
        TranscriptStatus::Finalizing { .. } => "finalizing",
        TranscriptStatus::Done => "done",
        TranscriptStatus::Postponed => "postponed",
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
            source: None,
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
            seg(5.0, 7.0, "   "),
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
    fn to_markdown_labels_channel_tagged_segments() {
        use crate::transcription::transcriber::TranscriptSource;
        let mut s = TranscriptSession::new(Language::Pl, mk_source(), PathBuf::from("/a.wav"));
        let mut sys = seg(0.0, 2.0, "Dzień dobry państwu.");
        sys.source = Some(TranscriptSource::System);
        let mut mic = seg(2.0, 3.0, "Cześć.");
        mic.source = Some(TranscriptSource::Mic);
        s.live_segments = vec![sys, mic, seg(3.0, 4.0, "bez kanału")];
        let md = s.to_markdown();
        assert!(md.contains("**(00:00.00) Meeting:** Dzień dobry państwu."));
        assert!(md.contains("**(00:02.00) You:** Cześć."));
        assert!(md.contains("**(00:03.00)** bez kanału"));
    }

    #[test]
    fn to_markdown_renders_live_segments_chronologically() {
        use crate::transcription::transcriber::TranscriptSource;
        let mut s = TranscriptSession::new(Language::Pl, mk_source(), PathBuf::from("/a.wav"));
        let mut late = seg(5.0, 6.0, "później");
        late.source = Some(TranscriptSource::System);
        let mut early = seg(1.0, 2.0, "wcześniej");
        early.source = Some(TranscriptSource::Mic);
        s.live_segments = vec![late, early];
        let md = s.to_markdown();
        let early_at = md.find("wcześniej").unwrap();
        let late_at = md.find("później").unwrap();
        assert!(
            early_at < late_at,
            "markdown must follow start time, not storage order"
        );
    }

    #[test]
    fn to_markdown_uses_the_title_as_heading_and_keeps_the_start_time() {
        let mut s = TranscriptSession::new(Language::En, mk_source(), PathBuf::from("/a.wav"));
        s.title = Some("Sprint review".to_string());
        let md = s.to_markdown();
        assert!(md.starts_with("# Sprint review\n\n"));
        assert!(md.contains(&format!("- Recorded: {}\n", s.created_at)));
        assert!(!md.contains("# Meeting transcript ("));
    }

    #[test]
    fn normalize_title_trims_collapses_and_caps_the_length() {
        assert_eq!(
            normalize_title("  Weekly\t sync \n"),
            Some("Weekly sync".to_string())
        );
        assert_eq!(normalize_title("a\u{7}b"), Some("a b".to_string()));
        assert_eq!(normalize_title("   "), None);
        assert_eq!(normalize_title(""), None);
        assert_eq!(
            normalize_title("Spotkanie zespołu 🎙"),
            Some("Spotkanie zespołu 🎙".to_string())
        );
        let long = "ż".repeat(TITLE_MAX_CHARS + 10);
        assert_eq!(
            normalize_title(&long).unwrap().chars().count(),
            TITLE_MAX_CHARS
        );
    }

    #[test]
    fn title_is_omitted_until_set_and_round_trips() {
        let mut s = TranscriptSession::new(Language::Pl, mk_source(), PathBuf::from("a.wav"));
        let json = serde_json::to_value(&s).unwrap();
        assert!(json.get("title").is_none());
        s.title = Some("Demo".to_string());
        let json = serde_json::to_value(&s).unwrap();
        assert_eq!(json.get("title").unwrap(), "Demo");
        let back: TranscriptSession = serde_json::from_value(json).unwrap();
        assert_eq!(back.title.as_deref(), Some("Demo"));
    }

    #[test]
    fn title_field_matches_ts_mirror() {
        let src = include_str!("../../../../desktop/src/src/app/models/transcript.ts");
        assert!(
            src.contains("title?: string | null"),
            "models/transcript.ts TranscriptSession must carry the optional title field"
        );
    }

    fn write_wav(path: &Path, frames: usize) {
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 16_000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut w = hound::WavWriter::create(path, spec).unwrap();
        for _ in 0..frames {
            w.write_sample(0i16).unwrap();
        }
        w.finalize().unwrap();
    }

    #[test]
    fn summary_sums_every_part_and_reports_the_final_transcript() {
        let dir = tempfile::tempdir().unwrap();
        let first = dir.path().join(AUDIO_WAV);
        let second = dir.path().join("audio-2.wav");
        write_wav(&first, 16_000);
        write_wav(&second, 8_000);
        let mut s = TranscriptSession::new(Language::Pl, mk_source(), first);
        s.audio_parts.push(second);
        s.title = Some("Retro".to_string());
        s.live_segments = vec![seg(0.0, 1.0, "live only")];
        s.set_final_segments(vec![
            seg(5.0, 6.0, "później"),
            seg(0.0, 1.0, "  Dzień dobry "),
        ]);
        s.save(dir.path()).unwrap();

        let sum = s.summary(dir.path());
        assert_eq!(sum.id, s.id);
        assert_eq!(sum.title.as_deref(), Some("Retro"));
        assert_eq!(sum.source_label, "System (everything)");
        assert!((sum.duration_secs - 1.5).abs() < 1e-9);
        assert_eq!(
            sum.segment_count, 2,
            "counts the offline pass, not the live one"
        );
        assert_eq!(sum.preview.as_deref(), Some("Dzień dobry"));
        let on_disk: u64 = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().metadata().unwrap().len())
            .sum();
        assert_eq!(sum.size_bytes, on_disk);
    }

    #[test]
    fn summary_of_a_record_only_session_counts_its_final_segments() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = TranscriptSession::new(Language::Pl, mk_source(), dir.path().join("a.wav"));
        assert!(s.live_segments.is_empty());
        s.set_final_segments(vec![seg(0.0, 1.0, "tekst")]);
        assert_eq!(s.summary(dir.path()).segment_count, 1);
    }

    #[test]
    fn summary_tolerates_missing_audio_and_an_empty_transcript() {
        let dir = tempfile::tempdir().unwrap();
        let s = TranscriptSession::new(Language::En, mk_source(), dir.path().join("none.wav"));
        let sum = s.summary(dir.path());
        assert_eq!(sum.duration_secs, 0.0);
        assert_eq!(sum.segment_count, 0);
        assert_eq!(sum.preview, None);
        assert_eq!(sum.size_bytes, 0);
        let gone = s.summary(&dir.path().join("deleted"));
        assert_eq!(gone.size_bytes, 0);
    }

    #[test]
    fn summary_preview_skips_blank_segments_and_shortens_long_text() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = TranscriptSession::new(Language::En, mk_source(), dir.path().join("a.wav"));
        let long = "word ".repeat(100);
        s.live_segments = vec![seg(0.0, 1.0, "   "), seg(1.0, 2.0, &long)];
        let preview = s.summary(dir.path()).preview.unwrap();
        assert_eq!(preview.chars().count(), PREVIEW_MAX_CHARS);
        assert!(preview.ends_with('…'));
    }

    #[test]
    fn transcript_summary_fields_match_ts_mirror() {
        let src = include_str!("../../../../desktop/src/src/app/models/transcript.ts");
        let dir = tempfile::tempdir().unwrap();
        let s = TranscriptSession::new(Language::En, mk_source(), dir.path().join("a.wav"));
        let json = serde_json::to_value(s.summary(dir.path())).unwrap();
        let start = src.find("export interface TranscriptSummary {").unwrap();
        let body = &src[start..start + src[start..].find("\n}").unwrap()];
        for key in json.as_object().unwrap().keys() {
            assert!(
                body.contains(&format!("  {key}:")),
                "models/transcript.ts TranscriptSummary is missing `{key}`"
            );
        }
    }

    #[test]
    fn paused_status_matches_ts_mirror() {
        let src = include_str!("../../../../desktop/src/src/app/models/transcript.ts");
        let wire = serde_json::to_string(&TranscriptStatus::Paused).unwrap();
        assert_eq!(wire, r#"{"state":"paused"}"#);
        assert!(
            src.contains("| { state: 'paused' }"),
            "models/transcript.ts TranscriptStatus must carry the paused state"
        );
    }

    #[test]
    fn postponed_status_matches_ts_mirror() {
        let src = include_str!("../../../../desktop/src/src/app/models/transcript.ts");
        let wire = serde_json::to_string(&TranscriptStatus::Postponed).unwrap();
        assert_eq!(wire, r#"{"state":"postponed"}"#);
        assert!(
            src.contains("| { state: 'postponed' }"),
            "models/transcript.ts TranscriptStatus must carry the postponed state"
        );
    }

    #[test]
    fn audio_parts_field_matches_ts_mirror() {
        let src = include_str!("../../../../desktop/src/src/app/models/transcript.ts");
        assert!(
            src.contains("audio_parts?: string[]"),
            "models/transcript.ts TranscriptSession must carry the optional audio_parts field"
        );
    }

    #[test]
    fn active_warnings_field_matches_ts_mirror() {
        let src = include_str!("../../../../desktop/src/src/app/models/transcript.ts");
        assert!(
            src.contains("active_warnings?: CaptureWarning[]"),
            "models/transcript.ts TranscriptSession must carry the optional active_warnings field"
        );
    }

    #[test]
    fn active_warnings_is_omitted_when_empty_and_wire_encoded_when_raised() {
        let mut s = TranscriptSession::new(Language::Pl, mk_source(), PathBuf::from("a.wav"));
        assert!(s.active_warnings.is_empty(), "a new session is healthy");
        let json = serde_json::to_value(&s).unwrap();
        assert!(
            json.get("active_warnings").is_none(),
            "an empty list stays off the wire so older readers see no new field"
        );

        s.active_warnings = vec![
            CaptureWarning::MicrophoneStalled,
            CaptureWarning::AudioDropped,
        ];
        let json = serde_json::to_value(&s).unwrap();
        assert_eq!(
            json.get("active_warnings").unwrap().to_string(),
            "[\"microphone_stalled\",\"audio_dropped\"]",
            "arrival order and snake_case wire names are both part of the contract"
        );
        let back: TranscriptSession = serde_json::from_value(json).unwrap();
        assert_eq!(back.active_warnings, s.active_warnings);
    }

    #[test]
    fn transcript_source_variants_match_ts_union() {
        use crate::transcription::transcriber::TranscriptSource;
        let src = include_str!("../../../../desktop/src/src/app/models/transcript.ts");
        for (variant, json) in [
            (TranscriptSource::System, "system"),
            (TranscriptSource::Mic, "mic"),
        ] {
            assert_eq!(
                serde_json::to_string(&variant).unwrap(),
                format!("\"{json}\"")
            );
        }
        assert!(
            src.contains("export type TranscriptSource = 'system' | 'mic'"),
            "models/transcript.ts must mirror the TranscriptSource union"
        );
        assert!(
            src.contains("source?: TranscriptSource | null"),
            "models/transcript.ts Segment must carry the optional source field"
        );
    }

    #[test]
    fn segment_source_serde_defaults_to_none_and_round_trips() {
        use crate::transcription::transcriber::TranscriptSource;
        let legacy = r#"{"start":{"secs":0,"nanos":0},"end":{"secs":1,"nanos":0},
            "text":"hej","words":[]}"#;
        let s: Segment = serde_json::from_str(legacy).unwrap();
        assert_eq!(s.source, None);
        let mut tagged = seg(0.0, 1.0, "x");
        assert!(!serde_json::to_string(&tagged).unwrap().contains("source"));
        tagged.source = Some(TranscriptSource::Mic);
        let j = serde_json::to_string(&tagged).unwrap();
        assert!(j.contains("\"source\":\"mic\""));
        assert_eq!(serde_json::from_str::<Segment>(&j).unwrap(), tagged);
    }

    #[test]
    fn old_transcript_json_with_speaker_fields_still_loads() {
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
        let entries: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(entries, vec![TRANSCRIPT_JSON.to_string()]);
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
            TranscriptStatus::Paused,
            TranscriptStatus::Finalizing { progress: 0.42 },
            TranscriptStatus::Done,
            TranscriptStatus::Postponed,
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
        let s = rfc3339_now();
        assert_eq!(s.len(), 20);
        assert!(s.ends_with('Z'));
        let year: i32 = s[..4].parse().unwrap();
        assert!((2020..2100).contains(&year), "year {year} not plausible");
    }

    #[test]
    fn ymd_hms_known_epochs() {
        assert_eq!(secs_to_ymd_hms(0), (1970, 1, 1, 0, 0, 0));
        assert_eq!(secs_to_ymd_hms(1_704_067_200), (2024, 1, 1, 0, 0, 0));
        assert_eq!(secs_to_ymd_hms(1_735_689_599), (2024, 12, 31, 23, 59, 59));
    }
}
