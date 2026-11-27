use std::path::{Path, PathBuf};

use speedwave_runtime::config::{self, SpeedwaveUserConfig};
use speedwave_runtime::consts;
use speedwave_runtime::runtime::{detect_runtime, LockedRuntime};
use speedwave_runtime::session::CliSessionGuard;
use speedwave_runtime::validation;

use crate::cli_action::CliAction;
use crate::cli_logger;
use crate::command_needs::{command_needs, RuntimeNeed};
use crate::redact_err;

pub(crate) struct ProjectContext {
    pub(crate) name: String,
    pub(crate) dir: PathBuf,
    pub(crate) user_config: SpeedwaveUserConfig,
}

pub(crate) struct Prepared {
    project: Option<ProjectContext>,
    runtime: Option<LockedRuntime>,
    _session: Option<CliSessionGuard>,
}

impl Prepared {
    pub(crate) fn take_project(&mut self) -> anyhow::Result<ProjectContext> {
        self.project.take().ok_or_else(|| {
            anyhow::anyhow!("internal error: the command needs a project that was not prepared")
        })
    }

    pub(crate) fn take_runtime(&mut self) -> anyhow::Result<LockedRuntime> {
        self.take_runtime_if_running().ok_or_else(|| {
            anyhow::anyhow!("internal error: the command needs a runtime that was not prepared")
        })
    }

    pub(crate) fn take_runtime_if_running(&mut self) -> Option<LockedRuntime> {
        self.runtime.take()
    }
}

pub(crate) fn prepare(action: &CliAction, data_dir: &Path) -> anyhow::Result<Prepared> {
    let needs = command_needs(action);
    let project = if needs.project {
        Some(resolve_project(action, data_dir)?)
    } else {
        None
    };
    let runtime = acquire_runtime(needs.runtime);
    let session = if needs.session_lock {
        acquire_session(data_dir)
    } else {
        None
    };
    if needs.runtime == RuntimeNeed::Start {
        speedwave_runtime::provision::ensure_windows_invariants();
    }
    Ok(Prepared {
        project,
        runtime,
        _session: session,
    })
}

fn resolve_project(action: &CliAction, data_dir: &Path) -> anyhow::Result<ProjectContext> {
    let user_config = config::load_user_config_from(&data_dir.join("config.json"))
        .map_err(|e| anyhow::anyhow!("Failed to load config: {}", redact_err(&e)))?;
    let name = resolve_action_project(action, &user_config)?;
    validation::validate_project_name(&name)?;
    let dir = project_dir(&user_config, &name)?;
    cli_logger::attach_file(&consts::cli_log_path_under(data_dir, &name));
    Ok(ProjectContext {
        name,
        dir,
        user_config,
    })
}

fn resolve_action_project(
    action: &CliAction,
    user_config: &SpeedwaveUserConfig,
) -> anyhow::Result<String> {
    match action {
        CliAction::Run(Some(name))
        | CliAction::Login(Some(name))
        | CliAction::Logout(Some(name))
        | CliAction::Update(Some(name))
        | CliAction::PluginEnable { project: name, .. }
        | CliAction::PluginDisable { project: name, .. } => {
            user_config.require_project(name)?;
            Ok(name.clone())
        }
        _ => resolve_project_fallback(user_config),
    }
}

fn resolve_project_fallback(user_config: &SpeedwaveUserConfig) -> anyhow::Result<String> {
    user_config
        .active_project
        .clone()
        .or_else(|| user_config.projects.first().map(|p| p.name.clone()))
        .ok_or_else(|| {
            anyhow::anyhow!(
                "No project configured. Run `speedwave init` or complete the Speedwave.app setup."
            )
        })
}

