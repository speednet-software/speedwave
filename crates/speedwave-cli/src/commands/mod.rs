mod check;
mod compose_inputs;
mod init;
mod login;
mod logout;
mod plugin;
mod session;
mod update;

use crate::cli_action::CliAction;
use crate::project_command::Prepared;

pub(crate) fn run(action: &CliAction, mut prepared: Prepared) -> anyhow::Result<()> {
    match action {
        CliAction::Run(_) => session::run(prepared.take_project()?, prepared.take_runtime()?),
        CliAction::Login(_) => login::run(prepared.take_project()?, prepared.take_runtime()?),
        CliAction::Update(_) => update::run(prepared.take_project()?, prepared.take_runtime()?),
        CliAction::Check => check::run(prepared.take_project()?, prepared.take_runtime()?),
        CliAction::Logout(_) => logout::run(&prepared.take_project()?),
        CliAction::Init(custom_name) => init::run(custom_name.as_deref()),
        CliAction::PluginInstall(path) => {
            plugin::install(path, prepared.take_runtime_if_running().as_ref())
        }
        CliAction::PluginList => {
            plugin::list();
            Ok(())
        }
        CliAction::PluginRemove(slug) => {
            plugin::remove(slug, prepared.take_runtime_if_running().as_ref())
        }
        CliAction::PluginEnable { service_id, .. } => {
            plugin::enable(service_id, &prepared.take_project()?.name)
        }
        CliAction::PluginDisable { service_id, .. } => {
            plugin::disable(service_id, &prepared.take_project()?.name)
        }
        CliAction::Help | CliAction::Version | CliAction::SelfUpdate => Ok(()),
    }
}
