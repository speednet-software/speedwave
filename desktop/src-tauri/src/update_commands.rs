// Tauri commands for app updates and bundle reconcile.

use crate::reconcile;
use crate::types::BundleReconcileStatus;
use crate::updater;
use speedwave_runtime::{bundle, config};

// ---------------------------------------------------------------------------
// App update commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub(crate) async fn check_for_update(
    app: tauri::AppHandle,
) -> Result<updater::UpdateCheckOutcome, String> {
    log::info!("starting update check");
    updater::check_for_update(&app).await.map_err(|e| {
        log::error!("update check failed: {e}");
        e
    })
}

#[tauri::command]
pub(crate) async fn install_update_and_reconcile(
    app: tauri::AppHandle,
    expected_version: String,
) -> Result<(), String> {
    log::info!("starting install and reconcile for update (expected_version={expected_version})");
    updater::verify_update_installable(&app, &expected_version)
        .await
        .map_err(|e| {
            log::error!("update install preflight failed: {e}");
            e
        })?;

    let running_projects = tokio::task::spawn_blocking(|| {
        let user_config = match config::load_user_config() {
            Ok(config) => config,
            Err(e) => {
                log::warn!("failed to load user config, assuming no configured projects: {e}");
                config::SpeedwaveUserConfig::default()
            }
        };
        let rt = speedwave_runtime::runtime::detect_runtime();
        let running_projects = if rt.is_available() {
            reconcile::list_running_projects(&rt, &user_config)?
        } else {
            Vec::new()
        };

        let mut state = bundle::load_bundle_state();
        state.phase = bundle::BundleReconcilePhase::Pending;
        state.pending_running_projects = running_projects.clone();
        state.last_error = None;
        bundle::save_bundle_state(&state).map_err(|e| e.to_string())?;

        if !running_projects.is_empty() && rt.is_available() {
            if let Err(stop_error) = reconcile::stop_projects(&running_projects, &rt) {
                let retained = match reconcile::restore_projects(&running_projects, &rt) {
                    Ok(retained) => retained,
                    Err(restore_error) => {
                        log::error!("failed to restore projects after stop error: {restore_error}");
                        Vec::new()
                    }
                };

                state.phase = bundle::BundleReconcilePhase::Done;
                state.pending_running_projects = retained;
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
        let restore_result = tokio::task::spawn_blocking(move || {
            if projects_to_restore.is_empty() {
                return Ok::<Vec<String>, String>(Vec::new());
            }

            let rt = speedwave_runtime::runtime::detect_runtime();
            if !rt.is_available() {
                return Err(
                    "Runtime unavailable while restoring containers after failed update"
                        .to_string(),
                );
            }

            reconcile::restore_projects(&projects_to_restore, &rt)
        })
        .await
        .map_err(|e| e.to_string())?;

        let retained = restore_result.as_ref().ok().cloned().unwrap_or_default();
        let clear_state_error = tokio::task::spawn_blocking(move || {
            let mut state = bundle::load_bundle_state();
            state.phase = bundle::BundleReconcilePhase::Done;
            state.pending_running_projects = retained;
            state.last_error = None;
            bundle::save_bundle_state(&state).map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| e.to_string())?;

        let error = build_install_failure_message(
            install_error,
            restore_result.err(),
            clear_state_error.err(),
        );
        log::error!("update install failed: {error}");
        return Err(error);
    }

    log::info!("update installed, restarting");
    app.restart()
}

#[tauri::command]
pub(crate) fn get_update_settings() -> Result<updater::UpdateSettings, String> {
    log::debug!("fetching update settings");
    Ok(updater::load_update_settings())
}

#[tauri::command]
pub(crate) fn set_update_settings(settings: updater::UpdateSettings) -> Result<(), String> {
    log::info!(
        "saving update settings: auto_check={}, interval={}h",
        settings.auto_check,
        settings.check_interval_hours
    );
    updater::save_update_settings(&settings)
}

#[tauri::command]
pub(crate) fn get_bundle_reconcile_state() -> Result<BundleReconcileStatus, String> {
    Ok(reconcile::current_bundle_status())
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
