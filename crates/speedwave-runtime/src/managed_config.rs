//! MDM-deployed managed policy (read-only, fail-closed): a malformed
//! `managed-config.json` is a hard error so a policy never silently vanishes.

use crate::config::ManagedTelemetryConfig;
use std::path::{Path, PathBuf};

/// Root policy object read from the system-level managed-config file. Rejects
/// unknown keys so an admin typo fails closed instead of silently dropping.
#[derive(serde::Deserialize, Debug, Default)]
#[serde(deny_unknown_fields)]
pub struct ManagedConfig {
    /// MDM-forced OTLP telemetry policy (absent = user fully self-service).
    pub telemetry: Option<ManagedTelemetryConfig>,
}

/// System-level managed-config path (macOS/Windows); `Ok(None)` on other platforms,
/// `Err` when the Windows ProgramData cannot be resolved (fail-closed).
pub fn managed_config_path() -> anyhow::Result<Option<PathBuf>> {
    let vendor = crate::consts::MANAGED_CONFIG_VENDOR_DIR;
    let file = crate::consts::MANAGED_CONFIG_FILE;
    #[cfg(target_os = "macos")]
    {
        Ok(Some(
            PathBuf::from("/Library/Application Support")
                .join(vendor)
                .join(file),
        ))
    }
    #[cfg(target_os = "windows")]
    {
        Ok(Some(program_data_dir()?.join(vendor).join(file)))
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (vendor, file);
        Ok(None)
    }
}

/// Resolves the system ProgramData directory via `SHGetKnownFolderPath`, never the
/// user-controllable `%ProgramData%` env var (which could hide MDM policy).
#[cfg(target_os = "windows")]
#[allow(unsafe_code)]
fn program_data_dir() -> anyhow::Result<PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::Globalization::lstrlenW;
    use windows_sys::Win32::System::Com::CoTaskMemFree;
    use windows_sys::Win32::UI::Shell::{FOLDERID_ProgramData, SHGetKnownFolderPath};

    // SAFETY: FOLDERID_ProgramData is a valid known-folder id; on S_OK `raw` points
    // at a CoTaskMem-allocated NUL-terminated wide string, freed before returning.
    unsafe {
        let mut raw: *mut u16 = std::ptr::null_mut();
        let hr = SHGetKnownFolderPath(&FOLDERID_ProgramData, 0, std::ptr::null_mut(), &mut raw);
        if hr < 0 || raw.is_null() {
            return Err(anyhow::anyhow!(
                "SHGetKnownFolderPath(ProgramData) failed: 0x{hr:08x}"
            ));
        }
        let len = lstrlenW(raw as *const u16) as usize;
        let path = std::ffi::OsString::from_wide(std::slice::from_raw_parts(raw, len));
        CoTaskMemFree(raw as *const _);
        Ok(PathBuf::from(path))
    }
}

/// Loads the MDM policy from the system path; `Ok(None)` if absent, `Err` if the
/// path cannot be resolved or the file is malformed (fail-closed).
pub fn load_managed_config() -> anyhow::Result<Option<ManagedConfig>> {
    match managed_config_path()? {
        Some(p) => load_managed_config_from(&p),
        None => Ok(None),
    }
}

pub(crate) fn load_managed_config_from(path: &Path) -> anyhow::Result<Option<ManagedConfig>> {
    if !path.exists() {
        return Ok(None);
    }
    let content = std::fs::read_to_string(path)
        .map_err(|e| anyhow::anyhow!("reading managed config {}: {e}", path.display()))?;
    let cfg: ManagedConfig = serde_json::from_str(&content)
        .map_err(|e| anyhow::anyhow!("managed config {} is invalid: {e}", path.display()))?;
    Ok(Some(cfg))
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn absent_file_returns_none() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("managed-config.json");
        assert!(load_managed_config_from(&p).unwrap().is_none());
    }

    #[test]
    fn valid_file_parses_telemetry() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("managed-config.json");
        std::fs::write(
            &p,
            r#"{"telemetry":{"enabled":false,"endpoint":"https://corp:4318"}}"#,
        )
        .unwrap();
        let c = load_managed_config_from(&p).unwrap().unwrap();
        let t = c.telemetry.unwrap();
        assert_eq!(t.enabled, Some(false));
        assert_eq!(t.endpoint.as_deref(), Some("https://corp:4318"));
    }

    #[test]
    fn malformed_json_is_hard_error() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("managed-config.json");
        std::fs::write(&p, "{ not json").unwrap();
        assert!(
            load_managed_config_from(&p).is_err(),
            "malformed MDM config must fail-closed"
        );
    }

    #[test]
    fn unknown_root_key_is_hard_error() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("managed-config.json");
        // `telemetery` typo at the root: valid JSON, but not the `telemetry` key.
        std::fs::write(&p, r#"{"telemetery":{"enabled":false}}"#).unwrap();
        assert!(
            load_managed_config_from(&p).is_err(),
            "an unknown MDM root key must fail-closed, not parse-and-drop"
        );
    }

    #[test]
    fn unknown_telemetry_key_is_hard_error() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("managed-config.json");
        // `endpont` typo inside telemetry: the intended lock would silently vanish.
        std::fs::write(&p, r#"{"telemetry":{"endpont":"https://corp:4318"}}"#).unwrap();
        assert!(
            load_managed_config_from(&p).is_err(),
            "an unknown telemetry key must fail-closed, not leave the field user-editable"
        );
    }
}
