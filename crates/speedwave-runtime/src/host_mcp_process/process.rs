//! Generic [`HostMcpProcess<S>`] — the SSOT spawn/stop/respawn/cleanup
//! lifecycle three host MCP worker managers (mcp-os, host_exec, oauth)
//! share. Each manager keeps only its worker-specific data and protocol
//! in a [`WorkerSpec`] impl; the generic struct handles everything else.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread::JoinHandle;
use std::time::Duration;

use super::env_policy::{apply_child_env, CurrentProcessEnv};
use super::lock::{self, LockFile, LockService};
use super::probe::probe_tcp;
use super::{drain_and_read_port, is_node_process, kill_process};

/// Worker-specific contract every per-manager `Spec` implements.
/// `apply_env`, `pre_spawn`, `extra_cleanup_files` and `probe` capture
/// the only places three existing managers actually differ.
pub trait WorkerSpec: Send + 'static {
    /// Service tag persisted in `lock.json` and used by all log labels.
    fn service(&self) -> LockService;

    /// Identifier used for log lines (`{tag}: ...`). Typically the
    /// hyphenated form of the service tag.
    fn log_tag(&self) -> &'static str;

    /// File name of the unified lock file relative to `state_dir`.
    /// Per-project workers use `consts::PER_PROJECT_LOCK_FILE` (the
    /// default); mcp-os singleton lives in `data_dir` directly with
    /// `consts::MCP_OS_LOCK_FILE` to avoid colliding with other
    /// top-level state files.
    fn lock_file_name(&self) -> &'static str {
        crate::consts::PER_PROJECT_LOCK_FILE
    }

    /// Inject worker-specific env vars on top of the SSOT
    /// [`apply_child_env`] base policy. Receives the spawn context so
    /// the impl can wire `<X>_AUTH_TOKEN`, `<X>_CONFIG_PATH`, etc.
    fn apply_env(&self, cmd: &mut Command, ctx: &SpawnContext);

    /// Worker-specific PATH substitution. `None` → inherit parent PATH
    /// (mcp-os, oauth); `Some(path)` → recovered login-shell PATH
    /// (host_exec).
    fn path_override(&self) -> Option<&str> {
        None
    }

    /// Hook invoked after `state_dir` is created and stale-PID cleanup
    /// has run but BEFORE the Node child is spawned. Worker writes
    /// anything it needs in the worker's environment view of the disk
    /// here (host_exec config snapshot, oauth bearer map + per-service
    /// bearer files).
    fn pre_spawn(&self, _ctx: &SpawnContext) -> anyhow::Result<()> {
        Ok(())
    }

    /// Liveness probe variant. mcp_os does pid+TCP via
    /// `is_mcp_os_alive_in`; host_exec is single-attempt TCP; oauth is
    /// 3-attempt TCP with backoff (a flake on the probe cascades into
    /// a container recreate so the retry matters — ADR-060).
    fn probe(&self) -> LivenessProbe;

    /// Extra files removed alongside `lock.json` on
    /// [`HostMcpProcess::cleanup_files`]. Per-service bearer files and
    /// `oauth.json` are NOT in this list (they are mounted into
    /// consumer containers; they must survive a supervisor respawn).
    fn extra_cleanup_files(&self, _ctx: &SpawnContext) -> Vec<PathBuf> {
        Vec::new()
    }
}

/// Liveness probe variants.
#[derive(Clone, Copy, Debug)]
pub enum LivenessProbe {
    /// Single TCP connect to `127.0.0.1:port`. host_exec default.
    TcpSingle,
    /// `attempts` TCP connects with `backoff` between them. oauth
    /// uses {3, 100 ms} to absorb transient stalls.
    TcpRetry {
        /// Number of connect attempts.
        attempts: u32,
        /// Delay between attempts.
        backoff: Duration,
    },
    /// Custom liveness check given the state dir. mcp_os delegates to
    /// `is_mcp_os_alive_in` (reads lock.json itself).
    Custom(fn(&Path) -> bool),
}

impl LivenessProbe {
    fn check(&self, state_dir: &Path, port: u16) -> bool {
        if port == 0 {
            return false;
        }
        let bind = super::probe::host_bind_address_for_probe();
        match self {
            LivenessProbe::TcpSingle => probe_tcp(&bind, port, 1, Duration::ZERO),
            LivenessProbe::TcpRetry { attempts, backoff } => {
                probe_tcp(&bind, port, *attempts, *backoff)
            }
            LivenessProbe::Custom(f) => f(state_dir),
        }
    }
}

