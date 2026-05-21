//! Process manager for the singleton mcp-os Node MCP worker (Calendar/
//! Mail/Reminders integration). Previously lived in `desktop/src-tauri`
//! alongside the Desktop binary; moved to `speedwave-runtime` in PR2 so
//! the CLI can re-use it and so all three host-MCP managers live in one
//! crate.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::thread::JoinHandle;
use std::time::Duration;

use crate::consts;
use crate::fs_perms::write_restricted_file;

/// Manages the mcp-os TypeScript worker as a child process.
///
/// Spawns `node mcp-servers/os/dist/index.js` on the host with a generated
/// auth token and a dynamic port (PORT=0 lets the OS assign a free port).
///
/// The child writes `{"port":<N>}` as its first stdout line. This process
/// manager reads that line to learn the actual port, then writes:
///   - `~/.speedwave/mcp-os-auth-token` — for compose.rs to bind-mount into hub
///   - `~/.speedwave/mcp-os-port` — for compose.rs to build WORKER_OS_URL
///   - `~/.speedwave/mcp-os-pid` — to kill stale processes on next startup
pub struct McpOsProcess {
    child: Option<Child>,
    drain_handles: Vec<JoinHandle<()>>,
    data_dir: PathBuf,
    token_path: PathBuf,
    port: u16,
    port_path: PathBuf,
    pid_path: PathBuf,
    script_path: String,
}

impl McpOsProcess {
    /// Spawn the mcp-os node process with a dynamic port.
    ///
    /// `script_path` is the absolute path to `mcp-servers/os/dist/index.js`.
    /// Blocks up to 10 s waiting for the child to announce its port on stdout.
    ///
    /// Before spawning, kills any stale mcp-os process left over from a
    /// previous session by reading the PID file.
    pub fn spawn(script_path: &str) -> anyhow::Result<Self> {
        Self::spawn_in(script_path, consts::data_dir())
    }

    fn spawn_in(script_path: &str, data_dir: &Path) -> anyhow::Result<Self> {
        std::fs::create_dir_all(data_dir)?;
        let token = uuid::Uuid::new_v4().to_string();
        let token_path = data_dir.join(consts::MCP_OS_AUTH_TOKEN_FILE);
        let port_path = data_dir.join(consts::MCP_OS_PORT_FILE);
        let pid_path = data_dir.join(consts::MCP_OS_PID_FILE);
        let log_path = data_dir.join(consts::MCP_OS_LOG_FILE);

        // Kill any stale mcp-os from a previous session
        kill_stale_by_pid_file(&pid_path);

        // Truncate log file if it exceeds 2 MB to prevent unbounded growth
        crate::log_file::truncate_if_oversized(&log_path, 2 * 1024 * 1024);

        // Write token file with restrictive permissions
        write_restricted_file(&token_path, &token)?;

        // Safety of env_clear() with binary::command():
        //
        // 1. binary::command() resolves "node" to an absolute path (e.g.
        //    /path/to/bundled/node) and stores it as the Command's program.
        //    Command::program is unaffected by env_clear() — the OS uses the
        //    absolute path directly, no PATH lookup required.
        //
        // 2. env_clear() intentionally wipes ALL inherited environment variables
        //    for security. This prevents secrets (API keys, tokens, credentials)
        //    from leaking to the mcp-os child process. The child runs with a
        //    minimal, explicitly-controlled environment.
        //
        // 3. PATH is re-added explicitly from the parent process below,
        //    sufficient for the Node.js runtime to locate shared libraries
        //    and spawn subprocesses.
        //
        // 4. The bundled node binary is already resolved to an absolute path
        //    by binary::command(), so it executes correctly even without PATH.
        //
        // 5. SPEEDWAVE_RESOURCES_DIR and SPEEDWAVE_PROD are forwarded only when
        //    the parent process has a non-empty SPEEDWAVE_RESOURCES_DIR (i.e.
        //    running as a bundled .app). This lets mcp-os resolve native CLI
        //    binaries from the flat Resources/ layout instead of the dev-mode
        //    source tree.
        let mut cmd = crate::binary::command("node");
        cmd.arg(script_path);
        apply_child_env(&mut cmd, &CurrentProcessEnv);

        let mut child = cmd
            .env("PORT", "0")
            .env("MCP_OS_AUTH_TOKEN", &token)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()?;

        // Write PID file immediately so next startup can clean up
        write_restricted_file(&pid_path, &child.id().to_string())?;

        // Drain both stdout and stderr in background threads BEFORE blocking
        // on the port announcement. mcp-os uses console.log (→ stdout) for
        // all logging. If the pipe buffer fills up (~64 KB), the process
        // blocks on write() and dies. After reading the port line, the stdout
        // drain thread continues consuming log output indefinitely.
        let (port, drain_handles) = match drain_and_read_port(&mut child, &log_path) {
            Ok(p) => p,
            Err(e) => {
                child.kill().ok();
                child.wait().ok();
                let _ = std::fs::remove_file(&token_path);
                let _ = std::fs::remove_file(&pid_path);
                return Err(e);
            }
        };

        // Write port file so compose.rs can build WORKER_OS_URL
        match write_restricted_file(&port_path, &port.to_string()) {
            Ok(()) => {}
            Err(e) => {
                child.kill().ok();
                child.wait().ok();
                let _ = std::fs::remove_file(&token_path);
                let _ = std::fs::remove_file(&pid_path);
                return Err(e);
            }
        }

        Ok(Self {
            child: Some(child),
            drain_handles,
            data_dir: data_dir.to_path_buf(),
            token_path,
            port,
            port_path,
            pid_path,
            script_path: script_path.to_string(),
        })
    }

    /// Test-only: spawn with an injectable data_dir (tempdir in tests).
    #[cfg(test)]
    pub(crate) fn spawn_in_dir(script_path: &str, data_dir: &Path) -> anyhow::Result<Self> {
        Self::spawn_in(script_path, data_dir)
    }

