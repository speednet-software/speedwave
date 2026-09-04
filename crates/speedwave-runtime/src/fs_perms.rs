//! Cross-platform owner-only file/directory permission utilities (chmod 0o600/0o700 Unix / DACL
//! Windows). SSOT for runtime supervisors + Desktop layer.

use std::io::Write;
use std::path::Path;

use tempfile::NamedTempFile;

/// Prefix every `NamedTempFile::with_prefix_in` call in this module uses; a
/// crash between creation and `persist` orphans a file with this prefix.
const ATOMIC_WRITE_TEMP_PREFIX: &str = "write-";

/// Restrict file permissions to owner-only access: Unix `chmod 0o600`; Windows DACL with a single
/// `GENERIC_ALL` ACE for the current user.
pub fn set_owner_only(path: &Path) -> Result<(), String> {
    set_owner_only_with_mode(path, 0o600, false)
}

/// Restrict directory permissions to owner-only access: Unix `chmod 0o700`; Windows DACL with a
/// single inheritable `GENERIC_ALL` ACE for the current user (contents stay owner-accessible).
pub fn set_owner_only_dir(path: &Path) -> Result<(), String> {
    set_owner_only_with_mode(path, 0o700, true)
}

/// SSOT for [`set_owner_only`] and [`set_owner_only_dir`]. Unix mode differs between files
/// (`0o600`) and dirs (`0o700`); Windows `SE_FILE_OBJECT` handles both, so `_mode` is unused.
fn set_owner_only_with_mode(path: &Path, _mode: u32, _dir_inheritable: bool) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(_mode))
            .map_err(|e| e.to_string())?;
    }

    #[cfg(windows)]
    {
        set_windows_acl_owner_only_in(path, _dir_inheritable)?;
    }

    Ok(())
}

/// File-shaped shim (non-inheritable ACE) for the tempfile-tightening call sites.
#[cfg(windows)]
fn set_windows_acl_owner_only(path: &Path) -> Result<(), String> {
    set_windows_acl_owner_only_in(path, false)
}

/// Restrict a file or directory to the current user only via a Windows DACL.
/// **Returns `Err` on any Win32 failure** — caller must remove/quarantine the target.
#[cfg(windows)]
#[expect(
    unsafe_code,
    reason = "Windows DACL FFI boundary; every block carries a SAFETY comment"
)]
fn set_windows_acl_owner_only_in(path: &Path, dir_inheritable: bool) -> Result<(), String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Foundation::{CloseHandle, GENERIC_ALL};
    use windows_sys::Win32::Security::Authorization::{
        SetEntriesInAclW, SetNamedSecurityInfoW, EXPLICIT_ACCESS_W, GRANT_ACCESS, SE_FILE_OBJECT,
        TRUSTEE_IS_SID, TRUSTEE_IS_USER, TRUSTEE_W,
    };
    use windows_sys::Win32::Security::{
        GetTokenInformation, TokenUser, ACL, DACL_SECURITY_INFORMATION, NO_INHERITANCE,
        PROTECTED_DACL_SECURITY_INFORMATION, SUB_CONTAINERS_AND_OBJECTS_INHERIT, TOKEN_QUERY,
        TOKEN_USER,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    unsafe {
        let mut token_handle = std::mem::zeroed();
        // SAFETY: GetCurrentProcess returns a pseudo-handle needing no close;
        // token_handle is a plain out-param, closed on every exit path below.
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token_handle) == 0 {
            return Err("OpenProcessToken failed".to_string());
        }
        // u64 backing keeps the TOKEN_USER cast below aligned; 256 B exceeds the
        // maximum payload (SID_AND_ATTRIBUTES + SECURITY_MAX_SID_SIZE).
        let mut buf = [0u64; 32];
        let mut returned = 0u32;
        // SAFETY: token_handle is live; buf is writable for the byte length passed.
        // A too-small buffer fails the call and we return Err.
        if GetTokenInformation(
            token_handle,
            TokenUser,
            buf.as_mut_ptr().cast(),
            std::mem::size_of_val(&buf) as u32,
            &mut returned,
        ) == 0
        {
            CloseHandle(token_handle);
            return Err("GetTokenInformation failed".to_string());
        }
        // SAFETY: the call above succeeded, so buf holds an initialized TOKEN_USER;
        // the u64 backing satisfies its pointer alignment.
        let user = &*(buf.as_ptr() as *const TOKEN_USER);
        // Dir ACEs must be inheritable: SetNamedSecurityInfoW propagates to existing
        // children, and a NO_INHERITANCE ACE strips theirs to an empty (deny-all) DACL.
        let inheritance = if dir_inheritable {
            SUB_CONTAINERS_AND_OBJECTS_INHERIT
        } else {
            NO_INHERITANCE
        };
        let ea = EXPLICIT_ACCESS_W {
            grfAccessPermissions: GENERIC_ALL,
            grfAccessMode: GRANT_ACCESS,
            grfInheritance: inheritance,
            Trustee: TRUSTEE_W {
                pMultipleTrustee: std::ptr::null_mut(),
                MultipleTrusteeOperation: 0,
                TrusteeForm: TRUSTEE_IS_SID,
                TrusteeType: TRUSTEE_IS_USER,
                ptstrName: user.User.Sid as *mut _,
            },
        };
        let mut new_acl: *mut ACL = std::ptr::null_mut();
        // SAFETY: ea's SID pointer targets buf, which outlives this call; on success
        // new_acl is a LocalAlloc'd ACL, freed exactly once below.
        if SetEntriesInAclW(1, &ea, std::ptr::null_mut(), &mut new_acl) != 0 {
            CloseHandle(token_handle);
            return Err("SetEntriesInAclW failed".to_string());
        }
        let wide_path: Vec<u16> = path
            .to_string_lossy()
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        // SAFETY: wide_path is NUL-terminated UTF-16 and new_acl is valid from
        // SetEntriesInAclW; both stay alive across the call.
        let rc = SetNamedSecurityInfoW(
            wide_path.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            new_acl,
            std::ptr::null_mut(),
        );
        // SAFETY: new_acl and token_handle are owned here and released exactly once.
        LocalFree(new_acl.cast());
        CloseHandle(token_handle);
        if rc != 0 {
            return Err(format!("SetNamedSecurityInfoW failed: rc={rc}"));
        }
        Ok(())
    }
}

