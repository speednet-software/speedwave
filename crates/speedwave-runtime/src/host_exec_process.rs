//! Per-project process manager for the `host_exec` MCP worker (ADR-054).
//!
//! Thin wrapper: `HostExecProcess` is a type alias over
//! [`crate::host_mcp_process::HostMcpProcess`] with `HostExecSpec` as
//! the worker spec. All lifecycle is in the generic struct; this
//! module only carries spec data (`project`, `project_dir`,
//! `host_path`, `config_path`), worker-specific env vars, and the
//! standalone `auth-token` bind-mount file the hub expects under
//! `/secrets/host_exec-auth-token:ro`.

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::consts;
use crate::fs_perms::write_restricted_file;
use crate::host_mcp_process::lock::LockService;
use crate::host_mcp_process::{HostMcpProcess, LivenessProbe, SpawnContext, WorkerSpec};

/// Worker spec for `host_exec`. Holds per-project state the generic
/// lifecycle does not know about (project name + dir, recovered
/// login-shell PATH, config snapshot path).
#[derive(Clone, Debug)]
pub struct HostExecSpec {
    project: String,
    project_dir: PathBuf,
    host_path: String,
    config_path: PathBuf,
    log_path: PathBuf,
}

impl HostExecSpec {
    pub fn project(&self) -> &str {
        &self.project
    }
    pub fn project_dir(&self) -> &Path {
        &self.project_dir
    }
    pub fn host_path(&self) -> &str {
        &self.host_path
    }
    pub fn config_path(&self) -> &Path {
        &self.config_path
    }
    pub fn log_path(&self) -> &Path {
        &self.log_path
    }
}

impl WorkerSpec for HostExecSpec {
    fn service(&self) -> LockService {
        LockService::HostExec
    }
    fn log_tag(&self) -> &'static str {
        "host_exec"
    }
    fn apply_env(&self, cmd: &mut Command, ctx: &SpawnContext) {
        cmd.env("PORT", "0")
            .env("HOST_EXEC_AUTH_TOKEN", ctx.auth_token)
            .env("HOST_EXEC_CONFIG_PATH", &self.config_path)
            .env("HOST_EXEC_LOG_FILE", &self.log_path);
    }
    fn path_override(&self) -> Option<&str> {
        Some(&self.host_path)
    }
    /// Write the standalone token mount file *before* the generic spawn
    /// writes `lock.json`. Crash-safety: a death between pre_spawn and
    /// lock::write leaves no lock.json, so the next start does a clean
    /// fresh spawn and overwrites the orphan token. Writing the token
    /// AFTER lock.json (the previous design) would risk a stale-token
    /// mount against a worker expecting a fresh one.
    fn pre_spawn(&self, ctx: &SpawnContext) -> anyhow::Result<()> {
        let token_mount_path = ctx.state_dir.join(consts::HOST_EXEC_AUTH_TOKEN_FILE);
        write_restricted_file(&token_mount_path, ctx.auth_token)
    }
    fn probe(&self) -> LivenessProbe {
        LivenessProbe::TcpSingle
    }
}

/// Type alias the rest of the codebase uses.
pub type HostExecProcess = HostMcpProcess<HostExecSpec>;

impl HostExecProcess {
    /// Spawn a `host_exec` worker. Blocks ~10s for the `{"port":N}`
    /// handshake. `host_path` is the recovered login-shell PATH (ADR-054).
    pub fn spawn_in(
        project: &str,
        project_dir: &Path,
        script_path: &str,
        host_path: &str,
        data_dir: &Path,
    ) -> anyhow::Result<Self> {
        // `state_dir` is created by `HostMcpProcess::spawn_with_spec`.
        let state_dir = crate::host_exec::host_exec_project_dir(data_dir, project);
        let config_path = state_dir.join(consts::HOST_EXEC_CONFIG_FILE);
        let log_path = state_dir.join(consts::HOST_EXEC_LOG_FILE);

        let spec = HostExecSpec {
            project: project.to_string(),
            project_dir: project_dir.to_path_buf(),
            host_path: host_path.to_string(),
            config_path,
            log_path,
        };

        // The standalone `auth-token` mount file (hub reads it from
        // `/secrets/host_exec-auth-token:ro`) is written by
        // `HostExecSpec::pre_spawn` *before* lock.json. Crash between
        // the two leaves zero files or a complete pair — never a stale
        // token paired with a fresh lock.
        HostMcpProcess::spawn_with_spec(
            spec,
            data_dir,
            state_dir,
            script_path,
            consts::HOST_EXEC_LOG_FILE,
        )
    }

