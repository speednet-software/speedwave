//! Per-project process manager for the `oauth` MCP worker (ADR-060).
//!
//! Thin wrapper: `OauthProcess` is a type alias over
//! [`crate::host_mcp_process::HostMcpProcess`] with `OauthSpec` as the
//! worker spec. All lifecycle (spawn/stop/respawn/cleanup) lives in
//! the generic struct; this module only carries worker-specific bits:
//!
//! - Per-consumer bearer provisioning (`.bearer-map.json` +
//!   `bearer-<service>` files) — mounted into consumer containers by
//!   compose, must survive a supervisor respawn.
//! - State-dir owner-only perms (0o700, ADR-060).
//! - The supervisor token + state-dir env vars Node oauth worker reads.
//! - Custom `is_oauth_alive` with retry + backoff — a transient probe
//!   failure cascades into recreate of every consumer container, so
//!   the retry matters (ADR-060).

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::consts;
use crate::fs_perms::write_restricted_file;
use crate::host_mcp_process::lock::LockService;
use crate::host_mcp_process::{HostMcpProcess, LivenessProbe, SpawnContext, WorkerSpec};

use crate::plugin::is_valid_slug;

/// Per-project `oauth` worker state directory: `<data_dir>/oauth/<project>/`.
pub fn oauth_project_dir(data_dir: &Path, project: &str) -> PathBuf {
    data_dir.join(consts::OAUTH_SUBDIR).join(project)
}

/// Worker spec for the `oauth` worker.
#[derive(Clone, Debug)]
pub struct OauthSpec {
    project: String,
    consumers: Vec<String>,
    log_path: PathBuf,
    tokens_base: PathBuf,
}

impl OauthSpec {
    /// Project this OAuth supervisor serves.
    pub fn project(&self) -> &str {
        &self.project
    }
    /// Services consuming the OAuth tokens.
    pub fn consumers(&self) -> &[String] {
        &self.consumers
    }
}

impl WorkerSpec for OauthSpec {
    fn service(&self) -> LockService {
        LockService::Oauth
    }
    fn log_tag(&self) -> &'static str {
        "oauth"
    }
    fn apply_env(&self, cmd: &mut Command, ctx: &SpawnContext) {
        cmd.env("PORT", "0")
            .env("OAUTH_STATE_DIR", ctx.state_dir)
            .env("OAUTH_LOG_FILE", &self.log_path)
            .env("OAUTH_PROJECT", &self.project)
            .env("OAUTH_SUPERVISOR_TOKEN", ctx.auth_token)
            .env("OAUTH_TOKENS_BASE", &self.tokens_base);
    }
    fn pre_spawn(&self, ctx: &SpawnContext) -> anyhow::Result<()> {
        // Per-consumer bearer provisioning. Each consumer gets a fresh
        // UUID bound to its service id; the worker derives `caller`
        // from the bearer via `.bearer-map.json` (ADR-060). The bearer
        // files are mounted into consumer containers (read-only), so
        // they live as separate on-disk artifacts beside lock.json.
        let bearer_map_path = ctx.state_dir.join(consts::OAUTH_BEARER_MAP_FILE);
        let mut bearer_map: std::collections::BTreeMap<String, String> =
            std::collections::BTreeMap::new();
        for service in &self.consumers {
            if !is_valid_slug(service) {
                anyhow::bail!(
                    "oauth: refused to provision bearer for invalid service slug '{service}'"
                );
            }
            let bearer = uuid::Uuid::new_v4().to_string();
            bearer_map.insert(bearer.clone(), service.clone());
            let bearer_file = ctx.state_dir.join(format!("bearer-{service}"));
            write_restricted_file(&bearer_file, &bearer)?;
        }
        let bearer_map_json = serde_json::to_string_pretty(&bearer_map)?;
        write_restricted_file(&bearer_map_path, &bearer_map_json)?;
        Ok(())
    }
    fn probe(&self) -> LivenessProbe {
        LivenessProbe::TcpRetry {
            attempts: u32::from(consts::PORT_PROBE_ATTEMPTS),
            backoff: consts::PORT_PROBE_BACKOFF,
        }
    }
}

