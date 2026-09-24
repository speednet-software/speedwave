use std::path::Path;

use crate::chat::SharedChatSession;
use crate::types::check_project;
use speedwave_runtime::config;

fn resolve_project_name(project_id: &str) -> Result<String, String> {
    check_project(project_id)?;
    let user_config = config::load_user_config().map_err(|e| e.to_string())?;
    let project = user_config
        .require_project(project_id)
        .map_err(|e| e.to_string())?;
    Ok(project.name.clone())
}

pub(crate) fn ensure_effort_pin_migrated_in(
    data_dir: &std::path::Path,
    project_name: &str,
) -> Result<(), String> {
    config::with_config_lock_in(data_dir, || {
        let config_path = data_dir.join("config.json");
        let mut user_config = config::load_user_config_from(&config_path)?;
        let Some(pin) = user_config
            .find_project(project_name)
            .map(|p| p.effort_pin.clone())
        else {
            return Ok(());
        };
        let legacy = match crate::claude_settings::take_legacy_effort_pin(data_dir, project_name) {
            Ok(legacy) => legacy,
            Err(e) => {
                log::warn!("legacy effort pin migration skipped for {project_name}: {e}");
                return Ok(());
            }
        };
        if let Some(pin) = pin {
            if let Some(stale) = legacy {
                log::info!(
                    "dropped the stale settings.json effortLevel {stale} for {project_name}; the effort pin {pin} stays authoritative"
                );
            }
            return Ok(());
        }
        let Some(level) =
            legacy.filter(|l| speedwave_runtime::defaults::EFFORT_LEVELS.contains(&l.as_str()))
        else {
            return Ok(());
        };
        if let Some(project) = user_config.find_project_mut(project_name) {
            project.effort_pin = Some(level);
            config::save_user_config_to(&user_config, &config_path)?;
        }
        Ok(())
    })
    .map_err(|e: anyhow::Error| e.to_string())
}

fn set_effort_pin_in(
    data_dir: &std::path::Path,
    project_name: &str,
    level: &str,
) -> Result<(), String> {
    if !speedwave_runtime::defaults::EFFORT_LEVELS.contains(&level) {
        return Err(format!("unknown effort level: {level}"));
    }
    config::with_config_lock_in(data_dir, || {
        let config_path = data_dir.join("config.json");
        let mut user_config = config::load_user_config_from(&config_path)?;
        let project = user_config
            .find_project_mut(project_name)
            .ok_or_else(|| anyhow::anyhow!("project '{project_name}' not found in config"))?;
        project.effort_pin = Some(level.to_string());
        config::save_user_config_to(&user_config, &config_path)
    })
    .map_err(|e: anyhow::Error| e.to_string())
}

#[tauri::command]
pub(crate) fn get_effort_pin(project_id: String) -> Result<Option<String>, String> {
    let project_name = resolve_project_name(&project_id)?;
    let data_dir = speedwave_runtime::consts::data_dir();
    ensure_effort_pin_migrated_in(data_dir, &project_name)?;
    let user_config = config::load_user_config().map_err(|e| e.to_string())?;
    Ok(user_config
        .find_project(&project_name)
        .and_then(|p| p.effort_pin.clone()))
}

#[tauri::command]
pub(crate) fn set_effort_pin(project_id: String, level: String) -> Result<(), String> {
    let project_name = resolve_project_name(&project_id)?;
    set_effort_pin_in(speedwave_runtime::consts::data_dir(), &project_name, &level)
}

#[tauri::command]
pub(crate) fn get_model_hint(project_id: String) -> Result<Option<String>, String> {
    let project_name = resolve_project_name(&project_id)?;
    Ok(get_model_hint_in(
        speedwave_runtime::consts::data_dir(),
        &project_name,
    ))
}

fn get_model_hint_in(data_dir: &Path, project: &str) -> Option<String> {
    let pin = crate::claude_settings::get_model_pin(data_dir, project)
        .map(|pin| speedwave_runtime::defaults::resolve_model_alias(&pin))
        .filter(|model| model.starts_with("claude-"));
    pin.or_else(|| {
        crate::history::last_session_model_impl(data_dir, project, |m| m.starts_with("claude-"))
    })
}

fn picker_wire_ids(session_arc: &SharedChatSession, project_name: &str) -> Vec<String> {
    config::load_user_config()
        .map_err(|e| e.to_string())
        .and_then(|cfg| crate::model_picker::picker_for(&cfg, session_arc, project_name))
        .ok()
        .flatten()
        .map(|picker| picker.rows.into_iter().map(|r| r.wire_id).collect())
        .unwrap_or_default()
}

