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
        assert!(released(tmp.path()));
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
        assert!(released(tmp.path()));
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
        assert!(!probe_says_active(Ok(())));
        assert!(probe_says_active(Err(std::fs::TryLockError::WouldBlock)));
        assert!(probe_says_active(Err(std::fs::TryLockError::Error(
            std::io::Error::other("io hiccup")
        ))));
    }

    #[test]
    fn probe_is_false_on_stale_unlocked_file() {
        let tmp = tempfile::tempdir().unwrap();
        {
            let _guard = CliSessionGuard::acquire(tmp.path()).unwrap();
        }
        assert!(tmp
            .path()
            .join(crate::consts::CLI_SESSION_LOCK_FILE)
            .is_file());
        assert!(released(tmp.path()));
    }

    #[test]
    fn released_waits_out_a_lock_held_for_a_moment() {
        let tmp = tempfile::tempdir().unwrap();
        let guard = CliSessionGuard::acquire(tmp.path()).unwrap();
        let holder = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(100));
            drop(guard);
        });

        assert!(released(tmp.path()));
        holder.join().unwrap();
    }

    #[test]
    fn released_reports_a_lock_that_stays_held() {
        let tmp = tempfile::tempdir().unwrap();
        let _guard = CliSessionGuard::acquire(tmp.path()).unwrap();

        assert!(!released_within(
            tmp.path(),
            std::time::Duration::from_millis(50)
        ));
    }

    fn released(data_dir: &Path) -> bool {
        released_within(data_dir, std::time::Duration::from_secs(5))
    }

    fn released_within(data_dir: &Path, limit: std::time::Duration) -> bool {
        let deadline = std::time::Instant::now() + limit;
        while any_cli_session_active(data_dir) {
            if std::time::Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        true
    }
}
