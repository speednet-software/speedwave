//! Self-update flow: download, verify, swap, and rollback of the app bundle.

use crate::build;
use crate::bundle;
use crate::compose::{self, SecurityCheck};
use crate::config;
use crate::consts;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Pre-update snapshot used to roll back a project on failure.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct UpdateSnapshot {
    /// Project the snapshot belongs to.
    pub project: String,
    /// The compose file at snapshot time.
    pub compose_yml: String,
    /// Plugin manifests enabled at snapshot time.
    #[serde(default)]
    pub plugin_manifests: Vec<crate::plugin::PluginManifest>,
}

/// Marker attached to an update failure that occurred AFTER `compose_down` tore
/// the project's containers down — the project now has no running containers and
/// a rollback is warranted. Early failures (prereq/security/build/render, before
/// `compose_down`) leave the old containers running and must NOT trigger a
/// rollback. Detect with `err.downcast_ref::<ContainersTornDown>()`.
#[derive(Debug, Clone, Copy)]
pub struct ContainersTornDown;

impl std::fmt::Display for ContainersTornDown {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "containers were torn down before the failure")
    }
}

impl std::error::Error for ContainersTornDown {}

/// Outcome of a container update for one project.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ContainerUpdateResult {
    /// Whether the update succeeded.
    pub success: bool,
    /// Number of images rebuilt.
    pub images_rebuilt: u32,
    /// Number of containers recreated.
    pub containers_recreated: u32,
    /// Error message if the update failed.
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
    let compose_yml = match std::fs::read_to_string(&compose_path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            log::warn!(
                "save_snapshot: no compose.yml at {} — rollback will be unavailable",
                compose_path.display()
            );
            return Ok(());
        }
        Err(e) => {
            return Err(anyhow::anyhow!(
                "cannot read current compose file at {}: {}",
                compose_path.display(),
                e
            ));
        }
    };

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
    // Durable atomic write (fsync data + parent dir, 0o600).
    crate::fs_perms::write_restricted_file_atomic(&path, &json)?;
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

/// Saves a rollback snapshot of the project's compose state.
pub fn save_snapshot(project: &str) -> anyhow::Result<()> {
    let compose_path = compose::compose_output_path(project)?;
    let compose_yml = match std::fs::read_to_string(&compose_path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // First-time restart: no compose.yml yet, proceed without a snapshot.
            log::warn!(
                "save_snapshot: no compose.yml at {} — rollback will be unavailable for this restart",
                compose_path.display()
            );
            return Ok(());
        }
        Err(e) => {
            return Err(anyhow::anyhow!(
                "cannot read current compose file at {}: {}",
                compose_path.display(),
                e
            ));
        }
    };

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
    // Durable atomic write: fsync data + parent dir, owner-only (0o600).
    crate::fs_perms::write_restricted_file_atomic(&path, &json)?;

    Ok(())
}

fn load_snapshot(project: &str) -> anyhow::Result<UpdateSnapshot> {
    let path = snapshot_path(project)?;
    let data = std::fs::read_to_string(&path)
        .map_err(|e| anyhow::anyhow!("no snapshot found for project '{}': {}", project, e))?;
    let snapshot: UpdateSnapshot = serde_json::from_str(&data)?;
    Ok(snapshot)
}

/// `true` when any configured project OTHER than `target` has running
/// containers — their live resource mounts forbid the dir swap.
fn other_projects_running(runtime: &crate::runtime::LockedRuntime, target: &str) -> bool {
    let Ok(cfg) = crate::config::load_user_config() else {
        return false;
    };
    cfg.projects.iter().filter(|p| p.name != target).any(|p| {
        runtime
            .compose_ps(&p.name)
            .map(|c| !c.is_empty())
            .unwrap_or(false)
    })
}

/// Prunes superseded per-image tags (+ legacy single-id tags on migration).
/// Callers MUST invoke only after new containers are confirmed running (atomicity).
#[cfg(any(test, feature = "test-support"))]
pub fn maybe_prune_previous_bundle(
    runtime: &crate::runtime::LockedRuntime,
    state: &bundle::BundleState,
    manifest: &bundle::BundleManifest,
) {
    maybe_prune_previous_bundle_inner(runtime, state, manifest);
}

#[cfg(not(any(test, feature = "test-support")))]
fn maybe_prune_previous_bundle(
    runtime: &crate::runtime::LockedRuntime,
    state: &bundle::BundleState,
    manifest: &bundle::BundleManifest,
) {
    maybe_prune_previous_bundle_inner(runtime, state, manifest);
}