/// Context passed to every [`WorkerSpec`] hook. Carries the freshly
/// minted auth-token, the state dir paths and the log file location —
/// everything a hook needs without poking at globals.
pub struct SpawnContext<'a> {
    /// Per-worker state directory.
    pub state_dir: &'a Path,
    /// Path to the worker's lock file.
    pub lock_path: &'a Path,
    /// Path to the worker's log file.
    pub log_path: &'a Path,
    /// Freshly minted auth token for this run.
    pub auth_token: &'a str,
    /// Speedwave data directory.
    pub data_dir: &'a Path,
}

/// Generic host MCP worker process manager. Three real managers
/// (mcp_os, host_exec, oauth) are type aliases over this struct with a
/// concrete `WorkerSpec`.
pub struct HostMcpProcess<S: WorkerSpec> {
    pub(crate) spec: S,
    pub(crate) child: Option<Child>,
    /// Job Object handle — load-bearing `Drop` side effect (kill-on-close).
    /// `_` prefix suppresses dead_code; field MUST live as long as `child`.
    /// `None` on non-Windows and on attach failure. See `job_object` + ADR-048.
    pub(crate) _job: Option<super::job_object::JobHandle>,
    pub(crate) drain_handles: Vec<JoinHandle<()>>,
    pub(crate) data_dir: PathBuf,
    pub(crate) state_dir: PathBuf,
    pub(crate) lock_path: PathBuf,
    pub(crate) log_path: PathBuf,
    pub(crate) auth_token: String,
    pub(crate) port: u16,
    pub(crate) script_path: String,
    /// Cleared by `respawn()` before `*self = new` so the dropped old
    /// instance does not delete the replacement's on-disk artifacts.
    /// Kept private — only `spawn_with_spec`, `respawn`, and `Drop`
    /// inside this module may mutate it.
    cleanup_on_drop: bool,
}

impl<S: WorkerSpec> HostMcpProcess<S> {
    /// Spawn the worker. `state_dir` is whatever the per-manager wrapper
    /// computes (e.g. `<data_dir>` for mcp-os singleton,
    /// `<data_dir>/host-exec/<project>` for host_exec). Blocks up to
    /// 10 s waiting for the `{"port":N}` handshake on stdout.
    ///
    /// Sequence:
    /// 1. `create_dir_all(state_dir)`
    /// 2. Idempotent upgrade-time migration of any pre-PR3 legacy
    ///    3-file layout into `lock.json` (caller is expected to wire
    ///    `lock::migrate_legacy` separately for service-specific
    ///    legacy file names — happens before this call).
    /// 3. Stale-PID cleanup from existing `lock.json` (kills only
    ///    confirmed node processes).
    /// 4. `WorkerSpec::pre_spawn` — config snapshot, bearer map, …
    /// 5. Mint UUID v4 auth-token; spawn `node <script_path>` with the
    ///    SSOT env policy + `WorkerSpec::apply_env`.
    /// 6. Drain stdout/stderr; read port from first JSON line (10 s).
    /// 7. Write `lock.json` with `{service, pid, port, authToken,
    ///    transport}`.
    pub fn spawn_with_spec(
        spec: S,
        data_dir: &Path,
        state_dir: PathBuf,
        script_path: &str,
        log_filename: &str,
    ) -> anyhow::Result<Self> {
        std::fs::create_dir_all(&state_dir)?;
        let lock_path = state_dir.join(spec.lock_file_name());
        let log_path = state_dir.join(log_filename);

        // Stale-PID cleanup: read lock.json (single on-disk format).
        if let Some(existing) = lock::read(&lock_path, spec.service()) {
            kill_stale_node(existing.pid, spec.log_tag());
            let _ = std::fs::remove_file(&lock_path);
        }

        crate::log_file::truncate_if_oversized(&log_path, 2 * 1024 * 1024);

        let auth_token = uuid::Uuid::new_v4().to_string();
        let ctx = SpawnContext {
            state_dir: &state_dir,
            lock_path: &lock_path,
            log_path: &log_path,
            auth_token: &auth_token,
            data_dir,
        };
        spec.pre_spawn(&ctx)?;

        let mut cmd = crate::binary::command("node");
        cmd.arg(script_path);
        apply_child_env(&mut cmd, spec.path_override(), &CurrentProcessEnv);
        // SSOT: macOS 127.0.0.1, Windows WSL adapter IP — must match host_gateway_ip
        // so container reaches the worker via extra_hosts: host.docker.internal:<gateway>.
        cmd.env("MCP_LISTEN_HOST", crate::compose::host_bind_address()?);
        spec.apply_env(&mut cmd, &ctx);
        cmd.stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = cmd.spawn()?;

        // Attach child to Windows Job Object (no-op on non-Windows).
        let job = super::job_object::attach_to_kill_on_close_job(&child);

        let (port, drain_handles) = match drain_and_read_port(&mut child, &log_path, spec.log_tag())
        {
            Ok(p) => p,
            Err(e) => {
                child.kill().ok();
                child.wait().ok();
                return Err(e);
            }
        };

        let lock = LockFile::new(spec.service(), child.id(), port, auth_token.clone());
        if let Err(e) = lock::write(&lock_path, &lock) {
            child.kill().ok();
            child.wait().ok();
            return Err(e);
        }

        Ok(Self {
            spec,
            child: Some(child),
            _job: job,
            drain_handles,
            data_dir: data_dir.to_path_buf(),
            state_dir,
            lock_path,
            log_path,
            auth_token,
            port,
            script_path: script_path.to_string(),
            cleanup_on_drop: true,
        })
    }

