use super::dto::{
    CustomMcpEntryDto, CustomMcpEntryState, CustomMcpForcedDto, CustomMcpListDto,
    CustomMcpSourceDto, CustomMcpToolDto,
};
use speedwave_runtime::compose::{AddressingMode, HostAddressing};
use speedwave_runtime::config::SpeedwaveUserConfig;
use speedwave_runtime::custom_mcp::catalog;
use speedwave_runtime::custom_mcp::effective::{
    resolve_for_project, CustomMcpResolution, ExclusionReason,
};
use speedwave_runtime::custom_mcp::failure;
use speedwave_runtime::custom_mcp::model::{
    self, CustomMcpEntry, CustomMcpSource, ManagedCustomMcpConfig,
};
use std::path::Path;

const DESCRIPTION_PREVIEW_CHARS: usize = 200;
const HOST_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(500);

/// Side-effecting probes a listing needs, injectable for tests.
pub(crate) struct HostProbes<'a> {
    /// Whether something listens on the host app's loopback port.
    pub(crate) app_available: &'a dyn Fn(u16) -> bool,
    /// Whether the host-server warning applies to a server on this port.
    pub(crate) warning: &'a dyn Fn(u16) -> bool,
}

/// The host-server warning: always on macOS, on Windows NAT when the port answers on the
/// containers' gateway, never under mirrored mode; unknown addressing warns.
pub(crate) fn host_warning_for(
    is_macos: bool,
    addressing: Option<&HostAddressing>,
    port: u16,
    reachable: &dyn Fn(&str, u16) -> bool,
) -> bool {
    if is_macos {
        return true;
    }
    match addressing {
        Some(a) if a.mode() == AddressingMode::MirroredRelay => false,
        Some(a) => reachable(a.gateway_ip(), port),
        None => true,
    }
}

fn gateway_reachable(ip: &str, port: u16) -> bool {
    ip.parse::<std::net::IpAddr>().is_ok_and(|ip| {
        std::net::TcpStream::connect_timeout(
            &std::net::SocketAddr::new(ip, port),
            HOST_PROBE_TIMEOUT,
        )
        .is_ok()
    })
}

/// [`host_warning_for`] on this host.
pub(crate) fn host_warning(port: u16) -> bool {
    host_warning_for(
        cfg!(target_os = "macos"),
        speedwave_runtime::compose::host_addressing().ok().as_ref(),
        port,
        &gateway_reachable,
    )
}

fn reason_tag(reason: &ExclusionReason) -> Option<String> {
    serde_json::to_value(reason)
        .ok()?
        .get("reason")?
        .as_str()
        .map(str::to_string)
}

fn state_for_exclusion(reason: &ExclusionReason) -> CustomMcpEntryState {
    match reason {
        ExclusionReason::Disabled => CustomMcpEntryState::Disabled,
        ExclusionReason::NotApproved => CustomMcpEntryState::Pending,
        ExclusionReason::ConsentChanged => CustomMcpEntryState::Changed,
        ExclusionReason::Invalid { .. }
        | ExclusionReason::BetaDisabled
        | ExclusionReason::ManagedDisabled
        | ExclusionReason::HostServersDisabled
        | ExclusionReason::ScopeNotAllowed
        | ExclusionReason::WorkspaceModeAboveLimit { .. }
        | ExclusionReason::OverLimit { .. } => CustomMcpEntryState::Excluded,
    }
}

fn partition_domains(
    entry: &CustomMcpEntry,
    managed: Option<&ManagedCustomMcpConfig>,
) -> (Vec<String>, Vec<String>) {
    let (allowed, blocked): (Vec<_>, Vec<_>) = entry
        .allowed_domains
        .iter()
        .partition(|d| super::edit::allowed_by_policy(d, managed));
    (
        allowed.into_iter().map(ToString::to_string).collect(),
        blocked.into_iter().map(ToString::to_string).collect(),
    )
}

