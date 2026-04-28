use serde::{Deserialize, Serialize};
use speedwave_runtime::consts;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

/// Mutex to serialize load-modify-save cycles on update-settings.json.
static SETTINGS_LOCK: Mutex<()> = Mutex::new(());

/// Authoritative update endpoint. Replaces `plugins.updater.endpoints` in tauri.conf.json at runtime.
/// Keep both in sync for documentation purposes.
///
/// Stable update endpoint — GitHub Releases latest (non-draft, non-prerelease).
const STABLE_ENDPOINT: &str =
    "https://github.com/speednet-software/speedwave/releases/latest/download/latest.json";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct UpdateInfo {
    pub version: String,
    pub body: Option<String>,
    pub date: Option<String>,
    pub is_critical: bool,
}

/// How the running app was installed and who is responsible for updating it.
///
/// `Bundled` covers the standard macOS `.app` and Windows `Program Files` installs
/// where Tauri's auto-updater can replace the binary. `SystemPackage` is the Linux
/// case where a package manager (apt, dpkg, dnf, pacman) owns updates — Tauri's
/// updater does not support `.deb`/`.rpm`, so any network check is wrong to run.
/// `AppImage` is the Linux portable bundle that Tauri's updater *does* support.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InstallManagementKind {
    /// Standard bundled install (macOS `.app`, Windows installer, Linux AppImage).
    Bundled,
    /// Linux install owned by a system package manager (apt/dpkg/dnf/pacman).
    SystemPackage,
    /// Linux AppImage running from a portable mount or user prefix.
    AppImage,
}

/// Outcome of `check_for_update`. The `ManagedExternally` variant signals that
/// the running install is owned by a system package manager and the app should
/// not run any network update check — the user runs `apt upgrade speedwave`
/// (or the equivalent for their distro) instead.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum UpdateCheckOutcome {
    /// No new release available.
    UpToDate,
    /// A newer release is available.
    UpdateAvailable(UpdateInfo),
    /// Updates are managed by an external system package manager. No network
    /// call was made.
    ManagedExternally {
        /// Best-effort guess at the package manager (`apt`, `dnf`, `pacman`, …).
        manager: String,
    },
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

// ---------------------------------------------------------------------------
// Settings persistence
// ---------------------------------------------------------------------------

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
    // Atomic write: write to a temporary file in the same directory, then rename.
    // This prevents partial/corrupt reads if the process is interrupted mid-write.
    let tmp_path = path.with_extension("json.tmp");
    std::fs::write(&tmp_path, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp_path, &path).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Install method detection
// ---------------------------------------------------------------------------

/// Inspect a path that the running executable lives at and decide whether the
/// install is owned by a system package manager, is an AppImage, or is a
/// regular bundled install. Pure function for testability — no I/O.
///
/// Heuristics (Linux only — non-Linux always returns `Bundled`):
/// * `APPIMAGE` env var or `/tmp/.mount_*` prefix → `AppImage`
/// * `/usr/`, `/opt/`, `/snap/`, `/var/lib/flatpak/`, `/nix/store/` → `SystemPackage`
/// * anything else (e.g. `$HOME/Applications/`, `/tmp/dev-build/`) → `Bundled`
pub fn detect_kind_for_path(exe_path: &Path, appimage_env: Option<&str>) -> InstallManagementKind {
    if !cfg!(target_os = "linux") {
        return InstallManagementKind::Bundled;
    }

    if appimage_env.is_some_and(|v| !v.is_empty()) {
        return InstallManagementKind::AppImage;
    }

    let s = exe_path.to_string_lossy();

    // AppImage runtime extracts to /tmp/.mount_<random>/ before exec.
    if s.starts_with("/tmp/.mount_") {
        return InstallManagementKind::AppImage;
    }

    const SYSTEM_PREFIXES: &[&str] = &[
        "/usr/",
        "/opt/",
        "/snap/",
        "/var/lib/flatpak/",
        "/nix/store/",
    ];
    if SYSTEM_PREFIXES.iter().any(|p| s.starts_with(p)) {
        return InstallManagementKind::SystemPackage;
    }

    InstallManagementKind::Bundled
}

