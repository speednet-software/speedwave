//! Parser and compiler for the `policy.json` v3 inter-component contract
//! (host renders it, proxy and hub consume the compiled form). Rules are
//! data: every category comes from the document, none are hardcoded here.

use regex::{Regex, RegexBuilder};
use serde::Deserialize;
use std::sync::LazyLock;

/// A rule may declare at most this many patterns; a document may declare at
/// most this many rules, keywords, and total patterns across all rules.
const MAX_RULES: usize = 256;
const MAX_PATTERNS: usize = 1024;
const MAX_KEYWORDS: usize = 256;
const MAX_PATTERN_LEN: usize = 512;

static RULE_ID_RE: LazyLock<Result<Regex, regex::Error>> =
    LazyLock::new(|| Regex::new(r"^[A-Z][A-Z0-9_]{0,63}$"));
static ALIAS_RE: LazyLock<Result<Regex, regex::Error>> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z][A-Za-z0-9]*$"));

/// Per-rule protection flags from policy.json v3.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct CategoryFlags {
    /// Whether hits in this rule are tokenized (sealed) before leaving the engine.
    pub tokenize: bool,
    /// Whether hits in this rule are logged (observation mode).
    pub log: bool,
}

/// One ready-to-scan rule: category id, compiled patterns, optional checksum validator, flags.
#[derive(Debug)]
pub struct CompiledRule {
    /// Category id: a `rules[].id` from policy.json.
    pub category: String,
    /// Compiled value-match regexes for this rule; any pattern matching counts as a hit.
    pub patterns: Vec<Regex>,
    /// Checksum validator run on a match before it counts as a hit.
    pub validator: Option<fn(&str) -> bool>,
    /// Tokenize/log flags resolved from policy.json for this rule.
    pub flags: CategoryFlags,
}

/// One literal keyword substitution: an exact string and its stand-in alias.
#[derive(Debug)]
pub struct CompiledKeyword {
    /// The literal text to mask.
    pub match_text: String,
    /// The alias substituted for `match_text`.
    pub alias: String,
    /// Whether matching is case-sensitive.
    pub case_sensitive: bool,
}

/// A policy.json v3, parsed, validated and compiled for scanning.
#[derive(Debug)]
pub struct CompiledPolicy {
    rules: Vec<CompiledRule>,
    keywords: Vec<CompiledKeyword>,
}

impl CompiledPolicy {
    /// Value-pattern rules with at least one flag on, in file order.
    pub fn rules(&self) -> &[CompiledRule] {
        &self.rules
    }

    /// Literal keyword substitutions, in file order.
    pub fn keywords(&self) -> &[CompiledKeyword] {
        &self.keywords
    }
}

