use crate::cli_action::CliAction;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RuntimeNeed {
    None,
    IfRunning,
    Start,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct CommandNeeds {
    pub(crate) project: bool,
    pub(crate) runtime: RuntimeNeed,
    pub(crate) session_lock: bool,
    pub(crate) plugin_audit: bool,
}

pub(crate) fn command_needs(action: &CliAction) -> CommandNeeds {
    match action {
        CliAction::Run(_) | CliAction::Login(_) | CliAction::Update(_) => CommandNeeds {
            project: true,
            runtime: RuntimeNeed::Start,
            session_lock: true,
            plugin_audit: true,
        },
        CliAction::Check => CommandNeeds {
            project: true,
            runtime: RuntimeNeed::Start,
            session_lock: false,
            plugin_audit: true,
        },
        CliAction::Logout(_) | CliAction::PluginEnable { .. } | CliAction::PluginDisable { .. } => {
            CommandNeeds {
                project: true,
                runtime: RuntimeNeed::None,
                session_lock: false,
                plugin_audit: true,
            }
        }
        CliAction::PluginInstall(_) | CliAction::PluginRemove(_) => CommandNeeds {
            project: false,
            runtime: RuntimeNeed::IfRunning,
            session_lock: false,
            plugin_audit: false,
        },
        CliAction::PluginList
        | CliAction::Init(_)
        | CliAction::Help
        | CliAction::Version
        | CliAction::SelfUpdate => CommandNeeds {
            project: false,
            runtime: RuntimeNeed::None,
            session_lock: false,
            plugin_audit: false,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn needs(
        project: bool,
        runtime: RuntimeNeed,
        session_lock: bool,
        plugin_audit: bool,
    ) -> CommandNeeds {
        CommandNeeds {
            project,
            runtime,
            session_lock,
            plugin_audit,
        }
    }

    fn enable() -> CliAction {
        CliAction::PluginEnable {
            service_id: "svc".to_string(),
            project: "p".to_string(),
        }
    }

    fn disable() -> CliAction {
        CliAction::PluginDisable {
            service_id: "svc".to_string(),
            project: "p".to_string(),
        }
    }

    #[test]
    fn bare_run_needs_a_project_a_started_runtime_the_lock_and_the_audit() {
        let expected = needs(true, RuntimeNeed::Start, true, true);
        assert_eq!(command_needs(&CliAction::Run(None)), expected);
        assert_eq!(
            command_needs(&CliAction::Run(Some("p".to_string()))),
            expected
        );
    }

    #[test]
    fn login_needs_a_project_a_started_runtime_the_lock_and_the_audit() {
        let expected = needs(true, RuntimeNeed::Start, true, true);
        assert_eq!(command_needs(&CliAction::Login(None)), expected);
        assert_eq!(
            command_needs(&CliAction::Login(Some("p".to_string()))),
            expected
        );
    }

    #[test]
    fn update_starts_the_runtime_and_takes_the_lock() {
        let expected = needs(true, RuntimeNeed::Start, true, true);
        assert_eq!(command_needs(&CliAction::Update(None)), expected);
        assert_eq!(
            command_needs(&CliAction::Update(Some("p".to_string()))),
            expected
        );
    }

    #[test]
    fn check_starts_the_runtime_without_the_lock() {
        assert_eq!(
            command_needs(&CliAction::Check),
            needs(true, RuntimeNeed::Start, false, true)
        );
    }

    #[test]
    fn logout_needs_a_project_and_no_runtime() {
        let expected = needs(true, RuntimeNeed::None, false, true);
        assert_eq!(command_needs(&CliAction::Logout(None)), expected);
        assert_eq!(
            command_needs(&CliAction::Logout(Some("p".to_string()))),
            expected
        );
    }

    #[test]
    fn plugin_enable_and_disable_need_a_project_and_no_runtime() {
        let expected = needs(true, RuntimeNeed::None, false, true);
        assert_eq!(command_needs(&enable()), expected);
        assert_eq!(command_needs(&disable()), expected);
    }

    #[test]
    fn plugin_install_and_remove_use_the_runtime_only_when_it_runs() {
        let expected = needs(false, RuntimeNeed::IfRunning, false, false);
        assert_eq!(
            command_needs(&CliAction::PluginInstall("x.zip".to_string())),
            expected
        );
        assert_eq!(
            command_needs(&CliAction::PluginRemove("slug".to_string())),
            expected
        );
    }

    #[test]
    fn plugin_list_and_init_need_nothing() {
        let expected = needs(false, RuntimeNeed::None, false, false);
        assert_eq!(command_needs(&CliAction::PluginList), expected);
        assert_eq!(command_needs(&CliAction::Init(None)), expected);
        assert_eq!(
            command_needs(&CliAction::Init(Some("name".to_string()))),
            expected
        );
    }

    #[test]
    fn help_version_and_self_update_need_nothing() {
        let expected = needs(false, RuntimeNeed::None, false, false);
        assert_eq!(command_needs(&CliAction::Help), expected);
        assert_eq!(command_needs(&CliAction::Version), expected);
        assert_eq!(command_needs(&CliAction::SelfUpdate), expected);
    }

    #[test]
    fn the_plugin_audit_is_skipped_for_recovery_actions_and_kept_for_the_rest() {
        let skipped = [
            CliAction::Init(None),
            CliAction::PluginInstall("x.zip".to_string()),
            CliAction::PluginList,
            CliAction::PluginRemove("slug".to_string()),
        ];
        let audited = [
            CliAction::Run(None),
            CliAction::Login(None),
            CliAction::Logout(None),
            CliAction::Update(None),
            CliAction::Check,
            enable(),
            disable(),
        ];
        assert!(skipped.iter().all(|a| !command_needs(a).plugin_audit));
        assert!(audited.iter().all(|a| command_needs(a).plugin_audit));
    }

    #[test]
    fn only_runtime_starting_commands_that_change_containers_take_the_lock() {
        let locked = [
            CliAction::Run(None),
            CliAction::Login(None),
            CliAction::Update(None),
        ];
        let unlocked = [
            CliAction::Check,
            CliAction::Logout(None),
            enable(),
            disable(),
            CliAction::PluginInstall("x.zip".to_string()),
            CliAction::PluginRemove("slug".to_string()),
            CliAction::PluginList,
            CliAction::Init(None),
        ];
        assert!(locked.iter().all(|a| command_needs(a).session_lock));
        assert!(unlocked.iter().all(|a| !command_needs(a).session_lock));
    }
}
