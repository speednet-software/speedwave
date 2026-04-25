use crate::history;
use speedwave_runtime::{config, consts, runtime};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Stdio};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

/// Events emitted to the Angular frontend via Tauri's event system.
/// The frontend listens for `"chat_stream"` events with this payload.
/// Tagged enum: serde serializes as `{"chunk_type":"Text","data":{...}}`.
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(tag = "chunk_type", content = "data")]
pub enum StreamChunk {
    /// Text content delta from the assistant.
    Text { content: String },
    /// Thinking content delta (extended thinking / interleaved thinking).
    Thinking { content: String },
    /// Tool use started — includes tool_id and tool_name.
    ToolStart { tool_id: String, tool_name: String },
    /// Partial JSON input for a tool (streamed incrementally).
    ToolInputDelta {
        tool_id: String,
        partial_json: String,
    },
    /// Tool result from a user message (tool execution output).
    ToolResult {
        tool_id: String,
        content: String,
        is_error: bool,
    },
    /// Final result — conversation turn complete.
    Result {
        session_id: String,
        /// Total session cost in USD — estimated from token counts at API pricing.
        total_cost: Option<f64>,
        usage: Option<UsageInfo>,
        #[serde(skip_serializing_if = "Option::is_none")]
        result_text: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        context_window_size: Option<u64>,
        /// UUID of the assistant message that just completed (ADR-046). Stays
        /// `None` for error turns and for local-LLM paths that omit `message.id`
        /// — the frontend degrades to "no retry target" for those entries.
        #[serde(skip_serializing_if = "Option::is_none")]
        assistant_uuid: Option<String>,
        /// Per-turn usage delta since the previous turn. When the stream carries
        /// cumulative `usage`, `turn_usage = current - previous`. When the CLI
        /// emits per-step `usage` (current behaviour), it equals `usage` with
        /// cache fields normalized to 0.
        #[serde(skip_serializing_if = "Option::is_none")]
        turn_usage: Option<TurnUsage>,
        /// Per-turn cost in USD. Computed as the delta of `total_cost_usd`
        /// between this and the previous turn when authoritative; the
        /// frontend falls back to `calculateCost()` if this is `None`.
        #[serde(skip_serializing_if = "Option::is_none")]
        turn_cost: Option<f64>,
        /// Model name for the turn when known. Populated from `modelUsage`
        /// in the `result` message or from the most recent `SystemInit`.
        #[serde(skip_serializing_if = "Option::is_none")]
        model: Option<String>,
    },
    /// Interactive question from Claude (AskUserQuestion tool).
    /// The frontend must display the question and send the answer back via `answer_question`.
    AskUserQuestion {
        tool_id: String,
        question: String,
        options: Vec<AskUserOption>,
        header: String,
        multi_select: bool,
    },
    /// Error from the Claude subprocess.
    Error { content: String },
    /// Session init metadata — model name from system init message.
    SystemInit { model: String },
    /// Rate limit event — utilization and reset info.
    RateLimit {
        status: String,
        utilization: Option<f64>,
        resets_at: Option<u64>,
    },
    /// Commits a UUID onto the most recent user entry (ADR-046). Emitted when
    /// the parser first sees `{"type":"user","message":{"id":"...",...}}` with
    /// a text-bearing user prompt (not a tool_result wrapper).
    UserMessageCommit { uuid: String },
}

/// A single option in an AskUserQuestion prompt.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct AskUserOption {
    pub label: String,
    pub value: String,
}

/// Token usage information from the result message.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct UsageInfo {
    /// Number of input tokens consumed.
    pub input_tokens: u64,
    /// Number of output tokens generated.
    pub output_tokens: u64,
    /// Number of tokens read from cache.
    pub cache_read_tokens: Option<u64>,
    /// Number of tokens written to cache.
    pub cache_write_tokens: Option<u64>,
}

/// Per-turn token usage. All cache fields are required (missing values are
/// normalized to 0), so the frontend can render without `??` guards.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct TurnUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
}

impl TurnUsage {
    /// Create a `TurnUsage` from a `UsageInfo`, normalizing missing cache
    /// fields to 0.
    pub fn from_usage_info(usage: &UsageInfo) -> Self {
        Self {
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            cache_read_tokens: usage.cache_read_tokens.unwrap_or(0),
            cache_write_tokens: usage.cache_write_tokens.unwrap_or(0),
        }
    }

    /// Per-turn delta between a cumulative snapshot and a previous snapshot.
    /// Saturating subtraction protects against reset/resume events where the
    /// current snapshot could momentarily be smaller than the previous one;
    /// in that case the turn is reported as zero tokens rather than negative.
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

/// Tool name constant for the AskUserQuestion tool.
const ASK_USER_TOOL_NAME: &str = "AskUserQuestion";

// Stream-json protocol literals — see claude-agent-sdk-python types.py
// (SDKControlRequest / SDKControlInterruptRequest).
const MSG_TYPE_CONTROL_REQUEST: &str = "control_request";
const CTRL_SUBTYPE_INTERRUPT: &str = "interrupt";

/// Parsed control_request from Claude stdout.
/// Also used as the pending request storage — keyed by `tool_use_id` in the HashMap.
#[derive(Debug, Clone)]
pub struct ControlRequest {
    pub request_id: String,
    pub tool_name: String,
    pub input: serde_json::Value,
    pub tool_use_id: String,
}

type PendingRequests = Arc<Mutex<HashMap<String, ControlRequest>>>;

/// Structured log entry returned by StreamParser for session logging.
pub struct LogEntry {
    pub prefix: &'static str,
    pub message: String,
}

/// Adapts a legacy `(Option<StreamChunk>, Option<LogEntry>)` tuple into the
/// `(Vec<StreamChunk>, Option<LogEntry>)` shape returned by `parse_line`.
fn option_to_vec(
    (chunk, log): (Option<StreamChunk>, Option<LogEntry>),
) -> (Vec<StreamChunk>, Option<LogEntry>) {
    (chunk.map(|c| vec![c]).unwrap_or_default(), log)
}

/// Stateful parser that tracks active content blocks across stream events.
/// Maintains index→(tool_id, tool_name) map built from content_block_start events.
pub struct StreamParser {
    /// Maps content block index to (tool_use_id, tool_name).
    active_blocks: HashMap<u64, (String, String)>,
    /// Accumulated input_json per tool_id (built from ToolInputDelta chunks).
    tool_input: HashMap<String, String>,
    /// Provisional assistant UUID tracked between `assistant` and `result`
    /// events (ADR-046). Committed onto the `Result` chunk; `take`n when the
    /// result arrives so a subsequent error turn cannot reuse a stale id.
    pending_assistant_uuid: Option<String>,
    /// UUIDs already emitted via `UserMessageCommit`, to guard against
    /// duplicate commits when Claude Code re-emits a user message inside the
    /// same turn (observed on retry/resume paths — the first user message
    /// echoes back). A user prompt's UUID is committed exactly once.
    committed_user_uuids: std::collections::HashSet<String>,
    /// Snapshot of cumulative session usage taken at the start of the
    /// current turn. Per-turn usage = current - previous. Kept here so
    /// that `MessageDelta` (hypothetical cumulative event) and `Result`
    /// both read the same baseline and compute a consistent delta.
    previous_session_usage: TurnUsage,
    /// Cumulative session cost in USD from the previous `Result`. Per-turn
    /// cost = current total - previous total, when both are authoritative.
    previous_session_cost: Option<f64>,
    /// Last model seen (from `SystemInit` or `modelUsage` in a result).
    last_model: Option<String>,
}

impl StreamParser {
    /// Create a new parser with empty state.
    pub fn new() -> Self {
        Self {
            active_blocks: HashMap::new(),
            tool_input: HashMap::new(),
            pending_assistant_uuid: None,
            committed_user_uuids: std::collections::HashSet::new(),
            previous_session_usage: TurnUsage::default(),
            previous_session_cost: None,
            last_model: None,
        }
    }

    /// Seeds the cumulative usage snapshot so the next `Result` subtracts
    /// against the supplied baseline. Called on resume with the snapshot
    /// computed from the existing transcript, so the first turn after a
    /// resume reports a correct delta instead of `cumulative - 0`.
    pub fn restore_session_snapshot(
        &mut self,
        usage: TurnUsage,
        total_cost: Option<f64>,
        model: Option<String>,
    ) {
        self.previous_session_usage = usage;
        self.previous_session_cost = total_cost;
        self.last_model = model;
    }

    /// Current cumulative usage snapshot. Tests use this to assert that the
    /// snapshot advances after each turn.
    #[cfg(test)]
    pub fn previous_session_usage(&self) -> TurnUsage {
        self.previous_session_usage
    }

