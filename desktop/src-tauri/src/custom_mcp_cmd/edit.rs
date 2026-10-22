use super::dto::CustomMcpToolDecisionArg;
use speedwave_runtime::config::{self, SpeedwaveUserConfig};
use speedwave_runtime::custom_mcp::catalog;
use speedwave_runtime::custom_mcp::effective::{resolve_for_project, EffectiveCustomMcp};
use speedwave_runtime::custom_mcp::failure;
use speedwave_runtime::custom_mcp::model::{
    self, CustomMcpEntry, CustomMcpSource, CustomPiiMode, CustomToolDecision, HostPort,
    ManagedCustomMcpConfig, WorkspaceMode,
};
use speedwave_runtime::custom_mcp::paths;
use speedwave_runtime::custom_mcp::policy::{
    self, EgressConfig, GuardMode, GuardPolicy, GuardToolPolicy,
};
use speedwave_runtime::runtime::LockedRuntime;
use std::path::Path;

const MAX_ALLOWED_DOMAINS: usize = 1024;

/// Runs `f` on the saved config of the active project `project` under the config lock; `f`
/// saves through the path it is given.
fn with_active_project<T>(
    data_dir: &Path,
    project: &str,
    f: impl FnOnce(&mut SpeedwaveUserConfig, &Path) -> anyhow::Result<T>,
) -> Result<T, String> {
    crate::types::check_project(project)?;
    let config_path = data_dir.join("config.json");
    config::with_config_lock_in(data_dir, || {
        let mut user_config = config::load_user_config_from(&config_path)?;
        let Some(active) = user_config.active_project.clone() else {
            return Ok(Err(
                "No project is active. Select a project and retry.".to_string()
            ));
        };
        if let Err(e) =
            crate::containers_cmd::ensure_saving_for_active_project(&active, Some(project))
        {
            return Ok(Err(e.to_string()));
        }
        Ok(f(&mut user_config, &config_path).map_err(|e| format!("{e:#}")))
    })
    .map_err(failure::settings_failed)?
}

fn entry_mut<'a>(
    user_config: &'a mut SpeedwaveUserConfig,
    project: &str,
    name: &str,
) -> anyhow::Result<&'a mut CustomMcpEntry> {
    user_config
        .find_project_mut(project)
        .and_then(|p| p.custom_mcp.as_mut())
        .and_then(|m| m.get_mut(name))
        .ok_or_else(|| anyhow::anyhow!("no custom MCP server named '{name}' in '{project}'"))
}

/// Updates a consented field: the user changing it in Desktop is a new consent, so an approved
/// entry is re-signed; an entry that is not approved stays unapproved.
fn change_consented(
    entry: &mut CustomMcpEntry,
    wall: chrono::DateTime<chrono::Utc>,
    change: impl FnOnce(&mut CustomMcpEntry),
) -> anyhow::Result<()> {
    let was_approved = policy::is_approved(entry);
    change(entry);
    if was_approved {
        entry.consent_digest = Some(policy::consent_digest(entry)?);
        entry.approved_at = Some(wall.to_rfc3339_opts(chrono::SecondsFormat::Secs, true));
    }
    Ok(())
}

fn refresh_guard_digest(
    data_dir: &Path,
    project: &str,
    name: &str,
    entry: &CustomMcpEntry,
) -> anyhow::Result<()> {
    let mut guard = policy::read_guard_policy(data_dir, project, name)?
        .unwrap_or_else(|| GuardPolicy::empty(name, GuardMode::of(&entry.source), None));
    guard.consent_digest = entry.consent_digest.clone();
    policy::write_guard_policy(data_dir, project, name, &guard)
}

