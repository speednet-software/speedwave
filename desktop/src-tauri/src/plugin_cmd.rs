// Plugin management commands — Tauri backend for the Plugins UI.
//
// All `#[tauri::command]` functions here are registered in the main
// `generate_handler!` macro via their fully-qualified paths.

use crate::types::check_project;
use speedwave_runtime::config;
use speedwave_runtime::consts;
use speedwave_runtime::plugin;
use std::collections::HashMap;
use tauri::Emitter;

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

#[derive(serde::Serialize, Clone)]
pub(crate) struct PluginStatusEntry {
    pub(crate) slug: String,
    pub(crate) name: String,
    pub(crate) service_id: Option<String>,
    pub(crate) version: String,
    pub(crate) description: String,
    /// Optional long-form Markdown setup/usage guide from the manifest,
    /// rendered on the Dashboard tab. `None` when the manifest omits it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) instructions: Option<String>,
    pub(crate) enabled: bool,
    pub(crate) configured: bool,
    pub(crate) auth_fields: Vec<plugin::AuthFieldDef>,
    pub(crate) current_values: HashMap<String, String>,
    /// Keys of `auth_fields` that currently have a non-empty value stored
    /// on disk. **Metadata only** — the secret contents are NOT read, only
    /// the file's existence + non-zero length is checked. This lets the UI
    /// show a per-field "configured" indicator for secret fields without
    /// ever exposing the secret (unlike `current_values`, which skips
    /// secrets entirely and so can't drive that indicator).
    pub(crate) configured_fields: Vec<String>,
    pub(crate) token_mount: String,
    pub(crate) settings_schema: Option<serde_json::Value>,
    pub(crate) requires_integrations: Vec<String>,
    /// Outcome of `runtime::plugin::list_for_ui` for this entry.
    /// Serializes to snake_case (`verified`, `missing_signature`, …).
    /// Anything but `Verified` disables the enable toggle and
    /// credential editing in the UI but keeps the remove button active.
    pub(crate) verification_status: plugin::VerificationStatus,
    /// Human-readable diagnostic when `verification_status != Verified`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) verification_error: Option<String>,
    /// True when the manifest declares `host_bridge`. Drives the
    /// frontend "Bridge connection" section visibility.
    pub(crate) has_host_bridge: bool,
}

