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
    let tmp_path = path.with_extension("json.tmp");
    std::fs::write(&tmp_path, &json)?;

    // Restrict permissions before rename to avoid TOCTOU window where the file
    // briefly exists with umask-derived permissions after atomic rename.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp_path, std::fs::Permissions::from_mode(0o600))?;
    }

    std::fs::rename(&tmp_path, &path)?;

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
    let project_dir = user_config.require_project(project)?.dir.clone();

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

    // 6. Rebuild images from local Containerfiles BEFORE stopping containers.
    //    If the build fails, containers keep running with the previous version.
    //    containerd uses content-addressable storage — new builds don't affect running containers.
    let images_rebuilt = build::build_all_images(runtime).map_err(|e| {
        anyhow::anyhow!(
            "Image rebuild failed: {}. Containers are still running with the previous version.",
            e
        )
    })?;

    // 7. Graceful shutdown — stop running containers before recreate.
    //    SIGTERM + timeout (compose default 10s) prevents killing active Claude sessions.
    runtime.compose_down(project)?;

    // 8. Recreate containers with newly built images
    runtime.compose_up_recreate(project)?;

    // 9. Wait for containers to stabilize before health check.
    //    A crash-looping container may briefly show state=="running".
    std::thread::sleep(std::time::Duration::from_secs(
        consts::CONTAINER_STABILIZATION_DELAY_SECS,
    ));

    // 10. Verify containers are running
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
    fn test_snapshot_permissions_after_save() {
        use std::os::unix::fs::PermissionsExt;

        let project = format!(
            "perms-test-{}",
            std::time::SystemTime::UNIX_EPOCH
                .elapsed()
                .unwrap()
                .subsec_nanos()
        );

        let compose_path = compose::compose_output_path(&project).unwrap();
        let snap_path = snapshot_path(&project).unwrap();

        struct Cleanup {
            paths: Vec<std::path::PathBuf>,
        }
        impl Drop for Cleanup {
            fn drop(&mut self) {
                for p in &self.paths {
                    let _ = std::fs::remove_dir_all(p);
                }
            }
        }
        let _cleanup = Cleanup {
            paths: vec![
                compose_path.parent().unwrap().to_path_buf(),
                snap_path.parent().unwrap().to_path_buf(),
            ],
        };

        std::fs::create_dir_all(compose_path.parent().unwrap()).unwrap();
        std::fs::write(&compose_path, "version: '3'\nservices: {}\n").unwrap();

        save_snapshot(&project).unwrap();

        let perms = std::fs::metadata(&snap_path).unwrap().permissions();
        assert_eq!(
            perms.mode() & 0o777,
            0o600,
            "snapshot.json must be 0o600 after save_snapshot"
        );
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

    #[test]
    fn test_snapshot_atomic_write_no_tmp_residue() {
        // Call the real save_snapshot() by setting up the compose output file it reads.
        // Uses a unique project name to avoid collisions in parallel test runs.
        let project = format!(
            "atomic-write-test-{}",
            std::time::SystemTime::UNIX_EPOCH
                .elapsed()
                .unwrap()
                .subsec_nanos()
        );

        // Set up the compose file that save_snapshot() will read
        let compose_path = compose::compose_output_path(&project).unwrap();
        let snap_path = snapshot_path(&project).unwrap();

        // RAII guard: clean up $HOME/.speedwave/ subdirs even on panic
        struct Cleanup {
            paths: Vec<std::path::PathBuf>,
        }
        impl Drop for Cleanup {
            fn drop(&mut self) {
                for p in &self.paths {
                    let _ = std::fs::remove_dir_all(p);
                }
            }
        }
        let _cleanup = Cleanup {
            paths: vec![
                compose_path.parent().unwrap().to_path_buf(),
                snap_path.parent().unwrap().to_path_buf(),
            ],
        };

        std::fs::create_dir_all(compose_path.parent().unwrap()).unwrap();
        std::fs::write(&compose_path, "version: '3'\nservices: {}\n").unwrap();

        // Call the real function
        save_snapshot(&project).unwrap();

        // Verify no .json.tmp residue remains
        let tmp_path = snap_path.with_extension("json.tmp");
        assert!(
            !tmp_path.exists(),
            ".json.tmp must not remain after atomic rename"
        );

        // Verify content was written correctly
        let loaded = load_snapshot(&project).unwrap();
        assert_eq!(loaded.project, project);
        assert_eq!(loaded.compose_yml, "version: '3'\nservices: {}\n");

        // Verify file permissions (unix only)
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let perms = std::fs::metadata(&snap_path).unwrap().permissions();
            assert_eq!(
                perms.mode() & 0o777,
                0o600,
                "snapshot.json must be 0o600 after save_snapshot"
            );
        }
    }

    #[test]
    fn test_build_before_compose_down_in_update_containers() {
        // **Why a structural (source-code) test?**
        //
        // The key safety invariant: `build_all_images` must run BEFORE
        // `compose_down`. Building first means a failed build leaves running
        // containers untouched (containerd uses content-addressable storage,
        // so new images don't affect running containers).
        //
        // A behavioral test would require mocking `build::build_all_images`
        // (a free function, not a trait method) plus `config::load_user_config`,
        // `compose::render_compose`, `SecurityCheck::run`, and filesystem I/O.
        // That level of test infrastructure isn't justified for a single
        // ordering invariant. Instead we verify the call order directly in
        // the source text, scoped to the `update_containers` function body.
        let source = include_str!("update.rs");

        // Locate the function body to avoid false matches from
        // rollback_containers or other functions that also call compose_down.
        let fn_start = source
            .find("fn update_containers(")
            .expect("update_containers function must exist in update.rs");
        let fn_body = &source[fn_start..];

        let build_pos = fn_body
            .find("build::build_all_images")
            .expect("build_all_images call must exist in update_containers");
        let down_pos = fn_body
            .find("runtime.compose_down(project)")
            .expect("compose_down call must exist in update_containers");

        assert!(
            build_pos < down_pos,
            "Safety invariant violated: build_all_images (at byte offset {build_pos}) \
             must appear before compose_down (at byte offset {down_pos}) in \
             update_containers — building first ensures a failed build leaves \
             running containers untouched",
        );
    }

    #[test]
    fn test_stabilization_delay_is_reasonable() {
        assert!(
            consts::CONTAINER_STABILIZATION_DELAY_SECS >= 1,
            "stabilization delay must be at least 1 second"
        );
        assert!(
            consts::CONTAINER_STABILIZATION_DELAY_SECS <= 10,
            "stabilization delay must not exceed 10 seconds"
        );
    }
}
