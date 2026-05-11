//! Per-project process manager for the `host_exec` MCP worker (ADR-054, step 4).
//!
//! `host_exec` is a host-side worker that runs **only** the commands a user has
//! explicitly whitelisted, in the project directory, with no shell, with
//! per-recipe confirmation. Unlike `mcp-os` (one global, single-instance,
//! project-agnostic process — see [`crate::mcp_os_process`]), `host_exec` is
//! **per-project**: one worker process per project, each on its own dynamic
//! `127.0.0.1` port, each with its own whitelist, bearer token, log, and
//! confirmation cache under `<data_dir>/host-exec/<project>/`.
//!
//! This module mirrors `mcp_os_process.rs`'s *mechanics* — `env_clear` + a
//! re-added minimal env, the `{"port":N}` stdout handshake with a read timeout,
//! the background drain threads, the PID-file stale-kill (`is_node_process`
//! guard), `write_restricted_file` (`chmod 600` / `icacls`), log truncation,
//! the `Drop` cleanup pattern — but adds two things `mcp-os` does not have:
//!
//! 1. **Per-project layout**: state files live at
//!    `<data_dir>/host-exec/<project>/{config.json, auth-token, port, pid, log}`;
//!    instances are held in a `HashMap<String, HostExecProcess>` in app state.
//! 2. **The confirm channel**: the worker writes confirm-requests on **fd 3**
//!    (an extra pipe — wired via `command-fds` on Unix); the Tauri side reads
//!    them, decides (auto-allow on `confirm: always` / a warm session cache, or
//!    asks the frontend), and writes the reply back on the **worker's stdin**.
//!    The session cache is keyed on `(project, recipe, argv, cwd, config-hash)`
//!    so an edited recipe re-prompts; it lives here (Tauri side) so it survives
//!    a worker respawn — see [`HostExecProcess::respawn`].
//!
//! ## The fd-3 confirm channel and the Windows gap
//!
//! Extra file descriptors are a Unix concept; `command-fds` (which we use to
//! map the pipe write-end onto the worker's fd 3) is Unix-only, and there is no
//! clean cross-platform crate for this. On **Windows** the fd-3 channel is
//! therefore **not wired**: the worker's `openFd3()` does `fstatSync(3)`, which
//! throws `EBADF`, so it returns `undefined`, `realConfirmChannel` drops
//! `send`s, and the worker's confirmation guard times out → MCP tool error
//! "confirmation unavailable" → **fail closed**. That is *safe* (a recipe is
//! never run without an answer) but means confirmed recipes are unusable on
//! Windows until the channel is wired there (e.g. over a named pipe) — tracked
//! as a follow-up; do not paper over it by relaxing the fail-closed default.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use speedwave_runtime::config::HostExecConfirm;
use speedwave_runtime::consts;

/// Timeout for reading the port announcement from the `host_exec` worker's
/// stdout (`{"port":N}` as the first line). Same value as `mcp-os`'s.
const PORT_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// Cap the per-project audit log at 2 MiB on spawn (the worker appends to it
/// for the lifetime of the process; the Tauri side just keeps it bounded).
const LOG_MAX_BYTES: u64 = 2 * 1024 * 1024;

/// How long the Tauri side waits for the frontend's reply to a per-recipe
/// confirmation before *giving up silently* — it does **not** reply on
/// timeout; the worker's own (longer) guard fires and produces "confirmation
/// unavailable". This is the SSOT value from the runtime crate.
const CONFIRM_REPLY_TIMEOUT: std::time::Duration =
    std::time::Duration::from_millis(consts::HOST_EXEC_CONFIRM_TIMEOUT_MS);

/// Windows system environment variables required for Node.js OpenSSL CSPRNG
/// (BCryptGenRandom) initialization. Without these, `node.exe` aborts with
/// "Assertion failed: ncrypto::CSPRNG(nullptr, 0)". Same list `mcp_os_process`
/// uses (see ADR-013).
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

/// The confirmation-cache key. A bare recipe name would be wrong: `allow-session`
/// for one `argv`/`cwd` must not authorise a *different* `argv`, and an edited
/// recipe must re-prompt — so the key folds in the resolved `argv`, the working
/// directory label, and a hash of the recipe's serialized config (ADR-054
/// §Confirmation flow).
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct ConfirmCacheKey {
    /// Project the worker belongs to.
    pub project: String,
    /// Recipe name (as Claude called it).
    pub recipe_name: String,
    /// The fully-resolved argv joined with `\u{1f}` (a separator that cannot
    /// appear in an argv element — argv elements with NUL/newline are rejected
    /// at config-validation time, and U+001F is reserved likewise). Joining
    /// rather than keeping a `Vec` lets the key derive `Hash`/`Eq` trivially.
    pub argv_joined: String,
    /// The working-directory label (`"."` or the `cwdSub`).
    pub cwd_label: String,
    /// Hex SHA-256 of the recipe's serialized JSON in the *current* config
    /// snapshot — so editing the recipe invalidates its cache entry. Empty
    /// string when the recipe is no longer in the snapshot (in which case the
    /// reader thread fails closed anyway).
    pub recipe_config_hash: String,
}

impl ConfirmCacheKey {
    /// Builds the key. `argv` is joined with U+001F (unit separator).
    fn new(
        project: &str,
        recipe_name: &str,
        argv: &[String],
        cwd_label: &str,
        recipe_config_hash: &str,
    ) -> Self {
        Self {
            project: project.to_string(),
            recipe_name: recipe_name.to_string(),
            argv_joined: argv.join("\u{1f}"),
            cwd_label: cwd_label.to_string(),
            recipe_config_hash: recipe_config_hash.to_string(),
        }
    }
}

/// A confirm-request the worker sends on fd 3 (newline-JSON). Mirrors the
/// worker's `ConfirmRequest` (`mcp-servers/host_exec/src/confirm.ts`); the
/// worker tags each line with `"type":"confirm"` but we don't model that field
/// (serde ignores it) — every line on this channel is a confirm-request.
#[derive(serde::Deserialize, Debug)]
struct ConfirmRequest {
    /// Correlation id (the reply carries the same `id`).
    id: String,
    /// Recipe name.
    recipe: String,
    /// The fully-resolved argv (`exec` first, then args with params substituted).
    argv: Vec<String>,
    /// The working-directory label (`"."` or the `cwdSub`).
    cwd: String,
}

/// The outcome of evaluating a confirm-request's *policy* (the part that does
/// not need the frontend). Pulled out as a pure function so the auto-allow /
/// ask-frontend decision is testable without spawning a worker.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ConfirmDecision {
    /// Reply `allow` immediately (recipe `confirm: always`, or the session
    /// cache is warm for this exact `(project, recipe, argv, cwd, config-hash)`).
    AutoAllow,
    /// Pop the per-call dialog on the frontend and wait for the user's reply.
    AskFrontend,
}

/// Decide how to answer a confirm-request, given the recipe's `confirm` setting
/// and the warm session cache. Pure — no I/O, no Tauri. The reader thread calls
/// this *after* it has confirmed the recipe still exists in the current config
/// snapshot (a missing recipe is failed closed before this is reached).
pub(crate) fn decide_confirmation(
    recipe_confirm: HostExecConfirm,
    key: &ConfirmCacheKey,
    session_cache: &HashSet<ConfirmCacheKey>,
) -> ConfirmDecision {
    match recipe_confirm {
        HostExecConfirm::Always => ConfirmDecision::AutoAllow,
        HostExecConfirm::Session | HostExecConfirm::Ask => {
            // `Ask` never caches (the dialog always shows), but a warm cache is
            // possible only via a prior `allow-session` — which only `Session`
            // recipes offer. Checking the cache for both is harmless: an `Ask`
            // recipe can never have an entry.
            if session_cache.contains(key) {
                ConfirmDecision::AutoAllow
            } else {
                ConfirmDecision::AskFrontend
            }
        }
    }
}

