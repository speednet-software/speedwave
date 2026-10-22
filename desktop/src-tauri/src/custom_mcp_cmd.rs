//! Tauri commands of Custom MCP servers: list, repository scan, review, approval, tool and
//! egress decisions, consented settings, removal; plus the host relay wiring. ADR-100..103.

pub(crate) mod dto;
mod edit;
mod egress;
mod list;
mod preview;
mod registry;
pub(crate) mod relays;

use crate::bridges::custom_host_relay::CustomHostRelay;
use crate::types::check_project;
use dto::{
    CustomMcpApproveChoices, CustomMcpEgressDenialsDto, CustomMcpEntryDto, CustomMcpListDto,
    CustomMcpPreviewDto, CustomMcpPreviewRequest, CustomMcpProposalDto, CustomMcpToolDecisionArg,
};
use speedwave_runtime::config;
use speedwave_runtime::custom_mcp::detect::{self, ProposalSource};
use speedwave_runtime::custom_mcp::effective::current_managed_policy;
use speedwave_runtime::custom_mcp::failure;
use speedwave_runtime::custom_mcp::model::{CustomMcpSource, CustomPiiMode, WorkspaceMode};
use std::sync::Arc;

pub(crate) use preview::PendingPreviews;

/// Reviews waiting for approval, shared by the preview and approve commands.
pub(crate) type SharedPendingPreviews = Arc<PendingPreviews>;

fn data_dir() -> &'static std::path::Path {
    speedwave_runtime::consts::data_dir()
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(f).await.map_err(|e| {
        failure::failure(
            failure::INTERNAL,
            "The action was interrupted unexpectedly",
            e,
        )
    })?
}

fn build_files_missing(cause: anyhow::Error) -> String {
    failure::failure(
        failure::BUILD,
        "The Speedwave files needed to build the server image were not found",
        cause,
    )
}

fn host_probes() -> list::HostProbes<'static> {
    list::HostProbes {
        app_available: &CustomHostRelay::probe_upstream,
        warning: &list::host_warning,
    }
}

fn list_now(project: &str) -> Result<CustomMcpListDto, String> {
    let user_config = config::load_user_config().map_err(failure::settings_failed)?;
    let managed = current_managed_policy();
    list::list_for(
        data_dir(),
        &user_config,
        project,
        managed.as_ref(),
        &host_probes(),
    )
}

/// Every Custom MCP server of `project` with its state, tools, domains and policy limits.
#[tauri::command]
pub async fn custom_mcp_get(project: String) -> Result<CustomMcpListDto, String> {
    check_project(&project)?;
    blocking(move || list_now(&project)).await
}

/// Servers the project's `.mcp.json` proposes; nothing is enabled by a proposal.
#[tauri::command]
pub async fn custom_mcp_scan_repo(project: String) -> Result<Vec<CustomMcpProposalDto>, String> {
    check_project(&project)?;
    blocking(move || {
        let user_config = config::load_user_config().map_err(failure::settings_failed)?;
        let entry = user_config
            .find_project(&project)
            .ok_or_else(|| format!("project '{project}' not found"))?;
        let proposals = detect::scan_project_dir(std::path::Path::new(&entry.dir))
            .map_err(|e| format!("{e:#}"))?;
        let configured: Vec<(String, String)> = entry
            .custom_mcp
            .iter()
            .flatten()
            .filter_map(|(name, e)| match &e.source {
                CustomMcpSource::Npm { lock } => Some((name.clone(), lock.package.clone())),
                CustomMcpSource::Host { .. } => None,
            })
            .collect();
        Ok(proposals
            .into_iter()
            .map(|proposal| {
                let configured_as = match &proposal.source {
                    ProposalSource::Npm { package, .. } => configured
                        .iter()
                        .find(|(_, p)| p == package)
                        .map(|(name, _)| name.clone()),
                    ProposalSource::Remote { .. } | ProposalSource::Unsupported { .. } => None,
                };
                CustomMcpProposalDto {
                    proposal,
                    configured_as,
                }
            })
            .collect())
    })
    .await
}

