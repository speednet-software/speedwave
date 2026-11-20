//! Collects the files staged into the secrets tmpfs of one project. Reads the host files and
//! decides which slots exist through the same helpers the renderer mounts them with.

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
use crate::consts;
use crate::plugin::PluginManifest;
use crate::secrets_tmpfs::layout::{
    validate_file_name, ProjectPayload, SecretFile, Slot, SlotFiles,
};
use crate::secrets_tmpfs::stage::{self, ProjectSettings};
use std::path::Path;

pub(crate) fn collect_project_payload_in(
    data_dir: &Path,
    project: &str,
    resolved_config: &ResolvedClaudeConfig,
    integrations: &ResolvedIntegrationsConfig,
    plugin_manifests: &[PluginManifest],
) -> anyhow::Result<ProjectPayload> {
    crate::validation::validate_project_name(project)?;
    let tokens_root = super::resolve_tokens_dir_in(data_dir, project);
    let secrets_dir = super::init_secrets_dir_in(data_dir, project)?;
    let proxy_config =
        proxy::project_proxy_config_in(data_dir, project, resolved_config, integrations)?;
    let mut slots = Vec::new();
    let mut hub_files = Vec::new();

    for svc in enabled_builtin_workers(integrations) {
        if builtin_worker_has_tokens(svc) {
            slots.push(worker_tokens_slot(
                worker_tokens_mount(svc.compose_name)?,
                &tokens_root.join(svc.config_key),
            )?);
        }
        let bearer = workers::read_or_create_worker_bearer(&secrets_dir, svc.config_key)?;
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
        slots.push(worker_tokens_slot(
            worker_tokens_mount(&worker.compose_name)?,
            &tokens_root.join(worker.service_id),
        )?);
        hub_files.push(SecretFile::new(
            workers::worker_bearer_file_name(worker.service_id),
            workers::read_or_create_worker_bearer(&secrets_dir, worker.service_id)?,
        ));
    }

    if let Some((_, token)) = workers::running_mcp_os_in(data_dir) {
        hub_files.push(SecretFile::new(OS_AUTH_TOKEN_FILE_NAME, token));
    }
    slots.push(SlotFiles::new(hub_secrets_mount()?.slot, hub_files));

    crate::pii_key::ensure_project_key_in(data_dir, project)?;
    let policy_files = regular_files_in(
        &crate::pii_policy::policy_config_dir_in(data_dir, project),
        &[],
    )?;
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
        regular_files_in(&tokens_root.join(super::LLM_TOKEN_SERVICE), &[])?,
    ));
    for forge in &proxy_config.git_forges {
        slots.push(SlotFiles::new(
            proxy_git_mount(forge.kind)?.slot,
            regular_files_in(&tokens_root.join(forge.kind.config_key()), &[])?,
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

pub(crate) struct ServiceTokenSlots {
    pub(crate) worker: Option<Slot>,
    pub(crate) git: Vec<Slot>,
}

pub(crate) fn service_token_slots_in(
    data_dir: &Path,
    project: &str,
    service: &str,
) -> anyhow::Result<ServiceTokenSlots> {
    let settings = stage::load_project_settings(data_dir, project)?;
    let worker = worker_tokens_slot_of(&settings, service)?;
    let mut git = Vec::new();
    for forge in proxy::git_forges_in(
        data_dir,
        project,
        &settings.integrations,
        &settings.resolved_config.git_repositories,
        &settings.resolved_config.access,
    ) {
        if forge.kind.config_key() == service {
            git.push(proxy_git_mount(forge.kind)?.slot);
        }
    }
    Ok(ServiceTokenSlots { worker, git })
}

fn worker_tokens_slot_of(
    settings: &ProjectSettings,
    service: &str,
) -> anyhow::Result<Option<Slot>> {
    let builtin = enabled_builtin_workers(&settings.integrations)
        .find(|svc| svc.config_key == service && builtin_worker_has_tokens(svc))
        .map(|svc| svc.compose_name.to_string());
    let compose_name = builtin.or_else(|| {
        enabled_plugin_workers(&settings.integrations, &settings.plugin_manifests)
            .find(|worker| worker.service_id == service)
            .map(|worker| worker.compose_name)
    });
    compose_name
        .map(|name| worker_tokens_mount(&name).map(|mount| mount.slot))
        .transpose()
}

fn worker_tokens_slot(mount: SlotMount, host_dir: &Path) -> anyhow::Result<SlotFiles> {
    let mut slot = SlotFiles::new(
        mount.slot,
        regular_files_in(host_dir, &[consts::OAUTH_REFRESH_STATUS_FILE])?,
    );
    slot.keep
        .push(consts::OAUTH_REFRESH_STATUS_FILE.to_string());
    Ok(slot)
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
            proxy::ensure_caller_token_in(data_dir, project)?,
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
