//! SSE-event-aware inbound response rewrite: keywords are unmasked and PII spans
//! detokenized on the DECODED delta text, so a span split across `content_block_delta`
//! events still matches (raw-byte rewriting misses it — the halves are separated by
//! SSE/JSON framing). Non-SSE bodies fall back to whole-body buffering.

use std::collections::BTreeMap;
use std::fmt;

use speedwave_pii_engine::{CompiledKeyword, DetokenizeError, EngineKey};

use crate::pii::{
    safe_prefix_len, unmask_and_detokenize_json_fragment, unmask_and_detokenize_response,
    ResponseRewriteBuffer,
};

/// Cap on one buffered SSE event and on a whole buffered non-SSE body; exceeding it aborts
/// the stream (fail-closed) — the rewriter never forwards bytes it could not rewrite.
const MAX_BUFFERED_BYTES: usize = 8 * 1024 * 1024;

/// A response-rewrite failure; the relay aborts the stream, never forwarding unrewritten bytes.
#[derive(Debug)]
pub enum RewriteError {
    /// A token span failed SIV verification (fail-closed detokenization).
    Detokenize(DetokenizeError),
    /// An event could not be decoded, so its content could not be rewritten.
    UnparseableEvent(&'static str),
    /// A single event (or the whole non-SSE body) outgrew [`MAX_BUFFERED_BYTES`].
    Oversized,
}

impl fmt::Display for RewriteError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Detokenize(e) => write!(f, "{e}"),
            Self::UnparseableEvent(reason) => write!(f, "unrewritable SSE event: {reason}"),
            Self::Oversized => write!(f, "buffered response content exceeded the rewrite cap"),
        }
    }
}

impl std::error::Error for RewriteError {}

impl From<DetokenizeError> for RewriteError {
    fn from(e: DetokenizeError) -> Self {
        Self::Detokenize(e)
    }
}

/// The text-carrying `content_block_delta` kinds the rewriter transforms.
#[derive(Clone, Copy, PartialEq, Eq)]
enum DeltaKind {
    Text,
    InputJson,
    Thinking,
}

impl DeltaKind {
    fn from_wire(delta_type: &str) -> Option<Self> {
        match delta_type {
            "text_delta" => Some(Self::Text),
            "input_json_delta" => Some(Self::InputJson),
            "thinking_delta" => Some(Self::Thinking),
            _ => None,
        }
    }

    fn wire(self) -> &'static str {
        match self {
            Self::Text => "text_delta",
            Self::InputJson => "input_json_delta",
            Self::Thinking => "thinking_delta",
        }
    }

    fn payload_key(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::InputJson => "partial_json",
            Self::Thinking => "thinking",
        }
    }
}

/// Per-content-block rolling buffer of decoded, not-yet-emitted delta text.
struct BlockBuffer {
    kind: DeltaKind,
    pending: String,
}

/// Applies the inbound transform appropriate for the delta kind: `partial_json` content is
/// serialized JSON, so its replacements are additionally JSON-string-escaped.
fn transform(
    kind: DeltaKind,
    text: &str,
    keywords: &[CompiledKeyword],
    key: &EngineKey,
) -> Result<String, RewriteError> {
    let result = match kind {
        DeltaKind::InputJson => unmask_and_detokenize_json_fragment(text, keywords, key),
        DeltaKind::Text | DeltaKind::Thinking => {
            unmask_and_detokenize_response(text, keywords, key)
        }
    };
    result.map_err(RewriteError::Detokenize)
}

/// Facade the forwarder streams every upstream chunk through; the arm is picked once from
/// the upstream Content-Type (SSE event rewriting vs whole-body buffering).
pub struct ResponseRewriter {
    inner: Inner,
}

enum Inner {
    Sse(SseRewriter),
    Raw {
        buffer: ResponseRewriteBuffer,
        total: usize,
    },
}