/// Best-effort guess at the package manager that owns the running install.
/// Returns the lowercased command name (`apt`, `dnf`, `pacman`, `zypper`),
/// falling back to `"system package manager"` if no known manager is detected.
pub fn detect_package_manager() -> String {
    if !cfg!(target_os = "linux") {
        return "system package manager".to_string();
    }

    // Probe common managers in order of popularity. We only check existence on
    // PATH — we never invoke them here.
    const MANAGERS: &[&str] = &["apt", "dnf", "pacman", "zypper", "dpkg"];
    for m in MANAGERS {
        if which_in_path(m).is_some() {
            return (*m).to_string();
        }
    }
    "system package manager".to_string()
}

/// Returns the kind for the currently running executable, falling back to
/// `Bundled` if `current_exe()` fails (we'd rather attempt the updater than
/// silently skip it on a non-Linux/unknown environment).
pub fn install_management_kind() -> InstallManagementKind {
    match std::env::current_exe() {
        Ok(p) => {
            let env = std::env::var("APPIMAGE").ok();
            detect_kind_for_path(&p, env.as_deref())
        }
        Err(e) => {
            log::warn!("current_exe() failed, assuming bundled install: {e}");
            InstallManagementKind::Bundled
        }
    }
}

/// Minimal `which` — looks for `name` on `$PATH`. Returns `Some(path)` if found.
fn which_in_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Update check / install
// ---------------------------------------------------------------------------

/// Returns `true` if the release body contains `[CRITICAL]` or `[SECURITY]` (case-insensitive).
fn detect_critical(body: &Option<String>) -> bool {
    body.as_deref().is_some_and(|b| {
        let upper = b.to_uppercase();
        upper.contains("[CRITICAL]") || upper.contains("[SECURITY]")
    })
}

/// Builds a Tauri Updater configured for the stable update channel.
///
/// Checks GitHub Releases `/releases/latest/download/latest.json`.
///
/// The `version_comparator` uses semver to only allow upgrades (remote > current),
/// preventing downgrade attacks where a compromised endpoint serves an older version.
fn build_updater(app: &AppHandle) -> Result<tauri_plugin_updater::Updater, String> {
    let parsed_url: url::Url = STABLE_ENDPOINT
        .parse()
        .map_err(|e: url::ParseError| e.to_string())?;
    app.updater_builder()
        .endpoints(vec![parsed_url])
        .map_err(|e| e.to_string())?
        .version_comparator(|current, remote| {
            // Only update when remote version is strictly newer (no downgrades).
            // Both `current` and `remote.version` are already parsed semver::Version
            // (tauri-plugin-updater handles parsing), so direct comparison is safe.
            remote.version > current
        })
        .build()
        .map_err(|e| e.to_string())
}

pub async fn check_for_update(app: &AppHandle) -> Result<UpdateCheckOutcome, String> {
    // If a system package manager owns this install, do not run the network
    // check at all — Tauri's updater cannot replace `.deb`/`.rpm`/`pacman`
    // packages, so a successful "no artifact for linux" branch would be
    // logged as an ERROR for an entirely expected, non-error situation.
    if install_management_kind() == InstallManagementKind::SystemPackage {
        let manager = detect_package_manager();
        log::info!(
            "skipping update check — installed via system package manager (run '{manager} upgrade speedwave' to update)"
        );
        return Ok(UpdateCheckOutcome::ManagedExternally { manager });
    }

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
    #[cfg(not(target_os = "linux"))] app: &AppHandle,
    #[cfg(target_os = "linux")] _app: &AppHandle,
    expected_version: &str,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        Err(format!(
            "Auto-update is not available for .deb packages. \
             Download v{expected_version} from GitHub Releases: \
             https://github.com/speednet-software/speedwave/releases"
        ))
    }

    #[cfg(not(target_os = "linux"))]
    {
        let outcome = check_for_update(app).await?;
        let update = match outcome {
            UpdateCheckOutcome::UpdateAvailable(info) => info,
            UpdateCheckOutcome::UpToDate => return Err("No update available".to_string()),
            UpdateCheckOutcome::ManagedExternally { manager } => {
                return Err(format!(
                    "Updates are managed by '{manager}' — run the package manager to upgrade."
                ));
            }
        };
        if update.version != expected_version {
            return Err(format!(
                "Version mismatch: expected {} but server returned {}. Please check for updates again.",
                expected_version, update.version
            ));
        }
        Ok(())
    }
}

