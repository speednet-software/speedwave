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
        log::debug!("removing images is not implemented for this runtime, skipping");
        Ok(())
    }

    /// Removes BuildKit build cache; only from the `with_build_recovery` ladder
    /// (disk-full/corruption) — routine prunes keep the cache (ADR-072).
    fn prune_buildkit_cache(&self) -> anyhow::Result<()> {
        log::debug!("pruning the BuildKit cache is not implemented for this runtime, skipping");
        Ok(())
    }

    /// Disk-full recovery: removes ALL tagged images not backing a running container
    /// (`nerdctl system prune`); BuildKit cache is cleared via `prune_buildkit_cache`.
    fn prune_unused_images(&self) -> anyhow::Result<()> {
        log::debug!("pruning unused images is not implemented for this runtime, skipping");
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

pub(crate) fn vm_exec_run(
    mut command: Command,
    stdin: &[u8],
    timeout: std::time::Duration,
) -> anyhow::Result<VmExecOutput> {
    use std::io::Write;
    use std::process::Stdio;

    command.stdin(Stdio::piped());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    let program = command.get_program().to_string_lossy().into_owned();
    let mut child = command.spawn()?;

    if let Some(mut sink) = child.stdin.take() {
        if !stdin.is_empty() {
            sink.write_all(stdin)?;
        }
    }

    let output = binary::wait_for_piped_child(child, timeout, &format!("command '{program}'"))?;
    Ok(VmExecOutput {
        status: output.status,
        stdout: output.stdout,
        stderr: output.stderr,
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
        self.run(cmd, args).map(|s| s.into_bytes())
    }

    /// Like `run`, but gives up after `timeout`. The default ignores the deadline so test runners
    /// never spawn a process; [`RealRunner`] bounds the real child and captures both streams.
    fn run_bounded(
        &self,
        cmd: &str,
        args: &[&str],
        _timeout: std::time::Duration,
    ) -> anyhow::Result<String> {
        self.run(cmd, args)
    }

    /// Like `run_raw_stdout`, but gives up after `timeout`; the default ignores the deadline, as
    /// [`CommandRunner::run_bounded`]'s does.
    fn run_raw_stdout_bounded(
        &self,
        cmd: &str,
        args: &[&str],
        _timeout: std::time::Duration,
    ) -> anyhow::Result<Vec<u8>> {
        self.run_raw_stdout(cmd, args)
    }

    /// Like `run`, but kills on `timeout`, captures stderr (drained on a thread), treats non-zero
    /// as `Err`.
    fn run_with_timeout(
        &self,
        cmd: &str,
        args: &[&str],
        timeout: std::time::Duration,
    ) -> anyhow::Result<()> {
        run_until(cmd, args, timeout, &|| false).map(|_| ())
    }

    /// Like `run_with_timeout`, but kills the command once `stop()` turns true: `Ok(false)` then,
    /// `Ok(true)` when it succeeded. The default ignores `stop` and calls `run_with_timeout`.
    fn run_with_timeout_until(
        &self,
        cmd: &str,
        args: &[&str],
        timeout: std::time::Duration,
        stop: &dyn Fn() -> bool,
    ) -> anyhow::Result<bool> {
        let _ = stop;
        self.run_with_timeout(cmd, args, timeout).map(|()| true)
    }
}

fn run_until(
    cmd: &str,
    args: &[&str],
    timeout: std::time::Duration,
    stop: &dyn Fn() -> bool,
) -> anyhow::Result<bool> {
    let mut command = binary::command(cmd);
    command.args(args);
    command.stderr(std::process::Stdio::piped());

    let program = command.get_program().to_string_lossy().to_string();
    let mut child = command.spawn()?;
    let stderr_reader = child.stderr.take().map(binary::read_on_thread);
    let start = std::time::Instant::now();
    loop {
        match child.try_wait()? {
            Some(status) if status.success() => return Ok(true),
            Some(_) if stop() => return Ok(false),
            Some(status) => {
                let stderr = stderr_reader
                    .as_ref()
                    .and_then(|r| binary::exited_child_output(r, &program).ok())
                    .map(|buf| decode_wsl_output(&buf))
                    .unwrap_or_default();
                let detail = stderr.trim();
                if detail.is_empty() {
                    anyhow::bail!("{} failed with exit code {:?}", program, status.code());
                }
                anyhow::bail!(
                    "{} failed with exit code {:?}: {}",
                    program,
                    status.code(),
                    user_facing_failure_text(&program, detail)
                );
            }
            None if stop() => {
                if let Err(e) = child.kill() {
                    log::warn!("failed to kill the stopped command '{program}': {e}");
                }
                let _ = child.wait();
                return Ok(false);
            }
            None if start.elapsed() >= timeout => {
                if let Err(e) = child.kill() {
                    log::warn!("failed to kill timed-out command: {e}");
                }
                let _ = child.wait();
                anyhow::bail!(
                    "command '{}' timed out after {}s",
                    program,
                    timeout.as_secs()
                );
            }
            None => std::thread::sleep(std::time::Duration::from_millis(200)),
        }
    }
}

/// Production [`CommandRunner`] that spawns real processes.
pub struct RealRunner;

/// Combines two output streams, returning whichever is non-empty (or both joined by newline).
pub(crate) fn combine_outputs(primary: &str, secondary: &str) -> String {
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
    let combined = combine_outputs(&stderr, &stdout);
    anyhow::anyhow!(
        "{} failed: {}",
        cmd,
        user_facing_failure_text(cmd, &combined)
    )
}

const LOGRUS_CHATTER_LEVELS: [&str; 5] = ["trace", "debug", "info", "warning", "warn"];

fn logrus_level(line: &str) -> Option<&str> {
    let line = line.trim_start();
    if !line.starts_with("time=") {
        return None;
    }
    let (_, rest) = line.split_once(" level=")?;
    rest.split(char::is_whitespace).next()
}

fn is_logrus_chatter(line: &str) -> bool {
    logrus_level(line).is_some_and(|level| LOGRUS_CHATTER_LEVELS.contains(&level))
}

fn user_facing_failure_text(cmd: &str, raw: &str) -> String {
    let kept: Vec<&str> = raw
        .lines()
        .filter(|line| !is_logrus_chatter(line) && !line.trim().is_empty())
        .collect();
    if kept.is_empty() || !raw.lines().any(is_logrus_chatter) {
        return crate::log_sanitizer::sanitize(raw);
    }
    log::debug!(
        "full output of the failed {cmd} command:\n{}",
        crate::log_sanitizer::sanitize(raw)
    );
    crate::log_sanitizer::sanitize(&kept.join("\n"))
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

    fn run_bounded(
        &self,
        cmd: &str,
        args: &[&str],
        timeout: std::time::Duration,
    ) -> anyhow::Result<String> {
        self.run_raw_stdout_bounded(cmd, args, timeout)
            .map(|stdout| String::from_utf8_lossy(&stdout).to_string())
    }

    fn run_with_timeout_until(
        &self,
        cmd: &str,
        args: &[&str],
        timeout: std::time::Duration,
        stop: &dyn Fn() -> bool,
    ) -> anyhow::Result<bool> {
        run_until(cmd, args, timeout, stop)
    }

    fn run_raw_stdout_bounded(
        &self,
        cmd: &str,
        args: &[&str],
        timeout: std::time::Duration,
    ) -> anyhow::Result<Vec<u8>> {
        let mut command = Self::prepare_command(cmd, args);
        let output = binary::run_with_timeout_capture(&mut command, timeout)?;
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
    compose_file_path_in(consts::data_dir(), project)
}

/// `compose_file_path` resolved under an explicit data directory — the env-free
/// core used by tests to avoid resolving the production `consts::data_dir()`.
pub fn compose_file_path_in(data_dir: &std::path::Path, project: &str) -> anyhow::Result<String> {
    let path = crate::compose::compose_output_path_in(data_dir, project)?;
    Ok(path.to_string_lossy().to_string())
}

/// True when the project's compose.yml has been rendered — a deferred-start or
/// interrupted-init project has none and can never have running containers.
pub fn project_has_compose_file(project: &str) -> bool {
    project_has_compose_file_in(consts::data_dir(), project)
}

/// True when a host-side compose file is absent — `compose_down` on it is a no-op (deferred
/// no-provider project never rendered one), so skip the engine call that would fatally error.
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
    configured_project_container_names_in(consts::data_dir(), project)
}

/// Env-free core of `configured_project_container_names` — tests inject a tempdir.
pub(crate) fn configured_project_container_names_in(
    data_dir: &std::path::Path,
    project: &str,
) -> Vec<String> {
    let compose_file = match compose_file_path_in(data_dir, project) {
        Ok(path) => path,
        Err(e) => {
            log::debug!("compose path unavailable for project {project}: {e}");
            return Vec::new();
        }
    };

    let compose_yml = match std::fs::read_to_string(&compose_file) {
        Ok(yaml) => yaml,
        Err(e) => {
            log::debug!("compose file unreadable for project {project}: {e}");
            return Vec::new();
        }
    };

    container_names_from_compose_yaml(&compose_yml)
}

fn container_names_from_compose_yaml(compose_yml: &str) -> Vec<String> {
    let doc: serde_yaml_ng::Value = match serde_yaml_ng::from_str(compose_yml) {
        Ok(doc) => doc,
        Err(e) => {
            log::debug!("invalid compose YAML: {e}");
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

const NO_SUCH_IMAGE_FRAGMENT: &str = "no such image";

pub(crate) fn image_inspect_verdict(inspect: anyhow::Result<String>) -> anyhow::Result<bool> {
    let Err(e) = inspect else {
        return Ok(true);
    };
    let lower = e.to_string().to_ascii_lowercase();
    if lower.contains(NO_SUCH_IMAGE_FRAGMENT) {
        Ok(false)
    } else {
        Err(e)
    }
}

#[derive(Debug)]
pub(crate) struct VmStatusUnreadable(String);

impl VmStatusUnreadable {
    pub(crate) fn error(message: String) -> anyhow::Error {
        anyhow::Error::new(Self(message))
    }
}

impl std::fmt::Display for VmStatusUnreadable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for VmStatusUnreadable {}

#[derive(Debug)]
pub(crate) struct VmNotFound(String);

impl VmNotFound {
    pub(crate) fn error(message: String) -> anyhow::Error {
        anyhow::Error::new(Self(message))
    }
}

impl std::fmt::Display for VmNotFound {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for VmNotFound {}

static ENGINE_TEARDOWN_STARTED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// From here on this process starts neither a stopped Lima VM nor a compose stack; app exit and
/// factory reset call it before they stop the engine.
pub fn begin_engine_teardown() {
    ENGINE_TEARDOWN_STARTED.store(true, std::sync::atomic::Ordering::SeqCst);
}

/// `true` once [`begin_engine_teardown`] ran in this process.
pub fn engine_teardown_started() -> bool {
    ENGINE_TEARDOWN_STARTED.load(std::sync::atomic::Ordering::SeqCst)
}

/// Undoes [`begin_engine_teardown`] for a test that ran exit cleanup in its own process.
#[cfg(any(test, feature = "test-support"))]
pub fn undo_engine_teardown() {
    ENGINE_TEARDOWN_STARTED.store(false, std::sync::atomic::Ordering::SeqCst);
}

#[derive(Debug)]
pub(crate) struct EngineTearingDown;

impl std::fmt::Display for EngineTearingDown {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Speedwave is shutting the container engine down and starts nothing on it")
    }
}

impl std::error::Error for EngineTearingDown {}

/// POSIX-shell-quotes each arg (via `shlex::try_quote`) and joins with spaces —
/// for transports re-evaluating the line through a remote shell (`ssh`, `wsl.exe`).
pub(crate) fn shell_quote_argv(argv: &[&str]) -> String {
    argv.iter()
        .map(|a| match shlex::try_quote(a) {
            Ok(quoted) => quoted.into_owned(),
            Err(_) => {
                log::error!("argv token contains a null byte; stripping nulls before quoting");
                let stripped = a.replace('\0', "");
                shlex::try_quote(stripped.as_str())
                    .map(|s| s.into_owned())
                    .unwrap_or(stripped)
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn run_exec_probe(cmd: &mut Command, timeout: std::time::Duration) -> anyhow::Result<()> {
    let output = binary::run_with_timeout_capture(cmd, timeout)?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("{}", stderr.trim())
    }
}

fn probe_container_exec_with_timeout(
    runtime: &LockedRuntime,
    container: &str,
    timeout: std::time::Duration,
) -> anyhow::Result<()> {
    let mut cmd = runtime.container_exec_piped(container, &["true"])?;
    run_exec_probe(&mut cmd, timeout)
}

fn probe_container_exec(runtime: &LockedRuntime, container: &str) -> anyhow::Result<()> {
    probe_container_exec_with_timeout(runtime, container, consts::CONTAINER_EXEC_PROBE_TIMEOUT)
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
            log::info!("container states at {when}: [{}]", states.join(", "));
        }
        Err(e) => log::info!("compose_ps failed at {when}: {e}"),
    }
}

/// Probes a container until it can run an exec, surfacing health failures.
pub fn ensure_exec_healthy(
    runtime: &LockedRuntime,
    project: &str,
    container: &str,
) -> anyhow::Result<()> {
    log::info!("probing container '{container}'");
    match probe_container_exec(runtime, container) {
        Ok(()) => {
            log::info!("container '{container}' is healthy");
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
        if msg.contains(NO_SUCH_IMAGE_FRAGMENT) || msg.contains("image not found") {
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

const COMPOSE_UP_TIMEOUT_SECS: u64 = 180;
const COMPOSE_UP_DEADLINE_FRAGMENT: &str = "timeout: sending signal KILL";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum UpMode<'a> {
    Diverged,
    All,
    Service(&'a str),
    Rejoin(&'a str),
}

impl<'a> UpMode<'a> {
    pub(crate) fn after_task_collision(self) -> UpMode<'a> {
        match self {
            UpMode::Service(service) => UpMode::Rejoin(service),
            other => other,
        }
    }
}

pub(crate) fn compose_up_argv(compose_file: &str, project: &str, mode: UpMode<'_>) -> Vec<String> {
    let limit = COMPOSE_UP_TIMEOUT_SECS.to_string();
    let mode_args = match mode {
        UpMode::Diverged => vec!["--remove-orphans"],
        UpMode::All => vec!["--force-recreate", "--remove-orphans"],
        UpMode::Service(service) => vec!["--force-recreate", service],
        UpMode::Rejoin(service) => vec![service],
    };
    [
        "timeout",
        "--signal=KILL",
        "--verbose",
        limit.as_str(),
        "nerdctl",
        "compose",
        "-f",
        compose_file,
        "-p",
        project,
        "up",
        "-d",
    ]
    .into_iter()
    .chain(mode_args)
    .map(str::to_string)
    .collect()
}

pub(crate) fn explain_compose_up_deadline(e: anyhow::Error) -> anyhow::Error {
    if e.to_string().contains(COMPOSE_UP_DEADLINE_FRAGMENT) {
        anyhow::anyhow!(
            "compose up did not finish within {COMPOSE_UP_TIMEOUT_SECS}s and was stopped: {e}"
        )
    } else {
        e
    }
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
                    "compose validate attempt {} failed: {e} — retrying after {} ms",
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
        || s.contains(crate::compose::COMPOSE_FILE_ENOENT_ERROR_FRAGMENT)
        || crate::compose::COMPOSE_SCHEMA_VALIDATION_ERROR_FRAGMENTS
            .iter()
            .any(|frag| s.contains(frag))
}

/// True for stale-CNI collisions (a prior CNI DEL never ran: crash/`wsl --shutdown`/reboot)
/// and, via the last arm, ANY `cni.setup … failed` — the named-state cleanup no-ops if none match.
fn is_stale_cni_error(e: &anyhow::Error) -> bool {
    let s = e.to_string().to_lowercase();
    s.contains("chain already exists")
        || s.contains("duplicate allocation is not allowed")
        || s.contains("already has an ip address different")
        || (s.contains("cni.setup") && s.contains("failed"))
}

fn is_cni_id(token: &str, prefix: &str) -> bool {
    token
        .strip_prefix(prefix)
        .is_some_and(|tail| !tail.is_empty() && tail.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// Unique `<prefix><hex…>` identifiers named in `haystack` (e.g. `CNI-…` chains,
/// `br-…` bridges) — so cleanup can target only the offending state, not everything.
fn scan_cni_ids(haystack: &str, prefix: &str) -> Vec<String> {
    haystack
        .split(|c: char| !(c.is_ascii_alphanumeric() || c == '-'))
        .filter(|tok| is_cni_id(tok, prefix))
        .map(str::to_string)
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect()
}

const MAX_CNI_HEALS: usize = 64;

pub(crate) struct CniTargets {
    chains: Vec<String>,
    bridges: Vec<String>,
}

impl CniTargets {
    fn named_in(err: &anyhow::Error) -> Self {
        let msg = err.to_string();
        Self {
            chains: scan_cni_ids(&msg, "CNI-"),
            bridges: scan_cni_ids(&msg, "br-"),
        }
    }

    fn colliding_chains_in(err: &anyhow::Error) -> Self {
        let msg = err.to_string();
        let collisions = msg
            .split('\n')
            .flat_map(|line| line.split("\\n"))
            .filter(|segment| segment.to_lowercase().contains("chain already exists"))
            .collect::<Vec<_>>()
            .join("\n");
        Self {
            chains: scan_cni_ids(&collisions, "CNI-"),
            bridges: Vec::new(),
        }
    }

    fn without(mut self, targeted: &std::collections::BTreeSet<String>) -> Self {
        self.chains.retain(|id| !targeted.contains(id));
        self.bridges.retain(|id| !targeted.contains(id));
        self
    }

    fn ids(&self) -> impl Iterator<Item = &String> {
        self.chains.iter().chain(&self.bridges)
    }

    fn is_empty(&self) -> bool {
        self.chains.is_empty() && self.bridges.is_empty()
    }
}

/// Best-effort cleanup for a stale-CNI failure: base64 `sh -c` payload (root, in the VM)
/// targeting ONLY the `CNI-*` chains / `br-*` bridges in `targets`.
pub(crate) fn cni_cleanup_command(targets: &CniTargets) -> String {
    let mut script = String::from(
        "export PATH=/usr/local/bin:/usr/local/sbin:/usr/sbin:/sbin:/usr/bin:/bin:$PATH\n",
    );
    for ch in targets.chains.iter().filter(|id| is_cni_id(id, "CNI-")) {
        script.push_str(&format!(
            "iptables -t nat -S 2>/dev/null | grep -- '-j {ch}' | sed 's/^-A/-D/' | while IFS= read -r r; do case \"$r\" in *'$'*|*'`'*|*';'*|*'|'*|*'&'*|*'<'*|*'>'*) continue;; esac; eval \"iptables -t nat $r\" 2>/dev/null || true; done\n\
             iptables -t nat -F {ch} 2>/dev/null || true\n\
             iptables -t nat -X {ch} 2>/dev/null || true\n"
        ));
    }
    for br in targets.bridges.iter().filter(|id| is_cni_id(id, "br-")) {
        script.push_str(&format!("ip link delete {br} 2>/dev/null || true\n"));
    }
    script.push_str("true\n");
    wrap_base64_sh(&script)
}

/// In-VM coordinates of the nerdctl name-store a cleanup payload targets;
/// tests inject a tempdir store and absolute stub binaries. The containerd
/// address/namespace are never overridden by Speedwave, so they are read
/// directly from `consts` rather than carried as fields.
pub(crate) struct NameStoreLayout {
    pub data_root: String,
    pub nerdctl_bin: String,
}

impl NameStoreLayout {
    /// Production coordinates: nerdctl defaults, never overridden by Speedwave.
    pub(crate) fn production() -> Self {
        Self {
            data_root: consts::NERDCTL_DATA_ROOT.to_string(),
            nerdctl_bin: "nerdctl".to_string(),
        }
    }

    fn store_dir(&self) -> String {
        format!(
            "{}/{}/names/{}",
            self.data_root,
            consts::nerdctl_addr_hash(),
            consts::CONTAINERD_NAMESPACE
        )
    }
}

/// Container-name shape our compose renders (`<prefix>_<project>_<service>`);
/// anything else never reaches a cleanup payload (shell-safety + scoping gate).
fn is_safe_container_name(name: &str) -> bool {
    !name.is_empty()
        && name.bytes().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'_' | b'.' | b'-')
        })
}

/// `(container_name, dead_id)` pairs from a nerdctl name-store conflict, scoped to
/// `project` (exact dynamic `<compose_prefix>_<project>_` anchor). Empty = not classified.
pub(crate) fn name_store_conflicts(e: &anyhow::Error, project: &str) -> Vec<(String, String)> {
    let raw = e.to_string();
    let lower = raw.to_lowercase();
    if !lower.contains("name-store error") || !lower.contains("is already used by id") {
        return Vec::new();
    }
    let msg = raw.replace('\\', "");
    let required_prefix = format!("{}_{}_", consts::compose_prefix(), project);
    const NAME_OPEN: &str = "name \"";
    const MID: &str = "\" is already used by ID \"";
    let mut out: Vec<(String, String)> = Vec::new();
    let mut rest = msg.as_str();
    while let Some(i) = rest.find(NAME_OPEN) {
        rest = &rest[i + NAME_OPEN.len()..];
        let Some(j) = rest.find(MID) else { break };
        let name = &rest[..j];
        rest = &rest[j + MID.len()..];
        let Some(k) = rest.find('"') else { break };
        let id = &rest[..k];
        rest = &rest[k + 1..];
        let id_ok = id.is_empty()
            || (id.len() == 64
                && id
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
        if name.starts_with(&required_prefix)
            && is_safe_container_name(name)
            && id_ok
            && !out.iter().any(|(n, _)| n == name)
        {
            out.push((name.to_string(), id.to_string()));
        }
    }
    out
}

const TASK_CREATE_COLLISION_SETTLE: std::time::Duration = std::time::Duration::from_secs(2);
const TASK_BUNDLE_DIR_FRAGMENT: &str = "io.containerd.runtime.v2.task/";
const TASK_ALREADY_EXISTS_FRAGMENT: &str = ": already exists";

fn is_task_create_collision(e: &anyhow::Error) -> bool {
    let s = e.to_string().to_lowercase();
    (s.contains("mkdir ") && s.contains(TASK_BUNDLE_DIR_FRAGMENT) && s.contains("file exists"))
        || names_an_existing_task(&s)
}

fn names_an_existing_task(s: &str) -> bool {
    s.match_indices("task ").any(|(i, needle)| {
        let rest = &s[i + needle.len()..];
        rest.len() > 64
            && rest.as_bytes()[..64].iter().all(u8::is_ascii_hexdigit)
            && rest[64..].starts_with(TASK_ALREADY_EXISTS_FRAGMENT)
    })
}

/// Shared fail-closed per-entry heal function + flock gate. The destructive `rm`
/// runs under the store's own flock (the lock nerdctl's name-store uses).
fn name_store_script_header(layout: &NameStoreLayout) -> String {
    format!(
        "export PATH=/usr/local/bin:/usr/local/sbin:/usr/sbin:/sbin:/usr/bin:/bin:$PATH\n\
         store=\"{store}\"\n\
         heal_entry() {{\n\
         f=\"$1\"\n\
         [ -f \"$f\" ] || return 0\n\
         id=$(cat \"$f\" 2>/dev/null)\n\
         if [ -z \"$id\" ]; then\n\
         flock -w 5 \"$store\" sh -c '[ -f \"$1\" ] && [ -z \"$(cat \"$1\" 2>/dev/null)\" ] && rm -f \"$1\"' _ \"$f\"\n\
         return 0\n\
         fi\n\
         case \"$id\" in *[!0-9a-f]*) return 0 ;; esac\n\
         [ \"${{#id}}\" -eq 64 ] || return 0\n\
         out=$(\"{nerdctl}\" --address \"{addr}\" --namespace \"{ns}\" --data-root \"{root}\" inspect \"$id\" 2>&1); rc=$?\n\
         [ \"$rc\" -ne 0 ] || return 0\n\
         case \"$out\" in *\"no such object $id\"*) ;; *) return 0 ;; esac\n\
         flock -w 5 \"$store\" sh -c '[ \"$(cat \"$1\" 2>/dev/null)\" = \"$2\" ] && rm -f \"$1\"' _ \"$f\" \"$id\"\n\
         return 0\n\
         }}\n\
         command -v flock >/dev/null 2>&1 || exit 0\n",
        store = layout.store_dir(),
        nerdctl = layout.nerdctl_bin,
        addr = consts::CONTAINERD_ADDRESS,
        ns = consts::CONTAINERD_NAMESPACE,
        root = layout.data_root,
    )
}

pub(crate) fn wrap_base64_sh(script: &str) -> String {
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(script);
    format!("echo {b64} | base64 -d | sh")
}

/// Reverses [`wrap_base64_sh`]: decodes an `echo <b64> | base64 -d | sh`
/// payload back to the script it wraps. Test-support only.
#[cfg(any(test, feature = "test-support"))]
#[expect(
    clippy::expect_used,
    reason = "test-support decoder: panics point straight at the malformed payload"
)]
pub fn decode_payload(cmd: &str) -> String {
    use base64::Engine;
    let b64 = cmd
        .strip_prefix("echo ")
        .and_then(|r| r.strip_suffix(" | base64 -d | sh"))
        .expect("payload must be `echo <b64> | base64 -d | sh`");
    assert!(
        b64.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/' || b == b'='),
        "payload must be pure base64 (quote-free through the WSL reparse)"
    );
    String::from_utf8(
        base64::engine::general_purpose::STANDARD
            .decode(b64)
            .expect("valid base64"),
    )
    .expect("utf8 script")
}

/// Heal payload for an `up` name-store conflict: exact-name targets only —
/// the project's rendered container names plus the names parsed from `err`.
pub(crate) fn name_store_heal_command_in(
    layout: &NameStoreLayout,
    err: &anyhow::Error,
    project: &str,
) -> String {
    let mut targets = configured_project_container_names(project);
    for (name, _) in name_store_conflicts(err, project) {
        push_unique_target(&mut targets, name);
    }
    let prefix = format!("{}_{}_", consts::compose_prefix(), project);
    let mut script = name_store_script_header(layout);
    for name in targets
        .iter()
        .filter(|n| n.starts_with(&prefix) && is_safe_container_name(n))
    {
        script.push_str(&format!("heal_entry \"$store/{name}\"\n"));
    }
    script.push_str("true\n");
    wrap_base64_sh(&script)
}

/// Sweep payload for a project with no rendered compose.yml (down path). Prefix-scoped
/// with longest-prefix disambiguation so `foo` never claims `foo_bar`'s entries.
pub(crate) fn name_store_sweep_command_in(
    layout: &NameStoreLayout,
    project: &str,
    registered_projects: &[String],
) -> String {
    let own_prefix = format!("{}_{}_", consts::compose_prefix(), project);
    let longer: Vec<String> = registered_projects
        .iter()
        .filter(|p| p.as_str() != project)
        .map(|p| format!("{}_{}_", consts::compose_prefix(), p))
        .filter(|pref| pref.starts_with(&own_prefix) && pref.len() > own_prefix.len())
        .filter(|pref| is_safe_container_name(pref.trim_end_matches('_')))
        .collect();
    let mut script = name_store_script_header(layout);
    script.push_str(&format!("for f in \"$store/{own_prefix}\"*; do\n"));
    if !longer.is_empty() {
        let arms = longer
            .iter()
            .map(|p| format!("{p}*"))
            .collect::<Vec<_>>()
            .join("|");
        script.push_str(&format!(
            "case \"${{f##*/}}\" in {arms}) continue ;; esac\n"
        ));
    }
    script.push_str("heal_entry \"$f\"\ndone\ntrue\n");
    wrap_base64_sh(&script)
}

/// Compose-project names known to this host (`<data_dir>/compose/<project>/`);
/// the sweep's registry for longest-prefix ownership checks.
pub(crate) fn registered_compose_projects() -> Vec<String> {
    let dir = consts::data_dir().join("compose");
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    entries
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .filter_map(|e| e.file_name().into_string().ok())
        .collect()
}

pub(crate) fn with_engine_state_heal<U, R, C, N>(
    project: &str,
    up: U,
    rejoin: R,
    cni_cleanup: C,
    name_store_cleanup: N,
) -> anyhow::Result<()>
where
    U: Fn() -> anyhow::Result<()>,
    R: Fn() -> anyhow::Result<()>,
    C: FnMut(&CniTargets) -> anyhow::Result<()>,
    N: FnOnce(&anyhow::Error) -> anyhow::Result<()>,
{
    with_engine_state_heal_settling(
        project,
        up,
        rejoin,
        cni_cleanup,
        name_store_cleanup,
        std::thread::sleep,
    )
}

fn with_engine_state_heal_settling<U, R, C, N, S>(
    project: &str,
    up: U,
    rejoin: R,
    mut cni_cleanup: C,
    name_store_cleanup: N,
    mut settle: S,
) -> anyhow::Result<()>
where
    U: Fn() -> anyhow::Result<()>,
    R: Fn() -> anyhow::Result<()>,
    C: FnMut(&CniTargets) -> anyhow::Result<()>,
    N: FnOnce(&anyhow::Error) -> anyhow::Result<()>,
    S: FnMut(std::time::Duration),
{
    let mut cni_heals = 0;
    let mut cni_targeted = std::collections::BTreeSet::new();
    let mut name_store_cleanup = Some(name_store_cleanup);
    let mut task_collision_retried = false;
    let mut rejoin_next = false;
    loop {
        let attempt = if rejoin_next { rejoin() } else { up() };
        rejoin_next = false;
        let Err(e) = attempt else {
            return Ok(());
        };
        let healed = if is_stale_cni_error(&e) {
            let first = cni_heals == 0;
            let targets = if first {
                CniTargets::named_in(&e)
            } else {
                CniTargets::colliding_chains_in(&e).without(&cni_targeted)
            };
            if cni_heals < MAX_CNI_HEALS && (first || !targets.is_empty()) {
                cni_heals += 1;
                cni_targeted.extend(targets.ids().cloned());
                let ids = targets.ids().collect::<Vec<_>>();
                if first {
                    log::warn!(
                        "compose up hit a CNI setup failure ({e}); flushing {ids:?} and retrying"
                    );
                } else {
                    log::warn!("compose up hit another stale CNI chain; flushing {ids:?} and retrying (heal {cni_heals}/{MAX_CNI_HEALS})");
                    log::debug!("CNI setup failure behind heal {cni_heals}: {e}");
                }
                if let Err(ce) = cni_cleanup(&targets) {
                    log::warn!("CNI cleanup failed (continuing to retry): {ce}");
                }
                task_collision_retried = false;
                true
            } else {
                false
            }
        } else if !name_store_conflicts(&e, project).is_empty() {
            match name_store_cleanup.take() {
                Some(cleanup) => {
                    log::warn!("compose up hit a stale name-store reservation ({e}); releasing dead entries for '{project}' and retrying once");
                    if let Err(ce) = cleanup(&e) {
                        log::warn!("name-store cleanup failed (continuing to retry): {ce}");
                    }
                    task_collision_retried = false;
                    true
                }
                None => false,
            }
        } else if is_task_create_collision(&e) && !task_collision_retried {
            task_collision_retried = true;
            log::warn!("compose up raced another start of the same container ({e}); retrying once in {TASK_CREATE_COLLISION_SETTLE:?}");
            settle(TASK_CREATE_COLLISION_SETTLE);
            rejoin_next = true;
            true
        } else {
            false
        };
        if !healed {
            return Err(e);
        }
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
    force_remove_project_containers_with_run_fn_in(
        consts::data_dir(),
        runner,
        cmd,
        project,
        nerdctl_prefix,
        rm,
    );
}

/// Env-free core of `force_remove_project_containers_with_run_fn` — the compose
/// read behind `configured_project_container_names` resolves under `data_dir`.
pub(crate) fn force_remove_project_containers_with_run_fn_in<RmFn>(
    data_dir: &std::path::Path,
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
            log::debug!("ps failed while listing containers to remove for {project}: {e}");
            Vec::new()
        }
    };
    let name_targets = configured_project_container_names_in(data_dir, project);

    if id_targets.is_empty() && name_targets.is_empty() {
        return;
    }

    if !id_targets.is_empty() {
        log::info!(
            "removing {} stale container id(s) for {project}",
            id_targets.len()
        );
        if let Err(e) = rm(&id_targets) {
            log::warn!("rm -f by id failed for {project}: {e}");
        }
    }

    for container_name in &name_targets {
        let single_target = vec![container_name.clone()];
        match rm(&single_target) {
            Ok(()) => {}
            Err(e) if is_missing_container_error(&e) => {
                log::debug!("{project} target '{container_name}' already gone: {e}");
            }
            Err(e) => {
                log::warn!("rm -f by name failed for {project} target '{container_name}': {e}");
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
    force_remove_project_containers_in(consts::data_dir(), runner, cmd, project, nerdctl_prefix);
}

/// Env-free core of `force_remove_project_containers` — tests inject a tempdir.
#[cfg(any(target_os = "windows", test))]
pub(crate) fn force_remove_project_containers_in(
    data_dir: &std::path::Path,
    runner: &dyn CommandRunner,
    cmd: &str,
    project: &str,
    nerdctl_prefix: &[&str],
) {
    force_remove_project_containers_with_run_fn_in(
        data_dir,
        runner,
        cmd,
        project,
        nerdctl_prefix,
        |targets| run_rm_force(runner, cmd, nerdctl_prefix, targets, false),
    );
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
                "network ls failed for {project}: {e} \
                 — orphan networks may block next compose_up"
            );
            return;
        }
    };
    if net_ids.is_empty() {
        return;
    }

    log::info!("removing {} network(s) for {project}", net_ids.len());
    for net_id in &net_ids {
        let mut rm_args: Vec<&str> = nerdctl_prefix.to_vec();
        rm_args.extend_from_slice(&["network", "rm", net_id]);
        if let Err(e) = run(cmd, &rm_args) {
            log::warn!("network rm {net_id} failed for {project}: {e}");
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
            log::debug!("ps failed for {project} (down will handle): {e}");
            return;
        }
    };
    if ids.is_empty() {
        return;
    }
    log::info!(
        "stopping {} container(s) in parallel for {project}",
        ids.len()
    );
    const MAX_PARALLEL_STOPS: usize = 8;
    for chunk in ids.chunks(MAX_PARALLEL_STOPS) {
        std::thread::scope(|scope| {
            for id in chunk {
                scope.spawn(move || {
                    let mut stop_args: Vec<&str> = nerdctl_prefix.to_vec();
                    stop_args.extend_from_slice(&["stop", id]);
                    if let Err(e) = runner.run(cmd, &stop_args) {
                        log::debug!("stop {id} failed (down will handle): {e}");
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
        log::warn!("compose down failed for {project}: {e}");
    }

    force_remove_project_containers(runner, cmd, project, nerdctl_prefix);
    force_remove_project_networks(runner, cmd, project, nerdctl_prefix);
    down_result.map(|_| ())
}

/// SSOT entry point: the only way to obtain a runtime handle outside this
/// crate. Returns `LockedRuntime` so callers cannot bypass per-project locks.
pub fn detect_runtime() -> LockedRuntime {
    LockedRuntime::new(detect_runtime_inner(), engine_teardown_started)
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
#[expect(clippy::unwrap_used, reason = "test code asserts via unwrap")]
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
#[expect(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "test code asserts via unwrap/expect"
)]
mod tests {
    use super::decode_payload;
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

    const NERDCTL_RUN_CHATTER: &str = "time=\"2026-09-16T10:00:00+02:00\" level=info msg=\"Running [/usr/local/bin/nerdctl run -d --name speedwave_acme_mcp-context7 -e=MCP_CONTEXT7_AUTH_TOKEN=00000000-0000-4000-8000-000000000001 --label io.speedwave.project=acme docker.io/speedwave/context7:1]\"";
    const NERDCTL_FATAL: &str = "time=\"2026-09-16T10:00:01+02:00\" level=fatal msg=\"error while creating container speedwave_acme_mcp-context7: exit status 1\"";
    const WORKER_TOKEN_ARG: &str = "-e=MCP_X_AUTH_TOKEN=abc";

    #[test]
    fn run_failure_keeps_only_the_fatal_line_of_a_compose_up_failure() {
        let stderr = format!("{NERDCTL_RUN_CHATTER}\n{NERDCTL_FATAL}\n");
        let msg = run_failure("limactl", stderr.as_bytes(), b"").to_string();
        assert_eq!(msg, format!("limactl failed: {NERDCTL_FATAL}"));
    }

    #[test]
    fn run_failure_never_returns_a_worker_auth_token_from_the_argv_echo() {
        let stderr = format!("{NERDCTL_RUN_CHATTER}\n{NERDCTL_FATAL}\n");
        let stdout = format!(
            "time=\"2026-09-16T10:00:00+02:00\" level=info msg=\"Running [nerdctl run {WORKER_TOKEN_ARG} image]\""
        );
        let msg = run_failure("wsl.exe", stderr.as_bytes(), stdout.as_bytes()).to_string();
        assert!(
            !msg.contains("00000000-0000-4000-8000-000000000001"),
            "leaked: {msg}"
        );
        assert!(!msg.contains(WORKER_TOKEN_ARG), "leaked: {msg}");
        assert!(
            !msg.contains("Running ["),
            "argv echo must not reach the error: {msg}"
        );
        assert!(
            msg.contains("exit status 1"),
            "fatal reason must survive: {msg}"
        );
    }

    #[test]
    fn run_failure_redacts_a_worker_auth_token_inside_a_kept_fatal_line() {
        let stderr = format!(
            "time=\"2026-09-16T10:00:01+02:00\" level=fatal msg=\"failed to run [nerdctl run {WORKER_TOKEN_ARG} image]: exit status 1\""
        );
        let msg = run_failure("limactl", stderr.as_bytes(), b"").to_string();
        assert!(
            msg.contains("level=fatal"),
            "fatal line must survive: {msg}"
        );
        assert!(!msg.contains(WORKER_TOKEN_ARG), "leaked: {msg}");
        assert!(
            msg.contains("-e=MCP_X_AUTH_TOKEN=***REDACTED*** image]"),
            "got: {msg}"
        );
    }

    #[test]
    fn run_failure_keeps_unstructured_lines_next_to_the_fatal_line() {
        let stderr = format!(
            "ssh: connect to host lima-speedwave port 60022: Connection refused\n{NERDCTL_RUN_CHATTER}\ntime=\"2026-09-16T10:00:01+02:00\" level=fatal msg=\"exit status 255\"\n"
        );
        let msg = run_failure("limactl", stderr.as_bytes(), b"").to_string();
        assert_eq!(
            msg,
            "limactl failed: ssh: connect to host lima-speedwave port 60022: Connection refused\ntime=\"2026-09-16T10:00:01+02:00\" level=fatal msg=\"exit status 255\""
        );
    }

    #[test]
    fn run_failure_keeps_level_error_lines_and_drops_warnings() {
        let stderr = b"time=\"2026-09-16T10:00:00+02:00\" level=warning msg=\"ignored\"\ntime=\"2026-09-16T10:00:01+02:00\" level=error msg=\"boom\"";
        let msg = run_failure("wsl.exe", stderr, b"").to_string();
        assert_eq!(
            msg,
            "wsl.exe failed: time=\"2026-09-16T10:00:01+02:00\" level=error msg=\"boom\""
        );
    }

    #[test]
    fn run_failure_falls_back_to_the_redacted_full_text_when_every_line_is_chatter() {
        let stderr = format!(
            "{NERDCTL_RUN_CHATTER}\ntime=\"2026-09-16T10:00:01+02:00\" level=info msg=\"done\""
        );
        let msg = run_failure("limactl", stderr.as_bytes(), b"").to_string();
        assert!(msg.contains("Running ["), "got: {msg}");
        assert!(msg.contains("msg=\"done\""), "got: {msg}");
        assert!(
            !msg.contains("00000000-0000-4000-8000-000000000001"),
            "leaked: {msg}"
        );
        assert!(
            msg.contains("MCP_CONTEXT7_AUTH_TOKEN=***REDACTED***"),
            "got: {msg}"
        );
    }

    #[test]
    fn run_failure_leaves_output_without_logrus_lines_byte_exact() {
        let stderr = b"Access is denied.\r\nError code: Wsl/Service/E_ACCESSDENIED";
        let msg = run_failure("wsl.exe", stderr, b"").to_string();
        assert_eq!(
            msg,
            "wsl.exe failed: Access is denied.\r\nError code: Wsl/Service/E_ACCESSDENIED"
        );
    }

    #[test]
    fn run_failure_drops_blank_lines_only_next_to_dropped_chatter() {
        let stderr = format!("{NERDCTL_RUN_CHATTER}\n\n{NERDCTL_FATAL}\n");
        let msg = run_failure("limactl", stderr.as_bytes(), b"").to_string();
        assert_eq!(msg, format!("limactl failed: {NERDCTL_FATAL}"));

        let only_chatter = format!("{NERDCTL_RUN_CHATTER}\n\n{NERDCTL_RUN_CHATTER}");
        let msg = run_failure("limactl", only_chatter.as_bytes(), b"").to_string();
        assert!(msg.contains("Running ["), "got: {msg}");
        assert!(
            msg.contains("\n\n"),
            "blank line survives without a reduction: {msg:?}"
        );

        let msg = run_failure("wsl.exe", b"first\r\n\r\nsecond", b"").to_string();
        assert_eq!(msg, "wsl.exe failed: first\r\n\r\nsecond");
    }

    #[test]
    fn run_failure_with_empty_streams_has_an_empty_detail() {
        assert_eq!(
            run_failure("limactl", b"", b"").to_string(),
            "limactl failed: "
        );
    }

    #[test]
    fn run_failure_shaping_keeps_the_propagation_and_name_store_classifiers_working() {
        let enoent = format!(
            "{NERDCTL_RUN_CHATTER}\ntime=\"2026-09-16T10:00:01+02:00\" level=fatal msg=\"open /Users/u/.speedwave/compose/acme/compose.yml: no such file or directory\""
        );
        assert!(is_propagation_error(&run_failure(
            "limactl",
            enoent.as_bytes(),
            b""
        )));

        let name = own_name("acme", "mcp_hub");
        let conflict = format!(
            "{NERDCTL_RUN_CHATTER}\ntime=\"2026-09-16T10:00:01+02:00\" level=fatal msg=\"name-store error\\nname \\\"{name}\\\" is already used by ID \\\"{DEAD_ID}\\\"\""
        );
        let err = run_failure("limactl", conflict.as_bytes(), b"");
        assert_eq!(
            name_store_conflicts(&err, "acme"),
            vec![(name, DEAD_ID.to_string())]
        );

        let cni = format!(
            "{NERDCTL_RUN_CHATTER}\ntime=\"2026-09-16T10:00:01+02:00\" level=fatal msg=\"cni.setup failed: chain already exists\""
        );
        assert!(is_stale_cni_error(&run_failure(
            "limactl",
            cni.as_bytes(),
            b""
        )));
    }

    #[test]
    fn logrus_level_parses_only_logrus_text_lines() {
        assert_eq!(
            logrus_level("time=\"x\" level=info msg=\"y\""),
            Some("info")
        );
        assert_eq!(
            logrus_level("  time=\"x\" level=fatal msg=EOF"),
            Some("fatal")
        );
        assert_eq!(logrus_level("level=info msg=\"no time prefix\""), None);
        assert_eq!(
            logrus_level("ssh: connect to host lima port 60022: Connection refused"),
            None
        );
        assert_eq!(logrus_level(""), None);
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

        assert_eq!(runner.run("cmd", &["--flag"]).unwrap(), "text_response");
        assert_eq!(
            runner.run_raw_stdout("cmd", &["--flag"]).unwrap(),
            vec![0xFF, 0xFE, 0x41, 0x00]
        );
    }

    #[test]
    fn test_mock_runner_raw_fallback_to_run() {
        let runner = test_support::MockRunner::new().with_response("cmd --flag", "hello");

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

        let project = "cleanup-names-test".to_string();
        let tmp = tempfile::tempdir().unwrap();
        let compose_dir = tmp.path().join("compose").join(&project);
        std::fs::create_dir_all(&compose_dir).unwrap();

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

        force_remove_project_containers_in(tmp.path(), &runner, "nerdctl", &project, &[]);

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
        run_rm_force(&runner, "nerdctl", &[], &targets, false).unwrap();
        run_rm_force(&runner, "nerdctl", &[], &targets, true).unwrap();
    }

    #[test]
    fn run_rm_force_empty_targets_is_noop() {
        let runner = test_support::MockRunner::new();
        run_rm_force(&runner, "nerdctl", &[], &[], true).unwrap();
    }

    #[test]
    fn force_remove_containers_run_fn_receives_id_batch_then_each_name() {
        let project = "run-fn-batches".to_string();
        let tmp = tempfile::tempdir().unwrap();
        let compose_dir = tmp.path().join("compose").join(&project);
        std::fs::create_dir_all(&compose_dir).unwrap();
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
        force_remove_project_containers_with_run_fn_in(
            tmp.path(),
            &runner,
            "nerdctl",
            &project,
            &[],
            |targets| {
                batches_clone.lock().unwrap().push(targets.to_vec());
                Ok(())
            },
        );

        assert_eq!(
            batches.lock().unwrap().as_slice(),
            &[
                vec!["id-1".to_string(), "id-2".to_string()],
                vec!["speedwave_tmp_claude".to_string()],
            ]
        );
    }

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

    #[test]
    #[cfg(unix)]
    fn vm_exec_run_returns_on_deadline_while_a_grandchild_holds_the_pipes() {
        let start = std::time::Instant::now();
        let mut command = Command::new("sh");
        command.args(["-c", "sleep 30 & sleep 30"]);
        let err = vm_exec_run(command, b"", std::time::Duration::from_millis(200)).unwrap_err();
        assert!(err.to_string().contains("timed out"));
        assert!(
            start.elapsed() < std::time::Duration::from_secs(10),
            "an orphaned grandchild still holding stdout must not stretch the deadline, took {:?}",
            start.elapsed()
        );
    }

    #[test]
    #[cfg(unix)]
    fn vm_exec_run_returns_once_the_child_exits_while_a_grandchild_holds_the_pipes() {
        let start = std::time::Instant::now();
        let mut command = Command::new("sh");
        command.args(["-c", "sleep 30 & exit 0"]);
        let err = vm_exec_run(command, b"", std::time::Duration::from_secs(10)).unwrap_err();
        assert!(
            err.to_string().contains("still holds its output open"),
            "got: {err}"
        );
        assert!(
            start.elapsed() < std::time::Duration::from_secs(20),
            "a grandchild holding the pipes must not outlast the child by its own lifetime, took {:?}",
            start.elapsed()
        );
    }

    #[test]
    #[cfg(unix)]
    fn real_runner_run_raw_stdout_bounded_keeps_the_bytes_it_read() {
        let out = RealRunner
            .run_raw_stdout_bounded(
                "printf",
                &["\\377\\376S\\000"],
                std::time::Duration::from_secs(10),
            )
            .unwrap();
        assert_eq!(
            out,
            vec![0xFF, 0xFE, b'S', 0],
            "a UTF-16LE list from wsl.exe must reach its decoder unconverted"
        );
    }

    #[test]
    fn run_bounded_falls_back_to_run_for_runners_that_only_implement_run() {
        struct RunOnly;
        impl CommandRunner for RunOnly {
            fn run(&self, cmd: &str, args: &[&str]) -> anyhow::Result<String> {
                Ok(format!("{cmd} {}", args.join(" ")))
            }
        }
        let out = RunOnly
            .run_bounded("limactl", &["list"], std::time::Duration::from_secs(1))
            .unwrap();
        assert_eq!(out, "limactl list");
    }

    #[test]
    #[cfg(unix)]
    fn real_runner_run_bounded_returns_stdout() {
        let out = RealRunner
            .run_bounded(
                "sh",
                &["-c", "printf ok"],
                std::time::Duration::from_secs(5),
            )
            .unwrap();
        assert_eq!(out, "ok");
    }

    #[test]
    #[cfg(unix)]
    fn real_runner_run_bounded_keeps_stderr_in_the_error() {
        let err = RealRunner
            .run_bounded(
                "sh",
                &["-c", "echo 'no such image: x:1' >&2; exit 1"],
                std::time::Duration::from_secs(5),
            )
            .unwrap_err();
        assert!(
            err.to_string().contains("no such image: x:1"),
            "the verdict reads stderr, so it must survive, got: {err}"
        );
    }

    #[test]
    #[cfg(unix)]
    fn real_runner_run_bounded_gives_up_at_the_deadline() {
        let start = std::time::Instant::now();
        let err = RealRunner
            .run_bounded(
                "sh",
                &["-c", "sleep 30"],
                std::time::Duration::from_millis(200),
            )
            .unwrap_err();
        assert!(err.to_string().contains("timed out"));
        assert!(start.elapsed() < std::time::Duration::from_secs(10));
    }

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

    #[cfg(unix)]
    fn hanging_exec_command() -> Command {
        let mut c = crate::binary::system_command("sleep");
        c.arg("5");
        c
    }

    #[cfg(windows)]
    fn hanging_exec_command() -> Command {
        let mut c = crate::binary::system_command("ping");
        c.args(["-n", "6", "127.0.0.1"]);
        c
    }

    #[test]
    fn run_exec_probe_times_out_on_a_stalled_command_instead_of_hanging() {
        let start = std::time::Instant::now();
        let err = run_exec_probe(
            &mut hanging_exec_command(),
            std::time::Duration::from_millis(200),
        )
        .unwrap_err();
        assert!(err.to_string().contains("timed out"), "got: {err}");
        assert!(
            start.elapsed() < std::time::Duration::from_secs(5),
            "must not wait for the full 5s sleep, elapsed: {:?}",
            start.elapsed()
        );
    }

    #[test]
    fn probe_container_exec_with_timeout_succeeds_on_a_fast_exec() {
        let (rt, _handles) = MockRuntimeBuilder::new().build();
        probe_container_exec_with_timeout(&rt, "container", std::time::Duration::from_secs(5))
            .unwrap();
    }

    #[test]
    fn probe_container_exec_reports_stderr_text_on_a_nonzero_exit() {
        let (rt, _handles) = MockRuntimeBuilder::new()
            .push_exec_piped_failure("boom from nerdctl exec")
            .build();
        let err = probe_container_exec(&rt, "container").unwrap_err();
        assert!(
            err.to_string().contains("boom from nerdctl exec"),
            "got: {err}"
        );
    }

    #[test]
    fn classifiers_reject_the_run_with_timeout_capture_message_shape() {
        let msg = "command 'sh' timed out after 60s";
        assert!(!is_stale_container_error(msg));
        assert!(!is_missing_container_error_msg(msg));
        assert!(!is_stopped_container_error(msg));
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
    fn real_runner_run_with_timeout_reports_a_failure_while_a_grandchild_holds_stderr() {
        let start = std::time::Instant::now();
        let err = RealRunner
            .run_with_timeout(
                "sh",
                &["-c", "sleep 30 & exit 3"],
                std::time::Duration::from_secs(20),
            )
            .unwrap_err()
            .to_string();
        assert!(err.contains("exit code Some(3)"), "got: {err}");
        assert!(
            start.elapsed() < std::time::Duration::from_secs(20),
            "a grandchild holding stderr must not hold up the failure, took {:?}",
            start.elapsed()
        );
    }

    #[test]
    #[cfg(unix)]
    fn real_runner_run_with_timeout_drains_stderr_that_outgrows_the_pipe_buffer() {
        let result = RealRunner.run_with_timeout(
            "sh",
            &["-c", "head -c 300000 /dev/zero >&2"],
            std::time::Duration::from_secs(20),
        );
        assert!(
            result.is_ok(),
            "a child must not block on a full stderr pipe, got: {result:?}"
        );
    }

    #[test]
    #[cfg(unix)]
    fn real_runner_run_with_timeout_until_kills_the_command_once_told_to_stop() {
        let start = std::time::Instant::now();
        let finished = RealRunner
            .run_with_timeout_until(
                "sleep",
                &["30"],
                std::time::Duration::from_secs(20),
                &|| start.elapsed() >= std::time::Duration::from_millis(200),
            )
            .unwrap();
        assert!(
            !finished,
            "a command stopped early must not read as finished"
        );
        assert!(
            start.elapsed() < std::time::Duration::from_secs(10),
            "the command must die once told to stop, took {:?}",
            start.elapsed()
        );
    }

    #[test]
    #[cfg(unix)]
    fn real_runner_run_with_timeout_until_reports_how_the_command_ended() {
        assert!(RealRunner
            .run_with_timeout_until("true", &[], std::time::Duration::from_secs(10), &|| false)
            .unwrap());
        let err = RealRunner
            .run_with_timeout_until(
                "sh",
                &["-c", "echo refused >&2; exit 3"],
                std::time::Duration::from_secs(10),
                &|| false,
            )
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("exit code Some(3)") && err.contains("refused"),
            "got: {err}"
        );
    }

    #[test]
    #[cfg(unix)]
    fn real_runner_run_with_timeout_until_leaves_the_output_of_a_command_stopped_as_it_failed() {
        let dir = tempfile::tempdir().unwrap();
        let exited = dir.path().join("exited");
        let script = format!("sleep 30 & touch '{}'; exit 3", exited.display());
        let start = std::time::Instant::now();
        let finished = RealRunner
            .run_with_timeout_until(
                "sh",
                &["-c", &script],
                std::time::Duration::from_secs(20),
                &|| exited.exists(),
            )
            .unwrap();
        assert!(!finished);
        assert!(
            start.elapsed() < std::time::Duration::from_secs(3),
            "a command stopped during a teardown must not hold it up for its output, took {:?}",
            start.elapsed()
        );
    }

    #[test]
    #[cfg(unix)]
    fn real_runner_run_with_timeout_until_still_gives_up_at_the_deadline() {
        let err = RealRunner
            .run_with_timeout_until(
                "sleep",
                &["30"],
                std::time::Duration::from_millis(300),
                &|| false,
            )
            .unwrap_err();
        assert!(err.to_string().contains("timed out"), "got: {err}");
    }

    #[test]
    fn run_with_timeout_until_falls_back_to_run_with_timeout_for_test_runners() {
        struct TimedOnly {
            calls: Mutex<Vec<String>>,
        }
        impl CommandRunner for TimedOnly {
            fn run(&self, cmd: &str, args: &[&str]) -> anyhow::Result<String> {
                anyhow::bail!("unexpected run: {cmd} {}", args.join(" "))
            }
            fn run_with_timeout(
                &self,
                cmd: &str,
                args: &[&str],
                _timeout: std::time::Duration,
            ) -> anyhow::Result<()> {
                self.calls
                    .lock()
                    .unwrap()
                    .push(format!("{cmd} {}", args.join(" ")));
                Ok(())
            }
        }
        let runner = TimedOnly {
            calls: Mutex::new(Vec::new()),
        };
        assert!(runner
            .run_with_timeout_until(
                "limactl",
                &["start", "vm"],
                std::time::Duration::from_secs(1),
                &|| true
            )
            .unwrap());
        assert_eq!(*runner.calls.lock().unwrap(), vec!["limactl start vm"]);
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
    fn compose_validate_with_retry_retries_on_compose_file_enoent() {
        let (rt, handles) = MockRuntimeBuilder::new()
            .push_validate_result(Err(
                "limactl failed: time=\"2026-08-25T09:37:03+02:00\" level=fatal \
                 msg=\"open /Users/u/.speedwave/compose/proj/compose.yml: \
                 no such file or directory\""
                    .to_string(),
            ))
            .push_validate_result(Ok(()))
            .build();
        compose_validate_with_retry(&rt, "proj").unwrap();
        assert_eq!(handles.validate_calls.lock().unwrap().len(), 2);
    }

    #[test]
    #[expect(
        clippy::assertions_on_constants,
        reason = "SSOT guard: asserts COMPOSE_VALIDATE_MAX_ATTEMPTS stays sane"
    )]
    fn compose_validate_retry_window_is_long_enough_for_virtiofs_lag() {
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

    fn task_bundle_collision_err() -> anyhow::Error {
        anyhow::anyhow!(
            "limactl failed: time=\"2026-09-23T00:31:30+02:00\" level=fatal \
             msg=\"mkdir /run/containerd/io.containerd.runtime.v2.task/default/\
             572494980b1f1310f4fae98c7648e2058a1c19c047af6749bfc549f363e2e7de: file exists\"\n\
             time=\"2026-09-23T00:31:30+02:00\" level=fatal msg=\"error while creating container \
             speedwave_acme_proxy: error while creating container speedwave_acme_proxy: exit status 1\""
        )
    }

    fn heal_recording_settles<U>(up: U) -> (anyhow::Result<()>, Vec<std::time::Duration>)
    where
        U: Fn() -> anyhow::Result<()>,
    {
        let mut settles = Vec::new();
        let r = with_engine_state_heal_settling(
            "acme",
            &up,
            &up,
            |_t| -> anyhow::Result<()> { panic!("CNI cleanup must not run on a task collision") },
            |_e| -> anyhow::Result<()> {
                panic!("name-store cleanup must not run on a task collision")
            },
            |d| settles.push(d),
        );
        (r, settles)
    }

    fn task_already_registered_err() -> anyhow::Error {
        anyhow::anyhow!(
            "wsl.exe failed: time=\"2026-09-23T15:19:29+02:00\" level=fatal \
             msg=\"1 errors:\\ntask \
             1d5a4194220fe7d0373e802431ebc3fb00fcd05d62508bfbeeca837658cf00bd: \
             already exists\"\ntime=\"2026-09-23T15:19:29+02:00\" level=fatal \
             msg=\"error while starting existing container speedwave_e2e-second_proxy: \
             error while creating container speedwave_e2e-second_proxy: exit status 1\""
        )
    }

    #[test]
    fn engine_state_heal_waits_then_retries_once_when_another_start_holds_the_task_bundle() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let ups = AtomicUsize::new(0);
        let (r, settles) = heal_recording_settles(|| {
            if ups.fetch_add(1, Ordering::SeqCst) == 0 {
                Err(task_bundle_collision_err())
            } else {
                Ok(())
            }
        });
        assert!(r.is_ok(), "the retry after the collision succeeds: {r:?}");
        assert_eq!(ups.load(Ordering::SeqCst), 2, "up runs twice");
        assert_eq!(
            settles,
            vec![TASK_CREATE_COLLISION_SETTLE],
            "waits once before the retry"
        );
    }

    #[test]
    fn engine_state_heal_retries_a_task_bundle_collision_only_once() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let ups = AtomicUsize::new(0);
        let (r, settles) = heal_recording_settles(|| {
            ups.fetch_add(1, Ordering::SeqCst);
            Err(task_bundle_collision_err())
        });
        let err = r.expect_err("a collision that persists must propagate");
        assert!(err.to_string().contains("file exists"), "got: {err}");
        assert_eq!(ups.load(Ordering::SeqCst), 2, "exactly one retry");
        assert_eq!(settles.len(), 1, "one wait for the one retry");
    }

    #[test]
    fn engine_state_heal_does_not_retry_a_file_exists_outside_the_task_bundles() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let ups = AtomicUsize::new(0);
        let (r, settles) = heal_recording_settles(|| {
            ups.fetch_add(1, Ordering::SeqCst);
            anyhow::bail!(
                "level=fatal msg=\"mkdir /var/lib/nerdctl/1935db59/containers/default/\
                 572494980b1f1310f4fae98c7648e2058a1c19c047af6749bfc549f363e2e7de: file exists\""
            )
        });
        assert!(r.is_err());
        assert_eq!(ups.load(Ordering::SeqCst), 1, "no retry for another path");
        assert!(settles.is_empty(), "no wait without a retry");
    }

    #[test]
    fn engine_state_heal_waits_then_retries_once_when_another_start_already_registered_the_task() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let ups = AtomicUsize::new(0);
        let (r, settles) = heal_recording_settles(|| {
            if ups.fetch_add(1, Ordering::SeqCst) == 0 {
                Err(task_already_registered_err())
            } else {
                Ok(())
            }
        });
        assert!(r.is_ok(), "the retry after the collision succeeds: {r:?}");
        assert_eq!(ups.load(Ordering::SeqCst), 2, "up runs twice");
        assert_eq!(
            settles,
            vec![TASK_CREATE_COLLISION_SETTLE],
            "waits once before the retry"
        );
    }

    #[test]
    fn engine_state_heal_does_not_retry_an_already_exists_that_names_no_task() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        for raw in [
            "level=fatal msg=\"task 1d5a4194: already exists\"",
            "level=fatal msg=\"network speedwave_acme_network already exists\"",
            "level=fatal msg=\"task \u{00e9}\
             1d5a4194220fe7d0373e802431ebc3fb00fcd05d62508bfbeeca837658cf00bd: already exists\"",
        ] {
            let ups = AtomicUsize::new(0);
            let (r, settles) = heal_recording_settles(|| {
                ups.fetch_add(1, Ordering::SeqCst);
                anyhow::bail!("{raw}")
            });
            assert!(r.is_err(), "{raw}");
            assert_eq!(ups.load(Ordering::SeqCst), 1, "no retry for: {raw}");
            assert!(settles.is_empty(), "no wait for: {raw}");
        }
    }

    #[test]
    fn engine_state_heal_rejoins_the_raced_container_instead_of_rerunning_up() {
        let calls = std::sync::Mutex::new(Vec::new());
        let mut settles = Vec::new();
        let r = with_engine_state_heal_settling(
            "acme",
            || {
                calls.lock().unwrap().push("up");
                Err(task_already_registered_err())
            },
            || {
                calls.lock().unwrap().push("rejoin");
                Ok(())
            },
            |_t| -> anyhow::Result<()> { panic!("CNI cleanup must not run on a task collision") },
            |_e| -> anyhow::Result<()> {
                panic!("name-store cleanup must not run on a task collision")
            },
            |d| settles.push(d),
        );
        assert!(r.is_ok(), "the rejoin settles the race: {r:?}");
        assert_eq!(*calls.lock().unwrap(), ["up", "rejoin"]);
        assert_eq!(settles, vec![TASK_CREATE_COLLISION_SETTLE]);
    }

    #[test]
    fn a_task_collision_rejoins_a_single_service_without_recreating_it_again() {
        assert_eq!(
            UpMode::Service("proxy").after_task_collision(),
            UpMode::Rejoin("proxy")
        );
        assert_eq!(
            UpMode::Rejoin("proxy").after_task_collision(),
            UpMode::Rejoin("proxy")
        );
        assert_eq!(UpMode::All.after_task_collision(), UpMode::All);
        assert_eq!(UpMode::Diverged.after_task_collision(), UpMode::Diverged);
        let argv = compose_up_argv("/c/compose.yml", "acme", UpMode::Rejoin("proxy"));
        assert_eq!(argv[argv.len() - 3..], ["up", "-d", "proxy"], "{argv:?}");
        assert!(!argv.iter().any(|a| a == "--force-recreate"), "{argv:?}");
    }

    #[test]
    fn engine_state_heal_allows_another_task_collision_retry_after_a_cni_heal() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let attempts = AtomicUsize::new(0);
        let calls = std::sync::Mutex::new(Vec::new());
        let attempt = |kind: &'static str| {
            calls.lock().unwrap().push(kind);
            match attempts.fetch_add(1, Ordering::SeqCst) {
                0 => Err(task_bundle_collision_err()),
                1 => anyhow::bail!(
                    "iptables -t nat -N CNI-7d758820f15d96676b3d9851: Chain already exists"
                ),
                2 => Err(task_already_registered_err()),
                _ => Ok(()),
            }
        };
        let cni_cleaned = AtomicUsize::new(0);
        let mut settles = Vec::new();
        let r = with_engine_state_heal_settling(
            "e2e-second",
            || attempt("up"),
            || attempt("rejoin"),
            |_t| {
                cni_cleaned.fetch_add(1, Ordering::SeqCst);
                Ok(())
            },
            |_e| -> anyhow::Result<()> { panic!("name-store cleanup must not run") },
            |d| settles.push(d),
        );
        assert!(
            r.is_ok(),
            "the race after the CNI heal gets its own retry: {r:?}"
        );
        assert_eq!(
            *calls.lock().unwrap(),
            ["up", "rejoin", "up", "rejoin"],
            "a collision is followed by a rejoin, any other heal by a full up"
        );
        assert_eq!(cni_cleaned.load(Ordering::SeqCst), 1, "CNI heal ran once");
        assert_eq!(settles.len(), 2, "one wait per collision retry");
    }

    #[test]
    fn engine_state_heal_heals_all_three_classes_in_one_up() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let attempts = AtomicUsize::new(0);
        let calls = std::sync::Mutex::new(Vec::new());
        let name = own_name("acme", "mcp_hub");
        let attempt = |kind: &'static str| {
            calls.lock().unwrap().push(kind);
            match attempts.fetch_add(1, Ordering::SeqCst) {
                0 => anyhow::bail!("iptables: Chain already exists"),
                1 => Err(ns_conflict_err(&name, DEAD_ID)),
                2 => Err(task_bundle_collision_err()),
                _ => Ok(()),
            }
        };
        let cni_cleaned = AtomicUsize::new(0);
        let ns_cleaned = AtomicUsize::new(0);
        let mut settles = Vec::new();
        let r = with_engine_state_heal_settling(
            "acme",
            || attempt("up"),
            || attempt("rejoin"),
            |_t| {
                cni_cleaned.fetch_add(1, Ordering::SeqCst);
                Ok(())
            },
            |_e| {
                ns_cleaned.fetch_add(1, Ordering::SeqCst);
                Ok(())
            },
            |d| settles.push(d),
        );
        assert!(r.is_ok(), "the fourth up succeeds after three heals: {r:?}");
        assert_eq!(*calls.lock().unwrap(), ["up", "up", "up", "rejoin"]);
        assert_eq!(cni_cleaned.load(Ordering::SeqCst), 1, "CNI heal ran once");
        assert_eq!(
            ns_cleaned.load(Ordering::SeqCst),
            1,
            "name-store heal ran once"
        );
        assert_eq!(settles.len(), 1, "one wait for the collision retry");
    }

    #[test]
    fn engine_contract_bats_pins_the_task_collision_and_up_deadline_phrases() {
        let bats = include_str!("../../../../_tests/e2e/engine-contract.bats");
        assert!(
            bats.contains(&format!(
                "TASKS=/run/containerd/{TASK_BUNDLE_DIR_FRAGMENT}{}",
                consts::CONTAINERD_NAMESPACE
            )),
            "engine-contract.bats TASKS= must be the task bundle root the collision heal keys on"
        );
        assert!(
            bats.contains(&format!("task $PAUSED_ID{TASK_ALREADY_EXISTS_FRAGMENT}")),
            "engine-contract.bats must pin containerd's registered-task text the heal keys on"
        );
        assert!(
            bats.contains(&format!("{COMPOSE_UP_DEADLINE_FRAGMENT} to command")),
            "engine-contract.bats must pin the timeout line explain_compose_up_deadline keys on"
        );
    }

    #[test]
    fn e2e_restart_wait_outlasts_an_up_stopped_at_the_deadline_and_its_rollback() {
        let helper = include_str!("../../../../desktop/e2e/helpers/shell.ts");
        let wait_ms: u64 = helper
            .lines()
            .find_map(|line| line.strip_prefix("export const RESTART_WAIT_MS = "))
            .and_then(|value| value.trim_end_matches(';').replace('_', "").parse().ok())
            .expect("shell.ts must export RESTART_WAIT_MS as a numeric literal");
        assert!(
            wait_ms >= 2 * COMPOSE_UP_TIMEOUT_SECS * 1000,
            "RESTART_WAIT_MS ({wait_ms} ms) must outlast an up stopped at the deadline plus its rollback up"
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
        assert!(is_propagation_error(&anyhow::anyhow!(
            "validating compose.yml: networks.x_network.driver must be a string"
        )));
        assert!(is_propagation_error(&anyhow::anyhow!(
            "yaml: line 12: could not find expected ':'"
        )));
        assert!(is_propagation_error(&anyhow::anyhow!(
            "yaml: line 8: did not find expected key"
        )));
        assert!(is_propagation_error(&anyhow::anyhow!(
            "failed to parse compose.yml: yaml: line 365: found unexpected end of stream"
        )));
        assert!(is_propagation_error(&anyhow::anyhow!(
            "validating compose.yml: services.mcp-office.deploy.resources.limits.cpus must be a number or string"
        )));
        assert!(is_propagation_error(&anyhow::anyhow!(
            "validating compose.yml: services.mcp-office.deploy.resources.limits.memory must be a string"
        )));
    }

    #[test]
    fn is_propagation_error_matches_compose_file_enoent() {
        assert!(is_propagation_error(&anyhow::anyhow!(
            "limactl failed: time=\"2026-08-25T09:37:03+02:00\" level=fatal msg=\"open /Users/u/.speedwave/compose/proj/compose.yml: no such file or directory\""
        )));
        assert!(is_propagation_error(&anyhow::anyhow!(
            "wsl failed: time=\"2026-08-25T09:37:03+02:00\" level=fatal msg=\"open /mnt/c/Users/u/.speedwave/compose/proj/compose.yml: no such file or directory\""
        )));
    }

    #[test]
    fn is_propagation_error_rejects_unrelated() {
        assert!(!is_propagation_error(&anyhow::anyhow!(
            "connection refused"
        )));
        assert!(!is_propagation_error(&anyhow::anyhow!("EOF")));
        assert!(!is_propagation_error(&anyhow::anyhow!(
            "validating compose.yml: services.claude.image must be a string"
        )));
        assert!(!is_propagation_error(&anyhow::anyhow!(
            "open /Users/u/.speedwave/tokens/proj/slack/token: no such file or directory"
        )));
    }

    #[test]
    fn is_propagation_error_yaml_scanner_phrases_are_intentionally_retried() {
        assert!(is_propagation_error(&anyhow::anyhow!(
            "yaml: line 5: could not find expected ':'"
        )));
        assert!(is_propagation_error(&anyhow::anyhow!(
            "yaml: line 9: did not find expected node content"
        )));
    }

    #[test]
    fn is_propagation_error_handles_mixed_case() {
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

    const CHAIN_A: &str = "CNI-d3c42d65590ae0cf2c72261f";
    const CHAIN_B: &str = "CNI-1be9c452999fb96d888571d2";
    const CHAIN_C: &str = "CNI-0f1e2d3c4b5a69788796a5b4";

    fn stale_chain_failure(chain: &str) -> anyhow::Error {
        anyhow::anyhow!(
            r##"wsl.exe failed: time="2026-09-23T01:10:08+02:00" level=fatal msg="1 errors:\nfailed to create shim task: OCI runtime create failed: runc create failed: unable to start container process: error during container init: error running createRuntime hook #0: exit status 1, stdout: , stderr: time=\"2026-09-23T01:10:07+02:00\" level=warning msg=\"Container failed starting. Removing allocated network configuration.\"\ntime=\"2026-09-23T01:10:08+02:00\" level=fatal msg=\"failed to call cni.Setup: plugin type=\\\"bridge\\\" failed (add): running [/usr/sbin/iptables -t nat -N {chain} --wait]: exit status 1: iptables: Chain already exists.\\n\""
time="2026-09-23T01:10:08+02:00" level=fatal msg="error while starting existing container speedwave_e2e-second_proxy: error while creating container speedwave_e2e-second_proxy: exit status 1""##
        )
    }

    fn masquerade_rule_failure(chain: &str) -> anyhow::Error {
        anyhow::anyhow!(
            "failed to call cni.Setup: plugin type=\"bridge\" failed (add): running [/usr/sbin/iptables -t nat -A {chain} -d 10.4.0.0/24 -j ACCEPT --wait]: exit status 4: iptables: Resource temporarily unavailable."
        )
    }

    fn bridge_address_failure(bridge: &str) -> anyhow::Error {
        anyhow::anyhow!(
            "failed to call cni.Setup: bridge {bridge} already has an IP address different from 10.4.1.1/24"
        )
    }

    struct HealRun {
        result: anyhow::Result<()>,
        ups: usize,
        cni_heal_targets: Vec<Vec<String>>,
        name_store_heals: usize,
    }

    fn run_heal(failures: Vec<anyhow::Error>) -> HealRun {
        run_heal_with(failures, || Ok(()))
    }

    fn run_heal_with(
        failures: Vec<anyhow::Error>,
        cni_cleanup_outcome: impl Fn() -> anyhow::Result<()>,
    ) -> HealRun {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let failures = std::sync::Mutex::new(std::collections::VecDeque::from(failures));
        let ups = AtomicUsize::new(0);
        let mut cni_heal_targets = Vec::new();
        let mut name_store_heals = 0;
        let up = || {
            ups.fetch_add(1, Ordering::SeqCst);
            failures.lock().unwrap().pop_front().map_or(Ok(()), Err)
        };
        let result = with_engine_state_heal(
            "acme",
            up,
            up,
            |cni_targets| {
                cni_heal_targets.push(cni_targets.ids().cloned().collect());
                cni_cleanup_outcome()
            },
            |_e| {
                name_store_heals += 1;
                Ok(())
            },
        );
        HealRun {
            result,
            ups: ups.into_inner(),
            cni_heal_targets,
            name_store_heals,
        }
    }

    fn heal_targets(heals: &[&[&str]]) -> Vec<Vec<String>> {
        heals
            .iter()
            .map(|ids| ids.iter().map(ToString::to_string).collect())
            .collect()
    }

    #[test]
    fn engine_state_heal_cleans_and_retries_on_a_cni_error() {
        let run = run_heal(vec![anyhow::anyhow!("iptables: Chain already exists")]);
        assert!(run.result.is_ok(), "{:?}", run.result);
        assert_eq!(run.ups, 2, "a failed up, then the retry");
        assert_eq!(run.cni_heal_targets, vec![Vec::<String>::new()]);
        assert_eq!(run.name_store_heals, 0);
    }

    #[test]
    fn engine_state_heal_skips_cleanup_and_retry_on_other_error() {
        let run = run_heal(vec![anyhow::anyhow!("no such image")]);
        assert!(run.result.is_err());
        assert_eq!(run.ups, 1, "no retry");
        assert!(run.cni_heal_targets.is_empty());
        assert_eq!(run.name_store_heals, 0);
    }

    #[test]
    fn engine_state_heal_retries_even_if_cleanup_fails() {
        let run = run_heal_with(
            vec![anyhow::anyhow!("iptables: Chain already exists")],
            || anyhow::bail!("cleanup blew up"),
        );
        assert!(
            run.result.is_ok(),
            "a cleanup failure is non-fatal, the retry still runs: {:?}",
            run.result
        );
        assert_eq!(run.ups, 2);
    }

    #[test]
    fn engine_state_heal_runs_both_classes_across_two_retries() {
        let run = run_heal(vec![
            anyhow::anyhow!("iptables: Chain already exists"),
            ns_conflict_err(&own_name("acme", "mcp_hub"), DEAD_ID),
        ]);
        assert!(
            run.result.is_ok(),
            "third up succeeds after both heals: {:?}",
            run.result
        );
        assert_eq!(run.ups, 3);
        assert_eq!(run.cni_heal_targets.len(), 1);
        assert_eq!(run.name_store_heals, 1);
    }

    #[test]
    fn engine_state_heal_propagates_a_retry_error_outside_every_heal_class() {
        let run = run_heal(vec![
            anyhow::anyhow!("iptables: Chain already exists"),
            anyhow::anyhow!("still broken after cleanup"),
        ]);
        let err = run.result.expect_err("the retry's failure must propagate");
        assert!(
            err.to_string().contains("still broken after cleanup"),
            "the retry error propagates, not the first: {err}"
        );
        assert_eq!(run.ups, 2, "a failure no heal class matches ends the loop");
    }

    #[test]
    fn engine_state_heal_keeps_healing_while_each_collision_names_a_new_chain() {
        let run = run_heal(vec![
            stale_chain_failure(CHAIN_A),
            stale_chain_failure(CHAIN_B),
            stale_chain_failure(CHAIN_C),
        ]);
        assert!(
            run.result.is_ok(),
            "every stale chain the retries uncover is healed: {:?}",
            run.result
        );
        assert_eq!(run.ups, 4, "three failed ups, then success");
        assert_eq!(
            run.cni_heal_targets,
            heal_targets(&[&[CHAIN_A], &[CHAIN_B], &[CHAIN_C]]),
            "each heal flushes the chain its own failure names"
        );
        assert_eq!(run.name_store_heals, 0);
    }

    #[test]
    fn engine_state_heal_flushes_only_the_state_a_failure_newly_names() {
        let run = run_heal(vec![
            stale_chain_failure(CHAIN_A),
            anyhow::anyhow!(
                "{}\n{}",
                stale_chain_failure(CHAIN_A),
                stale_chain_failure(CHAIN_B)
            ),
        ]);
        assert!(run.result.is_ok(), "{:?}", run.result);
        assert_eq!(
            run.cni_heal_targets,
            heal_targets(&[&[CHAIN_A], &[CHAIN_B]]),
            "a chain flushed earlier may belong to a container the last retry started"
        );
    }

    #[test]
    fn engine_state_heal_repeats_only_for_the_chain_a_collision_names() {
        let run = run_heal(vec![
            stale_chain_failure(CHAIN_A),
            anyhow::anyhow!(
                "{}\n{}",
                stale_chain_failure(CHAIN_A),
                masquerade_rule_failure(CHAIN_B)
            ),
            stale_chain_failure(CHAIN_C),
        ]);
        let err = run
            .result
            .expect_err("a chain that failed for another reason is no stale state");
        assert!(err.to_string().contains(CHAIN_B), "latest error: {err}");
        assert_eq!(run.ups, 2);
        assert_eq!(run.cni_heal_targets, heal_targets(&[&[CHAIN_A]]));
    }

    #[test]
    fn engine_state_heal_gives_up_when_a_retry_fails_on_a_flushed_chain() {
        let run = run_heal(vec![
            stale_chain_failure(CHAIN_A),
            stale_chain_failure(CHAIN_A),
            stale_chain_failure(CHAIN_B),
        ]);
        let err = run
            .result
            .expect_err("a chain the heal already flushed must not be healed again");
        assert!(err.to_string().contains(CHAIN_A), "latest error: {err}");
        assert_eq!(run.ups, 2);
        assert_eq!(run.cni_heal_targets, heal_targets(&[&[CHAIN_A]]));
    }

    #[test]
    fn engine_state_heal_ends_when_a_failed_cleanup_leaves_the_chain_colliding() {
        let run = run_heal_with(
            vec![
                stale_chain_failure(CHAIN_A),
                stale_chain_failure(CHAIN_A),
                stale_chain_failure(CHAIN_B),
            ],
            || anyhow::bail!("wsl.exe failed: the cleanup did not run"),
        );
        let err = run
            .result
            .expect_err("a chain the cleanup could not flush is targeted once");
        assert!(err.to_string().contains(CHAIN_A), "latest error: {err}");
        assert_eq!(run.ups, 2);
        assert_eq!(run.cni_heal_targets, heal_targets(&[&[CHAIN_A]]));
    }

    #[test]
    fn engine_state_heal_gives_up_when_a_retry_names_no_cni_state() {
        let run = run_heal(vec![
            stale_chain_failure(CHAIN_A),
            anyhow::anyhow!(
                "failed to call cni.Setup: failed to allocate for range 0: 10.4.0.4 has been allocated, duplicate allocation is not allowed"
            ),
        ]);
        let err = run
            .result
            .expect_err("a failure naming nothing new ends the heal");
        assert!(
            err.to_string().contains("duplicate allocation"),
            "latest error: {err}"
        );
        assert_eq!(run.ups, 2);
        assert_eq!(run.cni_heal_targets, heal_targets(&[&[CHAIN_A]]));
    }

    #[test]
    fn engine_state_heal_heals_a_cni_failure_naming_nothing_only_once() {
        let run = run_heal(vec![
            anyhow::anyhow!("iptables: Chain already exists"),
            anyhow::anyhow!("iptables: Chain already exists"),
            anyhow::anyhow!("iptables: Chain already exists"),
        ]);
        assert!(run.result.is_err());
        assert_eq!(
            run.ups, 2,
            "the first CNI failure heals even when it names nothing"
        );
        assert_eq!(run.cni_heal_targets, vec![Vec::<String>::new()]);
    }

    #[test]
    fn engine_state_heal_heals_a_failure_that_is_no_collision_only_once() {
        let run = run_heal(vec![
            masquerade_rule_failure(CHAIN_A),
            masquerade_rule_failure(CHAIN_B),
            masquerade_rule_failure(CHAIN_C),
        ]);
        let err = run.result.expect_err(
            "a recreate names a fresh chain every time, so only a collision proves stale state",
        );
        assert!(err.to_string().contains(CHAIN_B), "latest error: {err}");
        assert_eq!(run.ups, 2);
        assert_eq!(run.cni_heal_targets, heal_targets(&[&[CHAIN_A]]));
    }

    #[test]
    fn engine_state_heal_heals_a_collision_after_a_first_heal_that_was_no_collision() {
        let run = run_heal(vec![
            masquerade_rule_failure(CHAIN_A),
            stale_chain_failure(CHAIN_B),
        ]);
        assert!(run.result.is_ok(), "{:?}", run.result);
        assert_eq!(run.ups, 3);
        assert_eq!(
            run.cni_heal_targets,
            heal_targets(&[&[CHAIN_A], &[CHAIN_B]])
        );
    }

    #[test]
    fn engine_state_heal_stops_after_max_cni_heals() {
        let run = run_heal(
            (0..MAX_CNI_HEALS + 2)
                .map(|i| stale_chain_failure(&format!("CNI-{i:024x}")))
                .collect(),
        );
        let err = run
            .result
            .expect_err("an engine naming a fresh chain on every retry must not loop forever");
        assert!(
            err.to_string()
                .contains(&format!("CNI-{MAX_CNI_HEALS:024x}")),
            "latest error: {err}"
        );
        assert_eq!(run.cni_heal_targets.len(), MAX_CNI_HEALS);
        assert_eq!(run.ups, MAX_CNI_HEALS + 1);
    }

    #[test]
    fn engine_state_heal_deletes_a_bridge_only_in_the_first_heal() {
        let run = run_heal(vec![
            bridge_address_failure("br-0a1b2c3d4e5f"),
            bridge_address_failure("br-6a7b8c9d0e1f"),
        ]);
        let err = run
            .result
            .expect_err("a bridge is shared by every container on its network");
        assert!(
            err.to_string().contains("br-6a7b8c9d0e1f"),
            "latest error: {err}"
        );
        assert_eq!(run.ups, 2);
        assert_eq!(run.cni_heal_targets, heal_targets(&[&["br-0a1b2c3d4e5f"]]));
    }

    #[test]
    fn engine_state_heal_heals_a_new_chain_after_a_name_store_heal() {
        let run = run_heal(vec![
            stale_chain_failure(CHAIN_A),
            ns_conflict_err(&own_name("acme", "mcp_hub"), DEAD_ID),
            stale_chain_failure(CHAIN_B),
        ]);
        assert!(run.result.is_ok(), "{:?}", run.result);
        assert_eq!(run.ups, 4);
        assert_eq!(
            run.cni_heal_targets,
            heal_targets(&[&[CHAIN_A], &[CHAIN_B]])
        );
        assert_eq!(run.name_store_heals, 1);
    }

    #[test]
    fn engine_state_heal_heals_name_store_at_most_once() {
        let name = own_name("acme", "mcp_hub");
        let run = run_heal(vec![
            ns_conflict_err(&name, DEAD_ID),
            ns_conflict_err(&name, DEAD_ID),
        ]);
        assert!(run.result.is_err());
        assert_eq!(run.ups, 2);
        assert_eq!(run.name_store_heals, 1);
        assert!(run.cni_heal_targets.is_empty());
    }

    #[test]
    fn cni_targets_take_colliding_chains_only_from_their_own_segment() {
        let err = anyhow::anyhow!(
            "{}\n{}",
            stale_chain_failure(CHAIN_A),
            masquerade_rule_failure(CHAIN_B)
        );
        let colliding: Vec<String> = CniTargets::colliding_chains_in(&err)
            .ids()
            .cloned()
            .collect();
        assert_eq!(colliding, vec![CHAIN_A.to_string()]);
        let named: Vec<String> = CniTargets::named_in(&err).ids().cloned().collect();
        assert_eq!(named, vec![CHAIN_B.to_string(), CHAIN_A.to_string()]);
    }

    #[test]
    fn cni_cleanup_command_skips_ids_that_are_not_cni_tokens() {
        let targets = CniTargets {
            chains: vec![
                "CNI-68fe31e0".to_string(),
                "CNI-$(touch /tmp/pwned)".to_string(),
                "CNI-".to_string(),
            ],
            bridges: vec!["br-deadbeef".to_string(), "br-x;reboot".to_string()],
        };
        let script = decode_payload(&cni_cleanup_command(&targets));
        assert!(
            script.contains("iptables -t nat -X CNI-68fe31e0"),
            "{script}"
        );
        assert!(script.contains("ip link delete br-deadbeef"), "{script}");
        assert!(
            !script.contains("touch"),
            "a chain id that is no hex token must never reach the root script: {script}"
        );
        assert!(
            !script.contains("reboot"),
            "a bridge id that is no hex token must never reach the root script: {script}"
        );
        assert!(
            !script.contains("-X CNI- "),
            "an empty chain id must never reach the root script: {script}"
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
    fn scan_cni_ids_excludes_shared_hostport_infrastructure_chains() {
        let s =
            "CNI-HOSTPORT-DNAT CNI-HOSTPORT-SETMARK CNI-HOSTPORT-MASQ CNI-DN-abcdef CNI-68fe31e0";
        assert_eq!(
            scan_cni_ids(s, "CNI-"),
            vec!["CNI-68fe31e0"],
            "only the per-container hex chain is targeted; shared HOSTPORT/DN chains are spared"
        );
    }

    #[test]
    fn cni_cleanup_command_is_quote_free_base64_pipe() {
        let cmd = cni_cleanup_command(&CniTargets::named_in(&anyhow::anyhow!(
            "iptables: Chain already exists"
        )));
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
        let script = decode_payload(&cni_cleanup_command(&CniTargets::named_in(
            &anyhow::anyhow!(
                "iptables -t nat -N CNI-68fe31e0 --wait: iptables: Chain already exists"
            ),
        )));
        assert!(script.contains("iptables -t nat -F CNI-68fe31e0"));
        assert!(script.contains("iptables -t nat -X CNI-68fe31e0"));
        assert!(script.contains("eval \"iptables -t nat $r\""));
        assert!(script.contains("while IFS= read -r r"));
        assert!(
            script.contains(
                "case \"$r\" in *'$'*|*'`'*|*';'*|*'|'*|*'&'*|*'<'*|*'>'*) continue;; esac"
            ),
            "eval must skip any rule line with a shell metacharacter (root command-substitution sink): {script}"
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

        let bare = decode_payload(&cni_cleanup_command(&CniTargets::named_in(
            &anyhow::anyhow!("failed to call cni.Setup: plugin failed (add)"),
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

        let cmd = cni_cleanup_command(&CniTargets::named_in(&anyhow::anyhow!(
            "CNI-68fe31e0 and CNI-deadbeef: iptables: Chain already exists"
        )));
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

        assert!(!pwned.exists(), "command substitution must never execute");
        assert!(
            !calls
                .iter()
                .any(|c| c.contains(&"-D".to_string()) && c.iter().any(|a| a.contains("deadbeef"))),
            "guarded line must be skipped, not evaluated"
        );
    }

    /// Raw nerdctl stderr for a name-store conflict, with logrus-escaped inner quotes.
    fn ns_conflict_err(name: &str, id: &str) -> anyhow::Error {
        anyhow::anyhow!(
            "limactl failed: time=\"2026-07-14T10:50:38+02:00\" level=fatal \
             msg=\"name-store error\\nname \\\"{name}\\\" is already used by ID \\\"{id}\\\"\""
        )
    }

    fn own_name(project: &str, service: &str) -> String {
        format!("{}_{}_{service}", consts::compose_prefix(), project)
    }

    const DEAD_ID: &str = "db0da85287aa1119f5ef5483d7585c28ef721cf946111cf8d5369d308ecf450e";

    #[test]
    fn name_store_conflicts_parses_real_nerdctl_message() {
        let name = own_name("acme", "mcp_hub");
        let got = name_store_conflicts(&ns_conflict_err(&name, DEAD_ID), "acme");
        assert_eq!(got, vec![(name, DEAD_ID.to_string())]);
    }

    #[test]
    fn name_store_conflicts_requires_both_phrases_and_a_pair() {
        let name = own_name("acme", "mcp_hub");
        let no_store = anyhow::anyhow!("name \"{name}\" is already used by ID \"{DEAD_ID}\"");
        assert!(name_store_conflicts(&no_store, "acme").is_empty());
        let no_used = anyhow::anyhow!("name-store error: something else about {name}");
        assert!(name_store_conflicts(&no_used, "acme").is_empty());
        assert!(name_store_conflicts(&anyhow::anyhow!("no such image"), "acme").is_empty());
    }

    #[test]
    fn name_store_conflicts_scopes_names_by_project_prefix() {
        let foreign = own_name("other", "mcp_hub");
        assert!(name_store_conflicts(&ns_conflict_err(&foreign, DEAD_ID), "acme").is_empty());
        let nested = own_name("foo_bar", "mcp_hub");
        assert_eq!(
            name_store_conflicts(&ns_conflict_err(&nested, DEAD_ID), "foo_bar").len(),
            1
        );
        assert_eq!(
            name_store_conflicts(&ns_conflict_err(&nested, DEAD_ID), "foo").len(),
            1,
            "prefix-matching parse is accepted; the target is still exact and fail-closed"
        );
    }

    #[test]
    fn name_store_conflicts_validates_id_shape() {
        let name = own_name("acme", "mcp_hub");
        let short = &DEAD_ID[..63];
        assert!(name_store_conflicts(&ns_conflict_err(&name, short), "acme").is_empty());
        let upper = DEAD_ID.to_uppercase();
        assert!(name_store_conflicts(&ns_conflict_err(&name, &upper), "acme").is_empty());
        assert_eq!(
            name_store_conflicts(&ns_conflict_err(&name, ""), "acme"),
            vec![(name, String::new())]
        );
    }

    #[test]
    fn name_store_conflicts_dedups_repeated_names() {
        let name = own_name("acme", "mcp_hub");
        let msg = anyhow::anyhow!(
            "name-store error\\nname \\\"{name}\\\" is already used by ID \\\"{DEAD_ID}\\\" \
             and again name \\\"{name}\\\" is already used by ID \\\"{DEAD_ID}\\\""
        );
        assert_eq!(name_store_conflicts(&msg, "acme").len(), 1);
    }

    fn test_layout(data_root: &str) -> NameStoreLayout {
        NameStoreLayout {
            data_root: data_root.to_string(),
            nerdctl_bin: "nerdctl".to_string(),
        }
    }

    #[test]
    fn name_store_heal_command_is_fail_closed_and_lock_guarded() {
        let name = own_name("acme", "mcp_hub");
        let cmd = name_store_heal_command_in(
            &test_layout("/var/lib/nerdctl"),
            &ns_conflict_err(&name, DEAD_ID),
            "acme",
        );
        let script = decode_payload(&cmd);
        assert!(script.contains(&format!("heal_entry \"$store/{name}\"")));
        for flag in ["--address", "--namespace", "--data-root"] {
            assert!(script.contains(flag), "inspect must pass {flag}");
        }
        assert!(script.contains("no such object $id"), "ID-bound signature");
        assert!(
            script.contains("[ \"$rc\" -ne 0 ]"),
            "non-zero exit required"
        );
        assert!(
            script.contains("command -v flock"),
            "missing flock -> no-op"
        );
        let inspect_pos = script.find("inspect \"$id\"").expect("inspect present");
        let rm_pos = script
            .rfind("flock -w 5 \"$store\" sh -c '[ \"$(cat")
            .expect("locked rm present");
        assert!(
            inspect_pos < rm_pos,
            "proof runs before the locked destructive step"
        );
        assert!(
            script.contains(&format!(
                "{}/{}/names/{}",
                "/var/lib/nerdctl",
                consts::nerdctl_addr_hash(),
                consts::CONTAINERD_NAMESPACE
            )),
            "exact computed store path, no globbing"
        );
    }

    #[test]
    fn name_store_heal_command_drops_foreign_and_unsafe_names() {
        let foreign = own_name("other", "mcp_hub");
        let cmd = name_store_heal_command_in(
            &test_layout("/var/lib/nerdctl"),
            &ns_conflict_err(&foreign, DEAD_ID),
            "acme",
        );
        let script = decode_payload(&cmd);
        assert!(
            !script.contains("heal_entry \"$store/"),
            "no targets -> no heal_entry lines"
        );
    }

    #[test]
    fn name_store_sweep_command_skips_longer_registered_prefixes() {
        let registered = vec!["foo".to_string(), "foo_bar".to_string()];
        let cmd = name_store_sweep_command_in(&test_layout("/var/lib/nerdctl"), "foo", &registered);
        let script = decode_payload(&cmd);
        let own = format!("{}_foo_", consts::compose_prefix());
        let longer = format!("{}_foo_bar_", consts::compose_prefix());
        assert!(script.contains(&format!("for f in \"$store/{own}\"*")));
        assert!(
            script.contains(&format!("{longer}*) continue")),
            "foo's sweep must skip entries owned by registered foo_bar"
        );
        let solo =
            name_store_sweep_command_in(&test_layout("/var/lib/nerdctl"), "foo", &registered[..1]);
        assert!(!decode_payload(&solo).contains("continue"));
    }

    /// Executes generated payloads against a stub store + stub binaries. macOS-gated:
    /// the payload prepends system dirs to PATH, and only macOS ships no system flock.
    #[cfg(target_os = "macos")]
    mod name_store_payload_exec {
        use super::*;
        use std::path::{Path, PathBuf};

        const FLOCK_OK: &str = "#!/bin/sh\nshift 3\nexec \"$@\"\n";
        const FLOCK_BUSY: &str = "#!/bin/sh\nexit 1\n";
        const NERDCTL_DEAD: &str = "#!/bin/sh\nfor a in \"$@\"; do last=\"$a\"; done\n\
             echo \"level=fatal msg=\\\"1 errors: [no such object $last]\\\"\" >&2\nexit 1\n";
        const NERDCTL_LIVE: &str = "#!/bin/sh\necho '[{\"State\":{\"Running\":true}}]'\nexit 0\n";
        const NERDCTL_ADVERSARIAL: &str = "#!/bin/sh\nfor a in \"$@\"; do last=\"$a\"; done\n\
             echo \"env HINT=no such object $last\"\nexit 0\n";
        const NERDCTL_INFRA: &str =
            "#!/bin/sh\necho 'cannot access containerd socket: no such file' >&2\nexit 1\n";
        const NERDCTL_ID_SWAP: &str = "#!/bin/sh\nprintf '%s' \"$SWAP_TO\" > \"$SWAP_FILE\"\n\
             for a in \"$@\"; do last=\"$a\"; done\necho \"no such object $last\" >&2\nexit 1\n";

        struct StubStore {
            _tmp: tempfile::TempDir,
            store: PathBuf,
            layout: NameStoreLayout,
        }

        fn write_exec(path: &Path, body: &str) {
            use std::os::unix::fs::PermissionsExt;
            std::fs::write(path, body).unwrap();
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        fn stub_store(nerdctl_body: &str, flock_body: &str) -> StubStore {
            let tmp = tempfile::tempdir().unwrap();
            let data_root = tmp.path().join("nerdctl-root");
            let store = data_root
                .join(consts::nerdctl_addr_hash())
                .join("names")
                .join(consts::CONTAINERD_NAMESPACE);
            std::fs::create_dir_all(&store).unwrap();
            let bin = tmp.path().join("bin");
            std::fs::create_dir_all(&bin).unwrap();
            write_exec(&bin.join("nerdctl"), nerdctl_body);
            write_exec(&bin.join("flock"), flock_body);
            let layout = NameStoreLayout {
                data_root: data_root.to_string_lossy().to_string(),
                nerdctl_bin: bin.join("nerdctl").to_string_lossy().to_string(),
            };
            StubStore {
                _tmp: tmp,
                store,
                layout,
            }
        }

        fn run_payload(env: &StubStore, cmd: &str, extra_env: &[(&str, &str)]) {
            let bin = Path::new(&env.layout.nerdctl_bin).parent().unwrap();
            let path = format!(
                "{}:{}",
                bin.display(),
                std::env::var("PATH").unwrap_or_default()
            );
            // SSOT-allow: test executes the generated payload against a stub store
            let mut command = std::process::Command::new("/bin/sh");
            command.arg("-c").arg(cmd).env("PATH", path);
            for (k, v) in extra_env {
                command.env(k, v);
            }
            let out = command.output().unwrap();
            assert!(
                out.status.success(),
                "payload must never fail: {}\n{}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            );
        }

        fn heal_cmd(env: &StubStore, name: &str, id: &str, project: &str) -> String {
            name_store_heal_command_in(&env.layout, &ns_conflict_err(name, id), project)
        }

        #[test]
        fn dead_entry_is_removed_and_other_datastore_untouched() {
            let env = stub_store(NERDCTL_DEAD, FLOCK_OK);
            let name = own_name("nsheal1", "mcp_hub");
            let entry = env.store.join(&name);
            std::fs::write(&entry, DEAD_ID).unwrap();
            let other = env
                .store
                .parent()
                .unwrap()
                .parent()
                .unwrap()
                .parent()
                .unwrap()
                .join("deadbee0")
                .join("names")
                .join("default");
            std::fs::create_dir_all(&other).unwrap();
            let foreign_entry = other.join(&name);
            std::fs::write(&foreign_entry, DEAD_ID).unwrap();
            run_payload(&env, &heal_cmd(&env, &name, DEAD_ID, "nsheal1"), &[]);
            assert!(!entry.exists(), "provably-dead reservation is released");
            assert!(
                foreign_entry.exists(),
                "another datastore's entry is never touched (no globbing)"
            );
        }

        #[test]
        fn live_entry_is_kept() {
            let env = stub_store(NERDCTL_LIVE, FLOCK_OK);
            let name = own_name("nsheal2", "mcp_hub");
            let entry = env.store.join(&name);
            std::fs::write(&entry, DEAD_ID).unwrap();
            run_payload(&env, &heal_cmd(&env, &name, DEAD_ID, "nsheal2"), &[]);
            assert!(entry.exists(), "live container's reservation stays");
        }

        #[test]
        fn rc_zero_with_phrase_in_output_is_kept() {
            let env = stub_store(NERDCTL_ADVERSARIAL, FLOCK_OK);
            let name = own_name("nsheal3", "mcp_hub");
            let entry = env.store.join(&name);
            std::fs::write(&entry, DEAD_ID).unwrap();
            run_payload(&env, &heal_cmd(&env, &name, DEAD_ID, "nsheal3"), &[]);
            assert!(
                entry.exists(),
                "rc=0 means alive even if the JSON contains the phrase"
            );
        }

        #[test]
        fn infra_failure_is_kept() {
            let env = stub_store(NERDCTL_INFRA, FLOCK_OK);
            let name = own_name("nsheal4", "mcp_hub");
            let entry = env.store.join(&name);
            std::fs::write(&entry, DEAD_ID).unwrap();
            run_payload(&env, &heal_cmd(&env, &name, DEAD_ID, "nsheal4"), &[]);
            assert!(entry.exists(), "unreachable containerd must not delete");
        }

        #[test]
        fn id_swap_between_proof_and_lock_is_kept() {
            let env = stub_store(NERDCTL_ID_SWAP, FLOCK_OK);
            let name = own_name("nsheal5", "mcp_hub");
            let entry = env.store.join(&name);
            std::fs::write(&entry, DEAD_ID).unwrap();
            let swapped = "a".repeat(64);
            run_payload(
                &env,
                &heal_cmd(&env, &name, DEAD_ID, "nsheal5"),
                &[
                    ("SWAP_FILE", entry.to_string_lossy().as_ref()),
                    ("SWAP_TO", &swapped),
                ],
            );
            assert_eq!(
                std::fs::read_to_string(&entry).unwrap(),
                swapped,
                "under-lock re-check must keep an entry whose ID changed since the proof"
            );
        }

        #[test]
        fn flock_busy_is_kept() {
            let env = stub_store(NERDCTL_DEAD, FLOCK_BUSY);
            let name = own_name("nsheal6", "mcp_hub");
            let entry = env.store.join(&name);
            std::fs::write(&entry, DEAD_ID).unwrap();
            run_payload(&env, &heal_cmd(&env, &name, DEAD_ID, "nsheal6"), &[]);
            assert!(entry.exists(), "no lock -> no delete");
        }

        #[test]
        fn empty_entry_is_removed_and_garbled_is_kept() {
            let env = stub_store(NERDCTL_DEAD, FLOCK_OK);
            let empty = env.store.join(own_name("nsheal7", "mcp_hub"));
            std::fs::write(&empty, "").unwrap();
            let garbled = env.store.join(own_name("nsheal7", "mcp_office"));
            std::fs::write(&garbled, &DEAD_ID[..63]).unwrap();
            let err = anyhow::anyhow!(
                "name-store error\\nname \\\"{}\\\" is already used by ID \\\"\\\" and \
                 name \\\"{}\\\" is already used by ID \\\"{}\\\"",
                own_name("nsheal7", "mcp_hub"),
                own_name("nsheal7", "mcp_office"),
                DEAD_ID
            );
            let cmd = name_store_heal_command_in(&env.layout, &err, "nsheal7");
            run_payload(&env, &cmd, &[]);
            assert!(!empty.exists(), "empty reservation (#3351) is released");
            assert!(garbled.exists(), "non-64-hex content is fail-closed kept");
        }

        #[test]
        fn missing_first_target_does_not_abort_later_targets() {
            let env = stub_store(NERDCTL_DEAD, FLOCK_OK);
            let absent = own_name("nsheal8", "mcp_hub");
            let present = own_name("nsheal8", "mcp_office");
            let entry = env.store.join(&present);
            std::fs::write(&entry, DEAD_ID).unwrap();
            let err = anyhow::anyhow!(
                "name-store error\\nname \\\"{absent}\\\" is already used by ID \\\"{DEAD_ID}\\\" \
                 and name \\\"{present}\\\" is already used by ID \\\"{DEAD_ID}\\\""
            );
            let cmd = name_store_heal_command_in(&env.layout, &err, "nsheal8");
            run_payload(&env, &cmd, &[]);
            assert!(!entry.exists(), "second target heals despite missing first");
        }

        #[test]
        fn sweep_removes_own_ghosts_but_skips_longer_registered_project() {
            let env = stub_store(NERDCTL_DEAD, FLOCK_OK);
            let own = env.store.join(own_name("foo", "mcp_presale"));
            std::fs::write(&own, DEAD_ID).unwrap();
            let nested = env.store.join(own_name("foo_bar", "mcp_hub"));
            std::fs::write(&nested, DEAD_ID).unwrap();
            let registered = vec!["foo".to_string(), "foo_bar".to_string()];
            let cmd = name_store_sweep_command_in(&env.layout, "foo", &registered);
            run_payload(&env, &cmd, &[]);
            assert!(!own.exists(), "own dead ghost (plugin-named) is swept");
            assert!(
                nested.exists(),
                "registered foo_bar's entry is never claimed by foo"
            );
        }

        /// A foreign project's shared-store entry survives an own-project heal even when
        /// the stub would classify it dead — prefix scoping, not a live-inspect race.
        #[test]
        fn own_project_heal_never_touches_a_foreign_projects_entry() {
            let env = stub_store(NERDCTL_DEAD, FLOCK_OK);
            let own_ghost = env.store.join(own_name("e2e-test", "mcp_hub"));
            std::fs::write(&own_ghost, DEAD_ID).unwrap();
            let foreign = env.store.join(own_name("e2e-second", "claude"));
            std::fs::write(&foreign, DEAD_ID).unwrap();
            let cmd = heal_cmd(&env, &own_name("e2e-test", "mcp_hub"), DEAD_ID, "e2e-test");
            run_payload(&env, &cmd, &[]);
            assert!(!own_ghost.exists(), "own dead reservation is released");
            assert!(
                foreign.exists(),
                "foreign project's entry is out of the prefix scope, never a heal target"
            );
        }
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
