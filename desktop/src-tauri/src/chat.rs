use crate::history;
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

/// Events emitted to the Angular frontend over the `"chat_stream"` event.
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
        /// Boxed to keep this variant under clippy's large-variant gap;
        /// serde treats `Option<Box<T>>` exactly like `Option<T>`.
        usage: Option<Box<UsageInfo>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        result_text: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        context_window_size: Option<u64>,
        /// UUID of the just-completed assistant message (ADR-046); `None` for
        /// error turns and local-LLM paths that omit `message.id`.
        #[serde(skip_serializing_if = "Option::is_none")]
        assistant_uuid: Option<String>,
        /// Per-turn usage delta since the previous turn (`current - previous`
        /// for cumulative `usage`; the per-step `usage` otherwise).
        #[serde(skip_serializing_if = "Option::is_none")]
        turn_usage: Option<TurnUsage>,
        /// Per-turn cost in USD, delta of `total_cost_usd` between turns. `None`
        /// hides the segment until `reconcileFooterCost` fills it from the proxy SSOT.
        #[serde(skip_serializing_if = "Option::is_none")]
        turn_cost: Option<f64>,
        /// Model name for the turn when known. Populated from `modelUsage`
        /// in the `result` message or from the most recent `SystemInit`.
        #[serde(skip_serializing_if = "Option::is_none")]
        model: Option<String>,
        /// Usage of the most recent main-chain API call — the only valid
        /// context-occupancy source (per-turn `usage` sums cache reads per call).
        #[serde(skip_serializing_if = "Option::is_none")]
        context_usage: Option<TurnUsage>,
    },
    /// Interactive question(s) from Claude (AskUserQuestion tool).
    /// Up to 4 questions per the Agent SDK contract.
    AskUserQuestion {
        tool_id: String,
        questions: Vec<AskUserQuestionItem>,
        /// Always `0` on first emit. The frontend reducer advances this as
        /// answers come in.
        current_index: usize,
    },
    /// Error from the Claude subprocess.
    Error { content: String },
    /// Session init metadata — model + session id from the system init message.
    /// `session_id` lets the frontend queue/retry during the FIRST turn (ADR-045).
    SystemInit {
        model: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        session_id: Option<String>,
    },
    /// Rate limit event — utilization and reset info.
    RateLimit {
        status: String,
        utilization: Option<f64>,
        resets_at: Option<u64>,
    },
    /// Commits a UUID onto the most recent user entry (ADR-046) on the first
    /// text-bearing user message (not a tool_result wrapper).
    UserMessageCommit { uuid: String },
    /// A user control command (`/model <id>` or `/effort <level>`), recognized
    /// by shape at send time and rendered as a self-describing chip instead of
    /// a plain user bubble. `uuid` is `None` at emission — the wire carries no
    /// user-echo event for a tool-free session; a later user-type event with a
    /// matching `message.id` may still commit a uuid via `UserMessageCommit`.
    ControlChip {
        command: String,
        argument: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        uuid: Option<String>,
    },
    /// One-slot queued message (ADR-045) drained at turn end; frontend clears
    /// `state.pending_queue` since the message is already in flight via stdin.
    QueueDrained { session_id: String, text: String },
}

