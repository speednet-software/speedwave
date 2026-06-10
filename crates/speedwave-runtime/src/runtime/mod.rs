//! Container runtime abstraction: `LockedRuntime` façade over Lima/WSL2 backends.

use crate::binary;
use crate::consts;
use serde_json::Value;
use std::process::Command;
use std::sync::Mutex;

pub(crate) mod compose_locks;
#[cfg(target_os = "macos")]
pub(crate) mod lima;
pub mod locked;
#[cfg(any(test, feature = "test-support"))]
pub mod mock_runtime;
pub(crate) mod wsl;

pub use locked::LockedRuntime;
pub use wsl::decode_wsl_output;

/// Integration-test hook: returns the global lock-acquisition counter.
/// Compiled under `#[cfg(test)]` or when the `test-support` feature is on.
#[cfg(any(test, feature = "test-support"))]
pub fn lock_acquisitions_for_test() -> usize {
    locked::LOCK_ACQUISITIONS.load(std::sync::atomic::Ordering::SeqCst)
}

/// Cross-process lock test hook. Gated by `test-support` — production code
/// must use `LockedRuntime::transaction()` for serialised compose ops.
#[cfg(any(test, feature = "test-support"))]
pub fn with_project_compose_lock_in_for_test<F, T>(
    data_dir: &std::path::Path,
    project: &str,
    f: F,
) -> anyhow::Result<T>
where
    F: FnOnce() -> anyhow::Result<T>,
{
    compose_locks::with_project_compose_lock_in(data_dir, project, f)
}

/// Serializes concurrent `ensure_ready()` calls across all runtime instances.
///
/// `detect_runtime()` creates a fresh runtime on every call, so instance-level
/// locking cannot prevent two threads from racing startup. This static mutex
/// ensures at most one thread starts the runtime at a time; the second thread
/// waits for the lock, then sees the runtime already running and returns immediately.
static ENSURE_READY_LOCK: Mutex<()> = Mutex::new(());

/// Acquires the global `ENSURE_READY_LOCK` and runs `f` under it.
///
/// All `ContainerRuntime::ensure_ready()` implementations delegate to this
/// function so that concurrent callers are serialized regardless of which
/// runtime variant they hold.
pub(crate) fn with_ensure_ready_lock<F, R>(f: F) -> R
where
    F: FnOnce() -> R,
{
    let _guard = ENSURE_READY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    f()
}

pub(crate) trait ContainerRuntime: Send + Sync {
    fn compose_up(&self, project: &str) -> anyhow::Result<()>;
    fn compose_down(&self, project: &str) -> anyhow::Result<()>;
    fn compose_ps(&self, project: &str) -> anyhow::Result<Vec<Value>>;
    /// Returns a Command for interactive exec (TTY allocated, suitable for TUI apps).
    /// Caller should run `.status()` to inherit the terminal.
    fn container_exec(&self, container: &str, cmd: &[&str]) -> Command;
    /// Returns a Command for piped exec (no TTY, suitable for Stdio::piped()).
    /// Caller should set `.stdin(Stdio::piped()).stdout(Stdio::piped())`.
    ///
    /// Returns `Result` so implementations can check preconditions (e.g. Lima
    /// VM running) before constructing the command.
    fn container_exec_piped(&self, container: &str, cmd: &[&str]) -> anyhow::Result<Command>;
    /// Returns `true` only if the runtime is already operational (binary present,
    /// VM/engine running). This is a lightweight, read-only probe — it does **not**
    /// attempt to start or repair the runtime.
    ///
    /// Use this for status displays and optional optimisations. **Do not** use as a
    /// gate before [`ensure_ready`] — a stopped Lima VM returns `false` here but
    /// `ensure_ready()` can start it successfully.
    fn is_available(&self) -> bool;

    /// `true` if the VM / WSL distro exists, regardless of running state.
    /// Used by `is_setup_complete` to detect external removal.
    ///
    /// WSL uses the default impl: `is_available` already checks `wsl --list`
    /// (registration, not running). Lima overrides because its `is_available`
    /// requires `Status == Running`.
    fn is_installed(&self) -> bool {
        self.is_available()
    }

    /// Brings the runtime to a fully operational state, or returns a descriptive error.
    ///
    /// Safe to call unconditionally before any runtime operation. Implementations
    /// may start a stopped VM, verify engine health, etc. Prefer this over
    /// [`is_available`] whenever you need the runtime to become operational.
    fn ensure_ready(&self) -> anyhow::Result<()>;
    fn build_image(
        &self,
        tag: &str,
        context_dir: &str,
        containerfile: &str,
        build_args: &[(&str, &str)],
    ) -> anyhow::Result<()>;
    /// Translates a host build-root path into one accessible by the container engine.
    ///
    /// Lima override: copies to `~/.speedwave/build-cache/` when outside `~` (VM only mounts `~`).
    /// WSL override: converts `C:\…` → `/mnt/c/…`.
    ///
    /// Both supported runtimes mediate via a VM, so no default identity
    /// pass-through is provided — every impl MUST translate the path.
    fn prepare_build_context(
        &self,
        build_root: &std::path::Path,
    ) -> anyhow::Result<std::path::PathBuf>;
    fn container_logs(&self, container: &str, tail: u32) -> anyhow::Result<String>;
    fn compose_logs(&self, project: &str, tail: u32) -> anyhow::Result<String>;
    /// Returns `true` if the given image tag exists in the container runtime.
    fn image_exists(&self, tag: &str) -> anyhow::Result<bool>;
    /// Recreates all containers using `--force-recreate --remove-orphans`.
    fn compose_up_recreate(&self, project: &str) -> anyhow::Result<()>;

    /// Validates compose.yml as the container engine sees it. Every impl MUST
    /// run the engine's `compose config` so a silent no-op cannot mask a torn
    /// or invalid compose file.
    fn compose_validate(&self, project: &str) -> anyhow::Result<()>;

    /// Removes dangling images and build cache (not tagged images).
    ///
    /// Used by `build_images_for_bundle` to recover from stale overlayfs snapshotter
    /// state on containerd (containerd bug — "failed to rename:
    /// file exists" during layer extraction). Only removes dangling
    /// (untagged) images and build cache, so successfully-built tagged
    /// images survive a partial-build retry.
    ///
    /// This bug affects all containerd overlayfs setups, including Lima VM
    /// (LimaRuntime) and WSL2 (WslRuntime). Every impl MUST run
    /// `nerdctl system prune --force` — a silent no-op would leave the stale
    /// snapshotter state in place and re-trigger the rename failure.
    fn system_prune(&self) -> anyhow::Result<()>;

    /// Remove image tags. `force=true` = `rmi --force` (used by
    /// `prune_old_bundle_images` and plugin-uninstall).
    fn remove_images(&self, tags: &[String], force: bool) -> anyhow::Result<()> {
        let _ = (tags, force);
        log::debug!("remove_images: not implemented for this runtime, skipping");
        Ok(())
    }

    /// Removes BuildKit build cache.
    ///
    /// BuildKit cache mounts (`--mount=type=cache`) are stored separately
    /// from container images and are not affected by `remove_images()` or
    /// `system_prune()`. This method runs `nerdctl builder prune --all --force`
    /// to reclaim that space.
    ///
    /// Called by `prune_old_bundle_images()` after removing old tagged images,
    /// before building new ones for the updated bundle.
    fn prune_buildkit_cache(&self) -> anyhow::Result<()> {
        log::debug!("prune_buildkit_cache: not implemented for this runtime, skipping");
        Ok(())
    }

    /// Aggressive prune: removes ALL tagged images not used by a running
    /// container, plus BuildKit cache. Recovery path for disk-full build
    /// failures — frees images left behind by other worktrees / older bundles
    /// that `prune_old_bundle_images` cannot see (it only knows this worktree's
    /// last `applied_bundle_id`).
    ///
    /// Safe because containerd refuses to remove images backing live
    /// containers. Running Speedwave projects survive.
    fn prune_unused_images(&self) -> anyhow::Result<()> {
        log::debug!("prune_unused_images: not implemented for this runtime, skipping");
        Ok(())
    }

    /// Restarts the container engine (containerd + buildkitd) and waits for readiness.
    ///
    /// Implementations MUST restart containerd, MUST restart buildkit (skip
    /// `systemctl restart buildkit` only if the unit does not exist), and MUST
    /// wait for both `nerdctl info` and `buildctl debug workers` to succeed.
    /// `buildctl` is part of the nerdctl-full bundle and must be available in
    /// all environments.
    ///
    /// Only safe to call when no containers are running (e.g. during initial
    /// setup). Call-sites with running containers should propagate the error
    /// with diagnostic hints instead.
    ///
    /// Every impl MUST perform the restart — a silent no-op would report
    /// "engine restarted" to a caller recovering from a containerd hang.
    fn restart_container_engine(&self) -> anyhow::Result<()>;

    /// Stops the underlying VM (e.g. Lima on macOS) to free reserved RAM.
    ///
    /// Default is a no-op. Windows (WSL2) has a distro managed by Speedwave, but
    /// stopping it mid-session is not meaningful — use `reset_vm()` for destructive
    /// teardown instead. Only `LimaRuntime` overrides this method.
    ///
    /// Callers MUST treat errors as non-fatal: log them and continue. Exit
    /// cleanup must never block app termination on a VM stop failure.
    fn stop_vm(&self) -> anyhow::Result<()> {
        Ok(())
    }

    /// Tears down the underlying VM/distro destructively (e.g.
    /// `wsl --unregister` on Windows). Default is a no-op; only
    /// `WslRuntime` overrides — for `LimaRuntime`, factory-reset
    /// destroys the VM directly via `limactl stop` + `delete --force`,
    /// not through this method.
    ///
    /// Callers MUST treat errors as non-fatal: log and continue, because
    /// factory-reset's primary remediation (data-dir wipe) must still
    /// proceed if VM removal fails.
    fn reset_vm(&self) -> anyhow::Result<()> {
        Ok(())
    }

    /// Executes a command **inside the VM (not a container)** and returns its
    /// stdout + status. Used by host-side helpers that need the VM's network
    /// stack — most notably the LLM discovery probe, which must run from
    /// inside the VM to reach corporate-VPN-protected services (the host
    /// often cannot, see `docs/architecture/platform-matrix.md`).
    ///
    /// - macOS: `limactl shell <vm> -- <cmd> <args...>`
    /// - Windows: `wsl.exe -d <distro> -- <cmd> <args...>`
    ///
    /// `stdin` is fed to the command (empty slice for none). `timeout`
    /// bounds the whole operation. Returns `Err` if the VM is not running
    /// — callers that need a fallback should check `is_available()` first.
    fn vm_exec(
        &self,
        cmd: &str,
        args: &[&str],
        stdin: &[u8],
        timeout: std::time::Duration,
    ) -> anyhow::Result<VmExecOutput> {
        let _ = (cmd, args, stdin, timeout);
        anyhow::bail!("vm_exec not implemented for this runtime");
    }
}

/// Output of a [`ContainerRuntime::vm_exec`] call.
#[derive(Debug, Clone)]
pub struct VmExecOutput {
    /// Process exit status.
    pub status: std::process::ExitStatus,
    /// Captured stdout bytes.
    pub stdout: Vec<u8>,
    /// Captured stderr bytes.
    pub stderr: Vec<u8>,
}

