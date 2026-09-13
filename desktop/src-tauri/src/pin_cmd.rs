//! Tauri commands for the composer's effort pin and model hint.

use std::path::Path;

use crate::types::check_project;
use speedwave_runtime::config;

/// Resolves `project_id` to its persisted project name, or a frontend-facing error string.
fn resolve_project_name(project_id: &str) -> Result<String, String> {
    check_project(project_id)?;
    let user_config = config::load_user_config().map_err(|e| e.to_string())?;
    let project = user_config
        .require_project(project_id)
        .map_err(|e| e.to_string())?;
    Ok(project.name.clone())
}

/// One-time takeover of a legacy `effortLevel` into the project's config pin when it has
/// none; the key is removed from the file either way. Idempotent once a pin exists.
pub(crate) fn ensure_effort_pin_migrated_in(
    data_dir: &std::path::Path,
    project_name: &str,
) -> Result<(), String> {
    config::with_config_lock_in(data_dir, || {
        let config_path = data_dir.join("config.json");
        let mut user_config = config::load_user_config_from(&config_path)?;
        let already_pinned = user_config
            .find_project(project_name)
            .is_some_and(|p| p.effort_pin.is_some());
        if already_pinned {
            return Ok(());
        }
        let legacy = crate::claude_settings::take_legacy_effort_pin(data_dir, project_name)
            .map_err(|e| anyhow::anyhow!(e))?;
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

/// `data_dir`-parameterized effort pin write, under the config lock; rejects a
/// level outside `defaults::EFFORT_LEVELS`. Mirrors `containers_cmd::set_provider_model_in`.
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
pub(crate) fn list_effort_levels() -> Result<Vec<String>, String> {
    Ok(speedwave_runtime::defaults::EFFORT_LEVELS
        .iter()
        .map(|s| s.to_string())
        .collect())
}

/// Pre-session badge hint: the settings `model` pin first (CC aliases resolved, unknown
/// values verbatim), else the newest `claude-*` transcript model (foreign ids never leak).
#[tauri::command]
pub(crate) fn get_model_hint(project_id: String) -> Result<Option<String>, String> {
    let project_name = resolve_project_name(&project_id)?;
    Ok(get_model_hint_in(
        speedwave_runtime::consts::data_dir(),
        &project_name,
    ))
}

/// Testable core of [`get_model_hint`]: explicit `data_dir` so the source order can be
/// unit-tested against a tempdir.
fn get_model_hint_in(data_dir: &Path, project: &str) -> Option<String> {
    if let Some(pin) = crate::claude_settings::get_model_pin(data_dir, project) {
        return Some(speedwave_runtime::defaults::resolve_model_alias(&pin));
    }
    crate::history::last_session_model_impl(data_dir, project, |m| m.starts_with("claude-"))
}

/// Persists an Anthropic model pick as the settings.json `model` key for the next spawn;
/// routed (local/OpenRouter) picks never call this.
#[tauri::command]
pub(crate) fn set_model_pin(project_id: String, model: String) -> Result<(), String> {
    let project_name = resolve_project_name(&project_id)?;
    crate::claude_settings::set_model_pin(
        speedwave_runtime::consts::data_dir(),
        &project_name,
        &model,
    )
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "test assertions use unwrap/expect"
)]
mod tests {
    use super::*;

    /// Writes a raw `model` value straight into settings.json (bypassing `set_model_pin`)
    /// so the read side can be tested with aliases Claude Code itself writes.
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

    /// Writes a one-line transcript whose session-start model is `model`,
    /// standing in for a prior chat session `last_session_model` walks back to.
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
    fn list_effort_levels_returns_all_five() {
        let levels = list_effort_levels().unwrap();
        assert_eq!(levels, vec!["low", "medium", "high", "xhigh", "max"]);
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

    #[test]
    fn set_model_pin_rejects_invalid_project() {
        let res = set_model_pin(String::new(), "claude-sonnet-5".to_string());
        assert!(res.is_err());
    }

    #[test]
    fn set_model_pin_shares_the_same_resolution_error_as_the_effort_commands() {
        // set_model_pin delegates to the same resolve_project_name as the effort
        // commands: an invalid project_id must surface the identical error class.
        let model_err = set_model_pin(String::new(), "claude-sonnet-5".to_string()).unwrap_err();
        let effort_err = set_effort_pin(String::new(), "low".to_string()).unwrap_err();
        assert_eq!(model_err, effort_err);
        assert_eq!(model_err, resolve_project_name("").unwrap_err());
    }

    // ── get_model_hint_in: pin-first, transcript-fallback, none ──────────

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

    /// Ticket demo: a hand-written `fable[1m]` pin resolves to the latest Fable id with
    /// the `[1m]` suffix kept.
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

    #[test]
    fn ensure_effort_pin_migrated_in_ignores_the_file_when_a_pin_already_exists() {
        let tmp = tempfile::tempdir().unwrap();
        let user_config = config::SpeedwaveUserConfig {
            projects: vec![config::ProjectUserEntry {
                name: "proj".to_string(),
                dir: "/tmp/proj".to_string(),
                claude: None,
                integrations: None,
                plugin_settings: None,
                policy: None,
                effort_pin: Some("low".to_string()),
            }],
            ..Default::default()
        };
        config::save_user_config_to(&user_config, &tmp.path().join("config.json")).unwrap();
        let settings_path = speedwave_runtime::claude_home::claude_home_dir(tmp.path(), "proj")
            .join(".claude")
            .join("settings.json");
        std::fs::create_dir_all(settings_path.parent().unwrap()).unwrap();
        std::fs::write(&settings_path, r#"{"effortLevel":"xhigh"}"#).unwrap();

        ensure_effort_pin_migrated_in(tmp.path(), "proj").unwrap();

        let cfg = config::load_user_config_from(&tmp.path().join("config.json")).unwrap();
        assert_eq!(
            cfg.find_project("proj").unwrap().effort_pin.as_deref(),
            Some("low"),
            "an existing pin must never be overwritten by the legacy file"
        );
        let raw = std::fs::read_to_string(&settings_path).unwrap();
        assert_eq!(
            raw, r#"{"effortLevel":"xhigh"}"#,
            "the legacy file must be left untouched when a pin already exists"
        );
    }

    #[test]
    fn get_model_hint_in_shows_an_unrecognized_pin_value_verbatim_never_default() {
        let tmp = tempfile::tempdir().unwrap();
        write_model_pin(tmp.path(), "proj", "some-mystery-value");
        assert_eq!(
            get_model_hint_in(tmp.path(), "proj"),
            Some("some-mystery-value".to_string())
        );
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

    /// The transcript-side protection survives: without a pin, a foreign
    /// provider's transcript must not poison the Anthropic badge.
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
