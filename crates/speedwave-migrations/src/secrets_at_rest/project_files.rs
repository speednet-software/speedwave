use speedwave_runtime::secret_store::{secret_exists_in, SecretName};

use super::walk::{read_plain, Plain};
use super::Run;

const PII_KEY_HEX_LEN: usize = 64;

pub(super) fn migrate(run: &mut Run<'_>) {
    migrate_anthropic_keys(run);
    migrate_pii_keys(run);
}

fn migrate_anthropic_keys(run: &mut Run<'_>) {
    for project in run.project_dirs("secrets") {
        run.move_file(
            &project.path.join("anthropic_api_key"),
            SecretName::anthropic_api_key(&project.name).ok(),
            &project.name,
            "anthropic",
        );
    }
}

fn migrate_pii_keys(run: &mut Run<'_>) {
    for project in run.project_dirs("policies") {
        migrate_pii_key(run, &project.name, &project.path.join("key"));
    }
}

fn migrate_pii_key(run: &mut Run<'_>, project: &str, path: &std::path::Path) {
    let value = match read_plain(path) {
        Plain::Absent => return,
        Plain::NotRegular | Plain::Unreadable => return run.fail_pii_key(project),
        Plain::Blank => return remove_pii_key(run, project, path),
        Plain::Value(value) => value,
    };
    let key = value.trim();
    let Some(name) = SecretName::pii_key(project).ok() else {
        return run.fail_pii_key(project);
    };
    if !secret_exists_in(run.data_dir, &name) && !is_hex_key(key) {
        return run.fail_pii_key(project);
    }
    if run.store_secret(&name, key) {
        run.migrated += 1;
        remove_pii_key(run, project, path);
    } else {
        run.fail_pii_key(project);
    }
}

fn remove_pii_key(run: &mut Run<'_>, project: &str, path: &std::path::Path) {
    match std::fs::remove_file(path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => run.fail_pii_key(project),
    }
}

fn is_hex_key(key: &str) -> bool {
    key.len() == PII_KEY_HEX_LEN && key.bytes().all(|byte| byte.is_ascii_hexdigit())
}
