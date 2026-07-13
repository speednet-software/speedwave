use serde::{Deserialize, Serialize};
use speedwave_runtime::consts;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

/// Mutex to serialize load-modify-save cycles on update-settings.json.
static SETTINGS_LOCK: Mutex<()> = Mutex::new(());

/// Stable update endpoint — GitHub Releases latest. Mirrors `plugins.updater.endpoints` in tauri.conf.json.
const STABLE_ENDPOINT: &str =
    "https://github.com/speednet-software/speedwave/releases/latest/download/latest.json";

// ── Types ──

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct UpdateInfo {
    pub version: String,
    pub body: Option<String>,
    pub date: Option<String>,
    pub is_critical: bool,
}

/// Outcome of `check_for_update`. Both supported platforms (macOS .app,
/// Windows installer) use Tauri's auto-updater directly.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum UpdateCheckOutcome {
    /// No new release available.
    UpToDate,
    /// A newer release is available.
    UpdateAvailable(UpdateInfo),
}

#[derive(Clone, Serialize, Deserialize)]
pub struct UpdateSettings {
    pub auto_check: bool,
    pub check_interval_hours: u32,
}

impl Default for UpdateSettings {
    fn default() -> Self {
        Self {
            auto_check: true,
            check_interval_hours: consts::UPDATE_CHECK_INTERVAL_HOURS,
        }
    }
}

impl UpdateSettings {
    /// Clamp check_interval_hours to 1..=168 (1 hour to 1 week).
    pub fn normalize(&mut self) {
        self.check_interval_hours = self.check_interval_hours.clamp(1, 168);
    }
}

// ── Settings persistence ──

fn settings_path() -> Option<PathBuf> {
    Some(consts::data_dir().join("update-settings.json"))
}

pub fn load_update_settings() -> UpdateSettings {
    let _guard = SETTINGS_LOCK.lock().unwrap_or_else(|e| {
        log::warn!("SETTINGS_LOCK poisoned (load), recovering");
        e.into_inner()
    });
    load_update_settings_inner()
}

fn load_update_settings_inner() -> UpdateSettings {
    let Some(path) = settings_path() else {
        return UpdateSettings::default();
    };
    match std::fs::read_to_string(&path) {
        Ok(contents) => serde_json::from_str(&contents).unwrap_or_default(),
        Err(_) => UpdateSettings::default(),
    }
}

pub fn save_update_settings(settings: &UpdateSettings) -> Result<(), String> {
    let _guard = SETTINGS_LOCK.lock().unwrap_or_else(|e| {
        log::warn!("SETTINGS_LOCK poisoned (save), recovering");
        e.into_inner()
    });
    save_update_settings_inner(settings)
}

fn save_update_settings_inner(settings: &UpdateSettings) -> Result<(), String> {
    let path = settings_path().ok_or("Cannot determine home directory")?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut clamped = settings.clone();
    clamped.normalize();
    let json = serde_json::to_string_pretty(&clamped).map_err(|e| e.to_string())?;
    speedwave_runtime::fs_perms::write_shared_file_atomic(&path, &json).map_err(|e| e.to_string())
}

// ── Install method detection ──

// ── Update check / install ──

/// Returns `true` if the release body contains `[CRITICAL]` or `[SECURITY]` (case-insensitive).
fn detect_critical(body: &Option<String>) -> bool {
    body.as_deref().is_some_and(|b| {
        let upper = b.to_uppercase();
        upper.contains("[CRITICAL]") || upper.contains("[SECURITY]")
    })
}

/// Builds a stable-channel Tauri Updater. `version_comparator` allows upgrades only (remote > current).
fn build_updater(app: &AppHandle) -> Result<tauri_plugin_updater::Updater, String> {
    let parsed_url: url::Url = STABLE_ENDPOINT
        .parse()
        .map_err(|e: url::ParseError| e.to_string())?;
    app.updater_builder()
        .endpoints(vec![parsed_url])
        .map_err(|e| e.to_string())?
        .version_comparator(|current, remote| {
            // Only update when remote version is strictly newer (no downgrades).
            remote.version > current
        })
        .build()
        .map_err(|e| e.to_string())
}

pub async fn check_for_update(app: &AppHandle) -> Result<UpdateCheckOutcome, String> {
    let updater = build_updater(app)?;
    let update = updater.check().await.map_err(|e| e.to_string())?;
    match update {
        Some(u) => Ok(UpdateCheckOutcome::UpdateAvailable(UpdateInfo {
            version: u.version.clone(),
            is_critical: detect_critical(&u.body),
            body: u.body.clone(),
            date: u.date.map(|d| d.to_string()),
        })),
        None => Ok(UpdateCheckOutcome::UpToDate),
    }
}

