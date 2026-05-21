//! Collapses + summarises multi-line `ANTHROPIC_LOG=debug` blocks emitted by
//! Claude Code into single, human-readable log entries.
//!
//! Claude Code's HTTP debug logging is a known Anthropic bug — `console.log`
//! sends `util.inspect()` pretty-printed JS objects to stdout instead of
//! stderr (anthropics/claude-agent-sdk-typescript#157, anthropics/claude-code
//! #4859). Each HTTP transaction spans 60–80 physical lines that would
//! otherwise spam the System Health UI with one event per line.
//!
//! Three stages:
//!   1. [`Collator`] groups continuation lines into one logical block (any
//!      line ending in `{` opens a block, the matching outer `}` closes it).
//!   2. [`format_block`] extracts the fields that matter (method, URL,
//!      status, model, duration, counts) and produces a 1–2 line summary.
//!   3. Response fragments from the same `[log_id]` (Claude SDK emits three
//!      separate blocks per response: `response start`, `response NNN Headers`,
//!      `response parsed`) are merged into a single line per HTTP transaction.
//!
//! Unknown formats pass through verbatim — never lose information.

use std::collections::HashMap;
use std::sync::LazyLock;

use regex::Regex;

/// Upper bound on buffered continuation lines for one unclosed block.
/// Reached only on malformed input (mismatched braces); guards against an
/// unbounded `Vec<String>` if a future SDK emits broken output.
const MAX_BUFFERED_LINES: usize = 10_000;

/// Upper bound on response fragments pending merge. Reached only on
/// pathological streams where the terminator never arrives (interrupted
/// session, fragments with unseen ids). Evicts oldest on overflow.
const MAX_PENDING_RESPONSES: usize = 256;

/// State machine that joins multi-line HTTP debug blocks into single entries
/// and merges per-`log_id` response fragments into a single line.
#[derive(Default)]
pub struct Collator {
    buffer: Vec<String>,
    depth: i32,
    /// Pending response fragments keyed by `log_id`.
    pending_responses: HashMap<String, ResponseAccumulator>,
    /// Insertion order of `pending_responses` keys, so overflow eviction
    /// drops the oldest entry deterministically.
    pending_order: std::collections::VecDeque<String>,
}

/// Mutable accumulator for the fields harvested from `response …` blocks
/// belonging to one HTTP transaction.
#[derive(Default, Debug, Clone)]
struct ResponseAccumulator {
    status: Option<String>,
    url: Option<String>,
    content_type: Option<String>,
    server: Option<String>,
    duration_ms: Option<String>,
}

impl ResponseAccumulator {
    fn merge(&mut self, fields: ResponseFields) {
        if self.status.is_none() {
            self.status = fields.status;
        }
        if self.url.is_none() {
            self.url = fields.url;
        }
        if self.content_type.is_none() {
            self.content_type = fields.content_type;
        }
        if self.server.is_none() {
            self.server = fields.server;
        }
        if self.duration_ms.is_none() {
            self.duration_ms = fields.duration_ms;
        }
    }

    fn render(&self, log_id: &str) -> String {
        let status = self.status.as_deref().unwrap_or("?");
        let url = self.url.as_deref().unwrap_or("?");
        let mut parts = Vec::new();
        if let Some(ct) = &self.content_type {
            parts.push(ct.clone());
        }
        if let Some(srv) = &self.server {
            parts.push(format!("from {srv}"));
        }
        if let Some(d) = &self.duration_ms {
            parts.push(format!("in {d}ms"));
        }
        if parts.is_empty() {
            format!("← {status} {url}  [log_{log_id}]")
        } else {
            format!("← {status} {url} ({})  [log_{log_id}]", parts.join(", "))
        }
    }
}

impl Collator {
    pub fn new() -> Self {
        Self::default()
    }