fn project_dir(user_config: &SpeedwaveUserConfig, name: &str) -> anyhow::Result<PathBuf> {
    user_config
        .find_project(name)
        .map(|p| PathBuf::from(&p.dir))
        .ok_or_else(|| {
            let available = user_config
                .projects
                .iter()
                .map(|p| p.name.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            anyhow::anyhow!("project '{name}' not found in config. Available projects: {available}")
        })
}

fn acquire_runtime(need: RuntimeNeed) -> Option<LockedRuntime> {
    match need {
        RuntimeNeed::None => None,
        RuntimeNeed::IfRunning => Some(detect_runtime()).filter(LockedRuntime::is_available),
        RuntimeNeed::Start => Some(start_runtime()),
    }
}

fn start_runtime() -> LockedRuntime {
    let runtime = detect_runtime();
    if !runtime.is_available() {
        if !runtime.is_installed() {
            runtime_not_available();
        }
        err!("Starting the Speedwave runtime (it was stopped)...");
        if let Err(e) = runtime.ensure_ready() {
            err!("Failed to start the runtime: {}", redact_err(&e));
            std::process::exit(1);
        }
    }
    runtime
}

fn runtime_not_available() -> ! {
    err!("Speedwave runtime is not running.");
    err!("CLI requires Speedwave Desktop to be running with a completed setup.");
    err!("1. Open Speedwave.app");
    err!("2. Complete the Setup Wizard");
    err!("3. Start your project");
    err!("Then run `speedwave` again.");
    std::process::exit(1);
}

fn acquire_session(data_dir: &Path) -> Option<CliSessionGuard> {
    match CliSessionGuard::acquire(data_dir) {
        Ok(guard) => Some(guard),
        Err(e) => {
            log::warn!("CLI session lock unavailable: {e}");
            None
        }
    }
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test fixtures assert on setup that must not silently fail"
)]
mod tests {
    use super::*;

    fn proj(name: &str) -> config::ProjectUserEntry {
        config::ProjectUserEntry {
            name: name.to_string(),
            dir: format!("/projects/{name}"),
            claude: None,
            integrations: None,
            plugin_settings: None,
            policy: None,
            effort_pin: None,
            read_only: false,
        }
    }

    fn config_with(
        projects: Vec<config::ProjectUserEntry>,
        active: Option<&str>,
    ) -> config::SpeedwaveUserConfig {
        config::SpeedwaveUserConfig {
            projects,
            active_project: active.map(str::to_string),
            selected_ide: None,
            ui: None,
            telemetry: None,
        }
    }

    #[test]
    fn resolve_fallback_prefers_active_project() {
        let cfg = config_with(vec![proj("alpha"), proj("beta")], Some("beta"));
        assert_eq!(resolve_project_fallback(&cfg).unwrap(), "beta");
    }

    #[test]
    fn resolve_fallback_uses_first_when_active_none() {
        let cfg = config_with(vec![proj("alpha"), proj("beta")], None);
        assert_eq!(resolve_project_fallback(&cfg).unwrap(), "alpha");
    }

    #[test]
    fn resolve_fallback_errors_when_no_projects() {
        let cfg = config_with(vec![], None);
        assert!(resolve_project_fallback(&cfg).is_err());
    }

    #[test]
    fn resolve_fallback_ignores_cwd() {
        let cwd = std::env::current_dir().unwrap();
        let cwd_project = config::ProjectUserEntry {
            name: "here".to_string(),
            dir: cwd.to_string_lossy().to_string(),
            claude: None,
            integrations: None,
            plugin_settings: None,
            policy: None,
            effort_pin: None,
            read_only: false,
        };
        let cfg = config_with(vec![proj("alpha"), cwd_project], Some("alpha"));
        assert_eq!(resolve_project_fallback(&cfg).unwrap(), "alpha");
    }

    #[test]
    fn resolve_action_project_uses_run_override() {
        let cfg = config_with(vec![proj("alpha"), proj("beta")], Some("alpha"));
        let action = CliAction::Run(Some("beta".to_string()));
        assert_eq!(resolve_action_project(&action, &cfg).unwrap(), "beta");
    }

    #[test]
    fn resolve_action_project_bare_run_uses_active() {
        let cfg = config_with(vec![proj("alpha"), proj("beta")], Some("beta"));
        let action = CliAction::Run(None);
        assert_eq!(resolve_action_project(&action, &cfg).unwrap(), "beta");
    }

    #[test]
    fn resolve_action_project_login_override_wins() {
        let cfg = config_with(vec![proj("alpha"), proj("beta")], Some("alpha"));
        let action = CliAction::Login(Some("beta".to_string()));
        assert_eq!(resolve_action_project(&action, &cfg).unwrap(), "beta");
    }

    #[test]
    fn resolve_action_project_explicit_missing_errors() {
        let cfg = config_with(vec![proj("alpha")], Some("alpha"));
        let action = CliAction::Run(Some("typo".to_string()));
        let err = resolve_action_project(&action, &cfg).unwrap_err();
        assert!(
            err.to_string().contains("not found in config"),
            "expected not-found error, got: {err}"
        );
    }

