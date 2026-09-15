use crate::types::check_project;
use speedwave_runtime::config;
use speedwave_runtime::runtime;
use speedwave_runtime::slash;
use std::path::PathBuf;

#[tauri::command]
pub(crate) async fn list_slash_commands(
    project_id: String,
) -> Result<slash::SlashDiscovery, String> {
    check_project(&project_id)?;

    let discovery = tauri::async_runtime::spawn_blocking(move || {
        let user_config = config::load_user_config().map_err(|e| e.to_string())?;
        let project_entry = user_config
            .require_project(&project_id)
            .map_err(|e| e.to_string())?;
        let handle =
            slash::ProjectHandle::new(&project_entry.name, PathBuf::from(&project_entry.dir));
        let rt = runtime::detect_runtime();
        slash::discover_slash_commands(&rt, &handle).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("slash discovery task failed: {e}"))??;

    Ok(discovery)
}

#[tauri::command]
pub(crate) fn invalidate_slash_cache(project_id: String) -> Result<(), String> {
    check_project(&project_id)?;
    slash::invalidate_cache(&project_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalidate_slash_cache_rejects_invalid_project() {
        let res = invalidate_slash_cache(String::new());
        assert!(res.is_err());
    }

    #[test]
    fn invalidate_slash_cache_accepts_valid_project_name() {
        let res = invalidate_slash_cache("acme".to_string());
        assert!(res.is_ok());
    }
}
