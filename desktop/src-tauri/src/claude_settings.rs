use std::path::Path;

use speedwave_runtime::fs_perms;

pub fn get_model_pin(data_dir: &Path, project: &str) -> Option<String> {
    read_settings_string_key(data_dir, project, "model")
}

fn read_settings_string_key(data_dir: &Path, project: &str, key: &str) -> Option<String> {
    let path = settings_path(data_dir, project);
    let contents = fs_perms::read_regular_file_no_follow(&path)
        .ok()
        .flatten()?;
    let value: serde_json::Value = serde_json::from_str(&contents).ok()?;
    value.get(key)?.as_str().map(str::to_string)
}

pub fn take_legacy_effort_pin(data_dir: &Path, project: &str) -> Result<Option<String>, String> {
    let path = settings_path(data_dir, project);
    fs_perms::with_file_lock_in(&settings_lock_path(data_dir, project), || {
        let Some(contents) =
            fs_perms::read_regular_file_no_follow(&path).map_err(anyhow::Error::msg)?
        else {
            return Ok(None);
        };
        let mut value: serde_json::Value = serde_json::from_str(&contents)
            .map_err(|e| anyhow::anyhow!("malformed settings.json: {e}"))?;
        let obj = value
            .as_object_mut()
            .ok_or_else(|| anyhow::anyhow!("settings.json root is not an object"))?;
        let Some(removed) = obj.remove("effortLevel") else {
            return Ok(None);
        };
        let level = removed.as_str().map(str::to_string);
        let rendered = serde_json::to_string_pretty(&value)?;
        fs_perms::write_shared_file_atomic(&path, &rendered)?;
        Ok(level)
    })
    .map_err(|e| e.to_string())
}

pub fn set_model_pin(data_dir: &Path, project: &str, model: &str) -> Result<(), String> {
    if !speedwave_runtime::defaults::is_selectable_anthropic_model_id(model) {
        return Err(format!("unknown Anthropic model: {model}"));
    }
    let path = settings_path(data_dir, project);
    if let Some(parent) = path.parent() {
        fs_perms::ensure_owner_only_dir(parent).map_err(|e| e.to_string())?;
    }
    fs_perms::with_file_lock_in(&settings_lock_path(data_dir, project), || {
        let existing = fs_perms::read_regular_file_no_follow(&path).map_err(anyhow::Error::msg)?;
        let mut value: serde_json::Value = match existing {
            Some(contents) => serde_json::from_str(&contents)
                .map_err(|e| anyhow::anyhow!("malformed settings.json: {e}"))?,
            None => serde_json::json!({}),
        };
        let obj = value
            .as_object_mut()
            .ok_or_else(|| anyhow::anyhow!("settings.json root is not an object"))?;
        obj.insert(
            "model".to_string(),
            serde_json::Value::String(model.to_string()),
        );
        let rendered = serde_json::to_string_pretty(&value)?;
        fs_perms::write_shared_file_atomic(&path, &rendered)
    })
    .map_err(|e| e.to_string())
}

fn settings_path(data_dir: &Path, project: &str) -> std::path::PathBuf {
    speedwave_runtime::claude_home::claude_home_dir(data_dir, project)
        .join(".claude")
        .join("settings.json")
}

