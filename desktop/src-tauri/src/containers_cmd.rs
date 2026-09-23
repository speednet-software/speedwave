use speedwave_runtime::config;

use crate::reconcile::{SharedIdeBridge, SharedMcpOs, SharedOauth};
use crate::setup_wizard;
use crate::types::{
    check_project, CustomPolicyDto, LlmConfigResponse, LlmConfigUpdate, PiiRuleInfo,
    SecurityPolicyResponse, SecurityPolicyTemplateInfo, SecurityPolicyUpdate,
    TelemetryConfigResponse, TelemetryConfigUpdate, TelemetryLocks,
};

const MAX_API_KEY_BYTES: usize = 64 * 1024;
const MAX_CUSTOM_HEADERS_BYTES: usize = 16 * 1024;

const FORBIDDEN_HEADER_NAMES: &[&str] = &[
    "authorization",
    "cookie",
    "host",
    "content-length",
    "transfer-encoding",
];

pub(crate) fn validate_api_key(value: &str) -> Result<String, String> {
    if value.len() > MAX_API_KEY_BYTES {
        return Err(format!("api_key exceeds {} byte limit", MAX_API_KEY_BYTES));
    }
    if value.contains('\r') || value.contains('\n') {
        return Err("api_key must not contain newline characters".to_string());
    }
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    if trimmed.eq_ignore_ascii_case("bearer") {
        return Err("api_key must not be empty after stripping the 'Bearer ' prefix".to_string());
    }
    crate::llm_cmd::strip_bearer_prefix(value)
        .ok_or_else(|| "api_key must not be empty after stripping the 'Bearer ' prefix".to_string())
}

pub(crate) fn validate_custom_headers(value: &str) -> Result<String, String> {
    use reqwest::header::{HeaderName, HeaderValue};

    if value.len() > MAX_CUSTOM_HEADERS_BYTES {
        return Err(format!(
            "custom_headers exceeds {} byte limit",
            MAX_CUSTOM_HEADERS_BYTES
        ));
    }
    if value.contains('\r') {
        return Err("custom_headers must not contain carriage returns".to_string());
    }
    for (idx, line) in value.lines().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let (name, rest) = trimmed
            .split_once(':')
            .ok_or_else(|| format!("line {}: header must be `Name: Value`", idx + 1))?;
        let name = name.trim();
        HeaderName::from_bytes(name.as_bytes())
            .map_err(|e| format!("line {}: invalid header name '{}': {e}", idx + 1, name))?;
        if FORBIDDEN_HEADER_NAMES.contains(&name.to_ascii_lowercase().as_str()) {
            return Err(format!(
                "line {}: header '{}' is reserved (set api_key instead, or remove)",
                idx + 1,
                name
            ));
        }
        let val = rest.trim();
        if val.is_empty() {
            return Err(format!("line {}: empty header value", idx + 1));
        }
        HeaderValue::from_str(val)
            .map_err(|e| format!("line {}: invalid header value for '{}': {e}", idx + 1, name))?;
    }
    Ok(value.to_string())
}

const RECONCILE_WAIT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(600);

pub(crate) fn ensure_images_ready() -> Result<(), String> {
    crate::reconcile::wait_for_images_ready(RECONCILE_WAIT_TIMEOUT)
}

#[tauri::command]
pub(crate) fn retry_bundle_reconcile(app_handle: tauri::AppHandle) -> bool {
    crate::reconcile::retry_bundle_reconcile_if_failed(&app_handle)
}

pub(crate) enum SwitchResult {
    Succeeded {
        teardown: Option<String>,
    },
    Failed {
        error: String,
        cleanup_error: Option<String>,
    },
}

impl SwitchResult {
    pub(crate) fn failed(error: String, cleanup_error: Option<String>) -> Self {
        Self::Failed {
            error: speedwave_runtime::log_sanitizer::sanitize(&error),
            cleanup_error: cleanup_error
                .map(|cleanup| speedwave_runtime::log_sanitizer::sanitize(&cleanup)),
        }
    }
}

pub(crate) fn teardown_only(
    new_project: &str,
    rt: &speedwave_runtime::runtime::LockedRuntime,
) -> Option<String> {
    rt.compose_down(new_project).err().map(|e| {
        log::warn!("failed to tear down new project '{new_project}': {e}");
        format!("teardown of '{new_project}' failed: {e}")
    })
}

static PENDING_TEARDOWNS: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<String, std::thread::JoinHandle<()>>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

fn pending_teardowns_lock(
) -> std::sync::MutexGuard<'static, std::collections::HashMap<String, std::thread::JoinHandle<()>>>
{
    match PENDING_TEARDOWNS.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    }
}

pub(crate) fn spawn_background_teardown(prev: String) {
    spawn_background_teardown_with(prev, |p| {
        let rt = speedwave_runtime::runtime::detect_runtime();
        rt.compose_down(p).map_err(|e| e.to_string())
    });
}

fn teardown_intents_path_in(data_dir: &std::path::Path) -> std::path::PathBuf {
    data_dir.join("pending-teardowns")
}

fn record_teardown_intent_in(data_dir: &std::path::Path, project: &str) {
    let _guard = pending_teardowns_lock();
    let path = teardown_intents_path_in(data_dir);
    let mut entries: Vec<String> = std::fs::read_to_string(&path)
        .map(|c| c.lines().map(str::to_string).collect())
        .unwrap_or_default();
    if !entries.iter().any(|e| e == project) {
        entries.push(project.to_string());
        if let Err(e) =
            speedwave_runtime::fs_perms::write_shared_file_atomic(&path, &entries.join("\n"))
        {
            log::warn!("failed to record teardown intent for '{project}': {e}");
        }
    }
}

fn clear_teardown_intent_in(data_dir: &std::path::Path, project: &str) {
    let _guard = pending_teardowns_lock();
    let path = teardown_intents_path_in(data_dir);
    let Ok(content) = std::fs::read_to_string(&path) else {
        return;
    };
    let entries: Vec<&str> = content.lines().filter(|l| *l != project).collect();
    let result = if entries.is_empty() {
        std::fs::remove_file(&path).map_err(anyhow::Error::from)
    } else {
        speedwave_runtime::fs_perms::write_shared_file_atomic(&path, &entries.join("\n"))
    };
    if let Err(e) = result {
        log::warn!("failed to clear teardown intent for '{project}': {e}");
    }
}

const STALE_ATOMIC_WRITE_TEMP_AGE: std::time::Duration = std::time::Duration::from_secs(3600);

pub(crate) fn crashed_teardown_intents() -> Vec<String> {
    crashed_teardown_intents_in(speedwave_runtime::consts::data_dir())
}

fn crashed_teardown_intents_in(data_dir: &std::path::Path) -> Vec<String> {
    speedwave_runtime::fs_perms::sweep_stale_atomic_write_temp_files(
        data_dir,
        STALE_ATOMIC_WRITE_TEMP_AGE,
    );
    let path = teardown_intents_path_in(data_dir);
    std::fs::read_to_string(&path)
        .map(|c| c.lines().map(str::to_string).collect())
        .unwrap_or_default()
}

fn spawn_background_teardown_with(
    prev: String,
    down: impl FnOnce(&str) -> Result<(), String> + Send + 'static,
) {
    spawn_background_teardown_with_in(speedwave_runtime::consts::data_dir().clone(), prev, down);
}

fn spawn_background_teardown_with_in(
    data_dir: std::path::PathBuf,
    prev: String,
    down: impl FnOnce(&str) -> Result<(), String> + Send + 'static,
) {
    record_teardown_intent_in(&data_dir, &prev);
    let project = prev.clone();
    let handle = std::thread::spawn(move || {
        log::info!("stopping previous project '{project}' in the background");
        match down(&project) {
            Ok(()) => {
                log::info!("background teardown of '{project}' stopped");
                clear_teardown_intent_in(&data_dir, &project);
            }
            Err(e) => log::warn!("background compose_down('{project}') failed: {e}"),
        }
    });
    let replaced = pending_teardowns_lock().insert(prev, handle);
    if let Some(old) = replaced {
        let _ = old.join();
    }
}

pub(crate) fn drain_pending_teardowns() {
    let handles: Vec<(String, std::thread::JoinHandle<()>)> =
        pending_teardowns_lock().drain().collect();
    for (project, handle) in handles {
        log::info!("draining background teardown of '{project}' before exit");
        let _ = handle.join();
    }
}

pub(crate) fn wait_for_pending_teardown(project: &str) {
    let handle = pending_teardowns_lock().remove(project);
    if let Some(h) = handle {
        log::info!("waiting for background teardown of '{project}' before starting it");
        let _ = h.join();
    }
}

pub(crate) fn switch_project_core(
    previous: &Option<String>,
    new_project: &str,
    rt: &speedwave_runtime::runtime::LockedRuntime,
    recreate_fn: &dyn Fn(&str, &speedwave_runtime::runtime::LockedRuntime) -> Result<(), String>,
) -> SwitchResult {
    if let Err(e) = rt.ensure_ready() {
        return SwitchResult::failed(format!("Runtime not ready: {e}"), None);
    }

    wait_for_pending_teardown(new_project);

    if let Err(e) = recreate_fn(new_project, rt) {
        return SwitchResult::failed(e, teardown_only(new_project, rt));
    }

    SwitchResult::Succeeded {
        teardown: previous
            .as_ref()
            .filter(|p| p.as_str() != new_project)
            .cloned(),
    }
}

pub(crate) fn project_llm_is_unconfigured(project: &str) -> Result<bool, String> {
    let user_config = config::load_user_config().map_err(|e| e.to_string())?;
    project_llm_is_unconfigured_in(&user_config, project)
}

fn project_llm_is_unconfigured_in(
    user_config: &config::SpeedwaveUserConfig,
    project: &str,
) -> Result<bool, String> {
    let project_dir = user_config
        .find_project(project)
        .map(|p| p.dir.clone())
        .ok_or_else(|| format!("project '{}' not found", project))?;
    let project_path = std::path::Path::new(&project_dir);
    let (resolved, _integrations) =
        config::resolve_project_config(project_path, user_config, project);
    Ok(resolved.llm.is_unconfigured())
}

pub(crate) fn render_and_save_compose(project: &str) -> Result<(), String> {
    let user_config = config::load_user_config().map_err(|e| e.to_string())?;
    let project_dir = user_config
        .find_project(project)
        .map(|p| p.dir.clone())
        .ok_or_else(|| format!("project '{}' not found", project))?;

    let project_path = std::path::Path::new(&project_dir);
    speedwave_runtime::cloudstorage::check_project_readable_or_err(project_path)?;
    let (resolved, integrations) =
        config::resolve_project_config(project_path, &user_config, project);

    let yaml = speedwave_runtime::compose::render_compose(
        project,
        &project_dir,
        &resolved,
        &integrations,
        None,
        &crate::reconcile::current_bridges_info(),
    )
    .map_err(|e| e.to_string())?;

    let manifests = speedwave_runtime::plugin::list_installed_plugins().unwrap_or_else(|e| {
        log::warn!("Failed to list installed plugins: {e}");
        Vec::new()
    });
    let expected_paths =
        speedwave_runtime::compose::SecurityExpectedPaths::compute(project, &project_dir)
            .map_err(|e| e.to_string())?
            .with_telemetry_locked(resolved.telemetry.any_locked);
    let prereq_violations = speedwave_runtime::os_prereqs::check_os_prereqs();
    if !prereq_violations.is_empty() {
        return Err(format!(
            "{} {}",
            speedwave_runtime::consts::SYSTEM_CHECK_FAILED_PREFIX,
            prereq_violations
                .iter()
                .map(|v| v.to_string())
                .collect::<Vec<_>>()
                .join("\n\n")
        ));
    }

    speedwave_runtime::fs_security::ensure_data_dir_permissions(project)
        .map_err(|e| e.to_string())?;
    let violations =
        speedwave_runtime::compose::SecurityCheck::run(&yaml, project, &manifests, &expected_paths);
    if !violations.is_empty() {
        return Err(format!(
            "{}\n{}",
            speedwave_runtime::consts::SYSTEM_CHECK_FAILED_PREFIX,
            format_security_violations(&violations)
        ));
    }

    speedwave_runtime::compose::save_compose(project, &yaml).map_err(|e| e.to_string())?;
    Ok(())
}

pub(crate) fn format_security_violations(
    violations: &[speedwave_runtime::compose::SecurityViolation],
) -> String {
    violations
        .iter()
        .map(|v| format!("[{}] {} -- {}", v.container, v.rule, v.message))
        .collect::<Vec<_>>()
        .join("\n")
}

#[tauri::command]
pub async fn run_system_check() -> Result<(), String> {
    let (violations, warnings) = tokio::task::spawn_blocking(|| {
        let v = speedwave_runtime::os_prereqs::check_os_prereqs();
        let w = speedwave_runtime::os_prereqs::check_os_warnings();
        (v, w)
    })
    .await
    .map_err(|e| e.to_string())?;

    for w in &warnings {
        log::warn!("OS warning: {w}");
    }

    if violations.is_empty() {
        Ok(())
    } else {
        Err(violations
            .iter()
            .map(|v| v.to_string())
            .collect::<Vec<_>>()
            .join("\n\n"))
    }
}