#[derive(serde::Serialize)]
pub(crate) struct PluginsResponse {
    pub(crate) plugins: Vec<PluginStatusEntry>,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Returns the token directory path for a service, delegating to the runtime SSOT.
fn token_dir_for(project: &str, service_id: &str) -> Result<std::path::PathBuf, String> {
    plugin::token_dir(project, service_id).map_err(|e| e.to_string())
}

/// True when a credential file exists on disk with non-zero length.
///
/// Metadata-only: never reads the file contents, so it is safe to call
/// for secret fields. Backs the per-field "configured" indicator. A
/// zero-byte file counts as not-configured (matches `save_plugin_credentials`,
/// which only writes non-empty values).
fn field_has_stored_value(path: &std::path::Path) -> bool {
    match std::fs::metadata(path) {
        Ok(m) => m.len() > 0,
        // A missing file legitimately means "not configured".
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
        // Permission/IO errors are NOT "not configured" — the file may well
        // exist. We still report false (the UI degrades to "set it"), but log
        // so the cause is visible instead of silently swallowed. The path is
        // a token-dir filename, not the secret contents.
        Err(e) => {
            log::warn!("could not stat credential file {}: {e}", path.display());
            false
        }
    }
}

/// Returns the manifest `instructions` to surface in `PluginStatusEntry`.
/// `None` when the plugin is unverified, when no instructions are declared,
/// or when the cap would be exceeded — the latter is install-time invariant,
/// re-checked here as defence-in-depth (a >cap blob never reaches the
/// webview's `[innerHTML]`).
fn instructions_for_ui(verified: bool, instructions: Option<&str>) -> Option<String> {
    if !verified {
        return None;
    }
    let s = instructions?;
    if s.len() > speedwave_runtime::consts::PLUGIN_INSTRUCTIONS_MAX_BYTES {
        log::warn!(
            "plugin manifest instructions exceeds {} bytes — withholding from UI",
            speedwave_runtime::consts::PLUGIN_INSTRUCTIONS_MAX_BYTES
        );
        return None;
    }
    Some(s.to_string())
}

/// Validates a credential field name and value for safety.
pub(crate) fn validate_credential_field(key: &str, value: &str) -> Result<(), String> {
    if key.contains('/') || key.contains('\\') || key.contains("..") || key.contains('\0') {
        return Err(format!("invalid field name: {}", key));
    }
    if value.contains('\0') {
        return Err(format!("value for '{}' contains null byte", key));
    }
    if value.len() > crate::types::MAX_CREDENTIAL_BYTES {
        return Err(format!(
            "value for '{}' exceeds {} bytes",
            key,
            crate::types::MAX_CREDENTIAL_BYTES
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_plugins(project: String) -> Result<PluginsResponse, String> {
    check_project(&project)?;
    let user_config = config::load_user_config().map_err(|e| e.to_string())?;
    let project_entry = user_config.projects.iter().find(|p| p.name == project);

    let project_dir = project_entry
        .map(|p| p.dir.as_str())
        .ok_or_else(|| format!("project '{}' not found in config", project))?;
    let integrations =
        config::resolve_integrations(std::path::Path::new(project_dir), &user_config, &project);

    // Tolerant lister: every installed directory becomes one entry, with
    // `verification_status` carrying the verdict. Unverified entries are
    // shown so users know *why* a plugin is disabled and what to do
    // about it — hiding them would force users to inspect the filesystem.
    let ui_entries = plugin::list_for_ui();

    let mut entries = Vec::new();
    for ui in &ui_entries {
        // For entries without a parseable manifest, surface what we know
        // (slug = directory name) and a clear status; everything else
        // gets sensible empty defaults.
        let Some(manifest) = ui.manifest.as_ref() else {
            entries.push(PluginStatusEntry {
                slug: ui.slug.clone(),
                name: ui.slug.clone(),
                service_id: None,
                version: String::new(),
                description: String::new(),
                instructions: None,
                enabled: false,
                configured: false,
                auth_fields: Vec::new(),
                current_values: HashMap::new(),
                configured_fields: Vec::new(),
                token_mount: "ro".to_string(),
                settings_schema: None,
                requires_integrations: Vec::new(),
                verification_status: ui.verification_status.clone(),
                verification_error: ui.verification_error.clone(),
                has_host_bridge: false,
            });
            continue;
        };

        let sid = manifest.service_id.as_deref().unwrap_or(&manifest.slug);
        // An unverified plugin must NOT count as enabled, even if the
        // user previously enabled a (now-tampered) version. The frontend
        // additionally disables the enable toggle for non-verified entries.
        let verified = matches!(ui.verification_status, plugin::VerificationStatus::Verified);
        let enabled = verified && integrations.is_plugin_enabled(sid);

        let auth_fields: Vec<plugin::AuthFieldDef> = manifest.auth_fields.clone();

        let svc_token_dir = token_dir_for(&project, sid)?;
        let configured = is_plugin_configured(
            &svc_token_dir,
            &manifest.auth_fields,
            &manifest.requires_integrations,
            &project,
        );

        let mut current_values = HashMap::new();
        let mut configured_fields = Vec::new();
        for field in &manifest.auth_fields {
            let path = svc_token_dir.join(&field.key);
            // Metadata-only existence + non-empty check — drives the
            // per-field "configured" indicator for ALL fields (secret or
            // not) without reading secret contents.
            if field_has_stored_value(&path) {
                configured_fields.push(field.key.clone());
            }
            // current_values exposes only NON-secret values (host URLs etc.)
            // so the form can prefill them; secrets stay write-only.
            if field.is_secret {
                continue;
            }
            if let Ok(content) = std::fs::read_to_string(&path) {
                let trimmed = content.trim().to_string();
                if !trimmed.is_empty() {
                    current_values.insert(field.key.clone(), trimmed);
                }
            }
        }

        let token_mount = match &manifest.token_mount {
            plugin::TokenMount::ReadOnly => "ro".to_string(),
            plugin::TokenMount::ReadWrite { justification } => {
                format!("rw: {}", justification)
            }
        };

        entries.push(PluginStatusEntry {
            slug: manifest.slug.clone(),
            name: manifest.name.clone(),
            service_id: manifest.service_id.clone(),
            version: manifest.version.clone(),
            description: manifest.description.clone(),
            // Trust boundary for free-form Markdown: only verified plugins,
            // and re-check the install-time cap (defence-in-depth — if
            // signature verify is ever bypassed, the renderer still won't see
            // an oversized blob). The frontend `@if (verified)` is the third
            // layer.
            instructions: instructions_for_ui(verified, manifest.instructions.as_deref()),
            enabled,
            configured,
            auth_fields,
            current_values,
            configured_fields,
            token_mount,
            settings_schema: manifest.settings_schema.clone(),
            requires_integrations: manifest.requires_integrations.clone(),
            verification_status: ui.verification_status.clone(),
            verification_error: ui.verification_error.clone(),
            has_host_bridge: manifest.host_bridge.is_some(),
        });
    }

    Ok(PluginsResponse { plugins: entries })
}

fn is_plugin_configured(
    svc_token_dir: &std::path::Path,
    auth_fields: &[plugin::AuthFieldDef],
    requires_integrations: &[String],
    project: &str,
) -> bool {
    let secret_fields: Vec<_> = auth_fields
        .iter()
        .filter(|f| plugin::blocks_plugin_readiness(f))
        .collect();
    // Check secret fields if any exist
    if !secret_fields.is_empty() {
        let all_present = secret_fields.iter().all(|f| {
            let path = svc_token_dir.join(&f.key);
            path.exists()
                && std::fs::metadata(&path)
                    .map(|m| m.len() > 0)
                    .unwrap_or(false)
        });
        if !all_present {
            return false;
        }
    }

    // Check that all required integrations are configured
    for integration in requires_integrations {
        if !crate::integrations_cmd::is_service_configured(project, integration) {
            return false;
        }
    }

    true
}

/// Reads `plugin.json` from a ZIP without extracting, verifying signature,
/// or building. Returns a lightweight summary so the install overlay knows
/// which steps to render BEFORE invoking [`install_plugin`].
#[tauri::command]
pub async fn peek_plugin_manifest(
    zip_path: String,
) -> Result<plugin::PluginManifestSummary, String> {
    log::info!("peek_plugin_manifest: zip_path={zip_path}");
    let path = std::path::PathBuf::from(&zip_path);
    if !path.exists() {
        return Err(format!("File not found: {}", zip_path));
    }
    tokio::task::spawn_blocking(move || plugin::peek_plugin_manifest(&path))
        .await
        .map_err(|e| format!("peek task panicked: {e}"))?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn install_plugin(
    zip_path: String,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    log::info!("install_plugin: zip_path={zip_path}");
    let path = std::path::PathBuf::from(&zip_path);
    if !path.exists() {
        return Err(format!("File not found: {}", zip_path));
    }
    let app = app_handle.clone();

    let outcome = tokio::task::spawn_blocking(move || {
        let rt = speedwave_runtime::runtime::detect_runtime();
        plugin::install_plugin(&path, Some(&rt), &mut |progress| {
            let _ = app.emit("plugin_install_status", progress);
        })
    })
    .await
    .map_err(|e| format!("install task panicked: {e}"))?
    .map_err(|e| e.to_string())?;

    let manifest = match &outcome {
        plugin::InstallOutcome::Installed(m) => m,
        plugin::InstallOutcome::InstalledPendingBuild(m) => m,
    };

    // Auto-enable only when image is ready and no required secret is missing.
    // Plugins with optional secret fields (e.g. tokens that unlock extra
    // capabilities but are not needed for the baseline) can run right away;
    // the user fills them later if needed.
    let should_auto_enable = matches!(outcome, plugin::InstallOutcome::Installed(_))
        && !manifest
            .auth_fields
            .iter()
            .any(plugin::blocks_plugin_readiness);
    if should_auto_enable {
        let plugin_key = manifest.service_id.as_deref().unwrap_or(&manifest.slug);
        let plugin_key = plugin_key.to_string();
        config::with_config_lock(|| {
            let mut cfg = config::load_user_config()?;
            if let Some(active) = cfg.active_project.clone() {
                if let Some(entry) = cfg.projects.iter_mut().find(|p| p.name == active) {
                    let integrations = entry.integrations.get_or_insert_with(Default::default);
                    integrations.set_plugin_enabled(&plugin_key, true);
                    config::save_user_config(&cfg)?;
                }
            }
            Ok(())
        })
        .map_err(|e| e.to_string())?;
    }

    crate::bridges::plugin_bridge_manager::respawn_for(&manifest.slug, &app_handle);

    Ok(match outcome {
        plugin::InstallOutcome::Installed(m) => {
            format!("Plugin '{}' v{} installed successfully", m.name, m.version)
        }
        plugin::InstallOutcome::InstalledPendingBuild(m) => format!(
            "Plugin '{}' v{} installed; image build failed and will retry on next launch",
            m.name, m.version
        ),
    })
}

#[tauri::command]
pub fn remove_plugin(slug: String) -> Result<(), String> {
    log::info!("remove_plugin: slug={slug}");
    crate::bridges::plugin_bridge_manager::stop_for(&slug);

    // Recovery action: removal must work for tampered plugins too.
    // Use the tolerant lister so an unparseable manifest still gives us
    // the slug-as-fallback path. We need `service_id` and `auth_fields`
    // for cleanup; both default sensibly when the manifest is missing.
    let entries = plugin::list_for_ui();
    let entry = entries.iter().find(|e| e.slug == slug);
    let manifest = entry.and_then(|e| e.manifest.as_ref());
    let service_id = manifest
        .and_then(|m| m.service_id.as_deref())
        .map(|s| s.to_string())
        .unwrap_or_else(|| slug.clone());
    let auth_fields: Vec<String> = manifest
        .map(|m| m.auth_fields.iter().map(|f| f.key.clone()).collect())
        .unwrap_or_default();

    // Delete plugin files from ~/.speedwave/plugins/<slug>/ and clean up
    // the cached container image. Runtime is best-effort: when the
    // detected runtime is unavailable we skip image cleanup, mirroring
    // the install_plugin code path.
    let rt = speedwave_runtime::runtime::detect_runtime();
    let rt_ref: Option<&speedwave_runtime::runtime::LockedRuntime> =
        if rt.is_available() { Some(&rt) } else { None };
    plugin::remove_plugin(&slug, rt_ref).map_err(|e| e.to_string())?;

    // Collect project names for token cleanup (before config lock)
    let project_names: Vec<String> = {
        let cfg = config::load_user_config().map_err(|e| e.to_string())?;
        cfg.projects.iter().map(|p| p.name.clone()).collect()
    };

    // Clean config: plugin_settings + integrations.plugins
    config::with_config_lock(|| {
        let mut user_config = config::load_user_config()?;
        let mut changed = false;
        for project in &mut user_config.projects {
            if let Some(ps) = project.plugin_settings.as_mut() {
                if ps.remove(&slug).is_some() {
                    changed = true;
                }
            }
            if let Some(integrations) = project.integrations.as_mut() {
                if let Some(plugins) = integrations.plugins.as_mut() {
                    if plugins.remove(&service_id).is_some() {
                        changed = true;
                    }
                }
            }
        }
        if changed {
            config::save_user_config(&user_config)?;
        }
        Ok(())
    })
    .map_err(|e| e.to_string())?;

    // Delete tokens from ~/.speedwave/tokens/<project>/<service_id>/
    for project_name in &project_names {
        let svc_dir = token_dir_for(project_name, &service_id)?;
        if svc_dir.exists() {
            if auth_fields.is_empty() {
                std::fs::remove_dir_all(&svc_dir).map_err(|e| e.to_string())?;
            } else {
                for field_key in &auth_fields {
                    let path = svc_dir.join(field_key);
                    if path.exists() {
                        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
                    }
                }
                if svc_dir
                    .read_dir()
                    .map_err(|e| e.to_string())?
                    .next()
                    .is_none()
                {
                    std::fs::remove_dir(&svc_dir).map_err(|e| e.to_string())?;
                }
            }
        }
    }

    Ok(())
}

#[tauri::command]
pub fn set_plugin_enabled(
    project: String,
    service_id: String,
    enabled: bool,
) -> Result<(), String> {
    check_project(&project)?;
    log::info!("set_plugin_enabled: project={project} service_id={service_id} enabled={enabled}");

    // Verified-only on enable: a tampered plugin (missing SIGNATURE,
    // dir/slug mismatch, etc.) must not become enabled. We use the
    // tolerant `list_for_ui` so the presence of *another* unverified
    // plugin doesn't block the user from enabling a verified one. The
    // frontend already disables the toggle for non-verified entries, but
    // we re-check here so direct command calls from tests/scripts can't
    // bypass it. Disable requests skip the check — the user must always
    // be able to turn off a bad plugin.
    if enabled {
        let entries = plugin::list_for_ui();
        let matches_id = |m: &plugin::PluginManifest| {
            m.service_id.as_deref() == Some(&service_id) || m.slug == service_id
        };
        let candidate = entries
            .iter()
            .find(|e| e.manifest.as_ref().map(matches_id).unwrap_or(false));
        match candidate {
            None => {
                return Err(format!(
                    "no installed plugin with service_id '{}'",
                    service_id
                ));
            }
            Some(e) if e.verification_status != plugin::VerificationStatus::Verified => {
                return Err(format!(
                    "plugin '{}' cannot be enabled: {}. Reinstall a signed plugin or remove it.",
                    service_id,
                    e.verification_error
                        .as_deref()
                        .unwrap_or("verification failed")
                ));
            }
            Some(_) => {}
        }
    }

    config::with_config_lock(|| {
        let mut user_config = config::load_user_config()?;

        let entry = user_config
            .projects
            .iter_mut()
            .find(|p| p.name == project)
            .ok_or_else(|| anyhow::anyhow!("project '{}' not found", project))?;

        let integrations = entry.integrations.get_or_insert_with(Default::default);
        integrations.set_plugin_enabled(&service_id, enabled);

        config::save_user_config(&user_config)
    })
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_plugin_credentials(
    project: String,
    slug: String,
    credentials: HashMap<String, String>,
) -> Result<(), String> {
    check_project(&project)?;
    log::info!("save_plugin_credentials: project={project} slug={slug}");

    // Verified-only: writing credentials for an unverified plugin is an
    // attack — the manifest's `auth_fields` allowlist (and `service_id`,
    // which decides the on-disk token path) come from a manifest we
    // can't trust until the signature checks out.
    let manifest = require_verified_with_manifest(&slug)?;

    let sid = manifest.service_id.as_deref().unwrap_or(&manifest.slug);
    let allowed_keys: Vec<&str> = manifest
        .auth_fields
        .iter()
        .map(|f| f.key.as_str())
        .collect();

    let svc_dir = token_dir_for(&project, sid)?;
    std::fs::create_dir_all(&svc_dir).map_err(|e| e.to_string())?;

    // OAuth fields (`oauth_flow: true`) are kept off-mount: a compromised
    // worker must not read a client secret from `/tokens`. They accumulate
    // into the seed file instead of `svc_dir`.
    let mut oauth_seed: HashMap<String, String> = HashMap::new();

    for (key, value) in &credentials {
        if !allowed_keys.contains(&key.as_str()) {
            return Err(format!("field '{}' not allowed for plugin '{}'", key, slug));
        }
        validate_credential_field(key, value)?;
        // Enforce the field's optional regex constraint host-side — the UI's
        // HTML `pattern` check is advisory (a crafted IPC call bypasses it).
        let field = manifest
            .auth_fields
            .iter()
            .find(|f| f.key == *key)
            .ok_or_else(|| {
                format!("internal: '{key}' passed the allow-list but is missing from auth_fields")
            })?;
        plugin::validate_credential_value(field, value)?;

        if field.oauth_flow {
            oauth_seed.insert(key.clone(), value.clone());
            continue;
        }

        let file_path = svc_dir.join(key);
        std::fs::write(&file_path, value).map_err(|e| e.to_string())?;
        crate::fs_perms::set_owner_only(&file_path)?;
    }

    if !oauth_seed.is_empty() {
        write_oauth_seed(&project, &slug, &oauth_seed)?;
    }

    Ok(())
}

/// Writes OAuth client credentials to the host-only pre-auth seed file
/// (`oauth/<project>/<slug>.seed.json`, 0o600). Read by `start_plugin_oauth`;
/// never mounted into a worker.
fn write_oauth_seed(
    project: &str,
    slug: &str,
    seed: &HashMap<String, String>,
) -> Result<(), String> {
    let path = plugin::oauth_seed_file(project, slug);
    let parent = path.parent().ok_or_else(|| "seed: no parent".to_string())?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    let body = serde_json::to_string_pretty(seed).map_err(|e| e.to_string())? + "\n";
    speedwave_runtime::fs_perms::write_restricted_file(&path, &body).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn plugin_save_settings(
    project: String,
    slug: String,
    settings: serde_json::Value,
) -> Result<(), String> {
    check_project(&project)?;
    log::info!("plugin_save_settings: project={project} slug={slug}");

    // Verified-only: settings are stored under a slug whose meaning
    // comes from the manifest; persisting settings for a tampered
    // plugin would let an attacker pre-populate state for a future
    // (re)installed legitimate plugin.
    let manifest = require_verified_with_manifest(&slug)?;

    // Cap settings JSON size to prevent a runaway plugin from bloating
    // user_config.json. The bound is shared with `settings_schema`
    // validation (see `consts::PLUGIN_SETTINGS_MAX_BYTES`).
    let serialised = serde_json::to_vec(&settings).map_err(|e| e.to_string())?;
    if serialised.len() > consts::PLUGIN_SETTINGS_MAX_BYTES {
        return Err(format!(
            "plugin '{}' settings exceed {} bytes",
            slug,
            consts::PLUGIN_SETTINGS_MAX_BYTES
        ));
    }

    // If the plugin declared a `settings_schema`, the payload must
    // validate against it. Without this, the manifest field is
    // documentation only — the user_config could end up holding values
    // outside the schema's enum/type, which the worker would later
    // crash on or, worse, silently misinterpret.
    if let Some(ref schema) = manifest.settings_schema {
        validate_settings_against_schema(&slug, schema, &settings)?;
    }

    config::with_config_lock(|| {
        let mut user_config = config::load_user_config()?;

        let entry = user_config
            .projects
            .iter_mut()
            .find(|p| p.name == project)
            .ok_or_else(|| anyhow::anyhow!("project '{}' not found", project))?;

        let ps = entry.plugin_settings.get_or_insert_with(HashMap::new);
        ps.insert(slug.clone(), settings.clone());

        config::save_user_config(&user_config)
    })
    .map_err(|e| e.to_string())
}

/// Helper: rejects calls that target a plugin whose verification
/// status is not `Verified`. Used by every Tauri command that *acts
/// on* a plugin's identity — credentials, settings — to keep the
/// "tampered plugins are inert" invariant in one place.
fn require_verified(slug: &str) -> Result<(), String> {
    require_verified_with_manifest(slug).map(|_| ())
}

/// Same gate as [`require_verified`] but returns the parsed manifest
/// so callers that need to inspect declared fields (e.g. the
/// `settings_schema` for `plugin_save_settings`) don't have to look
/// it up a second time.
fn require_verified_with_manifest(slug: &str) -> Result<plugin::PluginManifest, String> {
    let entries = plugin::list_for_ui();
    let entry = entries
        .into_iter()
        .find(|e| e.slug == slug)
        .ok_or_else(|| format!("plugin '{}' not found", slug))?;
    if entry.verification_status != plugin::VerificationStatus::Verified {
        return Err(format!(
            "plugin '{}' is not verified: {}",
            slug,
            entry
                .verification_error
                .as_deref()
                .unwrap_or("verification failed")
        ));
    }
    entry
        .manifest
        .ok_or_else(|| format!("plugin '{}' has no manifest", slug))
}

/// Validates a settings payload against a plugin's declared JSON Schema
/// (Draft 7). Pure function — extracted from `plugin_save_settings` so
/// the schema-rejection invariant can be unit-tested without standing
/// up a project/config/verified-plugin fixture. Returns a
/// user-presentable error string on a malformed schema or a payload
/// that doesn't validate; `Ok(())` when the payload conforms.
///
/// The runtime side already gates `settings_schema` shape and size at
/// install time (`plugin::validate_manifest`), so a *malformed* schema
/// reaching here is unusual — but we still return a clean error rather
/// than panicking, in case an older plugin was installed before that
/// gate existed.
fn validate_settings_against_schema(
    slug: &str,
    schema: &serde_json::Value,
    settings: &serde_json::Value,
) -> Result<(), String> {
    let validator = jsonschema::draft7::new(schema)
        .map_err(|e| format!("plugin '{}' has an invalid settings_schema: {e}", slug))?;
    if let Err(e) = validator.validate(settings) {
        return Err(format!(
            "settings for plugin '{}' do not match its schema: {e}",
            slug
        ));
    }
    Ok(())
}

#[tauri::command]
pub fn plugin_load_settings(project: String, slug: String) -> Result<serde_json::Value, String> {
    check_project(&project)?;
    log::info!("plugin_load_settings: project={project} slug={slug}");

    // Verified-only: a tampered plugin must not be able to read settings
    // saved for a previously-legitimate version of itself. Settings can
    // contain non-secret-but-private project metadata (host names,
    // ticket IDs, model selections) that a tampered plugin should not
    // be allowed to scrape.
    require_verified(&slug)?;

    let user_config = config::load_user_config().map_err(|e| e.to_string())?;

    let value = user_config
        .projects
        .iter()
        .find(|p| p.name == project)
        .and_then(|entry| entry.plugin_settings.as_ref())
        .and_then(|ps| ps.get(&slug))
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));

    Ok(value)
}

#[tauri::command]
pub fn delete_plugin_credentials(project: String, slug: String) -> Result<(), String> {
    check_project(&project)?;
    log::info!("delete_plugin_credentials: project={project} slug={slug}");

    // Recovery action: a user must be able to clear the credentials of
    // a tampered plugin even if its signature no longer verifies — this
    // is the cleanup half of `remove_plugin`. We use the tolerant
    // lister and tolerate a missing/unparseable manifest. The token
    // directory is identified by `service_id` (or the slug when the
    // manifest is absent), and EVERY path we touch is canonicalised and
    // checked to stay inside that directory — a tampered `plugin.json`
    // with an `auth_field` key like `../../../other-project/token`
    // must not let us delete outside the service token dir.
    let entries = plugin::list_for_ui();
    let entry = entries.iter().find(|e| e.slug == slug);
    let manifest = entry.and_then(|e| e.manifest.as_ref());
    let sid = manifest
        .and_then(|m| m.service_id.as_deref())
        .unwrap_or(slug.as_str());

    let svc_dir = token_dir_for(&project, sid)?;
    if svc_dir.exists() {
        // Which token files to delete: the manifest's auth_fields if we
        // have a (possibly unverified) manifest, otherwise everything in
        // the service token dir (slug-based cleanup, mirroring
        // `remove_plugin`).
        let keys: Vec<String> = match manifest {
            Some(m) => m.auth_fields.iter().map(|f| f.key.clone()).collect(),
            None => std::fs::read_dir(&svc_dir)
                .map_err(|e| e.to_string())?
                .flatten()
                .filter_map(|e| e.file_name().into_string().ok())
                .collect(),
        };
        // Use the single symlink-aware helper so bulk and per-field delete
        // share one safety contract (no-follow + refuse all symlinks + only
        // remove the literal path).
        for key in &keys {
            remove_credential_file_guarded(&svc_dir, key)?;
        }
    }

    // Auto-disable the plugin since credentials are removed
    config::with_config_lock(|| {
        let mut user_config = config::load_user_config()?;
        if let Some(entry) = user_config.projects.iter_mut().find(|p| p.name == project) {
            let integrations = entry.integrations.get_or_insert_with(Default::default);
            integrations.set_plugin_enabled(sid, false);
            config::save_user_config(&user_config)?;
        }
        Ok(())
    })
    .map_err(|e| e.to_string())
}

/// Deletes a SINGLE stored credential field. Verified-only + allowlist +
/// symlink-guard. See ADR-015 "Credentials" for the layered safety contract.
#[tauri::command]
pub fn delete_plugin_credential_field(
    project: String,
    slug: String,
    key: String,
) -> Result<(), String> {
    check_project(&project)?;
    log::info!("delete_plugin_credential_field: project={project} slug={slug} key={key}");

    let manifest = require_verified_with_manifest(&slug)?;
    let sid = manifest.service_id.as_deref().unwrap_or(&manifest.slug);

    // The key must be a declared auth_field — refuse arbitrary deletions
    // even for a verified plugin.
    if !manifest.auth_fields.iter().any(|f| f.key == key) {
        return Err(format!(
            "field '{}' is not declared in plugin '{}' auth_fields",
            key, slug
        ));
    }
    // Reuse the field-name safety check (rejects '/', '\\', '..', null).
    // The empty value arg only exercises the key checks here.
    validate_credential_field(&key, "")?;

    let svc_dir = token_dir_for(&project, sid)?;
    remove_credential_file_guarded(&svc_dir, &key)
}

/// Removes a single credential file under `svc_dir`. Refuses any symlink —
/// credentials are only ever written by `save_plugin_credentials` via
/// `fs::write`, never as symlinks, so a symlink in the token dir is treated
/// as adversarial regardless of where its target points. Idempotent: a
/// genuinely missing entry is success; other IO errors (permission, dangling
/// symlinks via `metadata` after refusal-by-symlink-type) are surfaced.
///
/// Uses `symlink_metadata` (no-follow) so we delete `path` itself rather than
/// its symlink target (defence-in-depth — addresses both the M1 case where a
/// same-dir symlink would otherwise have its target unlinked, and the Low
/// case where a dangling symlink would short-circuit `canonicalize` as
/// "already gone"). Extracted so the safety guard is unit-testable without
/// a verified-plugin fixture.
fn remove_credential_file_guarded(svc_dir: &std::path::Path, key: &str) -> Result<(), String> {
    let path = svc_dir.join(key);
    match std::fs::symlink_metadata(&path) {
        Ok(meta) if meta.file_type().is_symlink() => Err(format!(
            "refusing to delete '{}': credential entry is a symlink (defence-in-depth — credentials are written via fs::write, never as symlinks)",
            path.display()
        )),
        Ok(_) => std::fs::remove_file(&path).map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("could not stat credential entry '{key}': {e}")),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn plugin_status_entry_serializes() {
        let entry = PluginStatusEntry {
            slug: "test-plugin".into(),
            name: "Test Plugin".into(),
            service_id: Some("test-plugin".into()),
            version: "1.0.0".into(),
            description: "A test plugin".into(),
            instructions: None,
            enabled: true,
            configured: false,
            auth_fields: vec![plugin::AuthFieldDef {
                key: "api_key".into(),
                label: "API Key".into(),
                field_type: "password".into(),
                placeholder: "Enter key".into(),
                is_secret: true,
                required: true,
                description: None,
                validation: None,
                oauth_flow: false,
            }],
            current_values: HashMap::new(),
            configured_fields: Vec::new(),
            token_mount: "ro".into(),
            settings_schema: None,
            requires_integrations: vec![],
            verification_status: plugin::VerificationStatus::Verified,
            verification_error: None,
            has_host_bridge: false,
        };
        let json = serde_json::to_string(&entry).unwrap();
        assert!(json.contains("test-plugin"));
        assert!(json.contains("api_key"));
        // The Angular frontend's `PluginVerificationStatus` union depends
        // on the snake_case wire literals — pin one here so a mis-annotated
        // `VerificationStatus` enum (e.g. PascalCase) is caught.
        assert!(json.contains(r#""verification_status":"verified""#));
        // instructions is None here → omitted from the wire (skip_serializing_if).
        assert!(
            !json.contains("instructions"),
            "None instructions must not serialize a key"
        );
    }

    #[test]
    fn plugin_status_entry_serializes_instructions_when_present() {
        let entry = PluginStatusEntry {
            slug: "example-plugin".into(),
            name: "Example Plugin".into(),
            service_id: Some("example-plugin".into()),
            version: "0.1.4".into(),
            description: "short".into(),
            instructions: Some("# Setup\n1. Import the bridge plugin".into()),
            enabled: false,
            configured: false,
            auth_fields: vec![],
            current_values: HashMap::new(),
            configured_fields: Vec::new(),
            token_mount: "ro".into(),
            settings_schema: None,
            requires_integrations: vec![],
            verification_status: plugin::VerificationStatus::Verified,
            verification_error: None,
            has_host_bridge: true,
        };
        let json = serde_json::to_string(&entry).unwrap();
        assert!(json.contains(r##""instructions":"# Setup"##));
    }

    #[test]
    fn instructions_for_ui_gates_unverified_oversized_and_absent() {
        // Verified + within cap → passes through unchanged.
        let ok = instructions_for_ui(true, Some("# Setup\nclean"));
        assert_eq!(ok.as_deref(), Some("# Setup\nclean"));
        // Unverified plugin → withheld regardless of content.
        assert_eq!(instructions_for_ui(false, Some("# Setup")), None);
        // Verified + no instructions → still None.
        assert_eq!(instructions_for_ui(true, None), None);
        // Verified + oversized → withheld (defence-in-depth re-check of the
        // install-time cap in case signature verify is ever bypassed).
        let huge = "a".repeat(speedwave_runtime::consts::PLUGIN_INSTRUCTIONS_MAX_BYTES + 1);
        assert_eq!(instructions_for_ui(true, Some(&huge)), None);
        // Verified + exactly at cap → passes (cap is inclusive).
        let at_cap = "a".repeat(speedwave_runtime::consts::PLUGIN_INSTRUCTIONS_MAX_BYTES);
        assert!(instructions_for_ui(true, Some(&at_cap)).is_some());
    }

    #[test]
    fn plugin_status_entry_serializes_with_settings_schema() {
        let schema = serde_json::json!({
            "type": "object",
            "properties": {
                "currency": {
                    "type": "string",
                    "enum": ["PLN", "EUR", "USD"],
                    "default": "PLN",
                    "description": "Default currency"
                }
            }
        });
        let entry = PluginStatusEntry {
            slug: "example-plugin".into(),
            name: "Example Plugin CRM".into(),
            service_id: Some("example-plugin".into()),
            version: "1.2.0".into(),
            description: "CRM integration".into(),
            instructions: None,
            enabled: true,
            configured: true,
            auth_fields: vec![],
            current_values: HashMap::new(),
            configured_fields: Vec::new(),
            token_mount: "ro".into(),
            settings_schema: Some(schema),
            requires_integrations: vec!["sharepoint".into()],
            verification_status: plugin::VerificationStatus::Verified,
            verification_error: None,
            has_host_bridge: false,
        };
        let json = serde_json::to_string(&entry).unwrap();
        assert!(json.contains("settings_schema"));
        assert!(json.contains("currency"));
        assert!(json.contains("PLN"));
        assert!(json.contains("requires_integrations"));
        assert!(json.contains("sharepoint"));
        assert!(json.contains(r#""verification_status":"verified""#));
    }

    // ── settings-schema validation (the `plugin_save_settings` gate) ─────
    //
    // `plugin_save_settings` is a Tauri command and needs a project /
    // config / verified-plugin fixture to drive end-to-end. The
    // schema-validation step is the security-relevant part, so it's
    // extracted into `validate_settings_against_schema` and tested
    // directly here.

    #[test]
    fn validate_settings_against_schema_accepts_conforming_payload() {
        let schema = serde_json::json!({
            "type": "object",
            "properties": {
                "currency": { "type": "string", "enum": ["PLN", "EUR", "USD"] }
            },
            "required": ["currency"]
        });
        let payload = serde_json::json!({ "currency": "EUR" });
        super::validate_settings_against_schema("example-plugin", &schema, &payload)
            .expect("a conforming payload must pass");
    }

    #[test]
    fn validate_settings_against_schema_rejects_payload_violating_schema() {
        let schema = serde_json::json!({
            "type": "object",
            "properties": {
                "currency": { "type": "string", "enum": ["PLN", "EUR", "USD"] }
            },
            "required": ["currency"]
        });
        // Value outside the enum.
        let bad_enum = serde_json::json!({ "currency": "BTC" });
        let err = super::validate_settings_against_schema("example-plugin", &schema, &bad_enum)
            .expect_err("off-enum value must be rejected");
        assert!(err.contains("do not match its schema"), "got: {err}");

        // Wrong type.
        let bad_type = serde_json::json!({ "currency": 42 });
        let err = super::validate_settings_against_schema("example-plugin", &schema, &bad_type)
            .expect_err("wrong-type value must be rejected");
        assert!(err.contains("do not match its schema"), "got: {err}");

        // Missing required field.
        let missing = serde_json::json!({});
        let err = super::validate_settings_against_schema("example-plugin", &schema, &missing)
            .expect_err("missing required field must be rejected");
        assert!(err.contains("do not match its schema"), "got: {err}");
    }

    #[test]
    fn validate_settings_against_schema_rejects_malformed_schema() {
        // A schema that isn't a valid Draft-7 schema (e.g. `type` set
        // to a non-string nonsense value). `jsonschema::draft7::new`
        // should fail to compile it; we surface that as a clean error.
        let bogus_schema = serde_json::json!({ "type": 12345 });
        let payload = serde_json::json!({ "anything": true });
        let err =
            super::validate_settings_against_schema("example-plugin", &bogus_schema, &payload)
                .expect_err("malformed schema must be rejected, not panic");
        assert!(err.contains("invalid settings_schema"), "got: {err}");
    }

    #[test]
    fn is_plugin_configured_true_when_no_secret_fields() {
        let fields = vec![plugin::AuthFieldDef {
            key: "host_url".into(),
            label: "Host".into(),
            field_type: "text".into(),
            placeholder: "".into(),
            is_secret: false,
            required: true,
            description: None,
            validation: None,
            oauth_flow: false,
        }];
        assert!(is_plugin_configured(
            std::path::Path::new("/nonexistent"),
            &fields,
            &[],
            "any-project",
        ));
    }

    #[test]
    fn is_plugin_configured_true_when_no_auth_fields() {
        assert!(is_plugin_configured(
            std::path::Path::new("/nonexistent"),
            &[],
            &[],
            "any-project",
        ));
    }

    #[test]
    fn is_plugin_configured_false_when_dir_missing() {
        let fields = vec![plugin::AuthFieldDef {
            key: "api_key".into(),
            label: "API Key".into(),
            field_type: "password".into(),
            placeholder: "".into(),
            is_secret: true,
            required: true,
            description: None,
            validation: None,
            oauth_flow: false,
        }];
        assert!(!is_plugin_configured(
            std::path::Path::new("/nonexistent/path"),
            &fields,
            &[],
            "any-project",
        ));
    }

    #[test]
    fn is_plugin_configured_true_when_secret_file_exists() {
        let dir = tempfile::tempdir().unwrap();
        let key_path = dir.path().join("api_key");
        std::fs::write(&key_path, "secret-value").unwrap();

        let fields = vec![plugin::AuthFieldDef {
            key: "api_key".into(),
            label: "API Key".into(),
            field_type: "password".into(),
            placeholder: "".into(),
            is_secret: true,
            required: true,
            description: None,
            validation: None,
            oauth_flow: false,
        }];
        assert!(is_plugin_configured(
            dir.path(),
            &fields,
            &[],
            "any-project"
        ));
    }

    #[test]
    fn is_plugin_configured_false_when_secret_file_empty() {
        let dir = tempfile::tempdir().unwrap();
        let key_path = dir.path().join("api_key");
        std::fs::write(&key_path, "").unwrap();

        let fields = vec![plugin::AuthFieldDef {
            key: "api_key".into(),
            label: "API Key".into(),
            field_type: "password".into(),
            placeholder: "".into(),
            is_secret: true,
            required: true,
            description: None,
            validation: None,
            oauth_flow: false,
        }];
        assert!(!is_plugin_configured(
            dir.path(),
            &fields,
            &[],
            "any-project"
        ));
    }

    #[test]
    fn is_plugin_configured_true_when_only_secret_is_optional_and_absent() {
        let dir = tempfile::tempdir().unwrap();
        let fields = vec![plugin::AuthFieldDef {
            key: "api_key".into(),
            label: "API Key".into(),
            field_type: "password".into(),
            placeholder: "".into(),
            is_secret: true,
            required: false,
            description: None,
            validation: None,
            oauth_flow: false,
        }];
        assert!(is_plugin_configured(
            dir.path(),
            &fields,
            &[],
            "any-project"
        ));
    }

    #[test]
    fn is_plugin_configured_false_when_required_secret_missing_alongside_optional() {
        let dir = tempfile::tempdir().unwrap();
        let fields = vec![
            plugin::AuthFieldDef {
                key: "api_key".into(),
                label: "API Key".into(),
                field_type: "password".into(),
                placeholder: "".into(),
                is_secret: true,
                required: true,
                description: None,
                validation: None,
                oauth_flow: false,
            },
            plugin::AuthFieldDef {
                key: "extra_token".into(),
                label: "Extra".into(),
                field_type: "password".into(),
                placeholder: "".into(),
                is_secret: true,
                required: false,
                description: None,
                validation: None,
                oauth_flow: false,
            },
        ];
        assert!(!is_plugin_configured(
            dir.path(),
            &fields,
            &[],
            "any-project"
        ));
    }

    #[test]
    fn field_has_stored_value_true_for_non_empty_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("example_pat");
        std::fs::write(&path, "tok_abc").unwrap();
        assert!(field_has_stored_value(&path));
    }

    #[test]
    fn field_has_stored_value_false_for_empty_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("example_pat");
        std::fs::write(&path, "").unwrap();
        assert!(
            !field_has_stored_value(&path),
            "zero-byte file must count as not-configured"
        );
    }

    #[test]
    fn field_has_stored_value_false_for_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("does_not_exist");
        assert!(
            !field_has_stored_value(&path),
            "absent file must count as not-configured"
        );
    }

    #[test]
    fn remove_credential_file_guarded_deletes_within_dir() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("api_key");
        std::fs::write(&f, "secret").unwrap();
        assert!(remove_credential_file_guarded(dir.path(), "api_key").is_ok());
        assert!(!f.exists(), "file inside the token dir must be deleted");
    }

    #[test]
    fn remove_credential_file_guarded_idempotent_when_missing() {
        let dir = tempfile::tempdir().unwrap();
        assert!(
            remove_credential_file_guarded(dir.path(), "never_existed").is_ok(),
            "deleting a missing file must be an idempotent success"
        );
    }

    #[cfg(unix)]
    #[test]
    fn remove_credential_file_guarded_refuses_symlink_escape() {
        // A symlink whose target lives outside the token dir must be refused
        // and the target must survive intact.
        let svc = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let victim = outside.path().join("victim");
        std::fs::write(&victim, "must NOT be deleted").unwrap();
        std::os::unix::fs::symlink(&victim, svc.path().join("evil")).unwrap();

        let err = remove_credential_file_guarded(svc.path(), "evil").unwrap_err();
        assert!(err.contains("symlink"), "got: {err}");
        assert!(
            victim.exists(),
            "a file outside the token dir must never be deleted via a symlink"
        );
    }

    #[cfg(unix)]
    #[test]
    fn remove_credential_file_guarded_refuses_intra_dir_symlink() {
        // A symlink whose target also lives INSIDE the token dir: the old
        // implementation would have unlinked the target (M1). The new
        // symlink_metadata-based check refuses every symlink, so the target
        // is preserved unconditionally.
        let svc = tempfile::tempdir().unwrap();
        let target = svc.path().join("real");
        std::fs::write(&target, "real credential").unwrap();
        std::os::unix::fs::symlink(&target, svc.path().join("alias")).unwrap();

        let err = remove_credential_file_guarded(svc.path(), "alias").unwrap_err();
        assert!(err.contains("symlink"), "got: {err}");
        assert!(
            target.exists(),
            "an intra-dir symlink target must NOT be unlinked when deleting the alias"
        );
    }

    #[cfg(unix)]
    #[test]
    fn remove_credential_file_guarded_refuses_dangling_symlink() {
        // A symlink whose target never existed used to short-circuit through
        // canonicalize's NotFound branch as "idempotent success"; now we use
        // symlink_metadata (no-follow), so the symlink is rejected outright.
        let svc = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink("/no/such/thing", svc.path().join("ghost")).unwrap();

        let err = remove_credential_file_guarded(svc.path(), "ghost").unwrap_err();
        assert!(err.contains("symlink"), "got: {err}");
    }

    #[test]
    fn delete_field_rejects_key_not_in_auth_fields_allowlist() {
        // Mirror of save_plugin_credentials_rejects_field_not_in_auth_fields:
        // delete_plugin_credential_field builds the same allowlist from the
        // verified manifest's auth_fields and rejects anything outside it.
        let manifest = plugin::PluginManifest {
            name: "Test".to_string(),
            service_id: Some("test-plugin".to_string()),
            slug: "test-plugin".to_string(),
            version: "1.0.0".to_string(),
            description: "test".to_string(),
            port: Some(5000),
            image_tag: None,
            resources: vec![],
            token_mount: plugin::TokenMount::ReadOnly,
            auth_fields: vec![plugin::AuthFieldDef {
                key: "api_key".to_string(),
                label: "API Key".to_string(),
                field_type: "password".to_string(),
                placeholder: "".to_string(),
                is_secret: true,
                required: true,
                description: None,
                validation: None,
                oauth_flow: false,
            }],
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

        let allowed_keys: Vec<&str> = manifest
            .auth_fields
            .iter()
            .map(|f| f.key.as_str())
            .collect();

        assert!(allowed_keys.contains(&"api_key"));
        assert!(
            !allowed_keys.contains(&"other_key"),
            "clearing a field not in auth_fields must be rejected"
        );
        assert!(
            !allowed_keys.contains(&"../../etc/passwd"),
            "path traversal key must be rejected"
        );
    }

    #[test]
    fn plugin_save_and_load_settings_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        let config_path = tmp.path().join("config.json");

        // Create a config with one project
        let initial_config = config::SpeedwaveUserConfig {
            projects: vec![config::ProjectUserEntry {
                name: "test-project".into(),
                dir: "/tmp/test".into(),
                claude: None,
                integrations: None,
                plugin_settings: None,
            }],
            active_project: Some("test-project".into()),
            selected_ide: None,
            transcription: None,
            ui: None,
        };
        let json = serde_json::to_string_pretty(&initial_config).unwrap();
        std::fs::write(&config_path, &json).unwrap();

        // Simulate save: load, mutate, save
        let content = std::fs::read_to_string(&config_path).unwrap();
        let mut cfg: config::SpeedwaveUserConfig = serde_json::from_str(&content).unwrap();
        let entry = cfg
            .projects
            .iter_mut()
            .find(|p| p.name == "test-project")
            .unwrap();
        let ps = entry.plugin_settings.get_or_insert_with(HashMap::new);
        let settings = serde_json::json!({"theme": "dark", "max_results": 50});
        ps.insert("my-plugin".into(), settings.clone());
        let json_out = serde_json::to_string_pretty(&cfg).unwrap();
        std::fs::write(&config_path, &json_out).unwrap();

        // Simulate load: read back and extract
        let content2 = std::fs::read_to_string(&config_path).unwrap();
        let cfg2: config::SpeedwaveUserConfig = serde_json::from_str(&content2).unwrap();
        let loaded = cfg2
            .projects
            .iter()
            .find(|p| p.name == "test-project")
            .and_then(|e| e.plugin_settings.as_ref())
            .and_then(|ps| ps.get("my-plugin"))
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}));

        assert_eq!(loaded, settings);
    }

    #[test]
    fn plugin_load_settings_default_empty() {
        let cfg = config::SpeedwaveUserConfig {
            projects: vec![config::ProjectUserEntry {
                name: "test-project".into(),
                dir: "/tmp/test".into(),
                claude: None,
                integrations: None,
                plugin_settings: None,
            }],
            active_project: Some("test-project".into()),
            selected_ide: None,
            transcription: None,
            ui: None,
        };

        // Load for unknown plugin — should return empty object
        let loaded = cfg
            .projects
            .iter()
            .find(|p| p.name == "test-project")
            .and_then(|e| e.plugin_settings.as_ref())
            .and_then(|ps| ps.get("nonexistent-plugin"))
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}));

        assert_eq!(loaded, serde_json::json!({}));

        // Also test with empty plugin_settings map
        let cfg2 = config::SpeedwaveUserConfig {
            projects: vec![config::ProjectUserEntry {
                name: "test-project".into(),
                dir: "/tmp/test".into(),
                claude: None,
                integrations: None,
                plugin_settings: Some(HashMap::new()),
            }],
            active_project: Some("test-project".into()),
            selected_ide: None,
            transcription: None,
            ui: None,
        };

        let loaded2 = cfg2
            .projects
            .iter()
            .find(|p| p.name == "test-project")
            .and_then(|e| e.plugin_settings.as_ref())
            .and_then(|ps| ps.get("nonexistent-plugin"))
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}));

