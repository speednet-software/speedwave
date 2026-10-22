use super::dto::{
    CustomMcpApproveChoices, CustomMcpForcedDto, CustomMcpPreviewDetailsDto, CustomMcpPreviewDto,
    CustomMcpPreviewRequest, NpmPreviewDto,
};
use super::registry::RegistryFacts;
use speedwave_runtime::config::{self, SpeedwaveUserConfig};
use speedwave_runtime::custom_mcp::build::{image_tag_for_dir, SERVER_TEMPLATE_VERSION};
use speedwave_runtime::custom_mcp::detect::{self, ProposalSource};
use speedwave_runtime::custom_mcp::failure;
use speedwave_runtime::custom_mcp::model::{
    self, CustomMcpEntry, CustomMcpLock, CustomMcpSource, Ecosystem, ManagedCustomMcpConfig,
};
use speedwave_runtime::custom_mcp::npm_resolve::{self, NpmResolution, NpmResolveRequest};
use speedwave_runtime::custom_mcp::paths;
use speedwave_runtime::custom_mcp::policy::{self, EgressConfig, GuardMode, GuardPolicy};
use speedwave_runtime::runtime::LockedRuntime;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How long a review stays approvable.
pub(crate) const PREVIEW_TTL: Duration = Duration::from_secs(15 * 60);
const MAX_PENDING_PREVIEWS: usize = 16;
const MIN_HOST_PORT: u16 = 1024;

#[derive(Clone)]
pub(crate) enum StoredSource {
    Npm {
        resolution: Box<NpmResolution>,
        args: Vec<String>,
        env_keys: Vec<String>,
        published_at: String,
        image_tag: String,
        staging_id: String,
    },
    Host {
        port: u16,
        path: String,
    },
}

#[derive(Clone)]
pub(crate) struct StoredPreview {
    pub(crate) project: String,
    pub(crate) name: String,
    pub(crate) proposed_by_repo: bool,
    pub(crate) source: StoredSource,
    created: Instant,
}

/// Reviews waiting for approval, keyed by a random id; the approval recomputes everything from
/// here and never trusts what the UI sends back.
#[derive(Default)]
pub(crate) struct PendingPreviews {
    inner: Mutex<HashMap<String, StoredPreview>>,
}

impl PendingPreviews {
    fn locked(&self) -> std::sync::MutexGuard<'_, HashMap<String, StoredPreview>> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn purge(map: &mut HashMap<String, StoredPreview>, now: Instant) {
        map.retain(|_, p| now.saturating_duration_since(p.created) < PREVIEW_TTL);
    }

    pub(crate) fn insert(&self, preview: StoredPreview, now: Instant) -> String {
        let mut map = self.locked();
        Self::purge(&mut map, now);
        while map.len() >= MAX_PENDING_PREVIEWS {
            let oldest = map
                .iter()
                .min_by_key(|(_, p)| p.created)
                .map(|(id, _)| id.clone());
            match oldest {
                Some(id) => map.remove(&id),
                None => break,
            };
        }
        let id = uuid::Uuid::new_v4().to_string();
        map.insert(
            id.clone(),
            StoredPreview {
                created: now,
                ..preview
            },
        );
        id
    }

    pub(crate) fn get(&self, id: &str, now: Instant) -> Result<StoredPreview, String> {
        let mut map = self.locked();
        Self::purge(&mut map, now);
        map.get(id).cloned().ok_or_else(|| {
            "This review expired or is unknown; review the server again.".to_string()
        })
    }

    pub(crate) fn remove(&self, id: &str) {
        self.locked().remove(id);
    }
}

fn ensure_name_free(
    user_config: &SpeedwaveUserConfig,
    project: &str,
    name: &str,
) -> Result<(), String> {
    model::validate_server_name(name).map_err(|e| e.to_string())?;
    let project_entry = user_config
        .find_project(project)
        .ok_or_else(|| format!("project '{project}' not found"))?;
    if project_entry
        .custom_mcp
        .as_ref()
        .is_some_and(|m| m.contains_key(name))
    {
        return Err(format!(
            "a custom MCP server named '{name}' already exists; remove it or choose another name"
        ));
    }
    Ok(())
}

fn ensure_feature_allowed(managed: Option<&ManagedCustomMcpConfig>) -> Result<(), String> {
    if managed.and_then(|m| m.enabled) == Some(false) {
        return Err("your organization has disabled custom MCP servers".to_string());
    }
    Ok(())
}

fn ensure_host_allowed(managed: Option<&ManagedCustomMcpConfig>) -> Result<(), String> {
    if managed.and_then(|m| m.host_servers_enabled) == Some(false) {
        return Err(
            "your organization has disabled MCP servers running on this computer".to_string(),
        );
    }
    Ok(())
}

/// Validates a host server request: name, port 1024..=65535, path.
pub(crate) fn validate_host_request(name: &str, port: u16, path: &str) -> Result<(), String> {
    model::validate_server_name(name).map_err(|e| e.to_string())?;
    if port < MIN_HOST_PORT {
        return Err(format!(
            "host server port must be between {MIN_HOST_PORT} and 65535"
        ));
    }
    model::validate_host_endpoint(port, path).map_err(|e| e.to_string())
}