/// Reviews a server before approval: an npm package is pinned by the resolver and checked
/// against the registry; a host server is validated and probed. Nothing is enabled.
#[tauri::command]
pub async fn custom_mcp_preview(
    project: String,
    source: CustomMcpPreviewRequest,
    previews: tauri::State<'_, SharedPendingPreviews>,
) -> Result<CustomMcpPreviewDto, String> {
    check_project(&project)?;
    let previews = previews.inner().clone();
    match &source {
        CustomMcpPreviewRequest::Host { .. } => {
            blocking(move || {
                let user_config = config::load_user_config().map_err(failure::settings_failed)?;
                let managed = current_managed_policy();
                preview::preview_host(
                    &previews,
                    &user_config,
                    &project,
                    &source,
                    managed.as_ref(),
                    &CustomHostRelay::probe_upstream,
                    &list::host_warning,
                    std::time::Instant::now(),
                    chrono::Utc::now(),
                )
            })
            .await
        }
        CustomMcpPreviewRequest::Npm {
            package, version, ..
        } => {
            let (package, version) = (package.clone(), version.clone());
            let resolve_project = project.clone();
            let resolve_source = source.clone();
            let (resolved, previous, project_dir) = blocking(move || {
                let user_config = config::load_user_config().map_err(failure::settings_failed)?;
                let managed = current_managed_policy();
                preview::validate_npm_request(
                    &user_config,
                    &resolve_project,
                    &resolve_source,
                    managed.as_ref(),
                )?;
                let project_dir = user_config
                    .find_project(&resolve_project)
                    .map(|p| p.dir.clone())
                    .ok_or_else(|| format!("project '{resolve_project}' not found"))?;
                let rt = speedwave_runtime::runtime::detect_runtime();
                rt.ensure_ready()
                    .map_err(|e| speedwave_runtime::build::user_facing_engine_error(&e))?;
                let build_root =
                    speedwave_runtime::build::resolve_build_root().map_err(build_files_missing)?;
                let resolved = preview::resolve_npm(
                    &rt,
                    data_dir(),
                    &build_root,
                    &resolve_project,
                    &resolve_source,
                    managed.as_ref(),
                    chrono::Utc::now(),
                )?;
                let previous = preview::previous_approved_version(&user_config, &package);
                Ok((resolved, previous, project_dir))
            })
            .await?;
            let staging_id = resolved.staging_id.clone();
            let facts = match registry::fetch_packument(&resolved.resolution.package).await {
                Ok(doc) => registry::parse_packument(
                    &doc,
                    &version,
                    &resolved.resolution.integrity,
                    previous.as_deref(),
                ),
                Err(e) => Err(e),
            };
            let proposed = preview::proposed_by_repo(
                std::path::Path::new(&project_dir),
                &resolved.resolution.package,
            );
            let reviewed = facts.and_then(|facts| {
                preview::finish_npm_preview(
                    &previews,
                    &project,
                    &source,
                    resolved,
                    facts,
                    previous,
                    proposed,
                    current_managed_policy().as_ref(),
                    std::time::Instant::now(),
                    chrono::Utc::now(),
                )
            });
            if reviewed.is_err() {
                discard_npm_staging(&project, &source, &staging_id);
            }
            reviewed
        }
    }
}

fn discard_npm_staging(project: &str, source: &CustomMcpPreviewRequest, staging_id: &str) {
    if let CustomMcpPreviewRequest::Npm { name, .. } = source {
        speedwave_runtime::custom_mcp::npm_resolve::discard_preview(
            data_dir(),
            project,
            name,
            staging_id,
        );
    }
}

/// Approves a review: re-derived from the stored review, validated, then credentials, policies
/// and the consented entry are written. The UI restarts the containers afterwards.
#[tauri::command]
pub async fn custom_mcp_approve(
    project: String,
    preview_id: String,
    choices: CustomMcpApproveChoices,
    previews: tauri::State<'_, SharedPendingPreviews>,
) -> Result<(), String> {
    check_project(&project)?;
    let previews = previews.inner().clone();
    blocking(move || {
        preview::approve_in(
            data_dir(),
            &|| speedwave_runtime::build::resolve_build_root().map_err(build_files_missing),
            &previews,
            &preview_id,
            &project,
            &choices,
            current_managed_policy().as_ref(),
            std::time::Instant::now(),
            chrono::Utc::now(),
        )
    })
    .await
}

