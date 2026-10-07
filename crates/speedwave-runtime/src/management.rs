//! Management inventory (ADR-091): what each project runs, read by the organisation's management
//! agent from `<data_dir>/management/inventory.json`.

use crate::config::{
    self, ManagedServicesConfig, ResolvedIntegrationsConfig, SpeedwaveUserConfig,
    OS_SERVICE_PREFIX, PLUGIN_SERVICE_PREFIX,
};
use crate::managed_config::ManagedConfig;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Version of the inventory document's shape.
pub const INVENTORY_SCHEMA_VERSION: u32 = 1;

/// One service a project's user turned on: its policy key, kind, name, and what the policy left.
#[derive(Serialize, Debug, PartialEq, Eq)]
pub struct InventoryService {
    /// Services-policy key: `slack`, `os.mail`, `plugin:<service_id>`.
    pub key: String,
    /// `integration`, `os` or `plugin`.
    pub kind: &'static str,
    /// Display name.
    pub name: String,
    /// Runs: turned on by the user and allowed by the policy.
    pub enabled: bool,
    /// Turned on by the user, kept off by the policy.
    pub blocked: bool,
}

/// One project and the services its user turned on.
#[derive(Serialize, Debug, PartialEq, Eq)]
pub struct InventoryProject {
    /// Project name.
    pub name: String,
    /// The services, built-ins first, then macOS, then plugins.
    pub services: Vec<InventoryService>,
}

/// Whether a managed policy applies and whether it was readable.
#[derive(Serialize, Debug, PartialEq, Eq)]
pub struct InventoryPolicy {
    /// A managed-config file is in force.
    pub present: bool,
    /// It carries a `services` block.
    pub services: bool,
    /// Why it could not be read (every service is then off).
    pub error: Option<String>,
}

/// The inventory document.
#[derive(Serialize, Debug)]
pub struct Inventory {
    /// [`INVENTORY_SCHEMA_VERSION`].
    pub schema_version: u32,
    /// Speedwave's version.
    pub speedwave_version: &'static str,
    /// RFC 3339 time of writing.
    pub written_at: String,
    /// The managed policy's state.
    pub policy: InventoryPolicy,
    /// Every project.
    pub projects: Vec<InventoryProject>,
}

/// Where the inventory lives under `data_dir`.
pub fn inventory_path(data_dir: &Path) -> PathBuf {
    data_dir.join("management").join("inventory.json")
}

/// The services `wanted` (the user's choice, before the policy) turns on, with what `policy` blocks.
pub fn services_of(
    wanted: &ResolvedIntegrationsConfig,
    policy: Option<&ManagedServicesConfig>,
    plugin_names: &HashMap<String, String>,
) -> Vec<InventoryService> {
    wanted
        .service_states()
        .into_iter()
        .filter(|(_, on)| *on)
        .map(|(key, _)| {
            let blocked = policy.is_some_and(|p| !p.allows(&key));
            let (kind, name) = if let Some(id) = key.strip_prefix(PLUGIN_SERVICE_PREFIX) {
                (
                    "plugin",
                    plugin_names
                        .get(id)
                        .cloned()
                        .unwrap_or_else(|| id.to_string()),
                )
            } else if let Some(os) = key.strip_prefix(OS_SERVICE_PREFIX) {
                let name = crate::consts::TOGGLEABLE_OS_SERVICES
                    .iter()
                    .find(|s| s.config_key == os)
                    .map_or(os, |s| s.display_name);
                ("os", name.to_string())
            } else {
                let name = crate::consts::TOGGLEABLE_MCP_SERVICES
                    .iter()
                    .find(|s| s.config_key == key)
                    .map_or(key.as_str(), |s| s.display_name);
                ("integration", name.to_string())
            };
            InventoryService {
                key,
                kind,
                name,
                enabled: !blocked,
                blocked,
            }
        })
        .collect()
}

/// The inventory of `user_config`'s projects under the managed policy `managed`.
pub fn inventory_of(
    data_dir: &Path,
    user_config: &SpeedwaveUserConfig,
    managed: anyhow::Result<Option<ManagedConfig>>,
    plugin_names: &HashMap<String, String>,
) -> Inventory {
    let (policy, services) = match managed {
        Ok(Some(m)) => (
            InventoryPolicy {
                present: true,
                services: m.services.is_some(),
                error: None,
            },
            m.services,
        ),
        Ok(None) => (
            InventoryPolicy {
                present: false,
                services: false,
                error: None,
            },
            None,
        ),
        Err(e) => (
            InventoryPolicy {
                present: true,
                services: false,
                error: Some(e.to_string()),
            },
            Some(ManagedServicesConfig::deny_all()),
        ),
    };
    let projects = user_config
        .projects
        .iter()
        .map(|p| {
            let wanted = config::resolve_project_config_in_with_load(
                data_dir,
                Path::new(&p.dir),
                user_config,
                &p.name,
                Ok(None),
            )
            .1;
            InventoryProject {
                name: p.name.clone(),
                services: services_of(&wanted, services.as_ref(), plugin_names),
            }
        })
        .collect();
    Inventory {
        schema_version: INVENTORY_SCHEMA_VERSION,
        speedwave_version: env!("CARGO_PKG_VERSION"),
        written_at: chrono::Utc::now().to_rfc3339(),
        policy,
        projects,
    }
}

