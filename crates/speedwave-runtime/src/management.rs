//! Management inventory (ADR-091): what each project runs — its services and its Claude Code
//! agents — read by the organisation's management agent from `<data_dir>/management/inventory.json`.

use crate::config::{
    self, ManagedAccessList, ManagedServicesConfig, ResolvedIntegrationsConfig,
    SpeedwaveUserConfig, OS_SERVICE_PREFIX, PLUGIN_SERVICE_PREFIX,
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

/// Prefix of an agent's inventory key: `agent:<name>`.
pub const AGENT_KEY_PREFIX: &str = "agent:";

/// One Claude Code agent a project defines, and whether the policy keeps Claude from calling it.
#[derive(Serialize, Debug, PartialEq, Eq)]
pub struct InventoryAgent {
    /// `agent:<name>`.
    pub key: String,
    /// The agent's name, as Claude Code calls it.
    pub name: String,
    /// The policy keeps Claude from calling it.
    pub blocked: bool,
}

/// One project, the services its user turned on and the agents it defines.
#[derive(Serialize, Debug, PartialEq, Eq)]
pub struct InventoryProject {
    /// Project name.
    pub name: String,
    /// The policy keeps the project from running.
    pub blocked: bool,
    /// The services, built-ins first, then macOS, then plugins.
    pub services: Vec<InventoryService>,
    /// The project's Claude Code agents (`.claude/agents`), by name.
    pub agents: Vec<InventoryAgent>,
}

/// Whether a managed policy applies and whether it was readable.
#[derive(Serialize, Debug, PartialEq, Eq)]
pub struct InventoryPolicy {
    /// A managed-config file is in force.
    pub present: bool,
    /// It carries a `services` block.
    pub services: bool,
    /// It carries a `projects` block.
    pub projects: bool,
    /// It carries an `agents` block.
    pub agents: bool,
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
    /// The top-level policy keys this Speedwave applies.
    pub policy_keys: &'static [&'static str],
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

/// The Claude Code agents a project defines (`.claude/agents/*.md`), by name — the frontmatter's
/// `name`, else the file's stem — sorted; a name an agent key cannot carry is left out.
pub fn project_agents(project_dir: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(project_dir.join(".claude").join("agents")) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "md") && p.is_file())
        .filter_map(|p| agent_name(&p))
        .filter(|n| is_agent_name(n))
        .collect();
    names.sort();
    names.dedup();
    names
}

fn agent_name(path: &Path) -> Option<String> {
    let stem = path.file_stem()?.to_string_lossy().to_string();
    let Ok(text) = std::fs::read_to_string(path) else {
        return Some(stem);
    };
    let mut lines = text.lines();
    if lines.next().map(str::trim) != Some("---") {
        return Some(stem);
    }
    let named = lines
        .take_while(|l| l.trim() != "---")
        .find_map(|l| l.strip_prefix("name:"))
        .map(|v| v.trim().trim_matches(|c| c == '"' || c == '\'').to_string())
        .filter(|v| !v.is_empty());
    Some(named.unwrap_or(stem))
}

