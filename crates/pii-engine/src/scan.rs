//! Scanning, tokenization, and fail-closed detokenization
//! (TS counterpart: `mcp-servers/policies/src/tokenizer.ts`).

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
    /// Category id: a rule id from policy.json.
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

/// Finds validated hits in one plain segment across every pattern in the rule (any pattern
/// matching counts as a hit) and, if tokenizing, replaces them (dedup by value).
fn tokenize_segment(
    segment: &str,
    rule: &crate::policy::CompiledRule,
    key: &EngineKey,
) -> Result<(Vec<Segment>, u32), ScanError> {
    let mut candidates: Vec<(usize, usize, String)> = Vec::new();
    for pattern in &rule.patterns {
        for m in pattern.find_iter(segment) {
            let value = m.as_str();
            if let Some(validator) = rule.validator {
                if !validator(value) {
                    continue;
                }
            }
            candidates.push((m.start(), m.end(), value.to_string()));
        }
    }
    // Earliest start first; at equal start, longest match first, so overlapping hits from a
    // rule's other patterns never re-match text already claimed.
    candidates.sort_by_key(|(start, end, _)| (*start, std::cmp::Reverse(*end)));

    let mut hits: Vec<(usize, usize, String)> = Vec::new();
    let mut last_end = 0usize;
    for (start, end, value) in candidates {
        if start < last_end {
            continue;
        }
        hits.push((start, end, value));
        last_end = end;
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

/// Merges a sub-tree's detections into the whole-tree aggregate.
fn merge_detections(agg: &mut Vec<Detection>, more: Vec<Detection>) {
    for d in more {
        if let Some(existing) = agg.iter_mut().find(|e| e.category == d.category) {
            existing.count += d.count;
        } else {
            agg.push(d);
        }
    }
}

/// Scans a JSON tree in place: every string value is scanned through the rule set.
/// All-or-nothing: on error, the input remains unchanged.
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
            for (_, field_value) in map.iter_mut() {
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

/// Case pattern detected in a matched span, applied to the substituted replacement text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CasePattern {
    Lowercase,
    Uppercase,
    Title,
    Mixed,
}

/// Classifies a span's letter casing: all-lower, all-upper, first-letter-upper-rest-lower
/// (Title), or anything else (Mixed, returned verbatim by [`apply_case_pattern`]).
fn detect_case_pattern(text: &str) -> CasePattern {
    let alpha: Vec<char> = text.chars().filter(|c| c.is_alphabetic()).collect();
    if alpha.is_empty() {
        return CasePattern::Mixed;
    }
    if alpha.iter().all(|c| c.is_uppercase()) {
        return CasePattern::Uppercase;
    }
    if alpha.iter().all(|c| c.is_lowercase()) {
        return CasePattern::Lowercase;
    }
    let mut chars = text.chars();
    let is_title = chars
        .next()
        .is_some_and(|c| !c.is_alphabetic() || c.is_uppercase())
        && chars.all(|c| !c.is_alphabetic() || c.is_lowercase());
    if is_title {
        CasePattern::Title
    } else {
        CasePattern::Mixed
    }
}

/// Reshapes `text` into the given case pattern; `Mixed` is returned verbatim (no single
/// case transform represents it correctly).
fn apply_case_pattern(text: &str, pattern: CasePattern) -> String {
    match pattern {
        CasePattern::Lowercase => text.to_lowercase(),
        CasePattern::Uppercase => text.to_uppercase(),
        CasePattern::Title => {
            let mut chars = text.chars();
            match chars.next() {
                None => String::new(),
                Some(first) => {
                    first.to_uppercase().collect::<String>() + &chars.as_str().to_lowercase()
                }
            }
        }
        CasePattern::Mixed => text.to_string(),
    }
}

/// Byte range of the first case-insensitive match of `needle` in `text` at or after byte
/// offset `from`. Case folding is ASCII-only (matches keyword semantics); a needle containing
/// only ASCII letters/digits/punctuation is unaffected, non-ASCII letters compare literally.
fn find_case_insensitive(text: &str, needle: &str, from: usize) -> Option<(usize, usize)> {
    if needle.is_empty() {
        return None;
    }
    let needle_lower: Vec<char> = needle.chars().map(|c| c.to_ascii_lowercase()).collect();
    let chars: Vec<(usize, char)> = text.char_indices().filter(|&(b, _)| b >= from).collect();

    for i in 0..chars.len() {
        if i + needle_lower.len() > chars.len() {
            break;
        }
        let is_match = chars[i..i + needle_lower.len()]
            .iter()
            .zip(needle_lower.iter())
            .all(|(&(_, c), &n)| c.to_ascii_lowercase() == n);
        if is_match {
            let start = chars[i].0;
            let end = chars
                .get(i + needle_lower.len())
                .map_or(text.len(), |&(b, _)| b);
            return Some((start, end));
        }
    }
    None
}

/// Replaces every occurrence of `needle` with `replacement`; case-sensitive mode is a plain
/// substring replace, case-insensitive mode preserves each match's case pattern.
fn substitute_preserving_case(
    text: &str,
    needle: &str,
    replacement: &str,
    case_sensitive: bool,
) -> String {
    if case_sensitive {
        return text.replace(needle, replacement);
    }
    let mut result = String::with_capacity(text.len());
    let mut pos = 0;
    while pos < text.len() {
        match find_case_insensitive(text, needle, pos) {
            Some((start, end)) => {
                result.push_str(&text[pos..start]);
                let pattern = detect_case_pattern(&text[start..end]);
                result.push_str(&apply_case_pattern(replacement, pattern));
                pos = end;
            }
            None => {
                result.push_str(&text[pos..]);
                pos = text.len();
            }
        }
    }
    result
}

/// Masks every occurrence of `match_text` with `alias`, preserving the matched span's case
/// pattern (lowercase/UPPERCASE/Title) when `case_sensitive` is false.
pub fn alias_text(text: &str, match_text: &str, alias: &str, case_sensitive: bool) -> String {
    substitute_preserving_case(text, match_text, alias, case_sensitive)
}

/// Reverses [`alias_text`]: replaces every occurrence of `alias` with `match_text`,
/// preserving the matched span's case pattern.
pub fn unalias_text(text: &str, match_text: &str, alias: &str, case_sensitive: bool) -> String {
    substitute_preserving_case(text, alias, match_text, case_sensitive)
}

/// [`unalias_text`], but skipping any already-formed PII token span (the same
/// `TOKEN_SPAN_RE` masking [`mask_spans`] uses for scan idempotency): a coincidental
/// alias-shaped substring inside a token's base64 ciphertext is never touched (design
/// doc §7.2 — the response path unmasks keywords before PII spans are detokenized, so
/// the spans are still present as literal text when this runs).
pub fn unalias_text_preserving_tokens(
    text: &str,
    match_text: &str,
    alias: &str,
    case_sensitive: bool,
) -> String {
    match mask_spans(text) {
        Ok(segments) => segments
            .into_iter()
            .map(|segment| match segment {
                Segment::Plain(s) => unalias_text(&s, match_text, alias, case_sensitive),
                Segment::Masked(s) => s,
            })
            .collect(),
        Err(_) => text.to_string(),
    }
}

#[cfg(test)]
#[expect(
    clippy::expect_used,
    reason = "test code: panics on setup failure are acceptable"
)]
mod tests {
    use super::*;
    use crate::policy::compile_policy_v3;
    use crate::siv::{encode_payload as siv_encode_payload, seal as siv_seal};