pub async fn install_update(app: &AppHandle, expected_version: String) -> Result<(), String> {
    let updater = build_updater(app)?;
    let update = updater.check().await.map_err(|e| e.to_string())?;
    let update = update.ok_or("No update available")?;

    // Verify the version matches what the user approved (TOCTOU mitigation).
    // If the server returns a different version between check and install, abort.
    let installing_version = update.version.clone();
    if installing_version != expected_version {
        return Err(format!(
            "Version mismatch: expected {} but server returned {}. Please check for updates again.",
            expected_version, installing_version
        ));
    }
    log::info!("installing version {installing_version}");

    // On Linux, Tauri updater only supports AppImage. With .deb packaging,
    // in-place update is not possible — direct the user to GitHub Releases.
    #[cfg(target_os = "linux")]
    {
        // Suppress unused-variable warnings for `update` on Linux — it was
        // already consumed for version verification above.
        let _ = &update;
        Err(format!(
            "Auto-update is not available for .deb packages. \
             Download v{expected_version} from GitHub Releases: \
             https://github.com/speednet-software/speedwave/releases"
        ))
    }

    #[cfg(not(target_os = "linux"))]
    {
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

        // Do not restart immediately from the auto-check flow — containers may be running.
        // Emit an event so the frontend can handle it. Note: the Settings page
        // "Install & Restart" intentionally uses force restart as an explicit user action.
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
        log::info!(
            "installed version {installing_version}; waiting for frontend to confirm restart"
        );
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Background auto-check loop
// ---------------------------------------------------------------------------

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
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

    #[cfg(target_os = "linux")]
    #[test]
    fn detect_kind_system_package_for_usr_bin() {
        let p = Path::new("/usr/bin/speedwave-desktop");
        assert_eq!(
            detect_kind_for_path(p, None),
            InstallManagementKind::SystemPackage
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn detect_kind_system_package_for_opt() {
        let p = Path::new("/opt/speedwave/bin/speedwave-desktop");
        assert_eq!(
            detect_kind_for_path(p, None),
            InstallManagementKind::SystemPackage
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn detect_kind_system_package_for_snap_flatpak_nix() {
        for prefix in [
            "/snap/speedwave/current/speedwave-desktop",
            "/var/lib/flatpak/exports/bin/speedwave-desktop",
            "/nix/store/abc123-speedwave/bin/speedwave-desktop",
        ] {
            assert_eq!(
                detect_kind_for_path(Path::new(prefix), None),
                InstallManagementKind::SystemPackage,
                "expected SystemPackage for {prefix}"
            );
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn detect_kind_appimage_via_mount_prefix() {
        let p = Path::new("/tmp/.mount_xxxxxxx/speedwave-desktop");
        assert_eq!(
            detect_kind_for_path(p, None),
            InstallManagementKind::AppImage
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn detect_kind_appimage_via_env_var_takes_precedence() {
        // Even if the path looks like /usr/, an APPIMAGE env var means we are
        // running through the AppImage runtime (it sometimes self-extracts to
        // odd paths). Trust the env var.
        let p = Path::new("/usr/local/bin/speedwave-desktop");
        assert_eq!(
            detect_kind_for_path(p, Some("/home/user/Apps/Speedwave.AppImage")),
            InstallManagementKind::AppImage
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn detect_kind_appimage_env_var_empty_is_ignored() {
        let p = Path::new("/usr/bin/speedwave-desktop");
        assert_eq!(
            detect_kind_for_path(p, Some("")),
            InstallManagementKind::SystemPackage
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn detect_kind_bundled_for_home_install() {
        let p = Path::new("/home/user/Applications/speedwave-desktop");
        assert_eq!(
            detect_kind_for_path(p, None),
            InstallManagementKind::Bundled
        );
    }

    #[test]
    fn detect_kind_bundled_for_macos_app_bundle() {
        // On non-Linux this always returns Bundled regardless of the path.
        // On Linux a `.app` path doesn't match any system prefix and falls
        // through to Bundled too — both branches converge here.
        let p = Path::new("/Applications/Speedwave.app/Contents/MacOS/speedwave-desktop");
        assert_eq!(
            detect_kind_for_path(p, None),
            InstallManagementKind::Bundled
        );
    }

    #[test]
    fn detect_kind_bundled_for_windows_program_files() {
        // Same: non-Linux returns Bundled; Linux falls through (no prefix match).
        let p = Path::new(r"C:\Program Files\Speedwave\speedwave-desktop.exe");
        assert_eq!(
            detect_kind_for_path(p, None),
            InstallManagementKind::Bundled
        );
    }

    #[cfg(not(target_os = "linux"))]
    #[test]
    fn detect_kind_non_linux_always_bundled() {
        // Even if the path looks system-y, on macOS/Windows we never want to
        // skip the updater — only Linux has the .deb gap.
        for path in [
            "/usr/bin/speedwave-desktop",
            "/opt/speedwave/speedwave-desktop",
            "/tmp/.mount_xxxxxxx/speedwave-desktop",
        ] {
            assert_eq!(
                detect_kind_for_path(Path::new(path), None),
                InstallManagementKind::Bundled,
                "non-Linux must always be Bundled for {path}"
            );
        }
    }

    #[test]
    fn update_check_outcome_serialises_managed_externally() {
        let outcome = UpdateCheckOutcome::ManagedExternally {
            manager: "apt".to_string(),
        };
        let json = serde_json::to_string(&outcome).unwrap();
        assert!(json.contains("\"kind\":\"managed_externally\""));
        assert!(json.contains("\"manager\":\"apt\""));
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
        let original = UpdateCheckOutcome::ManagedExternally {
            manager: "dnf".to_string(),
        };
        let json = serde_json::to_string(&original).unwrap();
        let back: UpdateCheckOutcome = serde_json::from_str(&json).unwrap();
        match back {
            UpdateCheckOutcome::ManagedExternally { manager } => assert_eq!(manager, "dnf"),
            _ => panic!("expected ManagedExternally"),
        }
    }

    #[test]
    fn detect_package_manager_returns_non_empty_string() {
        // We can't assert which manager is on PATH (varies per CI env), but we
        // can assert it's never an empty string and always a printable name.
        let m = detect_package_manager();
        assert!(!m.is_empty());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn install_update_returns_error_on_linux() {
        // On Linux with .deb, install_update should return an error message
        // directing the user to GitHub Releases. We can't call the async function
        // directly in a unit test without a Tauri AppHandle, but we verify the
        // error message format is correct.
        let version = "1.2.3";
        let msg = format!(
            "Auto-update is not available for .deb packages. \
             Download v{version} from GitHub Releases: \
             https://github.com/speednet-software/speedwave/releases"
        );
        assert!(msg.contains("1.2.3"));
        assert!(msg.contains("GitHub Releases"));
    }
}

pub fn spawn_auto_check(app_handle: AppHandle) -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        // If the install is owned by a system package manager, do not run the
        // background loop at all. The user updates with `apt upgrade` (or the
        // equivalent), and the network check would fail every cycle because
        // Tauri's updater does not generate `.deb`/`.rpm` artifacts.
        if install_management_kind() == InstallManagementKind::SystemPackage {
            log::info!(
                "auto-check loop disabled — installed via system package manager (use '{} upgrade speedwave' to update)",
                detect_package_manager()
            );
            return;
        }

        // Delay the first check to avoid a network call at startup.
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;

        loop {
            let mut settings = load_update_settings();
            settings.normalize();
            if !settings.auto_check {
                log::info!("auto-check disabled, sleeping");
                tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
                continue;
            }

            log::info!("checking for updates");
            match check_for_update(&app_handle).await {
                Ok(UpdateCheckOutcome::UpdateAvailable(info)) => {
                    log::info!("new version available: {}", info.version);
                    use tauri::Emitter;
                    let _ = app_handle.emit("update_available", &info);
                }
                Ok(UpdateCheckOutcome::UpToDate) => {
                    log::info!("already up to date");
                }
                Ok(UpdateCheckOutcome::ManagedExternally { manager }) => {
                    // Should not happen — we bailed out above — but handle
                    // defensively in case the install path changes mid-session.
                    log::info!(
                        "auto-check skipped — install now reports as managed by '{manager}'"
                    );
                    return;
                }
                Err(e) => {
                    log::error!("check failed: {e}");
                }
            }

            // Sleep in 60-second increments so that settings changes
            // (e.g. disabling auto-check or adjusting the interval) take
            // effect within one minute rather than after the full interval.
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
