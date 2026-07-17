// Container lifecycle and setup wizard Tauri commands — thin
// #[tauri::command] wrappers over setup_wizard / speedwave_runtime.

use speedwave_runtime::config;

use crate::reconcile::{SharedIdeBridge, SharedMcpOs, SharedOauth};
use crate::setup_wizard;
use crate::types::{
    check_project, LlmConfigResponse, LlmConfigUpdate, TelemetryConfigResponse,
    TelemetryConfigUpdate, TelemetryLocks,
};

/// Max bytes for the local-LLM `api_key` token file; larger is almost
/// certainly a paste error or hostile input.
const MAX_API_KEY_BYTES: usize = 64 * 1024;
/// Max bytes for the `custom_headers` blob (multi-line `Name: Value`) —
/// realistic header counts without enabling arbitrary blob storage.
const MAX_CUSTOM_HEADERS_BYTES: usize = 16 * 1024;

/// Disallowed header names (case-insensitive): Speedwave-managed
/// (`Authorization` ← `api_key`) or hop-by-hop/transport headers.
const FORBIDDEN_HEADER_NAMES: &[&str] = &[
    "authorization",
    "cookie",
    "host",
    "content-length",
    "transfer-encoding",
];

/// Validates and normalises an `api_key`. Empty after `Bearer ` strip is an
/// explicit error; clearing the key is a separate `Delete` path.
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
    // Reject a bare `Bearer` (no token) with an actionable error.
    if trimmed.eq_ignore_ascii_case("bearer") {
        return Err("api_key must not be empty after stripping the 'Bearer ' prefix".to_string());
    }
    crate::llm_cmd::strip_bearer_prefix(value)
        .ok_or_else(|| "api_key must not be empty after stripping the 'Bearer ' prefix".to_string())
}

/// Validates and normalises a `custom_headers` blob. Returns the original
/// string if every line parses; otherwise the first error.
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
        // RFC 7230 token validation — `HeaderName::from_bytes` enforces the
        // full token charset (alphanumeric + `!#$%&'*+-.^_`|~`).
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

/// Max wait for container images to become ready before failing; the
/// frontend shows a rebuild overlay meanwhile (UX in project-state.service.ts).
const RECONCILE_WAIT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(600);

/// Blocks until container images are ready (reconcile complete) or timeout.
/// Called before any operation that starts containers.
pub(crate) fn ensure_images_ready() -> Result<(), String> {
    crate::reconcile::wait_for_images_ready(RECONCILE_WAIT_TIMEOUT)
}

// Project switch transaction helpers
// ---------------------------------------------------------------------------

/// Result of the container-switching transaction.
pub(crate) enum SwitchResult {
    /// New project is up. `teardown` is the previous project the caller must
    /// stop via `spawn_background_teardown` (None when nothing to stop).
    Succeeded { teardown: Option<String> },
    /// Primary error + optional cleanup error. Caller handles config rollback + UI.
    Failed {
        error: String,
        cleanup_error: Option<String>,
    },
}

/// Tears down new project without restoring anything.
/// The previous project is never stopped before the switch succeeds.
pub(crate) fn teardown_only(
    new_project: &str,
    rt: &speedwave_runtime::runtime::LockedRuntime,
) -> Option<String> {
    rt.compose_down(new_project).err().map(|e| {
        log::warn!("failed to tear down new project '{new_project}': {e}");
        format!("teardown of '{new_project}' failed: {e}")
    })
}

/// In-flight background teardowns by project name.
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

/// Stops the previous project on a background thread (best-effort).
/// A failure only leaves idle containers; the next compose op converges them.
pub(crate) fn spawn_background_teardown(prev: String) {
    spawn_background_teardown_with(prev, |p| {
        let rt = speedwave_runtime::runtime::detect_runtime();
        rt.compose_down(p).map_err(|e| e.to_string())
    });
}

/// On-disk teardown intents — lets the NEXT launch converge projects whose
/// background teardown a crash interrupted (never CLI-run projects).
fn teardown_intents_path() -> std::path::PathBuf {
    speedwave_runtime::consts::data_dir().join("pending-teardowns")
}

