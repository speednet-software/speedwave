//! Startup sanitation of legacy secret-bearing state: v1 SharePoint secrets
//! left in the worker-mounted token dir (ADR-060) and the retired host_exec
//! worker's state tree (ADR-054, reverted). Best-effort, idempotent.

use std::path::Path;

use crate::consts;

/// Legacy SharePoint secret files that must be removed from the
/// worker-mounted token dir post-ADR-060. SSOT for what this module touches.
const LEGACY_SHAREPOINT_FILES: &[&str] = &["refresh_token", "client_id", "tenant_id"];

/// Data-dir subdir where the retired `host_exec` worker (ADR-054, reverted)
/// kept per-project state (0600 auth-token, config.json, logs). Legacy-only.
pub(crate) const LEGACY_HOST_EXEC_SUBDIR: &str = "host-exec";

/// Run cleanup once at startup: sweep the retired host_exec state tree, then
/// sanitise legacy SharePoint token files. Best-effort — failures are logged.
/// Returns the number of projects where a legacy SharePoint file was removed.
pub fn run_legacy_token_cleanup_at_startup() -> usize {
    run_with_data_dir(consts::data_dir())
}

/// Inner entry point parameterised by the data dir. Tests pass an explicit
/// tmp dir to bypass the cached `consts::data_dir()`.
fn run_with_data_dir(data_dir: &Path) -> usize {
    remove_legacy_host_exec_tree(data_dir);
    let tokens_root = data_dir.join("tokens");
    if !tokens_root.exists() {
        return 0;
    }
    let entries = match std::fs::read_dir(&tokens_root) {
        Ok(e) => e,
        Err(e) => {
            log::warn!(
                "legacy_token_cleanup: cannot read {}: {e}",
                tokens_root.display()
            );
            return 0;
        }
    };
    let mut cleaned = 0usize;
    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                log::warn!(
                    "legacy_token_cleanup: skipping unreadable entry under {}: {e}",
                    tokens_root.display()
                );
                continue;
            }
        };
        let project_path = entry.path();
        if !project_path.is_dir() {
            continue;
        }
        let project = match project_path.file_name().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        if cleanup_sharepoint_for_project(&project, &project_path) {
            cleaned += 1;
            log::info!("legacy_token_cleanup[{project}]: removed legacy SharePoint secrets");
        }
    }
    cleaned
}

/// Remove legacy files for one project. Returns `true` if at least one file
/// was removed. Missing files are not errors — this is sanitation, not migration.
fn cleanup_sharepoint_for_project(project: &str, project_dir: &Path) -> bool {
    let sp_dir = project_dir.join("sharepoint");
    if !sp_dir.is_dir() {
        return false;
    }
    let mut any_removed = false;
    for &name in LEGACY_SHAREPOINT_FILES {
        let path = sp_dir.join(name);
        if !path.exists() {
            continue;
        }
        match std::fs::remove_file(&path) {
            Ok(()) => {
                any_removed = true;
            }
            Err(e) => {
                log::warn!(
                    "legacy_token_cleanup[{project}]: failed to remove {}: {e}",
                    path.display()
                );
            }
        }
    }
    any_removed
}