    /// Push one raw stdout line. Returns completed entries ready to log,
    /// each already summarised and merged.
    pub fn push(&mut self, line: String) -> Vec<String> {
        let delta = brace_delta(&line);

        if self.buffer.is_empty() {
            if delta > 0 {
                self.buffer.push(line);
                self.depth = delta;
                return Vec::new();
            }
            return self.handle_complete_line(line);
        }

        self.buffer.push(line);
        self.depth += delta;
        if self.depth > 0 {
            if self.buffer.len() >= MAX_BUFFERED_LINES {
                // Malformed input — release buffered content verbatim and reset
                // so the collator does not grow unbounded.
                let joined = self.drain_buffer().unwrap_or_default();
                self.depth = 0;
                return vec![joined];
            }
            return Vec::new();
        }
        self.depth = 0;
        let joined = match self.drain_buffer() {
            Some(s) => s,
            None => return Vec::new(),
        };
        self.handle_complete_line(joined)
    }

    /// Drain any pending buffered block AND every still-unflushed response
    /// accumulator. Call on EOF, or whenever the caller knows all in-flight
    /// HTTP transactions have ended (e.g. on Claude Code's `RESULT:` line).
    pub fn flush(&mut self) -> Option<String> {
        let block = self.drain_buffer();
        let mut tail = Vec::new();
        if let Some(b) = block {
            tail.extend(self.handle_complete_line(b));
        }
        tail.extend(self.flush_all_pending_responses());
        if tail.is_empty() {
            None
        } else {
            Some(tail.join("\n"))
        }
    }

    /// Emit a merged summary line for every pending response and clear them.
    /// Exposed so the stdout reader can call this on Claude Code stream
    /// markers (`RESULT:`, `SYSTEM:`, `SESSION:`, `RATE_LIMIT:`) that signal
    /// in-flight HTTP transactions are done.
    pub fn flush_all_pending_responses(&mut self) -> Vec<String> {
        let order: Vec<String> = self.pending_order.drain(..).collect();
        order
            .into_iter()
            .filter_map(|id| {
                let acc = self.pending_responses.remove(&id)?;
                Some(acc.render(&id))
            })
            .collect()
    }

    fn handle_complete_line(&mut self, line: String) -> Vec<String> {
        let mut out = Vec::new();

        if let Some(fields) = parse_response_fragment(&line) {
            let log_id = fields.log_id.clone();
            self.merge_response_fragment(log_id, fields);
            return out;
        }

        // Same-id sending request flushes any previously-pending response
        // for that id (defensive — the SDK could in theory reuse an id).
        if let Some(id) = extract_log_id(&line) {
            if line.contains("sending request") {
                if let Some(merged) = self.flush_pending_response(&id) {
                    out.push(merged);
                }
            }
        }

        out.push(format_block(&line));
        out
    }

    fn merge_response_fragment(&mut self, log_id: String, fields: ResponseFields) {
        if !self.pending_responses.contains_key(&log_id) {
            if self.pending_responses.len() >= MAX_PENDING_RESPONSES {
                if let Some(oldest) = self.pending_order.pop_front() {
                    self.pending_responses.remove(&oldest);
                }
            }
            self.pending_order.push_back(log_id.clone());
        }
        self.pending_responses
            .entry(log_id)
            .or_default()
            .merge(fields);
    }

    fn flush_pending_response(&mut self, log_id: &str) -> Option<String> {
        let acc = self.pending_responses.remove(log_id)?;
        self.pending_order.retain(|id| id != log_id);
        Some(acc.render(log_id))
    }

    fn drain_buffer(&mut self) -> Option<String> {
        if self.buffer.is_empty() {
            return None;
        }
        let joined = self.buffer.join(" ");
        self.buffer.clear();
        Some(joined)
    }
}

// ---------------------------------------------------------------------------
// Brace depth helper
// ---------------------------------------------------------------------------

