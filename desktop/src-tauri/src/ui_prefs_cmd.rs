//! UI preferences commands — currently the beta-features toggle (ADR-057).
//!
//! `apply_beta_toggle_inner` is the shared write path used by both the
//! `set_beta_enabled` Tauri command and the tray menu's `toggle_beta` arm; it
//! locks the user-config, persists the new value, updates `TrayMenuState`,
//! rebuilds the tray menu, and emits `beta-changed` so the frontend can react.

use speedwave_runtime::config;
use tauri::{AppHandle, Emitter, Manager};

use crate::tray;

/// Reads the persisted beta-features flag from user-config. Returns `false`
/// when the file is absent or the field is unset.
#[tauri::command]
pub async fn get_beta_enabled() -> Result<bool, String> {
    tokio::task::spawn_blocking(|| -> anyhow::Result<bool> {
        let cfg = config::load_user_config()?;
        Ok(cfg.beta_enabled())
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

/// Persists the beta-features flag and reflects the new state in the tray
/// menu + frontend.
#[tauri::command]
pub async fn set_beta_enabled(app: AppHandle, enabled: bool) -> Result<(), String> {
    apply_beta_toggle_inner(&app, enabled).await
}

/// Internal write path shared by the Tauri command and the tray menu arm.
/// Tray callers spawn this on the async runtime to avoid blocking the UI
/// thread.
pub(crate) async fn apply_beta_toggle_inner(
    app: &AppHandle,
    enabled: bool,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        config::with_config_lock(|| {
            let mut cfg = config::load_user_config()?;
            let mut ui = cfg.ui.unwrap_or_default();
            ui.beta_enabled = Some(enabled);
            cfg.ui = Some(ui);
            config::save_user_config(&cfg)
        })
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;

    {
        let state = app.state::<tray::TrayMenuState>();
        match state.beta_enabled.lock() {
            Ok(mut g) => *g = enabled,
            Err(p) => *p.into_inner() = enabled,
        };
    }
    tray::refresh_tray_menu(app);
    app.emit("beta-changed", enabled).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use speedwave_runtime::config::{SpeedwaveUserConfig, UiPrefsConfig};

    /// `beta_enabled()` reads the user-config getter we rely on.
    #[test]
    fn getter_default_is_false() {
        let cfg = SpeedwaveUserConfig::default();
        assert!(!cfg.beta_enabled());
    }

    #[test]
    fn getter_reads_persisted_true() {
        let cfg = SpeedwaveUserConfig {
            ui: Some(UiPrefsConfig {
                beta_enabled: Some(true),
            }),
            ..Default::default()
        };
        assert!(cfg.beta_enabled());
    }

    #[test]
    fn getter_reads_persisted_false() {
        let cfg = SpeedwaveUserConfig {
            ui: Some(UiPrefsConfig {
                beta_enabled: Some(false),
            }),
            ..Default::default()
        };
        assert!(!cfg.beta_enabled());
    }
}