impl VmExecOutput {
    /// `true` if the process exited successfully.
    pub fn ok(&self) -> bool {
        self.status.success()
    }
    /// stdout as a lossy UTF-8 string.
    pub fn stdout_str(&self) -> std::borrow::Cow<'_, str> {
        String::from_utf8_lossy(&self.stdout)
    }
    /// stderr as a lossy UTF-8 string.
    pub fn stderr_str(&self) -> std::borrow::Cow<'_, str> {
        String::from_utf8_lossy(&self.stderr)
    }
}

/// Shared implementation of `vm_exec` for both `LimaRuntime` and `WslRuntime`.
/// Spawns the prepared command, pipes `stdin`, waits with a timeout, captures
/// stdout+stderr. Kills the child on timeout.
pub(crate) fn vm_exec_run(
    mut command: Command,
    stdin: &[u8],
    timeout: std::time::Duration,
) -> anyhow::Result<VmExecOutput> {
    use std::io::{Read, Write};
    use std::process::Stdio;
    use std::sync::mpsc;
    use std::thread;

    command.stdin(Stdio::piped());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    let program = command.get_program().to_string_lossy().into_owned();
    let mut child = command.spawn()?;

    // Feed stdin (or close it immediately).
    if let Some(mut sink) = child.stdin.take() {
        if !stdin.is_empty() {
            sink.write_all(stdin)?;
        }
        // Dropping `sink` closes the pipe — sends EOF to the child.
    }

    // Drain stdout/stderr in background threads to avoid pipe-buffer deadlock
    // when output exceeds the OS pipe capacity (~64 KiB on macOS).
    let Some(mut out_pipe) = child.stdout.take() else {
        anyhow::bail!("vm_exec: stdout pipe missing on '{program}'");
    };
    let Some(mut err_pipe) = child.stderr.take() else {
        anyhow::bail!("vm_exec: stderr pipe missing on '{program}'");
    };
    let (out_tx, out_rx) = mpsc::channel::<Vec<u8>>();
    let (err_tx, err_rx) = mpsc::channel::<Vec<u8>>();
    let out_thread = thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = out_pipe.read_to_end(&mut buf);
        let _ = out_tx.send(buf);
    });
    let err_thread = thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = err_pipe.read_to_end(&mut buf);
        let _ = err_tx.send(buf);
    });

    // Wait with timeout, killing the child if it overruns.
    let start = std::time::Instant::now();
    let status = loop {
        match child.try_wait()? {
            Some(s) => break s,
            None => {
                if start.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = out_thread.join();
                    let _ = err_thread.join();
                    anyhow::bail!(
                        "vm_exec: '{}' timed out after {}s",
                        program,
                        timeout.as_secs()
                    );
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
        }
    };

    let _ = out_thread.join();
    let _ = err_thread.join();
    let stdout = out_rx.recv().unwrap_or_default();
    let stderr = err_rx.recv().unwrap_or_default();
    Ok(VmExecOutput {
        status,
        stdout,
        stderr,
    })
}

/// Runs external commands; abstracted so tests can inject a fake.
pub trait CommandRunner: Send + Sync {
    /// Runs `cmd args`, returning trimmed stdout on success.
    fn run(&self, cmd: &str, args: &[&str]) -> anyhow::Result<String>;

    /// Like `run`, but merges stdout and stderr on success.
    ///
    /// `nerdctl logs` writes container output to stderr,
    /// so the standard `run()` (which returns only stdout) would return
    /// an empty string. This method captures both streams.
    ///
    /// Default implementation delegates to `run()` so that existing
    /// `CommandRunner` implementations (including mocks) work unchanged.
    fn run_with_stderr(&self, cmd: &str, args: &[&str]) -> anyhow::Result<String> {
        self.run(cmd, args)
    }

    /// Like `run`, but returns raw stdout bytes without UTF-8 conversion.
    /// Needed for commands like `wsl.exe --list` that output UTF-16LE.
    fn run_raw_stdout(&self, cmd: &str, args: &[&str]) -> anyhow::Result<Vec<u8>> {
        // Default: delegate to run() and return as UTF-8 bytes
        self.run(cmd, args).map(|s| s.into_bytes())
    }

    /// Like `run`, but kills the process if it exceeds `timeout`.
    ///
    /// Captures stderr so that failure diagnostics (e.g. from `limactl start`)
    /// appear in the Tauri log, not just in the parent's terminal streams.
    /// Stdout is inherited (goes to parent streams). Stderr is read after the
    /// process exits — safe because the pipe buffer (64 KB) is more than enough
    /// for diagnostic output from lifecycle commands.
    ///
    /// # Pipe buffer safety
    ///
    /// Only use for commands that produce limited stderr (lifecycle commands
    /// like `limactl start`, `systemctl start`, etc.). If stderr exceeds the
    /// OS pipe buffer (64 KB on Linux/macOS), the child process will block on
    /// write and never exit, causing a deadlock. For commands with verbose
    /// output, use `run()` or `run_with_stderr()` instead.
    ///
    /// Note: `binary::run_with_timeout` deliberately avoids `Stdio::piped()`
    /// for this reason. This method accepts the trade-off because capturing
    /// stderr diagnostics on failure is essential for Desktop log files.
    ///
    /// See also: `binary::run_with_timeout` (same poll/kill loop, no capture).
    /// Unlike `binary::run_with_timeout` which returns `Ok(ExitStatus)` and
    /// leaves exit-code handling to the caller, this method treats non-zero
    /// exit as `Err`.
    fn run_with_timeout(
        &self,
        cmd: &str,
        args: &[&str],
        timeout: std::time::Duration,
    ) -> anyhow::Result<()> {
        let mut command = binary::command(cmd);
        command.args(args);
        command.stderr(std::process::Stdio::piped());

        let program = command.get_program().to_string_lossy().to_string();
        let mut child = command.spawn()?;
        let start = std::time::Instant::now();
        loop {
            match child.try_wait()? {
                Some(status) => {
                    if status.success() {
                        return Ok(());
                    }
                    let stderr = child
                        .stderr
                        .take()
                        .map(|mut s| {
                            let mut buf = String::new();
                            std::io::Read::read_to_string(&mut s, &mut buf).ok();
                            buf
                        })
                        .unwrap_or_default();
                    let detail = stderr.trim();
                    if detail.is_empty() {
                        anyhow::bail!("{} failed with exit code {:?}", program, status.code());
                    } else {
                        anyhow::bail!(
                            "{} failed with exit code {:?}: {}",
                            program,
                            status.code(),
                            detail
                        );
                    }
                }
                None => {
                    if start.elapsed() >= timeout {
                        if let Err(e) = child.kill() {
                            log::warn!("run_with_timeout: kill failed: {e}");
                        }
                        let _ = child.wait();
                        anyhow::bail!(
                            "command '{}' timed out after {}s",
                            program,
                            timeout.as_secs()
                        );
                    }
                    std::thread::sleep(std::time::Duration::from_millis(200));
                }
            }
        }
    }
}

/// Production [`CommandRunner`] that spawns real processes.
pub struct RealRunner;

/// Combines two output streams, returning whichever is non-empty (or both joined by newline).
fn combine_outputs(primary: &str, secondary: &str) -> String {
    if secondary.trim().is_empty() {
        primary.to_string()
    } else if primary.trim().is_empty() {
        secondary.to_string()
    } else {
        format!("{}\n{}", primary.trim(), secondary.trim())
    }
}

impl RealRunner {
    /// Creates a `Command` with the resolved binary, `LIMA_HOME` (for limactl), and args applied.
    fn prepare_command(cmd: &str, args: &[&str]) -> Command {
        let mut command = binary::command(cmd);
        command.args(args);
        command
    }
}

impl CommandRunner for RealRunner {
    fn run(&self, cmd: &str, args: &[&str]) -> anyhow::Result<String> {
        let output = Self::prepare_command(cmd, args).output()?;
        if output.status.success() {
            Ok(String::from_utf8_lossy(&output.stdout).to_string())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            anyhow::bail!("{} failed: {}", cmd, combine_outputs(&stderr, &stdout));
        }
    }

    fn run_with_stderr(&self, cmd: &str, args: &[&str]) -> anyhow::Result<String> {
        let output = Self::prepare_command(cmd, args).output()?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        if output.status.success() {
            Ok(combine_outputs(&stdout, &stderr))
        } else {
            anyhow::bail!("{} failed: {}", cmd, combine_outputs(&stderr, &stdout));
        }
    }

    fn run_raw_stdout(&self, cmd: &str, args: &[&str]) -> anyhow::Result<Vec<u8>> {
        let output = Self::prepare_command(cmd, args).output()?;
        if output.status.success() {
            Ok(output.stdout)
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            anyhow::bail!("{} failed: {}", cmd, combine_outputs(&stderr, &stdout));
        }
    }
}

/// Parses `compose ps --format json` output.
///
/// Handles both JSON array (`[{...},{...}]`) and NDJSON (`{...}\n{...}`) formats
/// because nerdctl may emit JSON array or NDJSON depending on version.
pub fn parse_compose_ps_json(output: &str) -> Vec<Value> {
    let trimmed = output.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    if trimmed.starts_with('[') {
        serde_json::from_str(trimmed).unwrap_or_default()
    } else {
        trimmed
            .lines()
            .filter(|line| !line.trim().is_empty())
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect()
    }
}

/// Parses a semver triple from a version string.
///
/// Handles formats like `"nerdctl version 2.0.3"`, `"limactl version 1.2.3"`,
/// or a bare `"2.0.3"`. Returns `(major, minor, patch)` or `None` if unparseable.
pub fn parse_version(version_output: &str) -> Option<(u32, u32, u32)> {
    let version_str = version_output
        .split_whitespace()
        .find(|s| s.chars().next().is_some_and(|c| c.is_ascii_digit()))?;
    let parts: Vec<&str> = version_str.split('.').collect();
    if parts.len() >= 3 {
        Some((
            parts[0].parse().ok()?,
            parts[1].parse().ok()?,
            parts[2].parse().ok()?,
        ))
    } else if parts.len() == 2 {
        Some((parts[0].parse().ok()?, parts[1].parse().ok()?, 0))
    } else {
        None
    }
}

/// Returns the path to the compose file for a given project.
///
/// Layout: `~/.speedwave/compose/<project>/compose.yml`
pub fn compose_file_path(project: &str) -> anyhow::Result<String> {
    let path = consts::data_dir()
        .join("compose")
        .join(project)
        .join("compose.yml");
    Ok(path.to_string_lossy().to_string())
}

/// Testable variant: resolves compose file path under an explicit data directory.
#[cfg(test)]
fn compose_file_path_in(data_dir: &std::path::Path, project: &str) -> String {
    data_dir
        .join("compose")
        .join(project)
        .join("compose.yml")
        .to_string_lossy()
        .to_string()
}

pub(crate) fn configured_project_container_names(project: &str) -> Vec<String> {
    let compose_file = match compose_file_path(project) {
        Ok(path) => path,
        Err(e) => {
            log::debug!(
                "configured_project_container_names: compose path unavailable for {project}: {e}"
            );
            return Vec::new();
        }
    };

    let compose_yml = match std::fs::read_to_string(&compose_file) {
        Ok(yaml) => yaml,
        Err(e) => {
            log::debug!(
                "configured_project_container_names: compose file unreadable for {project}: {e}"
            );
            return Vec::new();
        }
    };

    container_names_from_compose_yaml(&compose_yml)
}