    /// Port the worker is listening on.
    pub fn port(&self) -> u16 {
        self.port
    }

    /// Path to the worker's lock file.
    pub fn lock_path(&self) -> &Path {
        &self.lock_path
    }

    /// The worker spec backing this manager.
    pub fn spec(&self) -> &S {
        &self.spec
    }

    /// Kill the worker; join drain threads. Idempotent.
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

    /// Remove `lock.json` + any spec-specific extras. Audit logs and
    /// bearer files are kept (long-lived, mounted into consumers).
    pub fn cleanup_files(&self) {
        let _ = std::fs::remove_file(&self.lock_path);
        let ctx = SpawnContext {
            state_dir: &self.state_dir,
            lock_path: &self.lock_path,
            log_path: &self.log_path,
            auth_token: &self.auth_token,
            data_dir: &self.data_dir,
        };
        for extra in self.spec.extra_cleanup_files(&ctx) {
            let _ = std::fs::remove_file(&extra);
        }
    }

    /// True when the worker is alive AND its probe accepts.
    pub fn is_alive(&self) -> bool {
        if self.child.is_none() {
            return false;
        }
        self.spec.probe().check(&self.state_dir, self.port)
    }
}

impl<S: WorkerSpec + Clone> HostMcpProcess<S> {
    /// Stop the old worker and spawn a fresh one at the same script
    /// path with the same spec. Disarms the old instance's `Drop` so it
    /// cannot delete the replacement's `lock.json` or spec-extras
    /// (token mount files, bearer files) when it goes out of scope.
    pub fn respawn(&mut self) -> anyhow::Result<u16> {
        if let Some(mut child) = self.child.take() {
            child.kill().ok();
            child.wait().ok();
        }
        for handle in self.drain_handles.drain(..) {
            let _ = handle.join();
        }
        self.cleanup_on_drop = false;

        let state_dir = self.state_dir.clone();
        let log_filename = self
            .log_path
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "audit.log".to_string());
        let spec = self.spec.clone();
        let data_dir = self.data_dir.clone();
        let script_path = self.script_path.clone();

        let new = Self::spawn_with_spec(spec, &data_dir, state_dir, &script_path, &log_filename)?;
        let new_port = new.port;
        *self = new;
        Ok(new_port)
    }
}

impl<S: WorkerSpec> Drop for HostMcpProcess<S> {
    fn drop(&mut self) {
        self.stop().ok();
        if self.cleanup_on_drop {
            self.cleanup_files();
        }
    }
}

/// The greppable phrase the live-worker-kill WARN line carries. SSOT shared
/// with `resources::OOM_MESSAGE`, whose exit-137 guidance tells users to grep
/// for it — the two must never drift (a test in `resources.rs` pins it).
pub(crate) const KILL_STALE_LOG_MARKER: &str = "killing a LIVE worker";