/// Test-only: makes an existing file unreadable by its own owner via a real OS artifact
/// (Unix `chmod 0o000`; Windows a protected empty DACL) — not a mocked error path.
#[cfg(test)]
#[expect(
    clippy::expect_used,
    reason = "test fixture: setup failure must panic, not be swallowed"
)]
pub(crate) fn make_unreadable_for_test(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o000))
            .expect("chmod 0o000 on test artifact must succeed");
    }

    #[cfg(windows)]
    {
        set_windows_acl_empty_for_test(path).expect("empty-DACL test artifact must succeed");
    }
}

/// Test-only: replaces the DACL with a protected, empty one — zero ACEs denies even the
/// owner (icacls `/inheritance:r` would keep `set_windows_acl_owner_only`'s explicit ACE).
#[cfg(all(windows, test))]
#[expect(
    unsafe_code,
    reason = "Windows DACL FFI boundary; every block carries a SAFETY comment"
)]
fn set_windows_acl_empty_for_test(path: &Path) -> Result<(), String> {
    use windows_sys::Win32::Security::Authorization::{SetNamedSecurityInfoW, SE_FILE_OBJECT};
    use windows_sys::Win32::Security::{
        InitializeAcl, ACL, ACL_REVISION, DACL_SECURITY_INFORMATION,
        PROTECTED_DACL_SECURITY_INFORMATION,
    };

    unsafe {
        let mut acl: ACL = std::mem::zeroed();
        let acl_size = std::mem::size_of::<ACL>() as u32;
        // SAFETY: `acl` is a stack-local ACL header sized exactly for zero ACEs;
        // InitializeAcl only writes within `acl_size` bytes of `&mut acl`.
        if InitializeAcl(&mut acl, acl_size, ACL_REVISION) == 0 {
            return Err("InitializeAcl failed".to_string());
        }
        let wide_path: Vec<u16> = path
            .to_string_lossy()
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        // SAFETY: wide_path is NUL-terminated UTF-16 and `acl` is a validly
        // initialized empty ACL that outlives this call.
        let rc = SetNamedSecurityInfoW(
            wide_path.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &acl,
            std::ptr::null_mut(),
        );
        if rc != 0 {
            return Err(format!("SetNamedSecurityInfoW failed: rc={rc}"));
        }
        Ok(())
    }
}

