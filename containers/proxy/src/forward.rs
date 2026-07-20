use std::sync::Arc;

use axum::{
    body::Body,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use bytes::Bytes;
use serde_json::json;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;

use crate::audit;
use crate::pii::{self, PiiEngineState};
use crate::router::{resolve, Auth, BareAuth, Config, Scheme};
use crate::usage::{append_usage, sniff, RequestStatus, UsageAcc};

/// Cap on the SSE sniff buffer. A partial line past this is not a real usage
/// frame; drop it so a newline-free upstream cannot grow the buffer unbounded.
const MAX_SNIFF_BUF: usize = 1024 * 1024;

/// Drops the sniff buffer if a not-yet-complete line exceeds `max`. Keeps RAM
/// flat against a newline-free upstream; the verbatim byte relay is separate.
fn bound_sniff_buffer(buf: &mut String, max: usize) {
    if buf.len() > max {
        buf.clear();
    }
}

/// True when the upstream response body is an SSE stream (`Content-Type:
/// text/event-stream`, parameters and case tolerated) — selects the rewrite arm.
fn is_event_stream(headers: &HeaderMap) -> bool {
    headers
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|ct| {
            ct.trim_start()
                .to_ascii_lowercase()
                .starts_with("text/event-stream")
        })
}

/// Drain all complete (`\n`-terminated) lines from `buf`, CRLF-stripped.
/// Any remaining incomplete line stays in `buf`.
pub(crate) fn drain_complete_lines(buf: &mut String) -> Vec<String> {
    let mut lines = Vec::new();
    while let Some(pos) = buf.find('\n') {
        let line = buf[..pos].trim_end_matches('\r').to_string();
        *buf = buf[pos + 1..].to_string();
        lines.push(line);
    }
    lines
}

/// Build the outbound `HeaderMap`: passthrough copies auth verbatim; swap drops
/// inbound auth and injects the provider key from `/tokens` (ADR-073 contract).
pub fn outbound_headers(auth: &Auth, inbound: &HeaderMap) -> HeaderMap {
    outbound_headers_with(auth, inbound, crate::keys::provider_key_for_env_name)
}

/// Testable variant — `lookup` provides the provider key for swap legs.
pub fn outbound_headers_with(
    auth: &Auth,
    inbound: &HeaderMap,
    lookup: impl Fn(&str) -> Option<String>,
) -> HeaderMap {
    let mut out = HeaderMap::new();

    match auth {
        Auth::Bare(BareAuth::Passthrough) => {
            // Copy auth and Anthropic headers verbatim — inject nothing.
            for name in &[
                "authorization",
                "x-api-key",
                "anthropic-beta",
                "anthropic-version",
                "content-type",
            ] {
                if let Some(v) = inbound.get(*name) {
                    out.insert(axum::http::header::HeaderName::from_static(name), v.clone());
                }
            }
        }
        Auth::Bare(BareAuth::None) => {
            // Local server, no key: drop inbound auth, keep non-auth headers,
            // inject nothing.
            for name in &["anthropic-version", "content-type"] {
                if let Some(v) = inbound.get(*name) {
                    out.insert(axum::http::header::HeaderName::from_static(name), v.clone());
                }
            }
        }
        Auth::Swap { env, scheme } => {
            // Drop inbound auth (client sends a dummy bearer on non-Anthropic legs).
            // Keep non-auth Anthropic headers.
            for name in &["anthropic-version", "content-type"] {
                if let Some(v) = inbound.get(*name) {
                    out.insert(axum::http::header::HeaderName::from_static(name), v.clone());
                }
            }
            // Inject real provider key according to scheme.
            match (scheme, lookup(env)) {
                (Scheme::Bearer, Some(key)) => {
                    let value = format!("Bearer {key}");
                    if let Ok(v) = value.parse() {
                        out.insert(axum::http::header::AUTHORIZATION, v);
                    }
                }
                (Scheme::Bearer, None) => {
                    // Key absent or env name tampered — forward with NO auth (the
                    // provider answers 401). Surface it; env name only, never a value.
                    log::warn!("swap leg: no provider key for {env}; forwarding without auth");
                }
                (Scheme::None, _) => {
                    // Local servers accept any/none — no auth header expected.
                }
            }
        }
    }

    out
}

