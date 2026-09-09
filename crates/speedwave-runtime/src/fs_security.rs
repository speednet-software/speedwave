//! Host filesystem permission auto-fix for security-sensitive paths. Called before
//! `SecurityCheck::run()` on all start paths to fix mode bits; `speedwave check` reports-only.

use crate::consts;

/// Fixes permissions under the default data directory (`~/.speedwave/`): dirs to `0o700`, files to
/// `0o600`. Skips missing paths and symlinks; idempotent; no-op on non-Unix.
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

/// Enumerates security-sensitive paths under `data_dir`: `dirs` must be `0o700`, `files` must be `0o600`.
/// Used by both the autofix path and `SecurityCheck::check_file_security_with_uid()`.
#[cfg(unix)]
pub(crate) fn collect_security_paths(
    data_dir: &std::path::Path,
    project: &str,
) -> (Vec<std::path::PathBuf>, Vec<std::path::PathBuf>) {
    let mut dirs: Vec<std::path::PathBuf> = vec![
        data_dir.join("secrets"),
        data_dir.join("snapshots"),
        data_dir.join("tokens"),
        data_dir.join(consts::OAUTH_SUBDIR),
        data_dir.join("secrets").join(project),
        data_dir.join("snapshots").join(project),
        data_dir.join("ide-bridge"),
        data_dir.join("tokens").join(project),
        data_dir.join(consts::OAUTH_SUBDIR).join(project),
        data_dir.join(consts::CLAUDE_MANAGED_SUBDIR),
        data_dir.join(consts::CLAUDE_MANAGED_SUBDIR).join(project),
    ];

    let mut files: Vec<std::path::PathBuf> = Vec::new();

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

    files.push(data_dir.join("bundle-state.json"));
    files.push(data_dir.join(consts::MCP_OS_LOCK_FILE));

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

    let oauth_project_dir = data_dir.join(consts::OAUTH_SUBDIR).join(project);
    if let Ok(entries) = std::fs::read_dir(&oauth_project_dir) {
        for entry in entries.flatten() {
            if let Ok(ft) = entry.file_type() {
                if ft.is_file() {
                    files.push(entry.path());
                }
            }
        }
    }

    files.push(crate::claude_managed::managed_settings_path(
        data_dir, project,
    ));

    (dirs, files)
}

#[cfg(all(test, unix))]
#[expect(
    clippy::unwrap_used,
    reason = "test-only module: unwraps assert setup succeeded"
)]
mod tests {
    use super::*;