/// Flushes file data to stable media. macOS: `F_FULLFSYNC` with fallback to `fsync` then
/// best-effort no-op on unsupported fs (SMB/NFS). Other Unix: `fsync`. Windows: no-op.
#[cfg(unix)]
pub(crate) fn fsync_file_durable(file: &std::fs::File) -> std::io::Result<()> {
    #[cfg(target_os = "macos")]
    {
        use rustix::io::Errno;
        // `F_FULLFSYNC` unsupported on this fs/device → fall back to `fsync`.
        let fcntl_unsupported = |e: &Errno| {
            matches!(
                *e,
                Errno::NOTSUP | Errno::OPNOTSUPP | Errno::INVAL | Errno::NODEV
            )
        };
        // EINVAL from `fsync` is a bad fd → must propagate, so it's excluded here.
        let fsync_unsupported =
            |e: &Errno| matches!(*e, Errno::NOTSUP | Errno::OPNOTSUPP | Errno::NODEV);
        match rustix::fs::fcntl_fullfsync(file) {
            Ok(()) => Ok(()),
            Err(e) if fcntl_unsupported(&e) => match rustix::fs::fsync(file) {
                Ok(()) => Ok(()),
                // Neither supported (some network FS): best-effort, don't fail.
                Err(e2) if fsync_unsupported(&e2) => Ok(()),
                Err(e2) => Err(std::io::Error::from(e2)),
            },
            Err(e) => Err(std::io::Error::from(e)),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        rustix::fs::fsync(file).map_err(std::io::Error::from)
    }
}

#[cfg(not(unix))]
pub(crate) fn fsync_file_durable(_file: &std::fs::File) -> std::io::Result<()> {
    Ok(())
}

/// Best-effort fsync of a directory so a contained rename is itself durable. Unix-only: opening a
/// directory as a file and fsync-ing it commits the entry; Windows has no directory-fsync concept.
#[cfg(unix)]
pub(crate) fn fsync_parent_dir(dir: &Path) {
    if let Ok(handle) = std::fs::File::open(dir) {
        // Best-effort: a dir-fsync failure is non-fatal.
        let _ = rustix::fs::fsync(&handle);
    }
}

#[cfg(not(unix))]
pub(crate) fn fsync_parent_dir(_dir: &Path) {}

/// Writes `content` to `path` via write-then-atomic-rename, owner-only perms; destination never
/// appears world-readable. Windows DACL failure returns `Err` (ADR-009); pre-existing dirs removed.
pub fn write_restricted_file(path: &Path, content: &str) -> anyhow::Result<()> {
    // Direct callers: `path` is the final name, so commit its directory entry.
    write_restricted_file_synced(path, content, true)
}

/// Core of [`write_restricted_file`]. `sync_parent_dir` = false skips the
/// post-rename dir fsync when the caller renames `path` away next (atomic variant).
fn write_restricted_file_synced(
    path: &Path,
    content: &str,
    sync_parent_dir: bool,
) -> anyhow::Result<()> {
    if path.is_dir() {
        log::warn!(
            "write_restricted_file: removing unexpected directory at {}",
            path.display()
        );
        std::fs::remove_dir_all(path)?;
    }

    // Tempfile must live on the same filesystem as `path` for an atomic rename.
    let parent = path.parent().ok_or_else(|| {
        anyhow::anyhow!(
            "write_restricted_file: path {} has no parent directory",
            path.display()
        )
    })?;
    let mut tmp = NamedTempFile::with_prefix_in(ATOMIC_WRITE_TEMP_PREFIX, parent)?;
    tmp.write_all(content.as_bytes())?;
    tmp.flush()?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // Re-chmod so the bits survive `persist()` replacing the target inode.
        std::fs::set_permissions(tmp.path(), std::fs::Permissions::from_mode(0o600))?;
    }

    #[cfg(windows)]
    {
        // Tighten the DACL on the tempfile before rename (atomic delivery with restricted perms).
        set_windows_acl_owner_only(tmp.path()).map_err(|e| {
            anyhow::anyhow!(
                "DACL tighten failed on tempfile for {}: {} — refusing to leave a world-readable secret",
                path.display(),
                e
            )
        })?;
    }

    #[cfg(not(any(unix, windows)))]
    {
        compile_error!(
            "write_restricted_file: unsupported platform — add file permission logic for this target"
        );
    }

    // fsync data before persist; `tempfile::persist` only renames, never fsyncs.
    fsync_file_durable(tmp.as_file()).map_err(|e| {
        anyhow::anyhow!(
            "fsync tempfile before persist for {}: {}",
            path.display(),
            e
        )
    })?;

    // Atomic rename. On error `tmp` is dropped, never appearing as `path`.
    tmp.persist(path)
        .map_err(|e| anyhow::anyhow!("failed to persist tempfile to {}: {}", path.display(), e))?;

    // fsync parent dir so the rename is durable (skipped for the atomic variant).
    if sync_parent_dir {
        fsync_parent_dir(parent);
    }

    Ok(())
}

