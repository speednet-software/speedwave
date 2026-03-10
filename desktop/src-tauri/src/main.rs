// Speedwave Desktop — Tauri v2 backend
//
// Thin #[tauri::command] wrappers that delegate to the existing module functions.
// Each command converts anyhow::Result into Result<T, String> (Tauri requires
// serializable errors).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#![allow(missing_docs)]

mod auth;
mod chat;
mod fs_perms;
mod health;
mod history;
mod ide_bridge;
mod mcp_os_process;
mod setup_wizard;
mod updater;

use chat::{ChatSession, SharedChatSession};
use health::HealthMonitor;
use speedwave_runtime::config;

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::Manager;

/// Shared handle for the background auto-update check task.
type SharedAutoCheckHandle = Arc<Mutex<Option<tauri::async_runtime::JoinHandle<()>>>>;

/// Tracks the latest available update version for the system tray menu.
type SharedUpdateVersion = Arc<Mutex<Option<String>>>;

const MAIN_WINDOW_LABEL: &str = "main";

/// Global mutex protecting all read-modify-write cycles on config.json.
/// Without this, concurrent Tauri commands (e.g. toggling mail then notes in quick
/// succession) can lose writes due to TOCTOU races.
static CONFIG_LOCK: std::sync::LazyLock<Mutex<()>> = std::sync::LazyLock::new(|| Mutex::new(()));

// ---------------------------------------------------------------------------
// Types returned to the Angular frontend
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize)]
struct ProjectEntry {
    name: String,
    dir: String,
}

