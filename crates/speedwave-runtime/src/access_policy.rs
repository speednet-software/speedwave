use crate::config::SpeedwaveUserConfig;
use crate::managed_config::ManagedConfig;
use speedwave_access_policy::{AccessMode, AccessPolicy};
use std::path::{Path, PathBuf};

/// The access.json path inside the per-project policy dir.
pub fn access_config_path_in(data_dir: &Path, project: &str) -> PathBuf {
    crate::pii_policy::policy_config_dir_in(data_dir, project).join("access.json")
}

/// Writes the composed access policy as `access.json` next to `policy.json`, also while every
/// service is `Full`, so the hub can read a missing file as an error.
pub fn write_access_config_in(
    data_dir: &Path,
    project: &str,
    access: &AccessPolicy,
) -> anyhow::Result<()> {
    let path = access_config_path_in(data_dir, project);
    let content = speedwave_access_policy::to_access_file(access)
        .map_err(|e| anyhow::anyhow!("invalid access policy: {e}"))?;
    crate::fs_perms::ensure_owner_only_dir(&crate::pii_policy::policy_config_dir_in(
        data_dir, project,
    ))?;
    crate::fs_perms::write_restricted_file_atomic_if_changed(&path, &content)?;
    Ok(())
}

/// State of the project-wide read-only switch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReadOnlyState {
    /// Read-only is on.
    pub enabled: bool,
    /// The organization locks the switch.
    pub locked: bool,
}

/// Read-only state of a project.
pub fn read_only_state(
    user_config: &SpeedwaveUserConfig,
    project: &str,
    managed: Option<&ManagedConfig>,
) -> ReadOnlyState {
    let locked = managed
        .and_then(|m| m.access.as_ref())
        .is_some_and(|a| a.read_only);
    let own = user_config
        .find_project(project)
        .is_some_and(|p| p.read_only);
    ReadOnlyState {
        enabled: locked || own,
        locked,
    }
}

/// Sets the project-wide read-only switch.
pub fn set_read_only(
    user_config: &mut SpeedwaveUserConfig,
    project: &str,
    enabled: bool,
    managed: Option<&ManagedConfig>,
) -> Result<(), String> {
    if read_only_state(user_config, project, managed).locked {
        return Err(
            "Read-only mode is set by your organization and cannot be changed here.".to_string(),
        );
    }
    let entry = user_config
        .find_project_mut(project)
        .ok_or_else(|| format!("project '{project}' not found in config"))?;
    entry.read_only = enabled;
    Ok(())
}

/// Access state of one integration.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IntegrationAccessState {
    /// Mode stored for the integration.
    pub mode: AccessMode,
    /// Project-wide read-only state.
    pub global: ReadOnlyState,
}

/// Access state of one integration.
pub fn integration_access_state(
    user_config: &SpeedwaveUserConfig,
    project: &str,
    key: &str,
    managed: Option<&ManagedConfig>,
) -> IntegrationAccessState {
    let mode = user_config
        .find_project(project)
        .and_then(|p| p.integrations.as_ref())
        .map_or(AccessMode::Full, |i| i.access_of(key));
    IntegrationAccessState {
        mode,
        global: read_only_state(user_config, project, managed),
    }
}

/// Stores the access mode of one integration.
pub fn set_integration_access(
    user_config: &mut SpeedwaveUserConfig,
    project: &str,
    key: &str,
    mode: AccessMode,
    is_known_plugin: impl Fn(&str) -> bool,
) -> Result<(), String> {
    let known = crate::consts::find_mcp_service(key).is_some()
        || crate::consts::TOGGLEABLE_OS_SERVICES
            .iter()
            .any(|svc| svc.config_key == key)
        || is_known_plugin(key);
    if !known {
        return Err(format!("unknown integration: {key}"));
    }
    let entry = user_config
        .find_project_mut(project)
        .ok_or_else(|| format!("project '{project}' not found in config"))?;
    entry
        .integrations
        .get_or_insert_with(Default::default)
        .set_access(key, mode);
    Ok(())
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code: panics on setup failure are acceptable"
)]
mod tests {
    use super::*;
    use crate::config::{ManagedAccessConfig, ProjectUserEntry};

