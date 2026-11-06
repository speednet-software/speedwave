use crate::types::check_project;
use serde::Serialize;
use speedwave_pii_engine::AccessMode;
use speedwave_runtime::access_policy::{
    integration_access_state, read_only_state, set_integration_access, set_read_only,
};
use speedwave_runtime::config::{self, SpeedwaveUserConfig};
use speedwave_runtime::managed_config::{self, ManagedConfig};

#[derive(Serialize, Debug, PartialEq)]
pub struct AccessSettingsView {
    read_only: bool,
    read_only_locked: bool,
}

#[tauri::command]
pub fn get_access_settings(project: String) -> Result<AccessSettingsView, String> {
    check_project(&project)?;
    let user_config = config::load_user_config().map_err(|e| e.to_string())?;
    let managed = managed_config::load_managed_config().map_err(|e| e.to_string())?;
    view_of(&user_config, &project, managed.as_ref())
}

#[tauri::command]
pub fn set_read_only_mode(project: String, enabled: bool) -> Result<AccessSettingsView, String> {
    check_project(&project)?;
    log::info!("setting read-only mode project={project} enabled={enabled}");
    let managed = managed_config::load_managed_config().map_err(|e| e.to_string())?;
    config::with_config_lock(|| {
        let mut user_config = config::load_user_config()?;
        set_read_only(&mut user_config, &project, enabled, managed.as_ref())
            .map_err(anyhow::Error::msg)?;
        config::save_user_config(&user_config)?;
        view_of(&user_config, &project, managed.as_ref()).map_err(anyhow::Error::msg)
    })
    .map_err(|e| e.to_string())
}

#[derive(Serialize, Debug, PartialEq)]
pub struct IntegrationAccessView {
    mode: AccessMode,
    global_read_only: bool,
    global_locked: bool,
}

#[tauri::command]
pub fn get_integration_access(
    project: String,
    service: String,
) -> Result<IntegrationAccessView, String> {
    check_project(&project)?;
    let user_config = config::load_user_config().map_err(|e| e.to_string())?;
    let managed = managed_config::load_managed_config().map_err(|e| e.to_string())?;
    integration_view_of(&user_config, &project, &service, managed.as_ref())
}

#[tauri::command]
pub fn set_integration_access_mode(
    project: String,
    service: String,
    mode: AccessMode,
) -> Result<IntegrationAccessView, String> {
    check_project(&project)?;
    log::info!("setting integration access mode project={project} service={service} mode={mode:?}");
    let managed = managed_config::load_managed_config().map_err(|e| e.to_string())?;
    config::with_config_lock(|| {
        let mut user_config = config::load_user_config()?;
        set_integration_access(
            &mut user_config,
            &project,
            &service,
            mode,
            is_installed_plugin,
        )
        .map_err(anyhow::Error::msg)?;
        config::save_user_config(&user_config)?;
        integration_view_of(&user_config, &project, &service, managed.as_ref())
            .map_err(anyhow::Error::msg)
    })
    .map_err(|e| e.to_string())
}

fn is_installed_plugin(key: &str) -> bool {
    speedwave_runtime::plugin::list_installed_plugins()
        .unwrap_or_default()
        .iter()
        .any(|manifest| manifest.config_key() == key)
}

fn integration_view_of(
    user_config: &SpeedwaveUserConfig,
    project: &str,
    service: &str,
    managed: Option<&ManagedConfig>,
) -> Result<IntegrationAccessView, String> {
    user_config
        .require_project(project)
        .map_err(|e| e.to_string())?;
    let state = integration_access_state(user_config, project, service, managed);
    Ok(IntegrationAccessView {
        mode: state.mode,
        global_read_only: state.global.enabled,
        global_locked: state.global.locked,
    })
}

fn view_of(
    user_config: &SpeedwaveUserConfig,
    project: &str,
    managed: Option<&ManagedConfig>,
) -> Result<AccessSettingsView, String> {
    user_config
        .require_project(project)
        .map_err(|e| e.to_string())?;
    let state = read_only_state(user_config, project, managed);
    Ok(AccessSettingsView {
        read_only: state.enabled,
        read_only_locked: state.locked,
    })
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test fixture setup and assertions unwrap"
)]
mod tests {
    use super::*;
    use speedwave_runtime::config::{ManagedAccessConfig, ProjectUserEntry};

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