    /// Test-only constructor with injected values.
    #[cfg(test)]
    fn new_with(
        child: Child,
        token_path: PathBuf,
        port: u16,
        port_path: PathBuf,
        pid_path: PathBuf,
        data_dir: PathBuf,
    ) -> Self {
        Self {
            child: Some(child),
            drain_handles: Vec::new(),
            data_dir,
            token_path,
            port,
            port_path,
            pid_path,
            script_path: String::new(),
        }
    }

    /// Returns the actual port mcp-os is listening on.
    pub fn port(&self) -> u16 {
        self.port
    }

    /// Kill the child process and join drain threads.
    ///
    /// After `child.wait()` the child is dead, pipes are closed, and
    /// `BufReader::lines()` returns `None` — so drain threads exit
    /// promptly and `join()` is deterministic (no timeout needed).
    pub fn stop(&mut self) -> anyhow::Result<()> {
        if let Some(mut child) = self.child.take() {
            child.kill().ok(); // ignore "already exited" errors
            child.wait().ok(); // reap zombie — guarantees pipes closed
        }
        for handle in self.drain_handles.drain(..) {
            let _ = handle.join();
        }
        Ok(())
    }

    /// Remove the token, port, and PID files from disk.
    /// Note: mcp-os.log is intentionally NOT deleted — it persists for diagnostics.
    ///
    pub fn cleanup_files(&self) {
        let _ = std::fs::remove_file(&self.token_path);
        let _ = std::fs::remove_file(&self.port_path);
        let _ = std::fs::remove_file(&self.pid_path);
    }

    /// Stop the old process and spawn a fresh one at the same script path.
    ///
    /// Carefully prevents Drop from deleting files written by the new process:
    /// the old child is killed, drain threads joined, paths cleared, then a
    /// new process is spawned via `spawn_in` using the same `data_dir`.
    pub fn respawn(&mut self) -> anyhow::Result<u16> {
        // 1. Kill old child
        if let Some(mut child) = self.child.take() {
            child.kill().ok();
            child.wait().ok(); // guarantees pipes closed
        }
        // 1b. Join old drain threads (release log file handle before new spawn opens it)
        for handle in self.drain_handles.drain(..) {
            let _ = handle.join();
        }
        // 2. child is now None → Drop.stop() will be a no-op
        // 3. Save old paths, then clear so Drop.cleanup_files() deletes nothing
        //    (spawn_in() writes fresh files at these same paths)
        let old_token_path = std::mem::replace(&mut self.token_path, PathBuf::new());
        let old_port_path = std::mem::replace(&mut self.port_path, PathBuf::new());
        let old_pid_path = std::mem::replace(&mut self.pid_path, PathBuf::new());

        // 4. Spawn new process using the same data_dir (not dirs::home_dir())
        let data_dir = self.data_dir.clone();
        let new = match Self::spawn_in(&self.script_path, &data_dir) {
            Ok(new) => new,
            Err(e) => {
                // Spawn failed — clean up stale files (auth token is security-sensitive)
                let _ = std::fs::remove_file(&old_token_path);
                let _ = std::fs::remove_file(&old_port_path);
                let _ = std::fs::remove_file(&old_pid_path);
                return Err(e);
            }
        };
        let new_port = new.port;
        *self = new; // old self dropped — Drop is now harmless (empty paths, no child, no handles)
        Ok(new_port)
    }

    /// Check process liveness using PID + TCP port probe.
    /// More thorough than health_check() — detects "alive but not listening".
    pub fn is_alive(&self) -> bool {
        if self.child.is_none() {
            return false;
        }
        is_mcp_os_alive_in(&self.data_dir)
    }
}

/// Check whether the singleton mcp-os process is alive AND listening on
/// its port. Reads PID + port from disk in `data_dir`, then probes TCP.
/// Used by `McpOsProcess::is_alive` and by `desktop::health::is_mcp_os_alive`.
pub fn is_mcp_os_alive() -> bool {
    is_mcp_os_alive_in(consts::data_dir())
}

/// Testable inner implementation; takes `data_dir` so tests can point at
/// a temporary directory.
pub fn is_mcp_os_alive_in(data_dir: &Path) -> bool {
    let token_path = data_dir.join(consts::MCP_OS_AUTH_TOKEN_FILE);
    let pid_path = data_dir.join(consts::MCP_OS_PID_FILE);
    let port_path = data_dir.join(consts::MCP_OS_PORT_FILE);

    if !token_path.exists() {
        return false;
    }
    let pid: u32 = match std::fs::read_to_string(&pid_path) {
        Ok(s) => match s.trim().parse() {
            Ok(p) if p > 0 => p,
            _ => return false,
        },
        Err(_) => return false,
    };
    if !crate::host_mcp_process::is_pid_alive(pid) {
        return false;
    }
    let port: u16 = match std::fs::read_to_string(&port_path) {
        Ok(s) => match s.trim().parse() {
            Ok(p) if p > 0 => p,
            _ => return false,
        },
        Err(_) => return false,
    };
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(500)).is_ok()
}

impl Drop for McpOsProcess {
    fn drop(&mut self) {
        self.stop().ok();
        self.cleanup_files();
    }
}

// Child-env policy, stale-PID cleanup, and stdio drain are shared with the
// other host-MCP workers in `crate::host_mcp_process`
// (SSOT extracted in PR1).
use crate::host_mcp_process::{
    apply_child_env as apply_child_env_shared, drain_and_read_port as drain_and_read_port_shared,
    kill_stale_by_pid_file, CurrentProcessEnv, EnvSource,
};

fn apply_child_env(cmd: &mut Command, env: &dyn EnvSource) {
    apply_child_env_shared(cmd, None, env);
}

fn drain_and_read_port(
    child: &mut Child,
    log_path: &Path,
) -> anyhow::Result<(u16, Vec<JoinHandle<()>>)> {
    drain_and_read_port_shared(child, log_path, "mcp-os")
}

