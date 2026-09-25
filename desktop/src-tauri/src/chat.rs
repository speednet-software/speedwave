use crate::control_channel::{
    self, ControlChannel, ControlHandle, ControlQuery, SessionInfoEvent, SessionInfoState,
};
use crate::history;
use crate::pii_display::DisplayPolicy;
use speedwave_runtime::stream::{
    AskUserOption, AskUserQuestionItem, MAX_ASK_USER_QUESTIONS, MAX_ASK_USER_WIRE_BYTES,
};
use speedwave_runtime::{config, consts, runtime};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Stdio};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(tag = "chunk_type", content = "data")]
pub enum StreamChunk {
    Text {
        content: String,
    },
    Thinking {
        content: String,
    },
    ToolStart {
        tool_id: String,
        tool_name: String,
    },
    ToolInputDelta {
        tool_id: String,
        partial_json: String,
    },
    ToolInputComplete {
        tool_id: String,
        input_json: String,
    },
    ToolResult {
        tool_id: String,
        content: String,
        is_error: bool,
    },
    Result {
        session_id: String,
        total_cost: Option<f64>,
        usage: Option<Box<UsageInfo>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        result_text: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        context_window_size: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        assistant_uuid: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        turn_usage: Option<TurnUsage>,
        #[serde(skip_serializing_if = "Option::is_none")]
        turn_cost: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        model: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        context_usage: Option<TurnUsage>,
    },
    AskUserQuestion {
        tool_id: String,
        questions: Vec<AskUserQuestionItem>,
        current_index: usize,
    },
    Error {
        content: String,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        turn_ended: bool,
    },
    SystemInit {
        model: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        session_id: Option<String>,
    },
    RateLimit {
        status: String,
        rate_limit_type: Option<String>,
        utilization_percent: Option<f64>,
        resets_at: Option<u64>,
        overage_status: Option<String>,
        is_using_overage: Option<bool>,
    },
    UserMessageCommit {
        uuid: String,
    },
    ControlChip {
        command: String,
        argument: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        uuid: Option<String>,
    },
    QueueDrained {
        session_id: String,
        text: String,
    },
}

pub(crate) fn sanitize_chunk(chunk: StreamChunk) -> StreamChunk {
    use speedwave_runtime::log_sanitizer::sanitize;
    match chunk {
        StreamChunk::Text { content } => StreamChunk::Text {
            content: sanitize(&content),
        },
        StreamChunk::Thinking { content } => StreamChunk::Thinking {
            content: sanitize(&content),
        },
        StreamChunk::ToolResult {
            tool_id,
            content,
            is_error,
        } => StreamChunk::ToolResult {
            tool_id,
            content: sanitize(&content),
            is_error,
        },
        StreamChunk::Error {
            content,
            turn_ended,
        } => StreamChunk::Error {
            content: sanitize(&content),
            turn_ended,
        },
        StreamChunk::Result {
            result_text: Some(text),
            session_id,
            total_cost,
            usage,
            context_window_size,
            assistant_uuid,
            turn_usage,
            turn_cost,
            model,
            context_usage,
        } => StreamChunk::Result {
            result_text: Some(sanitize(&text)),
            session_id,
            total_cost,
            usage,
            context_window_size,
            assistant_uuid,
            turn_usage,
            turn_cost,
            model,
            context_usage,
        },
        StreamChunk::QueueDrained { session_id, text } => StreamChunk::QueueDrained {
            session_id,
            text: sanitize(&text),
        },
        StreamChunk::AskUserQuestion {
            tool_id,
            mut questions,
            current_index,
        } => {
            for q in &mut questions {
                q.question = sanitize(&q.question);
                q.header = sanitize(&q.header);
                for opt in &mut q.options {
                    opt.label = sanitize(&opt.label);
                    opt.value = sanitize(&opt.value);
                }
            }
            StreamChunk::AskUserQuestion {
                tool_id,
                questions,
                current_index,
            }
        }
        other => other,
    }
}

fn detokenize_chunk(chunk: StreamChunk, policy: &DisplayPolicy) -> StreamChunk {
    if policy.is_noop() {
        return chunk;
    }
    use crate::pii_display::detokenize_for_display as detok;
    match chunk {
        StreamChunk::Text { content } => StreamChunk::Text {
            content: detok(policy, &content),
        },
        StreamChunk::Thinking { content } => StreamChunk::Thinking {
            content: detok(policy, &content),
        },
        StreamChunk::ToolResult {
            tool_id,
            content,
            is_error,
        } => StreamChunk::ToolResult {
            tool_id,
            content: detok(policy, &content),
            is_error,
        },
        StreamChunk::Error {
            content,
            turn_ended,
        } => StreamChunk::Error {
            content: detok(policy, &content),
            turn_ended,
        },
        StreamChunk::Result {
            result_text: Some(text),
            session_id,
            total_cost,
            usage,
            context_window_size,
            assistant_uuid,
            turn_usage,
            turn_cost,
            model,
            context_usage,
        } => StreamChunk::Result {
            result_text: Some(detok(policy, &text)),
            session_id,
            total_cost,
            usage,
            context_window_size,
            assistant_uuid,
            turn_usage,
            turn_cost,
            model,
            context_usage,
        },
        StreamChunk::QueueDrained { session_id, text } => StreamChunk::QueueDrained {
            session_id,
            text: detok(policy, &text),
        },
        StreamChunk::AskUserQuestion {
            tool_id,
            mut questions,
            current_index,
        } => {
            for q in &mut questions {
                q.question = detok(policy, &q.question);
                q.header = detok(policy, &q.header);
                for opt in &mut q.options {
                    opt.label = detok(policy, &opt.label);
                    opt.value = detok(policy, &opt.value);
                }
            }
            StreamChunk::AskUserQuestion {
                tool_id,
                questions,
                current_index,
            }
        }
        other => other,
    }
}

fn emit_sanitized_chunk(app_handle: &tauri::AppHandle, chunk: StreamChunk, policy: &DisplayPolicy) {
    let chunk = detokenize_chunk(chunk, policy);
    if let Err(e) = app_handle.emit("chat_stream", sanitize_chunk(chunk)) {
        log::warn!("failed to emit chat_stream event: {e}");
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct UsageInfo {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: Option<u64>,
    pub cache_write_tokens: Option<u64>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct TurnUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
}

impl TurnUsage {
    pub fn from_usage_info(usage: &UsageInfo) -> Self {
        Self {
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            cache_read_tokens: usage.cache_read_tokens.unwrap_or(0),
            cache_write_tokens: usage.cache_write_tokens.unwrap_or(0),
        }
    }

    pub fn delta(current: &Self, previous: &Self) -> Self {
        Self {
            input_tokens: current.input_tokens.saturating_sub(previous.input_tokens),
            output_tokens: current.output_tokens.saturating_sub(previous.output_tokens),
            cache_read_tokens: current
                .cache_read_tokens
                .saturating_sub(previous.cache_read_tokens),
            cache_write_tokens: current
                .cache_write_tokens
                .saturating_sub(previous.cache_write_tokens),
        }
    }
}

pub(crate) const USAGE_INPUT_TOKENS: &str = "input_tokens";
pub(crate) const USAGE_OUTPUT_TOKENS: &str = "output_tokens";
pub(crate) const USAGE_CACHE_READ_TOKENS: &str = "cache_read_input_tokens";
pub(crate) const USAGE_CACHE_WRITE_TOKENS: &str = "cache_creation_input_tokens";
pub(crate) const USAGE_CACHE_READ_TOKENS_LEGACY: &str = "cache_read_tokens";
pub(crate) const USAGE_CACHE_WRITE_TOKENS_LEGACY: &str = "cache_write_tokens";

pub(crate) fn is_sidechain_event(parsed: &serde_json::Value) -> bool {
    !parsed["parent_tool_use_id"].is_null() || parsed["isSidechain"].as_bool() == Some(true)
}

pub(crate) fn turn_usage_from_jsonl(usage: &serde_json::Value) -> Option<TurnUsage> {
    let obj = usage.as_object()?;
    let read = |k: &str| obj.get(k).and_then(serde_json::Value::as_u64).unwrap_or(0);
    Some(TurnUsage {
        input_tokens: read(USAGE_INPUT_TOKENS),
        output_tokens: read(USAGE_OUTPUT_TOKENS),
        cache_read_tokens: read(USAGE_CACHE_READ_TOKENS),
        cache_write_tokens: read(USAGE_CACHE_WRITE_TOKENS),
    })
}

const ASK_USER_TOOL_NAME: &str = "AskUserQuestion";

const CTRL_SUBTYPE_INTERRUPT: &str = "interrupt";

#[derive(Debug, Clone)]
pub struct ControlRequest {
    pub request_id: String,
    pub tool_name: String,
    pub input: serde_json::Value,
    pub tool_use_id: String,
}

#[derive(Debug, Clone)]
pub struct PartialAnswers {
    pub request: ControlRequest,
    pub questions: Vec<AskUserQuestionItem>,
    pub answers: Vec<Option<String>>,
}

impl PartialAnswers {
    pub fn new(request: ControlRequest, questions: Vec<AskUserQuestionItem>) -> Self {
        let answers = vec![None; questions.len()];
        Self {
            request,
            questions,
            answers,
        }
    }
}

type PendingRequests = Arc<Mutex<HashMap<String, PartialAnswers>>>;

#[derive(Debug)]
enum FillOutcome {
    Pending,
    Completed(PartialAnswers),
}

fn validate_slot(
    entry: &PartialAnswers,
    question_idx: usize,
    tool_use_id: &str,
) -> anyhow::Result<()> {
    if question_idx >= entry.questions.len() {
        anyhow::bail!("invalid question index {question_idx} for tool_use_id: {tool_use_id}");
    }
    let slot = entry.answers.get(question_idx).ok_or_else(|| {
        anyhow::anyhow!("answers/questions length mismatch for tool_use_id: {tool_use_id}")
    })?;
    if slot.is_some() {
        anyhow::bail!("question {question_idx} already answered for tool_use_id: {tool_use_id}");
    }
    Ok(())
}

pub const MAX_MESSAGE_LEN: usize = 1_000_000;

pub const MAX_ASK_USER_ANSWER_LEN: usize = 12 * 1024;

pub struct LogEntry {
    pub prefix: &'static str,
    pub message: String,
}

fn option_to_vec(
    (chunk, log): (Option<StreamChunk>, Option<LogEntry>),
) -> (Vec<StreamChunk>, Option<LogEntry>) {
    (chunk.map(|c| vec![c]).unwrap_or_default(), log)
}

pub struct StreamParser {
    active_blocks: HashMap<u64, (String, String)>,
    pending_assistant_uuid: Option<String>,
    committed_user_uuids: std::collections::HashSet<String>,
    previous_session_usage: TurnUsage,
    last_context_usage: Option<TurnUsage>,
    previous_session_cost: Option<f64>,
    model_tracker: crate::session_model::SessionModelTracker,
    seen_unknown_types: std::collections::HashSet<String>,
}

const MAX_TRACKED_UNKNOWN_TYPES: usize = 32;

impl StreamParser {
    pub fn new() -> Self {
        Self {
            active_blocks: HashMap::new(),
            pending_assistant_uuid: None,
            committed_user_uuids: std::collections::HashSet::new(),
            previous_session_usage: TurnUsage::default(),
            last_context_usage: None,
            previous_session_cost: None,
            model_tracker: crate::session_model::SessionModelTracker::default(),
            seen_unknown_types: std::collections::HashSet::new(),
        }
    }

    pub fn restore_session_snapshot(
        &mut self,
        usage: TurnUsage,
        total_cost: Option<f64>,
        model: Option<String>,
        context_usage: Option<TurnUsage>,
    ) {
        self.previous_session_usage = usage;
        self.previous_session_cost = total_cost;
        if let Some(m) = model.as_deref() {
            self.model_tracker.observe_init(m);
        }
        self.last_context_usage = context_usage;
    }

    #[cfg(test)]
    pub fn previous_session_usage(&self) -> TurnUsage {
        self.previous_session_usage
    }

    pub fn parse_line(
        &mut self,
        parsed: &serde_json::Value,
    ) -> (Vec<StreamChunk>, Option<LogEntry>) {
        let msg_type = parsed["type"].as_str().unwrap_or("");

        match msg_type {
            "stream_event" => option_to_vec(self.parse_stream_event(&parsed["event"])),
            "user" => self.parse_user_message(parsed),
            "result" => option_to_vec(self.parse_result(parsed)),
            "assistant" => {
                self.capture_assistant_uuid(parsed);
                self.capture_assistant_model(parsed);
                self.capture_context_usage(parsed);
                (Self::complete_tool_inputs(parsed), None)
            }
            "system" => option_to_vec(self.parse_system_message(parsed)),
            "rate_limit_event" => option_to_vec(Self::parse_rate_limit_event(parsed)),
            other => {
                let label = if other.is_empty() { "<none>" } else { other };
                if self.seen_unknown_types.len() < MAX_TRACKED_UNKNOWN_TYPES
                    && self.seen_unknown_types.insert(label.to_string())
                {
                    log::debug!("ignored unknown stream-json type '{label}'");
                    return (
                        Vec::new(),
                        Some(LogEntry {
                            prefix: "STREAM",
                            message: format!(
                                "unknown stream-json type '{label}' ignored (logged once per session)"
                            ),
                        }),
                    );
                }
                (Vec::new(), None)
            }
        }
    }

    fn capture_assistant_uuid(&mut self, parsed: &serde_json::Value) {
        if let Some(id) = parsed["message"]["id"].as_str() {
            if !id.is_empty() {
                self.pending_assistant_uuid = Some(id.to_string());
            }
        }
    }

    fn capture_assistant_model(&mut self, parsed: &serde_json::Value) {
        if is_sidechain_event(parsed) {
            return;
        }
        if let Some(model) = parsed["message"]["model"].as_str() {
            self.model_tracker.observe_assistant(model);
        }
    }

    fn capture_context_usage(&mut self, parsed: &serde_json::Value) {
        if is_sidechain_event(parsed) {
            return;
        }
        if let Some(u) = turn_usage_from_jsonl(&parsed["message"]["usage"]) {
            if u != TurnUsage::default() {
                self.last_context_usage = Some(u);
            }
        }
    }

    fn complete_tool_inputs(parsed: &serde_json::Value) -> Vec<StreamChunk> {
        if is_sidechain_event(parsed) {
            return Vec::new();
        }
        let Some(blocks) = parsed["message"]["content"].as_array() else {
            return Vec::new();
        };
        blocks
            .iter()
            .filter(|b| b["type"].as_str() == Some("tool_use"))
            .filter(|b| b["name"].as_str() != Some(ASK_USER_TOOL_NAME))
            .filter_map(|b| {
                let id = b["id"].as_str().filter(|s| !s.is_empty())?;
                let input = &b["input"];
                input.is_object().then(|| StreamChunk::ToolInputComplete {
                    tool_id: id.to_string(),
                    input_json: input.to_string(),
                })
            })
            .collect()
    }

    pub fn reset(&mut self) {
        self.active_blocks.clear();
    }

    #[cfg(test)]
    pub fn new_session(&mut self) {
        self.reset();
        self.pending_assistant_uuid = None;
        self.previous_session_usage = TurnUsage::default();
        self.last_context_usage = None;
        self.previous_session_cost = None;
        self.model_tracker = crate::session_model::SessionModelTracker::default();
        self.seen_unknown_types.clear();
    }

    pub fn try_parse_control_request(parsed: &serde_json::Value) -> Option<ControlRequest> {
        if parsed["type"].as_str() != Some("control_request") {
            return None;
        }
        let request_id = parsed["request_id"].as_str()?.to_string();
        let request = &parsed["request"];
        let tool_name = request["tool_name"].as_str()?.to_string();
        let input = request["input"].clone();
        let tool_use_id = request["tool_use_id"].as_str()?.to_string();
        Some(ControlRequest {
            request_id,
            tool_name,
            input,
            tool_use_id,
        })
    }

    fn parse_ask_user_question(v: &serde_json::Value) -> Option<AskUserQuestionItem> {
        let question = v["question"].as_str().unwrap_or("").to_string();
        let header = v["header"].as_str().unwrap_or("").to_string();
        let multi_select = v["multiSelect"].as_bool().unwrap_or(false);
        let options: Vec<AskUserOption> = v["options"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|opt| {
                        let label = opt["label"].as_str()?.to_string();
                        let value = opt["value"].as_str().unwrap_or(&label).to_string();
                        Some(AskUserOption { label, value })
                    })
                    .collect()
            })
            .unwrap_or_default();
        if question.trim().is_empty() {
            log::warn!(
                "dropping AskUserQuestion entry with empty question text \
                 (header_present={}, options={})",
                !header.is_empty(),
                options.len()
            );
            return None;
        }
        Some(AskUserQuestionItem {
            question,
            header,
            options,
            multi_select,
        })
    }

    pub fn parse_ask_user_questions(req: &ControlRequest) -> Vec<AskUserQuestionItem> {
        let parsed = &req.input;

        let raw_questions: Vec<serde_json::Value> =
            if let Some(arr) = parsed["questions"].as_array() {
                arr.clone()
            } else {
                vec![parsed.clone()]
            };

        let total = raw_questions.len();
        let bounded = if total > MAX_ASK_USER_QUESTIONS {
            log::warn!(
                "received {} AskUserQuestion questions, truncating to {}",
                total,
                MAX_ASK_USER_QUESTIONS
            );
            &raw_questions[..MAX_ASK_USER_QUESTIONS]
        } else {
            &raw_questions[..]
        };

        bounded
            .iter()
            .filter_map(Self::parse_ask_user_question)
            .collect()
    }

    #[cfg(test)]
    pub fn emit_ask_user_from_control_request(req: &ControlRequest) -> Option<StreamChunk> {
        let questions = Self::parse_ask_user_questions(req);
        if questions.is_empty() {
            log::warn!("AskUserQuestion 'questions' array is empty after parsing");
            return None;
        }
        Some(StreamChunk::AskUserQuestion {
            tool_id: req.tool_use_id.clone(),
            questions,
            current_index: 0,
        })
    }

    fn parse_stream_event(
        &mut self,
        event: &serde_json::Value,
    ) -> (Option<StreamChunk>, Option<LogEntry>) {
        let event_type = event["type"].as_str().unwrap_or("");

        match event_type {
            "content_block_start" => {
                let index = match event["index"].as_u64() {
                    Some(i) => i,
                    None => return (None, None),
                };
                let block = &event["content_block"];
                let block_type = block["type"].as_str().unwrap_or("");

                match block_type {
                    "tool_use" => {
                        let id = match block["id"].as_str() {
                            Some(s) if !s.is_empty() => s.to_string(),
                            _ => {
                                log::warn!("content_block_start tool_use block missing 'id' field");
                                return (None, None);
                            }
                        };
                        let name = match block["name"].as_str() {
                            Some(s) if !s.is_empty() => s.to_string(),
                            _ => {
                                log::warn!(
                                    "content_block_start tool_use block missing 'name' field"
                                );
                                return (None, None);
                            }
                        };
                        let log_entry = Some(LogEntry {
                            prefix: "TOOL",
                            message: format!("start: {} ({})", name, id),
                        });
                        self.active_blocks.insert(index, (id.clone(), name.clone()));
                        if name == ASK_USER_TOOL_NAME {
                            (None, log_entry)
                        } else {
                            (
                                Some(StreamChunk::ToolStart {
                                    tool_id: id,
                                    tool_name: name,
                                }),
                                log_entry,
                            )
                        }
                    }
                    "thinking" => (
                        Some(StreamChunk::Thinking {
                            content: String::new(),
                        }),
                        None,
                    ),
                    _ => (None, None),
                }
            }

            "content_block_delta" => {
                let delta = &event["delta"];
                let delta_type = delta["type"].as_str().unwrap_or("");

                match delta_type {
                    "text_delta" => {
                        let text = match delta["text"].as_str() {
                            Some(t) => t,
                            None => return (None, None),
                        };
                        (
                            Some(StreamChunk::Text {
                                content: text.to_string(),
                            }),
                            None,
                        )
                    }
                    "thinking_delta" => {
                        let thinking = match delta["thinking"].as_str() {
                            Some(t) => t,
                            None => return (None, None),
                        };
                        (
                            Some(StreamChunk::Thinking {
                                content: thinking.to_string(),
                            }),
                            None,
                        )
                    }
                    "input_json_delta" => {
                        let index = match event["index"].as_u64() {
                            Some(i) => i,
                            None => return (None, None),
                        };
                        let partial = match delta["partial_json"].as_str() {
                            Some(p) => p,
                            None => return (None, None),
                        };
                        let (tool_id, tool_name) = match self.active_blocks.get(&index) {
                            Some(t) => t,
                            None => return (None, None),
                        };
                        if tool_name == ASK_USER_TOOL_NAME {
                            (None, None)
                        } else {
                            (
                                Some(StreamChunk::ToolInputDelta {
                                    tool_id: tool_id.clone(),
                                    partial_json: partial.to_string(),
                                }),
                                None,
                            )
                        }
                    }
                    _ => (None, None),
                }
            }

            "content_block_stop" => {
                if let Some(index) = event["index"].as_u64() {
                    if let Some((tool_id, tool_name)) = self.active_blocks.remove(&index) {
                        let log_entry = Some(LogEntry {
                            prefix: "TOOL",
                            message: format!("stop: {} ({})", tool_name, tool_id),
                        });
                        return (None, log_entry);
                    }
                }
                (None, None)
            }

            "message_start" | "message_stop" => {
                self.reset();
                (None, None)
            }

            _ => (None, None),
        }
    }

    fn parse_user_message(
        &mut self,
        parsed: &serde_json::Value,
    ) -> (Vec<StreamChunk>, Option<LogEntry>) {
        let message = &parsed["message"];
        let content = &message["content"];
        let blocks = match content.as_array() {
            Some(b) => b,
            None => return (Vec::new(), None),
        };

        let mut has_text = false;
        let mut has_tool_result = false;
        for block in blocks {
            match block["type"].as_str().unwrap_or("") {
                "text" => has_text = true,
                "tool_result" => has_tool_result = true,
                _ => {}
            }
        }

        if has_text && !has_tool_result {
            if let Some(id) = message["id"].as_str() {
                if !id.is_empty() && !self.committed_user_uuids.contains(id) {
                    self.committed_user_uuids.insert(id.to_string());
                    return (
                        vec![StreamChunk::UserMessageCommit {
                            uuid: id.to_string(),
                        }],
                        Some(LogEntry {
                            prefix: "USER",
                            message: format!("commit uuid={id}"),
                        }),
                    );
                }
            }
        }

        let mut chunks = Vec::new();
        let mut log_lines = Vec::new();
        for block in blocks {
            let block_type = block["type"].as_str().unwrap_or("");
            if block_type != "tool_result" {
                continue;
            }
            let tool_use_id = match block["tool_use_id"].as_str() {
                Some(s) if !s.is_empty() => s.to_string(),
                _ => {
                    log::warn!("user message tool_result block missing 'tool_use_id'");
                    continue;
                }
            };
            let is_error = block["is_error"].as_bool().unwrap_or(false);

            let result_content = if let Some(s) = block["content"].as_str() {
                s.to_string()
            } else if let Some(arr) = block["content"].as_array() {
                arr.iter()
                    .filter_map(|b| {
                        if b["type"].as_str() == Some("text") {
                            b["text"].as_str().map(String::from)
                        } else {
                            None
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            } else {
                String::new()
            };

            log_lines.push(format!("result: {} error={}", tool_use_id, is_error));
            chunks.push(StreamChunk::ToolResult {
                tool_id: tool_use_id,
                content: result_content,
                is_error,
            });
        }
        let log_entry = (!log_lines.is_empty()).then(|| LogEntry {
            prefix: "TOOL",
            message: log_lines.join("; "),
        });
        (chunks, log_entry)
    }

    fn parse_result(
        &mut self,
        parsed: &serde_json::Value,
    ) -> (Option<StreamChunk>, Option<LogEntry>) {
        let assistant_uuid = self.pending_assistant_uuid.take();

        let is_error = parsed["is_error"].as_bool().unwrap_or(false);

        if is_error {
            let result_text = parsed["result"].as_str().unwrap_or("");
            let error_text = if result_text.trim().is_empty() {
                log::warn!(
                    "result message has is_error=true but empty result text; \
                     returning placeholder error chunk"
                );
                log::debug!("empty-error result payload: {parsed}");
                "The LLM returned an error without details. \
                     Check the provider server logs or try a different model."
                    .to_string()
            } else {
                log::warn!("turn ended with an API error: {result_text}");
                result_text.to_string()
            };
            let log_message = format!("error: {error_text}");
            return (
                Some(StreamChunk::Error {
                    content: error_text,
                    turn_ended: true,
                }),
                Some(LogEntry {
                    prefix: "RESULT",
                    message: log_message,
                }),
            );
        }

        let session_id = parsed["session_id"].as_str().unwrap_or("").to_string();
        if session_id.is_empty() {
            log::warn!("result message missing 'session_id'");
        }

        let total_cost = parsed["total_cost_usd"]
            .as_f64()
            .or_else(|| parsed["total_cost"].as_f64());

        let model_usage = parsed["modelUsage"].as_object();

        let model = self
            .model_tracker
            .resolve()
            .map(str::to_string)
            .or_else(|| dominant_model_by_output_tokens(model_usage));
        if self.model_tracker.resolve().is_none() {
            if let Some(m) = model.as_deref() {
                self.model_tracker.observe_assistant(m);
            }
        }

        let context_window_size = model
            .as_deref()
            .and_then(|m| model_usage.and_then(|mu| mu.get(m)))
            .and_then(|stats| stats["contextWindow"].as_u64());

        let usage = if parsed["usage"].is_object() {
            let u = &parsed["usage"];
            Some(Box::new(UsageInfo {
                input_tokens: u[USAGE_INPUT_TOKENS].as_u64().unwrap_or(0),
                output_tokens: u[USAGE_OUTPUT_TOKENS].as_u64().unwrap_or(0),
                cache_read_tokens: u[USAGE_CACHE_READ_TOKENS]
                    .as_u64()
                    .or_else(|| u[USAGE_CACHE_READ_TOKENS_LEGACY].as_u64()),
                cache_write_tokens: u[USAGE_CACHE_WRITE_TOKENS]
                    .as_u64()
                    .or_else(|| u[USAGE_CACHE_WRITE_TOKENS_LEGACY].as_u64()),
            }))
        } else {
            None
        };

        let turn_usage = compute_turn_usage_from_result(
            parsed,
            usage.as_deref(),
            &mut self.previous_session_usage,
        );

        let turn_cost = match (total_cost, self.previous_session_cost) {
            (Some(current), Some(prev)) if current >= prev => Some(current - prev),
            (Some(current), None) => Some(current),
            _ => None,
        };
        if let Some(t) = total_cost {
            self.previous_session_cost = Some(t);
        }

        let result_text = parsed["result"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .map(String::from);

        let log_entry = Some(LogEntry {
            prefix: "RESULT",
            message: "turn complete".to_string(),
        });

        (
            Some(StreamChunk::Result {
                session_id,
                total_cost,
                usage,
                result_text,
                context_window_size,
                assistant_uuid,
                turn_usage,
                turn_cost,
                model,
                context_usage: self.last_context_usage,
            }),
            log_entry,
        )
    }

    fn parse_rate_limit_event(
        parsed: &serde_json::Value,
    ) -> (Option<StreamChunk>, Option<LogEntry>) {
        let info = &parsed["rate_limit_info"];
        let status = info["status"].as_str().unwrap_or("unknown").to_string();
        let rate_limit_type = info["rateLimitType"].as_str().map(str::to_string);
        let utilization_percent = info["utilization"]
            .as_f64()
            .and_then(utilization_fraction_to_percent);
        let resets_at = info["resetsAt"]
            .as_u64()
            .or_else(|| info["resets_at"].as_u64());
        let overage_status = info["overageStatus"].as_str().map(str::to_string);
        let is_using_overage = info["isUsingOverage"].as_bool();

        let log_entry = Some(LogEntry {
            prefix: "RATE_LIMIT",
            message: format!(
                "status={status} type={} utilization={} resets_at={} overage={}",
                rate_limit_type.as_deref().unwrap_or("none"),
                utilization_percent.map_or("none".to_string(), |v| format!("{v:.0}%")),
                resets_at.map_or("none".to_string(), |v| v.to_string()),
                overage_status.as_deref().unwrap_or("none"),
            ),
        });

        (
            Some(StreamChunk::RateLimit {
                status,
                rate_limit_type,
                utilization_percent,
                resets_at,
                overage_status,
                is_using_overage,
            }),
            log_entry,
        )
    }

    const ACTIONABLE_PATTERNS: &'static [&'static str] = &[
        "hit your limit",
        "rate limit",
        "quota exceeded",
        "context length",
        "maximum length",
        "billing",
        "Error:",
    ];

    fn parse_system_message(
        &mut self,
        parsed: &serde_json::Value,
    ) -> (Option<StreamChunk>, Option<LogEntry>) {
        if parsed["subtype"].as_str() == Some("init") {
            let session_id = parsed["session_id"]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(String::from);
            if let Some(model) = parsed["model"].as_str() {
                if !model.is_empty() {
                    self.model_tracker.observe_init(model);
                    let log_entry = Some(LogEntry {
                        prefix: "SYSTEM",
                        message: format!("init: model={model}"),
                    });
                    return (
                        Some(StreamChunk::SystemInit {
                            model: model.to_string(),
                            session_id,
                        }),
                        log_entry,
                    );
                }
            }
            if session_id.is_some() {
                return (
                    Some(StreamChunk::SystemInit {
                        model: String::new(),
                        session_id,
                    }),
                    Some(LogEntry {
                        prefix: "SYSTEM",
                        message: "init".to_string(),
                    }),
                );
            }
        }

        let message = parsed["message"]
            .as_str()
            .or_else(|| parsed["content"].as_str())
            .unwrap_or("");

        if message.is_empty() {
            return (None, None);
        }

        let log_entry = Some(LogEntry {
            prefix: "SYSTEM",
            message: message.to_string(),
        });

        let is_actionable = Self::ACTIONABLE_PATTERNS
            .iter()
            .any(|p| message.contains(p));

        if is_actionable {
            (
                Some(StreamChunk::Error {
                    content: message.to_string(),
                    turn_ended: false,
                }),
                log_entry,
            )
        } else {
            (None, log_entry)
        }
    }
}

fn utilization_fraction_to_percent(fraction: f64) -> Option<f64> {
    if (0.0..=1.0).contains(&fraction) {
        Some(fraction * 100.0)
    } else {
        log::debug!("ignored a rate_limit_event utilization outside the 0-1 fraction: {fraction}");
        None
    }
}

fn compute_turn_usage_from_result(
    parsed: &serde_json::Value,
    flat: Option<&UsageInfo>,
    snapshot: &mut TurnUsage,
) -> Option<TurnUsage> {
    if let Some(u) = flat {
        let delta = TurnUsage::from_usage_info(u);
        snapshot.input_tokens = snapshot.input_tokens.saturating_add(delta.input_tokens);
        snapshot.output_tokens = snapshot.output_tokens.saturating_add(delta.output_tokens);
        snapshot.cache_read_tokens = snapshot
            .cache_read_tokens
            .saturating_add(delta.cache_read_tokens);
        snapshot.cache_write_tokens = snapshot
            .cache_write_tokens
            .saturating_add(delta.cache_write_tokens);
        return Some(delta);
    }
    let cumulative = extract_cumulative_usage(parsed)?;
    let delta = TurnUsage::delta(&cumulative, snapshot);
    *snapshot = cumulative;
    Some(delta)
}

fn extract_cumulative_usage(parsed: &serde_json::Value) -> Option<TurnUsage> {
    let model_usage = parsed["modelUsage"].as_object()?;
    if model_usage.is_empty() {
        return None;
    }
    let mut total = TurnUsage::default();
    let mut any_field = false;
    for stats in model_usage.values() {
        for (key, target) in [
            ("inputTokens", &mut total.input_tokens),
            ("outputTokens", &mut total.output_tokens),
            ("cacheReadInputTokens", &mut total.cache_read_tokens),
            ("cacheCreationInputTokens", &mut total.cache_write_tokens),
        ] {
            if let Some(n) = stats[key].as_u64() {
                *target = target.saturating_add(n);
                any_field = true;
            }
        }
    }
    if any_field {
        Some(total)
    } else {
        None
    }
}

fn dominant_model_by_output_tokens(
    model_usage: Option<&serde_json::Map<String, serde_json::Value>>,
) -> Option<String> {
    model_usage.and_then(|mu| {
        mu.iter()
            .max_by_key(|(_, stats)| stats["outputTokens"].as_u64().unwrap_or(0))
            .map(|(k, _)| k.clone())
    })
}

pub const MAX_WIRE_BYTES: usize = 1024 * 1024;

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WireContentBlock {
    Text { text: String },
}

pub fn text_only(text: impl Into<String>) -> Vec<WireContentBlock> {
    vec![WireContentBlock::Text { text: text.into() }]
}

pub fn is_blank_or_slash_only(blocks: &[WireContentBlock]) -> bool {
    let joined: String = blocks
        .iter()
        .map(|WireContentBlock::Text { text }| text.as_str())
        .collect();
    joined.trim().is_empty() || speedwave_runtime::slash::is_bare_slash(&joined)
}

pub fn build_user_message(blocks: &[WireContentBlock]) -> serde_json::Value {
    serde_json::json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": blocks,
        }
    })
}

fn soft_impose_target(
    kind: speedwave_runtime::config::LlmProviderKind,
    entry_id: &str,
    entry_model: Option<&str>,
    observed_model: &str,
) -> Option<String> {
    if kind.is_anthropic() {
        return None;
    }
    let model = entry_model?;
    let expected = speedwave_runtime::model_id::wire_model_id(kind, entry_id, model);
    let observed = speedwave_runtime::model_id::normalize_observed(observed_model, entry_id);
    if observed == speedwave_runtime::model_id::normalize_observed(&expected, entry_id) {
        return None;
    }
    Some(expected)
}

struct SoftImposeConfig {
    kind: speedwave_runtime::config::LlmProviderKind,
    entry_id: String,
    entry_model: Option<String>,
}

#[derive(Clone, Default)]
struct ModelSettled(Arc<std::sync::atomic::AtomicBool>);

impl ModelSettled {
    fn settle(&self) {
        self.0.store(true, std::sync::atomic::Ordering::SeqCst);
    }

    fn is_settled(&self) -> bool {
        self.0.load(std::sync::atomic::Ordering::SeqCst)
    }
}

fn settles_model(text: &str) -> bool {
    matches!(
        speedwave_runtime::slash::parse_control_command(text),
        Some(("model", _))
    )
}

fn soft_impose_step(
    line: &serde_json::Value,
    chunks: &[StreamChunk],
    cfg: &SoftImposeConfig,
    settled: &ModelSettled,
    control: &ControlChannel,
    stdin: &Mutex<impl Write>,
) -> Option<(control_channel::PendingControl, String)> {
    if !chunks
        .iter()
        .any(|c| matches!(c, StreamChunk::SystemInit { .. }))
    {
        return None;
    }
    let observed = line["model"].as_str().filter(|s| !s.is_empty())?;
    let model = soft_impose_target(
        cfg.kind,
        &cfg.entry_id,
        cfg.entry_model.as_deref(),
        observed,
    )?;
    let pending = send_soft_impose(stdin, control, settled, &model)?;
    Some((pending, model))
}

