//! Parser and compiler for the `policy.json` v2 inter-component contract
//! (host renders it, proxy and hub consume the compiled form).

use crate::patterns::{self, BUILTIN_CATEGORIES, SENSITIVE_FIELD};
use regex::{Regex, RegexBuilder};
use serde::Deserialize;
use std::collections::{HashMap, HashSet};

/// Per-category protection flags from policy.json v2.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct CategoryFlags {
    /// Whether hits in this category are tokenized (sealed) before leaving the engine.
    pub tokenize: bool,
    /// Whether hits in this category are logged (observation mode).
    pub log: bool,
}

/// One ready-to-scan rule: category id, compiled regex, optional checksum validator, flags.
pub struct CompiledRule {
    /// Category id: a built-in category or a `customPatterns[].id`.
    pub category: String,
    /// Compiled value-match regex for this category.
    pub regex: Regex,
    /// Checksum validator run on a regex match before it counts as a hit.
    pub validator: Option<fn(&str) -> bool>,
    /// Tokenize/log flags resolved from policy.json for this category.
    pub flags: CategoryFlags,
}

/// A policy.json v2, parsed, validated and compiled for scanning.
pub struct CompiledPolicy {
    rules: Vec<CompiledRule>,
    sensitive_field_flags: CategoryFlags,
    sensitive_keys: Vec<String>,
}

impl CompiledPolicy {
    /// Value-pattern rules with at least one flag on, built-ins first then custom (file order).
    pub fn rules(&self) -> &[CompiledRule] {
        &self.rules
    }

    /// Flags for SENSITIVE_FIELD key-name detection.
    pub fn sensitive_field_flags(&self) -> CategoryFlags {
        self.sensitive_field_flags
    }

    /// Lowercased sensitive key-name substrings.
    pub fn sensitive_keys(&self) -> &[String] {
        &self.sensitive_keys
    }
}

/// A policy.json v2 document failed to parse or violates the contract's semantics.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PolicyError {
    /// Malformed JSON or a v2 shape mismatch; the message carries only line/column, never content.
    Parse(String),
    /// A v2 semantic rule was violated; the message carries only field/category/pattern ids.
    Semantic(String),
}

impl std::fmt::Display for PolicyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Parse(msg) => write!(f, "policy parse error: {msg}"),
            Self::Semantic(msg) => write!(f, "policy semantic error: {msg}"),
        }
    }
}

impl std::error::Error for PolicyError {}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct PolicyFileV2 {
    version: u32,
    #[serde(rename = "source")]
    _source: SourceMeta,
    categories: HashMap<String, CategoryConfig>,
    #[serde(default)]
    custom_patterns: Vec<CustomPatternConfig>,
    #[serde(default)]
    sensitive_keys: Vec<String>,
}

