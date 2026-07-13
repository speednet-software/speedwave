//! Per-project native `managed-settings.json`, generated from the MDM-locked keys
//! and mounted `:ro` at `/etc/claude-code/` — the enforcement layer (ADR-076).

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
    create_owner_only_dir_chain(&dir)?;
    let env = crate::telemetry_env::locked_env_map(telemetry);
    let doc = serde_json::json!({ "env": env });
    let content = serde_json::to_string_pretty(&doc)?;
    crate::fs_perms::write_restricted_file_atomic(
        &managed_settings_path(data_dir, project),
        &content,
    )
}

/// Creates `dir` and every missing ancestor with owner-only permissions from the
/// moment each level is created — never a default-umask window (Unix) before a
/// later chmod. Existing ancestors are left untouched; only newly created ones,
/// plus the leaf, are tightened.
fn create_owner_only_dir_chain(dir: &Path) -> anyhow::Result<()> {
    let mut to_create = Vec::new();
    let mut cursor = Some(dir);
    while let Some(p) = cursor {
        if p.exists() {
            break;
        }
        to_create.push(p);
        cursor = p.parent();
    }
    for p in to_create.into_iter().rev() {
        // A concurrent creator (e.g. another project render) may have won the
        // race; either way the dir now exists and gets tightened below.
        if let Err(e) = std::fs::create_dir(p) {
            if e.kind() != std::io::ErrorKind::AlreadyExists {
                return Err(e.into());
            }
        }
        crate::fs_perms::set_owner_only_dir(p).map_err(|e| {
            anyhow::anyhow!("failed to restrict permissions on {}: {e}", p.display())
        })?;
    }
    // Leaf may have pre-existed (idempotent re-render) — always re-tighten it.
    crate::fs_perms::set_owner_only_dir(dir)
        .map_err(|e| anyhow::anyhow!("failed to restrict permissions on {}: {e}", dir.display()))
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "test code: panics on failure are acceptable assertions"
)]
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

    #[test]
    fn intermediate_claude_managed_dir_is_owner_only_on_first_render() {
        // The top-level `claude-managed/` dir must never pass through a
        // default-umask window before being tightened (project-name enumeration).
        let tmp = tempfile::tempdir().unwrap();
        write_managed_settings(tmp.path(), "proj", &locked_sample()).unwrap();
        let top = tmp.path().join(crate::consts::CLAUDE_MANAGED_SUBDIR);
        assert!(top.is_dir());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&top).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o700, "expected 0o700, got 0o{mode:o}");
        }
    }

    #[test]
    fn second_project_render_leaves_shared_parent_owner_only() {
        // Two projects share the same `claude-managed/` parent; rendering the
        // second must not weaken (or fail on) the already-tightened parent.
        let tmp = tempfile::tempdir().unwrap();
        write_managed_settings(tmp.path(), "proj-a", &locked_sample()).unwrap();
        write_managed_settings(tmp.path(), "proj-b", &locked_sample()).unwrap();
        let top = tmp.path().join(crate::consts::CLAUDE_MANAGED_SUBDIR);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&top).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o700, "expected 0o700, got 0o{mode:o}");
        }
        assert!(managed_settings_path(tmp.path(), "proj-a").exists());
        assert!(managed_settings_path(tmp.path(), "proj-b").exists());
    }

    #[test]
    fn writes_empty_env_when_nothing_locked() {
        // Master-switch-only / all-unlocked: the file is still written with an
        // empty `env` object, never a missing key or a non-object value.
        let mut t = locked_sample();
        t.locked_keys.clear();
        t.any_locked = false;
        let tmp = tempfile::tempdir().unwrap();
        write_managed_settings(tmp.path(), "proj", &t).unwrap();
        let p = managed_settings_path(tmp.path(), "proj");
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
        let env = v.get("env").expect("env key present").as_object().unwrap();
        assert!(
            env.is_empty(),
            "no locked keys must yield an empty env object"
        );
    }
}