/// Writes the inventory for the management agent, best effort; tests never write it.
pub fn refresh_inventory() {
    if cfg!(any(test, feature = "test-support")) {
        return;
    }
    let data_dir = crate::consts::data_dir();
    let user_config = match config::load_user_config() {
        Ok(c) => c,
        Err(e) => {
            log::warn!("management inventory not written: user config unreadable: {e}");
            return;
        }
    };
    let names: HashMap<String, String> = crate::plugin::list_installed_plugins()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|m| m.service_id.map(|id| (id, m.name)))
        .collect();
    let inventory = inventory_of(
        data_dir,
        &user_config,
        crate::managed_config::load_managed_config(),
        &names,
    );
    let path = inventory_path(data_dir);
    let written = path
        .parent()
        .map_or(Ok(()), std::fs::create_dir_all)
        .map_err(anyhow::Error::from)
        .and_then(|()| Ok(serde_json::to_string_pretty(&inventory)?))
        .and_then(|json| crate::fs_perms::write_restricted_file_atomic(&path, &json));
    if let Err(e) = written {
        log::warn!("management inventory not written: {e}");
    }
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test fixtures assert on setup that must not silently fail"
)]
mod tests {
    use super::*;
    use crate::config::{
        IntegrationConfig, IntegrationsConfig, OsIntegrationsConfig, ProjectUserEntry,
        ServiceAccess,
    };

    fn wanted() -> ResolvedIntegrationsConfig {
        ResolvedIntegrationsConfig {
            slack: true,
            github: true,
            os_mail: true,
            plugins: HashMap::from([("acme-crm".to_string(), true), ("off".to_string(), false)]),
            ..Default::default()
        }
    }

    #[test]
    fn lists_only_what_the_user_turned_on_with_kinds_and_names() {
        let names = HashMap::from([("acme-crm".to_string(), "Acme CRM".to_string())]);
        let s = services_of(&wanted(), None, &names);
        let keys: Vec<&str> = s.iter().map(|x| x.key.as_str()).collect();
        assert_eq!(keys, vec!["slack", "github", "os.mail", "plugin:acme-crm"]);
        assert_eq!(s[0].kind, "integration");
        assert_eq!(s[2].kind, "os");
        assert_eq!((s[3].kind, s[3].name.as_str()), ("plugin", "Acme CRM"));
        assert!(s.iter().all(|x| x.enabled && !x.blocked));
    }

    #[test]
    fn marks_what_the_policy_blocks_and_names_an_unknown_plugin_by_its_id() {
        let policy = ManagedServicesConfig {
            default: ServiceAccess::Allow,
            rules: [
                ("github".to_string(), ServiceAccess::Deny),
                ("plugin:acme-crm".to_string(), ServiceAccess::Deny),
            ]
            .into_iter()
            .collect(),
        };
        let s = services_of(&wanted(), Some(&policy), &HashMap::new());
        let github = s.iter().find(|x| x.key == "github").unwrap();
        assert!(github.blocked && !github.enabled);
        let plugin = s.iter().find(|x| x.key == "plugin:acme-crm").unwrap();
        assert!(plugin.blocked && plugin.name == "acme-crm");
        assert!(s.iter().find(|x| x.key == "slack").unwrap().enabled);
    }

    #[test]
    fn an_unreadable_policy_blocks_every_service_and_says_why() {
        let tmp = tempfile::tempdir().unwrap();
        let on = || {
            Some(IntegrationConfig {
                enabled: Some(true),
            })
        };
        let user_config = SpeedwaveUserConfig {
            projects: vec![ProjectUserEntry {
                name: "p".into(),
                dir: tmp.path().to_string_lossy().to_string(),
                claude: None,
                integrations: Some(IntegrationsConfig {
                    slack: on(),
                    os: Some(OsIntegrationsConfig {
                        notes: on(),
                        ..Default::default()
                    }),
                    ..Default::default()
                }),
                plugin_settings: None,
                policy: None,
                effort_pin: None,
            }],
            ..Default::default()
        };
        let inv = inventory_of(
            tmp.path(),
            &user_config,
            Err(anyhow::anyhow!("boom")),
            &HashMap::new(),
        );
        assert_eq!(
            inv.policy,
            InventoryPolicy {
                present: true,
                services: false,
                error: Some("boom".into())
            }
        );
        assert_eq!(inv.projects.len(), 1);
        assert!(inv.projects[0].services.iter().all(|s| s.blocked));
        assert_eq!(inv.projects[0].services.len(), 2);
        let json = serde_json::to_value(&inv).unwrap();
        assert_eq!(json["schema_version"], 1);
        assert_eq!(json["projects"][0]["services"][0]["key"], "slack");
    }

    #[test]
    fn no_policy_and_no_projects_give_an_empty_inventory() {
        let tmp = tempfile::tempdir().unwrap();
        let inv = inventory_of(
            tmp.path(),
            &SpeedwaveUserConfig::default(),
            Ok(None),
            &HashMap::new(),
        );
        assert!(!inv.policy.present && inv.projects.is_empty());
        assert!(inventory_path(tmp.path()).ends_with("management/inventory.json"));
    }
}