fn is_agent_name(name: &str) -> bool {
    (1..=120).contains(&name.len())
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// The agents `names` a project defines, with what `policy` keeps Claude from calling.
pub fn agents_of(names: &[String], policy: Option<&ManagedAccessList>) -> Vec<InventoryAgent> {
    names
        .iter()
        .map(|n| InventoryAgent {
            key: format!("{AGENT_KEY_PREFIX}{n}"),
            name: n.clone(),
            blocked: policy.is_some_and(|p| !p.allows(n)),
        })
        .collect()
}

/// The agents of `project_dir` the managed policy keeps Claude from calling.
pub fn denied_agents(project_dir: &Path, policy: Option<&ManagedAccessList>) -> Vec<String> {
    let Some(policy) = policy else {
        return Vec::new();
    };
    project_agents(project_dir)
        .into_iter()
        .filter(|n| !policy.allows(n))
        .collect()
}

/// The inventory of `user_config`'s projects under the managed policy `managed`.
pub fn inventory_of(
    data_dir: &Path,
    user_config: &SpeedwaveUserConfig,
    managed: anyhow::Result<Option<ManagedConfig>>,
    plugin_names: &HashMap<String, String>,
) -> Inventory {
    let (policy, services, projects_policy, agents_policy) = match managed {
        Ok(Some(m)) => (
            InventoryPolicy {
                present: true,
                services: m.services.is_some(),
                projects: m.projects.is_some(),
                agents: m.agents.is_some(),
                error: None,
            },
            m.services,
            m.projects,
            m.agents,
        ),
        Ok(None) => (
            InventoryPolicy {
                present: false,
                services: false,
                projects: false,
                agents: false,
                error: None,
            },
            None,
            None,
            None,
        ),
        Err(e) => (
            InventoryPolicy {
                present: true,
                services: false,
                projects: false,
                agents: false,
                error: Some(e.to_string()),
            },
            Some(ManagedServicesConfig::deny_all()),
            Some(ManagedAccessList::deny_all()),
            Some(ManagedAccessList::deny_all()),
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
                blocked: projects_policy.as_ref().is_some_and(|x| !x.allows(&p.name)),
                services: services_of(&wanted, services.as_ref(), plugin_names),
                agents: agents_of(&project_agents(Path::new(&p.dir)), agents_policy.as_ref()),
            }
        })
        .collect();
    Inventory {
        schema_version: INVENTORY_SCHEMA_VERSION,
        speedwave_version: env!("CARGO_PKG_VERSION"),
        written_at: chrono::Utc::now().to_rfc3339(),
        policy,
        policy_keys: crate::managed_config::MANAGED_POLICY_KEYS,
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
                projects: false,
                agents: false,
                error: Some("boom".into())
            }
        );
        assert_eq!(inv.projects.len(), 1);
        assert!(inv.projects[0].services.iter().all(|s| s.blocked));
        assert_eq!(inv.projects[0].services.len(), 2);
        assert!(inv.projects[0].blocked);
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

    #[test]
    fn the_inventory_names_every_policy_key_this_speedwave_takes() {
        let tmp = tempfile::tempdir().unwrap();
        let inv = inventory_of(
            tmp.path(),
            &SpeedwaveUserConfig::default(),
            Ok(None),
            &HashMap::new(),
        );
        let json = serde_json::to_value(&inv).unwrap();
        let keys: Vec<&str> = json["policy_keys"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|k| k.as_str())
            .collect();
        assert!(keys.contains(&"services") && keys.contains(&"management"));
        assert!(keys.contains(&"projects") && keys.contains(&"agents"));
        let all = keys
            .iter()
            .map(|k| format!("\"{k}\":null"))
            .collect::<Vec<_>>()
            .join(",");
        assert!(
            serde_json::from_str::<crate::managed_config::ManagedConfig>(&format!("{{{all}}}"))
                .is_ok()
        );
    }

    fn write(dir: &Path, file: &str, text: &str) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join(file), text).unwrap();
    }

    #[test]
    fn a_projects_agents_are_named_by_frontmatter_or_file_and_sorted() {
        let tmp = tempfile::tempdir().unwrap();
        let agents = tmp.path().join(".claude").join("agents");
        write(
            &agents,
            "review.md",
            "---\nname: code-reviewer\ndescription: x\n---\nbody",
        );
        write(&agents, "planner.md", "no frontmatter");
        write(&agents, "bad name.md", "---\nname: \"not valid!\"\n---\n");
        write(&agents, "notes.txt", "---\nname: ignored\n---\n");
        assert_eq!(
            project_agents(tmp.path()),
            vec!["code-reviewer".to_string(), "planner".to_string()]
        );
        assert!(project_agents(&tmp.path().join("missing")).is_empty());
    }

    #[test]
    fn the_policy_names_the_agents_and_projects_it_keeps_off() {
        let tmp = tempfile::tempdir().unwrap();
        write(
            &tmp.path().join(".claude").join("agents"),
            "a.md",
            "---\nname: reviewer\n---\n",
        );
        write(&tmp.path().join(".claude").join("agents"), "b.md", "x");
        let policy = ManagedAccessList {
            default: ServiceAccess::Deny,
            rules: [("reviewer".to_string(), ServiceAccess::Allow)]
                .into_iter()
                .collect(),
        };
        assert_eq!(
            denied_agents(tmp.path(), Some(&policy)),
            vec!["b".to_string()]
        );
        assert!(denied_agents(tmp.path(), None).is_empty());
        let listed = agents_of(&["reviewer".to_string(), "b".to_string()], Some(&policy));
        assert_eq!(listed[0].key, "agent:reviewer");
        assert!(!listed[0].blocked && listed[1].blocked);
        assert!(policy.allows("reviewer") && !policy.allows("other"));
    }
}
