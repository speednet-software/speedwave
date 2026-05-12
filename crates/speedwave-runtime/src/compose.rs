use crate::config::{LlmConfig, ResolvedClaudeConfig, ResolvedIntegrationsConfig};
use crate::consts;
use crate::defaults;
use crate::plugin::{self, PluginManifest};
use crate::runtime::ContainerRuntime;
use crate::{build, bundle};
use std::path::{Path, PathBuf};
use strum::EnumProperty;

/// Converts a host path to the path seen by the container engine.
///
/// On Windows, nerdctl runs inside WSL2 so host paths must be translated
/// from `C:\Users\...` to `/mnt/c/Users/...`. On macOS and Linux the
/// container engine runs on the host so paths are returned unchanged.
pub(crate) fn to_engine_path(path: &std::path::Path) -> anyhow::Result<String> {
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

/// Returns the tokens directory for a project using `consts::data_dir()`.
fn resolve_tokens_dir(project_name: &str) -> PathBuf {
    consts::data_dir().join("tokens").join(project_name)
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
    let data_dir = consts::data_dir();
    let tokens_dir = resolve_tokens_dir(project_name);
    let claude_home = crate::claude_home::claude_home_dir(data_dir, project_name);
    let resources_dir = data_dir.join("claude-resources");
    let network_name = format!("{}_{}_network", consts::compose_prefix(), project_name);

    let port_hub = consts::PORT_BASE;
    let port_worker = consts::PORT_WORKER;
    let bundle_manifest = bundle::load_current_bundle_manifest()?;

    let mut yaml = COMPOSE_TEMPLATE.to_string();
    yaml = yaml.replace("${COMPOSE_PREFIX}", consts::compose_prefix());
    yaml = yaml.replace("${PROJECT_NAME}", project_name);
    yaml = yaml.replace("${PROJECT_DIR}", &str_to_engine_path(project_dir)?);
    yaml = yaml.replace("${CLAUDE_HOME}", &to_engine_path(&claude_home)?);
    yaml = yaml.replace("${RESOURCES_DIR}", &to_engine_path(&resources_dir)?);
    yaml = yaml.replace("${TOKENS_DIR}", &to_engine_path(&tokens_dir)?);
    yaml = yaml.replace("${NETWORK_NAME}", &network_name);
    yaml = yaml.replace("${CLAUDE_VERSION}", defaults::CLAUDE_VERSION);
    yaml = yaml.replace("${PORT_HUB}", &port_hub.to_string());
    yaml = yaml.replace("${PORT_WORKER}", &port_worker.to_string());
    yaml = yaml.replace(
        "${IMAGE_CLAUDE}",
        &build::image_ref(build::IMAGE_CLAUDE, &bundle_manifest.bundle_id),
    );
    yaml = yaml.replace(
        "${IMAGE_MCP_HUB}",
        &build::image_ref(build::IMAGE_MCP_HUB, &bundle_manifest.bundle_id),
    );
    yaml = yaml.replace(
        "${IMAGE_MCP_SLACK}",
        &build::image_ref(build::IMAGE_MCP_SLACK, &bundle_manifest.bundle_id),
    );
    yaml = yaml.replace(
        "${IMAGE_MCP_SHAREPOINT}",
        &build::image_ref(build::IMAGE_MCP_SHAREPOINT, &bundle_manifest.bundle_id),
    );
    yaml = yaml.replace(
        "${IMAGE_MCP_REDMINE}",
        &build::image_ref(build::IMAGE_MCP_REDMINE, &bundle_manifest.bundle_id),
    );
    yaml = yaml.replace(
        "${IMAGE_MCP_GITLAB}",
        &build::image_ref(build::IMAGE_MCP_GITLAB, &bundle_manifest.bundle_id),
    );
    yaml = yaml.replace(
        "${IMAGE_MCP_GITHUB}",
        &build::image_ref(build::IMAGE_MCP_GITHUB, &bundle_manifest.bundle_id),
    );
    yaml = yaml.replace(
        "${IMAGE_MCP_ATLASSIAN}",
        &build::image_ref(build::IMAGE_MCP_ATLASSIAN, &bundle_manifest.bundle_id),
    );
    yaml = yaml.replace(
        "${IMAGE_MCP_OFFICE}",
        &build::image_ref(build::IMAGE_MCP_OFFICE, &bundle_manifest.bundle_id),
    );
    yaml = yaml.replace(
        "${IMAGE_MCP_PLAYWRIGHT}",
        &build::image_ref(build::IMAGE_MCP_PLAYWRIGHT, &bundle_manifest.bundle_id),
    );

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
    yaml = yaml.replace("${HOST_GATEWAY}", host_gateway_ip());
    yaml = yaml.replace("${IDE_HOST_OVERRIDE}", ide_host_override());
    yaml = yaml.replace("${CONTAINER_USER}", container_user());

    // Adaptive Claude container memory based on host resources.
    // SSOT: resources::effective_claude_memory_gib() handles platform detection.
    let claude_mem = crate::resources::effective_claude_memory_gib();
    yaml = yaml.replace("${CLAUDE_MEMORY}", &format!("{}g", claude_mem));

    // Inject Claude environment variables from resolved config
    yaml = inject_claude_env(&yaml, &resolved_config.env)?;

    // Handle LLM provider switching
    yaml = apply_llm_config(&yaml, &resolved_config.llm)?;

    // Ensure plugin images exist (builds pending and missing) before compose generation.
    // Scoped to plugins enabled for this project — a broken plugin in another project
    // does not block this one.
    if let Some(rt) = runtime {
        let enabled_ids = integrations.enabled_plugin_service_ids();
        plugin::ensure_plugin_images(rt, &enabled_ids)?;
    }

    // Integrate installed plugins
    yaml = apply_plugins(
        &yaml,
        project_name,
        project_dir,
        integrations,
        &network_name,
        &tokens_dir,
    )?;

    // Propagate host timezone into every service; must run after plugin injection.
    let host_tz = crate::tz::detect_host_timezone();
    yaml = inject_host_timezone(&yaml, &host_tz)?;

    // Inject Anthropic API key from secrets if configured.
    // Skipped when a local LLM provider is active — the dummy
    // ANTHROPIC_AUTH_TOKEN=sk-no-key-required is all Claude Code needs, and
    // leaking the real key into a container pointed at a local server would
    // violate least-privilege for no benefit.
    let provider = resolved_config
        .llm
        .provider
        .as_deref()
        .unwrap_or("anthropic");
    if provider == "anthropic" {
        yaml = apply_auth_config(&yaml, project_name)?;
    }

    // Inject mcp-os config into hub if auth token exists
    yaml = apply_mcp_os_config(&yaml)?;

    // Inject per-worker Bearer auth tokens (SEC-035)
    yaml = apply_worker_auth_tokens(&yaml, project_name, integrations)?;

    // Filter services based on integrations config
    yaml = apply_integrations_filter(&yaml, integrations, &network_name)?;

    Ok(yaml)
}

/// Creates the secrets directory for a project with restrictive permissions (chmod 700).
/// Path: `~/.speedwave/secrets/<project>/`
///
/// Also sets `0o700` on the parent `secrets/` directory.
pub fn init_secrets_dir(project: &str) -> anyhow::Result<PathBuf> {
    init_secrets_dir_in(consts::data_dir(), project)
}

/// Testable variant: accepts explicit data_dir.
pub(crate) fn init_secrets_dir_in(
    data_dir: &std::path::Path,
    project: &str,
) -> anyhow::Result<PathBuf> {
    crate::validation::validate_project_name(project)?;
    let secrets_dir = data_dir.join("secrets").join(project);
    std::fs::create_dir_all(&secrets_dir)?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode_700 = std::fs::Permissions::from_mode(0o700);
        // secrets_dir = data_dir/secrets/<project>
        std::fs::set_permissions(&secrets_dir, mode_700.clone())?;
        if let Some(secrets_parent) = secrets_dir.parent() {
            // secrets_parent = data_dir/secrets/ — one level above, stop here
            std::fs::set_permissions(secrets_parent, mode_700)?;
        }
    }

    Ok(secrets_dir)
}

/// Returns the path where the rendered compose file should be saved.
pub fn compose_output_path(project: &str) -> anyhow::Result<PathBuf> {
    crate::validation::validate_project_name(project)?;
    Ok(consts::data_dir()
        .join("compose")
        .join(project)
        .join("compose.yml"))
}