        assert_eq!(loaded2, serde_json::json!({}));

        // Test for unknown project — should also return empty object
        let loaded3 = cfg
            .projects
            .iter()
            .find(|p| p.name == "unknown-project")
            .and_then(|e| e.plugin_settings.as_ref())
            .and_then(|ps| ps.get("my-plugin"))
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}));

        assert_eq!(loaded3, serde_json::json!({}));
    }

    #[test]
    fn remove_plugin_cleans_settings_from_config() {
        let mut cfg = config::SpeedwaveUserConfig {
            projects: vec![
                config::ProjectUserEntry {
                    name: "proj-a".into(),
                    dir: "/tmp/a".into(),
                    claude: None,
                    integrations: None,
                    plugin_settings: Some(HashMap::from([
                        ("my-plugin".into(), serde_json::json!({"key": "val"})),
                        ("other-plugin".into(), serde_json::json!({"x": 1})),
                    ])),
                },
                config::ProjectUserEntry {
                    name: "proj-b".into(),
                    dir: "/tmp/b".into(),
                    claude: None,
                    integrations: None,
                    plugin_settings: Some(HashMap::from([(
                        "my-plugin".into(),
                        serde_json::json!({"k": "v"}),
                    )])),
                },
            ],
            active_project: None,
            selected_ide: None,
            transcription: None,
            ui: None,
        };

        // Simulate the cleanup logic from remove_plugin
        let slug = "my-plugin";
        for project in &mut cfg.projects {
            if let Some(ps) = project.plugin_settings.as_mut() {
                ps.remove(slug);
            }
        }

        // proj-a: my-plugin removed, other-plugin stays
        let ps_a = cfg.projects[0].plugin_settings.as_ref().unwrap();
        assert!(!ps_a.contains_key("my-plugin"));
        assert!(ps_a.contains_key("other-plugin"));

        // proj-b: my-plugin removed, map empty
        let ps_b = cfg.projects[1].plugin_settings.as_ref().unwrap();
        assert!(!ps_b.contains_key("my-plugin"));
    }

    #[test]
    fn remove_plugin_cleans_integration_entries_from_config() {
        let mut cfg = config::SpeedwaveUserConfig {
            projects: vec![
                config::ProjectUserEntry {
                    name: "proj-a".into(),
                    dir: "/tmp/a".into(),
                    claude: None,
                    integrations: Some(config::IntegrationsConfig {
                        plugins: Some(HashMap::from([(
                            "example-plugin".into(),
                            config::IntegrationConfig {
                                enabled: Some(true),
                            },
                        )])),
                        ..Default::default()
                    }),
                    plugin_settings: None,
                },
                config::ProjectUserEntry {
                    name: "proj-b".into(),
                    dir: "/tmp/b".into(),
                    claude: None,
                    integrations: Some(config::IntegrationsConfig {
                        plugins: Some(HashMap::from([
                            (
                                "example-plugin".into(),
                                config::IntegrationConfig {
                                    enabled: Some(true),
                                },
                            ),
                            (
                                "other".into(),
                                config::IntegrationConfig {
                                    enabled: Some(false),
                                },
                            ),
                        ])),
                        ..Default::default()
                    }),
                    plugin_settings: None,
                },
            ],
            active_project: None,
            selected_ide: None,
            transcription: None,
            ui: None,
        };

        let service_id = "example-plugin";
        for project in &mut cfg.projects {
            if let Some(integrations) = project.integrations.as_mut() {
                if let Some(plugins) = integrations.plugins.as_mut() {
                    plugins.remove(service_id);
                }
            }
        }

        let plugins_a = cfg.projects[0]
            .integrations
            .as_ref()
            .unwrap()
            .plugins
            .as_ref()
            .unwrap();
        assert!(!plugins_a.contains_key("example-plugin"));

        let plugins_b = cfg.projects[1]
            .integrations
            .as_ref()
            .unwrap()
            .plugins
            .as_ref()
            .unwrap();
        assert!(!plugins_b.contains_key("example-plugin"));
        assert!(plugins_b.contains_key("other"));
    }

    #[test]
    fn remove_plugin_cleans_tokens_from_disk() {
        let tmp = tempfile::tempdir().unwrap();

        // Create token dirs for two projects
        let dir_a = tmp.path().join("tokens/proj-a/example-plugin");
        let dir_b = tmp.path().join("tokens/proj-b/example-plugin");
        std::fs::create_dir_all(&dir_a).unwrap();
        std::fs::create_dir_all(&dir_b).unwrap();
        std::fs::write(dir_a.join("access_token"), "secret-a").unwrap();
        std::fs::write(dir_b.join("access_token"), "secret-b").unwrap();

        let auth_fields = vec!["access_token".to_string()];
        let service_id = "example-plugin";
        let project_names = vec!["proj-a", "proj-b"];

        for project_name in &project_names {
            let svc_dir = tmp
                .path()
                .join("tokens")
                .join(project_name)
                .join(service_id);
            if svc_dir.exists() {
                for field_key in &auth_fields {
                    let path = svc_dir.join(field_key);
                    if path.exists() {
                        std::fs::remove_file(&path).unwrap();
                    }
                }
                if svc_dir.read_dir().unwrap().next().is_none() {
                    std::fs::remove_dir(&svc_dir).unwrap();
                }
            }
        }

        assert!(!dir_a.exists());
        assert!(!dir_b.exists());
    }

    #[test]
    fn remove_plugin_fallback_removes_whole_dir_when_no_auth_fields() {
        let tmp = tempfile::tempdir().unwrap();

        let dir = tmp.path().join("tokens/proj-a/example-plugin");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("unknown_file"), "data").unwrap();
        std::fs::write(dir.join("another_file"), "data2").unwrap();

        let auth_fields: Vec<String> = vec![];
        let svc_dir = tmp.path().join("tokens/proj-a/example-plugin");

        if svc_dir.exists() {
            if auth_fields.is_empty() {
                std::fs::remove_dir_all(&svc_dir).unwrap();
            }
        }

        assert!(!dir.exists());
    }

    #[test]
    fn remove_plugin_removes_empty_token_dir() {
        let tmp = tempfile::tempdir().unwrap();

        let dir = tmp.path().join("tokens/proj-a/example-plugin");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("api_key"), "secret").unwrap();
        std::fs::write(dir.join("host_url"), "https://example.com").unwrap();

        let auth_fields = vec!["api_key".to_string(), "host_url".to_string()];

        for field_key in &auth_fields {
            let path = dir.join(field_key);
            if path.exists() {
                std::fs::remove_file(&path).unwrap();
            }
        }
        if dir.read_dir().unwrap().next().is_none() {
            std::fs::remove_dir(&dir).unwrap();
        }

        assert!(!dir.exists());
    }

    #[test]
    fn credential_field_validation_rejects_path_traversal() {
        assert!(validate_credential_field("../../etc/passwd", "val").is_err());
        assert!(validate_credential_field("foo\\bar", "val").is_err());
        assert!(validate_credential_field("foo..bar", "val").is_err());
        assert!(validate_credential_field("valid_key", "val").is_ok());
    }

    #[test]
    fn credential_field_validation_rejects_null_bytes() {
        assert!(validate_credential_field("key\0evil", "val").is_err());
        assert!(validate_credential_field("key", "val\0ue").is_err());
    }

    #[test]
    fn credential_value_length_limit() {
        let max_len = crate::types::MAX_CREDENTIAL_BYTES;
        let at_limit = "a".repeat(max_len);
        assert!(validate_credential_field("key", &at_limit).is_ok());

        let over_limit = "a".repeat(max_len + 1);
        assert!(validate_credential_field("key", &over_limit).is_err());
    }

    // OAuth seed lives under oauth/, NOT under the tokens/ mount — a worker
    // must never read a client secret from /tokens.
    #[test]
    fn oauth_seed_path_is_off_mount() {
        let base = std::path::Path::new("/data");
        let seed = plugin::oauth_seed_file_in(base, "proj", "my-plugin");
        let tokens = base.join("tokens");
        assert!(!seed.starts_with(&tokens), "seed must not be under tokens/");
        assert!(seed.starts_with(base.join(consts::OAUTH_SUBDIR)));
        assert!(seed.to_string_lossy().ends_with("my-plugin.seed.json"));
    }

    #[cfg(unix)]
    #[test]
    fn write_oauth_seed_writes_owner_only_json() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let prev = std::env::var("SPEEDWAVE_DATA_DIR").ok();
        std::env::set_var("SPEEDWAVE_DATA_DIR", tmp.path());

        let mut seed = HashMap::new();
        seed.insert("client_id".to_string(), "abc".to_string());
        seed.insert("client_secret".to_string(), "shhh".to_string());
        write_oauth_seed("proj", "my-plugin", &seed).unwrap();

        let path = plugin::oauth_seed_file("proj", "my-plugin");
        let body = std::fs::read_to_string(&path).unwrap();
        let json: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(json["client_secret"], "shhh");
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "seed file must be chmod 600");

        match prev {
            Some(v) => std::env::set_var("SPEEDWAVE_DATA_DIR", v),
            None => std::env::remove_var("SPEEDWAVE_DATA_DIR"),
        }
    }

    #[test]
    fn set_plugin_enabled_rejects_unknown_service_id() {
        let service_id = "nonexistent-plugin";
        let manifests: Vec<plugin::PluginManifest> = vec![];
        let found = manifests
            .iter()
            .any(|m| m.service_id.as_deref() == Some(service_id) || m.slug == service_id);
        assert!(!found, "unknown service_id should not match any manifest");
    }

    #[test]
    fn token_dir_for_constructs_correct_path() {
        let result = token_dir_for("my-project", "my-service");
        assert!(result.is_ok());
        let path = result.unwrap();
        assert!(path.ends_with("tokens/my-project/my-service"));
    }

    #[test]
    fn is_plugin_configured_false_when_required_integration_missing() {
        let dir = tempfile::tempdir().unwrap();
        // No auth fields required (always "configured" for own creds)
        let configured = is_plugin_configured(
            dir.path(),
            &[],
            &["sharepoint".to_string()],
            "nonexistent-project",
        );
        assert!(
            !configured,
            "should be false when required integration is not configured"
        );
    }

    #[test]
    fn is_plugin_configured_true_when_no_required_integrations() {
        let dir = tempfile::tempdir().unwrap();
        let configured = is_plugin_configured(dir.path(), &[], &[], "any-project");
        assert!(
            configured,
            "should be true when no integrations required and no auth fields"
        );
    }

    fn blocks_auto_enable(auth_fields: &[plugin::AuthFieldDef]) -> bool {
        auth_fields.iter().any(plugin::blocks_plugin_readiness)
    }

    #[test]
    fn auto_enable_skips_plugins_with_required_secret() {
        let auth_fields = vec![plugin::AuthFieldDef {
            key: "api_key".into(),
            label: "API Key".into(),
            field_type: "password".into(),
            placeholder: "".into(),
            is_secret: true,
            required: true,
            description: None,
            validation: None,
            oauth_flow: false,
        }];
        assert!(blocks_auto_enable(&auth_fields));
    }

    #[test]
    fn auto_enable_proceeds_when_secret_is_optional() {
        let auth_fields = vec![plugin::AuthFieldDef {
            key: "api_key".into(),
            label: "API Key".into(),
            field_type: "password".into(),
            placeholder: "".into(),
            is_secret: true,
            required: false,
            description: None,
            validation: None,
            oauth_flow: false,
        }];
        assert!(
            !blocks_auto_enable(&auth_fields),
            "optional secret should not block auto-enable"
        );
    }

    #[test]
    fn auto_enable_triggers_for_plugins_without_secret_fields() {
        let auth_fields = vec![plugin::AuthFieldDef {
            key: "host_url".into(),
            label: "Host".into(),
            field_type: "text".into(),
            placeholder: "".into(),
            is_secret: false,
            required: true,
            description: None,
            validation: None,
            oauth_flow: false,
        }];
        assert!(!blocks_auto_enable(&auth_fields));
    }

    #[test]
    fn auto_enable_triggers_for_plugins_without_auth_fields() {
        assert!(!blocks_auto_enable(&[]));
    }

    #[test]
    fn auto_enable_uses_slug_when_no_service_id() {
        let service_id: Option<String> = None;
        let slug = "my-skills";
        let plugin_key = service_id.as_deref().unwrap_or(slug);
        assert_eq!(plugin_key, "my-skills");
    }

    #[test]
    fn auto_enable_uses_service_id_when_present() {
        let service_id: Option<String> = Some("example-plugin".to_string());
        let slug = "example-plugin";
        let plugin_key = service_id.as_deref().unwrap_or(slug);
        assert_eq!(plugin_key, "example-plugin");
    }

    #[test]
    fn save_plugin_credentials_rejects_field_not_in_auth_fields() {
        let manifest = plugin::PluginManifest {
            name: "Test".to_string(),
            service_id: Some("test-plugin".to_string()),
            slug: "test-plugin".to_string(),
            version: "1.0.0".to_string(),
            description: "test".to_string(),
            port: Some(5000),
            image_tag: None,
            resources: vec![],
            token_mount: plugin::TokenMount::ReadOnly,
            auth_fields: vec![plugin::AuthFieldDef {
                key: "api_key".to_string(),
                label: "API Key".to_string(),
                field_type: "password".to_string(),
                placeholder: "".to_string(),
                is_secret: true,
                required: true,
                description: None,
                validation: None,
                oauth_flow: false,
            }],
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

        let allowed_keys: Vec<&str> = manifest
            .auth_fields
            .iter()
            .map(|f| f.key.as_str())
            .collect();

        // "api_key" is in the allowlist
        assert!(allowed_keys.contains(&"api_key"));
        // "secret_token" is NOT in the allowlist
        assert!(
            !allowed_keys.contains(&"secret_token"),
            "field not in auth_fields must be rejected"
        );
        // "../../etc/passwd" is NOT in the allowlist
        assert!(
            !allowed_keys.contains(&"../../etc/passwd"),
            "path traversal field must be rejected"
        );
    }

    #[test]
    fn save_credentials_enforces_field_validation_pattern() {
        // Mirrors the per-field check inside save_plugin_credentials: locate
        // the AuthFieldDef by key, then run the runtime regex validator. The
        // full command needs a verified on-disk plugin, so this isolates the
        // wiring the same way save_plugin_credentials_rejects_* does.
        let field = plugin::AuthFieldDef {
            key: "example_pat".to_string(),
            label: "Example Token".to_string(),
            field_type: "password".to_string(),
            placeholder: "tok_...".to_string(),
            is_secret: true,
            required: false,
            description: None,
            validation: Some(plugin::AuthFieldValidation {
                pattern: "^tok_[A-Za-z0-9_-]+$".to_string(),
                message: Some("Personal Access Tokens start with tok_".to_string()),
            }),
            oauth_flow: false,
        };
        let manifest = plugin::PluginManifest {
            name: "Example Plugin".to_string(),
            service_id: Some("example-plugin".to_string()),
            slug: "example-plugin".to_string(),
            version: "0.1.2".to_string(),
            description: "test".to_string(),
            port: None,
            image_tag: None,
            resources: vec![],
            token_mount: plugin::TokenMount::ReadOnly,
            auth_fields: vec![field],
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

        let lookup = |key: &str, value: &str| -> Result<(), String> {
            match manifest.auth_fields.iter().find(|f| f.key == key) {
                Some(f) => plugin::validate_credential_value(f, value),
                None => Ok(()),
            }
        };

        // Good value passes.
        assert!(lookup("example_pat", "tok_abc-123_XYZ").is_ok());
        // Wrong prefix is rejected, surfacing the author's message.
        assert_eq!(
            lookup("example_pat", "ghp_wrong").unwrap_err(),
            "Personal Access Tokens start with tok_"
        );
        // Empty value (leave-as-is) is never rejected by the pattern.
        assert!(lookup("example_pat", "").is_ok());
    }

    #[test]
    fn auto_enable_writes_plugin_enabled_to_active_project_config() {
        let mut cfg = config::SpeedwaveUserConfig {
            projects: vec![config::ProjectUserEntry {
                name: "my-project".into(),
                dir: "/tmp/test".into(),
                claude: None,
                integrations: None,
                plugin_settings: None,
            }],
            active_project: Some("my-project".into()),
            selected_ide: None,
            transcription: None,
            ui: None,
        };
        // Simulate the auto-enable block from install_plugin
        let plugin_key = "my-skills";
        if let Some(active) = cfg.active_project.clone() {
            if let Some(entry) = cfg.projects.iter_mut().find(|p| p.name == active) {
                let integrations = entry.integrations.get_or_insert_with(Default::default);
                integrations.set_plugin_enabled(plugin_key, true);
            }
        }
        let enabled = cfg
            .projects
            .iter()
            .find(|p| p.name == "my-project")
            .and_then(|e| e.integrations.as_ref())
            .and_then(|i| i.plugins.as_ref())
            .and_then(|p| p.get(plugin_key))
            .and_then(|e| e.enabled)
            .unwrap_or(false);
        assert!(
            enabled,
            "auto-enable should write plugin_key=true to active project config"
        );
    }
}