/// Type alias the rest of the codebase uses.
pub type OauthProcess = HostMcpProcess<OauthSpec>;

impl OauthProcess {
    /// Spawn an `oauth` worker; blocks ~10s for the `{"port":N}` handshake.
    pub fn spawn_in(
        project: &str,
        script_path: &str,
        data_dir: &Path,
        consumers: &[&str],
    ) -> anyhow::Result<Self> {
        // The state dir must exist with 0o700 *before* the generic
        // spawn writes lock.json / bearer files into it, so the perms
        // are inherited. Subsequent `create_dir_all` inside the generic
        // is a cheap no-op.
        let state_dir = oauth_project_dir(data_dir, project);
        std::fs::create_dir_all(&state_dir)?;
        set_dir_owner_only(&state_dir)?;

        let log_path = state_dir.join(consts::OAUTH_LOG_FILE);
        let tokens_base = data_dir.join("tokens");

        let spec = OauthSpec {
            project: project.to_string(),
            consumers: consumers.iter().map(|s| s.to_string()).collect(),
            log_path,
            tokens_base,
        };

        HostMcpProcess::spawn_with_spec(
            spec,
            data_dir,
            state_dir,
            script_path,
            consts::OAUTH_LOG_FILE,
        )
    }

    /// Project this OAuth process serves.
    pub fn project(&self) -> &str {
        self.spec().project()
    }
}