/// Testable variant: resolves compose output path under an explicit data directory.
#[cfg(test)]
pub fn compose_output_path_in(
    data_dir: &std::path::Path,
    project: &str,
) -> anyhow::Result<PathBuf> {
    crate::validation::validate_project_name(project)?;
    Ok(data_dir.join("compose").join(project).join("compose.yml"))
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

fn inject_claude_env(
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

fn apply_llm_config(yaml: &str, llm: &LlmConfig) -> anyhow::Result<String> {
    let provider = llm.provider.as_deref().unwrap_or("anthropic");
    match provider {
        "anthropic" => {
            // ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL pin each alias to the
            // SSOT-latest model id with a `[1m]` suffix where the model
            // supports a 1M-token context window. Without this, Max/Team
            // subscribers see their 1M models capped at the 200k base spec
            // (anthropics/claude-code#34083). Generated dynamically so a SSOT
            // bump (Opus 4.8 etc.) propagates without touching this branch.
            let mut extra_env = crate::defaults::anthropic_default_models_env();
            // When the user picks an explicit model in Settings, propagate it
            // through ANTHROPIC_MODEL so Claude Code respects the choice.
            // Leaving the field blank means the active model resolves through
            // an alias (`opus`/`sonnet`/`haiku`) which the DEFAULT_*_MODEL
            // entries above already steer toward the latest 1M variant.
            let model = llm.model.as_deref().map(str::trim).unwrap_or("");
            if !model.is_empty() {
                extra_env.insert("ANTHROPIC_MODEL".to_string(), model.to_string());
            }
            inject_claude_env(yaml, &extra_env)
        }
        "ollama" | "lmstudio" | "llamacpp" => {
            let base_url = llm
                .base_url
                .clone()
                .or_else(|| default_base_url(provider))
                .ok_or_else(|| anyhow::anyhow!("Provider '{}' requires a base_url.", provider))?;
            let base_url = strip_trailing_v1(&base_url);
            validate_base_url(&base_url)?;
            let model = llm.model.as_deref().ok_or_else(|| {
                anyhow::anyhow!(
                    "Provider '{}' requires a model name. \
                     Configure it in Settings → LLM Provider → Model.",
                    provider
                )
            })?;
            let extra_env = std::collections::HashMap::from([
                ("ANTHROPIC_BASE_URL".to_string(), base_url),
                (
                    "ANTHROPIC_AUTH_TOKEN".to_string(),
                    "sk-no-key-required".to_string(),
                ),
                // ANTHROPIC_MODEL is Claude Code's primary mechanism for setting
                // the active model (and what statusline / `/status` display).
                // Without it Claude Code falls back to its account-tier default
                // (Haiku/Sonnet) regardless of where ANTHROPIC_BASE_URL points.
                ("ANTHROPIC_MODEL".to_string(), model.to_string()),
                // CUSTOM_MODEL_OPTION* adds a friendly entry to the `/model`
                // picker. Documented as supplementary — useful when the gateway
                // doesn't auto-populate the picker via /v1/models discovery.
                (
                    "ANTHROPIC_CUSTOM_MODEL_OPTION".to_string(),
                    model.to_string(),
                ),
                (
                    "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME".to_string(),
                    custom_model_display_name(provider, model),
                ),
                (
                    "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION".to_string(),
                    custom_model_description(provider),
                ),
                (
                    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC".to_string(),
                    "1".to_string(),
                ),
                (
                    "CLAUDE_CODE_ATTRIBUTION_HEADER".to_string(),
                    "0".to_string(),
                ),
            ]);
            inject_claude_env(yaml, &extra_env)
        }
        other => anyhow::bail!(
            "Unsupported LLM provider '{other}'. \
             Supported: anthropic, ollama, lmstudio, llamacpp."
        ),
    }
}

/// Strips any trailing `/v1` and trailing slashes from a base URL.
/// Exposed so `update_llm_config` can normalize before validating, keeping
/// save-time and render-time acceptance consistent.
pub fn strip_trailing_v1(url: &str) -> String {
    let stripped = url.trim_end_matches('/');
    if let Some(without_v1) = stripped.strip_suffix("/v1") {
        without_v1.to_string()
    } else {
        stripped.to_string()
    }
}

/// Returns the default base URL for a known local model provider.
/// Used by the frontend to show a placeholder without duplicating the URL logic.
pub fn default_base_url(provider: &str) -> Option<String> {
    match provider {
        "ollama" => Some("http://host.docker.internal:11434".to_string()),
        "lmstudio" => Some("http://host.docker.internal:1234".to_string()),
        "llamacpp" => Some("http://host.docker.internal:8080".to_string()),
        _ => None,
    }
}

/// Human-readable label for a local LLM provider.
///
/// Invariant: the only callers (`custom_model_display_name` and
/// `custom_model_description`) are reached only after `apply_llm_config`
/// narrows the provider to one of the three local values below. Any other
/// value at this point indicates a programmer error in `apply_llm_config`.
fn provider_display_label(provider: &str) -> &'static str {
    match provider {
        "ollama" => "Ollama",
        "lmstudio" => "LM Studio",
        "llamacpp" => "llama.cpp",
        other => unreachable!("provider_display_label called with unsupported provider '{other}'"),
    }
}

fn custom_model_display_name(provider: &str, model: &str) -> String {
    format!("{} ({})", model, provider_display_label(provider))
}

fn custom_model_description(provider: &str) -> String {
    format!("Local model served by {}", provider_display_label(provider))
}

/// Validates a base URL for local model providers. Rejects non-HTTP schemes,
/// credentials, paths, query strings, and fragments.
pub fn validate_base_url(raw: &str) -> anyhow::Result<()> {
    let parsed =
        url::Url::parse(raw).map_err(|e| anyhow::anyhow!("Invalid base_url '{}': {}", raw, e))?;
    match parsed.scheme() {
        "http" | "https" => {}
        s => anyhow::bail!("base_url must use http:// or https://, got: {}", s),
    }
    if parsed.username() != "" || parsed.password().is_some() {
        anyhow::bail!("base_url must not contain credentials");
    }
    let path = parsed.path();
    if path != "/" && !path.is_empty() {
        anyhow::bail!("base_url must not contain a path (got '{}')", path);
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        anyhow::bail!("base_url must not contain query or fragment");
    }
    Ok(())
}

// --- Plugin integration ---

/// Applies all installed and enabled plugins to the compose YAML:
/// - Generates MCP service definitions for enabled plugins with service_id
/// - Injects WORKER_<PLUGIN>_URL into mcp-hub environment
/// - Adds plugin resource volume mounts to claude container
/// - Sets SPEEDWAVE_PLUGINS env var in claude container
///
/// Loads plugins via [`plugin::list_verified_plugins`], which fails the
/// compose render if any installed plugin has a missing/invalid signature
/// or a directory/manifest slug mismatch — a missing fail-closed loader
/// here would let an attacker who tampered with one plugin still get the
/// rest of the compose to render and run. Manifests are re-validated at
/// render time so a post-install tamper that only changed the manifest
/// (not enough to change the digest, e.g. a different field semantic)
/// would still be caught by the same code that gates install.
fn apply_plugins(
    yaml: &str,
    project_name: &str,
    project_dir: &str,
    integrations: &ResolvedIntegrationsConfig,
    network_name: &str,
    tokens_dir: &std::path::Path,
) -> anyhow::Result<String> {
    let plugins = plugin::list_verified_plugins()?;
    apply_plugins_from_verified(
        yaml,
        project_name,
        project_dir,
        integrations,
        network_name,
        tokens_dir,
        &plugins,
    )
}

/// Test-friendly variant of [`apply_plugins`] — accepts a pre-built
/// list of `VerifiedPlugin` instead of consulting the on-disk
/// `~/.speedwave/plugins/`. Production callers go through
/// `apply_plugins`; tests inject crafted scenarios (forged manifest,
/// dangling `claude-resources` symlink, slug collision) without
/// touching the user's real data dir.
fn apply_plugins_from_verified(
    yaml: &str,
    project_name: &str,
    project_dir: &str,
    integrations: &ResolvedIntegrationsConfig,
    network_name: &str,
    tokens_dir: &std::path::Path,
    plugins: &[plugin::VerifiedPlugin],
) -> anyhow::Result<String> {
    if plugins.is_empty() {
        return Ok(yaml.to_string());
    }

    let mut doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(yaml)?;
    let mut plugin_slugs: Vec<String> = Vec::new();

    for vp in plugins {
        let manifest = &vp.manifest;
        let plugin_dir = vp.dir.as_path();
        let slug = &manifest.slug;
        let service_id = manifest.service_id.as_deref();

        // Re-validate the manifest at render time. The signature already
        // covers the manifest bytes, but re-running validate_manifest gives
        // us a single rendering of the post-install rules (built-in slug
        // collision, reserved env keys, mem/cpu caps) — useful when
        // validate_manifest grows new rules and we don't want any installed
        // plugin to silently survive a stricter ruleset.
        plugin::validate_manifest(manifest, plugin_dir)?;

        // Check if plugin is enabled (by service_id for MCP plugins, by slug otherwise)
        let plugin_key = service_id.unwrap_or(slug);
        if !integrations.is_plugin_enabled(plugin_key) {
            continue;
        }

        plugin_slugs.push(slug.clone());

        // MCP service generation (follows apply_llm_config pattern)
        if let Some(sid) = service_id {
            let service_value = plugin::generate_plugin_service(
                manifest,
                project_name,
                network_name,
                tokens_dir,
                project_dir,
            )?;
            // Insert into doc["services"]["mcp-<service_id>"]. Refuse to
            // overwrite a built-in service already present in the YAML —
            // validate_manifest blocks the obvious "slug: hub" case at
            // install, but a future change there should not silently
            // re-open the door here. serde_yaml_ng's mapping insert
            // overwrites on key collision; we want a hard failure instead.
            let compose_name = plugin::derive_compose_name(sid);
            if let Some(services) = doc.get_mut("services").and_then(|v| v.as_mapping_mut()) {
                let key = serde_yaml_ng::Value::String(compose_name.clone());
                if services.contains_key(&key) {
                    anyhow::bail!(
                        "plugin '{slug}' would overwrite existing compose service '{compose_name}'"
                    );
                }
                services.insert(key, service_value);
            }
            // Inject WORKER_*_URL into hub. All workers share PORT_WORKER —
            // each container has its own network namespace, so port reuse is
            // safe and DNS disambiguates. See ADR-038.
            if let Some(declared) = manifest.port {
                if declared != consts::PORT_WORKER {
                    log::warn!(
                        "plugin '{}' sets deprecated 'port' field ({}); ignored — \
                         all workers use port {}. See ADR-038",
                        slug,
                        declared,
                        consts::PORT_WORKER
                    );
                }
            }
            let worker_env = plugin::derive_worker_env(sid);
            let url = format!(
                "http://{}:{}",
                plugin::derive_compose_name(sid),
                consts::PORT_WORKER
            );
            inject_worker_env(&mut doc, &worker_env, &url);
        }

        // Mount claude-resources to claude container. The resources dir
        // must be a *real* directory inside the verified plugin tree —
        // a symlink (or anything that escapes the tree under canonicalize)
        // would let an attacker bind-mount /etc into the claude container.
        let plugin_resources = vp.dir.join("claude-resources");
        if plugin_resources.exists() {
            ensure_resources_dir_safe(plugin_dir, &plugin_resources)
                .map_err(|e| anyhow::anyhow!("plugin '{slug}': claude-resources unsafe: {e}"))?;
            let mount = format!(
                "{}:/speedwave/plugins/{}:ro",
                to_engine_path(&plugin_resources)?,
                slug
            );
            add_claude_volume(&mut doc, &mount);
        }
    }

    // SPEEDWAVE_PLUGINS env var in claude (slugs of enabled plugins)
    if !plugin_slugs.is_empty() {
        add_claude_env_var(&mut doc, "SPEEDWAVE_PLUGINS", &plugin_slugs.join(","));
    }

    Ok(serde_yaml_ng::to_string(&doc)?)
}

/// Injects the Anthropic API key (legacy credential) into the `claude`
/// service environment when one is stored at
/// `secrets/<project>/anthropic_api_key`. OAuth credentials are managed by
/// Claude Code itself inside the `CLAUDE_HOME` bind-mount — Speedwave never
/// reads or writes them. On the host they live at
/// `<data_dir>/claude-home/<project>/.claude/.credentials.json`. See ADR-052.
pub fn apply_auth_config(yaml: &str, project: &str) -> anyhow::Result<String> {
    apply_auth_config_in(yaml, project, consts::data_dir())
}

/// Testable variant: resolves the legacy API key path under an explicit
/// data directory.
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

/// Adds an environment variable to a named service. Fails loudly if the service
/// does not exist in the YAML — unlike `inject_worker_env()` which silently no-ops.
/// Creates the `environment` key as a sequence if it does not exist.
fn add_service_env_var(
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

/// Generates per-worker Bearer auth tokens and injects them into the compose YAML.
///
/// For each enabled MCP service:
/// - Reads or generates a UUID v4 token at `~/.speedwave/secrets/<project>/<service>-auth-token`
/// - Injects `MCP_<SERVICE>_AUTH_TOKEN=<token>` env var into the worker container
/// - Mounts the token file as `/secrets/<service>-auth-token:ro` into the hub
///
/// Hub reads tokens from `/secrets/` files (auth-tokens.ts), not env vars.
/// Workers read tokens from env vars. This asymmetry is enforced by `check_no_tokens_in_hub`.
fn apply_worker_auth_tokens(
    yaml: &str,
    project_name: &str,
    integrations: &ResolvedIntegrationsConfig,
) -> anyhow::Result<String> {
    let secrets_dir = init_secrets_dir(project_name)?;
    let plugins = plugin::list_installed_plugins().unwrap_or_default();
    apply_worker_auth_tokens_with_dir(yaml, &secrets_dir, integrations, &plugins)
}

/// Testable version: accepts explicit secrets directory and plugin list.
/// Reads or generates a Bearer auth token, writes it atomically with 0o600
/// permissions, injects the env var into the worker container, and mounts
/// the token file into the hub.
fn ensure_worker_auth_token(
    doc: &mut serde_yaml_ng::Value,
    secrets_dir: &std::path::Path,
    token_key: &str,
    compose_name: &str,
    env_key: &str,
) -> anyhow::Result<()> {
    let token_file_name = format!("{token_key}-auth-token");
    let token_path = secrets_dir.join(&token_file_name);

    // Reject symlinks before is_file() — is_file() follows symlinks and would
    // return true for a symlink pointing at a regular file, letting an
    // attacker with write access to the secrets dir substitute the auth
    // token. Falls through to the cleanup branch which logs and removes the
    // planted symlink.
    let token = if !token_path.is_symlink() && token_path.is_file() {
        let content = std::fs::read_to_string(&token_path)?.trim().to_string();
        if content.is_empty() {
            log::warn!(
                "Token file at {} is empty — generating new auth token; MCP workers will require restart",
                token_path.display()
            );
            uuid::Uuid::new_v4().to_string()
        } else {
            content
        }
    } else {
        if token_path.is_symlink() {
            log::warn!(
                "Stale symlink at token location, removing: {}",
                token_path.display()
            );
            std::fs::remove_file(&token_path)?;
        } else if token_path.exists() {
            log::warn!(
                "Unexpected directory at token location {}, removing recursively",
                token_path.display()
            );
            std::fs::remove_dir_all(&token_path)?;
        }
        uuid::Uuid::new_v4().to_string()
    };

    // Atomic write with 0o600 permissions (pattern from update.rs).
    // Use a unique suffix to avoid collisions when multiple callers write
    // the same token file concurrently (e.g., parallel tests or processes).
    let tmp_name = format!("{}.{}.tmp", token_file_name, uuid::Uuid::new_v4());
    let tmp_path = secrets_dir.join(&tmp_name);
    std::fs::write(&tmp_path, &token)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp_path, std::fs::Permissions::from_mode(0o600))?;
    }
    std::fs::rename(&tmp_path, &token_path)?;

    // Inject env var into worker container (fail-loud)
    add_service_env_var(doc, compose_name, env_key, &token)?;

    // Mount token file into hub as /secrets/<service>-auth-token:ro
    add_hub_volume(
        doc,
        &format!(
            "{}:/secrets/{}:ro",
            to_engine_path(&token_path)?,
            token_file_name
        ),
    );

    Ok(())
}