/// Policy provenance metadata; parsed and validated structurally but not
/// consumed by compilation.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SourceMeta {
    #[serde(rename = "policies")]
    _policies: Vec<String>,
    #[serde(rename = "forced")]
    _forced: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CategoryConfig {
    tokenize: bool,
    log: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CustomPatternConfig {
    id: String,
    #[serde(rename = "displayName")]
    _display_name: String,
    pattern: String,
    case_insensitive: bool,
    tokenize: bool,
    log: bool,
}

/// Parses + validates + compiles policy.json v2. Any structural or semantic problem is Err.
pub fn compile_policy_v2(json: &str) -> Result<CompiledPolicy, PolicyError> {
    let file: PolicyFileV2 = serde_json::from_str(json).map_err(|e| {
        PolicyError::Parse(format!(
            "malformed policy document at line {} column {}",
            e.line(),
            e.column()
        ))
    })?;

    if file.version != 2 {
        return Err(PolicyError::Semantic(format!(
            "unsupported policy version {}, engine supports version 2 only",
            file.version
        )));
    }

    validate_categories(&file.categories)?;
    validate_custom_patterns(&file.custom_patterns)?;

    let builtin = patterns::builtin_rules().map_err(|e| PolicyError::Semantic(e.to_string()))?;
    let mut rules = Vec::with_capacity(builtin.len() + file.custom_patterns.len());

    for rule in builtin {
        // Presence of every built-in category key is guaranteed by validate_categories.
        let cfg = &file.categories[rule.category];
        let flags = CategoryFlags {
            tokenize: cfg.tokenize,
            log: cfg.log,
        };
        if flags.tokenize || flags.log {
            rules.push(CompiledRule {
                category: rule.category.to_string(),
                regex: rule.regex.clone(),
                validator: rule.validator,
                flags,
            });
        }
    }

    for cp in &file.custom_patterns {
        let flags = CategoryFlags {
            tokenize: cp.tokenize,
            log: cp.log,
        };
        if !(flags.tokenize || flags.log) {
            continue;
        }
        let regex = RegexBuilder::new(&cp.pattern)
            .case_insensitive(cp.case_insensitive)
            .build()
            .map_err(|_| {
                PolicyError::Semantic(format!("custom pattern '{}' failed to compile", cp.id))
            })?;
        rules.push(CompiledRule {
            category: cp.id.clone(),
            regex,
            validator: None,
            flags,
        });
    }

    // Presence of the SENSITIVE_FIELD category key is guaranteed by validate_categories.
    let sensitive_field_cfg = &file.categories[SENSITIVE_FIELD];
    let sensitive_field_flags = CategoryFlags {
        tokenize: sensitive_field_cfg.tokenize,
        log: sensitive_field_cfg.log,
    };

    let sensitive_keys = file
        .sensitive_keys
        .iter()
        .map(|k| k.to_lowercase())
        .collect();

    Ok(CompiledPolicy {
        rules,
        sensitive_field_flags,
        sensitive_keys,
    })
}

/// Serializes the compiled-in default policy.json v2 (every category tokenize-on, engine's
/// default sensitive-key list) — the SSOT fallback for every "no POLICY_FILE" caller (proxy, hub-wasm).
pub fn default_policy_json() -> String {
    let categories: serde_json::Map<String, serde_json::Value> = BUILTIN_CATEGORIES
        .iter()
        .map(|&category| {
            (
                category.to_string(),
                serde_json::json!({ "tokenize": true, "log": false }),
            )
        })
        .collect();
    serde_json::json!({
        "version": 2,
        "source": { "policies": [], "forced": [] },
        "categories": categories,
        "customPatterns": [],
        "sensitiveKeys": patterns::default_sensitive_keys(),
    })
    .to_string()
}

/// Every built-in category must be present exactly once; any other key is unknown.
fn validate_categories(categories: &HashMap<String, CategoryConfig>) -> Result<(), PolicyError> {
    for expected in BUILTIN_CATEGORIES {
        if !categories.contains_key(expected) {
            return Err(PolicyError::Semantic(format!(
                "missing category '{expected}'"
            )));
        }
    }
    for key in categories.keys() {
        if !BUILTIN_CATEGORIES.contains(&key.as_str()) {
            return Err(PolicyError::Semantic(format!("unknown category '{key}'")));
        }
    }
    Ok(())
}

/// Ids must be non-empty, distinct, and not collide with a built-in category.
fn validate_custom_patterns(custom: &[CustomPatternConfig]) -> Result<(), PolicyError> {
    let mut seen: HashSet<&str> = HashSet::new();
    for cp in custom {
        if cp.id.is_empty() {
            return Err(PolicyError::Semantic(
                "custom pattern id must not be empty".to_string(),
            ));
        }
        if BUILTIN_CATEGORIES.contains(&cp.id.as_str()) {
            return Err(PolicyError::Semantic(format!(
                "custom pattern id '{}' collides with a built-in category",
                cp.id
            )));
        }
        if !seen.insert(cp.id.as_str()) {
            return Err(PolicyError::Semantic(format!(
                "duplicate custom pattern id '{}'",
                cp.id
            )));
        }
    }
    Ok(())
}

#[cfg(test)]
#[expect(
    clippy::expect_used,
    reason = "test code: panics on setup failure are acceptable"
)]
mod tests {
    use super::*;

