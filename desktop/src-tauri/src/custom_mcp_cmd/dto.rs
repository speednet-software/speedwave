use serde::{Deserialize, Serialize};
use speedwave_runtime::custom_mcp::catalog::ToolState;
use speedwave_runtime::custom_mcp::detect::Proposal;
use speedwave_runtime::custom_mcp::egress_log::EgressDenyReason;
use speedwave_runtime::custom_mcp::model::{
    CustomMcpSource, CustomPiiMode, ManagedCustomMcpConfig, ToolDecisionState, WorkspaceMode,
};
use std::collections::BTreeMap;

/// Lifecycle state of a configured server, as the UI shows it.
#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CustomMcpEntryState {
    Pending,
    Approved,
    Changed,
    Disabled,
    Unavailable,
    Excluded,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct CustomMcpForcedDto {
    pub(crate) pii_mode: Option<CustomPiiMode>,
    pub(crate) workspace_mode_max: Option<WorkspaceMode>,
    pub(crate) host_servers_disabled: bool,
    pub(crate) allowed_domains: Option<Vec<String>>,
    pub(crate) allowed_scopes: Option<Vec<String>>,
}

impl CustomMcpForcedDto {
    pub(crate) fn from_managed(managed: Option<&ManagedCustomMcpConfig>) -> Self {
        Self {
            pii_mode: managed.and_then(|m| m.force_pii_mode),
            workspace_mode_max: managed.and_then(|m| m.max_workspace_mode),
            host_servers_disabled: managed.and_then(|m| m.host_servers_enabled) == Some(false),
            allowed_domains: managed.and_then(|m| m.allowed_domains.clone()),
            allowed_scopes: managed.and_then(|m| m.allowed_scopes.clone()),
        }
    }
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum CustomMcpSourceDto {
    Npm {
        package: String,
        version: String,
        integrity: String,
    },
    Host {
        port: u16,
        path: String,
    },
}

impl From<&CustomMcpSource> for CustomMcpSourceDto {
    fn from(source: &CustomMcpSource) -> Self {
        match source {
            CustomMcpSource::Npm { lock } => Self::Npm {
                package: lock.package.clone(),
                version: lock.version.clone(),
                integrity: lock.integrity.clone(),
            },
            CustomMcpSource::Host { port, path } => Self::Host {
                port: *port,
                path: path.clone(),
            },
        }
    }
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub(crate) struct CustomMcpToolDto {
    pub(crate) exposed_name: String,
    pub(crate) upstream_name: String,
    pub(crate) state: ToolState,
    pub(crate) read_only_hint: Option<bool>,
    pub(crate) description_preview: String,
    pub(crate) definition_hash: String,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub(crate) struct CustomMcpEntryDto {
    pub(crate) name: String,
    pub(crate) service_id: String,
    pub(crate) source: CustomMcpSourceDto,
    pub(crate) state: CustomMcpEntryState,
    pub(crate) reason: Option<String>,
    pub(crate) enabled: bool,
    pub(crate) tools_available: bool,
    pub(crate) tools: Vec<CustomMcpToolDto>,
    pub(crate) pii_mode: CustomPiiMode,
    pub(crate) workspace_mode: WorkspaceMode,
    pub(crate) domains: Vec<String>,
    pub(crate) domains_blocked_by_policy: Vec<String>,
    pub(crate) warnings: Vec<String>,
    pub(crate) host_warning: bool,
    pub(crate) host_app_available: Option<bool>,
    pub(crate) proposed_by_repo: bool,
    pub(crate) approved_at: Option<String>,
    pub(crate) forced: CustomMcpForcedDto,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub(crate) struct CustomMcpListDto {
    pub(crate) project: String,
    pub(crate) beta_enabled: bool,
    pub(crate) managed_disabled: bool,
    pub(crate) servers: Vec<CustomMcpEntryDto>,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub(crate) struct CustomMcpDeniedHostDto {
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) count: u32,
    pub(crate) allowed_by_policy: bool,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub(crate) struct CustomMcpEgressRefusalDto {
    pub(crate) reason: EgressDenyReason,
    pub(crate) count: u32,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct CustomMcpEgressDenialsDto {
    pub(crate) container_running: bool,
    pub(crate) hosts: Vec<CustomMcpDeniedHostDto>,
    pub(crate) other: Vec<CustomMcpEgressRefusalDto>,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub(crate) struct CustomMcpProposalDto {
    #[serde(flatten)]
    pub(crate) proposal: Proposal,
    pub(crate) configured_as: Option<String>,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum CustomMcpPreviewDetailsDto {
    Npm(Box<NpmPreviewDto>),
    Host {
        port: u16,
        path: String,
        upstream_reachable: bool,
    },
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub(crate) struct NpmPreviewDto {
    pub(crate) package: String,
    pub(crate) version: String,
    pub(crate) integrity: String,
    pub(crate) published_at: String,
    pub(crate) license: Option<String>,
    pub(crate) dependency_count: usize,
    pub(crate) publisher: Option<String>,
    pub(crate) maintainers: Vec<String>,
    pub(crate) provenance: bool,
    pub(crate) previous_version: Option<String>,
    pub(crate) previous_publisher: Option<String>,
    pub(crate) publisher_changed: bool,
    pub(crate) has_install_script: bool,
    pub(crate) args: Vec<String>,
    pub(crate) env_keys: Vec<String>,
    pub(crate) image_tag: String,
    pub(crate) before_date: String,
    pub(crate) lockfile_sha256: String,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub(crate) struct CustomMcpPreviewDto {
    pub(crate) preview_id: String,
    pub(crate) expires_at: String,
    pub(crate) project: String,
    pub(crate) name: String,
    pub(crate) details: CustomMcpPreviewDetailsDto,
    pub(crate) host_warning: bool,
    pub(crate) proposed_by_repo: bool,
    pub(crate) forced: CustomMcpForcedDto,
    pub(crate) warnings: Vec<String>,
}

/// What `custom_mcp_preview` reviews.
#[derive(Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum CustomMcpPreviewRequest {
    Npm {
        name: String,
        package: String,
        version: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        env_keys: Vec<String>,
    },
    Host {
        name: String,
        port: u16,
        path: String,
    },
}

/// The review-screen choices. Carries credential values, so it has no `Debug`.
#[derive(Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub(crate) struct CustomMcpApproveChoices {
    pub(crate) name: String,
    pub(crate) pii_mode: CustomPiiMode,
    pub(crate) workspace_mode: WorkspaceMode,
    #[serde(default)]
    pub(crate) env_values: BTreeMap<String, String>,
}

#[derive(Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct CustomMcpToolDecisionArg {
    pub(crate) upstream_name: String,
    pub(crate) state: ToolDecisionState,
    pub(crate) definition_hash: String,
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "test assertions use unwrap/expect"
)]
pub(crate) mod tests {
    use super::*;
    use speedwave_runtime::custom_mcp::detect::{ProposalSource, ProposalStatus};

    const TS: &str = include_str!("../../../src/src/app/models/custom-mcp.ts");

    fn ts_union(name: &str) -> Vec<String> {
        let marker = format!("export type {name} =");
        let idx = TS
            .find(&marker)
            .unwrap_or_else(|| panic!("custom-mcp.ts must declare `{marker}`"));
        let body = TS[idx + marker.len()..].split(';').next().unwrap();
        let mut values: Vec<String> = body
            .split('|')
            .map(|s| s.trim().trim_matches('\'').to_string())
            .filter(|s| !s.is_empty())
            .collect();
        values.sort();
        values
    }

    fn ts_fields(name: &str) -> Vec<String> {
        let marker = format!("export interface {name} {{");
        let idx = TS
            .find(&marker)
            .unwrap_or_else(|| panic!("custom-mcp.ts must declare `{marker}`"));
        let body = TS[idx + marker.len()..].split("\n}").next().unwrap();
        let mut keys: Vec<String> = body
            .lines()
            .filter_map(|l| l.split(':').next())
            .map(|k| k.trim().trim_end_matches('?').to_string())
            .filter(|s| !s.is_empty() && !s.starts_with('/') && !s.starts_with('*'))
            .collect();
        keys.sort();
        keys
    }

    fn ts_kind(name: &str) -> String {
        let marker = format!("export interface {name} {{");
        let idx = TS.find(&marker).unwrap();
        let body = TS[idx + marker.len()..].split("\n}").next().unwrap();
        body.lines()
            .find_map(|l| l.trim().strip_prefix("kind: "))
            .map(|k| k.trim_end_matches(';').trim_matches('\'').to_string())
            .unwrap_or_else(|| panic!("{name} has no kind"))
    }

    fn rust_fields(value: &impl Serialize) -> Vec<String> {
        let mut keys: Vec<String> = serde_json::to_value(value)
            .unwrap()
            .as_object()
            .expect("serializes as an object")
            .keys()
            .cloned()
            .collect();
        keys.sort();
        keys
    }

    fn rust_strings<T: Serialize>(all: &[T]) -> Vec<String> {
        let mut values: Vec<String> = all
            .iter()
            .map(|v| {
                serde_json::to_value(v)
                    .unwrap()
                    .as_str()
                    .unwrap()
                    .to_string()
            })
            .collect();
        values.sort();
        values
    }

    fn kind_of(value: &impl Serialize) -> String {
        serde_json::to_value(value).unwrap()["kind"]
            .as_str()
            .unwrap()
            .to_string()
    }

    pub(crate) fn sample_entry() -> CustomMcpEntryDto {
        CustomMcpEntryDto {
            name: "figma".into(),
            service_id: "custom-figma".into(),
            source: CustomMcpSourceDto::Host {
                port: 3845,
                path: "/mcp".into(),
            },
            state: CustomMcpEntryState::Approved,
            reason: None,
            enabled: true,
            tools_available: true,
            tools: vec![sample_tool()],
            pii_mode: CustomPiiMode::Tokens,
            workspace_mode: WorkspaceMode::None,
            domains: vec![],
            domains_blocked_by_policy: vec![],
            warnings: vec![],
            host_warning: true,
            host_app_available: Some(true),
            proposed_by_repo: false,
            approved_at: None,
            forced: CustomMcpForcedDto::default(),
        }
    }

    fn sample_tool() -> CustomMcpToolDto {
        CustomMcpToolDto {
            exposed_name: "get_file".into(),
            upstream_name: "get_file".into(),
            state: ToolState::Pending,
            read_only_hint: None,
            description_preview: String::new(),
            definition_hash: String::new(),
        }
    }

    fn sample_npm_preview() -> NpmPreviewDto {
        NpmPreviewDto {
            package: "p".into(),
            version: "1.0.0".into(),
            integrity: String::new(),
            published_at: String::new(),
            license: None,
            dependency_count: 0,
            publisher: None,
            maintainers: vec![],
            provenance: false,
            previous_version: None,
            previous_publisher: None,
            publisher_changed: false,
            has_install_script: false,
            args: vec![],
            env_keys: vec![],
            image_tag: String::new(),
            before_date: String::new(),
            lockfile_sha256: String::new(),
        }
    }

    #[test]
    fn string_unions_match_ts() {
        assert_eq!(
            rust_strings(&[CustomPiiMode::Tokens, CustomPiiMode::Plaintext]),
            ts_union("CustomPiiMode")
        );
        assert_eq!(
            rust_strings(&[
                WorkspaceMode::None,
                WorkspaceMode::ReadOnly,
                WorkspaceMode::ReadWrite
            ]),
            ts_union("CustomWorkspaceMode")
        );
        let entry_states = [
            CustomMcpEntryState::Pending,
            CustomMcpEntryState::Approved,
            CustomMcpEntryState::Changed,
            CustomMcpEntryState::Disabled,
            CustomMcpEntryState::Unavailable,
            CustomMcpEntryState::Excluded,
        ];
        for s in entry_states {
            match s {
                CustomMcpEntryState::Pending
                | CustomMcpEntryState::Approved
                | CustomMcpEntryState::Changed
                | CustomMcpEntryState::Disabled
                | CustomMcpEntryState::Unavailable
                | CustomMcpEntryState::Excluded => {}
            }
        }
        assert_eq!(rust_strings(&entry_states), ts_union("CustomMcpEntryState"));
        let tool_states = [
            ToolState::Pending,
            ToolState::Allowed,
            ToolState::Blocked,
            ToolState::Changed,
        ];
        for s in tool_states {
            match s {
                ToolState::Pending
                | ToolState::Allowed
                | ToolState::Blocked
                | ToolState::Changed => {}
            }
        }
        assert_eq!(rust_strings(&tool_states), ts_union("CustomMcpToolState"));
        let decisions = [
            ToolDecisionState::Allowed,
            ToolDecisionState::Blocked,
            ToolDecisionState::Pending,
        ];
        for s in decisions {
            match s {
                ToolDecisionState::Allowed
                | ToolDecisionState::Blocked
                | ToolDecisionState::Pending => {}
            }
        }
        assert_eq!(
            rust_strings(&decisions),
            ts_union("CustomMcpToolDecisionState")
        );
        let statuses = [
            ProposalStatus::Ready,
            ProposalStatus::NeedsExactVersion,
            ProposalStatus::Remote,
            ProposalStatus::Unsupported,
        ];
        for s in statuses {
            match s {
                ProposalStatus::Ready
                | ProposalStatus::NeedsExactVersion
                | ProposalStatus::Remote
                | ProposalStatus::Unsupported => {}
            }
        }
        assert_eq!(rust_strings(&statuses), ts_union("CustomMcpProposalStatus"));
        assert_eq!(
            rust_strings(&EgressDenyReason::ALL),
            ts_union("CustomMcpEgressDenyReason")
        );
    }

    #[test]
    fn egress_denials_wire_matches_ts() {
        let host = CustomMcpDeniedHostDto {
            host: "api.figma.com".into(),
            port: 443,
            count: 3,
            allowed_by_policy: true,
        };
        let refusal = CustomMcpEgressRefusalDto {
            reason: EgressDenyReason::PrivateAddress,
            count: 2,
        };
        assert_eq!(rust_fields(&host), ts_fields("CustomMcpDeniedHost"));
        assert_eq!(rust_fields(&refusal), ts_fields("CustomMcpEgressRefusal"));
        let denials = CustomMcpEgressDenialsDto {
            container_running: true,
            hosts: vec![host],
            other: vec![refusal],
        };
        assert_eq!(rust_fields(&denials), ts_fields("CustomMcpEgressDenials"));
        assert_eq!(
            serde_json::to_value(&denials).unwrap(),
            serde_json::json!({
                "container_running": true,
                "hosts": [{"host": "api.figma.com", "port": 443, "count": 3, "allowed_by_policy": true}],
                "other": [{"reason": "private_address", "count": 2}],
            })
        );
    }

    #[test]
    fn wire_field_names_match_ts() {
        let entry = sample_entry();
        assert_eq!(rust_fields(&entry), ts_fields("CustomMcpEntry"));
        assert_eq!(rust_fields(&sample_tool()), ts_fields("CustomMcpTool"));
        assert_eq!(
            rust_fields(&CustomMcpForcedDto::default()),
            ts_fields("CustomMcpForced")
        );
        assert_eq!(
            rust_fields(&CustomMcpListDto {
                project: "p".into(),
                beta_enabled: true,
                managed_disabled: false,
                servers: vec![],
            }),
            ts_fields("CustomMcpList")
        );
        let npm_source = CustomMcpSourceDto::Npm {
            package: "p".into(),
            version: "1.0.0".into(),
            integrity: "i".into(),
        };
        assert_eq!(rust_fields(&npm_source), ts_fields("CustomMcpNpmSource"));
        assert_eq!(kind_of(&npm_source), ts_kind("CustomMcpNpmSource"));
        assert_eq!(rust_fields(&entry.source), ts_fields("CustomMcpHostSource"));
        assert_eq!(kind_of(&entry.source), ts_kind("CustomMcpHostSource"));

        let npm = CustomMcpPreviewDetailsDto::Npm(Box::new(sample_npm_preview()));
        assert_eq!(rust_fields(&npm), ts_fields("CustomMcpNpmPreview"));
        assert_eq!(kind_of(&npm), ts_kind("CustomMcpNpmPreview"));
        let host = CustomMcpPreviewDetailsDto::Host {
            port: 3845,
            path: "/mcp".into(),
            upstream_reachable: false,
        };
        assert_eq!(rust_fields(&host), ts_fields("CustomMcpHostPreview"));
        assert_eq!(kind_of(&host), ts_kind("CustomMcpHostPreview"));
        let preview = CustomMcpPreviewDto {
            preview_id: "id".into(),
            expires_at: "t".into(),
            project: "p".into(),
            name: "n".into(),
            details: host,
            host_warning: false,
            proposed_by_repo: false,
            forced: CustomMcpForcedDto::default(),
            warnings: vec![],
        };
        assert_eq!(rust_fields(&preview), ts_fields("CustomMcpPreview"));
    }

    #[test]
    fn proposal_wire_matches_ts() {
        let proposals = speedwave_runtime::custom_mcp::detect::parse_mcp_json(
            r#"{"mcpServers":{"a":{"command":"npx","args":["p@1.0.0"]},"b":{"url":"https://h.example/x"},"c":{"command":"uvx"}}}"#,
        )
        .unwrap();
        let dtos: Vec<CustomMcpProposalDto> = proposals
            .into_iter()
            .map(|proposal| CustomMcpProposalDto {
                proposal,
                configured_as: None,
            })
            .collect();
        assert_eq!(rust_fields(&dtos[0]), ts_fields("CustomMcpProposal"));
        let expected = [
            ("CustomMcpProposalNpmSource", &dtos[0]),
            ("CustomMcpProposalRemoteSource", &dtos[1]),
            ("CustomMcpProposalUnsupportedSource", &dtos[2]),
        ];
        for (ts_name, dto) in expected {
            assert_eq!(
                rust_fields(&dto.proposal.source),
                ts_fields(ts_name),
                "{ts_name}"
            );
            assert_eq!(kind_of(&dto.proposal.source), ts_kind(ts_name), "{ts_name}");
        }
        for source in [
            ProposalSource::Npm {
                package: String::new(),
                version: None,
            },
            ProposalSource::Remote {
                host: String::new(),
            },
            ProposalSource::Unsupported {
                command: String::new(),
            },
        ] {
            match source {
                ProposalSource::Npm { .. }
                | ProposalSource::Remote { .. }
                | ProposalSource::Unsupported { .. } => {}
            }
        }
    }

    #[test]
    fn request_shapes_match_ts() {
        let npm: CustomMcpPreviewRequest = serde_json::from_value(serde_json::json!({
            "kind": "npm", "name": "figma", "package": "p", "version": "1.0.0",
            "args": [], "env_keys": []
        }))
        .unwrap();
        assert!(matches!(npm, CustomMcpPreviewRequest::Npm { ref name, .. } if name == "figma"));
        let mut npm_fields: Vec<String> =
            ["kind", "name", "package", "version", "args", "env_keys"]
                .iter()
                .map(|s| s.to_string())
                .collect();
        npm_fields.sort();
        assert_eq!(npm_fields, ts_fields("CustomMcpNpmPreviewRequest"));
        let mut host_fields: Vec<String> = ["kind", "name", "port", "path"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        host_fields.sort();
        assert_eq!(host_fields, ts_fields("CustomMcpHostPreviewRequest"));
        let host: CustomMcpPreviewRequest = serde_json::from_value(serde_json::json!({
            "kind": "host", "name": "desk", "port": 3845, "path": "/mcp"
        }))
        .unwrap();
        assert!(matches!(
            host,
            CustomMcpPreviewRequest::Host { port: 3845, .. }
        ));
        assert!(
            serde_json::from_value::<CustomMcpPreviewRequest>(serde_json::json!({
                "kind": "host", "name": "desk", "port": 3845, "path": "/mcp", "extra": 1
            }))
            .is_err()
        );

        let choices: CustomMcpApproveChoices = serde_json::from_value(serde_json::json!({
            "name": "figma", "pii_mode": "tokens", "workspace_mode": "read_only",
            "env_values": {"K": "v"}
        }))
        .unwrap();
        assert_eq!(choices.workspace_mode, WorkspaceMode::ReadOnly);
        let mut choice_fields = vec!["env_values", "name", "pii_mode", "workspace_mode"];
        choice_fields.sort_unstable();
        assert_eq!(choice_fields, ts_fields("CustomMcpApproveChoices"));

        let decision: CustomMcpToolDecisionArg = serde_json::from_value(serde_json::json!({
            "upstream_name": "t", "state": "allowed", "definition_hash": "sha256:x"
        }))
        .unwrap();
        assert_eq!(decision.state, ToolDecisionState::Allowed);
        let mut decision_fields = vec!["definition_hash", "state", "upstream_name"];
        decision_fields.sort_unstable();
        assert_eq!(decision_fields, ts_fields("CustomMcpToolDecision"));
    }
}
