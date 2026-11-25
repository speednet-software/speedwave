use super::secret_slots::{
    builtin_worker_has_tokens, claude_secrets_mount, enabled_builtin_workers,
    enabled_plugin_workers, hub_policy_mount, hub_secrets_mount, proxy_config_mount,
    proxy_git_mount, proxy_policy_mount, proxy_tokens_mount, worker_auth_mount,
    worker_tokens_mount, SlotMount, CLAUDE_API_KEY_FILE, CLAUDE_AUTH_TOKEN_FILE,
    CLAUDE_CUSTOM_HEADERS_FILE, CLAUDE_GIT_PROXY_AUTH_FILE, OS_AUTH_TOKEN_FILE_NAME,
    PROXY_CONFIG_FILE, WORKER_AUTH_FILE,
};
use super::{llm, proxy, workers};
use crate::config::{ResolvedClaudeConfig, ResolvedIntegrationsConfig};
use crate::consts::{self, McpServiceDescriptor};
use crate::plugin::PluginManifest;
use crate::secret_store::{builtin_secret_fields, ProjectSecrets, SecretName, SecretStore};
use crate::secrets_tmpfs::layout::{validate_file_name, ProjectPayload, SecretFile, SlotFiles};
use std::path::Path;

const REFRESH_TOKEN_FIELD: &str = "refresh_token";
const ACCESS_TOKEN_FIELD: &str = "access_token";
const PII_SERVICE: &str = "pii";
const PII_KEY_FIELD: &str = "key";
const LLM_KEY_FIELD_SUFFIX: &str = "_api_key";

pub(super) struct WorkerCredentials {
    service: String,
    delivered: Vec<String>,
    host_only: Vec<String>,
}

impl WorkerCredentials {
    pub(super) fn builtin_key(config_key: &str) -> Self {
        let (host_only, delivered) = builtin_secret_fields(config_key)
            .into_iter()
            .map(str::to_string)
            .partition(|field| field == REFRESH_TOKEN_FIELD);
        Self {
            service: config_key.to_string(),
            delivered,
            host_only,
        }
    }

    pub(super) fn builtin(svc: &McpServiceDescriptor) -> Self {
        Self::builtin_key(svc.config_key)
    }

    pub(super) fn plugin(service_id: &str, manifest: &PluginManifest) -> Self {
        let mut delivered = Vec::new();
        let mut host_only = Vec::new();
        for field in manifest.auth_fields.iter().filter(|field| field.is_secret) {
            if field.oauth_flow {
                host_only.push(field.key.clone());
            } else {
                delivered.push(field.key.clone());
            }
        }
        if manifest.oauth.is_some() {
            delivered.push(ACCESS_TOKEN_FIELD.to_string());
            host_only.push(REFRESH_TOKEN_FIELD.to_string());
        }
        delivered.sort();
        delivered.dedup();
        host_only.sort();
        host_only.dedup();
        host_only.retain(|field| !delivered.contains(field));
        Self {
            service: service_id.to_string(),
            delivered,
            host_only,
        }
    }

    pub(super) fn files(
        &self,
        project: &str,
        tokens_dir: &Path,
        secrets: &ProjectSecrets,
    ) -> anyhow::Result<Option<Vec<SecretFile>>> {
        if has_unreadable_secret(secrets, &self.service) {
            return Ok(None);
        }
        let mut excluded = vec![consts::OAUTH_REFRESH_STATUS_FILE];
        excluded.extend(
            self.delivered
                .iter()
                .chain(&self.host_only)
                .map(String::as_str),
        );
        let mut files = regular_files_in(tokens_dir, &excluded)?;
        for field in &self.delivered {
            if SecretName::integration(project, &self.service, field).is_err() {
                log::warn!(
                    "plugin '{}' declares a secret field that is not a valid secret name; skipped",
                    self.service
                );
                continue;
            }
            if let Some(value) = secret_value(secrets, &self.service, field) {
                files.push(SecretFile::new(field.clone(), value.as_bytes()));
            }
        }
        files.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(Some(files))
    }
}