fn placeholder_lock(
    package: &str,
    version: &str,
    args: &[String],
    env_keys: &[String],
) -> CustomMcpLock {
    CustomMcpLock {
        ecosystem: Ecosystem::Npm,
        package: package.to_string(),
        version: version.to_string(),
        integrity: format!("sha512-{}==", "A".repeat(86)),
        lockfile_sha256: "0".repeat(64),
        template_version: SERVER_TEMPLATE_VERSION,
        image_tag: "pending".to_string(),
        args: args.to_vec(),
        env_keys: env_keys.to_vec(),
        published_at: "pending".to_string(),
        before_date: "pending".to_string(),
    }
}

fn entry_with(source: CustomMcpSource) -> CustomMcpEntry {
    CustomMcpEntry {
        enabled: true,
        source,
        tools: Default::default(),
        allowed_domains: Vec::new(),
        pii_mode: Default::default(),
        workspace_mode: Default::default(),
        proposed_by_repo: false,
        approved_at: None,
        consent_digest: None,
    }
}

/// Everything a request must pass before the resolver runs, checked with the same validator an
/// approved entry passes: name free, package, exact version, arguments, env names, MDM scope.
pub(crate) fn validate_npm_request(
    user_config: &SpeedwaveUserConfig,
    project: &str,
    request: &CustomMcpPreviewRequest,
    managed: Option<&ManagedCustomMcpConfig>,
) -> Result<(), String> {
    let CustomMcpPreviewRequest::Npm {
        name,
        package,
        version,
        args,
        env_keys,
    } = request
    else {
        return Err("not an npm request".to_string());
    };
    ensure_feature_allowed(managed)?;
    ensure_name_free(user_config, project, name)?;
    npm_resolve::validate_request(
        &NpmResolveRequest {
            project,
            name,
            package,
            version,
        },
        managed,
    )
    .map_err(|e| e.to_string())?;
    entry_with(CustomMcpSource::Npm {
        lock: placeholder_lock(package, version, args, env_keys),
    })
    .validate(name)
    .map_err(|e| e.to_string())
}

fn build_files_failed(cause: anyhow::Error) -> String {
    failure::failure(
        failure::BUILD,
        "The files for the server image could not be prepared",
        format!("{cause:#}"),
    )
}

/// What the resolver half of an npm review produced: the pinned package, the image tag and the
/// id of the review's own staging dir.
pub(crate) struct ResolvedNpm {
    pub(crate) resolution: NpmResolution,
    pub(crate) image_tag: String,
    pub(crate) staging_id: String,
}

