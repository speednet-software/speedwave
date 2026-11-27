use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use speedwave_runtime::compose::{self, SecurityCheck};
use speedwave_runtime::consts;
use speedwave_runtime::oauth_refresh::{self, RefreshOutcome};
use speedwave_runtime::plugin;
use speedwave_runtime::runtime::{ensure_exec_healthy, LockedRuntime};

use super::compose_inputs;
use crate::paste_watcher::PasteWatcher;
use crate::project_command::ProjectContext;
use crate::{cli_logger, redact_err, terminal_restore};

const START_REFRESH_TIMEOUT: Duration = Duration::from_secs(5);

pub(super) struct Started {
    pub(super) container_name: String,
    flags: Vec<String>,
    _paste_watcher: PasteWatcher,
}

pub(super) fn run(project: ProjectContext, runtime: LockedRuntime) -> anyhow::Result<()> {
    let started = bring_up(&project, &runtime)?;

    let reconnect_warnings = ReconnectWarnings::default();
    let refreshed_at_start =
        oauth_refresh::refresh_now_with_timeout(&project.name, START_REFRESH_TIMEOUT);
    for refreshed in refreshed_at_start {
        if refreshed.outcome == RefreshOutcome::ReconnectRequired {
            reconnect_warnings.warn_once(&refreshed.service);
        }
    }
    let _session_refresher = oauth_refresh::spawn_session_refresher(&project.name, {
        let reconnect_warnings = reconnect_warnings.clone();
        move |refreshed| {
            if refreshed.outcome == RefreshOutcome::ReconnectRequired {
                reconnect_warnings.warn_once(&refreshed.service);
            }
        }
    });

    let instance_id = speedwave_runtime::session::new_instance_id();
    let mut tail = vec![consts::CLAUDE_BINARY.to_string()];
    tail.extend(started.flags.iter().cloned());
    let exec_argv = stamped_exec_argv(&instance_id, tail);
    let exec_cmd: Vec<&str> = exec_argv.iter().map(String::as_str).collect();
    reconnect_warnings.hold();
    let terminal = cli_logger::hand_over_terminal();
    let status_result = runtime
        .container_exec(&started.container_name, &exec_cmd)
        .status();
    terminal_restore::sanitize_host_terminal();
    drop(terminal);
    reap_instance(&runtime, &started.container_name, &instance_id);
    for message in reconnect_warnings.release() {
        err!("{message}");
    }
    let status = status_result?;

    let is_oom = speedwave_runtime::resources::is_oom_exit(&status);
    if is_oom {
        err!("{}", speedwave_runtime::resources::OOM_MESSAGE);
    }
    let code = status.code().unwrap_or(if is_oom { 137 } else { 1 });
    std::process::exit(code)
}

pub(super) fn bring_up(
    project: &ProjectContext,
    runtime: &LockedRuntime,
) -> anyhow::Result<Started> {
    let inputs = compose_inputs::gather(project, runtime)?;

    if !inputs.prereq_violations.is_empty() {
        err!("speedwave check FAILED -- containers NOT started\n");
        for v in &inputs.prereq_violations {
            err!("  {} -- {}", v.rule, v.message);
            err!("  Fix: {}\n", v.remediation);
        }
        std::process::exit(1);
    }
    speedwave_runtime::fs_security::ensure_data_dir_permissions(&project.name)?;
    let violations = SecurityCheck::run(
        &inputs.compose_yml,
        &project.name,
        &inputs.manifests,
        &inputs.expected_paths,
    );
    if !violations.is_empty() {
        err!("speedwave check FAILED -- containers NOT started\n");
        for v in &violations {
            err!("  [{}] {} -- {}", v.container, v.rule, v.message);
            err!("  Fix: {}\n", v.remediation);
        }
        std::process::exit(1);
    }

    let bundle_manifest = speedwave_runtime::bundle::load_current_bundle_manifest()?;
    let enabled_imgs = speedwave_runtime::build::enabled_images(&inputs.integrations);
    let prior_state = speedwave_runtime::bundle::load_bundle_state();
    let built = speedwave_runtime::build::build_missing_images_locked(
        runtime,
        &enabled_imgs,
        &bundle_manifest,
    )
    .map_err(|e| anyhow::anyhow!("container image build failed: {}", redact_err(&e)))?;
    if built > 0 {
        out!("Built {built} container image(s) for this app version");
        match speedwave_runtime::build::resolve_build_root() {
            Ok(root) => {
                if let Err(e) = speedwave_runtime::bundle::sync_claude_resources(&root) {
                    err!(
                        "Warning: claude-resources sync failed: {} (skills may be stale)",
                        redact_err(&e)
                    );
                }
            }
            Err(e) => err!(
                "Warning: build root unavailable, claude-resources not synced: {}",
                redact_err(&e)
            ),
        }
        speedwave_runtime::build::prune_superseded_images(
            runtime,
            &prior_state.applied_image_hashes,
            prior_state.applied_bundle_id.as_deref(),
            &bundle_manifest,
        );
    }
    let enabled_plugin_ids: Vec<&str> = inputs.integrations.enabled_plugin_service_ids();
    plugin::ensure_plugin_images(runtime, &enabled_plugin_ids)
        .map_err(|e| anyhow::anyhow!("plugin image build failed: {}", redact_err(&e)))?;

    runtime.transaction(&project.name, |runtime| -> anyhow::Result<()> {
        compose::save_compose(&project.name, &inputs.compose_yml)?;
        speedwave_runtime::runtime::compose_validate_with_retry(runtime, &project.name)?;
        runtime.compose_up(&project.name)?;
        Ok(())
    })?;

    let container_name = format!("{}_{}_claude", consts::compose_prefix(), project.name);
    ensure_exec_healthy(runtime, &project.name, &container_name)?;

    let paste_watcher = PasteWatcher::spawn(project.dir.clone());

    Ok(Started {
        container_name,
        flags: inputs.resolved.flags,
        _paste_watcher: paste_watcher,
    })
}

