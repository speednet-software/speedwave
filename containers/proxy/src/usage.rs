use serde::Serialize;
use serde_json::Value;
use std::path::Path;

/// One appended JSONL line — field names must match `UsageRecord` in
/// `crates/speedwave-runtime/src/usage.rs` exactly (aggregator-parity).
#[derive(Debug, Serialize)]
pub struct UsageLine {
    pub ts: String,
    pub capture: String,
    pub status: String,
    pub model: Option<String>,
    pub response_id: Option<String>,
    pub provider_kind: String,
    pub provider_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gen_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
    pub latency_ms: u64,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub cache_read: u64,
    pub cache_write: u64,
}

/// Accumulates SSE usage frames for a single request.
#[derive(Default)]
pub struct UsageAcc {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub response_id: Option<String>,
    /// OpenRouter generation id (`gen-…`) sniffed from the response, used
    /// host-side for real cost via `/generation`. `None` for other providers.
    pub gen_id: Option<String>,
    /// True once any usage frame was observed — distinguishes "0/0 real" from "never seen".
    pub saw_usage: bool,
}

/// Update `acc` from one parsed SSE frame `Value`.
pub fn sniff(frame: &Value, acc: &mut UsageAcc) {
    let event_type = frame.get("type").and_then(Value::as_str).unwrap_or("");

    // OpenRouter surfaces a `gen-…` generation id; capture it wherever it appears.
    if acc.gen_id.is_none() {
        for id in [
            frame.get("id").and_then(Value::as_str),
            frame
                .get("message")
                .and_then(|m| m.get("id"))
                .and_then(Value::as_str),
        ]
        .into_iter()
        .flatten()
        {
            if id.starts_with("gen-") {
                acc.gen_id = Some(id.to_string());
                break;
            }
        }
    }

    match event_type {
        "message_start" => {
            if let Some(msg) = frame.get("message") {
                if let Some(id) = msg.get("id").and_then(Value::as_str) {
                    acc.response_id = Some(id.to_string());
                }
                if let Some(usage) = msg.get("usage") {
                    acc.saw_usage = true;
                    if let Some(v) = usage.get("input_tokens").and_then(Value::as_u64) {
                        acc.prompt_tokens = v;
                    }
                    // Coalesced/single-frame backends put output on message_start.
                    if let Some(v) = usage.get("output_tokens").and_then(Value::as_u64) {
                        acc.completion_tokens = v;
                    }
                    if let Some(v) = usage.get("cache_read_input_tokens").and_then(Value::as_u64) {
                        acc.cache_read = v;
                    }
                    if let Some(v) = usage
                        .get("cache_creation_input_tokens")
                        .and_then(Value::as_u64)
                    {
                        acc.cache_write = v;
                    }
                }
            }
        }
        "message_delta" => {
            if let Some(usage) = frame.get("usage") {
                acc.saw_usage = true;
                // input_tokens on a delta overrides the message_start value (vLLM/bridged case).
                if let Some(v) = usage.get("input_tokens").and_then(Value::as_u64) {
                    if v > 0 {
                        acc.prompt_tokens = v;
                    }
                }
                // Guard >0: a trailing 0 must not wipe a message_start value.
                if let Some(v) = usage.get("output_tokens").and_then(Value::as_u64) {
                    if v > 0 {
                        acc.completion_tokens = v;
                    }
                }
                if let Some(v) = usage.get("cache_read_input_tokens").and_then(Value::as_u64) {
                    if v > 0 {
                        acc.cache_read = v;
                    }
                }
                if let Some(v) = usage
                    .get("cache_creation_input_tokens")
                    .and_then(Value::as_u64)
                {
                    if v > 0 {
                        acc.cache_write = v;
                    }
                }
            }
        }
        _ => {}
    }
}

/// Terminal status on the usage line; `Failure` = upstream ≥400 or aborted stream.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequestStatus {
    Success,
    Failure,
}

impl RequestStatus {
    fn as_wire(self) -> &'static str {
        match self {
            RequestStatus::Success => "success",
            RequestStatus::Failure => "failure",
        }
    }
}

impl UsageAcc {
    /// Convert to a `UsageLine` tagged with provider kind/id and `status`.
    /// `None` when no usage frame was seen. Falls back to `gen_id` as
    /// `response_id` when `message.id` is absent (keeps enrich/dedup keyed).
    pub fn finish(
        self,
        model: &str,
        latency_ms: u64,
        provider_kind: &str,
        provider_id: &str,
        status: RequestStatus,
    ) -> Option<UsageLine> {
        if !self.saw_usage {
            return None;
        }
        let ts = chrono::Local::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, false);
        let response_id = self.response_id.or_else(|| self.gen_id.clone());
        Some(UsageLine {
            ts,
            capture: "forwarder".to_string(),
            status: status.as_wire().to_string(),
            model: Some(model.to_string()),
            response_id,
            provider_kind: provider_kind.to_string(),
            provider_id: provider_id.to_string(),
            gen_id: self.gen_id,
            cost_usd: None,
            latency_ms,
            prompt_tokens: self.prompt_tokens,
            completion_tokens: self.completion_tokens,
            cache_read: self.cache_read,
            cache_write: self.cache_write,
        })
    }
}