/// Records tool decisions (the guard applies them without a restart) and returns the server.
#[tauri::command]
pub async fn custom_mcp_set_tools(
    project: String,
    name: String,
    decisions: Vec<CustomMcpToolDecisionArg>,
) -> Result<CustomMcpEntryDto, String> {
    check_project(&project)?;
    blocking(move || {
        edit::set_tools_in(data_dir(), &project, &name, &decisions)?;
        list_now(&project)?
            .servers
            .into_iter()
            .find(|s| s.name == name)
            .ok_or_else(|| format!("no custom MCP server named '{name}'"))
    })
    .await
}

/// Sets a server's PII mode; the UI restarts the containers afterwards.
#[tauri::command]
pub async fn custom_mcp_set_pii_mode(
    project: String,
    name: String,
    pii_mode: CustomPiiMode,
) -> Result<(), String> {
    blocking(move || {
        edit::set_pii_mode_in(
            data_dir(),
            &project,
            &name,
            pii_mode,
            current_managed_policy().as_ref(),
            chrono::Utc::now(),
        )
    })
    .await
}

/// Sets a server's project file access; the UI restarts the containers afterwards.
#[tauri::command]
pub async fn custom_mcp_set_file_access(
    project: String,
    name: String,
    workspace_mode: WorkspaceMode,
) -> Result<(), String> {
    blocking(move || {
        edit::set_file_access_in(
            data_dir(),
            &project,
            &name,
            workspace_mode,
            current_managed_policy().as_ref(),
            chrono::Utc::now(),
        )
    })
    .await
}

/// Turns a server on or off; the UI restarts the containers afterwards.
#[tauri::command]
pub async fn custom_mcp_set_enabled(
    project: String,
    name: String,
    enabled: bool,
) -> Result<(), String> {
    blocking(move || edit::set_enabled_in(data_dir(), &project, &name, enabled)).await
}

/// Lets a server reach `host:port` through its egress proxy, without a restart.
#[tauri::command]
pub async fn custom_mcp_allow_domain(
    project: String,
    name: String,
    host: String,
    port: u16,
) -> Result<(), String> {
    blocking(move || {
        edit::allow_domain_in(
            data_dir(),
            &project,
            &name,
            &host,
            port,
            current_managed_policy().as_ref(),
        )
    })
    .await
}

/// Stops a server from reaching `host:port`, without a restart.
#[tauri::command]
pub async fn custom_mcp_remove_domain(
    project: String,
    name: String,
    host: String,
    port: u16,
) -> Result<(), String> {
    blocking(move || {
        edit::remove_domain_in(
            data_dir(),
            &project,
            &name,
            &host,
            port,
            current_managed_policy().as_ref(),
        )
    })
    .await
}

/// Connections an npm server's egress proxy refused since its container started; read only when
/// the user opens the server, never with the list.
#[tauri::command]
pub async fn custom_mcp_egress_denials(
    project: String,
    name: String,
) -> Result<CustomMcpEgressDenialsDto, String> {
    check_project(&project)?;
    blocking(move || {
        let user_config = config::load_user_config().map_err(failure::settings_failed)?;
        let rt = speedwave_runtime::runtime::detect_runtime();
        egress::egress_denials_for(
            &user_config,
            current_managed_policy().as_ref(),
            &rt,
            &speedwave_runtime::runtime::project_has_compose_file,
            &project,
            &name,
        )
    })
    .await
}

fn rerender_if_running(
    rt: &speedwave_runtime::runtime::LockedRuntime,
    project: &str,
) -> anyhow::Result<()> {
    if !speedwave_runtime::runtime::project_has_compose_file(project)
        || rt.compose_ps(project)?.is_empty()
    {
        return Ok(());
    }
    use crate::types::IntoAnyhow;
    rt.transaction(project, |rt| -> anyhow::Result<()> {
        speedwave_runtime::update::save_snapshot(project)?;
        crate::containers_cmd::render_and_save_compose(project).into_anyhow()?;
        let up = speedwave_runtime::runtime::compose_validate_with_retry(rt, project)
            .and_then(|()| rt.compose_up(project));
        if let Err(e) = up {
            if let Err(rb) = speedwave_runtime::update::rollback_containers(rt, project) {
                anyhow::bail!("Restart failed: {e}. Rollback also failed: {rb}.");
            }
            anyhow::bail!("Restart failed: {e}. Rolled back to the previous configuration.");
        }
        Ok(())
    })
}

