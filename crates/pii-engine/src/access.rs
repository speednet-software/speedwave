use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

const MAX_SERVICES: usize = 256;
const SERVICE_ID_MAX_LEN: usize = 64;

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
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AccessPolicy {
    /// Mode of services not in `services`.
    #[serde(default)]
    pub default: AccessMode,
    /// Modes of single services.
    #[serde(default)]
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

fn is_valid_service_id(id: &str) -> bool {
    let mut chars = id.chars();
    chars.next().is_some_and(|c| c.is_ascii_lowercase())
        && id.len() <= SERVICE_ID_MAX_LEN
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(json: &str) -> AccessPolicy {
        serde_json::from_str(json).unwrap_or_else(|e| panic!("access section parses: {e}"))
    }

    #[test]
    fn default_policy_is_unrestricted_full() {
        let policy = AccessPolicy::default();
        assert!(policy.is_unrestricted());
        assert_eq!(policy.mode_of("slack"), AccessMode::Full);
    }

    #[test]
    fn service_entry_overrides_the_default() {
        let policy = parse(r#"{"default":"full","services":{"slack":"read_only"}}"#);
        assert_eq!(policy.mode_of("slack"), AccessMode::ReadOnly);
        assert_eq!(policy.mode_of("redmine"), AccessMode::Full);
        assert!(!policy.is_unrestricted());
    }

    #[test]
    fn read_only_default_applies_to_unnamed_services() {
        let policy = parse(r#"{"default":"read_only"}"#);
        assert_eq!(policy.mode_of("anything"), AccessMode::ReadOnly);
    }

    #[test]
    fn unknown_mode_is_rejected() {
        assert!(serde_json::from_str::<AccessPolicy>(r#"{"default":"confirm"}"#).is_err());
    }

    #[test]
    fn unknown_key_is_rejected() {
        assert!(serde_json::from_str::<AccessPolicy>(r#"{"defualt":"full"}"#).is_err());
    }

    #[test]
    fn invalid_service_id_fails_validation() {
        let policy = parse(r#"{"services":{"Bad Id":"read_only"}}"#);
        assert!(policy.validate().is_err());
    }

    #[test]
    fn plugin_style_service_id_passes_validation() {
        let policy = parse(r#"{"services":{"custom-my-mcp":"read_only","figma":"full"}}"#);
        assert!(policy.validate().is_ok());
    }

    #[test]
    fn service_id_of_the_plugin_slug_maximum_length_passes_validation() {
        let id = format!("a{}", "b".repeat(63));
        let policy = parse(&format!(r#"{{"services":{{"{id}":"read_only"}}}}"#));
        assert!(policy.validate().is_ok());
        let too_long = format!("{id}b");
        let policy = parse(&format!(r#"{{"services":{{"{too_long}":"read_only"}}}}"#));
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
}
