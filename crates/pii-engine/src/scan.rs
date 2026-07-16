//! Scanning, tokenization, and fail-closed detokenization
//! (TS counterpart: `mcp-servers/policies/src/tokenizer.ts`).

use crate::patterns::{self, SENSITIVE_FIELD};
use crate::policy::CompiledPolicy;
use crate::siv::{decode_payload, encode_payload, open, seal, EngineKey};
use regex::Regex;
use std::collections::HashMap;
use std::fmt;
use std::sync::LazyLock;

/// Regex source matching any token span; shared by masking, detokenization, and (later) proxy/hub.
pub const TOKEN_SPAN_RE: &str = r"\[[A-Z0-9_]+:TOKEN_[A-Za-z0-9_-]+\]";

static TOKEN_SPAN_REGEX: LazyLock<Result<Regex, regex::Error>> =
    LazyLock::new(|| Regex::new(TOKEN_SPAN_RE));

/// Fetches the lazily-compiled token-span regex, never panicking on a compile failure.
fn token_span_regex() -> Result<&'static Regex, ()> {
    TOKEN_SPAN_REGEX.as_ref().map_err(|_| ())
}

/// What happened for one category during a scan.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum DetectionAction {
    /// Every hit in this category was replaced with a token.
    Tokenized,
    /// Hits in this category were counted but left in place (observation mode).
    Passed,
}

/// Per-category aggregate: how many matches, and what was done with them.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Detection {
    /// Category id: a built-in category or a custom pattern id.
    pub category: String,
    /// What was done with hits in this category for this scan call.
    pub action: DetectionAction,
    /// Number of matches counted for this category (occurrences, not unique values).
    pub count: u32,
}

/// A scanned text plus the per-category detection aggregate.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ScanOutcome {
    /// The text after tokenization (unchanged for categories in observation mode).
    pub text: String,
    /// Per-category detection aggregate, ordered by each category's first hit.
    pub detections: Vec<Detection>,
}

/// A scan or tokenization failure; the message never carries the scanned value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScanError {
    /// The fixed token-span pattern failed to compile (defensive; unreachable in practice).
    TokenPatternInvalid,
    /// Sealing a detected value failed for the named category; never carries the value.
    SealFailed(String),
}

impl fmt::Display for ScanError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TokenPatternInvalid => write!(f, "token span pattern failed to compile"),
            Self::SealFailed(category) => write!(f, "failed to seal a detected {category} value"),
        }
    }
}

impl std::error::Error for ScanError {}

/// A detokenization failure; carries only the category and span position, never the payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DetokenizeError {
    /// The fixed token-span pattern failed to compile (defensive; unreachable in practice).
    TokenPatternInvalid,
    /// Verification failed for the span at `index` (0-based, document order) in `category`.
    VerificationFailed {
        /// Category name taken from the token span itself.
        category: String,
        /// 0-based position of the failing span among all spans found in the document.
        index: usize,
    },
}

impl fmt::Display for DetokenizeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TokenPatternInvalid => write!(f, "token span pattern failed to compile"),
            Self::VerificationFailed { category, index } => {
                write!(
                    f,
                    "token verification failed for {category} at span {index}"
                )
            }
        }
    }
}

impl std::error::Error for DetokenizeError {}

/// A run of text: either untouched source, or an already-sealed token span to never rescan.
enum Segment {
    Plain(String),
    Masked(String),
}

/// Splits `text` on every existing token span so later scanning never re-enters one (idempotency).
fn mask_spans(text: &str) -> Result<Vec<Segment>, ScanError> {
    let re = token_span_regex().map_err(|_| ScanError::TokenPatternInvalid)?;
    let mut segments = Vec::new();
    let mut last = 0;
    for m in re.find_iter(text) {
        if m.start() > last {
            segments.push(Segment::Plain(text[last..m.start()].to_string()));
        }
        segments.push(Segment::Masked(m.as_str().to_string()));
        last = m.end();
    }
    if last < text.len() {
        segments.push(Segment::Plain(text[last..].to_string()));
    }
    Ok(segments)
}

/// Builds the verbatim token span for a sealed value in the given category.
fn build_token(key: &EngineKey, category: &str, value: &str) -> Result<String, ScanError> {
    let ciphertext = seal(key, category, value.as_bytes())
        .map_err(|_| ScanError::SealFailed(category.to_string()))?;
    Ok(format!(
        "[{category}:TOKEN_{}]",
        encode_payload(&ciphertext)
    ))
}

