/// Chat history — reads Claude Code JSONL session files and project memory.
/// Public fns delegate to `_impl(data_dir: &Path)` variants that tests call directly.
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use speedwave_runtime::consts;

// ── Types ───────────────────────────────────────────────────────────────────────────────

/// Summary of a single conversation (session file).
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ConversationSummary {
    pub session_id: String,
    pub timestamp: Option<String>,
    pub preview: String,
    pub message_count: usize,
}

/// Rich block types for detailed message rendering.
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(tag = "type")]
pub enum MessageBlock {
    /// Text content.
    #[serde(rename = "text")]
    Text { content: String },
    /// Thinking / extended thinking content.
    #[serde(rename = "thinking")]
    Thinking { content: String },
    /// Tool invocation with input JSON.
    #[serde(rename = "tool_use")]
    ToolUse {
        tool_name: String,
        input_json: String,
    },
    /// Tool execution result.
    #[serde(rename = "tool_result")]
    ToolResult { content: String, is_error: bool },
    /// Error content.
    #[serde(rename = "error")]
    Error { content: String },
}

/// A single message extracted from a JSONL session.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ConversationMessage {
    pub role: String,
    pub content: String,
    /// Rich blocks for detailed rendering (optional — backward-compatible).
    /// When `Some`, frontend uses block-based rendering; when `None`, falls back to `content`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocks: Option<Vec<MessageBlock>>,
    pub timestamp: Option<String>,
    /// Stable JSONL UUID; anchors the retry-last-turn rewind point (ADR-046).
    /// `None` when the line lacks a `uuid` field.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uuid: Option<String>,
    /// Per-message model id (assistant turns only); restores the resumed footer.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Per-message token usage (assistant turns only). Reuses the chat SSOT.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<crate::chat::TurnUsage>,
}

/// Full transcript of a conversation.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ConversationTranscript {
    pub session_id: String,
    pub messages: Vec<ConversationMessage>,
}

// ── Path helpers ────────────────────────────────────────────────────────────────────────

fn claude_dot_dir_impl(data_dir: &Path, project: &str) -> PathBuf {
    data_dir
        .join(speedwave_runtime::consts::CLAUDE_HOME_SUBDIR)
        .join(project)
        .join(".claude")
}

fn sessions_dir_impl(data_dir: &Path, project: &str) -> PathBuf {
    let projects_dir = claude_dot_dir_impl(data_dir, project).join("projects");
    resolve_workspace_dir(&projects_dir)
}

/// Resolves the workspace subdirectory inside `.claude/projects/`.
/// `/workspace` → `-workspace`; falls back to newest-by-mtime auto-discovery.
fn resolve_workspace_dir(projects_dir: &Path) -> PathBuf {
    let default = projects_dir.join("-workspace");
    if default.is_dir() {
        return default;
    }
    if projects_dir.is_dir() {
        if let Ok(entries) = fs::read_dir(projects_dir) {
            let mut candidates: Vec<PathBuf> = entries
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| p.is_dir())
                .collect();
            if candidates.len() == 1 {
                log::info!(
                    "workspace dir fallback: using '{}' (only subdir in '{}')",
                    candidates[0].display(),
                    projects_dir.display()
                );
                return candidates.remove(0);
            }
            if candidates.len() > 1 {
                // Sort by mtime (newest first), alphabetical as tiebreak.
                candidates.sort_by(|a, b| {
                    let ma = a.metadata().and_then(|m| m.modified()).ok();
                    let mb = b.metadata().and_then(|m| m.modified()).ok();
                    mb.cmp(&ma).then_with(|| a.cmp(b))
                });
                log::warn!(
                    "multiple project dirs in '{}', using newest: '{}'",
                    projects_dir.display(),
                    candidates[0].display()
                );
                return candidates.remove(0);
            }
        }
    }
    default
}

// ── Validation ──────────────────────────────────────────────────────────────────────────

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

// ── JSONL parsing helpers ───────────────────────────────────────────────────────────────

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

    // Skip synthetic `type:"user"` meta-entries via `isMeta` (top-level or nested) or content sniffing.
    if msg_type == "user" {
        let reason = if parsed["isMeta"].as_bool().unwrap_or(false) {
            Some("isMeta")
        } else if parsed["message"]["isMeta"].as_bool().unwrap_or(false) {
            Some("message.isMeta")
        } else if is_synthetic_user_entry(&parsed) {
            Some("synthetic-content")
        } else {
            None
        };
        if let Some(reason) = reason {
            log::debug!(
                "skipping synthetic user JSONL entry reason={reason} uuid={}",
                parsed["uuid"].as_str().unwrap_or("?")
            );
            return None;
        }
    }

    match msg_type {
        "user" => parse_user_message(&parsed),
        "assistant" => parse_assistant_message(&parsed),
        "result" => parse_result_message(&parsed),
        _ => {
            // file-history-snapshot, system, progress, unknown — skip
            None
        }
    }
}

/// Bytes of the file tail read by [`last_message_timestamp`]. Sized to comfortably
/// hold the last several JSONL lines (incl. trailing `last-prompt`/`ai-title`).
const TAIL_READ_BYTES: u64 = 64 * 1024;

/// Timestamp of the last JSONL line carrying one — the session's last activity.
/// Scans only the final [`TAIL_READ_BYTES`] backwards; `None` if none present.
fn last_message_timestamp(path: &Path) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let start = len.saturating_sub(TAIL_READ_BYTES);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf).ok()?;
    let tail = String::from_utf8_lossy(&buf);
    // When we started mid-file the first line may be partial — drop it. `skip`
    // (not slicing) stays panic-free even if the tail read returned no lines.
    let lines: Vec<&str> = tail.lines().collect();
    let scan_from = if start > 0 { 1 } else { 0 };
    for line in lines.iter().skip(scan_from).rev() {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
            if let Some(ts) = v["timestamp"].as_str() {
                return Some(ts.to_string());
            }
        }
    }
    None
}

/// Detects synthetic `type:"user"` entries with no `isMeta` flag by sniffing content.
/// Caller must ensure `parsed["type"] == "user"`.
fn is_synthetic_user_entry(parsed: &serde_json::Value) -> bool {
    let content = &parsed["message"]["content"];
    if let Some(s) = content.as_str() {
        text_is_synthetic(s)
    } else if let Some(arr) = content.as_array() {
        // Check each text block so a synthetic tag in any block is caught.
        arr.iter()
            .filter(|b| b["type"].as_str() == Some("text"))
            .filter_map(|b| b["text"].as_str())
            .any(text_is_synthetic)
    } else {
        false
    }
}

fn text_is_synthetic(s: &str) -> bool {
    let trimmed = s.trim();
    trimmed.starts_with("<command-name>")
        || trimmed.starts_with("<command-message>")
        || trimmed.starts_with("<command-args>")
        || trimmed.starts_with("<command-result>")
        || trimmed.starts_with("<local-command-stdout>")
        || trimmed.starts_with("<local-command-stderr>")
        || trimmed.starts_with("Commands are in the form `/command [args]`")
}

fn parse_user_message(parsed: &serde_json::Value) -> Option<ConversationMessage> {
    let message = &parsed["message"];
    let content = &message["content"];
    let timestamp = parsed["timestamp"].as_str().map(String::from);
    let uuid = parsed["uuid"].as_str().map(String::from);

    // content can be a plain string
    if let Some(text) = content.as_str() {
        if text.is_empty() {
            return None;
        }
        return Some(ConversationMessage {
            role: "user".to_string(),
            content: text.to_string(),
            blocks: Some(vec![MessageBlock::Text {
                content: text.to_string(),
            }]),
            timestamp,
            uuid,
            model: None,
            usage: None,
        });
    }

    // content can be an array of blocks
    if let Some(raw_blocks) = content.as_array() {
        // Skip messages where content is only tool_result blocks
        let has_non_tool_result = raw_blocks
            .iter()
            .any(|b| b["type"].as_str().unwrap_or("") != "tool_result");
        if !has_non_tool_result {
            return None;
        }

        let mut text_parts = Vec::new();
        let mut rich_blocks = Vec::new();
        for block in raw_blocks {
            let block_type = block["type"].as_str().unwrap_or("");
            if block_type == "text" {
                if let Some(t) = block["text"].as_str() {
                    text_parts.push(t.to_string());
                    rich_blocks.push(MessageBlock::Text {
                        content: t.to_string(),
                    });
                }
            }
        }

        if text_parts.is_empty() {
            return None;
        }

        return Some(ConversationMessage {
            role: "user".to_string(),
            content: text_parts.join("\n"),
            blocks: Some(rich_blocks),
            timestamp,
            uuid,
            model: None,
            usage: None,
        });
    }

    None
}

