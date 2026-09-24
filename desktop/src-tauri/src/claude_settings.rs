use std::path::Path;

use speedwave_runtime::fs_perms;

pub fn take_legacy_effort_pin(data_dir: &Path, project: &str) -> Result<Option<String>, String> {
    take_settings_key(data_dir, project, "effortLevel")
}

const MODEL_KEY: &str = "model";

pub fn take_legacy_model_pin(data_dir: &Path, project: &str) -> Result<Option<String>, String> {
    take_settings_key(data_dir, project, MODEL_KEY)
}

fn take_settings_key(data_dir: &Path, project: &str, key: &str) -> Result<Option<String>, String> {
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
        let Some(removed) = obj.remove(key) else {
            return Ok(None);
        };
        let taken = removed.as_str().map(str::to_string);
        let rendered = serde_json::to_string_pretty(&value)?;
        fs_perms::write_shared_file_atomic(&path, &rendered)?;
        Ok(taken)
    })
    .map_err(|e| e.to_string())
}

fn settings_path(data_dir: &Path, project: &str) -> std::path::PathBuf {
    speedwave_runtime::claude_home::claude_config_dir(data_dir, project).join("settings.json")
}

fn settings_lock_path(data_dir: &Path, project: &str) -> std::path::PathBuf {
    speedwave_runtime::claude_home::claude_config_dir(data_dir, project).join(".settings.json.lock")
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
    fn take_legacy_model_pin_reads_and_removes_the_key() {
        let tmp = tempfile::tempdir().unwrap();
        write_settings(
            tmp.path(),
            "proj",
            r#"{"model":"claude-fable-5[1m]","effortLevel":"high","hooks":{"PreToolUse":[]}}"#,
        );
        let taken = take_legacy_model_pin(tmp.path(), "proj").unwrap();
        assert_eq!(taken, Some("claude-fable-5[1m]".to_string()));

        let raw = std::fs::read_to_string(settings_path(tmp.path(), "proj")).unwrap();
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert!(value.get("model").is_none());
        assert_eq!(value["effortLevel"], "high");
        assert_eq!(value["hooks"]["PreToolUse"], serde_json::json!([]));
    }

    #[test]
    fn take_legacy_model_pin_missing_file_and_key_return_none() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(take_legacy_model_pin(tmp.path(), "proj").unwrap(), None);
        write_settings(tmp.path(), "proj", r#"{"effortLevel":"high"}"#);
        assert_eq!(take_legacy_model_pin(tmp.path(), "proj").unwrap(), None);
        let raw = std::fs::read_to_string(settings_path(tmp.path(), "proj")).unwrap();
        assert_eq!(raw, r#"{"effortLevel":"high"}"#);
    }

    #[test]
    fn take_legacy_model_pin_is_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        write_settings(tmp.path(), "proj", r#"{"model":"claude-sonnet-5"}"#);
        assert_eq!(
            take_legacy_model_pin(tmp.path(), "proj").unwrap(),
            Some("claude-sonnet-5".to_string())
        );
        assert_eq!(take_legacy_model_pin(tmp.path(), "proj").unwrap(), None);
    }

    #[test]
    fn take_legacy_model_pin_non_string_value_removed_but_not_returned() {
        let tmp = tempfile::tempdir().unwrap();
        write_settings(tmp.path(), "proj", r#"{"model":7}"#);
        assert_eq!(take_legacy_model_pin(tmp.path(), "proj").unwrap(), None);
        let raw = std::fs::read_to_string(settings_path(tmp.path(), "proj")).unwrap();
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert!(value.get("model").is_none());
    }

    #[test]
    fn take_legacy_model_pin_rejects_malformed_json_and_leaves_the_file_untouched() {
        let tmp = tempfile::tempdir().unwrap();
        write_settings(tmp.path(), "proj", "not json");
        let err = take_legacy_model_pin(tmp.path(), "proj").unwrap_err();
        assert!(err.contains("malformed settings.json"));
        assert_eq!(
            std::fs::read_to_string(settings_path(tmp.path(), "proj")).unwrap(),
            "not json"
        );
    }

    #[test]
    fn take_legacy_model_pin_rejects_non_object_root() {
        let tmp = tempfile::tempdir().unwrap();
        write_settings(tmp.path(), "proj", "[]");
        let err = take_legacy_model_pin(tmp.path(), "proj").unwrap_err();
        assert!(err.contains("not an object"));
    }

    #[cfg(unix)]
    #[test]
    fn take_legacy_model_pin_lock_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().unwrap();
        write_settings(tmp.path(), "proj", r#"{"model":"claude-sonnet-5"}"#);
        take_legacy_model_pin(tmp.path(), "proj").unwrap();
        let lock_path = settings_lock_path(tmp.path(), "proj");
        let mode = std::fs::metadata(&lock_path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[test]
    fn take_legacy_model_pin_concurrent_takers_serialize_and_exactly_one_wins() {
        let tmp = tempfile::tempdir().unwrap();
        write_settings(
            tmp.path(),
            "proj",
            r#"{"model":"claude-sonnet-5","outputStyle":"Speedwave"}"#,
        );
        let d1 = tmp.path().to_path_buf();
        let d2 = tmp.path().to_path_buf();
        let t1 = std::thread::spawn(move || take_legacy_model_pin(&d1, "proj").unwrap());
        let t2 = std::thread::spawn(move || take_legacy_model_pin(&d2, "proj").unwrap());
        let taken: Vec<Option<String>> = vec![t1.join().unwrap(), t2.join().unwrap()];
        assert_eq!(
            taken.iter().flatten().count(),
            1,
            "exactly one taker wins: {taken:?}"
        );
        let raw = std::fs::read_to_string(settings_path(tmp.path(), "proj")).unwrap();
        let value: serde_json::Value =
            serde_json::from_str(&raw).expect("final file must be valid JSON, not torn");
        assert!(value.get("model").is_none());
        assert_eq!(value["outputStyle"], "Speedwave");
    }
}
