use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use speedwave_runtime::consts;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ConversationSummary {
    pub session_id: String,
    pub timestamp: Option<String>,
    pub preview: String,
    pub message_count: usize,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(tag = "type")]
pub enum MessageBlock {
    #[serde(rename = "text")]
    Text { content: String },
    #[serde(rename = "thinking")]
    Thinking { content: String },
    #[serde(rename = "tool_use")]
    ToolUse {
        tool_name: String,
        input_json: String,
    },
    #[serde(rename = "tool_result")]
    ToolResult { content: String, is_error: bool },
    #[serde(rename = "error")]
    Error { content: String },
    #[serde(rename = "control_chip")]
    ControlChip { command: String, argument: String },
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ConversationMessage {
    pub role: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocks: Option<Vec<MessageBlock>>,
    pub timestamp: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uuid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<crate::chat::TurnUsage>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ConversationTranscript {
    pub session_id: String,
    pub messages: Vec<ConversationMessage>,
}

pub(crate) fn sessions_dir_impl(data_dir: &Path, project: &str) -> PathBuf {
    let projects_dir =
        speedwave_runtime::claude_home::claude_config_dir(data_dir, project).join("projects");
    resolve_workspace_dir(&projects_dir)
}

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

fn parse_jsonl_message(line: &str) -> Option<ConversationMessage> {
    let parsed: serde_json::Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => {
            log::debug!("skipping malformed JSONL line: {e}");
            return None;
        }
    };

    let msg_type = parsed["type"].as_str().unwrap_or("");

    if msg_type == "user" {
        if let Some(line) = control_command_from_synthetic_entry(&parsed) {
            return Some(control_line_message(&parsed, line));
        }
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
        _ => None,
    }
}

const TAIL_READ_BYTES: u64 = 64 * 1024;

fn last_message_timestamp(path: &Path) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let start = len.saturating_sub(TAIL_READ_BYTES);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf).ok()?;
    let tail = String::from_utf8_lossy(&buf);
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

fn is_synthetic_user_entry(parsed: &serde_json::Value) -> bool {
    let content = &parsed["message"]["content"];
    if let Some(s) = content.as_str() {
        text_is_synthetic(s)
    } else if let Some(arr) = content.as_array() {
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

fn control_command_from_synthetic_entry(parsed: &serde_json::Value) -> Option<String> {
    let content = &parsed["message"]["content"];
    let text = match content.as_str() {
        Some(s) => s.to_string(),
        None => content
            .as_array()?
            .iter()
            .filter(|b| b["type"].as_str() == Some("text"))
            .filter_map(|b| b["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n"),
    };
    if !text_is_synthetic(&text) {
        return None;
    }
    let name = tag_body(&text, "command-name")?.trim();
    let args = tag_body(&text, "command-args").unwrap_or("").trim();
    let line = format!("{name} {args}");
    speedwave_runtime::slash::parse_control_command(&line)
        .is_some()
        .then_some(line)
}

fn tag_body<'a>(text: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let start = text.find(&open)? + open.len();
    let end = text[start..].find(&format!("</{tag}>"))? + start;
    Some(&text[start..end])
}

fn control_line_message(parsed: &serde_json::Value, line: String) -> ConversationMessage {
    ConversationMessage {
        role: "user".to_string(),
        content: line.clone(),
        blocks: Some(vec![MessageBlock::Text { content: line }]),
        timestamp: parsed["timestamp"].as_str().map(String::from),
        uuid: parsed["uuid"].as_str().map(String::from),
        model: None,
        usage: None,
    }
}

fn parse_user_message(parsed: &serde_json::Value) -> Option<ConversationMessage> {
    let message = &parsed["message"];
    let content = &message["content"];
    let timestamp = parsed["timestamp"].as_str().map(String::from);
    let uuid = parsed["uuid"].as_str().map(String::from);

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

    if let Some(raw_blocks) = content.as_array() {
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

    let flat_content = if parts.is_empty() {
        "[thinking]".to_string()
    } else {
        parts.join("\n")
    };

    let model = message["model"].as_str().map(String::from);
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

fn truncate_preview(s: &str, max_chars: usize) -> String {
    let char_count = s.chars().count();
    if char_count <= max_chars {
        return s.to_string();
    }
    let end: String = s.chars().take(max_chars).collect();
    format!("{end}...")
}

fn fold_history_control_chips(messages: &mut Vec<ConversationMessage>) {
    let mut i = 0;
    while i < messages.len() {
        let chip = match messages[i].blocks.as_deref() {
            Some([MessageBlock::Text { content }]) if messages[i].role == "user" => {
                speedwave_runtime::slash::parse_control_command(content)
                    .map(|(command, argument)| (command.to_string(), argument.to_string()))
            }
            _ => None,
        };
        let Some((command, argument)) = chip else {
            i += 1;
            continue;
        };
        messages[i].blocks = Some(vec![MessageBlock::ControlChip { command, argument }]);

        let next_is_synthetic = messages.get(i + 1).is_some_and(|m| {
            m.role == "assistant"
                && m.model.as_deref() == Some(crate::session_model::SYNTHETIC_MODEL)
        });
        if next_is_synthetic {
            messages.remove(i + 1);
        }
        i += 1;
    }
}

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

        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }

        let session_id = match path.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };

        if validate_session_id_impl(&session_id).is_err() {
            continue;
        }

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
        let mut scanned_lines: usize = 0;

        for line in reader.lines().take(MAX_SCAN_LINES) {
            let line = match line {
                Ok(l) => l,
                Err(_) => break,
            };
            scanned_lines += 1;
            if let Some(msg) = parse_jsonl_message(&line) {
                let is_control_chip_user = msg.role == "user"
                    && speedwave_runtime::slash::parse_control_command(&msg.content).is_some();
                let is_synthetic_chip_reply = msg.role == "assistant"
                    && msg.model.as_deref() == Some(crate::session_model::SYNTHETIC_MODEL);
                if is_control_chip_user || is_synthetic_chip_reply {
                    continue;
                }
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
                if msg.timestamp.is_some() {
                    last_timestamp = msg.timestamp.clone();
                }
                if preview.is_empty() && msg.role == "user" {
                    preview = truncate_preview(&msg.content, 200);
                }
            }
        }

        let head_saw_whole_file = scanned_lines < MAX_SCAN_LINES;

        if !head_saw_whole_file {
            if let Some(ts) = last_message_timestamp(&path) {
                last_timestamp = Some(ts);
            }
        }

        if message_count == 0 {
            continue;
        }

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

    summaries.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));

    if dir.is_dir() && summaries.is_empty() {
        log::debug!(
            "sessions dir '{}' exists but contains no sessions",
            dir.display()
        );
    }

    Ok(summaries)
}

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

    fold_history_control_chips(&mut messages);

    Ok(ConversationTranscript {
        session_id: session_id.to_string(),
        messages,
    })
}

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

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ResumeSnapshot {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub total_cost: Option<f64>,
    pub model: Option<String>,
    pub context_usage: Option<crate::chat::TurnUsage>,
}

impl ResumeSnapshot {
    pub(crate) fn usage(&self) -> crate::chat::TurnUsage {
        crate::chat::TurnUsage {
            input_tokens: self.input_tokens,
            output_tokens: self.output_tokens,
            cache_read_tokens: self.cache_read_tokens,
            cache_write_tokens: self.cache_write_tokens,
        }
    }

    fn with_usage(usage: crate::chat::TurnUsage) -> Self {
        Self {
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            cache_read_tokens: usage.cache_read_tokens,
            cache_write_tokens: usage.cache_write_tokens,
            ..Self::default()
        }
    }
}

pub fn compute_resume_snapshot(project: &str, session_id: &str) -> anyhow::Result<ResumeSnapshot> {
    compute_resume_snapshot_impl(consts::data_dir(), project, session_id)
}

const LAST_SESSION_MODEL_SCAN_CAP: usize = 20;

pub(crate) fn last_session_model_impl(
    data_dir: &Path,
    project: &str,
    accept: impl Fn(&str) -> bool,
) -> Option<String> {
    let dir = sessions_dir_impl(data_dir, project);
    let mut entries: Vec<(std::time::SystemTime, PathBuf)> = fs::read_dir(&dir)
        .ok()?
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "jsonl"))
        .map(|e| {
            let modified = e
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or(std::time::UNIX_EPOCH);
            (modified, e.path())
        })
        .collect();
    entries.sort_by(|a, b| b.0.cmp(&a.0));
    entries
        .into_iter()
        .take(LAST_SESSION_MODEL_SCAN_CAP)
        .find_map(|(_, path)| session_start_model(&path).filter(|m| accept(m)))
}

fn session_start_model(path: &Path) -> Option<String> {
    let file = fs::File::open(path).ok()?;
    for line in BufReader::new(file)
        .lines()
        .take(10_000)
        .map_while(Result::ok)
    {
        let parsed: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let model = match parsed["type"].as_str().unwrap_or("") {
            "system" if parsed["subtype"].as_str() == Some("init") => parsed["model"].as_str(),
            "assistant" => parsed["message"]["model"].as_str(),
            _ => None,
        };
        match model {
            Some(m) if !m.is_empty() && m != crate::session_model::SYNTHETIC_MODEL => {
                return Some(m.to_string());
            }
            _ => {}
        }
    }
    None
}

const COST_STATE_LINE: &str = "cost-state";

const MAX_RESTORED_COST_USD: f64 = 1e9;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CostState {
    session_id: String,
    #[serde(rename = "totalCostUSD")]
    total_cost_usd: f64,
    #[serde(rename = "totalAPIDuration")]
    total_api_duration: f64,
    #[serde(rename = "totalAPIDurationWithoutRetries")]
    total_api_duration_without_retries: f64,
    total_tool_duration: f64,
    total_lines_added: f64,
    total_lines_removed: f64,
    total_duration: f64,
    start_time: f64,
    model_usage: std::collections::BTreeMap<String, CostStateModelUsage>,
    #[serde(
        rename = "hasUnknownModelCost",
        default,
        deserialize_with = "zod_optional_not_nullable"
    )]
    _has_unknown_model_cost: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CostStateModelUsage {
    input_tokens: f64,
    output_tokens: f64,
    #[serde(default, deserialize_with = "zod_optional_not_nullable")]
    thinking_tokens: Option<f64>,
    cache_read_input_tokens: f64,
    cache_creation_input_tokens: f64,
    web_search_requests: f64,
    #[serde(rename = "costUSD")]
    cost_usd: f64,
}

fn zod_optional_not_nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)?
        .map(Some)
        .ok_or_else(|| serde::de::Error::custom("null in a field Claude Code allows only to omit"))
}

fn is_count(value: f64) -> bool {
    value.is_finite() && value >= 0.0
}