fn parse_assistant_message(parsed: &serde_json::Value) -> Option<ConversationMessage> {
    let message = &parsed["message"];
    let content = &message["content"];
    let timestamp = parsed["timestamp"].as_str().map(String::from);
    let uuid = parsed["uuid"].as_str().map(String::from);

    let raw_blocks = content.as_array()?;

    let mut parts = Vec::new();
    let mut rich_blocks = Vec::new();
    for block in raw_blocks {
        let block_type = block["type"].as_str().unwrap_or("");
        match block_type {
            "text" => {
                if let Some(t) = block["text"].as_str() {
                    parts.push(t.to_string());
                    rich_blocks.push(MessageBlock::Text {
                        content: t.to_string(),
                    });
                }
            }
            "thinking" => {
                if let Some(t) = block["thinking"].as_str() {
                    rich_blocks.push(MessageBlock::Thinking {
                        content: t.to_string(),
                    });
                }
            }
            "tool_use" => {
                if let Some(name) = block["name"].as_str() {
                    parts.push(format!("[Tool: {name}]"));
                    let input = block["input"].to_string();
                    rich_blocks.push(MessageBlock::ToolUse {
                        tool_name: name.to_string(),
                        input_json: input,
                    });
                }
            }
            _ => {}
        }
    }

    if parts.is_empty() && rich_blocks.is_empty() {
        return None;
    }

    // Flat content fallback (for sidebar preview and legacy rendering)
    let flat_content = if parts.is_empty() {
        // Thinking-only messages — provide a placeholder
        "[thinking]".to_string()
    } else {
        parts.join("\n")
    };

    let model = message["model"].as_str().map(String::from);
    // JSONL field names differ from TurnUsage; chat SSOT remaps on parse. Sidechain (subagent)
    // calls have their own context — never attach their usage or resume seed reads a foreign size.
    let usage = if crate::chat::is_sidechain_event(parsed) {
        None
    } else {
        message
            .get("usage")
            .and_then(crate::chat::turn_usage_from_jsonl)
    };

    Some(ConversationMessage {
        role: "assistant".to_string(),
        content: flat_content,
        blocks: Some(rich_blocks),
        timestamp,
        uuid,
        model,
        usage,
    })
}

fn parse_result_message(parsed: &serde_json::Value) -> Option<ConversationMessage> {
    let is_error = parsed["is_error"].as_bool().unwrap_or(false);
    let result_text = parsed["result"].as_str().unwrap_or("");

    if result_text.trim().is_empty() {
        return None;
    }

    let timestamp = parsed["timestamp"].as_str().map(String::from);
    // Result lines carry no stable per-turn uuid; leave `None`.
    let uuid = None;

    if is_error {
        return Some(ConversationMessage {
            role: "assistant".to_string(),
            content: result_text.to_string(),
            blocks: Some(vec![MessageBlock::Error {
                content: result_text.to_string(),
            }]),
            timestamp,
            uuid: uuid.clone(),
            model: None,
            usage: None,
        });
    }

    Some(ConversationMessage {
        role: "assistant".to_string(),
        content: result_text.to_string(),
        blocks: Some(vec![MessageBlock::Text {
            content: result_text.to_string(),
        }]),
        timestamp,
        uuid,
        model: None,
        usage: None,
    })
}

// ── Public API ──────────────────────────────────────────────────────────────────────────

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
    list_conversations_impl(consts::data_dir(), project)
}

fn list_conversations_impl(
    data_dir: &Path,
    project: &str,
) -> anyhow::Result<Vec<ConversationSummary>> {
    let dir = sessions_dir_impl(data_dir, project);
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

        // Scan first ~50 lines for timestamp, preview, and approximate count.
        let file = match fs::File::open(&path) {
            Ok(f) => f,
            Err(e) => {
                log::debug!("cannot read session file {}: {e}", path.display());
                continue;
            }
        };

        let reader = BufReader::new(file);
        let mut last_timestamp: Option<String> = None;
        let mut preview = String::new();
        let mut message_count: usize = 0;
        let mut user_message_count: usize = 0;
        let mut last_assistant_content: Option<String> = None;
        const MAX_SCAN_LINES: usize = 50;
        // Whether the head scan saw the whole file — gates the junk-slash drop
        // below (a real 2nd user message past the cap must keep the session).
        let mut scanned_lines: usize = 0;

        for line in reader.lines().take(MAX_SCAN_LINES) {
            let line = match line {
                Ok(l) => l,
                Err(_) => break,
            };
            scanned_lines += 1;
            if let Some(msg) = parse_jsonl_message(&line) {
                // Deduplicate: skip result whose content is a substring of the preceding assistant message.
                if msg.role == "assistant" {
                    if let Some(ref prev) = last_assistant_content {
                        if prev.contains(&msg.content) {
                            continue;
                        }
                    }
                    last_assistant_content = Some(msg.content.clone());
                } else {
                    last_assistant_content = None;
                }
                message_count += 1;
                if msg.role == "user" {
                    user_message_count += 1;
                }
                // Head-scan timestamp is only a fallback for when the tail read
                // below finds none; the tail is the authoritative last activity.
                if msg.timestamp.is_some() {
                    last_timestamp = msg.timestamp.clone();
                }
                if preview.is_empty() && msg.role == "user" {
                    preview = truncate_preview(&msg.content, 200);
                }
            }
        }

        // The head scan saw the whole file iff it stopped before its cap; then
        // `last_timestamp`/`user_message_count` are authoritative.
        let head_saw_whole_file = scanned_lines < MAX_SCAN_LINES;

        // Re-read the tail only when the head was truncated; tail wins when
        // present (a fully-scanned short file already has the last activity).
        if !head_saw_whole_file {
            if let Some(ts) = last_message_timestamp(&path) {
                last_timestamp = Some(ts);
            }
        }

        if message_count == 0 {
            continue;
        }

        // Drop junk sessions whose sole user message is a lone `/`, only when the
        // head saw the whole file. Real `/code-review` and 2nd messages survive.
        if head_saw_whole_file
            && user_message_count == 1
            && speedwave_runtime::slash::is_bare_slash(&preview)
        {
            continue;
        }

        summaries.push(ConversationSummary {
            session_id,
            timestamp: last_timestamp,
            preview,
            message_count,
        });
    }

    // Sort by last activity, newest first (None last).
    summaries.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));

    if dir.is_dir() && summaries.is_empty() {
        log::debug!(
            "sessions dir '{}' exists but contains no sessions",
            dir.display()
        );
    }

    Ok(summaries)
}

/// Get the full transcript for a specific session.
pub fn get_conversation(project: &str, session_id: &str) -> anyhow::Result<ConversationTranscript> {
    get_conversation_impl(consts::data_dir(), project, session_id)
}

fn get_conversation_impl(
    data_dir: &Path,
    project: &str,
    session_id: &str,
) -> anyhow::Result<ConversationTranscript> {
    validate_session_id_impl(session_id)?;

    let path = sessions_dir_impl(data_dir, project).join(format!("{session_id}.jsonl"));
    let file = fs::File::open(&path)
        .map_err(|e| anyhow::anyhow!("cannot read session {session_id}: {e}"))?;

    const MAX_TRANSCRIPT_LINES: usize = 10_000;
    let reader = BufReader::new(file);
    let mut messages = Vec::new();
    let mut last_assistant_content: Option<String> = None;
    for line in reader.lines().take(MAX_TRANSCRIPT_LINES) {
        let line = line.map_err(|e| anyhow::anyhow!("io error reading session: {e}"))?;
        if let Some(msg) = parse_jsonl_message(&line) {
            // Deduplicate: skip result whose content is a substring of the preceding assistant message.
            if msg.role == "assistant" {
                if let Some(ref prev) = last_assistant_content {
                    if prev.contains(&msg.content) {
                        continue;
                    }
                }
                last_assistant_content = Some(msg.content.clone());
            } else {
                last_assistant_content = None;
            }
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
    get_project_memory_impl(consts::data_dir(), project)
}

fn get_project_memory_impl(data_dir: &Path, project: &str) -> anyhow::Result<String> {
    let path = sessions_dir_impl(data_dir, project)
        .join("memory")
        .join("MEMORY.md");
    match fs::read_to_string(&path) {
        Ok(content) => Ok(content),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(anyhow::anyhow!("cannot read project memory: {e}")),
    }
}

/// Delete a conversation's JSONL file. Idempotent: a missing file is treated
/// as success so a double-click on the trash icon doesn't surface an error.
pub fn delete_conversation(project: &str, session_id: &str) -> anyhow::Result<()> {
    delete_conversation_impl(consts::data_dir(), project, session_id)
}

fn delete_conversation_impl(
    data_dir: &Path,
    project: &str,
    session_id: &str,
) -> anyhow::Result<()> {
    validate_session_id_impl(session_id)?;
    let path = sessions_dir_impl(data_dir, project).join(format!("{session_id}.jsonl"));
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(anyhow::anyhow!("cannot delete session {session_id}: {e}")),
    }
}

// ── Resume snapshot ─────────────────────────────────────────────────────────────────────

/// Cumulative session state recovered from a transcript. Seeds the
/// `StreamParser` on resume so the first new turn reports a real delta.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ResumeSnapshot {
    /// Cumulative input tokens across the session.
    pub input_tokens: u64,
    /// Cumulative output tokens across the session.
    pub output_tokens: u64,
    /// Cumulative cache-read tokens.
    pub cache_read_tokens: u64,
    /// Cumulative cache-write (creation) tokens.
    pub cache_write_tokens: u64,
    /// Cumulative cost in USD reported by the CLI in the most recent
    /// `result` line (`total_cost_usd`, falling back to `total_cost`).
    pub total_cost: Option<f64>,
    /// Most recently observed model. Pulled from the latest `result`'s
    /// `modelUsage` keys; falls back to the last `system init` model.
    pub model: Option<String>,
    /// Usage of the last main-chain assistant line (`message.usage`) —
    /// context-window occupancy at the point the session was left off.
    pub context_usage: Option<crate::chat::TurnUsage>,
}