pub(super) fn stamped_exec_argv(instance_id: &str, tail: Vec<String>) -> Vec<String> {
    let mut argv = speedwave_runtime::session::instance_env_argv(instance_id);
    argv.extend(tail);
    argv
}

pub(super) fn reap_instance(runtime: &LockedRuntime, container: &str, instance_id: &str) {
    if let Some(warning) = reap_warning(runtime, container, instance_id) {
        err!("{warning}");
    }
}

fn reap_warning(runtime: &LockedRuntime, container: &str, instance_id: &str) -> Option<String> {
    let e = speedwave_runtime::session::reap_instance(runtime, container, instance_id).err()?;
    Some(format!(
        "Warning: Claude Code may still be running in '{container}': {}",
        redact_err(&e)
    ))
}

#[derive(Clone, Default)]
struct ReconnectWarnings(Arc<Mutex<ReconnectState>>);

#[derive(Default)]
struct ReconnectState {
    reported: HashSet<String>,
    deferred: Vec<String>,
    held: bool,
}

impl ReconnectWarnings {
    fn warn_once(&self, service: &str) {
        if let Some(message) = self.report(service) {
            err!("{message}");
        }
    }

    fn hold(&self) {
        self.lock().held = true;
    }

    fn release(&self) -> Vec<String> {
        let mut state = self.lock();
        state.held = false;
        std::mem::take(&mut state.deferred)
    }

    fn report(&self, service: &str) -> Option<String> {
        let mut state = self.lock();
        if !state.reported.insert(service.to_string()) {
            return None;
        }
        let message = reconnect_warning(service);
        if state.held {
            state.deferred.push(message);
            return None;
        }
        Some(message)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, ReconnectState> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

fn reconnect_warning(service: &str) -> String {
    let name = oauth_refresh::service_display_name(service);
    format!(
        "Warning: the {name} sign-in expired and Speedwave cannot refresh it. \
         Reconnect {name} in Speedwave Desktop: Settings, Integrations, {name}."
    )
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "test fixtures assert on setup that must not silently fail"
)]
mod tests {
    use super::*;

    #[test]
    fn reconnect_warning_is_reported_once_per_service() {
        let warnings = ReconnectWarnings::default();
        assert!(warnings.report("slack").is_some());
        assert!(warnings.report("slack").is_none());
        assert!(warnings.report("sharepoint").is_some());
    }

    #[test]
    fn reconnect_warning_when_not_held_is_returned_at_once() {
        let warnings = ReconnectWarnings::default();

        assert_eq!(warnings.report("slack"), Some(reconnect_warning("slack")));
        assert!(warnings.release().is_empty());
    }