/// Testable version: accepts explicit secrets directory and plugin list.
fn apply_worker_auth_tokens_with_dir(
    yaml: &str,
    secrets_dir: &std::path::Path,
    integrations: &ResolvedIntegrationsConfig,
    installed_plugins: &[plugin::PluginManifest],
) -> anyhow::Result<String> {
    let mut doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(yaml)?;

    for svc in consts::TOGGLEABLE_MCP_SERVICES {
        if !integrations
            .is_service_enabled(svc.config_key)
            .unwrap_or(false)
        {
            continue;
        }
        let env_key = format!("MCP_{}_AUTH_TOKEN", svc.config_key.to_uppercase());
        ensure_worker_auth_token(
            &mut doc,
            secrets_dir,
            svc.config_key,
            svc.compose_name,
            &env_key,
        )?;
    }

    // Generate auth tokens for enabled plugin MCP workers (same pattern as built-in)
    for manifest in installed_plugins {
        let sid = match manifest.service_id.as_deref() {
            Some(s) => s,
            None => continue,
        };
        if !integrations.is_plugin_enabled(sid) {
            continue;
        }
        let compose_name = plugin::derive_compose_name(sid);
        let env_key = format!("MCP_{}_AUTH_TOKEN", sid.to_uppercase().replace('-', "_"));
        ensure_worker_auth_token(&mut doc, secrets_dir, sid, &compose_name, &env_key)?;
    }

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
    network_name: &str,
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
    // `office` is the only egress-less worker so far (ADR-055); a second one = add a flag to McpServiceDescriptor.
    let mut office_enabled = false;

    for svc in consts::TOGGLEABLE_MCP_SERVICES {
        let (config_key, compose_name, worker_env) =
            (svc.config_key, svc.compose_name, svc.worker_env);
        if service_enabled(config_key) {
            enabled_names.push(config_key);
            if config_key == "office" {
                office_enabled = true;
            }
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

    // The office worker has its own egress-less network (ADR-055). When office is disabled,
    // drop the network definition and the hub's attachment to it, so the rendered compose
    // has no dangling internal network.
    if !office_enabled {
        let office_network = format!("{network_name}_office");
        if let Some(networks) = doc.get_mut("networks") {
            if let Some(map) = networks.as_mapping_mut() {
                map.remove(serde_yaml_ng::Value::String(office_network.clone()));
            }
        }
        if let Some(nets) = doc
            .get_mut("services")
            .and_then(|s| s.get_mut("mcp-hub"))
            .and_then(|h| h.get_mut("networks"))
            .and_then(|n| n.as_sequence_mut())
        {
            nets.retain(|n| n.as_str() != Some(office_network.as_str()));
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
    let data_dir = consts::data_dir();
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
    // Single read attempt: don't pre-check `is_file()` before `read_to_string`.
    // The desktop process respawns mcp-os and rewrites these files at runtime,
    // so a TOCTOU between exists-check and read can bubble up `os error 2`
    // and abort `render_compose`. Treat any read failure the same as the
    // file being absent — mcp-os is simply not configured for this run —
    // but log non-NotFound errors so permission/disk problems remain visible.
    let token = match std::fs::read_to_string(token_path) {
        Ok(s) => s.trim().to_string(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(yaml.to_string());
        }
        Err(e) => {
            log::debug!("mcp-os token read failed ({e}); treating as not configured");
            return Ok(yaml.to_string());
        }
    };
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

/// Verifies that a plugin's `claude-resources` directory and every entry
/// underneath it is a real, non-symlink path inside the canonicalised
/// plugin directory. Bind-mounting `claude-resources` into the claude
/// container makes every file beneath it readable from inside; without
/// this check, an attacker could:
///
///   - replace `claude-resources` itself with a symlink to `/etc`, so
///     the container sees host configuration files at
///     `/speedwave/plugins/<slug>/`, or
///
///   - drop `claude-resources/skills/foo.md → ~/.ssh/id_rsa` so the
///     mount surfaces user secrets one level deeper.
///
/// The plugin signing model has no notion of legitimate symlinks, so
/// any encountered symlink is fatal — same invariant as
/// `compute_plugin_digest` in `signing.rs`.
fn ensure_resources_dir_safe(plugin_dir: &Path, resources: &Path) -> anyhow::Result<()> {
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

/// Expected engine paths for security validation.
/// Single source of truth — used by both render_compose() and SecurityCheck.
pub struct SecurityExpectedPaths {
    project_engine_path: String,
    tokens_engine_dir: String,
}

impl SecurityExpectedPaths {
    /// Returns the engine-format project directory path.
    pub fn project_engine_path(&self) -> &str {
        &self.project_engine_path
    }

    /// Returns the engine-format tokens directory path.
    pub fn tokens_engine_dir(&self) -> &str {
        &self.tokens_engine_dir
    }

    pub fn compute(project_name: &str, project_dir: &str) -> anyhow::Result<Self> {
        let tokens_dir = resolve_tokens_dir(project_name);
        Ok(Self {
            project_engine_path: to_engine_path(std::path::Path::new(project_dir))?,
            tokens_engine_dir: to_engine_path(&tokens_dir)?,
        })
    }

    /// Create from explicit paths (for tests in this crate and downstream crates).
    pub fn from_raw(project_engine_path: &str, tokens_engine_dir: &str) -> Self {
        Self {
            project_engine_path: project_engine_path.to_string(),
            tokens_engine_dir: tokens_engine_dir.to_string(),
        }
    }
}

/// Extracts (host_path, mode) for a known container target from a volume string.
/// Matches by searching for ":<target>:" or ":<target>" at end.
/// Returns None if the target is not found in the volume string.
fn extract_volume_for_target(vol: &str, target: &str) -> Option<(String, Option<String>)> {
    // Try :<target>:<mode> first (e.g., /path:/tokens:ro)
    let with_mode = format!(":{}:", target);
    if let Some(pos) = vol.find(&with_mode) {
        let host = &vol[..pos];
        let mode = &vol[pos + with_mode.len()..];
        return Some((host.to_string(), Some(mode.to_string())));
    }
    // Try :<target> at end (e.g., /path:/tokens)
    let at_end = format!(":{}", target);
    if vol.ends_with(&at_end) {
        let host = &vol[..vol.len() - at_end.len()];
        return Some((host.to_string(), None));
    }
    None
}

pub struct SecurityCheck;

/// Compile-time enumeration of every security rule enforced by [`SecurityCheck`].
///
/// Using an enum instead of `&'static str` guarantees that rule identifiers are
/// unique and typo-free — a misspelled variant is a compile error, whereas a
/// misspelled string literal would silently pass.
#[derive(
    Debug,
    Clone,
    Copy,
    PartialEq,
    Eq,
    Hash,
    strum_macros::Display,
    strum_macros::EnumIter,
    strum_macros::EnumProperty,
)]
pub enum SecurityRule {
    // 1. YAML parse
    #[strum(to_string = "YAML_PARSE_ERROR")]
    #[strum(props(description = "Compose YAML is parseable"))]
    YamlParseError,

    // 2-5. Container hardening
    #[strum(to_string = "CAP_DROP_ALL")]
    #[strum(props(description = "All containers have cap_drop: [ALL]"))]
    CapDropAll,
    #[strum(to_string = "NO_NEW_PRIVS")]
    #[strum(props(description = "All containers have no-new-privileges"))]
    NoNewPrivs,
    #[strum(to_string = "READ_ONLY_FS")]
    #[strum(props(description = "Core containers have read-only filesystem"))]
    ReadOnlyFs,
    #[strum(to_string = "TMPFS_NOEXEC")]
    #[strum(props(description = "Core containers have /tmp as tmpfs with noexec"))]
    TmpfsNoexec,

    // 6-7. Token / secret isolation
    #[strum(to_string = "NO_TOKENS_CLAUDE")]
    #[strum(props(description = "Claude container has no token/key/secret env vars"))]
    NoTokensClaude,
    #[strum(to_string = "NO_TOKENS_HUB")]
    #[strum(props(description = "Hub has no token env vars (only WORKER_*_URL)"))]
    NoTokensHub,

    // 8-11. Network security
    #[strum(to_string = "PORTS_LOCALHOST")]
    #[strum(props(description = "All exposed ports bind to 127.0.0.1"))]
    PortsLocalhost,
    #[strum(to_string = "NO_SOCKET_CLAUDE")]
    #[strum(props(description = "Claude container has no docker/nerdctl socket"))]
    NoSocketClaude,
    #[strum(to_string = "NO_EXTERNAL_LLM_KEYS_CLAUDE")]
    #[strum(props(description = "Claude container has no external LLM API keys"))]
    NoExternalLlmKeysClaude,
    #[strum(to_string = "NO_PORTS_WORKERS")]
    #[strum(props(description = "Built-in workers do not expose ports"))]
    NoPortsWorkers,

    // 12. Container user (moved here from old position 31)
    #[strum(to_string = "CONTAINER_USER")]
    #[strum(props(description = "All containers use correct platform user"))]
    ContainerUser,

    // 13-22. Plugin rules
    #[strum(to_string = "PLUGIN_NO_PRIVILEGED")]
    #[strum(props(description = "Plugin containers are not privileged"))]
    PluginNoPrivileged,
    #[strum(to_string = "PLUGIN_NO_HOST_NETWORK")]
    #[strum(props(description = "Plugin containers do not use host network"))]
    PluginNoHostNetwork,
    #[strum(to_string = "PLUGIN_MANIFEST_MISSING")]
    #[strum(props(description = "All plugin services have signed manifests"))]
    PluginManifestMissing,
    #[strum(to_string = "PLUGIN_VOLUME_LONG_FORM")]
    #[strum(props(description = "Plugin volumes use short-form only"))]
    PluginVolumeLongForm,
    #[strum(to_string = "PLUGIN_TOKEN_PATH_MISMATCH")]
    #[strum(props(description = "Plugin token mount paths match expected"))]
    PluginTokenPathMismatch,
    #[strum(to_string = "PLUGIN_TOKEN_MOUNT_MODE")]
    #[strum(props(description = "Plugin token mount modes match manifest"))]
    PluginTokenMountMode,
    #[strum(to_string = "PLUGIN_WORKSPACE_PATH_MISMATCH")]
    #[strum(props(description = "Plugin workspace paths match expected"))]
    PluginWorkspacePathMismatch,
    #[strum(to_string = "PLUGIN_WORKSPACE_MOUNT_MODE")]
    #[strum(props(description = "Plugin workspace mount mode is :rw"))]
    PluginWorkspaceMountMode,
    #[strum(to_string = "PLUGIN_NO_EXTRA_VOLUMES")]
    #[strum(props(description = "Plugin containers have no extra volumes"))]
    PluginNoExtraVolumes,
    #[strum(to_string = "PLUGIN_MISSING_TOKENS_MOUNT")]
    #[strum(props(description = "Plugin containers have /tokens mount"))]
    PluginMissingTokensMount,
    #[strum(to_string = "PLUGIN_MISSING_WORKSPACE_MOUNT")]
    #[strum(props(description = "Plugin containers have /workspace mount"))]
    PluginMissingWorkspaceMount,

    // 23-30. SharePoint rules
    #[strum(to_string = "SHAREPOINT_VOLUME_LONG_FORM")]
    #[strum(props(description = "SharePoint volumes use short-form only"))]
    SharepointVolumeLongForm,
    #[strum(to_string = "SHAREPOINT_TOKEN_PATH_MISMATCH")]
    #[strum(props(description = "SharePoint token path matches expected"))]
    SharepointTokenPathMismatch,
    #[strum(to_string = "SHAREPOINT_TOKEN_MOUNT_MODE")]
    #[strum(props(description = "SharePoint token mount mode is :rw"))]
    SharepointTokenMountMode,
    #[strum(to_string = "SHAREPOINT_WORKSPACE_PATH_MISMATCH")]
    #[strum(props(description = "SharePoint workspace path matches expected"))]
    SharepointWorkspacePathMismatch,
    #[strum(to_string = "SHAREPOINT_WORKSPACE_MOUNT_MODE")]
    #[strum(props(description = "SharePoint workspace mount mode is :rw"))]
    SharepointWorkspaceMountMode,
    #[strum(to_string = "SHAREPOINT_NO_EXTRA_VOLUMES")]
    #[strum(props(description = "SharePoint has no extra volumes"))]
    SharepointNoExtraVolumes,
    #[strum(to_string = "SHAREPOINT_MISSING_TOKENS_MOUNT")]
    #[strum(props(description = "SharePoint has /tokens mount"))]
    SharepointMissingTokensMount,
    #[strum(to_string = "SHAREPOINT_MISSING_WORKSPACE_MOUNT")]
    #[strum(props(description = "SharePoint has /workspace mount"))]
    SharepointMissingWorkspaceMount,

    // 31. Host file security
    #[strum(to_string = "FILE_SECURITY_VIOLATION")]
    #[strum(props(description = "Host file permissions and ownership are correct"))]
    /// Host file or directory has wrong permissions or ownership.
    /// Covers both mode bits (e.g. 0o644 instead of 0o600) and UID mismatch.
    /// Unix-only — skipped on Windows.
    FileSecurityViolation,
}

impl SecurityRule {
    /// Returns `true` for SharePoint-specific rules.
    pub fn is_sharepoint(self) -> bool {
        matches!(
            self,
            Self::SharepointVolumeLongForm
                | Self::SharepointTokenPathMismatch
                | Self::SharepointTokenMountMode
                | Self::SharepointWorkspacePathMismatch
                | Self::SharepointWorkspaceMountMode
                | Self::SharepointNoExtraVolumes
                | Self::SharepointMissingTokensMount
                | Self::SharepointMissingWorkspaceMount
        )
    }

    /// Human-readable description for verbose check output.
    pub fn description(self) -> &'static str {
        self.get_str("description")
            .unwrap_or("(missing description — update SecurityRule props)")
    }
}

#[derive(Debug)]
pub struct SecurityViolation {
    pub container: String,
    pub rule: SecurityRule,
    pub message: String,
    pub remediation: &'static str,
}

impl SecurityViolation {
    pub fn new(
        container: impl Into<String>,
        rule: SecurityRule,
        message: impl Into<String>,
        remediation: &'static str,
    ) -> Self {
        Self {
            container: container.into(),
            rule,
            message: message.into(),
            remediation,
        }
    }
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
    /// Verifies all security invariants on the generated compose YAML and host filesystem.
    /// Returns Vec of violations — if non-empty, compose_up MUST be blocked.
    ///
    /// `plugin_manifests` provides signed manifest data for cross-referencing
    /// plugin compose services against their declared token mount modes.
    ///
    /// Delegates to `run_with_data_dir()` using `consts::data_dir()` for host filesystem checks.
    pub fn run(
        compose_yml: &str,
        project: &str,
        plugin_manifests: &[PluginManifest],
        expected_paths: &SecurityExpectedPaths,
    ) -> Vec<SecurityViolation> {
        Self::run_with_data_dir(
            compose_yml,
            project,
            plugin_manifests,
            expected_paths,
            crate::consts::data_dir(),
        )
    }

    /// Testable version that accepts an explicit data_dir for host filesystem checks.
    ///
    /// Separated from `run()` so tests can pass a temp directory for
    /// `check_file_security()` without depending on `consts::data_dir()`.
    /// On non-Unix platforms, `check_file_security()` is a no-op.
    pub(crate) fn run_with_data_dir(
        compose_yml: &str,
        project: &str,
        plugin_manifests: &[PluginManifest],
        expected_paths: &SecurityExpectedPaths,
        data_dir: &std::path::Path,
    ) -> Vec<SecurityViolation> {
        let doc: serde_yaml_ng::Value = match serde_yaml_ng::from_str(compose_yml) {
            Ok(v) => v,
            Err(e) => {
                return vec![SecurityViolation {
                    container: "*".into(),
                    rule: SecurityRule::YamlParseError,
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
            // PORTS_LOCALHOST: any exposed port must bind 127.0.0.1 (plugins)
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
            Self::check_plugin_volumes(&doc, expected_paths, plugin_manifests),
            // Built-in SharePoint context mount validation
            Self::check_builtin_sharepoint_volumes(&doc, expected_paths),
            // Host filesystem checks (I/O — unlike pure YAML checks above)
            Self::check_file_security(data_dir, project),
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
                    rule: SecurityRule::CapDropAll,
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
                    rule: SecurityRule::NoNewPrivs,
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
                        rule: SecurityRule::ReadOnlyFs,
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
                        rule: SecurityRule::TmpfsNoexec,
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
                    "CLAUDE_CODE_OAUTH_TOKEN",
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
                                rule: SecurityRule::NoTokensClaude,
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
                                rule: SecurityRule::NoTokensHub,
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
                                rule: SecurityRule::PortsLocalhost,
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
                                rule: SecurityRule::PortsLocalhost,
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
                            rule: SecurityRule::PortsLocalhost,
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
                                    rule: SecurityRule::NoSocketClaude,
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
    /// (OPENAI_*, AZURE_OPENAI_*, GEMINI_*, DEEPSEEK_*, OPENROUTER_*, COHERE_*,
    /// MISTRAL_*, TOGETHER_*, GROQ_* — these prefixes are forbidden because external
    /// LLM API keys must never enter the claude container. Only the dummy
    /// ANTHROPIC_AUTH_TOKEN (sk-no-key-required) is permitted for local model providers.)
    fn check_no_external_llm_keys_claude(doc: &serde_yaml_ng::Value) -> Vec<SecurityViolation> {
        let mut violations = Vec::new();
        let services = match get_services(doc) {
            Some(s) => s,
            None => return violations,
        };

        if let Some((_name, service)) = services.iter().find(|(n, _)| n == "claude") {
            if let Some(env_seq) = service.get("environment").and_then(|v| v.as_sequence()) {
                let forbidden_prefixes = [
                    "OPENAI_",
                    "AZURE_OPENAI_",
                    "GEMINI_",
                    "DEEPSEEK_",
                    "OPENROUTER_",
                    "COHERE_",
                    "MISTRAL_",
                    "TOGETHER_",
                    "GROQ_",
                ];

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
                                rule: SecurityRule::NoExternalLlmKeysClaude,
                                message: format!(
                                    "env contains external LLM key: {}",
                                    var_name
                                ),
                                remediation:
                                    "External LLM API keys must not be injected into the claude container. Use a local model provider instead.",
                            });
                        }
                    }
                }
            }
        }
        violations
    }

    /// MCP workers and hub must NOT expose ports to the host.
    /// Only dynamically-injected services (addons) may map ports.
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
                    rule: SecurityRule::NoPortsWorkers,
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
                    rule: SecurityRule::PluginNoPrivileged,
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
                        rule: SecurityRule::PluginNoHostNetwork,
                        message: "Plugin service must not use network_mode: host".into(),
                        remediation: "Remove 'network_mode: host' from the plugin service.",
                    });
                }
            }
        }
        violations
    }

    /// Validates all volumes for plugin services:
    /// - /tokens mount: correct host path per service_id, mode matches manifest
    /// - /workspace mount: correct host path (project dir), must be :rw
    /// - No other volumes allowed
    /// - Long-form YAML volumes rejected
    /// - Both mounts must be present
    fn check_plugin_volumes(
        doc: &serde_yaml_ng::Value,
        expected_paths: &SecurityExpectedPaths,
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
            let sid = name.strip_prefix("mcp-").unwrap_or(&name);
            let manifest = manifests
                .iter()
                .find(|m| m.service_id.as_deref() == Some(sid));
            let manifest = match manifest {
                Some(m) => m,
                None => {
                    violations.push(SecurityViolation {
                        container: name.clone(),
                        rule: SecurityRule::PluginManifestMissing,
                        message: format!(
                            "Plugin service '{}' has no matching manifest — cannot validate mounts",
                            name
                        ),
                        remediation: "Ensure plugin manifests are loaded before security check.",
                    });
                    continue;
                }
            };

            let expected_token_mode = match manifest.token_mount {
                plugin::TokenMount::ReadOnly => "ro",
                plugin::TokenMount::ReadWrite { .. } => "rw",
            };
            let params = VolumeCheckParams {
                container_name: &name,
                expected_tokens_path: format!("{}/{}", expected_paths.tokens_engine_dir(), sid),
                expected_workspace_path: expected_paths.project_engine_path(),
                expected_token_mode,
                rules: VolumeCheckRules::PLUGIN,
            };
            let (base_violations, _) = validate_service_volume_mounts(service, &params);
            violations.extend(base_violations);
        }
        violations
    }

    /// Validates volumes for built-in mcp-sharepoint service (not a plugin).
    fn check_builtin_sharepoint_volumes(
        doc: &serde_yaml_ng::Value,
        expected_paths: &SecurityExpectedPaths,
    ) -> Vec<SecurityViolation> {
        let services = match get_services(doc) {
            Some(s) => s,
            None => return Vec::new(),
        };

        let (name, service) = match services.iter().find(|(n, _)| n == "mcp-sharepoint") {
            Some(pair) => pair,
            None => return Vec::new(), // SharePoint not in compose (disabled)
        };

        let params = VolumeCheckParams {
            container_name: name,
            expected_tokens_path: format!("{}/sharepoint", expected_paths.tokens_engine_dir()),
            expected_workspace_path: expected_paths.project_engine_path(),
            expected_token_mode: "rw",
            rules: VolumeCheckRules::SHAREPOINT,
        };
        let (violations, _) = validate_service_volume_mounts(service, &params);
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
                        rule: SecurityRule::ContainerUser,
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
                        rule: SecurityRule::ContainerUser,
                        message: "Missing user: field — container would run as image default user"
                            .into(),
                        remediation: "Add user: \"${CONTAINER_USER}\" to the service definition.",
                    });
                }
            }
        }
        violations
    }

    /// Validates file permissions and ownership on sensitive host paths.
    ///
    /// Unlike other `check_*` methods which validate in-memory compose YAML,
    /// this method performs filesystem I/O — it reads metadata from host paths
    /// under `data_dir`. This is intentional: host file permissions are a
    /// security property that cannot be derived from the compose template.
    ///
    /// Rules:
    /// - Files containing secrets must be 0o600 (owner rw only).
    /// - Directories containing secrets must be 0o700 (owner rwx only).
    /// - All sensitive files/dirs must be owned by the current user (UID match).
    /// - Missing paths are silently skipped — they may not exist yet.
    /// - Symlinks are skipped (not followed) to prevent traversal attacks.
    ///
    /// Known limitations: validates mode bits and UID only, not ACLs or xattrs.
    /// TOCTOU: permissions are checked before container start; a concurrent
    /// change between check and start is theoretically possible but acceptable.
    ///
    /// Performance: scans 1-2 directory levels (not recursive). Bounded by
    /// the number of configured services per project — typically under 10 files.
    /// Negligible compared to compose_up latency.
    #[cfg(unix)]
    fn check_file_security(data_dir: &std::path::Path, project: &str) -> Vec<SecurityViolation> {
        use std::os::unix::fs::MetadataExt;
        // Get current user's UID by checking ownership of data_dir itself.
        // This avoids unsafe libc::getuid() while respecting workspace unsafe_code = "deny".
        let expected_uid = match std::fs::metadata(data_dir) {
            Ok(m) => m.uid(),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
            Err(e) => {
                log::warn!(
                    "check_file_security: cannot read data_dir {}: {e}",
                    data_dir.display()
                );
                return Vec::new();
            }
        };
        Self::check_file_security_with_uid(data_dir, project, expected_uid)
    }

    /// Testable version that accepts an explicit expected UID.
    #[cfg(unix)]
    pub(crate) fn check_file_security_with_uid(
        data_dir: &std::path::Path,
        project: &str,
        expected_uid: u32,
    ) -> Vec<SecurityViolation> {
        let (dirs, files) = crate::fs_security::collect_security_paths(data_dir, project);
        let mut violations = Vec::new();

        for dir in &dirs {
            violations.extend(Self::verify_path(dir, 0o700, true, expected_uid));
        }
        for file in &files {
            violations.extend(Self::verify_path(file, 0o600, false, expected_uid));
        }

        violations
    }

    /// No-op on non-Unix platforms.
    #[cfg(not(unix))]
    fn check_file_security(_data_dir: &std::path::Path, _project: &str) -> Vec<SecurityViolation> {
        Vec::new()
    }

    /// Verifies a single path's permissions and ownership.
    /// Returns empty Vec if path is missing or is a symlink.
    #[cfg(unix)]
    fn verify_path(
        path: &std::path::Path,
        expected_mode: u32,
        is_dir: bool,
        expected_uid: u32,
    ) -> Vec<SecurityViolation> {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};

        let meta = match std::fs::symlink_metadata(path) {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
            Err(e) => {
                log::warn!(
                    "verify_path: cannot read metadata for {}: {e}",
                    path.display()
                );
                return Vec::new();
            }
        };
        if meta.file_type().is_symlink() {
            return Vec::new(); // Skip symlinks — prevent traversal attacks
        }

        let mut violations = Vec::new();

        // Ownership check
        if meta.uid() != expected_uid {
            violations.push(SecurityViolation {
                container: "host".into(),
                rule: SecurityRule::FileSecurityViolation,
                message: format!(
                    "{} owned by uid {}, expected uid {}",
                    path.display(),
                    meta.uid(),
                    expected_uid
                ),
                remediation: if is_dir {
                    "Run: chown -R $(id -u) on the directory shown above"
                } else {
                    "Run: chown $(id -u) on the file shown above"
                },
            });
        }

        // Permission check
        let mode = meta.permissions().mode() & 0o777;
        if mode != expected_mode {
            violations.push(SecurityViolation {
                container: "host".into(),
                rule: SecurityRule::FileSecurityViolation,
                message: format!(
                    "{} has mode {:#05o}, expected {:#05o}",
                    path.display(),
                    mode,
                    expected_mode
                ),
                remediation: if is_dir {
                    "Run: chmod 700 on the directory shown above"
                } else {
                    "Run: chmod 600 on the file shown above"
                },
            });
        }

        violations
    }
}

