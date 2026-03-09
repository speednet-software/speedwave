/// Chat history — reads Claude Code JSONL session files and project memory.
///
/// All public functions resolve paths from `dirs::home_dir()` and delegate to
/// internal `_impl` functions that accept a `base_dir: &Path` parameter.
/// Tests call the `_impl` functions directly with `tempfile::TempDir`.
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use speedwave_runtime::consts;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Summary of a single conversation (session file).
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ConversationSummary {
    pub session_id: String,
    pub timestamp: Option<String>,
    pub preview: String,
    pub message_count: usize,
}

/// A single message extracted from a JSONL session.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ConversationMessage {
    pub role: String,
    pub content: String,
    pub timestamp: Option<String>,
}

/// Full transcript of a conversation.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ConversationTranscript {
    pub session_id: String,
    pub messages: Vec<ConversationMessage>,
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

fn base_dir() -> anyhow::Result<PathBuf> {
    dirs::home_dir().ok_or_else(|| anyhow::anyhow!("cannot determine home directory"))
}

fn claude_dot_dir_impl(base: &Path, project: &str) -> anyhow::Result<PathBuf> {
    Ok(base
        .join(consts::DATA_DIR)
        .join("claude-home")
        .join(project)
        .join(".claude"))
}

fn sessions_dir_impl(base: &Path, project: &str) -> anyhow::Result<PathBuf> {
    Ok(claude_dot_dir_impl(base, project)?
        .join("projects")
        .join("-workspace"))
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/// Validate that `id` looks like a lowercase UUID v4 hex string.
/// Accepts: `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` (8-4-4-4-12, hex digits).
pub fn validate_session_id(id: &str) -> anyhow::Result<()> {
    validate_session_id_impl(id)
}

fn validate_session_id_impl(id: &str) -> anyhow::Result<()> {
    let parts: Vec<&str> = id.split('-').collect();
    if parts.len() != 5 {
        anyhow::bail!("invalid session id: expected UUID format");
    }
    let expected_lens = [8, 4, 4, 4, 12];
    for (part, &expected_len) in parts.iter().zip(&expected_lens) {
        if part.len() != expected_len {
            anyhow::bail!("invalid session id: wrong segment length");
        }
        if !part
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        {
            anyhow::bail!("invalid session id: non-hex or uppercase character");
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// JSONL parsing helpers
// ---------------------------------------------------------------------------

/// Extract displayable text from a JSONL message line.
/// Returns `None` if the line should be skipped.
fn parse_jsonl_message(line: &str) -> Option<ConversationMessage> {
    let parsed: serde_json::Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => {
            log::debug!("skipping malformed JSONL line: {e}");
            return None;
        }
    };

    let msg_type = parsed["type"].as_str().unwrap_or("");

    match msg_type {
        "user" => parse_user_message(&parsed),
        "assistant" => parse_assistant_message(&parsed),
        _ => {
            // file-history-snapshot, system, progress, unknown — skip
            None
        }
    }
}

fn parse_user_message(parsed: &serde_json::Value) -> Option<ConversationMessage> {
    let message = &parsed["message"];
    let content = &message["content"];
    let timestamp = parsed["timestamp"].as_str().map(String::from);

    // content can be a plain string
    if let Some(text) = content.as_str() {
        if text.is_empty() {
            return None;
        }
        return Some(ConversationMessage {
            role: "user".to_string(),
            content: text.to_string(),
            timestamp,
        });
    }

    // content can be an array of blocks
    if let Some(blocks) = content.as_array() {
        // Skip messages where content is only tool_result blocks
        let has_non_tool_result = blocks
            .iter()
            .any(|b| b["type"].as_str().unwrap_or("") != "tool_result");
        if !has_non_tool_result {
            return None;
        }

        let mut text_parts = Vec::new();
        for block in blocks {
            let block_type = block["type"].as_str().unwrap_or("");
            if block_type == "text" {
                if let Some(t) = block["text"].as_str() {
                    text_parts.push(t.to_string());
                }
            }
        }

        if text_parts.is_empty() {
            return None;
        }

        return Some(ConversationMessage {
            role: "user".to_string(),
            content: text_parts.join("\n"),
            timestamp,
        });
    }

    None
}

fn parse_assistant_message(parsed: &serde_json::Value) -> Option<ConversationMessage> {
    let message = &parsed["message"];
    let content = &message["content"];
    let timestamp = parsed["timestamp"].as_str().map(String::from);

    let blocks = content.as_array()?;

    let mut parts = Vec::new();
    for block in blocks {
        let block_type = block["type"].as_str().unwrap_or("");
        match block_type {
            "text" => {
                if let Some(t) = block["text"].as_str() {
                    parts.push(t.to_string());
                }
            }
            "tool_use" => {
                if let Some(name) = block["name"].as_str() {
                    parts.push(format!("[Tool: {name}]"));
                }
            }
            _ => {}
        }
    }

    if parts.is_empty() {
        return None;
    }

    Some(ConversationMessage {
        role: "assistant".to_string(),
        content: parts.join("\n"),
        timestamp,
    })
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Truncate a string to at most `max_chars` characters, appending "..." if truncated.
/// Safe for multi-byte UTF-8 content (operates on char boundaries, not bytes).
fn truncate_preview(s: &str, max_chars: usize) -> String {
    let char_count = s.chars().count();
    if char_count <= max_chars {
        return s.to_string();
    }
    let end: String = s.chars().take(max_chars).collect();
    format!("{end}...")
}

/// List all conversations for a project, sorted newest first.
pub fn list_conversations(project: &str) -> anyhow::Result<Vec<ConversationSummary>> {
    list_conversations_impl(&base_dir()?, project)
}

fn list_conversations_impl(base: &Path, project: &str) -> anyhow::Result<Vec<ConversationSummary>> {
    let dir = sessions_dir_impl(base, project)?;
    if !dir.is_dir() {
        return Ok(Vec::new());
    }

    let mut summaries = Vec::new();

    let entries =
        fs::read_dir(&dir).map_err(|e| anyhow::anyhow!("cannot read sessions dir: {e}"))?;
    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                log::debug!("skipping unreadable dir entry: {e}");
                continue;
            }
        };
        let path = entry.path();

        // Only process .jsonl files
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }

        // Extract session_id from filename (strip .jsonl)
        let session_id = match path.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };

        // Validate it's a UUID — skip non-UUID filenames.
        // This also prevents reading .credentials.json (not a valid UUID).
        if validate_session_id_impl(&session_id).is_err() {
            continue;
        }

        // Read first ~50 lines to get timestamp and preview without loading
        // entire multi-MB JSONL files. We also count messages in those lines
        // as an approximate count for display.
        let file = match fs::File::open(&path) {
            Ok(f) => f,
            Err(e) => {
                log::debug!("cannot read session file {}: {e}", path.display());
                continue;
            }
        };

        let reader = BufReader::new(file);
        let mut first_timestamp: Option<String> = None;
        let mut preview = String::new();
        let mut message_count: usize = 0;
        const MAX_SCAN_LINES: usize = 50;

        for line in reader.lines().take(MAX_SCAN_LINES) {
            let line = match line {
                Ok(l) => l,
                Err(_) => break,
            };
            if let Some(msg) = parse_jsonl_message(&line) {
                message_count += 1;
                if first_timestamp.is_none() {
                    first_timestamp = msg.timestamp.clone();
                }
                if preview.is_empty() && msg.role == "user" {
                    preview = truncate_preview(&msg.content, 200);
                }
            }
        }

        if message_count == 0 {
            continue;
        }

        summaries.push(ConversationSummary {
            session_id,
            timestamp: first_timestamp,
            preview,
            message_count,
        });
    }

    // Sort newest first (by timestamp descending, None last)
    summaries.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));

    Ok(summaries)
}

