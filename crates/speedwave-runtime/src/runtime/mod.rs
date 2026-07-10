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

/// Serializes concurrent `ensure_ready()` across all runtime instances —
/// `detect_runtime()` makes a fresh runtime each call, so a static lock is needed.
static ENSURE_READY_LOCK: Mutex<()> = Mutex::new(());

/// Acquires the global `ENSURE_READY_LOCK` and runs `f` under it — all
/// `ensure_ready()` impls delegate here so concurrent callers are serialized.
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
    /// Command for piped exec (no TTY). `Result` so impls can check preconditions
    /// (e.g. Lima VM running) before constructing the command.
    fn container_exec_piped(&self, container: &str, cmd: &[&str]) -> anyhow::Result<Command>;
    /// `true` only if already operational (binary present, VM/engine running).
    /// Read-only probe — never a gate before [`ensure_ready`], which can start it.
    fn is_available(&self) -> bool;

    /// `true` if the VM / WSL distro exists, regardless of running state
    /// (`is_setup_complete` external-removal check). Lima overrides; WSL uses default.
    fn is_installed(&self) -> bool {
        self.is_available()
    }

    /// Brings the runtime to a fully operational state, or returns a descriptive
    /// error. Safe to call unconditionally; prefer over [`is_available`].
    fn ensure_ready(&self) -> anyhow::Result<()>;
    fn build_image(
        &self,
        tag: &str,
        context_dir: &str,
        containerfile: &str,
        build_args: &[(&str, &str)],
    ) -> anyhow::Result<()>;
    /// Translates a host build-root into an engine-accessible path. No default —
    /// every impl MUST translate (Lima copies outside `~`; WSL maps `C:\`→`/mnt/c/`).
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

    /// Recreates ONE compose service (`--force-recreate`, no orphan removal),
    /// e.g. restart `proxy` mid-session (ADR-073). `service` must be built-in; impls validate.
    fn compose_up_service(&self, project: &str, service: &str) -> anyhow::Result<()>;

    /// Validates compose.yml as the engine sees it. Every impl MUST run the engine's
    /// `compose config` so a silent no-op cannot mask a torn/invalid file.
    fn compose_validate(&self, project: &str) -> anyhow::Result<()>;

    /// Removes dangling images + build cache (keeps tagged), recovering from the
    /// containerd overlayfs "failed to rename" bug. Every impl MUST actually prune.
    fn system_prune(&self) -> anyhow::Result<()>;

    /// Remove image tags. `force=true` = `rmi --force` (used by
    /// `prune_old_bundle_images` and plugin-uninstall).
    fn remove_images(&self, tags: &[String], force: bool) -> anyhow::Result<()> {
        let _ = (tags, force);
        log::debug!("remove_images: not implemented for this runtime, skipping");
        Ok(())
    }

    /// Removes BuildKit build cache; only from the `with_build_recovery` ladder
    /// (disk-full/corruption) — routine prunes keep the cache (ADR-072).
    fn prune_buildkit_cache(&self) -> anyhow::Result<()> {
        log::debug!("prune_buildkit_cache: not implemented for this runtime, skipping");
        Ok(())
    }

    /// Disk-full recovery: removes ALL tagged images not backing a running container
    /// (`nerdctl system prune`); BuildKit cache is cleared via `prune_buildkit_cache`.
    fn prune_unused_images(&self) -> anyhow::Result<()> {
        log::debug!("prune_unused_images: not implemented for this runtime, skipping");
        Ok(())
    }

    /// Restarts containerd + buildkitd, waiting on `nerdctl info` + `buildctl debug
    /// workers`. Only safe with no containers running; every impl MUST actually restart.
    fn restart_container_engine(&self) -> anyhow::Result<()>;

    /// Stops the underlying VM to free RAM (default no-op; only `LimaRuntime`
    /// overrides). Callers MUST treat errors as non-fatal — never block exit cleanup.
    fn stop_vm(&self) -> anyhow::Result<()> {
        Ok(())
    }

    /// Destructively tears down the VM/distro (`wsl --unregister`); default no-op,
    /// only `WslRuntime` overrides. Callers MUST treat errors as non-fatal.
    fn reset_vm(&self) -> anyhow::Result<()> {
        Ok(())
    }

    /// Runs a command **inside the VM (not a container)** for the VM's network
    /// stack (e.g. LLM discovery probe). `Err` if VM not running; see platform-matrix.md.
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

