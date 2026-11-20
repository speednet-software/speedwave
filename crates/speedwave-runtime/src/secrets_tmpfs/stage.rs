use super::frame;
use super::layout::{ProjectPayload, SecretFile, Slot, VM_ROOT};
use crate::runtime::ContainerRuntime;
use std::path::Path;
use std::time::Duration;

const WRITE_TIMEOUT: Duration = Duration::from_secs(30);

pub(crate) fn stage_project(
    runtime: &dyn ContainerRuntime,
    data_dir: &Path,
    project: &str,
) -> anyhow::Result<()> {
    let payload = collect_payload(data_dir, project)?;
    sync_payload(runtime, project, &payload)
}

pub(crate) fn put_file(
    runtime: &dyn ContainerRuntime,
    project: &str,
    slot: &Slot,
    file: &SecretFile,
) -> anyhow::Result<()> {
    run_frame(runtime, project, &frame::encode_put(project, slot, file)?)
}

fn sync_payload(
    runtime: &dyn ContainerRuntime,
    project: &str,
    payload: &ProjectPayload,
) -> anyhow::Result<()> {
    run_frame(runtime, project, &frame::encode_sync(project, payload)?)
}

pub(crate) struct ProjectSettings {
    pub(crate) resolved_config: crate::config::ResolvedClaudeConfig,
    pub(crate) integrations: crate::config::ResolvedIntegrationsConfig,
    pub(crate) plugin_manifests: Vec<crate::plugin::PluginManifest>,
}

pub(crate) fn load_project_settings(
    data_dir: &Path,
    project: &str,
) -> anyhow::Result<ProjectSettings> {
    let user_config = crate::config::load_user_config_from(&data_dir.join("config.json"))?;
    let entry = user_config.require_project(project)?;
    let (resolved_config, integrations) = crate::config::resolve_project_config_in(
        data_dir,
        Path::new(&entry.dir),
        &user_config,
        project,
    );
    let plugin_manifests: Vec<crate::plugin::PluginManifest> =
        crate::plugin::list_verified_from_dir(&crate::plugin::plugins_base_dir_in(data_dir))?
            .iter()
            .map(|verified| verified.manifest().clone())
            .collect();
    Ok(ProjectSettings {
        resolved_config,
        integrations,
        plugin_manifests,
    })
}

fn collect_payload(data_dir: &Path, project: &str) -> anyhow::Result<ProjectPayload> {
    let settings = load_project_settings(data_dir, project)?;
    crate::compose::secret_payload::collect_project_payload_in(
        data_dir,
        project,
        &settings.resolved_config,
        &settings.integrations,
        &settings.plugin_manifests,
    )
}

fn run_frame(runtime: &dyn ContainerRuntime, project: &str, frame: &[u8]) -> anyhow::Result<()> {
    let script = frame::production_script();
    let output = runtime
        .vm_exec_as_root("sh", &["-c", &script, "sh", VM_ROOT], frame, WRITE_TIMEOUT)
        .map_err(|e| {
            e.context(format!(
                "writing secrets of project '{project}' into the VM"
            ))
        })?;
    if !output.ok() {
        anyhow::bail!(
            "writing secrets of project '{project}' into the VM failed ({}): {}",
            output.status,
            output.stderr_str().trim()
        );
    }
    Ok(())
}
