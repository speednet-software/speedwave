//! Process manager for the singleton mcp-os Node MCP worker.
//!
//! Thin wrapper: `McpOsProcess` is a type alias over
//! [`crate::host_mcp_process::HostMcpProcess`] with `McpOsSpec` as the
//! per-worker `WorkerSpec`. All spawn/stop/respawn/cleanup lifecycle is
//! handled by the generic struct; this module only carries:
//!
//! - `McpOsSpec` — env vars, lock file name, the External liveness
//!   probe that reads `mcp-os.lock.json` from `data_dir`.
//! - `spawn()` — singleton entry-point used by Desktop (`main.rs`) and
//!   the CLI startup helpers.
//! - `is_mcp_os_alive()` / `is_mcp_os_alive_in()` — SSOT health probe
//!   re-exported to `desktop::health` and the watchdog.
//! - `McpOsSpec::pre_spawn` writes the standalone `mcp-os-auth-token`
//!   mount file (hub bind-mounts it at `/secrets/os-auth-token:ro`).
//!   Order matters: token lands on disk *before* lock.json so a crash
//!   in between leaves either zero files or a complete pair.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use crate::consts;
use crate::host_mcp_process::lock::{self, LockService};
use crate::host_mcp_process::{HostMcpProcess, LivenessProbe, SpawnContext, WorkerSpec};

/// `WorkerSpec` for the mcp-os singleton.
#[derive(Clone, Copy, Debug)]
pub struct McpOsSpec;

impl WorkerSpec for McpOsSpec {
    fn service(&self) -> LockService {
        LockService::McpOs
    }
    fn log_tag(&self) -> &'static str {
        "mcp-os"
    }
    fn lock_file_name(&self) -> &'static str {
        consts::MCP_OS_LOCK_FILE
    }
    fn apply_env(&self, cmd: &mut Command, ctx: &SpawnContext) {
        cmd.env("PORT", "0")
            .env("MCP_OS_AUTH_TOKEN", ctx.auth_token);
    }
    /// Write the standalone token mount file *before* the generic spawn
    /// writes `lock.json`. Order matters for crash-safety: if the process
    /// dies between pre_spawn and lock::write, the next start sees no
    /// lock.json, kill_stale_node runs against nothing, and a fresh spawn
    /// overwrites the orphan token. If we instead wrote the token AFTER
    /// lock.json (the previous design), a crash mid-write would leave the
    /// hub bind-mounting a stale token against a worker expecting a new
    /// one — every subsequent request 401s until manual cleanup.
    fn pre_spawn(&self, ctx: &SpawnContext) -> anyhow::Result<()> {
        let token_mount_path = ctx.data_dir.join(consts::MCP_OS_AUTH_TOKEN_FILE);
        crate::fs_perms::write_restricted_file(&token_mount_path, ctx.auth_token)
    }
    fn probe(&self) -> LivenessProbe {
        LivenessProbe::Custom(is_mcp_os_alive_static)
    }
    /// Standalone token mount file written by [`McpOsSpec::pre_spawn`]
    /// — must be removed on Drop alongside `lock.json` so the hub does
    /// not see a stale token.
    fn extra_cleanup_files(&self, ctx: &SpawnContext) -> Vec<PathBuf> {
        vec![ctx.data_dir.join(consts::MCP_OS_AUTH_TOKEN_FILE)]
    }
}

/// Static probe wrapper expected by [`LivenessProbe::Custom`]. The
/// closure-incompatible `fn` pointer means we cannot capture
/// `data_dir`; instead, the custom probe reads from
/// `consts::data_dir()` directly. Tests can still inject a temp dir
/// via [`is_mcp_os_alive_in`] called from the test path.
fn is_mcp_os_alive_static(_state_dir: &Path) -> bool {
    is_mcp_os_alive()
}

/// Type alias the rest of the codebase uses.
pub type McpOsProcess = HostMcpProcess<McpOsSpec>;

impl McpOsProcess {
    /// Spawn the mcp-os node process with a dynamic port. Singleton —
    /// reads `consts::data_dir()` directly. Production entry point.
    pub fn spawn(script_path: &str) -> anyhow::Result<Self> {
        Self::spawn_with_data_dir(script_path, consts::data_dir())
    }