/// A policy.json v3 document failed to parse or violates the contract's semantics.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PolicyError {
    /// Malformed JSON or a v3 shape mismatch; the message carries only line/column, never content.
    Parse(String),
    /// A v3 semantic rule was violated; the message carries only field/category/pattern ids.
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
#[serde(deny_unknown_fields)]
struct PolicyFileV3 {
    version: u32,
    #[serde(rename = "source")]
    _source: SourceMeta,
    rules: Vec<RuleV3>,
    #[serde(default)]
    keywords: Vec<KeywordV3>,
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
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RuleV3 {
    id: String,
    #[serde(rename = "displayName")]
    _display_name: String,
    patterns: Vec<String>,
    #[serde(default)]
    validator: Option<String>,
    #[serde(default = "default_case_sensitive")]
    case_sensitive: bool,
    tokenize: bool,
    log: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct KeywordV3 {
    r#match: String,
    alias: String,
    #[serde(default = "default_case_sensitive")]
    case_sensitive: bool,
}

fn default_case_sensitive() -> bool {
    true
}

/// Parses + validates + compiles policy.json v3. Any structural or semantic problem is Err.
pub fn compile_policy_v3(json: &str) -> Result<CompiledPolicy, PolicyError> {
    let file: PolicyFileV3 = serde_json::from_str(json).map_err(|e| {
        PolicyError::Parse(format!(
            "malformed policy document at line {} column {}",
            e.line(),
            e.column()
        ))
    })?;

    if file.version != 3 {
        return Err(PolicyError::Semantic(format!(
            "unsupported policy version {}, engine supports version 3 only",
            file.version
        )));
    }

    if file.rules.len() > MAX_RULES {
        return Err(PolicyError::Semantic(format!(
            "too many rules: {} exceeds limit of {MAX_RULES}",
            file.rules.len()
        )));
    }

    let pattern_count: usize = file.rules.iter().map(|r| r.patterns.len()).sum();
    if pattern_count > MAX_PATTERNS {
        return Err(PolicyError::Semantic(format!(
            "too many patterns: {pattern_count} exceeds limit of {MAX_PATTERNS}"
        )));
    }

    if file.keywords.len() > MAX_KEYWORDS {
        return Err(PolicyError::Semantic(format!(
            "too many keywords: {} exceeds limit of {MAX_KEYWORDS}",
            file.keywords.len()
        )));
    }

    let rules = compile_rules(file.rules)?;
    let keywords = compile_keywords(file.keywords)?;

    Ok(CompiledPolicy { rules, keywords })
}

fn compile_rules(rules: Vec<RuleV3>) -> Result<Vec<CompiledRule>, PolicyError> {
    let mut compiled = Vec::with_capacity(rules.len());
    for rule in rules {
        if !rule_id_format_valid(&rule.id) {
            return Err(PolicyError::Semantic(format!(
                "invalid rule id format '{}'",
                rule.id
            )));
        }
        if rule.patterns.is_empty() {
            return Err(PolicyError::Semantic(format!(
                "rule '{}' must have at least one pattern",
                rule.id
            )));
        }

        let mut patterns = Vec::with_capacity(rule.patterns.len());
        for (i, pattern) in rule.patterns.iter().enumerate() {
            if pattern.len() > MAX_PATTERN_LEN {
                return Err(PolicyError::Semantic(format!(
                    "rule '{}' pattern {i} exceeds {MAX_PATTERN_LEN} chars",
                    rule.id
                )));
            }
            let regex = RegexBuilder::new(pattern)
                .case_insensitive(!rule.case_sensitive)
                .build()
                .map_err(|_| {
                    PolicyError::Semantic(format!(
                        "rule '{}' pattern {i} failed to compile",
                        rule.id
                    ))
                })?;
            patterns.push(regex);
        }

        let validator = match &rule.validator {
            Some(name) => Some(crate::patterns::validator_by_name(name).ok_or_else(|| {
                PolicyError::Semantic(format!("unknown validator '{name}' in rule '{}'", rule.id))
            })?),
            None => None,
        };

        let flags = CategoryFlags {
            tokenize: rule.tokenize,
            log: rule.log,
        };

        if flags.tokenize || flags.log {
            compiled.push(CompiledRule {
                category: rule.id,
                patterns,
                validator,
                flags,
            });
        }
    }
    Ok(compiled)
}

fn compile_keywords(keywords: Vec<KeywordV3>) -> Result<Vec<CompiledKeyword>, PolicyError> {
    let mut compiled = Vec::with_capacity(keywords.len());
    for kw in keywords {
        if kw.r#match.len() < 3 {
            return Err(PolicyError::Semantic(
                "keyword match must be at least 3 characters".to_string(),
            ));
        }
        if kw.alias.len() < 3 {
            return Err(PolicyError::Semantic(
                "keyword alias must be at least 3 characters".to_string(),
            ));
        }
        if kw.r#match == kw.alias {
            return Err(PolicyError::Semantic(
                "keyword match and alias must be different".to_string(),
            ));
        }
        if !alias_format_valid(&kw.alias) {
            return Err(PolicyError::Semantic(format!(
                "invalid alias format '{}'",
                kw.alias
            )));
        }
        compiled.push(CompiledKeyword {
            match_text: kw.r#match,
            alias: kw.alias,
            case_sensitive: kw.case_sensitive,
        });
    }
    Ok(compiled)
}

fn rule_id_format_valid(id: &str) -> bool {
    RULE_ID_RE.as_ref().is_ok_and(|re| re.is_match(id))
}

fn alias_format_valid(alias: &str) -> bool {
    alias.len() <= 128 && ALIAS_RE.as_ref().is_ok_and(|re| re.is_match(alias))
}

#[derive(Deserialize)]
struct RulesYamlFile {
    version: u32,
    rules: Vec<RulesYamlRule>,
}

