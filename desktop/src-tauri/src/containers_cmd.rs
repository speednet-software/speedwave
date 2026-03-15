// Container lifecycle and setup wizard Tauri commands.
//
// Extracted from main.rs — thin #[tauri::command] wrappers that delegate to
// `setup_wizard` and `speedwave_runtime` functions, converting errors to
// `Result<T, String>` for Tauri's serialization boundary.

use speedwave_runtime::config;
use speedwave_runtime::runtime::ContainerRuntime;

use crate::reconcile::{SharedIdeBridge, SharedMcpOs};
use crate::setup_wizard;
use crate::types::{check_project, LlmConfigResponse};

// ---------------------------------------------------------------------------
// Project switch transaction helpers
// ---------------------------------------------------------------------------

/// Result of the container-switching transaction.
pub(crate) enum SwitchResult {
    Succeeded,
    /// Primary error + optional cleanup error. Caller handles config rollback + UI.
    Failed {
        error: String,
        cleanup_error: Option<String>,
    },
}

/// Tears down (partially-started) new project, then restores previous.
/// Returns Ok if restore succeeded, Err with combined message if not.
pub(crate) fn teardown_and_restore(
    new_project: &str,
    previous: &str,
    rt: &dyn ContainerRuntime,
) -> Result<(), String> {
    let down_err = rt.compose_down(new_project).err();
    if let Some(ref e) = down_err {
        log::warn!("teardown new '{new_project}' failed: {e}");
    }
    rt.compose_up(previous).map_err(|e| {
        let base = format!("restore '{previous}' failed: {e}");
        match down_err {
            Some(de) => format!("{base}. Teardown of '{new_project}' also failed: {de}"),
            None => base,
        }
    })
}

/// Tears down new project without restoring anything.
/// Used when previous is None — no project to restore.
pub(crate) fn teardown_only(new_project: &str, rt: &dyn ContainerRuntime) -> Option<String> {
    rt.compose_down(new_project).err().map(|e| {
        log::warn!("teardown new '{new_project}' failed: {e}");
        format!("teardown of '{new_project}' failed: {e}")
    })
}

/// Core sync logic: ensure_ready → stop previous → recreate new.
/// Does NOT touch config or chat — caller handles those.
pub(crate) fn switch_project_core(
    previous: &Option<String>,
    new_project: &str,
    rt: &dyn ContainerRuntime,
    recreate_fn: &dyn Fn(&str, &dyn ContainerRuntime) -> Result<(), String>,
) -> SwitchResult {
    // 1. Ensure runtime is ready
    if let Err(e) = rt.ensure_ready() {
        return SwitchResult::Failed {
            error: format!("Runtime not ready: {e}"),
            cleanup_error: None,
        };
    }

    // 2. Stop previous (if different)
    if let Some(prev) = previous {
        if prev != new_project {
            if let Err(e) = rt.compose_down(prev) {
                // Idempotent re-up: if compose_down left the previous project
                // in a partial state, compose_up ensures it is fully running.
                // On an already-running project this is a harmless no-op.
                let restore_err = rt.compose_up(prev).err();
                return SwitchResult::Failed {
                    error: format!("compose_down('{prev}') failed: {e}"),
                    cleanup_error: restore_err.map(|re| {
                        format!(
                            "restore '{prev}' also failed: {re}. \
                             System may be without running containers."
                        )
                    }),
                };
            }
        }
    }

    // 3. Recreate new
    if let Err(e) = recreate_fn(new_project, rt) {
        let cleanup_error = match previous {
            Some(prev) if prev != new_project => teardown_and_restore(new_project, prev, rt).err(),
            _ => teardown_only(new_project, rt),
        };
        return SwitchResult::Failed {
            error: e,
            cleanup_error,
        };
    }

    SwitchResult::Succeeded
}

// ---------------------------------------------------------------------------
// Compose helpers — resolve config, render, security check, save
// ---------------------------------------------------------------------------