/// Runs one rule over every unmasked segment, replacing hits when `flags.tokenize` is set.
fn apply_rule(
    segments: Vec<Segment>,
    rule: &crate::policy::CompiledRule,
    key: &EngineKey,
) -> Result<(Vec<Segment>, u32), ScanError> {
    let mut new_segments = Vec::with_capacity(segments.len());
    let mut total = 0u32;
    for segment in segments {
        match segment {
            Segment::Masked(s) => new_segments.push(Segment::Masked(s)),
            Segment::Plain(s) => {
                let (mut produced, count) = tokenize_segment(&s, rule, key)?;
                total += count;
                new_segments.append(&mut produced);
            }
        }
    }
    Ok((new_segments, total))
}

/// Finds validated hits in one plain segment and, if tokenizing, replaces them (dedup by value).
fn tokenize_segment(
    segment: &str,
    rule: &crate::policy::CompiledRule,
    key: &EngineKey,
) -> Result<(Vec<Segment>, u32), ScanError> {
    let mut hits: Vec<(usize, usize, String)> = Vec::new();
    for m in rule.regex.find_iter(segment) {
        let value = m.as_str();
        if let Some(validator) = rule.validator {
            if !validator(value) {
                continue;
            }
        }
        hits.push((m.start(), m.end(), value.to_string()));
    }

    let count = hits.len() as u32;
    if count == 0 || !rule.flags.tokenize {
        return Ok((vec![Segment::Plain(segment.to_string())], count));
    }

    let mut result = Vec::new();
    let mut cache: HashMap<String, String> = HashMap::new();
    let mut last = 0;
    for (start, end, value) in hits {
        if start > last {
            result.push(Segment::Plain(segment[last..start].to_string()));
        }
        let token = match cache.get(&value) {
            Some(t) => t.clone(),
            None => {
                let t = build_token(key, &rule.category, &value)?;
                cache.insert(value.clone(), t.clone());
                t
            }
        };
        result.push(Segment::Masked(token));
        last = end;
    }
    if last < segment.len() {
        result.push(Segment::Plain(segment[last..].to_string()));
    }
    Ok((result, count))
}

/// Scans plain text with every rule in the policy; existing token spans are masked first (idempotent).
pub fn scan_text(
    policy: &CompiledPolicy,
    key: &EngineKey,
    text: &str,
) -> Result<ScanOutcome, ScanError> {
    let mut segments = mask_spans(text)?;
    let mut detections: Vec<Detection> = Vec::new();
    for rule in policy.rules() {
        let (new_segments, count) = apply_rule(segments, rule, key)?;
        segments = new_segments;
        if count > 0 {
            detections.push(Detection {
                category: rule.category.clone(),
                action: if rule.flags.tokenize {
                    DetectionAction::Tokenized
                } else {
                    DetectionAction::Passed
                },
                count,
            });
        }
    }
    let text = segments
        .into_iter()
        .map(|s| match s {
            Segment::Plain(s) | Segment::Masked(s) => s,
        })
        .collect();
    Ok(ScanOutcome { text, detections })
}

/// Adds one hit to the aggregate, merging into an existing per-category entry if present.
fn record_hit(agg: &mut Vec<Detection>, category: &str, action: DetectionAction, count: u32) {
    if let Some(existing) = agg.iter_mut().find(|d| d.category == category) {
        existing.count += count;
    } else {
        agg.push(Detection {
            category: category.to_string(),
            action,
            count,
        });
    }
}

/// Merges a sub-tree's detections into the whole-tree aggregate.
fn merge_detections(agg: &mut Vec<Detection>, more: Vec<Detection>) {
    for d in more {
        record_hit(agg, &d.category, d.action, d.count);
    }
}

/// True when `s` is nothing but a single existing token span (already masked, never re-tokenize).
fn is_full_token_span(s: &str) -> Result<bool, ScanError> {
    let re = token_span_regex().map_err(|_| ScanError::TokenPatternInvalid)?;
    Ok(re
        .find(s)
        .is_some_and(|m| m.start() == 0 && m.end() == s.len()))
}

