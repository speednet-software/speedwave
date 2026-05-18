//! Per-project process manager for the `oauth` MCP worker (ADR-060).
//!
//! Mirrors `host_exec_process.rs` mechanics. The oauth worker holds
//! OAuth `refresh_token`, `client_id`, `tenant_id` for each OAuth-using
//! service in the project and exposes `refresh` / `forget` tools to
//! authenticated callers (other workers in the same project — today:
//! SharePoint). The hub does NOT know about it.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread::JoinHandle;

use crate::consts;
use crate::fs_perms::write_restricted_file;

/// Worker port-announcement read timeout (same value as `mcp-os` / `host_exec`).
const PORT_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// Cap on the per-project audit log size at spawn time.
const LOG_MAX_BYTES: u64 = 2 * 1024 * 1024;

/// Defense-in-depth slug check applied before writing a service id into the
/// bearer-map. Mirrors `plugin::validate_manifest`'s slug regex so a malformed
/// service id cannot escape as a path component in `loadOAuthState` or
/// `accessTokenPathFor` (ADR-060 §"Per-service bearer", security audit P0-1).
fn is_valid_service_slug(slug: &str) -> bool {
    if slug.is_empty() || slug.len() > 64 {
        return false;
    }
    let bytes = slug.as_bytes();
    if !bytes[0].is_ascii_lowercase() {
        return false;
    }
    bytes
        .iter()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

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

/// Per-project `oauth` worker state directory: `<data_dir>/oauth/<project>/`.
///
/// Created with mode 0o700 so the TS-side `writeRestrictedSecret` can rely on
/// the parent being owner-only (defense in depth for `oauth.json`).
pub fn oauth_project_dir(data_dir: &Path, project: &str) -> PathBuf {
    data_dir.join(consts::OAUTH_SUBDIR).join(project)
}

/// Manages one project's `oauth` worker as a child Node process.
pub struct OauthProcess {
    project: String,
    child: Option<Child>,
    drain_handles: Vec<JoinHandle<()>>,
    data_dir: PathBuf,
    state_dir: PathBuf,
    token_path: PathBuf,
    port_path: PathBuf,
    pid_path: PathBuf,
    port: u16,
    script_path: String,
}

impl OauthProcess {
    /// Spawn an `oauth` worker; blocks ~10s for the `{"port":N}` handshake.
    pub fn spawn_in(
        project: &str,
        script_path: &str,
        data_dir: &Path,
        consumers: &[&str],
    ) -> anyhow::Result<Self> {
        let state_dir = oauth_project_dir(data_dir, project);
        std::fs::create_dir_all(&state_dir)?;
        set_dir_owner_only(&state_dir)?;

        let token = uuid::Uuid::new_v4().to_string();
        let token_path = state_dir.join(consts::OAUTH_AUTH_TOKEN_FILE);
        let port_path = state_dir.join(consts::OAUTH_PORT_FILE);
        let pid_path = state_dir.join(consts::OAUTH_PID_FILE);
        let log_path = state_dir.join(consts::OAUTH_LOG_FILE);
        let bearer_map_path = state_dir.join(consts::OAUTH_BEARER_MAP_FILE);

        // Kill any stale worker from a previous session.
        kill_stale_by_pid_file(&pid_path);

        // Pre-create log chmod 600 so the worker opens an already-restricted file.
        crate::log_file::truncate_if_oversized(&log_path, LOG_MAX_BYTES);
        let _ = crate::log_file::open_log_file(&log_path);

        // Supervisor token — chmod 600. Not used to authenticate callers
        // (each consumer has its own bearer in `.bearer-map.json`); this token
        // is for the supervisor's own diagnostic handshake.
        write_restricted_file(&token_path, &token)?;

        // Generate per-consumer bearer tokens. Each consumer gets a fresh UUID
        // bound to its service id; the worker derives `caller` from the bearer
        // via `.bearer-map.json` (ADR-060 §"Per-service bearer"). Both files
        // are atomic 0o600 writes. Empty consumer list = empty map (no consumer
        // can authenticate, worker still starts for diagnostic handshake).
        let mut bearer_map: std::collections::BTreeMap<String, String> =
            std::collections::BTreeMap::new();
        for service in consumers {
            // Slug regex matches plugin convention; reject anything that could
            // be a path segment or query injection in the bearer-map.
            if !is_valid_service_slug(service) {
                anyhow::bail!(
                    "oauth: refused to provision bearer for invalid service slug '{service}'"
                );
            }
            let bearer = uuid::Uuid::new_v4().to_string();
            bearer_map.insert(bearer.clone(), (*service).to_string());
            // Per-service bearer file consumed by `apply_oauth_config_with_paths`
            // when injecting `/secrets/oauth-auth-token-<service>:ro` into the
            // consumer worker container.
            let bearer_file = state_dir.join(format!("bearer-{service}"));
            write_restricted_file(&bearer_file, &bearer)?;
        }
        let bearer_map_json = serde_json::to_string_pretty(&bearer_map)?;
        write_restricted_file(&bearer_map_path, &bearer_map_json)?;

        let tokens_base = data_dir.join("tokens");
        let mut cmd = crate::binary::command("node");
        cmd.arg(script_path);
        apply_child_env(&mut cmd, &CurrentProcessEnv);
        cmd.env("PORT", "0")
            .env("OAUTH_STATE_DIR", &state_dir)
            .env("OAUTH_LOG_FILE", &log_path)
            .env("OAUTH_PROJECT", project)
            .env("OAUTH_SUPERVISOR_TOKEN", &token)
            .env("OAUTH_TOKENS_BASE", &tokens_base)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = cmd.spawn()?;
        write_restricted_file(&pid_path, &child.id().to_string())?;

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

        if let Err(e) = write_restricted_file(&port_path, &port.to_string()) {
            child.kill().ok();
            child.wait().ok();
            let _ = std::fs::remove_file(&token_path);
            let _ = std::fs::remove_file(&pid_path);
            return Err(e);
        }

        Ok(Self {
            project: project.to_string(),
            child: Some(child),
            drain_handles,
            data_dir: data_dir.to_path_buf(),
            state_dir,
            token_path,
            port_path,
            pid_path,
            port,
            script_path: script_path.to_string(),
        })
    }

    /// Port `127.0.0.1:<port>` the worker is listening on.
    pub fn port(&self) -> u16 {
        self.port
    }

    /// Project this worker is bound to.
    pub fn project(&self) -> &str {
        &self.project
    }

    /// Per-project state directory `<data_dir>/oauth/<project>/`.
    pub fn state_dir(&self) -> &Path {
        &self.state_dir
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

    /// Remove token, port, PID files. Audit log and `oauth.json` files are kept
    /// (the OAuth state is persistent across worker restarts).
    pub fn cleanup_files(&self) {
        let _ = std::fs::remove_file(&self.token_path);
        let _ = std::fs::remove_file(&self.port_path);
        let _ = std::fs::remove_file(&self.pid_path);
    }

    /// True if the worker process is alive *and* listening on its port.
    pub fn is_alive(&self) -> bool {
        if self.child.is_none() {
            return false;
        }
        is_oauth_alive(self.port)
    }

    /// Stop and respawn for the same project. Reuses the existing consumer list
    /// from disk (`.bearer-map.json`) so bearer files remain stable across
    /// supervisor restarts; consumers don't need to reload their bearer mounts.
    /// Caller still triggers compose re-render to pick up the new port.
    ///
    /// On error: `self.child` is `None` and `self.port` is reset to `0`, so
    /// `is_alive()` returns `false` and `port()` returns the sentinel.
    pub fn respawn(&mut self) -> anyhow::Result<u16> {
        if let Some(mut child) = self.child.take() {
            child.kill().ok();
            child.wait().ok();
        }
        for handle in self.drain_handles.drain(..) {
            let _ = handle.join();
        }
        // Zero the port now so a failed spawn_in below leaves us in a known
        // post-error state (port() returns 0 sentinel instead of the dead port).
        self.port = 0;
        // Read back existing bearer-map to preserve consumer→bearer mapping.
        let bearer_map_path = self.state_dir.join(consts::OAUTH_BEARER_MAP_FILE);
        let existing_services = read_consumers_from_bearer_map(&bearer_map_path);
        let consumer_refs: Vec<&str> = existing_services.iter().map(String::as_str).collect();
        let new = Self::spawn_in(
            &self.project,
            &self.script_path,
            &self.data_dir.clone(),
            &consumer_refs,
        )?;
        let new_port = new.port;
        *self = new;
        Ok(new_port)
    }
}

/// Best-effort read of `<service>` values from an existing bearer-map. Used by
/// `respawn` to keep the same consumer set across supervisor restarts. Errors
/// degrade to an empty list (no consumers reprovisioned).
fn read_consumers_from_bearer_map(path: &Path) -> Vec<String> {
    let Ok(content) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(map) = serde_json::from_str::<std::collections::BTreeMap<String, String>>(&content)
    else {
        return Vec::new();
    };
    map.into_values().collect()
}

impl Drop for OauthProcess {
    fn drop(&mut self) {
        self.stop().ok();
        self.cleanup_files();
    }
}

/// TCP liveness probe against `127.0.0.1:<port>`. Retries on failure with
/// backoff — oauth respawn forces a recreate of every consumer container,
/// so a transient probe failure (worker mid-refresh, accept loop briefly
/// stalled) must NOT cascade into a respawn loop. Constants live in
/// `consts::PORT_PROBE_ATTEMPTS` / `consts::PORT_PROBE_BACKOFF`.
pub fn is_oauth_alive(port: u16) -> bool {
    if port == 0 {
        return false;
    }
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    for attempt in 0..consts::PORT_PROBE_ATTEMPTS {
        if std::net::TcpStream::connect_timeout(&addr, consts::PORT_PROBE_TIMEOUT).is_ok() {
            return true;
        }
        if attempt + 1 < consts::PORT_PROBE_ATTEMPTS {
            std::thread::sleep(consts::PORT_PROBE_BACKOFF);
        }
    }
    false
}

/// Set owner-only permissions on the per-project state dir.
fn set_dir_owner_only(_dir: &Path) -> anyhow::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = consts::OAUTH_PROJECT_DIR_MODE;
        std::fs::set_permissions(_dir, std::fs::Permissions::from_mode(mode))?;
    }
    // On Windows, the parent dir's ACL inherits from `~/.speedwave/` which is
    // user-owned by default. A future hardening pass can add explicit ACL here.
    Ok(())
}