/// Renders a new compose.yml for a project and saves it after security check.
///
/// Shared pipeline used by `recreate_project_containers`,
/// `restart_integration_containers`, and `reconcile_compose_port`.
pub(crate) fn render_and_save_compose(
    project: &str,
    rt: &dyn speedwave_runtime::runtime::ContainerRuntime,
) -> Result<String, String> {
    let user_config = config::load_user_config().map_err(|e| e.to_string())?;
    let project_dir = user_config
        .find_project(project)
        .map(|p| p.dir.clone())
        .ok_or_else(|| format!("project '{}' not found", project))?;

    let project_path = std::path::Path::new(&project_dir);
    let (resolved, integrations) =
        config::resolve_project_config(project_path, &user_config, project);

    let yaml = speedwave_runtime::compose::render_compose(
        project,
        &project_dir,
        &resolved,
        &integrations,
        Some(rt),
    )
    .map_err(|e| e.to_string())?;

    let manifests = speedwave_runtime::plugin::list_installed_plugins().unwrap_or_default();
    let violations = speedwave_runtime::compose::SecurityCheck::run(&yaml, project, &manifests);
    if !violations.is_empty() {
        return Err(format!(
            "Security check failed:\n{}",
            format_security_violations(&violations)
        ));
    }

    speedwave_runtime::compose::save_compose(project, &yaml).map_err(|e| e.to_string())?;
    Ok(yaml)
}

/// Formats security violations into a human-readable multi-line string.
pub(crate) fn format_security_violations(
    violations: &[speedwave_runtime::compose::SecurityViolation],
) -> String {
    violations
        .iter()
        .map(|v| format!("[{}] {} -- {}", v.container, v.rule, v.message))
        .collect::<Vec<_>>()
        .join("\n")
}

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