#[derive(Serialize, Deserialize)]
struct ProjectList {
    projects: Vec<ProjectEntry>,
    active_project: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct LlmConfigResponse {
    provider: Option<String>,
    model: Option<String>,
    base_url: Option<String>,
    api_key_env: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct AuthStatusResponse {
    api_key_configured: bool,
    oauth_authenticated: bool,
}

#[derive(Serialize, Clone)]
struct AuthField {
    key: String,
    label: String,
    field_type: String,
    placeholder: String,
}

#[derive(Serialize, Clone)]
struct IntegrationStatusEntry {
    service: String,
    enabled: bool,
    configured: bool,
    display_name: String,
    description: String,
    auth_fields: Vec<AuthField>,
    current_values: std::collections::HashMap<String, String>,
    mappings: Option<std::collections::HashMap<String, serde_json::Value>>,
}

#[derive(Serialize, Clone)]
struct OsIntegrationStatusEntry {
    service: String,
    enabled: bool,
    display_name: String,
    description: String,
}

#[derive(Serialize)]
struct IntegrationsResponse {
    services: Vec<IntegrationStatusEntry>,
    os: Vec<OsIntegrationStatusEntry>,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn check_project(name: &str) -> Result<(), String> {
    speedwave_runtime::validation::validate_project_name(name).map_err(|e| e.to_string())
}

const ALLOWED_CREDENTIAL_FILES: &[(&str, &[&str])] = &[
    ("slack", &["bot_token", "user_token"]),
    (
        "sharepoint",
        &[
            "access_token",
            "refresh_token",
            "client_id",
            "tenant_id",
            "site_id",
            "base_path",
        ],
    ),
    (
        "redmine",
        &[
            "api_key",
            "config.json",
            "host_url",
            "project_id",
            "project_name",
        ],
    ),
    ("gitlab", &["token", "host_url"]),
];

const SECRET_FIELDS: &[&str] = &[
    "bot_token",
    "user_token",
    "access_token",
    "refresh_token",
    "token",
    "api_key",
];

fn get_allowed_fields(service: &str) -> Option<&'static [&'static str]> {
    ALLOWED_CREDENTIAL_FILES
        .iter()
        .find(|(s, _)| *s == service)
        .map(|(_, fields)| *fields)
}

fn get_auth_fields(service: &str) -> Vec<AuthField> {
    match service {
        "slack" => vec![
            AuthField {
                key: "bot_token".into(),
                label: "Bot Token".into(),
                field_type: "password".into(),
                placeholder: "xoxb-...".into(),
            },
            AuthField {
                key: "user_token".into(),
                label: "User Token".into(),
                field_type: "password".into(),
                placeholder: "xoxp-...".into(),
            },
        ],
        "sharepoint" => vec![
            AuthField {
                key: "access_token".into(),
                label: "Access Token".into(),
                field_type: "password".into(),
                placeholder: "eyJ0...".into(),
            },
            AuthField {
                key: "refresh_token".into(),
                label: "Refresh Token".into(),
                field_type: "password".into(),
                placeholder: "0.AR...".into(),
            },
            AuthField {
                key: "client_id".into(),
                label: "Client ID".into(),
                field_type: "text".into(),
                placeholder: "00000000-0000-...".into(),
            },
            AuthField {
                key: "tenant_id".into(),
                label: "Tenant ID".into(),
                field_type: "text".into(),
                placeholder: "00000000-0000-...".into(),
            },
            AuthField {
                key: "site_id".into(),
                label: "Site ID".into(),
                field_type: "text".into(),
                placeholder: "site-id".into(),
            },
            AuthField {
                key: "base_path".into(),
                label: "Base Path".into(),
                field_type: "text".into(),
                placeholder: "/sites/MySite".into(),
            },
        ],
        "redmine" => vec![
            AuthField {
                key: "api_key".into(),
                label: "API Key".into(),
                field_type: "password".into(),
                placeholder: "abcdef1234567890...".into(),
            },
            AuthField {
                key: "host_url".into(),
                label: "Redmine URL".into(),
                field_type: "url".into(),
                placeholder: "https://redmine.company.com".into(),
            },
            AuthField {
                key: "project_id".into(),
                label: "Project ID".into(),
                field_type: "text".into(),
                placeholder: "my-project".into(),
            },
            AuthField {
                key: "project_name".into(),
                label: "Project Name".into(),
                field_type: "text".into(),
                placeholder: "My Project".into(),
            },
        ],
        "gitlab" => vec![
            AuthField {
                key: "token".into(),
                label: "Personal Access Token".into(),
                field_type: "password".into(),
                placeholder: "glpat-...".into(),
            },
            AuthField {
                key: "host_url".into(),
                label: "GitLab URL".into(),
                field_type: "url".into(),
                placeholder: "https://gitlab.com".into(),
            },
        ],
        _ => vec![],
    }
}

// ---------------------------------------------------------------------------
// Setup wizard commands
// ---------------------------------------------------------------------------

#[tauri::command]
async fn check_runtime() -> Result<String, String> {
    tokio::task::spawn_blocking(|| {
        log::info!("check_runtime: starting");
        let status = setup_wizard::check_runtime().map_err(|e| {
            log::error!("check_runtime: error: {e}");
            e.to_string()
        })?;
        match status {
            setup_wizard::RuntimeStatus::Ready => {
                log::info!("check_runtime: Ready");
                Ok("Ready".to_string())
            }
            setup_wizard::RuntimeStatus::NotInstalled => {
                log::info!("check_runtime: NotInstalled");
                Ok("NotInstalled".to_string())
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn install_runtime() -> Result<(), String> {
    tokio::task::spawn_blocking(|| {
        log::info!("install_runtime: starting");
        setup_wizard::install_runtime().map_err(|e| {
            log::error!("install_runtime: error: {e}");
            e.to_string()
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn init_vm() -> Result<(), String> {
    tokio::task::spawn_blocking(|| {
        log::info!("init_vm: starting");
        setup_wizard::init_vm().map_err(|e| {
            log::error!("init_vm: error: {e}");
            e.to_string()
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn create_project(name: String, dir: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        check_project(&name)?;
        let dir_path = std::path::Path::new(&dir);
        if !dir_path.is_absolute() {
            return Err("Project directory must be an absolute path".to_string());
        }
        if !dir_path.is_dir() {
            return Err(format!("Project directory does not exist: {}", dir));
        }
        log::info!("create_project: name={name}, dir={dir}");
        setup_wizard::create_project(&name, &dir).map_err(|e| {
            log::error!("create_project: error: {e}");
            e.to_string()
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn link_cli() -> Result<(), String> {
    tokio::task::spawn_blocking(|| {
        log::info!("link_cli: starting");
        setup_wizard::link_cli().map_err(|e| {
            log::error!("link_cli: error: {e}");
            e.to_string()
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// Container lifecycle commands
// ---------------------------------------------------------------------------

#[tauri::command]
async fn is_setup_complete() -> Result<bool, String> {
    Ok(setup_wizard::is_setup_complete())
}

#[tauri::command]
async fn build_images() -> Result<(), String> {
    tokio::task::spawn_blocking(|| {
        log::info!("build_images: starting");
        setup_wizard::build_images().map_err(|e| {
            log::error!("build_images: error: {e}");
            e.to_string()
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn start_containers(project: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        check_project(&project)?;
        log::info!("start_containers: project={project}");
        setup_wizard::start_containers(&project).map_err(|e| {
            log::error!("start_containers: error: {e}");
            e.to_string()
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn check_claude_auth(project: String) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || {
        check_project(&project)?;
        log::info!("check_claude_auth: project={project}");
        setup_wizard::check_claude_auth(&project).map_err(|e| {
            log::error!("check_claude_auth: error: {e}");
            e.to_string()
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn check_containers_running(project: String) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || {
        check_project(&project)?;
        log::info!("check_containers_running: project={project}");
        let rt = speedwave_runtime::runtime::detect_runtime();
        // Intentional double check: is_available() returns Ok(false) for a stopped
        // runtime (clear UX), while compose_ps() would return Err (confusing UX).
        // This guard gives the frontend a clean "no containers" signal.
        if !rt.is_available() {
            log::warn!("check_containers_running: runtime not available");
            return Ok(false);
        }
        let containers = rt.compose_ps(&project).map_err(|e| {
            log::error!("check_containers_running: error: {e}");
            e.to_string()
        })?;
        log::info!("check_containers_running: {} containers", containers.len());
        Ok(!containers.is_empty())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// Settings / reset commands
// ---------------------------------------------------------------------------

#[tauri::command]
async fn factory_reset() -> Result<(), String> {
    tokio::task::spawn_blocking(|| {
        log::info!("factory_reset: starting");
        setup_wizard::factory_reset().map_err(|e| {
            log::error!("factory_reset: error: {e}");
            e.to_string()
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn get_llm_config() -> Result<LlmConfigResponse, String> {
    let user_config = config::load_user_config().map_err(|e| e.to_string())?;
    let active = user_config.active_project.as_deref().unwrap_or("");
    let llm = user_config
        .projects
        .iter()
        .find(|p| p.name == active)
        .and_then(|p| p.claude.as_ref())
        .and_then(|c| c.llm.as_ref());
    Ok(LlmConfigResponse {
        provider: llm.and_then(|l| l.provider.clone()),
        model: llm.and_then(|l| l.model.clone()),
        base_url: llm.and_then(|l| l.base_url.clone()),
        api_key_env: llm.and_then(|l| l.api_key_env.clone()),
    })
}

#[tauri::command]
fn update_llm_config(
    provider: Option<String>,
    model: Option<String>,
    base_url: Option<String>,
    api_key_env: Option<String>,
) -> Result<(), String> {
    let _lock = CONFIG_LOCK.lock().map_err(|e| e.to_string())?;
    let mut user_config = config::load_user_config().map_err(|e| e.to_string())?;
    let active = user_config.active_project.clone().unwrap_or_default();
    let project = user_config
        .projects
        .iter_mut()
        .find(|p| p.name == active)
        .ok_or_else(|| "No active project".to_string())?;

    let llm = config::LlmConfig {
        provider,
        model,
        base_url,
        api_key_env,
    };
    match &mut project.claude {
        Some(c) => c.llm = Some(llm),
        None => {
            project.claude = Some(config::ClaudeOverrides {
                env: None,
                settings: None,
                llm: Some(llm),
            });
        }
    }
    config::save_user_config(&user_config).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Authentication commands (API key only — OAuth is done via CLI)
// ---------------------------------------------------------------------------

#[tauri::command]
async fn save_api_key(project: String, api_key: String) -> Result<(), String> {
    if api_key.len() > 4096 {
        return Err("API key too long".to_string());
    }
    tokio::task::spawn_blocking(move || {
        log::info!("save_api_key: project={project}");
        auth::save_api_key(&project, &api_key).map_err(|e| {
            log::error!("save_api_key: error: {e}");
            e.to_string()
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn delete_api_key(project: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        log::info!("delete_api_key: project={project}");
        auth::delete_api_key(&project).map_err(|e| {
            log::error!("delete_api_key: error: {e}");
            e.to_string()
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn get_auth_status(project: String) -> Result<AuthStatusResponse, String> {
    tokio::task::spawn_blocking(move || {
        log::info!("get_auth_status: project={project}");
        let api_key_configured = auth::has_api_key(&project);
        let oauth_authenticated = setup_wizard::check_claude_auth(&project).unwrap_or(false);
        Ok(AuthStatusResponse {
            api_key_configured,
            oauth_authenticated,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// URL opener
// ---------------------------------------------------------------------------

/// Returns `true` if the given IP address is loopback, private, link-local,
/// or otherwise reserved (not globally routable).
fn is_private_or_reserved(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => {
            v4.is_loopback()       // 127.0.0.0/8
            || v4.is_private()     // 10/8, 172.16/12, 192.168/16
            || v4.is_unspecified() // 0.0.0.0
            || v4.is_link_local()  // 169.254/16
            || v4.octets()[0] == 0 // 0.x.x.x (RFC 1122 "This host on this network")
            || v4.octets()[0] == 100 && (v4.octets()[1] & 0xc0) == 64 // 100.64.0.0/10 (RFC 6598 shared address / CGNAT)
            || (v4.octets()[0] == 192 && v4.octets()[1] == 0 && v4.octets()[2] == 2)   // 192.0.2.0/24 (RFC 5737 TEST-NET-1)
            || (v4.octets()[0] == 198 && v4.octets()[1] == 51 && v4.octets()[2] == 100) // 198.51.100.0/24 (RFC 5737 TEST-NET-2)
            || (v4.octets()[0] == 203 && v4.octets()[1] == 0 && v4.octets()[2] == 113)  // 203.0.113.0/24 (RFC 5737 TEST-NET-3)
            || (v4.octets()[0] == 198 && (v4.octets()[1] & 0xfe) == 18) // 198.18.0.0/15 (RFC 2544 benchmarking)
        }
        std::net::IpAddr::V6(v6) => {
            v6.is_loopback()       // ::1
            || v6.is_unspecified() // ::
            || (v6.segments()[0] & 0xfe00) == 0xfc00 // fc00::/7 unique-local
            || (v6.segments()[0] & 0xffc0) == 0xfe80 // fe80::/10 link-local
            || (v6.segments()[0] & 0xffc0) == 0xfec0 // fec0::/10 deprecated site-local (RFC 3879)
            || (v6.segments()[0] == 0x2001 && v6.segments()[1] == 0x0db8) // 2001:db8::/32 documentation (RFC 3849)
            || (v6.segments()[0] == 0x0100 && v6.segments()[1] == 0 && v6.segments()[2] == 0 && v6.segments()[3] == 0)
            // 100::/64 discard (RFC 6666)
        }
    }
}

/// Validates a URL string: only http/https schemes allowed, no localhost or private IPs.
/// Uses parsed IP types (not string matching) to prevent IPv6-mapped IPv4 bypasses.
fn validate_url(url: &str) -> Result<url::Url, String> {
    let parsed: url::Url = url.parse().map_err(|e: url::ParseError| e.to_string())?;
    match parsed.scheme() {
        "http" | "https" => {}
        scheme => {
            return Err(format!(
                "Blocked URL scheme '{}': only http and https are allowed",
                scheme
            ))
        }
    }

    match parsed.host() {
        Some(url::Host::Domain(domain)) => {
            let lower = domain.to_lowercase();
            if lower == "localhost" || lower.ends_with(".localhost") {
                return Err(format!(
                    "Blocked URL host '{}': localhost is not allowed",
                    domain
                ));
            }
        }
        Some(url::Host::Ipv4(ipv4)) => {
            if is_private_or_reserved(std::net::IpAddr::V4(ipv4)) {
                return Err(format!("Blocked URL host '{}': private/reserved IP", ipv4));
            }
        }
        Some(url::Host::Ipv6(ipv6)) => {
            if is_private_or_reserved(std::net::IpAddr::V6(ipv6)) {
                return Err(format!(
                    "Blocked URL host '{}': private/reserved IPv6",
                    ipv6
                ));
            }
            // Also check IPv6-mapped IPv4 addresses (::ffff:x.x.x.x)
            if let Some(mapped_v4) = ipv6.to_ipv4_mapped() {
                if is_private_or_reserved(std::net::IpAddr::V4(mapped_v4)) {
                    return Err(format!(
                        "Blocked URL host '{}': maps to private IPv4 {}",
                        ipv6, mapped_v4
                    ));
                }
            }
        }
        None => return Err("URL has no host".to_string()),
    }

    Ok(parsed)
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if url.len() > 8192 {
        return Err("URL too long".to_string());
    }
    let parsed = validate_url(&url)?;
    open::that(parsed.as_str()).map_err(|e| e.to_string())
}

/// Returns the current platform as a string ("macos", "linux", or "windows").
#[tauri::command]
fn get_platform() -> String {
    if cfg!(target_os = "macos") {
        "macos".to_string()
    } else if cfg!(target_os = "linux") {
        "linux".to_string()
    } else if cfg!(target_os = "windows") {
        "windows".to_string()
    } else {
        "unknown".to_string()
    }
}

// ---------------------------------------------------------------------------
// Open native terminal with speedwave (Claude Code)
// ---------------------------------------------------------------------------

/// Resolves and validates the CLI binary path.
///
/// Uses [`setup_wizard::cli_install_path()`] as the SSOT for the install location.
/// Returns the path to the installed CLI binary, or an error if it doesn't exist.
fn validate_cli_path() -> Result<std::path::PathBuf, String> {
    let cli_path = setup_wizard::cli_install_path()
        .ok_or_else(|| "cannot determine home directory".to_string())?;

    if !cli_path.exists() {
        return Err(format!(
            "CLI binary not found at {}. Please restart Speedwave to re-link the CLI.",
            cli_path.display()
        ));
    }

    Ok(cli_path)
}

#[tauri::command]
async fn open_auth_terminal(project: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        log::info!("open_auth_terminal: project={project}");

        // Resolve project dir from config
        let user_config = speedwave_runtime::config::load_user_config().unwrap_or_default();
        let project_dir = user_config
            .projects
            .iter()
            .find(|p| p.name == project)
            .map(|p| p.dir.clone())
            .unwrap_or_else(|| {
                std::env::current_dir()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string()
            });

        // Find the speedwave CLI binary
        let cli_path = validate_cli_path()?;

        let cli_str = cli_path.to_string_lossy().to_string();

        // Shell-escape a string for use inside single quotes (POSIX standard).
        // Each embedded single-quote becomes: close-quote, backslash-escaped quote, open-quote.
        fn shell_escape_single_quoted(s: &str) -> String {
            s.replace('\'', "'\\''")
        }

        #[cfg(target_os = "macos")]
        {
            // Escape a string for embedding inside an AppleScript double-quoted string.
            // AppleScript treats backslash and double-quote as special inside "...".
            fn applescript_escape(s: &str) -> String {
                s.replace('\\', "\\\\").replace('"', "\\\"")
            }

            // Build the shell command with proper single-quote escaping, then
            // escape the result for embedding in the AppleScript "do script" string.
            let shell_cmd = format!(
                "cd '{}' && '{}'",
                shell_escape_single_quoted(&project_dir),
                shell_escape_single_quoted(&cli_str),
            );
            let apple_script = format!(
                "tell application \"Terminal\"\n  activate\n  do script \"{}\"\nend tell",
                applescript_escape(&shell_cmd),
            );
            std::process::Command::new("osascript")
                .arg("-e")
                .arg(&apple_script)
                .status()
                .map_err(|e| e.to_string())?;
        }

        #[cfg(target_os = "linux")]
        {
            let shell_cmd = format!(
                "cd '{}' && exec '{}'",
                shell_escape_single_quoted(&project_dir),
                shell_escape_single_quoted(&cli_str),
            );
            let terminals = ["x-terminal-emulator", "gnome-terminal", "xterm"];
            let mut launched = false;
            for term in &terminals {
                if std::process::Command::new(term)
                    .args(["--", "bash", "-c", &shell_cmd])
                    .spawn()
                    .is_ok()
                {
                    launched = true;
                    break;
                }
            }
            if !launched {
                return Err("No terminal emulator found".to_string());
            }
        }

        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        {
            let _ = cli_str;
            return Err("Terminal launch not supported on this platform yet".to_string());
        }

        #[allow(unreachable_code)]
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// Chat commands
// ---------------------------------------------------------------------------

#[tauri::command]
fn start_chat(
    project: String,
    app_handle: tauri::AppHandle,
    state: tauri::State<SharedChatSession>,
) -> Result<(), String> {
    check_project(&project)?;
    let mut session = state.lock().map_err(|e| format!("Lock poisoned: {e}"))?;
    // Stop any existing session before starting a new one
    session.stop().map_err(|e| e.to_string())?;
    // Replace with a fresh session for the requested project
    *session = ChatSession::new(&project);
    session.start(app_handle, None).map_err(|e| e.to_string())
}

#[tauri::command]
fn send_message(message: String, state: tauri::State<SharedChatSession>) -> Result<(), String> {
    if message.len() > 1_000_000 {
        return Err("Message too long".to_string());
    }
    let mut session = state.lock().map_err(|e| format!("Lock poisoned: {e}"))?;
    session.send_message(&message).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Chat history commands
// ---------------------------------------------------------------------------

#[tauri::command]
async fn list_conversations(project: String) -> Result<Vec<history::ConversationSummary>, String> {
    tokio::task::spawn_blocking(move || {
        check_project(&project)?;
        log::info!("list_conversations: project={project}");
        history::list_conversations(&project).map_err(|e| {
            log::error!("list_conversations: error: {e}");
            e.to_string()
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn get_conversation(
    project: String,
    session_id: String,
) -> Result<history::ConversationTranscript, String> {
    tokio::task::spawn_blocking(move || {
        check_project(&project)?;
        log::info!("get_conversation: project={project}");
        history::get_conversation(&project, &session_id).map_err(|e| {
            log::error!("get_conversation: error: {e}");
            e.to_string()
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn get_project_memory(project: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        check_project(&project)?;
        log::info!("get_project_memory: project={project}");
        history::get_project_memory(&project).map_err(|e| {
            log::error!("get_project_memory: error: {e}");
            e.to_string()
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn resume_conversation(
    project: String,
    session_id: String,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, SharedChatSession>,
) -> Result<(), String> {
    check_project(&project)?;
    history::validate_session_id(&session_id).map_err(|e| e.to_string())?;
    log::info!("resume_conversation: project={project}");
    let session_arc = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        let mut session = session_arc
            .lock()
            .map_err(|e| format!("Lock poisoned: {e}"))?;
        session.stop().map_err(|e| e.to_string())?;
        *session = ChatSession::new(&project);
        session.start(app_handle, Some(&session_id)).map_err(|e| {
            log::error!("resume_conversation failed: {e}");
            e.to_string()
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// Project management commands
// ---------------------------------------------------------------------------

#[tauri::command]
fn list_projects() -> Result<ProjectList, String> {
    let user_config = config::load_user_config().map_err(|e| e.to_string())?;
    let projects = user_config
        .projects
        .iter()
        .map(|p| ProjectEntry {
            name: p.name.clone(),
            dir: p.dir.clone(),
        })
        .collect();
    Ok(ProjectList {
        projects,
        active_project: user_config.active_project,
    })
}

#[tauri::command]
fn switch_project(name: String) -> Result<(), String> {
    let _lock = CONFIG_LOCK.lock().map_err(|e| e.to_string())?;
    let mut user_config = config::load_user_config().map_err(|e| e.to_string())?;

    // Verify project exists
    if !user_config.projects.iter().any(|p| p.name == name) {
        return Err(format!("Project '{}' not found", name));
    }

    user_config.active_project = Some(name);

    config::save_user_config(&user_config).map_err(|e| e.to_string())?;

    Ok(())
}

// ---------------------------------------------------------------------------
// Health check command
// ---------------------------------------------------------------------------

#[tauri::command]
async fn get_health(project: String) -> Result<health::HealthReport, String> {
    tokio::task::spawn_blocking(move || {
        check_project(&project)?;
        let user_config = config::load_user_config().unwrap_or_default();
        let project_dir = user_config
            .projects
            .iter()
            .find(|p| p.name == project)
            .map(|p| std::path::PathBuf::from(&p.dir));
        let any_os_enabled = project_dir
            .map(|dir| {
                let resolved = config::resolve_integrations(&dir, &user_config, &project);
                resolved.any_os_enabled()
            })
            .unwrap_or(false);
        Ok(HealthMonitor::check_all(&project, any_os_enabled))
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// IDE Bridge commands
// ---------------------------------------------------------------------------

type SharedIdeBridge = Arc<Mutex<Option<ide_bridge::IdeBridge>>>;

#[derive(Serialize)]
struct BridgeStatus {
    port: u16,
    upstream_ide: Option<String>,
    upstream_port: Option<u16>,
}

/// Checks whether the IDE process behind `~/.claude/ide/<port>.lock` is still alive.
///
/// Verifies both PID liveness and TCP port reachability (50 ms timeout).
/// PID alone is insufficient because Cursor/VS Code may restart on a new port
/// while keeping the same main-process PID, leaving a stale lock file.
fn is_upstream_alive(port: u16) -> bool {
    let lock_path = match dirs::home_dir() {
        Some(h) => h.join(".claude").join("ide").join(format!("{}.lock", port)),
        None => return false,
    };
    health::is_ide_lock_alive(&lock_path)
}

/// Returns the current IDE Bridge status for the Angular frontend.
///
/// **Side effect:** when the upstream IDE is detected as dead (PID gone or port
/// not listening), this command clears the upstream selection and removes it from
/// persisted config so it won't be restored on next startup. This fires only once
/// per IDE death — subsequent polls see `upstream_info() → None`.
#[tauri::command]
fn get_bridge_status(state: tauri::State<SharedIdeBridge>) -> Result<Option<BridgeStatus>, String> {
    let guard = state
        .lock()
        .map_err(|e| format!("Bridge mutex poisoned: {e}"))?;
    match guard.as_ref() {
        Some(bridge) => {
            let (upstream_ide, upstream_port) = match bridge.upstream_info() {
                Some((name, port)) => {
                    if is_upstream_alive(port) {
                        (Some(name), Some(port))
                    } else {
                        bridge.clear_upstream();
                        // Clear persisted selection so it doesn't restore on next startup
                        if let Ok(_lock) = CONFIG_LOCK.lock() {
                            match config::load_user_config() {
                                Ok(mut user_config) => {
                                    user_config.selected_ide = None;
                                    if let Err(e) = config::save_user_config(&user_config) {
                                        log::warn!(
                                            "get_bridge_status: failed to persist IDE deselection: {e}"
                                        );
                                    }
                                }
                                Err(e) => {
                                    log::warn!(
                                        "get_bridge_status: failed to load user config: {e}"
                                    );
                                }
                            }
                        }
                        (None, None)
                    }
                }
                None => (None, None),
            };
            Ok(Some(BridgeStatus {
                port: bridge.port(),
                upstream_ide,
                upstream_port,
            }))
        }
        None => Ok(None),
    }
}

#[tauri::command]
fn list_available_ides() -> Result<Vec<health::DetectedIde>, String> {
    Ok(health::list_available_ides())
}

#[tauri::command]
fn select_ide(
    ide_name: String,
    port: u16,
    state: tauri::State<SharedIdeBridge>,
) -> Result<(), String> {
    // Validate that the port belongs to a currently detected IDE
    if !health::list_available_ides()
        .iter()
        .any(|i| i.port == Some(port))
    {
        return Err(format!(
            "IDE on port {} is not in the detected IDEs list",
            port
        ));
    }

    // Persist the selection to config.json
    {
        let _lock = CONFIG_LOCK.lock().map_err(|e| e.to_string())?;
        let mut user_config = config::load_user_config().map_err(|e| e.to_string())?;
        user_config.selected_ide = Some(speedwave_runtime::config::SelectedIde {
            ide_name: ide_name.clone(),
            port,
        });
        config::save_user_config(&user_config).map_err(|e| e.to_string())?;
    }

    // Update the live Bridge so new connections are proxied immediately
    let guard = state
        .lock()
        .map_err(|e| format!("Bridge mutex poisoned: {e}"))?;
    if let Some(bridge) = guard.as_ref() {
        bridge
            .set_upstream(ide_name, port)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn get_selected_ide() -> Result<Option<speedwave_runtime::config::SelectedIde>, String> {
    let user_config = config::load_user_config().map_err(|e| e.to_string())?;
    Ok(user_config.selected_ide)
}

// ---------------------------------------------------------------------------
// Container log commands
// ---------------------------------------------------------------------------

#[tauri::command]
async fn get_container_logs(container: String, tail: Option<u32>) -> Result<String, String> {
    // Only allow alphanumeric, underscore, hyphen, dot in container names
    // and must start with the Speedwave prefix
    if !container.starts_with(&format!("{}_", speedwave_runtime::consts::COMPOSE_PREFIX)) {
        return Err(format!(
            "Invalid container name: must start with '{}_'",
            speedwave_runtime::consts::COMPOSE_PREFIX
        ));
    }
    if !container
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.')
    {
        return Err("Invalid container name: contains illegal characters".to_string());
    }
    let tail = tail.unwrap_or(200).min(10_000);
    tokio::task::spawn_blocking(move || {
        let rt = speedwave_runtime::runtime::detect_runtime();
        if !rt.is_available() {
            return Err("Container runtime is not available. Please ensure the runtime is started before viewing logs.".to_string());
        }
        rt.container_logs(&container, tail)
            .map(|logs| speedwave_runtime::log_sanitizer::sanitize(&logs))
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn get_compose_logs(project: String, tail: Option<u32>) -> Result<String, String> {
    check_project(&project)?;
    let tail = tail.unwrap_or(200).min(10_000);
    tokio::task::spawn_blocking(move || {
        let rt = speedwave_runtime::runtime::detect_runtime();
        if !rt.is_available() {
            return Err("Container runtime is not available. Please ensure the runtime is started before viewing logs.".to_string());
        }
        rt.compose_logs(&project, tail)
            .map(|logs| speedwave_runtime::log_sanitizer::sanitize(&logs))
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// Container update commands
// ---------------------------------------------------------------------------

#[tauri::command]
async fn update_containers(
    project: String,
) -> Result<speedwave_runtime::update::ContainerUpdateResult, String> {
    tokio::task::spawn_blocking(move || {
        log::info!("update_containers: project={project}");
        check_project(&project)?;
        let rt = speedwave_runtime::runtime::detect_runtime();
        speedwave_runtime::update::update_containers(rt.as_ref(), &project).map_err(|e| {
            log::error!("update_containers: error: {e}");
            e.to_string()
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn rollback_containers(project: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        log::info!("rollback_containers: project={project}");
        check_project(&project)?;
        let rt = speedwave_runtime::runtime::detect_runtime();
        speedwave_runtime::update::rollback_containers(rt.as_ref(), &project).map_err(|e| {
            log::error!("rollback_containers: error: {e}");
            e.to_string()
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// Update commands
// ---------------------------------------------------------------------------

#[tauri::command]
async fn check_for_update(app: tauri::AppHandle) -> Result<Option<updater::UpdateInfo>, String> {
    log::info!("check_for_update: starting");
    updater::check_for_update(&app).await.map_err(|e| {
        log::error!("check_for_update: error: {e}");
        e
    })
}

#[tauri::command]
async fn install_update(app: tauri::AppHandle, expected_version: String) -> Result<(), String> {
    log::info!("install_update: starting (expected_version={expected_version})");
    updater::install_update(&app, expected_version)
        .await
        .map_err(|e| {
            log::error!("install_update: error: {e}");
            e
        })
}

#[tauri::command]
fn get_update_settings() -> Result<updater::UpdateSettings, String> {
    log::debug!("get_update_settings");
    Ok(updater::load_update_settings())
}

#[tauri::command]
fn set_update_settings(settings: updater::UpdateSettings) -> Result<(), String> {
    log::info!(
        "set_update_settings: auto_check={}, interval={}h",
        settings.auto_check,
        settings.check_interval_hours
    );
    updater::save_update_settings(&settings)
}

// `app.restart()` returns `-> !` (the never type) — it terminates the
// process immediately and never returns. The `Result<(), String>` return here
// is required by Tauri's `generate_handler!` macro; the compiler accepts it
// because `!` coerces to any type.
//
// Before restarting, check if any project has running containers.
// If `force` is false and containers are running, return an error instead.
#[tauri::command]
async fn restart_app(app: tauri::AppHandle, force: bool) -> Result<(), String> {
    if !force {
        // Check all projects for running containers
        let running_project = tokio::task::spawn_blocking(|| {
            let user_config = config::load_user_config().map_err(|e| e.to_string())?;
            let rt = speedwave_runtime::runtime::detect_runtime();
            for project in &user_config.projects {
                match rt.compose_ps(&project.name) {
                    Ok(containers) if !containers.is_empty() => {
                        return Ok::<Option<String>, String>(Some(project.name.clone()));
                    }
                    Ok(_) => {}
                    Err(e) => {
                        // Fail-closed: if we can't determine container state, assume
                        // they're running to prevent data loss from unexpected restart.
                        log::warn!(
                            "restart_app: compose_ps failed for '{}': {e}, assuming running",
                            project.name
                        );
                        return Ok(Some(project.name.clone()));
                    }
                }
            }
            Ok(None)
        })
        .await
        .map_err(|e| e.to_string())??;

        if let Some(project_name) = running_project {
            return Err(format!(
                "Cannot restart: containers are running for project '{}'. Stop them first or use force restart.",
                project_name
            ));
        }
    }

    log::info!("restart_app: restarting on frontend request (force={force})");
    app.restart()
}

// ---------------------------------------------------------------------------
// Tray click debounce
// ---------------------------------------------------------------------------

/// Returns `true` if a click should be suppressed (debounced).
///
/// A click is suppressed when the elapsed time since the previous click
/// (`now_ms.saturating_sub(prev_ms)`) is less than `threshold_ms`. Uses saturating
/// subtraction so that a backward clock jump suppresses rather than
/// double-toggles.
#[cfg_attr(target_os = "linux", allow(dead_code))]
fn should_debounce(prev_ms: u64, now_ms: u64, threshold_ms: u64) -> bool {
    now_ms.saturating_sub(prev_ms) < threshold_ms
}

/// Determines what the `CloseRequested` handler should do.
///
/// Returns `true` when the close should be intercepted (prevent close + hide).
/// Returns `false` when the close should proceed normally (app exits).
fn should_prevent_close(window_label: &str, tray_available: bool) -> bool {
    window_label == MAIN_WINDOW_LABEL && tray_available
}

/// Returns `true` if the `Destroyed` event should trigger cleanup.
///
/// Only the main window destruction runs cleanup — dialog or secondary
/// windows must not prematurely stop services.
fn should_run_cleanup(window_label: &str) -> bool {
    window_label == MAIN_WINDOW_LABEL
}

// ---------------------------------------------------------------------------
// Window visibility helpers (tray-only app)
// ---------------------------------------------------------------------------

/// Shows the main window and sets the macOS activation policy to Regular
/// so the app appears in the Dock while the window is visible.
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        if let Err(e) = window.show() {
            log::warn!("failed to show window: {e}");
        }
        if let Err(e) = window.set_focus() {
            log::warn!("failed to set focus: {e}");
        }
        #[cfg(target_os = "macos")]
        {
            if let Err(e) = app.set_activation_policy(tauri::ActivationPolicy::Regular) {
                log::warn!("failed to set activation policy to Regular: {e}");
            }
        }
    } else {
        log::warn!("main window not found");
    }
}

/// Hides the main window and sets the macOS activation policy to Accessory
/// so the app disappears from the Dock (tray-only).
fn hide_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        if let Err(e) = window.hide() {
            log::warn!("failed to hide window: {e}");
        }
        #[cfg(target_os = "macos")]
        {
            if let Err(e) = app.set_activation_policy(tauri::ActivationPolicy::Accessory) {
                log::warn!("failed to set activation policy to Accessory: {e}");
            }
        }
    } else {
        log::warn!("main window not found");
    }
}

/// After mcp-os starts on a new dynamic port, check if running containers have
/// a stale WORKER_OS_URL in their compose.yml. If so, regenerate compose and
/// recreate containers so the hub connects to the correct port.
///
/// Runs in a background thread to avoid blocking app startup.
fn reconcile_compose_port(app_handle: &tauri::AppHandle) {
    let handle = app_handle.clone();
    std::thread::spawn(move || {
        let project = match config::load_user_config()
            .ok()
            .and_then(|c| c.active_project)
        {
            Some(p) => p,
            None => {
                log::debug!("reconcile_compose_port: no active project");
                return;
            }
        };

        let rt = speedwave_runtime::runtime::detect_runtime();
        if !rt.is_available() {
            log::debug!("reconcile_compose_port: runtime not available");
            return;
        }

        // Check if containers are running
        let containers = match rt.compose_ps(&project) {
            Ok(c) => c,
            Err(e) => {
                log::debug!("reconcile_compose_port: compose_ps failed: {e}");
                return;
            }
        };
        if containers.is_empty() {
            log::debug!("reconcile_compose_port: no containers running");
            return;
        }

        // Read current compose and check if WORKER_OS_URL matches the port file
        let home = match dirs::home_dir() {
            Some(h) => h,
            None => {
                log::debug!("reconcile_compose_port: cannot determine home directory");
                return;
            }
        };
        let data_dir = home.join(speedwave_runtime::consts::DATA_DIR);
        let port_path = data_dir.join(speedwave_runtime::consts::MCP_OS_PORT_FILE);
        let current_port = match std::fs::read_to_string(&port_path) {
            Ok(c) => match c.trim().parse::<u16>() {
                Ok(p) => p,
                Err(e) => {
                    log::debug!("reconcile_compose_port: port parse error: {e}");
                    return;
                }
            },
            Err(e) => {
                log::debug!("reconcile_compose_port: port file read error: {e}");
                return;
            }
        };

        let compose_dir = data_dir.join("compose").join(&project);
        let compose_path = compose_dir.join("compose.yml");
        let compose_content = match std::fs::read_to_string(&compose_path) {
            Ok(c) => c,
            Err(e) => {
                log::debug!("reconcile_compose_port: compose file read error: {e}");
                return;
            }
        };

        // Check if compose already has the correct port
        let expected_url_fragment = format!(":{current_port}");
        if let Some(line) = compose_content
            .lines()
            .find(|l| l.contains("WORKER_OS_URL="))
        {
            if line.contains(&expected_url_fragment) {
                log::debug!("compose WORKER_OS_URL already matches mcp-os port {current_port}");
                return;
            }
            log::info!(
                "compose WORKER_OS_URL is stale (mcp-os port is {current_port}), regenerating"
            );
        } else {
            log::debug!(
                "reconcile_compose_port: no WORKER_OS_URL in compose, OS integration not enabled"
            );
            return;
        }

        // Regenerate compose with the current port
        let user_config = match config::load_user_config() {
            Ok(c) => c,
            Err(e) => {
                log::error!("reconcile_compose_port: failed to load config: {e}");
                return;
            }
        };
        let project_dir = match user_config.projects.iter().find(|p| p.name == project) {
            Some(p) => p.dir.clone(),
            None => {
                log::debug!("reconcile_compose_port: project '{project}' not found in config");
                return;
            }
        };

        let project_path = std::path::Path::new(&project_dir);
        let (resolved, integrations) =
            config::resolve_project_config(project_path, &user_config, &project);

        let yaml = match speedwave_runtime::compose::render_compose(
            &project,
            &project_dir,
            &resolved,
            &integrations,
        ) {
            Ok(y) => y,
            Err(e) => {
                log::error!("reconcile_compose_port: render_compose failed: {e}");
                return;
            }
        };

        let violations = speedwave_runtime::compose::SecurityCheck::run(&yaml, &project);
        if !violations.is_empty() {
            let msgs: Vec<String> = violations
                .iter()
                .map(|v| format!("[{}] {} -- {}", v.container, v.rule, v.message))
                .collect();
            log::error!(
                "reconcile_compose_port: security check failed:\n{}",
                msgs.join("\n")
            );
            return;
        }

        if let Err(e) = speedwave_runtime::compose::save_compose(&project, &yaml) {
            log::error!("reconcile_compose_port: save_compose failed: {e}");
            return;
        }

        // Recreate containers with the new compose
        if let Err(e) = rt.compose_up_recreate(&project) {
            log::error!("reconcile_compose_port: compose_up_recreate failed: {e}");
            return;
        }

        log::info!("reconcile_compose_port: containers recreated with mcp-os port {current_port}");

        // Notify the frontend that containers were restarted
        use tauri::Emitter;
        let _ = handle.emit("containers_reconciled", current_port);
    });
}

/// Runs cleanup when the main window is destroyed: stops IDE Bridge,
/// mcp-os process, and aborts the background auto-update check.
fn run_exit_cleanup(
    ide_bridge: &SharedIdeBridge,
    mcp_os: &Arc<Mutex<Option<mcp_os_process::McpOsProcess>>>,
    auto_check: &SharedAutoCheckHandle,
) {
    match ide_bridge.lock() {
        Ok(mut guard) => {
            if let Some(mut bridge) = guard.take() {
                if let Err(e) = bridge.stop() {
                    log::warn!("IDE Bridge stop error: {e}");
                }
            }
        }
        Err(e) => log::warn!("IDE Bridge cleanup skipped: mutex poisoned: {e}"),
    }
    match mcp_os.lock() {
        Ok(mut guard) => {
            if let Some(mut proc) = guard.take() {
                if let Err(e) = proc.stop() {
                    log::warn!("mcp-os stop error: {e}");
                }
                proc.cleanup_files();
            }
        }
        Err(e) => log::warn!("mcp-os cleanup skipped: mutex poisoned: {e}"),
    }
    match auto_check.lock() {
        Ok(mut guard) => {
            if let Some(handle) = guard.take() {
                handle.abort();
                log::info!("auto-update check task cancelled on exit");
            }
        }
        Err(e) => log::warn!("auto-check cleanup skipped: mutex poisoned: {e}"),
    }
}

// ---------------------------------------------------------------------------
// System tray
// ---------------------------------------------------------------------------

/// Builds the system tray context menu. If an update is available, includes
/// an "Install Update" item.
fn build_tray_menu(
    app: &tauri::AppHandle,
    update_version: &Option<String>,
) -> Result<tauri::menu::Menu<tauri::Wry>, tauri::Error> {
    let open = MenuItemBuilder::with_id("open", "Open Speedwave").build(app)?;
    let check_update = MenuItemBuilder::with_id("check_update", "Check for Updates").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;

    let mut builder = MenuBuilder::new(app)
        .item(&open)
        .separator()
        .item(&check_update);

    if let Some(version) = update_version {
        let install_update =
            MenuItemBuilder::with_id("install_update", format!("Install Update v{version}"))
                .build(app)?;
        builder = builder.item(&install_update);
    }

    builder.separator().item(&quit).build()
}

/// Rebuilds the tray menu to reflect a newly discovered update version.
fn refresh_tray_menu(app: &tauri::AppHandle, update_version: &Option<String>) {
    match build_tray_menu(app, update_version) {
        Ok(menu) => {
            if let Some(tray) = app.tray_by_id("main-tray") {
                if let Err(e) = tray.set_menu(Some(menu)) {
                    log::warn!("tray: failed to set menu: {e}");
                }
            }
        }
        Err(e) => log::warn!("tray: failed to build menu: {e}"),
    }
}

// ---------------------------------------------------------------------------
// Integration management commands
// ---------------------------------------------------------------------------

#[tauri::command]
fn get_integrations(project: String) -> Result<IntegrationsResponse, String> {
    check_project(&project)?;
    let user_config = config::load_user_config().map_err(|e| e.to_string())?;
    let project_entry = user_config.projects.iter().find(|p| p.name == project);

    let project_dir = project_entry
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

        let mut current_values = std::collections::HashMap::new();
        for field in &auth_fields {
            if SECRET_FIELDS.contains(&field.key.as_str()) {
                continue;
            }
            if svc == "redmine"
                && (field.key == "host_url"
                    || field.key == "project_id"
                    || field.key == "project_name")
            {
                let config_path = svc_token_dir.join("config.json");
                if let Ok(content) = std::fs::read_to_string(&config_path) {
                    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                        if let Some(val) = json.get(&field.key).and_then(|v| v.as_str()) {
                            current_values.insert(field.key.clone(), val.to_string());
                        }
                    }
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

        let mappings = if svc == "redmine" {
            let config_path = svc_token_dir.join("config.json");
            std::fs::read_to_string(&config_path)
                .ok()
                .and_then(|content| serde_json::from_str::<serde_json::Value>(&content).ok())
                .and_then(|json| json.get("mappings").cloned())
                .and_then(|m| serde_json::from_value(m).ok())
        } else {
            None
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

    let os = vec![
        OsIntegrationStatusEntry {
            service: "reminders".into(),
            enabled: integrations.os_reminders,
            display_name: "Reminders".into(),
            description: "Native OS reminders and tasks".into(),
        },
        OsIntegrationStatusEntry {
            service: "calendar".into(),
            enabled: integrations.os_calendar,
            display_name: "Calendar".into(),
            description: "Native OS calendar events".into(),
        },
        OsIntegrationStatusEntry {
            service: "mail".into(),
            enabled: integrations.os_mail,
            display_name: "Mail".into(),
            description: "Native OS email client".into(),
        },
        OsIntegrationStatusEntry {
            service: "notes".into(),
            enabled: integrations.os_notes,
            display_name: "Notes".into(),
            description: "Native OS notes".into(),
        },
    ];

    Ok(IntegrationsResponse {
        services: service_entries,
        os,
    })
}

fn is_service_configured(project: &str, service: &str) -> bool {
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
    auth_fields.iter().any(|f| {
        if SECRET_FIELDS.contains(&f.key.as_str()) {
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
fn set_integration_enabled(project: String, service: String, enabled: bool) -> Result<(), String> {
    check_project(&project)?;
    log::info!("set_integration_enabled: project={project} service={service} enabled={enabled}");

    let _lock = CONFIG_LOCK.lock().map_err(|e| e.to_string())?;

    if enabled && !is_service_configured(&project, &service) {
        return Err(format!("{service} has no credentials configured"));
    }

    let mut user_config = config::load_user_config().map_err(|e| e.to_string())?;

    let entry = user_config
        .projects
        .iter_mut()
        .find(|p| p.name == project)
        .ok_or_else(|| format!("project '{}' not found", project))?;

    let integrations = entry.integrations.get_or_insert_with(Default::default);
    let cfg = config::IntegrationConfig {
        enabled: Some(enabled),
    };

    if !integrations.set_service(&service, cfg) {
        return Err(format!("unknown service: {}", service));
    }

    config::save_user_config(&user_config).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_os_integration_enabled(
    project: String,
    service: String,
    enabled: bool,
) -> Result<(), String> {
    check_project(&project)?;
    log::info!("set_os_integration_enabled: project={project} service={service} enabled={enabled}");
    let _lock = CONFIG_LOCK.lock().map_err(|e| e.to_string())?;
    let mut user_config = config::load_user_config().map_err(|e| e.to_string())?;

    let entry = user_config
        .projects
        .iter_mut()
        .find(|p| p.name == project)
        .ok_or_else(|| format!("project '{}' not found", project))?;

    let integrations = entry.integrations.get_or_insert_with(Default::default);
    let os = integrations.os.get_or_insert_with(Default::default);
    let cfg = config::IntegrationConfig {
        enabled: Some(enabled),
    };

    match service.as_str() {
        "reminders" => os.reminders = Some(cfg),
        "calendar" => os.calendar = Some(cfg),
        "mail" => os.mail = Some(cfg),
        "notes" => os.notes = Some(cfg),
        _ => return Err(format!("unknown OS service: {}", service)),
    }

    config::save_user_config(&user_config).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_integration_credentials(
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

    let mut redmine_config: Option<serde_json::Value> = None;
    if service == "redmine" {
        let config_path = svc_dir.join("config.json");
        let mut config_obj = if let Ok(content) = std::fs::read_to_string(&config_path) {
            serde_json::from_str::<serde_json::Value>(&content)
                .map_err(|e| format!("existing config.json is corrupted: {e}"))?
        } else {
            serde_json::json!({})
        };

        for (key, value) in &credentials {
            match key.as_str() {
                "host_url" | "project_id" | "project_name" => {
                    config_obj[key] = serde_json::Value::String(value.clone());
                }
                _ => {}
            }
        }
        redmine_config = Some(config_obj);
    }

    for (key, value) in &credentials {
        if !allowed.contains(&key.as_str()) {
            return Err(format!(
                "field '{}' not allowed for service '{}'",
                key, service
            ));
        }
        if key.contains('/') || key.contains('\\') || key.contains("..") {
            return Err(format!("invalid field name: {}", key));
        }
        if value.len() > 4096 {
            return Err(format!("value for '{}' exceeds 4096 bytes", key));
        }

        if service == "redmine"
            && (key == "host_url" || key == "project_id" || key == "project_name")
        {
            continue;
        }

        let file_path = svc_dir.join(key);
        std::fs::write(&file_path, value).map_err(|e| e.to_string())?;
        fs_perms::set_owner_only(&file_path)?;
    }

    if let Some(config_obj) = redmine_config {
        let config_path = svc_dir.join("config.json");
        let json = serde_json::to_string_pretty(&config_obj).map_err(|e| e.to_string())?;
        std::fs::write(&config_path, &json).map_err(|e| e.to_string())?;
        fs_perms::set_owner_only(&config_path)?;
    }

    Ok(())
}

#[tauri::command]
fn save_redmine_mappings(
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
    fs_perms::set_owner_only(&config_path)?;

    Ok(())
}

#[tauri::command]
fn delete_integration_credentials(project: String, service: String) -> Result<(), String> {
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
    let _lock = CONFIG_LOCK.lock().map_err(|e| e.to_string())?;
    let mut user_config = config::load_user_config().map_err(|e| e.to_string())?;
    if let Some(entry) = user_config.projects.iter_mut().find(|p| p.name == project) {
        let integrations = entry.integrations.get_or_insert_with(Default::default);
        let cfg = config::IntegrationConfig {
            enabled: Some(false),
        };
        integrations.set_service(&service, cfg);
        config::save_user_config(&user_config).map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[tauri::command]
async fn restart_integration_containers(project: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        check_project(&project)?;
        log::info!("restart_integration_containers: project={project}");
        let rt = speedwave_runtime::runtime::detect_runtime();

        // Save snapshot of current compose.yml for rollback before any changes
        if let Err(e) = speedwave_runtime::update::save_snapshot(&project) {
            log::warn!("restart_integration_containers: save_snapshot failed, rollback will not work: {e}");
        }

        rt.compose_down(&project).map_err(|e| {
            log::error!("restart_integration_containers: compose_down error: {e}");
            e.to_string()
        })?;

        let user_config = config::load_user_config().map_err(|e| e.to_string())?;
        let project_dir = user_config
            .projects
            .iter()
            .find(|p| p.name == project)
            .map(|p| p.dir.clone())
            .ok_or_else(|| format!("project '{}' not found", project))?;

        let project_path = std::path::Path::new(&project_dir);
        let (resolved, integrations) =
            config::resolve_project_config(project_path, &user_config, &project);
        let yaml =
            speedwave_runtime::compose::render_compose(&project, &project_dir, &resolved, &integrations)
                .map_err(|e| e.to_string())?;

        let violations = speedwave_runtime::compose::SecurityCheck::run(&yaml, &project);
        if !violations.is_empty() {
            let msgs: Vec<String> = violations
                .iter()
                .map(|v| format!("[{}] {} -- {}", v.container, v.rule, v.message))
                .collect();
            return Err(format!("Security check failed:\n{}", msgs.join("\n")));
        }

        speedwave_runtime::compose::save_compose(&project, &yaml).map_err(|e| e.to_string())?;

        if let Err(e) = rt.compose_up(&project) {
            log::error!("restart_integration_containers: compose_up failed: {e}, attempting rollback");
            if let Err(rb_err) = speedwave_runtime::update::rollback_containers(&*rt, &project) {
                log::error!("restart_integration_containers: rollback also failed: {rb_err}");
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
// Diagnostic export
// ---------------------------------------------------------------------------

/// Inputs for building a diagnostics ZIP — extracted for testability.
struct DiagnosticsInput {
    /// Directory containing `.log` files (app logs).
    log_dir: Option<std::path::PathBuf>,
    /// Path to the Lima VM serial log (macOS only).
    serial_log: Option<std::path::PathBuf>,
    /// Container logs as a raw string (already fetched from runtime).
    container_logs: Option<String>,
    /// Path to the project's `compose.yml`.
    compose_path: Option<std::path::PathBuf>,
}

/// Builds a diagnostics ZIP at `zip_path` from the provided inputs.
///
/// All textual content is passed through `log_sanitizer::sanitize()` before
/// being written to the archive. System info is appended without sanitization.
fn build_diagnostics_zip(
    zip_path: &std::path::Path,
    input: &DiagnosticsInput,
) -> anyhow::Result<()> {
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    let file = std::fs::File::create(zip_path)?;
    let mut zip = zip::ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    // 1. App logs
    if let Some(ref log_dir) = input.log_dir {
        if let Ok(entries) = std::fs::read_dir(log_dir) {
            let mut log_paths: Vec<_> = entries
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.extension().map(|e| e == "log").unwrap_or(false))
                .collect();
            log_paths.sort();
            for path in &log_paths {
                if let Ok(content) = std::fs::read_to_string(path) {
                    let sanitized = speedwave_runtime::log_sanitizer::sanitize(&content);
                    let name = format!(
                        "logs/{}",
                        path.file_name().unwrap_or_default().to_string_lossy()
                    );
                    zip.start_file(&name, options)?;
                    zip.write_all(sanitized.as_bytes())?;
                }
            }
        }
    }

    // 2. Lima VM serial log
    if let Some(ref serial_log) = input.serial_log {
        if serial_log.exists() {
            if let Ok(content) = std::fs::read_to_string(serial_log) {
                let sanitized = speedwave_runtime::log_sanitizer::sanitize(&content);
                zip.start_file("lima/serial.log", options)?;
                zip.write_all(sanitized.as_bytes())?;
            }
        }
    }

    // 3. Container logs
    if let Some(ref logs) = input.container_logs {
        let sanitized = speedwave_runtime::log_sanitizer::sanitize(logs);
        zip.start_file("containers/compose.log", options)?;
        zip.write_all(sanitized.as_bytes())?;
    }

    // 4. compose.yml
    if let Some(ref compose_path) = input.compose_path {
        if compose_path.exists() {
            if let Ok(content) = std::fs::read_to_string(compose_path) {
                let sanitized = speedwave_runtime::log_sanitizer::sanitize(&content);
                zip.start_file("containers/compose.yml", options)?;
                zip.write_all(sanitized.as_bytes())?;
            }
        }
    }

    // 5. System info (no sanitization needed)
    let sys_info = format!(
        "os: {}\narch: {}\nversion: {}\n",
        std::env::consts::OS,
        std::env::consts::ARCH,
        env!("CARGO_PKG_VERSION"),
    );
    zip.start_file("system-info.txt", options)?;
    zip.write_all(sys_info.as_bytes())?;

    zip.finish()?;
    Ok(())
}

/// Collects app logs, container logs, compose config, and system info into a
/// sanitized ZIP archive for support diagnostics.
#[tauri::command]
async fn export_diagnostics(project: String) -> Result<String, String> {
    check_project(&project)?;

    tokio::task::spawn_blocking(move || -> anyhow::Result<String> {
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        let downloads = dirs::download_dir()
            .or_else(dirs::home_dir)
            .ok_or_else(|| anyhow::anyhow!("cannot determine downloads directory"))?;

        let zip_path = downloads.join(format!("speedwave-diagnostics-{timestamp}.zip"));

        let log_dir = if cfg!(target_os = "macos") {
            dirs::home_dir().map(|h| h.join("Library/Logs/pl.speedwave.desktop"))
        } else {
            dirs::home_dir().map(|h| h.join(".local/share/pl.speedwave.desktop/logs"))
        };

        let serial_log = if cfg!(target_os = "macos") {
            dirs::home_dir().map(|h| h.join(".speedwave/lima/speedwave/serial.log"))
        } else {
            None
        };

        let rt = speedwave_runtime::runtime::detect_runtime();
        let container_logs = rt.compose_logs(&project, 5000).ok();

        let compose_path = dirs::home_dir().map(|h| {
            h.join(speedwave_runtime::consts::DATA_DIR)
                .join("projects")
                .join(&project)
                .join("compose.yml")
        });

        let input = DiagnosticsInput {
            log_dir,
            serial_log,
            container_logs,
            compose_path,
        };

        build_diagnostics_zip(&zip_path, &input)?;

        Ok(zip_path.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Application entry point
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Log level commands
// ---------------------------------------------------------------------------

fn parse_log_level(s: &str) -> Option<log::LevelFilter> {
    match s.to_lowercase().as_str() {
        "error" => Some(log::LevelFilter::Error),
        "warn" => Some(log::LevelFilter::Warn),
        "info" => Some(log::LevelFilter::Info),
        "debug" => Some(log::LevelFilter::Debug),
        "trace" => Some(log::LevelFilter::Trace),
        _ => None,
    }
}

#[tauri::command]
fn set_log_level(level: String) -> Result<(), String> {
    let filter = parse_log_level(&level).ok_or_else(|| format!("Invalid log level: {level}"))?;
    log::info!("Log level changed to {level}");
    log::set_max_level(filter);
    if let Err(e) = persist_log_level(&level) {
        log::warn!("Failed to persist log level: {e}");
    }
    Ok(())
}

#[tauri::command]
fn get_log_level() -> String {
    log::max_level().to_string()
}

fn persist_log_level(level: &str) -> anyhow::Result<()> {
    let _lock = CONFIG_LOCK
        .lock()
        .map_err(|e| anyhow::anyhow!("config lock poisoned: {e}"))?;
    let mut config = config::load_user_config()?;
    config.log_level = Some(level.to_lowercase());
    config::save_user_config(&config)
}

// ---------------------------------------------------------------------------
// Log cleanup
// ---------------------------------------------------------------------------

/// Removes old rotated log files, keeping at most `max_files` recent ones.
fn cleanup_old_logs(max_files: usize) {
    let log_dir = match dirs::home_dir() {
        Some(h) => {
            if cfg!(target_os = "macos") {
                h.join("Library/Logs/pl.speedwave.desktop")
            } else {
                h.join(".local/share/pl.speedwave.desktop/logs")
            }
        }
        None => return,
    };

    cleanup_log_dir(&log_dir, max_files);
}

/// Core logic for log cleanup — operates on an arbitrary directory.
///
/// Keeps the `max_files` most-recently-modified `.log` files in `log_dir` and
/// deletes the rest.  Non-`.log` files are never touched.
fn cleanup_log_dir(log_dir: &std::path::Path, max_files: usize) {
    let entries = match std::fs::read_dir(log_dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    let mut log_files: Vec<_> = entries
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.path()
                .extension()
                .map(|ext| ext == "log")
                .unwrap_or(false)
        })
        .filter_map(|e| {
            e.metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .map(|t| (e.path(), t))
        })
        .collect();

    if log_files.len() <= max_files {
        return;
    }

    // Sort by modification time, newest first
    log_files.sort_by(|a, b| b.1.cmp(&a.1));

    // Remove the oldest files beyond the limit
    for (path, _) in log_files.iter().skip(max_files) {
        if let Err(e) = std::fs::remove_file(path) {
            log::warn!("failed to remove old log file {}: {e}", path.display());
        }
    }
}

/// Resolves the bundled resources directory from the executable's parent path.
///
/// Platform conventions:
/// - macOS: `<exe>/../../Resources` (inside .app bundle)
/// - Linux: `<exe>/../lib/Speedwave` (.deb — Tauri convention)
/// - Windows: `<exe>/resources` (NSIS installer)
///
/// Returns `None` in dev mode (no bundle structure present).
fn resolve_resources_dir(exe_parent: &std::path::Path) -> Option<std::path::PathBuf> {
    let candidates: Vec<std::path::PathBuf> = if cfg!(target_os = "macos") {
        exe_parent
            .parent()
            .map(|p| vec![p.join("Resources")])
            .unwrap_or_default()
    } else if cfg!(target_os = "linux") {
        // .deb: resources at <exe>/../lib/<productName>/
        let lib_path = exe_parent.parent().map(|p| p.join("lib").join("Speedwave"));
        let mut paths = Vec::new();
        if let Some(p) = lib_path {
            paths.push(p);
        }
        // Fallback: <exe>/resources (dev builds / non-standard layouts)
        paths.push(exe_parent.join("resources"));
        paths
    } else {
        // Windows NSIS: resources are installed alongside the .exe (no subdirectory).
        // Fallback: <exe>/resources (dev builds / non-standard layouts).
        vec![exe_parent.to_path_buf(), exe_parent.join("resources")]
    };

    // Verify the candidate actually contains bundled resources (not just that
    // the directory exists — exe_parent always exists).  Check for a known
    // bundled file to confirm it's the right directory.
    //
    // On Windows, check for the actual CLI binary (cli/speedwave.exe) to avoid
    // false positives from an empty cli/ directory. On Unix, check for the
    // directory since the binary name is platform-constant.
    candidates.into_iter().find(|p| {
        let has_cli = if cfg!(target_os = "windows") {
            p.join("cli").join("speedwave.exe").exists()
        } else {
            p.join("cli").exists()
        };
        has_cli || p.join("mcp-os").exists() || p.join("build-context").exists()
    })
}

fn main() {
    // Panic hook — sanitize panic payload before logging
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let sanitized = speedwave_runtime::log_sanitizer::sanitize(&format!("{info}"));
        log::error!("PANIC: {sanitized}");
        #[cfg(debug_assertions)]
        default_hook(info);
        #[cfg(not(debug_assertions))]
        {
            let _ = &default_hook; // suppress unused warning
            #[allow(clippy::print_stderr)]
            {
                eprintln!("PANIC: {sanitized}");
            }
        }
    }));

    // Bundled binary resolution for app bundles.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            if let Some(res) = resolve_resources_dir(parent) {
                std::env::set_var(speedwave_runtime::consts::BUNDLE_RESOURCES_ENV, &res);
                if let Err(e) = speedwave_runtime::build::write_resources_marker(&res) {
                    log::warn!("could not write resources-dir marker: {e}");
                }
            }
        }
    }

    let initial_session: SharedChatSession = Arc::new(Mutex::new(ChatSession::new("default")));

    // Shared state for IDE Bridge, mcp-os process, auto-check handle, and tray update version
    let ide_bridge: SharedIdeBridge = Arc::new(Mutex::new(None));
    let mcp_os: Arc<Mutex<Option<mcp_os_process::McpOsProcess>>> = Arc::new(Mutex::new(None));
    let auto_check_handle: SharedAutoCheckHandle = Arc::new(Mutex::new(None));
    let update_version: SharedUpdateVersion = Arc::new(Mutex::new(None));

    let tray_available = Arc::new(AtomicBool::new(false));
    #[cfg_attr(target_os = "linux", allow(unused_variables))]
    let tray_available_setup = tray_available.clone();
    let tray_available_close = tray_available.clone();

    let ide_bridge_exit = ide_bridge.clone();
    let mcp_os_exit = mcp_os.clone();
    let auto_check_exit = auto_check_handle.clone();
    let update_version_setup = update_version.clone();

    let mut builder = tauri::Builder::default();

    // WebDriver server for E2E tests — only present when the "e2e" feature is
    // enabled. The plugin embeds a W3C WebDriver server on 127.0.0.1:4445 so
    // E2E specs can drive the real app via WebdriverIO.
    // Production releases are built without the feature — the crate is not
    // compiled or linked, so zero attack surface.
    #[cfg(feature = "e2e")]
    {
        builder = builder.plugin(tauri_plugin_webdriver::init());
    }

    #[allow(clippy::expect_used)]
    builder
        .plugin({
            use tauri_plugin_log::{RotationStrategy, Target, TargetKind, TimezoneStrategy};
            tauri_plugin_log::Builder::new()
                .timezone_strategy(TimezoneStrategy::UseLocal)
                .targets([
                    Target::new(TargetKind::Stdout),
                    Target::new(TargetKind::LogDir {
                        file_name: Some("speedwave-desktop".into()),
                    }),
                    Target::new(TargetKind::Webview),
                ])
                .level(log::LevelFilter::Trace)
                .level_for("hyper", log::LevelFilter::Warn)
                .level_for("tungstenite", log::LevelFilter::Warn)
                .level_for("tokio_tungstenite", log::LevelFilter::Warn)
                .level_for("reqwest", log::LevelFilter::Warn)
                .max_file_size(50_000_000)
                .rotation_strategy(RotationStrategy::KeepAll)
                .format(move |callback, message, record| {
                    let sanitized =
                        speedwave_runtime::log_sanitizer::sanitize(&format!("{message}"));
                    callback.finish(format_args!(
                        "[{level}][{target}] {sanitized}",
                        level = record.level(),
                        target = record.target(),
                    ))
                })
                .build()
        })
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Second instance tried to launch — focus the existing window instead.
            if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                let _ = window.set_focus();
                if let Ok(false) = window.is_visible() {
                    let _ = window.show();
                }
            }
        }))
        .manage(initial_session)
        .manage(ide_bridge.clone())
        .setup(move |app| {
            // Restore persisted log level (default: Info)
            let initial_level = config::load_user_config()
                .ok()
                .and_then(|c| c.log_level)
                .and_then(|l| parse_log_level(&l))
                .unwrap_or(log::LevelFilter::Info);
            log::set_max_level(initial_level);

            // Clean up old rotated log files (max 10 kept)
            cleanup_old_logs(10);

            // Periodic cleanup every hour for long-running sessions
            tauri::async_runtime::spawn(async {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
                    cleanup_old_logs(10);
                }
            });

            // Start IDE Bridge
            match ide_bridge::IdeBridge::new() {
                Ok(mut bridge) => {
                    // Wire event callback to emit Tauri events to the Angular frontend
                    let app_handle = app.handle().clone();
                    bridge.set_event_callback(std::sync::Arc::new(move |kind, detail| {
                        use tauri::Emitter;
                        if let Err(e) = app_handle.emit(
                            "ide_bridge_event",
                            serde_json::json!({ "kind": kind, "detail": detail }),
                        ) {
                            log::error!("failed to emit ide_bridge_event: {e}");
                        }
                    }));

                    if let Err(e) = bridge.start() {
                        log::error!("IDE Bridge start error: {e}");
                    } else {
                        log::info!("IDE Bridge started");
                        // Restore upstream IDE selection from persisted config
                        if let Ok(cfg) = config::load_user_config() {
                            if let Some(sel) = cfg.selected_ide {
                                match bridge.set_upstream(sel.ide_name.clone(), sel.port) {
                                    Ok(()) => log::info!(
                                        "IDE Bridge: restored upstream {} :{}",
                                        sel.ide_name,
                                        sel.port
                                    ),
                                    Err(e) => {
                                        log::warn!("IDE Bridge: failed to restore upstream: {e}")
                                    }
                                }
                            }
                        }
                    }
                    if let Ok(mut guard) = ide_bridge.lock() {
                        *guard = Some(bridge);
                    }
                }
                Err(e) => log::error!("IDE Bridge init error: {e}"),
            }

            // Start mcp-os process
            let script = speedwave_runtime::build::resolve_mcp_os_script();

            if let Some(script_path) = script {
                let script_str = script_path.to_string_lossy().to_string();
                match mcp_os_process::McpOsProcess::spawn(&script_str) {
                    Ok(proc) => {
                        let new_port = proc.port();
                        log::info!("mcp-os process started (port {new_port})");
                        if let Ok(mut guard) = mcp_os.lock() {
                            *guard = Some(proc);
                        }

                        // If containers are already running, regenerate compose with the
                        // new mcp-os port and recreate them. Without this, the hub would
                        // keep connecting to the old (dead) port from the previous session.
                        reconcile_compose_port(app.handle());
                    }
                    Err(e) => log::error!("mcp-os spawn error: {e}"),
                }
            } else {
                log::warn!("mcp-os script not found — OS integrations will be unavailable");
            }

            // Start background auto-update check (store handle for cancellation)
            let handle = updater::spawn_auto_check(app.handle().clone());
            match auto_check_handle.lock() {
                Ok(mut guard) => *guard = Some(handle),
                Err(e) => log::warn!("auto-check handle mutex poisoned: {e}"),
            }

            // Re-link CLI binary on every startup to keep it in sync after updates.
            // Runs unconditionally — users may need the CLI for OAuth authentication
            // before completing the setup wizard.
            if let Err(e) = setup_wizard::link_cli() {
                log::warn!("CLI re-link on startup failed: {e}");
            }

            // Linux safety net: show the window immediately on startup.
            // Tray icon support on Linux depends on libappindicator/libayatana
            // and may be invisible even when tray_builder.build() succeeds
            // (e.g. GNOME without AppIndicator extension). Showing the window
            // ensures the user is never left with an invisible app. Close always
            // exits on Linux — tray_available is never set (see below).
            #[cfg(target_os = "linux")]
            show_main_window(app.handle());

            // Build system tray. If creation fails, fall back to visible
            // window (see Linux safety net above).
            let tray_menu = build_tray_menu(app.handle(), &None)?;
            let update_version_tray = update_version_setup.clone();
            let tray_icon = app
                .default_window_icon()
                .cloned()
                .ok_or("No default window icon")?;

            #[cfg_attr(target_os = "linux", allow(unused_mut))]
            let mut tray_builder = TrayIconBuilder::with_id("main-tray")
                .icon(tray_icon)
                .icon_as_template(true)
                .tooltip("Speedwave")
                .menu(&tray_menu)
                .on_menu_event(move |app, event| match event.id().as_ref() {
                    "open" => {
                        show_main_window(app);
                    }
                    "check_update" => {
                        let app_clone = app.clone();
                        tauri::async_runtime::spawn(async move {
                            match updater::check_for_update(&app_clone).await {
                                Ok(Some(info)) => {
                                    log::info!("tray: update available: {}", info.version);
                                    use tauri::Emitter;
                                    if let Err(e) = app_clone.emit("update_available", &info) {
                                        log::error!(
                                            "tray: failed to emit update_available event: {e}"
                                        );
                                    }
                                }
                                Ok(None) => {
                                    log::info!("tray: already up to date");
                                }
                                Err(e) => {
                                    log::error!("tray: check failed: {e}");
                                }
                            }
                        });
                    }
                    "install_update" => {
                        let app_clone = app.clone();
                        let uv = update_version_tray.clone();
                        tauri::async_runtime::spawn(async move {
                            let version = uv.lock().ok().and_then(|g| g.clone());
                            if let Some(expected) = version {
                                match updater::install_update(&app_clone, expected).await {
                                    Ok(()) => {
                                        log::info!("tray: update installed, restarting");
                                        app_clone.restart();
                                    }
                                    Err(e) => {
                                        log::error!("tray: install failed: {e}");
                                    }
                                }
                            } else {
                                log::warn!("tray: install_update clicked but no version available");
                            }
                        });
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    other => {
                        log::warn!("tray: unhandled menu event: {other}");
                    }
                });

            // macOS/Windows: left-click on tray icon toggles window visibility.
            // Linux: TrayIconEvent::Click is unsupported — users rely on the
            // right-click menu "Open Speedwave" instead.
            #[cfg(not(target_os = "linux"))]
            {
                use std::sync::atomic::AtomicU64;
                // Debounce: ignore clicks within 500ms of the previous one
                // to prevent double-toggle from rapid clicks. 500ms equals the
                // Windows default double-click interval, though users with
                // accessibility settings may have a longer interval (up to 900ms).
                // On Windows a double-click fires two Click::Up events.
                static LAST_CLICK_MS: AtomicU64 = AtomicU64::new(0);
                const DEBOUNCE_MS: u64 = 500;

                tray_builder = tray_builder
                    .show_menu_on_left_click(false)
                    .on_tray_icon_event(|tray, event| {
                        if let tauri::tray::TrayIconEvent::Click {
                            button: tauri::tray::MouseButton::Left,
                            button_state: tauri::tray::MouseButtonState::Up,
                            ..
                        } = event
                        {
                            let now = match std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                            {
                                // as u64: truncation at ~584 million years — safe
                                Ok(d) => d.as_millis() as u64,
                                Err(e) => {
                                    log::warn!(
                                        "tray: system clock error (before Unix epoch?): {e}"
                                    );
                                    0
                                }
                            };
                            let prev = LAST_CLICK_MS.swap(now, Ordering::Relaxed);
                            if should_debounce(prev, now, DEBOUNCE_MS) {
                                return;
                            }

                            let app = tray.app_handle();
                            let visible = match app.get_webview_window(MAIN_WINDOW_LABEL) {
                                Some(w) => match w.is_visible() {
                                    Ok(v) => v,
                                    Err(e) => {
                                        log::error!("tray: failed to check window visibility: {e}");
                                        false
                                    }
                                },
                                None => {
                                    log::warn!("tray: main window not found for visibility check");
                                    false
                                }
                            };
                            if visible {
                                hide_main_window(app);
                            } else {
                                show_main_window(app);
                            }
                        }
                    });
            }

            match tray_builder.build(app) {
                Ok(_tray) => {
                    log::info!("tray: system tray created");
                    // Linux: do not set tray_available — build() can return Ok
                    // even when the icon is invisible (GNOME without AppIndicator
                    // extension). Closing the window must always exit on Linux to
                    // prevent a stuck invisible app. The tray menu (Open/Quit)
                    // still works when the icon is visible.
                    #[cfg(not(target_os = "linux"))]
                    tray_available_setup.store(true, Ordering::Relaxed);

                    // macOS: switch to Accessory activation policy so the app
                    // does not appear in the Dock or Cmd+Tab. The window starts
                    // hidden (tauri.conf.json: visible=false) and is shown on
                    // tray click. Only after tray succeeds — if tray fails,
                    // Dock stays visible.
                    #[cfg(target_os = "macos")]
                    if let Err(e) = app
                        .handle()
                        .set_activation_policy(tauri::ActivationPolicy::Accessory)
                    {
                        log::error!(
                            "tray: failed to set initial activation policy to Accessory: {e}"
                        );
                    }
                }
                Err(e) => {
                    // Tray creation failed. On Linux the safety net above already
                    // showed the window; on other platforms, show it now as fallback.
                    log::error!("tray: failed to create system tray: {e}");
                    log::warn!("tray: falling back to visible window");
                    #[cfg(not(target_os = "linux"))]
                    show_main_window(app.handle());
                }
            }

            // Listen for update_available events (from auto-check) to update tray menu
            let update_version_listener = update_version_setup.clone();
            let app_handle_listener = app.handle().clone();
            use tauri::Listener;
            app.listen(
                "update_available",
                move |event| match serde_json::from_str::<updater::UpdateInfo>(event.payload()) {
                    Ok(info) => {
                        let version = info.version;
                        match update_version_listener.lock() {
                            Ok(mut guard) => *guard = Some(version.clone()),
                            Err(e) => log::warn!("update version mutex poisoned: {e}"),
                        }
                        refresh_tray_menu(&app_handle_listener, &Some(version));
                    }
                    Err(e) => {
                        log::warn!("tray: failed to deserialize update_available payload: {e}");
                    }
                },
            );

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Setup wizard
            check_runtime,
            install_runtime,
            init_vm,
            create_project,
            link_cli,
            // Container lifecycle
            is_setup_complete,
            build_images,
            start_containers,
            check_claude_auth,
            check_containers_running,
            // Settings
            factory_reset,
            get_llm_config,
            update_llm_config,
            // Authentication
            save_api_key,
            delete_api_key,
            get_auth_status,
            // URL opener
            open_url,
            // Platform
            get_platform,
            open_auth_terminal,
            // Chat
            start_chat,
            send_message,
            // Chat history
            list_conversations,
            get_conversation,
            get_project_memory,
            resume_conversation,
            // Project management
            list_projects,
            switch_project,
            // Health
            get_health,
            // Container logs
            get_container_logs,
            get_compose_logs,
            // IDE Bridge
            list_available_ides,
            select_ide,
            get_selected_ide,
            get_bridge_status,
            // Container updates
            update_containers,
            rollback_containers,
            // Update
            check_for_update,
            install_update,
            get_update_settings,
            set_update_settings,
            restart_app,
            // Logging
            set_log_level,
            get_log_level,
            // Diagnostics
            export_diagnostics,
            // Integrations
            get_integrations,
            set_integration_enabled,
            set_os_integration_enabled,
            save_integration_credentials,
            save_redmine_mappings,
            delete_integration_credentials,
            restart_integration_containers,
        ])
        .on_window_event(move |window, event| {
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    if should_prevent_close(
                        window.label(),
                        tray_available_close.load(Ordering::Relaxed),
                    ) {
                        // Tray is available — hide window, app lives in tray.
                        api.prevent_close();
                        hide_main_window(window.app_handle());
                    }
                }
                tauri::WindowEvent::Destroyed => {
                    if !should_run_cleanup(window.label()) {
                        return;
                    }
                    run_exit_cleanup(&ide_bridge_exit, &mcp_os_exit, &auto_check_exit);
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("fatal: Tauri application failed to start");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    // -- URL validation: scheme checks --

    #[test]
    fn validate_url_allows_https() {
        assert!(validate_url("https://example.com").is_ok());
    }

    #[test]
    fn validate_url_allows_http() {
        assert!(validate_url("http://example.com").is_ok());
    }

    #[test]
    fn validate_url_blocks_file_scheme() {
        let err = validate_url("file:///etc/passwd").unwrap_err();
        assert!(err.contains("Blocked URL scheme"));
    }

    #[test]
    fn validate_url_blocks_ssh_scheme() {
        let err = validate_url("ssh://user@host").unwrap_err();
        assert!(err.contains("Blocked URL scheme"));
    }

    #[test]
    fn validate_url_blocks_javascript_scheme() {
        let err = validate_url("javascript:alert(1)").unwrap_err();
        assert!(err.contains("Blocked URL scheme"));
    }

    // -- URL validation: localhost / domain blocking --

    #[test]
    fn validate_url_blocks_localhost() {
        assert!(validate_url("https://localhost/admin")
            .unwrap_err()
            .contains("localhost"));
    }

    #[test]
    fn validate_url_blocks_subdomain_localhost() {
        assert!(validate_url("https://evil.localhost/admin")
            .unwrap_err()
            .contains("localhost"));
    }

    // -- URL validation: IPv4 private ranges --

    #[test]
    fn validate_url_blocks_127_0_0_1() {
        assert!(validate_url("https://127.0.0.1:8080/secret")
            .unwrap_err()
            .contains("private"));
    }

    #[test]
    fn validate_url_blocks_127_255() {
        assert!(validate_url("https://127.255.255.255/")
            .unwrap_err()
            .contains("private"));
    }

    #[test]
    fn validate_url_blocks_10_x() {
        assert!(validate_url("https://10.0.0.1/internal")
            .unwrap_err()
            .contains("private"));
    }

    #[test]
    fn validate_url_blocks_192_168_x() {
        assert!(validate_url("https://192.168.1.1/router")
            .unwrap_err()
            .contains("private"));
    }

    #[test]
    fn validate_url_blocks_172_16_x() {
        assert!(validate_url("https://172.16.0.1/internal")
            .unwrap_err()
            .contains("private"));
    }

    #[test]
    fn validate_url_blocks_172_31_x() {
        assert!(validate_url("https://172.31.255.255/internal")
            .unwrap_err()
            .contains("private"));
    }

    #[test]
    fn validate_url_allows_172_15_x() {
        assert!(validate_url("https://172.15.0.1/ok").is_ok());
    }

    #[test]
    fn validate_url_allows_172_32_x() {
        assert!(validate_url("https://172.32.0.1/ok").is_ok());
    }

    #[test]
    fn validate_url_blocks_169_254_x() {
        assert!(validate_url("https://169.254.169.254/metadata")
            .unwrap_err()
            .contains("private"));
    }

    #[test]
    fn validate_url_blocks_0_0_0_0() {
        assert!(validate_url("https://0.0.0.0/")
            .unwrap_err()
            .contains("private"));
    }

    // -- URL validation: IPv6 blocking --

    #[test]
    fn validate_url_blocks_ipv6_loopback() {
        assert!(validate_url("https://[::1]/secret")
            .unwrap_err()
            .contains("private"));
    }

    #[test]
    fn validate_url_blocks_ipv6_unspecified() {
        assert!(validate_url("https://[::]/secret")
            .unwrap_err()
            .contains("private"));
    }

    #[test]
    fn validate_url_blocks_ipv6_unique_local() {
        assert!(validate_url("https://[fd00::1]/secret")
            .unwrap_err()
            .contains("private"));
    }

    #[test]
    fn validate_url_blocks_ipv6_link_local() {
        assert!(validate_url("https://[fe80::1]/secret")
            .unwrap_err()
            .contains("private"));
    }

    // -- URL validation: IPv6-mapped IPv4 bypass prevention --

    #[test]
    fn validate_url_blocks_ipv6_mapped_loopback() {
        assert!(validate_url("https://[::ffff:127.0.0.1]/secret")
            .unwrap_err()
            .contains("private"));
    }

    #[test]
    fn validate_url_blocks_ipv6_mapped_10_x() {
        assert!(validate_url("https://[::ffff:10.0.0.1]/secret")
            .unwrap_err()
            .contains("private"));
    }

    #[test]
    fn validate_url_blocks_ipv6_mapped_192_168() {
        assert!(validate_url("https://[::ffff:192.168.1.1]/secret")
            .unwrap_err()
            .contains("private"));
    }

    #[test]
    fn validate_url_blocks_ipv6_mapped_169_254() {
        assert!(validate_url("https://[::ffff:169.254.169.254]/secret")
            .unwrap_err()
            .contains("private"));
    }

    // -- URL validation: allowed URLs --

    #[test]
    fn validate_url_allows_public_ip() {
        assert!(validate_url("https://8.8.8.8/").is_ok());
    }

    #[test]
    fn validate_url_allows_public_domain() {
        assert!(validate_url("https://github.com/speedwave").is_ok());
    }

    #[test]
    fn validate_url_allows_public_ipv6() {
        assert!(validate_url("https://[2606:4700::1]/").is_ok());
    }

    // -- URL validation: additional scheme blocking --

    #[test]
    fn validate_url_blocks_ftp_scheme() {
        assert!(validate_url("ftp://evil.com/file")
            .unwrap_err()
            .contains("Blocked URL scheme"));
    }

    #[test]
    fn validate_url_blocks_data_scheme() {
        assert!(validate_url("data:text/html,test")
            .unwrap_err()
            .contains("Blocked URL scheme"));
    }

    // -- is_private_or_reserved: edge cases --

    #[test]
    fn private_reserved_blocks_0_x_range() {
        // 0.x.x.x is "This host on this network" per RFC 1122
        let ip: std::net::IpAddr = "0.1.2.3".parse().unwrap();
        assert!(is_private_or_reserved(ip));
    }

    #[test]
    fn private_reserved_allows_1_0_0_1() {
        let ip: std::net::IpAddr = "1.0.0.1".parse().unwrap();
        assert!(!is_private_or_reserved(ip));
    }

    #[test]
    fn private_reserved_blocks_fc00_unique_local() {
        let ip: std::net::IpAddr = "fc00::1".parse().unwrap();
        assert!(is_private_or_reserved(ip));
    }

    #[test]
    fn private_reserved_blocks_fdff_unique_local() {
        // fdff::1 is also in fc00::/7 range
        let ip: std::net::IpAddr = "fdff::1".parse().unwrap();
        assert!(is_private_or_reserved(ip));
    }

    #[test]
    fn private_reserved_allows_fe00() {
        // fe00:: is NOT in fc00::/7 (that's fc-fd) and NOT in fe80::/10 (that's fe80-febf)
        let ip: std::net::IpAddr = "fe00::1".parse().unwrap();
        assert!(!is_private_or_reserved(ip));
    }

    // -- URL validation: IPv6-mapped IPv4 additional vectors --

    #[test]
    fn validate_url_blocks_ipv6_mapped_0_0_0_0() {
        assert!(validate_url("https://[::ffff:0.0.0.0]/")
            .unwrap_err()
            .contains("private"));
    }

    #[test]
    fn validate_url_blocks_ipv6_mapped_172_16() {
        assert!(validate_url("https://[::ffff:172.16.0.1]/")
            .unwrap_err()
            .contains("private"));
    }

    // -- URL validation: malformed inputs --

    #[test]
    fn validate_url_blocks_empty_string() {
        assert!(validate_url("").is_err());
    }

    #[test]
    fn validate_url_blocks_no_scheme() {
        assert!(validate_url("example.com").is_err());
    }

    #[test]
    fn validate_url_blocks_scheme_only() {
        // "https:" either fails to parse or has no host — either way, must be Err
        assert!(validate_url("https:").is_err());
    }

    // -- RFC 5737 TEST-NET ranges --

    #[test]
    fn validate_url_blocks_rfc5737_test_net_1() {
        assert!(validate_url("https://192.0.2.1/")
            .unwrap_err()
            .contains("private"));
    }

    #[test]
    fn validate_url_blocks_rfc5737_test_net_2() {
        assert!(validate_url("https://198.51.100.1/")
            .unwrap_err()
            .contains("private"));
    }

    #[test]
    fn validate_url_blocks_rfc5737_test_net_3() {
        assert!(validate_url("https://203.0.113.1/")
            .unwrap_err()
            .contains("private"));
    }

    #[test]
    fn validate_url_blocks_rfc2544_benchmarking() {
        assert!(validate_url("https://198.18.0.1/")
            .unwrap_err()
            .contains("private"));
    }

    #[test]
    fn validate_url_blocks_cgnat() {
        assert!(validate_url("https://100.64.0.1/")
            .unwrap_err()
            .contains("private"));
    }

    #[test]
    fn validate_url_blocks_deprecated_site_local_ipv6() {
        assert!(validate_url("https://[fec0::1]/")
            .unwrap_err()
            .contains("private"));
    }

    #[test]
    fn validate_url_blocks_documentation_ipv6() {
        assert!(validate_url("https://[2001:db8::1]/")
            .unwrap_err()
            .contains("private"));
    }

    #[test]
    fn validate_url_allows_real_public_ipv6() {
        // Use a real public IPv6 instead of documentation prefix
        assert!(validate_url("https://[2606:4700::1]/").is_ok());
    }

    #[test]
    fn validate_url_blocks_url_with_credentials() {
        // Private IP should still be blocked even with userinfo
        assert!(validate_url("https://user:pass@127.0.0.1/")
            .unwrap_err()
            .contains("private"));
    }

    // -- RFC 6666 discard prefix --

    #[test]
    fn private_reserved_blocks_rfc6666_discard_prefix() {
        let ip: std::net::IpAddr = "100::1".parse().unwrap();
        assert!(
            is_private_or_reserved(ip),
            "0100::/64 discard prefix should be blocked"
        );
    }

    #[test]
    fn private_reserved_allows_non_discard_0100() {
        // 100::1:0:0:1 has non-zero segments beyond the /64 prefix, but still in 100::/64
        // Actually 100:0:0:0:x:x:x:x is in the prefix. Let's test outside:
        // 100:0:0:1::1 is NOT in 100::/64 because segment[3] != 0
        let ip: std::net::IpAddr = "100:0:0:1::1".parse().unwrap();
        assert!(
            !is_private_or_reserved(ip),
            "100:0:0:1::/64 is outside discard prefix"
        );
    }

    // -- Container name validation (get_container_logs logic) --

    #[test]
    fn container_name_requires_compose_prefix() {
        let prefix = speedwave_runtime::consts::COMPOSE_PREFIX;
        let valid = format!("{}_acme_claude", prefix);
        assert!(valid.starts_with(&format!("{}_", prefix)));

        // Without prefix
        assert!(!"random_container".starts_with(&format!("{}_", prefix)));
    }

    #[test]
    fn container_name_rejects_shell_characters() {
        let name = "speedwave_acme;rm -rf /";
        let has_invalid = !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.');
        assert!(has_invalid, "semicolons should be rejected");
    }

    #[test]
    fn container_name_rejects_path_traversal() {
        let name = "speedwave_../etc/passwd";
        let has_invalid = !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.');
        assert!(has_invalid, "slashes should be rejected");
    }

    // -- URL validation: additional edge cases --

    #[test]
    fn validate_url_blocks_private_ip_with_path() {
        assert!(validate_url("https://10.0.0.1/api/secrets")
            .unwrap_err()
            .contains("private"));
    }

    #[test]
    fn validate_url_blocks_private_ip_with_port() {
        assert!(validate_url("https://192.168.1.1:8443/admin")
            .unwrap_err()
            .contains("private"));
    }

    #[test]
    fn validate_url_allows_high_port_public_ip() {
        assert!(validate_url("https://1.1.1.1:8080/api").is_ok());
    }

    #[test]
    fn validate_url_blocks_decimal_ip_loopback() {
        // The url crate parses decimal integers (e.g. 2130706433 = 0x7F000001) as
        // IPv4 addresses. This must be blocked by is_private_or_reserved.
        let result = validate_url("https://2130706433/");
        assert!(
            result.is_err(),
            "decimal IP 2130706433 (127.0.0.1) must be blocked as loopback"
        );
        assert!(
            result.unwrap_err().contains("private"),
            "error should indicate private/reserved IP"
        );
    }

    // -- set_log_level / get_log_level tests --
    //
    // These functions mutate global state (`log::set_max_level`), so we
    // serialize all log-level tests through a single mutex.

    static LOG_LEVEL_MUTEX: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn set_log_level_accepts_error() {
        let _lock = LOG_LEVEL_MUTEX.lock().unwrap();
        assert!(set_log_level("error".to_string()).is_ok());
    }

    #[test]
    fn set_log_level_accepts_warn() {
        let _lock = LOG_LEVEL_MUTEX.lock().unwrap();
        assert!(set_log_level("warn".to_string()).is_ok());
    }

    #[test]
    fn set_log_level_accepts_info() {
        let _lock = LOG_LEVEL_MUTEX.lock().unwrap();
        assert!(set_log_level("info".to_string()).is_ok());
    }

    #[test]
    fn set_log_level_accepts_debug() {
        let _lock = LOG_LEVEL_MUTEX.lock().unwrap();
        assert!(set_log_level("debug".to_string()).is_ok());
    }

    #[test]
    fn set_log_level_accepts_trace() {
        let _lock = LOG_LEVEL_MUTEX.lock().unwrap();
        assert!(set_log_level("trace".to_string()).is_ok());
    }

    #[test]
    fn set_log_level_case_insensitive_uppercase() {
        let _lock = LOG_LEVEL_MUTEX.lock().unwrap();
        assert!(set_log_level("ERROR".to_string()).is_ok());
    }

    #[test]
    fn set_log_level_case_insensitive_mixed() {
        let _lock = LOG_LEVEL_MUTEX.lock().unwrap();
        assert!(set_log_level("Info".to_string()).is_ok());
    }

    #[test]
    fn set_log_level_case_insensitive_debug_upper() {
        let _lock = LOG_LEVEL_MUTEX.lock().unwrap();
        assert!(set_log_level("DEBUG".to_string()).is_ok());
    }

    #[test]
    fn set_log_level_rejects_invalid() {
        let _lock = LOG_LEVEL_MUTEX.lock().unwrap();
        let err = set_log_level("verbose".to_string()).unwrap_err();
        assert!(
            err.contains("verbose"),
            "error should contain the invalid value"
        );
    }

    #[test]
    fn set_log_level_rejects_empty_string() {
        let _lock = LOG_LEVEL_MUTEX.lock().unwrap();
        assert!(set_log_level(String::new()).is_err());
    }

    #[test]
    fn get_log_level_returns_non_empty() {
        let _lock = LOG_LEVEL_MUTEX.lock().unwrap();
        let level = get_log_level();
        assert!(!level.is_empty(), "log level string should not be empty");
    }

    #[test]
    fn set_then_get_log_level_round_trip() {
        let _lock = LOG_LEVEL_MUTEX.lock().unwrap();
        set_log_level("debug".to_string()).unwrap();
        let level = get_log_level();
        assert_eq!(level, "DEBUG");
    }

    #[test]
    fn set_log_level_off_returns_error() {
        let _lock = LOG_LEVEL_MUTEX.lock().unwrap();
        assert!(
            set_log_level("off".to_string()).is_err(),
            "\"off\" is not a valid log level and should be rejected"
        );
    }

    #[test]
    fn set_log_level_whitespace_padded_returns_error() {
        let _lock = LOG_LEVEL_MUTEX.lock().unwrap();
        assert!(
            set_log_level("  debug  ".to_string()).is_err(),
            "whitespace-padded input should be rejected (no trimming)"
        );
    }

    #[test]
    fn set_log_level_multi_step_round_trip() {
        let _lock = LOG_LEVEL_MUTEX.lock().unwrap();
        set_log_level("trace".to_string()).unwrap();
        set_log_level("error".to_string()).unwrap();
        let level = get_log_level();
        assert_eq!(level, "ERROR");
    }

    // -- cleanup_log_dir tests --

    /// Helper: create a `.log` file inside `dir` with the given name.
    fn create_log_file(dir: &std::path::Path, name: &str) -> std::path::PathBuf {
        let p = dir.join(name);
        std::fs::File::create(&p).unwrap();
        p
    }

    /// Helper: create a `.log` file and set its modification time to a specific
    /// epoch-based timestamp.  Uses `File::set_modified` (stable since Rust 1.75)
    /// instead of `thread::sleep` for deterministic ordering in tests.
    fn create_log_file_with_mtime(
        dir: &std::path::Path,
        name: &str,
        epoch_secs: u64,
    ) -> std::path::PathBuf {
        let p = dir.join(name);
        let f = std::fs::File::create(&p).unwrap();
        let mtime = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(epoch_secs);
        f.set_modified(mtime).unwrap();
        p
    }

    #[test]
    fn cleanup_log_dir_fewer_than_limit_deletes_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        create_log_file(tmp.path(), "a.log");
        create_log_file(tmp.path(), "b.log");

        cleanup_log_dir(tmp.path(), 5);

        let count = std::fs::read_dir(tmp.path()).unwrap().count();
        assert_eq!(count, 2, "no files should be deleted when under the limit");
    }

    #[test]
    fn cleanup_log_dir_exactly_at_limit_deletes_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        for i in 0..3 {
            create_log_file_with_mtime(tmp.path(), &format!("file{i}.log"), 1_000_000 + i * 100);
        }

        cleanup_log_dir(tmp.path(), 3);

        let count = std::fs::read_dir(tmp.path()).unwrap().count();
        assert_eq!(count, 3, "no files should be deleted at exactly the limit");
    }

    #[test]
    fn cleanup_log_dir_over_limit_deletes_oldest() {
        let tmp = tempfile::tempdir().unwrap();
        // Create 6 files with deterministic, well-separated mtimes.
        // file0 is oldest (epoch 1 000 000), file5 is newest (epoch 1 000 500).
        let mut created = Vec::new();
        for i in 0u64..6 {
            let p = create_log_file_with_mtime(
                tmp.path(),
                &format!("file{i}.log"),
                1_000_000 + i * 100,
            );
            created.push(p);
        }

        cleanup_log_dir(tmp.path(), 3);

        // The 3 newest files (file3, file4, file5) must survive.
        for p in &created[3..] {
            assert!(p.exists(), "newest file {} should survive", p.display());
        }
        // The 3 oldest files (file0, file1, file2) must be deleted.
        for p in &created[..3] {
            assert!(!p.exists(), "oldest file {} should be deleted", p.display());
        }

        let remaining_count = std::fs::read_dir(tmp.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .count();
        assert_eq!(
            remaining_count, 3,
            "should keep exactly 3 files, got {remaining_count}"
        );
    }

    #[test]
    fn cleanup_log_dir_ignores_non_log_files() {
        let tmp = tempfile::tempdir().unwrap();
        // 4 .log files (over the limit of 2) plus 3 .txt files
        for i in 0u64..4 {
            create_log_file_with_mtime(tmp.path(), &format!("file{i}.log"), 1_000_000 + i * 100);
        }
        for i in 0..3 {
            let p = tmp.path().join(format!("notes{i}.txt"));
            std::fs::File::create(&p).unwrap();
        }

        cleanup_log_dir(tmp.path(), 2);

        let log_count = std::fs::read_dir(tmp.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.path().extension().map(|x| x == "log").unwrap_or(false))
            .count();
        let txt_count = std::fs::read_dir(tmp.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.path().extension().map(|x| x == "txt").unwrap_or(false))
            .count();

        assert_eq!(log_count, 2, "should keep exactly 2 .log files");
        assert_eq!(txt_count, 3, "all .txt files should remain untouched");
    }

    #[test]
    fn cleanup_log_dir_nonexistent_directory_does_not_panic() {
        let tmp = tempfile::tempdir().unwrap();
        let missing = tmp.path().join("does_not_exist");
        // Should return silently — no panic, no error.
        cleanup_log_dir(&missing, 5);
    }

    #[test]
    fn cleanup_log_dir_max_zero_deletes_all_log_files() {
        let tmp = tempfile::tempdir().unwrap();
        for i in 0..4 {
            create_log_file(tmp.path(), &format!("file{i}.log"));
        }
        // Also add a non-log file that must survive
        let txt = tmp.path().join("keep.txt");
        std::fs::File::create(&txt).unwrap();

        cleanup_log_dir(tmp.path(), 0);

        let log_count = std::fs::read_dir(tmp.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.path().extension().map(|x| x == "log").unwrap_or(false))
            .count();
        assert_eq!(log_count, 0, "max_files=0 should delete all .log files");
        assert!(txt.exists(), ".txt file should not be deleted");
    }

    #[test]
    fn cleanup_log_dir_mixed_extensions_only_counts_log() {
        let tmp = tempfile::tempdir().unwrap();
        // 2 .log files + 5 .txt files — limit is 3, so nothing should be deleted
        // because only .log files are counted and 2 < 3.
        create_log_file(tmp.path(), "a.log");
        create_log_file(tmp.path(), "b.log");
        for i in 0..5 {
            let p = tmp.path().join(format!("data{i}.txt"));
            std::fs::File::create(&p).unwrap();
        }

        cleanup_log_dir(tmp.path(), 3);

        let total = std::fs::read_dir(tmp.path()).unwrap().count();
        assert_eq!(
            total, 7,
            "nothing should be deleted — only 2 .log files exist, under limit of 3"
        );
    }

    #[test]
    fn cleanup_log_dir_empty_directory() {
        let tmp = tempfile::tempdir().unwrap();
        // 0 .log files, max_files=5 — should not panic.
        cleanup_log_dir(tmp.path(), 5);

        let count = std::fs::read_dir(tmp.path()).unwrap().count();
        assert_eq!(count, 0, "empty directory should stay empty");
    }

    #[test]
    fn cleanup_log_dir_ignores_subdirectories() {
        let tmp = tempfile::tempdir().unwrap();
        // Create 2 .log files directly in the directory.
        create_log_file_with_mtime(tmp.path(), "old.log", 1_000_000);
        create_log_file_with_mtime(tmp.path(), "new.log", 2_000_000);

        // Create a subdirectory containing a .log file — cleanup must ignore it.
        let subdir = tmp.path().join("nested");
        std::fs::create_dir(&subdir).unwrap();
        create_log_file(&subdir, "inner.log");

        cleanup_log_dir(tmp.path(), 1);

        // Only "new.log" (newest) should survive at the top level.
        assert!(
            tmp.path().join("new.log").exists(),
            "newest top-level .log should survive"
        );
        assert!(
            !tmp.path().join("old.log").exists(),
            "oldest top-level .log should be deleted"
        );
        // The subdirectory and its .log file must be untouched.
        assert!(subdir.exists(), "subdirectory should not be deleted");
        assert!(
            subdir.join("inner.log").exists(),
            ".log file inside subdirectory should not be deleted"
        );
    }

    // -- Log sanitization tests (get_container_logs / get_compose_logs) --

    #[test]
    fn container_logs_sanitize_bearer_token() {
        let raw = "2024-01-15 INFO  Calling API with Bearer sk-ant-api03-secret123\nDone.";
        let sanitized = speedwave_runtime::log_sanitizer::sanitize(raw);
        assert!(
            !sanitized.contains("sk-ant-api03-secret123"),
            "Bearer token should be redacted in container logs: {sanitized}"
        );
        assert!(
            sanitized.contains("Bearer ***REDACTED***"),
            "Should contain redacted marker: {sanitized}"
        );
        assert!(
            sanitized.contains("Done."),
            "Non-secret content should remain: {sanitized}"
        );
    }

    #[test]
    fn container_logs_sanitize_slack_token() {
        let raw = "mcp-hub | Connecting with token xoxb-1234567890-abcdefghij";
        let sanitized = speedwave_runtime::log_sanitizer::sanitize(raw);
        assert!(
            !sanitized.contains("xoxb-1234567890-abcdefghij"),
            "Slack token should be redacted in container logs: {sanitized}"
        );
        assert!(
            sanitized.contains("***REDACTED_SLACK_TOKEN***"),
            "Should contain Slack redacted marker: {sanitized}"
        );
    }

    #[test]
    fn container_logs_sanitize_api_key_assignment() {
        let raw = "Config loaded: api_key=sk-proj-abc123def456 endpoint=https://api.example.com";
        let sanitized = speedwave_runtime::log_sanitizer::sanitize(raw);
        assert!(
            !sanitized.contains("sk-proj-abc123def456"),
            "API key should be redacted in container logs: {sanitized}"
        );
        assert!(
            sanitized.contains("api_key=***REDACTED***"),
            "Should contain redacted api_key: {sanitized}"
        );
        assert!(
            sanitized.contains("https://api.example.com"),
            "Non-secret content should remain: {sanitized}"
        );
    }

    #[test]
    fn compose_logs_sanitize_bearer_token() {
        let raw = concat!(
            "claude_1  | Starting session\n",
            "mcp_hub_1 | Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig123\n",
            "mcp_hub_1 | Ready\n"
        );
        let sanitized = speedwave_runtime::log_sanitizer::sanitize(raw);
        assert!(
            !sanitized.contains("eyJhbGciOiJIUzI1NiJ9"),
            "JWT in compose logs should be redacted: {sanitized}"
        );
        assert!(
            sanitized.contains("Starting session"),
            "Non-secret lines should remain: {sanitized}"
        );
        assert!(
            sanitized.contains("Ready"),
            "Non-secret lines should remain: {sanitized}"
        );
    }

    #[test]
    fn compose_logs_sanitize_multiple_secrets() {
        let raw = concat!(
            "hub | password=hunter2 connecting\n",
            "hub | using token xoxb-slack-secret-token\n",
            "hub | Bearer my-bearer-token in header\n",
        );
        let sanitized = speedwave_runtime::log_sanitizer::sanitize(raw);
        assert!(
            !sanitized.contains("hunter2"),
            "Password should be redacted: {sanitized}"
        );
        assert!(
            !sanitized.contains("xoxb-slack-secret-token"),
            "Slack token should be redacted: {sanitized}"
        );
        assert!(
            !sanitized.contains("my-bearer-token"),
            "Bearer token should be redacted: {sanitized}"
        );
    }

    #[test]
    fn container_logs_sanitize_plain_text_unchanged() {
        let raw = "2024-01-15 INFO  Container started successfully on port 4000\nHealthcheck OK";
        let sanitized = speedwave_runtime::log_sanitizer::sanitize(raw);
        assert_eq!(
            sanitized, raw,
            "Plain log lines without secrets should pass through unchanged"
        );
    }

    // -- export_diagnostics tests --

    #[test]
    fn export_diagnostics_rejects_invalid_project_name() {
        let result = check_project("../escape");
        assert!(result.is_err(), "path traversal should be rejected");
    }

    #[test]
    fn export_diagnostics_rejects_empty_project_name() {
        let result = check_project("");
        assert!(result.is_err(), "empty project name should be rejected");
    }

    // -- build_diagnostics_zip tests --

    /// Helper: read a ZIP entry as a UTF-8 string.
    fn read_zip_entry(zip_path: &std::path::Path, entry_name: &str) -> Option<String> {
        let file = std::fs::File::open(zip_path).ok()?;
        let mut archive = zip::ZipArchive::new(file).ok()?;
        let mut entry = archive.by_name(entry_name).ok()?;
        let mut buf = String::new();
        std::io::Read::read_to_string(&mut entry, &mut buf).ok()?;
        Some(buf)
    }

    /// Helper: list all entry names in a ZIP.
    fn zip_entry_names(zip_path: &std::path::Path) -> Vec<String> {
        let file = std::fs::File::open(zip_path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        (0..archive.len())
            .map(|i| archive.by_index(i).unwrap().name().to_string())
            .collect()
    }

    #[test]
    fn diagnostics_zip_contains_expected_entries() {
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("diag.zip");

        // Create a fake log directory with one log file
        let log_dir = tmp.path().join("logs");
        std::fs::create_dir_all(&log_dir).unwrap();
        std::fs::write(log_dir.join("app.log"), "INFO started").unwrap();
        // Non-.log file should be ignored
        std::fs::write(log_dir.join("app.txt"), "ignored").unwrap();

        // Create a fake compose.yml
        let compose_path = tmp.path().join("compose.yml");
        std::fs::write(
            &compose_path,
            "version: '3'\nservices:\n  claude:\n    image: test\n",
        )
        .unwrap();

        let input = DiagnosticsInput {
            log_dir: Some(log_dir),
            serial_log: None,
            container_logs: Some("container output here".into()),
            compose_path: Some(compose_path),
        };

        build_diagnostics_zip(&zip_path, &input).unwrap();

        let names = zip_entry_names(&zip_path);
        assert!(
            names.contains(&"logs/app.log".to_string()),
            "ZIP should contain app log: {names:?}"
        );
        assert!(
            !names.iter().any(|n| n.contains("app.txt")),
            "ZIP should not contain non-.log files: {names:?}"
        );
        assert!(
            names.contains(&"containers/compose.log".to_string()),
            "ZIP should contain container logs: {names:?}"
        );
        assert!(
            names.contains(&"containers/compose.yml".to_string()),
            "ZIP should contain compose.yml: {names:?}"
        );
        assert!(
            names.contains(&"system-info.txt".to_string()),
            "ZIP should contain system info: {names:?}"
        );

        // Verify system-info.txt has expected fields
        let sys_info = read_zip_entry(&zip_path, "system-info.txt").unwrap();
        assert!(sys_info.contains("os:"), "system info should contain OS");
        assert!(
            sys_info.contains("arch:"),
            "system info should contain arch"
        );
        assert!(
            sys_info.contains("version:"),
            "system info should contain version"
        );
    }

    #[test]
    fn diagnostics_zip_redacts_secrets_in_logs() {
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("diag-redact.zip");

        let log_dir = tmp.path().join("logs");
        std::fs::create_dir_all(&log_dir).unwrap();
        std::fs::write(
            log_dir.join("app.log"),
            "Auth: Bearer sk-ant-super-secret-key-12345\nSlack token: xoxb-slack-secret-token\n",
        )
        .unwrap();

        let input = DiagnosticsInput {
            log_dir: Some(log_dir),
            serial_log: None,
            container_logs: Some(
                "JWT: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123\n".into(),
            ),
            compose_path: None,
        };

        build_diagnostics_zip(&zip_path, &input).unwrap();

        let log_content = read_zip_entry(&zip_path, "logs/app.log").unwrap();
        assert!(
            !log_content.contains("sk-ant-super-secret-key-12345"),
            "Bearer token should be redacted in log: {log_content}"
        );
        assert!(
            !log_content.contains("xoxb-slack-secret-token"),
            "Slack token should be redacted in log: {log_content}"
        );
        assert!(
            log_content.contains("***REDACTED***"),
            "Redacted marker should be present: {log_content}"
        );

        let container_content = read_zip_entry(&zip_path, "containers/compose.log").unwrap();
        assert!(
            !container_content.contains("eyJhbGciOiJIUzI1NiJ9"),
            "JWT should be redacted in container logs: {container_content}"
        );
    }

    #[test]
    fn diagnostics_zip_redacts_secrets_in_compose_yml() {
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("diag-compose.zip");

        let compose_path = tmp.path().join("compose.yml");
        std::fs::write(
            &compose_path,
            "environment:\n  - API_KEY=password=hunter2\n  - SLACK_TOKEN=xoxp-slack-token\n",
        )
        .unwrap();

        let input = DiagnosticsInput {
            log_dir: None,
            serial_log: None,
            container_logs: None,
            compose_path: Some(compose_path),
        };

        build_diagnostics_zip(&zip_path, &input).unwrap();

        let content = read_zip_entry(&zip_path, "containers/compose.yml").unwrap();
        assert!(
            !content.contains("hunter2"),
            "Password value should be redacted in compose.yml: {content}"
        );
        assert!(
            !content.contains("xoxp-slack-token"),
            "Slack token should be redacted in compose.yml: {content}"
        );
    }

    #[test]
    fn diagnostics_zip_never_includes_tokens_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("diag-tokens.zip");

        // Create a fake log dir with a tokens/ subdirectory
        let log_dir = tmp.path().join("logs");
        std::fs::create_dir_all(&log_dir).unwrap();
        std::fs::write(log_dir.join("app.log"), "normal log").unwrap();
        // tokens/ dir alongside logs — should never appear
        let tokens_dir = tmp.path().join("tokens");
        std::fs::create_dir_all(tokens_dir.join("slack")).unwrap();
        std::fs::write(
            tokens_dir.join("slack/token.json"),
            r#"{"token":"xoxb-real-secret"}"#,
        )
        .unwrap();

        let input = DiagnosticsInput {
            log_dir: Some(log_dir),
            serial_log: None,
            container_logs: None,
            compose_path: None,
        };

        build_diagnostics_zip(&zip_path, &input).unwrap();

        let names = zip_entry_names(&zip_path);
        assert!(
            !names.iter().any(|n| n.contains("token")),
            "ZIP must never contain tokens directory entries: {names:?}"
        );
    }

    #[test]
    fn diagnostics_zip_redacts_serial_log() {
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("diag-serial.zip");

        let serial_log = tmp.path().join("serial.log");
        std::fs::write(
            &serial_log,
            "kernel boot\nAuthorization: Bearer leaked-token-here\nboot complete\n",
        )
        .unwrap();

        let input = DiagnosticsInput {
            log_dir: None,
            serial_log: Some(serial_log),
            container_logs: None,
            compose_path: None,
        };

        build_diagnostics_zip(&zip_path, &input).unwrap();

        let content = read_zip_entry(&zip_path, "lima/serial.log").unwrap();
        assert!(
            !content.contains("leaked-token-here"),
            "Bearer token should be redacted in serial log: {content}"
        );
        assert!(
            content.contains("kernel boot"),
            "Non-secret content should be preserved: {content}"
        );
    }

    #[test]
    fn diagnostics_zip_handles_empty_inputs() {
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("diag-empty.zip");

        let input = DiagnosticsInput {
            log_dir: None,
            serial_log: None,
            container_logs: None,
            compose_path: None,
        };

        build_diagnostics_zip(&zip_path, &input).unwrap();

        let names = zip_entry_names(&zip_path);
        assert_eq!(
            names,
            vec!["system-info.txt"],
            "Empty-input ZIP should only contain system-info.txt"
        );
    }

    // -- Tray click debounce --

    #[test]
    fn debounce_suppresses_click_within_threshold() {
        assert!(should_debounce(1000, 1200, 500));
    }

    #[test]
    fn debounce_allows_click_after_threshold() {
        assert!(!should_debounce(1000, 1501, 500));
    }

    #[test]
    fn debounce_allows_click_at_exact_threshold() {
        // At exactly 500ms elapsed, the click should go through
        // (condition is strict less-than).
        assert!(!should_debounce(1000, 1500, 500));
    }

    #[test]
    fn debounce_suppresses_when_clock_goes_backward() {
        // Clock jumped backward: now < prev. saturating_sub returns 0,
        // which is < threshold → suppressed. This is the safe behavior.
        assert!(should_debounce(5000, 3000, 500));
    }

    #[test]
    fn debounce_allows_first_click_ever() {
        // prev=0 (initial AtomicU64 value), now is any reasonable time.
        // Elapsed time is huge → not debounced.
        assert!(!should_debounce(0, 1_700_000_000_000, 500));
    }

    #[test]
    fn debounce_suppresses_zero_elapsed() {
        // Same timestamp (simultaneous events).
        assert!(should_debounce(1000, 1000, 500));
    }

    #[test]
    fn debounce_allows_with_zero_threshold() {
        // Zero threshold means "never debounce" (0 < 0 is false).
        assert!(!should_debounce(1000, 1000, 0));
    }

    #[test]
    fn debounce_handles_u64_max_prev() {
        // prev is u64::MAX, now is small (extreme backward jump).
        // saturating_sub(u64::MAX) = 0 → suppressed.
        assert!(should_debounce(u64::MAX, 1000, 500));
    }

    #[test]
    fn debounce_handles_u64_max_now() {
        // now is u64::MAX, prev is 0 → huge elapsed → allowed.
        assert!(!should_debounce(0, u64::MAX, 500));
    }

    // -- CloseRequested branching --

    #[test]
    fn prevent_close_main_window_with_tray() {
        assert!(should_prevent_close(MAIN_WINDOW_LABEL, true));
    }

    #[test]
    fn allow_close_main_window_without_tray() {
        assert!(!should_prevent_close(MAIN_WINDOW_LABEL, false));
    }

    #[test]
    fn allow_close_non_main_window_with_tray() {
        assert!(!should_prevent_close("dialog", true));
    }

    #[test]
    fn allow_close_non_main_window_without_tray() {
        assert!(!should_prevent_close("dialog", false));
    }

    #[test]
    fn allow_close_empty_label() {
        assert!(!should_prevent_close("", true));
    }

    // -- Destroyed cleanup guard --

    #[test]
    fn cleanup_runs_for_main_window() {
        assert!(should_run_cleanup(MAIN_WINDOW_LABEL));
    }

    #[test]
    fn cleanup_skips_for_dialog_window() {
        assert!(!should_run_cleanup("dialog"));
    }

    #[test]
    fn cleanup_skips_for_empty_label() {
        assert!(!should_run_cleanup(""));
    }

    #[test]
    fn cleanup_skips_for_similar_label() {
        // "main2" or "main-dialog" should not trigger cleanup.
        assert!(!should_run_cleanup("main2"));
        assert!(!should_run_cleanup("main-dialog"));
    }

    // -- validate_cli_path tests --

    #[test]
    fn validate_cli_path_returns_error_when_binary_missing() {
        // validate_cli_path delegates to setup_wizard::cli_install_path() for
        // the platform-specific path. Since this test runs in a clean CI
        // environment (or dev machine without a full install), the binary is
        // very unlikely to exist — but if it does, the test still passes.
        let result = validate_cli_path();
        match result {
            Ok(path) => assert!(path.exists(), "returned path should exist"),
            Err(msg) => assert!(
                msg.contains("not found"),
                "error should mention 'not found': {msg}"
            ),
        }
    }

    // -- Credential allowlist / path traversal tests --

    #[test]
    fn get_allowed_fields_returns_fields_for_known_services() {
        assert!(get_allowed_fields("slack").is_some());
        assert!(get_allowed_fields("sharepoint").is_some());
        assert!(get_allowed_fields("redmine").is_some());
        assert!(get_allowed_fields("gitlab").is_some());
    }

    #[test]
    fn get_allowed_fields_returns_none_for_unknown_service() {
        assert!(get_allowed_fields("unknown").is_none());
        assert!(get_allowed_fields("").is_none());
        assert!(get_allowed_fields("os").is_none());
    }

    #[test]
    fn allowed_fields_match_auth_fields() {
        for &(service, allowed) in ALLOWED_CREDENTIAL_FILES {
            let auth_fields = get_auth_fields(service);
            for field in &auth_fields {
                // config.json is a virtual file for redmine, not an auth field
                if field.key == "config.json" {
                    continue;
                }
                assert!(
                    allowed.contains(&field.key.as_str()),
                    "auth field '{}' for service '{}' not in ALLOWED_CREDENTIAL_FILES",
                    field.key,
                    service
                );
            }
        }
    }

    #[test]
    fn credential_field_rejects_forward_slash() {
        let key = "../../etc/passwd";
        assert!(
            key.contains('/') || key.contains('\\') || key.contains(".."),
            "path traversal must be detected"
        );
    }

    #[test]
    fn credential_field_rejects_backslash() {
        let key = "..\\windows\\system32";
        assert!(
            key.contains('/') || key.contains('\\') || key.contains(".."),
            "backslash path traversal must be detected"
        );
    }

    #[test]
    fn credential_field_rejects_dot_dot() {
        let key = "..token";
        assert!(key.contains(".."), "double dot must be detected");
    }

    #[test]
    fn credential_field_allows_valid_names() {
        for name in &["bot_token", "api_key", "host_url", "config.json"] {
            assert!(
                !name.contains('/') && !name.contains('\\') && !name.contains(".."),
                "valid field '{}' should pass validation",
                name
            );
        }
    }

    #[test]
    fn credential_value_length_limit() {
        let max_len = 4096;
        let short_value = "a".repeat(max_len);
        assert!(short_value.len() <= max_len, "exactly at limit should pass");

        let long_value = "a".repeat(max_len + 1);
        assert!(long_value.len() > max_len, "over limit should fail");
    }

    #[test]
    fn secret_fields_list_covers_sensitive_keys() {
        assert!(SECRET_FIELDS.contains(&"bot_token"));
        assert!(SECRET_FIELDS.contains(&"api_key"));
        assert!(SECRET_FIELDS.contains(&"token"));
        assert!(SECRET_FIELDS.contains(&"access_token"));
        assert!(SECRET_FIELDS.contains(&"refresh_token"));
    }

    #[test]
    fn secret_fields_excludes_non_secret_keys() {
        assert!(!SECRET_FIELDS.contains(&"host_url"));
        assert!(!SECRET_FIELDS.contains(&"project_id"));
        assert!(!SECRET_FIELDS.contains(&"base_path"));
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

    // -- get_integrations service list alignment --

    #[test]
    fn toggleable_services_match_allowed_credentials() {
        for svc in speedwave_runtime::consts::TOGGLEABLE_MCP_SERVICES {
            assert!(
                get_allowed_fields(svc.config_key).is_some(),
                "TOGGLEABLE service '{}' has no ALLOWED_CREDENTIAL_FILES entry",
                svc.config_key
            );
        }
    }

    #[test]
    fn toggleable_services_have_auth_fields() {
        for svc in speedwave_runtime::consts::TOGGLEABLE_MCP_SERVICES {
            let fields = get_auth_fields(svc.config_key);
            assert!(
                !fields.is_empty(),
                "TOGGLEABLE service '{}' has no auth_fields defined",
                svc.config_key
            );
        }
    }

    // -- resolve_resources_dir --

    #[cfg(target_os = "macos")]
    mod resolve_resources_dir_tests {
        use super::super::resolve_resources_dir;
        use tempfile::TempDir;

        /// Helper: create a marker subdirectory so the resource probe succeeds.
        fn mark_as_resources(dir: &std::path::Path) {
            std::fs::create_dir_all(dir.join("cli")).unwrap();
        }

        #[test]
        fn macos_app_bundle_resolves_resources() {
            let tmp = TempDir::new().unwrap();
            let exe_parent = tmp.path().join("Contents").join("MacOS");
            let resources = tmp.path().join("Contents").join("Resources");
            std::fs::create_dir_all(&exe_parent).unwrap();
            std::fs::create_dir_all(&resources).unwrap();
            mark_as_resources(&resources);

            let result = resolve_resources_dir(&exe_parent);
            assert_eq!(result, Some(resources));
        }

        #[test]
        fn macos_returns_none_when_resources_dir_empty() {
            let tmp = TempDir::new().unwrap();
            let exe_parent = tmp.path().join("Contents").join("MacOS");
            let resources = tmp.path().join("Contents").join("Resources");
            std::fs::create_dir_all(&exe_parent).unwrap();
            std::fs::create_dir_all(&resources).unwrap();
            // Resources dir exists but has no marker → should return None

            assert_eq!(resolve_resources_dir(&exe_parent), None);
        }

        #[test]
        fn macos_dev_mode_returns_none() {
            let tmp = TempDir::new().unwrap();
            let exe_parent = tmp.path().join("target").join("debug");
            std::fs::create_dir_all(&exe_parent).unwrap();

            assert_eq!(resolve_resources_dir(&exe_parent), None);
        }
    }

    #[cfg(target_os = "linux")]
    mod resolve_resources_dir_tests {
        use super::super::resolve_resources_dir;
        use tempfile::TempDir;

        fn mark_as_resources(dir: &std::path::Path) {
            std::fs::create_dir_all(dir.join("cli")).unwrap();
        }

        #[test]
        fn linux_deb_layout_resolves_lib_speedwave() {
            let tmp = TempDir::new().unwrap();
            let exe_parent = tmp.path().join("usr").join("bin");
            let lib_dir = tmp.path().join("usr").join("lib").join("Speedwave");
            std::fs::create_dir_all(&exe_parent).unwrap();
            std::fs::create_dir_all(&lib_dir).unwrap();
            mark_as_resources(&lib_dir);

            let result = resolve_resources_dir(&exe_parent);
            assert_eq!(result, Some(lib_dir));
        }

        #[test]
        fn linux_dev_mode_returns_none() {
            let tmp = TempDir::new().unwrap();
            let exe_parent = tmp.path().join("target").join("debug");
            std::fs::create_dir_all(&exe_parent).unwrap();

            assert_eq!(resolve_resources_dir(&exe_parent), None);
        }

        #[test]
        fn linux_fallback_to_resources_subdir() {
            let tmp = TempDir::new().unwrap();
            let exe_parent = tmp.path().join("target").join("debug");
            let resources = exe_parent.join("resources");
            std::fs::create_dir_all(&resources).unwrap();
            mark_as_resources(&resources);

            let result = resolve_resources_dir(&exe_parent);
            assert_eq!(result, Some(resources));
        }

        #[test]
        fn linux_returns_none_when_lib_dir_empty() {
            let tmp = TempDir::new().unwrap();
            let exe_parent = tmp.path().join("usr").join("bin");
            let lib_dir = tmp.path().join("usr").join("lib").join("Speedwave");
            std::fs::create_dir_all(&exe_parent).unwrap();
            std::fs::create_dir_all(&lib_dir).unwrap();
            // lib dir exists but has no marker → should return None

            assert_eq!(resolve_resources_dir(&exe_parent), None);
        }

        #[test]
        fn linux_lib_speedwave_takes_priority_over_resources() {
            let tmp = TempDir::new().unwrap();
            let exe_parent = tmp.path().join("usr").join("bin");
            let lib_dir = tmp.path().join("usr").join("lib").join("Speedwave");
            let resources = exe_parent.join("resources");
            std::fs::create_dir_all(&exe_parent).unwrap();
            std::fs::create_dir_all(&lib_dir).unwrap();
            std::fs::create_dir_all(&resources).unwrap();
            mark_as_resources(&lib_dir);
            mark_as_resources(&resources);

            let result = resolve_resources_dir(&exe_parent);
            assert_eq!(result, Some(lib_dir));
        }
    }

    #[cfg(target_os = "windows")]
    mod resolve_resources_dir_tests {
        use super::super::resolve_resources_dir;
        use tempfile::TempDir;

        fn mark_as_resources(dir: &std::path::Path) {
            let cli_dir = dir.join("cli");
            std::fs::create_dir_all(&cli_dir).unwrap();
            std::fs::write(cli_dir.join("speedwave.exe"), b"fake-cli").unwrap();
        }

        #[test]
        fn windows_nsis_resolves_exe_parent_when_resources_alongside() {
            // NSIS installs resources (cli/, mcp-os/, wsl/) directly alongside
            // the .exe — there is no `resources/` subdirectory.
            let tmp = TempDir::new().unwrap();
            let exe_parent = tmp.path().to_path_buf();
            mark_as_resources(&exe_parent);

            let result = resolve_resources_dir(&exe_parent);
            assert_eq!(result, Some(exe_parent));
        }

        #[test]
        fn windows_fallback_to_resources_subdir() {
            // Some layouts may use a resources/ subdirectory (e.g., dev builds).
            let tmp = TempDir::new().unwrap();
            let exe_parent = tmp.path().to_path_buf();
            let resources = exe_parent.join("resources");
            std::fs::create_dir_all(&resources).unwrap();
            mark_as_resources(&resources);

            let result = resolve_resources_dir(&exe_parent);
            // exe_parent itself has no marker, so resources/ should win
            assert_eq!(result, Some(resources));
        }

        #[test]
        fn windows_exe_parent_takes_priority_over_resources_subdir() {
            // When both exe_parent and exe_parent/resources have markers,
            // exe_parent (NSIS layout) wins because it is checked first.
            let tmp = TempDir::new().unwrap();
            let exe_parent = tmp.path().to_path_buf();
            let resources = exe_parent.join("resources");
            std::fs::create_dir_all(&resources).unwrap();
            mark_as_resources(&exe_parent);
            mark_as_resources(&resources);

            let result = resolve_resources_dir(&exe_parent);
            assert_eq!(result, Some(exe_parent));
        }

        #[test]
        fn windows_returns_none_when_no_markers() {
            // Empty directory — neither exe_parent nor resources/ has bundled assets.
            let tmp = TempDir::new().unwrap();
            let exe_parent = tmp.path().to_path_buf();
            // exe_parent exists but has no cli/, mcp-os/, or build-context/

            assert_eq!(resolve_resources_dir(&exe_parent), None);
        }

        #[test]
        fn windows_dev_mode_returns_none() {
            let tmp = TempDir::new().unwrap();
            let exe_parent = tmp.path().join("target").join("debug");
            std::fs::create_dir_all(&exe_parent).unwrap();

            assert_eq!(resolve_resources_dir(&exe_parent), None);
        }

        #[test]
        fn windows_detects_mcp_os_marker() {
            let tmp = TempDir::new().unwrap();
            let exe_parent = tmp.path().to_path_buf();
            std::fs::create_dir_all(exe_parent.join("mcp-os")).unwrap();

            let result = resolve_resources_dir(&exe_parent);
            assert_eq!(result, Some(exe_parent));
        }

        #[test]
        fn windows_detects_build_context_marker() {
            let tmp = TempDir::new().unwrap();
            let exe_parent = tmp.path().to_path_buf();
            std::fs::create_dir_all(exe_parent.join("build-context")).unwrap();

            let result = resolve_resources_dir(&exe_parent);
            assert_eq!(result, Some(exe_parent));
        }
    }

    #[test]
    fn get_platform_returns_known_value() {
        let platform = get_platform();
        assert!(
            ["macos", "linux", "windows"].contains(&platform.as_str()),
            "get_platform() returned unexpected value: {platform}"
        );
    }
}
