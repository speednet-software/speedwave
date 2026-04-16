use crate::build;
use crate::bundle;
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
    #[serde(default)]
    pub plugin_manifests: Vec<crate::plugin::PluginManifest>,
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
    let dir = consts::data_dir().join("snapshots").join(project);
    Ok(dir)
}

fn snapshot_path(project: &str) -> anyhow::Result<PathBuf> {
    Ok(snapshot_dir(project)?.join("snapshot.json"))
}

/// Testable variant: resolves snapshot path under an explicit data directory.
#[cfg(test)]
fn snapshot_path_in(data_dir: &std::path::Path, project: &str) -> PathBuf {
    data_dir
        .join("snapshots")
        .join(project)
        .join("snapshot.json")
}

/// Sets `0o700` permissions on `dir` and its parent (if any).
/// Used by both `save_snapshot()` and `save_snapshot_in()` to secure the
/// `snapshots/<project>/` directory and its parent `snapshots/` directory.
#[cfg(unix)]
fn secure_snapshot_dirs(dir: &std::path::Path) -> anyhow::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mode_700 = std::fs::Permissions::from_mode(0o700);
    std::fs::set_permissions(dir, mode_700.clone())?;
    if let Some(parent) = dir.parent() {
        std::fs::set_permissions(parent, mode_700)?;
    }
    Ok(())
}

/// Testable variant: saves a snapshot reading compose from an explicit data directory.
#[cfg(test)]
fn save_snapshot_in(data_dir: &std::path::Path, project: &str) -> anyhow::Result<()> {
    let compose_path = compose::compose_output_path_in(data_dir, project)?;
    let compose_yml = std::fs::read_to_string(&compose_path).map_err(|e| {
        anyhow::anyhow!(
            "cannot read current compose file at {}: {}",
            compose_path.display(),
            e
        )
    })?;

    let dir = data_dir.join("snapshots").join(project);
    std::fs::create_dir_all(&dir)?;

    #[cfg(unix)]
    {
        secure_snapshot_dirs(&dir)?;
    }

    let snapshot = UpdateSnapshot {
        project: project.to_string(),
        compose_yml,
        plugin_manifests: vec![],
    };

    let path = snapshot_path_in(data_dir, project);
    let json = serde_json::to_string_pretty(&snapshot)?;
    let tmp_path = path.with_extension("json.tmp");
    std::fs::write(&tmp_path, &json)?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp_path, std::fs::Permissions::from_mode(0o600))?;
    }

    std::fs::rename(&tmp_path, &path)?;
    Ok(())
}