    fn secure_mkdir(path: &std::path::Path) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::create_dir_all(path).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
    }

    fn get_mode(path: &std::path::Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    /// Creates a fully populated data dir tree for testing.
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
            data_dir.join("tokens/proj/github"),
            data_dir.join("tokens/proj/atlassian"),
            data_dir.join("tokens/proj/empty-service"),
            data_dir.join("ide-bridge"),
            data_dir.join("oauth"),
            data_dir.join("oauth/proj"),
        ];
        for dir in &dirs_to_create {
            std::fs::create_dir_all(dir).unwrap();
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(dir_mode)).unwrap();
        }

        let files_to_create = [
            data_dir.join("secrets/proj/worker-auth-token"),
            data_dir.join("tokens/proj/slack/token.txt"),
            data_dir.join("tokens/proj/gitlab/key.txt"),
            data_dir.join("tokens/proj/github/key.txt"),
            data_dir.join("tokens/proj/atlassian/api_token"),
            data_dir.join("snapshots/proj/snapshot.json"),
            data_dir.join("ide-bridge/1234.lock"),
            data_dir.join("bundle-state.json"),
            data_dir.join("mcp-os.lock.json"),
            data_dir.join("oauth/proj/sharepoint.json"),
            data_dir.join("oauth/proj/.bearer-map.json"),
            data_dir.join("oauth/proj/bearer-sharepoint"),
            data_dir.join("oauth/proj/lock.json"),
            data_dir.join("oauth/proj/audit.log"),
            data_dir.join("oauth/proj/audit.log.1"),
        ];
        for file in &files_to_create {
            std::fs::write(file, "test").unwrap();
            std::fs::set_permissions(file, std::fs::Permissions::from_mode(file_mode)).unwrap();
        }
    }

    #[test]
    fn test_collect_security_paths_returns_correct_paths() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path();
        create_test_tree(data_dir, true);

        std::fs::write(data_dir.join("ide-bridge/not-a-lock.txt"), "test").unwrap();

        let (dirs, files) = collect_security_paths(data_dir, "proj");

        assert_eq!(dirs.len(), 16, "expected 16 dirs, got: {dirs:?}");
        assert!(dirs.contains(&data_dir.join("secrets")));
        assert!(dirs.contains(&data_dir.join("secrets/proj")));
        assert!(dirs.contains(&data_dir.join("snapshots")));
        assert!(dirs.contains(&data_dir.join("snapshots/proj")));
        assert!(dirs.contains(&data_dir.join("tokens")));
        assert!(dirs.contains(&data_dir.join("tokens/proj")));
        assert!(dirs.contains(&data_dir.join("tokens/proj/slack")));
        assert!(dirs.contains(&data_dir.join("tokens/proj/gitlab")));
        assert!(dirs.contains(&data_dir.join("tokens/proj/github")));
        assert!(dirs.contains(&data_dir.join("tokens/proj/atlassian")));
        assert!(dirs.contains(&data_dir.join("tokens/proj/empty-service")));
        assert!(dirs.contains(&data_dir.join("ide-bridge")));
        assert!(dirs.contains(&data_dir.join("oauth")));
        assert!(dirs.contains(&data_dir.join("oauth/proj")));
        assert!(dirs.contains(&data_dir.join("claude-managed")));
        assert!(dirs.contains(&data_dir.join("claude-managed/proj")));

        assert_eq!(files.len(), 16, "expected 16 files, got: {files:?}");
        assert!(files.contains(&data_dir.join("secrets/proj/worker-auth-token")));
        assert!(files.contains(&data_dir.join("tokens/proj/slack/token.txt")));
        assert!(files.contains(&data_dir.join("tokens/proj/gitlab/key.txt")));
        assert!(files.contains(&data_dir.join("tokens/proj/github/key.txt")));
        assert!(files.contains(&data_dir.join("tokens/proj/atlassian/api_token")));
        assert!(files.contains(&data_dir.join("snapshots/proj/snapshot.json")));
        assert!(files.contains(&data_dir.join("ide-bridge/1234.lock")));
        assert!(files.contains(&data_dir.join("bundle-state.json")));
        assert!(files.contains(&data_dir.join("mcp-os.lock.json")));
        assert!(files.contains(&data_dir.join("oauth/proj/sharepoint.json")));
        assert!(files.contains(&data_dir.join("oauth/proj/.bearer-map.json")));
        assert!(files.contains(&data_dir.join("oauth/proj/bearer-sharepoint")));
        assert!(files.contains(&data_dir.join("oauth/proj/lock.json")));
        assert!(files.contains(&data_dir.join("oauth/proj/audit.log")));
        assert!(files.contains(&data_dir.join("oauth/proj/audit.log.1")));
        assert!(files.contains(&data_dir.join("claude-managed/proj/managed-settings.json")));

        assert!(
            !files.contains(&data_dir.join("ide-bridge/not-a-lock.txt")),
            "ide-bridge/not-a-lock.txt should not be in files list"
        );
    }

    #[test]
    fn test_ensure_correct_permissions_noop() {
        use std::os::unix::fs::MetadataExt as _;

        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path();
        create_test_tree(data_dir, true);

        ensure_data_dir_permissions_in(data_dir, "proj").unwrap();

        assert_eq!(get_mode(&data_dir.join("secrets")), 0o700);
        assert_eq!(get_mode(&data_dir.join("tokens/proj/slack")), 0o700);
        assert_eq!(get_mode(&data_dir.join("bundle-state.json")), 0o600);

        let uid = std::fs::metadata(data_dir).unwrap().uid();
        let violations =
            crate::compose::SecurityCheck::check_file_security_with_uid(data_dir, "proj", uid);
        assert!(
            violations.is_empty(),
            "SecurityCheck should pass for correct permissions, got: {violations:?}"
        );
    }

    #[test]
    fn test_ensure_fixes_wrong_permissions() {
        use std::os::unix::fs::MetadataExt as _;

        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path();
        create_test_tree(data_dir, false);

        ensure_data_dir_permissions_in(data_dir, "proj").unwrap();

        assert_eq!(get_mode(&data_dir.join("secrets")), 0o700);
        assert_eq!(get_mode(&data_dir.join("snapshots")), 0o700);
        assert_eq!(get_mode(&data_dir.join("tokens")), 0o700);
        assert_eq!(get_mode(&data_dir.join("tokens/proj")), 0o700);
        assert_eq!(get_mode(&data_dir.join("tokens/proj/slack")), 0o700);
        assert_eq!(get_mode(&data_dir.join("tokens/proj/gitlab")), 0o700);
        assert_eq!(get_mode(&data_dir.join("tokens/proj/github")), 0o700);
        assert_eq!(get_mode(&data_dir.join("tokens/proj/atlassian")), 0o700);
        assert_eq!(get_mode(&data_dir.join("tokens/proj/empty-service")), 0o700);
        assert_eq!(get_mode(&data_dir.join("ide-bridge")), 0o700);

        assert_eq!(
            get_mode(&data_dir.join("secrets/proj/worker-auth-token")),
            0o600
        );
        assert_eq!(
            get_mode(&data_dir.join("tokens/proj/slack/token.txt")),
            0o600
        );
        assert_eq!(get_mode(&data_dir.join("bundle-state.json")), 0o600);
        assert_eq!(
            get_mode(&data_dir.join("snapshots/proj/snapshot.json")),
            0o600
        );
        assert_eq!(get_mode(&data_dir.join("ide-bridge/1234.lock")), 0o600);

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

    #[test]
    fn test_ensure_missing_paths_ok() {
        let tmp = tempfile::tempdir().unwrap();
        ensure_data_dir_permissions_in(tmp.path(), "proj").unwrap();
    }

    #[test]
    fn test_ensure_skips_symlinks_at_top_level() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path();

        let real_dir = data_dir.join("real-secrets");
        std::fs::create_dir_all(&real_dir).unwrap();
        std::os::unix::fs::symlink(&real_dir, data_dir.join("secrets")).unwrap();

        ensure_data_dir_permissions_in(data_dir, "proj").unwrap();

        assert_ne!(
            get_mode(&real_dir),
            0o700,
            "symlink target should not have been changed to 0o700"
        );
    }

    #[test]
    fn test_ensure_skips_symlinks_inside_token_dir() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path();

        let real_service = data_dir.join("tokens/proj/real-service");
        secure_mkdir(&data_dir.join("tokens"));
        secure_mkdir(&data_dir.join("tokens/proj"));
        std::fs::create_dir_all(&real_service).unwrap();
        std::fs::set_permissions(&real_service, std::fs::Permissions::from_mode(0o755)).unwrap();

        let external = tmp.path().join("external-target");
        std::fs::create_dir_all(&external).unwrap();
        std::fs::set_permissions(&external, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::os::unix::fs::symlink(&external, data_dir.join("tokens/proj/symlinked-service"))
            .unwrap();

        secure_mkdir(&data_dir.join("secrets"));
        secure_mkdir(&data_dir.join("secrets/proj"));
        secure_mkdir(&data_dir.join("snapshots"));
        secure_mkdir(&data_dir.join("snapshots/proj"));
        secure_mkdir(&data_dir.join("ide-bridge"));

        ensure_data_dir_permissions_in(data_dir, "proj").unwrap();

        assert_eq!(get_mode(&real_service), 0o700);

        assert_eq!(
            get_mode(&external),
            0o755,
            "symlink target permissions should not have been changed"
        );
    }

    #[test]
    fn test_ensure_does_not_fix_uid_mismatch() {
        use std::os::unix::fs::MetadataExt as _;

        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path();
        create_test_tree(data_dir, true);

        ensure_data_dir_permissions_in(data_dir, "proj").unwrap();

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
            violations
                .iter()
                .any(|v| v.message.contains("owned by uid")),
            "At least one violation should be about UID ownership"
        );
    }

    #[test]
    fn test_ensure_roundtrip_fixes_then_check_passes() {
        use std::os::unix::fs::{MetadataExt as _, PermissionsExt};

        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path();

        create_test_tree(data_dir, false);

        std::fs::set_permissions(
            data_dir.join("tokens"),
            std::fs::Permissions::from_mode(0o777),
        )
        .unwrap();
        std::fs::set_permissions(
            data_dir.join("bundle-state.json"),
            std::fs::Permissions::from_mode(0o666),
        )
        .unwrap();

        ensure_data_dir_permissions_in(data_dir, "proj").unwrap();

        let uid = std::fs::metadata(data_dir).unwrap().uid();
        let violations =
            crate::compose::SecurityCheck::check_file_security_with_uid(data_dir, "proj", uid);
        assert!(
            violations.is_empty(),
            "SecurityCheck should pass after autofix, got: {:?}",
            violations.iter().map(|v| &v.message).collect::<Vec<_>>()
        );
    }
}