/// The resolver half of an npm review: pins the package in a staging dir of its own and
/// computes the image tag from it; a failure removes that dir.
pub(crate) fn resolve_npm(
    rt: &LockedRuntime,
    data_dir: &Path,
    build_root: &Path,
    project: &str,
    request: &CustomMcpPreviewRequest,
    managed: Option<&ManagedCustomMcpConfig>,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<ResolvedNpm, String> {
    let CustomMcpPreviewRequest::Npm {
        name,
        package,
        version,
        args,
        env_keys,
    } = request
    else {
        return Err("not an npm request".to_string());
    };
    let staging_id = uuid::Uuid::new_v4().to_string();
    let resolution = npm_resolve::resolve_npm_lock(
        rt,
        data_dir,
        &NpmResolveRequest {
            project,
            name,
            package,
            version,
        },
        &staging_id,
        managed,
        now,
    )
    .map_err(|e| format!("{e:#}"))?;
    let mut lock = placeholder_lock(package, version, args, env_keys);
    lock.lockfile_sha256 = resolution.lockfile_sha256.clone();
    let image_tag = paths::preview_dir_in(data_dir, project, name, &staging_id)
        .and_then(|dir| image_tag_for_dir(&dir, build_root, name, &lock))
        .map_err(|e| {
            npm_resolve::discard_preview(data_dir, project, name, &staging_id);
            build_files_failed(e)
        })?;
    Ok(ResolvedNpm {
        resolution,
        image_tag,
        staging_id,
    })
}

/// The newest approved version of `package` in any project, for the publisher comparison.
pub(crate) fn previous_approved_version(
    user_config: &SpeedwaveUserConfig,
    package: &str,
) -> Option<String> {
    user_config
        .projects
        .iter()
        .flat_map(|p| p.custom_mcp.iter().flatten())
        .filter_map(|(_, e)| match &e.source {
            CustomMcpSource::Npm { lock }
                if lock.package == package && e.consent_digest.is_some() =>
            {
                Some((
                    e.approved_at.clone().unwrap_or_default(),
                    lock.version.clone(),
                ))
            }
            _ => None,
        })
        .max()
        .map(|(_, version)| version)
}

/// `true` when the project's `.mcp.json` proposes this npm package.
pub(crate) fn proposed_by_repo(project_dir: &Path, package: &str) -> bool {
    detect::scan_project_dir(project_dir)
        .unwrap_or_default()
        .iter()
        .any(|p| matches!(&p.source, ProposalSource::Npm { package: p, .. } if p == package))
}

fn expires_at(now: chrono::DateTime<chrono::Utc>) -> String {
    (now + chrono::Duration::from_std(PREVIEW_TTL).unwrap_or_default())
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

#[expect(
    clippy::too_many_arguments,
    reason = "assembles one review from its independent sources"
)]
/// Stores an npm review and returns what the review screen shows.
pub(crate) fn finish_npm_preview(
    previews: &PendingPreviews,
    project: &str,
    request: &CustomMcpPreviewRequest,
    resolved: ResolvedNpm,
    facts: RegistryFacts,
    previous_version: Option<String>,
    proposed_by_repo: bool,
    managed: Option<&ManagedCustomMcpConfig>,
    now: Instant,
    wall: chrono::DateTime<chrono::Utc>,
) -> Result<CustomMcpPreviewDto, String> {
    let CustomMcpPreviewRequest::Npm {
        name,
        args,
        env_keys,
        ..
    } = request
    else {
        return Err("not an npm request".to_string());
    };
    let ResolvedNpm {
        resolution,
        image_tag,
        staging_id,
    } = resolved;
    let publisher_changed = matches!(
        (&facts.previous_publisher, &facts.publisher),
        (Some(before), Some(now)) if before != now
    );
    let mut warnings = Vec::new();
    if publisher_changed {
        warnings.push(
            "This version was published by someone else than the version you approved before."
                .to_string(),
        );
    }
    if !facts.provenance {
        warnings.push("This version has no npm provenance attestation.".to_string());
    }
    let details = NpmPreviewDto {
        package: resolution.package.clone(),
        version: resolution.version.clone(),
        integrity: resolution.integrity.clone(),
        published_at: facts.published_at.clone(),
        license: facts.license.clone().or_else(|| resolution.license.clone()),
        dependency_count: resolution.dependency_count,
        publisher: facts.publisher.clone(),
        maintainers: facts.maintainers.clone(),
        provenance: facts.provenance,
        previous_version,
        previous_publisher: facts.previous_publisher.clone(),
        publisher_changed,
        has_install_script: !resolution.has_install_script_packages.is_empty(),
        args: args.clone(),
        env_keys: env_keys.clone(),
        image_tag: image_tag.clone(),
        before_date: resolution.before_date.clone(),
        lockfile_sha256: resolution.lockfile_sha256.clone(),
    };
    let id = previews.insert(
        StoredPreview {
            project: project.to_string(),
            name: name.clone(),
            proposed_by_repo,
            source: StoredSource::Npm {
                resolution: Box::new(resolution),
                args: args.clone(),
                env_keys: env_keys.clone(),
                published_at: facts.published_at,
                image_tag,
                staging_id,
            },
            created: now,
        },
        now,
    );
    Ok(CustomMcpPreviewDto {
        preview_id: id,
        expires_at: expires_at(wall),
        project: project.to_string(),
        name: name.clone(),
        details: CustomMcpPreviewDetailsDto::Npm(Box::new(details)),
        host_warning: false,
        proposed_by_repo,
        forced: CustomMcpForcedDto::from_managed(managed),
        warnings,
    })
}

#[expect(
    clippy::too_many_arguments,
    reason = "the review of a host server needs its two probes injected"
)]
/// Reviews a host server: validated, MDM-checked, probed; nothing is written.
pub(crate) fn preview_host(
    previews: &PendingPreviews,
    user_config: &SpeedwaveUserConfig,
    project: &str,
    request: &CustomMcpPreviewRequest,
    managed: Option<&ManagedCustomMcpConfig>,
    probe_upstream: &dyn Fn(u16) -> bool,
    host_warning: &dyn Fn(u16) -> bool,
    now: Instant,
    wall: chrono::DateTime<chrono::Utc>,
) -> Result<CustomMcpPreviewDto, String> {
    let CustomMcpPreviewRequest::Host { name, port, path } = request else {
        return Err("not a host request".to_string());
    };
    ensure_feature_allowed(managed)?;
    ensure_host_allowed(managed)?;
    validate_host_request(name, *port, path)?;
    ensure_name_free(user_config, project, name)?;
    let upstream_reachable = probe_upstream(*port);
    let mut warnings = Vec::new();
    if !upstream_reachable {
        warnings.push(format!(
            "Nothing answers on port {port} on this computer; start the app and its MCP server."
        ));
    }
    let id = previews.insert(
        StoredPreview {
            project: project.to_string(),
            name: name.clone(),
            proposed_by_repo: false,
            source: StoredSource::Host {
                port: *port,
                path: path.clone(),
            },
            created: now,
        },
        now,
    );
    Ok(CustomMcpPreviewDto {
        preview_id: id,
        expires_at: expires_at(wall),
        project: project.to_string(),
        name: name.clone(),
        details: CustomMcpPreviewDetailsDto::Host {
            port: *port,
            path: path.clone(),
            upstream_reachable,
        },
        host_warning: host_warning(*port),
        proposed_by_repo: false,
        forced: CustomMcpForcedDto::from_managed(managed),
        warnings,
    })
}