/// Revokes a server: config entry, containers, networks, image, credentials and state.
#[tauri::command]
pub async fn custom_mcp_remove(project: String, name: String) -> Result<(), String> {
    check_project(&project)?;
    blocking(move || {
        let rt = speedwave_runtime::runtime::detect_runtime();
        let sync_project = project.clone();
        edit::remove_in(
            data_dir(),
            &rt,
            &project,
            &name,
            current_managed_policy().as_ref(),
            &edit::RemoveHooks {
                rerender: &rerender_if_running,
                sync_relay: &|servers| relays::sync_before_render(&sync_project, servers),
            },
        )
    })
    .await
}

#[cfg(test)]
#[expect(clippy::unwrap_used, reason = "test fixtures use unwrap/expect")]
pub(crate) mod tests_support {
    use super::preview::{self, PendingPreviews};
    use super::registry;
    use speedwave_runtime::config::SpeedwaveUserConfig;
    use speedwave_runtime::custom_mcp::model::CustomMcpEntry;
    use speedwave_runtime::custom_mcp::policy;
    use speedwave_runtime::runtime::mock_runtime::MockRuntimeBuilder;
    use speedwave_runtime::runtime::OneshotSpec;
    use std::path::{Path, PathBuf};
    use std::sync::Arc;

    pub(crate) const PROJECT: &str = "acme";

    pub(crate) fn integrity() -> String {
        format!("sha512-{}==", "A".repeat(86))
    }

    pub(crate) fn fixture_config(data_dir: &Path) -> SpeedwaveUserConfig {
        let dir = data_dir.join("proj");
        std::fs::create_dir_all(&dir).unwrap();
        serde_json::from_value(serde_json::json!({
            "projects": [{"name": PROJECT, "dir": dir.to_string_lossy()}],
            "active_project": PROJECT,
            "ui": {"beta_enabled": true},
        }))
        .unwrap()
    }

    pub(crate) fn save(data_dir: &Path, cfg: &SpeedwaveUserConfig) {
        speedwave_runtime::config::save_user_config_to(cfg, &data_dir.join("config.json")).unwrap();
    }

    pub(crate) fn load(data_dir: &Path) -> SpeedwaveUserConfig {
        speedwave_runtime::config::load_user_config_from(&data_dir.join("config.json")).unwrap()
    }

    fn signed(mut entry: CustomMcpEntry, approved: bool) -> CustomMcpEntry {
        if approved {
            entry.consent_digest = Some(policy::consent_digest(&entry).unwrap());
            entry.approved_at = Some("2026-10-01T00:00:00Z".into());
        }
        entry
    }

    pub(crate) fn npm_entry(approved: bool) -> CustomMcpEntry {
        let entry = serde_json::from_value(serde_json::json!({
            "enabled": true,
            "source": {"kind": "npm", "lock": {
                "ecosystem": "npm",
                "package": "figma-developer-mcp",
                "version": "0.6.1",
                "integrity": integrity(),
                "lockfile_sha256": "a".repeat(64),
                "template_version": 1,
                "image_tag": "speedwave-mcp-custom-figma:0.6.1-0123456789abcdef",
                "args": ["--stdio"],
                "env_keys": ["FIGMA_API_KEY"],
                "published_at": "2026-09-01T00:00:00.000Z",
                "before_date": "2026-10-01T00:00:00.000Z",
            }},
        }))
        .unwrap();
        signed(entry, approved)
    }

    pub(crate) fn host_entry(approved: bool) -> CustomMcpEntry {
        let entry = serde_json::from_value(serde_json::json!({
            "enabled": true,
            "source": {"kind": "host", "port": 3845, "path": "/mcp"},
        }))
        .unwrap();
        signed(entry, approved)
    }

