// Integration management commands — extracted from main.rs for clarity.
//
// All `#[tauri::command]` functions here are registered in the main
// `generate_handler!` macro via their fully-qualified paths.

use crate::types::{
    check_project, get_allowed_fields, get_auth_fields, is_secret_field, IntegrationStatusEntry,
    IntegrationsResponse, OsIntegrationStatusEntry,
};
use speedwave_runtime::config;
use speedwave_runtime::log_sanitizer;
use speedwave_runtime::plugin;

/// SharePoint banner trigger. ScopeMismatch and Stale collapse to one UI code.
fn detect_oauth_action_required(project: &str, service: &str) -> Option<String> {
    detect_oauth_action_required_in(speedwave_runtime::consts::data_dir(), project, service)
}

/// Parameterised by `data_dir` so unit tests avoid the `consts::data_dir()`
/// `OnceLock` cache. Production callers go through `detect_oauth_action_required`.
fn detect_oauth_action_required_in(
    data_dir: &std::path::Path,
    project: &str,
    service: &str,
) -> Option<String> {
    // Gate on the descriptor flag (SSOT) rather than a hardcoded service id, so a
    // future OAuth-refresh integration surfaces the banner without a code change.
    // The scope-coverage check below is still Microsoft-shaped; revisit when a
    // second provider lands (today only SharePoint sets `uses_oauth_refresh`).
    match speedwave_runtime::consts::find_mcp_service(service) {
        Some(d) if d.uses_oauth_refresh => {}
        _ => return None,
    }
    let oauth_path = plugin::oauth_state_file_in(data_dir, project, service);
    let raw = match std::fs::read_to_string(&oauth_path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
        Err(e) => {
            log::warn!(
                "detect_oauth_action_required: cannot read {} ({e}) — treating as stale",
                oauth_path.display()
            );
            return Some("scope_mismatch".to_string());
        }
    };
    let required = sharepoint_required_scopes();
    match detect_scope_mismatch_or_stale(&raw, &required) {
        ReauthorizeReason::Ok => None,
        ReauthorizeReason::ScopeMismatch | ReauthorizeReason::Stale => {
            Some("scope_mismatch".to_string())
        }
    }
}

/// Outcome of inspecting `oauth.json` for re-consent triggers.
#[derive(Debug, PartialEq, Eq)]
enum ReauthorizeReason {
    /// State is well-formed and covers the required scopes.
    Ok,
    /// State is well-formed but granted scopes ⊊ required scopes.
    ScopeMismatch,
    /// State cannot be interpreted — corrupted JSON, wrong root type, missing
    /// `providerData` (pre-refactor file), or no `grantedScopes` array.
    Stale,
}

/// Pure helper for `detect_oauth_action_required`. Extracted so unit tests do
/// not round-trip through the filesystem and the `consts::data_dir()`
/// `OnceLock` cache.
fn detect_scope_mismatch_or_stale(oauth_json_raw: &str, required: &[String]) -> ReauthorizeReason {
    let json: serde_json::Value = match serde_json::from_str(oauth_json_raw) {
        Ok(v) => v,
        Err(_) => return ReauthorizeReason::Stale,
    };
    let obj = match json.as_object() {
        Some(o) => o,
        None => return ReauthorizeReason::Stale,
    };
    if !obj.get("providerData").is_some_and(|v| v.is_object()) {
        return ReauthorizeReason::Stale;
    }
    let granted_arr = match obj.get("grantedScopes").and_then(|v| v.as_array()) {
        Some(a) => a,
        None => return ReauthorizeReason::Stale,
    };
    let granted: Vec<String> = granted_arr
        .iter()
        .filter_map(|s| s.as_str().map(|s| s.to_lowercase()))
        .collect();
    // `offline_access` is an OIDC control scope: Microsoft never echoes it in the
    // token-response `scope` field, so it never lands in grantedScopes. Same rule
    // as `mcp-servers/oauth/src/providers/microsoft.ts` `refreshMicrosoftToken`
    // (the `s.toLowerCase() === 'offline_access'` skip) — keep both in sync;
    // refreshToken is the real proof offline access was granted.
    let covers = required
        .iter()
        .filter(|r| r.as_str() != OFFLINE_ACCESS_SCOPE)
        .all(|r| granted.contains(r));
    if covers {
        ReauthorizeReason::Ok
    } else {
        ReauthorizeReason::ScopeMismatch
    }
}

/// OIDC control scope (lowercase) excluded from the response-scope coverage
/// check — Microsoft does not return it in the token-response `scope` field.
const OFFLINE_ACCESS_SCOPE: &str = "offline_access";

fn sharepoint_required_scopes() -> Vec<String> {
    speedwave_runtime::consts::SHAREPOINT_OAUTH_SCOPES
        .split_whitespace()
        .map(|s| s.to_lowercase())
        .collect()
}

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

/// True when any of `files` exists as a non-empty file under `svc_token_dir`.
fn has_any_credential_file(svc_token_dir: &std::path::Path, files: &[&str]) -> bool {
    files.iter().any(|name| {
        std::fs::metadata(svc_token_dir.join(name))
            .map(|m| m.len() > 0)
            .unwrap_or(false)
    })
}

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
            // Atomic O_CREAT|0o600 — close the TOCTOU window for credential files.
            speedwave_runtime::fs_perms::write_restricted_file(&file_path, value)
                .map_err(|e| e.to_string())?;
        }
    }

    if has_config_fields {
        let json = serde_json::to_string_pretty(&config_obj).map_err(|e| e.to_string())?;
        speedwave_runtime::fs_perms::write_restricted_file(&config_path, &json)
            .map_err(|e| e.to_string())?;
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
            let oauth_state_json: Option<serde_json::Value> =
                if svc_desc.oauth_state_fields.is_some() {
                    std::fs::read_to_string(plugin::oauth_state_file(&project, svc))
                        .ok()
                        .and_then(|s| serde_json::from_str(&s).ok())
                } else {
                    None
                };
            for field in &auth_fields {
                if is_secret_field(&field.key) {
                    continue;
                }
                let descriptor = svc_desc
                    .auth_fields
                    .iter()
                    .find(|f| f.key == field.key)
                    .map(|f| f.storage);
                match descriptor {
                    Some(
                        storage @ (speedwave_runtime::consts::FieldStorage::OAuthState
                        | speedwave_runtime::consts::FieldStorage::OAuthStateProviderData),
                    ) => {
                        if let Some(json) = &oauth_state_json {
                            if let Some(v) = get_oauth_field(json, storage, &field.key) {
                                if !v.is_empty() {
                                    values.insert(field.key.clone(), v.to_string());
                                }
                            }
                        }
                    }
                    _ => {
                        let path = svc_token_dir.join(&field.key);
                        if let Ok(content) = std::fs::read_to_string(&path) {
                            let trimmed = content.trim().to_string();
                            if !trimmed.is_empty() {
                                values.insert(field.key.clone(), trimmed);
                            }
                        }
                    }
                }
            }
            (values, None)
        };

        // Computed regardless of `configured`: a stale/malformed providerData
        // makes the service read as unconfigured, yet the user must still be
        // led to re-authorise. `detect_oauth_action_required` returns None for a
        // fresh (absent) file, so a never-configured service shows no banner.
        let oauth_action_required = detect_oauth_action_required(&project, svc);

        // Optional-only services (e.g. context7): badge from descriptor only when
        // no key is set — once configured, drop the badge to mirror configured state.
        let all_optional =
            !svc_desc.auth_fields.is_empty() && svc_desc.auth_fields.iter().all(|f| f.optional);
        let badge = if all_optional
            && configured
            && has_any_credential_file(&svc_token_dir, svc_desc.credential_files)
        {
            None
        } else {
            svc_desc.badge.map(|b| b.to_string())
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
            badge,
            oauth_action_required,
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
    is_service_configured_inner(speedwave_runtime::consts::data_dir(), project, service)
}

fn is_service_configured_inner(data_dir: &std::path::Path, project: &str, service: &str) -> bool {
    let svc_desc = match speedwave_runtime::consts::find_mcp_service(service) {
        Some(d) => d,
        None => return false,
    };
    if svc_desc.auth_fields.is_empty() {
        return true;
    }
    let svc_token_dir = data_dir.join("tokens").join(project).join(service);

    let has_config_fields = svc_desc.auth_fields.iter().any(|f| f.stored_in_config_json);
    let config_json = if has_config_fields {
        read_service_config(&svc_token_dir)
    } else {
        serde_json::json!({})
    };

    let oauth_state_json: Option<serde_json::Value> = if svc_desc.oauth_state_fields.is_some() {
        let path = speedwave_runtime::plugin::oauth_state_file_in(data_dir, project, service);
        std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
    } else {
        None
    };

    svc_desc
        .auth_fields
        .iter()
        .filter(|f| !f.optional)
        .all(|f| match f.storage {
            speedwave_runtime::consts::FieldStorage::OAuthState
            | speedwave_runtime::consts::FieldStorage::OAuthStateProviderData => oauth_state_json
                .as_ref()
                .and_then(|j| get_oauth_field(j, f.storage, f.key))
                .map(|s| !s.is_empty())
                .unwrap_or(false),
            speedwave_runtime::consts::FieldStorage::WorkerMountedConfig => config_json
                .get(f.key)
                .and_then(|v| v.as_str())
                .map(|s| !s.is_empty())
                .unwrap_or(false),
            speedwave_runtime::consts::FieldStorage::WorkerMountedToken => {
                let path = svc_token_dir.join(f.key);
                std::fs::metadata(&path)
                    .map(|m| m.len() > 0)
                    .unwrap_or(false)
            }
        })
}

