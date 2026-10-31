use serde::{Deserialize, Serialize};
use speedwave_runtime::consts;
use speedwave_runtime::update_channel::{self, deserialize_channel, UpdateChannel};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

/// Mutex to serialize load-modify-save cycles on update-settings.json.
static SETTINGS_LOCK: Mutex<()> = Mutex::new(());

/// Fixed update manifest URL. Mirrors `plugins.updater.endpoints` in tauri.conf.json.
const UPDATE_ENDPOINT: &str =
    "https://github.com/speednet-software/speedwave/releases/latest/download/latest.json";

const UPDATE_DOWNLOAD_PROGRESS_EVENT: &str = "update_download_progress";

const DOWNLOAD_PROGRESS_INTERVAL: Duration = Duration::from_millis(250);

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

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum UpdateInstallPhase {
    Downloading,
    Installing,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct UpdateDownloadProgress {
    downloaded: u64,
    total: Option<u64>,
    phase: UpdateInstallPhase,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct UpdateSettings {
    pub auto_check: bool,
    pub check_interval_hours: u32,
    #[serde(
        default,
        deserialize_with = "deserialize_channel",
        skip_serializing_if = "Option::is_none"
    )]
    pub channel: Option<UpdateChannel>,
}

impl Default for UpdateSettings {
    fn default() -> Self {
        Self {
            auto_check: true,
            check_interval_hours: consts::UPDATE_CHECK_INTERVAL_HOURS,
            channel: None,
        }
    }
}

impl UpdateSettings {
    /// Clamp check_interval_hours to 1..=168 (1 hour to 1 week).
    pub fn normalize(&mut self) {
        self.check_interval_hours = self.check_interval_hours.clamp(1, 168);
    }

    /// The channel this installation follows; `stable` when none was ever chosen.
    pub fn effective_channel(&self) -> UpdateChannel {
        self.channel.unwrap_or_default()
    }
}

fn settings_path() -> Option<PathBuf> {
    Some(update_channel::settings_path())
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
    load_update_settings_from(&path)
}

