//! The `policy.json` v3 document (host renders it, proxy and hub consume it):
//! parsing and validation. The PII sections are compiled by `speedwave-pii-engine`,
//! the `access` section is owned by `speedwave-access-policy`.

use regex::Regex;
use serde::Deserialize;
use speedwave_access_policy::AccessPolicy;
use std::sync::LazyLock;

const MAX_RULES: usize = 256;
const MAX_PATTERNS: usize = 1024;
const MAX_KEYWORDS: usize = 256;
const MAX_PATTERN_LEN: usize = 512;

const KEYWORD_MIN_CHARS: usize = 3;
const KEYWORD_MAX_CHARS: usize = 128;

static RULE_ID_RE: LazyLock<Result<Regex, regex::Error>> =
    LazyLock::new(|| Regex::new(r"^[A-Z][A-Z0-9_]{0,63}$"));
static ALIAS_RE: LazyLock<Result<Regex, regex::Error>> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z][A-Za-z0-9]*$"));

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

/// A parsed policy.json v3.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PolicyDocument {
    /// Contract version; only 3 is accepted.
    pub version: u32,
    /// Provenance metadata.
    pub source: PolicySource,
    /// Value-pattern rules, in file order.
    pub rules: Vec<PolicyRule>,
    /// Literal keyword substitutions, in file order.
    #[serde(default)]
    pub keywords: Vec<PolicyKeyword>,
    /// Access modes; absent means every service is `full`.
    #[serde(default)]
    pub access: AccessPolicy,
}

/// Policy provenance metadata: which policies the document merges and which are forced by MDM.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PolicySource {
    /// Ids of the merged policies.
    pub policies: Vec<String>,
    /// Ids of the policies forced on by MDM.
    pub forced: Vec<String>,
}

/// One `rules[]` entry.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PolicyRule {
    /// Category id, `^[A-Z][A-Z0-9_]{0,63}$`.
    pub id: String,
    /// Name shown to people.
    pub display_name: String,
    /// Regex sources; any match counts as a hit.
    pub patterns: Vec<String>,
    /// Name of the checksum validator run on a match.
    #[serde(default)]
    pub validator: Option<String>,
    /// Whether the patterns match case-sensitively.
    #[serde(default = "default_case_sensitive")]
    pub case_sensitive: bool,
    /// Whether hits are sealed into tokens.
    pub tokenize: bool,
    /// Whether hits are counted without touching the text.
    pub log: bool,
}

/// One `keywords[]` entry.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PolicyKeyword {
    /// The literal text to mask.
    #[serde(rename = "match")]
    pub match_text: String,
    /// The stand-in substituted for `match_text`.
    pub alias: String,
    /// Whether matching is case-sensitive.
    #[serde(default = "default_case_sensitive")]
    pub case_sensitive: bool,
}

fn default_case_sensitive() -> bool {
    true
}

impl PolicyRule {
    /// Checks the id format and that the rule has a pattern.
    pub fn validate_head(&self) -> Result<(), PolicyError> {
        if !is_valid_rule_id(&self.id) {
            return Err(PolicyError::Semantic(format!(
                "invalid rule id format '{}'",
                self.id
            )));
        }
        if self.patterns.is_empty() {
            return Err(PolicyError::Semantic(format!(
                "rule '{}' must have at least one pattern",
                self.id
            )));
        }
        Ok(())
    }

    /// Checks the length of pattern `index`.
    pub fn validate_pattern(&self, index: usize) -> Result<(), PolicyError> {
        match self.patterns.get(index) {
            Some(pattern) if pattern.len() > MAX_PATTERN_LEN => {
                Err(PolicyError::Semantic(format!(
                    "rule '{}' pattern {index} exceeds {MAX_PATTERN_LEN} chars",
                    self.id
                )))
            }
            _ => Ok(()),
        }
    }

    fn validate(&self) -> Result<(), PolicyError> {
        self.validate_head()?;
        (0..self.patterns.len()).try_for_each(|i| self.validate_pattern(i))
    }
}

