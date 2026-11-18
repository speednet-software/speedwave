//! The `access.json` files the host writes, which the hub's loader reads in its own tests.

use serde_json::Value;
use speedwave_access_policy::{to_access_file, AccessMode, AccessPolicy};
use std::collections::BTreeMap;

const FILES: &str = include_str!("fixtures/written-access-files.json");

#[test]
fn every_policy_is_written_as_its_listed_file() {
    let files: Vec<Value> = serde_json::from_str(FILES).unwrap_or_default();
    assert!(!files.is_empty());
    for file in &files {
        let name = &file["name"];
        let policy = AccessPolicy {
            default: serde_json::from_value::<AccessMode>(file["policy"]["default"].clone())
                .unwrap_or_else(|e| panic!("{name}: default: {e}")),
            services: serde_json::from_value::<BTreeMap<String, AccessMode>>(
                file["policy"]["services"].clone(),
            )
            .unwrap_or_else(|e| panic!("{name}: services: {e}")),
        };
        assert_eq!(
            to_access_file(&policy).as_deref(),
            Ok(file["text"].as_str().unwrap_or_default()),
            "{name}"
        );
    }
}
