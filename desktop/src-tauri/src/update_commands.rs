// Tauri commands for container updates, app updates, and restart.

use crate::reconcile;
use crate::types::{check_project, BundleReconcileStatus};
use crate::updater;
use speedwave_runtime::{bundle, config};

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
) -> Result<updater::UpdateCheckOutcome, String> {
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
pub(crate) async fn install_update_and_reconcile(
    app: tauri::AppHandle,
    expected_version: String,
) -> Result<(), String> {
    log::info!("install_update_and_reconcile: starting (expected_version={expected_version})");
    updater::verify_update_installable(&app, &expected_version)
        .await
        .map_err(|e| {
            log::error!("install_update_and_reconcile: preflight failed: {e}");
            e
        })?;

    let running_projects = tokio::task::spawn_blocking(|| {
        let user_config = match config::load_user_config() {
            Ok(config) => config,
            Err(e) => {
                log::warn!(
                    "install_update_and_reconcile: failed to load user config, assuming no configured projects: {e}"
                );
                config::SpeedwaveUserConfig::default()
            }
        };
        let rt = speedwave_runtime::runtime::detect_runtime();
        let running_projects = if rt.is_available() {
            reconcile::list_running_projects(rt.as_ref(), &user_config)?
        } else {
            Vec::new()
        };

        let mut state = bundle::load_bundle_state();
        state.phase = bundle::BundleReconcilePhase::Pending;
        state.pending_running_projects = running_projects.clone();
        state.last_error = None;
        bundle::save_bundle_state(&state).map_err(|e| e.to_string())?;

        if !running_projects.is_empty() && rt.is_available() {
            if let Err(stop_error) = reconcile::stop_projects(&running_projects, rt.as_ref()) {
                if let Err(restore_error) = reconcile::restore_projects(&running_projects, rt.as_ref())
                {
                    log::error!(
                        "install_update_and_reconcile: failed to restore projects after stop error: {restore_error}"
                    );
                }

                state.phase = bundle::BundleReconcilePhase::Done;
                state.pending_running_projects.clear();
                state.last_error = None;
                let _ = bundle::save_bundle_state(&state);
                return Err(stop_error);
            }
        }

        Ok::<Vec<String>, String>(running_projects)
    })
    .await
    .map_err(|e| e.to_string())??;

    if let Err(install_error) = updater::install_update(&app, expected_version).await {
        let projects_to_restore = running_projects.clone();
        let restore_error = tokio::task::spawn_blocking(move || {
            if projects_to_restore.is_empty() {
                return Ok::<(), String>(());
            }

            let rt = speedwave_runtime::runtime::detect_runtime();
            if !rt.is_available() {
                return Err(
                    "Runtime unavailable while restoring containers after failed update"
                        .to_string(),
                );
            }

            reconcile::restore_projects(&projects_to_restore, rt.as_ref())
        })
        .await
        .map_err(|e| e.to_string())?;

        let clear_state_error = tokio::task::spawn_blocking(|| {
            let mut state = bundle::load_bundle_state();
            state.phase = bundle::BundleReconcilePhase::Done;
            state.pending_running_projects.clear();
            state.last_error = None;
            bundle::save_bundle_state(&state).map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| e.to_string())?;

        let error = build_install_failure_message(
            install_error,
            restore_error.err(),
            clear_state_error.err(),
        );
        log::error!("install_update_and_reconcile: install failed: {error}");
        return Err(error);
    }

    log::info!("install_update_and_reconcile: update installed, restarting");
    app.restart()
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

#[tauri::command]
pub(crate) fn get_bundle_reconcile_state() -> Result<BundleReconcileStatus, String> {
    Ok(reconcile::current_bundle_status())
}

#[tauri::command]
pub(crate) fn retry_bundle_reconcile(app: tauri::AppHandle) -> Result<(), String> {
    reconcile::reconcile_bundle_update(&app);
    Ok(())
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
                        // Fail-closed: if we can't determine container state, block
                        // the restart to prevent data loss.
                        log::warn!(
                            "restart_app: compose_ps failed for '{}': {e}",
                            project.name
                        );
                        return Err(format!(
                            "Cannot restart: failed to check container state for project '{}' ({e}). \
                             Stop containers manually or use force restart.",
                            project.name
                        ));
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

fn build_install_failure_message(
    install_error: String,
    restore_error: Option<String>,
    clear_state_error: Option<String>,
) -> String {
    let mut error = install_error;
    if let Some(restore_error) = restore_error {
        error.push_str(&format!(
            " Restore after failed update also failed: {restore_error}."
        ));
    }
    if let Some(clear_state_error) = clear_state_error {
        error.push_str(&format!(
            " Failed to clear pending bundle update state: {clear_state_error}."
        ));
    }
    error
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn install_failure_message_install_only() {
        let msg = build_install_failure_message("install failed".into(), None, None);
        assert_eq!(msg, "install failed");
    }

    #[test]
    fn install_failure_message_with_restore_error() {
        let msg = build_install_failure_message(
            "install failed".into(),
            Some("restore boom".into()),
            None,
        );
        assert!(msg.starts_with("install failed"));
        assert!(msg.contains("Restore after failed update also failed: restore boom."));
    }

    #[test]
    fn install_failure_message_with_clear_state_error() {
        let msg =
            build_install_failure_message("install failed".into(), None, Some("state boom".into()));
        assert!(msg.starts_with("install failed"));
        assert!(msg.contains("Failed to clear pending bundle update state: state boom."));
    }

    #[test]
    fn install_failure_message_with_both_errors() {
        let msg = build_install_failure_message(
            "install failed".into(),
            Some("restore boom".into()),
            Some("state boom".into()),
        );
        assert!(msg.starts_with("install failed"));
        assert!(msg.contains("restore boom"));
        assert!(msg.contains("state boom"));
    }
}