    fn read_only_policy() -> AccessPolicy {
        AccessPolicy {
            default: AccessMode::Full,
            services: [("slack".to_string(), AccessMode::ReadOnly)].into(),
        }
    }

    #[test]
    fn access_file_carries_the_composed_policy() {
        let tmp = tempfile::tempdir().unwrap();
        write_access_config_in(tmp.path(), "proj", &read_only_policy()).unwrap();
        let json = std::fs::read_to_string(access_config_path_in(tmp.path(), "proj")).unwrap();
        assert_eq!(
            speedwave_access_policy::parse_access_file(&json),
            Ok(read_only_policy())
        );
    }

    #[test]
    fn access_file_sits_next_to_policy_json() {
        assert_eq!(
            access_config_path_in(Path::new("/d"), "proj").parent(),
            crate::pii_policy::policy_config_path_in(Path::new("/d"), "proj").parent()
        );
    }

    #[test]
    fn an_access_file_is_written_while_every_service_is_full() {
        let tmp = tempfile::tempdir().unwrap();
        write_access_config_in(tmp.path(), "proj", &AccessPolicy::default()).unwrap();
        let json = std::fs::read_to_string(access_config_path_in(tmp.path(), "proj")).unwrap();
        assert_eq!(
            speedwave_access_policy::parse_access_file(&json),
            Ok(AccessPolicy::default())
        );
    }

    #[test]
    fn a_read_only_access_file_is_replaced_when_every_service_is_full_again() {
        let tmp = tempfile::tempdir().unwrap();
        write_access_config_in(tmp.path(), "proj", &read_only_policy()).unwrap();
        write_access_config_in(tmp.path(), "proj", &AccessPolicy::default()).unwrap();
        let json = std::fs::read_to_string(access_config_path_in(tmp.path(), "proj")).unwrap();
        assert_eq!(
            speedwave_access_policy::parse_access_file(&json),
            Ok(AccessPolicy::default())
        );
    }

    #[test]
    fn an_invalid_policy_writes_no_access_file() {
        let tmp = tempfile::tempdir().unwrap();
        let invalid = AccessPolicy {
            default: AccessMode::Full,
            services: [("Bad Id".to_string(), AccessMode::ReadOnly)].into(),
        };
        assert!(write_access_config_in(tmp.path(), "proj", &invalid).is_err());
        assert!(!access_config_path_in(tmp.path(), "proj").exists());
    }