pub async fn verify_update_installable(
    app: &AppHandle,
    expected_version: &str,
) -> Result<(), String> {
    let outcome = check_for_update(app).await?;
    let update = match outcome {
        UpdateCheckOutcome::UpdateAvailable(info) => info,
        UpdateCheckOutcome::UpToDate => return Err("No update available".to_string()),
    };
    if update.version != expected_version {
        return Err(format!(
            "Version mismatch: expected {} but server returned {}. Please check for updates again.",
            expected_version, update.version
        ));
    }
    Ok(())
}

pub async fn install_update(app: &AppHandle, expected_version: String) -> Result<(), String> {
    let updater = build_updater(app)?;
    let update = updater.check().await.map_err(|e| e.to_string())?;
    let update = update.ok_or("No update available")?;

    // Verify the version matches what the user approved (TOCTOU mitigation).
    let installing_version = update.version.clone();
    if installing_version != expected_version {
        return Err(format!(
            "Version mismatch: expected {} but server returned {}. Please check for updates again.",
            expected_version, installing_version
        ));
    }
    log::info!("installing version {installing_version}");

    let update_body = update.body.clone();
    let mut downloaded: u64 = 0;
    update
        .download_and_install(
            |chunk, _total| {
                downloaded += chunk as u64;
                log::debug!("downloaded {downloaded} bytes");
            },
            || {
                log::info!("download complete, installing");
            },
        )
        .await
        .map_err(|e| e.to_string())?;

    // Do not restart from the auto-check flow (containers may be running); emit an event for the frontend.
    use tauri::Emitter;
    if let Err(e) = app.emit(
        "update_installed",
        &UpdateInfo {
            version: installing_version.clone(),
            body: update_body.clone(),
            date: None,
            is_critical: detect_critical(&update_body),
        },
    ) {
        log::warn!("failed to emit update_installed event: {e}");
    }
    log::info!("installed version {installing_version}; waiting for frontend to confirm restart");
    Ok(())
}

// ── Background auto-check loop ──

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "test-only assertions"
)]
mod tests {
    use super::*;

    #[test]
    fn detect_critical_default_false() {
        assert!(!detect_critical(&None));
        assert!(!detect_critical(&Some("Normal release notes".to_string())));
        assert!(!detect_critical(&Some(String::new())));
    }

    #[test]
    fn detect_critical_with_critical_tag() {
        assert!(detect_critical(&Some(
            "This release contains [CRITICAL] fixes.".to_string()
        )));
    }

    #[test]
    fn detect_critical_with_security_tag() {
        assert!(detect_critical(&Some(
            "[SECURITY] patch for CVE-2025-1234".to_string()
        )));
    }

    #[test]
    fn detect_critical_case_insensitive() {
        assert!(detect_critical(&Some("[critical] update".to_string())));
        assert!(detect_critical(&Some("[Security] fix".to_string())));
    }

    #[test]
    fn update_settings_clamp_min() {
        let mut s = UpdateSettings {
            auto_check: true,
            check_interval_hours: 0,
        };
        s.normalize();
        assert_eq!(s.check_interval_hours, 1);
    }

    #[test]
    fn update_settings_clamp_max() {
        let mut s = UpdateSettings {
            auto_check: true,
            check_interval_hours: 999,
        };
        s.normalize();
        assert_eq!(s.check_interval_hours, 168);
    }

    #[test]
    fn update_settings_ignores_unknown_fields() {
        // Backward compat: existing update-settings.json files may have update_channel
        let json = r#"{"auto_check":true,"check_interval_hours":24,"update_channel":"beta"}"#;
        let settings: UpdateSettings = serde_json::from_str(json).expect("deserialize");
        assert!(settings.auto_check);
        assert_eq!(settings.check_interval_hours, 24);
    }

    #[test]
    fn update_settings_round_trip_persistence() {
        let dir = tempfile::tempdir().expect("create tempdir");
        let path = dir.path().join("update-settings.json");

        let original = UpdateSettings {
            auto_check: false,
            check_interval_hours: 12,
        };

        // Save
        let json = serde_json::to_string_pretty(&original).expect("serialize");
        std::fs::write(&path, &json).expect("write");

        // Load
        let contents = std::fs::read_to_string(&path).expect("read");
        let loaded: UpdateSettings = serde_json::from_str(&contents).expect("deserialize");

        assert_eq!(loaded.auto_check, original.auto_check);
        assert_eq!(loaded.check_interval_hours, original.check_interval_hours);
    }