/// Adds a new project and boots it (containers + chat).
///
/// Same lifecycle as `switch_project`: emits `project_switch_started` /
/// `project_switch_succeeded` / `project_switch_failed`.  On failure the
/// project stays registered but inactive (user can retry from the switcher).
///
/// Transactional: ensure_ready → stop previous → start new. On failure,
/// previous project containers are restored.
#[tauri::command]
pub async fn add_project(
    name: String,
    dir: String,
    app: tauri::AppHandle,
    chat_state: tauri::State<'_, crate::chat::SharedChatSession>,
    mcp_os: tauri::State<'_, SharedMcpOs>,
    ide_bridge: tauri::State<'_, SharedIdeBridge>,
) -> Result<(), String> {
    // Start subsystems on-demand (e.g. after factory reset / fresh install)
    crate::ensure_mcp_os_running(&mcp_os, &app);
    crate::ensure_ide_bridge_running(&ide_bridge, &app);
    // Capture previous active project BEFORE runtime sets new one
    let previous = config::with_config_lock(|| {
        let cfg = config::load_user_config()?;
        Ok(cfg.active_project.clone())
    })
    .map_err(|e| e.to_string())?;

    // Register project (sets active_project internally)
    tokio::task::spawn_blocking({
        let name = name.clone();
        let dir = dir.clone();
        move || {
            log::info!("add_project: name={name}, dir={dir}");
            speedwave_runtime::project::add_project(&name, &dir).map_err(|e| {
                log::error!("add_project: error: {e}");
                e.to_string()
            })
        }
    })
    .await
    .map_err(|e| e.to_string())??;

    use tauri::Emitter;
    let _ = app.emit(
        "project_switch_started",
        serde_json::json!({ "project": name }),
    );

    // Container transaction: ensure_ready → stop previous → start new
    let prev_clone = previous.clone();
    let new_clone = name.clone();
    let switch_result = tokio::task::spawn_blocking(move || {
        let rt = speedwave_runtime::runtime::detect_runtime();
        switch_project_core(&prev_clone, &new_clone, &*rt, &|proj, _rt| {
            // start_containers calls ensure_ready internally (noop — VM already up)
            check_project(proj)?;
            log::info!("add_project: starting containers for project={proj}");
            setup_wizard::start_containers(proj).map_err(|e| {
                log::error!("add_project: start_containers failed: {e}");
                e.to_string()
            })
        })
    })
    .await
    .map_err(|e| e.to_string())?;

    if let SwitchResult::Failed {
        error,
        cleanup_error,
    } = switch_result
    {
        let full_error =
            crate::rollback_and_emit_failed(&app, previous, &error, cleanup_error.as_deref());
        return Err(full_error);
    }

    // Rebind chat session
    if let Err(e) = crate::rebind_chat(&name, &app, &chat_state) {
        // Containers running but chat failed — transient, still emit succeeded
        log::warn!("add_project: rebind_chat failed: {e}");
    }

    let _ = app.emit(
        "project_switch_succeeded",
        serde_json::json!({ "project": name }),
    );
    Ok(())
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
pub async fn start_containers(
    project: String,
    app: tauri::AppHandle,
    mcp_os: tauri::State<'_, SharedMcpOs>,
    ide_bridge: tauri::State<'_, SharedIdeBridge>,
) -> Result<(), String> {
    // Start subsystems on-demand (e.g. after factory reset / fresh install)
    crate::ensure_mcp_os_running(&mcp_os, &app);
    crate::ensure_ide_bridge_running(&ide_bridge, &app);

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

/// Recreate containers for a project with freshly generated compose.
///
/// Used on project switch to ensure `ENABLED_SERVICES` matches the new
/// project's integration settings.  Lighter than `restart_integration_containers`
/// because it skips image rebuilds and snapshot/rollback (images don't change
/// between projects, and there's no previous "good" compose to roll back to).
#[tauri::command]
pub async fn recreate_project_containers(project: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        check_project(&project)?;
        log::info!("recreate_project_containers: project={project}");
        let rt = speedwave_runtime::runtime::detect_runtime();

        // Stop old containers (ignore errors — they may not be running)
        let _ = rt.compose_down(&project);

        // Resolve config, render compose, security check, save
        render_and_save_compose(&project, &*rt)?;

        rt.compose_up_recreate(&project).map_err(|e| {
            log::error!("recreate_project_containers: compose_up_recreate failed: {e}");
            e.to_string()
        })?;

        log::info!("recreate_project_containers: done for project={project}");
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// Settings / reset commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn factory_reset(
    app: tauri::AppHandle,
    ide_bridge: tauri::State<'_, SharedIdeBridge>,
    mcp_os: tauri::State<'_, SharedMcpOs>,
) -> Result<(), String> {
    // 1. Stop mcp-os watchdog
    crate::WATCHDOG_STOP.store(true, std::sync::atomic::Ordering::Relaxed);

    // 2. Stop IDE Bridge
    if let Ok(mut guard) = ide_bridge.lock() {
        if let Some(mut bridge) = guard.take() {
            if let Err(e) = bridge.stop() {
                log::warn!("factory_reset: IDE Bridge stop: {e}");
            }
        }
    }

    // 3. Stop mcp-os (kill child, join drain threads → log file handles released)
    //    Explicit stop + cleanup_files before drop; wipe_data_dir will remove
    //    everything anyway, but this keeps behaviour consistent with run_exit_cleanup.
    if let Ok(mut guard) = mcp_os.lock() {
        if let Some(mut proc) = guard.take() {
            if let Err(e) = proc.stop() {
                log::warn!("factory_reset: mcp-os stop: {e}");
            }
            proc.cleanup_files();
        }
    }

    // 4. Wipe (compose_down, VM delete, CLI removal, remove_dir_all)
    let result = tokio::task::spawn_blocking(|| {
        log::info!("factory_reset: starting wipe");
        setup_wizard::factory_reset().map_err(|e| {
            log::error!("factory_reset: error: {e}");
            e.to_string()
        })
    })
    .await
    .map_err(|e| e.to_string())?;

    // 5. Always restart:
    //    Success → clean start, wizard shows (data dir gone).
    //    Failure → recover subsystems (data dir may partially exist).
    if let Err(ref e) = result {
        log::error!("factory_reset: wipe failed ({e}), restarting to recover");
    }
    app.restart();
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
                    plugin_settings: None,
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
                    plugin_settings: None,
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
                plugin_settings: None,
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
                plugin_settings: None,
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
                plugin_settings: None,
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

    // -- MockRuntime for switch/teardown tests --

    use speedwave_runtime::runtime::ContainerRuntime;
    use std::sync::{Arc, Mutex};

    struct MockRuntime {
        down_calls: Arc<Mutex<Vec<String>>>,
        up_calls: Arc<Mutex<Vec<String>>>,
        ensure_ready_fails: bool,
        fail_on_down: Vec<String>,
        fail_on_up: Vec<String>,
    }

    impl MockRuntime {
        fn new() -> Self {
            Self {
                down_calls: Arc::new(Mutex::new(Vec::new())),
                up_calls: Arc::new(Mutex::new(Vec::new())),
                ensure_ready_fails: false,
                fail_on_down: Vec::new(),
                fail_on_up: Vec::new(),
            }
        }

        fn with_ensure_ready_fails(mut self) -> Self {
            self.ensure_ready_fails = true;
            self
        }

        fn with_fail_on_down(mut self, projects: &[&str]) -> Self {
            self.fail_on_down = projects.iter().map(|s| s.to_string()).collect();
            self
        }

        fn with_fail_on_up(mut self, projects: &[&str]) -> Self {
            self.fail_on_up = projects.iter().map(|s| s.to_string()).collect();
            self
        }

        fn down_calls(&self) -> Vec<String> {
            self.down_calls.lock().unwrap().clone()
        }

        fn up_calls(&self) -> Vec<String> {
            self.up_calls.lock().unwrap().clone()
        }
    }

    impl ContainerRuntime for MockRuntime {
        fn compose_up(&self, project: &str) -> anyhow::Result<()> {
            self.up_calls.lock().unwrap().push(project.to_string());
            if self.fail_on_up.contains(&project.to_string()) {
                anyhow::bail!("mock up error for {project}");
            }
            Ok(())
        }
        fn compose_down(&self, project: &str) -> anyhow::Result<()> {
            self.down_calls.lock().unwrap().push(project.to_string());
            if self.fail_on_down.contains(&project.to_string()) {
                anyhow::bail!("mock down error for {project}");
            }
            Ok(())
        }
        fn compose_ps(&self, _: &str) -> anyhow::Result<Vec<serde_json::Value>> {
            Ok(vec![])
        }
        fn container_exec(&self, _: &str, _: &[&str]) -> std::process::Command {
            std::process::Command::new("true")
        }
        fn container_exec_piped(
            &self,
            _: &str,
            _: &[&str],
        ) -> anyhow::Result<std::process::Command> {
            Ok(std::process::Command::new("true"))
        }
        fn is_available(&self) -> bool {
            true
        }
        fn ensure_ready(&self) -> anyhow::Result<()> {
            if self.ensure_ready_fails {
                anyhow::bail!("VM not ready");
            }
            Ok(())
        }
        fn build_image(&self, _: &str, _: &str, _: &str, _: &[(&str, &str)]) -> anyhow::Result<()> {
            Ok(())
        }
        fn container_logs(&self, _: &str, _: u32) -> anyhow::Result<String> {
            Ok(String::new())
        }
        fn compose_logs(&self, _: &str, _: u32) -> anyhow::Result<String> {
            Ok(String::new())
        }
        fn compose_up_recreate(&self, _: &str) -> anyhow::Result<()> {
            Ok(())
        }
    }

    // -- teardown_and_restore tests --

    #[test]
    fn teardown_and_restore_ok() {
        let rt = MockRuntime::new();
        let result = teardown_and_restore("new_proj", "prev_proj", &rt);
        assert!(result.is_ok());
        assert_eq!(rt.down_calls(), vec!["new_proj"]);
        assert_eq!(rt.up_calls(), vec!["prev_proj"]);
    }

    #[test]
    fn teardown_and_restore_up_fails() {
        let rt = MockRuntime::new().with_fail_on_up(&["prev_proj"]);
        let result = teardown_and_restore("new_proj", "prev_proj", &rt);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            err.contains("restore 'prev_proj' failed"),
            "expected restore error, got: {err}"
        );
        assert_eq!(rt.down_calls(), vec!["new_proj"]);
        assert_eq!(rt.up_calls(), vec!["prev_proj"]);
    }

    #[test]
    fn teardown_and_restore_both_fail() {
        let rt = MockRuntime::new()
            .with_fail_on_down(&["new_proj"])
            .with_fail_on_up(&["prev_proj"]);
        let result = teardown_and_restore("new_proj", "prev_proj", &rt);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            err.contains("restore 'prev_proj' failed"),
            "expected restore error, got: {err}"
        );
        assert!(
            err.contains("Teardown of 'new_proj' also failed"),
            "expected teardown error, got: {err}"
        );
    }

    // -- teardown_only tests --

    #[test]
    fn teardown_only_ok() {
        let rt = MockRuntime::new();
        let result = teardown_only("new_proj", &rt);
        assert!(result.is_none());
        assert_eq!(rt.down_calls(), vec!["new_proj"]);
    }

    #[test]
    fn teardown_only_fails() {
        let rt = MockRuntime::new().with_fail_on_down(&["new_proj"]);
        let result = teardown_only("new_proj", &rt);
        assert!(result.is_some());
        let msg = result.unwrap();
        assert!(
            msg.contains("teardown of 'new_proj' failed"),
            "expected teardown msg, got: {msg}"
        );
    }

    // -- switch_project_core tests --

    fn ok_recreate(_proj: &str, _rt: &dyn ContainerRuntime) -> Result<(), String> {
        Ok(())
    }

    fn fail_recreate(_proj: &str, _rt: &dyn ContainerRuntime) -> Result<(), String> {
        Err("recreate failed".to_string())
    }

    #[test]
    fn switch_core_happy_path_with_previous() {
        let rt = MockRuntime::new();
        let prev = Some("prev".to_string());
        let result = switch_project_core(&prev, "new", &rt, &ok_recreate);
        assert!(matches!(result, SwitchResult::Succeeded));
        assert_eq!(rt.down_calls(), vec!["prev"]);
    }

    #[test]
    fn switch_core_happy_path_no_previous() {
        let rt = MockRuntime::new();
        let result = switch_project_core(&None, "new", &rt, &ok_recreate);
        assert!(matches!(result, SwitchResult::Succeeded));
        assert!(rt.down_calls().is_empty());
    }

    #[test]
    fn switch_core_happy_path_same_project() {
        let rt = MockRuntime::new();
        let prev = Some("same".to_string());
        let result = switch_project_core(&prev, "same", &rt, &ok_recreate);
        assert!(matches!(result, SwitchResult::Succeeded));
        // No down call when prev == new
        assert!(rt.down_calls().is_empty());
    }

    #[test]
    fn switch_core_ensure_ready_fails() {
        let rt = MockRuntime::new().with_ensure_ready_fails();
        let prev = Some("prev".to_string());
        let result = switch_project_core(&prev, "new", &rt, &ok_recreate);
        match result {
            SwitchResult::Failed {
                ref error,
                ref cleanup_error,
            } => {
                assert!(error.contains("Runtime not ready"), "got: {error}");
                assert!(cleanup_error.is_none());
            }
            SwitchResult::Succeeded => panic!("expected Failed"),
        }
        // No compose calls when ensure_ready fails
        assert!(rt.down_calls().is_empty());
        assert!(rt.up_calls().is_empty());
    }

    #[test]
    fn switch_core_down_prev_fails_up_prev_ok() {
        let rt = MockRuntime::new().with_fail_on_down(&["prev"]);
        let prev = Some("prev".to_string());
        let result = switch_project_core(&prev, "new", &rt, &ok_recreate);
        match result {
            SwitchResult::Failed {
                ref error,
                ref cleanup_error,
            } => {
                assert!(
                    error.contains("compose_down('prev') failed"),
                    "got: {error}"
                );
                // Restore succeeded → no cleanup_error
                assert!(cleanup_error.is_none(), "got: {cleanup_error:?}");
            }
            SwitchResult::Succeeded => panic!("expected Failed"),
        }
        assert_eq!(rt.down_calls(), vec!["prev"]);
        assert_eq!(rt.up_calls(), vec!["prev"]);
    }

    #[test]
    fn switch_core_down_prev_fails_up_prev_fails() {
        let rt = MockRuntime::new()
            .with_fail_on_down(&["prev"])
            .with_fail_on_up(&["prev"]);
        let prev = Some("prev".to_string());
        let result = switch_project_core(&prev, "new", &rt, &ok_recreate);
        match result {
            SwitchResult::Failed {
                ref error,
                ref cleanup_error,
            } => {
                assert!(
                    error.contains("compose_down('prev') failed"),
                    "got: {error}"
                );
                let ce = cleanup_error.as_ref().expect("should have cleanup_error");
                assert!(ce.contains("restore 'prev' also failed"), "got: {ce}");
            }
            SwitchResult::Succeeded => panic!("expected Failed"),
        }
    }

    #[test]
    fn switch_core_recreate_fails_with_previous() {
        let rt = MockRuntime::new();
        let prev = Some("prev".to_string());
        let result = switch_project_core(&prev, "new", &rt, &fail_recreate);
        match result {
            SwitchResult::Failed {
                ref error,
                ref cleanup_error,
            } => {
                assert!(error.contains("recreate failed"), "got: {error}");
                // teardown_and_restore: down(new) + up(prev) both succeed → no cleanup_error
                assert!(cleanup_error.is_none(), "got: {cleanup_error:?}");
            }
            SwitchResult::Succeeded => panic!("expected Failed"),
        }
        // down(prev) for stop + down(new) for teardown
        assert_eq!(rt.down_calls(), vec!["prev", "new"]);
        // up(prev) for restore
        assert_eq!(rt.up_calls(), vec!["prev"]);
    }

    #[test]
    fn switch_core_recreate_fails_no_previous() {
        let rt = MockRuntime::new();
        let result = switch_project_core(&None, "new", &rt, &fail_recreate);
        match result {
            SwitchResult::Failed {
                ref error,
                ref cleanup_error,
            } => {
                assert!(error.contains("recreate failed"), "got: {error}");
                // teardown_only succeeded → no cleanup_error
                assert!(cleanup_error.is_none(), "got: {cleanup_error:?}");
            }
            SwitchResult::Succeeded => panic!("expected Failed"),
        }
        assert_eq!(rt.down_calls(), vec!["new"]);
        assert!(rt.up_calls().is_empty());
    }

    #[test]
    fn switch_core_recreate_fails_restore_fails() {
        let rt = MockRuntime::new().with_fail_on_up(&["prev"]);
        let prev = Some("prev".to_string());
        let result = switch_project_core(&prev, "new", &rt, &fail_recreate);
        match result {
            SwitchResult::Failed {
                ref error,
                ref cleanup_error,
            } => {
                assert!(error.contains("recreate failed"), "got: {error}");
                let ce = cleanup_error.as_ref().expect("should have cleanup_error");
                assert!(ce.contains("restore 'prev' failed"), "got: {ce}");
            }
            SwitchResult::Succeeded => panic!("expected Failed"),
        }
    }

    #[test]
    fn switch_core_recreate_fails_via_closure_with_previous() {
        let rt = MockRuntime::new();
        let prev = Some("prev".to_string());
        let result = switch_project_core(&prev, "new", &rt, &|_proj, _rt| {
            Err("render error".to_string())
        });
        match result {
            SwitchResult::Failed { ref error, .. } => {
                assert!(error.contains("render error"), "got: {error}");
            }
            SwitchResult::Succeeded => panic!("expected Failed"),
        }
        // down(prev) for stop + down(new) for teardown (noop)
        assert_eq!(rt.down_calls(), vec!["prev", "new"]);
        assert_eq!(rt.up_calls(), vec!["prev"]);
    }

    #[test]
    fn switch_core_recreate_fails_via_closure_no_previous() {
        let rt = MockRuntime::new();
        let result = switch_project_core(&None, "new", &rt, &|_proj, _rt| {
            Err("render error".to_string())
        });
        match result {
            SwitchResult::Failed { ref error, .. } => {
                assert!(error.contains("render error"), "got: {error}");
            }
            SwitchResult::Succeeded => panic!("expected Failed"),
        }
        // down(new) for teardown only
        assert_eq!(rt.down_calls(), vec!["new"]);
        assert!(rt.up_calls().is_empty());
    }

    // -- add_project flow tests --
    //
    // add_project uses switch_project_core with a closure that calls
    // check_project + start_containers. These tests verify that specific
    // combination: ensure_ready → stop prev → start_containers(new),
    // distinct from switch_project which uses compose_down+render+up_recreate.

    /// Simulates the add_project closure: check_project (always ok in tests)
    /// + start_containers (delegates to compose_up to simulate container start).
    fn add_project_recreate(proj: &str, rt: &dyn ContainerRuntime) -> Result<(), String> {
        // In production: check_project(proj)? + start_containers(proj)
        // start_containers calls ensure_ready (noop) + render + compose_up
        rt.compose_up(proj).map_err(|e| e.to_string())
    }

    fn add_project_recreate_fail(_proj: &str, _rt: &dyn ContainerRuntime) -> Result<(), String> {
        Err("start_containers failed".to_string())
    }

    #[test]
    fn add_project_ensure_ready_fails() {
        let rt = MockRuntime::new().with_ensure_ready_fails();
        let prev = Some("prev".to_string());
        let result = switch_project_core(&prev, "new", &rt, &add_project_recreate);
        match result {
            SwitchResult::Failed {
                ref error,
                ref cleanup_error,
            } => {
                assert!(error.contains("Runtime not ready"), "got: {error}");
                assert!(cleanup_error.is_none());
            }
            SwitchResult::Succeeded => panic!("expected Failed"),
        }
        assert!(rt.down_calls().is_empty(), "no compose calls when VM fails");
        assert!(rt.up_calls().is_empty());
    }

    #[test]
    fn add_project_happy_path_with_previous() {
        let rt = MockRuntime::new();
        let prev = Some("prev".to_string());
        let result = switch_project_core(&prev, "new", &rt, &add_project_recreate);
        assert!(matches!(result, SwitchResult::Succeeded));
        // ensure_ready → down(prev) → up(new) via start_containers
        assert_eq!(rt.down_calls(), vec!["prev"]);
        assert_eq!(rt.up_calls(), vec!["new"]);
    }

    #[test]
    fn add_project_down_prev_fails_restore_ok() {
        let rt = MockRuntime::new().with_fail_on_down(&["prev"]);
        let prev = Some("prev".to_string());
        let result = switch_project_core(&prev, "new", &rt, &add_project_recreate);
        match result {
            SwitchResult::Failed {
                ref error,
                ref cleanup_error,
            } => {
                assert!(
                    error.contains("compose_down('prev') failed"),
                    "got: {error}"
                );
                // up(prev) restore succeeded → no cleanup_error
                assert!(cleanup_error.is_none(), "got: {cleanup_error:?}");
            }
            SwitchResult::Succeeded => panic!("expected Failed"),
        }
        assert_eq!(rt.down_calls(), vec!["prev"]);
        assert_eq!(rt.up_calls(), vec!["prev"]);
    }

    #[test]
    fn add_project_start_containers_fails_restore_prev() {
        // start_containers fails → teardown_and_restore(new, prev)
        let rt = MockRuntime::new();
        let prev = Some("prev".to_string());
        let result = switch_project_core(&prev, "new", &rt, &add_project_recreate_fail);
        match result {
            SwitchResult::Failed {
                ref error,
                ref cleanup_error,
            } => {
                assert!(error.contains("start_containers failed"), "got: {error}");
                // teardown(new) + restore(prev) both ok → no cleanup_error
                assert!(cleanup_error.is_none(), "got: {cleanup_error:?}");
            }
            SwitchResult::Succeeded => panic!("expected Failed"),
        }
        // down(prev) for stop + down(new) for teardown
        assert_eq!(rt.down_calls(), vec!["prev", "new"]);
        // up(prev) for restore
        assert_eq!(rt.up_calls(), vec!["prev"]);
    }

    #[test]
    fn add_project_happy_path_no_previous() {
        let rt = MockRuntime::new();
        let result = switch_project_core(&None, "new", &rt, &add_project_recreate);
        assert!(matches!(result, SwitchResult::Succeeded));
        // No previous → no down, only up(new)
        assert!(rt.down_calls().is_empty());
        assert_eq!(rt.up_calls(), vec!["new"]);
    }
}
