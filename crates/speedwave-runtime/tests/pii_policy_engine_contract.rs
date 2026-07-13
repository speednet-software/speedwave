//! Render↔engine contract: every host-rendered policy.json v2 must be a document
//! `speedwave_pii_engine::compile_policy_v2` actually accepts. Closes the class of bug where
//! the host writes a shape the container rejects at startup (v1 regression, caught only by a
//! whole-branch review).

#![expect(
    clippy::expect_used,
    reason = "test assertions on setup/serialization calls that must not silently fail"
)]

use speedwave_pii_engine::compile_policy_v2;
use speedwave_runtime::config::PiiPolicyUserConfig;
use speedwave_runtime::pii_policy::{builtin_templates, resolve_pii_policy};

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

        let compiled = compile_policy_v2(&json).unwrap_or_else(|e| {
            panic!(
                "template \"{}\" rendered a policy.json the engine rejects: {e}",
                template.id
            )
        });

        // The 7 value-pattern built-ins appear iff their tokenize/log pair has a flag on;
        // SENSITIVE_FIELD has no value-pattern rule of its own.
        let value_categories = [
            template.categories.email,
            template.categories.phone_pl,
            template.categories.pesel,
            template.categories.nip,
            template.categories.iban,
            template.categories.card,
            template.categories.api_key,
        ];
        let expected_builtin_rules = value_categories
            .iter()
            .filter(|c| c.tokenize || c.log)
            .count();
        let expected_rules = expected_builtin_rules + template.custom_patterns.len();
        assert_eq!(
            compiled.rules().len(),
            expected_rules,
            "template \"{}\" rule count mismatch",
            template.id
        );

        let expected_sensitive = template.categories.sensitive_field;
        assert_eq!(
            compiled.sensitive_field_flags().tokenize,
            expected_sensitive.tokenize,
            "template \"{}\" SENSITIVE_FIELD.tokenize mismatch",
            template.id
        );
        assert_eq!(
            compiled.sensitive_field_flags().log,
            expected_sensitive.log,
            "template \"{}\" SENSITIVE_FIELD.log mismatch",
            template.id
        );
    }
}

#[test]
fn custom_selection_with_extra_pattern_still_compiles() {
    use speedwave_runtime::config::PiiPolicyDefinition;
    use speedwave_runtime::pii_policy::CustomPiiPattern;

    let user = PiiPolicyUserConfig {
        policies: vec!["gdpr-art32".to_string(), "custom".to_string()],
        custom_policies: vec![PiiPolicyDefinition {
            id: "custom".to_string(),
            name: "Custom".to_string(),
            categories: speedwave_runtime::pii_policy::PiiCategoryFlags::ALL_ON.into(),
            custom_patterns: vec![CustomPiiPattern {
                id: "EMPLOYEE_ID".to_string(),
                display_name: "Employee ID".to_string(),
                pattern: r"\bEMP-\d{4,8}\b".to_string(),
                case_insensitive: false,
                tokenize: true,
                log: false,
            }],
            sensitive_keys: Default::default(),
        }],
    };
    let resolved =
        resolve_pii_policy(Some(&user), None).expect("gdpr-art32 + custom always resolves");
    let json = serde_json::to_string(&resolved).expect("resolved policy serializes");
    let compiled = compile_policy_v2(&json).expect("engine accepts a custom selection");
    assert!(compiled.rules().iter().any(|r| r.category == "EMPLOYEE_ID"));
}

#[test]
fn a_hand_corrupted_policy_json_is_rejected_by_the_engine() {
    let resolved = resolve_pii_policy(None, None).expect("empty policy always resolves");
    let mut value = serde_json::to_value(&resolved).expect("resolved policy serializes");
    value["bogusTopLevelField"] = serde_json::json!(true);
    let json = serde_json::to_string(&value).expect("value serializes");
    assert!(
        compile_policy_v2(&json).is_err(),
        "engine must reject an unknown top-level field"
    );
}
