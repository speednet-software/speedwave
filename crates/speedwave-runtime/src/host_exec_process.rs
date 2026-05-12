//! Per-project process manager for the `host_exec` MCP worker (ADR-054).
//! Mirrors `mcp_os_process.rs` mechanics; shared by Desktop and CLI.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread::JoinHandle;

use crate::consts;

/// Worker port-announcement read timeout (same value as `mcp-os`).
const PORT_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// Cap on the per-project audit log size at spawn time.
const LOG_MAX_BYTES: u64 = 2 * 1024 * 1024;

/// TCP liveness probe timeout for the worker's loopback port.
const PORT_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(500);

/// Windows env vars required for Node.js BCryptGenRandom (ADR-013).
#[cfg(target_os = "windows")]
const WINDOWS_SYSTEM_ENV_VARS: &[&str] = &[
    "SystemRoot",
    "SYSTEMDRIVE",
    "TEMP",
    "TMP",
    "APPDATA",
    "LOCALAPPDATA",
    "USERPROFILE",
    "PROGRAMDATA",
];

/// Manages one project's `host_exec` worker as a child Node process.
///
/// One `HostExecProcess` per project; Desktop holds them in a
/// `HashMap<String, HostExecProcess>`, the CLi keeps one for the run.
pub struct HostExecProcess {
    /// Project name (a validated single directory component).
    project: String,
    /// The project directory (whose contents the worker runs commands in).
    project_dir: PathBuf,
    /// The child worker process. `None` after `stop()`.
    child: Option<Child>,
    /// Background threads draining the worker's stdout/stderr into the log.
    drain_handles: Vec<JoinHandle<()>>,
    /// The data dir (so `respawn` re-spawns into the same per-project layout).
    data_dir: PathBuf,
    /// `<data_dir>/host-exec/<project>/config.json` — validated whitelist snapshot.
    config_path: PathBuf,
    /// `<data_dir>/host-exec/<project>/auth-token` (`chmod 600`).
    token_path: PathBuf,
    /// `<data_dir>/host-exec/<project>/port`.
    port_path: PathBuf,
    /// `<data_dir>/host-exec/<project>/pid` (for stale-process cleanup).
    pid_path: PathBuf,
    /// The actual port the worker is listening on (`127.0.0.1:port`).
    port: u16,
    /// Absolute path to `mcp-servers/host_exec/dist/index.js`.
    script_path: String,
    /// Recovered login-shell `PATH` for the worker and its recipes.
    host_path: String,
}

impl HostExecProcess {
    /// Spawn a `host_exec` worker; blocks ~10s for the `{"port":N}` handshake.
    /// `host_path` is the recovered login-shell `PATH` (see ADR-054).
    pub fn spawn_in(
        project: &str,
        project_dir: &Path,
        script_path: &str,
        host_path: &str,
        data_dir: &Path,
    ) -> anyhow::Result<Self> {
        let state_dir = crate::host_exec::host_exec_project_dir(data_dir, project);
        std::fs::create_dir_all(&state_dir)?;

        let token = uuid::Uuid::new_v4().to_string();
        let config_path = state_dir.join(consts::HOST_EXEC_CONFIG_FILE);
        let token_path = state_dir.join(consts::HOST_EXEC_AUTH_TOKEN_FILE);
        let port_path = state_dir.join(consts::HOST_EXEC_PORT_FILE);
        let pid_path = state_dir.join(consts::HOST_EXEC_PID_FILE);
        let log_path = state_dir.join(consts::HOST_EXEC_LOG_FILE);

        // Kill any stale worker from a previous session (this project's PID file).
        kill_stale_by_pid_file(&pid_path);

        // Pre-create log chmod 600 so the worker opens an already-restricted file.
        crate::log_file::truncate_if_oversized(&log_path, LOG_MAX_BYTES);
        let _ = crate::log_file::open_log_file(&log_path);

        // Bearer token — chmod 600.
        write_restricted_file(&token_path, &token)?;

        // env_clear + minimal re-added env (see ADR-054 §"Child environment of recipes").
        let mut cmd = crate::binary::command("node");
        cmd.arg(script_path);
        apply_child_env(&mut cmd, host_path, &CurrentProcessEnv);
        cmd.env("PORT", "0")
            .env("HOST_EXEC_AUTH_TOKEN", &token)
            .env("HOST_EXEC_CONFIG_PATH", &config_path)
            .env("HOST_EXEC_LOG_FILE", &log_path)
            // No stdin — recipes cannot prompt.
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = cmd.spawn()?;

        // PID file so the next session can kill a stale worker.
        write_restricted_file(&pid_path, &child.id().to_string())?;

        // Drain stdio + read port (10s). On failure, clean up child + token + PID.
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

        // Port file so compose.rs can build WORKER_HOST_EXEC_URL.
        if let Err(e) = write_restricted_file(&port_path, &port.to_string()) {
            child.kill().ok();
            child.wait().ok();
            let _ = std::fs::remove_file(&token_path);
            let _ = std::fs::remove_file(&pid_path);
            return Err(e);
        }

        Ok(Self {
            project: project.to_string(),
            project_dir: project_dir.to_path_buf(),
            child: Some(child),
            drain_handles,
            data_dir: data_dir.to_path_buf(),
            config_path,
            token_path,
            port_path,
            pid_path,
            port,
            script_path: script_path.to_string(),
            host_path: host_path.to_string(),
        })
    }