    /// Parse a pre-parsed JSON value. Mutates internal state for block tracking.
    /// Returns (chunks for frontend in emission order, optional log entry).
    ///
    /// The Vec lets a single stream-json line produce multiple UI chunks — for
    /// example a `user` line with a text-bearing prompt AND a tool_result
    /// wrapper (rare but possible) emits both `UserMessageCommit` and
    /// `ToolResult`. Callers iterate and emit each chunk in order.
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
                (Vec::new(), None)
            }
            "system" => option_to_vec(self.parse_system_message(parsed)),
            "rate_limit_event" => option_to_vec(Self::parse_rate_limit_event(parsed)),
            _ => (Vec::new(), None),
        }
    }

    /// Capture the assistant message UUID (`message.id`) into
    /// `pending_assistant_uuid`. The UUID is committed onto the next
    /// `Result` chunk — see `parse_result`. Silently ignores missing/empty
    /// ids (local LLMs without API-style ids still produce valid turns).
    fn capture_assistant_uuid(&mut self, parsed: &serde_json::Value) {
        if let Some(id) = parsed["message"]["id"].as_str() {
            if !id.is_empty() {
                self.pending_assistant_uuid = Some(id.to_string());
            }
        }
    }

    /// Reset per-message block state (e.g. on `message_stop`).
    /// Does NOT reset the cumulative usage snapshot — that spans the whole
    /// session and is only reset by `new_session()`.
    pub fn reset(&mut self) {
        self.active_blocks.clear();
        self.tool_input.clear();
        self.pending_assistant_uuid = None;
        // committed_user_uuids is NOT reset: it persists across turns for the
        // lifetime of the session so a retry on an already-committed user
        // UUID doesn't re-emit a duplicate commit chunk.
    }

    /// Reset all state for a fresh session (no snapshot restore). Used
    /// when starting a brand-new conversation rather than resuming one.
    ///
    /// Currently used only by unit tests; a freshly constructed parser is
    /// already in this state.
    #[cfg(test)]
    pub fn new_session(&mut self) {
        self.reset();
        self.previous_session_usage = TurnUsage::default();
        self.previous_session_cost = None;
        self.last_model = None;
    }

    /// Check if a parsed JSON value is a control_request. Returns parsed data if so.
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

    /// Build AskUserQuestion chunk from a control_request's input.
    pub fn emit_ask_user_from_control_request(req: &ControlRequest) -> Option<StreamChunk> {
        let parsed = &req.input;

        // Handle wrapped format: {"questions": [{...}]}
        let q = if let Some(questions) = parsed["questions"].as_array() {
            questions.first().cloned().unwrap_or_else(|| {
                log::warn!("AskUserQuestion: 'questions' array is empty, using empty fallback");
                serde_json::Value::Object(Default::default())
            })
        } else {
            parsed.clone()
        };

        let question = q["question"].as_str().unwrap_or("").to_string();
        let header = q["header"].as_str().unwrap_or("").to_string();
        let multi_select = q["multiSelect"].as_bool().unwrap_or(false);

        let options = q["options"]
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

        Some(StreamChunk::AskUserQuestion {
            tool_id: req.tool_use_id.clone(),
            question,
            options,
            header,
            multi_select,
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
                                log::warn!(
                                    "content_block_start: tool_use block missing 'id' field"
                                );
                                return (None, None);
                            }
                        };
                        let name = match block["name"].as_str() {
                            Some(s) if !s.is_empty() => s.to_string(),
                            _ => {
                                log::warn!(
                                    "content_block_start: tool_use block missing 'name' field"
                                );
                                return (None, None);
                            }
                        };
                        let log_entry = Some(LogEntry {
                            prefix: "TOOL",
                            message: format!("start: {} ({})", name, id),
                        });
                        self.active_blocks.insert(index, (id.clone(), name.clone()));
                        // Suppress ToolStart for AskUserQuestion — it will be emitted
                        // via control_request path, not from stream events.
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
                    // "text" — text deltas will arrive via content_block_delta
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
                        // Accumulate input JSON for AskUserQuestion detection on block stop
                        self.tool_input
                            .entry(tool_id.clone())
                            .or_default()
                            .push_str(partial);
                        // Suppress ToolInputDelta for AskUserQuestion — frontend doesn't need partial JSON
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
                    // signature_delta — integrity, not rendered
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
                        // AskUserQuestion is handled via control_request protocol,
                        // not via stream events — just clean up accumulated input.
                        self.tool_input.remove(&tool_id);
                        return (None, log_entry);
                    }
                }
                (None, None)
            }

            "message_stop" => {
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

        // A user message carrying text (a user prompt, not a tool_result
        // wrapper) commits its UUID once per session. Tool-result wrappers
        // reuse the prompt's UUID or carry different ids — we only want to
        // retry-point against actual prompts.
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

        for block in blocks {
            let block_type = block["type"].as_str().unwrap_or("");
            if block_type == "tool_result" {
                let tool_use_id = match block["tool_use_id"].as_str() {
                    Some(s) if !s.is_empty() => s.to_string(),
                    _ => {
                        log::warn!("parse_user_message: tool_result block missing 'tool_use_id'");
                        return (Vec::new(), None);
                    }
                };
                let is_error = block["is_error"].as_bool().unwrap_or(false);

                // content can be a string or an array of content blocks
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

                let log_entry = Some(LogEntry {
                    prefix: "TOOL",
                    message: format!("result: {} error={}", tool_use_id, is_error),
                });

                return (
                    vec![StreamChunk::ToolResult {
                        tool_id: tool_use_id,
                        content: result_content,
                        is_error,
                    }],
                    log_entry,
                );
            }
        }
        (Vec::new(), None)
    }

    fn parse_result(
        &mut self,
        parsed: &serde_json::Value,
    ) -> (Option<StreamChunk>, Option<LogEntry>) {
        let is_error = parsed["is_error"].as_bool().unwrap_or(false);

        if is_error {
            let result_text = parsed["result"].as_str().unwrap_or("");
            if result_text.trim().is_empty() {
                // An `is_error=true` message with no `result` text is a protocol
                // anomaly observed in the wild when a local LLM provider (e.g.
                // llama.cpp/Qwen) returns a bare error response. Previously the
                // chunk was dropped silently, leaving the user with an empty
                // message bubble and no indication that anything went wrong.
                //
                // Surface a placeholder so the user sees *something*, and log
                // the full response at DEBUG so a later troubleshooting session
                // has the server payload to dig into.
                log::warn!(
                    "parse_result: is_error=true but result text is empty; \
                     returning placeholder error chunk"
                );
                log::debug!("parse_result: empty-error payload: {parsed}");
                return (
                    Some(StreamChunk::Error {
                        content: "The LLM returned an error without details. \
                             Check the provider server logs or try a different model."
                            .to_string(),
                    }),
                    None,
                );
            }
            return (
                Some(StreamChunk::Error {
                    content: result_text.to_string(),
                }),
                None,
            );
        }

        let session_id = parsed["session_id"].as_str().unwrap_or("").to_string();
        if session_id.is_empty() {
            log::warn!("parse_result: result message missing 'session_id'");
        }

        // Cost: prefer total_cost_usd (real CLI), fall back to total_cost (legacy)
        let total_cost = parsed["total_cost_usd"]
            .as_f64()
            .or_else(|| parsed["total_cost"].as_f64());

        // modelUsage: cumulative per-model stats from the CLI. Used for
        // contextWindow (constant per model) and for model identification.
        let model_usage = parsed["modelUsage"].as_object();
        let context_window_size = model_usage
            .and_then(|mu| mu.values().next())
            .and_then(|stats| stats["contextWindow"].as_u64());

        // Pick the first model key from modelUsage if present; otherwise fall
        // back to the most recent SystemInit model captured in state.
        let model = model_usage
            .and_then(|mu| mu.keys().next().cloned())
            .or_else(|| self.last_model.clone());
        // Keep parser state in sync so future turns without modelUsage still
        // know the model.
        if let Some(m) = model.as_deref() {
            self.last_model = Some(m.to_string());
        }

        let usage = if parsed["usage"].is_object() {
            let u = &parsed["usage"];
            Some(UsageInfo {
                input_tokens: u["input_tokens"].as_u64().unwrap_or(0),
                output_tokens: u["output_tokens"].as_u64().unwrap_or(0),
                cache_read_tokens: u["cache_read_input_tokens"]
                    .as_u64()
                    .or_else(|| u["cache_read_tokens"].as_u64()),
                cache_write_tokens: u["cache_creation_input_tokens"]
                    .as_u64()
                    .or_else(|| u["cache_write_tokens"].as_u64()),
            })
        } else {
            None
        };

        // Per-turn usage: see `compute_turn_usage_from_result`.
        let turn_usage = compute_turn_usage_from_result(
            parsed,
            usage.as_ref(),
            &mut self.previous_session_usage,
        );

        // Per-turn cost. Use the authoritative delta of `total_cost_usd`
        // when available (CLI aggregates across the session; our previous
        // snapshot is the previous turn's cumulative total). For the first
        // turn in a session without a prior snapshot, `total_cost` itself
        // IS the first turn's cost.
        let turn_cost = match (total_cost, self.previous_session_cost) {
            (Some(current), Some(prev)) if current >= prev => Some(current - prev),
            (Some(current), None) => Some(current),
            _ => None,
        };
        // Update the cumulative cost snapshot for the next turn.
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

        let assistant_uuid = self.pending_assistant_uuid.take();

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
            }),
            log_entry,
        )
    }

    /// Parse a rate_limit_event from Claude Code.
    /// Extracts status, utilization percentage, and reset timestamp.
    fn parse_rate_limit_event(
        parsed: &serde_json::Value,
    ) -> (Option<StreamChunk>, Option<LogEntry>) {
        let info = &parsed["rate_limit_info"];
        let status = info["status"].as_str().unwrap_or("unknown").to_string();
        let utilization = info["utilization"].as_f64();
        let resets_at = info["resets_at"].as_u64();

        let log_entry = Some(LogEntry {
            prefix: "RATE_LIMIT",
            message: format!(
                "status={status} utilization={} resets_at={}",
                utilization.map_or("none".to_string(), |v| format!("{v:.1}")),
                resets_at.map_or("none".to_string(), |v| v.to_string()),
            ),
        });

        (
            Some(StreamChunk::RateLimit {
                status,
                utilization,
                resets_at,
            }),
            log_entry,
        )
    }

    /// Patterns that indicate a system message should be surfaced to the
    /// user as an error (rate limits, billing, context limits).
    const ACTIONABLE_PATTERNS: &'static [&'static str] = &[
        "hit your limit",
        "rate limit",
        "quota exceeded",
        "context length",
        "maximum length",
        "billing",
        "Error:",
    ];

    /// Parse system messages from Claude Code.
    /// Surfaces rate-limit and other actionable system messages as errors
    /// so the frontend can display them.
    fn parse_system_message(
        &mut self,
        parsed: &serde_json::Value,
    ) -> (Option<StreamChunk>, Option<LogEntry>) {
        // ── Extract model from system init message ──
        // Must be checked BEFORE the message.is_empty() early return below,
        // because init messages may not carry a `message`/`content` field.
        if parsed["subtype"].as_str() == Some("init") {
            if let Some(model) = parsed["model"].as_str() {
                if !model.is_empty() {
                    // Cache the model so subsequent result chunks can label
                    // their meta line even when `modelUsage` is absent.
                    self.last_model = Some(model.to_string());
                    let log_entry = Some(LogEntry {
                        prefix: "SYSTEM",
                        message: format!("init: model={model}"),
                    });
                    return (
                        Some(StreamChunk::SystemInit {
                            model: model.to_string(),
                        }),
                        log_entry,
                    );
                }
            }
            // subtype is "init" but model is missing/empty — fall through to
            // existing text-based logic (which will likely return (None, None)
            // since init messages typically have no `message` field).
        }

        // System messages carry text in either `message` or `content`
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
                }),
                log_entry,
            )
        } else {
            // Log but don't surface non-actionable system messages
            (None, log_entry)
        }
    }
}

