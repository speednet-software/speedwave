//! What the start gate expects of Custom MCP containers: the servers the current config runs,
//! derived from the user config at every gate, never from a rendered or snapshotted compose.

use super::effective::{resolve_for_project, EffectiveCustomMcp};
use super::model::{CustomMcpSource, ManagedCustomMcpConfig, WorkspaceMode};
use super::policy::GuardMode;

/// One server the gate accepts containers for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExpectedCustomServer {
    /// Server name.
    pub name: String,
    /// Consent digest recorded at approval (the label carries its first 16 hex characters).
    pub consent_digest: String,
    /// npm or host.
    pub mode: GuardMode,
    /// The approved server image (npm only).
    pub image_tag: Option<String>,
    /// The approved `/workspace` access of the server container.
    pub workspace_mode: WorkspaceMode,
}

/// The servers a project's compose may contain; empty means none may.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CustomMcpExpectations {
    servers: Vec<ExpectedCustomServer>,
}

impl CustomMcpExpectations {
    /// Expectations for an effective server set.
    pub fn from_effective(servers: &[EffectiveCustomMcp]) -> Self {
        Self {
            servers: servers
                .iter()
                .map(|s| ExpectedCustomServer {
                    name: s.name.clone(),
                    consent_digest: s.consent_digest.clone(),
                    mode: GuardMode::of(&s.source),
                    image_tag: match &s.source {
                        CustomMcpSource::Npm { lock } => Some(lock.image_tag.clone()),
                        CustomMcpSource::Host { .. } => None,
                    },
                    workspace_mode: s.workspace_mode,
                })
                .collect(),
        }
    }

    /// The expected server `name`, if the current config runs it.
    pub fn server(&self, name: &str) -> Option<&ExpectedCustomServer> {
        self.servers.iter().find(|s| s.name == name)
    }

    /// Every expected server, in name order.
    pub fn servers(&self) -> &[ExpectedCustomServer] {
        &self.servers
    }
}

/// The one builder every start gate uses: the servers `project` runs under the current user
/// config, beta flag and MDM `custom_mcp` policy.
pub fn expectations_for(
    user_config: &crate::config::SpeedwaveUserConfig,
    project: &str,
    managed: Option<&ManagedCustomMcpConfig>,
) -> CustomMcpExpectations {
    CustomMcpExpectations::from_effective(
        &resolve_for_project(user_config, project, managed).effective,
    )
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code: panics on setup failure are acceptable"
)]
mod tests {
    use super::*;
    use crate::custom_mcp::policy::tests::{approved, npm_entry};

    fn user(beta: bool) -> crate::config::SpeedwaveUserConfig {
        let mut user: crate::config::SpeedwaveUserConfig = serde_json::from_value(
            serde_json::json!({"projects": [{"name": "acme", "dir": "/tmp/acme"}]}),
        )
        .unwrap();
        let mut host = npm_entry();
        host.source = CustomMcpSource::Host {
            port: 3845,
            path: "/mcp".to_string(),
        };
        user.projects[0].custom_mcp = Some(
            [
                ("figma".to_string(), approved(npm_entry())),
                ("desk".to_string(), approved(host)),
                ("pending".to_string(), npm_entry()),
            ]
            .into_iter()
            .collect(),
        );
        user.ui = Some(crate::config::UiPrefsConfig {
            beta_enabled: Some(beta),
        });
        user
    }

    #[test]
    fn expectations_follow_the_effective_servers() {
        let exp = expectations_for(&user(true), "acme", None);
        let names: Vec<&str> = exp.servers().iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["desk", "figma"]);
        let figma = exp.server("figma").unwrap();
        assert_eq!(figma.mode, GuardMode::Npm);
        assert_eq!(
            figma.image_tag.as_deref(),
            Some("speedwave-mcp-custom-figma:0.6.1-0123456789abcdef")
        );
        assert_eq!(figma.consent_digest.len(), 64);
        assert_eq!(exp.server("desk").unwrap().mode, GuardMode::Host);
        assert!(exp.server("desk").unwrap().image_tag.is_none());
        assert!(exp.server("pending").is_none());
    }

    #[test]
    fn nothing_is_expected_without_beta_under_mdm_disable_or_for_another_project() {
        assert!(expectations_for(&user(false), "acme", None)
            .servers()
            .is_empty());
        let off = crate::custom_mcp::effective::unreadable_managed_policy();
        assert!(expectations_for(&user(true), "acme", Some(&off))
            .servers()
            .is_empty());
        assert!(expectations_for(&user(true), "other", None)
            .servers()
            .is_empty());
        assert!(CustomMcpExpectations::default().servers().is_empty());
    }
}