// ---------------------------------------------------------------------------
// Child-env policy — narrower than host_exec (no recipes, no project_dir).
// ---------------------------------------------------------------------------

trait EnvSource {
    fn var(&self, key: &str) -> Option<String>;
}

struct CurrentProcessEnv;

impl EnvSource for CurrentProcessEnv {
    fn var(&self, key: &str) -> Option<String> {
        std::env::var(key).ok()
    }
}

/// `env_clear()` + re-add only PATH/HOME/Windows-CSPRNG/bundle vars.
fn apply_child_env(cmd: &mut Command, env: &dyn EnvSource) {
    cmd.env_clear();

    #[cfg(target_os = "windows")]
    {
        for key in WINDOWS_SYSTEM_ENV_VARS {
            if let Some(val) = env.var(key) {
                cmd.env(key, val);
            }
        }
    }

    if let Some(p) = env.var("PATH") {
        cmd.env("PATH", p);
    }

    #[cfg(not(target_os = "windows"))]
    cmd.env("HOME", env.var("HOME").unwrap_or_default());

    if let Some(res) = env.var(consts::BUNDLE_RESOURCES_ENV) {
        if !res.is_empty() {
            cmd.env(consts::BUNDLE_RESOURCES_ENV, &res);
            cmd.env("SPEEDWAVE_PROD", "1");
        }
    }
}

