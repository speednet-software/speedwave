//! Custom MCP servers in the project compose: per npm server a guard, the server and its egress
//! proxy on the server's own networks, per host server a guard (`custom_host`), and the hub wiring.

use super::{custom_host, init_secrets_dir_in, inject_worker_env, networks, workers};
use crate::bundle::BundleManifest;
use crate::consts;
use crate::custom_mcp::effective::EffectiveCustomMcp;
use crate::custom_mcp::model::{CustomMcpLock, CustomMcpSource, WorkspaceMode};
use crate::custom_mcp::paths::{self, ServerSubdir};
use crate::custom_mcp::policy::{self, EgressConfig, GuardMode, GuardPolicy};
use crate::engine_path::{str_to_engine_path, to_engine_path};
use crate::{build, plugin, resources};
use serde_yaml_ng::{Mapping, Value};
use std::path::Path;

/// Label naming a Custom MCP container's role (`guard`, `server`, `egress`).
pub(crate) const ROLE_LABEL: &str = "speedwave.custom-mcp-role";
/// Label naming the Custom MCP server a container belongs to.
pub(crate) const ID_LABEL: &str = "speedwave.custom-mcp-id";
/// Label carrying the first 16 hex characters of the server's consent digest.
pub(crate) const CONSENT_LABEL: &str = "speedwave.custom-mcp-consent";
/// Port the egress proxy listens on inside `_cx_<name>`.
pub(crate) const EGRESS_PORT: u16 = 3128;
/// Entrypoint of the egress container (the second binary of the proxy image).
pub(crate) const EGRESS_ENTRYPOINT: &str = "/spw-egress";
/// Length of the consent digest prefix in [`CONSENT_LABEL`].
pub(crate) const CONSENT_LABEL_CHARS: usize = 16;
/// The only `security_opt` entry of a Custom MCP container.
pub(crate) const NO_NEW_PRIVILEGES: &str = "no-new-privileges:true";
/// The only `tmpfs` entry of a Custom MCP container, before its size.
pub(crate) const TMPFS_PREFIX: &str = "/tmp:noexec,nosuid,size=";

/// One container of a Custom MCP server.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Role {
    /// The guard the hub talks to.
    Guard,
    /// The npm server (launcher + package).
    Server,
    /// The server's egress proxy.
    Egress,
}

impl Role {
    /// Value of [`ROLE_LABEL`].
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Guard => "guard",
            Self::Server => "server",
            Self::Egress => "egress",
        }
    }

    /// Parses a [`ROLE_LABEL`] value.
    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "guard" => Some(Self::Guard),
            "server" => Some(Self::Server),
            "egress" => Some(Self::Egress),
            _ => None,
        }
    }

    /// Compose service name of this role for server `name`.
    pub(crate) fn service_name(self, name: &str) -> String {
        let guard = guard_service_name(name);
        match self {
            Self::Guard => guard,
            Self::Server => format!("{guard}-up"),
            Self::Egress => format!("{guard}-egress"),
        }
    }

    /// Resource envelope of this role.
    pub(crate) fn resources(self) -> resources::ContainerResources {
        match self {
            Self::Guard => resources::CUSTOM_MCP_GUARD_RESOURCES,
            Self::Server => resources::CUSTOM_MCP_SERVER_RESOURCES,
            Self::Egress => resources::CUSTOM_MCP_EGRESS_RESOURCES,
        }
    }
}

/// The Custom MCP role and server id a compose service's labels declare, if any.
pub(crate) fn role_of(service: &Value) -> Option<(Role, String)> {
    let labels = service.get("labels")?;
    let role = Role::parse(labels.get(ROLE_LABEL)?.as_str()?)?;
    let id = labels.get(ID_LABEL)?.as_str()?.to_string();
    Some((role, id))
}

/// Compose service of server `name`'s guard: `mcp-custom-<name>` (the hub's `WORKER_*_URL` host).
pub(crate) fn guard_service_name(name: &str) -> String {
    plugin::derive_compose_name(&crate::custom_mcp::model::service_id(name))
}

/// Env var carrying the hub bearer into the guard: `MCP_CUSTOM_<NAME>_AUTH_TOKEN`.
pub(crate) fn guard_auth_token_env(name: &str) -> String {
    format!(
        "MCP_{}_AUTH_TOKEN",
        crate::custom_mcp::model::service_id(name)
            .to_uppercase()
            .replace('-', "_")
    )
}

/// Secrets-dir file of the bearer between the guard and the launcher of server `name`.
pub(crate) fn launcher_token_file(name: &str) -> String {
    format!(
        "{}-launcher-token",
        crate::custom_mcp::model::service_id(name)
    )
}

/// Proxy URL the server's `HTTPS_PROXY`/`HTTP_PROXY` point at: its own egress container.
pub(crate) fn egress_proxy_url(name: &str) -> String {
    format!("http://{}:{EGRESS_PORT}", Role::Egress.service_name(name))
}

/// Upstream URL of the npm guard: the launcher in the server container.
pub(crate) fn upstream_url(name: &str) -> String {
    format!(
        "http://{}:{}/",
        Role::Server.service_name(name),
        consts::PORT_WORKER
    )
}

/// Engine path of `<data_dir>/custom-mcp/<project>/<name>/<sub>`.
pub(crate) fn subdir_engine_path(
    data_dir: &Path,
    project: &str,
    name: &str,
    sub: ServerSubdir,
) -> anyhow::Result<String> {
    to_engine_path(&paths::subdir_in(data_dir, project, name, sub)?)
}

