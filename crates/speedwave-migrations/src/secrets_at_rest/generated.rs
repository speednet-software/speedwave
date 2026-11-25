use super::Run;

pub(super) fn migrate(run: &mut Run<'_>) {
    remove_generated(run, "compose", "compose.yml");
    remove_generated(run, "snapshots", "snapshot.json");
}

fn remove_generated(run: &mut Run<'_>, base: &str, file_name: &str) {
    for project in run.project_dirs(base) {
        match std::fs::remove_file(project.path.join(file_name)) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => run.stale_files += 1,
        }
    }
}
