//! Tauri commands for the composer effort-pin control.
//! Delegates to [`crate::effort_pin`].

use crate::types::check_project;
use speedwave_runtime::config;

#[tauri::command]
pub(crate) fn get_effort_pin(project_id: String) -> Result<Option<String>, String> {
    check_project(&project_id)?;
    let user_config = config::load_user_config().map_err(|e| e.to_string())?;
    let project = user_config
        .require_project(&project_id)
        .map_err(|e| e.to_string())?;
    Ok(crate::effort_pin::get_effort_pin(
        speedwave_runtime::consts::data_dir(),
        &project.name,
    ))
}

#[tauri::command]
pub(crate) fn set_effort_pin(project_id: String, level: String) -> Result<(), String> {
    check_project(&project_id)?;
    let user_config = config::load_user_config().map_err(|e| e.to_string())?;
    let project = user_config
        .require_project(&project_id)
        .map_err(|e| e.to_string())?;
    crate::effort_pin::set_effort_pin(speedwave_runtime::consts::data_dir(), &project.name, &level)
}

#[tauri::command]
pub(crate) fn list_effort_levels() -> Result<Vec<String>, String> {
    Ok(crate::effort_pin::PERSISTABLE_EFFORT_LEVELS
        .iter()
        .map(|s| s.to_string())
        .collect())
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "test assertions use unwrap/expect"
)]
mod tests {
    use super::*;

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
}
