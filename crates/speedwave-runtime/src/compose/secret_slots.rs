use crate::config::ResolvedIntegrationsConfig;
use crate::consts::{self, McpServiceDescriptor};
use crate::git_allowlist::GitForgeService;
use crate::plugin::PluginManifest;
use crate::secrets_tmpfs::layout::{
    purpose_git_tokens, Slot, PURPOSE_AUTH, PURPOSE_CONFIG, PURPOSE_POLICY, PURPOSE_SECRETS,
    PURPOSE_TOKENS, VM_ROOT,
};

pub(super) const CLAUDE_SERVICE: &str = "claude";
pub(super) const HUB_SERVICE: &str = "mcp-hub";
pub(super) const PROXY_SERVICE: &str = "proxy";

pub(super) const WORKER_TOKENS_TARGET: &str = "/tokens";
pub(super) const WORKER_AUTH_TARGET: &str = "/run/speedwave/auth";
pub(super) const WORKER_AUTH_FILE: &str = "token";
pub(super) const HUB_SECRETS_TARGET: &str = "/secrets";
pub(super) const POLICY_TARGET: &str = "/policy";
pub(super) const PROXY_CONFIG_TARGET: &str = "/config";
pub(super) const PROXY_CONFIG_FILE: &str = "proxy.json";
pub(super) const CLAUDE_SECRETS_TARGET: &str = "/run/speedwave/secrets";

pub(super) const CLAUDE_API_KEY_FILE: &str = "anthropic-api-key";
pub(super) const CLAUDE_AUTH_TOKEN_FILE: &str = "anthropic-auth-token";
pub(super) const CLAUDE_CUSTOM_HEADERS_FILE: &str = "anthropic-custom-headers";
pub(super) const CALLER_TOKEN_FILE: &str = "caller-token";

pub(super) const OS_AUTH_TOKEN_FILE_NAME: &str = "os-auth-token";

pub(crate) struct SlotMount {
    pub(crate) slot: Slot,
    pub(super) target: String,
}

impl SlotMount {
    fn new(service: &str, purpose: &str, target: &str) -> anyhow::Result<Self> {
        Ok(Self {
            slot: Slot::new(service, purpose)?,
            target: target.to_string(),
        })
    }

    pub(super) fn source(&self, project: &str) -> String {
        self.slot.vm_dir(project)
    }

    pub(super) fn entry(&self, project: &str) -> String {
        format!("{}:{}:ro", self.source(project), self.target)
    }
}

pub(super) fn project_secrets_root(project: &str) -> String {
    format!("{VM_ROOT}/{project}")
}

pub(super) fn is_under_secrets_root(source: &str) -> bool {
    source == VM_ROOT || source.starts_with(&format!("{VM_ROOT}/"))
}

pub(crate) fn worker_tokens_mount(compose_name: &str) -> anyhow::Result<SlotMount> {
    SlotMount::new(compose_name, PURPOSE_TOKENS, WORKER_TOKENS_TARGET)
}

pub(super) fn worker_auth_mount(compose_name: &str) -> anyhow::Result<SlotMount> {
    SlotMount::new(compose_name, PURPOSE_AUTH, WORKER_AUTH_TARGET)
}

pub(super) fn hub_secrets_mount() -> anyhow::Result<SlotMount> {
    SlotMount::new(HUB_SERVICE, PURPOSE_SECRETS, HUB_SECRETS_TARGET)
}

pub(super) fn hub_policy_mount() -> anyhow::Result<SlotMount> {
    SlotMount::new(HUB_SERVICE, PURPOSE_POLICY, POLICY_TARGET)
}

pub(super) fn proxy_config_mount() -> anyhow::Result<SlotMount> {
    SlotMount::new(PROXY_SERVICE, PURPOSE_CONFIG, PROXY_CONFIG_TARGET)
}

pub(super) fn proxy_tokens_mount() -> anyhow::Result<SlotMount> {
    SlotMount::new(PROXY_SERVICE, PURPOSE_TOKENS, WORKER_TOKENS_TARGET)
}

pub(super) fn proxy_policy_mount() -> anyhow::Result<SlotMount> {
    SlotMount::new(PROXY_SERVICE, PURPOSE_POLICY, POLICY_TARGET)
}

pub(crate) fn proxy_git_mount(kind: GitForgeService) -> anyhow::Result<SlotMount> {
    SlotMount::new(
        PROXY_SERVICE,
        &purpose_git_tokens(kind.config_key()),
        &kind.token_mount_target(),
    )
}

pub(super) fn claude_secrets_mount() -> anyhow::Result<SlotMount> {
    SlotMount::new(CLAUDE_SERVICE, PURPOSE_SECRETS, CLAUDE_SECRETS_TARGET)
}

pub(crate) fn caller_token_vm_path(project: &str) -> anyhow::Result<String> {
    Ok(format!(
        "{}/{CALLER_TOKEN_FILE}",
        claude_secrets_mount()?.slot.vm_dir(project)
    ))
}

