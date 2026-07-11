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
    probe_says_active(file.try_lock())
}

/// Maps the exclusive-probe outcome (`Ok` = no shared holders). Inconclusive
/// fails toward active: a skipped VM stop is recoverable, a killed session is not.
fn probe_says_active(probe: Result<(), std::fs::TryLockError>) -> bool {
    match probe {
        Ok(()) => false,
        Err(std::fs::TryLockError::WouldBlock) => true,
        Err(std::fs::TryLockError::Error(e)) => {
            log::warn!("CLI session probe inconclusive ({e}); assuming a live session");
            true
        }
    }
}

#[cfg(test)]
#[expect(clippy::unwrap_used, reason = "test code asserts via unwrap")]
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
    fn inconclusive_probe_counts_as_active() {
        // Wrongly skipping a VM stop is recoverable; powering the VM off under
        // a live session is not — an inconclusive probe must fail toward active.
        assert!(!probe_says_active(Ok(())));
        assert!(probe_says_active(Err(std::fs::TryLockError::WouldBlock)));
        assert!(probe_says_active(Err(std::fs::TryLockError::Error(
            std::io::Error::other("io hiccup")
        ))));
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
