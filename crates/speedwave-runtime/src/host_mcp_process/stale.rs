//! Stale-process detection helpers shared by every host MCP worker
//! manager.
//!
//! The generic [`super::process::HostMcpProcess::spawn_with_spec`]
//! reads the PID from `lock.json` and gates the kill behind
//! `is_node_process` so a recycled PID for a non-node process is not
//! touched.

#[cfg(unix)]
use std::process::Command;

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

/// `true` if `pid` is a `node` process (Windows; matches the image name).
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

/// Terminate a process by PID (`taskkill /F` on Windows). Errors are ignored —
/// the process may already be gone.
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
    fn is_node_process_returns_false_for_pid_1() {
        // PID 1 is init/launchd on every Unix and System on Windows.
        assert!(!is_node_process(1));
    }

    #[cfg(unix)]
    #[test]
    fn is_node_process_returns_false_for_nonexistent_pid() {
        // Almost certainly not a node process (PID this high is rare).
        assert!(!is_node_process(u32::MAX - 1));
    }
}