impl PolicyKeyword {
    /// Checks the lengths of match and alias, that they differ, and the alias format.
    pub fn validate(&self) -> Result<(), PolicyError> {
        if !(KEYWORD_MIN_CHARS..=KEYWORD_MAX_CHARS).contains(&self.match_text.chars().count()) {
            return Err(PolicyError::Semantic(format!(
                "keyword match must be {KEYWORD_MIN_CHARS}-{KEYWORD_MAX_CHARS} characters"
            )));
        }
        if !(KEYWORD_MIN_CHARS..=KEYWORD_MAX_CHARS).contains(&self.alias.chars().count()) {
            return Err(PolicyError::Semantic(format!(
                "keyword alias must be {KEYWORD_MIN_CHARS}-{KEYWORD_MAX_CHARS} characters"
            )));
        }
        if self.match_text == self.alias {
            return Err(PolicyError::Semantic(
                "keyword match and alias must be different".to_string(),
            ));
        }
        if !alias_format_valid(&self.alias) {
            return Err(PolicyError::Semantic(format!(
                "invalid alias format '{}'",
                self.alias
            )));
        }
        Ok(())
    }
}

impl PolicyDocument {
    /// Checks every rule and keyword, in file order, rules first.
    pub fn validate(&self) -> Result<(), PolicyError> {
        self.rules.iter().try_for_each(PolicyRule::validate)?;
        self.keywords.iter().try_for_each(PolicyKeyword::validate)
    }
}

/// Parses policy.json v3 and checks the version, the size limits, the `access` section and
/// the format of every rule and keyword.
pub fn parse_policy_v3(json: &str) -> Result<PolicyDocument, PolicyError> {
    let document = parse_policy_v3_unchecked(json)?;
    document.validate()?;
    Ok(document)
}

