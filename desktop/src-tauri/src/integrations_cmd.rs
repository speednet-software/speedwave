// Integration management commands — extracted from main.rs for clarity.
//
// All `#[tauri::command]` functions here are registered in the main
// `generate_handler!` macro via their fully-qualified paths.

use crate::types::{
    check_project, get_allowed_fields, get_auth_fields, is_secret_field, IntegrationStatusEntry,
    IntegrationsResponse, OsIntegrationStatusEntry,
};
use speedwave_runtime::config;

/// Returns the field keys that Redmine stores in config.json (derived from SSOT in consts).
fn redmine_config_json_fields() -> Vec<&'static str> {
    speedwave_runtime::consts::find_mcp_service("redmine")
        .map(|svc| {
            svc.auth_fields
                .iter()
                .filter(|f| f.stored_in_config_json)
                .map(|f| f.key)
                .collect()
        })
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Redmine helpers — Redmine stores host_url, project_id, and project_name
// inside a single config.json file rather than as individual credential files.
// These helpers isolate that difference so the generic handlers stay clean.
// ---------------------------------------------------------------------------

/// Reads and parses Redmine's config.json. Returns an empty JSON object
/// on missing or unreadable files.
fn read_redmine_config(svc_token_dir: &std::path::Path) -> serde_json::Value {
    let config_path = svc_token_dir.join("config.json");
    std::fs::read_to_string(&config_path)
        .ok()
        .and_then(|content| serde_json::from_str::<serde_json::Value>(&content).ok())
        .unwrap_or_else(|| serde_json::json!({}))
}

/// Reads current values for Redmine-specific fields from config.json and
/// extracts mappings. Called by `get_integrations` for the redmine service.
fn read_redmine_current_values(
    svc_token_dir: &std::path::Path,
    auth_fields: &[crate::types::AuthField],
) -> (
    std::collections::HashMap<String, String>,
    Option<std::collections::HashMap<String, serde_json::Value>>,
) {
    let config_json = read_redmine_config(svc_token_dir);

    let mut current_values = std::collections::HashMap::new();
    for field in auth_fields {
        if is_secret_field(&field.key) {
            continue;
        }
        if redmine_config_json_fields().contains(&field.key.as_str()) {
            if let Some(val) = config_json.get(&field.key).and_then(|v| v.as_str()) {
                current_values.insert(field.key.clone(), val.to_string());
            }
        } else {
            let path = svc_token_dir.join(&field.key);
            if let Ok(content) = std::fs::read_to_string(&path) {
                let trimmed = content.trim().to_string();
                if !trimmed.is_empty() {
                    current_values.insert(field.key.clone(), trimmed);
                }
            }
        }
    }

    let mappings = config_json
        .get("mappings")
        .cloned()
        .and_then(|m| serde_json::from_value(m).ok());

    (current_values, mappings)
}

/// Saves Redmine credentials: secret fields go to individual files,
/// config fields (host_url, project_id, project_name) go into config.json.
fn save_redmine_credentials(
    svc_dir: &std::path::Path,
    credentials: &std::collections::HashMap<String, String>,
    allowed: &[&str],
) -> Result<(), String> {
    let has_config_fields = credentials
        .keys()
        .any(|k| redmine_config_json_fields().contains(&k.as_str()));

    let config_path = svc_dir.join("config.json");
    let mut config_obj = if has_config_fields {
        if let Ok(content) = std::fs::read_to_string(&config_path) {
            serde_json::from_str::<serde_json::Value>(&content)
                .map_err(|e| format!("existing config.json is corrupted: {e}"))?
        } else {
            serde_json::json!({})
        }
    } else {
        serde_json::json!({})
    };

    for (key, value) in credentials {
        if !allowed.contains(&key.as_str()) {
            return Err(format!("field '{}' not allowed for service 'redmine'", key));
        }
        validate_credential_field(key, value)?;

        if redmine_config_json_fields().contains(&key.as_str()) {
            config_obj[key] = serde_json::Value::String(value.clone());
        } else {
            let file_path = svc_dir.join(key);
            std::fs::write(&file_path, value).map_err(|e| e.to_string())?;
            crate::fs_perms::set_owner_only(&file_path)?;
        }
    }

    if has_config_fields {
        let json = serde_json::to_string_pretty(&config_obj).map_err(|e| e.to_string())?;
        std::fs::write(&config_path, &json).map_err(|e| e.to_string())?;
        crate::fs_perms::set_owner_only(&config_path)?;
    }

    Ok(())
}