#[derive(Deserialize)]
struct RulesYamlRule {
    id: String,
    #[serde(rename = "displayName")]
    display_name: String,
    patterns: Vec<String>,
    #[serde(default)]
    validator: Option<String>,
}

/// Serializes the compiled-in default policy.json v3 from the built-in rule
/// library (`mcp-servers/policies/rules.yaml`): every rule tokenize-on, no
/// keywords. SSOT fallback for every "no POLICY_FILE" caller (proxy, hub-wasm).
pub fn default_policy_json() -> String {
    let yaml = include_str!("../../../mcp-servers/policies/rules.yaml");
    // Fail-closed rather than panic: rules.yaml is a compile-time asset guarded by
    // rules_integration_test.rs, so a parse failure here is unreachable in practice.
    let file: RulesYamlFile = serde_yaml_ng::from_str(yaml).unwrap_or(RulesYamlFile {
        version: 3,
        rules: Vec::new(),
    });

    let rules: Vec<serde_json::Value> = file
        .rules
        .into_iter()
        .map(|r| {
            serde_json::json!({
                "id": r.id,
                "displayName": r.display_name,
                "patterns": r.patterns,
                "validator": r.validator,
                "caseSensitive": true,
                "tokenize": true,
                "log": false,
            })
        })
        .collect();

    serde_json::json!({
        "version": file.version,
        "source": { "policies": [], "forced": [] },
        "rules": rules,
        "keywords": [],
    })
    .to_string()
}

#[cfg(test)]
#[expect(
    clippy::expect_used,
    reason = "test code: panics on setup failure are acceptable"
)]
mod tests {
    use super::*;

