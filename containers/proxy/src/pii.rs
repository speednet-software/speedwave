//! Native PII engine state (ADR-073 F4): fail-closed load at startup, scans `system` +
//! `messages[].content` before every forward using the same crate the hub wraps in wasm.

use std::path::Path;

use rand::RngCore;
use speedwave_pii_engine::{
    alias_text, compile_policy_v3, default_policy_json, detokenize_text, detokenize_text_with,
    incomplete_token_span_start, scan_json, unalias_text_preserving_tokens,
    unalias_text_preserving_tokens_with, CompiledKeyword, CompiledPolicy, Detection,
    DetokenizeError, EngineKey, ScanError,
};

/// Loaded PII engine state: ready to scan, or a fatal load error. `Failed` is surfaced by
/// every `/v1/messages` call as a 5xx: never a silent fallback to an unscanned forward.
pub enum PiiEngineState {
    Ready {
        policy: CompiledPolicy,
        key: EngineKey,
    },
    Failed(String),
}

/// Loads the engine from `POLICY_FILE` (+ sibling `key` file) when set, else the compiled-in
/// default policy with an ephemeral per-process key (dev / no-`POLICY_FILE` mode).
pub fn load_engine_state() -> std::sync::Arc<PiiEngineState> {
    std::sync::Arc::new(load_engine_state_from_env(
        std::env::var("POLICY_FILE").ok(),
    ))
}

fn load_engine_state_from_env(policy_file: Option<String>) -> PiiEngineState {
    match policy_file {
        Some(path) => load_from_file(Path::new(&path)),
        None => default_state(),
    }
}

fn default_state() -> PiiEngineState {
    match compile_policy_v3(&default_policy_json()) {
        Ok(policy) => PiiEngineState::Ready {
            policy,
            key: ephemeral_key(),
        },
        Err(e) => PiiEngineState::Failed(format!("default policy failed to compile: {e}")),
    }
}

/// 32 random bytes per process: only reached when `POLICY_FILE` is unset (dev/fail-safe);
/// production always supplies a persistent key via `POLICY_FILE`'s sibling `key` file.
fn ephemeral_key() -> EngineKey {
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    EngineKey::from_bytes(bytes)
}

/// Reads and compiles `policy_file` plus its sibling `key` file (mirrors
/// `engine.ts::resolvePolicyAndKey`); any failure is `Failed`, never a silent default.
fn load_from_file(policy_file: &Path) -> PiiEngineState {
    let policy_json = match std::fs::read_to_string(policy_file) {
        Ok(s) => s,
        Err(e) => {
            return PiiEngineState::Failed(format!(
                "reading policy file '{}': {e}",
                policy_file.display()
            ))
        }
    };
    let policy = match compile_policy_v3(&policy_json) {
        Ok(p) => p,
        Err(e) => {
            return PiiEngineState::Failed(format!(
                "compiling policy file '{}': {e}",
                policy_file.display()
            ))
        }
    };
    let Some(key_path) = policy_file.parent().map(|p| p.join("key")) else {
        return PiiEngineState::Failed(format!(
            "policy file '{}' has no parent directory",
            policy_file.display()
        ));
    };
    let key_hex = match std::fs::read_to_string(&key_path) {
        Ok(s) => s,
        Err(e) => {
            return PiiEngineState::Failed(format!(
                "reading policy key '{}': {e}",
                key_path.display()
            ))
        }
    };
    match EngineKey::from_hex(key_hex.trim()) {
        Ok(key) => PiiEngineState::Ready { policy, key },
        Err(e) => {
            PiiEngineState::Failed(format!("decoding policy key '{}': {e}", key_path.display()))
        }
    }
}

/// Merges one scan call's detections into a per-(category, action) running aggregate.
fn merge_detections(agg: &mut Vec<Detection>, more: Vec<Detection>) {
    for d in more {
        if let Some(existing) = agg
            .iter_mut()
            .find(|e| e.category == d.category && e.action == d.action)
        {
            existing.count += d.count;
        } else {
            agg.push(d);
        }
    }
}

/// Scans `system` and every `messages[].content` (tool results included); other protocol
/// fields are untouched. An `Err` may leave `body` partially mutated. The caller must discard it.
///
/// Each scanned subtree is then keyword-masked (design doc §7.3): masking runs strictly after
/// tokenization so a keyword occurring inside a value that also matched a PII rule is already
/// sealed behind a token span and cannot be re-exposed by the keyword pass.
pub fn scan_request(
    policy: &CompiledPolicy,
    key: &EngineKey,
    body: &mut serde_json::Value,
) -> Result<Vec<Detection>, ScanError> {
    let mut detections = Vec::new();
    if let Some(system) = body.get_mut("system") {
        merge_detections(&mut detections, scan_json(policy, key, system)?);
        mask_keywords(system, policy.keywords());
    }
    if let Some(messages) = body.get_mut("messages").and_then(|m| m.as_array_mut()) {
        for message in messages.iter_mut() {
            if let Some(content) = message.get_mut("content") {
                merge_detections(&mut detections, scan_json(policy, key, content)?);
                mask_keywords(content, policy.keywords());
            }
        }
    }
    Ok(detections)
}