fn is_unicode_format_char(c: char) -> bool {
    matches!(
        c,
        '\u{00AD}'
            | '\u{0600}'..='\u{0605}'
            | '\u{061C}'
            | '\u{06DD}'
            | '\u{070F}'
            | '\u{0890}'..='\u{0891}'
            | '\u{08E2}'
            | '\u{180E}'
            | '\u{200B}'..='\u{200F}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2060}'..='\u{2064}'
            | '\u{2066}'..='\u{206F}'
            | '\u{FEFF}'
            | '\u{FFF9}'..='\u{FFFB}'
            | '\u{110BD}'
            | '\u{110CD}'
            | '\u{13430}'..='\u{1343F}'
            | '\u{1BCA0}'..='\u{1BCA3}'
            | '\u{1D173}'..='\u{1D17A}'
            | '\u{E0001}'
            | '\u{E0020}'..='\u{E007F}'
    )
}

fn is_model_usage_key(key: &str) -> bool {
    !key.is_empty()
        && !key
            .chars()
            .any(|c| c.is_control() || is_unicode_format_char(c))
}

impl CostStateModelUsage {
    fn is_valid(&self) -> bool {
        [
            self.input_tokens,
            self.output_tokens,
            self.cache_read_input_tokens,
            self.cache_creation_input_tokens,
            self.web_search_requests,
            self.cost_usd,
        ]
        .into_iter()
        .chain(self.thinking_tokens)
        .all(is_count)
    }
}

impl CostState {
    fn restores(&self, session_id: &str) -> bool {
        self.session_id == session_id
            && self.total_cost_usd <= MAX_RESTORED_COST_USD
            && [
                self.total_cost_usd,
                self.total_api_duration,
                self.total_api_duration_without_retries,
                self.total_tool_duration,
                self.total_lines_added,
                self.total_lines_removed,
                self.total_duration,
                self.start_time,
            ]
            .into_iter()
            .all(is_count)
            && self
                .model_usage
                .iter()
                .all(|(model, usage)| is_model_usage_key(model) && usage.is_valid())
    }

    fn usage(&self) -> crate::chat::TurnUsage {
        let total = |count: fn(&CostStateModelUsage) -> f64| -> u64 {
            self.model_usage.values().map(count).sum::<f64>().round() as u64
        };
        crate::chat::TurnUsage {
            input_tokens: total(|u| u.input_tokens),
            output_tokens: total(|u| u.output_tokens),
            cache_read_tokens: total(|u| u.cache_read_input_tokens),
            cache_write_tokens: total(|u| u.cache_creation_input_tokens),
        }
    }

    fn dominant_model(&self) -> Option<&str> {
        self.model_usage
            .iter()
            .max_by(|(_, a), (_, b)| a.output_tokens.total_cmp(&b.output_tokens))
            .map(|(model, _)| model.as_str())
    }
}

fn restored_cost_state(parsed: &serde_json::Value, session_id: &str) -> Option<CostState> {
    CostState::deserialize(parsed)
        .ok()
        .filter(|state| state.restores(session_id))
}

