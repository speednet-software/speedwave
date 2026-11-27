use super::caller_token::{generate_token, is_token};
use super::frame;
use super::layout::{ProjectPayload, SecretFile, Slot, VM_ROOT};
use crate::runtime::ContainerRuntime;
use std::path::Path;
use std::time::Duration;

const WRITE_TIMEOUT: Duration = Duration::from_secs(30);
const READ_TIMEOUT: Duration = Duration::from_secs(30);
const READ_SCRIPT: &str = r#"if [ -f "$1" ]; then cat "$1"; fi"#;

/// Where the caller token of a staging comes from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CallerTokenSource {
    /// The token already staged in the VM; a new one only when none is staged.
    ReuseStaged,
    /// A new random token, whatever is staged.
    DrawNew,
}

pub(crate) fn stage_project(
    runtime: &dyn ContainerRuntime,
    data_dir: &Path,
    project: &str,
    token_source: CallerTokenSource,
) -> anyhow::Result<()> {
    let settings = crate::config::load_project_settings(data_dir, project)?;
    let caller_token = token_for_staging(runtime, project, token_source)?;
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

fn token_for_staging(
    runtime: &dyn ContainerRuntime,
    project: &str,
    token_source: CallerTokenSource,
) -> anyhow::Result<String> {
    if token_source == CallerTokenSource::ReuseStaged {
        if let Some(staged) = staged_token(runtime, project)? {
            return Ok(staged);
        }
    }
    generate_token()
}

fn staged_token(runtime: &dyn ContainerRuntime, project: &str) -> anyhow::Result<Option<String>> {
    let path = crate::compose::secret_slots::caller_token_vm_path(project)?;
    let output = runtime
        .vm_exec_as_root("sh", &["-c", READ_SCRIPT, "sh", &path], &[], READ_TIMEOUT)
        .map_err(|e| e.context(format!("reading the caller token of project '{project}'")))?;
    if !output.ok() {
        anyhow::bail!(
            "reading the caller token of project '{project}' from the VM failed ({}): {}",
            output.status,
            output.stderr_str().trim()
        );
    }
    let staged = output.stdout_str().trim().to_string();
    Ok(is_token(&staged).then_some(staged))
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
