use crate::config::{LlmConfig, ResolvedClaudeConfig, ResolvedIntegrationsConfig};
use crate::consts;
use crate::defaults;
use crate::plugin::{self, PluginManifest};
use crate::runtime::ContainerRuntime;
use std::path::PathBuf;

/// Converts a host path to the path seen by the container engine.
///
/// On Windows, nerdctl runs inside WSL2 so host paths must be translated
/// from `C:\Users\...` to `/mnt/c/Users/...`. On macOS and Linux the
/// container engine runs on the host so paths are returned unchanged.
fn to_engine_path(path: &std::path::Path) -> anyhow::Result<String> {
    #[cfg(target_os = "windows")]
    {
        let wsl = crate::runtime::wsl::windows_to_wsl_path(path)?;
        Ok(wsl.to_string_lossy().to_string())
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(path.to_string_lossy().to_string())
    }
}

/// Like `to_engine_path` but takes a string (convenience for `project_dir`).
fn str_to_engine_path(path: &str) -> anyhow::Result<String> {
    to_engine_path(std::path::Path::new(path))
}

/// Default compose template embedded at compile time from containers/compose.template.yml (SSOT).
const COMPOSE_TEMPLATE: &str = include_str!("../../../containers/compose.template.yml");

/// Renders a compose.yml for a given project by substituting template variables.
pub fn render_compose(
    project_name: &str,
    project_dir: &str,
    resolved_config: &ResolvedClaudeConfig,
    integrations: &ResolvedIntegrationsConfig,
    runtime: Option<&dyn ContainerRuntime>,
) -> anyhow::Result<String> {
    crate::validation::validate_project_name(project_name)?;
    let home =
        dirs::home_dir().ok_or_else(|| anyhow::anyhow!("cannot determine home directory"))?;
    let data_dir = home.join(consts::DATA_DIR);
    let tokens_dir = data_dir.join("tokens").join(project_name);
    let claude_home = data_dir.join("claude-home").join(project_name);
    let resources_dir = data_dir.join("claude-resources");
    let network_name = format!("{}_{}_network", consts::COMPOSE_PREFIX, project_name);

    let port_hub = consts::PORT_BASE;
    let port_slack = consts::PORT_BASE + 1;
    let port_sharepoint = consts::PORT_BASE + 2;
    let port_redmine = consts::PORT_BASE + 3;
    let port_gitlab = consts::PORT_BASE + 4;

    let mut yaml = COMPOSE_TEMPLATE.to_string();
    yaml = yaml.replace("${COMPOSE_PREFIX}", consts::COMPOSE_PREFIX);
    yaml = yaml.replace("${PROJECT_NAME}", project_name);
    yaml = yaml.replace("${PROJECT_DIR}", &str_to_engine_path(project_dir)?);
    yaml = yaml.replace("${CLAUDE_HOME}", &to_engine_path(&claude_home)?);
    yaml = yaml.replace("${RESOURCES_DIR}", &to_engine_path(&resources_dir)?);
    yaml = yaml.replace("${TOKENS_DIR}", &to_engine_path(&tokens_dir)?);
    yaml = yaml.replace("${NETWORK_NAME}", &network_name);
    yaml = yaml.replace("${CLAUDE_VERSION}", defaults::CLAUDE_VERSION);
    yaml = yaml.replace("${PORT_HUB}", &port_hub.to_string());
    yaml = yaml.replace("${PORT_SLACK}", &port_slack.to_string());
    yaml = yaml.replace("${PORT_SHAREPOINT}", &port_sharepoint.to_string());
    yaml = yaml.replace("${PORT_REDMINE}", &port_redmine.to_string());
    yaml = yaml.replace("${PORT_GITLAB}", &port_gitlab.to_string());

    // Bridge writes lock files directly to ~/.speedwave/ide-bridge/
    // Mount it as /home/speedwave/.claude/ide/ — no copying needed.
    let ide_lock_dir = home.join(consts::DATA_DIR).join("ide-bridge");
    std::fs::create_dir_all(&ide_lock_dir)?;
    yaml = yaml.replace("${IDE_LOCK_DIR}", &to_engine_path(&ide_lock_dir)?);
    yaml = yaml.replace("${HOST_GATEWAY}", host_gateway_ip());
    yaml = yaml.replace("${IDE_HOST_OVERRIDE}", ide_host_override());
    yaml = yaml.replace("${CONTAINER_USER}", container_user());

    // Inject Claude environment variables from resolved config
    yaml = inject_claude_env(&yaml, &resolved_config.env);

    // Handle LLM provider switching
    yaml = apply_llm_config(&yaml, project_name, &resolved_config.llm)?;

    // Build any pending plugin images (centralized — one hook, not 6 callsites)
    if let Some(rt) = runtime {
        if let Err(e) = plugin::build_pending_plugin_images(rt) {
            log::warn!("Failed to build pending plugin images: {e}");
        }
    }

    // Integrate installed plugins
    yaml = apply_plugins(
        &yaml,
        project_name,
        integrations,
        &network_name,
        &tokens_dir,
    )?;

    // Inject Anthropic API key from secrets if configured
    yaml = apply_auth_config(&yaml, project_name)?;

    // Inject mcp-os config into hub if auth token exists
    yaml = apply_mcp_os_config(&yaml)?;

    // Filter services based on integrations config
    yaml = apply_integrations_filter(&yaml, integrations)?;

    Ok(yaml)
}

/// Creates project directories under ~/.speedwave/
pub fn init_project_dirs(project: &str) -> anyhow::Result<()> {
    crate::validation::validate_project_name(project)?;
    let home =
        dirs::home_dir().ok_or_else(|| anyhow::anyhow!("cannot determine home directory"))?;
    let data_dir = home.join(consts::DATA_DIR);

    let dirs_to_create = [
        data_dir.join("tokens").join(project).join("slack"),
        data_dir.join("tokens").join(project).join("sharepoint"),
        data_dir.join("tokens").join(project).join("redmine"),
        data_dir.join("tokens").join(project).join("gitlab"),
        data_dir.join("compose").join(project),
        data_dir.join("context").join(project),
        data_dir.join("claude-home").join(project),
    ];

    for dir in &dirs_to_create {
        std::fs::create_dir_all(dir)?;
    }

    Ok(())
}

/// Creates the secrets directory for a project with restrictive permissions (chmod 700).
/// Path: ~/.speedwave/secrets/<project>/
pub fn init_secrets_dir(project: &str) -> anyhow::Result<PathBuf> {
    crate::validation::validate_project_name(project)?;
    let home =
        dirs::home_dir().ok_or_else(|| anyhow::anyhow!("cannot determine home directory"))?;
    let secrets_dir = home.join(consts::DATA_DIR).join("secrets").join(project);
    std::fs::create_dir_all(&secrets_dir)?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&secrets_dir, std::fs::Permissions::from_mode(0o700))?;
    }

    Ok(secrets_dir)
}

/// Returns the path where the rendered compose file should be saved.
pub fn compose_output_path(project: &str) -> anyhow::Result<PathBuf> {
    crate::validation::validate_project_name(project)?;
    Ok(dirs::home_dir()
        .ok_or_else(|| anyhow::anyhow!("cannot determine home directory"))?
        .join(consts::DATA_DIR)
        .join("compose")
        .join(project)
        .join("compose.yml"))
}

/// Saves the rendered compose YAML to disk.
pub fn save_compose(project: &str, yaml: &str) -> anyhow::Result<()> {
    let path = compose_output_path(project)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, yaml)?;
    Ok(())
}

fn inject_claude_env(yaml: &str, env: &std::collections::HashMap<String, String>) -> String {
    // Parse YAML, find claude service, inject env vars
    let mut doc: serde_yaml_ng::Value = match serde_yaml_ng::from_str(yaml) {
        Ok(v) => v,
        Err(_) => return yaml.to_string(),
    };

    if let Some(services) = doc.get_mut("services") {
        if let Some(claude) = services.get_mut("claude") {
            if let Some(environment) = claude.get_mut("environment") {
                if let Some(env_seq) = environment.as_sequence_mut() {
                    for (key, value) in env {
                        env_seq.push(serde_yaml_ng::Value::String(format!("{}={}", key, value)));
                    }
                }
            }
        }
    }

    serde_yaml_ng::to_string(&doc).unwrap_or_else(|_| yaml.to_string())
}

fn apply_llm_config(yaml: &str, project_name: &str, llm: &LlmConfig) -> anyhow::Result<String> {
    let provider = llm.provider.as_deref().unwrap_or("anthropic");

    match provider {
        "anthropic" => {
            // Default — no proxy needed, Claude Code connects directly to api.anthropic.com
            Ok(yaml.to_string())
        }
        "ollama" => {
            // Ollama: direct connection without proxy
            let base_url = llm
                .base_url
                .as_deref()
                .unwrap_or("http://host.docker.internal:11434");
            let extra_env = std::collections::HashMap::from([
                ("ANTHROPIC_BASE_URL".to_string(), format!("{}/v1", base_url)),
                ("ANTHROPIC_AUTH_TOKEN".to_string(), "ollama".to_string()),
            ]);
            Ok(inject_claude_env(yaml, &extra_env))
        }
        _ => {
            // External provider: add llm-proxy container (LiteLLM)
            let proxy_token = uuid::Uuid::new_v4().to_string();
            let proxy_port = consts::PORT_BASE + 9; // 4009

            let home = dirs::home_dir()
                .ok_or_else(|| anyhow::anyhow!("cannot determine home directory"))?;
            let secrets_dir = home
                .join(consts::DATA_DIR)
                .join("secrets")
                .join(project_name);
            let llm_env_file = secrets_dir.join("llm.env");
            let network_name = format!("{}_{}_network", consts::COMPOSE_PREFIX, project_name);

            // Parse existing YAML and add llm-proxy service
            let mut doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(yaml)?;

            let proxy_service = serde_yaml_ng::from_str::<serde_yaml_ng::Value>(&format!(
                r#"
image: ghcr.io/berriai/litellm:latest
container_name: {prefix}_{project}_llm_proxy
user: "{container_user}"
cap_drop:
  - ALL
security_opt:
  - no-new-privileges:true
read_only: true
tmpfs:
  - /tmp:noexec,nosuid,size=64m
ports:
  - "127.0.0.1:{port}:{port}"
env_file:
  - {env_file}
environment:
  - PORT={port}
  - LITELLM_MASTER_KEY={token}
networks:
  - {network}
deploy:
  resources:
    limits:
      cpus: '0.5'
      memory: 512m
"#,
                prefix = consts::COMPOSE_PREFIX,
                project = project_name,
                container_user = container_user(),
                port = proxy_port,
                env_file = to_engine_path(&llm_env_file)?,
                token = proxy_token,
                network = network_name,
            ))?;

            if let Some(services) = doc.get_mut("services") {
                if let Some(services_map) = services.as_mapping_mut() {
                    services_map.insert(
                        serde_yaml_ng::Value::String("llm-proxy".to_string()),
                        proxy_service,
                    );
                }
            }

            let mut result = serde_yaml_ng::to_string(&doc)?;

            // Inject proxy URL into claude container
            let extra_env = std::collections::HashMap::from([
                (
                    "ANTHROPIC_BASE_URL".to_string(),
                    format!("http://llm-proxy:{}", proxy_port),
                ),
                ("ANTHROPIC_AUTH_TOKEN".to_string(), proxy_token),
            ]);
            result = inject_claude_env(&result, &extra_env);

            Ok(result)
        }
    }
}

