use std::io::BufRead;
use std::path::PathBuf;
use std::process::{Child, Command};

use speedwave_runtime::consts;

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
    #[allow(dead_code)] // used in tests
    token: String,
    token_path: PathBuf,
    port: u16,
    port_path: PathBuf,
    pid_path: PathBuf,
}

/// Timeout for reading the port announcement from mcp-os stdout.
const PORT_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

impl McpOsProcess {
    /// Spawn the mcp-os node process with a dynamic port.
    ///
    /// `script_path` is the absolute path to `mcp-servers/os/dist/index.js`.
    /// Blocks up to 10 s waiting for the child to announce its port on stdout.
    ///
    /// Before spawning, kills any stale mcp-os process left over from a
    /// previous session by reading the PID file.
    pub fn spawn(script_path: &str) -> anyhow::Result<Self> {
        let token = uuid::Uuid::new_v4().to_string();
        let home = dirs::home_dir().ok_or_else(|| anyhow::anyhow!("no home dir"))?;
        let data_dir = home.join(consts::DATA_DIR);
        std::fs::create_dir_all(&data_dir)?;
        let token_path = data_dir.join(consts::MCP_OS_AUTH_TOKEN_FILE);
        let port_path = data_dir.join(consts::MCP_OS_PORT_FILE);
        let pid_path = data_dir.join(consts::MCP_OS_PID_FILE);

        // Kill any stale mcp-os from a previous session
        kill_stale_by_pid_file(&pid_path);

        // Write token file with restrictive permissions
        write_restricted_file(&token_path, &token)?;

        let node = speedwave_runtime::binary::resolve_binary("node");
        let mut child = Command::new(&node)
            .arg(script_path)
            .env_clear()
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .env("HOME", std::env::var("HOME").unwrap_or_default())
            .env("PORT", "0")
            .env("MCP_OS_AUTH_TOKEN", &token)
            .env("NODE_PATH", std::env::var("NODE_PATH").unwrap_or_default())
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
        let port = drain_and_read_port(&mut child)?;

        // Write port file so compose.rs can build WORKER_OS_URL
        write_restricted_file(&port_path, &port.to_string())?;

        Ok(Self {
            child: Some(child),
            token,
            token_path,
            port,
            port_path,
            pid_path,
        })
    }

    /// Test-only constructor with injected values.
    #[cfg(test)]
    fn new_with(
        child: Child,
        token: String,
        token_path: PathBuf,
        port: u16,
        port_path: PathBuf,
        pid_path: PathBuf,
    ) -> Self {
        Self {
            child: Some(child),
            token,
            token_path,
            port,
            port_path,
            pid_path,
        }
    }

    /// Returns the auth token generated for this process.
    #[allow(dead_code)] // used in tests
    pub fn token(&self) -> &str {
        &self.token
    }

    /// Returns the actual port mcp-os is listening on.
    pub fn port(&self) -> u16 {
        self.port
    }

    /// Returns the path where the auth token is written.
    #[allow(dead_code)] // used in tests
    pub fn token_path(&self) -> &PathBuf {
        &self.token_path
    }

    /// Check if the child process is still alive.
    #[allow(dead_code)] // used in tests
    pub fn health_check(&mut self) -> bool {
        match &mut self.child {
            Some(child) => matches!(child.try_wait(), Ok(None)),
            None => false,
        }
    }

    /// Kill the child process.
    pub fn stop(&mut self) -> anyhow::Result<()> {
        if let Some(mut child) = self.child.take() {
            child.kill().ok(); // ignore "already exited" errors
            child.wait().ok(); // reap zombie
        }
        Ok(())
    }

    /// Remove the token, port, and PID files from disk.
    pub fn cleanup_files(&self) {
        let _ = std::fs::remove_file(&self.token_path);
        let _ = std::fs::remove_file(&self.port_path);
        let _ = std::fs::remove_file(&self.pid_path);
    }
}

impl Drop for McpOsProcess {
    fn drop(&mut self) {
        self.stop().ok();
        self.cleanup_files();
    }
}

/// Kill a stale mcp-os process identified by its PID file.
///
/// Cross-platform: uses `kill` on Unix and `taskkill` on Windows.
/// Only kills the process if it looks like a `node` process (verified via
/// `ps` on Unix, `tasklist` on Windows) to avoid killing unrelated PIDs
/// that may have been recycled by the OS.
fn kill_stale_by_pid_file(pid_path: &std::path::Path) {
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

    log::info!("killing stale mcp-os process (PID {pid})");
    kill_process(pid);
    let _ = std::fs::remove_file(pid_path);
}

/// Check whether a given PID belongs to a `node` process.
#[cfg(unix)]
fn is_node_process(pid: u32) -> bool {
    let output = Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "comm="])
        .output();
    match output {
        Ok(o) if o.status.success() => {
            let comm = String::from_utf8_lossy(&o.stdout);
            comm.trim().contains("node")
        }
        _ => false, // process doesn't exist or ps failed
    }
}

