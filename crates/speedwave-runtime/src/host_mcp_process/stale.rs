//! Stale-process detection and termination shared by every host MCP
//! worker manager.
//!
//! On startup, each manager reads a PID from disk (left by the previous
//! session), verifies it still points to a `node` process, then kills
//! it. The "is this still node?" check protects us from killing
//! unrelated PIDs that the OS may have recycled.

use std::path::Path;
use std::process::Command;

/// Read a PID from `pid_path`, verify it belongs to a `node` process,
/// kill it, and remove the PID file. No-op if the file is missing,
/// unreadable, or contains a non-positive integer. Best-effort — never
/// returns an error; cleanup happens before a fresh spawn so a stale
/// PID file is recoverable from on the next start.
pub fn kill_stale_by_pid_file(pid_path: &Path) {
    let pid_str = match std::fs::read_to_string(pid_path) {
        Ok(s) => s.trim().to_string(),
        Err(_) => return,
    };
    let pid: u32 = match pid_str.parse() {
        Ok(p) if p > 0 => p,
        _ => return,
    };

    if !is_node_process(pid) {
        log::debug!("stale PID {pid} is not a node process — skipping kill");
        let _ = std::fs::remove_file(pid_path);
        return;
    }

    log::info!("killing stale node process (PID {pid})");
    kill_process(pid);
    let _ = std::fs::remove_file(pid_path);
}

/// Check whether a PID belongs to a `node` process. Used as a safety
/// gate before killing — if the OS recycled the PID into something
/// else, we won't touch it.
#[cfg(unix)]
pub fn is_node_process(pid: u32) -> bool {
    let output = Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "comm="])
        .output();
    match output {
        Ok(o) if o.status.success() => {
            let comm = String::from_utf8_lossy(&o.stdout);
            comm.trim().contains("node")
        }
        _ => false,
    }
}

#[cfg(windows)]
pub fn is_node_process(pid: u32) -> bool {
    let output = crate::binary::system_command("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
        .output();
    match output {
        Ok(o) if o.status.success() => {
            let text = String::from_utf8_lossy(&o.stdout);
            text.to_lowercase().contains("node")
        }
        _ => false,
    }
}

/// Terminate a process by PID. SIGTERM then SIGKILL on Unix (500 ms
/// grace), `taskkill /F` on Windows. Errors are ignored — the process
/// may already be gone.
#[cfg(unix)]
pub fn kill_process(pid: u32) {
    let _ = Command::new("kill")
        .args(["-TERM", &pid.to_string()])
        .status();
    std::thread::sleep(std::time::Duration::from_millis(500));
    let _ = Command::new("kill")
        .args(["-KILL", &pid.to_string()])
        .status();
}

#[cfg(windows)]
pub fn kill_process(pid: u32) {
    let _ = crate::binary::system_command("taskkill")
        .args(["/F", "/PID", &pid.to_string()])
        .status();
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn kill_stale_missing_file_is_noop() {
        let dir = tempfile::tempdir().unwrap();
        let pid_path = dir.path().join("does-not-exist");
        kill_stale_by_pid_file(&pid_path);
    }

    #[test]
    fn kill_stale_invalid_pid_skips_kill_and_keeps_file() {
        let dir = tempfile::tempdir().unwrap();
        let pid_path = dir.path().join("pid");
        std::fs::write(&pid_path, "not-a-number").unwrap();
        kill_stale_by_pid_file(&pid_path);
        assert!(
            pid_path.exists(),
            "non-numeric pid keeps the file untouched"
        );
    }

    #[test]
    fn kill_stale_zero_pid_skips_kill() {
        let dir = tempfile::tempdir().unwrap();
        let pid_path = dir.path().join("pid");
        std::fs::write(&pid_path, "0").unwrap();
        kill_stale_by_pid_file(&pid_path);
        assert!(pid_path.exists(), "zero pid keeps the file untouched");
    }

    #[test]
    fn kill_stale_non_node_pid_removes_file_but_does_not_kill() {
        let dir = tempfile::tempdir().unwrap();
        let pid_path = dir.path().join("pid");
        // PID 1 (init/launchd) exists, is not node, must not be killed.
        std::fs::write(&pid_path, "1").unwrap();
        kill_stale_by_pid_file(&pid_path);
        assert!(
            !pid_path.exists(),
            "non-node PID still triggers PID-file cleanup"
        );
    }

    #[test]
    fn is_node_process_returns_false_for_pid_1() {
        // PID 1 is init/launchd on every Unix and System on Windows.
        assert!(!is_node_process(1));
    }
}
