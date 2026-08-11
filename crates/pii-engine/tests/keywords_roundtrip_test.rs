//! Integration tests: keyword masking (`alias_text`) and its inverse
//! (`unalias_text` / `unalias_text_preserving_tokens`) are exact round trips, using
//! only the crate's public API the way callers (proxy, hub) use it. Complements the
//! crate's own `#[cfg(test)]` unit coverage in `src/scan.rs`.

#![expect(
    clippy::expect_used,
    reason = "test code: panics on setup failure are acceptable"
)]

use speedwave_pii_engine::{
    alias_text, compile_policy_v3, scan_text, unalias_text, unalias_text_preserving_tokens,
    CompiledKeyword, EngineKey,
};

fn test_key() -> EngineKey {
    EngineKey::from_bytes([11u8; 32])
}

#[test]
fn case_sensitive_alias_unalias_roundtrip() {
    let original = "Sprite is on sale, Sprite everywhere";
    let masked = alias_text(original, "Sprite", "Mixer", true);
    assert_eq!(masked, "Mixer is on sale, Mixer everywhere");
    assert_eq!(unalias_text(&masked, "Sprite", "Mixer", true), original);
}

#[test]
fn case_insensitive_alias_unalias_roundtrip_across_case_patterns() {
    for original in ["coca-cola today", "COCA-COLA TODAY", "Coca-Cola Today"] {
        let masked = alias_text(original, "Coca-Cola", "Brandex", false);
        assert_ne!(masked, original, "a real substitution must have happened");
        let restored = unalias_text(&masked, "Coca-Cola", "Brandex", false);
        assert_eq!(restored, original, "roundtrip failed for {original:?}");
    }
}

#[test]
fn multiple_keywords_mask_and_unmask_in_sequence() {
    // Mirrors how a caller with several configured keywords applies them
    // (proxy's `mask_keywords`/`unmask_keywords_text`): one alias_text/unalias_text
    // pass per keyword, in policy order.
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
    let original = "Coca-Cola versus Sprite: a taste test";

    let mut masked = original.to_string();
    for kw in &keywords {
        masked = alias_text(&masked, &kw.match_text, &kw.alias, kw.case_sensitive);
    }
    assert_eq!(masked, "Brandex versus Mixer: a taste test");
    assert!(!masked.contains("Coca-Cola") && !masked.contains("Sprite"));

    let mut restored = masked;
    for kw in &keywords {
        restored = unalias_text(&restored, &kw.match_text, &kw.alias, kw.case_sensitive);
    }
    assert_eq!(restored, original);
}

#[test]
fn no_match_is_a_true_noop_in_both_directions() {
    let text = "nothing interesting here";
    assert_eq!(alias_text(text, "Coca-Cola", "Brandex", false), text);
    assert_eq!(unalias_text(text, "Coca-Cola", "Brandex", false), text);
}

#[test]
fn empty_keyword_list_leaves_text_untouched() {
    let keywords: Vec<CompiledKeyword> = Vec::new();
    let text = "Some text here";
    let mut masked = text.to_string();
    for kw in &keywords {
        masked = alias_text(&masked, &kw.match_text, &kw.alias, kw.case_sensitive);
    }
    assert_eq!(masked, text, "no keywords configured must be a no-op");
}

#[test]
fn unicode_text_round_trips() {
    let original = "Kontakt: Coca-Cola, ąęćłńóśźż";
    let masked = alias_text(original, "Coca-Cola", "Brandex", true);
    assert_eq!(masked, "Kontakt: Brandex, ąęćłńóśźż");
    assert_eq!(
        unalias_text(&masked, "Coca-Cola", "Brandex", true),
        original
    );
}

#[test]
fn unalias_preserving_tokens_never_touches_a_real_pii_token_span_and_still_unmasks_plain_text() {
    let policy_json = r#"{
        "version": 3,
        "source": { "policies": [], "forced": [] },
        "rules": [
            { "id": "EMAIL", "displayName": "E-mail", "patterns": ["[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}"], "caseSensitive": true, "tokenize": true, "log": false }
        ],
        "keywords": []
    }"#;
    let policy = compile_policy_v3(policy_json).expect("policy compiles");
    let key = test_key();
    let tokenized = scan_text(&policy, &key, "reach bob@example.com")
        .expect("scan succeeds")
        .text;
    let token_span = tokenized
        .split_whitespace()
        .find(|s| s.starts_with("[EMAIL:TOKEN_"))
        .expect("token span present")
        .to_string();

    let masked = format!("Brandex sent this: {tokenized}");
    let unmasked = unalias_text_preserving_tokens(&masked, "Coca-Cola", "Brandex", true);

    assert_eq!(unmasked, format!("Coca-Cola sent this: {tokenized}"));
    assert!(
        unmasked.contains(&token_span),
        "the token span's ciphertext must survive byte-for-byte"
    );
}
