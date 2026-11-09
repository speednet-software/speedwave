//! Compiler for the `policy.json` v3 document parsed by `speedwave-policy`: turns the PII
//! sections (rules and keywords) into regexes and validators ready to scan.

use regex::{Regex, RegexBuilder};
pub use speedwave_policy::{default_policy_json, is_valid_rule_id, PolicyError};
use speedwave_policy::{parse_policy_v3_unchecked, PolicyDocument, PolicyKeyword, PolicyRule};

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
#[derive(Debug, Clone)]
pub struct CompiledKeyword {
    /// The literal text to mask.
    pub match_text: String,
    /// The alias substituted for `match_text`.
    pub alias: String,
    /// Whether matching is case-sensitive.
    pub case_sensitive: bool,
}

/// The PII sections of a policy.json v3, compiled for scanning.
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

/// Parses, validates and compiles policy.json v3. Any structural or semantic problem is Err.
pub fn compile_policy_v3(json: &str) -> Result<CompiledPolicy, PolicyError> {
    compile(&parse_policy_v3_unchecked(json)?)
}

/// Compiles the rules and keywords of `document`, running the format checks of each rule
/// and keyword just before compiling it.
pub fn compile(document: &PolicyDocument) -> Result<CompiledPolicy, PolicyError> {
    let rules = compile_rules(&document.rules)?;
    let keywords = compile_keywords(&document.keywords)?;
    Ok(CompiledPolicy { rules, keywords })
}

fn compile_rules(rules: &[PolicyRule]) -> Result<Vec<CompiledRule>, PolicyError> {
    let mut compiled = Vec::with_capacity(rules.len());
    for rule in rules {
        rule.validate_head()?;

        let mut patterns = Vec::with_capacity(rule.patterns.len());
        for (i, pattern) in rule.patterns.iter().enumerate() {
            rule.validate_pattern(i)?;
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
                category: rule.id.clone(),
                patterns,
                validator,
                flags,
            });
        }
    }
    Ok(compiled)
}

fn compile_keywords(keywords: &[PolicyKeyword]) -> Result<Vec<CompiledKeyword>, PolicyError> {
    keywords
        .iter()
        .map(|kw| {
            kw.validate()?;
            Ok(CompiledKeyword {
                match_text: kw.match_text.clone(),
                alias: kw.alias.clone(),
                case_sensitive: kw.case_sensitive,
            })
        })
        .collect()
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
    fn v3_access_section_does_not_change_scanning_rules() {
        let with_access = VALID_V3_POLICY.replacen(
            "\"keywords\": [",
            "\"access\": {\"default\": \"read_only\"}, \"keywords\": [",
            1,
        );
        let a = compile_policy_v3(VALID_V3_POLICY).expect("policy");
        let b = compile_policy_v3(&with_access).expect("policy with access");
        assert_eq!(a.rules().len(), b.rules().len());
        assert_eq!(a.keywords().len(), b.keywords().len());
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
    fn default_policy_json_v3_compiles() {
        let json = default_policy_json();
        let policy = compile_policy_v3(&json).expect("default policy must compile");
        assert_eq!(policy.rules().len(), 7);
        assert!(policy.keywords().is_empty());
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