/// Like `parse_policy_v3` without the rule and keyword format checks, for a consumer that
/// runs them interleaved with its own per-rule work (`PolicyRule::validate_head`,
/// `PolicyRule::validate_pattern`, `PolicyKeyword::validate`) to keep its error order.
pub fn parse_policy_v3_unchecked(json: &str) -> Result<PolicyDocument, PolicyError> {
    let file: PolicyDocument = serde_json::from_str(json).map_err(|e| {
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

    file.access.validate().map_err(PolicyError::Semantic)?;

    Ok(file)
}

/// Whether `id` has the shape of a policy rule id (and so of a token category).
pub fn is_valid_rule_id(id: &str) -> bool {
    RULE_ID_RE.as_ref().is_ok_and(|re| re.is_match(id))
}

fn alias_format_valid(alias: &str) -> bool {
    alias.chars().count() <= KEYWORD_MAX_CHARS
        && ALIAS_RE.as_ref().is_ok_and(|re| re.is_match(alias))
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
    fn v3_without_access_section_is_unrestricted() {
        let policy = parse_policy_v3(VALID_V3_POLICY).expect("valid policy");
        assert!(policy.access.is_unrestricted());
    }

    #[test]
    fn v3_access_section_is_accepted_and_exposed() {
        let json = VALID_V3_POLICY.replacen(
            "\"keywords\": [",
            "\"access\": {\"default\": \"read_only\", \"services\": {\"slack\": \"full\"}}, \"keywords\": [",
            1,
        );
        let policy = parse_policy_v3(&json).expect("policy with access");
        assert_eq!(
            policy.access.default,
            speedwave_access_policy::AccessMode::ReadOnly
        );
        assert_eq!(
            policy.access.mode_of("slack"),
            speedwave_access_policy::AccessMode::Full
        );
        assert_eq!(policy.rules.len(), 2);
    }

    #[test]
    fn v3_access_section_with_unknown_mode_is_a_parse_error() {
        let json = VALID_V3_POLICY.replacen(
            "\"keywords\": [",
            "\"access\": {\"default\": \"confirm\"}, \"keywords\": [",
            1,
        );
        assert!(matches!(parse_policy_v3(&json), Err(PolicyError::Parse(_))));
    }

    #[test]
    fn v3_access_section_with_invalid_service_id_is_a_semantic_error() {
        let json = VALID_V3_POLICY.replacen(
            "\"keywords\": [",
            "\"access\": {\"services\": {\"Bad Id\": \"read_only\"}}, \"keywords\": [",
            1,
        );
        match parse_policy_v3(&json) {
            Err(PolicyError::Semantic(msg)) => assert!(msg.contains("access")),
            other => panic!("expected a semantic access error, got {other:?}"),
        }
    }

    #[test]
    fn v3_version_2_is_rejected() {
        let json = VALID_V3_POLICY.replacen("\"version\": 3,", "\"version\": 2,", 1);
        match parse_policy_v3(&json) {
            Err(PolicyError::Semantic(msg)) => assert!(msg.contains("version")),
            other => panic!("expected a semantic version error, got {other:?}"),
        }
    }

    #[test]
    fn v3_malformed_json_is_a_parse_error() {
        match parse_policy_v3("{ not json") {
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
        match parse_policy_v3(&json) {
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
        match parse_policy_v3(&json) {
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
        match parse_policy_v3(&json) {
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
        match parse_policy_v3(&json) {
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
        match parse_policy_v3(&json) {
            Err(PolicyError::Semantic(msg)) => assert!(msg.contains("exceeds")),
            other => panic!("expected semantic error for pattern length, got {other:?}"),
        }
    }

    #[test]
    fn v3_rejects_invalid_rule_id() {
        let json = r#"{"version": 3, "source": {"policies": [], "forced": []}, "rules": [{"id": "123", "displayName": "Bad", "patterns": ["x"], "caseSensitive": true, "tokenize": true, "log": false}], "keywords": []}"#;
        match parse_policy_v3(json) {
            Err(PolicyError::Semantic(msg)) => assert!(msg.contains("invalid rule id")),
            other => panic!("expected a semantic error, got {other:?}"),
        }
    }

    #[test]
    fn v3_rejects_lowercase_rule_id() {
        let json = r#"{"version": 3, "source": {"policies": [], "forced": []}, "rules": [{"id": "email", "displayName": "Bad", "patterns": ["x"], "caseSensitive": true, "tokenize": true, "log": false}], "keywords": []}"#;
        match parse_policy_v3(json) {
            Err(PolicyError::Semantic(msg)) => assert!(msg.contains("invalid rule id")),
            other => panic!("expected a semantic error, got {other:?}"),
        }
    }

    #[test]
    fn v3_rejects_empty_patterns() {
        let json = r#"{"version": 3, "source": {"policies": [], "forced": []}, "rules": [{"id": "FOO", "displayName": "Foo", "patterns": [], "caseSensitive": true, "tokenize": true, "log": false}], "keywords": []}"#;
        match parse_policy_v3(json) {
            Err(PolicyError::Semantic(msg)) => assert!(msg.contains("at least one pattern")),
            other => panic!("expected a semantic error, got {other:?}"),
        }
    }

    #[test]
    fn v3_keyword_match_alias_and_min_length_rules() {
        let too_short = r#"{"version": 3, "source": {"policies": [], "forced": []}, "rules": [], "keywords": [{"match": "ab", "alias": "xyz", "caseSensitive": true}]}"#;
        match parse_policy_v3(too_short) {
            Err(PolicyError::Semantic(msg)) => assert!(msg.contains("match")),
            other => panic!("expected a semantic error, got {other:?}"),
        }

        let same = r#"{"version": 3, "source": {"policies": [], "forced": []}, "rules": [], "keywords": [{"match": "secret", "alias": "secret", "caseSensitive": true}]}"#;
        match parse_policy_v3(same) {
            Err(PolicyError::Semantic(msg)) => assert!(msg.contains("must be different")),
            other => panic!("expected a semantic error, got {other:?}"),
        }

        let bad_alias = r#"{"version": 3, "source": {"policies": [], "forced": []}, "rules": [], "keywords": [{"match": "secretco", "alias": "123bad", "caseSensitive": true}]}"#;
        match parse_policy_v3(bad_alias) {
            Err(PolicyError::Semantic(msg)) => assert!(msg.contains("invalid alias format")),
            other => panic!("expected a semantic error, got {other:?}"),
        }
    }

    #[test]
    fn default_policy_json_is_deterministic() {
        assert_eq!(default_policy_json(), default_policy_json());
    }

    #[test]
    fn unchecked_parse_leaves_the_rule_format_checks_to_the_caller() {
        let json = VALID_V3_POLICY.replacen("\"EMAIL\"", "\"bad id\"", 1);
        assert!(parse_policy_v3_unchecked(&json).is_ok());
        match parse_policy_v3(&json) {
            Err(PolicyError::Semantic(msg)) => assert!(msg.contains("invalid rule id")),
            other => panic!("expected a semantic error, got {other:?}"),
        }
    }
}