fn send_soft_impose(
    stdin: &Mutex<impl Write>,
    control: &ControlChannel,
    settled: &ModelSettled,
    model: &str,
) -> Option<control_channel::PendingControl> {
    let Ok(mut handle) = stdin.lock() else {
        log::error!("stdin mutex poisoned; dropping the soft-impose");
        return None;
    };
    if settled.is_settled() {
        return None;
    }
    settled.settle();
    match control.send_set_model(&mut *handle, model) {
        Ok(pending) => {
            log::info!("soft-imposing {model} with a set_model control request");
            Some(pending)
        }
        Err(e) => {
            log::error!("the soft-impose set_model request was not written: {e}");
            None
        }
    }
}

pub(crate) struct ModelSwitch {
    control: ControlChannel,
    stdin: Arc<Mutex<std::process::ChildStdin>>,
    settled: ModelSettled,
}

impl ModelSwitch {
    pub(crate) fn apply(&self, model: &str) -> Result<(), control_channel::ControlError> {
        send_model_pick(&self.stdin, &self.control, &self.settled, model)?
            .wait(control_channel::SET_MODEL_TIMEOUT)
            .map(|_| ())
    }
}

fn send_model_pick(
    stdin: &Mutex<impl Write>,
    control: &ControlChannel,
    settled: &ModelSettled,
    model: &str,
) -> Result<control_channel::PendingControl, control_channel::ControlError> {
    let mut handle = stdin
        .lock()
        .map_err(|e| control_channel::ControlError::Write(format!("stdin lock poisoned: {e}")))?;
    settled.settle();
    control.send_set_model(&mut *handle, model)
}

fn report_soft_impose(pending: control_channel::PendingControl, model: &str) {
    match pending.wait(control_channel::SET_MODEL_TIMEOUT) {
        Ok(_) => log::info!("Claude Code switched the session to {model}"),
        Err(e) => log::warn!("the soft-impose to {model} did not apply: {e}"),
    }
}

pub fn build_auto_approve_response(request: &ControlRequest) -> serde_json::Value {
    serde_json::json!({
        "type": "control_response",
        "response": {
            "subtype": "success",
            "request_id": request.request_id,
            "response": {
                "behavior": "allow",
                "updatedInput": request.input
            }
        }
    })
}

fn build_ask_user_response_multi(partial: &PartialAnswers) -> anyhow::Result<serde_json::Value> {
    let mut updated_input = partial.request.input.clone();
    let mut answers = serde_json::Map::with_capacity(partial.questions.len());
    let mut seen_keys: std::collections::HashSet<&str> = std::collections::HashSet::new();
    for (q, slot) in partial.questions.iter().zip(partial.answers.iter()) {
        let value = slot.as_deref().unwrap_or("");
        let key = q.question.as_str();
        if !seen_keys.insert(key) {
            log::warn!(
                "AskUserQuestion request has duplicate question text — \
                 refusing to emit lossy answers map"
            );
            anyhow::bail!(
                "AskUserQuestion request contained duplicate question text — \
                 cannot build a complete answers map (refer to log for count)"
            );
        }
        answers.insert(
            key.to_string(),
            serde_json::Value::String(value.to_string()),
        );
    }
    updated_input["answers"] = serde_json::Value::Object(answers);

    Ok(serde_json::json!({
        "type": "control_response",
        "response": {
            "subtype": "success",
            "request_id": partial.request.request_id,
            "response": {
                "behavior": "allow",
                "updatedInput": updated_input
            }
        }
    }))
}

pub fn validate_retry_uuid(uuid: &str) -> anyhow::Result<()> {
    if uuid.is_empty() {
        anyhow::bail!("retry uuid must not be empty");
    }
    if uuid.len() > 128 {
        anyhow::bail!("retry uuid too long (max 128 chars)");
    }
    for ch in uuid.chars() {
        if !(ch.is_ascii_alphanumeric() || ch == '_' || ch == '-') {
            anyhow::bail!("retry uuid contains invalid character: {ch:?}");
        }
    }
    Ok(())
}

fn launch_effort_level(
    user_config: &config::SpeedwaveUserConfig,
    project_name: &str,
) -> Option<String> {
    user_config
        .find_project(project_name)
        .and_then(|p| p.effort_pin.clone())
        .filter(|l| speedwave_runtime::defaults::EFFORT_LEVELS.contains(&l.as_str()))
}

pub fn build_claude_args(
    instance_id: &str,
    resume_session_id: Option<&str>,
    resume_at_uuid: Option<&str>,
    flags: &[String],
) -> Vec<String> {
    let mut args = speedwave_runtime::session::instance_env_argv(instance_id);
    args.extend([
        consts::CLAUDE_BINARY.to_string(),
        "-p".to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--input-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
        "--include-partial-messages".to_string(),
        "--permission-prompt-tool".to_string(),
        "stdio".to_string(),
    ]);

    if let Some(id) = resume_session_id {
        args.push("--resume".to_string());
        args.push(id.to_string());
    }

    if let Some(uuid) = resume_at_uuid {
        args.push("--resume-session-at".to_string());
        args.push(uuid.to_string());
    }

    for flag in flags {
        args.push(flag.clone());
    }

    args
}

pub fn claude_container_name(project: &str) -> String {
    claude_container_name_with_prefix(consts::compose_prefix(), project)
}

fn claude_container_name_with_prefix(prefix: &str, project: &str) -> String {
    format!("{prefix}_{project}_claude")
}

fn reap_exec_plan(project: &str, id: &str) -> (String, Vec<String>) {
    (
        claude_container_name(project),
        speedwave_runtime::session::kill_by_instance_command(id),
    )
}

fn build_interrupt_payload(request_id: &str) -> serde_json::Value {
    serde_json::json!({
        "type": control_channel::MSG_TYPE_CONTROL_REQUEST,
        "request_id": request_id,
        "request": { "subtype": CTRL_SUBTYPE_INTERRUPT },
    })
}

fn next_interrupt_request_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    format!("req_interrupt_{}", COUNTER.fetch_add(1, Ordering::Relaxed))
}

fn write_interrupt<W: Write>(w: &mut W, payload: &serde_json::Value) -> anyhow::Result<()> {
    writeln!(w, "{}", payload)?;
    w.flush()?;
    Ok(())
}

fn consume_control_response(control: &ControlChannel, parsed: &serde_json::Value) -> bool {
    if parsed["type"].as_str() != Some(control_channel::MSG_TYPE_CONTROL_RESPONSE) {
        return false;
    }
    control.route_response(parsed);
    true
}

fn emit_session_info(app_handle: &AppHandle, project: &str, status: SessionInfoState) {
    let event = SessionInfoEvent {
        project: project.to_string(),
        status,
    };
    if let Err(e) = app_handle.emit(control_channel::SESSION_INFO_EVENT, event) {
        log::warn!("failed to emit the chat session info event: {e}");
    }
}

fn probe_session_info(
    query: impl FnOnce() -> Result<serde_json::Value, control_channel::ControlError>,
    slot: &Mutex<SessionInfoState>,
    stopping: &std::sync::atomic::AtomicBool,
) -> Option<SessionInfoState> {
    let status = control_channel::session_info_state_from(query());
    if stopping.load(std::sync::atomic::Ordering::SeqCst) {
        return None;
    }
    *slot
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = status.clone();
    Some(status)
}

#[derive(Clone)]
struct AwaitedResult(Arc<std::sync::atomic::AtomicBool>);

impl AwaitedResult {
    fn new() -> Self {
        Self(Arc::new(std::sync::atomic::AtomicBool::new(true)))
    }

    fn observe(&self, chunks: &[StreamChunk]) {
        if chunks
            .iter()
            .any(|c| matches!(c, StreamChunk::Result { .. } | StreamChunk::Error { .. }))
        {
            self.0.store(false, std::sync::atomic::Ordering::SeqCst);
        } else if !chunks.is_empty() {
            self.0.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }

    fn message_written(&self) {
        self.0.store(true, std::sync::atomic::Ordering::SeqCst);
    }

    fn is_awaited(&self) -> bool {
        self.0.load(std::sync::atomic::Ordering::SeqCst)
    }
}

#[derive(Debug)]
pub struct PreparedSpawn {
    pub args: Vec<String>,
    pub container: String,
}

pub struct ChatSession {
    child: Option<Child>,
    project_name: String,
    shared_stdin: Option<Arc<Mutex<std::process::ChildStdin>>>,
    pending_requests: PendingRequests,
    control: ControlChannel,
    session_info: Arc<Mutex<SessionInfoState>>,
    drain_handles: Vec<std::thread::JoinHandle<()>>,
    session_log_path: Option<std::path::PathBuf>,
    instance_id: Option<String>,
    stopping: Arc<std::sync::atomic::AtomicBool>,
    awaited_result: AwaitedResult,
    model_settled: ModelSettled,
}

impl ChatSession {
    pub fn new(project_name: &str) -> Self {
        Self {
            child: None,
            project_name: project_name.to_string(),
            shared_stdin: None,
            pending_requests: Arc::new(Mutex::new(HashMap::new())),
            control: ControlChannel::default(),
            session_info: Arc::new(Mutex::new(SessionInfoState::Unavailable)),
            drain_handles: Vec::new(),
            session_log_path: None,
            instance_id: None,
            stopping: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            awaited_result: AwaitedResult::new(),
            model_settled: ModelSettled::default(),
        }
    }

    pub fn project_name(&self) -> &str {
        &self.project_name
    }

    pub(crate) fn control_handle(&self) -> anyhow::Result<ControlHandle> {
        let stdin = self
            .shared_stdin
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("no active session"))?;
        Ok(ControlHandle::new(self.control.clone(), stdin.clone()))
    }

    pub(crate) fn model_switch(&self) -> anyhow::Result<ModelSwitch> {
        let stdin = self
            .shared_stdin
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("no active session"))?;
        Ok(ModelSwitch {
            control: self.control.clone(),
            stdin: stdin.clone(),
            settled: self.model_settled.clone(),
        })
    }

    pub(crate) fn session_info_state(&self) -> SessionInfoState {
        self.session_info
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    pub fn prepare_args(
        project_name: &str,
        user_config: &config::SpeedwaveUserConfig,
        instance_id: &str,
        resume_session_id: Option<&str>,
        resume_at_uuid: Option<&str>,
    ) -> anyhow::Result<PreparedSpawn> {
        if let Some(id) = resume_session_id {
            history::validate_session_id(id)?;
        }
        if let Some(uuid) = resume_at_uuid {
            validate_retry_uuid(uuid)?;
        }

        let project_dir = std::path::PathBuf::from(&user_config.require_project(project_name)?.dir);

        let resolved = config::resolve_claude_config(&project_dir, user_config, project_name);

        let mut flags = resolved.flags.clone();
        if let Some(level) = launch_effort_level(user_config, project_name) {
            flags.push("--effort".to_string());
            flags.push(level);
        }

        let args = build_claude_args(instance_id, resume_session_id, resume_at_uuid, &flags);
        let container = claude_container_name(project_name);

        #[cfg(feature = "e2e")]
        crate::e2e_support::record_spawn_args(&args);

        Ok(PreparedSpawn { args, container })
    }

    pub fn start(
        &mut self,
        app_handle: AppHandle,
        resume_session_id: Option<&str>,
    ) -> anyhow::Result<()> {
        self.start_with_retry(app_handle, resume_session_id, None)
    }

    pub fn start_with_retry(
        &mut self,
        app_handle: AppHandle,
        resume_session_id: Option<&str>,
        resume_at_uuid: Option<&str>,
    ) -> anyhow::Result<()> {
        let rt = runtime::detect_runtime();
        crate::pin_cmd::ensure_effort_pin_migrated_in(
            speedwave_runtime::consts::data_dir(),
            &self.project_name,
        )
        .map_err(|e| anyhow::anyhow!(e))?;
        let user_config = config::load_user_config()?;

        self.reap_instance();

        let instance_id = speedwave_runtime::session::new_instance_id();
        let PreparedSpawn { args, container } = Self::prepare_args(
            &self.project_name,
            &user_config,
            &instance_id,
            resume_session_id,
            resume_at_uuid,
        )?;

        let soft_impose_cfg = {
            let project_dir =
                std::path::PathBuf::from(&user_config.require_project(&self.project_name)?.dir);
            let resolved =
                config::resolve_claude_config(&project_dir, &user_config, &self.project_name);
            match resolved.llm.active_provider() {
                Some(entry) => SoftImposeConfig {
                    kind: entry.kind,
                    entry_id: entry.id.clone(),
                    entry_model: entry.model.clone(),
                },
                None => SoftImposeConfig {
                    kind: config::LlmProviderKind::AnthropicOauth,
                    entry_id: config::ANTHROPIC_PROVIDER_ID.to_string(),
                    entry_model: None,
                },
            }
        };

        let provider_kind = soft_impose_cfg.kind;
        let asks_claude_code_for_session_info = provider_kind.is_anthropic();

        let mut cmd = rt.container_exec_piped(
            &container,
            &args.iter().map(|s| s.as_str()).collect::<Vec<_>>(),
        )?;

        let mut child = cmd
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;

        self.instance_id = Some(instance_id);
        self.stopping
            .store(false, std::sync::atomic::Ordering::SeqCst);

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow::anyhow!("Failed to capture stdout from child process"))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow::anyhow!("Failed to capture stdin from child process"))?;
        let shared_stdin = Arc::new(Mutex::new(stdin));
        self.shared_stdin = Some(shared_stdin.clone());
        self.control = ControlChannel::default();
        self.session_info = Arc::new(Mutex::new(if asks_claude_code_for_session_info {
            SessionInfoState::Pending
        } else {
            SessionInfoState::Unavailable
        }));
        let session_info_probe = asks_claude_code_for_session_info.then(|| {
            (
                app_handle.clone(),
                ControlHandle::new(self.control.clone(), shared_stdin.clone()),
            )
        });

        let session_log_path = {
            let path = consts::claude_session_log_path(&self.project_name);
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            speedwave_runtime::log_file::truncate_if_oversized(&path, 2 * 1024 * 1024);
            let mut f = speedwave_runtime::log_file::open_log_file(&path);
            speedwave_runtime::log_file::write_log_line(&mut f, "SESSION", "started");
            Some(path)
        };
        self.session_log_path = session_log_path.clone();

        let stderr_log_path = session_log_path.clone();
        if let Some(stderr) = child.stderr.take() {
            let h = std::thread::spawn(move || {
                let mut log_file = stderr_log_path
                    .as_deref()
                    .and_then(speedwave_runtime::log_file::open_log_file);
                let reader = BufReader::new(stderr);
                for line in reader.lines() {
                    match line {
                        Ok(l) => {
                            log::debug!("{l}");
                            speedwave_runtime::log_file::write_log_line(
                                &mut log_file,
                                "STDERR",
                                &l,
                            );
                        }
                        Err(e) => {
                            log::warn!("stderr reader I/O error: {e}");
                            break;
                        }
                    }
                }
            });
            self.drain_handles.push(h);
        }

        let pending_requests = self.pending_requests.clone();
        let control_for_reader = self.control.clone();
        let stdin_for_reader = shared_stdin;
        let stdout_log_path = session_log_path;
        let stopping_for_reader = self.stopping.clone();
        self.awaited_result = AwaitedResult::new();
        let awaited_for_reader = self.awaited_result.clone();
        self.model_settled = ModelSettled::default();
        let settled_for_reader = self.model_settled.clone();

        let display_policy =
            crate::pii_display::load_display_policy(consts::data_dir(), &self.project_name);

        let resume_seed = resume_session_id.and_then(|id| {
            match history::compute_resume_snapshot(&self.project_name, id) {
                Ok(s) => Some(s),
                Err(e) => {
                    log::warn!("resume snapshot for session {id} unavailable: {e}");
                    None
                }
            }
        });

        let h = std::thread::spawn(move || {
            let mut parser = StreamParser::new();
            if let Some(seed) = resume_seed {
                parser.restore_session_snapshot(
                    TurnUsage {
                        input_tokens: seed.input_tokens,
                        output_tokens: seed.output_tokens,
                        cache_read_tokens: seed.cache_read_tokens,
                        cache_write_tokens: seed.cache_write_tokens,
                    },
                    seed.total_cost,
                    seed.model,
                    seed.context_usage,
                );
            }
            let mut log_file = stdout_log_path
                .as_deref()
                .and_then(speedwave_runtime::log_file::open_log_file);
            let reader = BufReader::new(stdout);
            let mut http_collator = speedwave_runtime::http_debug_collator::Collator::new();
            for line in reader.lines() {
                let line = match line {
                    Ok(l) => l,
                    Err(e) => {
                        log::warn!("stdout reader I/O error: {e}");
                        break;
                    }
                };

                let parsed = match serde_json::from_str::<serde_json::Value>(&line) {
                    Ok(v) => v,
                    Err(_) => {
                        for entry in http_collator.push(line) {
                            speedwave_runtime::log_file::write_log_line(
                                &mut log_file,
                                "STDOUT",
                                &entry,
                            );
                        }
                        continue;
                    }
                };

                let msg_type = parsed["type"].as_str().unwrap_or("");

                if consume_control_response(&control_for_reader, &parsed) {
                    continue;
                }

                if let Some(ctrl) = StreamParser::try_parse_control_request(&parsed) {
                    speedwave_runtime::log_file::write_log_line(
                        &mut log_file,
                        "CONTROL",
                        &format!("request: {} ({})", ctrl.tool_name, ctrl.tool_use_id),
                    );
                    if ctrl.tool_name == ASK_USER_TOOL_NAME {
                        let questions = StreamParser::parse_ask_user_questions(&ctrl);
                        if questions.is_empty() {
                            log::warn!(
                                "AskUserQuestion control_request had no usable questions; dropping"
                            );
                            continue;
                        }
                        match pending_requests.lock() {
                            Ok(mut map) => {
                                map.insert(
                                    ctrl.tool_use_id.clone(),
                                    PartialAnswers::new(ctrl.clone(), questions.clone()),
                                );
                            }
                            Err(e) => {
                                log::error!(
                                    "pending_requests mutex poisoned: {e}; dropping stream"
                                );
                                emit_sanitized_chunk(
                                    &app_handle,
                                    StreamChunk::Error {
                                        content: "Internal error: pending_requests lock poisoned"
                                            .to_string(),
                                        turn_ended: false,
                                    },
                                    &display_policy,
                                );
                                break;
                            }
                        }
                        emit_sanitized_chunk(
                            &app_handle,
                            StreamChunk::AskUserQuestion {
                                tool_id: ctrl.tool_use_id.clone(),
                                questions,
                                current_index: 0,
                            },
                            &display_policy,
                        );
                    } else {
                        let response = build_auto_approve_response(&ctrl);
                        match stdin_for_reader.lock() {
                            Ok(mut stdin) => {
                                if let Err(e) = writeln!(stdin, "{}", response) {
                                    log::error!(
                                        "auto-approve stdin write failed: {e}; dropping stream"
                                    );
                                    emit_sanitized_chunk(
                                        &app_handle,
                                        StreamChunk::Error {
                                            content: format!(
                                                "Failed to write auto-approve to stdin: {e}"
                                            ),
                                            turn_ended: false,
                                        },
                                        &display_policy,
                                    );
                                    break;
                                }
                                if let Err(e) = stdin.flush() {
                                    log::error!(
                                        "auto-approve stdin flush failed: {e}; dropping stream"
                                    );
                                    emit_sanitized_chunk(
                                        &app_handle,
                                        StreamChunk::Error {
                                            content: format!(
                                                "Failed to flush auto-approve to stdin: {e}"
                                            ),
                                            turn_ended: false,
                                        },
                                        &display_policy,
                                    );
                                    break;
                                }
                            }
                            Err(e) => {
                                log::error!("stdin mutex poisoned: {e}; dropping stream");
                                emit_sanitized_chunk(
                                    &app_handle,
                                    StreamChunk::Error {
                                        content: "Internal error: stdin lock poisoned".to_string(),
                                        turn_ended: false,
                                    },
                                    &display_policy,
                                );
                                break;
                            }
                        }
                    }
                    continue;
                }

                if msg_type == "control_request" {
                    log::warn!(
                        "unrecognized control_request shape; not auto-responding (turn may stall)"
                    );
                    speedwave_runtime::log_file::write_log_line(
                        &mut log_file,
                        "CONTROL",
                        "unrecognized control_request shape (missing request_id/tool_name/tool_use_id); not auto-responding",
                    );
                    continue;
                }

                let (chunks, log_entry) = parser.parse_line(&parsed);
                if let Some(entry) = log_entry {
                    speedwave_runtime::log_file::write_log_line(
                        &mut log_file,
                        entry.prefix,
                        &entry.message,
                    );
                    if matches!(entry.prefix, "RESULT" | "SYSTEM" | "SESSION" | "RATE_LIMIT") {
                        for merged in http_collator.flush_all_pending_responses() {
                            speedwave_runtime::log_file::write_log_line(
                                &mut log_file,
                                "STDOUT",
                                &merged,
                            );
                        }
                    }
                }
                if let Some((pending, model)) = soft_impose_step(
                    &parsed,
                    &chunks,
                    &soft_impose_cfg,
                    &settled_for_reader,
                    &control_for_reader,
                    &stdin_for_reader,
                ) {
                    std::thread::spawn(move || report_soft_impose(pending, &model));
                }
                let result_session_id = chunks.iter().find_map(|c| match c {
                    StreamChunk::Result { session_id, .. } => Some(session_id.clone()),
                    _ => None,
                });
                awaited_for_reader.observe(&chunks);
                for chunk in chunks {
                    emit_sanitized_chunk(&app_handle, chunk, &display_policy);
                }
                if let Some(session_id) = result_session_id {
                    if drain_queued_message(
                        &app_handle,
                        &session_id,
                        &stdin_for_reader,
                        &settled_for_reader,
                        &display_policy,
                    ) {
                        awaited_for_reader.message_written();
                    }
                }
            }

            if let Some(entry) = http_collator.flush() {
                speedwave_runtime::log_file::write_log_line(&mut log_file, "STDOUT", &entry);
            }
            control_for_reader.close();

            let stopping = stopping_for_reader.load(std::sync::atomic::Ordering::SeqCst);
            if awaited_for_reader.is_awaited() && !stopping {
                log::warn!("stdout reader stream ended without result");
                let chunk = StreamChunk::Error {
                    content:
                        "Claude session ended unexpectedly. Check the session log for details."
                            .to_string(),
                    turn_ended: false,
                };
                emit_sanitized_chunk(&app_handle, chunk, &display_policy);
            }
        });
        self.drain_handles.push(h);

        if let Some((probe_app_handle, handle)) = session_info_probe {
            let project = self.project_name.clone();
            let slot = self.session_info.clone();
            let stopping = self.stopping.clone();
            emit_session_info(&probe_app_handle, &project, SessionInfoState::Pending);
            let h = std::thread::spawn(move || {
                let status =
                    probe_session_info(|| handle.query(ControlQuery::Initialize), &slot, &stopping);
                if let Some(status) = status {
                    let info = match &status {
                        SessionInfoState::Ready { info } => Some(info),
                        SessionInfoState::Pending | SessionInfoState::Unavailable => None,
                    };
                    crate::model_picker::normalize_pin_for_session(
                        consts::data_dir(),
                        &project,
                        provider_kind,
                        info,
                    );
                    emit_session_info(&probe_app_handle, &project, status);
                }
            });
            self.drain_handles.push(h);
        }

        self.child = Some(child);
        Ok(())
    }

    pub fn send_message(
        &mut self,
        app_handle: &tauri::AppHandle,
        blocks: &[WireContentBlock],
    ) -> anyhow::Result<()> {
        let display_policy =
            crate::pii_display::load_display_policy(consts::data_dir(), &self.project_name);
        self.send_message_with_emit(blocks, |chunk| {
            emit_sanitized_chunk(app_handle, chunk, &display_policy)
        })
    }

    fn send_message_with_emit(
        &mut self,
        blocks: &[WireContentBlock],
        mut emit: impl FnMut(StreamChunk),
    ) -> anyhow::Result<()> {
        if is_blank_or_slash_only(blocks) {
            anyhow::bail!("empty message");
        }

        let child = self
            .child
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("no active session"))?;

        if let Some(status) = child.try_wait()? {
            self.child = None;
            if speedwave_runtime::resources::is_oom_exit(&status) {
                anyhow::bail!("{}", speedwave_runtime::resources::OOM_MESSAGE);
            }
            anyhow::bail!("session exited ({})", status);
        }

        let shared = self
            .shared_stdin
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("no active session"))?;
        let input = build_user_message(blocks);
        let serialized = input.to_string();
        if serialized.len() > MAX_WIRE_BYTES {
            anyhow::bail!(
                "user message too large: {} bytes exceeds {} byte limit",
                serialized.len(),
                MAX_WIRE_BYTES
            );
        }

        log::info!(
            "sending user message: serialized={} bytes, blocks={}",
            serialized.len(),
            blocks.len()
        );
        let mut stdin = shared
            .lock()
            .map_err(|e| anyhow::anyhow!("stdin lock poisoned: {e}"))?;
        if matches!(blocks, [WireContentBlock::Text { text }] if settles_model(text)) {
            self.model_settled.settle();
        }
        writeln!(stdin, "{}", serialized)?;
        stdin.flush()?;
        drop(stdin);
        self.awaited_result.message_written();

        if let [WireContentBlock::Text { text }] = blocks {
            if let Some((command, argument)) = speedwave_runtime::slash::parse_control_command(text)
            {
                emit(StreamChunk::ControlChip {
                    command: command.to_string(),
                    argument: argument.to_string(),
                    uuid: None,
                });
            }
        }
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn set_test_stdin_sink(&mut self, buf: Vec<u8>) {
        self.shared_stdin = Some(Arc::new(Mutex::new(test_pipe_stdin(buf))));
        self.child = Some(spawn_test_child());
    }

    #[cfg(test)]
    fn set_test_stdin_capture(&mut self) -> std::thread::JoinHandle<Vec<u8>> {
        let (stdin, capture) = test_capturing_stdin();
        self.shared_stdin = Some(Arc::new(Mutex::new(stdin)));
        self.child = Some(spawn_test_child());
        capture
    }

    #[cfg(test)]
    pub(crate) fn control_channel_for_test(&self) -> ControlChannel {
        self.control.clone()
    }

    #[cfg(test)]
    fn set_test_stdin_broken_pipe(&mut self) {
        self.shared_stdin = Some(Arc::new(Mutex::new(test_broken_pipe_stdin())));
        self.child = Some(spawn_test_child());
    }

    pub fn submit_question_answer(
        &mut self,
        tool_use_id: &str,
        question_idx: usize,
        answer: &str,
    ) -> anyhow::Result<()> {
        if answer.len() > MAX_ASK_USER_ANSWER_LEN {
            anyhow::bail!("answer too long (max {} bytes)", MAX_ASK_USER_ANSWER_LEN);
        }

        let child = self
            .child
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("no active session"))?;

        if let Some(status) = child.try_wait()? {
            self.child = None;
            if speedwave_runtime::resources::is_oom_exit(&status) {
                anyhow::bail!("{}", speedwave_runtime::resources::OOM_MESSAGE);
            }
            anyhow::bail!("session exited ({})", status);
        }

        let partial = match self.fill_slot(tool_use_id, question_idx, answer)? {
            FillOutcome::Pending => return Ok(()),
            FillOutcome::Completed(p) => p,
        };

        let response = match build_ask_user_response_multi(&partial) {
            Ok(v) => v,
            Err(e) => {
                self.restore_partial(tool_use_id, &partial, Some(question_idx));
                return Err(e);
            }
        };
        let serialized = serde_json::to_string(&response).map_err(|e| {
            self.restore_partial(tool_use_id, &partial, Some(question_idx));
            anyhow::anyhow!("failed to serialize AskUserQuestion response: {e}")
        })?;
        if serialized.len() > MAX_ASK_USER_WIRE_BYTES {
            self.restore_partial(tool_use_id, &partial, Some(question_idx));
            anyhow::bail!(
                "AskUserQuestion response exceeds {} byte cap (got {})",
                MAX_ASK_USER_WIRE_BYTES,
                serialized.len()
            );
        }

        let shared = self
            .shared_stdin
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("no active session"))?;
        let mut stdin = shared
            .lock()
            .map_err(|e| anyhow::anyhow!("stdin lock poisoned: {e}"))?;

        if let Err(e) = writeln!(stdin, "{}", serialized).and_then(|_| stdin.flush()) {
            log::error!(
                "failed to write answer for {} (tool_use_id={tool_use_id}): {e}",
                partial.request.tool_name
            );
            drop(stdin);
            self.restore_partial(tool_use_id, &partial, Some(question_idx));
            return Err(anyhow::anyhow!("failed to write answer to stdin: {e}"));
        }

        Ok(())
    }

    fn fill_slot(
        &self,
        tool_use_id: &str,
        question_idx: usize,
        answer: &str,
    ) -> anyhow::Result<FillOutcome> {
        let mut map = self
            .pending_requests
            .lock()
            .map_err(|e| anyhow::anyhow!("pending_requests lock poisoned: {e}"))?;
        let mut entry = map.remove(tool_use_id).ok_or_else(|| {
            anyhow::anyhow!("no pending control request for tool_use_id: {tool_use_id}")
        })?;
        let result = validate_slot(&entry, question_idx, tool_use_id);
        if let Err(e) = result {
            map.insert(tool_use_id.to_string(), entry);
            return Err(e);
        }
        entry.answers[question_idx] = Some(answer.to_string());
        if entry.answers.iter().any(|a| a.is_none()) {
            map.insert(tool_use_id.to_string(), entry);
            return Ok(FillOutcome::Pending);
        }
        Ok(FillOutcome::Completed(entry))
    }

    fn restore_partial(
        &self,
        tool_use_id: &str,
        partial: &PartialAnswers,
        cleared_idx: Option<usize>,
    ) {
        match self.pending_requests.lock() {
            Ok(mut map) => {
                let mut to_insert = partial.clone();
                if let Some(idx) = cleared_idx {
                    if let Some(slot) = to_insert.answers.get_mut(idx) {
                        *slot = None;
                    }
                }
                map.insert(tool_use_id.to_string(), to_insert);
            }
            Err(poison_err) => {
                log::error!("failed to restore pending request: mutex poisoned: {poison_err}");
            }
        }
    }

    pub fn interrupt(&mut self) -> anyhow::Result<()> {
        if let Some(child) = self.child.as_mut() {
            if let Some(status) = child.try_wait()? {
                self.child = None;
                if speedwave_runtime::resources::is_oom_exit(&status) {
                    anyhow::bail!("{}", speedwave_runtime::resources::OOM_MESSAGE);
                }
                anyhow::bail!("session exited ({status})");
            }
        }
        let shared = self
            .shared_stdin
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("no active session"))?;
        let request_id = next_interrupt_request_id();
        let payload = build_interrupt_payload(&request_id);
        let mut stdin = shared
            .lock()
            .map_err(|e| anyhow::anyhow!("stdin lock poisoned: {e}"))?;
        if let Err(e) = write_interrupt(&mut *stdin, &payload) {
            log::error!("failed to write interrupt control_request (request_id={request_id}): {e}");
            return Err(e);
        }
        log::info!("interrupt control_request sent (request_id={request_id})");
        Ok(())
    }

    fn reap_instance(&mut self) {
        let Some(id) = self.instance_id.take() else {
            return;
        };
        let (container, argv) = reap_exec_plan(&self.project_name, &id);
        let rt = runtime::detect_runtime();
        let argv_refs: Vec<&str> = argv.iter().map(String::as_str).collect();
        match rt.container_exec_piped(&container, &argv_refs) {
            Ok(mut cmd) => {
                if let Err(e) = cmd.status() {
                    log::warn!("kill exec for orphaned instance failed: {e}");
                }
            }
            Err(e) => log::warn!("could not build kill exec for orphaned instance: {e}"),
        }
    }

    pub fn stop(&mut self) -> anyhow::Result<()> {
        self.stopping
            .store(true, std::sync::atomic::Ordering::SeqCst);
        self.shared_stdin = None;
        self.control.close();
        *self
            .session_info
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = SessionInfoState::Unavailable;
        self.reap_instance();
        if let Some(mut child) = self.child.take() {
            child.kill().ok();
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            loop {
                match child.try_wait() {
                    Ok(Some(_)) => break,
                    Ok(None) => {
                        if std::time::Instant::now() >= deadline {
                            log::warn!("child did not exit within 5s of stop, abandoning");
                            break;
                        }
                        std::thread::sleep(std::time::Duration::from_millis(50));
                    }
                    Err(e) => {
                        log::warn!("try_wait error during stop (treating as exited): {e}");
                        break;
                    }
                }
            }
        }
        const READER_GRACE_MS: u64 = 200;
        const READER_POLL_MS: u64 = 10;
        let reader_grace_deadline =
            std::time::Instant::now() + std::time::Duration::from_millis(READER_GRACE_MS);
        for handle in self.drain_handles.drain(..) {
            while !handle.is_finished() && std::time::Instant::now() < reader_grace_deadline {
                std::thread::sleep(std::time::Duration::from_millis(READER_POLL_MS));
            }
            let name = format!("{:?}", handle.thread().id());
            if !handle.is_finished() {
                log::warn!(
                    "reader thread {name} still running after {READER_GRACE_MS}ms grace \
                     on stop, detaching"
                );
                continue;
            }
            if let Err(e) = handle.join() {
                log::warn!("reader thread panicked during stop: {e:?}");
            }
        }
        if let Some(ref log_path) = self.session_log_path {
            let mut f = speedwave_runtime::log_file::open_log_file(log_path);
            speedwave_runtime::log_file::write_log_line(&mut f, "SESSION", "stopped");
        }
        self.session_log_path = None;
        if let Ok(mut map) = self.pending_requests.lock() {
            map.clear();
        }
        Ok(())
    }
}

impl Drop for ChatSession {
    fn drop(&mut self) {
        self.stop().ok();
    }
}

pub type SharedChatSession = Arc<Mutex<ChatSession>>;

fn drain_queued_message(
    app_handle: &AppHandle,
    session_id: &str,
    stdin: &Arc<Mutex<std::process::ChildStdin>>,
    settled: &ModelSettled,
    policy: &DisplayPolicy,
) -> bool {
    let queue = app_handle.state::<speedwave_runtime::session::QueuedMessageService>();
    let drained = match queue.take(session_id) {
        Some(m) => m,
        None => return false,
    };
    write_and_emit_drained_message(session_id, &drained.text, stdin, settled, |chunk| {
        emit_sanitized_chunk(app_handle, chunk, policy)
    })
}

