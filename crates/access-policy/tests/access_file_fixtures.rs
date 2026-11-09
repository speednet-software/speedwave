//! Fixture cases for the access file format.

use serde_json::{json, Value};
use speedwave_access_policy::{parse_access_file, AccessPolicy};

const CASES: &str = include_str!("fixtures/access-file-cases.json");

fn text_of(case: &Value) -> String {
    if let Some(text) = case["text"].as_str() {
        return text.to_string();
    }
    let generate = &case["generate"];
    if let Some(count) = generate["services"].as_u64() {
        let services: serde_json::Map<String, Value> = (0..count)
            .map(|i| (format!("svc{i}"), json!("read_only")))
            .collect();
        return json!({ "version": 1, "services": services }).to_string();
    }
    let padding = generate["padding"].as_u64().unwrap_or(0) as usize;
    format!(r#"{{"version":1}}{}"#, " ".repeat(padding))
}

fn expected_of(case: &Value) -> Option<AccessPolicy> {
    serde_json::from_value(case["expected"].clone()).ok()
}

#[test]
fn every_fixture_case_parses_or_fails_as_listed() {
    let cases: Vec<Value> = serde_json::from_str(CASES).unwrap_or_default();
    assert!(!cases.is_empty());
    for case in &cases {
        let name = &case["name"];
        let result = parse_access_file(&text_of(case));
        if case["error"].as_bool() == Some(true) {
            assert!(result.is_err(), "{name} must be rejected");
        } else if let Some(count) = case["expected_service_count"].as_u64() {
            let policy = result.unwrap_or_else(|e| panic!("{name} must parse: {e}"));
            assert_eq!(policy.services.len() as u64, count, "{name}");
        } else {
            let policy = result.unwrap_or_else(|e| panic!("{name} must parse: {e}"));
            assert_eq!(Some(policy), expected_of(case), "{name}");
        }
    }
}