/// Atomic variant of [`write_restricted_file`]: writes to a sibling `.tmp` file with owner-only
/// perms, then `rename`s into place. Crash between write and rename leaves destination untouched.
pub fn write_restricted_file_atomic(path: &Path, content: &str) -> anyhow::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("path has no parent: {}", path.display()))?;
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| anyhow::anyhow!("path has no file name: {}", path.display()))?;
    // Atomic counter makes the tmp name unique per call (pid collides across threads).
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    let tmp = parent.join(format!(".{}.tmp.{}.{}", file_name, std::process::id(), seq));

    // `false`: the inner dir fsync is wasted — we rename `tmp` away next line.
    write_restricted_file_synced(&tmp, content, false).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })?;

    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        anyhow::bail!("rename {} -> {}: {}", tmp.display(), path.display(), e);
    }

    // fsync parent dir once for the final name (data already fsynced by the inner write).
    fsync_parent_dir(parent);

    Ok(())
}

/// Atomic write WITHOUT permission tightening — for shared, non-secret files
/// other principals must read (e.g. `.wslconfig`, read by the WSL service).
pub fn write_shared_file_atomic(path: &Path, content: &str) -> anyhow::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("path has no parent: {}", path.display()))?;
    let mut tmp = NamedTempFile::with_prefix_in(ATOMIC_WRITE_TEMP_PREFIX, parent)?;
    tmp.write_all(content.as_bytes())?;
    tmp.flush()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // Tempfiles default to 0600; a shared file must stay world-readable.
        std::fs::set_permissions(tmp.path(), std::fs::Permissions::from_mode(0o644))?;
    }
    fsync_file_durable(tmp.as_file())
        .map_err(|e| anyhow::anyhow!("fsync tempfile for {}: {}", path.display(), e))?;
    tmp.persist(path)
        .map_err(|e| anyhow::anyhow!("failed to persist tempfile to {}: {}", path.display(), e))?;
    fsync_parent_dir(parent);
    Ok(())
}

/// Creates `path` (if missing) and sets owner-only perms. Unix: `chmod 0o700`. Windows: DACL with a
/// single `GENERIC_ALL` ACE for the current user. Idempotent.
pub fn ensure_owner_only_dir(path: &Path) -> anyhow::Result<()> {
    std::fs::create_dir_all(path)?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    }

    #[cfg(windows)]
    {
        set_windows_acl_owner_only_in(path, true).map_err(|e| {
            anyhow::anyhow!("DACL tighten failed on directory {}: {}", path.display(), e)
        })?;
    }

    #[cfg(not(any(unix, windows)))]
    {
        compile_error!(
            "ensure_owner_only_dir: unsupported platform — add directory permission logic"
        );
    }

    Ok(())
}