fn validate_env_values(
    env_keys: &[String],
    values: &std::collections::BTreeMap<String, String>,
) -> Result<(), String> {
    for (key, value) in values {
        if !env_keys.iter().any(|k| k == key) {
            return Err(format!(
                "'{key}' is not a credential this server was reviewed with"
            ));
        }
        crate::integrations_cmd::validate_credential_field(key, value)?;
        if value.chars().any(char::is_control) {
            return Err(format!("the value for '{key}' contains control characters"));
        }
    }
    Ok(())
}

fn write_credentials(
    data_dir: &Path,
    project: &str,
    name: &str,
    values: &std::collections::BTreeMap<String, String>,
) -> anyhow::Result<()> {
    let dir = speedwave_runtime::plugin::token_dir_in(data_dir, project, &model::service_id(name));
    if std::fs::symlink_metadata(&dir).is_ok() {
        std::fs::remove_dir_all(&dir)?;
    }
    speedwave_runtime::fs_perms::ensure_owner_only_dir(&dir)?;
    for (key, value) in values {
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        speedwave_runtime::fs_perms::write_restricted_file_atomic(&dir.join(key), value)?;
    }
    Ok(())
}

fn check_choices_against_policy(
    stored: &StoredPreview,
    choices: &CustomMcpApproveChoices,
    managed: Option<&ManagedCustomMcpConfig>,
) -> Result<(), String> {
    ensure_feature_allowed(managed)?;
    if let Some(limit) = managed.and_then(|m| m.max_workspace_mode) {
        if choices.workspace_mode.exceeds(limit) {
            return Err("your organization limits project file access below this choice".into());
        }
    }
    if let Some(forced) = managed.and_then(|m| m.force_pii_mode) {
        if forced != choices.pii_mode {
            return Err("your organization sets the personal data mode of every server".into());
        }
    }
    match &stored.source {
        StoredSource::Host { .. } => ensure_host_allowed(managed),
        StoredSource::Npm { resolution, .. } => npm_resolve::validate_request(
            &NpmResolveRequest {
                project: &stored.project,
                name: &stored.name,
                package: &resolution.package,
                version: &resolution.version,
            },
            managed,
        )
        .map_err(|e| e.to_string()),
    }
}

/// What approving a stored review writes, rebuilt from the stored review only.
fn approved_entry(
    data_dir: &Path,
    build_root: &dyn Fn() -> Result<std::path::PathBuf, String>,
    stored: &StoredPreview,
    choices: &CustomMcpApproveChoices,
    wall: chrono::DateTime<chrono::Utc>,
) -> Result<CustomMcpEntry, String> {
    let source = match &stored.source {
        StoredSource::Host { port, path } => {
            validate_host_request(&stored.name, *port, path)?;
            CustomMcpSource::Host {
                port: *port,
                path: path.clone(),
            }
        }
        StoredSource::Npm {
            resolution,
            args,
            env_keys,
            published_at,
            image_tag,
            staging_id,
        } => {
            validate_env_values(env_keys, &choices.env_values)?;
            let mut lock = CustomMcpLock {
                ecosystem: Ecosystem::Npm,
                package: resolution.package.clone(),
                version: resolution.version.clone(),
                integrity: resolution.integrity.clone(),
                lockfile_sha256: resolution.lockfile_sha256.clone(),
                template_version: SERVER_TEMPLATE_VERSION,
                image_tag: String::new(),
                args: args.clone(),
                env_keys: env_keys.clone(),
                published_at: published_at.clone(),
                before_date: resolution.before_date.clone(),
            };
            let root = build_root()?;
            let current =
                paths::preview_dir_in(data_dir, &stored.project, &stored.name, staging_id)
                    .and_then(|dir| image_tag_for_dir(&dir, &root, &stored.name, &lock))
                    .map_err(build_files_failed)?;
            if current != *image_tag {
                return Err(
                    "the server's build files changed since the review; review it again".into(),
                );
            }
            lock.image_tag = current;
            CustomMcpSource::Npm { lock }
        }
    };
    let mut entry = entry_with(source);
    entry.pii_mode = choices.pii_mode;
    entry.workspace_mode = choices.workspace_mode;
    entry.proposed_by_repo = stored.proposed_by_repo;
    entry.approved_at = Some(wall.to_rfc3339_opts(chrono::SecondsFormat::Secs, true));
    entry.validate(&stored.name).map_err(|e| e.to_string())?;
    entry.consent_digest = Some(policy::consent_digest(&entry).map_err(|e| e.to_string())?);
    Ok(entry)
}

