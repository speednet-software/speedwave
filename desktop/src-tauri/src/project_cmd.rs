// Project-management Tauri commands.
//
// `list_projects` / `switch_project` plus the pure helpers behind the project
// switch (config mutation, container transition, chat rebind, and the
// rollback/failure-payload logic). The container orchestration lives in
// `containers_cmd`; this module owns the command surface and the
// config/event-payload glue.

use crate::chat::{ChatSession, SharedChatSession};
use crate::reconcile::{self, SharedHostExec};
use crate::types::{check_project, ProjectEntry, ProjectList};
use crate::{containers_cmd, integrations_cmd};
use speedwave_runtime::config;

#[tauri::command]
pub(crate) fn list_projects() -> Result<ProjectList, String> {
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

/// Switches the active project in-memory. Extracted for testability.
fn apply_switch_project(
    user_config: &mut config::SpeedwaveUserConfig,
    name: &str,
) -> anyhow::Result<()> {
    if user_config.find_project(name).is_none() {
        anyhow::bail!("Project '{}' not found", name);
    }
    user_config.active_project = Some(name.to_string());
    Ok(())
}

#[tauri::command]
pub(crate) async fn switch_project(
    name: String,
    app: tauri::AppHandle,
    chat_state: tauri::State<'_, SharedChatSession>,
    host_exec: tauri::State<'_, SharedHostExec>,
) -> Result<(), String> {
    use containers_cmd::{switch_project_core, teardown_and_restore, teardown_only, SwitchResult};

    // Config is committed first to keep the config lock brief — holding it
    // across the blocking container transition would starve other config
    // readers. If the container switch fails, rollback_and_emit_failed
    // restores active_project to `previous`.
    let previous = config::with_config_lock(|| {
        let mut user_config = config::load_user_config()?;
        let prev = user_config.active_project.clone();
        apply_switch_project(&mut user_config, &name)?;
        config::save_user_config(&user_config)?;
        Ok(prev)
    })
    .map_err(|e| e.to_string())?;

    // Tear down the previous project's `host_exec` worker (best-effort).
    if let Some(ref prev) = previous {
        if prev != &name {
            reconcile::teardown_host_exec_for_project(host_exec.inner(), prev);
        }
    }

    use tauri::Emitter;
    let _ = app.emit(
        "project_switch_started",
        serde_json::json!({ "project": name }),
    );

    // Container transaction: wait for images → stop previous → recreate new
    let prev_clone = previous.clone();
    let new_clone = name.clone();
    let switch_result = tokio::task::spawn_blocking(move || {
        if let Err(e) = containers_cmd::ensure_images_ready() {
            return SwitchResult::Failed {
                error: e,
                cleanup_error: None,
            };
        }
        let rt = speedwave_runtime::runtime::detect_runtime();
        switch_project_core(&prev_clone, &new_clone, &rt, &|proj, rt| {
            check_project(proj)?;
            // Lazy build for the destination project (ADR-057).
            if let Err(sanitized) = integrations_cmd::ensure_project_images_built(rt, proj) {
                return Err(format!("Image build failed: {sanitized}"));
            }
            // compose_down(prev) already handled by switch_project_core step 2.
            // Wrap the destination project's render → validate → up sequence in a
            // single transaction so it shares semantics with every other compose
            // callsite (see ADR-066) and benefits from compose_validate_with_retry's
            // virtiofs/9p propagation-lag recovery.
            use crate::types::IntoAnyhow;
            rt.transaction(proj, |rt| -> anyhow::Result<()> {
                containers_cmd::render_and_save_compose(proj).into_anyhow()?;
                speedwave_runtime::runtime::compose_validate_with_retry(rt, proj)?;
                rt.compose_up_recreate(proj)?;
                Ok(())
            })
            .map_err(|e| e.to_string())
        })
    })
    .await
    .map_err(|e| e.to_string())?;

    if let SwitchResult::Failed {
        error,
        cleanup_error,
    } = switch_result
    {
        let full_error = rollback_and_emit_failed(&app, previous, &error, cleanup_error.as_deref());
        return Err(full_error);
    }

    // Rebind chat session (spawn_blocking: rebind_chat acquires Mutex and calls session.start)
    let rebind_name = name.clone();
    let rebind_app = app.clone();
    let rebind_state = chat_state.inner().clone();
    let rebind_result: Result<(), String> =
        tokio::task::spawn_blocking(move || rebind_chat(&rebind_name, &rebind_app, &rebind_state))
            .await
            .map_err(|e| e.to_string())?;

    if let Err(e) = rebind_result {
        // Restore previous project containers + chat
        let mut cleanup_parts: Vec<String> = Vec::new();

        let prev_for_restore = previous.clone();
        let new_for_teardown = name.clone();
        let restore_result: Result<(), String> = tokio::task::spawn_blocking(move || {
            let rt = speedwave_runtime::runtime::detect_runtime();
            match &prev_for_restore {
                Some(prev) => teardown_and_restore(&new_for_teardown, prev, &rt),
                None => teardown_only(&new_for_teardown, &rt).map_or(Ok(()), Err),
            }
        })
        .await
        .unwrap_or_else(|je| Err(format!("join error: {je}")));

        if let Err(ref re) = restore_result {
            if previous.is_some() {
                cleanup_parts.push(format!(
                    "Container restore failed: {re}. \
                     System may be without running containers — run speedwave to restart."
                ));
            } else {
                cleanup_parts.push(format!("Teardown of new project incomplete: {re}"));
            }
        }

        if let Some(ref prev) = previous {
            if restore_result.is_ok() {
                let rb_prev = prev.clone();
                let rb_app = app.clone();
                let rb_state = chat_state.inner().clone();
                let rb_result: Result<(), String> =
                    tokio::task::spawn_blocking(move || rebind_chat(&rb_prev, &rb_app, &rb_state))
                        .await
                        .unwrap_or_else(|je| Err(format!("join error: {je}")));

                if let Err(re) = rb_result {
                    cleanup_parts.push(format!(
                        "Containers restored but chat rebind to '{prev}' failed: {re}"
                    ));
                }
            }
        }

        let cleanup_error = if cleanup_parts.is_empty() {
            None
        } else {
            Some(cleanup_parts.join(". "))
        };

        let full_error =
            rollback_and_emit_failed(&app, previous, &e.to_string(), cleanup_error.as_deref());
        return Err(full_error);
    }

    let _ = app.emit(
        "project_switch_succeeded",
        serde_json::json!({ "project": name }),
    );
    Ok(())
}

pub(crate) fn rebind_chat(
    project: &str,
    app: &tauri::AppHandle,
    chat_state: &SharedChatSession,
) -> Result<(), String> {
    check_project(project)?;
    let mut session = chat_state
        .lock()
        .map_err(|e| format!("Lock poisoned: {e}"))?;
    session.stop().map_err(|e| e.to_string())?;
    *session = ChatSession::new(project);
    session.start(app.clone(), None).map_err(|e| e.to_string())
}

/// Parses a prefix-encoded CloudStorage TCC error into the `(stable_id, dir)`
/// pair if present, otherwise returns `None`.
///
/// Format produced by `cloudstorage::check_project_readable_or_err`:
/// `"CloudStorage TCC required: {stable_id}|{dir}"`. Tolerates extra suffix
/// text that downstream wrappers may have appended after the dir.
fn parse_cloudstorage_tcc_error(error: &str) -> Option<(&str, &str)> {
    let body = error.strip_prefix(speedwave_runtime::cloudstorage::CLOUDSTORAGE_TCC_PREFIX)?;
    let pipe_idx = body.find('|')?;
    let (stable_id, rest) = body.split_at(pipe_idx);
    // rest starts with '|'
    let dir = rest[1..]
        .split_once(". ")
        .map(|(d, _)| d)
        .unwrap_or(&rest[1..]);
    Some((stable_id, dir))
}

/// Builds the JSON payload for the `project_switch_failed` Tauri event.
///
/// Pure function (no IO) so it can be unit-tested independently of Tauri.
/// When the error string is prefix-encoded with `CLOUDSTORAGE_TCC_PREFIX`,
/// emits structured `error_kind`/`provider`/`project_dir` fields so the
/// frontend can route to the CloudStorage remediation modal. Otherwise
/// emits only `project` + `error`.
pub(crate) fn compute_project_switch_failure_payload(
    previous: Option<&str>,
    full_error: &str,
) -> serde_json::Value {
    use speedwave_runtime::cloudstorage::CloudStorageProvider;

    if let Some((stable_id, dir)) = parse_cloudstorage_tcc_error(full_error) {
        let provider = CloudStorageProvider::from_stable_id(stable_id);
        return serde_json::json!({
            "project": previous,
            "error": full_error,
            "error_kind": "cloudstorage_tcc_required",
            "provider": provider.as_ref().map(|p| p.display_name()),
            "project_dir": dir,
        });
    }

    serde_json::json!({
        "project": previous,
        "error": full_error,
    })
}

pub(crate) fn rollback_and_emit_failed(
    app: &tauri::AppHandle,
    previous: Option<String>,
    error: &str,
    cleanup_error: Option<&str>,
) -> String {
    let rollback_err = config::with_config_lock(|| {
        let mut cfg = config::load_user_config()?;
        cfg.active_project = previous.clone();
        config::save_user_config(&cfg)?;
        Ok(())
    })
    .err();

    let mut parts = vec![error.to_string()];
    if let Some(ce) = cleanup_error {
        parts.push(ce.to_string());
    }
    if let Some(rb) = rollback_err {
        parts.push(format!("Config rollback failed: {rb}"));
    }
    let full_error = parts.join(". ");

    let payload = compute_project_switch_failure_payload(previous.as_deref(), &full_error);

    use tauri::Emitter;
    let _ = app.emit("project_switch_failed", payload);

    full_error
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use config::{ProjectUserEntry, SpeedwaveUserConfig};

    fn make_config_with_projects() -> SpeedwaveUserConfig {
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
                    claude: None,
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

    // -- apply_switch_project tests --

    #[test]
    fn switch_project_happy_path() {
        let mut cfg = make_config_with_projects();
        assert_eq!(cfg.active_project.as_deref(), Some("alpha"));

        let result = apply_switch_project(&mut cfg, "beta");
        assert!(result.is_ok());
        assert_eq!(cfg.active_project.as_deref(), Some("beta"));
    }

    #[test]
    fn switch_project_to_same_project() {
        let mut cfg = make_config_with_projects();
        let result = apply_switch_project(&mut cfg, "alpha");
        assert!(result.is_ok());
        assert_eq!(cfg.active_project.as_deref(), Some("alpha"));
    }

    #[test]
    fn switch_project_error_not_found() {
        let mut cfg = make_config_with_projects();
        let result = apply_switch_project(&mut cfg, "nonexistent");
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(
            err.contains("not found"),
            "expected 'not found' error, got: {err}"
        );
        assert!(
            err.contains("nonexistent"),
            "error should mention the project name, got: {err}"
        );
    }

    #[test]
    fn switch_project_error_empty_name() {
        let mut cfg = make_config_with_projects();
        let result = apply_switch_project(&mut cfg, "");
        assert!(result.is_err());
    }

    #[test]
    fn switch_project_does_not_modify_projects_list() {
        let mut cfg = make_config_with_projects();
        let projects_before: Vec<String> = cfg.projects.iter().map(|p| p.name.clone()).collect();

        apply_switch_project(&mut cfg, "beta").unwrap();

        let projects_after: Vec<String> = cfg.projects.iter().map(|p| p.name.clone()).collect();
        assert_eq!(projects_before, projects_after);
    }

    #[test]
    fn switch_project_from_none_active() {
        let mut cfg = SpeedwaveUserConfig {
            projects: vec![ProjectUserEntry {
                name: "only".to_string(),
                dir: "/tmp/only".to_string(),
                claude: None,
                integrations: None,
                plugin_settings: None,
            }],
            active_project: None,
            selected_ide: None,
            transcription: None,
            ui: None,
        };

        let result = apply_switch_project(&mut cfg, "only");
        assert!(result.is_ok());
        assert_eq!(cfg.active_project.as_deref(), Some("only"));
    }

    #[test]
    fn switch_project_empty_projects_list() {
        let mut cfg = SpeedwaveUserConfig::default();
        let result = apply_switch_project(&mut cfg, "anything");
        assert!(result.is_err());
    }

    // -- compute_project_switch_failure_payload tests --

    #[test]
    fn payload_for_generic_error_omits_cloudstorage_fields() {
        let payload =
            compute_project_switch_failure_payload(Some("acme"), "Container restore failed");
        assert_eq!(payload["project"], "acme");
        assert_eq!(payload["error"], "Container restore failed");
        assert!(payload.get("error_kind").is_none());
        assert!(payload.get("provider").is_none());
        assert!(payload.get("project_dir").is_none());
    }

    #[test]
    fn payload_for_cloudstorage_error_includes_structured_fields() {
        let err = "CloudStorage TCC required: one_drive|/Users/alice/Library/CloudStorage/OneDrive-Personal/p";
        let payload = compute_project_switch_failure_payload(Some("acme"), err);
        assert_eq!(payload["error_kind"], "cloudstorage_tcc_required");
        assert_eq!(payload["provider"], "OneDrive");
        assert_eq!(
            payload["project_dir"],
            "/Users/alice/Library/CloudStorage/OneDrive-Personal/p"
        );
        assert_eq!(payload["error"], err);
        assert_eq!(payload["project"], "acme");
    }

    #[test]
    fn payload_for_cloudstorage_error_with_appended_suffix_extracts_dir_only() {
        let err = "CloudStorage TCC required: dropbox|/Users/alice/Dropbox/p. Config rollback failed: nope";
        let payload = compute_project_switch_failure_payload(None, err);
        assert_eq!(payload["error_kind"], "cloudstorage_tcc_required");
        assert_eq!(payload["provider"], "Dropbox");
        assert_eq!(payload["project_dir"], "/Users/alice/Dropbox/p");
    }

    #[test]
    fn payload_for_cloudstorage_error_unknown_stable_id_emits_null_provider() {
        let err = "CloudStorage TCC required: future_provider|/some/path";
        let payload = compute_project_switch_failure_payload(None, err);
        assert_eq!(payload["error_kind"], "cloudstorage_tcc_required");
        assert!(payload["provider"].is_null());
        assert_eq!(payload["project_dir"], "/some/path");
    }

    #[test]
    fn payload_with_null_previous_serializes_as_null() {
        let payload = compute_project_switch_failure_payload(None, "boom");
        assert!(payload["project"].is_null());
    }

    #[test]
    fn payload_for_malformed_prefix_without_pipe_falls_back_to_generic() {
        let err = "CloudStorage TCC required: just_a_stable_id_without_pipe";
        let payload = compute_project_switch_failure_payload(None, err);
        assert!(payload.get("error_kind").is_none());
        assert!(payload.get("provider").is_none());
        assert!(payload.get("project_dir").is_none());
    }
}
