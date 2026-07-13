//! Plugin compose injection: generates MCP service definitions for enabled plugins, wires
//! `WORKER_<PLUGIN>_URL` into the hub, mounts claude-resources, injects host-bridge vars (ADR-063).

use super::{
    add_claude_env_var, add_claude_volume, add_service_env_var, ensure_host_gateway_extra_host,
    ensure_resources_dir_safe, inject_worker_env, HostBridgesInfo,
};
use crate::config::ResolvedIntegrationsConfig;
use crate::consts;
use crate::engine_path::to_engine_path;
use crate::plugin;

/// Applies installed+enabled plugins to compose YAML: generates MCP services, injects WORKER_*_URL,
/// mounts resources, sets SPEEDWAVE_PLUGINS. Manifests are re-validated at render time (ADR-051).
pub(crate) fn apply_plugins(yaml: &str, ctx: &ApplyPluginsCtx<'_>) -> anyhow::Result<String> {
    let plugins = plugin::list_verified_plugins()?;
    apply_plugins_from_verified(yaml, ctx, &plugins)
}

/// Per-call inputs shared by `apply_plugins` and `apply_plugins_from_verified`. Bundled together
/// so each new plugin-injection knob lives in one struct instead of growing the function signature.
pub(crate) struct ApplyPluginsCtx<'a> {
    pub project_name: &'a str,
    pub project_dir: &'a str,
    pub integrations: &'a ResolvedIntegrationsConfig,
    pub network_name: &'a str,
    pub tokens_dir: &'a std::path::Path,
    pub bridges: &'a HostBridgesInfo,
}

/// Test-friendly variant of [`apply_plugins`] accepting pre-verified plugins
/// instead of consulting disk. Production goes through `apply_plugins`.
pub(crate) fn apply_plugins_from_verified(
    yaml: &str,
    ctx: &ApplyPluginsCtx<'_>,
    plugins: &[plugin::VerifiedPlugin],
) -> anyhow::Result<String> {
    let ApplyPluginsCtx {
        project_name,
        project_dir,
        integrations,
        network_name,
        tokens_dir,
        bridges,
    } = *ctx;
    if plugins.is_empty() {
        return Ok(yaml.to_string());
    }

    let mut doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(yaml)?;
    let mut plugin_slugs: Vec<String> = Vec::new();

    for vp in plugins {
        let manifest = vp.manifest();
        let plugin_dir = vp.dir();
        let slug = &manifest.slug;
        let service_id = manifest.service_id.as_deref();

        plugin::validate_manifest(manifest, plugin_dir)?;

        // Check if plugin is enabled (by service_id for MCP plugins, by slug otherwise)
        let plugin_key = service_id.unwrap_or(slug);
        if !integrations.is_plugin_enabled(plugin_key) {
            continue;
        }

        plugin_slugs.push(format!(
            "{slug}:{}",
            &vp.tree_digest_hex()[..16.min(vp.tree_digest_hex().len())]
        ));

        // MCP service generation (follows apply_llm_config pattern)
        if let Some(sid) = service_id {
            let service_value = plugin::generate_plugin_service(
                manifest,
                vp.tree_digest_hex(),
                plugin_dir,
                project_name,
                network_name,
                tokens_dir,
                project_dir,
            )?;
            // Refuse to overwrite a built-in service (validate_manifest gates the obvious cases at install).
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
            // Inject WORKER_*_URL into hub; all workers share PORT_WORKER (ADR-038).
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

            // Inject host-bridge env vars when Desktop registered one for this slug (ADR-063).
            if manifest.host_bridge.is_some() {
                if let Some(registration) = bridges.bridges.iter().find(|r| r.plugin_slug == *slug)
                {
                    let compose_name = plugin::derive_compose_name(sid);
                    // Under WSL2 mirrored networking the container reaches the bridge
                    // through the guest relay port, not the loopback bind port (ADR-079).
                    let container_port = super::container_facing_port(registration.port);
                    let bridge_url =
                        format!("ws://{}:{}/", consts::HOST_GATEWAY_ALIAS, container_port);
                    add_service_env_var(
                        &mut doc,
                        &compose_name,
                        &registration.url_env,
                        &bridge_url,
                    )?;
                    add_service_env_var(
                        &mut doc,
                        &compose_name,
                        &registration.token_env,
                        &registration.auth_token,
                    )?;
                    ensure_host_gateway_extra_host(&mut doc, &compose_name)?;
                }
            }
        }

        // Validate claude-resources is a real dir, not a symlink (ADR-051 security model).
        let plugin_resources = plugin_dir.join("claude-resources");
        if plugin_resources.exists() {
            ensure_resources_dir_safe(plugin_dir, &plugin_resources)
                .map_err(|e| anyhow::anyhow!("plugin '{slug}': claude-resources unsafe: {e}"))?;
            let mount = format!(
                "{}:/speedwave/plugins/{}:ro",
                to_engine_path(&plugin_resources)?,
                slug
            );
            add_claude_volume(&mut doc, &mount)?;
        }
    }

    // slug in SPEEDWAVE_PLUGINS; digest in separate var for config-hash recreation (plugin contract).
    if !plugin_slugs.is_empty() {
        let slugs: Vec<&str> = plugin_slugs
            .iter()
            .map(|s| s.split(':').next().unwrap_or(s))
            .collect();
        add_claude_env_var(&mut doc, "SPEEDWAVE_PLUGINS", &slugs.join(","));
        add_claude_env_var(&mut doc, "SPW_PLUGIN_DIGESTS", &plugin_slugs.join(","));
    }

    Ok(serde_yaml_ng::to_string(&doc)?)
}
