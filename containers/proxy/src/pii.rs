//! Native PII engine state (ADR-073 F4): fail-closed load at startup, scans `system` +
//! `messages[].content` before every forward using the same crate the hub wraps in wasm.

use std::path::Path;

use rand::RngCore;
use speedwave_pii_engine::{
    compile_policy_v2, default_policy_json, scan_json, CompiledPolicy, Detection, EngineKey,
    ScanError,
};

/// Loaded PII engine state: ready to scan, or a fatal load error. `Failed` is surfaced by
/// every `/v1/messages` call as a 5xx — never a silent fallback to an unscanned forward.
pub enum PiiEngineState {
    Ready {
        policy: CompiledPolicy,
        key: EngineKey,
    },
    Failed(String),
}

/// Loads the engine from `POLICY_FILE` (+ sibling `key` file) when set, else the compiled-in
/// default policy with an ephemeral per-process key (dev / no-`POLICY_FILE` mode).
pub fn load_engine_state() -> std::sync::Arc<PiiEngineState> {
    std::sync::Arc::new(load_engine_state_from_env(
        std::env::var("POLICY_FILE").ok(),
    ))
}

fn load_engine_state_from_env(policy_file: Option<String>) -> PiiEngineState {
    match policy_file {
        Some(path) => load_from_file(Path::new(&path)),
        None => default_state(),
    }
}

fn default_state() -> PiiEngineState {
    match compile_policy_v2(&default_policy_json()) {
        Ok(policy) => PiiEngineState::Ready {
            policy,
            key: ephemeral_key(),
        },
        Err(e) => PiiEngineState::Failed(format!("default policy failed to compile: {e}")),
    }
}

/// 32 random bytes per process — only reached when `POLICY_FILE` is unset (dev/fail-safe);
/// production always supplies a persistent key via `POLICY_FILE`'s sibling `key` file.
fn ephemeral_key() -> EngineKey {
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    EngineKey::from_bytes(bytes)
}

/// Reads and compiles `policy_file` plus its sibling `key` file (mirrors
/// `engine.ts::resolvePolicyAndKey`); any failure is `Failed`, never a silent default.
fn load_from_file(policy_file: &Path) -> PiiEngineState {
    let policy_json = match std::fs::read_to_string(policy_file) {
        Ok(s) => s,
        Err(e) => {
            return PiiEngineState::Failed(format!(
                "reading policy file '{}': {e}",
                policy_file.display()
            ))
        }
    };
    let policy = match compile_policy_v2(&policy_json) {
        Ok(p) => p,
        Err(e) => {
            return PiiEngineState::Failed(format!(
                "compiling policy file '{}': {e}",
                policy_file.display()
            ))
        }
    };
    let Some(key_path) = policy_file.parent().map(|p| p.join("key")) else {
        return PiiEngineState::Failed(format!(
            "policy file '{}' has no parent directory",
            policy_file.display()
        ));
    };
    let key_hex = match std::fs::read_to_string(&key_path) {
        Ok(s) => s,
        Err(e) => {
            return PiiEngineState::Failed(format!(
                "reading policy key '{}': {e}",
                key_path.display()
            ))
        }
    };
    match EngineKey::from_hex(key_hex.trim()) {
        Ok(key) => PiiEngineState::Ready { policy, key },
        Err(e) => {
            PiiEngineState::Failed(format!("decoding policy key '{}': {e}", key_path.display()))
        }
    }
}

/// Merges one scan call's detections into a per-(category, action) running aggregate.
fn merge_detections(agg: &mut Vec<Detection>, more: Vec<Detection>) {
    for d in more {
        if let Some(existing) = agg
            .iter_mut()
            .find(|e| e.category == d.category && e.action == d.action)
        {
            existing.count += d.count;
        } else {
            agg.push(d);
        }
    }
}

/// Scans `system` and every `messages[].content` (tool results included); other protocol
/// fields are untouched. An `Err` may leave `body` partially mutated — the caller must discard it.
pub fn scan_request(
    policy: &CompiledPolicy,
    key: &EngineKey,
    body: &mut serde_json::Value,
) -> Result<Vec<Detection>, ScanError> {
    let mut detections = Vec::new();
    if let Some(system) = body.get_mut("system") {
        merge_detections(&mut detections, scan_json(policy, key, system)?);
    }
    if let Some(messages) = body.get_mut("messages").and_then(|m| m.as_array_mut()) {
        for message in messages.iter_mut() {
            if let Some(content) = message.get_mut("content") {
                merge_detections(&mut detections, scan_json(policy, key, content)?);
            }
        }
    }
    Ok(detections)
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "test fixture setup, failure aborts the test"
)]
mod tests {
    use super::*;
    use serde_json::json;
    use speedwave_pii_engine::DetectionAction;

    fn test_policy_and_key() -> (CompiledPolicy, EngineKey) {
        let policy = compile_policy_v2(&default_policy_json()).expect("default policy compiles");
        (policy, EngineKey::from_bytes([9u8; 32]))
    }

    #[test]
    fn default_state_is_ready() {
        assert!(matches!(default_state(), PiiEngineState::Ready { .. }));
    }

    #[test]
    fn load_engine_state_from_env_none_is_ready_default() {
        assert!(matches!(
            load_engine_state_from_env(None),
            PiiEngineState::Ready { .. }
        ));
    }

    #[test]
    fn missing_policy_file_fails_closed() {
        let state = load_engine_state_from_env(Some("/nonexistent/policy.json".to_string()));
        assert!(matches!(state, PiiEngineState::Failed(_)));
    }

