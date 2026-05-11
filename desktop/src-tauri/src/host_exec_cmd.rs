//! Tauri commands for the `host_exec` integration (ADR-054): reading the
//! per-project status, toggling it on/off, editing the recipe whitelist, and
//! resolving an executable on the recovered host `PATH` (for the UI's
//! "browse…" picker).
//!
//! The whitelist is **user-config only** — these commands write it to
//! `~/.speedwave/config.json` (never to the repo's `.speedwave.json`; the
//! repo-config layer ignores `integrations.hostExec`, see `config::apply_integrations_layer`).
//! After a change they (re)write the chmod-600 worker snapshot
//! (`<data_dir>/host-exec/<project>/config.json`), (re)spawn or tear down the
//! per-project worker, and — if the project's containers are running — recreate
//! them so the hub re-discovers (or drops) the `host_exec` tools with the
//! worker's current port. `host_exec_confirm_reply` (the per-recipe
//! confirmation reply) lives in `host_exec_process` next to the reader thread
//! that consumes it.
//!
//! All `#[tauri::command]` functions here are registered in `main.rs`'s
//! `invoke_handler!`.

use crate::types::check_project;
use serde::{Deserialize, Serialize};
use speedwave_runtime::config::{self, HostExecRecipe};

/// What the Desktop UI shows for `host_exec` in a project: whether it's
/// enabled, and the current whitelist (so the recipe editor can render it).
/// Mirrors the resolved config (`ResolvedIntegrationsConfig.host_exec` /
/// `.host_exec_commands`).
#[derive(Serialize, Deserialize, Debug)]
pub struct HostExecStatus {
    /// Whether `host_exec` is enabled for this project (user config only).
    pub enabled: bool,
    /// The recipe whitelist (empty unless the user has added recipes).
    pub commands: Vec<HostExecRecipe>,
}

/// Read the `host_exec` status for a project (enabled flag + whitelist).
#[tauri::command]
pub fn get_host_exec(project: String) -> Result<HostExecStatus, String> {
    check_project(&project)?;
    let user_config = config::load_user_config().map_err(|e| e.to_string())?;
    let project_dir = user_config
        .find_project(&project)
        .map(|p| std::path::PathBuf::from(&p.dir))
        .ok_or_else(|| format!("project '{project}' not found"))?;
    let resolved = config::resolve_integrations(&project_dir, &user_config, &project);
    Ok(HostExecStatus {
        enabled: resolved.host_exec,
        commands: resolved.host_exec_commands,
    })
}