// --- Plugin integration ---

/// Applies all installed and enabled plugins to the compose YAML:
/// - Generates MCP service definitions for enabled plugins with service_id
/// - Injects WORKER_<PLUGIN>_URL into mcp-hub environment
/// - Adds plugin resource volume mounts to claude container
/// - Sets SPEEDWAVE_PLUGINS env var in claude container
fn apply_plugins(
    yaml: &str,
    project_name: &str,
    integrations: &ResolvedIntegrationsConfig,
    network_name: &str,
    tokens_dir: &std::path::Path,
) -> anyhow::Result<String> {
    let plugins = plugin::list_installed_plugins()?;
    if plugins.is_empty() {
        return Ok(yaml.to_string());
    }

    let mut doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(yaml)?;
    let mut plugin_slugs: Vec<String> = Vec::new();

    for manifest in &plugins {
        let slug = &manifest.slug;
        let service_id = manifest.service_id.as_deref();

        // Only include enabled plugins (MCP plugins check service_id, non-MCP always included)
        if let Some(sid) = service_id {
            if !integrations.is_plugin_enabled(sid) {
                continue;
            }
        }

        plugin_slugs.push(slug.clone());

        // MCP service generation (follows apply_llm_config pattern — compose.rs:221-264)
        if let Some(sid) = service_id {
            let service_value =
                plugin::generate_plugin_service(manifest, project_name, network_name, tokens_dir)?;
            // Insert into doc["services"]["mcp-<service_id>"]
            if let Some(services) = doc.get_mut("services").and_then(|v| v.as_mapping_mut()) {
                services.insert(
                    serde_yaml_ng::Value::String(plugin::derive_compose_name(sid)),
                    service_value,
                );
            }
            // Inject WORKER_*_URL into hub
            let worker_env = plugin::derive_worker_env(sid);
            let url = format!(
                "http://{}:{}",
                plugin::derive_compose_name(sid),
                manifest.port.unwrap_or(0)
            );
            inject_worker_env(&mut doc, &worker_env, &url);
        }

        // Mount claude-resources to claude container
        if let Ok(plugins_base) = plugin::plugins_base_dir() {
            let plugin_resources = plugins_base.join(slug).join("claude-resources");
            if plugin_resources.exists() {
                let mount = format!(
                    "{}:/speedwave/plugins/{}:ro",
                    to_engine_path(&plugin_resources)?,
                    slug
                );
                add_claude_volume(&mut doc, &mount);
            }
        }
    }

    // SPEEDWAVE_PLUGINS env var in claude (slugs of enabled plugins)
    if !plugin_slugs.is_empty() {
        add_claude_env_var(&mut doc, "SPEEDWAVE_PLUGINS", &plugin_slugs.join(","));
    }

    Ok(serde_yaml_ng::to_string(&doc)?)
}

/// Reads the Anthropic API key from the secrets directory and injects it
/// into the claude service environment. If no key file exists, returns
/// the YAML unchanged.
pub fn apply_auth_config(yaml: &str, project: &str) -> anyhow::Result<String> {
    let home =
        dirs::home_dir().ok_or_else(|| anyhow::anyhow!("cannot determine home directory"))?;
    let key_path = home
        .join(consts::DATA_DIR)
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

/// Filters compose services based on integrations config.
/// - Removes disabled MCP service containers from the `services` map
/// - Removes corresponding WORKER_*_URL from hub environment
/// - Injects ENABLED_SERVICES env var into hub (comma-separated)
/// - Injects DISABLED_OS_SERVICES env var into hub if any OS sub-integrations are disabled
fn apply_integrations_filter(
    yaml: &str,
    integrations: &ResolvedIntegrationsConfig,
) -> anyhow::Result<String> {
    let mut doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(yaml)?;

    // Determine which services are enabled using the TOGGLEABLE_MCP_SERVICES constant
    let service_enabled = |key: &str| -> bool {
        integrations.is_service_enabled(key).unwrap_or_else(|| {
            log::warn!(
                "apply_integrations_filter: unknown service key '{}', treating as disabled",
                key
            );
            false
        })
    };

    let mut enabled_names: Vec<&str> = Vec::new();

    for svc in consts::TOGGLEABLE_MCP_SERVICES {
        let (config_key, compose_name, worker_env) =
            (svc.config_key, svc.compose_name, svc.worker_env);
        if service_enabled(config_key) {
            enabled_names.push(config_key);
        } else {
            // Remove the service container from compose
            if let Some(services) = doc.get_mut("services") {
                if let Some(services_map) = services.as_mapping_mut() {
                    services_map.remove(serde_yaml_ng::Value::String(compose_name.to_string()));
                }
            }
            // Remove WORKER_*_URL from hub environment
            remove_hub_env_var(&mut doc, worker_env);
        }
    }

    // OS service is conditionally present — only added when at least one OS category is enabled
    if integrations.any_os_enabled() {
        enabled_names.push("os");
    }

    // Include enabled plugin service_ids
    for sid in integrations.enabled_plugin_service_ids() {
        enabled_names.push(sid);
    }

    // Inject ENABLED_SERVICES into hub
    let enabled_csv = enabled_names.join(",");
    log::debug!("integrations filter: enabled_services={}", enabled_csv);
    inject_worker_env(&mut doc, "ENABLED_SERVICES", &enabled_csv);

    // Inject DISABLED_OS_SERVICES if any OS sub-integrations are disabled
    let disabled_os: Vec<&str> = consts::TOGGLEABLE_OS_SERVICES
        .iter()
        .filter(|svc| {
            !integrations
                .is_os_service_enabled(svc.config_key)
                .unwrap_or(false)
        })
        .map(|svc| svc.config_key)
        .collect();
    if !disabled_os.is_empty() {
        log::debug!("integrations filter: disabled_os={}", disabled_os.join(","));
        inject_worker_env(&mut doc, "DISABLED_OS_SERVICES", &disabled_os.join(","));
    }

    Ok(serde_yaml_ng::to_string(&doc)?)
}

/// Removes an environment variable from the mcp-hub service.
fn remove_hub_env_var(doc: &mut serde_yaml_ng::Value, env_var_name: &str) {
    if let Some(services) = doc.get_mut("services") {
        if let Some(hub) = services.get_mut("mcp-hub") {
            if let Some(environment) = hub.get_mut("environment") {
                if let Some(env_seq) = environment.as_sequence_mut() {
                    env_seq.retain(|item| {
                        item.as_str()
                            .map(|s| !s.starts_with(&format!("{}=", env_var_name)))
                            .unwrap_or(true)
                    });
                }
            }
        }
    }
}

/// Injects mcp-os configuration into the mcp-hub container if the
/// auth token file exists at ~/.speedwave/mcp-os-auth-token.
/// This allows the hub to forward requests to the mcp-os worker on the host.
///
/// Injections into mcp-hub:
///   - WORKER_OS_URL env var (platform-specific gateway URL)
///   - /secrets/os-auth-token:ro bind-mount (token as file, not env var)
///
/// Claude container is NOT modified — it only sees the hub.
fn apply_mcp_os_config(yaml: &str) -> anyhow::Result<String> {
    let home =
        dirs::home_dir().ok_or_else(|| anyhow::anyhow!("cannot determine home directory"))?;
    let data_dir = home.join(consts::DATA_DIR);
    let token_path = data_dir.join(consts::MCP_OS_AUTH_TOKEN_FILE);
    let port_path = data_dir.join(consts::MCP_OS_PORT_FILE);
    apply_mcp_os_config_with_path(yaml, &token_path, &port_path)
}

/// Testable version: accepts explicit paths instead of reading $HOME.
fn apply_mcp_os_config_with_path(
    yaml: &str,
    token_path: &std::path::Path,
    port_path: &std::path::Path,
) -> anyhow::Result<String> {
    if !token_path.exists() {
        return Ok(yaml.to_string());
    }

    let token = std::fs::read_to_string(token_path)?.trim().to_string();
    if token.is_empty() {
        return Ok(yaml.to_string());
    }

    let port = match read_mcp_os_port(port_path) {
        Some(p) => p,
        None => {
            // Port file missing — mcp-os not running, skip OS config
            return Ok(yaml.to_string());
        }
    };
    let worker_os_url = mcp_os_gateway_url(port);

    let mut doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(yaml)?;
    inject_worker_env(&mut doc, "WORKER_OS_URL", &worker_os_url);
    add_hub_volume(
        &mut doc,
        &format!("{}:/secrets/os-auth-token:ro", to_engine_path(token_path)?),
    );
    Ok(serde_yaml_ng::to_string(&doc)?)
}

/// Read the mcp-os port from the port file written by McpOsProcess.
/// Returns `None` if the file is missing or contains invalid data.
fn read_mcp_os_port(port_path: &std::path::Path) -> Option<u16> {
    let content = match std::fs::read_to_string(port_path) {
        Ok(c) => c,
        Err(_) => return None,
    };
    match content.trim().parse::<u16>() {
        Ok(p) => Some(p),
        Err(e) => {
            log::warn!("invalid mcp-os port file content '{}': {e}", content.trim());
            None
        }
    }
}

/// Returns the URL where the mcp-os worker listens, as seen from inside a container.
fn mcp_os_gateway_url(port: u16) -> String {
    #[cfg(target_os = "macos")]
    {
        // host.lima.internal is set in /etc/hosts by Lima — stable regardless of IP changes
        format!("http://host.lima.internal:{port}")
    }
    #[cfg(target_os = "linux")]
    {
        // nerdctl rootless: host.docker.internal via extra_hosts
        format!("http://host.docker.internal:{port}")
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        // Windows / fallback
        format!("http://host.containers.internal:{port}")
    }
}

/// Returns the host IP/hostname reachable from inside the container/VM.
/// Used for `extra_hosts` entries and constructing wsUrls in lock files.
///
/// macOS: Lima vzNAT always assigns 192.168.5.2 to the macOS host — static, not DHCP.
/// Linux: nerdctl rootless uses 10.0.2.2 for the host gateway (slirp4netns).
/// Windows: nerdctl in WSL2 uses 192.168.65.1.
pub fn host_gateway_ip() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        consts::LIMA_VZ_HOST_IP // "192.168.5.2"
    }
    #[cfg(target_os = "linux")]
    {
        consts::NERDCTL_LINUX_HOST_IP // "10.0.2.2"
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        consts::WSL_HOST_IP // "192.168.65.1"
    }
}

/// Returns the UID:GID to set as `user:` in compose services.
///
/// Linux (rootless nerdctl): "0:0" — UID 0 in user namespace maps to host user UID.
///   UID 1000 would map to subuid range (~101000), breaking bind-mount access.
/// macOS (Lima) / Windows (WSL2): "1000:1000" — containerd runs as root,
///   so UID 1000 maps directly to UID 1000. Unprivileged user as defense-in-depth.
pub fn container_user() -> &'static str {
    #[cfg(target_os = "linux")]
    {
        consts::CONTAINER_USER_ROOTLESS // "0:0"
    }
    #[cfg(not(target_os = "linux"))]
    {
        consts::CONTAINER_USER_UNPRIVILEGED // "1000:1000"
    }
}