    const VALID_V3_POLICY: &str = r#"{
        "version": 3,
        "source": { "policies": ["strict"], "forced": [] },
        "rules": [
            {
                "id": "EMAIL",
                "displayName": "E-mail address",
                "patterns": ["[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}"],
                "caseSensitive": true,
                "tokenize": true,
                "log": false
            },
            {
                "id": "PESEL",
                "displayName": "PESEL",
                "patterns": ["\\d{11}"],
                "validator": "pesel",
                "caseSensitive": true,
                "tokenize": true,
                "log": false
            }
        ],
        "keywords": [
            {
                "match": "Coca-Cola",
                "alias": "Brandex",
                "caseSensitive": false
            }
        ]
    }"#;

    #[test]
    fn v3_valid_policy_compiles() {
        let policy = compile_policy_v3(VALID_V3_POLICY).expect("valid policy");
        assert_eq!(policy.rules().len(), 2);
        assert_eq!(policy.keywords().len(), 1);
        assert_eq!(policy.keywords()[0].match_text, "Coca-Cola");
        assert_eq!(policy.keywords()[0].alias, "Brandex");
        assert!(!policy.keywords()[0].case_sensitive);
    }

    #[test]
    fn v3_version_2_is_rejected() {
        let json = VALID_V3_POLICY.replacen("\"version\": 3,", "\"version\": 2,", 1);
        match compile_policy_v3(&json) {
            Err(PolicyError::Semantic(msg)) => assert!(msg.contains("version")),
            other => panic!("expected a semantic version error, got {other:?}"),
        }
    }

    #[test]
    fn v3_malformed_json_is_a_parse_error() {
        match compile_policy_v3("{ not json") {
            Err(PolicyError::Parse(msg)) => assert!(msg.contains("line")),
            other => panic!("expected a parse error, got {other:?}"),
        }
    }

    #[test]
    fn v3_unknown_top_level_field_is_rejected() {
        let json = VALID_V3_POLICY.replacen(
            "\"version\": 3,",
            "\"version\": 3, \"bogusTopLevel\": true,",
            1,
        );
        match compile_policy_v3(&json) {
            Err(PolicyError::Parse(msg)) => assert!(msg.contains("line")),
            other => panic!("expected a parse error, got {other:?}"),
        }
    }

    #[test]
    fn v3_enforces_rule_limit() {
        let mut rules = Vec::new();
        for i in 0..257 {
            rules.push(format!(
                r#"{{"id": "RULE_{i}", "displayName": "Rule {i}", "patterns": ["pattern"], "caseSensitive": true, "tokenize": true, "log": false}}"#
            ));
        }
        let json = format!(
            r#"{{"version": 3, "source": {{"policies": [], "forced": []}}, "rules": [{}], "keywords": []}}"#,
            rules.join(",")
        );
        match compile_policy_v3(&json) {
            Err(PolicyError::Semantic(msg)) => assert!(msg.contains("too many rules")),
            other => panic!("expected semantic error for rule limit, got {other:?}"),
        }
    }

    #[test]
    fn v3_enforces_pattern_count_limit() {
        let mut patterns = Vec::new();
        for i in 0..1025 {
            patterns.push(format!("\"p{i}\""));
        }
        let json = format!(
            r#"{{"version": 3, "source": {{"policies": [], "forced": []}}, "rules": [
                {{"id": "BIG", "displayName": "Big", "patterns": [{}], "caseSensitive": true, "tokenize": true, "log": false}}
            ], "keywords": []}}"#,
            patterns.join(",")
        );
        match compile_policy_v3(&json) {
            Err(PolicyError::Semantic(msg)) => assert!(msg.contains("too many patterns")),
            other => panic!("expected semantic error for pattern limit, got {other:?}"),
        }
    }

    #[test]
    fn v3_enforces_keyword_limit() {
        let mut keywords = Vec::new();
        for i in 0..257 {
            keywords.push(format!(
                r#"{{"match": "needle{i}", "alias": "alias{i}", "caseSensitive": true}}"#
            ));
        }
        let json = format!(
            r#"{{"version": 3, "source": {{"policies": [], "forced": []}}, "rules": [], "keywords": [{}]}}"#,
            keywords.join(",")
        );
        match compile_policy_v3(&json) {
            Err(PolicyError::Semantic(msg)) => assert!(msg.contains("too many keywords")),
            other => panic!("expected semantic error for keyword limit, got {other:?}"),
        }
    }

    #[test]
    fn v3_enforces_pattern_length_limit() {
        let long_pattern = "a".repeat(513);
        let json = format!(
            r#"{{"version": 3, "source": {{"policies": [], "forced": []}}, "rules": [
                {{"id": "LONG", "displayName": "Long", "patterns": ["{long_pattern}"], "caseSensitive": true, "tokenize": true, "log": false}}
            ], "keywords": []}}"#
        );
        match compile_policy_v3(&json) {
            Err(PolicyError::Semantic(msg)) => assert!(msg.contains("exceeds")),
            other => panic!("expected semantic error for pattern length, got {other:?}"),
        }
    }

    #[test]
    fn v3_rejects_invalid_rule_id() {
        let json = r#"{"version": 3, "source": {"policies": [], "forced": []}, "rules": [{"id": "123", "displayName": "Bad", "patterns": ["x"], "caseSensitive": true, "tokenize": true, "log": false}], "keywords": []}"#;
        match compile_policy_v3(json) {
            Err(PolicyError::Semantic(msg)) => assert!(msg.contains("invalid rule id")),
            other => panic!("expected a semantic error, got {other:?}"),
        }
    }

    #[test]
    fn v3_rejects_lowercase_rule_id() {
        let json = r#"{"version": 3, "source": {"policies": [], "forced": []}, "rules": [{"id": "email", "displayName": "Bad", "patterns": ["x"], "caseSensitive": true, "tokenize": true, "log": false}], "keywords": []}"#;
        match compile_policy_v3(json) {
            Err(PolicyError::Semantic(msg)) => assert!(msg.contains("invalid rule id")),
            other => panic!("expected a semantic error, got {other:?}"),
        }
    }

    #[test]
    fn v3_rejects_unknown_validator() {
        let json = r#"{"version": 3, "source": {"policies": [], "forced": []}, "rules": [{"id": "FOO", "displayName": "Foo", "patterns": ["x"], "validator": "bogus", "caseSensitive": true, "tokenize": true, "log": false}], "keywords": []}"#;
        match compile_policy_v3(json) {
            Err(PolicyError::Semantic(msg)) => {
                assert!(msg.contains("unknown validator"));
                assert!(msg.contains("bogus"));
            }
            other => panic!("expected a semantic error, got {other:?}"),
        }
    }

    #[test]
    fn v3_rejects_empty_patterns() {
        let json = r#"{"version": 3, "source": {"policies": [], "forced": []}, "rules": [{"id": "FOO", "displayName": "Foo", "patterns": [], "caseSensitive": true, "tokenize": true, "log": false}], "keywords": []}"#;
        match compile_policy_v3(json) {
            Err(PolicyError::Semantic(msg)) => assert!(msg.contains("at least one pattern")),
            other => panic!("expected a semantic error, got {other:?}"),
        }
    }

    #[test]
    fn v3_invalid_regex_pattern_is_rejected_without_leaking_it() {
        let json = r#"{"version": 3, "source": {"policies": [], "forced": []}, "rules": [{"id": "FOO", "displayName": "Foo", "patterns": ["(a+"], "caseSensitive": true, "tokenize": true, "log": false}], "keywords": []}"#;
        match compile_policy_v3(json) {
            Err(PolicyError::Semantic(msg)) => {
                assert!(msg.contains("FOO"));
                assert!(!msg.contains("(a+"));
            }
            other => panic!("expected a semantic error, got {other:?}"),
        }
    }

    #[test]
    fn v3_rule_off_on_both_flags_is_excluded_from_rules() {
        let json = VALID_V3_POLICY.replacen(
            "\"caseSensitive\": true,\n                \"tokenize\": true,\n                \"log\": false\n            },\n            {\n                \"id\": \"PESEL\"",
            "\"caseSensitive\": true,\n                \"tokenize\": false,\n                \"log\": false\n            },\n            {\n                \"id\": \"PESEL\"",
            1,
        );
        let policy = compile_policy_v3(&json).expect("valid policy compiles");
        assert!(!policy.rules().iter().any(|r| r.category == "EMAIL"));
        assert_eq!(policy.rules().len(), 1);
    }

    #[test]
    fn v3_case_insensitive_rule_matches_mixed_case() {
        let json = VALID_V3_POLICY.replacen(
            "\"patterns\": [\"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\\\.[a-zA-Z]{2,}\"],\n                \"caseSensitive\": true,",
            "\"patterns\": [\"EMAIL-[a-z]+\"],\n                \"caseSensitive\": false,",
            1,
        );
        let policy = compile_policy_v3(&json).expect("valid policy compiles");
        let rule = policy
            .rules()
            .iter()
            .find(|r| r.category == "EMAIL")
            .expect("EMAIL rule present");
        assert!(rule.patterns[0].is_match("email-marker"));
    }

    #[test]
    fn v3_keyword_match_alias_and_min_length_rules() {
        let too_short = r#"{"version": 3, "source": {"policies": [], "forced": []}, "rules": [], "keywords": [{"match": "ab", "alias": "xyz", "caseSensitive": true}]}"#;
        match compile_policy_v3(too_short) {
            Err(PolicyError::Semantic(msg)) => assert!(msg.contains("match")),
            other => panic!("expected a semantic error, got {other:?}"),
        }

        let same = r#"{"version": 3, "source": {"policies": [], "forced": []}, "rules": [], "keywords": [{"match": "secret", "alias": "secret", "caseSensitive": true}]}"#;
        match compile_policy_v3(same) {
            Err(PolicyError::Semantic(msg)) => assert!(msg.contains("must be different")),
            other => panic!("expected a semantic error, got {other:?}"),
        }

        let bad_alias = r#"{"version": 3, "source": {"policies": [], "forced": []}, "rules": [], "keywords": [{"match": "secretco", "alias": "123bad", "caseSensitive": true}]}"#;
        match compile_policy_v3(bad_alias) {
            Err(PolicyError::Semantic(msg)) => assert!(msg.contains("invalid alias format")),
            other => panic!("expected a semantic error, got {other:?}"),
        }
    }

    #[test]
    fn default_policy_json_v3_compiles() {
        let json = default_policy_json();
        let policy = compile_policy_v3(&json).expect("default policy must compile");
        assert_eq!(policy.rules().len(), 7);
        assert!(policy.keywords().is_empty());
    }

    #[test]
    fn default_policy_json_is_deterministic() {
        assert_eq!(default_policy_json(), default_policy_json());
    }

    #[test]
    fn default_policy_json_includes_validators() {
        let json = default_policy_json();
        let policy = compile_policy_v3(&json).expect("default policy must compile");
        let pesel = policy
            .rules()
            .iter()
            .find(|r| r.category == "PESEL")
            .expect("PESEL present");
        assert!(pesel.validator.is_some());
        let email = policy
            .rules()
            .iter()
            .find(|r| r.category == "EMAIL")
            .expect("EMAIL present");
        assert!(email.validator.is_none());
    }
}
