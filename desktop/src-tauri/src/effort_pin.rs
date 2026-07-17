//! Launch-effort pin IO for a project's claude-home `settings.json`
//! (`effortLevel` key). Next-session semantics only (ADR-082):
//! Claude Code itself refuses a live `/effort` change under an existing pin.

use std::path::Path;

use speedwave_runtime::fs_perms;

/// Effort levels `effortLevel` in `settings.json` actually persists across
/// sessions. `max` is session-only; `ultracode`/`auto` are not settings
/// values - both are excluded even though CC's live `/effort` accepts them.
pub const PERSISTABLE_EFFORT_LEVELS: &[&str] = &["low", "medium", "high", "xhigh"];

/// Reads `effortLevel` from `<data_dir>/claude-home/<project>/.claude/settings.json`.
/// Missing file or missing/non-string key both tolerate to `None`; a malformed
/// (non-JSON-object) file also tolerates to `None` rather than erroring the caller.
pub fn get_effort_pin(data_dir: &Path, project: &str) -> Option<String> {
    let path = settings_path(data_dir, project);
    let contents = fs_perms::read_regular_file_no_follow(&path)
        .ok()
        .flatten()?;
    let value: serde_json::Value = serde_json::from_str(&contents).ok()?;
    value.get("effortLevel")?.as_str().map(str::to_string)
}

/// Writes `effortLevel` into the project's claude-home `settings.json`,
/// preserving every other key via read-modify-write. Rejects a level
/// outside `PERSISTABLE_EFFORT_LEVELS`.
pub fn set_effort_pin(data_dir: &Path, project: &str, level: &str) -> Result<(), String> {
    if !PERSISTABLE_EFFORT_LEVELS.contains(&level) {
        return Err(format!("unknown effort level: {level}"));
    }
    let path = settings_path(data_dir, project);
    let existing = fs_perms::read_regular_file_no_follow(&path).map_err(|e| e.to_string())?;
    let mut value: serde_json::Value = match existing {
        Some(contents) => {
            serde_json::from_str(&contents).map_err(|e| format!("malformed settings.json: {e}"))?
        }
        None => serde_json::json!({}),
    };
    let obj = value
        .as_object_mut()
        .ok_or_else(|| "settings.json root is not an object".to_string())?;
    obj.insert(
        "effortLevel".to_string(),
        serde_json::Value::String(level.to_string()),
    );
    if let Some(parent) = path.parent() {
        fs_perms::ensure_owner_only_dir(parent).map_err(|e| e.to_string())?;
    }
    let rendered = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
    fs_perms::write_shared_file_atomic(&path, &rendered).map_err(|e| e.to_string())
}

fn settings_path(data_dir: &Path, project: &str) -> std::path::PathBuf {
    speedwave_runtime::claude_home::claude_home_dir(data_dir, project)
        .join(".claude")
        .join("settings.json")
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "test assertions use unwrap/expect"
)]
mod tests {
    use super::*;

    fn write_settings(data_dir: &Path, project: &str, json: &str) {
        let path = settings_path(data_dir, project);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, json).unwrap();
    }

    #[test]
    fn get_effort_pin_missing_file_returns_none() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(get_effort_pin(tmp.path(), "proj"), None);
    }

    #[test]
    fn get_effort_pin_reads_existing_key() {
        let tmp = tempfile::tempdir().unwrap();
        write_settings(tmp.path(), "proj", r#"{"effortLevel":"high"}"#);
        assert_eq!(get_effort_pin(tmp.path(), "proj"), Some("high".to_string()));
    }

    #[test]
    fn get_effort_pin_missing_key_returns_none() {
        let tmp = tempfile::tempdir().unwrap();
        write_settings(tmp.path(), "proj", r#"{"model":"foo"}"#);
        assert_eq!(get_effort_pin(tmp.path(), "proj"), None);
    }

    #[test]
    fn get_effort_pin_malformed_json_returns_none() {
        let tmp = tempfile::tempdir().unwrap();
        write_settings(tmp.path(), "proj", "not json");
        assert_eq!(get_effort_pin(tmp.path(), "proj"), None);
    }

    #[test]
    fn get_effort_pin_non_string_value_returns_none() {
        let tmp = tempfile::tempdir().unwrap();
        write_settings(tmp.path(), "proj", r#"{"effortLevel":5}"#);
        assert_eq!(get_effort_pin(tmp.path(), "proj"), None);
    }

    #[test]
    fn set_effort_pin_rejects_unknown_level() {
        let tmp = tempfile::tempdir().unwrap();
        let err = set_effort_pin(tmp.path(), "proj", "not-a-level").unwrap_err();
        assert!(err.contains("unknown effort level"));
    }

    #[test]
    fn set_effort_pin_rejects_session_only_max_level() {
        let tmp = tempfile::tempdir().unwrap();
        let err = set_effort_pin(tmp.path(), "proj", "max").unwrap_err();
        assert!(err.contains("unknown effort level"));
    }

    #[test]
    fn set_effort_pin_writes_new_file() {
        let tmp = tempfile::tempdir().unwrap();
        let level = PERSISTABLE_EFFORT_LEVELS[0];
        set_effort_pin(tmp.path(), "proj", level).unwrap();
        assert_eq!(get_effort_pin(tmp.path(), "proj"), Some(level.to_string()));
    }

    #[test]
    fn set_effort_pin_preserves_other_keys() {
        let tmp = tempfile::tempdir().unwrap();
        write_settings(
            tmp.path(),
            "proj",
            r#"{"model":"claude-sonnet-5","hooks":{"PreToolUse":[]}}"#,
        );
        let level = PERSISTABLE_EFFORT_LEVELS[0];
        set_effort_pin(tmp.path(), "proj", level).unwrap();
        let path = settings_path(tmp.path(), "proj");
        let raw = std::fs::read_to_string(&path).unwrap();
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(value["model"], "claude-sonnet-5");
        assert_eq!(value["hooks"]["PreToolUse"], serde_json::json!([]));
        assert_eq!(value["effortLevel"], level);
    }

    #[test]
    fn set_effort_pin_overwrites_previous_pin() {
        let tmp = tempfile::tempdir().unwrap();
        set_effort_pin(tmp.path(), "proj", PERSISTABLE_EFFORT_LEVELS[0]).unwrap();
        set_effort_pin(tmp.path(), "proj", PERSISTABLE_EFFORT_LEVELS[1]).unwrap();
        assert_eq!(
            get_effort_pin(tmp.path(), "proj"),
            Some(PERSISTABLE_EFFORT_LEVELS[1].to_string())
        );
    }

    #[test]
    fn set_effort_pin_rejects_non_object_root() {
        let tmp = tempfile::tempdir().unwrap();
        write_settings(tmp.path(), "proj", "[]");
        let level = PERSISTABLE_EFFORT_LEVELS[0];
        let err = set_effort_pin(tmp.path(), "proj", level).unwrap_err();
        assert!(err.contains("not an object"));
    }

    #[test]
    fn set_effort_pin_rejects_malformed_json() {
        let tmp = tempfile::tempdir().unwrap();
        write_settings(tmp.path(), "proj", "not json");
        let level = PERSISTABLE_EFFORT_LEVELS[0];
        let err = set_effort_pin(tmp.path(), "proj", level).unwrap_err();
        assert!(err.contains("malformed settings.json"));
        let path = settings_path(tmp.path(), "proj");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "not json");
    }
}
