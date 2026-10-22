use super::dto::{CustomMcpDeniedHostDto, CustomMcpEgressDenialsDto, CustomMcpEgressRefusalDto};
use speedwave_runtime::config::SpeedwaveUserConfig;
use speedwave_runtime::custom_mcp::egress_log::{self, MAX_DENIED_HOSTS};
use speedwave_runtime::custom_mcp::failure;
use speedwave_runtime::custom_mcp::model::{self, CustomMcpSource, ManagedCustomMcpConfig};
use speedwave_runtime::runtime::LockedRuntime;

fn engine_unreadable(cause: anyhow::Error) -> String {
    failure::failure(
        failure::ENGINE,
        "The blocked connections of this server could not be read from the container engine",
        format!("{cause:#}"),
    )
}

/// Connections the egress proxy of npm server `name` refused, read from its container log.
/// A project that is not active, not rendered or not running, an engine that is down, and an
/// egress container that is not up give an empty summary with `container_running: false`.
pub(crate) fn egress_denials_for(
    user_config: &SpeedwaveUserConfig,
    managed: Option<&ManagedCustomMcpConfig>,
    rt: &LockedRuntime,
    has_compose_file: &dyn Fn(&str) -> bool,
    project: &str,
    name: &str,
) -> Result<CustomMcpEgressDenialsDto, String> {
    crate::types::check_project(project)?;
    model::validate_server_name(name).map_err(|e| e.to_string())?;
    let entry = user_config
        .find_project(project)
        .ok_or_else(|| format!("project '{project}' not found"))?
        .custom_mcp
        .as_ref()
        .and_then(|servers| servers.get(name))
        .ok_or_else(|| format!("no custom MCP server named '{name}' in '{project}'"))?;
    if !matches!(entry.source, CustomMcpSource::Npm { .. }) {
        return Err("a server running on this computer has no egress proxy in Speedwave".into());
    }
    if user_config.active_project.as_deref() != Some(project)
        || !has_compose_file(project)
        || !rt.is_available()
    {
        return Ok(CustomMcpEgressDenialsDto::default());
    }
    let container = egress_log::egress_container_name(project, name);
    let ps = rt.compose_ps(project).map_err(engine_unreadable)?;
    let expected = speedwave_runtime::consts::strip_compose_container_prefix(&container, project);
    let running = crate::health::parse_container_entries(&ps, project)
        .iter()
        .any(|c| c.healthy && c.name == expected);
    if !running {
        return Ok(CustomMcpEgressDenialsDto::default());
    }
    let log = rt
        .container_logs(&container, egress_log::LOG_TAIL_LINES)
        .map_err(engine_unreadable)?;
    let summary = egress_log::denials(&log, &entry.allowed_domains, MAX_DENIED_HOSTS);
    log::debug!(
        "egress of custom MCP server '{name}' refused {} hosts outside its allowlist",
        summary.hosts.len()
    );
    Ok(CustomMcpEgressDenialsDto {
        container_running: true,
        hosts: summary
            .hosts
            .into_iter()
            .map(|h| CustomMcpDeniedHostDto {
                allowed_by_policy: super::edit::allowed_by_policy(&h.host_port, managed),
                host: h.host_port.host().to_string(),
                port: h.host_port.port(),
                count: h.count,
            })
            .collect(),
        other: summary
            .other
            .into_iter()
            .map(|(reason, count)| CustomMcpEgressRefusalDto { reason, count })
            .collect(),
    })
}

#[cfg(test)]
#[expect(clippy::unwrap_used, reason = "test assertions use unwrap")]
mod tests {
    use super::*;
    use crate::custom_mcp_cmd::tests_support::{fixture_config, host_entry, npm_entry, PROJECT};
    use speedwave_runtime::custom_mcp::egress_log::EgressDenyReason;
    use speedwave_runtime::custom_mcp::model::{CustomMcpEntry, HostPort};
    use speedwave_runtime::runtime::mock_runtime::{MockHandles, MockRuntimeBuilder};

    fn config(entries: Vec<(&str, CustomMcpEntry)>) -> (tempfile::TempDir, SpeedwaveUserConfig) {
        let data = tempfile::tempdir().unwrap();
        let mut cfg = fixture_config(data.path());
        let servers = cfg.projects[0]
            .custom_mcp
            .get_or_insert_with(Default::default);
        for (name, entry) in entries {
            servers.insert(name.to_string(), entry);
        }
        (data, cfg)
    }

    fn deny(host: &str, reason: &str) -> String {
        serde_json::json!({"event":"egress","decision":"deny","host":host,"port":443,"reason":reason})
            .to_string()
    }

    fn egress_row(state: &str) -> serde_json::Value {
        serde_json::json!({
            "Name": egress_log::egress_container_name(PROJECT, "figma"),
            "State": state,
        })
    }

    fn running_rt(log: &str) -> (LockedRuntime, MockHandles) {
        MockRuntimeBuilder::new()
            .with_ps_response(PROJECT, vec![egress_row("running")])
            .with_container_logs_response(log)
            .build()
    }

    fn rendered(_: &str) -> bool {
        true
    }

    fn sample_log() -> String {
        [
            deny("api.figma.com", "not_allowlisted"),
            deny("api.figma.com", "not_allowlisted"),
            deny("cdn.x.io", "not_allowlisted"),
            deny("allowed.figma.com", "not_allowlisted"),
            deny("10.0.0.1", "ip_literal"),
            deny("internal.example.com", "private_address"),
        ]
        .join("\n")
    }

