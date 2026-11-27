use super::frame;
use super::layout::{ProjectPayload, SecretFile, Slot, VM_ROOT};
use crate::compose::caller_token::{self, TokenRotation};
use crate::runtime::ContainerRuntime;
use std::path::Path;
use std::time::Duration;

const WRITE_TIMEOUT: Duration = Duration::from_secs(30);

pub(crate) fn stage_project(
    runtime: &dyn ContainerRuntime,
    data_dir: &Path,
    project: &str,
    rotation: TokenRotation,
) -> anyhow::Result<()> {
    let settings = crate::config::load_project_settings(data_dir, project)?;
    let caller_token = caller_token::token_for_staging(runtime, project, rotation)?;
    let payload = crate::compose::secret_payload::collect_project_payload_in(
        data_dir,
        project,
        &settings.resolved_config,
        &settings.integrations,
        &settings.plugin_manifests,
        &caller_token,
    )?;
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