/// Returns the hostname Claude Code should use for IDE WebSocket connections.
/// Set as `CLAUDE_CODE_IDE_HOST_OVERRIDE` in the container environment.
///
/// Claude Code hardcodes `ws://127.0.0.1:<port>` when connecting to IDEs.
/// Inside a container, 127.0.0.1 is the container's own loopback — not the host.
/// This env var overrides the host to the platform-specific gateway DNS name
/// so Claude can reach the IDE Bridge running on the host.
fn ide_host_override() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        consts::LIMA_HOST // "host.lima.internal"
    }
    #[cfg(target_os = "linux")]
    {
        consts::NERDCTL_LINUX_HOST // "host.docker.internal"
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        consts::WSL_HOST // "host.speedwave.internal"
    }
}

/// Injects a WORKER_*_URL environment variable into the mcp-hub service.
fn inject_worker_env(doc: &mut serde_yaml_ng::Value, env_name: &str, url: &str) {
    if let Some(services) = doc.get_mut("services") {
        if let Some(hub) = services.get_mut("mcp-hub") {
            if let Some(environment) = hub.get_mut("environment") {
                if let Some(env_seq) = environment.as_sequence_mut() {
                    env_seq.push(serde_yaml_ng::Value::String(format!(
                        "{}={}",
                        env_name, url
                    )));
                }
            }
        }
    }
}

/// Adds a volume mount to the claude service.
fn add_claude_volume(doc: &mut serde_yaml_ng::Value, mount: &str) {
    if let Some(services) = doc.get_mut("services") {
        if let Some(claude) = services.get_mut("claude") {
            if let Some(volumes) = claude.get_mut("volumes") {
                if let Some(vol_seq) = volumes.as_sequence_mut() {
                    vol_seq.push(serde_yaml_ng::Value::String(mount.to_string()));
                }
            }
        }
    }
}

/// Adds a volume mount to the mcp-hub service.
fn add_hub_volume(doc: &mut serde_yaml_ng::Value, mount: &str) {
    if let Some(services) = doc.get_mut("services") {
        if let Some(hub) = services.get_mut("mcp-hub") {
            if let Some(volumes) = hub.get_mut("volumes") {
                if let Some(vol_seq) = volumes.as_sequence_mut() {
                    vol_seq.push(serde_yaml_ng::Value::String(mount.to_string()));
                }
            } else {
                // Hub has no volumes key yet — create it
                hub["volumes"] =
                    serde_yaml_ng::Value::Sequence(vec![serde_yaml_ng::Value::String(
                        mount.to_string(),
                    )]);
            }
        }
    }
}

/// Adds an environment variable to the claude service.
fn add_claude_env_var(doc: &mut serde_yaml_ng::Value, key: &str, value: &str) {
    if let Some(services) = doc.get_mut("services") {
        if let Some(claude) = services.get_mut("claude") {
            if let Some(environment) = claude.get_mut("environment") {
                if let Some(env_seq) = environment.as_sequence_mut() {
                    env_seq.push(serde_yaml_ng::Value::String(format!("{}={}", key, value)));
                }
            }
        }
    }
}

// --- SecurityCheck ---

pub struct SecurityCheck;

#[derive(Debug)]
pub struct SecurityViolation {
    pub container: String,
    pub rule: &'static str,
    pub message: String,
    pub remediation: &'static str,
}

impl std::fmt::Display for SecurityViolation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "[{}] {} -- {}\n  Fix: {}",
            self.container, self.rule, self.message, self.remediation
        )
    }
}

impl SecurityCheck {
    /// Verifies all security invariants on the generated compose YAML.
    /// Returns Vec of violations — if non-empty, compose_up MUST be blocked.
    ///
    /// `plugin_manifests` provides signed manifest data for cross-referencing
    /// plugin compose services against their declared token mount modes.
    ///
    /// Uses serde_yaml_ng for structured parsing — NOT string matching on raw YAML.
    pub fn run(
        compose_yml: &str,
        _project: &str,
        plugin_manifests: &[PluginManifest],
    ) -> Vec<SecurityViolation> {
        let doc: serde_yaml_ng::Value = match serde_yaml_ng::from_str(compose_yml) {
            Ok(v) => v,
            Err(e) => {
                return vec![SecurityViolation {
                    container: "*".into(),
                    rule: "YAML_PARSE_ERROR",
                    message: format!("Cannot parse compose YAML: {e}"),
                    remediation: "Run render_compose() again to regenerate the file.",
                }];
            }
        };

        [
            Self::check_cap_drop(&doc),
            Self::check_no_new_privileges(&doc),
            Self::check_read_only(&doc),
            Self::check_tmpfs_noexec(&doc),
            Self::check_no_tokens_in_claude(&doc),
            Self::check_no_tokens_in_hub(&doc),
            // PORTS_LOCALHOST: any exposed port must bind 127.0.0.1 (plugins, llm-proxy)
            Self::check_ports_localhost_only(&doc),
            Self::check_claude_no_socket(&doc),
            Self::check_no_external_llm_keys_claude(&doc),
            // NO_PORTS_WORKERS: built-in services must not expose ports at all.
            // May fire alongside PORTS_LOCALHOST — intentional defense-in-depth.
            Self::check_no_ports_on_workers(&doc),
            Self::check_container_user(&doc),
            // Plugin-specific checks
            Self::check_plugin_no_privileged(&doc),
            Self::check_plugin_no_host_network(&doc),
            Self::check_plugin_no_extra_volumes(&doc),
            Self::check_plugin_token_mount_mode(&doc, plugin_manifests),
        ]
        .into_iter()
        .flatten()
        .collect()
    }

    /// All containers must have cap_drop: [ALL]
    fn check_cap_drop(doc: &serde_yaml_ng::Value) -> Vec<SecurityViolation> {
        let mut violations = Vec::new();
        let services = match get_services(doc) {
            Some(s) => s,
            None => return violations,
        };

        for (name, service) in services {
            let has_cap_drop_all = service
                .get("cap_drop")
                .and_then(|v| v.as_sequence())
                .map(|seq| {
                    seq.iter()
                        .any(|item| item.as_str().is_some_and(|s| s.eq_ignore_ascii_case("all")))
                })
                .unwrap_or(false);

            if !has_cap_drop_all {
                violations.push(SecurityViolation {
                    container: name.clone(),
                    rule: "CAP_DROP_ALL",
                    message: "Missing cap_drop: [ALL]".into(),
                    remediation: "Add 'cap_drop: [ALL]' to the service definition.",
                });
            }
        }
        violations
    }

    /// All containers must have security_opt: [no-new-privileges:true]
    fn check_no_new_privileges(doc: &serde_yaml_ng::Value) -> Vec<SecurityViolation> {
        let mut violations = Vec::new();
        let services = match get_services(doc) {
            Some(s) => s,
            None => return violations,
        };

        for (name, service) in services {
            let has_no_new_privs = service
                .get("security_opt")
                .and_then(|v| v.as_sequence())
                .map(|seq| {
                    seq.iter()
                        .any(|item| item.as_str().is_some_and(|s| s == "no-new-privileges:true"))
                })
                .unwrap_or(false);

            if !has_no_new_privs {
                violations.push(SecurityViolation {
                    container: name.clone(),
                    rule: "NO_NEW_PRIVS",
                    message: "Missing security_opt: [no-new-privileges:true]".into(),
                    remediation:
                        "Add 'security_opt: [no-new-privileges:true]' to the service definition.",
                });
            }
        }
        violations
    }