/// Compute the cumulative session snapshot from a JSONL transcript: prefers the
/// latest `modelUsage`, falls back to summed flat `usage` / last `system init`.
pub fn compute_resume_snapshot(project: &str, session_id: &str) -> anyhow::Result<ResumeSnapshot> {
    compute_resume_snapshot_impl(consts::data_dir(), project, session_id)
}

fn compute_resume_snapshot_impl(
    data_dir: &Path,
    project: &str,
    session_id: &str,
) -> anyhow::Result<ResumeSnapshot> {
    validate_session_id_impl(session_id)?;

    let path = sessions_dir_impl(data_dir, project).join(format!("{session_id}.jsonl"));
    let file = fs::File::open(&path)
        .map_err(|e| anyhow::anyhow!("cannot read session {session_id}: {e}"))?;

    const MAX_TRANSCRIPT_LINES: usize = 10_000;
    let reader = BufReader::new(file);

    // Running sum of flat `usage` blocks; fallback when no `modelUsage`.
    let mut summed = ResumeSnapshot::default();
    // Cumulative snapshot from the most recent `result` carrying `modelUsage`.
    let mut latest_cumulative: Option<ResumeSnapshot> = None;
    let mut latest_cost: Option<f64> = None;
    let mut latest_modelusage_model: Option<String> = None;
    let mut latest_init_model: Option<String> = None;
    let mut last_context_usage: Option<crate::chat::TurnUsage> = None;

    for line in reader.lines().take(MAX_TRANSCRIPT_LINES) {
        let line = line.map_err(|e| anyhow::anyhow!("io error reading session: {e}"))?;
        let parsed: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        match parsed["type"].as_str().unwrap_or("") {
            "result" => {
                if let Some(cost) = parsed["total_cost_usd"]
                    .as_f64()
                    .or_else(|| parsed["total_cost"].as_f64())
                {
                    latest_cost = Some(cost);
                }
                if let Some(usage) = parsed.get("usage") {
                    // Summing keeps its legacy-name fallback; field names are
                    // the chat SSOT consts (cf. `turn_usage_from_jsonl`).
                    let read_u64 = |k: &str| usage.get(k).and_then(serde_json::Value::as_u64);
                    summed.input_tokens = summed
                        .input_tokens
                        .saturating_add(read_u64(crate::chat::USAGE_INPUT_TOKENS).unwrap_or(0));
                    summed.output_tokens = summed
                        .output_tokens
                        .saturating_add(read_u64(crate::chat::USAGE_OUTPUT_TOKENS).unwrap_or(0));
                    summed.cache_read_tokens = summed.cache_read_tokens.saturating_add(
                        read_u64(crate::chat::USAGE_CACHE_READ_TOKENS)
                            .or_else(|| read_u64(crate::chat::USAGE_CACHE_READ_TOKENS_LEGACY))
                            .unwrap_or(0),
                    );
                    summed.cache_write_tokens = summed.cache_write_tokens.saturating_add(
                        read_u64(crate::chat::USAGE_CACHE_WRITE_TOKENS)
                            .or_else(|| read_u64(crate::chat::USAGE_CACHE_WRITE_TOKENS_LEGACY))
                            .unwrap_or(0),
                    );
                }
                if let Some(model_usage) = parsed.get("modelUsage").and_then(|v| v.as_object()) {
                    if !model_usage.is_empty() {
                        let mut cumulative = ResumeSnapshot::default();
                        let mut any_field = false;
                        for stats in model_usage.values() {
                            for (key, target) in [
                                ("inputTokens", &mut cumulative.input_tokens),
                                ("outputTokens", &mut cumulative.output_tokens),
                                ("cacheReadInputTokens", &mut cumulative.cache_read_tokens),
                                (
                                    "cacheCreationInputTokens",
                                    &mut cumulative.cache_write_tokens,
                                ),
                            ] {
                                if let Some(n) = stats.get(key).and_then(serde_json::Value::as_u64)
                                {
                                    *target = target.saturating_add(n);
                                    any_field = true;
                                }
                            }
                        }
                        if any_field {
                            latest_cumulative = Some(cumulative);
                        }
                        // Pick the model with the most output tokens (the main response model).
                        if let Some((top_model, _)) = model_usage.iter().max_by_key(|(_, stats)| {
                            stats
                                .get("outputTokens")
                                .and_then(serde_json::Value::as_u64)
                                .unwrap_or(0)
                        }) {
                            latest_modelusage_model = Some(top_model.clone());
                        }
                    }
                }
            }
            "system" => {
                if parsed["subtype"].as_str() == Some("init") {
                    if let Some(model) = parsed["model"].as_str() {
                        if !model.is_empty() {
                            latest_init_model = Some(model.to_string());
                        }
                    }
                }
            }
            "assistant" => {
                // Last main-chain call's usage = context occupancy; sidechain
                // (subagent) lines have their own context and are skipped.
                if !crate::chat::is_sidechain_event(&parsed) {
                    if let Some(u) = crate::chat::turn_usage_from_jsonl(&parsed["message"]["usage"])
                    {
                        if u != crate::chat::TurnUsage::default() {
                            last_context_usage = Some(u);
                        }
                    }
                }
            }
            _ => {}
        }
    }

    let mut snap = latest_cumulative.unwrap_or(summed);
    snap.total_cost = latest_cost;
    snap.model = latest_modelusage_model.or(latest_init_model);
    snap.context_usage = last_context_usage;
    Ok(snap)
}

// ── Tests ───────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
#[expect(clippy::unwrap_used, reason = "test code asserts via unwrap")]
mod tests {
    use super::*;

    /// Create the sessions directory structure inside a tempdir.
    /// `data_dir` acts as the data directory (like `~/.speedwave`).
    fn setup_sessions_dir(data_dir: &Path, project: &str) -> PathBuf {
        let dir = sessions_dir_impl(data_dir, project);
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
        let data_dir = PathBuf::from("/home/test/.speedwave");
        let result = claude_dot_dir_impl(&data_dir, "acme");
        assert_eq!(
            result,
            PathBuf::from("/home/test/.speedwave/claude-home/acme/.claude")
        );
    }

    #[test]
    fn sessions_dir_resolves_dash_workspace() {
        // When -workspace exists, sessions_dir_impl returns it directly
        let tmp = tempfile::tempdir().unwrap();
        let workspace = tmp
            .path()
            .join(speedwave_runtime::consts::CLAUDE_HOME_SUBDIR)
            .join("acme")
            .join(".claude")
            .join("projects")
            .join("-workspace");
        fs::create_dir_all(&workspace).unwrap();

        let result = sessions_dir_impl(tmp.path(), "acme");
        assert_eq!(result, workspace);
    }

    #[test]
    fn sessions_dir_works_with_data_dir_directly() {
        // Verify paths are built from data_dir without parent()+rejoin
        let data_dir = PathBuf::from("/opt/custom-speedwave");
        // sessions_dir_impl returns the expected path (dir may not exist on disk)
        let result = sessions_dir_impl(&data_dir, "proj");
        assert_eq!(
            result,
            PathBuf::from("/opt/custom-speedwave/claude-home/proj/.claude/projects/-workspace")
        );
    }

    // ── resolve_workspace_dir ─────────────────────────────────────

    #[test]
    fn resolve_workspace_dir_prefers_dash_workspace() {
        let tmp = tempfile::tempdir().unwrap();
        let projects = tmp.path().join("projects");
        fs::create_dir_all(projects.join("-workspace")).unwrap();
        fs::create_dir_all(projects.join("-other")).unwrap();

        let result = resolve_workspace_dir(&projects);
        assert_eq!(result, projects.join("-workspace"));
    }

    #[test]
    fn resolve_workspace_dir_finds_single_subdir() {
        let tmp = tempfile::tempdir().unwrap();
        let projects = tmp.path().join("projects");
        fs::create_dir_all(projects.join("-custom-workspace")).unwrap();

        let result = resolve_workspace_dir(&projects);
        assert_eq!(result, projects.join("-custom-workspace"));
    }

    #[test]
    fn resolve_workspace_dir_picks_deterministic_when_multiple() {
        let tmp = tempfile::tempdir().unwrap();
        let projects = tmp.path().join("projects");
        fs::create_dir_all(projects.join("-alpha")).unwrap();
        fs::create_dir_all(projects.join("-beta")).unwrap();

        // Run twice — result must be identical (deterministic)
        let result1 = resolve_workspace_dir(&projects);
        let result2 = resolve_workspace_dir(&projects);
        assert_eq!(result1, result2);
    }

    #[test]
    fn resolve_workspace_dir_returns_default_when_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let projects = tmp.path().join("projects");
        fs::create_dir_all(&projects).unwrap();