fn has_unreadable_secret(secrets: &ProjectSecrets, service: &str) -> bool {
    secrets
        .unreadable
        .iter()
        .any(|name| name.service() == service)
}

fn secret_value<'a>(secrets: &'a ProjectSecrets, service: &str, field: &str) -> Option<&'a str> {
    secrets
        .values
        .iter()
        .find(|(name, _)| name.service() == service && name.field() == field)
        .map(|(_, value)| value.as_str())
}

pub(crate) fn collect_project_payload_in(
    data_dir: &Path,
    project: &str,
    resolved_config: &ResolvedClaudeConfig,
    integrations: &ResolvedIntegrationsConfig,
    plugin_manifests: &[PluginManifest],
) -> anyhow::Result<ProjectPayload> {
    crate::validation::validate_project_name(project)?;
    let tokens_root = super::resolve_tokens_dir_in(data_dir, project);
    let store = SecretStore::open(data_dir)?;
    crate::pii_key::ensure_project_key_in(data_dir, project)?;
    let secrets = store.read_project(project)?;
    for message in secrets.unreadable_messages() {
        log::warn!("{message} The integration is started without its credentials.");
    }
    let proxy_config =
        proxy::project_proxy_config_in(data_dir, project, resolved_config, integrations)?;
    let mut slots = Vec::new();
    let mut hub_files = Vec::new();

    for svc in enabled_builtin_workers(integrations) {
        if builtin_worker_has_tokens(svc) {
            let files = WorkerCredentials::builtin(svc).files(
                project,
                &tokens_root.join(svc.config_key),
                &secrets,
            )?;
            slots.push(worker_tokens_slot(
                worker_tokens_mount(svc.compose_name)?,
                files,
            ));
        }
        let bearer = workers::derived_worker_bearer(&store, project, svc.config_key)?;
        slots.push(SlotFiles::new(
            worker_auth_mount(svc.compose_name)?.slot,
            vec![SecretFile::new(WORKER_AUTH_FILE, bearer.as_str())],
        ));
        hub_files.push(SecretFile::new(
            workers::worker_bearer_file_name(svc.config_key),
            bearer,
        ));
    }

    for worker in enabled_plugin_workers(integrations, plugin_manifests) {
        let files = WorkerCredentials::plugin(worker.service_id, worker.manifest).files(
            project,
            &tokens_root.join(worker.service_id),
            &secrets,
        )?;
        slots.push(worker_tokens_slot(
            worker_tokens_mount(&worker.compose_name)?,
            files,
        ));
        hub_files.push(SecretFile::new(
            workers::worker_bearer_file_name(worker.service_id),
            workers::derived_worker_bearer(&store, project, worker.service_id)?,
        ));
    }

    if let Some((_, token)) = workers::running_mcp_os_in(data_dir) {
        hub_files.push(SecretFile::new(OS_AUTH_TOKEN_FILE_NAME, token));
    }
    slots.push(SlotFiles::new(hub_secrets_mount()?.slot, hub_files));

    let policy_files = policy_files(data_dir, project, &secrets)?;
    slots.push(SlotFiles::new(
        hub_policy_mount()?.slot,
        policy_files.clone(),
    ));
    slots.push(SlotFiles::new(proxy_policy_mount()?.slot, policy_files));

    slots.push(SlotFiles::new(
        proxy_config_mount()?.slot,
        vec![SecretFile::new(
            PROXY_CONFIG_FILE,
            proxy_config.config.content,
        )],
    ));
    slots.push(SlotFiles::new(
        proxy_tokens_mount()?.slot,
        provider_key_files(&secrets),
    ));
    for forge in &proxy_config.git_forges {
        let key = forge.kind.config_key();
        let files =
            WorkerCredentials::builtin_key(key).files(project, &tokens_root.join(key), &secrets)?;
        slots.push(SlotFiles::new(
            proxy_git_mount(forge.kind)?.slot,
            files.unwrap_or_default(),
        ));
    }

    slots.push(SlotFiles::new(
        claude_secrets_mount()?.slot,
        claude_secret_files(
            data_dir,
            project,
            resolved_config,
            !proxy_config.git_forges.is_empty(),
        )?,
    ));

    Ok(ProjectPayload { slots })
}