    #[test]
    fn refused_hosts_are_listed_with_the_policy_verdict() {
        let mut figma = npm_entry(true);
        figma.allowed_domains = vec![HostPort::parse("allowed.figma.com:443").unwrap()];
        let (_data, cfg) = config(vec![("figma", figma)]);
        let (rt, handles) = running_rt(&sample_log());
        let managed = ManagedCustomMcpConfig {
            allowed_domains: Some(vec!["*.figma.com".into()]),
            ..Default::default()
        };
        let dto =
            egress_denials_for(&cfg, Some(&managed), &rt, &rendered, PROJECT, "figma").unwrap();
        assert!(dto.container_running);
        assert_eq!(
            dto.hosts,
            vec![
                CustomMcpDeniedHostDto {
                    host: "api.figma.com".into(),
                    port: 443,
                    count: 2,
                    allowed_by_policy: true,
                },
                CustomMcpDeniedHostDto {
                    host: "cdn.x.io".into(),
                    port: 443,
                    count: 1,
                    allowed_by_policy: false,
                },
            ]
        );
        assert_eq!(
            dto.other,
            vec![
                CustomMcpEgressRefusalDto {
                    reason: EgressDenyReason::IpLiteral,
                    count: 1,
                },
                CustomMcpEgressRefusalDto {
                    reason: EgressDenyReason::PrivateAddress,
                    count: 1,
                },
            ]
        );
        assert_eq!(
            *handles.logs_calls.lock().unwrap(),
            vec![egress_log::egress_container_name(PROJECT, "figma")]
        );
        let unmanaged = egress_denials_for(&cfg, None, &rt, &rendered, PROJECT, "figma").unwrap();
        assert!(unmanaged.hosts.iter().all(|h| h.allowed_by_policy));
    }

    #[test]
    fn invalid_names_unknown_servers_and_host_servers_are_refused() {
        let (_data, cfg) = config(vec![("figma", npm_entry(true)), ("desk", host_entry(true))]);
        let (rt, handles) = running_rt(&sample_log());
        for (project, name, expected) in [
            ("../escape", "figma", ""),
            (PROJECT, "Figma", "lowercase"),
            (PROJECT, "guard", "reserved"),
            ("other", "figma", "not found"),
            (PROJECT, "missing", "no custom MCP server"),
            (PROJECT, "desk", "no egress proxy"),
        ] {
            let err = egress_denials_for(&cfg, None, &rt, &rendered, project, name).unwrap_err();
            assert!(err.contains(expected), "{project}/{name}: {err}");
        }
        assert!(handles.ps_projects().is_empty());
        assert!(handles.logs_calls.lock().unwrap().is_empty());
    }

    #[test]
    fn a_server_that_is_not_running_gives_an_empty_summary() {
        let (_data, mut cfg) = config(vec![("figma", npm_entry(true))]);
        let not_running = CustomMcpEgressDenialsDto::default();
        let (rt, _) = running_rt(&sample_log());
        assert_eq!(
            egress_denials_for(&cfg, None, &rt, &|_| false, PROJECT, "figma").unwrap(),
            not_running
        );
        let (down, handles) = MockRuntimeBuilder::new()
            .with_is_available(false)
            .with_container_logs_response(&sample_log())
            .build();
        assert_eq!(
            egress_denials_for(&cfg, None, &down, &rendered, PROJECT, "figma").unwrap(),
            not_running
        );
        assert!(handles.ps_projects().is_empty());
        for rows in [
            vec![],
            vec![egress_row("exited")],
            vec![
                serde_json::json!({"Name": "speedwave_acme_mcp_custom_other_egress", "State": "running"}),
            ],
        ] {
            let (rt, handles) = MockRuntimeBuilder::new()
                .with_ps_response(PROJECT, rows)
                .with_container_logs_response(&sample_log())
                .build();
            assert_eq!(
                egress_denials_for(&cfg, None, &rt, &rendered, PROJECT, "figma").unwrap(),
                not_running
            );
            assert!(handles.logs_calls.lock().unwrap().is_empty());
        }
        cfg.active_project = Some("elsewhere".into());
        let (rt, handles) = running_rt(&sample_log());
        assert_eq!(
            egress_denials_for(&cfg, None, &rt, &rendered, PROJECT, "figma").unwrap(),
            not_running
        );
        assert!(handles.ps_projects().is_empty());
    }

    #[test]
    fn engine_errors_are_reported() {
        let (_data, cfg) = config(vec![("figma", npm_entry(true))]);
        let (rt, _) = MockRuntimeBuilder::new()
            .with_ps_error("compose ps failed")
            .build();
        let err = egress_denials_for(&cfg, None, &rt, &rendered, PROJECT, "figma").unwrap_err();
        assert!(err.contains("CMCP-ENGINE"), "{err}");
        assert!(!err.contains("compose ps failed"), "{err}");
        let (rt, _) = MockRuntimeBuilder::new()
            .with_ps_response(PROJECT, vec![egress_row("running")])
            .with_container_logs_error("logs failed")
            .build();
        let err = egress_denials_for(&cfg, None, &rt, &rendered, PROJECT, "figma").unwrap_err();
        assert!(err.contains("CMCP-ENGINE"), "{err}");
        assert!(!err.contains("logs failed"), "{err}");
    }

    #[test]
    fn a_running_server_without_refusals_gives_an_empty_list() {
        let (_data, cfg) = config(vec![("figma", npm_entry(true))]);
        let (rt, _) = running_rt(
            r#"{"event":"egress","decision":"allow","host":"api.figma.com","port":443,"reason":null}"#,
        );
        let dto = egress_denials_for(&cfg, None, &rt, &rendered, PROJECT, "figma").unwrap();
        assert_eq!(
            dto,
            CustomMcpEgressDenialsDto {
                container_running: true,
                hosts: vec![],
                other: vec![],
            }
        );
    }
}