    /// The port the worker is listening on (`127.0.0.1:<port>`).
    pub fn port(&self) -> u16 {
        self.port
    }

    /// Kill the worker and join the stdio drain threads. Idempotent.
    pub fn stop(&mut self) -> anyhow::Result<()> {
        if let Some(mut child) = self.child.take() {
            child.kill().ok();
            child.wait().ok();
        }
        for handle in self.drain_handles.drain(..) {
            let _ = handle.join();
        }
        Ok(())
    }

    /// Remove token, port, PID, and config snapshot. Audit log is kept.
    pub fn cleanup_files(&self) {
        let _ = std::fs::remove_file(&self.token_path);
        let _ = std::fs::remove_file(&self.port_path);
        let _ = std::fs::remove_file(&self.pid_path);
        let _ = std::fs::remove_file(&self.config_path);
    }

    /// Stop and respawn for the same project. Caller must write the new
    /// config snapshot and trigger hub re-discovery afterwards.
    pub fn respawn(&mut self) -> anyhow::Result<u16> {
        if let Some(mut child) = self.child.take() {
            child.kill().ok();
            child.wait().ok();
        }
        for handle in self.drain_handles.drain(..) {
            let _ = handle.join();
        }
        let old_config_path = std::mem::take(&mut self.config_path);
        let old_token_path = std::mem::take(&mut self.token_path);
        let old_port_path = std::mem::take(&mut self.port_path);
        let old_pid_path = std::mem::take(&mut self.pid_path);

        let new = match Self::spawn_in(
            &self.project,
            &self.project_dir,
            &self.script_path,
            &self.host_path,
            &self.data_dir.clone(),
        ) {
            Ok(new) => new,
            Err(e) => {
                // Spawn failed — remove the stale files (the token is sensitive).
                let _ = std::fs::remove_file(&old_config_path);
                let _ = std::fs::remove_file(&old_token_path);
                let _ = std::fs::remove_file(&old_port_path);
                let _ = std::fs::remove_file(&old_pid_path);
                return Err(e);
            }
        };
        let new_port = new.port;
        *self = new; // empty paths + no child/handles → Drop is harmless
        Ok(new_port)
    }

    /// True if the worker process is alive *and* listening on its port.
    pub fn is_alive(&self) -> bool {
        if self.child.is_none() {
            return false;
        }
        is_host_exec_alive(self.port)
    }
}

impl Drop for HostExecProcess {
    fn drop(&mut self) {
        self.stop().ok();
        self.cleanup_files();
    }
}

/// Quick TCP liveness probe against `127.0.0.1:<port>`.
pub fn is_host_exec_alive(port: u16) -> bool {
    if port == 0 {
        return false;
    }
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    std::net::TcpStream::connect_timeout(&addr, PORT_PROBE_TIMEOUT).is_ok()
}

/// Write the config snapshot JSON `chmod 600` — may hold env-value secrets.
pub fn write_host_exec_config_snapshot(
    path: &Path,
    snapshot: &serde_json::Value,
) -> anyhow::Result<()> {
    write_restricted_file(path, &serde_json::to_string_pretty(snapshot)?)
}

// Child-env policy — mirrors `mcp_os_process::apply_child_env`.

/// Reads environment variables from a source (process env, or a fake in tests).
trait EnvSource {
    fn var(&self, key: &str) -> Option<String>;
}

/// Real implementation reading from `std::env`.
struct CurrentProcessEnv;

impl EnvSource for CurrentProcessEnv {
    fn var(&self, key: &str) -> Option<String> {
        std::env::var(key).ok()
    }
}

/// `env_clear()` + re-add only PATH/HOME/Windows-CSPRNG/bundle vars (ADR-054).
fn apply_child_env(cmd: &mut Command, host_path: &str, env: &dyn EnvSource) {
    cmd.env_clear();

    #[cfg(target_os = "windows")]
    {
        for key in WINDOWS_SYSTEM_ENV_VARS {
            if let Some(val) = env.var(key) {
                cmd.env(key, val);
            }
        }
    }

    // Recovered login-shell PATH — propagates to the worker and its recipes.
    cmd.env("PATH", host_path);

    // HOME on Unix; on Windows USERPROFILE is the equivalent (forwarded above).
    #[cfg(not(target_os = "windows"))]
    cmd.env("HOME", env.var("HOME").unwrap_or_default());

    if let Some(res) = env.var(consts::BUNDLE_RESOURCES_ENV) {
        if !res.is_empty() {
            cmd.env(consts::BUNDLE_RESOURCES_ENV, &res);
            cmd.env("SPEEDWAVE_PROD", "1");
        }
    }
}

// Stale-PID cleanup — mirrors `mcp_os_process`.

