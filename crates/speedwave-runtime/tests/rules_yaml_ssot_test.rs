//! `mcp-servers/policies/rules.yaml` is the single source of truth for the built-in
//! PII rule library: the engine's compiled-in default policy
//! (`speedwave_pii_engine::default_policy_json`, `crates/pii-engine/src/policy.rs`) and
//! the resolver's library (`speedwave_runtime::pii_policy::rule_library`) each embed
//! it independently via their own `include_str!` (ssot-registry.md). This test parses
//! the file a third, wholly independent way and cross-checks all three views never
//! drift apart.

#![expect(
    clippy::expect_used,
    reason = "test code: panics on setup failure are acceptable"
)]

use regex::Regex;
use std::collections::HashSet;

const RULES_YAML: &str = include_str!("../../../mcp-servers/policies/rules.yaml");
const EXPECTED_RULE_IDS: [&str; 7] = [
    "EMAIL", "PHONE_PL", "PESEL", "NIP", "IBAN", "CARD", "API_KEY",
];
const KNOWN_VALIDATORS: [&str; 4] = ["pesel", "nip", "iban", "luhn"];

#[derive(serde::Deserialize)]
struct RulesFile {
    version: u32,
    rules: Vec<RuleEntry>,
}

#[derive(serde::Deserialize)]
struct RuleEntry {
    id: String,
    #[serde(rename = "displayName")]
    display_name: String,
    patterns: Vec<String>,
    #[serde(default)]
    validator: Option<String>,
}

#[test]
fn rules_yaml_is_valid_v3_with_the_expected_seven_rules() {
    let file: RulesFile =
        serde_yaml_ng::from_str(RULES_YAML).expect("rules.yaml must be valid YAML");
    assert_eq!(file.version, 3, "rules.yaml version must be 3");
    assert_eq!(
        file.rules.len(),
        7,
        "rules.yaml must have exactly 7 builtin rules"
    );

    let rule_ids: HashSet<&str> = file.rules.iter().map(|r| r.id.as_str()).collect();
    for expected in EXPECTED_RULE_IDS {
        assert!(
            rule_ids.contains(expected),
            "{expected} rule must exist in rules.yaml"
        );
    }
    assert!(
        !rule_ids.contains("SENSITIVE_FIELD"),
        "SENSITIVE_FIELD is a removed v2 concept and must not exist in v3"
    );

    let id_re = Regex::new(r"^[A-Z][A-Z0-9_]{0,63}$").expect("id regex compiles");
    for rule in &file.rules {
        assert!(!rule.id.is_empty(), "rule id must not be empty");
        assert!(
            !rule.display_name.is_empty(),
            "rule {} must have a displayName",
            rule.id
        );
        assert!(
            !rule.patterns.is_empty(),
            "rule {} must have at least one pattern",
            rule.id
        );
        assert!(
            id_re.is_match(&rule.id),
            "rule id {} must match ^[A-Z][A-Z0-9_]{{0,63}}$",
            rule.id
        );
        if let Some(v) = &rule.validator {
            assert!(
                KNOWN_VALIDATORS.contains(&v.as_str()),
                "rule {} references unknown validator {v}",
                rule.id
            );
        }
    }
}

#[test]
fn rules_yaml_matches_the_resolvers_independently_embedded_copy() {
    // speedwave_runtime::pii_policy::rule_library() embeds the same file via its own
    // include_str! (crates/speedwave-runtime/src/pii_policy.rs) — this must be the
    // exact same content read a second time, never a stale duplicate.
    let direct: RulesFile = serde_yaml_ng::from_str(RULES_YAML).expect("rules.yaml parses");
    let resolver_library =
        speedwave_runtime::pii_policy::rule_library().expect("resolver's rule library loads");

    assert_eq!(direct.rules.len(), resolver_library.len());
    for direct_rule in &direct.rules {
        let resolver_rule = resolver_library
            .iter()
            .find(|r| r.id == direct_rule.id)
            .unwrap_or_else(|| panic!("resolver library is missing rule {}", direct_rule.id));
        assert_eq!(resolver_rule.display_name, direct_rule.display_name);
        assert_eq!(resolver_rule.patterns, direct_rule.patterns);
        assert_eq!(resolver_rule.validator, direct_rule.validator);
    }
}

#[test]
fn rules_yaml_matches_the_engines_independently_embedded_default_policy() {
    // speedwave_pii_engine::default_policy_json() embeds the same file via its own
    // include_str! (crates/pii-engine/src/policy.rs). pii_policy.rs already
    // cross-checks the *id set* against this function internally; this test goes
    // further and cross-checks patterns/displayName/tokenize too.
    let direct: RulesFile = serde_yaml_ng::from_str(RULES_YAML).expect("rules.yaml parses");
    let engine_default: serde_json::Value =
        serde_json::from_str(&speedwave_pii_engine::default_policy_json())
            .expect("default policy json parses");
    let engine_rules = engine_default["rules"]
        .as_array()
        .expect("rules is an array");

    assert_eq!(engine_rules.len(), direct.rules.len());
    for direct_rule in &direct.rules {
        let engine_rule = engine_rules
            .iter()
            .find(|r| r["id"] == direct_rule.id)
            .unwrap_or_else(|| panic!("engine default policy is missing rule {}", direct_rule.id));
        assert_eq!(
            engine_rule["patterns"],
            serde_json::json!(direct_rule.patterns)
        );
        assert_eq!(engine_rule["displayName"], direct_rule.display_name);
        assert_eq!(
            engine_rule["validator"],
            serde_json::json!(direct_rule.validator)
        );
        assert_eq!(
            engine_rule["tokenize"], true,
            "the engine's SSOT fallback must tokenize every library rule"
        );
    }
}