pub(crate) fn builtin_worker_has_tokens(svc: &McpServiceDescriptor) -> bool {
    !svc.credential_files.is_empty()
}

pub(crate) fn enabled_builtin_workers(
    integrations: &ResolvedIntegrationsConfig,
) -> impl Iterator<Item = &'static McpServiceDescriptor> + '_ {
    consts::TOGGLEABLE_MCP_SERVICES
        .iter()
        .filter(move |svc| integrations.is_service_enabled(svc.config_key) == Some(true))
}

pub(crate) struct PluginWorker<'a> {
    pub(crate) service_id: &'a str,
    pub(crate) compose_name: String,
    pub(crate) manifest: &'a PluginManifest,
}

pub(crate) fn enabled_plugin_workers<'a>(
    integrations: &'a ResolvedIntegrationsConfig,
    manifests: &'a [PluginManifest],
) -> impl Iterator<Item = PluginWorker<'a>> + 'a {
    manifests.iter().filter_map(move |manifest| {
        let sid = manifest.service_id.as_deref()?;
        integrations.is_plugin_enabled(sid).then(|| PluginWorker {
            service_id: sid,
            compose_name: crate::plugin::derive_compose_name(sid),
            manifest,
        })
    })
}

pub(super) fn expected_slot_mounts(
    service: &str,
    is_plugin: bool,
) -> anyhow::Result<Vec<SlotMount>> {
    let mounts = match service {
        CLAUDE_SERVICE => vec![claude_secrets_mount()],
        HUB_SERVICE => vec![hub_secrets_mount(), hub_policy_mount()],
        PROXY_SERVICE => [
            proxy_config_mount(),
            proxy_tokens_mount(),
            proxy_policy_mount(),
        ]
        .into_iter()
        .chain(GitForgeService::ALL.into_iter().map(proxy_git_mount))
        .collect(),
        _ if is_plugin => vec![worker_tokens_mount(service)],
        _ => match builtin_worker(service) {
            Some(svc) if builtin_worker_has_tokens(svc) => {
                vec![worker_tokens_mount(service), worker_auth_mount(service)]
            }
            Some(_) => vec![worker_auth_mount(service)],
            None => Vec::new(),
        },
    };
    mounts.into_iter().collect()
}

fn builtin_worker(compose_name: &str) -> Option<&'static McpServiceDescriptor> {
    consts::TOGGLEABLE_MCP_SERVICES
        .iter()
        .find(|svc| svc.compose_name == compose_name)
}

#[cfg(test)]
#[expect(clippy::unwrap_used, reason = "test assertions may unwrap freely")]
mod tests {
    use super::*;

    #[test]
    fn mount_entry_points_into_the_project_slot_read_only() {
        let mount = worker_tokens_mount("mcp-slack").unwrap();
        assert_eq!(
            mount.entry("acme"),
            "/run/speedwave-secrets/acme/mcp-slack/tokens:/tokens:ro"
        );
    }

    #[test]
    fn git_mount_targets_the_forge_directory() {
        let mount = proxy_git_mount(GitForgeService::Github).unwrap();
        assert_eq!(
            mount.entry("acme"),
            "/run/speedwave-secrets/acme/proxy/git-github:/git-tokens/github:ro"
        );
    }

    #[test]
    fn a_worker_expects_only_its_own_tokens_and_auth_slots() {
        let mounts = expected_slot_mounts("mcp-slack", false).unwrap();
        let sources: Vec<String> = mounts.iter().map(|m| m.source("p")).collect();
        assert_eq!(
            sources,
            [
                "/run/speedwave-secrets/p/mcp-slack/tokens",
                "/run/speedwave-secrets/p/mcp-slack/auth"
            ]
        );
    }

    #[test]
    fn a_worker_without_credentials_expects_only_its_auth_slot() {
        for name in ["mcp-office", "mcp-playwright"] {
            let mounts = expected_slot_mounts(name, false).unwrap();
            assert_eq!(mounts.len(), 1, "{name}");
            assert_eq!(mounts[0].target, "/run/speedwave/auth", "{name}");
        }
    }

    #[test]
    fn a_plugin_worker_expects_only_its_tokens_slot() {
        let mounts = expected_slot_mounts("mcp-example", true).unwrap();
        assert_eq!(mounts.len(), 1);
        assert_eq!(mounts[0].target, "/tokens");
    }

    #[test]
    fn an_unknown_service_expects_no_slot() {
        assert!(expected_slot_mounts("mcp-unknown", false)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn a_service_name_that_is_no_slot_component_is_an_error() {
        assert!(expected_slot_mounts("Not Valid", true).is_err());
    }

    #[test]
    fn secrets_root_membership_ignores_lookalike_prefixes() {
        assert!(is_under_secrets_root("/run/speedwave-secrets/p/x"));
        assert!(!is_under_secrets_root("/run/speedwave-secrets-evil/p/x"));
    }
}