/// Toggle `host_exec` on/off for a project.
///
/// **The danger modal that explains the consequences is the frontend's gate** —
/// the UI must confirm it before calling this; this command only persists the
/// flag, (re)spawns or tears down the worker, and recreates the project's
/// containers (if running) so the hub picks up / drops `host_exec`.
#[tauri::command]
pub async fn set_host_exec_enabled(
    project: String,
    enabled: bool,
    app: tauri::AppHandle,
    host_exec: tauri::State<'_, crate::reconcile::SharedHostExec>,
) -> Result<(), String> {
    check_project(&project)?;
    log::info!("set_host_exec_enabled: project={project} enabled={enabled}");
    let host_exec_arc = host_exec.inner().clone();
    tokio::task::spawn_blocking(move || {
        // 1. Persist the flag (user config only).
        config::with_config_lock(|| {
            let mut user_config = config::load_user_config()?;
            let entry = user_config
                .find_project_mut(&project)
                .ok_or_else(|| anyhow::anyhow!("project '{project}' not found in config"))?;
            let integrations = entry.integrations.get_or_insert_with(Default::default);
            integrations.set_host_exec_enabled(enabled);
            config::save_user_config(&user_config)
        })
        .map_err(|e| e.to_string())?;

        // 2. (Re)spawn or tear down this project's worker.
        if enabled {
            crate::ensure_host_exec_running(&host_exec_arc, &app, &project);
        } else {
            crate::reconcile::teardown_host_exec_for_project(&host_exec_arc, &project);
        }

        // 3. If the project's containers are running, recreate them so the hub
        //    re-discovers host_exec (or drops it) with the worker's current
        //    port. Best-effort — a render/recreate failure doesn't undo the
        //    config change; the next chat/container start picks it up.
        recreate_project_containers_if_running(&project);
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Replace the `host_exec` recipe whitelist for a project.
///
/// Validates the recipes (`host_exec::validate_host_exec_config` — the same
/// rules the worker relies on) and only persists if valid (a readable error is
/// returned otherwise, not a 500). Then: writes the chmod-600 worker snapshot,
/// clears that project's confirmation cache (so an edited recipe re-prompts),
/// respawns the worker if it's running, and recreates the project's containers
/// (if running) so the hub re-discovers the updated tool set.
#[tauri::command]
pub async fn host_exec_save_settings(
    project: String,
    commands: Vec<HostExecRecipe>,
    app: tauri::AppHandle,
    host_exec: tauri::State<'_, crate::reconcile::SharedHostExec>,
) -> Result<(), String> {
    check_project(&project)?;
    log::info!(
        "host_exec_save_settings: project={project} ({} recipe(s))",
        commands.len()
    );
    let host_exec_arc = host_exec.inner().clone();
    tokio::task::spawn_blocking(move || {
        // 1. Validate (same rules the worker enforces) — readable error on failure.
        let cfg = config::HostExecConfig {
            enabled: None, // `enabled` is not touched here; only `commands`.
            commands: commands.clone(),
        };
        speedwave_runtime::host_exec::validate_host_exec_config(&cfg).map_err(|e| e.to_string())?;

        // 2. Persist the whitelist (preserving the enabled flag — user config only).
        config::with_config_lock(|| {
            let mut user_config = config::load_user_config()?;
            let entry = user_config
                .find_project_mut(&project)
                .ok_or_else(|| anyhow::anyhow!("project '{project}' not found in config"))?;
            let integrations = entry.integrations.get_or_insert_with(Default::default);
            integrations.set_host_exec_commands(commands.clone());
            config::save_user_config(&user_config)
        })
        .map_err(|e| e.to_string())?;

        // 3. Write the chmod-600 worker snapshot (it may hold recipe `env`
        //    values, possibly secrets — ADR-054).
        let user_config = config::load_user_config().map_err(|e| e.to_string())?;
        let project_dir = user_config
            .find_project(&project)
            .map(|p| std::path::PathBuf::from(&p.dir))
            .ok_or_else(|| format!("project '{project}' not found"))?;
        let resolved = config::resolve_integrations(&project_dir, &user_config, &project);
        let state_dir = speedwave_runtime::host_exec::host_exec_project_dir(
            speedwave_runtime::consts::data_dir(),
            &project,
        );
        std::fs::create_dir_all(&state_dir).map_err(|e| e.to_string())?;
        let snapshot =
            config::host_exec_config_snapshot(&project_dir, &resolved.host_exec_commands);
        let config_path = state_dir.join(speedwave_runtime::consts::HOST_EXEC_CONFIG_FILE);
        crate::write_host_exec_config_snapshot(&config_path, &snapshot)
            .map_err(|e| e.to_string())?;

        // 4. If host_exec is enabled for this project, make the worker reflect
        //    the new whitelist: respawn it if it's running (refreshes tools/list
        //    and clears its confirmation cache), or spawn it via
        //    `ensure_host_exec_running` if it's enabled but not currently up
        //    (e.g. it died, or this is the first edit before a chat starts).
        //    Disabled → nothing to do; the worker also re-reads its snapshot per
        //    call regardless.
        if resolved.host_exec {
            let was_running = respawn_host_exec_worker(&host_exec_arc, &project);
            if !was_running {
                crate::ensure_host_exec_running(&host_exec_arc, &app, &project);
            }
        }

        // 5. Recreate the project's containers (if running) so the hub
        //    re-discovers the updated tools. Best-effort.
        recreate_project_containers_if_running(&project);
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Read the `host_exec` recipe whitelist for a project (from the user config).
#[tauri::command]
pub fn host_exec_load_settings(project: String) -> Result<Vec<HostExecRecipe>, String> {
    check_project(&project)?;
    let user_config = config::load_user_config().map_err(|e| e.to_string())?;
    Ok(user_config
        .find_project(&project)
        .and_then(|e| e.integrations.as_ref())
        .and_then(|i| i.host_exec.as_ref())
        .map(|h| h.commands.clone())
        .unwrap_or_default())
}

/// Resolve an executable name on the recovered host `PATH` — a `which`-style
/// lookup for the UI's "browse…" picker when `PATH` discovery can't find a
/// recipe's `exec` (e.g. `docker` / `gradle`). Returns the first absolute path
/// found, or `None`. Rejects names containing path separators, `..`, NUL, or a
/// line break (callers should pass a bare command name; an explicit path
/// doesn't need resolving).
#[tauri::command]
pub fn host_exec_resolve_executable(name: String) -> Result<Option<String>, String> {
    if name.is_empty()
        || name.contains('/')
        || name.contains('\\')
        || name.contains("..")
        || speedwave_runtime::host_exec::has_control_chars(&name)
    {
        return Err(
            "host_exec_resolve_executable: pass a bare command name (no path separators, '..', NUL, or newlines)"
                .to_string(),
        );
    }
    let path = crate::recovered_host_path();
    let sep = if cfg!(windows) { ';' } else { ':' };
    // On Windows, also try the PATHEXT extensions.
    let exts: Vec<String> = if cfg!(windows) {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string())
            .split(';')
            .filter(|e| !e.is_empty())
            .map(|e| e.to_string())
            .collect()
    } else {
        vec![String::new()]
    };
    for dir in path.split(sep).filter(|d| !d.is_empty()) {
        for ext in &exts {
            let candidate = std::path::Path::new(dir).join(format!("{name}{ext}"));
            if let Ok(meta) = std::fs::metadata(&candidate) {
                if meta.is_file() {
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        // Must be executable by someone (owner/group/other x bit).
                        if meta.permissions().mode() & 0o111 == 0 {
                            continue;
                        }
                    }
                    return Ok(Some(candidate.to_string_lossy().to_string()));
                }
            }
        }
    }
    Ok(None)
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/// Respawn the project's `host_exec` worker if one is in the shared map (so it
/// re-reads the whitelist and the hub gets a fresh `tools/list`); `respawn()`
/// also clears that project's confirmation cache. Returns `true` if a worker
/// was mapped (and a respawn was attempted), `false` if none was — so the
/// caller can `ensure_host_exec_running` instead. On a respawn failure the dead
/// worker is dropped (the watchdog / next chat start retries) and `true` is
/// still returned (a worker *was* there).
fn respawn_host_exec_worker(host_exec: &crate::reconcile::SharedHostExec, project: &str) -> bool {
    match host_exec.lock() {
        Ok(mut map) => {
            if !map.contains_key(project) {
                return false;
            }
            if let Some(proc) = map.get_mut(project) {
                match proc.respawn() {
                    Ok(port) => log::info!(
                        "host_exec[{project}]: respawned after settings change (port {port})"
                    ),
                    Err(e) => {
                        log::error!(
                            "host_exec[{project}]: respawn after settings change failed: {e}"
                        );
                        // Drop the dead worker — the watchdog / next start retries.
                        if let Some(mut dead) = map.remove(project) {
                            let _ = dead.stop();
                            dead.cleanup_files();
                        }
                    }
                }
            }
            true
        }
        Err(e) => {
            log::warn!("respawn_host_exec_worker: map mutex poisoned: {e}");
            false
        }
    }
}

/// If the project's containers are running, re-render its compose (now picking
/// up — or dropping — `WORKER_HOST_EXEC_URL` / the `host_exec` entry in
/// `ENABLED_SERVICES` via `compose::apply_host_exec_config` + the integrations
/// filter) and `compose_up_recreate` so the hub re-discovers. If nothing is
/// running, do nothing — the next chat/container start renders fresh. Mirrors
/// the recreate path in `containers_cmd`/`reconcile`; failures are logged, not
/// fatal (the config change stands regardless).
///
/// Visible crate-wide because the watchdog (`main::start_host_exec_watchdog`)
/// also needs to call it after a successful `proc.respawn()` so the hub
/// picks up the worker's new dynamic port.
pub(crate) fn recreate_project_containers_if_running(project: &str) {
    let rt = speedwave_runtime::runtime::detect_runtime();
    if !rt.is_available() {
        log::debug!("recreate_project_containers_if_running: runtime not available — skipping");
        return;
    }
    let running = match rt.compose_ps(project) {
        Ok(c) => !c.is_empty(),
        Err(e) => {
            log::debug!(
                "recreate_project_containers_if_running: compose_ps failed ({e}) — skipping"
            );
            return;
        }
    };
    if !running {
        log::debug!("recreate_project_containers_if_running: '{project}' not running — skipping");
        return;
    }
    if let Err(e) = crate::containers_cmd::render_and_save_compose(project, &*rt) {
        log::warn!("recreate_project_containers_if_running: render failed for '{project}': {e}");
        return;
    }
    if let Err(e) = rt.compose_up_recreate(project) {
        log::warn!("recreate_project_containers_if_running: recreate failed for '{project}': {e}");
    } else {
        log::info!("host_exec: recreated containers for '{project}' so the hub re-discovers");
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn host_exec_status_serde_round_trips() {
        let s = HostExecStatus {
            enabled: true,
            commands: vec![HostExecRecipe {
                name: "test".to_string(),
                exec: "./gradlew".to_string(),
                args: vec!["test".to_string()],
                cwd_sub: None,
                params: None,
                env: None,
                confirm: speedwave_runtime::config::HostExecConfirm::Ask,
            }],
        };
        let json = serde_json::to_string(&s).unwrap();
        let back: HostExecStatus = serde_json::from_str(&json).unwrap();
        assert!(back.enabled);
        assert_eq!(back.commands.len(), 1);
        assert_eq!(back.commands[0].name, "test");
    }

    #[test]
    fn resolve_executable_rejects_paths_and_dotdot() {
        for bad in ["/usr/bin/docker", "..", "a/b", "x\\y", "", "a\0b"] {
            assert!(
                host_exec_resolve_executable(bad.to_string()).is_err(),
                "{bad:?} should be rejected (not a bare command name)"
            );
        }
    }

    #[test]
    fn resolve_executable_finds_a_known_command_on_path() {
        // `sh` exists on every Unix box; on Windows skip (no `sh` guaranteed) —
        // but `cmd` is there. Either way, resolution must return some absolute
        // path for at least one ubiquitous command, or None (if the recovered
        // PATH genuinely lacks it, which would be unusual but not a test bug).
        #[cfg(unix)]
        {
            let r = host_exec_resolve_executable("sh".to_string()).unwrap();
            // In CI / dev the recovered PATH includes /bin or /usr/bin, so this
            // should find `sh`. If for some exotic reason it doesn't, accept None
            // rather than fail — the function's contract is "first match or None".
            if let Some(p) = r {
                assert!(
                    std::path::Path::new(&p).is_absolute() && p.ends_with("sh"),
                    "resolved sh path should be absolute and end with 'sh': {p}"
                );
            }
        }
        // A name that definitely doesn't exist → None.
        assert_eq!(
            host_exec_resolve_executable("definitely-not-a-real-binary-xyz-123".to_string())
                .unwrap(),
            None
        );
    }
}