/// Kill a stale node process recorded by a previous spawn. SSOT —
/// replaces three identical `kill_stale_node` shims that used to live
/// in each worker module.
pub fn kill_stale_node(pid: u32, service_tag: &str) {
    if !is_node_process(pid) {
        log::debug!("{service_tag}: stale PID {pid} is not a node process — skipping kill");
        return;
    }
    // `is_node_process` already confirmed PID is alive (ps -p succeeded),
    // so no second liveness probe is needed. A LIVE node here is a smell:
    // the sole owner's watchdog respawns only when its worker is dead, so a
    // live worker at spawn time means a second supervisor is racing us (the
    // dual-supervisor exit-137 bug — see ADR-060 / project_oauth_dual_supervisor_137).
    // WARN, not INFO, so the next occurrence is a single greppable line.
    log::warn!(
        "{service_tag}: {KILL_STALE_LOG_MARKER} (PID {pid}) at spawn — possible second supervisor racing this one"
    );
    kill_process(pid);
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
pub(crate) mod test_support {
    //! Fake `WorkerSpec` + helpers for testing the generic struct
    //! without spawning real Node workers.

    use super::*;
    use std::sync::{Arc, Mutex};

    pub struct FakeSpec {
        pub service: LockService,
        pub tag: &'static str,
        pub calls: Arc<Mutex<Vec<&'static str>>>,
    }

    impl FakeSpec {
        pub fn new(service: LockService, tag: &'static str) -> Self {
            Self {
                service,
                tag,
                calls: Arc::new(Mutex::new(Vec::new())),
            }
        }

        pub fn calls(&self) -> Vec<&'static str> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl WorkerSpec for FakeSpec {
        fn service(&self) -> LockService {
            self.service
        }
        fn log_tag(&self) -> &'static str {
            self.tag
        }
        fn apply_env(&self, cmd: &mut Command, ctx: &SpawnContext) {
            self.calls.lock().unwrap().push("apply_env");
            cmd.env("FAKE_TOKEN", ctx.auth_token);
            cmd.env("FAKE_STATE_DIR", ctx.state_dir);
        }
        fn pre_spawn(&self, _ctx: &SpawnContext) -> anyhow::Result<()> {
            self.calls.lock().unwrap().push("pre_spawn");
            Ok(())
        }
        fn probe(&self) -> LivenessProbe {
            LivenessProbe::TcpSingle
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::test_support::FakeSpec;
    use super::*;
    use crate::host_mcp_process::env_policy::test_support::FakeEnv;

    #[test]
    fn liveness_probe_returns_false_for_port_zero() {
        let probe = LivenessProbe::TcpSingle;
        let tmp = tempfile::tempdir().unwrap();
        assert!(!probe.check(tmp.path(), 0));
    }

    #[test]
    fn liveness_probe_custom_delegates_to_fn() {
        fn always_true(_: &Path) -> bool {
            true
        }
        fn always_false(_: &Path) -> bool {
            false
        }
        let tmp = tempfile::tempdir().unwrap();
        assert!(LivenessProbe::Custom(always_true).check(tmp.path(), 12345));
        assert!(!LivenessProbe::Custom(always_false).check(tmp.path(), 12345));
    }

    #[test]
    fn worker_spec_default_path_override_is_none() {
        let spec = FakeSpec::new(LockService::HostExec, "fake");
        assert!(spec.path_override().is_none());
    }

    #[test]
    fn worker_spec_default_extra_cleanup_files_is_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let lock_path = tmp.path().join("lock.json");
        let log_path = tmp.path().join("log");
        let ctx = SpawnContext {
            state_dir: tmp.path(),
            lock_path: &lock_path,
            log_path: &log_path,
            auth_token: "tok",
            data_dir: tmp.path(),
        };
        let spec = FakeSpec::new(LockService::HostExec, "fake");
        assert!(spec.extra_cleanup_files(&ctx).is_empty());
    }

    #[test]
    fn worker_spec_default_pre_spawn_is_ok() {
        let tmp = tempfile::tempdir().unwrap();
        let lock_path = tmp.path().join("lock.json");
        let log_path = tmp.path().join("log");
        let ctx = SpawnContext {
            state_dir: tmp.path(),
            lock_path: &lock_path,
            log_path: &log_path,
            auth_token: "tok",
            data_dir: tmp.path(),
        };
        let spec = FakeSpec::new(LockService::HostExec, "fake");
        assert!(spec.pre_spawn(&ctx).is_ok());
    }

    #[test]
    fn fake_spec_records_hook_order() {
        // Spawn-sequence contract: pre_spawn → apply_env → spawn → write_atomic.
        // Without a real node binary we can't test the full sequence
        // end-to-end, but we can prove the order pre_spawn → apply_env
        // by invoking them directly the way `spawn_in` would.
        let spec = FakeSpec::new(LockService::HostExec, "fake");
        let tmp = tempfile::tempdir().unwrap();
        let lock_path = tmp.path().join("lock.json");
        let log_path = tmp.path().join("log");
        let ctx = SpawnContext {
            state_dir: tmp.path(),
            lock_path: &lock_path,
            log_path: &log_path,
            auth_token: "tok",
            data_dir: tmp.path(),
        };
        spec.pre_spawn(&ctx).unwrap();
        let mut cmd = Command::new("true");
        spec.apply_env(&mut cmd, &ctx);
        let calls = spec.calls();
        assert_eq!(calls, vec!["pre_spawn", "apply_env"]);
    }

    #[test]
    fn kill_stale_node_skips_pid_1() {
        // PID 1 is init/launchd; is_node_process returns false → no kill.
        kill_stale_node(1, "test");
    }

    #[test]
    fn kill_stale_node_warn_uses_shared_marker() {
        // The WARN line MUST carry KILL_STALE_LOG_MARKER — that const is the
        // grep hint embedded in resources::OOM_MESSAGE. Source-string guard so a
        // refactor can't drop the marker from the format string while keeping
        // the const, which would silently break the exit-137 diagnostic.
        let source = include_str!("process.rs");
        assert!(
            source.contains("{service_tag}: {KILL_STALE_LOG_MARKER} (PID {pid})"),
            "kill_stale_node WARN line must interpolate KILL_STALE_LOG_MARKER"
        );
    }

    /// FakeEnv proves that apply_child_env composes with WorkerSpec::apply_env
    /// — base policy runs first (env_clear + PATH/HOME), then the spec
    /// adds worker-specific vars on top.
    #[test]
    fn spec_apply_env_runs_on_top_of_base_policy() {
        let env = FakeEnv::empty().with("PATH", "/usr/bin").with("HOME", "/h");
        let mut cmd = Command::new("true");
        apply_child_env(&mut cmd, None, &env);
        let tmp = tempfile::tempdir().unwrap();
        let lock_path = tmp.path().join("lock.json");
        let log_path = tmp.path().join("log");
        let ctx = SpawnContext {
            state_dir: tmp.path(),
            lock_path: &lock_path,
            log_path: &log_path,
            auth_token: "abc",
            data_dir: tmp.path(),
        };
        let spec = FakeSpec::new(LockService::HostExec, "fake");
        spec.apply_env(&mut cmd, &ctx);

        let envs: std::collections::HashMap<_, _> = cmd
            .get_envs()
            .filter_map(|(k, v)| v.map(|val| (k.to_owned(), val.to_owned())))
            .collect();
        // Base policy:
        assert_eq!(
            envs.get(std::ffi::OsStr::new("PATH"))
                .map(|v| v.to_string_lossy().to_string())
                .as_deref(),
            Some("/usr/bin"),
            "base apply_child_env must set PATH from EnvSource"
        );
        // Spec layer on top:
        assert_eq!(
            envs.get(std::ffi::OsStr::new("FAKE_TOKEN"))
                .map(|v| v.to_string_lossy().to_string())
                .as_deref(),
            Some("abc"),
            "WorkerSpec::apply_env must inject worker-specific vars"
        );
    }

    /// Pin spawn → attach → drain ordering — see ADR-048 §"PRE-INSTALL
    /// orphan worker sweep". Reordering breaks error-path cleanup.
    #[test]
    fn attach_runs_before_drain_so_failure_cleanup_drops_job() {
        const SRC: &str = include_str!("process.rs");
        let attach_pos = SRC
            .find("attach_to_kill_on_close_job(&child)")
            .expect("attach call must exist in spawn_with_spec");
        let drain_pos = SRC
            .find("drain_and_read_port(&mut child")
            .expect("drain call must exist in spawn_with_spec");
        let assign_pos = SRC.find("_job: job,").expect("_job assignment must exist");
        assert!(
            attach_pos < drain_pos,
            "attach_to_kill_on_close_job must run BEFORE drain_and_read_port \
             so the local `job` binding drops on drain failure"
        );
        assert!(
            drain_pos < assign_pos,
            "_job: job assignment must come AFTER drain success — otherwise \
             the error path moves `job` into a non-existent Self and leaks"
        );
    }
}
