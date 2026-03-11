// Tauri commands for container updates, app updates, and restart.

use crate::types::check_project;
use crate::updater;
use speedwave_runtime::config;

// ---------------------------------------------------------------------------
// Container update commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub(crate) async fn update_containers(
    project: String,
) -> Result<speedwave_runtime::update::ContainerUpdateResult, String> {
    tokio::task::spawn_blocking(move || {
        log::info!("update_containers: project={project}");
        check_project(&project)?;
        let rt = speedwave_runtime::runtime::detect_runtime();
        speedwave_runtime::update::update_containers(rt.as_ref(), &project).map_err(|e| {
            log::error!("update_containers: error: {e}");
            e.to_string()
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn rollback_containers(project: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        log::info!("rollback_containers: project={project}");
        check_project(&project)?;
        let rt = speedwave_runtime::runtime::detect_runtime();
        speedwave_runtime::update::rollback_containers(rt.as_ref(), &project).map_err(|e| {
            log::error!("rollback_containers: error: {e}");
            e.to_string()
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// App update commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub(crate) async fn check_for_update(
    app: tauri::AppHandle,
) -> Result<Option<updater::UpdateInfo>, String> {
    log::info!("check_for_update: starting");
    updater::check_for_update(&app).await.map_err(|e| {
        log::error!("check_for_update: error: {e}");
        e
    })
}

#[tauri::command]
pub(crate) async fn install_update(
    app: tauri::AppHandle,
    expected_version: String,
) -> Result<(), String> {
    log::info!("install_update: starting (expected_version={expected_version})");
    updater::install_update(&app, expected_version)
        .await
        .map_err(|e| {
            log::error!("install_update: error: {e}");
            e
        })
}

#[tauri::command]
pub(crate) fn get_update_settings() -> Result<updater::UpdateSettings, String> {
    log::debug!("get_update_settings");
    Ok(updater::load_update_settings())
}

#[tauri::command]
pub(crate) fn set_update_settings(settings: updater::UpdateSettings) -> Result<(), String> {
    log::info!(
        "set_update_settings: auto_check={}, interval={}h",
        settings.auto_check,
        settings.check_interval_hours
    );
    updater::save_update_settings(&settings)
}

// `app.restart()` returns `-> !` (the never type) — it terminates the
// process immediately and never returns. The `Result<(), String>` return here
// is required by Tauri's `generate_handler!` macro; the compiler accepts it
// because `!` coerces to any type.
//
// Before restarting, check if any project has running containers.
// If `force` is false and containers are running, return an error instead.
#[tauri::command]
pub(crate) async fn restart_app(app: tauri::AppHandle, force: bool) -> Result<(), String> {
    if !force {
        // Check all projects for running containers
        let running_project = tokio::task::spawn_blocking(|| {
            let user_config = config::load_user_config().map_err(|e| e.to_string())?;
            let rt = speedwave_runtime::runtime::detect_runtime();
            for project in &user_config.projects {
                match rt.compose_ps(&project.name) {
                    Ok(containers) if !containers.is_empty() => {
                        return Ok::<Option<String>, String>(Some(project.name.clone()));
                    }
                    Ok(_) => {}
                    Err(e) => {
                        // Fail-closed: if we can't determine container state, assume
                        // they're running to prevent data loss from unexpected restart.
                        log::warn!(
                            "restart_app: compose_ps failed for '{}': {e}, assuming running",
                            project.name
                        );
                        return Ok(Some(project.name.clone()));
                    }
                }
            }
            Ok(None)
        })
        .await
        .map_err(|e| e.to_string())??;

        if let Some(project_name) = running_project {
            return Err(format!(
                "Cannot restart: containers are running for project '{}'. Stop them first or use force restart.",
                project_name
            ));
        }
    }

    log::info!("restart_app: restarting on frontend request (force={force})");
    app.restart()
}