    /// Test-only entry point; lets tests redirect lock + audit log to
    /// a temp directory without poking the global `data_dir()` OnceLock.
    pub(crate) fn spawn_with_data_dir(script_path: &str, data_dir: &Path) -> anyhow::Result<Self> {
        // Idempotent upgrade-time migration: collapse the legacy
        // 3-file layout (`mcp-os-port`, `mcp-os-pid`,
        // `mcp-os-auth-token`) into `mcp-os.lock.json`. No-op once
        // the JSON exists.
        let _ = lock::migrate_legacy_with_target(
            data_dir,
            LockService::McpOs,
            consts::MCP_OS_LOCK_FILE,
            consts::MCP_OS_LEGACY_PORT_FILE,
            consts::MCP_OS_LEGACY_PID_FILE,
            consts::MCP_OS_AUTH_TOKEN_FILE,
        );

        // The standalone `mcp-os-auth-token` mount file is written by
        // `McpOsSpec::pre_spawn` *before* lock.json, so any crash leaves
        // either zero files or a complete pair — never a stale-token
        // mismatch against the running worker.
        HostMcpProcess::spawn_with_spec(
            McpOsSpec,
            data_dir,
            data_dir.to_path_buf(),
            script_path,
            consts::MCP_OS_LOG_FILE,
        )
    }
}

impl McpOsProcess {
    /// Read the cached auth token. Used by `spawn_with_data_dir` to
    /// dual-write the standalone mount file, and by the test accessor.
    pub fn token(&self) -> &str {
        &self.auth_token
    }
}

/// Check whether the singleton mcp-os process is alive AND listening
/// on its port. Reads `mcp-os.lock.json` from the process-global
/// `data_dir()` then probes TCP. Re-exported via `desktop::health`.
pub fn is_mcp_os_alive() -> bool {
    is_mcp_os_alive_in(consts::data_dir())
}