fn maybe_prune_previous_bundle_inner(
    runtime: &crate::runtime::LockedRuntime,
    state: &bundle::BundleState,
    manifest: &bundle::BundleManifest,
) {
    build::prune_superseded_images(
        runtime,
        &state.applied_image_hashes,
        state.applied_bundle_id.as_deref(),
        manifest,
    );
}

// ---------------------------------------------------------------------------
// Update / rollback
// ---------------------------------------------------------------------------

/// Compose mutation core. Caller MUST build images before calling —
/// builds run outside the lock (90+ s would block concurrent sessions).
/// See ADR-066.
#[cfg(any(test, feature = "test-support"))]
pub fn apply_update_transaction(
    runtime: &crate::runtime::LockedRuntime,
    project: &str,
    compose_yml: &str,
) -> anyhow::Result<()> {
    apply_update_transaction_inner(runtime, project, compose_yml)
}

#[cfg(not(any(test, feature = "test-support")))]
fn apply_update_transaction(
    runtime: &crate::runtime::LockedRuntime,
    project: &str,
    compose_yml: &str,
) -> anyhow::Result<()> {
    apply_update_transaction_inner(runtime, project, compose_yml)
}

fn apply_update_transaction_inner(
    runtime: &crate::runtime::LockedRuntime,
    project: &str,
    compose_yml: &str,
) -> anyhow::Result<()> {
    runtime.transaction(project, |runtime| -> anyhow::Result<()> {
        save_snapshot(project)?;
        compose::save_compose(project, compose_yml)?;
        runtime.compose_down(project)?;
        // Past this point the project's containers are down; any failure must
        // carry the ContainersTornDown marker so the caller knows to roll back.
        crate::runtime::compose_validate_with_retry(runtime, project)
            .map_err(|e| e.context(ContainersTornDown))?;
        runtime
            .compose_up_recreate(project)
            .map_err(|e| e.context(ContainersTornDown))?;
        Ok(())
    })
}

/// Mutation core of `rollback_containers`. Restores snapshot YAML and
/// recreates containers under the per-project compose lock.
#[cfg(any(test, feature = "test-support"))]
pub fn apply_rollback_transaction(
    runtime: &crate::runtime::LockedRuntime,
    project: &str,
    snapshot_yml: &str,
) -> anyhow::Result<()> {
    apply_rollback_transaction_inner(runtime, project, snapshot_yml)
}

#[cfg(not(any(test, feature = "test-support")))]
fn apply_rollback_transaction(
    runtime: &crate::runtime::LockedRuntime,
    project: &str,
    snapshot_yml: &str,
) -> anyhow::Result<()> {
    apply_rollback_transaction_inner(runtime, project, snapshot_yml)
}

fn apply_rollback_transaction_inner(
    runtime: &crate::runtime::LockedRuntime,
    project: &str,
    snapshot_yml: &str,
) -> anyhow::Result<()> {
    runtime.transaction(project, |runtime| -> anyhow::Result<()> {
        // No VM-side validate on rollback — virtiofs lag would block recovery (ADR-066).
        compose::save_compose(project, snapshot_yml)?;
        runtime.compose_up_recreate(project).map_err(|e| {
            anyhow::anyhow!(
                "Rollback failed: {}. Old compose.yml was restored. Run `speedwave` to start containers manually.",
                e
            )
        })?;
        Ok(())
    })
}