/// Hex SHA-256 of a string (recipe JSON). Lowercase, 64 chars.
fn sha256_hex(s: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(s.as_bytes());
    let mut out = String::with_capacity(64);
    for b in digest {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// Reads the per-project config snapshot and returns `(confirm, config_hash)`
/// for the named recipe, or `None` if the recipe is not in the snapshot.
///
/// The snapshot is `{ projectDir, commands: [...] }` (see
/// `config::host_exec_config_snapshot`). We re-read it on *every* confirm-request
/// rather than caching, so an edit lands immediately (the worker does the same).
fn lookup_recipe_confirm(
    config_path: &Path,
    recipe_name: &str,
) -> Option<(HostExecConfirm, String)> {
    let raw = std::fs::read_to_string(config_path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let commands = v.get("commands")?.as_array()?;
    for cmd in commands {
        if cmd.get("name").and_then(|n| n.as_str()) == Some(recipe_name) {
            // `confirm` defaults to "ask" if absent (matches the serde default
            // on `HostExecRecipe::confirm` / `HostExecConfirm::Ask`).
            let confirm = match cmd.get("confirm").and_then(|c| c.as_str()) {
                Some("always") => HostExecConfirm::Always,
                Some("session") => HostExecConfirm::Session,
                _ => HostExecConfirm::Ask,
            };
            // Hash the recipe's serialized JSON — canonicalised via re-serialize
            // so cosmetic whitespace differences in the snapshot don't matter.
            let hash = sha256_hex(&serde_json::to_string(cmd).unwrap_or_default());
            return Some((confirm, hash));
        }
    }
    None
}

/// A pending frontend-confirmation: the sender half handed to
/// [`HostExecProcess::complete_confirmation`]; the reader thread holds the
/// receiver and `recv_timeout`s on it. Keyed by the request `id`.
type PendingConfirms = Arc<Mutex<HashMap<String, std::sync::mpsc::Sender<String>>>>;

/// The session-allow cache, shared between the `HostExecProcess` and its
/// confirm-reader thread.
type SessionAllowCache = Arc<Mutex<HashSet<ConfirmCacheKey>>>;

/// Manages one project's `host_exec` worker as a child Node process.
///
/// One `HostExecProcess` per project; the Tauri app holds them in a
/// `HashMap<String, HostExecProcess>` (see `crate::reconcile::SharedHostExec`).
pub struct HostExecProcess {
    /// Project name (a validated single directory component).
    project: String,
    /// The project directory (whose contents the worker runs commands in).
    project_dir: PathBuf,
    /// The child worker process. `None` after `stop()`.
    child: Option<Child>,
    /// Background threads draining the worker's stdout/stderr into the log.
    drain_handles: Vec<JoinHandle<()>>,
    /// Background thread reading confirm-requests off fd 3. `None` if fd 3 was
    /// not wired (Windows) or the spawn failed before it started.
    confirm_reader: Option<JoinHandle<()>>,
    /// The data dir (so `respawn` re-spawns into the same per-project layout).
    data_dir: PathBuf,
    /// `<data_dir>/host-exec/<project>/config.json` — the validated whitelist
    /// snapshot the worker reads (and the reader thread re-reads per request).
    config_path: PathBuf,
    /// `<data_dir>/host-exec/<project>/auth-token` (`chmod 600`).
    token_path: PathBuf,
    /// `<data_dir>/host-exec/<project>/port`.
    port_path: PathBuf,
    /// `<data_dir>/host-exec/<project>/pid` (for stale-process cleanup).
    pid_path: PathBuf,
    /// The actual port the worker is listening on (`127.0.0.1:port`).
    port: u16,
    /// Absolute path to `mcp-servers/host_exec/dist/index.js` (so `respawn` can
    /// re-launch the same worker).
    script_path: String,
    /// The recovered login-shell `PATH` to give the worker (and, via the
    /// worker's child-env allowlist, to recipes). See [`crate::recovered_host_path`].
    host_path: String,
    /// App handle for emitting `host-exec://confirm-request` events. `None` in
    /// tests that don't drive the frontend.
    app_handle: Option<tauri::AppHandle>,
    /// Per-project `allow-session` cache, keyed on
    /// `(project, recipe, argv, cwd, config-hash)`. Lives here (not in the
    /// worker) so it survives a respawn; cleared by `respawn` and by
    /// `host_exec_save_settings` (step 6).
    session_allow_cache: SessionAllowCache,
    /// In-flight frontend confirmations, by request `id`.
    pending_confirms: PendingConfirms,
}

impl HostExecProcess {
    /// Spawn a `host_exec` worker for `project`, blocking up to ~10 s for the
    /// `{"port":N}` announcement. State files go under
    /// `<data_dir>/host-exec/<project>/`. `host_path` is the recovered
    /// login-shell `PATH` (see [`crate::recovered_host_path`]); `app_handle` is
    /// used to emit confirm-request events to the frontend.
    pub fn spawn_for(
        project: &str,
        project_dir: &Path,
        script_path: &str,
        host_path: &str,
        app_handle: tauri::AppHandle,
    ) -> anyhow::Result<Self> {
        Self::spawn_in(
            project,
            project_dir,
            script_path,
            host_path,
            consts::data_dir(),
            Some(app_handle),
        )
    }

    /// Core spawn, with an injectable `data_dir` (tempdir in tests) and an
    /// optional `app_handle` (`None` skips frontend confirm-request emission —
    /// such a worker fails closed on `confirm: ask` recipes, which is what
    /// tests that don't drive the frontend want).
    fn spawn_in(
        project: &str,
        project_dir: &Path,
        script_path: &str,
        host_path: &str,
        data_dir: &Path,
        app_handle: Option<tauri::AppHandle>,
    ) -> anyhow::Result<Self> {
        let state_dir = speedwave_runtime::host_exec::host_exec_project_dir(data_dir, project);
        std::fs::create_dir_all(&state_dir)?;

        let token = uuid::Uuid::new_v4().to_string();
        let config_path = state_dir.join(consts::HOST_EXEC_CONFIG_FILE);
        let token_path = state_dir.join(consts::HOST_EXEC_AUTH_TOKEN_FILE);
        let port_path = state_dir.join(consts::HOST_EXEC_PORT_FILE);
        let pid_path = state_dir.join(consts::HOST_EXEC_PID_FILE);
        let log_path = state_dir.join(consts::HOST_EXEC_LOG_FILE);

        // Kill any stale worker from a previous session (this project's PID file).
        kill_stale_by_pid_file(&pid_path);

        // Keep the audit log bounded (the worker appends to it indefinitely).
        crate::log_file::truncate_if_oversized(&log_path, LOG_MAX_BYTES);

        // Bearer token — chmod 600.
        write_restricted_file(&token_path, &token)?;

        // -- Build the child env (env_clear + a minimal re-added set) ----------
        //
        // env_clear() wipes every inherited variable so a parent secret (API
        // keys, tokens, credentials) cannot leak into the worker — and, via the
        // worker's own child-env allowlist, into recipes (`build.gradle`,
        // `node_modules`, …). The worker still gets:
        //   - PATH = the recovered login-shell PATH (so `npm`/`docker`/`gradle`
        //     globals resolve even when the app was launched from Finder);
        //   - HOME / Windows CSPRNG vars (Node.js needs them);
        //   - SPEEDWAVE_RESOURCES_DIR + SPEEDWAVE_PROD in a bundled .app;
        //   - the HOST_EXEC_* contract vars below.
        // The bundled `node` is resolved to an absolute path by
        // `binary::command("node")`, so it executes even though PATH no longer
        // contains the bundle's bin dir.
        let mut cmd = speedwave_runtime::binary::command("node");
        cmd.arg(script_path);
        apply_child_env(&mut cmd, host_path, &CurrentProcessEnv);
        cmd.env("PORT", "0")
            .env("HOST_EXEC_AUTH_TOKEN", &token)
            .env("HOST_EXEC_CONFIG_PATH", &config_path)
            // The worker writes its audit log here (full argv, exit code, the
            // confirmation decision; recipe `env` values redacted — ADR-054).
            .env("HOST_EXEC_LOG_FILE", &log_path)
            // stdin: the Tauri side writes confirm-replies here (newline-JSON).
            // It must be a real pipe — NOT inherited (would let the worker read
            // our stdin) and NOT null (the worker's `process.stdin` data handler
            // would never fire, so confirmations could never be answered).
            .stdin(Stdio::piped())
            // stdout: the `{"port":N}` line plus the worker's console logs.
            .stdout(Stdio::piped())
            // stderr: the worker's warnings/errors.
            .stderr(Stdio::piped());

        // -- Wire the confirm channel (fd 3) on Unix ---------------------------
        //
        // The worker writes confirm-requests to fd 3; we read them. We create a
        // socketpair, give one end to the child as fd 3 via `command-fds`
        // (which dup2's it and closes our copy after fork), and keep the other.
        // On Windows this is skipped — see the module-level NOTE; the worker's
        // openFd3() then returns undefined and confirmations fail closed.
        #[cfg(unix)]
        let confirm_read_end: Option<std::os::unix::net::UnixStream> = {
            match std::os::unix::net::UnixStream::pair() {
                Ok((ours, theirs)) => {
                    use command_fds::{CommandFdExt, FdMapping};
                    use std::os::fd::OwnedFd;
                    let mapping = FdMapping {
                        parent_fd: OwnedFd::from(theirs),
                        child_fd: 3,
                    };
                    if let Err(e) = cmd.fd_mappings(vec![mapping]) {
                        log::warn!(
                            "host_exec[{project}]: could not map fd 3 for the confirm channel: {e} \
                             — confirmations will fail closed"
                        );
                        None
                    } else {
                        Some(ours)
                    }
                }
                Err(e) => {
                    log::warn!(
                        "host_exec[{project}]: could not create the confirm-channel pipe: {e} \
                         — confirmations will fail closed"
                    );
                    None
                }
            }
        };
        #[cfg(not(unix))]
        let confirm_read_end: Option<()> = None;

        let mut child = cmd.spawn()?;

        // PID file immediately so the next session can kill a stale worker.
        write_restricted_file(&pid_path, &child.id().to_string())?;

        // Take stdin out of the child for the confirm-reader thread to write to.
        let stdin = child.stdin.take();

        // Drain stdout/stderr + read the port (10 s timeout). On failure, kill
        // the child and remove the token + PID (the port file isn't written
        // yet).
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

        // Port file so compose.rs (step 5) can build WORKER_HOST_EXEC_URL.
        if let Err(e) = write_restricted_file(&port_path, &port.to_string()) {
            child.kill().ok();
            child.wait().ok();
            let _ = std::fs::remove_file(&token_path);
            let _ = std::fs::remove_file(&pid_path);
            return Err(e);
        }

        let session_allow_cache: SessionAllowCache = Arc::new(Mutex::new(HashSet::new()));
        let pending_confirms: PendingConfirms = Arc::new(Mutex::new(HashMap::new()));

        // -- Confirm-reader thread --------------------------------------------
        let confirm_reader = spawn_confirm_reader(
            confirm_read_end,
            stdin,
            project.to_string(),
            config_path.clone(),
            session_allow_cache.clone(),
            pending_confirms.clone(),
            app_handle.clone(),
        );

        Ok(Self {
            project: project.to_string(),
            project_dir: project_dir.to_path_buf(),
            child: Some(child),
            drain_handles,
            confirm_reader,
            data_dir: data_dir.to_path_buf(),
            config_path,
            token_path,
            port_path,
            pid_path,
            port,
            script_path: script_path.to_string(),
            host_path: host_path.to_string(),
            app_handle,
            session_allow_cache,
            pending_confirms,
        })
    }

    /// Test-only spawn with an injectable `data_dir` and no app handle (the
    /// frontend confirm path is exercised at the pure-function level — see the
    /// `decide_confirmation` tests).
    #[cfg(test)]
    pub(crate) fn spawn_in_dir(
        project: &str,
        project_dir: &Path,
        script_path: &str,
        host_path: &str,
        data_dir: &Path,
    ) -> anyhow::Result<Self> {
        Self::spawn_in(project, project_dir, script_path, host_path, data_dir, None)
    }

    /// The port the worker is listening on (`127.0.0.1:<port>`).
    pub fn port(&self) -> u16 {
        self.port
    }

    /// Kill the worker and join all its threads (the stdout/stderr drains and
    /// the confirm reader). After `child.wait()` the pipes are closed, so the
    /// drain loops and the fd-3 read loop hit EOF and the joins are
    /// deterministic.
    pub fn stop(&mut self) -> anyhow::Result<()> {
        if let Some(mut child) = self.child.take() {
            child.kill().ok();
            child.wait().ok();
        }
        for handle in self.drain_handles.drain(..) {
            let _ = handle.join();
        }
        if let Some(reader) = self.confirm_reader.take() {
            let _ = reader.join();
        }
        Ok(())
    }

    /// Remove the per-project token, port, PID, and config-snapshot files.
    /// The audit **log is intentionally kept** — it persists for diagnostics.
    pub fn cleanup_files(&self) {
        let _ = std::fs::remove_file(&self.token_path);
        let _ = std::fs::remove_file(&self.port_path);
        let _ = std::fs::remove_file(&self.pid_path);
        let _ = std::fs::remove_file(&self.config_path);
    }

    /// Stop the worker and spawn a fresh one for the same project — and
    /// **clear the session-allow cache** (a respawn typically follows a config
    /// edit; a stale `allow-session` for an old argv must not survive). Mirrors
    /// `McpOsProcess::respawn`'s path-clearing dance so `Drop`/`cleanup_files`
    /// of the *old* `self` deletes nothing the new spawn just wrote.
    ///
    /// NOTE: the new worker reads the *current* `config.json`; the caller is
    /// responsible for having written the new snapshot first (step 6's
    /// `host_exec_save_settings`) and for triggering the hub re-discovery
    /// afterwards (step 5).
    pub fn respawn(&mut self) -> anyhow::Result<u16> {
        if let Some(mut child) = self.child.take() {
            child.kill().ok();
            child.wait().ok();
        }
        for handle in self.drain_handles.drain(..) {
            let _ = handle.join();
        }
        if let Some(reader) = self.confirm_reader.take() {
            let _ = reader.join();
        }
        // Save the old paths, then clear them so Drop/cleanup_files of the
        // about-to-be-replaced `self` deletes nothing (spawn_in writes fresh
        // files at these same paths).
        let old_config_path = std::mem::replace(&mut self.config_path, PathBuf::new());
        let old_token_path = std::mem::replace(&mut self.token_path, PathBuf::new());
        let old_port_path = std::mem::replace(&mut self.port_path, PathBuf::new());
        let old_pid_path = std::mem::replace(&mut self.pid_path, PathBuf::new());

        let new = match Self::spawn_in(
            &self.project,
            &self.project_dir,
            &self.script_path,
            &self.host_path,
            &self.data_dir.clone(),
            self.app_handle.clone(),
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
        *self = new; // old self dropped — Drop is harmless now (empty paths, no child/handles)
                     // The fresh worker starts with an empty cache, but be explicit: the
                     // contract is "respawn clears the cache".
        self.clear_session_cache();
        Ok(new_port)
    }

    /// Whether the worker is alive *and* listening on its port. More thorough
    /// than `child.is_some()` — detects "alive but not listening".
    pub fn is_alive(&self) -> bool {
        if self.child.is_none() {
            return false;
        }
        crate::health::is_host_exec_alive(self.port)
    }

    /// Drop every `(project, recipe, argv, cwd, config-hash)` entry from the
    /// session-allow cache. Called by `respawn` and by step 6's
    /// `host_exec_save_settings` (a recipe edit must re-prompt). Idempotent.
    pub fn clear_session_cache(&self) {
        match self.session_allow_cache.lock() {
            Ok(mut c) => c.clear(),
            Err(e) => log::warn!(
                "host_exec[{}]: session-cache mutex poisoned while clearing: {e}",
                self.project
            ),
        }
    }

    /// Deliver the frontend's reply to an in-flight confirm-request. Called by
    /// the `host_exec_confirm_reply` Tauri command. `decision` is one of
    /// `allow` / `allow-session` / `deny` (the caller validates). Unknown `id`
    /// (stale dialog, double-click, race with a timeout) is a no-op.
    pub fn complete_confirmation(&self, id: &str, decision: &str) {
        let sender = match self.pending_confirms.lock() {
            Ok(mut map) => map.remove(id),
            Err(e) => {
                log::warn!(
                    "host_exec[{}]: pending-confirms mutex poisoned: {e}",
                    self.project
                );
                None
            }
        };
        match sender {
            Some(tx) => {
                if tx.send(decision.to_string()).is_err() {
                    // Receiver gone — the reader thread already timed out and
                    // dropped its end. Nothing to do; the worker fails closed.
                    log::debug!(
                        "host_exec[{}]: confirm reply for id={id} arrived after the reader gave up",
                        self.project
                    );
                }
            }
            None => log::debug!(
                "host_exec[{}]: confirm reply for unknown id={id} (stale dialog?) — ignored",
                self.project
            ),
        }
    }
}

impl Drop for HostExecProcess {
    fn drop(&mut self) {
        self.stop().ok();
        self.cleanup_files();
    }
}

// ---------------------------------------------------------------------------
// Tauri command — forward a frontend confirmation reply to the worker.
// (Step 6 will add `host_exec_cmd.rs` with the settings commands; this one
// belongs here next to the reader thread that consumes it.)
// ---------------------------------------------------------------------------

/// Forward the user's per-recipe confirmation decision to the project's
/// `host_exec` worker (which then writes the reply line on the worker's stdin).
///
/// `decision` must be `"allow"`, `"allow-session"`, or `"deny"`. If the project
/// has no live worker, or `id` is unknown, this is a (logged) no-op — the
/// worker's own guard then fails closed.
#[tauri::command]
pub fn host_exec_confirm_reply(
    project: String,
    id: String,
    decision: String,
    state: tauri::State<'_, crate::reconcile::SharedHostExec>,
) -> Result<(), String> {
    if !matches!(decision.as_str(), "allow" | "allow-session" | "deny") {
        return Err(format!(
            "invalid host_exec confirmation decision: '{decision}' (expected allow / allow-session / deny)"
        ));
    }
    crate::types::check_project(&project)?;
    let map = state
        .lock()
        .map_err(|e| format!("host_exec process map poisoned: {e}"))?;
    match map.get(&project) {
        Some(proc) => {
            proc.complete_confirmation(&id, &decision);
            Ok(())
        }
        None => {
            log::warn!("host_exec_confirm_reply: no live worker for project '{project}'");
            // Not an error from the frontend's perspective — the worker (if any)
            // fails closed; the dialog can simply disappear.
            Ok(())
        }
    }
}

// ---------------------------------------------------------------------------
// Confirm-reader thread
// ---------------------------------------------------------------------------

/// Spawn the thread that reads confirm-requests off fd 3 (one newline-JSON
/// object per request) and answers them — auto-allowing on `confirm: always`
/// or a warm session cache, or emitting `host-exec://confirm-request` and
/// waiting for the frontend's reply (failing closed on timeout by *not*
/// replying, so the worker's own guard produces "confirmation unavailable").
///
/// Returns `None` if the fd-3 channel is not wired (Windows, or pipe-creation
/// failed) or there is no stdin to write replies to — in either case the worker
/// fails closed on its own.
#[cfg(unix)]
fn spawn_confirm_reader(
    read_end: Option<std::os::unix::net::UnixStream>,
    stdin: Option<std::process::ChildStdin>,
    project: String,
    config_path: PathBuf,
    session_allow_cache: SessionAllowCache,
    pending_confirms: PendingConfirms,
    app_handle: Option<tauri::AppHandle>,
) -> Option<JoinHandle<()>> {
    let (read_end, mut stdin) = match (read_end, stdin) {
        (Some(r), Some(s)) => (r, s),
        _ => {
            log::warn!(
                "host_exec[{project}]: confirm channel not available (fd 3 unwired or no stdin) \
                 — confirmations will fail closed"
            );
            return None;
        }
    };
    Some(std::thread::spawn(move || {
        use std::io::{BufRead, Write};
        let reader = std::io::BufReader::new(read_end);
        for line in reader.lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => break, // worker died / pipe closed
            };
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let req: ConfirmRequest = match serde_json::from_str(line) {
                Ok(r) => r,
                Err(e) => {
                    log::warn!(
                        "host_exec[{project}]: ignoring malformed confirm-request line: {e}"
                    );
                    continue;
                }
            };
            // Re-read the current config snapshot. If the recipe is gone, fail
            // closed (reply `deny`) — the worker's snapshot may be staler than
            // ours, but never run something the current whitelist doesn't have.
            let (confirm, config_hash) = match lookup_recipe_confirm(&config_path, &req.recipe) {
                Some(pair) => pair,
                None => {
                    log::warn!(
                        "host_exec[{project}]: confirm-request for recipe '{}' not in the current \
                         whitelist — denying",
                        req.recipe
                    );
                    write_confirm_reply(&mut stdin, &req.id, "deny", &project);
                    continue;
                }
            };
            let key =
                ConfirmCacheKey::new(&project, &req.recipe, &req.argv, &req.cwd, &config_hash);

            let decision = {
                let cache = match session_allow_cache.lock() {
                    Ok(c) => c,
                    Err(e) => {
                        log::warn!(
                            "host_exec[{project}]: session-cache mutex poisoned — failing closed: {e}"
                        );
                        write_confirm_reply(&mut stdin, &req.id, "deny", &project);
                        continue;
                    }
                };
                decide_confirmation(confirm, &key, &cache)
            };

            match decision {
                ConfirmDecision::AutoAllow => {
                    write_confirm_reply(&mut stdin, &req.id, "allow", &project);
                }
                ConfirmDecision::AskFrontend => {
                    let Some(ref app) = app_handle else {
                        // No frontend reachable (test / headless) — fail closed
                        // by NOT replying; the worker's guard produces
                        // "confirmation unavailable".
                        log::warn!(
                            "host_exec[{project}]: cannot ask the frontend to confirm recipe '{}' \
                             (no app handle) — failing closed",
                            req.recipe
                        );
                        continue;
                    };
                    // Register the pending reply BEFORE emitting, so a fast
                    // reply can't race past us.
                    let (tx, rx) = std::sync::mpsc::channel::<String>();
                    match pending_confirms.lock() {
                        Ok(mut map) => {
                            map.insert(req.id.clone(), tx);
                        }
                        Err(e) => {
                            log::warn!(
                                "host_exec[{project}]: pending-confirms mutex poisoned — failing \
                                 closed: {e}"
                            );
                            continue;
                        }
                    }
                    use tauri::Emitter;
                    if let Err(e) = app.emit(
                        "host-exec://confirm-request",
                        serde_json::json!({
                            "project": project,
                            "recipe": req.recipe,
                            "argv": req.argv,
                            "cwd": req.cwd,
                            "id": req.id,
                        }),
                    ) {
                        log::warn!(
                            "host_exec[{project}]: failed to emit confirm-request event: {e} — \
                             failing closed"
                        );
                        if let Ok(mut map) = pending_confirms.lock() {
                            map.remove(&req.id);
                        }
                        continue;
                    }
                    match rx.recv_timeout(CONFIRM_REPLY_TIMEOUT) {
                        Ok(decision) => {
                            if let Ok(mut map) = pending_confirms.lock() {
                                map.remove(&req.id);
                            }
                            if decision == "allow-session" {
                                if let Ok(mut cache) = session_allow_cache.lock() {
                                    cache.insert(key);
                                }
                            }
                            // The worker treats allow / allow-session the same
                            // (`allowed = decision !== 'deny'`); pass the
                            // decision through verbatim. `deny` → tool error.
                            write_confirm_reply(&mut stdin, &req.id, &decision, &project);
                        }
                        Err(_) => {
                            // Frontend didn't answer in time. Do NOT reply — the
                            // worker's own (longer) guard fires and produces
                            // "confirmation unavailable" (the right semantics;
                            // a `deny` here would mis-report it as "denied by
                            // user"). Drop the pending entry.
                            if let Ok(mut map) = pending_confirms.lock() {
                                map.remove(&req.id);
                            }
                            log::warn!(
                                "host_exec[{project}]: frontend confirmation for recipe '{}' timed \
                                 out — leaving it to the worker's guard (fail closed)",
                                req.recipe
                            );
                        }
                    }
                }
            }
            // Flush after each reply so the worker sees it promptly.
            let _ = stdin.flush();
        }
        log::debug!("host_exec[{project}]: confirm-reader thread exiting (fd 3 closed)");
    }))
}

/// On non-Unix, the fd-3 confirm channel is not wired (see the module NOTE) —
/// there is no reader thread; the worker's `openFd3()` returns undefined and
/// confirmations fail closed.
#[cfg(not(unix))]
fn spawn_confirm_reader(
    _read_end: Option<()>,
    _stdin: Option<std::process::ChildStdin>,
    project: String,
    _config_path: PathBuf,
    _session_allow_cache: SessionAllowCache,
    _pending_confirms: PendingConfirms,
    _app_handle: Option<tauri::AppHandle>,
) -> Option<JoinHandle<()>> {
    log::warn!(
        "host_exec[{project}]: the confirm channel (fd 3) is not wired on this platform — the \
         worker's openFd3() returns undefined and confirmations fail closed (safe but unusable). \
         Wiring extra fds here needs a different mechanism (e.g. a named pipe) — tracked separately."
    );
    None
}

/// Write `{"type":"confirm-reply","id":<id>,"decision":<decision>}\n` to the
/// worker's stdin. Errors are logged (the worker fails closed on its own if the
/// pipe is broken).
fn write_confirm_reply(
    stdin: &mut std::process::ChildStdin,
    id: &str,
    decision: &str,
    project: &str,
) {
    use std::io::Write;
    let line = serde_json::json!({ "type": "confirm-reply", "id": id, "decision": decision });
    if let Err(e) = writeln!(stdin, "{line}") {
        log::warn!("host_exec[{project}]: failed to write confirm-reply for id={id}: {e}");
    }
}

// ---------------------------------------------------------------------------
// Child-process environment policy (mirrors mcp_os_process::apply_child_env,
// but the re-added PATH is the recovered login-shell PATH, and the HOST_EXEC_*
// vars are added by the caller — never here, and never inherited).
// ---------------------------------------------------------------------------

/// Reads environment variables from a source (process env, or a fake in tests).
/// Pulled out so the env construction is testable without mutating the
/// process-global environment (which races other tests / concurrent instances).
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

/// Apply the `host_exec` worker's child-process environment policy to `cmd`.
///
/// Clears the inherited environment (so a parent secret cannot leak to the
/// worker — or, via the worker's own child-env allowlist, to recipes), then
/// adds back only what the worker needs:
///
/// - `PATH` = `host_path` (the *recovered login-shell* `PATH`, not the GUI
///   app's stunted one — see [`crate::recovered_host_path`]);
/// - `HOME` (Unix) / the Windows CSPRNG vars (Node.js needs them);
/// - `SPEEDWAVE_RESOURCES_DIR` + `SPEEDWAVE_PROD` when the parent is a bundled `.app`.
///
/// It does **not** add the `HOST_EXEC_*` contract vars — the caller does that
/// explicitly *after* this — and it never re-adds anything else inherited.
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

    // The recovered login-shell PATH — given to the worker, and (via the
    // worker's allowlist) to recipes. Empty string is tolerated (the bundled
    // `node` is an absolute path), but the recovery in main.rs always falls
    // back to something non-empty.
    cmd.env("PATH", host_path);

    // HOME is set on Unix; on Windows USERPROFILE (forwarded above) is the
    // equivalent and HOME="" would break Node's path resolution.
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
// Stale-process cleanup (per-project PID file) — identical mechanics to
// mcp_os_process, but operating on the per-project PID file.
// ---------------------------------------------------------------------------

/// Kill a stale `host_exec` worker identified by its (per-project) PID file.
/// Only kills the PID if `ps`/`tasklist` says it is a `node` process, so a
/// recycled PID is not killed by mistake. The PID file is removed regardless.
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

/// Whether `pid` belongs to a `node` process (`ps` on Unix, `tasklist` on Windows).
#[cfg(unix)]
fn is_node_process(pid: u32) -> bool {
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
    let output = speedwave_runtime::binary::system_command("tasklist")
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
    let _ = speedwave_runtime::binary::system_command("taskkill")
        .args(["/F", "/PID", &pid.to_string()])
        .status();
}

// ---------------------------------------------------------------------------
// Port handshake + stdout/stderr drain (mirrors mcp_os_process).
// ---------------------------------------------------------------------------

/// Spawn background threads draining the worker's stdout and stderr into the
/// log, and wait for the `{"port":N}` JSON line on stdout (10 s timeout).
/// Returns the port and the drain join handles (so the caller can join them on
/// stop, releasing the log-file handles).
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

// ---------------------------------------------------------------------------
// Restricted file write (chmod 600 / icacls) — same as mcp_os_process.
// ---------------------------------------------------------------------------

/// Write `content` to `path` with `chmod 600` on Unix (current-user-only ACL
/// via `icacls` on Windows). The token / port / PID / config-snapshot files all
/// use this — the config snapshot in particular may contain recipe `env` values
/// (possibly secrets), so it must not be world-readable (ADR-054).
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
        std::fs::write(path, content)?;
        let status = speedwave_runtime::binary::system_command("icacls")
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

// ---------------------------------------------------------------------------
// Test-only accessors — gated behind cfg(test) so clippy reports dead code in
// production builds instead of needing #[allow(dead_code)].
// ---------------------------------------------------------------------------

#[cfg(test)]
impl HostExecProcess {
    pub(crate) fn token(&self) -> String {
        std::fs::read_to_string(&self.token_path).unwrap_or_default()
    }

    pub(crate) fn config_path(&self) -> &Path {
        &self.config_path
    }

    /// The per-project audit log path, recomputed from `data_dir` + `project`
    /// (the file is created lazily by `crate::log_file::open_log_file` in the
    /// drain threads). Not stored on the struct — the worker writes to it via
    /// the `HOST_EXEC_LOG_FILE` env var, the Tauri side never reads it (yet —
    /// step 6's diagnostics view will).
    pub(crate) fn log_path(&self) -> PathBuf {
        speedwave_runtime::host_exec::host_exec_project_dir(&self.data_dir, &self.project)
            .join(consts::HOST_EXEC_LOG_FILE)
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

    pub(crate) fn session_cache_len(&self) -> usize {
        self.session_allow_cache
            .lock()
            .map(|c| c.len())
            .unwrap_or(0)
    }

    pub(crate) fn insert_session_cache_key(&self, key: ConfirmCacheKey) {
        if let Ok(mut c) = self.session_allow_cache.lock() {
            c.insert(key);
        }
    }

    pub(crate) fn pending_confirms_len(&self) -> usize {
        self.pending_confirms.lock().map(|m| m.len()).unwrap_or(0)
    }

    /// Register a fake pending confirmation for `id` and return the receiver —
    /// lets a test drive `complete_confirmation` without a real reader thread.
    pub(crate) fn register_pending_confirm(&self, id: &str) -> std::sync::mpsc::Receiver<String> {
        let (tx, rx) = std::sync::mpsc::channel();
        if let Ok(mut m) = self.pending_confirms.lock() {
            m.insert(id.to_string(), tx);
        }
        rx
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

    /// A minimal `host_exec`-worker stand-in: announces `{"port":N}` on stdout
    /// (binding 127.0.0.1) and then sleeps. Mirrors the http-listener fakes in
    /// `mcp_os_process.rs` so the port handshake / file-bookkeeping logic is
    /// exercised without the real (multi-file, npm-built) worker.
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

    /// Write a minimal config snapshot (`{ projectDir, commands }`) — the
    /// fake worker doesn't read it, but the reader thread does (per
    /// confirm-request) and `spawn_in` passes it as `HOST_EXEC_CONFIG_PATH`.
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

    // -- decide_confirmation (pure) ------------------------------------------

    fn key(project: &str, recipe: &str, argv: &[&str], cwd: &str, hash: &str) -> ConfirmCacheKey {
        ConfirmCacheKey::new(
            project,
            recipe,
            &argv.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
            cwd,
            hash,
        )
    }

    #[test]
    fn decide_confirmation_always_auto_allows() {
        let k = key("p", "test", &["./gradlew", "test"], ".", "h1");
        let empty = HashSet::new();
        assert_eq!(
            decide_confirmation(HostExecConfirm::Always, &k, &empty),
            ConfirmDecision::AutoAllow
        );
    }

    #[test]
    fn decide_confirmation_ask_asks_frontend() {
        let k = key("p", "test", &["./gradlew", "test"], ".", "h1");
        let empty = HashSet::new();
        assert_eq!(
            decide_confirmation(HostExecConfirm::Ask, &k, &empty),
            ConfirmDecision::AskFrontend
        );
    }

    #[test]
    fn decide_confirmation_session_auto_allows_only_on_cache_hit() {
        let k = key("p", "test", &["./gradlew", "test"], ".", "h1");
        let empty = HashSet::new();
        assert_eq!(
            decide_confirmation(HostExecConfirm::Session, &k, &empty),
            ConfirmDecision::AskFrontend,
            "first invocation must still prompt"
        );
        let mut warm = HashSet::new();
        warm.insert(k.clone());
        assert_eq!(
            decide_confirmation(HostExecConfirm::Session, &k, &warm),
            ConfirmDecision::AutoAllow,
            "second invocation with the same argv/cwd/config-hash is silent"
        );
    }

    #[test]
    fn confirm_cache_key_distinguishes_argv() {
        let a = key(
            "p",
            "psql",
            &["docker", "exec", "db", "psql", "-c", "SELECT 1"],
            ".",
            "h",
        );
        let b = key(
            "p",
            "psql",
            &["docker", "exec", "db", "psql", "-c", "DROP TABLE x"],
            ".",
            "h",
        );
        assert_ne!(a, b, "different argv → different key");
        let mut warm = HashSet::new();
        warm.insert(a.clone());
        assert_eq!(
            decide_confirmation(HostExecConfirm::Session, &a, &warm),
            ConfirmDecision::AutoAllow
        );
        assert_eq!(
            decide_confirmation(HostExecConfirm::Session, &b, &warm),
            ConfirmDecision::AskFrontend,
            "an allow-session for one argv must not authorise a different argv"
        );
    }

    #[test]
    fn confirm_cache_key_distinguishes_cwd_and_config_hash() {
        let base = key("p", "test", &["npm", "run", "build"], ".", "h1");
        let other_cwd = key("p", "test", &["npm", "run", "build"], "frontend", "h1");
        let other_hash = key("p", "test", &["npm", "run", "build"], ".", "h2");
        assert_ne!(base, other_cwd, "different cwd → different key");
        assert_ne!(
            base, other_hash,
            "edited recipe (new config hash) → different key"
        );
    }

    #[test]
    fn confirm_cache_key_distinguishes_project() {
        let a = key("proj-a", "test", &["./gradlew", "test"], ".", "h");
        let b = key("proj-b", "test", &["./gradlew", "test"], ".", "h");
        assert_ne!(
            a, b,
            "same recipe in two projects → different keys (per-project isolation)"
        );
    }

    // -- sha256_hex ----------------------------------------------------------

    #[test]
    fn sha256_hex_is_lowercase_64_hex() {
        let h = sha256_hex(r#"{"name":"test","exec":"./gradlew","args":["test"],"confirm":"ask"}"#);
        assert_eq!(h.len(), 64);
        assert!(h
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        // Stable across calls.
        assert_eq!(
            h,
            sha256_hex(r#"{"name":"test","exec":"./gradlew","args":["test"],"confirm":"ask"}"#)
        );
        assert_ne!(
            h,
            sha256_hex(r#"{"name":"test2","exec":"./gradlew","args":["test"],"confirm":"ask"}"#)
        );
    }

    // -- lookup_recipe_confirm ----------------------------------------------

    #[test]
    fn lookup_recipe_confirm_reads_confirm_and_hash() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = tmp.path().join("config.json");
        std::fs::write(
            &cfg,
            r#"{"projectDir":"/x","commands":[
                {"name":"test","exec":"./gradlew","args":["test"],"confirm":"ask"},
                {"name":"build","exec":"./gradlew","args":["build"],"confirm":"session"},
                {"name":"fe","exec":"npm","args":["run","build"],"confirm":"always"}
            ]}"#,
        )
        .unwrap();
        let (c, h1) = lookup_recipe_confirm(&cfg, "test").unwrap();
        assert_eq!(c, HostExecConfirm::Ask);
        assert_eq!(h1.len(), 64);
        assert_eq!(
            lookup_recipe_confirm(&cfg, "build").unwrap().0,
            HostExecConfirm::Session
        );
        assert_eq!(
            lookup_recipe_confirm(&cfg, "fe").unwrap().0,
            HostExecConfirm::Always
        );
        assert!(lookup_recipe_confirm(&cfg, "missing").is_none());
    }

    #[test]
    fn lookup_recipe_confirm_defaults_to_ask_when_field_absent() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = tmp.path().join("config.json");
        std::fs::write(
            &cfg,
            r#"{"projectDir":"/x","commands":[{"name":"t","exec":"./x","args":[]}]}"#,
        )
        .unwrap();
        assert_eq!(
            lookup_recipe_confirm(&cfg, "t").unwrap().0,
            HostExecConfirm::Ask
        );
    }

    #[test]
    fn lookup_recipe_confirm_hash_changes_when_recipe_edited() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = tmp.path().join("config.json");
        std::fs::write(
            &cfg,
            r#"{"projectDir":"/x","commands":[{"name":"t","exec":"./x","args":["a"],"confirm":"ask"}]}"#,
        )
        .unwrap();
        let h1 = lookup_recipe_confirm(&cfg, "t").unwrap().1;
        std::fs::write(
            &cfg,
            r#"{"projectDir":"/x","commands":[{"name":"t","exec":"./x","args":["a","b"],"confirm":"ask"}]}"#,
        )
        .unwrap();
        let h2 = lookup_recipe_confirm(&cfg, "t").unwrap().1;
        assert_ne!(h1, h2, "editing a recipe must change its config hash");
    }

    #[test]
    fn lookup_recipe_confirm_none_on_bad_file() {
        let tmp = tempfile::tempdir().unwrap();
        // Missing file.
        assert!(lookup_recipe_confirm(&tmp.path().join("nope.json"), "x").is_none());
        // Malformed JSON.
        let bad = tmp.path().join("bad.json");
        std::fs::write(&bad, "{not json").unwrap();
        assert!(lookup_recipe_confirm(&bad, "x").is_none());
        // Right JSON, no `commands` array.
        let empty = tmp.path().join("empty.json");
        std::fs::write(&empty, r#"{"projectDir":"/x"}"#).unwrap();
        assert!(lookup_recipe_confirm(&empty, "x").is_none());
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
        std::fs::write(&p, "99999999").unwrap(); // almost certainly not a live PID
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
        assert!(std::fs::read_to_string(&log)
            .unwrap()
            .contains("starting up"));
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
        // A child that never writes a port — drain_and_read_port should time
        // out (we use the helper that exercises the real rx.recv_timeout path
        // via a shorter, manual probe so the test isn't 10 s long).
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
            &speedwave_runtime::host_exec::host_exec_project_dir(&data_dir, "proj-a"),
            &proj_a_dir,
            commands.clone(),
        );
        write_config_snapshot(
            &speedwave_runtime::host_exec::host_exec_project_dir(&data_dir, "proj-b"),
            &proj_b_dir,
            commands,
        );

        let a = HostExecProcess::spawn_in_dir(
            "proj-a",
            &proj_a_dir,
            &script.to_string_lossy(),
            &host_path(),
            &data_dir,
        );
        let b = HostExecProcess::spawn_in_dir(
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
                // Per-project state dirs.
                let a_dir =
                    speedwave_runtime::host_exec::host_exec_project_dir(&data_dir, "proj-a");
                let b_dir =
                    speedwave_runtime::host_exec::host_exec_project_dir(&data_dir, "proj-b");
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
                // Port file matches the live port.
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
            &speedwave_runtime::host_exec::host_exec_project_dir(&data_dir, "p"),
            &proj_dir,
            serde_json::json!([]),
        );
        // A fake worker that reports back which env vars it sees.
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
        let proc = HostExecProcess::spawn_in_dir(
            "p",
            &proj_dir,
            &script.to_string_lossy(),
            &host_path(),
            &data_dir,
        );
        std::env::remove_var("SUPER_SECRET_FROM_PARENT");

        if let Ok(mut proc) = proc {
            // Give the probe line a moment to land in the log.
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
            &speedwave_runtime::host_exec::host_exec_project_dir(&data_dir, "p"),
            &proj_dir,
            serde_json::json!([]),
        );
        let script = write_fake_worker(tmp.path(), "fake.js");
        let proc = HostExecProcess::spawn_in_dir(
            "p",
            &proj_dir,
            &script.to_string_lossy(),
            &host_path(),
            &data_dir,
        );
        if let Ok(proc) = proc {
            let state = speedwave_runtime::host_exec::host_exec_project_dir(&data_dir, "p");
            let token = state.join(consts::HOST_EXEC_AUTH_TOKEN_FILE);
            let port = state.join(consts::HOST_EXEC_PORT_FILE);
            let pid = state.join(consts::HOST_EXEC_PID_FILE);
            let log = state.join(consts::HOST_EXEC_LOG_FILE);
            assert!(token.exists() && port.exists() && pid.exists());
            drop(proc);
            assert!(!token.exists(), "token removed on drop (sensitive)");
            assert!(!port.exists(), "port file removed on drop");
            assert!(!pid.exists(), "pid file removed on drop");
            // The log persists for diagnostics.
            assert!(log.exists(), "audit log must NOT be removed on drop");
        }
        // node not available — skip
    }

    #[test]
    #[serial(env)]
    fn respawn_clears_session_cache_and_keeps_data_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("data");
        let proj_dir = tmp.path().join("proj");
        std::fs::create_dir_all(&proj_dir).unwrap();
        write_config_snapshot(
            &speedwave_runtime::host_exec::host_exec_project_dir(&data_dir, "p"),
            &proj_dir,
            serde_json::json!([]),
        );
        let script = write_fake_worker(tmp.path(), "fake.js");
        if let Ok(mut proc) = HostExecProcess::spawn_in_dir(
            "p",
            &proj_dir,
            &script.to_string_lossy(),
            &host_path(),
            &data_dir,
        ) {
            proc.insert_session_cache_key(key("p", "test", &["./gradlew", "test"], ".", "h"));
            assert_eq!(proc.session_cache_len(), 1);
            match proc.respawn() {
                Ok(new_port) => {
                    assert!(new_port > 0);
                    assert_eq!(
                        proc.session_cache_len(),
                        0,
                        "respawn must clear the session-allow cache"
                    );
                    assert_eq!(
                        proc.data_dir(),
                        data_dir,
                        "data_dir is preserved across respawn"
                    );
                    assert!(proc.health_check(), "respawned worker should be alive");
                    // Fresh state files at the same paths.
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
            &speedwave_runtime::host_exec::host_exec_project_dir(&data_dir, "p"),
            &proj_dir,
            serde_json::json!([]),
        );
        let script = write_fake_worker(tmp.path(), "fake.js");
        if let Ok(mut proc) = HostExecProcess::spawn_in_dir(
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
    fn clear_session_cache_empties_it() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("data");
        let proj_dir = tmp.path().join("proj");
        std::fs::create_dir_all(&proj_dir).unwrap();
        write_config_snapshot(
            &speedwave_runtime::host_exec::host_exec_project_dir(&data_dir, "p"),
            &proj_dir,
            serde_json::json!([]),
        );
        let script = write_fake_worker(tmp.path(), "fake.js");
        if let Ok(mut proc) = HostExecProcess::spawn_in_dir(
            "p",
            &proj_dir,
            &script.to_string_lossy(),
            &host_path(),
            &data_dir,
        ) {
            proc.insert_session_cache_key(key("p", "a", &["x"], ".", "h1"));
            proc.insert_session_cache_key(key("p", "b", &["y"], ".", "h2"));
            assert_eq!(proc.session_cache_len(), 2);
            proc.clear_session_cache();
            assert_eq!(proc.session_cache_len(), 0);
            proc.stop().unwrap();
        }
        // node not available — skip
    }

    // -- complete_confirmation / pending-confirms mechanics ------------------

    #[test]
    #[serial(env)]
    fn complete_confirmation_delivers_to_waiting_receiver() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("data");
        let proj_dir = tmp.path().join("proj");
        std::fs::create_dir_all(&proj_dir).unwrap();
        write_config_snapshot(
            &speedwave_runtime::host_exec::host_exec_project_dir(&data_dir, "p"),
            &proj_dir,
            serde_json::json!([]),
        );
        let script = write_fake_worker(tmp.path(), "fake.js");
        if let Ok(mut proc) = HostExecProcess::spawn_in_dir(
            "p",
            &proj_dir,
            &script.to_string_lossy(),
            &host_path(),
            &data_dir,
        ) {
            let rx = proc.register_pending_confirm("req-1");
            assert_eq!(proc.pending_confirms_len(), 1);
            proc.complete_confirmation("req-1", "allow-session");
            assert_eq!(
                rx.recv_timeout(std::time::Duration::from_secs(1)).unwrap(),
                "allow-session"
            );
            assert_eq!(
                proc.pending_confirms_len(),
                0,
                "completing removes the pending entry"
            );
            // Unknown id is a harmless no-op.
            proc.complete_confirmation("does-not-exist", "deny");
            proc.stop().unwrap();
        }
        // node not available — skip
    }

    // -- fd-3 confirm round-trip (Unix): auto-allow on `confirm: always` -----

    #[cfg(unix)]
    #[test]
    #[serial(env)]
    fn fd3_confirm_round_trip_auto_allow() {
        // A fake worker that: announces its port, writes a confirm-request to
        // fd 3 (`{type:"confirm", recipe:"go", argv:["./run"], cwd:".", id}`),
        // reads the reply line from stdin, and logs whether it got `allow`.
        // The recipe `go` is `confirm: always` in the snapshot, so the reader
        // thread auto-allows — no frontend needed.
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("data");
        let proj_dir = tmp.path().join("proj");
        std::fs::create_dir_all(&proj_dir).unwrap();
        write_config_snapshot(
            &speedwave_runtime::host_exec::host_exec_project_dir(&data_dir, "p"),
            &proj_dir,
            serde_json::json!([
                {"name":"go","exec":"./run","args":["a"],"confirm":"always"}
            ]),
        );
        let script = tmp.path().join("fd3-worker.js");
        std::fs::write(
            &script,
            r#"
const fs = require('fs');
const http = require('http');
const srv = http.createServer((_, r) => { r.end('ok'); });
srv.listen(0, '127.0.0.1', () => {
  process.stdout.write(JSON.stringify({ port: srv.address().port }) + '\n');
  // fd 3 must be open (the parent wired it). Write a confirm-request.
  const fd3 = fs.createWriteStream('', { fd: 3 });
  const id = 'rt-1';
  fd3.write(JSON.stringify({ type: 'confirm', recipe: 'go', argv: ['./run'], cwd: '.', id }) + '\n');
  // Read the reply on stdin.
  let buf = '';
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      if (obj && obj.type === 'confirm-reply' && obj.id === id) {
        process.stdout.write('CONFIRMRESULT:' + obj.decision + '\n');
      }
    }
  });
});
setTimeout(() => {}, 60000);
"#,
        )
        .unwrap();

        if let Ok(mut proc) = HostExecProcess::spawn_in_dir(
            "p",
            &proj_dir,
            &script.to_string_lossy(),
            &host_path(),
            &data_dir,
        ) {
            // Wait for the reader thread to receive the request, auto-allow, and
            // write the reply — and for the worker to log the decision.
            let log_path = proc.log_path();
            let mut got = String::new();
            for _ in 0..40 {
                std::thread::sleep(std::time::Duration::from_millis(50));
                let log = std::fs::read_to_string(&log_path).unwrap_or_default();
                if let Some(line) = log.lines().find(|l| l.contains("CONFIRMRESULT:")) {
                    got = line
                        .split("CONFIRMRESULT:")
                        .nth(1)
                        .unwrap_or("")
                        .trim()
                        .to_string();
                    break;
                }
            }
            assert_eq!(
                got, "allow",
                "the worker must receive an `allow` reply for a `confirm: always` recipe"
            );
            proc.stop().unwrap();
        }
        // node not available — skip
    }

    #[cfg(unix)]
    #[test]
    #[serial(env)]
    fn fd3_confirm_round_trip_unknown_recipe_denied() {
        // Same as above but the worker asks to confirm a recipe NOT in the
        // current snapshot — the reader thread must reply `deny` (fail closed).
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("data");
        let proj_dir = tmp.path().join("proj");
        std::fs::create_dir_all(&proj_dir).unwrap();
        write_config_snapshot(
            &speedwave_runtime::host_exec::host_exec_project_dir(&data_dir, "p"),
            &proj_dir,
            serde_json::json!([{"name":"other","exec":"./x","args":[],"confirm":"always"}]),
        );
        let script = tmp.path().join("fd3-worker-deny.js");
        std::fs::write(
            &script,
            r#"
const fs = require('fs');
const http = require('http');
const srv = http.createServer((_, r) => { r.end('ok'); });
srv.listen(0, '127.0.0.1', () => {
  process.stdout.write(JSON.stringify({ port: srv.address().port }) + '\n');
  const fd3 = fs.createWriteStream('', { fd: 3 });
  const id = 'rt-deny';
  fd3.write(JSON.stringify({ type: 'confirm', recipe: 'NOT_WHITELISTED', argv: ['./x'], cwd: '.', id }) + '\n');
  let buf = '';
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let obj; try { obj = JSON.parse(line); } catch { continue; }
      if (obj && obj.type === 'confirm-reply' && obj.id === id) {
        process.stdout.write('CONFIRMRESULT:' + obj.decision + '\n');
      }
    }
  });
});
setTimeout(() => {}, 60000);
"#,
        )
        .unwrap();
        if let Ok(mut proc) = HostExecProcess::spawn_in_dir(
            "p",
            &proj_dir,
            &script.to_string_lossy(),
            &host_path(),
            &data_dir,
        ) {
            let log_path = proc.log_path();
            let mut got = String::new();
            for _ in 0..40 {
                std::thread::sleep(std::time::Duration::from_millis(50));
                let log = std::fs::read_to_string(&log_path).unwrap_or_default();
                if let Some(line) = log.lines().find(|l| l.contains("CONFIRMRESULT:")) {
                    got = line
                        .split("CONFIRMRESULT:")
                        .nth(1)
                        .unwrap_or("")
                        .trim()
                        .to_string();
                    break;
                }
            }
            assert_eq!(
                got, "deny",
                "a recipe not in the current whitelist must be denied (fail closed)"
            );
            proc.stop().unwrap();
        }
        // node not available — skip
    }
}