/// Masks every configured keyword to its alias across `value`'s string leaves, case-pattern
/// preserving via `alias_text`. A no-op when `keywords` is empty.
fn mask_keywords(value: &mut serde_json::Value, keywords: &[CompiledKeyword]) {
    for keyword in keywords {
        let fields_modified = mask_keyword_value(value, keyword);
        if fields_modified > 0 {
            log::debug!(
                "keyword mask: alias='{}' fields_modified={fields_modified}",
                keyword.alias
            );
        }
    }
}

/// Applies one keyword's substitution recursively over string leaves; returns how many
/// leaves it changed. Never logs or returns the matched text itself, only a count.
fn mask_keyword_value(value: &mut serde_json::Value, keyword: &CompiledKeyword) -> u32 {
    match value {
        serde_json::Value::String(s) => {
            let masked = alias_text(
                s,
                &keyword.match_text,
                &keyword.alias,
                keyword.case_sensitive,
            );
            if masked == *s {
                0
            } else {
                *s = masked;
                1
            }
        }
        serde_json::Value::Array(items) => items
            .iter_mut()
            .map(|item| mask_keyword_value(item, keyword))
            .sum(),
        serde_json::Value::Object(map) => map
            .values_mut()
            .map(|v| mask_keyword_value(v, keyword))
            .sum(),
        _ => 0,
    }
}

/// Longest plausible PII token span held back at the tail of the streaming rewrite buffer:
/// `[` + a generous category id + `:TOKEN_` + base64url(AES-SIV ciphertext) + `]`. Built-in
/// categories (email, phone, IBAN, card, API key) top out well under 1 KiB; a custom rule
/// pattern matching an exceptionally long value (design doc has no upper bound on match
/// length) can still exceed this and would then surface as an undecrypted literal span
/// rather than a cleartext leak (see `ResponseRewriteBuffer` docs) — a practical bound, not
/// a mathematical guarantee.
const MAX_TOKEN_SPAN_LEN: usize = 4096;

/// Unmasks every configured keyword (alias → match) across `text`, skipping any already-
/// formed PII token span so a coincidental alias-shaped substring inside a token's
/// ciphertext is never touched. Mirrors `mask_keywords`; a no-op when `keywords` is empty.
pub fn unmask_keywords_text(text: &str, keywords: &[CompiledKeyword]) -> String {
    let mut result = text.to_string();
    for keyword in keywords {
        let unmasked = unalias_text_preserving_tokens(
            &result,
            &keyword.match_text,
            &keyword.alias,
            keyword.case_sensitive,
        );
        if unmasked != result {
            log::debug!("keyword unmask: alias='{}'", keyword.alias);
        }
        result = unmasked;
    }
    result
}

/// Full inbound response rewrite (design doc §5.1, §7.2/§7.3): keywords unmasked first
/// (alias → match), then PII token spans decrypted — the inverse of `scan_request`'s
/// tokenize-then-mask order. Fail-closed: a token failing SIV verification is an `Err`,
/// never a silent pass-through of the literal span.
pub fn unmask_and_detokenize_response(
    text: &str,
    keywords: &[CompiledKeyword],
    key: &EngineKey,
) -> Result<String, DetokenizeError> {
    let unmasked = unmask_keywords_text(text, keywords);
    detokenize_text(key, &unmasked)
}

/// Largest byte index `<= at` that lands on a UTF-8 character boundary of `s`.
fn floor_char_boundary(s: &str, at: usize) -> usize {
    let mut idx = at.min(s.len());
    while idx > 0 && !s.is_char_boundary(idx) {
        idx -= 1;
    }
    idx
}

/// Longest prefix of `text` that no potential token span or keyword alias can straddle:
/// transforming the prefix and the tail (plus any future text) independently equals one
/// whole-text pass. Typical text has no viable tail, so streaming adds no latency.
pub fn safe_prefix_len(text: &str, keywords: &[CompiledKeyword]) -> usize {
    let mut safe = text.len();
    if let Some(start) = incomplete_token_span_start(text) {
        // A pseudo-span tail longer than the practical bound is treated as plain text so a
        // bracket-heavy stream cannot pin the buffer forever.
        if text.len() - start <= MAX_TOKEN_SPAN_LEN {
            safe = safe.min(start);
        }
    }
    for keyword in keywords {
        safe = safe.min(alias_prefix_start(
            text,
            &keyword.alias,
            keyword.case_sensitive,
        ));
    }
    floor_char_boundary(text, safe)
}

