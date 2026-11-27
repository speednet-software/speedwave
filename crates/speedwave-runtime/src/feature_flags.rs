//! Feature flags of the Desktop UI: the registry and the legacy-switch migration.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// A UI surface that ships behind a user-controlled flag.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Feature {
    /// The Office row in Integrations.
    Office,
    /// The Telemetry section in Settings.
    TelemetrySettings,
}

impl Feature {
    pub(crate) const ALL: [Feature; 2] = [Feature::Office, Feature::TelemetrySettings];

    /// The key under `ui.features` in the user config.
    pub fn key(self) -> &'static str {
        match self {
            Self::Office => "office",
            Self::TelemetrySettings => "telemetry_settings",
        }
    }

    /// The feature stored under `key`, if registered.
    pub fn from_key(key: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|f| f.key() == key)
    }
}

/// The `ui.features` map as stored in the user config.
#[derive(Serialize, Deserialize, Debug, Default, Clone, PartialEq)]
#[serde(transparent)]
pub struct FeatureFlagsConfig(BTreeMap<String, bool>);

impl FeatureFlagsConfig {
    pub(crate) fn enabled(&self, feature: Feature) -> bool {
        self.0.get(feature.key()).copied().unwrap_or(false)
    }

    pub(crate) fn set(&mut self, feature: Feature, enabled: bool) {
        self.0.insert(feature.key().to_string(), enabled);
    }
}

pub(crate) fn migrate_legacy_beta(
    features: Option<FeatureFlagsConfig>,
    legacy_beta: Option<bool>,
) -> Option<FeatureFlagsConfig> {
    if legacy_beta != Some(true) {
        return features;
    }
    let mut migrated = features.unwrap_or_default();
    for feature in Feature::ALL {
        migrated.0.entry(feature.key().to_string()).or_insert(true);
    }
    Some(migrated)
}

#[cfg(test)]
#[expect(clippy::unwrap_used, reason = "test assertions may unwrap freely")]
mod tests {
    use super::*;

    fn stored(pairs: &[(&str, bool)]) -> FeatureFlagsConfig {
        FeatureFlagsConfig(pairs.iter().map(|(k, v)| (k.to_string(), *v)).collect())
    }

    fn on(features: &Option<FeatureFlagsConfig>, feature: Feature) -> bool {
        features.as_ref().is_some_and(|f| f.enabled(feature))
    }

    #[test]
    fn keys_are_the_documented_config_keys() {
        assert_eq!(Feature::Office.key(), "office");
        assert_eq!(Feature::TelemetrySettings.key(), "telemetry_settings");
    }

    #[test]
    fn every_feature_round_trips_through_its_key() {
        for feature in Feature::ALL {
            assert_eq!(Feature::from_key(feature.key()), Some(feature));
        }
    }

    #[test]
    fn an_unknown_key_is_not_a_feature() {
        assert_eq!(Feature::from_key("nieznana"), None);
        assert_eq!(Feature::from_key(""), None);
        assert_eq!(Feature::from_key("Office"), None);
    }

    #[test]
    fn a_missing_entry_is_off() {
        let flags = FeatureFlagsConfig::default();
        for feature in Feature::ALL {
            assert!(!flags.enabled(feature));
        }
    }

    #[test]
    fn set_changes_only_the_named_feature() {
        let mut flags = FeatureFlagsConfig::default();
        flags.set(Feature::Office, true);
        assert!(flags.enabled(Feature::Office));
        assert!(!flags.enabled(Feature::TelemetrySettings));
        flags.set(Feature::Office, false);
        assert!(!flags.enabled(Feature::Office));
    }

    #[test]
    fn the_map_serializes_as_a_plain_object() {
        let mut flags = FeatureFlagsConfig::default();
        flags.set(Feature::Office, true);
        flags.set(Feature::TelemetrySettings, false);
        assert_eq!(
            serde_json::to_string(&flags).unwrap(),
            r#"{"office":true,"telemetry_settings":false}"#
        );
    }

    #[test]
    fn legacy_true_turns_both_flags_on() {
        let migrated = migrate_legacy_beta(None, Some(true));
        for feature in Feature::ALL {
            assert!(on(&migrated, feature));
        }
    }

    #[test]
    fn legacy_false_leaves_both_flags_off() {
        let migrated = migrate_legacy_beta(None, Some(false));
        for feature in Feature::ALL {
            assert!(!on(&migrated, feature));
        }
    }

    #[test]
    fn a_missing_legacy_key_leaves_both_flags_off() {
        let migrated = migrate_legacy_beta(None, None);
        assert_eq!(migrated, None);
    }

    #[test]
    fn an_existing_entry_wins_over_legacy_true() {
        let migrated = migrate_legacy_beta(Some(stored(&[("office", false)])), Some(true));
        assert!(!on(&migrated, Feature::Office));
        assert!(on(&migrated, Feature::TelemetrySettings));
    }

    #[test]
    fn an_existing_entry_wins_over_legacy_false() {
        let migrated = migrate_legacy_beta(Some(stored(&[("office", true)])), Some(false));
        assert!(on(&migrated, Feature::Office));
        assert!(!on(&migrated, Feature::TelemetrySettings));
    }

    #[test]
    fn unrelated_entries_survive_the_migration() {
        let migrated = migrate_legacy_beta(Some(stored(&[("future_flag", true)])), Some(true));
        assert_eq!(
            serde_json::to_string(&migrated).unwrap(),
            r#"{"future_flag":true,"office":true,"telemetry_settings":true}"#
        );
    }
}
