use std::path::Path;

use crate::chat_registry::SharedChatSessions;
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

pub(crate) fn ensure_model_pin_migrated_in(
    data_dir: &std::path::Path,
    project_name: &str,
) -> Result<(), String> {
    config::with_config_lock_in(data_dir, || {
        let config_path = data_dir.join("config.json");
        let mut user_config = config::load_user_config_from(&config_path)?;
        if user_config.find_project(project_name).is_none() {
            return Ok(());
        }
        let legacy = match crate::claude_settings::take_legacy_model_pin(data_dir, project_name) {
            Ok(legacy) => legacy,
            Err(e) => {
                log::warn!("legacy model pin migration skipped for {project_name}: {e}");
                return Ok(());
            }
        };
        let Some(project) = user_config.find_project_mut(project_name) else {
            return Ok(());
        };
        if project.model_pin_migrated {
            return Ok(());
        }
        if project.model_pin.is_none() {
            project.model_pin = legacy.filter(|m| is_adoptable_legacy_model_pin(m));
        }
        project.model_pin_migrated = true;
        config::save_user_config_to(&user_config, &config_path)?;
        Ok(())
    })
    .map_err(|e: anyhow::Error| e.to_string())
}

fn is_adoptable_legacy_model_pin(model: &str) -> bool {
    if crate::chat::validate_launch_model(model).is_err() {
        return false;
    }
    let base = model
        .strip_suffix(speedwave_runtime::defaults::ONE_MILLION_SUFFIX)
        .unwrap_or(model);
    base != "default"
}

fn set_model_pin_in(
    data_dir: &std::path::Path,
    project_name: &str,
    model: &str,
    listed_by_claude_code: &[String],
) -> Result<(), String> {
    let listed = model.starts_with("claude-") && listed_by_claude_code.iter().any(|m| m == model);
    if !listed && !speedwave_runtime::defaults::is_selectable_anthropic_model_id(model) {
        return Err(format!("unknown Anthropic model: {model}"));
    }
    crate::chat::validate_launch_model(model)?;
    edit_model_pin_in(data_dir, project_name, |pin| {
        *pin = Some(model.to_string());
    })
}

fn edit_model_pin_in(
    data_dir: &std::path::Path,
    project_name: &str,
    edit: impl FnOnce(&mut Option<String>),
) -> Result<(), String> {
    config::with_config_lock_in(data_dir, || {
        let config_path = data_dir.join("config.json");
        let mut user_config = config::load_user_config_from(&config_path)?;
        let project = user_config
            .find_project_mut(project_name)
            .ok_or_else(|| anyhow::anyhow!("project '{project_name}' not found in config"))?;
        edit(&mut project.model_pin);
        config::save_user_config_to(&user_config, &config_path)
    })
    .map_err(|e: anyhow::Error| e.to_string())
}

