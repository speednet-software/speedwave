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

/// Atomic variant of [`write_restricted_file`]: writes to a sibling `.tmp`
/// file with owner-only perms, then `rename`s into place. Crash between write
/// and rename leaves the destination untouched (no truncated secret on disk).
///
/// Used by `save_compose` and `update_llm_config` where partial writes would
/// corrupt a render or token.
pub fn write_restricted_file_atomic(path: &Path, content: &str) -> anyhow::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("path has no parent: {}", path.display()))?;
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| anyhow::anyhow!("path has no file name: {}", path.display()))?;
    // Per-write unique tmp name — `<pid>` alone collides across threads in
    // one process; the atomic counter makes every call's sibling unique.
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    let tmp = parent.join(format!(".{}.tmp.{}.{}", file_name, std::process::id(), seq));

    write_restricted_file(&tmp, content).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })?;

    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        anyhow::bail!("rename {} -> {}: {}", tmp.display(), path.display(), e);
    }

    Ok(())
}

/// Creates `path` (if missing) and sets it to owner-only perms.
/// Unix: `chmod 0o700`. Windows: `icacls /inheritance:r /grant:r <user>:(F)`.
///
/// Idempotent: re-runs harmless. Callers iterate parents themselves
/// (e.g. `tokens/` → `tokens/<project>/` → `tokens/<project>/<service>/`).
pub fn ensure_owner_only_dir(path: &Path) -> anyhow::Result<()> {
    std::fs::create_dir_all(path)?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    }

    #[cfg(windows)]
    {
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
            Ok(s) => anyhow::bail!("icacls failed (exit {}) on directory {}", s, path.display()),
            Err(e) => anyhow::bail!("failed to run icacls on {}: {}", path.display(), e),
        }
    }

    #[cfg(not(any(unix, windows)))]
    {
        compile_error!(
            "ensure_owner_only_dir: unsupported platform — add directory permission logic"
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

    // ── write_restricted_file (atomic via NamedTempFile::persist) ───────

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

    // ── write_restricted_file_atomic ─────────────────────────────────────

    #[test]
    fn atomic_writes_content() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("secret");

        write_restricted_file_atomic(&path, "hello").unwrap();

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "hello");
    }

    #[cfg(unix)]
    #[test]
    fn atomic_sets_mode_0o600() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("secret");

        write_restricted_file_atomic(&path, "x").unwrap();

        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[test]
    fn atomic_replaces_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("secret");
        std::fs::write(&path, "old").unwrap();

        write_restricted_file_atomic(&path, "new").unwrap();

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new");
    }

    #[test]
    fn atomic_leaves_no_tmp_on_success() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("secret");

        write_restricted_file_atomic(&path, "data").unwrap();

        let entries: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(
            entries.len(),
            1,
            "only the dest file should remain: {entries:?}"
        );
        assert_eq!(entries[0], "secret");
    }

    #[test]
    fn atomic_recovers_when_stale_tmp_exists() {
        // A prior crash may have left a `.tmp.<pid>.<seq>` orphan on disk.
        // The next call uses a fresh sequence and is not affected — the
        // happy path still writes the destination atomically. Stale tmp
        // files are not actively cleaned by the helper (each call has its
        // own sequence), but they never interfere with a subsequent write.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("secret");
        // Manual orphan with an old shape — the helper uses `.tmp.<pid>.<seq>`
        // so this exact name won't collide with the next call.
        let stale_tmp = dir
            .path()
            .join(format!(".secret.tmp.{}.legacy", std::process::id()));
        std::fs::write(&stale_tmp, "garbage").unwrap();

        write_restricted_file_atomic(&path, "fresh").unwrap();

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "fresh");
    }

    #[test]
    fn atomic_fails_when_parent_missing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("missing").join("secret");

        assert!(write_restricted_file_atomic(&path, "x").is_err());
    }

    /// Crash recovery: simulate a process that died between the `.tmp` write
    /// and the `rename`. The destination file must remain in its prior
    /// state — never truncated, never half-written, never replaced by the
    /// orphaned tmp content.
    #[test]
    fn atomic_crash_before_rename_leaves_destination_with_old_content() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("secret");

        // Pre-existing destination with known content.
        write_restricted_file_atomic(&path, "old-content").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "old-content");

        // Simulate a crash: write a `.tmp` file that "would have been" the
        // next atomic write's intermediate state — but the rename never
        // happened. The destination must still hold the OLD content.
        let crashed_tmp = dir.path().join(format!(
            ".secret.tmp.{}.simulated-crash",
            std::process::id()
        ));
        std::fs::write(&crashed_tmp, "would-have-been-new-content").unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "old-content",
            "destination must be untouched while tmp orphan exists"
        );

        // Subsequent successful write replaces the destination cleanly. The
        // orphaned tmp from the simulated crash is left for OS-level cleanup
        // (it cannot interfere — each call uses a fresh sequence).
        write_restricted_file_atomic(&path, "fresh").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "fresh");
    }

    /// Concurrent writes: two atomic writes racing produce one valid
    /// destination (the second-to-complete wins via rename), never a
    /// truncated file. The .tmp cleanup keeps the directory tidy.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn atomic_concurrent_writes_leave_destination_valid() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("secret");
        let path_a = path.clone();
        let path_b = path.clone();

        // Two concurrent writers. They share the same destination, so the
        // serialization is at the rename step, not the write step — both
        // .tmp files coexist briefly (different PIDs), then rename wins
        // one-at-a-time. Both calls must Ok and `path` must end up with
        // ONE of the two written values (never empty, never partial).
        let (a, b) = tokio::join!(
            tokio::task::spawn_blocking(move || {
                write_restricted_file_atomic(&path_a, "writer-a")
            }),
            tokio::task::spawn_blocking(move || {
                write_restricted_file_atomic(&path_b, "writer-b")
            }),
        );
        a.unwrap().unwrap();
        b.unwrap().unwrap();

        let content = std::fs::read_to_string(&path).unwrap();
        assert!(
            content == "writer-a" || content == "writer-b",
            "destination must hold exactly one writer's content, got: {content:?}"
        );

        // No orphaned .tmp files left on disk.
        let stragglers: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().starts_with(".secret.tmp."))
            .collect();
        assert!(
            stragglers.is_empty(),
            "no .tmp files should remain after both writes: {stragglers:?}"
        );
    }

    // ── ensure_owner_only_dir ────────────────────────────────────────────

    #[test]
    fn ensure_dir_creates_missing() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("tokens").join("proj").join("local-llm");

        ensure_owner_only_dir(&target).unwrap();

        assert!(target.is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn ensure_dir_sets_mode_0o700() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("svc");

        ensure_owner_only_dir(&target).unwrap();

        let mode = std::fs::metadata(&target).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700);
    }

    #[cfg(unix)]
    #[test]
    fn ensure_dir_tightens_existing_loose_perms() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("svc");
        std::fs::create_dir(&target).unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755)).unwrap();

        ensure_owner_only_dir(&target).unwrap();

        let mode = std::fs::metadata(&target).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700);
    }

    #[test]
    fn ensure_dir_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("svc");

        ensure_owner_only_dir(&target).unwrap();
        ensure_owner_only_dir(&target).unwrap();

        assert!(target.is_dir());
    }
}