fn set_model_pin_inner(
    project_id: &str,
    model: &str,
    session_arc: &SharedChatSession,
) -> Result<(), String> {
    let project_name = resolve_project_name(project_id)?;
    crate::claude_settings::set_model_pin(
        speedwave_runtime::consts::data_dir(),
        &project_name,
        model,
        &picker_wire_ids(session_arc, &project_name),
    )
}

#[tauri::command]
pub(crate) fn set_model_pin(
    project_id: String,
    model: String,
    state: tauri::State<'_, SharedChatSession>,
) -> Result<(), String> {
    set_model_pin_inner(&project_id, &model, state.inner())
}

#[tauri::command]
pub(crate) fn clear_model_pin(project_id: String) -> Result<(), String> {
    let project_name = resolve_project_name(&project_id)?;
    crate::claude_settings::clear_model_pin(speedwave_runtime::consts::data_dir(), &project_name)
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "test assertions use unwrap/expect"
)]
mod tests {
    use super::*;

    fn write_model_pin(data_dir: &Path, project: &str, model: &str) {
        let dir =
            speedwave_runtime::claude_home::claude_home_dir(data_dir, project).join(".claude");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("settings.json"),
            format!(r#"{{"model":"{model}"}}"#),
        )
        .unwrap();
    }

    fn write_transcript_session(data_dir: &Path, project: &str, model: &str) {
        let dir = crate::history::sessions_dir_impl(data_dir, project);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("s1.jsonl"),
            format!(r#"{{"type":"system","subtype":"init","model":"{model}"}}"#),
        )
        .unwrap();
    }

    fn user_config_with_project(data_dir: &std::path::Path, name: &str) {
        let user_config = config::SpeedwaveUserConfig {
            projects: vec![config::ProjectUserEntry {
                name: name.to_string(),
                dir: "/tmp/proj".to_string(),
                claude: None,
                integrations: None,
                plugin_settings: None,
                policy: None,
                effort_pin: None,
            }],
            ..Default::default()
        };
        config::save_user_config_to(&user_config, &data_dir.join("config.json")).unwrap();
    }

    #[test]
    fn get_effort_pin_rejects_invalid_project() {
        let res = get_effort_pin(String::new());
        assert!(res.is_err());
    }

    #[test]
    fn set_effort_pin_rejects_invalid_project() {
        let res = set_effort_pin(String::new(), "low".to_string());
        assert!(res.is_err());
    }

    #[test]
    fn get_model_hint_rejects_invalid_project() {
        let res = get_model_hint(String::new());
        assert!(res.is_err());
    }

    #[test]
    fn model_hint_claude_filter_covers_every_catalog_id() {
        for m in speedwave_runtime::defaults::ANTHROPIC_MODELS {
            assert!(
                m.id.starts_with("claude-"),
                "get_model_hint's claude- filter would drop catalog id {}",
                m.id
            );
        }
    }

    #[test]
    fn resolve_project_name_rejects_invalid_project() {
        let res = resolve_project_name("../escape");
        assert!(res.is_err());
    }

    #[test]
    fn get_and_set_effort_pin_share_the_same_resolution_error_for_an_invalid_project() {
        let get_err = get_effort_pin(String::new()).unwrap_err();
        let set_err = set_effort_pin(String::new(), "low".to_string()).unwrap_err();
        assert_eq!(get_err, set_err);
        assert_eq!(get_err, resolve_project_name("").unwrap_err());
    }

    fn no_session() -> SharedChatSession {
        std::sync::Arc::new(std::sync::Mutex::new(crate::chat::ChatSession::new("proj")))
    }

    #[test]
    fn set_model_pin_rejects_invalid_project() {
        let res = set_model_pin_inner("", "claude-sonnet-5", &no_session());
        assert!(res.is_err());
    }

    #[test]
    fn clear_model_pin_rejects_invalid_project() {
        assert_eq!(
            clear_model_pin(String::new()).unwrap_err(),
            resolve_project_name("").unwrap_err()
        );
        assert!(clear_model_pin("../escape".to_string()).is_err());
    }

    #[test]
    fn set_model_pin_shares_the_same_resolution_error_as_the_effort_commands() {
        let model_err = set_model_pin_inner("", "claude-sonnet-5", &no_session()).unwrap_err();
        let effort_err = set_effort_pin(String::new(), "low".to_string()).unwrap_err();
        assert_eq!(model_err, effort_err);
        assert_eq!(model_err, resolve_project_name("").unwrap_err());
    }

