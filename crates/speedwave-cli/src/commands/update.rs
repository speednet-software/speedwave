use speedwave_runtime::runtime::LockedRuntime;
use speedwave_runtime::update;

use crate::project_command::ProjectContext;
use crate::redact_err;

pub(super) fn run(project: ProjectContext, runtime: LockedRuntime) -> anyhow::Result<()> {
    let project_name = &project.name;
    out!("Updating containers for project '{}'...", project_name);
    match update::update_containers(&runtime, project_name) {
        Ok(result) => {
            out!(
                "Updated {} containers ({} images rebuilt)",
                result.containers_recreated,
                result.images_rebuilt
            );
            Ok(())
        }
        Err(e) => {
            let msg = redact_err(&e);
            err!("Container update failed: {msg}");
            if update::is_torn_down(&e) {
                match update::rollback_containers(&runtime, project_name) {
                    Ok(()) => err!("Rolled back to the previous container state."),
                    Err(rollback_err) => {
                        let rollback_err = redact_err(&rollback_err);
                        err!(
                            "Automatic rollback also failed: {rollback_err}. \
                             Run `speedwave` to start containers manually."
                        );
                    }
                }
            }
            std::process::exit(1);
        }
    }
}