    #[test]
    fn atomic_write_leaves_no_tmp_file() {
        let dir = tempfile::tempdir().expect("create tempdir");
        let path = dir.path().join("update-settings.json");
        let tmp_path = dir.path().join("update-settings.json.tmp");

        let settings = UpdateSettings {
            auto_check: true,
            check_interval_hours: 6,
        };

        // Simulate what save_update_settings_inner does
        let json = serde_json::to_string_pretty(&settings).expect("serialize");
        std::fs::write(&tmp_path, &json).expect("write tmp");
        std::fs::rename(&tmp_path, &path).expect("rename");

        // Final file exists with correct content
        let contents = std::fs::read_to_string(&path).expect("read");
        let loaded: UpdateSettings = serde_json::from_str(&contents).expect("deserialize");
        assert_eq!(loaded.check_interval_hours, 6);

        // Tmp file must not exist after rename
        assert!(!tmp_path.exists(), "tmp file should not exist after rename");
    }

    #[test]
    fn atomic_write_does_not_corrupt_on_overwrite() {
        let dir = tempfile::tempdir().expect("create tempdir");
        let path = dir.path().join("update-settings.json");
        let tmp_path = dir.path().join("update-settings.json.tmp");

        // Write initial file
        let initial = UpdateSettings::default();
        let json = serde_json::to_string_pretty(&initial).expect("serialize");
        std::fs::write(&path, &json).expect("write initial");

        // Now overwrite atomically
        let updated = UpdateSettings {
            auto_check: false,
            check_interval_hours: 48,
        };
        let json2 = serde_json::to_string_pretty(&updated).expect("serialize");
        std::fs::write(&tmp_path, &json2).expect("write tmp");
        std::fs::rename(&tmp_path, &path).expect("rename");

        let contents = std::fs::read_to_string(&path).expect("read");
        let loaded: UpdateSettings = serde_json::from_str(&contents).expect("deserialize");
        assert!(!loaded.auto_check);
        assert_eq!(loaded.check_interval_hours, 48);
    }

    #[test]
    fn save_clamps_interval_to_min() {
        let dir = tempfile::tempdir().expect("create tempdir");
        let path = dir.path().join("update-settings.json");

        let settings = UpdateSettings {
            auto_check: true,
            check_interval_hours: 0,
        };

        // Simulate normalize + atomic write as done in save_update_settings_inner
        let mut clamped = UpdateSettings {
            check_interval_hours: settings.check_interval_hours,
            auto_check: settings.auto_check,
        };
        clamped.normalize();
        let json = serde_json::to_string_pretty(&clamped).expect("serialize");
        let tmp_path = path.with_extension("json.tmp");
        std::fs::write(&tmp_path, &json).expect("write tmp");
        std::fs::rename(&tmp_path, &path).expect("rename");

        let contents = std::fs::read_to_string(&path).expect("read");
        let loaded: UpdateSettings = serde_json::from_str(&contents).expect("deserialize");
        assert_eq!(loaded.check_interval_hours, 1);
    }

