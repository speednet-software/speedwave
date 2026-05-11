// Plugin management commands — Tauri backend for the Plugins UI.
//
// All `#[tauri::command]` functions here are registered in the main
// `generate_handler!` macro via their fully-qualified paths.

use crate::types::check_project;
use speedwave_runtime::config;
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
    pub(crate) enabled: bool,
    pub(crate) configured: bool,
    pub(crate) auth_fields: Vec<plugin::AuthFieldDef>,
    pub(crate) current_values: HashMap<String, String>,
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
                enabled: false,
                configured: false,
                auth_fields: Vec::new(),
                current_values: HashMap::new(),
                token_mount: "ro".to_string(),
                settings_schema: None,
                requires_integrations: Vec::new(),
                verification_status: ui.verification_status.clone(),
                verification_error: ui.verification_error.clone(),
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
        for field in &manifest.auth_fields {
            if field.is_secret {
                continue;
            }
            let path = svc_token_dir.join(&field.key);
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
            enabled,
            configured,
            auth_fields,
            current_values,
            token_mount,
            settings_schema: manifest.settings_schema.clone(),
            requires_integrations: manifest.requires_integrations.clone(),
            verification_status: ui.verification_status.clone(),
            verification_error: ui.verification_error.clone(),
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
    let secret_fields: Vec<_> = auth_fields.iter().filter(|f| f.is_secret).collect();
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
        plugin::install_plugin(&path, Some(&*rt), &mut |progress| {
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

    // Auto-enable only when image is ready. MCP plugins with auth_fields are
    // auto-enabled after credential save in the UI.
    let should_auto_enable = matches!(outcome, plugin::InstallOutcome::Installed(_))
        && !manifest.auth_fields.iter().any(|f| f.is_secret);
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
    let rt_ref: Option<&dyn speedwave_runtime::runtime::ContainerRuntime> =
        if rt.is_available() { Some(&*rt) } else { None };
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

    for (key, value) in &credentials {
        if !allowed_keys.contains(&key.as_str()) {
            return Err(format!("field '{}' not allowed for plugin '{}'", key, slug));
        }
        validate_credential_field(key, value)?;

        let file_path = svc_dir.join(key);
        std::fs::write(&file_path, value).map_err(|e| e.to_string())?;
        crate::fs_perms::set_owner_only(&file_path)?;
    }

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
    // user_config.json. 64 KiB is generous — settings are key/value
    // metadata, not arbitrary blobs.
    const SETTINGS_MAX_BYTES: usize = 64 * 1024;
    let serialised = serde_json::to_vec(&settings).map_err(|e| e.to_string())?;
    if serialised.len() > SETTINGS_MAX_BYTES {
        return Err(format!(
            "plugin '{}' settings exceed {} bytes",
            slug, SETTINGS_MAX_BYTES
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
        let svc_canon = svc_dir.canonicalize().map_err(|e| e.to_string())?;
        for key in &keys {
            let path = svc_dir.join(key);
            // Path-traversal guard: canonicalise and confirm it stays
            // inside the service token dir before unlinking.
            match path.canonicalize() {
                Ok(canon) if canon.starts_with(&svc_canon) => {
                    std::fs::remove_file(&canon).map_err(|e| e.to_string())?;
                }
                Ok(canon) => {
                    return Err(format!(
                        "refusing to delete '{}': resolves outside the plugin's token dir",
                        canon.display()
                    ));
                }
                Err(_) => { /* file doesn't exist — nothing to delete */ }
            }
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
            enabled: true,
            configured: false,
            auth_fields: vec![plugin::AuthFieldDef {
                key: "api_key".into(),
                label: "API Key".into(),
                field_type: "password".into(),
                placeholder: "Enter key".into(),
                is_secret: true,
            }],
            current_values: HashMap::new(),
            token_mount: "ro".into(),
            settings_schema: None,
            requires_integrations: vec![],
            verification_status: plugin::VerificationStatus::Verified,
            verification_error: None,
        };
        let json = serde_json::to_string(&entry).unwrap();
        assert!(json.contains("test-plugin"));
        assert!(json.contains("api_key"));
        // The Angular frontend's `PluginVerificationStatus` union depends
        // on the snake_case wire literals — pin one here so a mis-annotated
        // `VerificationStatus` enum (e.g. PascalCase) is caught.
        assert!(json.contains(r#""verification_status":"verified""#));
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
            slug: "presale".into(),
            name: "Presale CRM".into(),
            service_id: Some("presale".into()),
            version: "1.2.0".into(),
            description: "CRM integration".into(),
            enabled: true,
            configured: true,
            auth_fields: vec![],
            current_values: HashMap::new(),
            token_mount: "ro".into(),
            settings_schema: Some(schema),
            requires_integrations: vec!["sharepoint".into()],
            verification_status: plugin::VerificationStatus::Verified,
            verification_error: None,
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
        super::validate_settings_against_schema("presale", &schema, &payload)
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
        let err = super::validate_settings_against_schema("presale", &schema, &bad_enum)
            .expect_err("off-enum value must be rejected");
        assert!(err.contains("do not match its schema"), "got: {err}");

        // Wrong type.
        let bad_type = serde_json::json!({ "currency": 42 });
        let err = super::validate_settings_against_schema("presale", &schema, &bad_type)
            .expect_err("wrong-type value must be rejected");
        assert!(err.contains("do not match its schema"), "got: {err}");

        // Missing required field.
        let missing = serde_json::json!({});
        let err = super::validate_settings_against_schema("presale", &schema, &missing)
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
        let err = super::validate_settings_against_schema("presale", &bogus_schema, &payload)
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
        }];
        assert!(!is_plugin_configured(
            dir.path(),
            &fields,
            &[],
            "any-project"
        ));
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
            log_level: None,
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
            log_level: None,
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
            log_level: None,
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
            log_level: None,
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
                            "presale".into(),
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
                                "presale".into(),
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
            log_level: None,
        };

        let service_id = "presale";
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
        assert!(!plugins_a.contains_key("presale"));

        let plugins_b = cfg.projects[1]
            .integrations
            .as_ref()
            .unwrap()
            .plugins
            .as_ref()
            .unwrap();
        assert!(!plugins_b.contains_key("presale"));
        assert!(plugins_b.contains_key("other"));
    }

    #[test]
    fn remove_plugin_cleans_tokens_from_disk() {
        let tmp = tempfile::tempdir().unwrap();

        // Create token dirs for two projects
        let dir_a = tmp.path().join("tokens/proj-a/presale");
        let dir_b = tmp.path().join("tokens/proj-b/presale");
        std::fs::create_dir_all(&dir_a).unwrap();
        std::fs::create_dir_all(&dir_b).unwrap();
        std::fs::write(dir_a.join("access_token"), "secret-a").unwrap();
        std::fs::write(dir_b.join("access_token"), "secret-b").unwrap();

        let auth_fields = vec!["access_token".to_string()];
        let service_id = "presale";
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

        let dir = tmp.path().join("tokens/proj-a/presale");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("unknown_file"), "data").unwrap();
        std::fs::write(dir.join("another_file"), "data2").unwrap();

        let auth_fields: Vec<String> = vec![];
        let svc_dir = tmp.path().join("tokens/proj-a/presale");

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

        let dir = tmp.path().join("tokens/proj-a/presale");
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

    #[test]
    fn auto_enable_skips_plugins_needing_credentials() {
        let auth_fields = vec![plugin::AuthFieldDef {
            key: "api_key".into(),
            label: "API Key".into(),
            field_type: "password".into(),
            placeholder: "".into(),
            is_secret: true,
        }];
        let needs_credentials = auth_fields.iter().any(|f| f.is_secret);
        assert!(
            needs_credentials,
            "plugin with secret auth_field needs credentials"
        );
    }

    #[test]
    fn auto_enable_triggers_for_plugins_without_secret_fields() {
        let auth_fields: Vec<plugin::AuthFieldDef> = vec![plugin::AuthFieldDef {
            key: "host_url".into(),
            label: "Host".into(),
            field_type: "text".into(),
            placeholder: "".into(),
            is_secret: false,
        }];
        let needs_credentials = auth_fields.iter().any(|f| f.is_secret);
        assert!(
            !needs_credentials,
            "plugin with only non-secret fields should auto-enable"
        );
    }

    #[test]
    fn auto_enable_triggers_for_plugins_without_auth_fields() {
        let auth_fields: Vec<plugin::AuthFieldDef> = vec![];
        let needs_credentials = auth_fields.iter().any(|f| f.is_secret);
        assert!(
            !needs_credentials,
            "plugin with no auth_fields should auto-enable"
        );
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
        let service_id: Option<String> = Some("presale".to_string());
        let slug = "presale";
        let plugin_key = service_id.as_deref().unwrap_or(slug);
        assert_eq!(plugin_key, "presale");
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
            }],
            settings_schema: None,
            speedwave_compat: None,
            extra_env: None,
            mem_limit: None,
            cpu_limit: None,
            requires_integrations: vec![],
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
            log_level: None,
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
