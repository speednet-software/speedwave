//! Per-project native `managed-settings.json`, generated from the MDM-locked keys
//! and mounted `:ro` at `/etc/claude-code/` — the enforcement layer (ADR-076).

use crate::config::{ManagedLlmEgressConfig, ResolvedTelemetry};
use std::collections::BTreeMap;
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

/// The gateway CA bundle inside the per-project managed dir.
pub fn gateway_ca_path(data_dir: &Path, project: &str) -> PathBuf {
    claude_managed_dir(data_dir, project).join(crate::consts::GATEWAY_CA_FILE)
}

/// Writes the `llm_egress` gateway CA bundle, or removes a stale one; true when one is in place.
pub fn write_gateway_ca(data_dir: &Path, project: &str, pem: Option<&str>) -> anyhow::Result<bool> {
    let path = gateway_ca_path(data_dir, project);
    match pem {
        Some(pem) => {
            create_owner_only_dir_chain(&claude_managed_dir(data_dir, project))?;
            crate::fs_perms::write_restricted_file_atomic(&path, pem)?;
            Ok(true)
        }
        None => {
            match std::fs::remove_file(&path) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.into()),
            }
            Ok(false)
        }
    }
}

/// Resource attribute naming the project telemetry came from, under an `llm_egress` policy.
pub const PROJECT_ATTRIBUTE: &str = "speedwave.project";

/// `OTEL_RESOURCE_ATTRIBUTES` plus the project, unless already named; `None` with telemetry off.
pub fn project_resource_attributes(telemetry: &ResolvedTelemetry, project: &str) -> Option<String> {
    if !telemetry.enabled {
        return None;
    }
    let base = telemetry
        .resource_attributes
        .as_deref()
        .unwrap_or("")
        .trim()
        .trim_matches(',')
        .to_string();
    let prefix = format!("{PROJECT_ATTRIBUTE}=");
    if base.split(',').any(|kv| kv.trim().starts_with(&prefix)) {
        return Some(base);
    }
    let own = format!("{PROJECT_ATTRIBUTE}={project}");
    Some(if base.is_empty() {
        own
    } else {
        format!("{base},{own}")
    })
}