/// Sets the PII mode of a server (re-signing an approved entry). The caller restarts.
pub(crate) fn set_pii_mode_in(
    data_dir: &Path,
    project: &str,
    name: &str,
    mode: CustomPiiMode,
    managed: Option<&ManagedCustomMcpConfig>,
    wall: chrono::DateTime<chrono::Utc>,
) -> Result<(), String> {
    if let Some(forced) = managed.and_then(|m| m.force_pii_mode) {
        if forced != mode {
            return Err("your organization sets the personal data mode of every server".into());
        }
    }
    with_active_project(data_dir, project, |cfg, path| {
        let entry = entry_mut(cfg, project, name)?;
        change_consented(entry, wall, |e| e.pii_mode = mode)?;
        let entry = entry.clone();
        config::save_user_config_to(cfg, path)?;
        refresh_guard_digest(data_dir, project, name, &entry)
    })
}

/// Sets a server's project file access (re-signing an approved entry). The caller restarts.
pub(crate) fn set_file_access_in(
    data_dir: &Path,
    project: &str,
    name: &str,
    mode: WorkspaceMode,
    managed: Option<&ManagedCustomMcpConfig>,
    wall: chrono::DateTime<chrono::Utc>,
) -> Result<(), String> {
    if let Some(limit) = managed.and_then(|m| m.max_workspace_mode) {
        if mode.exceeds(limit) {
            return Err("your organization limits project file access below this choice".into());
        }
    }
    with_active_project(data_dir, project, |cfg, path| {
        let entry = entry_mut(cfg, project, name)?;
        change_consented(entry, wall, |e| e.workspace_mode = mode)?;
        let entry = entry.clone();
        config::save_user_config_to(cfg, path)?;
        refresh_guard_digest(data_dir, project, name, &entry)
    })
}

/// Turns a server on or off (outside the consent digest). The caller restarts.
pub(crate) fn set_enabled_in(
    data_dir: &Path,
    project: &str,
    name: &str,
    enabled: bool,
) -> Result<(), String> {
    with_active_project(data_dir, project, |cfg, path| {
        entry_mut(cfg, project, name)?.enabled = enabled;
        config::save_user_config_to(cfg, path)
    })
}

/// Records tool decisions and rewrites the guard policy; no restart (the guard re-reads it). A
/// decision made for a definition other than the one the hub lists now is refused.
pub(crate) fn set_tools_in(
    data_dir: &Path,
    project: &str,
    name: &str,
    decisions: &[CustomMcpToolDecisionArg],
) -> Result<(), String> {
    model::validate_server_name(name).map_err(|e| e.to_string())?;
    let listed = catalog::read_catalog(data_dir, project, name)
        .map_err(|e| {
            failure::failure(
                failure::CATALOG,
                "The tool list of this server could not be read",
                format!("{e:#}"),
            )
        })?
        .ok_or_else(|| {
            "the tool list of this server is not available yet; start the project and retry"
                .to_string()
        })?;
    for decision in decisions {
        let tool = listed
            .iter()
            .find(|t| t.upstream_name == decision.upstream_name)
            .ok_or_else(|| format!("tool '{}' is no longer listed", decision.upstream_name))?;
        if tool.definition_hash != decision.definition_hash {
            return Err(format!(
                "tool '{}' changed since you reviewed it; review it again",
                decision.upstream_name
            ));
        }
    }
    with_active_project(data_dir, project, |cfg, path| {
        let before = std::fs::read_to_string(path).ok();
        let entry = entry_mut(cfg, project, name)?;
        for d in decisions {
            entry.tools.insert(
                d.upstream_name.clone(),
                CustomToolDecision {
                    state: d.state,
                    definition_hash: d.definition_hash.clone(),
                },
            );
        }
        let entry = entry.clone();
        config::save_user_config_to(cfg, path)?;
        if let Err(e) = write_tool_policy(data_dir, project, name, &entry, &listed) {
            restore(path, before.as_deref())?;
            return Err(e);
        }
        Ok(())
    })
}

fn restore(path: &Path, before: Option<&str>) -> anyhow::Result<()> {
    match before {
        Some(text) => speedwave_runtime::fs_perms::write_restricted_file_atomic(path, text),
        None => Ok(()),
    }
}