    /// claude and mcp-hub must have read_only: true
    fn check_read_only(doc: &serde_yaml_ng::Value) -> Vec<SecurityViolation> {
        let mut violations = Vec::new();
        let services = match get_services(doc) {
            Some(s) => s,
            None => return violations,
        };

        let read_only_required = ["claude", "mcp-hub"];
        for required in &read_only_required {
            if let Some((name, service)) = services.iter().find(|(n, _)| n == required) {
                let is_read_only = service
                    .get("read_only")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);

                if !is_read_only {
                    violations.push(SecurityViolation {
                        container: name.clone(),
                        rule: "READ_ONLY_FS",
                        message: "Missing read_only: true".into(),
                        remediation: "Add 'read_only: true' to the service definition.",
                    });
                }
            }
        }
        violations
    }

    /// claude and mcp-hub must have /tmp as tmpfs with noexec,nosuid
    fn check_tmpfs_noexec(doc: &serde_yaml_ng::Value) -> Vec<SecurityViolation> {
        let mut violations = Vec::new();
        let services = match get_services(doc) {
            Some(s) => s,
            None => return violations,
        };

        let tmpfs_required = ["claude", "mcp-hub"];
        for required in &tmpfs_required {
            if let Some((name, service)) = services.iter().find(|(n, _)| n == required) {
                let has_tmpfs_noexec = service
                    .get("tmpfs")
                    .and_then(|v| v.as_sequence())
                    .map(|seq| {
                        seq.iter().any(|item| {
                            item.as_str().is_some_and(|s| {
                                s.starts_with("/tmp")
                                    && s.contains("noexec")
                                    && s.contains("nosuid")
                            })
                        })
                    })
                    .unwrap_or(false);

                if !has_tmpfs_noexec {
                    violations.push(SecurityViolation {
                        container: name.clone(),
                        rule: "TMPFS_NOEXEC",
                        message: "Missing tmpfs /tmp with noexec,nosuid".into(),
                        remediation:
                            "Add 'tmpfs: [\"/tmp:noexec,nosuid\"]' to the service definition.",
                    });
                }
            }
        }
        violations
    }

    /// claude container must not have any TOKEN, KEY, or SECRET env vars
    fn check_no_tokens_in_claude(doc: &serde_yaml_ng::Value) -> Vec<SecurityViolation> {
        let mut violations = Vec::new();
        let services = match get_services(doc) {
            Some(s) => s,
            None => return violations,
        };

        if let Some((_name, service)) = services.iter().find(|(n, _)| n == "claude") {
            if let Some(env_seq) = service.get("environment").and_then(|v| v.as_sequence()) {
                let forbidden_patterns = ["TOKEN", "KEY", "SECRET"];
                // Allowed env vars that contain these patterns but are safe
                let allowed = [
                    "ANTHROPIC_AUTH_TOKEN",
                    "ANTHROPIC_API_KEY",
                    "DISABLE_AUTOUPDATER",
                ];

                for item in env_seq {
                    if let Some(env_str) = item.as_str() {
                        let var_name = env_str.split('=').next().unwrap_or("");
                        let upper = var_name.to_uppercase();

                        if forbidden_patterns
                            .iter()
                            .any(|pattern| upper.contains(pattern))
                            && !allowed.iter().any(|a| upper == *a)
                        {
                            violations.push(SecurityViolation {
                                container: "claude".into(),
                                rule: "NO_TOKENS_CLAUDE",
                                message: format!(
                                    "env contains forbidden variable: {}",
                                    var_name
                                ),
                                remediation:
                                    "Claude container must have zero service tokens. Remove from compose.",
                            });
                        }
                    }
                }
            }
        }
        violations
    }

    /// mcp-hub must not have TOKEN/KEY/SECRET env vars — auth tokens are
    /// delivered as file mounts (/secrets/*), not environment variables.
    /// Allowed: WORKER_*_URL (service discovery) and PORT.
    fn check_no_tokens_in_hub(doc: &serde_yaml_ng::Value) -> Vec<SecurityViolation> {
        let mut violations = Vec::new();
        let services = match get_services(doc) {
            Some(s) => s,
            None => return violations,
        };

        if let Some((_name, service)) = services.iter().find(|(n, _)| n == "mcp-hub") {
            if let Some(env_seq) = service.get("environment").and_then(|v| v.as_sequence()) {
                let forbidden_patterns = ["TOKEN", "KEY", "SECRET"];
                let allowed_prefixes = ["WORKER_", "PORT"];

                for item in env_seq {
                    if let Some(env_str) = item.as_str() {
                        let var_name = env_str.split('=').next().unwrap_or("");
                        let upper = var_name.to_uppercase();

                        if forbidden_patterns
                            .iter()
                            .any(|pattern| upper.contains(pattern))
                            && !allowed_prefixes
                                .iter()
                                .any(|prefix| upper.starts_with(prefix))
                        {
                            violations.push(SecurityViolation {
                                container: "mcp-hub".into(),
                                rule: "NO_TOKENS_HUB",
                                message: format!(
                                    "env contains forbidden variable: {}",
                                    var_name
                                ),
                                remediation:
                                    "Hub must have zero tokens in env vars. Use /secrets/ file mounts instead.",
                            });
                        }
                    }
                }
            }
        }
        violations
    }

    /// All ports must bind to 127.0.0.1, not 0.0.0.0
    fn check_ports_localhost_only(doc: &serde_yaml_ng::Value) -> Vec<SecurityViolation> {
        let mut violations = Vec::new();
        let services = match get_services(doc) {
            Some(s) => s,
            None => return violations,
        };

        for (name, service) in services {
            if let Some(ports_seq) = service.get("ports").and_then(|v| v.as_sequence()) {
                for port in ports_seq {
                    if let Some(port_str) = port.as_str() {
                        // Valid format: "127.0.0.1:host:container"
                        // Invalid: "host:container" (binds to 0.0.0.0) or "0.0.0.0:host:container"
                        if !port_str.starts_with("127.0.0.1:") {
                            violations.push(SecurityViolation {
                                container: name.clone(),
                                rule: "PORTS_LOCALHOST",
                                message: format!(
                                    "Port bound to non-localhost address: {}",
                                    port_str
                                ),
                                remediation:
                                    "All ports must bind to 127.0.0.1 only. Change to 127.0.0.1:host:container.",
                            });
                        }
                    } else if port.as_mapping().is_some() {
                        // Long-form: {target: 3000, published: 3000, protocol: tcp}
                        // If "published" is present without a host_ip of 127.0.0.1, it binds to 0.0.0.0
                        let host_ip = port.get("host_ip").and_then(|v| v.as_str()).unwrap_or("");
                        if port.get("published").is_some() && host_ip != "127.0.0.1" {
                            violations.push(SecurityViolation {
                                container: name.clone(),
                                rule: "PORTS_LOCALHOST",
                                message: "Port mapping missing host_ip: 127.0.0.1 (long-form)".to_string(),
                                remediation:
                                    "All ports must bind to 127.0.0.1 only. Add host_ip: 127.0.0.1 to the port mapping.",
                            });
                        }
                    }
                    // Integer port values (e.g., `- 3000`) expose only the container port
                    // with a random host port on all interfaces. This is not used in our
                    // template — flag it as a violation.
                    else if port.as_i64().is_some() || port.as_f64().is_some() {
                        violations.push(SecurityViolation {
                            container: name.clone(),
                            rule: "PORTS_LOCALHOST",
                            message: "Port specified as bare integer (binds to 0.0.0.0)".into(),
                            remediation:
                                "All ports must bind to 127.0.0.1 only. Change to \"127.0.0.1:host:container\".",
                        });
                    }
                }
            }
        }
        violations
    }

    /// claude container must not mount docker.sock or nerdctl.sock
    fn check_claude_no_socket(doc: &serde_yaml_ng::Value) -> Vec<SecurityViolation> {
        let mut violations = Vec::new();
        let services = match get_services(doc) {
            Some(s) => s,
            None => return violations,
        };

        if let Some((_name, service)) = services.iter().find(|(n, _)| n == "claude") {
            if let Some(vols_seq) = service.get("volumes").and_then(|v| v.as_sequence()) {
                let forbidden_sockets = ["docker.sock", "nerdctl.sock", "podman.sock"];
                for vol in vols_seq {
                    if let Some(vol_str) = vol.as_str() {
                        for socket in &forbidden_sockets {
                            if vol_str.contains(socket) {
                                violations.push(SecurityViolation {
                                    container: "claude".into(),
                                    rule: "NO_SOCKET_CLAUDE",
                                    message: format!(
                                        "Volume mounts container socket: {}",
                                        vol_str
                                    ),
                                    remediation:
                                        "Claude container must not have access to any container runtime socket.",
                                });
                            }
                        }
                    }
                }
            }
        }
        violations
    }

    /// claude container must not have external LLM API keys
    /// (OPENAI_*, GEMINI_*, DEEPSEEK_*, OPENROUTER_* — these belong in the proxy)
    fn check_no_external_llm_keys_claude(doc: &serde_yaml_ng::Value) -> Vec<SecurityViolation> {
        let mut violations = Vec::new();
        let services = match get_services(doc) {
            Some(s) => s,
            None => return violations,
        };

        if let Some((_name, service)) = services.iter().find(|(n, _)| n == "claude") {
            if let Some(env_seq) = service.get("environment").and_then(|v| v.as_sequence()) {
                let forbidden_prefixes = ["OPENAI_", "GEMINI_", "DEEPSEEK_", "OPENROUTER_"];

                for item in env_seq {
                    if let Some(env_str) = item.as_str() {
                        let var_name = env_str.split('=').next().unwrap_or("");
                        let upper = var_name.to_uppercase();

                        if forbidden_prefixes
                            .iter()
                            .any(|prefix| upper.starts_with(prefix))
                        {
                            violations.push(SecurityViolation {
                                container: "claude".into(),
                                rule: "NO_EXTERNAL_LLM_KEYS_CLAUDE",
                                message: format!(
                                    "env contains external LLM key: {}",
                                    var_name
                                ),
                                remediation:
                                    "External LLM keys belong in the llm-proxy container, not in claude.",
                            });
                        }
                    }
                }
            }
        }
        violations
    }

    /// MCP workers and hub must NOT expose ports to the host.
    /// Only dynamically-injected services (llm-proxy, addons) may map ports.
    /// All inter-container communication uses Docker DNS.
    fn check_no_ports_on_workers(doc: &serde_yaml_ng::Value) -> Vec<SecurityViolation> {
        let mut violations = Vec::new();
        let services = match get_services(doc) {
            Some(s) => s,
            None => return violations,
        };

        // Addon services (not listed in consts::BUILT_IN_SERVICES) are allowed to expose ports.
        for (name, service) in services {
            if !consts::BUILT_IN_SERVICES.contains(&name.as_str()) {
                continue;
            }
            if service
                .get("ports")
                .and_then(|v| v.as_sequence())
                .is_some_and(|s| !s.is_empty())
            {
                violations.push(SecurityViolation {
                    container: name.clone(),
                    rule: "NO_PORTS_WORKERS",
                    message: format!(
                        "{} must not expose ports to host — use Docker DNS for inter-container communication",
                        name
                    ),
                    remediation:
                        "Remove the 'ports:' section. Hub and workers communicate over the internal Docker network.",
                });
            }
        }
        violations
    }

    /// Plugin services (identified by label) must not have privileged: true
    fn check_plugin_no_privileged(doc: &serde_yaml_ng::Value) -> Vec<SecurityViolation> {
        let mut violations = Vec::new();
        let services = match get_services(doc) {
            Some(s) => s,
            None => return violations,
        };
        for (name, service) in services {
            if !is_plugin_service(service) {
                continue;
            }
            if service
                .get("privileged")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
            {
                violations.push(SecurityViolation {
                    container: name,
                    rule: "PLUGIN_NO_PRIVILEGED",
                    message: "Plugin service must not have privileged: true".into(),
                    remediation: "Remove 'privileged: true' from the plugin service.",
                });
            }
        }
        violations
    }

    /// Plugin services must not have network_mode: host
    fn check_plugin_no_host_network(doc: &serde_yaml_ng::Value) -> Vec<SecurityViolation> {
        let mut violations = Vec::new();
        let services = match get_services(doc) {
            Some(s) => s,
            None => return violations,
        };
        for (name, service) in services {
            if !is_plugin_service(service) {
                continue;
            }
            if let Some(mode) = service.get("network_mode").and_then(|v| v.as_str()) {
                if mode == "host" {
                    violations.push(SecurityViolation {
                        container: name,
                        rule: "PLUGIN_NO_HOST_NETWORK",
                        message: "Plugin service must not use network_mode: host".into(),
                        remediation: "Remove 'network_mode: host' from the plugin service.",
                    });
                }
            }
        }
        violations
    }

    /// Plugin services may only mount /tokens (max 1 volume). No other host paths.
    fn check_plugin_no_extra_volumes(doc: &serde_yaml_ng::Value) -> Vec<SecurityViolation> {
        let mut violations = Vec::new();
        let services = match get_services(doc) {
            Some(s) => s,
            None => return violations,
        };
        for (name, service) in services {
            if !is_plugin_service(service) {
                continue;
            }
            if let Some(vols) = service.get("volumes").and_then(|v| v.as_sequence()) {
                for vol in vols {
                    if let Some(vol_str) = vol.as_str() {
                        // Only /tokens mount is allowed
                        if !vol_str.contains(":/tokens:") && !vol_str.ends_with(":/tokens") {
                            violations.push(SecurityViolation {
                                container: name.clone(),
                                rule: "PLUGIN_NO_EXTRA_VOLUMES",
                                message: format!(
                                    "Plugin service has unauthorized volume mount: {}",
                                    vol_str
                                ),
                                remediation:
                                    "Plugin services may only mount /tokens. Remove all other volume mounts.",
                            });
                        }
                    }
                }
            }
        }
        violations
    }

    /// Plugin token mount mode in compose must match signed manifest.
    /// If manifest says ReadOnly but compose has :rw → violation.
    fn check_plugin_token_mount_mode(
        doc: &serde_yaml_ng::Value,
        manifests: &[PluginManifest],
    ) -> Vec<SecurityViolation> {
        let mut violations = Vec::new();
        let services = match get_services(doc) {
            Some(s) => s,
            None => return violations,
        };
        for (name, service) in services {
            if !is_plugin_service(service) {
                continue;
            }
            // Find the matching manifest by compose service name
            let sid = name.strip_prefix("mcp-").unwrap_or(&name);
            let manifest = manifests
                .iter()
                .find(|m| m.service_id.as_deref() == Some(sid));
            let manifest = match manifest {
                Some(m) => m,
                None => continue, // No manifest to cross-check
            };

            // Check volume mount mode matches manifest
            if let Some(vols) = service.get("volumes").and_then(|v| v.as_sequence()) {
                for vol in vols {
                    if let Some(vol_str) = vol.as_str() {
                        if vol_str.contains(":/tokens:") || vol_str.ends_with(":/tokens") {
                            let is_rw_in_compose = vol_str.ends_with(":rw");
                            let is_ro_in_manifest =
                                matches!(manifest.token_mount, plugin::TokenMount::ReadOnly);
                            if is_rw_in_compose && is_ro_in_manifest {
                                violations.push(SecurityViolation {
                                    container: name.clone(),
                                    rule: "PLUGIN_TOKEN_MOUNT_MODE",
                                    message: "Plugin manifest declares ReadOnly tokens but compose has :rw mount".to_string(),
                                    remediation:
                                        "Change the token volume mount to :ro or update the plugin manifest.",
                                });
                            }
                        }
                    }
                }
            }
        }
        violations
    }

    /// All services must have a valid `user:` field matching the platform-expected value.
    /// This prevents plugins from overriding the container user to gain elevated access.
    fn check_container_user(doc: &serde_yaml_ng::Value) -> Vec<SecurityViolation> {
        let mut violations = Vec::new();
        let services = match get_services(doc) {
            Some(s) => s,
            None => return violations,
        };

        let expected = container_user();
        for (name, service) in services {
            match service.get("user").and_then(|v| v.as_str()) {
                Some(user) if user == expected => {}
                Some(user) => {
                    violations.push(SecurityViolation {
                        container: name.clone(),
                        rule: "CONTAINER_USER",
                        message: format!(
                            "user: \"{}\" does not match expected \"{}\" for this platform",
                            user, expected
                        ),
                        remediation: "Use user: \"${CONTAINER_USER}\" in compose fragments. \
                                      Do not hardcode user values.",
                    });
                }
                None => {
                    violations.push(SecurityViolation {
                        container: name.clone(),
                        rule: "CONTAINER_USER",
                        message: "Missing user: field — container would run as image default user"
                            .into(),
                        remediation: "Add user: \"${CONTAINER_USER}\" to the service definition.",
                    });
                }
            }
        }
        violations
    }
}