    const FULL_EXAMPLE: &str = r#"{
        "version": 2,
        "source": { "policies": ["strict", "gdpr-art32"], "forced": ["gdpr-art32"] },
        "categories": {
            "EMAIL":           { "tokenize": true,  "log": false },
            "PHONE_PL":        { "tokenize": true,  "log": false },
            "PESEL":           { "tokenize": true,  "log": true  },
            "NIP":             { "tokenize": true,  "log": false },
            "IBAN":            { "tokenize": true,  "log": false },
            "CARD":            { "tokenize": true,  "log": false },
            "API_KEY":         { "tokenize": true,  "log": false },
            "SENSITIVE_FIELD": { "tokenize": true,  "log": false }
        },
        "customPatterns": [
            { "id": "EMPLOYEE_ID", "displayName": "Employee ID", "pattern": "\\bEMP-\\d{4,8}\\b",
              "caseInsensitive": false, "tokenize": true, "log": false }
        ],
        "sensitiveKeys": ["password", "token", "salary"]
    }"#;

    /// Replaces the eight canonical `categories` entries with a caller-supplied JSON object
    /// literal, keeping the rest of [`FULL_EXAMPLE`] intact.
    fn with_categories(categories_json: &str) -> String {
        let categories_start = FULL_EXAMPLE.find("\"categories\"").expect("field present");
        let brace_start = FULL_EXAMPLE[categories_start..]
            .find('{')
            .map(|i| categories_start + i)
            .expect("opening brace");
        let mut depth = 0i32;
        let mut brace_end = brace_start;
        for (offset, ch) in FULL_EXAMPLE[brace_start..].char_indices() {
            match ch {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        brace_end = brace_start + offset;
                        break;
                    }
                }
                _ => {}
            }
        }
        format!(
            "{}{}{}",
            &FULL_EXAMPLE[..brace_start],
            categories_json,
            &FULL_EXAMPLE[brace_end + 1..]
        )
    }

    #[test]
    fn happy_path_compiles_all_rules_builtin_then_custom() {
        let policy = compile_policy_v2(FULL_EXAMPLE).expect("valid policy compiles");
        let rules = policy.rules();
        assert_eq!(rules.len(), 8);
        let categories: Vec<&str> = rules.iter().map(|r| r.category.as_str()).collect();
        assert_eq!(
            categories,
            &[
                "EMAIL",
                "PHONE_PL",
                "PESEL",
                "NIP",
                "IBAN",
                "CARD",
                "API_KEY",
                "EMPLOYEE_ID",
            ]
        );
        assert!(rules.iter().all(|r| r.flags.tokenize || r.flags.log));
        assert_eq!(
            policy.sensitive_keys(),
            &[
                "password".to_string(),
                "token".to_string(),
                "salary".to_string()
            ]
        );
    }

    #[test]
    fn version_1_is_rejected() {
        let json = FULL_EXAMPLE.replacen("\"version\": 2", "\"version\": 1", 1);
        match compile_policy_v2(&json) {
            Err(PolicyError::Semantic(msg)) => assert!(msg.contains("version")),
            Ok(_) => panic!("expected an error, got Ok"),
            Err(e) => panic!("expected a semantic version error, got {e:?}"),
        }
    }

    #[test]
    fn version_3_is_rejected() {
        let json = FULL_EXAMPLE.replacen("\"version\": 2", "\"version\": 3", 1);
        match compile_policy_v2(&json) {
            Err(PolicyError::Semantic(msg)) => assert!(msg.contains("version")),
            Ok(_) => panic!("expected an error, got Ok"),
            Err(e) => panic!("expected a semantic version error, got {e:?}"),
        }
    }

    #[test]
    fn unknown_top_level_field_is_rejected() {
        let json = FULL_EXAMPLE.replacen(
            "\"version\": 2,",
            "\"version\": 2, \"bogusTopLevel\": true,",
            1,
        );
        match compile_policy_v2(&json) {
            Err(PolicyError::Parse(msg)) => assert!(msg.contains("line")),
            Ok(_) => panic!("expected an error, got Ok"),
            Err(e) => panic!("expected a parse error, got {e:?}"),
        }
    }

    #[test]
    fn unknown_category_field_is_rejected() {
        let json = FULL_EXAMPLE.replacen(
            "\"EMAIL\":           { \"tokenize\": true,  \"log\": false },",
            "\"EMAIL\":           { \"tokenize\": true,  \"log\": false, \"bogus\": 1 },",
            1,
        );
        match compile_policy_v2(&json) {
            Err(PolicyError::Parse(msg)) => assert!(msg.contains("line")),
            Ok(_) => panic!("expected an error, got Ok"),
            Err(e) => panic!("expected a parse error, got {e:?}"),
        }
    }

    #[test]
    fn unknown_custom_pattern_field_is_rejected() {
        let json = FULL_EXAMPLE.replacen(
            "\"caseInsensitive\": false, \"tokenize\": true, \"log\": false }",
            "\"caseInsensitive\": false, \"tokenize\": true, \"log\": false, \"bogus\": 1 }",
            1,
        );
        match compile_policy_v2(&json) {
            Err(PolicyError::Parse(msg)) => assert!(msg.contains("line")),
            Ok(_) => panic!("expected an error, got Ok"),
            Err(e) => panic!("expected a parse error, got {e:?}"),
        }
    }

    #[test]
    fn missing_one_category_names_it_in_the_error() {
        let json = with_categories(
            r#"{
                "PHONE_PL":        { "tokenize": true,  "log": false },
                "PESEL":           { "tokenize": true,  "log": true  },
                "NIP":             { "tokenize": true,  "log": false },
                "IBAN":            { "tokenize": true,  "log": false },
                "CARD":            { "tokenize": true,  "log": false },
                "API_KEY":         { "tokenize": true,  "log": false },
                "SENSITIVE_FIELD": { "tokenize": true,  "log": false }
            }"#,
        );
        match compile_policy_v2(&json) {
            Err(PolicyError::Semantic(msg)) => assert!(msg.contains("EMAIL")),
            Ok(_) => panic!("expected an error, got Ok"),
            Err(e) => panic!("expected a missing-category error, got {e:?}"),
        }
    }

    #[test]
    fn unknown_category_name_is_rejected() {
        let json = with_categories(
            r#"{
                "EMAIL":           { "tokenize": true,  "log": false },
                "PHONE_PL":        { "tokenize": true,  "log": false },
                "PESEL":           { "tokenize": true,  "log": true  },
                "NIP":             { "tokenize": true,  "log": false },
                "IBAN":            { "tokenize": true,  "log": false },
                "CARD":            { "tokenize": true,  "log": false },
                "API_KEY":         { "tokenize": true,  "log": false },
                "SENSITIVE_FIELD": { "tokenize": true,  "log": false },
                "FOO":             { "tokenize": true,  "log": false }
            }"#,
        );
        match compile_policy_v2(&json) {
            Err(PolicyError::Semantic(msg)) => assert!(msg.contains("FOO")),
            Ok(_) => panic!("expected an error, got Ok"),
            Err(e) => panic!("expected an unknown-category error, got {e:?}"),
        }
    }

    #[test]
    fn category_off_on_both_flags_is_excluded_from_rules() {
        let json = FULL_EXAMPLE.replacen(
            "\"EMAIL\":           { \"tokenize\": true,  \"log\": false },",
            "\"EMAIL\":           { \"tokenize\": false, \"log\": false },",
            1,
        );
        let policy = compile_policy_v2(&json).expect("valid policy compiles");
        assert!(!policy.rules().iter().any(|r| r.category == "EMAIL"));
    }

    #[test]
    fn category_log_only_is_included_in_rules() {
        let json = FULL_EXAMPLE.replacen(
            "\"EMAIL\":           { \"tokenize\": true,  \"log\": false },",
            "\"EMAIL\":           { \"tokenize\": false, \"log\": true  },",
            1,
        );
        let policy = compile_policy_v2(&json).expect("valid policy compiles");
        let rule = policy
            .rules()
            .iter()
            .find(|r| r.category == "EMAIL")
            .expect("log-only category still produces a rule");
        assert!(!rule.flags.tokenize);
        assert!(rule.flags.log);
    }

    #[test]
    fn custom_pattern_id_colliding_with_builtin_is_rejected() {
        let json = FULL_EXAMPLE.replacen("\"id\": \"EMPLOYEE_ID\"", "\"id\": \"EMAIL\"", 1);
        match compile_policy_v2(&json) {
            Err(PolicyError::Semantic(msg)) => assert!(msg.contains("EMAIL")),
            Ok(_) => panic!("expected an error, got Ok"),
            Err(e) => panic!("expected a semantic collision error, got {e:?}"),
        }
    }

    #[test]
    fn duplicate_custom_pattern_id_is_rejected() {
        let json = FULL_EXAMPLE.replacen(
            "\"customPatterns\": [",
            "\"customPatterns\": [\
                { \"id\": \"EMPLOYEE_ID\", \"displayName\": \"dup\", \"pattern\": \"x\", \
                  \"caseInsensitive\": false, \"tokenize\": true, \"log\": false },",
            1,
        );
        match compile_policy_v2(&json) {
            Err(PolicyError::Semantic(msg)) => assert!(msg.contains("EMPLOYEE_ID")),
            Ok(_) => panic!("expected an error, got Ok"),
            Err(e) => panic!("expected a duplicate id error, got {e:?}"),
        }
    }

    #[test]
    fn invalid_custom_pattern_regex_is_rejected() {
        let json = FULL_EXAMPLE.replacen("\\\\bEMP-\\\\d{4,8}\\\\b", "(a+", 1);
        match compile_policy_v2(&json) {
            Err(PolicyError::Semantic(msg)) => {
                assert!(
                    msg.contains("EMPLOYEE_ID"),
                    "message should name the pattern id"
                );
                assert!(
                    !msg.contains("(a+"),
                    "message must not leak the raw pattern"
                );
            }
            Ok(_) => panic!("expected an error, got Ok"),
            Err(e) => panic!("expected a semantic error, got {e:?}"),
        }
    }

    #[test]
    fn custom_pattern_case_insensitive_matches_lowercase_value() {
        let policy = compile_policy_v2(FULL_EXAMPLE).expect("valid policy compiles");
        let rule = policy
            .rules()
            .iter()
            .find(|r| r.category == "EMPLOYEE_ID")
            .expect("custom rule present");
        assert!(!rule.regex.is_match("emp-1234"));

        let json =
            FULL_EXAMPLE.replacen("\"caseInsensitive\": false", "\"caseInsensitive\": true", 1);
        let policy = compile_policy_v2(&json).expect("valid policy compiles");
        let rule = policy
            .rules()
            .iter()
            .find(|r| r.category == "EMPLOYEE_ID")
            .expect("custom rule present");
        assert!(rule.regex.is_match("emp-1234"));
    }

    #[test]
    fn sensitive_field_disabled_on_both_flags_reports_both_false() {
        let json = FULL_EXAMPLE.replacen(
            "\"SENSITIVE_FIELD\": { \"tokenize\": true,  \"log\": false }",
            "\"SENSITIVE_FIELD\": { \"tokenize\": false, \"log\": false }",
            1,
        );
        let policy = compile_policy_v2(&json).expect("valid policy compiles");
        assert_eq!(
            policy.sensitive_field_flags(),
            CategoryFlags {
                tokenize: false,
                log: false
            }
        );
    }

    #[test]
    fn empty_custom_patterns_and_sensitive_keys_are_valid() {
        let json = FULL_EXAMPLE
            .replacen(
                "\"customPatterns\": [\n            { \"id\": \"EMPLOYEE_ID\", \"displayName\": \"Employee ID\", \"pattern\": \"\\\\bEMP-\\\\d{4,8}\\\\b\",\n              \"caseInsensitive\": false, \"tokenize\": true, \"log\": false }\n        ],",
                "\"customPatterns\": [],",
                1,
            )
            .replacen(
                "\"sensitiveKeys\": [\"password\", \"token\", \"salary\"]",
                "\"sensitiveKeys\": []",
                1,
            );
        let policy = compile_policy_v2(&json).expect("valid policy compiles");
        assert_eq!(policy.rules().len(), 7);
        assert!(policy.sensitive_keys().is_empty());
    }

    #[test]
    fn tokenize_string_value_is_rejected_without_leaking_secret() {
        let json = FULL_EXAMPLE.replacen(
            "\"tokenize\": true",
            "\"tokenize\": \"MY-SECRET-VALUE-XYZ\"",
            1,
        );
        match compile_policy_v2(&json) {
            Err(PolicyError::Parse(msg)) => {
                assert!(msg.contains("line"), "message should contain 'line'");
                assert!(
                    !msg.contains("MY-SECRET-VALUE-XYZ"),
                    "message must not leak the secret value"
                );
            }
            Ok(_) => panic!("expected an error, got Ok"),
            Err(e) => panic!("expected a parse error, got {e:?}"),
        }
    }

    #[test]
    fn default_policy_json_compiles_and_covers_every_category() {
        let json = default_policy_json();
        let policy = compile_policy_v2(&json).expect("default policy.json v2 must compile");
        assert_eq!(policy.rules().len(), BUILTIN_CATEGORIES.len() - 1);
        assert!(policy.sensitive_field_flags().tokenize);
        assert_eq!(policy.sensitive_keys(), patterns::default_sensitive_keys());
    }

    #[test]
    fn default_policy_json_is_deterministic() {
        assert_eq!(default_policy_json(), default_policy_json());
    }

    #[test]
    fn empty_custom_pattern_id_is_rejected() {
        let json = FULL_EXAMPLE.replacen("\"id\": \"EMPLOYEE_ID\"", "\"id\": \"\"", 1);
        match compile_policy_v2(&json) {
            Err(PolicyError::Semantic(msg)) => assert!(msg.contains("empty")),
            Ok(_) => panic!("expected an error, got Ok"),
            Err(e) => panic!("expected a semantic error, got {e:?}"),
        }
    }
}