fn record_teardown_intent(project: &str) {
    let _guard = pending_teardowns_lock();
    let path = teardown_intents_path();
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

fn clear_teardown_intent(project: &str) {
    let _guard = pending_teardowns_lock();
    let path = teardown_intents_path();
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

/// A `write-*` atomic-write tempfile older than this was orphaned by a crash
/// between tempfile creation and rename, never an in-flight write.
const STALE_ATOMIC_WRITE_TEMP_AGE: std::time::Duration = std::time::Duration::from_secs(3600);

/// Projects whose background teardown a previous process never finished. Also
/// sweeps orphaned atomic-write tempfiles left in the data dir by a crash
/// between tempfile creation and rename — no other path cleans those up.
pub(crate) fn crashed_teardown_intents() -> Vec<String> {
    speedwave_runtime::fs_perms::sweep_stale_atomic_write_temp_files(
        speedwave_runtime::consts::data_dir(),
        STALE_ATOMIC_WRITE_TEMP_AGE,
    );
    let path = teardown_intents_path();
    std::fs::read_to_string(&path)
        .map(|c| c.lines().map(str::to_string).collect())
        .unwrap_or_default()
}

fn spawn_background_teardown_with(
    prev: String,
    down: impl FnOnce(&str) -> Result<(), String> + Send + 'static,
) {
    record_teardown_intent(&prev);
    let project = prev.clone();
    let handle = std::thread::spawn(move || {
        log::info!("stopping previous project '{project}' in the background");
        match down(&project) {
            Ok(()) => {
                log::info!("background teardown of '{project}' stopped");
                clear_teardown_intent(&project);
            }
            Err(e) => log::warn!("background compose_down('{project}') failed: {e}"),
        }
    });
    if let Some(old) = pending_teardowns_lock().insert(prev, handle) {
        // Replaced entry already finished; join() is a no-op cleanup.
        let _ = old.join();
    }
}

/// Joins every in-flight background teardown — callers: exit path and factory reset.
pub(crate) fn drain_pending_teardowns() {
    let handles: Vec<(String, std::thread::JoinHandle<()>)> =
        pending_teardowns_lock().drain().collect();
    for (project, handle) in handles {
        log::info!("draining background teardown of '{project}' before exit");
        let _ = handle.join();
    }
}

/// Joins a pending background teardown of `project` before it is started
/// again — otherwise the teardown could kill the freshly started containers.
pub(crate) fn wait_for_pending_teardown(project: &str) {
    let handle = pending_teardowns_lock().remove(project);
    if let Some(h) = handle {
        log::info!("waiting for background teardown of '{project}' before starting it");
        let _ = h.join();
    }
}

/// Core sync logic: ensure_ready → start new project FIRST → hand previous
/// back for background teardown. A failed start leaves previous untouched.
pub(crate) fn switch_project_core(
    previous: &Option<String>,
    new_project: &str,
    rt: &speedwave_runtime::runtime::LockedRuntime,
    recreate_fn: &dyn Fn(&str, &speedwave_runtime::runtime::LockedRuntime) -> Result<(), String>,
) -> SwitchResult {
    // 1. Ensure runtime is ready
    if let Err(e) = rt.ensure_ready() {
        return SwitchResult::Failed {
            error: format!("Runtime not ready: {e}"),
            cleanup_error: None,
        };
    }

    // 2. A still-running teardown of the destination must finish first.
    wait_for_pending_teardown(new_project);

    // 3. Start new first — previous keeps serving until the caller's
    //    background teardown after a fully successful switch.
    if let Err(e) = recreate_fn(new_project, rt) {
        return SwitchResult::Failed {
            error: e,
            cleanup_error: teardown_only(new_project, rt),
        };
    }

    SwitchResult::Succeeded {
        teardown: previous
            .as_ref()
            .filter(|p| p.as_str() != new_project)
            .cloned(),
    }
}

// Compose helpers — resolve config, render, security check, save
// ---------------------------------------------------------------------------

/// True when `project` has no resolvable LLM provider (SSOT:
/// `LlmConfig::is_unconfigured`) — callers must skip starting containers.
pub(crate) fn project_llm_is_unconfigured(project: &str) -> Result<bool, String> {
    let user_config = config::load_user_config().map_err(|e| e.to_string())?;
    project_llm_is_unconfigured_in(&user_config, project)
}

/// Testable variant of [`project_llm_is_unconfigured`] taking an explicit config.
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

/// Renders a project's compose.yml and saves it after security check. Caller
/// MUST pre-build images — passes `None` to render_compose (ADR-066).
pub(crate) fn render_and_save_compose(project: &str) -> Result<(), String> {
    let user_config = config::load_user_config().map_err(|e| e.to_string())?;
    let project_dir = user_config
        .find_project(project)
        .map(|p| p.dir.clone())
        .ok_or_else(|| format!("project '{}' not found", project))?;

    let project_path = std::path::Path::new(&project_dir);
    // Defense-in-depth: pre-flight CloudStorage TCC check before any compose render.
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
    // OS prerequisite check
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

/// Runs OS prerequisite checks. Returns Ok(()) if all pass, or Err with
/// violation details. Used by the frontend before attempting container start.
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

// Setup wizard commands
// ---------------------------------------------------------------------------

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

/// Adds a project and boots it (containers + chat); same lifecycle as
/// `switch_project`. On failure it stays registered but inactive (retryable).
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
        return Err("A project switch is already in progress".to_string());
    };
    // Start subsystems on-demand (e.g. after factory reset / fresh install)
    crate::ensure_mcp_os_running(&mcp_os, &app);
    crate::ensure_ide_bridge_running(&ide_bridge, &app);
    use tauri::Manager;
    let oauth_arc = app.state::<SharedOauth>().inner().clone();

    // Pre-flight: detect CloudStorage TCC denial before adding project.
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

    // Container transaction: wait for images → stop previous → start new
    let prev_clone = previous.clone();
    let new_clone = name.clone();
    let switch_result = tokio::task::spawn_blocking(move || {
        if let Err(e) = ensure_images_ready() {
            return SwitchResult::Failed {
                error: e,
                cleanup_error: None,
            };
        }
        let rt = speedwave_runtime::runtime::detect_runtime();
        switch_project_core(&prev_clone, &new_clone, &rt, &|proj, rt| {
            // start_containers calls ensure_ready internally (noop — VM already up)
            check_project(proj)?;
            // Lazy build for the new project (ADR-057) — repo-enabled
            // integrations need their images before pull_policy:never up.
            if let Err(sanitized) = crate::integrations_cmd::ensure_project_images_built(rt, proj) {
                return Err(format!("Image build failed: {sanitized}"));
            }
            // No provider is a valid state ("choose a provider" screen) —
            // skip starting containers rather than let render_compose bail.
            if project_llm_is_unconfigured(proj)? {
                log::info!("'{proj}' has no LLM provider — skipping container start");
                return Ok(());
            }
            // Eager-start host workers before compose render — live WORKER_*_URLs
            // prevent the first-message container recreate.
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

    // Rebind chat session
    if let Err(e) = crate::rebind_chat(&name, &app, &chat_state) {
        // Containers running but chat failed — transient, still emit succeeded
        log::warn!("rebind_chat failed after adding project: {e}");
    }

    // Previous project is stopped in the background.
    if let Some(prev) = pending_teardown {
        spawn_background_teardown(prev);
    }

    let _ = app.emit(
        "project_switch_succeeded",
        serde_json::json!({ "project": name }),
    );
    Ok(())
}

/// Core: compose_down → runtime::remove_project. Extracted for tests; on compose_down
/// failure the config wipe is skipped so the user can retry.
pub(crate) fn remove_project_core(
    name: &str,
    rt: &speedwave_runtime::runtime::LockedRuntime,
    remove_fn: &dyn Fn(&str) -> Result<(), String>,
) -> Result<(), String> {
    if rt.is_available() {
        rt.compose_down(name).map_err(|e| {
            log::error!("compose_down('{name}') failed: {e}");
            format!("Failed to stop containers for '{name}': {e}")
        })?;
    }
    log::info!("removing project name={name}");
    remove_fn(name)
}

/// Tears down a project's containers and unregisters it.
/// Runtime layer rejects the active project (sentinel-prefixed error for the UI).
#[tauri::command]
pub async fn remove_project(name: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let rt = speedwave_runtime::runtime::detect_runtime();
        remove_project_core(&name, &rt, &|n| {
            speedwave_runtime::project::remove_project(n).map_err(|e| {
                log::error!("failed to remove project: {e}");
                e.to_string()
            })
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

// Container lifecycle commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn is_setup_complete() -> Result<bool, String> {
    Ok(setup_wizard::is_setup_complete())
}

#[tauri::command]
pub async fn build_images() -> Result<(), String> {
    tokio::task::spawn_blocking(|| {
        log::info!("building images");
        setup_wizard::build_images().map_err(|e| {
            log::error!("failed to build images: {e}");
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
    crate::ensure_mcp_os_running(&mcp_os, &app);
    crate::ensure_ide_bridge_running(&ide_bridge, &app);
    use tauri::Manager;
    let oauth_arc = app.state::<SharedOauth>().inner().clone();

    tokio::task::spawn_blocking(move || {
        ensure_images_ready()?;
        check_project(&project)?;
        // Eager-start host workers before compose render — live WORKER_*_URLs
        // prevent the first-message container recreate.
        crate::ensure_oauth_running(&oauth_arc, &project);
        // Pre-flight: detect CloudStorage TCC denial before attempting container start.
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

    // `start_containers` is the last step that flips `is_setup_complete()`;
    // rebuild the tray so setup-gated items (ADR-058 beta toggle) appear.
    crate::tray::refresh_tray_menu(&app);
    Ok(())
}

/// Wizard step 4 for a project with no LLM provider yet — marks the step
/// done without starting containers. See `setup_wizard::defer_container_start`.
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
        let rt = speedwave_runtime::runtime::detect_runtime();
        // Intentional double check: is_available() gives a clean "no
        // containers" signal where compose_ps() would Err (confusing UX).
        if !rt.is_available() {
            log::warn!("runtime not available");
            return Ok(false);
        }
        // A deferred-start project (no LLM provider yet) has no compose.yml
        // at all — compose_ps would Err rather than report "not running".
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

/// Re-render compose and recreate running containers so the hub re-discovers a
/// host worker. Best-effort (oauth respawn + per-project watchdog).
pub(crate) fn recreate_project_containers_if_running(project: &str) {
    // Only the ACTIVE project may be resurrected — else a compose_ps TOCTOU
    // revives a project the user already switched away from mid-teardown.
    let active = speedwave_runtime::config::load_user_config()
        .ok()
        .and_then(|c| c.active_project);
    if active.as_deref() != Some(project) {
        log::debug!("'{project}' is not the active project — skipping recreate");
        return;
    }
    // Bundle reconcile may be rebuilding images. compose_up_recreate against a
    // missing image tag emits "image not available" to the user. Wait first.
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
    // Build OUTSIDE the compose lock (ADR-066).
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

/// Recreate a project's containers with freshly generated compose (on switch,
/// to match `ENABLED_SERVICES`). Skips image rebuild + snapshot/rollback.
#[tauri::command]
pub async fn recreate_project_containers(project: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        ensure_images_ready()?;
        check_project(&project)?;
        // Pre-flight: detect CloudStorage TCC denial before container recreate.
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

        // Lazy build (ADR-057).
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

// Settings / reset commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn factory_reset(
    app: tauri::AppHandle,
    ide_bridge: tauri::State<'_, SharedIdeBridge>,
    mcp_os: tauri::State<'_, SharedMcpOs>,
    oauth: tauri::State<'_, SharedOauth>,
    clipboard: tauri::State<'_, crate::clipboard_bridge::SharedClipboardBridge>,
) -> Result<(), String> {
    // 1. Stop mcp-os watchdog
    crate::WATCHDOG_STOP.store(true, std::sync::atomic::Ordering::Relaxed);

    // 1b. Stop the oauth watchdog too, so it cannot respawn workers mid-wipe.
    crate::OAUTH_WATCHDOG_STOP.store(true, std::sync::atomic::Ordering::Relaxed);

    // 2. Stop IDE Bridge
    if let Ok(mut guard) = ide_bridge.lock() {
        if let Some(mut bridge) = guard.take() {
            if let Err(e) = bridge.stop() {
                log::warn!("failed to stop IDE Bridge during factory reset: {e}");
            }
        }
    }

    // 3. Stop mcp-os (kill child, join drain threads, release log handles);
    //    explicit stop + cleanup_files keeps parity with run_exit_cleanup.
    if let Ok(mut guard) = mcp_os.lock() {
        if let Some(mut proc) = guard.take() {
            if let Err(e) = proc.stop() {
                log::warn!("failed to stop mcp-os during factory reset: {e}");
            }
            proc.cleanup_files();
        }
    }

    // 3b. Stop per-project oauth workers — they hold token-file handles under the
    // data dir and the exit path already stops them (parity).
    if let Ok(mut map) = oauth.lock() {
        for (project, mut proc) in map.drain() {
            if let Err(e) = proc.stop() {
                log::warn!("oauth worker for '{project}' stop error during factory reset: {e}");
            }
            proc.cleanup_files();
        }
    }

    // 3c. Stop the clipboard-bridge watcher — Windows cannot delete a watched
    // directory (os error 5), which made wipe_data_dir fail under claude-home.
    if let Ok(mut guard) = clipboard.lock() {
        drop(guard.take());
    }

    // 4. Wipe (compose_down, VM delete, CLI removal, remove_dir_all)
    let result = tokio::task::spawn_blocking(|| {
        // 3d. Join in-flight background teardowns so the wipe does not race them,
        // bounded — a hung compose_down must not wedge the reset (thread keeps draining).
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            drain_pending_teardowns();
            let _ = tx.send(());
        });
        if rx.recv_timeout(std::time::Duration::from_secs(30)).is_err() {
            log::warn!("background teardown drain did not finish within 30s, continuing with wipe");
        }
        log::info!("starting factory reset wipe");
        setup_wizard::factory_reset().map_err(|e| {
            log::error!("factory reset failed: {e}");
            e.to_string()
        })
    })
    .await
    .map_err(|e| e.to_string())?;

    // 5. Always restart: success → clean wizard start (data dir gone);
    //    failure → recover subsystems (data dir may partially exist).
    if let Err(ref e) = result {
        log::error!("factory reset wipe failed ({e}), restarting to recover");
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
    // `has_api_key` is the key file's existence (SSOT), not the persisted flag —
    // re-derive it before the frontend reads it.
    if let Some(active) = user_config.active_project.as_deref() {
        llm.sync_has_api_key_from_disk_in(speedwave_runtime::consts::data_dir().as_path(), active);
    }
    let default_base_url = llm
        .provider
        .as_deref()
        .and_then(speedwave_runtime::compose::default_base_url);

    // Non-destructive: warn if a stored base_url now fails the SSRF policy,
    // but still return it for display — the Save path rejects it (ADR-041).
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

/// Frontend mirror in `models/llm.ts::ActiveProviderSummary`; keep both in sync.
#[derive(serde::Serialize, Debug)]
pub struct ActiveProviderSummary {
    pub provider_id: String,
    pub kind: config::LlmProviderKind,
    pub model: Option<String>,
    /// Local providers only (`kind == Local`); the composer's local discovery
    /// probe needs it and must never call `discover_llm_models` with the bare
    /// `provider_id` as a URL.
    pub base_url: Option<String>,
}

/// Pure logic over an already-loaded config - unit-testable without touching
/// `consts::data_dir()` (process-wide `OnceLock`), same split as `apply_llm_config`.
fn active_provider_summary_from(
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

/// The active provider+model+base_url, for the composer badge/combobox to
/// normalize the observed wire id and drive per-provider discovery, without
/// duplicating `effective_active_model`.
#[tauri::command]
pub fn get_active_provider_summary(project: String) -> Result<ActiveProviderSummary, String> {
    let user_config = config::load_user_config().map_err(|e| e.to_string())?;
    active_provider_summary_from(&user_config, &project)
}

/// Backend-authoritative default base URL for a provider (so the frontend
/// duplicates no URL strings). `None` for unknown providers, e.g. anthropic.
#[tauri::command]
pub fn get_default_base_url(provider: String) -> Result<Option<String>, String> {
    Ok(speedwave_runtime::compose::default_base_url(&provider))
}

/// SSOT Anthropic model list for Settings → LLM Provider; bumping a model
/// edits one const in `defaults.rs` (struct serializes across IPC directly).
#[tauri::command]
pub fn list_anthropic_models() -> &'static [speedwave_runtime::defaults::AnthropicModelInfo] {
    speedwave_runtime::defaults::ANTHROPIC_MODELS
}

/// Builds the frontend telemetry response. Never copies the headers value (only
/// `has_headers`); locks derived per-field so no `OTEL_*` string reaches the UI.
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

/// Applies each set field unless MDM locked it; returns the names of any locked
/// fields the update tried to actually change (caller rejects the write when
/// non-empty). A locked field submitted with its current resolved value is a
/// no-op, never a rejection — it lets the frontend resend unlocked fields.
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
    // endpoint tri-state: Some(None) clears, Some(Some) sets.
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
    // Headers tri-state: Some(None) clears, Some(Some) sets.
    if let Some(h) = update.headers {
        set_field!(
            "headers",
            F::Headers,
            true,
            h == resolved.headers,
            user.headers = h
        );
    }
    // resource_attributes tri-state: Some(None) clears, Some(Some) sets.
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
    // Interval tri-state: Some(None) clears, Some(Some) sets.
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

/// True when either layer sets a non-empty headers value. Symmetric across
/// user and MDM sources — an empty-string policy must never read as "configured".
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

/// Returns the effective telemetry the container will use (user + MDM merge),
/// so the Settings UI shows exactly what reaches Claude Code.
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

/// Persists user telemetry fields to the user config. Rejects (does not persist)
/// a write that targets an MDM-locked field; a fail-closed MDM policy also rejects.
#[tauri::command]
pub fn update_telemetry_config(update: TelemetryConfigUpdate) -> Result<(), String> {
    config::with_config_lock(|| {
        let mut user_config = config::load_user_config()?;
        let managed =
            speedwave_runtime::managed_config::load_managed_config()?.and_then(|m| m.telemetry);
        // Propagate a resolve error instead of masking it as "nothing locked",
        // which would let a user overwrite fields MDM meant to lock.
        let resolved = config::resolve_telemetry(user_config.telemetry.as_ref(), managed.as_ref())?;
        let mut telemetry = user_config.telemetry.take().unwrap_or_default();
        let rejected = apply_telemetry_update_with(&mut telemetry, update, &resolved);
        if !rejected.is_empty() {
            anyhow::bail!(
                "cannot change organization-managed telemetry field(s): {}",
                rejected.join(", ")
            );
        }
        // Validate the post-update state through the same SSOT the renderer uses,
        // so an invalid save is rejected here instead of bricking the next render.
        config::resolve_telemetry(Some(&telemetry), managed.as_ref())?;
        user_config.telemetry = Some(telemetry);
        config::save_user_config(&user_config)?;
        Ok(())
    })
    .map_err(|e| e.to_string())
}

/// Probes whether an OTLP endpoint is reachable from the host (best-effort;
/// warns instead of letting Claude Code hang on an unreachable collector).
#[tauri::command]
pub async fn probe_otlp_endpoint(endpoint: String) -> Result<bool, String> {
    // Validate before dialing so this is not an SSRF reachability oracle; on-prem
    // and loopback collectors are legitimate, so allow loopback.
    let validated = crate::url_validation::validate_collector_url(
        &endpoint,
        crate::url_validation::PrivatePolicy::AllowLoopback,
    )?;
    let client = crate::http_util::build_hardened_client(None)?;
    // A HEAD to the base endpoint; any HTTP response means reachable. A collector
    // may 404/405 the path — that still proves the host/port is up.
    match client.head(validated).send().await {
        Ok(_) => Ok(true),
        Err(e) => {
            // UI verdict stays boolean; the reason (DNS/TLS/refused/timeout) is only
            // useful in diagnostics, so surface it at debug rather than discard it.
            log::debug!("OTLP collector unreachable: {e}");
            Ok(false)
        }
    }
}

/// Applies LLM config to the active project in-memory; enforces the local-
/// provider-needs-model invariant for callers bypassing `update_llm_config`.
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

/// Narrow write-through for the composer's model selector (ADR-073 §4.3.2):
/// mutates exactly one provider entry's `model`, never the full LLM config.
/// Rejects Anthropic entries (session-only via wire `/model`, never persisted).
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

/// Sets exactly one provider's model in place (composer write-through,
/// ADR-073 §4.3.2) under the standard config lock - never the full-form
/// `update_llm_config`. Rapid successive calls serialize through the lock;
/// the later call's write is what persists.
#[tauri::command]
pub fn set_provider_model(
    project_id: String,
    provider_id: String,
    model: String,
) -> Result<(), String> {
    log::info!("setting provider model project_id={project_id} provider_id={provider_id}");
    config::with_config_lock(|| {
        let mut user_config = config::load_user_config()?;
        apply_set_provider_model(&mut user_config, &project_id, &provider_id, &model)?;
        config::save_user_config(&user_config)?;
        Ok(())
    })
    .map_err(|e: anyhow::Error| e.to_string())
}

/// Auto-defaults a `Local` provider's model via the discovery probe (mockable
/// in tests); the production impl reuses `discover_llm_models_with_fallback`.
#[async_trait::async_trait]
pub(crate) trait ModelAutoDefaultProbe: Send + Sync {
    async fn first_local_model(&self, entry_id: &str, base_url: &str) -> Result<String, String>;
}

/// Production probe: no transient credential (save path carries none) - falls
/// back to the stored per-project token file, matching discovery-time behavior.
struct LiveModelAutoDefaultProbe<'a> {
    active_project: Option<&'a str>,
}

#[async_trait::async_trait]
impl ModelAutoDefaultProbe for LiveModelAutoDefaultProbe<'_> {
    async fn first_local_model(&self, entry_id: &str, base_url: &str) -> Result<String, String> {
        let result = crate::llm_cmd::discovery::discover_llm_models_with_fallback(
            entry_id,
            base_url,
            None,
            None,
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

/// A settings save carries the full provider list but the UI never writes a
/// user-chosen model (Task 18); an incoming entry with no model inherits the
/// stored entry's model by id, so a plain resave can never erase it.
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

/// Applies decision 7 (spec `2026-07-16-chat-slash-commands-design.md` §4.5):
/// an OpenRouter entry saved with no model gets the verified default; a Local
/// entry saved with no model gets the first probed model. Runs BEFORE
/// `validate_provider_entries`/`validate_active_selection` so the
/// model-required invariant never trips for a fresh save. Explicit models
/// are never touched.
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

/// Applies an `LlmConfigUpdate` (Settings Save) to the active project.
/// Crash-recovery contract documented in ADR-040 §"Rollback".
#[tauri::command]
pub async fn update_llm_config(mut update: LlmConfigUpdate) -> Result<(), String> {
    // Canonicalize loopback hosts before validation so the persisted base_url
    // is the one the proxy container can reach.
    if config::is_local_provider(update.provider.as_deref()) {
        if let Some(url) = update.base_url.as_deref() {
            update.base_url = Some(speedwave_runtime::compose::canonicalize_local_base_url(url));
        }
    }
    if let Some(ref mut providers) = update.providers {
        canonicalize_provider_base_urls(providers);
        let loaded = config::load_user_config().ok();
        let stored_providers = loaded
            .as_ref()
            .and_then(|c| c.active_project_entry())
            .and_then(|p| p.claude.as_ref())
            .and_then(|c| c.llm.as_ref())
            .map(|llm| llm.providers.as_slice())
            .unwrap_or(&[]);
        // The settings component never carries a model control (Task 18); an
        // incoming entry with no model must inherit the stored one by id
        // BEFORE auto-default runs, or a plain resave triggers a live
        // discovery probe (or worse, clobbers a working model with `None`).
        preserve_stored_entry_models(providers, stored_providers);
        let active_project = loaded.and_then(|c| c.active_project);
        let probe = LiveModelAutoDefaultProbe {
            active_project: active_project.as_deref(),
        };
        apply_model_auto_defaults(providers, &probe).await?;
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
    // v2 saves (Task 18) never carry a flat `model` for a provider whose model
    // already lives in `providers[]` (preserved above); only fall back to the
    // legacy flat-field check when no v2 entry resolves a model for it.
    let local_model_in_providers = update
        .provider
        .as_deref()
        .and_then(|provider_id| {
            update
                .providers
                .as_ref()?
                .iter()
                .find(|p| p.id == provider_id)
        })
        .is_some_and(|entry| entry.model.as_deref().is_some_and(|m| !m.is_empty()));
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

    // v2 provider list (ADR-073): validate ids, base URLs and the active
    // selection before anything is persisted.
    if let Some(ref providers) = update.providers {
        validate_provider_entries(providers)?;
        if let Some(ref active) = update.active {
            validate_active_selection(providers, active)?;
        }
    }

    // Validate credentials *before* touching the filesystem.
    let api_key_action =
        resolve_credential_action(update.api_key.as_ref(), validate_api_key, "api_key")?;
    let custom_headers_action = resolve_credential_action(
        update.custom_headers.as_ref(),
        validate_custom_headers,
        "custom_headers",
    )?;

    config::with_config_lock(|| {
        let mut user_config = config::load_user_config()?;
        let active = user_config
            .active_project
            .clone()
            .ok_or_else(|| anyhow::anyhow!("No active project"))?;

        // Mutate credential files before `save_user_config` so a crash leaves
        // an orphan file (flag=false, ignored) not a flag → missing file.
        let mut new_has_api_key = lookup_has_flag(&user_config, &active, |c| c.has_api_key);
        let mut new_has_custom_headers =
            lookup_has_flag(&user_config, &active, |c| c.has_custom_headers);

        apply_credential_action(&active, "api_key", &api_key_action)?;
        match &api_key_action {
            CredentialAction::Keep => {}
            CredentialAction::Delete => new_has_api_key = false,
            CredentialAction::Write(_) => new_has_api_key = true,
        }

        apply_credential_action(&active, "custom_headers", &custom_headers_action)?;
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
        // v2 fields (ADR-073): the UI sends the full provider set; preserve
        // the stored one when absent so a legacy-shaped save cannot wipe it.
        let stored = user_config
            .active_project_entry()
            .and_then(|p| p.claude.as_ref())
            .and_then(|c| c.llm.clone())
            .unwrap_or_default();
        merged.providers = update.providers.clone().unwrap_or(stored.providers);
        merged.active = update.active.clone().or(stored.active);
        merged.proxy_enabled = update.proxy_enabled.or(stored.proxy_enabled);
        // The active pointer must not desync from the entry after the merge:
        // a resend with no active.model inherits the (now-preserved) entry model.
        if let Some(ref mut active) = merged.active {
            if active.model.is_none() {
                if let Some(entry) = merged.providers.iter().find(|p| p.id == active.provider_id) {
                    active.model = entry.model.clone();
                }
            }
        }
        // Anthropic entries never carry a stored model (spec 4.5): clear it
        // on every save, regardless of what the caller sent.
        merged.clear_active_anthropic_model();
        if !merged.providers.is_empty() {
            merged.schema_version = Some(config::LLM_SCHEMA_VERSION);
            // Keep the legacy flat fields coherent for the downgrade story.
            config::sync_llm_legacy_fields(&mut merged);
        }
        apply_llm_config(&mut user_config, merged)?;
        config::save_user_config(&user_config)?;
        log::info!(
            "persisted LLM config to active_project={:?}",
            user_config.active_project
        );
        Ok(())
    })
    .map_err(|e| e.to_string())
}

/// Single message for the model-required error (one wording everywhere).
fn model_required_error(provider_id: &str) -> String {
    format!("provider '{provider_id}' requires a model name")
}

/// Validates the active selection against the provider list before save (R5):
/// it must exist, no flag-collision, and the active-entry model invariant.
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
        // Reject if EITHER pointer or entry model is foreign — render derives
        // from the entry, so checking only `active.model` would miss it.
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
        // Render uses effective_active_model (entry wins), so the entry must
        // carry a model — an active.model-only value would be ignored at render.
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

/// Rewrites local entries' loopback base_url to the gateway alias, since only
/// that alias is reachable from inside the proxy container.
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

/// Validates a v2 provider list before save (ADR-073): slug ids, no
/// duplicates, SSRF-clean base URLs where the kind requires one.
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
            // Provenance: no foreign model under ANY anthropic entry, not just
            // the active one (the active-only check lives in validate_active_selection).
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

/// Writes/removes one provider's API key in `tokens/<project>/llm/` — never
/// config.json; updates the entry's `has_api_key` in the same lock (ADR-073).
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
                // update_llm_config normally rewrites providers wholesale; a
                // direct caller leaves has_api_key stuck false — surface that.
                log::warn!("provider '{provider_id}' not in config — has_api_key not updated");
            }
        }
        config::save_user_config(&user_config)?;
        Ok(())
    })
    .map_err(|e: anyhow::Error| e.to_string())
}

/// Clears the active LLM provider (logout → no provider). `update_llm_config`
/// can't: it merges `active.or(stored.active)`, treating None as "unchanged".
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

/// Re-renders compose and recreates ONLY the proxy service (ADR-073 hot
/// reload); claude keeps running. Full restart when the claude env changes.
#[tauri::command]
pub async fn restart_llm_proxy(project: String) -> Result<(), String> {
    check_project(&project)?;
    render_and_save_compose(&project)?;
    let rt = speedwave_runtime::runtime::detect_runtime();
    rt.compose_up_service(&project, "proxy")
        .map_err(|e| e.to_string())
}

/// Three possible outcomes of a tri-state credential field.
#[derive(Debug, Clone)]
enum CredentialAction {
    /// Field omitted in the request — preserve current on-disk state.
    Keep,
    /// Field explicit `null` or empty — remove on-disk file.
    Delete,
    /// Field non-empty — write (validated) value.
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
    project: &str,
    file: &str,
    action: &CredentialAction,
) -> anyhow::Result<()> {
    match action {
        CredentialAction::Keep => Ok(()),
        CredentialAction::Delete => {
            let path = speedwave_runtime::compose::tokens_path(project, "local-llm", file)?;
            // One syscall, no TOCTOU — `NotFound` is the expected idempotent case.
            match std::fs::remove_file(&path) {
                Ok(()) => log::info!("removed LLM token file {}", path.display()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.into()),
            }
            mirror_local_key_to_llm_namespace(project, file, None)?;
            Ok(())
        }
        CredentialAction::Write(value) => {
            speedwave_runtime::compose::ensure_token_dir(project, "local-llm")?;
            let path = speedwave_runtime::compose::tokens_path(project, "local-llm", file)?;
            speedwave_runtime::fs_perms::write_restricted_file_atomic(&path, value)?;
            log::info!(
                "wrote LLM token file {} ({} bytes)",
                path.display(),
                value.len()
            );
            mirror_local_key_to_llm_namespace(project, file, Some(value))?;
            Ok(())
        }
    }
}

/// Mirrors the local card's `api_key` into the proxy-read `llm/` namespace
/// (only `api_key`; non-fatal — failure keeps the proxy on the previous key).
fn mirror_local_key_to_llm_namespace(
    project: &str,
    file: &str,
    value: Option<&str>,
) -> anyhow::Result<()> {
    if file != "api_key" {
        return Ok(());
    }
    let data_dir = speedwave_runtime::consts::data_dir();
    let result = match value {
        Some(v) => speedwave_runtime::compose::write_llm_provider_key_in(
            data_dir.as_path(),
            project,
            "local",
            v,
        )
        .map(|_| ()),
        None => speedwave_runtime::compose::remove_llm_provider_key_in(
            data_dir.as_path(),
            project,
            "local",
        ),
    };
    if let Err(e) = result {
        log::warn!("failed to mirror local api_key to llm namespace: {e}");
    }
    Ok(())
}

// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "test assertions may unwrap/expect freely"
)]
mod tests {
    use super::*;
    use config::{ClaudeOverrides, LlmConfig, ProjectUserEntry, SpeedwaveUserConfig};

    /// Structural: every `start_containers` error string crossing IPC goes through
    /// the one condensing+sanitizing helper (the chain carries nerdctl argv echoes).
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
                            context_tokens: None,
                            has_api_key: false,
                            has_custom_headers: false,
                            ..Default::default()
                        }),
                    }),
                    integrations: None,
                    plugin_settings: None,
                },
            ],
            active_project: Some("alpha".to_string()),
            selected_ide: None,
            ui: None,
            telemetry: None,
        }
    }

    /// Test helper: builds a `LlmConfig` (`context_tokens` always `None`)
    /// for the lower-level `apply_llm_config`.
    fn llm(provider: &str, model: Option<&str>, base_url: Option<&str>) -> LlmConfig {
        LlmConfig {
            provider: Some(provider.to_string()),
            model: model.map(str::to_string),
            base_url: base_url.map(str::to_string),
            ..Default::default()
        }
    }

    /// Test helper: returns the `LlmConfigUpdate` Tauri DTO for callers that
    /// exercise the full `update_llm_config` save path.
    fn llm_update(provider: &str, model: Option<&str>, base_url: Option<&str>) -> LlmConfigUpdate {
        LlmConfigUpdate {
            provider: Some(provider.to_string()),
            model: model.map(str::to_string),
            base_url: base_url.map(str::to_string),
            ..Default::default()
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
        // beta already has claude.llm set

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
            }],
            active_project: None,
            selected_ide: None,
            ui: None,
            telemetry: None,
        };

        // Use a non-local provider so the new local-provider+model guard
        // doesn't short-circuit before the No-active-project check runs.
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
            }],
            active_project: Some("nonexistent".to_string()),
            selected_ide: None,
            ui: None,
            telemetry: None,
        };

        // Anthropic skips the local-provider+model guard so the project-not-
        // -found check is what surfaces.
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
        // Safety net for internal callers that build a `LlmConfig` directly
        // (the Tauri command checks earlier).
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
        // active_project is "alpha"

        apply_llm_config(&mut cfg, llm("ollama", Some("llama3.3"), None)).unwrap();

        // beta should be unchanged
        let beta = cfg.find_project("beta").unwrap();
        let beta_llm = beta.claude.as_ref().unwrap().llm.as_ref().unwrap();
        assert_eq!(beta_llm.provider.as_deref(), Some("anthropic"));
        assert_eq!(beta_llm.model.as_deref(), Some("claude-sonnet-4-6"));
    }

    #[tokio::test]
    async fn update_llm_config_rejects_local_provider_without_model() {
        // Local providers need a model; reject at save time. Iterate the SSOT
        // const so a future local backend is covered automatically.
        assert!(
            !config::LOCAL_PROVIDERS.is_empty(),
            "LOCAL_PROVIDERS must list at least one provider — this test \
             iterates it"
        );
        for provider in config::LOCAL_PROVIDERS {
            // Empty string also counts as "no model" — matches the frontend
            // guard in llm-provider.component.ts.
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
        // Anthropic isn't local — the model-required guard must not fire.
        let result = update_llm_config(llm_update("anthropic", None, None)).await;
        // May fail for project-config reasons; we only require the error is
        // NOT the model-required one.
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
        // Pure merge-step check (mirrors update_llm_config's preserve step,
        // without touching disk): a settings resave carrying `model: None`
        // must inherit the stored model by id, never clobber it.
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

    #[test]
    fn update_llm_config_merge_clears_anthropic_model() {
        // Pure merge-step check (mirrors update_llm_config's construction of
        // `merged`, without touching disk): an anthropic-kind active entry
        // must never carry a stored model after the merge.
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
        // Structural: the merge step in update_llm_config must call the
        // clearing helper before persisting - a call-site drift check since
        // the full save path touches real user config on disk in tests.
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
        // Regression: a `--`-prefixed model name could be parsed as another
        // CLI flag in the Claude Code invocation.
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

    // ── v2 provider list validation (ADR-073) ────────────────────────────

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

    // ── set_provider_model (narrow write-through, ADR-073 §4.3.2) ──────

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
        // Verifies anthropic-kind rejection: the entry.kind.is_anthropic() early
        // return rejects ANY model value for an anthropic-kind entry, including a
        // foreign-provider-shaped id - there is no separate foreign-model-shape
        // guard on this path (that check lives only in validate_active_selection).
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
    fn set_provider_model_command_uses_lock_and_saves() {
        // Structural: the Tauri wrapper must go through the same lock/save
        // path as every other config writer (set_llm_provider_key pattern).
        let src = include_str!("containers_cmd.rs");
        let start = src
            .find("pub fn set_provider_model(")
            .expect("set_provider_model command must exist");
        let body = &src[start..src[start..].find("\n}\n").map(|i| start + i).unwrap()];
        assert!(
            body.contains("with_config_lock"),
            "must use the config lock"
        );
        assert!(body.contains("save_user_config"), "must persist");
        assert!(
            body.contains("apply_set_provider_model"),
            "must delegate to the pure helper"
        );
    }

    // ── get_active_provider_summary (composer badge/combobox) ──────────

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
        // alpha has no claude config at all, so no active provider.

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
            // Local loopback → rewritten to the gateway alias.
            v2_entry("local", K::Local, Some("http://127.0.0.1:1234")),
            // Local localhost → rewritten.
            v2_entry("local2", K::Local, Some("http://localhost:11434")),
            // Local non-loopback (real LAN box) → untouched.
            v2_entry("remote", K::Local, Some("http://192.168.5.10:1234")),
            // Non-local kinds → never touched, even with a base_url present.
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
        // Local without a URL.
        let err = validate_provider_entries(&[v2_entry("local", K::Local, None)]).unwrap_err();
        assert!(err.contains("requires a base URL"), "got: {err}");
        // Metadata endpoint must fail the shared SSRF validator.
        assert!(validate_provider_entries(&[v2_entry(
            "local",
            K::Local,
            Some("http://169.254.169.254")
        )])
        .is_err());
        // Credentials embedded in the URL.
        assert!(validate_provider_entries(&[v2_entry(
            "remote",
            K::Local,
            Some("http://user:pass@example.com")
        )])
        .is_err());
    }

    // ── auto-default model at provider save (Task 11) ────────────────────

    /// Test double for the local-model probe: returns a fixed result or error
    /// without any network/VM access.
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
        // A probe that would fail/return something else if it were (wrongly) called.
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
        // Structural: the command must clear active (not merge-preserve it like
        // update_llm_config) and persist through the standard lock/save path.
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
        // Validation fires before the config lock / fs — even with no active
        // project the slug error must surface, not a project error.
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
        // CR#6: render uses effective_active_model (entry wins). active.model set
        // but entry.model empty would be ignored at render → reject at save.
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
        // Active anthropic (no model = account default, ok); the INACTIVE OR row
        // with no model must NOT trip the model-required check.
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
        // Dangling active id.
        assert!(validate_active_selection(&providers, &active("ghost", None)).is_err());
    }

    #[tokio::test]
    async fn update_llm_config_rejects_zero_context_tokens() {
        // Persisted `context_tokens = 0` divides-by-zero in the chat footer;
        // reject at the boundary so it never reaches the frontend.
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
        // Common model names contain dashes (e.g. `llama-3.3`, `qwen-coder`).
        // The guard only rejects leading dashes.
        let result = update_llm_config(llm_update(
            "ollama",
            Some("llama-3.3"),
            Some("http://localhost:11434"),
        ))
        .await;
        // The save itself may fail for project-config reasons in the test env,
        // but the model-name check must not be the reason.
        if let Err(e) = result {
            assert!(
                !e.to_lowercase().contains("flag collision"),
                "Middle-dash model must not trigger flag-collision guard, got: {e}"
            );
        }
    }

    #[tokio::test]
    async fn update_llm_config_rejects_invalid_base_url() {
        // Non-empty model so the model-required guard doesn't short-circuit
        // before URL validation — this exercises scheme rejection.
        let result = update_llm_config(llm_update(
            "ollama",
            Some("placeholder-model"),
            Some("javascript:alert(1)"),
        ))
        .await;
        assert!(result.is_err());
        let err = result.unwrap_err();
        // Either the new SSRF guard (scheme denylist) or the runtime syntactic
        // validator rejects this; both mention the allowed schemes.
        assert!(
            err.to_lowercase().contains("http"),
            "Error must reference the allowed http(s) scheme, got: {err}"
        );
    }

    #[tokio::test]
    async fn update_llm_config_accepts_v1_suffix() {
        // Regression: a `…/v1` URL must be accepted (render strips the suffix
        // before validating); the error, if any, must NOT be the path rejection.
        let result = update_llm_config(llm_update(
            "ollama",
            Some("llama3.3"),
            Some("http://localhost:11434/v1"),
        ))
        .await;
        if let Err(err) = result {
            assert!(
                !err.contains("must not contain a path"),
                "`/v1` suffix must be stripped before validation, got: {err}"
            );
        }
    }

    // Save-path SSRF coverage (ADR-041): the `validate_llm_base_url` guard
    // runs at the command boundary, before any config file is touched.

    /// Helper for SSRF URL tests; passes a placeholder model so the
    /// model-required guard doesn't short-circuit before URL validation.
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
        // `update_llm_config` may fail later (no active project) — we just need
        // the error (if any) NOT to be a URL rejection.
        let result = update_llm_config(llm_update(
            "ollama",
            Some("llama3.3"),
            Some("http://127.0.0.1:11434"),
        ))
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
        let result = update_llm_config(llm_update(
            "ollama",
            Some("llama3.3"),
            Some("http://192.168.1.50:11434"),
        ))
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
        // Per ADR-041: user-written URL == user's threat model (align with Redmine).
        let result = update_llm_config(llm_update(
            "ollama",
            Some("x"),
            Some("http://my-ollama.company.com"),
        ))
        .await;
        if let Err(err) = result {
            assert!(
                !err.to_lowercase().contains("blocked"),
                "public domain must NOT be rejected by URL validation, got: {err}"
            );
        }
    }

    // -- get_default_base_url tests --

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

    // -- project_llm_is_unconfigured_in tests --

    #[test]
    fn project_llm_is_unconfigured_in_true_for_fresh_project() {
        // alpha has no claude override at all — the fresh, first-class no-provider state.
        let cfg = make_config_with_active_project();
        let result = project_llm_is_unconfigured_in(&cfg, "alpha");
        assert_eq!(result, Ok(true));
    }

    #[test]
    fn project_llm_is_unconfigured_in_false_for_configured_provider() {
        // beta has an unmigrated legacy `provider: anthropic` — resolve_project_config
        // runs it through migrate_llm, so it resolves to a usable active provider.
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

    // -- MockRuntime for switch/teardown tests --

    use speedwave_runtime::runtime::mock_runtime::MockRuntimeBuilder;

    // -- teardown_only tests --

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

    // -- switch_project_core tests --

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

    #[test]
    fn switch_core_happy_path_with_previous() {
        let (rt, handles) = MockRuntimeBuilder::new().build();
        let prev = Some("prev".to_string());
        let result = switch_project_core(&prev, "new", &rt, &ok_recreate);
        // Previous is handed back for background teardown, never downed here.
        match result {
            SwitchResult::Succeeded { teardown } => assert_eq!(teardown.as_deref(), Some("prev")),
            SwitchResult::Failed { error, .. } => panic!("expected Succeeded, got: {error}"),
        }
        assert!(handles.down_projects().is_empty());
    }

    /// Behavioral: the switch closure brings the destination up via idempotent
    /// `compose_up`, NOT `compose_up_recreate` (the ADR-072 perf decision).
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
        // No teardown when prev == new
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
        // No compose calls when ensure_ready fails
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
                // teardown_only(new) succeeded → no cleanup_error
                assert!(cleanup_error.is_none(), "got: {cleanup_error:?}");
            }
            SwitchResult::Succeeded { .. } => panic!("expected Failed"),
        }
        // Failed start tears down only the partial new project — previous
        // was never stopped, so no restore is needed or performed.
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
        // Previous untouched even when the cleanup itself fails.
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
                // teardown_only succeeded → no cleanup_error
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
        // down(new) for teardown only — previous untouched
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
        // down(new) for teardown only
        assert_eq!(handles.down_projects(), vec!["new"]);
        assert!(handles.up_projects().is_empty());
    }

    // -- background teardown registry tests --

    // Serialized via `serial(teardown_intents)`: these share the on-disk
    // intents file; parallel runs race the .tmp create/remove vs assert.
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
        // State transition: wait joins the in-flight teardown before returning.
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
        // Error path: failed teardown is logged, wait still joins cleanly.
        wait_for_pending_teardown("bg-fail-proj");
        assert!(!pending_teardowns_lock().contains_key("bg-fail-proj"));
    }

    #[test]
    #[serial_test::serial(teardown_intents)]
    fn teardown_intent_recorded_and_cleared_on_success() {
        let project = format!("intent-ok-{}", std::process::id());
        spawn_background_teardown_with(project.clone(), |_p| Ok(()));
        wait_for_pending_teardown(&project);
        // Success path: intent must not survive the completed teardown.
        assert!(!crashed_teardown_intents().contains(&project));
    }

    #[test]
    #[serial_test::serial(teardown_intents)]
    fn teardown_intent_survives_failed_teardown_for_next_launch() {
        let project = format!("intent-fail-{}", std::process::id());
        spawn_background_teardown_with(project.clone(), |_p| Err("down failed".to_string()));
        wait_for_pending_teardown(&project);
        // Failure path: the intent stays so the next launch converges it.
        assert!(crashed_teardown_intents().contains(&project));
        clear_teardown_intent(&project);
        assert!(!crashed_teardown_intents().contains(&project));
    }

    #[test]
    fn wait_for_pending_teardown_is_noop_without_entry() {
        wait_for_pending_teardown("bg-absent-proj");
    }

    #[test]
    #[serial_test::serial(teardown_intents)]
    fn teardown_intent_write_is_durable_atomic_rename() {
        let project = format!("intent-atomic-{}", std::process::id());
        record_teardown_intent(&project);
        let path = teardown_intents_path();
        let content = std::fs::read_to_string(&path).unwrap();
        assert!(content.lines().any(|l| l == project));
        // No leftover tempfile from the write-then-rename.
        let stray = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .filter_map(Result::ok)
            .any(|e| e.file_name().to_string_lossy().starts_with("write-"));
        assert!(!stray, "no tempfile should remain after atomic rename");
        clear_teardown_intent(&project);
    }

    #[cfg(unix)]
    #[test]
    #[serial_test::serial(teardown_intents)]
    fn teardown_intents_file_is_not_owner_restricted() {
        use std::os::unix::fs::PermissionsExt;
        let project = format!("intent-perm-{}", std::process::id());
        record_teardown_intent(&project);
        let path = teardown_intents_path();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o644, "shared intents file must stay world-readable");
        clear_teardown_intent(&project);
    }

    #[test]
    #[serial_test::serial(teardown_intents)]
    fn background_teardown_replaces_stale_entry_for_same_project() {
        spawn_background_teardown_with("bg-dup-proj".to_string(), |_p| Ok(()));
        spawn_background_teardown_with("bg-dup-proj".to_string(), |_p| Ok(()));
        wait_for_pending_teardown("bg-dup-proj");
        assert!(!pending_teardowns_lock().contains_key("bg-dup-proj"));
    }

    /// Structural: the build script must gate the build-context hash root on
    /// COMPLETENESS of declared hash inputs — CI stubs create the dirs only.
    #[test]
    fn build_script_requires_complete_context_for_hash_root() {
        let source = include_str!("../build.rs");
        assert!(
            source.contains("flat_map(|img| img.hash_inputs.iter())")
                && source.contains("all(|input| build_context.join(input).exists())"),
            "partial/stubbed build-context must fall back to the repo root"
        );
    }

    /// Structural: add_project's closure must lazy-build project images before
    /// start_containers — repo-enabled integrations would otherwise fail up.
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

    /// Compose file check must precede compose_ps (else nerdctl fatally errors).
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

    /// Structural: add_project must check for a missing LLM provider BEFORE start_containers, else
    /// render_compose bails and teardown_only targets a never-written compose.yml.
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

    // -- add_project flow tests: switch_project_core with a closure that calls
    //    check_project + start_containers (previous handed back for teardown) --

    /// Simulates the add_project closure: check_project (always ok in tests)
    /// + start_containers (delegates to compose_up to simulate container start).
    fn add_project_recreate(
        proj: &str,
        rt: &speedwave_runtime::runtime::LockedRuntime,
    ) -> Result<(), String> {
        // In production: check_project(proj)? + start_containers(proj)
        // start_containers calls ensure_ready (noop) + render + compose_up
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
        // ensure_ready → up(new); previous handed back for background teardown
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
                // teardown_only(new) ok → no cleanup_error
                assert!(cleanup_error.is_none(), "got: {cleanup_error:?}");
            }
            SwitchResult::Succeeded { .. } => panic!("expected Failed"),
        }
        // down(new) for teardown only; previous keeps running — no restore
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
        // No previous → no down, only up(new)
        assert!(handles.down_projects().is_empty());
        assert_eq!(handles.up_projects(), vec!["new"]);
    }

    /// A closure that skips to `Ok(())` for a no-provider project must
    /// succeed with no compose_up/compose_down calls at all.
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
        // IMAGES_READY defaults to Ready — ensure_images_ready should return Ok
        let result = ensure_images_ready();
        assert!(result.is_ok());
    }

    #[test]
    fn test_run_system_check_calls_check_os_warnings() {
        let source = include_str!("containers_cmd.rs");
        let fn_start = source
            .find("pub async fn run_system_check()")
            .expect("run_system_check function must exist");
        // Find the next function boundary (next `pub async fn` or `pub fn` or end of file)
        let fn_body = &source[fn_start..];
        assert!(
            fn_body.contains("check_os_warnings"),
            "run_system_check must call check_os_warnings()"
        );
    }

    /// Structural: `start_containers()` flips `is_setup_complete()` last, so it
    /// must `refresh_tray_menu` to surface the ADR-058 beta toggle.
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

    /// Structural: `create_project()` must NOT `refresh_tray_menu` — it runs
    /// before `is_setup_complete()`, so the rebuild would drop the beta toggle.
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

    /// Structural test: host workers must eager-start before the compose
    /// render, or the first chat message recreates containers mid-session.
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

    // Local-LLM credential validators
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn validate_api_key_accepts_normal_value() {
        let r = super::validate_api_key("sk-test-abcdef0123").unwrap();
        assert_eq!(r, "sk-test-abcdef0123");
    }

    #[test]
    fn validate_api_key_strips_bearer_prefix() {
        // Common paste-from-curl mistake.
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
        // Pasting just "Bearer " (forgot to copy the token) must surface an
        // actionable error, not silently turn into a Delete action.
        let err = super::validate_api_key("Bearer ").unwrap_err();
        assert!(
            err.contains("'Bearer '"),
            "error must mention the Bearer prefix: {err}"
        );
        // Case-insensitive variant + extra whitespace must also error.
        assert!(super::validate_api_key("bearer  ").is_err());
        assert!(super::validate_api_key("BEARER  \t").is_err());
    }

    #[test]
    fn validate_api_key_empty_input_returns_empty_string() {
        // Empty input is the explicit "clear the key" signal — accepted.
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
        // CRLF injection defense — must not let an attacker terminate the
        // header and inject a body.
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
        // RFC 7230 token excludes whitespace, colon, and CTL chars.
        assert!(super::validate_custom_headers("X Foo: bar").is_err());
        assert!(super::validate_custom_headers("X(Foo): bar").is_err());
        assert!(super::validate_custom_headers("X@Foo: bar").is_err());
    }

    #[test]
    fn validate_custom_headers_accepts_full_rfc7230_token_chars() {
        // Underscore and dot are valid RFC 7230 token chars (accepted by
        // HeaderName::from_bytes); the old hand-rolled allow-list rejected them.
        super::validate_custom_headers("X_Trace_Id: abc").unwrap();
        super::validate_custom_headers("X.Trace-Id: abc").unwrap();
        super::validate_custom_headers("X-Custom!Header: abc").unwrap();
    }

    #[test]
    fn validate_custom_headers_rejects_oversize() {
        let oversize = format!("X-A: {}", "x".repeat(16 * 1024));
        assert!(super::validate_custom_headers(&oversize).is_err());
    }

    // -- remove_project_core tests --

    use std::cell::RefCell;

    #[test]
    fn remove_project_core_happy_path() {
        let (rt, handles) = MockRuntimeBuilder::new().build();
        let removed = RefCell::new(Vec::<String>::new());
        let result = remove_project_core("alpha", &rt, &|n| {
            removed.borrow_mut().push(n.to_string());
            Ok(())
        });
        assert!(result.is_ok());
        assert_eq!(handles.down_projects(), vec!["alpha"]);
        assert_eq!(*removed.borrow(), vec!["alpha"]);
    }

    #[test]
    fn remove_project_core_compose_down_failure_aborts_remove() {
        let (rt, _handles) = MockRuntimeBuilder::new()
            .with_fail_on_down(&["alpha"])
            .build();
        let remove_calls = RefCell::new(0u32);
        let result = remove_project_core("alpha", &rt, &|_| {
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
        // The watchdog can fire for a project the user switched away from;
        // without this first-line guard it resurrects the torn-down project.
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
        // Race guard: this helper can fire mid-rebuild (oauth respawn /
        // watchdog); without the gate nerdctl emits image-not-available.
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

    /// Returns the body of a function by signature: locates the signature,
    /// then walks brace depth from the next `{` to its matching `}`.
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

    // ── telemetry command helpers ───────────────────────────────────────────

    #[test]
    fn apply_update_rejects_locked_field_and_leaves_it_unchanged() {
        use speedwave_runtime::config::{
            resolve_telemetry, ManagedTelemetryConfig, TelemetryConfig,
        };
        // MDM locks `endpoint`; user tries to change endpoint (locked) + resource_attributes (free).
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
        // MDM locks the master switch (enabled=true); endpoint stays free. A save
        // that resends the resolved `enabled` value plus a real endpoint edit must
        // succeed in full — the unchanged locked field is a no-op, not a rejection.
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

        // Some(None) clears a previously-saved interval back to the exporter default.
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

        // Some(Some(v)) sets it.
        let update = TelemetryConfigUpdate {
            metric_export_interval_ms: Some(Some(9000)),
            ..Default::default()
        };
        apply_telemetry_update_with(&mut user, update, &resolved);
        assert_eq!(user.metric_export_interval_ms, Some(9000));

        // Omitted (None) leaves it untouched.
        let update = TelemetryConfigUpdate::default();
        apply_telemetry_update_with(&mut user, update, &resolved);
        assert_eq!(user.metric_export_interval_ms, Some(9000), "omit must keep");
    }

    #[test]
    fn resolve_failure_is_not_masked_as_unlocked() {
        // MDM enabled=true with no endpoint is a fail-closed resolve error the
        // update path must propagate, never mask as all-unlocked.
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
        // The A1 guard: the post-update state is re-resolved before persisting,
        // so enabling telemetry without a valid endpoint is rejected at save time.
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
        // Ordering guard (same pattern as main.rs ExitRequested guard): the watcher
        // stop, oauth stop, and the teardown drain must precede the wipe inside factory_reset.
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
}