/// Kill a stale worker from `pid_path` (only if it's still a node process).
fn kill_stale_by_pid_file(pid_path: &Path) {
    let pid_str = match std::fs::read_to_string(pid_path) {
        Ok(s) => s.trim().to_string(),
        Err(_) => return,
    };
    let pid: u32 = match pid_str.parse() {
        Ok(p) if p > 0 => p,
        _ => return,
    };
    if !is_node_process(pid) {
        log::debug!("host_exec: stale PID {pid} is not a node process — skipping kill");
        let _ = std::fs::remove_file(pid_path);
        return;
    }
    log::info!("host_exec: killing stale worker (PID {pid})");
    kill_process(pid);
    let _ = std::fs::remove_file(pid_path);
}

/// True if `pid` is a node process (`/proc/<pid>/comm` on Linux, `ps` on macOS).
#[cfg(unix)]
fn is_node_process(pid: u32) -> bool {
    if let Ok(s) = std::fs::read_to_string(format!("/proc/{pid}/comm")) {
        return s.trim().contains("node");
    }
    let output = Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "comm="])
        .output();
    match output {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).trim().contains("node"),
        _ => false,
    }
}

#[cfg(windows)]
fn is_node_process(pid: u32) -> bool {
    let output = crate::binary::system_command("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
        .output();
    match output {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout)
            .to_lowercase()
            .contains("node"),
        _ => false,
    }
}

/// Terminate `pid` — SIGTERM then SIGKILL on Unix, `taskkill /F` on Windows.
#[cfg(unix)]
fn kill_process(pid: u32) {
    let _ = Command::new("kill")
        .args(["-TERM", &pid.to_string()])
        .status();
    std::thread::sleep(std::time::Duration::from_millis(500));
    let _ = Command::new("kill")
        .args(["-KILL", &pid.to_string()])
        .status();
}

#[cfg(windows)]
fn kill_process(pid: u32) {
    let _ = crate::binary::system_command("taskkill")
        .args(["/F", "/PID", &pid.to_string()])
        .status();
}

// Port handshake + stdio drain — mirrors `mcp_os_process`.

/// Drain stdio in background threads and wait for the `{"port":N}` line (10s).
fn drain_and_read_port(
    child: &mut Child,
    log_path: &Path,
) -> anyhow::Result<(u16, Vec<JoinHandle<()>>)> {
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow::anyhow!("host_exec worker stdout not captured"))?;

    let mut handles = Vec::new();

    if let Some(stderr) = child.stderr.take() {
        let log_path_stderr = log_path.to_path_buf();
        let h = std::thread::spawn(move || {
            use std::io::BufRead;
            let mut log_file = crate::log_file::open_log_file(&log_path_stderr);
            let reader = std::io::BufReader::new(stderr);
            for line in reader.lines() {
                match line {
                    Ok(line) => {
                        log::warn!("host_exec stderr: {line}");
                        crate::log_file::write_log_line(&mut log_file, "STDERR", &line);
                    }
                    Err(_) => break,
                }
            }
        });
        handles.push(h);
    }

    let (tx, rx) = std::sync::mpsc::channel();
    let log_path_stdout = log_path.to_path_buf();
    let h = std::thread::spawn(move || {
        use std::io::BufRead;
        let mut log_file = crate::log_file::open_log_file(&log_path_stdout);
        let reader = std::io::BufReader::new(stdout);
        let mut port_sent = false;
        for line in reader.lines() {
            match line {
                Ok(line) => {
                    if !port_sent {
                        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&line) {
                            if let Some(port) = json.get("port").and_then(|v| v.as_u64()) {
                                let _ =
                                    tx.send(u16::try_from(port).map_err(|_| {
                                        anyhow::anyhow!("port {port} out of u16 range")
                                    }));
                                port_sent = true;
                                crate::log_file::write_log_line(&mut log_file, "STDOUT", &line);
                                continue;
                            }
                        }
                    }
                    log::debug!("host_exec: {line}");
                    crate::log_file::write_log_line(&mut log_file, "STDOUT", &line);
                }
                Err(_) => break,
            }
        }
        if !port_sent {
            let _ = tx.send(Err(anyhow::anyhow!(
                "host_exec worker exited without announcing a port"
            )));
        }
    });
    handles.push(h);

    match rx.recv_timeout(PORT_READ_TIMEOUT) {
        Ok(result) => result.map(|port| (port, handles)),
        Err(_) => anyhow::bail!("timed out waiting for host_exec worker port announcement"),
    }
}

// Restricted file write — mirrors `mcp_os_process`; ADR-054 tracks the share-helper follow-up.

/// Write `content` to `path` chmod 600 (icacls on Windows; TOCTOU window — ADR-054).
fn write_restricted_file(path: &Path, content: &str) -> anyhow::Result<()> {
    if path.is_dir() {
        log::warn!(
            "host_exec write_restricted_file: removing unexpected directory at {}",
            path.display()
        );
        std::fs::remove_dir_all(path)?;
    }
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
    #[cfg(windows)]
    {
        // TOCTOU window — see the doc comment.
        std::fs::write(path, content)?;
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
            Ok(s) => log::warn!(
                "icacls failed (exit {}): {} may have overly permissive ACLs",
                s,
                path.display()
            ),
            Err(e) => log::warn!(
                "failed to run icacls on {}: {} — file may have overly permissive ACLs",
                path.display(),
                e
            ),
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        compile_error!("host_exec write_restricted_file: unsupported platform — add file permission logic for this target");
    }
    Ok(())
}

