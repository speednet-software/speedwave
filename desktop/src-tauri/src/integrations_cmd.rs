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
// Redmine helpers — Redmine stores host_url and project_id inside a single
// config.json file rather than as individual credential files.
// These helpers isolate that difference so the generic handlers stay clean.
// ---------------------------------------------------------------------------

/// Reads and parses a service's config.json. Returns an empty JSON object
/// on missing or unreadable files.
fn read_service_config(svc_token_dir: &std::path::Path) -> serde_json::Value {
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
    let config_json = read_service_config(svc_token_dir);

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
/// config fields (host_url, project_id) go into config.json.
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

    let tokens_dir = speedwave_runtime::consts::data_dir()
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
            badge: svc_desc.badge.map(|b| b.to_string()),
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
    let svc_desc = match speedwave_runtime::consts::find_mcp_service(service) {
        Some(d) => d,
        None => return false,
    };
    // Services with no auth fields have nothing to configure — they're
    // always "configured" (e.g. Playwright scrapes public URLs).
    if svc_desc.auth_fields.is_empty() {
        return true;
    }
    let svc_token_dir = speedwave_runtime::consts::data_dir()
        .join("tokens")
        .join(project)
        .join(service);

    let has_config_fields = svc_desc.auth_fields.iter().any(|f| f.stored_in_config_json);
    let config_json = if has_config_fields {
        read_service_config(&svc_token_dir)
    } else {
        serde_json::json!({})
    };

    // Skip optional fields (e.g. Redmine project_id)
    svc_desc
        .auth_fields
        .iter()
        .filter(|f| !f.optional)
        .all(|f| {
            if f.stored_in_config_json {
                config_json
                    .get(f.key)
                    .and_then(|v| v.as_str())
                    .map(|s| !s.is_empty())
                    .unwrap_or(false)
            } else {
                let path = svc_token_dir.join(f.key);
                std::fs::metadata(&path)
                    .map(|m| m.len() > 0)
                    .unwrap_or(false)
            }
        })
}