    #[test]
    fn get_model_hint_in_prefers_the_pin_over_transcript_history() {
        let tmp = tempfile::tempdir().unwrap();
        write_model_pin(tmp.path(), "proj", "claude-sonnet-5");
        write_transcript_session(tmp.path(), "proj", "claude-opus-4-8");
        assert_eq!(
            get_model_hint_in(tmp.path(), "proj"),
            Some("claude-sonnet-5".to_string())
        );
    }

    #[test]
    fn get_model_hint_in_resolves_an_alias_pin_to_its_latest_catalog_id() {
        let tmp = tempfile::tempdir().unwrap();
        write_model_pin(tmp.path(), "proj", "fable[1m]");
        assert_eq!(
            get_model_hint_in(tmp.path(), "proj"),
            Some("claude-fable-5-1[1m]".to_string())
        );
    }

    #[test]
    fn set_effort_pin_in_round_trips_every_level() {
        let tmp = tempfile::tempdir().unwrap();
        user_config_with_project(tmp.path(), "proj");
        for level in speedwave_runtime::defaults::EFFORT_LEVELS {
            set_effort_pin_in(tmp.path(), "proj", level).unwrap();
            let cfg = config::load_user_config_from(&tmp.path().join("config.json")).unwrap();
            assert_eq!(
                cfg.find_project("proj").unwrap().effort_pin.as_deref(),
                Some(*level)
            );
        }
    }

    #[test]
    fn set_effort_pin_in_rejects_unknown_level() {
        let tmp = tempfile::tempdir().unwrap();
        user_config_with_project(tmp.path(), "proj");
        let err = set_effort_pin_in(tmp.path(), "proj", "ultra").unwrap_err();
        assert!(err.contains("unknown effort level"));
    }

    #[test]
    fn set_effort_pin_in_unknown_project_errors() {
        let tmp = tempfile::tempdir().unwrap();
        user_config_with_project(tmp.path(), "proj");
        let err = set_effort_pin_in(tmp.path(), "ghost", "low").unwrap_err();
        assert!(err.contains("ghost"));
    }

    #[test]
    fn set_effort_pin_in_preserves_other_project_fields() {
        let tmp = tempfile::tempdir().unwrap();
        let user_config = config::SpeedwaveUserConfig {
            projects: vec![config::ProjectUserEntry {
                name: "proj".to_string(),
                dir: "/tmp/proj".to_string(),
                claude: Some(config::ClaudeOverrides {
                    env: None,
                    settings: None,
                    llm: None,
                }),
                integrations: None,
                plugin_settings: None,
                policy: None,
                effort_pin: None,
            }],
            active_project: Some("proj".to_string()),
            ..Default::default()
        };
        let config_path = tmp.path().join("config.json");
        config::save_user_config_to(&user_config, &config_path).unwrap();

        set_effort_pin_in(tmp.path(), "proj", "xhigh").unwrap();

        let cfg = config::load_user_config_from(&config_path).unwrap();
        let project = cfg.find_project("proj").unwrap();
        assert_eq!(project.effort_pin.as_deref(), Some("xhigh"));
        assert_eq!(project.dir, "/tmp/proj");
        assert!(project.claude.is_some());
        assert_eq!(cfg.active_project.as_deref(), Some("proj"));
    }

    #[test]
    fn set_effort_pin_in_concurrent_writers_serialize_without_lost_update() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().to_path_buf();
        user_config_with_project(&data_dir, "proj");

        let iterations = 30;
        let d1 = data_dir.clone();
        let d2 = data_dir.clone();
        let t1 = std::thread::spawn(move || {
            for _ in 0..iterations {
                set_effort_pin_in(&d1, "proj", "low").unwrap();
            }
        });
        let t2 = std::thread::spawn(move || {
            for _ in 0..iterations {
                set_effort_pin_in(&d2, "proj", "high").unwrap();
            }
        });
        t1.join().unwrap();
        t2.join().unwrap();