    #[test]
    fn update_info_round_trip_serialization() {
        let info = UpdateInfo {
            version: "1.2.3".to_string(),
            body: Some("release notes".to_string()),
            date: Some("2026-01-01".to_string()),
            is_critical: true,
        };
        let json = serde_json::to_string(&info).unwrap();
        let deserialized: UpdateInfo = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.version, "1.2.3");
        assert_eq!(deserialized.body.as_deref(), Some("release notes"));
        assert_eq!(deserialized.date.as_deref(), Some("2026-01-01"));
        assert!(deserialized.is_critical);
    }

    #[test]
    fn update_info_deserialize_minimal() {
        let json = r#"{"version":"2.0.0","body":null,"date":null,"is_critical":false}"#;
        let info: UpdateInfo = serde_json::from_str(json).unwrap();
        assert_eq!(info.version, "2.0.0");
        assert!(info.body.is_none());
        assert!(!info.is_critical);
    }

    #[test]
    fn update_info_deserialize_ignores_unknown_fields() {
        let json =
            r#"{"version":"3.0.0","body":null,"date":null,"is_critical":false,"extra":"field"}"#;
        let result: Result<UpdateInfo, _> = serde_json::from_str(json);
        assert!(result.is_ok());
        assert_eq!(result.unwrap().version, "3.0.0");
    }

    #[test]
    fn modify_settings_applies_closure() {
        let dir = tempfile::tempdir().expect("create tempdir");
        let path = dir.path().join("update-settings.json");

        let initial = UpdateSettings {
            auto_check: true,
            check_interval_hours: 24,
        };
        let json = serde_json::to_string_pretty(&initial).expect("serialize");
        std::fs::write(&path, &json).expect("write");

        // Simulate the modify pattern (load, mutate, save)
        let contents = std::fs::read_to_string(&path).expect("read");
        let mut settings: UpdateSettings = serde_json::from_str(&contents).expect("deserialize");
        settings.auto_check = false;
        settings.check_interval_hours = 48;
        let json2 = serde_json::to_string_pretty(&settings).expect("serialize");
        let tmp_path = path.with_extension("json.tmp");
        std::fs::write(&tmp_path, &json2).expect("write tmp");
        std::fs::rename(&tmp_path, &path).expect("rename");

        // Verify the modification was applied
        let contents = std::fs::read_to_string(&path).expect("read");
        let loaded: UpdateSettings = serde_json::from_str(&contents).expect("deserialize");
        assert!(!loaded.auto_check);
        assert_eq!(loaded.check_interval_hours, 48);
    }

    #[test]
    fn update_check_outcome_serialises_up_to_date() {
        let json = serde_json::to_string(&UpdateCheckOutcome::UpToDate).unwrap();
        assert_eq!(json, r#"{"kind":"up_to_date"}"#);
    }

    #[test]
    fn update_check_outcome_serialises_update_available() {
        let outcome = UpdateCheckOutcome::UpdateAvailable(UpdateInfo {
            version: "1.2.3".to_string(),
            body: None,
            date: None,
            is_critical: false,
        });
        let json = serde_json::to_string(&outcome).unwrap();
        assert!(json.contains("\"kind\":\"update_available\""));
        assert!(json.contains("\"version\":\"1.2.3\""));
    }

    #[test]
    fn update_check_outcome_round_trip() {
        let original = UpdateCheckOutcome::UpdateAvailable(UpdateInfo {
            version: "9.9.9".to_string(),
            body: None,
            date: None,
            is_critical: false,
        });
        let json = serde_json::to_string(&original).unwrap();
        let back: UpdateCheckOutcome = serde_json::from_str(&json).unwrap();
        match back {
            UpdateCheckOutcome::UpdateAvailable(info) => assert_eq!(info.version, "9.9.9"),
            _ => panic!("expected UpdateAvailable"),
        }
    }
}

/// Last auto-check state; the poll loop logs only when this changes.
#[derive(PartialEq)]
enum AutoCheckState {
    Disabled,
    UpdateAvailable(String),
    UpToDate,
    Error(String),
}

pub fn spawn_auto_check(app_handle: AppHandle) -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        // Delay the first check to avoid a network call at startup.
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        let mut last_state: Option<AutoCheckState> = None;

        loop {
            let mut settings = load_update_settings();
            settings.normalize();
            if !settings.auto_check {
                if last_state != Some(AutoCheckState::Disabled) {
                    log::info!("update auto-check disabled, sleeping");
                    last_state = Some(AutoCheckState::Disabled);
                }
                tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
                continue;
            }

            let state = match check_for_update(&app_handle).await {
                Ok(UpdateCheckOutcome::UpdateAvailable(info)) => {
                    use tauri::Emitter;
                    let _ = app_handle.emit("update_available", &info);
                    AutoCheckState::UpdateAvailable(info.version)
                }
                Ok(UpdateCheckOutcome::UpToDate) => AutoCheckState::UpToDate,
                Err(e) => AutoCheckState::Error(e.to_string()),
            };
            if last_state.as_ref() != Some(&state) {
                match &state {
                    AutoCheckState::UpdateAvailable(v) => log::info!("new version available: {v}"),
                    AutoCheckState::UpToDate => log::info!("update check: already up to date"),
                    AutoCheckState::Error(e) => log::error!("update check failed: {e}"),
                    AutoCheckState::Disabled => {}
                }
                last_state = Some(state);
            }

            // Sleep in 60-second increments so settings changes take effect within a minute.
            let interval_secs = (settings.check_interval_hours as u64) * 3600;
            let mut elapsed: u64 = 0;
            while elapsed < interval_secs {
                tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                elapsed += 60;
                let current = load_update_settings();
                if !current.auto_check {
                    log::info!("auto-check disabled mid-sleep, breaking");
                    break;
                }
            }
        }
    })
}