    #[test]
    fn resolve_action_project_update_override_wins() {
        let cfg = config_with(vec![proj("alpha"), proj("beta")], Some("alpha"));
        let action = CliAction::Update(Some("beta".to_string()));
        assert_eq!(resolve_action_project(&action, &cfg).unwrap(), "beta");
    }

    #[test]
    fn resolve_action_project_logout_override_wins() {
        let cfg = config_with(vec![proj("alpha"), proj("beta")], Some("alpha"));
        let action = CliAction::Logout(Some("beta".to_string()));
        assert_eq!(resolve_action_project(&action, &cfg).unwrap(), "beta");
    }

    fn write_config(data_dir: &Path, cfg: &SpeedwaveUserConfig) {
        std::fs::write(
            data_dir.join("config.json"),
            serde_json::to_string(cfg).unwrap(),
        )
        .unwrap();
    }

    fn cli_log_exists(data_dir: &Path, project: &str) -> bool {
        consts::cli_log_path_under(data_dir, project).exists()
    }

    fn prepared_project(action: &CliAction, data_dir: &Path) -> ProjectContext {
        prepare(action, data_dir).unwrap().take_project().unwrap()
    }

    fn prepare_error(action: &CliAction, data_dir: &Path) -> String {
        format!("{:#}", prepare(action, data_dir).err().unwrap())
    }

    fn enable(project: &str) -> CliAction {
        CliAction::PluginEnable {
            service_id: "svc".to_string(),
            project: project.to_string(),
        }
    }

    #[test]
    fn prepare_uses_the_explicit_project_and_creates_its_cli_log() {
        let data = tempfile::tempdir().unwrap();
        write_config(
            data.path(),
            &config_with(vec![proj("alpha"), proj("beta")], Some("alpha")),
        );

        let project = prepared_project(&CliAction::Logout(Some("beta".to_string())), data.path());

        assert_eq!(project.name, "beta");
        assert_eq!(project.dir, PathBuf::from("/projects/beta"));
        assert!(cli_log_exists(data.path(), "beta"));
        assert!(!cli_log_exists(data.path(), "alpha"));
    }

    #[test]
    fn prepare_defaults_to_the_active_project() {
        let data = tempfile::tempdir().unwrap();
        write_config(
            data.path(),
            &config_with(vec![proj("alpha"), proj("beta")], Some("beta")),
        );

        let project = prepared_project(&CliAction::Logout(None), data.path());

        assert_eq!(project.name, "beta");
        assert!(cli_log_exists(data.path(), "beta"));
    }

    #[test]
    fn prepare_defaults_to_the_first_project_when_none_is_active() {
        let data = tempfile::tempdir().unwrap();
        write_config(
            data.path(),
            &config_with(vec![proj("alpha"), proj("beta")], None),
        );

        let project = prepared_project(&CliAction::Logout(None), data.path());

        assert_eq!(project.name, "alpha");
        assert!(cli_log_exists(data.path(), "alpha"));
    }

    #[test]
    fn prepare_hands_over_the_loaded_user_config() {
        let data = tempfile::tempdir().unwrap();
        write_config(
            data.path(),
            &config_with(vec![proj("alpha"), proj("beta")], Some("beta")),
        );

        let project = prepared_project(&CliAction::Logout(None), data.path());

        assert_eq!(project.user_config.projects.len(), 2);
        assert_eq!(project.user_config.active_project.as_deref(), Some("beta"));
    }

    #[test]
    fn prepare_without_any_project_fails_and_creates_no_log_directory() {
        let data = tempfile::tempdir().unwrap();

        let message = prepare_error(&CliAction::Logout(None), data.path());

        assert!(message.contains("No project configured"), "{message}");
        assert!(!data.path().join("logs").exists());
    }

    #[test]
    fn prepare_rejects_an_unknown_explicit_project_without_creating_its_log_directory() {
        let data = tempfile::tempdir().unwrap();
        write_config(
            data.path(),
            &config_with(vec![proj("alpha")], Some("alpha")),
        );

        let message = prepare_error(&CliAction::Logout(Some("typo".to_string())), data.path());

        assert!(
            message.contains("project 'typo' not found in config"),
            "{message}"
        );
        assert!(!data.path().join("logs").exists());
    }