/// snake_case descriptor key → camelCase property name used in oauth.json.
/// Delegates to the runtime SSOT so the mapping lives in one place.
fn snake_to_oauth_json_key(key: &str) -> &str {
    speedwave_runtime::oauth_state_migration::oauth_json_key_for(key)
}

fn get_oauth_field<'a>(
    json: &'a serde_json::Value,
    storage: speedwave_runtime::consts::FieldStorage,
    key: &str,
) -> Option<&'a str> {
    use speedwave_runtime::consts::FieldStorage;
    let value = match storage {
        FieldStorage::OAuthStateProviderData => {
            let prop = snake_to_oauth_json_key(key);
            json.get("providerData").and_then(|p| p.get(prop))
        }
        FieldStorage::OAuthState => json.get(snake_to_oauth_json_key(key)),
        _ => return None,
    };
    value.and_then(|v| v.as_str())
}

#[cfg(test)]
fn is_service_configured_with_home(home: &std::path::Path, project: &str, service: &str) -> bool {
    let data_dir = home.join(speedwave_runtime::consts::DATA_DIR);
    is_service_configured_inner(&data_dir, project, service)
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
/// `resources_dir` is `Some(<BUNDLE_RESOURCES_ENV dir>)` in production (set by
/// main.rs); `None` selects the dev fallback `CARGO_MANIFEST_DIR ->
/// ../../native/macos/<pkg>/.build/release/<binary>`. Tests pass a tempdir.
// SYNC: binary paths must match mcp-servers/os/src/platform-runner.ts::resolveDarwinPaths()
fn resolve_native_cli_binary_in(
    service: &str,
    resources_dir: Option<&std::path::Path>,
) -> Result<std::path::PathBuf, String> {
    let (binary_name, pkg_dir) = match service {
        "reminders" => ("reminders-cli", "reminders"),
        "calendar" => ("calendar-cli", "calendar"),
        "mail" => ("mail-cli", "mail"),
        "notes" => ("notes-cli", "notes"),
        _ => return Err(format!("unknown OS service: {service}")),
    };

    if let Some(dir) = resources_dir {
        return Ok(dir.join(binary_name));
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
/// Expected format: `{"granted": true, "status": "granted"}` or
/// `{"granted": false, "status": "denied", "error": "..."}`.
/// The `status` field is parsed but not consumed — `error` is the single source
/// of user-facing text. Returns `Ok(())` if `granted` is boolean `true`.
/// Returns `Err(message)` if `granted` is `false`, missing, or non-boolean.
fn parse_permission_output(stdout: &str) -> Result<(), String> {
    let parsed: serde_json::Value = serde_json::from_str(stdout.trim())
        .map_err(|e| format!("Failed to parse permission check output: {e}"))?;

    let granted = parsed
        .get("granted")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    if granted {
        return Ok(());
    }

    // Per the Swift contract, granted=false ALWAYS carries a non-empty error string.
    // The status field is parsed but not consumed — error is the single source of
    // user-facing text. If the contract is violated (synthetic JSON, future bug),
    // fall through to a generic message.
    let raw_error = parsed
        .get("error")
        .and_then(|v| v.as_str())
        .unwrap_or("Permission denied");

    // Sanitize before returning to the webview. Defense-in-depth: error strings come
    // from the Swift side which uses static literals + EventKit localizedDescription,
    // but localizedDescription could in principle contain user paths in future macOS.
    Err(speedwave_runtime::log_sanitizer::sanitize(raw_error))
}

/// Checks macOS TCC/Automation permission for the given OS service.
///
/// Spawns the native CLI binary with `check_permission` and parses the JSON
/// output. Uses a spawn + try_wait polling loop with timeout (same pattern as
/// `speedwave_runtime::binary::run_with_timeout` but with stdout/stderr capture).
///
/// Pipe-buffer deadlock is not a risk: `check_permission` output is <200 bytes,
/// well within the OS pipe buffer of 64KB. Stdout is read after child exits.
fn check_os_permission(service: &str, launch_if_needed: bool) -> Result<(), String> {
    check_os_permission_with_timeout(
        service,
        launch_if_needed,
        std::time::Duration::from_secs(60),
    )
}

/// Inner implementation with configurable timeout for testability.
/// `launch_if_needed=true` (toggle click) lets the CLI auto-launch the target
/// app if not running. `false` (startup validate) keeps the check passive so
/// Speedwave never opens Mail/Notes uninvited at app boot.
fn check_os_permission_with_timeout(
    service: &str,
    launch_if_needed: bool,
    timeout: std::time::Duration,
) -> Result<(), String> {
    let resources_dir = std::env::var(speedwave_runtime::consts::BUNDLE_RESOURCES_ENV)
        .ok()
        .map(std::path::PathBuf::from);
    check_os_permission_with_timeout_in(
        service,
        launch_if_needed,
        timeout,
        resources_dir.as_deref(),
    )
}

/// Parameterised by `resources_dir` so unit tests pass a tempdir directly
/// instead of mutating the global `BUNDLE_RESOURCES_ENV`.
fn check_os_permission_with_timeout_in(
    service: &str,
    launch_if_needed: bool,
    timeout: std::time::Duration,
    resources_dir: Option<&std::path::Path>,
) -> Result<(), String> {
    let binary_path = resolve_native_cli_binary_in(service, resources_dir)?;
    log::info!(
        "check_os_permission: spawning {service}-cli check_permission launch={launch_if_needed} (binary={})",
        binary_path.display()
    );
    let spawn_started = std::time::Instant::now();

    let mut cmd = std::process::Command::new(&binary_path);
    cmd.arg("check_permission");
    if launch_if_needed {
        cmd.arg("--launch");
    }
    let mut child = cmd
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| {
            log::error!(
                "check_os_permission: spawn failed for {service}: {e} (binary={})",
                binary_path.display()
            );
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
                    log::warn!(
                        "check_os_permission: {service}-cli timed out after {}s",
                        timeout.as_secs()
                    );
                    return Err(format!(
                        "Permission check timed out after {}s. Try again.",
                        timeout.as_secs()
                    ));
                }
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
            Err(e) => {
                log::error!("check_os_permission: try_wait failed for {service}: {e}");
                return Err(format!("Permission check failed: {e}"));
            }
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

    let elapsed_ms = spawn_started.elapsed().as_millis();
    log::debug!(
        "check_os_permission: {service}-cli exited code={} elapsed_ms={elapsed_ms} stdout_len={} stderr_len={}",
        status.code().unwrap_or(-1),
        stdout.len(),
        stderr.len()
    );

    // Always surface Swift CLI stderr to the log — it carries the per-CLI trace
    // (AppleEvents OSStatus values, EventKit gate transitions) that's invaluable
    // when diagnosing TCC silent rejects from a user-supplied logs ZIP.
    if !stderr.trim().is_empty() {
        for line in stderr.lines() {
            log::info!("check_os_permission: {service}-cli stderr: {line}");
        }
    }

    if !status.success() {
        let detail = if stderr.trim().is_empty() {
            format!("exit code {}", status.code().unwrap_or(-1))
        } else {
            stderr.trim().to_string()
        };
        log::warn!(
            "check_os_permission: {service}-cli non-zero exit (code={}): {detail}",
            status.code().unwrap_or(-1)
        );
        return Err(format!("Permission check failed: {detail}"));
    }

    let parse_result = parse_permission_output(&stdout);
    match &parse_result {
        Ok(()) => log::info!("check_os_permission: {service} GRANTED"),
        Err(reason) => log::warn!("check_os_permission: {service} NOT GRANTED — {reason}"),
    }
    parse_result
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
        if let Err(reason) = check_os_permission(&service, true) {
            log::warn!(
                "set_os_integration_enabled: rejecting enable for {service} (project={project}) — {reason}"
            );
            return Err(reason);
        }
    }

    let result = config::with_config_lock(|| {
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
    .map_err(|e| e.to_string());

    match &result {
        Ok(()) => log::info!(
            "set_os_integration_enabled: persisted project={project} service={service} enabled={enabled}"
        ),
        Err(e) => log::error!(
            "set_os_integration_enabled: persist failed project={project} service={service} enabled={enabled} — {e}"
        ),
    }
    result
}

/// Result of validating one OS integration against the actual macOS TCC state.
/// Returned per-service to the frontend so the UI can render a toast for each
/// integration that was auto-disabled.
#[derive(serde::Serialize, Debug, Clone, PartialEq)]
pub struct OsIntegrationValidation {
    pub service: String,
    pub previous_enabled: bool,
    pub new_enabled: bool,
    pub reason: String,
}

/// Reconcile enabled OS integrations with live macOS TCC state — auto-disable
/// any whose permission no longer holds. No-op on non-macOS. Migration path
/// for the embedded-Info.plist identifier change is in ADR-049.
#[tauri::command]
pub fn validate_os_integrations_on_startup(
    project: String,
) -> Result<Vec<OsIntegrationValidation>, String> {
    if !cfg!(target_os = "macos") {
        log::debug!(
            "validate_os_integrations_on_startup: skipping on non-macOS host (project={project})"
        );
        return Ok(Vec::new());
    }
    check_project(&project)?;
    log::info!("validate_os_integrations_on_startup: project={project} — start");

    // SSOT: list of OS services to validate comes from speedwave_runtime::consts.
    let os_services: Vec<&'static str> = speedwave_runtime::consts::TOGGLEABLE_OS_SERVICES
        .iter()
        .map(|s| s.config_key)
        .collect();

    // Phase 1: short config_lock — snapshot enabled state per service.
    // Holding the lock through ~400ms parallel CLI runs would block any
    // concurrent toggle/restart from the UI; snapshot-then-unlock keeps the
    // lock window in microseconds.
    let prev_state: std::collections::HashMap<&'static str, bool> = config::with_config_lock(|| {
        let user_config = config::load_user_config()?;
        let entry = user_config
            .find_project(&project)
            .ok_or_else(|| anyhow::anyhow!("project '{}' not found in config", project))?;
        let os_cfg = entry.integrations.as_ref().and_then(|i| i.os.as_ref());
        Ok(os_services
            .iter()
            .map(|svc| {
                let enabled = os_cfg
                    .and_then(|os| os.get_service(svc))
                    .and_then(|cfg| cfg.enabled)
                    .unwrap_or(false);
                (*svc, enabled)
            })
            .collect())
    })
    .map_err(|e: anyhow::Error| {
        log::error!("validate_os_integrations_on_startup: config snapshot failure for project={project}: {e}");
        e.to_string()
    })?;

    let to_check: Vec<&'static str> = os_services
        .iter()
        .filter(|svc| *prev_state.get(*svc).unwrap_or(&false))
        .copied()
        .collect();
    let already_disabled = os_services.len() - to_check.len();
    let checked = to_check.len();
    for svc in &os_services {
        if !*prev_state.get(svc).unwrap_or(&false) {
            log::debug!(
                "validate_os_integrations_on_startup: skipping {svc} (already disabled in config)"
            );
        }
    }

    // Phase 2: parallel CLI checks — each spawn-and-wait is ~200-400ms; 4
    // sequential = ~1.4s. Parallel = bounded by the slowest CLI (~400ms).
    // No config lock held here.
    let handles: Vec<(&'static str, std::thread::JoinHandle<Result<(), String>>)> = to_check
        .into_iter()
        .map(|svc| {
            log::info!(
                "validate_os_integrations_on_startup: checking {svc} (currently enabled in config)"
            );
            let handle = std::thread::spawn(move || check_os_permission(svc, false));
            (svc, handle)
        })
        .collect();

    let mut validations: Vec<OsIntegrationValidation> = Vec::new();
    let mut to_disable: Vec<&'static str> = Vec::new();
    for (svc, handle) in handles {
        let result = handle
            .join()
            .unwrap_or_else(|_| Err(format!("validate worker thread for {svc} panicked")));
        match result {
            Ok(()) => log::info!(
                "validate_os_integrations_on_startup: {svc} VALID (TCC granted, keeping enabled)"
            ),
            Err(reason) => {
                log::warn!(
                    "validate_os_integrations_on_startup: auto-disabling {svc} (was enabled, TCC reports: {reason})"
                );
                to_disable.push(svc);
                validations.push(OsIntegrationValidation {
                    service: svc.to_string(),
                    previous_enabled: true,
                    new_enabled: false,
                    reason,
                });
            }
        }
    }

    // Phase 3: short config_lock — apply mutations only when there's something
    // to write. Skipping the lock entirely on the no-op path keeps the happy
    // case zero-contention.
    if !to_disable.is_empty() {
        config::with_config_lock(|| {
            let mut user_config = config::load_user_config()?;
            let entry = user_config
                .find_project_mut(&project)
                .ok_or_else(|| anyhow::anyhow!("project '{}' not found in config", project))?;
            let integrations = entry.integrations.get_or_insert_with(Default::default);
            let os = integrations.os.get_or_insert_with(Default::default);
            for svc in &to_disable {
                os.set_service(
                    svc,
                    config::IntegrationConfig {
                        enabled: Some(false),
                    },
                );
            }
            config::save_user_config(&user_config)
        })
        .map_err(|e| {
            log::error!(
                "validate_os_integrations_on_startup: config persist failure for project={project}: {e}"
            );
            e.to_string()
        })?;
    }

    log::info!(
        "validate_os_integrations_on_startup: project={project} done — total_services={} checked={checked} skipped_already_disabled={already_disabled} auto_disabled={} services=[{}]",
        os_services.len(),
        validations.len(),
        validations.iter().map(|v| v.service.as_str()).collect::<Vec<_>>().join(",")
    );

    Ok(validations)
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

    // Redmine stores some fields in `config.json` rather than as individual
    // files; route through its dedicated handler. The Redmine pattern is the
    // only built-in service that uses `WorkerMountedConfig`, so a per-service
    // dispatch is simpler than weaving config.json semantics into the generic
    // routing below.
    if service == "redmine" {
        return save_redmine_credentials(&svc_dir, &credentials, allowed);
    }

    // Generic routing driven by `FieldStorage` (plan §PR3:290-299). Each UI
    // field lands in the storage tier its descriptor declares — `OAuthState`
    // fields are merged into `oauth/<project>/<service>.json`, everything
    // else lands in the worker-mounted tokens dir. Adding a new OAuth-using
    // service means flipping `storage` on its descriptor; no edit here.
    save_with_field_storage(&project, &service, &svc_dir, &credentials)
}

/// Generic per-field routing of UI credentials by `FieldStorage` tier.
/// Partitions `credentials` into the worker-mounted file set and the OAuth
/// state JSON merge set, then writes both atomically with `0o600`.
fn save_with_field_storage(
    project: &str,
    service: &str,
    svc_dir: &std::path::Path,
    credentials: &std::collections::HashMap<String, String>,
) -> Result<(), String> {
    use std::collections::HashMap;
    let svc_desc = speedwave_runtime::consts::find_mcp_service(service)
        .ok_or_else(|| format!("unknown service: {}", service))?;

    let mut to_oauth_json: HashMap<&str, (speedwave_runtime::consts::FieldStorage, &str)> =
        HashMap::new();
    let mut to_tokens_dir: HashMap<&str, &str> = HashMap::new();
    for (key, value) in credentials {
        if !crate::types::is_allowed_field(service, key) {
            return Err(format!(
                "field '{}' not allowed for service '{}'",
                key, service
            ));
        }
        validate_credential_field(key, value)?;
        match crate::types::field_storage(service, key) {
            Some(s @ speedwave_runtime::consts::FieldStorage::OAuthState)
            | Some(s @ speedwave_runtime::consts::FieldStorage::OAuthStateProviderData) => {
                to_oauth_json.insert(key.as_str(), (s, value.as_str()));
            }
            _ => {
                to_tokens_dir.insert(key.as_str(), value.as_str());
            }
        }
    }

    for (key, value) in &to_tokens_dir {
        let file_path = svc_dir.join(key);
        speedwave_runtime::fs_perms::write_restricted_file(&file_path, value)
            .map_err(|e| e.to_string())?;
    }

    if !to_oauth_json.is_empty() {
        if svc_desc.oauth_state_fields.is_none() {
            return Err(format!(
                "service '{}' has no oauth_state_fields but received OAuth-state values",
                service
            ));
        }
        merge_oauth_state_json(project, service, &to_oauth_json)?;
    }
    Ok(())
}

/// Read-modify-write merge into `oauth/<project>/<service>.json`. `provider`
/// is derived from the descriptor; IdP-specific fields land under
/// `providerData`, the rest stay top-level (ADR-060 schema). 0o600 preserved.
fn merge_oauth_state_json(
    project: &str,
    service: &str,
    fields: &std::collections::HashMap<&str, (speedwave_runtime::consts::FieldStorage, &str)>,
) -> Result<(), String> {
    merge_oauth_state_json_in(
        speedwave_runtime::consts::data_dir(),
        project,
        service,
        fields,
    )
}

/// Parameterised by `data_dir` so unit tests avoid the `consts::data_dir()`
/// `OnceLock` cache. Production callers go through `merge_oauth_state_json`.
fn merge_oauth_state_json_in(
    data_dir: &std::path::Path,
    project: &str,
    service: &str,
    fields: &std::collections::HashMap<&str, (speedwave_runtime::consts::FieldStorage, &str)>,
) -> Result<(), String> {
    use speedwave_runtime::consts::FieldStorage;
    let provider = provider_id_for_service(service)
        .ok_or_else(|| format!("service '{service}' has no provider id mapping"))?;
    let path = speedwave_runtime::plugin::oauth_state_file_in(data_dir, project, service);
    let parent = path.parent().ok_or_else(|| "no parent".to_string())?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    let mut state: serde_json::Value = read_existing_oauth_state(&path, provider)?;
    let obj = state
        .as_object_mut()
        .ok_or_else(|| "oauth state must be a JSON object".to_string())?;
    speedwave_runtime::oauth_state_migration::ensure_provider_data_object(obj);
    for (key, (storage, value)) in fields {
        let prop = snake_to_oauth_json_key(key).to_string();
        match storage {
            FieldStorage::OAuthStateProviderData => {
                if let Some(pd) = obj.get_mut("providerData").and_then(|v| v.as_object_mut()) {
                    pd.insert(prop, serde_json::json!(value));
                }
            }
            FieldStorage::OAuthState => {
                obj.insert(prop, serde_json::json!(value));
            }
            _ => {
                return Err(format!("field '{key}' is not an OAuth-state storage tier"));
            }
        }
    }
    let body = serde_json::to_string_pretty(&state).map_err(|e| e.to_string())? + "\n";
    speedwave_runtime::fs_perms::write_restricted_file(&path, &body).map_err(|e| e.to_string())
}

/// Corrupt JSON: warn + fresh skeleton (silent loss would orphan the user).
fn read_existing_oauth_state(
    path: &std::path::Path,
    provider: &str,
) -> Result<serde_json::Value, String> {
    if !path.exists() {
        return Ok(fresh_oauth_skeleton(provider));
    }
    let raw = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    match serde_json::from_str(&raw) {
        Ok(v) => Ok(v),
        Err(e) => {
            log::warn!(
                "oauth state at {} is corrupt — replacing skeleton, losing pre-existing fields ({e})",
                path.display()
            );
            Ok(fresh_oauth_skeleton(provider))
        }
    }
}

fn fresh_oauth_skeleton(provider: &str) -> serde_json::Value {
    serde_json::json!({ "provider": provider, "providerData": {} })
}

fn provider_id_for_service(service: &str) -> Option<&'static str> {
    match service {
        "sharepoint" => Some(crate::oauth_providers::MICROSOFT_PROVIDER_ID),
        _ => None,
    }
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
    speedwave_runtime::fs_perms::write_restricted_file(&config_path, &json)
        .map_err(|e| e.to_string())?;

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

    // ADR-060: also remove the host-only oauth.json. Top-level (refreshToken,
    // scopes, timing) + nested providerData are managed by the oauth worker.
    let svc_desc = speedwave_runtime::consts::find_mcp_service(&service);
    if svc_desc.is_some_and(|d| d.oauth_state_fields.is_some()) {
        let oauth_path = speedwave_runtime::plugin::oauth_state_file(&project, &service);
        if oauth_path.exists() {
            std::fs::remove_file(&oauth_path).map_err(|e| e.to_string())?;
        }
    }

    // Optional-only services (e.g. context7) keep working in anonymous mode after
    // credential removal — skip auto-disable so the toggle stays as the user left it.
    let all_optional = svc_desc
        .map(|d| !d.auth_fields.is_empty() && d.auth_fields.iter().all(|f| f.optional))
        .unwrap_or(false);

    if !all_optional {
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
    }

    Ok(())
}

/// Builds missing worker images for `project`. Returns sanitized error on failure.
pub fn ensure_project_images_built(
    rt: &speedwave_runtime::runtime::LockedRuntime,
    project: &str,
) -> Result<(), String> {
    let user_config = speedwave_runtime::config::load_user_config()
        .map_err(|e| format!("failed to load user config: {e}"))?;
    let dir = user_config
        .require_project(project)
        .map_err(|e| e.to_string())?
        .dir
        .clone();
    let integrations = speedwave_runtime::config::resolve_integrations(
        std::path::Path::new(&dir),
        &user_config,
        project,
    );
    let manifest = speedwave_runtime::bundle::load_current_bundle_manifest()
        .map_err(|e| format!("failed to load bundle manifest: {e}"))?;
    let enabled = speedwave_runtime::build::enabled_images(&integrations);
    speedwave_runtime::build::build_missing_images(rt, &enabled, &manifest.bundle_id)
        .map_err(|e| log_sanitizer::sanitize(&format!("{e:#}")))?;

    // Plugin images must also be built outside the compose lock (ADR-066).
    let enabled_plugin_ids = integrations.enabled_plugin_service_ids();
    speedwave_runtime::plugin::ensure_plugin_images(rt, &enabled_plugin_ids)
        .map_err(|e| log_sanitizer::sanitize(&format!("{e:#}")))?;
    Ok(())
}

/// Removes worker images that `project` no longer enables. Per-project scope
/// (ADR-057): switching to a project that needs a pruned image triggers a
/// lazy build. Warn-only — failure never blocks restart.
fn prune_unused_worker_images(rt: &speedwave_runtime::runtime::LockedRuntime, project: &str) {
    let user_config = match speedwave_runtime::config::load_user_config() {
        Ok(c) => c,
        Err(e) => {
            log::warn!("prune_unused_worker_images: load_user_config failed: {e}");
            return;
        }
    };
    let dir = match user_config.find_project(project) {
        Some(p) => p.dir.clone(),
        None => {
            log::warn!("prune_unused_worker_images: project '{project}' not in config");
            return;
        }
    };
    let integrations = speedwave_runtime::config::resolve_integrations(
        std::path::Path::new(&dir),
        &user_config,
        project,
    );
    let keep = speedwave_runtime::build::enabled_images(&integrations);
    let manifest = match speedwave_runtime::bundle::load_current_bundle_manifest() {
        Ok(m) => m,
        Err(e) => {
            log::warn!("prune_unused_worker_images: load manifest failed: {e}");
            return;
        }
    };
    if let Err(e) =
        speedwave_runtime::build::prune_orphan_current_bundle_images(rt, &manifest.bundle_id, &keep)
    {
        log::warn!("prune_unused_worker_images failed: {e}");
    }
}

/// Rolls a service back to `enabled: false`; called when on-demand build fails.
fn rollback_integration_to_disabled(project: &str, service: &str) {
    let result = config::with_config_lock(|| {
        let mut user_config = config::load_user_config()?;
        let entry = user_config
            .find_project_mut(project)
            .ok_or_else(|| anyhow::anyhow!("project '{project}' not found"))?;
        let integrations = entry.integrations.get_or_insert_with(Default::default);
        let cfg = config::IntegrationConfig {
            enabled: Some(false),
        };
        if !integrations.set_service(service, cfg) {
            return Err(anyhow::anyhow!("unknown service: {service}"));
        }
        config::save_user_config(&user_config)
    });
    if let Err(e) = result {
        log::warn!("rollback of '{service}' to disabled failed: {e}");
    }
}

#[tauri::command]
pub async fn restart_integration_containers(
    project: String,
    just_enabled: Option<String>,
    oauth: tauri::State<'_, crate::reconcile::SharedOauth>,
) -> Result<(), String> {
    let oauth_arc = oauth.inner().clone();
    tokio::task::spawn_blocking(move || {
        crate::containers_cmd::ensure_images_ready()?;
        check_project(&project)?;
        // Pre-flight: detect CloudStorage TCC denial before restarting containers.
        if let Ok(cfg) = speedwave_runtime::config::load_user_config() {
            if let Some(p) = cfg.find_project(&project) {
                speedwave_runtime::cloudstorage::check_project_readable_or_err(
                    std::path::Path::new(&p.dir),
                )?;
            }
        }
        log::info!(
            "restart_integration_containers: project={project} just_enabled={just_enabled:?}"
        );
        let rt = speedwave_runtime::runtime::detect_runtime();
        rt.ensure_ready().map_err(|e| e.to_string())?;

        // Build OUTSIDE the compose lock (ADR-066). On failure, undo the
        // just-enabled config toggle but leave running containers intact.
        if let Err(sanitized) = ensure_project_images_built(&rt, &project) {
            log::error!("restart_integration_containers: image build failed: {sanitized}");
            if let Some(svc) = just_enabled.as_deref() {
                rollback_integration_to_disabled(&project, svc);
            }
            return Err(format!(
                "Image build failed: {sanitized}. Containers are still running with the previous configuration."
            ));
        }

        rt.transaction(&project, |rt| -> anyhow::Result<()> {
            // Hard-fail only on real IO errors (disk full, permission denied);
            // save_snapshot returns Ok(()) when compose.yml doesn't exist yet.
            speedwave_runtime::update::save_snapshot(&project).map_err(|e| {
                anyhow::anyhow!(
                    "Cannot safely restart: failed to write rollback snapshot ({e})"
                )
            })?;

            rt.compose_down(&project).map_err(|e| {
                log::error!("restart_integration_containers: compose_down error: {e}");
                anyhow::anyhow!("{e}")
            })?;

            // Respawn the oauth worker before compose render so the bearer-map
            // is current after a plugin OAuth toggle (ADR-069). Best-effort.
            crate::ensure_oauth_running(&oauth_arc, &project);

            use crate::types::IntoAnyhow;
            crate::containers_cmd::render_and_save_compose(&project).into_anyhow()?;

            // Both validate and up_recreate are post-compose_down; either failing
            // leaves containers stopped, so both require rollback.
            let recreate_result = speedwave_runtime::runtime::compose_validate_with_retry(
                rt, &project,
            )
            .and_then(|()| rt.compose_up_recreate(&project));

            if let Err(e) = recreate_result {
                log::error!(
                    "restart_integration_containers: recreate failed: {e}, attempting rollback"
                );
                // Nested transaction: rollback acquires its own — reentrant via HELD_LOCKS.
                if let Err(rb_err) = speedwave_runtime::update::rollback_containers(rt, &project) {
                    log::error!("restart_integration_containers: rollback also failed: {rb_err}");
                    anyhow::bail!(
                        "Restart failed: {e}. Rollback also failed: {rb_err}. Containers are stopped. Run speedwave to restart manually."
                    );
                }
                anyhow::bail!("Restart failed: {e}. Rolled back to previous configuration.");
            }

            Ok(())
        })
        .map_err(|e| e.to_string())?;

        prune_unused_worker_images(&rt, &project);

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

    /// Drift guard: the camelCase JSON keys the Desktop save-path derives from the
    /// `OAuthStateProviderData` descriptors (via `snake_to_oauth_json_key`, which
    /// delegates to the runtime SSOT) must equal the runtime `IDENTITY_KEYS` the
    /// migration nests under `providerData`. Catches a descriptor/mapping change
    /// that would desync the two write paths.
    #[test]
    fn provider_data_descriptor_keys_match_runtime_identity_keys() {
        let mut got: Vec<&str> = speedwave_runtime::consts::TOGGLEABLE_MCP_SERVICES
            .iter()
            .flat_map(|svc| svc.auth_fields.iter())
            .filter(|f| {
                f.storage == speedwave_runtime::consts::FieldStorage::OAuthStateProviderData
            })
            .map(|f| snake_to_oauth_json_key(f.key))
            .collect();
        got.sort_unstable();
        got.dedup();

        let mut expected: Vec<&str> =
            speedwave_runtime::oauth_state_migration::IDENTITY_KEYS.to_vec();
        expected.sort_unstable();

        assert_eq!(
            got, expected,
            "Desktop providerData descriptor keys drifted from runtime IDENTITY_KEYS"
        );
    }

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
        for key in &[
            "slack",
            "sharepoint",
            "redmine",
            "gitlab",
            "github",
            "atlassian",
            "office",
            "playwright",
        ] {
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

    // -- detect_scope_mismatch_or_stale tests (PR3 / FIX-P1-4 re-consent banner) --

    fn well_formed_state(granted: &[&str]) -> String {
        serde_json::json!({
            "provider": "microsoft",
            "providerData": { "clientId": "cid", "tenantId": "tid" },
            "grantedScopes": granted,
        })
        .to_string()
    }

    #[test]
    fn detect_scope_mismatch_returns_mismatch_when_granted_is_empty() {
        let raw = well_formed_state(&[]);
        let required = vec!["sites.manage.all".to_string()];
        assert_eq!(
            detect_scope_mismatch_or_stale(&raw, &required),
            ReauthorizeReason::ScopeMismatch
        );
    }

    #[test]
    fn detect_scope_mismatch_returns_mismatch_when_granted_is_strict_subset() {
        let raw = well_formed_state(&["user.read"]);
        let required = vec!["sites.manage.all".to_string(), "user.read".to_string()];
        assert_eq!(
            detect_scope_mismatch_or_stale(&raw, &required),
            ReauthorizeReason::ScopeMismatch
        );
    }

    #[test]
    fn detect_scope_mismatch_returns_ok_when_granted_covers_required() {
        let raw = well_formed_state(&[
            "sites.manage.all",
            "user.read",
            "files.readwrite.all",
            "offline_access",
        ]);
        let required = vec!["sites.manage.all".to_string(), "user.read".to_string()];
        assert_eq!(
            detect_scope_mismatch_or_stale(&raw, &required),
            ReauthorizeReason::Ok
        );
    }

    #[test]
    fn detect_scope_mismatch_returns_ok_when_granted_matches_with_different_case() {
        // grantedScopes come back in mixed case from Microsoft (e.g.
        // `Sites.Manage.All`). The helper normalises both sides.
        let raw = well_formed_state(&["Sites.Manage.All", "User.Read"]);
        let required = vec!["sites.manage.all".to_string(), "user.read".to_string()];
        assert_eq!(
            detect_scope_mismatch_or_stale(&raw, &required),
            ReauthorizeReason::Ok
        );
    }

    // Microsoft echoes the fully-qualified resource scopes (e.g.
    // `https://graph.microsoft.com/sites.manage.all`) in grantedScopes, never
    // `offline_access`. These mirror the live `documents` / `speedwave` files.
    const GRAPH_RESOURCE_SCOPES: &[&str] = &[
        "https://graph.microsoft.com/sites.manage.all",
        "https://graph.microsoft.com/files.readwrite.all",
        "https://graph.microsoft.com/user.read",
    ];

    #[test]
    fn detect_scope_mismatch_ok_when_all_resource_scopes_granted_but_offline_access_absent() {
        // The `documents` live case: every resource scope present, only
        // `offline_access` "missing" — Microsoft never echoes it. Must be Ok.
        let raw = well_formed_state(GRAPH_RESOURCE_SCOPES);
        let required = sharepoint_required_scopes(); // includes offline_access
        assert!(required.iter().any(|r| r == OFFLINE_ACCESS_SCOPE));
        assert_eq!(
            detect_scope_mismatch_or_stale(&raw, &required),
            ReauthorizeReason::Ok
        );
    }

    #[test]
    fn detect_scope_mismatch_still_trips_when_a_real_resource_scope_is_missing() {
        // Excluding offline_access must NOT mask a genuinely missing resource
        // scope (here: sites.manage.all absent).
        let raw = well_formed_state(&[
            "https://graph.microsoft.com/files.readwrite.all",
            "https://graph.microsoft.com/user.read",
        ]);
        let required = sharepoint_required_scopes();
        assert_eq!(
            detect_scope_mismatch_or_stale(&raw, &required),
            ReauthorizeReason::ScopeMismatch
        );
    }

    #[test]
    fn detect_scope_mismatch_ok_when_offline_access_also_present() {
        // A freshly re-authed file that happens to carry offline_access in
        // grantedScopes must still be Ok (the `speedwave` live case).
        let mut granted: Vec<&str> = GRAPH_RESOURCE_SCOPES.to_vec();
        granted.push("offline_access");
        let raw = well_formed_state(&granted);
        let required = sharepoint_required_scopes();
        assert_eq!(
            detect_scope_mismatch_or_stale(&raw, &required),
            ReauthorizeReason::Ok
        );
    }

    #[test]
    fn detect_scope_mismatch_stale_guard_unaffected_by_offline_access_filter() {
        // The Stale guards (missing providerData / grantedScopes) take priority
        // over the coverage check — filtering offline_access must not change that.
        let raw = r#"{"provider":"microsoft","providerData":{"clientId":"c"}}"#;
        let required = sharepoint_required_scopes();
        assert_eq!(
            detect_scope_mismatch_or_stale(raw, &required),
            ReauthorizeReason::Stale
        );
    }

    #[test]
    fn detect_scope_mismatch_returns_stale_on_malformed_json() {
        let required = vec!["sites.manage.all".to_string()];
        assert_eq!(
            detect_scope_mismatch_or_stale("not-json", &required),
            ReauthorizeReason::Stale
        );
    }

    #[test]
    fn detect_scope_mismatch_returns_stale_on_non_object_root() {
        let required = vec!["sites.manage.all".to_string()];
        assert_eq!(
            detect_scope_mismatch_or_stale("[1,2,3]", &required),
            ReauthorizeReason::Stale
        );
        assert_eq!(
            detect_scope_mismatch_or_stale("null", &required),
            ReauthorizeReason::Stale
        );
    }

    #[test]
    fn detect_scope_mismatch_returns_stale_when_provider_data_missing() {
        // Pre-OAuthProvider-refactor files lack `providerData` — UI banner
        // must surface re-consent to migrate the user forward.
        let raw = r#"{"provider":"microsoft","grantedScopes":["sites.manage.all","user.read","files.readwrite.all","offline_access"]}"#;
        let required = vec!["sites.manage.all".to_string()];
        assert_eq!(
            detect_scope_mismatch_or_stale(raw, &required),
            ReauthorizeReason::Stale
        );
    }

    #[test]
    fn detect_scope_mismatch_returns_stale_on_empty_object() {
        let required = vec!["sites.manage.all".to_string()];
        assert_eq!(
            detect_scope_mismatch_or_stale("{}", &required),
            ReauthorizeReason::Stale
        );
    }

    #[test]
    fn detect_scope_mismatch_returns_stale_when_provider_data_is_not_object() {
        let raw = r#"{"provider":"microsoft","providerData":"oops","grantedScopes":["sites.manage.all"]}"#;
        let required = vec!["sites.manage.all".to_string()];
        assert_eq!(
            detect_scope_mismatch_or_stale(raw, &required),
            ReauthorizeReason::Stale
        );
    }

    #[test]
    fn detect_scope_mismatch_returns_stale_when_grantedscopes_missing() {
        let raw = r#"{"provider":"microsoft","providerData":{"clientId":"cid","tenantId":"tid"}}"#;
        let required = vec!["sites.manage.all".to_string()];
        assert_eq!(
            detect_scope_mismatch_or_stale(raw, &required),
            ReauthorizeReason::Stale
        );
    }

    #[test]
    fn detect_oauth_action_required_only_acts_on_sharepoint() {
        // For non-sharepoint services we never even read the oauth.json — the
        // fact that consts::data_dir() may be unrelated/empty must not matter.
        assert!(detect_oauth_action_required("any-project", "slack").is_none());
        assert!(detect_oauth_action_required("any-project", "redmine").is_none());
        assert!(detect_oauth_action_required("any-project", "gitlab").is_none());
    }

    #[test]
    fn detect_oauth_action_required_none_when_file_absent() {
        // Fresh, never-configured SharePoint: no file → no banner.
        let tmp = tempfile::tempdir().unwrap();
        assert!(detect_oauth_action_required_in(tmp.path(), "p", "sharepoint").is_none());
    }

    #[test]
    fn detect_oauth_action_required_some_when_present_but_stale() {
        // Present file with malformed providerData (the bug state): the service
        // reads as unconfigured, but the banner MUST still fire so the user can
        // re-authorise. Stale collapses to "scope_mismatch".
        let tmp = tempfile::tempdir().unwrap();
        let path = speedwave_runtime::plugin::oauth_state_file_in(tmp.path(), "p", "sharepoint");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            r#"{"provider":"microsoft","clientId":"cid","tenantId":"tid"}"#,
        )
        .unwrap();

        assert_eq!(
            detect_oauth_action_required_in(tmp.path(), "p", "sharepoint"),
            Some("scope_mismatch".to_string())
        );
    }

    #[test]
    fn detect_oauth_action_required_none_when_well_formed_and_scopes_cover() {
        // A fully valid file covering required scopes → no banner.
        let tmp = tempfile::tempdir().unwrap();
        let path = speedwave_runtime::plugin::oauth_state_file_in(tmp.path(), "p", "sharepoint");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let granted: Vec<String> = sharepoint_required_scopes();
        std::fs::write(
            &path,
            serde_json::json!({
                "provider": "microsoft",
                "providerData": { "clientId": "cid", "tenantId": "tid" },
                "grantedScopes": granted,
            })
            .to_string(),
        )
        .unwrap();

        assert!(detect_oauth_action_required_in(tmp.path(), "p", "sharepoint").is_none());
    }

    #[test]
    fn sharepoint_required_scopes_matches_ssot_lowercased() {
        let scopes = sharepoint_required_scopes();
        let expected: Vec<String> = speedwave_runtime::consts::SHAREPOINT_OAUTH_SCOPES
            .split_whitespace()
            .map(|s| s.to_lowercase())
            .collect();
        assert_eq!(scopes, expected);
        // Sanity: PR3 bumped this to include Sites.Manage.All.
        assert!(scopes.iter().any(|s| s.contains("sites.manage.all")));
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

    #[cfg(target_os = "windows")]
    #[test]
    fn set_os_integration_enabled_rejects_on_windows() {
        let result = set_os_integration_enabled("test".into(), "reminders".into(), true);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("only available on macOS"));
    }

    // -- validate_os_integrations_on_startup --
    //
    // The full happy/error/state-transition path requires a temporary
    // ~/.speedwave/ data dir and a mocked native CLI that returns scripted
    // status JSON. That harness already exists for set_os_integration_enabled
    // tests at the integration level (run via `make test-desktop`). The unit
    // tests here cover the boundary behaviour reachable without spawning
    // child processes.

    #[cfg(target_os = "windows")]
    #[test]
    fn validate_os_integrations_returns_empty_on_windows() {
        // OS integrations are macOS-only — the validator must short-circuit
        // with Ok([]) on Windows hosts so the Angular ngOnInit hook can call
        // it unconditionally.
        let result = validate_os_integrations_on_startup("test".into());
        assert!(result.is_ok(), "expected Ok on non-macOS, got {result:?}");
        assert_eq!(
            result.unwrap(),
            Vec::<OsIntegrationValidation>::new(),
            "non-macOS host must return empty validation list, not auto-disable anything"
        );
    }

    #[test]
    fn os_integration_validation_serializes_to_camel_case_for_frontend() {
        // The Tauri command return type is consumed by Angular as
        // OsIntegrationValidation in models/integration.ts — the field names
        // must serialize to snake_case (Rust default). If a future PR adds
        // serde rename rules, this test catches the drift before frontend
        // breaks at runtime.
        let v = OsIntegrationValidation {
            service: "calendar".to_string(),
            previous_enabled: true,
            new_enabled: false,
            reason: "tccutil reset Calendar pl.speedwave.desktop.calendar".to_string(),
        };
        let json = serde_json::to_string(&v).unwrap();
        assert!(json.contains(r#""service":"calendar""#));
        assert!(json.contains(r#""previous_enabled":true"#));
        assert!(json.contains(r#""new_enabled":false"#));
        assert!(json.contains(r#""reason":"tccutil reset Calendar pl.speedwave.desktop.calendar""#));
    }

    #[test]
    fn os_integrations_config_get_service_covers_every_toggleable_service() {
        // SSOT alignment: get_service must accept every config_key in
        // TOGGLEABLE_OS_SERVICES. A new entry without a matching arm would
        // make the validator silently skip the service.
        use speedwave_runtime::config::{IntegrationConfig, OsIntegrationsConfig};
        let mut cfg = OsIntegrationsConfig::default();
        for svc in speedwave_runtime::consts::TOGGLEABLE_OS_SERVICES {
            assert!(
                cfg.set_service(
                    svc.config_key,
                    IntegrationConfig {
                        enabled: Some(true)
                    }
                ),
                "set_service must accept '{}'",
                svc.config_key
            );
            let got = cfg.get_service(svc.config_key);
            assert!(
                got.is_some(),
                "get_service must round-trip '{}'",
                svc.config_key
            );
            assert_eq!(got.and_then(|c| c.enabled), Some(true));
        }
    }

    #[test]
    fn os_integrations_config_get_service_rejects_unknown() {
        use speedwave_runtime::config::OsIntegrationsConfig;
        let cfg = OsIntegrationsConfig::default();
        assert!(cfg.get_service("contacts").is_none());
        assert!(cfg.get_service("").is_none());
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

        let build_pos = fn_body.find("ensure_project_images_built").expect(
            "ensure_project_images_built call must exist in restart_integration_containers",
        );
        let down_pos = fn_body
            .find("compose_down")
            .expect("compose_down call must exist in restart_integration_containers");

        assert!(
            build_pos < down_pos,
            "ensure_project_images_built (offset {}) must appear before compose_down (offset {}) in restart_integration_containers",
            build_pos,
            down_pos
        );
    }

    #[test]
    fn restart_reconciles_oauth_worker_before_compose_render() {
        // The oauth worker must respawn before compose render so the bearer-map
        // is current after a plugin OAuth toggle.
        let source = include_str!("integrations_cmd.rs");
        let fn_start = source
            .find("fn restart_integration_containers(")
            .expect("restart_integration_containers function must exist");
        let fn_body = &source[fn_start..];

        let oauth_pos = fn_body
            .find("ensure_oauth_running")
            .expect("restart must reconcile the oauth worker (ensure_oauth_running)");
        let render_pos = fn_body
            .find("render_and_save_compose")
            .expect("render_and_save_compose call must exist");
        assert!(
            oauth_pos < render_pos,
            "ensure_oauth_running (offset {oauth_pos}) must run before render_and_save_compose (offset {render_pos})"
        );
    }

    #[test]
    fn restart_rolls_back_just_enabled_on_build_failure() {
        // Structural: the build-failure branch must call the rollback helper
        // with the `just_enabled` arg so the toggled-on row reverts in the UI.
        let source = include_str!("integrations_cmd.rs");
        let fn_start = source
            .find("fn restart_integration_containers(")
            .expect("restart_integration_containers function must exist");
        let fn_body = &source[fn_start..];
        // The Err arm of ensure_project_images_built must call rollback_integration_to_disabled.
        let build_pos = fn_body
            .find("ensure_project_images_built")
            .expect("ensure_project_images_built must exist");
        let err_block = &fn_body[build_pos..build_pos.saturating_add(800)];
        assert!(
            err_block.contains("rollback_integration_to_disabled"),
            "build failure must call rollback_integration_to_disabled, context: {err_block}"
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

    #[test]
    fn restart_integration_containers_waits_for_image_readiness() {
        // Race guard: bundle reconcile may be rebuilding images while a user
        // toggles an integration; without this gate, compose_up_recreate would
        // surface "image not available" through nerdctl to the user.
        let source = include_str!("integrations_cmd.rs");
        let fn_start = source
            .find("fn restart_integration_containers(")
            .expect("restart_integration_containers function must exist");
        let fn_body = &source[fn_start..];

        let ensure_pos = fn_body
            .find("ensure_images_ready")
            .expect("restart_integration_containers must call ensure_images_ready");
        let up_pos = fn_body
            .find("compose_up_recreate")
            .expect("compose_up_recreate must exist in restart_integration_containers");
        assert!(
            ensure_pos < up_pos,
            "ensure_images_ready must come BEFORE compose_up_recreate"
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
        // but client_id/tenant_id/site_id are missing → false
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
        // SharePoint after base_path removal: access_token + site_id are
        // worker-mounted; refresh_token / client_id / tenant_id live in
        // oauth.json. is_service_configured_with_home checks the worker-mounted
        // dir (we feed minimum), and the OAuthState fields via the JSON.
        let tmp = tempfile::tempdir().unwrap();
        let svc_dir = make_svc_token_dir(tmp.path(), "proj", "sharepoint");
        std::fs::write(svc_dir.join("access_token"), "tok").unwrap();
        std::fs::write(svc_dir.join("site_id"), "my-site").unwrap();

        let oauth_dir = tmp.path().join(".speedwave").join("oauth").join("proj");
        std::fs::create_dir_all(&oauth_dir).unwrap();
        std::fs::write(
            oauth_dir.join("sharepoint.json"),
            serde_json::json!({
                "provider": "microsoft",
                "providerData": {
                    "clientId": "550e8400-e29b-41d4-a716-446655440000",
                    "tenantId": "common",
                },
                "refreshToken": "ref",
            })
            .to_string(),
        )
        .unwrap();

        assert!(
            is_service_configured_with_home(tmp.path(), "proj", "sharepoint"),
            "should be true when all auth_fields are present"
        );
    }

    #[test]
    fn is_service_configured_returns_false_for_pre_provider_data_layout() {
        let tmp = tempfile::tempdir().unwrap();
        let svc_dir = make_svc_token_dir(tmp.path(), "proj", "sharepoint");
        std::fs::write(svc_dir.join("access_token"), "tok").unwrap();
        std::fs::write(svc_dir.join("site_id"), "site").unwrap();

        let oauth_dir = tmp.path().join(".speedwave").join("oauth").join("proj");
        std::fs::create_dir_all(&oauth_dir).unwrap();
        std::fs::write(
            oauth_dir.join("sharepoint.json"),
            serde_json::json!({
                "provider": "microsoft",
                "clientId": "550e8400-e29b-41d4-a716-446655440000",
                "tenantId": "common",
                "refreshToken": "ref",
            })
            .to_string(),
        )
        .unwrap();

        assert!(
            !is_service_configured_with_home(tmp.path(), "proj", "sharepoint"),
            "pre-OAuthProvider layout (clientId/tenantId at top level) must surface as unconfigured"
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

    #[test]
    fn parse_permission_output_granted_with_status() {
        assert!(parse_permission_output(r#"{"granted": true, "status": "granted"}"#).is_ok());
    }

    #[test]
    fn parse_permission_output_denied_with_status_and_error() {
        // Calendar uses sub-identifier `pl.speedwave.desktop.calendar` per
        // SharedCLI/Utilities.swift::subBundleIdentifier — the `tccutil reset`
        // command in the error string must use the sub-identifier so that
        // recovery actually clears the right TCC.db row.
        let result = parse_permission_output(
            r#"{"granted": false, "status": "denied", "error": "tccutil reset Calendar pl.speedwave.desktop.calendar"}"#,
        );
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            err.contains("tccutil reset Calendar pl.speedwave.desktop.calendar"),
            "error must contain calendar sub-identifier in tccutil command, got: {err}"
        );
    }

    #[test]
    fn parse_permission_output_reminders_uses_sub_identifier() {
        let result = parse_permission_output(
            r#"{"granted": false, "status": "denied", "error": "tccutil reset Reminders pl.speedwave.desktop.reminders"}"#,
        );
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .contains("tccutil reset Reminders pl.speedwave.desktop.reminders"));
    }

    #[test]
    fn parse_permission_output_mail_uses_apple_events_service() {
        // Mail/Notes use kTCCServiceAppleEvents — `tccutil reset Mail` is wrong
        // (no such TCC service exists). The Swift composeErrorMessage produces
        // `tccutil reset AppleEvents pl.speedwave.desktop.mail` and the parser
        // must surface this string verbatim.
        let result = parse_permission_output(
            r#"{"granted": false, "status": "denied", "error": "tccutil reset AppleEvents pl.speedwave.desktop.mail"}"#,
        );
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            err.contains("tccutil reset AppleEvents pl.speedwave.desktop.mail"),
            "Mail must use AppleEvents service in tccutil command, got: {err}"
        );
        assert!(
            !err.contains("tccutil reset Mail "),
            "Mail must NOT use 'tccutil reset Mail' (no such TCC service), got: {err}"
        );
    }

    #[test]
    fn parse_permission_output_notes_uses_apple_events_service() {
        let result = parse_permission_output(
            r#"{"granted": false, "status": "denied", "error": "tccutil reset AppleEvents pl.speedwave.desktop.notes"}"#,
        );
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("tccutil reset AppleEvents pl.speedwave.desktop.notes"));
        assert!(!err.contains("tccutil reset Notes "));
    }

    #[test]
    fn parse_permission_output_target_not_running_omits_tccutil() {
        // .targetNotRunning (Mail/Notes app not running) is NOT a TCC issue —
        // the error string must NOT recommend tccutil because resetting
        // permission would not help. The Swift composeErrorMessage produces
        // a "open Mail.app and try again" message instead.
        let result = parse_permission_output(
            r#"{"granted": false, "status": "targetNotRunning", "error": "Mail.app is not running. Open Mail.app and try again — this is not a permission problem."}"#,
        );
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("Mail.app is not running"));
        assert!(
            !err.to_lowercase().contains("tccutil"),
            "targetNotRunning must NOT recommend tccutil, got: {err}"
        );
    }

    #[test]
    fn parse_permission_output_status_field_does_not_affect_message() {
        // The status field must not affect the returned Err message — only the error field matters.
        // Example: status="completely_made_up" with error="real error" → Err("real error")
        let result = parse_permission_output(
            r#"{"granted": false, "status": "completely_made_up", "error": "real error"}"#,
        );
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), "real error");
    }

    #[test]
    fn parse_permission_output_sanitizes_error() {
        // Error strings must be sanitized before reaching the webview.
        // Synthesize an error containing a Bearer token pattern.
        let input =
            r#"{"granted": false, "error": "failed with Bearer eyJhbGciOiJIUzI1NiJ9.test.sig"}"#;
        let result = parse_permission_output(input);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            !err.contains("eyJhbGciOiJIUzI1NiJ9.test.sig"),
            "Bearer token must be redacted, got: {err}"
        );
    }

    #[test]
    fn parse_permission_output_legacy_old_swift_shape_unchanged() {
        // Backward compat: old Swift shape without status field must still work
        let result = parse_permission_output(
            r#"{"granted": false, "error": "Calendar access denied: foo"}"#,
        );
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Calendar access denied: foo"));
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
            let path = resolve_native_cli_binary_in(service, None).unwrap();
            assert!(
                path.to_string_lossy().contains(expected_binary),
                "path for {service} should contain {expected_binary}, got: {}",
                path.display()
            );
        }
    }

    #[test]
    fn resolve_native_cli_binary_rejects_unknown() {
        assert!(resolve_native_cli_binary_in("unknown", None).is_err());
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
                resolve_native_cli_binary_in(service, None).is_ok(),
                "resolve_native_cli_binary_in must handle OS service '{service}'"
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
    fn check_os_permission_handles_binary_not_found() {
        let dir = std::path::Path::new("/nonexistent/path");
        let result = check_os_permission_with_timeout_in(
            "reminders",
            false,
            std::time::Duration::from_secs(60),
            Some(dir),
        );
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            err.contains("Failed to run") || err.contains("No such file"),
            "expected 'Failed to run' or 'No such file', got: {err}"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn check_os_permission_handles_non_executable_binary() {
        let tmp = tempfile::tempdir().unwrap();
        let binary_path = tmp.path().join("reminders-cli");
        std::fs::write(&binary_path, "not executable").unwrap();
        // chmod 0o644 — not executable
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&binary_path, std::fs::Permissions::from_mode(0o644)).unwrap();

        let result = check_os_permission_with_timeout_in(
            "reminders",
            false,
            std::time::Duration::from_secs(60),
            Some(tmp.path()),
        );
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            err.contains("Permission denied") || err.contains("Failed to run"),
            "expected permission error, got: {err}"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn check_os_permission_handles_nonzero_exit() {
        let tmp = tempfile::tempdir().unwrap();
        let script = tmp.path().join("reminders-cli");
        std::fs::write(&script, "#!/bin/sh\necho 'crash info' >&2\nexit 1\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();

        let result = check_os_permission_with_timeout_in(
            "reminders",
            false,
            std::time::Duration::from_secs(60),
            Some(tmp.path()),
        );
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("crash info"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn check_os_permission_handles_exit_0_garbage_stdout() {
        let tmp = tempfile::tempdir().unwrap();
        let script = tmp.path().join("reminders-cli");
        std::fs::write(&script, "#!/bin/sh\necho 'debug line'\necho 'not json'\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();

        let result = check_os_permission_with_timeout_in(
            "reminders",
            false,
            std::time::Duration::from_secs(60),
            Some(tmp.path()),
        );
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Failed to parse"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn check_os_permission_timeout_kills_child() {
        // Intentionally slow test (~5s) — spawns a script that sleeps 60s,
        // but we set a 2s timeout so it gets killed quickly.
        let tmp = tempfile::tempdir().unwrap();
        let script = tmp.path().join("reminders-cli");
        std::fs::write(&script, "#!/bin/sh\nsleep 60\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();

        let result = check_os_permission_with_timeout_in(
            "reminders",
            false,
            std::time::Duration::from_secs(2),
            Some(tmp.path()),
        );
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
    fn badge_propagated_for_playwright() {
        let svc_desc = speedwave_runtime::consts::find_mcp_service("playwright")
            .expect("playwright must exist");
        assert_eq!(
            svc_desc.badge,
            Some("BETA"),
            "playwright must have BETA badge"
        );
    }

    #[test]
    fn badge_none_for_credential_services() {
        for key in &[
            "slack",
            "sharepoint",
            "redmine",
            "gitlab",
            "github",
            "atlassian",
        ] {
            let svc_desc = speedwave_runtime::consts::find_mcp_service(key)
                .unwrap_or_else(|| panic!("service '{}' must exist", key));
            assert_eq!(
                svc_desc.badge, None,
                "service '{}' should have no badge",
                key
            );
        }
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

    #[test]
    fn get_oauth_field_routes_provider_specific_through_provider_data() {
        use speedwave_runtime::consts::FieldStorage;
        let json = serde_json::json!({
            "provider": "microsoft",
            "providerData": { "clientId": "cid", "tenantId": "tid" },
            "refreshToken": "rt",
            "grantedScopes": ["a"],
        });
        assert_eq!(
            get_oauth_field(&json, FieldStorage::OAuthStateProviderData, "client_id"),
            Some("cid")
        );
        assert_eq!(
            get_oauth_field(&json, FieldStorage::OAuthStateProviderData, "tenant_id"),
            Some("tid")
        );
        assert_eq!(
            get_oauth_field(&json, FieldStorage::OAuthState, "refresh_token"),
            Some("rt")
        );
        assert_eq!(
            get_oauth_field(&json, FieldStorage::OAuthState, "missing"),
            None
        );
    }

    #[test]
    fn get_oauth_field_returns_none_when_provider_data_absent() {
        use speedwave_runtime::consts::FieldStorage;
        let json = serde_json::json!({ "provider": "microsoft", "refreshToken": "rt" });
        assert_eq!(
            get_oauth_field(&json, FieldStorage::OAuthStateProviderData, "client_id"),
            None
        );
        assert_eq!(
            get_oauth_field(&json, FieldStorage::OAuthStateProviderData, "tenant_id"),
            None
        );
        assert_eq!(
            get_oauth_field(&json, FieldStorage::OAuthState, "refresh_token"),
            Some("rt")
        );
    }

    #[test]
    fn get_oauth_field_returns_none_when_value_not_string() {
        use speedwave_runtime::consts::FieldStorage;
        let json = serde_json::json!({
            "providerData": { "clientId": 42 },
            "refreshToken": ["arr"],
        });
        assert_eq!(
            get_oauth_field(&json, FieldStorage::OAuthStateProviderData, "client_id"),
            None
        );
        assert_eq!(
            get_oauth_field(&json, FieldStorage::OAuthState, "refresh_token"),
            None
        );
    }

    #[test]
    fn get_oauth_field_returns_none_for_non_oauth_storage_tiers() {
        use speedwave_runtime::consts::FieldStorage;
        let json = serde_json::json!({ "refreshToken": "rt" });
        assert_eq!(
            get_oauth_field(&json, FieldStorage::WorkerMountedToken, "refresh_token"),
            None
        );
        assert_eq!(
            get_oauth_field(&json, FieldStorage::WorkerMountedConfig, "host_url"),
            None
        );
    }

    fn merge_field(
        key: &'static str,
        value: &'static str,
    ) -> (
        &'static str,
        (speedwave_runtime::consts::FieldStorage, &'static str),
    ) {
        use speedwave_runtime::consts::FieldStorage;
        let storage = match key {
            "client_id" | "tenant_id" => FieldStorage::OAuthStateProviderData,
            _ => FieldStorage::OAuthState,
        };
        (key, (storage, value))
    }

    #[test]
    fn merge_oauth_state_json_initializes_with_provider_data_object() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path();

        let fields: std::collections::HashMap<_, _> = [
            merge_field("client_id", "cid"),
            merge_field("tenant_id", "tid"),
            merge_field("refresh_token", "rt"),
        ]
        .into_iter()
        .collect();
        merge_oauth_state_json_in(data_dir, "p", "sharepoint", &fields).unwrap();

        let path = speedwave_runtime::plugin::oauth_state_file_in(data_dir, "p", "sharepoint");
        let json: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(json["provider"], "microsoft");
        assert_eq!(json["providerData"]["clientId"], "cid");
        assert_eq!(json["providerData"]["tenantId"], "tid");
        assert_eq!(json["refreshToken"], "rt");
        // Provider-specific fields must NOT appear top-level.
        assert!(json.get("clientId").is_none());
        assert!(json.get("tenantId").is_none());

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "oauth.json must be created with chmod 600");
        }
    }

    #[test]
    fn merge_oauth_state_json_merges_into_existing_provider_data() {
        // Existing file already has a populated providerData node (typical
        // read-modify-write: user updates one field via UI, the others stay).
        // The merge must add the new field, preserve the old one, and keep
        // top-level fields intact.
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path();

        let path = speedwave_runtime::plugin::oauth_state_file_in(data_dir, "p", "sharepoint");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            serde_json::json!({
                "provider": "microsoft",
                "providerData": { "clientId": "old-cid" },
                "refreshToken": "old-rt",
            })
            .to_string(),
        )
        .unwrap();

        let fields: std::collections::HashMap<_, _> = [
            merge_field("tenant_id", "new-tid"),
            merge_field("refresh_token", "new-rt"),
        ]
        .into_iter()
        .collect();
        merge_oauth_state_json_in(data_dir, "p", "sharepoint", &fields).unwrap();

        let json: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        // Old providerData.clientId preserved.
        assert_eq!(json["providerData"]["clientId"], "old-cid");
        // New providerData.tenantId added under providerData (NOT top-level).
        assert_eq!(json["providerData"]["tenantId"], "new-tid");
        assert!(json.get("tenantId").is_none());
        // Top-level refresh_token overwritten.
        assert_eq!(json["refreshToken"], "new-rt");
        // Provider literal preserved.
        assert_eq!(json["provider"], "microsoft");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(
                mode, 0o600,
                "oauth.json must remain chmod 600 across merges"
            );
        }
    }

    #[test]
    fn merge_oauth_state_json_repairs_scalar_provider_data() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path();

        let path = speedwave_runtime::plugin::oauth_state_file_in(data_dir, "p", "sharepoint");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            serde_json::json!({ "provider": "microsoft", "providerData": "oops" }).to_string(),
        )
        .unwrap();

        let fields: std::collections::HashMap<_, _> =
            [merge_field("client_id", "cid")].into_iter().collect();
        merge_oauth_state_json_in(data_dir, "p", "sharepoint", &fields).unwrap();

        let json: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert!(json["providerData"].is_object());
        assert_eq!(json["providerData"]["clientId"], "cid");
    }

    #[test]
    fn merge_oauth_state_json_preserves_existing_fields_on_corrupt_json() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path();

        let path = speedwave_runtime::plugin::oauth_state_file_in(data_dir, "p", "sharepoint");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "not json at all").unwrap();

        let fields: std::collections::HashMap<_, _> =
            [merge_field("client_id", "cid")].into_iter().collect();
        merge_oauth_state_json_in(data_dir, "p", "sharepoint", &fields).unwrap();

        let json: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(json["provider"], "microsoft");
        assert_eq!(json["providerData"]["clientId"], "cid");
    }

    #[test]
    fn merge_oauth_state_json_repairs_missing_provider_data_node() {
        // Existing file lacks `providerData` (e.g. corrupted at that node).
        // The merge must repair it rather than silently drop client_id/tenant_id.
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path();

        let path = speedwave_runtime::plugin::oauth_state_file_in(data_dir, "p", "sharepoint");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            serde_json::json!({ "provider": "microsoft", "refreshToken": "old" }).to_string(),
        )
        .unwrap();

        let fields: std::collections::HashMap<_, _> =
            [merge_field("client_id", "cid")].into_iter().collect();
        merge_oauth_state_json_in(data_dir, "p", "sharepoint", &fields).unwrap();

        let json: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(json["providerData"]["clientId"], "cid");
        // Pre-existing top-level fields preserved.
        assert_eq!(json["refreshToken"], "old");
    }

    #[test]
    fn merge_oauth_state_json_lifts_legacy_top_level_identity() {
        // Legacy file with clientId/tenantId at top level (pre-providerData).
        // A re-save must lift them under providerData AND remove the top-level
        // copies — not leave them orphaned next to an empty providerData.
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path();

        let path = speedwave_runtime::plugin::oauth_state_file_in(data_dir, "p", "sharepoint");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            serde_json::json!({
                "provider": "microsoft",
                "clientId": "legacy-cid",
                "tenantId": "legacy-tid",
                "refreshToken": "rt"
            })
            .to_string(),
        )
        .unwrap();

        // Re-save only tenant_id; client_id must survive via the lift.
        let fields: std::collections::HashMap<_, _> =
            [merge_field("tenant_id", "new-tid")].into_iter().collect();
        merge_oauth_state_json_in(data_dir, "p", "sharepoint", &fields).unwrap();

        let json: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(json["providerData"]["clientId"], "legacy-cid");
        assert_eq!(json["providerData"]["tenantId"], "new-tid");
        // Top-level identity removed — no orphans.
        assert!(json.get("clientId").is_none());
        assert!(json.get("tenantId").is_none());
        assert_eq!(json["refreshToken"], "rt");
    }
}