/// Rebuilds images and recreates containers for a project.
pub fn update_containers(
    runtime: &crate::runtime::LockedRuntime,
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
    // Reconstruct host-bridge env from disk (ADR-074).
    let host_bridges = compose::host_bridges_from_disk();
    let compose_yml = compose::render_compose(
        project,
        &project_dir,
        &resolved,
        &integrations,
        Some(runtime),
        &host_bridges,
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

    let new_manifest = bundle::load_current_bundle_manifest()?;
    let bundle_state = bundle::load_bundle_state();

    // Build OUTSIDE the compose lock (ADR-066), missing-only per image (ADR-072).
    let images_rebuilt = build::build_missing_images_locked(
        runtime,
        &build::enabled_images(&integrations),
        &new_manifest,
    )
    .map_err(|e| {
        anyhow::anyhow!(
            "Image rebuild failed: {e}. Containers are still running with the previous version."
        )
    })?;

    // Sync claude-resources after the build, before recreate; skip if another project runs.
    if other_projects_running(runtime, project) {
        log::warn!(
            "claude-resources sync skipped: another project is running; \
             open Speedwave Desktop to finish applying the update"
        );
    } else {
        let build_root = build::resolve_build_root()?;
        bundle::sync_claude_resources(&build_root)
            .map_err(|e| anyhow::anyhow!("claude-resources sync failed: {e}"))?;
    }

    apply_update_transaction(runtime, project, &compose_yml)?;

    // 9. Wait for containers to stabilize before health check.
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

    maybe_prune_previous_bundle(runtime, &bundle_state, &new_manifest);

    Ok(ContainerUpdateResult {
        success: true,
        images_rebuilt,
        containers_recreated: running,
        error: None,
    })
}

/// Restores a project from its rollback snapshot.
pub fn rollback_containers(
    runtime: &crate::runtime::LockedRuntime,
    project: &str,
) -> anyhow::Result<()> {
    validate_project_name(project)?;

    let snapshot = load_snapshot(project)?;

    // OS prerequisite check (uses a "Rollback aborted" prefix, not SYSTEM_CHECK_FAILED_PREFIX).
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

    apply_rollback_transaction(runtime, project, &snapshot.compose_yml)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn cli_update_syncs_resources_after_build_before_recreate() {
        let source = include_str!("update.rs");
        let build_pos = source
            .find("build_missing_images_locked(")
            .expect("update must build images");
        let sync_pos = source
            .find("sync_claude_resources(&build_root)")
            .expect("CLI update must sync claude-resources");
        let guard_pos = source
            .find("other_projects_running(runtime, project)")
            .expect("sync must be guarded against other running projects");
        assert!(
            guard_pos < sync_pos,
            "live-mount guard must precede the resources swap"
        );
        let txn_pos = source
            .find("apply_update_transaction(runtime, project, &compose_yml)")
            .expect("update transaction must exist");
        assert!(
            build_pos < sync_pos && sync_pos < txn_pos,
            "sync must land after the build and before the recreate"
        );
    }

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

    #[test]
    fn save_snapshot_returns_ok_when_compose_missing() {
        let dir = tempfile::tempdir().unwrap();
        let project = "no-compose-yet";
        // Intentionally no compose.yml written.
        let result = save_snapshot_in(dir.path(), project);
        assert!(
            result.is_ok(),
            "missing compose.yml must be tolerated (first-time integration enable)"
        );
        let snap_path = snapshot_path_in(dir.path(), project);
        assert!(
            !snap_path.exists(),
            "no snapshot file should be written when there is no compose.yml"
        );
    }

    #[cfg(unix)]
    #[test]
    fn save_snapshot_propagates_non_notfound_io_errors() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let project = "perm-denied";

        let compose_path = compose::compose_output_path_in(dir.path(), project).unwrap();
        std::fs::create_dir_all(compose_path.parent().unwrap()).unwrap();
        std::fs::write(&compose_path, "version: '3'\nservices: {}\n").unwrap();
        // Strip all permissions from the file so read fails with PermissionDenied (not NotFound).
        std::fs::set_permissions(&compose_path, std::fs::Permissions::from_mode(0o000)).unwrap();

        let result = save_snapshot_in(dir.path(), project);

        // Restore perms before asserting so tempdir can clean up.
        let _ = std::fs::set_permissions(&compose_path, std::fs::Permissions::from_mode(0o644));

        assert!(
            result.is_err(),
            "permission-denied on compose.yml must bubble up as a hard error"
        );
        let err_msg = format!("{}", result.unwrap_err());
        assert!(
            !err_msg.contains("rollback will be unavailable"),
            "real IO errors must NOT be silently treated as 'no snapshot needed'"
        );
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

    // Behavioural tests for apply_update_transaction / apply_rollback_transaction live in tests/apply_transaction_behaviour.rs.

    #[test]
    fn test_rollback_with_empty_plugin_manifests_is_valid() {
        // Old snapshots may have empty plugin_manifests; security check still passes with no plugin services.
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
        // Structural test: check_os_prereqs() must run before SecurityCheck in update_containers.
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
        // Structural test: check_os_prereqs() must run before SecurityCheck in rollback_containers.
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
        // Structural test: ensure_data_dir_permissions must run before SecurityCheck::run in update_containers.
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
        // Structural test: ensure_data_dir_permissions must run before SecurityCheck::run in rollback_containers.
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
        // Structural test: save_snapshot() (production, not _in) must delegate to secure_snapshot_dirs.
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
    fn test_snapshot_writers_use_durable_helper() {
        // Both snapshot writers must use write_restricted_file_atomic, not bare fs::write+rename.
        let source = include_str!("update.rs");
        for func in ["fn save_snapshot(", "fn save_snapshot_in("] {
            let start = source
                .find(func)
                .unwrap_or_else(|| panic!("{func} must exist"));
            let body = &source[start..];
            // Slice to the next column-0 fn (not attributes) so inner #[cfg(unix)] blocks stay in the body.
            let end = ["\npub fn ", "\nfn "]
                .iter()
                .filter_map(|marker| body[1..].find(marker).map(|i| i + 1))
                .min()
                .unwrap_or(body.len());
            let body = &body[..end];
            assert!(
                body.contains("write_restricted_file_atomic"),
                "{func} must use the durable write_restricted_file_atomic helper"
            );
            assert!(
                !body.contains("std::fs::rename("),
                "{func} must not hand-roll write+rename (use the durable helper)"
            );
        }
    }

    // SSOT guard: asserts CONTAINER_STABILIZATION_DELAY_SECS stays sane.
    #[allow(clippy::assertions_on_constants)]
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

    // Behavioural prune coverage: tests/apply_transaction_behaviour.rs.

    #[test]
    fn test_render_compose_called_with_runtime_in_update_containers() {
        // Structural test: render_compose in update_containers must pass Some(runtime), not None.
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
    fn test_update_containers_reconstructs_host_bridges() {
        // Structural guard (ADR-074): update must feed disk-reconstructed host bridges into render_compose.
        let source = include_str!("update.rs");
        let fn_start = source
            .find("fn update_containers(")
            .expect("update_containers function must exist in update.rs");
        let fn_body = &source[fn_start..];

        let build_pos = fn_body.find("host_bridges_from_disk()");
        let render_pos = fn_body
            .find("render_compose(")
            .expect("render_compose call must exist in update_containers");
        assert!(
            build_pos.is_some_and(|b| b < render_pos),
            "update_containers must build host_bridges_from_disk() before render_compose"
        );
        let empty_default = format!("HostBridgesInfo::{}()", "default");
        assert!(
            !fn_body[..render_pos].contains(&empty_default),
            "update_containers must not pass an empty HostBridgesInfo to render_compose"
        );
        // Also assert the call site actually receives &host_bridges as its argument.
        let call = &fn_body[render_pos..];
        let call_end = call
            .find(';')
            .expect("render_compose statement must end with ;");
        assert!(
            call[..call_end].contains("&host_bridges"),
            "render_compose must receive &host_bridges, not an inline default"
        );
    }

    #[test]
    fn test_update_containers_plugin_rebuild_via_render_compose() {
        // Cross-file structural test: render_compose's body must call ensure_plugin_images.
        let compose_source = include_str!("compose/mod.rs");

        let fn_start = compose_source
            .find("pub fn render_compose(")
            .expect("render_compose function must exist in the compose module");
        let fn_body = &compose_source[fn_start..];

        assert!(
            fn_body.contains("ensure_plugin_images"),
            "render_compose must call ensure_plugin_images — the plugin rebuild chain \
             from update_containers depends on this"
        );
    }

    #[test]
    fn test_no_buildkit_prune_in_routine_prune_paths() {
        // Structural test (ADR-072): prune_buildkit_cache must not be called in the routine prune paths.
        let source = include_str!("build.rs");

        for fn_name in [
            "fn prune_old_bundle_images(",
            "fn prune_replaced_images(",
            "fn prune_orphan_current_bundle_images(",
        ] {
            let fn_start = source
                .find(fn_name)
                .unwrap_or_else(|| panic!("{fn_name} must exist in build.rs"));
            let fn_body = &source[fn_start..];
            let fn_end = fn_body[1..]
                .find("\npub fn ")
                .or_else(|| fn_body[1..].find("\nfn "))
                .unwrap_or(fn_body.len());
            let fn_body = &fn_body[..fn_end];

            assert!(
                !fn_body.contains("prune_buildkit_cache"),
                "{fn_name} must not prune the BuildKit cache (routine prune path)"
            );
        }
    }

    #[test]
    fn update_containers_never_writes_bundle_state() {
        // ADR-072 single-writer rule: only Desktop persists bundle state; the CLI only reads it.
        let source = include_str!("update.rs");
        // Split literal so this assertion line isn't itself a match.
        let needle = format!("{}{}", "save_", "bundle_state");
        assert!(
            !source.contains(&needle),
            "update.rs must not persist bundle state (CLI is a non-writer)"
        );
    }
}