    #[test]
    fn malformed_policy_json_fails_closed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("policy.json");
        std::fs::write(&path, "not json").unwrap();
        assert!(matches!(load_from_file(&path), PiiEngineState::Failed(_)));
    }

    #[test]
    fn missing_key_file_fails_closed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("policy.json");
        std::fs::write(&path, default_policy_json()).unwrap();
        // No sibling "key" file written.
        assert!(matches!(load_from_file(&path), PiiEngineState::Failed(_)));
    }

    #[test]
    fn malformed_key_fails_closed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("policy.json");
        std::fs::write(&path, default_policy_json()).unwrap();
        std::fs::write(dir.path().join("key"), "not-hex").unwrap();
        assert!(matches!(load_from_file(&path), PiiEngineState::Failed(_)));
    }

    #[test]
    fn valid_policy_and_key_load_ready() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("policy.json");
        std::fs::write(&path, default_policy_json()).unwrap();
        std::fs::write(dir.path().join("key"), "ab".repeat(32)).unwrap();
        assert!(matches!(
            load_from_file(&path),
            PiiEngineState::Ready { .. }
        ));
    }

    #[test]
    fn scan_request_tokenizes_system_and_message_content() {
        let (policy, key) = test_policy_and_key();
        let mut body = json!({
            "model": "claude-x",
            "system": "Contact bob@example.com for details",
            "messages": [
                {"role": "user", "content": "Email me at alice@example.com"}
            ]
        });
        let detections = scan_request(&policy, &key, &mut body).unwrap();
        assert!(!body["system"].as_str().unwrap().contains("bob@example.com"));
        assert!(body["system"].as_str().unwrap().contains("[EMAIL:TOKEN_"));
        assert!(!body["messages"][0]["content"]
            .as_str()
            .unwrap()
            .contains("alice@example.com"));
        assert_eq!(
            body["model"], "claude-x",
            "protocol field must be untouched"
        );
        assert_eq!(
            body["messages"][0]["role"], "user",
            "role must be untouched"
        );
        let email = detections.iter().find(|d| d.category == "EMAIL").unwrap();
        assert_eq!(email.count, 2);
    }

    #[test]
    fn scan_request_scans_system_as_array_of_text_blocks() {
        let (policy, key) = test_policy_and_key();
        let mut body = json!({
            "system": [{"type": "text", "text": "contact dave@example.com for access"}],
            "messages": []
        });
        let detections = scan_request(&policy, &key, &mut body).unwrap();
        let text = body["system"][0]["text"].as_str().unwrap();
        assert!(!text.contains("dave@example.com"));
        assert!(text.contains("[EMAIL:TOKEN_"));
        assert_eq!(
            body["system"][0]["type"], "text",
            "block type must be untouched"
        );
        assert!(detections.iter().any(|d| d.category == "EMAIL"));
    }

    #[test]
    fn scan_request_scans_tool_result_content_blocks() {
        let (policy, key) = test_policy_and_key();
        let mut body = json!({
            "messages": [
                {"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": "toolu_1", "content": "found carol@example.com"}
                ]}
            ]
        });
        let detections = scan_request(&policy, &key, &mut body).unwrap();
        let content = &body["messages"][0]["content"][0]["content"];
        assert!(!content.as_str().unwrap().contains("carol@example.com"));
        assert_eq!(body["messages"][0]["content"][0]["type"], "tool_result");
        assert_eq!(body["messages"][0]["content"][0]["tool_use_id"], "toolu_1");
        assert!(detections.iter().any(|d| d.category == "EMAIL"));
    }

    #[test]
    fn scan_request_is_idempotent_for_already_tokenized_history() {
        let (policy, key) = test_policy_and_key();
        let mut first = json!({"messages": [{"role": "user", "content": "dan@example.com"}]});
        let first_detections = scan_request(&policy, &key, &mut first).unwrap();
        assert_eq!(first_detections.len(), 1);

        // Reuse the already-tokenized turn as history, add a new message with fresh PII.
        let mut second = json!({
            "messages": [
                first["messages"][0].clone(),
                {"role": "user", "content": "erin@example.com"}
            ]
        });
        let second_detections = scan_request(&policy, &key, &mut second).unwrap();
        let email = second_detections
            .iter()
            .find(|d| d.category == "EMAIL")
            .unwrap();
        assert_eq!(
            email.count, 1,
            "only the new value must be counted, not the replayed token"
        );
        assert_eq!(
            second["messages"][0], first["messages"][0],
            "already-tokenized history must be untouched"
        );
    }

    #[test]
    fn scan_request_missing_system_and_messages_is_a_noop() {
        let (policy, key) = test_policy_and_key();
        let mut body = json!({"model": "claude-x", "max_tokens": 16});
        let detections = scan_request(&policy, &key, &mut body).unwrap();
        assert!(detections.is_empty());
        assert_eq!(body, json!({"model": "claude-x", "max_tokens": 16}));
    }

    #[test]
    fn scan_request_handles_a_large_history_without_panicking() {
        let (policy, key) = test_policy_and_key();
        let messages: Vec<_> = (0..2000)
            .map(|i| json!({"role": "user", "content": format!("row {i} contact user{i}@example.com")}))
            .collect();
        let mut body = json!({"messages": messages});
        let detections = scan_request(&policy, &key, &mut body).unwrap();
        let email = detections.iter().find(|d| d.category == "EMAIL").unwrap();
        assert_eq!(email.count, 2000);
    }

    #[test]
    fn merge_detections_sums_counts_across_calls() {
        let mut agg = vec![Detection {
            category: "EMAIL".into(),
            action: DetectionAction::Tokenized,
            count: 2,
        }];
        merge_detections(
            &mut agg,
            vec![Detection {
                category: "EMAIL".into(),
                action: DetectionAction::Tokenized,
                count: 3,
            }],
        );
        assert_eq!(agg.len(), 1);
        assert_eq!(agg[0].count, 5);
    }
}
