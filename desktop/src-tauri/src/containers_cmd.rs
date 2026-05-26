// Container lifecycle and setup wizard Tauri commands.
//
// Extracted from main.rs — thin #[tauri::command] wrappers that delegate to
// `setup_wizard` and `speedwave_runtime` functions, converting errors to
// `Result<T, String>` for Tauri's serialization boundary.

use speedwave_runtime::config;

use crate::reconcile::{SharedIdeBridge, SharedMcpOs};
use crate::setup_wizard;
use crate::types::{check_project, LlmConfigResponse, LlmConfigUpdate};

/// Maximum bytes accepted for the local-LLM `api_key` token file. 64 KiB is
/// generous for OAuth/JWT bearers; anything larger is almost certainly a paste
/// error or hostile input.
const MAX_API_KEY_BYTES: usize = 64 * 1024;
/// Maximum bytes accepted for the `custom_headers` blob (multi-line
/// `Name: Value`). 16 KiB covers realistic header counts without enabling
/// arbitrary blob storage.
const MAX_CUSTOM_HEADERS_BYTES: usize = 16 * 1024;

/// Disallowed header names (case-insensitive). These either collide with
/// Speedwave-managed semantics (`Authorization` comes from `api_key`) or are
/// hop-by-hop/transport headers that shouldn't be set by the caller.
const FORBIDDEN_HEADER_NAMES: &[&str] = &[
    "authorization",
    "cookie",
    "host",
    "content-length",
    "transfer-encoding",
];

/// Validates and normalises an `api_key` before persisting. An empty result
/// after `Bearer ` strip is an explicit error so the user gets an actionable
/// message — passing `""` to clear the key is a separate code path
/// (`save_compose` deletes the file when the resolver yields `Delete`).
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
    // A bare `Bearer` (no token after it) reaches `strip_bearer_prefix` only
    // when the trailing space survives the trim — but `trimmed` already
    // removed it. Detect the prefix-only case explicitly so the user sees
    // the actionable error instead of having the stripper return `Some("Bearer")`.
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

/// Maximum time to wait for container images to become ready before failing.
/// The Angular frontend shows a "Rebuilding container images..." overlay while
/// Tauri commands block on this timeout via `wait_for_images_ready()`.
/// If this value changes, update the UX expectations in project-state.service.ts.
const RECONCILE_WAIT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(600);

