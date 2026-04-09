// Plugin management commands — Tauri backend for the Plugins UI.
//
// All `#[tauri::command]` functions here are registered in the main
// `generate_handler!` macro via their fully-qualified paths.

use crate::types::check_project;
use speedwave_runtime::config;
use speedwave_runtime::plugin;
use std::collections::HashMap;

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

    let manifests = plugin::list_installed_plugins().map_err(|e| e.to_string())?;

    let mut entries = Vec::new();
    for manifest in &manifests {
        let sid = manifest.service_id.as_deref().unwrap_or(&manifest.slug);
        let enabled = integrations.is_plugin_enabled(sid);

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

#[tauri::command]
pub fn install_plugin(zip_path: String) -> Result<String, String> {
    log::info!("install_plugin: zip_path={zip_path}");
    let path = std::path::Path::new(&zip_path);
    if !path.exists() {
        return Err(format!("File not found: {}", zip_path));
    }

    let rt = speedwave_runtime::runtime::detect_runtime();
    let manifest = plugin::install_plugin(path, Some(&*rt)).map_err(|e| e.to_string())?;

    // Auto-enable plugins that need no credentials (resource-only or no auth_fields).
    // MCP plugins with auth_fields are auto-enabled after credential save in the UI.
    let needs_credentials = manifest.auth_fields.iter().any(|f| f.is_secret);
    if !needs_credentials {
        let plugin_key = manifest.service_id.as_deref().unwrap_or(&manifest.slug);
        config::with_config_lock(|| {
            let mut cfg = config::load_user_config()?;
            if let Some(active) = cfg.active_project.clone() {
                if let Some(entry) = cfg.projects.iter_mut().find(|p| p.name == active) {
                    let integrations = entry.integrations.get_or_insert_with(Default::default);
                    integrations.set_plugin_enabled(plugin_key, true);
                    config::save_user_config(&cfg)?;
                }
            }
            Ok(())
        })
        .map_err(|e| e.to_string())?;
    }

    Ok(format!(
        "Plugin '{}' v{} installed successfully",
        manifest.name, manifest.version
    ))
}

#[tauri::command]
pub fn remove_plugin(slug: String) -> Result<(), String> {
    log::info!("remove_plugin: slug={slug}");

    // Read manifest BEFORE deleting plugin files — need service_id, auth_fields
    let manifests = plugin::list_installed_plugins().map_err(|e| e.to_string())?;
    let manifest = manifests.iter().find(|m| m.slug == slug);
    let service_id = manifest
        .and_then(|m| m.service_id.as_deref())
        .map(|s| s.to_string())
        .unwrap_or_else(|| slug.clone());
    let auth_fields: Vec<String> = manifest
        .map(|m| m.auth_fields.iter().map(|f| f.key.clone()).collect())
        .unwrap_or_default();

    // Delete plugin files from ~/.speedwave/plugins/<slug>/
    plugin::remove_plugin(&slug).map_err(|e| e.to_string())?;

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

    // Validate that service_id corresponds to an installed plugin
    let manifests = plugin::list_installed_plugins().map_err(|e| e.to_string())?;
    let found = manifests
        .iter()
        .any(|m| m.service_id.as_deref() == Some(&service_id) || m.slug == service_id);
    if !found {
        return Err(format!(
            "no installed plugin with service_id '{}'",
            service_id
        ));
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

    let manifests = plugin::list_installed_plugins().map_err(|e| e.to_string())?;
    let manifest = manifests
        .iter()
        .find(|m| m.slug == slug)
        .ok_or_else(|| format!("plugin '{}' not found", slug))?;

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

#[tauri::command]
pub fn plugin_load_settings(project: String, slug: String) -> Result<serde_json::Value, String> {
    check_project(&project)?;
    log::info!("plugin_load_settings: project={project} slug={slug}");

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

    let manifests = plugin::list_installed_plugins().map_err(|e| e.to_string())?;
    let manifest = manifests
        .iter()
        .find(|m| m.slug == slug)
        .ok_or_else(|| format!("plugin '{}' not found", slug))?;

    let sid = manifest.service_id.as_deref().unwrap_or(&manifest.slug);

    // Delete token files (no config lock needed for filesystem ops)
    let svc_dir = token_dir_for(&project, sid)?;
    for field in &manifest.auth_fields {
        let path = svc_dir.join(&field.key);
        if path.exists() {
            std::fs::remove_file(&path).map_err(|e| e.to_string())?;
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
        };
        let json = serde_json::to_string(&entry).unwrap();
        assert!(json.contains("test-plugin"));
        assert!(json.contains("api_key"));
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
        };
        let json = serde_json::to_string(&entry).unwrap();
        assert!(json.contains("settings_schema"));
        assert!(json.contains("currency"));
        assert!(json.contains("PLN"));
        assert!(json.contains("requires_integrations"));
        assert!(json.contains("sharepoint"));
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
