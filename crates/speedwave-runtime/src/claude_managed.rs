//! Per-project native Claude Code managed-settings.json. Speedwave generates it
//! from the MDM-locked telemetry keys and mounts it `:ro` at
//! `/etc/claude-code/managed-settings.json` — the un-bypassable enforcement layer.

use crate::config::ResolvedTelemetry;
use std::path::{Path, PathBuf};

/// `<data_dir>/claude-managed/<project>/`. Caller validates `project` as a safe component.
pub fn claude_managed_dir(data_dir: &Path, project: &str) -> PathBuf {
    data_dir
        .join(crate::consts::CLAUDE_MANAGED_SUBDIR)
        .join(project)
}

/// The managed-settings.json path inside the per-project managed dir.
pub fn managed_settings_path(data_dir: &Path, project: &str) -> PathBuf {
    claude_managed_dir(data_dir, project).join(crate::consts::MANAGED_SETTINGS_FILE)
}

/// Writes managed-settings.json carrying only the MDM-locked OTEL_* keys in an
/// `env` block. Dir owner-only (0o700 / DACL), file 0o600 via fs_perms atomic write.
pub fn write_managed_settings(
    data_dir: &Path,
    project: &str,
    telemetry: &ResolvedTelemetry,
) -> anyhow::Result<()> {
    let dir = claude_managed_dir(data_dir, project);
    crate::fs_perms::ensure_owner_only_dir(&dir)?;
    let env = crate::telemetry_env::locked_env_map(telemetry);
    let doc = serde_json::json!({ "env": env });
    let content = serde_json::to_string_pretty(&doc)?;
    crate::fs_perms::write_restricted_file_atomic(
        &managed_settings_path(data_dir, project),
        &content,
    )
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use crate::config::{OtlpProtocol, ResolvedTelemetry};
    use std::path::Path;

    #[test]
    fn managed_dir_layout() {
        let p = claude_managed_dir(Path::new("/data"), "proj");
        assert_eq!(p, Path::new("/data/claude-managed/proj"));
    }

    fn locked_sample() -> ResolvedTelemetry {
        let mut t = ResolvedTelemetry {
            enabled: true,
            endpoint: Some("https://c.example.com:4318".into()),
            protocol: OtlpProtocol::Grpc,
            export_metrics: true,
            export_logs: false,
            headers: None,
            resource_attributes: None,
            include_account_uuid: true,
            log_user_prompts: false,
            log_assistant_responses: false,
            log_tool_details: false,
            log_raw_api_bodies: false,
            metric_export_interval_ms: None,
            logs_export_interval_ms: None,
            locked_keys: Default::default(),
            any_locked: true,
            kill_switch: false,
        };
        t.locked_keys.insert("OTEL_EXPORTER_OTLP_ENDPOINT".into());
        t
    }

    #[test]
    fn writes_managed_settings_with_locked_env_only() {
        let tmp = tempfile::tempdir().unwrap();
        write_managed_settings(tmp.path(), "proj", &locked_sample()).unwrap();
        let p = managed_settings_path(tmp.path(), "proj");
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
        let env = v.get("env").unwrap().as_object().unwrap();
        assert_eq!(
            env.get("OTEL_EXPORTER_OTLP_ENDPOINT").unwrap(),
            "https://c.example.com:4318"
        );
        assert!(
            !env.contains_key("OTEL_METRICS_EXPORTER"),
            "only locked keys go into managed-settings"
        );
    }
}