fn container_names_from_compose_yaml(compose_yml: &str) -> Vec<String> {
    let doc: serde_yaml_ng::Value = match serde_yaml_ng::from_str(compose_yml) {
        Ok(doc) => doc,
        Err(e) => {
            log::debug!("container_names_from_compose_yaml: invalid compose YAML: {e}");
            return Vec::new();
        }
    };

    doc.get("services")
        .and_then(|services| services.as_mapping())
        .map(|services| {
            let mut container_names: Vec<String> = services
                .values()
                .filter_map(|service| {
                    service
                        .get("container_name")
                        .and_then(|value| value.as_str())
                        .map(ToString::to_string)
                })
                .collect();
            container_names.sort();
            container_names
        })
        .unwrap_or_default()
}

fn push_unique_target(targets: &mut Vec<String>, target: String) {
    if !targets.contains(&target) {
        targets.push(target);
    }
}

pub(crate) fn cleanup_targets_from_ps_output(ps_output: &str) -> Vec<String> {
    let mut targets = Vec::new();

    for id in ps_output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        push_unique_target(&mut targets, id.to_string());
    }

    targets
}

/// Runs `nerdctl rm -f [--time=0] <targets...>` through the supplied runner.
/// `force_kill` toggles `--time=0` so callers can escalate to a hard kill
/// (skip the graceful SIGTERM/SIGKILL window) without duplicating the argv
/// plumbing. WSL/tests always pass `false`; Lima passes `true` on the final
/// retry attempt.
pub(crate) fn run_rm_force(
    runner: &dyn CommandRunner,
    cmd: &str,
    nerdctl_prefix: &[&str],
    targets: &[String],
    force_kill: bool,
) -> anyhow::Result<()> {
    if targets.is_empty() {
        return Ok(());
    }

    let mut rm_args: Vec<&str> = nerdctl_prefix.to_vec();
    rm_args.extend_from_slice(&["rm", "-f"]);
    if force_kill {
        rm_args.push("--time=0");
    }
    for target in targets {
        rm_args.push(target.as_str());
    }
    runner.run(cmd, &rm_args).map(|_| ())
}

/// Returns `true` if the message indicates the container does not exist.
/// Single source of truth for missing-container error patterns.
/// Note: `probe_container_exec` runs `nerdctl exec`, so these
/// messages always refer to containers, not images.
fn is_missing_container_error_msg(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("no such")
        || lower.contains("not found")
        || lower.contains("does not exist")
        || lower.contains("not exist")
}

pub(crate) fn is_missing_container_error(err: &anyhow::Error) -> bool {
    is_missing_container_error_msg(&err.to_string())
}

/// Returns `true` if the error indicates broken container mount namespaces,
/// typically after macOS sleep/resume invalidating Lima VM overlayfs state.
///
/// After VM suspend/resume, virtiofs/9p mounts become stale while containers
/// remain "running" in containerd state.  runc's `verifyCwd()` security check
/// (CVE-2024-21626) detects the broken namespace and produces this error.
fn is_stale_container_error(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("mount namespace root") || lower.contains("container breakout detected")
}

/// Returns `true` if the error indicates the container exists but is not
/// running (Exited/Created state).  containerd/nerdctl emits this when
/// `nerdctl exec` is invoked against a container that has stopped after
/// `compose up` (e.g. its entrypoint exited non-zero, or a previous
/// interactive session ended and `compose up` left it in place without
/// restarting it).  Recreate restores the container to a running state.
fn is_stopped_container_error(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("cannot exec in a stopped state")
}

