use std::path::Path;

use serde_json::{Map, Value};
use speedwave_runtime::consts;
use speedwave_runtime::fs_perms::write_restricted_file_atomic;
use speedwave_runtime::plugin::PluginManifest;
use speedwave_runtime::secret_store::SecretName;

use super::walk::{read_plain, Kind, Plain};
use super::Run;

const SEED_SUFFIX: &str = ".seed.json";
const STATE_SUFFIX: &str = ".json";

pub(super) fn migrate(run: &mut Run<'_>) {
    for project in run.project_dirs(consts::OAUTH_SUBDIR) {
        for file in run.entries(&project.path, Kind::File) {
            if file.name.starts_with('.') {
                continue;
            }
            if let Some(slug) = file.name.strip_suffix(SEED_SUFFIX) {
                migrate_seed(run, &project.name, slug, &file.path);
            } else if let Some(service) = file.name.strip_suffix(STATE_SUFFIX) {
                migrate_state(run, &project.name, service, &file.path);
            }
        }
    }
}

fn migrate_state(run: &mut Run<'_>, project: &str, service: &str, path: &Path) {
    let Some(refresh_token) = SecretName::oauth_refresh_token(project, service).ok() else {
        run.skipped += 1;
        return;
    };
    let Some(mut state) = read_object(run, project, service, path) else {
        return;
    };
    if !state.get("provider").is_some_and(Value::is_string) {
        run.skipped += 1;
        return;
    }
    let mut changed = lift(
        run,
        &mut state,
        "refreshToken",
        Some(refresh_token),
        project,
        service,
    );
    if let Some(Value::Object(provider_data)) = state.get_mut("providerData") {
        let client_secret = SecretName::oauth_client_secret(project, service).ok();
        changed |= lift(
            run,
            provider_data,
            "clientSecret",
            client_secret,
            project,
            service,
        );
    }
    if changed {
        rewrite(run, project, service, path, state);
    }
}

fn migrate_seed(run: &mut Run<'_>, project: &str, slug: &str, path: &Path) {
    let Some(keys) = run.manifest_by_slug(slug).map(secret_seed_keys) else {
        run.skipped += 1;
        return;
    };
    let Some(mut seed) = read_object(run, project, slug, path) else {
        return;
    };
    let mut changed = false;
    for key in keys {
        let name = SecretName::integration(project, slug, &key).ok();
        changed |= lift(run, &mut seed, &key, name, project, slug);
    }
    if changed {
        rewrite(run, project, slug, path, seed);
    }
}

fn secret_seed_keys(manifest: &PluginManifest) -> Vec<String> {
    let mut keys: Vec<String> = manifest
        .auth_fields
        .iter()
        .filter(|field| field.is_secret)
        .map(|field| field.key.clone())
        .collect();
    let client_secret_field = manifest
        .oauth
        .as_ref()
        .and_then(|oauth| oauth.client_secret_field.clone());
    if let Some(field) = client_secret_field {
        if !keys.contains(&field) {
            keys.push(field);
        }
    }
    keys
}

fn read_object(
    run: &mut Run<'_>,
    project: &str,
    service: &str,
    path: &Path,
) -> Option<Map<String, Value>> {
    let text = match read_plain(path) {
        Plain::Value(text) => text,
        Plain::Absent => return None,
        Plain::Blank | Plain::NotRegular => {
            run.skipped += 1;
            return None;
        }
        Plain::Unreadable => {
            run.fail_integration(project, service);
            return None;
        }
    };
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(object)) => Some(object),
        _ => {
            run.skipped += 1;
            None
        }
    }
}

fn lift(
    run: &mut Run<'_>,
    object: &mut Map<String, Value>,
    key: &str,
    name: Option<SecretName>,
    project: &str,
    service: &str,
) -> bool {
    let Some(text) = object.get(key).and_then(Value::as_str) else {
        return false;
    };
    if text.trim().is_empty() {
        object.remove(key);
        return true;
    }
    let Some(name) = name else {
        run.skipped += 1;
        return false;
    };
    if run.store_secret(&name, text) {
        run.migrated += 1;
        object.remove(key);
        true
    } else {
        run.fail_integration(project, service);
        false
    }
}

fn rewrite(
    run: &mut Run<'_>,
    project: &str,
    service: &str,
    path: &Path,
    object: Map<String, Value>,
) {
    let written = serde_json::to_string_pretty(&Value::Object(object))
        .ok()
        .and_then(|body| write_restricted_file_atomic(path, &(body + "\n")).ok());
    if written.is_none() {
        run.fail_integration(project, service);
    }
}
