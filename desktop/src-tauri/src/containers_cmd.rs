// Container lifecycle and setup wizard Tauri commands.
//
// Extracted from main.rs — thin #[tauri::command] wrappers that delegate to
// `setup_wizard` and `speedwave_runtime` functions, converting errors to
// `Result<T, String>` for Tauri's serialization boundary.

use speedwave_runtime::config;

use crate::setup_wizard;
use crate::types::{check_project, LlmConfigResponse};

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

/// Adds a new project and activates it.  Emits `project_switched` so that
/// Settings, Integrations and other listeners refresh automatically.
#[tauri::command]
pub async fn add_project(name: String, dir: String, app: tauri::AppHandle) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        log::info!("add_project: name={name}, dir={dir}");
        speedwave_runtime::project::add_project(&name, &dir).map_err(|e| {
            log::error!("add_project: error: {e}");
            e.to_string()
        })?;
        use tauri::Emitter;
        let _ = app.emit("project_switched", &name);
        Ok(())
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
    let llm = user_config
        .active_project_entry()
        .and_then(|p| p.claude.as_ref())
        .and_then(|c| c.llm.as_ref());
    Ok(LlmConfigResponse {
        provider: llm.and_then(|l| l.provider.clone()),
        model: llm.and_then(|l| l.model.clone()),
        base_url: llm.and_then(|l| l.base_url.clone()),
        api_key_env: llm.and_then(|l| l.api_key_env.clone()),
    })
}

/// Applies LLM config to the active project in-memory. Extracted for testability.
fn apply_llm_config(
    user_config: &mut config::SpeedwaveUserConfig,
    provider: Option<String>,
    model: Option<String>,
    base_url: Option<String>,
    api_key_env: Option<String>,
) -> anyhow::Result<()> {
    let active = user_config
        .active_project
        .clone()
        .ok_or_else(|| anyhow::anyhow!("No active project"))?;
    let project = user_config
        .find_project_mut(&active)
        .ok_or_else(|| anyhow::anyhow!("Project '{}' not found in config", active))?;

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
    Ok(())
}