/// Rewrites the parsed body's `model` to drop the route prefix (`local/foo` →
/// `foo`); returns `body` unchanged when no prefix or re-serialisation fails.
fn strip_model_prefix(body: &[u8], parsed: &serde_json::Value, model: &str) -> Vec<u8> {
    let Some((_, bare)) = model.split_once('/') else {
        return body.to_vec();
    };
    let mut v = parsed.clone();
    if let Some(m) = v.get_mut("model") {
        *m = serde_json::Value::String(bare.to_string());
    }
    serde_json::to_vec(&v).unwrap_or_else(|_| body.to_vec())
}

/// Host[:port] of an upstream `base_url` — scheme and path stripped. Never the
/// full URL (no path/query), so the traffic log carries no key-bearing suffix.
fn upstream_host(base_url: &str) -> &str {
    let after_scheme = base_url
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(base_url);
    after_scheme.split('/').next().unwrap_or(after_scheme)
}

/// One-line inbound traffic record: routing metadata only, no auth/body.
fn format_req_log(
    model: &str,
    prefix: &str,
    provider_kind: &str,
    provider_id: &str,
    base_url: &str,
) -> String {
    format!(
        "proxy req: model='{model}' prefix='{prefix}' provider={provider_kind}/{provider_id} → {}",
        upstream_host(base_url)
    )
}

/// One-line outbound traffic record: status, latency, sniffed token counts.
/// Absent counts render as `-` (count_tokens shim, errors, unpriced).
fn format_resp_log(
    model: &str,
    status: u16,
    latency_ms: u64,
    prompt_tokens: Option<u64>,
    completion_tokens: Option<u64>,
) -> String {
    let fmt = |t: Option<u64>| t.map(|n| n.to_string()).unwrap_or_else(|| "-".to_string());
    format!(
        "proxy resp: model='{model}' status={status} latency={latency_ms}ms in={} out={}",
        fmt(prompt_tokens),
        fmt(completion_tokens)
    )
}

/// Terminal status for a forwarded request: failure on an upstream ≥400 or a
/// byte stream that errored mid-flight, success otherwise.
fn resolve_request_status(status_code: u16, stream_errored: bool) -> RequestStatus {
    if status_code >= 400 || stream_errored {
        RequestStatus::Failure
    } else {
        RequestStatus::Success
    }
}