fn write_tool_policy(
    data_dir: &Path,
    project: &str,
    name: &str,
    entry: &CustomMcpEntry,
    listed: &[catalog::CatalogTool],
) -> anyhow::Result<()> {
    let previous = policy::read_guard_policy(data_dir, project, name)
        .unwrap_or_else(|e| {
            log::warn!(
                "guard policy of custom MCP server '{name}' is unreadable, rebuilding it: {e:#}"
            );
            None
        })
        .unwrap_or_else(|| GuardPolicy::empty(name, GuardMode::of(&entry.source), None));
    let mut guard = GuardPolicy {
        consent_digest: entry.consent_digest.clone(),
        tools: Default::default(),
        ..previous.clone()
    };
    for (upstream, decision) in &entry.tools {
        let kept = previous.tools.get(upstream);
        let listed_tool = listed.iter().find(|t| &t.upstream_name == upstream);
        let (exposed_name, definition) = match listed_tool {
            Some(t) if t.definition_hash == decision.definition_hash => {
                (Some(t.exposed_name.clone()), Some(t.definition.clone()))
            }
            _ => match kept {
                Some(k) if k.def_hash == decision.definition_hash => {
                    (k.exposed_name.clone(), k.definition.clone())
                }
                _ => (None, None),
            },
        };
        guard.tools.insert(
            upstream.clone(),
            GuardToolPolicy {
                state: decision.state,
                def_hash: decision.definition_hash.clone(),
                exposed_name,
                definition,
                defer_loading: kept.and_then(|k| k.defer_loading),
                timeout_class: kept.and_then(|k| k.timeout_class),
            },
        );
    }
    policy::write_guard_policy(data_dir, project, name, &guard)
}

/// `true` unless the organization's `allowed_domains` patterns leave `target` out.
pub(crate) fn allowed_by_policy(
    target: &HostPort,
    managed: Option<&ManagedCustomMcpConfig>,
) -> bool {
    managed
        .and_then(|m| m.allowed_domains.as_ref())
        .is_none_or(|patterns| patterns.iter().any(|p| target.matches_pattern(p)))
}

fn effective_domains(
    entry: &CustomMcpEntry,
    managed: Option<&ManagedCustomMcpConfig>,
) -> Vec<HostPort> {
    entry
        .allowed_domains
        .iter()
        .filter(|d| allowed_by_policy(d, managed))
        .cloned()
        .collect()
}

fn change_domains(
    data_dir: &Path,
    project: &str,
    name: &str,
    managed: Option<&ManagedCustomMcpConfig>,
    change: impl FnOnce(&mut Vec<HostPort>) -> anyhow::Result<()>,
) -> Result<(), String> {
    with_active_project(data_dir, project, |cfg, path| {
        let before = std::fs::read_to_string(path).ok();
        let entry = entry_mut(cfg, project, name)?;
        if !matches!(entry.source, CustomMcpSource::Npm { .. }) {
            anyhow::bail!(
                "a server running on this computer has no internet allowlist in Speedwave"
            );
        }
        change(&mut entry.allowed_domains)?;
        entry.allowed_domains.sort();
        entry.allowed_domains.dedup();
        let egress = EgressConfig::new(&effective_domains(entry, managed));
        config::save_user_config_to(cfg, path)?;
        if let Err(e) = policy::write_egress_config(data_dir, project, name, &egress) {
            restore(path, before.as_deref())?;
            return Err(e);
        }
        Ok(())
    })
}

fn parse_target(host: &str, port: u16) -> anyhow::Result<HostPort> {
    HostPort::parse(&format!("{}:{port}", host.trim().to_ascii_lowercase()))
}

