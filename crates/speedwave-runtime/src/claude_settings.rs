//! The keys of a project's Claude Code `settings.json` that Speedwave owns: the model pin and
//! the legacy `effortLevel` takeover; every write is locked, atomic and keeps the other keys.

use std::path::Path;

use crate::fs_perms;

/// The `model` pin of the project's `settings.json`, or `None` when unset or unreadable.
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

/// Removes the legacy `effortLevel` key and returns its string value, if any.
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

const MODEL_KEY: &str = "model";

/// Writes `model` as the pin: a Claude id the live session listed, else a selectable catalog id.
pub fn set_model_pin(
    data_dir: &Path,
    project: &str,
    model: &str,
    listed_by_claude_code: &[String],
) -> Result<(), String> {
    let listed = model.starts_with("claude-") && listed_by_claude_code.iter().any(|m| m == model);
    if !listed && !crate::defaults::is_selectable_anthropic_model_id(model) {
        return Err(format!("unknown Anthropic model: {model}"));
    }
    edit_settings(data_dir, project, true, |obj| {
        obj.insert(
            MODEL_KEY.to_string(),
            serde_json::Value::String(model.to_string()),
        );
        true
    })
    .map(|_| ())
}

/// Removes the `model` pin; a missing file or key is not an error.
pub fn clear_model_pin(data_dir: &Path, project: &str) -> Result<(), String> {
    edit_settings(data_dir, project, false, |obj| {
        obj.remove(MODEL_KEY).is_some()
    })
    .map(|_| ())
}

/// Rewrites the pin to what `normalized` returns for it and yields the new value, if any.
pub fn normalize_model_pin(
    data_dir: &Path,
    project: &str,
    normalized: impl FnOnce(&str) -> Option<String>,
) -> Result<Option<String>, String> {
    let mut rewritten = None;
    edit_settings(data_dir, project, false, |obj| {
        let Some(next) = obj
            .get(MODEL_KEY)
            .and_then(serde_json::Value::as_str)
            .and_then(normalized)
        else {
            return false;
        };
        obj.insert(
            MODEL_KEY.to_string(),
            serde_json::Value::String(next.clone()),
        );
        rewritten = Some(next);
        true
    })?;
    Ok(rewritten)
}

fn edit_settings(
    data_dir: &Path,
    project: &str,
    create_if_missing: bool,
    edit: impl FnOnce(&mut serde_json::Map<String, serde_json::Value>) -> bool,
) -> Result<bool, String> {
    let path = settings_path(data_dir, project);
    if !create_if_missing && !path.exists() {
        return Ok(false);
    }
    fs_perms::with_file_lock_in(&settings_lock_path(data_dir, project), || {
        if create_if_missing {
            if let Some(parent) = path.parent() {
                fs_perms::ensure_owner_only_dir(parent)?;
            }
        }
        let existing = fs_perms::read_regular_file_no_follow(&path).map_err(anyhow::Error::msg)?;
        let mut value: serde_json::Value = match existing {
            Some(contents) => serde_json::from_str(&contents)
                .map_err(|e| anyhow::anyhow!("malformed settings.json: {e}"))?,
            None if create_if_missing => serde_json::json!({}),
            None => return Ok(false),
        };
        let obj = value
            .as_object_mut()
            .ok_or_else(|| anyhow::anyhow!("settings.json root is not an object"))?;
        if !edit(obj) {
            return Ok(false);
        }
        let rendered = serde_json::to_string_pretty(&value)?;
        fs_perms::write_shared_file_atomic(&path, &rendered)?;
        Ok(true)
    })
    .map_err(|e| e.to_string())
}

fn settings_path(data_dir: &Path, project: &str) -> std::path::PathBuf {
    crate::claude_home::claude_config_dir(data_dir, project).join("settings.json")
}