/// Redacts secrets in a chunk's free-text fields. Structural fields (tool ids,
/// model, session ids) and `partial_json` are left untouched.
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
        StreamChunk::Error { content } => StreamChunk::Error {
            content: sanitize(&content),
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
            // Model-authored free text — redact question/header/option strings.
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

/// The ONE way to emit a `chat_stream` event: sanitizes first so no site leaks.
/// Enforced by `chat_stream_emits_go_through_helper`.
fn emit_sanitized_chunk(app_handle: &tauri::AppHandle, chunk: StreamChunk) {
    if let Err(e) = app_handle.emit("chat_stream", sanitize_chunk(chunk)) {
        log::warn!("failed to emit chat_stream event: {e}");
    }
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
    /// Saturating subtraction clamps reset/resume regressions to zero.
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

/// JSONL `usage` field names (Anthropic schema) — SSOT for the result reader,
/// `history.rs` transcript parsing, and the resume-snapshot summing.
pub(crate) const USAGE_INPUT_TOKENS: &str = "input_tokens";
pub(crate) const USAGE_OUTPUT_TOKENS: &str = "output_tokens";
pub(crate) const USAGE_CACHE_READ_TOKENS: &str = "cache_read_input_tokens";
pub(crate) const USAGE_CACHE_WRITE_TOKENS: &str = "cache_creation_input_tokens";
/// Legacy flat cache names some CLI builds emit in `result.usage`.
pub(crate) const USAGE_CACHE_READ_TOKENS_LEGACY: &str = "cache_read_tokens";
pub(crate) const USAGE_CACHE_WRITE_TOKENS_LEGACY: &str = "cache_write_tokens";

/// True when a parsed `assistant` line is a sidechain (subagent) call —
/// checked via BOTH the live stream-json marker (`parent_tool_use_id`) and
/// the on-disk transcript marker (`isSidechain`), since either can appear
/// depending on source (live CLI stream vs resumed JSONL transcript).
/// SSOT for both `capture_context_usage` (chat.rs) and the resume-snapshot
/// / assistant-message readers (history.rs) — never re-check one field alone.
pub(crate) fn is_sidechain_event(parsed: &serde_json::Value) -> bool {
    !parsed["parent_tool_use_id"].is_null() || parsed["isSidechain"].as_bool() == Some(true)
}

/// Reads a JSONL `usage` object into a `TurnUsage`, zero-filling missing or
/// malformed fields. `None` when `usage` is not a JSON object.
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

/// Tool name constant for the AskUserQuestion tool.
const ASK_USER_TOOL_NAME: &str = "AskUserQuestion";

// Stream-json protocol literals (claude-agent-sdk-python types.py).
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

/// Per-`AskUserQuestion` slot state held while the user answers each question.
/// Consumed once every slot in `answers` is `Some`.
#[derive(Debug, Clone)]
pub struct PartialAnswers {
    /// Original control_request — reconstructs the wire payload (`request_id`
    /// + full `input`).
    pub request: ControlRequest,
    /// Parsed questions list (after truncation to `MAX_ASK_USER_QUESTIONS`).
    pub questions: Vec<AskUserQuestionItem>,
    /// One slot per question (`None` until answered); length always equals
    /// `questions.len()` — enforced by `PartialAnswers::new`.
    pub answers: Vec<Option<String>>,
}

impl PartialAnswers {
    /// Create a `PartialAnswers` with one `None` slot per question, upholding
    /// the `answers.len() == questions.len()` invariant.
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

/// Result of `fill_slot`. `Completed` carries the `PartialAnswers` so the
/// caller builds the wire response without re-locking the pending map.
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

/// Maximum size, in bytes, of a user-supplied chat message string.
pub const MAX_MESSAGE_LEN: usize = 1_000_000;

/// Maximum size, in bytes, of a single per-slot answer to an `AskUserQuestion`.
/// Sized so 4 maximal slots stay under `MAX_ASK_USER_WIRE_BYTES` once encoded.
pub const MAX_ASK_USER_ANSWER_LEN: usize = 12 * 1024;

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
    /// Provisional assistant UUID (ADR-046), committed onto `Result` and
    /// `take`n there so an error turn can't reuse a stale id.
    pending_assistant_uuid: Option<String>,
    /// UUIDs already emitted via `UserMessageCommit`, guarding against
    /// duplicate commits when a user message is re-emitted in the same turn.
    committed_user_uuids: std::collections::HashSet<String>,
    /// Snapshot of cumulative session usage at the start of the current turn.
    /// Per-turn usage = current - previous.
    previous_session_usage: TurnUsage,
    /// Usage of the most recent main-chain API call (sidechains excluded);
    /// carried onto `Result` as the context-occupancy source.
    last_context_usage: Option<TurnUsage>,
    /// Cumulative session cost in USD from the previous `Result`. Per-turn
    /// cost = current total - previous total, when both are authoritative.
    previous_session_cost: Option<f64>,
    /// Chronological last-observed model (init or real assistant turn wins
    /// over cumulative-usage dominance — survives a mid-session /model switch).
    model_tracker: crate::session_model::SessionModelTracker,
    /// Unhandled top-level stream-json `type` values, each logged once per
    /// session. Bounded by `MAX_TRACKED_UNKNOWN_TYPES`.
    seen_unknown_types: std::collections::HashSet<String>,
    /// One-shot: suppresses the next assistant chunk whose `message.model ==
    /// "<synthetic>"` (the `/model`/`/effort` confirmation), armed by a
    /// chipped send. Cleared by a fresh `system/init` or any assistant line.
    pending_synthetic_confirmation_suppression: bool,
}

/// Cap on distinct unknown types tracked for once-per-type logging.
const MAX_TRACKED_UNKNOWN_TYPES: usize = 32;

impl StreamParser {
    /// Create a new parser with empty state.
    pub fn new() -> Self {
        Self {
            active_blocks: HashMap::new(),
            tool_input: HashMap::new(),
            pending_assistant_uuid: None,
            committed_user_uuids: std::collections::HashSet::new(),
            previous_session_usage: TurnUsage::default(),
            last_context_usage: None,
            previous_session_cost: None,
            model_tracker: crate::session_model::SessionModelTracker::default(),
            seen_unknown_types: std::collections::HashSet::new(),
            pending_synthetic_confirmation_suppression: false,
        }
    }

    /// Seeds the cumulative usage snapshot so the next `Result` subtracts
    /// against the supplied baseline (called on resume).
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

    /// Current cumulative usage snapshot. Tests use this to assert that the
    /// snapshot advances after each turn.
    #[cfg(test)]
    pub fn previous_session_usage(&self) -> TurnUsage {
        self.previous_session_usage
    }

    /// Parse a pre-parsed JSON value. Mutates internal state for block tracking.
    /// Returns (chunks for frontend in emission order, optional log entry).
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
                // One-shot: any assistant line consumes the flag (raw assistant
                // lines never emit chunks anyway, synthetic or not).
                self.pending_synthetic_confirmation_suppression = false;
                (Vec::new(), None)
            }
            "system" => option_to_vec(self.parse_system_message(parsed)),
            "rate_limit_event" => option_to_vec(Self::parse_rate_limit_event(parsed)),
            other => {
                // Unknown types are dropped; logged once per type.
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

    /// Capture `message.id` into `pending_assistant_uuid` for the next `Result`
    /// chunk; missing/empty ids are silently ignored.
    fn capture_assistant_uuid(&mut self, parsed: &serde_json::Value) {
        if let Some(id) = parsed["message"]["id"].as_str() {
            if !id.is_empty() {
                self.pending_assistant_uuid = Some(id.to_string());
            }
        }
    }

    /// Feed `message.model` into the session model tracker (chronological
    /// last-observed wins). Sidechain (subagent) calls are excluded — they
    /// commonly run a different, cheaper model than the main chain.
    fn capture_assistant_model(&mut self, parsed: &serde_json::Value) {
        if is_sidechain_event(parsed) {
            return;
        }
        if let Some(model) = parsed["message"]["model"].as_str() {
            self.model_tracker.observe_assistant(model);
        }
    }

    /// Track `message.usage` of main-chain assistant events (last one wins).
    /// Sidechain (subagent) calls and all-zero usage never move the meter.
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

    /// Reset per-message block state (e.g. on `message_stop`). Does NOT reset
    /// the session-wide usage snapshot — only `new_session()` does.
    pub fn reset(&mut self) {
        self.active_blocks.clear();
        self.tool_input.clear();
        // pending_assistant_uuid NOT cleared (message_stop can precede the
        // result; parse_result .take()s it); committed_user_uuids persists too.
    }

    /// Reset all state for a fresh session (no snapshot restore).
    #[cfg(test)]
    pub fn new_session(&mut self) {
        self.reset();
        self.pending_assistant_uuid = None;
        self.previous_session_usage = TurnUsage::default();
        self.last_context_usage = None;
        self.previous_session_cost = None;
        self.model_tracker = crate::session_model::SessionModelTracker::default();
        self.seen_unknown_types.clear();
        self.pending_synthetic_confirmation_suppression = false;
    }

    /// Arms the one-shot synthetic-confirmation suppression (production path,
    /// called by the reader thread when `ChatSession`'s send-time flag is set).
    pub(crate) fn arm_synthetic_confirmation_suppression(&mut self) {
        self.pending_synthetic_confirmation_suppression = true;
    }

    /// Test seam for `arm_synthetic_confirmation_suppression` — parsing tests
    /// have no access to `ChatSession`'s send-time `Arc<AtomicBool>`.
    #[cfg(test)]
    pub(crate) fn arm_pending_synthetic_confirmation_suppression(&mut self) {
        self.pending_synthetic_confirmation_suppression = true;
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

    /// Parse one question entry; `None` if unusable (no `question` text).
    /// Malformed `options` entries are filtered out individually.
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
        // Drop entries without question text; logged at count level only.
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

    /// Parse the questions list (SDK `{ "questions": [...] }` array or a single
    /// object); truncates to `MAX_ASK_USER_QUESTIONS`; empty `Vec` if none usable.
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

    /// Build AskUserQuestion chunk from a control_request's input (test-only).
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
                        // Suppress ToolStart for AskUserQuestion (control_request path).
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
                        // AskUserQuestion uses control_request; just clean up input.
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

        // Commit a UUID once per session, only for a text-bearing user prompt.
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

        // One user line can carry several tool_result blocks; each emits a chunk.
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
        // Consume the pending uuid up-front so an error turn (which short-circuits
        // below) doesn't leak it onto the next turn.
        let assistant_uuid = self.pending_assistant_uuid.take();

        let is_error = parsed["is_error"].as_bool().unwrap_or(false);

        if is_error {
            let result_text = parsed["result"].as_str().unwrap_or("");
            if result_text.trim().is_empty() {
                // `is_error=true` with empty `result`: placeholder chunk + DEBUG log.
                log::warn!(
                    "result message has is_error=true but empty result text; \
                     returning placeholder error chunk"
                );
                log::debug!("empty-error result payload: {parsed}");
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
            log::warn!("result message missing 'session_id'");
        }

        // Cost: prefer total_cost_usd (real CLI), fall back to total_cost (legacy)
        let total_cost = parsed["total_cost_usd"]
            .as_f64()
            .or_else(|| parsed["total_cost"].as_f64());

        // modelUsage: cumulative per-model stats; used for contextWindow + model id.
        let model_usage = parsed["modelUsage"].as_object();
        // Dominant-by-usage model: only a fallback when the tracker resolved nothing.
        let usage_dominant_model = model_usage.and_then(|mu| {
            mu.iter()
                .max_by_key(|(_, stats)| stats["outputTokens"].as_u64().unwrap_or(0))
                .map(|(k, _)| k.clone())
        });

        // Chronological last-observed model wins; usage-dominance is the final fallback.
        let model = self
            .model_tracker
            .resolve()
            .map(str::to_string)
            .or_else(|| usage_dominant_model.clone());

        // Fed AFTER resolving (so this turn's dominance can't overwrite a value
        // already observed this turn) — keeps a later plain-usage-only turn correct.
        if let Some(m) = usage_dominant_model.as_deref() {
            self.model_tracker.observe_assistant(m);
        }

        // contextWindow from the resolved model's modelUsage entry; falls back to
        // the dominant entry only when the tracker resolved nothing.
        let context_window_size = model
            .as_deref()
            .and_then(|m| model_usage.and_then(|mu| mu.get(m)))
            .or_else(|| {
                model_usage.and_then(|mu| {
                    mu.values()
                        .max_by_key(|stats| stats["outputTokens"].as_u64().unwrap_or(0))
                })
            })
            .and_then(|stats| stats["contextWindow"].as_u64());

        // Option-preserving reader (absent cache fields stay `None` for the UI);
        // field names shared with `turn_usage_from_jsonl` (the zero-filling SSOT).
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

        // Per-turn usage: see `compute_turn_usage_from_result`.
        let turn_usage = compute_turn_usage_from_result(
            parsed,
            usage.as_deref(),
            &mut self.previous_session_usage,
        );

        // Per-turn cost = `total_cost_usd` delta vs snapshot, or `total_cost` on turn 1.
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

    /// Parse a rate_limit_event from Claude Code.
    /// Extracts status, utilization percentage, and reset timestamp.
    fn parse_rate_limit_event(
        parsed: &serde_json::Value,
    ) -> (Option<StreamChunk>, Option<LogEntry>) {
        let info = &parsed["rate_limit_info"];
        let status = info["status"].as_str().unwrap_or("unknown").to_string();
        let utilization = info["utilization"].as_f64();
        // Read the reset timestamp as both `resetsAt` and `resets_at`.
        let resets_at = info["resetsAt"]
            .as_u64()
            .or_else(|| info["resets_at"].as_u64());

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

    /// Parse system messages, surfacing rate-limit and other actionable ones
    /// as errors so the frontend can display them.
    fn parse_system_message(
        &mut self,
        parsed: &serde_json::Value,
    ) -> (Option<StreamChunk>, Option<LogEntry>) {
        // A fresh system boundary must never carry a stale suppression into
        // the next turn (e.g. an interrupted chip send with no reply yet).
        self.pending_synthetic_confirmation_suppression = false;

        // ── Extract model + session id from system init message ──
        // Check BEFORE the message.is_empty() early return (init may lack `message`).
        if parsed["subtype"].as_str() == Some("init") {
            let session_id = parsed["session_id"]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(String::from);
            if let Some(model) = parsed["model"].as_str() {
                if !model.is_empty() {
                    // Cache the model for subsequent result chunks.
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
            // Model missing/empty — still surface the session id (ADR-045 first-turn queue).
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

/// Per-turn usage from a `result`, advancing the snapshot in place. Source:
/// flat `usage` (accumulated) or `modelUsage` (delta); `None` if absent.
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
    // Fallback: only `modelUsage` is present — delta against the snapshot.
    let cumulative = extract_cumulative_usage(parsed)?;
    let delta = TurnUsage::delta(&cumulative, snapshot);
    *snapshot = cumulative;
    Some(delta)
}

/// Sum `modelUsage` across models into one cumulative snapshot; `None` when
/// no `modelUsage` object or its values lack usage fields.
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

/// 1 MiB cap on serialized user-message JSON — wire is text-only after
/// ADR-065; images go through `<project>/.speedwave/pastes/` + `@…` refs.
pub const MAX_WIRE_BYTES: usize = 1024 * 1024;

/// Text-only wire content block (ADR-065). `@/workspace/...` refs are inlined as text.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WireContentBlock {
    Text { text: String },
}

pub fn text_only(text: impl Into<String>) -> Vec<WireContentBlock> {
    vec![WireContentBlock::Text { text: text.into() }]
}

/// True when the blocks carry nothing but whitespace or a lone `/` (the
/// slash-menu trigger, not a message — sending it spawns a junk session).
pub fn is_blank_or_slash_only(blocks: &[WireContentBlock]) -> bool {
    let joined: String = blocks
        .iter()
        .map(|WireContentBlock::Text { text }| text.as_str())
        .collect();
    joined.trim().is_empty() || speedwave_runtime::slash::is_bare_slash(&joined)
}

/// Stream-json user envelope: `{"type":"user","message":{"role":"user","content":[...]}}`.
pub fn build_user_message(blocks: &[WireContentBlock]) -> serde_json::Value {
    serde_json::json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": blocks,
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

/// AskUserQuestion response: full answers map (question text → chosen label)
/// with `questions` preserved in `updatedInput`; fails closed on duplicate text.
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

/// Validate a `--resume-session-at` UUID: non-empty bounded `[A-Za-z0-9_-]`
/// (API `msg_...` + UUID v4); rejects shell metacharacters/whitespace/traversal.
pub fn validate_retry_uuid(uuid: &str) -> anyhow::Result<()> {
    if uuid.is_empty() {
        anyhow::bail!("retry uuid must not be empty");
    }
    if uuid.len() > 128 {
        anyhow::bail!("retry uuid too long (max 128 chars)");
    }
    // Allow [A-Za-z0-9_-] only.
    for ch in uuid.chars() {
        if !(ch.is_ascii_alphanumeric() || ch == '_' || ch == '-') {
            anyhow::bail!("retry uuid contains invalid character: {ch:?}");
        }
    }
    Ok(())
}

/// Build Claude Code's stream-json argv: `env SPW_SESSION_INSTANCE_ID=<id>` for
/// reap, plus `--resume`/`--resume-session-at` from the resume args (ADR-046).
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

/// Build the container name for a project's Claude container.
pub fn claude_container_name(project: &str) -> String {
    claude_container_name_with_prefix(consts::compose_prefix(), project)
}

/// Parameterised by `prefix` so unit tests avoid the `consts::compose_prefix()`
/// `OnceLock`, which resolves the process-global `data_dir()` basename.
fn claude_container_name_with_prefix(prefix: &str, project: &str) -> String {
    format!("{prefix}_{project}_claude")
}

/// Container + marker-scoped kill argv for a reap exec. Pure (testable without
/// a runtime); [`ChatSession::reap_instance`] runs it.
fn reap_exec_plan(project: &str, id: &str) -> (String, Vec<String>) {
    (
        claude_container_name(project),
        speedwave_runtime::session::kill_by_instance_command(id),
    )
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

/// Manages a Claude Code subprocess in the container (via `container_exec`);
/// a background thread parses stdout and emits Tauri events directly.
pub struct ChatSession {
    child: Option<Child>,
    project_name: String,
    shared_stdin: Option<Arc<Mutex<std::process::ChildStdin>>>,
    pending_requests: PendingRequests,
    drain_handles: Vec<std::thread::JoinHandle<()>>,
    /// Set to `Some` only after a successful spawn — guards `stop()` log entry.
    session_log_path: Option<std::path::PathBuf>,
    /// Env marker of the spawned in-container process; lets `stop()` reap
    /// exactly this one, not other CLI/UI sessions sharing the container.
    instance_id: Option<String>,
    /// Set by `stop()` so the reader thread stays silent on a deliberate EOF
    /// instead of reporting a crash. Reset on each fresh spawn.
    stopping: Arc<std::sync::atomic::AtomicBool>,
    /// Set when the just-sent message was control-shaped and still expects
    /// its paired synthetic assistant confirmation (model `"<synthetic>"`) to
    /// arrive and be suppressed exactly once. Consumed by the reader thread,
    /// which copies-and-resets it into the local `StreamParser`.
    pending_synthetic_confirmation_suppression: Arc<std::sync::atomic::AtomicBool>,
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
            instance_id: None,
            stopping: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            pending_synthetic_confirmation_suppression: Arc::new(
                std::sync::atomic::AtomicBool::new(false),
            ),
        }
    }

    /// Read-only owning project name — the retry command reconstructs an empty
    /// `ChatSession` from it after stopping the old one.
    pub fn project_name(&self) -> &str {
        &self.project_name
    }

    /// Build the argv + container name for a spawn; `resume_session_id` adds
    /// `--resume`, `resume_at_uuid` adds `--resume-session-at` (ADR-046).
    pub fn prepare_args(
        project_name: &str,
        user_config: &config::SpeedwaveUserConfig,
        instance_id: &str,
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

        let args = build_claude_args(
            instance_id,
            resume_session_id,
            resume_at_uuid,
            &resolved.flags,
        );
        let container = claude_container_name(project_name);

        Ok((args, container))
    }

    /// Start Claude Code in stream-json mode, spawning a stdout reader thread
    /// that emits `chat_stream`. Precondition: container health already verified.
    pub fn start(
        &mut self,
        app_handle: AppHandle,
        resume_session_id: Option<&str>,
    ) -> anyhow::Result<()> {
        self.start_with_retry(app_handle, resume_session_id, None)
    }

    /// Start (or resume+retry) a session. `resume_at_uuid` rewinds to that
    /// user-message UUID (ADR-046) and MUST pair with `resume_session_id`.
    pub fn start_with_retry(
        &mut self,
        app_handle: AppHandle,
        resume_session_id: Option<&str>,
        resume_at_uuid: Option<&str>,
    ) -> anyhow::Result<()> {
        let rt = runtime::detect_runtime();
        let user_config = config::load_user_config()?;

        // Reap a prior leaked process for this session before spawning a new one.
        self.reap_instance();

        let instance_id = speedwave_runtime::session::new_instance_id();
        let (args, container) = Self::prepare_args(
            &self.project_name,
            &user_config,
            &instance_id,
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

        // Record the marker only after a confirmed spawn (no id for a missing
        // process); fresh spawn means this reader must report real EOFs.
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

        // Best-effort session log init — errors here do NOT kill the session
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

        // Spawn stderr reader to log errors (avoids pipe buffer deadlock);
        // each reader opens its own O_APPEND handle to the session log.
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
        let stdin_for_reader = shared_stdin;
        let stdout_log_path = session_log_path;
        let stopping_for_reader = self.stopping.clone();
        let pending_synthetic_confirmation_suppression_for_reader =
            self.pending_synthetic_confirmation_suppression.clone();

        // On resume: seed cumulative session state from the transcript so the
        // first turn reports a real delta. Non-fatal — log and use a zero baseline.
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
                    seed.context_usage,
                );
            }
            let mut log_file = stdout_log_path
                .as_deref()
                .and_then(speedwave_runtime::log_file::open_log_file);
            let reader = BufReader::new(stdout);
            let mut got_result = false;
            let mut http_collator = speedwave_runtime::http_debug_collator::Collator::new();
            for line in reader.lines() {
                let line = match line {
                    Ok(l) => l,
                    Err(e) => {
                        log::warn!("stdout reader I/O error: {e}");
                        break;
                    }
                };

                // Parse JSON once; non-JSON lines are collated by `http_collator`.
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

                // 1. Check for control_request
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
                                    },
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
                        );
                    } else {
                        // Auto-approve non-AskUserQuestion tools
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
                                        },
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
                                        },
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
                                    },
                                );
                                break;
                            }
                        }
                    }
                    continue;
                }

                // Undecodable control_request: surface the likely stall, no wire response.
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

                // 2. Normal stream events
                if pending_synthetic_confirmation_suppression_for_reader
                    .swap(false, std::sync::atomic::Ordering::SeqCst)
                {
                    parser.arm_synthetic_confirmation_suppression();
                }
                let (chunks, log_entry) = parser.parse_line(&parsed);
                if let Some(entry) = log_entry {
                    speedwave_runtime::log_file::write_log_line(
                        &mut log_file,
                        entry.prefix,
                        &entry.message,
                    );
                    // On stream-protocol markers, flush pending debug response fragments.
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
                // Track terminal events to emit a fallback error on unexpected EOF.
                let is_terminal = chunks
                    .iter()
                    .any(|c| matches!(c, StreamChunk::Result { .. } | StreamChunk::Error { .. }));
                // Capture session_id from a Result chunk before the emit loop consumes `chunks`.
                let result_session_id = chunks.iter().find_map(|c| match c {
                    StreamChunk::Result { session_id, .. } => Some(session_id.clone()),
                    _ => None,
                });
                if is_terminal || msg_type == "system" {
                    got_result = true;
                    // Clear per-turn state (interrupts emit Result with no message_stop).
                    parser.reset();
                }
                for chunk in chunks {
                    emit_sanitized_chunk(&app_handle, chunk);
                }
                // ADR-045 drain: after Result chunks emit, write any queued message to stdin.
                if let Some(session_id) = result_session_id {
                    drain_queued_message(&app_handle, &session_id, &stdin_for_reader);
                }
            }

            if let Some(entry) = http_collator.flush() {
                speedwave_runtime::log_file::write_log_line(&mut log_file, "STDOUT", &entry);
            }

            // EOF without a result: surface a crash — but not when `stop()` tore
            // this session down deliberately (that EOF is ours, not a crash).
            let stopping = stopping_for_reader.load(std::sync::atomic::Ordering::SeqCst);
            if !got_result && !stopping {
                log::warn!("stdout reader stream ended without result");
                let chunk = StreamChunk::Error {
                    content:
                        "Claude session ended unexpectedly. Check the session log for details."
                            .to_string(),
                };
                emit_sanitized_chunk(&app_handle, chunk);
            }
        });
        self.drain_handles.push(h);

        self.child = Some(child);
        Ok(())
    }

    /// Send a user message to Claude (write JSON to stdin) in stream-json input
    /// format. Errors if the subprocess has exited (broken pipe). A
    /// control-shaped message (`/model <id>`, `/effort <level>`) additionally
    /// emits a `ControlChip` chunk and arms the reader thread's one-shot
    /// suppression of the paired synthetic confirmation — the wire carries no
    /// user-echo event to detect this from, so the send path (which already
    /// knows the outgoing text) is the only place this can happen.
    pub fn send_message(
        &mut self,
        app_handle: &tauri::AppHandle,
        blocks: &[WireContentBlock],
    ) -> anyhow::Result<()> {
        self.send_message_with_emit(blocks, |chunk| emit_sanitized_chunk(app_handle, chunk))
    }

    fn send_message_with_emit(
        &mut self,
        blocks: &[WireContentBlock],
        mut emit: impl FnMut(StreamChunk),
    ) -> anyhow::Result<()> {
        // Drop a bare `/` or blank before stdin — never reaches Claude.
        if is_blank_or_slash_only(blocks) {
            anyhow::bail!("empty message");
        }

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
        let input = build_user_message(blocks);
        let serialized = input.to_string();
        if serialized.len() > MAX_WIRE_BYTES {
            anyhow::bail!(
                "user message too large: {} bytes exceeds {} byte limit",
                serialized.len(),
                MAX_WIRE_BYTES
            );
        }

        let joined: String = blocks
            .iter()
            .map(|WireContentBlock::Text { text }| text.as_str())
            .collect();
        if let Some((command, argument)) = speedwave_runtime::slash::parse_control_command(&joined)
        {
            self.pending_synthetic_confirmation_suppression
                .store(true, std::sync::atomic::Ordering::SeqCst);
            emit(StreamChunk::ControlChip {
                command: command.to_string(),
                argument: argument.to_string(),
                uuid: None,
            });
        }

        log::info!(
            "sending user message: serialized={} bytes, blocks={}",
            serialized.len(),
            blocks.len()
        );
        let mut stdin = shared
            .lock()
            .map_err(|e| anyhow::anyhow!("stdin lock poisoned: {e}"))?;
        writeln!(stdin, "{}", serialized)?;
        stdin.flush()?;
        Ok(())
    }

    /// Test-only stdin stand-in: wraps a real OS pipe write-end as a
    /// `ChildStdin` and a trivial blocked child as `self.child`, so
    /// `send_message_with_emit`'s liveness/stdin guards pass without a real
    /// spawned Claude session. `buf` seeds a background drain thread that
    /// reads everything written to the pipe (kept open for the pipe's life).
    #[cfg(test)]
    fn set_test_stdin_sink(&mut self, buf: Vec<u8>) {
        let (mut reader, writer) = std::io::pipe().expect("create test stdin pipe");
        #[cfg(unix)]
        let stdin: std::process::ChildStdin = {
            let fd: std::os::fd::OwnedFd = writer.into();
            fd.into()
        };
        #[cfg(windows)]
        let stdin: std::process::ChildStdin = {
            let handle: std::os::windows::io::OwnedHandle = writer.into();
            handle.into()
        };
        std::thread::spawn(move || {
            let mut drained = buf;
            let _ = std::io::Read::read_to_end(&mut reader, &mut drained);
        });
        self.shared_stdin = Some(Arc::new(Mutex::new(stdin)));
        self.child = Some(spawn_test_blocked_child());
    }

    /// Record one slot's answer; once every slot is filled, write a single
    /// `control_response` to stdin. Post-fill errors clear the slot for retry.
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

    /// Apply one answer to the pending entry. Validation errors restore the
    /// entry so a later retry with a valid index/value still works.
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

    /// Best-effort re-insert of a `PartialAnswers` after a failure (logs on
    /// poison); `cleared_idx` reverts that slot to `None` for re-submission.
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

    /// Cancel the current turn without killing the session: writes a
    /// `subtype: "interrupt"` control_request; Claude aborts but stays ready.
    pub fn interrupt(&mut self) -> anyhow::Result<()> {
        // Detect an already-exited child for a clean "session exited"/OOM error.
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

    /// Kill the orphaned in-container process for `self.instance_id` (host kill
    /// doesn't propagate). Best-effort; no-op (no runtime detected) without an id.
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

    /// Stop the Claude subprocess entirely (session end, not turn cancel).
    pub fn stop(&mut self) -> anyhow::Result<()> {
        // Mark deliberate teardown before EOF so the reader stays silent.
        self.stopping
            .store(true, std::sync::atomic::Ordering::SeqCst);
        // Drop stdin first to signal EOF to the child
        self.shared_stdin = None;
        // Reap the orphaned in-container process; self-disarms (no-op) without an id.
        self.reap_instance();
        if let Some(mut child) = self.child.take() {
            child.kill().ok();
            // Wait up to 5 s for exit, then abandon it (OS reaps).
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
        // Join finished reader threads; detach the rest after a grace window so `is_finished` can flip.
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
                // Pipe wedged — detach so `stop()` returns in bounded time.
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
        // Log session end ONLY if session actually started
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

/// Thread-safe wrapper for ChatSession, to be used from Tauri commands.
pub type SharedChatSession = Arc<Mutex<ChatSession>>;

/// Drain any queued message for `session_id` (ADR-045) and write it to `stdin`
/// as the next turn (on a `Result` chunk). Best-effort: failures are logged.
fn drain_queued_message(
    app_handle: &AppHandle,
    session_id: &str,
    stdin: &Arc<Mutex<std::process::ChildStdin>>,
) {
    let queue = app_handle.state::<speedwave_runtime::session::QueuedMessageService>();
    let drained = match queue.take(session_id) {
        Some(m) => m,
        None => return,
    };
    // Queue is text-only (ADR-065).
    let payload = build_user_message(&text_only(&drained.text));
    match stdin.lock() {
        Ok(mut handle) => {
            if let Err(e) = writeln!(handle, "{}", payload) {
                log::warn!("failed to write queued message to stdin: {e}");
                return;
            }
            if let Err(e) = handle.flush() {
                log::warn!("failed to flush queued message to stdin: {e}");
                return;
            }
        }
        Err(e) => {
            log::warn!("stdin lock poisoned while draining queued message: {e}");
            return;
        }
    }
    let drained_text = drained.text.clone();
    emit_sanitized_chunk(
        app_handle,
        StreamChunk::QueueDrained {
            session_id: session_id.to_string(),
            text: drained.text,
        },
    );
    log::debug!("queue drained: {} bytes for session", drained_text.len());
}

/// Spawns a trivial child that blocks reading its own stdin until killed, so
/// `ChatSession::set_test_stdin_sink` can populate `self.child` with a real,
/// live `Child` (test-only — never a Claude session).
#[cfg(test)]
fn spawn_test_blocked_child() -> Child {
    #[cfg(unix)]
    let mut command = {
        let mut c = std::process::Command::new("sh");
        c.arg("-c").arg("read line");
        c
    };
    #[cfg(windows)]
    let mut command = {
        let mut c = std::process::Command::new("cmd");
        c.args(["/C", "pause"]);
        c
    };
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn test blocked child")
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "test assertions may unwrap/expect freely"
)]
mod tests {
    use super::*;

    // -- sanitize_chunk: secrets must not reach the UI on any chunk channel --

    /// Enforcement: the ONLY `emit("chat_stream", ...)` in production source is
    /// inside emit_sanitized_chunk. A new raw emit elsewhere would leak.
    #[test]
    fn chat_stream_emits_go_through_helper() {
        let src = include_str!("chat.rs");
        // Strip the test module so test-only emits don't count.
        let prod = src.split("\nmod tests {").next().unwrap_or(src);
        // Count actual emit calls, ignoring doc/comment lines.
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
        // result_text reaches the UI only via chat_stream — sanitize covers it.
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
        // partial_json is incremental JSON — sanitizing could corrupt structure.
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
    fn send_message_rejects_bare_slash_before_session_check() {
        // The bare-slash guard runs before the active-session check: with no
        // child the error is "empty message", proving it never reaches stdin.
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
        // Real text passes the guard and hits the no-active-session error.
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
    fn send_message_matching_control_shape_emits_control_chip_before_stdin() {
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
        assert!(session
            .pending_synthetic_confirmation_suppression
            .load(std::sync::atomic::Ordering::SeqCst));
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
        assert!(!session
            .pending_synthetic_confirmation_suppression
            .load(std::sync::atomic::Ordering::SeqCst));
    }

    #[test]
    fn send_message_bare_model_without_argument_emits_no_control_chip() {
        // Bare "/model" (no argument) shows current model - CC's own reply, not
        // a switch - and must go to stdin as plain text, not a chip.
        let mut session = ChatSession::new("proj");
        let mut emitted: Vec<StreamChunk> = Vec::new();
        session.set_test_stdin_sink(Vec::new());
        session
            .send_message_with_emit(&text_only("/model"), |chunk| emitted.push(chunk))
            .unwrap();
        assert!(emitted.is_empty());
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

    // -- reap_instance targeting --

    #[test]
    fn reap_exec_plan_targets_project_container_with_marker() {
        let (container, argv) = reap_exec_plan("acme", "inst-123");
        assert!(
            container.ends_with("_acme_claude"),
            "must target the project's claude container, got: {container}"
        );
        // The kill command carries the exact instance marker so only this
        // session's in-container process is reaped.
        let joined = argv.join(" ");
        assert!(joined.contains("SPW_SESSION_INSTANCE_ID=inst-123"));
        assert!(joined.contains("kill"));
    }

    #[test]
    fn reap_instance_is_noop_without_an_id() {
        // No spawn happened → no marker → reap takes nothing and never touches a
        // runtime (would otherwise panic in a unit-test environment).
        let mut s = ChatSession::new("test-project");
        assert!(s.instance_id.is_none());
        s.reap_instance();
        assert!(s.instance_id.is_none());
    }

    // -- EOF-error gating (cross-session error-emission race) --

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
        // Regression: a reader finishing after ~50 ms (below the 200 ms grace)
        // must be joined by `stop()`, not classified as "still running".
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
        // A wedged reader's grace window must stay bounded; simulate one by
        // sleeping longer than the window.
        let mut s = ChatSession::new("test-project");
        s.drain_handles.push(std::thread::spawn(|| {
            std::thread::sleep(std::time::Duration::from_secs(10));
        }));
        let start = std::time::Instant::now();
        assert!(s.stop().is_ok());
        let elapsed = start.elapsed();
        assert!(s.drain_handles.is_empty(), "handle must be drained");
        // Upper bound: 200 ms grace window; 1000 ms allows CI jitter while
        // catching a regression to an unbounded join.
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

    /// Convenience: parse a JSON string and return the first StreamChunk
    /// (for single-chunk test assertions).
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

    // ── Unknown stream-json types ────────────────────────────────────

    #[test]
    fn parse_line_logs_unknown_type_once_per_session() {
        let mut parser = StreamParser::new();
        let line = r#"{"type":"compaction_event","data":{}}"#;
        let (chunks, log) = parse_line_full(&mut parser, line);
        assert!(chunks.is_none(), "unknown type must emit no chunk");
        let log = log.expect("first occurrence must produce a log entry");
        assert_eq!(log.prefix, "STREAM");
        assert!(log.message.contains("compaction_event"));
        // Second occurrence: silent (dedup), still no chunk.
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
        // Past the cap: dropped without logging (and without growing the set).
        let parsed: serde_json::Value = serde_json::from_str(r#"{"type":"overflow"}"#).unwrap();
        assert!(parser.parse_line(&parsed).1.is_none());
    }

    #[test]
    fn control_request_with_unknown_shape_returns_none() {
        // A future subtype without tool_name/tool_use_id must not parse into a
        // ControlRequest (the reader loop logs it instead of auto-approving).
        let line =
            r#"{"type":"control_request","request_id":"r1","request":{"subtype":"hook_callback"}}"#;
        assert!(try_parse_control_request_str(line).is_none());
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

    // ── blank / bare-slash guard ─────────────────────────────────────

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
        // A real slash command (slash + name) must still be sendable.
        assert!(!is_blank_or_slash_only(&text_only("/code-review")));
        assert!(!is_blank_or_slash_only(&text_only("/clear")));
    }

    #[test]
    fn is_blank_or_slash_only_accepts_normal_text() {
        assert!(!is_blank_or_slash_only(&text_only("hej")));
        assert!(!is_blank_or_slash_only(&text_only("what is 2/3?")));
    }

    // ── send_message JSON format ─────────────────────────────────────

    #[test]
    fn build_user_message_produces_correct_json_structure() {
        let msg = build_user_message(&text_only("test msg"));

        assert_eq!(msg["type"], "user");
        assert_eq!(msg["message"]["role"], "user");
        // No `parent_tool_use_id` on user-input envelope — that field is
        // an output-side correlation tag for tool_use, never appears here.
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
        // ADR-065: pastes go to `<project>/.speedwave/pastes/` with an inlined
        // `@…` ref; the wire is text-only.
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
        // Contract snapshot pinning the text-only wire shape (ADR-065); trips
        // on inline image blocks, `media_type`→`mimeType`, or `parent_tool_use_id`.
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
        // Defence-in-depth: ensure no `image` block ever appears in this
        // snapshot — that path is gone for good.
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
        // ADR-065: the cap is sized for text + paste-path refs only.
        assert_eq!(MAX_WIRE_BYTES, 1024 * 1024);
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

    /// Regression: an interrupted turn emits `result` without `message_stop`,
    /// so the stdout-reader calls `parser.reset()` after every terminal chunk.
    #[test]
    fn reset_after_result_prevents_stale_tool_contamination() {
        let mut parser = StreamParser::new();

        // Turn 1: a tool starts at index 0 and receives a partial input delta.
        let start = r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_OLD","name":"Read","input":{}}}}"#;
        parse_line_str(&mut parser, start);
        assert!(parser.active_blocks.contains_key(&0));

        // Simulate the reader's `reset()` after `result` (parse_line does not).
        let result = r#"{"type":"result","subtype":"error_during_execution","session_id":"s","total_cost_usd":0.0,"usage":{}}"#;
        parse_line_str(&mut parser, result);
        parser.reset();

        assert!(parser.active_blocks.is_empty());
        assert!(parser.tool_input.is_empty());

        // Turn 2 reuses index 0; without the reset above, the input delta
        // would route to the OLD tool_id.
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
    fn parse_user_multiple_tool_results_emit_one_chunk_each() {
        // Parallel batches pack several tool_result blocks into one user line;
        // an early return would leave later tools stuck as "running".
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
        // A block without tool_use_id is dropped; the valid sibling still emits.
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

    // The parser reads `total_cost_usd` (current) / `total_cost` (legacy);
    // this guards against re-adding the dead `cost_usd` alias.
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
    fn parse_result_picks_dominant_model_when_modelusage_has_multiple_keys() {
        // Regression: a turn mixing a main model with background Haiku calls
        // must report the model with the highest outputTokens.
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
                    "must pick the model with the highest outputTokens, not the alphabetically first key"
                );
                assert_eq!(
                    context_window_size,
                    Some(1_000_000),
                    "context_window_size must come from the same dominant model — picking Haiku's 200k here would misreport the cap for 1M sessions"
                );
            }
            other => panic!("expected Result, got {other:?}"),
        }
    }

    #[test]
    fn parse_result_chronological_model_wins_over_usage_dominant_old_model() {
        // Regression: a mid-session /model switch to B produces little B usage
        // next to a lot of accumulated A usage. Chronological last-observed
        // model (B) must win — usage-dominance would wrongly report A.
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
    fn parse_line_assistant_model_feeds_result_without_modelusage() {
        // Only `capture_assistant_model` (via parse_line's "assistant" arm) can
        // seed the tracker here: no preceding system init in this transcript.
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
        // A subagent (sidechain) turn commonly runs a cheaper model (e.g.
        // haiku); it must not overwrite the main-chain session model or
        // its context window.
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
    fn synthetic_confirmation_following_a_chip_is_suppressed_once() {
        let mut parser = StreamParser::new();
        parser.arm_pending_synthetic_confirmation_suppression();

        let synthetic_line = r#"{"type":"assistant","message":{"id":"u_synth_1","role":"assistant","model":"<synthetic>","content":[{"type":"text","text":"Set model to claude-sonnet-5"}]}}"#;
        let synthetic_chunks = parse_line_all_str(&mut parser, synthetic_line);
        assert!(
            synthetic_chunks.is_empty(),
            "the paired synthetic confirmation must produce no chunk, got {synthetic_chunks:?}"
        );
        assert!(
            !parser.pending_synthetic_confirmation_suppression,
            "the flag must be consumed by the matching synthetic line"
        );

        // A second, later synthetic-model assistant line (unrelated to any chip,
        // flag already consumed) must NOT stay suppressed - the flag is one-shot.
        let unrelated_synthetic = r#"{"type":"assistant","message":{"id":"u_synth_2","role":"assistant","model":"<synthetic>","content":[{"type":"text","text":"unrelated"}]}}"#;
        let unrelated_chunks = parse_line_all_str(&mut parser, unrelated_synthetic);
        assert!(
            unrelated_chunks.is_empty(),
            "raw assistant lines never emit chunks directly regardless of suppression state - this is the pre-existing behavior, not evidence of suppression"
        );
    }

    #[test]
    fn suppression_clears_on_system_init_to_avoid_leaking_across_turns() {
        let mut parser = StreamParser::new();
        parser.arm_pending_synthetic_confirmation_suppression();

        let init_line = serde_json::json!({
            "type": "system",
            "subtype": "init",
            "session_id": "sess-1",
            "model": "claude-sonnet-5",
        });
        parser.parse_system_message(&init_line);

        assert!(
            !parser.pending_synthetic_confirmation_suppression,
            "a fresh system/init must clear a stale suppression flag, never let it leak into the next turn"
        );
    }

    #[test]
    fn suppression_clears_on_non_synthetic_assistant_line_without_suppressing_it() {
        let mut parser = StreamParser::new();
        parser.arm_pending_synthetic_confirmation_suppression();

        let real_line = r#"{"type":"assistant","message":{"id":"u_real","role":"assistant","model":"claude-sonnet-5","content":[{"type":"text","text":"real reply"}]}}"#;
        parse_line_all_str(&mut parser, real_line);

        assert!(
            !parser.pending_synthetic_confirmation_suppression,
            "the flag must not leak past the next assistant line even when it wasn't the synthetic confirmation"
        );
    }

    #[test]
    fn synthetic_assistant_message_with_no_armed_suppression_is_unaffected() {
        let mut parser = StreamParser::new();
        let line = r#"{"type":"assistant","message":{"id":"u_synth_3","role":"assistant","model":"<synthetic>","content":[{"type":"text","text":"some other synthetic text"}]}}"#;
        let chunks = parse_line_all_str(&mut parser, line);
        assert!(
            chunks.is_empty(),
            "raw assistant lines never emit chunks directly regardless of suppression state"
        );
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
        // Regression guard: `is_error=true` with empty `result` now surfaces a
        // placeholder Error chunk instead of being swallowed.
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
        // Assistant messages emit no chunks (content streams via deltas; the
        // Result carries the UUID); a missing `message.id` is ignored.
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
        // The pending assistant UUID commits onto the Result (ADR-046) and is
        // cleared for the next turn.
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
        // An error turn also takes the pending UUID so a later success without
        // its own `assistant` event isn't mislabeled.
        let mut parser = StreamParser::new();
        let assistant =
            r#"{"type":"assistant","message":{"id":"msg_err","role":"assistant","content":[]}}"#;
        let error_result = r#"{"type":"result","is_error":true,"result":"something broke"}"#;
        parse_line_str(&mut parser, assistant);
        let chunk = parse_line_str(&mut parser, error_result).unwrap();
        assert!(matches!(chunk, StreamChunk::Error { .. }));
        // parse_result `.take()`s the uuid up-front, so an error turn consumes
        // it — no leak onto the next turn, without relying on reset().
        assert!(parser.pending_assistant_uuid.is_none());
    }

    #[test]
    fn assistant_uuid_survives_message_stop_before_result() {
        // Local-LLM order: assistant → message_stop → result. message_stop's
        // reset() must NOT drop the uuid the result needs (footer reconcile).
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
        // Mixed content: a text block alongside a tool_result wrapper MUST NOT
        // trigger a UserMessageCommit.
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
        // Across a turn boundary (reset), a committed user UUID must stay in
        // the dedup set so a re-echoed prompt isn't re-committed.
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
        // ADR-045: the first-turn queue needs the session id even when the
        // init line lacks a model.
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
            StreamChunk::Error { content } => assert!(content.contains("hit your limit")),
            other => panic!("expected Error, got {other:?}"),
        }
    }

    #[test]
    fn stream_chunk_system_init_round_trips() {
        // No session id → field omitted (wire shape unchanged for old events).
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

        // With session id → serialized for the frontend (ADR-045 first-turn queue).
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

    #[test]
    fn parse_rate_limit_event_extracts_fields() {
        // Real 2.1.173 wire shape: reset timestamp is camelCase `resetsAt`
        // (drives the footer countdown).
        let mut parser = StreamParser::new();
        let line = r#"{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","utilization":73.5,"resetsAt":1738425600}}"#;
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
    fn parse_rate_limit_event_accepts_legacy_snake_case_resets_at() {
        // Older builds emitted snake_case `resets_at`; the parser keeps a fallback.
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
        let line = r#"{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","utilization":100.0,"resetsAt":1738430000}}"#;
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
        // Use the `_with_prefix` variant with the fixed `COMPOSE_PREFIX` literal
        // so the test does not depend on the process-global `data_dir()` basename.
        let name = claude_container_name_with_prefix(consts::COMPOSE_PREFIX, "myproject");
        assert_eq!(name, format!("{}_myproject_claude", consts::COMPOSE_PREFIX));
    }

    #[test]
    fn claude_container_name_format_is_prefix_project_claude() {
        let name = claude_container_name_with_prefix(consts::COMPOSE_PREFIX, "acme-corp");
        assert_eq!(name, "speedwave_acme-corp_claude");
    }

    // ── build_claude_args ────────────────────────────────────────────

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
        // ADR-046: retry uses `--resume <session>` + `--resume-session-at <uuid>`.
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
        // The instance marker is injected via `env VAR=id` BEFORE the claude
        // binary so it lands in the container process's environ.
        let args = build_claude_args("my-instance-42", None, None, &[]);
        assert_eq!(args[0], "env");
        assert_eq!(args[1], "SPW_SESSION_INSTANCE_ID=my-instance-42");
        // claude binary follows the env prefix.
        assert_eq!(args[2], consts::CLAUDE_BINARY);
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

        // Expected: Text×2, Thinking×2, ToolStart, ToolInputDelta×2,
        // ToolResult, Text, Result (10 chunks; per-chunk asserts below).
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
        // Two slots share question text; the host refuses the lossy payload
        // and surfaces an error.
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
        // Without an active child, submit_question_answer must fail with
        // "no active session" before mutating state.
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
        // The pending entry must NOT be mutated by a no-session error.
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
        // Build a 4-question payload whose serialized wire response exceeds
        // 64 KiB to exercise the wire-cap guard.
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
        // E was truncated; we don't assert log capture here (covered by integration).
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
        // Default value falls back to label when missing.
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

    // ── Control request fixture test ────────────────────────────────

    // ── prepare_args tests ──────────────────────────────────────────

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
            }],
            active_project: None,
            selected_ide: None,
            ui: None,
            telemetry: None,
        };
        let result = ChatSession::prepare_args("myproject", &user_config, "inst", None, None);
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
            ui: None,
            telemetry: None,
        };
        let session_id = "550e8400-e29b-41d4-a716-446655440000";
        let result =
            ChatSession::prepare_args("proj", &user_config, "my-inst", Some(session_id), None);
        assert!(result.is_ok());
        let (args, _container) = result.unwrap();
        // The instance marker is stamped ahead of the claude binary.
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

    // ── context_usage (last main-chain API call) tests ──────────────

    /// Assistant stream-json line with the given per-call usage numbers.
    fn assistant_line(input: u64, cr: u64, cw: u64, out: u64, parent: Option<&str>) -> String {
        let parent = parent.map_or("null".to_string(), |p| format!("\"{p}\""));
        format!(
            r#"{{"type":"assistant","parent_tool_use_id":{parent},"message":{{"id":"msg_1","role":"assistant","usage":{{"input_tokens":{input},"cache_read_input_tokens":{cr},"cache_creation_input_tokens":{cw},"output_tokens":{out}}}}}}}"#
        )
    }

    const RESULT_LINE: &str = r#"{"type":"result","session_id":"s","is_error":false,"result":"","total_cost_usd":0.01,"usage":{"input_tokens":10,"output_tokens":20}}"#;

    #[test]
    fn result_carries_last_assistant_call_usage_not_the_turn_sum() {
        // Three API calls in one turn: summed cache_read (110k+120k+130k)
        // would overflow any window; context_usage must be the LAST call only.
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
        // Subagent call with a huge foreign context must be ignored.
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

    // ── is_sidechain_event: shared heuristic (chat.rs live stream + history.rs transcript) ──

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
        // Malformed/unexpected type on isSidechain must not be treated as truthy.
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
        // Turn 1: no API call (e.g. local slash command) — nothing to report.
        match parse_line_str(&mut parser, RESULT_LINE).unwrap() {
            StreamChunk::Result { context_usage, .. } => assert!(context_usage.is_none()),
            other => panic!("expected Result, got {other:?}"),
        }
        // Turn 2: a real call; turn 3 has no call and must keep turn 2's value.
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

    // ── turn_usage_from_jsonl (JSONL usage SSOT) ────────────────────

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
        // Non-u64 values (string, negative, float, null) read as 0, not an error.
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
        // Simulate mid-session resume: restore the snapshot, then verify the
        // next Result's delta is against the baseline, not zero.
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
            None,
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
        // Defensive: a cumulative cost below the previous snapshot drops
        // `turn_cost` instead of reporting a negative value.
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
        // Resume path: seed like `compute_resume_snapshot`, then assert the
        // first result is the per-turn delta, not the cumulative.
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