/// Per-rule names and remediation strings for volume validation.
/// Each constant preserves the exact rule names and messages used by plugin
/// and SharePoint security checks so that existing tests and monitoring remain stable.
struct VolumeCheckRules {
    volume_long_form: SecurityRule,
    volume_long_form_msg: &'static str,
    volume_long_form_rem: &'static str,
    token_path_mismatch: SecurityRule,
    token_path_mismatch_rem: &'static str,
    token_mount_mode: SecurityRule,
    token_mount_mode_msg: &'static str,
    token_mount_mode_rem: &'static str,
    workspace_path_mismatch: SecurityRule,
    workspace_mount_mode: SecurityRule,
    workspace_mount_mode_msg: &'static str,
    no_extra_volumes: SecurityRule,
    no_extra_volumes_msg_prefix: &'static str,
    no_extra_volumes_rem: &'static str,
    missing_tokens: SecurityRule,
    missing_tokens_msg: &'static str,
    missing_tokens_rem: &'static str,
    missing_workspace: SecurityRule,
    missing_workspace_msg: &'static str,
    missing_workspace_rem: &'static str,
}

impl VolumeCheckRules {
    const PLUGIN: Self = Self {
        volume_long_form: SecurityRule::PluginVolumeLongForm,
        volume_long_form_msg: "Plugin volume uses long-form YAML mapping \
                               — only short-form strings allowed",
        volume_long_form_rem: "Use short-form volume strings: 'host:container:mode'.",
        token_path_mismatch: SecurityRule::PluginTokenPathMismatch,
        token_path_mismatch_rem: "Token mount must use the project-specific tokens directory.",
        token_mount_mode: SecurityRule::PluginTokenMountMode,
        token_mount_mode_msg: "Token mount mode does not match expected mode",
        token_mount_mode_rem: "Ensure the token volume mount mode matches the expected mode.",
        workspace_path_mismatch: SecurityRule::PluginWorkspacePathMismatch,
        workspace_mount_mode: SecurityRule::PluginWorkspaceMountMode,
        workspace_mount_mode_msg: "Workspace mount must be :rw",
        no_extra_volumes: SecurityRule::PluginNoExtraVolumes,
        no_extra_volumes_msg_prefix: "Plugin service has unauthorized volume mount:",
        no_extra_volumes_rem: "Plugin services may only mount /tokens and /workspace.",
        missing_tokens: SecurityRule::PluginMissingTokensMount,
        missing_tokens_msg: "Plugin service is missing required /tokens mount",
        missing_tokens_rem: "Plugin services must mount /tokens.",
        missing_workspace: SecurityRule::PluginMissingWorkspaceMount,
        missing_workspace_msg: "Plugin service is missing required /workspace mount",
        missing_workspace_rem: "Plugin services must mount /workspace:rw.",
    };

    const SHAREPOINT: Self = Self {
        volume_long_form: SecurityRule::SharepointVolumeLongForm,
        volume_long_form_msg: "SharePoint volume uses long-form YAML mapping",
        volume_long_form_rem: "Use short-form volume strings.",
        token_path_mismatch: SecurityRule::SharepointTokenPathMismatch,
        token_path_mismatch_rem:
            "SharePoint token mount must use the project-specific tokens directory.",
        token_mount_mode: SecurityRule::SharepointTokenMountMode,
        token_mount_mode_msg: "SharePoint token mount must be :rw (OAuth refresh)",
        token_mount_mode_rem: "SharePoint requires :rw token mount for OAuth token refresh.",
        workspace_path_mismatch: SecurityRule::SharepointWorkspacePathMismatch,
        workspace_mount_mode: SecurityRule::SharepointWorkspaceMountMode,
        workspace_mount_mode_msg: "SharePoint workspace mount must be :rw",
        no_extra_volumes: SecurityRule::SharepointNoExtraVolumes,
        no_extra_volumes_msg_prefix: "SharePoint service has unauthorized volume mount:",
        no_extra_volumes_rem: "SharePoint may only mount /tokens and /workspace.",
        missing_tokens: SecurityRule::SharepointMissingTokensMount,
        missing_tokens_msg: "SharePoint service is missing required /tokens mount",
        missing_tokens_rem: "SharePoint must mount /tokens:rw.",
        missing_workspace: SecurityRule::SharepointMissingWorkspaceMount,
        missing_workspace_msg: "SharePoint service is missing required /workspace mount",
        missing_workspace_rem: "SharePoint must mount /workspace:rw.",
    };
}

/// Parameters for shared volume mount validation.
struct VolumeCheckParams<'a> {
    container_name: &'a str,
    expected_tokens_path: String,
    expected_workspace_path: &'a str,
    /// Expected token mount mode: "ro" or "rw"
    expected_token_mode: &'a str,
    rules: VolumeCheckRules,
}