/// Removes orphaned atomic-write tempfiles (`write-*`) directly under `dir`
/// older than `min_age`. Shallow, best-effort (a per-entry error is skipped,
/// never propagated); returns the count removed.
pub fn sweep_stale_atomic_write_temp_files(dir: &Path, min_age: std::time::Duration) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let now = std::time::SystemTime::now();
    let mut removed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !name.starts_with(ATOMIC_WRITE_TEMP_PREFIX) {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        let Ok(modified) = metadata.modified() else {
            continue;
        };
        let Ok(age) = now.duration_since(modified) else {
            continue;
        };
        if age >= min_age && std::fs::remove_file(entry.path()).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// Reads a file without following a final-component symlink (Unix `O_NOFOLLOW`; Windows
/// `FILE_FLAG_OPEN_REPARSE_POINT` + handle reparse check); regular-file confirmed via the handle.
pub fn read_regular_file_no_follow(path: &Path) -> Result<Option<String>, String> {
    use std::io::Read;

    let mut opts = std::fs::OpenOptions::new();
    opts.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // O_NOFOLLOW: open fails (ELOOP) on a final-component symlink.
        // O_NONBLOCK: a FIFO/device opened read-only must not block waiting for
        // a writer — the is_file() check below rejects it either way.
        opts.custom_flags(
            (rustix::fs::OFlags::NOFOLLOW | rustix::fs::OFlags::NONBLOCK).bits() as i32,
        );
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_FLAG_OPEN_REPARSE_POINT (0x0020_0000): open the reparse point
        // itself, never its target; the handle metadata check below rejects it.
        opts.custom_flags(0x0020_0000);
    }
    let mut file = match opts.open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("cannot open {}: {e}", path.display())),
    };
    // Confirm regular file via the OPEN HANDLE (no path re-resolution).
    let meta = file
        .metadata()
        .map_err(|e| format!("cannot stat {}: {e}", path.display()))?;
    #[cfg(windows)]
    {
        // Same Err a unix O_NOFOLLOW ELOOP produces: a name-surrogate reparse
        // point (symlink/junction) redirects to another path and is refused.
        if meta.file_type().is_symlink() {
            return Err(format!(
                "cannot open {}: refusing symlink/junction",
                path.display()
            ));
        }
    }
    if !meta.file_type().is_file() {
        return Err(format!("not a regular file: {}", path.display()));
    }
    let mut buf = String::new();
    file.read_to_string(&mut buf)
        .map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    Ok(Some(buf))
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "test fixtures assert on setup that must not silently fail"
)]
mod tests {
    use super::*;