fn load_update_settings_from(path: &std::path::Path) -> UpdateSettings {
    match std::fs::read_to_string(path) {
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

/// Returns `true` if the release body contains `[CRITICAL]` or `[SECURITY]` (case-insensitive).
fn detect_critical(body: &Option<String>) -> bool {
    body.as_deref().is_some_and(|b| {
        let upper = b.to_uppercase();
        upper.contains("[CRITICAL]") || upper.contains("[SECURITY]")
    })
}

/// Resolves the update manifest URL for `channel`: the fixed stable endpoint,
/// or the manifest built from the latest beta release's tag.
async fn resolve_update_endpoint(channel: UpdateChannel) -> Result<String, String> {
    match channel {
        UpdateChannel::Stable => Ok(UPDATE_ENDPOINT.to_string()),
        UpdateChannel::Beta => tokio::task::spawn_blocking(move || {
            update_channel::fetch_release_tag(UpdateChannel::Beta)
        })
        .await
        .map_err(|e| format!("Release tag fetch task failed: {e}"))?
        .map(|tag| update_channel::release_manifest_url(&tag)),
    }
}

/// Builds a Tauri Updater for `channel`. `version_comparator` allows upgrades only (remote > current), on either channel.
async fn build_updater(
    app: &AppHandle,
    channel: UpdateChannel,
) -> Result<tauri_plugin_updater::Updater, String> {
    let endpoint = resolve_update_endpoint(channel).await?;
    let parsed_url: url::Url = endpoint
        .parse()
        .map_err(|e: url::ParseError| e.to_string())?;
    app.updater_builder()
        .endpoints(vec![parsed_url])
        .map_err(|e| e.to_string())?
        .version_comparator(|current, remote| remote.version > current)
        .build()
        .map_err(|e| e.to_string())
}

pub async fn check_for_update(app: &AppHandle) -> Result<UpdateCheckOutcome, String> {
    let settings = load_update_settings();
    let updater = build_updater(app, settings.effective_channel()).await?;
    let update = updater.check().await.map_err(|e| e.to_string())?;
    match update {
        Some(u) => {
            let info = UpdateInfo {
                version: u.version.clone(),
                is_critical: detect_critical(&u.body),
                body: u.body.clone(),
                date: u.date.map(|d| d.to_string()),
            };
            if let Err(e) = app.emit("update_available", &info) {
                log::warn!("failed to emit update_available event: {e}");
            }
            Ok(UpdateCheckOutcome::UpdateAvailable(info))
        }
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
    let settings = load_update_settings();
    let updater = build_updater(app, settings.effective_channel()).await?;
    let update = updater.check().await.map_err(|e| e.to_string())?;
    let update = update.ok_or("No update available")?;

    let installing_version = update.version.clone();
    if installing_version != expected_version {
        return Err(format!(
            "Version mismatch: expected {} but server returned {}. Please check for updates again.",
            expected_version, installing_version
        ));
    }
    log::info!("installing version {installing_version}");

    let outcome = download_and_install(app, &update).await;
    if outcome.is_err() {
        emit_download_progress(app, &None);
    }
    outcome?;
    log::info!("installed version {installing_version}");
    Ok(())
}

async fn download_and_install(
    app: &AppHandle,
    update: &tauri_plugin_updater::Update,
) -> Result<(), String> {
    let mut progress = DownloadProgress::default();
    let bytes = update
        .download(
            |chunk, total| {
                if let Some(event) = progress.chunk(chunk, total, Instant::now()) {
                    emit_download_progress(app, &Some(event));
                }
            },
            || log::info!("download complete, installing"),
        )
        .await
        .map_err(|e| e.to_string())?;
    emit_download_progress(app, &Some(progress.finished()));
    update.install(bytes).map_err(|e| e.to_string())
}

fn emit_download_progress(app: &AppHandle, event: &Option<UpdateDownloadProgress>) {
    if let Err(e) = app.emit(UPDATE_DOWNLOAD_PROGRESS_EVENT, event) {
        log::warn!("failed to emit {UPDATE_DOWNLOAD_PROGRESS_EVENT} event: {e}");
    }
}

#[derive(Default)]
struct DownloadProgress {
    downloaded: u64,
    total: Option<u64>,
    last_reported_at: Option<Instant>,
}

impl DownloadProgress {
    fn chunk(
        &mut self,
        chunk_len: usize,
        total: Option<u64>,
        now: Instant,
    ) -> Option<UpdateDownloadProgress> {
        self.downloaded += chunk_len as u64;
        if total.is_some() {
            self.total = total;
        }
        let due = self
            .last_reported_at
            .is_none_or(|at| now.duration_since(at) >= DOWNLOAD_PROGRESS_INTERVAL);
        if !due {
            return None;
        }
        self.last_reported_at = Some(now);
        Some(self.snapshot(UpdateInstallPhase::Downloading))
    }

    fn finished(&self) -> UpdateDownloadProgress {
        self.snapshot(UpdateInstallPhase::Installing)
    }

    fn snapshot(&self, phase: UpdateInstallPhase) -> UpdateDownloadProgress {
        UpdateDownloadProgress {
            downloaded: self.downloaded,
            total: self.total,
            phase,
        }
    }
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "test-only assertions"
)]
mod tests {
    use super::*;

    #[test]
    fn update_endpoint_is_unchanged_stable_url() {
        assert_eq!(
            UPDATE_ENDPOINT,
            "https://github.com/speednet-software/speedwave/releases/latest/download/latest.json"
        );
    }

    #[test]
    fn update_settings_missing_channel_field_defaults_to_stable() {
        let json = r#"{"auto_check":true,"check_interval_hours":24}"#;
        let settings: UpdateSettings = serde_json::from_str(json).expect("deserialize");
        assert_eq!(settings.effective_channel(), UpdateChannel::Stable);
    }

    #[test]
    fn update_settings_channel_stable_value() {
        let json = r#"{"auto_check":true,"check_interval_hours":24,"channel":"stable"}"#;
        let settings: UpdateSettings = serde_json::from_str(json).expect("deserialize");
        assert_eq!(settings.effective_channel(), UpdateChannel::Stable);
    }

    #[test]
    fn update_settings_channel_beta_value() {
        let json = r#"{"auto_check":true,"check_interval_hours":24,"channel":"beta"}"#;
        let settings: UpdateSettings = serde_json::from_str(json).expect("deserialize");
        assert_eq!(settings.effective_channel(), UpdateChannel::Beta);
    }

    #[test]
    fn update_settings_unknown_channel_value_falls_back_to_stable_without_resetting_other_fields() {
        let json = r#"{"auto_check":false,"check_interval_hours":6,"channel":"nightly"}"#;
        let settings: UpdateSettings = serde_json::from_str(json).expect("deserialize");
        assert_eq!(settings.effective_channel(), UpdateChannel::Stable);
        assert!(!settings.auto_check);
        assert_eq!(settings.check_interval_hours, 6);
    }

    #[test]
    fn update_settings_default_channel_is_stable() {
        assert_eq!(
            UpdateSettings::default().effective_channel(),
            UpdateChannel::Stable
        );
    }

    #[test]
    fn update_settings_unparsable_file_defaults_to_stable_channel() {
        let dir = tempfile::tempdir().expect("create tempdir");
        let path = dir.path().join("update-settings.json");
        std::fs::write(&path, "not json").expect("write garbage");
        let settings = load_update_settings_from(&path);
        assert_eq!(settings.effective_channel(), UpdateChannel::Stable);
    }

    #[test]
    fn update_settings_missing_file_defaults_to_stable_channel() {
        let dir = tempfile::tempdir().expect("create tempdir");
        let path = dir.path().join("update-settings.json");
        let settings = load_update_settings_from(&path);
        assert_eq!(settings.effective_channel(), UpdateChannel::Stable);
    }

    #[test]
    fn update_settings_without_channel_serializes_without_the_key() {
        let settings = UpdateSettings {
            auto_check: true,
            check_interval_hours: 24,
            channel: None,
        };
        let json = serde_json::to_string(&settings).expect("serialize");
        assert!(
            !json.contains("channel"),
            "serialized settings must omit `channel` when it was never set: {json}"
        );
    }

    #[test]
    fn update_settings_with_channel_serializes_the_key() {
        let settings = UpdateSettings {
            auto_check: true,
            check_interval_hours: 24,
            channel: Some(UpdateChannel::Beta),
        };
        let json = serde_json::to_string(&settings).expect("serialize");
        assert!(json.contains(r#""channel":"beta""#));
    }

    #[tokio::test]
    async fn resolve_update_endpoint_stable_returns_update_endpoint() {
        let endpoint = resolve_update_endpoint(UpdateChannel::Stable)
            .await
            .expect("resolve");
        assert_eq!(endpoint, UPDATE_ENDPOINT);
    }

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
            channel: None,
        };
        s.normalize();
        assert_eq!(s.check_interval_hours, 1);
    }

    #[test]
    fn update_settings_clamp_max() {
        let mut s = UpdateSettings {
            auto_check: true,
            check_interval_hours: 999,
            channel: None,
        };
        s.normalize();
        assert_eq!(s.check_interval_hours, 168);
    }

    #[test]
    fn update_settings_ignores_unknown_fields() {
        let json = r#"{"auto_check":true,"check_interval_hours":24,"update_channel":"beta"}"#;
        let settings: UpdateSettings = serde_json::from_str(json).expect("deserialize");
        assert!(settings.auto_check);
        assert_eq!(settings.check_interval_hours, 24);
        assert_eq!(
            settings.effective_channel(),
            UpdateChannel::Stable,
            "the dead update_channel key must never be read as channel"
        );
    }

    #[test]
    fn update_settings_round_trip_persistence() {
        let dir = tempfile::tempdir().expect("create tempdir");
        let path = dir.path().join("update-settings.json");

        let original = UpdateSettings {
            auto_check: false,
            check_interval_hours: 12,
            channel: Some(UpdateChannel::Beta),
        };

        let json = serde_json::to_string_pretty(&original).expect("serialize");
        std::fs::write(&path, &json).expect("write");

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
            channel: None,
        };

        let json = serde_json::to_string_pretty(&settings).expect("serialize");
        std::fs::write(&tmp_path, &json).expect("write tmp");
        std::fs::rename(&tmp_path, &path).expect("rename");

        let contents = std::fs::read_to_string(&path).expect("read");
        let loaded: UpdateSettings = serde_json::from_str(&contents).expect("deserialize");
        assert_eq!(loaded.check_interval_hours, 6);

        assert!(!tmp_path.exists(), "tmp file should not exist after rename");
    }

    #[test]
    fn atomic_write_does_not_corrupt_on_overwrite() {
        let dir = tempfile::tempdir().expect("create tempdir");
        let path = dir.path().join("update-settings.json");
        let tmp_path = dir.path().join("update-settings.json.tmp");

        let initial = UpdateSettings::default();
        let json = serde_json::to_string_pretty(&initial).expect("serialize");
        std::fs::write(&path, &json).expect("write initial");

        let updated = UpdateSettings {
            auto_check: false,
            check_interval_hours: 48,
            channel: Some(UpdateChannel::Beta),
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
            channel: None,
        };

        let mut clamped = UpdateSettings {
            check_interval_hours: settings.check_interval_hours,
            auto_check: settings.auto_check,
            channel: settings.channel,
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
            channel: None,
        };
        let json = serde_json::to_string_pretty(&initial).expect("serialize");
        std::fs::write(&path, &json).expect("write");

        let contents = std::fs::read_to_string(&path).expect("read");
        let mut settings: UpdateSettings = serde_json::from_str(&contents).expect("deserialize");
        settings.auto_check = false;
        settings.check_interval_hours = 48;
        let json2 = serde_json::to_string_pretty(&settings).expect("serialize");
        let tmp_path = path.with_extension("json.tmp");
        std::fs::write(&tmp_path, &json2).expect("write tmp");
        std::fs::rename(&tmp_path, &path).expect("rename");

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

    #[test]
    fn the_first_chunk_is_reported_at_once() {
        let mut progress = DownloadProgress::default();
        let now = Instant::now();
        assert_eq!(
            progress.chunk(1024, Some(4096), now),
            Some(UpdateDownloadProgress {
                downloaded: 1024,
                total: Some(4096),
                phase: UpdateInstallPhase::Downloading,
            })
        );
    }

    #[test]
    fn chunks_inside_the_interval_are_not_reported() {
        let mut progress = DownloadProgress::default();
        let start = Instant::now();
        progress.chunk(10, Some(100), start);
        assert_eq!(
            progress.chunk(10, Some(100), start + Duration::from_millis(100)),
            None
        );
        assert_eq!(
            progress.chunk(10, Some(100), start + Duration::from_millis(249)),
            None
        );
    }

    #[test]
    fn a_chunk_after_the_interval_reports_every_byte_so_far() {
        let mut progress = DownloadProgress::default();
        let start = Instant::now();
        progress.chunk(10, Some(100), start);
        progress.chunk(10, Some(100), start + Duration::from_millis(100));
        let event = progress.chunk(10, Some(100), start + DOWNLOAD_PROGRESS_INTERVAL);
        assert_eq!(event.map(|e| e.downloaded), Some(30));
        assert_eq!(
            progress.chunk(
                10,
                Some(100),
                start + DOWNLOAD_PROGRESS_INTERVAL + Duration::from_millis(1)
            ),
            None
        );
    }

    #[test]
    fn an_empty_chunk_counts_nothing() {
        let mut progress = DownloadProgress::default();
        let event = progress.chunk(0, None, Instant::now());
        assert_eq!(event.map(|e| e.downloaded), Some(0));
    }

    #[test]
    fn the_total_stays_unknown_when_the_server_never_sends_one() {
        let mut progress = DownloadProgress::default();
        let start = Instant::now();
        progress.chunk(10, None, start);
        let event = progress.chunk(10, None, start + DOWNLOAD_PROGRESS_INTERVAL);
        assert_eq!(event.map(|e| e.total), Some(None));
        assert_eq!(progress.finished().total, None);
    }

    #[test]
    fn a_total_once_known_is_kept() {
        let mut progress = DownloadProgress::default();
        let start = Instant::now();
        progress.chunk(10, Some(100), start);
        let event = progress.chunk(10, None, start + DOWNLOAD_PROGRESS_INTERVAL);
        assert_eq!(event.map(|e| e.total), Some(Some(100)));
    }

    #[test]
    fn finishing_reports_the_installing_phase_with_the_full_count() {
        let mut progress = DownloadProgress::default();
        let start = Instant::now();
        progress.chunk(60, Some(100), start);
        progress.chunk(40, Some(100), start + Duration::from_millis(1));
        assert_eq!(
            progress.finished(),
            UpdateDownloadProgress {
                downloaded: 100,
                total: Some(100),
                phase: UpdateInstallPhase::Installing,
            }
        );
    }

    #[test]
    fn download_progress_serializes_snake_case_phases() {
        let json = serde_json::to_string(&UpdateDownloadProgress {
            downloaded: 5,
            total: None,
            phase: UpdateInstallPhase::Downloading,
        })
        .unwrap();
        assert_eq!(
            json,
            r#"{"downloaded":5,"total":null,"phase":"downloading"}"#
        );
        let json = serde_json::to_string(&UpdateDownloadProgress {
            downloaded: 5,
            total: Some(5),
            phase: UpdateInstallPhase::Installing,
        })
        .unwrap();
        assert_eq!(json, r#"{"downloaded":5,"total":5,"phase":"installing"}"#);
    }

    #[test]
    fn a_failed_install_clears_the_progress_with_a_null_payload() {
        let json = serde_json::to_string(&Option::<UpdateDownloadProgress>::None).unwrap();
        assert_eq!(json, "null");
    }

    #[test]
    fn download_progress_matches_ts_mirror() {
        use crate::ts_mirror::{rust_fields, ts_interface_fields};
        let ts = include_str!("../../src/src/app/models/update.ts");
        let sample = UpdateDownloadProgress {
            downloaded: 1,
            total: Some(2),
            phase: UpdateInstallPhase::Downloading,
        };
        assert_eq!(
            rust_fields(&sample),
            ts_interface_fields(ts, "UpdateDownloadProgress")
        );
        assert!(
            ts.contains(&format!("'{UPDATE_DOWNLOAD_PROGRESS_EVENT}'")),
            "update.ts must name the {UPDATE_DOWNLOAD_PROGRESS_EVENT} event"
        );
        assert!(
            ts.contains("UpdateDownloadProgressEvent = UpdateDownloadProgress | null"),
            "update.ts must type the event payload as nullable, since a failed install emits null"
        );
        for phase in [
            UpdateInstallPhase::Downloading,
            UpdateInstallPhase::Installing,
        ] {
            let name = serde_json::to_value(phase).unwrap();
            let name = name.as_str().unwrap();
            assert!(
                ts.contains(&format!("'{name}'")),
                "update.ts must list the '{name}' install phase"
            );
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
        if cfg!(feature = "e2e") {
            log::info!("update auto-check disabled in the e2e build");
            return;
        }
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