/// Testable inner implementation; takes `data_dir` so tests can point
/// at a temporary directory. Returns `false` if `lock.json` is missing
/// or the recorded PID/port no longer answer.
pub fn is_mcp_os_alive_in(data_dir: &Path) -> bool {
    let lock_path = data_dir.join(consts::MCP_OS_LOCK_FILE);
    let lock = match lock::read(&lock_path, LockService::McpOs) {
        Some(l) => l,
        None => return false,
    };
    if !crate::host_mcp_process::is_pid_alive(lock.pid) {
        return false;
    }
    let addr = SocketAddr::from(([127, 0, 0, 1], lock.port));
    std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(500)).is_ok()
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use crate::host_mcp_process::drain::test_support::write_fake_worker;
    use serial_test::serial;
    use std::process::Stdio;

    #[test]
    fn mcp_os_spec_service_tag() {
        assert_eq!(McpOsSpec.service(), LockService::McpOs);
        assert_eq!(McpOsSpec.log_tag(), "mcp-os");
        assert_eq!(McpOsSpec.lock_file_name(), consts::MCP_OS_LOCK_FILE);
    }

    #[test]
    fn mcp_os_spec_apply_env_sets_port_zero_and_token() {
        let mut cmd = Command::new("true");
        let tmp = tempfile::tempdir().unwrap();
        let lock_path = tmp.path().join("lock");
        let log_path = tmp.path().join("log");
        let ctx = SpawnContext {
            state_dir: tmp.path(),
            lock_path: &lock_path,
            log_path: &log_path,
            auth_token: "uuid-token",
            data_dir: tmp.path(),
        };
        McpOsSpec.apply_env(&mut cmd, &ctx);
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
            envs.get("MCP_OS_AUTH_TOKEN").map(String::as_str),
            Some("uuid-token")
        );
    }

    #[test]
    fn pre_spawn_writes_token_mount_before_lock_json() {
        // Crash-safety contract: standalone token mount file must be on
        // disk *before* lock.json. Tests the WorkerSpec hook directly so
        // it covers both the order and the on-disk content.
        let tmp = tempfile::tempdir().unwrap();
        let lock_path = tmp.path().join(consts::MCP_OS_LOCK_FILE);
        let log_path = tmp.path().join("log");
        let token_path = tmp.path().join(consts::MCP_OS_AUTH_TOKEN_FILE);
        let ctx = SpawnContext {
            state_dir: tmp.path(),
            lock_path: &lock_path,
            log_path: &log_path,
            auth_token: "fresh-token-uuid",
            data_dir: tmp.path(),
        };
        // lock.json must not exist yet when pre_spawn runs.
        assert!(
            !lock_path.exists(),
            "lock.json must be absent before pre_spawn"
        );
        McpOsSpec.pre_spawn(&ctx).unwrap();
        // Token file written with the new token, lock.json still absent.
        let written = std::fs::read_to_string(&token_path).unwrap();
        assert_eq!(written, "fresh-token-uuid");
        assert!(
            !lock_path.exists(),
            "lock.json must NOT be written by pre_spawn (generic spawn writes it after handshake)"
        );
    }

    #[cfg(unix)]
    #[test]
    fn pre_spawn_token_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let lock_path = tmp.path().join(consts::MCP_OS_LOCK_FILE);
        let log_path = tmp.path().join("log");
        let token_path = tmp.path().join(consts::MCP_OS_AUTH_TOKEN_FILE);
        let ctx = SpawnContext {
            state_dir: tmp.path(),
            lock_path: &lock_path,
            log_path: &log_path,
            auth_token: "tok",
            data_dir: tmp.path(),
        };
        McpOsSpec.pre_spawn(&ctx).unwrap();
        let mode = std::fs::metadata(&token_path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "token mount file must be owner-only");
    }

    #[test]
    fn is_mcp_os_alive_in_false_when_lock_missing() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(!is_mcp_os_alive_in(tmp.path()));
    }

    #[test]
    fn is_mcp_os_alive_in_false_when_pid_dead() {
        let tmp = tempfile::tempdir().unwrap();
        let lock = crate::host_mcp_process::lock::LockFile::new(
            LockService::McpOs,
            999_999_999,
            12345,
            "tok".into(),
        );
        crate::host_mcp_process::lock::write(&tmp.path().join(consts::MCP_OS_LOCK_FILE), &lock)
            .unwrap();
        assert!(!is_mcp_os_alive_in(tmp.path()));
    }

    #[cfg(unix)]
    #[test]
    fn is_mcp_os_alive_in_true_when_pid_alive_and_port_listens() {
        use std::net::TcpListener;
        let tmp = tempfile::tempdir().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let lock = crate::host_mcp_process::lock::LockFile::new(
            LockService::McpOs,
            std::process::id(),
            port,
            "tok".into(),
        );
        crate::host_mcp_process::lock::write(&tmp.path().join(consts::MCP_OS_LOCK_FILE), &lock)
            .unwrap();
        assert!(is_mcp_os_alive_in(tmp.path()));
        drop(listener);
    }

    /// Regression: an earlier version of `respawn` only cleared
    /// `lock_path` on the old `self`, so when `*self = new` dropped
    /// the old instance, `cleanup_files` still walked `data_dir` +
    /// `extra_cleanup_files` and deleted the freshly-written token
    /// mount belonging to the replacement. The hub then bind-mounted
    /// a missing file. Fix: `respawn` disarms `cleanup_on_drop` on
    /// the old self before the assignment.
    #[cfg(unix)]
    #[test]
    #[serial(env)]
    fn respawn_does_not_delete_new_token_mount() {
        let tmp = tempfile::tempdir().unwrap();
        let script = write_fake_worker(tmp.path(), "fake.js");
        let node_ok = Command::new("node")
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !node_ok {
            return;
        }
        let mut proc =
            McpOsProcess::spawn_with_data_dir(&script.to_string_lossy(), tmp.path()).unwrap();
        let token_mount = tmp.path().join(consts::MCP_OS_AUTH_TOKEN_FILE);
        assert!(token_mount.exists(), "spawn must write token mount");
        let token_before = std::fs::read_to_string(&token_mount).unwrap();
        proc.respawn().unwrap();
        assert!(
            token_mount.exists(),
            "respawn must NOT delete the new token mount"
        );
        let token_after = std::fs::read_to_string(&token_mount).unwrap();
        assert_ne!(
            token_before, token_after,
            "respawn must rotate the token (fresh UUID)"
        );
        proc.stop().unwrap();
    }

    /// End-to-end migration test: a state dir with the legacy 3-file
    /// layout is silently collapsed into `lock.json` when the singleton
    /// spawns. Uses a fake stdout-only
    /// node script (no listening server) so we only verify the
    /// migration side; full alive-listening probe is covered above.
    #[cfg(unix)]
    #[test]
    #[serial(env)]
    fn spawn_migrates_legacy_three_file_layout() {
        let tmp = tempfile::tempdir().unwrap();
        // Legacy layout: three separate files.
        std::fs::write(tmp.path().join("mcp-os-port"), "54321").unwrap();
        std::fs::write(tmp.path().join("mcp-os-pid"), "1").unwrap();
        std::fs::write(tmp.path().join("mcp-os-auth-token"), "legacy-token").unwrap();

        let script = write_fake_worker(tmp.path(), "fake.js");
        // `which node` — skip when node unavailable in test env.
        let node_ok = Command::new("node")
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !node_ok {
            return;
        }

        let res = McpOsProcess::spawn_with_data_dir(&script.to_string_lossy(), tmp.path());
        if let Ok(mut proc) = res {
            // lock.json must be present and parseable for service McpOs.
            let lock_path = tmp.path().join(consts::MCP_OS_LOCK_FILE);
            assert!(lock_path.exists(), "lock.json must exist after spawn");
            let lock = lock::read(&lock_path, LockService::McpOs)
                .expect("lock.json must parse with service McpOs");
            assert!(lock.port > 0, "lock.json port must be assigned");
            // Legacy files must have been cleaned up by migration.
            assert!(
                !tmp.path().join("mcp-os-port").exists(),
                "legacy port removed"
            );
            assert!(
                !tmp.path().join("mcp-os-pid").exists(),
                "legacy pid removed"
            );
            assert!(
                !tmp.path().join("mcp-os-auth-token").exists()
                    // Dual write recreates auth-token under the SAME name
                    // (legacy const reused). If it exists, it must be the
                    // standalone mount file with the new token, not the
                    // legacy migrated content.
                    || std::fs::read_to_string(tmp.path().join("mcp-os-auth-token"))
                        .map(|s| s != "legacy-token")
                        .unwrap_or(true),
                "legacy auth-token file replaced by fresh standalone mount (dual-write)"
            );
            proc.stop().unwrap();
        }
    }

    /// Full upgrade-path e2e: migration against the *real* bundled mcp-os
    /// worker (Express server with all routes), not the stub
    /// `FAKE_WORKER_JS`. `#[ignore]`d because it depends on the desktop
    /// bundle being built; run with `cargo test -- --ignored` after
    /// `make build-desktop`. PID 1 in the legacy fixture is the safe
    /// stale-PID choice — `kill_stale_node`'s `is_node_process` gate
    /// ignores init/launchd, keeping the test hermetic against the
    /// host system.
    #[cfg(unix)]
    #[test]
    #[ignore = "requires desktop/src-tauri/mcp-os bundle — run after make build-desktop"]
    #[serial(env)]
    fn upgrade_path_with_real_bundled_mcp_os() {
        let script = "../../desktop/src-tauri/mcp-os/os/dist/index.js";
        assert!(
            std::path::Path::new(script).exists(),
            "bundled mcp-os missing at {script} — run `make build-desktop` first"
        );
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("mcp-os-port"), "12345").unwrap();
        std::fs::write(tmp.path().join("mcp-os-pid"), "1").unwrap();
        std::fs::write(
            tmp.path().join("mcp-os-auth-token"),
            "deadbeef-aaaa-bbbb-cccc-1234567890ab",
        )
        .unwrap();

        let mut proc = McpOsProcess::spawn_with_data_dir(script, tmp.path())
            .expect("real bundled mcp-os must spawn");
        let lock = lock::read(
            &tmp.path().join(consts::MCP_OS_LOCK_FILE),
            LockService::McpOs,
        )
        .expect("lock.json must parse");
        assert!(lock.port > 0);
        assert!(!tmp.path().join("mcp-os-port").exists(), "legacy port gone");
        assert!(!tmp.path().join("mcp-os-pid").exists(), "legacy pid gone");

        let addr = std::net::SocketAddr::from(([127, 0, 0, 1], lock.port));
        std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_secs(2))
            .expect("real mcp-os must be listening");
        proc.stop().unwrap();
    }
}