    #[cfg(unix)]
    #[test]
    fn access_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        write_access_config_in(tmp.path(), "proj", &read_only_policy()).unwrap();
        let mode = std::fs::metadata(access_config_path_in(tmp.path(), "proj"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    fn user_config(read_only: bool) -> SpeedwaveUserConfig {
        SpeedwaveUserConfig {
            projects: vec![ProjectUserEntry {
                name: "proj".to_string(),
                dir: "/tmp/proj".to_string(),
                claude: None,
                integrations: None,
                plugin_settings: None,
                policy: None,
                effort_pin: None,
                read_only,
            }],
            ..Default::default()
        }
    }

    fn mdm(read_only: bool) -> ManagedConfig {
        ManagedConfig {
            access: Some(ManagedAccessConfig { read_only }),
            ..Default::default()
        }
    }

    #[test]
    fn state_is_off_and_unlocked_by_default() {
        assert_eq!(
            read_only_state(&user_config(false), "proj", None),
            ReadOnlyState {
                enabled: false,
                locked: false
            }
        );
    }

    #[test]
    fn state_follows_the_project_switch() {
        assert_eq!(
            read_only_state(&user_config(true), "proj", None),
            ReadOnlyState {
                enabled: true,
                locked: false
            }
        );
    }

    #[test]
    fn mdm_forces_the_state_on_and_locks_it() {
        assert_eq!(
            read_only_state(&user_config(false), "proj", Some(&mdm(true))),
            ReadOnlyState {
                enabled: true,
                locked: true
            }
        );
    }

    #[test]
    fn a_managed_file_without_the_access_key_locks_nothing() {
        let managed = ManagedConfig::default();
        assert!(!read_only_state(&user_config(false), "proj", Some(&managed)).locked);
    }

    #[test]
    fn set_read_only_stores_the_switch() {
        let mut cfg = user_config(false);
        set_read_only(&mut cfg, "proj", true, None).unwrap();
        assert!(cfg.find_project("proj").unwrap().read_only);
        set_read_only(&mut cfg, "proj", false, None).unwrap();
        assert!(!cfg.find_project("proj").unwrap().read_only);
    }

    #[test]
    fn set_read_only_is_rejected_server_side_while_mdm_locks_it() {
        let mut cfg = user_config(false);
        let err = set_read_only(&mut cfg, "proj", true, Some(&mdm(true))).unwrap_err();
        assert!(err.contains("organization"));
        assert!(!cfg.find_project("proj").unwrap().read_only);
    }

    #[test]
    fn set_read_only_off_is_rejected_while_mdm_locks_it() {
        let mut cfg = user_config(true);
        assert!(set_read_only(&mut cfg, "proj", false, Some(&mdm(true))).is_err());
        assert!(cfg.find_project("proj").unwrap().read_only);
    }

    #[test]
    fn set_read_only_fails_for_an_unknown_project() {
        let mut cfg = user_config(false);
        let err = set_read_only(&mut cfg, "other", true, None).unwrap_err();
        assert!(err.contains("other"));
    }

    #[test]
    fn integration_state_is_full_and_unlocked_by_default() {
        let state = integration_access_state(&user_config(false), "proj", "slack", None);
        assert_eq!(state.mode, AccessMode::Full);
        assert!(!state.global.enabled);
    }

    #[test]
    fn set_integration_access_stores_the_mode_per_integration() {
        let mut cfg = user_config(false);
        set_integration_access(&mut cfg, "proj", "slack", AccessMode::ReadOnly, |_| false).unwrap();
        set_integration_access(&mut cfg, "proj", "mail", AccessMode::ReadOnly, |_| false).unwrap();
        assert_eq!(
            integration_access_state(&cfg, "proj", "slack", None).mode,
            AccessMode::ReadOnly
        );
        assert_eq!(
            integration_access_state(&cfg, "proj", "mail", None).mode,
            AccessMode::ReadOnly
        );
        assert_eq!(
            integration_access_state(&cfg, "proj", "redmine", None).mode,
            AccessMode::Full
        );
        set_integration_access(&mut cfg, "proj", "slack", AccessMode::Full, |_| false).unwrap();
        assert_eq!(
            integration_access_state(&cfg, "proj", "slack", None).mode,
            AccessMode::Full
        );
    }

    #[test]
    fn set_integration_access_accepts_an_installed_plugin_only() {
        let mut cfg = user_config(false);
        let is_plugin = |key: &str| key == "my-plugin";
        set_integration_access(
            &mut cfg,
            "proj",
            "my-plugin",
            AccessMode::ReadOnly,
            is_plugin,
        )
        .unwrap();
        let err = set_integration_access(&mut cfg, "proj", "typo", AccessMode::ReadOnly, is_plugin)
            .unwrap_err();
        assert!(err.contains("typo"));
        assert_eq!(
            integration_access_state(&cfg, "proj", "my-plugin", None).mode,
            AccessMode::ReadOnly
        );
    }

    #[test]
    fn set_integration_access_fails_for_an_unknown_project() {
        let mut cfg = user_config(false);
        let err =
            set_integration_access(&mut cfg, "other", "slack", AccessMode::ReadOnly, |_| false)
                .unwrap_err();
        assert!(err.contains("other"));
    }

    #[test]
    fn integration_state_carries_the_project_wide_mode_and_its_lock() {
        let state =
            integration_access_state(&user_config(false), "proj", "slack", Some(&mdm(true)));
        assert!(state.global.enabled && state.global.locked);
        let own = integration_access_state(&user_config(true), "proj", "slack", None);
        assert!(own.global.enabled && !own.global.locked);
    }

    #[test]
    fn a_stored_integration_mode_survives_the_project_wide_mode_and_composes_to_read_only() {
        let mut cfg = user_config(true);
        set_integration_access(&mut cfg, "proj", "slack", AccessMode::ReadOnly, |_| false).unwrap();
        let state = integration_access_state(&cfg, "proj", "slack", None);
        assert_eq!(state.mode, AccessMode::ReadOnly);
        assert!(state.global.enabled);
    }
}