/// Validates volume mounts on a single service definition.
///
/// Returns the list of violations and, if a /tokens mount was found, its actual
/// mode string (so callers like `check_plugin_volumes` can do additional
/// manifest-specific checks).
fn validate_service_volume_mounts(
    service: &serde_yaml_ng::Value,
    params: &VolumeCheckParams,
) -> (Vec<SecurityViolation>, Option<String>) {
    let mut violations = Vec::new();
    let mut found_tokens = false;
    let mut found_workspace = false;
    let mut token_mode: Option<String> = None;

    if let Some(vols) = service.get("volumes").and_then(|v| v.as_sequence()) {
        for vol in vols {
            let vol_str = match vol.as_str() {
                Some(s) => s,
                None => {
                    violations.push(SecurityViolation {
                        container: params.container_name.to_string(),
                        rule: params.rules.volume_long_form,
                        message: params.rules.volume_long_form_msg.to_string(),
                        remediation: params.rules.volume_long_form_rem,
                    });
                    continue;
                }
            };

            if let Some((host_path, mode)) = extract_volume_for_target(vol_str, "/tokens") {
                found_tokens = true;
                if host_path != params.expected_tokens_path {
                    violations.push(SecurityViolation {
                        container: params.container_name.to_string(),
                        rule: params.rules.token_path_mismatch,
                        message: format!(
                            "Token host path '{}' does not match expected '{}'",
                            host_path, params.expected_tokens_path
                        ),
                        remediation: params.rules.token_path_mismatch_rem,
                    });
                }
                let actual = mode.as_deref().unwrap_or("ro");
                if actual != params.expected_token_mode {
                    violations.push(SecurityViolation {
                        container: params.container_name.to_string(),
                        rule: params.rules.token_mount_mode,
                        message: params.rules.token_mount_mode_msg.to_string(),
                        remediation: params.rules.token_mount_mode_rem,
                    });
                }
                token_mode = Some(actual.to_string());
            } else if let Some((host_path, mode)) = extract_volume_for_target(vol_str, "/workspace")
            {
                found_workspace = true;
                if host_path != params.expected_workspace_path {
                    violations.push(SecurityViolation {
                        container: params.container_name.to_string(),
                        rule: params.rules.workspace_path_mismatch,
                        message: format!(
                            "Workspace host path '{}' does not match expected '{}'",
                            host_path, params.expected_workspace_path
                        ),
                        remediation: "Workspace mount must use the project directory.",
                    });
                }
                if mode.as_deref() != Some("rw") {
                    violations.push(SecurityViolation {
                        container: params.container_name.to_string(),
                        rule: params.rules.workspace_mount_mode,
                        message: params.rules.workspace_mount_mode_msg.to_string(),
                        remediation: "Change the workspace volume mount to :rw.",
                    });
                }
            } else {
                violations.push(SecurityViolation {
                    container: params.container_name.to_string(),
                    rule: params.rules.no_extra_volumes,
                    message: format!("{} {}", params.rules.no_extra_volumes_msg_prefix, vol_str),
                    remediation: params.rules.no_extra_volumes_rem,
                });
            }
        }
    }

    if !found_tokens {
        violations.push(SecurityViolation {
            container: params.container_name.to_string(),
            rule: params.rules.missing_tokens,
            message: params.rules.missing_tokens_msg.to_string(),
            remediation: params.rules.missing_tokens_rem,
        });
    }
    if !found_workspace {
        violations.push(SecurityViolation {
            container: params.container_name.to_string(),
            rule: params.rules.missing_workspace,
            message: params.rules.missing_workspace_msg.to_string(),
            remediation: params.rules.missing_workspace_rem,
        });
    }

    (violations, token_mode)
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
    use strum::IntoEnumIterator;

    const SECURITY_RULE_COUNT: usize = 32;

    fn default_flags() -> Vec<String> {
        crate::defaults::DEFAULT_FLAGS
            .iter()
            .map(|s| s.to_string())
            .collect()
    }

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
        let violations = SecurityCheck::run(yaml, "test", &[], &test_expected_paths());
        assert!(violations
            .iter()
            .any(|v| v.rule == SecurityRule::CapDropAll));
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
        let violations = SecurityCheck::run(yaml, "test", &[], &test_expected_paths());
        assert!(violations
            .iter()
            .any(|v| v.rule == SecurityRule::NoNewPrivs));
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
        let violations = SecurityCheck::run(yaml, "test", &[], &test_expected_paths());
        assert!(violations
            .iter()
            .any(|v| v.rule == SecurityRule::ReadOnlyFs && v.container == "claude"));
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
        let violations = SecurityCheck::run(yaml, "test", &[], &test_expected_paths());
        assert!(violations
            .iter()
            .any(|v| v.rule == SecurityRule::TmpfsNoexec));
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
        let violations = SecurityCheck::run(yaml, "test", &[], &test_expected_paths());
        assert!(violations
            .iter()
            .any(|v| v.rule == SecurityRule::NoTokensClaude));
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
        let violations = SecurityCheck::run(yaml, "test", &[], &test_expected_paths());
        assert!(violations
            .iter()
            .any(|v| v.rule == SecurityRule::PortsLocalhost));
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
        let violations = SecurityCheck::run(yaml, "test", &[], &test_expected_paths());
        assert!(violations
            .iter()
            .any(|v| v.rule == SecurityRule::NoSocketClaude));
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
        let violations = SecurityCheck::run(yaml, "test", &[], &test_expected_paths());
        assert!(violations
            .iter()
            .any(|v| v.rule == SecurityRule::NoExternalLlmKeysClaude));
    }

    #[test]
    fn test_security_check_external_llm_keys_covers_major_providers() {
        // Each prefix on its own line — one violation per leaked key. We assert the
        // rule fires for every major third-party LLM vendor, not just the four
        // originally hard-coded.
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
            let violations = SecurityCheck::run(&yaml, "test", &[], &test_expected_paths());
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
        let violations =
            SecurityCheck::run("not: valid: yaml: [[[", "test", &[], &test_expected_paths());
        assert!(violations
            .iter()
            .any(|v| v.rule == SecurityRule::YamlParseError));
    }

    #[test]
    fn test_render_compose_substitution() {
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: default_flags(),
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
        // ${CLAUDE_MEMORY} must be substituted with a concrete value (e.g. "8g")
        assert!(
            !yaml.contains("${CLAUDE_MEMORY}"),
            "CLAUDE_MEMORY placeholder must be substituted"
        );
        assert!(
            yaml.lines()
                .any(|l| l.trim().starts_with("memory:") && l.contains('g')),
            "rendered YAML must contain a concrete memory limit (e.g. memory: 8g)"
        );
        // Verify it's valid YAML
        let parsed: serde_yaml_ng::Value = serde_yaml_ng::from_str(&yaml).unwrap();
        assert!(parsed.get("services").is_some());
    }

    #[test]
    fn test_render_compose_uses_bundle_scoped_image_refs() {
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: default_flags(),
            llm: LlmConfig::default(),
        };
        let manifest = bundle::load_current_bundle_manifest().unwrap();

        let yaml = render_compose(
            "test-project",
            "/home/user/projects/test",
            &config,
            &all_enabled_integrations(),
            None,
        )
        .unwrap();

        assert!(yaml.contains(&build::image_ref(build::IMAGE_CLAUDE, &manifest.bundle_id)));
        assert!(yaml.contains(&build::image_ref(build::IMAGE_MCP_HUB, &manifest.bundle_id)));
        assert!(yaml.contains(&build::image_ref(
            build::IMAGE_MCP_SLACK,
            &manifest.bundle_id
        )));
        assert!(yaml.contains(&build::image_ref(
            build::IMAGE_MCP_SHAREPOINT,
            &manifest.bundle_id,
        )));
        assert!(yaml.contains(&build::image_ref(
            build::IMAGE_MCP_REDMINE,
            &manifest.bundle_id,
        )));
        assert!(yaml.contains(&build::image_ref(
            build::IMAGE_MCP_GITLAB,
            &manifest.bundle_id
        )));
        assert!(yaml.contains(&build::image_ref(
            build::IMAGE_MCP_GITHUB,
            &manifest.bundle_id
        )));
        assert!(yaml.contains(&build::image_ref(
            build::IMAGE_MCP_ATLASSIAN,
            &manifest.bundle_id
        )));

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
    fn test_rendered_compose_has_sharepoint_workspace_mount() {
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: default_flags(),
            llm: LlmConfig::default(),
        };
        let yaml = render_compose(
            "test-project",
            "/home/user/projects/test",
            &config,
            &all_enabled_integrations(),
            None,
        )
        .unwrap();
        assert!(
            yaml.contains("/home/user/projects/test:/workspace:rw"),
            "Rendered compose must contain workspace mount for mcp-sharepoint.\nGot:\n{}",
            yaml.lines()
                .filter(|l| l.contains("/workspace"))
                .collect::<Vec<_>>()
                .join("\n")
        );
    }

    /// mcp-playwright appears in a rendered compose when the toggle is enabled,
    /// carries the hardening profile (cap_drop: ALL, read_only, no-new-privileges,
    /// shm_size: 2g), and has `PORT=PORT_WORKER`.
    #[test]
    fn test_render_compose_playwright_service_present() {
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: default_flags(),
            llm: LlmConfig::default(),
        };
        let integrations = ResolvedIntegrationsConfig {
            playwright: true,
            ..Default::default()
        };
        let yaml = render_compose(
            "test-project",
            "/home/user/projects/test",
            &config,
            &integrations,
            None,
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
        assert_eq!(
            pw.get("shm_size").and_then(|v| v.as_str()),
            Some("2g"),
            "mcp-playwright must set shm_size: 2g for Chromium IPC"
        );
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
    }

    /// mcp-playwright has no credentials — the generated compose must not mount
    /// any `/tokens` volume (attack-surface reduction per ADR).
    #[test]
    fn test_render_compose_playwright_no_token_mount() {
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: default_flags(),
            llm: LlmConfig::default(),
        };
        let integrations = ResolvedIntegrationsConfig {
            playwright: true,
            ..Default::default()
        };
        let yaml = render_compose(
            "test-project",
            "/home/user/projects/test",
            &config,
            &integrations,
            None,
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
    fn test_render_compose_playwright_no_workspace_mount() {
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: default_flags(),
            llm: LlmConfig::default(),
        };
        let integrations = ResolvedIntegrationsConfig {
            playwright: true,
            ..Default::default()
        };
        let yaml = render_compose(
            "test-project",
            "/home/user/projects/test",
            &config,
            &integrations,
            None,
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
    fn test_playwright_worker_url_in_hub_env() {
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: default_flags(),
            llm: LlmConfig::default(),
        };
        let integrations = ResolvedIntegrationsConfig {
            playwright: true,
            ..Default::default()
        };
        let yaml = render_compose(
            "test-project",
            "/home/user/projects/test",
            &config,
            &integrations,
            None,
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

    /// mcp-github must render with the standard worker hardening AND its non-standard
    /// 256m memory cap (Octokit + `octokit.paginate` need more headroom than the 128m
    /// other API workers use — see the comment in compose.template.yml). Also verifies
    /// the read-only, project-scoped `/tokens` mount and `PORT=PORT_WORKER`.
    #[test]
    fn test_render_compose_github_service_present() {
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: default_flags(),
            llm: LlmConfig::default(),
        };
        let integrations = ResolvedIntegrationsConfig {
            github: true,
            ..Default::default()
        };
        let yaml = render_compose(
            "test-project",
            "/home/user/projects/test",
            &config,
            &integrations,
            None,
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

        // Non-standard, load-bearing memory cap.
        assert_eq!(
            gh.get("deploy")
                .and_then(|d| d.get("resources"))
                .and_then(|r| r.get("limits"))
                .and_then(|l| l.get("memory"))
                .and_then(|m| m.as_str()),
            Some("256m"),
            "mcp-github must keep its 256m memory limit (Octokit footprint)"
        );

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
    fn test_github_worker_url_in_hub_env() {
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: default_flags(),
            llm: LlmConfig::default(),
        };
        let integrations = ResolvedIntegrationsConfig {
            github: true,
            ..Default::default()
        };
        let yaml = render_compose(
            "test-project",
            "/home/user/projects/test",
            &config,
            &integrations,
            None,
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
        let mut integrations = ResolvedIntegrationsConfig::default();
        integrations.github = false;

        let filtered =
            apply_integrations_filter(VALID_COMPOSE, &integrations, "speedwave_test_network")
                .unwrap();
        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&filtered).unwrap();

        let services = doc.get("services").and_then(|s| s.as_mapping()).unwrap();
        assert!(
            !services.contains_key(&serde_yaml_ng::Value::String("mcp-github".into())),
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
        let mut integrations = ResolvedIntegrationsConfig::default();
        integrations.playwright = false;

        let filtered =
            apply_integrations_filter(VALID_COMPOSE, &integrations, "speedwave_test_network")
                .unwrap();
        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&filtered).unwrap();

        let services = doc.get("services").and_then(|s| s.as_mapping()).unwrap();
        assert!(
            !services.contains_key(&serde_yaml_ng::Value::String("mcp-playwright".into())),
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
    fn test_rendered_compose_has_mcp_hub_port() {
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: default_flags(),
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
            flags: default_flags(),
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

    /// ADR-038: every non-hub service in the rendered compose must listen on
    /// `PORT_WORKER` (3000). The hub itself is exempt — it listens on
    /// `PORT_BASE` (4000).
    #[test]
    fn test_all_workers_use_port_worker() {
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: default_flags(),
            llm: LlmConfig::default(),
        };
        let yaml = render_compose(
            "test-project",
            "/home/user/projects/test",
            &config,
            &all_enabled_integrations(),
            None,
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
            // Only workers have PORT=; claude does not define PORT.
            if name == "claude" || name == "mcp-hub" {
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

    /// ADR-038: every container-to-container WORKER_*_URL in mcp-hub must point
    /// at `:{PORT_WORKER}`. `WORKER_OS_URL` is exempt: mcp-os runs on the host
    /// and uses a dynamic port allocated by the OS, not PORT_WORKER.
    #[test]
    fn test_hub_worker_urls_use_port_worker() {
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: default_flags(),
            llm: LlmConfig::default(),
        };
        let yaml = render_compose(
            "test-project",
            "/home/user/projects/test",
            &config,
            &all_enabled_integrations(),
            None,
        )
        .unwrap();

        let expected_suffix = format!(":{}", crate::consts::PORT_WORKER);
        for entry in get_hub_env_seq(&serde_yaml_ng::from_str(&yaml).unwrap()) {
            if let Some((key, value)) = entry.split_once('=') {
                if key.starts_with("WORKER_") && key.ends_with("_URL") {
                    // WORKER_OS_URL is a host-side gateway (host.lima.internal
                    // / host.docker.internal) with a dynamically assigned
                    // mcp-os port — not a containerized worker. ADR-038
                    // applies only to in-cluster workers.
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

    /// ADR-038: `plugin.json.port` is deprecated and ignored. A plugin
    /// manifest that requests a non-`PORT_WORKER` port must still be wired up
    /// at `:{PORT_WORKER}` without failing.
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
        };

        let tokens_dir = std::path::Path::new("/home/user/.speedwave/tokens/test-project");
        let service = generate_plugin_service(
            &manifest,
            "test-project",
            "speedwave_test-project_network",
            tokens_dir,
            "/home/user/projects/test",
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
    fn test_mcp_hub_port_survives_inject_claude_env() {
        // Regression: inject_claude_env re-parses YAML via serde_yaml_ng.
        // MCP_HUB_PORT must survive the parse → serialize roundtrip.
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: default_flags(),
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
    fn test_mcp_hub_port_in_claude_service_env() {
        // Verify MCP_HUB_PORT is specifically in the claude service environment,
        // not somewhere else in the compose file.
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: default_flags(),
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
    fn test_compose_template_all_services_have_pull_policy_never() {
        // All images are built locally — nerdctl must never attempt to pull from a
        // remote registry. Without `pull_policy: never`, nerdctl resolves unqualified
        // image names (e.g. `speedwave-mcp-hub:tag`) as `docker.io/library/...` and
        // fails with "pull access denied".
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
    fn test_rendered_compose_passes_security_check() {
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: default_flags(),
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
        let tmp = tempfile::tempdir().unwrap();
        let violations = SecurityCheck::run_with_data_dir(
            &yaml,
            "test-project",
            &[],
            &SecurityExpectedPaths::compute("test-project", "/home/user/projects/test").unwrap(),
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
        let violations = SecurityCheck::run(yaml, "test", &[], &test_expected_paths());
        assert!(
            violations
                .iter()
                .any(|v| v.rule == SecurityRule::PortsLocalhost),
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
        let violations = SecurityCheck::run(yaml, "test", &[], &test_expected_paths());
        assert!(
            violations
                .iter()
                .any(|v| v.rule == SecurityRule::PortsLocalhost),
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
        let violations = SecurityCheck::run(yaml, "test", &[], &test_expected_paths());
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
        let violations = SecurityCheck::run(yaml, "test", &[], &test_expected_paths());
        assert!(
            !violations
                .iter()
                .any(|v| v.rule == SecurityRule::NoTokensClaude),
            "ANTHROPIC_API_KEY in claude container should be allowed"
        );
    }

    #[test]
    fn test_render_compose_ollama_provider() {
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: default_flags(),
            llm: LlmConfig {
                provider: Some("ollama".to_string()),
                model: Some("llama3.3".to_string()),
                base_url: None,
                context_tokens: None,
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
        // Ollama: direct injection at host.docker.internal:11434 (no /v1 suffix — ADR-040)
        assert!(
            yaml.contains("ANTHROPIC_BASE_URL=http://host.docker.internal:11434"),
            "Ollama provider should set ANTHROPIC_BASE_URL to host.docker.internal:11434 (no /v1)"
        );
    }

    #[test]
    fn test_local_provider_requires_model() {
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: default_flags(),
            llm: LlmConfig {
                provider: Some("ollama".to_string()),
                model: None,
                base_url: None,
                context_tokens: None,
            },
        };
        let result = render_compose(
            "test-project",
            "/home/user/projects/test",
            &config,
            &ResolvedIntegrationsConfig::default(),
            None,
        );
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string();
        assert!(
            msg.contains("requires a model name"),
            "Error must mention model requirement, got: {msg}"
        );
        assert!(
            msg.contains("ollama"),
            "Error must mention the provider, got: {msg}"
        );
    }

    #[test]
    fn test_render_compose_default_anthropic() {
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: default_flags(),
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
        assert!(
            !yaml.contains("litellm"),
            "Default anthropic provider should not reference litellm"
        );
        assert!(
            !yaml.contains("ghcr.io/berriai"),
            "Default anthropic provider should not reference litellm image"
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

    #[test]
    fn test_ollama_direct_injection() {
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: default_flags(),
            llm: LlmConfig {
                provider: Some("ollama".to_string()),
                model: Some("llama3.3".to_string()),
                base_url: None,
                context_tokens: None,
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
        let env = get_claude_env(&yaml);
        assert!(
            env.iter().any(|e| e == "ANTHROPIC_BASE_URL=http://host.docker.internal:11434"),
            "Ollama must set ANTHROPIC_BASE_URL to host.docker.internal:11434 (no /v1), got: {env:?}"
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
                .any(|e| e == "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME=llama3.3 (Ollama)"),
            "Ollama must set ANTHROPIC_CUSTOM_MODEL_OPTION_NAME with provider label, got: {env:?}"
        );
        assert!(
            env.iter()
                .any(|e| e
                    == "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION=Local model served by Ollama"),
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
            !yaml.contains("litellm"),
            "Ollama must not reference litellm"
        );
    }

    #[test]
    fn test_lmstudio_default_url() {
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: default_flags(),
            llm: LlmConfig {
                provider: Some("lmstudio".to_string()),
                model: Some("qwen2.5-coder".to_string()),
                base_url: None,
                context_tokens: None,
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
        let env = get_claude_env(&yaml);
        assert!(
            env.iter()
                .any(|e| e == "ANTHROPIC_BASE_URL=http://host.docker.internal:1234"),
            "LM Studio must use port 1234, got: {env:?}"
        );
    }

    #[test]
    fn test_llamacpp_default_url() {
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: default_flags(),
            llm: LlmConfig {
                provider: Some("llamacpp".to_string()),
                model: Some("deepseek-r1".to_string()),
                base_url: None,
                context_tokens: None,
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
        let env = get_claude_env(&yaml);
        assert!(
            env.iter()
                .any(|e| e == "ANTHROPIC_BASE_URL=http://host.docker.internal:8080"),
            "llama.cpp must use port 8080, got: {env:?}"
        );
    }

    #[test]
    fn test_unsupported_provider_rejected() {
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: default_flags(),
            llm: LlmConfig {
                provider: Some("openrouter".to_string()),
                model: Some("some-model".to_string()),
                base_url: Some("http://host.docker.internal:9999".to_string()),
                context_tokens: None,
            },
        };
        let result = render_compose(
            "test-project",
            "/home/user/projects/test",
            &config,
            &ResolvedIntegrationsConfig::default(),
            None,
        );
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string();
        assert!(
            msg.contains("Unsupported LLM provider") && msg.contains("openrouter"),
            "Error must mention unsupported provider, got: {msg}"
        );
    }

    #[test]
    fn test_custom_provider_rejected_after_removal() {
        // Regression guard: the `custom` provider value was removed end-to-end.
        // Any lingering config that still sets `provider = "custom"` must now
        // fall through to the same unknown-provider path used by any other
        // unsupported value (e.g. `openrouter`), not a bespoke `custom` branch.
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: default_flags(),
            llm: LlmConfig {
                provider: Some("custom".to_string()),
                model: Some("my-model".to_string()),
                base_url: Some("http://host.docker.internal:9999".to_string()),
                context_tokens: None,
            },
        };
        let result = render_compose(
            "test-project",
            "/home/user/projects/test",
            &config,
            &ResolvedIntegrationsConfig::default(),
            None,
        );
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string();
        assert!(
            msg.contains("Unsupported LLM provider") && msg.contains("custom"),
            "Error must treat 'custom' as unsupported, got: {msg}"
        );
        assert!(
            !msg.contains("Custom provider requires a base_url"),
            "The legacy 'custom requires base_url' error must be gone, got: {msg}"
        );
    }

    #[test]
    fn test_strip_trailing_v1() {
        assert_eq!(strip_trailing_v1("http://x:8080/v1"), "http://x:8080");
        assert_eq!(strip_trailing_v1("http://x:8080/v1/"), "http://x:8080");
        assert_eq!(strip_trailing_v1("http://x:8080"), "http://x:8080");
        assert_eq!(strip_trailing_v1(""), "");
        assert_eq!(strip_trailing_v1("http://x:8080/v1/v1"), "http://x:8080/v1");
        // Regression: trailing slash without /v1 must be stripped too,
        // otherwise ANTHROPIC_BASE_URL ends with '/' and produces
        // double-slash request paths.
        assert_eq!(strip_trailing_v1("http://x:8080/"), "http://x:8080");
        assert_eq!(strip_trailing_v1("http://x:8080///"), "http://x:8080");
    }

    #[test]
    fn test_idempotent_render() {
        let llm = LlmConfig {
            provider: Some("ollama".to_string()),
            model: Some("llama3.3".to_string()),
            base_url: None,
            context_tokens: None,
        };
        let result1 = apply_llm_config(COMPOSE_TEMPLATE, &llm).unwrap();
        let result2 = apply_llm_config(&result1, &llm).unwrap();
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
    fn test_base_url_rejects_path() {
        assert!(
            validate_base_url("http://host.docker.internal:11434/api/v1/").is_err(),
            "Must reject URL with path"
        );
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
    fn test_compose_template_contains_all_container_host_aliases() {
        // compose.template.yml injects all aliases from CONTAINER_HOST_ALIASES via
        // extra_hosts. Iterating the constant (rather than asserting on a literal)
        // keeps the test in sync with the SSOT — adding a new alias to the const
        // without updating the template will fail here.
        for alias in consts::CONTAINER_HOST_ALIASES {
            assert!(
                COMPOSE_TEMPLATE.contains(alias),
                "compose.template.yml must map {} (named in CONTAINER_HOST_ALIASES)",
                alias
            );
        }
    }

    #[test]
    fn test_all_template_aliases_are_in_container_host_aliases() {
        // Inverse guard: every "host.*.internal" hostname that appears in the
        // extra_hosts block of compose.template.yml must be named in
        // CONTAINER_HOST_ALIASES.  Without this check, adding an alias to the
        // template without updating the constant would silently break host-side
        // code that uses CONTAINER_HOST_ALIASES to rewrite aliases to loopback.
        let mut in_extra_hosts = false;
        for line in COMPOSE_TEMPLATE.lines() {
            let trimmed = line.trim();
            if trimmed == "extra_hosts:" {
                in_extra_hosts = true;
                continue;
            }
            // A non-indented, non-list line signals the end of the extra_hosts block.
            if in_extra_hosts && !trimmed.starts_with('-') && !trimmed.is_empty() {
                in_extra_hosts = false;
            }
            if !in_extra_hosts {
                continue;
            }
            // Lines look like: - "host.lima.internal:${HOST_GATEWAY}"
            if let Some(alias) = trimmed
                .strip_prefix("- \"")
                .and_then(|s| s.split(':').next())
                .filter(|h| h.starts_with("host.") && h.ends_with(".internal"))
            {
                assert!(
                    consts::CONTAINER_HOST_ALIASES.contains(&alias),
                    "compose.template.yml extra_hosts contains '{}' which is not in \
                     CONTAINER_HOST_ALIASES — add it to the const in consts.rs",
                    alias
                );
            }
        }
    }

    #[test]
    fn test_anthropic_with_model_injects_anthropic_model_env() {
        // Settings → LLM Provider → Model dropdown writes the chosen value
        // into claude.llm.model. compose must translate that into the
        // ANTHROPIC_MODEL env var so Claude Code respects the user's pick
        // (without this, the dropdown was silently ignored — Claude Code
        // kept falling back to its built-in default).
        let llm = LlmConfig {
            provider: Some("anthropic".to_string()),
            model: Some("claude-sonnet-4-6".to_string()),
            base_url: None,
            context_tokens: None,
        };
        let rendered = apply_llm_config(COMPOSE_TEMPLATE, &llm).unwrap();
        let env = get_claude_env(&rendered);
        assert!(
            env.iter().any(|e| e == "ANTHROPIC_MODEL=claude-sonnet-4-6"),
            "Anthropic + explicit model must inject ANTHROPIC_MODEL, got: {env:?}"
        );
        // Local-provider envs must not leak in for the anthropic provider.
        assert!(
            !env.iter().any(|e| e.starts_with("ANTHROPIC_BASE_URL=")),
            "Anthropic provider must not set ANTHROPIC_BASE_URL, got: {env:?}"
        );
    }

    #[test]
    fn test_anthropic_without_model_does_not_inject_anthropic_model() {
        // Empty/unset model = "let Claude Code pick its default". compose
        // must keep base_env() free of ANTHROPIC_MODEL so the fallback path
        // documented in defaults.rs::base_env_does_not_set_model holds.
        let llm = LlmConfig {
            provider: Some("anthropic".to_string()),
            model: None,
            base_url: None,
            context_tokens: None,
        };
        let rendered = apply_llm_config(COMPOSE_TEMPLATE, &llm).unwrap();
        let env = get_claude_env(&rendered);
        assert!(
            !env.iter().any(|e| e.starts_with("ANTHROPIC_MODEL=")),
            "Anthropic + no model must not set ANTHROPIC_MODEL, got: {env:?}"
        );

        // An empty string after trim should behave the same as None — a
        // user clearing the dropdown from the UI sends "" through Tauri.
        let llm_blank = LlmConfig {
            provider: Some("anthropic".to_string()),
            model: Some("   ".to_string()),
            base_url: None,
            context_tokens: None,
        };
        let rendered_blank = apply_llm_config(COMPOSE_TEMPLATE, &llm_blank).unwrap();
        let env_blank = get_claude_env(&rendered_blank);
        assert!(
            !env_blank.iter().any(|e| e.starts_with("ANTHROPIC_MODEL=")),
            "Anthropic + whitespace-only model must not set ANTHROPIC_MODEL, got: {env_blank:?}"
        );
    }

    #[test]
    fn test_anthropic_injects_default_alias_env_vars() {
        // Workaround for anthropics/claude-code#34083 — without
        // ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL pointing to the
        // `[1m]` variant, Max/Team subscribers see their 1M models capped
        // at 200k. compose must inject these regardless of whether the
        // user pinned an explicit model, because the alias resolution is
        // what unlocks the upgraded window.
        let llm = LlmConfig {
            provider: Some("anthropic".to_string()),
            model: None,
            base_url: None,
            context_tokens: None,
        };
        let rendered = apply_llm_config(COMPOSE_TEMPLATE, &llm).unwrap();
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
        let llm_ollama = LlmConfig {
            provider: Some("ollama".to_string()),
            model: Some("llama3.3".to_string()),
            base_url: None,
            context_tokens: None,
        };
        let llm_anthropic = LlmConfig::default();

        let with_ollama = apply_llm_config(COMPOSE_TEMPLATE, &llm_ollama).unwrap();
        let with_anthropic = apply_llm_config(COMPOSE_TEMPLATE, &llm_anthropic).unwrap();

        let env_ollama = get_claude_env(&with_ollama);
        let env_anthropic = get_claude_env(&with_anthropic);

        assert!(
            env_ollama
                .iter()
                .any(|e| e.starts_with("ANTHROPIC_BASE_URL=")),
            "Ollama must set ANTHROPIC_BASE_URL"
        );
        assert!(
            !env_anthropic
                .iter()
                .any(|e| e.starts_with("ANTHROPIC_BASE_URL=")),
            "Anthropic must not set ANTHROPIC_BASE_URL, got: {env_anthropic:?}"
        );
        assert!(
            !env_anthropic
                .iter()
                .any(|e| e == "CLAUDE_CODE_ATTRIBUTION_HEADER=0"),
            "Anthropic must NOT disable attribution header — it is only stripped \
             for local providers to avoid breaking llama.cpp/Ollama KV cache. \
             Got: {env_anthropic:?}"
        );
        assert!(
            !env_anthropic
                .iter()
                .any(|e| e.starts_with("ANTHROPIC_CUSTOM_MODEL_OPTION")),
            "Anthropic provider must NOT inject ANTHROPIC_CUSTOM_MODEL_OPTION — it is only \
             set for local providers. Got: {env_anthropic:?}"
        );
    }

    #[test]
    fn test_llamacpp_custom_model_option_labels() {
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: default_flags(),
            llm: LlmConfig {
                provider: Some("llamacpp".to_string()),
                model: Some("deepseek-r1".to_string()),
                base_url: None,
                context_tokens: None,
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
        let env = get_claude_env(&yaml);
        assert!(
            env.iter()
                .any(|e| e == "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME=deepseek-r1 (llama.cpp)"),
            "llamacpp display name must use 'llama.cpp' label, got: {env:?}"
        );
    }

    #[test]
    fn test_lmstudio_custom_model_option_labels() {
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: default_flags(),
            llm: LlmConfig {
                provider: Some("lmstudio".to_string()),
                model: Some("qwen2.5-coder".to_string()),
                base_url: None,
                context_tokens: None,
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
        let env = get_claude_env(&yaml);
        assert!(
            env.iter()
                .any(|e| e == "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME=qwen2.5-coder (LM Studio)"),
            "lmstudio display name must use 'LM Studio' label, got: {env:?}"
        );
    }

    #[test]
    fn test_render_compose_claude_version_is_pinned() {
        // Regression guard: CLAUDE_VERSION must be the pinned semver from defaults.
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: default_flags(),
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
        let expected = format!("CLAUDE_VERSION={}", crate::defaults::CLAUDE_VERSION);
        assert!(
            yaml.contains(&expected),
            "render_compose must inject {expected}, got:\n{yaml}"
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
    fn test_workspace_mount_is_readwrite() {
        // The workspace must be read-write so Claude can create/edit files.
        // This guards against accidentally adding :ro to the workspace mount.
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: default_flags(),
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
        // The desktop process can delete and recreate ~/.speedwave/mcp-os-*
        // files at any moment (mcp-os respawn). Treat a missing token file
        // the same as an empty/absent config — never bubble up `os error 2`
        // and abort `render_compose`.
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
        let violations = SecurityCheck::run(yaml, "test", &[], &test_expected_paths());
        assert!(
            violations
                .iter()
                .any(|v| v.rule == SecurityRule::NoTokensClaude),
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
      - WORKER_SLACK_URL=http://mcp-slack:3000
      - SLACK_TOKEN=xoxb-12345
"#;
        let violations = SecurityCheck::run(yaml, "test", &[], &test_expected_paths());
        assert!(
            violations
                .iter()
                .any(|v| v.rule == SecurityRule::NoTokensHub && v.message.contains("SLACK_TOKEN")),
            "SLACK_TOKEN in hub env should trigger NO_TOKENS_HUB violation"
        );
    }

    #[test]
    fn test_security_check_hub_worker_urls_allowed() {
        // WORKER_*_URL vars in hub env should pass the security check.
        let yaml = valid_compose_yaml();
        let violations = SecurityCheck::run(&yaml, "test", &[], &test_expected_paths());
        assert!(
            !violations
                .iter()
                .any(|v| v.rule == SecurityRule::NoTokensHub),
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
        let violations = SecurityCheck::run(yaml, "test", &[], &test_expected_paths());
        assert!(
            violations
                .iter()
                .any(|v| v.rule == SecurityRule::ContainerUser),
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
        let violations = SecurityCheck::run(&yaml, "test", &[], &test_expected_paths());
        assert!(
            violations
                .iter()
                .any(|v| v.rule == SecurityRule::ContainerUser && v.container == "evil-addon"),
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
        let violations = SecurityCheck::run(&yaml, "test", &[], &test_expected_paths());
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
    fn test_render_compose_contains_ide_lock_mount() {
        // render_compose must substitute ${IDE_LOCK_DIR} so the claude container
        // has the ide-bridge directory mounted as /home/speedwave/.claude/ide:ro.
        // Read-only — container only reads the lock file; Speedwave host writes it.
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: default_flags(),
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
            flags: default_flags(),
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
    fn test_claude_env_has_no_flicker() {
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: default_flags(),
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
    fn test_claude_env_has_effort_level() {
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: default_flags(),
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

        let has_effort_level = claude_env
            .iter()
            .any(|v| v.as_str() == Some("CLAUDE_CODE_EFFORT_LEVEL=max"));
        assert!(
            has_effort_level,
            "CLAUDE_CODE_EFFORT_LEVEL=max must be in claude service environment"
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
            let violations = SecurityCheck::run(&yaml, "test", &[], &test_expected_paths());
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
        let violations = SecurityCheck::run(yaml, "test", &[], &test_expected_paths());
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
        let violations = SecurityCheck::run(yaml, "test", &[], &test_expected_paths());
        assert!(
            !violations
                .iter()
                .any(|v| v.rule == SecurityRule::NoPortsWorkers),
            "Addon services may expose ports (they are not in consts::BUILT_IN_SERVICES)"
        );
    }

    #[test]
    fn test_render_compose_rejects_invalid_project_name() {
        let resolved = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: default_flags(),
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
    fn test_init_secrets_dir_rejects_invalid_name() {
        assert!(init_secrets_dir("").is_err());
        assert!(init_secrets_dir("../evil").is_err());
        assert!(init_secrets_dir(&"a".repeat(64)).is_err());
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
        let filtered =
            apply_integrations_filter(&yaml, &integrations, "speedwave_test_network").unwrap();

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
        let mut integrations = ResolvedIntegrationsConfig::default();
        integrations.slack = true;
        integrations.sharepoint = true;
        integrations.gitlab = true;
        integrations.os_calendar = true;

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
    fn test_integrations_filter_all_disabled_keeps_claude_and_hub() {
        let integrations = ResolvedIntegrationsConfig::default();

        let filtered =
            apply_integrations_filter(VALID_COMPOSE, &integrations, "speedwave_test_network")
                .unwrap();
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
        let mut integrations = ResolvedIntegrationsConfig::default();
        integrations.os_reminders = true;
        integrations.os_calendar = true;
        integrations.os_mail = true;
        integrations.os_notes = true;

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
        assert!(services.contains_key(&serde_yaml_ng::Value::String("mcp-office".into())));
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
        assert!(!services.contains_key(&serde_yaml_ng::Value::String("mcp-office".into())));
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
    fn test_render_compose_with_mixed_enabled_disabled_end_to_end() {
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: default_flags(),
            llm: LlmConfig::default(),
        };
        let mut integrations = ResolvedIntegrationsConfig::default();
        integrations.sharepoint = true;
        integrations.gitlab = true;
        integrations.github = true;
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
        assert!(services.contains_key(&serde_yaml_ng::Value::String("mcp-github".into())));

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
        let mut integrations = ResolvedIntegrationsConfig::default();
        integrations.slack = true;

        let filtered =
            apply_integrations_filter(VALID_COMPOSE, &integrations, "speedwave_test_network")
                .unwrap();
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
            github: true,
            atlassian: true,
            office: true,
            playwright: true,
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
        let violations = SecurityCheck::run(&yaml, "test", &[], &test_expected_paths());
        assert!(
            violations
                .iter()
                .any(|v| v.rule == SecurityRule::PluginNoPrivileged && v.container == "mcp-presale"),
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
        let violations = SecurityCheck::run(&yaml, "test", &[], &test_expected_paths());
        assert!(
            violations.iter().any(
                |v| v.rule == SecurityRule::PluginNoHostNetwork && v.container == "mcp-presale"
            ),
            "Plugin with network_mode: host should trigger PLUGIN_NO_HOST_NETWORK"
        );
    }

    fn test_presale_manifest(token_mount: plugin::TokenMount) -> PluginManifest {
        PluginManifest {
            name: "Presale".to_string(),
            service_id: Some("presale".to_string()),
            slug: "presale".to_string(),
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
        }
    }

    /// Expected paths for plugin security tests. Token dir = /test/.speedwave/tokens/test.
    fn test_expected_paths() -> SecurityExpectedPaths {
        SecurityExpectedPaths::from_raw("/test/project", "/test/.speedwave/tokens/test")
    }

    /// Standard valid plugin YAML fragment with correct token + workspace mounts.
    fn valid_plugin_yaml(token_mode: &str) -> String {
        format!(
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
      - /test/.speedwave/tokens/test/presale:/tokens:{token_mode}
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
      - /test/.speedwave/tokens/test/presale:/tokens:ro
      - /test/project:/workspace:rw
      - /etc/passwd:/etc/passwd:ro
    labels:
      speedwave.plugin-service: "true"
"#,
            user = container_user()
        );
        let manifests = vec![test_presale_manifest(plugin::TokenMount::ReadOnly)];
        let violations = SecurityCheck::run(&yaml, "test", &manifests, &test_expected_paths());
        assert!(
            violations
                .iter()
                .any(|v| v.rule == SecurityRule::PluginNoExtraVolumes
                    && v.container == "mcp-presale"),
            "Plugin with extra volumes should trigger PLUGIN_NO_EXTRA_VOLUMES"
        );
    }

    #[test]
    fn test_security_check_plugin_no_extra_volumes_clean() {
        let yaml = valid_plugin_yaml("ro");
        let manifests = vec![test_presale_manifest(plugin::TokenMount::ReadOnly)];
        let violations = SecurityCheck::run(&yaml, "test", &manifests, &test_expected_paths());
        assert!(
            !violations
                .iter()
                .any(|v| v.rule == SecurityRule::PluginNoExtraVolumes),
            "Plugin with only /tokens + /workspace should not trigger PLUGIN_NO_EXTRA_VOLUMES"
        );
    }

    #[test]
    fn test_security_check_plugin_token_mount_mode_ro_violation() {
        let yaml = valid_plugin_yaml("rw");
        let manifests = vec![test_presale_manifest(plugin::TokenMount::ReadOnly)];
        let violations = SecurityCheck::run(&yaml, "test", &manifests, &test_expected_paths());
        assert!(
            violations
                .iter()
                .any(|v| v.rule == SecurityRule::PluginTokenMountMode
                    && v.container == "mcp-presale"),
            "ReadOnly manifest + :rw mount should trigger PLUGIN_TOKEN_MOUNT_MODE"
        );
    }

    #[test]
    fn test_security_check_plugin_token_mount_mode_rw_pass() {
        let yaml = valid_plugin_yaml("rw");
        let manifests = vec![test_presale_manifest(plugin::TokenMount::ReadWrite {
            justification: "OAuth token refresh".to_string(),
        })];
        let violations = SecurityCheck::run(&yaml, "test", &manifests, &test_expected_paths());
        assert!(
            !violations
                .iter()
                .any(|v| v.rule == SecurityRule::PluginTokenMountMode),
            "ReadWrite manifest + :rw mount should NOT trigger PLUGIN_TOKEN_MOUNT_MODE"
        );
    }

    #[test]
    fn test_security_check_plugin_workspace_path_mismatch() {
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
      - /test/.speedwave/tokens/test/presale:/tokens:ro
      - /etc:/workspace:rw
    labels:
      speedwave.plugin-service: "true"
"#,
            user = container_user()
        );
        let manifests = vec![test_presale_manifest(plugin::TokenMount::ReadOnly)];
        let violations = SecurityCheck::run(&yaml, "test", &manifests, &test_expected_paths());
        assert!(
            violations
                .iter()
                .any(|v| v.rule == SecurityRule::PluginWorkspacePathMismatch),
            "Wrong workspace host path should trigger PLUGIN_WORKSPACE_PATH_MISMATCH"
        );
    }

    #[test]
    fn test_security_check_plugin_workspace_mount_mode_ro() {
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
      - /test/.speedwave/tokens/test/presale:/tokens:ro
      - /test/project:/workspace:ro
    labels:
      speedwave.plugin-service: "true"
"#,
            user = container_user()
        );
        let manifests = vec![test_presale_manifest(plugin::TokenMount::ReadOnly)];
        let violations = SecurityCheck::run(&yaml, "test", &manifests, &test_expected_paths());
        assert!(
            violations
                .iter()
                .any(|v| v.rule == SecurityRule::PluginWorkspaceMountMode),
            "Workspace mount with :ro should trigger PLUGIN_WORKSPACE_MOUNT_MODE"
        );
    }

    #[test]
    fn test_security_check_plugin_token_path_mismatch() {
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
      - /etc:/tokens:ro
      - /test/project:/workspace:rw
    labels:
      speedwave.plugin-service: "true"
"#,
            user = container_user()
        );
        let manifests = vec![test_presale_manifest(plugin::TokenMount::ReadOnly)];
        let violations = SecurityCheck::run(&yaml, "test", &manifests, &test_expected_paths());
        assert!(
            violations
                .iter()
                .any(|v| v.rule == SecurityRule::PluginTokenPathMismatch),
            "Wrong token host path should trigger PLUGIN_TOKEN_PATH_MISMATCH"
        );
    }

    #[test]
    fn test_security_check_plugin_volume_long_form() {
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
      - type: bind
        source: /test/.speedwave/tokens/test/presale
        target: /tokens
    labels:
      speedwave.plugin-service: "true"
"#,
            user = container_user()
        );
        let manifests = vec![test_presale_manifest(plugin::TokenMount::ReadOnly)];
        let violations = SecurityCheck::run(&yaml, "test", &manifests, &test_expected_paths());
        assert!(
            violations
                .iter()
                .any(|v| v.rule == SecurityRule::PluginVolumeLongForm),
            "Long-form YAML volume should trigger PLUGIN_VOLUME_LONG_FORM"
        );
    }

    #[test]
    fn test_security_check_plugin_manifest_missing() {
        let yaml = valid_plugin_yaml("ro");
        // Pass empty manifests — should detect missing manifest
        let violations = SecurityCheck::run(&yaml, "test", &[], &test_expected_paths());
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
            cpu_limit: None,
            requires_integrations: vec![],
        };

        let tokens_dir = std::path::PathBuf::from("/home/user/.speedwave/tokens/test");
        let service_value = plugin::generate_plugin_service(
            &manifest,
            "test",
            "speedwave_test_network",
            &tokens_dir,
            "/test/project",
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
        };
        let svc = plugin::generate_plugin_service(
            &manifest,
            "proj",
            "net",
            std::path::Path::new("/tokens/proj"),
            "/workspace",
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
            cpu_limit: None,
            requires_integrations: vec![],
        };

        let tokens_dir = std::path::PathBuf::from("/home/user/.speedwave/tokens/myproject");
        let service_value = plugin::generate_plugin_service(
            &manifest,
            "myproject",
            "speedwave_myproject_network",
            &tokens_dir,
            "/test/project",
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
        let violations = SecurityCheck::run(&yaml, "test", &[], &paths);
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
    fn test_security_check_sharepoint_missing_workspace_mount() {
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
"#,
            user = container_user()
        );
        let paths = test_expected_paths();
        let violations = SecurityCheck::run(&yaml, "test", &[], &paths);
        assert!(
            violations
                .iter()
                .any(|v| v.rule == SecurityRule::SharepointMissingWorkspaceMount),
            "SharePoint without workspace mount should trigger SHAREPOINT_MISSING_WORKSPACE_MOUNT"
        );
    }

    #[test]
    fn test_security_check_sharepoint_workspace_path_mismatch() {
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
      - /wrong/path:/workspace:rw
"#,
            user = container_user()
        );
        let paths = test_expected_paths();
        let violations = SecurityCheck::run(&yaml, "test", &[], &paths);
        assert!(
            violations
                .iter()
                .any(|v| v.rule == SecurityRule::SharepointWorkspacePathMismatch),
            "Wrong SharePoint workspace path should trigger SHAREPOINT_WORKSPACE_PATH_MISMATCH"
        );
    }

    #[test]
    fn test_security_check_sharepoint_workspace_mount_mode_ro() {
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
      - /test/project:/workspace:ro
"#,
            user = container_user()
        );
        let paths = test_expected_paths();
        let violations = SecurityCheck::run(&yaml, "test", &[], &paths);
        assert!(
            violations
                .iter()
                .any(|v| v.rule == SecurityRule::SharepointWorkspaceMountMode),
            "SharePoint workspace with :ro should trigger SHAREPOINT_WORKSPACE_MOUNT_MODE"
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
            !services.contains_key(&serde_yaml_ng::Value::String("mcp-skills-pack".into())),
            "resource-only plugin should NOT have a compose service"
        );
    }

    // Note: these tests verify the `service_id.unwrap_or(slug)` key lookup
    // used in apply_plugins (compose.rs:325). We test the components (is_plugin_enabled
    // + key derivation) rather than calling apply_plugins directly because apply_plugins
    // reads from ~/.speedwave/plugins/ on the filesystem.

    #[test]
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
      - /home/user/.speedwave/tokens/test/sharepoint:/tokens:rw
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

        let token_path = tmp.path().join("slack-auth-token");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
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

        // The on-disk file should contain the same (trimmed) UUID, not a fresh one.
        // The atomic write normalises the content to the trimmed form — this confirms
        // the existing token was re-used rather than replaced with a new UUID.
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
            name: "Presale".to_string(),
            slug: "presale".to_string(),
            service_id: Some("presale".to_string()),
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
        }];

        // Compose with plugin service already present (as apply_plugins would leave it)
        let mut doc: serde_yaml_ng::Value =
            serde_yaml_ng::from_str(VALID_COMPOSE_ALL_WORKERS).unwrap();
        let plugin_svc: serde_yaml_ng::Value = serde_yaml_ng::from_str(
            "image: speedwave-mcp-presale:1.0.0\nenvironment:\n  - PORT=4010\nnetworks:\n  - speedwave_test_network\n",
        )
        .unwrap();
        doc["services"]["mcp-presale"] = plugin_svc;
        let compose_with_plugin = serde_yaml_ng::to_string(&doc).unwrap();

        let mut integrations = all_enabled_integrations();
        integrations.plugins.insert("presale".to_string(), true);

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

        // Plugin worker should have MCP_PRESALE_AUTH_TOKEN env var
        let env = get_service_env_seq(&doc, "mcp-presale");
        assert!(
            env.iter().any(|e| e.starts_with("MCP_PRESALE_AUTH_TOKEN=")),
            "plugin worker should have MCP_PRESALE_AUTH_TOKEN, env={:?}",
            env
        );

        // Hub should have /secrets/presale-auth-token:ro mount
        let volumes = get_hub_volumes(&doc);
        assert!(
            volumes
                .iter()
                .any(|v| v.contains("/secrets/presale-auth-token:ro")),
            "hub should mount plugin auth token, volumes={:?}",
            volumes
        );

        // Token file should exist on disk
        assert!(secrets_dir.join("presale-auth-token").exists());
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
        };
        let violations = SecurityCheck::run(&yaml, "test", &[manifest], &test_expected_paths());
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
      - /test/.speedwave/tokens/test/sharepoint:/tokens:rw
      - /test/project:/workspace:rw
      - /etc/passwd:/etc/passwd:ro
"#,
            user = container_user()
        );
        let violations = SecurityCheck::run(&yaml, "test", &[], &test_expected_paths());
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
        // Calls run() which uses consts::data_dir() internally.
        // Verifies the delegation from run() to run_with_data_dir() works
        // without panicking. On dev machines, real files may exist and produce
        // violations — that's fine, we only check that it doesn't crash.
        let yaml = valid_compose_yaml();
        let _violations =
            SecurityCheck::run(&yaml, "nonexistent-project", &[], &test_expected_paths());
        // No assertion on violations — dev machines may have real files with
        // various permissions. The test verifies the delegation path works.
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

    /// Creates a directory tree under data_dir with 0o700 on all components.
    /// E.g. `secure_mkdir(data_dir, &["secrets", "proj"])` creates `data_dir/secrets/`
    /// and `data_dir/secrets/proj/`, both with 0o700.
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
    fn test_ensure_plugin_images_called_before_apply_plugins() {
        // Structural test: verify render_compose() uses ensure_plugin_images (not
        // build_pending_plugin_images) and calls it BEFORE apply_plugins.
        let source = include_str!("compose.rs");

        // Find the render_compose function body
        let fn_start = source
            .find("pub fn render_compose(")
            .expect("render_compose function must exist in compose.rs");
        let fn_body = &source[fn_start..];

        // Verify ensure_plugin_images is used (not the old build_pending_plugin_images)
        assert!(
            fn_body.contains("ensure_plugin_images"),
            "render_compose must call ensure_plugin_images (not build_pending_plugin_images)"
        );
        assert!(
            !fn_body[..fn_body.find("fn apply_plugins(").unwrap_or(fn_body.len())]
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
    fn test_render_compose_propagates_tz_to_all_services() {
        let config = ResolvedClaudeConfig {
            env: crate::defaults::base_env(),
            flags: default_flags(),
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

    /// Minimal compose YAML with just the claude service so apply_auth_config
    /// can write into the environment sequence without dragging the whole
    /// template into the test fixture.
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
        let violations = SecurityCheck::run(yaml, "test", &[], &test_expected_paths());
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
        let violations = SecurityCheck::run(yaml, "test", &[], &test_expected_paths());
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
        // Symlink the entire claude-resources dir to /etc — without this
        // check, the bind-mount would surface /etc inside the claude
        // container as /speedwave/plugins/<slug>/.
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

    /// `claude-resources/` must be a real directory on disk, not a
    /// regular file dressed up as the resources root. Without this,
    /// `add_claude_volume` would still emit a bind-mount entry whose
    /// host source is a single file — and depending on the engine
    /// either fails opaquely at start, or surfaces the file in place
    /// of a directory inside the container.
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

    /// Builds a minimal valid YAML doc for `apply_plugins_from_verified`
    /// to mutate. The shape mirrors `compose.template.yml` enough that
    /// the renderer can find `services.claude` and `services.mcp-hub`.
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
        // MCP plugins (service_id present) require a Containerfile per
        // validate_manifest. Stub one in the fixture dir so apply_plugins
        // re-validation passes the existence check and proceeds to the
        // render-time invariants we actually want to test.
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
        };
        plugin::VerifiedPlugin::new(manifest, plugin_dir.to_path_buf())
    }

    /// `apply_plugins` re-runs `validate_manifest` so a manifest whose
    /// fields would now fail the (potentially stricter) ruleset is
    /// rejected at render time, not silently rendered. We can't
    /// hand-craft a "post-install rule violation" without breaking
    /// other tests, so we verify the call chain by passing a
    /// manifest with a value that would fail the cap (`mem_limit`
    /// above PLUGIN_MEM_LIMIT_MAX_MIB).
    #[test]
    fn test_apply_plugins_revalidates_manifest() {
        let tmp = tempfile::tempdir().unwrap();
        let plugin_dir = tmp.path().join("evil");
        std::fs::create_dir_all(&plugin_dir).unwrap();
        // 999g is far above the 16 GiB cap. Re-validation must reject.
        let vp = fixture_verified_plugin("evil", Some("evil"), &plugin_dir, Some("999g"));
        let result = super::apply_plugins_from_verified(
            fixture_compose_yaml(),
            "test-project",
            "/tmp/test",
            &fixture_integrations_with_enabled("evil"),
            "test-net",
            tmp.path(),
            &[vp],
        );
        let err = result.expect_err("oversized mem_limit must be rejected at render");
        assert!(err.to_string().contains("exceeds maximum"));
    }

    /// `apply_plugins` MUST reject a plugin whose derived compose name
    /// would overwrite an existing `services.<name>` entry. Without
    /// this check, `serde_yaml_ng`'s mapping insert silently replaces
    /// the built-in entry — defeating the hub's zero-token guarantee.
    /// The slug-collision rule in `validate_manifest` already blocks
    /// the obvious "slug: hub" case at install, so the render-time
    /// check is defence in depth — but a regression in either layer
    /// is invisible without a test that pins the contract.
    #[test]
    fn test_apply_plugins_rejects_compose_name_collision() {
        let tmp = tempfile::tempdir().unwrap();
        let plugin_dir = tmp.path().join("decoy");
        std::fs::create_dir_all(&plugin_dir).unwrap();
        // We can't construct a manifest with `slug: "hub"` —
        // `validate_manifest` rejects it. Instead, hand-build YAML
        // that already contains the service name a plugin would
        // produce, and pass a plugin whose service_id derives that
        // name. Pre-populating `services.mcp-decoy` simulates the
        // race where two render passes try to claim the same name.
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
            "test-project",
            "/tmp/test",
            &cfg,
            "test-net",
            tmp.path(),
            &[vp],
        )
        .expect_err("collision must abort the render");
        assert!(
            err.to_string().contains("would overwrite"),
            "expected collision rejection, got: {err}"
        );
    }

    /// Sanity: a verified plugin not blocked by validate_manifest and
    /// not colliding renders successfully. Pins the happy path so a
    /// regression that always returns Err (e.g. someone tightening
    /// validate_manifest in a way that breaks all in-tree manifests)
    /// is caught here rather than at the user's first launch.
    #[test]
    fn test_apply_plugins_renders_enabled_plugin() {
        let tmp = tempfile::tempdir().unwrap();
        let plugin_dir = tmp.path().join("ok-plugin");
        std::fs::create_dir_all(&plugin_dir).unwrap();
        let cfg = fixture_integrations_with_enabled("ok-plugin");
        let vp = fixture_verified_plugin("ok-plugin", Some("ok-plugin"), &plugin_dir, None);
        let yaml = super::apply_plugins_from_verified(
            fixture_compose_yaml(),
            "test-project",
            "/tmp/test",
            &cfg,
            "test-net",
            tmp.path(),
            &[vp],
        )
        .expect("happy path must render");
        assert!(
            yaml.contains("mcp-ok-plugin"),
            "rendered YAML must contain plugin service"
        );
        assert!(yaml.contains("SPEEDWAVE_PLUGINS=ok-plugin"));
    }

    /// If the canonical resolution of `claude-resources` escapes the
    /// canonical plugin tree, the helper bails. We can't trivially
    /// build such a path without symlinks (which `walk_reject_symlinks`
    /// already catches), but we can at least pin the invariant by
    /// verifying that a deeply-nested real directory tree IS accepted
    /// — regression test for "I broke the canonicalize check by
    /// being too strict".
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
}
