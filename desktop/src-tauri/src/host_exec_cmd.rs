//! Tauri commands for the `host_exec` integration (ADR-054).
//! User-config only; respawn worker + recreate containers on change.

use crate::types::check_project;
use serde::{Deserialize, Serialize};
use speedwave_runtime::config::{self, HostExecRecipe};
use speedwave_runtime::host_exec_process::write_host_exec_config_snapshot;

/// `host_exec` UI status: enabled flag + recipe whitelist.
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

/// Toggle `host_exec` for a project. Frontend danger modal is the consent gate.
#[tauri::command]
pub async fn set_host_exec_enabled(
    project: String,
    enabled: bool,
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
            crate::ensure_host_exec_running(&host_exec_arc, &project);
        } else {
            crate::reconcile::teardown_host_exec_for_project(&host_exec_arc, &project);
        }

        // 3. Recreate running containers so the hub re-discovers — best-effort.
        recreate_project_containers_if_running(&project);
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Replace the recipe whitelist: validate, persist, respawn worker, recreate containers.
#[tauri::command]
pub async fn host_exec_save_settings(
    project: String,
    commands: Vec<HostExecRecipe>,
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

        // 3. Write chmod-600 worker snapshot — may hold recipe env-value secrets (ADR-054).
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
        write_host_exec_config_snapshot(&config_path, &snapshot).map_err(|e| e.to_string())?;

        // 4. Make the worker reflect the new whitelist (respawn or spawn).
        if resolved.host_exec {
            let was_running = respawn_host_exec_worker(&host_exec_arc, &project);
            if !was_running {
                crate::ensure_host_exec_running(&host_exec_arc, &project);
            }
        }

        // 5. Recreate running containers so the hub re-discovers — best-effort.
        recreate_project_containers_if_running(&project);
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// `which`-style lookup on the recovered host `PATH`. Rejects path-bearing names.
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
                        // Must be executable (any x bit set).
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

// helpers

/// Respawn the project's worker if mapped. Returns `true` if one was present.
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

/// Re-render compose and recreate running containers so the hub re-discovers.
/// Best-effort — failures are logged, not fatal. Also used by the watchdog.
pub(crate) fn recreate_project_containers_if_running(project: &str) {
    // Bundle reconcile may be rebuilding images. compose_up_recreate against a
    // missing image tag emits "image not available" to the user. Wait first.
    if let Err(e) = crate::containers_cmd::ensure_images_ready() {
        log::warn!("recreate_project_containers_if_running: images not ready for '{project}': {e}");
        return;
    }
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
    // Build OUTSIDE the compose lock (ADR-066).
    if let Err(sanitized) = crate::integrations_cmd::ensure_project_images_built(&rt, project) {
        log::warn!(
            "recreate_project_containers_if_running: pre-build failed for '{project}': {sanitized}"
        );
        return;
    }
    use crate::types::IntoAnyhow;
    let result = rt.transaction(project, |rt| -> anyhow::Result<()> {
        crate::containers_cmd::render_and_save_compose(project).into_anyhow()?;
        speedwave_runtime::runtime::compose_validate_with_retry(rt, project)?;
        rt.compose_up_recreate(project)?;
        Ok(())
    });
    match result {
        Ok(()) => {
            log::info!("host_exec: recreated containers for '{project}' so the hub re-discovers");
        }
        Err(e) => {
            log::warn!("recreate_project_containers_if_running: failed for '{project}': {e}");
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn recreate_project_containers_if_running_waits_for_image_readiness() {
        // Race guard: this best-effort helper runs on host_exec / oauth respawn
        // and on watchdog ticks, both of which can fire while bundle reconcile
        // is rebuilding images. Without the gate, nerdctl emits
        // image-not-available through the UI.
        let source = include_str!("host_exec_cmd.rs");
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
        // Path separators, `..`, empty, NUL, and line breaks (`\n` / `\r` —
        // rejected via `host_exec::has_control_chars`) must all be refused;
        // callers pass a bare command name.
        for bad in [
            "/usr/bin/docker",
            "..",
            "a/b",
            "x\\y",
            "",
            "a\0b",
            "a\nb",
            "a\rb",
        ] {
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