    pub(crate) fn lockfile() -> String {
        serde_json::json!({
            "name": "build",
            "lockfileVersion": 3,
            "requires": true,
            "packages": {
                "": {"dependencies": {"figma-developer-mcp": "0.6.1"}},
                "node_modules/figma-developer-mcp": {
                    "version": "0.6.1",
                    "integrity": integrity(),
                    "license": "MIT",
                    "bin": {"figma-developer-mcp": "dist/cli.js"}
                }
            }
        })
        .to_string()
    }

    pub(crate) fn repo_root() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
    }

    /// Runs a reviewed npm preview of `figma-developer-mcp@0.6.1` under `name` through the mock
    /// resolver; returns the preview id and the build root it was computed against.
    pub(crate) fn stage_npm_preview(
        data_dir: &Path,
        previews: &PendingPreviews,
        name: &str,
    ) -> (String, PathBuf) {
        stage_npm_preview_with(data_dir, previews, name, lockfile())
    }

    /// [`stage_npm_preview`] with the lockfile the mock resolver writes.
    pub(crate) fn stage_npm_preview_with(
        data_dir: &Path,
        previews: &PendingPreviews,
        name: &str,
        lock_text: String,
    ) -> (String, PathBuf) {
        let (rt, _) = MockRuntimeBuilder::new()
            .with_oneshot_handler(Arc::new(move |spec: &OneshotSpec| {
                std::fs::write(spec.mounts[0].host.join("package-lock.json"), &lock_text).unwrap();
                Ok(String::new())
            }))
            .build();
        let request = super::dto::CustomMcpPreviewRequest::Npm {
            name: name.into(),
            package: "figma-developer-mcp".into(),
            version: "0.6.1".into(),
            args: vec!["--stdio".into()],
            env_keys: vec!["FIGMA_API_KEY".into()],
        };
        let root = repo_root();
        let wall = chrono::Utc::now();
        let resolved =
            preview::resolve_npm(&rt, data_dir, &root, PROJECT, &request, None, wall).unwrap();
        let doc = serde_json::json!({
            "time": {"0.6.1": "2026-09-01T00:00:00.000Z"},
            "versions": {"0.6.1": {
                "license": "MIT",
                "_npmUser": {"name": "glips"},
                "dist": {"integrity": integrity()}
            }}
        });
        let facts =
            registry::parse_packument(&doc, "0.6.1", &resolved.resolution.integrity, None).unwrap();
        let dto = preview::finish_npm_preview(
            previews,
            PROJECT,
            &request,
            resolved,
            facts,
            None,
            false,
            None,
            std::time::Instant::now(),
            wall,
        )
        .unwrap();
        (dto.preview_id, root)
    }
}

#[cfg(test)]
#[expect(clippy::unwrap_used, reason = "test assertions use unwrap")]
mod tests {
    use super::*;
    use tests_support::{stage_npm_preview, PROJECT};

    #[test]
    fn an_npm_review_shows_the_pinned_package_and_its_registry_facts() {
        let data = tempfile::tempdir().unwrap();
        let previews = PendingPreviews::default();
        let (id, _) = stage_npm_preview(data.path(), &previews, "figma");
        let stored = previews.get(&id, std::time::Instant::now()).unwrap();
        assert_eq!(stored.project, PROJECT);
        assert_eq!(stored.name, "figma");
    }

    #[test]
    fn every_command_is_registered_in_the_invoke_handler() {
        let main = include_str!("main.rs");
        let handler = &main[main.find("generate_handler![").unwrap()..];
        for command in [
            "custom_mcp_get",
            "custom_mcp_scan_repo",
            "custom_mcp_preview",
            "custom_mcp_approve",
            "custom_mcp_set_tools",
            "custom_mcp_set_pii_mode",
            "custom_mcp_set_file_access",
            "custom_mcp_set_enabled",
            "custom_mcp_allow_domain",
            "custom_mcp_remove_domain",
            "custom_mcp_egress_denials",
            "custom_mcp_remove",
        ] {
            assert!(
                handler.contains(&format!("custom_mcp_cmd::{command},")),
                "{command} is not registered"
            );
        }
    }
}
