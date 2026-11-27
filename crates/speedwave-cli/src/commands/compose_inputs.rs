use speedwave_runtime::compose::{self, SecurityExpectedPaths};
use speedwave_runtime::config::{self, ResolvedClaudeConfig, ResolvedIntegrationsConfig};
use speedwave_runtime::os_prereqs::{self, PrereqViolation};
use speedwave_runtime::plugin::{self, PluginManifest};
use speedwave_runtime::runtime::LockedRuntime;

use crate::project_command::ProjectContext;

pub(super) struct ComposeInputs {
    pub(super) resolved: ResolvedClaudeConfig,
    pub(super) integrations: ResolvedIntegrationsConfig,
    pub(super) compose_yml: String,
    pub(super) manifests: Vec<PluginManifest>,
    pub(super) expected_paths: SecurityExpectedPaths,
    pub(super) prereq_violations: Vec<PrereqViolation>,
}

pub(super) fn gather(
    project: &ProjectContext,
    runtime: &LockedRuntime,
) -> anyhow::Result<ComposeInputs> {
    if let Err(e) = speedwave_runtime::cloudstorage::check_project_readable_or_err(&project.dir) {
        err!(
            "{}",
            speedwave_runtime::cloudstorage::TCC_USER_REMEDIATION_MESSAGE
        );
        err!("({e})");
        std::process::exit(1);
    }

    let (resolved, integrations) =
        config::resolve_project_config(&project.dir, &project.user_config, &project.name);

    let cleaned = speedwave_runtime::legacy_token_cleanup::run_legacy_token_cleanup_at_startup();
    if cleaned > 0 {
        log::info!("legacy token cleanup sanitised {cleaned} project(s)");
    }

    let _ = speedwave_runtime::oauth_state_migration::run_oauth_state_migration_at_startup();

    let host_bridges = compose::host_bridges_from_disk();

    let project_dir = project.dir.to_string_lossy();
    let compose_yml = compose::render_compose(
        &project.name,
        &project_dir,
        &resolved,
        &integrations,
        Some(runtime),
        &host_bridges,
    )?;

    let manifests = plugin::list_installed_plugins().unwrap_or_else(|e| {
        log::warn!("Failed to list installed plugins: {e}");
        Vec::new()
    });
    let expected_paths = SecurityExpectedPaths::compute(&project.name, &project_dir)?
        .with_telemetry_locked(resolved.telemetry.any_locked);

    let prereq_violations = os_prereqs::check_os_prereqs();

    Ok(ComposeInputs {
        resolved,
        integrations,
        compose_yml,
        manifests,
        expected_paths,
        prereq_violations,
    })
}