    #[test]
    fn prepare_rejects_an_active_project_missing_from_the_config_without_a_log_directory() {
        let data = tempfile::tempdir().unwrap();
        write_config(
            data.path(),
            &config_with(vec![proj("alpha")], Some("ghost")),
        );

        let message = prepare_error(&CliAction::Logout(None), data.path());

        assert!(
            message.contains("project 'ghost' not found in config. Available projects: alpha"),
            "{message}"
        );
        assert!(!data.path().join("logs").exists());
    }

    #[test]
    fn prepare_rejects_an_invalid_project_name_without_creating_a_directory() {
        for name in ["-bad", "../x", "Upper", "with space"] {
            let data = tempfile::tempdir().unwrap();
            write_config(data.path(), &config_with(vec![proj(name)], Some(name)));

            let explicit = prepare_error(&CliAction::Logout(Some(name.to_string())), data.path());
            let default = prepare_error(&CliAction::Logout(None), data.path());

            assert!(explicit.contains("project name"), "{name}: {explicit}");
            assert!(default.contains("project name"), "{name}: {default}");
            assert!(!data.path().join("logs").exists(), "{name}");
            assert!(!data.path().join("x").exists(), "{name}");
        }
    }

    #[test]
    fn prepare_for_plugin_enable_uses_the_project_of_the_action() {
        let data = tempfile::tempdir().unwrap();
        write_config(
            data.path(),
            &config_with(vec![proj("alpha"), proj("beta")], Some("alpha")),
        );

        let project = prepared_project(&enable("beta"), data.path());

        assert_eq!(project.name, "beta");
        assert!(cli_log_exists(data.path(), "beta"));
        assert!(!cli_log_exists(data.path(), "alpha"));
    }

    #[test]
    fn prepare_for_plugin_disable_rejects_an_unknown_project_without_a_log_directory() {
        let data = tempfile::tempdir().unwrap();
        write_config(
            data.path(),
            &config_with(vec![proj("alpha")], Some("alpha")),
        );
        let action = CliAction::PluginDisable {
            service_id: "svc".to_string(),
            project: "typo".to_string(),
        };

        let message = prepare_error(&action, data.path());

        assert!(
            message.contains("project 'typo' not found in config"),
            "{message}"
        );
        assert!(!data.path().join("logs").exists());
    }

    #[test]
    fn prepare_for_plugin_enable_rejects_an_invalid_project_name_without_a_log_directory() {
        let data = tempfile::tempdir().unwrap();
        write_config(data.path(), &config_with(vec![proj("-bad")], None));

        let message = prepare_error(&enable("-bad"), data.path());

        assert!(message.contains("project name"), "{message}");
        assert!(!data.path().join("logs").exists());
    }

    #[test]
    fn prepare_reports_an_unreadable_config() {
        let data = tempfile::tempdir().unwrap();
        std::fs::write(data.path().join("config.json"), "{ not json").unwrap();

        let message = prepare_error(&CliAction::Logout(None), data.path());

        assert!(message.starts_with("Failed to load config: "), "{message}");
        assert!(!data.path().join("logs").exists());
    }

    #[test]
    fn prepare_changes_nothing_in_the_config() {
        let data = tempfile::tempdir().unwrap();
        write_config(data.path(), &config_with(vec![proj("alpha")], None));
        let before = std::fs::read(data.path().join("config.json")).unwrap();

        let _ = prepared_project(&CliAction::Logout(None), data.path());

        assert_eq!(
            std::fs::read(data.path().join("config.json")).unwrap(),
            before
        );
    }

    #[test]
    fn prepare_for_commands_without_a_project_reads_no_config_and_creates_no_log() {
        let data = tempfile::tempdir().unwrap();
        std::fs::write(data.path().join("config.json"), "{ not json").unwrap();

        for action in [CliAction::PluginList, CliAction::Init(None)] {
            let mut prepared = prepare(&action, data.path()).unwrap();
            assert!(prepared.take_project().is_err());
            assert!(prepared.take_runtime_if_running().is_none());
        }
        assert!(!data.path().join("logs").exists());
    }

    #[test]
    fn a_command_asking_for_a_runtime_that_was_not_prepared_gets_an_error() {
        let data = tempfile::tempdir().unwrap();
        write_config(data.path(), &config_with(vec![proj("alpha")], None));
        let mut prepared = prepare(&CliAction::Logout(None), data.path()).unwrap();

        let message = format!("{:#}", prepared.take_runtime().err().unwrap());

        assert!(
            message.contains("runtime that was not prepared"),
            "{message}"
        );
    }
}