#[expect(
    clippy::too_many_arguments,
    reason = "every input is explicit so the approval is testable without globals"
)]
/// Approves a stored review: all recomputed and validated first, then credentials, guard and
/// egress policies, and last the config entry.
pub(crate) fn approve_in(
    data_dir: &Path,
    build_root: &dyn Fn() -> Result<std::path::PathBuf, String>,
    previews: &PendingPreviews,
    preview_id: &str,
    project: &str,
    choices: &CustomMcpApproveChoices,
    managed: Option<&ManagedCustomMcpConfig>,
    now: Instant,
    wall: chrono::DateTime<chrono::Utc>,
) -> Result<(), String> {
    let stored = previews.get(preview_id, now)?;
    if stored.project != project {
        return Err("this review belongs to another project".to_string());
    }
    if stored.name != choices.name {
        return Err(format!(
            "the review was made for the name '{}'; review the server again to rename it",
            stored.name
        ));
    }
    check_choices_against_policy(&stored, choices, managed)?;
    let entry = approved_entry(data_dir, build_root, &stored, choices, wall)?;
    let name = stored.name.as_str();
    let config_path = data_dir.join("config.json");
    config::with_config_lock_in(data_dir, || {
        let mut user_config = config::load_user_config_from(&config_path)?;
        let active = user_config
            .active_project
            .clone()
            .ok_or_else(|| anyhow::anyhow!("No active project"))?;
        crate::containers_cmd::ensure_saving_for_active_project(&active, Some(project))?;
        ensure_name_free(&user_config, project, name).map_err(anyhow::Error::msg)?;
        if let StoredSource::Npm { staging_id, .. } = &stored.source {
            npm_resolve::promote_preview(data_dir, project, name, staging_id)?;
        }
        let mode = GuardMode::of(&entry.source);
        if let CustomMcpSource::Npm { .. } = &entry.source {
            write_credentials(data_dir, project, name, &choices.env_values)?;
            policy::write_egress_config(data_dir, project, name, &EgressConfig::new(&[]))?;
        }
        policy::write_guard_policy(
            data_dir,
            project,
            name,
            &GuardPolicy::empty(name, mode, entry.consent_digest.clone()),
        )?;
        user_config
            .find_project_mut(project)
            .ok_or_else(|| anyhow::anyhow!("project '{project}' not found"))?
            .custom_mcp
            .get_or_insert_with(Default::default)
            .insert(name.to_string(), entry.clone());
        config::save_user_config_to(&user_config, &config_path)
    })
    .map_err(|e| e.to_string())?;
    previews.remove(preview_id);
    log::info!("custom MCP server '{name}' approved for project '{project}'");
    Ok(())
}

#[cfg(test)]
#[expect(clippy::unwrap_used, reason = "test assertions use unwrap/expect")]
mod tests {
    use super::*;
    use crate::custom_mcp_cmd::tests_support::{
        fixture_config, load, lockfile, save, stage_npm_preview, stage_npm_preview_with, PROJECT,
    };
    use speedwave_runtime::custom_mcp::model::{CustomPiiMode, WorkspaceMode};
    use speedwave_runtime::custom_mcp::paths::{self, ServerSubdir};

    fn wall() -> chrono::DateTime<chrono::Utc> {
        chrono::DateTime::parse_from_rfc3339("2026-10-08T10:00:00Z")
            .unwrap()
            .with_timezone(&chrono::Utc)
    }

    fn choices(name: &str) -> CustomMcpApproveChoices {
        CustomMcpApproveChoices {
            name: name.into(),
            pii_mode: CustomPiiMode::Tokens,
            workspace_mode: WorkspaceMode::None,
            env_values: [("FIGMA_API_KEY".to_string(), "secret-123".to_string())]
                .into_iter()
                .collect(),
        }
    }

    fn host_request(name: &str, port: u16) -> CustomMcpPreviewRequest {
        CustomMcpPreviewRequest::Host {
            name: name.into(),
            port,
            path: "/mcp".into(),
        }
    }

    fn preview_host_ok(
        previews: &PendingPreviews,
        cfg: &SpeedwaveUserConfig,
        request: &CustomMcpPreviewRequest,
        managed: Option<&ManagedCustomMcpConfig>,
    ) -> Result<CustomMcpPreviewDto, String> {
        preview_host(
            previews,
            cfg,
            PROJECT,
            request,
            managed,
            &|_| true,
            &|_| true,
            Instant::now(),
            wall(),
        )
    }