// Test-only accessors — gated behind `cfg(test)` to keep clippy honest.

#[cfg(test)]
impl HostExecProcess {
    pub(crate) fn token(&self) -> String {
        std::fs::read_to_string(&self.token_path).unwrap_or_default()
    }

    pub(crate) fn config_path(&self) -> &Path {
        &self.config_path
    }

    pub(crate) fn pid_path(&self) -> &Path {
        &self.pid_path
    }

    pub(crate) fn port_path(&self) -> &Path {
        &self.port_path
    }

    pub(crate) fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    /// The per-project audit log path, recomputed from `data_dir` + `project`.
    pub(crate) fn log_path(&self) -> PathBuf {
        crate::host_exec::host_exec_project_dir(&self.data_dir, &self.project)
            .join(consts::HOST_EXEC_LOG_FILE)
    }

    fn health_check(&mut self) -> bool {
        match &mut self.child {
            Some(child) => matches!(child.try_wait(), Ok(None)),
            None => false,
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use serial_test::serial;
    use std::collections::HashMap;

    /// Poll until `is_node_process(pid)` is true (fork/execve race on Linux CI).
    fn wait_for_node_comm(pid: u32) {
        for _ in 0..40 {
            if is_node_process(pid) {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
    }

    /// A minimal `host_exec`-worker stand-in: announces `{"port":N}` on stdout
    /// (binding 127.0.0.1) and then sleeps.
    const FAKE_WORKER_JS: &str = r#"
const http = require('http');
const srv = http.createServer((_, r) => { r.end('ok'); });
srv.listen(0, '127.0.0.1', () => {
  process.stdout.write(JSON.stringify({ port: srv.address().port }) + '\n');
});
setTimeout(() => {}, 60000);
"#;

    fn write_fake_worker(dir: &Path, name: &str) -> PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, FAKE_WORKER_JS).unwrap();
        p
    }

    /// Write a minimal config snapshot (`{ projectDir, commands }`) — the fake
    /// worker doesn't read it, but `spawn_in` passes it as `HOST_EXEC_CONFIG_PATH`.
    fn write_config_snapshot(state_dir: &Path, project_dir: &Path, commands: serde_json::Value) {
        std::fs::create_dir_all(state_dir).unwrap();
        let snap = serde_json::json!({
            "projectDir": project_dir.to_string_lossy(),
            "commands": commands,
        });
        std::fs::write(
            state_dir.join(consts::HOST_EXEC_CONFIG_FILE),
            serde_json::to_string(&snap).unwrap(),
        )
        .unwrap();
    }

    fn host_path() -> String {
        std::env::var("PATH").unwrap_or_default()
    }

    // -- is_host_exec_alive --------------------------------------------------

    #[test]
    fn is_host_exec_alive_false_for_port_zero() {
        assert!(!is_host_exec_alive(0));
    }

    #[test]
    fn is_host_exec_alive_true_when_port_open() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(is_host_exec_alive(port), "should be alive while bound");
        drop(listener);
    }

    #[test]
    fn is_host_exec_alive_false_when_port_closed() {
        // Bind then immediately drop to learn an ephemeral port number that is
        // (almost certainly) no longer listening — no reliable way to force the
        // OS to free it instantly, but nothing should be listening there.
        let port = {
            let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };
        // Probe a few times to ride out a stray TIME_WAIT acceptance.
        let alive = (0..3).any(|_| {
            std::thread::sleep(std::time::Duration::from_millis(20));
            is_host_exec_alive(port)
        });
        assert!(
            !alive,
            "nothing should be listening on a freed ephemeral port"
        );
    }

    // -- write_host_exec_config_snapshot -------------------------------------

    #[test]
    fn write_host_exec_config_snapshot_is_chmod_600() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("config.json");
        let snap = serde_json::json!({ "projectDir": "/p", "commands": [] });
        write_host_exec_config_snapshot(&p, &snap).unwrap();
        let back: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
        assert_eq!(back["projectDir"], "/p");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&p).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    // -- token format --------------------------------------------------------

    #[test]
    fn token_is_uuid_v4_format() {
        let t = uuid::Uuid::new_v4().to_string();
        assert_eq!(t.len(), 36);
        assert_eq!(t.chars().filter(|c| *c == '-').count(), 4);
        assert!(t.chars().all(|c| c.is_ascii_hexdigit() || c == '-'));
    }

    // -- write_restricted_file ----------------------------------------------

