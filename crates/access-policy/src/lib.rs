//! Access modes of services, their composition and the `access.json` file format.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

const ACCESS_FILE_VERSION: u32 = 1;

/// Access mode of a service.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum AccessMode {
    /// Every tool may be called.
    #[default]
    Full,
    /// Only read-only tools may be called.
    ReadOnly,
}

impl AccessMode {
    /// True for `Full`.
    pub fn is_full(&self) -> bool {
        *self == AccessMode::Full
    }
}

/// Composed access modes.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AccessPolicy {
    /// Mode of services not in `services`.
    pub default: AccessMode,
    /// Modes of single services.
    pub services: BTreeMap<String, AccessMode>,
}

impl AccessPolicy {
    /// Mode of one service.
    pub fn mode_of(&self, service: &str) -> AccessMode {
        self.services.get(service).copied().unwrap_or(self.default)
    }
}

#[derive(Serialize)]
struct AccessFile<'a> {
    version: u32,
    default: AccessMode,
    services: &'a BTreeMap<String, AccessMode>,
}

/// Serializes a policy as the content of `access.json`.
pub fn to_access_file(policy: &AccessPolicy) -> Result<String, String> {
    let file = AccessFile {
        version: ACCESS_FILE_VERSION,
        default: policy.default,
        services: &policy.services,
    };
    serde_json::to_string_pretty(&file).map_err(|e| format!("access file: {e}"))
}

/// Layers that set an access mode.
pub struct AccessInputs<'a> {
    /// Organization forces read-only.
    pub managed_read_only: bool,
    /// Project-wide read-only switch.
    pub project_read_only: bool,
    /// Modes set per service.
    pub service_modes: &'a BTreeMap<String, AccessMode>,
}

/// Composes the effective access policy.
pub fn compose_access_policy(inputs: &AccessInputs<'_>) -> AccessPolicy {
    let default = if inputs.managed_read_only || inputs.project_read_only {
        AccessMode::ReadOnly
    } else {
        AccessMode::Full
    };
    let services = inputs
        .service_modes
        .iter()
        .map(|(service, mode)| (service.clone(), (*mode).max(default)))
        .filter(|(_, mode)| *mode != default)
        .collect();
    AccessPolicy { default, services }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy(default: AccessMode, services: &[(&str, AccessMode)]) -> AccessPolicy {
        AccessPolicy {
            default,
            services: modes(services),
        }
    }

    #[test]
    fn default_policy_is_full_for_every_service() {
        let policy = AccessPolicy::default();
        assert_eq!(policy.default, AccessMode::Full);
        assert!(policy.services.is_empty());
        assert_eq!(policy.mode_of("slack"), AccessMode::Full);
    }

    #[test]
    fn service_entry_overrides_the_default() {
        let policy = policy(AccessMode::Full, &[("slack", AccessMode::ReadOnly)]);
        assert_eq!(policy.mode_of("slack"), AccessMode::ReadOnly);
        assert_eq!(policy.mode_of("redmine"), AccessMode::Full);
        assert_ne!(policy, AccessPolicy::default());
    }

    #[test]
    fn read_only_default_applies_to_unnamed_services() {
        let policy = policy(AccessMode::ReadOnly, &[]);
        assert_eq!(policy.mode_of("anything"), AccessMode::ReadOnly);
    }

    fn modes(entries: &[(&str, AccessMode)]) -> BTreeMap<String, AccessMode> {
        entries
            .iter()
            .map(|(service, mode)| ((*service).to_string(), *mode))
            .collect()
    }

    fn compose(
        managed: bool,
        project: bool,
        service_modes: &BTreeMap<String, AccessMode>,
    ) -> AccessPolicy {
        compose_access_policy(&AccessInputs {
            managed_read_only: managed,
            project_read_only: project,
            service_modes,
        })
    }

    #[test]
    fn nothing_set_leaves_every_service_full() {
        assert_eq!(
            compose(false, false, &BTreeMap::new()),
            AccessPolicy::default()
        );
    }

    #[test]
    fn project_switch_makes_every_service_read_only() {
        let policy = compose(false, true, &BTreeMap::new());
        assert_eq!(policy.default, AccessMode::ReadOnly);
        assert_eq!(policy.mode_of("slack"), AccessMode::ReadOnly);
    }

    #[test]
    fn mdm_forces_read_only_over_an_unset_project_switch() {
        let policy = compose(true, false, &BTreeMap::new());
        assert_eq!(policy.default, AccessMode::ReadOnly);
    }

    #[test]
    fn mdm_and_project_switch_together_stay_read_only() {
        assert_eq!(
            compose(true, true, &BTreeMap::new()).default,
            AccessMode::ReadOnly
        );
    }

    #[test]
    fn a_service_mode_restricts_only_that_service() {
        let policy = compose(false, false, &modes(&[("slack", AccessMode::ReadOnly)]));
        assert_eq!(policy.default, AccessMode::Full);
        assert_eq!(policy.mode_of("slack"), AccessMode::ReadOnly);
        assert_eq!(policy.mode_of("redmine"), AccessMode::Full);
    }

    #[test]
    fn a_full_service_mode_cannot_loosen_the_global_switch() {
        let policy = compose(false, true, &modes(&[("slack", AccessMode::Full)]));
        assert_eq!(policy.mode_of("slack"), AccessMode::ReadOnly);
        assert!(policy.services.is_empty());
    }

    #[test]
    fn a_full_service_mode_cannot_loosen_mdm() {
        let policy = compose(true, false, &modes(&[("slack", AccessMode::Full)]));
        assert_eq!(policy.mode_of("slack"), AccessMode::ReadOnly);
    }

    #[test]
    fn a_full_service_entry_under_a_full_default_is_left_out() {
        let policy = compose(false, false, &modes(&[("slack", AccessMode::Full)]));
        assert_eq!(policy, AccessPolicy::default());
    }

    #[test]
    fn written_access_file_carries_the_version_the_default_and_every_service() {
        let policy = compose(
            false,
            false,
            &modes(&[
                ("slack", AccessMode::ReadOnly),
                ("os-mail", AccessMode::ReadOnly),
            ]),
        );
        let json = to_access_file(&policy).unwrap_or_else(|e| panic!("serializes: {e}"));
        let value: serde_json::Value =
            serde_json::from_str(&json).unwrap_or_else(|e| panic!("is JSON: {e}"));
        assert_eq!(
            value,
            serde_json::json!({
                "version": 1,
                "default": "full",
                "services": { "os-mail": "read_only", "slack": "read_only" }
            })
        );
    }

    #[test]
    fn an_all_full_policy_is_written_with_an_empty_service_map() {
        let json = to_access_file(&AccessPolicy::default()).unwrap_or_default();
        let value: serde_json::Value = serde_json::from_str(&json).unwrap_or_default();
        assert_eq!(
            value,
            serde_json::json!({ "version": 1, "default": "full", "services": {} })
        );
    }
}
