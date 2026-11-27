//! UI preference commands: the feature flags.

use std::collections::BTreeMap;
use std::path::Path;

use speedwave_runtime::config;
use speedwave_runtime::feature_flags::Feature;
use tauri::{AppHandle, Emitter};

const FEATURE_FLAGS_CHANGED: &str = "feature-flags-changed";

type FeatureFlags = BTreeMap<&'static str, bool>;

#[tauri::command]
pub async fn get_feature_flags() -> Result<FeatureFlags, String> {
    tokio::task::spawn_blocking(|| -> anyhow::Result<FeatureFlags> {
        Ok(config::load_user_config()?.feature_flags())
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_feature_flag(flag: String, enabled: bool, app: AppHandle) -> Result<(), String> {
    let feature =
        Feature::from_key(&flag).ok_or_else(|| format!("unknown feature flag: {flag}"))?;
    let changed = tokio::task::spawn_blocking(move || {
        store_feature_flag_in(speedwave_runtime::consts::data_dir(), feature, enabled)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;

    match changed {
        Some(flags) => app
            .emit(FEATURE_FLAGS_CHANGED, flags)
            .map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

fn store_feature_flag_in(
    data_dir: &Path,
    feature: Feature,
    enabled: bool,
) -> anyhow::Result<Option<FeatureFlags>> {
    config::with_config_lock_in(data_dir, || {
        let path = data_dir.join("config.json");
        let mut cfg = config::load_user_config_from(&path)?;
        if cfg.feature_enabled(feature) == enabled {
            return Ok(None);
        }
        cfg.set_feature_enabled(feature, enabled);
        config::save_user_config_to(&cfg, &path)?;
        Ok(Some(cfg.feature_flags()))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stored_json(dir: &Path) -> String {
        std::fs::read_to_string(dir.join("config.json")).unwrap()
    }

    #[test]
    fn enabling_a_flag_saves_it_and_returns_the_full_map() {
        let dir = tempfile::tempdir().unwrap();
        let flags = store_feature_flag_in(dir.path(), Feature::Office, true)
            .unwrap()
            .unwrap();
        assert_eq!(
            flags,
            BTreeMap::from([("office", true), ("telemetry_settings", false)])
        );
        let reloaded = config::load_user_config_from(&dir.path().join("config.json")).unwrap();
        assert!(reloaded.feature_enabled(Feature::Office));
        assert!(!reloaded.feature_enabled(Feature::TelemetrySettings));
    }

    #[test]
    fn setting_a_flag_to_its_current_value_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            store_feature_flag_in(dir.path(), Feature::Office, false).unwrap(),
            None
        );
        assert!(!dir.path().join("config.json").exists());

        store_feature_flag_in(dir.path(), Feature::Office, true).unwrap();
        assert_eq!(
            store_feature_flag_in(dir.path(), Feature::Office, true).unwrap(),
            None
        );
    }

    #[test]
    fn disabling_a_flag_keeps_the_other_one() {
        let dir = tempfile::tempdir().unwrap();
        store_feature_flag_in(dir.path(), Feature::Office, true).unwrap();
        store_feature_flag_in(dir.path(), Feature::TelemetrySettings, true).unwrap();
        let flags = store_feature_flag_in(dir.path(), Feature::Office, false)
            .unwrap()
            .unwrap();
        assert_eq!(
            flags,
            BTreeMap::from([("office", false), ("telemetry_settings", true)])
        );
    }

    #[test]
    fn a_flag_write_drops_the_legacy_beta_key_and_keeps_the_migrated_flags() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("config.json"),
            r#"{"projects":[],"ui":{"beta_enabled":true}}"#,
        )
        .unwrap();
        let flags = store_feature_flag_in(dir.path(), Feature::Office, false)
            .unwrap()
            .unwrap();
        assert_eq!(
            flags,
            BTreeMap::from([("office", false), ("telemetry_settings", true)])
        );
        assert!(!stored_json(dir.path()).contains("beta_enabled"));
    }

    #[test]
    fn an_unreadable_config_is_an_error_and_stays_untouched() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("config.json"), "{not json").unwrap();
        assert!(store_feature_flag_in(dir.path(), Feature::Office, true).is_err());
        assert_eq!(stored_json(dir.path()), "{not json");
    }

    #[test]
    fn the_flags_serialize_as_the_documented_payload() {
        let flags: FeatureFlags = config::SpeedwaveUserConfig::default().feature_flags();
        assert_eq!(
            serde_json::to_string(&flags).unwrap(),
            r#"{"office":false,"telemetry_settings":false}"#
        );
    }
}
