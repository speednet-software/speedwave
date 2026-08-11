//! Full request -> proxy -> LLM -> proxy -> agent cycle (design doc §5.1, §7.2/§7.3):
//! tokenize + mask outbound, unmask + detokenize inbound must exactly restore the
//! original plaintext, and neither an alias nor a token span may reach the agent.
//!
//! `proxy` ships no library target (binary-only crate, `[[bin]]` only, ADR-073 F4),
//! so an external integration test cannot import its `pii` module directly. This test
//! instead drives the shared `speedwave-pii-engine` dependency the same way
//! `containers/proxy/src/pii.rs::scan_request`/`unmask_and_detokenize_response` do
//! (tokenize-then-mask outbound, unmask-then-detokenize inbound); that module's own
//! `#[cfg(test)]` suite covers the wiring around it (JSON field selection, protocol
//! field exclusion, and the streaming rewrite buffer) end to end.

#![expect(
    clippy::expect_used,
    reason = "test code: panics on setup failure are acceptable"
)]

use speedwave_pii_engine::{
    alias_text, compile_policy_v3, detokenize_text, scan_json, unalias_text_preserving_tokens,
    CompiledKeyword, EngineKey,
};

fn test_key() -> EngineKey {
    EngineKey::from_bytes([21u8; 32])
}

const POLICY_JSON: &str = r#"{
    "version": 3,
    "source": { "policies": ["strict"], "forced": [] },
    "rules": [
        { "id": "EMAIL", "displayName": "E-mail", "patterns": ["[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}"], "caseSensitive": true, "tokenize": true, "log": false }
    ],
    "keywords": [
        { "match": "Acme", "alias": "Corp", "caseSensitive": true }
    ]
}"#;

/// Mirrors `containers/proxy/src/pii.rs::mask_keywords`: one `alias_text` pass per
/// configured keyword, run strictly after PII tokenization.
fn mask_keywords(text: &str, keywords: &[CompiledKeyword]) -> String {
    let mut result = text.to_string();
    for kw in keywords {
        result = alias_text(&result, &kw.match_text, &kw.alias, kw.case_sensitive);
    }
    result
}

/// Mirrors `containers/proxy/src/pii.rs::unmask_keywords_text`: one
/// `unalias_text_preserving_tokens` pass per configured keyword, run strictly before
/// PII detokenization, so an already-formed token span is never touched.
fn unmask_keywords(text: &str, keywords: &[CompiledKeyword]) -> String {
    let mut result = text.to_string();
    for kw in keywords {
        result =
            unalias_text_preserving_tokens(&result, &kw.match_text, &kw.alias, kw.case_sensitive);
    }
    result
}

#[test]
fn full_request_response_cycle_masks_keyword_and_tokenizes_pii_then_restores_both() {
    let policy = compile_policy_v3(POLICY_JSON).expect("policy compiles");
    let key = test_key();
    let keywords = policy.keywords();

    let original_request = serde_json::json!({
        "messages": [
            { "role": "user", "content": "Acme's contact is john@acme.com" }
        ]
    });

    // 1. Outbound (request -> proxy -> LLM): tokenize PII first, then mask keywords.
    let mut outbound = original_request.clone();
    let detections = scan_json(&policy, &key, &mut outbound).expect("scan succeeds");
    assert!(
        detections.iter().any(|d| d.category == "EMAIL"),
        "EMAIL must be detected"
    );

    let content = outbound["messages"][0]["content"]
        .as_str()
        .expect("content is a string");
    let masked_and_tokenized = mask_keywords(content, keywords);
    assert!(
        masked_and_tokenized.contains("Corp"),
        "keyword must be masked"
    );
    assert!(
        masked_and_tokenized.contains("[EMAIL:TOKEN_"),
        "PII must be tokenized"
    );
    assert!(
        !masked_and_tokenized.contains("Acme"),
        "original keyword must be gone from what the LLM sees"
    );
    assert!(
        !masked_and_tokenized.contains("john@acme.com"),
        "original PII must be gone from what the LLM sees"
    );

    // 2. Simulate the LLM echoing the masked/tokenized text back verbatim.
    let llm_response = format!("Processing: {masked_and_tokenized}");

    // 3. Inbound (LLM -> proxy -> agent): unmask keywords first, then detokenize —
    // the exact reverse order of the outbound pass.
    let unmasked = unmask_keywords(&llm_response, keywords);
    let restored = detokenize_text(&key, &unmasked).expect("detokenize succeeds");

    assert_eq!(restored, "Processing: Acme's contact is john@acme.com");
    assert!(!restored.contains("Corp"), "alias must not reach the agent");
    assert!(
        !restored.contains("[EMAIL:TOKEN_"),
        "token span must not reach the agent"
    );
}

#[test]
fn agent_sees_exact_original_plaintext_when_the_llm_echoes_only_the_masked_fragment() {
    let policy = compile_policy_v3(POLICY_JSON).expect("policy compiles");
    let key = test_key();
    let keywords = policy.keywords();

    let mut outbound = serde_json::json!({ "content": "Acme sent invoice@acme.com" });
    scan_json(&policy, &key, &mut outbound).expect("scan succeeds");
    let content = outbound["content"].as_str().expect("content is a string");
    let masked_and_tokenized = mask_keywords(content, keywords);

    let unmasked = unmask_keywords(&masked_and_tokenized, keywords);
    let restored = detokenize_text(&key, &unmasked).expect("detokenize succeeds");

    assert_eq!(restored, "Acme sent invoice@acme.com");
}

#[test]
fn corrupted_token_in_the_llm_response_fails_closed_never_leaking_ciphertext_as_plaintext() {
    let policy = compile_policy_v3(POLICY_JSON).expect("policy compiles");
    let key = test_key();

    let mut outbound = serde_json::json!({ "content": "reach eve@acme.com" });
    scan_json(&policy, &key, &mut outbound).expect("scan succeeds");
    let tokenized = outbound["content"]
        .as_str()
        .expect("content is a string")
        .to_string();

    let pos = tokenized.find("TOKEN_").expect("token present") + "TOKEN_".len();
    let mut bytes = tokenized.into_bytes();
    bytes[pos] = if bytes[pos] == b'A' { b'B' } else { b'A' };
    let corrupted = String::from_utf8(bytes).expect("still valid utf8");

    assert!(
        detokenize_text(&key, &corrupted).is_err(),
        "a tampered token must never resolve to plaintext for the agent"
    );
}