/// Earliest byte offset whose suffix is a PROPER prefix of `alias` (a complete alias is
/// replaceable now and never held); `text.len()` when no suffix qualifies.
fn alias_prefix_start(text: &str, alias: &str, case_sensitive: bool) -> usize {
    let alias_chars: Vec<char> = alias.chars().collect();
    if alias_chars.len() < 2 {
        return text.len();
    }
    let positions: Vec<usize> = text.char_indices().map(|(b, _)| b).collect();
    let window = positions.len().saturating_sub(alias_chars.len() - 1);
    for &pos in &positions[window..] {
        if suffix_is_proper_alias_prefix(&text[pos..], &alias_chars, case_sensitive) {
            return pos;
        }
    }
    text.len()
}

/// True when `tail` is a non-empty proper prefix of the alias, honoring case sensitivity.
fn suffix_is_proper_alias_prefix(tail: &str, alias_chars: &[char], case_sensitive: bool) -> bool {
    let tail_chars: Vec<char> = tail.chars().collect();
    if tail_chars.is_empty() || tail_chars.len() >= alias_chars.len() {
        return false;
    }
    tail_chars.iter().zip(alias_chars).all(|(&t, &a)| {
        if case_sensitive {
            t == a
        } else {
            t.to_ascii_lowercase() == a.to_ascii_lowercase()
        }
    })
}

/// Escapes `s` as JSON-string content (no surrounding quotes) for insertion into text that
/// is itself serialized JSON, e.g. an `input_json_delta.partial_json` fragment.
fn json_string_escape(s: &str) -> String {
    let quoted = serde_json::Value::String(s.to_string()).to_string();
    quoted[1..quoted.len() - 1].to_string()
}

/// [`unmask_and_detokenize_response`] for serialized-JSON delta content: every inserted
/// replacement (keyword match text, decrypted plaintext) is JSON-string-escaped so the
/// reassembled `partial_json` stays parseable.
pub fn unmask_and_detokenize_json_fragment(
    text: &str,
    keywords: &[CompiledKeyword],
    key: &EngineKey,
) -> Result<String, DetokenizeError> {
    let mut result = text.to_string();
    for keyword in keywords {
        result = unalias_text_preserving_tokens_with(
            &result,
            &keyword.match_text,
            &keyword.alias,
            keyword.case_sensitive,
            &json_string_escape,
        );
    }
    detokenize_text_with(key, &result, &json_string_escape)
}

/// Accumulates a non-SSE response body and rewrites it once at stream end. SSE responses go
/// through the event-aware rewriter instead (`rewrite::SseRewriter`); a whole JSON body is
/// only parseable complete, so buffering it avoids splitting a match at an arbitrary cut.
#[derive(Default)]
pub struct ResponseRewriteBuffer {
    buffer: Vec<u8>,
}

impl ResponseRewriteBuffer {
    pub fn new() -> Self {
        Self::default()
    }

    /// Appends `chunk`; all output is deferred to [`Self::finish`]. Callers bound the total
    /// buffered size (`rewrite::ResponseRewriter` enforces the cap and fails closed).
    pub fn push_chunk(&mut self, chunk: &[u8]) -> usize {
        self.buffer.extend_from_slice(chunk);
        self.buffer.len()
    }

    /// Transforms and returns the whole accumulated body (fail-closed on a bad token).
    pub fn finish(
        self,
        keywords: &[CompiledKeyword],
        key: &EngineKey,
    ) -> Result<Vec<u8>, DetokenizeError> {
        if self.buffer.is_empty() {
            return Ok(Vec::new());
        }
        let text = String::from_utf8_lossy(&self.buffer);
        let transformed = unmask_and_detokenize_response(&text, keywords, key)?;
        Ok(transformed.into_bytes())
    }
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "test fixture setup, failure aborts the test"
)]
mod tests {
    use super::*;
    use serde_json::json;
    use speedwave_pii_engine::DetectionAction;

    fn test_policy_and_key() -> (CompiledPolicy, EngineKey) {
        let policy = compile_policy_v3(&default_policy_json()).expect("default policy compiles");
        (policy, EngineKey::from_bytes([9u8; 32]))
    }

    #[test]
    fn default_state_is_ready() {
        assert!(matches!(default_state(), PiiEngineState::Ready { .. }));
    }

    #[test]
    fn load_engine_state_from_env_none_is_ready_default() {
        assert!(matches!(
            load_engine_state_from_env(None),
            PiiEngineState::Ready { .. }
        ));
    }

    #[test]
    fn missing_policy_file_fails_closed() {
        let state = load_engine_state_from_env(Some("/nonexistent/policy.json".to_string()));
        assert!(matches!(state, PiiEngineState::Failed(_)));
    }