fn settings_lock_path(data_dir: &Path, project: &str) -> std::path::PathBuf {
    crate::claude_home::claude_config_dir(data_dir, project).join(".settings.json.lock")
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
        set_model_pin(tmp.path(), "proj", "claude-sonnet-5", &[]).unwrap();
        assert_eq!(
            get_model_pin(tmp.path(), "proj"),
            Some("claude-sonnet-5".to_string())
        );
    }

    #[test]
    fn set_model_pin_accepts_the_1m_alias_when_priced() {
        let tmp = tempfile::tempdir().unwrap();
        set_model_pin(tmp.path(), "proj", "claude-sonnet-5[1m]", &[]).unwrap();
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
        set_model_pin(tmp.path(), "proj", "claude-opus-5", &[]).unwrap();
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
            let err = set_model_pin(tmp.path(), "proj", bad, &[]).unwrap_err();
            assert!(err.contains("unknown Anthropic model"), "id: {bad}");
        }
        assert_eq!(get_model_pin(tmp.path(), "proj"), None);
    }

    #[test]
    fn set_model_pin_accepts_the_legacy_catalog_rows() {
        let tmp = tempfile::tempdir().unwrap();
        for id in [
            "claude-opus-4-8[1m]",
            "claude-opus-4-6",
            "claude-sonnet-4-6",
        ] {
            set_model_pin(tmp.path(), "proj", id, &[]).unwrap();
            assert_eq!(get_model_pin(tmp.path(), "proj").as_deref(), Some(id));
        }
    }

    #[test]
    fn set_model_pin_accepts_a_claude_id_the_live_session_lists() {
        let tmp = tempfile::tempdir().unwrap();
        let listed = vec!["claude-opus-9[1m]".to_string(), "opus".to_string()];
        set_model_pin(tmp.path(), "proj", "claude-opus-9[1m]", &listed).unwrap();
        assert_eq!(
            get_model_pin(tmp.path(), "proj").as_deref(),
            Some("claude-opus-9[1m]")
        );
    }

    #[test]
    fn set_model_pin_rejects_listed_values_that_are_not_claude_ids() {
        let tmp = tempfile::tempdir().unwrap();
        let listed = vec!["opus".to_string(), "local/qwen3".to_string()];
        for bad in ["opus", "local/qwen3", "claude-opus-9"] {
            let err = set_model_pin(tmp.path(), "proj", bad, &listed).unwrap_err();
            assert!(err.contains("unknown Anthropic model"), "id: {bad}");
        }
        assert_eq!(get_model_pin(tmp.path(), "proj"), None);
    }

    #[test]
    fn clear_model_pin_removes_only_the_model_key() {
        let tmp = tempfile::tempdir().unwrap();
        write_settings(
            tmp.path(),
            "proj",
            r#"{"model":"claude-opus-5[1m]","outputStyle":"Speedwave"}"#,
        );
        clear_model_pin(tmp.path(), "proj").unwrap();
        assert_eq!(get_model_pin(tmp.path(), "proj"), None);
        let raw = std::fs::read_to_string(settings_path(tmp.path(), "proj")).unwrap();
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(value["outputStyle"], "Speedwave");
        assert!(value.get("model").is_none());
    }

    #[test]
    fn clear_model_pin_without_a_pin_or_a_file_changes_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        clear_model_pin(tmp.path(), "proj").unwrap();
        assert!(!settings_path(tmp.path(), "proj").exists());

        write_settings(tmp.path(), "proj", r#"{"outputStyle":"Speedwave"}"#);
        let before = std::fs::read_to_string(settings_path(tmp.path(), "proj")).unwrap();
        clear_model_pin(tmp.path(), "proj").unwrap();
        let after = std::fs::read_to_string(settings_path(tmp.path(), "proj")).unwrap();
        assert_eq!(before, after);
    }

    #[test]
    fn clear_model_pin_rejects_malformed_json_and_leaves_the_file_untouched() {
        let tmp = tempfile::tempdir().unwrap();
        write_settings(tmp.path(), "proj", "{not json");
        let err = clear_model_pin(tmp.path(), "proj").unwrap_err();
        assert!(err.contains("malformed settings.json"), "{err}");
        let raw = std::fs::read_to_string(settings_path(tmp.path(), "proj")).unwrap();
        assert_eq!(raw, "{not json");
    }

    #[test]
    fn normalize_model_pin_rewrites_the_pin_the_closure_changes() {
        let tmp = tempfile::tempdir().unwrap();
        write_settings(
            tmp.path(),
            "proj",
            r#"{"model":"claude-sonnet-5","outputStyle":"Speedwave"}"#,
        );
        let rewritten = normalize_model_pin(tmp.path(), "proj", |pin| {
            assert_eq!(pin, "claude-sonnet-5");
            Some("claude-sonnet-5[1m]".to_string())
        })
        .unwrap();
        assert_eq!(rewritten.as_deref(), Some("claude-sonnet-5[1m]"));
        assert_eq!(
            get_model_pin(tmp.path(), "proj").as_deref(),
            Some("claude-sonnet-5[1m]")
        );
        let raw = std::fs::read_to_string(settings_path(tmp.path(), "proj")).unwrap();
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(value["outputStyle"], "Speedwave");
    }

    #[test]
    fn normalize_model_pin_leaves_the_file_alone_when_nothing_changes() {
        let tmp = tempfile::tempdir().unwrap();
        write_settings(tmp.path(), "proj", r#"{"model":"claude-opus-5[1m]"}"#);
        let before = std::fs::read_to_string(settings_path(tmp.path(), "proj")).unwrap();
        assert_eq!(
            normalize_model_pin(tmp.path(), "proj", |_| None).unwrap(),
            None
        );
        let after = std::fs::read_to_string(settings_path(tmp.path(), "proj")).unwrap();
        assert_eq!(before, after);
    }

    #[test]
    fn normalize_model_pin_never_asks_about_a_missing_pin() {
        let tmp = tempfile::tempdir().unwrap();
        let never = |_: &str| -> Option<String> { panic!("no pin to normalize") };
        assert_eq!(
            normalize_model_pin(tmp.path(), "proj", never).unwrap(),
            None
        );
        write_settings(tmp.path(), "proj", r#"{"model":7}"#);
        let never = |_: &str| -> Option<String> { panic!("a non-string pin is not a pin") };
        assert_eq!(
            normalize_model_pin(tmp.path(), "proj", never).unwrap(),
            None
        );
    }

    #[test]
    fn set_model_pin_rejects_the_1m_alias_for_a_model_without_1m_pricing() {
        let tmp = tempfile::tempdir().unwrap();
        let err = set_model_pin(tmp.path(), "proj", "claude-haiku-4-5[1m]", &[]).unwrap_err();
        assert!(err.contains("unknown Anthropic model"));
        assert_eq!(get_model_pin(tmp.path(), "proj"), None);
    }

    #[test]
    fn set_model_pin_rejects_malformed_json_and_leaves_the_file_untouched() {
        let tmp = tempfile::tempdir().unwrap();
        write_settings(tmp.path(), "proj", "not json");
        let err = set_model_pin(tmp.path(), "proj", "claude-sonnet-5", &[]).unwrap_err();
        assert!(err.contains("malformed settings.json"));
        let path = settings_path(tmp.path(), "proj");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "not json");
    }

    #[test]
    fn set_model_pin_rejects_non_object_root_and_leaves_the_file_untouched() {
        let tmp = tempfile::tempdir().unwrap();
        write_settings(tmp.path(), "proj", "[]");
        let err = set_model_pin(tmp.path(), "proj", "claude-sonnet-5", &[]).unwrap_err();
        assert!(err.contains("not an object"));
        let path = settings_path(tmp.path(), "proj");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "[]");
    }

    #[test]
    fn set_model_pin_overwrites_previous_pin() {
        let tmp = tempfile::tempdir().unwrap();
        set_model_pin(tmp.path(), "proj", "claude-sonnet-5", &[]).unwrap();
        set_model_pin(tmp.path(), "proj", "claude-opus-5", &[]).unwrap();
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
                set_model_pin(&d1, "proj", "claude-sonnet-5", &[]).unwrap();
            }
        });
        let t2 = std::thread::spawn(move || {
            for _ in 0..iterations {
                set_model_pin(&d2, "proj", "claude-opus-5", &[]).unwrap();
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
        set_model_pin(tmp.path(), "proj", "claude-sonnet-5", &[]).unwrap();
        let lock_path = settings_lock_path(tmp.path(), "proj");
        let mode = std::fs::metadata(&lock_path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[cfg(unix)]
    #[test]
    fn set_model_pin_tightens_a_new_or_loose_claude_dir_to_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().unwrap();
        let dir = crate::claude_home::claude_config_dir(tmp.path(), "proj");
        let mode = || std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777;

        set_model_pin(tmp.path(), "proj", "claude-sonnet-5", &[]).unwrap();
        assert_eq!(mode(), 0o700);

        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        set_model_pin(tmp.path(), "proj", "claude-opus-5", &[]).unwrap();
        assert_eq!(mode(), 0o700);
    }

    #[test]
    fn set_model_pin_rejects_an_unknown_id_before_creating_anything() {
        let tmp = tempfile::tempdir().unwrap();
        let err = set_model_pin(tmp.path(), "proj", "claude-mystery-9", &[]).unwrap_err();
        assert!(err.contains("unknown Anthropic model"));
        assert!(!crate::claude_home::claude_home_dir(tmp.path(), "proj").exists());
    }
}
