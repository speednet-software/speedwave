use speedwave_runtime::consts;

use crate::project_command::ProjectContext;

pub(super) fn run(project: &ProjectContext) -> anyhow::Result<()> {
    let project_name = &project.name;
    let removed = speedwave_runtime::claude_home::remove_claude_credentials(
        consts::data_dir(),
        project_name,
    )?;
    if removed == 0 {
        err!("No Claude credentials found for project '{project_name}'.");
    } else {
        err!("Removed Claude credentials for project '{project_name}' ({removed} file(s)).");
    }
    Ok(())
}