impl ResponseRewriter {
    pub fn new(is_event_stream: bool) -> Self {
        let inner = if is_event_stream {
            Inner::Sse(SseRewriter::default())
        } else {
            Inner::Raw {
                buffer: ResponseRewriteBuffer::new(),
                total: 0,
            }
        };
        Self { inner }
    }

    /// Feeds one upstream chunk; returns the rewritten bytes safe to forward now.
    pub fn push_chunk(
        &mut self,
        chunk: &[u8],
        keywords: &[CompiledKeyword],
        key: &EngineKey,
    ) -> Result<Vec<u8>, RewriteError> {
        match &mut self.inner {
            Inner::Sse(sse) => sse.push_chunk(chunk, keywords, key),
            Inner::Raw { buffer, total } => {
                *total = buffer.push_chunk(chunk);
                if *total > MAX_BUFFERED_BYTES {
                    return Err(RewriteError::Oversized);
                }
                Ok(Vec::new())
            }
        }
    }

    /// Flushes and rewrites everything still buffered at stream end.
    pub fn finish(
        self,
        keywords: &[CompiledKeyword],
        key: &EngineKey,
    ) -> Result<Vec<u8>, RewriteError> {
        match self.inner {
            Inner::Sse(sse) => sse.finish(keywords, key),
            Inner::Raw { buffer, .. } => buffer
                .finish(keywords, key)
                .map_err(RewriteError::Detokenize),
        }
    }
}

/// Incremental SSE parser + per-block rewrite state machine. Non-delta events pass through
/// byte-exact; text-carrying delta events are re-synthesized from transformed decoded text,
/// holding back only a tail a potential match could still straddle ([`safe_prefix_len`]).
#[derive(Default)]
struct SseRewriter {
    line_buf: Vec<u8>,
    event_raw: Vec<u8>,
    event_data: Vec<String>,
    saw_event_name: bool,
    use_event_names: bool,
    blocks: BTreeMap<u64, BlockBuffer>,
}