/// Per-render inputs of [`apply_custom_mcp`].
pub(crate) struct CustomMcpCtx<'a> {
    /// Data dir every state path derives from.
    pub data_dir: &'a Path,
    /// Project name.
    pub project_name: &'a str,
    /// Raw project directory (host form).
    pub project_dir: &'a str,
    /// The project's main network name.
    pub network_name: &'a str,
    /// `<data_dir>/tokens/<project>`.
    pub tokens_dir: &'a Path,
    /// Manifest the guard and proxy image tags come from.
    pub bundle_manifest: &'a BundleManifest,
}

fn s(value: &str) -> Value {
    Value::String(value.to_string())
}

fn seq(items: impl IntoIterator<Item = String>) -> Value {
    Value::Sequence(items.into_iter().map(Value::String).collect())
}

fn consent_label(server: &EffectiveCustomMcp) -> String {
    server
        .consent_digest
        .chars()
        .take(CONSENT_LABEL_CHARS)
        .collect()
}

fn format_cpus(cpus: f32) -> String {
    format!("{cpus}")
}

/// Engine container name of the Custom MCP compose service `service` of `project`.
pub(crate) fn container_name(project: &str, service: &str) -> String {
    format!(
        "{}_{project}_{}",
        consts::compose_prefix(),
        service.replace('-', "_")
    )
}

/// The hardening block, labels and limits every Custom MCP container carries.
pub(crate) fn hardened_service(
    ctx: &CustomMcpCtx<'_>,
    server: &EffectiveCustomMcp,
    role: Role,
    image: &str,
) -> Mapping {
    let r = role.resources();
    let container_name = container_name(ctx.project_name, &role.service_name(&server.name));
    let mut labels = Mapping::new();
    labels.insert(s(ROLE_LABEL), s(role.label()));
    labels.insert(s(ID_LABEL), s(&server.name));
    labels.insert(s(CONSENT_LABEL), s(&consent_label(server)));
    let mut limits = Mapping::new();
    limits.insert(s("cpus"), s(&format_cpus(r.cpus)));
    limits.insert(s("memory"), s(&format!("{}m", r.mem_mib)));
    let mut res = Mapping::new();
    res.insert(s("limits"), Value::Mapping(limits));
    let mut deploy = Mapping::new();
    deploy.insert(s("resources"), Value::Mapping(res));

    let mut svc = Mapping::new();
    svc.insert(s("image"), s(image));
    svc.insert(s("pull_policy"), s("never"));
    svc.insert(s("container_name"), s(&container_name));
    svc.insert(s("read_only"), Value::Bool(true));
    svc.insert(s("user"), s(super::container_user()));
    svc.insert(s("cap_drop"), seq(["ALL".to_string()]));
    svc.insert(s("security_opt"), seq([NO_NEW_PRIVILEGES.to_string()]));
    svc.insert(s("tmpfs"), seq([format!("{TMPFS_PREFIX}{}m", r.tmpfs_mib)]));
    svc.insert(s("labels"), Value::Mapping(labels));
    svc.insert(s("deploy"), Value::Mapping(deploy));
    svc
}

/// `svc` with its volumes (omitted when empty), environment and networks.
pub(crate) fn service_value(
    mut svc: Mapping,
    volumes: Vec<String>,
    env: Vec<String>,
    nets: Vec<String>,
) -> Value {
    if !volumes.is_empty() {
        svc.insert(s("volumes"), seq(volumes));
    }
    svc.insert(s("environment"), seq(env));
    svc.insert(s("networks"), seq(nets));
    Value::Mapping(svc)
}

/// Adds `service` as `name`, refusing to replace an existing service.
pub(crate) fn insert_service(doc: &mut Value, name: String, service: Value) -> anyhow::Result<()> {
    let services = doc
        .get_mut("services")
        .and_then(Value::as_mapping_mut)
        .ok_or_else(|| anyhow::anyhow!("compose has no services mapping"))?;
    let key = Value::String(name.clone());
    if services.contains_key(&key) {
        anyhow::bail!("custom MCP service {name} would overwrite an existing compose service");
    }
    services.insert(key, service);
    Ok(())
}

fn declare_network(doc: &mut Value, key: &str, external: bool) -> anyhow::Result<()> {
    let root = doc
        .as_mapping_mut()
        .ok_or_else(|| anyhow::anyhow!("compose root is not a mapping"))?;
    let networks = root
        .entry(s("networks"))
        .or_insert_with(|| Value::Mapping(Mapping::new()));
    let networks = networks
        .as_mapping_mut()
        .ok_or_else(|| anyhow::anyhow!("compose networks is not a mapping"))?;
    let mut decl = Mapping::new();
    if external {
        decl.insert(s("name"), s(key));
        decl.insert(s("external"), Value::Bool(true));
    } else {
        decl.insert(s("driver"), s("bridge"));
    }
    networks.insert(s(key), Value::Mapping(decl));
    Ok(())
}

fn attach_hub(doc: &mut Value, network: &str) -> anyhow::Result<()> {
    let nets = doc
        .get_mut("services")
        .and_then(|svc| svc.get_mut("mcp-hub"))
        .and_then(|hub| hub.get_mut("networks"))
        .and_then(Value::as_sequence_mut)
        .ok_or_else(|| anyhow::anyhow!("compose mcp-hub has no networks list"))?;
    if !nets.iter().any(|n| n.as_str() == Some(network)) {
        nets.push(s(network));
    }
    Ok(())
}

