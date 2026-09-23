use crate::chat::{ChatSession, SharedChatSession};
use crate::reconcile;
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

pub(crate) static PROJECT_TRANSITION_LOCK: tokio::sync::Mutex<()> =
    tokio::sync::Mutex::const_new(());

pub(crate) const PROJECT_TRANSITION_BUSY_ERR: &str =
    "Another project operation is already in progress";

#[tauri::command]
pub(crate) async fn switch_project(
    name: String,
    app: tauri::AppHandle,
    chat_state: tauri::State<'_, SharedChatSession>,
) -> Result<(), String> {
    use containers_cmd::{
        spawn_background_teardown, switch_project_core, teardown_only, SwitchResult,
    };

    let Ok(_transition_guard) = PROJECT_TRANSITION_LOCK.try_lock() else {
        return Err(PROJECT_TRANSITION_BUSY_ERR.to_string());
    };

    let previous = config::with_config_lock(|| {
        let mut user_config = config::load_user_config()?;
        let prev = user_config.active_project.clone();
        apply_switch_project(&mut user_config, &name)?;
        config::save_user_config(&user_config)?;
        Ok(prev)
    })
    .map_err(|e| e.to_string())?;

    use tauri::Emitter;
    let _ = app.emit(
        "project_switch_started",
        serde_json::json!({ "project": name }),
    );

    let prev_clone = previous.clone();
    let new_clone = name.clone();
    use tauri::Manager;
    let oauth_arc = app.state::<reconcile::SharedOauth>().inner().clone();
    let oauth_for_teardown = oauth_arc.clone();
    let switch_result = tokio::task::spawn_blocking(move || {
        if let Err(e) = containers_cmd::ensure_images_ready() {
            return SwitchResult::failed(e, None);
        }
        let rt = speedwave_runtime::runtime::detect_runtime();
        switch_project_core(&prev_clone, &new_clone, &rt, &|proj, rt| {
            check_project(proj)?;
            if containers_cmd::project_llm_is_unconfigured(proj)? {
                log::info!(
                    "switch_project: '{proj}' has no LLM provider — skipping container start"
                );
                return Ok(());
            }
            if let Err(sanitized) = integrations_cmd::ensure_project_images_built(rt, proj) {
                return Err(format!("Image build failed: {sanitized}"));
            }
            crate::ensure_oauth_running(&oauth_arc, proj);
            use crate::types::IntoAnyhow;
            rt.transaction(proj, |rt| -> anyhow::Result<()> {
                containers_cmd::render_and_save_compose(proj).into_anyhow()?;
                speedwave_runtime::runtime::compose_validate_with_retry(rt, proj)?;
                rt.compose_up(proj)?;
                Ok(())
            })
            .map_err(|e| e.to_string())
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
                rollback_and_emit_failed(&app, previous, &error, cleanup_error.as_deref());
            return Err(full_error);
        }
        SwitchResult::Succeeded { teardown } => teardown,
    };

    let rebind_name = name.clone();
    let rebind_app = app.clone();
    let rebind_state = chat_state.inner().clone();
    let rebind_result: Result<(), String> =
        tokio::task::spawn_blocking(move || rebind_chat(&rebind_name, &rebind_app, &rebind_state))
            .await
            .map_err(|e| e.to_string())?;

    if let Err(e) = rebind_result {
        reconcile::teardown_oauth_for_project(&oauth_for_teardown, &name);
        let mut cleanup_parts: Vec<String> = Vec::new();

        let new_for_teardown = name.clone();
        let teardown_err: Option<String> = tokio::task::spawn_blocking(move || {
            let rt = speedwave_runtime::runtime::detect_runtime();
            teardown_only(&new_for_teardown, &rt)
        })
        .await
        .unwrap_or_else(|je| Some(format!("join error: {je}")));

        if let Some(te) = teardown_err {
            cleanup_parts.push(format!("Teardown of new project incomplete: {te}"));
        }

        if let Some(ref prev) = previous {
            let rb_prev = prev.clone();
            let rb_app = app.clone();
            let rb_state = chat_state.inner().clone();
            let rb_result: Result<(), String> =
                tokio::task::spawn_blocking(move || rebind_chat(&rb_prev, &rb_app, &rb_state))
                    .await
                    .unwrap_or_else(|je| Err(format!("join error: {je}")));

            if let Err(re) = rb_result {
                cleanup_parts.push(format!("Chat rebind back to '{prev}' failed: {re}"));
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

    if let Some(prev) = pending_teardown {
        reconcile::teardown_oauth_for_project(&oauth_for_teardown, &prev);
        spawn_background_teardown(prev);
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
    *session = ChatSession::new(
        project,
        "00000000-0000-4000-8000-000000000000",
        std::sync::Arc::new(std::sync::Mutex::new(None)),
    );
    session.start(app.clone(), None).map_err(|e| e.to_string())
}

fn parse_cloudstorage_tcc_error(error: &str) -> Option<(&str, &str)> {
    let body = error.strip_prefix(speedwave_runtime::cloudstorage::CLOUDSTORAGE_TCC_PREFIX)?;
    let pipe_idx = body.find('|')?;
    let (stable_id, rest) = body.split_at(pipe_idx);
    let dir = rest[1..]
        .split_once(". ")
        .map(|(d, _)| d)
        .unwrap_or(&rest[1..]);
    Some((stable_id, dir))
}

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

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "unwrap/expect are fine in test assertions"
)]
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
                    policy: None,
                    effort_pin: None,
                },
                ProjectUserEntry {
                    name: "beta".to_string(),
                    dir: "/tmp/beta".to_string(),
                    claude: None,
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

    #[test]
    fn switch_uses_idempotent_compose_up() {
        let source = include_str!("project_cmd.rs");
        let switch_fn = source
            .split("pub(crate) async fn switch_project(")
            .nth(1)
            .expect("switch_project must exist");
        let body = switch_fn.split("\nmod tests").next().unwrap_or(switch_fn);
        assert!(
            body.contains("rt.compose_up(proj)"),
            "switch must call idempotent compose_up"
        );
        assert!(
            !body.contains("compose_up_recreate"),
            "switch must NOT force-recreate (nerdctl config-hash handles it)"
        );
    }

    #[test]
    fn switch_checks_no_provider_before_render() {
        let source = include_str!("project_cmd.rs");
        let switch_fn = source
            .split("pub(crate) async fn switch_project(")
            .nth(1)
            .expect("switch_project must exist");
        let body = switch_fn.split("\nmod tests").next().unwrap_or(switch_fn);
        let check_pos = body
            .find("project_llm_is_unconfigured(proj)")
            .expect("switch_project closure must pre-check for a missing provider");
        let render_pos = body
            .find("render_and_save_compose")
            .expect("switch must render compose");
        assert!(
            check_pos < render_pos,
            "no-provider check must precede compose render"
        );
    }

    #[test]
    fn switch_eager_starts_host_workers_before_render() {
        let source = include_str!("project_cmd.rs");
        let switch_fn = source
            .split("pub(crate) async fn switch_project(")
            .nth(1)
            .expect("switch_project must exist");
        let body = switch_fn.split("\nmod tests").next().unwrap_or(switch_fn);
        let oauth_pos = body
            .find("ensure_oauth_running")
            .expect("switch must eager-start oauth");
        let render_pos = body
            .find("render_and_save_compose")
            .expect("switch must render compose");
        assert!(
            oauth_pos < render_pos,
            "host workers must start before compose render"
        );
    }

    #[tokio::test]
    async fn concurrent_switch_is_rejected_while_lock_held() {
        let guard = PROJECT_TRANSITION_LOCK.lock().await;
        assert!(PROJECT_TRANSITION_LOCK.try_lock().is_err());
        drop(guard);
        assert!(PROJECT_TRANSITION_LOCK.try_lock().is_ok());
    }

    #[test]
    fn switch_retires_previous_host_workers_only_after_success() {
        let source = include_str!("project_cmd.rs");
        let switch_fn = source
            .split("pub(crate) async fn switch_project(")
            .nth(1)
            .expect("switch_project must exist");
        let body = switch_fn.split("\nmod tests").next().unwrap_or(switch_fn);
        let success_marker = body
            .find("pending_teardown {")
            .expect("success-path teardown block must exist");
        let prev_oauth = body
            .rfind("teardown_oauth_for_project")
            .expect("oauth teardown must exist");
        assert!(
            prev_oauth > success_marker,
            "previous-project worker teardown must live in the success path"
        );
        let rebind_fail = body
            .find("rebind_result {")
            .expect("rebind-failure block must exist");
        let fail_window = &body[rebind_fail..success_marker];
        assert!(
            fail_window.contains("teardown_oauth_for_project"),
            "rebind failure must retire the destination's host workers"
        );
    }

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
                policy: None,
                effort_pin: None,
            }],
            active_project: None,
            selected_ide: None,
            ui: None,
            telemetry: None,
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
