//! MDM-deployed managed policy. Read-only from Speedwave's view: an admin/MDM
//! writes a system-level `managed-config.json`; a malformed file is a hard error
//! (fail-closed) so an org policy never silently vanishes.

use crate::config::ManagedTelemetryConfig;
use std::path::{Path, PathBuf};

/// Root policy object read from the system-level managed-config file.
#[derive(serde::Deserialize, Debug, Default)]
pub struct ManagedConfig {
    /// MDM-forced OTLP telemetry policy (absent = user fully self-service).
    pub telemetry: Option<ManagedTelemetryConfig>,
}

/// System-level managed-config path: macOS `/Library/Application Support/Speedwave/…`,
/// Windows `%ProgramData%\Speedwave\…`. `None` on other platforms or if `%ProgramData%` is unset.
pub fn managed_config_path() -> Option<PathBuf> {
    let vendor = crate::consts::MANAGED_CONFIG_VENDOR_DIR;
    let file = crate::consts::MANAGED_CONFIG_FILE;
    if cfg!(target_os = "macos") {
        Some(
            PathBuf::from("/Library/Application Support")
                .join(vendor)
                .join(file),
        )
    } else if cfg!(target_os = "windows") {
        let program_data = std::env::var_os("ProgramData")?;
        Some(PathBuf::from(program_data).join(vendor).join(file))
    } else {
        None
    }
}

/// Loads the MDM policy from the system path; `Ok(None)` if absent, `Err` if malformed.
pub fn load_managed_config() -> anyhow::Result<Option<ManagedConfig>> {
    match managed_config_path() {
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
}