fn ensure_guard_policy(
    data_dir: &Path,
    project: &str,
    server: &EffectiveCustomMcp,
) -> anyhow::Result<()> {
    let dir = paths::ensure_subdir_in(data_dir, project, &server.name, ServerSubdir::Guard)?;
    let file = dir.join(consts::CUSTOM_MCP_GUARD_POLICY_FILE);
    if std::fs::symlink_metadata(&file).is_ok() {
        return Ok(());
    }
    policy::write_guard_policy(
        data_dir,
        project,
        &server.name,
        &GuardPolicy::empty(
            &server.name,
            GuardMode::of(&server.source),
            Some(server.consent_digest.clone()),
        ),
    )
}

fn workspace_volume(project_dir: &str, mode: WorkspaceMode) -> anyhow::Result<Option<String>> {
    let suffix = match mode {
        WorkspaceMode::None => return Ok(None),
        WorkspaceMode::ReadOnly => "ro",
        WorkspaceMode::ReadWrite => "rw",
    };
    Ok(Some(format!(
        "{}:/workspace:{suffix}",
        str_to_engine_path(project_dir)?
    )))
}

fn add_npm_server(
    doc: &mut Value,
    ctx: &CustomMcpCtx<'_>,
    secrets_dir: &Path,
    server: &EffectiveCustomMcp,
    lock: &CustomMcpLock,
    images: &Images,
) -> anyhow::Result<()> {
    let name = server.name.as_str();
    let project = ctx.project_name;
    paths::ensure_subdir_in(ctx.data_dir, project, name, ServerSubdir::Egress)?;
    policy::write_egress_config(
        ctx.data_dir,
        project,
        name,
        &EgressConfig::new(&server.allowed_domains),
    )?;
    let launcher_token = workers::read_or_mint_secret(secrets_dir, &launcher_token_file(name))?;
    let custom_net = networks::custom_network_name(ctx.network_name);
    let server_net = networks::custom_server_network_name(ctx.network_name, name);
    let egress_net = networks::custom_egress_network_name(ctx.network_name, name);

    let guard = hardened_service(ctx, server, Role::Guard, &images.guard);
    insert_service(
        doc,
        Role::Guard.service_name(name),
        service_value(
            guard,
            vec![format!(
                "{}:/policy:ro",
                subdir_engine_path(ctx.data_dir, project, name, ServerSubdir::Guard)?
            )],
            vec![
                format!("PORT={}", consts::PORT_WORKER),
                format!("SPW_CUSTOM_SERVER={name}"),
                "SPW_CUSTOM_MODE=npm".to_string(),
                format!(
                    "POLICY_FILE=/policy/{}",
                    consts::CUSTOM_MCP_GUARD_POLICY_FILE
                ),
                format!("SPW_UPSTREAM_URL={}", upstream_url(name)),
                format!("SPW_UPSTREAM_AUTH_TOKEN={launcher_token}"),
            ],
            vec![custom_net, server_net.clone()],
        ),
    )?;

    let mut volumes = vec![format!(
        "{}:/tokens:ro",
        crate::engine_path::vm_path_join(
            &to_engine_path(ctx.tokens_dir)?,
            &crate::custom_mcp::model::service_id(name)
        )
    )];
    volumes.extend(workspace_volume(ctx.project_dir, server.workspace_mode)?);
    let proxy = egress_proxy_url(name);
    insert_service(
        doc,
        Role::Server.service_name(name),
        service_value(
            hardened_service(ctx, server, Role::Server, &lock.image_tag),
            volumes,
            vec![
                format!("PORT={}", consts::PORT_WORKER),
                format!("SPW_LAUNCHER_AUTH_TOKEN={launcher_token}"),
                format!("HTTPS_PROXY={proxy}"),
                format!("HTTP_PROXY={proxy}"),
                "NO_PROXY=".to_string(),
                "NODE_USE_ENV_PROXY=1".to_string(),
            ],
            vec![server_net.clone()],
        ),
    )?;

    let mut egress = hardened_service(ctx, server, Role::Egress, &images.proxy);
    egress.insert(s("entrypoint"), seq([EGRESS_ENTRYPOINT.to_string()]));
    insert_service(
        doc,
        Role::Egress.service_name(name),
        service_value(
            egress,
            vec![format!(
                "{}:/config:ro",
                subdir_engine_path(ctx.data_dir, project, name, ServerSubdir::Egress)?
            )],
            vec![
                format!(
                    "SPW_EGRESS_CONFIG=/config/{}",
                    consts::CUSTOM_MCP_EGRESS_CONFIG_FILE
                ),
                format!("SPW_EGRESS_LISTEN=0.0.0.0:{EGRESS_PORT}"),
            ],
            vec![server_net.clone(), egress_net.clone()],
        ),
    )?;
    declare_network(doc, &server_net, true)?;
    declare_network(doc, &egress_net, false)?;
    Ok(())
}

/// Image tags the Custom MCP containers run on, besides each server's own.
pub(crate) struct Images {
    /// `speedwave-mcp-custom-guard:<hash16>`.
    pub guard: String,
    /// `proxy:<hash16>` (the egress binary lives in the proxy image).
    pub proxy: String,
}