/// Delete the whole legacy `host-exec/` tree. Nothing reads it since the
/// host_exec worker was removed, but it still holds secret-bearing files
/// (auth-token, config.json). Returns `true` when the tree was removed.
fn remove_legacy_host_exec_tree(data_dir: &Path) -> bool {
    let root = data_dir.join(LEGACY_HOST_EXEC_SUBDIR);
    match std::fs::remove_dir_all(&root) {
        Ok(()) => {
            log::info!(
                "legacy_token_cleanup: removed retired host_exec state at {}",
                root.display()
            );
            true
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
        Err(e) => {
            log::warn!(
                "legacy_token_cleanup: failed to remove retired host_exec state at {}: {e}",
                root.display()
            );
            false
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write(path: &Path, content: &str) {
        let mut f = std::fs::File::create(path).unwrap();
        f.write_all(content.as_bytes()).unwrap();
    }

    fn make_tmp_data_dir() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn removes_all_legacy_sharepoint_files() {
        let tmp = make_tmp_data_dir();
        let data_dir = tmp.path();
        let sp_dir = data_dir.join("tokens").join("proj-a").join("sharepoint");
        std::fs::create_dir_all(&sp_dir).unwrap();
        write(&sp_dir.join("refresh_token"), "rt-old");
        write(&sp_dir.join("client_id"), "cid");
        write(&sp_dir.join("tenant_id"), "tid");
        write(&sp_dir.join("access_token"), "at-keep");
        write(&sp_dir.join("site_id"), "site-keep");

        let n = run_with_data_dir(data_dir);
        assert_eq!(n, 1);

        assert!(!sp_dir.join("refresh_token").exists());
        assert!(!sp_dir.join("client_id").exists());
        assert!(!sp_dir.join("tenant_id").exists());
        // Worker-mounted files preserved.
        assert!(sp_dir.join("access_token").exists());
        assert!(sp_dir.join("site_id").exists());
    }

    #[test]
    fn does_not_create_oauth_json_during_cleanup() {
        // Cleanup must not create the host-only `oauth/<project>/sharepoint.json`.
        let tmp = make_tmp_data_dir();
        let data_dir = tmp.path();
        let sp_dir = data_dir.join("tokens").join("proj-a").join("sharepoint");
        std::fs::create_dir_all(&sp_dir).unwrap();
        write(&sp_dir.join("refresh_token"), "rt-old");
        write(&sp_dir.join("client_id"), "cid");
        write(&sp_dir.join("tenant_id"), "tid");

        run_with_data_dir(data_dir);

        let oauth_path = data_dir
            .join(consts::OAUTH_SUBDIR)
            .join("proj-a")
            .join("sharepoint.json");
        assert!(!oauth_path.exists());
    }

    #[test]
    fn is_idempotent_when_no_legacy_files_present() {
        let tmp = make_tmp_data_dir();
        let data_dir = tmp.path();
        let sp_dir = data_dir.join("tokens").join("proj-b").join("sharepoint");
        std::fs::create_dir_all(&sp_dir).unwrap();
        write(&sp_dir.join("access_token"), "at");
        write(&sp_dir.join("site_id"), "site");

        let n = run_with_data_dir(data_dir);
        assert_eq!(n, 0);
        // access_token + site_id untouched.
        assert!(sp_dir.join("access_token").exists());
        assert!(sp_dir.join("site_id").exists());
    }

    #[test]
    fn handles_partial_legacy_state() {
        // Only refresh_token exists — other two missing.
        let tmp = make_tmp_data_dir();
        let data_dir = tmp.path();
        let sp_dir = data_dir.join("tokens").join("proj-c").join("sharepoint");
        std::fs::create_dir_all(&sp_dir).unwrap();
        write(&sp_dir.join("refresh_token"), "rt");

        let n = run_with_data_dir(data_dir);
        assert_eq!(n, 1);
        assert!(!sp_dir.join("refresh_token").exists());
    }

    #[test]
    fn is_no_op_when_no_sharepoint_dir() {
        let tmp = make_tmp_data_dir();
        let data_dir = tmp.path();
        std::fs::create_dir_all(data_dir.join("tokens").join("proj-d").join("slack")).unwrap();
        let n = run_with_data_dir(data_dir);
        assert_eq!(n, 0);
    }

    #[test]
    fn is_no_op_when_tokens_root_missing() {
        let tmp = make_tmp_data_dir();
        let n = run_with_data_dir(tmp.path());
        assert_eq!(n, 0);
    }

    #[test]
    fn cleans_multiple_projects_in_one_pass() {
        let tmp = make_tmp_data_dir();
        let data_dir = tmp.path();
        for project in ["proj-1", "proj-2", "proj-3"] {
            let sp_dir = data_dir.join("tokens").join(project).join("sharepoint");
            std::fs::create_dir_all(&sp_dir).unwrap();
            write(&sp_dir.join("refresh_token"), "rt");
            write(&sp_dir.join("client_id"), "cid");
            write(&sp_dir.join("tenant_id"), "tid");
        }
        let n = run_with_data_dir(data_dir);
        assert_eq!(n, 3);
    }

    #[cfg(unix)]
    #[test]
    fn does_not_crash_on_read_only_sharepoint_dir() {
        // A read-only sp_dir must not panic cleanup; perms restored before drop.
        use std::os::unix::fs::PermissionsExt;
        let tmp = make_tmp_data_dir();
        let data_dir = tmp.path();
        let sp_dir = data_dir.join("tokens").join("proj-ro").join("sharepoint");
        std::fs::create_dir_all(&sp_dir).unwrap();
        write(&sp_dir.join("refresh_token"), "rt");

        std::fs::set_permissions(&sp_dir, std::fs::Permissions::from_mode(0o500)).unwrap();

        // Must not panic; return value is best-effort (0 or 1 both accepted).
        let _ = run_with_data_dir(data_dir);

        // Restore writable perms so tempdir cleanup can recurse.
        std::fs::set_permissions(&sp_dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    }

    // macOS APFS rejects non-UTF-8 names at mkdir (`EILSEQ`); Linux-only.
    #[cfg(target_os = "linux")]
    #[test]
    fn skips_project_dir_with_non_utf8_name() {
        use std::ffi::OsStr;
        use std::os::unix::ffi::OsStrExt;

        let tmp = make_tmp_data_dir();
        let data_dir = tmp.path();
        let tokens_root = data_dir.join("tokens");
        std::fs::create_dir_all(&tokens_root).unwrap();

        let bad_dir = tokens_root.join(OsStr::from_bytes(&[0xff, b'x']));
        std::fs::create_dir(&bad_dir).unwrap();
        let ok_sp = tokens_root.join("good").join("sharepoint");
        std::fs::create_dir_all(&ok_sp).unwrap();
        write(&ok_sp.join("refresh_token"), "rt");

        let n = run_with_data_dir(data_dir);
        assert_eq!(n, 1, "non-UTF-8 dir skipped, normal project still cleaned");
        assert!(!ok_sp.join("refresh_token").exists());
    }

    #[test]
    fn ignores_unrelated_files_in_sharepoint_dir() {
        // Only the SSOT-listed legacy files are touched; other files survive.
        let tmp = make_tmp_data_dir();
        let data_dir = tmp.path();
        let sp_dir = data_dir.join("tokens").join("proj-e").join("sharepoint");
        std::fs::create_dir_all(&sp_dir).unwrap();
        write(&sp_dir.join("refresh_token"), "rt");
        write(&sp_dir.join("base_path"), "/sites/X");
        write(&sp_dir.join("future_field"), "value");

        run_with_data_dir(data_dir);

        assert!(!sp_dir.join("refresh_token").exists());
        assert!(sp_dir.join("base_path").exists());
        assert!(sp_dir.join("future_field").exists());
    }

    // -- retired host_exec state sweep --

    #[test]
    fn removes_orphaned_host_exec_tree() {
        let tmp = make_tmp_data_dir();
        let data_dir = tmp.path();
        let he = data_dir.join(LEGACY_HOST_EXEC_SUBDIR);
        for project in ["proj-a", "proj-b"] {
            let d = he.join(project);
            std::fs::create_dir_all(&d).unwrap();
            write(&d.join("auth-token"), "tok");
            write(&d.join("config.json"), "{}");
            write(&d.join("log"), "line");
        }
        // Unrelated sibling state must survive.
        let sp_dir = data_dir.join("tokens").join("proj-a").join("sharepoint");
        std::fs::create_dir_all(&sp_dir).unwrap();
        write(&sp_dir.join("access_token"), "at");

        run_with_data_dir(data_dir);

        assert!(!he.exists(), "whole host-exec tree must be removed");
        assert!(sp_dir.join("access_token").exists(), "unrelated state kept");
    }

    #[test]
    fn host_exec_sweep_is_no_op_when_dir_absent() {
        let tmp = make_tmp_data_dir();
        assert!(!remove_legacy_host_exec_tree(tmp.path()));
        let n = run_with_data_dir(tmp.path());
        assert_eq!(n, 0);
    }

    #[test]
    fn removes_empty_host_exec_dir() {
        let tmp = make_tmp_data_dir();
        let he = tmp.path().join(LEGACY_HOST_EXEC_SUBDIR);
        std::fs::create_dir_all(&he).unwrap();
        assert!(remove_legacy_host_exec_tree(tmp.path()));
        assert!(!he.exists());
    }

    #[test]
    fn removes_host_exec_tree_with_nested_unexpected_content() {
        let tmp = make_tmp_data_dir();
        let he = tmp.path().join(LEGACY_HOST_EXEC_SUBDIR);
        std::fs::create_dir_all(he.join("proj").join("deep").join("er")).unwrap();
        write(&he.join("stray-file"), "x");
        write(
            &he.join("proj").join("deep").join("er").join("blob.bin"),
            "b",
        );

        run_with_data_dir(tmp.path());

        assert!(!he.exists());
    }

    #[test]
    fn host_exec_sweep_runs_even_without_tokens_root() {
        // Guard: the sweep must not sit behind the tokens/ early return.
        let tmp = make_tmp_data_dir();
        let he = tmp.path().join(LEGACY_HOST_EXEC_SUBDIR);
        std::fs::create_dir_all(he.join("proj")).unwrap();
        write(&he.join("proj").join("auth-token"), "tok");

        let n = run_with_data_dir(tmp.path());

        assert_eq!(n, 0, "no SharePoint project sanitised");
        assert!(!he.exists(), "host-exec removed even with no tokens/ root");
    }

    #[test]
    fn host_exec_sweep_is_idempotent() {
        let tmp = make_tmp_data_dir();
        let he = tmp.path().join(LEGACY_HOST_EXEC_SUBDIR);
        std::fs::create_dir_all(he.join("proj")).unwrap();
        write(&he.join("proj").join("auth-token"), "tok");

        assert!(remove_legacy_host_exec_tree(tmp.path()));
        // Second run: already gone — no-op, no panic, nothing recreated.
        assert!(!remove_legacy_host_exec_tree(tmp.path()));
        assert!(!he.exists());
    }

    #[cfg(unix)]
    #[test]
    fn host_exec_sweep_survives_permission_denied() {
        // remove_dir_all cannot unlink inside a r-x dir: the sweep must report
        // failure via its return value (logged as warn), never panic. As root
        // the unlink succeeds anyway, so both outcomes are asserted coherently.
        use std::os::unix::fs::PermissionsExt;
        let tmp = make_tmp_data_dir();
        let protected = tmp.path().join(LEGACY_HOST_EXEC_SUBDIR).join("protected");
        std::fs::create_dir_all(&protected).unwrap();
        write(&protected.join("auth-token"), "tok");
        std::fs::set_permissions(&protected, std::fs::Permissions::from_mode(0o500)).unwrap();

        let removed = remove_legacy_host_exec_tree(tmp.path());

        if removed {
            assert!(!tmp.path().join(LEGACY_HOST_EXEC_SUBDIR).exists());
        } else {
            assert!(
                protected.join("auth-token").exists(),
                "failed sweep must leave the protected file for the next run"
            );
        }

        // Restore writable perms so tempdir cleanup can recurse.
        std::fs::set_permissions(&protected, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
}