    #[test]
    fn npm_approval_writes_credentials_policies_and_a_consented_entry() {
        let data = tempfile::tempdir().unwrap();
        save(data.path(), &fixture_config(data.path()));
        let previews = PendingPreviews::default();
        let (id, root) = stage_npm_preview(data.path(), &previews, "figma");
        approve_in(
            data.path(),
            &|| Ok(root.clone()),
            &previews,
            &id,
            PROJECT,
            &choices("figma"),
            None,
            Instant::now(),
            wall(),
        )
        .unwrap();

        let cfg = load(data.path());
        let entry = &cfg.projects[0].custom_mcp.as_ref().unwrap()["figma"];
        assert!(policy::is_approved(entry));
        assert_eq!(entry.approved_at.as_deref(), Some("2026-10-08T10:00:00Z"));
        let CustomMcpSource::Npm { lock } = &entry.source else {
            panic!("npm source expected")
        };
        assert_eq!(lock.published_at, "2026-09-01T00:00:00.000Z");
        assert!(lock.image_tag.starts_with("speedwave-mcp-custom-figma:"));
        let tokens = speedwave_runtime::plugin::token_dir_in(data.path(), PROJECT, "custom-figma");
        assert_eq!(
            std::fs::read_to_string(tokens.join("FIGMA_API_KEY")).unwrap(),
            "secret-123"
        );
        let guard = policy::read_guard_policy(data.path(), PROJECT, "figma")
            .unwrap()
            .unwrap();
        assert!(guard.tools.is_empty());
        assert_eq!(guard.consent_digest, entry.consent_digest);
        let egress = paths::subdir_in(data.path(), PROJECT, "figma", ServerSubdir::Egress)
            .unwrap()
            .join(speedwave_runtime::consts::CUSTOM_MCP_EGRESS_CONFIG_FILE);
        let egress: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(egress).unwrap()).unwrap();
        assert_eq!(egress["allow"], serde_json::json!([]));
        assert!(
            previews.get(&id, Instant::now()).is_err(),
            "a preview is used once"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(tokens.join("FIGMA_API_KEY"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[test]
    fn host_approval_records_the_endpoint_without_credentials() {
        let data = tempfile::tempdir().unwrap();
        save(data.path(), &fixture_config(data.path()));
        let cfg = load(data.path());
        let previews = PendingPreviews::default();
        let dto = preview_host_ok(&previews, &cfg, &host_request("desk", 3845), None).unwrap();
        assert!(dto.host_warning);
        assert!(matches!(
            dto.details,
            CustomMcpPreviewDetailsDto::Host {
                upstream_reachable: true,
                ..
            }
        ));
        let mut c = choices("desk");
        c.env_values.clear();
        approve_in(
            data.path(),
            &|| Err("a host approval never needs the build root".into()),
            &previews,
            &dto.preview_id,
            PROJECT,
            &c,
            None,
            Instant::now(),
            wall(),
        )
        .unwrap();
        let cfg = load(data.path());
        let entry = &cfg.projects[0].custom_mcp.as_ref().unwrap()["desk"];
        assert_eq!(
            entry.source,
            CustomMcpSource::Host {
                port: 3845,
                path: "/mcp".into()
            }
        );
        assert!(policy::is_approved(entry));
        assert!(
            !speedwave_runtime::plugin::token_dir_in(data.path(), PROJECT, "custom-desk").exists()
        );
        assert_eq!(
            policy::read_guard_policy(data.path(), PROJECT, "desk")
                .unwrap()
                .unwrap()
                .mode,
            GuardMode::Host
        );
    }

    #[test]
    fn host_requests_are_validated() {
        let data = tempfile::tempdir().unwrap();
        let mut cfg = fixture_config(data.path());
        cfg.projects[0]
            .custom_mcp
            .get_or_insert_with(Default::default)
            .insert(
                "taken".into(),
                crate::custom_mcp_cmd::tests_support::host_entry(true),
            );
        let previews = PendingPreviews::default();
        for (request, needle) in [
            (host_request("desk", 80), "between 1024"),
            (host_request("desk", 1023), "between 1024"),
            (host_request("Desk", 3845), "lowercase"),
            (host_request("guard", 3845), "reserved"),
            (host_request("relay-x", 3845), "reserved"),
            (host_request("x-up", 3845), "-up"),
            (host_request("taken", 3845), "already exists"),
            (
                CustomMcpPreviewRequest::Host {
                    name: "desk".into(),
                    port: 3845,
                    path: "/mcp?x=1".into(),
                },
                "path",
            ),
        ] {
            let err = preview_host_ok(&previews, &cfg, &request, None).unwrap_err();
            assert!(err.contains(needle), "{needle}: {err}");
        }
        let managed = ManagedCustomMcpConfig {
            host_servers_enabled: Some(false),
            ..Default::default()
        };
        let err = preview_host_ok(&previews, &cfg, &host_request("desk", 3845), Some(&managed))
            .unwrap_err();
        assert!(err.contains("organization"), "{err}");
    }

    #[test]
    fn npm_requests_are_validated_before_anything_runs() {
        let data = tempfile::tempdir().unwrap();
        let cfg = fixture_config(data.path());
        let request =
            |name: &str, package: &str, version: &str, env: &[&str]| CustomMcpPreviewRequest::Npm {
                name: name.into(),
                package: package.into(),
                version: version.into(),
                args: vec!["--stdio".into()],
                env_keys: env.iter().map(|s| s.to_string()).collect(),
            };
        validate_npm_request(
            &cfg,
            PROJECT,
            &request("figma", "figma-developer-mcp", "0.6.1", &["FIGMA_API_KEY"]),
            None,
        )
        .unwrap();
        for (req, needle) in [
            (request("Figma", "p", "1.0.0", &[]), "lowercase"),
            (request("figma", "Bad Pkg", "1.0.0", &[]), "npm package"),
            (request("figma", "p", "latest", &[]), "semver"),
            (request("figma", "p", "^1.0.0", &[]), "semver"),
            (
                request("figma", "p", "1.0.0", &["HTTPS_PROXY"]),
                "set by Speedwave",
            ),
            (
                request("figma", "p", "1.0.0", &["NODE_OPTIONS"]),
                "set by Speedwave",
            ),
            (request("figma", "p", "1.0.0", &["K", "k"]), "twice"),
        ] {
            let err = validate_npm_request(&cfg, PROJECT, &req, None).unwrap_err();
            assert!(err.contains(needle), "{needle}: {err}");
        }
        let scoped = ManagedCustomMcpConfig {
            allowed_scopes: Some(vec!["@acme".into()]),
            ..Default::default()
        };
        assert!(validate_npm_request(
            &cfg,
            PROJECT,
            &request("figma", "p", "1.0.0", &[]),
            Some(&scoped)
        )
        .is_err());
        let off = ManagedCustomMcpConfig {
            enabled: Some(false),
            ..Default::default()
        };
        assert!(validate_npm_request(
            &cfg,
            PROJECT,
            &request("figma", "p", "1.0.0", &[]),
            Some(&off)
        )
        .is_err());
    }

    #[test]
    fn approval_refuses_unknown_expired_foreign_and_renamed_reviews() {
        let data = tempfile::tempdir().unwrap();
        save(data.path(), &fixture_config(data.path()));
        let previews = PendingPreviews::default();
        let (id, root) = stage_npm_preview(data.path(), &previews, "figma");
        let approve = |id: &str, project: &str, c: &CustomMcpApproveChoices, now: Instant| {
            approve_in(
                data.path(),
                &|| Ok(root.clone()),
                &previews,
                id,
                project,
                c,
                None,
                now,
                wall(),
            )
        };
        assert!(approve("nope", PROJECT, &choices("figma"), Instant::now())
            .unwrap_err()
            .contains("expired or is unknown"));
        assert!(approve(&id, "other", &choices("figma"), Instant::now())
            .unwrap_err()
            .contains("another project"));
        assert!(approve(&id, PROJECT, &choices("linear"), Instant::now())
            .unwrap_err()
            .contains("review the server again"));
        let mut bad = choices("figma");
        bad.env_values.insert("OTHER".into(), "x".into());
        assert!(approve(&id, PROJECT, &bad, Instant::now())
            .unwrap_err()
            .contains("not a credential"));
        let mut crlf = choices("figma");
        crlf.env_values
            .insert("FIGMA_API_KEY".into(), "a\r\nb".into());
        assert!(approve(&id, PROJECT, &crlf, Instant::now())
            .unwrap_err()
            .contains("control characters"));
        let later = Instant::now() + PREVIEW_TTL + Duration::from_secs(1);
        assert!(approve(&id, PROJECT, &choices("figma"), later)
            .unwrap_err()
            .contains("expired"));
        assert!(load(data.path()).projects[0].custom_mcp.is_none());
    }

    #[test]
    fn approval_refuses_changed_build_files_and_managed_policy() {
        let data = tempfile::tempdir().unwrap();
        save(data.path(), &fixture_config(data.path()));
        let previews = PendingPreviews::default();
        let (id, root) = stage_npm_preview(data.path(), &previews, "figma");
        let approve = |c: &CustomMcpApproveChoices, managed: Option<&ManagedCustomMcpConfig>| {
            approve_in(
                data.path(),
                &|| Ok(root.clone()),
                &previews,
                &id,
                PROJECT,
                c,
                managed,
                Instant::now(),
                wall(),
            )
        };
        let max = ManagedCustomMcpConfig {
            max_workspace_mode: Some(WorkspaceMode::ReadOnly),
            ..Default::default()
        };
        let mut rw = choices("figma");
        rw.workspace_mode = WorkspaceMode::ReadWrite;
        assert!(approve(&rw, Some(&max))
            .unwrap_err()
            .contains("organization"));
        let forced = ManagedCustomMcpConfig {
            force_pii_mode: Some(CustomPiiMode::Plaintext),
            ..Default::default()
        };
        assert!(approve(&choices("figma"), Some(&forced))
            .unwrap_err()
            .contains("organization"));
        let off = ManagedCustomMcpConfig {
            enabled: Some(false),
            ..Default::default()
        };
        assert!(approve(&choices("figma"), Some(&off)).is_err());

        let staged = staging_dir(data.path(), &previews, &id);
        std::fs::write(staged.join("package.json"), "{\"tampered\":true}").unwrap();
        let err = approve(&choices("figma"), None).unwrap_err();
        assert!(err.contains("changed since the review"), "{err}");
        assert!(load(data.path()).projects[0].custom_mcp.is_none());
        assert!(
            !paths::subdir_in(data.path(), PROJECT, "figma", ServerSubdir::Build)
                .unwrap()
                .exists()
        );
    }

    fn staging_dir(data: &Path, previews: &PendingPreviews, id: &str) -> std::path::PathBuf {
        let stored = previews.get(id, Instant::now()).unwrap();
        let StoredSource::Npm { staging_id, .. } = &stored.source else {
            panic!("npm review expected")
        };
        paths::preview_dir_in(data, &stored.project, &stored.name, staging_id).unwrap()
    }

    #[test]
    fn concurrent_reviews_of_one_name_stage_apart_and_only_the_approved_one_is_built() {
        let data = tempfile::tempdir().unwrap();
        save(data.path(), &fixture_config(data.path()));
        let previews = PendingPreviews::default();
        let (first, root) = stage_npm_preview(data.path(), &previews, "figma");
        let mut other: serde_json::Value = serde_json::from_str(&lockfile()).unwrap();
        other["packages"]["node_modules/zod"] = serde_json::json!({"version": "3.23.8", "integrity": crate::custom_mcp_cmd::tests_support::integrity()});
        let other = other.to_string();
        let (second, _) = stage_npm_preview_with(data.path(), &previews, "figma", other.clone());
        let first_dir = staging_dir(data.path(), &previews, &first);
        let second_dir = staging_dir(data.path(), &previews, &second);
        assert_ne!(first_dir, second_dir);
        assert_eq!(
            std::fs::read_to_string(first_dir.join("package-lock.json")).unwrap(),
            lockfile()
        );
        assert_eq!(
            std::fs::read_to_string(second_dir.join("package-lock.json")).unwrap(),
            other
        );
        let build = paths::subdir_in(data.path(), PROJECT, "figma", ServerSubdir::Build).unwrap();
        assert!(
            !build.exists(),
            "a review never writes the approved build dir"
        );

        approve_in(
            data.path(),
            &|| Ok(root.clone()),
            &previews,
            &first,
            PROJECT,
            &choices("figma"),
            None,
            Instant::now(),
            wall(),
        )
        .unwrap();

        assert_eq!(
            std::fs::read_to_string(build.join("package-lock.json")).unwrap(),
            lockfile()
        );
        assert!(
            !paths::subdir_in(data.path(), PROJECT, "figma", ServerSubdir::Previews)
                .unwrap()
                .exists()
        );
        let cfg = load(data.path());
        let CustomMcpSource::Npm { lock } =
            &cfg.projects[0].custom_mcp.as_ref().unwrap()["figma"].source
        else {
            panic!("npm source expected")
        };
        assert_eq!(
            image_tag_for_dir(&build, &root, "figma", lock).unwrap(),
            lock.image_tag,
            "the approved build dir gives the tag recorded from the staging dir"
        );
        let err = approve_in(
            data.path(),
            &|| Ok(root.clone()),
            &previews,
            &second,
            PROJECT,
            &choices("figma"),
            None,
            Instant::now(),
            wall(),
        )
        .unwrap_err();
        assert!(err.contains("CMCP-BUILD"), "{err}");
        assert!(!err.contains("is missing"), "{err}");
        assert_eq!(
            std::fs::read_to_string(build.join("package-lock.json")).unwrap(),
            lockfile(),
            "a later review of a taken name never replaces the approved files"
        );
    }

    #[test]
    fn approval_only_saves_into_the_active_project() {
        let data = tempfile::tempdir().unwrap();
        let mut cfg = fixture_config(data.path());
        cfg.active_project = Some("other".into());
        save(data.path(), &cfg);
        let previews = PendingPreviews::default();
        let (id, root) = stage_npm_preview(data.path(), &previews, "figma");
        let err = approve_in(
            data.path(),
            &|| Ok(root.clone()),
            &previews,
            &id,
            PROJECT,
            &choices("figma"),
            None,
            Instant::now(),
            wall(),
        )
        .unwrap_err();
        assert!(err.contains("active project"), "{err}");
        assert!(
            previews.get(&id, Instant::now()).is_ok(),
            "a refused approval keeps the review"
        );
    }

    #[test]
    fn pending_previews_expire_and_stay_bounded() {
        let previews = PendingPreviews::default();
        let now = Instant::now();
        let stored = StoredPreview {
            project: PROJECT.into(),
            name: "desk".into(),
            proposed_by_repo: false,
            source: StoredSource::Host {
                port: 3845,
                path: "/mcp".into(),
            },
            created: now,
        };
        let first = previews.insert(stored.clone(), now);
        for _ in 0..MAX_PENDING_PREVIEWS {
            previews.insert(stored.clone(), now + Duration::from_secs(1));
        }
        assert!(previews.get(&first, now + Duration::from_secs(2)).is_err());
        assert_eq!(previews.locked().len(), MAX_PENDING_PREVIEWS);
        let fresh = previews.insert(stored, now + Duration::from_secs(3));
        assert!(previews
            .get(&fresh, now + Duration::from_secs(3) + PREVIEW_TTL)
            .is_err());
        assert!(previews.locked().is_empty());
    }

    #[test]
    fn previous_approvals_and_repository_proposals_are_found() {
        let data = tempfile::tempdir().unwrap();
        let mut cfg = fixture_config(data.path());
        let mut old = crate::custom_mcp_cmd::tests_support::npm_entry(true);
        old.approved_at = Some("2026-01-01T00:00:00Z".into());
        cfg.projects[0]
            .custom_mcp
            .get_or_insert_with(Default::default)
            .insert("figma".into(), old);
        assert_eq!(
            previous_approved_version(&cfg, "figma-developer-mcp").as_deref(),
            Some("0.6.1")
        );
        assert!(previous_approved_version(&cfg, "other").is_none());
        let project_dir = tempfile::tempdir().unwrap();
        assert!(!proposed_by_repo(project_dir.path(), "figma-developer-mcp"));
        std::fs::write(
            project_dir.path().join(".mcp.json"),
            r#"{"mcpServers":{"figma":{"command":"npx","args":["-y","figma-developer-mcp@0.6.1"]}}}"#,
        )
        .unwrap();
        assert!(proposed_by_repo(project_dir.path(), "figma-developer-mcp"));
        assert!(!proposed_by_repo(project_dir.path(), "other"));
    }
}