/// Testable core: takes an explicit `home` path so tests can inject a temp dir.
#[cfg(test)]
fn is_service_configured_with_home(home: &std::path::Path, project: &str, service: &str) -> bool {
    let svc_desc = match speedwave_runtime::consts::find_mcp_service(service) {
        Some(d) => d,
        None => return false,
    };
    // Services with no auth fields have nothing to configure — they're
    // always "configured" (e.g. Playwright scrapes public URLs).
    if svc_desc.auth_fields.is_empty() {
        return true;
    }
    let svc_token_dir = home
        .join(speedwave_runtime::consts::DATA_DIR)
        .join("tokens")
        .join(project)
        .join(service);

    let has_config_fields = svc_desc.auth_fields.iter().any(|f| f.stored_in_config_json);
    let config_json = if has_config_fields {
        read_service_config(&svc_token_dir)
    } else {
        serde_json::json!({})
    };

    // Skip optional fields (e.g. Redmine project_id)
    svc_desc
        .auth_fields
        .iter()
        .filter(|f| !f.optional)
        .all(|f| {
            if f.stored_in_config_json {
                config_json
                    .get(f.key)
                    .and_then(|v| v.as_str())
                    .map(|s| !s.is_empty())
                    .unwrap_or(false)
            } else {
                let path = svc_token_dir.join(f.key);
                std::fs::metadata(&path)
                    .map(|m| m.len() > 0)
                    .unwrap_or(false)
            }
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

// ---------------------------------------------------------------------------
// macOS permission check — verifies TCC/Automation access before enabling
// an OS integration. Uses the native Swift CLI binaries (same binaries as
// mcp-os) with a `check_permission` subcommand.
// ---------------------------------------------------------------------------

/// Resolves the absolute path to a native macOS CLI binary.
///
/// Production: `BUNDLE_RESOURCES_ENV` → `<dir>/<binary-name>`
/// Dev: `CARGO_MANIFEST_DIR` → `../../native/macos/<pkg>/.build/release/<binary-name>`
///
/// No fallback to Resources/ subdir — `BUNDLE_RESOURCES_ENV` is always set by
/// Desktop `main.rs` in production.
// SYNC: binary paths must match mcp-servers/os/src/platform-runner.ts::resolveDarwinPaths()
fn resolve_native_cli_binary(service: &str) -> Result<std::path::PathBuf, String> {
    let (binary_name, pkg_dir) = match service {
        "reminders" => ("reminders-cli", "reminders"),
        "calendar" => ("calendar-cli", "calendar"),
        "mail" => ("mail-cli", "mail"),
        "notes" => ("notes-cli", "notes"),
        _ => return Err(format!("unknown OS service: {service}")),
    };

    // Production: env var set by main.rs via resolve_resources_dir()
    if let Ok(resources_dir) = std::env::var(speedwave_runtime::consts::BUNDLE_RESOURCES_ENV) {
        return Ok(std::path::PathBuf::from(resources_dir).join(binary_name));
    }

    // Dev fallback: compile-time path from CARGO_MANIFEST_DIR (desktop/src-tauri/)
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    Ok(std::path::PathBuf::from(manifest_dir)
        .join("../../native/macos")
        .join(pkg_dir)
        .join(".build/release")
        .join(binary_name))
}

/// Parses the JSON output from a `check_permission` CLI command.
///
/// Expected format: `{"granted": true}` or `{"granted": false, "error": "..."}`
/// Returns `Ok(())` if `granted` is boolean `true`.
/// Returns `Err(message)` if `granted` is `false`, missing, or non-boolean.
fn parse_permission_output(stdout: &str) -> Result<(), String> {
    let parsed: serde_json::Value = serde_json::from_str(stdout.trim())
        .map_err(|e| format!("Failed to parse permission check output: {e}"))?;

    let granted = parsed
        .get("granted")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    if granted {
        Ok(())
    } else {
        let error_detail = parsed
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("Permission denied");
        Err(error_detail.to_string())
    }
}

/// Checks macOS TCC/Automation permission for the given OS service.
///
/// Spawns the native CLI binary with `check_permission` and parses the JSON
/// output. Uses a spawn + try_wait polling loop with timeout (same pattern as
/// `speedwave_runtime::binary::run_with_timeout` but with stdout/stderr capture).
///
/// Pipe-buffer deadlock is not a risk: `check_permission` output is <200 bytes,
/// well within the OS pipe buffer of 64KB. Stdout is read after child exits.
fn check_os_permission(service: &str) -> Result<(), String> {
    check_os_permission_with_timeout(service, std::time::Duration::from_secs(60))
}

/// Inner implementation with configurable timeout for testability.
fn check_os_permission_with_timeout(
    service: &str,
    timeout: std::time::Duration,
) -> Result<(), String> {
    let binary_path = resolve_native_cli_binary(service)?;

    let mut child = std::process::Command::new(&binary_path)
        .arg("check_permission")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| {
            format!(
                "Failed to run permission check for {service}: {e}. Binary: {}",
                binary_path.display()
            )
        })?;

    // Poll try_wait() every 200ms until exit or timeout
    let start = std::time::Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if start.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!(
                        "Permission check timed out after {}s. Try again.",
                        timeout.as_secs()
                    ));
                }
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
            Err(e) => return Err(format!("Permission check failed: {e}")),
        }
    };

    // Read stdout/stderr AFTER child exits — avoids pipe-buffer deadlock
    let stdout = child
        .stdout
        .take()
        .map(|mut s| {
            let mut buf = String::new();
            std::io::Read::read_to_string(&mut s, &mut buf).ok();
            buf
        })
        .unwrap_or_default();

    let stderr = child
        .stderr
        .take()
        .map(|mut s| {
            let mut buf = String::new();
            std::io::Read::read_to_string(&mut s, &mut buf).ok();
            buf
        })
        .unwrap_or_default();

    if !status.success() {
        let detail = if stderr.trim().is_empty() {
            format!("exit code {}", status.code().unwrap_or(-1))
        } else {
            stderr.trim().to_string()
        };
        return Err(format!("Permission check failed: {detail}"));
    }

    parse_permission_output(&stdout)
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

    // When enabling, check macOS permission first
    if enabled {
        check_os_permission(&service)?;
    }

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

    let svc_dir = speedwave_runtime::consts::data_dir()
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
        validate_credential_field(key, value)?;

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
    let config_path = speedwave_runtime::consts::data_dir()
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

    let svc_dir = speedwave_runtime::consts::data_dir()
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

        // Resolve config, render compose, security check, save
        crate::containers_cmd::render_and_save_compose(&project, &*rt)?;

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
    use serial_test::serial;

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
        for key in &["slack", "sharepoint", "redmine", "gitlab", "playwright"] {
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

    // -- read_service_config tests --

    #[test]
    fn read_service_config_returns_empty_for_missing_file() {
        let tmp = tempfile::tempdir().unwrap();
        let result = read_service_config(tmp.path());
        assert_eq!(result, serde_json::json!({}));
    }

    #[test]
    fn read_service_config_parses_valid_json() {
        let tmp = tempfile::tempdir().unwrap();
        let config_path = tmp.path().join("config.json");
        std::fs::write(
            &config_path,
            r#"{"host_url":"https://redmine.example.com","project_id":"my-proj"}"#,
        )
        .unwrap();
        let result = read_service_config(tmp.path());
        assert_eq!(
            result.get("host_url").unwrap().as_str().unwrap(),
            "https://redmine.example.com"
        );
    }

    #[test]
    fn read_service_config_returns_empty_for_invalid_json() {
        let tmp = tempfile::tempdir().unwrap();
        let config_path = tmp.path().join("config.json");
        std::fs::write(&config_path, "not json").unwrap();
        let result = read_service_config(tmp.path());
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

        let allowed = &["api_key", "host_url", "project_id", "config.json"];
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

        let allowed = &["api_key", "host_url", "project_id", "config.json"];
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

    // -- is_service_configured tests --

    /// Helper: creates the token directory for a service under a fake home.
    fn make_svc_token_dir(
        home: &std::path::Path,
        project: &str,
        service: &str,
    ) -> std::path::PathBuf {
        let dir = home
            .join(speedwave_runtime::consts::DATA_DIR)
            .join("tokens")
            .join(project)
            .join(service);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn is_service_configured_returns_false_when_only_secrets_exist() {
        // SharePoint: access_token + refresh_token exist (file-based secrets),
        // but client_id/tenant_id/site_id/base_path are missing → false
        let tmp = tempfile::tempdir().unwrap();
        let svc_dir = make_svc_token_dir(tmp.path(), "proj", "sharepoint");
        std::fs::write(svc_dir.join("access_token"), "tok").unwrap();
        std::fs::write(svc_dir.join("refresh_token"), "ref").unwrap();

        assert!(
            !is_service_configured_with_home(tmp.path(), "proj", "sharepoint"),
            "should be false when non-secret fields (client_id etc.) are missing"
        );
    }

    #[test]
    fn is_service_configured_returns_true_when_all_fields_present() {
        // SharePoint: all 6 auth_fields are file-based → all must exist as non-empty files
        let tmp = tempfile::tempdir().unwrap();
        let svc_dir = make_svc_token_dir(tmp.path(), "proj", "sharepoint");
        std::fs::write(svc_dir.join("access_token"), "tok").unwrap();
        std::fs::write(svc_dir.join("refresh_token"), "ref").unwrap();
        std::fs::write(
            svc_dir.join("client_id"),
            "550e8400-e29b-41d4-a716-446655440000",
        )
        .unwrap();
        std::fs::write(svc_dir.join("tenant_id"), "common").unwrap();
        std::fs::write(svc_dir.join("site_id"), "my-site").unwrap();
        std::fs::write(svc_dir.join("base_path"), "/Shared Documents").unwrap();

        assert!(
            is_service_configured_with_home(tmp.path(), "proj", "sharepoint"),
            "should be true when all auth_fields are present"
        );
    }

    #[test]
    fn is_service_configured_checks_stored_in_config_json_for_redmine() {
        // Redmine: api_key (file) + host_url (config.json, required) +
        // project_id (config.json, optional)
        let tmp = tempfile::tempdir().unwrap();
        let svc_dir = make_svc_token_dir(tmp.path(), "proj", "redmine");

        // Only api_key file — required config.json field host_url missing → false
        std::fs::write(svc_dir.join("api_key"), "secret").unwrap();
        assert!(
            !is_service_configured_with_home(tmp.path(), "proj", "redmine"),
            "should be false when required config.json field (host_url) is missing"
        );

        // Add config.json with only host_url (optional fields absent) → true
        let config = serde_json::json!({
            "host_url": "https://redmine.example.com"
        });
        std::fs::write(
            svc_dir.join("config.json"),
            serde_json::to_string(&config).unwrap(),
        )
        .unwrap();
        assert!(
            is_service_configured_with_home(tmp.path(), "proj", "redmine"),
            "should be true when required fields are present (optional fields absent)"
        );

        // Add all fields including optional → also true
        let config = serde_json::json!({
            "host_url": "https://redmine.example.com",
            "project_id": "my-proj"
        });
        std::fs::write(
            svc_dir.join("config.json"),
            serde_json::to_string(&config).unwrap(),
        )
        .unwrap();
        assert!(
            is_service_configured_with_home(tmp.path(), "proj", "redmine"),
            "should be true when all fields (including optional) are present"
        );
    }

    #[test]
    fn is_service_configured_returns_false_for_empty_files() {
        // Slack: bot_token + user_token exist but are empty → false
        let tmp = tempfile::tempdir().unwrap();
        let svc_dir = make_svc_token_dir(tmp.path(), "proj", "slack");
        std::fs::write(svc_dir.join("bot_token"), "").unwrap();
        std::fs::write(svc_dir.join("user_token"), "").unwrap();

        assert!(
            !is_service_configured_with_home(tmp.path(), "proj", "slack"),
            "should be false when token files are empty (0 bytes)"
        );

        // Write non-empty content → true
        std::fs::write(svc_dir.join("bot_token"), "xoxb-123").unwrap();
        std::fs::write(svc_dir.join("user_token"), "xoxp-456").unwrap();
        assert!(
            is_service_configured_with_home(tmp.path(), "proj", "slack"),
            "should be true when token files are non-empty"
        );
    }

    #[test]
    fn is_service_configured_returns_false_for_empty_config_json_values() {
        // Redmine: host_url is a required (non-optional) config.json field.
        // An empty host_url blocks configuration even if optional fields are present.
        let tmp = tempfile::tempdir().unwrap();
        let svc_dir = make_svc_token_dir(tmp.path(), "proj", "redmine");
        std::fs::write(svc_dir.join("api_key"), "secret").unwrap();
        let config = serde_json::json!({
            "host_url": "",
            "project_id": "proj"
        });
        std::fs::write(
            svc_dir.join("config.json"),
            serde_json::to_string(&config).unwrap(),
        )
        .unwrap();

        assert!(
            !is_service_configured_with_home(tmp.path(), "proj", "redmine"),
            "should be false when required config.json field (host_url) is empty"
        );
    }

    #[test]
    fn is_service_configured_returns_true_for_credential_less_service() {
        // Services like Playwright have no auth_fields; they scrape public URLs.
        // They must be treated as always-configured so the UI toggle is enabled.
        let tmp = tempfile::tempdir().unwrap();
        assert!(
            is_service_configured_with_home(tmp.path(), "proj", "playwright"),
            "credential-less service (playwright) should be always-configured"
        );
    }

    #[test]
    fn read_service_config_returns_empty_for_missing_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let nonexistent = tmp.path().join("does-not-exist");
        let result = read_service_config(&nonexistent);
        assert_eq!(result, serde_json::json!({}));
    }

    // -- parse_permission_output tests --

    #[test]
    fn parse_permission_output_granted() {
        assert!(parse_permission_output(r#"{"granted": true}"#).is_ok());
    }

    #[test]
    fn parse_permission_output_denied() {
        let result = parse_permission_output(r#"{"granted": false, "error": "denied"}"#);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("denied"));
    }

    #[test]
    fn parse_permission_output_denied_no_error_field() {
        let result = parse_permission_output(r#"{"granted": false}"#);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Permission denied"));
    }

    #[test]
    fn parse_permission_output_malformed_json() {
        let result = parse_permission_output("not json");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Failed to parse"));
    }

    #[test]
    fn parse_permission_output_empty() {
        let result = parse_permission_output("");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Failed to parse"));
    }

    #[test]
    fn parse_permission_output_missing_granted_key() {
        // Missing "granted" key treated as denial, not a "default to false"
        let result = parse_permission_output(r#"{"error": "something"}"#);
        assert!(result.is_err());
    }

    #[test]
    fn parse_permission_output_granted_wrong_type_string() {
        let result = parse_permission_output(r#"{"granted": "yes"}"#);
        assert!(result.is_err());
    }

    #[test]
    fn parse_permission_output_granted_wrong_type_number() {
        let result = parse_permission_output(r#"{"granted": 1}"#);
        assert!(result.is_err());
    }

    // -- resolve_native_cli_binary tests --

    #[test]
    fn resolve_native_cli_binary_maps_known_services() {
        for (service, expected_binary) in [
            ("reminders", "reminders-cli"),
            ("calendar", "calendar-cli"),
            ("mail", "mail-cli"),
            ("notes", "notes-cli"),
        ] {
            let path = resolve_native_cli_binary(service).unwrap();
            assert!(
                path.to_string_lossy().contains(expected_binary),
                "path for {service} should contain {expected_binary}, got: {}",
                path.display()
            );
        }
    }

    #[test]
    fn resolve_native_cli_binary_rejects_unknown() {
        assert!(resolve_native_cli_binary("unknown").is_err());
    }

    #[test]
    fn resolve_native_cli_binary_covers_all_os_services() {
        // Cross-language consistency with platform-runner.ts must be verified
        // manually when changing binary names
        let os_services: std::collections::HashSet<&str> =
            speedwave_runtime::consts::TOGGLEABLE_OS_SERVICES
                .iter()
                .map(|s| s.config_key)
                .collect();

        for service in &os_services {
            assert!(
                resolve_native_cli_binary(service).is_ok(),
                "resolve_native_cli_binary must handle OS service '{service}'"
            );
        }

        // Verify the match arms exactly cover TOGGLEABLE_OS_SERVICES
        let known = ["reminders", "calendar", "mail", "notes"]
            .iter()
            .copied()
            .collect::<std::collections::HashSet<&str>>();
        assert_eq!(
            os_services, known,
            "TOGGLEABLE_OS_SERVICES must match the known services in resolve_native_cli_binary"
        );
    }

    #[test]
    fn resolve_native_cli_binary_dev_fallback_path_exists() {
        // Verify the dev fallback path structure is plausible from CARGO_MANIFEST_DIR
        let manifest_dir = env!("CARGO_MANIFEST_DIR");
        let native_dir = std::path::Path::new(manifest_dir).join("../../native/macos/reminders");
        assert!(
            native_dir.exists(),
            "dev fallback path ../../native/macos/reminders from CARGO_MANIFEST_DIR should exist: {}",
            native_dir.display()
        );
    }

    // -- check_os_permission tests (macOS-only) --

    #[cfg(target_os = "macos")]
    #[test]
    #[serial]
    fn check_os_permission_handles_binary_not_found() {
        std::env::set_var(
            speedwave_runtime::consts::BUNDLE_RESOURCES_ENV,
            "/nonexistent/path",
        );
        let result = check_os_permission("reminders");
        std::env::remove_var(speedwave_runtime::consts::BUNDLE_RESOURCES_ENV);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            err.contains("Failed to run") || err.contains("No such file"),
            "expected 'Failed to run' or 'No such file', got: {err}"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[serial]
    fn check_os_permission_handles_non_executable_binary() {
        let tmp = tempfile::tempdir().unwrap();
        let binary_path = tmp.path().join("reminders-cli");
        std::fs::write(&binary_path, "not executable").unwrap();
        // chmod 0o644 — not executable
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&binary_path, std::fs::Permissions::from_mode(0o644)).unwrap();

        std::env::set_var(speedwave_runtime::consts::BUNDLE_RESOURCES_ENV, tmp.path());
        let result = check_os_permission("reminders");
        std::env::remove_var(speedwave_runtime::consts::BUNDLE_RESOURCES_ENV);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            err.contains("Permission denied") || err.contains("Failed to run"),
            "expected permission error, got: {err}"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[serial]
    fn check_os_permission_handles_nonzero_exit() {
        let tmp = tempfile::tempdir().unwrap();
        let script = tmp.path().join("reminders-cli");
        std::fs::write(&script, "#!/bin/sh\necho 'crash info' >&2\nexit 1\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();

        std::env::set_var(speedwave_runtime::consts::BUNDLE_RESOURCES_ENV, tmp.path());
        let result = check_os_permission("reminders");
        std::env::remove_var(speedwave_runtime::consts::BUNDLE_RESOURCES_ENV);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("crash info"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[serial]
    fn check_os_permission_handles_exit_0_garbage_stdout() {
        let tmp = tempfile::tempdir().unwrap();
        let script = tmp.path().join("reminders-cli");
        std::fs::write(&script, "#!/bin/sh\necho 'debug line'\necho 'not json'\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();

        std::env::set_var(speedwave_runtime::consts::BUNDLE_RESOURCES_ENV, tmp.path());
        let result = check_os_permission("reminders");
        std::env::remove_var(speedwave_runtime::consts::BUNDLE_RESOURCES_ENV);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Failed to parse"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[serial]
    fn check_os_permission_timeout_kills_child() {
        // Intentionally slow test (~5s) — spawns a script that sleeps 60s,
        // but we set a 2s timeout so it gets killed quickly.
        let tmp = tempfile::tempdir().unwrap();
        let script = tmp.path().join("reminders-cli");
        std::fs::write(&script, "#!/bin/sh\nsleep 60\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();

        std::env::set_var(speedwave_runtime::consts::BUNDLE_RESOURCES_ENV, tmp.path());
        let result =
            check_os_permission_with_timeout("reminders", std::time::Duration::from_secs(2));
        std::env::remove_var(speedwave_runtime::consts::BUNDLE_RESOURCES_ENV);
        assert!(result.is_err());
        assert!(
            result.unwrap_err().contains("timed out"),
            "should report timeout"
        );
    }

    // -- set_os_integration_enabled permission check structural tests --

    #[test]
    fn set_os_integration_enabled_calls_check_before_config_lock() {
        let source = include_str!("integrations_cmd.rs");
        let fn_start = source
            .find("fn set_os_integration_enabled(")
            .expect("set_os_integration_enabled function must exist");
        let fn_body = &source[fn_start..];

        let check_pos = fn_body
            .find("check_os_permission")
            .expect("check_os_permission call must exist in set_os_integration_enabled");
        let lock_pos = fn_body
            .find("with_config_lock")
            .expect("with_config_lock call must exist in set_os_integration_enabled");

        assert!(
            check_pos < lock_pos,
            "check_os_permission (offset {check_pos}) must appear before with_config_lock (offset {lock_pos})"
        );
    }

    #[test]
    fn credential_files_allowlist_covers_legacy_project_name_file() {
        // project_name was removed from auth_fields (UI no longer shows it),
        // but credential_files still includes it so delete_integration_credentials
        // can clean up legacy installations that have a project_name file on disk.
        let svc = speedwave_runtime::consts::find_mcp_service("redmine").unwrap();

        assert!(
            svc.credential_files.contains(&"project_name"),
            "credential_files must still contain 'project_name' for backward compat"
        );
        assert!(
            !svc.auth_fields.iter().any(|f| f.key == "project_name"),
            "project_name must not appear in auth_fields (removed from UI)"
        );

        // Simulate legacy cleanup: create a temp dir with a project_name file,
        // then iterate credential_files to delete — mirrors delete_integration_credentials logic.
        let tmp = tempfile::tempdir().unwrap();
        let svc_dir = tmp.path();
        std::fs::write(svc_dir.join("project_name"), "Legacy Project").unwrap();
        std::fs::write(svc_dir.join("api_key"), "secret").unwrap();
        std::fs::write(
            svc_dir.join("config.json"),
            r#"{"host_url":"https://r.test"}"#,
        )
        .unwrap();

        for &field in svc.credential_files {
            let path = svc_dir.join(field);
            if path.exists() {
                std::fs::remove_file(&path).unwrap();
            }
        }

        assert!(
            !svc_dir.join("project_name").exists(),
            "legacy project_name file should be cleaned up via credential_files allowlist"
        );
        assert!(
            !svc_dir.join("api_key").exists(),
            "api_key should also be cleaned up"
        );
        assert!(
            !svc_dir.join("config.json").exists(),
            "config.json should also be cleaned up"
        );
    }
}