/// Extract per-turn usage from a parsed `result` message, updating the
/// cumulative snapshot in place.
///
/// Two sources are possible:
///
///  * Flat `usage` (Claude Code CLI today) — already per-step, so the value
///    is emitted as the turn and the snapshot accumulates it.
///  * `modelUsage` only (cumulative per-model, no flat `usage`) — compute
///    `turn = cumulative - snapshot` and advance the snapshot.
///
/// The flat-path snapshot value is kept in sync so that future switches
/// between the two payload shapes remain consistent. Returns `None` when
/// the result carries no usage information at all.
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
    // Fallback path: only `modelUsage` is present. Compute the delta against
    // the cumulative snapshot. After a resume, callers should restore the
    // snapshot via `restore_session_snapshot` before the first Result; if
    // not, the first delta equals the full cumulative total (best-effort).
    let cumulative = extract_cumulative_usage(parsed)?;
    let delta = TurnUsage::delta(&cumulative, snapshot);
    *snapshot = cumulative;
    Some(delta)
}

/// Sum `modelUsage` across all models to a single cumulative snapshot.
/// Returns `None` when the payload has no `modelUsage` object or its
/// values are missing usage fields.
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

/// Build the JSON value for a user message in Claude's stream-json input format.
pub fn build_user_message(message: &str) -> serde_json::Value {
    serde_json::json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": [{"type": "text", "text": message}]
        }
    })
}

/// Auto-approve response for non-AskUserQuestion tools.
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

/// AskUserQuestion response with user's answer injected into input.
fn build_ask_user_response(request: &ControlRequest, selected_label: &str) -> serde_json::Value {
    let mut updated_input = request.input.clone();

    // Inject answers into the appropriate format
    if let Some(questions) = updated_input["questions"].as_array() {
        // Wrapped format: {"questions":[{...}]}
        let question_text = questions
            .first()
            .and_then(|q| q["question"].as_str())
            .unwrap_or("");
        let mut answers = serde_json::Map::new();
        answers.insert(
            question_text.to_string(),
            serde_json::Value::String(selected_label.to_string()),
        );
        updated_input["answers"] = serde_json::Value::Object(answers);
    } else {
        // Flat format: {"question":"...", ...}
        let question_text = updated_input["question"].as_str().unwrap_or("").to_string();
        let mut answers = serde_json::Map::new();
        answers.insert(
            question_text,
            serde_json::Value::String(selected_label.to_string()),
        );
        updated_input["answers"] = serde_json::Value::Object(answers);
    }

    serde_json::json!({
        "type": "control_response",
        "response": {
            "subtype": "success",
            "request_id": request.request_id,
            "response": {
                "behavior": "allow",
                "updatedInput": updated_input
            }
        }
    })
}

/// Validate a message UUID passed to `--resume-session-at`.
///
/// Claude Code's message ids take two shapes in the wild: Anthropic-API
/// `msg_...` ids (alphanumeric with underscores) and UUID v4 strings.  Rather
/// than enumerate both, we accept any bounded string whose characters are
/// safe to pass as a CLI argument — no shell metacharacters, no whitespace,
/// no path traversal. Empty strings are rejected so the caller can treat
/// "no known retry target" as a distinct error condition.
pub fn validate_retry_uuid(uuid: &str) -> anyhow::Result<()> {
    if uuid.is_empty() {
        anyhow::bail!("retry uuid must not be empty");
    }
    if uuid.len() > 128 {
        anyhow::bail!("retry uuid too long (max 128 chars)");
    }
    // Allow [A-Za-z0-9_-] only — the two observed formats (API `msg_...`
    // and UUID v4) fit within this set and it disallows shell injection.
    for ch in uuid.chars() {
        if !(ch.is_ascii_alphanumeric() || ch == '_' || ch == '-') {
            anyhow::bail!("retry uuid contains invalid character: {ch:?}");
        }
    }
    Ok(())
}

/// Build the argument list for Claude Code's stream-json mode.
///
/// When `resume_session_id` is `Some`, adds `--resume <id>` to resume an
/// existing conversation. When `resume_at_uuid` is `Some`, additionally
/// rewinds the conversation to that user-message UUID (ADR-046) — Claude
/// Code's native retry flag.
pub fn build_claude_args(
    resume_session_id: Option<&str>,
    resume_at_uuid: Option<&str>,
    flags: &[String],
) -> Vec<String> {
    let mut args = vec![
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
    ];

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

/// Build the container name for a project's Claude container.
pub fn claude_container_name(project: &str) -> String {
    format!("{}_{}_claude", consts::compose_prefix(), project)
}

/// Build the stream-json `control_request` payload for an interrupt.
fn build_interrupt_payload(request_id: &str) -> serde_json::Value {
    serde_json::json!({
        "type": MSG_TYPE_CONTROL_REQUEST,
        "request_id": request_id,
        "request": { "subtype": CTRL_SUBTYPE_INTERRUPT },
    })
}

/// Monotonic interrupt request_id (Claude requires uniqueness; we never
/// correlate the response, so a counter is enough — no UUID dependency).
fn next_interrupt_request_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    format!("req_interrupt_{}", COUNTER.fetch_add(1, Ordering::Relaxed))
}

/// Write a control_request payload + flush. Extracted so tests can assert
/// the exact bytes against an in-memory writer.
fn write_interrupt<W: Write>(w: &mut W, payload: &serde_json::Value) -> anyhow::Result<()> {
    writeln!(w, "{}", payload)?;
    w.flush()?;
    Ok(())
}

/// Manages a Claude Code subprocess running inside the container.
/// Claude is launched via `container_exec` from the ContainerRuntime trait,
/// which abstracts limactl/nerdctl/wsl.exe differences.
///
/// Stdout is parsed in a background thread that emits Tauri events directly.
pub struct ChatSession {
    child: Option<Child>,
    project_name: String,
    shared_stdin: Option<Arc<Mutex<std::process::ChildStdin>>>,
    pending_requests: PendingRequests,
    drain_handles: Vec<std::thread::JoinHandle<()>>,
    /// Set to `Some` only after a successful spawn — guards `stop()` log entry.
    session_log_path: Option<std::path::PathBuf>,
}

impl ChatSession {
    /// Create a new session for the given project.
    pub fn new(project_name: &str) -> Self {
        Self {
            child: None,
            project_name: project_name.to_string(),
            shared_stdin: None,
            pending_requests: Arc::new(Mutex::new(HashMap::new())),
            drain_handles: Vec::new(),
            session_log_path: None,
        }
    }

    /// Read-only accessor for the owning project name — required by the
    /// retry command so it can re-construct an empty `ChatSession` after
    /// stopping the old one.
    pub fn project_name(&self) -> &str {
        &self.project_name
    }

    /// Build the argv + container name for a Claude Code spawn.
    ///
    /// - `resume_session_id` adds `--resume <id>` (required for retry).
    /// - `resume_at_uuid` adds `--resume-session-at <uuid>` (ADR-046 retry
    ///   anchor). When both are `Some`, the spawn rewinds the session to the
    ///   given user-message UUID and regenerates the assistant turn natively.
    pub fn prepare_args(
        project_name: &str,
        user_config: &config::SpeedwaveUserConfig,
        resume_session_id: Option<&str>,
        resume_at_uuid: Option<&str>,
    ) -> anyhow::Result<(Vec<String>, String)> {
        if let Some(id) = resume_session_id {
            history::validate_session_id(id)?;
        }
        if let Some(uuid) = resume_at_uuid {
            validate_retry_uuid(uuid)?;
        }

        let project_dir = std::path::PathBuf::from(&user_config.require_project(project_name)?.dir);

        let resolved = config::resolve_claude_config(&project_dir, user_config, project_name);

        let args = build_claude_args(resume_session_id, resume_at_uuid, &resolved.flags);
        let container = claude_container_name(project_name);

        Ok((args, container))
    }

    /// Start Claude Code in stream-json mode inside the container.
    /// Spawns a background thread that reads stdout and emits `chat_stream`
    /// Tauri events for the Angular frontend.
    ///
    /// When `resume_session_id` is `Some`, resumes an existing conversation.
    ///
    /// **Precondition:** The caller must have already verified container
    /// health (e.g. via `check_claude_auth`, which calls
    /// `ensure_exec_healthy` internally).  This method does NOT run
    /// `ensure_exec_healthy` itself to avoid double health-checks.
    pub fn start(
        &mut self,
        app_handle: AppHandle,
        resume_session_id: Option<&str>,
    ) -> anyhow::Result<()> {
        self.start_with_retry(app_handle, resume_session_id, None)
    }