    #[test]
    fn malformed_policy_json_fails_closed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("policy.json");
        std::fs::write(&path, "not json").unwrap();
        assert!(matches!(load_from_file(&path), PiiEngineState::Failed(_)));
    }

    #[test]
    fn missing_key_file_fails_closed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("policy.json");
        std::fs::write(&path, default_policy_json()).unwrap();
        // No sibling "key" file written.
        assert!(matches!(load_from_file(&path), PiiEngineState::Failed(_)));
    }

    #[test]
    fn malformed_key_fails_closed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("policy.json");
        std::fs::write(&path, default_policy_json()).unwrap();
        std::fs::write(dir.path().join("key"), "not-hex").unwrap();
        assert!(matches!(load_from_file(&path), PiiEngineState::Failed(_)));
    }

    #[test]
    fn valid_policy_and_key_load_ready() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("policy.json");
        std::fs::write(&path, default_policy_json()).unwrap();
        std::fs::write(dir.path().join("key"), "ab".repeat(32)).unwrap();
        assert!(matches!(
            load_from_file(&path),
            PiiEngineState::Ready { .. }
        ));
    }

    #[test]
    fn scan_request_tokenizes_system_and_message_content() {
        let (policy, key) = test_policy_and_key();
        let mut body = json!({
            "model": "claude-x",
            "system": "Contact bob@example.com for details",
            "messages": [
                {"role": "user", "content": "Email me at alice@example.com"}
            ]
        });
        let detections = scan_request(&policy, &key, &mut body).unwrap();
        assert!(!body["system"].as_str().unwrap().contains("bob@example.com"));
        assert!(body["system"].as_str().unwrap().contains("[EMAIL:TOKEN_"));
        assert!(!body["messages"][0]["content"]
            .as_str()
            .unwrap()
            .contains("alice@example.com"));
        assert_eq!(
            body["model"], "claude-x",
            "protocol field must be untouched"
        );
        assert_eq!(
            body["messages"][0]["role"], "user",
            "role must be untouched"
        );
        let email = detections.iter().find(|d| d.category == "EMAIL").unwrap();
        assert_eq!(email.count, 2);
    }

    #[test]
    fn scan_request_scans_system_as_array_of_text_blocks() {
        let (policy, key) = test_policy_and_key();
        let mut body = json!({
            "system": [{"type": "text", "text": "contact dave@example.com for access"}],
            "messages": []
        });
        let detections = scan_request(&policy, &key, &mut body).unwrap();
        let text = body["system"][0]["text"].as_str().unwrap();
        assert!(!text.contains("dave@example.com"));
        assert!(text.contains("[EMAIL:TOKEN_"));
        assert_eq!(
            body["system"][0]["type"], "text",
            "block type must be untouched"
        );
        assert!(detections.iter().any(|d| d.category == "EMAIL"));
    }

    #[test]
    fn scan_request_scans_tool_result_content_blocks() {
        let (policy, key) = test_policy_and_key();
        let mut body = json!({
            "messages": [
                {"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": "toolu_1", "content": "found carol@example.com"}
                ]}
            ]
        });
        let detections = scan_request(&policy, &key, &mut body).unwrap();
        let content = &body["messages"][0]["content"][0]["content"];
        assert!(!content.as_str().unwrap().contains("carol@example.com"));
        assert_eq!(body["messages"][0]["content"][0]["type"], "tool_result");
        assert_eq!(body["messages"][0]["content"][0]["tool_use_id"], "toolu_1");
        assert!(detections.iter().any(|d| d.category == "EMAIL"));
    }

    #[test]
    fn scan_request_is_idempotent_for_already_tokenized_history() {
        let (policy, key) = test_policy_and_key();
        let mut first = json!({"messages": [{"role": "user", "content": "dan@example.com"}]});
        let first_detections = scan_request(&policy, &key, &mut first).unwrap();
        assert_eq!(first_detections.len(), 1);

        // Reuse the already-tokenized turn as history, add a new message with fresh PII.
        let mut second = json!({
            "messages": [
                first["messages"][0].clone(),
                {"role": "user", "content": "erin@example.com"}
            ]
        });
        let second_detections = scan_request(&policy, &key, &mut second).unwrap();
        let email = second_detections
            .iter()
            .find(|d| d.category == "EMAIL")
            .unwrap();
        assert_eq!(
            email.count, 1,
            "only the new value must be counted, not the replayed token"
        );
        assert_eq!(
            second["messages"][0], first["messages"][0],
            "already-tokenized history must be untouched"
        );
    }

    #[test]
    fn scan_request_missing_system_and_messages_is_a_noop() {
        let (policy, key) = test_policy_and_key();
        let mut body = json!({"model": "claude-x", "max_tokens": 16});
        let detections = scan_request(&policy, &key, &mut body).unwrap();
        assert!(detections.is_empty());
        assert_eq!(body, json!({"model": "claude-x", "max_tokens": 16}));
    }

    #[test]
    fn scan_request_handles_a_large_history_without_panicking() {
        let (policy, key) = test_policy_and_key();
        let messages: Vec<_> = (0..2000)
            .map(|i| json!({"role": "user", "content": format!("row {i} contact user{i}@example.com")}))
            .collect();
        let mut body = json!({"messages": messages});
        let detections = scan_request(&policy, &key, &mut body).unwrap();
        let email = detections.iter().find(|d| d.category == "EMAIL").unwrap();
        assert_eq!(email.count, 2000);
    }

    #[test]
    fn merge_detections_sums_counts_across_calls() {
        let mut agg = vec![Detection {
            category: "EMAIL".into(),
            action: DetectionAction::Tokenized,
            count: 2,
        }];
        merge_detections(
            &mut agg,
            vec![Detection {
                category: "EMAIL".into(),
                action: DetectionAction::Tokenized,
                count: 3,
            }],
        );
        assert_eq!(agg.len(), 1);
        assert_eq!(agg[0].count, 5);
    }

    // ── keyword masking: applied by scan_request after PII tokenization ──

    fn policy_with_keyword(match_text: &str, alias: &str, case_sensitive: bool) -> CompiledPolicy {
        let json = format!(
            r#"{{
                "version": 3,
                "source": {{ "policies": [], "forced": [] }},
                "rules": [],
                "keywords": [
                    {{ "match": "{match_text}", "alias": "{alias}", "caseSensitive": {case_sensitive} }}
                ]
            }}"#
        );
        compile_policy_v3(&json).expect("policy with one keyword compiles")
    }

    fn policy_with_email_rule_and_keyword(
        match_text: &str,
        alias: &str,
        case_sensitive: bool,
    ) -> CompiledPolicy {
        let json = format!(
            r#"{{
                "version": 3,
                "source": {{ "policies": [], "forced": [] }},
                "rules": [
                    {{ "id": "EMAIL", "displayName": "E-mail", "patterns": ["[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{{2,}}"], "caseSensitive": true, "tokenize": true, "log": false }}
                ],
                "keywords": [
                    {{ "match": "{match_text}", "alias": "{alias}", "caseSensitive": {case_sensitive} }}
                ]
            }}"#
        );
        compile_policy_v3(&json).expect("policy with EMAIL rule and one keyword compiles")
    }

    #[test]
    fn scan_request_masks_keyword_in_system_field() {
        let policy = policy_with_keyword("Globex", "BigCorp", true);
        let key = EngineKey::from_bytes([9u8; 32]);
        let mut body = json!({"system": "Acme purchased Globex today"});

        scan_request(&policy, &key, &mut body).unwrap();
        assert_eq!(body["system"], "Acme purchased BigCorp today");
    }

    #[test]
    fn scan_request_masks_keyword_case_insensitively_preserving_pattern() {
        let policy = policy_with_keyword("Coca-Cola", "Brandex", false);
        let key = EngineKey::from_bytes([9u8; 32]);
        let mut body = json!({
            "messages": [{"role": "user", "content": "coca-cola is here"}]
        });

        scan_request(&policy, &key, &mut body).unwrap();
        assert_eq!(body["messages"][0]["content"], "brandex is here");
    }

    #[test]
    fn scan_request_masks_keyword_across_every_message() {
        let policy = policy_with_keyword("Coca-Cola", "Brandex", true);
        let key = EngineKey::from_bytes([9u8; 32]);
        let mut body = json!({
            "messages": [
                {"role": "user", "content": "Use Coca-Cola API"},
                {"role": "assistant", "content": "OK, done"}
            ]
        });

        scan_request(&policy, &key, &mut body).unwrap();
        assert_eq!(body["messages"][0]["content"], "Use Brandex API");
        assert_eq!(body["messages"][1]["content"], "OK, done");
    }

    #[test]
    fn scan_request_keyword_masking_skips_non_string_leaves() {
        let policy = policy_with_keyword("Coca-Cola", "Brandex", true);
        let key = EngineKey::from_bytes([9u8; 32]);
        let mut body = json!({
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "text", "text": "Coca-Cola order", "index": 3, "cached": true, "note": null}
                ]
            }]
        });

        scan_request(&policy, &key, &mut body).unwrap();
        let block = &body["messages"][0]["content"][0];
        assert_eq!(block["text"], "Brandex order");
        assert_eq!(block["index"], 3);
        assert_eq!(block["cached"], true);
        assert!(block["note"].is_null());
    }

    #[test]
    fn scan_request_masks_multiple_keywords_in_one_field() {
        let json = r#"{
            "version": 3,
            "source": { "policies": [], "forced": [] },
            "rules": [],
            "keywords": [
                { "match": "Coca-Cola", "alias": "Brandex", "caseSensitive": true },
                { "match": "Sprite", "alias": "Mixer", "caseSensitive": true }
            ]
        }"#;
        let policy = compile_policy_v3(json).expect("policy with two keywords compiles");
        let key = EngineKey::from_bytes([9u8; 32]);
        let mut body = json!({"system": "Use Coca-Cola with Sprite"});

        scan_request(&policy, &key, &mut body).unwrap();
        assert_eq!(body["system"], "Use Brandex with Mixer");
    }

    #[test]
    fn scan_request_does_not_mask_keywords_in_protocol_fields() {
        // "model" and "role" are never scanned for PII either (see
        // scan_request_tokenizes_system_and_message_content); a keyword whose match text
        // happens to equal a protocol value must not touch it.
        let policy = policy_with_keyword("claude-x", "REDACTED", true);
        let key = EngineKey::from_bytes([9u8; 32]);
        let mut body = json!({
            "model": "claude-x",
            "messages": [{"role": "claude-x", "content": "hello"}]
        });

        scan_request(&policy, &key, &mut body).unwrap();
        assert_eq!(body["model"], "claude-x");
        assert_eq!(body["messages"][0]["role"], "claude-x");
    }

    #[test]
    fn scan_request_protects_keyword_already_sealed_inside_a_tokenized_pii_value() {
        // Sequence matters (design doc §7.3): PII tokenization runs first, so a keyword
        // that only appears as a substring of an already-tokenized PII value must not
        // survive in cleartext, and the alias substitution must find no cleartext match.
        let policy = policy_with_email_rule_and_keyword("secretco", "Vendor", true);
        let key = EngineKey::from_bytes([9u8; 32]);
        let mut body = json!({"system": "Contact admin@secretco.com about the merger"});

        scan_request(&policy, &key, &mut body).unwrap();
        let system = body["system"].as_str().unwrap();
        assert!(
            !system.contains("secretco"),
            "the keyword must not survive in cleartext once its containing value is tokenized"
        );
        assert!(
            !system.contains("Vendor"),
            "no alias substitution should fire: the keyword text is already gone by the time \
             the keyword pass runs"
        );
        assert!(system.contains("[EMAIL:TOKEN_"));
    }

    #[test]
    fn scan_request_keyword_masking_is_a_noop_with_no_keywords_configured() {
        let (policy, key) = test_policy_and_key();
        let mut body = json!({"system": "Use Coca-Cola with Sprite"});

        scan_request(&policy, &key, &mut body).unwrap();
        assert_eq!(body["system"], "Use Coca-Cola with Sprite");
    }

    // ── unmask_keywords_text / unmask_and_detokenize_response: inbound response rewrite ──

    fn email_token(policy: &CompiledPolicy, key: &EngineKey, value: &str) -> String {
        speedwave_pii_engine::scan_text(policy, key, value)
            .expect("scan succeeds")
            .text
    }

    #[test]
    fn unmask_keywords_text_reverses_mask_keywords() {
        let keywords = vec![CompiledKeyword {
            match_text: "Coca-Cola".to_string(),
            alias: "Brandex".to_string(),
            case_sensitive: true,
        }];
        assert_eq!(
            unmask_keywords_text("Use Brandex API", &keywords),
            "Use Coca-Cola API"
        );
    }

    #[test]
    fn unmask_keywords_text_is_noop_with_no_keywords() {
        assert_eq!(
            unmask_keywords_text("Use Brandex API", &[]),
            "Use Brandex API"
        );
    }

    #[test]
    fn unmask_keywords_text_applies_every_configured_keyword() {
        let keywords = vec![
            CompiledKeyword {
                match_text: "Coca-Cola".to_string(),
                alias: "Brandex".to_string(),
                case_sensitive: true,
            },
            CompiledKeyword {
                match_text: "Sprite".to_string(),
                alias: "Mixer".to_string(),
                case_sensitive: true,
            },
        ];
        assert_eq!(
            unmask_keywords_text("Use Brandex with Mixer", &keywords),
            "Use Coca-Cola with Sprite"
        );
    }

    #[test]
    fn unmask_keywords_text_skips_a_pii_token_spans_ciphertext() {
        // The keyword alias never legitimately appears inside a token's base64 payload, but
        // the mechanism must not corrupt the span even if it coincidentally did (§7.2).
        let policy = policy_with_email_rule_and_keyword("Coca-Cola", "Brandex", true);
        let key = EngineKey::from_bytes([9u8; 32]);
        let token = email_token(&policy, &key, "bob@example.com");
        let text = format!("Brandex shipped {token}");

        let result = unmask_keywords_text(
            &text,
            &[CompiledKeyword {
                match_text: "Coca-Cola".to_string(),
                alias: "Brandex".to_string(),
                case_sensitive: true,
            }],
        );
        assert_eq!(result, format!("Coca-Cola shipped {token}"));
    }

    #[test]
    fn unmask_and_detokenize_response_reverses_scan_request_end_to_end() {
        // Round-trip symmetry (design doc §7.3): mask+tokenize outbound the way scan_request
        // does, then unmask+detokenize inbound must recover the exact original text.
        let policy = policy_with_email_rule_and_keyword("Coca-Cola", "Brandex", true);
        let key = EngineKey::from_bytes([9u8; 32]);
        let mut body = json!({"system": "Contact bob@example.com at Coca-Cola"});
        scan_request(&policy, &key, &mut body).unwrap();
        let masked_and_tokenized = body["system"].as_str().unwrap();
        assert!(masked_and_tokenized.contains("[EMAIL:TOKEN_"));
        assert!(masked_and_tokenized.contains("Brandex"));

        let restored =
            unmask_and_detokenize_response(masked_and_tokenized, policy.keywords(), &key)
                .expect("detokenize succeeds");
        assert_eq!(restored, "Contact bob@example.com at Coca-Cola");
    }

    #[test]
    fn unmask_and_detokenize_response_fails_closed_on_a_corrupted_token() {
        let (policy, key) = test_policy_and_key();
        let token = email_token(&policy, &key, "bob@example.com");
        let mut bytes = token.into_bytes();
        let pos = bytes.len() - 5;
        bytes[pos] = if bytes[pos] == b'A' { b'B' } else { b'A' };
        let corrupted = String::from_utf8(bytes).expect("still valid utf8");

        assert!(unmask_and_detokenize_response(&corrupted, &[], &key).is_err());
    }

    // ── safe_prefix_len: emit-boundary computation for the streaming rewriter ──

    fn kw(match_text: &str, alias: &str, case_sensitive: bool) -> CompiledKeyword {
        CompiledKeyword {
            match_text: match_text.to_string(),
            alias: alias.to_string(),
            case_sensitive,
        }
    }

    #[test]
    fn safe_prefix_len_full_when_no_candidates() {
        let text = "plain text with no brackets";
        assert_eq!(
            safe_prefix_len(text, &[kw("Coca-Cola", "Brandex", true)]),
            text.len()
        );
    }

    #[test]
    fn safe_prefix_len_holds_incomplete_token_span_tail() {
        assert_eq!(safe_prefix_len("abc [EMAIL:TOK", &[]), 4);
        assert_eq!(safe_prefix_len("abc [", &[]), 4);
    }

    #[test]
    fn safe_prefix_len_holds_partial_alias_tail_case_insensitively() {
        let text = "say bRa";
        assert_eq!(
            safe_prefix_len(text, &[kw("Coca-Cola", "Brandex", false)]),
            4
        );
        // Case-sensitive keyword: a wrong-case tail can never grow into the alias.
        assert_eq!(
            safe_prefix_len(text, &[kw("Coca-Cola", "Brandex", true)]),
            text.len()
        );
    }

    #[test]
    fn safe_prefix_len_does_not_hold_complete_alias_unless_prefix_of_longer_alias() {
        let text = "use Brand";
        assert_eq!(
            safe_prefix_len(text, &[kw("Coca-Cola", "Brand", true)]),
            text.len()
        );
        assert_eq!(
            safe_prefix_len(
                text,
                &[
                    kw("Coca-Cola", "Brand", true),
                    kw("Sprite", "Brandex", true)
                ]
            ),
            4
        );
    }

    #[test]
    fn safe_prefix_len_gives_up_beyond_max_token_span_len() {
        let text = format!("[EMAIL:TOKEN_{}", "a".repeat(MAX_TOKEN_SPAN_LEN + 10));
        assert_eq!(safe_prefix_len(&text, &[]), text.len());
    }

    // ── unmask_and_detokenize_json_fragment: replacements escaped for serialized JSON ──

    fn policy_with_secret_rule() -> CompiledPolicy {
        let json = r#"{
            "version": 3,
            "source": { "policies": [], "forced": [] },
            "rules": [
                { "id": "SECRET", "displayName": "Secret", "patterns": ["(?s)BEGIN.+END"], "caseSensitive": true, "tokenize": true, "log": false }
            ],
            "keywords": []
        }"#;
        compile_policy_v3(json).expect("secret-rule policy compiles")
    }

    #[test]
    fn json_fragment_escapes_quote_backslash_newline_in_detokenized_plaintext() {
        let policy = policy_with_secret_rule();
        let key = EngineKey::from_bytes([9u8; 32]);
        let plaintext = "BEGIN\"x\ny\\zEND";
        let token = speedwave_pii_engine::scan_text(&policy, &key, plaintext)
            .expect("scan succeeds")
            .text;
        assert!(token.starts_with("[SECRET:TOKEN_"), "got: {token}");

        let fragment = format!("{{\"content\": \"{token}\"}}");
        let out = unmask_and_detokenize_json_fragment(&fragment, &[], &key).expect("fragment ok");
        let parsed: serde_json::Value =
            serde_json::from_str(&out).expect("fragment must stay valid JSON");
        assert_eq!(parsed["content"], plaintext);
    }

    #[test]
    fn json_fragment_escapes_keyword_match_replacement() {
        let key = EngineKey::from_bytes([9u8; 32]);
        let keywords = vec![kw("Line1\nLine2 \"Q\"", "Brandex", true)];

        let fragment = r#"{"note": "Brandex ships"}"#;
        let out = unmask_and_detokenize_json_fragment(fragment, &keywords, &key).expect("ok");
        let parsed: serde_json::Value = serde_json::from_str(&out).expect("valid JSON");
        assert_eq!(parsed["note"], "Line1\nLine2 \"Q\" ships");
    }

    #[test]
    fn json_fragment_without_matches_is_identity() {
        let key = EngineKey::from_bytes([9u8; 32]);
        let fragment = r#"{"note": "nothing here"}"#;
        assert_eq!(
            unmask_and_detokenize_json_fragment(fragment, &[], &key).expect("ok"),
            fragment
        );
    }

    // ── ResponseRewriteBuffer: whole-body buffer for non-SSE responses ──

    #[test]
    fn buffer_accumulates_chunks_and_emits_only_at_finish() {
        let mut buffer = ResponseRewriteBuffer::new();
        let key = EngineKey::from_bytes([9u8; 32]);

        assert_eq!(buffer.push_chunk(b"Hello "), 6);
        assert_eq!(buffer.push_chunk(b"world"), 11);

        let flushed = buffer.finish(&[], &key).unwrap();
        assert_eq!(flushed, b"Hello world");
    }

    #[test]
    fn buffer_finish_on_empty_buffer_is_empty() {
        let key = EngineKey::from_bytes([9u8; 32]);
        assert!(ResponseRewriteBuffer::new()
            .finish(&[], &key)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn buffer_detokenizes_a_token_split_across_two_push_chunk_calls_at_finish() {
        let (policy, key) = test_policy_and_key();
        let token = email_token(&policy, &key, "split.alice@example.com");
        let (first_half, second_half) = token.split_at(token.len() / 2);

        let mut buffer = ResponseRewriteBuffer::new();
        buffer.push_chunk(first_half.as_bytes());
        buffer.push_chunk(second_half.as_bytes());

        let flushed = buffer.finish(&[], &key).unwrap();
        assert_eq!(
            String::from_utf8(flushed).unwrap(),
            "split.alice@example.com"
        );
    }

    #[test]
    fn buffer_detokenizes_token_straddling_the_old_rolling_boundary() {
        // Regression: the retired rolling emit cut the buffer at len-MAX_TOKEN_SPAN_LEN and
        // transformed only the prefix, splitting a match that crossed the cut.
        let (policy, key) = test_policy_and_key();
        let token = email_token(&policy, &key, "straddle.bob@example.com");
        let (first_half, second_half) = token.split_at(token.len() / 2);
        let chunk1 = format!("{}{first_half}", "A".repeat(MAX_TOKEN_SPAN_LEN + 900));
        let chunk2 = format!("{second_half}{}", "B".repeat(50));

        let mut buffer = ResponseRewriteBuffer::new();
        buffer.push_chunk(chunk1.as_bytes());
        buffer.push_chunk(chunk2.as_bytes());

        let out = String::from_utf8(buffer.finish(&[], &key).unwrap()).unwrap();
        assert!(out.contains("straddle.bob@example.com"));
        assert!(!out.contains("TOKEN_"), "no literal token may leak");
    }

    #[test]
    fn buffer_unmasks_alias_straddling_the_old_rolling_boundary() {
        let policy = policy_with_email_rule_and_keyword("Coca-Cola", "Brandex", true);
        let key = EngineKey::from_bytes([9u8; 32]);
        let chunk1 = format!("{}Bran", "A".repeat(MAX_TOKEN_SPAN_LEN + 900));

        let mut buffer = ResponseRewriteBuffer::new();
        buffer.push_chunk(chunk1.as_bytes());
        buffer.push_chunk(b"dex done");

        let out = String::from_utf8(buffer.finish(policy.keywords(), &key).unwrap()).unwrap();
        assert!(
            out.ends_with("Coca-Cola done"),
            "got tail: {}",
            &out[out.len() - 30..]
        );
    }

    #[test]
    fn buffer_unmasks_keywords_before_detokenizing_at_finish() {
        let policy = policy_with_email_rule_and_keyword("Coca-Cola", "Brandex", true);
        let key = EngineKey::from_bytes([9u8; 32]);
        let original = "kw.carol@example.com works at Coca-Cola";
        let mut body = json!({ "system": original });
        scan_request(&policy, &key, &mut body).unwrap();
        let upstream_text = body["system"].as_str().unwrap().to_string();
        assert!(upstream_text.contains("Brandex"));
        assert!(upstream_text.contains("[EMAIL:TOKEN_"));

        let mut buffer = ResponseRewriteBuffer::new();
        buffer.push_chunk(upstream_text.as_bytes());
        let flushed = buffer.finish(policy.keywords(), &key).unwrap();
        assert_eq!(String::from_utf8(flushed).unwrap(), original);
    }

    #[test]
    fn buffer_propagates_detokenize_failure_and_never_emits_the_literal_token() {
        let (policy, key) = test_policy_and_key();
        let token = email_token(&policy, &key, "corrupt.dave@example.com");
        let mut bytes = token.into_bytes();
        let pos = bytes.len() - 5;
        bytes[pos] = if bytes[pos] == b'A' { b'B' } else { b'A' };

        let mut buffer = ResponseRewriteBuffer::new();
        buffer.push_chunk(&bytes);
        assert!(buffer.finish(&[], &key).is_err());
    }
}