/// Resolve the route, forward with swapped/verbatim headers, relay the SSE byte
/// stream unbuffered while sniffing usage, and append one usage line on end.
pub async fn messages(State(cfg): State<Arc<Config>>, headers: HeaderMap, body: Bytes) -> Response {
    // Parse the body once: the model selects the backend route, the same
    // parsed value is reused (now PII-scanned) to strip the route prefix before forwarding.
    let mut parsed = match serde_json::from_slice::<serde_json::Value>(&body) {
        Ok(v) => v,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"error":"request body is not valid JSON"})),
            )
                .into_response();
        }
    };

    // Fail-closed (ADR-073 F4): a broken PII engine must never let cleartext forward.
    let (policy, key) = match cfg.pii.as_ref() {
        PiiEngineState::Ready { policy, key } => (policy, key),
        PiiEngineState::Failed(reason) => {
            log::error!("PII engine unavailable, rejecting /v1/messages: {reason}");
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({"error": "PII policy engine unavailable"})),
            )
                .into_response();
        }
    };
    let detections = match pii::scan_request(policy, key, &mut parsed) {
        Ok(d) => d,
        Err(e) => {
            log::error!("PII scan failed, rejecting /v1/messages: {e}");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "PII scan failed"})),
            )
                .into_response();
        }
    };
    audit::write_pii_audit(cfg.audit_dir.as_deref(), &detections);

    // Re-serialize the scanned value: this, not the original raw bytes, is what forwards.
    let scanned_body = match serde_json::to_vec(&parsed) {
        Ok(b) => b,
        Err(e) => {
            log::error!("failed to serialize scanned request body: {e}");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "failed to serialize scanned request"})),
            )
                .into_response();
        }
    };

    let model = parsed
        .get("model")
        .and_then(|m| m.as_str())
        .unwrap_or("")
        .to_string();

    let route = match resolve(&cfg, &model) {
        Some(r) => r,
        None => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({"error": format!("no route for model: {model}")})),
            )
                .into_response();
        }
    };

    log::info!(
        "{}",
        format_req_log(
            &model,
            &route.prefix,
            &route.provider_kind,
            &route.provider_id,
            &route.base_url
        )
    );

    let out_headers = outbound_headers(&route.auth, &headers);
    let upstream_url = format!("{}/v1/messages", route.base_url);
    // Strip the route prefix so the backend sees its own model name (the
    // anthropic passthrough has no prefix and is untouched).
    let outbound_body = strip_model_prefix(&scanned_body, &parsed, &model);
    // Owned copies for the spawned relay task (outlives the `cfg` borrow).
    let provider_kind = route.provider_kind.clone();
    let provider_id = route.provider_id.clone();

    // Shared client (built once with no-redirect — SSRF, ADR-041); clone is cheap.
    let client = cfg.client.clone();

    let mut req = client.post(&upstream_url).body(outbound_body);
    for (name, value) in &out_headers {
        req = req.header(name, value);
    }

    // Clock starts before send() so latency includes connect + TTFT, not just body.
    let start = std::time::Instant::now();
    let upstream = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({"error": format!("upstream error: {e}")})),
            )
                .into_response();
        }
    };

    let status = upstream.status();
    // Surface backend rejections at the proxy (model name only, never a key or
    // body) — else a 401/403/5xx only shows up in the Claude Code logs.
    if status.as_u16() >= 400 {
        log::warn!(
            "upstream {} for model '{}' via prefix '{}'",
            status.as_u16(),
            model,
            route.prefix
        );
    }
    let response_headers = upstream.headers().clone();
    let upstream_is_sse = is_event_stream(&response_headers);

    // Usage path resolved once at startup and stored in Config — no env read per request.
    let usage_path = cfg.usage_path.clone();
    let model_owned = model.clone();
    let status_code = status.as_u16();
    // Cheap Arc clone: the spawned task outlives this handler and needs its own handle to
    // unmask keywords and detokenize PII spans before the response reaches the agent (§5.1).
    let pii_state = cfg.pii.clone();

    // Channel-based relay: each upstream chunk is rewritten (keywords unmasked, PII spans
    // detokenized) then forwarded as soon as the rolling buffer judges it safe.
    let (tx, rx) = mpsc::channel::<Result<Bytes, std::io::Error>>(16);

    tokio::spawn(async move {
        let PiiEngineState::Ready { policy, key } = pii_state.as_ref() else {
            // Unreachable: `messages` already required `Ready` before ever calling upstream,
            // and the engine state never changes after startup. Fail closed rather than
            // forward a response nobody has rewritten.
            log::error!("PII engine unavailable for response rewrite; dropping stream");
            return;
        };
        let mut byte_stream = upstream.bytes_stream();
        let mut acc = UsageAcc::default();
        // Buffer for incomplete SSE lines across chunks (usage sniffing only).
        let mut line_buf = String::new();
        let mut rewrite_buffer = crate::rewrite::ResponseRewriter::new(upstream_is_sse);
        // Stream aborted mid-flight (upstream byte error, or a detokenization failure) →
        // failure, even on a 2xx.
        let mut stream_errored = false;
        // The client dropped the connection — stop pushing, and skip the final flush send.
        let mut client_disconnected = false;

        use futures_util::StreamExt;
        while let Some(chunk) = byte_stream.next().await {
            match chunk {
                Ok(bytes) => {
                    // Sniff SSE frames from the original chunk — unaffected by the rewrite
                    // below, since usage numbers reflect what the upstream actually billed.
                    if let Ok(text) = std::str::from_utf8(&bytes) {
                        line_buf.push_str(text);
                        for line in drain_complete_lines(&mut line_buf) {
                            if let Some(data) = line.strip_prefix("data: ") {
                                if data != "[DONE]" {
                                    if let Ok(frame) =
                                        serde_json::from_str::<serde_json::Value>(data)
                                    {
                                        sniff(&frame, &mut acc);
                                        crate::usage::note_first_text_delta(
                                            &frame, start, &mut acc,
                                        );
                                    }
                                }
                            }
                        }
                        // Only sniffing is bounded; the rewrite buffer below is separate.
                        bound_sniff_buffer(&mut line_buf, MAX_SNIFF_BUF);
                    }
                    // Unmask keywords then detokenize PII spans (§5.1/§7.2/§7.3) on decoded
                    // event text — a span split across SSE delta events still matches.
                    let forward_bytes =
                        match rewrite_buffer.push_chunk(&bytes, policy.keywords(), key) {
                            Ok(b) => b,
                            Err(e) => {
                                log::error!("response rewrite failed mid-stream, aborting: {e}");
                                let _ = tx.send(Err(std::io::Error::other(e.to_string()))).await;
                                stream_errored = true;
                                break;
                            }
                        };
                    if !forward_bytes.is_empty()
                        && tx.send(Ok(Bytes::from(forward_bytes))).await.is_err()
                    {
                        client_disconnected = true;
                        break; // Client disconnected.
                    }
                }
                Err(e) => {
                    let _ = tx.send(Err(std::io::Error::other(e.to_string()))).await;
                    stream_errored = true;
                    break;
                }
            }
        }

        if !stream_errored && !client_disconnected {
            match rewrite_buffer.finish(policy.keywords(), key) {
                Ok(remaining) if !remaining.is_empty() => {
                    let _ = tx.send(Ok(Bytes::from(remaining))).await;
                }
                Ok(_) => {}
                Err(e) => {
                    log::error!("PII detokenization failed flushing response tail: {e}");
                    stream_errored = true;
                }
            }
        }

        let latency_ms = start.elapsed().as_millis() as u64;
        let req_status = resolve_request_status(status_code, stream_errored);
        let (in_tok, out_tok) = if acc.saw_usage {
            (Some(acc.prompt_tokens), Some(acc.completion_tokens))
        } else {
            (None, None)
        };
        log::info!(
            "{}",
            format_resp_log(&model_owned, status_code, latency_ms, in_tok, out_tok)
        );
        if let Some(line) = acc.finish(
            &model_owned,
            latency_ms,
            &provider_kind,
            &provider_id,
            req_status,
        ) {
            append_usage(&usage_path, &line);
        }
        // tx is dropped here; ReceiverStream terminates cleanly.
    });

    let stream = ReceiverStream::new(rx);
    let mut builder = Response::builder().status(status);
    // Forward upstream headers (content-type, etc.), minus hop-by-hop ones —
    // axum re-frames the body, so relaying them corrupts the client transfer.
    for (name, value) in &response_headers {
        if !is_hop_by_hop(name.as_str()) {
            builder = builder.header(name, value);
        }
    }
    builder
        .body(Body::from_stream(stream))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