impl SseRewriter {
    fn push_chunk(
        &mut self,
        chunk: &[u8],
        keywords: &[CompiledKeyword],
        key: &EngineKey,
    ) -> Result<Vec<u8>, RewriteError> {
        self.line_buf.extend_from_slice(chunk);
        if self.line_buf.len() + self.event_raw.len() > MAX_BUFFERED_BYTES {
            return Err(RewriteError::Oversized);
        }
        let mut out = Vec::new();
        while let Some(nl) = self.line_buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.line_buf.drain(..=nl).collect();
            self.consume_line(&line, &mut out, keywords, key)?;
            if self.event_raw.len() > MAX_BUFFERED_BYTES {
                return Err(RewriteError::Oversized);
            }
        }
        Ok(out)
    }

    fn finish(
        mut self,
        keywords: &[CompiledKeyword],
        key: &EngineKey,
    ) -> Result<Vec<u8>, RewriteError> {
        let mut out = Vec::new();
        // EOF terminates an unterminated final line, and an event missing its blank line.
        if !self.line_buf.is_empty() {
            let mut last = std::mem::take(&mut self.line_buf);
            last.push(b'\n');
            self.consume_line(&last, &mut out, keywords, key)?;
        }
        if !self.event_raw.is_empty() || !self.event_data.is_empty() {
            self.on_event_complete(&mut out, keywords, key)?;
        }
        let indexes: Vec<u64> = self.blocks.keys().copied().collect();
        for index in indexes {
            self.flush_block(index, &mut out, keywords, key)?;
        }
        Ok(out)
    }

    /// Consumes one raw line (terminator included). The raw bytes ride along for verbatim
    /// pass-through; only `data:`/`event:` fields and the blank event boundary are decoded.
    fn consume_line(
        &mut self,
        raw: &[u8],
        out: &mut Vec<u8>,
        keywords: &[CompiledKeyword],
        key: &EngineKey,
    ) -> Result<(), RewriteError> {
        self.event_raw.extend_from_slice(raw);
        let mut line = raw;
        if line.ends_with(b"\n") {
            line = &line[..line.len() - 1];
        }
        if line.ends_with(b"\r") {
            line = &line[..line.len() - 1];
        }
        if line.is_empty() {
            return self.on_event_complete(out, keywords, key);
        }
        if let Some(rest) = strip_field(line, b"data:") {
            let text = std::str::from_utf8(rest)
                .map_err(|_| RewriteError::UnparseableEvent("data line is not valid UTF-8"))?;
            self.event_data.push(text.to_string());
        } else if strip_field(line, b"event:").is_some() {
            self.saw_event_name = true;
        }
        Ok(())
    }

    fn on_event_complete(
        &mut self,
        out: &mut Vec<u8>,
        keywords: &[CompiledKeyword],
        key: &EngineKey,
    ) -> Result<(), RewriteError> {
        let raw = std::mem::take(&mut self.event_raw);
        let data = std::mem::take(&mut self.event_data);
        let had_event_name = std::mem::take(&mut self.saw_event_name);

        if data.is_empty() {
            out.extend_from_slice(&raw);
            return Ok(());
        }
        let joined = data.join("\n");
        if joined == "[DONE]" {
            out.extend_from_slice(&raw);
            return Ok(());
        }
        let frame: serde_json::Value = serde_json::from_str(&joined)
            .map_err(|_| RewriteError::UnparseableEvent("data content is not valid JSON"))?;
        match frame.get("type").and_then(|t| t.as_str()) {
            Some("content_block_delta") => {
                let index = frame.get("index").and_then(|i| i.as_u64()).unwrap_or(0);
                let delta_type = frame
                    .get("delta")
                    .and_then(|d| d.get("type"))
                    .and_then(|t| t.as_str())
                    .unwrap_or("");
                match DeltaKind::from_wire(delta_type) {
                    Some(kind) => {
                        self.use_event_names = had_event_name;
                        self.rewrite_delta(index, kind, &frame, out, keywords, key)?;
                    }
                    None => {
                        // Unknown delta kind (e.g. signature_delta): flush our held text so
                        // in-block ordering survives, then pass the event through verbatim.
                        self.flush_block(index, out, keywords, key)?;
                        out.extend_from_slice(&raw);
                    }
                }
            }
            Some("content_block_stop") => {
                let index = frame.get("index").and_then(|i| i.as_u64()).unwrap_or(0);
                self.flush_block(index, out, keywords, key)?;
                self.blocks.remove(&index);
                out.extend_from_slice(&raw);
            }
            _ => out.extend_from_slice(&raw),
        }
        Ok(())
    }

    /// Buffers a known delta's payload and emits the transformed safe prefix, holding back
    /// only a tail a split token span or keyword alias could still be growing into.
    fn rewrite_delta(
        &mut self,
        index: u64,
        kind: DeltaKind,
        frame: &serde_json::Value,
        out: &mut Vec<u8>,
        keywords: &[CompiledKeyword],
        key: &EngineKey,
    ) -> Result<(), RewriteError> {
        let payload = frame
            .get("delta")
            .and_then(|d| d.get(kind.payload_key()))
            .and_then(|p| p.as_str())
            .ok_or(RewriteError::UnparseableEvent(
                "delta payload is not a string",
            ))?;
        if self.blocks.get(&index).is_some_and(|b| b.kind != kind) {
            // A kind change inside one block is not a real protocol state, but never mix
            // buffered text across transforms — flush the old kind first.
            self.flush_block(index, out, keywords, key)?;
            self.blocks.remove(&index);
        }
        let block = self.blocks.entry(index).or_insert_with(|| BlockBuffer {
            kind,
            pending: String::new(),
        });
        block.pending.push_str(payload);
        let safe = safe_prefix_len(&block.pending, keywords);
        if safe == 0 {
            return Ok(());
        }
        let tail = block.pending.split_off(safe);
        let prefix = std::mem::replace(&mut block.pending, tail);
        let transformed = transform(kind, &prefix, keywords, key)?;
        if !transformed.is_empty() {
            self.emit_delta(index, kind, &transformed, out);
        }
        Ok(())
    }

    /// Transforms and emits whatever text is still held for `index` (block end / stream end).
    fn flush_block(
        &mut self,
        index: u64,
        out: &mut Vec<u8>,
        keywords: &[CompiledKeyword],
        key: &EngineKey,
    ) -> Result<(), RewriteError> {
        let (kind, pending) = match self.blocks.get_mut(&index) {
            Some(block) if !block.pending.is_empty() => {
                (block.kind, std::mem::take(&mut block.pending))
            }
            _ => return Ok(()),
        };
        let transformed = transform(kind, &pending, keywords, key)?;
        if !transformed.is_empty() {
            self.emit_delta(index, kind, &transformed, out);
        }
        Ok(())
    }

    /// Serializes one synthesized delta event, mirroring the upstream `event:`-line style.
    fn emit_delta(&self, index: u64, kind: DeltaKind, text: &str, out: &mut Vec<u8>) {
        let mut delta = serde_json::Map::new();
        delta.insert(
            "type".to_string(),
            serde_json::Value::String(kind.wire().to_string()),
        );
        delta.insert(
            kind.payload_key().to_string(),
            serde_json::Value::String(text.to_string()),
        );
        let frame = serde_json::json!({
            "type": "content_block_delta",
            "index": index,
            "delta": serde_json::Value::Object(delta),
        });
        if self.use_event_names {
            out.extend_from_slice(b"event: content_block_delta\n");
        }
        out.extend_from_slice(b"data: ");
        out.extend_from_slice(frame.to_string().as_bytes());
        out.extend_from_slice(b"\n\n");
    }
}