/// TCP liveness probe against `127.0.0.1:<port>`. Retries on failure
/// with backoff — oauth respawn forces a recreate of every consumer
/// container, so a transient probe failure (worker mid-refresh,
/// accept loop briefly stalled) must NOT cascade into a respawn loop.
pub fn is_oauth_alive(port: u16) -> bool {
    if port == 0 {
        return false;
    }
    let bind = crate::host_mcp_process::probe::host_bind_address_for_probe();
    crate::host_mcp_process::probe::probe_tcp(
        &bind,
        port,
        consts::PORT_PROBE_ATTEMPTS.into(),
        consts::PORT_PROBE_BACKOFF,
    )
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

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use serial_test::serial;

    #[test]
    fn oauth_spec_apply_env_sets_worker_vars() {
        let spec = OauthSpec {
            project: "proj".into(),
            consumers: vec!["sharepoint".into()],
            log_path: PathBuf::from("/tmp/p/audit.log"),
            tokens_base: PathBuf::from("/tmp/tokens"),
        };
        let mut cmd = Command::new("true");
        let lock_path = PathBuf::from("/tmp/p/lock.json");
        let log_path = PathBuf::from("/tmp/p/audit.log");
        let ctx = SpawnContext {
            state_dir: Path::new("/tmp/p"),
            lock_path: &lock_path,
            log_path: &log_path,
            auth_token: "supervisor-token",
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
            envs.get("OAUTH_STATE_DIR").map(String::as_str),
            Some("/tmp/p")
        );
        assert_eq!(envs.get("OAUTH_PROJECT").map(String::as_str), Some("proj"));
        assert_eq!(
            envs.get("OAUTH_SUPERVISOR_TOKEN").map(String::as_str),
            Some("supervisor-token")
        );
        assert_eq!(
            envs.get("OAUTH_TOKENS_BASE").map(String::as_str),
            Some("/tmp/tokens")
        );
    }

    #[test]
    fn oauth_spec_probe_uses_retry_with_backoff() {
        let spec = OauthSpec {
            project: "p".into(),
            consumers: vec![],
            log_path: PathBuf::from(""),
            tokens_base: PathBuf::from(""),
        };
        match spec.probe() {
            LivenessProbe::TcpRetry { attempts, backoff } => {
                assert_eq!(attempts, u32::from(consts::PORT_PROBE_ATTEMPTS));
                assert_eq!(backoff, consts::PORT_PROBE_BACKOFF);
            }
            _ => panic!("oauth probe must be TcpRetry"),
        }
    }

    #[test]
    fn is_oauth_alive_returns_false_for_port_zero() {
        assert!(!is_oauth_alive(0));
    }

    #[test]
    fn is_oauth_alive_returns_true_when_listener_accepts() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(is_oauth_alive(port));
        drop(listener);
    }

    #[test]
    fn oauth_project_dir_returns_subdir_join() {
        let base = PathBuf::from("/data");
        assert_eq!(
            oauth_project_dir(&base, "proj"),
            PathBuf::from("/data/oauth/proj")
        );
    }

    #[test]
    fn pre_spawn_writes_consistent_bearer_files_and_map() {
        // Invariant: after successful pre_spawn, every bearer-<svc> file
        // on disk maps to its service via .bearer-map.json. The worker
        // reads the map at startup and resolves incoming bearers through
        // it; a mismatch = 401. This test pins the on-disk consistency
        // contract so a future refactor can't silently desynchronize them.
        let tmp = tempfile::tempdir().unwrap();
        let state_dir = tmp.path().join("state");
        std::fs::create_dir_all(&state_dir).unwrap();
        let lock_path = state_dir.join(consts::PER_PROJECT_LOCK_FILE);
        let log_path = state_dir.join("log");

        let spec = OauthSpec {
            project: "proj".into(),
            consumers: vec!["sharepoint".into(), "redmine".into()],
            log_path: log_path.clone(),
            tokens_base: tmp.path().to_path_buf(),
        };
        let ctx = SpawnContext {
            state_dir: &state_dir,
            lock_path: &lock_path,
            log_path: &log_path,
            auth_token: "supervisor-tok",
            data_dir: tmp.path(),
        };
        spec.pre_spawn(&ctx).unwrap();

        let map_json = std::fs::read_to_string(state_dir.join(consts::OAUTH_BEARER_MAP_FILE))
            .expect("bearer-map.json must exist");
        let map: std::collections::BTreeMap<String, String> =
            serde_json::from_str(&map_json).expect("bearer-map.json must parse");
        for service in &["sharepoint", "redmine"] {
            let bearer_file = state_dir.join(format!("bearer-{service}"));
            let bearer = std::fs::read_to_string(&bearer_file)
                .unwrap_or_else(|_| panic!("bearer-{service} must exist"));
            assert_eq!(
                map.get(&bearer).map(String::as_str),
                Some(*service),
                "bearer-{service} content must round-trip through .bearer-map.json"
            );
        }
    }

    #[test]
    fn pre_spawn_rejects_invalid_service_slug_without_writing_anything() {
        // Defense-in-depth: a malformed slug must bail before any bearer
        // file lands on disk, so a malicious settings inject can't trick
        // us into writing `bearer-../evil` somewhere.
        let tmp = tempfile::tempdir().unwrap();
        let state_dir = tmp.path().join("state");
        std::fs::create_dir_all(&state_dir).unwrap();
        let lock_path = state_dir.join(consts::PER_PROJECT_LOCK_FILE);
        let log_path = state_dir.join("log");

        let spec = OauthSpec {
            project: "proj".into(),
            consumers: vec!["sharepoint".into(), "../etc/passwd".into()],
            log_path: log_path.clone(),
            tokens_base: tmp.path().to_path_buf(),
        };
        let ctx = SpawnContext {
            state_dir: &state_dir,
            lock_path: &lock_path,
            log_path: &log_path,
            auth_token: "tok",
            data_dir: tmp.path(),
        };
        let err = spec
            .pre_spawn(&ctx)
            .expect_err("invalid slug must bail pre_spawn");
        assert!(
            err.to_string().contains("invalid service slug"),
            "error must call out the slug: {err}"
        );
        // The first iteration wrote `bearer-sharepoint` before the invalid
        // slug aborted the loop. Document this partial-write window — fixing
        // it requires building artifacts in a tempdir and rename-once, which
        // is tracked separately. Restart of the supervisor overwrites.
        // (No assertion about .bearer-map.json: it is written *after* the
        // loop, so on bail it must NOT exist.)
        assert!(
            !state_dir.join(consts::OAUTH_BEARER_MAP_FILE).exists(),
            ".bearer-map.json must not be written when pre_spawn bails"
        );
    }

    #[cfg(unix)]
    #[test]
    #[serial(env)]
    fn set_dir_owner_only_sets_0o700_on_unix() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("subdir");
        std::fs::create_dir_all(&dir).unwrap();
        set_dir_owner_only(&dir).unwrap();
        let mode = std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700);
    }
}