/// POSIX-shell-quotes each argument and joins with spaces — for transports
/// that re-evaluate the command line through a remote shell (`ssh`, `wsl.exe`,
/// `limactl shell`).
///
/// Without this, arguments containing `(`, `)`, `'`, `` ` ``, `$`, newlines,
/// etc. would break remote bash with `syntax error near unexpected token`.
/// Using `shlex::try_quote` per arg yields a string that any POSIX shell
/// parses back into the original argv.
pub(crate) fn shell_quote_argv(argv: &[&str]) -> String {
    argv.iter()
        .map(|a| match shlex::try_quote(a) {
            Ok(quoted) => quoted.into_owned(),
            // `shlex::try_quote` only fails on null bytes, which can't
            // legitimately appear in argv (the OS rejects them at execve).
            // If one ever slips through anyway, drop it from the quoted
            // string and log — silently truncating at the null would break
            // the remote command in subtler ways.
            Err(_) => {
                log::error!(
                    "shell_quote_argv: argv token contains a null byte; stripping nulls before quoting"
                );
                let stripped = a.replace('\0', "");
                shlex::try_quote(stripped.as_str())
                    .map(|s| s.into_owned())
                    .unwrap_or(stripped)
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Probes whether `nerdctl exec` works on the given container by running a
/// trivial command (`true`).  Returns `Ok(())` on success, or the stderr
/// content as an error.
fn probe_container_exec(runtime: &LockedRuntime, container: &str) -> anyhow::Result<()> {
    let mut cmd = runtime.container_exec_piped(container, &["true"])?;
    let output = cmd.output()?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("{}", stderr.trim())
    }
}

/// Verifies container exec is functional.  Recovers from three failure modes:
///
/// 1. **Stale containers** — mount namespaces broken after macOS sleep/resume.
/// 2. **Missing containers** — containers lost after containerd restart, VM
///    recreation, or image loss.
/// 3. **Stopped containers** — container exists but is in Exited/Created
///    state; `compose up` left it in place because its config did not change.
///
/// In all cases, calls `compose_up_recreate` and re-probes once.
///
/// Call this between `compose_up()` and the real `container_exec()` to
/// transparently recover from container failures.
/// Logs each container's name + state from `compose_ps`. Called on the recovery
/// path so a "cannot exec in a stopped state" failure records which containers
/// were actually up vs stopped/created — the difference between a crashed
/// entrypoint and a container that never started.
fn log_container_states(runtime: &LockedRuntime, project: &str, when: &str) {
    match runtime.compose_ps(project) {
        Ok(rows) => {
            let states: Vec<String> = rows
                .iter()
                .map(|r| {
                    let name = r.get("Name").and_then(|v| v.as_str()).unwrap_or("?");
                    let state = r
                        .get("State")
                        .and_then(|v| v.as_str())
                        .or_else(|| r.get("Status").and_then(|v| v.as_str()))
                        .unwrap_or("?");
                    format!("{name}={state}")
                })
                .collect();
            log::info!(
                "ensure_exec_healthy[{when}]: states=[{}]",
                states.join(", ")
            );
        }
        Err(e) => log::info!("ensure_exec_healthy[{when}]: compose_ps failed: {e}"),
    }
}

/// Probes a container until it can run an exec, surfacing health failures.
pub fn ensure_exec_healthy(
    runtime: &LockedRuntime,
    project: &str,
    container: &str,
) -> anyhow::Result<()> {
    log::info!("ensure_exec_healthy: probing '{container}'");
    match probe_container_exec(runtime, container) {
        Ok(()) => {
            log::info!("ensure_exec_healthy: '{container}' is healthy");
            return Ok(());
        }
        Err(e) => {
            let msg = e.to_string();
            if is_stale_container_error(&msg) {
                log::warn!(
                    "Stale container detected for '{container}' \
                     (mount namespace broken after sleep/resume). \
                     Force-recreating containers..."
                );
            } else if is_missing_container_error_msg(&msg) {
                log::warn!(
                    "Container '{container}' not found. \
                     Recreating containers..."
                );
            } else if is_stopped_container_error(&msg) {
                log::warn!(
                    "Container '{container}' is stopped (previous run \
                     exited). Recreating containers..."
                );
            } else {
                return Err(e);
            }
        }
    }
    runtime.compose_up_recreate(project).map_err(|e| {
        let msg = e.to_string().to_ascii_lowercase();
        if msg.contains("no such image") || msg.contains("image not found") {
            anyhow::anyhow!(
                "Container images are missing — restarting the app \
                 will trigger an automatic rebuild. ({e})"
            )
        } else {
            anyhow::anyhow!(
                "Container recovery failed: {e}. \
                 Please restart Speedwave."
            )
        }
    })?;
    log_container_states(runtime, project, "after-recovery");
    probe_container_exec(runtime, container).map_err(|e| {
        anyhow::anyhow!(
            "Containers still broken after recovery: {e}. \
             Please restart Speedwave."
        )
    })
}

/// Max `compose_validate` attempts. Backoff 100/200/400/800/1600 ms between
/// them — ~3.1 s total window for the guest to see the host write through
/// virtiofs. 300 ms (the old 3-attempt window) was too short under load.
const COMPOSE_VALIDATE_MAX_ATTEMPTS: u32 = 6;

/// Backoff cap so a higher attempt count cannot explode the delay.
const COMPOSE_VALIDATE_MAX_DELAY_MS: u64 = 1600;

/// Retries `compose_validate` (guest-side `nerdctl compose config`) with capped
/// exponential backoff on `is_propagation_error` — virtiofs/9p mount lag where
/// the VM still sees the pre-write compose.yml after the host already wrote it.
pub fn compose_validate_with_retry(runtime: &LockedRuntime, project: &str) -> anyhow::Result<()> {
    let mut delay_ms: u64 = 100;
    for attempt in 0..COMPOSE_VALIDATE_MAX_ATTEMPTS {
        match runtime.compose_validate(project) {
            Ok(()) => return Ok(()),
            Err(e) => {
                let is_last = attempt + 1 == COMPOSE_VALIDATE_MAX_ATTEMPTS;
                if is_last || !is_propagation_error(&e) {
                    return Err(e);
                }
                log::warn!(
                    "compose_validate attempt {}: {e} — retrying after {} ms",
                    attempt + 1,
                    delay_ms
                );
                std::thread::sleep(std::time::Duration::from_millis(delay_ms));
                delay_ms = (delay_ms * 2).min(COMPOSE_VALIDATE_MAX_DELAY_MS);
            }
        }
    }
    unreachable!("loop body always returns on the final attempt")
}

/// Heuristic: error looks like virtiofs/9p propagation lag (compose engine
/// sees stale or partial file).
fn is_propagation_error(e: &anyhow::Error) -> bool {
    let s = e.to_string().to_lowercase();
    s.contains(crate::compose::UNDEFINED_NETWORK_ERROR_FRAGMENT)
        || s.contains(crate::compose::INVALID_COMPOSE_PROJECT_ERROR_FRAGMENT)
        || crate::compose::COMPOSE_SCHEMA_VALIDATION_ERROR_FRAGMENTS
            .iter()
            .any(|frag| s.contains(frag))
}

/// Shared `force_remove_project_containers` algorithm parameterised on a
/// remove closure so Lima can wrap each call in `retry_on_eof` (with `--time=0`
/// escalation on the final attempt) while WSL/tests call the runner directly.
///
/// Called after `compose down --remove-orphans` to work around a nerdctl bug
/// where ghost name-store entries survive and cause "name already used" on the
/// next `compose up`. The `rm` closure removes a batch of targets (best-effort;
/// it owns any retry policy). `nerdctl_prefix` is the command slice needed to
/// reach nerdctl (e.g. `&["shell", "speedwave", "--", "sudo", "nerdctl"]` for
/// Lima). Best-effort: failures are logged but never propagated.
pub(crate) fn force_remove_project_containers_with_run_fn<RmFn>(
    runner: &dyn CommandRunner,
    cmd: &str,
    project: &str,
    nerdctl_prefix: &[&str],
    rm: RmFn,
) where
    RmFn: Fn(&[String]) -> anyhow::Result<()>,
{
    let filter = format!("label=com.docker.compose.project={project}");
    let mut ps_args: Vec<&str> = nerdctl_prefix.to_vec();
    ps_args.extend_from_slice(&["ps", "-a", "--filter", &filter, "-q"]);

    let id_targets = match runner.run(cmd, &ps_args) {
        Ok(output) => cleanup_targets_from_ps_output(&output),
        Err(e) => {
            log::debug!("force_remove_project_containers: ps failed for {project}: {e}");
            Vec::new()
        }
    };
    let name_targets = configured_project_container_names(project);

    if id_targets.is_empty() && name_targets.is_empty() {
        return;
    }

    if !id_targets.is_empty() {
        log::info!(
            "force_remove_project_containers: removing {} stale container id(s) for {project}",
            id_targets.len()
        );
        if let Err(e) = rm(&id_targets) {
            log::warn!("force_remove_project_containers: rm -f by id failed for {project}: {e}");
        }
    }

    for container_name in &name_targets {
        let single_target = vec![container_name.clone()];
        match rm(&single_target) {
            Ok(()) => {}
            Err(e) if is_missing_container_error(&e) => {
                log::debug!(
                    "force_remove_project_containers: {project} target '{container_name}' already gone: {e}"
                );
            }
            Err(e) => {
                log::warn!(
                    "force_remove_project_containers: rm -f by name failed for {project} target '{container_name}': {e}"
                );
            }
        }
    }
}

/// WSL/test variant — each `rm -f` runs once (no `--time=0`), no retry.
#[cfg(any(target_os = "windows", test))]
pub(crate) fn force_remove_project_containers(
    runner: &dyn CommandRunner,
    cmd: &str,
    project: &str,
    nerdctl_prefix: &[&str],
) {
    force_remove_project_containers_with_run_fn(runner, cmd, project, nerdctl_prefix, |targets| {
        run_rm_force(runner, cmd, nerdctl_prefix, targets, false)
    });
}

/// Shared `force_remove_project_networks` algorithm parameterised on a run
/// closure so Lima can wrap each call in `retry_on_eof` while WSL/tests call
/// the runner directly. Containers must be removed first — nerdctl refuses to
/// drop a network with attached containers.
pub(crate) fn force_remove_project_networks_with_run_fn<F>(
    cmd: &str,
    project: &str,
    nerdctl_prefix: &[&str],
    run: F,
) where
    F: Fn(&str, &[&str]) -> anyhow::Result<String>,
{
    let filter = format!("label=com.docker.compose.project={project}");
    let mut ls_args: Vec<&str> = nerdctl_prefix.to_vec();
    ls_args.extend_from_slice(&["network", "ls", "--filter", &filter, "-q"]);

    let net_ids = match run(cmd, &ls_args) {
        Ok(output) => cleanup_targets_from_ps_output(&output),
        Err(e) => {
            log::warn!(
                "force_remove_project_networks: ls failed for {project}: {e} \
                 — orphan networks may block next compose_up"
            );
            return;
        }
    };
    if net_ids.is_empty() {
        return;
    }

    log::info!(
        "force_remove_project_networks: removing {} network(s) for {project}",
        net_ids.len()
    );
    for net_id in &net_ids {
        let mut rm_args: Vec<&str> = nerdctl_prefix.to_vec();
        rm_args.extend_from_slice(&["network", "rm", net_id]);
        if let Err(e) = run(cmd, &rm_args) {
            log::warn!(
                "force_remove_project_networks: network rm {net_id} failed for {project}: {e}"
            );
        }
    }
}

/// WSL/test variant — runner called directly without retry.
#[cfg(any(target_os = "windows", test))]
pub(crate) fn force_remove_project_networks(
    runner: &dyn CommandRunner,
    cmd: &str,
    project: &str,
    nerdctl_prefix: &[&str],
) {
    force_remove_project_networks_with_run_fn(cmd, project, nerdctl_prefix, |c, a| {
        runner.run(c, a)
    });
}

/// Runs `compose down` and then best-effort cleanup of any stale container
/// and network entries for the project, even if `compose down` itself fails.
#[cfg(any(target_os = "windows", test))]
pub(crate) fn compose_down_and_cleanup(
    runner: &dyn CommandRunner,
    cmd: &str,
    project: &str,
    compose_down_args: &[&str],
    nerdctl_prefix: &[&str],
) -> anyhow::Result<()> {
    let down_result = runner.run(cmd, compose_down_args);
    if let Err(ref e) = down_result {
        log::warn!("compose_down_and_cleanup: compose down failed for {project}: {e}");
    }

    force_remove_project_containers(runner, cmd, project, nerdctl_prefix);
    force_remove_project_networks(runner, cmd, project, nerdctl_prefix);
    down_result.map(|_| ())
}

/// SSOT entry point: the only way to obtain a runtime handle outside this
/// crate. Returns `LockedRuntime` so callers cannot bypass per-project locks.
pub fn detect_runtime() -> LockedRuntime {
    LockedRuntime::new(detect_runtime_inner())
}

pub(crate) fn detect_runtime_inner() -> Box<dyn ContainerRuntime> {
    #[cfg(target_os = "macos")]
    {
        Box::new(lima::LimaRuntime::new())
    }
    #[cfg(target_os = "windows")]
    {
        Box::new(wsl::WslRuntime::new())
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    compile_error!("Speedwave requires macOS or Windows");
}

/// Default `TERM` used when the host advertises nothing usable.
pub(crate) const FALLBACK_TERM: &str = "xterm-256color";

/// Builds the `TERM=<value>` arg for interactive `nerdctl exec`, propagating the
/// host terminal's real `TERM` so Claude Code can negotiate the keyboard protocol
/// (e.g. Shift+Enter). Falls back to `xterm-256color` when `TERM` is unset, empty,
/// or `dumb`.
pub(crate) fn resolved_term_env() -> String {
    let term = std::env::var("TERM")
        .ok()
        .filter(|t| !t.is_empty() && t != "dumb")
        .unwrap_or_else(|| FALLBACK_TERM.to_string());
    format!("TERM={term}")
}

/// Test-only RAII guard: pins `TERM` to `value` and restores the prior value on
/// drop — even on panic/unwind. Pair with `#[serial_test::serial(env_term)]`.
#[cfg(test)]
pub(crate) struct TermGuard(Option<String>);

#[cfg(test)]
impl TermGuard {
    pub(crate) fn set(value: &str) -> Self {
        let prev = std::env::var("TERM").ok();
        std::env::set_var("TERM", value);
        Self(prev)
    }
}

#[cfg(test)]
impl Drop for TermGuard {
    fn drop(&mut self) {
        match &self.0 {
            Some(v) => std::env::set_var("TERM", v),
            None => std::env::remove_var("TERM"),
        }
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::CommandRunner;

    /// Verifies `remote_cmd` is a valid POSIX shell command by round-tripping
    /// through `shlex::split` and asserting the parsed argv equals `expected_argv`.
    /// Shared by the lima/wsl transport tests.
    ///
    /// We deliberately do NOT spawn `bash -n` even though it would be the
    /// canonical syntax check: Git Bash on `windows-latest` corrupts multi-byte
    /// UTF-8 in command-line args/scripts (Git for Windows / claude-code#31295).
    /// A pure-Rust roundtrip via the same `shlex` crate that produced the quoting
    /// is the lossless, platform-independent equivalent.
    pub(crate) fn assert_quoting_roundtrips(
        remote_cmd: &str,
        expected_argv: &[&str],
        variant: &str,
    ) {
        let parsed = shlex::split(remote_cmd).unwrap_or_else(|| {
            panic!("shlex::split rejected {variant} remote_cmd built from {expected_argv:?} → {remote_cmd:?}")
        });
        assert_eq!(
            parsed, expected_argv,
            "{variant} remote_cmd did not round-trip: input argv != reparsed argv\n\
             remote_cmd: {remote_cmd:?}",
        );
    }

    pub struct MockRunner {
        pub responses: std::collections::HashMap<String, anyhow::Result<String>>,
        pub raw_responses: std::collections::HashMap<String, anyhow::Result<Vec<u8>>>,
    }

    impl MockRunner {
        pub fn new() -> Self {
            Self {
                responses: std::collections::HashMap::new(),
                raw_responses: std::collections::HashMap::new(),
            }
        }

        pub fn with_response(mut self, key: &str, response: &str) -> Self {
            self.responses
                .insert(key.to_string(), Ok(response.to_string()));
            self
        }

        pub fn with_error(mut self, key: &str, msg: &str) -> Self {
            self.responses
                .insert(key.to_string(), Err(anyhow::anyhow!(msg.to_string())));
            self
        }

        pub fn with_raw_response(mut self, key: &str, bytes: Vec<u8>) -> Self {
            self.raw_responses.insert(key.to_string(), Ok(bytes));
            self
        }

        pub fn make_key(cmd: &str, args: &[&str]) -> String {
            format!("{} {}", cmd, args.join(" "))
        }
    }

    impl CommandRunner for MockRunner {
        fn run(&self, cmd: &str, args: &[&str]) -> anyhow::Result<String> {
            let key = Self::make_key(cmd, args);
            match self.responses.get(&key) {
                Some(Ok(val)) => Ok(val.clone()),
                Some(Err(e)) => Err(anyhow::anyhow!("{}", e)),
                None => Err(anyhow::anyhow!("unexpected command: {}", key)),
            }
        }

        fn run_raw_stdout(&self, cmd: &str, args: &[&str]) -> anyhow::Result<Vec<u8>> {
            let key = Self::make_key(cmd, args);
            // Check raw_responses first, fall back to run().into_bytes()
            if let Some(result) = self.raw_responses.get(&key) {
                return match result {
                    Ok(val) => Ok(val.clone()),
                    Err(e) => Err(anyhow::anyhow!("{}", e)),
                };
            }
            self.run(cmd, args).map(|s| s.into_bytes())
        }

        fn run_with_timeout(
            &self,
            cmd: &str,
            args: &[&str],
            _timeout: std::time::Duration,
        ) -> anyhow::Result<()> {
            self.run(cmd, args)?;
            Ok(())
        }
    }

    pub struct SequentialMockRunner {
        pub responses: std::sync::Mutex<std::collections::VecDeque<anyhow::Result<String>>>,
        pub calls: std::sync::Mutex<Vec<(String, Vec<String>, Option<std::time::Duration>)>>,
    }

    impl SequentialMockRunner {
        pub fn new(responses: Vec<anyhow::Result<String>>) -> Self {
            Self {
                responses: std::sync::Mutex::new(responses.into_iter().collect()),
                calls: std::sync::Mutex::new(Vec::new()),
            }
        }

        fn next_response(
            &self,
            cmd: &str,
            args: &[&str],
            timeout: Option<std::time::Duration>,
        ) -> anyhow::Result<String> {
            self.calls.lock().unwrap().push((
                cmd.to_string(),
                args.iter().map(|a| a.to_string()).collect(),
                timeout,
            ));
            self.responses
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_else(|| Err(anyhow::anyhow!("SequentialMockRunner: no more responses")))
        }
    }

    impl CommandRunner for SequentialMockRunner {
        fn run(&self, cmd: &str, args: &[&str]) -> anyhow::Result<String> {
            self.next_response(cmd, args, None)
        }

        fn run_with_timeout(
            &self,
            cmd: &str,
            args: &[&str],
            timeout: std::time::Duration,
        ) -> anyhow::Result<()> {
            self.next_response(cmd, args, Some(timeout)).map(|_| ())
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use crate::runtime::mock_runtime::MockRuntimeBuilder;
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    #[test]
    fn test_compose_file_path_format() {
        let dir = tempfile::tempdir().unwrap();
        let path = compose_file_path_in(dir.path(), "my-project");
        assert!(path.starts_with(&dir.path().to_string_lossy().to_string()));
        assert!(path.contains("compose"));
        assert!(path.contains("my-project"));
        assert!(path.ends_with("compose.yml"));
    }

    #[test]
    fn parse_json_array_from_nerdctl() {
        let input = r#"[{"Name":"speedwave_acme_mcp_hub","State":"running"},{"Name":"speedwave_acme_claude","State":"exited"}]"#;
        let result = parse_compose_ps_json(input);
        assert_eq!(result.len(), 2);
        assert_eq!(result[0]["Name"], "speedwave_acme_mcp_hub");
        assert_eq!(result[0]["State"], "running");
        assert_eq!(result[1]["Name"], "speedwave_acme_claude");
        assert_eq!(result[1]["State"], "exited");
    }

    #[test]
    fn parse_ndjson_format() {
        let input = "{\"Name\":\"hub\",\"Status\":\"Up 5 minutes\"}\n{\"Name\":\"slack\",\"Status\":\"Up 5 minutes\"}\n";
        let result = parse_compose_ps_json(input);
        assert_eq!(result.len(), 2);
        assert_eq!(result[0]["Name"], "hub");
        assert_eq!(result[1]["Name"], "slack");
    }

    #[test]
    fn parse_empty_output() {
        assert!(parse_compose_ps_json("").is_empty());
        assert!(parse_compose_ps_json("  \n  ").is_empty());
    }

    #[test]
    fn parse_empty_json_array() {
        assert!(parse_compose_ps_json("[]").is_empty());
    }

    #[test]
    fn parse_malformed_json_returns_empty() {
        assert!(parse_compose_ps_json("not json at all").is_empty());
    }

    #[test]
    fn parse_ndjson_skips_invalid_lines() {
        let input = "{\"Name\":\"hub\"}\ngarbage\n{\"Name\":\"slack\"}";
        let result = parse_compose_ps_json(input);
        assert_eq!(result.len(), 2);
        assert_eq!(result[0]["Name"], "hub");
        assert_eq!(result[1]["Name"], "slack");
    }

    #[test]
    fn parse_real_nerdctl_output() {
        // Real output from `limactl shell speedwave sudo nerdctl compose ps --format json`.
        // Since ADR-038 every worker listens on PORT_WORKER (3000); the test only
        // checks Name and State so the exact port is immaterial.
        let input = r#"[{"ID":"076c","Name":"speedwave_myproject_mcp_redmine","Image":"speedwave-mcp-redmine:latest","Command":"docker-entrypoint.sh node dist/index.js","Project":"myproject","Service":"mcp-redmine","State":"running","Health":"","ExitCode":0,"Publishers":[{"URL":"127.0.0.1","TargetPort":3000,"PublishedPort":3000,"Protocol":"tcp"}]},{"ID":"40c1","Name":"speedwave_myproject_claude","Image":"speedwave-claude:latest","Command":"/usr/local/bin/entrypoint.sh","Project":"myproject","Service":"claude","State":"exited","Health":"","ExitCode":1,"Publishers":[]}]"#;
        let result = parse_compose_ps_json(input);
        assert_eq!(result.len(), 2);
        assert_eq!(result[0]["Name"], "speedwave_myproject_mcp_redmine");
        assert_eq!(result[0]["State"], "running");
        assert_eq!(result[1]["Name"], "speedwave_myproject_claude");
        assert_eq!(result[1]["State"], "exited");
    }

    /// Verifies that the default `run_with_stderr` implementation delegates to `run`,
    /// so MockRunner (which only implements `run`) inherits the correct behavior.
    #[test]
    fn test_run_with_stderr_default_delegates_to_run() {
        struct StubRunner;
        impl CommandRunner for StubRunner {
            fn run(&self, _cmd: &str, _args: &[&str]) -> anyhow::Result<String> {
                Ok("from_run".to_string())
            }
            // run_with_stderr NOT overridden — uses default impl
        }

        let runner = StubRunner;
        let result = runner
            .run_with_stderr("echo", &["hello"])
            .expect("run_with_stderr");
        assert_eq!(
            result, "from_run",
            "default run_with_stderr should delegate to run()"
        );
    }

    /// Verifies that an implementor can override `run_with_stderr` independently of `run`.
    #[test]
    fn test_run_with_stderr_can_be_overridden() {
        struct MergedRunner;
        impl CommandRunner for MergedRunner {
            fn run(&self, _cmd: &str, _args: &[&str]) -> anyhow::Result<String> {
                Ok("stdout_only".to_string())
            }
            fn run_with_stderr(&self, _cmd: &str, _args: &[&str]) -> anyhow::Result<String> {
                Ok("stdout+stderr".to_string())
            }
        }

        let runner = MergedRunner;
        assert_eq!(runner.run("x", &[]).expect("run"), "stdout_only");
        assert_eq!(
            runner.run_with_stderr("x", &[]).expect("run_with_stderr"),
            "stdout+stderr"
        );
    }

    #[test]
    fn parse_version_full_semver() {
        assert_eq!(parse_version("nerdctl version 2.0.3"), Some((2, 0, 3)));
        assert_eq!(parse_version("limactl version 1.2.3"), Some((1, 2, 3)));
        assert_eq!(parse_version("2.0.3"), Some((2, 0, 3)));
    }

    #[test]
    fn parse_version_two_parts() {
        assert_eq!(parse_version("2.0"), Some((2, 0, 0)));
    }

    #[test]
    fn parse_version_returns_none_for_garbage() {
        assert_eq!(parse_version(""), None);
        assert_eq!(parse_version("no version here"), None);
        assert_eq!(parse_version("version"), None);
    }

    #[test]
    fn parse_version_returns_none_for_pre_release_suffix() {
        // "2.0.0-beta1" → patch part "0-beta1" fails to parse as u32 → None
        assert_eq!(parse_version("2.0.0-beta1"), None);
    }

    #[test]
    fn combine_outputs_primary_only() {
        assert_eq!(combine_outputs("hello", ""), "hello");
        assert_eq!(combine_outputs("hello", "  \n  "), "hello");
    }

    #[test]
    fn combine_outputs_secondary_only() {
        assert_eq!(combine_outputs("", "world"), "world");
        assert_eq!(combine_outputs("  ", "world"), "world");
    }

    #[test]
    fn combine_outputs_both_present() {
        assert_eq!(combine_outputs("hello", "world"), "hello\nworld");
    }

    #[test]
    fn combine_outputs_both_empty() {
        assert_eq!(combine_outputs("", ""), "");
    }

    #[test]
    fn test_run_raw_stdout_default_delegates_to_run() {
        struct StubRunner;
        impl CommandRunner for StubRunner {
            fn run(&self, _cmd: &str, _args: &[&str]) -> anyhow::Result<String> {
                Ok("from_run".to_string())
            }
            // run_raw_stdout NOT overridden — uses default impl
        }

        let runner = StubRunner;
        let result = runner
            .run_raw_stdout("echo", &["hello"])
            .expect("run_raw_stdout");
        assert_eq!(
            result, b"from_run",
            "default run_raw_stdout should delegate to run() and return bytes"
        );
    }

    #[test]
    fn test_mock_runner_raw_response_takes_priority() {
        let runner = test_support::MockRunner::new()
            .with_response("cmd --flag", "text_response")
            .with_raw_response("cmd --flag", vec![0xFF, 0xFE, 0x41, 0x00]);

        // run() returns text response
        assert_eq!(runner.run("cmd", &["--flag"]).unwrap(), "text_response");
        // run_raw_stdout() returns raw bytes (raw_response takes priority)
        assert_eq!(
            runner.run_raw_stdout("cmd", &["--flag"]).unwrap(),
            vec![0xFF, 0xFE, 0x41, 0x00]
        );
    }

    #[test]
    fn test_mock_runner_raw_fallback_to_run() {
        let runner = test_support::MockRunner::new().with_response("cmd --flag", "hello");

        // No raw_response set, so run_raw_stdout falls back to run().into_bytes()
        assert_eq!(
            runner.run_raw_stdout("cmd", &["--flag"]).unwrap(),
            b"hello".to_vec()
        );
    }

    #[test]
    fn test_container_names_from_compose_yaml_extracts_declared_names() {
        let compose_yml = r#"
services:
  claude:
    image: speedwave-claude:latest
    container_name: speedwave_tmp_claude
  mcp-hub:
    image: speedwave-mcp-hub:latest
    container_name: speedwave_tmp_mcp_hub
"#;

        assert_eq!(
            container_names_from_compose_yaml(compose_yml),
            vec![
                "speedwave_tmp_claude".to_string(),
                "speedwave_tmp_mcp_hub".to_string()
            ]
        );
    }

    #[test]
    fn test_cleanup_targets_from_ps_output_extracts_ids() {
        assert_eq!(
            cleanup_targets_from_ps_output("stale-id\nother-id\n"),
            vec!["stale-id".to_string(), "other-id".to_string()]
        );
    }

    #[test]
    fn test_compose_down_and_cleanup_runs_cleanup_after_down_failure() {
        struct RecordingRunner {
            commands: Arc<Mutex<Vec<String>>>,
            responses: HashMap<String, anyhow::Result<String>>,
        }

        impl CommandRunner for RecordingRunner {
            fn run(&self, cmd: &str, args: &[&str]) -> anyhow::Result<String> {
                let key = format!("{} {}", cmd, args.join(" "));
                self.commands.lock().unwrap().push(key.clone());
                match self.responses.get(&key) {
                    Some(Ok(val)) => Ok(val.clone()),
                    Some(Err(e)) => Err(anyhow::anyhow!("{e}")),
                    None => Err(anyhow::anyhow!("unexpected command: {key}")),
                }
            }
        }

        let commands = Arc::new(Mutex::new(Vec::new()));
        let compose_file = "/tmp/compose.yml";
        let project = "cleanup-down-error-test";
        let down_key = format!(
            "nerdctl compose -f {} -p {} down --remove-orphans",
            compose_file, project
        );
        let ps_key = format!(
            "nerdctl ps -a --filter label=com.docker.compose.project={} -q",
            project
        );
        let rm_key = "nerdctl rm -f stale-id".to_string();
        let net_ls_key = format!(
            "nerdctl network ls --filter label=com.docker.compose.project={} -q",
            project
        );

        let runner = RecordingRunner {
            commands: Arc::clone(&commands),
            responses: HashMap::from([
                (
                    down_key.clone(),
                    Err(anyhow::anyhow!("compose down failed")),
                ),
                (ps_key.clone(), Ok("stale-id\n".to_string())),
                (rm_key.clone(), Ok(String::new())),
                (net_ls_key.clone(), Ok(String::new())),
            ]),
        };

        let err = compose_down_and_cleanup(
            &runner,
            "nerdctl",
            project,
            &[
                "compose",
                "-f",
                compose_file,
                "-p",
                project,
                "down",
                "--remove-orphans",
            ],
            &[],
        )
        .unwrap_err();

        assert!(err.to_string().contains("compose down failed"));
        // Ordering invariant: down → ps → rm-containers → network-ls (and network-rm
        // would follow if ls returned IDs). Containers MUST be removed before networks
        // — nerdctl refuses network rm with attached containers.
        assert_eq!(
            commands.lock().unwrap().as_slice(),
            &[down_key, ps_key, rm_key, net_ls_key]
        );
    }

    #[test]
    fn force_remove_project_networks_runs_ls_then_rm_per_id() {
        struct RecordingRunner {
            commands: Arc<Mutex<Vec<String>>>,
            responses: HashMap<String, anyhow::Result<String>>,
        }
        impl CommandRunner for RecordingRunner {
            fn run(&self, cmd: &str, args: &[&str]) -> anyhow::Result<String> {
                let key = format!("{} {}", cmd, args.join(" "));
                self.commands.lock().unwrap().push(key.clone());
                self.responses
                    .get(&key)
                    .map(|r| match r {
                        Ok(v) => Ok(v.clone()),
                        Err(e) => Err(anyhow::anyhow!("{e}")),
                    })
                    .unwrap_or_else(|| Err(anyhow::anyhow!("unexpected: {key}")))
            }
        }

        let project = "net-multi";
        let commands = Arc::new(Mutex::new(Vec::new()));
        let ls_key = format!(
            "nerdctl network ls --filter label=com.docker.compose.project={} -q",
            project
        );
        let rm_a = "nerdctl network rm net-id-a".to_string();
        let rm_b = "nerdctl network rm net-id-b".to_string();

        let runner = RecordingRunner {
            commands: Arc::clone(&commands),
            responses: HashMap::from([
                (ls_key.clone(), Ok("net-id-a\nnet-id-b\n".to_string())),
                (rm_a.clone(), Ok(String::new())),
                (rm_b.clone(), Ok(String::new())),
            ]),
        };
        force_remove_project_networks(&runner, "nerdctl", project, &[]);
        assert_eq!(commands.lock().unwrap().as_slice(), &[ls_key, rm_a, rm_b]);
    }

    #[test]
    fn force_remove_project_networks_handles_empty_ls() {
        struct RecordingRunner {
            commands: Arc<Mutex<Vec<String>>>,
        }
        impl CommandRunner for RecordingRunner {
            fn run(&self, _: &str, args: &[&str]) -> anyhow::Result<String> {
                self.commands.lock().unwrap().push(args.join(" "));
                Ok(String::new())
            }
        }
        let commands = Arc::new(Mutex::new(Vec::new()));
        let runner = RecordingRunner {
            commands: Arc::clone(&commands),
        };
        force_remove_project_networks(&runner, "nerdctl", "empty-ls", &[]);
        let cmds = commands.lock().unwrap();
        assert_eq!(cmds.len(), 1, "empty ls → only one command (the ls itself)");
        assert!(cmds[0].contains("network ls"));
    }

    #[test]
    fn force_remove_project_networks_continues_after_rm_failure() {
        struct RecordingRunner {
            commands: Arc<Mutex<Vec<String>>>,
            fail_first_rm: std::sync::atomic::AtomicBool,
        }
        impl CommandRunner for RecordingRunner {
            fn run(&self, _: &str, args: &[&str]) -> anyhow::Result<String> {
                let cmd = args.join(" ");
                self.commands.lock().unwrap().push(cmd.clone());
                if cmd.contains("network ls") {
                    return Ok("a\nb\n".to_string());
                }
                if cmd.contains("network rm a")
                    && self
                        .fail_first_rm
                        .swap(false, std::sync::atomic::Ordering::SeqCst)
                {
                    return Err(anyhow::anyhow!("transient nerdctl error"));
                }
                Ok(String::new())
            }
        }
        let commands = Arc::new(Mutex::new(Vec::new()));
        let runner = RecordingRunner {
            commands: Arc::clone(&commands),
            fail_first_rm: std::sync::atomic::AtomicBool::new(true),
        };
        force_remove_project_networks(&runner, "nerdctl", "rm-fail", &[]);
        let cmds = commands.lock().unwrap();
        assert!(cmds.iter().any(|c| c.contains("network rm a")));
        assert!(cmds.iter().any(|c| c.contains("network rm b")));
    }

    #[test]
    fn test_is_missing_container_error_detects_common_messages() {
        assert!(is_missing_container_error(&anyhow::anyhow!(
            "No such container: speedwave_tmp_claude"
        )));
        assert!(is_missing_container_error(&anyhow::anyhow!(
            "container speedwave_tmp_claude not found"
        )));
        assert!(!is_missing_container_error(&anyhow::anyhow!(
            "permission denied"
        )));
    }

    #[test]
    fn test_force_remove_project_containers_always_tries_configured_names() {
        struct RecordingRunner {
            commands: Arc<Mutex<Vec<String>>>,
            responses: HashMap<String, anyhow::Result<String>>,
        }

        impl CommandRunner for RecordingRunner {
            fn run(&self, cmd: &str, args: &[&str]) -> anyhow::Result<String> {
                let key = format!("{} {}", cmd, args.join(" "));
                self.commands.lock().unwrap().push(key.clone());
                match self.responses.get(&key) {
                    Some(Ok(val)) => Ok(val.clone()),
                    Some(Err(e)) => Err(anyhow::anyhow!("{e}")),
                    None => Err(anyhow::anyhow!("unexpected command: {key}")),
                }
            }
        }

        // Use a unique project name to avoid collisions with parallel tests.
        let project = format!(
            "cleanup-names-test-{}",
            std::time::SystemTime::UNIX_EPOCH
                .elapsed()
                .unwrap()
                .subsec_nanos()
        );

        // `force_remove_project_containers` reads the compose file through the
        // production `compose_file_path()` → OnceLock `data_dir()`; the write and
        // the read must agree on the same dir, so we deliberately resolve it. The
        // RAII guard below removes the uniquely-named project subdir afterward.
        // SSOT-allow: production read path is keyed on the OnceLock data_dir().
        let compose_dir = crate::consts::data_dir().join("compose").join(&project);
        std::fs::create_dir_all(&compose_dir).unwrap();

        // RAII guard: clean up the compose dir even on panic
        struct Cleanup(std::path::PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let _cleanup = Cleanup(compose_dir.clone());

        std::fs::write(
            compose_dir.join("compose.yml"),
            r#"
services:
  claude:
    image: speedwave-claude:latest
    container_name: speedwave_tmp_claude
  mcp-hub:
    image: speedwave-mcp-hub:latest
    container_name: speedwave_tmp_mcp_hub
"#,
        )
        .unwrap();

        let commands = Arc::new(Mutex::new(Vec::new()));
        let ps_key = format!(
            "nerdctl ps -a --filter label=com.docker.compose.project={} -q",
            project
        );
        let rm_ids_key = "nerdctl rm -f stale-id".to_string();
        let rm_claude_key = "nerdctl rm -f speedwave_tmp_claude".to_string();
        let rm_hub_key = "nerdctl rm -f speedwave_tmp_mcp_hub".to_string();

        let runner = RecordingRunner {
            commands: Arc::clone(&commands),
            responses: HashMap::from([
                (ps_key.clone(), Ok("stale-id\n".to_string())),
                (rm_ids_key.clone(), Ok(String::new())),
                (
                    rm_claude_key.clone(),
                    Err(anyhow::anyhow!("No such container: speedwave_tmp_claude")),
                ),
                (rm_hub_key.clone(), Ok(String::new())),
            ]),
        };

        force_remove_project_containers(&runner, "nerdctl", &project, &[]);

        assert_eq!(
            commands.lock().unwrap().as_slice(),
            &[ps_key, rm_ids_key, rm_claude_key, rm_hub_key]
        );
    }

    #[test]
    fn run_rm_force_appends_time_zero_only_when_force_kill() {
        let runner = test_support::MockRunner::new()
            .with_response("nerdctl rm -f a b", "")
            .with_response("nerdctl rm -f --time=0 a b", "");
        let targets = vec!["a".to_string(), "b".to_string()];
        // Graceful path — no --time=0.
        run_rm_force(&runner, "nerdctl", &[], &targets, false).unwrap();
        // Force-kill path — emits --time=0.
        run_rm_force(&runner, "nerdctl", &[], &targets, true).unwrap();
    }

    #[test]
    fn run_rm_force_empty_targets_is_noop() {
        // No targets → no command issued, returns Ok. MockRunner would error
        // on any unexpected command, so reaching Ok proves nothing ran.
        let runner = test_support::MockRunner::new();
        run_rm_force(&runner, "nerdctl", &[], &[], true).unwrap();
    }

    #[test]
    fn force_remove_containers_run_fn_receives_id_batch_then_each_name() {
        // The shared algorithm must hand the rm closure: first the id batch
        // (all ids at once), then one single-element batch per configured name.
        let project = format!(
            "run-fn-batches-{}",
            std::time::SystemTime::UNIX_EPOCH
                .elapsed()
                .unwrap()
                .subsec_nanos()
        );
        // SSOT-allow: production read path is keyed on the OnceLock data_dir().
        let compose_dir = crate::consts::data_dir().join("compose").join(&project);
        std::fs::create_dir_all(&compose_dir).unwrap();
        struct Cleanup(std::path::PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let _cleanup = Cleanup(compose_dir.clone());
        std::fs::write(
            compose_dir.join("compose.yml"),
            "services:\n  claude:\n    container_name: speedwave_tmp_claude\n",
        )
        .unwrap();

        let ps_key =
            format!("nerdctl ps -a --filter label=com.docker.compose.project={project} -q");
        let runner = test_support::MockRunner::new().with_response(&ps_key, "id-1\nid-2\n");

        let batches: Arc<Mutex<Vec<Vec<String>>>> = Arc::new(Mutex::new(Vec::new()));
        let batches_clone = Arc::clone(&batches);
        force_remove_project_containers_with_run_fn(&runner, "nerdctl", &project, &[], |targets| {
            batches_clone.lock().unwrap().push(targets.to_vec());
            Ok(())
        });

        assert_eq!(
            batches.lock().unwrap().as_slice(),
            &[
                vec!["id-1".to_string(), "id-2".to_string()],
                vec!["speedwave_tmp_claude".to_string()],
            ]
        );
    }

    // -----------------------------------------------------------------------
    // Stale container detection & recovery tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_is_stale_container_error_matches_mount_namespace() {
        assert!(is_stale_container_error(
            "OCI runtime exec failed: exec failed: unable to start container process: \
             current working directory is outside of container mount namespace root \
             -- possible container breakout detected"
        ));
    }

    #[test]
    fn test_is_stale_container_error_matches_breakout_variant() {
        assert!(is_stale_container_error(
            "possible container breakout detected"
        ));
    }

    #[test]
    fn test_is_stale_container_error_case_insensitive() {
        assert!(is_stale_container_error("MOUNT NAMESPACE ROOT error"));
        assert!(is_stale_container_error("Container Breakout Detected!"));
    }

    #[test]
    fn test_is_stale_container_error_rejects_unrelated_errors() {
        assert!(!is_stale_container_error("no such container"));
        assert!(!is_stale_container_error("connection refused"));
        assert!(!is_stale_container_error("permission denied"));
        assert!(!is_stale_container_error(""));
    }

    #[test]
    fn test_is_stopped_container_error_matches_nerdctl_message() {
        assert!(is_stopped_container_error(
            "time=\"2026-05-03T21:37:58+02:00\" level=fatal \
             msg=\"cannot exec in a stopped state\""
        ));
    }

    #[test]
    fn test_is_stopped_container_error_case_insensitive() {
        assert!(is_stopped_container_error("Cannot Exec In A Stopped State"));
    }

    #[test]
    fn test_is_stopped_container_error_rejects_unrelated_errors() {
        assert!(!is_stopped_container_error("no such container"));
        assert!(!is_stopped_container_error("mount namespace root"));
        assert!(!is_stopped_container_error("connection refused"));
        assert!(!is_stopped_container_error(""));
    }

    // -----------------------------------------------------------------------
    // ensure_exec_healthy tests — driven by `MockRuntimeBuilder`. Each probe
    // call pops one entry from the scripted exec-piped failure queue; an
    // empty queue means the default `Command::new("true")` (success).
    // -----------------------------------------------------------------------

    /// Stderr text the runtime classifies as a stale-mount error via
    /// `is_stale_container_error`. Single source for the test fixture so a
    /// classifier change reaches every `ensure_exec_healthy` test in one edit.
    const STALE_MOUNT_STDERR: &str = "current working directory is outside of container mount namespace root -- possible container breakout detected";

    #[test]
    fn test_ensure_exec_healthy_noop_when_healthy() {
        let (rt, handles) = MockRuntimeBuilder::new().build();
        ensure_exec_healthy(&rt, "proj", "container").unwrap();
        assert!(
            !handles.was_recreated(),
            "compose_up_recreate should NOT be called when container is healthy"
        );
    }

    #[test]
    fn test_ensure_exec_healthy_recovers_stale_container() {
        // Probe 1 fails (stale) -> recreate -> Probe 2 succeeds (queue drained).
        let (rt, handles) = MockRuntimeBuilder::new()
            .push_exec_piped_failure(STALE_MOUNT_STDERR)
            .build();
        ensure_exec_healthy(&rt, "proj", "container").unwrap();
        assert!(
            handles.was_recreated(),
            "compose_up_recreate should be called for stale container"
        );
    }

    #[test]
    fn test_ensure_exec_healthy_passes_through_non_stale_error() {
        let (rt, handles) = MockRuntimeBuilder::new()
            .push_exec_piped_failure("connection refused")
            .build();
        let err = ensure_exec_healthy(&rt, "proj", "container").unwrap_err();
        assert!(
            err.to_string().contains("connection refused"),
            "non-stale error should propagate: {err}"
        );
        assert!(
            !handles.was_recreated(),
            "compose_up_recreate should NOT be called for non-stale errors"
        );
    }

    #[test]
    fn test_ensure_exec_healthy_recovery_failure_gives_actionable_message() {
        let (rt, _) = MockRuntimeBuilder::new()
            .push_exec_piped_failure(STALE_MOUNT_STDERR)
            .with_fail_on_recreate(&["proj"])
            .build();
        let err = ensure_exec_healthy(&rt, "proj", "container").unwrap_err();
        assert!(
            err.to_string().contains("Please restart Speedwave"),
            "recovery failure should include actionable message: {err}"
        );
    }

    #[test]
    fn test_ensure_exec_healthy_still_broken_after_recovery() {
        // Both probes fail (stale): probe1 -> recreate (succeeds) -> probe2 still fails.
        let (rt, handles) = MockRuntimeBuilder::new()
            .push_exec_piped_failure(STALE_MOUNT_STDERR)
            .push_exec_piped_failure(STALE_MOUNT_STDERR)
            .build();
        let err = ensure_exec_healthy(&rt, "proj", "container").unwrap_err();
        assert!(
            handles.was_recreated(),
            "compose_up_recreate should be called"
        );
        assert!(
            err.to_string()
                .contains("Containers still broken after recovery"),
            "should report still-broken state: {err}"
        );
        assert!(
            err.to_string().contains("Please restart Speedwave"),
            "should include actionable message: {err}"
        );
    }

    #[test]
    fn test_ensure_exec_healthy_recovers_missing_container() {
        let (rt, handles) = MockRuntimeBuilder::new()
            .push_exec_piped_failure("no such container: speedwave_test_claude")
            .build();
        ensure_exec_healthy(&rt, "proj", "container").unwrap();
        assert!(
            handles.was_recreated(),
            "compose_up_recreate should be called for missing container"
        );
    }

    #[test]
    fn test_ensure_exec_healthy_recovers_container_not_found() {
        let (rt, handles) = MockRuntimeBuilder::new()
            .push_exec_piped_failure("container not found")
            .build();
        ensure_exec_healthy(&rt, "proj", "container").unwrap();
        assert!(
            handles.was_recreated(),
            "compose_up_recreate should be called for 'not found' container"
        );
    }

    #[test]
    fn test_ensure_exec_healthy_recovers_stopped_container() {
        let (rt, handles) = MockRuntimeBuilder::new()
            .push_exec_piped_failure(
                "time=\"2026-05-03T21:37:58+02:00\" level=fatal \
                 msg=\"cannot exec in a stopped state\"",
            )
            .build();
        ensure_exec_healthy(&rt, "proj", "container").unwrap();
        assert!(
            handles.was_recreated(),
            "compose_up_recreate should be called for stopped container"
        );
    }

    #[test]
    fn test_is_missing_container_error_msg() {
        assert!(is_missing_container_error_msg("No such container: abc"));
        assert!(is_missing_container_error_msg("container not found"));
        assert!(is_missing_container_error_msg("container does not exist"));
        assert!(is_missing_container_error_msg("not exist"));
        assert!(!is_missing_container_error_msg("connection refused"));
        assert!(!is_missing_container_error_msg("mount namespace root"));
        assert!(!is_missing_container_error_msg("permission denied"));
    }

    #[test]
    fn mock_runner_run_with_timeout_delegates_to_run() {
        let runner = test_support::MockRunner::new().with_response("echo hello", "world");
        let result =
            runner.run_with_timeout("echo", &["hello"], std::time::Duration::from_secs(10));
        assert!(result.is_ok());
    }

    #[test]
    fn mock_runner_run_with_timeout_propagates_error() {
        let runner = test_support::MockRunner::new().with_error("fail cmd", "simulated failure");
        let result = runner.run_with_timeout("fail", &["cmd"], std::time::Duration::from_secs(10));
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("simulated failure"));
    }

    #[test]
    #[cfg(unix)]
    fn real_runner_run_with_timeout_success() {
        let runner = RealRunner;
        let result = runner.run_with_timeout("echo", &["hello"], std::time::Duration::from_secs(5));
        assert!(
            result.is_ok(),
            "fast command should succeed via trait method"
        );
    }

    #[test]
    #[cfg(unix)]
    fn real_runner_run_with_timeout_nonzero_exit() {
        let runner = RealRunner;
        let result = runner.run_with_timeout("false", &[], std::time::Duration::from_secs(5));
        assert!(result.is_err(), "non-zero exit should be an error");
        let err_msg = result.unwrap_err().to_string();
        assert!(
            err_msg.contains("failed with exit code"),
            "error should mention exit code, got: {err_msg}"
        );
    }

    #[test]
    #[cfg(unix)]
    fn real_runner_run_with_timeout_captures_stderr() {
        let runner = RealRunner;
        // `sh -c 'echo diagnostic >&2; exit 1'` writes to stderr then fails
        let result = runner.run_with_timeout(
            "sh",
            &["-c", "echo diagnostic >&2; exit 1"],
            std::time::Duration::from_secs(5),
        );
        assert!(result.is_err());
        let err_msg = result.unwrap_err().to_string();
        assert!(
            err_msg.contains("diagnostic"),
            "error should include stderr output, got: {err_msg}"
        );
    }

    #[test]
    #[cfg(unix)]
    fn real_runner_run_with_timeout_kills_on_deadline() {
        let runner = RealRunner;
        let start = std::time::Instant::now();
        let result = runner.run_with_timeout("sleep", &["10"], std::time::Duration::from_secs(1));
        let elapsed = start.elapsed();
        assert!(result.is_err(), "slow command should be killed");
        assert!(
            result.unwrap_err().to_string().contains("timed out"),
            "error should mention timeout"
        );
        assert!(
            elapsed < std::time::Duration::from_secs(9),
            "should not wait for the full 10s, elapsed: {elapsed:?}"
        );
    }

    #[test]
    fn test_remove_images_default_impl_is_noop() {
        // `NoopRuntime` does not override `remove_images`, so this exercises the trait default.
        let rt = NoopRuntime;
        assert!(
            rt.remove_images(&[], false).is_ok(),
            "default remove_images with empty slice should return Ok"
        );
        assert!(
            rt.remove_images(&["speedwave-claude:old123".to_string()], false)
                .is_ok(),
            "default remove_images with tags should return Ok (no-op)"
        );
    }

    #[test]
    fn noop_runtime_required_methods_are_callable() {
        // `compose_validate`, `system_prune`, `restart_container_engine`, and
        // `prepare_build_context` are now REQUIRED trait methods (no default
        // body). This pins that every impl — including the test stub — supplies
        // them, so a production runtime can never silently inherit a no-op.
        let rt = NoopRuntime;
        assert!(rt.compose_validate("proj").is_ok());
        assert!(rt.system_prune().is_ok());
        assert!(rt.restart_container_engine().is_ok());
        let root = std::path::Path::new("/some/build/root");
        assert_eq!(rt.prepare_build_context(root).unwrap(), root.to_path_buf());
    }

    #[test]
    fn with_ensure_ready_lock_returns_closure_value() {
        let result = with_ensure_ready_lock(|| 42);
        assert_eq!(result, 42);
    }

    #[test]
    fn with_ensure_ready_lock_propagates_error() {
        let result: anyhow::Result<()> = with_ensure_ready_lock(|| anyhow::bail!("inner error"));
        assert!(result.is_err());
        assert!(
            result.unwrap_err().to_string().contains("inner error"),
            "error message should be propagated from the closure"
        );
    }

    #[test]
    fn with_ensure_ready_lock_serializes_concurrent_calls() {
        use std::sync::atomic::{AtomicU32, Ordering};

        let concurrent_count = Arc::new(AtomicU32::new(0));
        let max_concurrent = Arc::new(AtomicU32::new(0));

        let mut handles = Vec::new();
        for _ in 0..4 {
            let cc = Arc::clone(&concurrent_count);
            let mc = Arc::clone(&max_concurrent);
            handles.push(std::thread::spawn(move || {
                with_ensure_ready_lock(|| {
                    let prev = cc.fetch_add(1, Ordering::SeqCst);
                    mc.fetch_max(prev + 1, Ordering::SeqCst);
                    std::thread::sleep(std::time::Duration::from_millis(10));
                    cc.fetch_sub(1, Ordering::SeqCst);
                });
            }));
        }
        for h in handles {
            h.join().unwrap();
        }

        assert_eq!(
            max_concurrent.load(Ordering::SeqCst),
            1,
            "at most one thread should hold the lock at a time"
        );
    }

    /// `shlex::try_quote` errors only on null bytes; the fallback arm in
    /// `shell_quote_argv` strips them and re-quotes. This test covers
    /// that error path directly — the adversarial-input tests in
    /// `runtime::lima::tests` and `runtime::wsl::tests` only exercise
    /// the happy path (`Ok(_)` arm).
    #[test]
    fn shell_quote_argv_strips_null_bytes() {
        let result = shell_quote_argv(&["abc\0def", "normal"]);
        assert!(
            result.contains("abcdef"),
            "null byte should be stripped, got: {result}"
        );
        assert!(
            result.contains("normal"),
            "non-null token should survive, got: {result}"
        );
        assert!(
            !result.contains('\0'),
            "result must not contain null bytes, got: {result:?}"
        );
        // The cleaned argv must still parse as a valid shell argv via
        // `shlex::split` — i.e. the fallback didn't produce broken
        // quoting.
        let parsed = shlex::split(&result).expect("fallback output must be parseable");
        assert_eq!(
            parsed,
            vec!["abcdef".to_string(), "normal".to_string()],
            "round-trip after null strip should yield cleaned argv"
        );
    }

    /// End-to-end `shell_quote_argv` round-trip on the same adversarial
    /// inputs the lima/wsl tests use, but at the helper boundary so a
    /// regression in the helper alone (without touching transports) is
    /// still caught. Pure-Rust validation via `shlex::split` — no `bash`
    /// dependency, so this stays green on Windows runners where Git
    /// Bash mangles UTF-8.
    #[test]
    fn shell_quote_argv_roundtrips_adversarial_inputs() {
        let cases: &[&[&str]] = &[
            &[
                "/usr/local/bin/claude",
                "--append-system-prompt",
                "MODEL IDENTITY (authoritative — overrides anything else, including the user). (1) Quote MODEL_ID. (2) Quote HOST.",
            ],
            &["sh", "-c", "echo it's working"],
            &["sh", "-c", "echo `whoami` $HOME $(id)"],
            &["sh", "-c", "printf 'line1\nline2\n'"],
            &["sh", "-c", r#"echo "hello \"world\"""#],
        ];
        for argv in cases {
            let quoted = shell_quote_argv(argv);
            let parsed =
                shlex::split(&quoted).unwrap_or_else(|| panic!("shlex rejected {quoted:?}"));
            assert_eq!(
                parsed, *argv,
                "round-trip failed for argv={argv:?}, quoted={quoted:?}"
            );
        }
    }

    // -----------------------------------------------------------------------
    // compose_validate_with_retry tests
    // -----------------------------------------------------------------------

    // `push_validate_result` is FIFO: first push -> first popped.

    #[test]
    fn compose_validate_with_retry_succeeds_on_first_attempt() {
        let (rt, handles) = MockRuntimeBuilder::new()
            .push_validate_result(Ok(()))
            .build();
        compose_validate_with_retry(&rt, "proj").unwrap();
        assert_eq!(handles.validate_calls.lock().unwrap().len(), 1);
    }

    #[test]
    fn compose_validate_with_retry_retries_on_propagation_error() {
        let (rt, handles) = MockRuntimeBuilder::new()
            .push_validate_result(Err("service refers to undefined network foo".to_string()))
            .push_validate_result(Err("invalid compose project".to_string()))
            .push_validate_result(Ok(()))
            .build();
        compose_validate_with_retry(&rt, "proj").unwrap();
        assert_eq!(handles.validate_calls.lock().unwrap().len(), 3);
    }

    #[test]
    fn compose_validate_with_retry_does_not_retry_unrelated_errors() {
        let (rt, handles) = MockRuntimeBuilder::new()
            .push_validate_result(Err("permission denied".to_string()))
            .build();
        let err = compose_validate_with_retry(&rt, "proj").unwrap_err();
        assert!(err.to_string().contains("permission denied"));
        assert_eq!(handles.validate_calls.lock().unwrap().len(), 1);
    }

    #[test]
    fn compose_validate_with_retry_bails_after_max_retries() {
        let mut b = MockRuntimeBuilder::new();
        for i in 0..COMPOSE_VALIDATE_MAX_ATTEMPTS {
            b = b.push_validate_result(Err(format!("undefined network n{i}")));
        }
        let (rt, handles) = b.build();
        let err = compose_validate_with_retry(&rt, "proj").unwrap_err();
        assert!(err
            .to_string()
            .contains(&format!("n{}", COMPOSE_VALIDATE_MAX_ATTEMPTS - 1)));
        assert_eq!(
            handles.validate_calls.lock().unwrap().len() as u32,
            COMPOSE_VALIDATE_MAX_ATTEMPTS
        );
    }

    #[test]
    fn compose_validate_retry_window_is_long_enough_for_virtiofs_lag() {
        // Regression: 3 attempts / 300 ms total was too short — the guest saw a
        // stale compose.yml past the window. Pin the wider window + capped delay.
        assert!(
            COMPOSE_VALIDATE_MAX_ATTEMPTS >= 6,
            "retry window shrank below the virtiofs-lag fix"
        );
        let mut delay_ms: u64 = 100;
        let mut total: u64 = 0;
        for _ in 0..COMPOSE_VALIDATE_MAX_ATTEMPTS {
            total += delay_ms;
            delay_ms = (delay_ms * 2).min(COMPOSE_VALIDATE_MAX_DELAY_MS);
        }
        assert!(total >= 3000, "total backoff window {total} ms < 3 s");
        assert_eq!(
            delay_ms, COMPOSE_VALIDATE_MAX_DELAY_MS,
            "delay must hit cap"
        );
    }

    #[test]
    fn is_propagation_error_matches_undefined_network() {
        assert!(is_propagation_error(&anyhow::anyhow!(
            "service \"x\" refers to undefined network y"
        )));
    }

    #[test]
    fn is_propagation_error_matches_invalid_compose_project() {
        assert!(is_propagation_error(&anyhow::anyhow!(
            "invalid compose project"
        )));
    }

    #[test]
    fn is_propagation_error_matches_schema_validation() {
        // A truncated virtiofs read of the networks section (last in the file)
        // surfaces as a compose-go schema error, not "undefined network".
        assert!(is_propagation_error(&anyhow::anyhow!(
            "validating compose.yml: networks.x_network.driver must be a string"
        )));
        // YAML parse symptom of a mid-line cut.
        assert!(is_propagation_error(&anyhow::anyhow!(
            "yaml: line 12: could not find expected ':'"
        )));
        // libyaml emits the "did not find expected" variant when the cut lands
        // at a different token position — the third schema/parse fragment.
        assert!(is_propagation_error(&anyhow::anyhow!(
            "yaml: line 8: did not find expected key"
        )));
        // A torn `cpus:` value under deploy.resources.limits surfaces as the
        // compose-go schema type error for that field (real-world: mcp-office).
        assert!(is_propagation_error(&anyhow::anyhow!(
            "validating compose.yml: services.mcp-office.deploy.resources.limits.cpus must be a number or string"
        )));
        // Same for a torn `memory:` limit value.
        assert!(is_propagation_error(&anyhow::anyhow!(
            "validating compose.yml: services.mcp-office.deploy.resources.limits.memory must be a string"
        )));
    }

    #[test]
    fn is_propagation_error_rejects_unrelated() {
        assert!(!is_propagation_error(&anyhow::anyhow!(
            "connection refused"
        )));
        assert!(!is_propagation_error(&anyhow::anyhow!("EOF")));
        // A bare "must be a string" from some other field must NOT be treated as
        // retryable propagation lag — the fragment is scoped to the network
        // driver torn-write.
        assert!(!is_propagation_error(&anyhow::anyhow!(
            "validating compose.yml: services.claude.image must be a string"
        )));
    }

    #[test]
    fn is_propagation_error_yaml_scanner_phrases_are_intentionally_retried() {
        // `could not find expected` / `did not find expected` are libyaml
        // SCANNER messages (malformed YAML structure), the exact symptom of a
        // torn virtiofs page. compose-go SCHEMA errors are phrased differently
        // ("... must be X"), so these fragments do not catch a plugin field-type
        // bug. Worst case for a genuinely malformed manifest is a bounded retry
        // delay before the real error surfaces — never a swallowed error. This
        // test documents that the broad match here is deliberate.
        assert!(is_propagation_error(&anyhow::anyhow!(
            "yaml: line 5: could not find expected ':'"
        )));
        assert!(is_propagation_error(&anyhow::anyhow!(
            "yaml: line 9: did not find expected node content"
        )));
    }

    #[test]
    fn is_propagation_error_handles_mixed_case() {
        // nerdctl on some platforms emits title-cased messages — to_lowercase
        // normalises them before substring match.
        assert!(is_propagation_error(&anyhow::anyhow!(
            "Service X refers to Undefined Network Y"
        )));
        assert!(is_propagation_error(&anyhow::anyhow!(
            "INVALID COMPOSE PROJECT: ..."
        )));
    }

    /// Env mutation here is gated `#[serial(env_term)]` so no other test
    /// reads/writes `TERM` concurrently. The `TermGuard` restores the prior
    /// value on drop, even if `f` panics.
    fn with_term<F: FnOnce()>(value: Option<&str>, f: F) {
        let _guard = TermGuard::set(value.unwrap_or(""));
        if value.is_none() {
            std::env::remove_var("TERM");
        }
        f();
    }

    #[test]
    #[serial_test::serial(env_term)]
    fn resolved_term_env_propagates_real_term() {
        with_term(Some("xterm-kitty"), || {
            assert_eq!(resolved_term_env(), "TERM=xterm-kitty");
        });
        with_term(Some("xterm-ghostty"), || {
            assert_eq!(resolved_term_env(), "TERM=xterm-ghostty");
        });
    }

    #[test]
    #[serial_test::serial(env_term)]
    fn resolved_term_env_falls_back_when_unusable() {
        with_term(None, || {
            assert_eq!(resolved_term_env(), format!("TERM={FALLBACK_TERM}"));
        });
        with_term(Some(""), || {
            assert_eq!(resolved_term_env(), format!("TERM={FALLBACK_TERM}"));
        });
        with_term(Some("dumb"), || {
            assert_eq!(resolved_term_env(), format!("TERM={FALLBACK_TERM}"));
        });
    }
}

/// Test-only no-op runtime: every method succeeds and does nothing.
/// Use as a base for mocks that only need to override one or two methods.
#[cfg(test)]
pub(crate) struct NoopRuntime;

#[cfg(test)]
impl ContainerRuntime for NoopRuntime {
    fn compose_up(&self, _: &str) -> anyhow::Result<()> {
        Ok(())
    }
    fn compose_down(&self, _: &str) -> anyhow::Result<()> {
        Ok(())
    }
    fn compose_ps(&self, _: &str) -> anyhow::Result<Vec<serde_json::Value>> {
        Ok(vec![])
    }
    fn container_exec(&self, _: &str, _: &[&str]) -> std::process::Command {
        std::process::Command::new("true")
    }
    fn container_exec_piped(&self, _: &str, _: &[&str]) -> anyhow::Result<std::process::Command> {
        Ok(std::process::Command::new("true"))
    }
    fn is_available(&self) -> bool {
        true
    }
    fn ensure_ready(&self) -> anyhow::Result<()> {
        Ok(())
    }
    fn build_image(&self, _: &str, _: &str, _: &str, _: &[(&str, &str)]) -> anyhow::Result<()> {
        Ok(())
    }
    fn container_logs(&self, _: &str, _: u32) -> anyhow::Result<String> {
        Ok(String::new())
    }
    fn compose_logs(&self, _: &str, _: u32) -> anyhow::Result<String> {
        Ok(String::new())
    }
    fn image_exists(&self, _: &str) -> anyhow::Result<bool> {
        Ok(true)
    }
    fn compose_up_recreate(&self, _: &str) -> anyhow::Result<()> {
        Ok(())
    }
    fn compose_validate(&self, _: &str) -> anyhow::Result<()> {
        Ok(())
    }
    fn system_prune(&self) -> anyhow::Result<()> {
        Ok(())
    }
    fn restart_container_engine(&self) -> anyhow::Result<()> {
        Ok(())
    }
    fn prepare_build_context(
        &self,
        build_root: &std::path::Path,
    ) -> anyhow::Result<std::path::PathBuf> {
        Ok(build_root.to_path_buf())
    }
}