fn write_and_emit_drained_message(
    session_id: &str,
    text: &str,
    stdin: &Arc<Mutex<std::process::ChildStdin>>,
    settled: &ModelSettled,
    mut emit: impl FnMut(StreamChunk),
) -> bool {
    let payload = build_user_message(&text_only(text));
    match stdin.lock() {
        Ok(mut handle) => {
            if settles_model(text) {
                settled.settle();
            }
            if let Err(e) = writeln!(handle, "{}", payload) {
                log::warn!("failed to write queued message to stdin: {e}");
                return false;
            }
            if let Err(e) = handle.flush() {
                log::warn!("failed to flush queued message to stdin: {e}");
                return false;
            }
        }
        Err(e) => {
            log::warn!("stdin lock poisoned while draining queued message: {e}");
            return false;
        }
    }
    if let Some((command, argument)) = speedwave_runtime::slash::parse_control_command(text) {
        emit(StreamChunk::ControlChip {
            command: command.to_string(),
            argument: argument.to_string(),
            uuid: None,
        });
    }
    emit(StreamChunk::QueueDrained {
        session_id: session_id.to_string(),
        text: text.to_string(),
    });
    log::debug!("queue drained: {} bytes for session", text.len());
    true
}

#[cfg(test)]
fn test_stdin_pipe() -> (std::io::PipeReader, std::process::ChildStdin) {
    let (reader, writer) = std::io::pipe().expect("create test stdin pipe");
    #[cfg(unix)]
    let stdin = std::process::ChildStdin::from(std::os::fd::OwnedFd::from(writer));
    #[cfg(windows)]
    let stdin = std::process::ChildStdin::from(std::os::windows::io::OwnedHandle::from(writer));
    (reader, stdin)
}

#[cfg(test)]
fn test_pipe_stdin(buf: Vec<u8>) -> std::process::ChildStdin {
    let (mut reader, stdin) = test_stdin_pipe();
    std::thread::spawn(move || {
        let mut drained = buf;
        let _ = std::io::Read::read_to_end(&mut reader, &mut drained);
    });
    stdin
}

#[cfg(test)]
fn test_capturing_stdin() -> (std::process::ChildStdin, std::thread::JoinHandle<Vec<u8>>) {
    let (mut reader, stdin) = test_stdin_pipe();
    let capture = std::thread::spawn(move || {
        let mut written = Vec::new();
        let _ = std::io::Read::read_to_end(&mut reader, &mut written);
        written
    });
    (stdin, capture)
}

#[cfg(test)]
fn test_broken_pipe_stdin() -> std::process::ChildStdin {
    let (reader, stdin) = test_stdin_pipe();
    drop(reader);
    stdin
}

#[cfg(test)]
fn spawn_test_child() -> Child {
    #[cfg(unix)]
    let mut command = {
        let mut c = std::process::Command::new("sh");
        c.arg("-c").arg("read line");
        c
    };
    #[cfg(windows)]
    let mut command = {
        let mut c = std::process::Command::new("cmd");
        c.arg("/C").arg("pause");
        c
    };
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn test child")
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "test assertions may unwrap/expect freely"
)]
mod tests {
    use super::*;

    #[test]
    fn chat_stream_emits_go_through_helper() {
        let src = include_str!("chat.rs");
        let prod = src.split("\nmod tests {").next().unwrap_or(src);
        let raw_emits = prod
            .lines()
            .filter(|l| {
                let t = l.trim_start();
                !t.starts_with("//") && t.contains("emit(\"chat_stream\"")
            })
            .count();
        assert_eq!(
            raw_emits, 1,
            "exactly one chat_stream emit allowed (inside emit_sanitized_chunk); \
             found {raw_emits} — a new raw emit bypasses sanitization"
        );
    }

    #[test]
    fn stdout_reader_never_resets_the_parser() {
        let src = include_str!("chat.rs");
        let prod = src.split("\nmod tests {").next().unwrap_or(src);
        let resets = prod
            .lines()
            .filter(|l| {
                let t = l.trim_start();
                !t.starts_with("//") && t.contains("parser.reset()")
            })
            .count();
        assert_eq!(
            resets, 0,
            "the stdout reader must not call parser.reset(); found {resets}"
        );
    }

    fn ts_chunk_type_tags(union_body: &str) -> Vec<String> {
        union_body
            .lines()
            .map(str::trim_start)
            .filter(|l| !l.starts_with("/*") && !l.starts_with('*') && !l.starts_with("//"))
            .flat_map(|l| {
                l.split("chunk_type: '")
                    .skip(1)
                    .filter_map(|s| s.split('\'').next())
                    .map(String::from)
                    .collect::<Vec<_>>()
            })
            .collect()
    }

    #[test]
    fn ts_chunk_type_tags_skips_comment_examples() {
        let body = "  | {\n      /** e.g. { chunk_type: 'Foo' } */\n      chunk_type: 'Bar';\n    }\n  | { chunk_type: 'Baz'; data: { x: string } };";
        assert_eq!(ts_chunk_type_tags(body), vec!["Bar", "Baz"]);
    }

    #[test]
    fn stream_chunk_variant_set_matches_ts_union() {
        let rust_src = include_str!("chat.rs");
        let start = rust_src
            .find("pub enum StreamChunk {")
            .expect("chat.rs must declare `pub enum StreamChunk`");
        let mut rust: Vec<String> = rust_src[start..]
            .lines()
            .skip(1)
            .take_while(|l| *l != "}")
            .filter(|l| l.starts_with("    ") && !l.starts_with("     "))
            .map(|l| l.trim())
            .filter(|l| !l.starts_with("//") && !l.starts_with('#'))
            .filter_map(|l| l.split(|c: char| !c.is_alphanumeric()).next())
            .filter(|s| !s.is_empty())
            .map(String::from)
            .collect();
        rust.sort();

        let ts_src = include_str!("../../src/src/app/models/chat.ts");
        let marker = "export type StreamChunk =";
        let idx = ts_src
            .find(marker)
            .expect("chat.ts must declare `export type StreamChunk`");
        let rest = &ts_src[idx + marker.len()..];
        let union = &rest[..rest.find("\nexport ").unwrap_or(rest.len())];
        let mut ts = ts_chunk_type_tags(union);
        ts.sort();

        assert_eq!(
            rust, ts,
            "TS StreamChunk union must mirror Rust StreamChunk variants"
        );
    }

    #[test]
    fn sanitize_chunk_redacts_ask_user_question() {
        use speedwave_runtime::stream::{AskUserOption, AskUserQuestionItem};
        let chunk = StreamChunk::AskUserQuestion {
            tool_id: "t1".into(),
            questions: vec![AskUserQuestionItem {
                question: "use sk-ant-abcdefabcdefabcdefabcdef?".into(),
                header: "key sk-ant-abcdefabcdefabcdefabcdef".into(),
                multi_select: false,
                options: vec![AskUserOption {
                    label: "Bearer ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
                    value: "MCP_X_AUTH_TOKEN=550e8400-e29b-41d4-a716-446655440000".into(),
                }],
            }],
            current_index: 0,
        };
        let out = format!("{:?}", sanitize_chunk(chunk));
        assert!(
            !out.contains("abcdefabcdefabcdefabcdef"),
            "question/header leaked: {out}"
        );
        assert!(!out.contains("ghp_aaaaaaaa"), "option label leaked: {out}");
        assert!(!out.contains("550e8400"), "option value leaked: {out}");
    }

    #[test]
    fn sanitize_chunk_redacts_text_and_thinking() {
        let secret = "MCP_SLACK_AUTH_TOKEN=550e8400-e29b-41d4-a716-446655440000";
        for chunk in [
            StreamChunk::Text {
                content: secret.into(),
            },
            StreamChunk::Thinking {
                content: secret.into(),
            },
            StreamChunk::Error {
                content: secret.into(),
                turn_ended: false,
            },
        ] {
            let out = format!("{:?}", sanitize_chunk(chunk));
            assert!(!out.contains("550e8400"), "secret leaked: {out}");
        }
    }

    #[test]
    fn sanitize_chunk_redacts_tool_result() {
        let chunk = StreamChunk::ToolResult {
            tool_id: "t1".into(),
            content: "key sk-ant-abcdefabcdefabcdefabcdef".into(),
            is_error: false,
        };
        let out = format!("{:?}", sanitize_chunk(chunk));
        assert!(!out.contains("abcdefabcdefabcdefabcdef"), "leaked: {out}");
    }

    #[test]
    fn sanitize_chunk_redacts_result_text() {
        let chunk = StreamChunk::Result {
            session_id: "s".into(),
            total_cost: None,
            usage: None,
            result_text: Some("token=sk-ant-secretsecretsecretsecret done".into()),
            context_window_size: None,
            assistant_uuid: None,
            turn_usage: None,
            turn_cost: None,
            model: None,
            context_usage: None,
        };
        let out = format!("{:?}", sanitize_chunk(chunk));
        assert!(!out.contains("secretsecretsecretsecret"), "leaked: {out}");
    }

    #[test]
    fn sanitize_chunk_leaves_tool_input_delta_untouched() {
        let raw = r#"{"path":"/x","token":"abc"#;
        let chunk = StreamChunk::ToolInputDelta {
            tool_id: "t1".into(),
            partial_json: raw.into(),
        };
        match sanitize_chunk(chunk) {
            StreamChunk::ToolInputDelta { partial_json, .. } => {
                assert_eq!(partial_json, raw, "partial_json must be byte-identical");
            }
            other => panic!("variant changed: {other:?}"),
        }
    }

    #[test]
    fn sanitize_chunk_leaves_tool_input_complete_untouched() {
        let raw = r#"{"path":"/x","token":"sk-ant-abcdefabcdefabcdefabcdef"}"#;
        let chunk = StreamChunk::ToolInputComplete {
            tool_id: "t1".into(),
            input_json: raw.into(),
        };
        match sanitize_chunk(chunk) {
            StreamChunk::ToolInputComplete { input_json, .. } => {
                assert_eq!(input_json, raw, "input_json must be byte-identical");
            }
            other => panic!("variant changed: {other:?}"),
        }
    }

    fn detok_test_key(tmp: &std::path::Path, project: &str) -> speedwave_pii_engine::EngineKey {
        speedwave_runtime::pii_key::ensure_project_key_in(tmp, project)
            .expect("ensure_project_key_in");
        crate::pii_display::load_display_key(tmp, project).expect("key must load")
    }

    fn tokenize_for_test(key: &speedwave_pii_engine::EngineKey, plain: &str) -> String {
        use speedwave_pii_engine::{compile_policy_v3, default_policy_json, scan_text};
        let policy = compile_policy_v3(&default_policy_json()).expect("policy compiles");
        scan_text(&policy, key, plain).expect("scan succeeds").text
    }

    fn key_policy(key: speedwave_pii_engine::EngineKey) -> DisplayPolicy {
        DisplayPolicy::new(Some(key), Vec::new())
    }

    #[test]
    fn detokenize_chunk_without_key_is_a_noop() {
        let tokenized = "[EMAIL:TOKEN_whatever]";
        let chunk = StreamChunk::Text {
            content: tokenized.to_string(),
        };
        match detokenize_chunk(chunk, &DisplayPolicy::default()) {
            StreamChunk::Text { content } => assert_eq!(content, tokenized),
            other => panic!("variant changed: {other:?}"),
        }
    }

    #[test]
    fn detokenize_chunk_resolves_text_content_with_key() {
        let tmp = tempfile::tempdir().unwrap();
        let key = detok_test_key(tmp.path(), "proj");
        let tokenized = tokenize_for_test(&key, "email me at jan@example.com");
        assert!(tokenized.contains("TOKEN_"), "fixture must tokenize");

        let chunk = StreamChunk::Text { content: tokenized };
        match detokenize_chunk(chunk, &key_policy(key)) {
            StreamChunk::Text { content } => {
                assert_eq!(content, "email me at jan@example.com");
            }
            other => panic!("variant changed: {other:?}"),
        }
    }

    #[test]
    fn detokenize_chunk_resolves_thinking_and_tool_result_and_error() {
        let tmp = tempfile::tempdir().unwrap();
        let key = detok_test_key(tmp.path(), "proj");
        let tokenized = tokenize_for_test(&key, "secret@example.com");

        let policy = key_policy(key);

        match detokenize_chunk(
            StreamChunk::Thinking {
                content: tokenized.clone(),
            },
            &policy,
        ) {
            StreamChunk::Thinking { content } => assert_eq!(content, "secret@example.com"),
            other => panic!("variant changed: {other:?}"),
        }

        match detokenize_chunk(
            StreamChunk::ToolResult {
                tool_id: "t1".into(),
                content: tokenized.clone(),
                is_error: false,
            },
            &policy,
        ) {
            StreamChunk::ToolResult { content, .. } => {
                assert_eq!(content, "secret@example.com");
            }
            other => panic!("variant changed: {other:?}"),
        }

        match detokenize_chunk(
            StreamChunk::Error {
                content: tokenized.clone(),
                turn_ended: true,
            },
            &policy,
        ) {
            StreamChunk::Error {
                content,
                turn_ended,
            } => {
                assert_eq!(content, "secret@example.com");
                assert!(turn_ended, "detokenizing must keep the turn-end marker");
            }
            other => panic!("variant changed: {other:?}"),
        }
    }

    #[test]
    fn detokenize_chunk_resolves_result_text_and_queue_drained() {
        let tmp = tempfile::tempdir().unwrap();
        let key = detok_test_key(tmp.path(), "proj");
        let tokenized = tokenize_for_test(&key, "reach me at jan@example.com");

        let policy = key_policy(key);

        let result_chunk = StreamChunk::Result {
            session_id: "s".into(),
            total_cost: None,
            usage: None,
            result_text: Some(tokenized.clone()),
            context_window_size: None,
            assistant_uuid: None,
            turn_usage: None,
            turn_cost: None,
            model: None,
            context_usage: None,
        };
        match detokenize_chunk(result_chunk, &policy) {
            StreamChunk::Result { result_text, .. } => {
                assert_eq!(result_text.as_deref(), Some("reach me at jan@example.com"));
            }
            other => panic!("variant changed: {other:?}"),
        }

        let queue_chunk = StreamChunk::QueueDrained {
            session_id: "s".into(),
            text: tokenized,
        };
        match detokenize_chunk(queue_chunk, &policy) {
            StreamChunk::QueueDrained { text, .. } => {
                assert_eq!(text, "reach me at jan@example.com");
            }
            other => panic!("variant changed: {other:?}"),
        }
    }

    #[test]
    fn detokenize_chunk_resolves_ask_user_question_fields() {
        use speedwave_runtime::stream::{AskUserOption, AskUserQuestionItem};
        let tmp = tempfile::tempdir().unwrap();
        let key = detok_test_key(tmp.path(), "proj");
        let tokenized = tokenize_for_test(&key, "jan@example.com");

        let chunk = StreamChunk::AskUserQuestion {
            tool_id: "t1".into(),
            questions: vec![AskUserQuestionItem {
                question: format!("confirm {tokenized}?"),
                header: tokenized.clone(),
                multi_select: false,
                options: vec![AskUserOption {
                    label: tokenized.clone(),
                    value: tokenized.clone(),
                }],
            }],
            current_index: 0,
        };
        match detokenize_chunk(chunk, &key_policy(key)) {
            StreamChunk::AskUserQuestion { questions, .. } => {
                assert_eq!(questions[0].question, "confirm jan@example.com?");
                assert_eq!(questions[0].header, "jan@example.com");
                assert_eq!(questions[0].options[0].label, "jan@example.com");
                assert_eq!(questions[0].options[0].value, "jan@example.com");
            }
            other => panic!("variant changed: {other:?}"),
        }
    }

    #[test]
    fn detokenize_chunk_wrong_project_key_falls_back_to_tokenized_text() {
        let tmp = tempfile::tempdir().unwrap();
        let key_a = detok_test_key(tmp.path(), "proj-a");
        let key_b = detok_test_key(tmp.path(), "proj-b");
        let tokenized = tokenize_for_test(&key_a, "secret@example.com");

        let chunk = StreamChunk::Text {
            content: tokenized.clone(),
        };
        match detokenize_chunk(chunk, &key_policy(key_b)) {
            StreamChunk::Text { content } => assert_eq!(content, tokenized),
            other => panic!("variant changed: {other:?}"),
        }
    }

    #[test]
    fn detokenize_chunk_leaves_tool_input_delta_and_tool_start_untouched() {
        let tmp = tempfile::tempdir().unwrap();
        let key = detok_test_key(tmp.path(), "proj");
        let raw = r#"{"path":"/x","token":"abc"#;
        let chunk = StreamChunk::ToolInputDelta {
            tool_id: "t1".into(),
            partial_json: raw.into(),
        };
        match detokenize_chunk(chunk, &key_policy(key)) {
            StreamChunk::ToolInputDelta { partial_json, .. } => {
                assert_eq!(partial_json, raw);
            }
            other => panic!("variant changed: {other:?}"),
        }
    }

    #[test]
    fn detokenize_chunk_leaves_tool_input_complete_untouched() {
        let tmp = tempfile::tempdir().unwrap();
        let key = detok_test_key(tmp.path(), "proj");
        let raw = r#"{"path":"/x","token":"abc"}"#;
        let chunk = StreamChunk::ToolInputComplete {
            tool_id: "t1".into(),
            input_json: raw.into(),
        };
        match detokenize_chunk(chunk, &key_policy(key)) {
            StreamChunk::ToolInputComplete { input_json, .. } => {
                assert_eq!(input_json, raw);
            }
            other => panic!("variant changed: {other:?}"),
        }
    }

    #[test]
    fn detokenize_chunk_unmasks_keyword_aliases_in_tool_results() {
        let policy = DisplayPolicy::new(
            None,
            vec![speedwave_pii_engine::CompiledKeyword {
                match_text: "coca-cola".to_string(),
                alias: "Brandex".to_string(),
                case_sensitive: false,
            }],
        );
        let chunk = StreamChunk::ToolResult {
            tool_id: "t1".into(),
            content: "brandex shipped".into(),
            is_error: false,
        };
        match detokenize_chunk(chunk, &policy) {
            StreamChunk::ToolResult { content, .. } => assert_eq!(content, "coca-cola shipped"),
            other => panic!("variant changed: {other:?}"),
        }
    }

