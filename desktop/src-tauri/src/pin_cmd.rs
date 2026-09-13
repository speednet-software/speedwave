//! Tauri commands for the composer's effort pin and model hint.
//! Delegates to [`crate::claude_settings`].

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

#[tauri::command]
pub(crate) fn get_effort_pin(project_id: String) -> Result<Option<String>, String> {
    let project_name = resolve_project_name(&project_id)?;
    Ok(crate::claude_settings::get_effort_pin(
        speedwave_runtime::consts::data_dir(),
        &project_name,
    ))
}

#[tauri::command]
pub(crate) fn set_effort_pin(project_id: String, level: String) -> Result<(), String> {
    let project_name = resolve_project_name(&project_id)?;
    crate::claude_settings::set_effort_pin(
        speedwave_runtime::consts::data_dir(),
        &project_name,
        &level,
    )
}

#[tauri::command]
pub(crate) fn list_effort_levels() -> Result<Vec<String>, String> {
    Ok(crate::claude_settings::PERSISTABLE_EFFORT_LEVELS
        .iter()
        .map(|s| s.to_string())
        .collect())
}

/// Anthropic-badge hint, pre-session: the settings `model` pin is the first
/// source, with any Claude Code alias (`opus`/`sonnet`/`haiku`/`fable`, each
/// optionally suffixed `[1m]`) resolved to its catalog id and an unrecognized
/// pin value shown verbatim (never "default"). Only without a pin does it fall
/// back to the newest transcript's start model, restricted to `claude-*` shapes
/// so a foreign provider's transcript can't poison the badge.
#[tauri::command]
pub(crate) fn get_model_hint(project_id: String) -> Result<Option<String>, String> {
    let project_name = resolve_project_name(&project_id)?;
    Ok(get_model_hint_in(
        speedwave_runtime::consts::data_dir(),
        &project_name,
    ))
}

/// Testable core of [`get_model_hint`]: takes an explicit `data_dir` so the
/// pin-first/transcript-fallback/none priority order can be unit-tested
/// against a tempdir instead of the real `~/.speedwave` data dir.
fn get_model_hint_in(data_dir: &Path, project: &str) -> Option<String> {
    if let Some(pin) = crate::claude_settings::get_model_pin(data_dir, project) {
        return Some(speedwave_runtime::defaults::resolve_model_alias(&pin));
    }
    crate::history::last_session_model_impl(data_dir, project, |m| m.starts_with("claude-"))
}

/// Persists an Anthropic model pick as the `model` key of the project's
/// claude-home `settings.json`, so the next spawn (and Claude Code itself)
/// starts on it; routed (local/OpenRouter) picks never call this.
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

    /// Writes a raw `model` pin value into the project's claude-home
    /// `settings.json`, bypassing `claude_settings::set_model_pin` (SPEED-539's
    /// write path) so the read side can be tested against arbitrary raw values,
    /// including an alias Claude Code itself would write.
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

    #[test]
    fn get_effort_pin_rejects_invalid_project() {
        let res = get_effort_pin(String::new());
        assert!(res.is_err());
    }

    #[test]
    fn list_effort_levels_returns_the_persistable_four() {
        let levels = list_effort_levels().unwrap();
        assert_eq!(levels, vec!["low", "medium", "high", "xhigh"]);
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
        // Both commands delegate to resolve_project_name: an invalid project_id
        // must surface the identical error class from both entry points.
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

    /// Demo scenario from the ticket: a hand-written `fable[1m]` pin (the shape
    /// Claude Code itself rewrites a saved `claude-fable-5[1m]` to) resolves to
    /// the latest Fable's catalog id with the `[1m]` suffix kept.
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
    fn get_model_hint_in_shows_an_unrecognized_pin_value_verbatim_never_default() {
        let tmp = tempfile::tempdir().unwrap();
        write_model_pin(tmp.path(), "proj", "some-mystery-value");
        assert_eq!(
            get_model_hint_in(tmp.path(), "proj"),
            Some("some-mystery-value".to_string())
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
}
