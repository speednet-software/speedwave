//! Golden snapshots of what compiling a policy.json v3 produces, and of the error
//! a doubly-invalid document reports. Pins the observable result of the policy
//! pipeline so moving code between crates cannot change it.

#![expect(
    clippy::expect_used,
    reason = "test code: panics on setup failure are acceptable"
)]

use speedwave_pii_engine::{
    compile_policy_v3, default_policy_json, parse_policy_v3, CompiledPolicy,
};

const POLICY_WITH_ACCESS: &str = r#"{
    "version": 3,
    "source": { "policies": ["strict"], "forced": ["strict"] },
    "rules": [
        {
            "id": "EMAIL",
            "displayName": "E-mail address",
            "patterns": ["[a-z]+@[a-z]+\\.com"],
            "caseSensitive": false,
            "tokenize": true,
            "log": false
        },
        {
            "id": "PESEL",
            "displayName": "PESEL",
            "patterns": ["\\d{11}", "P-\\d{11}"],
            "validator": "pesel",
            "caseSensitive": true,
            "tokenize": false,
            "log": true
        },
        {
            "id": "OFF",
            "displayName": "Switched off",
            "patterns": ["x"],
            "tokenize": false,
            "log": false
        }
    ],
    "keywords": [
        { "match": "Coca-Cola", "alias": "Brandex", "caseSensitive": false },
        { "match": "Sprite", "alias": "Mixer" }
    ],
    "access": { "default": "read_only", "services": { "slack": "full", "gitlab": "read_only" } }
}"#;

fn snapshot(policy: &CompiledPolicy) -> String {
    let mut lines = Vec::new();
    for rule in policy.rules() {
        let patterns: Vec<&str> = rule.patterns.iter().map(|p| p.as_str()).collect();
        lines.push(format!(
            "rule {} tokenize={} log={} validator={} patterns={:?}",
            rule.category,
            rule.flags.tokenize,
            rule.flags.log,
            rule.validator.is_some(),
            patterns
        ));
    }
    for keyword in policy.keywords() {
        lines.push(format!(
            "keyword {:?} -> {:?} case_sensitive={}",
            keyword.match_text, keyword.alias, keyword.case_sensitive
        ));
    }
    lines.join("\n")
}

#[test]
fn default_policy_compiles_to_the_golden_snapshot() {
    let policy = compile_policy_v3(&default_policy_json()).expect("default policy compiles");
    assert_eq!(
        snapshot(&policy),
        include_str!("golden/default_policy.txt").trim_end()
    );
}

#[test]
fn policy_with_access_compiles_to_the_golden_snapshot() {
    let policy = compile_policy_v3(POLICY_WITH_ACCESS).expect("policy with access compiles");
    assert_eq!(
        snapshot(&policy),
        include_str!("golden/policy_with_access.txt").trim_end()
    );
    assert_eq!(
        serde_json::to_string(
            &parse_policy_v3(POLICY_WITH_ACCESS)
                .expect("document parses")
                .access
        )
        .expect("access serializes"),
        r#"{"default":"read_only","services":{"gitlab":"read_only","slack":"full"}}"#
    );
}

#[test]
fn doubly_invalid_policy_reports_the_rule_pattern_error_before_a_later_format_error() {
    let json = r#"{
        "version": 3,
        "source": { "policies": [], "forced": [] },
        "rules": [
            { "id": "FIRST", "displayName": "First", "patterns": ["(a+"], "tokenize": true, "log": false },
            { "id": "bad id", "displayName": "Second", "patterns": ["x"], "tokenize": true, "log": false }
        ],
        "keywords": [ { "match": "secret", "alias": "1bad" } ]
    }"#;
    let err = compile_policy_v3(json).expect_err("invalid policy");
    assert_eq!(
        err.to_string(),
        "policy semantic error: rule 'FIRST' pattern 0 failed to compile"
    );
}

#[test]
fn doubly_invalid_policy_reports_the_rule_error_before_a_keyword_error() {
    let json = r#"{
        "version": 3,
        "source": { "policies": [], "forced": [] },
        "rules": [
            { "id": "FOO", "displayName": "Foo", "patterns": ["x"], "validator": "bogus", "tokenize": true, "log": false }
        ],
        "keywords": [ { "match": "secret", "alias": "1bad" } ]
    }"#;
    let err = compile_policy_v3(json).expect_err("invalid policy");
    assert_eq!(
        err.to_string(),
        "policy semantic error: unknown validator 'bogus' in rule 'FOO'"
    );
}