/// Lets a server reach `host:port` (no restart: the egress proxy re-reads its allowlist).
pub(crate) fn allow_domain_in(
    data_dir: &Path,
    project: &str,
    name: &str,
    host: &str,
    port: u16,
    managed: Option<&ManagedCustomMcpConfig>,
) -> Result<(), String> {
    let target = parse_target(host, port).map_err(|e| e.to_string())?;
    if !allowed_by_policy(&target, managed) {
        return Err(format!(
            "your organization does not allow servers to reach {}",
            target.host()
        ));
    }
    change_domains(data_dir, project, name, managed, |domains| {
        if !domains.contains(&target) && domains.len() >= MAX_ALLOWED_DOMAINS {
            anyhow::bail!("a server may reach at most {MAX_ALLOWED_DOMAINS} targets");
        }
        domains.push(target);
        Ok(())
    })
}

/// Stops a server from reaching `host:port` (no restart).
pub(crate) fn remove_domain_in(
    data_dir: &Path,
    project: &str,
    name: &str,
    host: &str,
    port: u16,
    managed: Option<&ManagedCustomMcpConfig>,
) -> Result<(), String> {
    let target = parse_target(host, port).map_err(|e| e.to_string())?;
    change_domains(data_dir, project, name, managed, |domains| {
        domains.retain(|d| *d != target);
        Ok(())
    })
}

fn remove_path(path: &Path) -> Result<(), String> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => std::fs::remove_dir_all(path),
        Ok(_) => std::fs::remove_file(path),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
    .map_err(|e| {
        failure::failure(
            failure::CLEANUP,
            "A leftover file of the server could not be deleted",
            format!("{}: {e}", path.display()),
        )
    })
}

/// Hooks [`remove_in`] calls between the config change and the cleanup.
pub(crate) struct RemoveHooks<'a> {
    /// Re-render and bring a running project up without the server.
    pub(crate) rerender: &'a dyn Fn(&LockedRuntime, &str) -> anyhow::Result<()>,
    /// Make the relay serve the remaining host servers.
    pub(crate) sync_relay: &'a dyn Fn(&[EffectiveCustomMcp]),
}

/// Revokes a server: engine readied first (networks are reaped only while the name is known),
/// entry removed, running project re-rendered, then networks, image and every state path go.
pub(crate) fn remove_in(
    data_dir: &Path,
    rt: &LockedRuntime,
    project: &str,
    name: &str,
    managed: Option<&ManagedCustomMcpConfig>,
    hooks: &RemoveHooks<'_>,
) -> Result<(), String> {
    model::validate_server_name(name).map_err(|e| e.to_string())?;
    rt.ensure_ready().map_err(|e| {
        failure::failure(
            failure::ENGINE,
            "The container engine must be running to remove a server. Start the project and retry",
            format!("{e:#}"),
        )
    })?;
    let remaining = with_active_project(data_dir, project, |cfg, path| {
        let servers = cfg
            .find_project_mut(project)
            .and_then(|p| p.custom_mcp.as_mut())
            .ok_or_else(|| anyhow::anyhow!("no custom MCP server named '{name}' in '{project}'"))?;
        if servers.remove(name).is_none() {
            anyhow::bail!("no custom MCP server named '{name}' in '{project}'");
        }
        config::save_user_config_to(cfg, path)?;
        Ok(resolve_for_project(cfg, project, managed).effective)
    })?;
    (hooks.sync_relay)(&remaining);
    let mut errors = Vec::new();
    if let Err(e) = (hooks.rerender)(rt, project) {
        errors.push(failure::failure(
            failure::ENGINE,
            "The containers could not be updated",
            format!("{e:#}"),
        ));
    }
    if let Err(e) = rt.remove_custom_mcp_server_networks(project, name) {
        errors.push(failure::failure(
            failure::ENGINE,
            "The networks of the server could not be removed",
            format!("{e:#}"),
        ));
    }
    if let Err(e) = speedwave_runtime::custom_mcp::build::prune_custom_images_in(
        rt, data_dir, project, &remaining, managed,
    ) {
        log::warn!("custom MCP server images of '{project}' could not be pruned: {e:#}");
    }
    let mut paths_to_remove = vec![speedwave_runtime::plugin::token_dir_in(
        data_dir,
        project,
        &model::service_id(name),
    )];
    paths_to_remove.extend(paths::server_dir_in(data_dir, project, name));
    paths_to_remove.extend(paths::relay_dir_in(data_dir, project, name));
    paths_to_remove.extend(catalog::catalog_path_in(data_dir, project, name));
    for path in paths_to_remove {
        if let Err(e) = remove_path(&path) {
            errors.push(e);
        }
    }
    log::info!("custom MCP server '{name}' removed from project '{project}'");
    if errors.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "The server was removed, but its cleanup was incomplete: {}",
            errors.join("; ")
        ))
    }
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "test assertions use unwrap/expect"
)]
mod tests {
    use super::*;
    use crate::custom_mcp_cmd::list::tests::speedwave_runtime_catalog_json;
    use crate::custom_mcp_cmd::tests_support::{
        fixture_config, host_entry, load, npm_entry, save, PROJECT,
    };
    use speedwave_runtime::custom_mcp::model::ToolDecisionState;
    use speedwave_runtime::custom_mcp::paths::ServerSubdir;
    use speedwave_runtime::runtime::mock_runtime::MockRuntimeBuilder;

