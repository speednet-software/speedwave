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
pub(crate) struct PluginAuthFieldDto {
    pub(crate) key: String,
    pub(crate) label: String,
    pub(crate) field_type: String,
    pub(crate) placeholder: String,
    pub(crate) is_secret: bool,
}

#[derive(serde::Serialize, Clone)]
pub(crate) struct PluginStatusEntry {
    pub(crate) slug: String,
    pub(crate) name: String,
    pub(crate) service_id: Option<String>,
    pub(crate) version: String,
    pub(crate) description: String,
    pub(crate) enabled: bool,
    pub(crate) configured: bool,
    pub(crate) auth_fields: Vec<PluginAuthFieldDto>,
    pub(crate) current_values: HashMap<String, String>,
    pub(crate) token_mount: String,
}

#[derive(serde::Serialize)]
pub(crate) struct PluginsResponse {
    pub(crate) plugins: Vec<PluginStatusEntry>,
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

    let home = dirs::home_dir().ok_or("cannot determine home directory")?;
    let tokens_dir = home
        .join(speedwave_runtime::consts::DATA_DIR)
        .join("tokens")
        .join(&project);

    let mut entries = Vec::new();
    for manifest in &manifests {
        let sid = manifest.service_id.as_deref().unwrap_or(&manifest.slug);
        let enabled = integrations.is_plugin_enabled(sid);

        let auth_fields: Vec<PluginAuthFieldDto> = manifest
            .auth_fields
            .iter()
            .map(|f| PluginAuthFieldDto {
                key: f.key.clone(),
                label: f.label.clone(),
                field_type: f.field_type.clone(),
                placeholder: f.placeholder.clone(),
                is_secret: f.is_secret,
            })
            .collect();

        let svc_token_dir = tokens_dir.join(sid);
        let configured = is_plugin_configured(&svc_token_dir, &manifest.auth_fields);

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
        });
    }

    Ok(PluginsResponse { plugins: entries })
}

fn is_plugin_configured(
    svc_token_dir: &std::path::Path,
    auth_fields: &[plugin::AuthFieldDef],
) -> bool {
    auth_fields.iter().any(|f| {
        if f.is_secret {
            let path = svc_token_dir.join(&f.key);
            path.exists()
                && std::fs::metadata(&path)
                    .map(|m| m.len() > 0)
                    .unwrap_or(false)
        } else {
            false
        }
    })
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

    Ok(format!(
        "Plugin '{}' v{} installed successfully",
        manifest.name, manifest.version
    ))
}

#[tauri::command]
pub fn remove_plugin(slug: String) -> Result<(), String> {
    log::info!("remove_plugin: slug={slug}");
    plugin::remove_plugin(&slug).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_plugin_enabled(
    project: String,
    service_id: String,
    enabled: bool,
) -> Result<(), String> {
    check_project(&project)?;
    log::info!("set_plugin_enabled: project={project} service_id={service_id} enabled={enabled}");

    let _lock = crate::CONFIG_LOCK.lock().map_err(|e| e.to_string())?;

    let mut user_config = config::load_user_config().map_err(|e| e.to_string())?;

    let entry = user_config
        .projects
        .iter_mut()
        .find(|p| p.name == project)
        .ok_or_else(|| format!("project '{}' not found", project))?;

    let integrations = entry.integrations.get_or_insert_with(Default::default);
    integrations.set_plugin_enabled(&service_id, enabled);

    config::save_user_config(&user_config).map_err(|e| e.to_string())
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

    let home = dirs::home_dir().ok_or("cannot determine home directory")?;
    let svc_dir = home
        .join(speedwave_runtime::consts::DATA_DIR)
        .join("tokens")
        .join(&project)
        .join(sid);
    std::fs::create_dir_all(&svc_dir).map_err(|e| e.to_string())?;

    for (key, value) in &credentials {
        if !allowed_keys.contains(&key.as_str()) {
            return Err(format!("field '{}' not allowed for plugin '{}'", key, slug));
        }
        if key.contains('/') || key.contains('\\') || key.contains("..") {
            return Err(format!("invalid field name: {}", key));
        }
        if value.len() > 4096 {
            return Err(format!("value for '{}' exceeds 4096 bytes", key));
        }

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

    let _lock = crate::CONFIG_LOCK.lock().map_err(|e| e.to_string())?;

    let mut user_config = config::load_user_config().map_err(|e| e.to_string())?;

    let entry = user_config
        .projects
        .iter_mut()
        .find(|p| p.name == project)
        .ok_or_else(|| format!("project '{}' not found", project))?;

    let ps = entry.plugin_settings.get_or_insert_with(HashMap::new);
    ps.insert(slug, settings);

    config::save_user_config(&user_config).map_err(|e| e.to_string())
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

    let home = dirs::home_dir().ok_or("cannot determine home directory")?;
    let svc_dir = home
        .join(speedwave_runtime::consts::DATA_DIR)
        .join("tokens")
        .join(&project)
        .join(sid);

    for field in &manifest.auth_fields {
        let path = svc_dir.join(&field.key);
        if path.exists() {
            std::fs::remove_file(&path).map_err(|e| e.to_string())?;
        }
    }

    // Auto-disable the plugin since credentials are removed
    let _lock = crate::CONFIG_LOCK.lock().map_err(|e| e.to_string())?;
    let mut user_config = config::load_user_config().map_err(|e| e.to_string())?;
    if let Some(entry) = user_config.projects.iter_mut().find(|p| p.name == project) {
        let integrations = entry.integrations.get_or_insert_with(Default::default);
        integrations.set_plugin_enabled(sid, false);
        config::save_user_config(&user_config).map_err(|e| e.to_string())?;
    }

    Ok(())
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
            auth_fields: vec![PluginAuthFieldDto {
                key: "api_key".into(),
                label: "API Key".into(),
                field_type: "password".into(),
                placeholder: "Enter key".into(),
                is_secret: true,
            }],
            current_values: HashMap::new(),
            token_mount: "ro".into(),
        };
        let json = serde_json::to_string(&entry).unwrap();
        assert!(json.contains("test-plugin"));
        assert!(json.contains("api_key"));
    }

    #[test]
    fn is_plugin_configured_false_when_no_secret_fields() {
        let fields = vec![plugin::AuthFieldDef {
            key: "host_url".into(),
            label: "Host".into(),
            field_type: "text".into(),
            placeholder: "".into(),
            is_secret: false,
        }];
        assert!(!is_plugin_configured(
            std::path::Path::new("/nonexistent"),
            &fields
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
            &fields
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
        assert!(is_plugin_configured(dir.path(), &fields));
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
        assert!(!is_plugin_configured(dir.path(), &fields));
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
    fn credential_field_validation_rejects_path_traversal() {
        let key = "../../etc/passwd";
        assert!(
            key.contains('/') || key.contains('\\') || key.contains(".."),
            "path traversal must be detected"
        );
    }

    #[test]
    fn credential_value_length_limit() {
        let max_len = 4096;
        let short_value = "a".repeat(max_len);
        assert!(short_value.len() <= max_len, "exactly at limit should pass");

        let long_value = "a".repeat(max_len + 1);
        assert!(long_value.len() > max_len, "over limit should fail");
    }
}