    // Unix: root bypasses mode 0o000, so this test relies on CI running unprivileged;
    // we deliberately don't gate it — revisit if a root-run flake ever appears.
    #[test]
    fn make_unreadable_for_test_actually_blocks_reads() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("t");
        std::fs::write(&p, "x").unwrap();
        make_unreadable_for_test(&p);
        let err = std::fs::read(&p).expect_err("read must fail on the planted artifact");
        assert_eq!(err.kind(), std::io::ErrorKind::PermissionDenied);
    }

    #[test]
    fn read_no_follow_reads_regular_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("log.txt");
        std::fs::write(&path, "line1\nline2\n").unwrap();
        assert_eq!(
            read_regular_file_no_follow(&path).unwrap(),
            Some("line1\nline2\n".to_string())
        );
    }

    #[test]
    fn read_no_follow_returns_none_for_missing() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            read_regular_file_no_follow(&dir.path().join("nope")).unwrap(),
            None
        );
    }

    #[cfg(unix)]
    #[test]
    fn read_no_follow_rejects_a_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let secret = dir.path().join("secret.txt");
        std::fs::write(&secret, "sk-ant-SECRET\n").unwrap();
        let link = dir.path().join("log.txt");
        std::os::unix::fs::symlink(&secret, &link).unwrap();
        assert!(
            read_regular_file_no_follow(&link).is_err(),
            "a symlinked source must not be followed"
        );
    }

    /// Plants a directory junction (`mklink /J`, no privilege needed) at
    /// `base/log.txt` and asserts the no-follow read rejects it.
    #[cfg(windows)]
    fn assert_junction_rejected(base: &Path) {
        let target = base.join("real");
        std::fs::create_dir(&target).unwrap();
        std::fs::write(target.join("secret.txt"), "sk-ant-SECRET\n").unwrap();
        let junction = base.join("log.txt");
        // mklink is a cmd builtin; /J junctions need no privilege (unlike symlinks).
        let status = std::process::Command::new("cmd")
            .arg("/C")
            .arg("mklink")
            .arg("/J")
            .arg(&junction)
            .arg(&target)
            .status()
            .expect("cmd /C mklink /J must spawn");
        assert!(status.success(), "junction creation must succeed");
        // Assert the plant: the junction is a name-surrogate reparse point.
        let planted = std::fs::symlink_metadata(&junction).expect("junction must exist");
        assert!(
            planted.file_type().is_symlink(),
            "planted junction must read as a reparse point"
        );
        let r = read_regular_file_no_follow(&junction);
        assert!(
            r.is_err(),
            "a final-component junction must be rejected: {r:?}"
        );
    }

    #[cfg(windows)]
    #[test]
    fn read_no_follow_rejects_a_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let secret = dir.path().join("secret.txt");
        std::fs::write(&secret, "sk-ant-SECRET\n").unwrap();
        let link = dir.path().join("log.txt");
        if let Err(e) = std::os::windows::fs::symlink_file(&secret, &link) {
            // 1314 = ERROR_PRIVILEGE_NOT_HELD (no Developer Mode/admin): fall
            // back to a junction, which needs no privilege, for the same check.
            assert_eq!(
                e.raw_os_error(),
                Some(1314),
                "unexpected symlink_file failure: {e}"
            );
            assert_junction_rejected(dir.path());
            return;
        }
        let r = read_regular_file_no_follow(&link);
        assert!(r.is_err(), "a symlinked source must not be followed: {r:?}");
    }

    #[cfg(windows)]
    #[test]
    fn read_no_follow_rejects_a_junction() {
        let dir = tempfile::tempdir().unwrap();
        assert_junction_rejected(dir.path());
    }

    #[cfg(unix)]
    #[test]
    fn read_no_follow_rejects_a_fifo() {
        use std::os::unix::fs::FileTypeExt;
        let dir = tempfile::tempdir().unwrap();
        let fifo = dir.path().join("log.txt");
        // Skip if mkfifo is unavailable; assert the type check when present.
        if std::process::Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
        {
            assert!(std::fs::symlink_metadata(&fifo)
                .unwrap()
                .file_type()
                .is_fifo());
            // O_NOFOLLOW opens the fifo (not a symlink); the handle-based
            // is_file() check must still reject it.
            let r = read_regular_file_no_follow(&fifo);
            assert!(r.is_err(), "a non-regular file must be rejected: {r:?}");
        }
    }

    #[test]
    fn writes_content_to_new_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("secret.txt");

        write_restricted_file(&path, "hello").unwrap();

        let content = std::fs::read_to_string(&path).unwrap();
        assert_eq!(content, "hello");
    }

    #[test]
    fn shared_atomic_write_replaces_content_without_tightening() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".wslconfig");
        write_shared_file_atomic(&path, "[wsl2]\n").unwrap();
        write_shared_file_atomic(&path, "[wsl2]\nnetworkingMode=mirrored\n").unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "[wsl2]\nnetworkingMode=mirrored\n"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o644, "shared write must stay world-readable");
        }
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

    /// TOCTOU regression guard: tempfile must be 0o600 before persist so the
    /// destination cannot be world-readable.
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

    /// Atomicity smoke test: the destination either doesn't exist or already holds the new content
    /// with the restricted mode — never a partial write with default perms.
    #[cfg(unix)]
    #[test]
    fn destination_never_observed_world_readable_under_overwrite() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("secret");

        // Pre-existing file with world-readable mode (simulates pre-PR1 layout).
        std::fs::write(&path, "old").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();

        // Overwrite — must end with 0o600 and new content.
        write_restricted_file(&path, "new").unwrap();

        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new");
    }

    /// `persist` requires the tempfile on the same filesystem as the destination;
    /// `with_prefix_in(parent)` ensures this — guard against a regression to system tempdir.
    #[test]
    fn tempfile_created_in_destination_parent() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("token");

        // Exercises the `with_prefix_in(parent)` code path.
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
        // A stale `.tmp.<pid>.<seq>` orphan must not affect the next call.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("secret");
        // Manual orphan with a legacy shape that won't collide with the next call.
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

    /// Crash recovery: a process dying between `.tmp` write and `rename` must
    /// leave the destination in its prior state, never truncated or half-written.
    #[test]
    fn atomic_crash_before_rename_leaves_destination_with_old_content() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("secret");

        // Pre-existing destination with known content.
        write_restricted_file_atomic(&path, "old-content").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "old-content");

        // Simulate a crash: orphaned `.tmp` with the rename never happening.
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

        // Subsequent write replaces the destination cleanly despite the orphan.
        write_restricted_file_atomic(&path, "fresh").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "fresh");
    }

    /// Concurrent writes: two atomic writes racing produce one valid destination (rename picks a
    /// winner), never a truncated file. The .tmp cleanup keeps the directory tidy.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn atomic_concurrent_writes_leave_destination_valid() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("secret");
        let path_a = path.clone();
        let path_b = path.clone();

        // Two concurrent writers; `path` must end up with one writer's value.
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

    // ── durability fsync ─────────────────────────────────────────────────

    /// Happy path: fsync of a real, open file succeeds. On macOS this exercises
    /// the `F_FULLFSYNC` branch; on other Unix the `fsync` branch.
    #[cfg(unix)]
    #[test]
    fn fsync_file_durable_ok_on_open_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("f");
        let file = std::fs::File::create(&path).unwrap();
        std::io::Write::write_all(&mut (&file), b"data").unwrap();
        fsync_file_durable(&file).expect("fsync of an open writable file must succeed");
    }

    /// Network-mount regression guard: a target supporting neither `F_FULLFSYNC` nor plain `fsync`
    /// (ENOTSUP) must degrade to best-effort `Ok` — else workers can't start on SMB/NFS homes.
    #[cfg(target_os = "macos")]
    #[test]
    fn fsync_file_durable_best_effort_on_unsupported_fd() {
        // /dev/null supports neither fsync flavour — fcntl returns ENOTSUP/EINVAL.
        let file = std::fs::OpenOptions::new()
            .write(true)
            .open("/dev/null")
            .unwrap();
        assert!(
            fsync_file_durable(&file).is_ok(),
            "unsupported-fsync target must degrade to best-effort, not hard-fail"
        );
    }

    /// Regression: the fsync insertion must not change the observable happy-path
    /// behavior — content and 0o600 perms are still correct after the write.
    #[cfg(unix)]
    #[test]
    fn atomic_write_content_and_mode_survive_fsync() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("compose.yml");

        write_restricted_file_atomic(&path, "networks:\n  net: {}\n").unwrap();

        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "networks:\n  net: {}\n"
        );
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "expected 0o600, got 0o{mode:o}");
    }

    /// `fsync_parent_dir` is best-effort: a non-existent directory must not
    /// panic or propagate (the data blocks are already durable).
    #[cfg(unix)]
    #[test]
    fn fsync_parent_dir_is_best_effort_on_missing_dir() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("does-not-exist");
        // Must be a silent no-op — no panic, returns ().
        fsync_parent_dir(&missing);
    }

    /// Source-ordering guard: the data fsync MUST precede `persist` in
    /// `write_restricted_file_synced`, else the rename can publish a torn file.
    #[test]
    fn fsync_precedes_persist_in_source() {
        let src = include_str!("fs_perms.rs");
        let body = src
            .split("fn write_restricted_file_synced(")
            .nth(1)
            .and_then(|s| s.split("\n}").next())
            .expect("write_restricted_file_synced body");
        let fsync_at = body
            .find("fsync_file_durable(tmp.as_file())")
            .expect("write_restricted_file_synced must fsync the tempfile");
        let persist_at = body
            .find("tmp.persist(path)")
            .expect("write_restricted_file_synced must persist the tempfile");
        assert!(
            fsync_at < persist_at,
            "fsync_file_durable must run BEFORE tmp.persist — reordering reintroduces the torn-write bug"
        );
    }

    // ── set_owner_only (file) / set_owner_only_dir ───────────────────────

    #[test]
    fn set_owner_only_sets_600_on_regular_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("secret.txt");
        std::fs::File::create(&path)
            .unwrap()
            .write_all(b"secret")
            .unwrap();

        set_owner_only(&path).unwrap();

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "expected 0o600, got 0o{mode:o}");
        }
    }

    #[test]
    fn set_owner_only_preserves_file_content() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("data.json");
        std::fs::write(&path, r#"{"key":"value"}"#).unwrap();

        set_owner_only(&path).unwrap();

        let content = std::fs::read_to_string(&path).unwrap();
        assert_eq!(content, r#"{"key":"value"}"#);
    }

    #[test]
    fn set_owner_only_fails_on_nonexistent_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("does_not_exist.txt");

        let result = set_owner_only(&path);
        assert!(result.is_err(), "should fail on nonexistent file");
    }

    #[test]
    fn set_owner_only_works_on_empty_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("empty.txt");
        std::fs::File::create(&path).unwrap();

        set_owner_only(&path).unwrap();

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "expected 0o600, got 0o{mode:o}");
        }
    }

    #[test]
    fn set_owner_only_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("token");
        std::fs::write(&path, "abc123").unwrap();

        set_owner_only(&path).unwrap();
        set_owner_only(&path).unwrap();

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "expected 0o600, got 0o{mode:o}");
        }
    }

    #[test]
    fn set_owner_only_dir_sets_700_on_unix() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("subdir");
        std::fs::create_dir(&target).unwrap();

        set_owner_only_dir(&target).unwrap();

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&target).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o700, "expected 0o700, got 0o{mode:o}");
        }
    }

    #[test]
    fn set_owner_only_dir_works_on_existing_dir() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("existing");
        std::fs::create_dir(&target).unwrap();
        // Place a file inside — perms change on dir must not affect contents.
        std::fs::write(target.join("file.txt"), b"contents").unwrap();

        set_owner_only_dir(&target).unwrap();

        let content = std::fs::read_to_string(target.join("file.txt")).unwrap();
        assert_eq!(content, "contents");
    }

    #[test]
    fn ensure_owner_only_dir_keeps_existing_contents_readable() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("ensure-existing");
        std::fs::create_dir(&target).unwrap();
        // Re-tightening an existing dir must not lock the owner out of its
        // contents (Windows: the inheritable-ACE propagation contract).
        std::fs::write(target.join("file.txt"), b"contents").unwrap();

        ensure_owner_only_dir(&target).unwrap();

        let content = std::fs::read_to_string(target.join("file.txt")).unwrap();
        assert_eq!(content, "contents");
    }

    #[test]
    fn set_owner_only_dir_fails_on_nonexistent_path() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("does_not_exist");

        let result = set_owner_only_dir(&target);
        assert!(result.is_err(), "should fail on nonexistent directory");
    }

    #[cfg(unix)]
    #[test]
    fn set_owner_only_tightens_world_readable_file() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("loose.txt");
        std::fs::write(&path, "open").unwrap();

        // Start with 0o644 (world-readable).
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();

        set_owner_only(&path).unwrap();

        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(
            mode, 0o600,
            "expected 0o600 after tightening, got 0o{mode:o}"
        );
    }

    // ── sweep_stale_atomic_write_temp_files ──────────────────────────────

    /// Backdates a file's mtime by `age` so an age-based sweep sees it as stale.
    fn backdate(path: &Path, age: std::time::Duration) {
        let file = std::fs::OpenOptions::new().write(true).open(path).unwrap();
        let stamp = std::time::SystemTime::now() - age;
        file.set_modified(stamp).unwrap();
    }

    #[test]
    fn sweep_removes_only_stale_write_prefixed_files() {
        let dir = tempfile::tempdir().unwrap();
        let stale = dir.path().join("write-abc123");
        let fresh = dir.path().join("write-def456");
        let unrelated = dir.path().join("other-file.txt");
        std::fs::write(&stale, "orphan").unwrap();
        std::fs::write(&fresh, "just written").unwrap();
        std::fs::write(&unrelated, "keep me").unwrap();
        backdate(&stale, std::time::Duration::from_secs(3600));

        let removed =
            sweep_stale_atomic_write_temp_files(dir.path(), std::time::Duration::from_secs(60));

        assert_eq!(removed, 1);
        assert!(!stale.exists(), "stale write-* orphan must be removed");
        assert!(fresh.exists(), "a fresh write-* tempfile must survive");
        assert!(
            unrelated.exists(),
            "non-prefixed files must never be touched"
        );
    }

    #[test]
    fn sweep_is_shallow_and_ignores_subdirectories() {
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("write-looks-like-a-dir");
        std::fs::create_dir(&sub).unwrap();
        let nested = sub.join("write-nested");
        std::fs::write(&nested, "should not be reached").unwrap();

        let removed =
            sweep_stale_atomic_write_temp_files(dir.path(), std::time::Duration::from_secs(0));

        assert_eq!(removed, 0, "a directory named like a tempfile is skipped");
        assert!(nested.exists(), "the sweep must not recurse");
    }

    #[test]
    fn sweep_on_missing_directory_is_a_no_op() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("does-not-exist");

        let removed =
            sweep_stale_atomic_write_temp_files(&missing, std::time::Duration::from_secs(0));

        assert_eq!(removed, 0);
    }

    #[test]
    fn sweep_leaves_a_persisted_atomic_write_output_untouched() {
        // The final file from write_shared_file_atomic has no "write-" prefix —
        // confirms the sweep only ever targets orphaned tempfiles, never real data.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pending-teardowns");
        write_shared_file_atomic(&path, "proj-a").unwrap();

        let removed =
            sweep_stale_atomic_write_temp_files(dir.path(), std::time::Duration::from_secs(0));

        assert_eq!(removed, 0);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "proj-a");
    }
}
