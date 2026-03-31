//! Host filesystem permission auto-fix for security-sensitive paths.
//!
//! Called before `SecurityCheck::run()` on all container start paths (CLI,
//! Desktop, update, rollback) to silently fix incorrect mode bits.
//! `speedwave check` does NOT call autofix — it reports violations only.

use crate::consts;

/// Fixes permissions on existing security-sensitive paths under the default
/// data directory (`~/.speedwave/`).
///
/// Directories are set to `0o700`, files to `0o600`. Missing paths and
/// symlinks are silently skipped. Idempotent — safe to call on every startup.
///
/// On non-Unix platforms this is a no-op.
pub fn ensure_data_dir_permissions(project: &str) -> anyhow::Result<()> {
    ensure_data_dir_permissions_in(consts::data_dir(), project)
}

/// Testable version accepting an explicit data directory.
#[cfg(unix)]
pub(crate) fn ensure_data_dir_permissions_in(
    data_dir: &std::path::Path,
    project: &str,
) -> anyhow::Result<()> {
    use anyhow::Context;
    use std::os::unix::fs::PermissionsExt;

    let (dirs, files) = collect_security_paths(data_dir, project);
    let mut fixed = 0u32;

    for dir in &dirs {
        match std::fs::symlink_metadata(dir) {
            Ok(meta) if meta.file_type().is_symlink() => continue,
            Ok(meta) => {
                let mode = meta.permissions().mode() & 0o777;
                if mode != 0o700 {
                    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
                        .with_context(|| {
                            format!("failed to fix permissions on {}", dir.display())
                        })?;
                    log::warn!(
                        "fixed directory permissions on {}: {:#05o} -> 0o700",
                        dir.display(),
                        mode
                    );
                    fixed += 1;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => {
                log::warn!(
                    "ensure_data_dir_permissions: cannot read {}: {e}",
                    dir.display()
                );
                continue;
            }
        }
    }

    for file in &files {
        match std::fs::symlink_metadata(file) {
            Ok(meta) if meta.file_type().is_symlink() => continue,
            Ok(meta) => {
                let mode = meta.permissions().mode() & 0o777;
                if mode != 0o600 {
                    std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o600))
                        .with_context(|| {
                            format!("failed to fix permissions on {}", file.display())
                        })?;
                    log::warn!(
                        "fixed file permissions on {}: {:#05o} -> 0o600",
                        file.display(),
                        mode
                    );
                    fixed += 1;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => {
                log::warn!(
                    "ensure_data_dir_permissions: cannot read {}: {e}",
                    file.display()
                );
                continue;
            }
        }
    }

    if fixed == 0 {
        log::info!("data dir permissions verified");
    }

    Ok(())
}

/// No-op on non-Unix platforms.
#[cfg(not(unix))]
pub(crate) fn ensure_data_dir_permissions_in(
    _data_dir: &std::path::Path,
    _project: &str,
) -> anyhow::Result<()> {
    log::debug!("file permission autofix skipped (non-Unix)");
    Ok(())
}

/// Enumerates security-sensitive paths under `data_dir` for a project.
///
/// Returns `(dirs, files)` where:
/// - `dirs` must have mode `0o700` (owner rwx only)
/// - `files` must have mode `0o600` (owner rw only)
///
/// Used by both `ensure_data_dir_permissions_in()` (to fix) and
/// `SecurityCheck::check_file_security_with_uid()` (to validate).
#[cfg(unix)]
pub(crate) fn collect_security_paths(
    data_dir: &std::path::Path,
    project: &str,
) -> (Vec<std::path::PathBuf>, Vec<std::path::PathBuf>) {
    let mut dirs: Vec<std::path::PathBuf> = vec![
        // Top-level directories (prevent project name enumeration)
        data_dir.join("secrets"),
        data_dir.join("snapshots"),
        data_dir.join("tokens"),
        // Per-project directories
        data_dir.join("secrets").join(project),
        data_dir.join("snapshots").join(project),
        data_dir.join("ide-bridge"),
        data_dir.join("tokens").join(project),
    ];

    let mut files: Vec<std::path::PathBuf> = Vec::new();

    // --- tokens/<project>/<service>/ subdirectories ---
    // Single read_dir pass collects both directory paths (for 0o700)
    // and credential file paths (for 0o600).
    let tokens_project_dir = data_dir.join("tokens").join(project);
    if let Ok(services) = std::fs::read_dir(&tokens_project_dir) {
        for entry in services.flatten() {
            if let Ok(ft) = entry.file_type() {
                if ft.is_dir() {
                    dirs.push(entry.path());
                    if let Ok(inner_files) = std::fs::read_dir(entry.path()) {
                        for file_entry in inner_files.flatten() {
                            if let Ok(fft) = file_entry.file_type() {
                                if fft.is_file() {
                                    files.push(file_entry.path());
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // --- Root-level files ---
    files.push(data_dir.join("bundle-state.json"));

    // --- secrets/<project>/* (worker auth tokens) ---
    let secrets_dir = data_dir.join("secrets").join(project);
    if let Ok(entries) = std::fs::read_dir(&secrets_dir) {
        for entry in entries.flatten() {
            if let Ok(ft) = entry.file_type() {
                if ft.is_file() {
                    files.push(entry.path());
                }
            }
        }
    }

    // --- snapshots/<project>/*.json ---
    let snapshots_dir = data_dir.join("snapshots").join(project);
    if let Ok(entries) = std::fs::read_dir(&snapshots_dir) {
        for entry in entries.flatten() {
            if let Ok(ft) = entry.file_type() {
                if ft.is_file() {
                    files.push(entry.path());
                }
            }
        }
    }

    // --- ide-bridge/*.lock (IDE auth tokens) ---
    let ide_dir = data_dir.join("ide-bridge");
    if let Ok(entries) = std::fs::read_dir(&ide_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if let Ok(ft) = entry.file_type() {
                if ft.is_file() && path.extension().is_some_and(|e| e == "lock") {
                    files.push(path);
                }
            }
        }
    }

    (dirs, files)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[cfg(unix)]
    fn secure_mkdir(path: &std::path::Path) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::create_dir_all(path).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
    }

    #[cfg(unix)]
    fn get_mode(path: &std::path::Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    /// Creates a fully populated data dir tree for testing.
    #[cfg(unix)]
    fn create_test_tree(data_dir: &std::path::Path, correct_perms: bool) {
        let dir_mode = if correct_perms { 0o700 } else { 0o755 };
        let file_mode = if correct_perms { 0o600 } else { 0o644 };

        use std::os::unix::fs::PermissionsExt;

        let dirs_to_create = [
            data_dir.join("secrets"),
            data_dir.join("secrets/proj"),
            data_dir.join("snapshots"),
            data_dir.join("snapshots/proj"),
            data_dir.join("tokens"),
            data_dir.join("tokens/proj"),
            data_dir.join("tokens/proj/slack"),
            data_dir.join("tokens/proj/gitlab"),
            data_dir.join("tokens/proj/empty-service"),
            data_dir.join("ide-bridge"),
        ];
        for dir in &dirs_to_create {
            std::fs::create_dir_all(dir).unwrap();
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(dir_mode)).unwrap();
        }

        let files_to_create = [
            data_dir.join("secrets/proj/worker-auth-token"),
            data_dir.join("tokens/proj/slack/token.txt"),
            data_dir.join("tokens/proj/gitlab/key.txt"),
            data_dir.join("snapshots/proj/snapshot.json"),
            data_dir.join("ide-bridge/1234.lock"),
            data_dir.join("bundle-state.json"),
        ];
        for file in &files_to_create {
            std::fs::write(file, "test").unwrap();
            std::fs::set_permissions(file, std::fs::Permissions::from_mode(file_mode)).unwrap();
        }
    }

    // ── collect_security_paths ─────────────────────────────────────────

    #[cfg(unix)]
    #[test]
    fn test_collect_security_paths_returns_correct_paths() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path();
        create_test_tree(data_dir, true);

        // Also create a non-.lock file in ide-bridge (should NOT be in files)
        std::fs::write(data_dir.join("ide-bridge/not-a-lock.txt"), "test").unwrap();

        let (dirs, files) = collect_security_paths(data_dir, "proj");

        // Expected dirs (10): secrets, secrets/proj, snapshots, snapshots/proj,
        // tokens, tokens/proj, tokens/proj/slack, tokens/proj/gitlab,
        // tokens/proj/empty-service, ide-bridge
        assert_eq!(dirs.len(), 10, "expected 10 dirs, got: {dirs:?}");
        assert!(dirs.contains(&data_dir.join("secrets")));
        assert!(dirs.contains(&data_dir.join("secrets/proj")));
        assert!(dirs.contains(&data_dir.join("snapshots")));
        assert!(dirs.contains(&data_dir.join("snapshots/proj")));
        assert!(dirs.contains(&data_dir.join("tokens")));
        assert!(dirs.contains(&data_dir.join("tokens/proj")));
        assert!(dirs.contains(&data_dir.join("tokens/proj/slack")));
        assert!(dirs.contains(&data_dir.join("tokens/proj/gitlab")));
        assert!(dirs.contains(&data_dir.join("tokens/proj/empty-service")));
        assert!(dirs.contains(&data_dir.join("ide-bridge")));

        // Expected files (6): secrets/proj/worker-auth-token,
        // tokens/proj/slack/token.txt, tokens/proj/gitlab/key.txt,
        // snapshots/proj/snapshot.json, ide-bridge/1234.lock, bundle-state.json
        assert_eq!(files.len(), 6, "expected 6 files, got: {files:?}");
        assert!(files.contains(&data_dir.join("secrets/proj/worker-auth-token")));
        assert!(files.contains(&data_dir.join("tokens/proj/slack/token.txt")));
        assert!(files.contains(&data_dir.join("tokens/proj/gitlab/key.txt")));
        assert!(files.contains(&data_dir.join("snapshots/proj/snapshot.json")));
        assert!(files.contains(&data_dir.join("ide-bridge/1234.lock")));
        assert!(files.contains(&data_dir.join("bundle-state.json")));

        // non-.lock file must NOT be included
        assert!(
            !files.contains(&data_dir.join("ide-bridge/not-a-lock.txt")),
            "ide-bridge/not-a-lock.txt should not be in files list"
        );
    }

    // ── ensure_data_dir_permissions_in ─────────────────────────────────

    #[cfg(unix)]
    #[test]
    fn test_ensure_correct_permissions_noop() {
        use std::os::unix::fs::MetadataExt as _;

        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path();
        create_test_tree(data_dir, true);

        ensure_data_dir_permissions_in(data_dir, "proj").unwrap();

        // All dirs still 0o700, all files still 0o600
        assert_eq!(get_mode(&data_dir.join("secrets")), 0o700);
        assert_eq!(get_mode(&data_dir.join("tokens/proj/slack")), 0o700);
        assert_eq!(get_mode(&data_dir.join("bundle-state.json")), 0o600);

        // SecurityCheck should also pass
        let uid = std::fs::metadata(data_dir).unwrap().uid();
        let violations =
            crate::compose::SecurityCheck::check_file_security_with_uid(data_dir, "proj", uid);
        assert!(
            violations.is_empty(),
            "SecurityCheck should pass for correct permissions, got: {violations:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn test_ensure_fixes_wrong_permissions() {
        use std::os::unix::fs::MetadataExt as _;

        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path();
        create_test_tree(data_dir, false); // 0o755 dirs, 0o644 files

        ensure_data_dir_permissions_in(data_dir, "proj").unwrap();

        // All dirs fixed to 0o700
        assert_eq!(get_mode(&data_dir.join("secrets")), 0o700);
        assert_eq!(get_mode(&data_dir.join("snapshots")), 0o700);
        assert_eq!(get_mode(&data_dir.join("tokens")), 0o700);
        assert_eq!(get_mode(&data_dir.join("tokens/proj")), 0o700);
        assert_eq!(get_mode(&data_dir.join("tokens/proj/slack")), 0o700);
        assert_eq!(get_mode(&data_dir.join("tokens/proj/gitlab")), 0o700);
        assert_eq!(get_mode(&data_dir.join("tokens/proj/empty-service")), 0o700);
        assert_eq!(get_mode(&data_dir.join("ide-bridge")), 0o700);

        // All files fixed to 0o600
        assert_eq!(
            get_mode(&data_dir.join("secrets/proj/worker-auth-token")),
            0o600
        );
        assert_eq!(get_mode(&data_dir.join("tokens/proj/slack/token.txt")), 0o600);
        assert_eq!(get_mode(&data_dir.join("bundle-state.json")), 0o600);
        assert_eq!(
            get_mode(&data_dir.join("snapshots/proj/snapshot.json")),
            0o600
        );
        assert_eq!(get_mode(&data_dir.join("ide-bridge/1234.lock")), 0o600);

        // Verify SecurityCheck passes after autofix
        let violations = crate::compose::SecurityCheck::check_file_security_with_uid(
            data_dir,
            "proj",
            std::fs::metadata(data_dir).unwrap().uid(),
        );
        assert!(
            violations.is_empty(),
            "SecurityCheck should pass after autofix, got: {violations:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn test_ensure_missing_paths_ok() {
        let tmp = tempfile::tempdir().unwrap();
        // Empty data_dir — no subdirs exist
        ensure_data_dir_permissions_in(tmp.path(), "proj").unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn test_ensure_skips_symlinks_at_top_level() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path();

        // Create a real target dir and symlink secrets/ to it
        let real_dir = data_dir.join("real-secrets");
        std::fs::create_dir_all(&real_dir).unwrap();
        std::os::unix::fs::symlink(&real_dir, data_dir.join("secrets")).unwrap();

        ensure_data_dir_permissions_in(data_dir, "proj").unwrap();

        // Symlink target should NOT have been changed
        assert_ne!(
            get_mode(&real_dir),
            0o700,
            "symlink target should not have been changed to 0o700"
        );
    }

    #[cfg(unix)]
    #[test]
    fn test_ensure_skips_symlinks_inside_token_dir() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path();

        // Create token dir structure
        let real_service = data_dir.join("tokens/proj/real-service");
        secure_mkdir(&data_dir.join("tokens"));
        secure_mkdir(&data_dir.join("tokens/proj"));
        std::fs::create_dir_all(&real_service).unwrap();
        std::fs::set_permissions(&real_service, std::fs::Permissions::from_mode(0o755)).unwrap();

        // Create external target and symlink a service dir to it
        let external = tmp.path().join("external-target");
        std::fs::create_dir_all(&external).unwrap();
        std::fs::set_permissions(&external, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::os::unix::fs::symlink(&external, data_dir.join("tokens/proj/symlinked-service"))
            .unwrap();

        // Create minimal other dirs so ensure doesn't fail
        secure_mkdir(&data_dir.join("secrets"));
        secure_mkdir(&data_dir.join("secrets/proj"));
        secure_mkdir(&data_dir.join("snapshots"));
        secure_mkdir(&data_dir.join("snapshots/proj"));
        secure_mkdir(&data_dir.join("ide-bridge"));

        ensure_data_dir_permissions_in(data_dir, "proj").unwrap();

        // Real service dir should be fixed
        assert_eq!(get_mode(&real_service), 0o700);

        // Symlink target should NOT be changed
        assert_eq!(
            get_mode(&external),
            0o755,
            "symlink target permissions should not have been changed"
        );
    }

    #[cfg(unix)]
    #[test]
    fn test_ensure_does_not_fix_uid_mismatch() {
        use std::os::unix::fs::MetadataExt as _;

        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path();
        create_test_tree(data_dir, true); // correct mode bits

        // Autofix should succeed (nothing to fix for mode bits)
        ensure_data_dir_permissions_in(data_dir, "proj").unwrap();

        // But SecurityCheck with a DIFFERENT expected UID should still find violations
        let real_uid = std::fs::metadata(data_dir).unwrap().uid();
        let wrong_uid = real_uid + 1;
        let violations = crate::compose::SecurityCheck::check_file_security_with_uid(
            data_dir, "proj", wrong_uid,
        );
        assert!(
            !violations.is_empty(),
            "SecurityCheck should report UID mismatch violations"
        );
        assert!(
            violations.iter().any(|v| v.message.contains("owned by uid")),
            "At least one violation should be about UID ownership"
        );
    }

    #[cfg(unix)]
    #[test]
    fn test_ensure_roundtrip_fixes_then_check_passes() {
        use std::os::unix::fs::{MetadataExt as _, PermissionsExt};

        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path();

        // Create tree with various wrong permissions
        create_test_tree(data_dir, false); // 0o755 dirs, 0o644 files

        // Make some even worse
        std::fs::set_permissions(
            &data_dir.join("tokens"),
            std::fs::Permissions::from_mode(0o777),
        )
        .unwrap();
        std::fs::set_permissions(
            &data_dir.join("bundle-state.json"),
            std::fs::Permissions::from_mode(0o666),
        )
        .unwrap();

        // Autofix
        ensure_data_dir_permissions_in(data_dir, "proj").unwrap();

        // SecurityCheck should now pass
        let uid = std::fs::metadata(data_dir).unwrap().uid();
        let violations =
            crate::compose::SecurityCheck::check_file_security_with_uid(data_dir, "proj", uid);
        assert!(
            violations.is_empty(),
            "SecurityCheck should pass after autofix, got: {:?}",
            violations
                .iter()
                .map(|v| &v.message)
                .collect::<Vec<_>>()
        );
    }
}