/// Scans a JSON tree in place: string values via value rules; keys matching the sensitive-key
/// list tokenize the whole value under SENSITIVE_FIELD. All-or-nothing: on error, the input remains unchanged.
pub fn scan_json(
    policy: &CompiledPolicy,
    key: &EngineKey,
    value: &mut serde_json::Value,
) -> Result<Vec<Detection>, ScanError> {
    let mut clone = value.clone();
    let mut detections: Vec<Detection> = Vec::new();
    scan_json_value(policy, key, &mut clone, &mut detections)?;
    *value = clone;
    Ok(detections)
}

fn scan_json_value(
    policy: &CompiledPolicy,
    key: &EngineKey,
    value: &mut serde_json::Value,
    detections: &mut Vec<Detection>,
) -> Result<(), ScanError> {
    match value {
        serde_json::Value::String(s) => {
            let outcome = scan_text(policy, key, s)?;
            *s = outcome.text;
            merge_detections(detections, outcome.detections);
        }
        serde_json::Value::Array(items) => {
            for item in items.iter_mut() {
                scan_json_value(policy, key, item, detections)?;
            }
        }
        serde_json::Value::Object(map) => {
            let flags = policy.sensitive_field_flags();
            for (field_name, field_value) in map.iter_mut() {
                if let serde_json::Value::String(s) = field_value {
                    if (flags.tokenize || flags.log)
                        && patterns::is_sensitive_key(field_name, policy.sensitive_keys())
                        && !is_full_token_span(s)?
                    {
                        if flags.tokenize {
                            let token = build_token(key, SENSITIVE_FIELD, s)?;
                            *s = token;
                            record_hit(detections, SENSITIVE_FIELD, DetectionAction::Tokenized, 1);
                        } else {
                            record_hit(detections, SENSITIVE_FIELD, DetectionAction::Passed, 1);
                        }
                        continue;
                    }
                }
                scan_json_value(policy, key, field_value, detections)?;
            }
        }
        _ => {}
    }
    Ok(())
}

/// Splits a token span's inner text into (category, base64url payload).
fn parse_token_span(span: &str) -> Option<(&str, &str)> {
    let inner = span.strip_prefix('[')?.strip_suffix(']')?;
    inner.split_once(":TOKEN_")
}

/// Resolves one token span to its plaintext; `None` on any parse or verification failure.
fn resolve_span(key: &EngineKey, span: &str) -> Option<String> {
    let (category, payload) = parse_token_span(span)?;
    let ciphertext = decode_payload(payload).ok()?;
    let plaintext_bytes = open(key, category, &ciphertext).ok()?;
    String::from_utf8(plaintext_bytes).ok()
}

/// Replaces EVERY token span with its plaintext; the first failed tag verification aborts with Err.
pub fn detokenize_text(key: &EngineKey, text: &str) -> Result<String, DetokenizeError> {
    let re = token_span_regex().map_err(|_| DetokenizeError::TokenPatternInvalid)?;
    let mut result = String::with_capacity(text.len());
    let mut last = 0;
    for (index, m) in re.find_iter(text).enumerate() {
        let plaintext =
            resolve_span(key, m.as_str()).ok_or_else(|| DetokenizeError::VerificationFailed {
                category: parse_token_span(m.as_str())
                    .map_or_else(|| "unknown".to_string(), |(c, _)| c.to_string()),
                index,
            })?;
        result.push_str(&text[last..m.start()]);
        result.push_str(&plaintext);
        last = m.end();
    }
    result.push_str(&text[last..]);
    Ok(result)
}

/// Per-span detokenization for presentation: resolvable spans are replaced, unresolvable
/// spans stay verbatim. Never fails; tool-call paths must use the fail-closed variants instead.
pub fn detokenize_text_lossy(key: &EngineKey, text: &str) -> String {
    let Ok(re) = token_span_regex() else {
        return text.to_string();
    };
    let mut result = String::with_capacity(text.len());
    let mut last = 0;
    for m in re.find_iter(text) {
        result.push_str(&text[last..m.start()]);
        match resolve_span(key, m.as_str()) {
            Some(plaintext) => result.push_str(&plaintext),
            None => result.push_str(m.as_str()),
        }
        last = m.end();
    }
    result.push_str(&text[last..]);
    result
}

fn detokenize_json_value(
    key: &EngineKey,
    value: &mut serde_json::Value,
) -> Result<(), DetokenizeError> {
    match value {
        serde_json::Value::String(s) => {
            *s = detokenize_text(key, s)?;
        }
        serde_json::Value::Array(items) => {
            for item in items.iter_mut() {
                detokenize_json_value(key, item)?;
            }
        }
        serde_json::Value::Object(map) => {
            for (_, v) in map.iter_mut() {
                detokenize_json_value(key, v)?;
            }
        }
        _ => {}
    }
    Ok(())
}