    #[test]
    fn reconnect_warning_during_a_hold_is_deferred_and_released_once_per_service() {
        let warnings = ReconnectWarnings::default();
        warnings.hold();

        assert!(warnings.report("slack").is_none());
        assert!(warnings.report("slack").is_none());
        assert!(warnings.report("sharepoint").is_none());

        assert_eq!(
            warnings.release(),
            vec![reconnect_warning("slack"), reconnect_warning("sharepoint")]
        );
        assert!(warnings.release().is_empty());
    }

    #[test]
    fn reconnect_warning_after_release_is_returned_at_once_again() {
        let warnings = ReconnectWarnings::default();
        warnings.hold();
        assert!(warnings.report("slack").is_none());
        let _ = warnings.release();

        assert!(warnings.report("slack").is_none());
        assert_eq!(
            warnings.report("sharepoint"),
            Some(reconnect_warning("sharepoint"))
        );
    }

    #[test]
    fn reconnect_warning_names_the_service_and_the_desktop_path() {
        assert_eq!(
            reconnect_warning("slack"),
            "Warning: the Slack sign-in expired and Speedwave cannot refresh it. \
             Reconnect Slack in Speedwave Desktop: Settings, Integrations, Slack."
        );
        assert!(reconnect_warning("no-such-service")
            .contains("Settings, Integrations, no-such-service."));
    }

    #[test]
    fn stamped_exec_argv_places_claude_after_instance_marker() {
        let argv = stamped_exec_argv(
            "id-1",
            vec![consts::CLAUDE_BINARY.to_string(), "--flag".to_string()],
        );
        assert_eq!(argv[0], "env");
        assert_eq!(
            argv[1],
            format!("{}=id-1", speedwave_runtime::session::SESSION_INSTANCE_ENV)
        );
        assert_eq!(argv[2], "/usr/local/bin/claude");
        assert_eq!(argv[3], "--flag");
    }

    #[test]
    fn test_exec_cmd_includes_resolved_flags() {
        use speedwave_runtime::defaults;
        let mut tail = vec![consts::CLAUDE_BINARY.to_string()];
        tail.extend(defaults::DEFAULT_FLAGS.iter().map(|f| f.to_string()));
        let argv = stamped_exec_argv("id-2", tail);
        assert!(argv.contains(&consts::CLAUDE_BINARY.to_string()));
        assert!(argv.contains(&"--dangerously-skip-permissions".to_string()));
        assert!(argv.contains(&"--mcp-config".to_string()));
        assert!(argv.contains(&defaults::MCP_CONFIG_PATH.to_string()));
        assert!(argv.contains(&"--strict-mcp-config".to_string()));
    }

    #[test]
    fn a_reap_that_fails_in_a_running_container_warns_that_claude_code_may_still_run() {
        let container = "cli-reap-fails_claude";
        let (runtime, _handles) =
            speedwave_runtime::runtime::mock_runtime::MockRuntimeBuilder::new()
                .push_exec_piped_failure("container is not responding")
                .build();

        let warning = reap_warning(&runtime, container, "abc-123").expect("a warning");

        assert!(
            warning.starts_with(&format!(
                "Warning: Claude Code may still be running in '{container}': "
            )),
            "{warning}"
        );
        assert!(warning.contains("container is not responding"), "{warning}");
    }

    #[test]
    fn a_reap_that_finds_no_container_or_a_stopped_one_stays_quiet() {
        for (container, stderr) in [
            (
                "cli-reap-missing_claude",
                "Error: No such container: cli-reap-missing_claude",
            ),
            (
                "cli-reap-stopped_claude",
                "level=fatal msg=\"cannot exec in a stopped state\"",
            ),
        ] {
            let (runtime, handles) =
                speedwave_runtime::runtime::mock_runtime::MockRuntimeBuilder::new()
                    .push_exec_piped_failure(stderr)
                    .build();

            let warning = reap_warning(&runtime, container, "abc-123");

            assert_eq!(warning, None, "{stderr}");
            assert_eq!(handles.exec_calls.lock().unwrap().len(), 1, "{stderr}");
        }
    }

    #[test]
    fn a_reap_that_succeeds_stays_quiet() {
        let (runtime, handles) =
            speedwave_runtime::runtime::mock_runtime::MockRuntimeBuilder::new().build();

        let warning = reap_warning(&runtime, "cli-reap-ok_claude", "abc-123");

        assert_eq!(warning, None);
        let calls = handles.exec_calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(
            calls[0].argv,
            speedwave_runtime::session::kill_by_instance_command("abc-123")
        );
    }
}