/// Writes managed-settings.json with the MDM-locked keys in an `env` block: the OTEL_* locks
/// and, under an `llm_egress` policy (ADR-090), the proxy route and the locked model env; the
/// agents the `agents` policy keeps off (ADR-091) are denied to Claude by name.
pub fn write_managed_settings(
    data_dir: &Path,
    project: &str,
    telemetry: &ResolvedTelemetry,
    egress: Option<&ManagedLlmEgressConfig>,
    denied_agents: &[String],
) -> anyhow::Result<()> {
    let dir = claude_managed_dir(data_dir, project);
    create_owner_only_dir_chain(&dir)?;
    let mut env: BTreeMap<String, String> = BTreeMap::new();
    if let Some(e) = egress {
        env.extend(e.locked_claude_env());
        env.insert(
            "ANTHROPIC_BASE_URL".to_string(),
            crate::compose::PROXY_BASE_URL.to_string(),
        );
    }
    env.extend(crate::telemetry_env::locked_env_map(telemetry));
    if egress.is_some() {
        if let Some(ra) = project_resource_attributes(telemetry, project) {
            env.insert("OTEL_RESOURCE_ATTRIBUTES".to_string(), ra);
        }
    }
    let mut doc = serde_json::json!({ "env": env });
    if !denied_agents.is_empty() {
        let deny: Vec<String> = denied_agents
            .iter()
            .flat_map(|a| [format!("Agent({a})"), format!("Task({a})")])
            .collect();
        doc["permissions"] = serde_json::json!({ "deny": deny });
    }
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
        if let Err(e) = std::fs::create_dir(p) {
            if e.kind() != std::io::ErrorKind::AlreadyExists {
                return Err(e.into());
            }
        }
        crate::fs_perms::set_owner_only_dir(p).map_err(|e| {
            anyhow::anyhow!("failed to restrict permissions on {}: {e}", p.display())
        })?;
    }
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
        write_managed_settings(tmp.path(), "proj", &locked_sample(), None, &[]).unwrap();
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
        let tmp = tempfile::tempdir().unwrap();
        write_managed_settings(tmp.path(), "proj", &locked_sample(), None, &[]).unwrap();
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
        let tmp = tempfile::tempdir().unwrap();
        write_managed_settings(tmp.path(), "proj-a", &locked_sample(), None, &[]).unwrap();
        write_managed_settings(tmp.path(), "proj-b", &locked_sample(), None, &[]).unwrap();
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

    fn gateway() -> ManagedLlmEgressConfig {
        ManagedLlmEgressConfig {
            anthropic_base_url: Some("https://gateway.example/llm".into()),
            ..Default::default()
        }
    }

    #[test]
    fn an_egress_policy_pins_the_proxy_and_locks_only_model_env() {
        let tmp = tempfile::tempdir().unwrap();
        let mut egress = gateway();
        egress
            .claude_env
            .insert("ANTHROPIC_MODEL".into(), "claude-opus-5-5".into());
        egress
            .claude_env
            .insert("ANTHROPIC_AUTH_TOKEN".into(), "secret".into());
        write_managed_settings(tmp.path(), "proj", &locked_sample(), Some(&egress), &[]).unwrap();
        let v: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(managed_settings_path(tmp.path(), "proj")).unwrap(),
        )
        .unwrap();
        let env = v["env"].as_object().unwrap();
        assert_eq!(env["ANTHROPIC_BASE_URL"], crate::compose::PROXY_BASE_URL);
        assert_eq!(env["ANTHROPIC_MODEL"], "claude-opus-5-5");
        assert!(!env.contains_key("ANTHROPIC_AUTH_TOKEN"));
        assert!(env.contains_key("OTEL_EXPORTER_OTLP_ENDPOINT"));
    }

    #[test]
    fn telemetry_names_the_project_it_came_from() {
        let tmp = tempfile::tempdir().unwrap();
        let mut t = locked_sample();
        t.resource_attributes = Some("team=payments".into());
        write_managed_settings(tmp.path(), "billing-bot", &t, Some(&gateway()), &[]).unwrap();
        let v: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(managed_settings_path(tmp.path(), "billing-bot")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            v["env"]["OTEL_RESOURCE_ATTRIBUTES"],
            "team=payments,speedwave.project=billing-bot"
        );
        write_managed_settings(tmp.path(), "plain", &t, None, &[]).unwrap();
        let plain = std::fs::read_to_string(managed_settings_path(tmp.path(), "plain")).unwrap();
        assert!(!plain.contains(PROJECT_ATTRIBUTE), "{plain}");
        t.resource_attributes = None;
        assert_eq!(
            project_resource_attributes(&t, "x").as_deref(),
            Some("speedwave.project=x")
        );
        t.resource_attributes = Some("speedwave.project=fixed".into());
        assert_eq!(
            project_resource_attributes(&t, "x").as_deref(),
            Some("speedwave.project=fixed")
        );
        t.enabled = false;
        assert!(project_resource_attributes(&t, "x").is_none());
    }

    #[test]
    fn writes_empty_env_when_nothing_locked() {
        let mut t = locked_sample();
        t.locked_keys.clear();
        t.any_locked = false;
        let tmp = tempfile::tempdir().unwrap();
        write_managed_settings(tmp.path(), "proj", &t, None, &[]).unwrap();
        let p = managed_settings_path(tmp.path(), "proj");
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
        let env = v.get("env").expect("env key present").as_object().unwrap();
        assert!(
            env.is_empty(),
            "no locked keys must yield an empty env object"
        );
    }

    #[test]
    fn the_agents_the_policy_keeps_off_are_denied_to_claude() {
        let tmp = tempfile::tempdir().unwrap();
        write_managed_settings(
            tmp.path(),
            "proj",
            &locked_sample(),
            None,
            &["reviewer".to_string()],
        )
        .unwrap();
        let doc: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(managed_settings_path(tmp.path(), "proj")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            doc["permissions"]["deny"],
            serde_json::json!(["Agent(reviewer)", "Task(reviewer)"])
        );
        write_managed_settings(tmp.path(), "proj", &locked_sample(), None, &[]).unwrap();
        let doc: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(managed_settings_path(tmp.path(), "proj")).unwrap(),
        )
        .unwrap();
        assert!(doc.get("permissions").is_none());
    }
}