/// Connection-specific headers that must not be relayed end-to-end (RFC 7230 §6.1).
fn is_hop_by_hop(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
    )
}

#[cfg(test)]
mod tests {
    #![expect(
        clippy::unwrap_used,
        reason = "test fixture setup, failure aborts the test"
    )]
    use super::*;

    #[test]
    fn hop_by_hop_headers_are_filtered_case_insensitively() {
        assert!(is_hop_by_hop("connection"));
        assert!(is_hop_by_hop("Transfer-Encoding"));
        assert!(is_hop_by_hop("Keep-Alive"));
        assert!(is_hop_by_hop("UPGRADE"));
        assert!(!is_hop_by_hop("content-type"));
        assert!(!is_hop_by_hop("anthropic-version"));
    }

    #[test]
    fn upstream_host_strips_scheme_and_path() {
        assert_eq!(
            upstream_host("http://10.155.3.101:4000"),
            "10.155.3.101:4000"
        );
        assert_eq!(
            upstream_host("https://api.openrouter.ai/api/v1"),
            "api.openrouter.ai"
        );
        assert_eq!(
            upstream_host("http://host:8080/v1/messages?x=1"),
            "host:8080"
        );
        // No scheme — return as-is up to the first slash.
        assert_eq!(upstream_host("barehost:9000/x"), "barehost:9000");
    }

    #[test]
    fn req_log_has_routing_metadata_and_no_secret() {
        let line = format_req_log(
            "openrouter/z-ai/glm-5.2",
            "openrouter",
            "open_router",
            "openrouter",
            "https://api.openrouter.ai/api/v1",
        );
        assert!(line.contains("model='openrouter/z-ai/glm-5.2'"), "{line}");
        assert!(line.contains("prefix='openrouter'"), "{line}");
        assert!(line.contains("provider=open_router/openrouter"), "{line}");
        assert!(line.contains("api.openrouter.ai"), "{line}");
        // Host only — never the full URL path.
        assert!(
            !line.contains("/api/v1"),
            "req log must not carry the URL path: {line}"
        );
    }

    #[test]
    fn resp_log_carries_status_latency_and_tokens() {
        let line = format_resp_log("local/qwen3", 200, 1234, Some(50), Some(7));
        assert!(line.contains("status=200"), "{line}");
        assert!(line.contains("latency=1234ms"), "{line}");
        assert!(line.contains("in=50"), "{line}");
        assert!(line.contains("out=7"), "{line}");
        assert!(line.contains("model='local/qwen3'"), "{line}");
    }

    #[test]
    fn resp_log_renders_absent_tokens_as_dash() {
        let line = format_resp_log("claude-opus-4-8", 400, 90, None, None);
        assert!(line.contains("status=400"), "{line}");
        assert!(
            line.contains("in=- out=-"),
            "unpriced/no-usage → dashes: {line}"
        );
    }

    #[test]
    fn strip_model_prefix_removes_route_prefix() {
        let body = br#"{"model":"local/unsloth/Qwen3.6","max_tokens":16}"#;
        let parsed = serde_json::from_slice(body).unwrap();
        let out = strip_model_prefix(body, &parsed, "local/unsloth/Qwen3.6");
        let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(v["model"], "unsloth/Qwen3.6");
        // Other fields survive the rewrite.
        assert_eq!(v["max_tokens"], 16);
    }

    #[test]
    fn strip_model_prefix_leaves_anthropic_untouched() {
        // No prefix (anthropic passthrough) → body byte-identical.
        let body = br#"{"model":"claude-opus-4-8","max_tokens":16}"#;
        let parsed = serde_json::from_slice(body).unwrap();
        let out = strip_model_prefix(body, &parsed, "claude-opus-4-8");
        assert_eq!(out, body.to_vec());
    }

    #[test]
    fn strip_model_prefix_only_drops_first_segment() {
        // openrouter/anthropic/claude-3.5 → anthropic/claude-3.5 (one level).
        let body = br#"{"model":"openrouter/anthropic/claude-3.5"}"#;
        let parsed = serde_json::from_slice(body).unwrap();
        let out = strip_model_prefix(body, &parsed, "openrouter/anthropic/claude-3.5");
        let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(v["model"], "anthropic/claude-3.5");
    }

    #[test]
    fn passthrough_forwards_oauth_bearer_verbatim() {
        let mut h = HeaderMap::new();
        h.insert("authorization", "Bearer sk-ant-oat-REAL".parse().unwrap());
        let out = outbound_headers(&Auth::Bare(BareAuth::Passthrough), &h);
        assert_eq!(out.get("authorization").unwrap(), "Bearer sk-ant-oat-REAL");
    }

    #[test]
    fn swap_drops_dummy_and_injects_provider_key() {
        let mut h = HeaderMap::new();
        h.insert(
            "authorization",
            "Bearer sk-no-key-required".parse().unwrap(),
        );
        h.insert("x-api-key", "sk-no-key-required".parse().unwrap());
        let auth = Auth::Swap {
            env: "SPW_KEY_OPENROUTER".into(),
            scheme: Scheme::Bearer,
        };
        let out = outbound_headers_with(&auth, &h, |_| Some("or-REALKEY".into()));
        assert_eq!(out.get("authorization").unwrap(), "Bearer or-REALKEY");
        assert!(
            out.get("x-api-key").is_none(),
            "x-api-key must not be forwarded on a Swap leg"
        );
    }

    #[test]
    fn passthrough_never_injects_a_stored_key() {
        let out = outbound_headers(&Auth::Bare(BareAuth::Passthrough), &HeaderMap::new());
        assert!(out.get("authorization").is_none() && out.get("x-api-key").is_none());
    }

    #[test]
    fn swap_bearer_with_no_key_drops_dummy_and_injects_nothing() {
        // Missing/tampered key: dummy auth dropped, no real key available → the
        // request forwards with NO authorization header (provider answers 401).
        let mut h = HeaderMap::new();
        h.insert(
            "authorization",
            "Bearer sk-no-key-required".parse().unwrap(),
        );
        h.insert("x-api-key", "sk-no-key-required".parse().unwrap());
        let auth = Auth::Swap {
            env: "SPW_KEY_OPENROUTER".into(),
            scheme: Scheme::Bearer,
        };
        let out = outbound_headers_with(&auth, &h, |_| None);
        assert!(
            out.get("authorization").is_none(),
            "no key → no Bearer header (dummy must not leak through)"
        );
        assert!(out.get("x-api-key").is_none());
    }

    #[test]
    fn swap_scheme_none_drops_dummy_and_injects_no_auth_header() {
        let mut h = HeaderMap::new();
        h.insert(
            "authorization",
            "Bearer sk-no-key-required".parse().unwrap(),
        );
        h.insert("x-api-key", "sk-no-key-required".parse().unwrap());
        let auth = Auth::Swap {
            env: "SPW_KEY_LOCAL".into(),
            scheme: Scheme::None,
        };
        let out = outbound_headers_with(&auth, &h, |_| Some("local-key".into()));
        assert!(out.get("authorization").is_none());
        assert!(
            out.get("x-api-key").is_none(),
            "x-api-key must not be forwarded on a Swap/None leg"
        );
    }

    #[test]
    fn passthrough_copies_all_anthropic_headers() {
        let mut h = HeaderMap::new();
        h.insert("authorization", "Bearer sk-ant-oat-REAL".parse().unwrap());
        h.insert("x-api-key", "sk-ant-key".parse().unwrap());
        h.insert("anthropic-beta", "messages-2023-12-15".parse().unwrap());
        h.insert("anthropic-version", "2023-06-01".parse().unwrap());
        h.insert("content-type", "application/json".parse().unwrap());
        let out = outbound_headers(&Auth::Bare(BareAuth::Passthrough), &h);
        assert_eq!(out.get("authorization").unwrap(), "Bearer sk-ant-oat-REAL");
        assert_eq!(out.get("x-api-key").unwrap(), "sk-ant-key");
        assert_eq!(out.get("anthropic-beta").unwrap(), "messages-2023-12-15");
        assert_eq!(out.get("anthropic-version").unwrap(), "2023-06-01");
        assert_eq!(out.get("content-type").unwrap(), "application/json");
    }

    #[test]
    fn swap_keeps_non_auth_anthropic_headers() {
        let mut h = HeaderMap::new();
        h.insert(
            "authorization",
            "Bearer sk-no-key-required".parse().unwrap(),
        );
        h.insert("anthropic-version", "2023-06-01".parse().unwrap());
        h.insert("content-type", "application/json".parse().unwrap());
        let auth = Auth::Swap {
            env: "SPW_KEY_OPENROUTER".into(),
            scheme: Scheme::Bearer,
        };
        let out = outbound_headers_with(&auth, &h, |_| Some("or-REALKEY".into()));
        assert_eq!(out.get("anthropic-version").unwrap(), "2023-06-01");
        assert_eq!(out.get("content-type").unwrap(), "application/json");
        assert_eq!(out.get("authorization").unwrap(), "Bearer or-REALKEY");
    }

    /// A `data: {...}` SSE line split across two chunks must parse exactly
    /// once — no partial sniff on chunk 1, full parse on chunk 2's `\n`.
    #[test]
    fn split_sse_frame_across_chunks_parses_once() {
        let full_line = "data: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":42}}\n";
        // Split arbitrarily in the middle of the JSON payload.
        let split_at = full_line.find("\"output_to").unwrap();
        let chunk1 = &full_line[..split_at];
        let chunk2 = &full_line[split_at..];

        let mut buf = String::new();
        let mut acc = UsageAcc::default();

        // First chunk — no complete line yet.
        buf.push_str(chunk1);
        for line in drain_complete_lines(&mut buf) {
            if let Some(data) = line.strip_prefix("data: ") {
                if let Ok(frame) = serde_json::from_str::<serde_json::Value>(data) {
                    sniff(&frame, &mut acc);
                }
            }
        }
        assert_eq!(acc.completion_tokens, 0, "must not sniff before full line");

        // Second chunk — completes the line.
        buf.push_str(chunk2);
        for line in drain_complete_lines(&mut buf) {
            if let Some(data) = line.strip_prefix("data: ") {
                if let Ok(frame) = serde_json::from_str::<serde_json::Value>(data) {
                    sniff(&frame, &mut acc);
                }
            }
        }
        assert_eq!(acc.completion_tokens, 42, "must parse full frame once");
        assert!(
            buf.is_empty(),
            "buffer must be empty after complete line consumed"
        );
    }

    #[test]
    fn sniff_buffer_is_bounded_against_newlineless_stream() {
        let max = 64;
        let mut buf = String::new();
        // No newline: drain yields nothing, buffer would grow unbounded.
        buf.push_str(&"x".repeat(max + 10));
        assert!(drain_complete_lines(&mut buf).is_empty());
        bound_sniff_buffer(&mut buf, max);
        assert!(buf.is_empty(), "over-cap partial line must be dropped");

        // A partial line UNDER the cap is preserved (real split frame).
        buf.push_str("data: {\"type\":\"mes");
        bound_sniff_buffer(&mut buf, max);
        assert_eq!(
            buf, "data: {\"type\":\"mes",
            "under-cap partial must survive"
        );
    }

    #[test]
    fn sniff_recovers_after_buffer_reset() {
        let max = 64;
        let mut buf = String::new();
        let mut acc = UsageAcc::default();
        buf.push_str(&"y".repeat(max + 10));
        bound_sniff_buffer(&mut buf, max);
        // A complete frame after the reset still parses.
        buf.push_str("data: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":7}}\n");
        for line in drain_complete_lines(&mut buf) {
            if let Some(data) = line.strip_prefix("data: ") {
                if let Ok(frame) = serde_json::from_str::<serde_json::Value>(data) {
                    sniff(&frame, &mut acc);
                }
            }
        }
        assert_eq!(acc.completion_tokens, 7, "sniffing must resume after reset");
    }

    #[test]
    fn request_status_failure_on_4xx_5xx_or_abort() {
        assert_eq!(resolve_request_status(200, false), RequestStatus::Success);
        assert_eq!(resolve_request_status(200, true), RequestStatus::Failure);
        assert_eq!(resolve_request_status(401, false), RequestStatus::Failure);
        assert_eq!(resolve_request_status(429, false), RequestStatus::Failure);
        assert_eq!(resolve_request_status(500, false), RequestStatus::Failure);
        assert_eq!(resolve_request_status(503, true), RequestStatus::Failure);
    }

    #[test]
    fn is_event_stream_matches_content_type_with_params_and_case() {
        let mut headers = HeaderMap::new();
        assert!(
            !is_event_stream(&headers),
            "missing content-type is not SSE"
        );

        headers.insert("content-type", "application/json".parse().unwrap());
        assert!(!is_event_stream(&headers));

        headers.insert("content-type", "text/event-stream".parse().unwrap());
        assert!(is_event_stream(&headers));

        headers.insert(
            "content-type",
            "Text/Event-Stream; charset=utf-8".parse().unwrap(),
        );
        assert!(is_event_stream(&headers), "params and case are tolerated");
    }
}
