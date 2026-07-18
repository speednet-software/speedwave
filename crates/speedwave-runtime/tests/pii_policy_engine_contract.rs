//! Render↔engine contract: every host-rendered policy.json v3 must be a document
//! `speedwave_pii_engine::compile_policy_v3` actually accepts. Closes the class of bug where
//! the host writes a shape the container rejects at startup (v1 regression, caught only by a
//! whole-branch review). Also covers the v3 additions (open rule-id `categories`, additive
//! `rules`, and `keywords`) end to end: resolver output must round-trip through the real engine.

#![expect(
    clippy::expect_used,
    reason = "test assertions on setup/serialization calls that must not silently fail"
)]

use speedwave_pii_engine::compile_policy_v3;
use speedwave_runtime::config::{PiiPolicyDefinition, PiiPolicyUserConfig};
use speedwave_runtime::pii_policy::{builtin_templates, resolve_pii_policy, KeywordV3, OwnRuleV3};
use std::collections::HashMap;

#[test]
fn every_builtin_template_resolves_to_a_policy_the_engine_accepts() {
    let templates = builtin_templates().expect("builtin templates load");
    assert_eq!(
        templates.len(),
        3,
        "sanity: all 3 shipped templates present"
    );

    for template in templates {
        let user = PiiPolicyUserConfig {
            policies: vec![template.id.clone()],
            ..Default::default()
        };
        let resolved =
            resolve_pii_policy(Some(&user), None).expect("builtin template id always resolves");
        let json = serde_json::to_string(&resolved).expect("resolved policy serializes");

        let compiled = compile_policy_v3(&json).unwrap_or_else(|e| {
            panic!(
                "template \"{}\" rendered a policy.json the engine rejects: {e}",
                template.id
            )
        });

        // Library rules appear iff their tokenize/log pair has a flag on; every
        // shipped template's `rules` list (additive, on top of the library) is empty today.
        let expected_builtin_rules = template
            .categories
            .values()
            .filter(|f| f.tokenize || f.log)
            .count();
        let expected_rules = expected_builtin_rules + template.rules.len();
        assert_eq!(
            compiled.rules().len(),
            expected_rules,
            "template \"{}\" rule count mismatch",
            template.id
        );
        assert!(
            compiled.keywords().is_empty(),
            "no shipped template carries keywords today"
        );
    }
}

#[test]
fn custom_selection_with_extra_rule_and_keyword_still_compiles() {
    let user = PiiPolicyUserConfig {
        policies: vec!["gdpr-art32".to_string(), "custom".to_string()],
        custom_policies: vec![PiiPolicyDefinition {
            id: "custom".to_string(),
            name: "Custom".to_string(),
            categories: HashMap::new(),
            rules: vec![OwnRuleV3 {
                id: "EMPLOYEE_ID".to_string(),
                display_name: "Employee ID".to_string(),
                patterns: vec![r"\bEMP-\d{4,8}\b".to_string()],
                validator: None,
                case_sensitive: true,
                tokenize: true,
                log: false,
            }],
            keywords: vec![KeywordV3 {
                r#match: "Coca-Cola".to_string(),
                alias: "Brandex".to_string(),
                case_sensitive: true,
            }],
        }],
    };
    let resolved =
        resolve_pii_policy(Some(&user), None).expect("gdpr-art32 + custom always resolves");
    let json = serde_json::to_string(&resolved).expect("resolved policy serializes");
    let compiled = compile_policy_v3(&json).expect("engine accepts a custom selection");
    assert!(compiled.rules().iter().any(|r| r.category == "EMPLOYEE_ID"));
    assert_eq!(compiled.keywords().len(), 1);
    assert_eq!(compiled.keywords()[0].match_text, "Coca-Cola");
    assert_eq!(compiled.keywords()[0].alias, "Brandex");
}

#[test]
fn a_hand_corrupted_policy_json_is_rejected_by_the_engine() {
    let resolved = resolve_pii_policy(None, None).expect("empty policy always resolves");
    let mut value = serde_json::to_value(&resolved).expect("resolved policy serializes");
    value["bogusTopLevelField"] = serde_json::json!(true);
    let json = serde_json::to_string(&value).expect("value serializes");
    assert!(
        compile_policy_v3(&json).is_err(),
        "engine must reject an unknown top-level field"
    );
}