    #[test]
    fn interrupt_without_active_session_errors() {
        let mut s = ChatSession::new("test-project");
        let err = s
            .interrupt()
            .expect_err("expected 'no active session' when stdin not set");
        assert!(
            err.to_string().contains("no active session"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn send_message_rejects_bare_slash_before_session_check() {
        let mut s = ChatSession::new("test-project");
        let err = s
            .send_message_with_emit(&text_only("/"), |_| {})
            .expect_err("bare slash must be rejected");
        assert!(
            err.to_string().contains("empty message"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn send_message_allows_real_text_through_to_session_check() {
        let mut s = ChatSession::new("test-project");
        let err = s
            .send_message_with_emit(&text_only("hej"), |_| {})
            .expect_err("no active session expected");
        assert!(
            err.to_string().contains("no active session"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn send_message_matching_control_shape_emits_control_chip_after_stdin_write() {
        let mut session = ChatSession::new("proj");
        let mut emitted: Vec<StreamChunk> = Vec::new();
        session.set_test_stdin_sink(Vec::new());
        let result =
            session.send_message_with_emit(&text_only("/model claude-sonnet-5"), |chunk| {
                emitted.push(chunk);
            });
        assert!(result.is_ok());
        assert_eq!(emitted.len(), 1);
        match &emitted[0] {
            StreamChunk::ControlChip {
                command,
                argument,
                uuid,
            } => {
                assert_eq!(command, "model");
                assert_eq!(argument, "claude-sonnet-5");
                assert_eq!(
                    uuid, &None,
                    "no uuid available at send time - see Task 13 wire-fact note"
                );
            }
            other => panic!("expected ControlChip, got {other:?}"),
        }
    }

    #[test]
    fn send_message_stdin_write_failure_propagates_error_and_emits_no_control_chip() {
        let mut session = ChatSession::new("proj");
        let mut emitted: Vec<StreamChunk> = Vec::new();
        session.set_test_stdin_broken_pipe();
        let result =
            session.send_message_with_emit(&text_only("/model claude-sonnet-5"), |chunk| {
                emitted.push(chunk);
            });
        assert!(result.is_err(), "expected stdin write failure to propagate");
        assert!(
            emitted.is_empty(),
            "expected no ControlChip on write failure, got {emitted:?}"
        );
    }

    #[test]
    fn send_message_plain_text_emits_no_control_chip() {
        let mut session = ChatSession::new("proj");
        let mut emitted: Vec<StreamChunk> = Vec::new();
        session.set_test_stdin_sink(Vec::new());
        session
            .send_message_with_emit(&text_only("what is 2+2?"), |chunk| emitted.push(chunk))
            .unwrap();
        assert!(emitted.is_empty());
    }

    #[test]
    fn send_message_bare_model_without_argument_emits_no_control_chip() {
        let mut session = ChatSession::new("proj");
        let mut emitted: Vec<StreamChunk> = Vec::new();
        session.set_test_stdin_sink(Vec::new());
        session
            .send_message_with_emit(&text_only("/model"), |chunk| emitted.push(chunk))
            .unwrap();
        assert!(emitted.is_empty());
    }

    #[test]
    fn send_message_multi_block_never_matches_control_shape_even_when_joined_text_would() {
        let mut session = ChatSession::new("proj");
        let mut emitted: Vec<StreamChunk> = Vec::new();
        session.set_test_stdin_sink(Vec::new());
        let blocks = vec![
            WireContentBlock::Text {
                text: "/model ".to_string(),
            },
            WireContentBlock::Text {
                text: "x".to_string(),
            },
        ];
        session
            .send_message_with_emit(&blocks, |chunk| emitted.push(chunk))
            .unwrap();
        assert!(
            emitted.is_empty(),
            "multi-block message must never emit a ControlChip, got {emitted:?}"
        );
    }

    #[test]
    fn send_message_single_block_control_command_still_matches() {
        let mut session = ChatSession::new("proj");
        let mut emitted: Vec<StreamChunk> = Vec::new();
        session.set_test_stdin_sink(Vec::new());
        session
            .send_message_with_emit(&text_only("/model x"), |chunk| emitted.push(chunk))
            .unwrap();
        assert_eq!(emitted.len(), 1);
        match &emitted[0] {
            StreamChunk::ControlChip {
                command, argument, ..
            } => {
                assert_eq!(command, "model");
                assert_eq!(argument, "x");
            }
            other => panic!("expected ControlChip, got {other:?}"),
        }
    }

    #[test]
    fn drained_control_shaped_text_emits_control_chip_then_queue_drained_and_writes_stdin_once() {
        let stdin = Arc::new(Mutex::new(test_pipe_stdin(Vec::new())));
        let settled = ModelSettled::default();
        let mut emitted: Vec<StreamChunk> = Vec::new();
        write_and_emit_drained_message(
            "sess-1",
            "/model claude-sonnet-5",
            &stdin,
            &settled,
            |chunk| emitted.push(chunk),
        );

        assert!(
            settled.is_settled(),
            "a queued model pick must stop the session-start soft-impose"
        );
        assert_eq!(
            emitted.len(),
            2,
            "expected ControlChip + QueueDrained, got {emitted:?}"
        );
        match &emitted[0] {
            StreamChunk::ControlChip {
                command, argument, ..
            } => {
                assert_eq!(command, "model");
                assert_eq!(argument, "claude-sonnet-5");
            }
            other => panic!("expected ControlChip first, got {other:?}"),
        }
        match &emitted[1] {
            StreamChunk::QueueDrained { session_id, text } => {
                assert_eq!(session_id, "sess-1");
                assert_eq!(text, "/model claude-sonnet-5");
            }
            other => panic!("expected QueueDrained second, got {other:?}"),
        }
    }

    #[test]
    fn drained_plain_text_emits_only_queue_drained() {
        let stdin = Arc::new(Mutex::new(test_pipe_stdin(Vec::new())));
        let settled = ModelSettled::default();
        let mut emitted: Vec<StreamChunk> = Vec::new();
        write_and_emit_drained_message("sess-1", "what is 2+2?", &stdin, &settled, |chunk| {
            emitted.push(chunk)
        });

        assert_eq!(emitted.len(), 1);
        assert!(matches!(emitted[0], StreamChunk::QueueDrained { .. }));
        assert!(!settled.is_settled());
    }

    #[test]
    fn a_drained_effort_pick_leaves_the_soft_impose_armed() {
        let stdin = Arc::new(Mutex::new(test_pipe_stdin(Vec::new())));
        let settled = ModelSettled::default();
        write_and_emit_drained_message("sess-1", "/effort high", &stdin, &settled, |_| {});
        assert!(!settled.is_settled());
    }

    fn finished_turn() -> StreamChunk {
        StreamChunk::Result {
            session_id: "sess-1".to_string(),
            total_cost: None,
            usage: None,
            result_text: None,
            context_window_size: None,
            assistant_uuid: None,
            turn_usage: None,
            turn_cost: None,
            model: None,
            context_usage: None,
        }
    }

    #[test]
    fn a_result_is_awaited_until_one_arrives_and_again_after_the_next_message() {
        let awaited = AwaitedResult::new();
        assert!(
            awaited.is_awaited(),
            "a process that dies before its first output line must be reported"
        );
        awaited.observe(&[finished_turn()]);
        assert!(!awaited.is_awaited());
        awaited.message_written();
        assert!(
            awaited.is_awaited(),
            "the previous turn's result must not cover a message sent after it"
        );
    }

    #[test]
    fn turn_output_keeps_the_result_awaited_and_an_error_or_empty_batch_does_not() {
        let awaited = AwaitedResult::new();
        awaited.observe(&[StreamChunk::Error {
            content: "boom".to_string(),
            turn_ended: false,
        }]);
        assert!(!awaited.is_awaited());
        awaited.observe(&[]);
        assert!(!awaited.is_awaited());
        awaited.observe(&[StreamChunk::Text {
            content: "hi".to_string(),
        }]);
        assert!(awaited.is_awaited());
        awaited.observe(&[
            StreamChunk::Text {
                content: "bye".to_string(),
            },
            finished_turn(),
        ]);
        assert!(!awaited.is_awaited());
    }

    #[test]
    fn a_message_sent_after_a_finished_turn_awaits_its_own_result() {
        let mut session = ChatSession::new("proj");
        session.set_test_stdin_sink(Vec::new());
        session.awaited_result.observe(&[finished_turn()]);
        session
            .send_message_with_emit(&text_only("next question"), |_| {})
            .unwrap();
        assert!(session.awaited_result.is_awaited());
    }

    #[test]
    fn a_message_that_fails_to_reach_the_process_awaits_nothing() {
        let mut session = ChatSession::new("proj");
        session.set_test_stdin_broken_pipe();
        session.awaited_result.observe(&[finished_turn()]);
        session
            .send_message_with_emit(&text_only("next question"), |_| {})
            .unwrap_err();
        assert!(!session.awaited_result.is_awaited());
    }

    #[test]
    fn a_model_pick_sent_to_the_session_stops_the_soft_impose() {
        let mut session = ChatSession::new("proj");
        session.set_test_stdin_sink(Vec::new());
        session
            .send_message_with_emit(&text_only("/model openrouter/openai/gpt-4o-mini"), |_| {})
            .unwrap();
        assert!(session.model_settled.is_settled());
    }

    #[test]
    fn a_plain_message_or_an_effort_pick_leaves_the_soft_impose_armed() {
        let mut session = ChatSession::new("proj");
        session.set_test_stdin_sink(Vec::new());
        session
            .send_message_with_emit(&text_only("/effort high"), |_| {})
            .unwrap();
        session
            .send_message_with_emit(&text_only("what model are you?"), |_| {})
            .unwrap();
        assert!(!session.model_settled.is_settled());
    }

    #[test]
    fn a_drained_message_reports_whether_it_reached_the_process() {
        let stdin = Arc::new(Mutex::new(test_pipe_stdin(Vec::new())));
        let settled = ModelSettled::default();
        assert!(write_and_emit_drained_message(
            "sess-1",
            "queued",
            &stdin,
            &settled,
            |_| {}
        ));
        let broken = Arc::new(Mutex::new(test_broken_pipe_stdin()));
        let mut emitted: Vec<StreamChunk> = Vec::new();
        assert!(!write_and_emit_drained_message(
            "sess-1",
            "queued",
            &broken,
            &settled,
            |chunk| emitted.push(chunk)
        ));
        assert!(emitted.is_empty());
    }

    #[test]
    fn the_stdout_reader_reports_an_unexpected_end_from_the_shared_result_state() {
        let source = include_str!("chat.rs");
        let start = source
            .find("pub fn start_with_retry(")
            .expect("start_with_retry must exist");
        let body = &source[start..];
        let body = &body[..body
            .find("pub fn send_message(")
            .expect("send_message must follow start_with_retry")];
        for wiring in [
            "awaited_for_reader.observe(&chunks)",
            "awaited_for_reader.message_written()",
            "awaited_for_reader.is_awaited() && !stopping",
        ] {
            assert!(body.contains(wiring), "the reader must use `{wiring}`");
        }
    }

    #[test]
    fn the_stdout_reader_runs_the_soft_impose_step_on_every_parsed_line() {
        let source = include_str!("chat.rs");
        let start = source
            .find("pub fn start_with_retry(")
            .expect("start_with_retry must exist");
        let body = &source[start..];
        let body: String = body[..body
            .find("pub fn send_message(")
            .expect("send_message must follow start_with_retry")]
            .split_whitespace()
            .collect();
        let at = |needle: &str| {
            body.find(needle)
                .unwrap_or_else(|| panic!("the reader must use `{needle}`"))
        };
        let answers_routed =
            at("ifconsume_control_response(&control_for_reader,&parsed){continue;}");
        let parsed = at("let(chunks,log_entry)=parser.parse_line(&parsed);");
        let step = at(concat!(
            "ifletSome((pending,model))=soft_impose_step(&parsed,&chunks,&soft_impose_cfg,",
            "&settled_for_reader,&control_for_reader,&stdin_for_reader,)",
            "{std::thread::spawn(move||report_soft_impose(pending,&model));}"
        ));
        assert!(
            answers_routed < parsed,
            "control answers never reach the parser"
        );
        assert!(parsed < step, "the step reads the parsed chunks");
    }

    #[test]
    fn build_interrupt_payload_matches_sdk_protocol() {
        let v = build_interrupt_payload("req_interrupt_42");
        assert_eq!(v["type"], "control_request");
        assert_eq!(v["request_id"], "req_interrupt_42");
        assert_eq!(v["request"]["subtype"], "interrupt");
        let obj = v.as_object().expect("object");
        let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
        keys.sort();
        assert_eq!(keys, vec!["request", "request_id", "type"]);
    }

    #[test]
    fn next_interrupt_request_id_is_unique_and_prefixed() {
        let a = next_interrupt_request_id();
        let b = next_interrupt_request_id();
        assert_ne!(a, b);
        assert!(a.starts_with("req_interrupt_"));
        assert!(b.starts_with("req_interrupt_"));
    }

    #[test]
    fn write_interrupt_emits_single_ndjson_line() {
        let payload = build_interrupt_payload("req_interrupt_test");
        let mut buf: Vec<u8> = Vec::new();
        write_interrupt(&mut buf, &payload).expect("write");
        let s = String::from_utf8(buf).expect("utf8");
        assert!(s.ends_with('\n'), "must end with newline, got: {s:?}");
        let line = s.trim_end_matches('\n');
        assert!(!line.contains('\n'), "must be single line, got: {s:?}");
        let parsed: serde_json::Value = serde_json::from_str(line).expect("valid json");
        assert_eq!(parsed["request"]["subtype"], "interrupt");
    }

    #[test]
    fn write_interrupt_propagates_io_errors() {
        struct FailWriter;
        impl Write for FailWriter {
            fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
                Err(std::io::Error::new(std::io::ErrorKind::BrokenPipe, "boom"))
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let payload = build_interrupt_payload("req_interrupt_err");
        let err = write_interrupt(&mut FailWriter, &payload).expect_err("expected error");
        assert!(err.to_string().contains("boom"), "got: {err}");
    }

    #[test]
    fn control_response_is_consumed_before_the_stream_parser() {
        let control = ControlChannel::default();
        let line = serde_json::json!({
            "type": "control_response",
            "response": { "subtype": "success", "request_id": "req_interrupt_1" }
        });
        assert!(consume_control_response(&control, &line));

        for other in [
            serde_json::json!({ "type": "control_request", "request_id": "r" }),
            serde_json::json!({ "type": "result" }),
            serde_json::json!({ "foo": "bar" }),
        ] {
            assert!(!consume_control_response(&control, &other), "{other}");
        }
    }

    #[test]
    fn stdout_reader_routes_control_responses_before_parsing_the_line() {
        let src = include_str!("chat.rs");
        let prod = src.split("\nmod tests {").next().unwrap_or(src);
        let route_pos = prod
            .find("if consume_control_response(&control_for_reader, &parsed)")
            .expect("the stdout reader must route control responses");
        let parse_pos = prod
            .find("parser.parse_line(&parsed)")
            .expect("the stdout reader must parse lines");
        assert!(
            route_pos < parse_pos,
            "a control_response reaching parse_line is logged as an unknown stream-json type"
        );
    }

    #[test]
    fn stdout_reader_ends_pending_control_requests_when_the_stream_closes() {
        let src = include_str!("chat.rs");
        let prod = src.split("\nmod tests {").next().unwrap_or(src);
        assert!(
            prod.contains("control_for_reader.close();"),
            "a dead process must fail waiting control requests instead of letting them time out"
        );
    }

    #[test]
    fn probe_session_info_stores_the_parsed_initialize_result() {
        let fixture: serde_json::Value =
            serde_json::from_str(control_channel::FIXTURE).expect("fixture");
        let slot = Mutex::new(SessionInfoState::Pending);
        let stopping = std::sync::atomic::AtomicBool::new(false);
        let status = probe_session_info(
            || Ok(fixture["run_A"]["initialize"].clone()),
            &slot,
            &stopping,
        )
        .expect("a live session reports its status");
        assert!(matches!(&status, SessionInfoState::Ready { info } if info.models.len() == 6));
        assert_eq!(*slot.lock().unwrap(), status);
    }

    #[test]
    fn probe_session_info_degrades_to_unavailable_when_the_request_fails() {
        let slot = Mutex::new(SessionInfoState::Pending);
        let stopping = std::sync::atomic::AtomicBool::new(false);
        let status = probe_session_info(
            || {
                Err(control_channel::ControlError::Timeout {
                    subtype: "initialize",
                    timeout: std::time::Duration::from_secs(15),
                })
            },
            &slot,
            &stopping,
        );
        assert_eq!(status, Some(SessionInfoState::Unavailable));
        assert_eq!(*slot.lock().unwrap(), SessionInfoState::Unavailable);
    }

    #[test]
    fn probe_session_info_of_a_stopped_session_reports_nothing() {
        let slot = Mutex::new(SessionInfoState::Unavailable);
        let stopping = std::sync::atomic::AtomicBool::new(true);
        let status = probe_session_info(
            || Err(control_channel::ControlError::SessionEnded),
            &slot,
            &stopping,
        );
        assert_eq!(status, None);
        assert_eq!(*slot.lock().unwrap(), SessionInfoState::Unavailable);
    }

    #[test]
    fn fresh_session_has_no_session_info_and_no_control_handle() {
        let s = ChatSession::new("test-project");
        assert_eq!(s.session_info_state(), SessionInfoState::Unavailable);
        let err = s.control_handle().err().expect("no stdin yet");
        assert!(err.to_string().contains("no active session"), "{err}");
    }

    #[test]
    fn stop_ends_a_control_request_that_is_still_waiting() {
        let mut s = ChatSession::new("test-project");
        s.set_test_stdin_sink(Vec::new());
        let handle = s.control_handle().expect("handle");
        let control = s.control.clone();
        let waiter = std::thread::spawn(move || handle.query(ControlQuery::Usage));
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while control.pending_ids().is_empty() {
            assert!(std::time::Instant::now() < deadline, "request never sent");
            std::thread::yield_now();
        }
        s.stop().expect("stop");
        assert_eq!(
            waiter.join().expect("join"),
            Err(control_channel::ControlError::SessionEnded)
        );
        assert_eq!(s.session_info_state(), SessionInfoState::Unavailable);
    }

    #[test]
    fn reap_exec_plan_targets_project_container_with_marker() {
        let (container, argv) = reap_exec_plan("acme", "inst-123");
        assert!(
            container.ends_with("_acme_claude"),
            "must target the project's claude container, got: {container}"
        );
        let joined = argv.join(" ");
        assert!(joined.contains("SPW_SESSION_INSTANCE_ID=inst-123"));
        assert!(joined.contains("kill"));
    }

    #[test]
    fn reap_instance_is_noop_without_an_id() {
        let mut s = ChatSession::new("test-project");
        assert!(s.instance_id.is_none());
        s.reap_instance();
        assert!(s.instance_id.is_none());
    }

    #[test]
    fn stop_sets_stopping_flag() {
        use std::sync::atomic::Ordering;
        let mut s = ChatSession::new("test-project");
        assert!(!s.stopping.load(Ordering::SeqCst));
        s.stop().unwrap();
        assert!(
            s.stopping.load(Ordering::SeqCst),
            "stop() must mark deliberate teardown so the reader stays silent"
        );
    }

    #[test]
    fn stop_is_idempotent_when_no_session_running() {
        let mut s = ChatSession::new("test-project");
        assert!(s.stop().is_ok());
        assert!(s.stop().is_ok());
        assert!(s.child.is_none());
        assert!(s.shared_stdin.is_none());
        assert!(s.drain_handles.is_empty());
        assert!(s.session_log_path.is_none());
    }

    #[test]
    fn stop_grace_period_joins_reader_that_finishes_late() {
        let mut s = ChatSession::new("test-project");
        s.drain_handles.push(std::thread::spawn(|| {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }));
        let start = std::time::Instant::now();
        assert!(s.stop().is_ok());
        let elapsed = start.elapsed();
        assert!(s.drain_handles.is_empty(), "handle must be drained");
        assert!(
            elapsed < std::time::Duration::from_millis(500),
            "stop() took {elapsed:?} — grace window should have joined the reader well under 500ms"
        );
    }

    #[test]
    fn stop_grace_period_gives_up_on_genuinely_stuck_reader() {
        let mut s = ChatSession::new("test-project");
        s.drain_handles.push(std::thread::spawn(|| {
            std::thread::sleep(std::time::Duration::from_secs(10));
        }));
        let start = std::time::Instant::now();
        assert!(s.stop().is_ok());
        let elapsed = start.elapsed();
        assert!(s.drain_handles.is_empty(), "handle must be drained");
        assert!(
            elapsed < std::time::Duration::from_millis(1000),
            "stop() took {elapsed:?} — a stuck reader must be detached within the grace window, not joined"
        );
    }

    #[test]
    fn stop_clears_pending_requests() {
        let mut s = ChatSession::new("test-project");
        s.pending_requests.lock().unwrap().insert(
            "tool-1".to_string(),
            PartialAnswers {
                request: ControlRequest {
                    request_id: "r1".to_string(),
                    tool_name: ASK_USER_TOOL_NAME.to_string(),
                    input: serde_json::json!({}),
                    tool_use_id: "tool-1".to_string(),
                },
                questions: vec![AskUserQuestionItem {
                    question: "q".to_string(),
                    header: String::new(),
                    options: vec![],
                    multi_select: false,
                }],
                answers: vec![None],
            },
        );
        assert!(s.stop().is_ok());
        assert!(s.pending_requests.lock().unwrap().is_empty());
    }

    #[test]
    fn second_session_can_be_created_after_stop() {
        let mut s1 = ChatSession::new("test-project");
        assert!(s1.stop().is_ok());
        drop(s1);
        let mut s2 = ChatSession::new("test-project");
        assert!(s2.stop().is_ok());
    }

    fn parse_line_str(parser: &mut StreamParser, line: &str) -> Option<StreamChunk> {
        let parsed: serde_json::Value = serde_json::from_str(line).ok()?;
        parser.parse_line(&parsed).0.into_iter().next()
    }

    fn parse_line_all_str(parser: &mut StreamParser, line: &str) -> Vec<StreamChunk> {
        let parsed: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => return Vec::new(),
        };
        parser.parse_line(&parsed).0
    }

    fn parse_line_full(
        parser: &mut StreamParser,
        line: &str,
    ) -> (Option<StreamChunk>, Option<LogEntry>) {
        let parsed = match serde_json::from_str::<serde_json::Value>(line) {
            Ok(v) => v,
            Err(_) => return (None, None),
        };
        let (chunks, log) = parser.parse_line(&parsed);
        (chunks.into_iter().next(), log)
    }

    fn try_parse_control_request_str(line: &str) -> Option<ControlRequest> {
        let parsed: serde_json::Value = serde_json::from_str(line).ok()?;
        StreamParser::try_parse_control_request(&parsed)
    }

    #[test]
    fn parse_line_logs_unknown_type_once_per_session() {
        let mut parser = StreamParser::new();
        let line = r#"{"type":"compaction_event","data":{}}"#;
        let (chunks, log) = parse_line_full(&mut parser, line);
        assert!(chunks.is_none(), "unknown type must emit no chunk");
        let log = log.expect("first occurrence must produce a log entry");
        assert_eq!(log.prefix, "STREAM");
        assert!(log.message.contains("compaction_event"));
        let (chunks2, log2) = parse_line_full(&mut parser, line);
        assert!(chunks2.is_none());
        assert!(log2.is_none(), "repeat occurrences must not spam the log");
    }

    #[test]
    fn parse_line_logs_each_distinct_unknown_type() {
        let mut parser = StreamParser::new();
        let (_, log_a) = parse_line_full(&mut parser, r#"{"type":"future_a"}"#);
        let (_, log_b) = parse_line_full(&mut parser, r#"{"type":"future_b"}"#);
        assert!(log_a.is_some());
        assert!(log_b.is_some(), "a different unknown type logs separately");
    }

    #[test]
    fn parse_line_missing_type_logged_as_none_label() {
        let mut parser = StreamParser::new();
        let (chunks, log) = parse_line_full(&mut parser, r#"{"foo":"bar"}"#);
        assert!(chunks.is_none());
        assert!(log.expect("must log").message.contains("<none>"));
    }

    #[test]
    fn parse_line_unknown_type_tracking_is_capped() {
        let mut parser = StreamParser::new();
        for i in 0..MAX_TRACKED_UNKNOWN_TYPES {
            let line = format!(r#"{{"type":"future_{i}"}}"#);
            let parsed: serde_json::Value = serde_json::from_str(&line).unwrap();
            assert!(parser.parse_line(&parsed).1.is_some());
        }
        let parsed: serde_json::Value = serde_json::from_str(r#"{"type":"overflow"}"#).unwrap();
        assert!(parser.parse_line(&parsed).1.is_none());
    }

    #[test]
    fn control_request_with_unknown_shape_returns_none() {
        let line =
            r#"{"type":"control_request","request_id":"r1","request":{"subtype":"hook_callback"}}"#;
        assert!(try_parse_control_request_str(line).is_none());
    }

    #[test]
    fn stream_chunk_text_serializes_tagged() {
        let chunk = StreamChunk::Text {
            content: "hello".to_string(),
        };
        let json = serde_json::to_value(&chunk).unwrap();
        assert_eq!(json["chunk_type"], "Text");
        assert_eq!(json["data"]["content"], "hello");
    }

    #[test]
    fn stream_chunk_round_trips_through_json() {
        let original = StreamChunk::Text {
            content: "hello".to_string(),
        };
        let serialized = serde_json::to_string(&original).unwrap();
        let deserialized: StreamChunk = serde_json::from_str(&serialized).unwrap();
        match deserialized {
            StreamChunk::Text { content } => assert_eq!(content, "hello"),
            other => panic!("expected Text, got {other:?}"),
        }
    }

    #[test]
    fn stream_chunk_tool_start_round_trips() {
        let original = StreamChunk::ToolStart {
            tool_id: "t1".to_string(),
            tool_name: "Read".to_string(),
        };
        let serialized = serde_json::to_string(&original).unwrap();
        let deserialized: StreamChunk = serde_json::from_str(&serialized).unwrap();
        match deserialized {
            StreamChunk::ToolStart { tool_id, tool_name } => {
                assert_eq!(tool_id, "t1");
                assert_eq!(tool_name, "Read");
            }
            other => panic!("expected ToolStart, got {other:?}"),
        }
    }

    #[test]
    fn stream_chunk_result_round_trips() {
        let original = StreamChunk::Result {
            session_id: "abc".to_string(),
            total_cost: Some(0.05),
            usage: Some(Box::new(UsageInfo {
                input_tokens: 100,
                output_tokens: 50,
                cache_read_tokens: Some(10),
                cache_write_tokens: None,
            })),
            result_text: None,
            context_window_size: None,
            assistant_uuid: Some("msg_test".to_string()),
            turn_usage: None,
            turn_cost: None,
            model: None,
            context_usage: None,
        };
        let serialized = serde_json::to_string(&original).unwrap();
        let deserialized: StreamChunk = serde_json::from_str(&serialized).unwrap();
        match deserialized {
            StreamChunk::Result {
                session_id,
                total_cost,
                usage,
                ..
            } => {
                assert_eq!(session_id, "abc");
                assert_eq!(total_cost, Some(0.05));
                let u = usage.unwrap();
                assert_eq!(u.input_tokens, 100);
                assert_eq!(u.cache_read_tokens, Some(10));
            }
            other => panic!("expected Result, got {other:?}"),
        }
    }

    #[test]
    fn is_blank_or_slash_only_rejects_lone_slash() {
        assert!(is_blank_or_slash_only(&text_only("/")));
    }

    #[test]
    fn is_blank_or_slash_only_rejects_slash_with_surrounding_whitespace() {
        assert!(is_blank_or_slash_only(&text_only("  /  ")));
        assert!(is_blank_or_slash_only(&text_only("\n/\t")));
    }

    #[test]
    fn is_blank_or_slash_only_rejects_blank_and_empty() {
        assert!(is_blank_or_slash_only(&text_only("")));
        assert!(is_blank_or_slash_only(&text_only("   \n\t ")));
        assert!(is_blank_or_slash_only(&[]));
    }

    #[test]
    fn is_blank_or_slash_only_accepts_real_slash_command() {
        assert!(!is_blank_or_slash_only(&text_only("/code-review")));
        assert!(!is_blank_or_slash_only(&text_only("/clear")));
    }

    #[test]
    fn is_blank_or_slash_only_accepts_normal_text() {
        assert!(!is_blank_or_slash_only(&text_only("hej")));
        assert!(!is_blank_or_slash_only(&text_only("what is 2/3?")));
    }

    #[test]
    fn build_user_message_produces_correct_json_structure() {
        let msg = build_user_message(&text_only("test msg"));

        assert_eq!(msg["type"], "user");
        assert_eq!(msg["message"]["role"], "user");
        assert!(msg.get("parent_tool_use_id").is_none());

        let content = &msg["message"]["content"];
        assert!(content.is_array());

        let items = content.as_array().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["type"], "text");
        assert_eq!(items[0]["text"], "test msg");
    }

    #[test]
    fn build_user_message_preserves_special_characters() {
        let msg = build_user_message(&text_only("hello \"world\" \n\ttab"));
        let text = msg["message"]["content"][0]["text"].as_str().unwrap();
        assert_eq!(text, "hello \"world\" \n\ttab");
    }

    #[test]
    fn build_user_message_with_paste_reference_in_text() {
        let blocks = text_only("Co tu widać?\n\n@/workspace/.speedwave/pastes/paste-123.png");
        let msg = build_user_message(&blocks);
        let items = msg["message"]["content"].as_array().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["type"], "text");
        let text = items[0]["text"].as_str().unwrap();
        assert!(text.contains("@/workspace/.speedwave/pastes/paste-123.png"));
    }

    #[test]
    fn build_user_message_snapshot_wire_format() {
        let blocks = text_only(
            "review these\n\n@/workspace/.speedwave/pastes/paste-1.png\n@/workspace/.speedwave/pastes/paste-2.jpg",
        );
        let msg = build_user_message(&blocks);
        let expected = serde_json::json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": "review these\n\n@/workspace/.speedwave/pastes/paste-1.png\n@/workspace/.speedwave/pastes/paste-2.jpg"
                    }
                ]
            }
        });
        assert_eq!(msg, expected);
        assert!(!serde_json::to_string(&msg).unwrap().contains("\"image\""));
    }

    #[test]
    fn wire_content_block_roundtrip_text_only() {
        let blocks = text_only("hi");
        let encoded = serde_json::to_value(&blocks).unwrap();
        let decoded: Vec<WireContentBlock> = serde_json::from_value(encoded).unwrap();
        assert_eq!(blocks, decoded);
    }

    #[test]
    fn text_only_helper_wraps_into_text_block() {
        let blocks = text_only("hello");
        assert_eq!(blocks.len(), 1);
        match &blocks[0] {
            WireContentBlock::Text { text } => assert_eq!(text, "hello"),
        }
    }

    #[test]
    fn max_wire_bytes_is_1_mib() {
        assert_eq!(MAX_WIRE_BYTES, 1024 * 1024);
    }

    #[test]
    fn soft_impose_target_is_the_configured_wire_id_on_a_mismatch() {
        let target = soft_impose_target(
            speedwave_runtime::config::LlmProviderKind::Local,
            "local",
            Some("llama-3.1-70b"),
            "wrong-observed-model",
        );
        assert_eq!(target.as_deref(), Some("local/llama-3.1-70b"));
    }

    #[test]
    fn soft_impose_target_is_none_on_a_match() {
        let target = soft_impose_target(
            speedwave_runtime::config::LlmProviderKind::Local,
            "local",
            Some("llama-3.1-70b"),
            "local/llama-3.1-70b",
        );
        assert_eq!(target, None);
    }

    #[test]
    fn soft_impose_target_is_none_for_an_anthropic_kind() {
        let target = soft_impose_target(
            speedwave_runtime::config::LlmProviderKind::AnthropicOauth,
            "anthropic",
            Some("claude-sonnet-5"),
            "some-other-observed",
        );
        assert_eq!(target, None);
    }

    #[test]
    fn soft_impose_target_is_none_without_an_entry_model() {
        let target = soft_impose_target(
            speedwave_runtime::config::LlmProviderKind::OpenRouter,
            "openrouter",
            None,
            "anthropic/claude-sonnet-5",
        );
        assert_eq!(target, None);
    }

    #[test]
    fn soft_impose_target_matches_an_already_prefixed_catalog_id() {
        let target = soft_impose_target(
            speedwave_runtime::config::LlmProviderKind::Local,
            "llama",
            Some("llama/whatever"),
            "llama/whatever",
        );
        assert_eq!(
            target, None,
            "an already-prefixed catalog id must still be recognized as matching"
        );
    }

    #[test]
    fn soft_impose_target_fires_for_openrouter_and_local_kinds_on_a_mismatch() {
        for kind in [
            speedwave_runtime::config::LlmProviderKind::OpenRouter,
            speedwave_runtime::config::LlmProviderKind::Local,
        ] {
            let mismatch = soft_impose_target(kind, "entry", Some("model-a"), "model-b");
            assert!(mismatch.is_some(), "{kind:?} must fire on mismatch");

            let matching = soft_impose_target(kind, "entry", Some("model-a"), "entry/model-a");
            assert_eq!(matching, None, "{kind:?} must suppress on match");
        }
    }

    fn local_llama() -> SoftImposeConfig {
        SoftImposeConfig {
            kind: speedwave_runtime::config::LlmProviderKind::Local,
            entry_id: "local".to_string(),
            entry_model: Some("llama-3.1-70b".to_string()),
        }
    }

    fn init_with_model(model: &str) -> serde_json::Value {
        serde_json::json!({
            "type": "system",
            "subtype": "init",
            "session_id": "sess-1",
            "model": model,
        })
    }

    fn init_chunk(model: &str) -> Vec<StreamChunk> {
        vec![StreamChunk::SystemInit {
            model: model.to_string(),
            session_id: Some("sess-1".to_string()),
        }]
    }

    fn written_lines(stdin: &Mutex<Vec<u8>>) -> Vec<serde_json::Value> {
        String::from_utf8(stdin.lock().unwrap().clone())
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    #[test]
    fn a_mismatched_init_sends_one_set_model_with_the_configured_wire_id() {
        let stdin = Mutex::new(Vec::<u8>::new());
        let control = ControlChannel::default();
        let settled = ModelSettled::default();
        let init = init_with_model("wrong-observed-model");
        let chunks = init_chunk("wrong-observed-model");

        let first = soft_impose_step(&init, &chunks, &local_llama(), &settled, &control, &stdin);
        let second = soft_impose_step(&init, &chunks, &local_llama(), &settled, &control, &stdin);

        assert_eq!(
            first.map(|(_, model)| model).as_deref(),
            Some("local/llama-3.1-70b")
        );
        assert!(second.is_none(), "a session is soft-imposed once");
        let written = written_lines(&stdin);
        assert_eq!(written.len(), 1);
        assert_eq!(written[0]["type"], "control_request");
        assert_eq!(
            written[0]["request"],
            serde_json::json!({ "subtype": "set_model", "model": "local/llama-3.1-70b" })
        );
        assert!(settled.is_settled());
    }

    #[test]
    fn a_matching_init_a_line_that_is_not_an_init_or_a_picked_model_sends_nothing() {
        let stdin = Mutex::new(Vec::<u8>::new());
        let control = ControlChannel::default();
        let settled = ModelSettled::default();
        let cfg = local_llama();

        let matching = soft_impose_step(
            &init_with_model("local/llama-3.1-70b"),
            &init_chunk("local/llama-3.1-70b"),
            &cfg,
            &settled,
            &control,
            &stdin,
        );
        let not_an_init = soft_impose_step(
            &init_with_model("wrong-observed-model"),
            &[],
            &cfg,
            &settled,
            &control,
            &stdin,
        );
        settled.settle();
        let picked = soft_impose_step(
            &init_with_model("wrong-observed-model"),
            &init_chunk("wrong-observed-model"),
            &cfg,
            &settled,
            &control,
            &stdin,
        );

        assert!(matching.is_none());
        assert!(not_an_init.is_none());
        assert!(
            picked.is_none(),
            "a model the user picked is never switched back"
        );
        assert!(written_lines(&stdin).is_empty());
        assert!(control.pending_ids().is_empty());
    }

    #[test]
    fn an_anthropic_session_is_never_soft_imposed() {
        let stdin = Mutex::new(Vec::<u8>::new());
        let settled = ModelSettled::default();
        let cfg = SoftImposeConfig {
            kind: speedwave_runtime::config::LlmProviderKind::AnthropicOauth,
            entry_id: "anthropic".to_string(),
            entry_model: Some("claude-sonnet-5".to_string()),
        };

        let sent = soft_impose_step(
            &init_with_model("totally-different"),
            &init_chunk("totally-different"),
            &cfg,
            &settled,
            &ControlChannel::default(),
            &stdin,
        );

        assert!(sent.is_none());
        assert!(written_lines(&stdin).is_empty());
        assert!(!settled.is_settled());
    }

    #[test]
    fn a_model_pick_written_while_the_soft_impose_waits_for_stdin_cancels_it() {
        let stdin = Arc::new(Mutex::new(Vec::<u8>::new()));
        let settled = ModelSettled::default();
        let control = ControlChannel::default();
        let held = stdin.lock().unwrap();
        let sender = {
            let (stdin, settled, control) = (stdin.clone(), settled.clone(), control.clone());
            std::thread::spawn(move || {
                send_soft_impose(&stdin, &control, &settled, "local/llama-3.1-70b").is_some()
            })
        };
        std::thread::sleep(std::time::Duration::from_millis(50));

        settled.settle();
        drop(held);

        assert!(!sender.join().unwrap());
        assert!(written_lines(&stdin).is_empty());
        assert!(control.pending_ids().is_empty());
    }

    #[test]
    fn a_soft_impose_that_fails_to_reach_the_process_is_not_retried() {
        struct BrokenPipe;
        impl Write for BrokenPipe {
            fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
                Err(std::io::Error::from(std::io::ErrorKind::BrokenPipe))
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Err(std::io::Error::from(std::io::ErrorKind::BrokenPipe))
            }
        }
        let settled = ModelSettled::default();
        let control = ControlChannel::default();

        let sent = send_soft_impose(
            &Mutex::new(BrokenPipe),
            &control,
            &settled,
            "local/llama-3.1-70b",
        );

        assert!(sent.is_none());
        assert!(
            settled.is_settled(),
            "a dead process is not written to again at the next init"
        );
        assert!(control.pending_ids().is_empty());
    }

    #[test]
    fn a_first_matching_init_then_a_mismatch_sends_one_set_model() {
        let stdin = Mutex::new(Vec::<u8>::new());
        let control = ControlChannel::default();
        let settled = ModelSettled::default();

        let first = soft_impose_step(
            &init_with_model("local/llama-3.1-70b"),
            &init_chunk("local/llama-3.1-70b"),
            &local_llama(),
            &settled,
            &control,
            &stdin,
        );
        let later = soft_impose_step(
            &init_with_model("wrong-observed-model"),
            &init_chunk("wrong-observed-model"),
            &local_llama(),
            &settled,
            &control,
            &stdin,
        );

        assert!(first.is_none());
        assert_eq!(
            later.map(|(_, model)| model).as_deref(),
            Some("local/llama-3.1-70b")
        );
        assert_eq!(written_lines(&stdin).len(), 1);
    }

    #[test]
    fn the_soft_impose_report_ends_on_the_answer_and_on_the_session_end() {
        let control = ControlChannel::default();
        let answered = control
            .send_set_model(&mut Vec::new(), "local/llama-3.1-70b")
            .expect("written");
        let id = control.pending_ids().pop().expect("a waiter");
        control.route_response(&serde_json::json!({
            "type": "control_response",
            "response": { "subtype": "success", "request_id": id },
        }));
        let orphaned = control
            .send_set_model(&mut Vec::new(), "local/llama-3.1-70b")
            .expect("written");
        control.close();
        let started = std::time::Instant::now();

        report_soft_impose(answered, "local/llama-3.1-70b");
        report_soft_impose(orphaned, "local/llama-3.1-70b");

        assert!(
            started.elapsed() < control_channel::SET_MODEL_TIMEOUT / 2,
            "neither report waited for the timeout"
        );
    }

    #[test]
    fn a_model_pick_is_sent_every_time_and_settles_the_session() {
        let stdin = Mutex::new(Vec::<u8>::new());
        let control = ControlChannel::default();
        let settled = ModelSettled::default();

        let first = send_model_pick(&stdin, &control, &settled, "claude-haiku-4-5");
        let second = send_model_pick(&stdin, &control, &settled, "default");

        assert!(first.is_ok() && second.is_ok());
        assert!(settled.is_settled(), "no soft-impose follows a pick");
        let models: Vec<serde_json::Value> = written_lines(&stdin)
            .iter()
            .map(|l| l["request"]["model"].clone())
            .collect();
        assert_eq!(
            models,
            vec![
                serde_json::json!("claude-haiku-4-5"),
                serde_json::json!("default")
            ]
        );
    }

    #[test]
    fn a_soft_impose_after_a_model_pick_sends_nothing() {
        let stdin = Mutex::new(Vec::<u8>::new());
        let control = ControlChannel::default();
        let settled = ModelSettled::default();
        send_model_pick(&stdin, &control, &settled, ROUTED_PICK).expect("written");

        let after = soft_impose_step(
            &init_with_model(ENV_MODEL),
            &init_chunk(ENV_MODEL),
            &openrouter_mini(),
            &settled,
            &control,
            &stdin,
        );

        assert!(after.is_none());
        assert_eq!(written_lines(&stdin).len(), 1);
    }

    #[test]
    fn a_model_pick_on_a_live_session_settles_it_and_resolves_on_the_answer() {
        let mut session = ChatSession::new("proj");
        session.set_test_stdin_sink(Vec::new());
        let control = session.control.clone();
        let switch = session.model_switch().expect("a live session");
        let answerer = std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            loop {
                if let Some(id) = control.pending_ids().pop() {
                    return control.route_response(&serde_json::json!({
                        "type": "control_response",
                        "response": { "subtype": "success", "request_id": id },
                    }));
                }
                assert!(
                    std::time::Instant::now() < deadline,
                    "the pick never registered a waiter"
                );
                std::thread::yield_now();
            }
        });

        let applied = switch.apply("claude-haiku-4-5");

        assert_eq!(applied, Ok(()));
        assert_eq!(answerer.join().unwrap(), control_channel::Routed::Delivered);
        assert!(session.model_settled.is_settled());
    }

    #[test]
    fn a_model_pick_that_cannot_reach_the_process_reports_the_write_failure() {
        let mut session = ChatSession::new("proj");
        session.set_test_stdin_broken_pipe();
        let switch = session.model_switch().expect("a session with a pipe");

        let err = switch
            .apply("claude-haiku-4-5")
            .expect_err("the pipe is closed");

        assert!(
            matches!(err, control_channel::ControlError::Write(_)),
            "{err}"
        );
        assert!(session.control.pending_ids().is_empty());
    }

    #[test]
    fn a_session_without_a_process_has_no_model_switch() {
        assert!(ChatSession::new("proj").model_switch().is_err());
    }

    fn answer_the_pending_request(
        control: ControlChannel,
        answer: fn(&str) -> serde_json::Value,
    ) -> std::thread::JoinHandle<control_channel::Routed> {
        std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            loop {
                if let Some(id) = control.pending_ids().pop() {
                    return control.route_response(&answer(&id));
                }
                assert!(
                    std::time::Instant::now() < deadline,
                    "the effort pick never registered a waiter"
                );
                std::thread::yield_now();
            }
        })
    }

    fn lines_written_until_stdin_closed(
        capture: std::thread::JoinHandle<Vec<u8>>,
    ) -> Vec<serde_json::Value> {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !capture.is_finished() {
            assert!(
                std::time::Instant::now() < deadline,
                "stdin was never closed: a handle to it is still alive"
            );
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        let text = String::from_utf8(capture.join().unwrap()).unwrap();
        assert!(
            text.is_empty() || text.ends_with('\n'),
            "every write to stdin is a whole line: {text:?}"
        );
        text.lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    #[test]
    fn an_effort_pick_on_a_live_session_is_an_apply_flag_settings_request_resolved_by_its_answer() {
        let mut session = ChatSession::new("proj");
        let capture = session.set_test_stdin_capture();
        let answerer = answer_the_pending_request(session.control.clone(), |id| {
            serde_json::json!({
                "type": "control_response",
                "response": { "subtype": "success", "request_id": id },
            })
        });

        let applied = session
            .control_handle()
            .expect("a live session")
            .apply_effort("low");

        assert_eq!(applied, Ok(()));
        assert_eq!(answerer.join().unwrap(), control_channel::Routed::Delivered);
        assert!(
            !session.model_settled.is_settled(),
            "an effort pick leaves the soft-impose armed"
        );
        assert!(session.control.pending_ids().is_empty());
        drop(session);
        let written = lines_written_until_stdin_closed(capture);
        assert_eq!(written.len(), 1, "one request, no /effort input");
        assert_eq!(written[0]["type"], "control_request");
        assert_eq!(
            written[0]["request"],
            serde_json::json!({
                "subtype": "apply_flag_settings",
                "settings": { "effortLevel": "low" },
            })
        );
    }

    #[test]
    fn an_effort_pick_after_the_process_output_ended_fails_at_once_and_writes_nothing() {
        let mut session = ChatSession::new("proj");
        let capture = session.set_test_stdin_capture();
        let handle = session.control_handle().expect("stdin is still open");
        session.control.close();
        let started = std::time::Instant::now();

        let applied = handle.apply_effort("low");

        assert_eq!(applied, Err(control_channel::ControlError::SessionEnded));
        assert!(started.elapsed() < control_channel::APPLY_EFFORT_TIMEOUT / 2);
        drop(handle);
        drop(session);
        assert!(lines_written_until_stdin_closed(capture).is_empty());
    }

    #[test]
    fn an_effort_pick_claude_code_rejects_fails_with_its_text() {
        let mut session = ChatSession::new("proj");
        session.set_test_stdin_sink(Vec::new());
        let answerer = answer_the_pending_request(session.control.clone(), |id| {
            serde_json::json!({
                "type": "control_response",
                "response": {
                    "subtype": "error",
                    "request_id": id,
                    "error": "effortLevel is not supported",
                },
            })
        });

        let applied = session
            .control_handle()
            .expect("a live session")
            .apply_effort("max");

        assert_eq!(
            applied,
            Err(control_channel::ControlError::Rejected(
                "effortLevel is not supported".to_string()
            ))
        );
        answerer.join().unwrap();
    }

    #[test]
    fn an_unanswered_effort_pick_times_out_and_forgets_its_waiter() {
        let mut session = ChatSession::new("proj");
        session.set_test_stdin_sink(Vec::new());

        let applied = session
            .control_handle()
            .expect("a live session")
            .apply_effort_within("high", std::time::Duration::from_millis(30));

        assert_eq!(
            applied,
            Err(control_channel::ControlError::Timeout {
                subtype: "apply_flag_settings",
                timeout: std::time::Duration::from_millis(30),
            })
        );
        assert!(session.control.pending_ids().is_empty());
    }

    #[test]
    fn an_effort_pick_that_cannot_reach_the_process_reports_the_write_failure() {
        let mut session = ChatSession::new("proj");
        session.set_test_stdin_broken_pipe();

        let applied = session
            .control_handle()
            .expect("a session with a pipe")
            .apply_effort("low");

        assert!(
            matches!(applied, Err(control_channel::ControlError::Write(_))),
            "{applied:?}"
        );
        assert!(session.control.pending_ids().is_empty());
    }

    #[test]
    fn an_effort_pick_on_a_stopped_session_fails_its_waiter_at_once() {
        let mut session = ChatSession::new("proj");
        session.set_test_stdin_sink(Vec::new());
        let handle = session.control_handle().expect("a live session");
        let control = session.control.clone();
        let stopper = std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            while control.pending_ids().is_empty() {
                assert!(std::time::Instant::now() < deadline);
                std::thread::yield_now();
            }
            control.close();
        });
        let started = std::time::Instant::now();

        let applied = handle.apply_effort("low");

        stopper.join().unwrap();
        assert_eq!(applied, Err(control_channel::ControlError::SessionEnded));
        assert!(started.elapsed() < control_channel::APPLY_EFFORT_TIMEOUT / 2);
    }

    #[test]
    fn a_typed_model_pick_settles_under_the_stdin_lock_before_it_is_written() {
        let source = include_str!("chat.rs");
        let body_of = |signature: &str, end: &str| -> String {
            let start = source.find(signature).expect("function exists");
            let body = &source[start..];
            body[..body.find(end).expect("end marker")]
                .split_whitespace()
                .collect()
        };
        let send = body_of("fn send_message_with_emit(", "fn set_test_stdin_sink(");
        let at = |body: &str, needle: &str| {
            body.find(needle)
                .unwrap_or_else(|| panic!("the send path must use `{needle}`"))
        };
        let locked = at(&send, "letmutstdin=shared.lock()");
        let settled = at(&send, "self.model_settled.settle();");
        let written = at(&send, "writeln!(stdin,\"{}\",serialized)?;");
        assert!(locked < settled && settled < written);

        let drain = body_of("fn write_and_emit_drained_message(", "#[cfg(test)]");
        let locked = at(&drain, "matchstdin.lock(){Ok(muthandle)=>{");
        let settled = at(&drain, "settled.settle();");
        let written = at(&drain, "writeln!(handle,\"{}\",payload)");
        assert!(locked < settled && settled < written);
    }

    const ROUTED_PICK: &str = "openrouter/openai/gpt-4o-mini";
    const ENV_MODEL: &str = "openrouter/anthropic/claude-sonnet-5";

    fn openrouter_mini() -> SoftImposeConfig {
        SoftImposeConfig {
            kind: speedwave_runtime::config::LlmProviderKind::OpenRouter,
            entry_id: "openrouter".to_string(),
            entry_model: Some("openai/gpt-4o-mini".to_string()),
        }
    }

    #[test]
    fn the_answer_to_a_soft_impose_reaches_its_waiter_and_not_the_chat() {
        let stdin = Mutex::new(Vec::<u8>::new());
        let control = ControlChannel::default();
        let (pending, model) = soft_impose_step(
            &init_with_model(ENV_MODEL),
            &init_chunk(ENV_MODEL),
            &openrouter_mini(),
            &ModelSettled::default(),
            &control,
            &stdin,
        )
        .expect("a mismatch is soft-imposed");
        let answer = serde_json::json!({
            "type": "control_response",
            "response": {
                "subtype": "success",
                "request_id": written_lines(&stdin)[0]["request_id"],
            },
        });

        assert!(consume_control_response(&control, &answer));
        assert_eq!(
            pending.wait(std::time::Duration::from_secs(5)),
            Ok(serde_json::Value::Null)
        );
        assert_eq!(model, ROUTED_PICK);
    }

    const SOFT_IMPOSE_CAPTURE: &str =
        include_str!("../tests/fixtures/cc-2.1.282-soft-impose.sanitized.ndjson");
    const MID_TURN_COMMAND_CAPTURE: &str =
        include_str!("../tests/fixtures/cc-2.1.282-model-command-mid-tool-turn.sanitized.ndjson");
    const MODEL_PICKS_CAPTURE: &str =
        include_str!("../tests/fixtures/cc-2.1.282-model-picks.sanitized.ndjson");
    const MODEL_PICKS_REQUESTS: &str =
        include_str!("../tests/fixtures/cc-2.1.282-model-picks-requests.sanitized.json");

    #[test]
    fn set_model_checks_a_catalog_id_with_a_one_token_request_and_default_with_none() {
        let capture: serde_json::Value = serde_json::from_str(MODEL_PICKS_REQUESTS).unwrap();
        assert_eq!(
            capture["claude_code_version"],
            speedwave_runtime::defaults::CLAUDE_VERSION,
            "re-capture the model-picks requests with the new Claude Code pin"
        );
        let requests = capture["requests"].as_array().unwrap();
        let checks: Vec<(usize, &serde_json::Value)> = requests
            .iter()
            .enumerate()
            .filter(|(_, r)| r["max_tokens"] == 1)
            .collect();

        assert_eq!(checks.len(), 1, "{requests:?}");
        let (index, check) = checks[0];
        assert_eq!(index, 1, "the check follows the first turn: {requests:?}");
        assert_eq!(check["model"], "claude-haiku-4-5");
        assert_eq!(check["stream"], serde_json::Value::Null);
        assert_eq!(
            requests.len(),
            4,
            "one request per turn plus the check: {requests:?}"
        );
    }

    fn capture_lines(capture: &str) -> Vec<serde_json::Value> {
        capture
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    fn init_models(lines: &[serde_json::Value]) -> Vec<String> {
        lines
            .iter()
            .filter(|l| l["type"] == "system" && l["subtype"] == "init")
            .map(|l| l["model"].as_str().unwrap().to_string())
            .collect()
    }

    #[test]
    fn the_soft_impose_captures_are_of_the_pinned_claude_code() {
        for capture in [
            SOFT_IMPOSE_CAPTURE,
            MID_TURN_COMMAND_CAPTURE,
            MODEL_PICKS_CAPTURE,
        ] {
            let versions: Vec<String> = capture_lines(capture)
                .iter()
                .filter(|l| l["type"] == "system" && l["subtype"] == "init")
                .map(|l| l["claude_code_version"].as_str().unwrap().to_string())
                .collect();
            assert!(!versions.is_empty());
            assert!(
                versions
                    .iter()
                    .all(|v| v == speedwave_runtime::defaults::CLAUDE_VERSION),
                "re-capture the soft-impose streams from Claude Code {} (got {versions:?})",
                speedwave_runtime::defaults::CLAUDE_VERSION
            );
        }
    }

    #[test]
    fn set_model_switches_to_an_anthropic_id_and_back_to_the_account_default() {
        let lines = capture_lines(MODEL_PICKS_CAPTURE);
        let answers: Vec<&str> = lines
            .iter()
            .filter(|l| l["type"] == "control_response")
            .map(|l| l["response"]["subtype"].as_str().unwrap())
            .collect();
        let confirmations: Vec<&str> = lines
            .iter()
            .filter_map(|l| l["message"]["content"].as_str())
            .collect();

        assert_eq!(answers, vec!["success", "success"]);
        assert_eq!(
            confirmations,
            vec![
                "<local-command-stdout>Set model to `claude-haiku-4-5`</local-command-stdout>",
                "<local-command-stdout>Set model to `claude-opus-5-5[1m]`</local-command-stdout>",
            ]
        );
        assert_eq!(
            init_models(&lines)[..3],
            [
                "claude-opus-5-5[1m]",
                "claude-haiku-4-5",
                "claude-opus-5-5[1m]"
            ]
        );
    }

    #[test]
    fn a_typed_model_command_answers_as_an_input_of_its_own() {
        let lines = capture_lines(MODEL_PICKS_CAPTURE);
        let tail: Vec<String> = lines
            .iter()
            .filter(|l| l["type"] != "stream_event" && l["subtype"] != "status")
            .rev()
            .take(3)
            .map(|l| match l["type"].as_str().unwrap() {
                "assistant" => format!("assistant {}", l["message"]["model"].as_str().unwrap()),
                "result" => format!("result {}", l["num_turns"]),
                other => format!("{other} {}", l["subtype"].as_str().unwrap_or("")),
            })
            .collect();
        let mut parser = StreamParser::new();
        let turn_ends = lines
            .iter()
            .flat_map(|l| parser.parse_line(l).0)
            .filter(|c| matches!(c, StreamChunk::Result { .. }))
            .count();

        assert_eq!(
            tail,
            vec!["result 0", "assistant <synthetic>", "system init"]
        );
        assert_eq!(
            turn_ends, 4,
            "the typed command's answer is a turn end in the chat, the two switches are not"
        );
    }

    #[test]
    fn a_model_command_written_during_a_tool_using_turn_runs_after_it_as_an_input_of_its_own() {
        let lines = capture_lines(MID_TURN_COMMAND_CAPTURE);
        let results: Vec<u64> = lines
            .iter()
            .filter(|l| l["type"] == "result")
            .map(|l| l["num_turns"].as_u64().unwrap())
            .collect();
        let mut parser = StreamParser::new();
        let turn_ends = lines
            .iter()
            .flat_map(|l| parser.parse_line(l).0)
            .filter(|c| matches!(c, StreamChunk::Result { .. }))
            .count();

        assert_eq!(
            results,
            vec![2, 0, 1],
            "the tool-using turn, then the queued /model's own answer, then the next message"
        );
        assert_eq!(init_models(&lines), vec![ENV_MODEL, ENV_MODEL, ROUTED_PICK]);
        assert_eq!(
            turn_ends, 3,
            "the command's answer is a turn end in the chat, which is why no switch is a /model input"
        );
    }

    #[test]
    fn a_set_model_soft_impose_switches_the_running_turn_and_adds_nothing_to_the_chat() {
        let cfg = openrouter_mini();
        let mut parser = StreamParser::new();
        let settled = ModelSettled::default();
        let control = ControlChannel::default();
        let stdin = Mutex::new(Vec::<u8>::new());
        let mut emitted: Vec<StreamChunk> = Vec::new();
        let mut sent = Vec::new();
        let mut routed_answers = 0;
        let mut confirmations = 0;

        for mut parsed in capture_lines(SOFT_IMPOSE_CAPTURE) {
            if parsed["type"] == "control_response" {
                parsed["response"]["request_id"] = written_lines(&stdin)[0]["request_id"].clone();
            }
            if consume_control_response(&control, &parsed) {
                routed_answers += 1;
                continue;
            }
            let (chunks, _log) = parser.parse_line(&parsed);
            if parsed["message"]["content"]
                .as_str()
                .is_some_and(|c| c.starts_with("<local-command-stdout>"))
            {
                confirmations += 1;
                assert!(chunks.is_empty(), "{chunks:?}");
            }
            if let Some(step) = soft_impose_step(&parsed, &chunks, &cfg, &settled, &control, &stdin)
            {
                sent.push(step);
            }
            emitted.extend(chunks);
        }

        assert_eq!(sent.len(), 1, "one set_model, at the first init");
        assert_eq!(confirmations, 1, "the confirmation line makes no chunk");
        let (pending, model) = sent.remove(0);
        assert_eq!(model, ROUTED_PICK);
        assert_eq!(routed_answers, 1);
        assert_eq!(
            pending.wait(std::time::Duration::from_secs(1)),
            Ok(serde_json::Value::Null),
            "the captured answer resolves the request"
        );
        let turn_ends: Vec<(Option<String>, Option<String>)> = emitted
            .iter()
            .filter_map(|c| match c {
                StreamChunk::Result {
                    result_text, model, ..
                } => Some((result_text.clone(), model.clone())),
                StreamChunk::Error { content, .. } => Some((Some(content.clone()), None)),
                _ => None,
            })
            .collect();
        assert_eq!(
            turn_ends,
            vec![
                (
                    Some("stub reply".to_string()),
                    Some(ROUTED_PICK.to_string())
                ),
                (
                    Some("stub reply".to_string()),
                    Some(ROUTED_PICK.to_string())
                ),
            ],
            "only the user's two turns end, and the first already ends on the pick"
        );
        let emitted_inits: Vec<&str> = emitted
            .iter()
            .filter_map(|c| match c {
                StreamChunk::SystemInit { model, .. } => Some(model.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(emitted_inits, vec![ENV_MODEL, ROUTED_PICK]);
        assert!(
            !emitted
                .iter()
                .any(|c| matches!(c, StreamChunk::UserMessageCommit { .. })),
            "the set_model confirmation line adds no user message"
        );
    }

    #[test]
    fn parse_text_delta_produces_text_chunk() {
        let mut parser = StreamParser::new();
        let line = r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello world"}}}"#;
        let chunk = parse_line_str(&mut parser, line).unwrap();
        match chunk {
            StreamChunk::Text { content } => assert_eq!(content, "Hello world"),
            other => panic!("expected Text, got {other:?}"),
        }
    }

    #[test]
    fn parse_thinking_delta_emits_thinking_chunk() {
        let mut parser = StreamParser::new();
        let line = r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"Let me think..."}}}"#;
        let chunk = parse_line_str(&mut parser, line).unwrap();
        match chunk {
            StreamChunk::Thinking { content } => assert_eq!(content, "Let me think..."),
            other => panic!("expected Thinking, got {other:?}"),
        }
    }

    #[test]
    fn parse_thinking_block_start_emits_empty_thinking() {
        let mut parser = StreamParser::new();
        let line = r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}}"#;
        let chunk = parse_line_str(&mut parser, line).unwrap();
        match chunk {
            StreamChunk::Thinking { content } => assert_eq!(content, ""),
            other => panic!("expected Thinking, got {other:?}"),
        }
    }

    #[test]
    fn parse_tool_use_with_input_json_delta_correlates_by_index() {
        let mut parser = StreamParser::new();

        let start = r#"{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_01ABC","name":"Read","input":{}}}}"#;
        let chunk = parse_line_str(&mut parser, start).unwrap();
        match &chunk {
            StreamChunk::ToolStart { tool_id, tool_name } => {
                assert_eq!(tool_id, "toolu_01ABC");
                assert_eq!(tool_name, "Read");
            }
            other => panic!("expected ToolStart, got {other:?}"),
        }

        let delta = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"file_path\":\"/src/main.rs\"}"}}}"#;
        let chunk = parse_line_str(&mut parser, delta).unwrap();
        match chunk {
            StreamChunk::ToolInputDelta {
                tool_id,
                partial_json,
            } => {
                assert_eq!(tool_id, "toolu_01ABC");
                assert_eq!(partial_json, r#"{"file_path":"/src/main.rs"}"#);
            }
            other => panic!("expected ToolInputDelta, got {other:?}"),
        }
    }

