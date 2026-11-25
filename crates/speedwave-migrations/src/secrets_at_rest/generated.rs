use super::walk::{read_plain, Plain};
use super::Run;

const SECRET_ENV_NAMES: &[&str] = &[
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_CUSTOM_HEADERS",
    "SPEEDWAVE_GIT_PROXY_AUTH",
];

pub(super) fn migrate(run: &mut Run<'_>) {
    remove_with_secrets(run, "compose", "compose.yml");
    remove_with_secrets(run, "snapshots", "snapshot.json");
}

fn remove_with_secrets(run: &mut Run<'_>, base: &str, file_name: &str) {
    for project in run.project_dirs(base) {
        let path = project.path.join(file_name);
        let Plain::Value(text) = read_plain(&path) else {
            continue;
        };
        if !SECRET_ENV_NAMES.iter().any(|name| text.contains(name)) {
            continue;
        }
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => run.stale_files += 1,
        }
    }
}
