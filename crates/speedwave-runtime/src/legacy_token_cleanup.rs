//! Startup sanitation of v1 SharePoint secrets (refresh_token / client_id /
//! tenant_id) left over in the worker-mounted token dir. ADR-060 moved them
//! off-mount; this module deletes the stragglers. Best-effort, idempotent.

use std::path::Path;

use crate::consts;

/// Legacy SharePoint secret files that must be removed from the
/// worker-mounted token dir post-ADR-060. SSOT for what this module touches.
const LEGACY_SHAREPOINT_FILES: &[&str] = &["refresh_token", "client_id", "tenant_id"];

/// Run cleanup once at startup. Best-effort: per-project failures are logged
/// and do not abort the rest. Returns the number of projects where at least
/// one legacy file was removed this run.
pub fn run_legacy_token_cleanup_at_startup() -> usize {
    run_with_data_dir(consts::data_dir())
}

/// Inner entry point parameterised by the data dir. Tests pass an explicit
/// tmp dir to bypass the cached `consts::data_dir()`.
fn run_with_data_dir(data_dir: &Path) -> usize {
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
}