/// Get the full transcript for a specific session.
pub fn get_conversation(project: &str, session_id: &str) -> anyhow::Result<ConversationTranscript> {
    get_conversation_impl(&base_dir()?, project, session_id)
}

fn get_conversation_impl(
    base: &Path,
    project: &str,
    session_id: &str,
) -> anyhow::Result<ConversationTranscript> {
    validate_session_id_impl(session_id)?;

    let path = sessions_dir_impl(base, project)?.join(format!("{session_id}.jsonl"));
    let file = fs::File::open(&path)
        .map_err(|e| anyhow::anyhow!("cannot read session {session_id}: {e}"))?;

    const MAX_TRANSCRIPT_LINES: usize = 10_000;
    let reader = BufReader::new(file);
    let mut messages = Vec::new();
    for line in reader.lines().take(MAX_TRANSCRIPT_LINES) {
        let line = line.map_err(|e| anyhow::anyhow!("io error reading session: {e}"))?;
        if let Some(msg) = parse_jsonl_message(&line) {
            messages.push(msg);
        }
    }

    Ok(ConversationTranscript {
        session_id: session_id.to_string(),
        messages,
    })
}

/// Read the project memory file (MEMORY.md). Returns empty string if missing.
pub fn get_project_memory(project: &str) -> anyhow::Result<String> {
    get_project_memory_impl(&base_dir()?, project)
}

