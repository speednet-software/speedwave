//! Lock files of the Desktop relay for host-mode Custom MCP servers:
//! `<data_dir>/custom-mcp/<project>/relay/<port>.lock`, written only by the Desktop.

use super::paths::relay_lock_dir_in;
use crate::consts;
use serde::{Deserialize, Serialize};
use std::path::Path;

/// Body of a relay lock file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RelayLock {
    /// Project the relay serves.
    pub project: String,
    /// PID of the Desktop process running the relay.
    pub pid: u32,
    /// Host port the relay listens on.
    pub port: u16,
}

fn read_lock(path: &Path) -> Option<RelayLock> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

/// `true` when a relay lock of `project` names a live process; a missing or unreadable
/// directory, a malformed lock, another project's lock or a dead PID count as not running.
pub fn is_running_in(data_dir: &Path, project: &str) -> bool {
    let Ok(dir) = relay_lock_dir_in(data_dir, project) else {
        return false;
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return false;
    };
    entries
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some(consts::CUSTOM_RELAY_LOCK_EXT))
        .filter_map(|p| read_lock(&p))
        .any(|lock| {
            lock.project == project
                && lock.port != 0
                && crate::host_mcp_process::probe::is_pid_alive(lock.pid)
        })
}

/// [`is_running_in`] under the Speedwave data dir.
pub fn is_running(project: &str) -> bool {
    is_running_in(consts::data_dir(), project)
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code: panics on setup failure are acceptable"
)]
mod tests {
    use super::*;

    fn write_lock(data_dir: &Path, project: &str, file: &str, lock: &RelayLock) {
        let dir = relay_lock_dir_in(data_dir, project).unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(file), serde_json::to_string(lock).unwrap()).unwrap();
    }

    fn lock(project: &str, pid: u32, port: u16) -> RelayLock {
        RelayLock {
            project: project.into(),
            pid,
            port,
        }
    }

    #[test]
    fn a_missing_lock_dir_is_not_running() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(!is_running_in(tmp.path(), "acme"));
    }

    #[test]
    fn an_empty_lock_dir_is_not_running() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(relay_lock_dir_in(tmp.path(), "acme").unwrap()).unwrap();
        assert!(!is_running_in(tmp.path(), "acme"));
    }

    #[test]
    fn a_lock_of_a_live_process_is_running() {
        let tmp = tempfile::tempdir().unwrap();
        write_lock(
            tmp.path(),
            "acme",
            "4100.lock",
            &lock("acme", std::process::id(), 4100),
        );
        assert!(is_running_in(tmp.path(), "acme"));
    }

    #[test]
    fn a_lock_of_a_dead_process_is_not_running() {
        let tmp = tempfile::tempdir().unwrap();
        write_lock(
            tmp.path(),
            "acme",
            "4100.lock",
            &lock("acme", crate::host_mcp_process::probe::exited_pid(), 4100),
        );
        assert!(!is_running_in(tmp.path(), "acme"));
    }

    #[test]
    fn one_live_lock_among_stale_ones_is_running() {
        let tmp = tempfile::tempdir().unwrap();
        write_lock(
            tmp.path(),
            "acme",
            "4100.lock",
            &lock("acme", crate::host_mcp_process::probe::exited_pid(), 4100),
        );
        write_lock(
            tmp.path(),
            "acme",
            "4101.lock",
            &lock("acme", std::process::id(), 4101),
        );
        assert!(is_running_in(tmp.path(), "acme"));
    }

    #[test]
    fn another_projects_lock_does_not_count() {
        let tmp = tempfile::tempdir().unwrap();
        write_lock(
            tmp.path(),
            "acme",
            "4100.lock",
            &lock("other", std::process::id(), 4100),
        );
        assert!(!is_running_in(tmp.path(), "acme"));
    }

    #[test]
    fn malformed_zero_port_and_foreign_files_do_not_count() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = relay_lock_dir_in(tmp.path(), "acme").unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("4100.lock"), "{not json").unwrap();
        write_lock(
            tmp.path(),
            "acme",
            "4102.lock",
            &lock("acme", std::process::id(), 0),
        );
        write_lock(
            tmp.path(),
            "acme",
            "4103.json",
            &lock("acme", std::process::id(), 4103),
        );
        assert!(!is_running_in(tmp.path(), "acme"));
    }

    #[test]
    fn unknown_lock_fields_are_tolerated() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = relay_lock_dir_in(tmp.path(), "acme").unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("4101.lock"),
            format!(
                r#"{{"project":"acme","pid":{},"port":4101,"extra":1}}"#,
                std::process::id()
            ),
        )
        .unwrap();
        assert!(is_running_in(tmp.path(), "acme"));
    }

    #[test]
    fn an_invalid_project_name_is_not_running() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(!is_running_in(tmp.path(), "../acme"));
    }
}
