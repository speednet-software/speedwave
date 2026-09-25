//! Guard for the bundled Claude Code `settings.json` template: it must not seed
//! a key that host-side code owns as a per-project store, and it keeps claude.ai sync off.

#![expect(
    clippy::expect_used,
    reason = "test assertions on setup calls that must not silently fail"
)]

use std::path::PathBuf;

const HOST_OWNED_KEYS: [(&str, &str); 2] = [
    (
        "effortLevel",
        "the project config effort_pin is the only effort store; \
         pin_cmd::ensure_effort_pin_migrated_in strips this key and the entrypoint merge \
         would seed it straight back (SPEED-664)",
    ),
    (
        "model",
        "claude_settings::set_model_pin owns this key; a template default would reappear \
         after clear_model_pin",
    ),
];

fn template() -> serde_json::Map<String, serde_json::Value> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("crates dir")
        .parent()
        .expect("repo root")
        .join("containers/claude-resources/settings.json");
    let raw = std::fs::read_to_string(&path).expect("read the settings template");
    serde_json::from_str::<serde_json::Value>(&raw)
        .expect("settings template is valid JSON")
        .as_object()
        .expect("settings template root is an object")
        .clone()
}

#[test]
fn settings_template_seeds_no_host_owned_key() {
    let template = template();
    for (key, why) in HOST_OWNED_KEYS {
        assert!(!template.contains_key(key), "{key}: {why}");
    }
}

#[test]
fn settings_template_turns_claude_ai_sync_off() {
    let template = template();
    for key in ["syncClaudeAiSkills", "syncClaudeAiPlugins"] {
        assert_eq!(
            template.get(key),
            Some(&serde_json::Value::Bool(false)),
            "{key}: Claude Code honours only `false`, and the container must not pull skills or \
             plugins enabled on claude.ai unless the user sets the key in its settings.json"
        );
    }
}

#[test]
fn settings_template_still_carries_its_own_keys() {
    let template = template();
    assert_eq!(
        template
            .get("outputStyle")
            .and_then(serde_json::Value::as_str),
        Some("Speedwave"),
        "the guard above must not be satisfiable by emptying the template"
    );
}
