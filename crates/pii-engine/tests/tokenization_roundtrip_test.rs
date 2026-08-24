//! Integration tests: PII tokenization (`scan_text`/`scan_json`) and its inverse
//! (`detokenize_text`/`detokenize_json`) are exact round trips, using only the
//! crate's public API the way callers (proxy, hub) use it. Complements the crate's
//! own `#[cfg(test)]` unit coverage in `src/scan.rs`.

#![expect(
    clippy::expect_used,
    reason = "test code: panics on setup failure are acceptable"
)]

use speedwave_pii_engine::{
    compile_policy_v3, detokenize_json, detokenize_text, scan_json, scan_text, EngineKey,
};

fn test_key() -> EngineKey {
    EngineKey::from_bytes([5u8; 32])
}

const EMAIL_POLICY: &str = r#"{
    "version": 3,
    "source": {"policies": ["strict"], "forced": []},
    "rules": [
        {
            "id": "EMAIL",
            "displayName": "E-mail address",
            "patterns": ["[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}"],
            "caseSensitive": true,
            "tokenize": true,
            "log": false
        }
    ],
    "keywords": []
}"#;

#[test]
fn tokenize_detokenize_text_is_symmetric() {
    let policy = compile_policy_v3(EMAIL_POLICY).expect("policy compiles");
    let key = test_key();
    let original = "Contact me at john@example.com for details";

    let outcome = scan_text(&policy, &key, original).expect("scan succeeds");
    assert_ne!(
        outcome.text, original,
        "tokenized text must differ from the original"
    );
    assert!(
        outcome.text.contains("[EMAIL:TOKEN_"),
        "tokenized text must carry a token span"
    );
    assert!(!outcome.text.contains("john@example.com"));

    let restored = detokenize_text(&key, &outcome.text).expect("detokenize succeeds");
    assert_eq!(
        restored, original,
        "tokenize -> detokenize must restore the original text exactly"
    );
}

#[test]
fn tokenize_detokenize_json_is_symmetric_across_nested_values() {
    let policy = compile_policy_v3(EMAIL_POLICY).expect("policy compiles");
    let key = test_key();
    let mut value = serde_json::json!({
        "reporter": "alice@example.com",
        "watchers": ["bob@example.com", "carol@example.com"],
        "id": 42,
        "resolved": false,
    });
    let original = value.clone();

    scan_json(&policy, &key, &mut value).expect("scan succeeds");
    assert_ne!(value["reporter"], original["reporter"]);
    assert_ne!(value["watchers"], original["watchers"]);
    assert_eq!(value["id"], 42, "non-string fields must be untouched");
    assert_eq!(value["resolved"], false);

    detokenize_json(&key, &mut value).expect("detokenize succeeds");
    assert_eq!(
        value, original,
        "tokenize -> detokenize must restore the exact original JSON tree"
    );
}

#[test]
fn detokenize_fails_closed_on_a_corrupted_token() {
    let policy = compile_policy_v3(EMAIL_POLICY).expect("policy compiles");
    let key = test_key();
    let tokenized = scan_text(&policy, &key, "reach out to dan@example.com")
        .expect("scan succeeds")
        .text;

    let pos = tokenized.find("TOKEN_").expect("token present") + "TOKEN_".len();
    let mut bytes = tokenized.into_bytes();
    bytes[pos] = if bytes[pos] == b'A' { b'B' } else { b'A' };
    let corrupted = String::from_utf8(bytes).expect("still valid utf8");

    assert!(
        detokenize_text(&key, &corrupted).is_err(),
        "a tampered token must never decrypt"
    );
}

#[test]
fn detokenize_with_a_different_key_fails_closed() {
    let policy = compile_policy_v3(EMAIL_POLICY).expect("policy compiles");
    let key_a = test_key();
    let key_b = EngineKey::from_bytes([6u8; 32]);
    let tokenized = scan_text(&policy, &key_a, "erin@example.com")
        .expect("scan succeeds")
        .text;

    assert!(
        detokenize_text(&key_b, &tokenized).is_err(),
        "the wrong key must never decrypt someone else's token"
    );
}

#[test]
fn same_value_tokenizes_to_the_same_token_deterministically() {
    let policy = compile_policy_v3(EMAIL_POLICY).expect("policy compiles");
    let key = test_key();
    let a = scan_text(&policy, &key, "frank@example.com")
        .expect("scan succeeds")
        .text;
    let b = scan_text(&policy, &key, "frank@example.com")
        .expect("scan succeeds")
        .text;
    assert_eq!(
        a, b,
        "tokenization must be deterministic for the same (key, category, value)"
    );
}

#[test]
fn multi_category_document_round_trips_every_category() {
    let policy_json = r#"{
        "version": 3,
        "source": {"policies": [], "forced": []},
        "rules": [
            {"id": "EMAIL", "displayName": "E-mail", "patterns": ["[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}"], "caseSensitive": true, "tokenize": true, "log": false},
            {"id": "PESEL", "displayName": "PESEL", "patterns": ["(?-u:\\b)\\d{11}(?-u:\\b)"], "validator": "pesel", "caseSensitive": true, "tokenize": true, "log": false}
        ],
        "keywords": []
    }"#;
    let policy = compile_policy_v3(policy_json).expect("policy compiles");
    let key = test_key();
    let original = "Contact grace@example.com, PESEL 44051401359 please";

    let tokenized = scan_text(&policy, &key, original)
        .expect("scan succeeds")
        .text;
    assert!(tokenized.contains("[EMAIL:TOKEN_"));
    assert!(tokenized.contains("[PESEL:TOKEN_"));
    assert!(!tokenized.contains("grace@example.com"));
    assert!(!tokenized.contains("44051401359"));

    let restored = detokenize_text(&key, &tokenized).expect("detokenize succeeds");
    assert_eq!(restored, original);
}

#[test]
fn scanning_an_already_tokenized_document_twice_is_idempotent() {
    let policy = compile_policy_v3(EMAIL_POLICY).expect("policy compiles");
    let key = test_key();
    let original = "helen@example.com";

    let once = scan_text(&policy, &key, original).expect("scan succeeds");
    let twice = scan_text(&policy, &key, &once.text).expect("scan succeeds");

    assert_eq!(
        once.text, twice.text,
        "re-scanning tokenized text must be a no-op"
    );
    assert!(
        twice.detections.is_empty(),
        "an existing token must not be re-detected"
    );

    let restored = detokenize_text(&key, &twice.text).expect("detokenize succeeds");
    assert_eq!(restored, original);
}
