// Container lifecycle and setup wizard Tauri commands.
//
// Extracted from main.rs — thin #[tauri::command] wrappers that delegate to
// `setup_wizard` and `speedwave_runtime` functions, converting errors to
// `Result<T, String>` for Tauri's serialization boundary.

use speedwave_runtime::config;

use crate::setup_wizard;
use crate::types::{check_project, LlmConfigResponse};
use crate::CONFIG_LOCK;

// ---------------------------------------------------------------------------
// Setup wizard commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn check_runtime() -> Result<String, String> {
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
pub async fn install_runtime() -> Result<(), String> {
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
pub async fn init_vm() -> Result<(), String> {
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
pub async fn create_project(name: String, dir: String) -> Result<(), String> {
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
pub async fn link_cli() -> Result<(), String> {
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
pub async fn is_setup_complete() -> Result<bool, String> {
    Ok(setup_wizard::is_setup_complete())
}

#[tauri::command]
pub async fn build_images() -> Result<(), String> {
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
pub async fn start_containers(project: String) -> Result<(), String> {
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
pub async fn check_claude_auth(project: String) -> Result<bool, String> {
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
pub async fn check_containers_running(project: String) -> Result<bool, String> {
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
pub async fn factory_reset() -> Result<(), String> {
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
pub fn get_llm_config() -> Result<LlmConfigResponse, String> {
    let user_config = config::load_user_config().map_err(|e| e.to_string())?;
    let active = user_config.active_project.as_deref().unwrap_or("");
    let llm = user_config
        .find_project(active)
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
pub fn update_llm_config(
    provider: Option<String>,
    model: Option<String>,
    base_url: Option<String>,
    api_key_env: Option<String>,
) -> Result<(), String> {
    let _lock = CONFIG_LOCK.lock().map_err(|e| e.to_string())?;
    let mut user_config = config::load_user_config().map_err(|e| e.to_string())?;
    let active = user_config.active_project.clone().unwrap_or_default();
    let project = user_config
        .find_project_mut(&active)
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