    #[test]
    fn parse_input_json_delta_without_matching_start_returns_none() {
        let mut parser = StreamParser::new();
        let delta = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":5,"delta":{"type":"input_json_delta","partial_json":"{}"}}}"#;
        assert!(parse_line_str(&mut parser, delta).is_none());
    }

    #[test]
    fn parse_content_block_stop_cleans_up_active_blocks() {
        let mut parser = StreamParser::new();

        let start = r#"{"type":"stream_event","event":{"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_X","name":"Bash","input":{}}}}"#;
        parse_line_str(&mut parser, start);

        let stop = r#"{"type":"stream_event","event":{"type":"content_block_stop","index":2}}"#;
        parse_line_str(&mut parser, stop);

        let delta = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{}"}}}"#;
        assert!(parse_line_str(&mut parser, delta).is_none());
    }

    #[test]
    fn parse_message_stop_resets_parser_state() {
        let mut parser = StreamParser::new();

        let start = r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_Y","name":"Edit","input":{}}}}"#;
        parse_line_str(&mut parser, start);

        let stop = r#"{"type":"stream_event","event":{"type":"message_stop"}}"#;
        parse_line_str(&mut parser, stop);

        assert!(parser.active_blocks.is_empty());
    }

    const MESSAGE_START_LINE: &str = r#"{"type":"stream_event","event":{"type":"message_start","message":{"id":"msg_next","role":"assistant","content":[]}}}"#;

    #[test]
    fn parse_message_start_resets_parser_state() {
        let mut parser = StreamParser::new();
        let start = r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_Y","name":"Edit","input":{}}}}"#;
        parse_line_str(&mut parser, start);
        parse_line_str(&mut parser, MESSAGE_START_LINE);
        assert!(parser.active_blocks.is_empty());
    }