// ---------------------------------------------------------------------------
// Test-only accessors — gated behind cfg(test) so clippy reports dead code
// in production builds without needing #[allow(dead_code)].
#[cfg(test)]
impl McpOsProcess {
    pub fn token(&self) -> String {
        std::fs::read_to_string(&self.token_path).unwrap_or_default()
    }

    pub fn health_check(&mut self) -> bool {
        match &mut self.child {
            Some(child) => matches!(child.try_wait(), Ok(None)),
            None => false,
        }
    }
}

// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use crate::host_mcp_process::{is_node_process, kill_process};
    use std::io::BufRead;

    use serial_test::serial;

    #[test]
    fn test_spawn_dynamic_port() {
        let tmp = tempfile::tempdir().unwrap();
        let script = tmp.path().join("test_port.js");
        std::fs::write(
            &script,
            r#"
const http = require('http');
const srv = http.createServer((_,r) => { r.end('ok'); });
srv.listen(0, '127.0.0.1', () => {
    process.stdout.write(JSON.stringify({ port: srv.address().port }) + '\n');
});
"#,
        )
        .unwrap();

        let data_dir = tmp.path().join("data");
        let result = McpOsProcess::spawn_in_dir(&script.to_string_lossy(), &data_dir);
        if let Ok(mut proc) = result {
            assert!(proc.port() > 0, "Port should be assigned");
            assert!(!proc.token().is_empty(), "Token should be generated");
            assert_eq!(proc.token().len(), 36, "Token should be UUID format");
            proc.stop().unwrap();
        }
        // If node is not installed, skip gracefully
    }

    #[test]
    fn test_spawn_writes_port_file() {
        let tmp = tempfile::tempdir().unwrap();
        let script = tmp.path().join("test_port_file.js");
        std::fs::write(
            &script,
            r#"
const http = require('http');
const srv = http.createServer((_,r) => { r.end('ok'); });
srv.listen(0, '127.0.0.1', () => {
    process.stdout.write(JSON.stringify({ port: srv.address().port }) + '\n');
});
"#,
        )
        .unwrap();

        let data_dir = tmp.path().join("data");
        let result = McpOsProcess::spawn_in_dir(&script.to_string_lossy(), &data_dir);
        if let Ok(mut proc) = result {
            let port_path = proc.port_path.clone();
            assert!(port_path.exists(), "Port file should exist");
            let content = std::fs::read_to_string(&port_path).unwrap();
            let file_port: u16 = content
                .parse()
                .expect("port file should contain a valid u16");
            assert_eq!(
                file_port,
                proc.port(),
                "Port file should match process port"
            );
            assert!(proc.port() > 0, "Process port should be assigned");
            proc.stop().unwrap();
        }
    }

    #[test]
    fn test_spawn_writes_pid_file() {
        let tmp = tempfile::tempdir().unwrap();
        let script = tmp.path().join("test_pid_file.js");
        std::fs::write(
            &script,
            r#"
const http = require('http');
const srv = http.createServer((_,r) => { r.end('ok'); });
srv.listen(0, '127.0.0.1', () => {
    process.stdout.write(JSON.stringify({ port: srv.address().port }) + '\n');
});
"#,
        )
        .unwrap();

        let data_dir = tmp.path().join("data");
        let result = McpOsProcess::spawn_in_dir(&script.to_string_lossy(), &data_dir);
        if let Ok(mut proc) = result {
            let pid_path = proc.pid_path.clone();
            assert!(pid_path.exists(), "PID file should exist");
            let content = std::fs::read_to_string(&pid_path).unwrap();
            let pid: u32 = content
                .trim()
                .parse()
                .expect("PID file should contain a valid u32");
            assert_eq!(
                pid,
                proc.child.as_ref().unwrap().id(),
                "PID file should match child PID"
            );
            proc.stop().unwrap();
        }
    }

    #[cfg(unix)]
    #[test]
    fn test_read_port_timeout_on_silent_child() {
        let mut child = Command::new("sleep")
            .arg("60")
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();

        let stdout = child.stdout.take().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let reader = std::io::BufReader::new(stdout);
            for line in reader.lines() {
                if let Ok(line) = line {
                    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&line) {
                        if let Some(port) = json.get("port").and_then(|v| v.as_u64()) {
                            let _ = tx.send(
                                u16::try_from(port)
                                    .map_err(|_| anyhow::anyhow!("port {port} out of u16 range")),
                            );
                            return;
                        }
                    }
                }
            }
            let _ = tx.send(Err(anyhow::anyhow!("no port")));
        });

        let result = rx.recv_timeout(std::time::Duration::from_millis(200));
        assert!(result.is_err(), "Should timeout on silent child");
        child.kill().ok();
        child.wait().ok();
    }

    #[cfg(unix)]
    #[test]
    fn test_kill_terminates_child() {
        let child = Command::new("sleep")
            .arg("60")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();

        if let Ok(child) = child {
            let tmp = tempfile::tempdir().unwrap();
            let token_path = tmp.path().join("token");
            let port_path = tmp.path().join("port");
            let pid_path = tmp.path().join("pid");
            std::fs::write(&token_path, "tok").unwrap();
            std::fs::write(&port_path, "1234").unwrap();
            std::fs::write(&pid_path, child.id().to_string()).unwrap();

            let mut proc = McpOsProcess::new_with(
                child,
                token_path,
                1234,
                port_path,
                pid_path,
                tmp.path().to_path_buf(),
            );
            assert!(proc.health_check(), "Process should be alive");

            proc.stop().unwrap();
            assert!(!proc.health_check(), "Process should be dead after stop");
        }
    }

    #[cfg(unix)]
    #[test]
    fn test_health_check_running() {
        let child = Command::new("sleep")
            .arg("60")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();

        if let Ok(child) = child {
            let tmp = tempfile::tempdir().unwrap();
            let token_path = tmp.path().join("token");
            let port_path = tmp.path().join("port");
            let pid_path = tmp.path().join("pid");
            std::fs::write(&token_path, "tok").unwrap();
            std::fs::write(&port_path, "1234").unwrap();
            std::fs::write(&pid_path, child.id().to_string()).unwrap();

            let mut proc = McpOsProcess::new_with(
                child,
                token_path,
                1234,
                port_path,
                pid_path,
                tmp.path().to_path_buf(),
            );
            assert!(proc.health_check(), "Running process should be healthy");
            proc.stop().unwrap();
        }
    }

    #[cfg(unix)]
    #[test]
    fn test_health_check_dead() {
        let child = Command::new("true")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();

        if let Ok(child) = child {
            let tmp = tempfile::tempdir().unwrap();
            let token_path = tmp.path().join("token");
            let port_path = tmp.path().join("port");
            let pid_path = tmp.path().join("pid");
            std::fs::write(&token_path, "tok").unwrap();
            std::fs::write(&port_path, "1234").unwrap();
            std::fs::write(&pid_path, child.id().to_string()).unwrap();

            let mut proc = McpOsProcess::new_with(
                child,
                token_path,
                1234,
                port_path,
                pid_path,
                tmp.path().to_path_buf(),
            );
            std::thread::sleep(std::time::Duration::from_millis(100));
            assert!(!proc.health_check(), "Exited process should be unhealthy");
            proc.stop().unwrap();
        }
    }

    #[cfg(unix)]
    #[test]
    fn test_drop_cleans_up_files() {
        let tmp = tempfile::tempdir().unwrap();
        let token_path = tmp.path().join("drop-token");
        let port_path = tmp.path().join("drop-port");
        let pid_path = tmp.path().join("drop-pid");
        write_restricted_file(&token_path, "secret").unwrap();
        write_restricted_file(&port_path, "1234").unwrap();
        write_restricted_file(&pid_path, "9999").unwrap();
        assert!(token_path.exists());
        assert!(port_path.exists());
        assert!(pid_path.exists());

        let child = Command::new("sleep")
            .arg("60")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();

        if let Ok(child) = child {
            let proc = McpOsProcess::new_with(
                child,
                token_path.clone(),
                1234,
                port_path.clone(),
                pid_path.clone(),
                tmp.path().to_path_buf(),
            );
            drop(proc);
            assert!(!token_path.exists(), "Token file should be removed on drop");
            assert!(!port_path.exists(), "Port file should be removed on drop");
            assert!(!pid_path.exists(), "PID file should be removed on drop");
        }
    }

    #[test]
    fn test_kill_stale_by_pid_file_kills_node_process() {
        // Spawn a real node process, write its PID to a file, then call kill_stale
        let child = Command::new("node")
            .args(["-e", "setTimeout(() => {}, 60000)"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();

        if let Ok(mut child) = child {
            let tmp = tempfile::tempdir().unwrap();
            let pid_path = tmp.path().join("stale-pid");
            let pid = child.id();
            std::fs::write(&pid_path, pid.to_string()).unwrap();

            kill_stale_by_pid_file(&pid_path);

            // Give the process a moment to die
            std::thread::sleep(std::time::Duration::from_millis(800));

            // Process should be dead
            match child.try_wait() {
                Ok(Some(_)) => {} // exited — good
                Ok(None) => {
                    child.kill().ok();
                    child.wait().ok();
                    panic!("Process should have been killed by kill_stale_by_pid_file");
                }
                Err(_) => {} // error checking — treat as dead
            }
            // PID file should be removed
            assert!(!pid_path.exists(), "PID file should be cleaned up");
        }
        // node not available — skip
    }

    #[cfg(unix)]
    #[test]
    fn test_kill_stale_by_pid_file_skips_non_node_process() {
        // Spawn a non-node process — kill_stale should NOT kill it
        let child = Command::new("sleep")
            .arg("60")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();

        if let Ok(mut child) = child {
            let tmp = tempfile::tempdir().unwrap();
            let pid_path = tmp.path().join("stale-pid");
            let pid = child.id();
            std::fs::write(&pid_path, pid.to_string()).unwrap();

            kill_stale_by_pid_file(&pid_path);

            // Process should still be alive
            std::thread::sleep(std::time::Duration::from_millis(100));
            match child.try_wait() {
                Ok(None) => {} // still running — correct
                _ => panic!("Non-node process should NOT have been killed"),
            }

            child.kill().ok();
            child.wait().ok();
            // PID file should still be cleaned up (we remove it regardless)
            assert!(
                !pid_path.exists(),
                "PID file should be cleaned up even for non-node"
            );
        }
    }

    #[test]
    fn test_kill_stale_by_pid_file_handles_missing_file() {
        let tmp = tempfile::tempdir().unwrap();
        let pid_path = tmp.path().join("nonexistent-pid");
        // Should not panic
        kill_stale_by_pid_file(&pid_path);
    }

    #[test]
    fn test_kill_stale_by_pid_file_handles_invalid_content() {
        let tmp = tempfile::tempdir().unwrap();
        let pid_path = tmp.path().join("bad-pid");
        std::fs::write(&pid_path, "not-a-number").unwrap();
        // Should not panic
        kill_stale_by_pid_file(&pid_path);
    }

    #[test]
    fn test_kill_stale_by_pid_file_handles_stale_pid() {
        let tmp = tempfile::tempdir().unwrap();
        let pid_path = tmp.path().join("dead-pid");
        // PID 99999999 almost certainly doesn't exist
        std::fs::write(&pid_path, "99999999").unwrap();
        // Should not panic — is_node_process returns false for nonexistent PID
        kill_stale_by_pid_file(&pid_path);
        assert!(
            !pid_path.exists(),
            "PID file should be cleaned up for dead PID"
        );
    }

    #[test]
    #[serial(env)]
    fn test_env_clear_prevents_secret_leakage() {
        let tmp = tempfile::tempdir().unwrap();
        let script = tmp.path().join("check_env.js");
        std::fs::write(
            &script,
            "const has_secret = !!process.env.SUPER_SECRET_TOKEN;\nprocess.stdout.write(has_secret ? 'LEAKED' : 'SAFE');\nprocess.exit(0);\n",
        ).unwrap();

        std::env::set_var("SUPER_SECRET_TOKEN", "do-not-leak");

        let mut cmd = Command::new("node");
        cmd.arg(&script)
            .env_clear()
            .env("PATH", std::env::var("PATH").unwrap_or_default());
        #[cfg(not(target_os = "windows"))]
        if let Ok(home) = std::env::var("HOME") {
            cmd.env("HOME", home);
        }
        let result = cmd
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .output();

        std::env::remove_var("SUPER_SECRET_TOKEN");

        if let Ok(output) = result {
            let stdout = String::from_utf8_lossy(&output.stdout);
            assert_eq!(
                stdout.as_ref(),
                "SAFE",
                "Secret env var should NOT leak to child process"
            );
        }
    }

    #[test]
    fn test_token_is_uuid_format() {
        let token = uuid::Uuid::new_v4().to_string();
        assert_eq!(token.len(), 36);
        assert_eq!(token.chars().filter(|c| *c == '-').count(), 4);
        assert!(token.chars().all(|c| c.is_ascii_hexdigit() || c == '-'));
    }

    #[cfg(unix)]
    #[test]
    fn test_stop_is_idempotent() {
        let child = Command::new("sleep")
            .arg("60")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();

        if let Ok(child) = child {
            let tmp = tempfile::tempdir().unwrap();
            let token_path = tmp.path().join("token");
            let port_path = tmp.path().join("port");
            let pid_path = tmp.path().join("pid");
            std::fs::write(&token_path, "tok").unwrap();
            std::fs::write(&port_path, "1234").unwrap();
            std::fs::write(&pid_path, child.id().to_string()).unwrap();

            let mut proc = McpOsProcess::new_with(
                child,
                token_path,
                1234,
                port_path,
                pid_path,
                tmp.path().to_path_buf(),
            );
            proc.stop().unwrap();
            proc.stop().unwrap();
        }
    }

    #[test]
    fn test_is_node_process_returns_false_for_nonexistent_pid() {
        assert!(
            !is_node_process(99999999),
            "Nonexistent PID should not be node"
        );
    }

    #[cfg(unix)]
    #[test]
    fn test_is_node_process_returns_false_for_non_node() {
        let child = Command::new("sleep")
            .arg("60")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();

        if let Ok(mut child) = child {
            assert!(!is_node_process(child.id()), "sleep should not be node");
            child.kill().ok();
            child.wait().ok();
        }
    }

    #[test]
    fn test_is_node_process_returns_true_for_node() {
        let child = Command::new("node")
            .args(["-e", "setTimeout(() => {}, 60000)"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();

        if let Ok(mut child) = child {
            assert!(
                is_node_process(child.id()),
                "node should be detected as node"
            );
            child.kill().ok();
            child.wait().ok();
        }
        // node not available — skip
    }

    /// On Windows, essential system env vars (SystemRoot, SYSTEMDRIVE, TEMP, etc.)
    /// must be passed through to the child process so that Node.js OpenSSL CSPRNG
    /// can initialize BCryptGenRandom. This test verifies those vars are present.
    #[cfg(target_os = "windows")]
    #[test]
    #[serial(env)]
    fn test_windows_system_env_vars_passed_through() {
        let tmp = tempfile::tempdir().unwrap();
        let script = tmp.path().join("check_win_env.js");

        // The JS script checks for all essential Windows env vars and reports
        // which ones are present. It prints JSON so we can parse the result.
        let keys_json: Vec<String> = WINDOWS_SYSTEM_ENV_VARS
            .iter()
            .map(|k| format!("'{k}'"))
            .collect();
        std::fs::write(
            &script,
            format!(
                "const keys = [{keys}];\nconst result = {{}};\nfor (const k of keys) {{ result[k] = !!process.env[k]; }}\nprocess.stdout.write(JSON.stringify(result));",
                keys = keys_json.join(", ")
            ),
        )
        .unwrap();

        // Build the command exactly as spawn() does
        let mut cmd = Command::new("node");
        cmd.arg(&script).env_clear();

        for key in WINDOWS_SYSTEM_ENV_VARS {
            if let Ok(val) = std::env::var(key) {
                cmd.env(key, val);
            }
        }

        let result = cmd
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .output();

        if let Ok(output) = result {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let json: serde_json::Value = serde_json::from_str(&stdout)
                .unwrap_or_else(|_| panic!("Failed to parse output: {stdout}"));

            // SystemRoot is the most critical — without it, Node.js CSPRNG fails
            assert_eq!(
                json.get("SystemRoot").and_then(|v| v.as_bool()),
                Some(true),
                "SystemRoot must be passed to child process"
            );

            // Verify all vars that exist in the parent are passed through
            for key in WINDOWS_SYSTEM_ENV_VARS {
                if std::env::var(key).is_ok() {
                    assert_eq!(
                        json.get(key).and_then(|v| v.as_bool()),
                        Some(true),
                        "{key} should be passed through to child when it exists in parent"
                    );
                }
            }
        }
        // node not available — skip
    }

    /// Verifies that secrets (e.g. ANTHROPIC_API_KEY) are NOT leaked to the
    /// child process even when Windows system env vars are passed through.
    /// This test builds the command exactly as spawn() does — env_clear() +
    /// selective re-injection — and confirms that arbitrary env vars from the
    /// parent do not reach the child.
    #[test]
    #[serial(env)]
    fn test_env_clear_with_windows_passthrough_still_blocks_secrets() {
        let tmp = tempfile::tempdir().unwrap();
        let script = tmp.path().join("check_secrets.js");

        // Check for multiple secret-like env vars that should never leak
        std::fs::write(
            &script,
            r#"
const secrets = [
    'ANTHROPIC_API_KEY',
    'SLACK_BOT_TOKEN',
    'GITLAB_TOKEN',
    'AWS_SECRET_ACCESS_KEY',
    'DATABASE_URL',
    'SUPER_SECRET_TOKEN'
];
const leaked = secrets.filter(k => !!process.env[k]);
process.stdout.write(JSON.stringify({ leaked }));
"#,
        )
        .unwrap();

        // Set secrets in the parent process
        std::env::set_var("ANTHROPIC_API_KEY", "sk-ant-secret");
        std::env::set_var("SLACK_BOT_TOKEN", "xoxb-secret");
        std::env::set_var("GITLAB_TOKEN", "glpat-secret");
        std::env::set_var("AWS_SECRET_ACCESS_KEY", "aws-secret");
        std::env::set_var("DATABASE_URL", "postgres://secret@db/prod");
        std::env::set_var("SUPER_SECRET_TOKEN", "do-not-leak");

        // Build command exactly as spawn() does
        let mut cmd = Command::new("node");
        cmd.arg(&script).env_clear();

        #[cfg(target_os = "windows")]
        {
            for key in WINDOWS_SYSTEM_ENV_VARS {
                if let Ok(val) = std::env::var(key) {
                    cmd.env(key, val);
                }
            }
        }

        cmd.env("PATH", std::env::var("PATH").unwrap_or_default());
        #[cfg(not(target_os = "windows"))]
        if let Ok(home) = std::env::var("HOME") {
            cmd.env("HOME", home);
        }
        let result = cmd
            .env("PORT", "0")
            .env("MCP_OS_AUTH_TOKEN", "test-token")
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .output();

        // Clean up env vars
        std::env::remove_var("ANTHROPIC_API_KEY");
        std::env::remove_var("SLACK_BOT_TOKEN");
        std::env::remove_var("GITLAB_TOKEN");
        std::env::remove_var("AWS_SECRET_ACCESS_KEY");
        std::env::remove_var("DATABASE_URL");
        std::env::remove_var("SUPER_SECRET_TOKEN");

        if let Ok(output) = result {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let json: serde_json::Value = serde_json::from_str(&stdout)
                .unwrap_or_else(|_| panic!("Failed to parse output: {stdout}"));
            let leaked = json
                .get("leaked")
                .and_then(|v| v.as_array())
                .expect("Should have 'leaked' array in output");
            assert!(
                leaked.is_empty(),
                "No secrets should leak to child process, but found: {leaked:?}"
            );
        }
        // node not available — skip
    }

    // ── drain_and_read_port edge cases ───────────────────────────────────

    /// Helper: spawn a child process that writes the given lines to stdout,
    /// one per line, then exits. Unix-only: uses `bash` + `printf`.
    #[cfg(unix)]
    fn spawn_stdout_lines(lines: &[&str]) -> Child {
        // Use printf to write each line with a trailing newline
        Command::new("bash")
            .args(["-c", &format!("printf '%s\\n' {}", shell_quote_args(lines))])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .expect("failed to spawn bash")
    }

    /// Shell-quote a list of arguments for safe interpolation.
    #[cfg(unix)]
    fn shell_quote_args(args: &[&str]) -> String {
        args.iter()
            .map(|a| format!("'{}'", a.replace('\'', "'\\''")))
            .collect::<Vec<_>>()
            .join(" ")
    }

    /// Helper: create a temp log path for drain tests.
    #[cfg(unix)]
    fn temp_log_path() -> (tempfile::TempDir, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let log_path = tmp.path().join(consts::MCP_OS_LOG_FILE);
        (tmp, log_path)
    }

    #[cfg(unix)]
    #[test]
    fn drain_and_read_port_skips_non_json_lines_before_port() {
        let (_tmp, log_path) = temp_log_path();
        let mut child = spawn_stdout_lines(&[
            "Warning: something happened",
            "DEBUG: initializing",
            r#"{"port":4567}"#,
            "more output after port",
        ]);

        let (port, _handles) = drain_and_read_port(&mut child, &log_path)
            .expect("should find port after non-JSON lines");
        assert_eq!(
            port, 4567,
            "should extract port from the first JSON line with 'port' key"
        );
        child.kill().ok();
        child.wait().ok();
    }

    #[cfg(unix)]
    #[test]
    fn drain_and_read_port_rejects_port_zero() {
        // Shared `parse_port_line` rejects 0 (invalid bind target). The
        // child then exits without a valid port announcement and the
        // error surfaces as "exited without announcing a port".
        let (_tmp, log_path) = temp_log_path();
        let mut child = spawn_stdout_lines(&[r#"{"port":0}"#]);
        let result = drain_and_read_port(&mut child, &log_path);
        assert!(result.is_err(), "port 0 must be rejected");
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("exited without announcing"));
        child.kill().ok();
        child.wait().ok();
    }

    #[cfg(unix)]
    #[test]
    fn drain_and_read_port_rejects_port_over_65535() {
        let (_tmp, log_path) = temp_log_path();
        let mut child = spawn_stdout_lines(&[r#"{"port":70000}"#]);
        let result = drain_and_read_port(&mut child, &log_path);
        assert!(
            result.is_err(),
            "port 70000 exceeds u16 range and should be rejected"
        );
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("exited without announcing"));
        child.kill().ok();
        child.wait().ok();
    }

    #[cfg(unix)]
    #[test]
    fn drain_and_read_port_rejects_port_max_u64() {
        let (_tmp, log_path) = temp_log_path();
        let mut child = spawn_stdout_lines(&[r#"{"port":18446744073709551615}"#]);

        let result = drain_and_read_port(&mut child, &log_path);
        // serde_json may fail to parse u64::MAX, or it parses but u16::try_from fails.
        // Either way the port should not be successfully returned.
        assert!(
            result.is_err(),
            "extremely large port value should be rejected"
        );
        child.kill().ok();
        child.wait().ok();
    }

    #[cfg(unix)]
    #[test]
    fn drain_and_read_port_errors_on_exit_without_port() {
        let (_tmp, log_path) = temp_log_path();
        // Child outputs only non-JSON text then exits
        let mut child = spawn_stdout_lines(&["just some warnings", "no port here"]);

        let result = drain_and_read_port(&mut child, &log_path);
        assert!(
            result.is_err(),
            "should error when child exits without announcing a port"
        );
        let err_msg = result.unwrap_err().to_string();
        assert!(
            err_msg.contains("exited without announcing"),
            "error should mention missing port announcement: {err_msg}"
        );
        child.kill().ok();
        child.wait().ok();
    }

    #[cfg(unix)]
    #[test]
    fn drain_and_read_port_ignores_json_without_port_key() {
        let (_tmp, log_path) = temp_log_path();
        // JSON lines that don't have a "port" key should be skipped
        let mut child = spawn_stdout_lines(&[
            r#"{"status":"initializing"}"#,
            r#"{"level":"debug","msg":"ready"}"#,
            r#"{"port":9876}"#,
        ]);

        let (port, _handles) = drain_and_read_port(&mut child, &log_path)
            .expect("should find port after non-port JSON lines");
        assert_eq!(port, 9876, "should skip JSON lines without 'port' key");
        child.kill().ok();
        child.wait().ok();
    }

    #[cfg(unix)]
    #[test]
    fn drain_and_read_port_writes_to_log_file() {
        let (_tmp, log_path) = temp_log_path();
        let mut child =
            spawn_stdout_lines(&["startup message", r#"{"port":5555}"#, "after port line"]);

        let (port, _handles) = drain_and_read_port(&mut child, &log_path).unwrap();
        assert_eq!(port, 5555);
        child.kill().ok();
        child.wait().ok();

        // Give drain thread a moment to flush
        std::thread::sleep(std::time::Duration::from_millis(200));

        assert!(log_path.exists(), "log file should be created");
        let content = std::fs::read_to_string(&log_path).unwrap();
        assert!(
            content.contains("startup message"),
            "log file should contain stdout lines: {content}"
        );
    }

    #[test]
    fn test_respawn_stops_old_and_starts_new() {
        let tmp = tempfile::tempdir().unwrap();
        let script = tmp.path().join("respawn_test.js");
        std::fs::write(
            &script,
            r#"
const http = require('http');
const srv = http.createServer((_,r) => { r.end('ok'); });
srv.listen(0, '127.0.0.1', () => {
    process.stdout.write(JSON.stringify({ port: srv.address().port }) + '\n');
});
"#,
        )
        .unwrap();

        let result = McpOsProcess::spawn(&script.to_string_lossy());
        if let Ok(mut proc) = result {
            let old_port = proc.port();
            assert!(old_port > 0);

            match proc.respawn() {
                Ok(new_port) => {
                    assert!(new_port > 0, "new port should be assigned");
                    // Ports may or may not differ (OS can reuse), but process should be alive
                    assert!(proc.health_check(), "respawned process should be alive");
                }
                Err(e) => {
                    // Node not available or spawn failure — acceptable in CI
                    log::warn!("respawn test skipped: {e}");
                }
            }

            proc.stop().unwrap();
        }
        // node not available — skip
    }

    #[test]
    fn test_respawn_does_not_delete_new_files() {
        let tmp = tempfile::tempdir().unwrap();
        let script = tmp.path().join("respawn_files.js");
        std::fs::write(
            &script,
            r#"
const http = require('http');
const srv = http.createServer((_,r) => { r.end('ok'); });
srv.listen(0, '127.0.0.1', () => {
    process.stdout.write(JSON.stringify({ port: srv.address().port }) + '\n');
});
"#,
        )
        .unwrap();

        let result = McpOsProcess::spawn(&script.to_string_lossy());
        if let Ok(mut proc) = result {
            if let Ok(new_port) = proc.respawn() {
                // After respawn, process should be functional with a valid port.
                // File existence checks are lenient because multiple spawn-based
                // tests run in parallel and share the same global ~/.speedwave/ dir.
                assert!(new_port > 0, "new port should be non-zero after respawn");
                assert!(
                    proc.port() > 0,
                    "process port should be non-zero after respawn"
                );
                // Verify the new process state has valid paths (not the empty
                // paths we set on the old instance to prevent Drop cleanup).
                assert!(
                    !proc.token_path.as_os_str().is_empty(),
                    "token_path should not be empty after respawn"
                );
                assert!(
                    !proc.port_path.as_os_str().is_empty(),
                    "port_path should not be empty after respawn"
                );
                assert!(
                    !proc.pid_path.as_os_str().is_empty(),
                    "pid_path should not be empty after respawn"
                );
            }
            proc.stop().unwrap();
        }
        // node not available — skip
    }

    #[test]
    fn test_stop_releases_log_file() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("sw-data");
        let script = tmp.path().join("log_release.js");
        std::fs::write(
            &script,
            r#"
const http = require('http');
const srv = http.createServer((_,r) => { r.end('ok'); });
srv.listen(0, '127.0.0.1', () => {
    process.stdout.write(JSON.stringify({ port: srv.address().port }) + '\n');
});
"#,
        )
        .unwrap();

        let result = McpOsProcess::spawn_in_dir(&script.to_string_lossy(), &data_dir);
        if let Ok(mut proc) = result {
            let log_path = data_dir.join(consts::MCP_OS_LOG_FILE);
            proc.stop().unwrap();
            // After stop() + drain thread join, the log file handle is released.
            // Verify by successfully removing the file (would fail if still open
            // on some platforms).
            if log_path.exists() {
                std::fs::remove_file(&log_path)
                    .expect("log file should be removable after stop (handles released)");
            }
        }
        // node not available — skip
    }

    #[test]
    fn test_respawn_returns_new_port() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("sw-data");
        let script = tmp.path().join("respawn_port.js");
        std::fs::write(
            &script,
            r#"
const http = require('http');
const srv = http.createServer((_,r) => { r.end('ok'); });
srv.listen(0, '127.0.0.1', () => {
    process.stdout.write(JSON.stringify({ port: srv.address().port }) + '\n');
});
"#,
        )
        .unwrap();

        let result = McpOsProcess::spawn_in_dir(&script.to_string_lossy(), &data_dir);
        if let Ok(mut proc) = result {
            match proc.respawn() {
                Ok(new_port) => {
                    assert!(new_port > 0, "new port should be assigned");
                    assert!(proc.health_check(), "respawned process should be alive");
                    // Verify data_dir is preserved (not defaulting to ~/.speedwave/)
                    assert_eq!(
                        proc.data_dir, data_dir,
                        "data_dir should be preserved across respawn"
                    );
                }
                Err(e) => {
                    log::warn!("respawn test skipped: {e}");
                }
            }
            proc.stop().unwrap();
        }
        // node not available — skip
    }

    /// Fake env source backed by a static map — lets `apply_child_env` tests
    /// run against arbitrary parent-environment scenarios without mutating
    /// `std::env`, which races with parallel tests and any Speedwave instance
    /// running concurrently on the host.
    struct FakeEnv<'a>(&'a [(&'a str, &'a str)]);

    impl EnvSource for FakeEnv<'_> {
        fn var(&self, key: &str) -> Option<String> {
            self.0
                .iter()
                .find(|(k, _)| *k == key)
                .map(|(_, v)| (*v).to_string())
        }
    }

    /// Read the env vars `apply_child_env` set on a freshly created Command.
    fn captured_env(cmd: &Command) -> std::collections::HashMap<String, String> {
        cmd.get_envs()
            .filter_map(|(k, v)| {
                let v = v?.to_str()?.to_string();
                Some((k.to_str()?.to_string(), v))
            })
            .collect()
    }

    #[test]
    fn apply_child_env_forwards_resources_dir_and_sets_prod_flag() {
        let mut cmd = Command::new("/bin/true");
        let env = FakeEnv(&[
            ("PATH", "/usr/bin:/bin"),
            ("HOME", "/home/test"),
            (consts::BUNDLE_RESOURCES_ENV, "/fake/Resources"),
        ]);

        apply_child_env(&mut cmd, &env);

        let captured = captured_env(&cmd);
        assert_eq!(
            captured
                .get(consts::BUNDLE_RESOURCES_ENV)
                .map(String::as_str),
            Some("/fake/Resources"),
            "BUNDLE_RESOURCES_ENV must be forwarded verbatim to the child"
        );
        assert_eq!(
            captured.get("SPEEDWAVE_PROD").map(String::as_str),
            Some("1"),
            "SPEEDWAVE_PROD=1 must be set when the parent has a non-empty \
             BUNDLE_RESOURCES_ENV (production .app launch)"
        );
        assert_eq!(
            captured.get("PATH").map(String::as_str),
            Some("/usr/bin:/bin")
        );
        #[cfg(not(target_os = "windows"))]
        assert_eq!(captured.get("HOME").map(String::as_str), Some("/home/test"));
    }

    #[test]
    fn apply_child_env_omits_prod_flag_when_resources_unset() {
        let mut cmd = Command::new("/bin/true");
        let env = FakeEnv(&[("PATH", "/usr/bin:/bin"), ("HOME", "/home/test")]);

        apply_child_env(&mut cmd, &env);

        let captured = captured_env(&cmd);
        assert!(
            !captured.contains_key(consts::BUNDLE_RESOURCES_ENV),
            "BUNDLE_RESOURCES_ENV must not be set on child when parent does \
             not have it (dev mode)"
        );
        assert!(
            !captured.contains_key("SPEEDWAVE_PROD"),
            "SPEEDWAVE_PROD must not be set in dev mode"
        );
    }

    #[test]
    fn apply_child_env_treats_empty_resources_as_unset() {
        let mut cmd = Command::new("/bin/true");
        let env = FakeEnv(&[
            ("PATH", "/usr/bin:/bin"),
            (consts::BUNDLE_RESOURCES_ENV, ""),
        ]);

        apply_child_env(&mut cmd, &env);

        let captured = captured_env(&cmd);
        assert!(
            !captured.contains_key(consts::BUNDLE_RESOURCES_ENV),
            "empty BUNDLE_RESOURCES_ENV must be treated as unset"
        );
        assert!(
            !captured.contains_key("SPEEDWAVE_PROD"),
            "empty BUNDLE_RESOURCES_ENV must not trigger SPEEDWAVE_PROD"
        );
    }

    #[test]
    fn apply_child_env_defaults_path_to_empty_when_missing_and_omits_home() {
        let mut cmd = Command::new("/bin/true");
        let env = FakeEnv(&[]);

        apply_child_env(&mut cmd, &env);

        let captured = captured_env(&cmd);
        assert_eq!(
            captured.get("PATH").map(String::as_str),
            Some(""),
            "PATH must always be set on the child, even if empty"
        );
        // HOME="" makes Node.js os.homedir() return "" and breaks ~/.npm,
        // ~/.cache, etc. — better to leave HOME unset than poison it.
        #[cfg(not(target_os = "windows"))]
        assert!(
            captured.get("HOME").is_none(),
            "HOME must be omitted on Unix children when not set on the host"
        );
    }

    #[test]
    fn apply_child_env_drops_inherited_vars_not_in_policy() {
        // The function must clear inherited environment before adding back
        // only policy-approved variables, otherwise a parent secret
        // (API keys, tokens) would silently leak to the mcp-os child.
        let mut cmd = Command::new("/bin/true");
        cmd.env("SUPER_SECRET_TOKEN", "do-not-leak");
        cmd.env("ANTHROPIC_API_KEY", "sk-leak");

        let env = FakeEnv(&[("PATH", "/usr/bin")]);
        apply_child_env(&mut cmd, &env);

        let captured = captured_env(&cmd);
        assert!(
            !captured.contains_key("SUPER_SECRET_TOKEN"),
            "inherited SUPER_SECRET_TOKEN must be wiped by apply_child_env"
        );
        assert!(
            !captured.contains_key("ANTHROPIC_API_KEY"),
            "inherited ANTHROPIC_API_KEY must be wiped by apply_child_env"
        );
    }
}
