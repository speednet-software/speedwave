use crate::types::check_project;
use serde::Serialize;
use speedwave_runtime::access_policy::{read_only_state, set_read_only};
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