/// Testable variant: loads a snapshot from an explicit data directory.
#[cfg(test)]
fn load_snapshot_in(data_dir: &std::path::Path, project: &str) -> anyhow::Result<UpdateSnapshot> {
    let path = snapshot_path_in(data_dir, project);
    let data = std::fs::read_to_string(&path)
        .map_err(|e| anyhow::anyhow!("no snapshot found for project '{}': {}", project, e))?;
    let snapshot: UpdateSnapshot = serde_json::from_str(&data)?;
    Ok(snapshot)
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
        secure_snapshot_dirs(&dir)?;
    }

    let plugin_manifests = crate::plugin::list_installed_plugins().unwrap_or_else(|e| {
        log::warn!("Failed to list installed plugins for snapshot: {e}");
        Vec::new()
    });
    let snapshot = UpdateSnapshot {
        project: project.to_string(),
        compose_yml,
        plugin_manifests,
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

    // 2. Re-render compose.yml with current template (includes plugin image rebuild)
    let compose_yml = compose::render_compose(
        project,
        &project_dir,
        &resolved,
        &integrations,
        Some(runtime),
    )?;

    // 3a. OS prerequisite check
    let prereq_violations = crate::os_prereqs::check_os_prereqs();
    if !prereq_violations.is_empty() {
        let msgs: Vec<String> = prereq_violations.iter().map(|v| v.to_string()).collect();
        anyhow::bail!(
            "{} {}",
            crate::consts::SYSTEM_CHECK_FAILED_PREFIX,
            msgs.join("\n\n")
        );
    }

    // 3b. Fix host filesystem permissions before security gate
    crate::fs_security::ensure_data_dir_permissions(project)?;

    // 3c. Mandatory security gate — BEFORE saving anything
    let manifests = crate::plugin::list_installed_plugins().unwrap_or_else(|e| {
        log::warn!("Failed to list installed plugins for security check: {e}");
        Vec::new()
    });
    let expected_paths = compose::SecurityExpectedPaths::compute(project, &project_dir)?;
    let violations = SecurityCheck::run(&compose_yml, project, &manifests, &expected_paths);
    if !violations.is_empty() {
        let msgs: Vec<String> = violations
            .iter()
            .map(|v| format!("[{}] {} -- {}", v.container, v.rule, v.message))
            .collect();
        anyhow::bail!(
            "{}\n{}",
            crate::consts::SYSTEM_CHECK_FAILED_PREFIX,
            msgs.join("\n")
        );
    }

    // 4. Save snapshot of current compose.yml for rollback (AFTER security check)
    save_snapshot(project)?;

    // 5. Save new compose.yml
    compose::save_compose(project, &compose_yml)?;

    // 6. Rebuild images from local Containerfiles BEFORE stopping containers.
    //    If the build fails, containers keep running with the previous version.
    //    containerd uses content-addressable storage — new builds don't affect running containers.
    let new_manifest = bundle::load_current_bundle_manifest()?;
    let bundle_state = bundle::load_bundle_state();
    if let Some(old_id) = build::should_prune_bundle(
        bundle_state.applied_bundle_id.as_deref(),
        &new_manifest.bundle_id,
    ) {
        if let Err(e) = build::prune_old_bundle_images(runtime, old_id) {
            log::warn!("Failed to prune old bundle images: {e}");
        }
    }
    let images_rebuilt = build::build_all_images_for_bundle(runtime, &new_manifest.bundle_id)
        .map_err(|e| {
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

    // OS prerequisite check.
    // Note: intentionally NOT using SYSTEM_CHECK_FAILED_PREFIX here — rollback
    // is only triggered via CLI/Tauri update flow, not from the main Desktop
    // startup path. The "Rollback aborted" prefix makes the context clearer
    // than the generic "System check failed:" prefix.
    let prereq_violations = crate::os_prereqs::check_os_prereqs();
    if !prereq_violations.is_empty() {
        let msgs: Vec<String> = prereq_violations.iter().map(|v| v.to_string()).collect();
        anyhow::bail!(
            "Rollback aborted — OS prerequisites not met:\n{}",
            msgs.join("\n\n")
        );
    }

    // Fix host filesystem permissions before security gate.
    crate::fs_security::ensure_data_dir_permissions(project)?;

    // Security check on the snapshot compose.yml before applying.
    // Use manifests from the snapshot (live state may differ post-uninstall).
    let user_config = config::load_user_config()?;
    let project_dir = user_config.require_project(project)?.dir.clone();
    let expected_paths = compose::SecurityExpectedPaths::compute(project, &project_dir)?;
    let violations = SecurityCheck::run(
        &snapshot.compose_yml,
        project,
        &snapshot.plugin_manifests,
        &expected_paths,
    );
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
            plugin_manifests: vec![],
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

        let dir = tempfile::tempdir().unwrap();
        let project = "perms-test";

        let compose_path = compose::compose_output_path_in(dir.path(), project).unwrap();
        std::fs::create_dir_all(compose_path.parent().unwrap()).unwrap();
        std::fs::write(&compose_path, "version: '3'\nservices: {}\n").unwrap();

        save_snapshot_in(dir.path(), project).unwrap();

        let snap_path = snapshot_path_in(dir.path(), project);
        let perms = std::fs::metadata(&snap_path).unwrap().permissions();
        assert_eq!(
            perms.mode() & 0o777,
            0o600,
            "snapshot.json must be 0o600 after save_snapshot"
        );
    }

    #[test]
    fn test_snapshot_path_format() {
        let dir = tempfile::tempdir().unwrap();
        let path = snapshot_path_in(dir.path(), "my-project");
        assert!(path.starts_with(dir.path()));
        assert!(path.to_string_lossy().contains("snapshots"));
        assert!(path.to_string_lossy().contains("my-project"));
        assert!(path.to_string_lossy().ends_with("snapshot.json"));
    }

    #[test]
    fn test_snapshot_atomic_write_no_tmp_residue() {
        let dir = tempfile::tempdir().unwrap();
        let project = "atomic-write-test";

        // Set up the compose file that save_snapshot_in() will read
        let compose_path = compose::compose_output_path_in(dir.path(), project).unwrap();
        std::fs::create_dir_all(compose_path.parent().unwrap()).unwrap();
        std::fs::write(&compose_path, "version: '3'\nservices: {}\n").unwrap();

        save_snapshot_in(dir.path(), project).unwrap();

        // Verify no .json.tmp residue remains
        let snap_path = snapshot_path_in(dir.path(), project);
        let tmp_path = snap_path.with_extension("json.tmp");
        assert!(
            !tmp_path.exists(),
            ".json.tmp must not remain after atomic rename"
        );

        // Verify content was written correctly
        let loaded = load_snapshot_in(dir.path(), project).unwrap();
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
    fn test_rollback_with_empty_plugin_manifests_is_valid() {
        // Old snapshots may have empty plugin_manifests. Security check
        // should still pass if compose YAML has no plugin services.
        let snapshot = UpdateSnapshot {
            project: "test".to_string(),
            compose_yml: "version: '3'\nservices: {}\n".to_string(),
            plugin_manifests: vec![],
        };
        assert!(snapshot.plugin_manifests.is_empty());
        // With no services in compose YAML, security check passes trivially
        let tmp = tempfile::tempdir().unwrap();
        let violations = compose::SecurityCheck::run_with_data_dir(
            &snapshot.compose_yml,
            "test",
            &snapshot.plugin_manifests,
            &compose::SecurityExpectedPaths::from_raw("/test", "/test/tokens"),
            tmp.path(),
        );
        assert!(
            violations.is_empty(),
            "empty compose with empty manifests should produce no violations"
        );
    }

    #[test]
    fn test_update_checks_os_prereqs() {
        // Structural test: verify os_prereqs::check_os_prereqs() runs BEFORE
        // SecurityCheck in update_containers. Same approach as
        // test_build_before_compose_down_in_update_containers.
        let source = include_str!("update.rs");

        let fn_start = source
            .find("fn update_containers(")
            .expect("update_containers function must exist in update.rs");
        let fn_body = &source[fn_start..];

        let prereq_pos = fn_body
            .find("os_prereqs::check_os_prereqs()")
            .expect("os_prereqs::check_os_prereqs() call must exist in update_containers");
        let security_pos = fn_body
            .find("SecurityCheck::run(")
            .expect("SecurityCheck::run() call must exist in update_containers");

        assert!(
            prereq_pos < security_pos,
            "OS prerequisite check (at byte offset {prereq_pos}) must appear before \
             SecurityCheck::run (at byte offset {security_pos}) in update_containers",
        );
    }

    #[test]
    fn test_rollback_checks_os_prereqs() {
        // Structural test: verify os_prereqs::check_os_prereqs() runs BEFORE
        // SecurityCheck in rollback_containers.
        let source = include_str!("update.rs");

        let fn_start = source
            .find("fn rollback_containers(")
            .expect("rollback_containers function must exist in update.rs");
        let fn_body = &source[fn_start..];

        let prereq_pos = fn_body
            .find("os_prereqs::check_os_prereqs()")
            .expect("os_prereqs::check_os_prereqs() call must exist in rollback_containers");
        let security_pos = fn_body
            .find("SecurityCheck::run(")
            .expect("SecurityCheck::run() call must exist in rollback_containers");

        assert!(
            prereq_pos < security_pos,
            "OS prerequisite check (at byte offset {prereq_pos}) must appear before \
             SecurityCheck::run (at byte offset {security_pos}) in rollback_containers",
        );
    }

    #[test]
    fn test_update_calls_ensure_before_security_check() {
        // Structural test: ensure_data_dir_permissions must run BEFORE SecurityCheck::run
        // in update_containers. Behavioral coverage: see
        // fs_security::tests::test_ensure_roundtrip_fixes_then_check_passes
        let source = include_str!("update.rs");

        let fn_start = source
            .find("fn update_containers(")
            .expect("update_containers function must exist in update.rs");
        let fn_body = &source[fn_start..];

        let ensure_pos = fn_body
            .find("ensure_data_dir_permissions(")
            .expect("ensure_data_dir_permissions call must exist in update_containers");
        let security_pos = fn_body
            .find("SecurityCheck::run(")
            .expect("SecurityCheck::run() call must exist in update_containers");

        assert!(
            ensure_pos < security_pos,
            "ensure_data_dir_permissions (at byte offset {ensure_pos}) must appear before \
             SecurityCheck::run (at byte offset {security_pos}) in update_containers",
        );
    }

    #[test]
    fn test_rollback_calls_ensure_before_security_check() {
        // Structural test: ensure_data_dir_permissions must run BEFORE SecurityCheck::run
        // in rollback_containers. Behavioral coverage: see
        // fs_security::tests::test_ensure_roundtrip_fixes_then_check_passes
        let source = include_str!("update.rs");

        let fn_start = source
            .find("fn rollback_containers(")
            .expect("rollback_containers function must exist in update.rs");
        let fn_body = &source[fn_start..];

        let ensure_pos = fn_body
            .find("ensure_data_dir_permissions(")
            .expect("ensure_data_dir_permissions call must exist in rollback_containers");
        let security_pos = fn_body
            .find("SecurityCheck::run(")
            .expect("SecurityCheck::run() call must exist in rollback_containers");

        assert!(
            ensure_pos < security_pos,
            "ensure_data_dir_permissions (at byte offset {ensure_pos}) must appear before \
             SecurityCheck::run (at byte offset {security_pos}) in rollback_containers",
        );
    }

    #[cfg(unix)]
    #[test]
    fn save_snapshot_secures_parent_dir() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path();
        let original_mode = std::fs::metadata(data_dir).unwrap().permissions().mode() & 0o777;

        // Setup: create compose dir with a compose file (save_snapshot_in reads it)
        let compose_dir = data_dir.join("compose").join("proj");
        std::fs::create_dir_all(&compose_dir).unwrap();
        std::fs::write(compose_dir.join("compose.yml"), "version: '3'").unwrap();

        save_snapshot_in(data_dir, "proj").unwrap();

        assert_eq!(
            std::fs::metadata(data_dir.join("snapshots/proj"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700,
            "snapshots/proj should be 0o700"
        );
        assert_eq!(
            std::fs::metadata(data_dir.join("snapshots"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700,
            "snapshots should be 0o700"
        );
        assert_eq!(
            std::fs::metadata(data_dir).unwrap().permissions().mode() & 0o777,
            original_mode,
            "data_dir should not have been changed"
        );
    }

    #[test]
    fn test_save_snapshot_sets_parent_permissions() {
        // Structural test: verify save_snapshot() (production, not _in) delegates
        // to secure_snapshot_dirs. Protects against accidental removal of the
        // permission-setting call.
        let source = include_str!("update.rs");

        // Find the production save_snapshot function (not save_snapshot_in)
        let fn_start = source
            .find("pub fn save_snapshot(")
            .expect("save_snapshot function must exist in update.rs");
        // Limit scope to just this function (up to the next pub fn)
        let fn_body = &source[fn_start..];
        let fn_end = fn_body[1..]
            .find("\npub fn ")
            .or_else(|| fn_body[1..].find("\nfn "))
            .unwrap_or(fn_body.len());
        let fn_body = &fn_body[..fn_end];

        assert!(
            fn_body.contains("secure_snapshot_dirs"),
            "save_snapshot must call secure_snapshot_dirs to set permissions on dir and parent"
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

    #[test]
    fn test_prune_before_build_in_update_containers() {
        // Structural test: prune_old_bundle_images must appear BEFORE build_all_images
        // inside update_containers — pruning first means old images are removed before
        // new ones are built, with no risk of removing newly-built images.
        let source = include_str!("update.rs");

        let fn_start = source
            .find("fn update_containers(")
            .expect("update_containers function must exist in update.rs");
        let fn_body = &source[fn_start..];

        let prune_pos = fn_body
            .find("prune_old_bundle_images")
            .expect("prune_old_bundle_images call must exist in update_containers");
        let build_pos = fn_body
            .find("build::build_all_images")
            .expect("build_all_images call must exist in update_containers");

        assert!(
            prune_pos < build_pos,
            "prune_old_bundle_images (at byte {prune_pos}) must appear before \
             build_all_images (at byte {build_pos}) in update_containers"
        );
    }

    #[test]
    fn test_render_compose_called_with_runtime_in_update_containers() {
        // Structural test: render_compose in update_containers must pass Some(runtime),
        // not None — this ensures plugin images are checked/rebuilt during CLI updates.
        //
        // A behavioral test is not feasible here because render_compose, build_all_images,
        // and config::load_user_config are all free functions (not trait methods), making
        // mocking prohibitively complex. The source-text test is the established pattern
        // in this file — see test_build_before_compose_down_in_update_containers.
        let source = include_str!("update.rs");

        let fn_start = source
            .find("fn update_containers(")
            .expect("update_containers function must exist in update.rs");
        let fn_body = &source[fn_start..];

        // Find the render_compose call site
        let render_pos = fn_body
            .find("render_compose(")
            .expect("render_compose call must exist in update_containers");
        let render_call = &fn_body[render_pos..render_pos + 300];

        // Must NOT pass None as the last argument
        assert!(
            !render_call.contains("None)?"),
            "render_compose in update_containers must NOT pass None for runtime — \
             plugin images won't be rebuilt during CLI updates: {render_call}"
        );

        // Must pass Some(runtime)
        assert!(
            render_call.contains("Some(runtime)"),
            "render_compose in update_containers must pass Some(runtime) so that \
             plugin images are rebuilt if missing: {render_call}"
        );
    }

    #[test]
    fn test_update_containers_plugin_rebuild_via_render_compose() {
        // Cross-file structural test: verifies the full path
        // update_containers → render_compose(Some(runtime)) → ensure_plugin_images.
        //
        // update_containers passes Some(runtime) to render_compose (verified by
        // test_render_compose_called_with_runtime_in_update_containers). Here we
        // verify that render_compose's body calls ensure_plugin_images, completing
        // the behavioral chain.
        //
        // This cross-file test is justified because update_containers depends on
        // free functions (render_compose, build_all_images, load_user_config) that
        // cannot be mocked without major test infrastructure — the same reasoning
        // documented in test_build_before_compose_down_in_update_containers.
        let compose_source = include_str!("compose.rs");

        let fn_start = compose_source
            .find("pub fn render_compose(")
            .expect("render_compose function must exist in compose.rs");
        let fn_body = &compose_source[fn_start..];

        assert!(
            fn_body.contains("ensure_plugin_images"),
            "render_compose must call ensure_plugin_images — the plugin rebuild chain \
             from update_containers depends on this"
        );
    }
}