/// Blocks until container images are ready (reconcile complete) or timeout.
/// Called before any operation that starts containers.
pub(crate) fn ensure_images_ready() -> Result<(), String> {
    crate::reconcile::wait_for_images_ready(RECONCILE_WAIT_TIMEOUT)
}

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
    rt: &speedwave_runtime::runtime::LockedRuntime,
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
pub(crate) fn teardown_only(
    new_project: &str,
    rt: &speedwave_runtime::runtime::LockedRuntime,
) -> Option<String> {
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
    rt: &speedwave_runtime::runtime::LockedRuntime,
) -> Result<(), String> {
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
        Some(rt),
        &crate::reconcile::current_bridges_info(),
    )
    .map_err(|e| e.to_string())?;

    let manifests = speedwave_runtime::plugin::list_installed_plugins().unwrap_or_else(|e| {
        log::warn!("Failed to list installed plugins: {e}");
        Vec::new()
    });
    let expected_paths =
        speedwave_runtime::compose::SecurityExpectedPaths::compute(project, &project_dir)
            .map_err(|e| e.to_string())?;
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
        switch_project_core(&prev_clone, &new_clone, &rt, &|proj, _rt| {
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
    crate::ensure_mcp_os_running(&mcp_os, &app);
    crate::ensure_ide_bridge_running(&ide_bridge, &app);

    tokio::task::spawn_blocking(move || {
        ensure_images_ready()?;
        check_project(&project)?;
        // Pre-flight: detect CloudStorage TCC denial before attempting container start.
        if let Ok(cfg) = speedwave_runtime::config::load_user_config() {
            if let Some(p) = cfg.find_project(&project) {
                speedwave_runtime::cloudstorage::check_project_readable_or_err(
                    std::path::Path::new(&p.dir),
                )?;
            }
        }
        log::info!("start_containers: project={project}");
        setup_wizard::start_containers(&project).map_err(|e| {
            log::error!("start_containers: error: {e}");
            e.to_string()
        })
    })
    .await
    .map_err(|e| e.to_string())??;

    // `start_containers` is the last setup step that flips `is_setup_complete()`
    // (the wizard order is runtime_ready → vm_ready → images_built →
    // project_created → containers_started; cli_linked is independent). Rebuild
    // the tray here so setup-gated items (the ADR-058 beta toggle) appear
    // immediately after the wizard finishes.
    crate::tray::refresh_tray_menu(&app);
    Ok(())
}

#[tauri::command]
pub async fn check_claude_auth(project: String) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || {
        // check_claude_auth → setup_wizard::check_claude_auth → ensure_exec_healthy
        // can call compose_up_recreate; block on bundle reconcile first.
        ensure_images_ready()?;
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
        log::info!("recreate_project_containers: project={project}");
        let rt = speedwave_runtime::runtime::detect_runtime();
        rt.ensure_ready().map_err(|e| e.to_string())?;

        // Lazy build (ADR-057).
        if let Err(sanitized) = crate::integrations_cmd::ensure_project_images_built(&rt, &project)
        {
            log::error!("recreate_project_containers: image build failed: {sanitized}");
            return Err(format!("Image build failed: {sanitized}"));
        }

        use crate::types::IntoAnyhow;
        rt.transaction(&project, |rt| -> anyhow::Result<()> {
            let _ = rt.compose_down(&project);
            render_and_save_compose(&project, rt).into_anyhow()?;
            speedwave_runtime::runtime::compose_validate_with_retry(rt, &project)?;
            rt.compose_up_recreate(&project)?;
            Ok(())
        })
        .map_err(|e| e.to_string())?;

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
        .and_then(|c| c.llm.clone())
        .unwrap_or_default();
    let default_base_url = llm
        .provider
        .as_deref()
        .and_then(speedwave_runtime::compose::default_base_url);

    // Non-destructive migration: if a previously-stored base_url no longer
    // satisfies the current SSRF policy (e.g. someone saved `http://169.254.169.254`
    // before the policy was introduced), log a warning. The value is still
    // returned so the UI can show it in the input; the Save path will reject
    // it on the user's next edit. See ADR-041.
    if let Some(ref url) = llm.base_url {
        let normalized = speedwave_runtime::compose::strip_trailing_v1(url);
        if let Err(e) = crate::llm_cmd::validate_llm_base_url(&normalized) {
            log::warn!("get_llm_config: stored base_url '{url}' fails current SSRF policy: {e}");
        }
    }

    Ok(LlmConfigResponse {
        llm,
        default_base_url,
    })
}

/// Returns the backend-authoritative default base URL for a given provider.
///
/// Delegates to `speedwave_runtime::compose::default_base_url` so the frontend
/// never needs to duplicate URL strings. Returns `None` for unknown providers
/// (e.g. `"anthropic"` has no local server URL).
#[tauri::command]
pub fn get_default_base_url(provider: String) -> Result<Option<String>, String> {
    Ok(speedwave_runtime::compose::default_base_url(&provider))
}

/// Returns the SSOT list of Anthropic models surfaced in
/// `Settings → LLM Provider`. Backend owns the catalog so the frontend has
/// no model strings hard-coded — bumping a model means editing a single
/// const in `defaults.rs`. The struct already derives `Serialize`, so the
/// `&'static str` fields cross the Tauri IPC boundary directly without a
/// mirror DTO.
#[tauri::command]
pub fn list_anthropic_models() -> &'static [speedwave_runtime::defaults::AnthropicModelInfo] {
    speedwave_runtime::defaults::ANTHROPIC_MODELS
}

/// Returns the display label of the Opus model that the dropdown's
/// `(default)` option resolves to at runtime — used by the Settings UI to
/// render an honest hint like *"Default — Opus 4.7 (switchable via /model)"*
/// instead of the previous vague *"let Claude Code choose"* placeholder.
///
/// `None` when the SSOT has no `latest = true` Opus family — frontend then
/// falls back to the generic placeholder.
#[tauri::command]
pub fn get_default_anthropic_model_label() -> Option<&'static str> {
    speedwave_runtime::defaults::default_anthropic_family_label()
}