    fn mdm() -> ManagedConfig {
        ManagedConfig {
            access: Some(ManagedAccessConfig { read_only: true }),
            ..Default::default()
        }
    }

    #[test]
    fn view_is_off_and_unlocked_by_default() {
        assert_eq!(
            view_of(&user_config(false), "proj", None).unwrap(),
            AccessSettingsView {
                read_only: false,
                read_only_locked: false
            }
        );
    }

    #[test]
    fn view_shows_the_stored_switch() {
        assert!(view_of(&user_config(true), "proj", None).unwrap().read_only);
    }

    #[test]
    fn view_is_on_and_locked_under_an_mdm_policy() {
        assert_eq!(
            view_of(&user_config(false), "proj", Some(&mdm())).unwrap(),
            AccessSettingsView {
                read_only: true,
                read_only_locked: true
            }
        );
    }

    #[test]
    fn view_fails_for_an_unknown_project() {
        assert!(view_of(&user_config(false), "other", None).is_err());
    }

    #[test]
    fn get_rejects_an_invalid_project_name() {
        assert!(get_access_settings("../x".to_string()).is_err());
    }

    #[test]
    fn set_rejects_an_invalid_project_name() {
        assert!(set_read_only_mode("../x".to_string(), true).is_err());
    }

    fn config_with_slack_read_only() -> SpeedwaveUserConfig {
        let mut cfg = user_config(false);
        set_integration_access(&mut cfg, "proj", "slack", AccessMode::ReadOnly, |_| false).unwrap();
        cfg
    }

    #[test]
    fn integration_view_shows_the_stored_mode() {
        let view =
            integration_view_of(&config_with_slack_read_only(), "proj", "slack", None).unwrap();
        assert_eq!(
            view,
            IntegrationAccessView {
                mode: AccessMode::ReadOnly,
                global_read_only: false,
                global_locked: false
            }
        );
        let other =
            integration_view_of(&config_with_slack_read_only(), "proj", "redmine", None).unwrap();
        assert_eq!(other.mode, AccessMode::Full);
    }

    #[test]
    fn integration_view_carries_the_project_wide_mode_and_the_organization_lock() {
        let view = integration_view_of(&user_config(false), "proj", "slack", Some(&mdm())).unwrap();
        assert!(view.global_read_only);
        assert!(view.global_locked);
        let own = integration_view_of(&user_config(true), "proj", "slack", None).unwrap();
        assert!(own.global_read_only);
        assert!(!own.global_locked);
    }

    #[test]
    fn integration_view_fails_for_an_unknown_project() {
        assert!(integration_view_of(&user_config(false), "other", "slack", None).is_err());
    }

    #[test]
    fn integration_commands_reject_an_invalid_project_name() {
        assert!(get_integration_access("../x".to_string(), "slack".to_string()).is_err());
        assert!(set_integration_access_mode(
            "../x".to_string(),
            "slack".to_string(),
            AccessMode::ReadOnly
        )
        .is_err());
    }

    #[test]
    fn integration_view_matches_ts_mirror() {
        use crate::ts_mirror::{rust_fields, serde_names, ts_interface_fields, ts_union_members};
        let ts = include_str!("../../src/src/app/models/access.ts");
        let sample = IntegrationAccessView {
            mode: AccessMode::Full,
            global_read_only: false,
            global_locked: false,
        };
        assert_eq!(
            rust_fields(&sample),
            ts_interface_fields(ts, "IntegrationAccessView")
        );
        assert_eq!(
            serde_names(&[AccessMode::Full, AccessMode::ReadOnly]),
            ts_union_members(ts, "AccessMode")
        );
    }

    #[test]
    fn view_matches_ts_mirror() {
        use crate::ts_mirror::{rust_fields, ts_interface_fields};
        let ts = include_str!("../../src/src/app/models/access.ts");
        let sample = AccessSettingsView {
            read_only: true,
            read_only_locked: false,
        };
        assert_eq!(
            rust_fields(&sample),
            ts_interface_fields(ts, "AccessSettingsView")
        );
    }
}