    fn test_key() -> EngineKey {
        EngineKey::from_bytes([9u8; 32])
    }

    const FULL_POLICY: &str = r#"{
        "version": 3,
        "source": { "policies": ["strict"], "forced": [] },
        "rules": [
            { "id": "EMAIL", "displayName": "E-mail", "patterns": ["[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}"], "caseSensitive": true, "tokenize": true, "log": false },
            { "id": "PHONE_PL", "displayName": "Phone", "patterns": ["\\+?48[\\s-]?\\d{3}[\\s-]?\\d{3}[\\s-]?\\d{3}"], "caseSensitive": true, "tokenize": true, "log": false },
            { "id": "PESEL", "displayName": "PESEL", "patterns": ["(?-u:\\b)\\d{11}(?-u:\\b)"], "validator": "pesel", "caseSensitive": true, "tokenize": true, "log": false },
            { "id": "NIP", "displayName": "NIP", "patterns": ["(?-u:\\b)\\d{10}(?-u:\\b)"], "validator": "nip", "caseSensitive": true, "tokenize": true, "log": false },
            { "id": "IBAN", "displayName": "IBAN", "patterns": ["[A-Z]{2}\\d{2}[A-Z0-9]{4}\\d{7}([A-Z0-9]?){0,16}"], "validator": "iban", "caseSensitive": true, "tokenize": true, "log": false },
            { "id": "CARD", "displayName": "Card", "patterns": ["(?-u:\\b)(?:\\d{4}[\\s-]?){3}\\d{4}(?-u:\\b)"], "validator": "luhn", "caseSensitive": true, "tokenize": true, "log": false },
            { "id": "API_KEY", "displayName": "API key", "patterns": ["(?-u:\\b)(sk-[a-zA-Z0-9]{20,}|xoxb-[a-zA-Z0-9-]+|xoxp-[a-zA-Z0-9-]+)(?-u:\\b)"], "caseSensitive": true, "tokenize": true, "log": false }
        ],
        "keywords": []
    }"#;

    fn full_policy() -> CompiledPolicy {
        compile_policy_v3(FULL_POLICY).expect("valid policy compiles")
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
            r#"{ "id": "EMAIL", "displayName": "E-mail", "patterns": ["[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}"], "caseSensitive": true, "tokenize": true, "log": false },"#,
            r#"{ "id": "EMAIL", "displayName": "E-mail", "patterns": ["[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}"], "caseSensitive": true, "tokenize": false, "log": true },"#,
            1,
        );
        let policy = compile_policy_v3(&json).expect("valid policy compiles");
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
    fn scan_json_nested_payload_roundtrips() {
        let policy = full_policy();
        let key = test_key();

        let mut value = serde_json::json!({
            "issue": {
                "reporter_email": "reporter@example.com",
                "watchers": ["one@example.com", "two@example.com"],
                "id": 42,
                "resolved": false,
            }
        });
        let original = value.clone();

        let detections = scan_json(&policy, &key, &mut value).expect("scan succeeds");
        assert!(detections.iter().any(|d| d.category == "EMAIL"));
        assert_eq!(value["issue"]["id"], 42);
        assert_eq!(value["issue"]["resolved"], false);
        assert_ne!(
            value["issue"]["reporter_email"],
            original["issue"]["reporter_email"]
        );

        detokenize_json(&key, &mut value).expect("detokenize succeeds");
        assert_eq!(value, original);
    }

    #[test]
    fn scan_json_non_string_values_are_left_untouched() {
        let policy = full_policy();
        let key = test_key();
        let mut value = serde_json::json!({ "count": 12345, "active": true });

        let detections = scan_json(&policy, &key, &mut value).expect("scan succeeds");
        assert!(detections.is_empty());
        assert_eq!(value["count"], 12345);
        assert_eq!(value["active"], true);
    }

    #[test]
    fn multiple_patterns_in_one_rule_both_match_without_double_counting_overlap() {
        // PHONE_PL matches once via its single pattern in FULL_POLICY; verify a rule with two
        // overlapping patterns dedupes rather than double-counting the same span.
        let json = r#"{
            "version": 3,
            "source": { "policies": [], "forced": [] },
            "rules": [
                { "id": "MULTI", "displayName": "Multi", "patterns": ["\\d{3}-\\d{3}", "\\d{3}-\\d{3}-\\d{3}"], "caseSensitive": true, "tokenize": true, "log": false }
            ],
            "keywords": []
        }"#;
        let policy = compile_policy_v3(json).expect("valid policy compiles");
        let key = test_key();

        let outcome = scan_text(&policy, &key, "id 111-222-333 end").expect("scan succeeds");
        let multi = outcome
            .detections
            .iter()
            .find(|d| d.category == "MULTI")
            .expect("MULTI detected");
        assert_eq!(
            multi.count, 1,
            "overlapping patterns in one rule must not double-count"
        );
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

    // ── alias_text / unalias_text: keyword masking with case preservation ──

    #[test]
    fn alias_text_case_sensitive_replaces_exact_case_only() {
        assert_eq!(
            alias_text("Coca-Cola is great", "Coca-Cola", "Brandex", true),
            "Brandex is great"
        );
        assert_eq!(
            alias_text("coca-cola is great", "Coca-Cola", "Brandex", true),
            "coca-cola is great",
            "different case must not match under case_sensitive"
        );
    }

    #[test]
    fn alias_text_case_insensitive_preserves_mixed_case_verbatim() {
        let result = alias_text("Coca-Cola Company", "Coca-Cola", "Brandex", false);
        assert_eq!(result, "Brandex Company");
    }

    #[test]
    fn alias_text_case_insensitive_preserves_uppercase() {
        let result = alias_text("COCA-COLA COMPANY", "coca-cola", "BRANDEX", false);
        assert_eq!(result, "BRANDEX COMPANY");
    }

    #[test]
    fn alias_text_case_insensitive_preserves_lowercase() {
        let result = alias_text("contact coca-cola today", "Coca-Cola", "brandex", false);
        assert_eq!(result, "contact brandex today");
    }

    #[test]
    fn alias_text_case_insensitive_preserves_title_case_single_word() {
        let result = alias_text("Secret project underway", "secret", "public", false);
        assert_eq!(result, "Public project underway");
    }

    #[test]
    fn alias_text_replaces_every_occurrence() {
        let result = alias_text("acme and ACME and Acme", "acme", "megacorp", false);
        assert_eq!(result, "megacorp and MEGACORP and Megacorp");
    }

    #[test]
    fn alias_and_unalias_roundtrip() {
        // A single-word match/alias keeps every occurrence's case pattern within the
        // lowercase/UPPERCASE/Title taxonomy, so round-tripping is exact; a multi-capital
        // span like "Coca-Cola" detects as Mixed and is not guaranteed to round-trip (the
        // alias itself may read as Title-shaped, e.g. "Brandex"), which is an accepted
        // limitation of the four-bucket case model, not exercised here.
        let original = "acme signed with ACME and Acme twice";
        let masked = alias_text(original, "acme", "brandex", false);
        assert!(!masked.to_lowercase().contains("acme"));
        let restored = unalias_text(&masked, "acme", "brandex", false);
        assert_eq!(restored, original);
    }

    #[test]
    fn unalias_text_case_sensitive_replaces_exact_case_only() {
        assert_eq!(
            unalias_text("Brandex is great", "Coca-Cola", "Brandex", true),
            "Coca-Cola is great"
        );
    }

    #[test]
    fn alias_text_no_match_is_identity() {
        assert_eq!(
            alias_text("nothing to see here", "Coca-Cola", "Brandex", false),
            "nothing to see here"
        );
    }

    // ── unalias_text_preserving_tokens: keyword unmask must skip PII token spans ──

    #[test]
    fn preserving_tokens_unmasks_plain_text_normally() {
        let result =
            unalias_text_preserving_tokens("Use Brandex API", "Coca-Cola", "Brandex", true);
        assert_eq!(result, "Use Coca-Cola API");
    }

    #[test]
    fn preserving_tokens_never_touches_a_token_spans_ciphertext() {
        let key = test_key();
        // An alias-shaped ciphertext substring is astronomically unlikely in practice, but
        // the mechanism must still leave the whole span untouched byte-for-byte: build a
        // real token and confirm it survives verbatim even when it appears next to the
        // alias in plain text.
        let ciphertext = siv_seal(&key, "EMAIL", b"alias@example.com").expect("seal succeeds");
        let token = format!("[EMAIL:TOKEN_{}]", siv_encode_payload(&ciphertext));
        let text = format!("Brandex sent from {token}");

        let result = unalias_text_preserving_tokens(&text, "Coca-Cola", "Brandex", true);
        assert_eq!(result, format!("Coca-Cola sent from {token}"));
    }

    #[test]
    fn preserving_tokens_is_a_noop_with_no_match() {
        let result =
            unalias_text_preserving_tokens("nothing to see here", "Coca-Cola", "Brandex", false);
        assert_eq!(result, "nothing to see here");
    }
}
