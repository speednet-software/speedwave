use std::path::Path;

use speedwave_runtime::consts;
use speedwave_runtime::plugin::PluginManifest;
use speedwave_runtime::secret_store::{builtin_secret_fields, SecretName};

use super::walk::Kind;
use super::Run;

const SUPERSEDED_FIELDS: &[(&str, &str)] = &[("sharepoint", "refresh_token")];

pub(super) fn migrate(run: &mut Run<'_>) {
    for project in run.project_dirs("tokens") {
        for service in run.entries(&project.path, Kind::Dir) {
            match service.name.as_str() {
                "llm" => migrate_llm(run, &project.name, &service.path),
                "local-llm" => migrate_local_llm(run, &project.name, &service.path),
                name => migrate_service(run, &project.name, name, &service.path),
            }
        }
    }
}

fn migrate_service(run: &mut Run<'_>, project: &str, service: &str, dir: &Path) {
    let fields: Vec<String> = if consts::find_mcp_service(service).is_some() {
        builtin_secret_fields(service)
            .into_iter()
            .map(str::to_owned)
            .collect()
    } else if let Some(manifest) = run.manifest_by_config_key(service) {
        plugin_secret_fields(manifest)
    } else {
        run.skipped += 1;
        return;
    };
    for field in fields {
        if SUPERSEDED_FIELDS.contains(&(service, field.as_str())) {
            continue;
        }
        let Some(name) = SecretName::integration(project, service, &field).ok() else {
            run.skipped += 1;
            continue;
        };
        run.move_file(&dir.join(&field), Some(name), project, service);
    }
}

fn plugin_secret_fields(manifest: &PluginManifest) -> Vec<String> {
    let mut fields: Vec<String> = manifest
        .auth_fields
        .iter()
        .filter(|field| field.is_secret && !field.oauth_flow)
        .map(|field| field.key.clone())
        .collect();
    if manifest.oauth.is_some() && !fields.iter().any(|field| field == "access_token") {
        fields.push("access_token".to_owned());
    }
    fields
}

fn migrate_llm(run: &mut Run<'_>, project: &str, dir: &Path) {
    for entry in run.entries(dir, Kind::File) {
        let Some(provider) = entry.name.strip_suffix("_api_key") else {
            continue;
        };
        let Some(name) = SecretName::llm_provider_key(project, provider).ok() else {
            run.skipped += 1;
            continue;
        };
        run.move_file(&entry.path, Some(name), project, "llm");
    }
}

fn migrate_local_llm(run: &mut Run<'_>, project: &str, dir: &Path) {
    run.move_file(
        &dir.join("api_key"),
        SecretName::local_llm_api_key(project).ok(),
        project,
        "local-llm",
    );
    run.move_file(
        &dir.join("custom_headers"),
        SecretName::local_llm_custom_headers(project).ok(),
        project,
        "local-llm",
    );
}
