//! Access modes of services, their composition and the `access.json` file format.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

const MAX_SERVICES: usize = 256;
const SERVICE_ID_MAX_LEN: usize = 64;
const ACCESS_FILE_VERSION: u32 = 1;
const MAX_ACCESS_FILE_BYTES: usize = 65_536;

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

    /// True when every service is `Full`.
    pub fn is_unrestricted(&self) -> bool {
        self.default == AccessMode::Full && self.services.values().all(|m| *m == AccessMode::Full)
    }

    /// Checks the service count and ids.
    pub fn validate(&self) -> Result<(), String> {
        if self.services.len() > MAX_SERVICES {
            return Err(format!(
                "too many access services: {} exceeds limit of {MAX_SERVICES}",
                self.services.len()
            ));
        }
        for id in self.services.keys() {
            if !is_valid_service_id(id) {
                return Err(format!("invalid access service id '{id}'"));
            }
        }
        Ok(())
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct AccessFile {
    version: u32,
    #[serde(default)]
    default: AccessMode,
    #[serde(default)]
    services: BTreeMap<String, AccessMode>,
}

/// Serializes a validated policy as the content of `access.json`.
pub fn to_access_file(policy: &AccessPolicy) -> Result<String, String> {
    policy.validate()?;
    let file = AccessFile {
        version: ACCESS_FILE_VERSION,
        default: policy.default,
        services: policy.services.clone(),
    };
    serde_json::to_string_pretty(&file).map_err(|e| format!("access file: {e}"))
}

/// Parses and validates the content of `access.json`.
pub fn parse_access_file(json: &str) -> Result<AccessPolicy, String> {
    if json.len() > MAX_ACCESS_FILE_BYTES {
        return Err(format!(
            "access file is {} bytes, limit is {MAX_ACCESS_FILE_BYTES}",
            json.len()
        ));
    }
    let file: AccessFile = serde_json::from_str(json).map_err(|e| format!("access file: {e}"))?;
    if file.version != ACCESS_FILE_VERSION {
        return Err(format!(
            "unsupported access file version {}, expected {ACCESS_FILE_VERSION}",
            file.version
        ));
    }
    let policy = AccessPolicy {
        default: file.default,
        services: file.services,
    };
    policy.validate()?;
    Ok(policy)
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

fn is_valid_service_id(id: &str) -> bool {
    let mut chars = id.chars();
    chars.next().is_some_and(|c| c.is_ascii_lowercase())
        && id.len() <= SERVICE_ID_MAX_LEN
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
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
    fn default_policy_is_unrestricted_full() {
        let policy = AccessPolicy::default();
        assert!(policy.is_unrestricted());
        assert_eq!(policy.mode_of("slack"), AccessMode::Full);
    }

    #[test]
    fn service_entry_overrides_the_default() {
        let policy = policy(AccessMode::Full, &[("slack", AccessMode::ReadOnly)]);
        assert_eq!(policy.mode_of("slack"), AccessMode::ReadOnly);
        assert_eq!(policy.mode_of("redmine"), AccessMode::Full);
        assert!(!policy.is_unrestricted());
    }

    #[test]
    fn read_only_default_applies_to_unnamed_services() {
        let policy = policy(AccessMode::ReadOnly, &[]);
        assert_eq!(policy.mode_of("anything"), AccessMode::ReadOnly);
    }

    #[test]
    fn invalid_service_id_fails_validation() {
        let policy = policy(AccessMode::Full, &[("Bad Id", AccessMode::ReadOnly)]);
        assert!(policy.validate().is_err());
    }

    #[test]
    fn too_many_services_fail_validation() {
        let services: BTreeMap<String, AccessMode> = (0..=MAX_SERVICES)
            .map(|i| (format!("svc{i}"), AccessMode::ReadOnly))
            .collect();
        let policy = AccessPolicy {
            default: AccessMode::Full,
            services,
        };
        assert!(policy.validate().is_err());
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
        assert!(compose(false, false, &BTreeMap::new()).is_unrestricted());
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
        assert!(policy.services.is_empty());
        assert!(policy.is_unrestricted());
    }

    #[test]
    fn written_access_file_parses_back_to_the_same_policy() {
        let policy = compose(
            false,
            false,
            &modes(&[
                ("slack", AccessMode::ReadOnly),
                ("os-mail", AccessMode::ReadOnly),
            ]),
        );
        let json = to_access_file(&policy).unwrap_or_else(|e| panic!("serializes: {e}"));
        assert_eq!(parse_access_file(&json), Ok(policy));
    }

    #[test]
    fn written_access_file_carries_the_version() {
        let json = to_access_file(&AccessPolicy::default()).unwrap_or_default();
        let value: serde_json::Value = serde_json::from_str(&json).unwrap_or_default();
        assert_eq!(value["version"], 1);
    }

    #[test]
    fn an_invalid_policy_is_not_serialized() {
        let policy = policy(AccessMode::Full, &[("Bad Id", AccessMode::ReadOnly)]);
        assert!(to_access_file(&policy).is_err());
    }
}