/// One configured server as the UI shows it.
pub(crate) fn entry_dto(
    data_dir: &Path,
    project: &str,
    name: &str,
    entry: &CustomMcpEntry,
    resolution: &CustomMcpResolution,
    managed: Option<&ManagedCustomMcpConfig>,
    probes: &HostProbes<'_>,
) -> CustomMcpEntryDto {
    let mut warnings = Vec::new();
    let excluded = resolution.excluded.iter().find(|e| e.name == name);
    let host_port = match &entry.source {
        CustomMcpSource::Host { port, .. } => Some(*port),
        CustomMcpSource::Npm { .. } => None,
    };
    let host_app_available = host_port.map(|p| (probes.app_available)(p));
    let state = match excluded {
        Some(e) => {
            if let ExclusionReason::Invalid { detail } = &e.reason {
                warnings.push(detail.clone());
            }
            state_for_exclusion(&e.reason)
        }
        None if host_app_available == Some(false) => CustomMcpEntryState::Unavailable,
        None => CustomMcpEntryState::Approved,
    };
    let (tools_available, tools) = match catalog::read_catalog(data_dir, project, name) {
        Ok(Some(listed)) => (
            true,
            listed
                .iter()
                .map(|t| CustomMcpToolDto {
                    exposed_name: t.exposed_name.clone(),
                    upstream_name: t.upstream_name.clone(),
                    state: catalog::tool_state(
                        entry.tools.get(&t.upstream_name),
                        &t.definition_hash,
                    ),
                    read_only_hint: t.read_only_hint(),
                    description_preview: t.description_preview(DESCRIPTION_PREVIEW_CHARS),
                    definition_hash: t.definition_hash.clone(),
                })
                .collect(),
        ),
        Ok(None) => (false, Vec::new()),
        Err(e) => {
            warnings.push(failure::failure(
                failure::CATALOG,
                "The tool list of this server could not be read",
                format!("{e:#}"),
            ));
            (false, Vec::new())
        }
    };
    let (domains, domains_blocked_by_policy) = partition_domains(entry, managed);
    CustomMcpEntryDto {
        name: name.to_string(),
        service_id: model::service_id(name),
        source: CustomMcpSourceDto::from(&entry.source),
        state,
        reason: excluded.and_then(|e| reason_tag(&e.reason)),
        enabled: entry.enabled,
        tools_available,
        tools,
        pii_mode: entry.pii_mode,
        workspace_mode: entry.workspace_mode,
        domains,
        domains_blocked_by_policy,
        warnings,
        host_warning: host_port.is_some_and(|p| (probes.warning)(p)),
        host_app_available,
        proposed_by_repo: entry.proposed_by_repo,
        approved_at: entry.approved_at.clone(),
        forced: CustomMcpForcedDto::from_managed(managed),
    }
}

/// Every configured server of `project`, merged with what runs and why the rest does not.
pub(crate) fn list_for(
    data_dir: &Path,
    user_config: &SpeedwaveUserConfig,
    project: &str,
    managed: Option<&ManagedCustomMcpConfig>,
    probes: &HostProbes<'_>,
) -> Result<CustomMcpListDto, String> {
    let entry = user_config
        .find_project(project)
        .ok_or_else(|| format!("project '{project}' not found"))?;
    let resolution = resolve_for_project(user_config, project, managed);
    let servers = entry
        .custom_mcp
        .iter()
        .flatten()
        .map(|(name, e)| entry_dto(data_dir, project, name, e, &resolution, managed, probes))
        .collect();
    Ok(CustomMcpListDto {
        project: project.to_string(),
        beta_enabled: user_config.beta_enabled(),
        managed_disabled: managed.and_then(|m| m.enabled) == Some(false),
        servers,
    })
}

#[cfg(test)]
#[expect(clippy::unwrap_used, reason = "test assertions use unwrap/expect")]
pub(crate) mod tests {
    use super::*;
    use crate::custom_mcp_cmd::tests_support::{fixture_config, host_entry, npm_entry, PROJECT};
    use speedwave_runtime::custom_mcp::catalog::ToolState;
    use speedwave_runtime::custom_mcp::model::{
        CustomToolDecision, HostPort, ToolDecisionState, WorkspaceMode,
    };

    type Probe = Box<dyn Fn(u16) -> bool>;

    pub(crate) fn probes(available: bool) -> (Probe, Probe) {
        (Box::new(move |_| available), Box::new(|_| true))
    }

