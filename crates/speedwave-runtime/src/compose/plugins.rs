//! Plugin compose injection: generates MCP service definitions for enabled
//! plugins, wires `WORKER_<PLUGIN>_URL` into the hub, mounts claude-resources,
//! and injects declared host-bridge env vars (ADR-063).

use super::{
    add_claude_env_var, add_claude_volume, add_service_env_var, ensure_host_gateway_extra_host,
    ensure_resources_dir_safe, inject_worker_env, HostBridgesInfo,
};
use crate::config::ResolvedIntegrationsConfig;
use crate::consts;
use crate::engine_path::to_engine_path;
use crate::plugin;

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
///
/// **Host-gateway note:** `ensure_host_gateway_extra_host` is intentionally NOT
/// called for plugin services. Plugin workers communicate with `mcp-hub` over
/// the internal compose network — they have no direct host-side dependency.
/// If a future plugin needs to reach the host, the helper must be called for
/// that plugin's compose service.
pub(crate) fn apply_plugins(yaml: &str, ctx: &ApplyPluginsCtx<'_>) -> anyhow::Result<String> {
    let plugins = plugin::list_verified_plugins()?;
    apply_plugins_from_verified(yaml, ctx, &plugins)
}

/// Per-call inputs shared by `apply_plugins` and `apply_plugins_from_verified`.
/// Bundled together so each new plugin-injection knob lives in one struct
/// instead of growing the function signature.
pub(crate) struct ApplyPluginsCtx<'a> {
    pub project_name: &'a str,
    pub project_dir: &'a str,
    pub integrations: &'a ResolvedIntegrationsConfig,
    pub network_name: &'a str,
    pub tokens_dir: &'a std::path::Path,
    pub bridges: &'a HostBridgesInfo,
}

/// Test-friendly variant of [`apply_plugins`] — accepts a pre-built
/// list of `VerifiedPlugin` instead of consulting the on-disk
/// `~/.speedwave/plugins/`. Production callers go through
/// `apply_plugins`; tests inject crafted scenarios (forged manifest,
/// dangling `claude-resources` symlink, slug collision) without
/// touching the user's real data dir.
// Internal helper exposed only for tests that need to inject crafted
// `VerifiedPlugin` fixtures; the public entrypoint is `apply_plugins`.
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

        plugin_slugs.push(format!(
            "{slug}:{}",
            &vp.tree_digest_hex()[..16.min(vp.tree_digest_hex().len())]
        ));

        // MCP service generation (follows apply_llm_config pattern)
        if let Some(sid) = service_id {
            let service_value = plugin::generate_plugin_service(
                manifest,
                vp.tree_digest_hex(),
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

            // Plugin's manifest may declare a host-side WebSocket bridge
            // (see ADR-063). When the Desktop has registered one for this
            // slug, inject the env vars the plugin asked for.
            if manifest.host_bridge.is_some() {
                if let Some(registration) = bridges.bridges.iter().find(|r| r.plugin_slug == *slug)
                {
                    let compose_name = plugin::derive_compose_name(sid);
                    let bridge_url =
                        format!("ws://{}:{}/", consts::HOST_GATEWAY_ALIAS, registration.port);
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

        // Mount claude-resources to claude container. The resources dir
        // must be a *real* directory inside the verified plugin tree —
        // a symlink (or anything that escapes the tree under canonicalize)
        // would let an attacker bind-mount /etc into the claude container.
        let plugin_resources = plugin_dir.join("claude-resources");
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

    // SPEEDWAVE_PLUGINS in claude: slug per enabled plugin; the digest goes
    // into a SEPARATE var so a plugin upgrade changes claude's config-hash
    // (recreate -> entrypoint relinks resources) without altering the slug
    // list the entrypoint iterates (plugin contract, CLAUDE.md).
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
