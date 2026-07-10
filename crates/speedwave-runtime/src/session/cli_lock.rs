//! Live-CLI-session marker: a shared file lock the kernel releases on any
//! process death, probed by Desktop's exit cleanup before VM teardown.

use std::fs::File;
use std::path::Path;

/// Holds the shared lock for the lifetime of a CLI interactive session.
pub struct CliSessionGuard {
    _file: File,
}

impl CliSessionGuard {
    /// Takes a shared lock on `<data_dir>/cli-session.lock` (creates both).
    pub fn acquire(data_dir: &Path) -> std::io::Result<Self> {
        std::fs::create_dir_all(data_dir)?;
        let file = File::options()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(data_dir.join(crate::consts::CLI_SESSION_LOCK_FILE))?;
        file.lock_shared()?;
        Ok(Self { _file: file })
    }
}

/// True when at least one live CLI session holds the shared lock.
pub fn any_cli_session_active(data_dir: &Path) -> bool {
    let Ok(file) = File::open(data_dir.join(crate::consts::CLI_SESSION_LOCK_FILE)) else {
        return false;
    };
    match file.try_lock() {
        // Exclusive lock acquired: no shared holders, released on close below.
        Ok(()) => false,
        Err(std::fs::TryLockError::WouldBlock) => true,
        Err(std::fs::TryLockError::Error(e)) => {
            log::warn!("CLI session probe failed ({e}); assuming no live session");
            false
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn probe_is_false_when_lock_file_absent() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(!any_cli_session_active(tmp.path()));
    }

    #[test]
    fn guard_marks_session_active() {
        let tmp = tempfile::tempdir().unwrap();
        let _guard = CliSessionGuard::acquire(tmp.path()).unwrap();
        assert!(any_cli_session_active(tmp.path()));
    }

    #[test]
    fn dropping_guard_releases_session() {
        let tmp = tempfile::tempdir().unwrap();
        let guard = CliSessionGuard::acquire(tmp.path()).unwrap();
        drop(guard);
        assert!(!any_cli_session_active(tmp.path()));
    }

    #[test]
    fn concurrent_guards_require_both_drops() {
        let tmp = tempfile::tempdir().unwrap();
        let first = CliSessionGuard::acquire(tmp.path()).unwrap();
        let second = CliSessionGuard::acquire(tmp.path()).unwrap();
        drop(first);
        assert!(
            any_cli_session_active(tmp.path()),
            "second session still live"
        );
        drop(second);
        assert!(!any_cli_session_active(tmp.path()));
    }

    #[test]
    fn acquire_creates_missing_data_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let nested = tmp.path().join("fresh").join("data");
        let _guard = CliSessionGuard::acquire(&nested).unwrap();
        assert!(any_cli_session_active(&nested));
    }

    #[test]
    fn probe_is_false_on_stale_unlocked_file() {
        // A crash leaves the file behind; the kernel already dropped the lock.
        let tmp = tempfile::tempdir().unwrap();
        {
            let _guard = CliSessionGuard::acquire(tmp.path()).unwrap();
        }
        assert!(tmp
            .path()
            .join(crate::consts::CLI_SESSION_LOCK_FILE)
            .is_file());
        assert!(!any_cli_session_active(tmp.path()));
    }
}