/// Validates a credential field name and value.
fn validate_credential_field(key: &str, value: &str) -> Result<(), String> {
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
pub fn get_integrations(project: String) -> Result<IntegrationsResponse, String> {
    check_project(&project)?;
    let user_config = config::load_user_config().map_err(|e| e.to_string())?;
    let project_dir = user_config
        .find_project(&project)
        .map(|p| p.dir.as_str())
        .ok_or_else(|| format!("project '{}' not found in config", project))?;
    let integrations =
        config::resolve_integrations(std::path::Path::new(project_dir), &user_config, &project);

    let home = dirs::home_dir().ok_or("cannot determine home directory")?;
    let tokens_dir = home
        .join(speedwave_runtime::consts::DATA_DIR)
        .join("tokens")
        .join(&project);

    let mut service_entries = Vec::new();

    for svc_desc in speedwave_runtime::consts::TOGGLEABLE_MCP_SERVICES {
        let svc = svc_desc.config_key;
        let display_name = svc_desc.display_name;
        let description = svc_desc.description;
        let enabled = integrations.is_service_enabled(svc).unwrap_or(false);

        let svc_token_dir = tokens_dir.join(svc);
        let auth_fields = get_auth_fields(svc);

        let configured = is_service_configured(&project, svc);

        let (current_values, mappings) = if svc == "redmine" {
            read_redmine_current_values(&svc_token_dir, &auth_fields)
        } else {
            let mut values = std::collections::HashMap::new();
            for field in &auth_fields {
                if is_secret_field(&field.key) {
                    continue;
                }
                let path = svc_token_dir.join(&field.key);
                if let Ok(content) = std::fs::read_to_string(&path) {
                    let trimmed = content.trim().to_string();
                    if !trimmed.is_empty() {
                        values.insert(field.key.clone(), trimmed);
                    }
                }
            }
            (values, None)
        };

        service_entries.push(IntegrationStatusEntry {
            service: svc.to_string(),
            enabled,
            configured,
            display_name: display_name.to_string(),
            description: description.to_string(),
            auth_fields: auth_fields.clone(),
            current_values,
            mappings,
        });
    }

    let os = if cfg!(target_os = "macos") {
        speedwave_runtime::consts::TOGGLEABLE_OS_SERVICES
            .iter()
            .map(|svc| OsIntegrationStatusEntry {
                service: svc.config_key.to_string(),
                enabled: integrations
                    .is_os_service_enabled(svc.config_key)
                    .unwrap_or(false),
                display_name: svc.display_name.to_string(),
                description: svc.description.to_string(),
            })
            .collect()
    } else {
        vec![]
    };

    Ok(IntegrationsResponse {
        services: service_entries,
        os,
    })
}

pub(crate) fn is_service_configured(project: &str, service: &str) -> bool {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return false,
    };
    let svc_token_dir = home
        .join(speedwave_runtime::consts::DATA_DIR)
        .join("tokens")
        .join(project)
        .join(service);
    let auth_fields = get_auth_fields(service);
    let secret_fields: Vec<_> = auth_fields
        .iter()
        .filter(|f| is_secret_field(&f.key))
        .collect();
    if secret_fields.is_empty() {
        return false;
    }
    secret_fields.iter().all(|f| {
        let path = svc_token_dir.join(&f.key);
        path.exists()
            && std::fs::metadata(&path)
                .map(|m| m.len() > 0)
                .unwrap_or(false)
    })
}