fn settings_lock_path(data_dir: &Path, project: &str) -> std::path::PathBuf {
    speedwave_runtime::claude_home::claude_home_dir(data_dir, project)
        .join(".claude")
        .join(".settings.json.lock")
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
    fn get_model_pin_reads_the_model_key() {
        let tmp = tempfile::tempdir().unwrap();
        write_settings(tmp.path(), "proj", r#"{"model":"claude-fable-5[1m]"}"#);
        assert_eq!(
            get_model_pin(tmp.path(), "proj"),
            Some("claude-fable-5[1m]".to_string())
        );
    }

    #[test]
    fn get_model_pin_tolerates_missing_file_and_key() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(get_model_pin(tmp.path(), "proj"), None);
        write_settings(tmp.path(), "proj", r#"{"effortLevel":"high"}"#);
        assert_eq!(get_model_pin(tmp.path(), "proj"), None);
    }

    #[test]
    fn take_legacy_effort_pin_missing_file_returns_none() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(take_legacy_effort_pin(tmp.path(), "proj").unwrap(), None);
    }

    #[test]
    fn take_legacy_effort_pin_reads_and_removes_the_key() {
        let tmp = tempfile::tempdir().unwrap();
        write_settings(
            tmp.path(),
            "proj",
            r#"{"model":"claude-sonnet-5","effortLevel":"high"}"#,
        );
        let taken = take_legacy_effort_pin(tmp.path(), "proj").unwrap();
        assert_eq!(taken, Some("high".to_string()));

        let path = settings_path(tmp.path(), "proj");
        let raw = std::fs::read_to_string(&path).unwrap();
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(value["model"], "claude-sonnet-5");
        assert!(value.get("effortLevel").is_none());
    }

    #[test]
    fn take_legacy_effort_pin_missing_key_returns_none_and_leaves_file() {
        let tmp = tempfile::tempdir().unwrap();
        write_settings(tmp.path(), "proj", r#"{"model":"claude-sonnet-5"}"#);
        assert_eq!(take_legacy_effort_pin(tmp.path(), "proj").unwrap(), None);
        let path = settings_path(tmp.path(), "proj");
        let raw = std::fs::read_to_string(&path).unwrap();
        assert_eq!(raw, r#"{"model":"claude-sonnet-5"}"#);
    }

    #[test]
    fn take_legacy_effort_pin_is_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        write_settings(tmp.path(), "proj", r#"{"effortLevel":"low"}"#);
        assert_eq!(
            take_legacy_effort_pin(tmp.path(), "proj").unwrap(),
            Some("low".to_string())
        );
        assert_eq!(take_legacy_effort_pin(tmp.path(), "proj").unwrap(), None);
    }

    #[test]
    fn take_legacy_effort_pin_non_string_value_removed_but_not_returned() {
        let tmp = tempfile::tempdir().unwrap();
        write_settings(tmp.path(), "proj", r#"{"effortLevel":5}"#);
        assert_eq!(take_legacy_effort_pin(tmp.path(), "proj").unwrap(), None);
        let path = settings_path(tmp.path(), "proj");
        let raw = std::fs::read_to_string(&path).unwrap();
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert!(value.get("effortLevel").is_none());
    }

    #[test]
    fn take_legacy_effort_pin_rejects_non_object_root() {
        let tmp = tempfile::tempdir().unwrap();
        write_settings(tmp.path(), "proj", "[]");
        let err = take_legacy_effort_pin(tmp.path(), "proj").unwrap_err();
        assert!(err.contains("not an object"));
    }

    #[test]
    fn take_legacy_effort_pin_rejects_malformed_json() {
        let tmp = tempfile::tempdir().unwrap();
        write_settings(tmp.path(), "proj", "not json");
        let err = take_legacy_effort_pin(tmp.path(), "proj").unwrap_err();
        assert!(err.contains("malformed settings.json"));
        let path = settings_path(tmp.path(), "proj");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "not json");
    }

    #[cfg(unix)]
    #[test]
    fn take_legacy_effort_pin_lock_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().unwrap();
        write_settings(tmp.path(), "proj", r#"{"effortLevel":"low"}"#);
        take_legacy_effort_pin(tmp.path(), "proj").unwrap();
        let lock_path = settings_lock_path(tmp.path(), "proj");
        let mode = std::fs::metadata(&lock_path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[test]
    fn set_model_pin_writes_new_file() {
        let tmp = tempfile::tempdir().unwrap();
        set_model_pin(tmp.path(), "proj", "claude-sonnet-5").unwrap();
        assert_eq!(
            get_model_pin(tmp.path(), "proj"),
            Some("claude-sonnet-5".to_string())
        );
    }

    #[test]
    fn set_model_pin_accepts_the_1m_alias_when_priced() {
        let tmp = tempfile::tempdir().unwrap();
        set_model_pin(tmp.path(), "proj", "claude-sonnet-5[1m]").unwrap();
        assert_eq!(
            get_model_pin(tmp.path(), "proj"),
            Some("claude-sonnet-5[1m]".to_string())
        );
    }

    #[test]
    fn set_model_pin_preserves_other_keys() {
        let tmp = tempfile::tempdir().unwrap();
        write_settings(
            tmp.path(),
            "proj",
            r#"{"effortLevel":"high","hooks":{"PreToolUse":[]}}"#,
        );
        set_model_pin(tmp.path(), "proj", "claude-opus-5").unwrap();
        let path = settings_path(tmp.path(), "proj");
        let raw = std::fs::read_to_string(&path).unwrap();
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(value["effortLevel"], "high");
        assert_eq!(value["hooks"]["PreToolUse"], serde_json::json!([]));
        assert_eq!(value["model"], "claude-opus-5");
    }

    #[test]
    fn set_model_pin_rejects_ids_outside_the_anthropic_catalog() {
        let tmp = tempfile::tempdir().unwrap();
        for bad in ["gpt-4o", "openrouter/anthropic/claude-sonnet-5", ""] {
            let err = set_model_pin(tmp.path(), "proj", bad).unwrap_err();
            assert!(err.contains("unknown Anthropic model"), "id: {bad}");
        }
        assert_eq!(get_model_pin(tmp.path(), "proj"), None);
    }

    #[test]
    fn set_model_pin_rejects_the_1m_alias_for_a_model_without_1m_pricing() {
        let tmp = tempfile::tempdir().unwrap();
        let err = set_model_pin(tmp.path(), "proj", "claude-haiku-4-5[1m]").unwrap_err();
        assert!(err.contains("unknown Anthropic model"));
        assert_eq!(get_model_pin(tmp.path(), "proj"), None);
    }

    #[test]
    fn set_model_pin_rejects_malformed_json_and_leaves_the_file_untouched() {
        let tmp = tempfile::tempdir().unwrap();
        write_settings(tmp.path(), "proj", "not json");
        let err = set_model_pin(tmp.path(), "proj", "claude-sonnet-5").unwrap_err();
        assert!(err.contains("malformed settings.json"));
        let path = settings_path(tmp.path(), "proj");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "not json");
    }

    #[test]
    fn set_model_pin_rejects_non_object_root_and_leaves_the_file_untouched() {
        let tmp = tempfile::tempdir().unwrap();
        write_settings(tmp.path(), "proj", "[]");
        let err = set_model_pin(tmp.path(), "proj", "claude-sonnet-5").unwrap_err();
        assert!(err.contains("not an object"));
        let path = settings_path(tmp.path(), "proj");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "[]");
    }

    #[test]
    fn set_model_pin_overwrites_previous_pin() {
        let tmp = tempfile::tempdir().unwrap();
        set_model_pin(tmp.path(), "proj", "claude-sonnet-5").unwrap();
        set_model_pin(tmp.path(), "proj", "claude-opus-5").unwrap();
        assert_eq!(
            get_model_pin(tmp.path(), "proj"),
            Some("claude-opus-5".to_string())
        );
    }

    #[test]
    fn set_model_pin_concurrent_writers_serialize_without_lost_update() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().to_path_buf();
        write_settings(&data_dir, "proj", r#"{"effortLevel":"high"}"#);

        let iterations = 50;
        let d1 = data_dir.clone();
        let d2 = data_dir.clone();
        let t1 = std::thread::spawn(move || {
            for _ in 0..iterations {
                set_model_pin(&d1, "proj", "claude-sonnet-5").unwrap();
            }
        });
        let t2 = std::thread::spawn(move || {
            for _ in 0..iterations {
                set_model_pin(&d2, "proj", "claude-opus-5").unwrap();
            }
        });
        t1.join().unwrap();
        t2.join().unwrap();

        let path = settings_path(&data_dir, "proj");
        let raw = std::fs::read_to_string(&path).unwrap();
        let value: serde_json::Value =
            serde_json::from_str(&raw).expect("final file must be valid JSON, not torn");
        assert_eq!(value["effortLevel"], "high");
        let model = value["model"].as_str().unwrap();
        assert!(
            model == "claude-sonnet-5" || model == "claude-opus-5",
            "unexpected model: {model}"
        );

        let read_back = get_model_pin(&data_dir, "proj");
        assert_eq!(read_back.as_deref(), Some(model));
    }

    #[cfg(unix)]
    #[test]
    fn set_model_pin_lock_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().unwrap();
        set_model_pin(tmp.path(), "proj", "claude-sonnet-5").unwrap();
        let lock_path = settings_lock_path(tmp.path(), "proj");
        let mode = std::fs::metadata(&lock_path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
}