/// Adds every server in `servers` (the effective set, name order) to `yaml`; returns `yaml`
/// unchanged when there is none, so a project without Custom MCP renders byte-for-byte as before.
pub(crate) fn apply_custom_mcp(
    yaml: &str,
    ctx: &CustomMcpCtx<'_>,
    servers: &[EffectiveCustomMcp],
) -> anyhow::Result<String> {
    if servers.is_empty() {
        return Ok(yaml.to_string());
    }
    let images = Images {
        guard: ctx
            .bundle_manifest
            .image_tag(build::IMAGE_MCP_CUSTOM_GUARD)?,
        proxy: ctx.bundle_manifest.image_tag(build::IMAGE_PROXY)?,
    };
    let secrets_dir = init_secrets_dir_in(ctx.data_dir, ctx.project_name)?;
    let mut doc: Value = serde_yaml_ng::from_str(yaml)?;
    let mut npm = false;
    let mut host = false;
    for server in servers {
        ensure_guard_policy(ctx.data_dir, ctx.project_name, server)?;
        match &server.source {
            CustomMcpSource::Npm { lock } => {
                npm = true;
                add_npm_server(&mut doc, ctx, &secrets_dir, server, lock, &images)?;
            }
            CustomMcpSource::Host { .. } => {
                host = true;
                custom_host::add_host_server(&mut doc, ctx, server, &images)?;
            }
        }
        let guard = Role::Guard.service_name(&server.name);
        workers::ensure_worker_auth_token(
            &mut doc,
            &secrets_dir,
            &server.service_id,
            &guard,
            &guard_auth_token_env(&server.name),
        )?;
        inject_worker_env(
            &mut doc,
            &plugin::derive_worker_env(&server.service_id),
            &format!("http://{guard}:{}", consts::PORT_WORKER),
        );
    }
    if npm {
        let custom = networks::custom_network_name(ctx.network_name);
        declare_network(&mut doc, &custom, true)?;
        attach_hub(&mut doc, &custom)?;
    }
    if host {
        let custom_host = networks::custom_host_network_name(ctx.network_name);
        declare_network(&mut doc, &custom_host, false)?;
        attach_hub(&mut doc, &custom_host)?;
    }
    Ok(serde_yaml_ng::to_string(&doc)?)
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code: panics on setup failure are acceptable"
)]
pub(crate) mod tests {
    use super::*;
    use crate::config::{LlmConfig, ResolvedClaudeConfig, ResolvedIntegrationsConfig};
    use crate::custom_mcp::effective::resolve_effective;
    use crate::custom_mcp::model::{CustomMcpEntry, HostPort, ManagedCustomMcpConfig};
    use crate::custom_mcp::policy::tests::{approved, npm_entry};
    use std::collections::BTreeMap;

    pub(crate) const PROJECT: &str = "acme";

    pub(crate) struct Fixture {
        pub data: tempfile::TempDir,
        pub project: tempfile::TempDir,
    }

    impl Fixture {
        pub(crate) fn new() -> Self {
            Self {
                data: tempfile::tempdir().unwrap(),
                project: tempfile::tempdir().unwrap(),
            }
        }

        pub(crate) fn project_dir(&self) -> &str {
            self.project.path().to_str().unwrap()
        }

        pub(crate) fn npm(&self, name: &str) -> CustomMcpEntry {
            crate::custom_mcp::build::tests::pinned_entry(self.data.path(), PROJECT, name)
        }
    }

    pub(crate) fn host_entry() -> CustomMcpEntry {
        let mut entry = npm_entry();
        entry.source = CustomMcpSource::Host {
            port: 3845,
            path: "/mcp".to_string(),
        };
        approved(entry)
    }

    pub(crate) fn integrations(
        entries: Vec<(&str, CustomMcpEntry)>,
        beta: bool,
        managed: Option<&ManagedCustomMcpConfig>,
    ) -> ResolvedIntegrationsConfig {
        let map: BTreeMap<String, CustomMcpEntry> = entries
            .into_iter()
            .map(|(n, e)| (n.to_string(), e))
            .collect();
        ResolvedIntegrationsConfig {
            custom_mcp: resolve_effective(&map, beta, managed),
            ..ResolvedIntegrationsConfig::default()
        }
    }