fn snapshot_reads(line: &str) -> bool {
    [COST_STATE_LINE, "\"assistant\"", "\"system\""]
        .into_iter()
        .any(|marker| line.contains(marker))
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

    let mut reader = BufReader::new(file);

    let mut latest_cumulative: Option<ResumeSnapshot> = None;
    let mut latest_cost: Option<f64> = None;
    let mut latest_modelusage_model: Option<String> = None;
    let mut latest_init_model: Option<String> = None;
    let mut last_context_usage: Option<crate::chat::TurnUsage> = None;
    let mut tracker = crate::session_model::SessionModelTracker::default();

    let mut raw_line = Vec::new();
    loop {
        raw_line.clear();
        let read = reader
            .read_until(b'\n', &mut raw_line)
            .map_err(|e| anyhow::anyhow!("io error reading session: {e}"))?;
        if read == 0 {
            break;
        }
        let decoded = String::from_utf8_lossy(&raw_line);
        let line = decoded
            .trim_end_matches(['\n', '\r'])
            .trim_start_matches('\0');
        if !snapshot_reads(line) {
            continue;
        }
        let parsed: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        match parsed["type"].as_str().unwrap_or("") {
            COST_STATE_LINE => {
                if let Some(state) = restored_cost_state(&parsed, session_id) {
                    latest_cost = Some(state.total_cost_usd);
                    latest_cumulative = Some(ResumeSnapshot::with_usage(state.usage()));
                    if let Some(model) = state.dominant_model() {
                        latest_modelusage_model = Some(model.to_string());
                    }
                }
            }
            "system" => {
                if parsed["subtype"].as_str() == Some("init") {
                    if let Some(model) = parsed["model"].as_str() {
                        if !model.is_empty() {
                            latest_init_model = Some(model.to_string());
                            tracker.observe_init(model);
                        }
                    }
                }
            }
            "assistant" => {
                if !crate::chat::is_sidechain_event(&parsed) {
                    if let Some(model) = parsed["message"]["model"].as_str() {
                        tracker.observe_assistant(model);
                    }
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

    let mut snap = latest_cumulative.unwrap_or_default();
    snap.total_cost = latest_cost;
    snap.model = tracker
        .resolve()
        .map(str::to_string)
        .or(latest_modelusage_model)
        .or(latest_init_model);
    snap.context_usage = last_context_usage;
    Ok(snap)
}

#[cfg(test)]
#[expect(clippy::unwrap_used, reason = "test code asserts via unwrap")]
mod tests {
    use super::*;

    fn setup_sessions_dir(data_dir: &Path, project: &str) -> PathBuf {
        let dir = sessions_dir_impl(data_dir, project);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_session(dir: &Path, session_id: &str, lines: &[&str]) {
        let path = dir.join(format!("{session_id}.jsonl"));
        fs::write(&path, lines.join("\n")).unwrap();
    }

    fn user_msg(uuid: &str, content: &str) -> ConversationMessage {
        ConversationMessage {
            role: "user".to_string(),
            content: content.to_string(),
            blocks: Some(vec![MessageBlock::Text {
                content: content.to_string(),
            }]),
            timestamp: None,
            uuid: Some(uuid.to_string()),
            model: None,
            usage: None,
        }
    }

    fn assistant_msg(model: Option<&str>, content: &str) -> ConversationMessage {
        ConversationMessage {
            role: "assistant".to_string(),
            content: content.to_string(),
            blocks: Some(vec![MessageBlock::Text {
                content: content.to_string(),
            }]),
            timestamp: None,
            uuid: None,
            model: model.map(str::to_string),
            usage: None,
        }
    }

    #[test]
    fn fold_history_control_chips_converts_matching_user_text() {
        let mut messages = vec![user_msg("u1", "/model claude-sonnet-5")];
        fold_history_control_chips(&mut messages);
        match &messages[0].blocks.as_ref().unwrap()[0] {
            MessageBlock::ControlChip { command, argument } => {
                assert_eq!(command, "model");
                assert_eq!(argument, "claude-sonnet-5");
            }
            other => panic!("expected ControlChip, got {other:?}"),
        }
    }

    #[test]
    fn fold_history_control_chips_removes_paired_synthetic_reply() {
        let mut messages = vec![
            user_msg("u1", "/model claude-sonnet-5"),
            assistant_msg(
                Some(crate::session_model::SYNTHETIC_MODEL),
                "Set model to claude-sonnet-5",
            ),
            assistant_msg(Some("claude-sonnet-5"), "Hello!"),
        ];
        fold_history_control_chips(&mut messages);
        assert_eq!(
            messages.len(),
            2,
            "the synthetic confirmation must be folded away"
        );
        assert!(matches!(
            messages[0].blocks.as_ref().unwrap()[0],
            MessageBlock::ControlChip { .. }
        ));
        assert_eq!(messages[1].content, "Hello!");
    }

    #[test]
    fn fold_history_control_chips_only_folds_synthetic_directly_after_a_chip() {
        let mut messages = vec![
            user_msg("u1", "hello"),
            assistant_msg(
                Some(crate::session_model::SYNTHETIC_MODEL),
                "unrelated synthetic reply",
            ),
        ];
        fold_history_control_chips(&mut messages);
        assert_eq!(
            messages.len(),
            2,
            "synthetic-fold only applies right after a chip"
        );
        match &messages[0].blocks.as_ref().unwrap()[0] {
            MessageBlock::Text { content } => assert_eq!(content, "hello"),
            other => panic!("expected Text, got {other:?}"),
        }
    }

    #[test]
    fn fold_history_control_chips_leaves_help_command_unchipped() {
        let mut messages = vec![user_msg("u1", "/help")];
        fold_history_control_chips(&mut messages);
        match &messages[0].blocks.as_ref().unwrap()[0] {
            MessageBlock::Text { content } => assert_eq!(content, "/help"),
            other => panic!("expected Text, got {other:?}"),
        }
    }

    #[test]
    fn fold_history_control_chips_preserves_retry_anchor_uuid() {
        let mut messages = vec![user_msg("u1", "/effort high")];
        fold_history_control_chips(&mut messages);
        assert_eq!(messages[0].uuid.as_deref(), Some("u1"));
    }

    #[test]
    fn fold_history_control_chips_ignores_multi_block_user_messages() {
        let mut messages = vec![ConversationMessage {
            role: "user".to_string(),
            content: "/model claude-sonnet-5".to_string(),
            blocks: Some(vec![
                MessageBlock::Text {
                    content: "/model claude-sonnet-5".to_string(),
                },
                MessageBlock::Text {
                    content: "extra".to_string(),
                },
            ]),
            timestamp: None,
            uuid: Some("u1".to_string()),
            model: None,
            usage: None,
        }];
        fold_history_control_chips(&mut messages);
        assert!(matches!(
            messages[0].blocks.as_ref().unwrap()[0],
            MessageBlock::Text { .. }
        ));
    }

    #[test]
    fn fold_history_control_chips_classification_matches_parse_control_command_directly() {
        let source = [
            ("user", None, "/model claude-sonnet-5"),
            (
                "assistant",
                Some(crate::session_model::SYNTHETIC_MODEL),
                "Set model to claude-sonnet-5",
            ),
            ("user", None, "what is 2+2?"),
            ("assistant", Some("claude-sonnet-5"), "4"),
        ];

        let mut history_side: Vec<ConversationMessage> = source
            .iter()
            .map(|(role, model, text)| {
                if *role == "user" {
                    user_msg("uuid", text)
                } else {
                    assistant_msg(*model, text)
                }
            })
            .collect();
        fold_history_control_chips(&mut history_side);

        assert_eq!(
            history_side.len(),
            3,
            "the paired synthetic confirmation must be folded away"
        );

        for (idx, (role, _model, text)) in source.iter().enumerate() {
            if *role != "user" {
                continue;
            }
            let live_path_is_chip = speedwave_runtime::slash::parse_control_command(text).is_some();
            let history_side_msg = history_side
                .iter()
                .find(|m| m.role == "user" && m.content == *text);
            let history_is_chip = history_side_msg.is_some_and(|m| {
                matches!(
                    m.blocks.as_deref(),
                    Some([MessageBlock::ControlChip { .. }])
                )
            });
            assert_eq!(
                live_path_is_chip, history_is_chip,
                "entry {idx} ('{text}'): live-path and history classification must agree"
            );
        }
    }

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

    #[test]
    fn sessions_dir_resolves_dash_workspace() {
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
        let data_dir = PathBuf::from("/opt/custom-speedwave");
        let result = sessions_dir_impl(&data_dir, "proj");
        assert_eq!(
            result,
            PathBuf::from("/opt/custom-speedwave/claude-home/proj/.claude/projects/-workspace")
        );
    }

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

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("/nonexistent/target", projects.join("-broken")).unwrap();
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

        fs::set_permissions(&projects, fs::Permissions::from_mode(0o000)).unwrap();

        let result = resolve_workspace_dir(&projects);
        assert_eq!(result, projects.join("-workspace"));

        fs::set_permissions(&projects, fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[test]
    fn get_project_memory_works_with_autodiscovered_dir() {
        let tmp = tempfile::tempdir().unwrap();
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

    #[test]
    fn list_conversations_returns_empty_when_autodiscovered_dir_has_no_sessions() {
        let tmp = tempfile::tempdir().unwrap();
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
        assert_eq!(usage.cache_read_tokens, 56);
        assert_eq!(usage.cache_write_tokens, 78);
    }

    #[test]
    fn parse_assistant_message_sidechain_line_drops_usage() {
        let line = r#"{"type":"assistant","isSidechain":true,"message":{"role":"assistant","model":"claude-haiku-4-5-20251001","content":[{"type":"text","text":"subagent"}],"usage":{"input_tokens":9,"output_tokens":9,"cache_read_input_tokens":180000,"cache_creation_input_tokens":9}}}"#;
        let msg = parse_jsonl_message(line).unwrap();
        assert!(msg.usage.is_none());
        assert_eq!(msg.model.as_deref(), Some("claude-haiku-4-5-20251001"));
    }

    #[test]
    fn parse_assistant_message_parent_tool_use_id_line_also_drops_usage() {
        let line = r#"{"type":"assistant","parent_tool_use_id":"toolu_task_1","message":{"role":"assistant","model":"claude-haiku-4-5-20251001","content":[{"type":"text","text":"subagent"}],"usage":{"input_tokens":9,"output_tokens":9,"cache_read_input_tokens":180000,"cache_creation_input_tokens":9}}}"#;
        let msg = parse_jsonl_message(line).unwrap();
        assert!(msg.usage.is_none());
    }

    #[test]
    fn parse_assistant_message_usage_missing_fields_default_zero() {
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
        let line = r#"{"type":"assistant","message":{"role":"assistant","model":"claude-opus-4-8","content":[{"type":"text","text":"hi"}]}}"#;
        let msg = parse_jsonl_message(line).unwrap();
        assert_eq!(msg.model.as_deref(), Some("claude-opus-4-8"));
        assert!(msg.usage.is_none());
    }

    #[test]
    fn parse_assistant_message_null_usage_is_none() {
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
        assert_eq!(result[0].session_id, id_started_early);
        assert_eq!(result[1].session_id, id_started_late);
    }

    #[test]
    fn list_conversations_timestamp_skips_trailing_metadata_lines() {
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
        assert_eq!(result[0].message_count, 2);
    }

    #[test]
    fn list_conversations_skips_non_uuid_files() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "proj");

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
        assert_eq!(result[0].preview.len(), 203);
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
        let line = r#"{"type":"user","message":{"role":"user","isMeta":true,"content":"<local-command-caveat>x</local-command-caveat>"}}"#;
        assert!(parse_jsonl_message(line).is_none());
    }

    #[test]
    fn parse_jsonl_message_does_not_drop_is_meta_on_non_user_types() {
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
    fn get_conversation_renders_control_chip_and_folds_synthetic_reply() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "proj");
        let id = "abcdef01-2345-6789-abcd-ef0123456789";

        write_session(
            &dir,
            id,
            &[
                r#"{"type":"user","uuid":"u1","message":{"role":"user","content":"/model claude-sonnet-5"},"timestamp":"2025-01-01T00:00:00Z"}"#,
                r#"{"type":"assistant","message":{"role":"assistant","model":"<synthetic>","content":[{"type":"text","text":"Set model to claude-sonnet-5"}]},"timestamp":"2025-01-01T00:00:01Z"}"#,
                r#"{"type":"user","uuid":"u2","message":{"role":"user","content":"what is 2+2?"},"timestamp":"2025-01-01T00:00:02Z"}"#,
                r#"{"type":"assistant","message":{"role":"assistant","model":"claude-sonnet-5","content":[{"type":"text","text":"4"}]},"timestamp":"2025-01-01T00:00:03Z"}"#,
            ],
        );

        let transcript = get_conversation_impl(tmp.path(), "proj", id).unwrap();
        assert_eq!(
            transcript.messages.len(),
            3,
            "the synthetic reply must be folded away"
        );
        match &transcript.messages[0].blocks.as_ref().unwrap()[0] {
            MessageBlock::ControlChip { command, argument } => {
                assert_eq!(command, "model");
                assert_eq!(argument, "claude-sonnet-5");
            }
            other => panic!(
                "expected ControlChip, got {:?}",
                std::mem::discriminant(other)
            ),
        }
        assert_eq!(transcript.messages[0].uuid.as_deref(), Some("u1"));
        assert_eq!(transcript.messages[1].content, "what is 2+2?");
        assert_eq!(transcript.messages[2].content, "4");
    }

    #[test]
    fn get_conversation_hand_typed_chip_gets_the_same_treatment() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "proj");
        let id = "abcdef01-2345-6789-abcd-ef0123456789";

        write_session(
            &dir,
            id,
            &[
                r#"{"type":"user","uuid":"u1","message":{"role":"user","content":"/effort high"},"timestamp":"2025-01-01T00:00:00Z"}"#,
            ],
        );

        let transcript = get_conversation_impl(tmp.path(), "proj", id).unwrap();
        assert_eq!(transcript.messages.len(), 1);
        match &transcript.messages[0].blocks.as_ref().unwrap()[0] {
            MessageBlock::ControlChip { command, argument } => {
                assert_eq!(command, "effort");
                assert_eq!(argument, "high");
            }
            other => panic!(
                "expected ControlChip, got {:?}",
                std::mem::discriminant(other)
            ),
        }
    }

    #[test]
    fn get_conversation_rebuilds_the_chip_from_claude_codes_synthetic_command_entry() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "proj");
        let id = "abcdef01-2345-6789-abcd-ef0123456789";

        write_session(
            &dir,
            id,
            &[
                r#"{"type":"user","uuid":"u1","message":{"role":"user","content":"<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>openai/gpt-4o-mini</command-args>"},"timestamp":"2025-01-01T00:00:00Z"}"#,
                r#"{"type":"system","uuid":"s1","subtype":"local_command","content":"Set model to openai/gpt-4o-mini","timestamp":"2025-01-01T00:00:01Z"}"#,
                r#"{"type":"user","uuid":"u2","message":{"role":"user","content":"what is 2+2?"},"timestamp":"2025-01-01T00:00:02Z"}"#,
                r#"{"type":"assistant","message":{"role":"assistant","model":"claude-sonnet-5","content":[{"type":"text","text":"4"}]},"timestamp":"2025-01-01T00:00:03Z"}"#,
            ],
        );

        let transcript = get_conversation_impl(tmp.path(), "proj", id).unwrap();
        assert_eq!(transcript.messages.len(), 3);
        match &transcript.messages[0].blocks.as_ref().unwrap()[0] {
            MessageBlock::ControlChip { command, argument } => {
                assert_eq!(command, "model");
                assert_eq!(argument, "openai/gpt-4o-mini");
            }
            other => panic!(
                "expected ControlChip, got {:?}",
                std::mem::discriminant(other)
            ),
        }
        assert_eq!(transcript.messages[0].uuid.as_deref(), Some("u1"));
        assert_eq!(transcript.messages[1].content, "what is 2+2?");
        assert_eq!(transcript.messages[2].content, "4");
    }

    #[test]
    fn a_set_model_switch_is_rebuilt_as_a_model_chip_between_the_turns() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "proj");
        let id = "abcdef01-2345-6789-abcd-ef0123456789";

        write_session(
            &dir,
            id,
            &[
                r#"{"type":"user","uuid":"17332c55-943a-4a57-8f86-a0e9685d6a11","message":{"role":"user","content":[{"type":"text","text":"Say hello in one word."}]},"timestamp":"2026-09-24T04:54:21.215Z","isSidechain":false,"parentUuid":null}"#,
                r#"{"type":"assistant","uuid":"47762bfa-223f-4551-bb63-df30c0a476e1","message":{"role":"assistant","model":"openrouter/anthropic/claude-sonnet-5","content":[{"type":"tool_use","id":"toolu_stub_1","name":"Read","input":{"file_path":"/workspace/notes.txt"}}]},"timestamp":"2026-09-24T04:54:21.547Z","isSidechain":false,"parentUuid":"8eb92599-6243-4dc8-a32e-ecf85e523aab"}"#,
                r#"{"type":"user","uuid":"3082c0a0-0fea-4c5f-bcce-01edeb236f02","message":{"role":"user","content":[{"tool_use_id":"toolu_stub_1","type":"tool_result","content":"1\tfile body for the Read tool\n2\t"}]},"timestamp":"2026-09-24T04:54:21.571Z","isSidechain":false,"parentUuid":"47762bfa-223f-4551-bb63-df30c0a476e1"}"#,
                r#"{"type":"assistant","uuid":"e13b637d-1738-444c-8a6e-d94c4ed11aa2","message":{"role":"assistant","model":"openrouter/openai/gpt-4o-mini","content":[{"type":"text","text":"stub reply"}]},"timestamp":"2026-09-24T04:54:21.890Z","isSidechain":false,"parentUuid":"222c3a61-ca7f-4c65-9843-fcfcec7c00d5"}"#,
                r#"{"type":"user","uuid":"eeb8bcc4-1f16-4070-86ae-24ac529e41de","isMeta":true,"message":{"role":"user","content":"<local-command-caveat>Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to.</local-command-caveat>"},"timestamp":"2026-09-24T04:54:21.231Z","isSidechain":false,"parentUuid":"e13b637d-1738-444c-8a6e-d94c4ed11aa2"}"#,
                r#"{"type":"user","uuid":"602c6477-f20b-4ec9-bc4a-b5a70823fba8","message":{"role":"user","content":"<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>openrouter/openai/gpt-4o-mini</command-args>"},"timestamp":"2026-09-24T04:54:21.231Z","isSidechain":false,"parentUuid":"eeb8bcc4-1f16-4070-86ae-24ac529e41de"}"#,
                r#"{"type":"user","uuid":"4aad17e6-e632-4c4a-932e-f2dcd5761680","message":{"role":"user","content":"<local-command-stdout>Set model to `openrouter/openai/gpt-4o-mini`</local-command-stdout>"},"timestamp":"2026-09-24T04:54:21.231Z","isSidechain":false,"parentUuid":"602c6477-f20b-4ec9-bc4a-b5a70823fba8"}"#,
                r#"{"type":"user","uuid":"ca30f52b-236f-4eff-8614-438d4ebb6931","message":{"role":"user","content":[{"type":"text","text":"Second message."}]},"timestamp":"2026-09-24T04:54:21.913Z","isSidechain":false,"parentUuid":"4aad17e6-e632-4c4a-932e-f2dcd5761680"}"#,
                r#"{"type":"assistant","uuid":"61e55f15-5b60-44dc-820c-c969e574eb47","message":{"role":"assistant","model":"openrouter/openai/gpt-4o-mini","content":[{"type":"text","text":"stub reply"}]},"timestamp":"2026-09-24T04:54:22.223Z","isSidechain":false,"parentUuid":"c6c5a443-5b77-46bc-8f75-051fd7a1836c"}"#,
            ],
        );

        let transcript = get_conversation_impl(tmp.path(), "proj", id).unwrap();
        let shapes: Vec<String> = transcript
            .messages
            .iter()
            .map(|m| match m.blocks.as_ref().and_then(|b| b.first()) {
                Some(MessageBlock::ControlChip { command, argument }) => {
                    format!("/{command} {argument}")
                }
                _ => m.content.clone(),
            })
            .collect();
        let chip = shapes
            .iter()
            .position(|s| s == "/model openrouter/openai/gpt-4o-mini")
            .expect("the switch is rebuilt as a /model chip");
        assert_eq!(shapes.iter().filter(|s| s.starts_with("/model")).count(), 1);
        assert_eq!(shapes[chip - 1], "stub reply", "{shapes:?}");
        assert_eq!(shapes[chip + 1], "Second message.", "{shapes:?}");
        assert_eq!(
            shapes.first().map(String::as_str),
            Some("Say hello in one word.")
        );
    }

    #[test]
    fn get_conversation_rebuilds_an_effort_chip_from_a_text_block_array_entry_marked_meta() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "proj");
        let id = "abcdef01-2345-6789-abcd-ef0123456789";

        write_session(
            &dir,
            id,
            &[
                r#"{"type":"user","uuid":"u1","isMeta":true,"message":{"role":"user","content":[{"type":"text","text":"<command-name>/effort</command-name>\n<command-message>effort</command-message>\n<command-args>high</command-args>"}]},"timestamp":"2025-01-01T00:00:00Z"}"#,
            ],
        );

        let transcript = get_conversation_impl(tmp.path(), "proj", id).unwrap();
        assert_eq!(transcript.messages.len(), 1);
        match &transcript.messages[0].blocks.as_ref().unwrap()[0] {
            MessageBlock::ControlChip { command, argument } => {
                assert_eq!(command, "effort");
                assert_eq!(argument, "high");
            }
            other => panic!(
                "expected ControlChip, got {:?}",
                std::mem::discriminant(other)
            ),
        }
        assert_eq!(transcript.messages[0].uuid.as_deref(), Some("u1"));
    }

    #[test]
    fn get_conversation_drops_synthetic_command_entries_that_are_not_control_commands() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "proj");
        let id = "abcdef01-2345-6789-abcd-ef0123456789";

        write_session(
            &dir,
            id,
            &[
                r#"{"type":"user","message":{"role":"user","content":"<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>"},"timestamp":"2025-01-01T00:00:00Z"}"#,
                r#"{"type":"user","message":{"role":"user","content":"<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>"},"timestamp":"2025-01-01T00:00:01Z"}"#,
                r#"{"type":"user","message":{"role":"user","content":"<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>claude-sonnet-5 extra</command-args>"},"timestamp":"2025-01-01T00:00:02Z"}"#,
                r#"{"type":"user","uuid":"u2","message":{"role":"user","content":"real question"},"timestamp":"2025-01-01T00:00:03Z"}"#,
            ],
        );

        let transcript = get_conversation_impl(tmp.path(), "proj", id).unwrap();
        assert_eq!(transcript.messages.len(), 1);
        assert_eq!(transcript.messages[0].content, "real question");
    }

    #[test]
    fn get_conversation_keeps_a_typed_message_that_merely_mentions_command_tags() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "proj");
        let id = "abcdef01-2345-6789-abcd-ef0123456789";

        write_session(
            &dir,
            id,
            &[
                r#"{"type":"user","uuid":"u1","message":{"role":"user","content":"Can you explain what <command-name>/model</command-name> and <command-args>sonnet</command-args> mean?"},"timestamp":"2025-01-01T00:00:00Z"}"#,
            ],
        );

        let transcript = get_conversation_impl(tmp.path(), "proj", id).unwrap();
        assert_eq!(transcript.messages.len(), 1);
        assert_eq!(
            transcript.messages[0].content,
            "Can you explain what <command-name>/model</command-name> and <command-args>sonnet</command-args> mean?"
        );
        assert!(
            !transcript.messages[0]
                .blocks
                .iter()
                .flatten()
                .any(|b| matches!(b, MessageBlock::ControlChip { .. })),
            "a typed question must never be rebuilt into a control chip"
        );
    }

    #[test]
    fn list_conversations_preview_skips_a_synthetic_control_command_entry() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "proj");
        let id = "abcdef01-2345-6789-abcd-ef0123456789";

        write_session(
            &dir,
            id,
            &[
                r#"{"type":"user","uuid":"u1","message":{"role":"user","content":"<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>claude-sonnet-5</command-args>"},"timestamp":"2025-01-01T00:00:00Z"}"#,
                r#"{"type":"system","uuid":"s1","subtype":"local_command","content":"Set model to claude-sonnet-5","timestamp":"2025-01-01T00:00:01Z"}"#,
                r#"{"type":"user","uuid":"u2","message":{"role":"user","content":"real question"},"timestamp":"2025-01-01T00:00:02Z"}"#,
                r#"{"type":"assistant","message":{"role":"assistant","model":"claude-sonnet-5","content":[{"type":"text","text":"real answer"}]},"timestamp":"2025-01-01T00:00:03Z"}"#,
            ],
        );

        let result = list_conversations_impl(tmp.path(), "proj").unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].preview, "real question");
        assert_eq!(result[0].message_count, 2);
    }

    #[test]
    fn tag_body_requires_both_tags() {
        assert_eq!(tag_body("<a>x</a>", "a"), Some("x"));
        assert_eq!(tag_body("<a>x", "a"), None);
        assert_eq!(tag_body("x</a>", "a"), None);
        assert_eq!(
            tag_body("<command-args></command-args>", "command-args"),
            Some("")
        );
    }

    #[test]
    fn list_conversations_skips_slash_command_markers() {
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
    fn list_conversations_preview_falls_back_past_a_leading_control_chip() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "proj");
        let id = "abcdef01-2345-6789-abcd-ef0123456789";

        write_session(
            &dir,
            id,
            &[
                r#"{"type":"user","uuid":"u1","message":{"role":"user","content":"/model claude-sonnet-5"},"timestamp":"2025-01-01T00:00:00Z"}"#,
                r#"{"type":"assistant","message":{"role":"assistant","model":"<synthetic>","content":[{"type":"text","text":"Set model to claude-sonnet-5"}]},"timestamp":"2025-01-01T00:00:01Z"}"#,
                r#"{"type":"user","uuid":"u2","message":{"role":"user","content":"real question"},"timestamp":"2025-01-01T00:00:02Z"}"#,
                r#"{"type":"assistant","message":{"role":"assistant","model":"claude-sonnet-5","content":[{"type":"text","text":"real answer"}]},"timestamp":"2025-01-01T00:00:03Z"}"#,
            ],
        );

        let result = list_conversations_impl(tmp.path(), "proj").unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(
            result[0].preview, "real question",
            "the chip and its synthetic reply must never be chosen as the preview"
        );
        assert_eq!(
            result[0].message_count, 2,
            "the chip/synthetic-reply pair must not count toward message_count"
        );
    }

    #[test]
    fn list_conversations_synthetic_model_exclusion_is_only_ever_adjacent_to_a_control_chip() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "proj");
        let id = "abcdef01-2345-6789-abcd-ef0123456789";

        write_session(
            &dir,
            id,
            &[
                r#"{"type":"user","uuid":"u1","message":{"role":"user","content":"real question"},"timestamp":"2025-01-01T00:00:00Z"}"#,
                r#"{"type":"assistant","message":{"role":"assistant","model":"claude-sonnet-5","content":[{"type":"text","text":"real answer"}]},"timestamp":"2025-01-01T00:00:01Z"}"#,
                r#"{"type":"user","uuid":"u2","message":{"role":"user","content":"/model claude-opus-4-7"},"timestamp":"2025-01-01T00:00:02Z"}"#,
                r#"{"type":"assistant","message":{"role":"assistant","model":"<synthetic>","content":[{"type":"text","text":"Set model to claude-opus-4-7"}]},"timestamp":"2025-01-01T00:00:03Z"}"#,
                r#"{"type":"user","uuid":"u3","message":{"role":"user","content":"/effort high"},"timestamp":"2025-01-01T00:00:04Z"}"#,
                r#"{"type":"assistant","message":{"role":"assistant","model":"<synthetic>","content":[{"type":"text","text":"Set effort to high"}]},"timestamp":"2025-01-01T00:00:05Z"}"#,
                r#"{"type":"user","uuid":"u4","message":{"role":"user","content":"another real question"},"timestamp":"2025-01-01T00:00:06Z"}"#,
                r#"{"type":"assistant","message":{"role":"assistant","model":"claude-opus-4-7","content":[{"type":"text","text":"another real answer"}]},"timestamp":"2025-01-01T00:00:07Z"}"#,
            ],
        );

        let result = list_conversations_impl(tmp.path(), "proj").unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(
            result[0].message_count, 4,
            "only the two chip exchanges are excluded; both real turns count"
        );
    }

    #[test]
    fn list_conversations_chip_only_session_is_dropped_like_any_other_empty_session() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "proj");
        let id = "abcdef01-2345-6789-abcd-ef0123456789";

        write_session(
            &dir,
            id,
            &[
                r#"{"type":"user","uuid":"u1","message":{"role":"user","content":"/effort high"},"timestamp":"2025-01-01T00:00:00Z"}"#,
                r#"{"type":"assistant","message":{"role":"assistant","model":"<synthetic>","content":[{"type":"text","text":"Set effort to high"}]},"timestamp":"2025-01-01T00:00:01Z"}"#,
            ],
        );

        let result = list_conversations_impl(tmp.path(), "proj").unwrap();
        assert_eq!(
            result.len(),
            0,
            "a chip-only session has zero real messages and is dropped, matching any other empty session"
        );
    }

    #[test]
    fn list_conversations_drops_sdk_cli_boilerplate_session() {
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
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "proj");
        let id = "abcdef01-2345-6789-abcd-ef0123456789";

        let mut lines: Vec<String> = Vec::new();
        lines.push(
            r#"{"type":"user","message":{"role":"user","content":"/"},"timestamp":"2025-01-01T00:00:00Z"}"#
                .to_string(),
        );
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
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "proj");
        let id = "abcdef01-2345-6789-abcd-ef0123456789";
        let path = dir.join(format!("{id}.jsonl"));
        fs::write(&path, "{\"type\":\"last-prompt\"}\n{\"type\":\"ai-title\"}").unwrap();
        assert!(last_message_timestamp(&path).is_none());
    }

    #[test]
    fn last_message_timestamp_does_not_panic_on_single_huge_line() {
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
        assert!(last_message_timestamp(&tmp.path().join("nope.jsonl")).is_none());
        let empty = tmp.path().join("empty.jsonl");
        fs::write(&empty, "").unwrap();
        assert!(last_message_timestamp(&empty).is_none());
    }

    #[test]
    fn last_message_timestamp_reads_only_the_tail_of_a_large_file() {
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
        let line = r#"{"type":"user","message":{"role":"user","content":"Commands are in the form `/command [args]`\n\nMore context."}}"#;
        assert!(parse_jsonl_message(line).is_none());
    }

    #[test]
    fn parse_jsonl_message_drops_synthetic_tag_in_non_first_text_block() {
        let line = r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"preamble"},{"type":"text","text":"<command-name>/clear</command-name>"}]}}"#;
        assert!(parse_jsonl_message(line).is_none());
    }

    #[test]
    fn truncate_preview_is_utf8_safe() {
        let emoji_msg = "\u{1F600}".repeat(300);
        let result = truncate_preview(&emoji_msg, 200);
        assert_eq!(result.chars().count(), 203);
        assert!(result.ends_with("..."));
    }

    #[test]
    fn truncate_preview_short_string_unchanged() {
        assert_eq!(truncate_preview("hello", 200), "hello");
    }

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

        let mut transcript = get_conversation_impl(tmp.path(), "proj", id).unwrap();
        assert!(
            transcript.messages[0].content.contains("TOKEN_"),
            "history.rs must read the tokenized source as-is"
        );

        crate::pii_display::detokenize_transcript(
            &mut transcript,
            &crate::pii_display::DisplayPolicy::new(Some(key), Vec::new()),
        );
        assert_eq!(transcript.messages[0].content, "contact jan@example.com");

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

    #[test]
    fn list_conversations_ignores_non_jsonl_files() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "proj");

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
    fn message_block_control_chip_serializes_with_type_tag() {
        let block = MessageBlock::ControlChip {
            command: "model".to_string(),
            argument: "claude-sonnet-5".to_string(),
        };
        let encoded = serde_json::to_value(&block).unwrap();
        assert_eq!(
            encoded,
            serde_json::json!({
                "type": "control_chip",
                "command": "model",
                "argument": "claude-sonnet-5",
            })
        );
    }

    #[test]
    fn message_block_control_chip_roundtrips() {
        let line = r#"{"type":"control_chip","command":"effort","argument":"high"}"#;
        let decoded: MessageBlock = serde_json::from_str(line).unwrap();
        match decoded {
            MessageBlock::ControlChip { command, argument } => {
                assert_eq!(command, "effort");
                assert_eq!(argument, "high");
            }
            other => panic!("expected ControlChip, got {other:?}"),
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
        assert_eq!(result.messages.len(), 2);
        assert_eq!(result.messages[0].role, "user");
        assert_eq!(result.messages[1].role, "assistant");
        assert_eq!(result.messages[1].content, "I will read\n[Tool: Read]");
    }

    const RESUME_TRANSCRIPT: &str =
        include_str!("../tests/fixtures/cc-2.1.282-resume-transcript.sanitized.jsonl");
    const RESUME_TRANSCRIPT_AFTER: &str =
        include_str!("../tests/fixtures/cc-2.1.282-resume-transcript-after.sanitized.jsonl");
    const RESUME_STDOUT: &str =
        include_str!("../tests/fixtures/cc-2.1.282-resume-stdout.sanitized.ndjson");
    const RESUMED_SESSION: &str = "7f989b3d-8e7e-4691-ac93-c91c3bf281c2";
    const SNAPSHOT_SESSION: &str = "abcdef01-2345-6789-abcd-ef0123456789";

    fn is_cost_state(line: &str) -> bool {
        serde_json::from_str::<serde_json::Value>(line)
            .is_ok_and(|l| l["type"].as_str() == Some(COST_STATE_LINE))
    }

    fn cost_state_line(session: &str, cost: f64, model_usage: serde_json::Value) -> String {
        serde_json::json!({
            "type": "cost-state",
            "sessionId": session,
            "totalCostUSD": cost,
            "totalAPIDuration": 436,
            "totalAPIDurationWithoutRetries": 434,
            "totalToolDuration": 0,
            "totalLinesAdded": 0,
            "totalLinesRemoved": 0,
            "totalDuration": 792,
            "startTime": 1_790_282_904_783_u64,
            "modelUsage": model_usage,
            "hasUnknownModelCost": false,
        })
        .to_string()
    }

    fn model_usage_entry(
        input: u64,
        output: u64,
        cache_read: u64,
        cache_write: u64,
    ) -> serde_json::Value {
        serde_json::json!({
            "inputTokens": input,
            "outputTokens": output,
            "thinkingTokens": 0,
            "cacheReadInputTokens": cache_read,
            "cacheCreationInputTokens": cache_write,
            "webSearchRequests": 0,
            "costUSD": 0.0,
        })
    }

    fn snapshot_of_lines(lines: &[String]) -> ResumeSnapshot {
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "proj");
        let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
        write_session(&dir, SNAPSHOT_SESSION, &refs);
        compute_resume_snapshot_impl(tmp.path(), "proj", SNAPSHOT_SESSION).unwrap()
    }

    fn last_cost_state(transcript: &str) -> serde_json::Value {
        transcript
            .lines()
            .filter(|l| is_cost_state(l))
            .last()
            .map(|l| serde_json::from_str(l).unwrap())
            .expect("the capture holds a cost-state line")
    }

    fn last_assistant_model(transcript: &str) -> String {
        transcript
            .lines()
            .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
            .filter(|l| l["type"] == "assistant")
            .filter_map(|l| l["message"]["model"].as_str().map(str::to_string))
            .last()
            .expect("the capture holds an assistant model")
    }

    fn resumed_result() -> serde_json::Value {
        RESUME_STDOUT
            .lines()
            .map(|l| serde_json::from_str::<serde_json::Value>(l).unwrap())
            .find(|l| l["type"] == "result")
            .expect("the resumed run ends in a result")
    }

    fn snapshot_of_capture(transcript: &str) -> ResumeSnapshot {
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "proj");
        let lines: Vec<&str> = transcript.lines().collect();
        write_session(&dir, RESUMED_SESSION, &lines);
        compute_resume_snapshot_impl(tmp.path(), "proj", RESUMED_SESSION).unwrap()
    }

    #[test]
    fn the_resume_captures_are_of_the_pinned_claude_code() {
        let transcript_versions: std::collections::BTreeSet<String> = RESUME_TRANSCRIPT
            .lines()
            .chain(RESUME_TRANSCRIPT_AFTER.lines())
            .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
            .filter_map(|l| l["version"].as_str().map(str::to_string))
            .collect();
        let init_version = RESUME_STDOUT
            .lines()
            .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
            .find(|l| l["type"] == "system" && l["subtype"] == "init")
            .and_then(|l| l["claude_code_version"].as_str().map(str::to_string));

        let pinned = speedwave_runtime::defaults::CLAUDE_VERSION.to_string();
        assert_eq!(
            transcript_versions,
            std::collections::BTreeSet::from([pinned.clone()]),
            "re-capture the resume transcripts from the new Claude Code pin"
        );
        assert_eq!(init_version, Some(pinned));
    }

    fn resumed_results(
        parser: &mut crate::chat::StreamParser,
        stdout: &[serde_json::Value],
    ) -> Vec<crate::chat::StreamChunk> {
        stdout
            .iter()
            .flat_map(|l| parser.parse_line(l).0)
            .filter(|c| matches!(c, crate::chat::StreamChunk::Result { .. }))
            .collect()
    }

    fn model_usage_sum(line: &serde_json::Value) -> crate::chat::TurnUsage {
        let models = line["modelUsage"].as_object().unwrap();
        let total = |key: &str| models.values().map(|m| m[key].as_u64().unwrap()).sum();
        crate::chat::TurnUsage {
            input_tokens: total("inputTokens"),
            output_tokens: total("outputTokens"),
            cache_read_tokens: total("cacheReadInputTokens"),
            cache_write_tokens: total("cacheCreationInputTokens"),
        }
    }

    fn usage_between(
        after: crate::chat::TurnUsage,
        before: crate::chat::TurnUsage,
    ) -> crate::chat::TurnUsage {
        crate::chat::TurnUsage {
            input_tokens: after.input_tokens - before.input_tokens,
            output_tokens: after.output_tokens - before.output_tokens,
            cache_read_tokens: after.cache_read_tokens - before.cache_read_tokens,
            cache_write_tokens: after.cache_write_tokens - before.cache_write_tokens,
        }
    }

    #[test]
    fn a_resumed_first_turn_is_charged_only_for_itself() {
        let exit_state = last_cost_state(RESUME_TRANSCRIPT);
        let result = resumed_result();
        let expected_turn_cost = result["total_cost_usd"].as_f64().unwrap()
            - exit_state["totalCostUSD"].as_f64().unwrap();
        let expected_turn_usage =
            usage_between(model_usage_sum(&result), model_usage_sum(&exit_state));
        assert!(expected_turn_cost > 0.0);
        let mut parser = crate::chat::StreamParser::new();
        parser.restore_resume_snapshot(snapshot_of_capture(RESUME_TRANSCRIPT));
        assert_eq!(
            parser.previous_session_usage(),
            model_usage_sum(&exit_state)
        );

        let stdout: Vec<serde_json::Value> = RESUME_STDOUT
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        let results = resumed_results(&mut parser, &stdout);

        let [crate::chat::StreamChunk::Result {
            total_cost,
            turn_cost,
            turn_usage,
            ..
        }] = results.as_slice()
        else {
            panic!("the resumed turn must end in one result: {results:?}");
        };
        assert_eq!(*total_cost, result["total_cost_usd"].as_f64());
        assert!(
            (turn_cost.unwrap() - expected_turn_cost).abs() < 1e-12,
            "the first turn after a resume was charged {turn_cost:?}"
        );
        assert_eq!(*turn_usage, Some(expected_turn_usage));
    }

    #[test]
    fn a_resumed_first_turn_takes_its_tokens_from_the_restored_model_usage() {
        let exit_state = last_cost_state(RESUME_TRANSCRIPT);
        let result = resumed_result();
        let mut parser = crate::chat::StreamParser::new();
        parser.restore_resume_snapshot(snapshot_of_capture(RESUME_TRANSCRIPT));

        let stdout: Vec<serde_json::Value> = RESUME_STDOUT
            .lines()
            .map(|l| serde_json::from_str::<serde_json::Value>(l).unwrap())
            .map(|mut l| {
                if l["type"] == "result" {
                    l.as_object_mut().unwrap().remove("usage");
                }
                l
            })
            .collect();
        let results = resumed_results(&mut parser, &stdout);

        let [crate::chat::StreamChunk::Result { turn_usage, .. }] = results.as_slice() else {
            panic!("the resumed turn must end in one result: {results:?}");
        };
        assert_eq!(
            *turn_usage,
            Some(usage_between(
                model_usage_sum(&result),
                model_usage_sum(&exit_state)
            ))
        );
    }

    #[test]
    fn the_resume_snapshot_starts_from_the_cost_state_claude_code_wrote_at_exit() {
        let exit_state = last_cost_state(RESUME_TRANSCRIPT);

        let snapshot = snapshot_of_capture(RESUME_TRANSCRIPT);

        assert_eq!(snapshot.total_cost, exit_state["totalCostUSD"].as_f64());
        assert_eq!(snapshot.usage(), model_usage_sum(&exit_state));
        assert_eq!(
            snapshot.model.as_deref(),
            Some(last_assistant_model(RESUME_TRANSCRIPT).as_str())
        );
    }

    #[test]
    fn the_last_of_several_cost_state_lines_wins() {
        assert_eq!(
            RESUME_TRANSCRIPT_AFTER
                .lines()
                .filter(|l| is_cost_state(l))
                .count(),
            2
        );
        let last = last_cost_state(RESUME_TRANSCRIPT_AFTER);
        assert_ne!(last, last_cost_state(RESUME_TRANSCRIPT));

        let snapshot = snapshot_of_capture(RESUME_TRANSCRIPT_AFTER);

        assert_eq!(snapshot.total_cost, last["totalCostUSD"].as_f64());
        assert_eq!(snapshot.usage(), model_usage_sum(&last));
    }

    #[test]
    fn the_snapshot_reads_a_cost_state_line_far_down_a_long_transcript() {
        let mut lines: Vec<String> = (0..12_000)
            .map(|i| {
                format!(r#"{{"type":"user","message":{{"role":"user","content":"line {i}"}}}}"#)
            })
            .collect();
        lines.push(cost_state_line(
            SNAPSHOT_SESSION,
            0.42,
            serde_json::json!({ "claude-opus-5-5": model_usage_entry(7, 3, 5, 1) }),
        ));

        let snapshot = snapshot_of_lines(&lines);

        assert_eq!(snapshot.total_cost, Some(0.42));
        assert_eq!((snapshot.input_tokens, snapshot.output_tokens), (7, 3));
    }

    #[test]
    fn a_cost_state_line_of_another_session_is_not_restored() {
        let mut missing_id: serde_json::Value = serde_json::from_str(&cost_state_line(
            SNAPSHOT_SESSION,
            9.0,
            serde_json::json!({ "m": model_usage_entry(90, 90, 0, 0) }),
        ))
        .unwrap();
        missing_id.as_object_mut().unwrap().remove("sessionId");
        let lines = vec![
            cost_state_line(
                SNAPSHOT_SESSION,
                0.25,
                serde_json::json!({ "m": model_usage_entry(4, 2, 0, 0) }),
            ),
            cost_state_line(
                "11111111-2222-3333-4444-555555555555",
                7.0,
                serde_json::json!({ "m": model_usage_entry(70, 70, 0, 0) }),
            ),
            missing_id.to_string(),
        ];

        let snapshot = snapshot_of_lines(&lines);

        assert_eq!(snapshot.total_cost, Some(0.25));
        assert_eq!((snapshot.input_tokens, snapshot.output_tokens), (4, 2));
    }

    #[test]
    fn a_cost_state_line_claude_code_would_reject_is_not_restored() {
        let valid = cost_state_line(
            SNAPSHOT_SESSION,
            0.25,
            serde_json::json!({ "m": model_usage_entry(4, 2, 0, 0) }),
        );
        let minimal = serde_json::json!({
            "type": "cost-state",
            "sessionId": SNAPSHOT_SESSION,
            "totalCostUSD": 17.0,
            "modelUsage": { "m": model_usage_entry(170, 170, 0, 0) },
        })
        .to_string();
        let negative = cost_state_line(
            SNAPSHOT_SESSION,
            13.0,
            serde_json::json!({ "m": model_usage_entry(130, 130, 0, 0) }),
        )
        .replace(r#""totalDuration":792"#, r#""totalDuration":-1"#);
        let over_the_cap = cost_state_line(
            SNAPSHOT_SESSION,
            2e9,
            serde_json::json!({ "m": model_usage_entry(20, 20, 0, 0) }),
        );
        let incomplete_usage = cost_state_line(
            SNAPSHOT_SESSION,
            11.0,
            serde_json::json!({ "m": { "inputTokens": 110, "outputTokens": 110 } }),
        );
        let control_key = cost_state_line(
            SNAPSHOT_SESSION,
            12.0,
            serde_json::json!({ "m\u{7}": model_usage_entry(120, 120, 0, 0) }),
        );
        let format_key = cost_state_line(
            SNAPSHOT_SESSION,
            14.0,
            serde_json::json!({ "m\u{200b}": model_usage_entry(140, 140, 0, 0) }),
        );
        assert!(negative.contains(r#""totalDuration":-1"#));

        let snapshot = snapshot_of_lines(&[
            valid,
            minimal,
            negative,
            over_the_cap,
            incomplete_usage,
            control_key,
            format_key,
        ]);

        assert_eq!(snapshot.total_cost, Some(0.25));
        assert_eq!((snapshot.input_tokens, snapshot.output_tokens), (4, 2));
    }

    #[test]
    fn a_cost_state_line_missing_optional_fields_still_restores() {
        let line = serde_json::json!({
            "type": "cost-state",
            "sessionId": SNAPSHOT_SESSION,
            "totalCostUSD": 0.42,
            "totalAPIDuration": 436,
            "totalAPIDurationWithoutRetries": 434,
            "totalToolDuration": 0,
            "totalLinesAdded": 0,
            "totalLinesRemoved": 0,
            "totalDuration": 792,
            "startTime": 1_790_282_904_783_u64,
            "modelUsage": {
                "m": {
                    "inputTokens": 7,
                    "outputTokens": 3,
                    "cacheReadInputTokens": 5,
                    "cacheCreationInputTokens": 1,
                    "webSearchRequests": 0,
                    "costUSD": 0.0,
                }
            },
        })
        .to_string();
        assert!(!line.contains("thinkingTokens"));
        assert!(!line.contains("hasUnknownModelCost"));

        let snapshot = snapshot_of_lines(&[line]);

        assert_eq!(snapshot.total_cost, Some(0.42));
        assert_eq!((snapshot.input_tokens, snapshot.output_tokens), (7, 3));
    }

    #[test]
    fn a_cost_state_line_with_null_has_unknown_model_cost_is_not_restored() {
        let mut line: serde_json::Value = serde_json::from_str(&cost_state_line(
            SNAPSHOT_SESSION,
            0.25,
            serde_json::json!({ "m": model_usage_entry(4, 2, 0, 0) }),
        ))
        .unwrap();
        line["hasUnknownModelCost"] = serde_json::Value::Null;
        assert!(line.to_string().contains(r#""hasUnknownModelCost":null"#));

        let snapshot = snapshot_of_lines(&[line.to_string()]);

        assert_eq!(snapshot.total_cost, None);
    }

    #[test]
    fn a_cost_state_line_with_null_thinking_tokens_is_not_restored() {
        let mut line: serde_json::Value = serde_json::from_str(&cost_state_line(
            SNAPSHOT_SESSION,
            0.25,
            serde_json::json!({ "m": model_usage_entry(4, 2, 0, 0) }),
        ))
        .unwrap();
        line["modelUsage"]["m"]["thinkingTokens"] = serde_json::Value::Null;
        assert!(line.to_string().contains(r#""thinkingTokens":null"#));

        let snapshot = snapshot_of_lines(&[line.to_string()]);

        assert_eq!(snapshot.total_cost, None);
    }

    #[test]
    fn a_cost_state_line_with_leading_nul_bytes_still_restores() {
        let valid = cost_state_line(
            SNAPSHOT_SESSION,
            0.42,
            serde_json::json!({ "m": model_usage_entry(7, 3, 5, 1) }),
        );
        let padded = format!("\0\0\0{valid}");

        let snapshot = snapshot_of_lines(&[padded]);

        assert_eq!(snapshot.total_cost, Some(0.42));
        assert_eq!((snapshot.input_tokens, snapshot.output_tokens), (7, 3));
    }

    #[test]
    fn a_cost_state_line_with_trailing_nul_bytes_is_skipped_as_claude_code_skips_it() {
        let earlier = cost_state_line(
            SNAPSHOT_SESSION,
            0.25,
            serde_json::json!({ "m": model_usage_entry(4, 2, 0, 0) }),
        );
        let later = cost_state_line(
            SNAPSHOT_SESSION,
            0.42,
            serde_json::json!({ "m": model_usage_entry(7, 3, 5, 1) }),
        );

        let snapshot = snapshot_of_lines(&[earlier, format!("{later}\0\0")]);

        assert_eq!(snapshot.total_cost, Some(0.25));
        assert_eq!((snapshot.input_tokens, snapshot.output_tokens), (4, 2));
    }

    #[test]
    fn token_counts_written_as_json_floats_are_restored() {
        let line = cost_state_line(
            SNAPSHOT_SESSION,
            0.42,
            serde_json::json!({
                "claude-opus-5-5": {
                    "inputTokens": 7.0,
                    "outputTokens": 20.0,
                    "cacheReadInputTokens": 5e0,
                    "cacheCreationInputTokens": 1,
                    "webSearchRequests": 0,
                    "costUSD": 0.42,
                },
            }),
        );
        assert!(line.contains(r#""outputTokens":20.0"#));

        let snapshot = snapshot_of_lines(&[line]);

        assert_eq!(
            snapshot.usage(),
            crate::chat::TurnUsage {
                input_tokens: 7,
                output_tokens: 20,
                cache_read_tokens: 5,
                cache_write_tokens: 1,
            }
        );
        assert_eq!(snapshot.model.as_deref(), Some("claude-opus-5-5"));
    }

    #[test]
    fn the_model_with_the_most_output_tokens_wins_even_when_its_count_is_a_json_float() {
        let line = cost_state_line(
            SNAPSHOT_SESSION,
            0.42,
            serde_json::json!({
                "claude-haiku-4-5": model_usage_entry(1, 3, 0, 0),
                "claude-fable-5": {
                    "inputTokens": 1,
                    "outputTokens": 9.0,
                    "cacheReadInputTokens": 0,
                    "cacheCreationInputTokens": 0,
                    "webSearchRequests": 0,
                    "costUSD": 0.4,
                },
            }),
        );

        let snapshot = snapshot_of_lines(&[line]);

        assert_eq!(snapshot.model.as_deref(), Some("claude-fable-5"));
        assert_eq!(snapshot.output_tokens, 12);
    }

    #[test]
    fn a_later_cost_state_without_model_usage_keeps_the_model_seen_before() {
        let snapshot = snapshot_of_lines(&[
            cost_state_line(
                SNAPSHOT_SESSION,
                0.25,
                serde_json::json!({ "claude-opus-5-5": model_usage_entry(4, 2, 0, 0) }),
            ),
            cost_state_line(SNAPSHOT_SESSION, 0.5, serde_json::json!({})),
        ]);

        assert_eq!(snapshot.total_cost, Some(0.5));
        assert_eq!(snapshot.model.as_deref(), Some("claude-opus-5-5"));
    }

    #[test]
    fn a_cost_state_line_at_the_cost_cap_still_restores() {
        let snapshot = snapshot_of_lines(&[cost_state_line(
            SNAPSHOT_SESSION,
            MAX_RESTORED_COST_USD,
            serde_json::json!({ "m": model_usage_entry(4, 2, 0, 0) }),
        )]);

        assert_eq!(snapshot.total_cost, Some(MAX_RESTORED_COST_USD));
    }

    #[test]
    fn a_torn_non_utf8_line_is_skipped_after_a_valid_cost_state() {
        let valid = cost_state_line(
            SNAPSHOT_SESSION,
            0.42,
            serde_json::json!({ "m": model_usage_entry(7, 3, 5, 1) }),
        );
        let torn_source = cost_state_line(
            SNAPSHOT_SESSION,
            99.0,
            serde_json::json!({ "m": model_usage_entry(1, 1, 1, 1) }),
        );
        let marker = torn_source
            .find(COST_STATE_LINE)
            .expect("the source line names its type");
        let mut torn = torn_source.into_bytes();
        torn.truncate(marker + COST_STATE_LINE.len() + 2);
        torn.push(0xFF);
        torn.push(0xFE);

        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "proj");
        let path = dir.join(format!("{SNAPSHOT_SESSION}.jsonl"));
        let mut bytes = valid.into_bytes();
        bytes.push(b'\n');
        bytes.extend_from_slice(&torn);
        fs::write(&path, &bytes).unwrap();

        let snapshot = compute_resume_snapshot_impl(tmp.path(), "proj", SNAPSHOT_SESSION).unwrap();

        assert_eq!(snapshot.total_cost, Some(0.42));
        assert_eq!((snapshot.input_tokens, snapshot.output_tokens), (7, 3));
    }

    #[test]
    fn cost_and_tokens_come_from_the_same_cost_state_line() {
        let snapshot = snapshot_of_lines(&[
            cost_state_line(
                SNAPSHOT_SESSION,
                0.25,
                serde_json::json!({ "m": model_usage_entry(4, 2, 1, 1) }),
            ),
            cost_state_line(SNAPSHOT_SESSION, 0.5, serde_json::json!({})),
        ]);

        assert_eq!(snapshot.total_cost, Some(0.5));
        assert_eq!(snapshot.usage(), crate::chat::TurnUsage::default());
    }

    #[test]
    fn a_transcript_without_cost_state_starts_without_a_cost() {
        let without: String = RESUME_TRANSCRIPT
            .lines()
            .filter(|l| !is_cost_state(l))
            .map(|l| format!("{l}\n"))
            .collect();
        assert!(without.len() < RESUME_TRANSCRIPT.len());

        let snapshot = snapshot_of_capture(&without);

        assert_eq!(snapshot.total_cost, None);
        assert_eq!(snapshot.input_tokens, 0);
        assert_eq!(snapshot.output_tokens, 0);
        assert_eq!(snapshot.cache_read_tokens, 0);
        assert_eq!(snapshot.cache_write_tokens, 0);
        assert_eq!(
            snapshot.model.as_deref(),
            Some(last_assistant_model(&without).as_str())
        );
    }

    #[test]
    fn a_result_line_in_a_transcript_moves_neither_cost_nor_tokens() {
        let snapshot = snapshot_of_lines(&[
            cost_state_line(
                SNAPSHOT_SESSION,
                0.09,
                serde_json::json!({ "m": model_usage_entry(12, 6, 3, 1) }),
            ),
            r#"{"type":"result","session_id":"s","is_error":false,"result":"ok","total_cost_usd":0.5,"modelUsage":{"m":{"inputTokens":50,"outputTokens":50}}}"#.to_string(),
        ]);

        assert_eq!(snapshot.total_cost, Some(0.09));
        assert_eq!(
            snapshot.usage(),
            crate::chat::TurnUsage {
                input_tokens: 12,
                output_tokens: 6,
                cache_read_tokens: 3,
                cache_write_tokens: 1,
            }
        );
    }

    #[test]
    fn compute_resume_snapshot_uses_latest_modelusage_for_tokens_and_cost() {
        let snap = snapshot_of_lines(&[
            r#"{"type":"system","subtype":"init","model":"claude-opus-4-7"}"#.to_string(),
            cost_state_line(
                SNAPSHOT_SESSION,
                0.05,
                serde_json::json!({ "claude-opus-4-7": model_usage_entry(10, 5, 0, 2) }),
            ),
            cost_state_line(
                SNAPSHOT_SESSION,
                0.18,
                serde_json::json!({ "claude-opus-4-7": model_usage_entry(17, 8, 50, 2) }),
            ),
        ]);

        assert_eq!(snap.input_tokens, 17);
        assert_eq!(snap.output_tokens, 8);
        assert_eq!(snap.cache_read_tokens, 50);
        assert_eq!(snap.cache_write_tokens, 2);
        assert_eq!(snap.total_cost, Some(0.18));
        assert_eq!(snap.model.as_deref(), Some("claude-opus-4-7"));
    }

    #[test]
    fn compute_resume_snapshot_takes_context_usage_from_last_mainchain_assistant() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "proj");
        let id = "abcdef01-2345-6789-abcd-ef0123456789";

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

        write_session(
            &dir,
            id,
            &[
                "garbage that is not json",
                &cost_state_line(
                    id,
                    0.01,
                    serde_json::json!({ "claude-opus-4-7": model_usage_entry(3, 2, 0, 0) }),
                ),
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
    fn compute_resume_snapshot_chronological_model_wins_over_usage_dominant_old_model() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "proj");
        let id = "abcdef01-2345-6789-abcd-ef0123456789";

        write_session(
            &dir,
            id,
            &[
                r#"{"type":"system","subtype":"init","model":"model-a"}"#,
                r#"{"type":"assistant","message":{"role":"assistant","model":"model-a","usage":{"input_tokens":100,"output_tokens":900}}}"#,
                r#"{"type":"assistant","message":{"role":"assistant","model":"model-a","usage":{"input_tokens":100,"output_tokens":900}}}"#,
                r#"{"type":"system","subtype":"init","model":"model-b"}"#,
                r#"{"type":"assistant","message":{"role":"assistant","model":"model-b","usage":{"input_tokens":1,"output_tokens":1}}}"#,
            ],
        );

        let snap = compute_resume_snapshot_impl(tmp.path(), "proj", id).unwrap();
        assert_eq!(snap.model.as_deref(), Some("model-b"));
    }

    #[test]
    fn compute_resume_snapshot_chronological_tracker_wins_over_usage_dominant_model_never_observed_chronologically(
    ) {
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "proj");
        let id = "abcdef01-2345-6789-abcd-ef0123456789";

        write_session(
            &dir,
            id,
            &[
                r#"{"type":"system","subtype":"init","model":"model-a"}"#,
                r#"{"type":"assistant","message":{"role":"assistant","usage":{"input_tokens":1,"output_tokens":1}}}"#,
                &cost_state_line(
                    id,
                    0.10,
                    serde_json::json!({ "model-b": model_usage_entry(100, 900, 0, 0) }),
                ),
            ],
        );

        let snap = compute_resume_snapshot_impl(tmp.path(), "proj", id).unwrap();
        assert_eq!(
            snap.model.as_deref(),
            Some("model-a"),
            "chronological tracker (init-observed model-a) must win over usage-dominant model-b, \
             which was never chronologically observed"
        );
    }

    #[test]
    fn compute_resume_snapshot_synthetic_assistant_model_without_later_init_is_ignored() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "proj");
        let id = "abcdef01-2345-6789-abcd-ef0123456789";

        write_session(
            &dir,
            id,
            &[
                r#"{"type":"system","subtype":"init","model":"model-a"}"#,
                r#"{"type":"assistant","message":{"role":"assistant","model":"<synthetic>"}}"#,
            ],
        );

        let snap = compute_resume_snapshot_impl(tmp.path(), "proj", id).unwrap();
        assert_eq!(snap.model.as_deref(), Some("model-a"));
    }

    #[test]
    fn compute_resume_snapshot_assistant_model_wins_when_no_init_line() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "proj");
        let id = "abcdef01-2345-6789-abcd-ef0123456789";

        write_session(
            &dir,
            id,
            &[r#"{"type":"assistant","message":{"role":"assistant","model":"claude-haiku-4-5"}}"#],
        );

        let snap = compute_resume_snapshot_impl(tmp.path(), "proj", id).unwrap();
        assert_eq!(snap.model.as_deref(), Some("claude-haiku-4-5"));
    }

    #[test]
    fn compute_resume_snapshot_sidechain_assistant_model_does_not_override_main_chain() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "proj");
        let id = "abcdef01-2345-6789-abcd-ef0123456789";

        write_session(
            &dir,
            id,
            &[
                r#"{"type":"system","subtype":"init","model":"model-a"}"#,
                r#"{"type":"assistant","isSidechain":true,"message":{"role":"assistant","model":"claude-haiku-4-5-20251001"}}"#,
            ],
        );

        let snap = compute_resume_snapshot_impl(tmp.path(), "proj", id).unwrap();
        assert_eq!(snap.model.as_deref(), Some("model-a"));
    }

    #[test]
    fn compute_resume_snapshot_main_chain_assistant_model_supersedes_init() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "proj");
        let id = "abcdef01-2345-6789-abcd-ef0123456789";

        write_session(
            &dir,
            id,
            &[
                r#"{"type":"system","subtype":"init","model":"claude-opus-4-7"}"#,
                r#"{"type":"assistant","parent_tool_use_id":null,"message":{"id":"msg_1","model":"claude-sonnet-4-7","role":"assistant"}}"#,
                &cost_state_line(
                    id,
                    0.10,
                    serde_json::json!({ "claude-sonnet-4-7": model_usage_entry(1, 1, 0, 0) }),
                ),
            ],
        );

        let snap = compute_resume_snapshot_impl(tmp.path(), "proj", id).unwrap();
        assert_eq!(snap.model.as_deref(), Some("claude-sonnet-4-7"));
    }

    #[test]
    fn compute_resume_snapshot_ignores_sidechain_assistant_model() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "proj");
        let id = "abcdef01-2345-6789-abcd-ef0123456789";

        write_session(
            &dir,
            id,
            &[
                r#"{"type":"system","subtype":"init","model":"claude-fable-5"}"#,
                r#"{"type":"assistant","isSidechain":true,"message":{"id":"msg_1","model":"claude-haiku-4-5","role":"assistant"}}"#,
                r#"{"type":"assistant","parent_tool_use_id":"toolu_1","message":{"id":"msg_2","model":"claude-haiku-4-5","role":"assistant"}}"#,
                &cost_state_line(
                    id,
                    0.10,
                    serde_json::json!({
                        "claude-haiku-4-5": model_usage_entry(10, 5000, 0, 0),
                        "claude-fable-5": model_usage_entry(100, 100, 0, 0),
                    }),
                ),
            ],
        );

        let snap = compute_resume_snapshot_impl(tmp.path(), "proj", id).unwrap();
        assert_eq!(
            snap.model.as_deref(),
            Some("claude-fable-5"),
            "a sidechain assistant model must never move the conversation model"
        );
    }

    #[test]
    fn compute_resume_snapshot_later_init_supersedes_earlier_assistant_model() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "proj");
        let id = "abcdef01-2345-6789-abcd-ef0123456789";

        write_session(
            &dir,
            id,
            &[
                r#"{"type":"system","subtype":"init","model":"claude-opus-4-7"}"#,
                r#"{"type":"assistant","parent_tool_use_id":null,"message":{"id":"msg_1","model":"claude-opus-4-7","role":"assistant"}}"#,
                r#"{"type":"system","subtype":"init","model":"claude-sonnet-4-7"}"#,
            ],
        );

        let snap = compute_resume_snapshot_impl(tmp.path(), "proj", id).unwrap();
        assert_eq!(snap.model.as_deref(), Some("claude-sonnet-4-7"));
    }
    #[test]
    fn compute_resume_snapshot_picks_dominant_model_from_modelusage() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "proj");
        let id = "abcdef01-2345-6789-abcd-ef0123456790";

        write_session(
            &dir,
            id,
            &[&cost_state_line(
                id,
                0.10,
                serde_json::json!({
                    "claude-haiku-4-5-20251001": model_usage_entry(10, 50, 0, 0),
                    "claude-opus-4-7": model_usage_entry(100, 500, 0, 0),
                }),
            )],
        );

        let snap = compute_resume_snapshot_impl(tmp.path(), "proj", id).unwrap();
        assert_eq!(
            snap.model.as_deref(),
            Some("claude-opus-4-7"),
            "must pick the model with the highest outputTokens, not the alphabetically first key"
        );
    }

    #[test]
    fn compute_resume_snapshot_ignores_chip_exchange_when_a_real_turn_follows() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "proj");
        let id = "abcdef01-2345-6789-abcd-ef0123456789";

        write_session(
            &dir,
            id,
            &[
                r#"{"type":"system","subtype":"init","model":"claude-opus-4-7"}"#,
                r#"{"type":"user","uuid":"u1","message":{"role":"user","content":"/model claude-sonnet-5"}}"#,
                r#"{"type":"assistant","message":{"role":"assistant","model":"<synthetic>","content":[{"type":"text","text":"Set model to claude-sonnet-5"}]}}"#,
                r#"{"type":"system","subtype":"init","model":"claude-sonnet-5"}"#,
                r#"{"type":"assistant","isSidechain":false,"message":{"role":"assistant","usage":{"input_tokens":5,"output_tokens":9,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}"#,
            ],
        );

        let snap = compute_resume_snapshot_impl(tmp.path(), "proj", id).unwrap();
        assert_eq!(snap.model.as_deref(), Some("claude-sonnet-5"));
        let cu = snap.context_usage.expect("context_usage must be present");
        assert_eq!(cu.input_tokens, 5);
        assert_eq!(cu.output_tokens, 9);
    }

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

    #[test]
    fn control_chip_tag_matches_ts() {
        let json = serde_json::to_string(&MessageBlock::ControlChip {
            command: "model".to_string(),
            argument: "claude-sonnet-5".to_string(),
        })
        .unwrap();
        assert!(
            json.contains(r#""type":"control_chip""#),
            "Rust MessageBlock::ControlChip must serialize with tag control_chip, got: {json}"
        );

        let ts = include_str!("../../src/src/app/services/chat-state.service.ts");
        assert!(
            ts.contains("'control_chip'"),
            "TS normalizeHistoryBlocks must match the 'control_chip' history tag"
        );
        assert!(
            ts.contains("type: 'chip'"),
            "TS normalizeHistoryBlocks must map control_chip to the chip view-model (type: 'chip')"
        );
    }

    #[test]
    fn last_session_model_resolves_the_session_start_model_ignoring_a_later_switch() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "proj");
        write_session(
            &dir,
            "s1",
            &[
                r#"{"type":"system","subtype":"init","model":"claude-opus-4-8"}"#,
                r#"{"type":"assistant","message":{"model":"claude-fable-5"}}"#,
            ],
        );
        assert_eq!(
            last_session_model_impl(tmp.path(), "proj", |_| true),
            Some("claude-opus-4-8".to_string())
        );
    }

    #[test]
    fn last_session_model_uses_the_first_assistant_model_when_no_init_is_persisted() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "proj");
        write_session(
            &dir,
            "s1",
            &[
                r#"{"type":"assistant","message":{"model":"claude-opus-4-8"}}"#,
                r#"{"type":"assistant","message":{"model":"claude-sonnet-5"}}"#,
            ],
        );
        assert_eq!(
            last_session_model_impl(tmp.path(), "proj", |_| true),
            Some("claude-opus-4-8".to_string())
        );
    }

    #[test]
    fn last_session_model_none_for_missing_dir_or_empty_transcripts() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(last_session_model_impl(tmp.path(), "proj", |_| true), None);
        let dir = setup_sessions_dir(tmp.path(), "proj");
        write_session(&dir, "s1", &[r#"{"type":"result"}"#]);
        assert_eq!(last_session_model_impl(tmp.path(), "proj", |_| true), None);
    }

    fn set_session_mtime(dir: &Path, session_id: &str, secs_ago: u64) {
        let path = dir.join(format!("{session_id}.jsonl"));
        let f = fs::File::options().write(true).open(path).unwrap();
        f.set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(secs_ago))
            .unwrap();
    }

    #[test]
    fn last_session_model_walks_past_a_model_less_newest_transcript() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "proj");
        write_session(
            &dir,
            "old-real",
            &[r#"{"type":"system","subtype":"init","model":"claude-opus-4-8"}"#],
        );
        write_session(
            &dir,
            "new-garbage",
            &[r#"{"type":"queue-operation","operation":"enqueue","content":"/"}"#],
        );
        set_session_mtime(&dir, "old-real", 60);
        set_session_mtime(&dir, "new-garbage", 1);
        assert_eq!(
            last_session_model_impl(tmp.path(), "proj", |_| true),
            Some("claude-opus-4-8".to_string())
        );
    }

    #[test]
    fn last_session_model_walks_past_a_predicate_rejected_model() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "proj");
        write_session(
            &dir,
            "old-claude",
            &[r#"{"type":"system","subtype":"init","model":"claude-sonnet-5"}"#],
        );
        write_session(
            &dir,
            "new-foreign",
            &[r#"{"type":"assistant","message":{"model":"unsloth/qwen-x"}}"#],
        );
        set_session_mtime(&dir, "old-claude", 60);
        set_session_mtime(&dir, "new-foreign", 1);
        assert_eq!(
            last_session_model_impl(tmp.path(), "proj", |m| m.starts_with("claude-")),
            Some("claude-sonnet-5".to_string())
        );
        assert_eq!(
            last_session_model_impl(tmp.path(), "proj", |_| true),
            Some("unsloth/qwen-x".to_string())
        );
    }

    #[test]
    fn last_session_model_scan_is_capped() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "proj");
        write_session(
            &dir,
            "beyond-cap",
            &[r#"{"type":"system","subtype":"init","model":"claude-opus-4-8"}"#],
        );
        set_session_mtime(&dir, "beyond-cap", 10_000);
        for i in 0..LAST_SESSION_MODEL_SCAN_CAP {
            let id = format!("garbage-{i}");
            write_session(&dir, &id, &[r#"{"type":"result"}"#]);
            set_session_mtime(&dir, &id, 100 + i as u64);
        }
        assert_eq!(last_session_model_impl(tmp.path(), "proj", |_| true), None);
    }

    #[test]
    fn last_session_model_skips_the_synthetic_control_reply_model() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = setup_sessions_dir(tmp.path(), "proj");
        write_session(
            &dir,
            "s1",
            &[
                r#"{"type":"system","subtype":"init","model":"claude-fable-5"}"#,
                r#"{"type":"assistant","message":{"model":"<synthetic>"}}"#,
            ],
        );
        assert_eq!(
            last_session_model_impl(tmp.path(), "proj", |_| true),
            Some("claude-fable-5".to_string())
        );
    }
}