#[tauri::command]
pub async fn check_runtime() -> Result<String, String> {
    tokio::task::spawn_blocking(|| {
        log::info!("checking runtime status");
        let status = setup_wizard::check_runtime().map_err(|e| {
            log::error!("failed to check runtime status: {e}");
            e.to_string()
        })?;
        match status {
            setup_wizard::RuntimeStatus::Ready => {
                log::info!("runtime status is Ready");
                Ok("Ready".to_string())
            }
            setup_wizard::RuntimeStatus::NotInstalled => {
                log::info!("runtime status is NotInstalled");
                Ok("NotInstalled".to_string())
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn init_vm() -> Result<(), String> {
    tokio::task::spawn_blocking(|| {
        log::info!("initializing VM");
        setup_wizard::init_vm().map_err(|e| {
            log::error!("failed to initialize VM: {e}");
            e.to_string()
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn create_project(name: String, dir: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        log::info!("creating project name={name}, dir={dir}");
        setup_wizard::create_project(&name, &dir).map_err(|e| {
            log::error!("failed to create project: {e}");
            e.to_string()
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn link_cli() -> Result<(), String> {
    tokio::task::spawn_blocking(|| {
        log::info!("linking CLI");
        setup_wizard::link_cli().map_err(|e| {
            log::error!("failed to link CLI: {e}");
            e.to_string()
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn add_project(
    name: String,
    dir: String,
    app: tauri::AppHandle,
    chat_state: tauri::State<'_, crate::chat::SharedChatSession>,
    mcp_os: tauri::State<'_, SharedMcpOs>,
    ide_bridge: tauri::State<'_, SharedIdeBridge>,
) -> Result<(), String> {
    let Ok(_transition_guard) = crate::project_cmd::PROJECT_TRANSITION_LOCK.try_lock() else {
        return Err(crate::project_cmd::PROJECT_TRANSITION_BUSY_ERR.to_string());
    };
    crate::ensure_mcp_os_running(&mcp_os, &app);
    crate::ensure_ide_bridge_running(&ide_bridge, &app);
    use tauri::Manager;
    let oauth_arc = app.state::<SharedOauth>().inner().clone();

    {
        let dir_clone = dir.clone();
        let preflight_result = tokio::task::spawn_blocking(move || {
            speedwave_runtime::cloudstorage::check_project_readable_or_err(std::path::Path::new(
                &dir_clone,
            ))
        })
        .await
        .map_err(|e| e.to_string())?;
        preflight_result?;
    }

    let previous = config::with_config_lock(|| {
        let cfg = config::load_user_config()?;
        Ok(cfg.active_project.clone())
    })
    .map_err(|e| e.to_string())?;

    tokio::task::spawn_blocking({
        let name = name.clone();
        let dir = dir.clone();
        move || {
            log::info!("adding project name={name}, dir={dir}");
            speedwave_runtime::project::add_project(&name, &dir).map_err(|e| {
                log::error!("failed to add project: {e}");
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

    let prev_clone = previous.clone();
    let new_clone = name.clone();
    let switch_result = tokio::task::spawn_blocking(move || {
        if let Err(e) = ensure_images_ready() {
            return SwitchResult::failed(e, None);
        }
        let rt = speedwave_runtime::runtime::detect_runtime();
        switch_project_core(&prev_clone, &new_clone, &rt, &|proj, rt| {
            check_project(proj)?;
            if let Err(sanitized) = crate::integrations_cmd::ensure_project_images_built(rt, proj) {
                return Err(format!("Image build failed: {sanitized}"));
            }
            if project_llm_is_unconfigured(proj)? {
                log::info!("'{proj}' has no LLM provider — skipping container start");
                return Ok(());
            }
            crate::ensure_oauth_running(&oauth_arc, proj);
            log::info!("starting containers for project={proj}");
            setup_wizard::start_containers(proj).map_err(|e| {
                log::error!("failed to start containers: {e:#}");
                speedwave_runtime::build::user_facing_engine_error(&e)
            })
        })
    })
    .await
    .map_err(|e| e.to_string())?;

    let pending_teardown = match switch_result {
        SwitchResult::Failed {
            error,
            cleanup_error,
        } => {
            let full_error =
                crate::rollback_and_emit_failed(&app, previous, &error, cleanup_error.as_deref());
            return Err(full_error);
        }
        SwitchResult::Succeeded { teardown } => teardown,
    };

    if let Err(e) = crate::rebind_chat(&name, &app, &chat_state) {
        log::warn!("rebind_chat failed after adding project: {e}");
    }

    if let Some(prev) = pending_teardown {
        spawn_background_teardown(prev);
    }

    let _ = app.emit(
        "project_switch_succeeded",
        serde_json::json!({ "project": name }),
    );
    Ok(())
}

pub(crate) fn remove_project_core(
    name: &str,
    rt: &speedwave_runtime::runtime::LockedRuntime,
    check_fn: &dyn Fn(&str) -> Result<(), String>,
    remove_fn: &dyn Fn(&str) -> Result<(), String>,
) -> Result<(), String> {
    check_fn(name)?;
    rt.ensure_ready().map_err(|e| {
        log::error!("ensure_ready before removing '{name}' failed: {e:#}");
        format!(
            "Failed to start the container engine to clean up '{name}': {}",
            speedwave_runtime::build::user_facing_engine_error(&e)
        )
    })?;
    rt.compose_down(name).map_err(|e| {
        log::error!("compose_down('{name}') failed: {e:#}");
        format!(
            "Failed to stop containers for '{name}': {}",
            speedwave_runtime::build::user_facing_engine_error(&e)
        )
    })?;
    log::info!("removing project name={name}");
    remove_fn(name)
}

#[tauri::command]
pub async fn remove_project(name: String) -> Result<(), String> {
    let Ok(_transition_guard) = crate::project_cmd::PROJECT_TRANSITION_LOCK.try_lock() else {
        return Err(crate::project_cmd::PROJECT_TRANSITION_BUSY_ERR.to_string());
    };
    tokio::task::spawn_blocking(move || {
        let rt = speedwave_runtime::runtime::detect_runtime();
        remove_project_core(
            &name,
            &rt,
            &|n| speedwave_runtime::project::check_removable(n).map_err(|e| e.to_string()),
            &|n| {
                speedwave_runtime::project::remove_project(n).map_err(|e| {
                    log::error!("failed to remove project: {e}");
                    e.to_string()
                })
            },
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn is_setup_complete() -> Result<bool, String> {
    Ok(setup_wizard::is_setup_complete())
}

#[tauri::command]
pub async fn build_images() -> Result<(), String> {
    tokio::task::spawn_blocking(|| {
        log::info!("building images");
        setup_wizard::build_images().map_err(|e| {
            log::error!("failed to build images: {e:#}");
            format!("{e:#}")
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
    crate::ensure_mcp_os_running(&mcp_os, &app);
    crate::ensure_ide_bridge_running(&ide_bridge, &app);
    use tauri::Manager;
    let oauth_arc = app.state::<SharedOauth>().inner().clone();

    tokio::task::spawn_blocking(move || {
        ensure_images_ready()?;
        check_project(&project)?;
        crate::ensure_oauth_running(&oauth_arc, &project);
        if let Ok(cfg) = speedwave_runtime::config::load_user_config() {
            if let Some(p) = cfg.find_project(&project) {
                speedwave_runtime::cloudstorage::check_project_readable_or_err(
                    std::path::Path::new(&p.dir),
                )?;
            }
        }
        log::info!("starting containers for project={project}");
        setup_wizard::start_containers(&project).map_err(|e| {
            log::error!("failed to start containers: {e:#}");
            speedwave_runtime::build::user_facing_engine_error(&e)
        })
    })
    .await
    .map_err(|e| e.to_string())??;

    crate::tray::refresh_tray_menu(&app);
    Ok(())
}

#[tauri::command]
pub async fn defer_container_start(project: String, app: tauri::AppHandle) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        check_project(&project)?;
        setup_wizard::defer_container_start(&project).map_err(|e| {
            log::error!("failed to defer container start: {e}");
            e.to_string()
        })
    })
    .await
    .map_err(|e| e.to_string())??;

    crate::tray::refresh_tray_menu(&app);
    Ok(())
}

#[tauri::command]
pub async fn check_containers_running(project: String) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || {
        check_project(&project)?;
        log::info!("checking whether containers are running for project={project}");
        if !crate::reconcile::wait_for_image_check(RECONCILE_WAIT_TIMEOUT) {
            log::warn!(
                "container engine check still running after {}s, reading the engine as it is",
                RECONCILE_WAIT_TIMEOUT.as_secs()
            );
        }
        let rt = speedwave_runtime::runtime::detect_runtime();
        if !rt.is_available() {
            log::warn!("runtime not available");
            return Ok(false);
        }
        if !speedwave_runtime::runtime::project_has_compose_file(&project) {
            log::info!("no compose.yml yet for '{project}'");
            return Ok(false);
        }
        let containers = rt.compose_ps(&project).map_err(|e| {
            log::error!("failed to check containers running: {e}");
            e.to_string()
        })?;
        log::info!("found {} running containers", containers.len());
        Ok(!containers.is_empty())
    })
    .await
    .map_err(|e| e.to_string())?
}

pub(crate) fn recreate_project_containers_if_running(project: &str) {
    let active = speedwave_runtime::config::load_user_config()
        .ok()
        .and_then(|c| c.active_project);
    if active.as_deref() != Some(project) {
        log::debug!("'{project}' is not the active project — skipping recreate");
        return;
    }
    if let Err(e) = ensure_images_ready() {
        log::warn!("images not ready for '{project}' — skipping recreate: {e}");
        return;
    }
    let rt = speedwave_runtime::runtime::detect_runtime();
    if !rt.is_available() {
        log::debug!("runtime not available — skipping recreate");
        return;
    }
    let running = match rt.compose_ps(project) {
        Ok(c) => !c.is_empty(),
        Err(e) => {
            log::debug!("compose_ps failed ({e}) — skipping recreate");
            return;
        }
    };
    if !running {
        log::debug!("'{project}' not running — skipping recreate");
        return;
    }
    if let Err(sanitized) = crate::integrations_cmd::ensure_project_images_built(&rt, project) {
        log::warn!("pre-build failed for '{project}' — skipping recreate: {sanitized}");
        return;
    }
    use crate::types::IntoAnyhow;
    let result = rt.transaction(project, |rt| -> anyhow::Result<()> {
        render_and_save_compose(project).into_anyhow()?;
        speedwave_runtime::runtime::compose_validate_with_retry(rt, project)?;
        rt.compose_up_recreate(project)?;
        Ok(())
    });
    match result {
        Ok(()) => {
            log::info!("recreated containers for '{project}' so the hub re-discovers");
        }
        Err(e) => {
            log::warn!("failed to recreate containers for '{project}': {e}");
        }
    }
}

#[tauri::command]
pub async fn recreate_project_containers(project: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        ensure_images_ready()?;
        check_project(&project)?;
        if let Ok(cfg) = speedwave_runtime::config::load_user_config() {
            if let Some(p) = cfg.find_project(&project) {
                speedwave_runtime::cloudstorage::check_project_readable_or_err(
                    std::path::Path::new(&p.dir),
                )?;
            }
        }
        log::info!("recreating containers for project={project}");
        let rt = speedwave_runtime::runtime::detect_runtime();
        rt.ensure_ready().map_err(|e| e.to_string())?;

        if let Err(sanitized) = crate::integrations_cmd::ensure_project_images_built(&rt, &project)
        {
            log::error!("image build failed: {sanitized}");
            return Err(format!("Image build failed: {sanitized}"));
        }

        use crate::types::IntoAnyhow;
        rt.transaction(&project, |rt| -> anyhow::Result<()> {
            let _ = rt.compose_down(&project);
            render_and_save_compose(&project).into_anyhow()?;
            speedwave_runtime::runtime::compose_validate_with_retry(rt, &project)?;
            rt.compose_up_recreate(&project)?;
            Ok(())
        })
        .map_err(|e| e.to_string())?;

        log::info!("finished recreating containers for project={project}");
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn factory_reset(
    app: tauri::AppHandle,
    ide_bridge: tauri::State<'_, SharedIdeBridge>,
    mcp_os: tauri::State<'_, SharedMcpOs>,
    oauth: tauri::State<'_, SharedOauth>,
    clipboard: tauri::State<'_, crate::clipboard_bridge::SharedClipboardBridge>,
) -> Result<(), String> {
    speedwave_runtime::runtime::inhibit_vm_start();
    crate::WATCHDOG_STOP.store(true, std::sync::atomic::Ordering::Relaxed);

    crate::OAUTH_WATCHDOG_STOP.store(true, std::sync::atomic::Ordering::Relaxed);

    if let Ok(mut guard) = ide_bridge.lock() {
        if let Some(mut bridge) = guard.take() {
            if let Err(e) = bridge.stop() {
                log::warn!("failed to stop IDE Bridge during factory reset: {e}");
            }
        }
    }

    if let Ok(mut guard) = mcp_os.lock() {
        if let Some(mut proc) = guard.take() {
            if let Err(e) = proc.stop() {
                log::warn!("failed to stop mcp-os during factory reset: {e}");
            }
            proc.cleanup_files();
        }
    }

    if let Ok(mut map) = oauth.lock() {
        for (project, mut proc) in map.drain() {
            if let Err(e) = proc.stop() {
                log::warn!("oauth worker for '{project}' stop error during factory reset: {e}");
            }
            proc.cleanup_files();
        }
    }

    if let Ok(mut guard) = clipboard.lock() {
        drop(guard.take());
    }

    let wipe = tokio::task::spawn_blocking(|| {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            drain_pending_teardowns();
            let _ = tx.send(());
        });
        if rx.recv_timeout(std::time::Duration::from_secs(30)).is_err() {
            log::warn!("background teardown drain did not finish within 30s, continuing with wipe");
        }
        log::info!("starting factory reset wipe");
        setup_wizard::factory_reset()
    })
    .await;

    match wipe {
        Ok(Ok(())) => {}
        Ok(Err(e)) => log::error!("factory reset wipe failed ({e:#}), restarting to recover"),
        Err(e) => log::error!("factory reset wipe did not finish ({e}), restarting to recover"),
    }
    app.restart();
}

#[tauri::command]
pub fn get_llm_config() -> Result<LlmConfigResponse, String> {
    let user_config = config::load_user_config().map_err(|e| e.to_string())?;
    let mut llm = user_config
        .active_project_entry()
        .and_then(|p| p.claude.as_ref())
        .and_then(|c| c.llm.clone())
        .unwrap_or_default();
    if let Some(active) = user_config.active_project.as_deref() {
        llm.sync_has_api_key_from_disk_in(speedwave_runtime::consts::data_dir().as_path(), active);
    }
    let default_base_url = llm
        .provider
        .as_deref()
        .and_then(speedwave_runtime::compose::default_base_url);

    if let Some(ref url) = llm.base_url {
        let normalized = speedwave_runtime::compose::strip_trailing_v1(url);
        if let Err(e) = crate::llm_cmd::validate_llm_base_url(&normalized) {
            log::warn!("stored base_url '{url}' fails current SSRF policy: {e}");
        }
    }

    Ok(LlmConfigResponse {
        llm,
        default_base_url,
    })
}

#[derive(serde::Serialize, Debug)]
pub struct ActiveProviderSummary {
    pub provider_id: String,
    pub kind: config::LlmProviderKind,
    pub model: Option<String>,
    pub base_url: Option<String>,
}

pub(crate) fn active_provider_summary_from(
    user_config: &config::SpeedwaveUserConfig,
    project: &str,
) -> Result<ActiveProviderSummary, String> {
    let project_entry = user_config
        .find_project(project)
        .ok_or_else(|| format!("unknown project: {project}"))?;
    let llm = project_entry
        .claude
        .as_ref()
        .and_then(|c| c.llm.clone())
        .unwrap_or_default();
    let entry = llm
        .active_provider()
        .ok_or("no active provider configured")?;
    Ok(ActiveProviderSummary {
        provider_id: entry.id.clone(),
        kind: entry.kind,
        model: llm.effective_active_model(),
        base_url: entry.base_url.clone(),
    })
}

#[tauri::command]
pub fn get_active_provider_summary(project: String) -> Result<ActiveProviderSummary, String> {
    let user_config = config::load_user_config().map_err(|e| e.to_string())?;
    active_provider_summary_from(&user_config, &project)
}

#[tauri::command]
pub fn get_default_base_url(provider: String) -> Result<Option<String>, String> {
    Ok(speedwave_runtime::compose::default_base_url(&provider))
}

#[tauri::command]
pub fn get_openrouter_default_model() -> &'static str {
    speedwave_runtime::consts::OPENROUTER_DEFAULT_MODEL
}

#[tauri::command]
pub fn list_anthropic_models() -> &'static [speedwave_runtime::defaults::AnthropicModelInfo] {
    speedwave_runtime::defaults::ANTHROPIC_MODELS
}

fn build_telemetry_response(
    resolved: &config::ResolvedTelemetry,
    has_headers: bool,
) -> TelemetryConfigResponse {
    use speedwave_runtime::telemetry_env::TelemetryField as F;
    let locks = TelemetryLocks {
        enabled: resolved.is_field_locked(F::Enabled),
        endpoint: resolved.is_field_locked(F::Endpoint),
        protocol: resolved.is_field_locked(F::Protocol),
        export_metrics: resolved.is_field_locked(F::ExportMetrics),
        export_logs: resolved.is_field_locked(F::ExportLogs),
        headers: resolved.is_field_locked(F::Headers),
        resource_attributes: resolved.is_field_locked(F::ResourceAttributes),
        include_account_uuid: resolved.is_field_locked(F::IncludeAccountUuid),
        log_user_prompts: resolved.is_field_locked(F::LogUserPrompts),
        log_assistant_responses: resolved.is_field_locked(F::LogAssistantResponses),
        log_tool_details: resolved.is_field_locked(F::LogToolDetails),
        log_raw_api_bodies: resolved.is_field_locked(F::LogRawApiBodies),
        metric_export_interval_ms: resolved.is_field_locked(F::MetricExportInterval),
        logs_export_interval_ms: resolved.is_field_locked(F::LogsExportInterval),
    };
    TelemetryConfigResponse {
        enabled: resolved.enabled,
        endpoint: resolved.endpoint.clone(),
        protocol: resolved.protocol,
        export_metrics: resolved.export_metrics,
        export_logs: resolved.export_logs,
        has_headers,
        resource_attributes: resolved.resource_attributes.clone(),
        include_account_uuid: resolved.include_account_uuid,
        log_user_prompts: resolved.log_user_prompts,
        log_assistant_responses: resolved.log_assistant_responses,
        log_tool_details: resolved.log_tool_details,
        log_raw_api_bodies: resolved.log_raw_api_bodies,
        metric_export_interval_ms: resolved.metric_export_interval_ms,
        logs_export_interval_ms: resolved.logs_export_interval_ms,
        locks,
        any_locked: resolved.any_locked,
        kill_switch: resolved.kill_switch,
    }
}

fn apply_telemetry_update_with(
    user: &mut config::TelemetryConfig,
    update: TelemetryConfigUpdate,
    resolved: &config::ResolvedTelemetry,
) -> Vec<&'static str> {
    use speedwave_runtime::telemetry_env::TelemetryField as F;
    let mut rejected: Vec<&'static str> = Vec::new();
    macro_rules! set_field {
        ($name:literal, $field:expr, $present:expr, $unchanged:expr, $assign:expr) => {
            if $present {
                if resolved.is_field_locked($field) {
                    if !$unchanged {
                        rejected.push($name);
                    }
                } else {
                    $assign;
                }
            }
        };
    }
    set_field!(
        "enabled",
        F::Enabled,
        update.enabled.is_some(),
        update.enabled == Some(resolved.enabled),
        user.enabled = update.enabled
    );
    if let Some(e) = update.endpoint {
        set_field!(
            "endpoint",
            F::Endpoint,
            true,
            e == resolved.endpoint,
            user.endpoint = e
        );
    }
    set_field!(
        "protocol",
        F::Protocol,
        update.protocol.is_some(),
        update.protocol == Some(resolved.protocol),
        user.protocol = update.protocol
    );
    set_field!(
        "export_metrics",
        F::ExportMetrics,
        update.export_metrics.is_some(),
        update.export_metrics == Some(resolved.export_metrics),
        user.export_metrics = update.export_metrics
    );
    set_field!(
        "export_logs",
        F::ExportLogs,
        update.export_logs.is_some(),
        update.export_logs == Some(resolved.export_logs),
        user.export_logs = update.export_logs
    );
    if let Some(h) = update.headers {
        set_field!(
            "headers",
            F::Headers,
            true,
            h == resolved.headers,
            user.headers = h
        );
    }
    if let Some(ra) = update.resource_attributes {
        set_field!(
            "resource_attributes",
            F::ResourceAttributes,
            true,
            ra == resolved.resource_attributes,
            user.resource_attributes = ra
        );
    }
    set_field!(
        "include_account_uuid",
        F::IncludeAccountUuid,
        update.include_account_uuid.is_some(),
        update.include_account_uuid == Some(resolved.include_account_uuid),
        user.include_account_uuid = update.include_account_uuid
    );
    set_field!(
        "log_user_prompts",
        F::LogUserPrompts,
        update.log_user_prompts.is_some(),
        update.log_user_prompts == Some(resolved.log_user_prompts),
        user.log_user_prompts = update.log_user_prompts
    );
    set_field!(
        "log_assistant_responses",
        F::LogAssistantResponses,
        update.log_assistant_responses.is_some(),
        update.log_assistant_responses == Some(resolved.log_assistant_responses),
        user.log_assistant_responses = update.log_assistant_responses
    );
    set_field!(
        "log_tool_details",
        F::LogToolDetails,
        update.log_tool_details.is_some(),
        update.log_tool_details == Some(resolved.log_tool_details),
        user.log_tool_details = update.log_tool_details
    );
    set_field!(
        "log_raw_api_bodies",
        F::LogRawApiBodies,
        update.log_raw_api_bodies.is_some(),
        update.log_raw_api_bodies == Some(resolved.log_raw_api_bodies),
        user.log_raw_api_bodies = update.log_raw_api_bodies
    );
    if let Some(v) = update.metric_export_interval_ms {
        set_field!(
            "metric_export_interval_ms",
            F::MetricExportInterval,
            true,
            v == resolved.metric_export_interval_ms,
            user.metric_export_interval_ms = v
        );
    }
    if let Some(v) = update.logs_export_interval_ms {
        set_field!(
            "logs_export_interval_ms",
            F::LogsExportInterval,
            true,
            v == resolved.logs_export_interval_ms,
            user.logs_export_interval_ms = v
        );
    }
    rejected
}

fn compute_has_headers(
    user: Option<&config::TelemetryConfig>,
    managed: Option<&speedwave_runtime::config::ManagedTelemetryConfig>,
) -> bool {
    let non_empty = |h: &String| !h.is_empty();
    user.and_then(|t| t.headers.as_ref()).is_some_and(non_empty)
        || managed
            .and_then(|m| m.headers.as_ref())
            .is_some_and(non_empty)
}

#[tauri::command]
pub fn get_telemetry_config() -> Result<TelemetryConfigResponse, String> {
    let user_config = config::load_user_config().map_err(|e| e.to_string())?;
    let managed = speedwave_runtime::managed_config::load_managed_config()
        .map_err(|e| e.to_string())?
        .and_then(|m| m.telemetry);
    let resolved = config::resolve_telemetry(user_config.telemetry.as_ref(), managed.as_ref())
        .map_err(|e| e.to_string())?;
    let has_headers = compute_has_headers(user_config.telemetry.as_ref(), managed.as_ref());
    Ok(build_telemetry_response(&resolved, has_headers))
}

#[tauri::command]
pub fn update_telemetry_config(update: TelemetryConfigUpdate) -> Result<(), String> {
    config::with_config_lock(|| {
        let mut user_config = config::load_user_config()?;
        let managed =
            speedwave_runtime::managed_config::load_managed_config()?.and_then(|m| m.telemetry);
        let resolved = config::resolve_telemetry(user_config.telemetry.as_ref(), managed.as_ref())?;
        let mut telemetry = user_config.telemetry.take().unwrap_or_default();
        let rejected = apply_telemetry_update_with(&mut telemetry, update, &resolved);
        if !rejected.is_empty() {
            anyhow::bail!(
                "cannot change organization-managed telemetry field(s): {}",
                rejected.join(", ")
            );
        }
        config::resolve_telemetry(Some(&telemetry), managed.as_ref())?;
        user_config.telemetry = Some(telemetry);
        config::save_user_config(&user_config)?;
        Ok(())
    })
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn probe_otlp_endpoint(endpoint: String) -> Result<bool, String> {
    let validated = crate::url_validation::validate_collector_url(
        &endpoint,
        crate::url_validation::PrivatePolicy::AllowLoopback,
    )?;
    let client = crate::http_util::build_hardened_client(None)?;
    match client.head(validated).send().await {
        Ok(_) => Ok(true),
        Err(e) => {
            log::debug!("OTLP collector unreachable: {e}");
            Ok(false)
        }
    }
}

fn build_security_policy_response(
    resolved: &speedwave_runtime::pii_policy::ResolvedPiiPolicy,
    raw: Option<&config::PiiPolicyUserConfig>,
) -> SecurityPolicyResponse {
    let custom_policies = raw
        .map(|r| {
            r.custom_policies
                .iter()
                .map(|d| CustomPolicyDto {
                    id: d.id.clone(),
                    name: d.name.clone(),
                    categories: d.categories.clone(),
                    rules: d.rules.clone(),
                    keywords: d.keywords.clone(),
                })
                .collect()
        })
        .unwrap_or_default();
    SecurityPolicyResponse {
        enabled_policies: resolved.source.policies.clone(),
        forced_policies: resolved.source.forced.clone(),
        effective_rules: resolved.rules.clone(),
        custom_policies,
    }
}

#[tauri::command]
pub fn get_security_policy() -> Result<SecurityPolicyResponse, String> {
    let user_config = config::load_user_config().map_err(|e| e.to_string())?;
    let policy = user_config
        .active_project_entry()
        .and_then(|p| p.policy.clone());
    let managed = speedwave_runtime::managed_config::load_managed_config()
        .map_err(|e| e.to_string())?
        .and_then(|m| m.pii_policy);
    let resolved =
        speedwave_runtime::pii_policy::resolve_pii_policy(policy.as_ref(), managed.as_ref())?;
    Ok(build_security_policy_response(&resolved, policy.as_ref()))
}

#[tauri::command]
pub fn list_security_policy_templates() -> Result<Vec<SecurityPolicyTemplateInfo>, String> {
    let templates =
        speedwave_runtime::pii_policy::builtin_templates().map_err(|e| e.to_string())?;
    Ok(templates
        .iter()
        .map(|t| SecurityPolicyTemplateInfo {
            id: t.id.clone(),
            name: t.name.clone(),
            description: t.description.clone(),
            categories: t.categories.clone(),
        })
        .collect())
}

#[tauri::command]
pub fn list_pii_rules() -> Result<Vec<PiiRuleInfo>, String> {
    let library = speedwave_runtime::pii_policy::rule_library().map_err(|e| e.to_string())?;
    Ok(library
        .iter()
        .map(|r| PiiRuleInfo {
            id: r.id.clone(),
            display_name: r.display_name.clone(),
        })
        .collect())
}

fn derive_custom_policy_id(name: &str) -> Result<String, String> {
    let mut id = String::new();
    let mut prev_sep = true;
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() {
            id.push(ch.to_ascii_lowercase());
            prev_sep = false;
        } else if !prev_sep {
            id.push('-');
            prev_sep = true;
        }
    }
    while id.ends_with('-') {
        id.pop();
    }
    if id.is_empty() {
        return Err("policy name must contain at least one letter or digit".to_string());
    }
    if id.chars().next().is_some_and(|c| c.is_ascii_digit()) {
        id = format!("policy-{id}");
    }
    if id.len() > 64 {
        id.truncate(64);
        while id.ends_with('-') {
            id.pop();
        }
    }
    Ok(id)
}

fn derive_own_rule_id(name: &str) -> Result<String, String> {
    let mut id = String::new();
    let mut prev_sep = true;
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() {
            id.push(ch.to_ascii_uppercase());
            prev_sep = false;
        } else if !prev_sep {
            id.push('_');
            prev_sep = true;
        }
    }
    while id.ends_with('_') {
        id.pop();
    }
    if id.is_empty() {
        return Err("pattern name must contain at least one letter or digit".to_string());
    }
    if id.chars().next().is_some_and(|c| c.is_ascii_digit()) {
        id = format!("RULE_{id}");
    }
    if id.len() > 64 {
        id.truncate(64);
        while id.ends_with('_') {
            id.pop();
        }
    }
    Ok(id)
}

fn build_pii_policy_user_config(
    update: &SecurityPolicyUpdate,
) -> anyhow::Result<config::PiiPolicyUserConfig> {
    use speedwave_runtime::pii_policy;

    let mut policies = update.policies.clone();
    let mut custom_policies = Vec::with_capacity(update.custom_policies.len());
    for input in &update.custom_policies {
        let name = input.name.trim();
        let id = derive_custom_policy_id(name)
            .map_err(|e| anyhow::anyhow!("custom policy \"{name}\": {e}"))?;

        let mut rules = Vec::with_capacity(input.custom_patterns.len());
        for pattern in &input.custom_patterns {
            let pattern_name = pattern.display_name.trim();
            let rule_id = derive_own_rule_id(pattern_name)
                .map_err(|e| anyhow::anyhow!("custom pattern \"{pattern_name}\": {e}"))?;
            rules.push(pii_policy::OwnRuleV3 {
                id: rule_id,
                display_name: pattern_name.to_string(),
                patterns: vec![pattern.pattern.clone()],
                validator: None,
                case_sensitive: !pattern.case_insensitive,
                tokenize: true,
                log: false,
            });
        }

        if input.enabled && !policies.contains(&id) {
            policies.push(id.clone());
        }
        custom_policies.push(config::PiiPolicyDefinition {
            id,
            name: name.to_string(),
            categories: input.categories.clone(),
            rules,
            keywords: input.keywords.clone(),
        });
    }

    let cfg = config::PiiPolicyUserConfig {
        policies,
        custom_policies,
    };
    pii_policy::validate_user_policy_config(&cfg).map_err(|e| anyhow::anyhow!(e))?;
    Ok(cfg)
}

#[tauri::command]
pub fn update_security_policy(update: SecurityPolicyUpdate) -> Result<(), String> {
    config::with_config_lock(|| {
        let policy = build_pii_policy_user_config(&update)?;
        let mut user_config = config::load_user_config()?;
        let active = user_config
            .active_project
            .clone()
            .ok_or_else(|| anyhow::anyhow!("No active project"))?;
        let project = user_config
            .find_project_mut(&active)
            .ok_or_else(|| anyhow::anyhow!("Project '{}' not found in config", active))?;
        project.policy = Some(policy);
        config::save_user_config(&user_config)?;
        Ok(())
    })
    .map_err(|e| e.to_string())
}

fn apply_llm_config(
    user_config: &mut config::SpeedwaveUserConfig,
    update: config::LlmConfig,
) -> anyhow::Result<()> {
    if config::is_local_provider(update.provider.as_deref())
        && update.model.as_deref().is_none_or(str::is_empty)
    {
        return Err(anyhow::anyhow!(model_required_error(
            update.provider.as_deref().unwrap_or("")
        )));
    }
    if matches!(update.context_tokens, Some(0)) {
        return Err(anyhow::anyhow!("context_tokens must be greater than 0"));
    }

    let active = user_config
        .active_project
        .clone()
        .ok_or_else(|| anyhow::anyhow!("No active project"))?;
    let project = user_config
        .find_project_mut(&active)
        .ok_or_else(|| anyhow::anyhow!("Project '{}' not found in config", active))?;

    match &mut project.claude {
        Some(c) => c.llm = Some(update),
        None => {
            project.claude = Some(config::ClaudeOverrides {
                env: None,
                settings: None,
                llm: Some(update),
            });
        }
    }
    Ok(())
}

fn apply_set_provider_model(
    user_config: &mut config::SpeedwaveUserConfig,
    project_id: &str,
    provider_id: &str,
    model: &str,
) -> anyhow::Result<()> {
    let trimmed = model.trim();
    if trimmed.is_empty() {
        return Err(anyhow::anyhow!("model must not be empty"));
    }
    let project = user_config
        .find_project_mut(project_id)
        .ok_or_else(|| anyhow::anyhow!("Project '{project_id}' not found in config"))?;
    let llm = project
        .claude
        .as_mut()
        .and_then(|c| c.llm.as_mut())
        .ok_or_else(|| anyhow::anyhow!("provider '{provider_id}' not in config"))?;
    let entry = llm
        .providers
        .iter_mut()
        .find(|p| p.id == provider_id)
        .ok_or_else(|| anyhow::anyhow!("provider '{provider_id}' not in config"))?;
    if entry.kind.is_anthropic() {
        return Err(anyhow::anyhow!(
            "'{provider_id}' is Anthropic - model changes are session-only via /model, not saved"
        ));
    }
    entry.model = Some(trimmed.to_string());
    if llm
        .active
        .as_ref()
        .is_some_and(|a| a.provider_id == provider_id)
    {
        if let Some(active) = llm.active.as_mut() {
            active.model = Some(trimmed.to_string());
        }
    }
    Ok(())
}

#[tauri::command]
pub fn set_provider_model(
    project_id: String,
    provider_id: String,
    model: String,
) -> Result<(), String> {
    set_provider_model_in(
        speedwave_runtime::consts::data_dir(),
        project_id,
        provider_id,
        model,
    )
}

fn set_provider_model_in(
    data_dir: &std::path::Path,
    project_id: String,
    provider_id: String,
    model: String,
) -> Result<(), String> {
    log::info!("setting provider model project_id={project_id} provider_id={provider_id}");
    config::with_config_lock_in(data_dir, || {
        let config_path = data_dir.join("config.json");
        let mut user_config = config::load_user_config_from(&config_path)?;
        apply_set_provider_model(&mut user_config, &project_id, &provider_id, &model)?;
        if let Some(llm) = user_config
            .find_project_mut(&project_id)
            .and_then(|p| p.claude.as_mut())
            .and_then(|c| c.llm.as_mut())
        {
            config::sync_llm_legacy_fields(llm);
        }
        config::save_user_config_to(&user_config, &config_path)?;
        Ok(())
    })
    .map_err(|e: anyhow::Error| e.to_string())
}

#[async_trait::async_trait]
pub(crate) trait ModelAutoDefaultProbe: Send + Sync {
    async fn first_local_model(&self, entry_id: &str, base_url: &str) -> Result<String, String>;
}

struct LiveModelAutoDefaultProbe<'a> {
    active_project: Option<&'a str>,
    transient_api_key: Option<&'a str>,
    transient_custom_headers: Option<&'a str>,
}

#[async_trait::async_trait]
impl ModelAutoDefaultProbe for LiveModelAutoDefaultProbe<'_> {
    async fn first_local_model(&self, entry_id: &str, base_url: &str) -> Result<String, String> {
        let result = crate::llm_cmd::discovery::discover_llm_models_with_fallback(
            entry_id,
            base_url,
            self.transient_api_key,
            self.transient_custom_headers,
            self.active_project,
        )
        .await?;
        result
            .models
            .into_iter()
            .next()
            .map(|m| m.id)
            .ok_or_else(|| "empty".to_string())
    }
}

fn transient_credential(field: &Option<Option<String>>) -> Option<&str> {
    field
        .as_ref()
        .and_then(|inner| inner.as_deref())
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

fn preserve_stored_entry_models(
    incoming: &mut [speedwave_runtime::config::LlmProviderEntry],
    stored: &[speedwave_runtime::config::LlmProviderEntry],
) {
    for entry in incoming.iter_mut() {
        if entry.model.is_some() {
            continue;
        }
        if let Some(prior) = stored.iter().find(|p| p.id == entry.id) {
            entry.model = prior.model.clone();
            if entry.context_tokens.is_none() {
                entry.context_tokens = prior.context_tokens;
            }
        }
    }
}

async fn apply_model_auto_defaults(
    providers: &mut [speedwave_runtime::config::LlmProviderEntry],
    probe: &dyn ModelAutoDefaultProbe,
) -> Result<(), String> {
    use speedwave_runtime::config::LlmProviderKind;
    for entry in providers.iter_mut() {
        let has_model = entry
            .model
            .as_deref()
            .map(str::trim)
            .is_some_and(|m| !m.is_empty());
        if has_model {
            continue;
        }
        match entry.kind {
            LlmProviderKind::OpenRouter => {
                entry.model = Some(speedwave_runtime::consts::OPENROUTER_DEFAULT_MODEL.to_string());
            }
            LlmProviderKind::Local => {
                let base_url = entry.base_url.clone().unwrap_or_default();
                match probe.first_local_model(&entry.id, &base_url).await {
                    Ok(model) => entry.model = Some(model),
                    Err(e) => {
                        return Err(format!(
                            "{} - could not auto-select a model: {e}",
                            model_required_error(&entry.id)
                        ));
                    }
                }
            }
            _ => {}
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn update_llm_config(update: LlmConfigUpdate) -> Result<(), String> {
    update_llm_config_in(speedwave_runtime::consts::data_dir(), update).await
}

async fn update_llm_config_in(
    data_dir: &std::path::Path,
    mut update: LlmConfigUpdate,
) -> Result<(), String> {
    let config_path = data_dir.join("config.json");
    if config::is_local_provider(update.provider.as_deref()) {
        if let Some(url) = update.base_url.as_deref() {
            update.base_url = Some(speedwave_runtime::compose::canonicalize_local_base_url(url));
        }
    }
    let mut auto_default_candidates: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    let mut validation_providers = update.providers.clone();
    if let Some(ref mut providers) = update.providers {
        canonicalize_provider_base_urls(providers);
    }
    if let Some(ref mut providers) = validation_providers {
        canonicalize_provider_base_urls(providers);
        let loaded = config::load_user_config_from(&config_path).ok();
        let stored_providers = loaded
            .as_ref()
            .and_then(|c| c.active_project_entry())
            .and_then(|p| p.claude.as_ref())
            .and_then(|c| c.llm.as_ref())
            .map(|llm| llm.providers.as_slice())
            .unwrap_or(&[]);
        preserve_stored_entry_models(providers, stored_providers);
        let active_project = loaded.and_then(|c| c.active_project);
        let probe = LiveModelAutoDefaultProbe {
            active_project: active_project.as_deref(),
            transient_api_key: transient_credential(&update.api_key),
            transient_custom_headers: transient_credential(&update.custom_headers),
        };
        apply_model_auto_defaults(providers, &probe).await?;
        for entry in providers.iter() {
            if let Some(model) = entry.model.as_deref() {
                auto_default_candidates.insert(entry.id.clone(), model.to_string());
            }
        }
    }
    log::info!(
        "updating LLM config: provider={:?} model={:?} context_tokens={:?} \
         api_key_change={} custom_headers_change={}",
        update.provider,
        update.model,
        update.context_tokens,
        update.api_key.is_some(),
        update.custom_headers.is_some(),
    );
    let local_model_in_providers = update
        .provider
        .as_deref()
        .and_then(|provider_id| {
            validation_providers
                .as_ref()?
                .iter()
                .find(|p| p.id == provider_id)
        })
        .is_some_and(|entry| {
            entry
                .model
                .as_deref()
                .map(str::trim)
                .is_some_and(|m| !m.is_empty())
        });
    if config::is_local_provider(update.provider.as_deref())
        && update.model.as_deref().is_none_or(str::is_empty)
        && !local_model_in_providers
    {
        return Err(format!(
            "{} — configure it in Settings → LLM Provider → Model.",
            model_required_error(update.provider.as_deref().unwrap_or(""))
        ));
    }
    if let Some(ref m) = update.model {
        if m.starts_with("--") || m.starts_with('-') {
            return Err("Model name must not start with '-' (CLI flag collision)".to_string());
        }
    }
    if matches!(update.context_tokens, Some(0)) {
        return Err("context_tokens must be greater than 0".to_string());
    }
    if let Some(ref url) = update.base_url {
        let normalized = speedwave_runtime::compose::strip_trailing_v1(url);
        let parsed =
            crate::llm_cmd::validate_llm_base_url(&normalized).map_err(|e| e.to_string())?;
        speedwave_runtime::compose::validate_base_url(&normalized).map_err(|e| e.to_string())?;
        let port_str = parsed.port().map(|p| format!(":{p}")).unwrap_or_default();
        log::info!(
            "updating LLM config base_url={}://{}{port_str}",
            parsed.scheme(),
            parsed.host_str().unwrap_or("<no-host>"),
        );
    }

    if let Some(ref providers) = validation_providers {
        validate_provider_entries(providers)?;
        if let Some(ref active) = update.active {
            validate_active_selection(providers, active)?;
        }
    }

    let api_key_action =
        resolve_credential_action(update.api_key.as_ref(), validate_api_key, "api_key")?;
    let custom_headers_action = resolve_credential_action(
        update.custom_headers.as_ref(),
        validate_custom_headers,
        "custom_headers",
    )?;

    config::with_config_lock_in(data_dir, || {
        let mut user_config = config::load_user_config_from(&config_path)?;
        let active = user_config
            .active_project
            .clone()
            .ok_or_else(|| anyhow::anyhow!("No active project"))?;

        let mut new_has_api_key = lookup_has_flag(&user_config, &active, |c| c.has_api_key);
        let mut new_has_custom_headers =
            lookup_has_flag(&user_config, &active, |c| c.has_custom_headers);

        apply_credential_action(data_dir, &active, "api_key", &api_key_action)?;
        match &api_key_action {
            CredentialAction::Keep => {}
            CredentialAction::Delete => new_has_api_key = false,
            CredentialAction::Write(_) => new_has_api_key = true,
        }

        apply_credential_action(data_dir, &active, "custom_headers", &custom_headers_action)?;
        match &custom_headers_action {
            CredentialAction::Keep => {}
            CredentialAction::Delete => new_has_custom_headers = false,
            CredentialAction::Write(_) => new_has_custom_headers = true,
        }

        let mut merged = config::LlmConfig {
            provider: update.provider,
            model: update.model,
            base_url: update.base_url,
            context_tokens: update.context_tokens,
            has_api_key: new_has_api_key,
            has_custom_headers: new_has_custom_headers,
            ..Default::default()
        };
        let stored = user_config
            .active_project_entry()
            .and_then(|p| p.claude.as_ref())
            .and_then(|c| c.llm.clone())
            .unwrap_or_default();
        merged.providers = match update.providers {
            Some(mut providers) => {
                preserve_stored_entry_models(&mut providers, &stored.providers);
                for entry in &mut providers {
                    if entry.model.is_none() {
                        if let Some(model) = auto_default_candidates.get(&entry.id) {
                            entry.model = Some(model.clone());
                        }
                    }
                }
                providers
            }
            None => stored.providers.clone(),
        };
        merged.active = update.active.clone().or(stored.active);
        merged.proxy_enabled = update.proxy_enabled.or(stored.proxy_enabled);
        if let Some(ref mut active) = merged.active {
            if active.model.is_none() {
                if let Some(entry) = merged.providers.iter().find(|p| p.id == active.provider_id) {
                    active.model = entry.model.clone();
                }
            }
        }
        merged.clear_active_anthropic_model();
        if !merged.providers.is_empty() {
            merged.schema_version = Some(config::LLM_SCHEMA_VERSION);
            config::sync_llm_legacy_fields(&mut merged);
        }
        apply_llm_config(&mut user_config, merged)?;
        config::save_user_config_to(&user_config, &config_path)?;
        log::info!(
            "persisted LLM config to active_project={:?}",
            user_config.active_project
        );
        Ok(())
    })
    .map_err(|e| e.to_string())
}

fn model_required_error(provider_id: &str) -> String {
    format!("provider '{provider_id}' requires a model name")
}

fn validate_active_selection(
    providers: &[speedwave_runtime::config::LlmProviderEntry],
    active: &speedwave_runtime::config::LlmActive,
) -> Result<(), String> {
    use speedwave_runtime::config::is_foreign_anthropic_model;
    let Some(active_entry) = providers.iter().find(|p| p.id == active.provider_id) else {
        return Err(format!(
            "active provider '{}' is not in the provider list",
            active.provider_id
        ));
    };
    if let Some(model) = active.model.as_deref() {
        if model.starts_with('-') {
            return Err("active model must not start with '-' (CLI flag collision)".to_string());
        }
    }
    if active_entry.kind.is_anthropic() {
        let foreign = [active.model.as_deref(), active_entry.model.as_deref()]
            .into_iter()
            .flatten()
            .map(str::trim)
            .find(|m| is_foreign_anthropic_model(m));
        if let Some(m) = foreign {
            return Err(format!(
                "model '{m}' is not an Anthropic model — \
                 pick an Anthropic model or leave it on the account default"
            ));
        }
    } else {
        let entry_has = active_entry
            .model
            .as_deref()
            .map(str::trim)
            .is_some_and(|m| !m.is_empty());
        if !entry_has {
            return Err(model_required_error(&active.provider_id));
        }
    }
    Ok(())
}

fn canonicalize_provider_base_urls(providers: &mut [speedwave_runtime::config::LlmProviderEntry]) {
    use speedwave_runtime::config::LlmProviderKind;
    for entry in providers {
        if entry.kind == LlmProviderKind::Local {
            if let Some(url) = entry.base_url.as_deref() {
                entry.base_url = Some(speedwave_runtime::compose::canonicalize_local_base_url(url));
            }
        }
    }
}

fn validate_provider_entries(
    providers: &[speedwave_runtime::config::LlmProviderEntry],
) -> Result<(), String> {
    use speedwave_runtime::config::LlmProviderKind;
    let mut seen = std::collections::HashSet::new();
    for entry in providers {
        if !speedwave_runtime::plugin::is_valid_slug(&entry.id) {
            return Err(format!(
                "provider id '{}' must match ^[a-z][a-z0-9-]{{0,63}}$",
                entry.id
            ));
        }
        if !seen.insert(entry.id.as_str()) {
            return Err(format!("duplicate provider id '{}'", entry.id));
        }
        let needs_url = matches!(entry.kind, LlmProviderKind::Local);
        match (&entry.base_url, needs_url) {
            (Some(url), _) => {
                let normalized = speedwave_runtime::compose::strip_trailing_v1(url);
                crate::llm_cmd::validate_llm_base_url(&normalized).map_err(|e| e.to_string())?;
                speedwave_runtime::compose::validate_base_url(&normalized)
                    .map_err(|e| e.to_string())?;
            }
            (None, true) => {
                return Err(format!("provider '{}' requires a base URL", entry.id));
            }
            (None, false) => {}
        }
        if let Some(model) = entry.model.as_deref() {
            if model.starts_with('-') {
                return Err(format!(
                    "provider '{}': model must not start with '-' (CLI flag collision)",
                    entry.id
                ));
            }
            if entry.kind.is_anthropic()
                && speedwave_runtime::config::is_foreign_anthropic_model(model.trim())
            {
                return Err(format!(
                    "provider '{}': '{model}' is not an Anthropic model",
                    entry.id
                ));
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn set_llm_provider_key(provider_id: String, key: Option<String>) -> Result<(), String> {
    log::info!(
        "setting LLM provider key provider_id={provider_id} action={}",
        if key.as_deref().is_some_and(|k| !k.trim().is_empty()) {
            "write"
        } else {
            "delete"
        }
    );
    config::with_config_lock(|| {
        let mut user_config = config::load_user_config()?;
        let active = user_config
            .active_project
            .clone()
            .ok_or_else(|| anyhow::anyhow!("No active project"))?;
        let data_dir = speedwave_runtime::consts::data_dir();

        let has_key = match key.as_deref().map(str::trim) {
            Some(value) if !value.is_empty() => {
                speedwave_runtime::compose::write_llm_provider_key_in(
                    data_dir.as_path(),
                    &active,
                    &provider_id,
                    value,
                )?;
                true
            }
            _ => {
                speedwave_runtime::compose::remove_llm_provider_key_in(
                    data_dir.as_path(),
                    &active,
                    &provider_id,
                )?;
                false
            }
        };

        let project = user_config
            .find_project_mut(&active)
            .ok_or_else(|| anyhow::anyhow!("Project '{}' not found in config", active))?;
        if let Some(llm) = project.claude.as_mut().and_then(|c| c.llm.as_mut()) {
            if let Some(entry) = llm.providers.iter_mut().find(|p| p.id == provider_id) {
                entry.has_api_key = has_key;
            } else {
                log::warn!("provider '{provider_id}' not in config — has_api_key not updated");
            }
        }
        config::save_user_config(&user_config)?;
        Ok(())
    })
    .map_err(|e: anyhow::Error| e.to_string())
}

#[tauri::command]
pub fn clear_active_llm_provider() -> Result<(), String> {
    log::info!("clearing active LLM provider");
    config::with_config_lock(|| {
        let mut user_config = config::load_user_config()?;
        let active = user_config
            .active_project
            .clone()
            .ok_or_else(|| anyhow::anyhow!("No active project"))?;
        let project = user_config
            .find_project_mut(&active)
            .ok_or_else(|| anyhow::anyhow!("Project '{}' not found in config", active))?;
        if let Some(llm) = project.claude.as_mut().and_then(|c| c.llm.as_mut()) {
            llm.active = None;
        }
        config::save_user_config(&user_config)?;
        Ok(())
    })
    .map_err(|e: anyhow::Error| e.to_string())
}

#[tauri::command]
pub async fn restart_llm_proxy(project: String) -> Result<(), String> {
    check_project(&project)?;
    render_and_save_compose(&project)?;
    let rt = speedwave_runtime::runtime::detect_runtime();
    rt.compose_up_service(&project, "proxy")
        .map_err(|e| e.to_string())
}

#[derive(Debug, Clone)]
enum CredentialAction {
    Keep,
    Delete,
    Write(String),
}

fn resolve_credential_action(
    field: Option<&Option<String>>,
    validate: impl Fn(&str) -> Result<String, String>,
    name: &str,
) -> Result<CredentialAction, String> {
    match field {
        None => Ok(CredentialAction::Keep),
        Some(None) => Ok(CredentialAction::Delete),
        Some(Some(raw)) => {
            let normalised = validate(raw).map_err(|e| format!("{name}: {e}"))?;
            if normalised.is_empty() {
                Ok(CredentialAction::Delete)
            } else {
                Ok(CredentialAction::Write(normalised))
            }
        }
    }
}

fn lookup_has_flag(
    user_config: &config::SpeedwaveUserConfig,
    active: &str,
    pick: impl Fn(&config::LlmConfig) -> bool,
) -> bool {
    user_config
        .projects
        .iter()
        .find(|p| p.name == active)
        .and_then(|p| p.claude.as_ref())
        .and_then(|c| c.llm.as_ref())
        .map(pick)
        .unwrap_or(false)
}

fn apply_credential_action(
    data_dir: &std::path::Path,
    project: &str,
    file: &str,
    action: &CredentialAction,
) -> anyhow::Result<()> {
    match action {
        CredentialAction::Keep => Ok(()),
        CredentialAction::Delete => {
            let path =
                speedwave_runtime::compose::tokens_path_in(data_dir, project, "local-llm", file)?;
            match std::fs::remove_file(&path) {
                Ok(()) => log::info!("removed LLM token file {}", path.display()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.into()),
            }
            mirror_local_key_to_llm_namespace(data_dir, project, file, None)?;
            Ok(())
        }
        CredentialAction::Write(value) => {
            speedwave_runtime::compose::ensure_token_dir_in(data_dir, project, "local-llm")?;
            let path =
                speedwave_runtime::compose::tokens_path_in(data_dir, project, "local-llm", file)?;
            speedwave_runtime::fs_perms::write_restricted_file_atomic(&path, value)?;
            log::info!(
                "wrote LLM token file {} ({} bytes)",
                path.display(),
                value.len()
            );
            mirror_local_key_to_llm_namespace(data_dir, project, file, Some(value))?;
            Ok(())
        }
    }
}

fn mirror_local_key_to_llm_namespace(
    data_dir: &std::path::Path,
    project: &str,
    file: &str,
    value: Option<&str>,
) -> anyhow::Result<()> {
    if file != "api_key" {
        return Ok(());
    }
    let result = match value {
        Some(v) => {
            speedwave_runtime::compose::write_llm_provider_key_in(data_dir, project, "local", v)
                .map(|_| ())
        }
        None => speedwave_runtime::compose::remove_llm_provider_key_in(data_dir, project, "local"),
    };
    if let Err(e) = result {
        log::warn!("failed to mirror local api_key to llm namespace: {e}");
    }
    Ok(())
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "test assertions may unwrap/expect freely"
)]
mod tests {
    use super::*;
    use crate::types::{CustomPolicyDtoInput, SecurityPolicyCustomPatternInput};
    use config::{ClaudeOverrides, LlmConfig, ProjectUserEntry, SpeedwaveUserConfig};

    #[test]
    fn start_container_errors_route_through_the_owning_helper() {
        let source = include_str!("containers_cmd.rs");
        for pat in [
            "setup_wizard::start_containers(proj).map_err",
            "setup_wizard::start_containers(&project).map_err",
        ] {
            let site = source
                .find(pat)
                .unwrap_or_else(|| panic!("call site '{pat}' must exist"));
            let end = speedwave_runtime::build::char_boundary_at_or_after(source, site + 300);
            assert!(
                source[site..end].contains("user_facing_engine_error"),
                "'{pat}' must route through build::user_facing_engine_error before Err(String)"
            );
        }
    }

    #[test]
    fn list_anthropic_models_serves_the_whole_catalog_without_a_1m_row_flag() {
        let models = list_anthropic_models();
        assert_eq!(models, speedwave_runtime::defaults::ANTHROPIC_MODELS);

        let json = serde_json::to_value(models).expect("catalog must serialize");
        let fable_json = json
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["id"] == "claude-fable-5")
            .expect("claude-fable-5 must be present in the JSON payload");
        assert_eq!(fable_json["family"], "Fable 5");
        assert_eq!(fable_json["one_million_context"], "every_plan");
        assert!(fable_json.get("has_1m").is_none());
        assert!(fable_json.get("selectable").is_none());
    }

    fn make_config_with_active_project() -> SpeedwaveUserConfig {
        SpeedwaveUserConfig {
            projects: vec![
                ProjectUserEntry {
                    name: "alpha".to_string(),
                    dir: "/tmp/alpha".to_string(),
                    claude: None,
                    integrations: None,
                    plugin_settings: None,
                    policy: None,
                    effort_pin: None,
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
                            context_tokens: None,
                            has_api_key: false,
                            has_custom_headers: false,
                            ..Default::default()
                        }),
                    }),
                    integrations: None,
                    plugin_settings: None,
                    policy: None,
                    effort_pin: None,
                },
            ],
            active_project: Some("alpha".to_string()),
            selected_ide: None,
            ui: None,
            telemetry: None,
        }
    }

    fn llm(provider: &str, model: Option<&str>, base_url: Option<&str>) -> LlmConfig {
        LlmConfig {
            provider: Some(provider.to_string()),
            model: model.map(str::to_string),
            base_url: base_url.map(str::to_string),
            ..Default::default()
        }
    }

    fn llm_update(provider: &str, model: Option<&str>, base_url: Option<&str>) -> LlmConfigUpdate {
        LlmConfigUpdate {
            provider: Some(provider.to_string()),
            model: model.map(str::to_string),
            base_url: base_url.map(str::to_string),
            ..Default::default()
        }
    }

    fn seeded_config_tempdir() -> tempfile::TempDir {
        let tmp = tempfile::tempdir().expect("tempdir");
        config::save_user_config_to(
            &make_config_with_active_project(),
            &tmp.path().join("config.json"),
        )
        .expect("seed config");
        tmp
    }

    #[test]
    fn apply_llm_config_happy_path_no_existing_claude() {
        let mut cfg = make_config_with_active_project();
        assert!(cfg.find_project("alpha").unwrap().claude.is_none());

        let result = apply_llm_config(
            &mut cfg,
            llm("ollama", Some("llama3.3"), Some("http://localhost:11434")),
        );
        assert!(result.is_ok());

        let project = cfg.find_project("alpha").unwrap();
        let llm = project.claude.as_ref().unwrap().llm.as_ref().unwrap();
        assert_eq!(llm.provider.as_deref(), Some("ollama"));
        assert_eq!(llm.model.as_deref(), Some("llama3.3"));
        assert_eq!(llm.base_url.as_deref(), Some("http://localhost:11434"));
    }

    #[test]
    fn apply_llm_config_happy_path_existing_claude_overrides() {
        let mut cfg = make_config_with_active_project();
        cfg.active_project = Some("beta".to_string());

        let result = apply_llm_config(&mut cfg, llm("ollama", Some("llama3.3"), None));
        assert!(result.is_ok());

        let project = cfg.find_project("beta").unwrap();
        let llm = project.claude.as_ref().unwrap().llm.as_ref().unwrap();
        assert_eq!(llm.provider.as_deref(), Some("ollama"));
        assert_eq!(llm.model.as_deref(), Some("llama3.3"));
        assert_eq!(llm.base_url, None);
    }

    #[test]
    fn apply_llm_config_all_none_clears_fields() {
        let mut cfg = make_config_with_active_project();
        cfg.active_project = Some("beta".to_string());

        let result = apply_llm_config(
            &mut cfg,
            LlmConfig {
                provider: None,
                model: None,
                base_url: None,
                context_tokens: None,
                has_api_key: false,
                has_custom_headers: false,
                ..Default::default()
            },
        );
        assert!(result.is_ok());

        let project = cfg.find_project("beta").unwrap();
        let llm = project.claude.as_ref().unwrap().llm.as_ref().unwrap();
        assert!(llm.provider.is_none());
        assert!(llm.model.is_none());
        assert!(llm.base_url.is_none());
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
                policy: None,
                effort_pin: None,
            }],
            active_project: None,
            selected_ide: None,
            ui: None,
            telemetry: None,
        };

        let result = apply_llm_config(&mut cfg, llm("anthropic", None, None));
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
                policy: None,
                effort_pin: None,
            }],
            active_project: Some("nonexistent".to_string()),
            selected_ide: None,
            ui: None,
            telemetry: None,
        };

        let result = apply_llm_config(&mut cfg, llm("anthropic", None, None));
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
                policy: None,
                effort_pin: None,
            }],
            active_project: Some("proj".to_string()),
            selected_ide: None,
            ui: None,
            telemetry: None,
        };

        apply_llm_config(&mut cfg, llm("ollama", Some("llama3.3"), None)).unwrap();

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
            Some("ollama")
        );
    }

    #[test]
    fn apply_llm_config_rejects_local_provider_without_model() {
        let mut cfg = make_config_with_active_project();
        for provider in config::LOCAL_PROVIDERS {
            let err = apply_llm_config(&mut cfg, llm(provider, None, None)).unwrap_err();
            assert!(
                err.to_string().contains("requires a model name"),
                "provider={provider} must be rejected when model is None, got: {err}"
            );
        }
    }

    #[test]
    fn apply_llm_config_rejects_zero_context_tokens() {
        let mut cfg = make_config_with_active_project();
        let err = apply_llm_config(
            &mut cfg,
            LlmConfig {
                provider: Some("ollama".to_string()),
                model: Some("llama3.3".to_string()),
                base_url: Some("http://localhost:11434".to_string()),
                context_tokens: Some(0),
                has_api_key: false,
                has_custom_headers: false,
                ..Default::default()
            },
        )
        .unwrap_err();
        assert!(
            err.to_string().contains("context_tokens"),
            "zero context_tokens must be rejected, got: {err}"
        );
    }

    #[test]
    fn apply_llm_config_does_not_affect_other_projects() {
        let mut cfg = make_config_with_active_project();

        apply_llm_config(&mut cfg, llm("ollama", Some("llama3.3"), None)).unwrap();

        let beta = cfg.find_project("beta").unwrap();
        let beta_llm = beta.claude.as_ref().unwrap().llm.as_ref().unwrap();
        assert_eq!(beta_llm.provider.as_deref(), Some("anthropic"));
        assert_eq!(beta_llm.model.as_deref(), Some("claude-sonnet-4-6"));
    }

    #[tokio::test]
    async fn update_llm_config_rejects_local_provider_without_model() {
        assert!(
            !config::LOCAL_PROVIDERS.is_empty(),
            "LOCAL_PROVIDERS must list at least one provider — this test \
             iterates it"
        );
        for provider in config::LOCAL_PROVIDERS {
            for model in [None, Some(String::new())] {
                let result = update_llm_config(llm_update(
                    provider,
                    model.as_deref(),
                    Some("http://localhost:11434"),
                ))
                .await;
                let err = result.expect_err(&format!(
                    "provider={provider}, model={model:?} must be rejected \
                     but save succeeded"
                ));
                assert!(
                    err.contains("requires a model name"),
                    "provider={provider}, model={model:?} must fail with \
                     model-required error, got: {err}"
                );
            }
        }
    }

    #[tokio::test]
    async fn update_llm_config_accepts_anthropic_without_model() {
        let tmp = seeded_config_tempdir();
        let result = update_llm_config_in(tmp.path(), llm_update("anthropic", None, None)).await;
        if let Err(err) = result {
            assert!(
                !err.contains("requires a model name"),
                "Anthropic with no model must not trigger the local-provider \
                 model-required guard, got: {err}"
            );
        }
    }

    #[test]
    fn settings_save_preserves_existing_entry_models() {
        let stored = [speedwave_runtime::config::LlmProviderEntry {
            id: "local".to_string(),
            kind: speedwave_runtime::config::LlmProviderKind::Local,
            base_url: Some("http://localhost:11434".to_string()),
            model: Some("llama3.3".to_string()),
            has_api_key: false,
            context_tokens: Some(128_000),
            has_custom_headers: false,
        }];
        let mut incoming = [speedwave_runtime::config::LlmProviderEntry {
            id: "local".to_string(),
            kind: speedwave_runtime::config::LlmProviderKind::Local,
            base_url: Some("http://localhost:11434".to_string()),
            model: None,
            has_api_key: false,
            context_tokens: None,
            has_custom_headers: false,
        }];

        preserve_stored_entry_models(&mut incoming, &stored);

        assert_eq!(
            incoming[0].model.as_deref(),
            Some("llama3.3"),
            "a settings save carrying no model must not erase the \
             stored entry model"
        );
    }

    fn seeded_config_tempdir_with_local_model(model: &str) -> tempfile::TempDir {
        let mut cfg = make_config_with_active_project();
        let project = cfg.find_project_mut("alpha").unwrap();
        project.claude = Some(ClaudeOverrides {
            env: None,
            settings: None,
            llm: Some(LlmConfig {
                schema_version: Some(config::LLM_SCHEMA_VERSION),
                providers: vec![speedwave_runtime::config::LlmProviderEntry {
                    id: "local".to_string(),
                    kind: speedwave_runtime::config::LlmProviderKind::Local,
                    base_url: Some("http://localhost:11434".to_string()),
                    model: Some(model.to_string()),
                    has_api_key: false,
                    context_tokens: None,
                    has_custom_headers: false,
                }],
                active: Some(speedwave_runtime::config::LlmActive {
                    provider_id: "local".to_string(),
                    model: Some(model.to_string()),
                }),
                ..Default::default()
            }),
        });
        let tmp = tempfile::tempdir().expect("tempdir");
        config::save_user_config_to(&cfg, &tmp.path().join("config.json")).expect("seed config");
        tmp
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn update_llm_config_in_reconciles_models_under_the_lock_not_a_pre_lock_snapshot() {
        let tmp = seeded_config_tempdir_with_local_model("llama-old");
        let data_dir = tmp.path().to_path_buf();
        let config_path = data_dir.join("config.json");

        let lock_path = data_dir.join("config.lock");
        let lock_file = std::fs::File::create(&lock_path).expect("create lock file");
        fs2::FileExt::lock_exclusive(&lock_file).expect("acquire external lock");

        let update = LlmConfigUpdate {
            providers: Some(vec![speedwave_runtime::config::LlmProviderEntry {
                id: "local".to_string(),
                kind: speedwave_runtime::config::LlmProviderKind::Local,
                base_url: Some("http://localhost:11434".to_string()),
                model: None,
                has_api_key: false,
                context_tokens: None,
                has_custom_headers: false,
            }]),
            active: Some(speedwave_runtime::config::LlmActive {
                provider_id: "local".to_string(),
                model: None,
            }),
            ..Default::default()
        };

        let call_data_dir = data_dir.clone();
        let handle =
            tokio::spawn(async move { update_llm_config_in(&call_data_dir, update).await });

        tokio::time::sleep(std::time::Duration::from_millis(200)).await;

        let mut cfg = config::load_user_config_from(&config_path).expect("reload seeded config");
        {
            let project = cfg.find_project_mut("alpha").unwrap();
            let llm = project.claude.as_mut().unwrap().llm.as_mut().unwrap();
            llm.providers[0].model = Some("llama-new".to_string());
            llm.active.as_mut().unwrap().model = Some("llama-new".to_string());
        }
        config::save_user_config_to(&cfg, &config_path).expect("write concurrent update");

        fs2::FileExt::unlock(&lock_file).expect("release external lock");
        drop(lock_file);

        handle
            .await
            .expect("task join")
            .expect("update must succeed");

        let final_cfg = config::load_user_config_from(&config_path).expect("reload final config");
        let final_llm = final_cfg
            .find_project("alpha")
            .unwrap()
            .claude
            .as_ref()
            .unwrap()
            .llm
            .as_ref()
            .unwrap();
        assert_eq!(
            final_llm.providers[0].model.as_deref(),
            Some("llama-new"),
            "the persisted model must come from the on-disk state read UNDER \
             the config lock, not the pre-lock snapshot — a concurrent save's \
             model change must never be silently reverted"
        );
    }

    #[test]
    fn update_llm_config_merge_clears_anthropic_model() {
        let stored = config::LlmConfig {
            schema_version: Some(config::LLM_SCHEMA_VERSION),
            providers: vec![config::LlmProviderEntry {
                id: "anthropic".to_string(),
                kind: config::LlmProviderKind::AnthropicOauth,
                base_url: None,
                model: Some("claude-opus-4-6".to_string()),
                has_api_key: false,
                context_tokens: None,
                has_custom_headers: false,
            }],
            active: Some(config::LlmActive {
                provider_id: "anthropic".to_string(),
                model: Some("claude-opus-4-6".to_string()),
            }),
            ..Default::default()
        };

        let mut merged = config::LlmConfig {
            providers: stored.providers.clone(),
            active: stored.active.clone(),
            schema_version: Some(config::LLM_SCHEMA_VERSION),
            ..Default::default()
        };
        merged.clear_active_anthropic_model();
        config::sync_llm_legacy_fields(&mut merged);

        assert_eq!(
            merged.active_provider().unwrap().model,
            None,
            "entry model must be cleared"
        );
        assert_eq!(
            merged.active.as_ref().unwrap().model,
            None,
            "active pointer model must be cleared"
        );
        assert_eq!(merged.effective_active_model(), None);
    }

    #[test]
    fn update_llm_config_source_calls_clear_active_anthropic_model() {
        let source = include_str!("containers_cmd.rs");
        let site = source
            .find("apply_llm_config(&mut user_config, merged)?;")
            .expect("update_llm_config merge call site must exist");
        let start = source[..site].rfind("let mut merged").unwrap_or(0);
        assert!(
            source[start..site].contains("merged.clear_active_anthropic_model()"),
            "update_llm_config must call clear_active_anthropic_model on \
             `merged` before apply_llm_config"
        );
    }

    #[tokio::test]
    async fn update_llm_config_rejects_model_with_flag_prefix() {
        let result = update_llm_config(llm_update(
            "ollama",
            Some("--dangerously-skip-permissions"),
            Some("http://localhost:11434"),
        ))
        .await;
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            err.to_lowercase().contains("flag"),
            "Error must reference the flag collision, got: {err}"
        );
    }

    #[tokio::test]
    async fn update_llm_config_rejects_model_with_single_dash_prefix() {
        let result = update_llm_config(llm_update(
            "ollama",
            Some("-h"),
            Some("http://localhost:11434"),
        ))
        .await;
        assert!(result.is_err());
    }

    fn v2_entry(
        id: &str,
        kind: speedwave_runtime::config::LlmProviderKind,
        base_url: Option<&str>,
    ) -> speedwave_runtime::config::LlmProviderEntry {
        speedwave_runtime::config::LlmProviderEntry {
            id: id.to_string(),
            kind,
            base_url: base_url.map(str::to_string),
            model: None,
            has_api_key: false,
            context_tokens: None,
            has_custom_headers: false,
        }
    }

    fn cfg_with_providers(
        active_provider_id: &str,
        active_model: Option<&str>,
        providers: Vec<speedwave_runtime::config::LlmProviderEntry>,
    ) -> SpeedwaveUserConfig {
        let mut cfg = make_config_with_active_project();
        let project = cfg.find_project_mut("alpha").unwrap();
        project.claude = Some(ClaudeOverrides {
            env: None,
            settings: None,
            llm: Some(LlmConfig {
                schema_version: Some(speedwave_runtime::config::LLM_SCHEMA_VERSION),
                providers,
                active: Some(speedwave_runtime::config::LlmActive {
                    provider_id: active_provider_id.to_string(),
                    model: active_model.map(str::to_string),
                }),
                ..Default::default()
            }),
        });
        cfg
    }

    #[test]
    fn apply_set_provider_model_happy_path_sets_entry_and_syncs_active() {
        use speedwave_runtime::config::LlmProviderKind as K;
        let mut cfg = cfg_with_providers(
            "openrouter",
            Some("anthropic/claude-sonnet-4-6"),
            vec![v2_entry("openrouter", K::OpenRouter, None)],
        );
        apply_set_provider_model(&mut cfg, "alpha", "openrouter", "anthropic/claude-opus-4-8")
            .unwrap();
        let llm = cfg
            .find_project_mut("alpha")
            .unwrap()
            .claude
            .as_ref()
            .unwrap()
            .llm
            .as_ref()
            .unwrap();
        let entry = llm.providers.iter().find(|p| p.id == "openrouter").unwrap();
        assert_eq!(entry.model.as_deref(), Some("anthropic/claude-opus-4-8"));
        assert_eq!(
            llm.active.as_ref().unwrap().model.as_deref(),
            Some("anthropic/claude-opus-4-8"),
            "active pointer must follow the entry it points at"
        );
    }

    #[test]
    fn apply_set_provider_model_unknown_provider_id_errors() {
        use speedwave_runtime::config::LlmProviderKind as K;
        let mut cfg = cfg_with_providers(
            "openrouter",
            None,
            vec![v2_entry("openrouter", K::OpenRouter, None)],
        );
        let err = apply_set_provider_model(&mut cfg, "alpha", "ghost", "some-model").unwrap_err();
        assert!(err.to_string().contains("ghost"), "got: {err}");
    }

    #[test]
    fn apply_set_provider_model_rejects_anthropic_provider() {
        use speedwave_runtime::config::LlmProviderKind as K;
        let mut cfg = cfg_with_providers(
            "anthropic",
            None,
            vec![v2_entry("anthropic", K::AnthropicOauth, None)],
        );
        let err = apply_set_provider_model(&mut cfg, "alpha", "anthropic", "claude-opus-4-8")
            .unwrap_err();
        assert!(err.to_string().contains("session-only"), "got: {err}");
    }

    #[test]
    fn apply_set_provider_model_rejects_empty_model() {
        use speedwave_runtime::config::LlmProviderKind as K;
        let mut cfg = cfg_with_providers(
            "local",
            None,
            vec![v2_entry("local", K::Local, Some("http://127.0.0.1:11434"))],
        );
        let err = apply_set_provider_model(&mut cfg, "alpha", "local", "   ").unwrap_err();
        assert!(err.to_string().contains("model"), "got: {err}");
    }

    #[test]
    fn apply_set_provider_model_rejects_anthropic_provider_regardless_of_model_shape() {
        use speedwave_runtime::config::LlmProviderKind as K;
        let mut cfg = cfg_with_providers(
            "anthropic",
            None,
            vec![v2_entry("anthropic", K::AnthropicOauth, None)],
        );
        let err =
            apply_set_provider_model(&mut cfg, "alpha", "anthropic", "openrouter/x").unwrap_err();
        assert!(err.to_string().contains("session-only"), "got: {err}");
    }

    #[test]
    fn apply_set_provider_model_does_not_sync_active_when_pointer_targets_other_provider() {
        use speedwave_runtime::config::LlmProviderKind as K;
        let mut cfg = cfg_with_providers(
            "anthropic",
            None,
            vec![
                v2_entry("anthropic", K::AnthropicOauth, None),
                v2_entry("local", K::Local, Some("http://127.0.0.1:11434")),
            ],
        );
        apply_set_provider_model(&mut cfg, "alpha", "local", "llama3.3").unwrap();
        let llm = cfg
            .find_project_mut("alpha")
            .unwrap()
            .claude
            .as_ref()
            .unwrap()
            .llm
            .as_ref()
            .unwrap();
        assert_eq!(
            llm.active.as_ref().unwrap().provider_id,
            "anthropic",
            "active still points at anthropic, unaffected by the local entry write"
        );
        assert_eq!(
            llm.providers
                .iter()
                .find(|p| p.id == "local")
                .unwrap()
                .model
                .as_deref(),
            Some("llama3.3")
        );
    }

    #[test]
    fn apply_set_provider_model_sequential_calls_last_write_wins() {
        use speedwave_runtime::config::LlmProviderKind as K;
        let mut cfg = cfg_with_providers(
            "local",
            Some("llama3.3"),
            vec![v2_entry("local", K::Local, Some("http://127.0.0.1:11434"))],
        );
        apply_set_provider_model(&mut cfg, "alpha", "local", "mixtral").unwrap();
        apply_set_provider_model(&mut cfg, "alpha", "local", "llama4").unwrap();
        let llm = cfg
            .find_project_mut("alpha")
            .unwrap()
            .claude
            .as_ref()
            .unwrap()
            .llm
            .as_ref()
            .unwrap();
        assert_eq!(
            llm.providers.iter().find(|p| p.id == "local").unwrap().model.as_deref(),
            Some("llama4"),
            "the later call must win, serialized the same way two rapid IPC calls serialize through with_config_lock"
        );
        assert_eq!(
            llm.active.as_ref().unwrap().model.as_deref(),
            Some("llama4")
        );
    }

    #[test]
    fn set_provider_model_command_delegates_to_data_dir_variant() {
        let src = include_str!("containers_cmd.rs");
        let start = src
            .find("pub fn set_provider_model(")
            .expect("set_provider_model command must exist");
        let body = &src[start..src[start..].find("\n}\n").map(|i| start + i).unwrap()];
        assert!(
            body.contains("set_provider_model_in("),
            "must delegate to the data_dir-parameterized variant"
        );
        assert!(
            // SSOT-allow: asserting on the literal token in source, not a call.
            body.contains("speedwave_runtime::consts::data_dir()"),
            "must pass the process-wide data_dir SSOT"
        );
    }

    #[test]
    fn set_provider_model_in_uses_lock_and_saves() {
        let src = include_str!("containers_cmd.rs");
        let start = src
            .find("fn set_provider_model_in(")
            .expect("set_provider_model_in must exist");
        let body = &src[start..src[start..].find("\n}\n").map(|i| start + i).unwrap()];
        assert!(
            body.contains("with_config_lock_in"),
            "must use the data_dir-parameterized config lock"
        );
        assert!(body.contains("save_user_config_to"), "must persist");
        assert!(
            body.contains("apply_set_provider_model"),
            "must delegate to the pure helper"
        );
        assert!(
            body.contains("sync_llm_legacy_fields"),
            "must sync legacy flat fields, like every other LLM config mutation path"
        );
    }

    #[test]
    fn set_provider_model_in_persists_to_injected_data_dir_only() {
        let tmp = seeded_config_tempdir_with_local_model("llama-old");
        let data_dir = tmp.path().to_path_buf();

        set_provider_model_in(
            &data_dir,
            "alpha".to_string(),
            "local".to_string(),
            "llama-new".to_string(),
        )
        .expect("set_provider_model_in must succeed");

        let final_cfg = config::load_user_config_from(&data_dir.join("config.json"))
            .expect("reload injected-dir config");
        let llm = final_cfg
            .find_project("alpha")
            .unwrap()
            .claude
            .as_ref()
            .unwrap()
            .llm
            .as_ref()
            .unwrap();
        assert_eq!(
            llm.providers
                .iter()
                .find(|p| p.id == "local")
                .unwrap()
                .model
                .as_deref(),
            Some("llama-new"),
            "the picked model must persist to the injected tmp config"
        );
    }

    #[test]
    fn set_provider_model_in_syncs_legacy_flat_fields() {
        let tmp = seeded_config_tempdir_with_local_model("llama-old");
        let data_dir = tmp.path().to_path_buf();
        {
            let config_path = data_dir.join("config.json");
            let mut cfg = config::load_user_config_from(&config_path).unwrap();
            {
                let llm = cfg
                    .find_project_mut("alpha")
                    .unwrap()
                    .claude
                    .as_mut()
                    .unwrap()
                    .llm
                    .as_mut()
                    .unwrap();
                llm.proxy_enabled = Some(false);
            }
            config::save_user_config_to(&cfg, &config_path).unwrap();
        }

        set_provider_model_in(
            &data_dir,
            "alpha".to_string(),
            "local".to_string(),
            "llama-new".to_string(),
        )
        .expect("set_provider_model_in must succeed");

        let final_cfg = config::load_user_config_from(&data_dir.join("config.json"))
            .expect("reload injected-dir config");
        let llm = final_cfg
            .find_project("alpha")
            .unwrap()
            .claude
            .as_ref()
            .unwrap()
            .llm
            .as_ref()
            .unwrap();
        assert_eq!(
            llm.provider.as_deref(),
            Some("local"),
            "legacy flat provider field must be synced from the new active entry"
        );
        assert_eq!(
            llm.model.as_deref(),
            Some("llama-new"),
            "legacy flat model field must be synced from the new active entry"
        );
    }

    #[test]
    fn apply_set_provider_model_whitespace_only_model_is_rejected_like_empty() {
        use speedwave_runtime::config::LlmProviderKind as K;
        let mut cfg = cfg_with_providers(
            "local",
            None,
            vec![v2_entry("local", K::Local, Some("http://127.0.0.1:11434"))],
        );
        let err = apply_set_provider_model(&mut cfg, "alpha", "local", "   \t  ").unwrap_err();
        assert!(err.to_string().contains("model"), "got: {err}");
    }

    #[tokio::test]
    async fn update_llm_config_in_whitespace_only_provider_model_still_requires_model() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let data_dir = tmp.path().to_path_buf();
        config::save_user_config_to(
            &make_config_with_active_project(),
            &data_dir.join("config.json"),
        )
        .expect("seed config");

        let update = LlmConfigUpdate {
            provider: Some("local".to_string()),
            model: None,
            providers: Some(vec![speedwave_runtime::config::LlmProviderEntry {
                id: "local".to_string(),
                kind: speedwave_runtime::config::LlmProviderKind::Local,
                base_url: Some("http://127.0.0.1:11434".to_string()),
                model: Some("   ".to_string()),
                has_api_key: false,
                context_tokens: None,
                has_custom_headers: false,
            }]),
            active: Some(speedwave_runtime::config::LlmActive {
                provider_id: "local".to_string(),
                model: None,
            }),
            ..Default::default()
        };

        let err = update_llm_config_in(&data_dir, update)
            .await
            .expect_err("a whitespace-only model must not satisfy the model-required guard");
        assert!(err.contains("requires a model name"), "got: {err}");
    }

    #[test]
    fn active_provider_summary_reflects_effective_active_model() {
        use speedwave_runtime::config::LlmProviderKind as K;
        let mut cfg = make_config_with_active_project();
        let project = cfg.find_project_mut("alpha").unwrap();
        project.claude = Some(ClaudeOverrides {
            env: None,
            settings: None,
            llm: Some(LlmConfig {
                schema_version: Some(config::LLM_SCHEMA_VERSION),
                providers: vec![config::LlmProviderEntry {
                    id: "my-ollama".to_string(),
                    kind: K::Local,
                    base_url: Some("http://host.docker.internal:11434".to_string()),
                    model: Some("my-ollama/llama3.3".to_string()),
                    has_api_key: false,
                    context_tokens: None,
                    has_custom_headers: false,
                }],
                active: Some(config::LlmActive {
                    provider_id: "my-ollama".to_string(),
                    model: Some("my-ollama/llama3.3".to_string()),
                }),
                ..Default::default()
            }),
        });

        let summary = active_provider_summary_from(&cfg, "alpha").unwrap();
        assert_eq!(summary.provider_id, "my-ollama");
        assert_eq!(summary.kind, K::Local);
        assert_eq!(
            summary.model.as_deref(),
            Some("my-ollama/llama3.3"),
            "effective_active_model returns the entry model (provenance)"
        );
        assert_eq!(
            summary.base_url.as_deref(),
            Some("http://host.docker.internal:11434"),
            "local discovery needs the entry's base_url, not the provider_id"
        );
    }

    #[test]
    fn active_provider_summary_none_when_unconfigured() {
        let cfg = make_config_with_active_project();

        let err = active_provider_summary_from(&cfg, "alpha").unwrap_err();
        assert!(err.contains("no active provider"), "got: {err}");
    }

    #[test]
    fn active_provider_summary_rejects_unknown_project() {
        let cfg = make_config_with_active_project();

        let err = active_provider_summary_from(&cfg, "does-not-exist").unwrap_err();
        assert!(err.contains("does-not-exist"), "got: {err}");
    }

    #[test]
    fn canonicalize_provider_base_urls_rewrites_only_local_loopback() {
        use speedwave_runtime::config::LlmProviderKind as K;
        let alias = speedwave_runtime::consts::HOST_GATEWAY_ALIAS;
        let mut providers = vec![
            v2_entry("local", K::Local, Some("http://127.0.0.1:1234")),
            v2_entry("local2", K::Local, Some("http://localhost:11434")),
            v2_entry("remote", K::Local, Some("http://192.168.5.10:1234")),
            v2_entry("anthropic", K::AnthropicOauth, None),
            v2_entry("openrouter", K::OpenRouter, None),
        ];
        canonicalize_provider_base_urls(&mut providers);
        assert_eq!(
            providers[0].base_url.as_deref(),
            Some(format!("http://{alias}:1234/").as_str())
        );
        assert_eq!(
            providers[1].base_url.as_deref(),
            Some(format!("http://{alias}:11434/").as_str())
        );
        assert_eq!(
            providers[2].base_url.as_deref(),
            Some("http://192.168.5.10:1234"),
            "real LAN server must not be rewritten"
        );
        assert_eq!(providers[3].base_url, None);
        assert_eq!(providers[4].base_url, None);
    }

    #[test]
    fn canonicalize_provider_base_urls_is_idempotent() {
        use speedwave_runtime::config::LlmProviderKind as K;
        let alias = speedwave_runtime::consts::HOST_GATEWAY_ALIAS;
        let canonical = format!("http://{alias}:1234/");
        let mut providers = vec![v2_entry("local", K::Local, Some(&canonical))];
        canonicalize_provider_base_urls(&mut providers);
        assert_eq!(providers[0].base_url.as_deref(), Some(canonical.as_str()));
    }

    #[test]
    fn validate_provider_entries_rejects_flag_shaped_model() {
        use speedwave_runtime::config::LlmProviderKind as K;
        let mut entry = v2_entry("openrouter", K::OpenRouter, None);
        entry.model = Some("--dangerously-skip".to_string());
        let err = validate_provider_entries(&[entry]).unwrap_err();
        assert!(err.contains("must not start with '-'"));

        let mut ok = v2_entry("openrouter", K::OpenRouter, None);
        ok.model = Some("deepseek/deepseek-v4-flash".to_string());
        assert!(validate_provider_entries(&[ok]).is_ok());
    }

    #[test]
    fn validate_provider_entries_accepts_a_valid_mix() {
        use speedwave_runtime::config::LlmProviderKind as K;
        let providers = vec![
            v2_entry("anthropic", K::AnthropicOauth, None),
            v2_entry("openrouter", K::OpenRouter, None),
            v2_entry("local", K::Local, Some("http://host.docker.internal:9000")),
        ];
        assert!(validate_provider_entries(&providers).is_ok());
    }

    #[test]
    fn validate_provider_entries_rejects_bad_slug_and_duplicates() {
        use speedwave_runtime::config::LlmProviderKind as K;
        let err =
            validate_provider_entries(&[v2_entry("Bad.Id", K::OpenRouter, None)]).unwrap_err();
        assert!(err.contains("Bad.Id"), "slug error must name the id: {err}");

        let err = validate_provider_entries(&[
            v2_entry("dup", K::OpenRouter, None),
            v2_entry("dup", K::OpenRouter, None),
        ])
        .unwrap_err();
        assert!(err.contains("duplicate"), "got: {err}");
    }

    #[test]
    fn validate_provider_entries_rejects_missing_or_ssrf_url() {
        use speedwave_runtime::config::LlmProviderKind as K;
        let err = validate_provider_entries(&[v2_entry("local", K::Local, None)]).unwrap_err();
        assert!(err.contains("requires a base URL"), "got: {err}");
        assert!(validate_provider_entries(&[v2_entry(
            "local",
            K::Local,
            Some("http://169.254.169.254")
        )])
        .is_err());
        assert!(validate_provider_entries(&[v2_entry(
            "remote",
            K::Local,
            Some("http://user:pass@example.com")
        )])
        .is_err());
    }

    struct FakeProbe(Result<Vec<&'static str>, &'static str>);

    #[async_trait::async_trait]
    impl ModelAutoDefaultProbe for FakeProbe {
        async fn first_local_model(
            &self,
            _entry_id: &str,
            _base_url: &str,
        ) -> Result<String, String> {
            match &self.0 {
                Ok(models) => models
                    .first()
                    .map(|m| m.to_string())
                    .ok_or_else(|| "empty".to_string()),
                Err(e) => Err(e.to_string()),
            }
        }
    }

    #[test]
    fn transient_credential_extracts_only_a_non_empty_value() {
        assert_eq!(transient_credential(&None), None);
        assert_eq!(transient_credential(&Some(None)), None);
        assert_eq!(transient_credential(&Some(Some("  ".into()))), None);
        assert_eq!(
            transient_credential(&Some(Some(" sk-x ".into()))),
            Some("sk-x")
        );
    }

    #[tokio::test]
    async fn live_probe_forwards_the_transient_api_key_a_fresh_save_carries() {
        let mut keyed = mockito::Server::new_async().await;
        let _authed = keyed
            .mock("GET", "/v1/models")
            .match_header("authorization", "Bearer sk-fresh")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"data":[{"id":"first-model"},{"id":"second-model"}]}"#)
            .create_async()
            .await;
        let with_key = LiveModelAutoDefaultProbe {
            active_project: None,
            transient_api_key: Some("sk-fresh"),
            transient_custom_headers: None,
        };
        assert_eq!(
            with_key.first_local_model("local", &keyed.url()).await,
            Ok("first-model".to_string())
        );

        let mut rejecting = mockito::Server::new_async().await;
        let _unauthed = rejecting
            .mock("GET", "/v1/models")
            .with_status(401)
            .create_async()
            .await;
        let without_key = LiveModelAutoDefaultProbe {
            active_project: None,
            transient_api_key: None,
            transient_custom_headers: None,
        };
        assert!(without_key
            .first_local_model("local", &rejecting.url())
            .await
            .is_err());
    }

    #[tokio::test]
    async fn or_entry_without_model_gets_default() {
        use speedwave_runtime::config::LlmProviderKind as K;
        let mut providers = vec![v2_entry("openrouter", K::OpenRouter, None)];
        let probe = FakeProbe(Ok(vec!["unused"]));
        apply_model_auto_defaults(&mut providers, &probe)
            .await
            .unwrap();
        assert_eq!(
            providers[0].model.as_deref(),
            Some(speedwave_runtime::consts::OPENROUTER_DEFAULT_MODEL)
        );
    }

    #[tokio::test]
    async fn local_entry_without_model_uses_first_probe_result() {
        use speedwave_runtime::config::LlmProviderKind as K;
        let mut providers = vec![v2_entry(
            "local",
            K::Local,
            Some("http://host.docker.internal:11434"),
        )];
        let probe = FakeProbe(Ok(vec!["llama-3.3-70b", "llama-3.1-8b"]));
        apply_model_auto_defaults(&mut providers, &probe)
            .await
            .unwrap();
        assert_eq!(providers[0].model.as_deref(), Some("llama-3.3-70b"));
    }

    #[tokio::test]
    async fn local_probe_failure_surfaces_model_required_error() {
        use speedwave_runtime::config::LlmProviderKind as K;
        let mut providers = vec![v2_entry(
            "local",
            K::Local,
            Some("http://host.docker.internal:11434"),
        )];
        let probe = FakeProbe(Err("connection refused"));
        let err = apply_model_auto_defaults(&mut providers, &probe)
            .await
            .unwrap_err();
        assert!(
            err.contains("requires a model name"),
            "must still surface the model-required error, got: {err}"
        );
        assert!(
            err.contains("could not auto-select a model") && err.contains("connection refused"),
            "must enrich the error with the probe failure, got: {err}"
        );
    }

    #[tokio::test]
    async fn explicit_model_never_overwritten() {
        use speedwave_runtime::config::LlmProviderKind as K;
        let mut or_entry = v2_entry("openrouter", K::OpenRouter, None);
        or_entry.model = Some("deepseek/deepseek-v4-flash".to_string());
        let mut local_entry =
            v2_entry("local", K::Local, Some("http://host.docker.internal:11434"));
        local_entry.model = Some("llama-3.1-8b".to_string());
        let mut providers = vec![or_entry, local_entry];
        let probe = FakeProbe(Err("must not be called"));
        apply_model_auto_defaults(&mut providers, &probe)
            .await
            .unwrap();
        assert_eq!(
            providers[0].model.as_deref(),
            Some("deepseek/deepseek-v4-flash")
        );
        assert_eq!(providers[1].model.as_deref(), Some("llama-3.1-8b"));
    }

    #[tokio::test]
    async fn update_llm_config_rejects_dangling_active_provider() {
        use speedwave_runtime::config::LlmProviderKind as K;
        let result = update_llm_config(LlmConfigUpdate {
            providers: Some(vec![v2_entry("openrouter", K::OpenRouter, None)]),
            active: Some(speedwave_runtime::config::LlmActive {
                provider_id: "ghost".to_string(),
                model: None,
            }),
            ..Default::default()
        })
        .await;
        let err = result.unwrap_err();
        assert!(
            err.contains("ghost") && err.contains("not in the provider list"),
            "got: {err}"
        );
    }

    #[test]
    fn clear_active_llm_provider_sets_active_none_via_lock_and_save() {
        let src = include_str!("containers_cmd.rs");
        let start = src
            .find("pub fn clear_active_llm_provider(")
            .expect("clear_active_llm_provider command must exist");
        let body = &src[start..src[start..].find("\n}\n").map(|i| start + i).unwrap()];
        assert!(body.contains("llm.active = None"), "must clear active");
        assert!(
            body.contains("with_config_lock"),
            "must use the config lock"
        );
        assert!(body.contains("save_user_config"), "must persist");
    }

    #[tokio::test]
    async fn update_llm_config_rejects_invalid_v2_entries_before_any_io() {
        use speedwave_runtime::config::LlmProviderKind as K;
        let err = update_llm_config(LlmConfigUpdate {
            providers: Some(vec![v2_entry("UPPER", K::OpenRouter, None)]),
            ..Default::default()
        })
        .await
        .unwrap_err();
        assert!(err.contains("UPPER"), "got: {err}");
    }

    fn active(id: &str, model: Option<&str>) -> speedwave_runtime::config::LlmActive {
        speedwave_runtime::config::LlmActive {
            provider_id: id.to_string(),
            model: model.map(str::to_string),
        }
    }

    #[test]
    fn validate_active_selection_rejects_foreign_model_under_anthropic() {
        use speedwave_runtime::config::LlmProviderKind as K;
        let providers = vec![v2_entry("anthropic", K::AnthropicOauth, None)];
        let err =
            validate_active_selection(&providers, &active("anthropic", Some("nex-agi/x:free")))
                .unwrap_err();
        assert!(err.contains("not an Anthropic model"), "got: {err}");
    }

    #[test]
    fn validate_active_selection_rejects_active_openrouter_without_model() {
        use speedwave_runtime::config::LlmProviderKind as K;
        let providers = vec![v2_entry("openrouter", K::OpenRouter, None)];
        let err = validate_active_selection(&providers, &active("openrouter", None)).unwrap_err();
        assert!(err.contains("requires a model name"), "got: {err}");
    }

    #[test]
    fn validate_active_selection_nonanthropic_requires_entry_model_not_active_only() {
        use speedwave_runtime::config::LlmProviderKind as K;
        let providers = vec![v2_entry("openrouter", K::OpenRouter, None)];
        let err =
            validate_active_selection(&providers, &active("openrouter", Some("z-ai/glm-5.2")))
                .unwrap_err();
        assert!(err.contains("requires a model name"), "got: {err}");
    }

    #[test]
    fn validate_active_selection_inactive_partial_rows_not_forced() {
        use speedwave_runtime::config::LlmProviderKind as K;
        let providers = vec![
            v2_entry("anthropic", K::AnthropicOauth, None),
            v2_entry("openrouter", K::OpenRouter, None),
        ];
        assert!(validate_active_selection(&providers, &active("anthropic", None)).is_ok());
    }

    #[test]
    fn validate_active_selection_accepts_valid_anthropic_and_openrouter() {
        use speedwave_runtime::config::LlmProviderKind as K;
        let providers = vec![v2_entry("anthropic", K::AnthropicOauth, None), {
            let mut e = v2_entry("openrouter", K::OpenRouter, None);
            e.model = Some("z-ai/glm-5.2".to_string());
            e
        }];
        assert!(validate_active_selection(
            &providers,
            &active("anthropic", Some("claude-opus-4-8"))
        )
        .is_ok());
        assert!(
            validate_active_selection(&providers, &active("openrouter", Some("z-ai/glm-5.2")))
                .is_ok()
        );
        assert!(validate_active_selection(&providers, &active("ghost", None)).is_err());
    }

    #[tokio::test]
    async fn update_llm_config_rejects_zero_context_tokens() {
        let result = update_llm_config(LlmConfigUpdate {
            provider: Some("ollama".to_string()),
            model: Some("llama3.3".to_string()),
            base_url: Some("http://localhost:11434".to_string()),
            context_tokens: Some(0),
            api_key: None,
            custom_headers: None,
            ..Default::default()
        })
        .await;
        assert!(result.is_err());
        assert!(
            result.unwrap_err().contains("context_tokens"),
            "error must mention context_tokens"
        );
    }

    #[tokio::test]
    async fn update_llm_config_accepts_model_with_dash_in_middle() {
        let tmp = seeded_config_tempdir();
        let result = update_llm_config_in(
            tmp.path(),
            llm_update("ollama", Some("llama-3.3"), Some("http://localhost:11434")),
        )
        .await;
        if let Err(e) = result {
            assert!(
                !e.to_lowercase().contains("flag collision"),
                "Middle-dash model must not trigger flag-collision guard, got: {e}"
            );
        }
    }

    #[tokio::test]
    async fn update_llm_config_rejects_invalid_base_url() {
        let result = update_llm_config(llm_update(
            "ollama",
            Some("placeholder-model"),
            Some("javascript:alert(1)"),
        ))
        .await;
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            err.to_lowercase().contains("http"),
            "Error must reference the allowed http(s) scheme, got: {err}"
        );
    }

    #[tokio::test]
    async fn update_llm_config_accepts_v1_suffix() {
        let tmp = seeded_config_tempdir();
        let result = update_llm_config_in(
            tmp.path(),
            llm_update(
                "ollama",
                Some("llama3.3"),
                Some("http://localhost:11434/v1"),
            ),
        )
        .await;
        if let Err(err) = result {
            assert!(
                !err.contains("must not contain a path"),
                "`/v1` suffix must be stripped before validation, got: {err}"
            );
        }
    }

    async fn url_rejection_err(url: &str) -> String {
        update_llm_config(llm_update("ollama", Some("placeholder-model"), Some(url)))
            .await
            .unwrap_err()
    }

    #[tokio::test]
    async fn update_llm_config_rejects_metadata_ip() {
        let err = url_rejection_err("http://169.254.169.254:8080").await;
        assert!(
            err.to_lowercase().contains("private") || err.to_lowercase().contains("reserved"),
            "metadata IP must be rejected with a private/reserved error, got: {err}"
        );
    }

    #[tokio::test]
    async fn update_llm_config_rejects_link_local_ipv6() {
        let err = url_rejection_err("http://[fe80::1]").await;
        assert!(
            err.to_lowercase().contains("private") || err.to_lowercase().contains("reserved"),
            "IPv6 link-local must be rejected, got: {err}"
        );
    }

    #[tokio::test]
    async fn update_llm_config_rejects_credentials() {
        let err = url_rejection_err("http://user:pass@localhost:11434").await;
        assert!(
            err.to_lowercase().contains("credentials"),
            "embedded credentials must be rejected, got: {err}"
        );
    }

    #[tokio::test]
    async fn update_llm_config_rejects_query_string() {
        let err = url_rejection_err("http://localhost:11434?foo=bar").await;
        assert!(
            err.to_lowercase().contains("query"),
            "query string must be rejected, got: {err}"
        );
    }

    #[tokio::test]
    async fn update_llm_config_accepts_loopback_via_validation() {
        let tmp = seeded_config_tempdir();
        let result = update_llm_config_in(
            tmp.path(),
            llm_update("ollama", Some("llama3.3"), Some("http://127.0.0.1:11434")),
        )
        .await;
        if let Err(err) = result {
            assert!(
                !err.to_lowercase().contains("private")
                    && !err.to_lowercase().contains("blocked")
                    && !err.to_lowercase().contains("credentials"),
                "loopback must NOT be rejected by URL validation, got: {err}"
            );
        }
    }

    #[tokio::test]
    async fn update_llm_config_accepts_rfc1918_via_validation() {
        let tmp = seeded_config_tempdir();
        let result = update_llm_config_in(
            tmp.path(),
            llm_update(
                "ollama",
                Some("llama3.3"),
                Some("http://192.168.1.50:11434"),
            ),
        )
        .await;
        if let Err(err) = result {
            assert!(
                !err.to_lowercase().contains("private") && !err.to_lowercase().contains("blocked"),
                "RFC1918 must NOT be rejected by URL validation, got: {err}"
            );
        }
    }

    #[tokio::test]
    async fn update_llm_config_accepts_public_domain_via_validation() {
        let tmp = seeded_config_tempdir();
        let result = update_llm_config_in(
            tmp.path(),
            llm_update("ollama", Some("x"), Some("http://my-ollama.company.com")),
        )
        .await;
        if let Err(err) = result {
            assert!(
                !err.to_lowercase().contains("blocked"),
                "public domain must NOT be rejected by URL validation, got: {err}"
            );
        }
    }

    #[test]
    fn get_default_base_url_returns_ollama_url() {
        let result = get_default_base_url("ollama".to_string()).unwrap();
        assert_eq!(
            result,
            Some("http://host.docker.internal:11434".to_string())
        );
    }

    #[test]
    fn get_default_base_url_returns_lmstudio_url() {
        let result = get_default_base_url("lmstudio".to_string()).unwrap();
        assert_eq!(result, Some("http://host.docker.internal:1234".to_string()));
    }

    #[test]
    fn get_default_base_url_returns_llamacpp_url() {
        let result = get_default_base_url("llamacpp".to_string()).unwrap();
        assert_eq!(result, Some("http://host.docker.internal:8080".to_string()));
    }

    #[test]
    fn get_default_base_url_returns_none_for_anthropic() {
        let result = get_default_base_url("anthropic".to_string()).unwrap();
        assert_eq!(result, None);
    }

    #[test]
    fn get_default_base_url_returns_none_for_unknown_provider() {
        let result = get_default_base_url("openai".to_string()).unwrap();
        assert_eq!(result, None);
    }

    #[test]
    fn get_openrouter_default_model_returns_the_consts_ssot() {
        assert_eq!(
            get_openrouter_default_model(),
            speedwave_runtime::consts::OPENROUTER_DEFAULT_MODEL
        );
    }

    #[test]
    fn project_llm_is_unconfigured_in_true_for_fresh_project() {
        let cfg = make_config_with_active_project();
        let result = project_llm_is_unconfigured_in(&cfg, "alpha");
        assert_eq!(result, Ok(true));
    }

    #[test]
    fn project_llm_is_unconfigured_in_false_for_configured_provider() {
        let cfg = make_config_with_active_project();
        let result = project_llm_is_unconfigured_in(&cfg, "beta");
        assert_eq!(result, Ok(false));
    }

    #[test]
    fn project_llm_is_unconfigured_in_errors_for_unknown_project() {
        let cfg = make_config_with_active_project();
        let result = project_llm_is_unconfigured_in(&cfg, "ghost");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not found"));
    }

    use speedwave_runtime::runtime::mock_runtime::MockRuntimeBuilder;

    #[test]
    fn teardown_only_ok() {
        let (rt, handles) = MockRuntimeBuilder::new().build();
        let result = teardown_only("new_proj", &rt);
        assert!(result.is_none());
        assert_eq!(handles.down_projects(), vec!["new_proj"]);
    }

    #[test]
    fn teardown_only_fails() {
        let (rt, _handles) = MockRuntimeBuilder::new()
            .with_fail_on_down(&["new_proj"])
            .build();
        let result = teardown_only("new_proj", &rt);
        assert!(result.is_some());
        let msg = result.unwrap();
        assert!(
            msg.contains("teardown of 'new_proj' failed"),
            "expected teardown msg, got: {msg}"
        );
    }

    fn ok_recreate(
        _proj: &str,
        _rt: &speedwave_runtime::runtime::LockedRuntime,
    ) -> Result<(), String> {
        Ok(())
    }

    fn fail_recreate(
        _proj: &str,
        _rt: &speedwave_runtime::runtime::LockedRuntime,
    ) -> Result<(), String> {
        Err("recreate failed".to_string())
    }

    const LEAKY_ENGINE_ERROR: &str = "limactl failed: time=\"2026-09-16T10:00:00+02:00\" level=fatal msg=\"failed to run [nerdctl run -e=MCP_X_AUTH_TOKEN=abc image]: exit status 1\"";

    #[test]
    fn switch_core_redacts_worker_auth_tokens_from_the_start_error() {
        let (rt, handles) = MockRuntimeBuilder::new().build();
        let result = switch_project_core(&None, "new", &rt, &|_proj, _rt| {
            Err(LEAKY_ENGINE_ERROR.to_string())
        });
        match result {
            SwitchResult::Failed {
                error,
                cleanup_error,
            } => {
                assert!(!error.contains("MCP_X_AUTH_TOKEN=abc"), "leaked: {error}");
                assert!(
                    error.starts_with("limactl failed: time="),
                    "engine detail must survive: {error}"
                );
                assert!(
                    error.contains("MCP_X_AUTH_TOKEN=***REDACTED***"),
                    "got: {error}"
                );
                assert!(cleanup_error.is_none(), "got: {cleanup_error:?}");
            }
            SwitchResult::Succeeded { .. } => panic!("expected Failed"),
        }
        assert_eq!(handles.down_projects(), vec!["new"]);
    }

    #[test]
    fn switch_core_redacts_worker_auth_tokens_from_the_runtime_not_ready_error() {
        let (rt, handles) = MockRuntimeBuilder::new()
            .with_ensure_ready_error(LEAKY_ENGINE_ERROR)
            .build();
        let prev = Some("prev".to_string());
        let result = switch_project_core(&prev, "new", &rt, &ok_recreate);
        match result {
            SwitchResult::Failed {
                error,
                cleanup_error,
            } => {
                assert!(
                    error.starts_with("Runtime not ready: limactl failed: "),
                    "got: {error}"
                );
                assert!(!error.contains("MCP_X_AUTH_TOKEN=abc"), "leaked: {error}");
                assert!(cleanup_error.is_none(), "got: {cleanup_error:?}");
            }
            SwitchResult::Succeeded { .. } => panic!("expected Failed"),
        }
        assert!(handles.down_projects().is_empty());
    }

    #[test]
    fn switch_result_failed_redacts_the_cleanup_error_too() {
        let result = SwitchResult::failed(
            "start failed".to_string(),
            Some(format!("teardown of 'new' failed: {LEAKY_ENGINE_ERROR}")),
        );
        match result {
            SwitchResult::Failed {
                error,
                cleanup_error,
            } => {
                assert_eq!(error, "start failed");
                let cleanup = cleanup_error.expect("cleanup error must be kept");
                assert!(
                    cleanup.starts_with("teardown of 'new' failed: limactl failed: "),
                    "got: {cleanup}"
                );
                assert!(
                    !cleanup.contains("MCP_X_AUTH_TOKEN=abc"),
                    "leaked: {cleanup}"
                );
            }
            SwitchResult::Succeeded { .. } => panic!("expected Failed"),
        }
    }

    #[test]
    fn switch_result_failed_keeps_a_missing_cleanup_error_absent() {
        match SwitchResult::failed("plain".to_string(), None) {
            SwitchResult::Failed {
                error,
                cleanup_error,
            } => {
                assert_eq!(error, "plain");
                assert!(cleanup_error.is_none());
            }
            SwitchResult::Succeeded { .. } => panic!("expected Failed"),
        }
    }

    #[test]
    fn switch_core_happy_path_with_previous() {
        let (rt, handles) = MockRuntimeBuilder::new().build();
        let prev = Some("prev".to_string());
        let result = switch_project_core(&prev, "new", &rt, &ok_recreate);
        match result {
            SwitchResult::Succeeded { teardown } => assert_eq!(teardown.as_deref(), Some("prev")),
            SwitchResult::Failed { error, .. } => panic!("expected Succeeded, got: {error}"),
        }
        assert!(handles.down_projects().is_empty());
    }

    #[test]
    fn switch_core_brings_destination_up_without_recreate() {
        let (rt, handles) = MockRuntimeBuilder::new().build();
        let prev = Some("prev".to_string());
        let up_closure =
            |proj: &str, rt: &speedwave_runtime::runtime::LockedRuntime| -> Result<(), String> {
                rt.compose_up(proj).map_err(|e| e.to_string())
            };

        let result = switch_project_core(&prev, "new", &rt, &up_closure);

        match result {
            SwitchResult::Succeeded { teardown } => assert_eq!(teardown.as_deref(), Some("prev")),
            SwitchResult::Failed { error, .. } => panic!("expected Succeeded, got: {error}"),
        }
        assert!(
            handles.down_projects().is_empty(),
            "previous is torn down in the background, not in core"
        );
        assert_eq!(
            handles.up_projects(),
            vec!["new"],
            "destination brought up via compose_up"
        );
        assert!(
            !handles.was_recreated(),
            "switch must not force-recreate (config-hash handles changes)"
        );
    }

    #[test]
    fn switch_core_happy_path_no_previous() {
        let (rt, handles) = MockRuntimeBuilder::new().build();
        let result = switch_project_core(&None, "new", &rt, &ok_recreate);
        match result {
            SwitchResult::Succeeded { teardown } => assert!(teardown.is_none()),
            SwitchResult::Failed { error, .. } => panic!("expected Succeeded, got: {error}"),
        }
        assert!(handles.down_projects().is_empty());
    }

    #[test]
    fn switch_core_happy_path_same_project() {
        let (rt, handles) = MockRuntimeBuilder::new().build();
        let prev = Some("same".to_string());
        let result = switch_project_core(&prev, "same", &rt, &ok_recreate);
        match result {
            SwitchResult::Succeeded { teardown } => assert!(teardown.is_none()),
            SwitchResult::Failed { error, .. } => panic!("expected Succeeded, got: {error}"),
        }
        assert!(handles.down_projects().is_empty());
    }

    #[test]
    fn switch_core_ensure_ready_fails() {
        let (rt, handles) = MockRuntimeBuilder::new()
            .with_ensure_ready_error("VM not ready")
            .build();
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
            SwitchResult::Succeeded { .. } => panic!("expected Failed"),
        }
        assert!(handles.down_projects().is_empty());
        assert!(handles.up_projects().is_empty());
    }

    #[test]
    fn switch_core_recreate_fails_with_previous() {
        let (rt, handles) = MockRuntimeBuilder::new().build();
        let prev = Some("prev".to_string());
        let result = switch_project_core(&prev, "new", &rt, &fail_recreate);
        match result {
            SwitchResult::Failed {
                ref error,
                ref cleanup_error,
            } => {
                assert!(error.contains("recreate failed"), "got: {error}");
                assert!(cleanup_error.is_none(), "got: {cleanup_error:?}");
            }
            SwitchResult::Succeeded { .. } => panic!("expected Failed"),
        }
        assert_eq!(handles.down_projects(), vec!["new"]);
        assert!(handles.up_projects().is_empty());
    }

    #[test]
    fn switch_core_recreate_fails_teardown_fails() {
        let (rt, handles) = MockRuntimeBuilder::new()
            .with_fail_on_down(&["new"])
            .build();
        let prev = Some("prev".to_string());
        let result = switch_project_core(&prev, "new", &rt, &fail_recreate);
        match result {
            SwitchResult::Failed {
                ref error,
                ref cleanup_error,
            } => {
                assert!(error.contains("recreate failed"), "got: {error}");
                let ce = cleanup_error.as_ref().expect("should have cleanup_error");
                assert!(ce.contains("teardown of 'new' failed"), "got: {ce}");
            }
            SwitchResult::Succeeded { .. } => panic!("expected Failed"),
        }
        assert!(handles.up_projects().is_empty());
    }

    #[test]
    fn switch_core_recreate_fails_no_previous() {
        let (rt, handles) = MockRuntimeBuilder::new().build();
        let result = switch_project_core(&None, "new", &rt, &fail_recreate);
        match result {
            SwitchResult::Failed {
                ref error,
                ref cleanup_error,
            } => {
                assert!(error.contains("recreate failed"), "got: {error}");
                assert!(cleanup_error.is_none(), "got: {cleanup_error:?}");
            }
            SwitchResult::Succeeded { .. } => panic!("expected Failed"),
        }
        assert_eq!(handles.down_projects(), vec!["new"]);
        assert!(handles.up_projects().is_empty());
    }

    #[test]
    fn switch_core_recreate_fails_via_closure_with_previous() {
        let (rt, handles) = MockRuntimeBuilder::new().build();
        let prev = Some("prev".to_string());
        let result = switch_project_core(&prev, "new", &rt, &|_proj, _rt| {
            Err("render error".to_string())
        });
        match result {
            SwitchResult::Failed { ref error, .. } => {
                assert!(error.contains("render error"), "got: {error}");
            }
            SwitchResult::Succeeded { .. } => panic!("expected Failed"),
        }
        assert_eq!(handles.down_projects(), vec!["new"]);
        assert!(handles.up_projects().is_empty());
    }

    #[test]
    fn switch_core_recreate_fails_via_closure_no_previous() {
        let (rt, handles) = MockRuntimeBuilder::new().build();
        let result = switch_project_core(&None, "new", &rt, &|_proj, _rt| {
            Err("render error".to_string())
        });
        match result {
            SwitchResult::Failed { ref error, .. } => {
                assert!(error.contains("render error"), "got: {error}");
            }
            SwitchResult::Succeeded { .. } => panic!("expected Failed"),
        }
        assert_eq!(handles.down_projects(), vec!["new"]);
        assert!(handles.up_projects().is_empty());
    }

    #[test]
    #[serial_test::serial(teardown_intents)]
    fn background_teardown_runs_down_and_wait_joins_it() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;
        let done = Arc::new(AtomicBool::new(false));
        let done_clone = done.clone();
        spawn_background_teardown_with("bg-test-proj".to_string(), move |p| {
            assert_eq!(p, "bg-test-proj");
            std::thread::sleep(std::time::Duration::from_millis(50));
            done_clone.store(true, Ordering::SeqCst);
            Ok(())
        });
        wait_for_pending_teardown("bg-test-proj");
        assert!(done.load(Ordering::SeqCst));
        assert!(!pending_teardowns_lock().contains_key("bg-test-proj"));
    }

    #[test]
    #[serial_test::serial(teardown_intents)]
    fn background_teardown_failure_does_not_panic_wait() {
        spawn_background_teardown_with("bg-fail-proj".to_string(), |_p| {
            Err("compose down failed".to_string())
        });
        wait_for_pending_teardown("bg-fail-proj");
        assert!(!pending_teardowns_lock().contains_key("bg-fail-proj"));
    }

    #[test]
    fn teardown_intent_recorded_and_cleared_on_success() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().to_path_buf();
        let project = format!("intent-ok-{}", std::process::id());
        spawn_background_teardown_with_in(data_dir.clone(), project.clone(), |_p| Ok(()));
        wait_for_pending_teardown(&project);
        assert!(!crashed_teardown_intents_in(&data_dir).contains(&project));
    }

    #[test]
    fn teardown_intent_survives_failed_teardown_for_next_launch() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().to_path_buf();
        let project = format!("intent-fail-{}", std::process::id());
        spawn_background_teardown_with_in(data_dir.clone(), project.clone(), |_p| {
            Err("down failed".to_string())
        });
        wait_for_pending_teardown(&project);
        assert!(crashed_teardown_intents_in(&data_dir).contains(&project));
        clear_teardown_intent_in(&data_dir, &project);
        assert!(!crashed_teardown_intents_in(&data_dir).contains(&project));
    }

    #[test]
    fn wait_for_pending_teardown_is_noop_without_entry() {
        wait_for_pending_teardown("bg-absent-proj");
    }

    #[test]
    fn teardown_intent_write_is_durable_atomic_rename() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().to_path_buf();
        let project = format!("intent-atomic-{}", std::process::id());
        record_teardown_intent_in(&data_dir, &project);
        let path = teardown_intents_path_in(&data_dir);
        let content = std::fs::read_to_string(&path).unwrap();
        assert!(content.lines().any(|l| l == project));
        let stray = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .filter_map(Result::ok)
            .any(|e| e.file_name().to_string_lossy().starts_with("write-"));
        assert!(!stray, "no tempfile should remain after atomic rename");
        clear_teardown_intent_in(&data_dir, &project);
    }

    #[cfg(unix)]
    #[test]
    fn teardown_intents_file_is_not_owner_restricted() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().to_path_buf();
        let project = format!("intent-perm-{}", std::process::id());
        record_teardown_intent_in(&data_dir, &project);
        let path = teardown_intents_path_in(&data_dir);
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o644, "shared intents file must stay world-readable");
        clear_teardown_intent_in(&data_dir, &project);
    }

    #[test]
    fn background_teardown_replaces_stale_entry_for_same_project() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().to_path_buf();
        spawn_background_teardown_with_in(data_dir.clone(), "bg-dup-proj".to_string(), |_p| Ok(()));
        spawn_background_teardown_with_in(data_dir, "bg-dup-proj".to_string(), |_p| Ok(()));
        wait_for_pending_teardown("bg-dup-proj");
        assert!(!pending_teardowns_lock().contains_key("bg-dup-proj"));
    }

    #[test]
    #[serial_test::serial(teardown_intents)]
    fn replacing_a_live_teardown_does_not_join_it_under_the_registry_lock() {
        use std::sync::mpsc;
        use std::time::Duration;
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().to_path_buf();
        let project = format!("bg-live-dup-{}", std::process::id());

        let (started_tx, started_rx) = mpsc::channel();
        let (go_tx, go_rx) = mpsc::channel::<()>();
        spawn_background_teardown_with_in(data_dir.clone(), project.clone(), move |_p| {
            started_tx.send(()).ok();
            go_rx.recv().ok();
            drop(pending_teardowns_lock());
            Ok(())
        });
        started_rx
            .recv_timeout(Duration::from_secs(10))
            .expect("first teardown must start");

        let (done_tx, done_rx) = mpsc::channel();
        let replacing_dir = data_dir.clone();
        let replacing_project = project.clone();
        let replacing = std::thread::spawn(move || {
            spawn_background_teardown_with_in(replacing_dir, replacing_project, |_p| Ok(()));
            done_tx.send(()).ok();
        });
        std::thread::sleep(Duration::from_millis(100));
        go_tx.send(()).ok();

        let finished = done_rx.recv_timeout(Duration::from_secs(10)).is_ok();
        if finished {
            replacing.join().expect("replacing thread must not panic");
            wait_for_pending_teardown(&project);
        }
        assert!(
            finished,
            "replacing a still-running teardown must release the registry lock before joining it"
        );
    }

    #[test]
    fn build_script_hashes_the_staged_context_through_the_ssot_resolver() {
        let source = include_str!("../build.rs");
        assert!(
            source.contains("bundle::hash_inputs_resolvable(&build_context)"),
            "the hash root must be decided by bundle::hash_inputs_resolvable"
        );
        assert!(
            !source.contains(".join(input).exists()"),
            "a direct-path existence check misses the vendored containers/ layout and hashes \
             the repo root while the image builds from the staged tree"
        );
    }

    #[test]
    fn add_project_builds_missing_images_before_start() {
        let source = include_str!("containers_cmd.rs");
        let fn_start = source
            .find("pub async fn add_project(")
            .expect("add_project must exist");
        let body = &source[fn_start..];
        let build_pos = body
            .find("ensure_project_images_built")
            .expect("add_project closure must build project images");
        let start_pos = body
            .find("start_containers(proj)")
            .expect("add_project closure must call start_containers");
        assert!(
            build_pos < start_pos,
            "image build must precede start_containers (ADR-057/066)"
        );
    }

    #[test]
    fn check_containers_running_checks_compose_file_before_compose_ps() {
        let source = include_str!("containers_cmd.rs");
        let fn_start = source
            .find("pub async fn check_containers_running(")
            .expect("check_containers_running must exist");
        let body = &source[fn_start..];
        let exists_pos = body
            .find("project_has_compose_file(&project)")
            .expect("check_containers_running must probe compose.yml via the runtime SSOT helper");
        let ps_pos = body
            .find("rt.compose_ps(&project)")
            .expect("check_containers_running must call compose_ps");
        assert!(
            exists_pos < ps_pos,
            "compose.yml existence check must precede compose_ps"
        );
    }

    #[test]
    fn add_project_checks_no_provider_before_start() {
        let source = include_str!("containers_cmd.rs");
        let fn_start = source
            .find("pub async fn add_project(")
            .expect("add_project must exist");
        let body = &source[fn_start..];
        let check_pos = body
            .find("project_llm_is_unconfigured(proj)")
            .expect("add_project closure must pre-check for a missing provider");
        let start_pos = body
            .find("start_containers(proj)")
            .expect("add_project closure must call start_containers");
        assert!(
            check_pos < start_pos,
            "no-provider check must precede start_containers"
        );
    }

    fn add_project_recreate(
        proj: &str,
        rt: &speedwave_runtime::runtime::LockedRuntime,
    ) -> Result<(), String> {
        rt.compose_up(proj).map_err(|e| e.to_string())
    }

    fn add_project_recreate_fail(
        _proj: &str,
        _rt: &speedwave_runtime::runtime::LockedRuntime,
    ) -> Result<(), String> {
        Err("start_containers failed".to_string())
    }

    #[test]
    fn add_project_ensure_ready_fails() {
        let (rt, handles) = MockRuntimeBuilder::new()
            .with_ensure_ready_error("VM not ready")
            .build();
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
            SwitchResult::Succeeded { .. } => panic!("expected Failed"),
        }
        assert!(
            handles.down_projects().is_empty(),
            "no compose calls when VM fails"
        );
        assert!(handles.up_projects().is_empty());
    }

    #[test]
    fn add_project_happy_path_with_previous() {
        let (rt, handles) = MockRuntimeBuilder::new().build();
        let prev = Some("prev".to_string());
        let result = switch_project_core(&prev, "new", &rt, &add_project_recreate);
        match result {
            SwitchResult::Succeeded { teardown } => assert_eq!(teardown.as_deref(), Some("prev")),
            SwitchResult::Failed { error, .. } => panic!("expected Succeeded, got: {error}"),
        }
        assert!(handles.down_projects().is_empty());
        assert_eq!(handles.up_projects(), vec!["new"]);
    }

    #[test]
    fn add_project_start_containers_fails_previous_untouched() {
        let (rt, handles) = MockRuntimeBuilder::new().build();
        let prev = Some("prev".to_string());
        let result = switch_project_core(&prev, "new", &rt, &add_project_recreate_fail);
        match result {
            SwitchResult::Failed {
                ref error,
                ref cleanup_error,
            } => {
                assert!(error.contains("start_containers failed"), "got: {error}");
                assert!(cleanup_error.is_none(), "got: {cleanup_error:?}");
            }
            SwitchResult::Succeeded { .. } => panic!("expected Failed"),
        }
        assert_eq!(handles.down_projects(), vec!["new"]);
        assert!(handles.up_projects().is_empty());
    }

    #[test]
    fn add_project_happy_path_no_previous() {
        let (rt, handles) = MockRuntimeBuilder::new().build();
        let result = switch_project_core(&None, "new", &rt, &add_project_recreate);
        match result {
            SwitchResult::Succeeded { teardown } => assert!(teardown.is_none()),
            SwitchResult::Failed { error, .. } => panic!("expected Succeeded, got: {error}"),
        }
        assert!(handles.down_projects().is_empty());
        assert_eq!(handles.up_projects(), vec!["new"]);
    }

    #[test]
    fn add_project_skips_start_when_no_provider_configured() {
        let (rt, handles) = MockRuntimeBuilder::new().build();
        let cfg = make_config_with_active_project();
        let prev = Some("prev".to_string());
        let recreate = |proj: &str, _rt: &speedwave_runtime::runtime::LockedRuntime| {
            if project_llm_is_unconfigured_in(&cfg, proj).unwrap_or(false) {
                return Ok(());
            }
            panic!("test project must be unconfigured");
        };
        let result = switch_project_core(&prev, "alpha", &rt, &recreate);
        match result {
            SwitchResult::Succeeded { teardown } => assert_eq!(teardown.as_deref(), Some("prev")),
            SwitchResult::Failed { error, .. } => panic!("expected Succeeded, got: {error}"),
        }
        assert!(
            handles.down_projects().is_empty(),
            "no-provider path must never attempt teardown"
        );
        assert!(
            handles.up_projects().is_empty(),
            "no-provider path must never attempt compose_up"
        );
    }

    #[test]
    fn ensure_images_ready_passes_through_when_ready() {
        let result = ensure_images_ready();
        assert!(result.is_ok());
    }

    #[test]
    fn test_run_system_check_calls_check_os_warnings() {
        let source = include_str!("containers_cmd.rs");
        let fn_start = source
            .find("pub async fn run_system_check()")
            .expect("run_system_check function must exist");
        let fn_body = &source[fn_start..];
        assert!(
            fn_body.contains("check_os_warnings"),
            "run_system_check must call check_os_warnings()"
        );
    }

    #[test]
    fn start_containers_refreshes_tray_after_setup_completes() {
        let source = include_str!("containers_cmd.rs");
        let fn_start = source
            .find("pub async fn start_containers(")
            .expect("start_containers function must exist");
        let fn_body = &source[fn_start..];
        let next_fn = fn_body[1..]
            .find("\npub ")
            .map(|i| i + 1)
            .unwrap_or(fn_body.len());
        let fn_body = &fn_body[..next_fn];
        assert!(
            fn_body.contains("tray::refresh_tray_menu"),
            "start_containers must call crate::tray::refresh_tray_menu so the \
             ADR-058 beta toggle appears after the wizard's final step"
        );
    }

    #[test]
    fn create_project_does_not_refresh_tray_prematurely() {
        let source = include_str!("containers_cmd.rs");
        let fn_start = source
            .find("pub async fn create_project(")
            .expect("create_project function must exist");
        let fn_body = &source[fn_start..];
        let next_fn = fn_body[1..]
            .find("\npub ")
            .map(|i| i + 1)
            .unwrap_or(fn_body.len());
        let fn_body = &fn_body[..next_fn];
        assert!(
            !fn_body.contains("tray::refresh_tray_menu"),
            "create_project must not call refresh_tray_menu — at that point \
             is_setup_complete() is still false (containers_started is set \
             later by start_containers)"
        );
    }

    #[test]
    fn start_containers_eager_starts_host_workers_before_compose() {
        for cmd in [
            "pub async fn start_containers(",
            "pub async fn add_project(",
        ] {
            let source = include_str!("containers_cmd.rs");
            let fn_start = source.find(cmd).expect("command function must exist");
            let fn_body = &source[fn_start..];
            let next_fn = fn_body[1..]
                .find("\npub ")
                .map(|i| i + 1)
                .unwrap_or(fn_body.len());
            let fn_body = &fn_body[..next_fn];
            let oauth = fn_body
                .find("ensure_oauth_running(")
                .unwrap_or_else(|| panic!("{cmd} must call ensure_oauth_running"));
            let compose_start = fn_body
                .find("setup_wizard::start_containers(")
                .unwrap_or_else(|| panic!("{cmd} must call setup_wizard::start_containers"));
            assert!(
                oauth < compose_start,
                "{cmd}: host workers must start before setup_wizard::start_containers"
            );
        }
    }

    #[test]
    fn validate_api_key_accepts_normal_value() {
        let r = super::validate_api_key("sk-test-abcdef0123").unwrap();
        assert_eq!(r, "sk-test-abcdef0123");
    }

    #[test]
    fn validate_api_key_strips_bearer_prefix() {
        let r = super::validate_api_key("Bearer sk-test").unwrap();
        assert_eq!(r, "sk-test", "leading 'Bearer ' must be stripped");
    }

    #[test]
    fn validate_api_key_strips_bearer_case_insensitive() {
        let r = super::validate_api_key("bearer sk-x").unwrap();
        assert_eq!(r, "sk-x");
        let r = super::validate_api_key("BEARER sk-y").unwrap();
        assert_eq!(r, "sk-y");
    }

    #[test]
    fn validate_api_key_trims_whitespace() {
        let r = super::validate_api_key("  sk-trim  ").unwrap();
        assert_eq!(r, "sk-trim");
    }

    #[test]
    fn validate_api_key_rejects_newline() {
        assert!(super::validate_api_key("sk-test\nfoo").is_err());
        assert!(super::validate_api_key("sk-test\rfoo").is_err());
    }

    #[test]
    fn validate_api_key_rejects_bearer_prefix_with_no_token() {
        let err = super::validate_api_key("Bearer ").unwrap_err();
        assert!(
            err.contains("'Bearer '"),
            "error must mention the Bearer prefix: {err}"
        );
        assert!(super::validate_api_key("bearer  ").is_err());
        assert!(super::validate_api_key("BEARER  \t").is_err());
    }

    #[test]
    fn validate_api_key_empty_input_returns_empty_string() {
        assert_eq!(super::validate_api_key("").unwrap(), "");
        assert_eq!(super::validate_api_key("   ").unwrap(), "");
    }

    #[test]
    fn validate_api_key_rejects_oversize() {
        let oversize = "x".repeat(64 * 1024 + 1);
        assert!(super::validate_api_key(&oversize).is_err());
    }

    #[test]
    fn validate_api_key_accepts_at_size_limit() {
        let at_limit = "x".repeat(64 * 1024);
        assert!(super::validate_api_key(&at_limit).is_ok());
    }

    #[test]
    fn validate_custom_headers_accepts_multiline() {
        let r = super::validate_custom_headers("X-Foo: bar\nX-Baz: qux").unwrap();
        assert!(r.contains("X-Foo"));
        assert!(r.contains("X-Baz"));
    }

    #[test]
    fn validate_custom_headers_accepts_empty_lines() {
        super::validate_custom_headers("X-Foo: bar\n\nX-Baz: qux").unwrap();
    }

    #[test]
    fn validate_custom_headers_rejects_authorization() {
        let err = super::validate_custom_headers("Authorization: Bearer x").unwrap_err();
        assert!(
            err.to_lowercase().contains("authorization"),
            "error must mention forbidden header: {err}"
        );
    }

    #[test]
    fn validate_custom_headers_rejects_cookie() {
        assert!(super::validate_custom_headers("Cookie: sid=abc").is_err());
    }

    #[test]
    fn validate_custom_headers_rejects_host() {
        assert!(super::validate_custom_headers("Host: evil.com").is_err());
    }

    #[test]
    fn validate_custom_headers_rejects_carriage_return() {
        assert!(super::validate_custom_headers("X-Foo: bar\r\nX-Evil: yes").is_err());
    }

    #[test]
    fn validate_custom_headers_rejects_missing_colon() {
        assert!(super::validate_custom_headers("X-Foo bar").is_err());
    }

    #[test]
    fn validate_custom_headers_rejects_empty_value() {
        assert!(super::validate_custom_headers("X-Foo:").is_err());
        assert!(super::validate_custom_headers("X-Foo:    ").is_err());
    }

    #[test]
    fn validate_custom_headers_rejects_invalid_name_chars() {
        assert!(super::validate_custom_headers("X Foo: bar").is_err());
        assert!(super::validate_custom_headers("X(Foo): bar").is_err());
        assert!(super::validate_custom_headers("X@Foo: bar").is_err());
    }

    #[test]
    fn validate_custom_headers_accepts_full_rfc7230_token_chars() {
        super::validate_custom_headers("X_Trace_Id: abc").unwrap();
        super::validate_custom_headers("X.Trace-Id: abc").unwrap();
        super::validate_custom_headers("X-Custom!Header: abc").unwrap();
    }

    #[test]
    fn validate_custom_headers_rejects_oversize() {
        let oversize = format!("X-A: {}", "x".repeat(16 * 1024));
        assert!(super::validate_custom_headers(&oversize).is_err());
    }

    use std::cell::RefCell;

    fn ok_check(_: &str) -> Result<(), String> {
        Ok(())
    }

    #[test]
    fn remove_project_core_happy_path() {
        let (rt, handles) = MockRuntimeBuilder::new().build();
        let removed = RefCell::new(Vec::<String>::new());
        let result = remove_project_core("alpha", &rt, &ok_check, &|n| {
            removed.borrow_mut().push(n.to_string());
            Ok(())
        });
        assert!(result.is_ok(), "{result:?}");
        assert_eq!(handles.ensure_ready_count(), 1);
        assert_eq!(handles.down_projects(), vec!["alpha"]);
        assert_eq!(*removed.borrow(), vec!["alpha"]);
    }

    #[test]
    fn remove_project_core_starts_a_stopped_engine_before_teardown() {
        let (rt, handles) = MockRuntimeBuilder::new().with_is_available(false).build();
        let removed = RefCell::new(Vec::<String>::new());
        let result = remove_project_core("alpha", &rt, &ok_check, &|n| {
            removed.borrow_mut().push(n.to_string());
            Ok(())
        });
        assert!(result.is_ok(), "{result:?}");
        assert_eq!(handles.ensure_ready_count(), 1);
        assert_eq!(handles.down_projects(), vec!["alpha"]);
        assert_eq!(*removed.borrow(), vec!["alpha"]);
    }

    #[test]
    fn remove_project_core_unready_engine_keeps_the_project() {
        let (rt, handles) = MockRuntimeBuilder::new()
            .with_ensure_ready_error(
                "Lima VM 'speedwave' not found. Run Speedwave.app setup wizard to create it.",
            )
            .build();
        let remove_calls = RefCell::new(0u32);
        let result = remove_project_core("alpha", &rt, &ok_check, &|_| {
            *remove_calls.borrow_mut() += 1;
            Ok(())
        });
        let err = result.unwrap_err();
        assert!(
            err.contains("Failed to start the container engine to clean up 'alpha'")
                && err.contains("not found"),
            "expected user-facing engine-start error, got: {err}"
        );
        assert!(handles.down_projects().is_empty());
        assert_eq!(
            *remove_calls.borrow(),
            0,
            "config wipe must not run when the teardown is impossible"
        );
    }

    #[test]
    fn remove_project_core_rejects_before_touching_the_engine() {
        let (rt, handles) = MockRuntimeBuilder::new().build();
        let remove_calls = RefCell::new(0u32);
        let result = remove_project_core(
            "alpha",
            &rt,
            &|n| {
                Err(format!(
                    "{}Cannot remove the active project '{n}'.",
                    speedwave_runtime::project::REMOVE_ACTIVE_PROJECT_ERR_PREFIX
                ))
            },
            &|_| {
                *remove_calls.borrow_mut() += 1;
                Ok(())
            },
        );
        let err = result.unwrap_err();
        assert!(
            err.starts_with(speedwave_runtime::project::REMOVE_ACTIVE_PROJECT_ERR_PREFIX),
            "{err}"
        );
        assert_eq!(handles.ensure_ready_count(), 0);
        assert!(handles.down_projects().is_empty());
        assert_eq!(*remove_calls.borrow(), 0);
    }

    #[test]
    fn remove_project_core_compose_down_failure_aborts_remove() {
        let (rt, _handles) = MockRuntimeBuilder::new()
            .with_fail_on_down(&["alpha"])
            .build();
        let remove_calls = RefCell::new(0u32);
        let result = remove_project_core("alpha", &rt, &ok_check, &|_| {
            *remove_calls.borrow_mut() += 1;
            Ok(())
        });
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            err.contains("Failed to stop containers for 'alpha'"),
            "expected user-facing teardown error, got: {err}"
        );
        assert_eq!(
            *remove_calls.borrow(),
            0,
            "runtime project removal must not run after compose_down failure"
        );
    }

    #[test]
    fn recreate_guard_checks_active_project_before_anything_else() {
        let source = include_str!("containers_cmd.rs");
        let fn_body = extract_fn_body_braced(
            source,
            "pub(crate) fn recreate_project_containers_if_running(",
        );
        let active_pos = fn_body
            .find("active_project")
            .expect("must read active_project from config");
        let images_pos = fn_body
            .find("ensure_images_ready")
            .expect("readiness gate must exist");
        assert!(
            active_pos < images_pos,
            "active-project guard must come before any side-effecting step"
        );
    }

    #[test]
    fn recreate_project_containers_if_running_waits_for_image_readiness() {
        let source = include_str!("containers_cmd.rs");
        let fn_body = extract_fn_body_braced(
            source,
            "pub(crate) fn recreate_project_containers_if_running(",
        );

        let ensure_pos = fn_body
            .find("ensure_images_ready(")
            .expect("recreate_project_containers_if_running must call ensure_images_ready");
        let up_pos = fn_body
            .find("compose_up_recreate(")
            .expect("compose_up_recreate must exist in recreate_project_containers_if_running");
        assert!(
            ensure_pos < up_pos,
            "ensure_images_ready must come BEFORE compose_up_recreate"
        );
    }

    #[test]
    fn factory_reset_marks_the_engine_teardown_before_stopping_anything() {
        let source = include_str!("containers_cmd.rs");
        let fn_body = extract_fn_body_braced(source, "pub async fn factory_reset(");
        let teardown = fn_body
            .find("speedwave_runtime::runtime::inhibit_vm_start()")
            .expect("factory_reset must keep the runtime from starting the VM again");
        let first_stop = fn_body
            .find("WATCHDOG_STOP")
            .expect("factory_reset stops the watchdogs");
        assert!(
            teardown < first_stop,
            "a startup image check must not restart the VM a factory reset deletes"
        );
    }

    #[test]
    fn factory_reset_restarts_even_when_the_wipe_task_does_not_finish() {
        let source = include_str!("containers_cmd.rs");
        let fn_body = extract_fn_body_braced(source, "pub async fn factory_reset(");
        let wipe = fn_body
            .find("spawn_blocking(")
            .expect("factory_reset wipes on a blocking task");
        let after_wipe = &fn_body[wipe..];
        assert!(
            !after_wipe.contains(")?"),
            "a process that stopped its workers and may not start its VM again must restart, \
             never return an error and keep running"
        );
        assert!(after_wipe.contains("app.restart()"));
    }

    #[test]
    fn check_containers_running_answers_from_the_engine_once_the_wait_runs_out() {
        let source = include_str!("containers_cmd.rs");
        let fn_body = extract_fn_body_braced(source, "pub async fn check_containers_running(");
        assert!(
            fn_body.contains("if !crate::reconcile::wait_for_image_check(RECONCILE_WAIT_TIMEOUT)"),
            "a first VM start may provision for as long as the wait lasts, so running out of it \
             must not fail the container check"
        );
    }

    #[test]
    fn check_containers_running_waits_for_the_engine_check_before_asking_the_engine() {
        let source = include_str!("containers_cmd.rs");
        let fn_body = extract_fn_body_braced(source, "pub async fn check_containers_running(");

        let wait_pos = fn_body
            .find("wait_for_image_check(")
            .expect("check_containers_running must wait for the startup engine check");
        let probe_pos = fn_body
            .find("is_available()")
            .expect("check_containers_running must probe the runtime");
        let ps_pos = fn_body
            .find("compose_ps(")
            .expect("check_containers_running must list the project's containers");
        assert!(
            wait_pos < probe_pos && wait_pos < ps_pos,
            "the engine check must settle before the runtime is probed, or a VM that still reports \
             Running while it shuts down fails the check"
        );
    }

    fn extract_fn_body_braced<'a>(source: &'a str, fn_signature: &str) -> &'a str {
        let sig_pos = source
            .find(fn_signature)
            .unwrap_or_else(|| panic!("{fn_signature} not found in source"));
        let after = &source[sig_pos..];
        let open = after.find('{').expect("opening brace not found");
        let bytes = after.as_bytes();
        let mut depth: i32 = 0;
        for (i, &b) in bytes.iter().enumerate().skip(open) {
            match b {
                b'{' => depth += 1,
                b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        return &after[..=i];
                    }
                }
                _ => {}
            }
        }
        panic!("closing brace not found for {fn_signature}")
    }

    #[test]
    fn apply_update_rejects_locked_field_and_leaves_it_unchanged() {
        use speedwave_runtime::config::{
            resolve_telemetry, ManagedTelemetryConfig, TelemetryConfig,
        };
        let managed = ManagedTelemetryConfig {
            endpoint: Some("https://corp:4318".into()),
            ..Default::default()
        };
        let mut user = TelemetryConfig {
            endpoint: Some("https://old-user:4318".into()),
            ..Default::default()
        };
        let resolved = resolve_telemetry(Some(&user), Some(&managed)).unwrap();
        let update = TelemetryConfigUpdate {
            endpoint: Some(Some("https://user-evil:4318".into())),
            resource_attributes: Some(Some("team=x".into())),
            ..Default::default()
        };
        let rejected = apply_telemetry_update_with(&mut user, update, &resolved);
        assert_eq!(
            rejected,
            vec!["endpoint"],
            "locked field must be reported rejected"
        );
        assert_eq!(
            user.endpoint.as_deref(),
            Some("https://old-user:4318"),
            "locked endpoint must not change"
        );
    }

    #[test]
    fn apply_update_unchanged_locked_value_is_a_no_op_alongside_unlocked_edit() {
        use speedwave_runtime::config::{
            resolve_telemetry, ManagedTelemetryConfig, TelemetryConfig,
        };
        let managed = ManagedTelemetryConfig {
            enabled: Some(true),
            ..Default::default()
        };
        let mut user = TelemetryConfig {
            endpoint: Some("https://old-user:4318".into()),
            ..Default::default()
        };
        let resolved = resolve_telemetry(Some(&user), Some(&managed)).unwrap();
        assert!(resolved.enabled, "MDM-forced enabled must resolve true");
        let update = TelemetryConfigUpdate {
            enabled: Some(true),
            endpoint: Some(Some("https://new-user:4318".into())),
            ..Default::default()
        };
        let rejected = apply_telemetry_update_with(&mut user, update, &resolved);
        assert!(
            rejected.is_empty(),
            "resending the resolved locked value must not reject the whole save: {rejected:?}"
        );
        assert_eq!(
            user.endpoint.as_deref(),
            Some("https://new-user:4318"),
            "the unlocked endpoint edit must still apply"
        );
    }

    #[test]
    fn apply_update_no_rejections_when_nothing_locked() {
        use speedwave_runtime::config::{resolve_telemetry, TelemetryConfig};
        let mut user = TelemetryConfig::default();
        let resolved = resolve_telemetry(None, None).unwrap();
        let update = TelemetryConfigUpdate {
            resource_attributes: Some(Some("team=x".into())),
            ..Default::default()
        };
        let rejected = apply_telemetry_update_with(&mut user, update, &resolved);
        assert!(rejected.is_empty());
        assert_eq!(user.resource_attributes.as_deref(), Some("team=x"));
    }

    #[test]
    fn apply_update_interval_tri_state_clear_set_and_keep() {
        use speedwave_runtime::config::{resolve_telemetry, TelemetryConfig};
        let resolved = resolve_telemetry(None, None).unwrap();

        let mut user = TelemetryConfig {
            metric_export_interval_ms: Some(5000),
            ..Default::default()
        };
        let update = TelemetryConfigUpdate {
            metric_export_interval_ms: Some(None),
            ..Default::default()
        };
        apply_telemetry_update_with(&mut user, update, &resolved);
        assert_eq!(
            user.metric_export_interval_ms, None,
            "Some(None) must clear"
        );

        let update = TelemetryConfigUpdate {
            metric_export_interval_ms: Some(Some(9000)),
            ..Default::default()
        };
        apply_telemetry_update_with(&mut user, update, &resolved);
        assert_eq!(user.metric_export_interval_ms, Some(9000));

        let update = TelemetryConfigUpdate::default();
        apply_telemetry_update_with(&mut user, update, &resolved);
        assert_eq!(user.metric_export_interval_ms, Some(9000), "omit must keep");
    }

    #[test]
    fn resolve_failure_is_not_masked_as_unlocked() {
        use speedwave_runtime::config::{resolve_telemetry, ManagedTelemetryConfig};
        let managed = ManagedTelemetryConfig {
            enabled: Some(true),
            ..Default::default()
        };
        assert!(
            resolve_telemetry(None, Some(&managed)).is_err(),
            "fail-closed MDM state must be an Err the update path propagates"
        );
    }

    #[test]
    fn save_time_validation_rejects_enabled_without_valid_endpoint() {
        use speedwave_runtime::config::{resolve_telemetry, TelemetryConfig};
        let resolved = resolve_telemetry(None, None).unwrap();

        let mut enabled_no_endpoint = TelemetryConfig::default();
        apply_telemetry_update_with(
            &mut enabled_no_endpoint,
            TelemetryConfigUpdate {
                enabled: Some(true),
                ..Default::default()
            },
            &resolved,
        );
        assert!(
            resolve_telemetry(Some(&enabled_no_endpoint), None).is_err(),
            "enabled=true without an endpoint must be rejected at save time"
        );

        let mut enabled_bad_url = TelemetryConfig::default();
        apply_telemetry_update_with(
            &mut enabled_bad_url,
            TelemetryConfigUpdate {
                enabled: Some(true),
                endpoint: Some(Some("ftp://x/".into())),
                ..Default::default()
            },
            &resolved,
        );
        assert!(
            resolve_telemetry(Some(&enabled_bad_url), None).is_err(),
            "enabled=true with a non-http endpoint must be rejected at save time"
        );

        let mut disabled_ok = TelemetryConfig::default();
        apply_telemetry_update_with(
            &mut disabled_ok,
            TelemetryConfigUpdate {
                enabled: Some(false),
                ..Default::default()
            },
            &resolved,
        );
        assert!(
            resolve_telemetry(Some(&disabled_ok), None).is_ok(),
            "disabled telemetry without an endpoint must still save"
        );
    }

    #[test]
    fn get_telemetry_never_returns_headers_value() {
        use speedwave_runtime::config::{resolve_telemetry, TelemetryConfig};
        let user = TelemetryConfig {
            enabled: Some(true),
            endpoint: Some("https://c:4318".into()),
            headers: Some("Authorization=Bearer SUPER_SECRET".into()),
            export_metrics: Some(true),
            ..Default::default()
        };
        let resolved = resolve_telemetry(Some(&user), None).unwrap();
        let resp = build_telemetry_response(&resolved, user.headers.is_some());
        assert!(resp.has_headers);
        let json = serde_json::to_string(&resp).unwrap();
        assert!(
            !json.contains("SUPER_SECRET"),
            "headers value must never reach the frontend"
        );
    }

    #[test]
    fn compute_has_headers_true_for_non_empty_user_or_managed() {
        use speedwave_runtime::config::{ManagedTelemetryConfig, TelemetryConfig};
        let user = TelemetryConfig {
            headers: Some("Authorization=Bearer x".into()),
            ..Default::default()
        };
        assert!(compute_has_headers(Some(&user), None));

        let managed = ManagedTelemetryConfig {
            headers: Some("Authorization=Bearer y".into()),
            ..Default::default()
        };
        assert!(compute_has_headers(None, Some(&managed)));
    }

    #[test]
    fn compute_has_headers_false_for_empty_string_on_either_side() {
        use speedwave_runtime::config::{ManagedTelemetryConfig, TelemetryConfig};
        let user_empty = TelemetryConfig {
            headers: Some(String::new()),
            ..Default::default()
        };
        assert!(
            !compute_has_headers(Some(&user_empty), None),
            "empty-string user headers must not report as configured"
        );

        let managed_empty = ManagedTelemetryConfig {
            headers: Some(String::new()),
            ..Default::default()
        };
        assert!(
            !compute_has_headers(None, Some(&managed_empty)),
            "empty-string MDM headers must not report as configured (symmetry with user branch)"
        );

        assert!(!compute_has_headers(None, None));
    }

    #[test]
    fn factory_reset_stops_clipboard_and_drains_teardowns_before_wipe() {
        let src = include_str!("containers_cmd.rs");
        let body = &src[src
            .find("pub async fn factory_reset")
            .expect("factory_reset fn")..];
        let oauth_stop = body.find("oauth.lock()").expect("oauth stop call");
        let clipboard_stop = body.find("clipboard.lock()").expect("clipboard stop call");
        let drain = body.find("drain_pending_teardowns();").expect("drain call");
        let wipe = body
            .find("starting factory reset wipe")
            .expect("wipe log line");
        assert!(oauth_stop < wipe, "oauth workers must stop before the wipe");
        assert!(
            clipboard_stop < wipe,
            "clipboard bridge must stop before the wipe"
        );
        assert!(
            drain < wipe,
            "pending teardowns must be joined before the wipe"
        );
    }

    fn all_categories_on(
    ) -> std::collections::HashMap<String, speedwave_runtime::pii_policy::RuleFlags> {
        speedwave_runtime::pii_policy::rule_library()
            .unwrap()
            .iter()
            .map(|r| {
                (
                    r.id.clone(),
                    speedwave_runtime::pii_policy::RuleFlags {
                        tokenize: true,
                        log: false,
                    },
                )
            })
            .collect()
    }

    fn security_policy_input(
        policies: Vec<&str>,
        custom_policies: Vec<CustomPolicyDtoInput>,
    ) -> SecurityPolicyUpdate {
        SecurityPolicyUpdate {
            policies: policies.into_iter().map(String::from).collect(),
            custom_policies,
        }
    }

    fn custom_policy_input(
        name: &str,
        enabled: bool,
        categories: std::collections::HashMap<String, speedwave_runtime::pii_policy::RuleFlags>,
        custom_patterns: Vec<SecurityPolicyCustomPatternInput>,
    ) -> CustomPolicyDtoInput {
        CustomPolicyDtoInput {
            name: name.to_string(),
            enabled,
            categories,
            custom_patterns,
            keywords: Vec::new(),
        }
    }

    #[test]
    fn list_security_policy_templates_maps_every_builtin() {
        let templates = list_security_policy_templates().unwrap();
        let ids: Vec<&str> = templates.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids.len(), 3);
        assert!(ids.contains(&"strict"));
        assert!(ids.contains(&"gdpr-art32"));
        assert!(ids.contains(&"eu-ai-act-art5"));
    }

    #[test]
    fn list_pii_rules_maps_every_library_rule() {
        let rules = list_pii_rules().unwrap();
        let ids: Vec<&str> = rules.iter().map(|r| r.id.as_str()).collect();
        assert!(ids.contains(&"EMAIL"));
        assert!(ids.contains(&"PESEL"));
        assert!(ids.contains(&"NIP"));
        assert!(!ids.contains(&"SENSITIVE_FIELD"));
        assert_eq!(
            rules.len(),
            speedwave_runtime::pii_policy::rule_library().unwrap().len()
        );
    }

    #[test]
    fn build_response_defaults_to_every_library_rule_tokenized_for_unconfigured_project() {
        let resolved = speedwave_runtime::pii_policy::resolve_pii_policy(None, None).unwrap();
        let resp = build_security_policy_response(&resolved, None);
        assert!(resp.enabled_policies.is_empty());
        assert!(resp.forced_policies.is_empty());
        let library = speedwave_runtime::pii_policy::rule_library().unwrap();
        assert_eq!(resp.effective_rules.len(), library.len());
        assert!(resp.effective_rules.iter().all(|r| r.tokenize && !r.log));
        assert!(resp.custom_policies.is_empty());
    }

    #[test]
    fn build_response_round_trips_every_custom_policy_definition() {
        use speedwave_runtime::pii_policy::{OwnRuleV3, RuleFlags};

        let mut categories = all_categories_on();
        categories.insert(
            "EMAIL".to_string(),
            RuleFlags {
                tokenize: false,
                log: false,
            },
        );
        let raw = config::PiiPolicyUserConfig {
            policies: vec!["my-custom".to_string()],
            custom_policies: vec![config::PiiPolicyDefinition {
                id: "my-custom".to_string(),
                name: "My Custom".to_string(),
                categories: categories.clone(),
                rules: vec![OwnRuleV3 {
                    id: "EMPLOYEE_ID".to_string(),
                    display_name: "Employee ID".to_string(),
                    patterns: vec![r"\bEMP-\d{4,8}\b".to_string()],
                    validator: None,
                    case_sensitive: true,
                    tokenize: true,
                    log: false,
                }],
                keywords: vec![],
            }],
        };
        let resolved = speedwave_runtime::pii_policy::resolve_pii_policy(Some(&raw), None).unwrap();
        let resp = build_security_policy_response(&resolved, Some(&raw));
        assert_eq!(resp.enabled_policies, vec!["my-custom".to_string()]);
        assert!(resp.forced_policies.is_empty());
        assert!(resp.effective_rules.iter().any(|r| r.id == "EMPLOYEE_ID"));
        assert!(!resp.effective_rules.iter().any(|r| r.id == "EMAIL"));
        assert_eq!(resp.custom_policies.len(), 1);
        let dto = &resp.custom_policies[0];
        assert_eq!(dto.id, "my-custom");
        assert_eq!(dto.name, "My Custom");
        assert_eq!(dto.categories, categories);
        assert_eq!(dto.rules.len(), 1);
        assert_eq!(dto.rules[0].id, "EMPLOYEE_ID");
    }

    #[test]
    fn build_response_marks_managed_forced_policies() {
        let managed = config::ManagedPiiPolicyConfig {
            forced_policies: vec!["strict".to_string()],
        };
        let resolved =
            speedwave_runtime::pii_policy::resolve_pii_policy(None, Some(&managed)).unwrap();
        let resp = build_security_policy_response(&resolved, None);
        assert_eq!(resp.enabled_policies, vec!["strict".to_string()]);
        assert_eq!(resp.forced_policies, vec!["strict".to_string()]);
    }

    #[test]
    fn build_config_selecting_a_builtin_stores_only_its_id() {
        let update = security_policy_input(vec!["gdpr-art32"], vec![]);
        let cfg = build_pii_policy_user_config(&update).unwrap();
        assert_eq!(cfg.policies, vec!["gdpr-art32".to_string()]);
        assert!(cfg.custom_policies.is_empty());
    }

    #[test]
    fn build_config_rejects_unknown_policy_id() {
        let update = security_policy_input(vec!["totally-bogus"], vec![]);
        assert!(build_pii_policy_user_config(&update).is_err());
    }

    #[test]
    fn build_config_custom_policy_derives_id_from_name_and_persists_full_selection() {
        let update = security_policy_input(
            vec![],
            vec![custom_policy_input(
                "Employee Roster",
                true,
                all_categories_on(),
                vec![SecurityPolicyCustomPatternInput {
                    display_name: "Employee ID".to_string(),
                    pattern: r"\bEMP-\d{4,8}\b".to_string(),
                    case_insensitive: false,
                }],
            )],
        );
        let cfg = build_pii_policy_user_config(&update).unwrap();
        assert_eq!(cfg.policies, vec!["employee-roster".to_string()]);
        assert_eq!(cfg.custom_policies.len(), 1);
        let def = &cfg.custom_policies[0];
        assert_eq!(def.id, "employee-roster");
        assert_eq!(def.name, "Employee Roster");
        assert_eq!(def.categories, all_categories_on());
        assert_eq!(def.rules.len(), 1);
        assert_eq!(def.rules[0].id, "EMPLOYEE_ID");
        assert_eq!(def.rules[0].display_name, "Employee ID");
        assert!(def.rules[0].tokenize);
        assert!(!def.rules[0].log);
    }

    #[test]
    fn build_config_custom_policy_persists_keywords() {
        let mut input = custom_policy_input("Brand Names", true, all_categories_on(), vec![]);
        input.keywords = vec![speedwave_runtime::pii_policy::KeywordV3 {
            r#match: "Coca-Cola".to_string(),
            alias: "Brandex".to_string(),
            case_sensitive: false,
        }];
        let update = security_policy_input(vec![], vec![input]);
        let cfg = build_pii_policy_user_config(&update).unwrap();
        assert_eq!(cfg.custom_policies.len(), 1);
        let keywords = &cfg.custom_policies[0].keywords;
        assert_eq!(keywords.len(), 1);
        assert_eq!(keywords[0].r#match, "Coca-Cola");
        assert_eq!(keywords[0].alias, "Brandex");
        assert!(!keywords[0].case_sensitive);
    }

    #[test]
    fn build_config_rejects_keyword_with_invalid_alias() {
        let mut input = custom_policy_input("Brand Names", true, all_categories_on(), vec![]);
        input.keywords = vec![speedwave_runtime::pii_policy::KeywordV3 {
            r#match: "Coca-Cola".to_string(),
            alias: "1bad alias!".to_string(),
            case_sensitive: true,
        }];
        let update = security_policy_input(vec![], vec![input]);
        assert!(build_pii_policy_user_config(&update).is_err());
    }

    #[test]
    fn build_config_disabled_custom_policy_is_persisted_but_not_selected() {
        let update = security_policy_input(
            vec!["strict"],
            vec![custom_policy_input(
                "Draft Policy",
                false,
                all_categories_on(),
                vec![],
            )],
        );
        let cfg = build_pii_policy_user_config(&update).unwrap();
        assert_eq!(cfg.policies, vec!["strict".to_string()]);
        assert_eq!(cfg.custom_policies.len(), 1);
        assert_eq!(cfg.custom_policies[0].id, "draft-policy");
    }

    #[test]
    fn build_config_rejects_custom_policy_id_colliding_with_builtin() {
        let update = security_policy_input(
            vec![],
            vec![custom_policy_input(
                "Strict",
                true,
                all_categories_on(),
                vec![],
            )],
        );
        assert!(build_pii_policy_user_config(&update).is_err());
    }

    #[test]
    fn build_config_rejects_duplicate_derived_policy_ids() {
        let update = security_policy_input(
            vec![],
            vec![
                custom_policy_input("Sales Team", true, all_categories_on(), vec![]),
                custom_policy_input("Sales-Team", true, all_categories_on(), vec![]),
            ],
        );
        assert!(build_pii_policy_user_config(&update).is_err());
    }

    #[test]
    fn build_config_rejects_nested_quantifier_regex() {
        let update = security_policy_input(
            vec![],
            vec![custom_policy_input(
                "Evil Policy",
                true,
                all_categories_on(),
                vec![SecurityPolicyCustomPatternInput {
                    display_name: "Evil".to_string(),
                    pattern: "(a+)+".to_string(),
                    case_insensitive: false,
                }],
            )],
        );
        assert!(build_pii_policy_user_config(&update).is_err());
    }

    #[test]
    fn build_config_rejects_over_cap_custom_patterns() {
        let patterns: Vec<SecurityPolicyCustomPatternInput> = (0
            ..=speedwave_runtime::consts::PII_MAX_RULES)
            .map(|i| SecurityPolicyCustomPatternInput {
                display_name: format!("Pattern {i}"),
                pattern: r"\d{3}".to_string(),
                case_insensitive: false,
            })
            .collect();
        let update = security_policy_input(
            vec![],
            vec![custom_policy_input(
                "Custom",
                true,
                all_categories_on(),
                patterns,
            )],
        );
        assert!(build_pii_policy_user_config(&update).is_err());
    }

    #[test]
    fn build_config_rejects_duplicate_derived_pattern_ids() {
        let update = security_policy_input(
            vec![],
            vec![custom_policy_input(
                "Custom",
                true,
                all_categories_on(),
                vec![
                    SecurityPolicyCustomPatternInput {
                        display_name: "Employee ID".to_string(),
                        pattern: r"\d{3}".to_string(),
                        case_insensitive: false,
                    },
                    SecurityPolicyCustomPatternInput {
                        display_name: "Employee-ID".to_string(),
                        pattern: r"\d{4}".to_string(),
                        case_insensitive: false,
                    },
                ],
            )],
        );
        assert!(build_pii_policy_user_config(&update).is_err());
    }
}