/// In-place detokenization of every string in a JSON tree; all-or-nothing like detokenize_text.
pub fn detokenize_json(
    key: &EngineKey,
    value: &mut serde_json::Value,
) -> Result<(), DetokenizeError> {
    let mut clone = value.clone();
    detokenize_json_value(key, &mut clone)?;
    *value = clone;
    Ok(())
}

#[cfg(test)]
#[expect(
    clippy::expect_used,
    reason = "test code: panics on setup failure are acceptable"
)]
mod tests {
    use super::*;
    use crate::policy::compile_policy_v2;
    use crate::siv::{encode_payload as siv_encode_payload, seal as siv_seal};

    fn test_key() -> EngineKey {
        EngineKey::from_bytes([9u8; 32])
    }

    const FULL_POLICY: &str = r#"{
        "version": 2,
        "source": { "policies": ["strict"], "forced": [] },
        "categories": {
            "EMAIL":           { "tokenize": true,  "log": false },
            "PHONE_PL":        { "tokenize": true,  "log": false },
            "PESEL":           { "tokenize": true,  "log": false },
            "NIP":             { "tokenize": true,  "log": false },
            "IBAN":            { "tokenize": true,  "log": false },
            "CARD":            { "tokenize": true,  "log": false },
            "API_KEY":         { "tokenize": true,  "log": false },
            "SENSITIVE_FIELD": { "tokenize": true,  "log": false }
        },
        "customPatterns": [],
        "sensitiveKeys": ["password", "token", "secret"]
    }"#;

    fn full_policy() -> CompiledPolicy {
        compile_policy_v2(FULL_POLICY).expect("valid policy compiles")
    }

    #[test]
    fn roundtrip_email_and_pesel() {
        let policy = full_policy();
        let key = test_key();
        let original = "Contact alice@example.com, PESEL 44051401359 please";

        let outcome = scan_text(&policy, &key, original).expect("scan succeeds");
        assert!(!outcome.text.contains("alice@example.com"));
        assert!(!outcome.text.contains("44051401359"));
        assert!(outcome.text.contains("[EMAIL:TOKEN_"));
        assert!(outcome.text.contains("[PESEL:TOKEN_"));

        let restored = detokenize_text(&key, &outcome.text).expect("detokenize succeeds");
        assert_eq!(restored, original);
    }

    #[test]
    fn scanning_twice_is_idempotent() {
        let policy = full_policy();
        let key = test_key();
        let original = "Contact alice@example.com about card 4532-0151-1283-0366";

        let first = scan_text(&policy, &key, original).expect("scan succeeds");
        let second = scan_text(&policy, &key, &first.text).expect("scan succeeds");

        assert_eq!(first.text, second.text);
        assert!(second.detections.is_empty());
    }

    #[test]
    fn digits_inside_an_existing_token_are_not_rematched() {
        let policy = full_policy();
        let key = test_key();

        let pesel_only = scan_text(&policy, &key, "PESEL 44051401359").expect("scan succeeds");
        let combined = format!("{} and NIP 5261040828", pesel_only.text);

        let outcome = scan_text(&policy, &key, &combined).expect("scan succeeds");
        assert!(!outcome.detections.iter().any(|d| d.category == "PESEL"));
        let nip = outcome
            .detections
            .iter()
            .find(|d| d.category == "NIP")
            .expect("NIP detected");
        assert_eq!(nip.count, 1);
        assert!(outcome.text.contains("[PESEL:TOKEN_"));
        assert!(outcome.text.contains("[NIP:TOKEN_"));
    }

    #[test]
    fn same_value_same_category_is_stable_across_calls() {
        let policy = full_policy();
        let key = test_key();
        let text = "Email me@example.com";

        let a = scan_text(&policy, &key, text).expect("scan succeeds");
        let b = scan_text(&policy, &key, text).expect("scan succeeds");
        assert_eq!(a.text, b.text);
    }

    #[test]
    fn same_value_different_category_is_a_different_token() {
        let key = test_key();
        let email_ct = siv_seal(&key, "EMAIL", b"same-value").expect("seal succeeds");
        let custom_ct = siv_seal(&key, "CUSTOM", b"same-value").expect("seal succeeds");
        assert_ne!(
            siv_encode_payload(&email_ct),
            siv_encode_payload(&custom_ct)
        );
    }

    #[test]
    fn observation_mode_counts_without_replacing() {
        let json = FULL_POLICY.replacen(
            "\"EMAIL\":           { \"tokenize\": true,  \"log\": false },",
            "\"EMAIL\":           { \"tokenize\": false, \"log\": true  },",
            1,
        );
        let policy = compile_policy_v2(&json).expect("valid policy compiles");
        let key = test_key();
        let original = "Contact alice@example.com now";

        let outcome = scan_text(&policy, &key, original).expect("scan succeeds");
        assert_eq!(outcome.text, original);
        assert_eq!(
            outcome.detections,
            vec![Detection {
                category: "EMAIL".to_string(),
                action: DetectionAction::Passed,
                count: 1,
            }]
        );
    }

    #[test]
    fn three_emails_two_unique_aggregate_into_one_detection() {
        let policy = full_policy();
        let key = test_key();
        let text = "a@example.com b@example.com a@example.com";

        let outcome = scan_text(&policy, &key, text).expect("scan succeeds");
        assert_eq!(outcome.detections.len(), 1);
        assert_eq!(outcome.detections[0].category, "EMAIL");
        assert_eq!(outcome.detections[0].count, 3);

        let tokens: Vec<&str> = outcome
            .text
            .split_whitespace()
            .filter(|s| s.starts_with("[EMAIL:TOKEN_"))
            .collect();
        assert_eq!(tokens.len(), 3);
        assert_eq!(tokens[0], tokens[2]);
        assert_ne!(tokens[0], tokens[1]);
    }

    #[test]
    fn invalid_pesel_checksum_yields_zero_detections() {
        let policy = full_policy();
        let key = test_key();
        let text = "id 12345678901 end";

        let outcome = scan_text(&policy, &key, text).expect("scan succeeds");
        assert!(outcome.detections.is_empty());
        assert_eq!(outcome.text, text);
    }

    #[test]
    fn scan_json_jira_like_payload_roundtrips() {
        let policy = full_policy();
        let key = test_key();

        let mut value = serde_json::json!({
            "issue": {
                "reporter_email": "reporter@example.com",
                "password": "hunter2",
                "watchers": ["one@example.com", "two@example.com"],
                "id": 42,
                "resolved": false,
            }
        });
        let original = value.clone();

        let detections = scan_json(&policy, &key, &mut value).expect("scan succeeds");
        assert!(detections.iter().any(|d| d.category == "EMAIL"));
        assert!(detections.iter().any(|d| d.category == "SENSITIVE_FIELD"));
        assert_eq!(value["issue"]["id"], 42);
        assert_eq!(value["issue"]["resolved"], false);
        assert_ne!(value["issue"]["password"], original["issue"]["password"]);

        detokenize_json(&key, &mut value).expect("detokenize succeeds");
        assert_eq!(value, original);
    }

    #[test]
    fn sensitive_key_non_string_value_is_left_untouched() {
        let policy = full_policy();
        let key = test_key();
        let mut value = serde_json::json!({ "password": 12345, "token": true });

        let detections = scan_json(&policy, &key, &mut value).expect("scan succeeds");
        assert!(detections.is_empty());
        assert_eq!(value["password"], 12345);
        assert_eq!(value["token"], true);
    }

    #[test]
    fn scan_json_is_idempotent_for_sensitive_fields() {
        let policy = full_policy();
        let key = test_key();
        let mut value = serde_json::json!({ "password": "hunter2" });

        scan_json(&policy, &key, &mut value).expect("scan succeeds");
        let second = scan_json(&policy, &key, &mut value).expect("scan succeeds");
        assert!(second.is_empty());
    }

    #[test]
    fn overlapping_phone_inside_iban_shaped_value_masks_deterministically() {
        // PHONE_PL (no `\b` anchor) runs before IBAN in rule order, masking digits IBAN needs.
        // NIP's `\b` anchor prevents it matching mid-alnum, unlike PHONE_PL.
        let policy = full_policy();
        let key = test_key();
        let text = "Account PL61ABCD48123456789 on file";

        let outcome = scan_text(&policy, &key, text).expect("scan succeeds");
        assert!(!outcome.detections.iter().any(|d| d.category == "IBAN"));
        let phone = outcome
            .detections
            .iter()
            .find(|d| d.category == "PHONE_PL")
            .expect("PHONE_PL detected");
        assert_eq!(phone.count, 1);

        let expected_token = build_token(&key, "PHONE_PL", "48123456789").expect("token builds");
        let expected = format!("Account PL61ABCD{expected_token} on file");
        assert_eq!(outcome.text, expected);
    }

    #[test]
    fn detokenize_rejects_flipped_bit_mismatched_category_and_non_base64() {
        let policy = full_policy();
        let key = test_key();
        let scanned = scan_text(&policy, &key, "Email x@example.com")
            .expect("scan succeeds")
            .text;

        // Flip a bit inside the base64 payload (ASCII-safe swap keeps the buffer valid UTF-8).
        let pos = scanned.find("TOKEN_").expect("token present") + "TOKEN_".len();
        let mut bytes = scanned.into_bytes();
        bytes[pos] = if bytes[pos] == b'A' { b'B' } else { b'A' };
        let flipped = String::from_utf8(bytes).expect("still valid utf8");
        assert!(detokenize_text(&key, &flipped).is_err());

        // Category in the span does not match the AAD the value was sealed under.
        let pesel_ct = siv_seal(&key, "PESEL", b"44051401359").expect("seal succeeds");
        let mismatched = format!("[EMAIL:TOKEN_{}]", siv_encode_payload(&pesel_ct));
        assert!(detokenize_text(&key, &mismatched).is_err());

        // Payload has token-span-legal characters but an invalid base64url length (a single char
        // cannot represent a full byte), so decoding itself fails before any SIV check runs.
        let non_base64 = "[EMAIL:TOKEN_A]";
        assert!(TOKEN_SPAN_REGEX
            .as_ref()
            .expect("token regex compiles")
            .is_match(non_base64));
        assert!(detokenize_text(&key, non_base64).is_err());
    }

    #[test]
    fn detokenize_text_without_tokens_is_identity_and_unknown_category_errs() {
        let key = test_key();
        assert_eq!(
            detokenize_text(&key, "plain text, nothing to see").expect("detokenize succeeds"),
            "plain text, nothing to see"
        );

        let email_ct = siv_seal(&key, "EMAIL", b"whatever").expect("seal succeeds");
        let unknown_category = format!("[FOO:TOKEN_{}]", siv_encode_payload(&email_ct));
        assert!(detokenize_text(&key, &unknown_category).is_err());
    }

    #[test]
    fn large_csv_smoke_test_scans_to_completion() {
        let policy = full_policy();
        let key = test_key();
        let mut csv = String::new();
        for i in 0..1000 {
            csv.push_str(&format!("row{i},user{i}@example.com\n"));
        }

        let outcome = scan_text(&policy, &key, &csv).expect("scan succeeds");
        let email_detection = outcome
            .detections
            .iter()
            .find(|d| d.category == "EMAIL")
            .expect("EMAIL detected");
        assert_eq!(email_detection.count, 1000);
    }

    #[test]
    fn detokenize_text_two_tokens_first_valid_second_corrupted_rejects_all_or_nothing() {
        let key = test_key();
        // First token is valid, second has a flipped bit in base64 payload.
        let first_valid_ct = siv_seal(&key, "EMAIL", b"first@example.com").expect("seal succeeds");
        let first_token = format!("[EMAIL:TOKEN_{}]", siv_encode_payload(&first_valid_ct));
        let second_valid_ct =
            siv_seal(&key, "EMAIL", b"second@example.com").expect("seal succeeds");
        let mut second_bytes = siv_encode_payload(&second_valid_ct).into_bytes();
        second_bytes[0] = if second_bytes[0] == b'A' { b'B' } else { b'A' };
        let second_token = format!(
            "[EMAIL:TOKEN_{}]",
            String::from_utf8(second_bytes).expect("still valid utf8")
        );
        let text = format!("Email {} and {}", first_token, second_token);

        let result = detokenize_text(&key, &text);
        assert!(result.is_err(), "should reject on second token corruption");
    }

    #[test]
    fn detokenize_json_two_fields_first_valid_token_second_corrupted_keeps_input_unchanged() {
        let key = test_key();
        let first_valid_ct = siv_seal(&key, "EMAIL", b"user@example.com").expect("seal succeeds");
        let first_token = format!("[EMAIL:TOKEN_{}]", siv_encode_payload(&first_valid_ct));
        let second_valid_ct = siv_seal(&key, "EMAIL", b"other@example.com").expect("seal succeeds");
        let mut second_bytes = siv_encode_payload(&second_valid_ct).into_bytes();
        second_bytes[0] = if second_bytes[0] == b'A' { b'B' } else { b'A' };
        let second_token = format!(
            "[EMAIL:TOKEN_{}]",
            String::from_utf8(second_bytes).expect("still valid utf8")
        );

        let original = serde_json::json!({
            "primary": first_token,
            "secondary": second_token
        });
        let mut value = original.clone();

        let result = detokenize_json(&key, &mut value);
        assert!(result.is_err(), "should reject on second token corruption");
        assert_eq!(value, original, "input must remain unchanged after error");
    }

    // ── detokenize_text_lossy: per-span presentation variant ──

    #[test]
    fn lossy_resolves_valid_spans_and_keeps_unresolvable_ones_verbatim() {
        let key = test_key();
        let valid_ct = siv_seal(
            &key,
            "EMAIL",
            b"[EMAIL:TOKEN_S6Vqu7yWuqrhbwHUuU7GAsi0M6emGFXCiEHbo9lIVsjNvw]",
        )
        .expect("seal succeeds");
        let valid_token = format!("[EMAIL:TOKEN_{}]", siv_encode_payload(&valid_ct));
        let text = format!("real {valid_token} fake [EMAIL:TOKEN_XYZ] end");

        let displayed = detokenize_text_lossy(&key, &text);
        assert_eq!(displayed, "real [EMAIL:TOKEN_S6Vqu7yWuqrhbwHUuU7GAsi0M6emGFXCiEHbo9lIVsjNvw] fake [EMAIL:TOKEN_XYZ] end");
    }

    #[test]
    fn lossy_keeps_flipped_bit_span_verbatim_and_resolves_its_valid_neighbor() {
        let key = test_key();
        let first_ct = siv_seal(
            &key,
            "EMAIL",
            b"[EMAIL:TOKEN_kbmxDYUcxYCV0v9lHDfVDX9TG9ORSU9lHqsxWmye9BUq]",
        )
        .expect("seal succeeds");
        let first_token = format!("[EMAIL:TOKEN_{}]", siv_encode_payload(&first_ct));
        let second_ct = siv_seal(
            &key,
            "EMAIL",
            b"[EMAIL:TOKEN_2q2xCFkxOI2vLuJ3S4NCA33olsxh1jieUqzYqAkzGpU8pg]",
        )
        .expect("seal succeeds");
        let mut second_bytes = siv_encode_payload(&second_ct).into_bytes();
        second_bytes[0] = if second_bytes[0] == b'A' { b'B' } else { b'A' };
        let second_token = format!(
            "[EMAIL:TOKEN_{}]",
            String::from_utf8(second_bytes).expect("still valid utf8")
        );
        let text = format!("{first_token} and {second_token}");

        let displayed = detokenize_text_lossy(&key, &text);
        assert_eq!(
            displayed,
            format!(
                "[EMAIL:TOKEN_kbmxDYUcxYCV0v9lHDfVDX9TG9ORSU9lHqsxWmye9BUq] and {second_token}"
            )
        );
    }

    #[test]
    fn lossy_with_wrong_key_leaves_every_span_verbatim() {
        let key = test_key();
        let other_key = EngineKey::from_bytes([7u8; 32]);
        let ct = siv_seal(
            &key,
            "EMAIL",
            b"[EMAIL:TOKEN_Yl4h9nJRt3THY3zoNklqXVIcCq3zKA2rrPO4mCUW6uWm]",
        )
        .expect("seal succeeds");
        let token = format!("[EMAIL:TOKEN_{}]", siv_encode_payload(&ct));

        assert_eq!(detokenize_text_lossy(&other_key, &token), token);
    }

    #[test]
    fn lossy_unknown_category_span_stays_verbatim() {
        let key = test_key();
        let ct = siv_seal(&key, "EMAIL", b"whatever").expect("seal succeeds");
        let span = format!("[FOO:TOKEN_{}]", siv_encode_payload(&ct));

        assert_eq!(detokenize_text_lossy(&key, &span), span);
    }

    #[test]
    fn lossy_without_tokens_is_identity_and_empty_is_empty() {
        let key = test_key();
        assert_eq!(
            detokenize_text_lossy(&key, "plain text, nothing to see"),
            "plain text, nothing to see"
        );
        assert_eq!(detokenize_text_lossy(&key, ""), "");
    }
}