// ---------------------------------------------------------------------------
// Stale-PID cleanup — mirrors host_exec / mcp_os.
// ---------------------------------------------------------------------------

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
        log::debug!("oauth: stale PID {pid} is not a node process — skipping kill");
        let _ = std::fs::remove_file(pid_path);
        return;
    }
    log::info!("oauth: killing stale worker (PID {pid})");
    kill_process(pid);
    let _ = std::fs::remove_file(pid_path);
}

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

#[cfg(unix)]
fn kill_process(pid: u32) {
    let _ = Command::new("kill").arg(pid.to_string()).status();
    std::thread::sleep(std::time::Duration::from_millis(50));
    let _ = Command::new("kill").args(["-9", &pid.to_string()]).status();
}

#[cfg(windows)]
fn kill_process(pid: u32) {
    let _ = crate::binary::system_command("taskkill")
        .args(["/F", "/PID", &pid.to_string()])
        .status();
}

// ---------------------------------------------------------------------------
// Port-handshake: reads `{"port":N}` from the worker's stdout within 10s.
// Mirrors host_exec_process::drain_and_read_port.
// ---------------------------------------------------------------------------

fn drain_and_read_port(
    child: &mut Child,
    log_path: &Path,
) -> anyhow::Result<(u16, Vec<JoinHandle<()>>)> {
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow::anyhow!("oauth worker stdout not captured"))?;

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
                        log::warn!("oauth stderr: {line}");
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
                        if let Some(port) = parse_port_line(&line) {
                            let _ = tx.send(Ok(port));
                            port_sent = true;
                            crate::log_file::write_log_line(&mut log_file, "STDOUT", &line);
                            continue;
                        }
                    }
                    log::debug!("oauth: {line}");
                    crate::log_file::write_log_line(&mut log_file, "STDOUT", &line);
                }
                Err(_) => break,
            }
        }
        if !port_sent {
            let _ = tx.send(Err(anyhow::anyhow!(
                "oauth worker exited without announcing a port"
            )));
        }
    });
    handles.push(h);

    match rx.recv_timeout(PORT_READ_TIMEOUT) {
        Ok(result) => result.map(|port| (port, handles)),
        Err(_) => anyhow::bail!("timed out waiting for oauth worker port announcement"),
    }
}