#[tauri::command]
pub fn update_llm_config(
    provider: Option<String>,
    model: Option<String>,
    base_url: Option<String>,
    api_key_env: Option<String>,
) -> Result<(), String> {
    config::with_config_lock(|| {
        let mut user_config = config::load_user_config()?;
        apply_llm_config(&mut user_config, provider, model, base_url, api_key_env)?;
        config::save_user_config(&user_config)
    })
    .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use config::{ClaudeOverrides, LlmConfig, ProjectUserEntry, SpeedwaveUserConfig};

    fn make_config_with_active_project() -> SpeedwaveUserConfig {
        SpeedwaveUserConfig {
            projects: vec![
                ProjectUserEntry {
                    name: "alpha".to_string(),
                    dir: "/tmp/alpha".to_string(),
                    claude: None,
                    integrations: None,
                },
                ProjectUserEntry {
                    name: "beta".to_string(),
                    dir: "/tmp/beta".to_string(),
                    claude: Some(ClaudeOverrides {
                        env: None,
                        settings: None,
                        llm: Some(LlmConfig {
                            provider: Some("anthropic".to_string()),
                            model: Some("claude-sonnet-4-6".to_string()),
                            base_url: None,
                            api_key_env: None,
                        }),
                    }),
                    integrations: None,
                },
            ],
            active_project: Some("alpha".to_string()),
            selected_ide: None,
            log_level: None,
        }
    }

    // -- apply_llm_config tests --

    #[test]
    fn apply_llm_config_happy_path_no_existing_claude() {
        let mut cfg = make_config_with_active_project();
        // alpha has no claude config yet
        assert!(cfg.find_project("alpha").unwrap().claude.is_none());

        let result = apply_llm_config(
            &mut cfg,
            Some("openai".to_string()),
            Some("gpt-4o".to_string()),
            Some("http://localhost:8080".to_string()),
            Some("OPENAI_KEY".to_string()),
        );
        assert!(result.is_ok());

        let project = cfg.find_project("alpha").unwrap();
        let llm = project.claude.as_ref().unwrap().llm.as_ref().unwrap();
        assert_eq!(llm.provider.as_deref(), Some("openai"));
        assert_eq!(llm.model.as_deref(), Some("gpt-4o"));
        assert_eq!(llm.base_url.as_deref(), Some("http://localhost:8080"));
        assert_eq!(llm.api_key_env.as_deref(), Some("OPENAI_KEY"));
    }

    #[test]
    fn apply_llm_config_happy_path_existing_claude_overrides() {
        let mut cfg = make_config_with_active_project();
        cfg.active_project = Some("beta".to_string());
        // beta already has claude.llm set

        let result = apply_llm_config(
            &mut cfg,
            Some("ollama".to_string()),
            Some("llama3.3".to_string()),
            None,
            None,
        );
        assert!(result.is_ok());

        let project = cfg.find_project("beta").unwrap();
        let llm = project.claude.as_ref().unwrap().llm.as_ref().unwrap();
        assert_eq!(llm.provider.as_deref(), Some("ollama"));
        assert_eq!(llm.model.as_deref(), Some("llama3.3"));
        assert_eq!(llm.base_url, None);
        assert_eq!(llm.api_key_env, None);
    }

    #[test]
    fn apply_llm_config_all_none_clears_fields() {
        let mut cfg = make_config_with_active_project();
        cfg.active_project = Some("beta".to_string());

        let result = apply_llm_config(&mut cfg, None, None, None, None);
        assert!(result.is_ok());

        let project = cfg.find_project("beta").unwrap();
        let llm = project.claude.as_ref().unwrap().llm.as_ref().unwrap();
        assert!(llm.provider.is_none());
        assert!(llm.model.is_none());
        assert!(llm.base_url.is_none());
        assert!(llm.api_key_env.is_none());
    }

    #[test]
    fn apply_llm_config_error_no_active_project() {
        let mut cfg = SpeedwaveUserConfig {
            projects: vec![ProjectUserEntry {
                name: "alpha".to_string(),
                dir: "/tmp/alpha".to_string(),
                claude: None,
                integrations: None,
            }],
            active_project: None,
            selected_ide: None,
            log_level: None,
        };

        let result = apply_llm_config(&mut cfg, Some("openai".to_string()), None, None, None);
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(
            err.contains("No active project"),
            "expected 'No active project' error, got: {err}"
        );
    }

    #[test]
    fn apply_llm_config_error_active_project_not_in_list() {
        let mut cfg = SpeedwaveUserConfig {
            projects: vec![ProjectUserEntry {
                name: "alpha".to_string(),
                dir: "/tmp/alpha".to_string(),
                claude: None,
                integrations: None,
            }],
            active_project: Some("nonexistent".to_string()),
            selected_ide: None,
            log_level: None,
        };

        let result = apply_llm_config(&mut cfg, Some("openai".to_string()), None, None, None);
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(
            err.contains("not found in config"),
            "expected 'not found in config' error, got: {err}"
        );
    }

    #[test]
    fn apply_llm_config_preserves_existing_env_and_settings() {
        let mut cfg = SpeedwaveUserConfig {
            projects: vec![ProjectUserEntry {
                name: "proj".to_string(),
                dir: "/tmp/proj".to_string(),
                claude: Some(ClaudeOverrides {
                    env: Some(std::collections::HashMap::from([(
                        "KEY".to_string(),
                        "val".to_string(),
                    )])),
                    settings: Some(serde_json::json!({"foo": "bar"})),
                    llm: None,
                }),
                integrations: None,
            }],
            active_project: Some("proj".to_string()),
            selected_ide: None,
            log_level: None,
        };

        apply_llm_config(&mut cfg, Some("openai".to_string()), None, None, None).unwrap();

        let project = cfg.find_project("proj").unwrap();
        let claude = project.claude.as_ref().unwrap();
        assert!(claude.env.is_some(), "env should be preserved");
        assert_eq!(
            claude.env.as_ref().unwrap().get("KEY"),
            Some(&"val".to_string())
        );
        assert!(claude.settings.is_some(), "settings should be preserved");
        assert_eq!(
            claude.llm.as_ref().unwrap().provider.as_deref(),
            Some("openai")
        );
    }

    #[test]
    fn apply_llm_config_does_not_affect_other_projects() {
        let mut cfg = make_config_with_active_project();
        // active_project is "alpha"

        apply_llm_config(&mut cfg, Some("openai".to_string()), None, None, None).unwrap();

        // beta should be unchanged
        let beta = cfg.find_project("beta").unwrap();
        let beta_llm = beta.claude.as_ref().unwrap().llm.as_ref().unwrap();
        assert_eq!(beta_llm.provider.as_deref(), Some("anthropic"));
        assert_eq!(beta_llm.model.as_deref(), Some("claude-sonnet-4-6"));
    }
}