#[tauri::command]
pub fn set_integration_enabled(
    project: String,
    service: String,
    enabled: bool,
) -> Result<(), String> {
    check_project(&project)?;
    log::info!("set_integration_enabled: project={project} service={service} enabled={enabled}");

    if enabled && !is_service_configured(&project, &service) {
        return Err(format!("{service} has no credentials configured"));
    }

    config::with_config_lock(|| {
        let mut user_config = config::load_user_config()?;

        let entry = user_config
            .find_project_mut(&project)
            .ok_or_else(|| anyhow::anyhow!("project '{}' not found in config", project))?;

        let integrations = entry.integrations.get_or_insert_with(Default::default);
        let cfg = config::IntegrationConfig {
            enabled: Some(enabled),
        };

        if !integrations.set_service(&service, cfg) {
            return Err(anyhow::anyhow!("unknown service: {}", service));
        }

        config::save_user_config(&user_config)
    })
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_os_integration_enabled(
    project: String,
    service: String,
    enabled: bool,
) -> Result<(), String> {
    if !cfg!(target_os = "macos") {
        return Err("OS integrations are only available on macOS".to_string());
    }
    check_project(&project)?;
    log::info!("set_os_integration_enabled: project={project} service={service} enabled={enabled}");

    config::with_config_lock(|| {
        let mut user_config = config::load_user_config()?;

        let entry = user_config
            .find_project_mut(&project)
            .ok_or_else(|| anyhow::anyhow!("project '{}' not found in config", project))?;

        let integrations = entry.integrations.get_or_insert_with(Default::default);
        let os = integrations.os.get_or_insert_with(Default::default);
        let cfg = config::IntegrationConfig {
            enabled: Some(enabled),
        };

        if !os.set_service(&service, cfg) {
            return Err(anyhow::anyhow!("unknown OS service: {}", service));
        }

        config::save_user_config(&user_config)
    })
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_integration_credentials(
    project: String,
    service: String,
    credentials: std::collections::HashMap<String, String>,
) -> Result<(), String> {
    check_project(&project)?;
    log::info!("save_integration_credentials: project={project} service={service}");
    let allowed =
        get_allowed_fields(&service).ok_or_else(|| format!("unknown service: {}", service))?;

    let home = dirs::home_dir().ok_or("cannot determine home directory")?;
    let svc_dir = home
        .join(speedwave_runtime::consts::DATA_DIR)
        .join("tokens")
        .join(&project)
        .join(&service);
    std::fs::create_dir_all(&svc_dir).map_err(|e| e.to_string())?;

    // Redmine stores some fields in config.json — dispatch to dedicated handler
    if service == "redmine" {
        return save_redmine_credentials(&svc_dir, &credentials, allowed);
    }

    // Generic handler: write each credential as an individual file
    for (key, value) in &credentials {
        if !allowed.contains(&key.as_str()) {
            return Err(format!(
                "field '{}' not allowed for service '{}'",
                key, service
            ));
        }
        crate::plugin_cmd::validate_credential_field(key, value)?;

        if service == "redmine"
            && (key == "host_url" || key == "project_id" || key == "project_name")
        {
            continue;
        }

        let file_path = svc_dir.join(key);
        std::fs::write(&file_path, value).map_err(|e| e.to_string())?;
        crate::fs_perms::set_owner_only(&file_path)?;
    }

    Ok(())
}

#[tauri::command]
pub fn save_redmine_mappings(
    project: String,
    mappings: std::collections::HashMap<String, serde_json::Value>,
) -> Result<(), String> {
    check_project(&project)?;
    log::info!("save_redmine_mappings: project={project}");
    let home = dirs::home_dir().ok_or("cannot determine home directory")?;
    let config_path = home
        .join(speedwave_runtime::consts::DATA_DIR)
        .join("tokens")
        .join(&project)
        .join("redmine")
        .join("config.json");

    if let Some(parent) = config_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let mut config_obj = if let Ok(content) = std::fs::read_to_string(&config_path) {
        serde_json::from_str::<serde_json::Value>(&content)
            .map_err(|e| format!("existing config.json is corrupted: {e}"))?
    } else {
        serde_json::json!({})
    };

    for key in mappings.keys() {
        if key.contains('/') || key.contains('\\') || key.contains("..") || key.len() > 255 {
            return Err(format!("invalid mapping key: {}", key));
        }
    }

    for (key, value) in &mappings {
        if !value.is_number() && !value.is_null() {
            return Err(format!(
                "mapping value for '{}' must be a number, got: {}",
                key, value
            ));
        }
    }
    config_obj["mappings"] = serde_json::Value::Object(mappings.into_iter().collect());

    let json = serde_json::to_string_pretty(&config_obj).map_err(|e| e.to_string())?;
    std::fs::write(&config_path, &json).map_err(|e| e.to_string())?;
    crate::fs_perms::set_owner_only(&config_path)?;

    Ok(())
}

#[tauri::command]
pub fn delete_integration_credentials(project: String, service: String) -> Result<(), String> {
    check_project(&project)?;
    log::info!("delete_integration_credentials: project={project} service={service}");
    let allowed =
        get_allowed_fields(&service).ok_or_else(|| format!("unknown service: {}", service))?;

    let home = dirs::home_dir().ok_or("cannot determine home directory")?;
    let svc_dir = home
        .join(speedwave_runtime::consts::DATA_DIR)
        .join("tokens")
        .join(&project)
        .join(&service);

    for &field in allowed {
        let path = svc_dir.join(field);
        if path.exists() {
            std::fs::remove_file(&path).map_err(|e| e.to_string())?;
        }
    }

    // Auto-disable the integration since credentials are now removed
    config::with_config_lock(|| {
        let mut user_config = config::load_user_config()?;
        if let Some(entry) = user_config.find_project_mut(&project) {
            let integrations = entry.integrations.get_or_insert_with(Default::default);
            let cfg = config::IntegrationConfig {
                enabled: Some(false),
            };
            integrations.set_service(&service, cfg);
            config::save_user_config(&user_config)?;
        }
        Ok(())
    })
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn restart_integration_containers(project: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        check_project(&project)?;
        log::info!("restart_integration_containers: project={project}");
        let rt = speedwave_runtime::runtime::detect_runtime();

        // Save snapshot of current compose.yml for rollback before any changes
        if let Err(e) = speedwave_runtime::update::save_snapshot(&project) {
            log::warn!("restart_integration_containers: save_snapshot failed, rollback will not work: {e}");
        }

        // Rebuild images BEFORE stopping containers.
        // If the build fails, containers keep running with the previous version.
        // Docker/nerdctl layer caching makes no-op rebuilds fast (seconds).
        if let Err(e) = speedwave_runtime::build::build_all_images(&*rt) {
            log::error!("restart_integration_containers: image rebuild failed: {e}");
            return Err(format!(
                "Image rebuild failed: {e}. Containers are still running with the previous version."
            ));
        }

        rt.compose_down(&project).map_err(|e| {
            log::error!("restart_integration_containers: compose_down error: {e}");
            e.to_string()
        })?;

        let user_config = config::load_user_config().map_err(|e| e.to_string())?;
        let project_dir = user_config
            .find_project(&project)
            .map(|p| p.dir.clone())
            .ok_or_else(|| format!("project '{}' not found", project))?;

        let project_path = std::path::Path::new(&project_dir);
        let (resolved, integrations) =
            config::resolve_project_config(project_path, &user_config, &project);
        let yaml = speedwave_runtime::compose::render_compose(
            &project,
            &project_dir,
            &resolved,
            &integrations,
            Some(&*rt),
        )
        .map_err(|e| e.to_string())?;

        let manifests = speedwave_runtime::plugin::list_installed_plugins().unwrap_or_default();
        let violations = speedwave_runtime::compose::SecurityCheck::run(&yaml, &project, &manifests);
        if !violations.is_empty() {
            let msgs: Vec<String> = violations
                .iter()
                .map(|v| format!("[{}] {} -- {}", v.container, v.rule, v.message))
                .collect();
            return Err(format!("Security check failed:\n{}", msgs.join("\n")));
        }

        speedwave_runtime::compose::save_compose(&project, &yaml).map_err(|e| e.to_string())?;

        if let Err(e) = rt.compose_up_recreate(&project) {
            log::error!(
                "restart_integration_containers: compose_up_recreate failed: {e}, attempting rollback"
            );
            if let Err(rb_err) = speedwave_runtime::update::rollback_containers(&*rt, &project) {
                log::error!(
                    "restart_integration_containers: rollback also failed: {rb_err}"
                );
                return Err(format!(
                    "Restart failed: {e}. Rollback also failed: {rb_err}. Containers are stopped. Run speedwave to restart manually."
                ));
            }
            return Err(format!(
                "Restart failed: {e}. Rolled back to previous configuration."
            ));
        }

        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    // -- IntegrationsConfig::set_service tests --

    #[test]
    fn set_service_known_key_returns_true() {
        let mut cfg = config::IntegrationsConfig::default();
        let ic = config::IntegrationConfig {
            enabled: Some(true),
        };
        assert!(cfg.set_service("slack", ic));
        assert_eq!(cfg.slack.unwrap().enabled, Some(true));
    }

    #[test]
    fn set_service_all_known_keys() {
        for key in &["slack", "sharepoint", "redmine", "gitlab"] {
            let mut cfg = config::IntegrationsConfig::default();
            let ic = config::IntegrationConfig {
                enabled: Some(true),
            };
            assert!(
                cfg.set_service(key, ic),
                "set_service should accept '{}'",
                key
            );
        }
    }

    #[test]
    fn set_service_unknown_key_returns_false() {
        let mut cfg = config::IntegrationsConfig::default();
        let ic = config::IntegrationConfig {
            enabled: Some(true),
        };
        assert!(!cfg.set_service("unknown", ic));
        assert!(!cfg.set_service(
            "os",
            config::IntegrationConfig {
                enabled: Some(true)
            }
        ));
    }

    #[test]
    fn set_service_overwrite() {
        let mut cfg = config::IntegrationsConfig::default();
        cfg.set_service(
            "slack",
            config::IntegrationConfig {
                enabled: Some(true),
            },
        );
        cfg.set_service(
            "slack",
            config::IntegrationConfig {
                enabled: Some(false),
            },
        );
        assert_eq!(cfg.slack.unwrap().enabled, Some(false));
    }

    // -- OS integration platform guards --

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn set_os_integration_enabled_rejects_on_non_macos() {
        let result = set_os_integration_enabled("test".into(), "reminders".into(), true);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("only available on macOS"));
    }

    // -- validate_credential_field tests --

    #[test]
    fn validate_credential_field_accepts_normal_key() {
        assert!(validate_credential_field("api_key", "some-value").is_ok());
    }

    #[test]
    fn validate_credential_field_rejects_slash() {
        assert!(validate_credential_field("../escape", "value").is_err());
    }

    #[test]
    fn validate_credential_field_rejects_backslash() {
        assert!(validate_credential_field("key\\bad", "value").is_err());
    }

    #[test]
    fn validate_credential_field_rejects_dotdot() {
        assert!(validate_credential_field("foo..bar", "value").is_err());
    }

    #[test]
    fn validate_credential_field_rejects_null_byte_in_key() {
        assert!(validate_credential_field("api\x00key", "value").is_err());
    }

    #[test]
    fn validate_credential_field_rejects_null_byte_in_value() {
        assert!(validate_credential_field("key", "val\x00ue").is_err());
    }

    #[test]
    fn validate_credential_field_rejects_oversized_value() {
        let big_value = "x".repeat(4097);
        assert!(validate_credential_field("key", &big_value).is_err());
    }

    #[test]
    fn validate_credential_field_accepts_max_size_value() {
        let max_value = "x".repeat(4096);
        assert!(validate_credential_field("key", &max_value).is_ok());
    }

    // -- Redmine helper tests --

    #[test]
    fn read_redmine_config_returns_empty_for_missing_file() {
        let tmp = tempfile::tempdir().unwrap();
        let result = read_redmine_config(tmp.path());
        assert_eq!(result, serde_json::json!({}));
    }

    #[test]
    fn read_redmine_config_parses_valid_json() {
        let tmp = tempfile::tempdir().unwrap();
        let config_path = tmp.path().join("config.json");
        std::fs::write(
            &config_path,
            r#"{"host_url":"https://redmine.example.com","project_id":"my-proj"}"#,
        )
        .unwrap();
        let result = read_redmine_config(tmp.path());
        assert_eq!(
            result.get("host_url").unwrap().as_str().unwrap(),
            "https://redmine.example.com"
        );
    }

    #[test]
    fn read_redmine_config_returns_empty_for_invalid_json() {
        let tmp = tempfile::tempdir().unwrap();
        let config_path = tmp.path().join("config.json");
        std::fs::write(&config_path, "not json").unwrap();
        let result = read_redmine_config(tmp.path());
        assert_eq!(result, serde_json::json!({}));
    }

    #[test]
    fn save_redmine_credentials_writes_config_fields_to_json() {
        let tmp = tempfile::tempdir().unwrap();
        let svc_dir = tmp.path();
        let mut creds = std::collections::HashMap::new();
        creds.insert("host_url".to_string(), "https://r.test".to_string());
        creds.insert("project_id".to_string(), "proj1".to_string());
        creds.insert("api_key".to_string(), "secret123".to_string());

        let allowed = &[
            "api_key",
            "host_url",
            "project_id",
            "project_name",
            "config.json",
        ];
        save_redmine_credentials(svc_dir, &creds, allowed).unwrap();

        // api_key should be written as a file
        let api_key = std::fs::read_to_string(svc_dir.join("api_key")).unwrap();
        assert_eq!(api_key, "secret123");

        // host_url and project_id should be in config.json
        let config_content = std::fs::read_to_string(svc_dir.join("config.json")).unwrap();
        let config_json: serde_json::Value = serde_json::from_str(&config_content).unwrap();
        assert_eq!(config_json["host_url"], "https://r.test");
        assert_eq!(config_json["project_id"], "proj1");

        // host_url should NOT be written as a separate file
        assert!(!svc_dir.join("host_url").exists());
    }

    #[test]
    fn save_redmine_credentials_rejects_disallowed_field() {
        let tmp = tempfile::tempdir().unwrap();
        let mut creds = std::collections::HashMap::new();
        creds.insert("evil_field".to_string(), "value".to_string());

        let allowed = &["api_key", "host_url"];
        let result = save_redmine_credentials(tmp.path(), &creds, allowed);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not allowed"));
    }

    #[test]
    fn save_redmine_credentials_skips_config_json_when_only_secret_fields() {
        let tmp = tempfile::tempdir().unwrap();
        let svc_dir = tmp.path();
        let mut creds = std::collections::HashMap::new();
        creds.insert("api_key".to_string(), "secret123".to_string());

        let allowed = &[
            "api_key",
            "host_url",
            "project_id",
            "project_name",
            "config.json",
        ];
        save_redmine_credentials(svc_dir, &creds, allowed).unwrap();

        // api_key should be written as a file
        assert!(svc_dir.join("api_key").exists());

        // config.json should NOT be created since no config fields were present
        assert!(
            !svc_dir.join("config.json").exists(),
            "config.json should not be written when only secret fields are saved"
        );
    }

    // OsIntegrationsConfig::set_service tests live in config.rs (SSOT)

    // -- restart_integration_containers structural tests --

    #[test]
    fn restart_rebuilds_images_before_compose_down() {
        let source = include_str!("integrations_cmd.rs");
        let fn_start = source
            .find("fn restart_integration_containers(")
            .expect("restart_integration_containers function must exist");
        let fn_body = &source[fn_start..];

        let build_pos = fn_body
            .find("build::build_all_images")
            .expect("build_all_images call must exist in restart_integration_containers");
        let down_pos = fn_body
            .find("compose_down")
            .expect("compose_down call must exist in restart_integration_containers");

        assert!(
            build_pos < down_pos,
            "build_all_images (offset {}) must appear before compose_down (offset {}) in restart_integration_containers",
            build_pos,
            down_pos
        );
    }

    #[test]
    fn restart_uses_compose_up_recreate() {
        let source = include_str!("integrations_cmd.rs");
        let fn_start = source
            .find("fn restart_integration_containers(")
            .expect("restart_integration_containers function must exist");
        let fn_body = &source[fn_start..];

        assert!(
            fn_body.contains("compose_up_recreate"),
            "restart_integration_containers must use compose_up_recreate, not compose_up"
        );
    }
}