    /// The cached auth token (used by the dual-write of the mount file
    /// and by `compose::apply_host_exec_config`).
    pub fn token(&self) -> &str {
        &self.auth_token
    }

    pub fn config_path(&self) -> &Path {
        self.spec().config_path()
    }

    /// The per-project audit log path. Equivalent to
    /// `<state_dir>/<HOST_EXEC_LOG_FILE>`.
    pub fn log_path(&self) -> &Path {
        self.spec().log_path()
    }
}

/// Quick TCP liveness probe against the worker's bind address.
pub fn is_host_exec_alive(port: u16) -> bool {
    if port == 0 {
        return false;
    }
    let bind = crate::host_mcp_process::probe::host_bind_address_for_probe();
    crate::host_mcp_process::probe::probe_tcp(&bind, port, 1, consts::PORT_PROBE_TIMEOUT)
}

/// Write the config snapshot JSON `chmod 600` — may hold env-value secrets.
pub fn write_host_exec_config_snapshot(
    path: &Path,
    snapshot: &serde_json::Value,
) -> anyhow::Result<()> {
    write_restricted_file(path, &serde_json::to_string_pretty(snapshot)?)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use crate::host_mcp_process::drain::test_support::write_fake_worker;
    use crate::host_mcp_process::env_policy::test_support::FakeEnv;
    use crate::host_mcp_process::lock;
    use serial_test::serial;
    use std::process::Stdio;

    fn write_config_snapshot(state_dir: &Path, project_dir: &Path, commands: serde_json::Value) {
        std::fs::create_dir_all(state_dir).unwrap();
        let snapshot = serde_json::json!({
            "schema_version": 1,
            "project_dir": project_dir.to_string_lossy(),
            "commands": commands,
        });
        write_host_exec_config_snapshot(&state_dir.join(consts::HOST_EXEC_CONFIG_FILE), &snapshot)
            .unwrap();
    }

    fn host_path() -> String {
        std::env::var("PATH").unwrap_or_default()
    }

    fn node_available() -> bool {
        Command::new("node")
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }

    #[test]
    fn host_exec_spec_service_and_tag() {
        let spec = HostExecSpec {
            project: "p".into(),
            project_dir: PathBuf::from("/tmp/p"),
            host_path: "/usr/bin".into(),
            config_path: PathBuf::from("/tmp/p/config.json"),
            log_path: PathBuf::from("/tmp/p/log"),
        };
        assert_eq!(spec.service(), LockService::HostExec);
        assert_eq!(spec.log_tag(), "host_exec");
        assert_eq!(spec.path_override(), Some("/usr/bin"));
    }

    #[test]
    fn host_exec_spec_apply_env_sets_worker_vars() {
        let spec = HostExecSpec {
            project: "p".into(),
            project_dir: PathBuf::from("/tmp/p"),
            host_path: "/usr/bin".into(),
            config_path: PathBuf::from("/tmp/p/config.json"),
            log_path: PathBuf::from("/tmp/p/log"),
        };
        let mut cmd = Command::new("true");
        let lock_path = PathBuf::from("/tmp/p/lock.json");
        let log_path = PathBuf::from("/tmp/p/log");
        let ctx = SpawnContext {
            state_dir: Path::new("/tmp/p"),
            lock_path: &lock_path,
            log_path: &log_path,
            auth_token: "uuid-host-exec",
            data_dir: Path::new("/tmp"),
        };
        spec.apply_env(&mut cmd, &ctx);
        let envs: std::collections::HashMap<_, _> = cmd
            .get_envs()
            .filter_map(|(k, v)| {
                v.map(|val| {
                    (
                        k.to_string_lossy().into_owned(),
                        val.to_string_lossy().into_owned(),
                    )
                })
            })
            .collect();
        assert_eq!(envs.get("PORT").map(String::as_str), Some("0"));
        assert_eq!(
            envs.get("HOST_EXEC_AUTH_TOKEN").map(String::as_str),
            Some("uuid-host-exec")
        );
        assert_eq!(
            envs.get("HOST_EXEC_CONFIG_PATH").map(String::as_str),
            Some("/tmp/p/config.json")
        );
        assert_eq!(
            envs.get("HOST_EXEC_LOG_FILE").map(String::as_str),
            Some("/tmp/p/log")
        );
    }

    #[test]
    fn host_exec_spec_probe_is_single_tcp() {
        let spec = HostExecSpec {
            project: "p".into(),
            project_dir: PathBuf::from("/"),
            host_path: "".into(),
            config_path: PathBuf::from(""),
            log_path: PathBuf::from(""),
        };
        assert!(matches!(spec.probe(), LivenessProbe::TcpSingle));
    }

    #[test]
    fn pre_spawn_writes_token_mount_before_lock_json() {
        // Crash-safety contract: standalone auth-token mount file is on
        // disk before lock.json. The bind mount the hub uses is keyed off
        // the per-project state_dir, so we check there.
        let tmp = tempfile::tempdir().unwrap();
        let state_dir = tmp.path().join("state");
        std::fs::create_dir_all(&state_dir).unwrap();
        let lock_path = state_dir.join(consts::PER_PROJECT_LOCK_FILE);
        let log_path = state_dir.join("log");
        let token_path = state_dir.join(consts::HOST_EXEC_AUTH_TOKEN_FILE);
        let spec = HostExecSpec {
            project: "p".into(),
            project_dir: PathBuf::from("/"),
            host_path: "/usr/bin".into(),
            config_path: state_dir.join(consts::HOST_EXEC_CONFIG_FILE),
            log_path: log_path.clone(),
        };
        let ctx = SpawnContext {
            state_dir: &state_dir,
            lock_path: &lock_path,
            log_path: &log_path,
            auth_token: "fresh-token",
            data_dir: tmp.path(),
        };
        assert!(!lock_path.exists());
        spec.pre_spawn(&ctx).unwrap();
        assert_eq!(std::fs::read_to_string(&token_path).unwrap(), "fresh-token");
        assert!(
            !lock_path.exists(),
            "pre_spawn must not write lock.json (generic spawn does it after handshake)"
        );
    }

    #[cfg(unix)]
    #[test]
    fn pre_spawn_token_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let state_dir = tmp.path().join("state");
        std::fs::create_dir_all(&state_dir).unwrap();
        let token_path = state_dir.join(consts::HOST_EXEC_AUTH_TOKEN_FILE);
        let lock_path = state_dir.join(consts::PER_PROJECT_LOCK_FILE);
        let log_path = state_dir.join("log");
        let spec = HostExecSpec {
            project: "p".into(),
            project_dir: PathBuf::from("/"),
            host_path: "/usr/bin".into(),
            config_path: state_dir.join(consts::HOST_EXEC_CONFIG_FILE),
            log_path: log_path.clone(),
        };
        let ctx = SpawnContext {
            state_dir: &state_dir,
            lock_path: &lock_path,
            log_path: &log_path,
            auth_token: "tok",
            data_dir: tmp.path(),
        };
        spec.pre_spawn(&ctx).unwrap();
        let mode = std::fs::metadata(&token_path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[test]
    fn is_host_exec_alive_false_for_port_zero() {
        assert!(!is_host_exec_alive(0));
    }

    #[test]
    fn is_host_exec_alive_false_for_closed_port() {
        // Bind+drop yields an unused port. Best-effort — race tolerant.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        // Not asserting !false here — another process may have grabbed
        // the port between drop and probe. We just verify the function
        // does not panic on a non-listening port.
        let _ = is_host_exec_alive(port);
    }

    #[test]
    fn is_host_exec_alive_true_for_open_listener() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(is_host_exec_alive(port));
        drop(listener);
    }

    #[test]
    fn write_host_exec_config_snapshot_is_chmod_600() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("config.json");
        write_host_exec_config_snapshot(&path, &serde_json::json!({"v": 1})).unwrap();
        assert!(path.exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "config snapshot must be owner-only");
        }
    }

    #[cfg(unix)]
    #[test]
    #[serial(env)]
    fn spawn_in_two_projects_get_separate_ports_and_files() {
        if !node_available() {
            return;
        }
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

        let mut a = HostExecProcess::spawn_in(
            "proj-a",
            &proj_a_dir,
            &script.to_string_lossy(),
            &host_path(),
            &data_dir,
        )
        .unwrap();
        let mut b = HostExecProcess::spawn_in(
            "proj-b",
            &proj_b_dir,
            &script.to_string_lossy(),
            &host_path(),
            &data_dir,
        )
        .unwrap();

        assert!(a.port() > 0 && b.port() > 0);
        assert_ne!(
            a.port(),
            b.port(),
            "two workers must get two distinct ports"
        );
        let a_dir = crate::host_exec::host_exec_project_dir(&data_dir, "proj-a");
        let b_dir = crate::host_exec::host_exec_project_dir(&data_dir, "proj-b");
        assert!(a_dir.join(consts::PER_PROJECT_LOCK_FILE).exists());
        assert!(b_dir.join(consts::PER_PROJECT_LOCK_FILE).exists());
        assert_eq!(a.token().len(), 36);
        assert_ne!(
            a.token(),
            b.token(),
            "each worker gets its own bearer token"
        );
        let lock = lock::read(a.lock_path(), LockService::HostExec).expect("lock.json must exist");
        assert_eq!(lock.port, a.port());
        a.stop().unwrap();
        b.stop().unwrap();
    }

    #[cfg(unix)]
    #[test]
    #[serial(env)]
    fn spawn_in_drop_cleans_up_files_keeps_log() {
        if !node_available() {
            return;
        }
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
        )
        .unwrap();
        let state = crate::host_exec::host_exec_project_dir(&data_dir, "p");
        let lock = state.join(consts::PER_PROJECT_LOCK_FILE);
        let log = state.join(consts::HOST_EXEC_LOG_FILE);
        assert!(lock.exists(), "lock.json present while worker is alive");
        drop(proc);
        assert!(!lock.exists(), "lock.json removed on drop");
        assert!(log.exists(), "audit log must NOT be removed on drop");
    }

    #[test]
    fn fake_env_proves_apply_child_env_clears_secrets() {
        // Ensures the FakeEnv pattern stays consistent across managers.
        let env = FakeEnv::empty().with("PATH", "/usr/bin");
        let mut cmd = Command::new("true");
        cmd.env("LEAK", "should-be-cleared");
        crate::host_mcp_process::apply_child_env(&mut cmd, Some("/recovered"), &env);
        let envs: std::collections::HashMap<_, _> = cmd
            .get_envs()
            .filter_map(|(k, v)| v.map(|val| (k.to_owned(), val.to_owned())))
            .collect();
        assert!(envs.get(std::ffi::OsStr::new("LEAK")).is_none());
        assert_eq!(
            envs.get(std::ffi::OsStr::new("PATH"))
                .map(|v| v.to_string_lossy().into_owned())
                .as_deref(),
            Some("/recovered"),
            "path_override must win over inherited PATH"
        );
    }
}