pub(crate) fn normalize_model_pin_in(
    data_dir: &std::path::Path,
    project_name: &str,
    normalized: impl FnOnce(&str) -> Option<String>,
) -> Result<Option<String>, String> {
    config::with_config_lock_in(data_dir, || {
        let config_path = data_dir.join("config.json");
        let mut user_config = config::load_user_config_from(&config_path)?;
        let Some(project) = user_config.find_project_mut(project_name) else {
            return Ok(None);
        };
        let Some(next) = project.model_pin.as_deref().and_then(normalized) else {
            return Ok(None);
        };
        project.model_pin = Some(next.clone());
        config::save_user_config_to(&user_config, &config_path)?;
        Ok(Some(next))
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
    let data_dir = speedwave_runtime::consts::data_dir();
    ensure_model_pin_migrated_in(data_dir, &project_name)?;
    Ok(get_model_hint_in(data_dir, &project_name))
}

fn get_model_hint_in(data_dir: &Path, project: &str) -> Option<String> {
    let pin = get_model_pin_in(data_dir, project)
        .map(|pin| speedwave_runtime::defaults::resolve_model_alias(&pin))
        .filter(|model| model.starts_with("claude-"));
    pin.or_else(|| {
        crate::history::last_session_model_impl(data_dir, project, |m| m.starts_with("claude-"))
    })
}

fn get_model_pin_in(data_dir: &Path, project: &str) -> Option<String> {
    config::load_user_config_from(&data_dir.join("config.json"))
        .ok()
        .and_then(|cfg| cfg.find_project(project).and_then(|p| p.model_pin.clone()))
}

#[tauri::command]
pub(crate) fn get_model_pin(project_id: String) -> Result<Option<String>, String> {
    let project_name = resolve_project_name(&project_id)?;
    let data_dir = speedwave_runtime::consts::data_dir();
    ensure_model_pin_migrated_in(data_dir, &project_name)?;
    Ok(get_model_pin_in(data_dir, &project_name))
}

fn picker_wire_ids(registry: &SharedChatSessions, project_name: &str) -> Vec<String> {
    config::load_user_config()
        .map_err(|e| e.to_string())
        .and_then(|cfg| crate::model_picker::picker_for(&cfg, registry, project_name))
        .ok()
        .flatten()
        .map(|picker| picker.rows.into_iter().map(|r| r.wire_id).collect())
        .unwrap_or_default()
}

fn set_model_pin_inner(
    project_id: &str,
    model: &str,
    registry: &SharedChatSessions,
) -> Result<(), String> {
    let project_name = resolve_project_name(project_id)?;
    let data_dir = speedwave_runtime::consts::data_dir();
    ensure_model_pin_migrated_in(data_dir, &project_name)?;
    set_model_pin_in(
        data_dir,
        &project_name,
        model,
        &picker_wire_ids(registry, &project_name),
    )
}

#[tauri::command]
pub(crate) fn set_model_pin(
    project_id: String,
    model: String,
    state: tauri::State<'_, SharedChatSessions>,
) -> Result<(), String> {
    set_model_pin_inner(&project_id, &model, state.inner())
}

#[tauri::command]
pub(crate) fn clear_model_pin(project_id: String) -> Result<(), String> {
    let project_name = resolve_project_name(&project_id)?;
    let data_dir = speedwave_runtime::consts::data_dir();
    ensure_model_pin_migrated_in(data_dir, &project_name)?;
    edit_model_pin_in(data_dir, &project_name, |pin| {
        *pin = None;
    })
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "test assertions use unwrap/expect"
)]
mod tests {
    use super::*;

    fn write_legacy_model_pin(data_dir: &Path, project: &str, model: &str) {
        let dir =
            speedwave_runtime::claude_home::claude_home_dir(data_dir, project).join(".claude");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("settings.json"),
            format!(r#"{{"model":"{model}"}}"#),
        )
        .unwrap();
    }

    fn write_config_model_pin(data_dir: &Path, name: &str, pin: &str) {
        let path = data_dir.join("config.json");
        let mut cfg = config::load_user_config_from(&path).unwrap();
        cfg.find_project_mut(name).unwrap().model_pin = Some(pin.to_string());
        config::save_user_config_to(&cfg, &path).unwrap();
    }

    fn config_model_pin(data_dir: &Path, name: &str) -> Option<String> {
        config::load_user_config_from(&data_dir.join("config.json"))
            .unwrap()
            .find_project(name)
            .and_then(|p| p.model_pin.clone())
    }

    fn settings_model_key(data_dir: &Path, project: &str) -> Option<serde_json::Value> {
        let path = speedwave_runtime::claude_home::claude_home_dir(data_dir, project)
            .join(".claude")
            .join("settings.json");
        let raw = std::fs::read_to_string(path).ok()?;
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        value.get("model").cloned()
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
                model_pin: None,
                model_pin_migrated: false,
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

    fn no_session() -> SharedChatSessions {
        crate::chat_registry::test_support::registry_with("proj").0
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
        user_config_with_project(tmp.path(), "proj");
        write_config_model_pin(tmp.path(), "proj", "claude-sonnet-5");
        write_transcript_session(tmp.path(), "proj", "claude-opus-4-8");
        assert_eq!(
            get_model_hint_in(tmp.path(), "proj"),
            Some("claude-sonnet-5".to_string())
        );
    }

    #[test]
    fn get_model_hint_in_resolves_an_alias_pin_to_its_latest_catalog_id() {
        let tmp = tempfile::tempdir().unwrap();
        user_config_with_project(tmp.path(), "proj");
        write_config_model_pin(tmp.path(), "proj", "fable[1m]");
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
                model_pin: None,
                model_pin_migrated: false,
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
        user_config_with_project(tmp.path(), "proj");
        write_config_model_pin(tmp.path(), "proj", "claude-mystery-9");
        assert_eq!(
            get_model_hint_in(tmp.path(), "proj"),
            Some("claude-mystery-9".to_string())
        );
    }

    #[test]
    fn get_model_hint_in_skips_a_foreign_pin_and_falls_back_to_transcript_history() {
        let tmp = tempfile::tempdir().unwrap();
        user_config_with_project(tmp.path(), "proj");
        write_config_model_pin(tmp.path(), "proj", "llama3.3");
        write_transcript_session(tmp.path(), "proj", "claude-opus-4-8");
        assert_eq!(
            get_model_hint_in(tmp.path(), "proj"),
            Some("claude-opus-4-8".to_string())
        );
    }

    #[test]
    fn get_model_hint_in_returns_none_for_a_foreign_pin_without_history() {
        let tmp = tempfile::tempdir().unwrap();
        user_config_with_project(tmp.path(), "proj");
        write_config_model_pin(tmp.path(), "proj", "llama3.3");
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

    #[test]
    fn ensure_model_pin_migrated_in_adopts_the_legacy_settings_model_once() {
        let tmp = tempfile::tempdir().unwrap();
        user_config_with_project(tmp.path(), "proj");
        write_legacy_model_pin(tmp.path(), "proj", "claude-sonnet-5[1m]");

        ensure_model_pin_migrated_in(tmp.path(), "proj").unwrap();

        assert_eq!(
            config_model_pin(tmp.path(), "proj").as_deref(),
            Some("claude-sonnet-5[1m]")
        );
        assert_eq!(settings_model_key(tmp.path(), "proj"), None);
    }

    #[test]
    fn ensure_model_pin_migrated_in_strips_but_never_re_adopts_after_the_first_run() {
        let tmp = tempfile::tempdir().unwrap();
        user_config_with_project(tmp.path(), "proj");
        ensure_model_pin_migrated_in(tmp.path(), "proj").unwrap();
        assert_eq!(config_model_pin(tmp.path(), "proj"), None);

        write_legacy_model_pin(tmp.path(), "proj", "claude-opus-4-8");
        ensure_model_pin_migrated_in(tmp.path(), "proj").unwrap();

        assert_eq!(
            config_model_pin(tmp.path(), "proj"),
            None,
            "a Claude-Code-written model key is session scrap, never a new default"
        );
        assert_eq!(
            settings_model_key(tmp.path(), "proj"),
            None,
            "the stray key is still stripped"
        );
    }

    #[test]
    fn ensure_model_pin_migrated_in_keeps_an_existing_config_pin() {
        let tmp = tempfile::tempdir().unwrap();
        user_config_with_project(tmp.path(), "proj");
        write_config_model_pin(tmp.path(), "proj", "claude-haiku-4-5");
        write_legacy_model_pin(tmp.path(), "proj", "claude-opus-4-8");

        ensure_model_pin_migrated_in(tmp.path(), "proj").unwrap();

        assert_eq!(
            config_model_pin(tmp.path(), "proj").as_deref(),
            Some("claude-haiku-4-5")
        );
        assert_eq!(settings_model_key(tmp.path(), "proj"), None);
    }

    #[test]
    fn ensure_model_pin_migrated_in_never_adopts_a_foreign_or_default_value() {
        for legacy in ["llama3.3", "local/qwen3", "default", "gpt-4o"] {
            let tmp = tempfile::tempdir().unwrap();
            user_config_with_project(tmp.path(), "proj");
            write_legacy_model_pin(tmp.path(), "proj", legacy);

            ensure_model_pin_migrated_in(tmp.path(), "proj").unwrap();

            assert_eq!(
                config_model_pin(tmp.path(), "proj"),
                None,
                "legacy value {legacy}"
            );
            assert_eq!(
                settings_model_key(tmp.path(), "proj"),
                None,
                "legacy value {legacy} is still stripped"
            );
        }
    }

    #[test]
    fn ensure_model_pin_migrated_in_adopts_a_listed_claude_id_and_a_bare_alias() {
        for legacy in ["claude-mystery-9", "opus", "fable[1m]"] {
            let tmp = tempfile::tempdir().unwrap();
            user_config_with_project(tmp.path(), "proj");
            write_legacy_model_pin(tmp.path(), "proj", legacy);

            ensure_model_pin_migrated_in(tmp.path(), "proj").unwrap();

            assert_eq!(
                config_model_pin(tmp.path(), "proj").as_deref(),
                Some(legacy),
                "legacy value {legacy}"
            );
        }
    }

    #[test]
    fn ensure_model_pin_migrated_in_skips_a_malformed_settings_file_and_retries_later() {
        let tmp = tempfile::tempdir().unwrap();
        user_config_with_project(tmp.path(), "proj");
        let dir =
            speedwave_runtime::claude_home::claude_home_dir(tmp.path(), "proj").join(".claude");
        std::fs::create_dir_all(&dir).unwrap();
        let settings = dir.join("settings.json");
        std::fs::write(&settings, "not json").unwrap();

        ensure_model_pin_migrated_in(tmp.path(), "proj").unwrap();
        assert_eq!(config_model_pin(tmp.path(), "proj"), None);

        std::fs::write(&settings, r#"{"model":"claude-sonnet-5"}"#).unwrap();
        ensure_model_pin_migrated_in(tmp.path(), "proj").unwrap();
        assert_eq!(
            config_model_pin(tmp.path(), "proj").as_deref(),
            Some("claude-sonnet-5"),
            "a skipped run must not consume the one-shot marker"
        );
    }

    #[test]
    fn ensure_model_pin_migrated_in_leaves_an_unregistered_project_alone() {
        let tmp = tempfile::tempdir().unwrap();
        user_config_with_project(tmp.path(), "proj");
        write_legacy_model_pin(tmp.path(), "ghost", "claude-sonnet-5");

        ensure_model_pin_migrated_in(tmp.path(), "ghost").unwrap();

        assert_eq!(
            settings_model_key(tmp.path(), "ghost"),
            Some(serde_json::json!("claude-sonnet-5")),
            "the legacy value must survive until the project is registered"
        );
    }

    #[test]
    fn set_model_pin_in_round_trips_and_validates() {
        let tmp = tempfile::tempdir().unwrap();
        user_config_with_project(tmp.path(), "proj");

        set_model_pin_in(tmp.path(), "proj", "claude-sonnet-5[1m]", &[]).unwrap();
        assert_eq!(
            config_model_pin(tmp.path(), "proj").as_deref(),
            Some("claude-sonnet-5[1m]")
        );

        set_model_pin_in(tmp.path(), "proj", "claude-opus-4-8", &[]).unwrap();
        assert_eq!(
            config_model_pin(tmp.path(), "proj").as_deref(),
            Some("claude-opus-4-8")
        );
    }

    #[test]
    fn set_model_pin_in_accepts_a_claude_id_the_live_session_lists() {
        let tmp = tempfile::tempdir().unwrap();
        user_config_with_project(tmp.path(), "proj");
        let listed = vec!["claude-opus-9[1m]".to_string(), "opus".to_string()];
        set_model_pin_in(tmp.path(), "proj", "claude-opus-9[1m]", &listed).unwrap();
        assert_eq!(
            config_model_pin(tmp.path(), "proj").as_deref(),
            Some("claude-opus-9[1m]")
        );
    }

    #[test]
    fn set_model_pin_in_rejects_foreign_unlisted_and_unpriced_ids() {
        let tmp = tempfile::tempdir().unwrap();
        user_config_with_project(tmp.path(), "proj");
        let listed = vec!["opus".to_string(), "local/qwen3".to_string()];
        for bad in [
            "gpt-4o",
            "openrouter/anthropic/claude-sonnet-5",
            "",
            "opus",
            "local/qwen3",
            "claude-opus-9",
            "claude-haiku-4-5[1m]",
        ] {
            let err = set_model_pin_in(tmp.path(), "proj", bad, &listed).unwrap_err();
            assert!(err.contains("unknown Anthropic model"), "id: {bad}");
        }
        assert_eq!(config_model_pin(tmp.path(), "proj"), None);
    }

    #[test]
    fn set_model_pin_in_unknown_project_errors() {
        let tmp = tempfile::tempdir().unwrap();
        user_config_with_project(tmp.path(), "proj");
        let err = set_model_pin_in(tmp.path(), "ghost", "claude-sonnet-5", &[]).unwrap_err();
        assert!(err.contains("ghost"));
    }

    #[test]
    fn edit_model_pin_in_clears_the_pin_and_preserves_other_fields() {
        let tmp = tempfile::tempdir().unwrap();
        user_config_with_project(tmp.path(), "proj");
        set_effort_pin_in(tmp.path(), "proj", "high").unwrap();
        write_config_model_pin(tmp.path(), "proj", "claude-sonnet-5");

        edit_model_pin_in(tmp.path(), "proj", |pin| {
            *pin = None;
        })
        .unwrap();

        let cfg = config::load_user_config_from(&tmp.path().join("config.json")).unwrap();
        let project = cfg.find_project("proj").unwrap();
        assert_eq!(project.model_pin, None);
        assert_eq!(project.effort_pin.as_deref(), Some("high"));
        assert_eq!(project.dir, "/tmp/proj");
    }

    #[test]
    fn normalize_model_pin_in_rewrites_only_when_the_closure_changes_it() {
        let tmp = tempfile::tempdir().unwrap();
        user_config_with_project(tmp.path(), "proj");
        write_config_model_pin(tmp.path(), "proj", "claude-sonnet-5");

        let rewritten = normalize_model_pin_in(tmp.path(), "proj", |pin| {
            assert_eq!(pin, "claude-sonnet-5");
            Some("claude-sonnet-5[1m]".to_string())
        })
        .unwrap();
        assert_eq!(rewritten.as_deref(), Some("claude-sonnet-5[1m]"));
        assert_eq!(
            config_model_pin(tmp.path(), "proj").as_deref(),
            Some("claude-sonnet-5[1m]")
        );

        assert_eq!(
            normalize_model_pin_in(tmp.path(), "proj", |_| None).unwrap(),
            None
        );
        assert_eq!(
            config_model_pin(tmp.path(), "proj").as_deref(),
            Some("claude-sonnet-5[1m]")
        );
    }

    #[test]
    fn normalize_model_pin_in_never_asks_about_a_missing_pin_or_project() {
        let tmp = tempfile::tempdir().unwrap();
        user_config_with_project(tmp.path(), "proj");
        let never = |_: &str| -> Option<String> { panic!("no pin to normalize") };
        assert_eq!(
            normalize_model_pin_in(tmp.path(), "proj", never).unwrap(),
            None
        );
        let never = |_: &str| -> Option<String> { panic!("unknown project has no pin") };
        assert_eq!(
            normalize_model_pin_in(tmp.path(), "ghost", never).unwrap(),
            None
        );
    }

    #[test]
    fn set_model_pin_in_concurrent_writers_serialize_without_lost_update() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().to_path_buf();
        user_config_with_project(&data_dir, "proj");

        let iterations = 30;
        let d1 = data_dir.clone();
        let d2 = data_dir.clone();
        let t1 = std::thread::spawn(move || {
            for _ in 0..iterations {
                set_model_pin_in(&d1, "proj", "claude-sonnet-5", &[]).unwrap();
            }
        });
        let t2 = std::thread::spawn(move || {
            for _ in 0..iterations {
                set_model_pin_in(&d2, "proj", "claude-opus-4-8", &[]).unwrap();
            }
        });
        t1.join().unwrap();
        t2.join().unwrap();

        let pin = config_model_pin(&data_dir, "proj").unwrap();
        assert!(
            pin == "claude-sonnet-5" || pin == "claude-opus-4-8",
            "unexpected pin: {pin}"
        );
    }
}
