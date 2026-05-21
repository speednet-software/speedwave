//! Restricted-file write helpers used by host-side worker supervisors.
//!
//! All worker auth tokens, PID files, and OAuth state files must be written
//! such that only the current user can read them. Unix: `chmod 0o600`.
//! Windows: ACL replacement via `icacls /inheritance:r /grant:r <user>:(F)`.
//!
//! Single SSOT — previously duplicated in `desktop/src-tauri/src/mcp_os_process.rs`
//! and `crates/speedwave-runtime/src/host_exec_process.rs`. A third copy would
//! have appeared for the OAuth worker; PR1 extracted before that.

use std::io::Write;
use std::path::Path;

use tempfile::NamedTempFile;

/// Write `content` to `path` with owner-only permissions.
///
/// Both platforms now use the same write-then-atomic-rename pattern via
/// `tempfile::NamedTempFile`. The destination path never sees a world-readable
/// state: the file is created in `path`'s parent directory with owner-only
/// permissions, written, locked down, then atomically renamed into place.
///
/// - Unix: `NamedTempFile` opens with `O_CREAT | mode 0o600`. We explicitly
///   re-`chmod` after writing so a pre-existing destination file's old (possibly
///   world-readable) bits are replaced too. `persist()` is atomic on Unix —
///   the destination is the new file or the old one, never a partial write.
/// - Windows: tightens the ACL on the tempfile **before** rename, so the
///   destination path never appears world-readable to a concurrent reader.
///   Previous behavior (`fs::write(dest) + icacls dest`) opened a TOCTOU window
///   where the destination file existed with the inherited (potentially
///   world-readable) DACL between the two syscalls. `persist()` uses
///   `MoveFileExW(MOVEFILE_REPLACE_EXISTING)`, which is atomic on NTFS.
///   **An `icacls` failure returns `Err`** — the tempfile is dropped before
///   ever appearing at `path`, so no secret leaks. ADR-009 makes Windows ACL
///   failure a hard error so the owner-only invariant is real.
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

    // Tempfile must live on the same filesystem as `path` — otherwise
    // `persist()` falls back to a copy and the rename is not atomic.
    let parent = path.parent().ok_or_else(|| {
        anyhow::anyhow!(
            "write_restricted_file: path {} has no parent directory",
            path.display()
        )
    })?;
    let mut tmp = NamedTempFile::with_prefix_in("write-", parent)?;
    tmp.write_all(content.as_bytes())?;
    tmp.flush()?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // `NamedTempFile` already creates with mode 0o600, but on overwrite of
        // an existing file `persist()` replaces the target inode entirely — the
        // bits we set here are what the destination ends up with. Belt-and-suspenders.
        std::fs::set_permissions(tmp.path(), std::fs::Permissions::from_mode(0o600))?;
    }

    #[cfg(windows)]
    {
        // Tighten ACL on the **tempfile** before rename. The tempfile path is
        // in the same parent directory as the destination (so rename is atomic),
        // but the random prefix makes a concurrent reader unable to guess it.
        // After `persist()` the destination already has the restricted DACL.
        let status = crate::binary::system_command("icacls")
            .args([
                tmp.path().as_os_str(),
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
                // `tmp` is dropped here, which removes it — the destination
                // path is never touched, so no secret leaks.
                anyhow::bail!(
                    "icacls failed (exit {}) on tempfile for {}: refusing to leave a world-readable secret",
                    s,
                    path.display()
                );
            }
            Err(e) => {
                anyhow::bail!(
                    "failed to run icacls on tempfile for {}: {} — refusing to leave a world-readable secret",
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

    // Atomic rename. On error, `tmp` is dropped (cleanup on Unix; on Windows
    // the tempfile path may linger but never as `path`).
    tmp.persist(path)
        .map_err(|e| anyhow::anyhow!("failed to persist tempfile to {}: {}", path.display(), e))?;

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

    /// TOCTOU regression guard: prior implementation did `fs::write(dest) + chmod/icacls(dest)`,
    /// which opened a window where the destination existed with looser bits. The
    /// tempfile-based implementation must never expose a world-readable file at the
    /// destination path.
    ///
    /// On Unix we prove this indirectly by checking that the tempfile produced by
    /// `NamedTempFile::with_prefix_in` is already 0o600 at the moment of creation —
    /// before any write, before `persist`. That is the only state the destination
    /// can transition from, so the destination cannot be world-readable.
    #[cfg(unix)]
    #[test]
    fn tempfile_is_0o600_before_persist() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        // Mimic the production path: tempfile lives in same parent as destination.
        let tmp = tempfile::NamedTempFile::with_prefix_in("write-", dir.path()).unwrap();
        let mode = std::fs::metadata(tmp.path()).unwrap().permissions().mode() & 0o777;
        assert_eq!(
            mode, 0o600,
            "NamedTempFile must create with 0o600 — got 0o{mode:o}. \
             If tempfile changes its default, write_restricted_file must chmod \
             explicitly before persist to keep the TOCTOU guarantee."
        );
    }

    /// Atomicity smoke test: while the file is being written, the destination
    /// path either does not exist or already contains the new content with the
    /// restricted mode — never a partial write with default perms.
    #[cfg(unix)]
    #[test]
    fn destination_never_observed_world_readable_under_overwrite() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("secret");

        // Pre-existing file with world-readable mode (simulates pre-PR1 layout).
        std::fs::write(&path, "old").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();

        // Overwrite — must end with 0o600 and new content. Because persist is
        // a single rename, intermediate states are not observable.
        write_restricted_file(&path, "new").unwrap();

        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new");
    }

    /// `persist` requires the tempfile to live on the same filesystem as the
    /// destination. The implementation uses `with_prefix_in(parent)` to ensure
    /// this — guard against a regression that switches to system tempdir.
    #[test]
    fn tempfile_created_in_destination_parent() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("token");

        // Write must succeed even when the system tempdir is a different fs
        // (we can't easily simulate that, but `with_prefix_in(parent)` is the
        // structural fix and this test exercises the code path).
        write_restricted_file(&path, "x").unwrap();
        assert!(path.exists());
    }
}
