//! Compose rendering: generates per-project compose files from the template SSOT.

use crate::config::{ResolvedClaudeConfig, ResolvedIntegrationsConfig};
// `LlmConfig` is referenced only by the in-module test fixtures below.
#[cfg(test)]
use crate::config::LlmConfig;
use crate::consts;
use crate::defaults;
// Host→engine path conversion is the SSOT in `crate::engine_path`.
use crate::engine_path::{str_to_engine_path, to_engine_path};
use crate::plugin::{self};
use crate::{build, bundle};
use std::path::{Path, PathBuf};

// Self-contained concerns split out of this module. Each is re-exported below
// so the public path `compose::*` is preserved for external callers.
mod addressing;
mod llm;
mod plugins;
mod proxy;
mod quoting;
mod security_check;
mod tokens;
mod workers;

// Speedwave proxy config rendering + key management (ADR-073).
pub(crate) use proxy::migrate_legacy_local_key_in;
pub use proxy::{
    proxy_config_dir_in, proxy_config_path_in, remove_llm_provider_key_in, render_proxy_config,
    spw_key_env_name, write_llm_provider_key_in, write_proxy_config_in, PROXY_BASE_URL, PROXY_PORT,
};

// Host addressing SSOT (ADR-067) — public API surface.
pub use addressing::{
    host_addressing, host_bind_address, host_gateway_ip, invalidate_host_addressing_cache,
    HostAddressing, HostAddressingComputer,
};
#[cfg(test)]
pub use addressing::{
    reset_host_addressing_computer_for_test, set_host_addressing_computer_for_test,
};

// Final YAML env-scalar quoting pass — `harden_env_scalar_quoting` is called by
// the render pipeline; `env_entry_needs_quoting` is referenced only by tests.
#[cfg(test)]
use quoting::env_entry_needs_quoting;
pub(crate) use quoting::harden_env_scalar_quoting;

// Security validation framework — public surface; the volume/service helpers
// are crate-internal and referenced only by tests in this module.
#[cfg(test)]
use crate::plugin::PluginManifest;
#[cfg(test)]
use security_check::{extract_volume_for_target, get_services};
pub use security_check::{SecurityCheck, SecurityExpectedPaths, SecurityRule, SecurityViolation};

// LLM provider switching (ADR-040). Public surface mirrors the pre-split paths.
pub(crate) use llm::apply_llm_config_in;
#[cfg(test)]
use llm::provider_display_label;
pub use llm::{
    anthropic_login_unset_keys, canonicalize_local_base_url, default_base_url,
    read_local_llm_token_opt, read_local_llm_token_opt_in, strip_trailing_v1, validate_base_url,
};

// Plugin compose injection.
#[cfg(test)]
use plugins::apply_plugins_from_verified;
pub(crate) use plugins::{apply_plugins, ApplyPluginsCtx};

// Token / secrets directory paths.
pub use tokens::{
    ensure_token_dir, ensure_token_dir_in, init_secrets_dir, llm_provider_key_path_in, tokens_path,
    tokens_path_in, LLM_TOKEN_FILE_SUFFIX, LLM_TOKEN_SERVICE,
};
pub(crate) use tokens::{init_secrets_dir_in, resolve_tokens_dir_in};

// Host-side worker + integrations-filter wiring.
pub use workers::enabled_hub_service_ids;
pub(crate) use workers::{
    apply_integrations_filter, apply_worker_auth_tokens_in, apply_worker_config, worker_gateway_url,
};
#[cfg(test)]
use workers::{
    apply_worker_auth_tokens_with_dir, mcp_os_gateway_url, read_lock_port, remove_env_from,
};

// Test-only bundle build root override; thread-local for parallel test safety.
#[cfg(test)]
thread_local! {
    static TEST_BUILD_ROOT: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
}

/// Resolves the bundle manifest: production reads the env-derived build root;
/// tests read the injected `TEST_BUILD_ROOT` so they never touch global env.
fn resolve_bundle_manifest() -> anyhow::Result<bundle::BundleManifest> {
    #[cfg(test)]
    {
        if let Some(root) = TEST_BUILD_ROOT.with(|r| r.borrow().clone()) {
            return bundle::load_current_bundle_manifest_from(&root);
        }
    }
    bundle::load_current_bundle_manifest()
}

/// Default compose template embedded at compile time from containers/compose.template.yml (SSOT).
const COMPOSE_TEMPLATE: &str = include_str!("../../../../containers/compose.template.yml");

/// Template `${IMAGE_*}` placeholder ↔ catalogue image name. Alignment with
/// `build::IMAGES` and the template is pinned by `image_placeholders_align_*`.
const IMAGE_PLACEHOLDERS: &[(&str, &str)] = &[
    ("${IMAGE_CLAUDE}", build::IMAGE_CLAUDE),
    ("${IMAGE_PROXY}", build::IMAGE_PROXY),
    ("${IMAGE_MCP_HUB}", build::IMAGE_MCP_HUB),
    ("${IMAGE_MCP_SLACK}", build::IMAGE_MCP_SLACK),
    ("${IMAGE_MCP_SHAREPOINT}", build::IMAGE_MCP_SHAREPOINT),
    ("${IMAGE_MCP_REDMINE}", build::IMAGE_MCP_REDMINE),
    ("${IMAGE_MCP_GITLAB}", build::IMAGE_MCP_GITLAB),
    ("${IMAGE_MCP_GITHUB}", build::IMAGE_MCP_GITHUB),
    ("${IMAGE_MCP_ATLASSIAN}", build::IMAGE_MCP_ATLASSIAN),
    ("${IMAGE_MCP_OFFICE}", build::IMAGE_MCP_OFFICE),
    ("${IMAGE_MCP_PLAYWRIGHT}", build::IMAGE_MCP_PLAYWRIGHT),
    ("${IMAGE_MCP_CONTEXT7}", build::IMAGE_MCP_CONTEXT7),
];

/// One live host-side bridge compose advertises to a worker. The plugin manifest's
/// `host_bridge` drives `slug` + env-var names; Desktop supplies `port`/`auth_token`.
#[derive(Clone)]
pub struct HostBridgeRegistration {
    /// Plugin slug — matched against `PluginManifest.slug` in
    /// `apply_plugins_from_verified` to pick the worker receiving the env vars.
    pub plugin_slug: String,
    /// TCP port the bridge listens on (loopback only).
    pub port: u16,
    /// UUID v4 minted by the bridge at startup.
    pub auth_token: String,
    /// Env var name for the bridge URL injected into the worker.
    pub url_env: String,
    /// Env var name for the auth token injected into the worker.
    pub token_env: String,
}

// Manual impl so `auth_token` (a bearer secret) never reaches Debug/log output.
impl std::fmt::Debug for HostBridgeRegistration {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HostBridgeRegistration")
            .field("plugin_slug", &self.plugin_slug)
            .field("port", &self.port)
            .field("auth_token", &"***REDACTED***")
            .field("url_env", &self.url_env)
            .field("token_env", &self.token_env)
            .finish()
    }
}

/// Snapshot of host-side bridges to advertise to container workers. Desktop fills
/// it from live bridges; off-Desktop uses [`host_bridges_from_disk`]. Empty = `BRIDGE_NOT_CONFIGURED`.
#[derive(Clone, Debug, Default)]
pub struct HostBridgesInfo {
    /// All currently active host-side bridge registrations.
    pub bridges: Vec<HostBridgeRegistration>,
}

/// Off-Desktop [`HostBridgesInfo`] from each verified plugin's persisted token +
/// manifest port (`plugin-state/<slug>/`); tokenless degrade. See ADR-063/ADR-074.
pub fn host_bridges_from_disk() -> HostBridgesInfo {
    match plugin::plugins_base_dir() {
        Ok(dir) => host_bridges_from_disk_in(&dir),
        Err(e) => {
            log::warn!("host_bridges_from_disk: cannot resolve plugins dir: {e}");
            HostBridgesInfo::default()
        }
    }
}

/// Env-free core of [`host_bridges_from_disk`]: paths derive from the explicit
/// `plugins_dir`, so tests hit the zero-plugins and list-error branches via a tempdir.
fn host_bridges_from_disk_in(plugins_dir: &Path) -> HostBridgesInfo {
    // Manifests come from signature-verified plugins only (ADR-051); the
    // token lives outside the signed tree, so reading it keeps that gate.
    let plugins = match plugin::list_verified_from_dir(plugins_dir) {
        Ok(p) => p,
        Err(e) => {
            log::warn!("host_bridges_from_disk: cannot list verified plugins: {e}");
            return HostBridgesInfo::default();
        }
    };
    collect_host_bridges(plugins.iter().map(|p| {
        let m = p.manifest();
        (
            m,
            plugin::read_persistent_bridge_token_from(plugins_dir, &m.slug),
        )
    }))
}

/// Assemble [`HostBridgesInfo`] from `(manifest, persisted-token)` pairs —
/// split from the disk walk so it is unit-testable without signed fixtures.
fn collect_host_bridges<'a>(
    entries: impl IntoIterator<Item = (&'a plugin::PluginManifest, Option<String>)>,
) -> HostBridgesInfo {
    let mut bridges: Vec<HostBridgeRegistration> = entries
        .into_iter()
        .filter_map(|(manifest, token)| build_host_bridge_registration(manifest, token))
        .collect();
    // Deterministic order: renders must hash identically across runs/sources.
    bridges.sort_by(|a, b| a.plugin_slug.cmp(&b.plugin_slug));
    HostBridgesInfo { bridges }
}

/// Pure mapping from a manifest (+ pre-validated token) to a [`HostBridgeRegistration`].
/// Eligible only with both knobs (`persistent_token` + fixed `preferred_port`).
fn build_host_bridge_registration(
    manifest: &plugin::PluginManifest,
    token: Option<String>,
) -> Option<HostBridgeRegistration> {
    let bridge = manifest.host_bridge.as_ref()?;
    if !bridge.persistent_token {
        return None;
    }
    let port = bridge.preferred_port?;
    let auth_token = token?;
    Some(HostBridgeRegistration {
        plugin_slug: manifest.slug.clone(),
        port,
        auth_token,
        url_env: bridge.url_env.clone(),
        token_env: bridge.token_env.clone(),
    })
}

/// Renders a compose.yml for a given project by substituting template variables.
pub fn render_compose(
    project_name: &str,
    project_dir: &str,
    resolved_config: &ResolvedClaudeConfig,
    integrations: &ResolvedIntegrationsConfig,
    runtime: Option<&crate::runtime::LockedRuntime>,
    bridges: &HostBridgesInfo,
) -> anyhow::Result<String> {
    render_compose_in(
        consts::data_dir(),
        project_name,
        project_dir,
        resolved_config,
        integrations,
        runtime,
        bridges,
    )
}

/// Env-free core of [`render_compose`]: paths derive from the explicit `data_dir`
/// (tests pass a tempdir); the public no-arg shim resolves `data_dir()`.
pub fn render_compose_in(
    data_dir: &Path,
    project_name: &str,
    project_dir: &str,
    resolved_config: &ResolvedClaudeConfig,
    integrations: &ResolvedIntegrationsConfig,
    runtime: Option<&crate::runtime::LockedRuntime>,
    bridges: &HostBridgesInfo,
) -> anyhow::Result<String> {
    crate::validation::validate_project_name(project_name)?;
    // A vanished workspace must be a clear error, not a root-owned re-create
    // by nerdctl at `up` time (ADR-052).
    if !Path::new(project_dir).is_dir() {
        anyhow::bail!(
            "project directory '{project_dir}' for '{project_name}' no longer exists — \
             restore it or remove the project"
        );
    }
    // Windows: WSL adapter IP can drift; re-detect before it lands in extra_hosts.
    #[cfg(target_os = "windows")]
    invalidate_host_addressing_cache();
    let tokens_dir = resolve_tokens_dir_in(data_dir, project_name);
    let claude_home = crate::claude_home::claude_home_dir(data_dir, project_name);
    let resources_dir = data_dir.join("claude-resources");
    let network_name = format!("{}_{}_network", consts::compose_prefix(), project_name);

    let port_hub = consts::PORT_BASE;
    let port_worker = consts::PORT_WORKER;
    let bundle_manifest = resolve_bundle_manifest()?;

    let mut yaml = COMPOSE_TEMPLATE.to_string();
    yaml = yaml.replace("${COMPOSE_PREFIX}", consts::compose_prefix());
    yaml = yaml.replace("${PROJECT_NAME}", project_name);
    yaml = yaml.replace("${PROJECT_DIR}", &str_to_engine_path(project_dir)?);
    yaml = yaml.replace("${CLAUDE_HOME}", &to_engine_path(&claude_home)?);
    yaml = yaml.replace("${RESOURCES_DIR}", &to_engine_path(&resources_dir)?);
    yaml = yaml.replace("${TOKENS_DIR}", &to_engine_path(&tokens_dir)?);
    yaml = yaml.replace("${NETWORK_NAME}", &network_name);
    yaml = yaml.replace("${CLAUDE_VERSION}", defaults::CLAUDE_VERSION);
    yaml = yaml.replace("${BUNDLED_PLUGINS}", &defaults::BUNDLED_PLUGINS.join(","));
    yaml = yaml.replace(
        "${BUNDLED_PLUGIN_MARKETPLACE}",
        defaults::BUNDLED_PLUGIN_MARKETPLACE,
    );
    yaml = yaml.replace("${PORT_HUB}", &port_hub.to_string());
    yaml = yaml.replace("${PORT_WORKER}", &port_worker.to_string());
    // Per-image build-input hash tags (ADR-072) — one placeholder per service.
    for (placeholder, image_name) in IMAGE_PLACEHOLDERS {
        yaml = yaml.replace(placeholder, &bundle_manifest.image_tag(image_name)?);
    }

    // Pre-create the claude-home mount source incl. the nested .claude/ide
    // mountpoint — otherwise rootful nerdctl creates them root:root (ADR-052).
    std::fs::create_dir_all(claude_home.join(".claude").join("ide"))?;

    // Bridge writes lock files directly to ~/.speedwave/ide-bridge/
    // Mount it as /home/speedwave/.claude/ide/ — no copying needed.
    let ide_lock_dir = data_dir.join("ide-bridge");
    std::fs::create_dir_all(&ide_lock_dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&ide_lock_dir, std::fs::Permissions::from_mode(0o700))?;
    }
    yaml = yaml.replace("${IDE_LOCK_DIR}", &to_engine_path(&ide_lock_dir)?);

    // Speedwave proxy per-project mounts (ADR-073): rendered config (ro) + usage sink (rw).
    proxy::write_proxy_config_in(data_dir, project_name, &resolved_config.llm)?;
    let proxy_config_dir = proxy::proxy_config_dir_in(data_dir, project_name);
    std::fs::create_dir_all(&proxy_config_dir)?;
    let proxy_usage_dir = data_dir.join("usage").join(project_name).join("proxy");
    std::fs::create_dir_all(&proxy_usage_dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&proxy_config_dir, std::fs::Permissions::from_mode(0o700))?;
        std::fs::set_permissions(&proxy_usage_dir, std::fs::Permissions::from_mode(0o700))?;
    }
    yaml = yaml.replace("${PROXY_CONFIG_DIR}", &to_engine_path(&proxy_config_dir)?);
    yaml = yaml.replace("${PROXY_USAGE_DIR}", &to_engine_path(&proxy_usage_dir)?);
    yaml = yaml.replace(
        "${PROXY_CONFIG_DIGEST}",
        &proxy::proxy_state_digest_in(data_dir, project_name),
    );

    yaml = yaml.replace("${HOST_GATEWAY}", &host_gateway_ip()?);
    yaml = yaml.replace("${IDE_HOST_OVERRIDE}", ide_host_override());
    yaml = yaml.replace("${CONTAINER_USER}", container_user());

    // Container resource limits (mem/cpu/tmpfs/shm). SSOT: resources.rs + McpServiceDescriptor.resources.
    yaml = apply_container_resources(&yaml);

    // Inject Claude environment variables from resolved config
    yaml = inject_claude_env(&yaml, &resolved_config.env)?;

    // Native managed-settings.json (MDM telemetry): fail-closed on a resolve error,
    // then mount it :ro only when MDM locked at least one telemetry key.
    if let Some(err) = &resolved_config.telemetry_error {
        anyhow::bail!("telemetry configuration invalid: {err}");
    }
    if resolved_config.telemetry.any_locked {
        crate::claude_managed::write_managed_settings(
            data_dir,
            project_name,
            &resolved_config.telemetry,
        )?;
        let src = crate::claude_managed::managed_settings_path(data_dir, project_name);
        let mount = format!(
            "{}:/etc/claude-code/{}:ro",
            to_engine_path(&src)?,
            crate::consts::MANAGED_SETTINGS_FILE
        );
        let mut doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&yaml)?;
        add_claude_volume(&mut doc, &mount)?;
        yaml = serde_yaml_ng::to_string(&doc)?;
    }

    // Handle LLM provider switching
    yaml = apply_llm_config_in(data_dir, &yaml, &resolved_config.llm, project_name)?;

    // Build pending plugin images before compose; scoped to project-enabled plugins.
    if let Some(rt) = runtime {
        let enabled_ids = integrations.enabled_plugin_service_ids();
        plugin::ensure_plugin_images(rt, &enabled_ids)?;
    }

    // Integrate installed plugins
    yaml = apply_plugins(
        &yaml,
        &ApplyPluginsCtx {
            project_name,
            project_dir,
            integrations,
            network_name: &network_name,
            tokens_dir: &tokens_dir,
            bridges,
        },
    )?;

    // Propagate host timezone into every service; must run after plugin injection.
    let host_tz = crate::tz::detect_host_timezone();
    yaml = inject_host_timezone(&yaml, &host_tz)?;

    // Gate on the v2 active entry's real kind, not the flat `provider` string
    // (it masquerades OpenRouter as `anthropic`, which would re-inject a stale key).
    let anthropic_active = match resolved_config.llm.active_provider() {
        Some(entry) => entry.kind.is_anthropic(),
        None => {
            resolved_config
                .llm
                .provider
                .as_deref()
                .unwrap_or("anthropic")
                == "anthropic"
        }
    };
    if anthropic_active {
        yaml = apply_auth_config_in(&yaml, project_name, data_dir)?;
    }

    // Inject mcp-os config into hub if auth token exists
    yaml = apply_mcp_os_config_in(data_dir, &yaml)?;

    // Inject oauth worker URL + per-service bearer mount; no-op if oauth not running for project (ADR-060).
    yaml = apply_oauth_config_in(data_dir, &yaml, project_name)?;

    // Inject per-worker Bearer auth tokens (SEC-035)
    yaml = apply_worker_auth_tokens_in(data_dir, &yaml, project_name, integrations)?;

    // Filter services based on integrations config
    yaml = apply_integrations_filter(&yaml, integrations, &network_name)?;

    // Per-worker credentials digest: token rotation changes config-hash for idempotent recreate.
    yaml = workers::apply_credentials_digests_in(data_dir, &yaml, project_name)?;

    // Re-quote env values with YAML flow indicators (e.g. `[1m]` suffix); must run after all env-injection.
    yaml = harden_env_scalar_quoting(&yaml)?;

    // Every data_dir-rooted mount source must exist host-side BEFORE `up` —
    // rootful nerdctl creates missing sources as root:root (ADR-052).
    ensure_data_dir_mount_sources(data_dir, &yaml)?;

    warn_if_host_workers_unavailable(data_dir, project_name, &yaml, integrations);

    Ok(yaml)
}

/// Warns when the rendered stack expects a Desktop-supervised host worker
/// (oauth refresh / mcp-os) that is not running — CLI with Desktop closed.
fn warn_if_host_workers_unavailable(
    data_dir: &Path,
    project: &str,
    yaml: &str,
    integrations: &ResolvedIntegrationsConfig,
) {
    let manifests: Vec<crate::plugin::PluginManifest> = crate::plugin::list_verified_plugins()
        .map(|ps| ps.into_iter().map(|p| p.manifest().clone()).collect())
        .unwrap_or_default();
    for w in host_worker_warnings(data_dir, project, yaml, integrations, &manifests) {
        log::warn!("{w}");
    }
}

/// Pure core of [`warn_if_host_workers_unavailable`] — testable, no I/O
/// beyond the mcp-os token existence probe.
fn host_worker_warnings(
    data_dir: &Path,
    project: &str,
    yaml: &str,
    integrations: &ResolvedIntegrationsConfig,
    manifests: &[crate::plugin::PluginManifest],
) -> Vec<String> {
    let mut out = Vec::new();
    if !yaml.contains("WORKER_OAUTH_URL") {
        let consumers = oauth_consumer_service_ids(integrations, manifests);
        if !consumers.is_empty() {
            out.push(format!(
                "'{project}' uses OAuth integrations ({}) but the refresh worker is not \
                 running — tokens will expire until Speedwave Desktop is started",
                consumers.join(", ")
            ));
        }
    }
    if !yaml.contains("WORKER_OS_URL") && data_dir.join(consts::MCP_OS_AUTH_TOKEN_FILE).exists() {
        out.push(format!(
            "mcp-os is not running — OS integrations (mail/calendar) are unavailable \
             for '{project}' until Speedwave Desktop is started"
        ));
    }
    out
}

/// Host-creates every volume source under `data_dir` found in the rendered
/// YAML (tokens, resources, usage, plugin mounts). Existing paths untouched.
fn ensure_data_dir_mount_sources(data_dir: &Path, yaml: &str) -> anyhow::Result<()> {
    let engine_prefix = to_engine_path(data_dir)?;
    for line in yaml.lines() {
        let Some(entry) = line.trim_start().strip_prefix("- ") else {
            continue;
        };
        if !entry.starts_with(&engine_prefix) {
            continue;
        }
        let src = entry.split_once(':').map_or(entry, |(s, _)| s);
        let rel = src[engine_prefix.len()..].trim_start_matches('/');
        if rel.is_empty() {
            continue;
        }
        let host = rel
            .split('/')
            .fold(data_dir.to_path_buf(), |p, seg| p.join(seg));
        if !host.exists() {
            std::fs::create_dir_all(&host)?;
        }
    }
    Ok(())
}

/// Canonical memory/tmpfs/shm rendering — MiB as `Nm` (e.g. `512m`).
fn format_mib(mib: u32) -> String {
    format!("{mib}m")
}

/// Canonical CPU rendering — one decimal (e.g. `2.0`).
fn format_cpus(cpus: f32) -> String {
    format!("{cpus:.1}")
}

/// Substitutes every `${…_MEM|_CPUS|_TMPFS|_SHM}` from the resource SSOT (resources.rs +
/// `McpServiceDescriptor.resources`): mem/tmpfs/shm as MiB (`Nm`), CPU one-decimal (`2.0`).
fn apply_container_resources(yaml: &str) -> String {
    use crate::resources::{ContainerResources, CLAUDE_RESOURCES, HUB_RESOURCES, PROXY_RESOURCES};

    // Substitute the ${PREFIX_*} placeholders for one container into `out`.
    fn apply(out: &mut String, prefix: &str, r: &ContainerResources) {
        *out = out.replace(&format!("${{{prefix}_MEM}}"), &format_mib(r.mem_mib));
        *out = out.replace(&format!("${{{prefix}_CPUS}}"), &format_cpus(r.cpus));
        *out = out.replace(&format!("${{{prefix}_TMPFS}}"), &format_mib(r.tmpfs_mib));
        if let Some(shm) = r.shm_mib {
            *out = out.replace(&format!("${{{prefix}_SHM}}"), &format_mib(shm));
        }
    }

    let mut out = yaml.to_string();

    // Claude's mem uses the legacy ${CLAUDE_MEMORY}; CPUS/TMPFS use uniform ${CLAUDE_*}.
    out = out.replace("${CLAUDE_MEMORY}", &format_mib(CLAUDE_RESOURCES.mem_mib));
    apply(&mut out, "CLAUDE", &CLAUDE_RESOURCES);
    apply(&mut out, "MCP_HUB", &HUB_RESOURCES);
    apply(&mut out, "PROXY", &PROXY_RESOURCES);

    for svc in crate::consts::TOGGLEABLE_MCP_SERVICES {
        // compose_name "mcp-slack" → placeholder prefix "MCP_SLACK".
        let prefix = svc.compose_name.to_ascii_uppercase().replace('-', "_");
        apply(&mut out, &prefix, &svc.resources);
    }

    out
}

/// Returns the path where the rendered compose file should be saved.
pub fn compose_output_path(project: &str) -> anyhow::Result<PathBuf> {
    compose_output_path_in(consts::data_dir(), project)
}

/// Resolves the compose output path under an explicit data directory — the
/// env-free core used by `save_compose_in` and by tests.
pub fn compose_output_path_in(
    data_dir: &std::path::Path,
    project: &str,
) -> anyhow::Result<PathBuf> {
    crate::validation::validate_project_name(project)?;
    Ok(data_dir.join("compose").join(project).join("compose.yml"))
}

#[cfg(test)]
thread_local! {
    /// Test seam: overrides the post-write read-back to exercise the disk-corruption /
    /// virtiofs-divergence branch in `save_compose` without real FS games. Cleared per call.
    static FORCE_DISK_GARBAGE: std::cell::RefCell<Option<String>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn read_back_compose(path: &std::path::Path) -> std::io::Result<String> {
    if let Some(forced) = FORCE_DISK_GARBAGE.with(|c| c.borrow_mut().take()) {
        return Ok(forced);
    }
    std::fs::read_to_string(path)
}

#[cfg(not(test))]
fn read_back_compose(path: &std::path::Path) -> std::io::Result<String> {
    std::fs::read_to_string(path)
}

/// Atomic 0o600 write (YAML may carry `ANTHROPIC_AUTH_TOKEN`, ADR-040). Validates network
/// refs in-memory + post-read-back (catches macOS virtiofs lag; no-op on ext4/NTFS).
pub fn save_compose(project: &str, yaml: &str) -> anyhow::Result<()> {
    save_compose_in(consts::data_dir(), project, yaml)
}

/// Env-free core of [`save_compose`]: writes the per-project compose under an explicit
/// `data_dir` (tests use a tempdir). The public shim resolves `data_dir()` at the call site.
pub fn save_compose_in(data_dir: &Path, project: &str, yaml: &str) -> anyhow::Result<()> {
    validate_compose_network_refs(yaml)
        .map_err(|e| anyhow::anyhow!("save_compose: in-memory YAML failed validation: {e}"))?;

    let path = compose_output_path_in(data_dir, project)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    crate::fs_perms::write_restricted_file_atomic(&path, yaml)?;

    let on_disk = read_back_compose(&path).map_err(|e| {
        anyhow::anyhow!(
            "save_compose: post-write read-back failed for '{}': {e}",
            path.display()
        )
    })?;
    validate_compose_network_refs(&on_disk).map_err(|e| {
        anyhow::anyhow!(
            "save_compose: disk content failed validation (host write succeeded but \
             read-back differs from in-memory):\n  on-disk error: {e}\n  in-memory \
             length: {} bytes\n  on-disk length: {} bytes",
            yaml.len(),
            on_disk.len()
        )
    })?;
    Ok(())
}

/// SSOT for the "undefined network" error fragment, shared by the host-side validator below
/// and `runtime::is_propagation_error` (recognises VM-side `nerdctl compose config` failures).
pub(crate) const UNDEFINED_NETWORK_ERROR_FRAGMENT: &str = "undefined network";

/// SSOT for the "invalid compose project" error fragment nerdctl emits on an undefined-network
/// ref — recognised by `runtime::is_propagation_error` for retry-on-propagation-lag.
pub(crate) const INVALID_COMPOSE_PROJECT_ERROR_FRAGMENT: &str = "invalid compose project";

/// SSOT for compose schema/parse error fragments seen on a stale/torn virtiofs
/// read; recognised by `runtime::is_propagation_error` for retry-on-propagation-lag.
pub(crate) const COMPOSE_SCHEMA_VALIDATION_ERROR_FRAGMENTS: &[&str] = &[
    // Field-specific fragments (path + type), never bare "must be a string". See ADR-068.
    "driver must be a string",         // networks.<n>.driver torn
    "cpus must be a number or string", // deploy.resources.limits.cpus torn
    "memory must be a string",         // deploy.resources.limits.memory torn
    "yaml:", // any yaml-go parse error: rendered YAML is always valid, so torn read
];

/// Asserts every `services.<svc>.networks: [name]` resolves to a declared top-level
/// `networks.<name>`. Catches render bugs and torn writes with missing network entries.
fn validate_compose_network_refs(yaml: &str) -> anyhow::Result<()> {
    let doc: serde_yaml_ng::Value =
        serde_yaml_ng::from_str(yaml).map_err(|e| anyhow::anyhow!("YAML parse failed: {e}"))?;

    let mut declared: std::collections::HashSet<String> = std::collections::HashSet::new();
    if let Some(map) = doc.get("networks").and_then(|n| n.as_mapping()) {
        for key in map.keys() {
            if let Some(name) = key.as_str() {
                declared.insert(name.to_string());
            }
        }
    }

    // Compute once for all error paths — declared set is immutable after this.
    let mut declared_sorted: Vec<&str> = declared.iter().map(String::as_str).collect();
    declared_sorted.sort();

    let services = match doc.get("services").and_then(|s| s.as_mapping()) {
        Some(s) => s,
        None => return Ok(()),
    };

    for (svc_key, svc_val) in services {
        let svc_name = svc_key.as_str().unwrap_or("<non-string-key>");
        let Some(networks) = svc_val.get("networks") else {
            continue;
        };
        // Compose spec allows `networks: null` (or omission) to mean "no network
        // attachments declared". Treat null/missing same as an absent field.
        if networks.is_null() {
            continue;
        }
        let refs: Vec<String> = if let Some(seq) = networks.as_sequence() {
            seq.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        } else if let Some(m) = networks.as_mapping() {
            m.keys()
                .filter_map(|k| k.as_str().map(str::to_string))
                .collect()
        } else {
            anyhow::bail!(
                "service '{svc_name}': networks field is neither a sequence nor a mapping \
                 (got {:?}) — render bug",
                networks
            );
        };
        for r in refs {
            if !declared.contains(&r) {
                anyhow::bail!(
                    "service '{svc_name}' references {UNDEFINED_NETWORK_ERROR_FRAGMENT} '{r}'; \
                     declared networks: [{}]",
                    declared_sorted.join(", ")
                );
            }
        }
    }
    Ok(())
}

pub(crate) fn inject_claude_env(
    yaml: &str,
    env: &std::collections::HashMap<String, String>,
) -> anyhow::Result<String> {
    let mut doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(yaml)
        .map_err(|e| anyhow::anyhow!("inject_claude_env: failed to parse compose YAML: {e}"))?;

    if let Some(services) = doc.get_mut("services") {
        if let Some(claude) = services.get_mut("claude") {
            if let Some(environment) = claude.get_mut("environment") {
                if let Some(env_seq) = environment.as_sequence_mut() {
                    for (key, value) in env {
                        let new_entry = format!("{}={}", key, value);
                        let existing = env_seq.iter().position(|v| {
                            v.as_str()
                                .is_some_and(|s| s.split('=').next() == Some(key.as_str()))
                        });
                        match existing {
                            Some(idx) => {
                                env_seq[idx] = serde_yaml_ng::Value::String(new_entry);
                            }
                            None => {
                                env_seq.push(serde_yaml_ng::Value::String(new_entry));
                            }
                        }
                    }
                } else {
                    log::warn!(
                        "inject_claude_env: claude service 'environment' field is not a sequence \
                         (got {:?}) — env vars not injected",
                        environment
                    );
                }
            }
        }
    }

    serde_yaml_ng::to_string(&doc)
        .map_err(|e| anyhow::anyhow!("inject_claude_env: failed to serialize compose YAML: {e}"))
}

/// Appends `TZ=<tz>` to every service's `environment` sequence; idempotent, never overwrites an existing `TZ`.
fn inject_host_timezone(yaml: &str, tz: &str) -> anyhow::Result<String> {
    let mut doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(yaml)
        .map_err(|e| anyhow::anyhow!("inject_host_timezone: failed to parse compose YAML: {e}"))?;

    if let Some(services) = doc.get_mut("services").and_then(|s| s.as_mapping_mut()) {
        for (_, service) in services.iter_mut() {
            let Some(service_map) = service.as_mapping_mut() else {
                continue;
            };
            let env_key = serde_yaml_ng::Value::String("environment".to_string());
            let env_seq = match service_map.get_mut(&env_key) {
                Some(existing) => match existing.as_sequence_mut() {
                    Some(seq) => seq,
                    // compose.template.yml uses sequence form uniformly; mapping form is intentionally skipped.
                    None => {
                        log::warn!(
                            "inject_host_timezone: service 'environment' is not a sequence \
                             (got {:?}) — TZ not injected",
                            existing
                        );
                        continue;
                    }
                },
                None => {
                    service_map.insert(env_key.clone(), serde_yaml_ng::Value::Sequence(vec![]));
                    let Some(inserted) = service_map
                        .get_mut(&env_key)
                        .and_then(|v| v.as_sequence_mut())
                    else {
                        continue;
                    };
                    inserted
                }
            };

            let already_set = env_seq.iter().any(|v| {
                v.as_str()
                    .is_some_and(|s| s.split('=').next() == Some("TZ"))
            });
            if !already_set {
                env_seq.push(serde_yaml_ng::Value::String(format!("TZ={}", tz)));
            }
        }
    }

    serde_yaml_ng::to_string(&doc)
        .map_err(|e| anyhow::anyhow!("inject_host_timezone: failed to serialize compose YAML: {e}"))
}

/// Injects the legacy Anthropic API key into the `claude` service env when
/// stored at `secrets/<project>/anthropic_api_key`. See ADR-052.
pub(crate) fn apply_auth_config_in(
    yaml: &str,
    project: &str,
    data_dir: &std::path::Path,
) -> anyhow::Result<String> {
    let key_path = data_dir
        .join("secrets")
        .join(project)
        .join("anthropic_api_key");

    if !key_path.exists() {
        return Ok(yaml.to_string());
    }

    let api_key = std::fs::read_to_string(&key_path)?.trim().to_string();
    if api_key.is_empty() {
        return Ok(yaml.to_string());
    }

    let mut doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(yaml)?;
    add_claude_env_var(&mut doc, "ANTHROPIC_API_KEY", &api_key);
    Ok(serde_yaml_ng::to_string(&doc)?)
}

/// Adds an env var to a named service (creating `environment` as a sequence if absent).
/// Returns `Err` if the service is absent; `inject_env_into()` warns and returns instead.
pub(crate) fn add_service_env_var(
    doc: &mut serde_yaml_ng::Value,
    service_name: &str,
    key: &str,
    value: &str,
) -> anyhow::Result<()> {
    let service = doc
        .get_mut("services")
        .and_then(|s| s.get_mut(service_name))
        .ok_or_else(|| {
            anyhow::anyhow!(
                "service '{}' not found in compose YAML — cannot inject env var '{}'",
                service_name,
                key
            )
        })?;
    let env = service
        .get_mut("environment")
        .and_then(|e| e.as_sequence_mut());
    match env {
        Some(seq) => {
            seq.push(serde_yaml_ng::Value::String(format!("{}={}", key, value)));
        }
        None => {
            service["environment"] =
                serde_yaml_ng::Value::Sequence(vec![serde_yaml_ng::Value::String(format!(
                    "{}={}",
                    key, value
                ))]);
        }
    }
    Ok(())
}

/// Injects mcp-os config into mcp-hub if the auth token file exists: `WORKER_OS_URL`
/// (platform gateway URL) + `/secrets/os-auth-token:ro` bind-mount (token as file).
fn apply_mcp_os_config_in(data_dir: &std::path::Path, yaml: &str) -> anyhow::Result<String> {
    let lock_path = data_dir.join(consts::MCP_OS_LOCK_FILE);
    let token_mount_path = data_dir.join(consts::MCP_OS_AUTH_TOKEN_FILE);
    apply_mcp_os_config_with_path(yaml, &token_mount_path, &lock_path)
}

/// Test-only alias. `lock_path` is the unified `lock.json`; `token_mount_path`
/// is the standalone token file bind-mounted into the hub (see `mcp_os_process::spawn_in`).
fn apply_mcp_os_config_with_path(
    yaml: &str,
    token_mount_path: &std::path::Path,
    lock_path: &std::path::Path,
) -> anyhow::Result<String> {
    apply_worker_config(
        yaml,
        "mcp-os",
        token_mount_path,
        lock_path,
        crate::host_mcp_process::lock::LockService::McpOs,
        "WORKER_OS_URL",
        "os-auth-token",
    )
}

/// Inject `WORKER_OAUTH_URL` + per-service bearer mount into each OAuth consumer when oauth is up
/// (consumers from `uses_oauth_refresh`, ADR-060). Bearer at `/secrets/oauth-auth-token-<key>:ro`.
fn apply_oauth_config_in(
    data_dir: &std::path::Path,
    yaml: &str,
    project: &str,
) -> anyhow::Result<String> {
    let state_dir = crate::oauth_process::oauth_project_dir(data_dir, project);
    let lock_path = state_dir.join(consts::PER_PROJECT_LOCK_FILE);
    let bearer_map_path = state_dir.join(consts::OAUTH_BEARER_MAP_FILE);
    apply_oauth_config_with_paths(yaml, &state_dir, &lock_path, &bearer_map_path)
}

/// Test-only entry point — same logic, explicit paths.
fn apply_oauth_config_with_paths(
    yaml: &str,
    state_dir: &std::path::Path,
    lock_path: &std::path::Path,
    bearer_map_path: &std::path::Path,
) -> anyhow::Result<String> {
    // Stale lock.json survives a dead Desktop; gate on PID liveness to avoid injecting a dead port.
    let lock = match crate::host_mcp_process::lock::read(
        lock_path,
        crate::host_mcp_process::lock::LockService::Oauth,
    ) {
        Some(l) if crate::host_mcp_process::probe::is_pid_alive(l.pid) => l,
        _ => return Ok(yaml.to_string()),
    };
    let port = lock.port;
    let bearer_map = match read_oauth_bearer_map(bearer_map_path) {
        Some(m) => m,
        None => return Ok(yaml.to_string()),
    };
    if bearer_map.is_empty() {
        return Ok(yaml.to_string());
    }
    let url = worker_gateway_url(port);

    let mut doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(yaml)?;

    // Inject for every bearer-map consumer; the map is SSOT and covers plugins dynamically.
    for (bearer, service_id) in &bearer_map {
        let compose_service = oauth_consumer_compose_name(service_id);
        let bearer_file = state_dir.join(format!("bearer-{service_id}"));
        if !bearer_file.exists() {
            // Lazily write the per-service bearer file (chmod 0o600).
            if let Err(e) = crate::fs_perms::write_restricted_file(&bearer_file, bearer) {
                log::warn!("oauth: failed to write per-service bearer for '{service_id}': {e}");
                continue;
            }
        }
        ensure_host_gateway_extra_host(&mut doc, &compose_service)?;
        inject_env_into(&mut doc, &compose_service, "WORKER_OAUTH_URL", &url);
        let mount = format!(
            "{}:/secrets/oauth-auth-token-{service_id}:ro",
            to_engine_path(&bearer_file)?
        );
        add_service_volume(&mut doc, &compose_service, &mount);
    }

    Ok(serde_yaml_ng::to_string(&doc)?)
}

/// Resolves an OAuth consumer's compose service name (built-in: descriptor `compose_name`;
/// plugin: `mcp-<slug>`). SSOT shared by the spawn-side consumer list and compose injection.
pub fn oauth_consumer_compose_name(service_id: &str) -> String {
    consts::TOGGLEABLE_MCP_SERVICES
        .iter()
        .find(|d| d.config_key == service_id)
        .map(|d| d.compose_name.to_string())
        .unwrap_or_else(|| crate::plugin::derive_compose_name(service_id))
}

/// OAuth consumer service ids for a project: built-ins with `uses_oauth_refresh`
/// plus plugins declaring `oauth`. SSOT for the spawn consumer list + bearer-map.
pub fn oauth_consumer_service_ids(
    resolved: &crate::config::ResolvedIntegrationsConfig,
    enabled_plugins: &[crate::plugin::PluginManifest],
) -> Vec<String> {
    let mut out: Vec<String> = consts::TOGGLEABLE_MCP_SERVICES
        .iter()
        .filter(|d| {
            d.uses_oauth_refresh && resolved.is_service_enabled(d.config_key).unwrap_or(false)
        })
        .map(|d| d.config_key.to_string())
        .collect();
    for m in enabled_plugins {
        if m.oauth.is_some() {
            let sid = m.service_id.as_deref().unwrap_or(&m.slug);
            if resolved.is_plugin_enabled(sid) {
                out.push(sid.to_string());
            }
        }
    }
    out
}

/// Read the oauth bearer-map JSON (bearer → service). Returns `None` on any IO
/// or parse error (treats as "oauth worker not yet provisioned for this project").
fn read_oauth_bearer_map(
    path: &std::path::Path,
) -> Option<std::collections::BTreeMap<String, String>> {
    let content = std::fs::read_to_string(path).ok()?;
    let map: std::collections::BTreeMap<String, String> = serde_json::from_str(&content).ok()?;
    Some(map)
}

/// Returns the unprivileged `user:` (UID:GID) for compose services. Both platforms
/// run containerd as root in a VM, so UID 1000 maps 1:1 — no user-namespace remapping.
pub fn container_user() -> &'static str {
    consts::CONTAINER_USER_UNPRIVILEGED // "1000:1000"
}

/// Returns the IDE WebSocket host (`CLAUDE_CODE_IDE_HOST_OVERRIDE`), overriding Claude Code's
/// hardcoded `ws://127.0.0.1` to reach the host IDE Bridge via the `extra_hosts` gateway alias.
fn ide_host_override() -> &'static str {
    consts::HOST_GATEWAY_ALIAS
}

/// Verifies a plugin's `claude-resources` dir and every entry is a real, non-symlink path inside
/// the canonicalised plugin dir; any symlink is fatal (same invariant as `signing.rs` digest).
pub(crate) fn ensure_resources_dir_safe(plugin_dir: &Path, resources: &Path) -> anyhow::Result<()> {
    use std::fs;
    let resources_meta = fs::symlink_metadata(resources)?;
    if resources_meta.file_type().is_symlink() {
        anyhow::bail!("claude-resources is a symlink: {}", resources.display());
    }
    if !resources_meta.is_dir() {
        anyhow::bail!(
            "claude-resources is not a directory: {}",
            resources.display()
        );
    }
    let canonical_plugin = plugin_dir.canonicalize()?;
    let canonical_resources = resources.canonicalize()?;
    if !canonical_resources.starts_with(&canonical_plugin) {
        anyhow::bail!(
            "claude-resources canonicalises outside plugin dir: {} -> {}",
            resources.display(),
            canonical_resources.display()
        );
    }
    walk_reject_symlinks(resources)
}

fn walk_reject_symlinks(dir: &Path) -> anyhow::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let ft = std::fs::symlink_metadata(&path)?.file_type();
        if ft.is_symlink() {
            anyhow::bail!("claude-resources contains symlink: {}", path.display());
        }
        if ft.is_dir() {
            walk_reject_symlinks(&path)?;
        }
    }
    Ok(())
}

/// Injects an env var into the `mcp-hub` service. Thin wrapper over
/// [`inject_env_into`] — idempotent (replaces an existing entry).
pub(crate) fn inject_worker_env(doc: &mut serde_yaml_ng::Value, env_name: &str, url: &str) {
    inject_env_into(doc, "mcp-hub", env_name, url)
}

/// Inject `<env_name>=<value>` into a service's `environment` sequence. Idempotent: replaces
/// existing, creates if absent; warns and returns only if the service is missing.
pub(crate) fn inject_env_into(
    doc: &mut serde_yaml_ng::Value,
    service: &str,
    env_name: &str,
    value: &str,
) {
    let Some(services) = doc.get_mut("services").and_then(|s| s.as_mapping_mut()) else {
        log::warn!(
            "inject_env_into: 'services' key absent or not a mapping — cannot inject {env_name} into '{service}'"
        );
        return;
    };
    let Some(svc) = services
        .get_mut(serde_yaml_ng::Value::String(service.to_string()))
        .and_then(|s| s.as_mapping_mut())
    else {
        log::warn!("inject_env_into: service '{service}' absent — cannot inject {env_name}");
        return;
    };

    let env_key = serde_yaml_ng::Value::String("environment".to_string());
    let env_entry = svc
        .entry(env_key)
        .or_insert_with(|| serde_yaml_ng::Value::Sequence(Vec::new()));
    let Some(env_seq) = env_entry.as_sequence_mut() else {
        log::warn!("inject_env_into: service '{service}' 'environment' is not a sequence — cannot inject {env_name}");
        return;
    };

    let new_entry = format!("{}={}", env_name, value);
    let existing = env_seq.iter().position(|v| {
        v.as_str()
            .is_some_and(|s| s.split('=').next() == Some(env_name))
    });
    match existing {
        Some(idx) => env_seq[idx] = serde_yaml_ng::Value::String(new_entry),
        None => env_seq.push(serde_yaml_ng::Value::String(new_entry)),
    }
}

/// Adds a volume mount to the claude service, creating the `volumes:` sequence if
/// absent. Errors when the claude service is missing (the mount is a security boundary).
pub(crate) fn add_claude_volume(doc: &mut serde_yaml_ng::Value, mount: &str) -> anyhow::Result<()> {
    let claude = doc
        .get_mut("services")
        .and_then(|s| s.get_mut("claude"))
        .ok_or_else(|| anyhow::anyhow!("compose has no claude service to mount into"))?;
    let map = claude
        .as_mapping_mut()
        .ok_or_else(|| anyhow::anyhow!("claude service is not a mapping"))?;
    let key = serde_yaml_ng::Value::String("volumes".to_string());
    if !map.contains_key(&key) {
        map.insert(key.clone(), serde_yaml_ng::Value::Sequence(Vec::new()));
    }
    let vol_seq = map
        .get_mut(&key)
        .and_then(|v| v.as_sequence_mut())
        .ok_or_else(|| anyhow::anyhow!("claude volumes is not a sequence"))?;
    vol_seq.push(serde_yaml_ng::Value::String(mount.to_string()));
    Ok(())
}

/// Adds a volume mount to the mcp-hub service.
pub(crate) fn add_hub_volume(doc: &mut serde_yaml_ng::Value, mount: &str) {
    add_service_volume(doc, "mcp-hub", mount)
}

/// Ensures `<service>.extra_hosts` maps `HOST_GATEWAY_ALIAS` to the gateway IP (after
/// `${HOST_GATEWAY}` substitution). Idempotent by hostname prefix: replaces, never duplicates.
pub(crate) fn ensure_host_gateway_extra_host(
    doc: &mut serde_yaml_ng::Value,
    service: &str,
) -> anyhow::Result<()> {
    let canonical_entry = format!("{}:{}", consts::HOST_GATEWAY_ALIAS, host_gateway_ip()?);
    let hostname_prefix = format!("{}:", consts::HOST_GATEWAY_ALIAS);
    let Some(services) = doc.get_mut("services") else {
        return Ok(());
    };
    let Some(svc) = services.get_mut(service) else {
        return Ok(());
    };
    if svc.get("extra_hosts").is_none() {
        svc["extra_hosts"] =
            serde_yaml_ng::Value::Sequence(vec![serde_yaml_ng::Value::String(canonical_entry)]);
        return Ok(());
    }
    let Some(seq) = svc["extra_hosts"].as_sequence_mut() else {
        return Ok(());
    };
    if let Some(existing) = seq
        .iter_mut()
        .find(|v| v.as_str().is_some_and(|s| s.starts_with(&hostname_prefix)))
    {
        *existing = serde_yaml_ng::Value::String(canonical_entry);
    } else {
        seq.push(serde_yaml_ng::Value::String(canonical_entry));
    }
    Ok(())
}

/// Adds a volume mount to an arbitrary service. No-op if the service is absent.
fn add_service_volume(doc: &mut serde_yaml_ng::Value, service: &str, mount: &str) {
    if let Some(services) = doc.get_mut("services") {
        if let Some(svc) = services.get_mut(service) {
            if let Some(volumes) = svc.get_mut("volumes") {
                if let Some(vol_seq) = volumes.as_sequence_mut() {
                    vol_seq.push(serde_yaml_ng::Value::String(mount.to_string()));
                }
            } else {
                svc["volumes"] =
                    serde_yaml_ng::Value::Sequence(vec![serde_yaml_ng::Value::String(
                        mount.to_string(),
                    )]);
            }
        }
    }
}

/// Adds an environment variable to the claude service. Thin wrapper over
/// [`inject_env_into`] — idempotent (replaces an existing entry).
pub(crate) fn add_claude_env_var(doc: &mut serde_yaml_ng::Value, key: &str, value: &str) {
    inject_env_into(doc, "claude", key, value)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use strum::IntoEnumIterator;

    const SECURITY_RULE_COUNT: usize = 40;

    /// Repo root (holds `containers/`, `mcp-servers/`), derived from this crate's manifest dir —
    /// the injected bundle build root, so manifest resolution never reads the process-global env.
    fn test_build_root() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(Path::parent)
            .expect("crate manifest dir has a workspace grandparent")
            .to_path_buf()
    }

    /// Existing project dir for render tests (validation rejects vanished dirs).
    fn tmp_project_dir() -> &'static str {
        std::fs::create_dir_all("/tmp/speedwave-test-project").unwrap();
        "/tmp/speedwave-test-project"
    }

    /// Isolated `render_compose` for tests: roots data-dir paths at the caller's tempdir
    /// and resolves the bundle manifest via `TEST_BUILD_ROOT` — no global `~/.speedwave` or env.
    fn render_compose_isolated(
        data_dir: &Path,
        project_name: &str,
        project_dir: &str,
        resolved_config: &ResolvedClaudeConfig,
        integrations: &ResolvedIntegrationsConfig,
        runtime: Option<&crate::runtime::LockedRuntime>,
        bridges: &HostBridgesInfo,
    ) -> anyhow::Result<String> {
        // RAII guard clears the thread-local on scope exit (even on panic), so a
        // later test reusing this libtest thread never inherits a stale build root.
        struct BuildRootGuard;
        impl Drop for BuildRootGuard {
            fn drop(&mut self) {
                TEST_BUILD_ROOT.with(|r| *r.borrow_mut() = None);
            }
        }
        TEST_BUILD_ROOT.with(|r| *r.borrow_mut() = Some(test_build_root()));
        let _guard = BuildRootGuard;
        render_compose_in(
            data_dir,
            project_name,
            project_dir,
            resolved_config,
            integrations,
            runtime,
            bridges,
        )
    }

    /// Builds a minimal ResolvedClaudeConfig whose telemetry is resolved from the
    /// given user/MDM layers, for the managed-settings mount tests.
    fn resolved_with_telemetry(
        user: Option<&crate::config::TelemetryConfig>,
        managed: Option<&crate::config::ManagedTelemetryConfig>,
    ) -> ResolvedClaudeConfig {
        let (telemetry, telemetry_error) = match crate::config::resolve_telemetry(user, managed) {
            Ok(t) => (t, None),
            Err(e) => (
                crate::config::ResolvedTelemetry::disabled(),
                Some(e.to_string()),
            ),
        };
        let mut llm = crate::config::LlmConfig {
            provider: Some("local".to_string()),
            model: Some("test/model".to_string()),
            base_url: Some("http://100.74.182.88:8888".to_string()),
            ..Default::default()
        };
        crate::config::migrate_llm(&mut llm, crate::config::AnthropicEvidence::None);
        ResolvedClaudeConfig {
            env: std::collections::HashMap::new(),
            flags: default_flags(),
            llm,
            telemetry,
            telemetry_error,
        }
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn managed_settings_mount_present_only_when_locked() {
        let data_dir = tempfile::tempdir().unwrap();
        let project = format!("mdm-mount-{}", std::process::id());
        let tmp = tempfile::tempdir().unwrap();
        let project_dir = tmp.path().join("project");
        std::fs::create_dir_all(&project_dir).unwrap();

        let managed = crate::config::ManagedTelemetryConfig {
            enabled: Some(true),
            endpoint: Some("https://c.example.com:4318".into()),
            ..Default::default()
        };
        let resolved = resolved_with_telemetry(None, Some(&managed));
        let yaml = render_compose_isolated(
            data_dir.path(),
            &project,
            project_dir.to_str().unwrap(),
            &resolved,
            &ResolvedIntegrationsConfig::default(),
            None,
            &HostBridgesInfo::default(),
        )
        .expect("render must succeed");
        assert!(yaml.contains("/etc/claude-code/managed-settings.json:ro"));

        // Without MDM: no mount.
        let resolved_none = resolved_with_telemetry(None, None);
        let yaml_none = render_compose_isolated(
            data_dir.path(),
            &project,
            project_dir.to_str().unwrap(),
            &resolved_none,
            &ResolvedIntegrationsConfig::default(),
            None,
            &HostBridgesInfo::default(),
        )
        .expect("render must succeed");
        assert!(!yaml_none.contains("/etc/claude-code/managed-settings.json"));
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn render_hard_errors_on_invalid_telemetry_endpoint() {
        let data_dir = tempfile::tempdir().unwrap();
        let project = format!("mdm-badurl-{}", std::process::id());
        let tmp = tempfile::tempdir().unwrap();
        let project_dir = tmp.path().join("project");
        std::fs::create_dir_all(&project_dir).unwrap();

        let user = crate::config::TelemetryConfig {
            enabled: Some(true),
            endpoint: Some("ftp://evil/".into()),
            export_metrics: Some(true),
            ..Default::default()
        };
        let resolved = resolved_with_telemetry(Some(&user), None);
        let err = render_compose_isolated(
            data_dir.path(),
            &project,
            project_dir.to_str().unwrap(),
            &resolved,
            &ResolvedIntegrationsConfig::default(),
            None,
            &HostBridgesInfo::default(),
        );
        assert!(
            err.is_err(),
            "invalid OTLP endpoint must abort render/start"
        );
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn render_hard_errors_on_crlf_header() {
        let data_dir = tempfile::tempdir().unwrap();
        let project = format!("mdm-crlf-{}", std::process::id());
        let tmp = tempfile::tempdir().unwrap();
        let project_dir = tmp.path().join("project");
        std::fs::create_dir_all(&project_dir).unwrap();

        let managed = crate::config::ManagedTelemetryConfig {
            enabled: Some(true),
            endpoint: Some("https://c:4318".into()),
            headers: Some("Authorization=Bearer x\r\nInjected: y".into()),
            ..Default::default()
        };
        let resolved = resolved_with_telemetry(None, Some(&managed));
        let err = render_compose_isolated(
            data_dir.path(),
            &project,
            project_dir.to_str().unwrap(),
            &resolved,
            &ResolvedIntegrationsConfig::default(),
            None,
            &HostBridgesInfo::default(),
        );
        assert!(
            err.is_err(),
            "CRLF-bearing MDM header must abort render/start"
        );
    }

    /// Renders via `render_compose` with a local LLM provider + multi-line
    /// custom_headers and checks the result re-parses (production code path).
    #[test]
    #[serial_test::serial(host_addressing)]
    fn render_compose_with_multiline_custom_headers_is_valid_yaml() {
        let data_dir = tempfile::tempdir().unwrap();
        let project = format!("render-multiline-headers-{}", std::process::id());
        let tokens_dir = ensure_token_dir_in(data_dir.path(), &project, "local-llm")
            .expect("ensure_token_dir must succeed in test env");
        std::fs::write(tokens_dir.join("api_key"), "sk-test-key").unwrap();
        std::fs::write(
            tokens_dir.join("custom_headers"),
            "X-Tenant-ID: foo\nX-Subscription-ID: bar\n",
        )
        .unwrap();
        let tmp = tempfile::tempdir().unwrap();
        let project_dir = tmp.path().join("project");
        std::fs::create_dir_all(&project_dir).unwrap();

        let mut llm = crate::config::LlmConfig {
            provider: Some("local".to_string()),
            model: Some("unsloth/Qwen3.6-35B".to_string()),
            base_url: Some("http://100.74.182.88:8888".to_string()),
            context_tokens: None,
            has_api_key: true,
            has_custom_headers: true,
            ..Default::default()
        };
        crate::config::migrate_llm(&mut llm, crate::config::AnthropicEvidence::None);
        let resolved = ResolvedClaudeConfig {
            env: std::collections::HashMap::new(),
            flags: default_flags(),
            llm,
            ..Default::default()
        };
        let integrations = ResolvedIntegrationsConfig::default();

        let yaml = render_compose_isolated(
            data_dir.path(),
            &project,
            project_dir.to_str().unwrap(),
            &resolved,
            &integrations,
            None,
            &HostBridgesInfo::default(),
        )
        .expect("render must succeed");

        // Sanitise panic message: rendered YAML carries cleartext ANTHROPIC_AUTH_TOKEN (CodeQL).
        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&yaml)
            .unwrap_or_else(|e| panic!("rendered compose YAML must re-parse: {e}"));
        // Custom headers must be single-line: nerdctl/docker-compose reject block literals in environment.
        let env_seq = doc["services"]["claude"]["environment"]
            .as_sequence()
            .expect("claude.environment must be a sequence");
        let header_entry = env_seq
            .iter()
            .filter_map(|v| v.as_str())
            .find(|s| s.starts_with("ANTHROPIC_CUSTOM_HEADERS="))
            .expect("ANTHROPIC_CUSTOM_HEADERS entry present");
        assert!(
            !header_entry.contains('\n'),
            "header env var must be a single line, got: {header_entry:?}"
        );
        assert!(header_entry.contains("X-Tenant-ID: foo"));
        assert!(header_entry.contains("X-Subscription-ID: bar"));
        // Rendered scalar must be plain in raw YAML: block literals break nerdctl-compose.
        assert!(
            !yaml.contains("ANTHROPIC_CUSTOM_HEADERS=\n")
                && !yaml.contains("- |-")
                && !yaml.contains("- |\n"),
            "headers env var must render as a single-line plain scalar, not \
             a block literal (would break nerdctl-compose)"
        );

        // Cleanup — best-effort, errors here would mask the assertion above.
        let _ = std::fs::remove_file(tokens_dir.join("api_key"));
        let _ = std::fs::remove_file(tokens_dir.join("custom_headers"));
        let _ = std::fs::remove_dir(&tokens_dir);
    }

    /// Render must host-create the claude-home source incl. the nested
    /// .claude/ide mountpoint — else rootful nerdctl creates them root:root.
    #[test]
    #[serial_test::serial(host_addressing)]
    fn render_compose_precreates_claude_home_with_nested_ide_mountpoint() {
        let data_dir = tempfile::tempdir().unwrap();
        let project = format!("render-claude-home-{}", std::process::id());
        let tmp = tempfile::tempdir().unwrap();
        let project_dir = tmp.path().join("project");
        std::fs::create_dir_all(&project_dir).unwrap();

        let mut llm = crate::config::LlmConfig::default();
        crate::config::migrate_llm(&mut llm, crate::config::AnthropicEvidence::Oauth);
        let resolved = ResolvedClaudeConfig {
            env: std::collections::HashMap::new(),
            flags: default_flags(),
            llm,
            ..Default::default()
        };
        render_compose_isolated(
            data_dir.path(),
            &project,
            project_dir.to_str().unwrap(),
            &resolved,
            &ResolvedIntegrationsConfig::default(),
            None,
            &HostBridgesInfo::default(),
        )
        .expect("render must succeed");

        let nested = crate::claude_home::claude_home_dir(data_dir.path(), &project)
            .join(".claude")
            .join("ide");
        assert!(
            nested.is_dir(),
            "render_compose must pre-create {nested:?} host-side"
        );
        // Umbrella (ADR-052): every data_dir-rooted mount source pre-created.
        let llm_tokens = data_dir.path().join("tokens").join(&project).join("llm");
        assert!(
            llm_tokens.is_dir(),
            "render_compose must pre-create the proxy token mount source"
        );
        assert!(data_dir.path().join("claude-resources").is_dir());
    }

    #[test]
    fn ensure_data_dir_mount_sources_creates_only_data_dir_paths() {
        let data_dir = tempfile::tempdir().unwrap();
        let prefix = to_engine_path(data_dir.path()).unwrap();
        let yaml = format!(
            "services:\n  x:\n    volumes:\n      - {prefix}/tokens/p/llm:/tokens:ro\n      - {prefix}/claude-resources:/speedwave/resources:ro\n      - /workspace-elsewhere:/workspace:rw\n    environment:\n      - FOO=bar\n"
        );
        ensure_data_dir_mount_sources(data_dir.path(), &yaml).unwrap();
        assert!(data_dir.path().join("tokens/p/llm").is_dir());
        assert!(data_dir.path().join("claude-resources").is_dir());
        assert!(!Path::new("/workspace-elsewhere").exists());
    }

    #[test]
    fn render_compose_rejects_missing_project_dir() {
        let data_dir = tempfile::tempdir().unwrap();
        let mut llm = crate::config::LlmConfig::default();
        crate::config::migrate_llm(&mut llm, crate::config::AnthropicEvidence::Oauth);
        let resolved = ResolvedClaudeConfig {
            env: std::collections::HashMap::new(),
            flags: default_flags(),
            llm,
            ..Default::default()
        };
        let err = render_compose_isolated(
            data_dir.path(),
            "ghost-project",
            "/definitely/not/a/real/dir-e2e",
            &resolved,
            &ResolvedIntegrationsConfig::default(),
            None,
            &HostBridgesInfo::default(),
        )
        .unwrap_err();
        assert!(
            err.to_string().contains("no longer exists"),
            "vanished workspace must be a clear error, got: {err}"
        );
    }

    /// A project with a stale `anthropic_api_key` file but an active OpenRouter
    /// provider must NOT get `ANTHROPIC_API_KEY` re-injected into `claude` (the
    /// flat provider string masquerades as `anthropic` for downgrade compat).
    #[test]
    #[serial_test::serial(host_addressing)]
    fn render_compose_no_anthropic_key_when_openrouter_active() {
        let data_dir = tempfile::tempdir().unwrap();
        let project = format!("render-stale-key-openrouter-{}", std::process::id());
        // Stale Anthropic key from a prior Anthropic session.
        let secrets = data_dir.path().join("secrets").join(&project);
        std::fs::create_dir_all(&secrets).unwrap();
        std::fs::write(secrets.join("anthropic_api_key"), "sk-ant-stale").unwrap();

        let tmp = tempfile::tempdir().unwrap();
        let project_dir = tmp.path().join("project");
        std::fs::create_dir_all(&project_dir).unwrap();

        let llm = crate::config::LlmConfig {
            schema_version: Some(crate::config::LLM_SCHEMA_VERSION),
            providers: vec![crate::config::LlmProviderEntry {
                id: "openrouter".to_string(),
                kind: crate::config::LlmProviderKind::OpenRouter,
                base_url: None,
                model: Some("z-ai/glm-5.2".to_string()),
                has_api_key: true,
                context_tokens: None,
                has_custom_headers: false,
            }],
            active: Some(crate::config::LlmActive {
                provider_id: "openrouter".to_string(),
                model: Some("z-ai/glm-5.2".to_string()),
            }),
            ..Default::default()
        };
        let resolved = ResolvedClaudeConfig {
            env: std::collections::HashMap::new(),
            flags: default_flags(),
            llm,
            ..Default::default()
        };

        let yaml = render_compose_isolated(
            data_dir.path(),
            &project,
            project_dir.to_str().unwrap(),
            &resolved,
            &ResolvedIntegrationsConfig::default(),
            None,
            &HostBridgesInfo::default(),
        )
        .expect("render must succeed");

        assert!(
            !yaml.contains("ANTHROPIC_API_KEY"),
            "stale Anthropic key must not be injected while OpenRouter is active"
        );
        let _ = std::fs::remove_file(secrets.join("anthropic_api_key"));
    }

    /// Regression for the unquoted `[1m]` suffix nerdctl's Go YAML parser rejects;
    /// rendered file must re-parse and carry the bracketed entry as a quoted scalar.
    #[test]
    #[serial_test::serial(host_addressing)]
    fn render_compose_quotes_bracketed_model_env_and_round_trips() {
        let data_dir = tempfile::tempdir().unwrap();
        let project = format!("render-1m-suffix-{}", std::process::id());
        let tmp = tempfile::tempdir().unwrap();
        let project_dir = tmp.path().join("project");
        std::fs::create_dir_all(&project_dir).unwrap();

        // Default Anthropic provider (no explicit model) — exercises
        // anthropic_default_models_env(), which emits the `[1m]` suffix.
        let mut llm = LlmConfig {
            provider: Some("anthropic".to_string()),
            model: None,
            base_url: None,
            context_tokens: None,
            has_api_key: false,
            has_custom_headers: false,
            ..Default::default()
        };
        crate::config::migrate_llm(&mut llm, crate::config::AnthropicEvidence::None);
        let resolved = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: default_flags(),
            llm,
            ..Default::default()
        };

        let yaml = render_compose_isolated(
            data_dir.path(),
            &project,
            project_dir.to_str().unwrap(),
            &resolved,
            &ResolvedIntegrationsConfig::default(),
            None,
            &HostBridgesInfo::default(),
        )
        .expect("render must succeed");

        // (a) Round-trips through the parser.
        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&yaml)
            .unwrap_or_else(|e| panic!("rendered compose YAML must re-parse: {e}"));
        let env = doc["services"]["claude"]["environment"]
            .as_sequence()
            .expect("claude.environment must be a sequence");
        let opus = env
            .iter()
            .filter_map(|v| v.as_str())
            .find(|s| s.starts_with("ANTHROPIC_DEFAULT_OPUS_MODEL="))
            .expect("ANTHROPIC_DEFAULT_OPUS_MODEL must be present");
        assert!(
            opus.ends_with("[1m]"),
            "1M-context suffix must survive intact, got: {opus:?}"
        );

        // (b) Across every service, each env entry with a flow indicator must be a
        // quoted scalar in raw YAML; scoped to env values only (not tmpfs mounts etc).
        let services = doc["services"].as_mapping().expect("services mapping");
        for (_, svc) in services {
            let Some(env) = svc.get("environment").and_then(|e| e.as_sequence()) else {
                continue;
            };
            for v in env {
                let Some(entry) = v.as_str() else { continue };
                if !env_entry_needs_quoting(entry) {
                    continue;
                }
                let quoted = format!("- {}", serde_json::to_string(entry).unwrap());
                assert!(
                    yaml.contains(&quoted),
                    "env entry {entry:?} carries a flow indicator but is not a quoted \
                     scalar in the rendered YAML; expected a line containing {quoted:?}"
                );
            }
        }
    }

    /// A stale `custom_headers` `Authorization` must not smuggle a header colliding with the
    /// `ANTHROPIC_AUTH_TOKEN` Bearer. Mirrors the reject in `build_llm_probe_client_with_auth`.
    #[test]
    #[serial_test::serial(host_addressing)]
    fn render_compose_strips_authorization_from_custom_headers() {
        let data_dir = tempfile::tempdir().unwrap();
        let project = format!("authz-strip-{}", std::process::id());
        let tokens_dir = ensure_token_dir_in(data_dir.path(), &project, "local-llm")
            .expect("ensure_token_dir must succeed in test env");
        std::fs::write(tokens_dir.join("api_key"), "sk-test").unwrap();
        std::fs::write(
            tokens_dir.join("custom_headers"),
            "X-Tenant-ID: foo\nAuthorization: Bearer leaked\nX-Other: bar\n",
        )
        .unwrap();
        let tmp = tempfile::tempdir().unwrap();
        let project_dir = tmp.path().join("project");
        std::fs::create_dir_all(&project_dir).unwrap();

        let mut llm = crate::config::LlmConfig {
            provider: Some("local".to_string()),
            model: Some("m".to_string()),
            base_url: Some("http://x:1".to_string()),
            context_tokens: None,
            has_api_key: true,
            has_custom_headers: true,
            ..Default::default()
        };
        crate::config::migrate_llm(&mut llm, crate::config::AnthropicEvidence::None);
        let resolved = ResolvedClaudeConfig {
            env: std::collections::HashMap::new(),
            flags: default_flags(),
            llm,
            ..Default::default()
        };
        let yaml = render_compose_isolated(
            data_dir.path(),
            &project,
            project_dir.to_str().unwrap(),
            &resolved,
            &ResolvedIntegrationsConfig::default(),
            None,
            &HostBridgesInfo::default(),
        )
        .unwrap();
        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&yaml).unwrap();
        let header_entry = doc["services"]["claude"]["environment"]
            .as_sequence()
            .unwrap()
            .iter()
            .filter_map(|v| v.as_str())
            .find(|s| s.starts_with("ANTHROPIC_CUSTOM_HEADERS="))
            .expect("header entry present");
        assert!(header_entry.contains("X-Tenant-ID"));
        assert!(header_entry.contains("X-Other"));
        assert!(
            !header_entry.to_ascii_lowercase().contains("authorization"),
            "Authorization header must be stripped, got: {header_entry:?}"
        );
        assert!(!header_entry.contains("leaked"));

        let _ = std::fs::remove_file(tokens_dir.join("api_key"));
        let _ = std::fs::remove_file(tokens_dir.join("custom_headers"));
        let _ = std::fs::remove_dir(&tokens_dir);
    }

    /// Multi-line `ANTHROPIC_CUSTOM_HEADERS` must serialise as a quoted scalar so the
    /// YAML parser does not treat the second line as a new top-level key.
    #[test]
    fn inject_claude_env_multiline_value_keeps_yaml_parseable() {
        let yaml = "services:\n  claude:\n    image: x\n    environment:\n    - PORT=4000\n";
        let mut env = std::collections::HashMap::new();
        env.insert(
            "ANTHROPIC_CUSTOM_HEADERS".to_string(),
            "X-Tenant-ID: foo\nX-Subscription-ID: bar".to_string(),
        );
        let injected = inject_claude_env(yaml, &env).expect("inject must succeed");
        // The injected YAML must re-parse cleanly; if the multi-line value
        // breaks YAML structure, `from_str` will fail.
        let _doc: serde_yaml_ng::Value =
            serde_yaml_ng::from_str(&injected).expect("re-parsed YAML must be valid");
        // And the header value must still be retrievable intact.
        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&injected).unwrap();
        let env_seq = doc["services"]["claude"]["environment"]
            .as_sequence()
            .unwrap();
        let header_entry = env_seq
            .iter()
            .filter_map(|v| v.as_str())
            .find(|s| s.starts_with("ANTHROPIC_CUSTOM_HEADERS="))
            .expect("header entry present");
        assert!(header_entry.contains("X-Tenant-ID: foo"));
        assert!(header_entry.contains("X-Subscription-ID: bar"));
    }

    /// Migrated, configured Anthropic-OAuth `LlmConfig` for tests that only need
    /// *some* renderable LLM config as an unrelated fixture (SSOT gate requires
    /// a resolved active provider — see `LlmConfig::is_unconfigured`).
    fn configured_anthropic_llm() -> LlmConfig {
        let mut llm = LlmConfig {
            provider: Some("anthropic".to_string()),
            ..Default::default()
        };
        crate::config::migrate_llm(&mut llm, crate::config::AnthropicEvidence::None);
        llm
    }

    fn default_flags() -> Vec<String> {
        crate::defaults::DEFAULT_FLAGS
            .iter()
            .map(|s| s.to_string())
            .collect()
    }

    fn get_hub_env_seq(doc: &serde_yaml_ng::Value) -> Vec<String> {
        get_service_env_seq(doc, "mcp-hub")
    }

    fn find_env_value(env: &[String], prefix: &str) -> Option<String> {
        env.iter()
            .find(|s| s.starts_with(prefix))
            .map(|s| s[prefix.len()..].to_string())
    }

    /// Returns VALID_COMPOSE with user values replaced by `container_user()` ("1000:1000").
    fn valid_compose_yaml() -> String {
        VALID_COMPOSE.replace(
            "user: \"1000:1000\"",
            &format!("user: \"{}\"", container_user()),
        )
    }

    const VALID_COMPOSE: &str = r#"
version: "3"
services:
  claude:
    image: speedwave-claude:latest
    container_name: speedwave_test_claude
    read_only: true
    user: "1000:1000"
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp:noexec,nosuid,size=512m
    volumes:
      - /home/user/.speedwave/claude-home/test:/home/speedwave:rw
      - /home/user/projects/test:/workspace
      - /home/user/.speedwave/claude-resources:/speedwave/resources:ro
    environment:
      - CLAUDE_VERSION=1.0.3
      - DISABLE_AUTOUPDATER=1
    networks:
      - speedwave_test_network

  mcp-hub:
    image: speedwave-mcp-hub:latest
    container_name: speedwave_test_mcp_hub
    read_only: true
    user: "1000:1000"
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp:noexec,nosuid,size=64m
    environment:
      - PORT=4000
      - WORKER_SLACK_URL=http://mcp-slack:3000
      - WORKER_SHAREPOINT_URL=http://mcp-sharepoint:3000
      - WORKER_REDMINE_URL=http://mcp-redmine:3000
      - WORKER_GITLAB_URL=http://mcp-gitlab:3000
      - WORKER_GITHUB_URL=http://mcp-github:3000
      - WORKER_ATLASSIAN_URL=http://mcp-atlassian:3000
      - WORKER_OFFICE_URL=http://mcp-office:3000
      - WORKER_PLAYWRIGHT_URL=http://mcp-playwright:3000
      - WORKER_CONTEXT7_URL=http://mcp-context7:3000
    networks:
      - speedwave_test_network
      - speedwave_test_network_office

  mcp-slack:
    image: speedwave-mcp-slack:latest
    container_name: speedwave_test_mcp_slack
    read_only: true
    user: "1000:1000"
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp:noexec,nosuid,size=64m
    volumes:
      - /test/.speedwave/tokens/test/slack:/tokens:ro
      - /test/project:/workspace:rw
    environment:
      - PORT=3000
    networks:
      - speedwave_test_network

  mcp-office:
    image: speedwave-mcp-office:latest
    container_name: speedwave_test_mcp_office
    read_only: true
    user: "1000:1000"
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp:noexec,nosuid,size=512m
    volumes:
      - /home/user/projects/test:/workspace:rw
    environment:
      - PORT=3000
    networks:
      - speedwave_test_network_office

  mcp-playwright:
    image: speedwave-mcp-playwright:latest
    container_name: speedwave_test_mcp_playwright
    read_only: true
    user: "1000:1000"
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp:noexec,nosuid,size=1g
    shm_size: 2g
    environment:
      - PORT=3000
    networks:
      - speedwave_test_network

  mcp-context7:
    image: speedwave-mcp-context7:latest
    container_name: speedwave_test_mcp_context7
    read_only: true
    user: "1000:1000"
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp:noexec,nosuid,size=64m
    volumes:
      - /home/user/.speedwave/tokens/test/context7:/tokens:ro
    environment:
      - PORT=3000
    networks:
      - speedwave_test_network

networks:
  speedwave_test_network:
    driver: bridge
  speedwave_test_network_office:
    driver: bridge
    internal: true
"#;

    #[test]
    fn test_security_check_valid_compose() {
        let tmp = tempfile::tempdir().unwrap();
        let yaml = valid_compose_yaml();
        let violations = SecurityCheck::run_with_data_dir(
            &yaml,
            "test",
            &[],
            &test_expected_paths(),
            tmp.path(),
        );
        assert!(
            violations.is_empty(),
            "Expected no violations, got: {:?}",
            violations
                .iter()
                .map(|v| format!("{}", v))
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn test_security_check_missing_cap_drop() {
        let data_dir = tempfile::tempdir().unwrap();
        let yaml = r#"
version: "3"
services:
  claude:
    image: speedwave-claude:latest
    read_only: true
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp:noexec,nosuid,size=512m
    environment:
      - CLAUDE_VERSION=1.0.3
"#;
        let violations = SecurityCheck::run_with_data_dir(
            yaml,
            "test",
            &[],
            &test_expected_paths(),
            data_dir.path(),
        );
        assert!(violations
            .iter()
            .any(|v| v.rule == SecurityRule::CapDropAll));
    }

    #[test]
    fn test_security_check_missing_no_new_privileges() {
        let data_dir = tempfile::tempdir().unwrap();
        let yaml = r#"
version: "3"
services:
  claude:
    image: speedwave-claude:latest
    read_only: true
    cap_drop:
      - ALL
    tmpfs:
      - /tmp:noexec,nosuid,size=512m
    environment:
      - CLAUDE_VERSION=1.0.3
"#;
        let violations = SecurityCheck::run_with_data_dir(
            yaml,
            "test",
            &[],
            &test_expected_paths(),
            data_dir.path(),
        );
        assert!(violations
            .iter()
            .any(|v| v.rule == SecurityRule::NoNewPrivs));
    }

    #[test]
    fn test_security_check_claude_read_only_missing() {
        let data_dir = tempfile::tempdir().unwrap();
        let yaml = r#"
version: "3"
services:
  claude:
    image: speedwave-claude:latest
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp:noexec,nosuid,size=512m
    environment:
      - CLAUDE_VERSION=1.0.3
"#;
        let violations = SecurityCheck::run_with_data_dir(
            yaml,
            "test",
            &[],
            &test_expected_paths(),
            data_dir.path(),
        );
        assert!(violations
            .iter()
            .any(|v| v.rule == SecurityRule::ReadOnlyFs && v.container == "claude"));
    }

    #[test]
    fn test_security_check_tmpfs_missing() {
        let data_dir = tempfile::tempdir().unwrap();
        let yaml = r#"
version: "3"
services:
  claude:
    image: speedwave-claude:latest
    read_only: true
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    environment:
      - CLAUDE_VERSION=1.0.3
"#;
        let violations = SecurityCheck::run_with_data_dir(
            yaml,
            "test",
            &[],
            &test_expected_paths(),
            data_dir.path(),
        );
        assert!(violations
            .iter()
            .any(|v| v.rule == SecurityRule::TmpfsNoexec));
    }

    #[test]
    fn test_security_check_tokens_in_claude() {
        let data_dir = tempfile::tempdir().unwrap();
        let yaml = r#"
version: "3"
services:
  claude:
    image: speedwave-claude:latest
    read_only: true
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp:noexec,nosuid,size=512m
    environment:
      - CLAUDE_VERSION=1.0.3
      - SLACK_TOKEN=xoxb-12345
"#;
        let violations = SecurityCheck::run_with_data_dir(
            yaml,
            "test",
            &[],
            &test_expected_paths(),
            data_dir.path(),
        );
        assert!(violations
            .iter()
            .any(|v| v.rule == SecurityRule::NoTokensClaude));
    }

    #[test]
    fn test_security_check_ports_not_localhost() {
        let data_dir = tempfile::tempdir().unwrap();
        let yaml = r#"
version: "3"
services:
  mcp-hub:
    image: speedwave-mcp-hub:latest
    read_only: true
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp:noexec,nosuid,size=64m
    ports:
      - "0.0.0.0:4000:4000"
"#;
        let violations = SecurityCheck::run_with_data_dir(
            yaml,
            "test",
            &[],
            &test_expected_paths(),
            data_dir.path(),
        );
        assert!(violations
            .iter()
            .any(|v| v.rule == SecurityRule::PortsLocalhost));
    }

    #[test]
    fn test_security_check_claude_docker_socket() {
        let data_dir = tempfile::tempdir().unwrap();
        let yaml = r#"
version: "3"
services:
  claude:
    image: speedwave-claude:latest
    read_only: true
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp:noexec,nosuid,size=512m
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    environment:
      - CLAUDE_VERSION=1.0.3
"#;
        let violations = SecurityCheck::run_with_data_dir(
            yaml,
            "test",
            &[],
            &test_expected_paths(),
            data_dir.path(),
        );
        assert!(violations
            .iter()
            .any(|v| v.rule == SecurityRule::NoSocketClaude));
    }

    #[test]
    fn test_security_check_external_llm_keys_in_claude() {
        let data_dir = tempfile::tempdir().unwrap();
        let yaml = r#"
version: "3"
services:
  claude:
    image: speedwave-claude:latest
    read_only: true
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp:noexec,nosuid,size=512m
    environment:
      - CLAUDE_VERSION=1.0.3
      - OPENAI_API_KEY=sk-12345
"#;
        let violations = SecurityCheck::run_with_data_dir(
            yaml,
            "test",
            &[],
            &test_expected_paths(),
            data_dir.path(),
        );
        assert!(violations
            .iter()
            .any(|v| v.rule == SecurityRule::NoExternalLlmKeysClaude));
    }

    #[test]
    fn test_security_check_external_llm_keys_covers_major_providers() {
        let data_dir = tempfile::tempdir().unwrap();
        // One violation per leaked key; covers every major third-party LLM vendor.
        for key in [
            "OPENAI_API_KEY=sk-x",
            "AZURE_OPENAI_API_KEY=az-x",
            "GEMINI_API_KEY=g-x",
            "DEEPSEEK_API_KEY=ds-x",
            "OPENROUTER_API_KEY=or-x",
            "COHERE_API_KEY=co-x",
            "MISTRAL_API_KEY=mi-x",
            "TOGETHER_API_KEY=to-x",
            "GROQ_API_KEY=gq-x",
        ] {
            let yaml = format!(
                r#"
version: "3"
services:
  claude:
    image: speedwave-claude:latest
    read_only: true
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp:noexec,nosuid,size=512m
    environment:
      - {key}
"#
            );
            let violations = SecurityCheck::run_with_data_dir(
                &yaml,
                "test",
                &[],
                &test_expected_paths(),
                data_dir.path(),
            );
            assert!(
                violations
                    .iter()
                    .any(|v| v.rule == SecurityRule::NoExternalLlmKeysClaude),
                "must flag {key} as an external LLM key"
            );
        }
    }

    #[test]
    fn test_security_check_invalid_yaml() {
        let data_dir = tempfile::tempdir().unwrap();
        let violations = SecurityCheck::run_with_data_dir(
            "not: valid: yaml: [[[",
            "test",
            &[],
            &test_expected_paths(),
            data_dir.path(),
        );
        assert!(violations
            .iter()
            .any(|v| v.rule == SecurityRule::YamlParseError));
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn test_render_compose_substitution() {
        let data_dir = tempfile::tempdir().unwrap();
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: default_flags(),
            llm: configured_anthropic_llm(),
            ..Default::default()
        };
        let result = render_compose_isolated(
            data_dir.path(),
            "test-project",
            tmp_project_dir(),
            &config,
            &ResolvedIntegrationsConfig::default(),
            None,
            &HostBridgesInfo::default(),
        );
        assert!(result.is_ok());
        let yaml = result.unwrap();
        // Derive the prefix from the SSOT rather than hardcoding "speedwave",
        // so the test holds whatever data_dir basename the process resolved.
        let prefix = consts::compose_prefix();
        assert!(yaml.contains(&format!("{prefix}_test-project_claude")));
        assert!(yaml.contains(&format!("{prefix}_test-project_mcp_hub")));
        assert!(yaml.contains("/workspace"));
        // Resource placeholders must all be substituted; the concrete values are
        // asserted against the SSOT by `resources_render_from_ssot`.
        assert!(
            !yaml.contains("${CLAUDE_MEMORY}") && !yaml.contains("${MCP_"),
            "resource placeholders must be substituted"
        );
        // Verify it's valid YAML
        let parsed: serde_yaml_ng::Value = serde_yaml_ng::from_str(&yaml).unwrap();
        assert!(parsed.get("services").is_some());
    }

    /// SSOT alignment (ADR-072): every `${IMAGE_*}` placeholder has a substitution entry, every
    /// entry exists in the template, and every catalogue image is covered (no unsubstituted render).
    #[test]
    fn image_placeholders_align_with_catalogue_and_template() {
        assert_eq!(
            IMAGE_PLACEHOLDERS.len(),
            build::IMAGES.len(),
            "one placeholder entry per catalogue image"
        );
        for img in build::IMAGES {
            assert!(
                IMAGE_PLACEHOLDERS.iter().any(|(_, name)| *name == img.name),
                "catalogue image '{}' has no placeholder entry",
                img.name
            );
        }
        for (placeholder, _) in IMAGE_PLACEHOLDERS {
            assert!(
                COMPOSE_TEMPLATE.contains(placeholder),
                "placeholder {placeholder} missing from compose.template.yml"
            );
        }
        for line in COMPOSE_TEMPLATE.lines() {
            let mut rest = line;
            while let Some(pos) = rest.find("${IMAGE_") {
                let tail = &rest[pos..];
                let end = tail.find('}').expect("unterminated ${IMAGE_ placeholder") + 1;
                let placeholder = &tail[..end];
                assert!(
                    IMAGE_PLACEHOLDERS.iter().any(|(p, _)| *p == placeholder),
                    "template placeholder {placeholder} has no substitution entry"
                );
                rest = &tail[end..];
            }
        }
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn test_render_compose_uses_bundle_scoped_image_refs() {
        let data_dir = tempfile::tempdir().unwrap();
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: default_flags(),
            llm: configured_anthropic_llm(),
            ..Default::default()
        };
        let manifest = bundle::load_current_bundle_manifest_from(&test_build_root()).unwrap();

        let yaml = render_compose_isolated(
            data_dir.path(),
            "test-project",
            tmp_project_dir(),
            &config,
            &all_enabled_integrations(),
            None,
            &HostBridgesInfo::default(),
        )
        .unwrap();

        // Each service carries its own per-image build-input hash tag (ADR-072).
        for image_name in [
            build::IMAGE_CLAUDE,
            build::IMAGE_MCP_HUB,
            build::IMAGE_MCP_SLACK,
            build::IMAGE_MCP_SHAREPOINT,
            build::IMAGE_MCP_REDMINE,
            build::IMAGE_MCP_GITLAB,
            build::IMAGE_MCP_GITHUB,
            build::IMAGE_MCP_ATLASSIAN,
            build::IMAGE_MCP_CONTEXT7,
        ] {
            let tag = manifest.image_tag(image_name).unwrap();
            assert!(yaml.contains(&tag), "rendered YAML must contain {tag}");
        }

        assert!(!yaml.contains("image: speedwave-claude:latest"));
        assert!(!yaml.contains("image: speedwave-mcp-hub:latest"));
        assert!(!yaml.contains("image: speedwave-mcp-slack:latest"));
        assert!(!yaml.contains("image: speedwave-mcp-sharepoint:latest"));
        assert!(!yaml.contains("image: speedwave-mcp-redmine:latest"));
        assert!(!yaml.contains("image: speedwave-mcp-gitlab:latest"));
        assert!(!yaml.contains("image: speedwave-mcp-github:latest"));
        assert!(!yaml.contains("image: speedwave-mcp-atlassian:latest"));
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn test_rendered_compose_has_sharepoint_workspace_mount() {
        let data_dir = tempfile::tempdir().unwrap();
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: default_flags(),
            llm: configured_anthropic_llm(),
            ..Default::default()
        };
        let yaml = render_compose_isolated(
            data_dir.path(),
            "test-project",
            tmp_project_dir(),
            &config,
            &all_enabled_integrations(),
            None,
            &HostBridgesInfo::default(),
        )
        .unwrap();
        assert!(
            yaml.contains(&format!("{}:/workspace:rw", tmp_project_dir())),
            "Rendered compose must contain workspace mount for mcp-sharepoint.\nGot:\n{}",
            yaml.lines()
                .filter(|l| l.contains("/workspace"))
                .collect::<Vec<_>>()
                .join("\n")
        );
    }

    /// mcp-playwright renders when the toggle is enabled, with the hardening profile
    /// (cap_drop: ALL, read_only, no-new-privileges, shm_size: 2g) and `PORT=PORT_WORKER`.
    #[test]
    #[serial_test::serial(host_addressing)]
    fn test_render_compose_playwright_service_present() {
        let data_dir = tempfile::tempdir().unwrap();
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: default_flags(),
            llm: configured_anthropic_llm(),
            ..Default::default()
        };
        let integrations = ResolvedIntegrationsConfig {
            playwright: true,
            ..Default::default()
        };
        let yaml = render_compose_isolated(
            data_dir.path(),
            "test-project",
            tmp_project_dir(),
            &config,
            &integrations,
            None,
            &HostBridgesInfo::default(),
        )
        .unwrap();

        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&yaml).unwrap();
        let pw = doc
            .get("services")
            .and_then(|s| s.get("mcp-playwright"))
            .expect("mcp-playwright service must be present when enabled");

        assert!(
            pw.get("read_only")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
            "mcp-playwright must set read_only: true"
        );
        // shm_size comes from the SSOT (McpServiceDescriptor.resources.shm_mib),
        // guarded by `resources_render_from_ssot` — not duplicated here.
        let cap_drop = pw
            .get("cap_drop")
            .and_then(|v| v.as_sequence())
            .expect("cap_drop must be present");
        assert!(cap_drop.iter().any(|c| c.as_str() == Some("ALL")));
        let sec_opt = pw
            .get("security_opt")
            .and_then(|v| v.as_sequence())
            .expect("security_opt must be present");
        assert!(sec_opt
            .iter()
            .any(|s| s.as_str() == Some("no-new-privileges:true")));
        let env = pw
            .get("environment")
            .and_then(|e| e.as_sequence())
            .expect("environment must be present");
        let port_line = format!("PORT={}", crate::consts::PORT_WORKER);
        assert!(
            env.iter().any(|v| v.as_str() == Some(port_line.as_str())),
            "mcp-playwright must set PORT={}",
            crate::consts::PORT_WORKER
        );

        // ADR-062: mcp-playwright resolves host.docker.internal to the gateway IP.
        // Verifies the rendered compose, not the template (${HOST_GATEWAY} substituted).
        let extra_hosts = pw
            .get("extra_hosts")
            .and_then(|v| v.as_sequence())
            .expect("mcp-playwright must have extra_hosts (ADR-062)");
        let gateway_ip = crate::compose::host_gateway_ip().expect("test host addressing");
        let expected_entry = format!("host.docker.internal:{gateway_ip}");
        assert!(
            extra_hosts
                .iter()
                .any(|v| v.as_str() == Some(expected_entry.as_str())),
            "mcp-playwright must resolve host.docker.internal to {gateway_ip} (rendered, not template)"
        );
    }

    /// mcp-office has no credentials: no `/tokens` mount, `/workspace:rw`, and attached only to
    /// its egress-less `{NETWORK_NAME}_office` network (ADR-055).
    #[test]
    #[serial_test::serial(host_addressing)]
    fn test_render_compose_office_no_token_mount_workspace_rw_office_network_only() {
        let data_dir = tempfile::tempdir().unwrap();
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: default_flags(),
            llm: configured_anthropic_llm(),
            ..Default::default()
        };
        let integrations = ResolvedIntegrationsConfig {
            office: true,
            ..Default::default()
        };
        let yaml = render_compose_isolated(
            data_dir.path(),
            "test-project",
            tmp_project_dir(),
            &config,
            &integrations,
            None,
            &HostBridgesInfo::default(),
        )
        .unwrap();
        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&yaml).unwrap();
        let svc = doc
            .get("services")
            .and_then(|s| s.get("mcp-office"))
            .expect("mcp-office must be present when office is enabled");

        let volumes = svc
            .get("volumes")
            .and_then(|v| v.as_sequence())
            .expect("mcp-office must declare /workspace:rw");
        let vol_strs: Vec<&str> = volumes.iter().filter_map(|v| v.as_str()).collect();
        assert!(
            !vol_strs.iter().any(|v| v.contains("/tokens")),
            "mcp-office must not mount any /tokens volume; got: {vol_strs:?}"
        );
        assert!(
            vol_strs.iter().any(|v| v.ends_with(":/workspace:rw")),
            "mcp-office must mount the project workspace at /workspace:rw; got: {vol_strs:?}"
        );

        let nets: Vec<&str> = svc
            .get("networks")
            .and_then(|n| n.as_sequence())
            .map(|s| s.iter().filter_map(|v| v.as_str()).collect())
            .unwrap_or_default();
        assert_eq!(
            nets.len(),
            1,
            "mcp-office must be on exactly one (egress-less) network; got: {nets:?}"
        );
        assert!(
            nets[0].ends_with("_office"),
            "mcp-office's only network must be the egress-less *_office network; got: {nets:?}"
        );
    }

    /// mcp-playwright has no credentials — the generated compose must not mount
    /// any `/tokens` volume (attack-surface reduction per ADR).
    #[test]
    #[serial_test::serial(host_addressing)]
    fn test_render_compose_playwright_no_token_mount() {
        let data_dir = tempfile::tempdir().unwrap();
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: default_flags(),
            llm: configured_anthropic_llm(),
            ..Default::default()
        };
        let integrations = ResolvedIntegrationsConfig {
            playwright: true,
            ..Default::default()
        };
        let yaml = render_compose_isolated(
            data_dir.path(),
            "test-project",
            tmp_project_dir(),
            &config,
            &integrations,
            None,
            &HostBridgesInfo::default(),
        )
        .unwrap();

        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&yaml).unwrap();
        let pw = doc
            .get("services")
            .and_then(|s| s.get("mcp-playwright"))
            .expect("mcp-playwright must be present");

        // Playwright block has no `volumes:` key at all.
        assert!(
            pw.get("volumes").is_none(),
            "mcp-playwright must not declare any volumes; got: {:?}",
            pw.get("volumes")
        );
    }

    /// v1 explicitly refuses the `/workspace` mount — outputs return as base64
    /// so a compromised Chromium cannot exfiltrate repo contents.
    #[test]
    #[serial_test::serial(host_addressing)]
    fn test_render_compose_playwright_no_workspace_mount() {
        let data_dir = tempfile::tempdir().unwrap();
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: default_flags(),
            llm: configured_anthropic_llm(),
            ..Default::default()
        };
        let integrations = ResolvedIntegrationsConfig {
            playwright: true,
            ..Default::default()
        };
        let yaml = render_compose_isolated(
            data_dir.path(),
            "test-project",
            tmp_project_dir(),
            &config,
            &integrations,
            None,
            &HostBridgesInfo::default(),
        )
        .unwrap();

        // Scan the mcp-playwright block specifically rather than the whole
        // document — claude and mcp-sharepoint legitimately mount /workspace.
        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&yaml).unwrap();
        let pw_yaml = serde_yaml_ng::to_string(
            doc.get("services")
                .and_then(|s| s.get("mcp-playwright"))
                .expect("mcp-playwright must be present"),
        )
        .unwrap();
        assert!(
            !pw_yaml.contains("/workspace"),
            "mcp-playwright must not mount /workspace in v1; got block:\n{pw_yaml}"
        );
    }

    /// Hub must know where to reach the Playwright worker. The URL is injected
    /// from the compose template and must point at `:PORT_WORKER`.
    #[test]
    #[serial_test::serial(host_addressing)]
    fn test_playwright_worker_url_in_hub_env() {
        let data_dir = tempfile::tempdir().unwrap();
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: default_flags(),
            llm: configured_anthropic_llm(),
            ..Default::default()
        };
        let integrations = ResolvedIntegrationsConfig {
            playwright: true,
            ..Default::default()
        };
        let yaml = render_compose_isolated(
            data_dir.path(),
            "test-project",
            tmp_project_dir(),
            &config,
            &integrations,
            None,
            &HostBridgesInfo::default(),
        )
        .unwrap();

        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&yaml).unwrap();
        let hub_env = get_hub_env_seq(&doc);
        let expected = format!(
            "WORKER_PLAYWRIGHT_URL=http://mcp-playwright:{}",
            crate::consts::PORT_WORKER
        );
        assert!(
            hub_env.iter().any(|s| s == &expected),
            "hub must have '{expected}' in environment; got: {hub_env:?}"
        );
    }

    /// mcp-github must render with the standard worker hardening, the read-only
    /// project-scoped `/tokens` mount, and `PORT=PORT_WORKER` (mem cap guarded by `resources_render_from_ssot`).
    #[test]
    #[serial_test::serial(host_addressing)]
    fn test_render_compose_github_service_present() {
        let data_dir = tempfile::tempdir().unwrap();
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: default_flags(),
            llm: configured_anthropic_llm(),
            ..Default::default()
        };
        let integrations = ResolvedIntegrationsConfig {
            github: true,
            ..Default::default()
        };
        let yaml = render_compose_isolated(
            data_dir.path(),
            "test-project",
            tmp_project_dir(),
            &config,
            &integrations,
            None,
            &HostBridgesInfo::default(),
        )
        .unwrap();

        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&yaml).unwrap();
        let gh = doc
            .get("services")
            .and_then(|s| s.get("mcp-github"))
            .expect("mcp-github service must be present when enabled");

        assert!(
            gh.get("read_only")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
            "mcp-github must set read_only: true"
        );
        let cap_drop = gh
            .get("cap_drop")
            .and_then(|v| v.as_sequence())
            .expect("cap_drop must be present");
        assert!(cap_drop.iter().any(|c| c.as_str() == Some("ALL")));
        let sec_opt = gh
            .get("security_opt")
            .and_then(|v| v.as_sequence())
            .expect("security_opt must be present");
        assert!(sec_opt
            .iter()
            .any(|s| s.as_str() == Some("no-new-privileges:true")));

        // Token mount: only its own service dir, read-only, under the project's tokens path.
        let volumes = gh
            .get("volumes")
            .and_then(|v| v.as_sequence())
            .expect("mcp-github must mount its token dir");
        assert!(
            volumes.iter().filter_map(|v| v.as_str()).any(|v| {
                v.ends_with("/test-project/github:/tokens:ro") || v.ends_with("github:/tokens:ro")
            }),
            "mcp-github must mount github tokens read-only; got: {volumes:?}"
        );
        // It must NOT mount anyone else's tokens or /workspace.
        let gh_block = serde_yaml_ng::to_string(gh).unwrap();
        assert!(
            !gh_block.contains("/workspace"),
            "mcp-github must not mount /workspace"
        );
        assert!(
            !gh_block.contains("slack:/tokens") && !gh_block.contains("gitlab:/tokens"),
            "mcp-github must mount only its own tokens; got block:\n{gh_block}"
        );

        let env = gh
            .get("environment")
            .and_then(|e| e.as_sequence())
            .expect("environment must be present");
        let port_line = format!("PORT={}", crate::consts::PORT_WORKER);
        assert!(
            env.iter().any(|v| v.as_str() == Some(port_line.as_str())),
            "mcp-github must set PORT={}",
            crate::consts::PORT_WORKER
        );
    }

    /// Hub must know where to reach the GitHub worker — `WORKER_GITHUB_URL` injected
    /// from the compose template, pointing at `:PORT_WORKER`.
    #[test]
    #[serial_test::serial(host_addressing)]
    fn test_github_worker_url_in_hub_env() {
        let data_dir = tempfile::tempdir().unwrap();
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: default_flags(),
            llm: configured_anthropic_llm(),
            ..Default::default()
        };
        let integrations = ResolvedIntegrationsConfig {
            github: true,
            ..Default::default()
        };
        let yaml = render_compose_isolated(
            data_dir.path(),
            "test-project",
            tmp_project_dir(),
            &config,
            &integrations,
            None,
            &HostBridgesInfo::default(),
        )
        .unwrap();

        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&yaml).unwrap();
        let hub_env = get_hub_env_seq(&doc);
        let expected = format!(
            "WORKER_GITHUB_URL=http://mcp-github:{}",
            crate::consts::PORT_WORKER
        );
        assert!(
            hub_env.iter().any(|s| s == &expected),
            "hub must have '{expected}' in environment; got: {hub_env:?}"
        );
    }

    /// Disabling the GitHub toggle must remove both the `mcp-github` service block
    /// and the `WORKER_GITHUB_URL` hub env entry.
    #[test]
    fn test_apply_integrations_filter_disables_github() {
        let integrations = ResolvedIntegrationsConfig {
            github: false,
            ..Default::default()
        };

        let filtered =
            apply_integrations_filter(VALID_COMPOSE, &integrations, "speedwave_test_network")
                .unwrap();
        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&filtered).unwrap();

        let services = doc.get("services").and_then(|s| s.as_mapping()).unwrap();
        assert!(
            !services.contains_key(serde_yaml_ng::Value::String("mcp-github".into())),
            "mcp-github must be removed when disabled"
        );
        let hub_env = get_hub_env_seq(&doc);
        assert!(
            !hub_env.iter().any(|s| s.starts_with("WORKER_GITHUB_URL=")),
            "WORKER_GITHUB_URL must be removed from hub env when github disabled; got: {hub_env:?}"
        );
    }

    /// Disabling the Playwright toggle must remove both the service block and
    /// the WORKER_PLAYWRIGHT_URL hub env entry.
    #[test]
    fn test_apply_integrations_filter_disables_playwright() {
        let integrations = ResolvedIntegrationsConfig {
            playwright: false,
            ..Default::default()
        };

        let filtered =
            apply_integrations_filter(VALID_COMPOSE, &integrations, "speedwave_test_network")
                .unwrap();
        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&filtered).unwrap();

        let services = doc.get("services").and_then(|s| s.as_mapping()).unwrap();
        assert!(
            !services.contains_key(serde_yaml_ng::Value::String("mcp-playwright".into())),
            "mcp-playwright must be removed when disabled"
        );

        let hub_env = get_hub_env_seq(&doc);
        let has_pw_url = hub_env
            .iter()
            .any(|s| s.starts_with("WORKER_PLAYWRIGHT_URL="));
        assert!(
            !has_pw_url,
            "WORKER_PLAYWRIGHT_URL must be removed from hub env when disabled; got: {hub_env:?}"
        );
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn test_rendered_compose_has_mcp_hub_port() {
        let data_dir = tempfile::tempdir().unwrap();
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: default_flags(),
            llm: configured_anthropic_llm(),
            ..Default::default()
        };
        let yaml = render_compose_isolated(
            data_dir.path(),
            "test-project",
            tmp_project_dir(),
            &config,
            &ResolvedIntegrationsConfig::default(),
            None,
            &HostBridgesInfo::default(),
        )
        .unwrap();
        assert!(
            yaml.contains("MCP_HUB_PORT=4000"),
            "Rendered compose must contain MCP_HUB_PORT=4000 for entrypoint.sh.\nGot:\n{}",
            yaml.lines()
                .filter(|l| l.contains("environment") || l.contains("MCP") || l.contains("CLAUDE"))
                .collect::<Vec<_>>()
                .join("\n")
        );
    }

    #[test]
    fn test_claude_depends_on_proxy() {
        // ADR-073: Claude routes /v1/messages through the proxy, so the proxy
        // must start first (deterministic ordering — service_started).
        let data_dir = tempfile::tempdir().unwrap();
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: default_flags(),
            llm: configured_anthropic_llm(),
            ..Default::default()
        };
        let yaml = render_compose_isolated(
            data_dir.path(),
            "test-project",
            tmp_project_dir(),
            &config,
            &ResolvedIntegrationsConfig::default(),
            None,
            &HostBridgesInfo::default(),
        )
        .unwrap();
        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&yaml).unwrap();
        let depends = &doc["services"]["claude"]["depends_on"]["proxy"]["condition"];
        assert_eq!(
            depends.as_str(),
            Some("service_started"),
            "claude must depend_on proxy with condition service_started"
        );
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn test_mcp_hub_port_matches_port_base() {
        let data_dir = tempfile::tempdir().unwrap();
        // MCP_HUB_PORT in the claude container must equal PORT_BASE (hub port).
        // If these drift apart, entrypoint.sh generates wrong mcp-config.json URL.
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: default_flags(),
            llm: configured_anthropic_llm(),
            ..Default::default()
        };
        let yaml = render_compose_isolated(
            data_dir.path(),
            "test-project",
            tmp_project_dir(),
            &config,
            &ResolvedIntegrationsConfig::default(),
            None,
            &HostBridgesInfo::default(),
        )
        .unwrap();
        let expected = format!("MCP_HUB_PORT={}", crate::consts::PORT_BASE);
        assert!(
            yaml.contains(&expected),
            "MCP_HUB_PORT must equal PORT_BASE ({})",
            crate::consts::PORT_BASE
        );
    }

    /// ADR-038: every non-hub service must listen on `PORT_WORKER` (3000).
    /// The hub itself is exempt — it listens on `PORT_BASE` (4000).
    #[test]
    #[serial_test::serial(host_addressing)]
    fn test_all_workers_use_port_worker() {
        let data_dir = tempfile::tempdir().unwrap();
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: default_flags(),
            llm: configured_anthropic_llm(),
            ..Default::default()
        };
        let yaml = render_compose_isolated(
            data_dir.path(),
            "test-project",
            tmp_project_dir(),
            &config,
            &all_enabled_integrations(),
            None,
            &HostBridgesInfo::default(),
        )
        .unwrap();

        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&yaml).unwrap();
        let services = doc
            .get("services")
            .and_then(|s| s.as_mapping())
            .expect("services mapping");

        let worker_port_line = format!("PORT={}", crate::consts::PORT_WORKER);
        for (name_value, svc) in services {
            let name = name_value.as_str().unwrap_or("");
            // Only workers define PORT; claude and proxy do not (proxy uses a fixed entrypoint port, ADR-073).
            if name == "claude" || name == "mcp-hub" || name == "proxy" {
                continue;
            }
            let env = svc
                .get("environment")
                .and_then(|e| e.as_sequence())
                .unwrap_or_else(|| panic!("service '{name}' missing environment"));
            let has_worker_port = env
                .iter()
                .any(|v| v.as_str().is_some_and(|s| s == worker_port_line));
            assert!(
                has_worker_port,
                "service '{name}' must set {worker_port_line}, got: {env:?}"
            );
        }
    }

    /// ADR-038: every container-to-container WORKER_*_URL in mcp-hub points at `:{PORT_WORKER}`.
    /// `WORKER_OS_URL` is exempt: mcp-os runs on the host with a dynamic OS-allocated port.
    #[test]
    #[serial_test::serial(host_addressing)]
    fn test_hub_worker_urls_use_port_worker() {
        let data_dir = tempfile::tempdir().unwrap();
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: default_flags(),
            llm: configured_anthropic_llm(),
            ..Default::default()
        };
        let yaml = render_compose_isolated(
            data_dir.path(),
            "test-project",
            tmp_project_dir(),
            &config,
            &all_enabled_integrations(),
            None,
            &HostBridgesInfo::default(),
        )
        .unwrap();

        let expected_suffix = format!(":{}", crate::consts::PORT_WORKER);
        for entry in get_hub_env_seq(&serde_yaml_ng::from_str(&yaml).unwrap()) {
            if let Some((key, value)) = entry.split_once('=') {
                if key.starts_with("WORKER_") && key.ends_with("_URL") {
                    // WORKER_OS_URL is a host-side gateway with a dynamic port; ADR-038 applies only to in-cluster workers.
                    if key == "WORKER_OS_URL" {
                        continue;
                    }
                    assert!(
                        value.ends_with(&expected_suffix),
                        "{key} must point at :{} (ADR-038), got: {value}",
                        crate::consts::PORT_WORKER
                    );
                }
            }
        }
    }

    /// ADR-038: `plugin.json.port` is ignored. A manifest requesting a non-`PORT_WORKER`
    /// port is still wired up at `:{PORT_WORKER}` without failing.
    #[test]
    fn test_plugin_manifest_port_is_ignored() {
        use crate::plugin::{generate_plugin_service, PluginManifest, TokenMount};

        let manifest = PluginManifest {
            name: "Legacy".to_string(),
            service_id: Some("legacy".to_string()),
            slug: "legacy".to_string(),
            version: "1.0.0".to_string(),
            description: "legacy port".to_string(),
            port: Some(9999), // deprecated, must be ignored
            image_tag: Some("speedwave-mcp-legacy:latest".to_string()),
            resources: vec![],
            token_mount: TokenMount::ReadOnly,
            auth_fields: vec![],
            settings_schema: None,
            speedwave_compat: None,
            extra_env: None,
            mem_limit: None,
            cpu_limit: None,
            requires_integrations: vec![],
            host_bridge: None,
            instructions: None,
            oauth: None,
        };

        let tokens_dir = std::path::Path::new("/home/user/.speedwave/tokens/test-project");
        let service = generate_plugin_service(
            &manifest,
            "f00ddeadbeefcafe0123456789abcdef",
            std::path::Path::new("/nonexistent/plugins/legacy"),
            "test-project",
            "speedwave_test-project_network",
            tokens_dir,
            tmp_project_dir(),
        )
        .unwrap();

        let env = service
            .get("environment")
            .and_then(|v| v.as_sequence())
            .expect("plugin service must have environment");
        let has_worker_port = env.iter().any(|v| {
            v.as_str()
                .is_some_and(|s| s == format!("PORT={}", crate::consts::PORT_WORKER))
        });
        assert!(
            has_worker_port,
            "plugin service must use PORT={} regardless of manifest.port (ADR-038)",
            crate::consts::PORT_WORKER
        );
        let has_deprecated_port = env.iter().any(|v| {
            v.as_str()
                .is_some_and(|s| s == format!("PORT={}", manifest.port.unwrap()))
        });
        assert!(
            !has_deprecated_port,
            "plugin service must not honour deprecated manifest.port"
        );
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn test_mcp_hub_port_survives_inject_claude_env() {
        let data_dir = tempfile::tempdir().unwrap();
        // Regression: inject_claude_env re-parses YAML via serde_yaml_ng.
        // MCP_HUB_PORT must survive the parse → serialize roundtrip.
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: default_flags(),
            llm: configured_anthropic_llm(),
            ..Default::default()
        };
        let yaml = render_compose_isolated(
            data_dir.path(),
            "test-project",
            tmp_project_dir(),
            &config,
            &ResolvedIntegrationsConfig::default(),
            None,
            &HostBridgesInfo::default(),
        )
        .unwrap();

        // Parse and re-serialize (same as inject_claude_env does)
        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&yaml).unwrap();
        let reserialized = serde_yaml_ng::to_string(&doc).unwrap();
        assert!(
            reserialized.contains("MCP_HUB_PORT"),
            "MCP_HUB_PORT lost during serde_yaml_ng roundtrip"
        );
    }

    #[test]
    fn test_inject_claude_env_propagates_parse_error() {
        let bad_yaml = "this is: not: yaml: : :";
        let env = std::collections::HashMap::new();
        let result = inject_claude_env(bad_yaml, &env);
        assert!(result.is_err(), "should return Err for malformed YAML");
        let err_msg = format!("{}", result.unwrap_err());
        assert!(
            err_msg.contains("failed to parse compose YAML"),
            "error should mention 'failed to parse compose YAML', got: '{}'",
            err_msg
        );
    }

    #[test]
    fn test_inject_claude_env_happy_path_preserves_existing_env() {
        let yaml = "services:\n  claude:\n    environment:\n      - FOO=bar\n";
        let mut env = std::collections::HashMap::new();
        env.insert("BAZ".to_string(), "qux".to_string());
        let result = inject_claude_env(yaml, &env).unwrap();
        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&result).unwrap();
        let env_seq = doc["services"]["claude"]["environment"]
            .as_sequence()
            .unwrap();
        let entries: Vec<&str> = env_seq.iter().filter_map(|v| v.as_str()).collect();
        assert!(
            entries.contains(&"FOO=bar"),
            "should preserve existing FOO=bar"
        );
        assert!(entries.contains(&"BAZ=qux"), "should add new BAZ=qux");
    }

    #[test]
    fn test_inject_claude_env_overrides_existing_key() {
        let yaml = "services:\n  claude:\n    environment:\n      - FOO=bar\n";
        let mut env = std::collections::HashMap::new();
        env.insert("FOO".to_string(), "updated".to_string());
        let result = inject_claude_env(yaml, &env).unwrap();
        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&result).unwrap();
        let env_seq = doc["services"]["claude"]["environment"]
            .as_sequence()
            .unwrap();
        let entries: Vec<&str> = env_seq.iter().filter_map(|v| v.as_str()).collect();
        assert!(
            entries.contains(&"FOO=updated"),
            "should override FOO with 'updated', got: {:?}",
            entries
        );
        assert!(
            !entries.contains(&"FOO=bar"),
            "old FOO=bar should be gone, got: {:?}",
            entries
        );
    }

    #[test]
    fn test_inject_claude_env_no_claude_service_returns_yaml() {
        let yaml = "services:\n  hub:\n    image: hub:latest\n";
        let mut env = std::collections::HashMap::new();
        env.insert("FOO".to_string(), "bar".to_string());
        let result = inject_claude_env(yaml, &env);
        assert!(
            result.is_ok(),
            "should not error when claude service is absent"
        );
        let output = result.unwrap();
        // Output should still be valid YAML and semantically equivalent
        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&output).unwrap();
        assert!(
            doc.get("services").and_then(|s| s.get("hub")).is_some(),
            "hub service should still be present"
        );
    }

    #[test]
    fn test_inject_claude_env_handles_null_environment_field() {
        let yaml = "services:\n  claude:\n    environment: null\n";
        let mut env = std::collections::HashMap::new();
        env.insert("FOO".to_string(), "bar".to_string());
        let result = inject_claude_env(yaml, &env);
        assert!(
            result.is_ok(),
            "should not panic on null environment field, got: {:?}",
            result
        );
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn test_mcp_hub_port_in_claude_service_env() {
        let data_dir = tempfile::tempdir().unwrap();
        // Verify MCP_HUB_PORT is specifically in the claude service environment,
        // not somewhere else in the compose file.
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: default_flags(),
            llm: configured_anthropic_llm(),
            ..Default::default()
        };
        let yaml = render_compose_isolated(
            data_dir.path(),
            "test-project",
            tmp_project_dir(),
            &config,
            &ResolvedIntegrationsConfig::default(),
            None,
            &HostBridgesInfo::default(),
        )
        .unwrap();
        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&yaml).unwrap();

        let claude_env = doc
            .get("services")
            .and_then(|s| s.get("claude"))
            .and_then(|c| c.get("environment"))
            .and_then(|e| e.as_sequence())
            .expect("claude service must have environment");

        let has_mcp_hub_port = claude_env
            .iter()
            .any(|v| v.as_str().is_some_and(|s| s.starts_with("MCP_HUB_PORT=")));
        assert!(
            has_mcp_hub_port,
            "MCP_HUB_PORT must be in claude service environment"
        );
    }

    #[test]
    fn test_compose_template_has_mcp_hub_port_placeholder() {
        // Guard: compose.template.yml must contain MCP_HUB_PORT=${PORT_HUB}.
        // If someone removes it from the template, entrypoint.sh won't know the hub port.
        assert!(
            COMPOSE_TEMPLATE.contains("MCP_HUB_PORT=${PORT_HUB}"),
            "compose.template.yml must contain MCP_HUB_PORT=${{PORT_HUB}}"
        );
    }

    #[test]
    fn test_compose_template_all_services_have_pull_policy_never() {
        // Images built locally; without `pull_policy: never` nerdctl pulls unqualified names from docker.io/library.
        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(COMPOSE_TEMPLATE).unwrap();
        let services = doc.get("services").unwrap().as_mapping().unwrap();
        for (name, svc) in services {
            let name = name.as_str().unwrap();
            let policy = svc
                .get("pull_policy")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            assert_eq!(
                policy, "never",
                "service '{}' must have `pull_policy: never` (images are built locally)",
                name
            );
        }
    }

    #[test]
    fn compose_template_worker_url_env_vars_match_toggleable_services() {
        // SSOT: WORKER_*_URL lines in compose.template.yml must match TOGGLEABLE_MCP_SERVICES.worker_env.
        let expected: std::collections::BTreeSet<&str> = crate::consts::TOGGLEABLE_MCP_SERVICES
            .iter()
            .map(|s| s.worker_env)
            .collect();

        let found: std::collections::BTreeSet<&str> = COMPOSE_TEMPLATE
            .lines()
            .filter_map(|l| {
                let trimmed = l.trim_start();
                let after_dash = trimmed.strip_prefix("- ")?;
                let var_name = after_dash.split('=').next()?;
                if var_name.starts_with("WORKER_") && var_name.ends_with("_URL") {
                    Some(var_name)
                } else {
                    None
                }
            })
            .collect();

        assert_eq!(
            found, expected,
            "WORKER_*_URL entries in compose.template.yml must match TOGGLEABLE_MCP_SERVICES worker_env.\n\
             In template but not in TOGGLEABLE_MCP_SERVICES: {:?}\n\
             In TOGGLEABLE_MCP_SERVICES but not in template: {:?}",
            found.difference(&expected).collect::<Vec<_>>(),
            expected.difference(&found).collect::<Vec<_>>(),
        );
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn test_rendered_compose_passes_security_check() {
        let data_dir = tempfile::tempdir().unwrap();
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: default_flags(),
            llm: configured_anthropic_llm(),
            ..Default::default()
        };
        let yaml = render_compose_isolated(
            data_dir.path(),
            "test-project",
            tmp_project_dir(),
            &config,
            &ResolvedIntegrationsConfig::default(),
            None,
            &HostBridgesInfo::default(),
        )
        .unwrap();
        let tmp = tempfile::tempdir().unwrap();
        // Expected paths must derive from the render's data_dir; compute() reads the production singleton.
        let tokens_dir = data_dir.path().join("tokens").join("test-project");
        let violations = SecurityCheck::run_with_data_dir(
            &yaml,
            "test-project",
            &[],
            &SecurityExpectedPaths::from_raw(tmp_project_dir(), &tokens_dir.to_string_lossy()),
            tmp.path(),
        );
        assert!(
            violations.is_empty(),
            "Generated compose should pass security check. Violations: {:?}",
            violations
                .iter()
                .map(|v| format!("{}", v))
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn test_inject_worker_env() {
        let mut doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(VALID_COMPOSE).unwrap();

        inject_worker_env(
            &mut doc,
            "WORKER_EXAMPLE_PLUGIN_URL",
            "http://mcp-example-plugin:4006",
        );

        let hub = doc.get("services").unwrap().get("mcp-hub").unwrap();
        let env_seq = hub.get("environment").unwrap().as_sequence().unwrap();
        let has_example_plugin = env_seq.iter().any(|v| {
            v.as_str()
                .is_some_and(|s| s == "WORKER_EXAMPLE_PLUGIN_URL=http://mcp-example-plugin:4006")
        });
        assert!(
            has_example_plugin,
            "WORKER_EXAMPLE_PLUGIN_URL should be in mcp-hub env"
        );
    }

    /// Second call with the same key must REPLACE, not duplicate; tested on both claude and hub.
    #[test]
    fn test_inject_env_into_idempotent() {
        for service in ["mcp-hub", "claude"] {
            let mut doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(VALID_COMPOSE).unwrap();

            inject_env_into(&mut doc, service, "ENABLED_SERVICES", "slack");
            inject_env_into(&mut doc, service, "ENABLED_SERVICES", "slack,office");

            let svc = doc.get("services").unwrap().get(service).unwrap();
            let env_seq = svc.get("environment").unwrap().as_sequence().unwrap();
            let occurrences = env_seq
                .iter()
                .filter(|v| {
                    v.as_str()
                        .is_some_and(|s| s.starts_with("ENABLED_SERVICES="))
                })
                .count();
            assert_eq!(
                occurrences, 1,
                "service '{service}': ENABLED_SERVICES must appear exactly once after repeated injection"
            );
            let final_value = env_seq
                .iter()
                .find_map(|v| v.as_str().and_then(|s| s.strip_prefix("ENABLED_SERVICES=")));
            assert_eq!(final_value, Some("slack,office"), "service '{service}'");
        }
    }

    /// Missing service yields a warn and a no-op — nothing must mutate elsewhere.
    #[test]
    fn test_inject_env_into_absent_service_is_safe_no_op() {
        let mut doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(VALID_COMPOSE).unwrap();
        let hub_before = get_service_env_seq(&doc, "mcp-hub");

        inject_env_into(&mut doc, "nonexistent-service", "FOO", "bar");

        assert!(doc
            .get("services")
            .and_then(|s| s.get("nonexistent-service"))
            .is_none());
        assert_eq!(get_service_env_seq(&doc, "mcp-hub"), hub_before);
    }

    /// Missing `environment` key on an existing service is created on the fly.
    #[test]
    fn test_inject_env_into_creates_missing_environment() {
        let mut doc: serde_yaml_ng::Value =
            serde_yaml_ng::from_str("services:\n  bare-service:\n    image: example\n").unwrap();
        inject_env_into(&mut doc, "bare-service", "FOO", "bar");
        let env = get_service_env_seq(&doc, "bare-service");
        assert_eq!(find_env_value(&env, "FOO=").as_deref(), Some("bar"));
    }

    /// `remove_env_from` removes the named key from an arbitrary service and no-ops on absent paths.
    #[test]
    fn test_remove_env_from() {
        let mut doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(VALID_COMPOSE).unwrap();

        inject_env_into(&mut doc, "claude", "TEST_KEY", "value");
        assert!(find_env_value(&get_service_env_seq(&doc, "claude"), "TEST_KEY=").is_some());

        remove_env_from(&mut doc, "claude", "TEST_KEY");
        assert!(find_env_value(&get_service_env_seq(&doc, "claude"), "TEST_KEY=").is_none());

        // No-op on absent service / env name.
        remove_env_from(&mut doc, "nonexistent-service", "ANY");
        remove_env_from(&mut doc, "claude", "NEVER_INJECTED");

        // Removing only matches by exact key, not prefix.
        inject_env_into(&mut doc, "claude", "FOO", "1");
        inject_env_into(&mut doc, "claude", "FOO_BAR", "2");
        remove_env_from(&mut doc, "claude", "FOO");
        let env = get_service_env_seq(&doc, "claude");
        assert!(find_env_value(&env, "FOO=").is_none());
        assert_eq!(find_env_value(&env, "FOO_BAR=").as_deref(), Some("2"));
    }

    /// The claude container needs ENABLED_SERVICES so entrypoint.sh can gate
    /// per-integration claude-resources (skills/commands/agents/hooks).
    #[test]
    fn test_apply_integrations_filter_injects_enabled_services_into_claude() {
        let resolved = ResolvedIntegrationsConfig {
            slack: true,
            office: true,
            ..Default::default()
        };
        let yaml = apply_integrations_filter(VALID_COMPOSE, &resolved, "test-net").unwrap();
        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&yaml).unwrap();

        let claude_env = find_env_value(&get_service_env_seq(&doc, "claude"), "ENABLED_SERVICES=")
            .expect("claude must have ENABLED_SERVICES");
        let hub_env = find_env_value(&get_service_env_seq(&doc, "mcp-hub"), "ENABLED_SERVICES=")
            .expect("mcp-hub must have ENABLED_SERVICES");
        assert_eq!(
            claude_env, hub_env,
            "claude and mcp-hub must see identical ENABLED_SERVICES"
        );
        assert!(claude_env.contains("slack"));
        assert!(claude_env.contains("office"));
    }

    /// claude container needs DISABLED_OS_SERVICES so entrypoint.sh can gate OS sub-service skills.
    #[test]
    fn test_apply_integrations_filter_injects_disabled_os_services_into_claude() {
        let resolved = ResolvedIntegrationsConfig {
            os_calendar: true,
            ..Default::default()
        };
        let yaml = apply_integrations_filter(VALID_COMPOSE, &resolved, "test-net").unwrap();
        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&yaml).unwrap();

        let claude_disabled = find_env_value(
            &get_service_env_seq(&doc, "claude"),
            "DISABLED_OS_SERVICES=",
        )
        .expect("DISABLED_OS_SERVICES must be injected into claude");
        let hub_disabled = find_env_value(
            &get_service_env_seq(&doc, "mcp-hub"),
            "DISABLED_OS_SERVICES=",
        )
        .expect("DISABLED_OS_SERVICES must be injected into mcp-hub");
        assert_eq!(claude_disabled, hub_disabled);
        for sub in ["reminders", "mail", "notes"] {
            assert!(
                claude_disabled.contains(sub),
                "missing {sub}: {claude_disabled}"
            );
        }
        assert!(!claude_disabled.contains("calendar"));

        let os_available =
            find_env_value(&get_service_env_seq(&doc, "claude"), "OS_AVAILABLE_SUBS=")
                .expect("OS_AVAILABLE_SUBS must be injected into claude");
        for sub in ["reminders", "calendar", "mail", "notes"] {
            assert!(os_available.contains(sub), "missing {sub}: {os_available}");
        }
        // OS_AVAILABLE_SUBS is consumed only by claude's entrypoint, never by the hub.
        assert!(
            find_env_value(&get_service_env_seq(&doc, "mcp-hub"), "OS_AVAILABLE_SUBS=").is_none(),
            "OS_AVAILABLE_SUBS must not be injected into mcp-hub"
        );
    }

    #[test]
    fn test_add_claude_volume() {
        let mut doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(VALID_COMPOSE).unwrap();

        add_claude_volume(
            &mut doc,
            "/home/user/.speedwave/addons/example-plugin/claude-resources:/speedwave/addons/example-plugin:ro",
        )
        .unwrap();

        let claude = doc.get("services").unwrap().get("claude").unwrap();
        let vols = claude.get("volumes").unwrap().as_sequence().unwrap();
        let has_addon_vol = vols.iter().any(|v| {
            v.as_str()
                .is_some_and(|s| s.contains("/speedwave/addons/example-plugin:ro"))
        });
        assert!(has_addon_vol, "Addon volume should be in claude volumes");
    }

    #[test]
    fn add_claude_volume_creates_missing_volumes_key() {
        // The security-boundary mount must not be silently dropped when the claude
        // service has no `volumes:` block — the sequence is created on demand.
        let mut doc: serde_yaml_ng::Value =
            serde_yaml_ng::from_str("services:\n  claude:\n    image: x\n").unwrap();
        add_claude_volume(&mut doc, "/src:/etc/claude-code/managed-settings.json:ro").unwrap();
        let vols = doc["services"]["claude"]["volumes"].as_sequence().unwrap();
        assert!(vols
            .iter()
            .any(|v| v.as_str() == Some("/src:/etc/claude-code/managed-settings.json:ro")));
    }

    #[test]
    fn add_claude_volume_errors_when_claude_service_absent() {
        let mut doc: serde_yaml_ng::Value =
            serde_yaml_ng::from_str("services:\n  other:\n    image: x\n").unwrap();
        assert!(
            add_claude_volume(&mut doc, "/src:/dst:ro").is_err(),
            "a missing claude service must be an error, not a silent no-op"
        );
    }

    #[test]
    fn test_add_claude_env_var() {
        let mut doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(VALID_COMPOSE).unwrap();

        add_claude_env_var(
            &mut doc,
            "SPEEDWAVE_PLUGINS",
            "example-plugin,custom-skills",
        );

        let claude = doc.get("services").unwrap().get("claude").unwrap();
        let env_seq = claude.get("environment").unwrap().as_sequence().unwrap();
        let has_plugins_var = env_seq.iter().any(|v| {
            v.as_str()
                .is_some_and(|s| s == "SPEEDWAVE_PLUGINS=example-plugin,custom-skills")
        });
        assert!(has_plugins_var, "SPEEDWAVE_PLUGINS should be in claude env");
    }

    #[test]
    fn test_security_check_ports_integer_rejected() {
        let data_dir = tempfile::tempdir().unwrap();
        let yaml = r#"
version: "3"
services:
  mcp-hub:
    image: speedwave-mcp-hub:latest
    read_only: true
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp:noexec,nosuid,size=64m
    ports:
      - 4000
"#;
        let violations = SecurityCheck::run_with_data_dir(
            yaml,
            "test",
            &[],
            &test_expected_paths(),
            data_dir.path(),
        );
        assert!(
            violations
                .iter()
                .any(|v| v.rule == SecurityRule::PortsLocalhost),
            "Bare integer port should be rejected"
        );
    }

    #[test]
    fn test_security_check_ports_long_form_no_host_ip() {
        let data_dir = tempfile::tempdir().unwrap();
        let yaml = r#"
version: "3"
services:
  mcp-hub:
    image: speedwave-mcp-hub:latest
    read_only: true
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp:noexec,nosuid,size=64m
    ports:
      - target: 4000
        published: 4000
        protocol: tcp
"#;
        let violations = SecurityCheck::run_with_data_dir(
            yaml,
            "test",
            &[],
            &test_expected_paths(),
            data_dir.path(),
        );
        assert!(
            violations
                .iter()
                .any(|v| v.rule == SecurityRule::PortsLocalhost),
            "Long-form port without host_ip should be rejected"
        );
    }

    #[test]
    fn test_security_check_ports_long_form_with_localhost() {
        let data_dir = tempfile::tempdir().unwrap();
        let yaml = r#"
version: "3"
services:
  mcp-hub:
    image: speedwave-mcp-hub:latest
    read_only: true
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp:noexec,nosuid,size=64m
    ports:
      - target: 4000
        published: 4000
        host_ip: "127.0.0.1"
        protocol: tcp
"#;
        let violations = SecurityCheck::run_with_data_dir(
            yaml,
            "test",
            &[],
            &test_expected_paths(),
            data_dir.path(),
        );
        let port_violations: Vec<_> = violations
            .iter()
            .filter(|v| v.rule == SecurityRule::PortsLocalhost)
            .collect();
        assert!(
            port_violations.is_empty(),
            "Long-form port with host_ip 127.0.0.1 should pass"
        );
    }

    #[test]
    fn test_security_check_anthropic_api_key_allowed() {
        let data_dir = tempfile::tempdir().unwrap();
        let yaml = r#"
version: "3"
services:
  claude:
    image: speedwave-claude:latest
    read_only: true
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp:noexec,nosuid,size=512m
    environment:
      - CLAUDE_VERSION=1.0.3
      - ANTHROPIC_API_KEY=sk-ant-12345
"#;
        let violations = SecurityCheck::run_with_data_dir(
            yaml,
            "test",
            &[],
            &test_expected_paths(),
            data_dir.path(),
        );
        assert!(
            !violations
                .iter()
                .any(|v| v.rule == SecurityRule::NoTokensClaude),
            "ANTHROPIC_API_KEY in claude container should be allowed"
        );
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn test_render_compose_ollama_provider() {
        let data_dir = tempfile::tempdir().unwrap();
        // Kill-switch off: exercises the legacy direct-injection path (this
        // test asserts the raw default_base_url, not the proxy-routed model).
        let mut llm = LlmConfig {
            provider: Some("ollama".to_string()),
            model: Some("llama3.3".to_string()),
            base_url: None,
            context_tokens: None,
            has_api_key: false,
            has_custom_headers: false,
            ..Default::default()
        };
        crate::config::migrate_llm(&mut llm, crate::config::AnthropicEvidence::None);
        llm.proxy_enabled = Some(false);
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: default_flags(),
            llm,
            ..Default::default()
        };
        let yaml = render_compose_isolated(
            data_dir.path(),
            "test-project",
            tmp_project_dir(),
            &config,
            &ResolvedIntegrationsConfig::default(),
            None,
            &HostBridgesInfo::default(),
        )
        .unwrap();
        // Ollama: direct injection via default_base_url SSOT (no /v1 suffix — ADR-040)
        let expected = format!("ANTHROPIC_BASE_URL={}", default_base_url("ollama").unwrap());
        assert!(
            yaml.contains(&expected),
            "Ollama provider should set {expected} (no /v1)"
        );
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn test_local_provider_requires_model() {
        let data_dir = tempfile::tempdir().unwrap();
        let mut llm = LlmConfig {
            provider: Some("ollama".to_string()),
            model: None,
            base_url: None,
            context_tokens: None,
            has_api_key: false,
            has_custom_headers: false,
            ..Default::default()
        };
        crate::config::migrate_llm(&mut llm, crate::config::AnthropicEvidence::None);
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: default_flags(),
            llm,
            ..Default::default()
        };
        let result = render_compose_isolated(
            data_dir.path(),
            "test-project",
            tmp_project_dir(),
            &config,
            &ResolvedIntegrationsConfig::default(),
            None,
            &HostBridgesInfo::default(),
        );
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string();
        assert!(
            msg.contains("requires a model name"),
            "Error must mention model requirement, got: {msg}"
        );
        // Migration normalises every LOCAL_PROVIDERS alias to the canonical
        // "local" id (ADR-073) — the error names that id, not the raw "ollama".
        assert!(
            msg.contains("local"),
            "Error must mention the provider, got: {msg}"
        );
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn test_render_compose_default_anthropic() {
        let data_dir = tempfile::tempdir().unwrap();
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: default_flags(),
            llm: configured_anthropic_llm(),
            ..Default::default()
        };
        let yaml = render_compose_isolated(
            data_dir.path(),
            "test-project",
            tmp_project_dir(),
            &config,
            &ResolvedIntegrationsConfig::default(),
            None,
            &HostBridgesInfo::default(),
        )
        .unwrap();
        // Default anthropic: proxy service always exists (ADR-073) and claude
        // routes at it via the passthrough leg (not the pre-ADR-073 direct path).
        assert!(
            !yaml.contains("llm-proxy"),
            "Default anthropic provider should not add llm-proxy"
        );
        assert!(
            get_claude_env(&yaml)
                .iter()
                .any(|e| e == "ANTHROPIC_BASE_URL=http://proxy:4000"),
            "Default anthropic must route claude env through the proxy passthrough (ADR-073)"
        );
        assert!(
            !yaml.contains("ghcr.io/berriai"),
            "proxy image must be the locally built one, never pulled from ghcr"
        );
        // ANTHROPIC_BASE_URL is the proxy passthrough URL, not a user override.
        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&yaml).unwrap();
        let claude_env = doc
            .get("services")
            .and_then(|s| s.get("claude"))
            .and_then(|c| c.get("environment"))
            .and_then(|e| e.as_sequence())
            .unwrap();
        let has_foreign_base_url = claude_env.iter().any(|v| {
            v.as_str().is_some_and(|s| {
                s.starts_with("ANTHROPIC_BASE_URL=") && s != "ANTHROPIC_BASE_URL=http://proxy:4000"
            })
        });
        assert!(
            !has_foreign_base_url,
            "Default anthropic should not set an ANTHROPIC_BASE_URL other than the proxy passthrough"
        );
    }

    /// Builds a resolved (v2) LlmConfig the way production resolve does —
    /// proxy-path tests must exercise the migrated shape.
    fn v2_llm(provider: &str, model: Option<&str>, base_url: Option<&str>) -> LlmConfig {
        let mut llm = LlmConfig {
            provider: Some(provider.to_string()),
            model: model.map(str::to_string),
            base_url: base_url.map(str::to_string),
            ..Default::default()
        };
        crate::config::migrate_llm(&mut llm, crate::config::AnthropicEvidence::None);
        llm
    }

    /// ADR-073: subscription (oauth) sessions route through the proxy's anthropic passthrough
    /// and must NOT carry any Bearer/API key env — either would disable Claude Code's OAuth.
    #[test]
    #[serial_test::serial(host_addressing)]
    fn test_proxy_injection_anthropic_oauth() {
        let data_dir = tempfile::tempdir().unwrap();
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: default_flags(),
            llm: v2_llm("anthropic", None, None),
            ..Default::default()
        };
        let yaml = render_compose_isolated(
            data_dir.path(),
            "test-project",
            tmp_project_dir(),
            &config,
            &ResolvedIntegrationsConfig::default(),
            None,
            &HostBridgesInfo::default(),
        )
        .unwrap();
        let env = get_claude_env(&yaml);
        assert!(
            env.iter()
                .any(|e| e == "ANTHROPIC_BASE_URL=http://proxy:4000"),
            "oauth sessions must use the passthrough route, got: {env:?}"
        );
        assert!(
            !env.iter()
                .any(|e| e.starts_with("ANTHROPIC_AUTH_TOKEN=")
                    || e.starts_with("ANTHROPIC_API_KEY=")),
            "oauth sessions must carry no auth env (it disables OAuth): {env:?}"
        );
        // 1M alias pins survive the proxy (passthrough is transparent).
        assert!(
            env.iter()
                .any(|e| e.starts_with("ANTHROPIC_DEFAULT_OPUS_MODEL=")),
            "alias pins must be present: {env:?}"
        );
    }

    /// ADR-073: local sessions route through the proxy with an
    /// id-prefixed model matching the rendered route prefix.
    #[test]
    #[serial_test::serial(host_addressing)]
    fn test_proxy_injection_local_provider() {
        let data_dir = tempfile::tempdir().unwrap();
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: default_flags(),
            llm: v2_llm(
                "llamacpp",
                Some("qwen3"),
                Some("http://host.docker.internal:9000"),
            ),
            ..Default::default()
        };
        let yaml = render_compose_isolated(
            data_dir.path(),
            "test-project",
            tmp_project_dir(),
            &config,
            &ResolvedIntegrationsConfig::default(),
            None,
            &HostBridgesInfo::default(),
        )
        .unwrap();
        let env = get_claude_env(&yaml);
        assert!(
            env.iter()
                .any(|e| e == "ANTHROPIC_BASE_URL=http://proxy:4000"),
            "local sessions use the unified root: {env:?}"
        );
        assert!(
            env.iter().any(|e| e == "ANTHROPIC_MODEL=local/qwen3"),
            "model must be provider-id-prefixed: {env:?}"
        );
        for alias in [
            "ANTHROPIC_DEFAULT_OPUS_MODEL",
            "ANTHROPIC_DEFAULT_SONNET_MODEL",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL",
            "ANTHROPIC_DEFAULT_FABLE_MODEL",
        ] {
            assert!(
                env.iter().any(|e| e == &format!("{alias}=local/qwen3")),
                "built-in alias {alias} must remap to the routable id: {env:?}"
            );
        }
        // Deprecated var must be gone (replaced by ANTHROPIC_DEFAULT_HAIKU_MODEL).
        assert!(
            !env.iter()
                .any(|e| e.starts_with("ANTHROPIC_SMALL_FAST_MODEL=")),
            "deprecated ANTHROPIC_SMALL_FAST_MODEL must not be injected: {env:?}"
        );
        assert!(
            env.iter()
                .any(|e| e == "ANTHROPIC_AUTH_TOKEN=sk-no-key-required"),
            "dummy bearer expected: {env:?}"
        );
        // The rendered proxy config must carry the matching route.
        let proxy_cfg = std::fs::read_to_string(
            data_dir
                .path()
                .join("proxy")
                .join("test-project")
                .join("proxy.json"),
        )
        .unwrap();
        // migrate_llm normalises the `llamacpp` alias to the canonical `local`
        // id (LOCAL_PROVIDERS), matching the `local/qwen3` model asserted above.
        assert!(
            proxy_cfg.contains(r#""prefix":"local""#),
            "route must exist for the provider: {proxy_cfg}"
        );
    }

    /// ADR-073 kill-switch: proxy_enabled=false falls back to the direct
    /// injection path (legacy behaviour).
    #[test]
    #[serial_test::serial(host_addressing)]
    fn test_proxy_kill_switch_uses_direct_path() {
        let data_dir = tempfile::tempdir().unwrap();
        let mut llm = v2_llm(
            "llamacpp",
            Some("qwen3"),
            Some("http://host.docker.internal:9000"),
        );
        llm.proxy_enabled = Some(false);
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: default_flags(),
            llm,
            ..Default::default()
        };
        let yaml = render_compose_isolated(
            data_dir.path(),
            "test-project",
            tmp_project_dir(),
            &config,
            &ResolvedIntegrationsConfig::default(),
            None,
            &HostBridgesInfo::default(),
        )
        .unwrap();
        let env = get_claude_env(&yaml);
        assert!(
            env.iter()
                .any(|e| e == "ANTHROPIC_BASE_URL=http://host.docker.internal:9000"),
            "kill-switch must restore direct injection: {env:?}"
        );
        assert!(
            !env.iter().any(|e| e.contains("proxy")),
            "no proxy reference on the direct path: {env:?}"
        );
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn test_kill_switch_anthropic_foreign_model_not_injected_on_direct_path() {
        // Kill-switch + a corrupted anthropic entry holding a foreign id: the
        // legacy direct path must NOT send it to api.anthropic.com (F-4/d8/b3).
        let data_dir = tempfile::tempdir().unwrap();
        let llm = LlmConfig {
            schema_version: Some(crate::config::LLM_SCHEMA_VERSION),
            proxy_enabled: Some(false),
            provider: Some("anthropic".to_string()),
            model: Some("nex-agi/nex-n2-pro:free".to_string()),
            providers: vec![crate::config::LlmProviderEntry {
                id: "anthropic".to_string(),
                kind: crate::config::LlmProviderKind::AnthropicOauth,
                base_url: None,
                model: Some("nex-agi/nex-n2-pro:free".to_string()),
                has_api_key: false,
                context_tokens: None,
                has_custom_headers: false,
            }],
            active: Some(crate::config::LlmActive {
                provider_id: "anthropic".to_string(),
                model: Some("nex-agi/nex-n2-pro:free".to_string()),
            }),
            ..Default::default()
        };
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: default_flags(),
            llm,
            ..Default::default()
        };
        let yaml = render_compose_isolated(
            data_dir.path(),
            "test-project",
            tmp_project_dir(),
            &config,
            &ResolvedIntegrationsConfig::default(),
            None,
            &HostBridgesInfo::default(),
        )
        .unwrap();
        let env = get_claude_env(&yaml);
        assert!(
            !env.iter().any(|e| e.starts_with("ANTHROPIC_MODEL=")),
            "foreign model must not be injected on the direct anthropic path: {env:?}"
        );
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn test_kill_switch_openrouter_errors_instead_of_billing_anthropic() {
        // CR#3: proxy_enabled=false + active OpenRouter must error, not silently
        // route to api.anthropic.com via the flat anthropic masquerade.
        let data_dir = tempfile::tempdir().unwrap();
        let mut llm = LlmConfig {
            schema_version: Some(crate::config::LLM_SCHEMA_VERSION),
            proxy_enabled: Some(false),
            providers: vec![crate::config::LlmProviderEntry {
                id: "openrouter".to_string(),
                kind: crate::config::LlmProviderKind::OpenRouter,
                base_url: None,
                model: Some("z-ai/glm-5.2".to_string()),
                has_api_key: true,
                context_tokens: None,
                has_custom_headers: false,
            }],
            active: Some(crate::config::LlmActive {
                provider_id: "openrouter".to_string(),
                model: Some("z-ai/glm-5.2".to_string()),
            }),
            ..Default::default()
        };
        crate::config::sync_llm_legacy_fields(&mut llm);
        let err = apply_llm_config_in(data_dir.path(), COMPOSE_TEMPLATE, &llm, "test-project")
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("requires the LLM proxy"),
            "kill-switch + OR must error clearly, got: {err}"
        );
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn test_kill_switch_dangling_active_bails_no_provider_configured() {
        // Dangling active (points at a missing entry) is unconfigured (SSOT
        // gate) regardless of the proxy kill-switch: render must refuse rather
        // than silently fall back to the Anthropic account default.
        let data_dir = tempfile::tempdir().unwrap();
        let llm = LlmConfig {
            schema_version: Some(crate::config::LLM_SCHEMA_VERSION),
            proxy_enabled: Some(false),
            providers: vec![],
            active: Some(crate::config::LlmActive {
                provider_id: "ghost".to_string(),
                model: None,
            }),
            ..Default::default()
        };
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: default_flags(),
            llm,
            ..Default::default()
        };
        let err = render_compose_isolated(
            data_dir.path(),
            "test-project",
            tmp_project_dir(),
            &config,
            &ResolvedIntegrationsConfig::default(),
            None,
            &HostBridgesInfo::default(),
        )
        .unwrap_err()
        .to_string();
        assert!(
            err.contains("No LLM provider configured"),
            "dangling active + kill-switch off must still bail: {err}"
        );
    }

    /// Local providers with custom headers stay on the direct path — the
    /// proxy would consume headers addressed to the LLM server.
    #[test]
    #[serial_test::serial(host_addressing)]
    fn test_proxy_local_custom_headers_falls_back_to_direct() {
        let data_dir = tempfile::tempdir().unwrap();
        let tokens_dir = ensure_token_dir_in(data_dir.path(), "test-project", "local-llm").unwrap();
        std::fs::write(tokens_dir.join("custom_headers"), "X-Test: 1\n").unwrap();
        let mut llm = LlmConfig {
            provider: Some("local".to_string()),
            model: Some("qwen3".to_string()),
            base_url: Some("http://host.docker.internal:9000".to_string()),
            has_custom_headers: true,
            ..Default::default()
        };
        crate::config::migrate_llm(&mut llm, crate::config::AnthropicEvidence::None);
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: default_flags(),
            llm,
            ..Default::default()
        };
        let yaml = render_compose_isolated(
            data_dir.path(),
            "test-project",
            tmp_project_dir(),
            &config,
            &ResolvedIntegrationsConfig::default(),
            None,
            &HostBridgesInfo::default(),
        )
        .unwrap();
        let env = get_claude_env(&yaml);
        assert!(
            env.iter()
                .any(|e| e == "ANTHROPIC_BASE_URL=http://host.docker.internal:9000"),
            "custom-header setups must use the direct path: {env:?}"
        );
        assert!(
            env.iter()
                .any(|e| e.starts_with("ANTHROPIC_CUSTOM_HEADERS=")),
            "custom headers must be injected on the direct path: {env:?}"
        );
    }

    fn get_claude_env(yaml: &str) -> Vec<String> {
        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(yaml).unwrap();
        doc.get("services")
            .and_then(|s| s.get("claude"))
            .and_then(|c| c.get("environment"))
            .and_then(|e| e.as_sequence())
            .unwrap_or(&vec![])
            .iter()
            .filter_map(|v| v.as_str().map(|s| s.to_string()))
            .collect()
    }

    /// ADR-073: proxy renders in every compose with the local image, hardened mounts (config ro,
    /// tokens ro, usage rw), no host ports, the per-project network, and renderer-created dirs.
    #[test]
    #[serial_test::serial(host_addressing)]
    fn test_proxy_service_rendered() {
        let data_dir = tempfile::tempdir().unwrap();
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: default_flags(),
            llm: configured_anthropic_llm(),
            ..Default::default()
        };
        let yaml = render_compose_isolated(
            data_dir.path(),
            "test-project",
            tmp_project_dir(),
            &config,
            &ResolvedIntegrationsConfig::default(),
            None,
            &HostBridgesInfo::default(),
        )
        .unwrap();

        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&yaml).unwrap();
        let svc = doc
            .get("services")
            .and_then(|s| s.get("proxy"))
            .expect("proxy service must render");

        let image = svc.get("image").and_then(|i| i.as_str()).unwrap();
        assert!(
            image.starts_with(build::IMAGE_PROXY),
            "proxy must use the locally built image, got {image}"
        );
        assert_eq!(
            svc.get("pull_policy").and_then(|p| p.as_str()),
            Some("never"),
            "proxy image must never be pulled"
        );
        assert!(
            svc.get("ports").is_none(),
            "proxy must not expose host ports"
        );
        assert_eq!(
            svc.get("read_only").and_then(|r| r.as_bool()),
            Some(true),
            "proxy must be read_only"
        );
        assert_eq!(
            svc.get("restart").and_then(|r| r.as_str()),
            Some("unless-stopped"),
            "proxy must restart unless-stopped"
        );
        let env: Vec<&str> = svc
            .get("environment")
            .and_then(|e| e.as_sequence())
            .map(|seq| seq.iter().filter_map(|v| v.as_str()).collect())
            .unwrap_or_default();
        let digest_env = env
            .iter()
            .find(|e| e.starts_with("SPW_CONFIG_DIGEST="))
            .expect("proxy must carry the config digest env");
        let digest = digest_env.trim_start_matches("SPW_CONFIG_DIGEST=");
        assert_eq!(digest.len(), 64, "substituted sha256 hex, got {digest}");
        assert!(digest.chars().all(|c| c.is_ascii_hexdigit()));

        let volumes: Vec<&str> = svc
            .get("volumes")
            .and_then(|v| v.as_sequence())
            .unwrap()
            .iter()
            .filter_map(|v| v.as_str())
            .collect();
        assert!(
            volumes.iter().any(|v| v.ends_with(":/config:ro")),
            "config mount must be ro, got {volumes:?}"
        );
        assert!(
            volumes
                .iter()
                .any(|v| v.contains("/llm:/tokens") && v.ends_with(":ro")),
            "tokens mount must be the llm namespace, ro, got {volumes:?}"
        );
        assert!(
            volumes.iter().any(|v| v.ends_with(":/usage:rw")),
            "usage mount must be rw, got {volumes:?}"
        );

        // Renderer must create the host-side mount sources.
        assert!(
            data_dir.path().join("proxy").join("test-project").is_dir(),
            "proxy config dir must be created"
        );
        assert!(
            data_dir
                .path()
                .join("usage")
                .join("test-project")
                .join("proxy")
                .is_dir(),
            "usage dir must be created"
        );
    }

    /// The claude container reads the proxy usage JSONL (statusline SSOT) via a
    /// read-only `/usage` mount pointed at the same dir the proxy writes.
    #[test]
    #[serial_test::serial(host_addressing)]
    fn claude_service_mounts_usage_readonly() {
        let data_dir = tempfile::tempdir().unwrap();
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: default_flags(),
            llm: configured_anthropic_llm(),
            ..Default::default()
        };
        let yaml = render_compose_isolated(
            data_dir.path(),
            "test-project",
            tmp_project_dir(),
            &config,
            &ResolvedIntegrationsConfig::default(),
            None,
            &HostBridgesInfo::default(),
        )
        .unwrap();

        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&yaml).unwrap();
        let volumes: Vec<&str> = doc
            .get("services")
            .and_then(|s| s.get("claude"))
            .and_then(|c| c.get("volumes"))
            .and_then(|v| v.as_sequence())
            .unwrap()
            .iter()
            .filter_map(|v| v.as_str())
            .collect();
        assert!(
            volumes.iter().any(|v| v.ends_with(":/usage:ro")),
            "claude must mount the usage dir read-only, got {volumes:?}"
        );
        // The claude /usage source must be the same dir the proxy writes to.
        let usage_src = volumes
            .iter()
            .find(|v| v.ends_with(":/usage:ro"))
            .map(|v| v.trim_end_matches(":/usage:ro"))
            .unwrap();
        assert!(
            usage_src.ends_with("proxy"),
            "claude /usage must point at the proxy usage dir, got {usage_src}"
        );
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn test_ollama_direct_injection() {
        let data_dir = tempfile::tempdir().unwrap();
        // Kill-switch off: this test asserts the legacy direct-injection path.
        // Migration normalises the "ollama" alias to the generic "local" id
        // (ADR-073), so the display label is "Local", not the v1 "Ollama" alias
        // (that per-alias-string behavior is covered directly, unmigrated, by
        // compose::llm::tests::legacy_in_ollama_uses_its_own_display_label).
        let mut llm = LlmConfig {
            provider: Some("ollama".to_string()),
            model: Some("llama3.3".to_string()),
            base_url: None,
            context_tokens: None,
            has_api_key: false,
            has_custom_headers: false,
            ..Default::default()
        };
        crate::config::migrate_llm(&mut llm, crate::config::AnthropicEvidence::None);
        llm.proxy_enabled = Some(false);
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: default_flags(),
            llm,
            ..Default::default()
        };
        let yaml = render_compose_isolated(
            data_dir.path(),
            "test-project",
            tmp_project_dir(),
            &config,
            &ResolvedIntegrationsConfig::default(),
            None,
            &HostBridgesInfo::default(),
        )
        .unwrap();
        let env = get_claude_env(&yaml);
        let expected_ollama = format!("ANTHROPIC_BASE_URL={}", default_base_url("ollama").unwrap());
        assert!(
            env.iter().any(|e| e == &expected_ollama),
            "Ollama must set {expected_ollama} (no /v1), got: {env:?}"
        );
        assert!(
            env.iter()
                .any(|e| e == "ANTHROPIC_AUTH_TOKEN=sk-no-key-required"),
            "Ollama must set dummy auth token"
        );
        assert!(
            env.iter().any(|e| e == "ANTHROPIC_MODEL=llama3.3"),
            "Ollama must set ANTHROPIC_MODEL — Claude Code's primary mechanism for the active \
             model, displayed in /status and statusline. Without it Claude Code falls back to \
             its account-tier default. Got: {env:?}"
        );
        assert!(
            env.iter()
                .any(|e| e == "ANTHROPIC_CUSTOM_MODEL_OPTION=llama3.3"),
            "Ollama must set ANTHROPIC_CUSTOM_MODEL_OPTION to the user model, got: {env:?}"
        );
        assert!(
            env.iter()
                .any(|e| e == "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME=llama3.3 (Local)"),
            "Post-migration ollama collapses to the generic 'Local' label, got: {env:?}"
        );
        assert!(
            env.iter()
                .any(|e| e
                    == "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION=Local model served by Local"),
            "Ollama must set ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION, got: {env:?}"
        );
        assert!(
            !env
                .iter()
                .any(|e| e.starts_with("ANTHROPIC_DEFAULT_SONNET_MODEL=")
                    || e.starts_with("ANTHROPIC_DEFAULT_OPUS_MODEL=")
                    || e.starts_with("ANTHROPIC_DEFAULT_HAIKU_MODEL=")),
            "Local providers must not override Anthropic alias models — use ANTHROPIC_CUSTOM_MODEL_OPTION \
             so the /model picker shows a single explicit entry. Got: {env:?}"
        );
        assert!(
            env.iter()
                .any(|e| e == "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1"),
            "Ollama must disable nonessential traffic"
        );
        assert!(
            env.iter().any(|e| e == "CLAUDE_CODE_ATTRIBUTION_HEADER=0"),
            "Ollama must disable attribution header"
        );
        assert!(!yaml.contains("llm-proxy"), "Ollama must not add llm-proxy");
        assert!(
            !env.iter().any(|e| e.contains("proxy")),
            "Ollama (direct path) must not point claude env at the proxy"
        );
    }

    // test_lmstudio_default_url / test_llamacpp_default_url / test_llamacpp_custom_model_option_labels /
    // test_lmstudio_custom_model_option_labels: relocated to compose::llm::tests as
    // legacy_in_lmstudio_uses_its_own_default_port / legacy_in_llamacpp_uses_its_own_default_port /
    // legacy_in_llamacpp_uses_its_own_display_label / legacy_in_lmstudio_uses_its_own_display_label.
    // Migration collapses every LOCAL_PROVIDERS alias to the canonical "local" id
    // (ADR-073) before it ever reaches the renderer, so the per-alias URL/label is
    // only observable via the unmigrated, direct apply_llm_config_legacy_in call
    // those tests already make.

    // test_unsupported_provider_rejected / test_custom_provider_rejected_after_removal:
    // relocated to compose::llm::tests as legacy_in_rejects_unsupported_provider /
    // legacy_in_rejects_custom_provider_after_removal — an unmigrated raw config
    // now bails at the SSOT gate before ever reaching apply_llm_config_legacy_in's
    // unsupported-provider check, so the direct-legacy-path variant is the only
    // one still reachable through that code path.

    #[test]
    fn test_strip_trailing_v1() {
        assert_eq!(strip_trailing_v1("http://x:8080/v1"), "http://x:8080");
        assert_eq!(strip_trailing_v1("http://x:8080/v1/"), "http://x:8080");
        assert_eq!(strip_trailing_v1("http://x:8080"), "http://x:8080");
        assert_eq!(strip_trailing_v1(""), "");
        assert_eq!(strip_trailing_v1("http://x:8080/v1/v1"), "http://x:8080/v1");
        // Regression: trailing slash without /v1 must be stripped too, else double-slash request paths.
        assert_eq!(strip_trailing_v1("http://x:8080/"), "http://x:8080");
        assert_eq!(strip_trailing_v1("http://x:8080///"), "http://x:8080");
    }

    // `url::Url` adds a trailing `/` to a host-only authority; the save path's
    // later `strip_trailing_v1` removes it. Tests assert the exact returned form.
    #[test]
    fn canonicalize_rewrites_loopback_hosts_to_gateway_alias() {
        let alias = crate::consts::HOST_GATEWAY_ALIAS;
        // Happy: the common loopback forms a user types for a local LLM.
        assert_eq!(
            canonicalize_local_base_url("http://127.0.0.1:1234"),
            format!("http://{alias}:1234/")
        );
        assert_eq!(
            canonicalize_local_base_url("http://localhost:11434"),
            format!("http://{alias}:11434/")
        );
        // Case-insensitive localhost (mirrors validate_url).
        assert_eq!(
            canonicalize_local_base_url("http://LocalHost:8080"),
            format!("http://{alias}:8080/")
        );
        // Whole 127.0.0.0/8 loopback range, not just 127.0.0.1.
        assert_eq!(
            canonicalize_local_base_url("http://127.0.0.5:1234"),
            format!("http://{alias}:1234/")
        );
        // IPv6 loopback and IPv6-mapped IPv4 loopback.
        assert_eq!(
            canonicalize_local_base_url("http://[::1]:1234"),
            format!("http://{alias}:1234/")
        );
        assert_eq!(
            canonicalize_local_base_url("http://[::ffff:127.0.0.1]:1234"),
            format!("http://{alias}:1234/")
        );
    }

    #[test]
    fn canonicalize_preserves_scheme_port_path_and_is_idempotent() {
        let alias = crate::consts::HOST_GATEWAY_ALIAS;
        // Path preserved (the /v1 strip is a separate step).
        assert_eq!(
            canonicalize_local_base_url("http://127.0.0.1:1234/v1"),
            format!("http://{alias}:1234/v1")
        );
        // Scheme preserved.
        assert_eq!(
            canonicalize_local_base_url("https://127.0.0.1:1234"),
            format!("https://{alias}:1234/")
        );
        // No port — the host swaps, nothing else.
        assert_eq!(
            canonicalize_local_base_url("http://127.0.0.1"),
            format!("http://{alias}/")
        );
        // Already canonical → unchanged (idempotent).
        let already = format!("http://{alias}:1234/");
        assert_eq!(canonicalize_local_base_url(&already), already);
    }

    #[test]
    fn canonicalize_leaves_non_loopback_hosts_untouched() {
        // Non-loopback hosts are returned verbatim (no re-serialization), so a
        // real remote server's exact string is preserved.
        assert_eq!(
            canonicalize_local_base_url("http://192.168.5.10:1234"),
            "http://192.168.5.10:1234"
        );
        assert_eq!(
            canonicalize_local_base_url("http://10.0.0.4:8080"),
            "http://10.0.0.4:8080"
        );
        // Public domain — untouched.
        assert_eq!(
            canonicalize_local_base_url("https://api.example.com/"),
            "https://api.example.com/"
        );
        // 0.0.0.0 is not a loopback the user would target — untouched.
        assert_eq!(
            canonicalize_local_base_url("http://0.0.0.0:1234"),
            "http://0.0.0.0:1234"
        );
    }

    #[test]
    fn canonicalize_returns_input_unchanged_on_parse_failure() {
        // Malformed input is returned verbatim — validation runs separately.
        assert_eq!(canonicalize_local_base_url("not-a-url"), "not-a-url");
        assert_eq!(canonicalize_local_base_url(""), "");
    }

    #[test]
    fn test_idempotent_render() {
        let data_dir = tempfile::tempdir().unwrap();
        let mut llm = LlmConfig {
            provider: Some("ollama".to_string()),
            model: Some("llama3.3".to_string()),
            base_url: None,
            context_tokens: None,
            has_api_key: false,
            has_custom_headers: false,
            ..Default::default()
        };
        crate::config::migrate_llm(&mut llm, crate::config::AnthropicEvidence::None);
        let result1 =
            apply_llm_config_in(data_dir.path(), COMPOSE_TEMPLATE, &llm, "test-project").unwrap();
        let result2 = apply_llm_config_in(data_dir.path(), &result1, &llm, "test-project").unwrap();
        assert_eq!(
            result1, result2,
            "apply_llm_config must be idempotent (no UUID injection)"
        );
    }

    #[test]
    fn test_base_url_rejects_non_http_schemes() {
        for bad_url in &["javascript:alert(1)", "file:///etc/passwd", "ftp://x:21"] {
            assert!(
                validate_base_url(bad_url).is_err(),
                "Must reject scheme: {bad_url}"
            );
        }
    }

    #[test]
    fn test_base_url_rejects_credentials() {
        assert!(
            validate_base_url("http://user:pass@host.docker.internal:11434").is_err(),
            "Must reject credentials in URL"
        );
    }

    #[test]
    fn test_base_url_rejects_multi_segment_path() {
        // Multi-segment paths must be rejected even with the relaxed policy.
        for bad in &[
            "http://host.docker.internal:11434/api/v1/",
            "http://host.docker.internal:11434/a/b",
            "http://host.docker.internal:11434/anthropic/v1",
        ] {
            assert!(
                validate_base_url(bad).is_err(),
                "Must reject multi-segment path: {bad}"
            );
        }
    }

    #[test]
    fn test_base_url_accepts_single_segment_path() {
        // The proxy's `/anthropic`, AWS-style `/v1`, any single ASCII segment.
        for ok in &[
            "http://host.docker.internal:4000/anthropic",
            "http://litellm.local/v1",
            "https://gateway.example.com/aws_proxy",
            "http://host:8080/my-route",
        ] {
            assert!(
                validate_base_url(ok).is_ok(),
                "Must accept single-segment path: {ok}"
            );
        }
    }

    #[test]
    fn test_base_url_rejects_path_traversal() {
        for bad in &[
            "http://host/..",
            "http://host/../etc",
            "http://host/./foo",
            "http://host/foo/",
        ] {
            assert!(
                validate_base_url(bad).is_err(),
                "Must reject traversal/trailing-slash path: {bad}"
            );
        }
    }

    #[test]
    fn test_base_url_rejects_query_and_fragment() {
        for bad in &[
            "http://host/anthropic?api_key=x",
            "http://host/v1#section",
            "http://host?token=x",
        ] {
            assert!(
                validate_base_url(bad).is_err(),
                "Must reject query/fragment: {bad}"
            );
        }
    }

    #[test]
    fn test_base_url_accepts_remote_host() {
        assert!(
            validate_base_url("http://192.168.1.100:11434").is_ok(),
            "Must accept remote IP (LLM on another machine in LAN)"
        );
    }

    #[test]
    fn test_base_url_accepts_localhost() {
        assert!(
            validate_base_url("http://localhost:11434").is_ok(),
            "Must accept localhost"
        );
    }

    #[test]
    fn compose_template_claude_has_canonical_host_gateway_entry() {
        // Static template guard: claude and mcp-playwright must list the host gateway alias in extra_hosts (ADR-062).
        let expected = format!(r#"- "{}:${{HOST_GATEWAY}}""#, consts::HOST_GATEWAY_ALIAS);
        assert!(
            COMPOSE_TEMPLATE.lines().any(|l| l.trim() == expected),
            "compose.template.yml must contain '{expected}' in extra_hosts"
        );
    }

    #[test]
    fn compose_template_extra_hosts_contains_only_canonical_alias() {
        // Inverse guard: no deprecated `host.*.internal` alias may sneak back
        // into the template's extra_hosts block.
        let mut in_extra_hosts = false;
        for line in COMPOSE_TEMPLATE.lines() {
            let trimmed = line.trim();
            if trimmed == "extra_hosts:" {
                in_extra_hosts = true;
                continue;
            }
            if in_extra_hosts && !trimmed.starts_with('-') && !trimmed.is_empty() {
                in_extra_hosts = false;
            }
            if !in_extra_hosts {
                continue;
            }
            if let Some(alias) = trimmed
                .strip_prefix("- \"")
                .and_then(|s| s.split(':').next())
                .filter(|h| h.starts_with("host.") && h.ends_with(".internal"))
            {
                assert_eq!(
                    alias,
                    consts::HOST_GATEWAY_ALIAS,
                    "compose.template.yml extra_hosts contains deprecated alias '{alias}'; \
                     only the canonical HOST_GATEWAY_ALIAS is allowed"
                );
            }
        }
    }

    /// ADR-062: the `mcp-playwright` template block must declare the canonical `extra_hosts` entry.
    #[test]
    fn mcp_playwright_section_has_extra_hosts_in_template() {
        let needle = "\n  mcp-playwright:\n";
        let pw_start = COMPOSE_TEMPLATE
            .find(needle)
            .expect("mcp-playwright section must exist in compose.template.yml");
        let after_pw = pw_start + needle.len();
        let next_service = COMPOSE_TEMPLATE[after_pw..]
            .find("\n  mcp-")
            .map(|i| after_pw + i)
            .unwrap_or(COMPOSE_TEMPLATE.len());
        let pw_block = &COMPOSE_TEMPLATE[pw_start..next_service];
        let expected = format!(r#"- "{}:${{HOST_GATEWAY}}""#, consts::HOST_GATEWAY_ALIAS);
        // Match an actual YAML list item, not the string inside a comment; lines().any() rejects commented-out lines.
        assert!(
            pw_block.lines().any(|l| l.trim() == expected),
            "mcp-playwright section in compose.template.yml must declare extra_hosts '{expected}' (ADR-062)"
        );
    }

    // ---- ensure_host_gateway_extra_host + per-consumer injection tests ----

    fn render_substituted_template() -> String {
        COMPOSE_TEMPLATE.replace("${HOST_GATEWAY}", &host_gateway_ip().expect("test"))
    }

    // --- Resource SSOT works (ADR-068) -----------------------------------------
    // Renderer fills every container's mem/cpu/tmpfs/shm from the SSOT, no placeholder left (ADR-068).

    /// Reads a service's mem/cpu/tmpfs/shm out of the rendered doc and asserts
    /// they equal its SSOT entry. Iterating callers stay literal-free.
    fn assert_resources_from_ssot(
        doc: &serde_yaml_ng::Value,
        service: &str,
        ssot: &crate::resources::ContainerResources,
    ) {
        let svc = &doc["services"][service];
        let parse = |s: &str| crate::plugin::parse_mem_limit_to_mib(s).expect("mem parse");
        let mem = svc["deploy"]["resources"]["limits"]["memory"]
            .as_str()
            .unwrap_or_else(|| panic!("{service}: missing memory"));
        let cpus: f32 = svc["deploy"]["resources"]["limits"]["cpus"]
            .as_str()
            .unwrap_or_else(|| panic!("{service}: missing cpus"))
            .parse()
            .expect("cpus parse");
        let tmpfs = svc["tmpfs"][0]
            .as_str()
            .and_then(|e| e.rsplit("size=").next())
            .unwrap_or_else(|| panic!("{service}: missing tmpfs size"));
        let shm = svc["shm_size"].as_str().map(parse);

        assert_eq!(parse(mem), ssot.mem_mib as u64, "{service}: memory");
        assert!((cpus - ssot.cpus).abs() < f32::EPSILON, "{service}: cpus");
        assert_eq!(parse(tmpfs), ssot.tmpfs_mib as u64, "{service}: tmpfs");
        assert_eq!(shm, ssot.shm_mib.map(|m| m as u64), "{service}: shm");
    }

    #[test]
    fn resources_render_from_ssot() {
        let yaml =
            apply_container_resources(COMPOSE_TEMPLATE).replace("${HOST_GATEWAY}", "127.0.0.1");
        let doc: serde_yaml_ng::Value =
            serde_yaml_ng::from_str(&yaml).expect("rendered template must be valid YAML");

        // Every container's resources come from the SSOT.
        assert_resources_from_ssot(&doc, "claude", &crate::resources::CLAUDE_RESOURCES);
        assert_resources_from_ssot(&doc, "mcp-hub", &crate::resources::HUB_RESOURCES);
        assert_resources_from_ssot(&doc, "proxy", &crate::resources::PROXY_RESOURCES);
        for svc in crate::consts::TOGGLEABLE_MCP_SERVICES {
            assert_resources_from_ssot(&doc, svc.compose_name, &svc.resources);
        }
        // No resource placeholder left unsubstituted; IMAGE_*, NETWORK_NAME are filled later.
        for marker in ["_MEM}", "_CPUS}", "_TMPFS}", "_SHM}", "${CLAUDE_MEMORY}"] {
            assert!(
                !yaml.contains(marker),
                "unsubstituted resource placeholder containing {marker}"
            );
        }

        // Raw template must carry a placeholder for each worker's mem/cpu; catches a re-hardcoded literal.
        for svc in crate::consts::TOGGLEABLE_MCP_SERVICES {
            let prefix = svc.compose_name.to_ascii_uppercase().replace('-', "_");
            assert!(
                COMPOSE_TEMPLATE.contains(&format!("${{{prefix}_MEM}}")),
                "{}: template must carry ${{{prefix}_MEM}}, not a literal",
                svc.compose_name
            );
            assert!(
                COMPOSE_TEMPLATE.contains(&format!("${{{prefix}_CPUS}}")),
                "{}: template must carry ${{{prefix}_CPUS}}, not a literal",
                svc.compose_name
            );
            // tmpfs is most prone to a silent re-hardcode; needs the same raw-template guard as _MEM/_CPUS.
            assert!(
                COMPOSE_TEMPLATE.contains(&format!("${{{prefix}_TMPFS}}")),
                "{}: template must carry ${{{prefix}_TMPFS}}, not a literal",
                svc.compose_name
            );
            // _SHM placeholder must exist IFF the descriptor sets shm_mib; assert both directions.
            assert_eq!(
                COMPOSE_TEMPLATE.contains(&format!("${{{prefix}_SHM}}")),
                svc.resources.shm_mib.is_some(),
                "{}: template ${{{prefix}_SHM}} placeholder must match descriptor shm_mib",
                svc.compose_name
            );
        }

        // Same raw-template guard for the always-on containers (claude mem is legacy).
        for placeholder in [
            "${CLAUDE_MEMORY}",
            "${CLAUDE_CPUS}",
            "${CLAUDE_TMPFS}",
            "${MCP_HUB_MEM}",
            "${MCP_HUB_CPUS}",
            "${MCP_HUB_TMPFS}",
            "${PROXY_MEM}",
            "${PROXY_CPUS}",
            "${PROXY_TMPFS}",
        ] {
            assert!(
                COMPOSE_TEMPLATE.contains(placeholder),
                "template must carry {placeholder}, not a literal"
            );
        }
    }

    #[test]
    fn format_mib_renders_mebibyte_suffix() {
        assert_eq!(format_mib(0), "0m");
        assert_eq!(format_mib(64), "64m");
        assert_eq!(format_mib(6144), "6144m");
    }

    #[test]
    fn format_cpus_renders_one_decimal() {
        assert_eq!(format_cpus(0.5), "0.5");
        assert_eq!(format_cpus(2.0), "2.0");
        // Whole and >1 values still carry exactly one decimal place.
        assert_eq!(format_cpus(4.0), "4.0");
    }

    /// Write a fixture lock.json + standalone token mount file for the given service.
    /// Returns `(token_mount_path, lock_path)` — inputs to `apply_*_config_with_path*`.
    fn write_lock_and_token_mount(
        tmp: &std::path::Path,
        service: crate::host_mcp_process::lock::LockService,
    ) -> (std::path::PathBuf, std::path::PathBuf) {
        use crate::host_mcp_process::lock::{self, LockFile};
        let token_path = tmp.join("auth-token");
        let lock_path = tmp.join(consts::PER_PROJECT_LOCK_FILE);
        std::fs::write(&token_path, "test-token").unwrap();
        // PID = this test process so apply_worker_config's liveness gate passes.
        let lock = LockFile::new(service, std::process::id(), 4007, "test-token".into());
        lock::write(&lock_path, &lock).unwrap();
        (token_path, lock_path)
    }

    fn extra_hosts_for(yaml: &str, service: &str) -> Vec<String> {
        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(yaml).unwrap();
        doc["services"][service]["extra_hosts"]
            .as_sequence()
            .map(|s| {
                s.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default()
    }

    fn count_canonical_entries(entries: &[String]) -> usize {
        let prefix = format!("{}:", consts::HOST_GATEWAY_ALIAS);
        entries.iter().filter(|e| e.starts_with(&prefix)).count()
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn apply_mcp_os_config_adds_host_gateway_to_hub() {
        let tmp = tempfile::tempdir().unwrap();
        let (token_path, lock_path) = write_lock_and_token_mount(
            tmp.path(),
            crate::host_mcp_process::lock::LockService::McpOs,
        );
        let yaml = render_substituted_template();
        let result = apply_mcp_os_config_with_path(&yaml, &token_path, &lock_path).unwrap();
        let entries = extra_hosts_for(&result, "mcp-hub");
        assert_eq!(
            count_canonical_entries(&entries),
            1,
            "mcp-hub must have exactly 1 host.docker.internal entry, got: {entries:?}"
        );
    }

    /// Like the live helper but reaps a real child for a deterministically-dead
    /// PID, so apply_worker_config's liveness gate treats the lock as absent.
    fn write_dead_lock_and_token_mount(
        tmp: &std::path::Path,
        service: crate::host_mcp_process::lock::LockService,
    ) -> (std::path::PathBuf, std::path::PathBuf) {
        use crate::host_mcp_process::lock::{self, LockFile};
        let mut child = std::process::Command::new("true")
            .spawn()
            .or_else(|_| {
                std::process::Command::new("cmd")
                    .args(["/C", "exit"])
                    .spawn()
            })
            .expect("spawn a trivially-exiting child");
        let dead_pid = child.id();
        child.wait().expect("reap child");

        let token_path = tmp.join("auth-token");
        let lock_path = tmp.join(consts::PER_PROJECT_LOCK_FILE);
        std::fs::write(&token_path, "test-token").unwrap();
        lock::write(
            &lock_path,
            &LockFile::new(service, dead_pid, 4007, "test-token".into()),
        )
        .unwrap();
        (token_path, lock_path)
    }

    /// Same regression guard for the mcp-os entry point (also routes through
    /// apply_worker_config).
    #[test]
    #[serial_test::serial(host_addressing)]
    fn apply_mcp_os_config_skipped_when_worker_pid_is_dead() {
        let tmp = tempfile::tempdir().unwrap();
        let (token_path, lock_path) = write_dead_lock_and_token_mount(
            tmp.path(),
            crate::host_mcp_process::lock::LockService::McpOs,
        );
        let yaml = render_substituted_template();
        let result = apply_mcp_os_config_with_path(&yaml, &token_path, &lock_path).unwrap();
        assert_eq!(
            result, yaml,
            "stale mcp-os lock with a dead PID must be treated as absent — no injection"
        );
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn apply_oauth_config_adds_host_gateway_to_each_consumer() {
        let tmp = tempfile::tempdir().unwrap();
        let lock_path = tmp.path().join(consts::PER_PROJECT_LOCK_FILE);
        write_live_oauth_lock(&lock_path, 4090);
        let bearer_map_path = tmp.path().join("bearer-map.json");
        std::fs::write(
            &bearer_map_path,
            r#"{"bearer-sharepoint-secret":"sharepoint"}"#,
        )
        .unwrap();

        let yaml = render_substituted_template();
        let result =
            apply_oauth_config_with_paths(&yaml, tmp.path(), &lock_path, &bearer_map_path).unwrap();

        // Each OAuth-consumer in the bearer map gets the canonical alias in its extra_hosts.
        let entries = extra_hosts_for(&result, "mcp-sharepoint");
        assert_eq!(
            count_canonical_entries(&entries),
            1,
            "mcp-sharepoint must have exactly 1 host.docker.internal entry, got: {entries:?}"
        );
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn ensure_host_gateway_extra_host_is_idempotent() {
        let mut doc: serde_yaml_ng::Value =
            serde_yaml_ng::from_str(&render_substituted_template()).unwrap();
        ensure_host_gateway_extra_host(&mut doc, "mcp-hub").expect("test");
        ensure_host_gateway_extra_host(&mut doc, "mcp-hub").expect("test");
        let yaml = serde_yaml_ng::to_string(&doc).unwrap();
        let entries = extra_hosts_for(&yaml, "mcp-hub");
        assert_eq!(
            count_canonical_entries(&entries),
            1,
            "after 2× helper calls, mcp-hub must still have 1 entry, got: {entries:?}"
        );
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn ensure_host_gateway_extra_host_replaces_existing_canonical_entry() {
        let mut doc: serde_yaml_ng::Value =
            serde_yaml_ng::from_str(&render_substituted_template()).unwrap();
        // Pre-seed mcp-hub with a stale canonical entry pointing at a wrong IP.
        doc["services"]["mcp-hub"]["extra_hosts"] =
            serde_yaml_ng::Value::Sequence(vec![serde_yaml_ng::Value::String(format!(
                "{}:9.9.9.9",
                consts::HOST_GATEWAY_ALIAS
            ))]);
        ensure_host_gateway_extra_host(&mut doc, "mcp-hub").expect("test");
        let yaml = serde_yaml_ng::to_string(&doc).unwrap();
        let entries = extra_hosts_for(&yaml, "mcp-hub");
        assert_eq!(
            entries.len(),
            1,
            "must replace, not append, got: {entries:?}"
        );
        assert_eq!(
            entries[0],
            format!(
                "{}:{}",
                consts::HOST_GATEWAY_ALIAS,
                host_gateway_ip().expect("test")
            )
        );
    }

    // SSOT-definition guards: pin the literal expected base_url for each local provider.

    #[test]
    fn test_default_base_url_ollama_returns_canonical_url() {
        assert_eq!(
            default_base_url("ollama").as_deref(),
            Some("http://host.docker.internal:11434")
        );
    }

    #[test]
    fn test_default_base_url_lmstudio_returns_canonical_url() {
        assert_eq!(
            default_base_url("lmstudio").as_deref(),
            Some("http://host.docker.internal:1234")
        );
    }

    #[test]
    fn test_default_base_url_llamacpp_returns_canonical_url() {
        assert_eq!(
            default_base_url("llamacpp").as_deref(),
            Some("http://host.docker.internal:8080")
        );
    }

    #[test]
    fn test_anthropic_with_model_injects_anthropic_model_env() {
        let data_dir = tempfile::tempdir().unwrap();
        // claude.llm.model must translate into the ANTHROPIC_MODEL env var so Claude Code respects the pick.
        let mut llm = LlmConfig {
            provider: Some("anthropic".to_string()),
            model: Some("claude-sonnet-4-6".to_string()),
            base_url: None,
            context_tokens: None,
            has_api_key: false,
            has_custom_headers: false,
            ..Default::default()
        };
        crate::config::migrate_llm(&mut llm, crate::config::AnthropicEvidence::None);
        let rendered =
            apply_llm_config_in(data_dir.path(), COMPOSE_TEMPLATE, &llm, "test-project").unwrap();
        let env = get_claude_env(&rendered);
        assert!(
            env.iter().any(|e| e == "ANTHROPIC_MODEL=claude-sonnet-4-6"),
            "Anthropic + explicit model must inject ANTHROPIC_MODEL, got: {env:?}"
        );
        // ADR-073: anthropic sessions route through the proxy passthrough, so
        // ANTHROPIC_BASE_URL points at it (never a foreign/local URL).
        assert!(
            env.iter()
                .any(|e| e == "ANTHROPIC_BASE_URL=http://proxy:4000"),
            "Anthropic provider must route through the proxy passthrough, got: {env:?}"
        );
    }

    #[test]
    fn test_anthropic_without_model_does_not_inject_anthropic_model() {
        let data_dir = tempfile::tempdir().unwrap();
        // Empty/unset model = let Claude Code pick its default: base_env() must stay free of
        // ANTHROPIC_MODEL (fallback path per defaults.rs::base_env_does_not_set_model).
        let mut llm = LlmConfig {
            provider: Some("anthropic".to_string()),
            model: None,
            base_url: None,
            context_tokens: None,
            has_api_key: false,
            has_custom_headers: false,
            ..Default::default()
        };
        crate::config::migrate_llm(&mut llm, crate::config::AnthropicEvidence::None);
        let rendered =
            apply_llm_config_in(data_dir.path(), COMPOSE_TEMPLATE, &llm, "test-project").unwrap();
        let env = get_claude_env(&rendered);
        assert!(
            !env.iter().any(|e| e.starts_with("ANTHROPIC_MODEL=")),
            "Anthropic + no model must not set ANTHROPIC_MODEL, got: {env:?}"
        );

        // An empty string after trim should behave the same as None — a
        // user clearing the dropdown from the UI sends "" through Tauri.
        let mut llm_blank = LlmConfig {
            provider: Some("anthropic".to_string()),
            model: Some("   ".to_string()),
            base_url: None,
            context_tokens: None,
            has_api_key: false,
            has_custom_headers: false,
            ..Default::default()
        };
        crate::config::migrate_llm(&mut llm_blank, crate::config::AnthropicEvidence::None);
        let rendered_blank = apply_llm_config_in(
            data_dir.path(),
            COMPOSE_TEMPLATE,
            &llm_blank,
            "test-project",
        )
        .unwrap();
        let env_blank = get_claude_env(&rendered_blank);
        assert!(
            !env_blank.iter().any(|e| e.starts_with("ANTHROPIC_MODEL=")),
            "Anthropic + whitespace-only model must not set ANTHROPIC_MODEL, got: {env_blank:?}"
        );
    }

    #[test]
    fn test_anthropic_foreign_model_falls_back_to_account_default() {
        // Corrupted v2 config: anthropic entry + active both hold an OR id.
        // The render-guard must drop it (no ANTHROPIC_MODEL) instead of 404ing.
        let data_dir = tempfile::tempdir().unwrap();
        let llm = LlmConfig {
            schema_version: Some(crate::config::LLM_SCHEMA_VERSION),
            providers: vec![crate::config::LlmProviderEntry {
                id: "anthropic".to_string(),
                kind: crate::config::LlmProviderKind::AnthropicOauth,
                base_url: None,
                model: Some("nex-agi/nex-n2-pro:free".to_string()),
                has_api_key: false,
                context_tokens: None,
                has_custom_headers: false,
            }],
            active: Some(crate::config::LlmActive {
                provider_id: "anthropic".to_string(),
                model: Some("nex-agi/nex-n2-pro:free".to_string()),
            }),
            ..Default::default()
        };
        let rendered =
            apply_llm_config_in(data_dir.path(), COMPOSE_TEMPLATE, &llm, "test-project").unwrap();
        let env = get_claude_env(&rendered);
        assert!(
            !env.iter().any(|e| e.starts_with("ANTHROPIC_MODEL=")),
            "foreign model under anthropic must NOT set ANTHROPIC_MODEL, got: {env:?}"
        );
        assert!(
            env.iter()
                .any(|e| e == "ANTHROPIC_BASE_URL=http://proxy:4000"),
            "anthropic still routes through the passthrough: {env:?}"
        );
    }

    #[test]
    fn test_anthropic_valid_catalog_model_injected_verbatim() {
        let data_dir = tempfile::tempdir().unwrap();
        let llm = LlmConfig {
            schema_version: Some(crate::config::LLM_SCHEMA_VERSION),
            providers: vec![crate::config::LlmProviderEntry {
                id: "anthropic".to_string(),
                kind: crate::config::LlmProviderKind::AnthropicOauth,
                base_url: None,
                model: Some("claude-opus-4-8[1m]".to_string()),
                has_api_key: false,
                context_tokens: None,
                has_custom_headers: false,
            }],
            active: Some(crate::config::LlmActive {
                provider_id: "anthropic".to_string(),
                model: Some("claude-opus-4-8[1m]".to_string()),
            }),
            ..Default::default()
        };
        let rendered =
            apply_llm_config_in(data_dir.path(), COMPOSE_TEMPLATE, &llm, "test-project").unwrap();
        let env = get_claude_env(&rendered);
        assert!(
            env.iter()
                .any(|e| e == "ANTHROPIC_MODEL=claude-opus-4-8[1m]"),
            "valid claude model must inject verbatim: {env:?}"
        );
    }

    #[test]
    fn test_anthropic_injects_default_alias_env_vars() {
        let data_dir = tempfile::tempdir().unwrap();
        // Workaround for anthropics/claude-code#34083: inject ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL
        // `[1m]` variants regardless of an explicit pinned model.
        let mut llm = LlmConfig {
            provider: Some("anthropic".to_string()),
            model: None,
            base_url: None,
            context_tokens: None,
            has_api_key: false,
            has_custom_headers: false,
            ..Default::default()
        };
        crate::config::migrate_llm(&mut llm, crate::config::AnthropicEvidence::None);
        let rendered =
            apply_llm_config_in(data_dir.path(), COMPOSE_TEMPLATE, &llm, "test-project").unwrap();
        let env = get_claude_env(&rendered);

        let expected = crate::defaults::anthropic_default_models_env();
        assert!(
            !expected.is_empty(),
            "anthropic_default_models_env returned empty — SSOT lost its `latest: true` entries"
        );
        for (var, value) in &expected {
            let line = format!("{var}={value}");
            assert!(
                env.iter().any(|e| e == &line),
                "Anthropic provider must inject `{line}`, got: {env:?}"
            );
        }
    }

    #[test]
    fn test_switching_provider_ollama_to_anthropic() {
        let data_dir = tempfile::tempdir().unwrap();
        let mut llm_ollama = LlmConfig {
            provider: Some("ollama".to_string()),
            model: Some("llama3.3".to_string()),
            base_url: None,
            context_tokens: None,
            has_api_key: false,
            has_custom_headers: false,
            ..Default::default()
        };
        crate::config::migrate_llm(&mut llm_ollama, crate::config::AnthropicEvidence::None);
        let llm_anthropic = configured_anthropic_llm();

        let with_ollama = apply_llm_config_in(
            data_dir.path(),
            COMPOSE_TEMPLATE,
            &llm_ollama,
            "test-project",
        )
        .unwrap();
        let with_anthropic = apply_llm_config_in(
            data_dir.path(),
            COMPOSE_TEMPLATE,
            &llm_anthropic,
            "test-project",
        )
        .unwrap();

        let env_ollama = get_claude_env(&with_ollama);
        let env_anthropic = get_claude_env(&with_anthropic);

        assert!(
            env_ollama
                .iter()
                .any(|e| e.starts_with("ANTHROPIC_BASE_URL=")),
            "Ollama must set ANTHROPIC_BASE_URL"
        );
        // ADR-073: both providers route through the proxy, but only ollama's
        // model is prefixed with its provider id — anthropic's is bare.
        assert!(
            env_anthropic
                .iter()
                .any(|e| e == "ANTHROPIC_BASE_URL=http://proxy:4000"),
            "Anthropic must route through the proxy passthrough, got: {env_anthropic:?}"
        );
        // ADR-073: the proxy path sets this for every provider kind (prompt-cache
        // only, OAuth-neutral) — no longer a local-only marker (see
        // llm::tests::login_unset_keys_cover_local_proxy_env's OAUTH_NEUTRAL list).
        assert!(
            env_anthropic
                .iter()
                .any(|e| e == "CLAUDE_CODE_ATTRIBUTION_HEADER=0"),
            "Anthropic (proxy path) must still set the attribution header, got: {env_anthropic:?}"
        );
        assert!(
            !env_anthropic
                .iter()
                .any(|e| e.starts_with("ANTHROPIC_CUSTOM_MODEL_OPTION")),
            "Anthropic provider must NOT inject ANTHROPIC_CUSTOM_MODEL_OPTION — it is only \
             set for local providers. Got: {env_anthropic:?}"
        );
    }

    // test_llamacpp_custom_model_option_labels / test_lmstudio_custom_model_option_labels:
    // duplicates — see the relocation note above test_strip_trailing_v1.

    #[test]
    #[serial_test::serial(host_addressing)]
    fn test_render_compose_claude_version_is_pinned() {
        let data_dir = tempfile::tempdir().unwrap();
        // Regression guard: CLAUDE_VERSION must be the pinned semver from defaults.
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: default_flags(),
            llm: configured_anthropic_llm(),
            ..Default::default()
        };
        let result = render_compose_isolated(
            data_dir.path(),
            "test-project",
            tmp_project_dir(),
            &config,
            &ResolvedIntegrationsConfig::default(),
            None,
            &HostBridgesInfo::default(),
        );
        // CodeQL: avoid {result:?} / {yaml} in panic — anyhow chain may carry
        // apply_oauth_config / init_secrets_dir traces. See project.rs:700.
        let yaml = result.expect("render_compose must succeed in test env");
        let expected = format!("CLAUDE_VERSION={}", crate::defaults::CLAUDE_VERSION);
        assert!(
            yaml.contains(&expected),
            "render_compose must inject {expected} (rendered length: {} chars)",
            yaml.len()
        );
        assert!(
            !yaml.contains("CLAUDE_VERSION=latest"),
            "render_compose must not contain CLAUDE_VERSION=latest"
        );
        assert!(
            !yaml.contains("CLAUDE_VERSION=stable"),
            "render_compose must not contain CLAUDE_VERSION=stable"
        );
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn test_workspace_mount_is_readwrite() {
        let data_dir = tempfile::tempdir().unwrap();
        // The workspace must be read-write so Claude can create/edit files.
        // This guards against accidentally adding :ro to the workspace mount.
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: default_flags(),
            llm: configured_anthropic_llm(),
            ..Default::default()
        };
        let yaml = render_compose_isolated(
            data_dir.path(),
            "testproj",
            tmp_project_dir(),
            &config,
            &ResolvedIntegrationsConfig::default(),
            None,
            &HostBridgesInfo::default(),
        )
        .expect("render_compose should succeed");

        // Should contain the workspace mount
        assert!(yaml.contains("/workspace"), "workspace mount must exist");

        // Should NOT have :ro on the workspace mount
        // Check that no line contains both "/workspace" and ":ro"
        for line in yaml.lines() {
            if line.contains("/workspace") {
                assert!(
                    !line.contains(":ro"),
                    "workspace mount must be read-write, not read-only: {}",
                    line
                );
            }
        }
    }

    // ── entrypoint.sh contract tests ────────────────────────────────────
    // entrypoint.sh is baked into the image; these tests validate its content at compile time.

    const ENTRYPOINT: &str = include_str!("../../../../containers/entrypoint.sh");

    #[test]
    fn test_entrypoint_generates_mcp_config() {
        // entrypoint.sh must generate mcp-config.json so Claude Code discovers the hub.
        assert!(
            ENTRYPOINT.contains("mcp-config.json"),
            "entrypoint.sh must generate mcp-config.json"
        );
    }

    #[test]
    fn test_entrypoint_mcp_config_uses_hub_port_env() {
        // entrypoint.sh reads MCP_HUB_PORT from compose environment.
        assert!(
            ENTRYPOINT.contains("MCP_HUB_PORT"),
            "entrypoint.sh must reference MCP_HUB_PORT env var"
        );
    }

    #[test]
    fn test_entrypoint_mcp_config_has_default_port() {
        // If MCP_HUB_PORT is not set, entrypoint.sh defaults to 4000 (PORT_BASE).
        assert!(
            ENTRYPOINT.contains("MCP_HUB_PORT:-4000") || ENTRYPOINT.contains("MCP_HUB_PORT:=4000"),
            "entrypoint.sh must default MCP_HUB_PORT to 4000"
        );
    }

    #[test]
    fn test_entrypoint_mcp_config_uses_http_transport() {
        // MCP hub uses HTTP transport (not stdio). Config must specify type=http.
        assert!(
            ENTRYPOINT.contains(r#""type": "http""#),
            "entrypoint.sh must generate MCP config with type=http"
        );
    }

    #[test]
    fn test_entrypoint_mcp_config_connects_to_hub_hostname() {
        // Inside Docker network, the hub container is reachable as "mcp-hub".
        assert!(
            ENTRYPOINT.contains("http://mcp-hub:"),
            "entrypoint.sh must connect to http://mcp-hub:<port>"
        );
    }

    #[test]
    fn test_entrypoint_mcp_config_path_matches_defaults() {
        // The path entrypoint.sh writes mcp-config.json to must match MCP_CONFIG_PATH in
        // DEFAULT_FLAGS. Extracted from entrypoint.sh: `cat > "${HOME}/.claude/mcp-config.json"`
        assert!(
            ENTRYPOINT.contains(".claude/mcp-config.json"),
            "entrypoint.sh must write to .claude/mcp-config.json (matching MCP_CONFIG_PATH)"
        );
        // Also verify that MCP_CONFIG_PATH contains the same subpath
        assert!(
            crate::defaults::MCP_CONFIG_PATH.contains(".claude/mcp-config.json"),
            "MCP_CONFIG_PATH must contain .claude/mcp-config.json"
        );
    }

    #[test]
    fn test_entrypoint_mcp_config_has_speedwave_hub_server() {
        // The MCP server name must be "speedwave-hub" for consistent identification.
        assert!(
            ENTRYPOINT.contains("speedwave-hub"),
            "entrypoint.sh must name the MCP server 'speedwave-hub'"
        );
    }

    // ── mcp-os integration tests (routed through hub) ──────────────────

    #[test]
    fn test_entrypoint_no_speedwave_os() {
        // mcp-os is routed through the hub. entrypoint.sh must never
        // contain "speedwave-os" — Claude sees only speedwave-hub.
        assert!(
            !ENTRYPOINT.contains("speedwave-os"),
            "entrypoint.sh must NOT contain 'speedwave-os' — mcp-os goes through hub"
        );
    }

    #[test]
    fn test_entrypoint_no_mcp_os_env_vars() {
        // entrypoint.sh must not reference MCP_OS_URL or MCP_OS_AUTH_TOKEN.
        // These are no longer injected into the claude container.
        assert!(
            !ENTRYPOINT.contains("MCP_OS_URL"),
            "entrypoint.sh must NOT reference MCP_OS_URL"
        );
        assert!(
            !ENTRYPOINT.contains("MCP_OS_AUTH_TOKEN"),
            "entrypoint.sh must NOT reference MCP_OS_AUTH_TOKEN"
        );
    }

    #[test]
    fn test_mcp_os_config_skipped_when_no_token_file() {
        let tmp = tempfile::tempdir().unwrap();
        let nonexistent = tmp.path().join("no-such-token");
        let port_path = tmp.path().join("port");
        let result =
            apply_mcp_os_config_with_path(VALID_COMPOSE, &nonexistent, &port_path).unwrap();
        assert_eq!(
            result, VALID_COMPOSE,
            "yaml should be unchanged when token file is missing"
        );
    }

    #[test]
    fn test_mcp_os_config_skipped_when_token_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let token_path = tmp.path().join("empty-token");
        let port_path = tmp.path().join("port");
        std::fs::write(&token_path, "  \n").unwrap();
        let result = apply_mcp_os_config_with_path(VALID_COMPOSE, &token_path, &port_path).unwrap();
        assert_eq!(
            result, VALID_COMPOSE,
            "yaml should be unchanged when token is empty/whitespace"
        );
    }

    #[test]
    fn test_mcp_os_config_injects_when_token_exists() {
        use crate::host_mcp_process::lock::{self, LockFile, LockService};
        let tmp = tempfile::tempdir().unwrap();
        let token_path = tmp.path().join("mcp-os-auth-token");
        let lock_path = tmp.path().join(consts::MCP_OS_LOCK_FILE);
        std::fs::write(&token_path, "test-uuid-token-abc").unwrap();
        lock::write(
            &lock_path,
            &LockFile::new(
                LockService::McpOs,
                std::process::id(),
                54321,
                "test-uuid-token-abc".into(),
            ),
        )
        .unwrap();

        let result = apply_mcp_os_config_with_path(VALID_COMPOSE, &token_path, &lock_path).unwrap();

        assert!(
            result.contains("WORKER_OS_URL="),
            "WORKER_OS_URL must be injected when lock.json exists.\nGot:\n{}",
            result
        );
        assert!(
            result.contains(":54321"),
            "WORKER_OS_URL must use port from lock.json.\nGot:\n{}",
            result
        );

        let expected_mount = format!("{}:/secrets/os-auth-token:ro", token_path.display());
        assert!(
            result.contains(&expected_mount),
            "Token file must be mounted into hub.\nExpected: {}\nGot:\n{}",
            expected_mount,
            result
        );
    }

    #[test]
    fn test_mcp_os_config_skips_when_port_file_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let token_path = tmp.path().join("mcp-os-auth-token");
        let port_path = tmp.path().join("no-such-port-file");
        std::fs::write(&token_path, "test-uuid-token-abc").unwrap();
        // port_path does not exist — should return yaml unmodified

        let result = apply_mcp_os_config_with_path(VALID_COMPOSE, &token_path, &port_path).unwrap();

        assert!(
            !result.contains("WORKER_OS_URL"),
            "Should not inject WORKER_OS_URL when port file is missing.\nGot:\n{}",
            result
        );
    }

    #[test]
    fn test_mcp_os_config_skips_when_port_file_invalid() {
        let tmp = tempfile::tempdir().unwrap();
        let token_path = tmp.path().join("mcp-os-auth-token");
        let port_path = tmp.path().join("bad-port");
        std::fs::write(&token_path, "test-uuid-token-abc").unwrap();
        std::fs::write(&port_path, "not-a-number").unwrap();

        let result = apply_mcp_os_config_with_path(VALID_COMPOSE, &token_path, &port_path).unwrap();

        assert!(
            !result.contains("WORKER_OS_URL"),
            "Should not inject WORKER_OS_URL when port file has invalid content.\nGot:\n{}",
            result
        );
    }

    #[test]
    fn test_mcp_os_gateway_url_uses_gateway_not_bind_addr() {
        let port: u16 = 12345;
        let url = mcp_os_gateway_url(port);
        assert_eq!(
            url,
            format!("http://{}:{port}", consts::HOST_GATEWAY_ALIAS),
            "containers reach mcp-os via the canonical host gateway alias"
        );
        // URL must never contain 0.0.0.0 — that's the bind address, not a routable address
        assert!(
            !url.contains("0.0.0.0"),
            "mcp_os_gateway_url must not use 0.0.0.0 — containers can't route to it"
        );
    }

    #[test]
    fn test_mcp_os_config_injects_worker_url_into_hub() {
        let mut doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(VALID_COMPOSE).unwrap();
        let url = mcp_os_gateway_url(4007);
        inject_worker_env(&mut doc, "WORKER_OS_URL", &url);

        let hub = doc.get("services").unwrap().get("mcp-hub").unwrap();
        let env_seq = hub.get("environment").unwrap().as_sequence().unwrap();
        let has_os_url = env_seq
            .iter()
            .any(|v| v.as_str().is_some_and(|s| s.starts_with("WORKER_OS_URL=")));
        assert!(has_os_url, "WORKER_OS_URL should be in mcp-hub env");
    }

    #[test]
    fn test_mcp_os_config_mounts_token_file_into_hub() {
        // Auth token should be bind-mounted as /secrets/os-auth-token:ro
        // into the hub container, not passed as an env var.
        let mut doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(VALID_COMPOSE).unwrap();
        add_hub_volume(
            &mut doc,
            "/home/user/.speedwave/mcp-os-auth-token:/secrets/os-auth-token:ro",
        );

        let hub = doc.get("services").unwrap().get("mcp-hub").unwrap();
        let vols = hub.get("volumes").unwrap().as_sequence().unwrap();
        let has_token_mount = vols.iter().any(|v| {
            v.as_str()
                .is_some_and(|s| s.contains("/secrets/os-auth-token:ro"))
        });
        assert!(
            has_token_mount,
            "Token file should be mounted into mcp-hub as /secrets/os-auth-token:ro"
        );
    }

    #[test]
    fn test_mcp_os_config_skipped_when_token_is_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let token_path = tmp.path().join("mcp-os-auth-token");
        std::fs::create_dir(&token_path).unwrap();
        let port_path = tmp.path().join("mcp-os-port");

        let result = apply_mcp_os_config_with_path(VALID_COMPOSE, &token_path, &port_path).unwrap();
        assert_eq!(
            result, VALID_COMPOSE,
            "yaml should be unchanged when token path is a directory"
        );
    }

    #[test]
    fn test_mcp_os_config_skipped_when_token_path_does_not_exist() {
        // A missing mcp-os token file is treated as absent config; never abort render_compose with os error 2.
        let tmp = tempfile::tempdir().unwrap();
        let token_path = tmp.path().join("does-not-exist");
        let port_path = tmp.path().join("does-not-exist-port");

        let result = apply_mcp_os_config_with_path(VALID_COMPOSE, &token_path, &port_path).unwrap();
        assert_eq!(
            result, VALID_COMPOSE,
            "yaml should be unchanged when token file is absent"
        );
    }

    #[test]
    fn test_mcp_os_config_not_in_claude_env() {
        // MCP_OS_* env vars must NOT be in the claude container.
        // mcp-os is accessed through the hub, not directly by Claude.
        let mut doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(VALID_COMPOSE).unwrap();
        let url = mcp_os_gateway_url(4007);
        inject_worker_env(&mut doc, "WORKER_OS_URL", &url);

        let claude = doc.get("services").unwrap().get("claude").unwrap();
        let env_seq = claude.get("environment").unwrap().as_sequence().unwrap();
        let has_mcp_os = env_seq
            .iter()
            .any(|v| v.as_str().is_some_and(|s| s.contains("MCP_OS_")));
        assert!(!has_mcp_os, "MCP_OS_* must NOT be in claude container env");
    }

    // -- oauth compose wiring (ADR-060) --------------------------------------

    /// Compose fixture with a standard mcp-sharepoint service. Verifies `apply_oauth_config`
    /// injects WORKER_OAUTH_URL + per-service bearer mount into mcp-sharepoint ONLY.
    const VALID_COMPOSE_WITH_SHAREPOINT: &str = r#"
version: "3"
services:
  mcp-hub:
    image: speedwave-mcp-hub:latest
    environment:
      - PORT=4000
  mcp-sharepoint:
    image: speedwave-mcp-sharepoint:latest
    environment:
      - PORT=3000
    volumes:
      - /test/.speedwave/tokens/test/sharepoint:/tokens:ro
      - /test/project:/workspace:rw
"#;

    /// Compose fixture with multiple non-OAuth workers next to SharePoint, for the negative-injection
    /// test asserting `apply_oauth_config` does NOT touch services other than SharePoint.
    const VALID_COMPOSE_WITH_MULTIPLE_WORKERS: &str = r#"
version: "3"
services:
  mcp-hub:
    image: speedwave-mcp-hub:latest
    environment:
      - PORT=4000
  mcp-sharepoint:
    image: speedwave-mcp-sharepoint:latest
    environment:
      - PORT=3000
    volumes:
      - /test/.speedwave/tokens/test/sharepoint:/tokens:ro
      - /test/project:/workspace:rw
  mcp-slack:
    image: speedwave-mcp-slack:latest
    environment:
      - PORT=3001
    volumes:
      - /test/.speedwave/tokens/test/slack:/tokens:ro
      - /test/project:/workspace:rw
  mcp-redmine:
    image: speedwave-mcp-redmine:latest
    environment:
      - PORT=3002
    volumes:
      - /test/.speedwave/tokens/test/redmine:/tokens:ro
      - /test/project:/workspace:rw
"#;

    /// Write an oauth `lock.json` with THIS process's PID (guaranteed alive, so the liveness
    /// gate passes). Tests wanting a dead worker pass a bogus PID directly.
    fn write_live_oauth_lock(lock_path: &std::path::Path, port: u16) {
        crate::host_mcp_process::lock::write(
            lock_path,
            &crate::host_mcp_process::lock::LockFile::new(
                crate::host_mcp_process::lock::LockService::Oauth,
                std::process::id(),
                port,
                "supervisor".into(),
            ),
        )
        .unwrap();
    }

    #[test]
    fn test_oauth_config_skipped_when_port_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let result = apply_oauth_config_with_paths(
            VALID_COMPOSE_WITH_SHAREPOINT,
            tmp.path(),
            &tmp.path().join("no-port"),
            &tmp.path().join(".bearer-map.json"),
        )
        .unwrap();
        assert_eq!(
            result, VALID_COMPOSE_WITH_SHAREPOINT,
            "yaml unchanged when oauth worker is not running"
        );
    }

    #[test]
    fn test_oauth_config_skipped_when_bearer_map_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let lock_path = tmp.path().join(consts::PER_PROJECT_LOCK_FILE);
        write_live_oauth_lock(&lock_path, 49300);
        let result = apply_oauth_config_with_paths(
            VALID_COMPOSE_WITH_SHAREPOINT,
            tmp.path(),
            &lock_path,
            &tmp.path().join("no-bearer-map.json"),
        )
        .unwrap();
        assert_eq!(
            result, VALID_COMPOSE_WITH_SHAREPOINT,
            "yaml unchanged when bearer-map is missing"
        );
    }

    #[test]
    fn test_oauth_config_skipped_when_bearer_map_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let lock_path = tmp.path().join(consts::PER_PROJECT_LOCK_FILE);
        write_live_oauth_lock(&lock_path, 49300);
        let bearer_map_path = tmp.path().join(".bearer-map.json");
        std::fs::write(&bearer_map_path, "{}").unwrap();
        let result = apply_oauth_config_with_paths(
            VALID_COMPOSE_WITH_SHAREPOINT,
            tmp.path(),
            &lock_path,
            &bearer_map_path,
        )
        .unwrap();
        assert_eq!(
            result, VALID_COMPOSE_WITH_SHAREPOINT,
            "yaml unchanged when no consumer bearers are provisioned"
        );
    }

    #[test]
    fn test_oauth_config_injects_url_and_bearer_into_sharepoint_only() {
        let tmp = tempfile::tempdir().unwrap();
        let lock_path = tmp.path().join(consts::PER_PROJECT_LOCK_FILE);
        write_live_oauth_lock(&lock_path, 49301);
        let bearer_map_path = tmp.path().join(".bearer-map.json");
        std::fs::write(&bearer_map_path, r#"{"bearer-sp-uuid": "sharepoint"}"#).unwrap();

        let result = apply_oauth_config_with_paths(
            VALID_COMPOSE_WITH_SHAREPOINT,
            tmp.path(),
            &lock_path,
            &bearer_map_path,
        )
        .unwrap();

        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&result).unwrap();
        let services = doc.get("services").unwrap();

        // mcp-sharepoint gets WORKER_OAUTH_URL + per-service bearer mount.
        let sp_env = service_env(&doc, "mcp-sharepoint");
        let oauth_url = find_env_value(&sp_env, "WORKER_OAUTH_URL=")
            .expect("WORKER_OAUTH_URL must be injected into mcp-sharepoint");
        assert!(
            oauth_url.ends_with(":49301"),
            "URL must use port: {oauth_url}"
        );
        assert!(!oauth_url.contains("0.0.0.0"));

        // Per-service bearer mount on sharepoint
        let sp_vols: Vec<String> = services
            .get("mcp-sharepoint")
            .and_then(|s| s.get("volumes"))
            .and_then(|v| v.as_sequence())
            .map(|seq| {
                seq.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        assert!(
            sp_vols
                .iter()
                .any(|v| v.contains(":/secrets/oauth-auth-token-sharepoint:ro")),
            "per-service oauth bearer must be mounted into mcp-sharepoint, got: {sp_vols:?}"
        );

        // mcp-hub gets NOTHING about oauth.
        let hub_env = get_hub_env_seq(&doc);
        assert!(
            find_env_value(&hub_env, "WORKER_OAUTH_URL=").is_none(),
            "WORKER_OAUTH_URL must NOT be injected into mcp-hub"
        );
        let hub_vols: Vec<String> = services
            .get("mcp-hub")
            .and_then(|s| s.get("volumes"))
            .and_then(|v| v.as_sequence())
            .map(|seq| {
                seq.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        assert!(
            !hub_vols.iter().any(|v| v.contains("oauth-auth-token")),
            "oauth bearer must NOT be mounted into mcp-hub, got: {hub_vols:?}"
        );
    }

    #[test]
    fn test_oauth_config_injects_into_plugin_consumer() {
        // A plugin slug in the bearer-map gets WORKER_OAUTH_URL + bearer mount on its derived service (mcp-<slug>), no descriptor entry.
        let compose = r#"
services:
  mcp-hub:
    image: speedwave-mcp-hub:latest
  mcp-glpi:
    image: speedwave-mcp-glpi:latest
    environment:
      - PORT=3001
    volumes:
      - /test/.speedwave/tokens/test/glpi:/tokens:ro
"#;
        let tmp = tempfile::tempdir().unwrap();
        let lock_path = tmp.path().join(consts::PER_PROJECT_LOCK_FILE);
        write_live_oauth_lock(&lock_path, 49305);
        let bearer_map_path = tmp.path().join(".bearer-map.json");
        std::fs::write(&bearer_map_path, r#"{"bearer-glpi-uuid": "glpi"}"#).unwrap();

        let result =
            apply_oauth_config_with_paths(compose, tmp.path(), &lock_path, &bearer_map_path)
                .unwrap();
        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&result).unwrap();

        let env = service_env(&doc, "mcp-glpi");
        assert!(
            find_env_value(&env, "WORKER_OAUTH_URL=").is_some(),
            "plugin consumer must get WORKER_OAUTH_URL"
        );
        let vols: Vec<String> = doc
            .get("services")
            .and_then(|s| s.get("mcp-glpi"))
            .and_then(|s| s.get("volumes"))
            .and_then(|v| v.as_sequence())
            .map(|seq| {
                seq.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        assert!(
            vols.iter()
                .any(|v| v.contains(":/secrets/oauth-auth-token-glpi:ro")),
            "plugin consumer must get its bearer mount, got: {vols:?}"
        );
    }

    #[test]
    fn oauth_consumer_compose_name_resolves_builtin_and_plugin() {
        assert_eq!(oauth_consumer_compose_name("sharepoint"), "mcp-sharepoint");
        // Unknown id → plugin derivation.
        assert_eq!(oauth_consumer_compose_name("glpi"), "mcp-glpi");
    }

    fn oauth_plugin_manifest(slug: &str) -> crate::plugin::PluginManifest {
        let json = format!(
            r#"{{
                "name": "{slug}", "service_id": "{slug}", "slug": "{slug}",
                "version": "1.0.0", "description": "d",
                "auth_fields": [{{"key":"client_id","label":"id","field_type":"text","placeholder":"","is_secret":false,"oauth_flow":true}}],
                "oauth": {{"grant_type":"authorization_code","token_url":"https://idp/token","authorize_url":"https://idp/authorize","client_id_field":"client_id"}}
            }}"#
        );
        serde_json::from_str(&json).unwrap()
    }

    #[test]
    fn oauth_consumer_service_ids_includes_builtins_and_enabled_oauth_plugins() {
        let mut resolved = crate::config::ResolvedIntegrationsConfig {
            sharepoint: true,
            slack: true,
            ..Default::default()
        };
        resolved.plugins.insert("glpi".to_string(), true);
        resolved.plugins.insert("disabled-plug".to_string(), false);

        let plugins = vec![
            oauth_plugin_manifest("glpi"),
            oauth_plugin_manifest("disabled-plug"),
        ];
        let ids = oauth_consumer_service_ids(&resolved, &plugins);
        assert!(ids.contains(&"sharepoint".to_string()), "built-in included");
        assert!(
            ids.contains(&"slack".to_string()),
            "slack included when enabled (ADR-071)"
        );

        // State transition: toggling slack off removes it from the consumer set.
        let mut resolved_off = resolved.clone();
        resolved_off.slack = false;
        let ids_off = oauth_consumer_service_ids(&resolved_off, &plugins);
        assert!(!ids_off.contains(&"slack".to_string()));
        assert!(ids_off.contains(&"sharepoint".to_string()));
        assert!(
            ids.contains(&"glpi".to_string()),
            "enabled oauth plugin included"
        );
        assert!(
            !ids.contains(&"disabled-plug".to_string()),
            "disabled plugin excluded"
        );
    }

    #[test]
    fn oauth_consumer_service_ids_excludes_plugin_without_oauth() {
        let mut resolved = crate::config::ResolvedIntegrationsConfig::default();
        resolved.plugins.insert("plain".to_string(), true);
        // A plugin manifest with no oauth block, enabled.
        let plain: crate::plugin::PluginManifest = serde_json::from_str(
            r#"{"name":"plain","service_id":"plain","slug":"plain","version":"1.0.0","description":"d"}"#,
        )
        .unwrap();
        let ids = oauth_consumer_service_ids(&resolved, &[plain]);
        assert!(ids.is_empty(), "plugin without oauth is not a consumer");
    }

    #[test]
    fn host_worker_warnings_fire_only_when_workers_absent_and_needed() {
        let tmp = tempfile::tempdir().unwrap();
        let resolved = crate::config::ResolvedIntegrationsConfig {
            sharepoint: true,
            ..Default::default()
        };
        // OAuth consumer enabled, env missing → oauth warning.
        let w = host_worker_warnings(tmp.path(), "p", "services: {}", &resolved, &[]);
        assert_eq!(w.len(), 1);
        assert!(w[0].contains("sharepoint") && w[0].contains("refresh worker"));

        // Env injected → no oauth warning.
        let w = host_worker_warnings(tmp.path(), "p", "WORKER_OAUTH_URL=x", &resolved, &[]);
        assert!(w.is_empty());

        // No consumers enabled → silent even without the env.
        let none = crate::config::ResolvedIntegrationsConfig::default();
        assert!(host_worker_warnings(tmp.path(), "p", "services: {}", &none, &[]).is_empty());
    }

    #[test]
    fn host_worker_warnings_mcp_os_gated_on_token_file() {
        let tmp = tempfile::tempdir().unwrap();
        let none = crate::config::ResolvedIntegrationsConfig::default();
        // No token file (Desktop never ran) → silent.
        assert!(host_worker_warnings(tmp.path(), "p", "services: {}", &none, &[]).is_empty());
        // Token exists but env missing → mcp-os warning.
        std::fs::write(tmp.path().join(consts::MCP_OS_AUTH_TOKEN_FILE), "t").unwrap();
        let w = host_worker_warnings(tmp.path(), "p", "services: {}", &none, &[]);
        assert_eq!(w.len(), 1);
        assert!(w[0].contains("mcp-os"));
        // Env present → silent again.
        let w = host_worker_warnings(tmp.path(), "p", "WORKER_OS_URL=x", &none, &[]);
        assert!(w.is_empty());
    }

    #[test]
    fn test_oauth_config_writes_per_service_bearer_file() {
        let tmp = tempfile::tempdir().unwrap();
        let lock_path = tmp.path().join(consts::PER_PROJECT_LOCK_FILE);
        write_live_oauth_lock(&lock_path, 49301);
        let bearer_map_path = tmp.path().join(".bearer-map.json");
        std::fs::write(&bearer_map_path, r#"{"bearer-x": "sharepoint"}"#).unwrap();

        apply_oauth_config_with_paths(
            VALID_COMPOSE_WITH_SHAREPOINT,
            tmp.path(),
            &lock_path,
            &bearer_map_path,
        )
        .unwrap();

        let bearer_file = tmp.path().join("bearer-sharepoint");
        assert!(
            bearer_file.exists(),
            "per-service bearer file must be written"
        );
        let content = std::fs::read_to_string(&bearer_file).unwrap();
        assert_eq!(content, "bearer-x");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&bearer_file)
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600, "bearer file must be chmod 600");
        }
    }

    /// Negative-injection test: `apply_oauth_config` must NOT touch services other than SharePoint.
    #[test]
    fn test_oauth_config_injects_url_and_bearer_into_slack_consumer() {
        // ADR-071: slack consumes the host oauth worker exactly like sharepoint.
        let tmp = tempfile::tempdir().unwrap();
        let lock_path = tmp.path().join(consts::PER_PROJECT_LOCK_FILE);
        write_live_oauth_lock(&lock_path, 49302);
        let bearer_map_path = tmp.path().join(".bearer-map.json");
        std::fs::write(
            &bearer_map_path,
            r#"{"bearer-sl-uuid": "slack", "bearer-sp-uuid": "sharepoint"}"#,
        )
        .unwrap();

        let result = apply_oauth_config_with_paths(
            VALID_COMPOSE_WITH_MULTIPLE_WORKERS,
            tmp.path(),
            &lock_path,
            &bearer_map_path,
        )
        .unwrap();

        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&result).unwrap();
        let services = doc.get("services").unwrap();

        let slack_env = service_env(&doc, "mcp-slack");
        let oauth_url = find_env_value(&slack_env, "WORKER_OAUTH_URL=")
            .expect("WORKER_OAUTH_URL must be injected into mcp-slack");
        assert!(
            oauth_url.ends_with(":49302"),
            "URL must use port: {oauth_url}"
        );

        let slack_vols: Vec<String> = services
            .get("mcp-slack")
            .and_then(|s| s.get("volumes"))
            .and_then(|v| v.as_sequence())
            .map(|seq| {
                seq.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        assert!(
            slack_vols
                .iter()
                .any(|v| v.contains(":/secrets/oauth-auth-token-slack:ro")),
            "per-service oauth bearer must be mounted into mcp-slack, got: {slack_vols:?}"
        );

        // Redmine (never-OAuth) stays untouched even with consumers present.
        let rm_env = service_env(&doc, "mcp-redmine");
        assert!(find_env_value(&rm_env, "WORKER_OAUTH_URL=").is_none());
    }

    #[test]
    fn test_oauth_config_does_not_inject_into_unprovisioned_services() {
        let tmp = tempfile::tempdir().unwrap();
        let lock_path = tmp.path().join(consts::PER_PROJECT_LOCK_FILE);
        write_live_oauth_lock(&lock_path, 49301);
        let bearer_map_path = tmp.path().join(".bearer-map.json");
        std::fs::write(&bearer_map_path, r#"{"bearer-sp": "sharepoint"}"#).unwrap();

        let result = apply_oauth_config_with_paths(
            VALID_COMPOSE_WITH_MULTIPLE_WORKERS,
            tmp.path(),
            &lock_path,
            &bearer_map_path,
        )
        .unwrap();

        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&result).unwrap();

        // SharePoint receives the injection (sanity — same as the happy-path test).
        let sp_env = service_env(&doc, "mcp-sharepoint");
        assert!(
            find_env_value(&sp_env, "WORKER_OAUTH_URL=").is_some(),
            "WORKER_OAUTH_URL must be injected into mcp-sharepoint"
        );

        // Services absent from the bearer map MUST be untouched (no env, no mount). mcp-slack is an
        // OAuth consumer (ADR-071) but unprovisioned here; mcp-redmine never uses OAuth.
        for non_oauth_service in &["mcp-slack", "mcp-redmine", "mcp-hub"] {
            let env = service_env(&doc, non_oauth_service);
            assert!(
                find_env_value(&env, "WORKER_OAUTH_URL=").is_none(),
                "{non_oauth_service}: WORKER_OAUTH_URL must NOT be injected, env={env:?}"
            );

            let vols: Vec<String> = doc
                .get("services")
                .and_then(|s| s.get(non_oauth_service))
                .and_then(|s| s.get("volumes"))
                .and_then(|v| v.as_sequence())
                .map(|seq| {
                    seq.iter()
                        .filter_map(|v| v.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default();
            assert!(
                !vols.iter().any(|v| v.contains("oauth-auth-token")),
                "{non_oauth_service}: oauth bearer must NOT be mounted, vols={vols:?}"
            );
        }
    }

    /// Regression guard: a stale `lock.json` with a dead PID is treated as absent (no `WORKER_OAUTH_URL`).
    #[test]
    fn test_oauth_config_skipped_when_worker_pid_is_dead() {
        // Reap a real child so its PID is deterministically dead (not merely
        // "probably unused") — avoids the 999999-might-exist flakiness.
        let mut child = std::process::Command::new("true")
            .spawn()
            .or_else(|_| {
                std::process::Command::new("cmd")
                    .args(["/C", "exit"])
                    .spawn()
            })
            .expect("spawn a trivially-exiting child");
        let dead_pid = child.id();
        child.wait().expect("reap child");

        let tmp = tempfile::tempdir().unwrap();
        let lock_path = tmp.path().join(consts::PER_PROJECT_LOCK_FILE);
        crate::host_mcp_process::lock::write(
            &lock_path,
            &crate::host_mcp_process::lock::LockFile::new(
                crate::host_mcp_process::lock::LockService::Oauth,
                dead_pid,
                49301,
                "supervisor".into(),
            ),
        )
        .unwrap();
        let bearer_map_path = tmp.path().join(".bearer-map.json");
        std::fs::write(&bearer_map_path, r#"{"bearer-sp": "sharepoint"}"#).unwrap();

        let result = apply_oauth_config_with_paths(
            VALID_COMPOSE_WITH_SHAREPOINT,
            tmp.path(),
            &lock_path,
            &bearer_map_path,
        )
        .unwrap();
        assert_eq!(
            result, VALID_COMPOSE_WITH_SHAREPOINT,
            "stale lock with a dead PID must be treated as absent — no injection"
        );
    }

    /// Helper: read environment sequence for a given compose service name.
    fn service_env(doc: &serde_yaml_ng::Value, service_name: &str) -> Vec<String> {
        doc.get("services")
            .and_then(|s| s.get(service_name))
            .and_then(|s| s.get("environment"))
            .and_then(|e| e.as_sequence())
            .map(|seq| {
                seq.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default()
    }

    // ── read_lock_port legacy fallback ──────────────────────────────────

    #[test]
    fn test_read_lock_port_reads_lock_json_when_present() {
        use crate::host_mcp_process::lock::{self, LockFile, LockService};
        let tmp = tempfile::tempdir().unwrap();
        let lock_path = tmp.path().join("lock.json");
        lock::write(
            &lock_path,
            &LockFile::new(LockService::Oauth, 12345, 49215, "tok".into()),
        )
        .unwrap();

        assert_eq!(read_lock_port(&lock_path, LockService::Oauth), Some(49215));
    }

    #[test]
    fn test_read_lock_port_returns_none_when_lock_json_absent() {
        use crate::host_mcp_process::lock::LockService;
        let tmp = tempfile::tempdir().unwrap();
        let lock_path = tmp.path().join("lock.json"); // absent

        assert_eq!(read_lock_port(&lock_path, LockService::Oauth), None);
    }

    #[test]
    fn test_read_lock_port_returns_none_when_wrong_service_tag() {
        // `read` returns None if the JSON exists but `service` doesn't match
        // — defends against a lock file from a different worker getting picked up.
        use crate::host_mcp_process::lock::{self, LockFile, LockService};
        let tmp = tempfile::tempdir().unwrap();
        let lock_path = tmp.path().join("lock.json");
        lock::write(
            &lock_path,
            &LockFile::new(LockService::Oauth, 12345, 49215, "tok".into()),
        )
        .unwrap();

        assert_eq!(read_lock_port(&lock_path, LockService::McpOs), None);
    }

    #[test]
    fn test_security_check_mcp_os_auth_token_forbidden_in_claude() {
        let data_dir = tempfile::tempdir().unwrap();
        // MCP_OS_AUTH_TOKEN must now trigger a security violation in claude
        // container — it should never be injected there anymore.
        let yaml = r#"
version: "3"
services:
  claude:
    image: speedwave-claude:latest
    read_only: true
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp:noexec,nosuid,size=512m
    environment:
      - CLAUDE_VERSION=1.0.3
      - MCP_OS_AUTH_TOKEN=550e8400-e29b-41d4-a716-446655440000
"#;
        let violations = SecurityCheck::run_with_data_dir(
            yaml,
            "test",
            &[],
            &test_expected_paths(),
            data_dir.path(),
        );
        assert!(
            violations
                .iter()
                .any(|v| v.rule == SecurityRule::NoTokensClaude),
            "MCP_OS_AUTH_TOKEN should be FORBIDDEN in claude container"
        );
    }

    #[test]
    fn test_security_check_no_tokens_in_hub() {
        let data_dir = tempfile::tempdir().unwrap();
        // Hub env must not contain TOKEN/KEY/SECRET vars (except WORKER_*_URL).
        let yaml = r#"
version: "3"
services:
  mcp-hub:
    image: speedwave-mcp-hub:latest
    read_only: true
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp:noexec,nosuid,size=64m
    environment:
      - PORT=4000
      - WORKER_SLACK_URL=http://mcp-slack:3000
      - SLACK_TOKEN=xoxb-12345
"#;
        let violations = SecurityCheck::run_with_data_dir(
            yaml,
            "test",
            &[],
            &test_expected_paths(),
            data_dir.path(),
        );
        assert!(
            violations
                .iter()
                .any(|v| v.rule == SecurityRule::NoTokensHub && v.message.contains("SLACK_TOKEN")),
            "SLACK_TOKEN in hub env should trigger NO_TOKENS_HUB violation"
        );
    }

    #[test]
    fn test_security_check_hub_worker_urls_allowed() {
        let data_dir = tempfile::tempdir().unwrap();
        // WORKER_*_URL vars in hub env should pass the security check.
        let yaml = valid_compose_yaml();
        let violations = SecurityCheck::run_with_data_dir(
            &yaml,
            "test",
            &[],
            &test_expected_paths(),
            data_dir.path(),
        );
        assert!(
            !violations
                .iter()
                .any(|v| v.rule == SecurityRule::NoTokensHub),
            "WORKER_*_URL in hub env should NOT trigger NO_TOKENS_HUB"
        );
    }

    #[test]
    fn test_security_check_missing_user_field() {
        let data_dir = tempfile::tempdir().unwrap();
        let yaml = r#"
version: "3"
services:
  claude:
    image: speedwave-claude:latest
    read_only: true
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp:noexec,nosuid,size=512m
    environment:
      - CLAUDE_VERSION=1.0.3
"#;
        let violations = SecurityCheck::run_with_data_dir(
            yaml,
            "test",
            &[],
            &test_expected_paths(),
            data_dir.path(),
        );
        assert!(
            violations
                .iter()
                .any(|v| v.rule == SecurityRule::ContainerUser),
            "Should flag missing user field"
        );
    }

    #[test]
    fn test_security_check_wrong_user_value() {
        let data_dir = tempfile::tempdir().unwrap();
        let yaml = r#"
version: "3"
services:
  evil-addon:
    image: evil:latest
    user: "root"
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
"#
        .to_string();
        let violations = SecurityCheck::run_with_data_dir(
            &yaml,
            "test",
            &[],
            &test_expected_paths(),
            data_dir.path(),
        );
        assert!(
            violations
                .iter()
                .any(|v| v.rule == SecurityRule::ContainerUser && v.container == "evil-addon"),
            "Should flag wrong user value"
        );
    }

    #[test]
    fn test_security_check_correct_user_passes() {
        let data_dir = tempfile::tempdir().unwrap();
        let yaml = format!(
            r#"
version: "3"
services:
  my-addon:
    image: addon:latest
    user: "{user}"
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
"#,
            user = container_user()
        );
        let violations = SecurityCheck::run_with_data_dir(
            &yaml,
            "test",
            &[],
            &test_expected_paths(),
            data_dir.path(),
        );
        assert!(
            !violations
                .iter()
                .any(|v| v.rule == SecurityRule::ContainerUser),
            "Correct user should not trigger violation"
        );
    }

    #[test]
    fn test_add_hub_volume_creates_volumes_key() {
        // Hub in the template has no volumes. add_hub_volume must create
        // the volumes key if it doesn't exist.
        let mut doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(VALID_COMPOSE).unwrap();
        add_hub_volume(&mut doc, "/tmp/test-token:/secrets/os-auth-token:ro");

        let hub = doc.get("services").unwrap().get("mcp-hub").unwrap();
        let vols = hub.get("volumes").unwrap().as_sequence().unwrap();
        assert_eq!(vols.len(), 1);
        assert_eq!(
            vols[0].as_str().unwrap(),
            "/tmp/test-token:/secrets/os-auth-token:ro"
        );
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn test_render_compose_contains_ide_lock_mount() {
        let data_dir = tempfile::tempdir().unwrap();
        // render_compose substitutes ${IDE_LOCK_DIR} so claude mounts the ide-bridge dir as
        // /home/speedwave/.claude/ide:ro (container reads the lock file; the host writes it).
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: default_flags(),
            llm: configured_anthropic_llm(),
            ..Default::default()
        };
        let yaml = render_compose_isolated(
            data_dir.path(),
            "test-project",
            tmp_project_dir(),
            &config,
            &ResolvedIntegrationsConfig::default(),
            None,
            &HostBridgesInfo::default(),
        )
        .unwrap();
        assert!(
            yaml.contains("/home/speedwave/.claude/ide:ro"),
            "Rendered compose must contain ide-bridge mount: /home/speedwave/.claude/ide:ro\nGot:\n{}",
            yaml.lines()
                .filter(|l| l.contains("ide"))
                .collect::<Vec<_>>()
                .join("\n")
        );
    }

    #[test]
    fn test_compose_template_has_ide_lock_dir_placeholder() {
        // Guard: compose.template.yml must contain the ${IDE_LOCK_DIR} placeholder.
        assert!(
            COMPOSE_TEMPLATE.contains("${IDE_LOCK_DIR}"),
            "compose.template.yml must contain ${{IDE_LOCK_DIR}} placeholder"
        );
    }

    #[test]
    fn test_compose_template_has_host_gateway_placeholder() {
        assert!(
            COMPOSE_TEMPLATE.contains("${HOST_GATEWAY}"),
            "compose.template.yml must contain ${{HOST_GATEWAY}} placeholder for extra_hosts"
        );
    }

    #[test]
    fn test_container_user_returns_unprivileged_value() {
        assert_eq!(
            container_user(),
            "1000:1000",
            "macOS/Windows must use 1000:1000"
        );
    }

    #[test]
    fn test_compose_template_has_container_user_placeholder() {
        assert!(
            COMPOSE_TEMPLATE.contains("${CONTAINER_USER}"),
            "compose.template.yml must contain ${{CONTAINER_USER}} placeholder"
        );
        assert!(
            !COMPOSE_TEMPLATE.contains("user: \"1000:1000\""),
            "compose.template.yml must not contain hardcoded user: \"1000:1000\""
        );
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn test_render_compose_substitutes_container_user() {
        let data_dir = tempfile::tempdir().unwrap();
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: vec![],
            llm: configured_anthropic_llm(),
            ..Default::default()
        };
        let result = render_compose_isolated(
            data_dir.path(),
            "test-project",
            tmp_project_dir(),
            &config,
            &ResolvedIntegrationsConfig::default(),
            None,
            &HostBridgesInfo::default(),
        )
        .unwrap();
        assert!(
            !result.contains("${CONTAINER_USER}"),
            "render_compose must substitute ${{CONTAINER_USER}}"
        );
        // After serde_yaml_ng roundtrip, the user field is parsed into a
        // service mapping. Verify via structured parse instead of string matching.
        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&result).unwrap();
        let claude_user = doc
            .get("services")
            .and_then(|s| s.get("claude"))
            .and_then(|c| c.get("user"))
            .and_then(|u| u.as_str())
            .expect("claude service must have user field");
        assert_eq!(claude_user, container_user());
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn test_render_compose_injects_bundled_plugins_from_ssot() {
        let data_dir = tempfile::tempdir().unwrap();
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: vec![],
            llm: configured_anthropic_llm(),
            ..Default::default()
        };
        let yaml = render_compose_isolated(
            data_dir.path(),
            "test-project",
            tmp_project_dir(),
            &config,
            &ResolvedIntegrationsConfig::default(),
            None,
            &HostBridgesInfo::default(),
        )
        .unwrap();
        assert!(
            !yaml.contains("${BUNDLED_PLUGINS}") && !yaml.contains("${BUNDLED_PLUGIN_MARKETPLACE}"),
            "render must substitute the bundled-plugin placeholders"
        );
        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&yaml).unwrap();
        let env_seq = doc["services"]["claude"]["environment"]
            .as_sequence()
            .expect("claude.environment must be a sequence");
        let plugins_entry = env_seq
            .iter()
            .filter_map(|v| v.as_str())
            .find(|s| s.starts_with("SPEEDWAVE_BUNDLED_PLUGINS="))
            .expect("SPEEDWAVE_BUNDLED_PLUGINS entry present");
        assert_eq!(
            plugins_entry,
            format!(
                "SPEEDWAVE_BUNDLED_PLUGINS={}",
                defaults::BUNDLED_PLUGINS.join(",")
            ),
            "env must carry the SSOT plugin list"
        );
        let mp_entry = env_seq
            .iter()
            .filter_map(|v| v.as_str())
            .find(|s| s.starts_with("SPEEDWAVE_BUNDLED_PLUGIN_MARKETPLACE="))
            .expect("marketplace entry present");
        assert_eq!(
            mp_entry,
            format!(
                "SPEEDWAVE_BUNDLED_PLUGIN_MARKETPLACE={}",
                defaults::BUNDLED_PLUGIN_MARKETPLACE
            )
        );
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn test_render_compose_substitutes_host_gateway() {
        let data_dir = tempfile::tempdir().unwrap();
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: vec![],
            llm: configured_anthropic_llm(),
            ..Default::default()
        };
        let result = render_compose_isolated(
            data_dir.path(),
            "test-project",
            tmp_project_dir(),
            &config,
            &ResolvedIntegrationsConfig::default(),
            None,
            &HostBridgesInfo::default(),
        )
        .unwrap();
        assert!(
            !result.contains("${HOST_GATEWAY}"),
            "render_compose must substitute ${{HOST_GATEWAY}}"
        );
        // Must contain a valid IP (not the placeholder)
        let expected_ip = host_gateway_ip().expect("test");
        assert!(
            result.contains(&expected_ip),
            "rendered compose must contain host gateway IP {expected_ip}"
        );
    }

    #[test]
    fn test_compose_template_has_ide_host_override_placeholder() {
        assert!(
            COMPOSE_TEMPLATE.contains("${IDE_HOST_OVERRIDE}"),
            "compose.template.yml must contain ${{IDE_HOST_OVERRIDE}} placeholder"
        );
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn test_render_compose_substitutes_ide_host_override() {
        let data_dir = tempfile::tempdir().unwrap();
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: vec![],
            llm: configured_anthropic_llm(),
            ..Default::default()
        };
        let result = render_compose_isolated(
            data_dir.path(),
            "test-project",
            tmp_project_dir(),
            &config,
            &ResolvedIntegrationsConfig::default(),
            None,
            &HostBridgesInfo::default(),
        )
        .unwrap();
        assert!(
            !result.contains("${IDE_HOST_OVERRIDE}"),
            "render_compose must substitute ${{IDE_HOST_OVERRIDE}}"
        );
        let expected = ide_host_override();
        assert!(
            result.contains(&format!("CLAUDE_CODE_IDE_HOST_OVERRIDE={expected}")),
            "rendered compose must contain CLAUDE_CODE_IDE_HOST_OVERRIDE={expected}"
        );
    }

    #[test]
    fn test_ide_host_override_uses_gateway_hostname() {
        // CLAUDE_CODE_IDE_HOST_OVERRIDE must use the canonical host gateway alias
        // — same as worker_gateway_url, resolvable from inside the VM via extra_hosts.
        let host = ide_host_override();
        assert!(
            !host.contains("127.0.0.1"),
            "IDE host override must NOT be 127.0.0.1 — that's the container loopback"
        );
        assert!(
            !host.contains("0.0.0.0"),
            "IDE host override must NOT be 0.0.0.0"
        );
        assert_eq!(host, consts::HOST_GATEWAY_ALIAS);
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn test_claude_env_has_ide_host_override() {
        let data_dir = tempfile::tempdir().unwrap();
        // CLAUDE_CODE_IDE_HOST_OVERRIDE must be in the claude service environment.
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: default_flags(),
            llm: configured_anthropic_llm(),
            ..Default::default()
        };
        let yaml = render_compose_isolated(
            data_dir.path(),
            "test-project",
            tmp_project_dir(),
            &config,
            &ResolvedIntegrationsConfig::default(),
            None,
            &HostBridgesInfo::default(),
        )
        .unwrap();
        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&yaml).unwrap();

        let claude_env = doc
            .get("services")
            .and_then(|s| s.get("claude"))
            .and_then(|c| c.get("environment"))
            .and_then(|e| e.as_sequence())
            .expect("claude service must have environment");

        let has_override = claude_env.iter().any(|v| {
            v.as_str()
                .is_some_and(|s| s.starts_with("CLAUDE_CODE_IDE_HOST_OVERRIDE="))
        });
        assert!(
            has_override,
            "CLAUDE_CODE_IDE_HOST_OVERRIDE must be in claude service environment"
        );
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn test_claude_env_has_no_flicker() {
        let data_dir = tempfile::tempdir().unwrap();
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: default_flags(),
            llm: configured_anthropic_llm(),
            ..Default::default()
        };
        let yaml = render_compose_isolated(
            data_dir.path(),
            "test-project",
            tmp_project_dir(),
            &config,
            &ResolvedIntegrationsConfig::default(),
            None,
            &HostBridgesInfo::default(),
        )
        .unwrap();
        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&yaml).unwrap();

        let claude_env = doc
            .get("services")
            .and_then(|s| s.get("claude"))
            .and_then(|c| c.get("environment"))
            .and_then(|e| e.as_sequence())
            .expect("claude service must have environment");

        let has_no_flicker = claude_env
            .iter()
            .any(|v| v.as_str() == Some("CLAUDE_CODE_NO_FLICKER=1"));
        assert!(
            has_no_flicker,
            "CLAUDE_CODE_NO_FLICKER=1 must be in claude service environment \
             (mitigates PTY backpressure by reducing ANSI frame size — see issue #451)"
        );
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn test_claude_env_has_no_effort_level() {
        let data_dir = tempfile::tempdir().unwrap();
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: default_flags(),
            llm: configured_anthropic_llm(),
            ..Default::default()
        };
        let yaml = render_compose_isolated(
            data_dir.path(),
            "test-project",
            tmp_project_dir(),
            &config,
            &ResolvedIntegrationsConfig::default(),
            None,
            &HostBridgesInfo::default(),
        )
        .unwrap();
        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&yaml).unwrap();

        let claude_env = doc
            .get("services")
            .and_then(|s| s.get("claude"))
            .and_then(|c| c.get("environment"))
            .and_then(|e| e.as_sequence())
            .expect("claude service must have environment");

        // Speedwave must NOT pin effort: a CLAUDE_CODE_EFFORT_LEVEL env var
        // outranks the user's in-session /effort and settings.json (ADR-017).
        let has_effort_level = claude_env.iter().any(|v| {
            v.as_str()
                .is_some_and(|s| s.starts_with("CLAUDE_CODE_EFFORT_LEVEL"))
        });
        assert!(
            !has_effort_level,
            "CLAUDE_CODE_EFFORT_LEVEL must NOT be in claude service environment — it would block the user's /effort"
        );

        // Auto-connect to the Speedwave IDE Bridge on start (no manual /ide pick). Value is the
        // string `true` (not 1) per the Claude Code env-vars reference.
        let has_auto_connect = claude_env
            .iter()
            .any(|v| v.as_str() == Some("CLAUDE_CODE_AUTO_CONNECT_IDE=true"));
        assert!(
            has_auto_connect,
            "CLAUDE_CODE_AUTO_CONNECT_IDE=true must be in claude service environment"
        );
    }

    #[test]
    fn test_security_no_ports_on_each_worker() {
        let data_dir = tempfile::tempdir().unwrap();
        for name in [
            "claude",
            "mcp-hub",
            "mcp-slack",
            "mcp-sharepoint",
            "mcp-redmine",
            "mcp-gitlab",
        ] {
            let yaml = format!(
                r#"
version: "3"
services:
  {name}:
    image: test:latest
    read_only: true
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    tmpfs: ["/tmp:noexec,nosuid,size=64m"]
    ports:
      - "127.0.0.1:4000:4000"
"#
            );
            let violations = SecurityCheck::run_with_data_dir(
                &yaml,
                "test",
                &[],
                &test_expected_paths(),
                data_dir.path(),
            );
            assert!(
                violations
                    .iter()
                    .any(|v| v.rule == SecurityRule::NoPortsWorkers),
                "{name} with ports should trigger NO_PORTS_WORKERS"
            );
        }
    }

    #[test]
    fn test_security_worker_without_ports_passes() {
        let data_dir = tempfile::tempdir().unwrap();
        let yaml = r#"
version: "3"
services:
  mcp-slack:
    image: speedwave-mcp-slack:latest
    read_only: true
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    tmpfs: ["/tmp:noexec,nosuid,size=64m"]
    environment:
      - PORT=3000
"#;
        let violations = SecurityCheck::run_with_data_dir(
            yaml,
            "test",
            &[],
            &test_expected_paths(),
            data_dir.path(),
        );
        assert!(
            !violations
                .iter()
                .any(|v| v.rule == SecurityRule::NoPortsWorkers),
            "Worker without ports should pass"
        );
    }

    #[test]
    fn test_internal_only_covers_all_template_services() {
        // Self-enforcing: parse compose.template.yml and verify every built-in
        // service (claude + mcp-*) is listed in consts::BUILT_IN_SERVICES.
        let doc: serde_yaml_ng::Value =
            serde_yaml_ng::from_str(COMPOSE_TEMPLATE).expect("compose template must be valid YAML");
        let services = get_services(&doc).expect("compose template must have services");

        for (name, _) in &services {
            assert!(
                consts::BUILT_IN_SERVICES.contains(&name.as_str()),
                "Service '{}' in compose.template.yml is not listed in consts::BUILT_IN_SERVICES. \
                 If this is a new built-in service, add it to consts::BUILT_IN_SERVICES. \
                 If it's an addon placeholder, this test needs updating.",
                name
            );
        }
    }

    #[test]
    fn test_security_addon_service_ports_allowed() {
        let data_dir = tempfile::tempdir().unwrap();
        let yaml = r#"
version: "3"
services:
  mcp-example-plugin:
    image: speedwave-mcp-example-plugin:latest
    read_only: true
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    tmpfs: ["/tmp:noexec,nosuid,size=64m"]
    ports:
      - "127.0.0.1:4006:4006"
"#;
        let violations = SecurityCheck::run_with_data_dir(
            yaml,
            "test",
            &[],
            &test_expected_paths(),
            data_dir.path(),
        );
        assert!(
            !violations
                .iter()
                .any(|v| v.rule == SecurityRule::NoPortsWorkers),
            "Addon services may expose ports (they are not in consts::BUILT_IN_SERVICES)"
        );
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn test_render_compose_rejects_invalid_project_name() {
        let data_dir = tempfile::tempdir().unwrap();
        let resolved = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: default_flags(),
            llm: LlmConfig::default(),
            ..Default::default()
        };
        let integrations = ResolvedIntegrationsConfig::default();
        assert!(render_compose_isolated(
            data_dir.path(),
            "",
            "/tmp/proj",
            &resolved,
            &integrations,
            None,
            &HostBridgesInfo::default()
        )
        .is_err());
        assert!(render_compose_isolated(
            data_dir.path(),
            "../evil",
            "/tmp/proj",
            &resolved,
            &integrations,
            None,
            &HostBridgesInfo::default()
        )
        .is_err());
        assert!(render_compose_isolated(
            data_dir.path(),
            &"a".repeat(64),
            "/tmp/proj",
            &resolved,
            &integrations,
            None,
            &HostBridgesInfo::default()
        )
        .is_err());
    }

    #[test]
    fn test_init_secrets_dir_rejects_invalid_name() {
        let data_dir = tempfile::tempdir().unwrap();
        assert!(init_secrets_dir_in(data_dir.path(), "").is_err());
        assert!(init_secrets_dir_in(data_dir.path(), "../evil").is_err());
        assert!(init_secrets_dir_in(data_dir.path(), &"a".repeat(64)).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn test_init_secrets_dir_secures_parent_directory() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path();

        let original_mode = std::fs::metadata(data_dir).unwrap().permissions().mode() & 0o777;

        let secrets_dir = init_secrets_dir_in(data_dir, "proj").unwrap();

        assert_eq!(
            std::fs::metadata(&secrets_dir)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700,
            "secrets/<project> should be 0o700"
        );
        assert_eq!(
            std::fs::metadata(data_dir.join("secrets"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700,
            "secrets/ parent should be 0o700"
        );
        assert_eq!(
            std::fs::metadata(data_dir).unwrap().permissions().mode() & 0o777,
            original_mode,
            "data_dir itself should not have been changed"
        );
    }

    #[test]
    fn test_compose_output_path_rejects_invalid_name() {
        let data_dir = tempfile::tempdir().unwrap();
        assert!(compose_output_path_in(data_dir.path(), "").is_err());
        assert!(compose_output_path_in(data_dir.path(), "../evil").is_err());
        assert!(compose_output_path_in(data_dir.path(), &"a".repeat(64)).is_err());
    }

    #[test]
    fn test_integrations_filter_removes_disabled_service() {
        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(VALID_COMPOSE).unwrap();

        // Verify mcp-slack exists before filtering
        let services = doc.get("services").unwrap().as_mapping().unwrap();
        assert!(services.contains_key(serde_yaml_ng::Value::String("mcp-slack".into())));

        // Disable slack
        let integrations = ResolvedIntegrationsConfig {
            slack: false,
            ..Default::default()
        };

        let yaml = serde_yaml_ng::to_string(&doc).unwrap();
        let filtered =
            apply_integrations_filter(&yaml, &integrations, "speedwave_test_network").unwrap();

        let filtered_doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&filtered).unwrap();
        let filtered_services = filtered_doc.get("services").unwrap().as_mapping().unwrap();

        // mcp-slack should be removed
        assert!(!filtered_services.contains_key(serde_yaml_ng::Value::String("mcp-slack".into())));
        // claude and mcp-hub must remain
        assert!(filtered_services.contains_key(serde_yaml_ng::Value::String("claude".into())));
        assert!(filtered_services.contains_key(serde_yaml_ng::Value::String("mcp-hub".into())));
    }

    #[test]
    fn test_integrations_filter_removes_worker_url_from_hub() {
        let integrations = ResolvedIntegrationsConfig {
            gitlab: false,
            ..Default::default()
        };

        let filtered =
            apply_integrations_filter(VALID_COMPOSE, &integrations, "speedwave_test_network")
                .unwrap();
        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&filtered).unwrap();

        // Check hub environment does not contain WORKER_GITLAB_URL
        let hub_env = doc
            .get("services")
            .and_then(|s| s.get("mcp-hub"))
            .and_then(|h| h.get("environment"))
            .and_then(|e| e.as_sequence())
            .unwrap();

        let has_gitlab_url = hub_env.iter().any(|v| {
            v.as_str()
                .map(|s| s.starts_with("WORKER_GITLAB_URL="))
                .unwrap_or(false)
        });
        assert!(
            !has_gitlab_url,
            "WORKER_GITLAB_URL should be removed from hub env"
        );
    }

    #[test]
    fn test_integrations_filter_injects_enabled_services() {
        let integrations = ResolvedIntegrationsConfig {
            slack: true,
            sharepoint: true,
            gitlab: true,
            os_calendar: true,
            ..Default::default()
        };

        let filtered =
            apply_integrations_filter(VALID_COMPOSE, &integrations, "speedwave_test_network")
                .unwrap();
        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&filtered).unwrap();
        let env = get_hub_env_seq(&doc);
        let enabled_var =
            find_env_value(&env, "ENABLED_SERVICES=").expect("ENABLED_SERVICES should be injected");

        assert!(enabled_var.contains("slack"));
        assert!(enabled_var.contains("sharepoint"));
        assert!(enabled_var.contains("gitlab"));
        assert!(!enabled_var.contains("redmine"));
        assert!(enabled_var.contains("os"));
    }

    #[test]
    fn test_enabled_hub_service_ids() {
        let default_ids = enabled_hub_service_ids(&ResolvedIntegrationsConfig::default());
        assert!(default_ids.is_empty());

        let mut cfg = ResolvedIntegrationsConfig {
            slack: true,
            gitlab: true,
            os_calendar: true,
            ..ResolvedIntegrationsConfig::default()
        };
        cfg.plugins.insert("example-plugin".to_string(), true);
        cfg.plugins.insert("disabled-one".to_string(), false);
        let ids = enabled_hub_service_ids(&cfg);
        assert!(ids.contains(&"slack".to_string()));
        assert!(ids.contains(&"gitlab".to_string()));
        assert!(ids.contains(&"os".to_string()));
        assert!(ids.contains(&"example-plugin".to_string()));
        assert!(!ids.contains(&"redmine".to_string()));
        assert!(!ids.contains(&"disabled-one".to_string()));
        assert!(!ids.contains(&"claude".to_string()));
        assert!(!ids.contains(&"mcp-hub".to_string()));
    }

    #[test]
    fn test_integrations_filter_all_disabled_keeps_claude_and_hub() {
        let integrations = ResolvedIntegrationsConfig::default();

        let filtered =
            apply_integrations_filter(VALID_COMPOSE, &integrations, "speedwave_test_network")
                .unwrap();
        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&filtered).unwrap();
        let services = doc.get("services").unwrap().as_mapping().unwrap();

        assert!(services.contains_key(serde_yaml_ng::Value::String("claude".into())));
        assert!(services.contains_key(serde_yaml_ng::Value::String("mcp-hub".into())));
        // No MCP worker services should remain
        assert!(!services.contains_key(serde_yaml_ng::Value::String("mcp-slack".into())));
    }

    #[test]
    fn test_integrations_filter_disabled_os_services_injected() {
        let integrations = ResolvedIntegrationsConfig {
            os_calendar: true,
            os_notes: true,
            ..Default::default()
        };
        // reminders and mail remain false (default)

        let filtered =
            apply_integrations_filter(VALID_COMPOSE, &integrations, "speedwave_test_network")
                .unwrap();
        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&filtered).unwrap();
        let env = get_hub_env_seq(&doc);
        let disabled_os_var = find_env_value(&env, "DISABLED_OS_SERVICES=")
            .expect("DISABLED_OS_SERVICES should be injected");

        assert!(disabled_os_var.contains("reminders"));
        assert!(disabled_os_var.contains("mail"));
        assert!(!disabled_os_var.contains("calendar"));
        assert!(!disabled_os_var.contains("notes"));
    }

    #[test]
    fn test_integrations_filter_no_disabled_os_when_all_os_enabled() {
        let integrations = ResolvedIntegrationsConfig {
            os_reminders: true,
            os_calendar: true,
            os_mail: true,
            os_notes: true,
            ..Default::default()
        };

        let filtered =
            apply_integrations_filter(VALID_COMPOSE, &integrations, "speedwave_test_network")
                .unwrap();
        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&filtered).unwrap();
        let env = get_hub_env_seq(&doc);

        assert!(
            find_env_value(&env, "DISABLED_OS_SERVICES=").is_none(),
            "DISABLED_OS_SERVICES should not be present when all OS integrations enabled"
        );
    }

    #[test]
    fn test_integrations_filter_office_enabled_keeps_service_and_office_network() {
        let mut integrations = all_enabled_integrations();
        integrations.office = true;
        let filtered = apply_integrations_filter(
            VALID_COMPOSE_ALL_WORKERS,
            &integrations,
            "speedwave_test_network",
        )
        .unwrap();
        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&filtered).unwrap();

        let services = doc.get("services").unwrap().as_mapping().unwrap();
        assert!(services.contains_key(serde_yaml_ng::Value::String("mcp-office".into())));
        let office_nets: Vec<&str> = services
            .get(serde_yaml_ng::Value::String("mcp-office".into()))
            .and_then(|s| s.get("networks"))
            .and_then(|n| n.as_sequence())
            .map(|seq| seq.iter().filter_map(|v| v.as_str()).collect())
            .unwrap_or_default();
        assert_eq!(office_nets, vec!["speedwave_test_network_office"]);
        let hub_nets: Vec<&str> = services
            .get(serde_yaml_ng::Value::String("mcp-hub".into()))
            .and_then(|s| s.get("networks"))
            .and_then(|n| n.as_sequence())
            .map(|seq| seq.iter().filter_map(|v| v.as_str()).collect())
            .unwrap_or_default();
        assert!(hub_nets.contains(&"speedwave_test_network"));
        assert!(hub_nets.contains(&"speedwave_test_network_office"));
        assert!(doc
            .get("networks")
            .and_then(|n| n.get("speedwave_test_network_office"))
            .is_some());
        let env = get_hub_env_seq(&doc);
        assert!(env.iter().any(|e| e.starts_with("WORKER_OFFICE_URL=")));
    }

    #[test]
    fn test_integrations_filter_office_disabled_removes_service_and_office_network() {
        let mut integrations = all_enabled_integrations();
        integrations.office = false;
        let filtered = apply_integrations_filter(
            VALID_COMPOSE_ALL_WORKERS,
            &integrations,
            "speedwave_test_network",
        )
        .unwrap();
        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&filtered).unwrap();

        let services = doc.get("services").unwrap().as_mapping().unwrap();
        assert!(!services.contains_key(serde_yaml_ng::Value::String("mcp-office".into())));
        assert!(doc
            .get("networks")
            .and_then(|n| n.get("speedwave_test_network_office"))
            .is_none());
        let hub_nets: Vec<&str> = services
            .get(serde_yaml_ng::Value::String("mcp-hub".into()))
            .and_then(|s| s.get("networks"))
            .and_then(|n| n.as_sequence())
            .map(|seq| seq.iter().filter_map(|v| v.as_str()).collect())
            .unwrap_or_default();
        assert_eq!(hub_nets, vec!["speedwave_test_network"]);
        let env = get_hub_env_seq(&doc);
        assert!(!env.iter().any(|e| e.starts_with("WORKER_OFFICE_URL=")));
        let enabled = find_env_value(&env, "ENABLED_SERVICES=").unwrap_or_default();
        assert!(!enabled.split(',').any(|s| s == "office"));
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn test_render_compose_with_mixed_enabled_disabled_end_to_end() {
        let data_dir = tempfile::tempdir().unwrap();
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: default_flags(),
            llm: configured_anthropic_llm(),
            ..Default::default()
        };
        let integrations = ResolvedIntegrationsConfig {
            sharepoint: true,
            gitlab: true,
            github: true,
            os_calendar: true,
            ..Default::default()
        };
        // slack, redmine remain disabled (default)
        // os_reminders, os_mail, os_notes remain disabled (default)

        let result = render_compose_isolated(
            data_dir.path(),
            "test-e2e",
            tmp_project_dir(),
            &config,
            &integrations,
            None,
            &HostBridgesInfo::default(),
        );
        // CodeQL: avoid {result:?} — anyhow chain may carry apply_oauth_config
        // / init_secrets_dir traces. See project.rs:700.
        let yaml = result.expect("render_compose should succeed in test env");

        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&yaml).unwrap();
        let services = doc.get("services").unwrap().as_mapping().unwrap();

        // mcp-slack should be removed (disabled by default)
        assert!(
            !services.contains_key(serde_yaml_ng::Value::String("mcp-slack".into())),
            "mcp-slack should be removed when slack is disabled"
        );

        // claude and mcp-hub must still be present
        assert!(services.contains_key(serde_yaml_ng::Value::String("claude".into())));
        assert!(services.contains_key(serde_yaml_ng::Value::String("mcp-hub".into())));

        // Enabled services should be present
        assert!(services.contains_key(serde_yaml_ng::Value::String("mcp-sharepoint".into())));
        assert!(services.contains_key(serde_yaml_ng::Value::String("mcp-gitlab".into())));
        assert!(services.contains_key(serde_yaml_ng::Value::String("mcp-github".into())));

        // ENABLED_SERVICES should be in hub env
        let env = get_hub_env_seq(&doc);
        let enabled_str = find_env_value(&env, "ENABLED_SERVICES=")
            .expect("ENABLED_SERVICES should be in hub env");

        assert!(
            !enabled_str.contains("slack"),
            "ENABLED_SERVICES should not contain 'slack'"
        );
        assert!(
            enabled_str.contains("sharepoint"),
            "ENABLED_SERVICES should contain 'sharepoint'"
        );
        assert!(
            enabled_str.contains("gitlab"),
            "ENABLED_SERVICES should contain 'gitlab'"
        );
        assert!(
            enabled_str.contains("github"),
            "ENABLED_SERVICES should contain 'github'"
        );
        assert!(
            enabled_str.contains("os"),
            "ENABLED_SERVICES should contain 'os' (calendar is enabled)"
        );

        // DISABLED_OS_SERVICES should contain reminders, mail, notes (only calendar enabled)
        let disabled_os_str = find_env_value(&env, "DISABLED_OS_SERVICES=")
            .expect("DISABLED_OS_SERVICES should be in hub env");

        assert!(disabled_os_str.contains("reminders"));
        assert!(disabled_os_str.contains("mail"));
        assert!(disabled_os_str.contains("notes"));
        assert!(!disabled_os_str.contains("calendar"));
    }

    #[test]
    fn test_all_disabled_removes_all_mcp_services() {
        let integrations = ResolvedIntegrationsConfig::default(); // all false

        let filtered =
            apply_integrations_filter(VALID_COMPOSE, &integrations, "speedwave_test_network")
                .unwrap();
        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&filtered).unwrap();
        let services = doc.get("services").unwrap().as_mapping().unwrap();

        // No MCP worker services should remain
        assert!(!services.contains_key(serde_yaml_ng::Value::String("mcp-slack".into())));
        assert!(
            !services.contains_key(serde_yaml_ng::Value::String("mcp-sharepoint".into()))
                || !VALID_COMPOSE.contains("mcp-sharepoint")
        );

        // claude and mcp-hub must remain
        assert!(services.contains_key(serde_yaml_ng::Value::String("claude".into())));
        assert!(services.contains_key(serde_yaml_ng::Value::String("mcp-hub".into())));

        let env = get_hub_env_seq(&doc);

        // ENABLED_SERVICES should be empty string
        let enabled_var =
            find_env_value(&env, "ENABLED_SERVICES=").expect("ENABLED_SERVICES should be injected");
        assert!(
            enabled_var.is_empty(),
            "ENABLED_SERVICES should be empty when all integrations disabled, got: '{}'",
            enabled_var
        );

        // claude must also receive ENABLED_SERVICES (even empty) so entrypoint links zero integrations.
        let claude_env_seq = get_service_env_seq(&doc, "claude");
        assert!(
            !claude_env_seq.is_empty(),
            "claude.environment must be present"
        );
        let claude_enabled_var = find_env_value(&claude_env_seq, "ENABLED_SERVICES=")
            .expect("ENABLED_SERVICES must be injected into the claude container");
        assert!(
            claude_enabled_var.is_empty(),
            "claude ENABLED_SERVICES should be empty when all integrations disabled, got: '{}'",
            claude_enabled_var
        );

        // All WORKER_*_URL vars should be removed from hub env
        let has_worker_url = env
            .iter()
            .any(|s| s.starts_with("WORKER_") && s.contains("_URL="));
        assert!(
            !has_worker_url,
            "All WORKER_*_URL vars should be removed when all integrations disabled"
        );

        // DISABLED_OS_SERVICES should contain all 4 categories
        let disabled_os_var = find_env_value(&env, "DISABLED_OS_SERVICES=")
            .expect("DISABLED_OS_SERVICES should be injected");
        assert!(disabled_os_var.contains("reminders"));
        assert!(disabled_os_var.contains("calendar"));
        assert!(disabled_os_var.contains("mail"));
        assert!(disabled_os_var.contains("notes"));
    }

    #[test]
    fn test_all_disabled_passes_security_check() {
        let integrations = ResolvedIntegrationsConfig::default(); // all false
        let yaml = valid_compose_yaml();
        let filtered =
            apply_integrations_filter(&yaml, &integrations, "speedwave_test_network").unwrap();
        let tmp = tempfile::tempdir().unwrap();
        let violations = SecurityCheck::run_with_data_dir(
            &filtered,
            "test",
            &[],
            &test_expected_paths(),
            tmp.path(),
        );
        assert!(
            violations.is_empty(),
            "All-disabled compose should pass security check. Violations: {:?}",
            violations
                .iter()
                .map(|v| format!("{}", v))
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn test_single_enabled_keeps_only_that_service() {
        let integrations = ResolvedIntegrationsConfig {
            slack: true,
            ..Default::default()
        };

        let filtered =
            apply_integrations_filter(VALID_COMPOSE, &integrations, "speedwave_test_network")
                .unwrap();
        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&filtered).unwrap();
        let services = doc.get("services").unwrap().as_mapping().unwrap();

        // mcp-slack should remain
        assert!(services.contains_key(serde_yaml_ng::Value::String("mcp-slack".into())));

        // Other MCP services in VALID_COMPOSE should be gone (only mcp-slack was in template)
        // claude and mcp-hub must remain
        assert!(services.contains_key(serde_yaml_ng::Value::String("claude".into())));
        assert!(services.contains_key(serde_yaml_ng::Value::String("mcp-hub".into())));

        let env = get_hub_env_seq(&doc);

        // ENABLED_SERVICES should be "slack"
        let enabled_var =
            find_env_value(&env, "ENABLED_SERVICES=").expect("ENABLED_SERVICES should be injected");
        assert_eq!(
            enabled_var, "slack",
            "ENABLED_SERVICES should be 'slack' only, got: '{}'",
            enabled_var
        );

        // Only WORKER_SLACK_URL should remain in hub env
        let worker_urls: Vec<String> = env
            .iter()
            .filter(|s| s.starts_with("WORKER_") && s.contains("_URL="))
            .cloned()
            .collect();

        assert_eq!(
            worker_urls.len(),
            1,
            "Only WORKER_SLACK_URL should remain, got: {:?}",
            worker_urls
        );
        assert!(worker_urls[0].starts_with("WORKER_SLACK_URL="));
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn test_render_compose_all_services_have_container_user() {
        let data_dir = tempfile::tempdir().unwrap();
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: vec![],
            llm: configured_anthropic_llm(),
            ..Default::default()
        };
        // Enable all integrations so no services are filtered out
        let integrations = ResolvedIntegrationsConfig {
            slack: true,
            sharepoint: true,
            redmine: true,
            gitlab: true,
            github: true,
            atlassian: true,
            office: true,
            playwright: true,
            context7: true,
            ..ResolvedIntegrationsConfig::default()
        };
        let result = render_compose_isolated(
            data_dir.path(),
            "test-project",
            tmp_project_dir(),
            &config,
            &integrations,
            None,
            &HostBridgesInfo::default(),
        )
        .unwrap();
        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&result).unwrap();
        let expected = container_user();

        for service_name in crate::consts::BUILT_IN_SERVICES {
            let user = doc
                .get("services")
                .and_then(|s| s.get(service_name))
                .and_then(|c| c.get("user"))
                .and_then(|u| u.as_str());
            assert_eq!(
                user,
                Some(expected),
                "Service '{}' must have user: \"{}\"",
                service_name,
                expected
            );
        }
    }

    // ── Plugin SecurityCheck tests ───────────────────────────────────────

    #[test]
    fn test_security_check_plugin_no_privileged() {
        let data_dir = tempfile::tempdir().unwrap();
        let yaml = format!(
            r#"
version: "3"
services:
  mcp-example-plugin:
    image: speedwave-mcp-example-plugin:1.0.0
    user: "{user}"
    privileged: true
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    labels:
      speedwave.plugin-service: "true"
"#,
            user = container_user()
        );
        let violations = SecurityCheck::run_with_data_dir(
            &yaml,
            "test",
            &[],
            &test_expected_paths(),
            data_dir.path(),
        );
        assert!(
            violations
                .iter()
                .any(|v| v.rule == SecurityRule::PluginNoPrivileged
                    && v.container == "mcp-example-plugin"),
            "Plugin with privileged: true should trigger PLUGIN_NO_PRIVILEGED"
        );
    }

    #[test]
    fn test_security_check_plugin_no_host_network() {
        let data_dir = tempfile::tempdir().unwrap();
        let yaml = format!(
            r#"
version: "3"
services:
  mcp-example-plugin:
    image: speedwave-mcp-example-plugin:1.0.0
    user: "{user}"
    network_mode: host
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    labels:
      speedwave.plugin-service: "true"
"#,
            user = container_user()
        );
        let violations = SecurityCheck::run_with_data_dir(
            &yaml,
            "test",
            &[],
            &test_expected_paths(),
            data_dir.path(),
        );
        assert!(
            violations
                .iter()
                .any(|v| v.rule == SecurityRule::PluginNoHostNetwork
                    && v.container == "mcp-example-plugin"),
            "Plugin with network_mode: host should trigger PLUGIN_NO_HOST_NETWORK"
        );
    }

    fn test_example_plugin_manifest(token_mount: plugin::TokenMount) -> PluginManifest {
        PluginManifest {
            name: "Example Plugin".to_string(),
            service_id: Some("example-plugin".to_string()),
            slug: "example-plugin".to_string(),
            version: "1.0.0".to_string(),
            description: "test".to_string(),
            port: Some(4010),
            image_tag: None,
            resources: vec![],
            token_mount,
            auth_fields: vec![],
            settings_schema: None,
            speedwave_compat: None,
            extra_env: None,
            mem_limit: None,
            cpu_limit: None,
            requires_integrations: vec![],
            host_bridge: None,
            instructions: None,
            oauth: None,
        }
    }

    /// Expected paths for plugin security tests. Token dir = /test/.speedwave/tokens/test.
    fn test_expected_paths() -> SecurityExpectedPaths {
        SecurityExpectedPaths::from_raw("/test/project", "/test/.speedwave/tokens/test")
    }

    /// Speedwave proxy service YAML with parameterised volumes (ADR-073 tests).
    fn proxy_yaml(volumes: &str, extra: &str) -> String {
        format!(
            r#"
version: "3"
services:
  proxy:
    image: proxy:1.0.0
    user: "{user}"
    read_only: true
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp:noexec,nosuid,size=64m
    volumes:
{volumes}
{extra}
"#,
            user = container_user(),
        )
    }

    #[test]
    fn test_security_proxy_canonical_mounts_pass() {
        let data_dir = tempfile::tempdir().unwrap();
        let yaml = proxy_yaml(
            "      - /test/.speedwave/proxy/test:/config:ro\n      \
             - /test/.speedwave/tokens/test/llm:/tokens:ro\n      \
             - /test/.speedwave/usage/test/proxy:/usage:rw",
            "",
        );
        let violations = SecurityCheck::run_with_data_dir(
            &yaml,
            "test",
            &[],
            &test_expected_paths(),
            data_dir.path(),
        );
        assert!(
            !violations
                .iter()
                .any(|v| v.rule == SecurityRule::SpeedwaveProxyVolumes),
            "canonical proxy mounts must pass, got: {violations:?}"
        );
    }

    #[test]
    fn test_security_proxy_rejects_writable_tokens_and_extra_mounts() {
        let data_dir = tempfile::tempdir().unwrap();
        // tokens :rw + an extra workspace mount → both flagged.
        let yaml = proxy_yaml(
            "      - /test/.speedwave/proxy/test:/config:ro\n      \
             - /test/.speedwave/tokens/test/llm:/tokens:rw\n      \
             - /test/.speedwave/usage/test/proxy:/usage:rw\n      \
             - /test/project:/workspace:rw",
            "",
        );
        let violations = SecurityCheck::run_with_data_dir(
            &yaml,
            "test",
            &[],
            &test_expected_paths(),
            data_dir.path(),
        );
        let proxy: Vec<_> = violations
            .iter()
            .filter(|v| v.rule == SecurityRule::SpeedwaveProxyVolumes)
            .collect();
        assert!(
            proxy.iter().any(|v| v.message.contains("/tokens")),
            "rw tokens mount must be flagged: {proxy:?}"
        );
        assert!(
            proxy.iter().any(|v| v.message.contains("unexpected")),
            "extra workspace mount must be flagged: {proxy:?}"
        );
    }

    #[test]
    fn test_security_proxy_rejects_foreign_tokens_namespace_and_host_network() {
        let data_dir = tempfile::tempdir().unwrap();
        // Whole tokens dir (all services!) instead of the llm namespace +
        // host networking → both flagged.
        let yaml = proxy_yaml(
            "      - /test/.speedwave/proxy/test:/config:ro\n      \
             - /test/.speedwave/tokens/test:/tokens:ro\n      \
             - /test/.speedwave/usage/test/proxy:/usage:rw",
            "    network_mode: host",
        );
        let violations = SecurityCheck::run_with_data_dir(
            &yaml,
            "test",
            &[],
            &test_expected_paths(),
            data_dir.path(),
        );
        let proxy: Vec<_> = violations
            .iter()
            .filter(|v| v.rule == SecurityRule::SpeedwaveProxyVolumes)
            .collect();
        assert!(
            proxy.iter().any(|v| v.message.contains("llm namespace")),
            "whole-tokens-dir mount must be flagged: {proxy:?}"
        );
        assert!(
            proxy.iter().any(|v| v.message.contains("network_mode")),
            "host network must be flagged: {proxy:?}"
        );
    }

    /// YAML with the renamed `proxy` service name and a writable
    /// tokens mount (the forbidden case the gate must catch).
    fn proxy_yaml_with_writable_tokens() -> String {
        format!(
            r#"
version: "3"
services:
  proxy:
    image: proxy:1.0.0
    user: "{user}"
    read_only: true
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp:noexec,nosuid,size=64m
    volumes:
      - /test/.speedwave/proxy/test:/config:ro
      - /test/.speedwave/tokens/test/llm:/tokens:rw
      - /test/.speedwave/usage/test/proxy:/usage:rw
"#,
            user = container_user(),
        )
    }

    /// Regression guard: the mount-hardening gate must find the proxy by its renamed name.
    /// If security_check.rs still keys on `"litellm"`, the early-return silently disables it.
    #[test]
    fn security_gate_fires_on_renamed_proxy_service() {
        let yaml = proxy_yaml_with_writable_tokens();
        let data_dir = tempfile::tempdir().unwrap();
        let violations = SecurityCheck::run_with_data_dir(
            &yaml,
            "test",
            &[],
            &test_expected_paths(),
            data_dir.path(),
        );
        assert!(
            violations
                .iter()
                .any(|v| v.rule == SecurityRule::SpeedwaveProxyVolumes),
            "renamed proxy service must still trip the mount-hardening gate, got {violations:?}"
        );
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn test_security_proxy_full_render_passes() {
        // The real rendered compose must satisfy the proxy profile checks
        // (read_only/tmpfs/no-ports come from the shared core rules).
        let data_dir = tempfile::tempdir().unwrap();
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: default_flags(),
            llm: configured_anthropic_llm(),
            ..Default::default()
        };
        let yaml = render_compose_isolated(
            data_dir.path(),
            "test-project",
            tmp_project_dir(),
            &config,
            &ResolvedIntegrationsConfig::default(),
            None,
            &HostBridgesInfo::default(),
        )
        .unwrap();
        let tokens_dir = data_dir.path().join("tokens").join("test-project");
        let expected =
            SecurityExpectedPaths::from_raw(tmp_project_dir(), &tokens_dir.to_string_lossy());
        let violations = SecurityCheck::run_with_data_dir(
            &yaml,
            "test-project",
            &[],
            &expected,
            data_dir.path(),
        );
        let proxy: Vec<_> = violations
            .iter()
            .filter(|v| v.container == "proxy" || v.rule == SecurityRule::SpeedwaveProxyVolumes)
            .collect();
        assert!(
            proxy.is_empty(),
            "rendered proxy service must pass all checks: {proxy:?}"
        );
    }

    /// Standard valid plugin YAML fragment with correct token + workspace mounts.
    fn valid_plugin_yaml(token_mode: &str) -> String {
        format!(
            r#"
version: "3"
services:
  mcp-example-plugin:
    image: speedwave-mcp-example-plugin:1.0.0
    user: "{user}"
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp:noexec,nosuid,size=64m
    volumes:
      - /test/.speedwave/tokens/test/example-plugin:/tokens:{token_mode}
      - /test/project:/workspace:rw
    labels:
      speedwave.plugin-service: "true"
"#,
            user = container_user(),
            token_mode = token_mode,
        )
    }

    #[test]
    fn test_security_check_plugin_no_extra_volumes() {
        let data_dir = tempfile::tempdir().unwrap();
        let yaml = format!(
            r#"
version: "3"
services:
  mcp-example-plugin:
    image: speedwave-mcp-example-plugin:1.0.0
    user: "{user}"
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    volumes:
      - /test/.speedwave/tokens/test/example-plugin:/tokens:ro
      - /test/project:/workspace:rw
      - /etc/passwd:/etc/passwd:ro
    labels:
      speedwave.plugin-service: "true"
"#,
            user = container_user()
        );
        let manifests = vec![test_example_plugin_manifest(plugin::TokenMount::ReadOnly)];
        let violations = SecurityCheck::run_with_data_dir(
            &yaml,
            "test",
            &manifests,
            &test_expected_paths(),
            data_dir.path(),
        );
        assert!(
            violations
                .iter()
                .any(|v| v.rule == SecurityRule::PluginNoExtraVolumes
                    && v.container == "mcp-example-plugin"),
            "Plugin with extra volumes should trigger PLUGIN_NO_EXTRA_VOLUMES"
        );
    }

    #[test]
    fn test_security_check_plugin_no_extra_volumes_clean() {
        let data_dir = tempfile::tempdir().unwrap();
        let yaml = valid_plugin_yaml("ro");
        let manifests = vec![test_example_plugin_manifest(plugin::TokenMount::ReadOnly)];
        let violations = SecurityCheck::run_with_data_dir(
            &yaml,
            "test",
            &manifests,
            &test_expected_paths(),
            data_dir.path(),
        );
        assert!(
            !violations
                .iter()
                .any(|v| v.rule == SecurityRule::PluginNoExtraVolumes),
            "Plugin with only /tokens + /workspace should not trigger PLUGIN_NO_EXTRA_VOLUMES"
        );
    }

    /// A plugin yaml with the oauth bearer mount the host injects for consumers.
    fn oauth_consumer_plugin_yaml() -> String {
        format!(
            r#"
version: "3"
services:
  mcp-example-plugin:
    image: speedwave-mcp-example-plugin:1.0.0
    user: "{user}"
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp:noexec,nosuid,size=64m
    volumes:
      - /test/.speedwave/tokens/test/example-plugin:/tokens:ro
      - /test/project:/workspace:rw
      - /test/.speedwave/oauth/test/bearer-example-plugin:/secrets/oauth-auth-token-example-plugin:ro
    labels:
      speedwave.plugin-service: "true"
"#,
            user = container_user(),
        )
    }

    #[test]
    fn test_security_check_oauth_plugin_allows_bearer_mount() {
        let data_dir = tempfile::tempdir().unwrap();
        let yaml = oauth_consumer_plugin_yaml();
        let mut manifest = test_example_plugin_manifest(plugin::TokenMount::ReadOnly);
        manifest.oauth = oauth_plugin_manifest("example-plugin").oauth;
        let violations = SecurityCheck::run_with_data_dir(
            &yaml,
            "test",
            &[manifest],
            &test_expected_paths(),
            data_dir.path(),
        );
        assert!(
            !violations
                .iter()
                .any(|v| v.rule == SecurityRule::PluginNoExtraVolumes),
            "OAuth plugin's bearer mount must be allowed, got: {violations:?}"
        );
    }

    #[test]
    fn test_security_check_non_oauth_plugin_rejects_bearer_mount() {
        let data_dir = tempfile::tempdir().unwrap();
        let yaml = oauth_consumer_plugin_yaml();
        // Manifest has NO oauth block — the bearer mount must NOT be allowed.
        let manifest = test_example_plugin_manifest(plugin::TokenMount::ReadOnly);
        let violations = SecurityCheck::run_with_data_dir(
            &yaml,
            "test",
            &[manifest],
            &test_expected_paths(),
            data_dir.path(),
        );
        assert!(
            violations
                .iter()
                .any(|v| v.rule == SecurityRule::PluginNoExtraVolumes),
            "a non-oauth plugin with a bearer mount must trigger PLUGIN_NO_EXTRA_VOLUMES"
        );
    }

    #[test]
    fn test_security_check_plugin_token_mount_mode_ro_violation() {
        let data_dir = tempfile::tempdir().unwrap();
        let yaml = valid_plugin_yaml("rw");
        let manifests = vec![test_example_plugin_manifest(plugin::TokenMount::ReadOnly)];
        let violations = SecurityCheck::run_with_data_dir(
            &yaml,
            "test",
            &manifests,
            &test_expected_paths(),
            data_dir.path(),
        );
        assert!(
            violations
                .iter()
                .any(|v| v.rule == SecurityRule::PluginTokenMountMode
                    && v.container == "mcp-example-plugin"),
            "ReadOnly manifest + :rw mount should trigger PLUGIN_TOKEN_MOUNT_MODE"
        );
    }

    #[test]
    fn test_security_check_plugin_token_mount_mode_rw_pass() {
        let data_dir = tempfile::tempdir().unwrap();
        let yaml = valid_plugin_yaml("rw");
        let manifests = vec![test_example_plugin_manifest(
            plugin::TokenMount::ReadWrite {
                justification: "OAuth token refresh".to_string(),
            },
        )];
        let violations = SecurityCheck::run_with_data_dir(
            &yaml,
            "test",
            &manifests,
            &test_expected_paths(),
            data_dir.path(),
        );
        assert!(
            !violations
                .iter()
                .any(|v| v.rule == SecurityRule::PluginTokenMountMode),
            "ReadWrite manifest + :rw mount should NOT trigger PLUGIN_TOKEN_MOUNT_MODE"
        );
    }

    #[test]
    fn test_security_check_plugin_workspace_path_mismatch() {
        let data_dir = tempfile::tempdir().unwrap();
        let yaml = format!(
            r#"
version: "3"
services:
  mcp-example-plugin:
    image: speedwave-mcp-example-plugin:1.0.0
    user: "{user}"
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp:noexec,nosuid,size=64m
    volumes:
      - /test/.speedwave/tokens/test/example-plugin:/tokens:ro
      - /etc:/workspace:rw
    labels:
      speedwave.plugin-service: "true"
"#,
            user = container_user()
        );
        let manifests = vec![test_example_plugin_manifest(plugin::TokenMount::ReadOnly)];
        let violations = SecurityCheck::run_with_data_dir(
            &yaml,
            "test",
            &manifests,
            &test_expected_paths(),
            data_dir.path(),
        );
        assert!(
            violations
                .iter()
                .any(|v| v.rule == SecurityRule::PluginWorkspacePathMismatch),
            "Wrong workspace host path should trigger PLUGIN_WORKSPACE_PATH_MISMATCH"
        );
    }

    #[test]
    fn test_security_check_plugin_workspace_mount_mode_ro() {
        let data_dir = tempfile::tempdir().unwrap();
        let yaml = format!(
            r#"
version: "3"
services:
  mcp-example-plugin:
    image: speedwave-mcp-example-plugin:1.0.0
    user: "{user}"
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp:noexec,nosuid,size=64m
    volumes:
      - /test/.speedwave/tokens/test/example-plugin:/tokens:ro
      - /test/project:/workspace:ro
    labels:
      speedwave.plugin-service: "true"
"#,
            user = container_user()
        );
        let manifests = vec![test_example_plugin_manifest(plugin::TokenMount::ReadOnly)];
        let violations = SecurityCheck::run_with_data_dir(
            &yaml,
            "test",
            &manifests,
            &test_expected_paths(),
            data_dir.path(),
        );
        assert!(
            violations
                .iter()
                .any(|v| v.rule == SecurityRule::PluginWorkspaceMountMode),
            "Workspace mount with :ro should trigger PLUGIN_WORKSPACE_MOUNT_MODE"
        );
    }

    #[test]
    fn test_security_check_plugin_token_path_mismatch() {
        let data_dir = tempfile::tempdir().unwrap();
        let yaml = format!(
            r#"
version: "3"
services:
  mcp-example-plugin:
    image: speedwave-mcp-example-plugin:1.0.0
    user: "{user}"
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp:noexec,nosuid,size=64m
    volumes:
      - /etc:/tokens:ro
      - /test/project:/workspace:rw
    labels:
      speedwave.plugin-service: "true"
"#,
            user = container_user()
        );
        let manifests = vec![test_example_plugin_manifest(plugin::TokenMount::ReadOnly)];
        let violations = SecurityCheck::run_with_data_dir(
            &yaml,
            "test",
            &manifests,
            &test_expected_paths(),
            data_dir.path(),
        );
        assert!(
            violations
                .iter()
                .any(|v| v.rule == SecurityRule::PluginTokenPathMismatch),
            "Wrong token host path should trigger PLUGIN_TOKEN_PATH_MISMATCH"
        );
    }

    #[test]
    fn test_security_check_plugin_volume_long_form() {
        let data_dir = tempfile::tempdir().unwrap();
        let yaml = format!(
            r#"
version: "3"
services:
  mcp-example-plugin:
    image: speedwave-mcp-example-plugin:1.0.0
    user: "{user}"
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp:noexec,nosuid,size=64m
    volumes:
      - type: bind
        source: /test/.speedwave/tokens/test/example-plugin
        target: /tokens
    labels:
      speedwave.plugin-service: "true"
"#,
            user = container_user()
        );
        let manifests = vec![test_example_plugin_manifest(plugin::TokenMount::ReadOnly)];
        let violations = SecurityCheck::run_with_data_dir(
            &yaml,
            "test",
            &manifests,
            &test_expected_paths(),
            data_dir.path(),
        );
        assert!(
            violations
                .iter()
                .any(|v| v.rule == SecurityRule::PluginVolumeLongForm),
            "Long-form YAML volume should trigger PLUGIN_VOLUME_LONG_FORM"
        );
    }

    #[test]
    fn test_security_check_plugin_manifest_missing() {
        let data_dir = tempfile::tempdir().unwrap();
        let yaml = valid_plugin_yaml("ro");
        // Pass empty manifests — should detect missing manifest
        let violations = SecurityCheck::run_with_data_dir(
            &yaml,
            "test",
            &[],
            &test_expected_paths(),
            data_dir.path(),
        );
        assert!(
            violations
                .iter()
                .any(|v| v.rule == SecurityRule::PluginManifestMissing),
            "Plugin without matching manifest should trigger PLUGIN_MANIFEST_MISSING"
        );
    }

    // ── apply_plugins integration tests (via individual pieces) ──────────

    #[test]
    fn test_apply_plugins_enabled_in_compose() {
        // Test that generate_plugin_service creates a valid service and it can be
        // inserted into compose YAML, simulating what apply_plugins does.
        let manifest = PluginManifest {
            name: "Example Plugin".to_string(),
            service_id: Some("example-plugin".to_string()),
            slug: "example-plugin".to_string(),
            version: "1.0.0".to_string(),
            description: "test".to_string(),
            port: Some(4010),
            image_tag: None,
            resources: vec![],
            token_mount: plugin::TokenMount::ReadOnly,
            auth_fields: vec![],
            settings_schema: None,
            speedwave_compat: None,
            extra_env: None,
            mem_limit: None,
            cpu_limit: None,
            requires_integrations: vec![],
            host_bridge: None,
            instructions: None,
            oauth: None,
        };

        let tokens_dir = std::path::PathBuf::from("/home/user/.speedwave/tokens/test");
        let service_value = plugin::generate_plugin_service(
            &manifest,
            "f00ddeadbeefcafe0123456789abcdef",
            Path::new("/nonexistent/plugins/example-plugin"),
            "test",
            "speedwave_test_network",
            &tokens_dir,
            tmp_project_dir(),
        )
        .unwrap();

        // Insert into valid compose (simulating apply_plugins behavior)
        let mut doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(VALID_COMPOSE).unwrap();
        if let Some(services) = doc.get_mut("services").and_then(|v| v.as_mapping_mut()) {
            services.insert(
                serde_yaml_ng::Value::String("mcp-example-plugin".to_string()),
                service_value,
            );
        }

        // Verify the service appears
        let services = doc.get("services").unwrap().as_mapping().unwrap();
        assert!(
            services.contains_key(serde_yaml_ng::Value::String("mcp-example-plugin".into())),
            "Enabled plugin service mcp-example-plugin should appear in compose"
        );
    }

    #[test]
    fn test_plugin_service_has_pull_policy_never() {
        let manifest = PluginManifest {
            name: "Test".to_string(),
            service_id: Some("test-svc".to_string()),
            slug: "test-svc".to_string(),
            version: "1.0.0".to_string(),
            description: "test".to_string(),
            port: Some(4099),
            image_tag: None,
            resources: vec![],
            token_mount: plugin::TokenMount::ReadOnly,
            auth_fields: vec![],
            settings_schema: None,
            speedwave_compat: None,
            extra_env: None,
            mem_limit: None,
            cpu_limit: None,
            requires_integrations: vec![],
            host_bridge: None,
            instructions: None,
            oauth: None,
        };
        let svc = plugin::generate_plugin_service(
            &manifest,
            "f00ddeadbeefcafe0123456789abcdef",
            Path::new("/nonexistent/plugins/test-svc"),
            "proj",
            "net",
            std::path::Path::new("/tokens/proj"),
            tmp_project_dir(),
        )
        .unwrap();
        let policy = svc
            .get("pull_policy")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        assert_eq!(
            policy, "never",
            "Plugin services must have `pull_policy: never` (images are built locally)"
        );
    }

    #[test]
    fn test_apply_plugins_disabled_excluded() {
        // A plugin NOT enabled in integrations must not appear: apply_plugins checks
        // is_plugin_enabled(sid) and skips when false. Simulated by not inserting into compose.
        let integrations = ResolvedIntegrationsConfig::default(); // plugins map is empty
        assert!(
            !integrations.is_plugin_enabled("example-plugin"),
            "example-plugin should not be enabled by default"
        );

        // Verify the compose YAML does not contain the plugin service
        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(VALID_COMPOSE).unwrap();
        let services = doc.get("services").unwrap().as_mapping().unwrap();
        assert!(
            !services.contains_key(serde_yaml_ng::Value::String("mcp-example-plugin".into())),
            "Disabled plugin service should NOT appear in compose"
        );
    }

    #[test]
    fn test_apply_plugins_worker_url_injected() {
        // Simulate apply_plugins injecting WORKER_EXAMPLE_PLUGIN_URL into mcp-hub
        let mut doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(VALID_COMPOSE).unwrap();
        let worker_env = plugin::derive_worker_env("example-plugin");
        let url = "http://mcp-example-plugin:4010".to_string();
        inject_worker_env(&mut doc, &worker_env, &url);

        let env = get_hub_env_seq(&doc);
        assert!(
            env.iter()
                .any(|s| s == "WORKER_EXAMPLE_PLUGIN_URL=http://mcp-example-plugin:4010"),
            "WORKER_EXAMPLE_PLUGIN_URL should be injected into mcp-hub. Got: {:?}",
            env
        );
    }

    #[test]
    fn test_apply_plugins_speedwave_plugins_env() {
        // Simulate apply_plugins setting SPEEDWAVE_PLUGINS in claude container
        let mut doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(VALID_COMPOSE).unwrap();
        let slugs = ["example-plugin".to_string(), "analytics".to_string()];
        add_claude_env_var(&mut doc, "SPEEDWAVE_PLUGINS", &slugs.join(","));

        let claude = doc.get("services").unwrap().get("claude").unwrap();
        let env_seq = claude.get("environment").unwrap().as_sequence().unwrap();
        let has_plugins = env_seq.iter().any(|v| {
            v.as_str()
                .is_some_and(|s| s == "SPEEDWAVE_PLUGINS=example-plugin,analytics")
        });
        assert!(
            has_plugins,
            "SPEEDWAVE_PLUGINS should be set on claude with comma-separated slugs"
        );
    }

    #[test]
    fn test_apply_plugins_token_mount_path() {
        // Verify the token mount path format generated by generate_plugin_service
        let manifest = PluginManifest {
            name: "Example Plugin".to_string(),
            service_id: Some("example-plugin".to_string()),
            slug: "example-plugin".to_string(),
            version: "1.0.0".to_string(),
            description: "test".to_string(),
            port: Some(4010),
            image_tag: None,
            resources: vec![],
            token_mount: plugin::TokenMount::ReadOnly,
            auth_fields: vec![],
            settings_schema: None,
            speedwave_compat: None,
            extra_env: None,
            mem_limit: None,
            cpu_limit: None,
            requires_integrations: vec![],
            host_bridge: None,
            instructions: None,
            oauth: None,
        };

        let tokens_dir = std::path::PathBuf::from("/home/user/.speedwave/tokens/myproject");
        let service_value = plugin::generate_plugin_service(
            &manifest,
            "f00ddeadbeefcafe0123456789abcdef",
            Path::new("/nonexistent/plugins/example-plugin"),
            "myproject",
            "speedwave_myproject_network",
            &tokens_dir,
            tmp_project_dir(),
        )
        .unwrap();

        let yaml = serde_yaml_ng::to_string(&service_value).unwrap();
        // Token mount should be tokens_dir/service_id:/tokens:ro
        assert!(
            yaml.contains("/home/user/.speedwave/tokens/myproject/example-plugin:/tokens:ro"),
            "Token mount should be <tokens_dir>/<service_id>:/tokens:<mode>. Got:\n{}",
            yaml
        );
    }

    // ── extract_volume_for_target tests ─────────────────────────────────

    #[test]
    fn test_extract_volume_for_target_with_mode() {
        let result = extract_volume_for_target("/path/to/host:/tokens:ro", "/tokens");
        assert_eq!(
            result,
            Some(("/path/to/host".to_string(), Some("ro".to_string())))
        );
    }

    #[test]
    fn test_extract_volume_for_target_without_mode() {
        let result = extract_volume_for_target("/path/to/host:/tokens", "/tokens");
        assert_eq!(result, Some(("/path/to/host".to_string(), None)));
    }

    #[test]
    fn test_extract_volume_for_target_no_match() {
        let result = extract_volume_for_target("/path:/other:ro", "/tokens");
        assert_eq!(result, None);
    }

    #[test]
    fn test_extract_volume_for_target_workspace_mount() {
        let result = extract_volume_for_target("/project:/workspace:rw", "/workspace");
        assert_eq!(
            result,
            Some(("/project".to_string(), Some("rw".to_string())))
        );
    }

    // ── SharePoint built-in security tests ──────────────────────────────

    #[test]
    fn test_security_check_sharepoint_correct_mounts_pass() {
        let data_dir = tempfile::tempdir().unwrap();
        // ADR-060: SharePoint tokens mount is :ro (refresh delegated to the host-side `oauth`
        // worker). The legacy :rw mount is now a violation — see ..._sharepoint_rw_now_violates.
        let yaml = format!(
            r#"
version: "3"
services:
  mcp-sharepoint:
    image: speedwave-mcp-sharepoint:latest
    user: "{user}"
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp:noexec,nosuid,size=64m
    volumes:
      - /test/.speedwave/tokens/test/sharepoint:/tokens:ro
      - /test/project:/workspace:rw
"#,
            user = container_user()
        );
        let paths = test_expected_paths();
        let violations =
            SecurityCheck::run_with_data_dir(&yaml, "test", &[], &paths, data_dir.path());
        let sp_violations: Vec<_> = violations
            .iter()
            .filter(|v| v.rule.is_sharepoint())
            .collect();
        assert!(
            sp_violations.is_empty(),
            "Correct SharePoint mounts should not trigger violations, got: {:?}",
            sp_violations.iter().map(|v| &v.rule).collect::<Vec<_>>()
        );
    }

    #[test]
    fn test_security_check_sharepoint_with_oauth_bearer_mount_passes() {
        let data_dir = tempfile::tempdir().unwrap();
        // ADR-060: SharePoint also mounts its per-service oauth bearer at
        // `/secrets/oauth-auth-token-sharepoint:ro`; the SharepointNoExtraVolumes allowlist accepts it.
        let yaml = format!(
            r#"
version: "3"
services:
  mcp-sharepoint:
    image: speedwave-mcp-sharepoint:latest
    user: "{user}"
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp:noexec,nosuid,size=64m
    volumes:
      - /test/.speedwave/tokens/test/sharepoint:/tokens:ro
      - /test/project:/workspace:rw
      - /test/.speedwave/oauth/test/bearer-sharepoint:/secrets/oauth-auth-token-sharepoint:ro
"#,
            user = container_user()
        );
        let paths = test_expected_paths();
        let violations =
            SecurityCheck::run_with_data_dir(&yaml, "test", &[], &paths, data_dir.path());
        let sp_violations: Vec<_> = violations
            .iter()
            .filter(|v| v.rule.is_sharepoint())
            .collect();
        assert!(
            sp_violations.is_empty(),
            "post-ADR-060 SharePoint compose (with oauth bearer mount) must pass: {:?}",
            sp_violations.iter().map(|v| &v.rule).collect::<Vec<_>>()
        );
    }

    #[test]
    fn test_security_check_slack_with_workspace_and_bearer_passes() {
        let data_dir = tempfile::tempdir().unwrap();
        // ADR-071: slack mounts /tokens:ro + /workspace:rw (file downloads)
        // + its per-service oauth bearer — the full allowlist must pass.
        let yaml = format!(
            r#"
version: "3"
services:
  mcp-slack:
    image: speedwave-mcp-slack:latest
    user: "{user}"
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp:noexec,nosuid,size=64m
    volumes:
      - /test/.speedwave/tokens/test/slack:/tokens:ro
      - /test/project:/workspace:rw
      - /test/.speedwave/oauth/test/bearer-slack:/secrets/oauth-auth-token-slack:ro
"#,
            user = container_user()
        );
        let paths = test_expected_paths();
        let violations =
            SecurityCheck::run_with_data_dir(&yaml, "test", &[], &paths, data_dir.path());
        let slack_violations: Vec<_> = violations.iter().filter(|v| v.rule.is_slack()).collect();
        assert!(
            slack_violations.is_empty(),
            "ADR-071 slack compose must pass: {:?}",
            slack_violations.iter().map(|v| &v.rule).collect::<Vec<_>>()
        );
    }

    #[test]
    fn test_security_check_slack_flags_rw_tokens_and_missing_workspace() {
        let data_dir = tempfile::tempdir().unwrap();
        let yaml = format!(
            r#"
version: "3"
services:
  mcp-slack:
    image: speedwave-mcp-slack:latest
    user: "{user}"
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp:noexec,nosuid,size=64m
    volumes:
      - /test/.speedwave/tokens/test/slack:/tokens:rw
"#,
            user = container_user()
        );
        let paths = test_expected_paths();
        let violations =
            SecurityCheck::run_with_data_dir(&yaml, "test", &[], &paths, data_dir.path());
        assert!(
            violations
                .iter()
                .any(|v| v.rule == SecurityRule::PluginTokenMountMode
                    && v.container == "mcp-slack"),
            "a :rw token mount on slack must be flagged"
        );
        assert!(
            violations
                .iter()
                .any(|v| v.rule == SecurityRule::SlackMissingWorkspaceMount),
            "a slack service without /workspace must be flagged (ADR-071)"
        );
    }

    #[test]
    fn test_security_check_slack_flags_unauthorized_extra_volume() {
        let data_dir = tempfile::tempdir().unwrap();
        let yaml = format!(
            r#"
version: "3"
services:
  mcp-slack:
    image: speedwave-mcp-slack:latest
    user: "{user}"
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp:noexec,nosuid,size=64m
    volumes:
      - /test/.speedwave/tokens/test/slack:/tokens:ro
      - /test/project:/workspace:rw
      - /etc/passwd:/stolen:ro
"#,
            user = container_user()
        );
        let paths = test_expected_paths();
        let violations =
            SecurityCheck::run_with_data_dir(&yaml, "test", &[], &paths, data_dir.path());
        assert!(
            violations
                .iter()
                .any(|v| v.rule == SecurityRule::SlackNoExtraVolumes),
            "an unauthorized extra volume on slack must be flagged"
        );
    }

    #[test]
    fn test_security_check_sharepoint_oauth_bearer_must_be_ro() {
        let data_dir = tempfile::tempdir().unwrap();
        // ADR-060 / extra_allowed_ro_targets logic: oauth bearer mount must be :ro.
        // A `:rw` mount on that path should fail SharepointNoExtraVolumes.
        let yaml = format!(
            r#"
version: "3"
services:
  mcp-sharepoint:
    image: speedwave-mcp-sharepoint:latest
    user: "{user}"
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp:noexec,nosuid,size=64m
    volumes:
      - /test/.speedwave/tokens/test/sharepoint:/tokens:ro
      - /test/project:/workspace:rw
      - /test/x:/secrets/oauth-auth-token-sharepoint:rw
"#,
            user = container_user()
        );
        let paths = test_expected_paths();
        let violations =
            SecurityCheck::run_with_data_dir(&yaml, "test", &[], &paths, data_dir.path());
        assert!(
            violations
                .iter()
                .any(|v| v.rule == SecurityRule::SharepointNoExtraVolumes),
            "oauth bearer mount with :rw must violate SharepointNoExtraVolumes"
        );
    }

    #[test]
    fn test_security_check_sharepoint_unrecognised_secret_mount_rejected() {
        let data_dir = tempfile::tempdir().unwrap();
        // A `/secrets/` mount with a path that is NOT in extra_allowed_ro_targets
        // (e.g. an attempt to mount another service's bearer) must be rejected.
        let yaml = format!(
            r#"
version: "3"
services:
  mcp-sharepoint:
    image: speedwave-mcp-sharepoint:latest
    user: "{user}"
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp:noexec,nosuid,size=64m
    volumes:
      - /test/.speedwave/tokens/test/sharepoint:/tokens:ro
      - /test/project:/workspace:rw
      - /test/x:/secrets/oauth-auth-token-evil:ro
"#,
            user = container_user()
        );
        let paths = test_expected_paths();
        let violations =
            SecurityCheck::run_with_data_dir(&yaml, "test", &[], &paths, data_dir.path());
        assert!(
            violations
                .iter()
                .any(|v| v.rule == SecurityRule::SharepointNoExtraVolumes),
            "non-allowlisted /secrets/ mount must violate SharepointNoExtraVolumes"
        );
    }

    #[test]
    fn test_security_check_sharepoint_rw_now_violates() {
        let data_dir = tempfile::tempdir().unwrap();
        // Verifies that the legacy :rw mount (ADR-009) is rejected after the
        // ADR-060 migration: SharePoint no longer needs to write to /tokens.
        let yaml = format!(
            r#"
version: "3"
services:
  mcp-sharepoint:
    image: speedwave-mcp-sharepoint:latest
    user: "{user}"
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp:noexec,nosuid,size=64m
    volumes:
      - /test/.speedwave/tokens/test/sharepoint:/tokens:rw
      - /test/project:/workspace:rw
"#,
            user = container_user()
        );
        let paths = test_expected_paths();
        let violations =
            SecurityCheck::run_with_data_dir(&yaml, "test", &[], &paths, data_dir.path());
        // ADR-060 removed `SharepointTokenMountMode`; the universal `PluginTokenMountMode` rule
        // (re-used for built-in workers) now catches a SharePoint `:rw` regression.
        assert!(
            violations
                .iter()
                .any(|v| v.rule == SecurityRule::PluginTokenMountMode),
            "legacy :rw mount must now violate PluginTokenMountMode \
             (the generic mount-mode rule reused for built-in workers)"
        );
    }

    #[test]
    fn test_security_check_sharepoint_missing_workspace_mount() {
        let data_dir = tempfile::tempdir().unwrap();
        let yaml = format!(
            r#"
version: "3"
services:
  mcp-sharepoint:
    image: speedwave-mcp-sharepoint:latest
    user: "{user}"
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp:noexec,nosuid,size=64m
    volumes:
      - /test/.speedwave/tokens/test/sharepoint:/tokens:ro
"#,
            user = container_user()
        );
        let paths = test_expected_paths();
        let violations =
            SecurityCheck::run_with_data_dir(&yaml, "test", &[], &paths, data_dir.path());
        assert!(
            violations
                .iter()
                .any(|v| v.rule == SecurityRule::SharepointMissingWorkspaceMount),
            "SharePoint without workspace mount should trigger SHAREPOINT_MISSING_WORKSPACE_MOUNT"
        );
    }

    #[test]
    fn test_security_check_sharepoint_workspace_path_mismatch() {
        let data_dir = tempfile::tempdir().unwrap();
        let yaml = format!(
            r#"
version: "3"
services:
  mcp-sharepoint:
    image: speedwave-mcp-sharepoint:latest
    user: "{user}"
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp:noexec,nosuid,size=64m
    volumes:
      - /test/.speedwave/tokens/test/sharepoint:/tokens:ro
      - /wrong/path:/workspace:rw
"#,
            user = container_user()
        );
        let paths = test_expected_paths();
        let violations =
            SecurityCheck::run_with_data_dir(&yaml, "test", &[], &paths, data_dir.path());
        assert!(
            violations
                .iter()
                .any(|v| v.rule == SecurityRule::SharepointWorkspacePathMismatch),
            "Wrong SharePoint workspace path should trigger SHAREPOINT_WORKSPACE_PATH_MISMATCH"
        );
    }

    #[test]
    fn test_security_check_sharepoint_workspace_mount_mode_ro() {
        let data_dir = tempfile::tempdir().unwrap();
        let yaml = format!(
            r#"
version: "3"
services:
  mcp-sharepoint:
    image: speedwave-mcp-sharepoint:latest
    user: "{user}"
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp:noexec,nosuid,size=64m
    volumes:
      - /test/.speedwave/tokens/test/sharepoint:/tokens:ro
      - /test/project:/workspace:ro
"#,
            user = container_user()
        );
        let paths = test_expected_paths();
        let violations =
            SecurityCheck::run_with_data_dir(&yaml, "test", &[], &paths, data_dir.path());
        assert!(
            violations
                .iter()
                .any(|v| v.rule == SecurityRule::SharepointWorkspaceMountMode),
            "SharePoint workspace with :ro should trigger SHAREPOINT_WORKSPACE_MOUNT_MODE"
        );
    }

    #[test]
    fn resource_only_plugin_has_no_service_in_compose() {
        // A resource-only plugin (no service_id, no port) should not generate
        // a compose service, but should still appear in SPEEDWAVE_PLUGINS.
        let manifest = PluginManifest {
            name: "Skills Pack".to_string(),
            service_id: None,
            slug: "skills-pack".to_string(),
            version: "1.0.0".to_string(),
            description: "Resource-only plugin".to_string(),
            port: None,
            image_tag: None,
            resources: vec![],
            token_mount: plugin::TokenMount::ReadOnly,
            auth_fields: vec![],
            settings_schema: None,
            speedwave_compat: None,
            extra_env: None,
            mem_limit: None,
            cpu_limit: None,
            requires_integrations: vec![],
            host_bridge: None,
            instructions: None,
            oauth: None,
        };

        // generate_plugin_service requires a port for MCP plugins,
        // but resource-only plugins should never call it (service_id is None)
        assert!(
            manifest.service_id.is_none(),
            "resource-only plugin has no service_id"
        );
        assert!(manifest.port.is_none(), "resource-only plugin has no port");

        // Verify the slug would appear in SPEEDWAVE_PLUGINS
        let mut doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(VALID_COMPOSE).unwrap();
        add_claude_env_var(&mut doc, "SPEEDWAVE_PLUGINS", "skills-pack");
        let claude = doc.get("services").unwrap().get("claude").unwrap();
        let env_seq = claude.get("environment").unwrap().as_sequence().unwrap();
        let has_slug = env_seq.iter().any(|v| {
            v.as_str()
                .is_some_and(|s| s == "SPEEDWAVE_PLUGINS=skills-pack")
        });
        assert!(
            has_slug,
            "resource-only plugin slug should appear in SPEEDWAVE_PLUGINS"
        );

        // Verify no mcp-* service was added
        let services = doc.get("services").unwrap().as_mapping().unwrap();
        assert!(
            !services.contains_key(serde_yaml_ng::Value::String("mcp-skills-pack".into())),
            "resource-only plugin should NOT have a compose service"
        );
    }

    // Verify the `service_id.unwrap_or(slug)` key lookup via its components (is_plugin_enabled + key derivation),
    // not apply_plugins directly (it reads the plugins filesystem).

    #[test]
    #[allow(clippy::unnecessary_literal_unwrap)] // mirrors production `service_id.unwrap_or(slug)` key derivation
    fn test_resource_only_plugin_enabled_by_slug_appears_in_speedwave_plugins() {
        // A plugin without service_id should be toggled by slug.
        // When enabled by slug, it should appear in SPEEDWAVE_PLUGINS.
        let integrations = ResolvedIntegrationsConfig {
            plugins: std::collections::HashMap::from([("my-skills".to_string(), true)]),
            ..Default::default()
        };
        // The key lookup: service_id.unwrap_or(slug) = "my-skills"
        let slug = "my-skills";
        let service_id: Option<&str> = None;
        let plugin_key = service_id.unwrap_or(slug);
        assert!(
            integrations.is_plugin_enabled(plugin_key),
            "Resource-only plugin should be enabled when slug is in plugins map"
        );
    }

    #[test]
    #[allow(clippy::unnecessary_literal_unwrap)] // mirrors production `service_id.unwrap_or(slug)` key derivation
    fn test_resource_only_plugin_disabled_by_slug_excluded() {
        // A plugin without service_id should be excluded when disabled.
        let integrations = ResolvedIntegrationsConfig {
            plugins: std::collections::HashMap::from([("my-skills".to_string(), false)]),
            ..Default::default()
        };
        let slug = "my-skills";
        let service_id: Option<&str> = None;
        let plugin_key = service_id.unwrap_or(slug);
        assert!(
            !integrations.is_plugin_enabled(plugin_key),
            "Resource-only plugin should be excluded when disabled"
        );
    }

    #[test]
    #[allow(clippy::unnecessary_literal_unwrap)] // mirrors production `service_id.unwrap_or(slug)` key derivation
    fn test_resource_only_plugin_absent_from_config_is_disabled() {
        // A freshly installed plugin not in config should be disabled.
        let integrations = ResolvedIntegrationsConfig::default();
        let slug = "new-plugin";
        let service_id: Option<&str> = None;
        let plugin_key = service_id.unwrap_or(slug);
        assert!(
            !integrations.is_plugin_enabled(plugin_key),
            "Plugin not in config should be disabled by default"
        );
    }

    // ─── Worker auth token tests (SEC-035) ────────────────────────────────────

    /// Compose YAML with all 5 toggleable workers for auth token tests.
    const VALID_COMPOSE_ALL_WORKERS: &str = r#"
version: "3"
services:
  claude:
    image: speedwave-claude:latest
    container_name: speedwave_test_claude
    read_only: true
    user: "1000:1000"
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp:noexec,nosuid,size=512m
    volumes:
      - /home/user/.speedwave/claude-home/test:/home/speedwave:rw
      - /home/user/projects/test:/workspace
      - /home/user/.speedwave/claude-resources:/speedwave/resources:ro
    environment:
      - CLAUDE_VERSION=1.0.3
      - DISABLE_AUTOUPDATER=1
    networks:
      - speedwave_test_network

  mcp-hub:
    image: speedwave-mcp-hub:latest
    container_name: speedwave_test_mcp_hub
    read_only: true
    user: "1000:1000"
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp:noexec,nosuid,size=64m
    environment:
      - PORT=4000
      - WORKER_SLACK_URL=http://mcp-slack:3000
      - WORKER_SHAREPOINT_URL=http://mcp-sharepoint:3000
      - WORKER_REDMINE_URL=http://mcp-redmine:3000
      - WORKER_GITLAB_URL=http://mcp-gitlab:3000
      - WORKER_GITHUB_URL=http://mcp-github:3000
      - WORKER_ATLASSIAN_URL=http://mcp-atlassian:3000
      - WORKER_OFFICE_URL=http://mcp-office:3000
      - WORKER_PLAYWRIGHT_URL=http://mcp-playwright:3000
      - WORKER_CONTEXT7_URL=http://mcp-context7:3000
    networks:
      - speedwave_test_network
      - speedwave_test_network_office

  mcp-slack:
    image: speedwave-mcp-slack:latest
    container_name: speedwave_test_mcp_slack
    read_only: true
    user: "1000:1000"
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp:noexec,nosuid,size=64m
    volumes:
      - /home/user/.speedwave/tokens/test/slack:/tokens:ro
      - /home/user/projects/test:/workspace:rw
    environment:
      - PORT=3000
    networks:
      - speedwave_test_network

  mcp-sharepoint:
    image: speedwave-mcp-sharepoint:latest
    container_name: speedwave_test_mcp_sharepoint
    read_only: true
    user: "1000:1000"
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp:noexec,nosuid,size=64m
    volumes:
      - /home/user/.speedwave/tokens/test/sharepoint:/tokens:ro
      - /home/user/projects/test:/workspace:rw
    environment:
      - PORT=3000
    networks:
      - speedwave_test_network

  mcp-redmine:
    image: speedwave-mcp-redmine:latest
    container_name: speedwave_test_mcp_redmine
    read_only: true
    user: "1000:1000"
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp:noexec,nosuid,size=64m
    volumes:
      - /home/user/.speedwave/tokens/test/redmine:/tokens:ro
    environment:
      - PORT=3000
    networks:
      - speedwave_test_network

  mcp-gitlab:
    image: speedwave-mcp-gitlab:latest
    container_name: speedwave_test_mcp_gitlab
    read_only: true
    user: "1000:1000"
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp:noexec,nosuid,size=64m
    volumes:
      - /home/user/.speedwave/tokens/test/gitlab:/tokens:ro
    environment:
      - PORT=3000
    networks:
      - speedwave_test_network

  mcp-github:
    image: speedwave-mcp-github:latest
    container_name: speedwave_test_mcp_github
    read_only: true
    user: "1000:1000"
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp:noexec,nosuid,size=64m
    volumes:
      - /home/user/.speedwave/tokens/test/github:/tokens:ro
    environment:
      - PORT=3000
    networks:
      - speedwave_test_network

  mcp-atlassian:
    image: speedwave-mcp-atlassian:latest
    container_name: speedwave_test_mcp_atlassian
    read_only: true
    user: "1000:1000"
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp:noexec,nosuid,size=64m
    volumes:
      - /home/user/.speedwave/tokens/test/atlassian:/tokens:ro
    environment:
      - PORT=3000
    networks:
      - speedwave_test_network

  mcp-office:
    image: speedwave-mcp-office:latest
    container_name: speedwave_test_mcp_office
    read_only: true
    user: "1000:1000"
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp:noexec,nosuid,size=512m
    volumes:
      - /home/user/projects/test:/workspace:rw
    environment:
      - PORT=3000
    networks:
      - speedwave_test_network_office

  mcp-playwright:
    image: speedwave-mcp-playwright:latest
    container_name: speedwave_test_mcp_playwright
    read_only: true
    user: "1000:1000"
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp:noexec,nosuid,size=1g
    shm_size: 2g
    environment:
      - PORT=3000
    networks:
      - speedwave_test_network

  mcp-context7:
    image: speedwave-mcp-context7:latest
    container_name: speedwave_test_mcp_context7
    read_only: true
    user: "1000:1000"
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp:noexec,nosuid,size=64m
    volumes:
      - /home/user/.speedwave/tokens/test/context7:/tokens:ro
    environment:
      - PORT=3000
    networks:
      - speedwave_test_network

networks:
  speedwave_test_network:
    driver: bridge
  speedwave_test_network_office:
    driver: bridge
    internal: true
"#;

    fn all_enabled_integrations() -> ResolvedIntegrationsConfig {
        ResolvedIntegrationsConfig {
            slack: true,
            sharepoint: true,
            redmine: true,
            gitlab: true,
            github: true,
            atlassian: true,
            office: true,
            playwright: true,
            context7: true,
            ..Default::default()
        }
    }

    fn get_service_env_seq(doc: &serde_yaml_ng::Value, service: &str) -> Vec<String> {
        doc.get("services")
            .and_then(|s| s.get(service))
            .and_then(|h| h.get("environment"))
            .and_then(|e| e.as_sequence())
            .map(|seq| {
                seq.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default()
    }

    fn get_hub_volumes(doc: &serde_yaml_ng::Value) -> Vec<String> {
        doc.get("services")
            .and_then(|s| s.get("mcp-hub"))
            .and_then(|h| h.get("volumes"))
            .and_then(|v| v.as_sequence())
            .map(|seq| {
                seq.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default()
    }

    #[test]
    fn test_worker_auth_tokens_injected_into_enabled_workers() {
        let tmp = tempfile::tempdir().unwrap();
        let integrations = all_enabled_integrations();

        let result = apply_worker_auth_tokens_with_dir(
            VALID_COMPOSE_ALL_WORKERS,
            tmp.path(),
            &integrations,
            &[],
        )
        .unwrap();
        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&result).unwrap();

        for svc in consts::TOGGLEABLE_MCP_SERVICES {
            let env_key = format!("MCP_{}_AUTH_TOKEN", svc.config_key.to_uppercase());
            let env = get_service_env_seq(&doc, svc.compose_name);
            assert!(
                env.iter().any(|e| e.starts_with(&format!("{}=", env_key))),
                "worker '{}' should have {} env var",
                svc.compose_name,
                env_key
            );
        }
    }

    #[test]
    fn test_worker_auth_tokens_not_injected_for_disabled() {
        let tmp = tempfile::tempdir().unwrap();
        let integrations = ResolvedIntegrationsConfig {
            slack: false,
            sharepoint: false,
            redmine: false,
            gitlab: false,
            github: false,
            ..Default::default()
        };

        let result = apply_worker_auth_tokens_with_dir(
            VALID_COMPOSE_ALL_WORKERS,
            tmp.path(),
            &integrations,
            &[],
        )
        .unwrap();
        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&result).unwrap();

        // No auth token env vars on any worker
        for svc in consts::TOGGLEABLE_MCP_SERVICES {
            let env_key = format!("MCP_{}_AUTH_TOKEN", svc.config_key.to_uppercase());
            let env = get_service_env_seq(&doc, svc.compose_name);
            assert!(
                !env.iter().any(|e| e.starts_with(&format!("{}=", env_key))),
                "disabled worker '{}' should NOT have {} env var",
                svc.compose_name,
                env_key
            );
        }

        // No /secrets/ mounts in hub
        let volumes = get_hub_volumes(&doc);
        assert!(
            !volumes
                .iter()
                .any(|v| v.contains("/secrets/") && v.contains("-auth-token")),
            "hub should have no auth token mounts for disabled workers"
        );
    }

    #[test]
    fn test_worker_auth_tokens_mounted_into_hub() {
        let tmp = tempfile::tempdir().unwrap();
        let integrations = all_enabled_integrations();

        let result = apply_worker_auth_tokens_with_dir(
            VALID_COMPOSE_ALL_WORKERS,
            tmp.path(),
            &integrations,
            &[],
        )
        .unwrap();
        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&result).unwrap();
        let volumes = get_hub_volumes(&doc);

        for svc in consts::TOGGLEABLE_MCP_SERVICES {
            let expected_mount = format!("/secrets/{}-auth-token:ro", svc.config_key);
            assert!(
                volumes.iter().any(|v| v.ends_with(&expected_mount)),
                "hub should have mount for {} (looking for suffix '{}')",
                svc.config_key,
                expected_mount
            );
        }
    }

    #[test]
    fn test_worker_auth_tokens_not_in_hub_env() {
        let tmp = tempfile::tempdir().unwrap();
        let integrations = all_enabled_integrations();

        let result = apply_worker_auth_tokens_with_dir(
            VALID_COMPOSE_ALL_WORKERS,
            tmp.path(),
            &integrations,
            &[],
        )
        .unwrap();
        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&result).unwrap();

        // SecurityCheck: hub must not have TOKEN/KEY/SECRET env vars (except WORKER_*_URL, PORT)
        let violations = SecurityCheck::check_no_tokens_in_hub(&doc);
        assert!(
            violations.is_empty(),
            "check_no_tokens_in_hub should pass after worker auth injection, got: {:?}",
            violations.iter().map(|v| &v.message).collect::<Vec<_>>()
        );
    }

    #[test]
    fn test_worker_auth_tokens_are_uuids() {
        let tmp = tempfile::tempdir().unwrap();
        let integrations = all_enabled_integrations();

        apply_worker_auth_tokens_with_dir(
            VALID_COMPOSE_ALL_WORKERS,
            tmp.path(),
            &integrations,
            &[],
        )
        .unwrap();

        for svc in consts::TOGGLEABLE_MCP_SERVICES {
            let token_path = tmp.path().join(format!("{}-auth-token", svc.config_key));
            let token = std::fs::read_to_string(&token_path).unwrap();
            assert!(
                uuid::Uuid::parse_str(token.trim()).is_ok(),
                "token for '{}' should be a valid UUID, got: '{}'",
                svc.config_key,
                token
            );
        }
    }

    #[test]
    fn test_worker_auth_tokens_persist_across_renders() {
        let tmp = tempfile::tempdir().unwrap();
        let integrations = all_enabled_integrations();

        // First render — generates tokens
        apply_worker_auth_tokens_with_dir(
            VALID_COMPOSE_ALL_WORKERS,
            tmp.path(),
            &integrations,
            &[],
        )
        .unwrap();

        let first_tokens: Vec<String> = consts::TOGGLEABLE_MCP_SERVICES
            .iter()
            .map(|svc| {
                std::fs::read_to_string(tmp.path().join(format!("{}-auth-token", svc.config_key)))
                    .unwrap()
            })
            .collect();

        // Second render — should reuse same tokens
        apply_worker_auth_tokens_with_dir(
            VALID_COMPOSE_ALL_WORKERS,
            tmp.path(),
            &integrations,
            &[],
        )
        .unwrap();

        let second_tokens: Vec<String> = consts::TOGGLEABLE_MCP_SERVICES
            .iter()
            .map(|svc| {
                std::fs::read_to_string(tmp.path().join(format!("{}-auth-token", svc.config_key)))
                    .unwrap()
            })
            .collect();

        assert_eq!(
            first_tokens, second_tokens,
            "tokens should persist across renders"
        );
    }

    #[test]
    fn test_worker_auth_tokens_use_engine_path() {
        let tmp = tempfile::tempdir().unwrap();
        let integrations = ResolvedIntegrationsConfig {
            slack: true,
            ..Default::default()
        };

        let result = apply_worker_auth_tokens_with_dir(
            VALID_COMPOSE_ALL_WORKERS,
            tmp.path(),
            &integrations,
            &[],
        )
        .unwrap();
        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&result).unwrap();
        let volumes = get_hub_volumes(&doc);

        let token_path = tmp.path().join("slack-auth-token");
        let expected_host = to_engine_path(&token_path).unwrap();
        assert!(
            volumes
                .iter()
                .any(|v| v.starts_with(&expected_host)
                    && v.ends_with("/secrets/slack-auth-token:ro")),
            "hub mount should use to_engine_path(), volumes: {:?}",
            volumes
        );
    }

    #[test]
    fn test_security_check_passes_with_worker_auth() {
        let tmp = tempfile::tempdir().unwrap();
        let integrations = all_enabled_integrations();

        // Use VALID_COMPOSE_ALL_WORKERS with correct user for current platform
        let yaml = VALID_COMPOSE_ALL_WORKERS.replace(
            "user: \"1000:1000\"",
            &format!("user: \"{}\"", container_user()),
        );
        let result =
            apply_worker_auth_tokens_with_dir(&yaml, tmp.path(), &integrations, &[]).unwrap();

        let data_tmp = tempfile::tempdir().unwrap();
        let violations = SecurityCheck::run_with_data_dir(
            &result,
            "test",
            &[],
            &SecurityExpectedPaths::from_raw(
                "/home/user/projects/test",
                "/home/user/.speedwave/tokens/test",
            ),
            data_tmp.path(),
        );
        assert!(
            violations.is_empty(),
            "SecurityCheck should pass with worker auth, got: {:?}",
            violations
                .iter()
                .map(|v| format!("{}", v))
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn test_worker_auth_token_skipped_when_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let integrations = ResolvedIntegrationsConfig {
            slack: true,
            ..Default::default()
        };

        // Create a directory where the token file should be
        std::fs::create_dir(tmp.path().join("slack-auth-token")).unwrap();

        let result = apply_worker_auth_tokens_with_dir(
            VALID_COMPOSE_ALL_WORKERS,
            tmp.path(),
            &integrations,
            &[],
        )
        .unwrap();

        // Should generate a new token (not panic)
        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&result).unwrap();
        let env = get_service_env_seq(&doc, "mcp-slack");
        assert!(
            env.iter().any(|e| e.starts_with("MCP_SLACK_AUTH_TOKEN=")),
            "should generate new token even when existing path is a directory"
        );
    }

    /// Finds `MCP_SLACK_AUTH_TOKEN=<value>` in env, asserts it is a valid UUID
    /// and is not equal to `sentinel`. Returns the token value for further assertions.
    #[cfg(unix)]
    fn assert_fresh_uuid_token(env: &[String], sentinel: &str) -> String {
        let entry = env
            .iter()
            .find(|e| e.starts_with("MCP_SLACK_AUTH_TOKEN="))
            .expect("MCP_SLACK_AUTH_TOKEN must be present in env");
        let value = entry.strip_prefix("MCP_SLACK_AUTH_TOKEN=").unwrap();
        assert!(
            uuid::Uuid::parse_str(value).is_ok(),
            "token must be a valid UUID, got: '{}'",
            value
        );
        assert_ne!(
            value, sentinel,
            "token must not equal the planted sentinel '{}'",
            sentinel
        );
        value.to_string()
    }

    #[cfg(unix)]
    #[test]
    fn test_worker_auth_token_skipped_when_symlink() {
        const SENTINEL: &str = "PLANTED-NOT-A-UUID";
        let tmp = tempfile::tempdir().unwrap();
        let integrations = ResolvedIntegrationsConfig {
            slack: true,
            ..Default::default()
        };

        let target = tmp.path().join("some-target");
        std::fs::write(&target, SENTINEL).unwrap();
        std::os::unix::fs::symlink(&target, tmp.path().join("slack-auth-token")).unwrap();

        let result = apply_worker_auth_tokens_with_dir(
            VALID_COMPOSE_ALL_WORKERS,
            tmp.path(),
            &integrations,
            &[],
        )
        .unwrap();

        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&result).unwrap();
        let env = get_service_env_seq(&doc, "mcp-slack");
        assert_fresh_uuid_token(&env, SENTINEL);

        let token_path = tmp.path().join("slack-auth-token");
        assert!(token_path.is_file(), "token should be a regular file");
        assert!(
            !token_path.is_symlink(),
            "token should not be a symlink after cleanup"
        );
        let disk_token = std::fs::read_to_string(&token_path).unwrap();
        assert!(
            uuid::Uuid::parse_str(disk_token.trim()).is_ok(),
            "on-disk token should be a valid UUID, got: '{}'",
            disk_token
        );
        assert_ne!(
            disk_token.trim(),
            SENTINEL,
            "on-disk token must not equal the planted sentinel"
        );
    }

    #[test]
    fn test_worker_auth_token_written_with_0o600() {
        let tmp = tempfile::tempdir().unwrap();
        let integrations = ResolvedIntegrationsConfig {
            slack: true,
            ..Default::default()
        };

        apply_worker_auth_tokens_with_dir(
            VALID_COMPOSE_ALL_WORKERS,
            tmp.path(),
            &integrations,
            &[],
        )
        .unwrap();

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let token_path = tmp.path().join("slack-auth-token");
            let mode = std::fs::metadata(&token_path).unwrap().permissions().mode();
            assert_eq!(
                mode & 0o777,
                0o600,
                "token file should have 0o600 permissions, got: {:o}",
                mode & 0o777
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn test_worker_auth_token_rejects_symlink_with_uuid_target() {
        const PLANTED_UUID: &str = "550e8400-e29b-41d4-a716-446655440000";
        let tmp = tempfile::tempdir().unwrap();
        let integrations = ResolvedIntegrationsConfig {
            slack: true,
            ..Default::default()
        };

        let target = tmp.path().join("uuid-target");
        std::fs::write(&target, PLANTED_UUID).unwrap();
        std::os::unix::fs::symlink(&target, tmp.path().join("slack-auth-token")).unwrap();

        let result = apply_worker_auth_tokens_with_dir(
            VALID_COMPOSE_ALL_WORKERS,
            tmp.path(),
            &integrations,
            &[],
        )
        .unwrap();

        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&result).unwrap();
        let env = get_service_env_seq(&doc, "mcp-slack");
        assert_fresh_uuid_token(&env, PLANTED_UUID);
    }

    #[cfg(unix)]
    #[test]
    fn test_worker_auth_token_rejects_symlink_chain() {
        const SENTINEL: &str = "CHAIN-SENTINEL";
        let tmp = tempfile::tempdir().unwrap();
        let integrations = ResolvedIntegrationsConfig {
            slack: true,
            ..Default::default()
        };

        let file_c = tmp.path().join("chain-target-file");
        std::fs::write(&file_c, SENTINEL).unwrap();
        let link_b = tmp.path().join("chain-link-b");
        std::os::unix::fs::symlink(&file_c, &link_b).unwrap();
        std::os::unix::fs::symlink(&link_b, tmp.path().join("slack-auth-token")).unwrap();

        let result = apply_worker_auth_tokens_with_dir(
            VALID_COMPOSE_ALL_WORKERS,
            tmp.path(),
            &integrations,
            &[],
        )
        .unwrap();

        let token_path = tmp.path().join("slack-auth-token");
        assert!(token_path.is_file(), "token should be a regular file");
        assert!(
            !token_path.is_symlink(),
            "token should not be a symlink after chain cleanup"
        );

        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&result).unwrap();
        let env = get_service_env_seq(&doc, "mcp-slack");
        assert_fresh_uuid_token(&env, SENTINEL);
    }

    #[test]
    fn test_worker_auth_token_trims_whitespace_and_preserves_legacy_format() {
        const KNOWN_UUID: &str = "550e8400-e29b-41d4-a716-446655440000";
        let tmp = tempfile::tempdir().unwrap();
        let integrations = ResolvedIntegrationsConfig {
            slack: true,
            ..Default::default()
        };

        // Write a token file with leading/trailing whitespace (hand-edited or older format)
        let token_path = tmp.path().join("slack-auth-token");
        let raw_content = "  550e8400-e29b-41d4-a716-446655440000\n  \n";
        std::fs::write(&token_path, raw_content).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&token_path, std::fs::Permissions::from_mode(0o600)).unwrap();
        }

        let result = apply_worker_auth_tokens_with_dir(
            VALID_COMPOSE_ALL_WORKERS,
            tmp.path(),
            &integrations,
            &[],
        )
        .unwrap();

        // The env-var should contain the trimmed UUID
        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&result).unwrap();
        let env = get_service_env_seq(&doc, "mcp-slack");
        let token_entry = env
            .iter()
            .find(|e| e.starts_with("MCP_SLACK_AUTH_TOKEN="))
            .expect("should have MCP_SLACK_AUTH_TOKEN env var");
        let token_value = token_entry.strip_prefix("MCP_SLACK_AUTH_TOKEN=").unwrap();
        assert_eq!(
            token_value, KNOWN_UUID,
            "token should be trimmed UUID, got: '{}'",
            token_value
        );

        // The on-disk file holds the same (trimmed) UUID, not a fresh one — the atomic write
        // normalises to trimmed form, confirming the existing token was re-used, not replaced.
        let disk_content = std::fs::read_to_string(&token_path).unwrap();
        assert_eq!(
            disk_content.trim(),
            KNOWN_UUID,
            "on-disk file should contain the same UUID as the env-var, got: '{}'",
            disk_content
        );
    }

    #[test]
    fn test_worker_auth_token_empty_file_generates_fresh_uuid() {
        let tmp = tempfile::tempdir().unwrap();
        let integrations = ResolvedIntegrationsConfig {
            slack: true,
            ..Default::default()
        };

        let token_path = tmp.path().join("slack-auth-token");
        std::fs::write(&token_path, "   \n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&token_path, std::fs::Permissions::from_mode(0o600)).unwrap();
        }

        let result = apply_worker_auth_tokens_with_dir(
            VALID_COMPOSE_ALL_WORKERS,
            tmp.path(),
            &integrations,
            &[],
        )
        .unwrap();

        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&result).unwrap();
        let env = get_service_env_seq(&doc, "mcp-slack");
        let token_entry = env
            .iter()
            .find(|e| e.starts_with("MCP_SLACK_AUTH_TOKEN="))
            .expect("should have MCP_SLACK_AUTH_TOKEN");
        let token_value = token_entry.strip_prefix("MCP_SLACK_AUTH_TOKEN=").unwrap();
        assert!(
            uuid::Uuid::parse_str(token_value).is_ok(),
            "empty-file branch should generate a valid UUID, got: '{}'",
            token_value
        );
        let disk = std::fs::read_to_string(&token_path).unwrap();
        assert!(
            uuid::Uuid::parse_str(disk.trim()).is_ok(),
            "on-disk token should be a valid UUID, got: '{}'",
            disk
        );
    }

    #[test]
    fn test_worker_auth_token_atomic_write() {
        let tmp = tempfile::tempdir().unwrap();
        let integrations = all_enabled_integrations();

        apply_worker_auth_tokens_with_dir(
            VALID_COMPOSE_ALL_WORKERS,
            tmp.path(),
            &integrations,
            &[],
        )
        .unwrap();

        // No .tmp files should remain
        let tmp_files: Vec<_> = std::fs::read_dir(tmp.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.path().extension().is_some_and(|ext| ext == "tmp"))
            .collect();
        assert!(
            tmp_files.is_empty(),
            "no .tmp files should remain after atomic write, found: {:?}",
            tmp_files.iter().map(|e| e.path()).collect::<Vec<_>>()
        );
    }

    #[test]
    fn test_plugin_worker_auth_token_injected() {
        let tmp = tempfile::tempdir().unwrap();

        let plugins = vec![plugin::PluginManifest {
            name: "Example Plugin".to_string(),
            slug: "example-plugin".to_string(),
            service_id: Some("example-plugin".to_string()),
            version: "1.0.0".to_string(),
            description: "test".to_string(),
            port: Some(4010),
            image_tag: None,
            resources: vec![],
            token_mount: plugin::TokenMount::ReadOnly,
            auth_fields: vec![],
            settings_schema: None,
            speedwave_compat: None,
            extra_env: None,
            mem_limit: None,
            cpu_limit: None,
            requires_integrations: vec![],
            host_bridge: None,
            instructions: None,
            oauth: None,
        }];

        // Compose with plugin service already present (as apply_plugins would leave it)
        let mut doc: serde_yaml_ng::Value =
            serde_yaml_ng::from_str(VALID_COMPOSE_ALL_WORKERS).unwrap();
        let plugin_svc: serde_yaml_ng::Value = serde_yaml_ng::from_str(
            "image: speedwave-mcp-example-plugin:1.0.0\nenvironment:\n  - PORT=4010\nnetworks:\n  - speedwave_test_network\n",
        )
        .unwrap();
        doc["services"]["mcp-example-plugin"] = plugin_svc;
        let compose_with_plugin = serde_yaml_ng::to_string(&doc).unwrap();

        let mut integrations = all_enabled_integrations();
        integrations
            .plugins
            .insert("example-plugin".to_string(), true);

        let secrets_dir = tmp.path().join("secrets");
        std::fs::create_dir_all(&secrets_dir).unwrap();

        let result = apply_worker_auth_tokens_with_dir(
            &compose_with_plugin,
            &secrets_dir,
            &integrations,
            &plugins,
        )
        .unwrap();
        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&result).unwrap();

        // Plugin worker should have MCP_EXAMPLE_PLUGIN_AUTH_TOKEN env var
        let env = get_service_env_seq(&doc, "mcp-example-plugin");
        assert!(
            env.iter()
                .any(|e| e.starts_with("MCP_EXAMPLE_PLUGIN_AUTH_TOKEN=")),
            "plugin worker should have MCP_EXAMPLE_PLUGIN_AUTH_TOKEN, env={:?}",
            env
        );

        // Hub should have /secrets/example-plugin-auth-token:ro mount
        let volumes = get_hub_volumes(&doc);
        assert!(
            volumes
                .iter()
                .any(|v| v.contains("/secrets/example-plugin-auth-token:ro")),
            "hub should mount plugin auth token, volumes={:?}",
            volumes
        );

        // Token file should exist on disk
        assert!(secrets_dir.join("example-plugin-auth-token").exists());
    }

    #[test]
    fn test_add_service_env_var_fails_for_missing_service() {
        let mut doc: serde_yaml_ng::Value =
            serde_yaml_ng::from_str(VALID_COMPOSE_ALL_WORKERS).unwrap();

        let result = add_service_env_var(&mut doc, "nonexistent-service", "FOO", "bar");
        assert!(
            result.is_err(),
            "add_service_env_var should fail for missing service"
        );
        let err = result.unwrap_err().to_string();
        assert!(
            err.contains("nonexistent-service"),
            "error should mention the missing service name, got: {}",
            err
        );
    }

    #[test]
    fn test_security_check_plugin_token_ro_when_manifest_rw() {
        let data_dir = tempfile::tempdir().unwrap();
        use crate::plugin::{PluginManifest, TokenMount};
        let yaml = format!(
            r#"
version: "3"
services:
  mcp-test-plugin:
    image: speedwave-mcp-test-plugin:1.0.0
    user: "{user}"
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp:noexec,nosuid,size=64m
    read_only: true
    volumes:
      - /test/.speedwave/tokens/test/test-plugin:/tokens:ro
      - /test/project:/workspace:rw
    labels:
      speedwave.plugin-service: "true"
"#,
            user = container_user()
        );
        let manifest = PluginManifest {
            name: "Test".to_string(),
            service_id: Some("test-plugin".to_string()),
            slug: "test-plugin".to_string(),
            version: "1.0.0".to_string(),
            description: "test".to_string(),
            port: Some(5000),
            image_tag: None,
            resources: vec![],
            token_mount: TokenMount::ReadWrite {
                justification: "OAuth refresh".to_string(),
            },
            auth_fields: vec![],
            settings_schema: None,
            speedwave_compat: None,
            extra_env: None,
            mem_limit: None,
            cpu_limit: None,
            requires_integrations: vec![],
            host_bridge: None,
            instructions: None,
            oauth: None,
        };
        let violations = SecurityCheck::run_with_data_dir(
            &yaml,
            "test",
            &[manifest],
            &test_expected_paths(),
            data_dir.path(),
        );
        assert!(
            violations
                .iter()
                .any(|v| v.rule == SecurityRule::PluginTokenMountMode),
            "should detect :ro mount when manifest declares ReadWrite. Violations: {:?}",
            violations
                .iter()
                .map(|v| format!("{}", v))
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn test_security_check_sharepoint_no_extra_volumes() {
        let data_dir = tempfile::tempdir().unwrap();
        let yaml = format!(
            r#"
version: "3"
services:
  mcp-sharepoint:
    image: speedwave-mcp-sharepoint:latest
    user: "{user}"
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    volumes:
      - /test/.speedwave/tokens/test/sharepoint:/tokens:ro
      - /test/project:/workspace:rw
      - /etc/passwd:/etc/passwd:ro
"#,
            user = container_user()
        );
        let violations = SecurityCheck::run_with_data_dir(
            &yaml,
            "test",
            &[],
            &test_expected_paths(),
            data_dir.path(),
        );
        assert!(
            violations
                .iter()
                .any(|v| v.rule == SecurityRule::SharepointNoExtraVolumes),
            "should detect unauthorized volume mount on SharePoint. Got: {:?}",
            violations
                .iter()
                .map(|v| format!("{}", v))
                .collect::<Vec<_>>()
        );
    }

    // --- ALL_RULES sync test ---

    #[test]
    fn test_all_rules_covers_every_variant() {
        assert_eq!(
            SecurityRule::iter().count(),
            SECURITY_RULE_COUNT,
            "variant count drifted — update SecurityRule and tests"
        );
    }

    #[test]
    fn test_is_sharepoint_covers_all_sharepoint_prefixed_variants() {
        let by_prefix = SecurityRule::iter()
            .filter(|r| r.to_string().starts_with("SHAREPOINT"))
            .count();
        let by_method = SecurityRule::iter().filter(|r| r.is_sharepoint()).count();
        let slack_by_prefix = SecurityRule::iter()
            .filter(|r| r.to_string().starts_with("SLACK_"))
            .count();
        let slack_by_method = SecurityRule::iter().filter(|r| r.is_slack()).count();
        assert_eq!(
            slack_by_method, slack_by_prefix,
            "is_slack() count ({slack_by_method}) differs from SLACK-prefixed variant count \
             ({slack_by_prefix}) — update SecurityRule::is_slack() to include the new variant"
        );
        assert_eq!(
            by_prefix, by_method,
            "is_sharepoint() count ({by_method}) differs from SHAREPOINT-prefixed variant count \
             ({by_prefix}) — update SecurityRule::is_sharepoint() to include the new variant"
        );
    }

    // --- strum attribute spot-checks ---

    #[test]
    fn test_security_rule_display_spot_check() {
        assert_eq!(SecurityRule::CapDropAll.to_string(), "CAP_DROP_ALL");
        assert_eq!(SecurityRule::ContainerUser.to_string(), "CONTAINER_USER");
        assert_eq!(
            SecurityRule::FileSecurityViolation.to_string(),
            "FILE_SECURITY_VIOLATION"
        );
    }

    #[test]
    fn test_security_rule_description_spot_check() {
        assert_eq!(
            SecurityRule::CapDropAll.description(),
            "All containers have cap_drop: [ALL]"
        );
        assert_eq!(
            SecurityRule::FileSecurityViolation.description(),
            "Host file permissions and ownership are correct"
        );
    }

    #[test]
    fn test_security_rule_description_all_variants_have_prop() {
        for rule in SecurityRule::iter() {
            let desc = rule.description();
            assert!(
                !desc.is_empty(),
                "SecurityRule::{:?} has empty description",
                rule
            );
        }
    }

    #[test]
    fn test_security_rule_iter_first_and_last() {
        let rules: Vec<SecurityRule> = SecurityRule::iter().collect();
        assert_eq!(rules.len(), SECURITY_RULE_COUNT);
        assert_eq!(rules.first().copied(), Some(SecurityRule::YamlParseError));
        assert_eq!(
            rules.last().copied(),
            Some(SecurityRule::FileSecurityViolation)
        );
        assert_eq!(
            rules[11],
            SecurityRule::ContainerUser,
            "ContainerUser must be at index 11 (position 12)"
        );
    }

    // --- Integration: run() delegation ---

    #[test]
    fn test_security_check_run_delegates_without_panic() {
        // Verifies run() delegates to run_with_data_dir() without panicking (real files may produce violations).
        let yaml = valid_compose_yaml();
        let _violations =
            SecurityCheck::run(&yaml, "nonexistent-project", &[], &test_expected_paths());
        // No assertion on violations — dev machines may have real files.
    }

    #[cfg(unix)]
    #[test]
    fn test_security_check_run_includes_file_security() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path();

        let secrets_dir = data_dir.join("secrets").join("test");
        std::fs::create_dir_all(&secrets_dir).unwrap();
        std::fs::set_permissions(&secrets_dir, std::fs::Permissions::from_mode(0o755)).unwrap();

        let yaml = valid_compose_yaml();
        let violations =
            SecurityCheck::run_with_data_dir(&yaml, "test", &[], &test_expected_paths(), data_dir);
        assert!(
            violations
                .iter()
                .any(|v| v.rule == SecurityRule::FileSecurityViolation),
            "run_with_data_dir() should include file security violations"
        );
        // Note: this assertion depends on valid_compose_yaml() producing no
        // YAML-level violations. If valid_compose_yaml() changes, this may need updating.
        assert!(
            violations
                .iter()
                .all(|v| v.rule == SecurityRule::FileSecurityViolation),
            "Only file security violations expected — compose YAML should be valid"
        );
    }

    // --- File security check tests ---

    /// Creates a directory tree under data_dir with 0o700 on all components. E.g.
    /// `secure_mkdir(data_dir, &["secrets", "proj"])` creates `secrets/` and `secrets/proj/` (0o700).
    #[cfg(unix)]
    fn secure_mkdir(data_dir: &std::path::Path, components: &[&str]) {
        use std::os::unix::fs::PermissionsExt;
        let mut path = data_dir.to_path_buf();
        for comp in components {
            path = path.join(comp);
            if !path.exists() {
                std::fs::create_dir(&path).unwrap();
            }
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
    }

    #[cfg(unix)]
    #[test]
    fn test_file_security_passes_for_correct_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path();

        secure_mkdir(data_dir, &["secrets", "testproj"]);
        let secrets_dir = data_dir.join("secrets").join("testproj");

        let token_file = secrets_dir.join("slack-auth-token");
        std::fs::write(&token_file, "secret").unwrap();
        std::fs::set_permissions(&token_file, std::fs::Permissions::from_mode(0o600)).unwrap();

        let violations = SecurityCheck::check_file_security(data_dir, "testproj");
        assert!(
            violations.is_empty(),
            "Expected no violations for correct permissions, got: {:?}",
            violations
                .iter()
                .map(|v| format!("{v}"))
                .collect::<Vec<_>>()
        );
    }

    #[cfg(unix)]
    #[test]
    fn test_file_security_detects_world_readable_secret() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path();

        secure_mkdir(data_dir, &["secrets", "testproj"]);
        let secrets_dir = data_dir.join("secrets").join("testproj");

        let token_file = secrets_dir.join("slack-auth-token");
        std::fs::write(&token_file, "secret").unwrap();
        std::fs::set_permissions(&token_file, std::fs::Permissions::from_mode(0o644)).unwrap();

        let violations = SecurityCheck::check_file_security(data_dir, "testproj");
        assert!(
            violations
                .iter()
                .any(|v| v.rule == SecurityRule::FileSecurityViolation),
            "Expected FILE_SECURITY_VIOLATION"
        );
        assert!(
            violations[0].message.contains("0o644"),
            "Message should contain actual permissions"
        );
    }

    #[cfg(unix)]
    #[test]
    fn test_file_security_detects_group_readable_secret() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path();

        secure_mkdir(data_dir, &["secrets", "testproj"]);
        let secrets_dir = data_dir.join("secrets").join("testproj");

        let token_file = secrets_dir.join("slack-auth-token");
        std::fs::write(&token_file, "secret").unwrap();
        std::fs::set_permissions(&token_file, std::fs::Permissions::from_mode(0o640)).unwrap();

        let violations = SecurityCheck::check_file_security(data_dir, "testproj");
        assert!(
            violations
                .iter()
                .any(|v| v.rule == SecurityRule::FileSecurityViolation),
            "0o640 (group-readable) should be a violation — expected 0o600"
        );
    }

    #[cfg(unix)]
    #[test]
    fn test_file_security_detects_world_readable_directory() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path();

        // Parent secrets/ is correct, only project subdir is wrong
        secure_mkdir(data_dir, &["secrets"]);
        let secrets_dir = data_dir.join("secrets").join("testproj");
        std::fs::create_dir(&secrets_dir).unwrap();
        std::fs::set_permissions(&secrets_dir, std::fs::Permissions::from_mode(0o755)).unwrap();

        let violations = SecurityCheck::check_file_security(data_dir, "testproj");
        assert!(
            violations
                .iter()
                .any(|v| v.rule == SecurityRule::FileSecurityViolation),
            "Expected violation for directory with 0o755"
        );
    }

    #[cfg(unix)]
    #[test]
    fn test_file_security_skips_missing_paths() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path();

        let violations = SecurityCheck::check_file_security(data_dir, "testproj");
        assert!(
            violations.is_empty(),
            "Missing paths should be skipped, not reported as violations"
        );
    }

    #[cfg(unix)]
    #[test]
    fn test_file_security_skips_symlinks() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path();

        secure_mkdir(data_dir, &["secrets", "testproj"]);
        let secrets_dir = data_dir.join("secrets").join("testproj");

        let target = tmp.path().join("outside-file");
        std::fs::write(&target, "data").unwrap();
        std::os::unix::fs::symlink(&target, secrets_dir.join("symlink-token")).unwrap();

        let violations = SecurityCheck::check_file_security(data_dir, "testproj");
        assert!(
            violations.is_empty(),
            "Symlinks should be skipped, got: {:?}",
            violations
                .iter()
                .map(|v| format!("{v}"))
                .collect::<Vec<_>>()
        );
    }

    #[cfg(unix)]
    #[test]
    fn test_file_security_token_dir_files() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path();

        secure_mkdir(data_dir, &["tokens", "testproj", "myplugin"]);
        let token_dir = data_dir.join("tokens").join("testproj").join("myplugin");

        let token_file = token_dir.join("api_key");
        std::fs::write(&token_file, "key123").unwrap();
        std::fs::set_permissions(&token_file, std::fs::Permissions::from_mode(0o644)).unwrap();

        let violations = SecurityCheck::check_file_security(data_dir, "testproj");
        assert_eq!(
            violations
                .iter()
                .filter(|v| v.rule == SecurityRule::FileSecurityViolation)
                .count(),
            1,
            "Expected exactly 1 violation for the token file, dirs are correct"
        );
        assert!(
            violations[0].message.contains("api_key"),
            "Violation should reference the token file"
        );
    }

    #[cfg(unix)]
    #[test]
    fn test_file_security_bundle_state() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path();

        let state_file = data_dir.join("bundle-state.json");
        std::fs::write(&state_file, "{}").unwrap();
        std::fs::set_permissions(&state_file, std::fs::Permissions::from_mode(0o644)).unwrap();

        let violations = SecurityCheck::check_file_security(data_dir, "testproj");
        assert!(
            violations
                .iter()
                .any(|v| v.rule == SecurityRule::FileSecurityViolation
                    && v.message.contains("bundle-state.json")),
            "Expected violation for bundle-state.json with wrong permissions"
        );
    }

    #[cfg(unix)]
    #[test]
    fn test_file_security_unreadable_directory() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};

        // Root can read any directory regardless of mode bits
        let tmp_check = tempfile::tempdir().unwrap();
        let check_meta = std::fs::metadata(tmp_check.path()).unwrap();
        if check_meta.uid() == 0 {
            return;
        }

        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path();

        secure_mkdir(data_dir, &["secrets", "testproj"]);
        let secrets_dir = data_dir.join("secrets").join("testproj");
        std::fs::write(secrets_dir.join("token"), "secret").unwrap();
        std::fs::set_permissions(&secrets_dir, std::fs::Permissions::from_mode(0o000)).unwrap();

        let violations = SecurityCheck::check_file_security(data_dir, "testproj");
        assert!(
            violations
                .iter()
                .any(|v| v.rule == SecurityRule::FileSecurityViolation
                    && v.message.contains("0o000")),
            "Directory with 0o000 should be flagged"
        );

        // Restore permissions so tempdir cleanup can delete it
        std::fs::set_permissions(&secrets_dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn test_file_security_ide_bridge() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path();

        let ide_dir = data_dir.join("ide-bridge");
        std::fs::create_dir_all(&ide_dir).unwrap();
        std::fs::set_permissions(&ide_dir, std::fs::Permissions::from_mode(0o755)).unwrap();

        let lock_file = ide_dir.join("4000.lock");
        std::fs::write(&lock_file, "{}").unwrap();
        std::fs::set_permissions(&lock_file, std::fs::Permissions::from_mode(0o644)).unwrap();

        let violations = SecurityCheck::check_file_security(data_dir, "testproj");
        assert_eq!(
            violations
                .iter()
                .filter(|v| v.rule == SecurityRule::FileSecurityViolation)
                .count(),
            2,
            "Expected 2 violations: directory + lock file"
        );
    }

    #[cfg(unix)]
    #[test]
    fn test_file_security_snapshots() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path();

        // Parent snapshots/ dir is correct, only project subdir is wrong
        secure_mkdir(data_dir, &["snapshots"]);
        let snap_dir = data_dir.join("snapshots").join("testproj");
        std::fs::create_dir(&snap_dir).unwrap();
        std::fs::set_permissions(&snap_dir, std::fs::Permissions::from_mode(0o755)).unwrap();

        let snap_file = snap_dir.join("update-snapshot-testproj.json");
        std::fs::write(&snap_file, "{}").unwrap();
        std::fs::set_permissions(&snap_file, std::fs::Permissions::from_mode(0o644)).unwrap();

        let violations = SecurityCheck::check_file_security(data_dir, "testproj");
        assert_eq!(
            violations
                .iter()
                .filter(|v| v.rule == SecurityRule::FileSecurityViolation)
                .count(),
            2,
            "Expected 2 violations: snapshots/testproj dir + snapshot file"
        );
    }

    #[cfg(unix)]
    #[test]
    fn test_file_security_oauth_tree() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path();

        // World-readable oauth/<project> dir + oauth.json must both be flagged. Earlier the oauth
        // tree was outside SecurityCheck's path collector, so a world-readable token slipped by.
        let oauth_dir = data_dir.join("oauth");
        std::fs::create_dir_all(oauth_dir.join("testproj")).unwrap();
        std::fs::set_permissions(&oauth_dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::set_permissions(
            oauth_dir.join("testproj"),
            std::fs::Permissions::from_mode(0o755),
        )
        .unwrap();
        let oauth_json = oauth_dir.join("testproj").join("sharepoint.json");
        std::fs::write(&oauth_json, "{}").unwrap();
        std::fs::set_permissions(&oauth_json, std::fs::Permissions::from_mode(0o644)).unwrap();

        let audit = oauth_dir.join("testproj").join("audit.log");
        std::fs::write(&audit, "x").unwrap();
        std::fs::set_permissions(&audit, std::fs::Permissions::from_mode(0o644)).unwrap();

        let violations = SecurityCheck::check_file_security(data_dir, "testproj");
        let file_violations = violations
            .iter()
            .filter(|v| v.rule == SecurityRule::FileSecurityViolation)
            .count();
        assert_eq!(
            file_violations, 4,
            "Expected 4 violations (oauth/, oauth/testproj/, sharepoint.json, audit.log); got: {violations:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn test_file_security_oauth_tree_passes_when_correct() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path();

        let oauth_dir = data_dir.join("oauth");
        std::fs::create_dir_all(oauth_dir.join("testproj")).unwrap();
        std::fs::set_permissions(&oauth_dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::set_permissions(
            oauth_dir.join("testproj"),
            std::fs::Permissions::from_mode(0o700),
        )
        .unwrap();

        // Cover every file kind we expect under oauth/<project>/.
        for name in &[
            "sharepoint.json",
            ".bearer-map.json",
            "bearer-sharepoint",
            "auth-token",
            "port",
            "pid",
            "audit.log",
            "audit.log.1",
        ] {
            let p = oauth_dir.join("testproj").join(name);
            std::fs::write(&p, "x").unwrap();
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600)).unwrap();
        }

        let violations = SecurityCheck::check_file_security(data_dir, "testproj");
        assert!(
            violations.is_empty(),
            "No violations expected for correctly-permed oauth tree; got: {violations:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn test_file_security_tokens_only_no_secrets() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path();

        secure_mkdir(data_dir, &["tokens", "testproj", "myplugin"]);
        let token_dir = data_dir.join("tokens").join("testproj").join("myplugin");

        let token_file = token_dir.join("api_key");
        std::fs::write(&token_file, "key123").unwrap();
        std::fs::set_permissions(&token_file, std::fs::Permissions::from_mode(0o600)).unwrap();

        let violations = SecurityCheck::check_file_security(data_dir, "testproj");
        assert!(
            violations.is_empty(),
            "No violations expected when only tokens exist with correct permissions"
        );
    }

    #[cfg(unix)]
    #[test]
    fn test_file_security_uid_mismatch() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};

        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path();

        secure_mkdir(data_dir, &["secrets", "testproj"]);
        let secrets_dir = data_dir.join("secrets").join("testproj");

        let token_file = secrets_dir.join("slack-auth-token");
        std::fs::write(&token_file, "secret").unwrap();
        std::fs::set_permissions(&token_file, std::fs::Permissions::from_mode(0o600)).unwrap();

        // Get real UID from a file we own, then use fake_uid = real + 1
        let real_uid = std::fs::metadata(&secrets_dir).unwrap().uid();
        let fake_uid = real_uid + 1;
        let violations =
            SecurityCheck::check_file_security_with_uid(data_dir, "testproj", fake_uid);
        assert!(
            violations.iter().any(|v| {
                v.rule == SecurityRule::FileSecurityViolation && v.message.contains("owned by uid")
            }),
            "Expected ownership violation when expected UID doesn't match file owner"
        );
    }

    #[cfg(unix)]
    #[test]
    fn test_file_security_token_directory_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path();

        let token_service_dir = data_dir.join("tokens").join("testproj").join("slack");
        std::fs::create_dir_all(&token_service_dir).unwrap();
        let tokens_project_dir = data_dir.join("tokens").join("testproj");
        std::fs::set_permissions(&tokens_project_dir, std::fs::Permissions::from_mode(0o755))
            .unwrap();
        std::fs::set_permissions(&token_service_dir, std::fs::Permissions::from_mode(0o755))
            .unwrap();

        let violations = SecurityCheck::check_file_security(data_dir, "testproj");
        let dir_violations: Vec<_> = violations
            .iter()
            .filter(|v| {
                v.rule == SecurityRule::FileSecurityViolation && v.message.contains("0o755")
            })
            .collect();
        assert!(
            dir_violations.len() >= 2,
            "Expected violations for tokens/<project>/ and tokens/<project>/slack/ directories"
        );
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn test_ensure_plugin_images_called_before_apply_plugins() {
        // Structural test: verify render_compose() uses ensure_plugin_images (not
        // build_pending_plugin_images) and calls it BEFORE apply_plugins.
        let source = include_str!("mod.rs");

        // Find the render_compose function body
        let fn_start = source
            .find("pub fn render_compose(")
            .expect("render_compose function must exist in the compose module");
        let fn_body = &source[fn_start..];

        // Verify ensure_plugin_images is used (not the old build_pending_plugin_images)
        assert!(
            fn_body.contains("ensure_plugin_images"),
            "render_compose must call ensure_plugin_images (not build_pending_plugin_images)"
        );
        assert!(
            !fn_body[..fn_body.find("apply_plugins(").unwrap_or(fn_body.len())]
                .contains("build_pending_plugin_images"),
            "render_compose must not call build_pending_plugin_images"
        );

        // Verify ensure_plugin_images appears before apply_plugins
        let ensure_pos = fn_body
            .find("ensure_plugin_images")
            .expect("ensure_plugin_images call must exist in render_compose");
        let apply_pos = fn_body
            .find("apply_plugins(")
            .expect("apply_plugins call must exist in render_compose");
        assert!(
            ensure_pos < apply_pos,
            "ensure_plugin_images (offset {ensure_pos}) must appear before \
             apply_plugins (offset {apply_pos}) in render_compose"
        );

        // Verify project scoping via enabled_plugin_service_ids
        assert!(
            fn_body[ensure_pos..].contains("enabled_plugin_service_ids"),
            "ensure_plugin_images call must use enabled_plugin_service_ids for project scoping"
        );
    }

    // ---- inject_host_timezone -----------------------------------------------

    #[test]
    fn test_inject_host_timezone_adds_tz_to_every_service() {
        let yaml = "services:\n  \
                    claude:\n    environment:\n      - PORT=3000\n  \
                    mcp-hub:\n    environment:\n      - PORT=4000\n  \
                    mcp-slack:\n    environment:\n      - PORT=5000\n";
        let result = inject_host_timezone(yaml, "Europe/Warsaw").unwrap();
        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&result).unwrap();
        for service_name in ["claude", "mcp-hub", "mcp-slack"] {
            let env = doc
                .get("services")
                .and_then(|s| s.get(service_name))
                .and_then(|s| s.get("environment"))
                .and_then(|e| e.as_sequence())
                .unwrap_or_else(|| panic!("missing environment sequence for {}", service_name));
            assert!(
                env.iter().any(|v| v.as_str() == Some("TZ=Europe/Warsaw")),
                "service {} missing TZ entry; got {:?}",
                service_name,
                env
            );
        }
    }

    #[test]
    fn test_inject_host_timezone_idempotent() {
        let yaml = "services:\n  claude:\n    environment:\n      - PORT=3000\n";
        let once = inject_host_timezone(yaml, "Europe/Warsaw").unwrap();
        let twice = inject_host_timezone(&once, "Europe/Warsaw").unwrap();
        let count = twice.matches("TZ=Europe/Warsaw").count();
        assert_eq!(count, 1, "TZ entry duplicated; got:\n{}", twice);
    }

    #[test]
    fn test_inject_host_timezone_does_not_overwrite_existing() {
        let yaml = "services:\n  claude:\n    environment:\n      - TZ=America/New_York\n";
        let result = inject_host_timezone(yaml, "Europe/Warsaw").unwrap();
        assert!(
            result.contains("TZ=America/New_York"),
            "existing TZ value clobbered; got:\n{}",
            result
        );
        assert!(
            !result.contains("TZ=Europe/Warsaw"),
            "duplicate TZ entry added; got:\n{}",
            result
        );
    }

    #[test]
    fn test_inject_host_timezone_preserves_existing_env() {
        let yaml = "services:\n  claude:\n    environment:\n      - PORT=3000\n      - DEBUG=1\n";
        let result = inject_host_timezone(yaml, "Europe/Warsaw").unwrap();
        assert!(result.contains("PORT=3000"));
        assert!(result.contains("DEBUG=1"));
        assert!(result.contains("TZ=Europe/Warsaw"));
    }

    #[test]
    fn test_inject_host_timezone_creates_environment_when_missing() {
        let yaml = "services:\n  claude:\n    image: foo\n";
        let result = inject_host_timezone(yaml, "Europe/Warsaw").unwrap();
        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&result).unwrap();
        let env = doc
            .get("services")
            .and_then(|s| s.get("claude"))
            .and_then(|c| c.get("environment"))
            .and_then(|e| e.as_sequence())
            .expect("environment sequence should be created");
        assert!(env.iter().any(|v| v.as_str() == Some("TZ=Europe/Warsaw")));
    }

    #[test]
    fn test_inject_host_timezone_handles_no_services_key() {
        let yaml = "version: '3'\n";
        let result = inject_host_timezone(yaml, "Europe/Warsaw");
        assert!(
            result.is_ok(),
            "should not error on compose without services"
        );
    }

    #[test]
    fn test_inject_host_timezone_propagates_parse_error() {
        let bad = "this is: not: yaml: : :";
        let result = inject_host_timezone(bad, "Europe/Warsaw");
        assert!(result.is_err());
        let msg = format!("{}", result.unwrap_err());
        assert!(
            msg.contains("failed to parse compose YAML"),
            "expected parse error message, got: {}",
            msg
        );
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn test_render_compose_propagates_tz_to_all_services() {
        let data_dir = tempfile::tempdir().unwrap();
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: default_flags(),
            llm: configured_anthropic_llm(),
            ..Default::default()
        };
        let yaml = render_compose_isolated(
            data_dir.path(),
            "test-project",
            tmp_project_dir(),
            &config,
            &ResolvedIntegrationsConfig::default(),
            None,
            &HostBridgesInfo::default(),
        )
        .unwrap();
        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&yaml).unwrap();
        let services = doc
            .get("services")
            .and_then(|s| s.as_mapping())
            .expect("services mapping");
        assert!(!services.is_empty(), "expected at least one service");
        for (name, service) in services {
            let service_name = name.as_str().unwrap_or("<non-string>");
            let env = service
                .get("environment")
                .and_then(|e| e.as_sequence())
                .unwrap_or_else(|| panic!("service {} has no environment sequence", service_name));
            assert!(
                env.iter()
                    .any(|v| { v.as_str().is_some_and(|s| s.starts_with("TZ=")) }),
                "service {} missing TZ env entry; got {:?}",
                service_name,
                env
            );
        }
    }

    // ── apply_auth_config: OAuth + API key + precedence ────────────────────

    /// Minimal compose YAML with just the claude service, so apply_auth_config can write into
    /// the environment sequence without dragging the whole template into the fixture.
    fn auth_test_yaml() -> &'static str {
        r#"
services:
  claude:
    image: speedwave-claude:latest
    environment:
      - CLAUDE_VERSION=1.0.3
"#
    }

    fn write_api_key_in(data_dir: &std::path::Path, project: &str, key: &str) {
        let dir = data_dir.join("secrets").join(project);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("anthropic_api_key"), key).unwrap();
    }

    #[test]
    fn apply_auth_config_in_api_key_only() {
        let tmp = tempfile::tempdir().unwrap();
        write_api_key_in(tmp.path(), "test", "sk-ant-api-1234");

        let result = apply_auth_config_in(auth_test_yaml(), "test", tmp.path()).unwrap();
        let has_api_key = result.contains("ANTHROPIC_API_KEY=sk-ant-api-1234");
        assert!(has_api_key, "API key must be injected when stored");
    }

    #[test]
    fn apply_auth_config_in_neither_present() {
        let tmp = tempfile::tempdir().unwrap();
        let result = apply_auth_config_in(auth_test_yaml(), "test", tmp.path()).unwrap();
        let has_api_key = result.contains("ANTHROPIC_API_KEY=");
        assert!(!has_api_key);
    }

    #[test]
    fn apply_auth_config_in_empty_api_key_returns_unchanged() {
        let tmp = tempfile::tempdir().unwrap();
        write_api_key_in(tmp.path(), "test", "");
        let result = apply_auth_config_in(auth_test_yaml(), "test", tmp.path()).unwrap();
        let has_api_key = result.contains("ANTHROPIC_API_KEY=");
        assert!(!has_api_key);
    }

    // ── SecurityCheck regression: CLAUDE_CODE_OAUTH_TOKEN allowlisted ──────

    #[test]
    fn test_security_check_oauth_token_allowed() {
        let data_dir = tempfile::tempdir().unwrap();
        let yaml = r#"
version: "3"
services:
  claude:
    image: speedwave-claude:latest
    read_only: true
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp:noexec,nosuid,size=512m
    environment:
      - CLAUDE_VERSION=1.0.3
      - CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-aaaaaaaaaaaaaaaaaaaa
"#;
        let violations = SecurityCheck::run_with_data_dir(
            yaml,
            "test",
            &[],
            &test_expected_paths(),
            data_dir.path(),
        );
        assert!(
            !violations
                .iter()
                .any(|v| v.rule == SecurityRule::NoTokensClaude),
            "CLAUDE_CODE_OAUTH_TOKEN must be allowlisted in claude container; got {:?}",
            violations
        );
    }

    #[test]
    fn test_security_check_other_token_still_blocked() {
        let data_dir = tempfile::tempdir().unwrap();
        // Defence-in-depth: allowlist must NOT widen to arbitrary *_TOKEN.
        // MCP_OS_AUTH_TOKEN must remain forbidden in claude container.
        let yaml = r#"
version: "3"
services:
  claude:
    image: speedwave-claude:latest
    read_only: true
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp:noexec,nosuid,size=512m
    environment:
      - CLAUDE_VERSION=1.0.3
      - MCP_OS_AUTH_TOKEN=secret-uuid
"#;
        let violations = SecurityCheck::run_with_data_dir(
            yaml,
            "test",
            &[],
            &test_expected_paths(),
            data_dir.path(),
        );
        assert!(
            violations
                .iter()
                .any(|v| v.rule == SecurityRule::NoTokensClaude),
            "MCP_OS_AUTH_TOKEN must still trigger NoTokensClaude violation"
        );
    }

    #[test]
    fn test_ensure_resources_dir_safe_accepts_real_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let plugin = tmp.path().join("plug");
        let resources = plugin.join("claude-resources");
        std::fs::create_dir_all(resources.join("skills")).unwrap();
        std::fs::write(resources.join("skills").join("ok.md"), b"hi").unwrap();
        super::ensure_resources_dir_safe(&plugin, &resources)
            .expect("real directory tree must be accepted");
    }

    #[cfg(unix)]
    #[test]
    fn test_ensure_resources_dir_safe_rejects_root_symlink() {
        let tmp = tempfile::tempdir().unwrap();
        let plugin = tmp.path().join("plug");
        std::fs::create_dir_all(&plugin).unwrap();
        // Symlink the entire claude-resources dir to /etc — without this check, the bind-mount
        // would surface /etc inside the claude container as /speedwave/plugins/<slug>/.
        let resources = plugin.join("claude-resources");
        std::os::unix::fs::symlink("/etc", &resources).unwrap();

        let err = super::ensure_resources_dir_safe(&plugin, &resources)
            .expect_err("symlinked claude-resources must be rejected");
        assert!(err.to_string().contains("symlink"));
    }

    #[cfg(unix)]
    #[test]
    fn test_ensure_resources_dir_safe_rejects_nested_symlink() {
        let tmp = tempfile::tempdir().unwrap();
        let plugin = tmp.path().join("plug");
        let resources = plugin.join("claude-resources");
        let skills = resources.join("skills");
        std::fs::create_dir_all(&skills).unwrap();
        // Real symlink deep in the tree — also fatal because the bind
        // mount surfaces every entry, including nested ones.
        std::os::unix::fs::symlink("/etc/passwd", skills.join("evil.md")).unwrap();

        let err = super::ensure_resources_dir_safe(&plugin, &resources)
            .expect_err("nested symlink in claude-resources must be rejected");
        assert!(err.to_string().contains("symlink"));
    }

    /// `claude-resources/` must be a real directory on disk, not a regular file.
    #[test]
    fn test_ensure_resources_dir_safe_rejects_non_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let plugin = tmp.path().join("plug");
        std::fs::create_dir_all(&plugin).unwrap();
        let resources = plugin.join("claude-resources");
        std::fs::write(&resources, b"not a dir").unwrap();

        let err = super::ensure_resources_dir_safe(&plugin, &resources)
            .expect_err("non-directory claude-resources must be rejected");
        assert!(err.to_string().contains("not a directory"));
    }

    // ── apply_plugins_from_verified — render-time invariants ─────────

    #[test]
    fn plugin_digests_env_reflects_tree_digest_and_keeps_slug_list_clean() {
        let tmp = tempfile::tempdir().unwrap();
        let plugin_dir = tmp.path().join("digplug");
        std::fs::create_dir_all(&plugin_dir).unwrap();
        let vp = fixture_verified_plugin("digplug", Some("digplug"), &plugin_dir, None);
        let mut integrations = crate::config::ResolvedIntegrationsConfig::default();
        integrations.plugins.insert("digplug".to_string(), true);
        let ctx = ApplyPluginsCtx {
            project_name: "proj",
            project_dir: "/tmp/proj",
            integrations: &integrations,
            network_name: "net",
            tokens_dir: tmp.path(),
            bridges: &Default::default(),
        };
        let out = apply_plugins_from_verified(VALID_COMPOSE, &ctx, &[vp]).unwrap();
        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&out).unwrap();
        let env = get_service_env_seq(&doc, "claude");
        // Slug list stays digest-free (entrypoint contract)...
        assert!(env.iter().any(|v| v == "SPEEDWAVE_PLUGINS=digplug"));
        // ...while the digest var changes claude's config-hash on plugin
        // upgrade, so the entrypoint re-runs and relinks plugin resources.
        assert!(env
            .iter()
            .any(|v| v == "SPW_PLUGIN_DIGESTS=digplug:f00ddeadbeefcafe"));
    }

    #[test]
    fn credentials_digest_pass_sits_between_filter_and_env_hardening() {
        let source = include_str!("mod.rs");
        let filter_pos = source
            .find("yaml = apply_integrations_filter(")
            .expect("filter pass must exist");
        let creds_pos = source
            .find("apply_credentials_digests_in(data_dir")
            .expect("credentials pass must be wired into render");
        let harden_pos = source
            .find("yaml = harden_env_scalar_quoting(")
            .expect("hardening pass must exist");
        assert!(
            filter_pos < creds_pos && creds_pos < harden_pos,
            "credentials digest must run on filtered services, before quoting"
        );
    }

    /// Minimal valid YAML doc for `apply_plugins_from_verified` to mutate; the shape mirrors
    /// `compose.template.yml` enough that the renderer finds `services.claude` and `services.mcp-hub`.
    fn fixture_compose_yaml() -> &'static str {
        r#"
services:
  claude:
    image: speedwave-claude:test
    environment: []
    volumes: []
  mcp-hub:
    image: speedwave-mcp-hub:test
    environment: []
"#
    }

    fn fixture_integrations_with_enabled(slug: &str) -> ResolvedIntegrationsConfig {
        let mut cfg = ResolvedIntegrationsConfig::default();
        cfg.plugins.insert(slug.to_string(), true);
        cfg
    }

    fn fixture_verified_plugin(
        slug: &str,
        service_id: Option<&str>,
        plugin_dir: &Path,
        mem_limit: Option<&str>,
    ) -> plugin::VerifiedPlugin {
        fixture_verified_plugin_full(slug, service_id, plugin_dir, mem_limit, None)
    }

    fn fixture_verified_plugin_full(
        slug: &str,
        service_id: Option<&str>,
        plugin_dir: &Path,
        mem_limit: Option<&str>,
        host_bridge: Option<plugin::HostBridgeManifest>,
    ) -> plugin::VerifiedPlugin {
        if service_id.is_some() {
            std::fs::create_dir_all(plugin_dir).ok();
            std::fs::write(plugin_dir.join("Containerfile"), b"FROM scratch").ok();
        }
        let manifest = plugin::PluginManifest {
            name: slug.into(),
            service_id: service_id.map(String::from),
            slug: slug.into(),
            version: "1.0.0".into(),
            description: "fixture".into(),
            port: None,
            image_tag: None,
            resources: vec![],
            token_mount: plugin::TokenMount::ReadOnly,
            auth_fields: vec![],
            settings_schema: None,
            speedwave_compat: None,
            extra_env: None,
            mem_limit: mem_limit.map(String::from),
            cpu_limit: None,
            requires_integrations: vec![],
            host_bridge,
            instructions: None,
            oauth: None,
        };
        plugin::VerifiedPlugin::new(
            manifest,
            plugin_dir.to_path_buf(),
            "f00ddeadbeefcafe0123456789abcdef".to_string(),
        )
    }

    fn fixture_host_bridge_manifest(url_env: &str, token_env: &str) -> plugin::HostBridgeManifest {
        // `validate_manifest` rejects empty roles, so seed one valid role.
        let roles = std::collections::HashMap::from([(
            "worker".to_string(),
            plugin::HostBridgeRoleAuth::Header {
                name: "x-bridge-auth".to_string(),
            },
        )]);
        plugin::HostBridgeManifest {
            url_env: url_env.into(),
            token_env: token_env.into(),
            roles,
            origin_policy: plugin::HostBridgeOriginPolicy::default(),
            max_frame_bytes: None,
            collision_policy: plugin::HostBridgeCollisionPolicy::default(),
            pending_slot_timeout_secs: None,
            display_name: "Fixture".into(),
            preferred_port: None,
            persistent_token: false,
        }
    }

    /// Plain manifest fixture for the `host_bridges_from_disk` unit tests — no on-disk plugin
    /// dir, no signature, just the fields the reconstruction logic reads.
    fn manifest_for_bridge_tests(
        slug: &str,
        host_bridge: Option<plugin::HostBridgeManifest>,
    ) -> plugin::PluginManifest {
        plugin::PluginManifest {
            name: slug.into(),
            service_id: Some(slug.into()),
            slug: slug.into(),
            version: "1.0.0".into(),
            description: "fixture".into(),
            port: None,
            image_tag: None,
            resources: vec![],
            token_mount: plugin::TokenMount::ReadOnly,
            auth_fields: vec![],
            settings_schema: None,
            speedwave_compat: None,
            extra_env: None,
            mem_limit: None,
            cpu_limit: None,
            requires_integrations: vec![],
            host_bridge,
            instructions: None,
            oauth: None,
        }
    }

    fn manifest_with_bridge_knobs(
        persistent_token: bool,
        preferred_port: Option<u16>,
    ) -> plugin::PluginManifest {
        let mut host_bridge = fixture_host_bridge_manifest(
            "EXAMPLE_PLUGIN_BRIDGE_URL",
            "EXAMPLE_PLUGIN_BRIDGE_TOKEN",
        );
        host_bridge.persistent_token = persistent_token;
        host_bridge.preferred_port = preferred_port;
        manifest_for_bridge_tests("example-plugin", Some(host_bridge))
    }

    #[test]
    fn build_host_bridge_registration_happy_path_mirrors_manifest() {
        let m = manifest_with_bridge_knobs(true, Some(60123));
        let reg = build_host_bridge_registration(&m, Some("tok-123".to_string()))
            .expect("eligible manifest + token must produce a registration");
        assert_eq!(reg.plugin_slug, "example-plugin");
        assert_eq!(reg.port, 60123);
        assert_eq!(reg.auth_token, "tok-123");
        assert_eq!(reg.url_env, "EXAMPLE_PLUGIN_BRIDGE_URL");
        assert_eq!(reg.token_env, "EXAMPLE_PLUGIN_BRIDGE_TOKEN");
    }

    #[test]
    fn build_host_bridge_registration_skips_ineligible_cases() {
        let eligible = manifest_with_bridge_knobs(true, Some(60123));

        // No token on disk (Desktop never minted it) → skipped.
        assert!(build_host_bridge_registration(&eligible, None).is_none());

        // persistent_token = false → not reconstructable off-process → skipped.
        let no_persist = manifest_with_bridge_knobs(false, Some(60123));
        assert!(build_host_bridge_registration(&no_persist, Some("tok".to_string())).is_none());

        // preferred_port = None → no stable port to address → skipped.
        let no_port = manifest_with_bridge_knobs(true, None);
        assert!(build_host_bridge_registration(&no_port, Some("tok".to_string())).is_none());

        // No host_bridge block at all → skipped.
        let no_bridge = manifest_for_bridge_tests("example-plugin", None);
        assert!(build_host_bridge_registration(&no_bridge, Some("tok".to_string())).is_none());
    }

    #[test]
    fn collect_host_bridges_keeps_all_eligible_with_token() {
        let first = manifest_with_bridge_knobs(true, Some(60123));
        let mut second = manifest_with_bridge_knobs(true, Some(60200));
        second.slug = "second-plugin".into();
        let ineligible = manifest_with_bridge_knobs(false, Some(60300));
        let no_token = manifest_with_bridge_knobs(true, Some(60400));

        // Two eligible plugins with an ineligible one interleaved — all
        // eligible registrations must survive, in input order.
        let info = collect_host_bridges([
            (&first, Some("tok-a".to_string())),
            (&ineligible, Some("tok-x".to_string())),
            (&second, Some("tok-b".to_string())),
            (&no_token, None),
        ]);
        assert_eq!(info.bridges.len(), 2);
        assert_eq!(info.bridges[0].plugin_slug, "example-plugin");
        assert_eq!(info.bridges[0].port, 60123);
        assert_eq!(info.bridges[1].plugin_slug, "second-plugin");
        assert_eq!(info.bridges[1].port, 60200);
    }

    #[test]
    fn host_bridges_from_disk_in_returns_empty_when_plugins_dir_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let info = host_bridges_from_disk_in(&tmp.path().join("plugins"));
        assert!(info.bridges.is_empty());
    }

    #[test]
    fn host_bridges_from_disk_in_degrades_to_empty_on_list_error() {
        // A file at the plugins-dir path makes read_dir fail — the
        // orchestrator must warn and degrade to an empty list, not propagate.
        let tmp = tempfile::tempdir().unwrap();
        let not_a_dir = tmp.path().join("plugins");
        std::fs::write(&not_a_dir, b"not a directory").unwrap();
        let info = host_bridges_from_disk_in(&not_a_dir);
        assert!(info.bridges.is_empty());
    }

    #[test]
    fn host_bridge_registration_debug_redacts_auth_token() {
        let m = manifest_with_bridge_knobs(true, Some(60123));
        let token = "11111111-2222-3333-4444-555555555555";
        let reg = build_host_bridge_registration(&m, Some(token.to_string()))
            .expect("eligible manifest + token must produce a registration");
        let dbg = format!("{reg:?}");
        assert!(
            !dbg.contains(token),
            "auth token must not appear in Debug output: {dbg}"
        );
        assert!(dbg.contains("REDACTED"));
        // Non-secret fields stay visible for diagnostics.
        assert!(dbg.contains("example-plugin"));
        assert!(dbg.contains("60123"));
    }

    /// `apply_plugins` re-runs `validate_manifest`, rejecting at render time a manifest
    /// that fails the ruleset (here: `mem_limit` above PLUGIN_MEM_LIMIT_MAX_MIB).
    #[test]
    fn test_apply_plugins_revalidates_manifest() {
        let tmp = tempfile::tempdir().unwrap();
        let plugin_dir = tmp.path().join("evil");
        std::fs::create_dir_all(&plugin_dir).unwrap();
        // 999g is far above the 16 GiB cap. Re-validation must reject.
        let vp = fixture_verified_plugin("evil", Some("evil"), &plugin_dir, Some("999g"));
        let cfg = fixture_integrations_with_enabled("evil");
        let result = super::apply_plugins_from_verified(
            fixture_compose_yaml(),
            &super::ApplyPluginsCtx {
                project_name: "test-project",
                project_dir: tmp_project_dir(),
                integrations: &cfg,
                network_name: "test-net",
                tokens_dir: tmp.path(),
                bridges: &super::HostBridgesInfo::default(),
            },
            &[vp],
        );
        let err = result.expect_err("oversized mem_limit must be rejected at render");
        assert!(err.to_string().contains("exceeds maximum"));
    }

    /// `apply_plugins` MUST reject a plugin whose derived compose name would overwrite an
    /// existing `services.<name>` entry (defence in depth beyond `validate_manifest`).
    #[test]
    fn test_apply_plugins_rejects_compose_name_collision() {
        let tmp = tempfile::tempdir().unwrap();
        let plugin_dir = tmp.path().join("decoy");
        std::fs::create_dir_all(&plugin_dir).unwrap();
        // Hand-built YAML pre-populating a plugin-produced service name, plus a plugin whose service_id derives it.
        let yaml = r#"
services:
  claude:
    image: speedwave-claude:test
    environment: []
    volumes: []
  mcp-hub:
    image: speedwave-mcp-hub:test
    environment: []
  mcp-decoy:
    image: pre-existing:test
"#;
        let cfg = fixture_integrations_with_enabled("decoy");
        let vp = fixture_verified_plugin("decoy", Some("decoy"), &plugin_dir, None);
        let err = super::apply_plugins_from_verified(
            yaml,
            &super::ApplyPluginsCtx {
                project_name: "test-project",
                project_dir: tmp_project_dir(),
                integrations: &cfg,
                network_name: "test-net",
                tokens_dir: tmp.path(),
                bridges: &super::HostBridgesInfo::default(),
            },
            &[vp],
        )
        .expect_err("collision must abort the render");
        assert!(
            err.to_string().contains("would overwrite"),
            "expected collision rejection, got: {err}"
        );
    }

    /// Sanity: a verified plugin that passes validate_manifest and doesn't collide renders (happy path).
    #[test]
    fn test_apply_plugins_renders_enabled_plugin() {
        let tmp = tempfile::tempdir().unwrap();
        let plugin_dir = tmp.path().join("ok-plugin");
        std::fs::create_dir_all(&plugin_dir).unwrap();
        let cfg = fixture_integrations_with_enabled("ok-plugin");
        let vp = fixture_verified_plugin("ok-plugin", Some("ok-plugin"), &plugin_dir, None);
        let yaml = super::apply_plugins_from_verified(
            fixture_compose_yaml(),
            &super::ApplyPluginsCtx {
                project_name: "test-project",
                project_dir: tmp_project_dir(),
                integrations: &cfg,
                network_name: "test-net",
                tokens_dir: tmp.path(),
                bridges: &super::HostBridgesInfo::default(),
            },
            &[vp],
        )
        .expect("happy path must render");
        assert!(
            yaml.contains("mcp-ok-plugin"),
            "rendered YAML must contain plugin service"
        );
        assert!(yaml.contains("SPEEDWAVE_PLUGINS=ok-plugin"));
    }

    /// A deeply-nested real directory tree under `claude-resources` is accepted
    /// (the canonicalize check must not be over-strict).
    #[test]
    fn test_ensure_resources_dir_safe_accepts_deep_nesting() {
        let tmp = tempfile::tempdir().unwrap();
        let plugin = tmp.path().join("plug");
        let deep = plugin.join("claude-resources/skills/sub/deeper");
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::write(deep.join("ok.md"), b"hi").unwrap();
        super::ensure_resources_dir_safe(&plugin, &plugin.join("claude-resources"))
            .expect("deep real-directory tree must be accepted");
    }

    // ── Host-bridge env injection (generic plugin host-bridge plumbing) ─────

    fn render_with_host_bridge_plugin(
        slug: &str,
        url_env: &str,
        token_env: &str,
        bridges: &super::HostBridgesInfo,
    ) -> anyhow::Result<String> {
        let tmp = tempfile::tempdir().unwrap();
        let plugin_dir = tmp.path().join(slug);
        std::fs::create_dir_all(&plugin_dir).unwrap();
        let vp = fixture_verified_plugin_full(
            slug,
            Some(slug),
            &plugin_dir,
            None,
            Some(fixture_host_bridge_manifest(url_env, token_env)),
        );
        let cfg = fixture_integrations_with_enabled(slug);
        super::apply_plugins_from_verified(
            fixture_compose_yaml(),
            &super::ApplyPluginsCtx {
                project_name: "test-project",
                project_dir: tmp_project_dir(),
                integrations: &cfg,
                network_name: "test-net",
                tokens_dir: tmp.path(),
                bridges,
            },
            &[vp],
        )
    }

    #[test]
    fn test_render_compose_default_bridges_omits_host_bridge_env() {
        let yaml = render_with_host_bridge_plugin(
            "example-plugin",
            "EXAMPLE_PLUGIN_BRIDGE_URL",
            "EXAMPLE_PLUGIN_BRIDGE_TOKEN",
            &super::HostBridgesInfo::default(),
        )
        .unwrap();
        assert!(
            !yaml.contains("EXAMPLE_PLUGIN_BRIDGE_URL"),
            "host-bridge env must NOT be injected when bridges is empty, got:\n{yaml}"
        );
        assert!(!yaml.contains("EXAMPLE_PLUGIN_BRIDGE_TOKEN"));
    }

    #[test]
    fn test_render_compose_with_host_bridge_registration_injects_url_and_token() {
        let bridges = super::HostBridgesInfo {
            bridges: vec![super::HostBridgeRegistration {
                plugin_slug: "example-plugin".to_string(),
                port: 54321,
                auth_token: "test-token-abc".to_string(),
                url_env: "EXAMPLE_PLUGIN_BRIDGE_URL".to_string(),
                token_env: "EXAMPLE_PLUGIN_BRIDGE_TOKEN".to_string(),
            }],
        };
        let yaml = render_with_host_bridge_plugin(
            "example-plugin",
            "EXAMPLE_PLUGIN_BRIDGE_URL",
            "EXAMPLE_PLUGIN_BRIDGE_TOKEN",
            &bridges,
        )
        .unwrap();
        // No `{yaml}` in any panic message: the render carries the auth token,
        // which must never reach a log/panic (CodeQL rust/cleartext-logging).
        assert!(
            yaml.contains("EXAMPLE_PLUGIN_BRIDGE_URL"),
            "EXAMPLE_PLUGIN_BRIDGE_URL must be injected"
        );
        assert!(
            yaml.contains("EXAMPLE_PLUGIN_BRIDGE_TOKEN"),
            "EXAMPLE_PLUGIN_BRIDGE_TOKEN must be injected"
        );
        assert!(yaml.contains("54321"), "port must appear in URL");
        assert!(yaml.contains("test-token-abc"), "token must appear in env");
    }

    // ── Local LLM: tokens_path / ensure_token_dir / read_local_llm_token /
    //    apply_llm_config for provider="local" ─────────────────────────────

    #[test]
    fn tokens_path_resolves_for_local_llm() {
        let dir = tempfile::tempdir().unwrap();
        let p = super::tokens_path_in(dir.path(), "myproj", "local-llm", "api_key").unwrap();
        let expected = dir
            .path()
            .join("tokens")
            .join("myproj")
            .join("local-llm")
            .join("api_key");
        assert_eq!(p, expected);
    }

    #[test]
    fn tokens_path_rejects_unknown_service() {
        let dir = tempfile::tempdir().unwrap();
        assert!(super::tokens_path_in(dir.path(), "myproj", "../etc", "api_key").is_err());
        assert!(super::tokens_path_in(dir.path(), "myproj", "slack", "token").is_err());
    }

    #[test]
    fn tokens_path_rejects_unknown_file() {
        let dir = tempfile::tempdir().unwrap();
        assert!(super::tokens_path_in(dir.path(), "myproj", "local-llm", "../passwd").is_err());
        assert!(super::tokens_path_in(dir.path(), "myproj", "local-llm", "random").is_err());
    }

    #[test]
    fn tokens_path_rejects_invalid_project_name() {
        let dir = tempfile::tempdir().unwrap();
        assert!(super::tokens_path_in(dir.path(), "../etc", "local-llm", "api_key").is_err());
    }

    // ── Proxy `llm` token namespace (ADR-073) ──────────────────────────

    #[test]
    fn llm_provider_key_path_resolves_for_valid_slug() {
        let dir = tempfile::tempdir().unwrap();
        let p =
            super::tokens::llm_provider_key_path_in(dir.path(), "myproj", "openrouter").unwrap();
        let expected = dir
            .path()
            .join("tokens")
            .join("myproj")
            .join("llm")
            .join("openrouter_api_key");
        assert_eq!(p, expected);
        // Hyphenated ids are valid slugs.
        assert!(
            super::tokens::llm_provider_key_path_in(dir.path(), "myproj", "my-anthropic").is_ok()
        );
    }

    #[test]
    fn llm_provider_key_path_rejects_traversal_and_bad_slugs() {
        let dir = tempfile::tempdir().unwrap();
        for bad in [
            "../passwd",
            "a/b",
            "a\\b",
            "UPPER",
            "Bad.Provider",
            "under_score",
            "",
            "1starts-with-digit",
        ] {
            assert!(
                super::tokens::llm_provider_key_path_in(dir.path(), "myproj", bad).is_err(),
                "provider id '{bad}' must be rejected"
            );
        }
    }

    #[test]
    fn llm_tokens_path_requires_api_key_suffix() {
        let dir = tempfile::tempdir().unwrap();
        assert!(super::tokens_path_in(dir.path(), "myproj", "llm", "openrouter_api_key").is_ok());
        assert!(super::tokens_path_in(dir.path(), "myproj", "llm", "openrouter").is_err());
        assert!(super::tokens_path_in(dir.path(), "myproj", "llm", "../escape_api_key").is_err());
    }

    #[test]
    fn ensure_token_dir_supports_llm_service() {
        let dir = tempfile::tempdir().unwrap();
        let service_dir = super::ensure_token_dir_in(dir.path(), "myproj", "llm").unwrap();
        assert!(service_dir.is_dir());
        assert!(service_dir.ends_with("tokens/myproj/llm"));
    }

    #[test]
    fn ensure_token_dir_creates_three_levels() {
        let dir = tempfile::tempdir().unwrap();
        let service_dir = super::ensure_token_dir_in(dir.path(), "myproj", "local-llm").unwrap();

        assert!(service_dir.is_dir());
        assert!(dir.path().join("tokens").is_dir());
        assert!(dir.path().join("tokens").join("myproj").is_dir());
        assert!(dir
            .path()
            .join("tokens")
            .join("myproj")
            .join("local-llm")
            .is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn ensure_token_dir_sets_0o700_on_all_levels() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        super::ensure_token_dir_in(dir.path(), "myproj", "local-llm").unwrap();

        for level in &[
            dir.path().join("tokens"),
            dir.path().join("tokens").join("myproj"),
            dir.path().join("tokens").join("myproj").join("local-llm"),
        ] {
            let mode = std::fs::metadata(level).unwrap().permissions().mode() & 0o777;
            assert_eq!(
                mode,
                0o700,
                "expected 0o700 at {}, got 0o{mode:o}",
                level.display()
            );
        }
    }

    #[test]
    fn ensure_token_dir_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        super::ensure_token_dir_in(dir.path(), "myproj", "local-llm").unwrap();
        // Second call must succeed and not change tree.
        super::ensure_token_dir_in(dir.path(), "myproj", "local-llm").unwrap();
    }

    #[test]
    fn apply_llm_config_local_provider_renders_with_dummy_when_no_key() {
        let data_dir = tempfile::tempdir().unwrap();
        // Kill-switch off: asserts the legacy direct-injection path's raw
        // base_url + "Local" display label, not the proxy-routed values.
        let mut llm = LlmConfig {
            provider: Some("local".to_string()),
            model: Some("my-model".to_string()),
            base_url: Some("http://host.docker.internal:8080/anthropic".to_string()),
            context_tokens: None,
            has_api_key: false,
            has_custom_headers: false,
            ..Default::default()
        };
        crate::config::migrate_llm(&mut llm, crate::config::AnthropicEvidence::None);
        llm.proxy_enabled = Some(false);
        let rendered =
            apply_llm_config_in(data_dir.path(), COMPOSE_TEMPLATE, &llm, "test-project").unwrap();
        let env = get_claude_env(&rendered);

        // Dummy token when has_api_key=false.
        assert!(
            env.iter()
                .any(|e| e == "ANTHROPIC_AUTH_TOKEN=sk-no-key-required"),
            "Expected dummy token, got env: {env:?}"
        );
        // Base URL with path prefix preserved.
        assert!(
            env.iter()
                .any(|e| e == "ANTHROPIC_BASE_URL=http://host.docker.internal:8080/anthropic"),
            "Base URL with path prefix lost, got env: {env:?}"
        );
        // Friendly label uses "Local".
        assert!(
            env.iter()
                .any(|e| e == "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME=my-model (Local)"),
            "Expected 'Local' display label, got env: {env:?}"
        );
        // Custom headers NOT injected when has_custom_headers=false.
        assert!(
            !env.iter()
                .any(|e| e.starts_with("ANTHROPIC_CUSTOM_HEADERS=")),
            "Custom headers must not be injected when flag is false, got env: {env:?}"
        );
    }

    #[test]
    fn test_render_compose_host_bridge_url_uses_host_docker_internal() {
        let bridges = super::HostBridgesInfo {
            bridges: vec![super::HostBridgeRegistration {
                plugin_slug: "example-plugin".to_string(),
                port: 54321,
                auth_token: "tok".to_string(),
                url_env: "EXAMPLE_PLUGIN_BRIDGE_URL".to_string(),
                token_env: "EXAMPLE_PLUGIN_BRIDGE_TOKEN".to_string(),
            }],
        };
        let yaml = render_with_host_bridge_plugin(
            "example-plugin",
            "EXAMPLE_PLUGIN_BRIDGE_URL",
            "EXAMPLE_PLUGIN_BRIDGE_TOKEN",
            &bridges,
        )
        .unwrap();
        // No `{yaml}`: this render carries the bridge auth token (cleartext-logging).
        assert!(
            yaml.contains("ws://host.docker.internal:54321/"),
            "URL must use host.docker.internal alias"
        );
    }

    #[test]
    fn apply_llm_config_local_uses_default_base_url_when_none() {
        let data_dir = tempfile::tempdir().unwrap();
        // Kill-switch off: asserts the legacy direct-injection path's raw
        // default_base_url, not the proxy-routed URL.
        let mut llm = LlmConfig {
            provider: Some("local".to_string()),
            model: Some("foo".to_string()),
            base_url: None,
            context_tokens: None,
            has_api_key: false,
            has_custom_headers: false,
            ..Default::default()
        };
        crate::config::migrate_llm(&mut llm, crate::config::AnthropicEvidence::None);
        llm.proxy_enabled = Some(false);
        let rendered =
            apply_llm_config_in(data_dir.path(), COMPOSE_TEMPLATE, &llm, "test-project").unwrap();
        let env = get_claude_env(&rendered);
        let expected = format!("ANTHROPIC_BASE_URL={}", default_base_url("local").unwrap());
        assert!(
            env.iter().any(|e| e == &expected),
            "Expected default base_url for 'local', got: {env:?}"
        );
    }

    #[test]
    fn test_render_compose_host_bridge_adds_extra_hosts_for_plugin_service() {
        let bridges = super::HostBridgesInfo {
            bridges: vec![super::HostBridgeRegistration {
                plugin_slug: "example-plugin".to_string(),
                port: 54321,
                auth_token: "tok".to_string(),
                url_env: "EXAMPLE_PLUGIN_BRIDGE_URL".to_string(),
                token_env: "EXAMPLE_PLUGIN_BRIDGE_TOKEN".to_string(),
            }],
        };
        let yaml = render_with_host_bridge_plugin(
            "example-plugin",
            "EXAMPLE_PLUGIN_BRIDGE_URL",
            "EXAMPLE_PLUGIN_BRIDGE_TOKEN",
            &bridges,
        )
        .unwrap();
        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&yaml).unwrap();
        let services = doc.get("services").and_then(|v| v.as_mapping()).unwrap();
        let mcp_example_plugin = services
            .get(serde_yaml_ng::Value::String(
                "mcp-example-plugin".to_string(),
            ))
            .and_then(|v| v.as_mapping())
            .expect("mcp-example-plugin service must be present");
        let extra_hosts = mcp_example_plugin
            .get(serde_yaml_ng::Value::String("extra_hosts".to_string()))
            .expect("mcp-example-plugin needs extra_hosts for host.docker.internal");
        let entries: Vec<String> = extra_hosts
            .as_sequence()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect();
        assert!(
            entries
                .iter()
                .any(|e| e.starts_with("host.docker.internal:")),
            "extra_hosts must include host.docker.internal entry, got: {entries:?}"
        );
    }

    #[test]
    fn test_apply_plugins_from_verified_skips_bridge_for_plugins_without_manifest() {
        let tmp = tempfile::tempdir().unwrap();
        let plugin_dir = tmp.path().join("notbridge");
        std::fs::create_dir_all(&plugin_dir).unwrap();
        let vp = fixture_verified_plugin("notbridge", Some("notbridge"), &plugin_dir, None);
        let bridges = super::HostBridgesInfo {
            bridges: vec![super::HostBridgeRegistration {
                plugin_slug: "notbridge".to_string(),
                port: 54321,
                auth_token: "tok".to_string(),
                url_env: "SOMETHING_URL".to_string(),
                token_env: "SOMETHING_TOKEN".to_string(),
            }],
        };
        let cfg = fixture_integrations_with_enabled("notbridge");
        let yaml = super::apply_plugins_from_verified(
            fixture_compose_yaml(),
            &super::ApplyPluginsCtx {
                project_name: "test-project",
                project_dir: tmp_project_dir(),
                integrations: &cfg,
                network_name: "test-net",
                tokens_dir: tmp.path(),
                bridges: &bridges,
            },
            &[vp],
        )
        .unwrap();
        // No `{yaml}`: the bridges list carries an auth token (cleartext-logging).
        assert!(
            !yaml.contains("SOMETHING_URL"),
            "plugin without host_bridge manifest must NOT receive bridge env"
        );
    }

    #[test]
    fn test_apply_plugins_from_verified_skips_bridge_when_no_registration_matches() {
        let tmp = tempfile::tempdir().unwrap();
        let plugin_dir = tmp.path().join("example-plugin");
        std::fs::create_dir_all(&plugin_dir).unwrap();
        let vp = fixture_verified_plugin_full(
            "example-plugin",
            Some("example-plugin"),
            &plugin_dir,
            None,
            Some(fixture_host_bridge_manifest(
                "EXAMPLE_PLUGIN_BRIDGE_URL",
                "EXAMPLE_PLUGIN_BRIDGE_TOKEN",
            )),
        );
        let bridges = super::HostBridgesInfo {
            bridges: vec![super::HostBridgeRegistration {
                plugin_slug: "other".to_string(),
                port: 54322,
                auth_token: "x".to_string(),
                url_env: "OTHER_URL".to_string(),
                token_env: "OTHER_TOKEN".to_string(),
            }],
        };
        let cfg = fixture_integrations_with_enabled("example-plugin");
        let yaml = super::apply_plugins_from_verified(
            fixture_compose_yaml(),
            &super::ApplyPluginsCtx {
                project_name: "test-project",
                project_dir: tmp_project_dir(),
                integrations: &cfg,
                network_name: "test-net",
                tokens_dir: tmp.path(),
                bridges: &bridges,
            },
            &[vp],
        )
        .unwrap();
        // No `{yaml}`: the bridges list carries an auth token (cleartext-logging).
        assert!(
            !yaml.contains("EXAMPLE_PLUGIN_BRIDGE_URL"),
            "example-plugin declares host_bridge but no registration matches its slug"
        );
    }

    #[test]
    fn default_base_url_for_local_matches_ollama() {
        // Both resolve to the same canonical default — `local` = "an Anthropic-Messages-speaking
        // server"; the Ollama port is the most common starting point.
        assert_eq!(default_base_url("local"), default_base_url("ollama"));
    }

    #[test]
    fn provider_display_label_local_returns_local() {
        assert_eq!(provider_display_label("local"), "Local");
    }

    /// Crash recovery: with an orphaned token file but `has_api_key=false` in config,
    /// `apply_llm_config` must ignore the file and fall back to the dummy.
    #[test]
    fn apply_llm_config_ignores_orphaned_token_when_flag_is_false() {
        let data_dir = tempfile::tempdir().unwrap();
        let project = format!("crash-recovery-{}", std::process::id());
        let dir = ensure_token_dir_in(data_dir.path(), &project, "local-llm")
            .expect("ensure_token_dir must succeed in test env");
        let api_key_path = dir.join("api_key");
        // Simulate the orphan: a token written by an interrupted save that
        // never reached config.json.
        crate::fs_perms::write_restricted_file_atomic(&api_key_path, "leaked-secret-from-crash")
            .expect("write must succeed");

        // Config carries `has_api_key=false` (crash before flag flip). Kill-switch
        // off: only the legacy direct-injection path reads the local-llm token file.
        let mut llm = LlmConfig {
            provider: Some("local".to_string()),
            model: Some("test-model".to_string()),
            base_url: Some("http://host.docker.internal:8080".to_string()),
            context_tokens: None,
            has_api_key: false,
            has_custom_headers: false,
            ..Default::default()
        };
        crate::config::migrate_llm(&mut llm, crate::config::AnthropicEvidence::None);
        llm.proxy_enabled = Some(false);
        let rendered =
            apply_llm_config_in(data_dir.path(), COMPOSE_TEMPLATE, &llm, &project).unwrap();
        let env = get_claude_env(&rendered);

        // Critical: dummy, not the orphaned secret.
        assert!(
            env.iter()
                .any(|e| e == "ANTHROPIC_AUTH_TOKEN=sk-no-key-required"),
            "Orphaned token file MUST NOT leak when has_api_key=false. \
             Got env: {env:?}"
        );
        assert!(
            !env.iter().any(|e| e.contains("leaked-secret-from-crash")),
            "Leaked secret must not appear in rendered YAML: {env:?}"
        );

        // Cleanup
        let _ = std::fs::remove_file(&api_key_path);
        let _ = std::fs::remove_dir(&dir);
    }

    /// Multi-line `ANTHROPIC_CUSTOM_HEADERS` must flatten to one comma-joined env entry present in
    /// the YAML list, single-line, every header intact, re-parsing cleanly (nerdctl rejects blocks).
    #[test]
    fn apply_llm_config_multiline_custom_headers_survives_yaml_roundtrip() {
        let data_dir = tempfile::tempdir().unwrap();
        let project = format!("custom-headers-roundtrip-{}", std::process::id());
        let dir = ensure_token_dir_in(data_dir.path(), &project, "local-llm")
            .expect("ensure_token_dir must succeed in test env");
        let headers_path = dir.join("custom_headers");
        let multiline = "X-Foo: bar\nX-Tenant-ID: acme\nOcp-Apim-Subscription-Key: secret-123";
        crate::fs_perms::write_restricted_file_atomic(&headers_path, multiline)
            .expect("write_restricted_file_atomic must succeed");

        let mut llm = LlmConfig {
            provider: Some("local".to_string()),
            model: Some("test-model".to_string()),
            base_url: Some("http://host.docker.internal:8080".to_string()),
            context_tokens: None,
            has_api_key: false,
            has_custom_headers: true,
            ..Default::default()
        };
        // has_custom_headers routes to the direct path regardless of the
        // kill-switch (the proxy would consume headers meant for the LLM server).
        crate::config::migrate_llm(&mut llm, crate::config::AnthropicEvidence::None);
        let rendered =
            apply_llm_config_in(data_dir.path(), COMPOSE_TEMPLATE, &llm, &project).unwrap();

        // Step 1: the env entry is present as a string.
        let env = get_claude_env(&rendered);
        let entry = env
            .iter()
            .find(|e| e.starts_with("ANTHROPIC_CUSTOM_HEADERS="))
            .unwrap_or_else(|| panic!("ANTHROPIC_CUSTOM_HEADERS not injected: {env:?}"));
        let value = entry
            .strip_prefix("ANTHROPIC_CUSTOM_HEADERS=")
            .expect("env entry must start with prefix");

        // Step 2: value is single-line, comma-joined, with every original
        // header preserved.
        assert!(
            !value.contains('\n'),
            "ANTHROPIC_CUSTOM_HEADERS must be a single line (nerdctl-compose \
             rejects block literals inside an environment: sequence), got: {value:?}"
        );
        for header in multiline.split('\n') {
            assert!(
                value.contains(header),
                "header {header:?} missing after flattening, got: {value:?}"
            );
        }
        // Step 3: full re-parse defends against future serialiser changes
        // that might re-introduce block literals.
        let _: serde_yaml_ng::Value = serde_yaml_ng::from_str(&rendered)
            .expect("rendered compose must re-parse — block-literal regression?");

        // Cleanup — best-effort, errors here would mask the assertion above.
        let _ = std::fs::remove_file(&headers_path);
        let _ = std::fs::remove_dir(&dir);
    }

    // ---- validate_compose_network_refs tests ------------------------------

    #[test]
    fn validate_network_refs_accepts_valid_topology() {
        let yaml = r#"
services:
  claude:
    networks:
      - speedwave_net
  hub:
    networks:
      - speedwave_net
      - speedwave_net_office
networks:
  speedwave_net:
    driver: bridge
  speedwave_net_office:
    driver: bridge
    internal: true
"#;
        validate_compose_network_refs(yaml).unwrap();
    }

    #[test]
    fn validate_network_refs_rejects_undefined_reference() {
        let yaml = r#"
services:
  claude:
    networks:
      - speedwave_speedwave_network
networks:
  speedwave_network:
    driver: bridge
"#;
        let err = validate_compose_network_refs(yaml).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("'claude'"), "missing service name: {msg}");
        assert!(
            msg.contains("'speedwave_speedwave_network'"),
            "missing offending ref: {msg}"
        );
        assert!(
            msg.contains("speedwave_network"),
            "missing declared-list: {msg}"
        );
    }

    #[test]
    fn validate_network_refs_handles_no_networks_block() {
        let yaml = r#"
services:
  claude:
    image: example
"#;
        validate_compose_network_refs(yaml).unwrap();
    }

    #[test]
    fn validate_network_refs_rejects_truncated_name() {
        // Production-observed truncations: speedwave_, spe, ..._offi.
        let yaml = r#"
services:
  claude:
    networks:
      - speedwave_
networks:
  speedwave_speedwave_network:
    driver: bridge
"#;
        let err = validate_compose_network_refs(yaml).unwrap_err();
        assert!(err.to_string().contains("'speedwave_'"));
    }

    #[test]
    fn validate_network_refs_handles_services_without_networks_field() {
        let yaml = r#"
services:
  claude: {}
  hub:
    networks:
      - net1
networks:
  net1:
    driver: bridge
"#;
        validate_compose_network_refs(yaml).unwrap();
    }

    #[test]
    fn validate_network_refs_accepts_map_form_networks_in_service() {
        // Compose spec allows `networks:` as a mapping (with aliases/ipv4_address)
        // — the validator must extract the keys as references.
        let yaml = r#"
services:
  claude:
    networks:
      net1:
        aliases:
          - claude.local
networks:
  net1:
    driver: bridge
"#;
        validate_compose_network_refs(yaml).unwrap();
    }

    #[test]
    fn validate_network_refs_accepts_null_networks() {
        // Compose spec: `networks: null` (or `~`) validly means "no network attachments" — must
        // not be confused with the "unknown YAML shape" render-bug branch.
        let yaml = r#"
services:
  claude:
    networks: null
networks:
  net1:
    driver: bridge
"#;
        validate_compose_network_refs(yaml).unwrap();
    }

    #[test]
    fn validate_network_refs_bails_on_unknown_yaml_shape() {
        // `networks:` is neither a sequence nor a mapping (here: a scalar) —
        // render bug or torn-write. Must bail explicitly, not silently pass.
        let yaml = r#"
services:
  claude:
    networks: just-a-string
networks:
  net1:
    driver: bridge
"#;
        let err = validate_compose_network_refs(yaml).unwrap_err();
        assert!(
            err.to_string().contains("neither a sequence nor a mapping"),
            "unknown shape must bail with descriptive error, got: {err}"
        );
    }

    #[test]
    fn save_compose_bails_on_invalid_in_memory_yaml() {
        let project = format!("save-validate-{}", std::process::id());
        let yaml = r#"
services:
  claude:
    networks:
      - bogus
networks:
  speedwave_net:
    driver: bridge
"#;
        let data_dir = tempfile::tempdir().unwrap();
        let err = super::save_compose_in(data_dir.path(), &project, yaml).unwrap_err();
        assert!(
            err.to_string().contains("in-memory YAML failed validation"),
            "expected in-memory diagnostic: {err}"
        );

        // Side-effect check: file should NOT have been written.
        let path = super::compose_output_path_in(data_dir.path(), &project).unwrap();
        assert!(
            !path.exists(),
            "compose.yml must not exist after pre-write bail"
        );
    }

    #[test]
    fn save_compose_bails_when_disk_content_diverges_from_memory() {
        // Test seam: FORCE_DISK_GARBAGE replaces read-back content with YAML that fails
        // network-ref validation, simulating virtiofs/9p propagation lag or a torn write.
        let project = format!("save-disk-divergence-{}", std::process::id());
        let valid_yaml = r#"
services:
  claude:
    networks:
      - speedwave_net
networks:
  speedwave_net:
    driver: bridge
"#;
        let corrupt_yaml = r#"
services:
  claude:
    networks:
      - speedwave_
networks:
  speedwave_net:
    driver: bridge
"#;
        let data_dir = tempfile::tempdir().unwrap();
        super::FORCE_DISK_GARBAGE.with(|c| *c.borrow_mut() = Some(corrupt_yaml.to_string()));
        let err = super::save_compose_in(data_dir.path(), &project, valid_yaml).unwrap_err();
        assert!(
            err.to_string().contains("disk content failed validation"),
            "expected disk-corruption diagnostic, got: {err}"
        );
        assert!(
            err.to_string().contains("in-memory length"),
            "expected length diagnostic, got: {err}"
        );
    }

    #[test]
    fn save_compose_read_back_io_error_has_actionable_context() {
        // Inject FORCE_DISK_GARBAGE = empty string (valid YAML); assert valid disk content does not fail read-back.
        let project = format!("save-readback-ok-{}", std::process::id());
        let valid_yaml = r#"
services:
  claude:
    networks:
      - speedwave_net
networks:
  speedwave_net:
    driver: bridge
"#;
        let data_dir = tempfile::tempdir().unwrap();
        super::FORCE_DISK_GARBAGE.with(|c| *c.borrow_mut() = Some(valid_yaml.to_string()));
        super::save_compose_in(data_dir.path(), &project, valid_yaml).unwrap();
    }
}
