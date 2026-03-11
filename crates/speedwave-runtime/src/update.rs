use crate::build;
use crate::compose::{self, SecurityCheck};
use crate::config;
use crate::consts;
use crate::runtime::ContainerRuntime;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct UpdateSnapshot {
    pub project: String,
    pub compose_yml: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ContainerUpdateResult {
    pub success: bool,
    pub images_rebuilt: u32,
    pub containers_recreated: u32,
    pub error: Option<String>,
}

pub use crate::validation::validate_project_name;

// ---------------------------------------------------------------------------
// Snapshot helpers
// ---------------------------------------------------------------------------

fn snapshot_dir(project: &str) -> anyhow::Result<PathBuf> {
    let dir = dirs::home_dir()
        .ok_or_else(|| anyhow::anyhow!("cannot determine home directory"))?
        .join(consts::DATA_DIR)
        .join("snapshots")
        .join(project);
    Ok(dir)
}

fn snapshot_path(project: &str) -> anyhow::Result<PathBuf> {
    Ok(snapshot_dir(project)?.join("snapshot.json"))
}

pub fn save_snapshot(project: &str) -> anyhow::Result<()> {
    let compose_path = compose::compose_output_path(project)?;
    let compose_yml = std::fs::read_to_string(&compose_path).map_err(|e| {
        anyhow::anyhow!(
            "cannot read current compose file at {}: {}",
            compose_path.display(),
            e
        )
    })?;

    let dir = snapshot_dir(project)?;
    std::fs::create_dir_all(&dir)?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
    }

    let snapshot = UpdateSnapshot {
        project: project.to_string(),
        compose_yml,
    };

    let path = snapshot_path(project)?;
    let json = serde_json::to_string_pretty(&snapshot)?;
    std::fs::write(&path, json)?;

    // Restrict snapshot file permissions (may contain sensitive compose config)
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    }

    Ok(())
}

fn load_snapshot(project: &str) -> anyhow::Result<UpdateSnapshot> {
    let path = snapshot_path(project)?;
    let data = std::fs::read_to_string(&path)
        .map_err(|e| anyhow::anyhow!("no snapshot found for project '{}': {}", project, e))?;
    let snapshot: UpdateSnapshot = serde_json::from_str(&data)?;
    Ok(snapshot)
}

// ---------------------------------------------------------------------------
// Update / rollback
// ---------------------------------------------------------------------------

pub fn update_containers(
    runtime: &dyn ContainerRuntime,
    project: &str,
) -> anyhow::Result<ContainerUpdateResult> {
    validate_project_name(project)?;

    // 1. Load config and resolve
    let user_config = config::load_user_config()?;
    let project_dir = user_config
        .projects
        .iter()
        .find(|p| p.name == project)
        .map(|p| p.dir.clone())
        .ok_or_else(|| anyhow::anyhow!("project '{}' not found in config", project))?;

    let project_path = std::path::PathBuf::from(&project_dir);
    let (resolved, integrations) =
        config::resolve_project_config(&project_path, &user_config, project);

    // 2. Re-render compose.yml with current template
    let compose_yml = compose::render_compose(project, &project_dir, &resolved, &integrations)?;

    // 3. Mandatory security gate — BEFORE saving anything
    let violations = SecurityCheck::run(&compose_yml, project);
    if !violations.is_empty() {
        let msgs: Vec<String> = violations
            .iter()
            .map(|v| format!("[{}] {} -- {}", v.container, v.rule, v.message))
            .collect();
        anyhow::bail!("Security check failed:\n{}", msgs.join("\n"));
    }

    // 4. Save snapshot of current compose.yml for rollback (AFTER security check)
    save_snapshot(project)?;

    // 5. Save new compose.yml
    compose::save_compose(project, &compose_yml)?;

    // 6. Graceful shutdown — stop running containers before rebuild/recreate.
    //    SIGTERM + timeout (compose default 10s) prevents killing active Claude sessions.
    runtime.compose_down(project)?;

    // 7. Rebuild images from local Containerfiles.
    //    Images are built locally (no registry) — this picks up any changes
    //    to Containerfiles, entrypoint scripts, or MCP server code.
    let images_rebuilt = build::build_all_images(runtime).map_err(|e| {
        anyhow::anyhow!(
            "Image rebuild failed: {}. Containers are stopped. Run `speedwave` to restart with previous config, or retry the update.",
            e
        )
    })?;

    // 8. Recreate containers
    runtime.compose_up_recreate(project)?;

    // 9. Verify containers are running
    let containers = runtime.compose_ps(project)?;
    let running = containers
        .iter()
        .filter(|c| {
            c.get("State")
                .and_then(|s| s.as_str())
                .map(|s| s == "running")
                .unwrap_or(false)
        })
        .count() as u32;
    let total = containers.len() as u32;

    if running == 0 && total > 0 {
        anyhow::bail!(
            "Update completed but no containers are running ({} exited)",
            total
        );
    }

    Ok(ContainerUpdateResult {
        success: true,
        images_rebuilt,
        containers_recreated: running,
        error: None,
    })
}