#[cfg(windows)]
fn is_node_process(pid: u32) -> bool {
    let output = Command::new("tasklist")
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

/// Terminate a process by PID. Sends SIGTERM then SIGKILL on Unix,
/// uses `taskkill /F` on Windows.
#[cfg(unix)]
fn kill_process(pid: u32) {
    // SIGTERM for graceful shutdown
    let _ = Command::new("kill")
        .args(["-TERM", &pid.to_string()])
        .status();
    std::thread::sleep(std::time::Duration::from_millis(500));
    // SIGKILL as fallback — ignore errors (process may already be gone)
    let _ = Command::new("kill")
        .args(["-KILL", &pid.to_string()])
        .status();
}

#[cfg(windows)]
fn kill_process(pid: u32) {
    let _ = Command::new("taskkill")
        .args(["/F", "/PID", &pid.to_string()])
        .status();
}

/// Spawn background threads to drain both stdout and stderr of the child,
/// then wait for the `{"port":<N>}` JSON line on stdout.
///
/// mcp-os uses `console.log` (→ stdout) for all its logging after the
/// initial port announcement. If the stdout/stderr pipes are closed or
/// their buffers fill up, the child process dies (SIGPIPE or write block).
/// The drain threads keep both pipes open for the entire lifetime of the
/// child process.
fn drain_and_read_port(child: &mut Child) -> anyhow::Result<u16> {
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow::anyhow!("mcp-os stdout not captured"))?;

    // Drain stderr — mcp-os writes warnings here via console.error/console.warn
    if let Some(stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            let reader = std::io::BufReader::new(stderr);
            for line in reader.lines() {
                match line {
                    Ok(line) => log::warn!("mcp-os stderr: {line}"),
                    Err(_) => break,
                }
            }
        });
    }

    // Drain stdout — reads port from first JSON line, then keeps draining
    // all subsequent console.log output to prevent pipe buffer exhaustion.
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let reader = std::io::BufReader::new(stdout);
        let mut port_sent = false;
        for line in reader.lines() {
            match line {
                Ok(line) => {
                    if !port_sent {
                        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&line) {
                            if let Some(port) = json.get("port").and_then(|v| v.as_u64()) {
                                let _ = tx.send(Ok(port as u16));
                                port_sent = true;
                                continue;
                            }
                        }
                    }
                    // After port is found, keep draining stdout so the pipe
                    // never fills up and the child never gets SIGPIPE.
                    log::debug!("mcp-os: {line}");
                }
                Err(_) => break,
            }
        }
        if !port_sent {
            let _ = tx.send(Err(anyhow::anyhow!(
                "mcp-os exited without announcing a port"
            )));
        }
    });

    match rx.recv_timeout(PORT_READ_TIMEOUT) {
        Ok(result) => result,
        Err(_) => anyhow::bail!("timed out waiting for mcp-os port announcement"),
    }
}

/// Write content to file with chmod 600 (Unix) to prevent other users from reading it.
fn write_restricted_file(path: &PathBuf, content: &str) -> anyhow::Result<()> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)?;
        file.write_all(content.as_bytes())?;
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, content)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

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

        let result = McpOsProcess::spawn(&script.to_string_lossy());
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

        let result = McpOsProcess::spawn(&script.to_string_lossy());
        if let Ok(mut proc) = result {
            let port_path = proc.port_path.clone();
            assert!(port_path.exists(), "Port file should exist");
            let content = std::fs::read_to_string(&port_path).unwrap();
            assert_eq!(
                content,
                proc.port().to_string(),
                "Port file should contain actual port"
            );
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

        let result = McpOsProcess::spawn(&script.to_string_lossy());
        if let Ok(mut proc) = result {
            let pid_path = proc.pid_path.clone();
            assert!(pid_path.exists(), "PID file should exist");
            let content = std::fs::read_to_string(&pid_path).unwrap();
            let pid: u32 = content.trim().parse().unwrap();
            assert!(pid > 0, "PID should be positive");
            proc.stop().unwrap();
        }
    }

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
                            let _ = tx.send(Ok(port as u16));
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

    #[test]
    fn test_write_restricted_file() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("test-file");

        write_restricted_file(&path, "test-content").unwrap();

        assert!(path.exists());
        let content = std::fs::read_to_string(&path).unwrap();
        assert_eq!(content, "test-content");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "File should be chmod 600");
        }
    }

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
                "tok".to_string(),
                token_path,
                1234,
                port_path,
                pid_path,
            );
            assert!(proc.health_check(), "Process should be alive");

            proc.stop().unwrap();
            assert!(!proc.health_check(), "Process should be dead after stop");
        }
    }

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
                "tok".to_string(),
                token_path,
                1234,
                port_path,
                pid_path,
            );
            assert!(proc.health_check(), "Running process should be healthy");
            proc.stop().unwrap();
        }
    }

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
                "tok".to_string(),
                token_path,
                1234,
                port_path,
                pid_path,
            );
            std::thread::sleep(std::time::Duration::from_millis(100));
            assert!(!proc.health_check(), "Exited process should be unhealthy");
            proc.stop().unwrap();
        }
    }

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
                "secret".to_string(),
                token_path.clone(),
                1234,
                port_path.clone(),
                pid_path.clone(),
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
    fn test_env_clear_prevents_secret_leakage() {
        use std::sync::Mutex;
        static ENV_LOCK: Mutex<()> = Mutex::new(());
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());

        let tmp = tempfile::tempdir().unwrap();
        let script = tmp.path().join("check_env.js");
        std::fs::write(
            &script,
            "const has_secret = !!process.env.SUPER_SECRET_TOKEN;\nprocess.stdout.write(has_secret ? 'LEAKED' : 'SAFE');\nprocess.exit(0);\n",
        ).unwrap();

        std::env::set_var("SUPER_SECRET_TOKEN", "do-not-leak");

        let result = Command::new("node")
            .arg(&script)
            .env_clear()
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .env("HOME", std::env::var("HOME").unwrap_or_default())
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
                "tok".to_string(),
                token_path,
                1234,
                port_path,
                pid_path,
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
}