/// Shared `vm_exec` impl for Lima/WSL: spawns the command, pipes `stdin`, waits
/// with a timeout (kills child on overrun), captures stdout+stderr.
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

    /// Like `run`, but merges stdout+stderr (e.g. `nerdctl logs` writes to stderr).
    /// Default delegates to `run()` so existing impls/mocks work unchanged.
    fn run_with_stderr(&self, cmd: &str, args: &[&str]) -> anyhow::Result<String> {
        self.run(cmd, args)
    }

    /// Like `run`, but returns raw stdout bytes without UTF-8 conversion.
    /// Needed for commands like `wsl.exe --list` that output UTF-16LE.
    fn run_raw_stdout(&self, cmd: &str, args: &[&str]) -> anyhow::Result<Vec<u8>> {
        // Default: delegate to run() and return as UTF-8 bytes
        self.run(cmd, args).map(|s| s.into_bytes())
    }

    /// Like `run`, but kills on `timeout`, captures stderr, treats non-zero as `Err`.
    /// Limited-stderr commands only — verbose output deadlocks the 64 KB pipe.
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
                    // Bytes, not read_to_string: UTF-16LE wsl.exe stderr is
                    // invalid UTF-8 and would drop the whole error detail.
                    let stderr = child
                        .stderr
                        .take()
                        .map(|mut s| {
                            let mut buf = Vec::new();
                            std::io::Read::read_to_end(&mut s, &mut buf).ok();
                            decode_wsl_output(&buf)
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

/// Error for a failed child process; streams go through `decode_wsl_output`
/// so UTF-16LE wsl.exe stderr stays readable for classifiers (no-op on UTF-8).
fn run_failure(cmd: &str, stderr: &[u8], stdout: &[u8]) -> anyhow::Error {
    let stderr = decode_wsl_output(stderr);
    let stdout = decode_wsl_output(stdout);
    anyhow::anyhow!("{} failed: {}", cmd, combine_outputs(&stderr, &stdout))
}

impl CommandRunner for RealRunner {
    fn run(&self, cmd: &str, args: &[&str]) -> anyhow::Result<String> {
        let output = Self::prepare_command(cmd, args).output()?;
        if output.status.success() {
            Ok(String::from_utf8_lossy(&output.stdout).to_string())
        } else {
            Err(run_failure(cmd, &output.stderr, &output.stdout))
        }
    }

    fn run_with_stderr(&self, cmd: &str, args: &[&str]) -> anyhow::Result<String> {
        let output = Self::prepare_command(cmd, args).output()?;
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            Ok(combine_outputs(&stdout, &stderr))
        } else {
            Err(run_failure(cmd, &output.stderr, &output.stdout))
        }
    }

    fn run_raw_stdout(&self, cmd: &str, args: &[&str]) -> anyhow::Result<Vec<u8>> {
        let output = Self::prepare_command(cmd, args).output()?;
        if output.status.success() {
            Ok(output.stdout)
        } else {
            Err(run_failure(cmd, &output.stderr, &output.stdout))
        }
    }
}

/// Parses `compose ps --format json`, handling both JSON array and NDJSON
/// (nerdctl emits either depending on version).
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

/// Parses a semver triple from `"nerdctl version 2.0.3"`, `"limactl version 1.2.3"`,
/// or bare `"2.0.3"`. Returns `(major, minor, patch)` or `None`.
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

/// Path to a project's compose file: `~/.speedwave/compose/<project>/compose.yml`.
/// Delegates to the validating compose-path SSOT — invalid names are an error.
pub fn compose_file_path(project: &str) -> anyhow::Result<String> {
    let path = crate::compose::compose_output_path_in(consts::data_dir(), project)?;
    Ok(path.to_string_lossy().to_string())
}

/// True when the project's compose.yml has been rendered — a deferred-start or
/// interrupted-init project has none and can never have running containers.
pub fn project_has_compose_file(project: &str) -> bool {
    project_has_compose_file_in(consts::data_dir(), project)
}

/// True when a host-side compose file is absent — a `compose_down` on it is a
/// no-op (deferred no-provider project never rendered one), so skip the engine
/// call that would fatally error and retry.
pub(crate) fn compose_down_is_noop(host_compose_file: &str) -> bool {
    !std::path::Path::new(host_compose_file).exists()
}

/// Guards a compose service name before splicing into engine argv — only built-in
/// (runtime-managed, e.g. proxy) services qualify, never plugin/user input.
pub(crate) fn validate_builtin_service_name(service: &str) -> anyhow::Result<()> {
    if consts::BUILT_IN_SERVICES.contains(&service) {
        Ok(())
    } else {
        anyhow::bail!("'{service}' is not a built-in compose service")
    }
}

/// Core of [`project_has_compose_file`] under an explicit data directory;
/// an invalid project name can never have a compose file.
fn project_has_compose_file_in(data_dir: &std::path::Path, project: &str) -> bool {
    crate::compose::compose_output_path_in(data_dir, project).is_ok_and(|p| p.exists())
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

/// Runs `nerdctl rm -f [--time=0] <targets...>`. `force_kill` toggles `--time=0`
/// (hard kill) — WSL/tests pass `false`; Lima passes `true` on the final retry.
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

/// `true` if the message indicates the container does not exist (SSOT for
/// missing-container patterns; always containers, not images).
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

/// `true` if the error indicates broken mount namespaces after VM sleep/resume —
/// runc's `verifyCwd()` (CVE-2024-21626) detects the stale namespace.
fn is_stale_container_error(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("mount namespace root") || lower.contains("container breakout detected")
}

/// `true` if the container exists but is not running (Exited/Created) — nerdctl
/// exec emits this when `compose up` left a stopped container in place. Recreate fixes it.
fn is_stopped_container_error(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("cannot exec in a stopped state")
}

/// POSIX-shell-quotes each arg (via `shlex::try_quote`) and joins with spaces —
/// for transports re-evaluating the line through a remote shell (`ssh`, `wsl.exe`).
pub(crate) fn shell_quote_argv(argv: &[&str]) -> String {
    argv.iter()
        .map(|a| match shlex::try_quote(a) {
            Ok(quoted) => quoted.into_owned(),
            // `try_quote` only fails on null bytes (OS rejects them at execve);
            // if one slips through, strip and log rather than truncate silently.
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

/// Probes whether `nerdctl exec` works by running `true` — `Ok(())` on success,
/// else the stderr content as an error.
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

/// Logs each container's name + state from `compose_ps` on the recovery path,
/// distinguishing a crashed entrypoint from a container that never started.
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

/// Max `compose_validate` attempts; 100/200/400/800/1600 ms backoff (~3.1 s) for
/// the guest to see the host write through virtiofs (300 ms was too short).
const COMPOSE_VALIDATE_MAX_ATTEMPTS: u32 = 6;

/// Backoff cap so a higher attempt count cannot explode the delay.
const COMPOSE_VALIDATE_MAX_DELAY_MS: u64 = 1600;

/// Retries `compose_validate` with capped backoff on `is_propagation_error` —
/// virtiofs/9p lag where the VM still sees the pre-write compose.yml.
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

/// True for the CNI collision family left when a prior container's CNI DEL never ran
/// (crash, `wsl --shutdown`, reboot): next start hits "Chain already exists" or a stale IP.
fn is_stale_cni_error(e: &anyhow::Error) -> bool {
    let s = e.to_string().to_lowercase();
    s.contains("chain already exists")
        || s.contains("duplicate allocation is not allowed")
        || s.contains("already has an ip address different")
        || (s.contains("cni.setup") && s.contains("failed"))
}

/// Unique `<prefix><hex…>` identifiers named in `haystack` (e.g. `CNI-…` chains,
/// `br-…` bridges) — so cleanup can target only the offending state, not everything.
fn scan_cni_ids(haystack: &str, prefix: &str) -> Vec<String> {
    haystack
        .split(|c: char| !(c.is_ascii_alphanumeric() || c == '-'))
        .filter_map(|tok| {
            tok.strip_prefix(prefix)
                .filter(|tail| !tail.is_empty() && tail.bytes().all(|b| b.is_ascii_hexdigit()))
                .map(|_| tok.to_string())
        })
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect()
}

/// Best-effort cleanup for a stale-CNI failure: base64 `sh -c` payload (root, in the VM)
/// targeting ONLY the `CNI-*` chains / `br-*` bridges named in `err`. Docs: troubleshooting.
pub(crate) fn cni_cleanup_command(err: &anyhow::Error) -> String {
    use base64::Engine;
    let msg = err.to_string();
    let mut script = String::from(
        "export PATH=/usr/local/bin:/usr/local/sbin:/usr/sbin:/sbin:/usr/bin:/bin:$PATH\n",
    );
    for ch in scan_cni_ids(&msg, "CNI-") {
        // Guarded `eval`: only shell parsing survives the `\"` in %q comments (xargs dies
        // on "unmatched double quote"); the case-guard rejects `$`/backtick lines first.
        script.push_str(&format!(
            "iptables -t nat -S 2>/dev/null | grep -- '-j {ch}' | sed 's/^-A/-D/' | while IFS= read -r r; do case \"$r\" in *'$'*|*'`'*) continue;; esac; eval \"iptables -t nat $r\" 2>/dev/null || true; done\n\
             iptables -t nat -F {ch} 2>/dev/null || true\n\
             iptables -t nat -X {ch} 2>/dev/null || true\n"
        ));
    }
    for br in scan_cni_ids(&msg, "br-") {
        script.push_str(&format!("ip link delete {br} 2>/dev/null || true\n"));
    }
    script.push_str("true\n");
    let b64 = base64::engine::general_purpose::STANDARD.encode(&script);
    format!("echo {b64} | base64 -d | sh")
}

/// Runs `up`; on a stale-CNI failure runs `cleanup(err)` and retries `up` **once**. Any
/// other error propagates immediately. `cleanup` failure is logged, never fatal.
pub(crate) fn with_cni_heal<U, C>(up: U, cleanup: C) -> anyhow::Result<()>
where
    U: Fn() -> anyhow::Result<()>,
    C: FnOnce(&anyhow::Error) -> anyhow::Result<()>,
{
    match up() {
        Err(e) if is_stale_cni_error(&e) => {
            log::warn!("compose up hit stale CNI state ({e}); flushing the named CNI state and retrying once");
            if let Err(ce) = cleanup(&e) {
                log::warn!("CNI cleanup failed (continuing to retry): {ce}");
            }
            up()
        }
        other => other,
    }
}

/// Shared `force_remove_project_containers` (the `rm` closure removes a batch;
/// Lima wraps with retry). Works around the nerdctl ghost-name-store bug; best-effort.
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

/// Shared `force_remove_project_networks` (Lima wraps with retry, WSL/tests call
/// directly). Containers must be removed first — nerdctl refuses attached networks.
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

/// Stops all running project containers in parallel before `compose down` —
/// nerdctl stops sequentially, so this pays only the slowest container's time.
pub(crate) fn parallel_stop_project_containers(
    runner: &dyn CommandRunner,
    cmd: &str,
    project: &str,
    nerdctl_prefix: &[&str],
) {
    let filter = format!("label=com.docker.compose.project={project}");
    let mut ps_args: Vec<&str> = nerdctl_prefix.to_vec();
    ps_args.extend_from_slice(&["ps", "-q", "--filter", &filter]);
    let ids = match runner.run(cmd, &ps_args) {
        Ok(output) => cleanup_targets_from_ps_output(&output),
        Err(e) => {
            log::debug!("parallel_stop: ps failed for {project} (down will handle): {e}");
            return;
        }
    };
    if ids.is_empty() {
        return;
    }
    log::info!(
        "parallel_stop: stopping {} container(s) for {project}",
        ids.len()
    );
    // Chunked fan-out: each stop is its own ssh/wsl session; OpenSSH's
    // default MaxSessions is 10, so cap below it with polling headroom.
    const MAX_PARALLEL_STOPS: usize = 8;
    for chunk in ids.chunks(MAX_PARALLEL_STOPS) {
        std::thread::scope(|scope| {
            for id in chunk {
                scope.spawn(move || {
                    let mut stop_args: Vec<&str> = nerdctl_prefix.to_vec();
                    stop_args.extend_from_slice(&["stop", id]);
                    if let Err(e) = runner.run(cmd, &stop_args) {
                        log::debug!("parallel_stop: stop {id} failed (down will handle): {e}");
                    }
                });
            }
        });
    }
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
    parallel_stop_project_containers(runner, cmd, project, nerdctl_prefix);
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

/// Builds `TERM=<value>` for interactive `nerdctl exec`, propagating the host's
/// real `TERM` (keyboard protocol); falls back to `xterm-256color` if unset/dumb.
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
#[allow(clippy::unwrap_used, clippy::expect_used)]
pub(crate) mod test_support {
    use super::CommandRunner;

    /// Asserts `remote_cmd` round-trips through `shlex::split` to `expected_argv`.
    /// No `bash -n` — Git Bash on Windows mangles UTF-8 (claude-code#31295).
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

    type RecordedCall = (String, Vec<String>, Option<std::time::Duration>);

    pub struct SequentialMockRunner {
        pub responses: std::sync::Mutex<std::collections::VecDeque<anyhow::Result<String>>>,
        pub calls: std::sync::Mutex<Vec<RecordedCall>>,
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

    /// Encodes text the way `wsl.exe` emits it by default (UTF-16LE, no BOM).
    fn utf16le(s: &str) -> Vec<u8> {
        s.encode_utf16().flat_map(u16::to_le_bytes).collect()
    }

    #[test]
    fn run_failure_decodes_utf16_wsl_stderr_for_classifiers() {
        let stderr = utf16le("There is no distribution with the supplied name.\r\nError code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND");
        let err = run_failure("wsl.exe", &stderr, b"");
        let msg = err.to_string();
        assert!(
            msg.contains("WSL_E_DISTRO_NOT_FOUND"),
            "classifier token must survive decoding, got: {msg}"
        );
        assert!(
            !msg.contains('\u{0}'),
            "no NUL interleaving in decoded stderr: {msg:?}"
        );
    }

    #[test]
    fn run_failure_decodes_localized_utf16_stderr() {
        // Polish WSL: diacritics are invalid UTF-8 when read as bytes.
        let stderr = utf16le("Odmowa dostępu. Nie można otworzyć pliku konfiguracji.");
        let err = run_failure("wsl.exe", &stderr, b"");
        assert!(
            err.to_string().contains("Odmowa dostępu"),
            "localized detail must not be dropped: {err}"
        );
    }

    #[test]
    fn run_failure_passes_plain_utf8_through() {
        let err = run_failure("nerdctl", b"no such container speedwave_x_claude", b"");
        assert!(err.to_string().contains("no such container"));
    }

    #[test]
    fn test_compose_file_path_format() {
        let dir = tempfile::tempdir().unwrap();
        let path = crate::compose::compose_output_path_in(dir.path(), "my-project")
            .expect("valid name must resolve")
            .to_string_lossy()
            .to_string();
        assert!(path.starts_with(&dir.path().to_string_lossy().to_string()));
        assert!(path.contains("compose"));
        assert!(path.contains("my-project"));
        assert!(path.ends_with("compose.yml"));
    }

    /// A traversal-shaped name must never resolve another project's compose
    /// file — the probe validates via the compose-path SSOT.
    #[test]
    fn project_has_compose_file_rejects_invalid_names() {
        let dir = tempfile::tempdir().unwrap();
        let legit = dir.path().join("compose").join("legit");
        std::fs::create_dir_all(&legit).unwrap();
        std::fs::write(legit.join("compose.yml"), "services: {}").unwrap();
        assert!(project_has_compose_file_in(dir.path(), "legit"));
        assert!(!project_has_compose_file_in(dir.path(), "../compose/legit"));
        assert!(!project_has_compose_file_in(dir.path(), ""));
    }

    #[test]
    fn project_has_compose_file_false_when_never_rendered() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!project_has_compose_file_in(dir.path(), "orphaned"));
    }

    #[test]
    fn project_has_compose_file_true_when_rendered() {
        let dir = tempfile::tempdir().unwrap();
        let compose_dir = dir.path().join("compose").join("acme");
        std::fs::create_dir_all(&compose_dir).unwrap();
        std::fs::write(compose_dir.join("compose.yml"), "services: {}").unwrap();
        assert!(project_has_compose_file_in(dir.path(), "acme"));
    }

    #[test]
    fn compose_down_is_noop_true_when_file_absent() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("compose.yml");
        assert!(compose_down_is_noop(&missing.to_string_lossy()));
    }

    #[test]
    fn compose_down_is_noop_false_when_file_present() {
        let dir = tempfile::tempdir().unwrap();
        let present = dir.path().join("compose.yml");
        std::fs::write(&present, "services: {}").unwrap();
        assert!(!compose_down_is_noop(&present.to_string_lossy()));
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
        // Real `nerdctl compose ps --format json` output; the test only checks
        // Name and State, so the exact port is immaterial (ADR-038).
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
        let prestop_ps_key = format!(
            "nerdctl ps -q --filter label=com.docker.compose.project={}",
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
                (prestop_ps_key.clone(), Ok(String::new())),
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
        // Ordering: down → ps → rm-containers → network-ls. Containers MUST go
        // before networks — nerdctl refuses network rm with attached containers.
        assert_eq!(
            commands.lock().unwrap().as_slice(),
            &[prestop_ps_key, down_key, ps_key, rm_key, net_ls_key]
        );
    }

    #[test]
    fn parallel_stop_stops_every_running_container() {
        struct StopRunner {
            commands: Arc<Mutex<Vec<String>>>,
        }
        impl CommandRunner for StopRunner {
            fn run(&self, cmd: &str, args: &[&str]) -> anyhow::Result<String> {
                let key = format!("{} {}", cmd, args.join(" "));
                self.commands.lock().unwrap().push(key.clone());
                if args.contains(&"ps") {
                    Ok("id-a\nid-b\nid-c\n".to_string())
                } else {
                    Ok(String::new())
                }
            }
        }
        let commands = Arc::new(Mutex::new(Vec::new()));
        let runner = StopRunner {
            commands: Arc::clone(&commands),
        };
        parallel_stop_project_containers(&runner, "nerdctl", "par-stop", &[]);
        let recorded = commands.lock().unwrap();
        // Stops run concurrently — assert as a set, not a sequence.
        for id in ["id-a", "id-b", "id-c"] {
            assert!(
                recorded.contains(&format!("nerdctl stop {id}")),
                "missing stop for {id}: {recorded:?}"
            );
        }
        assert_eq!(recorded.len(), 4, "ps + 3 stops: {recorded:?}");
    }

    #[test]
    fn parallel_stop_runs_stops_concurrently() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        struct ConcurrencyRunner {
            current: AtomicUsize,
            max_seen: AtomicUsize,
        }
        impl CommandRunner for ConcurrencyRunner {
            fn run(&self, _cmd: &str, args: &[&str]) -> anyhow::Result<String> {
                if args.contains(&"ps") {
                    let ids: Vec<String> = (1..=20).map(|i| format!("c{i}")).collect();
                    return Ok(ids.join("\n"));
                }
                let now = self.current.fetch_add(1, Ordering::SeqCst) + 1;
                self.max_seen.fetch_max(now, Ordering::SeqCst);
                std::thread::sleep(std::time::Duration::from_millis(50));
                self.current.fetch_sub(1, Ordering::SeqCst);
                Ok(String::new())
            }
        }
        let runner = ConcurrencyRunner {
            current: AtomicUsize::new(0),
            max_seen: AtomicUsize::new(0),
        };
        parallel_stop_project_containers(&runner, "nerdctl", "par-conc", &[]);
        let max = runner.max_seen.load(std::sync::atomic::Ordering::SeqCst);
        assert!(
            max > 1,
            "stops must overlap in time (sequential would be 1)"
        );
        assert!(
            max <= 8,
            "fan-out must stay under sshd MaxSessions (10), got {max}"
        );
    }

    #[test]
    fn parallel_stop_tolerates_ps_failure() {
        struct FailingPsRunner {
            stops: Arc<Mutex<Vec<String>>>,
        }
        impl CommandRunner for FailingPsRunner {
            fn run(&self, _cmd: &str, args: &[&str]) -> anyhow::Result<String> {
                if args.contains(&"ps") {
                    anyhow::bail!("ps exploded");
                }
                self.stops.lock().unwrap().push(args.join(" "));
                Ok(String::new())
            }
        }
        let stops = Arc::new(Mutex::new(Vec::new()));
        let runner = FailingPsRunner {
            stops: Arc::clone(&stops),
        };
        parallel_stop_project_containers(&runner, "nerdctl", "par-psfail", &[]);
        assert!(
            stops.lock().unwrap().is_empty(),
            "no stops after ps failure"
        );
    }

    #[test]
    fn parallel_stop_tolerates_individual_stop_failure() {
        struct PartialFailRunner {
            commands: Arc<Mutex<Vec<String>>>,
        }
        impl CommandRunner for PartialFailRunner {
            fn run(&self, _cmd: &str, args: &[&str]) -> anyhow::Result<String> {
                let key = args.join(" ");
                self.commands.lock().unwrap().push(key.clone());
                if args.contains(&"ps") {
                    return Ok("good-id\nbad-id\n".to_string());
                }
                if key.contains("bad-id") {
                    anyhow::bail!("stop failed");
                }
                Ok(String::new())
            }
        }
        let commands = Arc::new(Mutex::new(Vec::new()));
        let runner = PartialFailRunner {
            commands: Arc::clone(&commands),
        };
        // Must not panic or propagate — down/rm -f converge failed stops later.
        parallel_stop_project_containers(&runner, "nerdctl", "par-partial", &[]);
        let recorded = commands.lock().unwrap();
        assert!(recorded.contains(&"stop good-id".to_string()));
        assert!(recorded.contains(&"stop bad-id".to_string()));
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

        // Write and read must agree on the same OnceLock `data_dir()`; resolve it
        // deliberately (RAII guard below cleans the uniquely-named subdir).

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

    // Stale container detection & recovery tests.

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

    // ensure_exec_healthy tests via `MockRuntimeBuilder`: each probe pops one
    // scripted exec-piped failure; empty queue → default `true` (success).

    /// Stderr classified as stale-mount by `is_stale_container_error`; single
    /// fixture so a classifier change reaches every test in one edit.
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
        // These four are REQUIRED trait methods (no default body); pins that every
        // impl supplies them, so production can never silently inherit a no-op.
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

    /// Covers `shell_quote_argv`'s null-byte fallback arm directly (the lima/wsl
    /// adversarial tests only exercise the `Ok(_)` happy path).
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
        // Cleaned argv must still parse via `shlex::split` (fallback quoting valid).
        let parsed = shlex::split(&result).expect("fallback output must be parseable");
        assert_eq!(
            parsed,
            vec!["abcdef".to_string(), "normal".to_string()],
            "round-trip after null strip should yield cleaned argv"
        );
    }

    /// `shell_quote_argv` round-trip on adversarial inputs at the helper boundary,
    /// validated via `shlex::split` (no `bash` — Windows Git Bash mangles UTF-8).
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

    // compose_validate_with_retry tests.

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
    #[allow(clippy::assertions_on_constants)] // SSOT guard: asserts COMPOSE_VALIDATE_MAX_ATTEMPTS stays sane
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
        // A cut at end-of-document (file truncated mid-write) — yaml-go variant.
        assert!(is_propagation_error(&anyhow::anyhow!(
            "failed to parse compose.yml: yaml: line 365: found unexpected end of stream"
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
        // A bare "must be a string" on another field must NOT be retryable —
        // the fragment is scoped to the network-driver torn-write.
        assert!(!is_propagation_error(&anyhow::anyhow!(
            "validating compose.yml: services.claude.image must be a string"
        )));
    }

    #[test]
    fn is_propagation_error_yaml_scanner_phrases_are_intentionally_retried() {
        // libyaml SCANNER phrases (`could not/did not find expected`) signal a torn
        // virtiofs page; worst case for a real malformed manifest is a bounded retry.
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

    #[test]
    fn is_stale_cni_error_matches_chain_collision_family() {
        assert!(is_stale_cni_error(&anyhow::anyhow!(
            "running [/usr/sbin/iptables -t nat -N CNI-abc --wait]: exit status 1: iptables: Chain already exists"
        )));
        assert!(is_stale_cni_error(&anyhow::anyhow!(
            "failed to call cni.Setup: plugin type=\"bridge\" failed (add)"
        )));
        assert!(is_stale_cni_error(&anyhow::anyhow!(
            "failed to allocate for range 0: 10.4.0.4 has been allocated, duplicate allocation is not allowed"
        )));
        assert!(is_stale_cni_error(&anyhow::anyhow!(
            "bridge br-x already has an IP address different from 10.4.1.1/24"
        )));
    }

    #[test]
    fn is_stale_cni_error_rejects_unrelated() {
        assert!(!is_stale_cni_error(&anyhow::anyhow!("EOF")));
        assert!(!is_stale_cni_error(&anyhow::anyhow!("no such image: foo")));
    }

    #[test]
    fn with_cni_heal_cleans_and_retries_once_on_cni_error() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let ups = AtomicUsize::new(0);
        let cleaned = AtomicUsize::new(0);
        let r = with_cni_heal(
            || {
                if ups.fetch_add(1, Ordering::SeqCst) == 0 {
                    anyhow::bail!("iptables: Chain already exists")
                } else {
                    Ok(())
                }
            },
            |_e| {
                cleaned.fetch_add(1, Ordering::SeqCst);
                Ok(())
            },
        );
        assert!(r.is_ok());
        assert_eq!(ups.load(Ordering::SeqCst), 2, "up runs twice");
        assert_eq!(cleaned.load(Ordering::SeqCst), 1, "cleanup runs once");
    }

    #[test]
    fn with_cni_heal_skips_cleanup_and_retry_on_other_error() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let ups = AtomicUsize::new(0);
        let r = with_cni_heal(
            || {
                ups.fetch_add(1, Ordering::SeqCst);
                anyhow::bail!("no such image")
            },
            |_e| -> anyhow::Result<()> { panic!("cleanup must not run on non-CNI error") },
        );
        assert!(r.is_err());
        assert_eq!(ups.load(Ordering::SeqCst), 1, "up runs once, no retry");
    }

    #[test]
    fn with_cni_heal_retries_even_if_cleanup_fails() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let ups = AtomicUsize::new(0);
        let r = with_cni_heal(
            || {
                if ups.fetch_add(1, Ordering::SeqCst) == 0 {
                    anyhow::bail!("iptables: Chain already exists")
                } else {
                    Ok(())
                }
            },
            |_e| anyhow::bail!("cleanup blew up"),
        );
        assert!(
            r.is_ok(),
            "cleanup failure is non-fatal; the retry still runs"
        );
        assert_eq!(
            ups.load(Ordering::SeqCst),
            2,
            "up retried despite cleanup error"
        );
    }

    #[test]
    fn scan_cni_ids_extracts_only_hex_suffixed_names() {
        let s = "chain CNI-68fe31e0 and CNI-abc plus br-deadbeef but not CNI-nothex or plain";
        assert_eq!(scan_cni_ids(s, "CNI-"), vec!["CNI-68fe31e0", "CNI-abc"]);
        assert_eq!(scan_cni_ids(s, "br-"), vec!["br-deadbeef"]);
        assert!(scan_cni_ids("no ids here", "CNI-").is_empty());
    }

    #[test]
    fn cni_cleanup_command_is_quote_free_base64_pipe() {
        let cmd = cni_cleanup_command(&anyhow::anyhow!("iptables: Chain already exists"));
        assert!(
            cmd.starts_with("echo "),
            "must pipe an echoed payload: {cmd}"
        );
        assert!(
            cmd.ends_with("| base64 -d | sh"),
            "must self-decode + exec: {cmd}"
        );
        let b64 = cmd
            .trim_start_matches("echo ")
            .trim_end_matches(" | base64 -d | sh");
        // The payload must carry no shell metacharacters — the whole point is that it
        // survives the WSL default-shell reparse + `sh -c` layers that mangle raw quotes.
        assert!(
            !b64.is_empty()
                && b64
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"+/=".contains(&b)),
            "payload must be pure base64, got: {b64}"
        );
    }

    #[test]
    fn cni_cleanup_command_targets_only_named_state() {
        use base64::Engine;
        let decode = |cmd: &str| -> String {
            let b64 = cmd
                .trim_start_matches("echo ")
                .trim_end_matches(" | base64 -d | sh");
            String::from_utf8(
                base64::engine::general_purpose::STANDARD
                    .decode(b64)
                    .unwrap(),
            )
            .unwrap()
        };

        // Names the colliding chain → flush + delete THAT chain, never a VM-wide scan.
        let script = decode(&cni_cleanup_command(&anyhow::anyhow!(
            "iptables -t nat -N CNI-68fe31e0 --wait: iptables: Chain already exists"
        )));
        assert!(script.contains("iptables -t nat -F CNI-68fe31e0"));
        assert!(script.contains("iptables -t nat -X CNI-68fe31e0"));
        // Jump-rule delete: guarded `eval` (only shell parsing handles the `\"` inside
        // CNI's %q comments; xargs errors "unmatched double quote" and drops `-j <ch>`).
        assert!(script.contains("eval \"iptables -t nat $r\""));
        assert!(script.contains("while IFS= read -r r"));
        assert!(
            script.contains("case \"$r\" in *'$'*|*'`'*) continue;; esac"),
            "eval must be guarded against $/backtick (root command-substitution sink): {script}"
        );
        assert!(
            !script.contains("xargs"),
            "xargs cannot parse backslash-escaped quotes in %q comments: {script}"
        );
        assert!(
            !script.contains("nerdctl network prune"),
            "prune is VM-global while the compose lock is per-project: {script}"
        );
        assert!(
            !script.contains("grep -oE"),
            "must not blanket-scan CNI chains: {script}"
        );
        assert!(
            !script.contains("ip -o link show type bridge"),
            "must not blanket-delete bridges: {script}"
        );

        // No id in the error → no iptables/bridge/network mutation at all (retry only).
        let bare = decode(&cni_cleanup_command(&anyhow::anyhow!(
            "failed to call cni.Setup: plugin failed (add)"
        )));
        assert!(
            !bare.contains("iptables -t nat -F"),
            "no chain named → no flush: {bare}"
        );
        assert!(
            !bare.contains("ip link delete"),
            "no bridge named → no delete: {bare}"
        );
        assert!(
            !bare.contains("nerdctl"),
            "no id named → nothing VM-global to run: {bare}"
        );
    }

    /// Empirical: runs the decoded cleanup pipeline against a fake `iptables` on PATH.
    /// macOS-gated — Linux hosts would resolve the real `/usr/sbin/iptables` first.
    #[test]
    #[cfg(target_os = "macos")]
    fn cni_cleanup_pipeline_parses_escaped_quotes_and_blocks_injection() {
        use std::io::Write;
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("calls.log");
        let pwned = dir.path().join("pwned");

        // Fake iptables: `-S` emits one legit %q-commented jump rule (CNI-68fe31e0) and
        // one command-substitution attempt (CNI-deadbeef); every other call logs argv.
        let legit = r#"-A POSTROUTING -s 10.4.0.0/24 -m comment --comment "name: \"speedwave_net\" id: \"abc\"" -j CNI-68fe31e0"#;
        let evil = format!(
            r#"-A POSTROUTING -s 10.4.1.0/24 -m comment --comment "x $(touch {})" -j CNI-deadbeef"#,
            pwned.display()
        );
        let fake = dir.path().join("iptables");
        {
            let mut f = std::fs::File::create(&fake).unwrap();
            write!(
                f,
                "#!/bin/sh\nif [ \"$3\" = \"-S\" ]; then\nprintf '%s\\n' '{legit}'\nprintf '%s\\n' '{evil}'\nexit 0\nfi\n{{ for a in \"$@\"; do printf '%s\\n' \"$a\"; done; printf 'END\\n'; }} >> '{}'\nexit 0\n",
                log.display()
            )
            .unwrap();
            f.set_permissions(std::fs::Permissions::from_mode(0o755))
                .unwrap();
        }

        let cmd = cni_cleanup_command(&anyhow::anyhow!(
            "CNI-68fe31e0 and CNI-deadbeef: iptables: Chain already exists"
        ));
        let path = format!(
            "{}:{}",
            dir.path().display(),
            std::env::var("PATH").unwrap_or_default()
        );
        let status = std::process::Command::new("sh")
            .arg("-c")
            .arg(&cmd)
            .env("PATH", path)
            .status()
            .unwrap();
        assert!(status.success(), "cleanup pipeline must exit 0");

        let calls: Vec<Vec<String>> = std::fs::read_to_string(&log)
            .unwrap()
            .split("END\n")
            .filter(|b| !b.trim().is_empty())
            .map(|b| b.lines().map(str::to_string).collect())
            .collect();

        // The %q comment must arrive UNESCAPED as one argv element, with `-j <chain>`
        // intact — exactly what the xargs variant lost ("unmatched double quote").
        let delete = calls
            .iter()
            .find(|c| c.contains(&"-D".to_string()) && c.contains(&"CNI-68fe31e0".to_string()))
            .expect("jump-rule delete for CNI-68fe31e0 must reach iptables");
        assert!(
            delete.contains(&r#"name: "speedwave_net" id: "abc""#.to_string()),
            "comment must be one unescaped argv element, got: {delete:?}"
        );
        assert!(delete.contains(&"-j".to_string()), "got: {delete:?}");
        assert!(
            calls
                .iter()
                .any(|c| c.contains(&"-F".to_string()) && c.contains(&"CNI-68fe31e0".to_string())),
            "chain flush must run"
        );

        // The `$(…)` rule is skipped by the guard: nothing executed, no delete issued.
        assert!(!pwned.exists(), "command substitution must never execute");
        assert!(
            !calls
                .iter()
                .any(|c| c.contains(&"-D".to_string()) && c.iter().any(|a| a.contains("deadbeef"))),
            "guarded line must be skipped, not evaluated"
        );
    }

    #[test]
    fn with_cni_heal_propagates_error_when_retry_also_fails() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let ups = AtomicUsize::new(0);
        let r = with_cni_heal(
            || {
                if ups.fetch_add(1, Ordering::SeqCst) == 0 {
                    anyhow::bail!("iptables: Chain already exists")
                } else {
                    anyhow::bail!("still broken after cleanup")
                }
            },
            |_e| Ok(()),
        );
        let err = r.expect_err("second failure must propagate");
        assert!(
            err.to_string().contains("still broken after cleanup"),
            "the RETRY error propagates (not the first): {err}"
        );
        assert_eq!(
            ups.load(Ordering::SeqCst),
            2,
            "exactly one retry, never two"
        );
    }

    /// Gated `#[serial(env_term)]`; `TermGuard` restores the prior `TERM` on drop,
    /// even if `f` panics.
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
    fn compose_up_service(&self, _: &str, _: &str) -> anyhow::Result<()> {
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