/// Append `line` as a compact JSON line to `path`.  Any IO error is swallowed
/// — usage logging must never break request forwarding.
pub fn append_usage(path: &Path, line: &UsageLine) {
    let _ = append_usage_inner(path, line);
}

fn append_usage_inner(path: &Path, line: &UsageLine) -> std::io::Result<()> {
    use std::io::Write;
    let json = serde_json::to_string(line).map_err(std::io::Error::other)?;
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .create(true)
        .open(path)?;
    writeln!(file, "{json}")
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]
    use super::*;
    use serde_json::json;

    fn fixture_line() -> UsageLine {
        UsageLine {
            ts: "2026-06-25T10:00:00.000+02:00".to_string(),
            capture: "forwarder".to_string(),
            status: "success".to_string(),
            model: Some("claude-haiku-4-5".to_string()),
            response_id: Some("msg_abc123".to_string()),
            provider_kind: "anthropic_oauth".to_string(),
            provider_id: "anthropic".to_string(),
            gen_id: None,
            cost_usd: None,
            latency_ms: 900,
            prompt_tokens: 100,
            completion_tokens: 50,
            cache_read: 0,
            cache_write: 0,
        }
    }

    #[test]
    fn usage_line_serializes_provider_kind_and_gen_id() {
        let line = UsageLine {
            provider_kind: "openrouter".into(),
            provider_id: "openrouter".into(),
            gen_id: Some("gen-abc".into()),
            ..fixture_line()
        };
        let s = serde_json::to_string(&line).unwrap();
        assert!(s.contains(r#""provider_kind":"openrouter""#));
        assert!(s.contains(r#""gen_id":"gen-abc""#));
    }

    #[test]
    fn sniff_captures_openrouter_gen_id_from_top_level_id() {
        let mut a = UsageAcc::default();
        sniff(
            &json!({"type":"message_start","id":"gen-xyz","message":{"id":"msg_3","usage":{"input_tokens":1}}}),
            &mut a,
        );
        assert_eq!(a.gen_id.unwrap(), "gen-xyz");
        // The `msg_…` id is still the response id, not the gen id.
        assert_eq!(a.response_id.unwrap(), "msg_3");
    }

    #[test]
    fn sniff_leaves_gen_id_none_without_gen_prefix() {
        let mut a = UsageAcc::default();
        sniff(
            &json!({"type":"message_start","message":{"id":"msg_4","usage":{"input_tokens":1}}}),
            &mut a,
        );
        assert!(a.gen_id.is_none());
    }

    #[test]
    fn input_from_message_delta_overrides_message_start() {
        let mut a = UsageAcc::default();
        sniff(
            &json!({"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":0}}}),
            &mut a,
        );
        sniff(
            &json!({"type":"message_delta","usage":{"input_tokens":1234,"output_tokens":50}}),
            &mut a,
        );
        let line = a
            .finish("m", 500, "openrouter", "openrouter", RequestStatus::Success)
            .unwrap();
        assert_eq!(line.prompt_tokens, 1234);
        assert_eq!(line.completion_tokens, 50);
    }

    #[test]
    fn skips_when_no_usage_seen() {
        let mut a = UsageAcc::default();
        sniff(
            &json!({"type":"content_block_delta","delta":{"text":"hi"}}),
            &mut a,
        );
        assert!(a
            .finish(
                "m",
                0,
                "anthropic_oauth",
                "anthropic",
                RequestStatus::Success
            )
            .is_none());
    }

    #[test]
    fn emits_openrouter_zero_cache_not_skipped() {
        let mut a = UsageAcc::default();
        sniff(
            &json!({"type":"message_start","message":{"id":"x","usage":{"input_tokens":0}}}),
            &mut a,
        );
        sniff(
            &json!({"type":"message_delta","usage":{"output_tokens":0}}),
            &mut a,
        );
        let line = a
            .finish("m", 0, "openrouter", "openrouter", RequestStatus::Success)
            .unwrap();
        assert_eq!(line.cache_read, 0);
    }

    #[test]
    fn serialized_line_has_no_cost_usd_for_mvp() {
        let line = UsageLine {
            cost_usd: None,
            ..fixture_line()
        };
        let s = serde_json::to_string(&line).unwrap();
        assert!(!s.contains("cost_usd"));
    }

    #[test]
    fn null_response_id_still_serializes() {
        let line = UsageLine {
            response_id: None,
            ..fixture_line()
        };
        assert!(serde_json::to_string(&line)
            .unwrap()
            .contains("\"response_id\":null"));
    }

    #[test]
    fn cross_aggregator_round_trip_bytes_match() {
        // Write a UsageLine and verify the bytes the host aggregator would parse.
        // Field names and types must match UsageRecord in speedwave-runtime/src/usage.rs.
        let line = UsageLine {
            ts: "2026-06-12T10:00:00.000+02:00".to_string(),
            capture: "forwarder".to_string(),
            status: "success".to_string(),
            model: Some("claude-haiku-4-5".to_string()),
            response_id: Some("msg_abc".to_string()),
            provider_kind: "anthropic_oauth".to_string(),
            provider_id: "anthropic".to_string(),
            gen_id: None,
            cost_usd: None,
            latency_ms: 900,
            prompt_tokens: 50000,
            completion_tokens: 10,
            cache_read: 0,
            cache_write: 0,
        };
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("usage.jsonl");
        append_usage(&path, &line);
        let written = std::fs::read_to_string(&path).unwrap();
        let trimmed = written.trim_end_matches('\n');
        // Must round-trip through serde_json as a valid object with required fields.
        let parsed: serde_json::Value = serde_json::from_str(trimmed).unwrap();
        assert_eq!(parsed["ts"], "2026-06-12T10:00:00.000+02:00");
        assert_eq!(parsed["capture"], "forwarder");
        assert_eq!(parsed["status"], "success");
        assert_eq!(parsed["model"], "claude-haiku-4-5");
        assert_eq!(parsed["response_id"], "msg_abc");
        assert_eq!(
            parsed["latency_ms"], 900,
            "latency_ms must be emitted for throughput parity"
        );
        assert_eq!(parsed["prompt_tokens"], 50000);
        assert_eq!(parsed["completion_tokens"], 10);
        assert_eq!(parsed["cache_read"], 0);
        assert_eq!(parsed["cache_write"], 0);
        assert_eq!(parsed["provider_kind"], "anthropic_oauth");
        assert_eq!(parsed["provider_id"], "anthropic");
        // gen_id must be absent for non-OpenRouter (skip_serializing_if None).
        assert!(parsed.get("gen_id").is_none(), "gen_id must be absent");
        // cost_usd must be absent (skip_serializing_if None).
        assert!(parsed.get("cost_usd").is_none(), "cost_usd must be absent");
        // Ends with a newline (append_usage uses writeln!).
        assert!(written.ends_with('\n'));
    }

    #[test]
    fn output_tokens_captured_from_message_start_only_stream() {
        // Coalesced backend: final output count arrives on message_start, no delta.
        let mut a = UsageAcc::default();
        sniff(
            &json!({"type":"message_start","message":{"id":"x","usage":{
                "input_tokens":10,
                "output_tokens":42
            }}}),
            &mut a,
        );
        let line = a
            .finish("m", 0, "local", "local", RequestStatus::Success)
            .unwrap();
        assert_eq!(line.prompt_tokens, 10);
        assert_eq!(line.completion_tokens, 42);
    }

    #[test]
    fn message_delta_output_overrides_message_start_output() {
        // A later message_delta carries the authoritative final output count.
        let mut a = UsageAcc::default();
        sniff(
            &json!({"type":"message_start","message":{"id":"x","usage":{"input_tokens":5,"output_tokens":1}}}),
            &mut a,
        );
        sniff(
            &json!({"type":"message_delta","usage":{"output_tokens":99}}),
            &mut a,
        );
        let line = a
            .finish(
                "m",
                0,
                "anthropic_oauth",
                "anthropic",
                RequestStatus::Success,
            )
            .unwrap();
        assert_eq!(line.completion_tokens, 99);
    }

    #[test]
    fn zero_output_delta_does_not_wipe_message_start_output() {
        // A trailing message_delta with output_tokens:0 must keep message_start's value.
        let mut a = UsageAcc::default();
        sniff(
            &json!({"type":"message_start","message":{"id":"x","usage":{"output_tokens":42}}}),
            &mut a,
        );
        sniff(
            &json!({"type":"message_delta","usage":{"output_tokens":0}}),
            &mut a,
        );
        let line = a
            .finish(
                "m",
                0,
                "anthropic_oauth",
                "anthropic",
                RequestStatus::Success,
            )
            .unwrap();
        assert_eq!(
            line.completion_tokens, 42,
            "zero delta must not wipe output"
        );
    }

    #[test]
    fn zero_cache_delta_does_not_wipe_message_start_cache() {
        // A delta re-sending cache fields as 0 must keep the message_start values.
        let mut a = UsageAcc::default();
        sniff(
            &json!({"type":"message_start","message":{"id":"x","usage":{
                "input_tokens":100,
                "cache_read_input_tokens":40,
                "cache_creation_input_tokens":20
            }}}),
            &mut a,
        );
        sniff(
            &json!({"type":"message_delta","usage":{
                "output_tokens":7,
                "cache_read_input_tokens":0,
                "cache_creation_input_tokens":0
            }}),
            &mut a,
        );
        let line = a
            .finish(
                "m",
                0,
                "anthropic_oauth",
                "anthropic",
                RequestStatus::Success,
            )
            .unwrap();
        assert_eq!(line.cache_read, 40, "zero delta must not wipe cache_read");
        assert_eq!(line.cache_write, 20, "zero delta must not wipe cache_write");
        assert_eq!(line.completion_tokens, 7);
    }

    #[test]
    fn nonzero_cache_delta_still_overrides() {
        // A delta with a real (>0) cache value still updates the accumulator.
        let mut a = UsageAcc::default();
        sniff(
            &json!({"type":"message_start","message":{"id":"x","usage":{"cache_read_input_tokens":40}}}),
            &mut a,
        );
        sniff(
            &json!({"type":"message_delta","usage":{"cache_read_input_tokens":55}}),
            &mut a,
        );
        let line = a
            .finish(
                "m",
                0,
                "anthropic_oauth",
                "anthropic",
                RequestStatus::Success,
            )
            .unwrap();
        assert_eq!(line.cache_read, 55);
    }

    #[test]
    fn message_start_populates_cache_fields() {
        let mut a = UsageAcc::default();
        sniff(
            &json!({"type":"message_start","message":{"id":"msg_2","usage":{
                "input_tokens":100,
                "cache_read_input_tokens":40,
                "cache_creation_input_tokens":20
            }}}),
            &mut a,
        );
        let line = a
            .finish(
                "m",
                750,
                "anthropic_oauth",
                "anthropic",
                RequestStatus::Success,
            )
            .unwrap();
        assert_eq!(line.cache_read, 40);
        assert_eq!(line.cache_write, 20);
        assert_eq!(line.response_id.unwrap(), "msg_2");
    }

    #[test]
    fn append_usage_swallows_bad_path() {
        let line = fixture_line();
        // Non-existent directory — must not panic.
        append_usage(
            Path::new("/nonexistent/dir/that/cannot/exist/usage.jsonl"),
            &line,
        );
    }

    #[test]
    fn finish_returns_none_when_only_non_usage_events_seen() {
        let mut a = UsageAcc::default();
        sniff(&json!({"type":"ping"}), &mut a);
        sniff(
            &json!({"type":"content_block_start","content_block":{"type":"text"}}),
            &mut a,
        );
        assert!(a
            .finish(
                "model",
                0,
                "anthropic_oauth",
                "anthropic",
                RequestStatus::Success
            )
            .is_none());
    }

    #[test]
    fn failure_status_serializes_to_wire() {
        let mut a = UsageAcc::default();
        sniff(
            &json!({"type":"message_start","message":{"id":"x","usage":{"input_tokens":1}}}),
            &mut a,
        );
        let line = a
            .finish(
                "m",
                0,
                "anthropic_apikey",
                "anthropic",
                RequestStatus::Failure,
            )
            .unwrap();
        assert_eq!(line.status, "failure");
    }

    #[test]
    fn response_id_falls_back_to_gen_id_when_message_id_absent() {
        let mut a = UsageAcc::default();
        sniff(
            &json!({"type":"message_start","id":"gen-xyz","message":{"usage":{"input_tokens":1}}}),
            &mut a,
        );
        let line = a
            .finish("m", 0, "openrouter", "openrouter", RequestStatus::Success)
            .unwrap();
        assert_eq!(line.response_id.as_deref(), Some("gen-xyz"));
        assert_eq!(line.gen_id.as_deref(), Some("gen-xyz"));
    }

    #[test]
    fn message_id_preferred_over_gen_id_for_response_id() {
        let mut a = UsageAcc::default();
        sniff(
            &json!({"type":"message_start","id":"gen-xyz","message":{"id":"msg_1","usage":{"input_tokens":1}}}),
            &mut a,
        );
        let line = a
            .finish("m", 0, "openrouter", "openrouter", RequestStatus::Success)
            .unwrap();
        assert_eq!(line.response_id.as_deref(), Some("msg_1"));
        assert_eq!(line.gen_id.as_deref(), Some("gen-xyz"));
    }
}
