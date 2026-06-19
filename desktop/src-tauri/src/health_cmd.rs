// Health-check Tauri command: aggregates per-container and (on macOS) OS-bridge health.

use crate::health::{self, HealthMonitor};
use crate::types::check_project;
use speedwave_runtime::config;

#[tauri::command]
pub(crate) async fn get_health(project: String) -> Result<health::HealthReport, String> {
    tokio::task::spawn_blocking(move || {
        check_project(&project)?;
        let user_config = match config::load_user_config() {
            Ok(c) => c,
            Err(e) => {
                log::warn!("Health check: failed to load config, using defaults: {e}");
                config::SpeedwaveUserConfig::default()
            }
        };
        let project_dir = user_config
            .find_project(&project)
            .map(|p| std::path::PathBuf::from(&p.dir));
        let any_os_enabled = if cfg!(target_os = "macos") {
            project_dir
                .map(|dir| {
                    let resolved = config::resolve_integrations(&dir, &user_config, &project);
                    resolved.any_os_enabled()
                })
                .unwrap_or(false)
        } else {
            false
        };
        Ok(HealthMonitor::check_all(&project, any_os_enabled))
    })
    .await
    .map_err(|e| e.to_string())?
}
