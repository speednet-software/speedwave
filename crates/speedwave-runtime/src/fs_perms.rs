//! Restricted-file write helpers used by host-side worker supervisors.
//!
//! All worker auth tokens, PID files, and OAuth state files must be written
//! such that only the current user can read them. Unix: `chmod 0o600`.
//! Windows: ACL replacement via `icacls /inheritance:r /grant:r <user>:(F)`.
//!
//! Single SSOT — previously duplicated in `desktop/src-tauri/src/mcp_os_process.rs`
//! and `crates/speedwave-runtime/src/host_exec_process.rs`. A third copy would
//! have appeared for the OAuth worker; PR1 extracted before that.

use std::path::Path;

/// Write `content` to `path` with owner-only permissions.
///
/// - Unix: opens with `O_CREAT | O_WRONLY | O_TRUNC` and mode `0o600`, then
///   re-`chmod`s to `0o600`. The explicit chmod is load-bearing: `OpenOptions::mode`
///   only applies on file creation, so a pre-existing file keeps its old (possibly
///   world-readable) bits unless we reset them.
/// - Windows: writes the file, then runs `icacls /inheritance:r /grant:r <user>:(F)`
///   to replace the DACL with a single ACE granting the current user full control.
///   `icacls` runs on every call, so a pre-existing inherited or relaxed ACL is
///   replaced as well. **An `icacls` failure now returns `Err`** — previous behavior
///   swallowed the error and logged a warning, leaving the file world-readable.
///   ADR-009 / PR1 make Windows ACL failure a hard error so the owner-only
///   invariant is real.
///
/// Existing directories at `path` are removed first (consistent with prior behavior).
pub fn write_restricted_file(path: &Path, content: &str) -> anyhow::Result<()> {
    if path.is_dir() {
        log::warn!(
            "write_restricted_file: removing unexpected directory at {}",
            path.display()
        );
        std::fs::remove_dir_all(path)?;
    }

    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)?;
        file.write_all(content.as_bytes())?;
        // `OpenOptions::mode` only applies on file creation. If the file already
        // existed with looser bits (e.g. 0o644 from a pre-PR1 path) we must
        // explicitly reset the mode — otherwise the "owner-only" contract is
        // a lie on overwrite.
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }

    #[cfg(windows)]
    {
        std::fs::write(path, content)?;
        let status = crate::binary::system_command("icacls")
            .args([
                path.as_os_str(),
                "/inheritance:r".as_ref(),
                "/grant:r".as_ref(),
            ])
            .arg(format!(
                "{}:(F)",
                std::env::var("USERNAME").unwrap_or_default()
            ))
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
        match status {
            Ok(s) if s.success() => {}
            Ok(s) => {
                let _ = std::fs::remove_file(path);
                anyhow::bail!(
                    "icacls failed (exit {}) on {}: refusing to leave a world-readable secret",
                    s,
                    path.display()
                );
            }
            Err(e) => {
                let _ = std::fs::remove_file(path);
                anyhow::bail!(
                    "failed to run icacls on {}: {} — refusing to leave a world-readable secret",
                    path.display(),
                    e
                );
            }
        }
    }

    #[cfg(not(any(unix, windows)))]
    {
        compile_error!(
            "write_restricted_file: unsupported platform — add file permission logic for this target"
        );
    }

    Ok(())
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn writes_content_to_new_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("secret.txt");

        write_restricted_file(&path, "hello").unwrap();

        let content = std::fs::read_to_string(&path).unwrap();
        assert_eq!(content, "hello");
    }

    #[cfg(unix)]
    #[test]
    fn sets_mode_0o600_on_unix() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("token");

        write_restricted_file(&path, "abc123").unwrap();

        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "expected 0o600, got 0o{mode:o}");
    }

    #[test]
    fn overwrites_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("secret.txt");
        std::fs::write(&path, "old content").unwrap();

        write_restricted_file(&path, "new content").unwrap();

        let content = std::fs::read_to_string(&path).unwrap();
        assert_eq!(content, "new content");
    }

    #[test]
    fn removes_existing_directory_at_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("conflict");
        std::fs::create_dir(&path).unwrap();
        std::fs::write(path.join("inner"), "data").unwrap();

        write_restricted_file(&path, "file now").unwrap();

        assert!(path.is_file(), "expected file at {}", path.display());
        let content = std::fs::read_to_string(&path).unwrap();
        assert_eq!(content, "file now");
    }

    #[test]
    fn fails_when_parent_missing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("missing").join("secret.txt");

        let result = write_restricted_file(&path, "x");

        assert!(result.is_err(), "expected error when parent missing");
    }

    #[test]
    fn writes_empty_content() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("empty");

        write_restricted_file(&path, "").unwrap();

        let content = std::fs::read_to_string(&path).unwrap();
        assert_eq!(content, "");
    }

    #[cfg(unix)]
    #[test]
    fn resets_mode_to_0o600_on_overwrite_of_world_readable_file() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("secret");
        // Pre-existing world-readable file (simulates a pre-PR1 token file).
        std::fs::write(&path, "old").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        let before = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(before, 0o644, "test setup: expected 0o644 pre-write");

        write_restricted_file(&path, "new").unwrap();

        let after = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(
            after, 0o600,
            "overwrite must tighten perms, got 0o{after:o}"
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new");
    }

    #[test]
    fn idempotent_consecutive_writes_with_same_content() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("token");

        write_restricted_file(&path, "abc").unwrap();
        write_restricted_file(&path, "abc").unwrap();

        let content = std::fs::read_to_string(&path).unwrap();
        assert_eq!(content, "abc");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
    }
}