/// Applies LLM config to the active project in-memory. Extracted for
/// testability and reused by `update_llm_config`.
///
/// Cross-field invariants are enforced here, not just in `update_llm_config`:
/// internal callers that build a `LlmConfig` directly (setup wizard, future
/// migration paths) must not be able to persist `provider=<local>, model=None`.
/// The Tauri command performs the same checks earlier so the user gets a
/// human-readable error before the save attempt; the duplicated guard here is
/// the safety net.
fn apply_llm_config(
    user_config: &mut config::SpeedwaveUserConfig,
    update: config::LlmConfig,
) -> anyhow::Result<()> {
    if config::is_local_provider(update.provider.as_deref())
        && update.model.as_deref().is_none_or(str::is_empty)
    {
        return Err(anyhow::anyhow!(
            "Provider '{}' requires a model name",
            update.provider.as_deref().unwrap_or("")
        ));
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

/// Applies an `LlmConfigUpdate` (Settings Save) to the active project.
/// Crash-recovery contract documented in ADR-040 §"Rollback".
#[tauri::command]
pub fn update_llm_config(update: LlmConfigUpdate) -> Result<(), String> {
    log::info!(
        "update_llm_config: provider={:?} model={:?} context_tokens={:?} \
         api_key_change={} custom_headers_change={}",
        update.provider,
        update.model,
        update.context_tokens,
        update.api_key.is_some(),
        update.custom_headers.is_some(),
    );
    if config::is_local_provider(update.provider.as_deref())
        && update.model.as_deref().is_none_or(str::is_empty)
    {
        return Err(format!(
            "Provider '{}' requires a model name. \
             Configure it in Settings → LLM Provider → Model.",
            update.provider.as_deref().unwrap_or("")
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
            "update_llm_config: base_url={}://{}{port_str}",
            parsed.scheme(),
            parsed.host_str().unwrap_or("<no-host>"),
        );
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

        // Apply credential file mutations now that we hold the lock. This
        // happens before `save_user_config` so a crash leaves an orphan file
        // (flag=false → compose ignores it) rather than a flag pointing at a
        // missing file.
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

        let merged = config::LlmConfig {
            provider: update.provider,
            model: update.model,
            base_url: update.base_url,
            context_tokens: update.context_tokens,
            has_api_key: new_has_api_key,
            has_custom_headers: new_has_custom_headers,
        };
        apply_llm_config(&mut user_config, merged)?;
        config::save_user_config(&user_config)?;
        log::info!(
            "update_llm_config: persisted to active_project={:?}",
            user_config.active_project
        );
        Ok(())
    })
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
                Ok(()) => log::info!("update_llm_config: removed token file {}", path.display()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.into()),
            }
            Ok(())
        }
        CredentialAction::Write(value) => {
            speedwave_runtime::compose::ensure_token_dir(project, "local-llm")?;
            let path = speedwave_runtime::compose::tokens_path(project, "local-llm", file)?;
            speedwave_runtime::fs_perms::write_restricted_file_atomic(&path, value)?;
            log::info!(
                "update_llm_config: wrote token file {} ({} bytes)",
                path.display(),
                value.len()
            );
            Ok(())
        }
    }
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
                            context_tokens: None,
                            has_api_key: false,
                            has_custom_headers: false,
                        }),
                    }),
                    integrations: None,
                    plugin_settings: None,
                },
            ],
            active_project: Some("alpha".to_string()),
            selected_ide: None,
            transcription: None,
            ui: None,
        }
    }

    /// Builds a `LlmConfig` for tests. `context_tokens` is always `None` —
    /// every test in this module covers the boundary either via a real
    /// provider (where context is discovered, not hand-set) or via the
    /// model/url validation guards that run before context is consulted.
    /// Centralising the literal so adding a future `LlmConfig` field
    /// touches one helper, not 14 inline struct expressions.
    /// Test helper: returns the legacy `LlmConfig` for callers that exercise
    /// the lower-level `apply_llm_config` (the in-memory mutator).
    fn llm(provider: &str, model: Option<&str>, base_url: Option<&str>) -> LlmConfig {
        LlmConfig {
            provider: Some(provider.to_string()),
            model: model.map(str::to_string),
            base_url: base_url.map(str::to_string),
            context_tokens: None,
            has_api_key: false,
            has_custom_headers: false,
        }
    }

    /// Test helper: returns the `LlmConfigUpdate` Tauri DTO for callers that
    /// exercise the full `update_llm_config` save path.
    fn llm_update(provider: &str, model: Option<&str>, base_url: Option<&str>) -> LlmConfigUpdate {
        LlmConfigUpdate {
            provider: Some(provider.to_string()),
            model: model.map(str::to_string),
            base_url: base_url.map(str::to_string),
            context_tokens: None,
            api_key: None,
            custom_headers: None,
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
            transcription: None,
            ui: None,
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
            transcription: None,
            ui: None,
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
            transcription: None,
            ui: None,
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
        // The Tauri command performs the same check earlier — this guard is
        // the safety net for internal callers (setup wizard, future migration
        // paths) that build a `LlmConfig` directly.
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

    #[test]
    fn update_llm_config_rejects_local_provider_without_model() {
        // Local providers can't start a session without a model —
        // `compose::apply_llm_config` would reject the compose render.
        // Catching it at save time prevents the config from persisting a
        // state that only fails when the user tries to run.
        //
        // Enumerate every local provider via the SSOT const so a future
        // addition (a fourth local backend) is automatically covered.
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
                ));
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

    #[test]
    fn update_llm_config_accepts_anthropic_without_model() {
        // Anthropic is not a local provider — the model-required guard must
        // not fire. The Anthropic path has its own default model handling.
        let result = update_llm_config(llm_update("anthropic", None, None));
        // Either succeeds or fails for project-config reasons in the test env
        // (no active project) — what we require is that the error is NOT the
        // model-required one.
        if let Err(err) = result {
            assert!(
                !err.contains("requires a model name"),
                "Anthropic with no model must not trigger the local-provider \
                 model-required guard, got: {err}"
            );
        }
    }

    #[test]
    fn update_llm_config_rejects_model_with_flag_prefix() {
        // Regression: a model name starting with `--` would be rendered as
        // `--model --dangerously-skip-permissions` in the Claude Code
        // invocation; argument parsers may treat the value as another flag.
        let result = update_llm_config(llm_update(
            "ollama",
            Some("--dangerously-skip-permissions"),
            Some("http://localhost:11434"),
        ));
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            err.to_lowercase().contains("flag"),
            "Error must reference the flag collision, got: {err}"
        );
    }

    #[test]
    fn update_llm_config_rejects_model_with_single_dash_prefix() {
        let result = update_llm_config(llm_update(
            "ollama",
            Some("-h"),
            Some("http://localhost:11434"),
        ));
        assert!(result.is_err());
    }

    #[test]
    fn update_llm_config_rejects_zero_context_tokens() {
        // Persisted `context_tokens = 0` would divide-by-zero in the chat
        // footer's used/max calculation. Reject at the boundary so the value
        // never reaches the frontend.
        let result = update_llm_config(LlmConfigUpdate {
            provider: Some("ollama".to_string()),
            model: Some("llama3.3".to_string()),
            base_url: Some("http://localhost:11434".to_string()),
            context_tokens: Some(0),
            api_key: None,
            custom_headers: None,
        });
        assert!(result.is_err());
        assert!(
            result.unwrap_err().contains("context_tokens"),
            "error must mention context_tokens"
        );
    }

    #[test]
    fn update_llm_config_accepts_model_with_dash_in_middle() {
        // Common model names contain dashes (e.g. `llama-3.3`, `qwen-coder`).
        // The guard only rejects leading dashes.
        let result = update_llm_config(llm_update(
            "ollama",
            Some("llama-3.3"),
            Some("http://localhost:11434"),
        ));
        // The save itself may fail for project-config reasons in the test env,
        // but the model-name check must not be the reason.
        if let Err(e) = result {
            assert!(
                !e.to_lowercase().contains("flag collision"),
                "Middle-dash model must not trigger flag-collision guard, got: {e}"
            );
        }
    }

    #[test]
    fn update_llm_config_rejects_invalid_base_url() {
        // Non-empty model so the model-required guard doesn't short-circuit
        // before URL validation runs — this test exercises URL scheme
        // rejection, not model handling.
        let result = update_llm_config(llm_update(
            "ollama",
            Some("placeholder-model"),
            Some("javascript:alert(1)"),
        ));
        assert!(result.is_err());
        let err = result.unwrap_err();
        // Either the new SSRF guard (scheme denylist) or the runtime syntactic
        // validator rejects this; both mention the allowed schemes.
        assert!(
            err.to_lowercase().contains("http"),
            "Error must reference the allowed http(s) scheme, got: {err}"
        );
    }

    #[test]
    fn update_llm_config_accepts_v1_suffix() {
        // Regression: a `…/v1` URL (common in Ollama/LiteLLM docs) must be accepted
        // at save time because compose rendering strips the suffix before validating.
        // Previously this produced a false "base_url must not contain a path" error.
        // We only check the URL-validation path here — a config-save error is fine,
        // what we require is that the error (if any) is NOT the path rejection.
        let result = update_llm_config(llm_update(
            "ollama",
            Some("llama3.3"),
            Some("http://localhost:11434/v1"),
        ));
        if let Err(err) = result {
            assert!(
                !err.contains("must not contain a path"),
                "`/v1` suffix must be stripped before validation, got: {err}"
            );
        }
    }

    // ── Save-path SSRF coverage (ADR-041) ────────────────────────────────
    //
    // Before these tests, `update_llm_config` ran only compose::validate_base_url,
    // which accepts `http://169.254.169.254` and friends. The new
    // `llm_cmd::validate_llm_base_url` guard closes that hole — these tests
    // exercise it at the command boundary. Validation fails before the config
    // file is touched, so no fixture/lock setup is required.

    /// Helper for SSRF URL-validation tests. Passes a placeholder model so the
    /// model-required guard doesn't short-circuit before the URL is validated
    /// — these tests exercise URL validation specifically, not model handling.
    fn url_rejection_err(url: &str) -> String {
        update_llm_config(llm_update("ollama", Some("placeholder-model"), Some(url))).unwrap_err()
    }

    #[test]
    fn update_llm_config_rejects_metadata_ip() {
        let err = url_rejection_err("http://169.254.169.254:8080");
        assert!(
            err.to_lowercase().contains("private") || err.to_lowercase().contains("reserved"),
            "metadata IP must be rejected with a private/reserved error, got: {err}"
        );
    }

    #[test]
    fn update_llm_config_rejects_link_local_ipv6() {
        let err = url_rejection_err("http://[fe80::1]");
        assert!(
            err.to_lowercase().contains("private") || err.to_lowercase().contains("reserved"),
            "IPv6 link-local must be rejected, got: {err}"
        );
    }

    #[test]
    fn update_llm_config_rejects_credentials() {
        let err = url_rejection_err("http://user:pass@localhost:11434");
        assert!(
            err.to_lowercase().contains("credentials"),
            "embedded credentials must be rejected, got: {err}"
        );
    }

    #[test]
    fn update_llm_config_rejects_query_string() {
        let err = url_rejection_err("http://localhost:11434?foo=bar");
        assert!(
            err.to_lowercase().contains("query"),
            "query string must be rejected, got: {err}"
        );
    }

    #[test]
    fn update_llm_config_accepts_loopback_via_validation() {
        // `update_llm_config` may fail later (no active project) — we just need
        // the error (if any) NOT to be a URL rejection.
        let result = update_llm_config(llm_update(
            "ollama",
            Some("llama3.3"),
            Some("http://127.0.0.1:11434"),
        ));
        if let Err(err) = result {
            assert!(
                !err.to_lowercase().contains("private")
                    && !err.to_lowercase().contains("blocked")
                    && !err.to_lowercase().contains("credentials"),
                "loopback must NOT be rejected by URL validation, got: {err}"
            );
        }
    }

    #[test]
    fn update_llm_config_accepts_rfc1918_via_validation() {
        let result = update_llm_config(llm_update(
            "ollama",
            Some("llama3.3"),
            Some("http://192.168.1.50:11434"),
        ));
        if let Err(err) = result {
            assert!(
                !err.to_lowercase().contains("private") && !err.to_lowercase().contains("blocked"),
                "RFC1918 must NOT be rejected by URL validation, got: {err}"
            );
        }
    }

    #[test]
    fn update_llm_config_accepts_public_domain_via_validation() {
        // Per ADR-041: user-written URL == user's threat model (align with Redmine).
        let result = update_llm_config(llm_update(
            "ollama",
            Some("x"),
            Some("http://my-ollama.company.com"),
        ));
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

    // -- MockRuntime for switch/teardown tests --

    use speedwave_runtime::runtime::mock_runtime::MockRuntimeBuilder;

    // -- teardown_and_restore tests --

    #[test]
    fn teardown_and_restore_ok() {
        let (rt, handles) = MockRuntimeBuilder::new().build();
        let result = teardown_and_restore("new_proj", "prev_proj", &rt);
        assert!(result.is_ok());
        assert_eq!(handles.down_projects(), vec!["new_proj"]);
        assert_eq!(handles.up_projects(), vec!["prev_proj"]);
    }

    #[test]
    fn teardown_and_restore_up_fails() {
        let (rt, handles) = MockRuntimeBuilder::new()
            .with_fail_on_up(&["prev_proj"])
            .build();
        let result = teardown_and_restore("new_proj", "prev_proj", &rt);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            err.contains("restore 'prev_proj' failed"),
            "expected restore error, got: {err}"
        );
        assert_eq!(handles.down_projects(), vec!["new_proj"]);
        assert_eq!(handles.up_projects(), vec!["prev_proj"]);
    }

    #[test]
    fn teardown_and_restore_both_fail() {
        let (rt, _handles) = MockRuntimeBuilder::new()
            .with_fail_on_down(&["new_proj"])
            .with_fail_on_up(&["prev_proj"])
            .build();
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
        assert!(matches!(result, SwitchResult::Succeeded));
        assert_eq!(handles.down_projects(), vec!["prev"]);
    }

    #[test]
    fn switch_core_happy_path_no_previous() {
        let (rt, handles) = MockRuntimeBuilder::new().build();
        let result = switch_project_core(&None, "new", &rt, &ok_recreate);
        assert!(matches!(result, SwitchResult::Succeeded));
        assert!(handles.down_projects().is_empty());
    }

    #[test]
    fn switch_core_happy_path_same_project() {
        let (rt, handles) = MockRuntimeBuilder::new().build();
        let prev = Some("same".to_string());
        let result = switch_project_core(&prev, "same", &rt, &ok_recreate);
        assert!(matches!(result, SwitchResult::Succeeded));
        // No down call when prev == new
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
            SwitchResult::Succeeded => panic!("expected Failed"),
        }
        // No compose calls when ensure_ready fails
        assert!(handles.down_projects().is_empty());
        assert!(handles.up_projects().is_empty());
    }

    #[test]
    fn switch_core_down_prev_fails_up_prev_ok() {
        let (rt, handles) = MockRuntimeBuilder::new()
            .with_fail_on_down(&["prev"])
            .build();
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
        assert_eq!(handles.down_projects(), vec!["prev"]);
        assert_eq!(handles.up_projects(), vec!["prev"]);
    }

    #[test]
    fn switch_core_down_prev_fails_up_prev_fails() {
        let (rt, _handles) = MockRuntimeBuilder::new()
            .with_fail_on_down(&["prev"])
            .with_fail_on_up(&["prev"])
            .build();
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
        let (rt, handles) = MockRuntimeBuilder::new().build();
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
        assert_eq!(handles.down_projects(), vec!["prev", "new"]);
        // up(prev) for restore
        assert_eq!(handles.up_projects(), vec!["prev"]);
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
            SwitchResult::Succeeded => panic!("expected Failed"),
        }
        assert_eq!(handles.down_projects(), vec!["new"]);
        assert!(handles.up_projects().is_empty());
    }

    #[test]
    fn switch_core_recreate_fails_restore_fails() {
        let (rt, _handles) = MockRuntimeBuilder::new().with_fail_on_up(&["prev"]).build();
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
        let (rt, handles) = MockRuntimeBuilder::new().build();
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
        assert_eq!(handles.down_projects(), vec!["prev", "new"]);
        assert_eq!(handles.up_projects(), vec!["prev"]);
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
            SwitchResult::Succeeded => panic!("expected Failed"),
        }
        // down(new) for teardown only
        assert_eq!(handles.down_projects(), vec!["new"]);
        assert!(handles.up_projects().is_empty());
    }

    // -- add_project flow tests --
    //
    // add_project uses switch_project_core with a closure that calls
    // check_project + start_containers. These tests verify that specific
    // combination: ensure_ready → stop prev → start_containers(new),
    // distinct from switch_project which uses compose_down+render+up_recreate.

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
            SwitchResult::Succeeded => panic!("expected Failed"),
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
        assert!(matches!(result, SwitchResult::Succeeded));
        // ensure_ready → down(prev) → up(new) via start_containers
        assert_eq!(handles.down_projects(), vec!["prev"]);
        assert_eq!(handles.up_projects(), vec!["new"]);
    }

    #[test]
    fn add_project_down_prev_fails_restore_ok() {
        let (rt, handles) = MockRuntimeBuilder::new()
            .with_fail_on_down(&["prev"])
            .build();
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
        assert_eq!(handles.down_projects(), vec!["prev"]);
        assert_eq!(handles.up_projects(), vec!["prev"]);
    }

    #[test]
    fn add_project_start_containers_fails_restore_prev() {
        // start_containers fails → teardown_and_restore(new, prev)
        let (rt, handles) = MockRuntimeBuilder::new().build();
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
        assert_eq!(handles.down_projects(), vec!["prev", "new"]);
        // up(prev) for restore
        assert_eq!(handles.up_projects(), vec!["prev"]);
    }

    #[test]
    fn add_project_happy_path_no_previous() {
        let (rt, handles) = MockRuntimeBuilder::new().build();
        let result = switch_project_core(&None, "new", &rt, &add_project_recreate);
        assert!(matches!(result, SwitchResult::Succeeded));
        // No previous → no down, only up(new)
        assert!(handles.down_projects().is_empty());
        assert_eq!(handles.up_projects(), vec!["new"]);
    }

    #[test]
    fn ensure_images_ready_passes_through_when_ready() {
        // IMAGES_READY defaults to Ready — ensure_images_ready should return Ok
        let result = ensure_images_ready();
        assert!(result.is_ok());
    }

    #[test]
    fn check_claude_auth_waits_for_image_readiness() {
        // Race guard: setup_wizard::check_claude_auth -> ensure_exec_healthy ->
        // compose_up_recreate. Without this gate, polling auth at startup
        // while reconcile rebuilds images surfaces image-not-available.
        // The test extracts the body by brace-matching to avoid trailing
        // tests' source content (this file uses include_str! on itself).
        let source = include_str!("containers_cmd.rs");
        let fn_body = extract_fn_body_braced(source, "pub async fn check_claude_auth(");

        let ensure_pos = fn_body
            .find("ensure_images_ready(")
            .expect("check_claude_auth must call ensure_images_ready");
        let inner_call_pos = fn_body
            .find("setup_wizard::check_claude_auth(")
            .expect("check_claude_auth must delegate to setup_wizard::check_claude_auth");
        assert!(
            ensure_pos < inner_call_pos,
            "ensure_images_ready must come BEFORE setup_wizard::check_claude_auth"
        );
    }

    /// Returns the body of a function by signature: locates the signature,
    /// then walks brace depth from the next `{` to its matching `}`. Source
    /// after the function (including tests that quote it) is excluded.
    fn extract_fn_body_braced<'a>(source: &'a str, fn_signature: &str) -> &'a str {
        let sig_pos = source
            .find(fn_signature)
            .unwrap_or_else(|| panic!("{fn_signature} not found in source"));
        let after = &source[sig_pos..];
        let open = after
            .find('{')
            .expect("opening brace not found after signature");
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

    /// Structural test: `start_containers()` is the last setup step that flips
    /// `is_setup_complete()`. It must call `refresh_tray_menu` so the
    /// setup-gated tray items (the ADR-058 beta toggle) appear immediately
    /// after the wizard finishes — without a manual refresh.
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

    /// Structural test: `create_project()` must NOT call `refresh_tray_menu`.
    /// It runs at step 4 of 5, before `containers_started = true` is
    /// persisted, so `is_setup_complete()` would still return `false` and the
    /// tray rebuild would drop the beta toggle anyway (the bug fixed in this
    /// commit). The refresh belongs in `start_containers()` instead.
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

    // ─────────────────────────────────────────────────────────────────────
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
        // Underscore and dot are valid token chars per RFC 7230 — reqwest's
        // HeaderName::from_bytes accepts them. The handrolled allow-list
        // used to reject these and rejected valid headers like X_Trace_Id.
        super::validate_custom_headers("X_Trace_Id: abc").unwrap();
        super::validate_custom_headers("X.Trace-Id: abc").unwrap();
        super::validate_custom_headers("X-Custom!Header: abc").unwrap();
    }

    #[test]
    fn validate_custom_headers_rejects_oversize() {
        let oversize = format!("X-A: {}", "x".repeat(16 * 1024));
        assert!(super::validate_custom_headers(&oversize).is_err());
    }
}