fn worker_tokens_slot(mount: SlotMount, files: Option<Vec<SecretFile>>) -> SlotFiles {
    let mut slot = SlotFiles::new(mount.slot, files.unwrap_or_default());
    slot.keep
        .push(consts::OAUTH_REFRESH_STATUS_FILE.to_string());
    slot
}

fn provider_key_files(secrets: &ProjectSecrets) -> Vec<SecretFile> {
    secrets
        .values
        .iter()
        .filter(|(name, _)| {
            name.service() == super::LLM_TOKEN_SERVICE
                && name.field().ends_with(LLM_KEY_FIELD_SUFFIX)
        })
        .map(|(name, value)| SecretFile::new(name.field(), value.as_bytes()))
        .collect()
}

fn policy_files(
    data_dir: &Path,
    project: &str,
    secrets: &ProjectSecrets,
) -> anyhow::Result<Vec<SecretFile>> {
    let mut files = regular_files_in(
        &crate::pii_policy::policy_config_dir_in(data_dir, project),
        &[PII_KEY_FIELD],
    )?;
    let Some(key) = secret_value(secrets, PII_SERVICE, PII_KEY_FIELD) else {
        anyhow::bail!("the PII tokenization key of project '{project}' cannot be read");
    };
    files.push(SecretFile::new(PII_KEY_FIELD, key.as_bytes()));
    files.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(files)
}

fn claude_secret_files(
    data_dir: &Path,
    project: &str,
    resolved_config: &ResolvedClaudeConfig,
    git_forges_enabled: bool,
) -> anyhow::Result<Vec<SecretFile>> {
    let mut files = Vec::new();
    if llm::anthropic_provider_active(&resolved_config.llm) {
        if let Some(api_key) = llm::anthropic_api_key_in(data_dir, project)? {
            files.push(SecretFile::new(CLAUDE_API_KEY_FILE, api_key));
        }
    }
    let llm_env = llm::claude_llm_env_in(data_dir, &resolved_config.llm, project)?;
    if let Some(auth_token) = llm_env.auth_token {
        files.push(SecretFile::new(CLAUDE_AUTH_TOKEN_FILE, auth_token));
    }
    if let Some(custom_headers) = llm_env.custom_headers {
        files.push(SecretFile::new(CLAUDE_CUSTOM_HEADERS_FILE, custom_headers));
    }
    if git_forges_enabled {
        files.push(SecretFile::new(
            CLAUDE_GIT_PROXY_AUTH_FILE,
            proxy::caller_token_in(data_dir, project)?,
        ));
    }
    Ok(files)
}

fn regular_files_in(dir: &Path, excluded: &[&str]) -> anyhow::Result<Vec<SecretFile>> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => anyhow::bail!("cannot read {}: {e}", dir.display()),
    };
    let mut files = Vec::new();
    for entry in entries {
        let entry = entry?;
        let file_name = entry.file_name();
        let Some(name) = file_name.to_str() else {
            log::warn!("skipping a non-UTF-8 file name in a secrets source directory");
            continue;
        };
        if excluded.contains(&name) || workers::is_write_in_progress(&file_name) {
            continue;
        }
        if !entry.file_type()?.is_file() {
            continue;
        }
        if validate_file_name(name).is_err() {
            log::warn!("skipping a file with an unsupported name in a secrets source directory");
            continue;
        }
        let content = std::fs::read(entry.path())
            .map_err(|e| anyhow::anyhow!("cannot read {}: {e}", entry.path().display()))?;
        files.push(SecretFile::new(name, content));
    }
    files.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(files)
}