fn get_project_memory_impl(base: &Path, project: &str) -> anyhow::Result<String> {
    let path = sessions_dir_impl(base, project)?
        .join("memory")
        .join("MEMORY.md");
    match fs::read_to_string(&path) {
        Ok(content) => Ok(content),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(anyhow::anyhow!("cannot read project memory: {e}")),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    /// Create the sessions directory structure inside a tempdir.
    fn setup_sessions_dir(base: &Path, project: &str) -> PathBuf {
        let dir = sessions_dir_impl(base, project).unwrap();
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_session(dir: &Path, session_id: &str, lines: &[&str]) {
        let path = dir.join(format!("{session_id}.jsonl"));
        fs::write(&path, lines.join("\n")).unwrap();
    }

    // ── validate_session_id ────────────────────────────────────────

    #[test]
    fn validate_session_id_accepts_valid_uuid() {
        assert!(validate_session_id_impl("550e8400-e29b-41d4-a716-446655440000").is_ok());
    }

    #[test]
    fn validate_session_id_accepts_all_hex_digits() {
        assert!(validate_session_id_impl("abcdef01-2345-6789-abcd-ef0123456789").is_ok());
    }

    #[test]
    fn validate_session_id_rejects_uppercase() {
        assert!(validate_session_id_impl("550E8400-E29B-41D4-A716-446655440000").is_err());
    }

    #[test]
    fn validate_session_id_rejects_path_traversal() {
        assert!(validate_session_id_impl("../../../etc/passwd").is_err());
    }

    #[test]
    fn validate_session_id_rejects_empty() {
        assert!(validate_session_id_impl("").is_err());
    }

    #[test]
    fn validate_session_id_rejects_short_segment() {
        assert!(validate_session_id_impl("550e8400-e29b-41d4-a716-44665544000").is_err());
    }

    #[test]
    fn validate_session_id_rejects_non_hex() {
        assert!(validate_session_id_impl("550e8400-e29b-41d4-a716-44665544000g").is_err());
    }

    // ── Path resolution ────────────────────────────────────────────

    #[test]
    fn claude_dot_dir_has_correct_structure() {
        let base = PathBuf::from("/home/test");
        let result = claude_dot_dir_impl(&base, "acme").unwrap();
        assert_eq!(
            result,
            PathBuf::from("/home/test/.speedwave/claude-home/acme/.claude")
        );
    }

    #[test]
    fn sessions_dir_has_correct_structure() {
        let base = PathBuf::from("/home/test");
        let result = sessions_dir_impl(&base, "acme").unwrap();
        assert_eq!(
            result,
            PathBuf::from("/home/test/.speedwave/claude-home/acme/.claude/projects/-workspace")
        );
    }

    // ── JSONL parsing ──────────────────────────────────────────────

    #[test]
    fn parse_user_message_with_string_content() {
        let line = r#"{"type":"user","message":{"role":"user","content":"hello world"},"timestamp":"2025-01-01T00:00:00Z"}"#;
        let msg = parse_jsonl_message(line).unwrap();
        assert_eq!(msg.role, "user");
        assert_eq!(msg.content, "hello world");
        assert_eq!(msg.timestamp.as_deref(), Some("2025-01-01T00:00:00Z"));
    }

    #[test]
    fn parse_user_message_with_array_content() {
        let line = r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"array msg"}]},"timestamp":"2025-01-01T00:00:00Z"}"#;
        let msg = parse_jsonl_message(line).unwrap();
        assert_eq!(msg.role, "user");
        assert_eq!(msg.content, "array msg");
    }

    #[test]
    fn parse_user_message_tool_result_only_is_skipped() {
        let line = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"abc","content":"result"}]}}"#;
        assert!(parse_jsonl_message(line).is_none());
    }

    #[test]
    fn parse_assistant_message_with_text_and_tool_use() {
        let line = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I will read the file"},{"type":"tool_use","name":"Read"}]},"timestamp":"2025-01-01T00:01:00Z"}"#;
        let msg = parse_jsonl_message(line).unwrap();
        assert_eq!(msg.role, "assistant");
        assert_eq!(msg.content, "I will read the file\n[Tool: Read]");
    }

    #[test]
    fn parse_assistant_message_text_only() {
        let line = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}"#;
        let msg = parse_jsonl_message(line).unwrap();
        assert_eq!(msg.role, "assistant");
        assert_eq!(msg.content, "done");
    }

    #[test]
    fn parse_system_type_is_skipped() {
        let line = r#"{"type":"system","message":"init"}"#;
        assert!(parse_jsonl_message(line).is_none());
    }

    #[test]
    fn parse_file_history_snapshot_is_skipped() {
        let line = r#"{"type":"file-history-snapshot","files":{}}"#;
        assert!(parse_jsonl_message(line).is_none());
    }

    #[test]
    fn parse_progress_type_is_skipped() {
        let line = r#"{"type":"progress","percent":50}"#;
        assert!(parse_jsonl_message(line).is_none());
    }

    #[test]
    fn parse_malformed_json_is_skipped() {
        assert!(parse_jsonl_message("not json {").is_none());
    }

    #[test]
    fn parse_empty_user_content_is_skipped() {
        let line = r#"{"type":"user","message":{"role":"user","content":""}}"#;
        assert!(parse_jsonl_message(line).is_none());
    }

    // ── list_conversations ─────────────────────────────────────────

    #[test]
    fn list_conversations_returns_empty_for_missing_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let result = list_conversations_impl(tmp.path(), "noproject").unwrap();
        assert!(result.is_empty());
    }

    #[test]
    fn list_conversations_finds_sessions_sorted_newest_first() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "acme");

        let id_old = "00000000-0000-0000-0000-000000000001";
        let id_new = "00000000-0000-0000-0000-000000000002";

        write_session(
            &dir,
            id_old,
            &[
                r#"{"type":"user","message":{"role":"user","content":"old msg"},"timestamp":"2025-01-01T00:00:00Z"}"#,
            ],
        );
        write_session(
            &dir,
            id_new,
            &[
                r#"{"type":"user","message":{"role":"user","content":"new msg"},"timestamp":"2025-06-15T00:00:00Z"}"#,
            ],
        );

        let result = list_conversations_impl(tmp.path(), "acme").unwrap();
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].session_id, id_new);
        assert_eq!(result[1].session_id, id_old);
    }

    #[test]
    fn list_conversations_extracts_preview_from_first_user_message() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "proj");
        let id = "abcdef01-2345-6789-abcd-ef0123456789";

        write_session(
            &dir,
            id,
            &[
                r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hello"}]},"timestamp":"2025-01-01T00:00:00Z"}"#,
                r#"{"type":"user","message":{"role":"user","content":"my question"},"timestamp":"2025-01-01T00:00:01Z"}"#,
            ],
        );

        let result = list_conversations_impl(tmp.path(), "proj").unwrap();
        assert_eq!(result[0].preview, "my question");
        assert_eq!(result[0].message_count, 2);
    }

    #[test]
    fn list_conversations_skips_non_uuid_files() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "proj");

        // Write a non-UUID file
        fs::write(
            dir.join("not-a-uuid.jsonl"),
            r#"{"type":"user","message":{"role":"user","content":"test"}}"#,
        )
        .unwrap();

        let result = list_conversations_impl(tmp.path(), "proj").unwrap();
        assert!(result.is_empty());
    }

    #[test]
    fn list_conversations_skips_empty_sessions() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "proj");
        let id = "abcdef01-2345-6789-abcd-ef0123456789";

        // A session with only system messages — no parseable user/assistant
        write_session(&dir, id, &[r#"{"type":"system","message":"init"}"#]);

        let result = list_conversations_impl(tmp.path(), "proj").unwrap();
        assert!(result.is_empty());
    }

    #[test]
    fn list_conversations_truncates_long_preview() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "proj");
        let id = "abcdef01-2345-6789-abcd-ef0123456789";

        let long_msg = "x".repeat(300);
        let line = format!(
            r#"{{"type":"user","message":{{"role":"user","content":"{long_msg}"}},"timestamp":"2025-01-01T00:00:00Z"}}"#
        );
        write_session(&dir, id, &[&line]);

        let result = list_conversations_impl(tmp.path(), "proj").unwrap();
        assert_eq!(result[0].preview.len(), 203); // 200 + "..."
        assert!(result[0].preview.ends_with("..."));
    }

    #[test]
    fn truncate_preview_is_utf8_safe() {
        // 200 emoji (each 4 bytes) should not panic
        let emoji_msg = "\u{1F600}".repeat(300);
        let result = truncate_preview(&emoji_msg, 200);
        assert_eq!(result.chars().count(), 203); // 200 emoji + 3 dots
        assert!(result.ends_with("..."));
    }

    #[test]
    fn truncate_preview_short_string_unchanged() {
        assert_eq!(truncate_preview("hello", 200), "hello");
    }

    // ── get_conversation ───────────────────────────────────────────

    #[test]
    fn get_conversation_returns_full_transcript() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "proj");
        let id = "abcdef01-2345-6789-abcd-ef0123456789";

        write_session(
            &dir,
            id,
            &[
                r#"{"type":"user","message":{"role":"user","content":"question"},"timestamp":"2025-01-01T00:00:00Z"}"#,
                r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"answer"}]},"timestamp":"2025-01-01T00:00:01Z"}"#,
            ],
        );

        let result = get_conversation_impl(tmp.path(), "proj", id).unwrap();
        assert_eq!(result.session_id, id);
        assert_eq!(result.messages.len(), 2);
        assert_eq!(result.messages[0].role, "user");
        assert_eq!(result.messages[0].content, "question");
        assert_eq!(result.messages[1].role, "assistant");
        assert_eq!(result.messages[1].content, "answer");
    }

    #[test]
    fn get_conversation_rejects_invalid_session_id() {
        let tmp = tempfile::tempdir().unwrap();
        setup_sessions_dir(tmp.path(), "proj");

        let result = get_conversation_impl(tmp.path(), "proj", "../escape");
        assert!(result.is_err());
    }

    #[test]
    fn get_conversation_returns_error_for_missing_file() {
        let tmp = tempfile::tempdir().unwrap();
        setup_sessions_dir(tmp.path(), "proj");

        let result =
            get_conversation_impl(tmp.path(), "proj", "abcdef01-2345-6789-abcd-ef0123456789");
        assert!(result.is_err());
    }

    #[test]
    fn get_conversation_skips_system_and_progress_lines() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "proj");
        let id = "abcdef01-2345-6789-abcd-ef0123456789";

        write_session(
            &dir,
            id,
            &[
                r#"{"type":"system","message":"init"}"#,
                r#"{"type":"progress","percent":50}"#,
                r#"{"type":"user","message":{"role":"user","content":"real msg"}}"#,
            ],
        );

        let result = get_conversation_impl(tmp.path(), "proj", id).unwrap();
        assert_eq!(result.messages.len(), 1);
        assert_eq!(result.messages[0].content, "real msg");
    }

    // ── get_project_memory ─────────────────────────────────────────

    #[test]
    fn get_project_memory_reads_memory_file() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "proj");

        let memory_dir = dir.join("memory");
        fs::create_dir_all(&memory_dir).unwrap();
        fs::write(memory_dir.join("MEMORY.md"), "# My Memory\nHello").unwrap();

        let result = get_project_memory_impl(tmp.path(), "proj").unwrap();
        assert_eq!(result, "# My Memory\nHello");
    }

    #[test]
    fn get_project_memory_returns_empty_when_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let result = get_project_memory_impl(tmp.path(), "proj").unwrap();
        assert_eq!(result, "");
    }

    // ── Edge cases ─────────────────────────────────────────────────

    #[test]
    fn list_conversations_ignores_non_jsonl_files() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "proj");

        // Write a .json file (not .jsonl)
        fs::write(dir.join("abcdef01-2345-6789-abcd-ef0123456789.json"), "{}").unwrap();

        let result = list_conversations_impl(tmp.path(), "proj").unwrap();
        assert!(result.is_empty());
    }

    #[test]
    fn parse_user_message_with_mixed_text_and_tool_result() {
        let line = r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"here is my input"},{"type":"tool_result","tool_use_id":"abc","content":"ok"}]}}"#;
        let msg = parse_jsonl_message(line).unwrap();
        assert_eq!(msg.role, "user");
        assert_eq!(msg.content, "here is my input");
    }

    #[test]
    fn parse_assistant_empty_content_array_is_skipped() {
        let line = r#"{"type":"assistant","message":{"role":"assistant","content":[]}}"#;
        assert!(parse_jsonl_message(line).is_none());
    }
}