    fn wall() -> chrono::DateTime<chrono::Utc> {
        chrono::DateTime::parse_from_rfc3339("2026-10-09T08:00:00Z")
            .unwrap()
            .with_timezone(&chrono::Utc)
    }

    fn setup(entries: Vec<(&str, CustomMcpEntry)>) -> tempfile::TempDir {
        let data = tempfile::tempdir().unwrap();
        let mut cfg = fixture_config(data.path());
        let servers = cfg.projects[0]
            .custom_mcp
            .get_or_insert_with(Default::default);
        for (name, entry) in entries {
            servers.insert(name.to_string(), entry);
        }
        save(data.path(), &cfg);
        data
    }

    fn entry(data: &Path, name: &str) -> CustomMcpEntry {
        load(data).projects[0].custom_mcp.as_ref().unwrap()[name].clone()
    }

    fn write_catalog(data: &Path, description: &str) -> String {
        let path = catalog::catalog_path_in(data, PROJECT, "figma").unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, speedwave_runtime_catalog_json("figma", description)).unwrap();
        catalog::read_catalog(data, PROJECT, "figma")
            .unwrap()
            .unwrap()[0]
            .definition_hash
            .clone()
    }

    fn decision(hash: &str, state: ToolDecisionState) -> CustomMcpToolDecisionArg {
        CustomMcpToolDecisionArg {
            upstream_name: "get-file".into(),
            state,
            definition_hash: hash.into(),
        }
    }

    #[test]
    fn tool_decisions_update_config_and_guard_policy_without_touching_consent() {
        let data = setup(vec![("figma", npm_entry(true))]);
        let digest = entry(data.path(), "figma").consent_digest;
        let hash = write_catalog(data.path(), "Fetch a file");
        set_tools_in(
            data.path(),
            PROJECT,
            "figma",
            &[decision(&hash, ToolDecisionState::Allowed)],
        )
        .unwrap();
        let saved = entry(data.path(), "figma");
        assert_eq!(saved.tools["get-file"].state, ToolDecisionState::Allowed);
        assert_eq!(saved.consent_digest, digest);
        assert!(policy::is_approved(&saved));
        let guard = policy::read_guard_policy(data.path(), PROJECT, "figma")
            .unwrap()
            .unwrap();
        let tool = &guard.tools["get-file"];
        assert_eq!(tool.state, ToolDecisionState::Allowed);
        assert_eq!(tool.def_hash, hash);
        assert_eq!(tool.exposed_name.as_deref(), Some("get_file"));
        assert_eq!(tool.definition.as_ref().unwrap()["name"], "get-file");
        assert_eq!(
            policy::definition_hash(tool.definition.as_ref().unwrap()).unwrap(),
            hash
        );
        assert_eq!(guard.consent_digest, digest);

        set_tools_in(
            data.path(),
            PROJECT,
            "figma",
            &[decision(&hash, ToolDecisionState::Blocked)],
        )
        .unwrap();
        let guard = policy::read_guard_policy(data.path(), PROJECT, "figma")
            .unwrap()
            .unwrap();
        assert_eq!(guard.tools["get-file"].state, ToolDecisionState::Blocked);
    }

    #[test]
    fn a_stale_hash_or_an_unlisted_tool_is_refused() {
        let data = setup(vec![("figma", npm_entry(true))]);
        let err = set_tools_in(data.path(), PROJECT, "figma", &[]).unwrap_err();
        assert!(err.contains("not available yet"), "{err}");
        let old = write_catalog(data.path(), "Fetch a file");
        write_catalog(data.path(), "Fetch a file, then delete it");
        let err = set_tools_in(
            data.path(),
            PROJECT,
            "figma",
            &[decision(&old, ToolDecisionState::Allowed)],
        )
        .unwrap_err();
        assert!(err.contains("changed since you reviewed it"), "{err}");
        let mut gone = decision(&old, ToolDecisionState::Allowed);
        gone.upstream_name = "delete-file".into();
        assert!(set_tools_in(data.path(), PROJECT, "figma", &[gone])
            .unwrap_err()
            .contains("no longer listed"));
        assert!(entry(data.path(), "figma").tools.is_empty());
        assert!(policy::read_guard_policy(data.path(), PROJECT, "figma")
            .unwrap()
            .is_none());
    }

    #[test]
    fn decisions_go_only_to_the_active_project_and_a_known_server() {
        let data = setup(vec![("figma", npm_entry(true))]);
        let hash = write_catalog(data.path(), "Fetch a file");
        let mut cfg = load(data.path());
        cfg.active_project = Some("other".into());
        save(data.path(), &cfg);
        assert!(set_tools_in(
            data.path(),
            PROJECT,
            "figma",
            &[decision(&hash, ToolDecisionState::Allowed)]
        )
        .unwrap_err()
        .contains("active project"));
        assert!(set_enabled_in(data.path(), PROJECT, "figma", false).is_err());
        cfg.active_project = Some(PROJECT.into());
        save(data.path(), &cfg);
        assert!(set_enabled_in(data.path(), PROJECT, "nope", false)
            .unwrap_err()
            .contains("no custom MCP server"));
        assert!(set_enabled_in(data.path(), "../x", "figma", false).is_err());
    }

    #[test]
    fn consented_changes_re_sign_an_approved_entry_and_its_guard_policy() {
        let data = setup(vec![("figma", npm_entry(true))]);
        let before = entry(data.path(), "figma").consent_digest.unwrap();
        set_pii_mode_in(
            data.path(),
            PROJECT,
            "figma",
            CustomPiiMode::Plaintext,
            None,
            wall(),
        )
        .unwrap();
        let after = entry(data.path(), "figma");
        assert_eq!(after.pii_mode, CustomPiiMode::Plaintext);
        assert!(policy::is_approved(&after));
        assert_ne!(after.consent_digest.as_deref(), Some(before.as_str()));
        assert_eq!(after.approved_at.as_deref(), Some("2026-10-09T08:00:00Z"));
        assert_eq!(
            policy::read_guard_policy(data.path(), PROJECT, "figma")
                .unwrap()
                .unwrap()
                .consent_digest,
            after.consent_digest
        );
        set_file_access_in(
            data.path(),
            PROJECT,
            "figma",
            WorkspaceMode::ReadOnly,
            None,
            wall(),
        )
        .unwrap();
        let after = entry(data.path(), "figma");
        assert_eq!(after.workspace_mode, WorkspaceMode::ReadOnly);
        assert!(policy::is_approved(&after));

        let cfg = load(data.path());
        let expected = speedwave_runtime::custom_mcp::expectations_for(&cfg, PROJECT, None);
        let server = expected
            .server("figma")
            .expect("the re-signed entry still renders and passes the start gate");
        assert_eq!(Some(&server.consent_digest), after.consent_digest.as_ref());
        assert_eq!(server.workspace_mode, WorkspaceMode::ReadOnly);
    }

    #[test]
    fn consented_changes_never_approve_an_unapproved_entry() {
        let data = setup(vec![("figma", npm_entry(false))]);
        set_pii_mode_in(
            data.path(),
            PROJECT,
            "figma",
            CustomPiiMode::Plaintext,
            None,
            wall(),
        )
        .unwrap();
        let after = entry(data.path(), "figma");
        assert!(after.consent_digest.is_none());
        assert!(!policy::is_approved(&after));
    }

    #[test]
    fn managed_policy_bounds_consented_changes() {
        let data = setup(vec![("figma", npm_entry(true))]);
        let forced = ManagedCustomMcpConfig {
            force_pii_mode: Some(CustomPiiMode::Tokens),
            max_workspace_mode: Some(WorkspaceMode::ReadOnly),
            ..Default::default()
        };
        assert!(set_pii_mode_in(
            data.path(),
            PROJECT,
            "figma",
            CustomPiiMode::Plaintext,
            Some(&forced),
            wall()
        )
        .is_err());
        assert!(set_file_access_in(
            data.path(),
            PROJECT,
            "figma",
            WorkspaceMode::ReadWrite,
            Some(&forced),
            wall()
        )
        .is_err());
        set_file_access_in(
            data.path(),
            PROJECT,
            "figma",
            WorkspaceMode::ReadOnly,
            Some(&forced),
            wall(),
        )
        .unwrap();
    }

    #[test]
    fn enabling_is_outside_the_consent() {
        let data = setup(vec![("figma", npm_entry(true))]);
        set_enabled_in(data.path(), PROJECT, "figma", false).unwrap();
        let e = entry(data.path(), "figma");
        assert!(!e.enabled);
        assert!(policy::is_approved(&e));
    }

    fn egress(data: &Path) -> serde_json::Value {
        let path = paths::subdir_in(data, PROJECT, "figma", ServerSubdir::Egress)
            .unwrap()
            .join(speedwave_runtime::consts::CUSTOM_MCP_EGRESS_CONFIG_FILE);
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    #[test]
    fn domains_are_validated_filtered_and_written_without_restart() {
        let data = setup(vec![("figma", npm_entry(true)), ("desk", host_entry(true))]);
        allow_domain_in(data.path(), PROJECT, "figma", "API.Figma.com", 443, None).unwrap();
        allow_domain_in(data.path(), PROJECT, "figma", "api.figma.com", 443, None).unwrap();
        assert_eq!(
            egress(data.path())["allow"],
            serde_json::json!(["api.figma.com:443"])
        );
        assert_eq!(entry(data.path(), "figma").allowed_domains.len(), 1);
        for (host, port) in [
            ("127.0.0.1", 443),
            ("*.figma.com", 443),
            ("a b", 443),
            ("x.com", 0),
        ] {
            assert!(
                allow_domain_in(data.path(), PROJECT, "figma", host, port, None).is_err(),
                "{host}"
            );
        }
        let managed = ManagedCustomMcpConfig {
            allowed_domains: Some(vec!["*.figma.com".into()]),
            ..Default::default()
        };
        assert!(allow_domain_in(
            data.path(),
            PROJECT,
            "figma",
            "evil.test",
            443,
            Some(&managed)
        )
        .unwrap_err()
        .contains("organization"));
        assert!(allow_domain_in(data.path(), PROJECT, "desk", "api.figma.com", 443, None).is_err());
        remove_domain_in(data.path(), PROJECT, "figma", "api.figma.com", 443, None).unwrap();
        assert_eq!(egress(data.path())["allow"], serde_json::json!([]));
        assert!(entry(data.path(), "figma").allowed_domains.is_empty());
        assert!(policy::is_approved(&entry(data.path(), "figma")));
    }

    #[test]
    fn removal_cleans_every_path_and_the_networks() {
        let data = setup(vec![("figma", npm_entry(true)), ("desk", host_entry(true))]);
        let tokens = speedwave_runtime::plugin::token_dir_in(data.path(), PROJECT, "custom-figma");
        std::fs::create_dir_all(&tokens).unwrap();
        std::fs::write(tokens.join("FIGMA_API_KEY"), "secret").unwrap();
        policy::write_guard_policy(
            data.path(),
            PROJECT,
            "figma",
            &GuardPolicy::empty("figma", GuardMode::Npm, None),
        )
        .unwrap();
        paths::ensure_relay_dir_in(data.path(), PROJECT, "figma").unwrap();
        write_catalog(data.path(), "Fetch a file");
        let (rt, handles) = MockRuntimeBuilder::new().build();
        let rerendered = std::cell::RefCell::new(Vec::new());
        let synced = std::cell::RefCell::new(Vec::new());
        remove_in(
            data.path(),
            &rt,
            PROJECT,
            "figma",
            None,
            &RemoveHooks {
                rerender: &|_, p| {
                    rerendered.borrow_mut().push(p.to_string());
                    Ok(())
                },
                sync_relay: &|servers| {
                    synced
                        .borrow_mut()
                        .extend(servers.iter().map(|s| s.name.clone()));
                },
            },
        )
        .unwrap();
        let servers = load(data.path()).projects[0].custom_mcp.clone().unwrap();
        assert!(!servers.contains_key("figma"));
        assert!(servers.contains_key("desk"));
        assert_eq!(rerendered.into_inner(), vec![PROJECT.to_string()]);
        assert_eq!(synced.into_inner(), vec!["desk".to_string()]);
        assert!(!tokens.exists());
        assert!(!paths::server_dir_in(data.path(), PROJECT, "figma")
            .unwrap()
            .exists());
        assert!(!paths::relay_dir_in(data.path(), PROJECT, "figma")
            .unwrap()
            .exists());
        assert!(!catalog::catalog_path_in(data.path(), PROJECT, "figma")
            .unwrap()
            .exists());
        let removed = handles.removed_networks();
        assert!(
            removed.iter().any(|n| n.ends_with("_cx_figma")),
            "{removed:?}"
        );
        assert_eq!(handles.ensure_ready_count(), 1);
    }

    #[test]
    fn removal_needs_the_engine_and_a_known_server() {
        let data = setup(vec![("figma", npm_entry(true))]);
        let hooks = RemoveHooks {
            rerender: &|_, _| Ok(()),
            sync_relay: &|_| {},
        };
        let (rt, _) = MockRuntimeBuilder::new()
            .with_ensure_ready_error("vm broken")
            .build();
        assert!(remove_in(data.path(), &rt, PROJECT, "figma", None, &hooks)
            .unwrap_err()
            .contains("engine"));
        assert!(load(data.path()).projects[0]
            .custom_mcp
            .as_ref()
            .unwrap()
            .contains_key("figma"));
        let (rt, _) = MockRuntimeBuilder::new().build();
        assert!(remove_in(data.path(), &rt, PROJECT, "nope", None, &hooks)
            .unwrap_err()
            .contains("no custom MCP server"));
        assert!(remove_in(data.path(), &rt, PROJECT, "../x", None, &hooks).is_err());
    }

    #[test]
    fn a_failed_rerender_is_reported_after_the_cleanup() {
        let data = setup(vec![("figma", npm_entry(true))]);
        let (rt, _) = MockRuntimeBuilder::new().build();
        let err = remove_in(
            data.path(),
            &rt,
            PROJECT,
            "figma",
            None,
            &RemoveHooks {
                rerender: &|_, _| anyhow::bail!("compose up failed"),
                sync_relay: &|_| {},
            },
        )
        .unwrap_err();
        assert!(err.contains("CMCP-ENGINE"), "{err}");
        assert!(!err.contains("compose up failed"), "{err}");
        assert!(!load(data.path()).projects[0]
            .custom_mcp
            .as_ref()
            .unwrap()
            .contains_key("figma"));
    }
}