        let cfg =
            config::load_user_config_from(&data_dir.join("config.json")).expect("valid, not torn");
        let effort = cfg
            .find_project("proj")
            .unwrap()
            .effort_pin
            .clone()
            .unwrap();
        assert!(effort == "low" || effort == "high", "unexpected: {effort}");
    }

    #[test]
    fn ensure_effort_pin_migrated_in_takes_over_legacy_effort_level_and_removes_the_key() {
        let tmp = tempfile::tempdir().unwrap();
        user_config_with_project(tmp.path(), "proj");
        let settings_path = speedwave_runtime::claude_home::claude_home_dir(tmp.path(), "proj")
            .join(".claude")
            .join("settings.json");
        std::fs::create_dir_all(settings_path.parent().unwrap()).unwrap();
        std::fs::write(&settings_path, r#"{"effortLevel":"xhigh"}"#).unwrap();

        ensure_effort_pin_migrated_in(tmp.path(), "proj").unwrap();

        let cfg = config::load_user_config_from(&tmp.path().join("config.json")).unwrap();
        assert_eq!(
            cfg.find_project("proj").unwrap().effort_pin.as_deref(),
            Some("xhigh")
        );
        let raw = std::fs::read_to_string(&settings_path).unwrap();
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert!(value.get("effortLevel").is_none());
    }

    fn user_config_with_pinned_project(data_dir: &Path, name: &str, pin: &str) {
        user_config_with_project(data_dir, name);
        set_effort_pin_in(data_dir, name, pin).unwrap();
    }

    #[test]
    fn ensure_effort_pin_migrated_in_removes_the_legacy_key_and_keeps_an_existing_pin() {
        let tmp = tempfile::tempdir().unwrap();
        user_config_with_pinned_project(tmp.path(), "proj", "low");
        let settings_path = write_settings(
            tmp.path(),
            "proj",
            r#"{"effortLevel":"high","model":"claude-sonnet-5","hooks":{"PreToolUse":[]}}"#,
        );

        ensure_effort_pin_migrated_in(tmp.path(), "proj").unwrap();

        let cfg = config::load_user_config_from(&tmp.path().join("config.json")).unwrap();
        assert_eq!(
            cfg.find_project("proj").unwrap().effort_pin.as_deref(),
            Some("low"),
            "an existing pin outranks the legacy file"
        );
        let value: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&settings_path).unwrap()).unwrap();
        assert_eq!(
            value,
            serde_json::json!({"model":"claude-sonnet-5","hooks":{"PreToolUse":[]}}),
            "the legacy key is removed and every other key survives"
        );
    }

    #[test]
    fn ensure_effort_pin_migrated_in_with_a_pin_removes_every_legacy_value_shape() {
        for legacy in [r#""xhigh""#, r#""max""#, r#""bogus""#, r#""""#, "5", "null"] {
            let tmp = tempfile::tempdir().unwrap();
            user_config_with_pinned_project(tmp.path(), "proj", "low");
            let settings_path = write_settings(
                tmp.path(),
                "proj",
                &format!(r#"{{"effortLevel":{legacy}}}"#),
            );

            ensure_effort_pin_migrated_in(tmp.path(), "proj").unwrap();

            let cfg = config::load_user_config_from(&tmp.path().join("config.json")).unwrap();
            assert_eq!(
                cfg.find_project("proj").unwrap().effort_pin.as_deref(),
                Some("low"),
                "legacy value {legacy}"
            );
            let value: serde_json::Value =
                serde_json::from_str(&std::fs::read_to_string(&settings_path).unwrap()).unwrap();
            assert!(value.get("effortLevel").is_none(), "legacy value {legacy}");
        }
    }

    #[test]
    fn ensure_effort_pin_migrated_in_with_a_pin_leaves_a_file_without_the_key_untouched() {
        let tmp = tempfile::tempdir().unwrap();
        user_config_with_pinned_project(tmp.path(), "proj", "low");
        let settings_path = write_settings(tmp.path(), "proj", r#"{"model":"claude-sonnet-5"}"#);

        ensure_effort_pin_migrated_in(tmp.path(), "proj").unwrap();

        assert_eq!(
            std::fs::read_to_string(&settings_path).unwrap(),
            r#"{"model":"claude-sonnet-5"}"#
        );
    }

    #[test]
    fn ensure_effort_pin_migrated_in_with_a_pin_skips_a_malformed_settings_file_without_failing() {
        let tmp = tempfile::tempdir().unwrap();
        user_config_with_pinned_project(tmp.path(), "proj", "low");
        let settings_path = write_settings(tmp.path(), "proj", "not json");

        ensure_effort_pin_migrated_in(tmp.path(), "proj").unwrap();

        let cfg = config::load_user_config_from(&tmp.path().join("config.json")).unwrap();
        assert_eq!(
            cfg.find_project("proj").unwrap().effort_pin.as_deref(),
            Some("low")
        );
        assert_eq!(std::fs::read_to_string(&settings_path).unwrap(), "not json");
    }

    #[test]
    fn get_model_hint_in_shows_an_unrecognized_claude_pin_verbatim_never_default() {
        let tmp = tempfile::tempdir().unwrap();
        write_model_pin(tmp.path(), "proj", "claude-mystery-9");
        assert_eq!(
            get_model_hint_in(tmp.path(), "proj"),
            Some("claude-mystery-9".to_string())
        );
    }

    #[test]
    fn get_model_hint_in_skips_a_foreign_pin_and_falls_back_to_transcript_history() {
        let tmp = tempfile::tempdir().unwrap();
        write_model_pin(tmp.path(), "proj", "llama3.3");
        write_transcript_session(tmp.path(), "proj", "claude-opus-4-8");
        assert_eq!(
            get_model_hint_in(tmp.path(), "proj"),
            Some("claude-opus-4-8".to_string())
        );
    }

    #[test]
    fn get_model_hint_in_returns_none_for_a_foreign_pin_without_history() {
        let tmp = tempfile::tempdir().unwrap();
        write_model_pin(tmp.path(), "proj", "llama3.3");
        assert_eq!(get_model_hint_in(tmp.path(), "proj"), None);
    }

    fn write_settings(data_dir: &Path, project: &str, contents: &str) -> std::path::PathBuf {
        let path = speedwave_runtime::claude_home::claude_home_dir(data_dir, project)
            .join(".claude")
            .join("settings.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, contents).unwrap();
        path
    }

    #[test]
    fn ensure_effort_pin_migrated_in_skips_a_malformed_settings_file_without_failing() {
        let tmp = tempfile::tempdir().unwrap();
        user_config_with_project(tmp.path(), "proj");
        let settings_path = write_settings(tmp.path(), "proj", "not json");

        ensure_effort_pin_migrated_in(tmp.path(), "proj").unwrap();

        let cfg = config::load_user_config_from(&tmp.path().join("config.json")).unwrap();
        assert_eq!(cfg.find_project("proj").unwrap().effort_pin, None);
        assert_eq!(std::fs::read_to_string(&settings_path).unwrap(), "not json");
    }

    #[test]
    fn ensure_effort_pin_migrated_in_keeps_the_legacy_key_for_an_unregistered_project() {
        let tmp = tempfile::tempdir().unwrap();
        user_config_with_project(tmp.path(), "proj");
        let settings_path = write_settings(tmp.path(), "ghost", r#"{"effortLevel":"xhigh"}"#);

        ensure_effort_pin_migrated_in(tmp.path(), "ghost").unwrap();

        assert_eq!(
            std::fs::read_to_string(&settings_path).unwrap(),
            r#"{"effortLevel":"xhigh"}"#,
            "the legacy value must survive until the project is registered"
        );
        let cfg = config::load_user_config_from(&tmp.path().join("config.json")).unwrap();
        assert!(cfg.find_project("ghost").is_none());
    }

    #[test]
    fn ensure_effort_pin_migrated_in_is_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        user_config_with_project(tmp.path(), "proj");
        let settings_path = speedwave_runtime::claude_home::claude_home_dir(tmp.path(), "proj")
            .join(".claude")
            .join("settings.json");
        std::fs::create_dir_all(settings_path.parent().unwrap()).unwrap();
        std::fs::write(&settings_path, r#"{"effortLevel":"low"}"#).unwrap();

        ensure_effort_pin_migrated_in(tmp.path(), "proj").unwrap();
        ensure_effort_pin_migrated_in(tmp.path(), "proj").unwrap();

        let cfg = config::load_user_config_from(&tmp.path().join("config.json")).unwrap();
        assert_eq!(
            cfg.find_project("proj").unwrap().effort_pin.as_deref(),
            Some("low")
        );
    }

    #[test]
    fn get_model_hint_in_falls_back_to_transcript_history_without_a_pin() {
        let tmp = tempfile::tempdir().unwrap();
        write_transcript_session(tmp.path(), "proj", "claude-opus-4-8");
        assert_eq!(
            get_model_hint_in(tmp.path(), "proj"),
            Some("claude-opus-4-8".to_string())
        );
    }

    #[test]
    fn get_model_hint_in_ignores_a_foreign_provider_transcript_without_a_pin() {
        let tmp = tempfile::tempdir().unwrap();
        write_transcript_session(tmp.path(), "proj", "gpt-4o-mini");
        assert_eq!(get_model_hint_in(tmp.path(), "proj"), None);
    }

    #[test]
    fn get_model_hint_in_returns_none_without_a_pin_or_history() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(get_model_hint_in(tmp.path(), "proj"), None);
    }

    #[test]
    fn ensure_effort_pin_migrated_in_no_legacy_key_is_a_noop() {
        let tmp = tempfile::tempdir().unwrap();
        user_config_with_project(tmp.path(), "proj");
        ensure_effort_pin_migrated_in(tmp.path(), "proj").unwrap();
        let cfg = config::load_user_config_from(&tmp.path().join("config.json")).unwrap();
        assert_eq!(cfg.find_project("proj").unwrap().effort_pin, None);
    }
}