    fn list(
        data: &Path,
        cfg: &SpeedwaveUserConfig,
        managed: Option<&ManagedCustomMcpConfig>,
        available: bool,
    ) -> CustomMcpListDto {
        let (a, w) = probes(available);
        list_for(
            data,
            cfg,
            PROJECT,
            managed,
            &HostProbes {
                app_available: &*a,
                warning: &*w,
            },
        )
        .unwrap()
    }

    fn write_catalog(data: &Path, name: &str, description: &str) -> String {
        let text = speedwave_runtime_catalog_json(name, description);
        let path = catalog::catalog_path_in(data, PROJECT, name).unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, text).unwrap();
        catalog::read_catalog(data, PROJECT, name).unwrap().unwrap()[0]
            .definition_hash
            .clone()
    }

    pub(crate) fn speedwave_runtime_catalog_json(name: &str, description: &str) -> String {
        serde_json::json!({
            "schema": 1,
            "service": model::service_id(name),
            "written_at": "2026-10-08T10:00:00.000Z",
            "tools": [{
                "name": "get_file",
                "upstream_name": "get-file",
                "description": description,
                "inputSchema": {"type": "object"},
                "annotations": {"readOnlyHint": true},
                "state": "allowed",
            }],
        })
        .to_string()
    }

    #[test]
    fn states_follow_approval_toggle_and_host_availability() {
        let data = tempfile::tempdir().unwrap();
        let mut cfg = fixture_config(data.path());
        let servers = cfg.projects[0]
            .custom_mcp
            .get_or_insert_with(Default::default);
        servers.insert("figma".into(), npm_entry(true));
        servers.insert("pending".into(), npm_entry(false));
        let mut off = npm_entry(true);
        off.enabled = false;
        servers.insert("off".into(), off);
        let mut changed = npm_entry(true);
        changed.workspace_mode = WorkspaceMode::ReadWrite;
        servers.insert("changed".into(), changed);
        servers.insert("desk".into(), host_entry(true));
        let dto = list(data.path(), &cfg, None, false);
        let by = |n: &str| dto.servers.iter().find(|s| s.name == n).unwrap();
        assert_eq!(by("figma").state, CustomMcpEntryState::Approved);
        assert_eq!(by("pending").state, CustomMcpEntryState::Pending);
        assert_eq!(by("pending").reason.as_deref(), Some("not_approved"));
        assert_eq!(by("off").state, CustomMcpEntryState::Disabled);
        assert_eq!(by("changed").state, CustomMcpEntryState::Changed);
        assert_eq!(by("desk").state, CustomMcpEntryState::Unavailable);
        assert_eq!(by("desk").host_app_available, Some(false));
        assert!(by("desk").host_warning);
        assert!(!by("figma").host_warning);
        assert_eq!(by("figma").host_app_available, None);
        assert!(dto.beta_enabled);
        let dto = list(data.path(), &cfg, None, true);
        assert_eq!(
            dto.servers.iter().find(|s| s.name == "desk").unwrap().state,
            CustomMcpEntryState::Approved
        );
    }

    #[test]
    fn managed_policy_excludes_and_reports_forced_fields() {
        let data = tempfile::tempdir().unwrap();
        let mut cfg = fixture_config(data.path());
        let mut figma = npm_entry(true);
        figma.allowed_domains = vec![
            HostPort::parse("api.figma.com:443").unwrap(),
            HostPort::parse("cdn.evil.test:443").unwrap(),
        ];
        let servers = cfg.projects[0]
            .custom_mcp
            .get_or_insert_with(Default::default);
        servers.insert("figma".into(), figma);
        servers.insert("desk".into(), host_entry(true));
        let managed = ManagedCustomMcpConfig {
            host_servers_enabled: Some(false),
            allowed_domains: Some(vec!["*.figma.com".into()]),
            force_pii_mode: Some(model::CustomPiiMode::Plaintext),
            ..Default::default()
        };
        let dto = list(data.path(), &cfg, Some(&managed), true);
        let desk = dto.servers.iter().find(|s| s.name == "desk").unwrap();
        assert_eq!(desk.state, CustomMcpEntryState::Excluded);
        assert_eq!(desk.reason.as_deref(), Some("host_servers_disabled"));
        let figma = dto.servers.iter().find(|s| s.name == "figma").unwrap();
        assert_eq!(figma.domains, vec!["api.figma.com:443"]);
        assert_eq!(figma.domains_blocked_by_policy, vec!["cdn.evil.test:443"]);
        assert!(figma.forced.host_servers_disabled);
        assert_eq!(figma.forced.pii_mode, Some(model::CustomPiiMode::Plaintext));
        let off = ManagedCustomMcpConfig {
            enabled: Some(false),
            ..Default::default()
        };
        let dto = list(data.path(), &cfg, Some(&off), true);
        assert!(dto.managed_disabled);
        assert!(dto
            .servers
            .iter()
            .all(|s| s.reason.as_deref() == Some("managed_disabled")));
    }

    #[test]
    fn tool_states_move_pending_allowed_changed_with_the_catalog() {
        let data = tempfile::tempdir().unwrap();
        let mut cfg = fixture_config(data.path());
        cfg.projects[0]
            .custom_mcp
            .get_or_insert_with(Default::default)
            .insert("figma".into(), npm_entry(true));
        let first = list(data.path(), &cfg, None, true);
        assert!(!first.servers[0].tools_available);
        assert!(first.servers[0].tools.is_empty());

        let hash = write_catalog(data.path(), "figma", "Fetch a file");
        let tool = &list(data.path(), &cfg, None, true).servers[0].tools[0];
        assert_eq!(tool.state, ToolState::Pending);
        assert_eq!(tool.upstream_name, "get-file");
        assert_eq!(tool.exposed_name, "get_file");
        assert_eq!(tool.read_only_hint, Some(true));
        assert_eq!(tool.definition_hash, hash);

        cfg.projects[0]
            .custom_mcp
            .as_mut()
            .unwrap()
            .get_mut("figma")
            .unwrap()
            .tools
            .insert(
                "get-file".into(),
                CustomToolDecision {
                    state: ToolDecisionState::Allowed,
                    definition_hash: hash,
                },
            );
        let tool = &list(data.path(), &cfg, None, true).servers[0].tools[0];
        assert_eq!(tool.state, ToolState::Allowed);

        write_catalog(data.path(), "figma", "Fetch a file and post it elsewhere");
        let tool = &list(data.path(), &cfg, None, true).servers[0].tools[0];
        assert_eq!(tool.state, ToolState::Changed);
    }

    #[test]
    fn a_torn_catalog_makes_the_tool_list_unavailable_with_a_warning() {
        let data = tempfile::tempdir().unwrap();
        let mut cfg = fixture_config(data.path());
        cfg.projects[0]
            .custom_mcp
            .get_or_insert_with(Default::default)
            .insert("figma".into(), npm_entry(true));
        let path = catalog::catalog_path_in(data.path(), PROJECT, "figma").unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, r#"{"schema":1,"serv"#).unwrap();
        let dto = list(data.path(), &cfg, None, true);
        assert!(!dto.servers[0].tools_available);
        assert_eq!(dto.servers[0].warnings.len(), 1);
    }

    #[test]
    fn unknown_projects_are_an_error() {
        let data = tempfile::tempdir().unwrap();
        let cfg = fixture_config(data.path());
        let (a, w) = probes(true);
        let probes = HostProbes {
            app_available: &*a,
            warning: &*w,
        };
        assert!(list_for(data.path(), &cfg, "nope", None, &probes).is_err());
    }

    #[test]
    fn the_host_warning_follows_platform_and_addressing() {
        let never = |_: &str, _: u16| false;
        let always = |_: &str, _: u16| true;
        assert!(host_warning_for(true, None, 3845, &never));
        let nat = HostAddressing::direct("172.20.0.1", "172.20.0.1");
        assert!(host_warning_for(false, Some(&nat), 3845, &always));
        assert!(!host_warning_for(false, Some(&nat), 3845, &never));
        let mirrored = HostAddressing::mirrored_relay();
        assert!(!host_warning_for(false, Some(&mirrored), 3845, &always));
        assert!(host_warning_for(false, None, 3845, &never));
        let probed = std::cell::RefCell::new(Vec::new());
        let record = |ip: &str, port: u16| {
            probed.borrow_mut().push((ip.to_string(), port));
            false
        };
        host_warning_for(false, Some(&nat), 4000, &record);
        assert_eq!(probed.into_inner(), vec![("172.20.0.1".to_string(), 4000)]);
    }
}