    /// Start (or resume+retry) a Claude Code session.
    ///
    /// When `resume_at_uuid` is `Some`, Claude Code rewinds the session to
    /// the given user-message UUID and regenerates the assistant turn
    /// natively (ADR-046). The caller MUST also pass `resume_session_id`;
    /// retry without a session is nonsensical.
    pub fn start_with_retry(
        &mut self,
        app_handle: AppHandle,
        resume_session_id: Option<&str>,
        resume_at_uuid: Option<&str>,
    ) -> anyhow::Result<()> {
        let rt = runtime::detect_runtime();
        let user_config = config::load_user_config()?;

        let (args, container) = Self::prepare_args(
            &self.project_name,
            &user_config,
            resume_session_id,
            resume_at_uuid,
        )?;

        let mut cmd = rt.container_exec_piped(
            &container,
            &args.iter().map(|s| s.as_str()).collect::<Vec<_>>(),
        )?;

        let mut child = cmd
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;

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

        // Best-effort session log init — errors here do NOT kill the session
        let session_log_path = {
            let path = consts::claude_session_log_path(&self.project_name);
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            crate::log_file::truncate_if_oversized(&path, 2 * 1024 * 1024);
            let mut f = crate::log_file::open_log_file(&path);
            crate::log_file::write_log_line(&mut f, "SESSION", "started");
            Some(path)
        };
        self.session_log_path = session_log_path.clone();

        // Spawn stderr reader to log errors (avoids pipe buffer deadlock).
        // Each reader thread opens its own O_APPEND handle to the session log.
        // POSIX guarantees atomic writes below PIPE_BUF (4 KB); our lines are
        // ~100 bytes, so interleaving cannot corrupt individual entries.
        let stderr_log_path = session_log_path.clone();
        if let Some(stderr) = child.stderr.take() {
            let h = std::thread::spawn(move || {
                let mut log_file = stderr_log_path
                    .as_deref()
                    .and_then(crate::log_file::open_log_file);
                let reader = BufReader::new(stderr);
                for line in reader.lines() {
                    match line {
                        Ok(l) => {
                            log::debug!("{l}");
                            crate::log_file::write_log_line(&mut log_file, "STDERR", &l);
                        }
                        Err(e) => {
                            log::warn!("stderr reader: I/O error: {e}");
                            break;
                        }
                    }
                }
            });
            self.drain_handles.push(h);
        }

        let pending_requests = self.pending_requests.clone();
        let stdin_for_reader = shared_stdin;
        let stdout_log_path = session_log_path;

        // On resume: recover the cumulative session state from the existing
        // transcript so the first turn after resume reports a real per-turn
        // delta. Without this seed the parser would compare the next
        // cumulative snapshot against zero and emit the entire session
        // total as a single turn. Failures here are non-fatal — we log and
        // proceed with a zero baseline (matches pre-resume-seed behaviour).
        let resume_seed = resume_session_id.and_then(|id| {
            match history::compute_resume_snapshot(&self.project_name, id) {
                Ok(s) => Some(s),
                Err(e) => {
                    log::warn!("resume snapshot for session {id} unavailable: {e}");
                    None
                }
            }
        });

        // Background thread: parse Claude's stream-json and emit Tauri events
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
                );
            }
            let mut log_file = stdout_log_path
                .as_deref()
                .and_then(crate::log_file::open_log_file);
            let reader = BufReader::new(stdout);
            let mut got_result = false;
            for line in reader.lines() {
                let line = match line {
                    Ok(l) => l,
                    Err(e) => {
                        log::warn!("stdout reader: I/O error: {e}");
                        break;
                    }
                };

                // Parse JSON once — pass the Value to both control_request and stream parsers
                let parsed = match serde_json::from_str::<serde_json::Value>(&line) {
                    Ok(v) => v,
                    Err(_) => {
                        crate::log_file::write_log_line(
                            &mut log_file,
                            "STDOUT",
                            "[non-json stdout suppressed]",
                        );
                        continue;
                    }
                };

                let msg_type = parsed["type"].as_str().unwrap_or("");

                // 1. Check for control_request
                if let Some(ctrl) = StreamParser::try_parse_control_request(&parsed) {
                    crate::log_file::write_log_line(
                        &mut log_file,
                        "CONTROL",
                        &format!("request: {} ({})", ctrl.tool_name, ctrl.tool_use_id),
                    );
                    if ctrl.tool_name == ASK_USER_TOOL_NAME {
                        // Store pending request and emit to frontend
                        match pending_requests.lock() {
                            Ok(mut map) => {
                                map.insert(ctrl.tool_use_id.clone(), ctrl.clone());
                            }
                            Err(e) => {
                                log::error!(
                                    "pending_requests mutex poisoned: {e}; dropping stream"
                                );
                                let _ = app_handle.emit(
                                    "chat_stream",
                                    StreamChunk::Error {
                                        content: "Internal error: pending_requests lock poisoned"
                                            .to_string(),
                                    },
                                );
                                break;
                            }
                        }
                        if let Some(chunk) = StreamParser::emit_ask_user_from_control_request(&ctrl)
                        {
                            if let Err(e) = app_handle.emit("chat_stream", chunk) {
                                log::warn!("failed to emit AskUserQuestion event: {e}");
                            }
                        }
                    } else {
                        // Auto-approve non-AskUserQuestion tools
                        let response = build_auto_approve_response(&ctrl);
                        match stdin_for_reader.lock() {
                            Ok(mut stdin) => {
                                if let Err(e) = writeln!(stdin, "{}", response) {
                                    log::error!(
                                        "auto-approve stdin write failed: {e}; dropping stream"
                                    );
                                    let _ = app_handle.emit(
                                        "chat_stream",
                                        StreamChunk::Error {
                                            content: format!(
                                                "Failed to write auto-approve to stdin: {e}"
                                            ),
                                        },
                                    );
                                    break;
                                }
                                if let Err(e) = stdin.flush() {
                                    log::error!(
                                        "auto-approve stdin flush failed: {e}; dropping stream"
                                    );
                                    let _ = app_handle.emit(
                                        "chat_stream",
                                        StreamChunk::Error {
                                            content: format!(
                                                "Failed to flush auto-approve to stdin: {e}"
                                            ),
                                        },
                                    );
                                    break;
                                }
                            }
                            Err(e) => {
                                log::error!("stdin mutex poisoned: {e}; dropping stream");
                                let _ = app_handle.emit(
                                    "chat_stream",
                                    StreamChunk::Error {
                                        content: "Internal error: stdin lock poisoned".to_string(),
                                    },
                                );
                                break;
                            }
                        }
                    }
                    continue;
                }

                // 2. Normal stream events
                let (chunks, log_entry) = parser.parse_line(&parsed);
                if let Some(entry) = log_entry {
                    crate::log_file::write_log_line(&mut log_file, entry.prefix, &entry.message);
                }
                // Track whether we received a terminal event so we can
                // emit a fallback error on unexpected EOF.  Covers:
                // - StreamChunk::Result / Error from normal turns
                // - system messages (including non-actionable ones that
                //   return no chunk but still indicate normal lifecycle)
                let is_terminal = chunks
                    .iter()
                    .any(|c| matches!(c, StreamChunk::Result { .. } | StreamChunk::Error { .. }));
                if is_terminal || msg_type == "system" {
                    got_result = true;
                    // Clear StreamParser per-turn state. message_stop also
                    // triggers reset inside parse_line, but an interrupted
                    // turn may emit Result without a preceding message_stop,
                    // leaving active_blocks entries that could misroute
                    // ToolInputDelta events in the next turn.
                    parser.reset();
                }
                for chunk in chunks {
                    if let Err(e) = app_handle.emit("chat_stream", chunk) {
                        log::warn!("failed to emit chat_stream event: {e}");
                    }
                }
            }

            // If the stdout pipe closed without a proper result/error,
            // emit an error so the frontend doesn't hang with isStreaming=true.
            if !got_result {
                log::warn!("stdout reader: stream ended without result");
                let _ = app_handle.emit(
                    "chat_stream",
                    StreamChunk::Error {
                        content:
                            "Claude session ended unexpectedly. Check the session log for details."
                                .to_string(),
                    },
                );
            }
        });
        self.drain_handles.push(h);

        self.child = Some(child);
        Ok(())
    }

    /// Send a user message to Claude (write JSON to stdin).
    /// Uses the stream-json input format: `{"type":"user","message":{"role":"user","content":[...]}}`.
    ///
    /// Returns an error if the subprocess has exited (broken pipe).
    /// The caller should restart the session and retry.
    pub fn send_message(&mut self, message: &str) -> anyhow::Result<()> {
        let child = self
            .child
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("no active session"))?;

        // Check if process is still alive
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
        let input = build_user_message(message);
        let mut stdin = shared
            .lock()
            .map_err(|e| anyhow::anyhow!("stdin lock poisoned: {e}"))?;
        writeln!(stdin, "{}", input)?;
        stdin.flush()?;
        Ok(())
    }

    /// Send a control_response for an AskUserQuestion prompt.
    /// Looks up the pending request by `tool_use_id`, builds a control_response
    /// with the user's answer, and writes it to Claude's stdin.
    pub fn answer_question(&mut self, tool_use_id: &str, answer: &str) -> anyhow::Result<()> {
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

        let pending = self
            .pending_requests
            .lock()
            .map_err(|e| anyhow::anyhow!("pending_requests lock poisoned: {e}"))?
            .remove(tool_use_id)
            .ok_or_else(|| {
                anyhow::anyhow!("no pending control request for tool_use_id: {tool_use_id}")
            })?;

        let response = build_ask_user_response(&pending, answer);

        let shared = self
            .shared_stdin
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("no active session"))?;
        let mut stdin = shared
            .lock()
            .map_err(|e| anyhow::anyhow!("stdin lock poisoned: {e}"))?;

        if let Err(e) = writeln!(stdin, "{}", response).and_then(|_| stdin.flush()) {
            log::error!(
                "failed to write answer for {} (tool_use_id={tool_use_id}): {e}",
                pending.tool_name
            );
            // Restore the pending request so the user can retry
            match self.pending_requests.lock() {
                Ok(mut map) => {
                    map.insert(tool_use_id.to_string(), pending);
                }
                Err(poison_err) => {
                    log::error!("failed to restore pending request: mutex poisoned: {poison_err}");
                }
            }
            return Err(anyhow::anyhow!("failed to write answer to stdin: {e}"));
        }

        Ok(())
    }

    /// Cancel the current turn without killing the session.
    ///
    /// Writes a stream-json `control_request` with `subtype: "interrupt"` to
    /// Claude's stdin (protocol: `SDKControlInterruptRequest` in
    /// https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/types.py).
    /// Claude aborts the in-flight turn, emits a `result` with
    /// `subtype: "error_during_execution"`, and stays ready for the next user
    /// message on the same stdin — session, context, MCP hub, and history
    /// preserved.
    pub fn interrupt(&mut self) -> anyhow::Result<()> {
        // Mirror send_message/answer_question: detect a child that has already
        // exited so we surface a clean "session exited" (or OOM) error instead
        // of a confusing broken-pipe write failure.
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
            log::error!(
                "interrupt: failed to write control_request (request_id={request_id}): {e}"
            );
            return Err(e);
        }
        log::info!("interrupt: control_request sent (request_id={request_id})");
        Ok(())
    }

    /// Stop the Claude subprocess entirely (session end, not turn cancel).
    pub fn stop(&mut self) -> anyhow::Result<()> {
        // Drop stdin first to signal EOF to the child
        self.shared_stdin = None;
        if let Some(mut child) = self.child.take() {
            child.kill().ok();
            // Wait with timeout — nerdctl exec can be slow to die.
            // If it doesn't exit in 5 seconds, abandon it (OS will reap).
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            loop {
                match child.try_wait() {
                    Ok(Some(_)) => break,
                    Ok(None) => {
                        if std::time::Instant::now() >= deadline {
                            log::warn!("stop: child did not exit within 5s, abandoning");
                            break;
                        }
                        std::thread::sleep(std::time::Duration::from_millis(50));
                    }
                    Err(e) => {
                        log::warn!("stop: try_wait error (treating as exited): {e}");
                        break;
                    }
                }
            }
        }
        // Join already-finished reader threads; detach any still running.
        // Pipes may still be open if the child didn't exit in time.
        //
        // When the child exits cleanly (the common case, including the
        // 5 s wait above), the kernel closes its pipe ends immediately,
        // which unblocks the reader's `read_line` with EOF — but the Rust
        // thread still needs a short moment to propagate that through
        // `BufReader::lines()` -> loop exit -> the `is_finished` flag. A
        // naive `is_finished()` check right after `kill()` therefore
        // produces noisy "still running, detaching" warnings even on the
        // happy path. Give the readers a brief grace window (polled at
        // 10 ms) so the flag has time to flip before we classify them.
        //
        // The deadline is shared across ALL reader handles, not per-handle —
        // stdout and stderr from the same child both receive EOF at the same
        // instant (when the child exits), so one shared window covers them.
        // If the first handle is genuinely stuck and burns the full window,
        // the second handle still gets at least one poll before classification.
        // The window only adds latency when a reader is actually stuck (then
        // we wait up to READER_GRACE_MS total and give up); in the common
        // case each handle is finished on the very first poll.
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
                // Pipe is genuinely wedged — typically because an upstream
                // in the SSH -> nerdctl chain didn't close its end. Detach
                // so `stop()` still returns to the caller in a bounded time.
                log::warn!(
                    "stop: reader thread {name} still running after {READER_GRACE_MS}ms grace, detaching"
                );
                continue;
            }
            if let Err(e) = handle.join() {
                log::warn!("stop: reader thread panicked: {e:?}");
            }
        }
        // Log session end ONLY if session actually started
        if let Some(ref log_path) = self.session_log_path {
            let mut f = crate::log_file::open_log_file(log_path);
            crate::log_file::write_log_line(&mut f, "SESSION", "stopped");
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

/// Thread-safe wrapper for ChatSession, to be used from Tauri commands.
pub type SharedChatSession = Arc<Mutex<ChatSession>>;

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    // -- interrupt protocol tests (behavioural via free helpers) --

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
    fn build_interrupt_payload_matches_sdk_protocol() {
        // Wire format per SDKControlInterruptRequest in claude-agent-sdk-python.
        let v = build_interrupt_payload("req_interrupt_42");
        assert_eq!(v["type"], "control_request");
        assert_eq!(v["request_id"], "req_interrupt_42");
        assert_eq!(v["request"]["subtype"], "interrupt");
        // Defensive: no extra top-level keys leak in.
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
        // Exactly one trailing newline (NDJSON framing) and one parse-able value.
        assert!(s.ends_with('\n'), "must end with newline, got: {s:?}");
        let line = s.trim_end_matches('\n');
        assert!(!line.contains('\n'), "must be single line, got: {s:?}");
        let parsed: serde_json::Value = serde_json::from_str(line).expect("valid json");
        assert_eq!(parsed["request"]["subtype"], "interrupt");
    }

    #[test]
    fn write_interrupt_propagates_io_errors() {
        // Writer that always fails on first write — verifies the error path
        // (the production code logs and returns this error to the caller).
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

    // -- ChatSession::stop() tests --

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
        // Regression: `stop()` used to check `handle.is_finished()` the
        // instant after `child.kill()` + `wait`, which races the reader
        // thread's EOF propagation through BufReader::lines(). The flag
        // would often read `false` for a reader that was about to exit
        // cleanly anyway, producing noisy "still running, detaching"
        // warnings even on the happy path.
        //
        // Simulate a reader that finishes after ~50ms (well below the
        // 200ms grace window). `stop()` must join it instead of
        // classifying it as "still running".
        let mut s = ChatSession::new("test-project");
        s.drain_handles.push(std::thread::spawn(|| {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }));
        let start = std::time::Instant::now();
        assert!(s.stop().is_ok());
        let elapsed = start.elapsed();
        assert!(s.drain_handles.is_empty(), "handle must be drained");
        // Upper bound: grace window is 200ms; joining a 50ms thread must
        // finish well inside it. The generous ceiling absorbs CI jitter.
        assert!(
            elapsed < std::time::Duration::from_millis(500),
            "stop() took {elapsed:?} — grace window should have joined the reader well under 500ms"
        );
    }

    #[test]
    fn stop_grace_period_gives_up_on_genuinely_stuck_reader() {
        // When a reader is truly wedged (pipe upstream didn't close), the
        // grace window must still be bounded so `stop()` returns to the
        // caller in a predictable time. We simulate a stuck reader by
        // spawning a thread that sleeps longer than the grace window.
        let mut s = ChatSession::new("test-project");
        s.drain_handles.push(std::thread::spawn(|| {
            std::thread::sleep(std::time::Duration::from_secs(10));
        }));
        let start = std::time::Instant::now();
        assert!(s.stop().is_ok());
        let elapsed = start.elapsed();
        assert!(s.drain_handles.is_empty(), "handle must be drained");
        // Upper bound: the grace window is 200ms total (shared across all
        // handles, not per-handle) — stop() must detach the stuck reader
        // within that window and return. 1000ms leaves plenty of room for
        // CI jitter while still catching a regression to an unbounded join.
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
            ControlRequest {
                request_id: "r1".to_string(),
                tool_name: ASK_USER_TOOL_NAME.to_string(),
                input: serde_json::json!({}),
                tool_use_id: "tool-1".to_string(),
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

    /// Convenience: parse a JSON string and call `parser.parse_line`.
    /// Returns the first StreamChunk (for backward-compatible test assertions
    /// against single-chunk emissions).
    fn parse_line_str(parser: &mut StreamParser, line: &str) -> Option<StreamChunk> {
        let parsed: serde_json::Value = serde_json::from_str(line).ok()?;
        parser.parse_line(&parsed).0.into_iter().next()
    }

    /// Convenience: parse a JSON string and return all emitted chunks.
    fn parse_line_all_str(parser: &mut StreamParser, line: &str) -> Vec<StreamChunk> {
        let parsed: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => return Vec::new(),
        };
        parser.parse_line(&parsed).0
    }

    /// Convenience: parse a JSON string and call `parser.parse_line`.
    /// Returns the full tuple (first chunk, log_entry) for log entry assertions.
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

    /// Convenience: parse a JSON string and call `StreamParser::try_parse_control_request`.
    fn try_parse_control_request_str(line: &str) -> Option<ControlRequest> {
        let parsed: serde_json::Value = serde_json::from_str(line).ok()?;
        StreamParser::try_parse_control_request(&parsed)
    }

    // ── StreamChunk serialization ────────────────────────────────────

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
            usage: Some(UsageInfo {
                input_tokens: 100,
                output_tokens: 50,
                cache_read_tokens: Some(10),
                cache_write_tokens: None,
            }),
            result_text: None,
            context_window_size: None,
            assistant_uuid: Some("msg_test".to_string()),
            turn_usage: None,
            turn_cost: None,
            model: None,
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

    // ── send_message JSON format ─────────────────────────────────────

    #[test]
    fn build_user_message_produces_correct_json_structure() {
        let msg = build_user_message("test msg");

        assert_eq!(msg["type"], "user");
        assert_eq!(msg["message"]["role"], "user");

        let content = &msg["message"]["content"];
        assert!(content.is_array());

        let items = content.as_array().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["type"], "text");
        assert_eq!(items[0]["text"], "test msg");
    }

    #[test]
    fn build_user_message_preserves_special_characters() {
        let msg = build_user_message("hello \"world\" \n\ttab");
        let text = msg["message"]["content"][0]["text"].as_str().unwrap();
        assert_eq!(text, "hello \"world\" \n\ttab");
    }

    // ── StreamParser: text delta ─────────────────────────────────────

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

    // ── StreamParser: thinking delta ─────────────────────────────────

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

    // ── StreamParser: tool_use with input_json_delta ──────────────────

    #[test]
    fn parse_tool_use_with_input_json_delta_correlates_by_index() {
        let mut parser = StreamParser::new();

        // content_block_start: tool_use at index 1
        let start = r#"{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_01ABC","name":"Read","input":{}}}}"#;
        let chunk = parse_line_str(&mut parser, start).unwrap();
        match &chunk {
            StreamChunk::ToolStart { tool_id, tool_name } => {
                assert_eq!(tool_id, "toolu_01ABC");
                assert_eq!(tool_name, "Read");
            }
            other => panic!("expected ToolStart, got {other:?}"),
        }

        // content_block_delta: input_json_delta at index 1
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

    // ── StreamParser: content_block_stop cleans up ────────────────────

    #[test]
    fn parse_content_block_stop_cleans_up_active_blocks() {
        let mut parser = StreamParser::new();

        // Start a tool at index 2
        let start = r#"{"type":"stream_event","event":{"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_X","name":"Bash","input":{}}}}"#;
        parse_line_str(&mut parser, start);

        // Stop at index 2 — should clean up
        let stop = r#"{"type":"stream_event","event":{"type":"content_block_stop","index":2}}"#;
        parse_line_str(&mut parser, stop);

        // Now a delta at index 2 should return None (cleaned up)
        let delta = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{}"}}}"#;
        assert!(parse_line_str(&mut parser, delta).is_none());
    }

    // ── StreamParser: message_stop resets state ───────────────────────

    #[test]
    fn parse_message_stop_resets_parser_state() {
        let mut parser = StreamParser::new();

        // Start a tool
        let start = r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_Y","name":"Edit","input":{}}}}"#;
        parse_line_str(&mut parser, start);

        // message_stop should reset
        let stop = r#"{"type":"stream_event","event":{"type":"message_stop"}}"#;
        parse_line_str(&mut parser, stop);

        assert!(parser.active_blocks.is_empty());
    }

    /// Regression test for the interrupt path: an interrupted turn can emit
    /// `result` without a preceding `message_stop`, so the stdout-reader
    /// calls `parser.reset()` after every terminal chunk. Without that
    /// reset, stale `active_blocks` entries would misroute
    /// `ToolInputDelta` events in the next turn when Claude reuses the
    /// same content-block index for a different tool.
    #[test]
    fn reset_after_result_prevents_stale_tool_contamination() {
        let mut parser = StreamParser::new();

        // Turn 1: a tool starts at index 0 and receives a partial input delta.
        let start = r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_OLD","name":"Read","input":{}}}}"#;
        parse_line_str(&mut parser, start);
        assert!(parser.active_blocks.contains_key(&0));

        // Interrupt emits a `result` directly — no preceding `message_stop`.
        // The stdout-reader loop calls `parser.reset()` after this chunk, so
        // simulate that here (parse_line alone does not reset on `result`).
        let result = r#"{"type":"result","subtype":"error_during_execution","session_id":"s","total_cost_usd":0.0,"usage":{}}"#;
        parse_line_str(&mut parser, result);
        parser.reset();

        assert!(parser.active_blocks.is_empty());
        assert!(parser.tool_input.is_empty());

        // Turn 2: Claude reuses index 0 for a different tool. Without the
        // reset above, an input delta at index 0 would still route to the
        // OLD tool_id; after reset the new tool_id takes over cleanly.
        let start2 = r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_NEW","name":"Edit","input":{}}}}"#;
        parse_line_str(&mut parser, start2);
        let delta = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"file\":\"x\"}"}}}"#;
        let chunk = parse_line_str(&mut parser, delta).expect("expected ToolInputDelta");
        match chunk {
            StreamChunk::ToolInputDelta { tool_id, .. } => assert_eq!(tool_id, "toolu_NEW"),
            other => panic!("expected ToolInputDelta for toolu_NEW, got {other:?}"),
        }
    }

    // ── StreamParser: user tool_result ────────────────────────────────

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

    // ── StreamParser: result ──────────────────────────────────────────

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

    // `cost_usd` was the original JSON field name in older test fixtures. The CLI
    // never actually emitted it — the parser reads `total_cost_usd` (current) with
    // `total_cost` (legacy) as fallback. This test guards against someone adding
    // `cost_usd` back as a third alias, which would silently resurrect a dead name.
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
        // Real CLI sends both flat usage (per-step) and modelUsage (cumulative)
        let line = r#"{"type":"result","session_id":"abc","is_error":false,"total_cost_usd":0.078,"result":"","usage":{"input_tokens":3,"cache_read_input_tokens":11204,"cache_creation_input_tokens":11358,"output_tokens":65},"modelUsage":{"claude-opus-4-6[1m]":{"inputTokens":3,"cacheReadInputTokens":11204,"cacheCreationInputTokens":11358,"outputTokens":65,"contextWindow":1000000,"costUSD":0.078}}}"#;
        let chunk = parse_line_str(&mut parser, line).unwrap();
        match chunk {
            StreamChunk::Result {
                usage,
                context_window_size,
                total_cost,
                ..
            } => {
                // Should use flat usage (per-step), not modelUsage (cumulative)
                let u = usage.unwrap();
                assert_eq!(u.input_tokens, 3);
                assert_eq!(u.output_tokens, 65);
                assert_eq!(u.cache_read_tokens, Some(11204));
                assert_eq!(u.cache_write_tokens, Some(11358));
                // contextWindow from modelUsage
                assert_eq!(context_window_size, Some(1_000_000));
                // cost from total_cost_usd
                assert_eq!(total_cost, Some(0.078));
            }
            other => panic!("expected Result, got {other:?}"),
        }
    }

    #[test]
    fn parse_result_error_produces_error_chunk() {
        let mut parser = StreamParser::new();
        let line = r#"{"type":"result","is_error":true,"result":"Something went wrong"}"#;
        let chunk = parse_line_str(&mut parser, line).unwrap();
        match chunk {
            StreamChunk::Error { content } => assert_eq!(content, "Something went wrong"),
            other => panic!("expected Error, got {other:?}"),
        }
    }

    #[test]
    fn parse_result_error_with_empty_result_returns_placeholder_error() {
        // Regression guard: an `is_error=true` message with empty/missing
        // `result` text used to be swallowed silently, leaving the user
        // with a blank bubble and no indication of failure. Local LLM
        // providers (e.g. llama.cpp + Qwen) hit this path frequently, so
        // the parser now surfaces a placeholder Error chunk so the UI
        // always shows *something*.
        let mut parser = StreamParser::new();
        for line in [
            r#"{"type":"result","is_error":true,"result":""}"#,
            // Missing `result` key entirely — same semantics as empty.
            r#"{"type":"result","is_error":true}"#,
        ] {
            let chunk = parse_line_str(&mut parser, line).unwrap_or_else(|| {
                panic!(
                    "empty/missing error result must now produce a chunk, not be dropped: {line}"
                )
            });
            match chunk {
                StreamChunk::Error { content } => {
                    assert!(
                        !content.trim().is_empty(),
                        "placeholder content must be non-empty so the UI has something to render"
                    );
                }
                other => panic!("expected Error chunk, got {other:?}"),
            }
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

    // ── StreamParser: ignored types ──────────────────────────────────

    #[test]
    fn parse_assistant_type_emits_no_chunk() {
        // Assistant messages don't emit chunks — content streams via
        // `stream_event` deltas, and the final `Result` carries the UUID.
        // An assistant line WITHOUT a `message.id` (local LLM) is silently
        // ignored just like before.
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
        // Regression: the parser must stash `message.id` when seeing an
        // `assistant` event so the next `Result` commits it.
        let mut parser = StreamParser::new();
        let line =
            r#"{"type":"assistant","message":{"id":"msg_abc123","role":"assistant","content":[]}}"#;
        let chunks = parse_line_all_str(&mut parser, line);
        assert!(chunks.is_empty(), "assistant event must not emit chunks");
        assert_eq!(parser.pending_assistant_uuid.as_deref(), Some("msg_abc123"));
    }

    #[test]
    fn result_commits_pending_assistant_uuid_and_clears_it() {
        // The assistant UUID seen before a Result commits ONTO that Result
        // (ADR-046: atomic commit on turn completion) and is cleared so the
        // next turn doesn't recycle a stale id.
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

        // Fresh turn: Result with no preceding assistant must have None.
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
        // An error turn also `take`s the pending UUID so a subsequent
        // successful turn that arrives without its own `assistant` event
        // (an edge protocol) cannot be mislabeled with the errored turn's
        // identity.
        let mut parser = StreamParser::new();
        let assistant =
            r#"{"type":"assistant","message":{"id":"msg_err","role":"assistant","content":[]}}"#;
        let error_result = r#"{"type":"result","is_error":true,"result":"something broke"}"#;
        parse_line_str(&mut parser, assistant);
        let chunk = parse_line_str(&mut parser, error_result).unwrap();
        assert!(matches!(chunk, StreamChunk::Error { .. }));
        // pending_assistant_uuid stays set here because `parse_result`
        // short-circuits on `is_error=true`; the stdout-reader loop calls
        // `parser.reset()` after every terminal chunk which clears it. The
        // reset() is exercised explicitly to prove the clear happens.
        parser.reset();
        assert!(parser.pending_assistant_uuid.is_none());
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
        // Tool-result wrappers carry a user role but must NOT commit a
        // retry-point UUID — they're not real user prompts.
        let mut parser = StreamParser::new();
        let line = r#"{"type":"user","message":{"id":"u_tr","role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"ok"}]}}"#;
        let chunks = parse_line_all_str(&mut parser, line);
        assert_eq!(chunks.len(), 1);
        assert!(matches!(&chunks[0], StreamChunk::ToolResult { .. }));
    }

    #[test]
    fn user_message_mixed_text_and_tool_result_emits_tool_result_only() {
        // Mixed content (Claude Code occasionally interleaves a narrative
        // text block alongside a tool_result wrapper in the same user
        // event). The text presence MUST NOT trigger a UserMessageCommit:
        // the message is still a tool-result wrapper, not a real prompt.
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
        // Duplicate user messages (observed on retry/resume) must not
        // emit the commit twice — only the first occurrence wins.
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
        // Across a turn boundary (reset), a previously-committed user UUID
        // must stay in the dedup set — otherwise the re-echoed prompt on a
        // resume would commit a second time.
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
            StreamChunk::Error { content } => {
                assert!(content.contains("hit your limit"));
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
            StreamChunk::Error { content } => {
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

    // ── StreamParser: system init message ────────────────────────────

    #[test]
    fn parse_system_init_extracts_model() {
        let mut parser = StreamParser::new();
        let line = r#"{"type":"system","subtype":"init","model":"claude-opus-4-6"}"#;
        let chunk = parse_line_str(&mut parser, line).unwrap();
        match chunk {
            StreamChunk::SystemInit { model } => assert_eq!(model, "claude-opus-4-6"),
            other => panic!("expected SystemInit, got {other:?}"),
        }
    }

    #[test]
    fn parse_system_init_with_extra_fields() {
        let mut parser = StreamParser::new();
        let line = r#"{"type":"system","subtype":"init","model":"claude-opus-4-6","session_id":"abc","tools":["Read","Write"],"mcp_servers":[],"message":""}"#;
        let chunk = parse_line_str(&mut parser, line).unwrap();
        match chunk {
            StreamChunk::SystemInit { model } => assert_eq!(model, "claude-opus-4-6"),
            other => panic!("expected SystemInit, got {other:?}"),
        }
    }

    #[test]
    fn parse_system_init_without_model_falls_through() {
        let mut parser = StreamParser::new();
        let line = r#"{"type":"system","subtype":"init","session_id":"abc"}"#;
        assert!(
            parse_line_str(&mut parser, line).is_none(),
            "init without model field should fall through and produce None"
        );
    }

    #[test]
    fn parse_system_init_with_empty_model_falls_through() {
        let mut parser = StreamParser::new();
        let line = r#"{"type":"system","subtype":"init","model":""}"#;
        assert!(
            parse_line_str(&mut parser, line).is_none(),
            "init with empty model should fall through and produce None"
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
            StreamChunk::Error { content } => assert!(content.contains("hit your limit")),
            other => panic!("expected Error, got {other:?}"),
        }
    }

    #[test]
    fn stream_chunk_system_init_round_trips() {
        let chunk = StreamChunk::SystemInit {
            model: "test".to_string(),
        };
        let json = serde_json::to_string(&chunk).unwrap();
        assert_eq!(
            json,
            r#"{"chunk_type":"SystemInit","data":{"model":"test"}}"#
        );
        let deserialized: StreamChunk = serde_json::from_str(&json).unwrap();
        match deserialized {
            StreamChunk::SystemInit { model } => assert_eq!(model, "test"),
            other => panic!("expected SystemInit after round-trip, got {other:?}"),
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

    #[test]
    fn parse_rate_limit_event_extracts_fields() {
        let mut parser = StreamParser::new();
        let line = r#"{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","utilization":73.5,"resets_at":1738425600}}"#;
        let parsed: serde_json::Value = serde_json::from_str(line).unwrap();
        let (chunks, log_entry) = parser.parse_line(&parsed);
        let chunk = chunks.into_iter().next();
        match chunk {
            Some(StreamChunk::RateLimit {
                status,
                utilization,
                resets_at,
            }) => {
                assert_eq!(status, "allowed_warning");
                assert!((utilization.unwrap() - 73.5).abs() < f64::EPSILON);
                assert_eq!(resets_at, Some(1738425600));
            }
            other => panic!("expected RateLimit, got {other:?}"),
        }
        let entry = log_entry.unwrap();
        assert_eq!(entry.prefix, "RATE_LIMIT");
        assert!(entry.message.contains("73.5"));
    }

    #[test]
    fn parse_rate_limit_event_without_utilization() {
        let mut parser = StreamParser::new();
        let line = r#"{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"}}"#;
        let parsed: serde_json::Value = serde_json::from_str(line).unwrap();
        let (chunks, _) = parser.parse_line(&parsed);
        let chunk = chunks.into_iter().next();
        match chunk {
            Some(StreamChunk::RateLimit {
                status,
                utilization,
                resets_at,
            }) => {
                assert_eq!(status, "allowed");
                assert!(utilization.is_none());
                assert!(resets_at.is_none());
            }
            other => panic!("expected RateLimit, got {other:?}"),
        }
    }

    #[test]
    fn parse_rate_limit_event_rejected() {
        let mut parser = StreamParser::new();
        let line = r#"{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","utilization":100.0,"resets_at":1738430000}}"#;
        let parsed: serde_json::Value = serde_json::from_str(line).unwrap();
        let (chunks, _) = parser.parse_line(&parsed);
        let chunk = chunks.into_iter().next();
        match chunk {
            Some(StreamChunk::RateLimit {
                status,
                utilization,
                ..
            }) => {
                assert_eq!(status, "rejected");
                assert!((utilization.unwrap() - 100.0).abs() < f64::EPSILON);
            }
            other => panic!("expected RateLimit, got {other:?}"),
        }
    }

    #[test]
    fn stream_chunk_rate_limit_round_trips() {
        let chunk = StreamChunk::RateLimit {
            status: "allowed".to_string(),
            utilization: Some(42.5),
            resets_at: Some(1738425600),
        };
        let json = serde_json::to_string(&chunk).unwrap();
        let deserialized: StreamChunk = serde_json::from_str(&json).unwrap();
        match deserialized {
            StreamChunk::RateLimit {
                status,
                utilization,
                resets_at,
            } => {
                assert_eq!(status, "allowed");
                assert!((utilization.unwrap() - 42.5).abs() < f64::EPSILON);
                assert_eq!(resets_at, Some(1738425600));
            }
            other => panic!("expected RateLimit after round-trip, got {other:?}"),
        }
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

    // ── ChatSession::new() ───────────────────────────────────────────

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

    // ── Container name construction ──────────────────────────────────

    #[test]
    fn claude_container_name_uses_compose_prefix() {
        let name = claude_container_name("myproject");
        assert_eq!(name, format!("{}_myproject_claude", consts::COMPOSE_PREFIX));
    }

    #[test]
    fn claude_container_name_format_is_prefix_project_claude() {
        let name = claude_container_name("acme-corp");
        assert_eq!(name, "speedwave_acme-corp_claude");
    }

    // ── build_claude_args ────────────────────────────────────────────

    #[test]
    fn build_claude_args_without_resume() {
        let args = build_claude_args(None, None, &[]);
        assert!(args.contains(&consts::CLAUDE_BINARY.to_string()));
        assert!(args.contains(&"-p".to_string()));
        assert!(!args.contains(&"--resume".to_string()));
        assert!(!args.contains(&"--resume-session-at".to_string()));
        assert!(args.contains(&"--permission-prompt-tool".to_string()));
    }

    #[test]
    fn build_claude_args_with_resume() {
        let id = "550e8400-e29b-41d4-a716-446655440000";
        let args = build_claude_args(Some(id), None, &[]);
        let resume_pos = args.iter().position(|a| a == "--resume").unwrap();
        assert_eq!(args[resume_pos + 1], id);
        assert!(!args.contains(&"--resume-session-at".to_string()));
    }

    #[test]
    fn build_claude_args_with_resume_and_uuid() {
        // ADR-046: retry uses `--resume <session>` + `--resume-session-at <uuid>`.
        let session = "550e8400-e29b-41d4-a716-446655440000";
        let uuid = "msg_retry_anchor";
        let args = build_claude_args(Some(session), Some(uuid), &[]);
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
        let args = build_claude_args(None, None, &["--dangerously-skip-permissions".to_string()]);
        assert!(args.contains(&"--dangerously-skip-permissions".to_string()));
    }

    // ── Multi-event fixture test ─────────────────────────────────────

    #[test]
    fn full_turn_fixture_produces_expected_chunk_sequence() {
        let fixture = include_str!("../tests/fixtures/full_turn.ndjson");
        let mut parser = StreamParser::new();
        let chunks: Vec<StreamChunk> = fixture
            .lines()
            .filter_map(|line| parse_line_str(&mut parser, line))
            .collect();

        // Expected sequence:
        // 0: Text("I'll read ")
        // 1: Text("the file.")
        // 2: Thinking("")  (start marker)
        // 3: Thinking("Let me think about this...")
        // 4: ToolStart { toolu_01ABC, Read }
        // 5: ToolInputDelta { toolu_01ABC, ... }
        // 6: ToolInputDelta { toolu_01ABC, ... }
        // 7: ToolResult { toolu_01ABC, "fn main() {}", false }
        // 8: Text("The file contains a main function.")
        // 9: Result { session_id, cost, usage }

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

    // ── AskUserQuestion tests ───────────────────────────────────────

    #[test]
    fn parse_ask_user_question_suppressed_in_stream_events() {
        let mut parser = StreamParser::new();

        // 1. content_block_start: tool_use with AskUserQuestion — suppressed (no ToolStart emitted)
        let start = r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_ask1","name":"AskUserQuestion"}}}"#;
        let chunk = parse_line_str(&mut parser, start);
        assert!(chunk.is_none(), "AskUserQuestion should suppress ToolStart");

        // 2. input_json_delta — also suppressed for AskUserQuestion
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

        // 3. content_block_stop → AskUserQuestion is now handled via control_request,
        //    stream events should NOT emit it (returns None)
        let stop = r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0}}"#;
        assert!(
            parse_line_str(&mut parser, stop).is_none(),
            "AskUserQuestion should not be emitted from stream events (handled via control_request)"
        );
    }

    #[test]
    fn parse_ask_user_question_cleans_up_tool_input() {
        let mut parser = StreamParser::new();

        let start = r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_ask2","name":"AskUserQuestion"}}}"#;
        parse_line_str(&mut parser, start);

        let delta = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"question\":\"Yes or no?\",\"header\":\"\",\"multiSelect\":false,\"options\":[]}"}}}"#;
        parse_line_str(&mut parser, delta);

        let stop = r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0}}"#;
        parse_line_str(&mut parser, stop);

        // tool_input should be cleaned up after emission
        assert!(parser.tool_input.is_empty());
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
            question: "Pick one".to_string(),
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
            header: "Test".to_string(),
            multi_select: true,
        };
        let serialized = serde_json::to_string(&original).unwrap();
        let deserialized: StreamChunk = serde_json::from_str(&serialized).unwrap();
        match deserialized {
            StreamChunk::AskUserQuestion {
                tool_id,
                question,
                options,
                header,
                multi_select,
            } => {
                assert_eq!(tool_id, "t1");
                assert_eq!(question, "Pick one");
                assert_eq!(options.len(), 2);
                assert_eq!(header, "Test");
                assert!(multi_select);
            }
            other => panic!("expected AskUserQuestion, got {other:?}"),
        }
    }

    #[test]
    fn parse_ask_user_question_wrapped_format_suppressed_in_stream() {
        let mut parser = StreamParser::new();

        let start = r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_ask3","name":"AskUserQuestion"}}}"#;
        parse_line_str(&mut parser, start);

        // Wrapped format: {"questions":[{...}]}
        let delta = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"questions\":[{\"question\":\"Co wolisz?\",\"header\":\"Owoc\",\"multiSelect\":false,\"options\":[{\"label\":\"Gruszki\",\"description\":\"Zielone\"},{\"label\":\"Banany\",\"description\":\"Żółte\"}]}]}"}}}"#;
        parse_line_str(&mut parser, delta);

        // content_block_stop should NOT emit AskUserQuestion (handled via control_request)
        let stop = r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0}}"#;
        assert!(
            parse_line_str(&mut parser, stop).is_none(),
            "AskUserQuestion should not be emitted from stream events"
        );
    }

    // ── Control protocol tests ────────────────────────────────────

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

    #[test]
    fn build_ask_user_response_flat_format() {
        let pending = ControlRequest {
            request_id: "req_10".to_string(),
            tool_name: "AskUserQuestion".to_string(),
            input: serde_json::json!({
                "question": "Pick a fruit",
                "header": "Fruits",
                "multiSelect": false,
                "options": [{"label": "Apple", "value": "apple"}, {"label": "Banana", "value": "banana"}]
            }),
            tool_use_id: "toolu_flat_test".to_string(),
        };
        let resp = build_ask_user_response(&pending, "Apple");
        assert_eq!(resp["type"], "control_response");
        assert_eq!(resp["response"]["request_id"], "req_10");
        assert_eq!(resp["response"]["response"]["behavior"], "allow");
        let updated = &resp["response"]["response"]["updatedInput"];
        assert_eq!(updated["answers"]["Pick a fruit"], "Apple");
        assert_eq!(updated["question"], "Pick a fruit");
    }

    #[test]
    fn build_ask_user_response_wrapped_format() {
        let pending = ControlRequest {
            request_id: "req_11".to_string(),
            tool_name: "AskUserQuestion".to_string(),
            input: serde_json::json!({
                "questions": [{
                    "question": "Co wolisz?",
                    "header": "Owoc",
                    "multiSelect": false,
                    "options": [{"label": "Gruszki"}, {"label": "Banany"}]
                }]
            }),
            tool_use_id: "toolu_wrapped_test".to_string(),
        };
        let resp = build_ask_user_response(&pending, "Gruszki");
        assert_eq!(resp["type"], "control_response");
        let updated = &resp["response"]["response"]["updatedInput"];
        assert_eq!(updated["answers"]["Co wolisz?"], "Gruszki");
        // Original questions array should still be present
        assert!(updated["questions"].as_array().unwrap().len() == 1);
    }

    #[test]
    fn build_ask_user_response_empty_questions_array_sets_answers() {
        let pending = ControlRequest {
            request_id: "req_empty".to_string(),
            tool_name: "AskUserQuestion".to_string(),
            input: serde_json::json!({
                "questions": []
            }),
            tool_use_id: "toolu_empty_q".to_string(),
        };
        let resp = build_ask_user_response(&pending, "fallback");
        assert_eq!(resp["type"], "control_response");
        let updated = &resp["response"]["response"]["updatedInput"];
        // With empty questions, the answer key is "" (empty question text)
        assert_eq!(updated["answers"][""], "fallback");
    }

    #[test]
    fn emit_ask_user_from_control_request_flat() {
        let req = ControlRequest {
            request_id: "req_20".to_string(),
            tool_name: "AskUserQuestion".to_string(),
            input: serde_json::json!({
                "question": "Yes or no?",
                "header": "Confirm",
                "multiSelect": false,
                "options": [{"label": "Yes", "value": "yes"}, {"label": "No", "value": "no"}]
            }),
            tool_use_id: "toolu_ask_flat".to_string(),
        };
        let chunk = StreamParser::emit_ask_user_from_control_request(&req).unwrap();
        match chunk {
            StreamChunk::AskUserQuestion {
                tool_id,
                question,
                options,
                header,
                multi_select,
            } => {
                assert_eq!(tool_id, "toolu_ask_flat");
                assert_eq!(question, "Yes or no?");
                assert_eq!(header, "Confirm");
                assert!(!multi_select);
                assert_eq!(options.len(), 2);
                assert_eq!(options[0].label, "Yes");
                assert_eq!(options[1].label, "No");
            }
            other => panic!("expected AskUserQuestion, got {other:?}"),
        }
    }

    #[test]
    fn emit_ask_user_from_control_request_wrapped() {
        let req = ControlRequest {
            request_id: "req_21".to_string(),
            tool_name: "AskUserQuestion".to_string(),
            input: serde_json::json!({
                "questions": [{
                    "question": "Wybierz kolor",
                    "header": "Kolor",
                    "multiSelect": true,
                    "options": [{"label": "Czerwony", "value": "red"}, {"label": "Niebieski", "value": "blue"}]
                }]
            }),
            tool_use_id: "toolu_ask_wrapped".to_string(),
        };
        let chunk = StreamParser::emit_ask_user_from_control_request(&req).unwrap();
        match chunk {
            StreamChunk::AskUserQuestion {
                tool_id,
                question,
                header,
                multi_select,
                options,
            } => {
                assert_eq!(tool_id, "toolu_ask_wrapped");
                assert_eq!(question, "Wybierz kolor");
                assert_eq!(header, "Kolor");
                assert!(multi_select);
                assert_eq!(options.len(), 2);
                assert_eq!(options[0].value, "red");
                assert_eq!(options[1].value, "blue");
            }
            other => panic!("expected AskUserQuestion, got {other:?}"),
        }
    }

    #[test]
    fn emit_ask_user_from_control_request_empty_questions_array() {
        let req = ControlRequest {
            request_id: "req_empty".to_string(),
            tool_name: "AskUserQuestion".to_string(),
            input: serde_json::json!({
                "questions": []
            }),
            tool_use_id: "toolu_empty_q".to_string(),
        };
        let chunk = StreamParser::emit_ask_user_from_control_request(&req).unwrap();
        match chunk {
            StreamChunk::AskUserQuestion {
                question, options, ..
            } => {
                assert_eq!(question, "");
                assert!(options.is_empty());
            }
            other => panic!("expected AskUserQuestion, got {other:?}"),
        }
    }

    #[test]
    fn build_claude_args_includes_permission_prompt_tool() {
        let args = build_claude_args(None, None, &[]);
        let pos = args
            .iter()
            .position(|a| a == "--permission-prompt-tool")
            .expect("--permission-prompt-tool should be in args");
        assert_eq!(args[pos + 1], "stdio");
    }

    // ── Control request fixture test ────────────────────────────────

    // ── prepare_args tests ──────────────────────────────────────────

    #[test]
    fn prepare_args_fails_when_project_not_in_config() {
        let user_config = config::SpeedwaveUserConfig {
            projects: vec![],
            active_project: None,
            selected_ide: None,
            log_level: None,
        };
        let result = ChatSession::prepare_args("nonexistent", &user_config, None, None);
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
            }],
            active_project: None,
            selected_ide: None,
            log_level: None,
        };
        let result =
            ChatSession::prepare_args("test", &user_config, Some("../../../etc/passwd"), None);
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
            }],
            active_project: None,
            selected_ide: None,
            log_level: None,
        };
        let result = ChatSession::prepare_args(
            "test",
            &user_config,
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
            }],
            active_project: None,
            selected_ide: None,
            log_level: None,
        };
        let result = ChatSession::prepare_args("myproject", &user_config, None, None);
        assert!(result.is_ok());
        let (args, container) = result.unwrap();
        assert!(args.contains(&"-p".to_string()));
        assert!(container.contains("myproject"));
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
            }],
            active_project: None,
            selected_ide: None,
            log_level: None,
        };
        let session_id = "550e8400-e29b-41d4-a716-446655440000";
        let result = ChatSession::prepare_args("proj", &user_config, Some(session_id), None);
        assert!(result.is_ok());
        let (args, _container) = result.unwrap();
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
            }],
            active_project: None,
            selected_ide: None,
            log_level: None,
        };
        let session_id = "550e8400-e29b-41d4-a716-446655440000";
        let uuid = "msg_retry_me";
        let result = ChatSession::prepare_args("proj", &user_config, Some(session_id), Some(uuid));
        assert!(result.is_ok());
        let (args, _) = result.unwrap();
        assert!(args.contains(&"--resume-session-at".to_string()));
        assert!(args.contains(&uuid.to_string()));
    }

    // ── validate_retry_uuid ──────────────────────────────────────────

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

    // ── Silent failure prevention tests ──────────────────────────────

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
            // control_requests are handled separately from stream events
            if let Some(ctrl) = try_parse_control_request_str(line) {
                if ctrl.tool_name == ASK_USER_TOOL_NAME {
                    if let Some(chunk) = StreamParser::emit_ask_user_from_control_request(&ctrl) {
                        chunks.push(chunk);
                    }
                }
                // auto-approve for non-AskUserQuestion is a stdin write, not a chunk
                continue;
            }
            if let Some(chunk) = parse_line_str(&mut parser, line) {
                chunks.push(chunk);
            }
        }

        // Expected: Text, AskUserQuestion (from control_request), Text, Result
        assert_eq!(chunks.len(), 4, "expected 4 chunks, got {}", chunks.len());

        match &chunks[0] {
            StreamChunk::Text { content } => assert_eq!(content, "Let me check."),
            other => panic!("chunk 0: expected Text, got {other:?}"),
        }
        match &chunks[1] {
            StreamChunk::AskUserQuestion {
                tool_id, question, ..
            } => {
                assert_eq!(tool_id, "toolu_ask_ctrl1");
                assert_eq!(question, "Allow file read?");
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

    // ── Slash command result_text tests ──────────────────────────────

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
        };
        let json = serde_json::to_string(&chunk).unwrap();
        assert!(
            json.contains("\"context_window_size\":1000000"),
            "context_window_size should be present when Some, got: {json}"
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

    // ── LogEntry tests ──────────────────────────────────────────────

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
        // Start first
        let start = r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_01ABC","name":"Read","input":{}}}}"#;
        parse_line_full(&mut parser, start);
        // Stop
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

    // ── Session guard tests ─────────────────────────────────────────

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

    // ── TurnUsage + per-turn meta tests ─────────────────────────────

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
        // After a resume or reset, `current` may momentarily be less than
        // `previous`. The helper should report zero, not underflow.
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
    fn parse_result_emits_turn_usage_from_flat_per_step_usage() {
        let mut parser = StreamParser::new();
        // First turn: flat usage with all four fields. With no modelUsage,
        // the parser treats this as per-step and emits it directly.
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
        // Turn 1: cumulative = {in:5, out:3, cR:0, cW:10}. Delta = that.
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

        // Turn 2: cumulative = {in:12, out:8, cR:100, cW:10}. Delta = {7,5,100,0}.
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

        // Turn 3: cumulative = {in:20, out:13, cR:200, cW:10}. Delta = {8,5,100,0}.
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
        // Simulate resuming mid-session: restore the cumulative snapshot
        // from history, then verify the next Result's delta is computed
        // against the restored baseline, not against zero.
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
        );

        // First Result after resume: cumulative = {in:110, out:55, cR:200, cW:30}.
        // Expected delta: {10, 5, 0, 0}. turn_cost = 0.30 - 0.25 = 0.05.
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

        // Snapshot advanced to the current cumulative total after the turn.
        let snap = parser.previous_session_usage();
        assert_eq!(snap.input_tokens, 110);
        assert_eq!(snap.output_tokens, 55);
    }

    #[test]
    fn parse_result_uses_systeminit_model_when_modelusage_absent() {
        let mut parser = StreamParser::new();
        // SystemInit captures the model
        let init = r#"{"type":"system","subtype":"init","model":"claude-haiku-4-5"}"#;
        parse_line_str(&mut parser, init);

        // Result without modelUsage should fall back to the captured model
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
        // Neither cache_read_input_tokens nor cache_creation_input_tokens —
        // both must flatten to 0 in the emitted TurnUsage.
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
        // First Result: no previous cost snapshot — turn_cost == total_cost.
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
        );
        parser.new_session();
        assert_eq!(parser.previous_session_usage(), TurnUsage::default());
        // Next Result with no prior history should emit the turn at face value.
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
        // Defensive: if the CLI ever reports a cumulative cost lower than
        // the previous snapshot (resume edge case), we drop `turn_cost`
        // rather than report a nonsense negative value.
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
        // Rare but defined case: modelUsage has entries for two models
        // (e.g., mid-session model switch). The cumulative is the sum.
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
        // No optional fields: cache_read/write are always present in the
        // wire format so the TS frontend can render without `??` guards.
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
        // End-to-end-ish coverage of the resume path: feed the parser a
        // seed that mirrors what `compute_resume_snapshot` would return for
        // a real prior transcript, then assert the first new `result` line
        // produces the per-turn delta — not the entire cumulative total.
        // Without `restore_session_snapshot` being invoked on the live
        // resume path, this test would fail with delta == cumulative.
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
        );

        // First post-resume Result: cumulative jumps by {5 in, 3 out}.
        // Without the seed the parser would report all 95/43 as the turn.
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