/// Net change in brace depth for one line, ignoring braces inside `"…"` strings.
fn brace_delta(line: &str) -> i32 {
    // Fast path — most stdout lines contain no braces at all (memchr-vectorised).
    if !line.as_bytes().iter().any(|&b| b == b'{' || b == b'}') {
        return 0;
    }
    let mut depth: i32 = 0;
    let mut in_string = false;
    let mut escape = false;
    for b in line.bytes() {
        if escape {
            escape = false;
            continue;
        }
        match b {
            b'\\' if in_string => escape = true,
            b'"' => in_string = !in_string,
            b'{' if !in_string => depth += 1,
            b'}' if !in_string => depth -= 1,
            _ => {}
        }
    }
    depth
}

// ---------------------------------------------------------------------------
// Block summariser
// ---------------------------------------------------------------------------

fn re(pat: &str) -> Regex {
    // `.expect()` is forbidden in prod by clippy::expect_used (CLAUDE.md rule);
    // the panic body is the same — these patterns are static, panics surface
    // any malformed regex on first use in tests.
    Regex::new(pat).unwrap_or_else(|e| panic!("static regex must compile: {e}"))
}

static RE_LOG_ID: LazyLock<Regex> = LazyLock::new(|| re(r"\[log_([0-9a-f]+)\]"));
static RE_URL: LazyLock<Regex> = LazyLock::new(|| re(r#"url:\s*"([^"]+)""#));
static RE_METHOD: LazyLock<Regex> = LazyLock::new(|| re(r#"method:\s*"([^"]+)""#));
static RE_STATUS: LazyLock<Regex> = LazyLock::new(|| re(r"status:\s*(\d+)"));
static RE_DURATION: LazyLock<Regex> = LazyLock::new(|| re(r"durationMs:\s*(\d+)"));
static RE_MODEL: LazyLock<Regex> = LazyLock::new(|| re(r#"model:\s*"([^"]+)""#));
static RE_MAX_TOKENS: LazyLock<Regex> = LazyLock::new(|| re(r"max_tokens:\s*(\d+)"));
static RE_STREAM: LazyLock<Regex> = LazyLock::new(|| re(r"stream:\s*(true|false)"));
static RE_CONTENT_TYPE: LazyLock<Regex> = LazyLock::new(|| re(r#""content-type":\s*"([^"]+)""#));
static RE_SERVER: LazyLock<Regex> = LazyLock::new(|| re(r#""server":\s*"([^"]+)""#));
static RE_OBJECT_COUNT: LazyLock<Regex> = LazyLock::new(|| re(r"\[Object \.\.\.\]"));

static RE_POST_SUCCEEDED: LazyLock<Regex> = LazyLock::new(|| {
    re(r"\[log_([0-9a-f]+)\]\s+(\w+)\s+(\S+)\s+succeeded with status (\d+) in (\d+)ms")
});

fn extract_log_id(line: &str) -> Option<String> {
    RE_LOG_ID.captures(line).map(|c| c[1].to_string())
}

/// Fields harvested from one of the three response blocks emitted per HTTP
/// transaction (`response start`, `response NNN Headers`, `response parsed`).
struct ResponseFields {
    log_id: String,
    status: Option<String>,
    url: Option<String>,
    content_type: Option<String>,
    server: Option<String>,
    duration_ms: Option<String>,
}

/// Extract response fields from a joined block if it is one of the response
/// fragments; otherwise `None`.
fn parse_response_fragment(line: &str) -> Option<ResponseFields> {
    let is_response_start = line.contains("response start") || line.contains("response parsed");
    let is_response_headers = line.starts_with("response ") && line.contains("Headers {");

    if !is_response_start && !is_response_headers {
        return None;
    }

    let log_id = if is_response_start {
        extract_log_id(line)?
    } else {
        // The headers block has no `[log_id]` of its own — Claude SDK emits
        // it immediately after `[log_xxx] post … succeeded`. We can't merge
        // it without an id. Skip and let format_block render it standalone.
        return None;
    };

    let url = RE_URL.captures(line).map(|c| c[1].to_string());
    let status = RE_STATUS.captures(line).map(|c| c[1].to_string());
    let duration_ms = RE_DURATION.captures(line).map(|c| c[1].to_string());
    let content_type = RE_CONTENT_TYPE.captures(line).map(|c| c[1].to_string());
    let server = RE_SERVER.captures(line).map(|c| c[1].to_string());

    Some(ResponseFields {
        log_id,
        status,
        url,
        content_type,
        server,
        duration_ms,
    })
}

/// Summarise a joined block. Returns `block` verbatim if the format is
/// unrecognised — we never drop information, only condense what we understand.
pub fn format_block(block: &str) -> String {
    let log_id = extract_log_id(block);

    if block.contains("sending request") {
        return format_request(block, log_id.as_deref());
    }
    if let Some(c) = RE_POST_SUCCEEDED.captures(block) {
        return format!(
            "{} {} → {} in {}ms  [log_{}]",
            &c[2], &c[3], &c[4], &c[5], &c[1]
        );
    }
    if block.starts_with("response ") && block.contains("Headers {") {
        return format_response_full(block);
    }
    // Response start / parsed blocks: emitted before merging — render anyway
    // for the case where the merge never happens (unknown id, EOF, etc.).
    if block.contains("response start") || block.contains("response parsed") {
        return format_response_start(block, log_id.as_deref());
    }

    block.to_string()
}

fn format_request(block: &str, log_id: Option<&str>) -> String {
    let method = RE_METHOD
        .captures(block)
        .map(|c| c[1].to_uppercase())
        .unwrap_or_else(|| "?".into());
    let url = RE_URL
        .captures(block)
        .map(|c| c[1].to_string())
        .unwrap_or_else(|| "?".into());
    let model = RE_MODEL.captures(block).map(|c| c[1].to_string());
    let max_tokens = RE_MAX_TOKENS.captures(block).map(|c| c[1].to_string());
    let stream = RE_STREAM.captures(block).map(|c| c[1].to_string());

    let messages = count_object_placeholders(block, "messages:");
    let system = count_object_placeholders(block, "system:");
    let tools = count_object_placeholders(block, "tools:");

    let mut parts = Vec::new();
    if let Some(m) = model {
        parts.push(format!("model={m}"));
    }
    if let Some(t) = max_tokens {
        parts.push(format!("max_tokens={t}"));
    }
    if let Some(s) = stream {
        parts.push(format!("stream={s}"));
    }
    if messages > 0 {
        parts.push(format!("messages={messages}"));
    }
    if system > 0 {
        parts.push(format!("system={system}"));
    }
    if tools > 0 {
        parts.push(format!("tools={tools}"));
    }
    let tag = log_id.map(|id| format!("  [log_{id}]")).unwrap_or_default();
    format!("→ {method} {url} ({}){tag}", parts.join(", "))
}

fn format_response_start(block: &str, log_id: Option<&str>) -> String {
    let url = RE_URL
        .captures(block)
        .map(|c| c[1].to_string())
        .unwrap_or_else(|| "?".into());
    let status = RE_STATUS
        .captures(block)
        .map(|c| c[1].to_string())
        .unwrap_or_else(|| "?".into());
    let duration = RE_DURATION.captures(block).map(|c| c[1].to_string());
    let content_type = RE_CONTENT_TYPE.captures(block).map(|c| c[1].to_string());
    let server = RE_SERVER.captures(block).map(|c| c[1].to_string());

    let mut parts = Vec::new();
    if let Some(ct) = content_type {
        parts.push(ct);
    }
    if let Some(srv) = server {
        parts.push(format!("from {srv}"));
    }
    if let Some(d) = duration {
        parts.push(format!("in {d}ms"));
    }
    let tag = log_id.map(|id| format!("  [log_{id}]")).unwrap_or_default();
    if parts.is_empty() {
        format!("← {status} {url}{tag}")
    } else {
        format!("← {status} {url} ({}){tag}", parts.join(", "))
    }
}

fn format_response_full(block: &str) -> String {
    let status = block
        .split_whitespace()
        .nth(1)
        .filter(|s| s.chars().all(|c| c.is_ascii_digit()))
        .unwrap_or("?");
    let url = block.split_whitespace().nth(2).unwrap_or("?");
    let content_type = RE_CONTENT_TYPE
        .captures(block)
        .map(|c| c[1].to_string())
        .unwrap_or_else(|| "?".into());
    let server = RE_SERVER
        .captures(block)
        .map(|c| c[1].to_string())
        .unwrap_or_else(|| "?".into());
    format!("← {status} {url} ({content_type}, from {server})")
}

fn count_object_placeholders(block: &str, section_key: &str) -> usize {
    let Some(idx) = block.find(section_key) else {
        return 0;
    };
    let tail = &block[idx + section_key.len()..];
    let bytes = tail.as_bytes();
    let mut depth: i32 = 0;
    let mut end = tail.len();
    let mut started = false;
    for (i, &b) in bytes.iter().enumerate() {
        match b {
            b'[' => {
                depth += 1;
                started = true;
            }
            b']' => {
                depth -= 1;
                if started && depth == 0 {
                    end = i;
                    break;
                }
            }
            _ => {}
        }
    }
    RE_OBJECT_COUNT.find_iter(&tail[..end]).count()
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    /// Push every line through the collator and return all emitted entries
    /// (plus whatever `flush()` produces) as a flat `Vec<String>`.
    fn drive_all(c: &mut Collator, lines: &[&str]) -> Vec<String> {
        let mut out = Vec::new();
        for line in lines {
            out.extend(c.push((*line).into()));
        }
        if let Some(rest) = c.flush() {
            out.extend(rest.split('\n').map(|s| s.to_string()));
        }
        out
    }

    #[test]
    fn single_log_line_succeeded_is_condensed() {
        let mut c = Collator::new();
        let out = drive_all(
            &mut c,
            &[
                "[log_abc123] post http://10.155.3.114:8888/v1/messages?beta=true \
                 succeeded with status 200 in 261ms",
            ],
        );
        assert_eq!(out.len(), 1);
        assert!(out[0].contains("post"));
        assert!(out[0].contains("http://10.155.3.114:8888/v1/messages?beta=true"));
        assert!(out[0].contains("200"));
        assert!(out[0].contains("261ms"));
        assert!(out[0].contains("log_abc123"));
    }

    #[test]
    fn multi_line_sending_request_is_summarised() {
        let mut c = Collator::new();
        let out = drive_all(
            &mut c,
            &[
                "[log_abc] sending request {",
                r#"  method: "post","#,
                r#"  url: "http://10.155.3.114:8888/v1/messages?beta=true","#,
                "  options: {",
                r#"    body: {"#,
                r#"      model: "unsloth/Qwen3.6-35B","#,
                "      messages: [",
                "        [Object ...]",
                "      ],",
                "      system: [",
                "        [Object ...], [Object ...]",
                "      ],",
                "      tools: [",
                "        [Object ...], [Object ...], [Object ...]",
                "      ],",
                "      max_tokens: 32000,",
                "      stream: true,",
                "    },",
                "  },",
                "}",
            ],
        );
        assert_eq!(out.len(), 1);
        assert!(out[0].starts_with("→ POST"));
        assert!(out[0].contains("model=unsloth/Qwen3.6-35B"));
        assert!(out[0].contains("max_tokens=32000"));
        assert!(out[0].contains("stream=true"));
        assert!(out[0].contains("messages=1"));
        assert!(out[0].contains("system=2"));
        assert!(out[0].contains("tools=3"));
        assert!(out[0].contains("[log_abc]"));
    }

    #[test]
    fn three_response_fragments_merge_into_one_line() {
        let mut c = Collator::new();
        let mut out = drive_all(
            &mut c,
            &[
                "[log_abc] response start {",
                r#"  url: "http://10.155.3.114:8888/v1/messages?beta=true","#,
                "  status: 200,",
                "  headers: {",
                r#"    "content-type": "text/event-stream; charset=utf-8","#,
                r#"    "server": "unsloth-studio","#,
                "  },",
                "  durationMs: 77,",
                "}",
                "response 200 http://10.155.3.114:8888/v1/messages?beta=true Headers {",
                r#"  "content-type": "text/event-stream; charset=utf-8","#,
                r#"  "server": "unsloth-studio","#,
                "} ReadableStream {",
                "  blob: [Function: blob],",
                "}",
                "[log_abc] response parsed {",
                r#"  url: "http://10.155.3.114:8888/v1/messages?beta=true","#,
                "  status: 200,",
                "  durationMs: 78,",
                "}",
            ],
        );
        // Simulate chat.rs flushing pending responses on the next RESULT: marker.
        out.extend(c.flush_all_pending_responses());

        let response_lines: Vec<_> = out.iter().filter(|l| l.starts_with("← 200")).collect();
        // Standalone Headers block (no log_id) renders separately + one merged line = 2.
        assert_eq!(response_lines.len(), 2, "got: {out:?}");
        let merged = response_lines
            .iter()
            .find(|l| l.contains("[log_abc]"))
            .expect("merged line with log_id present");
        assert!(merged.contains("text/event-stream"));
        assert!(merged.contains("from unsloth-studio"));
        assert!(merged.contains("in 77ms"));
    }

    #[test]
    fn new_request_flushes_pending_response_of_same_id() {
        let mut c = Collator::new();
        let out = drive_all(
            &mut c,
            &[
                "[log_abc] response start {",
                r#"  url: "http://x","#,
                "  status: 200,",
                "  durationMs: 50,",
                "}",
                // New request reuses log_abc (defensive)
                "[log_abc] sending request {",
                r#"  method: "post","#,
                r#"  url: "http://y","#,
                "}",
            ],
        );
        // Expect: response line (flushed by the new request) + the new request line.
        assert!(out
            .iter()
            .any(|l| l.starts_with("← 200") && l.contains("[log_abc]")));
        assert!(out.iter().any(|l| l.starts_with("→ POST")));
    }

    #[test]
    fn flush_drains_pending_response_on_eof() {
        let mut c = Collator::new();
        let out = drive_all(
            &mut c,
            &[
                "[log_aff] response start {",
                r#"  url: "http://x","#,
                "  status: 200,",
                "  durationMs: 50,",
                "}",
            ],
        );
        let merged = out
            .iter()
            .find(|l| l.starts_with("← 200") && l.contains("[log_aff]"))
            .expect("eof flush emits the pending response");
        assert!(merged.contains("in 50ms"));
    }

    #[test]
    fn unknown_format_passes_through_verbatim() {
        let mut c = Collator::new();
        let out = drive_all(
            &mut c,
            &[
                "weird new format {",
                "  some: value,",
                "  other: thing,",
                "}",
            ],
        );
        assert_eq!(out.len(), 1);
        assert!(out[0].contains("weird new format"));
        assert!(out[0].contains("some: value"));
        assert!(out[0].contains("other: thing"));
    }

    #[test]
    fn non_block_line_passes_through_unchanged() {
        let mut c = Collator::new();
        assert_eq!(
            c.push("RESULT: turn complete".into()),
            vec!["RESULT: turn complete".to_string()]
        );
    }

    #[test]
    fn eof_flush_drains_unterminated_buffer() {
        let mut c = Collator::new();
        c.push("[log_a] sending request {".into());
        c.push(r#"  method: "post","#.into());
        c.push(r#"  url: "http://x","#.into());
        let drained = c.flush().unwrap();
        assert!(drained.contains("POST"));
        assert!(drained.contains("http://x"));
        assert!(c.flush().is_none());
    }

    #[test]
    fn format_block_returns_input_verbatim_for_unrecognised() {
        let raw = "this is just some random log line";
        assert_eq!(format_block(raw), raw);
    }

    #[test]
    fn format_block_extracts_post_succeeded() {
        let raw = "[log_aff] post http://example.com succeeded with status 200 in 100ms";
        let out = format_block(raw);
        assert!(out.contains("post"));
        assert!(out.contains("http://example.com"));
        assert!(out.contains("200"));
        assert!(out.contains("100ms"));
        assert!(out.contains("log_aff"));
    }

    #[test]
    fn count_object_placeholders_respects_array_boundaries() {
        let block = "messages: [ [Object ...] ], system: [ [Object ...], [Object ...] ]";
        assert_eq!(count_object_placeholders(block, "messages:"), 1);
        assert_eq!(count_object_placeholders(block, "system:"), 2);
    }

    #[test]
    fn count_object_placeholders_returns_zero_when_section_absent() {
        let block = "no such section here";
        assert_eq!(count_object_placeholders(block, "messages:"), 0);
    }

    #[test]
    fn brace_delta_ignores_braces_inside_strings() {
        assert_eq!(brace_delta(r#"  url: "http://x/{tok}","#), 0);
        assert_eq!(brace_delta(r#"  options: { url: "x{y}","#), 1);
        assert_eq!(brace_delta(r#"  s: "a\"{b\"","#), 0);
    }

    #[test]
    fn brace_delta_handles_close_then_open() {
        assert_eq!(brace_delta("} ReadableStream {"), 0);
    }

    #[test]
    fn brace_delta_short_circuits_on_lines_without_braces() {
        // Plain text with no braces — must return 0 via the fast path.
        assert_eq!(brace_delta("  some: value,"), 0);
        assert_eq!(brace_delta(""), 0);
        assert_eq!(brace_delta("RESULT: turn complete"), 0);
    }

    #[test]
    fn buffer_overflow_releases_content_and_resets() {
        let mut c = Collator::new();
        // Open a block, then exceed MAX_BUFFERED_LINES with content that never
        // closes — collator must release the buffer and not grow unbounded.
        c.push("[log_abc] sending request {".into());
        let mut emitted = None;
        for i in 0..MAX_BUFFERED_LINES + 5 {
            let out = c.push(format!("  field_{i}: x,"));
            if !out.is_empty() {
                emitted = Some(out);
                break;
            }
        }
        let entries = emitted.expect("overflow must release buffered content");
        assert!(!entries.is_empty());
        // Next push starts fresh.
        let next = c.push("RESULT: turn complete".into());
        assert_eq!(next, vec!["RESULT: turn complete".to_string()]);
    }

    #[test]
    fn pending_response_overflow_evicts_oldest() {
        let mut c = Collator::new();
        // Insert MAX_PENDING_RESPONSES + 1 distinct response fragments — the
        // oldest must be evicted to keep memory bounded.
        for i in 0..MAX_PENDING_RESPONSES + 5 {
            c.push(format!("[log_{i:06x}] response start {{"));
            c.push(format!(r#"  url: "http://x/{i}","#));
            c.push("  status: 200,".into());
            c.push(format!("  durationMs: {i},"));
            c.push("}".into());
        }
        assert_eq!(c.pending_responses.len(), MAX_PENDING_RESPONSES);
        assert_eq!(c.pending_order.len(), MAX_PENDING_RESPONSES);
    }

    #[test]
    fn multi_id_flush_returns_insertion_order() {
        let mut c = Collator::new();
        // Three concurrent transactions, no terminator between them.
        for (i, id) in ["aaa111", "bbb222", "ccc333"].iter().enumerate() {
            c.push(format!("[log_{id}] response start {{"));
            c.push(format!(r#"  url: "http://x/{i}","#));
            c.push("  status: 200,".into());
            c.push(format!("  durationMs: {},", i + 10));
            c.push("}".into());
        }
        let flushed = c.flush_all_pending_responses();
        assert_eq!(flushed.len(), 3);
        // Insertion order preserved (not alphabetic — would be coincident here,
        // but the order field guarantees insertion-order on any input).
        assert!(flushed[0].contains("[log_aaa111]"));
        assert!(flushed[1].contains("[log_bbb222]"));
        assert!(flushed[2].contains("[log_ccc333]"));
    }
}