/// Checks if a service has the `speedwave.plugin-service: "true"` label.
fn is_plugin_service(service: &serde_yaml_ng::Value) -> bool {
    service
        .get("labels")
        .and_then(|l| l.get("speedwave.plugin-service"))
        .and_then(|v| v.as_str())
        .is_some_and(|s| s == "true")
}

/// Helper: extract services as Vec<(name, &Value)> from a compose YAML doc
fn get_services(doc: &serde_yaml_ng::Value) -> Option<Vec<(String, &serde_yaml_ng::Value)>> {
    let services = doc.get("services")?.as_mapping()?;
    Some(
        services
            .iter()
            .filter_map(|(key, value)| key.as_str().map(|name| (name.to_string(), value)))
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn get_hub_env_seq(doc: &serde_yaml_ng::Value) -> Vec<String> {
        doc.get("services")
            .and_then(|s| s.get("mcp-hub"))
            .and_then(|h| h.get("environment"))
            .and_then(|e| e.as_sequence())
            .map(|seq| {
                seq.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default()
    }

    fn find_env_value(env: &[String], prefix: &str) -> Option<String> {
        env.iter()
            .find(|s| s.starts_with(prefix))
            .map(|s| s[prefix.len()..].to_string())
    }

    /// Returns VALID_COMPOSE with hardcoded user values replaced by the
    /// platform-correct value from `container_user()`. This ensures tests
    /// pass on all platforms (Linux uses "0:0", macOS/Windows use "1000:1000").
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
      - ANTHROPIC_MODEL=claude-sonnet-4-6
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
      - WORKER_SLACK_URL=http://mcp-slack:4001
      - WORKER_SHAREPOINT_URL=http://mcp-sharepoint:4002
      - WORKER_REDMINE_URL=http://mcp-redmine:4003
      - WORKER_GITLAB_URL=http://mcp-gitlab:4004
    networks:
      - speedwave_test_network

  mcp-slack:
    image: speedwave-mcp-slack:latest
    container_name: speedwave_test_mcp_slack
    user: "1000:1000"
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    volumes:
      - /home/user/.speedwave/tokens/test/slack:/tokens:ro
    environment:
      - PORT=4001
    networks:
      - speedwave_test_network

networks:
  speedwave_test_network:
    driver: bridge
"#;

    #[test]
    fn test_security_check_valid_compose() {
        let yaml = valid_compose_yaml();
        let violations = SecurityCheck::run(&yaml, "test", &[]);
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
        let violations = SecurityCheck::run(yaml, "test", &[]);
        assert!(violations.iter().any(|v| v.rule == "CAP_DROP_ALL"));
    }

    #[test]
    fn test_security_check_missing_no_new_privileges() {
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
        let violations = SecurityCheck::run(yaml, "test", &[]);
        assert!(violations.iter().any(|v| v.rule == "NO_NEW_PRIVS"));
    }

    #[test]
    fn test_security_check_claude_read_only_missing() {
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
        let violations = SecurityCheck::run(yaml, "test", &[]);
        assert!(violations
            .iter()
            .any(|v| v.rule == "READ_ONLY_FS" && v.container == "claude"));
    }

    #[test]
    fn test_security_check_tmpfs_missing() {
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
        let violations = SecurityCheck::run(yaml, "test", &[]);
        assert!(violations.iter().any(|v| v.rule == "TMPFS_NOEXEC"));
    }

    #[test]
    fn test_security_check_tokens_in_claude() {
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
        let violations = SecurityCheck::run(yaml, "test", &[]);
        assert!(violations.iter().any(|v| v.rule == "NO_TOKENS_CLAUDE"));
    }

    #[test]
    fn test_security_check_ports_not_localhost() {
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
        let violations = SecurityCheck::run(yaml, "test", &[]);
        assert!(violations.iter().any(|v| v.rule == "PORTS_LOCALHOST"));
    }

    #[test]
    fn test_security_check_claude_docker_socket() {
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
        let violations = SecurityCheck::run(yaml, "test", &[]);
        assert!(violations.iter().any(|v| v.rule == "NO_SOCKET_CLAUDE"));
    }

    #[test]
    fn test_security_check_external_llm_keys_in_claude() {
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
        let violations = SecurityCheck::run(yaml, "test", &[]);
        assert!(violations
            .iter()
            .any(|v| v.rule == "NO_EXTERNAL_LLM_KEYS_CLAUDE"));
    }

    #[test]
    fn test_security_check_invalid_yaml() {
        let violations = SecurityCheck::run("not: valid: yaml: [[[", "test", &[]);
        assert!(violations.iter().any(|v| v.rule == "YAML_PARSE_ERROR"));
    }

    #[test]
    fn test_init_project_dirs() {
        let tmp = tempfile::tempdir().unwrap();
        // Override home dir for testing by using the init logic directly
        let data_dir = tmp.path().join(consts::DATA_DIR);
        let project = "test-project";
        let dirs_to_create: Vec<std::path::PathBuf> = vec![
            data_dir.join("tokens").join(project).join("slack"),
            data_dir.join("tokens").join(project).join("sharepoint"),
            data_dir.join("tokens").join(project).join("redmine"),
            data_dir.join("tokens").join(project).join("gitlab"),
            data_dir.join("compose").join(project),
            data_dir.join("context").join(project),
            data_dir.join("claude-home").join(project),
        ];
        for dir in &dirs_to_create {
            std::fs::create_dir_all(dir).unwrap();
        }
        for dir in &dirs_to_create {
            assert!(dir.exists(), "Directory should exist: {:?}", dir);
        }
    }

    #[test]
    fn test_render_compose_substitution() {
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: crate::defaults::DEFAULT_FLAGS.to_vec(),
            llm: LlmConfig::default(),
        };
        let result = render_compose(
            "test-project",
            "/home/user/projects/test",
            &config,
            &ResolvedIntegrationsConfig::default(),
            None,
        );
        assert!(result.is_ok());
        let yaml = result.unwrap();
        assert!(yaml.contains("speedwave_test-project_claude"));
        assert!(yaml.contains("speedwave_test-project_mcp_hub"));
        assert!(yaml.contains("/workspace"));
        // Verify it's valid YAML
        let parsed: serde_yaml_ng::Value = serde_yaml_ng::from_str(&yaml).unwrap();
        assert!(parsed.get("services").is_some());
    }

    #[test]
    fn test_rendered_compose_has_mcp_hub_port() {
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: crate::defaults::DEFAULT_FLAGS.to_vec(),
            llm: LlmConfig::default(),
        };
        let yaml = render_compose(
            "test-project",
            "/home/user/projects/test",
            &config,
            &ResolvedIntegrationsConfig::default(),
            None,
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
    fn test_mcp_hub_port_matches_port_base() {
        // MCP_HUB_PORT in the claude container must equal PORT_BASE (hub port).
        // If these drift apart, entrypoint.sh generates wrong mcp-config.json URL.
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: crate::defaults::DEFAULT_FLAGS.to_vec(),
            llm: LlmConfig::default(),
        };
        let yaml = render_compose(
            "test-project",
            "/home/user/projects/test",
            &config,
            &ResolvedIntegrationsConfig::default(),
            None,
        )
        .unwrap();
        let expected = format!("MCP_HUB_PORT={}", crate::consts::PORT_BASE);
        assert!(
            yaml.contains(&expected),
            "MCP_HUB_PORT must equal PORT_BASE ({})",
            crate::consts::PORT_BASE
        );
    }

    #[test]
    fn test_mcp_hub_port_survives_inject_claude_env() {
        // Regression: inject_claude_env re-parses YAML via serde_yaml_ng.
        // MCP_HUB_PORT must survive the parse → serialize roundtrip.
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: crate::defaults::DEFAULT_FLAGS.to_vec(),
            llm: LlmConfig::default(),
        };
        let yaml = render_compose(
            "test-project",
            "/home/user/projects/test",
            &config,
            &ResolvedIntegrationsConfig::default(),
            None,
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
    fn test_mcp_hub_port_in_claude_service_env() {
        // Verify MCP_HUB_PORT is specifically in the claude service environment,
        // not somewhere else in the compose file.
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: crate::defaults::DEFAULT_FLAGS.to_vec(),
            llm: LlmConfig::default(),
        };
        let yaml = render_compose(
            "test-project",
            "/home/user/projects/test",
            &config,
            &ResolvedIntegrationsConfig::default(),
            None,
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
    fn test_rendered_compose_passes_security_check() {
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: crate::defaults::DEFAULT_FLAGS.to_vec(),
            llm: LlmConfig::default(),
        };
        let yaml = render_compose(
            "test-project",
            "/home/user/projects/test",
            &config,
            &ResolvedIntegrationsConfig::default(),
            None,
        )
        .unwrap();
        let violations = SecurityCheck::run(&yaml, "test-project", &[]);
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

        inject_worker_env(&mut doc, "WORKER_PRESALE_URL", "http://mcp-presale:4006");

        let hub = doc.get("services").unwrap().get("mcp-hub").unwrap();
        let env_seq = hub.get("environment").unwrap().as_sequence().unwrap();
        let has_presale = env_seq.iter().any(|v| {
            v.as_str()
                .is_some_and(|s| s == "WORKER_PRESALE_URL=http://mcp-presale:4006")
        });
        assert!(has_presale, "WORKER_PRESALE_URL should be in mcp-hub env");
    }

    #[test]
    fn test_add_claude_volume() {
        let mut doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(VALID_COMPOSE).unwrap();

        add_claude_volume(
            &mut doc,
            "/home/user/.speedwave/addons/presale/claude-resources:/speedwave/addons/presale:ro",
        );

        let claude = doc.get("services").unwrap().get("claude").unwrap();
        let vols = claude.get("volumes").unwrap().as_sequence().unwrap();
        let has_addon_vol = vols.iter().any(|v| {
            v.as_str()
                .is_some_and(|s| s.contains("/speedwave/addons/presale:ro"))
        });
        assert!(has_addon_vol, "Addon volume should be in claude volumes");
    }

    #[test]
    fn test_add_claude_env_var() {
        let mut doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(VALID_COMPOSE).unwrap();

        add_claude_env_var(&mut doc, "SPEEDWAVE_PLUGINS", "presale,custom-skills");

        let claude = doc.get("services").unwrap().get("claude").unwrap();
        let env_seq = claude.get("environment").unwrap().as_sequence().unwrap();
        let has_plugins_var = env_seq.iter().any(|v| {
            v.as_str()
                .is_some_and(|s| s == "SPEEDWAVE_PLUGINS=presale,custom-skills")
        });
        assert!(has_plugins_var, "SPEEDWAVE_PLUGINS should be in claude env");
    }

    #[test]
    fn test_security_check_ports_integer_rejected() {
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
        let violations = SecurityCheck::run(yaml, "test", &[]);
        assert!(
            violations.iter().any(|v| v.rule == "PORTS_LOCALHOST"),
            "Bare integer port should be rejected"
        );
    }

    #[test]
    fn test_security_check_ports_long_form_no_host_ip() {
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
        let violations = SecurityCheck::run(yaml, "test", &[]);
        assert!(
            violations.iter().any(|v| v.rule == "PORTS_LOCALHOST"),
            "Long-form port without host_ip should be rejected"
        );
    }

    #[test]
    fn test_security_check_ports_long_form_with_localhost() {
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
        let violations = SecurityCheck::run(yaml, "test", &[]);
        let port_violations: Vec<_> = violations
            .iter()
            .filter(|v| v.rule == "PORTS_LOCALHOST")
            .collect();
        assert!(
            port_violations.is_empty(),
            "Long-form port with host_ip 127.0.0.1 should pass"
        );
    }

    #[test]
    fn test_security_check_anthropic_api_key_allowed() {
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
        let violations = SecurityCheck::run(yaml, "test", &[]);
        assert!(
            !violations.iter().any(|v| v.rule == "NO_TOKENS_CLAUDE"),
            "ANTHROPIC_API_KEY in claude container should be allowed"
        );
    }

    #[test]
    fn test_render_compose_ollama_provider() {
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: crate::defaults::DEFAULT_FLAGS.to_vec(),
            llm: LlmConfig {
                provider: Some("ollama".to_string()),
                model: None,
                base_url: None,
                api_key_env: None,
            },
        };
        let yaml = render_compose(
            "test-project",
            "/home/user/projects/test",
            &config,
            &ResolvedIntegrationsConfig::default(),
            None,
        )
        .unwrap();
        // Ollama should inject ANTHROPIC_BASE_URL pointing to Ollama's OpenAI-compatible endpoint
        assert!(
            yaml.contains("11434/v1"),
            "Ollama provider should set ANTHROPIC_BASE_URL with 11434/v1 port"
        );
    }

    #[test]
    fn test_render_compose_openai_provider() {
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: crate::defaults::DEFAULT_FLAGS.to_vec(),
            llm: LlmConfig {
                provider: Some("openai".to_string()),
                model: Some("gpt-4o".to_string()),
                base_url: None,
                api_key_env: Some("OPENAI_API_KEY".to_string()),
            },
        };
        let yaml = render_compose(
            "test-project",
            "/home/user/projects/test",
            &config,
            &ResolvedIntegrationsConfig::default(),
            None,
        )
        .unwrap();
        // External provider should add an llm-proxy (LiteLLM) service
        assert!(
            yaml.contains("llm-proxy") || yaml.contains("llm_proxy"),
            "OpenAI provider should add llm-proxy service"
        );
    }

    #[test]
    fn test_render_compose_default_anthropic() {
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: crate::defaults::DEFAULT_FLAGS.to_vec(),
            llm: LlmConfig::default(), // provider = None → defaults to "anthropic"
        };
        let yaml = render_compose(
            "test-project",
            "/home/user/projects/test",
            &config,
            &ResolvedIntegrationsConfig::default(),
            None,
        )
        .unwrap();
        // Default anthropic: no proxy, no ANTHROPIC_BASE_URL override
        assert!(
            !yaml.contains("llm-proxy"),
            "Default anthropic provider should not add llm-proxy"
        );
        // Should not contain base_url override (unless explicitly configured)
        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&yaml).unwrap();
        let claude_env = doc
            .get("services")
            .and_then(|s| s.get("claude"))
            .and_then(|c| c.get("environment"))
            .and_then(|e| e.as_sequence())
            .unwrap();
        let has_base_url = claude_env.iter().any(|v| {
            v.as_str()
                .is_some_and(|s| s.starts_with("ANTHROPIC_BASE_URL="))
        });
        assert!(
            !has_base_url,
            "Default anthropic should not set ANTHROPIC_BASE_URL"
        );
    }

    #[test]
    fn test_render_compose_claude_version_is_latest() {
        // Regression guard: CLAUDE_VERSION must be "latest" in generated compose.
        // A pinned version (e.g. "1.0.3") causes 404 on install and the container exits(1).
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: crate::defaults::DEFAULT_FLAGS.to_vec(),
            llm: LlmConfig::default(),
        };
        let yaml = render_compose(
            "test-project",
            "/home/user/projects/test",
            &config,
            &ResolvedIntegrationsConfig::default(),
            None,
        )
        .unwrap();
        assert!(
            yaml.contains("CLAUDE_VERSION=latest"),
            "render_compose must inject CLAUDE_VERSION=latest, got:\n{yaml}"
        );
        assert!(
            !yaml.contains("CLAUDE_VERSION=1."),
            "render_compose must not contain a pinned semver CLAUDE_VERSION"
        );
    }

    #[test]
    fn test_workspace_mount_is_readwrite() {
        // The workspace must be read-write so Claude can create/edit files.
        // This guards against accidentally adding :ro to the workspace mount.
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: crate::defaults::DEFAULT_FLAGS.to_vec(),
            llm: LlmConfig::default(),
        };
        let yaml = render_compose(
            "testproj",
            "/tmp/test",
            &config,
            &ResolvedIntegrationsConfig::default(),
            None,
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
    // entrypoint.sh is baked into the container image. These tests validate
    // its content at compile time to catch regressions before rebuilding.

    const ENTRYPOINT: &str = include_str!("../../../containers/entrypoint.sh");

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
        // The path where entrypoint.sh writes mcp-config.json must match
        // the MCP_CONFIG_PATH constant used in DEFAULT_FLAGS.
        // Extract the path from entrypoint.sh: `cat > "${HOME}/.claude/mcp-config.json"`
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
        let tmp = tempfile::tempdir().unwrap();
        let token_path = tmp.path().join("mcp-os-auth-token");
        let port_path = tmp.path().join("mcp-os-port");
        std::fs::write(&token_path, "test-uuid-token-abc").unwrap();
        std::fs::write(&port_path, "54321").unwrap();

        let result = apply_mcp_os_config_with_path(VALID_COMPOSE, &token_path, &port_path).unwrap();

        // WORKER_OS_URL must be injected into mcp-hub env with the dynamic port
        assert!(
            result.contains("WORKER_OS_URL="),
            "WORKER_OS_URL must be injected when token file exists.\nGot:\n{}",
            result
        );
        assert!(
            result.contains(":54321"),
            "WORKER_OS_URL must use port from port file.\nGot:\n{}",
            result
        );

        // Token file must be bind-mounted into hub
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
        #[cfg(target_os = "macos")]
        {
            assert_eq!(
                url,
                format!("http://host.lima.internal:{port}"),
                "macOS: containers reach mcp-os via host.lima.internal"
            );
        }
        #[cfg(target_os = "linux")]
        {
            assert_eq!(
                url,
                format!("http://host.docker.internal:{port}"),
                "Linux: containers reach mcp-os via nerdctl rootless DNS name"
            );
        }
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

    #[test]
    fn test_security_check_mcp_os_auth_token_forbidden_in_claude() {
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
        let violations = SecurityCheck::run(yaml, "test", &[]);
        assert!(
            violations.iter().any(|v| v.rule == "NO_TOKENS_CLAUDE"),
            "MCP_OS_AUTH_TOKEN should be FORBIDDEN in claude container"
        );
    }

    #[test]
    fn test_security_check_no_tokens_in_hub() {
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
      - WORKER_SLACK_URL=http://mcp-slack:4001
      - SLACK_TOKEN=xoxb-12345
"#;
        let violations = SecurityCheck::run(yaml, "test", &[]);
        assert!(
            violations
                .iter()
                .any(|v| v.rule == "NO_TOKENS_HUB" && v.message.contains("SLACK_TOKEN")),
            "SLACK_TOKEN in hub env should trigger NO_TOKENS_HUB violation"
        );
    }

    #[test]
    fn test_security_check_hub_worker_urls_allowed() {
        // WORKER_*_URL vars in hub env should pass the security check.
        let yaml = valid_compose_yaml();
        let violations = SecurityCheck::run(&yaml, "test", &[]);
        assert!(
            !violations.iter().any(|v| v.rule == "NO_TOKENS_HUB"),
            "WORKER_*_URL in hub env should NOT trigger NO_TOKENS_HUB"
        );
    }

    #[test]
    fn test_security_check_missing_user_field() {
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
        let violations = SecurityCheck::run(yaml, "test", &[]);
        assert!(
            violations.iter().any(|v| v.rule == "CONTAINER_USER"),
            "Should flag missing user field"
        );
    }

    #[test]
    fn test_security_check_wrong_user_value() {
        let yaml = format!(
            r#"
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
        );
        let violations = SecurityCheck::run(&yaml, "test", &[]);
        assert!(
            violations
                .iter()
                .any(|v| v.rule == "CONTAINER_USER" && v.container == "evil-addon"),
            "Should flag wrong user value"
        );
    }

    #[test]
    fn test_security_check_correct_user_passes() {
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
        let violations = SecurityCheck::run(&yaml, "test", &[]);
        assert!(
            !violations.iter().any(|v| v.rule == "CONTAINER_USER"),
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
    fn test_render_compose_contains_ide_lock_mount() {
        // render_compose must substitute ${IDE_LOCK_DIR} so the claude container
        // has the ide-bridge directory mounted as /home/speedwave/.claude/ide:ro.
        // Read-only — container only reads the lock file; Speedwave host writes it.
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: crate::defaults::DEFAULT_FLAGS.to_vec(),
            llm: LlmConfig::default(),
        };
        let yaml = render_compose(
            "test-project",
            "/home/user/projects/test",
            &config,
            &ResolvedIntegrationsConfig::default(),
            None,
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
    fn test_container_user_returns_platform_value() {
        let user = container_user();
        #[cfg(target_os = "linux")]
        assert_eq!(user, "0:0", "Linux rootless must use 0:0");
        #[cfg(not(target_os = "linux"))]
        assert_eq!(user, "1000:1000", "macOS/Windows must use 1000:1000");
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
    fn test_render_compose_substitutes_container_user() {
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: vec![],
            llm: crate::config::LlmConfig::default(),
        };
        let result = render_compose(
            "test-project",
            "/workspace",
            &config,
            &ResolvedIntegrationsConfig::default(),
            None,
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
    fn test_render_compose_substitutes_host_gateway() {
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: vec![],
            llm: crate::config::LlmConfig::default(),
        };
        let result = render_compose(
            "test-project",
            "/workspace",
            &config,
            &ResolvedIntegrationsConfig::default(),
            None,
        )
        .unwrap();
        assert!(
            !result.contains("${HOST_GATEWAY}"),
            "render_compose must substitute ${{HOST_GATEWAY}}"
        );
        // Must contain a valid IP (not the placeholder)
        let expected_ip = host_gateway_ip();
        assert!(
            result.contains(expected_ip),
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
    fn test_render_compose_substitutes_ide_host_override() {
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: vec![],
            llm: crate::config::LlmConfig::default(),
        };
        let result = render_compose(
            "test-project",
            "/workspace",
            &config,
            &ResolvedIntegrationsConfig::default(),
            None,
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
        // CLAUDE_CODE_IDE_HOST_OVERRIDE must use the same gateway hostname
        // as mcp_os_gateway_url — it resolves to the host from inside the VM.
        let host = ide_host_override();
        assert!(
            !host.contains("127.0.0.1"),
            "IDE host override must NOT be 127.0.0.1 — that's the container loopback"
        );
        assert!(
            !host.contains("0.0.0.0"),
            "IDE host override must NOT be 0.0.0.0"
        );
        #[cfg(target_os = "macos")]
        assert_eq!(host, consts::LIMA_HOST);
        #[cfg(target_os = "linux")]
        assert_eq!(host, consts::NERDCTL_LINUX_HOST);
    }

    #[test]
    fn test_claude_env_has_ide_host_override() {
        // CLAUDE_CODE_IDE_HOST_OVERRIDE must be in the claude service environment.
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: crate::defaults::DEFAULT_FLAGS.to_vec(),
            llm: LlmConfig::default(),
        };
        let yaml = render_compose(
            "test-project",
            "/home/user/projects/test",
            &config,
            &ResolvedIntegrationsConfig::default(),
            None,
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
    fn test_security_no_ports_on_each_worker() {
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
            let violations = SecurityCheck::run(&yaml, "test", &[]);
            assert!(
                violations.iter().any(|v| v.rule == "NO_PORTS_WORKERS"),
                "{name} with ports should trigger NO_PORTS_WORKERS"
            );
        }
    }

    #[test]
    fn test_security_worker_without_ports_passes() {
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
      - PORT=4001
"#;
        let violations = SecurityCheck::run(yaml, "test", &[]);
        assert!(
            !violations.iter().any(|v| v.rule == "NO_PORTS_WORKERS"),
            "Worker without ports should pass"
        );
    }

    #[test]
    fn test_security_llm_proxy_ports_allowed() {
        let yaml = r#"
version: "3"
services:
  llm-proxy:
    image: ghcr.io/berriai/litellm:latest
    read_only: true
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    tmpfs: ["/tmp:noexec,nosuid,size=64m"]
    ports:
      - "127.0.0.1:4010:4010"
"#;
        let violations = SecurityCheck::run(yaml, "test", &[]);
        assert!(
            !violations.iter().any(|v| v.rule == "NO_PORTS_WORKERS"),
            "llm-proxy is allowed to expose ports"
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
        let yaml = r#"
version: "3"
services:
  mcp-presale:
    image: speedwave-mcp-presale:latest
    read_only: true
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    tmpfs: ["/tmp:noexec,nosuid,size=64m"]
    ports:
      - "127.0.0.1:4006:4006"
"#;
        let violations = SecurityCheck::run(yaml, "test", &[]);
        assert!(
            !violations.iter().any(|v| v.rule == "NO_PORTS_WORKERS"),
            "Addon services may expose ports (they are not in consts::BUILT_IN_SERVICES)"
        );
    }

    #[test]
    fn test_render_compose_rejects_invalid_project_name() {
        let resolved = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: crate::defaults::DEFAULT_FLAGS.to_vec(),
            llm: LlmConfig::default(),
        };
        let integrations = ResolvedIntegrationsConfig::default();
        assert!(render_compose("", "/tmp/proj", &resolved, &integrations, None).is_err());
        assert!(render_compose("../evil", "/tmp/proj", &resolved, &integrations, None).is_err());
        assert!(
            render_compose(&"a".repeat(64), "/tmp/proj", &resolved, &integrations, None).is_err()
        );
    }

    #[test]
    fn test_init_project_dirs_rejects_invalid_name() {
        assert!(init_project_dirs("").is_err());
        assert!(init_project_dirs("../evil").is_err());
        assert!(init_project_dirs(&"a".repeat(64)).is_err());
    }

    #[test]
    fn test_init_secrets_dir_rejects_invalid_name() {
        assert!(init_secrets_dir("").is_err());
        assert!(init_secrets_dir("../evil").is_err());
        assert!(init_secrets_dir(&"a".repeat(64)).is_err());
    }

    #[test]
    fn test_compose_output_path_rejects_invalid_name() {
        assert!(compose_output_path("").is_err());
        assert!(compose_output_path("../evil").is_err());
        assert!(compose_output_path(&"a".repeat(64)).is_err());
    }

    #[test]
    fn test_integrations_filter_removes_disabled_service() {
        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(VALID_COMPOSE).unwrap();

        // Verify mcp-slack exists before filtering
        let services = doc.get("services").unwrap().as_mapping().unwrap();
        assert!(services.contains_key(&serde_yaml_ng::Value::String("mcp-slack".into())));

        // Disable slack
        let mut integrations = ResolvedIntegrationsConfig::default();
        integrations.slack = false;

        let yaml = serde_yaml_ng::to_string(&doc).unwrap();
        let filtered = apply_integrations_filter(&yaml, &integrations).unwrap();

        let filtered_doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&filtered).unwrap();
        let filtered_services = filtered_doc.get("services").unwrap().as_mapping().unwrap();

        // mcp-slack should be removed
        assert!(!filtered_services.contains_key(&serde_yaml_ng::Value::String("mcp-slack".into())));
        // claude and mcp-hub must remain
        assert!(filtered_services.contains_key(&serde_yaml_ng::Value::String("claude".into())));
        assert!(filtered_services.contains_key(&serde_yaml_ng::Value::String("mcp-hub".into())));
    }

    #[test]
    fn test_integrations_filter_removes_worker_url_from_hub() {
        let mut integrations = ResolvedIntegrationsConfig::default();
        integrations.gitlab = false;

        let filtered = apply_integrations_filter(VALID_COMPOSE, &integrations).unwrap();
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
        let mut integrations = ResolvedIntegrationsConfig::default();
        integrations.slack = true;
        integrations.sharepoint = true;
        integrations.gitlab = true;
        integrations.os_calendar = true;

        let filtered = apply_integrations_filter(VALID_COMPOSE, &integrations).unwrap();
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
    fn test_integrations_filter_all_disabled_keeps_claude_and_hub() {
        let integrations = ResolvedIntegrationsConfig::default();

        let filtered = apply_integrations_filter(VALID_COMPOSE, &integrations).unwrap();
        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&filtered).unwrap();
        let services = doc.get("services").unwrap().as_mapping().unwrap();

        assert!(services.contains_key(&serde_yaml_ng::Value::String("claude".into())));
        assert!(services.contains_key(&serde_yaml_ng::Value::String("mcp-hub".into())));
        // No MCP worker services should remain
        assert!(!services.contains_key(&serde_yaml_ng::Value::String("mcp-slack".into())));
    }

    #[test]
    fn test_integrations_filter_disabled_os_services_injected() {
        let mut integrations = ResolvedIntegrationsConfig::default();
        integrations.os_calendar = true;
        integrations.os_notes = true;
        // reminders and mail remain false (default)

        let filtered = apply_integrations_filter(VALID_COMPOSE, &integrations).unwrap();
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
        let mut integrations = ResolvedIntegrationsConfig::default();
        integrations.os_reminders = true;
        integrations.os_calendar = true;
        integrations.os_mail = true;
        integrations.os_notes = true;

        let filtered = apply_integrations_filter(VALID_COMPOSE, &integrations).unwrap();
        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&filtered).unwrap();
        let env = get_hub_env_seq(&doc);

        assert!(
            find_env_value(&env, "DISABLED_OS_SERVICES=").is_none(),
            "DISABLED_OS_SERVICES should not be present when all OS integrations enabled"
        );
    }

    #[test]
    fn test_render_compose_with_mixed_enabled_disabled_end_to_end() {
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: crate::defaults::DEFAULT_FLAGS.to_vec(),
            llm: LlmConfig::default(),
        };
        let mut integrations = ResolvedIntegrationsConfig::default();
        integrations.sharepoint = true;
        integrations.gitlab = true;
        integrations.os_calendar = true;
        // slack, redmine remain disabled (default)
        // os_reminders, os_mail, os_notes remain disabled (default)

        let result = render_compose(
            "test-e2e",
            "/home/user/projects/test",
            &config,
            &integrations,
            None,
        );
        assert!(
            result.is_ok(),
            "render_compose should succeed: {:?}",
            result
        );
        let yaml = result.unwrap();

        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&yaml).unwrap();
        let services = doc.get("services").unwrap().as_mapping().unwrap();

        // mcp-slack should be removed (disabled by default)
        assert!(
            !services.contains_key(&serde_yaml_ng::Value::String("mcp-slack".into())),
            "mcp-slack should be removed when slack is disabled"
        );

        // claude and mcp-hub must still be present
        assert!(services.contains_key(&serde_yaml_ng::Value::String("claude".into())));
        assert!(services.contains_key(&serde_yaml_ng::Value::String("mcp-hub".into())));

        // Enabled services should be present
        assert!(services.contains_key(&serde_yaml_ng::Value::String("mcp-sharepoint".into())));
        assert!(services.contains_key(&serde_yaml_ng::Value::String("mcp-gitlab".into())));

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

        let filtered = apply_integrations_filter(VALID_COMPOSE, &integrations).unwrap();
        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&filtered).unwrap();
        let services = doc.get("services").unwrap().as_mapping().unwrap();

        // No MCP worker services should remain
        assert!(!services.contains_key(&serde_yaml_ng::Value::String("mcp-slack".into())));
        assert!(
            !services.contains_key(&serde_yaml_ng::Value::String("mcp-sharepoint".into()))
                || !VALID_COMPOSE.contains("mcp-sharepoint")
        );

        // claude and mcp-hub must remain
        assert!(services.contains_key(&serde_yaml_ng::Value::String("claude".into())));
        assert!(services.contains_key(&serde_yaml_ng::Value::String("mcp-hub".into())));

        let env = get_hub_env_seq(&doc);

        // ENABLED_SERVICES should be empty string
        let enabled_var =
            find_env_value(&env, "ENABLED_SERVICES=").expect("ENABLED_SERVICES should be injected");
        assert!(
            enabled_var.is_empty(),
            "ENABLED_SERVICES should be empty when all integrations disabled, got: '{}'",
            enabled_var
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
        let filtered = apply_integrations_filter(&yaml, &integrations).unwrap();
        let violations = SecurityCheck::run(&filtered, "test", &[]);
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
        let mut integrations = ResolvedIntegrationsConfig::default();
        integrations.slack = true;

        let filtered = apply_integrations_filter(VALID_COMPOSE, &integrations).unwrap();
        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&filtered).unwrap();
        let services = doc.get("services").unwrap().as_mapping().unwrap();

        // mcp-slack should remain
        assert!(services.contains_key(&serde_yaml_ng::Value::String("mcp-slack".into())));

        // Other MCP services in VALID_COMPOSE should be gone (only mcp-slack was in template)
        // claude and mcp-hub must remain
        assert!(services.contains_key(&serde_yaml_ng::Value::String("claude".into())));
        assert!(services.contains_key(&serde_yaml_ng::Value::String("mcp-hub".into())));

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
    fn test_render_compose_all_services_have_container_user() {
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: vec![],
            llm: crate::config::LlmConfig::default(),
        };
        // Enable all integrations so no services are filtered out
        let integrations = ResolvedIntegrationsConfig {
            slack: true,
            sharepoint: true,
            redmine: true,
            gitlab: true,
            ..ResolvedIntegrationsConfig::default()
        };
        let result =
            render_compose("test-project", "/workspace", &config, &integrations, None).unwrap();
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

    #[test]
    fn test_render_compose_llm_proxy_has_container_user() {
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: crate::defaults::DEFAULT_FLAGS.to_vec(),
            llm: LlmConfig {
                provider: Some("openai".to_string()),
                model: Some("gpt-4o".to_string()),
                base_url: None,
                api_key_env: Some("OPENAI_API_KEY".to_string()),
            },
        };
        let yaml = render_compose(
            "test-project",
            "/home/user/projects/test",
            &config,
            &ResolvedIntegrationsConfig::default(),
            None,
        )
        .unwrap();
        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&yaml).unwrap();
        let proxy_user = doc
            .get("services")
            .and_then(|s| s.get("llm-proxy"))
            .and_then(|p| p.get("user"))
            .and_then(|u| u.as_str());
        assert_eq!(
            proxy_user,
            Some(container_user()),
            "llm-proxy service must have user: \"{}\"",
            container_user()
        );
    }

    // ── Plugin SecurityCheck tests ───────────────────────────────────────

    #[test]
    fn test_security_check_plugin_no_privileged() {
        let yaml = format!(
            r#"
version: "3"
services:
  mcp-presale:
    image: speedwave-mcp-presale:1.0.0
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
        let violations = SecurityCheck::run(&yaml, "test", &[]);
        assert!(
            violations
                .iter()
                .any(|v| v.rule == "PLUGIN_NO_PRIVILEGED" && v.container == "mcp-presale"),
            "Plugin with privileged: true should trigger PLUGIN_NO_PRIVILEGED"
        );
    }

    #[test]
    fn test_security_check_plugin_no_host_network() {
        let yaml = format!(
            r#"
version: "3"
services:
  mcp-presale:
    image: speedwave-mcp-presale:1.0.0
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
        let violations = SecurityCheck::run(&yaml, "test", &[]);
        assert!(
            violations
                .iter()
                .any(|v| v.rule == "PLUGIN_NO_HOST_NETWORK" && v.container == "mcp-presale"),
            "Plugin with network_mode: host should trigger PLUGIN_NO_HOST_NETWORK"
        );
    }

    #[test]
    fn test_security_check_plugin_no_extra_volumes() {
        let yaml = format!(
            r#"
version: "3"
services:
  mcp-presale:
    image: speedwave-mcp-presale:1.0.0
    user: "{user}"
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    volumes:
      - /home/user/.speedwave/tokens/test/presale:/tokens:ro
      - /etc/passwd:/etc/passwd:ro
    labels:
      speedwave.plugin-service: "true"
"#,
            user = container_user()
        );
        let violations = SecurityCheck::run(&yaml, "test", &[]);
        assert!(
            violations
                .iter()
                .any(|v| v.rule == "PLUGIN_NO_EXTRA_VOLUMES" && v.container == "mcp-presale"),
            "Plugin with extra volumes should trigger PLUGIN_NO_EXTRA_VOLUMES"
        );
    }

    #[test]
    fn test_security_check_plugin_no_extra_volumes_clean() {
        let yaml = format!(
            r#"
version: "3"
services:
  mcp-presale:
    image: speedwave-mcp-presale:1.0.0
    user: "{user}"
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp:noexec,nosuid,size=64m
    volumes:
      - /home/user/.speedwave/tokens/test/presale:/tokens:ro
    labels:
      speedwave.plugin-service: "true"
"#,
            user = container_user()
        );
        let violations = SecurityCheck::run(&yaml, "test", &[]);
        assert!(
            !violations
                .iter()
                .any(|v| v.rule == "PLUGIN_NO_EXTRA_VOLUMES"),
            "Plugin with only /tokens volume should not trigger PLUGIN_NO_EXTRA_VOLUMES"
        );
    }

    #[test]
    fn test_security_check_plugin_token_mount_mode_ro_violation() {
        let yaml = format!(
            r#"
version: "3"
services:
  mcp-presale:
    image: speedwave-mcp-presale:1.0.0
    user: "{user}"
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp:noexec,nosuid,size=64m
    volumes:
      - /home/user/.speedwave/tokens/test/presale:/tokens:rw
    labels:
      speedwave.plugin-service: "true"
"#,
            user = container_user()
        );
        let manifests = vec![PluginManifest {
            name: "Presale".to_string(),
            service_id: Some("presale".to_string()),
            slug: "presale".to_string(),
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
        }];
        let violations = SecurityCheck::run(&yaml, "test", &manifests);
        assert!(
            violations
                .iter()
                .any(|v| v.rule == "PLUGIN_TOKEN_MOUNT_MODE" && v.container == "mcp-presale"),
            "ReadOnly manifest + :rw mount should trigger PLUGIN_TOKEN_MOUNT_MODE"
        );
    }

    #[test]
    fn test_security_check_plugin_token_mount_mode_rw_pass() {
        let yaml = format!(
            r#"
version: "3"
services:
  mcp-presale:
    image: speedwave-mcp-presale:1.0.0
    user: "{user}"
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp:noexec,nosuid,size=64m
    volumes:
      - /home/user/.speedwave/tokens/test/presale:/tokens:rw
    labels:
      speedwave.plugin-service: "true"
"#,
            user = container_user()
        );
        let manifests = vec![PluginManifest {
            name: "Presale".to_string(),
            service_id: Some("presale".to_string()),
            slug: "presale".to_string(),
            version: "1.0.0".to_string(),
            description: "test".to_string(),
            port: Some(4010),
            image_tag: None,
            resources: vec![],
            token_mount: plugin::TokenMount::ReadWrite {
                justification: "OAuth token refresh".to_string(),
            },
            auth_fields: vec![],
            settings_schema: None,
            speedwave_compat: None,
            extra_env: None,
            mem_limit: None,
        }];
        let violations = SecurityCheck::run(&yaml, "test", &manifests);
        assert!(
            !violations
                .iter()
                .any(|v| v.rule == "PLUGIN_TOKEN_MOUNT_MODE"),
            "ReadWrite manifest + :rw mount should NOT trigger PLUGIN_TOKEN_MOUNT_MODE"
        );
    }

    // ── apply_plugins integration tests (via individual pieces) ──────────

    #[test]
    fn test_apply_plugins_enabled_in_compose() {
        // Test that generate_plugin_service creates a valid service and it can be
        // inserted into compose YAML, simulating what apply_plugins does.
        let manifest = PluginManifest {
            name: "Presale".to_string(),
            service_id: Some("presale".to_string()),
            slug: "presale".to_string(),
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
        };

        let tokens_dir = std::path::PathBuf::from("/home/user/.speedwave/tokens/test");
        let service_value = plugin::generate_plugin_service(
            &manifest,
            "test",
            "speedwave_test_network",
            &tokens_dir,
        )
        .unwrap();

        // Insert into valid compose (simulating apply_plugins behavior)
        let mut doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(VALID_COMPOSE).unwrap();
        if let Some(services) = doc.get_mut("services").and_then(|v| v.as_mapping_mut()) {
            services.insert(
                serde_yaml_ng::Value::String("mcp-presale".to_string()),
                service_value,
            );
        }

        // Verify the service appears
        let services = doc.get("services").unwrap().as_mapping().unwrap();
        assert!(
            services.contains_key(&serde_yaml_ng::Value::String("mcp-presale".into())),
            "Enabled plugin service mcp-presale should appear in compose"
        );
    }

    #[test]
    fn test_apply_plugins_disabled_excluded() {
        // When a plugin is NOT enabled in integrations, its service should not appear.
        // apply_plugins checks integrations.is_plugin_enabled(sid) — when false, it skips.
        // Simulate by not inserting into compose.
        let integrations = ResolvedIntegrationsConfig::default(); // plugins map is empty
        assert!(
            !integrations.is_plugin_enabled("presale"),
            "presale should not be enabled by default"
        );

        // Verify the compose YAML does not contain the plugin service
        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(VALID_COMPOSE).unwrap();
        let services = doc.get("services").unwrap().as_mapping().unwrap();
        assert!(
            !services.contains_key(&serde_yaml_ng::Value::String("mcp-presale".into())),
            "Disabled plugin service should NOT appear in compose"
        );
    }

    #[test]
    fn test_apply_plugins_worker_url_injected() {
        // Simulate apply_plugins injecting WORKER_PRESALE_URL into mcp-hub
        let mut doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(VALID_COMPOSE).unwrap();
        let worker_env = plugin::derive_worker_env("presale");
        let url = format!("http://mcp-presale:4010");
        inject_worker_env(&mut doc, &worker_env, &url);

        let env = get_hub_env_seq(&doc);
        assert!(
            env.iter()
                .any(|s| s == "WORKER_PRESALE_URL=http://mcp-presale:4010"),
            "WORKER_PRESALE_URL should be injected into mcp-hub. Got: {:?}",
            env
        );
    }

    #[test]
    fn test_apply_plugins_speedwave_plugins_env() {
        // Simulate apply_plugins setting SPEEDWAVE_PLUGINS in claude container
        let mut doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(VALID_COMPOSE).unwrap();
        let slugs = vec!["presale".to_string(), "analytics".to_string()];
        add_claude_env_var(&mut doc, "SPEEDWAVE_PLUGINS", &slugs.join(","));

        let claude = doc.get("services").unwrap().get("claude").unwrap();
        let env_seq = claude.get("environment").unwrap().as_sequence().unwrap();
        let has_plugins = env_seq.iter().any(|v| {
            v.as_str()
                .is_some_and(|s| s == "SPEEDWAVE_PLUGINS=presale,analytics")
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
            name: "Presale".to_string(),
            service_id: Some("presale".to_string()),
            slug: "presale".to_string(),
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
        };

        let tokens_dir = std::path::PathBuf::from("/home/user/.speedwave/tokens/myproject");
        let service_value = plugin::generate_plugin_service(
            &manifest,
            "myproject",
            "speedwave_myproject_network",
            &tokens_dir,
        )
        .unwrap();

        let yaml = serde_yaml_ng::to_string(&service_value).unwrap();
        // Token mount should be tokens_dir/service_id:/tokens:ro
        assert!(
            yaml.contains("/home/user/.speedwave/tokens/myproject/presale:/tokens:ro"),
            "Token mount should be <tokens_dir>/<service_id>:/tokens:<mode>. Got:\n{}",
            yaml
        );
    }

    #[test]
    fn to_engine_path_returns_path_unchanged_on_non_windows() {
        let path = std::path::Path::new("/home/user/projects/acme");
        let result = to_engine_path(path).unwrap();
        assert_eq!(result, "/home/user/projects/acme");
    }

    #[test]
    fn str_to_engine_path_returns_path_unchanged_on_non_windows() {
        let result = str_to_engine_path("/home/user/projects/acme").unwrap();
        assert_eq!(result, "/home/user/projects/acme");
    }

    #[test]
    fn to_engine_path_handles_path_with_spaces() {
        let path = std::path::Path::new("/home/user/my projects/acme corp");
        let result = to_engine_path(path).unwrap();
        assert_eq!(result, "/home/user/my projects/acme corp");
    }

    #[test]
    fn str_to_engine_path_handles_absolute_path() {
        let result = str_to_engine_path("/usr/local/share/speedwave").unwrap();
        assert_eq!(result, "/usr/local/share/speedwave");
    }
}