fn parse_port_line(line: &str) -> Option<u16> {
    let v: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    let port = v.get("port")?.as_u64()?;
    if port == 0 || port > u16::MAX as u64 {
        return None;
    }
    u16::try_from(port).ok()
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn is_valid_service_slug_accepts_plugin_slugs() {
        assert!(is_valid_service_slug("sharepoint"));
        assert!(is_valid_service_slug("my-plugin"));
        assert!(is_valid_service_slug("a"));
        assert!(is_valid_service_slug("a1"));
    }

    #[test]
    fn is_valid_service_slug_rejects_path_traversal_and_garbage() {
        assert!(!is_valid_service_slug(""));
        assert!(!is_valid_service_slug("../etc/passwd"));
        assert!(!is_valid_service_slug("../../etc/passwd"));
        assert!(!is_valid_service_slug("a/b"));
        assert!(!is_valid_service_slug("UPPER"));
        assert!(!is_valid_service_slug("9starts-with-digit"));
        assert!(!is_valid_service_slug("-starts-with-dash"));
        assert!(!is_valid_service_slug("under_score"));
        assert!(!is_valid_service_slug("space here"));
        assert!(!is_valid_service_slug(&"x".repeat(65)));
    }

    #[test]
    fn read_consumers_from_bearer_map_returns_services() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join(".bearer-map.json");
        std::fs::write(&p, r#"{"bearer-1":"sharepoint","bearer-2":"slack"}"#).unwrap();
        let mut svcs = read_consumers_from_bearer_map(&p);
        svcs.sort();
        assert_eq!(svcs, vec!["sharepoint", "slack"]);
    }

    #[test]
    fn read_consumers_from_bearer_map_returns_empty_on_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let svcs = read_consumers_from_bearer_map(&tmp.path().join("nope"));
        assert!(svcs.is_empty());
    }

    #[test]
    fn read_consumers_from_bearer_map_returns_empty_on_bad_json() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join(".bearer-map.json");
        std::fs::write(&p, "not json").unwrap();
        let svcs = read_consumers_from_bearer_map(&p);
        assert!(svcs.is_empty());
    }

    #[test]
    fn parse_port_line_accepts_valid_json() {
        assert_eq!(parse_port_line(r#"{"port":4040}"#), Some(4040));
        assert_eq!(parse_port_line(r#"  {"port": 1}  "#), Some(1));
        assert_eq!(parse_port_line(r#"{"port":65535}"#), Some(65535));
    }

    #[test]
    fn parse_port_line_rejects_zero_and_oversize() {
        assert_eq!(parse_port_line(r#"{"port":0}"#), None);
        assert_eq!(parse_port_line(r#"{"port":65536}"#), None);
        assert_eq!(parse_port_line(r#"{"port":100000}"#), None);
    }

    #[test]
    fn parse_port_line_rejects_non_json() {
        assert_eq!(parse_port_line("starting on port 4040"), None);
        assert_eq!(parse_port_line(""), None);
        assert_eq!(parse_port_line(r#"{"not_port":4040}"#), None);
    }

    #[test]
    fn oauth_project_dir_returns_subdir_join() {
        let dir = std::path::PathBuf::from("/tmp/sw");
        let path = oauth_project_dir(&dir, "my-project");
        assert_eq!(path, std::path::PathBuf::from("/tmp/sw/oauth/my-project"));
    }

    #[test]
    fn is_oauth_alive_returns_false_for_port_zero() {
        assert!(!is_oauth_alive(0));
    }

    #[test]
    fn is_oauth_alive_returns_false_for_closed_port() {
        // Port 1 is privileged and almost never listening
        assert!(!is_oauth_alive(1));
    }

    #[test]
    fn is_oauth_alive_returns_true_when_listener_accepts() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(is_oauth_alive(port));
    }

    #[test]
    fn is_oauth_alive_false_takes_at_least_two_retry_backoffs() {
        // Bind then drop so every connect_timeout gets a fast RST on every
        // platform (port 1 RST behaviour is OS/privilege-dependent and slow
        // on filtered-port CI hosts).
        let addr = {
            let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap()
        };
        let start = std::time::Instant::now();
        assert!(!is_oauth_alive(addr.port()));
        // 2 × PORT_PROBE_BACKOFF elapses between the 3 failed attempts.
        let min = consts::PORT_PROBE_BACKOFF
            .checked_mul((consts::PORT_PROBE_ATTEMPTS - 1) as u32)
            .unwrap();
        assert!(
            start.elapsed() >= min,
            "probe gave up too early: {:?}",
            start.elapsed()
        );
    }

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
    fn kill_stale_handles_negative_pid() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("neg-pid");
        std::fs::write(&p, "-1").unwrap();
        kill_stale_by_pid_file(&p);
    }

    #[cfg(unix)]
    #[test]
    fn set_dir_owner_only_sets_0o700_on_unix() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path().join("oauth-state");
        std::fs::create_dir(&d).unwrap();
        set_dir_owner_only(&d).unwrap();
        let mode = std::fs::metadata(&d).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700, "expected 0o700, got 0o{mode:o}");
    }

    // -- apply_child_env -----------------------------------------------------

    struct FakeEnv {
        vars: std::collections::HashMap<String, String>,
    }
    impl EnvSource for FakeEnv {
        fn var(&self, k: &str) -> Option<String> {
            self.vars.get(k).cloned()
        }
    }

    #[test]
    fn apply_child_env_clears_and_re_adds_path() {
        let mut cmd = Command::new("true");
        let mut vars = std::collections::HashMap::new();
        vars.insert("PATH".into(), "/usr/bin:/bin".into());
        vars.insert("SECRET".into(), "should-not-leak".into());
        apply_child_env(&mut cmd, &FakeEnv { vars });
        let env: std::collections::HashMap<_, _> = cmd
            .get_envs()
            .filter_map(|(k, v)| v.map(|val| (k.to_owned(), val.to_owned())))
            .collect();
        // PATH is re-added
        assert!(env
            .get(std::ffi::OsStr::new("PATH"))
            .map(|v| v == std::ffi::OsStr::new("/usr/bin:/bin"))
            .unwrap_or(false));
        // SECRET is not (env_clear was called)
        assert!(env.get(std::ffi::OsStr::new("SECRET")).is_none());
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn apply_child_env_sets_home_on_unix() {
        let mut cmd = Command::new("true");
        let mut vars = std::collections::HashMap::new();
        vars.insert("HOME".into(), "/home/me".into());
        apply_child_env(&mut cmd, &FakeEnv { vars });
        let env: std::collections::HashMap<_, _> = cmd
            .get_envs()
            .filter_map(|(k, v)| v.map(|val| (k.to_owned(), val.to_owned())))
            .collect();
        assert!(env
            .get(std::ffi::OsStr::new("HOME"))
            .map(|v| v == std::ffi::OsStr::new("/home/me"))
            .unwrap_or(false));
    }
}