/// Strips an SSE field name plus one optional following space; `None` when the line does
/// not start with the field.
fn strip_field<'a>(line: &'a [u8], field: &[u8]) -> Option<&'a [u8]> {
    let rest = line.strip_prefix(field)?;
    Some(rest.strip_prefix(b" ").unwrap_or(rest))
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "test fixture setup, failure aborts the test"
)]
mod tests {
    use super::*;
    use speedwave_pii_engine::{compile_policy_v3, default_policy_json, scan_text, CompiledPolicy};

    fn default_policy_and_key() -> (CompiledPolicy, EngineKey) {
        (
            compile_policy_v3(&default_policy_json()).expect("default policy compiles"),
            EngineKey::from_bytes([9u8; 32]),
        )
    }

    fn keyword_policy() -> CompiledPolicy {
        let json = r#"{
            "version": 3,
            "source": { "policies": [], "forced": [] },
            "rules": [
                { "id": "EMAIL", "displayName": "E-mail", "patterns": ["[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}"], "caseSensitive": true, "tokenize": true, "log": false }
            ],
            "keywords": [
                { "match": "Coca-Cola", "alias": "Brandex", "caseSensitive": true }
            ]
        }"#;
        compile_policy_v3(json).expect("keyword policy compiles")
    }

    fn secret_policy() -> CompiledPolicy {
        let json = r#"{
            "version": 3,
            "source": { "policies": [], "forced": [] },
            "rules": [
                { "id": "SECRET", "displayName": "Secret", "patterns": ["(?s)BEGIN.+END"], "caseSensitive": true, "tokenize": true, "log": false }
            ],
            "keywords": []
        }"#;
        compile_policy_v3(json).expect("secret policy compiles")
    }

    fn token_for(policy: &CompiledPolicy, key: &EngineKey, value: &str) -> String {
        scan_text(policy, key, value).expect("scan succeeds").text
    }

    fn delta_event(
        index: u64,
        kind: &str,
        payload_key: &str,
        text: &str,
        event_line: bool,
    ) -> String {
        let payload = serde_json::to_string(text).expect("string serializes");
        let data = format!(
            r#"{{"type":"content_block_delta","index":{index},"delta":{{"type":"{kind}","{payload_key}":{payload}}}}}"#
        );
        if event_line {
            format!("event: content_block_delta\ndata: {data}\n\n")
        } else {
            format!("data: {data}\n\n")
        }
    }

    fn split_deltas(index: u64, kind: &str, payload_key: &str, text: &str, piece: usize) -> String {
        let chars: Vec<char> = text.chars().collect();
        chars
            .chunks(piece)
            .map(|c| {
                delta_event(
                    index,
                    kind,
                    payload_key,
                    &c.iter().collect::<String>(),
                    true,
                )
            })
            .collect()
    }

    fn stop_event(index: u64) -> String {
        format!("event: content_block_stop\ndata: {{\"type\":\"content_block_stop\",\"index\":{index}}}\n\n")
    }

    fn run(
        stream: &str,
        chunk: usize,
        keywords: &[CompiledKeyword],
        key: &EngineKey,
    ) -> Result<String, RewriteError> {
        let mut rewriter = ResponseRewriter::new(true);
        let mut out = Vec::new();
        for part in stream.as_bytes().chunks(chunk) {
            out.extend(rewriter.push_chunk(part, keywords, key)?);
        }
        out.extend(rewriter.finish(keywords, key)?);
        Ok(String::from_utf8(out).expect("output is valid utf8"))
    }

    fn delta_text(output: &str, index: u64) -> String {
        let mut text = String::new();
        for line in output.lines() {
            let Some(data) = line.strip_prefix("data: ") else {
                continue;
            };
            let Ok(frame) = serde_json::from_str::<serde_json::Value>(data) else {
                continue;
            };
            if frame["type"] == "content_block_delta"
                && frame["index"].as_u64().unwrap_or(0) == index
            {
                for k in ["text", "partial_json", "thinking"] {
                    if let Some(s) = frame["delta"][k].as_str() {
                        text.push_str(s);
                    }
                }
            }
        }
        text
    }

    #[test]
    fn sse_span_split_across_multiple_delta_events_detokenizes() {
        // The production failure: a token span streamed as tiny text_delta fragments.
        let (policy, key) = default_policy_and_key();
        let token = token_for(&policy, &key, "user.813b4c5c4a@example.com");
        let stream = format!(
            "{}{}",
            split_deltas(0, "text_delta", "text", &format!("Contact {token} now"), 3),
            stop_event(0)
        );

        let out = run(&stream, 64 * 1024, &[], &key).unwrap();
        assert_eq!(
            delta_text(&out, 0),
            format!("Contact {} now", "user.813b4c5c4a@example.com")
        );
        assert!(!out.contains("TOKEN_"), "no literal token may survive");
    }

    #[test]
    fn sse_span_split_across_event_and_transport_chunks() {
        let (policy, key) = default_policy_and_key();
        let token = token_for(&policy, &key, "user.f42d16939a@example.com");
        let stream = format!(
            "{}{}",
            split_deltas(0, "text_delta", "text", &format!("hi {token}!"), 4),
            stop_event(0)
        );

        let out = run(&stream, 5, &[], &key).unwrap();
        assert_eq!(
            delta_text(&out, 0),
            format!("hi {}!", "user.f42d16939a@example.com")
        );
        assert!(!out.contains("TOKEN_"));
    }

    #[test]
    fn sse_alias_split_across_delta_events_unmasks() {
        let policy = keyword_policy();
        let key = EngineKey::from_bytes([9u8; 32]);
        let stream = format!(
            "{}{}",
            split_deltas(0, "text_delta", "text", "Meet Brandex today", 2),
            stop_event(0)
        );

        let out = run(&stream, 64 * 1024, policy.keywords(), &key).unwrap();
        assert_eq!(delta_text(&out, 0), "Meet Coca-Cola today");
    }

    #[test]
    fn sse_alias_straddling_emit_boundary_is_held_then_unmasked() {
        let policy = keyword_policy();
        let key = EngineKey::from_bytes([9u8; 32]);
        let mut rewriter = ResponseRewriter::new(true);

        let ev1 = delta_event(0, "text_delta", "text", "see Bran", true);
        let out1 = rewriter
            .push_chunk(ev1.as_bytes(), policy.keywords(), &key)
            .unwrap();
        let out1 = String::from_utf8(out1).unwrap();
        assert_eq!(delta_text(&out1, 0), "see ", "partial alias must be held");

        let ev2 = delta_event(0, "text_delta", "text", "dex go", true);
        let mut rest = rewriter
            .push_chunk(ev2.as_bytes(), policy.keywords(), &key)
            .unwrap();
        rest.extend(rewriter.finish(policy.keywords(), &key).unwrap());
        let rest = String::from_utf8(rest).unwrap();
        assert_eq!(
            format!("{}{}", delta_text(&out1, 0), delta_text(&rest, 0)),
            "see Coca-Cola go"
        );
    }

    #[test]
    fn sse_input_json_delta_replacement_is_json_escaped() {
        let policy = secret_policy();
        let key = EngineKey::from_bytes([9u8; 32]);
        let plaintext = "BEGIN\"x\ny\\zEND";
        let token = token_for(&policy, &key, plaintext);
        assert!(token.starts_with("[SECRET:TOKEN_"), "got: {token}");

        let tool_input = serde_json::json!({ "content": token }).to_string();
        let stream = format!(
            "{}{}",
            split_deltas(0, "input_json_delta", "partial_json", &tool_input, 4),
            stop_event(0)
        );

        let out = run(&stream, 64 * 1024, &[], &key).unwrap();
        let reassembled = delta_text(&out, 0);
        let parsed: serde_json::Value =
            serde_json::from_str(&reassembled).expect("partial_json must reassemble to valid JSON");
        assert_eq!(parsed["content"], plaintext);
    }

    #[test]
    fn sse_interleaved_blocks_rewrite_independently() {
        let (policy, key) = default_policy_and_key();
        let token0 = token_for(&policy, &key, "user.292a9fcc6f@example.com");
        let token1 = token_for(&policy, &key, "user.8e6a804878@example.com");
        let ev0: Vec<String> = split_deltas(0, "text_delta", "text", &format!("a {token0} b"), 3)
            .split_inclusive("\n\n")
            .map(str::to_string)
            .collect();
        let ev1: Vec<String> = split_deltas(1, "text_delta", "text", &format!("c {token1} d"), 3)
            .split_inclusive("\n\n")
            .map(str::to_string)
            .collect();
        let mut stream = String::new();
        for i in 0..ev0.len().max(ev1.len()) {
            if let Some(e) = ev0.get(i) {
                stream.push_str(e);
            }
            if let Some(e) = ev1.get(i) {
                stream.push_str(e);
            }
        }
        stream.push_str(&stop_event(0));
        stream.push_str(&stop_event(1));

        let out = run(&stream, 64 * 1024, &[], &key).unwrap();
        assert_eq!(
            delta_text(&out, 0),
            format!("a {} b", "user.292a9fcc6f@example.com")
        );
        assert_eq!(
            delta_text(&out, 1),
            format!("c {} d", "user.8e6a804878@example.com")
        );
        assert!(!out.contains("TOKEN_"));
    }

    #[test]
    fn sse_thinking_delta_is_rewritten() {
        let (policy, key) = default_policy_and_key();
        let token = token_for(&policy, &key, "user.65a1e26a3e@example.com");
        let stream = format!(
            "{}{}",
            split_deltas(0, "thinking_delta", "thinking", &format!("re {token}"), 3),
            stop_event(0)
        );

        let out = run(&stream, 64 * 1024, &[], &key).unwrap();
        assert_eq!(
            delta_text(&out, 0),
            format!("re {}", "user.65a1e26a3e@example.com")
        );
    }

    #[test]
    fn sse_ping_message_delta_done_and_comments_pass_through_verbatim() {
        let key = EngineKey::from_bytes([9u8; 32]);
        let stream = concat!(
            "event: ping\r\ndata: {\"type\":\"ping\"}\r\n\r\n",
            ": keep-alive comment\n\n",
            "event: message_delta\ndata: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":5}}\n\n",
            "data: [DONE]\n\n",
        );

        let out = run(stream, 7, &[], &key).unwrap();
        assert_eq!(out, stream, "non-delta events must pass through byte-exact");
    }

    #[test]
    fn sse_signature_delta_flushes_pending_thinking_first() {
        let key = EngineKey::from_bytes([9u8; 32]);
        let stream = format!(
            "{}{}{}",
            delta_event(0, "thinking_delta", "thinking", "deep [EMAIL:TOK", true),
            "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"signature_delta\",\"signature\":\"sig\"}}\n\n",
            stop_event(0)
        );

        let out = run(&stream, 64 * 1024, &[], &key).unwrap();
        let held = out.find("[EMAIL:TOK").expect("held tail must be flushed");
        let signature = out
            .find("signature_delta")
            .expect("signature passes through");
        assert!(
            held < signature,
            "buffered thinking text must flush before the signature event"
        );
    }

    #[test]
    fn sse_stop_flushes_tail_before_stop_event() {
        let key = EngineKey::from_bytes([9u8; 32]);
        let stream = format!(
            "{}{}",
            delta_event(0, "text_delta", "text", "tail [EMAIL:TOK", true),
            stop_event(0)
        );

        let out = run(&stream, 64 * 1024, &[], &key).unwrap();
        let held = out.find("[EMAIL:TOK").expect("held tail must be flushed");
        let stop = out.find("content_block_stop").expect("stop passes through");
        assert!(held < stop, "tail must be emitted before the stop event");
    }

    #[test]
    fn sse_unparseable_data_line_fails_closed() {
        let key = EngineKey::from_bytes([9u8; 32]);
        let result = run("data: {not json\n\n", 64 * 1024, &[], &key);
        assert!(matches!(result, Err(RewriteError::UnparseableEvent(_))));
    }

    #[test]
    fn sse_oversized_event_fails_closed() {
        let key = EngineKey::from_bytes([9u8; 32]);
        let mut rewriter = ResponseRewriter::new(true);
        let huge = format!("data: {}", "x".repeat(MAX_BUFFERED_BYTES + 1));
        assert!(matches!(
            rewriter.push_chunk(huge.as_bytes(), &[], &key),
            Err(RewriteError::Oversized)
        ));
    }

    #[test]
    fn sse_corrupted_token_aborts_mid_stream() {
        let (policy, key) = default_policy_and_key();
        let token = token_for(&policy, &key, "user.f24ee5c55d@example.com");
        let mut bytes = token.into_bytes();
        let pos = bytes.len() - 5;
        bytes[pos] = if bytes[pos] == b'A' { b'B' } else { b'A' };
        let corrupted = String::from_utf8(bytes).unwrap();
        let stream = format!(
            "{}{}",
            split_deltas(0, "text_delta", "text", &corrupted, 6),
            stop_event(0)
        );

        let result = run(&stream, 64 * 1024, &[], &key);
        assert!(matches!(result, Err(RewriteError::Detokenize(_))));
    }

    #[test]
    fn non_sse_json_body_transforms_via_raw_buffer() {
        let (policy, key) = default_policy_and_key();
        let token = token_for(&policy, &key, "user.dd95ef9b85@example.com");
        let body = format!("{{\"content\":[{{\"type\":\"text\",\"text\":\"mail {token}\"}}]}}");

        let mut rewriter = ResponseRewriter::new(false);
        let (first, second) = body.as_bytes().split_at(body.len() / 2);
        assert!(rewriter.push_chunk(first, &[], &key).unwrap().is_empty());
        assert!(rewriter.push_chunk(second, &[], &key).unwrap().is_empty());
        let out = String::from_utf8(rewriter.finish(&[], &key).unwrap()).unwrap();
        assert!(out.contains("mail user.dd95ef9b85@example.com"));
        assert!(!out.contains("TOKEN_"));
    }

    #[test]
    fn sse_finish_flushes_unterminated_event_and_blocks() {
        let (policy, key) = default_policy_and_key();
        let token = token_for(&policy, &key, "user.7880093b09@example.com");
        // No trailing blank line and no stop event: EOF must terminate and flush.
        let event = delta_event(0, "text_delta", "text", &format!("end {token}"), true);
        let stream = event.trim_end_matches('\n');

        let out = run(stream, 64 * 1024, &[], &key).unwrap();
        assert_eq!(
            delta_text(&out, 0),
            format!("end {}", "user.7880093b09@example.com")
        );
    }

    #[test]
    fn sse_synthesized_event_line_mirrors_upstream_style() {
        let (policy, key) = default_policy_and_key();
        let token = token_for(&policy, &key, "user.8529f1d4de@example.com");
        let bare = format!(
            "{}data: {{\"type\":\"content_block_stop\",\"index\":0}}\n\n",
            delta_event(0, "text_delta", "text", &format!("x {token}"), false)
        );

        let out = run(&bare, 64 * 1024, &[], &key).unwrap();
        assert!(
            !out.contains("event:"),
            "bare data: streams must not grow event names: {out}"
        );
        assert_eq!(
            delta_text(&out, 0),
            format!("x {}", "user.8529f1d4de@example.com")
        );
    }

    #[test]
    fn sse_delta_kind_change_mid_block_flushes_old_kind() {
        let key = EngineKey::from_bytes([9u8; 32]);
        let stream = format!(
            "{}{}{}",
            delta_event(0, "text_delta", "text", "held [EMAIL:TOK", true),
            delta_event(0, "input_json_delta", "partial_json", "{}", true),
            stop_event(0)
        );

        let out = run(&stream, 64 * 1024, &[], &key).unwrap();
        let text_pos = out.find("[EMAIL:TOK").expect("old-kind text flushed");
        let json_pos = out.find("input_json_delta").expect("new kind emitted");
        assert!(
            text_pos < json_pos,
            "old kind must flush before the new kind"
        );
        assert!(out.contains("text_delta"));
    }

    #[test]
    fn sse_missing_index_defaults_to_block_zero() {
        let (policy, key) = default_policy_and_key();
        let token = token_for(&policy, &key, "user.c04045e4e2@example.com");
        let payload = serde_json::to_string(&format!("no-index {token}")).unwrap();
        let stream = format!(
            "data: {{\"type\":\"content_block_delta\",\"delta\":{{\"type\":\"text_delta\",\"text\":{payload}}}}}\n\ndata: {{\"type\":\"content_block_stop\"}}\n\n"
        );

        let out = run(&stream, 64 * 1024, &[], &key).unwrap();
        assert_eq!(
            delta_text(&out, 0),
            format!("no-index {}", "user.c04045e4e2@example.com")
        );
    }

    #[test]
    fn sse_multiple_data_lines_join_per_spec() {
        let key = EngineKey::from_bytes([9u8; 32]);
        let stream = "data: {\"type\":\ndata: \"ping\"}\n\n";

        let out = run(stream, 64 * 1024, &[], &key).unwrap();
        assert_eq!(
            out, stream,
            "multi-data-line non-delta event passes verbatim"
        );
    }

    #[test]
    fn sse_empty_text_delta_produces_no_output_and_no_error() {
        let key = EngineKey::from_bytes([9u8; 32]);
        let stream = format!(
            "{}{}",
            delta_event(0, "text_delta", "text", "", true),
            stop_event(0)
        );

        let out = run(&stream, 64 * 1024, &[], &key).unwrap();
        assert_eq!(delta_text(&out, 0), "");
        assert!(out.contains("content_block_stop"));
    }
}