    #[test]
    fn message_start_clears_stale_blocks_from_an_interrupted_turn() {
        let mut parser = StreamParser::new();
        let start = r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_OLD","name":"Read","input":{}}}}"#;
        parse_line_str(&mut parser, start);
        let result = r#"{"type":"result","subtype":"error_during_execution","session_id":"s","total_cost_usd":0.0,"usage":{}}"#;
        parse_line_str(&mut parser, result);
        parse_line_str(&mut parser, MESSAGE_START_LINE);
        assert!(parser.active_blocks.is_empty());

        let start2 = r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_NEW","name":"Edit","input":{}}}}"#;
        parse_line_str(&mut parser, start2);
        let delta = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"file\":\"x\"}"}}}"#;
        match parse_line_str(&mut parser, delta).expect("expected ToolInputDelta") {
            StreamChunk::ToolInputDelta { tool_id, .. } => assert_eq!(tool_id, "toolu_NEW"),
            other => panic!("expected ToolInputDelta for toolu_NEW, got {other:?}"),
        }
    }

    const TOOL_START_LINE: &str = r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_MID","name":"Write","input":{}}}}"#;
    const TOOL_DELTA_LINE: &str = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"file_path\":\"/x\"}"}}}"#;
    const TOOL_STOP_LINE: &str =
        r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0}}"#;

    #[test]
    fn mid_turn_system_line_keeps_streaming_tool_block() {
        let mut parser = StreamParser::new();
        parse_line_str(&mut parser, TOOL_START_LINE);
        let system =
            r#"{"type":"system","subtype":"task_progress","task_id":"t1","description":"bg"}"#;
        assert!(parse_line_all_str(&mut parser, system).is_empty());

        match parse_line_str(&mut parser, TOOL_DELTA_LINE) {
            Some(StreamChunk::ToolInputDelta {
                tool_id,
                partial_json,
            }) => {
                assert_eq!(tool_id, "toolu_MID");
                assert_eq!(partial_json, r#"{"file_path":"/x"}"#);
            }
            other => panic!("delta after a mid-turn system line must still route: {other:?}"),
        }

        let (_, log) = parse_line_full(&mut parser, TOOL_STOP_LINE);
        let log = log.expect("content_block_stop must log TOOL: stop");
        assert_eq!(log.prefix, "TOOL");
        assert_eq!(log.message, "stop: Write (toolu_MID)");
    }

    #[test]
    fn every_documented_mid_turn_system_subtype_keeps_block_state() {
        let subtypes = [
            "init",
            "status",
            "api_retry",
            "task_started",
            "task_progress",
            "task_notification",
            "hook_started",
            "hook_progress",
            "hook_response",
            "files_persisted",
            "session_state_changed",
        ];
        for subtype in subtypes {
            let mut parser = StreamParser::new();
            parse_line_str(&mut parser, TOOL_START_LINE);
            let line = format!(r#"{{"type":"system","subtype":"{subtype}"}}"#);
            parse_line_str(&mut parser, &line);
            assert!(
                parser.active_blocks.contains_key(&0),
                "system/{subtype} must not drop block state"
            );
        }
    }

    #[test]
    fn non_actionable_system_text_keeps_block_state() {
        let mut parser = StreamParser::new();
        parse_line_str(&mut parser, TOOL_START_LINE);
        let line = r#"{"type":"system","subtype":"status","message":"Compacting conversation"}"#;
        let (chunk, log) = parse_line_full(&mut parser, line);
        assert!(chunk.is_none());
        assert_eq!(log.expect("system text is logged").prefix, "SYSTEM");
        assert!(parser.active_blocks.contains_key(&0));
    }

    fn assistant_tool_use_line(parent: &str, content: &str) -> String {
        format!(
            r#"{{"type":"assistant","parent_tool_use_id":{parent},"message":{{"id":"msg_1","role":"assistant","content":[{content}],"usage":{{"input_tokens":1,"output_tokens":1}}}}}}"#
        )
    }

    #[test]
    fn assistant_line_emits_complete_input_per_tool_use_block_in_order() {
        let mut parser = StreamParser::new();
        let line = assistant_tool_use_line(
            "null",
            r#"{"type":"text","text":"Sending"},{"type":"tool_use","id":"toolu_A","name":"SendMessage","input":{"to":"ab97","message":"Any progress?"}},{"type":"tool_use","id":"toolu_B","name":"Bash","input":{}}"#,
        );
        let chunks = parse_line_all_str(&mut parser, &line);
        match chunks.as_slice() {
            [StreamChunk::ToolInputComplete {
                tool_id: a,
                input_json: ja,
            }, StreamChunk::ToolInputComplete {
                tool_id: b,
                input_json: jb,
            }] => {
                assert_eq!(a, "toolu_A");
                let parsed: serde_json::Value = serde_json::from_str(ja).unwrap();
                assert_eq!(
                    parsed,
                    serde_json::json!({"to":"ab97","message":"Any progress?"})
                );
                assert_eq!(b, "toolu_B");
                assert_eq!(jb, "{}");
            }
            other => panic!("expected two ToolInputComplete chunks, got {other:?}"),
        }
    }

    #[test]
    fn assistant_line_complete_input_round_trips_unicode_and_nesting() {
        let mut parser = StreamParser::new();
        let input = serde_json::json!({
            "prompt": "zażółć gęślą jaźń — \"quoted\"\n",
            "nested": {"list": [1, 2, {"k": null}]}
        });
        let line = assistant_tool_use_line(
            "null",
            &format!(r#"{{"type":"tool_use","id":"toolu_U","name":"Agent","input":{input}}}"#),
        );
        match parse_line_str(&mut parser, &line).expect("ToolInputComplete") {
            StreamChunk::ToolInputComplete { input_json, .. } => {
                let parsed: serde_json::Value = serde_json::from_str(&input_json).unwrap();
                assert_eq!(parsed, input);
            }
            other => panic!("expected ToolInputComplete, got {other:?}"),
        }
    }

    #[test]
    fn assistant_line_skips_sidechain_ask_user_and_malformed_tool_use_blocks() {
        let mut parser = StreamParser::new();
        let sidechain = assistant_tool_use_line(
            "\"toolu_parent\"",
            r#"{"type":"tool_use","id":"toolu_sub","name":"Read","input":{"file_path":"/x"}}"#,
        );
        assert!(
            parse_line_all_str(&mut parser, &sidechain).is_empty(),
            "subagent tools have no frontend block"
        );

        let ask = assistant_tool_use_line(
            "null",
            r#"{"type":"tool_use","id":"toolu_ask","name":"AskUserQuestion","input":{"questions":[]}}"#,
        );
        assert!(
            parse_line_all_str(&mut parser, &ask).is_empty(),
            "AskUserQuestion is served through control_request"
        );

        let malformed = assistant_tool_use_line(
            "null",
            r#"{"type":"tool_use","name":"Read","input":{"a":1}},{"type":"tool_use","id":"","name":"Read","input":{"a":1}},{"type":"tool_use","id":"toolu_noinput","name":"Read"},{"type":"tool_use","id":"toolu_str","name":"Read","input":"not an object"}"#,
        );
        assert!(parse_line_all_str(&mut parser, &malformed).is_empty());
    }

    #[test]
    fn assistant_line_without_content_array_emits_nothing_but_still_captures_uuid() {
        let mut parser = StreamParser::new();
        let line =
            r#"{"type":"assistant","message":{"id":"msg_9","role":"assistant","content":"plain"}}"#;
        assert!(parse_line_all_str(&mut parser, line).is_empty());
        assert_eq!(parser.pending_assistant_uuid.as_deref(), Some("msg_9"));
    }

    #[test]
    fn assistant_line_complete_input_follows_block_stop_in_reader_order() {
        let mut parser = StreamParser::new();
        parse_line_str(&mut parser, TOOL_START_LINE);
        parse_line_str(
            &mut parser,
            r#"{"type":"system","subtype":"hook_started","hook_name":"x"}"#,
        );
        parse_line_str(&mut parser, TOOL_STOP_LINE);
        let line = assistant_tool_use_line(
            "null",
            r#"{"type":"tool_use","id":"toolu_MID","name":"Write","input":{"file_path":"/x","content":"full"}}"#,
        );
        let chunks = parse_line_all_str(&mut parser, &line);
        assert!(matches!(
            chunks.as_slice(),
            [StreamChunk::ToolInputComplete { tool_id, .. }] if tool_id == "toolu_MID"
        ));
    }

    #[test]
    fn parse_user_tool_result_emits_tool_result() {
        let mut parser = StreamParser::new();
        let line = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_01ABC","content":"file contents here"}]}}"#;
        let chunk = parse_line_str(&mut parser, line).unwrap();
        match chunk {
            StreamChunk::ToolResult {
                tool_id,
                content,
                is_error,
            } => {
                assert_eq!(tool_id, "toolu_01ABC");
                assert_eq!(content, "file contents here");
                assert!(!is_error);
            }
            other => panic!("expected ToolResult, got {other:?}"),
        }
    }

    #[test]
    fn parse_user_multiple_tool_results_emit_one_chunk_each() {
        let mut parser = StreamParser::new();
        let line = r#"{"type":"user","message":{"role":"user","content":[
            {"type":"tool_result","tool_use_id":"t1","content":"ok"},
            {"type":"tool_result","tool_use_id":"t2","content":"boom","is_error":true}
        ]}}"#;
        let chunks = parse_line_all_str(&mut parser, line);
        assert_eq!(chunks.len(), 2, "each tool_result block must emit a chunk");
        match (&chunks[0], &chunks[1]) {
            (
                StreamChunk::ToolResult {
                    tool_id: id1,
                    is_error: e1,
                    ..
                },
                StreamChunk::ToolResult {
                    tool_id: id2,
                    is_error: e2,
                    ..
                },
            ) => {
                assert_eq!(id1, "t1");
                assert!(!e1);
                assert_eq!(id2, "t2");
                assert!(*e2);
            }
            other => panic!("expected two ToolResults, got {other:?}"),
        }
    }

    #[test]
    fn parse_user_multiple_tool_results_log_entry_covers_all() {
        let mut parser = StreamParser::new();
        let line = r#"{"type":"user","message":{"role":"user","content":[
            {"type":"tool_result","tool_use_id":"t1","content":"a"},
            {"type":"tool_result","tool_use_id":"t2","content":"b"}
        ]}}"#;
        let parsed: serde_json::Value = serde_json::from_str(line).unwrap();
        let (chunks, log) = parser.parse_line(&parsed);
        assert_eq!(chunks.len(), 2);
        let log = log.expect("tool results must produce a log entry");
        assert_eq!(log.prefix, "TOOL");
        assert!(log.message.contains("t1") && log.message.contains("t2"));
    }

    #[test]
    fn parse_user_malformed_tool_result_skips_block_not_siblings() {
        let mut parser = StreamParser::new();
        let line = r#"{"type":"user","message":{"role":"user","content":[
            {"type":"tool_result","content":"orphan"},
            {"type":"tool_result","tool_use_id":"t2","content":"ok"}
        ]}}"#;
        let chunks = parse_line_all_str(&mut parser, line);
        assert_eq!(chunks.len(), 1);
        match &chunks[0] {
            StreamChunk::ToolResult { tool_id, .. } => assert_eq!(tool_id, "t2"),
            other => panic!("expected ToolResult, got {other:?}"),
        }
    }

    #[test]
    fn parse_user_no_tool_results_emits_nothing() {
        let mut parser = StreamParser::new();
        let line =
            r#"{"type":"user","message":{"role":"user","content":[{"type":"image","source":{}}]}}"#;
        let parsed: serde_json::Value = serde_json::from_str(line).unwrap();
        let (chunks, log) = parser.parse_line(&parsed);
        assert!(chunks.is_empty());
        assert!(log.is_none(), "no tool_result → no TOOL log entry");
    }

    #[test]
    fn parse_user_tool_result_with_error_flag() {
        let mut parser = StreamParser::new();
        let line = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"command failed","is_error":true}]}}"#;
        let chunk = parse_line_str(&mut parser, line).unwrap();
        match chunk {
            StreamChunk::ToolResult { is_error, .. } => assert!(is_error),
            other => panic!("expected ToolResult, got {other:?}"),
        }
    }

    #[test]
    fn parse_user_tool_result_with_array_content() {
        let mut parser = StreamParser::new();
        let line = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":[{"type":"text","text":"line1"},{"type":"text","text":"line2"}]}]}}"#;
        let chunk = parse_line_str(&mut parser, line).unwrap();
        match chunk {
            StreamChunk::ToolResult { content, .. } => assert_eq!(content, "line1\nline2"),
            other => panic!("expected ToolResult, got {other:?}"),
        }
    }

    #[test]
    fn parse_result_extracts_cost_and_usage() {
        let mut parser = StreamParser::new();
        let line = r#"{"type":"result","session_id":"550e8400-e29b-41d4-a716-446655440000","total_cost_usd":0.015,"usage":{"input_tokens":500,"output_tokens":100,"cache_read_tokens":50},"is_error":false,"result":""}"#;
        let chunk = parse_line_str(&mut parser, line).unwrap();
        match chunk {
            StreamChunk::Result {
                session_id,
                total_cost,
                usage,
                result_text,
                context_window_size,
                assistant_uuid,
                ..
            } => {
                assert_eq!(session_id, "550e8400-e29b-41d4-a716-446655440000");
                assert_eq!(total_cost, Some(0.015));
                let u = usage.unwrap();
                assert_eq!(u.input_tokens, 500);
                assert_eq!(u.output_tokens, 100);
                assert_eq!(u.cache_read_tokens, Some(50));
                assert!(u.cache_write_tokens.is_none());
                assert!(result_text.is_none(), "empty result should produce None");
                assert!(context_window_size.is_none());
                assert!(
                    assistant_uuid.is_none(),
                    "no preceding 'assistant' event should leave assistant_uuid empty"
                );
            }
            other => panic!("expected Result, got {other:?}"),
        }
    }

    #[test]
    fn parse_result_with_legacy_cost_usd_only_produces_no_cost() {
        let mut parser = StreamParser::new();
        let line =
            r#"{"type":"result","session_id":"abc","is_error":false,"result":"","cost_usd":0.05}"#;
        let chunk = parse_line_str(&mut parser, line).unwrap();
        match chunk {
            StreamChunk::Result { total_cost, .. } => {
                assert!(
                    total_cost.is_none(),
                    "cost_usd alone should not populate total_cost"
                );
            }
            other => panic!("expected Result, got {other:?}"),
        }
    }

    #[test]
    fn parse_result_with_legacy_total_cost_fallback() {
        let mut parser = StreamParser::new();
        let line = r#"{"type":"result","session_id":"abc","is_error":false,"result":"","total_cost":0.042}"#;
        let chunk = parse_line_str(&mut parser, line).unwrap();
        match chunk {
            StreamChunk::Result { total_cost, .. } => {
                assert_eq!(
                    total_cost,
                    Some(0.042),
                    "total_cost should populate via the legacy fallback path when total_cost_usd is absent"
                );
            }
            other => panic!("expected Result, got {other:?}"),
        }
    }

    #[test]
    fn parse_result_with_flat_usage_and_model_usage() {
        let mut parser = StreamParser::new();
        let line = r#"{"type":"result","session_id":"abc","is_error":false,"total_cost_usd":0.078,"result":"","usage":{"input_tokens":3,"cache_read_input_tokens":11204,"cache_creation_input_tokens":11358,"output_tokens":65},"modelUsage":{"claude-opus-4-6[1m]":{"inputTokens":3,"cacheReadInputTokens":11204,"cacheCreationInputTokens":11358,"outputTokens":65,"contextWindow":1000000,"costUSD":0.078}}}"#;
        let chunk = parse_line_str(&mut parser, line).unwrap();
        match chunk {
            StreamChunk::Result {
                usage,
                context_window_size,
                total_cost,
                ..
            } => {
                let u = usage.unwrap();
                assert_eq!(u.input_tokens, 3);
                assert_eq!(u.output_tokens, 65);
                assert_eq!(u.cache_read_tokens, Some(11204));
                assert_eq!(u.cache_write_tokens, Some(11358));
                assert_eq!(context_window_size, Some(1_000_000));
                assert_eq!(total_cost, Some(0.078));
            }
            other => panic!("expected Result, got {other:?}"),
        }
    }

    #[test]
    fn parse_result_falls_back_to_dominant_model_when_no_conversation_model_known() {
        let mut parser = StreamParser::new();
        let line = r#"{"type":"result","session_id":"abc","is_error":false,"total_cost_usd":0.10,"result":"","modelUsage":{"claude-haiku-4-5-20251001":{"inputTokens":10,"outputTokens":50,"contextWindow":200000},"claude-opus-4-7":{"inputTokens":100,"outputTokens":500,"contextWindow":1000000}}}"#;
        let chunk = parse_line_str(&mut parser, line).unwrap();
        match chunk {
            StreamChunk::Result {
                model,
                context_window_size,
                ..
            } => {
                assert_eq!(
                    model.as_deref(),
                    Some("claude-opus-4-7"),
                    "with no conversation model known, must fall back to the highest-outputTokens key"
                );
                assert_eq!(
                    context_window_size,
                    Some(1_000_000),
                    "context_window_size must come from the same fallback model"
                );
            }
            other => panic!("expected Result, got {other:?}"),
        }
    }

    #[test]
    fn parse_result_chronological_model_wins_over_usage_dominant_old_model() {
        let mut parser = StreamParser::new();
        let init_a = r#"{"type":"system","subtype":"init","model":"model-a"}"#;
        parse_line_str(&mut parser, init_a);
        let init_b = r#"{"type":"system","subtype":"init","model":"model-b"}"#;
        parse_line_str(&mut parser, init_b);

        let line = r#"{"type":"result","session_id":"abc","is_error":false,"total_cost_usd":0.10,"result":"","modelUsage":{"model-a":{"inputTokens":1000,"outputTokens":5000,"contextWindow":200000},"model-b":{"inputTokens":10,"outputTokens":5,"contextWindow":1000000}}}"#;
        let chunk = parse_line_str(&mut parser, line).unwrap();
        match chunk {
            StreamChunk::Result {
                model,
                context_window_size,
                ..
            } => {
                assert_eq!(model.as_deref(), Some("model-b"));
                assert_eq!(context_window_size, Some(1_000_000));
            }
            other => panic!("expected Result, got {other:?}"),
        }
    }

    #[test]
    fn parse_result_does_not_revert_tracker_on_later_plain_usage_turn() {
        let mut parser = StreamParser::new();
        let assistant_a =
            r#"{"type":"assistant","message":{"id":"msg_a","model":"model-a","usage":{}}}"#;
        parse_line_all_str(&mut parser, assistant_a);
        let assistant_b =
            r#"{"type":"assistant","message":{"id":"msg_b","model":"model-b","usage":{}}}"#;
        parse_line_all_str(&mut parser, assistant_b);

        let result_line = r#"{"type":"result","session_id":"abc","is_error":false,"total_cost_usd":0.10,"result":"","modelUsage":{"model-a":{"inputTokens":1000,"outputTokens":5000,"contextWindow":200000},"model-b":{"inputTokens":10,"outputTokens":5,"contextWindow":1000000}}}"#;
        let chunk = parse_line_str(&mut parser, result_line).unwrap();
        match chunk {
            StreamChunk::Result { model, .. } => {
                assert_eq!(model.as_deref(), Some("model-b"));
            }
            other => panic!("expected Result, got {other:?}"),
        }

        assert_eq!(
            parser.model_tracker.resolve(),
            Some("model-b"),
            "the result event must not re-seed the tracker back to the \
             cumulative-dominant model-a"
        );

        let interrupt_line = r#"{"type":"result","session_id":"abc","is_error":false,"result":""}"#;
        let interrupt_chunk = parse_line_str(&mut parser, interrupt_line).unwrap();
        match interrupt_chunk {
            StreamChunk::Result { model, .. } => {
                assert_eq!(model.as_deref(), Some("model-b"));
            }
            other => panic!("expected Result, got {other:?}"),
        }
    }

    #[test]
    fn parse_result_plain_usage_only_turn_still_resolves_model_for_context_window() {
        let mut parser = StreamParser::new();
        assert!(parser.model_tracker.resolve().is_none());

        let line = r#"{"type":"result","session_id":"abc","is_error":false,"total_cost_usd":0.05,"result":"","modelUsage":{"model-only":{"inputTokens":10,"outputTokens":10,"contextWindow":123456}}}"#;
        let chunk = parse_line_str(&mut parser, line).unwrap();
        match chunk {
            StreamChunk::Result {
                model,
                context_window_size,
                ..
            } => {
                assert_eq!(model.as_deref(), Some("model-only"));
                assert_eq!(context_window_size, Some(123_456));
            }
            other => panic!("expected Result, got {other:?}"),
        }
        assert_eq!(parser.model_tracker.resolve(), Some("model-only"));
    }

    #[test]
    fn parse_line_assistant_model_feeds_result_without_modelusage() {
        let mut parser = StreamParser::new();
        let assistant =
            r#"{"type":"assistant","message":{"id":"msg_1","model":"model-observed","usage":{}}}"#;
        parse_line_all_str(&mut parser, assistant);

        let line = r#"{"type":"result","session_id":"abc","is_error":false,"result":""}"#;
        let chunk = parse_line_str(&mut parser, line).unwrap();
        match chunk {
            StreamChunk::Result { model, .. } => {
                assert_eq!(model.as_deref(), Some("model-observed"));
            }
            other => panic!("expected Result, got {other:?}"),
        }
    }

    #[test]
    fn parse_line_sidechain_assistant_model_does_not_override_main_chain() {
        let mut parser = StreamParser::new();
        let init_a = r#"{"type":"system","subtype":"init","model":"model-a"}"#;
        parse_line_str(&mut parser, init_a);
        let sidechain = r#"{"type":"assistant","isSidechain":true,"message":{"id":"msg_sub","model":"claude-haiku-4-5-20251001","usage":{}}}"#;
        parse_line_all_str(&mut parser, sidechain);

        let line = r#"{"type":"result","session_id":"abc","is_error":false,"result":"","modelUsage":{"model-a":{"inputTokens":10,"outputTokens":10,"contextWindow":200000}}}"#;
        let chunk = parse_line_str(&mut parser, line).unwrap();
        match chunk {
            StreamChunk::Result {
                model,
                context_window_size,
                ..
            } => {
                assert_eq!(model.as_deref(), Some("model-a"));
                assert_eq!(context_window_size, Some(200_000));
            }
            other => panic!("expected Result, got {other:?}"),
        }
    }

    #[test]
    fn synthetic_confirmation_after_a_chip_send_emits_no_chunk() {
        let mut parser = StreamParser::new();
        let synthetic_line = r#"{"type":"assistant","message":{"id":"u_synth_1","role":"assistant","model":"<synthetic>","content":[{"type":"text","text":"Set model to Sonnet 5 for this session only"}]}}"#;
        let chunks = parse_line_all_str(&mut parser, synthetic_line);
        assert!(
            chunks.is_empty(),
            "the synthetic confirmation must produce no chunk, got {chunks:?}"
        );
    }

    #[test]
    fn parse_result_uses_conversation_model_window_not_the_dominant_subagent_model() {
        let mut parser = StreamParser::new();
        parse_line_str(
            &mut parser,
            r#"{"type":"system","subtype":"init","model":"claude-fable-5"}"#,
        );

        let line = r#"{"type":"result","session_id":"abc","is_error":false,"total_cost_usd":0.10,"result":"","modelUsage":{"claude-haiku-4-5-20251001":{"inputTokens":10,"outputTokens":5000,"contextWindow":200000},"claude-fable-5":{"inputTokens":100,"outputTokens":100,"contextWindow":1000000}}}"#;
        let chunk = parse_line_str(&mut parser, line).unwrap();
        match chunk {
            StreamChunk::Result {
                model,
                context_window_size,
                ..
            } => {
                assert_eq!(
                    model.as_deref(),
                    Some("claude-fable-5"),
                    "the conversation model must win even though the Haiku subagent produced more output"
                );
                assert_eq!(
                    context_window_size,
                    Some(1_000_000),
                    "context_window_size must be the conversation model's window, not the dominant subagent's 200k"
                );
            }
            other => panic!("expected Result, got {other:?}"),
        }
    }

    #[test]
    fn parse_result_main_chain_assistant_model_supersedes_systeminit() {
        let mut parser = StreamParser::new();
        parse_line_str(
            &mut parser,
            r#"{"type":"system","subtype":"init","model":"claude-opus-4-7"}"#,
        );
        parse_line_str(
            &mut parser,
            r#"{"type":"assistant","parent_tool_use_id":null,"message":{"id":"msg_1","model":"claude-sonnet-4-6","role":"assistant"}}"#,
        );

        let line = r#"{"type":"result","session_id":"abc","is_error":false,"total_cost_usd":0.10,"result":"","modelUsage":{"claude-opus-4-7":{"inputTokens":10,"outputTokens":5000,"contextWindow":500000},"claude-sonnet-4-6":{"inputTokens":100,"outputTokens":100,"contextWindow":750000}}}"#;
        let chunk = parse_line_str(&mut parser, line).unwrap();
        match chunk {
            StreamChunk::Result {
                model,
                context_window_size,
                ..
            } => {
                assert_eq!(model.as_deref(), Some("claude-sonnet-4-6"));
                assert_eq!(
                    context_window_size,
                    Some(750_000),
                    "must use sonnet's window, not opus's higher-outputTokens entry"
                );
            }
            other => panic!("expected Result, got {other:?}"),
        }
    }

    #[test]
    fn parse_result_ignores_sidechain_assistant_model() {
        let mut parser = StreamParser::new();
        parse_line_str(
            &mut parser,
            r#"{"type":"system","subtype":"init","model":"claude-fable-5"}"#,
        );
        parse_line_str(
            &mut parser,
            r#"{"type":"assistant","parent_tool_use_id":"toolu_1","message":{"id":"msg_1","model":"claude-haiku-4-5","role":"assistant"}}"#,
        );
        parse_line_str(
            &mut parser,
            r#"{"type":"assistant","isSidechain":true,"message":{"id":"msg_2","model":"claude-haiku-4-5","role":"assistant"}}"#,
        );

        let line = r#"{"type":"result","session_id":"abc","is_error":false,"total_cost_usd":0.10,"result":"","modelUsage":{"claude-haiku-4-5":{"inputTokens":10,"outputTokens":5000,"contextWindow":200000},"claude-fable-5":{"inputTokens":100,"outputTokens":100,"contextWindow":1000000}}}"#;
        let chunk = parse_line_str(&mut parser, line).unwrap();
        match chunk {
            StreamChunk::Result {
                model,
                context_window_size,
                ..
            } => {
                assert_eq!(
                    model.as_deref(),
                    Some("claude-fable-5"),
                    "a sidechain assistant event must never move the conversation model"
                );
                assert_eq!(context_window_size, Some(1_000_000));
            }
            other => panic!("expected Result, got {other:?}"),
        }
    }

    #[test]
    fn parse_result_context_window_none_when_conversation_model_absent_from_modelusage() {
        let mut parser = StreamParser::new();
        parse_line_str(
            &mut parser,
            r#"{"type":"system","subtype":"init","model":"claude-fable-5"}"#,
        );

        let line = r#"{"type":"result","session_id":"abc","is_error":false,"total_cost_usd":0.10,"result":"","modelUsage":{"claude-haiku-4-5":{"inputTokens":10,"outputTokens":5000,"contextWindow":200000}}}"#;
        let chunk = parse_line_str(&mut parser, line).unwrap();
        match chunk {
            StreamChunk::Result {
                model,
                context_window_size,
                ..
            } => {
                assert_eq!(model.as_deref(), Some("claude-fable-5"));
                assert!(
                    context_window_size.is_none(),
                    "must be None so the frontend falls back to the Anthropic SSOT instead of a subagent's window"
                );
            }
            other => panic!("expected Result, got {other:?}"),
        }
    }

    #[test]
    fn parse_result_conversation_model_persists_across_turns_without_modelusage() {
        let mut parser = StreamParser::new();
        parse_line_str(
            &mut parser,
            r#"{"type":"system","subtype":"init","model":"claude-fable-5"}"#,
        );
        let first = r#"{"type":"result","session_id":"abc","is_error":false,"total_cost_usd":0.10,"result":"","modelUsage":{"claude-haiku-4-5-20251001":{"inputTokens":10,"outputTokens":5000,"contextWindow":200000},"claude-fable-5":{"inputTokens":100,"outputTokens":100,"contextWindow":1000000}}}"#;
        parse_line_str(&mut parser, first);

        let second = r#"{"type":"result","session_id":"abc","is_error":false,"total_cost_usd":0.11,"result":""}"#;
        let chunk = parse_line_str(&mut parser, second).unwrap();
        match chunk {
            StreamChunk::Result { model, .. } => {
                assert_eq!(model.as_deref(), Some("claude-fable-5"));
            }
            other => panic!("expected Result, got {other:?}"),
        }
    }

    #[test]
    fn capture_assistant_model_ignores_empty_or_missing_model() {
        let mut parser = StreamParser::new();
        parse_line_str(
            &mut parser,
            r#"{"type":"system","subtype":"init","model":"claude-fable-5"}"#,
        );
        parse_line_str(
            &mut parser,
            r#"{"type":"assistant","message":{"id":"msg_1","model":"","role":"assistant"}}"#,
        );
        parse_line_str(
            &mut parser,
            r#"{"type":"assistant","message":{"id":"msg_2","role":"assistant"}}"#,
        );

        let line = r#"{"type":"result","session_id":"abc","is_error":false,"result":"","total_cost_usd":0.01}"#;
        let chunk = parse_line_str(&mut parser, line).unwrap();
        match chunk {
            StreamChunk::Result { model, .. } => {
                assert_eq!(model.as_deref(), Some("claude-fable-5"));
            }
            other => panic!("expected Result, got {other:?}"),
        }
    }

    #[test]
    fn parse_result_error_produces_error_chunk() {
        let mut parser = StreamParser::new();
        let line = r#"{"type":"result","is_error":true,"result":"Something went wrong"}"#;
        let (chunk, log_entry) = parse_line_full(&mut parser, line);
        match chunk.unwrap() {
            StreamChunk::Error {
                content,
                turn_ended,
            } => {
                assert_eq!(content, "Something went wrong");
                assert!(
                    turn_ended,
                    "an is_error result ends the turn of a live process"
                );
            }
            other => panic!("expected Error, got {other:?}"),
        }
        let entry = log_entry.expect("error result must produce a log entry");
        assert_eq!(entry.prefix, "RESULT");
        assert_eq!(entry.message, "error: Something went wrong");
    }
    #[test]
    fn parse_result_error_with_empty_result_returns_placeholder_error() {
        let mut parser = StreamParser::new();
        for line in [
            r#"{"type":"result","is_error":true,"result":""}"#,
            r#"{"type":"result","is_error":true}"#,
        ] {
            let (chunk, log_entry) = parse_line_full(&mut parser, line);
            let chunk = chunk.unwrap_or_else(|| {
                panic!(
                    "empty/missing error result must now produce a chunk, not be dropped: {line}"
                )
            });
            let content = match chunk {
                StreamChunk::Error { content, .. } => {
                    assert!(
                        !content.trim().is_empty(),
                        "placeholder content must be non-empty so the UI has something to render"
                    );
                    content
                }
                other => panic!("expected Error chunk, got {other:?}"),
            };
            let entry = log_entry
                .unwrap_or_else(|| panic!("empty/missing error result must also log: {line}"));
            assert_eq!(entry.prefix, "RESULT");
            assert_eq!(entry.message, format!("error: {content}"));
        }
    }

    #[test]
    fn parse_result_without_usage_or_cost() {
        let mut parser = StreamParser::new();
        let line = r#"{"type":"result","is_error":false,"result":"","session_id":"abc"}"#;
        let chunk = parse_line_str(&mut parser, line).unwrap();
        match chunk {
            StreamChunk::Result {
                total_cost, usage, ..
            } => {
                assert!(total_cost.is_none());
                assert!(usage.is_none());
            }
            other => panic!("expected Result, got {other:?}"),
        }
    }

    #[test]
    fn parse_assistant_type_emits_no_chunk() {
        let mut parser = StreamParser::new();
        let line = r#"{"type":"assistant","message":{"role":"assistant","content":[]}}"#;
        assert!(parse_line_str(&mut parser, line).is_none());
        assert!(
            parser.pending_assistant_uuid.is_none(),
            "missing message.id must leave pending_assistant_uuid empty"
        );
    }

    #[test]
    fn parse_assistant_with_id_captures_pending_uuid() {
        let mut parser = StreamParser::new();
        let line =
            r#"{"type":"assistant","message":{"id":"msg_abc123","role":"assistant","content":[]}}"#;
        let chunks = parse_line_all_str(&mut parser, line);
        assert!(chunks.is_empty(), "assistant event must not emit chunks");
        assert_eq!(parser.pending_assistant_uuid.as_deref(), Some("msg_abc123"));
    }

    #[test]
    fn result_commits_pending_assistant_uuid_and_clears_it() {
        let mut parser = StreamParser::new();
        let assistant =
            r#"{"type":"assistant","message":{"id":"msg_turn1","role":"assistant","content":[]}}"#;
        let result = r#"{"type":"result","session_id":"550e8400-e29b-41d4-a716-446655440000","total_cost_usd":0.01,"usage":{"input_tokens":1,"output_tokens":1},"is_error":false,"result":""}"#;

        parse_line_str(&mut parser, assistant);
        let chunk = parse_line_str(&mut parser, result).unwrap();
        match chunk {
            StreamChunk::Result { assistant_uuid, .. } => {
                assert_eq!(assistant_uuid.as_deref(), Some("msg_turn1"));
            }
            other => panic!("expected Result, got {other:?}"),
        }

        parser.reset();
        let result2 = r#"{"type":"result","session_id":"550e8400-e29b-41d4-a716-446655440000","total_cost_usd":0.01,"is_error":false,"result":""}"#;
        let chunk = parse_line_str(&mut parser, result2).unwrap();
        match chunk {
            StreamChunk::Result { assistant_uuid, .. } => {
                assert!(
                    assistant_uuid.is_none(),
                    "stale uuid must not survive reset"
                );
            }
            other => panic!("expected Result, got {other:?}"),
        }
    }

    #[test]
    fn assistant_uuid_does_not_leak_into_error_result() {
        let mut parser = StreamParser::new();
        let assistant =
            r#"{"type":"assistant","message":{"id":"msg_err","role":"assistant","content":[]}}"#;
        let error_result = r#"{"type":"result","is_error":true,"result":"something broke"}"#;
        parse_line_str(&mut parser, assistant);
        let chunk = parse_line_str(&mut parser, error_result).unwrap();
        assert!(matches!(chunk, StreamChunk::Error { .. }));
        assert!(parser.pending_assistant_uuid.is_none());
    }

    #[test]
    fn assistant_uuid_survives_message_stop_before_result() {
        let mut parser = StreamParser::new();
        let assistant =
            r#"{"type":"assistant","message":{"id":"msg_local","role":"assistant","content":[]}}"#;
        let stop = r#"{"type":"stream_event","event":{"type":"message_stop"}}"#;
        let result = r#"{"type":"result","session_id":"s1","total_cost_usd":0.04}"#;
        parse_line_str(&mut parser, assistant);
        parse_line_str(&mut parser, stop);
        let chunk = parse_line_str(&mut parser, result).unwrap();
        match chunk {
            StreamChunk::Result { assistant_uuid, .. } => {
                assert_eq!(assistant_uuid.as_deref(), Some("msg_local"));
            }
            other => panic!("expected Result, got {other:?}"),
        }
    }

    #[test]
    fn user_message_with_text_and_id_emits_user_message_commit() {
        let mut parser = StreamParser::new();
        let line = r#"{"type":"user","message":{"id":"u_hello","role":"user","content":[{"type":"text","text":"hello"}]}}"#;
        let chunks = parse_line_all_str(&mut parser, line);
        assert_eq!(chunks.len(), 1);
        match &chunks[0] {
            StreamChunk::UserMessageCommit { uuid } => assert_eq!(uuid, "u_hello"),
            other => panic!("expected UserMessageCommit, got {other:?}"),
        }
    }

    #[test]
    fn user_message_tool_result_does_not_emit_commit() {
        let mut parser = StreamParser::new();
        let line = r#"{"type":"user","message":{"id":"u_tr","role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"ok"}]}}"#;
        let chunks = parse_line_all_str(&mut parser, line);
        assert_eq!(chunks.len(), 1);
        assert!(matches!(&chunks[0], StreamChunk::ToolResult { .. }));
    }

    #[test]
    fn user_message_mixed_text_and_tool_result_emits_tool_result_only() {
        let mut parser = StreamParser::new();
        let line = r#"{"type":"user","message":{"id":"u_mix","role":"user","content":[{"type":"text","text":"here is the result"},{"type":"tool_result","tool_use_id":"toolu_1","content":"ok"}]}}"#;
        let chunks = parse_line_all_str(&mut parser, line);
        assert_eq!(chunks.len(), 1);
        assert!(
            matches!(&chunks[0], StreamChunk::ToolResult { .. }),
            "expected ToolResult, not UserMessageCommit, for mixed message"
        );
    }

    #[test]
    fn user_message_commit_is_emitted_exactly_once() {
        let mut parser = StreamParser::new();
        let line = r#"{"type":"user","message":{"id":"u_once","role":"user","content":[{"type":"text","text":"hi"}]}}"#;
        assert_eq!(parse_line_all_str(&mut parser, line).len(), 1);
        assert_eq!(
            parse_line_all_str(&mut parser, line).len(),
            0,
            "second occurrence of same user UUID must not re-emit"
        );
    }

    #[test]
    fn user_message_without_id_is_silent() {
        let mut parser = StreamParser::new();
        let line =
            r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}"#;
        assert!(parse_line_all_str(&mut parser, line).is_empty());
    }

    #[test]
    fn user_message_commit_survives_reset() {
        let mut parser = StreamParser::new();
        let line = r#"{"type":"user","message":{"id":"u_persist","role":"user","content":[{"type":"text","text":"hi"}]}}"#;
        assert_eq!(parse_line_all_str(&mut parser, line).len(), 1);
        parser.reset();
        assert_eq!(
            parse_line_all_str(&mut parser, line).len(),
            0,
            "reset must not clear committed_user_uuids"
        );
    }

    #[test]
    fn parse_system_non_actionable_is_not_surfaced() {
        let mut parser = StreamParser::new();
        let line = r#"{"type":"system","message":"hello"}"#;
        assert!(parse_line_str(&mut parser, line).is_none());
    }

    #[test]
    fn parse_system_rate_limit_surfaces_as_error() {
        let mut parser = StreamParser::new();
        let line = r#"{"type":"system","message":"You've hit your limit · resets 5pm (UTC)"}"#;
        let chunk = parse_line_str(&mut parser, line).unwrap();
        match chunk {
            StreamChunk::Error {
                content,
                turn_ended,
            } => {
                assert!(content.contains("hit your limit"));
                assert!(!turn_ended, "a system message may arrive mid-turn");
            }
            other => panic!("expected Error, got {other:?}"),
        }
    }

    #[test]
    fn parse_system_error_message_surfaces() {
        let mut parser = StreamParser::new();
        let line = r#"{"type":"system","message":"Error: connection refused"}"#;
        let chunk = parse_line_str(&mut parser, line).unwrap();
        match chunk {
            StreamChunk::Error { content, .. } => {
                assert!(content.contains("Error: connection refused"));
            }
            other => panic!("expected Error, got {other:?}"),
        }
    }

    #[test]
    fn parse_system_message_with_bare_error_word_is_not_actionable() {
        let mut parser = StreamParser::new();
        let line = r#"{"type":"system","message":"No errors found in session"}"#;
        assert!(
            parse_line_str(&mut parser, line).is_none(),
            "bare 'error' as substring should NOT be treated as actionable"
        );
    }

    #[test]
    fn parse_system_empty_message_is_skipped() {
        let mut parser = StreamParser::new();
        let line = r#"{"type":"system","message":""}"#;
        assert!(parse_line_str(&mut parser, line).is_none());
    }

    #[test]
    fn parse_system_init_extracts_model() {
        let mut parser = StreamParser::new();
        let line = r#"{"type":"system","subtype":"init","model":"claude-opus-4-6"}"#;
        let chunk = parse_line_str(&mut parser, line).unwrap();
        match chunk {
            StreamChunk::SystemInit { model, session_id } => {
                assert_eq!(model, "claude-opus-4-6");
                assert!(session_id.is_none());
            }
            other => panic!("expected SystemInit, got {other:?}"),
        }
    }

    #[test]
    fn parse_system_init_extracts_session_id_with_model() {
        let mut parser = StreamParser::new();
        let line = r#"{"type":"system","subtype":"init","model":"claude-opus-4-6","session_id":"abc","tools":["Read","Write"],"mcp_servers":[],"message":""}"#;
        let chunk = parse_line_str(&mut parser, line).unwrap();
        match chunk {
            StreamChunk::SystemInit { model, session_id } => {
                assert_eq!(model, "claude-opus-4-6");
                assert_eq!(session_id.as_deref(), Some("abc"));
            }
            other => panic!("expected SystemInit, got {other:?}"),
        }
    }

    #[test]
    fn parse_system_init_without_model_still_surfaces_session_id() {
        let mut parser = StreamParser::new();
        let line = r#"{"type":"system","subtype":"init","session_id":"abc"}"#;
        let chunk = parse_line_str(&mut parser, line).unwrap();
        match chunk {
            StreamChunk::SystemInit { model, session_id } => {
                assert_eq!(model, "");
                assert_eq!(session_id.as_deref(), Some("abc"));
            }
            other => panic!("expected SystemInit, got {other:?}"),
        }
    }

    #[test]
    fn parse_system_init_with_empty_model_and_no_session_falls_through() {
        let mut parser = StreamParser::new();
        let line = r#"{"type":"system","subtype":"init","model":""}"#;
        assert!(
            parse_line_str(&mut parser, line).is_none(),
            "init with empty model and no session id should fall through and produce None"
        );
    }

    #[test]
    fn parse_system_init_with_null_model_falls_through() {
        let mut parser = StreamParser::new();
        let line = r#"{"type":"system","subtype":"init","model":null}"#;
        assert!(
            parse_line_str(&mut parser, line).is_none(),
            "init with null model should fall through and produce None"
        );
    }

    #[test]
    fn parse_system_non_init_subtype_unchanged() {
        let mut parser = StreamParser::new();
        let line = r#"{"type":"system","subtype":"compact","message":"hello"}"#;
        assert!(
            parse_line_str(&mut parser, line).is_none(),
            "non-init subtype should not produce SystemInit"
        );
    }

    #[test]
    fn parse_system_actionable_still_surfaces_as_error() {
        let mut parser = StreamParser::new();
        let line = r#"{"type":"system","message":"You've hit your limit · resets 5pm (UTC)"}"#;
        let chunk = parse_line_str(&mut parser, line).unwrap();
        match chunk {
            StreamChunk::Error { content, .. } => assert!(content.contains("hit your limit")),
            other => panic!("expected Error, got {other:?}"),
        }
    }

    #[test]
    fn stream_chunk_system_init_round_trips() {
        let chunk = StreamChunk::SystemInit {
            model: "test".to_string(),
            session_id: None,
        };
        let json = serde_json::to_string(&chunk).unwrap();
        assert_eq!(
            json,
            r#"{"chunk_type":"SystemInit","data":{"model":"test"}}"#
        );
        let deserialized: StreamChunk = serde_json::from_str(&json).unwrap();
        match deserialized {
            StreamChunk::SystemInit { model, session_id } => {
                assert_eq!(model, "test");
                assert!(session_id.is_none());
            }
            other => panic!("expected SystemInit after round-trip, got {other:?}"),
        }

        let chunk = StreamChunk::SystemInit {
            model: "test".to_string(),
            session_id: Some("abc".to_string()),
        };
        let json = serde_json::to_string(&chunk).unwrap();
        assert_eq!(
            json,
            r#"{"chunk_type":"SystemInit","data":{"model":"test","session_id":"abc"}}"#
        );
    }

    #[test]
    fn stream_chunk_control_chip_round_trips() {
        let chunk = StreamChunk::ControlChip {
            command: "model".to_string(),
            argument: "claude-sonnet-5".to_string(),
            uuid: Some("u-model-1".to_string()),
        };
        let json = serde_json::to_string(&chunk).unwrap();
        assert_eq!(
            json,
            r#"{"chunk_type":"ControlChip","data":{"command":"model","argument":"claude-sonnet-5","uuid":"u-model-1"}}"#
        );
        let decoded: StreamChunk = serde_json::from_str(&json).unwrap();
        match decoded {
            StreamChunk::ControlChip {
                command,
                argument,
                uuid,
            } => {
                assert_eq!(command, "model");
                assert_eq!(argument, "claude-sonnet-5");
                assert_eq!(uuid.as_deref(), Some("u-model-1"));
            }
            other => panic!("expected ControlChip after round-trip, got {other:?}"),
        }
    }

    #[test]
    fn stream_chunk_control_chip_omits_uuid_when_none() {
        let chunk = StreamChunk::ControlChip {
            command: "effort".to_string(),
            argument: "high".to_string(),
            uuid: None,
        };
        let json = serde_json::to_string(&chunk).unwrap();
        assert!(
            !json.contains("uuid"),
            "None uuid must be omitted, got: {json}"
        );
    }

    #[test]
    fn stream_chunk_control_chip_unicode_argument_round_trips() {
        let chunk = StreamChunk::ControlChip {
            command: "model".to_string(),
            argument: "modèle-🌊".to_string(),
            uuid: Some("u-2".to_string()),
        };
        let json = serde_json::to_string(&chunk).unwrap();
        let decoded: StreamChunk = serde_json::from_str(&json).unwrap();
        match decoded {
            StreamChunk::ControlChip { argument, .. } => assert_eq!(argument, "modèle-🌊"),
            other => panic!("expected ControlChip, got {other:?}"),
        }
    }

    #[test]
    fn parse_system_init_produces_log_entry() {
        let mut parser = StreamParser::new();
        let line = r#"{"type":"system","subtype":"init","model":"claude-opus-4-6"}"#;
        let parsed: serde_json::Value = serde_json::from_str(line).unwrap();
        let (chunk, log_entry) = parser.parse_system_message(&parsed);
        assert!(chunk.is_some(), "expected Some(SystemInit)");
        let entry = log_entry.unwrap();
        assert_eq!(entry.prefix, "SYSTEM");
        assert_eq!(entry.message, "init: model=claude-opus-4-6");
    }

    fn parse_rate_limit(line: &str) -> (StreamChunk, LogEntry) {
        let mut parser = StreamParser::new();
        let parsed: serde_json::Value = serde_json::from_str(line).unwrap();
        let (chunks, log_entry) = parser.parse_line(&parsed);
        (
            chunks.into_iter().next().expect("a RateLimit chunk"),
            log_entry.expect("a RATE_LIMIT log entry"),
        )
    }

    #[test]
    fn parse_rate_limit_event_stores_a_warning_fraction_as_percent() {
        let (chunk, entry) = parse_rate_limit(
            r#"{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","resetsAt":1738425600,"rateLimitType":"five_hour","utilization":0.6,"overageStatus":"rejected","isUsingOverage":false},"uuid":"u","session_id":"s"}"#,
        );
        match chunk {
            StreamChunk::RateLimit {
                status,
                rate_limit_type,
                utilization_percent,
                resets_at,
                overage_status,
                is_using_overage,
            } => {
                assert_eq!(status, "allowed_warning");
                assert_eq!(rate_limit_type.as_deref(), Some("five_hour"));
                assert!((utilization_percent.unwrap() - 60.0).abs() < 1e-9);
                assert_eq!(resets_at, Some(1738425600));
                assert_eq!(overage_status.as_deref(), Some("rejected"));
                assert_eq!(is_using_overage, Some(false));
            }
            other => panic!("expected RateLimit, got {other:?}"),
        }
        assert_eq!(entry.prefix, "RATE_LIMIT");
        assert!(
            entry.message.contains("utilization=60%"),
            "{}",
            entry.message
        );
        assert!(
            entry.message.contains("type=five_hour"),
            "{}",
            entry.message
        );
    }

    #[test]
    fn parse_rate_limit_event_ignores_a_utilization_that_is_not_a_fraction() {
        for raw in ["73.5", "1.01", "-0.1"] {
            let line = format!(
                r#"{{"type":"rate_limit_event","rate_limit_info":{{"status":"allowed_warning","utilization":{raw}}}}}"#
            );
            match parse_rate_limit(&line).0 {
                StreamChunk::RateLimit {
                    utilization_percent,
                    status,
                    ..
                } => {
                    assert_eq!(utilization_percent, None, "{raw}");
                    assert_eq!(status, "allowed_warning");
                }
                other => panic!("expected RateLimit, got {other:?}"),
            }
        }
    }

    #[test]
    fn utilization_fraction_bounds_map_to_zero_and_one_hundred_percent() {
        assert_eq!(utilization_fraction_to_percent(0.0), Some(0.0));
        assert_eq!(utilization_fraction_to_percent(1.0), Some(100.0));
        assert_eq!(utilization_fraction_to_percent(f64::NAN), None);
    }

    #[test]
    fn parse_rate_limit_event_accepts_legacy_snake_case_resets_at() {
        let mut parser = StreamParser::new();
        let line = r#"{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resets_at":1738425600}}"#;
        let parsed: serde_json::Value = serde_json::from_str(line).unwrap();
        let (chunks, _) = parser.parse_line(&parsed);
        match chunks.into_iter().next() {
            Some(StreamChunk::RateLimit { resets_at, .. }) => {
                assert_eq!(resets_at, Some(1738425600));
            }
            other => panic!("expected RateLimit, got {other:?}"),
        }
    }

    #[test]
    fn parse_rate_limit_event_without_utilization_keeps_status_type_and_reset_time() {
        let (chunk, entry) = parse_rate_limit(
            r#"{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1738425600,"rateLimitType":"seven_day","overageStatus":"rejected","isUsingOverage":false}}"#,
        );
        match chunk {
            StreamChunk::RateLimit {
                status,
                rate_limit_type,
                utilization_percent,
                resets_at,
                ..
            } => {
                assert_eq!(status, "allowed");
                assert_eq!(rate_limit_type.as_deref(), Some("seven_day"));
                assert_eq!(utilization_percent, None);
                assert_eq!(resets_at, Some(1738425600));
            }
            other => panic!("expected RateLimit, got {other:?}"),
        }
        assert!(
            entry.message.contains("utilization=none"),
            "{}",
            entry.message
        );
    }

    #[test]
    fn parse_rate_limit_event_with_only_a_status_leaves_every_other_field_absent() {
        match parse_rate_limit(
            r#"{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"}}"#,
        )
        .0
        {
            StreamChunk::RateLimit {
                status,
                rate_limit_type,
                utilization_percent,
                resets_at,
                overage_status,
                is_using_overage,
            } => {
                assert_eq!(status, "allowed");
                assert_eq!(rate_limit_type, None);
                assert_eq!(utilization_percent, None);
                assert_eq!(resets_at, None);
                assert_eq!(overage_status, None);
                assert_eq!(is_using_overage, None);
            }
            other => panic!("expected RateLimit, got {other:?}"),
        }
    }

    #[test]
    fn parse_rate_limit_event_rejected_at_the_limit() {
        match parse_rate_limit(
            r#"{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1738430000,"rateLimitType":"five_hour","utilization":1.0,"overageStatus":"allowed","isUsingOverage":true}}"#,
        )
        .0
        {
            StreamChunk::RateLimit {
                status,
                utilization_percent,
                is_using_overage,
                overage_status,
                ..
            } => {
                assert_eq!(status, "rejected");
                assert!((utilization_percent.unwrap() - 100.0).abs() < 1e-9);
                assert_eq!(overage_status.as_deref(), Some("allowed"));
                assert_eq!(is_using_overage, Some(true));
            }
            other => panic!("expected RateLimit, got {other:?}"),
        }
    }

    #[test]
    fn stream_chunk_rate_limit_round_trips() {
        let chunk = StreamChunk::RateLimit {
            status: "allowed_warning".to_string(),
            rate_limit_type: Some("five_hour".to_string()),
            utilization_percent: Some(42.0),
            resets_at: Some(1738425600),
            overage_status: None,
            is_using_overage: Some(false),
        };
        let json = serde_json::to_value(&chunk).unwrap();
        assert_eq!(json["chunk_type"], "RateLimit");
        let mut keys: Vec<&str> = json["data"]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec![
                "is_using_overage",
                "overage_status",
                "rate_limit_type",
                "resets_at",
                "status",
                "utilization_percent"
            ]
        );
        let deserialized: StreamChunk = serde_json::from_value(json).unwrap();
        match deserialized {
            StreamChunk::RateLimit {
                status,
                utilization_percent,
                resets_at,
                ..
            } => {
                assert_eq!(status, "allowed_warning");
                assert!((utilization_percent.unwrap() - 42.0).abs() < f64::EPSILON);
                assert_eq!(resets_at, Some(1738425600));
            }
            other => panic!("expected RateLimit after round-trip, got {other:?}"),
        }
    }

    #[test]
    fn rate_limit_chunk_fields_match_ts_mirror() {
        let ts = include_str!("../../src/src/app/models/chat.ts");
        let marker = "export interface RateLimitInfo {";
        let idx = ts
            .find(marker)
            .expect("chat.ts must declare `export interface RateLimitInfo`");
        let body = ts[idx + marker.len()..]
            .split("\n}")
            .next()
            .expect("RateLimitInfo must close");
        let mut ts_fields: Vec<&str> = body
            .lines()
            .filter_map(|l| l.split(':').next())
            .map(str::trim)
            .filter(|s| !s.is_empty() && !s.starts_with('/') && !s.starts_with('*'))
            .collect();
        ts_fields.sort_unstable();
        let chunk = StreamChunk::RateLimit {
            status: "allowed".to_string(),
            rate_limit_type: None,
            utilization_percent: None,
            resets_at: None,
            overage_status: None,
            is_using_overage: None,
        };
        let json = serde_json::to_value(&chunk).unwrap();
        let mut rust_fields: Vec<&str> = json["data"]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        rust_fields.sort_unstable();
        assert_eq!(rust_fields, ts_fields);
        let compact: String = ts.split_whitespace().collect();
        assert!(
            compact.contains("chunk_type:'RateLimit';data:RateLimitInfo"),
            "the RateLimit chunk must carry RateLimitInfo"
        );
    }

    #[test]
    fn parse_invalid_json_is_skipped() {
        let mut parser = StreamParser::new();
        assert!(parse_line_str(&mut parser, "not json at all").is_none());
    }

    #[test]
    fn parse_empty_line_is_skipped() {
        let mut parser = StreamParser::new();
        assert!(parse_line_str(&mut parser, "").is_none());
        assert!(parse_line_str(&mut parser, "   ").is_none());
        assert!(parse_line_str(&mut parser, "\t\n").is_none());
    }

    #[test]
    fn parse_signature_delta_is_ignored() {
        let mut parser = StreamParser::new();
        let line = r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"signature_delta","signature":"sig..."}}}"#;
        assert!(parse_line_str(&mut parser, line).is_none());
    }

    #[test]
    fn chat_session_new_stores_project_name() {
        let session = ChatSession::new("acme-corp");
        assert_eq!(session.project_name, "acme-corp");
    }

    #[test]
    fn chat_session_new_has_no_child() {
        let session = ChatSession::new("acme-corp");
        assert!(session.child.is_none());
        assert!(session.shared_stdin.is_none());
        assert!(session.pending_requests.lock().unwrap().is_empty());
    }

    #[test]
    fn claude_container_name_uses_compose_prefix() {
        let name = claude_container_name_with_prefix(consts::COMPOSE_PREFIX, "myproject");
        assert_eq!(name, format!("{}_myproject_claude", consts::COMPOSE_PREFIX));
    }

    #[test]
    fn claude_container_name_format_is_prefix_project_claude() {
        let name = claude_container_name_with_prefix(consts::COMPOSE_PREFIX, "acme-corp");
        assert_eq!(name, "speedwave_acme-corp_claude");
    }

    #[test]
    fn build_claude_args_without_resume() {
        let args = build_claude_args("inst", None, None, &[]);
        assert!(args.contains(&consts::CLAUDE_BINARY.to_string()));
        assert!(args.contains(&"-p".to_string()));
        assert!(!args.contains(&"--resume".to_string()));
        assert!(!args.contains(&"--resume-session-at".to_string()));
        assert!(args.contains(&"--permission-prompt-tool".to_string()));
    }

    #[test]
    fn build_claude_args_with_resume() {
        let id = "550e8400-e29b-41d4-a716-446655440000";
        let args = build_claude_args("inst", Some(id), None, &[]);
        let resume_pos = args.iter().position(|a| a == "--resume").unwrap();
        assert_eq!(args[resume_pos + 1], id);
        assert!(!args.contains(&"--resume-session-at".to_string()));
    }

    #[test]
    fn build_claude_args_with_resume_and_uuid() {
        let session = "550e8400-e29b-41d4-a716-446655440000";
        let uuid = "msg_retry_anchor";
        let args = build_claude_args("inst", Some(session), Some(uuid), &[]);
        let resume_pos = args.iter().position(|a| a == "--resume").unwrap();
        assert_eq!(args[resume_pos + 1], session);
        let at_pos = args
            .iter()
            .position(|a| a == "--resume-session-at")
            .expect("--resume-session-at must be present");
        assert_eq!(args[at_pos + 1], uuid);
    }

    #[test]
    fn build_claude_args_includes_flags() {
        let args = build_claude_args(
            "inst",
            None,
            None,
            &["--dangerously-skip-permissions".to_string()],
        );
        assert!(args.contains(&"--dangerously-skip-permissions".to_string()));
    }

    #[test]
    fn build_claude_args_prepends_instance_env_marker() {
        let args = build_claude_args("my-instance-42", None, None, &[]);
        assert_eq!(args[0], "env");
        assert_eq!(args[1], "SPW_SESSION_INSTANCE_ID=my-instance-42");
        assert_eq!(args[2], consts::CLAUDE_BINARY);
    }

    #[test]
    fn full_turn_fixture_produces_expected_chunk_sequence() {
        let fixture = include_str!("../tests/fixtures/full_turn.ndjson");
        let mut parser = StreamParser::new();
        let chunks: Vec<StreamChunk> = fixture
            .lines()
            .filter_map(|line| parse_line_str(&mut parser, line))
            .collect();

        assert_eq!(chunks.len(), 10, "expected 10 chunks, got {}", chunks.len());

        match &chunks[0] {
            StreamChunk::Text { content } => assert_eq!(content, "I'll read "),
            other => panic!("chunk 0: expected Text, got {other:?}"),
        }
        match &chunks[1] {
            StreamChunk::Text { content } => assert_eq!(content, "the file."),
            other => panic!("chunk 1: expected Text, got {other:?}"),
        }
        match &chunks[2] {
            StreamChunk::Thinking { content } => assert_eq!(content, ""),
            other => panic!("chunk 2: expected Thinking(''), got {other:?}"),
        }
        match &chunks[3] {
            StreamChunk::Thinking { content } => assert_eq!(content, "Let me think about this..."),
            other => panic!("chunk 3: expected Thinking, got {other:?}"),
        }
        match &chunks[4] {
            StreamChunk::ToolStart { tool_id, tool_name } => {
                assert_eq!(tool_id, "toolu_01ABC");
                assert_eq!(tool_name, "Read");
            }
            other => panic!("chunk 4: expected ToolStart, got {other:?}"),
        }
        match &chunks[5] {
            StreamChunk::ToolInputDelta {
                tool_id,
                partial_json,
            } => {
                assert_eq!(tool_id, "toolu_01ABC");
                assert!(partial_json.contains("file_path"));
            }
            other => panic!("chunk 5: expected ToolInputDelta, got {other:?}"),
        }
        match &chunks[6] {
            StreamChunk::ToolInputDelta { tool_id, .. } => {
                assert_eq!(tool_id, "toolu_01ABC");
            }
            other => panic!("chunk 6: expected ToolInputDelta, got {other:?}"),
        }
        match &chunks[7] {
            StreamChunk::ToolResult {
                tool_id,
                content,
                is_error,
            } => {
                assert_eq!(tool_id, "toolu_01ABC");
                assert_eq!(content, "fn main() {}");
                assert!(!is_error);
            }
            other => panic!("chunk 7: expected ToolResult, got {other:?}"),
        }
        match &chunks[8] {
            StreamChunk::Text { content } => {
                assert_eq!(content, "The file contains a main function.")
            }
            other => panic!("chunk 8: expected Text, got {other:?}"),
        }
        match &chunks[9] {
            StreamChunk::Result {
                session_id,
                total_cost,
                usage,
                result_text,
                ..
            } => {
                assert_eq!(session_id, "550e8400-e29b-41d4-a716-446655440000");
                assert_eq!(total_cost, &Some(0.003));
                let u = usage.as_ref().unwrap();
                assert_eq!(u.input_tokens, 100);
                assert_eq!(u.output_tokens, 50);
                assert!(result_text.is_none(), "empty result should produce None");
            }
            other => panic!("chunk 9: expected Result, got {other:?}"),
        }
    }

    #[test]
    fn parse_ask_user_question_suppressed_in_stream_events() {
        let mut parser = StreamParser::new();

        let start = r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_ask1","name":"AskUserQuestion"}}}"#;
        let chunk = parse_line_str(&mut parser, start);
        assert!(chunk.is_none(), "AskUserQuestion should suppress ToolStart");

        let delta1 = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"question\":\"Pick a fruit\","}}}"#;
        assert!(
            parse_line_str(&mut parser, delta1).is_none(),
            "AskUserQuestion input_json_delta should be suppressed"
        );

        let delta2 = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\"header\":\"Fruits\",\"multiSelect\":false,\"options\":[{\"label\":\"Apple\",\"value\":\"apple\"},{\"label\":\"Banana\",\"value\":\"banana\"}]}"}}}"#;
        assert!(
            parse_line_str(&mut parser, delta2).is_none(),
            "AskUserQuestion input_json_delta should be suppressed"
        );

        let stop = r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0}}"#;
        assert!(
            parse_line_str(&mut parser, stop).is_none(),
            "AskUserQuestion should not be emitted from stream events (handled via control_request)"
        );
    }

    #[test]
    fn parse_ask_user_question_cleans_up_active_blocks() {
        let mut parser = StreamParser::new();

        let start = r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_ask2","name":"AskUserQuestion"}}}"#;
        parse_line_str(&mut parser, start);

        let delta = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"question\":\"Yes or no?\",\"header\":\"\",\"multiSelect\":false,\"options\":[]}"}}}"#;
        parse_line_str(&mut parser, delta);

        let stop = r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0}}"#;
        parse_line_str(&mut parser, stop);

        assert!(parser.active_blocks.is_empty());
    }

    #[test]
    fn parse_non_ask_tool_does_not_emit_ask_user_question() {
        let mut parser = StreamParser::new();

        let start = r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_read1","name":"Read"}}}"#;
        parse_line_str(&mut parser, start);

        let delta = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"file_path\":\"/tmp/test.rs\"}"}}}"#;
        parse_line_str(&mut parser, delta);

        let stop = r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0}}"#;
        let chunk = parse_line_str(&mut parser, stop);
        assert!(
            chunk.is_none(),
            "non-AskUserQuestion tool should not emit AskUserQuestion chunk"
        );
    }

    #[test]
    fn ask_user_question_round_trips_through_json() {
        let original = StreamChunk::AskUserQuestion {
            tool_id: "t1".to_string(),
            questions: vec![AskUserQuestionItem {
                question: "Pick one".to_string(),
                header: "Test".to_string(),
                options: vec![
                    AskUserOption {
                        label: "A".to_string(),
                        value: "a".to_string(),
                    },
                    AskUserOption {
                        label: "B".to_string(),
                        value: "b".to_string(),
                    },
                ],
                multi_select: true,
            }],
            current_index: 0,
        };
        let serialized = serde_json::to_string(&original).unwrap();
        let deserialized: StreamChunk = serde_json::from_str(&serialized).unwrap();
        match deserialized {
            StreamChunk::AskUserQuestion {
                tool_id,
                questions,
                current_index,
            } => {
                assert_eq!(tool_id, "t1");
                assert_eq!(current_index, 0);
                assert_eq!(questions.len(), 1);
                assert_eq!(questions[0].question, "Pick one");
                assert_eq!(questions[0].header, "Test");
                assert!(questions[0].multi_select);
                assert_eq!(questions[0].options.len(), 2);
            }
            other => panic!("expected AskUserQuestion, got {other:?}"),
        }
    }

    #[test]
    fn parse_ask_user_question_wrapped_format_suppressed_in_stream() {
        let mut parser = StreamParser::new();

        let start = r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_ask3","name":"AskUserQuestion"}}}"#;
        parse_line_str(&mut parser, start);

        let delta = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"questions\":[{\"question\":\"Co wolisz?\",\"header\":\"Owoc\",\"multiSelect\":false,\"options\":[{\"label\":\"Gruszki\",\"description\":\"Zielone\"},{\"label\":\"Banany\",\"description\":\"Żółte\"}]}]}"}}}"#;
        parse_line_str(&mut parser, delta);

        let stop = r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0}}"#;
        assert!(
            parse_line_str(&mut parser, stop).is_none(),
            "AskUserQuestion should not be emitted from stream events"
        );
    }

    #[test]
    fn try_parse_control_request_returns_none_for_stream_event() {
        let line = r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}}"#;
        assert!(try_parse_control_request_str(line).is_none());
    }

    #[test]
    fn try_parse_control_request_parses_ask_user_question() {
        let line = r#"{"type":"control_request","request_id":"req_1","request":{"tool_name":"AskUserQuestion","tool_use_id":"toolu_ask_ctrl","input":{"question":"Pick one","header":"Choice","multiSelect":false,"options":[{"label":"A","value":"a"},{"label":"B","value":"b"}]}}}"#;
        let req = try_parse_control_request_str(line).unwrap();
        assert_eq!(req.request_id, "req_1");
        assert_eq!(req.tool_name, "AskUserQuestion");
        assert_eq!(req.tool_use_id, "toolu_ask_ctrl");
        assert_eq!(req.input["question"], "Pick one");
    }

    #[test]
    fn try_parse_control_request_parses_regular_tool() {
        let line = r#"{"type":"control_request","request_id":"req_2","request":{"tool_name":"Bash","tool_use_id":"toolu_bash1","input":{"command":"ls"}}}"#;
        let req = try_parse_control_request_str(line).unwrap();
        assert_eq!(req.request_id, "req_2");
        assert_eq!(req.tool_name, "Bash");
        assert_eq!(req.tool_use_id, "toolu_bash1");
    }

    #[test]
    fn build_auto_approve_response_structure() {
        let req = ControlRequest {
            request_id: "req_42".to_string(),
            tool_name: "Read".to_string(),
            input: serde_json::json!({"file_path": "/tmp/test.rs"}),
            tool_use_id: "toolu_read1".to_string(),
        };
        let resp = build_auto_approve_response(&req);
        assert_eq!(resp["type"], "control_response");
        assert_eq!(resp["response"]["subtype"], "success");
        assert_eq!(resp["response"]["request_id"], "req_42");
        assert_eq!(resp["response"]["response"]["behavior"], "allow");
        assert_eq!(
            resp["response"]["response"]["updatedInput"]["file_path"],
            "/tmp/test.rs"
        );
    }

    fn make_partial(
        req_id: &str,
        qs: &[(&str, &str)],
        answers: Vec<Option<String>>,
    ) -> PartialAnswers {
        let questions: Vec<AskUserQuestionItem> = qs
            .iter()
            .map(|(q, h)| AskUserQuestionItem {
                question: (*q).into(),
                header: (*h).into(),
                options: vec![],
                multi_select: false,
            })
            .collect();
        let serde_q: Vec<serde_json::Value> = questions
            .iter()
            .map(|q| {
                serde_json::json!({
                    "question": q.question,
                    "header": q.header,
                    "multiSelect": q.multi_select,
                    "options": q.options.iter().map(|o| serde_json::json!({"label": o.label, "value": o.value})).collect::<Vec<_>>(),
                })
            })
            .collect();
        PartialAnswers {
            request: ControlRequest {
                request_id: req_id.into(),
                tool_name: "AskUserQuestion".into(),
                input: serde_json::json!({ "questions": serde_q }),
                tool_use_id: "toolu_t".into(),
            },
            questions,
            answers,
        }
    }

    #[test]
    fn build_ask_user_response_multi_writes_full_answers_map() {
        let partial = make_partial(
            "req_full",
            &[("Q1", "H1"), ("Q2", "H2"), ("Q3", "H3")],
            vec![Some("a".into()), Some("b".into()), Some("c".into())],
        );
        let resp = build_ask_user_response_multi(&partial).expect("must succeed");
        assert_eq!(resp["type"], "control_response");
        assert_eq!(resp["response"]["subtype"], "success");
        assert_eq!(resp["response"]["request_id"], "req_full");
        assert_eq!(resp["response"]["response"]["behavior"], "allow");
        let updated = &resp["response"]["response"]["updatedInput"];
        assert_eq!(updated["answers"]["Q1"], "a");
        assert_eq!(updated["answers"]["Q2"], "b");
        assert_eq!(updated["answers"]["Q3"], "c");
        assert_eq!(
            updated["questions"].as_array().map(|a| a.len()),
            Some(3),
            "original questions array must be preserved unchanged"
        );
    }

    #[test]
    fn build_ask_user_response_multi_passes_through_multi_select_value() {
        let partial = make_partial("req_multi", &[("Pick", "h")], vec![Some("A, B".into())]);
        let resp = build_ask_user_response_multi(&partial).expect("must succeed");
        assert_eq!(
            resp["response"]["response"]["updatedInput"]["answers"]["Pick"],
            "A, B"
        );
    }

    #[test]
    fn build_ask_user_response_multi_duplicate_question_text_fails_closed() {
        let partial = make_partial(
            "req_dup",
            &[("Same?", "H1"), ("Same?", "H2")],
            vec![Some("first".into()), Some("second".into())],
        );
        let err = build_ask_user_response_multi(&partial)
            .expect_err("duplicate question text must fail closed");
        assert!(
            err.to_string().contains("duplicate question text"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn build_ask_user_response_multi_one_question_round_trip() {
        let partial = make_partial(
            "req_one",
            &[("Pick a fruit", "Fruits")],
            vec![Some("Apple".into())],
        );
        let resp = build_ask_user_response_multi(&partial).expect("must succeed");
        assert_eq!(
            resp["response"]["response"]["updatedInput"]["answers"]["Pick a fruit"],
            "Apple"
        );
    }

    #[test]
    fn submit_question_answer_no_session_errors_cleanly() {
        let mut s = ChatSession::new("test-project");
        s.pending_requests.lock().unwrap().insert(
            "tool-x".into(),
            make_partial("r1", &[("Q", "")], vec![None]),
        );
        let err = s
            .submit_question_answer("tool-x", 0, "yes")
            .expect_err("must fail without an active session");
        assert!(
            err.to_string().contains("no active session"),
            "unexpected error: {err}"
        );
        let map = s.pending_requests.lock().unwrap();
        let entry = map.get("tool-x").expect("entry preserved");
        assert!(entry.answers[0].is_none(), "answers must not be modified");
    }

    #[test]
    fn submit_question_answer_oversize_answer_errors_cleanly() {
        let mut s = ChatSession::new("test-project");
        s.pending_requests.lock().unwrap().insert(
            "tool-y".into(),
            make_partial("r2", &[("Q", "")], vec![None]),
        );
        let huge = "x".repeat(MAX_ASK_USER_ANSWER_LEN + 1);
        let err = s
            .submit_question_answer("tool-y", 0, &huge)
            .expect_err("oversize answer must fail");
        assert!(
            err.to_string().contains("answer too long"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn fill_slot_invalid_index_errors_and_preserves_entry() {
        let s = ChatSession::new("test-project");
        s.pending_requests.lock().unwrap().insert(
            "tool-bad-idx".into(),
            make_partial("r1", &[("Q", "h")], vec![None]),
        );
        let err = s
            .fill_slot("tool-bad-idx", 5, "value")
            .expect_err("out-of-bounds index must fail");
        assert!(
            err.to_string().contains("invalid question index"),
            "unexpected: {err}"
        );
        let map = s.pending_requests.lock().unwrap();
        let entry = map.get("tool-bad-idx").expect("entry must be restored");
        assert!(entry.answers[0].is_none(), "slot 0 must remain None");
    }

    #[test]
    fn fill_slot_already_answered_errors_and_preserves_entry() {
        let s = ChatSession::new("test-project");
        s.pending_requests.lock().unwrap().insert(
            "tool-dup".into(),
            make_partial("r1", &[("Q", "h")], vec![Some("first".into())]),
        );
        let err = s
            .fill_slot("tool-dup", 0, "second")
            .expect_err("already-answered slot must fail");
        assert!(
            err.to_string().contains("already answered"),
            "unexpected: {err}"
        );
        let map = s.pending_requests.lock().unwrap();
        let entry = map.get("tool-dup").expect("entry must be restored");
        assert_eq!(entry.answers[0].as_deref(), Some("first"));
    }

    #[test]
    fn fill_slot_pending_after_partial_completion() {
        let s = ChatSession::new("test-project");
        s.pending_requests.lock().unwrap().insert(
            "tool-multi".into(),
            make_partial("r1", &[("Q0", ""), ("Q1", "")], vec![None, None]),
        );
        let outcome = s.fill_slot("tool-multi", 0, "first").expect("must succeed");
        match outcome {
            FillOutcome::Pending => {}
            _ => panic!("expected Pending"),
        }
        let map = s.pending_requests.lock().unwrap();
        let entry = map.get("tool-multi").expect("still pending");
        assert_eq!(entry.answers[0].as_deref(), Some("first"));
        assert!(entry.answers[1].is_none());
    }

    #[test]
    fn fill_slot_completed_removes_entry_and_returns_partial() {
        let s = ChatSession::new("test-project");
        s.pending_requests.lock().unwrap().insert(
            "tool-fin".into(),
            make_partial("r1", &[("Q0", "")], vec![None]),
        );
        let outcome = s.fill_slot("tool-fin", 0, "only").expect("must succeed");
        match outcome {
            FillOutcome::Completed(p) => assert_eq!(p.answers[0].as_deref(), Some("only")),
            _ => panic!("expected Completed"),
        }
        let map = s.pending_requests.lock().unwrap();
        assert!(
            !map.contains_key("tool-fin"),
            "Completed must remove the entry"
        );
    }

    #[test]
    fn restore_partial_clears_specified_slot() {
        let s = ChatSession::new("test-project");
        let partial = make_partial(
            "r1",
            &[("Q0", ""), ("Q1", "")],
            vec![Some("a".into()), Some("b".into())],
        );
        s.restore_partial("tool-r", &partial, Some(1));
        let map = s.pending_requests.lock().unwrap();
        let entry = map.get("tool-r").expect("must be inserted");
        assert_eq!(entry.answers[0].as_deref(), Some("a"));
        assert!(
            entry.answers[1].is_none(),
            "slot 1 must be cleared so user can retry"
        );
    }

    #[test]
    fn build_ask_user_response_multi_oversize_payload_serializes_to_more_than_64_kib() {
        let big = "x".repeat(20_000);
        let partial = make_partial(
            "req_oversize",
            &[("Q0", "h"), ("Q1", "h"), ("Q2", "h"), ("Q3", "h")],
            vec![
                Some(big.clone()),
                Some(big.clone()),
                Some(big.clone()),
                Some(big),
            ],
        );
        let resp = build_ask_user_response_multi(&partial).expect("must succeed");
        let serialized = serde_json::to_string(&resp).expect("must serialize");
        assert!(
            serialized.len() > MAX_ASK_USER_WIRE_BYTES,
            "expected serialized > {} bytes, got {}",
            MAX_ASK_USER_WIRE_BYTES,
            serialized.len()
        );
    }

    fn make_question_value(question: &str, header: &str) -> serde_json::Value {
        serde_json::json!({
            "question": question,
            "header": header,
            "multiSelect": false,
            "options": [{"label": "Yes", "value": "yes"}, {"label": "No", "value": "no"}],
        })
    }

    fn build_ask_user_request(questions: Vec<serde_json::Value>) -> ControlRequest {
        ControlRequest {
            request_id: "req".to_string(),
            tool_name: "AskUserQuestion".to_string(),
            input: serde_json::json!({ "questions": questions }),
            tool_use_id: "toolu_multi".to_string(),
        }
    }

    fn unwrap_ask_chunk(chunk: StreamChunk) -> (String, Vec<AskUserQuestionItem>, usize) {
        match chunk {
            StreamChunk::AskUserQuestion {
                tool_id,
                questions,
                current_index,
            } => (tool_id, questions, current_index),
            other => panic!("expected AskUserQuestion, got {other:?}"),
        }
    }

    #[test]
    fn emit_ask_user_one_question() {
        let req = build_ask_user_request(vec![make_question_value("Q1", "H1")]);
        let chunk = StreamParser::emit_ask_user_from_control_request(&req).unwrap();
        let (tool_id, questions, current_index) = unwrap_ask_chunk(chunk);
        assert_eq!(tool_id, "toolu_multi");
        assert_eq!(current_index, 0);
        assert_eq!(questions.len(), 1);
        assert_eq!(questions[0].question, "Q1");
        assert_eq!(questions[0].header, "H1");
    }

    #[test]
    fn emit_ask_user_two_questions() {
        let req = build_ask_user_request(vec![
            make_question_value("Q1", "H1"),
            make_question_value("Q2", "H2"),
        ]);
        let chunk = StreamParser::emit_ask_user_from_control_request(&req).unwrap();
        let (_, questions, _) = unwrap_ask_chunk(chunk);
        assert_eq!(questions.len(), 2);
        assert_eq!(questions[0].question, "Q1");
        assert_eq!(questions[1].question, "Q2");
    }

    #[test]
    fn emit_ask_user_three_questions() {
        let req = build_ask_user_request(vec![
            make_question_value("A", ""),
            make_question_value("B", ""),
            make_question_value("C", ""),
        ]);
        let chunk = StreamParser::emit_ask_user_from_control_request(&req).unwrap();
        let (_, questions, _) = unwrap_ask_chunk(chunk);
        assert_eq!(questions.len(), 3);
        assert_eq!(
            questions
                .iter()
                .map(|q| q.question.clone())
                .collect::<Vec<_>>(),
            vec!["A".to_string(), "B".to_string(), "C".to_string()]
        );
    }

    #[test]
    fn emit_ask_user_four_questions() {
        let req = build_ask_user_request(vec![
            make_question_value("A", ""),
            make_question_value("B", ""),
            make_question_value("C", ""),
            make_question_value("D", ""),
        ]);
        let chunk = StreamParser::emit_ask_user_from_control_request(&req).unwrap();
        let (_, questions, _) = unwrap_ask_chunk(chunk);
        assert_eq!(questions.len(), 4);
        assert_eq!(questions[3].question, "D");
    }

    #[test]
    fn emit_ask_user_five_questions_truncates_to_cap() {
        let req = build_ask_user_request(vec![
            make_question_value("A", ""),
            make_question_value("B", ""),
            make_question_value("C", ""),
            make_question_value("D", ""),
            make_question_value("E", ""),
        ]);
        let chunk = StreamParser::emit_ask_user_from_control_request(&req).unwrap();
        let (_, questions, _) = unwrap_ask_chunk(chunk);
        assert_eq!(questions.len(), MAX_ASK_USER_QUESTIONS);
        assert_eq!(questions[0].question, "A");
        assert_eq!(questions[3].question, "D");
    }

    #[test]
    fn emit_ask_user_duplicate_question_text_kept_distinct() {
        let req = build_ask_user_request(vec![
            make_question_value("Same?", "H1"),
            make_question_value("Same?", "H2"),
        ]);
        let chunk = StreamParser::emit_ask_user_from_control_request(&req).unwrap();
        let (_, questions, _) = unwrap_ask_chunk(chunk);
        assert_eq!(questions.len(), 2);
        assert_eq!(questions[0].question, "Same?");
        assert_eq!(questions[1].question, "Same?");
        assert_eq!(questions[0].header, "H1");
        assert_eq!(questions[1].header, "H2");
    }

    #[test]
    fn emit_ask_user_empty_questions_array_returns_none() {
        let req = build_ask_user_request(vec![]);
        assert!(StreamParser::emit_ask_user_from_control_request(&req).is_none());
    }

    #[test]
    fn emit_ask_user_missing_questions_field_treats_input_as_single() {
        let req = ControlRequest {
            request_id: "req_flat".to_string(),
            tool_name: "AskUserQuestion".to_string(),
            input: serde_json::json!({
                "question": "Flat?",
                "header": "Confirm",
                "multiSelect": false,
                "options": [{"label": "Yes"}, {"label": "No"}]
            }),
            tool_use_id: "toolu_flat".to_string(),
        };
        let chunk = StreamParser::emit_ask_user_from_control_request(&req).unwrap();
        let (_, questions, _) = unwrap_ask_chunk(chunk);
        assert_eq!(questions.len(), 1);
        assert_eq!(questions[0].question, "Flat?");
        assert_eq!(questions[0].options.len(), 2);
    }

    #[test]
    fn emit_ask_user_malformed_options_skipped() {
        let req = build_ask_user_request(vec![serde_json::json!({
            "question": "Pick",
            "header": "h",
            "multiSelect": false,
            "options": [
                {"label": "Good", "value": "good"},
                {"value": "no_label"},
                {"label": "Also good"}
            ]
        })]);
        let chunk = StreamParser::emit_ask_user_from_control_request(&req).unwrap();
        let (_, questions, _) = unwrap_ask_chunk(chunk);
        assert_eq!(questions[0].options.len(), 2);
        assert_eq!(questions[0].options[0].label, "Good");
        assert_eq!(questions[0].options[1].label, "Also good");
        assert_eq!(questions[0].options[1].value, "Also good");
    }

    #[test]
    fn emit_ask_user_unicode_polish() {
        let req = build_ask_user_request(vec![serde_json::json!({
            "question": "Co wolisz?",
            "header": "Wybór 🌊",
            "multiSelect": true,
            "options": [{"label": "Gruszki"}, {"label": "Banany"}]
        })]);
        let chunk = StreamParser::emit_ask_user_from_control_request(&req).unwrap();
        let (_, questions, _) = unwrap_ask_chunk(chunk);
        assert_eq!(questions[0].question, "Co wolisz?");
        assert_eq!(questions[0].header, "Wybór 🌊");
        assert!(questions[0].multi_select);
        assert_eq!(questions[0].options[0].label, "Gruszki");
    }

    #[test]
    fn build_claude_args_includes_permission_prompt_tool() {
        let args = build_claude_args("inst", None, None, &[]);
        let pos = args
            .iter()
            .position(|a| a == "--permission-prompt-tool")
            .expect("--permission-prompt-tool should be in args");
        assert_eq!(args[pos + 1], "stdio");
    }

    #[test]
    fn prepare_args_fails_when_project_not_in_config() {
        let user_config = config::SpeedwaveUserConfig {
            projects: vec![],
            active_project: None,
            selected_ide: None,
            ui: None,
            telemetry: None,
        };
        let result = ChatSession::prepare_args("nonexistent", &user_config, "inst", None, None);
        assert!(result.is_err());
        let err_msg = result.unwrap_err().to_string();
        assert!(
            err_msg.contains("nonexistent"),
            "error should mention project name, got: {err_msg}"
        );
    }

    #[test]
    fn prepare_args_fails_with_invalid_resume_session_id() {
        let user_config = config::SpeedwaveUserConfig {
            projects: vec![config::ProjectUserEntry {
                name: "test".to_string(),
                dir: "/tmp/test".to_string(),
                claude: None,
                integrations: None,
                plugin_settings: None,
                policy: None,
                effort_pin: None,
            }],
            active_project: None,
            selected_ide: None,
            ui: None,
            telemetry: None,
        };
        let result = ChatSession::prepare_args(
            "test",
            &user_config,
            "inst",
            Some("../../../etc/passwd"),
            None,
        );
        assert!(result.is_err());
    }

    #[test]
    fn prepare_args_fails_with_malformed_retry_uuid() {
        let user_config = config::SpeedwaveUserConfig {
            projects: vec![config::ProjectUserEntry {
                name: "test".to_string(),
                dir: "/tmp/test".to_string(),
                claude: None,
                integrations: None,
                plugin_settings: None,
                policy: None,
                effort_pin: None,
            }],
            active_project: None,
            selected_ide: None,
            ui: None,
            telemetry: None,
        };
        let result = ChatSession::prepare_args(
            "test",
            &user_config,
            "inst",
            Some("550e8400-e29b-41d4-a716-446655440000"),
            Some("$(rm -rf /)"),
        );
        assert!(result.is_err(), "shell-injection uuid must be rejected");
    }

    #[test]
    fn prepare_args_succeeds_with_valid_project() {
        let user_config = config::SpeedwaveUserConfig {
            projects: vec![config::ProjectUserEntry {
                name: "myproject".to_string(),
                dir: "/home/user/myproject".to_string(),
                claude: None,
                integrations: None,
                plugin_settings: None,
                policy: None,
                effort_pin: None,
            }],
            active_project: None,
            selected_ide: None,
            ui: None,
            telemetry: None,
        };
        let result = ChatSession::prepare_args("myproject", &user_config, "inst", None, None);
        assert!(result.is_ok());
        let PreparedSpawn {
            args, container, ..
        } = result.unwrap();
        assert!(args.contains(&"-p".to_string()));
        assert!(container.contains("myproject"));
        assert!(!args.contains(&"--effort".to_string()));
        assert!(!args.contains(&"--model".to_string()));
    }

    #[test]
    fn prepare_args_includes_effort_flag_when_a_pin_exists() {
        let mut user_config = config::SpeedwaveUserConfig {
            projects: vec![config::ProjectUserEntry {
                name: "myproject".to_string(),
                dir: "/home/user/myproject".to_string(),
                claude: None,
                integrations: None,
                plugin_settings: None,
                policy: None,
                effort_pin: Some("xhigh".to_string()),
            }],
            active_project: None,
            selected_ide: None,
            ui: None,
            telemetry: None,
        };
        let args = ChatSession::prepare_args("myproject", &user_config, "inst", None, None)
            .unwrap()
            .args;
        let effort_count = args.iter().filter(|a| *a == "--effort").count();
        assert_eq!(effort_count, 1, "exactly one --effort flag, got: {args:?}");
        let pos = args.iter().position(|a| a == "--effort").unwrap();
        assert_eq!(args[pos + 1], "xhigh");

        user_config.projects[0].effort_pin = Some("max".to_string());
        let args = ChatSession::prepare_args("myproject", &user_config, "inst", None, None)
            .unwrap()
            .args;
        let effort_count = args.iter().filter(|a| *a == "--effort").count();
        assert_eq!(effort_count, 1);
        let pos = args.iter().position(|a| a == "--effort").unwrap();
        assert_eq!(args[pos + 1], "max");
    }

    #[test]
    fn a_resumed_spawn_carries_the_pin_and_never_an_unknown_level() {
        let session_id = "11111111-2222-3333-4444-555555555555";
        let mut user_config = config::SpeedwaveUserConfig {
            projects: vec![config::ProjectUserEntry {
                name: "myproject".to_string(),
                dir: "/home/user/myproject".to_string(),
                claude: None,
                integrations: None,
                plugin_settings: None,
                policy: None,
                effort_pin: None,
            }],
            active_project: None,
            selected_ide: None,
            ui: None,
            telemetry: None,
        };
        let spawn =
            ChatSession::prepare_args("myproject", &user_config, "inst", Some(session_id), None)
                .unwrap();
        assert!(!spawn.args.contains(&"--effort".to_string()));

        user_config.projects[0].effort_pin = Some("low".to_string());
        let spawn =
            ChatSession::prepare_args("myproject", &user_config, "inst", Some(session_id), None)
                .unwrap();
        let pos = spawn.args.iter().position(|a| a == "--effort").unwrap();
        assert_eq!(spawn.args[pos + 1], "low");
        assert!(spawn.args.contains(&"--resume".to_string()));

        user_config.projects[0].effort_pin = Some("turbo".to_string());
        let spawn =
            ChatSession::prepare_args("myproject", &user_config, "inst", Some(session_id), None)
                .unwrap();
        assert!(
            !spawn.args.contains(&"--effort".to_string()),
            "an unknown pin is never launched"
        );
    }

    #[test]
    fn error_chunk_carries_turn_ended_only_when_set() {
        let mid_turn = serde_json::to_value(StreamChunk::Error {
            content: "rate limit".to_string(),
            turn_ended: false,
        })
        .unwrap();
        assert!(mid_turn["data"].get("turn_ended").is_none(), "{mid_turn}");

        let ended = serde_json::to_value(StreamChunk::Error {
            content: "overloaded".to_string(),
            turn_ended: true,
        })
        .unwrap();
        assert_eq!(ended["data"]["turn_ended"], serde_json::Value::Bool(true));

        let decoded: StreamChunk =
            serde_json::from_str(r#"{"chunk_type":"Error","data":{"content":"x"}}"#).unwrap();
        assert!(matches!(
            decoded,
            StreamChunk::Error {
                turn_ended: false,
                ..
            }
        ));
    }

    #[test]
    fn prepare_args_with_resume_includes_resume_flag() {
        let user_config = config::SpeedwaveUserConfig {
            projects: vec![config::ProjectUserEntry {
                name: "proj".to_string(),
                dir: "/tmp/proj".to_string(),
                claude: None,
                integrations: None,
                plugin_settings: None,
                policy: None,
                effort_pin: None,
            }],
            active_project: None,
            selected_ide: None,
            ui: None,
            telemetry: None,
        };
        let session_id = "550e8400-e29b-41d4-a716-446655440000";
        let result =
            ChatSession::prepare_args("proj", &user_config, "my-inst", Some(session_id), None);
        assert!(result.is_ok());
        let args = result.unwrap().args;
        assert!(args.contains(&format!(
            "{}=my-inst",
            speedwave_runtime::session::SESSION_INSTANCE_ENV
        )));
        assert!(args.contains(&"--resume".to_string()));
        assert!(args.contains(&session_id.to_string()));
        assert!(!args.contains(&"--resume-session-at".to_string()));
    }

    #[test]
    fn prepare_args_with_retry_uuid_includes_resume_session_at_flag() {
        let user_config = config::SpeedwaveUserConfig {
            projects: vec![config::ProjectUserEntry {
                name: "proj".to_string(),
                dir: "/tmp/proj".to_string(),
                claude: None,
                integrations: None,
                plugin_settings: None,
                policy: None,
                effort_pin: None,
            }],
            active_project: None,
            selected_ide: None,
            ui: None,
            telemetry: None,
        };
        let session_id = "550e8400-e29b-41d4-a716-446655440000";
        let uuid = "msg_retry_me";
        let result =
            ChatSession::prepare_args("proj", &user_config, "inst", Some(session_id), Some(uuid));
        assert!(result.is_ok());
        let args = result.unwrap().args;
        assert!(args.contains(&"--resume-session-at".to_string()));
        assert!(args.contains(&uuid.to_string()));
    }

    fn single_project_user_config() -> config::SpeedwaveUserConfig {
        config::SpeedwaveUserConfig {
            projects: vec![config::ProjectUserEntry {
                name: "proj".to_string(),
                dir: "/tmp/proj".to_string(),
                claude: None,
                integrations: None,
                plugin_settings: None,
                policy: None,
                effort_pin: None,
            }],
            active_project: None,
            selected_ide: None,
            ui: None,
            telemetry: None,
        }
    }

    #[test]
    fn prepare_args_never_appends_a_model_flag_without_a_pin_file() {
        let user_config = single_project_user_config();
        let args = ChatSession::prepare_args("proj", &user_config, "inst", None, None)
            .unwrap()
            .args;
        assert!(!args.contains(&"--model".to_string()));
    }

    #[test]
    fn prepare_args_never_appends_a_model_flag_even_with_a_model_pin_file() {
        let tmp = tempfile::tempdir().unwrap();
        speedwave_runtime::claude_settings::set_model_pin(
            tmp.path(),
            "proj",
            "claude-sonnet-5",
            &[],
        )
        .unwrap();
        let user_config = single_project_user_config();
        let args = ChatSession::prepare_args("proj", &user_config, "inst", None, None)
            .unwrap()
            .args;
        assert!(!args.contains(&"--model".to_string()));
    }

    #[test]
    fn validate_retry_uuid_accepts_api_msg_ids() {
        assert!(validate_retry_uuid("msg_01ABCdef_123").is_ok());
    }

    #[test]
    fn validate_retry_uuid_accepts_uuid_v4() {
        assert!(validate_retry_uuid("550e8400-e29b-41d4-a716-446655440000").is_ok());
    }

    #[test]
    fn validate_retry_uuid_rejects_empty() {
        assert!(validate_retry_uuid("").is_err());
    }

    #[test]
    fn validate_retry_uuid_rejects_shell_metachars() {
        for bad in ["a;b", "a b", "a|b", "`id`", "a$b", "a&b", "a'b", "a\"b"] {
            assert!(
                validate_retry_uuid(bad).is_err(),
                "must reject shell-injection uuid: {bad:?}"
            );
        }
    }

    #[test]
    fn validate_retry_uuid_rejects_path_traversal() {
        for bad in ["../x", "a/b", "a\\b"] {
            assert!(
                validate_retry_uuid(bad).is_err(),
                "must reject path-traversal uuid: {bad:?}"
            );
        }
    }

    #[test]
    fn validate_retry_uuid_rejects_overlong() {
        let too_long = "a".repeat(129);
        assert!(validate_retry_uuid(&too_long).is_err());
    }

    #[test]
    fn tool_use_with_empty_id_returns_none() {
        let mut parser = StreamParser::new();
        let line = r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"","name":"Read"}}}"#;
        assert!(
            parse_line_str(&mut parser, line).is_none(),
            "empty tool_use id should return None"
        );
    }

    #[test]
    fn tool_use_with_missing_id_returns_none() {
        let mut parser = StreamParser::new();
        let line = r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","name":"Read"}}}"#;
        assert!(
            parse_line_str(&mut parser, line).is_none(),
            "missing tool_use id should return None"
        );
    }

    #[test]
    fn tool_use_with_empty_name_returns_none() {
        let mut parser = StreamParser::new();
        let line = r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_01","name":""}}}"#;
        assert!(
            parse_line_str(&mut parser, line).is_none(),
            "empty tool_use name should return None"
        );
    }

    #[test]
    fn tool_use_with_missing_name_returns_none() {
        let mut parser = StreamParser::new();
        let line = r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_01"}}}"#;
        assert!(
            parse_line_str(&mut parser, line).is_none(),
            "missing tool_use name should return None"
        );
    }

    #[test]
    fn tool_result_with_empty_tool_use_id_returns_none() {
        let mut parser = StreamParser::new();
        let line = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"","content":"file contents"}]}}"#;
        assert!(
            parse_line_str(&mut parser, line).is_none(),
            "empty tool_use_id in tool_result should return None"
        );
    }

    #[test]
    fn tool_result_with_missing_tool_use_id_returns_none() {
        let mut parser = StreamParser::new();
        let line = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"file contents"}]}}"#;
        assert!(
            parse_line_str(&mut parser, line).is_none(),
            "missing tool_use_id in tool_result should return None"
        );
    }

    #[test]
    fn result_with_missing_session_id_still_emits_result() {
        let mut parser = StreamParser::new();
        let line = r#"{"type":"result","is_error":false,"result":"","total_cost_usd":0.01}"#;
        let chunk = parse_line_str(&mut parser, line).unwrap();
        match chunk {
            StreamChunk::Result { session_id, .. } => {
                assert_eq!(
                    session_id, "",
                    "missing session_id should default to empty string"
                );
            }
            other => panic!("expected Result, got {other:?}"),
        }
    }

    #[test]
    fn control_request_stores_tool_name() {
        let ctrl = ControlRequest {
            request_id: "req_1".to_string(),
            tool_name: "AskUserQuestion".to_string(),
            input: serde_json::json!({"question": "test"}),
            tool_use_id: "toolu_test".to_string(),
        };
        assert_eq!(ctrl.tool_name, "AskUserQuestion");
    }

    #[test]
    fn control_request_turn_fixture_produces_expected_chunks() {
        let fixture = include_str!("../tests/fixtures/control_request_turn.ndjson");
        let mut parser = StreamParser::new();
        let mut chunks: Vec<StreamChunk> = Vec::new();

        for line in fixture.lines() {
            if let Some(ctrl) = try_parse_control_request_str(line) {
                if ctrl.tool_name == ASK_USER_TOOL_NAME {
                    if let Some(chunk) = StreamParser::emit_ask_user_from_control_request(&ctrl) {
                        chunks.push(chunk);
                    }
                }
                continue;
            }
            if let Some(chunk) = parse_line_str(&mut parser, line) {
                chunks.push(chunk);
            }
        }

        assert_eq!(chunks.len(), 4, "expected 4 chunks, got {}", chunks.len());

        match &chunks[0] {
            StreamChunk::Text { content } => assert_eq!(content, "Let me check."),
            other => panic!("chunk 0: expected Text, got {other:?}"),
        }
        match &chunks[1] {
            StreamChunk::AskUserQuestion {
                tool_id,
                questions,
                current_index,
            } => {
                assert_eq!(tool_id, "toolu_ask_ctrl1");
                assert_eq!(*current_index, 0);
                assert_eq!(questions.len(), 1);
                assert_eq!(questions[0].question, "Allow file read?");
            }
            other => panic!("chunk 1: expected AskUserQuestion, got {other:?}"),
        }
        match &chunks[2] {
            StreamChunk::Text { content } => assert_eq!(content, "Done."),
            other => panic!("chunk 2: expected Text, got {other:?}"),
        }
        match &chunks[3] {
            StreamChunk::Result { session_id, .. } => {
                assert_eq!(session_id, "ctrl-session-001");
            }
            other => panic!("chunk 3: expected Result, got {other:?}"),
        }
    }

    #[test]
    fn slash_command_result_includes_result_text() {
        let mut parser = StreamParser::new();
        let line = r#"{"type":"result","session_id":"abc","total_cost_usd":0.0,"usage":{"input_tokens":0,"output_tokens":0},"is_error":false,"result":"Session cost: $0.003\nTotal cost: $0.015"}"#;
        let chunk = parse_line_str(&mut parser, line).unwrap();
        match chunk {
            StreamChunk::Result { result_text, .. } => {
                assert_eq!(
                    result_text.as_deref(),
                    Some("Session cost: $0.003\nTotal cost: $0.015")
                );
            }
            other => panic!("expected Result, got {other:?}"),
        }
    }

    #[test]
    fn whitespace_only_result_is_none() {
        let mut parser = StreamParser::new();
        let line = r#"{"type":"result","session_id":"abc","is_error":false,"result":"  \n  "}"#;
        let chunk = parse_line_str(&mut parser, line).unwrap();
        match chunk {
            StreamChunk::Result { result_text, .. } => {
                assert!(
                    result_text.is_none(),
                    "whitespace-only result should be None"
                );
            }
            other => panic!("expected Result, got {other:?}"),
        }
    }

    #[test]
    fn result_text_skipped_in_serialization_when_none() {
        let chunk = StreamChunk::Result {
            session_id: "abc".to_string(),
            total_cost: None,
            usage: None,
            result_text: None,
            context_window_size: None,
            assistant_uuid: None,
            turn_usage: None,
            turn_cost: None,
            model: None,
            context_usage: None,
        };
        let json = serde_json::to_string(&chunk).unwrap();
        assert!(
            !json.contains("result_text"),
            "result_text should be absent when None, got: {json}"
        );
        assert!(
            !json.contains("context_window_size"),
            "context_window_size should be absent when None, got: {json}"
        );
        assert!(
            !json.contains("assistant_uuid"),
            "assistant_uuid should be absent when None, got: {json}"
        );
        assert!(!json.contains("turn_usage"));
        assert!(!json.contains("turn_cost"));
        assert!(!json.contains("\"model\""));
        assert!(!json.contains("context_usage"));
    }

    #[test]
    fn context_window_size_present_in_serialization_when_some() {
        let chunk = StreamChunk::Result {
            session_id: "abc".to_string(),
            total_cost: None,
            usage: None,
            result_text: None,
            context_window_size: Some(1_000_000),
            assistant_uuid: None,
            turn_usage: None,
            turn_cost: None,
            model: None,
            context_usage: None,
        };
        let json = serde_json::to_string(&chunk).unwrap();
        assert!(
            json.contains("\"context_window_size\":1000000"),
            "context_window_size should be present when Some, got: {json}"
        );
    }

    fn assistant_line(input: u64, cr: u64, cw: u64, out: u64, parent: Option<&str>) -> String {
        let parent = parent.map_or("null".to_string(), |p| format!("\"{p}\""));
        format!(
            r#"{{"type":"assistant","parent_tool_use_id":{parent},"message":{{"id":"msg_1","role":"assistant","usage":{{"input_tokens":{input},"cache_read_input_tokens":{cr},"cache_creation_input_tokens":{cw},"output_tokens":{out}}}}}}}"#
        )
    }

    const RESULT_LINE: &str = r#"{"type":"result","session_id":"s","is_error":false,"result":"","total_cost_usd":0.01,"usage":{"input_tokens":10,"output_tokens":20}}"#;

    #[test]
    fn result_carries_last_assistant_call_usage_not_the_turn_sum() {
        let mut parser = StreamParser::new();
        for cr in [110_000, 120_000, 130_000] {
            parse_line_str(&mut parser, &assistant_line(5, cr, 100, 50, None));
        }
        let chunk = parse_line_str(&mut parser, RESULT_LINE).unwrap();
        match chunk {
            StreamChunk::Result { context_usage, .. } => {
                let cu = context_usage.expect("context_usage must be present");
                assert_eq!(cu.cache_read_tokens, 130_000);
                assert_eq!(cu.input_tokens, 5);
                assert_eq!(cu.cache_write_tokens, 100);
                assert_eq!(cu.output_tokens, 50);
            }
            other => panic!("expected Result, got {other:?}"),
        }
    }

    #[test]
    fn sidechain_assistant_usage_never_moves_the_context_meter() {
        let mut parser = StreamParser::new();
        parse_line_str(&mut parser, &assistant_line(5, 60_000, 100, 50, None));
        parse_line_str(
            &mut parser,
            &assistant_line(9, 180_000, 900, 90, Some("toolu_task_1")),
        );
        let chunk = parse_line_str(&mut parser, RESULT_LINE).unwrap();
        match chunk {
            StreamChunk::Result { context_usage, .. } => {
                assert_eq!(context_usage.unwrap().cache_read_tokens, 60_000);
            }
            other => panic!("expected Result, got {other:?}"),
        }
    }

    #[test]
    fn is_sidechain_event_true_via_parent_tool_use_id() {
        let v = serde_json::json!({"parent_tool_use_id": "toolu_1"});
        assert!(is_sidechain_event(&v));
    }

    #[test]
    fn is_sidechain_event_true_via_is_sidechain_flag() {
        let v = serde_json::json!({"isSidechain": true});
        assert!(is_sidechain_event(&v));
    }

    #[test]
    fn is_sidechain_event_true_when_both_signals_present() {
        let v = serde_json::json!({"parent_tool_use_id": "toolu_1", "isSidechain": true});
        assert!(is_sidechain_event(&v));
    }

    #[test]
    fn is_sidechain_event_false_when_neither_signal_present() {
        let v = serde_json::json!({"type": "assistant"});
        assert!(!is_sidechain_event(&v));
    }

    #[test]
    fn is_sidechain_event_false_for_null_parent_and_false_is_sidechain() {
        let v = serde_json::json!({"parent_tool_use_id": null, "isSidechain": false});
        assert!(!is_sidechain_event(&v));
    }

    #[test]
    fn is_sidechain_event_false_for_non_boolean_is_sidechain() {
        let v = serde_json::json!({"isSidechain": "true"});
        assert!(!is_sidechain_event(&v));
    }

    #[test]
    fn all_zero_assistant_usage_keeps_previous_context_usage() {
        let mut parser = StreamParser::new();
        parse_line_str(&mut parser, &assistant_line(5, 60_000, 100, 50, None));
        parse_line_str(&mut parser, &assistant_line(0, 0, 0, 0, None));
        let chunk = parse_line_str(&mut parser, RESULT_LINE).unwrap();
        match chunk {
            StreamChunk::Result { context_usage, .. } => {
                assert_eq!(context_usage.unwrap().cache_read_tokens, 60_000);
            }
            other => panic!("expected Result, got {other:?}"),
        }
    }

    #[test]
    fn context_usage_absent_before_any_assistant_call_then_persists_across_turns() {
        let mut parser = StreamParser::new();
        match parse_line_str(&mut parser, RESULT_LINE).unwrap() {
            StreamChunk::Result { context_usage, .. } => assert!(context_usage.is_none()),
            other => panic!("expected Result, got {other:?}"),
        }
        parse_line_str(&mut parser, &assistant_line(5, 70_000, 100, 50, None));
        parse_line_str(&mut parser, RESULT_LINE).unwrap();
        match parse_line_str(&mut parser, RESULT_LINE).unwrap() {
            StreamChunk::Result { context_usage, .. } => {
                assert_eq!(context_usage.unwrap().cache_read_tokens, 70_000);
            }
            other => panic!("expected Result, got {other:?}"),
        }
    }

    #[test]
    fn restore_session_snapshot_seeds_context_usage_for_first_result() {
        let mut parser = StreamParser::new();
        parser.restore_session_snapshot(
            TurnUsage::default(),
            None,
            None,
            Some(TurnUsage {
                input_tokens: 2,
                output_tokens: 1_660,
                cache_read_tokens: 66_844,
                cache_write_tokens: 4_920,
            }),
        );
        match parse_line_str(&mut parser, RESULT_LINE).unwrap() {
            StreamChunk::Result { context_usage, .. } => {
                assert_eq!(context_usage.unwrap().cache_read_tokens, 66_844);
            }
            other => panic!("expected Result, got {other:?}"),
        }
    }

    #[test]
    fn context_usage_serializes_with_full_turn_usage_shape() {
        let chunk = StreamChunk::Result {
            session_id: "abc".to_string(),
            total_cost: None,
            usage: None,
            result_text: None,
            context_window_size: None,
            assistant_uuid: None,
            turn_usage: None,
            turn_cost: None,
            model: None,
            context_usage: Some(TurnUsage {
                input_tokens: 2,
                output_tokens: 3,
                cache_read_tokens: 4,
                cache_write_tokens: 5,
            }),
        };
        let json = serde_json::to_string(&chunk).unwrap();
        assert!(
            json.contains(
                "\"context_usage\":{\"input_tokens\":2,\"output_tokens\":3,\"cache_read_tokens\":4,\"cache_write_tokens\":5}"
            ),
            "unexpected serialization: {json}"
        );
    }

    #[test]
    fn slash_command_fixture_produces_result_with_text() {
        let fixture = include_str!("../tests/fixtures/slash_command_turn.ndjson");
        let mut parser = StreamParser::new();
        let chunks: Vec<StreamChunk> = fixture
            .lines()
            .filter_map(|line| parse_line_str(&mut parser, line))
            .collect();

        assert_eq!(chunks.len(), 1, "expected 1 chunk, got {}", chunks.len());
        match &chunks[0] {
            StreamChunk::Result {
                result_text,
                session_id,
                ..
            } => {
                assert_eq!(session_id, "550e8400-e29b-41d4-a716-446655440000");
                assert!(
                    result_text.is_some(),
                    "slash command should have result_text"
                );
                assert!(result_text.as_ref().unwrap().contains("Session cost"));
            }
            other => panic!("expected Result, got {other:?}"),
        }
    }

    #[test]
    fn tool_use_start_produces_log_entry() {
        let mut parser = StreamParser::new();
        let line = r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_01ABC","name":"Read","input":{}}}}"#;
        let (chunk, log_entry) = parse_line_full(&mut parser, line);
        assert!(chunk.is_some(), "should produce ToolStart chunk");
        let entry = log_entry.unwrap();
        assert_eq!(entry.prefix, "TOOL");
        assert!(
            entry.message.contains("start: Read (toolu_01ABC)"),
            "message: {}",
            entry.message
        );
    }

    #[test]
    fn tool_use_stop_produces_log_entry() {
        let mut parser = StreamParser::new();
        let start = r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_01ABC","name":"Read","input":{}}}}"#;
        parse_line_full(&mut parser, start);
        let stop = r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0}}"#;
        let (chunk, log_entry) = parse_line_full(&mut parser, stop);
        assert!(chunk.is_none(), "content_block_stop should not emit chunk");
        let entry = log_entry.unwrap();
        assert_eq!(entry.prefix, "TOOL");
        assert!(
            entry.message.contains("stop: Read (toolu_01ABC)"),
            "message: {}",
            entry.message
        );
    }

    #[test]
    fn content_block_stop_without_tool_produces_no_log_entry() {
        let mut parser = StreamParser::new();
        let stop = r#"{"type":"stream_event","event":{"type":"content_block_stop","index":99}}"#;
        let (chunk, log_entry) = parse_line_full(&mut parser, stop);
        assert!(chunk.is_none());
        assert!(log_entry.is_none());
    }

    #[test]
    fn result_produces_log_entry() {
        let mut parser = StreamParser::new();
        let line = r#"{"type":"result","session_id":"abc123","total_cost_usd":0.003,"is_error":false,"result":""}"#;
        let (chunk, log_entry) = parse_line_full(&mut parser, line);
        assert!(chunk.is_some(), "should produce Result chunk");
        let entry = log_entry.unwrap();
        assert_eq!(entry.prefix, "RESULT");
        assert_eq!(entry.message, "turn complete");
    }

    #[test]
    fn text_delta_produces_no_log_entry() {
        let mut parser = StreamParser::new();
        let line = r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}}"#;
        let (_chunk, log_entry) = parse_line_full(&mut parser, line);
        assert!(
            log_entry.is_none(),
            "text_delta should not produce log entry"
        );
    }

    #[test]
    fn user_tool_result_produces_log_entry() {
        let mut parser = StreamParser::new();
        let line = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_01ABC","content":"output","is_error":true}]}}"#;
        let (chunk, log_entry) = parse_line_full(&mut parser, line);
        assert!(chunk.is_some(), "should produce ToolResult chunk");
        let entry = log_entry.unwrap();
        assert_eq!(entry.prefix, "TOOL");
        assert!(
            entry.message.contains("result: toolu_01ABC error=true"),
            "message: {}",
            entry.message
        );
    }

    #[test]
    fn user_tool_result_no_error_produces_log_entry() {
        let mut parser = StreamParser::new();
        let line = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t2","content":"ok"}]}}"#;
        let (_chunk, log_entry) = parse_line_full(&mut parser, line);
        let entry = log_entry.unwrap();
        assert!(
            entry.message.contains("result: t2 error=false"),
            "message: {}",
            entry.message
        );
    }

    #[test]
    fn chat_session_new_has_no_session_log_path() {
        let session = ChatSession::new("test-project");
        assert!(session.session_log_path.is_none());
        assert!(session.drain_handles.is_empty());
    }

    #[test]
    fn chat_session_stop_on_new_does_not_create_log_file() {
        let tmp = tempfile::tempdir().unwrap();
        let log_path = tmp
            .path()
            .join(".speedwave/logs/default/claude-session.log");
        let mut session = ChatSession::new("default");
        session.stop().unwrap();
        assert!(
            !log_path.exists(),
            "stop() on fresh session should not create log file"
        );
    }

    #[test]
    fn turn_usage_from_usage_info_defaults_missing_cache_fields_to_zero() {
        let info = UsageInfo {
            input_tokens: 5,
            output_tokens: 7,
            cache_read_tokens: None,
            cache_write_tokens: None,
        };
        let turn = TurnUsage::from_usage_info(&info);
        assert_eq!(turn.input_tokens, 5);
        assert_eq!(turn.output_tokens, 7);
        assert_eq!(turn.cache_read_tokens, 0);
        assert_eq!(turn.cache_write_tokens, 0);
    }

    #[test]
    fn turn_usage_from_usage_info_preserves_present_cache_fields() {
        let info = UsageInfo {
            input_tokens: 1,
            output_tokens: 2,
            cache_read_tokens: Some(10),
            cache_write_tokens: Some(20),
        };
        let turn = TurnUsage::from_usage_info(&info);
        assert_eq!(turn.cache_read_tokens, 10);
        assert_eq!(turn.cache_write_tokens, 20);
    }

    #[test]
    fn turn_usage_delta_subtracts_field_by_field() {
        let prev = TurnUsage {
            input_tokens: 100,
            output_tokens: 50,
            cache_read_tokens: 200,
            cache_write_tokens: 10,
        };
        let curr = TurnUsage {
            input_tokens: 150,
            output_tokens: 75,
            cache_read_tokens: 500,
            cache_write_tokens: 12,
        };
        let delta = TurnUsage::delta(&curr, &prev);
        assert_eq!(delta.input_tokens, 50);
        assert_eq!(delta.output_tokens, 25);
        assert_eq!(delta.cache_read_tokens, 300);
        assert_eq!(delta.cache_write_tokens, 2);
    }

    #[test]
    fn turn_usage_delta_saturates_on_reset() {
        let prev = TurnUsage {
            input_tokens: 500,
            output_tokens: 500,
            cache_read_tokens: 500,
            cache_write_tokens: 500,
        };
        let curr = TurnUsage {
            input_tokens: 100,
            output_tokens: 100,
            cache_read_tokens: 100,
            cache_write_tokens: 100,
        };
        let delta = TurnUsage::delta(&curr, &prev);
        assert_eq!(delta.input_tokens, 0);
        assert_eq!(delta.output_tokens, 0);
        assert_eq!(delta.cache_read_tokens, 0);
        assert_eq!(delta.cache_write_tokens, 0);
    }

    #[test]
    fn turn_usage_from_jsonl_maps_all_fields() {
        let u = serde_json::json!({
            "input_tokens": 12,
            "output_tokens": 34,
            "cache_read_input_tokens": 56,
            "cache_creation_input_tokens": 78,
        });
        let turn = turn_usage_from_jsonl(&u).expect("object must parse");
        assert_eq!(turn.input_tokens, 12);
        assert_eq!(turn.output_tokens, 34);
        assert_eq!(turn.cache_read_tokens, 56);
        assert_eq!(turn.cache_write_tokens, 78);
    }

    #[test]
    fn turn_usage_from_jsonl_zero_fills_missing_fields() {
        let u = serde_json::json!({ "input_tokens": 5 });
        let turn = turn_usage_from_jsonl(&u).expect("partial object must parse");
        assert_eq!(turn.input_tokens, 5);
        assert_eq!(turn.output_tokens, 0);
        assert_eq!(turn.cache_read_tokens, 0);
        assert_eq!(turn.cache_write_tokens, 0);
    }

    #[test]
    fn turn_usage_from_jsonl_zero_fills_malformed_values() {
        let u = serde_json::json!({
            "input_tokens": "many",
            "output_tokens": -3,
            "cache_read_input_tokens": 1.5,
            "cache_creation_input_tokens": null,
        });
        let turn = turn_usage_from_jsonl(&u).expect("object must parse");
        assert_eq!(turn, TurnUsage::default());
    }

    #[test]
    fn turn_usage_from_jsonl_non_object_is_none() {
        for v in [
            serde_json::Value::Null,
            serde_json::json!("usage"),
            serde_json::json!(7),
            serde_json::json!([1, 2]),
        ] {
            assert!(turn_usage_from_jsonl(&v).is_none(), "expected None for {v}");
        }
    }

    #[test]
    fn parse_result_emits_turn_usage_from_flat_per_step_usage() {
        let mut parser = StreamParser::new();
        let line = r#"{"type":"result","session_id":"s1","is_error":false,"result":"","total_cost_usd":0.003,"usage":{"input_tokens":10,"output_tokens":20,"cache_read_input_tokens":30,"cache_creation_input_tokens":40}}"#;
        let chunk = parse_line_str(&mut parser, line).unwrap();
        match chunk {
            StreamChunk::Result {
                turn_usage,
                turn_cost,
                ..
            } => {
                let t = turn_usage.expect("turn_usage should be populated");
                assert_eq!(t.input_tokens, 10);
                assert_eq!(t.output_tokens, 20);
                assert_eq!(t.cache_read_tokens, 30);
                assert_eq!(t.cache_write_tokens, 40);
                assert_eq!(turn_cost, Some(0.003));
            }
            other => panic!("expected Result, got {other:?}"),
        }
    }

    #[test]
    fn parse_result_three_turn_cumulative_modelusage_produces_correct_deltas() {
        let mut parser = StreamParser::new();
        let t1 = r#"{"type":"result","session_id":"s","is_error":false,"result":"","total_cost_usd":0.01,"modelUsage":{"claude-opus-4-7":{"inputTokens":5,"outputTokens":3,"cacheReadInputTokens":0,"cacheCreationInputTokens":10}}}"#;
        let c1 = parse_line_str(&mut parser, t1).unwrap();
        match c1 {
            StreamChunk::Result {
                turn_usage,
                turn_cost,
                ..
            } => {
                let t = turn_usage.unwrap();
                assert_eq!(t.input_tokens, 5);
                assert_eq!(t.output_tokens, 3);
                assert_eq!(t.cache_read_tokens, 0);
                assert_eq!(t.cache_write_tokens, 10);
                assert_eq!(turn_cost, Some(0.01));
            }
            other => panic!("expected Result, got {other:?}"),
        }

        let t2 = r#"{"type":"result","session_id":"s","is_error":false,"result":"","total_cost_usd":0.025,"modelUsage":{"claude-opus-4-7":{"inputTokens":12,"outputTokens":8,"cacheReadInputTokens":100,"cacheCreationInputTokens":10}}}"#;
        let c2 = parse_line_str(&mut parser, t2).unwrap();
        match c2 {
            StreamChunk::Result {
                turn_usage,
                turn_cost,
                ..
            } => {
                let t = turn_usage.unwrap();
                assert_eq!(t.input_tokens, 7);
                assert_eq!(t.output_tokens, 5);
                assert_eq!(t.cache_read_tokens, 100);
                assert_eq!(t.cache_write_tokens, 0);
                assert!((turn_cost.unwrap() - 0.015).abs() < 1e-9);
            }
            other => panic!("expected Result, got {other:?}"),
        }

        let t3 = r#"{"type":"result","session_id":"s","is_error":false,"result":"","total_cost_usd":0.040,"modelUsage":{"claude-opus-4-7":{"inputTokens":20,"outputTokens":13,"cacheReadInputTokens":200,"cacheCreationInputTokens":10}}}"#;
        let c3 = parse_line_str(&mut parser, t3).unwrap();
        match c3 {
            StreamChunk::Result {
                turn_usage,
                turn_cost,
                ..
            } => {
                let t = turn_usage.unwrap();
                assert_eq!(t.input_tokens, 8);
                assert_eq!(t.output_tokens, 5);
                assert_eq!(t.cache_read_tokens, 100);
                assert_eq!(t.cache_write_tokens, 0);
                assert!((turn_cost.unwrap() - 0.015).abs() < 1e-9);
            }
            other => panic!("expected Result, got {other:?}"),
        }
    }

    #[test]
    fn parse_result_resume_session_restores_snapshot_correctly() {
        let mut parser = StreamParser::new();
        parser.restore_session_snapshot(
            TurnUsage {
                input_tokens: 100,
                output_tokens: 50,
                cache_read_tokens: 200,
                cache_write_tokens: 30,
            },
            Some(0.25),
            Some("claude-sonnet-4-6".to_string()),
            None,
        );

        let line = r#"{"type":"result","session_id":"s","is_error":false,"result":"","total_cost_usd":0.30,"modelUsage":{"claude-sonnet-4-6":{"inputTokens":110,"outputTokens":55,"cacheReadInputTokens":200,"cacheCreationInputTokens":30}}}"#;
        let chunk = parse_line_str(&mut parser, line).unwrap();
        match chunk {
            StreamChunk::Result {
                turn_usage,
                turn_cost,
                model,
                ..
            } => {
                let t = turn_usage.unwrap();
                assert_eq!(t.input_tokens, 10);
                assert_eq!(t.output_tokens, 5);
                assert_eq!(t.cache_read_tokens, 0);
                assert_eq!(t.cache_write_tokens, 0);
                assert!((turn_cost.unwrap() - 0.05).abs() < 1e-9);
                assert_eq!(model.as_deref(), Some("claude-sonnet-4-6"));
            }
            other => panic!("expected Result, got {other:?}"),
        }

        let snap = parser.previous_session_usage();
        assert_eq!(snap.input_tokens, 110);
        assert_eq!(snap.output_tokens, 55);
    }

    #[test]
    fn parse_result_uses_systeminit_model_when_modelusage_absent() {
        let mut parser = StreamParser::new();
        let init = r#"{"type":"system","subtype":"init","model":"claude-haiku-4-5"}"#;
        parse_line_str(&mut parser, init);

        let line = r#"{"type":"result","session_id":"s","is_error":false,"result":"","total_cost_usd":0.001,"usage":{"input_tokens":1,"output_tokens":1}}"#;
        let chunk = parse_line_str(&mut parser, line).unwrap();
        match chunk {
            StreamChunk::Result { model, .. } => {
                assert_eq!(model.as_deref(), Some("claude-haiku-4-5"));
            }
            other => panic!("expected Result, got {other:?}"),
        }
    }

    #[test]
    fn parse_result_without_any_usage_emits_no_turn_usage() {
        let mut parser = StreamParser::new();
        let line = r#"{"type":"result","session_id":"s","is_error":false,"result":""}"#;
        let chunk = parse_line_str(&mut parser, line).unwrap();
        match chunk {
            StreamChunk::Result {
                turn_usage,
                turn_cost,
                model,
                ..
            } => {
                assert!(turn_usage.is_none());
                assert!(turn_cost.is_none());
                assert!(model.is_none());
            }
            other => panic!("expected Result, got {other:?}"),
        }
    }

    #[test]
    fn parse_result_treats_missing_cache_fields_as_zero() {
        let mut parser = StreamParser::new();
        let line = r#"{"type":"result","session_id":"s","is_error":false,"result":"","total_cost_usd":0.001,"usage":{"input_tokens":3,"output_tokens":4}}"#;
        let chunk = parse_line_str(&mut parser, line).unwrap();
        match chunk {
            StreamChunk::Result { turn_usage, .. } => {
                let t = turn_usage.unwrap();
                assert_eq!(t.input_tokens, 3);
                assert_eq!(t.output_tokens, 4);
                assert_eq!(t.cache_read_tokens, 0);
                assert_eq!(t.cache_write_tokens, 0);
            }
            other => panic!("expected Result, got {other:?}"),
        }
    }

    #[test]
    fn parse_result_first_turn_cost_uses_total_cost_when_no_prior_snapshot() {
        let mut parser = StreamParser::new();
        let line = r#"{"type":"result","session_id":"s","is_error":false,"result":"","total_cost_usd":0.123,"usage":{"input_tokens":1,"output_tokens":1}}"#;
        let chunk = parse_line_str(&mut parser, line).unwrap();
        match chunk {
            StreamChunk::Result { turn_cost, .. } => {
                assert_eq!(turn_cost, Some(0.123));
            }
            other => panic!("expected Result, got {other:?}"),
        }
    }

    #[test]
    fn parse_result_turn_cost_is_none_when_total_cost_absent() {
        let mut parser = StreamParser::new();
        let line = r#"{"type":"result","session_id":"s","is_error":false,"result":"","usage":{"input_tokens":1,"output_tokens":1}}"#;
        let chunk = parse_line_str(&mut parser, line).unwrap();
        match chunk {
            StreamChunk::Result { turn_cost, .. } => {
                assert!(turn_cost.is_none());
            }
            other => panic!("expected Result, got {other:?}"),
        }
    }

    #[test]
    fn new_session_resets_cumulative_snapshot_and_model() {
        let mut parser = StreamParser::new();
        parser.restore_session_snapshot(
            TurnUsage {
                input_tokens: 10,
                output_tokens: 10,
                cache_read_tokens: 10,
                cache_write_tokens: 10,
            },
            Some(0.5),
            Some("claude-opus-4-7".to_string()),
            None,
        );
        parser.new_session();
        assert_eq!(parser.previous_session_usage(), TurnUsage::default());
        let line = r#"{"type":"result","session_id":"s","is_error":false,"result":"","total_cost_usd":0.001,"usage":{"input_tokens":2,"output_tokens":3}}"#;
        let chunk = parse_line_str(&mut parser, line).unwrap();
        match chunk {
            StreamChunk::Result {
                turn_usage,
                turn_cost,
                ..
            } => {
                assert_eq!(turn_usage.unwrap().input_tokens, 2);
                assert_eq!(turn_cost, Some(0.001));
            }
            other => panic!("expected Result, got {other:?}"),
        }
    }

    #[test]
    fn parse_result_with_negative_cost_delta_drops_turn_cost() {
        let mut parser = StreamParser::new();
        let t1 = r#"{"type":"result","session_id":"s","is_error":false,"result":"","total_cost_usd":0.50}"#;
        parse_line_str(&mut parser, t1);
        let t2 = r#"{"type":"result","session_id":"s","is_error":false,"result":"","total_cost_usd":0.30}"#;
        let chunk = parse_line_str(&mut parser, t2).unwrap();
        match chunk {
            StreamChunk::Result { turn_cost, .. } => {
                assert!(
                    turn_cost.is_none(),
                    "negative delta should drop turn_cost, got {turn_cost:?}"
                );
            }
            other => panic!("expected Result, got {other:?}"),
        }
    }

    #[test]
    fn extract_cumulative_usage_sums_multiple_models() {
        let parsed: serde_json::Value = serde_json::from_str(
            r#"{
                "modelUsage": {
                    "claude-opus-4-7": {"inputTokens":5,"outputTokens":3,"cacheReadInputTokens":0,"cacheCreationInputTokens":0},
                    "claude-sonnet-4-6": {"inputTokens":2,"outputTokens":1,"cacheReadInputTokens":10,"cacheCreationInputTokens":0}
                }
            }"#,
        )
        .unwrap();
        let cumulative = extract_cumulative_usage(&parsed).unwrap();
        assert_eq!(cumulative.input_tokens, 7);
        assert_eq!(cumulative.output_tokens, 4);
        assert_eq!(cumulative.cache_read_tokens, 10);
        assert_eq!(cumulative.cache_write_tokens, 0);
    }

    #[test]
    fn extract_cumulative_usage_returns_none_for_absent_model_usage() {
        let parsed: serde_json::Value = serde_json::from_str(r#"{"modelUsage": {}}"#).unwrap();
        assert!(extract_cumulative_usage(&parsed).is_none());
        let parsed2: serde_json::Value = serde_json::from_str(r#"{}"#).unwrap();
        assert!(extract_cumulative_usage(&parsed2).is_none());
    }

    #[test]
    fn turn_usage_serializes_with_required_cache_fields() {
        let t = TurnUsage {
            input_tokens: 1,
            output_tokens: 2,
            cache_read_tokens: 3,
            cache_write_tokens: 4,
        };
        let json = serde_json::to_string(&t).unwrap();
        assert!(json.contains("\"input_tokens\":1"));
        assert!(json.contains("\"output_tokens\":2"));
        assert!(json.contains("\"cache_read_tokens\":3"));
        assert!(json.contains("\"cache_write_tokens\":4"));
    }

    #[test]
    fn first_turn_after_resume_seed_emits_delta_not_cumulative() {
        let mut parser = StreamParser::new();
        parser.restore_session_snapshot(
            TurnUsage {
                input_tokens: 90,
                output_tokens: 40,
                cache_read_tokens: 150,
                cache_write_tokens: 20,
            },
            Some(0.20),
            Some("claude-opus-4-7".to_string()),
            None,
        );

        let line = r#"{"type":"result","session_id":"s","is_error":false,"result":"","total_cost_usd":0.27,"modelUsage":{"claude-opus-4-7":{"inputTokens":95,"outputTokens":43,"cacheReadInputTokens":150,"cacheCreationInputTokens":20}}}"#;
        let chunk = parse_line_str(&mut parser, line).unwrap();
        match chunk {
            StreamChunk::Result {
                turn_usage,
                turn_cost,
                ..
            } => {
                let t = turn_usage.expect("turn_usage must be present");
                assert_eq!(
                    t.input_tokens, 5,
                    "input delta must be 95-90, not full cumulative"
                );
                assert_eq!(
                    t.output_tokens, 3,
                    "output delta must be 43-40, not full cumulative"
                );
                assert_eq!(t.cache_read_tokens, 0);
                assert_eq!(t.cache_write_tokens, 0);
                let cost = turn_cost.expect("turn_cost must be present");
                assert!(
                    (cost - 0.07).abs() < 1e-9,
                    "cost delta must be 0.27-0.20, got {cost}"
                );
            }
            other => panic!("expected Result, got {other:?}"),
        }
    }
}