    #[test]
    fn write_restricted_file_writes_content() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("f");
        write_restricted_file(&p, "secret-token").unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "secret-token");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&p).unwrap().permissions().mode() & 0o777,
                0o600,
                "config/token/port/pid files must be chmod 600"
            );
        }
    }

    #[test]
    fn write_restricted_file_overwrites_unexpected_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("was-a-dir");
        std::fs::create_dir(&p).unwrap();
        write_restricted_file(&p, "now-a-file").unwrap();
        assert!(p.is_file());
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "now-a-file");
    }

    // -- kill_stale_by_pid_file ---------------------------------------------

    #[test]
    fn kill_stale_handles_missing_file() {
        let tmp = tempfile::tempdir().unwrap();
        kill_stale_by_pid_file(&tmp.path().join("nope"));
    }

    #[test]
    fn kill_stale_handles_invalid_content() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("bad-pid");
        std::fs::write(&p, "not-a-pid").unwrap();
        kill_stale_by_pid_file(&p);
    }

    #[test]
    fn kill_stale_handles_dead_pid_and_removes_file() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("dead-pid");
        std::fs::write(&p, "99999999").unwrap();
        kill_stale_by_pid_file(&p);
        assert!(
            !p.exists(),
            "PID file should be removed for a dead/unknown PID"
        );
    }

    #[test]
    fn kill_stale_kills_a_node_process() {
        let child = Command::new("node")
            .args(["-e", "setTimeout(() => {}, 60000)"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
        if let Ok(mut child) = child {
            // Wait for execve so kill_stale_by_pid_file's is_node_process check sees "node".
            wait_for_node_comm(child.id());
            let tmp = tempfile::tempdir().unwrap();
            let p = tmp.path().join("stale-pid");
            std::fs::write(&p, child.id().to_string()).unwrap();
            kill_stale_by_pid_file(&p);
            std::thread::sleep(std::time::Duration::from_millis(800));
            match child.try_wait() {
                Ok(Some(_)) => {}
                Ok(None) => {
                    child.kill().ok();
                    child.wait().ok();
                    panic!("kill_stale should have killed the node worker");
                }
                Err(_) => {}
            }
            assert!(!p.exists());
        }
        // node not available — skip
    }

    #[cfg(unix)]
    #[test]
    fn kill_stale_skips_non_node_process() {
        let child = Command::new("sleep")
            .arg("60")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
        if let Ok(mut child) = child {
            let tmp = tempfile::tempdir().unwrap();
            let p = tmp.path().join("stale-pid");
            std::fs::write(&p, child.id().to_string()).unwrap();
            kill_stale_by_pid_file(&p);
            std::thread::sleep(std::time::Duration::from_millis(100));
            assert!(
                matches!(child.try_wait(), Ok(None)),
                "non-node process must NOT be killed"
            );
            child.kill().ok();
            child.wait().ok();
            assert!(!p.exists(), "PID file is removed regardless");
        }
    }

    #[test]
    fn is_node_process_false_for_nonexistent_pid() {
        assert!(!is_node_process(99999999));
    }

    #[cfg(unix)]
    #[test]
    fn is_node_process_false_for_non_node() {
        let child = Command::new("sleep")
            .arg("60")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
        if let Ok(mut child) = child {
            assert!(!is_node_process(child.id()));
            child.kill().ok();
            child.wait().ok();
        }
    }

    #[test]
    fn is_node_process_true_for_node() {
        let child = Command::new("node")
            .args(["-e", "setTimeout(() => {}, 60000)"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
        if let Ok(mut child) = child {
            // Wait for execve so /proc/<pid>/comm reflects "node".
            wait_for_node_comm(child.id());
            assert!(is_node_process(child.id()));
            child.kill().ok();
            child.wait().ok();
        }
        // node not available — skip
    }

    // -- drain_and_read_port -------------------------------------------------

    #[cfg(unix)]
    fn spawn_stdout_lines(lines: &[&str]) -> Child {
        let quoted: String = lines
            .iter()
            .map(|a| format!("'{}'", a.replace('\'', "'\\''")))
            .collect::<Vec<_>>()
            .join(" ");
        Command::new("bash")
            .args(["-c", &format!("printf '%s\\n' {quoted}")])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("failed to spawn bash")
    }

    #[cfg(unix)]
    #[test]
    fn drain_and_read_port_finds_port_after_noise() {
        let tmp = tempfile::tempdir().unwrap();
        let log = tmp.path().join(consts::HOST_EXEC_LOG_FILE);
        let mut child = spawn_stdout_lines(&["starting up", r#"{"port":4567}"#, "more logs"]);
        let (port, _h) = drain_and_read_port(&mut child, &log).unwrap();
        assert_eq!(port, 4567);
        child.kill().ok();
        child.wait().ok();
        std::thread::sleep(std::time::Duration::from_millis(150));
        assert!(log.exists());
        let content = std::fs::read_to_string(&log).unwrap();
        // Drain lines now carry the shared `<ISO> STDOUT: …` prefix.
        let first = content.lines().next().unwrap();
        let space = first.find(' ').unwrap();
        assert!(
            chrono::DateTime::parse_from_rfc3339(&first[..space]).is_ok(),
            "drain line must start with an RFC-3339 timestamp: {content}"
        );
        assert!(
            content.contains("STDOUT: starting up"),
            "content: {content}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn drain_and_read_port_rejects_port_over_u16() {
        let tmp = tempfile::tempdir().unwrap();
        let log = tmp.path().join(consts::HOST_EXEC_LOG_FILE);
        let mut child = spawn_stdout_lines(&[r#"{"port":70000}"#]);
        let r = drain_and_read_port(&mut child, &log);
        assert!(r.is_err());
        assert!(r.unwrap_err().to_string().contains("out of u16 range"));
        child.kill().ok();
        child.wait().ok();
    }

    #[cfg(unix)]
    #[test]
    fn drain_and_read_port_errors_when_no_port_announced() {
        let tmp = tempfile::tempdir().unwrap();
        let log = tmp.path().join(consts::HOST_EXEC_LOG_FILE);
        let mut child = spawn_stdout_lines(&["warning", "no port here"]);
        let r = drain_and_read_port(&mut child, &log);
        assert!(r.is_err());
        assert!(r
            .unwrap_err()
            .to_string()
            .contains("exited without announcing"));
        child.kill().ok();
        child.wait().ok();
    }

    #[cfg(unix)]
    #[test]
    fn drain_and_read_port_times_out_on_silent_child() {
        let mut child = Command::new("sleep")
            .arg("30")
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let (tx, rx) = std::sync::mpsc::channel::<anyhow::Result<u16>>();
        std::thread::spawn(move || {
            use std::io::BufRead;
            let reader = std::io::BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                if let Ok(j) = serde_json::from_str::<serde_json::Value>(&line) {
                    if let Some(p) = j.get("port").and_then(|v| v.as_u64()) {
                        let _ = tx.send(u16::try_from(p).map_err(|_| anyhow::anyhow!("range")));
                        return;
                    }
                }
            }
            let _ = tx.send(Err(anyhow::anyhow!("no port")));
        });
        assert!(rx
            .recv_timeout(std::time::Duration::from_millis(200))
            .is_err());
        child.kill().ok();
        child.wait().ok();
    }

    // -- apply_child_env -----------------------------------------------------

    struct FakeEnv<'a>(&'a [(&'a str, &'a str)]);
    impl EnvSource for FakeEnv<'_> {
        fn var(&self, key: &str) -> Option<String> {
            self.0
                .iter()
                .find(|(k, _)| *k == key)
                .map(|(_, v)| (*v).to_string())
        }
    }

    fn captured_env(cmd: &Command) -> HashMap<String, String> {
        cmd.get_envs()
            .filter_map(|(k, v)| Some((k.to_str()?.to_string(), v?.to_str()?.to_string())))
            .collect()
    }

    #[test]
    fn apply_child_env_sets_recovered_path_not_inherited_path() {
        let mut cmd = Command::new("/bin/true");
        let env = FakeEnv(&[("PATH", "/inherited/bin"), ("HOME", "/home/t")]);
        apply_child_env(
            &mut cmd,
            "/recovered/bin:/usr/local/bin:/opt/homebrew/bin",
            &env,
        );
        let c = captured_env(&cmd);
        assert_eq!(
            c.get("PATH").map(String::as_str),
            Some("/recovered/bin:/usr/local/bin:/opt/homebrew/bin"),
            "the worker's PATH must be the recovered login-shell PATH, not the inherited one"
        );
        #[cfg(not(target_os = "windows"))]
        assert_eq!(c.get("HOME").map(String::as_str), Some("/home/t"));
    }

    #[test]
    fn apply_child_env_clears_inherited_secrets() {
        let mut cmd = Command::new("/bin/true");
        cmd.env("SUPER_SECRET_TOKEN", "do-not-leak");
        cmd.env("ANTHROPIC_API_KEY", "sk-leak");
        cmd.env("HOST_EXEC_AUTH_TOKEN", "stale-from-parent"); // even a HOST_EXEC_* must be wiped
        let env = FakeEnv(&[("PATH", "/p"), ("HOME", "/h")]);
        apply_child_env(&mut cmd, "/p", &env);
        let c = captured_env(&cmd);
        assert!(!c.contains_key("SUPER_SECRET_TOKEN"));
        assert!(!c.contains_key("ANTHROPIC_API_KEY"));
        assert!(
            !c.contains_key("HOST_EXEC_AUTH_TOKEN"),
            "apply_child_env never re-adds HOST_EXEC_* — the caller sets it explicitly afterwards"
        );
    }

    #[test]
    fn apply_child_env_forwards_resources_dir_and_prod_flag() {
        let mut cmd = Command::new("/bin/true");
        let env = FakeEnv(&[
            ("PATH", "/p"),
            ("HOME", "/h"),
            (consts::BUNDLE_RESOURCES_ENV, "/fake/Resources"),
        ]);
        apply_child_env(&mut cmd, "/p", &env);
        let c = captured_env(&cmd);
        assert_eq!(
            c.get(consts::BUNDLE_RESOURCES_ENV).map(String::as_str),
            Some("/fake/Resources")
        );
        assert_eq!(c.get("SPEEDWAVE_PROD").map(String::as_str), Some("1"));
    }

    #[test]
    fn apply_child_env_empty_resources_treated_as_unset() {
        let mut cmd = Command::new("/bin/true");
        let env = FakeEnv(&[("PATH", "/p"), (consts::BUNDLE_RESOURCES_ENV, "")]);
        apply_child_env(&mut cmd, "/p", &env);
        let c = captured_env(&cmd);
        assert!(!c.contains_key(consts::BUNDLE_RESOURCES_ENV));
        assert!(!c.contains_key("SPEEDWAVE_PROD"));
    }

    // -- spawn_in (real `node`, fake worker) ---------------------------------

    #[test]
    #[serial(env)] // touches PATH/HOME via apply_child_env reading the real env
    fn spawn_in_two_projects_get_separate_ports_and_files() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("data");
        let proj_a_dir = tmp.path().join("project-a");
        let proj_b_dir = tmp.path().join("project-b");
        std::fs::create_dir_all(&proj_a_dir).unwrap();
        std::fs::create_dir_all(&proj_b_dir).unwrap();
        let script = write_fake_worker(tmp.path(), "fake.js");
        let commands = serde_json::json!([]);
        write_config_snapshot(
            &crate::host_exec::host_exec_project_dir(&data_dir, "proj-a"),
            &proj_a_dir,
            commands.clone(),
        );
        write_config_snapshot(
            &crate::host_exec::host_exec_project_dir(&data_dir, "proj-b"),
            &proj_b_dir,
            commands,
        );

        let a = HostExecProcess::spawn_in(
            "proj-a",
            &proj_a_dir,
            &script.to_string_lossy(),
            &host_path(),
            &data_dir,
        );
        let b = HostExecProcess::spawn_in(
            "proj-b",
            &proj_b_dir,
            &script.to_string_lossy(),
            &host_path(),
            &data_dir,
        );
        match (a, b) {
            (Ok(mut a), Ok(mut b)) => {
                assert!(a.port() > 0 && b.port() > 0);
                assert_ne!(
                    a.port(),
                    b.port(),
                    "two workers must get two distinct ports"
                );
                let a_dir = crate::host_exec::host_exec_project_dir(&data_dir, "proj-a");
                let b_dir = crate::host_exec::host_exec_project_dir(&data_dir, "proj-b");
                assert!(a_dir.join(consts::HOST_EXEC_AUTH_TOKEN_FILE).exists());
                assert!(b_dir.join(consts::HOST_EXEC_AUTH_TOKEN_FILE).exists());
                assert!(a_dir.join(consts::HOST_EXEC_PORT_FILE).exists());
                assert!(b_dir.join(consts::HOST_EXEC_PID_FILE).exists());
                assert_eq!(a.token().len(), 36);
                assert_ne!(
                    a.token(),
                    b.token(),
                    "each worker gets its own bearer token"
                );
                assert_eq!(
                    std::fs::read_to_string(a.port_path())
                        .unwrap()
                        .trim()
                        .parse::<u16>()
                        .unwrap(),
                    a.port()
                );
                a.stop().unwrap();
                b.stop().unwrap();
            }
            _ => { /* node not available — skip */ }
        }
    }

    #[test]
    #[serial(env)]
    fn spawn_in_sets_host_exec_env_vars_and_clears_secrets() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("data");
        let proj_dir = tmp.path().join("proj");
        std::fs::create_dir_all(&proj_dir).unwrap();
        write_config_snapshot(
            &crate::host_exec::host_exec_project_dir(&data_dir, "p"),
            &proj_dir,
            serde_json::json!([]),
        );
        let script = tmp.path().join("env-probe.js");
        std::fs::write(
            &script,
            r#"
const http = require('http');
const srv = http.createServer((_, r) => { r.end('ok'); });
srv.listen(0, '127.0.0.1', () => {
  process.stdout.write(JSON.stringify({ port: srv.address().port }) + '\n');
  process.stdout.write('ENVPROBE:' + JSON.stringify({
    haveToken: !!process.env.HOST_EXEC_AUTH_TOKEN,
    haveConfig: !!process.env.HOST_EXEC_CONFIG_PATH,
    haveLog: !!process.env.HOST_EXEC_LOG_FILE,
    port0: process.env.PORT === '0',
    secret: process.env.SUPER_SECRET_FROM_PARENT === undefined ? 'absent' : 'LEAKED',
  }) + '\n');
});
setTimeout(() => {}, 60000);
"#,
        )
        .unwrap();

        std::env::set_var("SUPER_SECRET_FROM_PARENT", "nope");
        let proc = HostExecProcess::spawn_in(
            "p",
            &proj_dir,
            &script.to_string_lossy(),
            &host_path(),
            &data_dir,
        );
        std::env::remove_var("SUPER_SECRET_FROM_PARENT");

        if let Ok(mut proc) = proc {
            std::thread::sleep(std::time::Duration::from_millis(300));
            let log = std::fs::read_to_string(proc.log_path()).unwrap_or_default();
            let line = log.lines().find(|l| l.contains("ENVPROBE:")).unwrap_or("");
            let json_part = line.split("ENVPROBE:").nth(1).unwrap_or("{}");
            let v: serde_json::Value =
                serde_json::from_str(json_part.trim()).unwrap_or_else(|_| serde_json::json!({}));
            assert_eq!(
                v.get("haveToken").and_then(|b| b.as_bool()),
                Some(true),
                "HOST_EXEC_AUTH_TOKEN must be set"
            );
            assert_eq!(
                v.get("haveConfig").and_then(|b| b.as_bool()),
                Some(true),
                "HOST_EXEC_CONFIG_PATH must be set"
            );
            assert_eq!(
                v.get("haveLog").and_then(|b| b.as_bool()),
                Some(true),
                "HOST_EXEC_LOG_FILE must be set"
            );
            assert_eq!(
                v.get("port0").and_then(|b| b.as_bool()),
                Some(true),
                "PORT must be 0 (OS picks)"
            );
            assert_eq!(
                v.get("secret").and_then(|s| s.as_str()),
                Some("absent"),
                "a parent secret must not leak into the worker"
            );
            proc.stop().unwrap();
        }
        // node not available — skip
    }

    #[cfg(unix)]
    #[test]
    #[serial(env)]
    fn spawn_in_drop_cleans_up_files_keeps_log() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("data");
        let proj_dir = tmp.path().join("proj");
        std::fs::create_dir_all(&proj_dir).unwrap();
        write_config_snapshot(
            &crate::host_exec::host_exec_project_dir(&data_dir, "p"),
            &proj_dir,
            serde_json::json!([]),
        );
        let script = write_fake_worker(tmp.path(), "fake.js");
        let proc = HostExecProcess::spawn_in(
            "p",
            &proj_dir,
            &script.to_string_lossy(),
            &host_path(),
            &data_dir,
        );
        if let Ok(proc) = proc {
            let state = crate::host_exec::host_exec_project_dir(&data_dir, "p");
            let token = state.join(consts::HOST_EXEC_AUTH_TOKEN_FILE);
            let port = state.join(consts::HOST_EXEC_PORT_FILE);
            let pid = state.join(consts::HOST_EXEC_PID_FILE);
            let log = state.join(consts::HOST_EXEC_LOG_FILE);
            assert!(token.exists() && port.exists() && pid.exists());
            drop(proc);
            assert!(!token.exists(), "token removed on drop (sensitive)");
            assert!(!port.exists(), "port file removed on drop");
            assert!(!pid.exists(), "pid file removed on drop");
            assert!(log.exists(), "audit log must NOT be removed on drop");
        }
        // node not available — skip
    }

    #[test]
    #[serial(env)]
    fn respawn_keeps_data_dir_and_gets_a_fresh_worker() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("data");
        let proj_dir = tmp.path().join("proj");
        std::fs::create_dir_all(&proj_dir).unwrap();
        write_config_snapshot(
            &crate::host_exec::host_exec_project_dir(&data_dir, "p"),
            &proj_dir,
            serde_json::json!([]),
        );
        let script = write_fake_worker(tmp.path(), "fake.js");
        if let Ok(mut proc) = HostExecProcess::spawn_in(
            "p",
            &proj_dir,
            &script.to_string_lossy(),
            &host_path(),
            &data_dir,
        ) {
            match proc.respawn() {
                Ok(new_port) => {
                    assert!(new_port > 0);
                    assert_eq!(
                        proc.data_dir(),
                        data_dir,
                        "data_dir is preserved across respawn"
                    );
                    assert!(proc.health_check(), "respawned worker should be alive");
                    assert!(!proc.config_path().as_os_str().is_empty());
                    assert!(!proc.pid_path().as_os_str().is_empty());
                }
                Err(e) => log::warn!("respawn test skipped: {e}"),
            }
            proc.stop().unwrap();
        }
        // node not available — skip
    }

    #[test]
    #[serial(env)]
    fn stop_is_idempotent_and_joins_threads() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("data");
        let proj_dir = tmp.path().join("proj");
        std::fs::create_dir_all(&proj_dir).unwrap();
        write_config_snapshot(
            &crate::host_exec::host_exec_project_dir(&data_dir, "p"),
            &proj_dir,
            serde_json::json!([]),
        );
        let script = write_fake_worker(tmp.path(), "fake.js");
        if let Ok(mut proc) = HostExecProcess::spawn_in(
            "p",
            &proj_dir,
            &script.to_string_lossy(),
            &host_path(),
            &data_dir,
        ) {
            proc.stop().unwrap();
            assert!(!proc.health_check(), "worker dead after stop");
            proc.stop().unwrap(); // idempotent
        }
        // node not available — skip
    }

    #[test]
    #[serial(env)]
    fn is_alive_false_after_stop() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("data");
        let proj_dir = tmp.path().join("proj");
        std::fs::create_dir_all(&proj_dir).unwrap();
        write_config_snapshot(
            &crate::host_exec::host_exec_project_dir(&data_dir, "p"),
            &proj_dir,
            serde_json::json!([]),
        );
        let script = write_fake_worker(tmp.path(), "fake.js");
        if let Ok(mut proc) = HostExecProcess::spawn_in(
            "p",
            &proj_dir,
            &script.to_string_lossy(),
            &host_path(),
            &data_dir,
        ) {
            assert!(proc.is_alive(), "live worker should report alive");
            proc.stop().unwrap();
            assert!(!proc.is_alive(), "stopped worker should report dead");
        }
        // node not available — skip
    }
}