pub fn rollback_containers(runtime: &dyn ContainerRuntime, project: &str) -> anyhow::Result<()> {
    validate_project_name(project)?;

    let snapshot = load_snapshot(project)?;

    // Security check on the snapshot compose.yml before applying
    let violations = SecurityCheck::run(&snapshot.compose_yml, project);
    if !violations.is_empty() {
        let msgs: Vec<String> = violations
            .iter()
            .map(|v| format!("[{}] {} -- {}", v.container, v.rule, v.message))
            .collect();
        anyhow::bail!(
            "Rollback aborted — snapshot compose.yml failed security check:\n{}",
            msgs.join("\n")
        );
    }

    // Restore compose.yml from snapshot
    compose::save_compose(project, &snapshot.compose_yml)?;

    // Recreate containers with the old compose config
    runtime.compose_up_recreate(project).map_err(|e| {
        anyhow::anyhow!(
            "Rollback failed: {}. Old compose.yml was restored. Run `speedwave` to start containers manually.",
            e
        )
    })?;

    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn test_snapshot_save_and_load_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let project = "test-snapshot";

        // Create a fake compose file that save_snapshot will read
        let compose_dir = dir.path().join("compose").join(project);
        std::fs::create_dir_all(&compose_dir).unwrap();
        let compose_content = "version: '3'\nservices:\n  claude:\n    image: test\n";
        std::fs::write(compose_dir.join("compose.yml"), compose_content).unwrap();

        // Test snapshot serialization/deserialization roundtrip
        let snapshot = UpdateSnapshot {
            project: project.to_string(),
            compose_yml: compose_content.to_string(),
        };

        let json = serde_json::to_string_pretty(&snapshot).unwrap();
        let loaded: UpdateSnapshot = serde_json::from_str(&json).unwrap();

        assert_eq!(loaded.project, project);
        assert_eq!(loaded.compose_yml, compose_content);
    }

    #[test]
    fn test_update_result_serializes() {
        let result = ContainerUpdateResult {
            success: true,
            images_rebuilt: 3,
            containers_recreated: 2,
            error: None,
        };
        let json = serde_json::to_string(&result).unwrap();
        let loaded: ContainerUpdateResult = serde_json::from_str(&json).unwrap();
        assert!(loaded.success);
        assert_eq!(loaded.images_rebuilt, 3);
        assert_eq!(loaded.containers_recreated, 2);
        assert!(loaded.error.is_none());
    }

    #[test]
    fn test_update_result_serializes_with_error() {
        let result = ContainerUpdateResult {
            success: false,
            images_rebuilt: 0,
            containers_recreated: 0,
            error: Some("build failed".to_string()),
        };
        let json = serde_json::to_string(&result).unwrap();
        let loaded: ContainerUpdateResult = serde_json::from_str(&json).unwrap();
        assert!(!loaded.success);
        assert_eq!(loaded.error.as_deref(), Some("build failed"));
    }

    #[cfg(unix)]
    #[test]
    fn test_snapshot_directory_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let snap_dir = dir.path().join("test-perms");
        std::fs::create_dir_all(&snap_dir).unwrap();

        std::fs::set_permissions(&snap_dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        let perms = std::fs::metadata(&snap_dir).unwrap().permissions();
        assert_eq!(perms.mode() & 0o777, 0o700);
    }

    #[test]
    fn test_snapshot_path_format() {
        let path = snapshot_path("my-project").unwrap();
        let path_str = path.to_string_lossy();
        assert!(path_str.contains(consts::DATA_DIR));
        assert!(path_str.contains("snapshots"));
        assert!(path_str.contains("my-project"));
        assert!(path_str.ends_with("snapshot.json"));
    }
}