    fn claude_config() -> ResolvedClaudeConfig {
        let mut llm = LlmConfig {
            provider: Some("anthropic".to_string()),
            ..Default::default()
        };
        crate::config::migrate_llm(&mut llm, crate::config::AnthropicEvidence::None);
        ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: crate::defaults::DEFAULT_FLAGS
                .iter()
                .map(|f| f.to_string())
                .collect(),
            llm,
            ..Default::default()
        }
    }

    pub(crate) fn manifest() -> BundleManifest {
        BundleManifest::for_tests("0123456789abcdef")
    }

    pub(crate) fn render(fx: &Fixture, integrations: &ResolvedIntegrationsConfig) -> String {
        super::super::render_compose_in(
            fx.data.path(),
            PROJECT,
            fx.project_dir(),
            &claude_config(),
            integrations,
            None,
            super::super::RenderInputs {
                bridges: &super::super::HostBridgesInfo::default(),
                bundle_manifest: &manifest(),
            },
        )
        .unwrap()
    }

    pub(crate) fn npm_and_host(fx: &Fixture) -> ResolvedIntegrationsConfig {
        let mut figma = fx.npm("figma");
        figma.allowed_domains = vec![HostPort::parse("api.figma.com:443").unwrap()];
        integrations(vec![("figma", figma), ("desk", host_entry())], true, None)
    }

    fn doc(yaml: &str) -> Value {
        serde_yaml_ng::from_str(yaml).unwrap()
    }

    fn normalized(yaml: &str) -> Value {
        let mut d = doc(yaml);
        if let Some(services) = d.get_mut("services").and_then(Value::as_mapping_mut) {
            for (_, svc) in services.iter_mut() {
                if let Some(env) = svc.get_mut("environment").and_then(Value::as_sequence_mut) {
                    env.sort_by(|a, b| a.as_str().cmp(&b.as_str()));
                }
            }
        }
        d
    }

    fn strings(value: Option<&Value>) -> Vec<String> {
        value
            .and_then(Value::as_sequence)
            .map(|s| {
                s.iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default()
    }

    fn service<'a>(doc: &'a Value, name: &str) -> &'a Value {
        doc.get("services").and_then(|s| s.get(name)).unwrap()
    }

    fn env_keys(svc: &Value) -> Vec<String> {
        strings(svc.get("environment"))
            .into_iter()
            .map(|e| e.split('=').next().unwrap_or_default().to_string())
            .collect()
    }

    fn env_value(svc: &Value, key: &str) -> Option<String> {
        strings(svc.get("environment"))
            .into_iter()
            .find_map(|e| e.strip_prefix(&format!("{key}=")).map(str::to_string))
    }

    fn net(name: &str) -> String {
        format!(
            "{}_{name}",
            super::super::networks::project_network_name(PROJECT)
        )
    }

    fn engine(path: &Path) -> String {
        to_engine_path(path).unwrap()
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn npm_and_host_servers_render_in_the_target_shape() {
        let fx = Fixture::new();
        let integrations = npm_and_host(&fx);
        let figma = integrations
            .custom_mcp
            .effective
            .iter()
            .find(|s| s.name == "figma")
            .unwrap();
        let lock_tag = match &figma.source {
            CustomMcpSource::Npm { lock } => lock.image_tag.clone(),
            CustomMcpSource::Host { .. } => String::new(),
        };
        let consent: String = figma.consent_digest.chars().take(16).collect();
        let d = doc(&render(&fx, &integrations));
        let data = fx.data.path();
        let guard_dir = engine(&data.join("custom-mcp/acme/figma/guard"));

        let guard = service(&d, "mcp-custom-figma");
        assert_eq!(
            guard["image"].as_str(),
            Some(
                manifest()
                    .image_tag(build::IMAGE_MCP_CUSTOM_GUARD)
                    .unwrap()
                    .as_str()
            )
        );
        assert_eq!(guard["pull_policy"].as_str(), Some("never"));
        assert_eq!(guard["read_only"].as_bool(), Some(true));
        assert_eq!(guard["user"].as_str(), Some("1000:1000"));
        assert_eq!(strings(guard.get("cap_drop")), vec!["ALL"]);
        assert_eq!(
            strings(guard.get("security_opt")),
            vec!["no-new-privileges:true"]
        );
        assert_eq!(
            strings(guard.get("tmpfs")),
            vec!["/tmp:noexec,nosuid,size=32m"]
        );
        assert_eq!(
            strings(guard.get("volumes")),
            vec![format!("{guard_dir}:/policy:ro")]
        );
        assert_eq!(
            strings(guard.get("networks")),
            vec![net("custom"), net("cx_figma")]
        );
        assert_eq!(guard["labels"][ROLE_LABEL].as_str(), Some("guard"));
        assert_eq!(guard["labels"][ID_LABEL].as_str(), Some("figma"));
        assert_eq!(
            guard["labels"][CONSENT_LABEL].as_str(),
            Some(consent.as_str())
        );
        assert_eq!(
            guard["deploy"]["resources"]["limits"]["cpus"].as_str(),
            Some("0.25")
        );
        assert_eq!(
            guard["deploy"]["resources"]["limits"]["memory"].as_str(),
            Some("128m")
        );
        assert_eq!(
            env_value(guard, "SPW_UPSTREAM_URL").as_deref(),
            Some("http://mcp-custom-figma-up:3000/")
        );
        assert_eq!(env_value(guard, "SPW_CUSTOM_MODE").as_deref(), Some("npm"));
        assert_eq!(
            env_value(guard, "SPW_CUSTOM_SERVER").as_deref(),
            Some("figma")
        );
        assert_eq!(
            env_value(guard, "POLICY_FILE").as_deref(),
            Some("/policy/policy.json")
        );
        assert!(env_value(guard, "MCP_CUSTOM_FIGMA_AUTH_TOKEN").is_some());
        assert!(guard.get("ports").is_none() && guard.get("extra_hosts").is_none());

        let server = service(&d, "mcp-custom-figma-up");
        assert_eq!(server["image"].as_str(), Some(lock_tag.as_str()));
        assert_eq!(
            strings(server.get("volumes")),
            vec![format!(
                "{}:/tokens:ro",
                engine(&data.join("tokens/acme/custom-figma"))
            )]
        );
        assert_eq!(strings(server.get("networks")), vec![net("cx_figma")]);
        assert_eq!(
            strings(server.get("tmpfs")),
            vec!["/tmp:noexec,nosuid,size=128m"]
        );
        assert_eq!(
            server["deploy"]["resources"]["limits"]["cpus"].as_str(),
            Some("1")
        );
        for key in ["HTTPS_PROXY", "HTTP_PROXY"] {
            assert_eq!(
                env_value(server, key).as_deref(),
                Some("http://mcp-custom-figma-egress:3128")
            );
        }
        assert_eq!(env_value(server, "NO_PROXY").as_deref(), Some(""));
        assert_eq!(
            env_value(server, "NODE_USE_ENV_PROXY").as_deref(),
            Some("1")
        );
        assert_eq!(
            env_value(server, "SPW_LAUNCHER_AUTH_TOKEN"),
            env_value(guard, "SPW_UPSTREAM_AUTH_TOKEN")
        );
        assert_eq!(server["labels"][ROLE_LABEL].as_str(), Some("server"));

        let egress = service(&d, "mcp-custom-figma-egress");
        assert_eq!(
            egress["image"].as_str(),
            Some(manifest().image_tag(build::IMAGE_PROXY).unwrap().as_str())
        );
        assert_eq!(strings(egress.get("entrypoint")), vec!["/spw-egress"]);
        assert_eq!(
            strings(egress.get("volumes")),
            vec![format!(
                "{}:/config:ro",
                engine(&data.join("custom-mcp/acme/figma/egress"))
            )]
        );
        assert_eq!(
            strings(egress.get("networks")),
            vec![net("cx_figma"), net("eg_figma")]
        );
        assert_eq!(
            egress["deploy"]["resources"]["limits"]["memory"].as_str(),
            Some("32m")
        );
        assert_eq!(
            env_keys(egress),
            vec!["SPW_EGRESS_CONFIG", "SPW_EGRESS_LISTEN", "TZ"]
        );

        let desk = service(&d, "mcp-custom-desk");
        assert_eq!(strings(desk.get("networks")), vec![net("custom_host")]);
        assert_eq!(
            strings(desk.get("volumes")),
            vec![
                format!(
                    "{}:/policy:ro",
                    engine(&data.join("custom-mcp/acme/desk/guard"))
                ),
                format!(
                    "{}:/secrets/relay:ro",
                    engine(&data.join("custom-mcp/acme/relay-desk"))
                ),
            ]
        );
        assert_eq!(env_value(desk, "SPW_CUSTOM_MODE").as_deref(), Some("host"));
        assert_eq!(
            env_value(desk, "SPW_HOST_PROJECT_DIR").as_deref(),
            Some(fx.project_dir())
        );
        assert_eq!(
            env_value(desk, "SPW_HOST_PATH_STYLE").as_deref(),
            Some("posix")
        );
        assert_eq!(
            env_value(desk, "SPW_RELAY_DIR").as_deref(),
            Some("/secrets/relay")
        );
        let extra_hosts = strings(desk.get("extra_hosts"));
        assert_eq!(extra_hosts.len(), 1);
        assert!(extra_hosts[0].starts_with("host.docker.internal:"));
        assert!(d["services"].get("mcp-custom-desk-up").is_none());
        assert!(d["services"].get("mcp-custom-desk-egress").is_none());

        let hub = service(&d, "mcp-hub");
        let hub_nets = strings(hub.get("networks"));
        assert!(hub_nets.contains(&net("custom")) && hub_nets.contains(&net("custom_host")));
        assert!(!hub_nets
            .iter()
            .any(|n| n.contains("_cx_") || n.contains("_eg_")));
        assert_eq!(
            env_value(hub, "WORKER_CUSTOM_FIGMA_URL").as_deref(),
            Some("http://mcp-custom-figma:3000")
        );
        assert_eq!(
            env_value(hub, "WORKER_CUSTOM_DESK_URL").as_deref(),
            Some("http://mcp-custom-desk:3000")
        );
        let enabled = env_value(hub, "ENABLED_SERVICES").unwrap();
        assert!(enabled.ends_with("custom-desk,custom-figma"), "{enabled}");
        assert_eq!(
            env_value(service(&d, "claude"), "ENABLED_SERVICES").unwrap(),
            enabled
        );
        let hub_vols = strings(hub.get("volumes"));
        for sid in ["custom-figma", "custom-desk"] {
            assert!(
                hub_vols.iter().any(|v| v.ends_with(&format!(
                    "/secrets/acme/{sid}-auth-token:/secrets/{sid}-auth-token:ro"
                ))),
                "{hub_vols:?}"
            );
        }

        let networks = &d["networks"];
        for external in [net("custom"), net("cx_figma")] {
            assert_eq!(
                networks[external.as_str()]["external"].as_bool(),
                Some(true)
            );
            assert_eq!(
                networks[external.as_str()]["name"].as_str(),
                Some(external.as_str())
            );
        }
        for bridge in [net("eg_figma"), net("custom_host")] {
            assert_eq!(networks[bridge.as_str()]["driver"].as_str(), Some("bridge"));
            assert!(networks[bridge.as_str()].get("external").is_none());
        }
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn no_running_server_renders_exactly_as_before() {
        let fx = Fixture::new();
        let none = render(&fx, &integrations(vec![], true, None));
        let mut disabled = fx.npm("figma");
        disabled.enabled = false;
        let mut unapproved = host_entry();
        unapproved.consent_digest = None;
        let excluded = integrations(vec![("figma", disabled), ("desk", unapproved)], true, None);
        assert!(excluded.custom_mcp.effective.is_empty());
        assert_eq!(normalized(&render(&fx, &excluded)), normalized(&none));
        let no_beta = integrations(vec![("figma", fx.npm("figma"))], false, None);
        assert_eq!(normalized(&render(&fx, &no_beta)), normalized(&none));
        assert!(!none.contains("custom"), "{none}");
        assert!(!fx.data.path().join("custom-mcp/acme/figma/guard").exists());
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn excluded_servers_are_left_out_next_to_running_ones() {
        let fx = Fixture::new();
        let mut off = fx.npm("off");
        off.enabled = false;
        let yaml = render(
            &fx,
            &integrations(vec![("figma", fx.npm("figma")), ("off", off)], true, None),
        );
        assert!(yaml.contains("mcp-custom-figma-up"));
        assert!(!yaml.contains("mcp-custom-off"));
        assert!(!yaml.contains("cx_off"));
        assert!(!yaml.contains("WORKER_CUSTOM_OFF_URL"));
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn mdm_disable_removes_every_custom_server() {
        let fx = Fixture::new();
        let none = render(&fx, &integrations(vec![], true, None));
        let managed = ManagedCustomMcpConfig {
            enabled: Some(false),
            ..Default::default()
        };
        let entries = vec![("figma", fx.npm("figma")), ("desk", host_entry())];
        assert_eq!(
            normalized(&render(&fx, &integrations(entries, true, Some(&managed)))),
            normalized(&none)
        );
        let hosts_off = ManagedCustomMcpConfig {
            host_servers_enabled: Some(false),
            ..Default::default()
        };
        let yaml = render(
            &fx,
            &integrations(vec![("desk", host_entry())], true, Some(&hosts_off)),
        );
        assert_eq!(normalized(&yaml), normalized(&none));
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn workspace_mode_decides_the_server_project_mount() {
        let fx = Fixture::new();
        let project = to_engine_path(fx.project.path()).unwrap();
        for (mode, expected) in [
            (WorkspaceMode::None, None),
            (
                WorkspaceMode::ReadOnly,
                Some(format!("{project}:/workspace:ro")),
            ),
            (
                WorkspaceMode::ReadWrite,
                Some(format!("{project}:/workspace:rw")),
            ),
        ] {
            let mut entry = fx.npm("figma");
            entry.workspace_mode = mode;
            let entry = approved(entry);
            let d = doc(&render(
                &fx,
                &integrations(vec![("figma", entry)], true, None),
            ));
            let volumes = strings(service(&d, "mcp-custom-figma-up").get("volumes"));
            let workspace: Vec<&String> = volumes
                .iter()
                .filter(|v| v.contains(":/workspace"))
                .collect();
            assert_eq!(
                workspace.first().map(|v| (*v).clone()),
                expected,
                "{mode:?}"
            );
            for role in ["mcp-custom-figma", "mcp-custom-figma-egress"] {
                assert!(
                    !strings(service(&d, role).get("volumes"))
                        .iter()
                        .any(|v| v.contains("/workspace")),
                    "{role} must never see the project"
                );
            }
        }
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn guard_policy_is_created_once_and_never_overwritten() {
        let fx = Fixture::new();
        let integrations = npm_and_host(&fx);
        render(&fx, &integrations);
        let file = fx
            .data
            .path()
            .join("custom-mcp/acme/figma/guard/policy.json");
        let written: GuardPolicy =
            serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(written.service, "custom-figma");
        assert_eq!(written.mode, GuardMode::Npm);
        assert!(written.tools.is_empty());
        let host: GuardPolicy = serde_json::from_str(
            &std::fs::read_to_string(
                fx.data
                    .path()
                    .join("custom-mcp/acme/desk/guard/policy.json"),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(host.mode, GuardMode::Host);
        std::fs::write(&file, "{\"desktop\":\"owns this\"}").unwrap();
        render(&fx, &integrations);
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "{\"desktop\":\"owns this\"}"
        );
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn egress_config_follows_the_effective_domains_on_every_render() {
        let fx = Fixture::new();
        let file = fx
            .data
            .path()
            .join("custom-mcp/acme/figma/egress/egress.json");
        render(&fx, &npm_and_host(&fx));
        let config: EgressConfig =
            serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(
            config.allow,
            vec![HostPort::parse("api.figma.com:443").unwrap()]
        );
        let managed = ManagedCustomMcpConfig {
            allowed_domains: Some(vec!["*.example.com".to_string()]),
            ..Default::default()
        };
        let mut figma = fx.npm("figma");
        figma.allowed_domains = vec![HostPort::parse("api.figma.com:443").unwrap()];
        render(
            &fx,
            &integrations(vec![("figma", figma)], true, Some(&managed)),
        );
        let config: EgressConfig =
            serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert!(
            config.allow.is_empty(),
            "MDM-blocked domains never reach the egress"
        );
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn hub_and_claude_never_carry_custom_server_secrets() {
        let fx = Fixture::new();
        let d = doc(&render(&fx, &npm_and_host(&fx)));
        let launcher = env_value(
            service(&d, "mcp-custom-figma-up"),
            "SPW_LAUNCHER_AUTH_TOKEN",
        )
        .unwrap();
        let bearer = env_value(
            service(&d, "mcp-custom-figma"),
            "MCP_CUSTOM_FIGMA_AUTH_TOKEN",
        )
        .unwrap();
        for svc in ["mcp-hub", "claude"] {
            let rendered = serde_yaml_ng::to_string(service(&d, svc)).unwrap();
            assert!(
                !rendered.contains(&launcher),
                "{svc} sees the launcher bearer"
            );
            assert!(!rendered.contains(&bearer), "{svc} sees the guard bearer");
            assert!(
                !rendered.contains("launcher-token"),
                "{svc} mounts the launcher bearer"
            );
        }
        assert_ne!(launcher, bearer);
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn rendering_twice_gives_the_same_compose() {
        let fx = Fixture::new();
        let integrations = npm_and_host(&fx);
        assert_eq!(
            normalized(&render(&fx, &integrations)),
            normalized(&render(&fx, &integrations))
        );
    }

    #[test]
    fn the_pass_returns_its_input_untouched_without_servers() {
        let fx = Fixture::new();
        let yaml = "services:\n  mcp-hub: {networks: [n]}\n# keep: exact bytes\n";
        let ctx = CustomMcpCtx {
            data_dir: fx.data.path(),
            project_name: PROJECT,
            project_dir: fx.project_dir(),
            network_name: "speedwave_acme_network",
            tokens_dir: fx.data.path(),
            bundle_manifest: &manifest(),
        };
        assert_eq!(apply_custom_mcp(yaml, &ctx, &[]).unwrap(), yaml);
        assert!(!fx.data.path().join("secrets").exists());
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn the_credentials_digest_goes_to_the_server_not_the_guard() {
        let fx = Fixture::new();
        let tokens = fx.data.path().join("tokens/acme/custom-figma");
        std::fs::create_dir_all(&tokens).unwrap();
        std::fs::write(tokens.join("FIGMA_API_KEY"), "secret").unwrap();
        let d = doc(&render(&fx, &npm_and_host(&fx)));
        assert!(env_value(service(&d, "mcp-custom-figma-up"), "SPW_CREDENTIALS_DIGEST").is_some());
        for role in [
            "mcp-custom-figma",
            "mcp-custom-figma-egress",
            "mcp-custom-desk",
        ] {
            assert!(
                env_value(service(&d, role), "SPW_CREDENTIALS_DIGEST").is_none(),
                "{role}"
            );
        }
    }

    #[test]
    fn rendered_env_names_match_what_guard_launcher_and_egress_read() {
        const GUARD: &str = include_str!("../../../../mcp-servers/custom-guard/src/config.ts");
        const LAUNCHER: &str =
            include_str!("../../../../mcp-servers/custom-launcher/src/launcher.ts");
        const EGRESS: &str =
            include_str!("../../../../containers/proxy/src/bin/spw-egress/main.rs");
        for key in [
            "SPW_CUSTOM_SERVER",
            "SPW_CUSTOM_MODE",
            "POLICY_FILE",
            "SPW_UPSTREAM_URL",
            "SPW_UPSTREAM_AUTH_TOKEN",
            "SPW_RELAY_DIR",
            "SPW_HOST_PROJECT_DIR",
            "SPW_HOST_PATH_STYLE",
        ] {
            assert!(
                GUARD.contains(key),
                "custom-guard config.ts no longer reads {key}"
            );
        }
        assert!(GUARD.contains("`MCP_${serviceId.toUpperCase().replace(/-/g, '_')}_AUTH_TOKEN`"));
        assert!(GUARD.contains(&format!("'{}'", crate::custom_mcp::model::service_id(""))));
        for key in ["SPW_LAUNCHER_AUTH_TOKEN", "env.PORT"] {
            assert!(LAUNCHER.contains(key), "launcher.ts no longer reads {key}");
        }
        for key in ["SPW_EGRESS_CONFIG", "SPW_EGRESS_LISTEN"] {
            assert!(EGRESS.contains(key), "spw-egress no longer reads {key}");
        }
        assert!(GUARD.contains(&format!("'{}'", custom_host::RELAY_MOUNT)));
    }

    #[test]
    fn roles_round_trip_their_labels_and_names() {
        for role in [Role::Guard, Role::Server, Role::Egress] {
            assert_eq!(Role::parse(role.label()), Some(role));
        }
        assert_eq!(Role::parse("hub"), None);
        assert_eq!(Role::Guard.service_name("figma"), "mcp-custom-figma");
        assert_eq!(Role::Server.service_name("figma"), "mcp-custom-figma-up");
        assert_eq!(
            Role::Egress.service_name("figma"),
            "mcp-custom-figma-egress"
        );
        assert_eq!(
            guard_auth_token_env("figma-desk"),
            "MCP_CUSTOM_FIGMA_DESK_AUTH_TOKEN"
        );
        assert_eq!(launcher_token_file("figma"), "custom-figma-launcher-token");
        let labelled: Value = serde_yaml_ng::from_str(&format!(
            "labels: {{{ROLE_LABEL}: egress, {ID_LABEL}: figma}}"
        ))
        .unwrap();
        assert_eq!(
            role_of(&labelled),
            Some((Role::Egress, "figma".to_string()))
        );
        let forged: Value =
            serde_yaml_ng::from_str(&format!("labels: {{{ROLE_LABEL}: root}}")).unwrap();
        assert_eq!(role_of(&forged), None);
        assert_eq!(role_of(&Value::Null), None);
    }
}