        let result = resolve_workspace_dir(&projects);
        assert_eq!(result, projects.join("-workspace"));
    }

    #[test]
    fn resolve_workspace_dir_returns_default_when_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let projects = tmp.path().join("nonexistent");

        let result = resolve_workspace_dir(&projects);
        assert_eq!(result, projects.join("-workspace"));
    }

    #[test]
    fn resolve_workspace_dir_skips_broken_symlinks() {
        let tmp = tempfile::tempdir().unwrap();
        let projects = tmp.path().join("projects");
        fs::create_dir_all(&projects).unwrap();

        // Create a broken symlink — is_dir() returns false for it
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("/nonexistent/target", projects.join("-broken")).unwrap();
            // Create one valid dir so we can verify the symlink is skipped
            fs::create_dir_all(projects.join("-valid")).unwrap();

            let result = resolve_workspace_dir(&projects);
            assert_eq!(result, projects.join("-valid"));
        }
    }

    #[cfg(unix)]
    #[test]
    fn resolve_workspace_dir_returns_default_on_read_dir_error() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().unwrap();
        let projects = tmp.path().join("projects");
        fs::create_dir_all(&projects).unwrap();

        // Remove read permission — fs::read_dir will fail
        fs::set_permissions(&projects, fs::Permissions::from_mode(0o000)).unwrap();

        let result = resolve_workspace_dir(&projects);
        assert_eq!(result, projects.join("-workspace"));

        // Restore permissions for cleanup
        fs::set_permissions(&projects, fs::Permissions::from_mode(0o755)).unwrap();
    }

    // ── Memory with auto-discovered dir ───────────────────────────

    #[test]
    fn get_project_memory_works_with_autodiscovered_dir() {
        let tmp = tempfile::tempdir().unwrap();
        // Create a non-standard workspace dir (not -workspace)
        let custom_ws = tmp
            .path()
            .join(speedwave_runtime::consts::CLAUDE_HOME_SUBDIR)
            .join("proj")
            .join(".claude")
            .join("projects")
            .join("-custom-workspace");
        let memory_dir = custom_ws.join("memory");
        fs::create_dir_all(&memory_dir).unwrap();
        fs::write(memory_dir.join("MEMORY.md"), "# Auto-discovered memory").unwrap();

        let result = get_project_memory_impl(tmp.path(), "proj").unwrap();
        assert_eq!(result, "# Auto-discovered memory");
    }

    // ── Diagnostic: empty auto-discovered dir ─────────────────────

    #[test]
    fn list_conversations_returns_empty_when_autodiscovered_dir_has_no_sessions() {
        let tmp = tempfile::tempdir().unwrap();
        // Create a non-standard workspace dir with no .jsonl files
        let custom_ws = tmp
            .path()
            .join(speedwave_runtime::consts::CLAUDE_HOME_SUBDIR)
            .join("proj")
            .join(".claude")
            .join("projects")
            .join("-renamed-workspace");
        fs::create_dir_all(&custom_ws).unwrap();

        let result = list_conversations_impl(tmp.path(), "proj").unwrap();
        assert!(result.is_empty());
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
    fn parse_user_message_extracts_uuid_from_jsonl() {
        let line = r#"{"type":"user","uuid":"11111111-2222-3333-4444-555555555555","message":{"role":"user","content":"hi"}}"#;
        let msg = parse_jsonl_message(line).unwrap();
        assert_eq!(
            msg.uuid.as_deref(),
            Some("11111111-2222-3333-4444-555555555555")
        );
    }

    #[test]
    fn parse_user_message_uuid_is_none_when_absent() {
        let line = r#"{"type":"user","message":{"role":"user","content":"hi"}}"#;
        let msg = parse_jsonl_message(line).unwrap();
        assert!(msg.uuid.is_none());
    }

    #[test]
    fn parse_assistant_message_extracts_uuid_from_jsonl() {
        let line = r#"{"type":"assistant","uuid":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]}}"#;
        let msg = parse_jsonl_message(line).unwrap();
        assert_eq!(
            msg.uuid.as_deref(),
            Some("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
        );
    }

    #[test]
    fn parse_user_message_array_content_propagates_uuid() {
        let line = r#"{"type":"user","uuid":"deadbeef-1111-2222-3333-444444444444","message":{"role":"user","content":[{"type":"text","text":"hello"}]}}"#;
        let msg = parse_jsonl_message(line).unwrap();
        assert_eq!(
            msg.uuid.as_deref(),
            Some("deadbeef-1111-2222-3333-444444444444")
        );
    }

    #[test]
    fn parse_result_message_uuid_is_always_none() {
        // Result lines must never expose a uuid.
        let line = r#"{"type":"result","is_error":false,"result":"summary"}"#;
        let msg = parse_jsonl_message(line).unwrap();
        assert!(msg.uuid.is_none());
    }

    #[test]
    fn parse_assistant_message_extracts_model_and_usage() {
        let line = r#"{"type":"assistant","message":{"role":"assistant","model":"claude-opus-4-8","content":[{"type":"text","text":"hi"}],"usage":{"input_tokens":12,"output_tokens":34,"cache_read_input_tokens":56,"cache_creation_input_tokens":78}}}"#;
        let msg = parse_jsonl_message(line).unwrap();
        assert_eq!(msg.model.as_deref(), Some("claude-opus-4-8"));
        let usage = msg.usage.expect("usage must be present");
        assert_eq!(usage.input_tokens, 12);
        assert_eq!(usage.output_tokens, 34);
        // cache_read_input_tokens → cache_read_tokens
        assert_eq!(usage.cache_read_tokens, 56);
        // cache_creation_input_tokens → cache_write_tokens
        assert_eq!(usage.cache_write_tokens, 78);
    }

    #[test]
    fn parse_assistant_message_sidechain_line_drops_usage() {
        // Subagent lines must not carry usage — the frontend resume seed
        // reads the last usage-bearing message as the context occupancy.
        let line = r#"{"type":"assistant","isSidechain":true,"message":{"role":"assistant","model":"claude-haiku-4-5-20251001","content":[{"type":"text","text":"subagent"}],"usage":{"input_tokens":9,"output_tokens":9,"cache_read_input_tokens":180000,"cache_creation_input_tokens":9}}}"#;
        let msg = parse_jsonl_message(line).unwrap();
        assert!(msg.usage.is_none());
        // Non-usage metadata is unaffected.
        assert_eq!(msg.model.as_deref(), Some("claude-haiku-4-5-20251001"));
    }

    #[test]
    fn parse_assistant_message_parent_tool_use_id_line_also_drops_usage() {
        // The on-disk transcript path shares `is_sidechain_event` with the live
        // stream-json path — `parent_tool_use_id` alone (no `isSidechain`) must
        // also drop usage, not just the transcript-native `isSidechain` marker.
        let line = r#"{"type":"assistant","parent_tool_use_id":"toolu_task_1","message":{"role":"assistant","model":"claude-haiku-4-5-20251001","content":[{"type":"text","text":"subagent"}],"usage":{"input_tokens":9,"output_tokens":9,"cache_read_input_tokens":180000,"cache_creation_input_tokens":9}}}"#;
        let msg = parse_jsonl_message(line).unwrap();
        assert!(msg.usage.is_none());
    }

    #[test]
    fn parse_assistant_message_usage_missing_fields_default_zero() {
        // A `usage` object with only partial fields zero-fills the rest.
        let line = r#"{"type":"assistant","message":{"role":"assistant","model":"haiku-4.5","content":[{"type":"text","text":"hi"}],"usage":{"input_tokens":5}}}"#;
        let msg = parse_jsonl_message(line).unwrap();
        let usage = msg.usage.expect("usage must be present");
        assert_eq!(usage.input_tokens, 5);
        assert_eq!(usage.output_tokens, 0);
        assert_eq!(usage.cache_read_tokens, 0);
        assert_eq!(usage.cache_write_tokens, 0);
    }

    #[test]
    fn parse_assistant_message_without_usage_leaves_none() {
        // No `usage` object — `usage` stays None (model still parsed when present).
        let line = r#"{"type":"assistant","message":{"role":"assistant","model":"claude-opus-4-8","content":[{"type":"text","text":"hi"}]}}"#;
        let msg = parse_jsonl_message(line).unwrap();
        assert_eq!(msg.model.as_deref(), Some("claude-opus-4-8"));
        assert!(msg.usage.is_none());
    }

    #[test]
    fn parse_assistant_message_null_usage_is_none() {
        // `usage: null` is not an object — None, not a zero-filled TurnUsage.
        let line = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi"}],"usage":null}}"#;
        let msg = parse_jsonl_message(line).unwrap();
        assert!(msg.usage.is_none());
    }

    #[test]
    fn parse_user_message_has_no_model_or_usage() {
        let line = r#"{"type":"user","message":{"role":"user","content":"hello"}}"#;
        let msg = parse_jsonl_message(line).unwrap();
        assert!(msg.model.is_none());
        assert!(msg.usage.is_none());
    }

    #[test]
    fn parse_result_message_has_no_model_or_usage() {
        let line = r#"{"type":"result","is_error":false,"result":"summary"}"#;
        let msg = parse_jsonl_message(line).unwrap();
        assert!(msg.model.is_none());
        assert!(msg.usage.is_none());
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
    fn list_conversations_sorts_by_last_activity_not_first_message() {
        // A chat STARTED earlier but REPLIED-TO later must sort above a chat
        // started later with no further activity — newest activity on top.
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "acme");

        let id_started_early = "00000000-0000-0000-0000-00000000000a";
        let id_started_late = "00000000-0000-0000-0000-00000000000b";

        write_session(
            &dir,
            id_started_early,
            &[
                r#"{"type":"user","message":{"role":"user","content":"begun monday"},"timestamp":"2025-01-01T00:00:00Z"}"#,
                r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]},"timestamp":"2025-01-01T00:00:01Z"}"#,
                r#"{"type":"user","message":{"role":"user","content":"replied friday"},"timestamp":"2025-01-05T12:00:00Z"}"#,
            ],
        );
        write_session(
            &dir,
            id_started_late,
            &[
                r#"{"type":"user","message":{"role":"user","content":"begun wednesday"},"timestamp":"2025-01-03T00:00:00Z"}"#,
            ],
        );

        let result = list_conversations_impl(tmp.path(), "acme").unwrap();
        assert_eq!(result.len(), 2);
        // id_started_early last activity (Jan 5) > id_started_late (Jan 3).
        assert_eq!(result[0].session_id, id_started_early);
        assert_eq!(result[1].session_id, id_started_late);
    }

    #[test]
    fn list_conversations_timestamp_skips_trailing_metadata_lines() {
        // Trailing `last-prompt`/`ai-title` lines carry no timestamp; the report
        // is the last real message before them, not None.
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "acme");
        let id = "00000000-0000-0000-0000-00000000000d";

        write_session(
            &dir,
            id,
            &[
                r#"{"type":"user","message":{"role":"user","content":"hi"},"timestamp":"2025-01-01T00:00:00Z"}"#,
                r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"yo"}]},"timestamp":"2025-02-02T02:02:02Z"}"#,
                r#"{"type":"last-prompt"}"#,
                r#"{"type":"ai-title","title":"chat"}"#,
            ],
        );

        let result = list_conversations_impl(tmp.path(), "acme").unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].timestamp.as_deref(), Some("2025-02-02T02:02:02Z"));
    }

    #[test]
    fn list_conversations_timestamp_is_last_activity() {
        // The reported timestamp is the latest message, not the first —
        // the sidebar renders it as "last activity".
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "acme");
        let id = "00000000-0000-0000-0000-00000000000c";

        write_session(
            &dir,
            id,
            &[
                r#"{"type":"user","message":{"role":"user","content":"start"},"timestamp":"2025-01-01T00:00:00Z"}"#,
                r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"reply"}]},"timestamp":"2025-01-09T09:09:09Z"}"#,
            ],
        );

        let result = list_conversations_impl(tmp.path(), "acme").unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].timestamp.as_deref(), Some("2025-01-09T09:09:09Z"));
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
    fn list_conversations_deduplicates_tool_use_turn_result() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "proj");
        let id = "abcdef01-2345-6789-abcd-ef0123456789";

        write_session(
            &dir,
            id,
            &[
                r#"{"type":"user","message":{"role":"user","content":"read it"},"timestamp":"2025-01-01T00:00:00Z"}"#,
                r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I will read"},{"type":"tool_use","name":"Read","input":{}}]},"timestamp":"2025-01-01T00:00:01Z"}"#,
                r#"{"type":"result","is_error":false,"result":"I will read","timestamp":"2025-01-01T00:00:02Z"}"#,
            ],
        );

        let result = list_conversations_impl(tmp.path(), "proj").unwrap();
        assert_eq!(result.len(), 1);
        // message_count should be 2 (user + assistant), not 3 (result deduplicated)
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
    fn list_conversations_skips_is_meta_for_preview() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "proj");
        let id = "abcdef01-2345-6789-abcd-ef0123456789";

        write_session(
            &dir,
            id,
            &[
                r#"{"type":"user","isMeta":true,"message":{"role":"user","content":"<local-command-caveat>Caveat: …</local-command-caveat>"},"timestamp":"2025-01-01T00:00:00Z"}"#,
                r#"{"type":"user","message":{"role":"user","content":"real question"},"timestamp":"2025-01-01T00:00:01Z"}"#,
                r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"reply"}]},"timestamp":"2025-01-01T00:00:02Z"}"#,
            ],
        );

        let result = list_conversations_impl(tmp.path(), "proj").unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].preview, "real question");
        assert_eq!(result[0].message_count, 2);
    }

    #[test]
    fn parse_jsonl_message_respects_nested_is_meta_under_message() {
        // `isMeta` nested under `message.*` must still be caught.
        let line = r#"{"type":"user","message":{"role":"user","isMeta":true,"content":"<local-command-caveat>x</local-command-caveat>"}}"#;
        assert!(parse_jsonl_message(line).is_none());
    }

    #[test]
    fn parse_jsonl_message_does_not_drop_is_meta_on_non_user_types() {
        // The `isMeta` filter is scoped to user entries; an assistant row with isMeta:true must still parse.
        let line = r#"{"type":"assistant","isMeta":true,"message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}"#;
        let msg = parse_jsonl_message(line).expect("assistant with isMeta should parse");
        assert_eq!(msg.role, "assistant");
        assert_eq!(msg.content, "hi");
    }

    #[test]
    fn list_conversations_drops_session_with_only_meta_entries() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "proj");
        let id = "abcdef01-2345-6789-abcd-ef0123456789";

        write_session(
            &dir,
            id,
            &[
                r#"{"type":"user","isMeta":true,"message":{"role":"user","content":"<local-command-caveat>Caveat: …</local-command-caveat>"},"timestamp":"2025-01-01T00:00:00Z"}"#,
                r#"{"type":"user","isMeta":true,"message":{"role":"user","content":"<command-name>/clear</command-name>"},"timestamp":"2025-01-01T00:00:01Z"}"#,
            ],
        );

        let result = list_conversations_impl(tmp.path(), "proj").unwrap();
        assert!(result.is_empty());
    }

    #[test]
    fn get_conversation_omits_is_meta_entries() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "proj");
        let id = "abcdef01-2345-6789-abcd-ef0123456789";

        write_session(
            &dir,
            id,
            &[
                r#"{"type":"user","isMeta":true,"message":{"role":"user","content":"<local-command-caveat>Caveat: …</local-command-caveat>"},"timestamp":"2025-01-01T00:00:00Z"}"#,
                r#"{"type":"user","message":{"role":"user","content":"real question"},"timestamp":"2025-01-01T00:00:01Z"}"#,
                r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"reply"}]},"timestamp":"2025-01-01T00:00:02Z"}"#,
            ],
        );

        let transcript = get_conversation_impl(tmp.path(), "proj", id).unwrap();
        assert_eq!(transcript.messages.len(), 2);
        assert_eq!(transcript.messages[0].role, "user");
        assert_eq!(transcript.messages[0].content, "real question");
        assert_eq!(transcript.messages[1].role, "assistant");
    }

    #[test]
    fn list_conversations_skips_slash_command_markers() {
        // Slash-command invocations carry no `isMeta` flag but are still synthetic.
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "proj");
        let id = "abcdef01-2345-6789-abcd-ef0123456789";

        write_session(
            &dir,
            id,
            &[
                r#"{"type":"user","message":{"role":"user","content":"<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>"},"timestamp":"2025-01-01T00:00:00Z"}"#,
                r#"{"type":"user","message":{"role":"user","content":"<local-command-stdout></local-command-stdout>"},"timestamp":"2025-01-01T00:00:01Z"}"#,
                r#"{"type":"user","message":{"role":"user","content":"real question"},"timestamp":"2025-01-01T00:00:02Z"}"#,
                r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"reply"}]},"timestamp":"2025-01-01T00:00:03Z"}"#,
            ],
        );

        let result = list_conversations_impl(tmp.path(), "proj").unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].preview, "real question");
        assert_eq!(result[0].message_count, 2);
    }

    #[test]
    fn list_conversations_drops_sdk_cli_boilerplate_session() {
        // A session whose only user entry is the `Commands are in the form …` boilerplate must not appear.
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "proj");
        let id = "abcdef01-2345-6789-abcd-ef0123456789";

        write_session(
            &dir,
            id,
            &[
                r#"{"type":"user","message":{"role":"user","content":"Commands are in the form `/command [args]`"},"timestamp":"2025-01-01T00:00:00Z"}"#,
            ],
        );

        let result = list_conversations_impl(tmp.path(), "proj").unwrap();
        assert!(result.is_empty());
    }

    #[test]
    fn list_conversations_drops_bare_slash_session() {
        // A junk session whose only content is a lone `/` (slash-menu trigger
        // sent as a message) must not pollute the history list.
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "proj");
        let id = "abcdef01-2345-6789-abcd-ef0123456789";

        write_session(
            &dir,
            id,
            &[
                r#"{"type":"user","message":{"role":"user","content":"/"},"timestamp":"2025-01-01T00:00:00Z"}"#,
            ],
        );

        let result = list_conversations_impl(tmp.path(), "proj").unwrap();
        assert!(result.is_empty());
    }

    #[test]
    fn list_conversations_drops_bare_slash_session_with_reply() {
        // The common junk shape: a lone `/` plus Claude's "you typed /" reply.
        // The user never sent anything real, so this must be dropped too.
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "proj");
        let id = "abcdef01-2345-6789-abcd-ef0123456789";

        write_session(
            &dir,
            id,
            &[
                r#"{"type":"user","message":{"role":"user","content":"/"},"timestamp":"2025-01-01T00:00:00Z"}"#,
                r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"You typed / with no command."}]},"timestamp":"2025-01-01T00:00:01Z"}"#,
            ],
        );

        let result = list_conversations_impl(tmp.path(), "proj").unwrap();
        assert!(result.is_empty());
    }

    #[test]
    fn list_conversations_keeps_slash_session_with_real_message_past_head_scan() {
        // Lone `/`, then >50 noise lines, then a real 2nd user message past the
        // head-scan cap: the session must NOT be dropped.
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "proj");
        let id = "abcdef01-2345-6789-abcd-ef0123456789";

        let mut lines: Vec<String> = Vec::new();
        lines.push(
            r#"{"type":"user","message":{"role":"user","content":"/"},"timestamp":"2025-01-01T00:00:00Z"}"#
                .to_string(),
        );
        // 60 noise lines (assistant text + system) — past the 50-line head cap.
        for i in 0..60 {
            lines.push(format!(
                r#"{{"type":"system","message":"step {i}","timestamp":"2025-01-01T00:00:01Z"}}"#
            ));
        }
        lines.push(
            r#"{"type":"user","message":{"role":"user","content":"the real question"},"timestamp":"2025-01-01T00:01:00Z"}"#
                .to_string(),
        );
        let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
        write_session(&dir, id, &refs);

        let result = list_conversations_impl(tmp.path(), "proj").unwrap();
        assert_eq!(
            result.len(),
            1,
            "a real message past the head-scan cap must keep the session"
        );
    }

    #[test]
    fn list_conversations_keeps_session_where_slash_is_followed_by_real_message() {
        // A lone `/` first, then a real second user message: `user_message_count`
        // is 2, so the junk filter must NOT drop it — preventing history loss.
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "proj");
        let id = "abcdef01-2345-6789-abcd-ef0123456789";

        write_session(
            &dir,
            id,
            &[
                r#"{"type":"user","message":{"role":"user","content":"/"},"timestamp":"2025-01-01T00:00:00Z"}"#,
                r#"{"type":"user","message":{"role":"user","content":"actually, summarize this repo"},"timestamp":"2025-01-01T00:00:05Z"}"#,
                r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Sure."}]},"timestamp":"2025-01-01T00:00:06Z"}"#,
            ],
        );

        let result = list_conversations_impl(tmp.path(), "proj").unwrap();
        assert_eq!(
            result.len(),
            1,
            "a 2nd real user message must keep the session"
        );
    }

    #[test]
    fn last_message_timestamp_skips_trailing_metadata_lines() {
        // Trailing `last-prompt`/`ai-title` lines carry no timestamp; the tail
        // scan walks past them to the last real message's timestamp.
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "proj");
        let id = "abcdef01-2345-6789-abcd-ef0123456789";
        write_session(
            &dir,
            id,
            &[
                r#"{"type":"user","message":{"role":"user","content":"hi"},"timestamp":"2025-03-03T03:03:03Z"}"#,
                r#"{"type":"last-prompt"}"#,
                r#"{"type":"ai-title","title":"chat"}"#,
            ],
        );
        let path = dir.join(format!("{id}.jsonl"));
        assert_eq!(
            last_message_timestamp(&path).as_deref(),
            Some("2025-03-03T03:03:03Z")
        );
    }

    #[test]
    fn last_message_timestamp_none_when_no_line_has_a_timestamp() {
        // No timestamp anywhere in the tail → None; the list path then keeps the
        // head-scanned value (the documented fallback).
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "proj");
        let id = "abcdef01-2345-6789-abcd-ef0123456789";
        let path = dir.join(format!("{id}.jsonl"));
        fs::write(&path, "{\"type\":\"last-prompt\"}\n{\"type\":\"ai-title\"}").unwrap();
        assert!(last_message_timestamp(&path).is_none());
    }

    #[test]
    fn last_message_timestamp_does_not_panic_on_single_huge_line() {
        // One JSONL line larger than TAIL_READ_BYTES: the 64 KiB tail is a single
        // partial fragment, `skip(1)` empties the scan — must return None, not panic.
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "proj");
        let id = "abcdef01-2345-6789-abcd-ef0123456789";
        let huge = format!(
            r#"{{"type":"user","message":{{"role":"user","content":"{}"}},"timestamp":"2025-01-01T00:00:00Z"}}"#,
            "x".repeat((TAIL_READ_BYTES as usize) + 1000)
        );
        let path = dir.join(format!("{id}.jsonl"));
        fs::write(&path, huge).unwrap();
        assert!(last_message_timestamp(&path).is_none());
    }

    #[test]
    fn last_message_timestamp_reads_final_line_without_trailing_newline() {
        // The last line has no trailing `\n`; `lines()` still yields it, so the
        // timestamp is found.
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "proj");
        let id = "abcdef01-2345-6789-abcd-ef0123456789";
        let path = dir.join(format!("{id}.jsonl"));
        fs::write(
            &path,
            "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"hi\"},\"timestamp\":\"2027-07-07T07:07:07Z\"}",
        )
        .unwrap();
        assert_eq!(
            last_message_timestamp(&path).as_deref(),
            Some("2027-07-07T07:07:07Z")
        );
    }

    #[test]
    fn last_message_timestamp_none_for_unreadable_or_empty() {
        let tmp = tempfile::tempdir().unwrap();
        // Missing file → None (no panic).
        assert!(last_message_timestamp(&tmp.path().join("nope.jsonl")).is_none());
        // Empty file → None.
        let empty = tmp.path().join("empty.jsonl");
        fs::write(&empty, "").unwrap();
        assert!(last_message_timestamp(&empty).is_none());
    }

    #[test]
    fn last_message_timestamp_reads_only_the_tail_of_a_large_file() {
        // A file larger than TAIL_READ_BYTES: the timestamp in the final line is
        // still found even though earlier lines are never read.
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "proj");
        let id = "abcdef01-2345-6789-abcd-ef0123456789";
        let filler = format!(
            r#"{{"type":"user","message":{{"role":"user","content":"{}"}},"timestamp":"2024-01-01T00:00:00Z"}}"#,
            "x".repeat(2000)
        );
        let mut lines: Vec<String> = (0..200).map(|_| filler.clone()).collect();
        lines.push(
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"done"}]},"timestamp":"2026-12-12T12:12:12Z"}"#
                .to_string(),
        );
        let path = dir.join(format!("{id}.jsonl"));
        fs::write(&path, lines.join("\n")).unwrap();
        assert!(path.metadata().unwrap().len() > TAIL_READ_BYTES);
        assert_eq!(
            last_message_timestamp(&path).as_deref(),
            Some("2026-12-12T12:12:12Z")
        );
    }

    #[test]
    fn list_conversations_keeps_real_slash_command_session() {
        // A real slash command (`/code-review`) with a reply is a genuine
        // conversation — it must NOT be dropped.
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "proj");
        let id = "abcdef01-2345-6789-abcd-ef0123456789";

        write_session(
            &dir,
            id,
            &[
                r#"{"type":"user","message":{"role":"user","content":"/code-review"},"timestamp":"2025-01-01T00:00:00Z"}"#,
                r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"reviewing"}]},"timestamp":"2025-01-01T00:00:01Z"}"#,
            ],
        );

        let result = list_conversations_impl(tmp.path(), "proj").unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].preview, "/code-review");
    }

    #[test]
    fn parse_jsonl_message_drops_command_args_and_command_result_prefixes() {
        // Sibling command tags must also be filtered, not only <command-name>.
        for tag in ["<command-args>", "<command-result>"] {
            let line = format!(
                r#"{{"type":"user","message":{{"role":"user","content":"{tag}foo</X>"}}}}"#
            );
            assert!(
                parse_jsonl_message(&line).is_none(),
                "expected {tag} to be filtered"
            );
        }
    }

    #[test]
    fn parse_jsonl_message_drops_boilerplate_with_trailing_punctuation() {
        // Boilerplate with trailing punctuation/context is still filtered.
        let line = r#"{"type":"user","message":{"role":"user","content":"Commands are in the form `/command [args]`\n\nMore context."}}"#;
        assert!(parse_jsonl_message(line).is_none());
    }

    #[test]
    fn parse_jsonl_message_drops_synthetic_tag_in_non_first_text_block() {
        // Synthetic marker in a non-first text block is caught per-block.
        let line = r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"preamble"},{"type":"text","text":"<command-name>/clear</command-name>"}]}}"#;
        assert!(parse_jsonl_message(line).is_none());
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

    /// INVARIANT: detokenization happens only on the copy returned to the webview;
    /// the source JSONL on disk stays tokenized and unchanged.
    #[test]
    fn get_conversation_detokenizes_returned_copy_but_leaves_source_file_tokenized() {
        use speedwave_pii_engine::{compile_policy_v3, default_policy_json, scan_text, EngineKey};

        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "proj");
        let id = "abcdef01-2345-6789-abcd-ef0123456789";

        speedwave_runtime::pii_key::ensure_project_key_in(tmp.path(), "proj").unwrap();
        let key_bytes =
            speedwave_runtime::pii_key::read_project_key_in(tmp.path(), "proj").unwrap();
        let key = EngineKey::from_bytes(key_bytes);
        let policy = compile_policy_v3(&default_policy_json()).unwrap();
        let tokenized = scan_text(&policy, &key, "contact jan@example.com")
            .unwrap()
            .text;
        assert!(
            tokenized.contains("TOKEN_"),
            "fixture must actually tokenize"
        );

        let line =
            format!(r#"{{"type":"user","message":{{"role":"user","content":"{tokenized}"}}}}"#);
        write_session(&dir, id, &[&line]);

        // history.rs's own read path: must yield the tokenized source, never a
        // detokenized value — this is also what resume/compute_resume_snapshot reads.
        let mut transcript = get_conversation_impl(tmp.path(), "proj", id).unwrap();
        assert!(
            transcript.messages[0].content.contains("TOKEN_"),
            "history.rs must read the tokenized source as-is"
        );

        // Detokenization happens only on this owned, in-memory copy.
        crate::pii_display::detokenize_transcript(
            &mut transcript,
            &crate::pii_display::DisplayPolicy::new(Some(key), Vec::new()),
        );
        assert_eq!(transcript.messages[0].content, "contact jan@example.com");

        // The source file on disk must remain byte-for-byte tokenized.
        let raw = fs::read_to_string(dir.join(format!("{id}.jsonl"))).unwrap();
        assert!(
            raw.contains("TOKEN_"),
            "source JSONL must never be rewritten with a detokenized value"
        );
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

    #[test]
    fn get_project_memory_propagates_non_not_found_io_error() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "proj");

        // A directory at the MEMORY.md path yields an I/O error that is NOT ErrorKind::NotFound.
        let memory_dir = dir.join("memory").join("MEMORY.md");
        fs::create_dir_all(&memory_dir).unwrap();

        let result = get_project_memory_impl(tmp.path(), "proj");
        assert!(
            result.is_err(),
            "non-NotFound I/O error should propagate as Err"
        );
        let err_msg = result.unwrap_err().to_string();
        assert!(
            err_msg.contains("cannot read project memory"),
            "error message should mention 'cannot read project memory', got: {err_msg}"
        );
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

    // ── Result message parsing (slash commands / history) ─────────

    #[test]
    fn parse_result_message_extracts_slash_command_output() {
        let line = r#"{"type":"result","is_error":false,"result":"Session cost: $0.003","timestamp":"2025-06-01T00:00:00Z"}"#;
        let msg = parse_jsonl_message(line).unwrap();
        assert_eq!(msg.role, "assistant");
        assert_eq!(msg.content, "Session cost: $0.003");
        let blocks = msg.blocks.unwrap();
        assert_eq!(blocks.len(), 1);
        match &blocks[0] {
            MessageBlock::Text { content } => assert_eq!(content, "Session cost: $0.003"),
            other => panic!("expected Text block, got {other:?}"),
        }
    }

    #[test]
    fn parse_result_message_renders_error_as_error_block() {
        let line = r#"{"type":"result","is_error":true,"result":"Command not found","timestamp":"2025-06-01T00:00:00Z"}"#;
        let msg = parse_jsonl_message(line).unwrap();
        assert_eq!(msg.role, "assistant");
        let blocks = msg.blocks.unwrap();
        assert_eq!(blocks.len(), 1);
        match &blocks[0] {
            MessageBlock::Error { content } => assert_eq!(content, "Command not found"),
            other => panic!("expected Error block, got {other:?}"),
        }
    }

    #[test]
    fn parse_result_message_skips_empty() {
        let line = r#"{"type":"result","is_error":false,"result":""}"#;
        assert!(parse_jsonl_message(line).is_none());

        let line_ws = r#"{"type":"result","is_error":false,"result":"   "}"#;
        assert!(parse_jsonl_message(line_ws).is_none());
    }

    #[test]
    fn get_conversation_deduplicates_assistant_and_result() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "proj");
        let id = "abcdef01-2345-6789-abcd-ef0123456789";

        // JSONL with assistant message followed by result with same content
        write_session(
            &dir,
            id,
            &[
                r#"{"type":"user","message":{"role":"user","content":"hello"},"timestamp":"2025-01-01T00:00:00Z"}"#,
                r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"answer"}]},"timestamp":"2025-01-01T00:00:01Z"}"#,
                r#"{"type":"result","is_error":false,"result":"answer","timestamp":"2025-01-01T00:00:02Z"}"#,
            ],
        );

        let result = get_conversation_impl(tmp.path(), "proj", id).unwrap();
        // Should have 2 messages: user + assistant (result deduplicated)
        assert_eq!(result.messages.len(), 2);
        assert_eq!(result.messages[0].role, "user");
        assert_eq!(result.messages[1].role, "assistant");
        assert_eq!(result.messages[1].content, "answer");
    }

    #[test]
    fn get_conversation_shows_result_when_no_assistant() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "proj");
        let id = "abcdef01-2345-6789-abcd-ef0123456789";

        // JSONL with only a result message (slash command — no assistant message)
        write_session(
            &dir,
            id,
            &[
                r#"{"type":"user","message":{"role":"user","content":"/cost"},"timestamp":"2025-01-01T00:00:00Z"}"#,
                r#"{"type":"result","is_error":false,"result":"Session cost: $0.003","timestamp":"2025-01-01T00:00:01Z"}"#,
            ],
        );

        let result = get_conversation_impl(tmp.path(), "proj", id).unwrap();
        assert_eq!(result.messages.len(), 2);
        assert_eq!(result.messages[0].role, "user");
        assert_eq!(result.messages[0].content, "/cost");
        assert_eq!(result.messages[1].role, "assistant");
        assert_eq!(result.messages[1].content, "Session cost: $0.003");
    }

    #[test]
    fn get_conversation_deduplicates_tool_use_turn_result() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "proj");
        let id = "abcdef01-2345-6789-abcd-ef0123456789";

        // Assistant message with text + tool_use → content = "I will read\n[Tool: Read]"
        // Result has only the text portion → content = "I will read"
        write_session(
            &dir,
            id,
            &[
                r#"{"type":"user","message":{"role":"user","content":"read it"},"timestamp":"2025-01-01T00:00:00Z"}"#,
                r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I will read"},{"type":"tool_use","name":"Read","input":{}}]},"timestamp":"2025-01-01T00:00:01Z"}"#,
                r#"{"type":"result","is_error":false,"result":"I will read","timestamp":"2025-01-01T00:00:02Z"}"#,
            ],
        );

        let result = get_conversation_impl(tmp.path(), "proj", id).unwrap();
        // 2 messages: user + assistant (result deduplicated).
        assert_eq!(result.messages.len(), 2);
        assert_eq!(result.messages[0].role, "user");
        assert_eq!(result.messages[1].role, "assistant");
        assert_eq!(result.messages[1].content, "I will read\n[Tool: Read]");
    }

    // ── compute_resume_snapshot ────────────────────────────────────

    #[test]
    fn compute_resume_snapshot_uses_latest_modelusage_for_tokens_and_cost() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "proj");
        let id = "abcdef01-2345-6789-abcd-ef0123456789";

        // Two cumulative result lines; the latest is authoritative.
        write_session(
            &dir,
            id,
            &[
                r#"{"type":"system","subtype":"init","model":"claude-opus-4-7"}"#,
                r#"{"type":"result","session_id":"s","is_error":false,"result":"ok","total_cost_usd":0.05,"usage":{"input_tokens":10,"output_tokens":5},"modelUsage":{"claude-opus-4-7":{"inputTokens":10,"outputTokens":5,"cacheReadInputTokens":0,"cacheCreationInputTokens":2}}}"#,
                r#"{"type":"result","session_id":"s","is_error":false,"result":"ok","total_cost_usd":0.18,"usage":{"input_tokens":7,"output_tokens":3},"modelUsage":{"claude-opus-4-7":{"inputTokens":17,"outputTokens":8,"cacheReadInputTokens":50,"cacheCreationInputTokens":2}}}"#,
            ],
        );

        let snap = compute_resume_snapshot_impl(tmp.path(), "proj", id).unwrap();
        // Latest cumulative `modelUsage` wins.
        assert_eq!(snap.input_tokens, 17);
        assert_eq!(snap.output_tokens, 8);
        assert_eq!(snap.cache_read_tokens, 50);
        assert_eq!(snap.cache_write_tokens, 2);
        assert_eq!(snap.total_cost, Some(0.18));
        assert_eq!(snap.model.as_deref(), Some("claude-opus-4-7"));
    }

    #[test]
    fn compute_resume_snapshot_falls_back_to_summed_flat_usage_without_modelusage() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "proj");
        let id = "abcdef01-2345-6789-abcd-ef0123456789";

        // No `modelUsage` anywhere; flat per-step `usage` must be summed.
        write_session(
            &dir,
            id,
            &[
                r#"{"type":"system","subtype":"init","model":"claude-sonnet-4-7"}"#,
                r#"{"type":"result","session_id":"s","is_error":false,"result":"ok","total_cost_usd":0.02,"usage":{"input_tokens":4,"output_tokens":2,"cache_read_input_tokens":1,"cache_creation_input_tokens":0}}"#,
                r#"{"type":"result","session_id":"s","is_error":false,"result":"ok","total_cost_usd":0.05,"usage":{"input_tokens":3,"output_tokens":1,"cache_read_input_tokens":2,"cache_creation_input_tokens":1}}"#,
            ],
        );

        let snap = compute_resume_snapshot_impl(tmp.path(), "proj", id).unwrap();
        assert_eq!(snap.input_tokens, 7);
        assert_eq!(snap.output_tokens, 3);
        assert_eq!(snap.cache_read_tokens, 3);
        assert_eq!(snap.cache_write_tokens, 1);
        assert_eq!(snap.total_cost, Some(0.05));
        // No `modelUsage` ever, so the system init model is the fallback.
        assert_eq!(snap.model.as_deref(), Some("claude-sonnet-4-7"));
    }

    #[test]
    fn compute_resume_snapshot_takes_context_usage_from_last_mainchain_assistant() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "proj");
        let id = "abcdef01-2345-6789-abcd-ef0123456789";

        // Real transcripts carry NO result/system lines — only per-call
        // assistant usage. Sidechain and all-zero lines never win.
        write_session(
            &dir,
            id,
            &[
                r#"{"type":"assistant","isSidechain":false,"message":{"role":"assistant","usage":{"input_tokens":5,"output_tokens":9,"cache_read_input_tokens":30000,"cache_creation_input_tokens":100}}}"#,
                r#"{"type":"assistant","isSidechain":false,"message":{"role":"assistant","usage":{"input_tokens":2,"output_tokens":1660,"cache_read_input_tokens":66844,"cache_creation_input_tokens":4920}}}"#,
                r#"{"type":"assistant","isSidechain":true,"message":{"role":"assistant","usage":{"input_tokens":9,"output_tokens":9,"cache_read_input_tokens":180000,"cache_creation_input_tokens":9}}}"#,
                r#"{"type":"assistant","isSidechain":false,"message":{"role":"assistant","usage":{"input_tokens":0,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}"#,
            ],
        );

        let snap = compute_resume_snapshot_impl(tmp.path(), "proj", id).unwrap();
        let cu = snap.context_usage.expect("context_usage must be present");
        assert_eq!(cu.input_tokens, 2);
        assert_eq!(cu.output_tokens, 1660);
        assert_eq!(cu.cache_read_tokens, 66844);
        assert_eq!(cu.cache_write_tokens, 4920);
    }

    #[test]
    fn compute_resume_snapshot_skips_sidechain_marked_via_parent_tool_use_id_only() {
        // Same exclusion as `isSidechain`, but via the live-stream marker with
        // no `isSidechain` field at all — proves the shared `is_sidechain_event`
        // helper (not a transcript-local `isSidechain` check) drives this path.
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "proj");
        let id = "abcdef01-2345-6789-abcd-ef0123456789";

        write_session(
            &dir,
            id,
            &[
                r#"{"type":"assistant","message":{"role":"assistant","usage":{"input_tokens":2,"output_tokens":1660,"cache_read_input_tokens":66844,"cache_creation_input_tokens":4920}}}"#,
                r#"{"type":"assistant","parent_tool_use_id":"toolu_task_1","message":{"role":"assistant","usage":{"input_tokens":9,"output_tokens":9,"cache_read_input_tokens":180000,"cache_creation_input_tokens":9}}}"#,
            ],
        );

        let snap = compute_resume_snapshot_impl(tmp.path(), "proj", id).unwrap();
        let cu = snap.context_usage.expect("context_usage must be present");
        assert_eq!(cu.cache_read_tokens, 66844);
    }

    #[test]
    fn compute_resume_snapshot_context_usage_none_without_assistant_usage() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "proj");
        let id = "abcdef01-2345-6789-abcd-ef0123456789";

        write_session(
            &dir,
            id,
            &[
                r#"{"type":"user","message":{"role":"user","content":"hi"}}"#,
                r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"no usage here"}]}}"#,
            ],
        );

        let snap = compute_resume_snapshot_impl(tmp.path(), "proj", id).unwrap();
        assert!(snap.context_usage.is_none());
    }

    #[test]
    fn compute_resume_snapshot_returns_zero_for_empty_transcript() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "proj");
        let id = "abcdef01-2345-6789-abcd-ef0123456789";

        // Transcript with no result/init lines must not error and reports a zero baseline.
        write_session(
            &dir,
            id,
            &[r#"{"type":"user","message":{"role":"user","content":"hi"}}"#],
        );

        let snap = compute_resume_snapshot_impl(tmp.path(), "proj", id).unwrap();
        assert_eq!(snap, ResumeSnapshot::default());
    }

    #[test]
    fn compute_resume_snapshot_skips_malformed_lines() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "proj");
        let id = "abcdef01-2345-6789-abcd-ef0123456789";

        // Malformed lines must not poison the running totals.
        write_session(
            &dir,
            id,
            &[
                "garbage that is not json",
                r#"{"type":"result","session_id":"s","is_error":false,"result":"ok","total_cost_usd":0.01,"modelUsage":{"claude-opus-4-7":{"inputTokens":3,"outputTokens":2}}}"#,
                "{ broken json",
            ],
        );

        let snap = compute_resume_snapshot_impl(tmp.path(), "proj", id).unwrap();
        assert_eq!(snap.input_tokens, 3);
        assert_eq!(snap.output_tokens, 2);
        assert_eq!(snap.total_cost, Some(0.01));
        assert_eq!(snap.model.as_deref(), Some("claude-opus-4-7"));
    }

    #[test]
    fn compute_resume_snapshot_rejects_invalid_session_id() {
        let tmp = tempfile::tempdir().unwrap();
        let result = compute_resume_snapshot_impl(tmp.path(), "proj", "../escape");
        assert!(result.is_err());
    }

    #[test]
    fn compute_resume_snapshot_returns_error_for_missing_file() {
        let tmp = tempfile::tempdir().unwrap();
        let result = compute_resume_snapshot_impl(
            tmp.path(),
            "proj",
            "abcdef01-2345-6789-abcd-ef0123456789",
        );
        assert!(result.is_err());
    }

    #[test]
    fn compute_resume_snapshot_prefers_modelusage_model_over_init() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "proj");
        let id = "abcdef01-2345-6789-abcd-ef0123456789";

        // On a mid-session model switch, the seed reflects the latest `modelUsage` model.
        write_session(
            &dir,
            id,
            &[
                r#"{"type":"system","subtype":"init","model":"claude-opus-4-7"}"#,
                r#"{"type":"result","session_id":"s","is_error":false,"result":"ok","total_cost_usd":0.10,"modelUsage":{"claude-sonnet-4-7":{"inputTokens":1,"outputTokens":1}}}"#,
            ],
        );

        let snap = compute_resume_snapshot_impl(tmp.path(), "proj", id).unwrap();
        assert_eq!(snap.model.as_deref(), Some("claude-sonnet-4-7"));
    }

    #[test]
    fn compute_resume_snapshot_picks_dominant_model_from_modelusage() {
        // From a multi-entry modelUsage map, picks the highest `outputTokens`.
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "proj");
        let id = "abcdef01-2345-6789-abcd-ef0123456790";

        write_session(
            &dir,
            id,
            &[
                r#"{"type":"system","subtype":"init","model":"claude-opus-4-7"}"#,
                r#"{"type":"result","session_id":"s","is_error":false,"result":"ok","total_cost_usd":0.10,"modelUsage":{"claude-haiku-4-5-20251001":{"inputTokens":10,"outputTokens":50},"claude-opus-4-7":{"inputTokens":100,"outputTokens":500}}}"#,
            ],
        );

        let snap = compute_resume_snapshot_impl(tmp.path(), "proj", id).unwrap();
        assert_eq!(
            snap.model.as_deref(),
            Some("claude-opus-4-7"),
            "must pick the model with the highest outputTokens, not the alphabetically first key"
        );
    }

    // ── delete_conversation ────────────────────────────────────────

    #[test]
    fn delete_conversation_removes_existing_file() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "proj");
        let id = "abcdef01-2345-6789-abcd-ef0123456789";
        write_session(&dir, id, &[r#"{"type":"user"}"#]);
        let path = dir.join(format!("{id}.jsonl"));
        assert!(path.exists());

        delete_conversation_impl(tmp.path(), "proj", id).unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn delete_conversation_is_idempotent_when_file_missing() {
        let tmp = tempfile::tempdir().unwrap();
        setup_sessions_dir(tmp.path(), "proj");
        let id = "abcdef01-2345-6789-abcd-ef0123456789";

        let result = delete_conversation_impl(tmp.path(), "proj", id);
        assert!(result.is_ok());
    }

    #[test]
    fn delete_conversation_rejects_path_traversal() {
        let tmp = tempfile::tempdir().unwrap();
        setup_sessions_dir(tmp.path(), "proj");

        let result = delete_conversation_impl(tmp.path(), "proj", "../escape");
        assert!(result.is_err());
    }

    #[test]
    fn delete_conversation_rejects_empty_session_id() {
        let tmp = tempfile::tempdir().unwrap();
        setup_sessions_dir(tmp.path(), "proj");

        let result = delete_conversation_impl(tmp.path(), "proj", "");
        assert!(result.is_err());
    }

    #[test]
    fn delete_conversation_does_not_touch_other_sessions() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "proj");
        let id_a = "abcdef01-2345-6789-abcd-ef0123456789";
        let id_b = "abcdef01-2345-6789-abcd-ef012345678a";
        write_session(&dir, id_a, &[r#"{"type":"user"}"#]);
        write_session(&dir, id_b, &[r#"{"type":"user"}"#]);

        delete_conversation_impl(tmp.path(), "proj", id_a).unwrap();
        assert!(!dir.join(format!("{id_a}.jsonl")).exists());
        assert!(dir.join(format!("{id_b}.jsonl")).exists());
    }
}
