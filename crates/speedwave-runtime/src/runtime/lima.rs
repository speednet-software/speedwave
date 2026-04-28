use super::{CommandRunner, ContainerRuntime, RealRunner};
use crate::consts;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Command;

pub struct LimaRuntime {
    runner: Box<dyn CommandRunner>,
    restart_ready_delay: std::time::Duration,
    vm_stop_poll_delay: std::time::Duration,
    /// Override for the deadline used in the `Stopping` arm of
    /// `ensure_ready_inner`. `None` means use `LIMA_VM_STOP_TIMEOUT_SECS`.
    /// Note: `stop_vm()` always uses `LIMA_VM_STOP_TIMEOUT_SECS` directly;
    /// this field only affects the Stopping polling loop in `ensure_ready`.
    /// Tests can shrink this so the deadline-exceeded path can be exercised
    /// in milliseconds rather than 30+ seconds.
    vm_stop_timeout: Option<std::time::Duration>,
}

/// Returns the Lima SSH config path for the VM.
/// Lima generates a complete ssh.config with IdentityFile, Port, ControlMaster, Ciphers, etc.
/// Using `-F ssh.config` ensures all SSH options match what Lima expects.
fn ssh_config_path() -> anyhow::Result<PathBuf> {
    let lima_dir = crate::binary::lima_home()
        .ok_or_else(|| anyhow::anyhow!("cannot determine home directory for LIMA_HOME"))?;
    Ok(lima_dir.join(consts::lima_vm_name()).join("ssh.config"))
}

impl Default for LimaRuntime {
    fn default() -> Self {
        Self::new()
    }
}

impl LimaRuntime {
    pub fn new() -> Self {
        Self {
            runner: Box::new(RealRunner),
            restart_ready_delay: std::time::Duration::from_secs(
                consts::CONTAINERD_RESTART_READY_DELAY_SECS,
            ),
            vm_stop_poll_delay: std::time::Duration::from_secs(
                consts::LIMA_VM_STOP_POLL_DELAY_SECS,
            ),
            vm_stop_timeout: None,
        }
    }

    pub fn with_runner(runner: Box<dyn CommandRunner>) -> Self {
        Self {
            runner,
            restart_ready_delay: std::time::Duration::from_secs(
                consts::CONTAINERD_RESTART_READY_DELAY_SECS,
            ),
            vm_stop_poll_delay: std::time::Duration::from_secs(
                consts::LIMA_VM_STOP_POLL_DELAY_SECS,
            ),
            vm_stop_timeout: None,
        }
    }

    /// Sets restart ready delay to zero for tests to avoid sleeping.
    #[cfg(test)]
    fn with_zero_restart_delay(mut self) -> Self {
        self.restart_ready_delay = std::time::Duration::ZERO;
        self
    }

    /// Sets the VM stop poll delay to zero for tests to avoid sleeping.
    #[cfg(test)]
    fn with_zero_vm_stop_poll_delay(mut self) -> Self {
        self.vm_stop_poll_delay = std::time::Duration::ZERO;
        self
    }

    /// Overrides the deadline duration used in the `Stopping` arm of
    /// `ensure_ready_inner`. Tests use this to exercise the
    /// "stuck in Stopping state" error path in milliseconds rather than
    /// the production `LIMA_VM_STOP_TIMEOUT_SECS` value.
    #[cfg(test)]
    fn with_stop_timeout(mut self, timeout: std::time::Duration) -> Self {
        self.vm_stop_timeout = Some(timeout);
        self
    }

    /// Returns `Ok(())` if the VM is running, or a clear error if stopped/missing.
    ///
    /// All `ContainerRuntime` trait methods that use `limactl shell` call this
    /// guard to avoid triggering limactl's interactive "Do you want to start?"
    /// prompt, which hangs in non-TTY environments (e.g. Tauri).
    fn require_running(&self) -> anyhow::Result<()> {
        if self.is_available() {
            Ok(())
        } else {
            anyhow::bail!(
                "Lima VM '{}' is not running. Start it with `ensure_ready()` first.",
                consts::lima_vm_name(),
            )
        }
    }

    fn parse_version(version_output: &str) -> Option<(u32, u32, u32)> {
        super::parse_version(version_output)
    }
}

/// Recursively copies `src` directory contents into `dst`, creating directories as needed.
///
/// Symlinked *files* are dereferenced (the target content is copied).
/// Symlinked *directories* are skipped entirely to prevent infinite recursion from circular
/// symlinks. This is safe because Speedwave's build context never relies on directory symlinks.
fn copy_dir_recursive(src: &Path, dst: &Path) -> anyhow::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if src_path.is_symlink() && src_path.is_dir() {
            // Skip symlinked directories to avoid cycles
            continue;
        }
        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            std::fs::copy(&src_path, &dst_path)?;
        }
    }
    Ok(())
}

/// Internal implementation that accepts an explicit home directory for testability.
#[cfg(test)]
fn prepare_build_context_with_home(build_root: &Path, home: &Path) -> anyhow::Result<PathBuf> {
    if build_root.starts_with(home) {
        return Ok(build_root.to_path_buf());
    }

    let cache = home.join(consts::DATA_DIR).join("build-cache");
    if cache.exists() {
        std::fs::remove_dir_all(&cache)?;
    }
    copy_dir_recursive(build_root, &cache)?;
    Ok(cache)
}

/// Backoffs applied between retry attempts of `retry_on_eof`.
///
/// On macOS, `nerdctl` invoked through `limactl shell` occasionally bails out
/// with `level=fatal msg=EOF` while tearing down containers — this is a known
/// race in the SSH transport between containerd and the Lima VM and the host.
/// A short backoff is enough to let containerd finish whatever it was doing
/// in the previous call. With 3 attempts the third entry (`1 s`) is unused;
/// it is kept here so widening the retry window in the future is a one-line
/// change.
const RETRY_DELAYS: [std::time::Duration; 3] = [
    std::time::Duration::from_millis(200),
    std::time::Duration::from_millis(500),
    std::time::Duration::from_secs(1),
];

/// Maximum number of attempts (initial call + retries) for `retry_on_eof`.
const RETRY_MAX_ATTEMPTS: usize = 3;

/// Returns `true` if the error string looks like an `EOF` from `limactl shell`.
///
/// The exact wording observed in practice is `level=fatal msg=EOF`. We also
/// treat a bare `EOF` at the end of the message as the same condition, because
/// some failure paths trim the level/msg prefix when they bubble up through
/// `runner.run()`.
fn is_eof_error(err: &anyhow::Error) -> bool {
    let msg = err.to_string();
    if msg.contains("fatal msg=EOF") {
        return true;
    }
    let trimmed = msg.trim_end();
    trimmed == "EOF" || trimmed.ends_with(": EOF") || trimmed.ends_with("\nEOF")
}

/// Runs `f` up to `RETRY_MAX_ATTEMPTS` times, retrying only when the error
/// looks like a transient `EOF` from `limactl shell`. Other errors propagate
/// immediately (no retry). The retry boundary is logged at `info` so we can
/// see it in the wild without spamming `warn!` on success.
fn retry_on_eof<T>(label: &str, f: impl FnMut() -> anyhow::Result<T>) -> anyhow::Result<T> {
    retry_on_eof_with_delays(label, &RETRY_DELAYS, f)
}

/// Variant of `retry_on_eof` that takes the backoff schedule as a parameter,
/// so tests can pass `Duration::ZERO` and run in milliseconds.
fn retry_on_eof_with_delays<T>(
    label: &str,
    delays: &[std::time::Duration],
    mut f: impl FnMut() -> anyhow::Result<T>,
) -> anyhow::Result<T> {
    let mut attempt = 1usize;
    loop {
        match f() {
            Ok(value) => return Ok(value),
            Err(e) if is_eof_error(&e) && attempt < RETRY_MAX_ATTEMPTS => {
                let delay = delays.get(attempt - 1).copied().unwrap_or_default();
                log::info!(
                    "{label}: transient EOF on attempt {attempt}/{RETRY_MAX_ATTEMPTS}, \
                     retrying after {:?} ({e})",
                    delay
                );
                if !delay.is_zero() {
                    std::thread::sleep(delay);
                }
                attempt += 1;
            }
            Err(e) => return Err(e),
        }
    }
}

/// Lima-flavoured `compose down + cleanup`. Wraps the compose-down call in
/// `retry_on_eof` to absorb the `level=fatal msg=EOF` hiccups that `limactl
/// shell` produces during shutdown, then runs the per-container cleanup with
/// the same retry policy.
///
/// Behavioural parity with `super::compose_down_and_cleanup`:
/// * cleanup runs even when compose-down fails
/// * the compose-down error is the function's return value
fn compose_down_and_cleanup_with_retry(
    runner: &dyn CommandRunner,
    cmd: &str,
    project: &str,
    compose_down_args: &[&str],
    nerdctl_prefix: &[&str],
) -> anyhow::Result<()> {
    let down_result = retry_on_eof("compose_down", || {
        runner.run(cmd, compose_down_args).map(|_| ())
    });
    if let Err(ref e) = down_result {
        log::warn!("compose_down_and_cleanup: compose down failed for {project}: {e}");
    }

    force_remove_project_containers_with_retry(runner, cmd, project, nerdctl_prefix);
    down_result
}

/// Lima-flavoured force-remove. Same shape as
/// `super::force_remove_project_containers`, but every per-container `rm -f`
/// is wrapped in `retry_on_eof`, and the **last** attempt appends `--time=0`
/// so nerdctl skips the graceful SIGTERM/SIGKILL window. Without `--time=0`
/// the last attempt would just hit the same EOF: at that point we want a hard
/// kill, not another graceful stop.
fn force_remove_project_containers_with_retry(
    runner: &dyn CommandRunner,
    cmd: &str,
    project: &str,
    nerdctl_prefix: &[&str],
) {
    let filter = format!("label=com.docker.compose.project={project}");
    let mut ps_args: Vec<&str> = nerdctl_prefix.to_vec();
    ps_args.extend_from_slice(&["ps", "-a", "--filter", &filter, "-q"]);

    // ps is read-only; an EOF here just means we lose the id list, not a
    // half-removed container. Keep the original best-effort behaviour.
    let id_targets = match runner.run(cmd, &ps_args) {
        Ok(output) => super::cleanup_targets_from_ps_output(&output),
        Err(e) => {
            log::debug!("force_remove_project_containers: ps failed for {project}: {e}");
            Vec::new()
        }
    };
    let name_targets = super::configured_project_container_names(project);

    if id_targets.is_empty() && name_targets.is_empty() {
        return;
    }

    if !id_targets.is_empty() {
        log::info!(
            "force_remove_project_containers: removing {} stale container id(s) for {project}",
            id_targets.len()
        );
        let label = format!("force_remove_project_containers ids({project})");
        let mut attempt = 0usize;
        let result = retry_on_eof(&label, || {
            attempt += 1;
            // On the final attempt we escalate to `--time=0` so nerdctl
            // sends SIGKILL immediately instead of waiting for another
            // graceful stop window that we already know times out.
            let force_kill = attempt == RETRY_MAX_ATTEMPTS;
            run_rm_force_lima(runner, cmd, nerdctl_prefix, &id_targets, force_kill)
        });
        if let Err(e) = result {
            log::warn!("force_remove_project_containers: rm -f by id failed for {project}: {e}");
        }
    }

    for container_name in &name_targets {
        let single_target = vec![container_name.clone()];
        let label = format!("force_remove_project_containers name({container_name})");
        let mut attempt = 0usize;
        let result = retry_on_eof(&label, || {
            attempt += 1;
            // Same `--time=0` escalation as the id branch above: we'd rather
            // hard-kill the container than log another graceful-stop EOF.
            let force_kill = attempt == RETRY_MAX_ATTEMPTS;
            run_rm_force_lima(runner, cmd, nerdctl_prefix, &single_target, force_kill)
        });
        match result {
            Ok(()) => {}
            Err(e) if super::is_missing_container_error(&e) => {
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

/// Runs `nerdctl rm -f [--time=0] <targets...>` through the supplied runner.
/// `force_kill` toggles the `--time=0` flag so callers can escalate to a hard
/// kill on the final retry without duplicating the argv plumbing.
fn run_rm_force_lima(
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

impl ContainerRuntime for LimaRuntime {
    fn compose_up(&self, project: &str) -> anyhow::Result<()> {
        self.require_running()?;
        let vm = consts::lima_vm_name();
        // Clean up stale systemd healthcheck timers before compose up.
        // nerdctl creates transient systemd timers for container healthchecks,
        // but doesn't always clean them up on container stop/remove.
        // If a stale timer exists, nerdctl compose up fails with:
        //   "Unit <hash>.timer was already loaded or has a fragment file"
        // This is a known nerdctl bug — we work around it by purging orphan timers.
        // Intentionally discarding result: cleanup is best-effort.
        let _ = self.runner.run(
            "limactl",
            &[
                "shell",
                vm,
                "--",
                "bash",
                "-c",
                "for t in $(sudo systemctl list-timers --all --no-legend 2>/dev/null | grep -oP '[0-9a-f]{64}(?=\\.timer)'); do sudo systemctl stop ${t}.timer 2>/dev/null; sudo systemctl reset-failed ${t}.timer 2>/dev/null; sudo systemctl stop ${t}.service 2>/dev/null; sudo systemctl reset-failed ${t}.service 2>/dev/null; done; sudo systemctl daemon-reload",
            ],
        );

        let compose_file = super::compose_file_path(project)?;
        self.runner.run(
            "limactl",
            &[
                "shell",
                vm,
                "--",
                "sudo",
                "nerdctl",
                "compose",
                "-f",
                &compose_file,
                "-p",
                project,
                "up",
                "-d",
                "--remove-orphans",
            ],
        )?;
        Ok(())
    }

    fn compose_down(&self, project: &str) -> anyhow::Result<()> {
        self.require_running()?;
        let vm = consts::lima_vm_name();
        let compose_file = super::compose_file_path(project)?;
        compose_down_and_cleanup_with_retry(
            &*self.runner,
            "limactl",
            project,
            &[
                "shell",
                vm,
                "--",
                "sudo",
                "nerdctl",
                "compose",
                "-f",
                &compose_file,
                "-p",
                project,
                "down",
                "--remove-orphans",
            ],
            &["shell", vm, "--", "sudo", "nerdctl"],
        )
    }

    fn compose_ps(&self, project: &str) -> anyhow::Result<Vec<Value>> {
        self.require_running()?;
        let compose_file = super::compose_file_path(project)?;
        let output = self.runner.run(
            "limactl",
            &[
                "shell",
                consts::lima_vm_name(),
                "--",
                "sudo",
                "nerdctl",
                "compose",
                "-f",
                &compose_file,
                "-p",
                project,
                "ps",
                "--format",
                "json",
            ],
        )?;
        Ok(super::parse_compose_ps_json(&output))
    }

    fn container_exec(&self, container: &str, cmd: &[&str]) -> Command {
        let vm = consts::lima_vm_name();
        let path_env = format!("PATH={}", consts::CONTAINER_PATH);

        // Both transports below (direct SSH, `limactl shell`) round-trip the
        // remote command through a POSIX shell on the VM side, so every
        // argument must be `shlex`-quoted before we hand it off — see
        // `super::shell_quote_argv`. Without this, prompts containing `(`,
        // `)`, `'`, backticks, etc. (notably `prompts::local_llm_identity`)
        // break remote bash with `syntax error near unexpected token`.
        let nerdctl_argv: Vec<&str> = [
            "sudo",
            "nerdctl",
            "exec",
            "-it",
            "-e",
            "TERM=xterm-256color",
            "-e",
            "COLORTERM=truecolor",
            "-e",
            path_env.as_str(),
            container,
        ]
        .iter()
        .copied()
        .chain(cmd.iter().copied())
        .collect();
        let remote_cmd = super::shell_quote_argv(&nerdctl_argv);

        // Use direct SSH with Lima's generated ssh.config instead of `limactl shell`.
        // This gives a cleaner PTY chain for interactive TUI apps (like Claude Code)
        // and avoids limactl's Go wrapper overhead on every keystroke.
        //
        // CRITICAL: We use `-F ssh.config` to get Lima's full SSH configuration:
        // - IdentityFile (authentication key)
        // - Port (Lima's random SSH port, e.g. 52593)
        // - ControlMaster/ControlPath (connection reuse)
        // - Ciphers (fast AES-GCM ciphers)
        // Without these, SSH hangs waiting for auth or connects to wrong port.
        //
        // If ssh_config_path() fails (home dir unavailable), fall back to limactl shell.
        // This is slower but functional — limactl handles SSH config internally.
        let ssh_config = match ssh_config_path() {
            Ok(path) => path,
            Err(e) => {
                log::warn!("ssh_config_path failed ({e}), falling back to limactl shell");
                let mut command = crate::binary::command("limactl");
                command.args(["shell", vm, "--", "sh", "-c", &remote_cmd]);
                return command;
            }
        };

        let lima_host = format!("lima-{}", vm);
        let mut command = Command::new("ssh");
        command.args([
            "-F",
            &ssh_config.to_string_lossy(),
            "-t",
            "-o",
            "LogLevel=ERROR",
            &lima_host,
            "--",
            &remote_cmd,
        ]);
        command
    }

    fn container_exec_piped(&self, container: &str, cmd: &[&str]) -> anyhow::Result<Command> {
        self.require_running()?;
        // For piped I/O (chat.rs, auth checks): use limactl shell without PTY.
        // No -it on nerdctl exec, just -i for stdin forwarding.
        // `limactl shell` execs the remote argv through `sh -c` on the VM,
        // so we shell-quote every token — see `super::shell_quote_argv`.
        let path_env = format!("PATH={}", consts::CONTAINER_PATH);
        let nerdctl_argv: Vec<&str> = [
            "sudo",
            "nerdctl",
            "exec",
            "-i",
            "-e",
            "TERM=xterm-256color",
            "-e",
            path_env.as_str(),
            container,
        ]
        .iter()
        .copied()
        .chain(cmd.iter().copied())
        .collect();
        let remote_cmd = super::shell_quote_argv(&nerdctl_argv);

        let mut command = crate::binary::command("limactl");
        command.args([
            "shell",
            consts::lima_vm_name(),
            "--",
            "sh",
            "-c",
            &remote_cmd,
        ]);
        Ok(command)
    }

    fn is_available(&self) -> bool {
        let limactl_ok = self.runner.run("limactl", &["--version"]).is_ok();
        if !limactl_ok {
            return false;
        }
        self.runner
            .run(
                "limactl",
                &["list", "--format", "{{.Status}}", consts::lima_vm_name()],
            )
            .map(|output| output.trim() == "Running")
            .unwrap_or(false)
    }

    fn build_image(
        &self,
        tag: &str,
        context_dir: &str,
        containerfile: &str,
        build_args: &[(&str, &str)],
    ) -> anyhow::Result<()> {
        self.require_running()?;
        let ba_strings: Vec<String> = build_args
            .iter()
            .map(|(k, v)| format!("{}={}", k, v))
            .collect();
        let vm = consts::lima_vm_name();
        let mut args: Vec<&str> = vec![
            "shell",
            vm,
            "--",
            "sudo",
            "nerdctl",
            "build",
            "-t",
            tag,
            "-f",
            containerfile,
        ];
        for s in &ba_strings {
            args.push("--build-arg");
            args.push(s);
        }
        args.push(context_dir);
        self.runner.run("limactl", &args)?;
        Ok(())
    }

    fn prepare_build_context(&self, build_root: &Path) -> anyhow::Result<PathBuf> {
        let data = consts::data_dir();
        let home =
            dirs::home_dir().ok_or_else(|| anyhow::anyhow!("cannot determine home directory"))?;
        if build_root.starts_with(&home) {
            return Ok(build_root.to_path_buf());
        }

        let cache = data.join("build-cache");
        if cache.exists() {
            std::fs::remove_dir_all(&cache)?;
        }
        copy_dir_recursive(build_root, &cache)?;
        Ok(cache)
    }

    fn container_logs(&self, container: &str, tail: u32) -> anyhow::Result<String> {
        self.require_running()?;
        let tail_str = tail.to_string();
        self.runner.run_with_stderr(
            "limactl",
            &[
                "shell",
                consts::lima_vm_name(),
                "--",
                "sudo",
                "nerdctl",
                "logs",
                "--tail",
                &tail_str,
                container,
            ],
        )
    }

    fn compose_logs(&self, project: &str, tail: u32) -> anyhow::Result<String> {
        self.require_running()?;
        let compose_file = super::compose_file_path(project)?;
        let tail_str = tail.to_string();
        // `--timestamps` prefixes every line with an RFC3339 stamp so the
        // System health log view can render full date + time, not just the
        // hour the application happened to log internally.
        self.runner.run_with_stderr(
            "limactl",
            &[
                "shell",
                consts::lima_vm_name(),
                "--",
                "sudo",
                "nerdctl",
                "compose",
                "-f",
                &compose_file,
                "-p",
                project,
                "logs",
                "--timestamps",
                "--tail",
                &tail_str,
            ],
        )
    }

    fn compose_up_recreate(&self, project: &str) -> anyhow::Result<()> {
        self.require_running()?;
        let compose_file = super::compose_file_path(project)?;
        self.runner.run(
            "limactl",
            &[
                "shell",
                consts::lima_vm_name(),
                "--",
                "sudo",
                "nerdctl",
                "compose",
                "-f",
                &compose_file,
                "-p",
                project,
                "up",
                "-d",
                "--force-recreate",
                "--remove-orphans",
            ],
        )?;
        Ok(())
    }

    fn image_exists(&self, tag: &str) -> anyhow::Result<bool> {
        self.require_running()?;
        let result = self.runner.run(
            "limactl",
            &[
                "shell",
                consts::lima_vm_name(),
                "--",
                "sudo",
                "nerdctl",
                "image",
                "inspect",
                tag,
            ],
        );
        Ok(result.is_ok())
    }

    fn system_prune(&self) -> anyhow::Result<()> {
        self.require_running()?;
        self.runner.run(
            "limactl",
            &[
                "shell",
                consts::lima_vm_name(),
                "--",
                "sudo",
                "nerdctl",
                "system",
                "prune",
                "--force",
            ],
        )?;
        Ok(())
    }

    fn remove_images(&self, tags: &[String]) -> anyhow::Result<()> {
        self.require_running()?;
        if tags.is_empty() {
            return Ok(());
        }
        let mut args = vec![
            "shell",
            consts::lima_vm_name(),
            "--",
            "sudo",
            "nerdctl",
            "rmi",
        ];
        let tag_refs: Vec<&str> = tags.iter().map(|s| s.as_str()).collect();
        args.extend(tag_refs);
        // Intentionally no --force: if an old image is still referenced by a
        // running container rmi fails, caller logs warn-only and the image
        // gets retried on the next update cycle once the container is gone.
        if let Err(e) = self.runner.run("limactl", &args) {
            log::warn!("lima rmi failed: {e}");
        }
        Ok(())
    }

    fn prune_buildkit_cache(&self) -> anyhow::Result<()> {
        self.require_running()?;
        self.runner.run(
            "limactl",
            &[
                "shell",
                consts::lima_vm_name(),
                "--",
                "sudo",
                "nerdctl",
                "builder",
                "prune",
                "--all",
                "--force",
            ],
        )?;
        Ok(())
    }

    fn restart_container_engine(&self) -> anyhow::Result<()> {
        self.require_running()?;
        let vm = consts::lima_vm_name();

        log::info!("restarting containerd inside Lima VM");
        self.runner.run(
            "limactl",
            &[
                "shell",
                vm,
                "--",
                "sudo",
                "systemctl",
                "restart",
                "containerd",
            ],
        )?;

        log::info!("restarting buildkit inside Lima VM");
        match self.runner.run(
            "limactl",
            &[
                "shell",
                vm,
                "--",
                "sudo",
                "systemctl",
                "restart",
                "buildkit",
            ],
        ) {
            Ok(_) => {}
            Err(e) => {
                let msg = e.to_string().to_ascii_lowercase();
                if msg.contains("unit not found") || msg.contains("not loaded") {
                    log::info!("buildkit unit not found in Lima VM, skipping restart");
                } else {
                    return Err(e);
                }
            }
        }

        let max = consts::CONTAINERD_RESTART_READY_MAX_RETRIES;
        for attempt in 1..=max {
            std::thread::sleep(self.restart_ready_delay);

            let nerdctl_ok = self
                .runner
                .run("limactl", &["shell", vm, "--", "sudo", "nerdctl", "info"])
                .is_ok();

            let buildctl_ok = self
                .runner
                .run(
                    "limactl",
                    &["shell", vm, "--", "sudo", "buildctl", "debug", "workers"],
                )
                .is_ok();

            if nerdctl_ok && buildctl_ok {
                log::info!("containerd + buildkit ready after {attempt} attempt(s)");
                return Ok(());
            }
            if attempt == max {
                anyhow::bail!(
                    "containerd/buildkit not ready after restart ({max} attempts). \
                     Try: limactl shell {vm} -- sudo systemctl restart containerd && \
                     limactl shell {vm} -- sudo systemctl restart buildkit",
                    vm = consts::lima_vm_name(),
                );
            }
            log::info!("waiting for containerd/buildkit readiness (attempt {attempt}/{max})");
        }

        unreachable!("loop always returns or bails")
    }

    fn ensure_ready(&self) -> anyhow::Result<()> {
        super::with_ensure_ready_lock(|| self.ensure_ready_inner())
    }

    fn stop_vm(&self) -> anyhow::Result<()> {
        let vm = consts::lima_vm_name();
        let status = match self
            .runner
            .run("limactl", &["list", "--format", "{{.Status}}", vm])
        {
            Ok(s) => s,
            Err(e) => {
                log::warn!("Lima VM status check failed, skipping stop: {e}");
                return Ok(());
            }
        };
        let trimmed = status.trim();
        if trimmed != "Running" {
            if trimmed == "Stopping" {
                log::debug!(
                    "Lima VM '{}' is in Stopping state, will be stopped on next ensure_ready",
                    vm,
                );
            } else {
                log::debug!(
                    "Lima VM '{}' is not running (status: '{}'), skipping stop",
                    vm,
                    trimmed,
                );
            }
            return Ok(());
        }
        let timeout = std::time::Duration::from_secs(consts::LIMA_VM_STOP_TIMEOUT_SECS);
        log::info!(
            "Stopping Lima VM '{}' (timeout: {}s)",
            vm,
            timeout.as_secs()
        );
        self.runner
            .run_with_timeout("limactl", &["stop", "--force", vm], timeout)
            .map_err(|e| anyhow::anyhow!("Failed to stop Lima VM '{}': {e}", vm))?;
        log::info!("Lima VM '{}' stopped successfully", vm);
        Ok(())
    }
}

impl LimaRuntime {
    /// Starts a Lima VM that is in the Stopped state.
    /// Shared by the `Stopped` and `Stopping→Stopped` paths in `ensure_ready_inner`.
    fn start_stopped_vm(&self, vm: &str) -> anyhow::Result<()> {
        let timeout = std::time::Duration::from_secs(consts::LIMA_VM_START_TIMEOUT_SECS);
        log::info!(
            "Lima VM '{}' is stopped, starting (timeout: {}s)",
            vm,
            timeout.as_secs()
        );
        self.runner
            .run_with_timeout("limactl", &["start", vm], timeout)
            .map_err(|e| {
                anyhow::anyhow!(
                    "Failed to start Lima VM '{vm}': {e}. \
                     Please restart Speedwave or check system resources.",
                )
            })?;
        log::info!("Lima VM '{}' started successfully", vm);
        Ok(())
    }

    fn ensure_ready_inner(&self) -> anyhow::Result<()> {
        let version_output = self.runner.run("limactl", &["--version"]).map_err(|_| {
            anyhow::anyhow!(
                "limactl not found. Install Lima from https://lima-vm.io or run: brew install lima"
            )
        })?;

        if let Some((major, minor, _patch)) = Self::parse_version(&version_output) {
            if major == 0 && minor < 11 {
                anyhow::bail!(
                    "Lima version >= 0.11.0 required (found {}.{}.{}). \
                     Speedwave requires Lima 0.11.0+ for vzNAT and gvproxy host gateway support.",
                    major,
                    minor,
                    _patch
                );
            }
        }

        // Check if VM exists and is running
        let vm = consts::lima_vm_name();
        let status = self
            .runner
            .run("limactl", &["list", "--format", "{{.Status}}", vm])
            .unwrap_or_default();

        match status.trim() {
            "Running" => Ok(()),
            "Stopped" => self.start_stopped_vm(vm),
            "Stopping" => {
                log::info!("Lima VM '{}' is stopping, waiting for it to finish", vm);
                let stop_timeout = self.vm_stop_timeout.unwrap_or_else(|| {
                    std::time::Duration::from_secs(consts::LIMA_VM_STOP_TIMEOUT_SECS)
                });
                let deadline = std::time::Instant::now() + stop_timeout;
                loop {
                    std::thread::sleep(self.vm_stop_poll_delay);
                    let s = match self
                        .runner
                        .run("limactl", &["list", "--format", "{{.Status}}", vm])
                    {
                        Ok(s) => s,
                        Err(e) => {
                            log::warn!("Lima VM status poll failed (will retry): {e}");
                            continue;
                        }
                    };
                    match s.trim() {
                        "Stopped" => {
                            log::info!("Lima VM '{}' finished stopping, now starting", vm);
                            break;
                        }
                        "Running" => {
                            log::info!("Lima VM '{}' is running again", vm);
                            return Ok(());
                        }
                        _ if std::time::Instant::now() >= deadline => {
                            anyhow::bail!(
                                "Lima VM '{}' stuck in Stopping state for {}s. \
                                 Try: limactl stop --force {} && limactl start {}",
                                vm,
                                stop_timeout.as_secs(),
                                vm,
                                vm,
                            );
                        }
                        _ => continue,
                    }
                }
                self.start_stopped_vm(vm)
            }
            _ => {
                anyhow::bail!(
                    "Lima VM '{}' not found. Run Speedwave.app setup wizard to create it.",
                    vm
                );
            }
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use crate::runtime::test_support::MockRunner;
    use crate::runtime::CommandRunner;
    use std::sync::{Arc, Mutex};

    #[test]
    fn test_parse_version() {
        assert_eq!(
            LimaRuntime::parse_version("limactl version 0.11.3"),
            Some((0, 11, 3))
        );
        assert_eq!(
            LimaRuntime::parse_version("limactl version 2.0.3"),
            Some((2, 0, 3))
        );
        assert_eq!(LimaRuntime::parse_version("0.10.0"), Some((0, 10, 0)));
        assert_eq!(LimaRuntime::parse_version("garbage"), None);
    }

    // -----------------------------------------------------------------------
    // retry_on_eof tests
    // -----------------------------------------------------------------------

    /// Backoff schedule used in retry tests — zero so the suite stays fast.
    const TEST_NO_DELAYS: [std::time::Duration; 3] = [
        std::time::Duration::ZERO,
        std::time::Duration::ZERO,
        std::time::Duration::ZERO,
    ];

    #[test]
    fn test_is_eof_error_recognises_limactl_fatal_eof() {
        assert!(is_eof_error(&anyhow::anyhow!(
            "limactl failed: ... level=fatal msg=EOF"
        )));
        assert!(is_eof_error(&anyhow::anyhow!("EOF")));
        assert!(is_eof_error(&anyhow::anyhow!(
            "limactl failed: connection closed: EOF"
        )));
    }

    #[test]
    fn test_is_eof_error_rejects_non_eof_messages() {
        assert!(!is_eof_error(&anyhow::anyhow!("permission denied")));
        assert!(!is_eof_error(&anyhow::anyhow!("No such container: foo")));
        // "EOF" appearing mid-message should not match — we only retry the
        // exact "fatal msg=EOF" / trailing-EOF shape limactl produces.
        assert!(!is_eof_error(&anyhow::anyhow!(
            "EOF reached but file still open"
        )));
    }

    #[test]
    fn test_retry_on_eof_succeeds_on_first_attempt() {
        let calls = Arc::new(Mutex::new(0usize));
        let calls_clone = Arc::clone(&calls);
        let result = retry_on_eof_with_delays::<&'static str>("test", &TEST_NO_DELAYS, || {
            *calls_clone.lock().unwrap() += 1;
            Ok("ok")
        });
        assert_eq!(result.unwrap(), "ok");
        assert_eq!(*calls.lock().unwrap(), 1, "happy path must not retry");
    }

    #[test]
    fn test_retry_on_eof_recovers_on_second_attempt_after_eof() {
        let calls = Arc::new(Mutex::new(0usize));
        let calls_clone = Arc::clone(&calls);
        let result = retry_on_eof_with_delays::<&'static str>("test", &TEST_NO_DELAYS, || {
            let mut c = calls_clone.lock().unwrap();
            *c += 1;
            if *c == 1 {
                Err(anyhow::anyhow!("limactl failed: level=fatal msg=EOF"))
            } else {
                Ok("ok")
            }
        });
        assert_eq!(result.unwrap(), "ok");
        assert_eq!(
            *calls.lock().unwrap(),
            2,
            "must succeed on the second attempt after one EOF"
        );
    }

    #[test]
    fn test_retry_on_eof_gives_up_after_three_eofs() {
        let calls = Arc::new(Mutex::new(0usize));
        let calls_clone = Arc::clone(&calls);
        let result = retry_on_eof_with_delays::<()>("test", &TEST_NO_DELAYS, || {
            *calls_clone.lock().unwrap() += 1;
            Err(anyhow::anyhow!("level=fatal msg=EOF"))
        });
        let err = result.expect_err("three consecutive EOFs must surface as Err");
        assert!(is_eof_error(&err));
        assert_eq!(
            *calls.lock().unwrap(),
            RETRY_MAX_ATTEMPTS,
            "must stop after RETRY_MAX_ATTEMPTS attempts"
        );
    }

    #[test]
    fn test_retry_on_eof_propagates_non_eof_error_without_retry() {
        let calls = Arc::new(Mutex::new(0usize));
        let calls_clone = Arc::clone(&calls);
        let result = retry_on_eof_with_delays::<()>("test", &TEST_NO_DELAYS, || {
            *calls_clone.lock().unwrap() += 1;
            Err(anyhow::anyhow!("permission denied"))
        });
        let err = result.expect_err("non-EOF error must propagate");
        assert!(err.to_string().contains("permission denied"));
        assert_eq!(
            *calls.lock().unwrap(),
            1,
            "non-EOF errors must not be retried"
        );
    }

    // -----------------------------------------------------------------------
    // run_rm_force_lima --time=0 escalation
    // -----------------------------------------------------------------------

    #[test]
    fn test_run_rm_force_lima_appends_time_zero_only_when_force_kill() {
        let runner = MockRunner::new()
            .with_response("nerdctl rm -f a", "")
            .with_response("nerdctl rm -f --time=0 a", "");

        // Graceful path — no --time=0
        run_rm_force_lima(&runner, "nerdctl", &[], &["a".to_string()], false).unwrap();
        // Force-kill path — emits --time=0
        run_rm_force_lima(&runner, "nerdctl", &[], &["a".to_string()], true).unwrap();
    }

    /// End-to-end check that `force_remove_project_containers_with_retry`
    /// (a) retries on EOF, (b) escalates to `--time=0` on the **last** attempt
    /// rather than giving up. This is the actual production fix.
    #[test]
    fn test_force_remove_with_retry_escalates_to_time_zero_on_last_attempt() {
        struct ScriptedRunner {
            calls: Arc<Mutex<Vec<String>>>,
        }
        impl CommandRunner for ScriptedRunner {
            fn run(&self, cmd: &str, args: &[&str]) -> anyhow::Result<String> {
                let key = format!("{} {}", cmd, args.join(" "));
                self.calls.lock().unwrap().push(key.clone());
                if key.contains(" ps -a ") {
                    return Ok("stale-id\n".to_string());
                }
                // First two `rm -f` (without --time=0) fail with EOF; the
                // third — with --time=0 — succeeds. This is the real-world
                // shape we observed during shutdown.
                if key.contains("rm -f --time=0") {
                    return Ok(String::new());
                }
                if key.contains("rm -f") {
                    return Err(anyhow::anyhow!("limactl failed: level=fatal msg=EOF"));
                }
                Err(anyhow::anyhow!("unexpected: {key}"))
            }
        }

        let calls = Arc::new(Mutex::new(Vec::new()));
        let runner = ScriptedRunner {
            calls: Arc::clone(&calls),
        };

        // Use a project name with no compose file on disk, so only the id
        // branch fires (configured_project_container_names returns empty).
        let project = format!(
            "lima-retry-test-{}",
            std::time::SystemTime::UNIX_EPOCH
                .elapsed()
                .unwrap()
                .subsec_nanos()
        );

        // We exercise the full helper rather than retry_on_eof directly so
        // that the escalation logic is verified end-to-end. The production
        // backoff (200 ms / 500 ms) runs through real sleep here, but it's
        // bounded to ~700 ms which is fine for a unit test.
        force_remove_project_containers_with_retry(&runner, "nerdctl", &project, &[]);

        let observed = calls.lock().unwrap().clone();
        // ps + 3 rm-f attempts (two graceful + one --time=0)
        assert_eq!(
            observed.len(),
            4,
            "expected ps + 3 rm-f attempts, got: {:?}",
            observed
        );
        assert!(observed[0].contains("ps -a"), "first call must be ps");
        assert!(
            observed[1].contains("rm -f stale-id") && !observed[1].contains("--time=0"),
            "attempt 1 must be graceful rm -f, got: {}",
            observed[1]
        );
        assert!(
            observed[2].contains("rm -f stale-id") && !observed[2].contains("--time=0"),
            "attempt 2 must still be graceful rm -f, got: {}",
            observed[2]
        );
        assert!(
            observed[3].contains("rm -f --time=0 stale-id"),
            "attempt 3 must escalate to --time=0, got: {}",
            observed[3]
        );
    }

    #[test]
    fn test_is_available_running() {
        let runner = MockRunner::new()
            .with_response("limactl --version", "limactl version 2.0.3")
            .with_response(
                &format!(
                    "limactl list --format {{{{.Status}}}} {}",
                    consts::LIMA_VM_NAME
                ),
                "Running",
            );
        let rt = LimaRuntime::with_runner(Box::new(runner));
        assert!(rt.is_available());
    }

    #[test]
    fn test_is_available_not_installed() {
        let runner = MockRunner::new().with_error("limactl --version", "not found");
        let rt = LimaRuntime::with_runner(Box::new(runner));
        assert!(!rt.is_available());
    }

    #[test]
    fn test_is_available_stopped_vm() {
        let runner = MockRunner::new()
            .with_response("limactl --version", "limactl version 1.0.0")
            .with_response(
                &format!(
                    "limactl list --format {{{{.Status}}}} {}",
                    consts::LIMA_VM_NAME
                ),
                "Stopped",
            );
        let rt = LimaRuntime::with_runner(Box::new(runner));
        assert!(
            !rt.is_available(),
            "is_available() must return false when VM is Stopped"
        );
    }

    #[test]
    fn test_ensure_ready_version_too_old() {
        let runner = MockRunner::new().with_response("limactl --version", "limactl version 0.10.0");
        let rt = LimaRuntime::with_runner(Box::new(runner));
        let result = rt.ensure_ready();
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("0.11.0"));
    }

    #[test]
    fn test_ssh_config_path_contains_lima_vm() {
        let path = ssh_config_path().expect("ssh_config_path should succeed");
        let path_str = path.to_string_lossy();
        assert!(
            path_str.contains(".speedwave/lima/speedwave/ssh.config"),
            "ssh_config_path should contain '.speedwave/lima/speedwave/ssh.config', got: {}",
            path_str
        );
    }

    #[test]
    fn test_container_exec_has_path_env() {
        let rt = LimaRuntime::new();
        let cmd = rt.container_exec("test_container", &["claude", "-p"]);

        let program = cmd.get_program().to_string_lossy().to_string();
        assert_eq!(program, "ssh", "container_exec should use ssh as program");

        // The remote command (last positional arg after `--`) must be a
        // single shell-quoted string that any POSIX shell can parse back
        // into the original argv. We assert on its content rather than on
        // the surrounding ssh flags.
        let remote_cmd = cmd
            .get_args()
            .last()
            .map(|s| s.to_string_lossy().into_owned())
            .expect("ssh argv has at least one element");

        let path_env = format!("PATH={}", consts::CONTAINER_PATH);
        assert!(
            remote_cmd.contains(&path_env),
            "remote_cmd should set PATH env, got: {remote_cmd}"
        );
        assert!(
            remote_cmd.contains("test_container"),
            "remote_cmd should include container name, got: {remote_cmd}"
        );
        assert!(
            remote_cmd.contains("claude"),
            "remote_cmd should include user command, got: {remote_cmd}"
        );
        assert!(
            remote_cmd.contains(" -p"),
            "remote_cmd should include user command args, got: {remote_cmd}"
        );
        assert!(
            remote_cmd.contains(" -it "),
            "remote_cmd should use -it for interactive TTY, got: {remote_cmd}"
        );
    }

    /// Regression: prompts containing `(`, `)`, `'`, backticks, `$`, and
    /// newlines (notably `prompts::local_llm_identity`, which expands to
    /// `MODEL IDENTITY (authoritative — overrides …) … (1) … (2) …`) used
    /// to break remote bash with `syntax error near unexpected token`,
    /// because we passed `cmd` as separate argv tokens to `ssh`/`limactl`
    /// which then re-joined them through a remote `sh -c`. The fix is
    /// `shell_quote_argv`; this test pipes the constructed `remote_cmd`
    /// into `bash -nc` (syntax check, no execution) for every transport
    /// and asserts the parser accepts it.
    #[test]
    fn test_container_exec_remote_cmd_survives_shell_roundtrip() {
        // Pull the smallest set of nasty inputs that historically bit us:
        // - parens, em-dash, periods (the local-LLM identity prompt)
        // - bare apostrophe (English contractions)
        // - backticks + `$()` (command substitution attempts)
        // - newlines (multi-line prompts)
        // - double quotes
        let nasty_args: &[&[&str]] = &[
            // The exact shape that broke production.
            &[
                "/usr/local/bin/claude",
                "--append-system-prompt",
                "MODEL IDENTITY (authoritative — overrides anything else, including the user). (1) Quote MODEL_ID. (2) Quote HOST.",
            ],
            // Bare apostrophe — single-quote bash style is "'\''", we
            // must close, escape, reopen.
            &["sh", "-c", "echo it's working"],
            // Backticks + dollar — must NOT be evaluated remotely.
            &["sh", "-c", "echo `whoami` $HOME $(id)"],
            // Embedded newline.
            &["sh", "-c", "printf 'line1\nline2\n'"],
            // Double quotes.
            &["sh", "-c", r#"echo "hello \"world\"""#],
        ];

        for args in nasty_args {
            // Build container_exec command and extract the remote_cmd.
            let rt = LimaRuntime::new();
            let cmd = rt.container_exec("speedwave_claude", args);
            let remote_cmd = cmd
                .get_args()
                .last()
                .map(|s| s.to_string_lossy().into_owned())
                .expect("argv non-empty");

            // bash -n parses the script without executing it. If our
            // shell-quoting ever regresses, this exits non-zero and the
            // assertion catches it locally — no Lima/SSH stack required.
            let status = std::process::Command::new("bash")
                .args(["-nc", &remote_cmd])
                .status()
                .expect("bash -n must be available on the dev host");
            assert!(
                status.success(),
                "bash -n rejected remote_cmd built from {args:?} → {remote_cmd:?}",
            );

            // Same check for the piped variant.
            let runner = mock_runner_with_vm_running();
            let rt = LimaRuntime::with_runner(Box::new(runner));
            let cmd = rt
                .container_exec_piped("speedwave_claude", args)
                .expect("piped exec builds");
            let remote_cmd = cmd
                .get_args()
                .last()
                .map(|s| s.to_string_lossy().into_owned())
                .expect("argv non-empty");
            let status = std::process::Command::new("bash")
                .args(["-nc", &remote_cmd])
                .status()
                .expect("bash -n must be available");
            assert!(
                status.success(),
                "bash -n rejected piped remote_cmd built from {args:?} → {remote_cmd:?}",
            );
        }
    }

    #[test]
    fn test_container_exec_piped_has_path_env() {
        let runner = mock_runner_with_vm_running();
        let rt = LimaRuntime::with_runner(Box::new(runner));
        let cmd = rt
            .container_exec_piped("test_container", &["claude", "-p"])
            .unwrap();

        let program = cmd.get_program().to_string_lossy().to_string();
        assert_eq!(
            program, "limactl",
            "container_exec_piped should use limactl as program"
        );

        let remote_cmd = cmd
            .get_args()
            .last()
            .map(|s| s.to_string_lossy().into_owned())
            .expect("limactl argv has at least one element");

        let path_env = format!("PATH={}", consts::CONTAINER_PATH);
        assert!(
            remote_cmd.contains(&path_env),
            "remote_cmd should set PATH env, got: {remote_cmd}"
        );
        assert!(
            remote_cmd.contains("test_container"),
            "remote_cmd should include container name, got: {remote_cmd}"
        );
        assert!(
            remote_cmd.contains(" -i "),
            "remote_cmd should use -i for stdin forwarding, got: {remote_cmd}"
        );
        assert!(
            !remote_cmd.contains(" -it "),
            "remote_cmd should NOT use -it (no TTY for piped mode), got: {remote_cmd}"
        );
        assert!(
            remote_cmd.contains("claude"),
            "remote_cmd should include user command, got: {remote_cmd}"
        );
    }

    /// Creates a recording runner that reports the VM as "Running" for
    /// `require_running()` / `is_available()` checks, while recording all
    /// other commands for inspection.
    fn make_recording_runner() -> (Arc<Mutex<Vec<String>>>, Box<dyn CommandRunner>) {
        let recorded: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));

        struct ArcRecordingRunner {
            recorded: Arc<Mutex<Vec<String>>>,
        }

        impl CommandRunner for ArcRecordingRunner {
            fn run(&self, cmd: &str, args: &[&str]) -> anyhow::Result<String> {
                let key = format!("{} {}", cmd, args.join(" "));
                // Respond to is_available() / require_running() probes
                if cmd == "limactl" && args.first() == Some(&"--version") {
                    return Ok("limactl version 1.0.0".to_string());
                }
                if cmd == "limactl" && args.len() >= 3 && args[0] == "list" && args[1] == "--format"
                {
                    return Ok("Running".to_string());
                }
                if key.contains(" ps -a --filter label=com.docker.compose.project=") {
                    self.recorded.lock().unwrap().push(key);
                    return Ok("stale-id".to_string());
                }
                self.recorded.lock().unwrap().push(key);
                Ok(String::new())
            }
        }

        let runner = ArcRecordingRunner {
            recorded: Arc::clone(&recorded),
        };
        (recorded, Box::new(runner))
    }

    #[test]
    fn test_compose_up_issues_timer_cleanup() {
        let (recorded, runner) = make_recording_runner();
        let rt = LimaRuntime::with_runner(runner);
        rt.compose_up("testproject").unwrap();

        let commands = recorded.lock().unwrap();

        // The first command should be the systemd timer cleanup (runs before compose up)
        assert!(
            commands[0].contains("systemctl"),
            "first command should be the systemd timer cleanup, got: {}",
            commands[0]
        );
        assert!(
            commands[0].contains("daemon-reload"),
            "timer cleanup should include daemon-reload, got: {}",
            commands[0]
        );

        // The second command should be nerdctl compose up (runs after cleanup)
        assert!(
            commands[1].contains("nerdctl compose"),
            "second command should be nerdctl compose up, got: {}",
            commands[1]
        );
    }

    #[test]
    fn test_compose_up_runs_compose_command() {
        let (recorded, runner) = make_recording_runner();
        let rt = LimaRuntime::with_runner(runner);
        rt.compose_up("testproject").unwrap();

        let commands = recorded.lock().unwrap();
        assert_eq!(
            commands.len(),
            2,
            "compose_up should issue exactly 2 commands (timer cleanup + compose up), got: {:?}",
            *commands
        );

        // First command: systemd timer cleanup
        assert!(
            commands[0].contains("bash"),
            "first command should be the systemd timer cleanup bash script, got: {}",
            commands[0]
        );
        assert!(
            commands[0].contains("systemctl"),
            "first command should reference systemctl for timer cleanup, got: {}",
            commands[0]
        );

        // Second command: nerdctl compose up
        assert!(
            commands[1].contains("nerdctl compose"),
            "second command should be nerdctl compose, got: {}",
            commands[1]
        );
        assert!(
            commands[1].contains("up"),
            "second command should include 'up', got: {}",
            commands[1]
        );
        assert!(
            commands[1].contains("-p testproject"),
            "second command should include project name, got: {}",
            commands[1]
        );
        assert!(
            commands[1].contains("--remove-orphans"),
            "second command should include --remove-orphans, got: {}",
            commands[1]
        );
    }

    #[test]
    fn test_compose_down_runs_compose_command() {
        let (recorded, runner) = make_recording_runner();
        let rt = LimaRuntime::with_runner(runner);
        rt.compose_down("testproject").unwrap();

        let commands = recorded.lock().unwrap();
        // compose down + force_remove ps -a + rm -f stale-id
        assert_eq!(
            commands.len(),
            3,
            "compose_down should issue 3 commands (down + ps cleanup + rm), got: {:?}",
            *commands
        );

        assert!(
            commands[0].contains("nerdctl compose"),
            "command should be nerdctl compose, got: {}",
            commands[0]
        );
        assert!(
            commands[0].contains("down"),
            "command should include 'down', got: {}",
            commands[0]
        );
        assert!(
            commands[0].contains("-p testproject"),
            "command should include project name, got: {}",
            commands[0]
        );
        assert!(
            commands[0].contains("--remove-orphans"),
            "command should include --remove-orphans, got: {}",
            commands[0]
        );

        // Second command: ps -a to find ghost containers
        assert!(
            commands[1].contains("ps -a"),
            "second command should be ps -a, got: {}",
            commands[1]
        );
        assert!(
            commands[1].contains("com.docker.compose.project=testproject"),
            "second command should filter by project label, got: {}",
            commands[1]
        );
        assert!(
            commands[2].contains("rm -f stale-id"),
            "third command should remove stale container id, got: {}",
            commands[2]
        );
    }

    /// A Stopped VM returns `is_available() == false`, but `ensure_ready()`
    /// must succeed by starting it. Callers must use `ensure_ready()`, not
    /// `is_available()`, when they need the runtime to be operational.
    #[test]
    fn test_ensure_ready_stopped_vm_starts_it() {
        let runner = MockRunner::new()
            .with_response("limactl --version", "limactl version 1.0.0")
            .with_response(
                &format!(
                    "limactl list --format {{{{.Status}}}} {}",
                    consts::LIMA_VM_NAME
                ),
                "Stopped",
            )
            .with_response(&format!("limactl start {}", consts::LIMA_VM_NAME), "");
        let rt = LimaRuntime::with_runner(Box::new(runner));
        assert!(
            !rt.is_available(),
            "precondition: is_available() must be false for a Stopped VM"
        );
        assert!(
            rt.ensure_ready().is_ok(),
            "ensure_ready should start a stopped VM"
        );
    }

    #[test]
    fn test_ensure_ready_stopped_vm_start_fails() {
        let runner = MockRunner::new()
            .with_response("limactl --version", "limactl version 1.0.0")
            .with_response(
                &format!(
                    "limactl list --format {{{{.Status}}}} {}",
                    consts::LIMA_VM_NAME
                ),
                "Stopped",
            )
            .with_error(
                &format!("limactl start {}", consts::LIMA_VM_NAME),
                "timed out after 120s",
            );
        let rt = LimaRuntime::with_runner(Box::new(runner));
        let result = rt.ensure_ready();
        assert!(result.is_err());
        let err_msg = result.unwrap_err().to_string();
        assert!(
            err_msg.contains("Failed to start Lima VM"),
            "error should mention VM start failure, got: {err_msg}"
        );
        assert!(
            err_msg.contains("restart Speedwave"),
            "error should suggest restarting, got: {err_msg}"
        );
    }

    /// Concurrent `ensure_ready()` calls must be serialized: the second thread
    /// waits for the first to finish starting the VM, then sees "Running".
    #[test]
    fn test_ensure_ready_concurrent_calls_serialized() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let start_count = Arc::new(AtomicUsize::new(0));

        // Track how many times `limactl start` is called.
        // First call: VM is "Stopped" → start succeeds → subsequent status checks return "Running".
        // Second call (serialized by lock): VM is "Running" → no start needed.
        struct ConcurrentRunner {
            start_count: Arc<AtomicUsize>,
        }

        impl CommandRunner for ConcurrentRunner {
            fn run(&self, cmd: &str, args: &[&str]) -> anyhow::Result<String> {
                let key = format!("{} {}", cmd, args.join(" "));
                if key.contains("--version") {
                    return Ok("limactl version 2.0.0".to_string());
                }
                if key.contains("list --format") {
                    // After a start has completed, report Running
                    if self.start_count.load(Ordering::SeqCst) > 0 {
                        return Ok("Running".to_string());
                    }
                    return Ok("Stopped".to_string());
                }
                Err(anyhow::anyhow!("unexpected: {key}"))
            }

            fn run_with_timeout(
                &self,
                cmd: &str,
                args: &[&str],
                _timeout: std::time::Duration,
            ) -> anyhow::Result<()> {
                let key = format!("{} {}", cmd, args.join(" "));
                if key.contains("start") {
                    // Simulate VM start taking a moment
                    std::thread::sleep(std::time::Duration::from_millis(50));
                    self.start_count.fetch_add(1, Ordering::SeqCst);
                    return Ok(());
                }
                Err(anyhow::anyhow!("unexpected: {key}"))
            }
        }

        let runner = Arc::new(ConcurrentRunner {
            start_count: Arc::clone(&start_count),
        });
        let runner2 = Arc::clone(&runner);

        let h1 = std::thread::spawn(move || {
            let rt = LimaRuntime::with_runner(Box::new(ArcRunner(runner)));
            rt.ensure_ready()
        });
        let h2 = std::thread::spawn(move || {
            let rt = LimaRuntime::with_runner(Box::new(ArcRunner(runner2)));
            rt.ensure_ready()
        });

        let r1 = h1.join().unwrap();
        let r2 = h2.join().unwrap();
        assert!(r1.is_ok(), "thread 1 should succeed: {:?}", r1);
        assert!(r2.is_ok(), "thread 2 should succeed: {:?}", r2);

        // The lock ensures only one thread actually calls `limactl start`.
        // The second thread sees "Running" after acquiring the lock.
        assert_eq!(
            start_count.load(Ordering::SeqCst),
            1,
            "limactl start should be called exactly once, not twice"
        );
    }

    /// Adapter that implements `CommandRunner` by delegating to an `Arc<T>`.
    struct ArcRunner<T: CommandRunner>(Arc<T>);
    impl<T: CommandRunner> CommandRunner for ArcRunner<T> {
        fn run(&self, cmd: &str, args: &[&str]) -> anyhow::Result<String> {
            self.0.run(cmd, args)
        }
        fn run_raw_stdout(&self, cmd: &str, args: &[&str]) -> anyhow::Result<Vec<u8>> {
            self.0.run(cmd, args).map(|s| s.into_bytes())
        }
        fn run_with_timeout(
            &self,
            cmd: &str,
            args: &[&str],
            timeout: std::time::Duration,
        ) -> anyhow::Result<()> {
            self.0.run_with_timeout(cmd, args, timeout)
        }
    }

    /// Helper: creates a MockRunner that already has `is_available()` responses
    /// configured so `require_running()` succeeds.
    fn mock_runner_with_vm_running() -> MockRunner {
        MockRunner::new()
            .with_response("limactl --version", "limactl version 1.0.0")
            .with_response(
                &format!(
                    "limactl list --format {{{{.Status}}}} {}",
                    consts::LIMA_VM_NAME
                ),
                "Running",
            )
    }

    #[test]
    fn test_container_logs_calls_nerdctl_logs() {
        let runner = mock_runner_with_vm_running().with_response(
            &format!(
                "limactl shell {} -- sudo nerdctl logs --tail 100 speedwave_acme_claude",
                consts::LIMA_VM_NAME
            ),
            "line1\nline2\nline3",
        );
        let rt = LimaRuntime::with_runner(Box::new(runner));
        let logs = rt.container_logs("speedwave_acme_claude", 100).unwrap();
        assert_eq!(logs, "line1\nline2\nline3");
    }

    #[test]
    fn test_compose_up_recreate_includes_force_recreate_and_remove_orphans() {
        let (recorded, runner) = make_recording_runner();
        let rt = LimaRuntime::with_runner(runner);
        rt.compose_up_recreate("testproject").unwrap();

        let commands = recorded.lock().unwrap();
        assert_eq!(commands.len(), 1);
        assert!(
            commands[0].contains("nerdctl compose"),
            "command should be nerdctl compose, got: {}",
            commands[0]
        );
        assert!(
            commands[0].contains("up"),
            "command should include 'up', got: {}",
            commands[0]
        );
        assert!(
            commands[0].contains("--force-recreate"),
            "command should include '--force-recreate', got: {}",
            commands[0]
        );
        assert!(
            commands[0].contains("--remove-orphans"),
            "command should include '--remove-orphans', got: {}",
            commands[0]
        );
        assert!(
            commands[0].contains("-p testproject"),
            "command should include project name, got: {}",
            commands[0]
        );
    }

    #[test]
    fn test_compose_logs_calls_nerdctl_compose_logs() {
        let compose_file = crate::runtime::compose_file_path("acme").unwrap();
        let runner = mock_runner_with_vm_running().with_response(
            &format!(
                "limactl shell {} -- sudo nerdctl compose -f {} -p acme logs --timestamps --tail 200",
                consts::LIMA_VM_NAME,
                compose_file
            ),
            "hub | started\nclaude | ready",
        );
        let rt = LimaRuntime::with_runner(Box::new(runner));
        let logs = rt.compose_logs("acme", 200).unwrap();
        assert_eq!(logs, "hub | started\nclaude | ready");
    }

    #[test]
    fn test_container_exec_piped_fails_when_vm_stopped() {
        let runner = MockRunner::new()
            .with_response("limactl --version", "limactl version 1.0.0")
            .with_response(
                &format!(
                    "limactl list --format {{{{.Status}}}} {}",
                    consts::LIMA_VM_NAME
                ),
                "Stopped",
            );
        let rt = LimaRuntime::with_runner(Box::new(runner));
        let err = rt
            .container_exec_piped("test_container", &["claude", "-p"])
            .unwrap_err();
        assert!(
            err.to_string().contains("not running"),
            "should report VM not running, got: {err}"
        );
    }

    #[test]
    fn test_prepare_build_context_path_under_home_unchanged() {
        let tmp = tempfile::tempdir().unwrap();
        let fake_home = tmp.path().join("home");
        std::fs::create_dir_all(&fake_home).unwrap();
        let path_under_home = fake_home.join("projects").join("speedwave");
        let result = prepare_build_context_with_home(&path_under_home, &fake_home).unwrap();
        assert_eq!(result, path_under_home);
    }

    #[test]
    fn test_prepare_build_context_outside_home_copies_to_cache() {
        let tmp = tempfile::tempdir().unwrap();
        let fake_home = tmp.path().join("home");
        std::fs::create_dir_all(&fake_home).unwrap();

        let build_root = tmp.path().join("AppResources").join("build-context");
        std::fs::create_dir_all(build_root.join("containers")).unwrap();
        std::fs::write(
            build_root.join("containers").join("Containerfile"),
            "FROM scratch",
        )
        .unwrap();
        std::fs::create_dir_all(build_root.join("mcp-servers")).unwrap();
        std::fs::write(build_root.join("mcp-servers").join("package.json"), "{}").unwrap();

        let result = prepare_build_context_with_home(&build_root, &fake_home).unwrap();

        let expected_cache = fake_home.join(consts::DATA_DIR).join("build-cache");
        assert_eq!(result, expected_cache);
        assert!(expected_cache
            .join("containers")
            .join("Containerfile")
            .exists());
        assert!(expected_cache
            .join("mcp-servers")
            .join("package.json")
            .exists());
    }

    #[test]
    fn test_prepare_build_context_cleans_stale_cache() {
        let tmp = tempfile::tempdir().unwrap();
        let fake_home = tmp.path().join("home");
        let cache = fake_home.join(consts::DATA_DIR).join("build-cache");

        // Create stale cache with a leftover file
        std::fs::create_dir_all(cache.join("stale-dir")).unwrap();
        std::fs::write(cache.join("stale-dir").join("old.txt"), "stale").unwrap();

        let build_root = tmp.path().join("fresh");
        std::fs::create_dir_all(build_root.join("containers")).unwrap();
        std::fs::write(build_root.join("containers").join("new.txt"), "fresh").unwrap();

        let result = prepare_build_context_with_home(&build_root, &fake_home).unwrap();

        assert_eq!(result, cache);
        assert!(
            !cache.join("stale-dir").exists(),
            "stale dir should be removed"
        );
        assert!(cache.join("containers").join("new.txt").exists());
    }

    #[test]
    fn test_copy_dir_recursive_copies_files_and_subdirs() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("src");
        std::fs::create_dir_all(src.join("sub")).unwrap();
        std::fs::write(src.join("file.txt"), "root").unwrap();
        std::fs::write(src.join("sub").join("nested.txt"), "nested").unwrap();

        let dst = tmp.path().join("dst");
        copy_dir_recursive(&src, &dst).unwrap();

        assert_eq!(
            std::fs::read_to_string(dst.join("file.txt")).unwrap(),
            "root"
        );
        assert_eq!(
            std::fs::read_to_string(dst.join("sub").join("nested.txt")).unwrap(),
            "nested"
        );
    }

    #[test]
    fn test_container_exec_piped_fails_when_limactl_missing() {
        let runner = MockRunner::new().with_error("limactl --version", "command not found");
        let rt = LimaRuntime::with_runner(Box::new(runner));
        let err = rt
            .container_exec_piped("test_container", &["claude", "-p"])
            .unwrap_err();
        assert!(
            err.to_string().contains("not running"),
            "should report VM not running when limactl missing, got: {err}"
        );
    }

    #[test]
    fn test_require_running_fails_when_vm_stopped() {
        let runner = MockRunner::new()
            .with_response("limactl --version", "limactl version 1.0.0")
            .with_response(
                &format!(
                    "limactl list --format {{{{.Status}}}} {}",
                    consts::LIMA_VM_NAME
                ),
                "Stopped",
            );
        let rt = LimaRuntime::with_runner(Box::new(runner));
        let err = rt.compose_ps("testproject").unwrap_err();
        assert!(
            err.to_string().contains("not running"),
            "should report VM not running, got: {err}"
        );
    }

    #[test]
    fn test_require_running_fails_when_limactl_missing() {
        let runner = MockRunner::new().with_error("limactl --version", "command not found");
        let rt = LimaRuntime::with_runner(Box::new(runner));
        let err = rt.compose_down("testproject").unwrap_err();
        assert!(
            err.to_string().contains("not running"),
            "should report VM not running when limactl missing, got: {err}"
        );
    }

    #[test]
    fn test_copy_dir_recursive_empty_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("empty-src");
        std::fs::create_dir_all(&src).unwrap();

        let dst = tmp.path().join("empty-dst");
        copy_dir_recursive(&src, &dst).unwrap();

        assert!(dst.exists());
        assert!(dst.is_dir());
        assert_eq!(std::fs::read_dir(&dst).unwrap().count(), 0);
    }

    #[test]
    fn test_copy_dir_recursive_skips_symlinked_dirs() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("src");
        std::fs::create_dir_all(src.join("real")).unwrap();
        std::fs::write(src.join("real").join("file.txt"), "ok").unwrap();

        // Create a symlink that points back to root — would cause infinite recursion
        #[cfg(unix)]
        std::os::unix::fs::symlink(&src, src.join("cycle")).unwrap();

        let dst = tmp.path().join("dst");
        copy_dir_recursive(&src, &dst).unwrap();

        assert!(dst.join("real").join("file.txt").exists());
        // Symlinked directory is skipped entirely — no "cycle" entry in output
        #[cfg(unix)]
        assert!(!dst.join("cycle").exists());
    }

    #[test]
    fn test_prepare_build_context_trait_path_under_home() {
        let runner = MockRunner::new();
        let rt = LimaRuntime::with_runner(Box::new(runner));
        let home = dirs::home_dir().unwrap();
        let path = home.join("projects").join("speedwave");
        let result = rt.prepare_build_context(&path).unwrap();
        assert_eq!(result, path);
    }

    #[test]
    fn test_system_prune_shells_out_to_lima() {
        let (recorded, runner) = make_recording_runner();
        let rt = LimaRuntime::with_runner(runner);
        assert!(
            rt.system_prune().is_ok(),
            "LimaRuntime::system_prune should succeed"
        );

        let commands = recorded.lock().unwrap();
        assert_eq!(
            commands.len(),
            1,
            "system_prune should issue exactly 1 command, got: {:?}",
            *commands
        );
        assert!(
            commands[0].contains("nerdctl system prune --force"),
            "system_prune should run nerdctl system prune --force, got: {}",
            commands[0]
        );
    }

    #[test]
    fn test_build_image_passes_build_args() {
        let (recorded, runner) = make_recording_runner();
        let rt = LimaRuntime::with_runner(runner);
        let version = crate::defaults::CLAUDE_VERSION;
        rt.build_image(
            "my-image:latest",
            "/ctx",
            "/ctx/Containerfile",
            &[("CLAUDE_VERSION", version)],
        )
        .unwrap();

        let commands = recorded.lock().unwrap();
        assert_eq!(commands.len(), 1);
        let expected = format!("--build-arg CLAUDE_VERSION={}", version);
        assert!(
            commands[0].contains(&expected),
            "build_image should pass {expected}, got: {}",
            commands[0]
        );
    }

    #[test]
    fn test_system_prune_fails_when_vm_stopped() {
        let runner = MockRunner::new()
            .with_response("limactl --version", "limactl version 1.0.0")
            .with_response(
                &format!(
                    "limactl list --format {{{{.Status}}}} {}",
                    consts::LIMA_VM_NAME
                ),
                "Stopped",
            );
        let rt = LimaRuntime::with_runner(Box::new(runner));
        let err = rt.system_prune().unwrap_err();
        assert!(
            err.to_string().contains("not running"),
            "should report VM not running, got: {err}"
        );
    }

    #[test]
    fn test_prune_buildkit_cache_shells_out_to_lima() {
        let (recorded, runner) = make_recording_runner();
        let rt = LimaRuntime::with_runner(runner);
        assert!(
            rt.prune_buildkit_cache().is_ok(),
            "LimaRuntime::prune_buildkit_cache should succeed"
        );
        let commands = recorded.lock().unwrap();
        assert_eq!(
            commands.len(),
            1,
            "prune_buildkit_cache should issue exactly 1 command, got: {:?}",
            *commands
        );
        assert!(
            commands[0].contains("nerdctl builder prune --all --force"),
            "prune_buildkit_cache should run nerdctl builder prune --all --force, got: {}",
            commands[0]
        );
    }

    #[test]
    fn test_prune_buildkit_cache_fails_when_vm_stopped() {
        let runner = MockRunner::new()
            .with_response("limactl --version", "limactl version 1.0.0")
            .with_response(
                &format!(
                    "limactl list --format {{{{.Status}}}} {}",
                    consts::LIMA_VM_NAME
                ),
                "Stopped",
            );
        let rt = LimaRuntime::with_runner(Box::new(runner));
        let err = rt.prune_buildkit_cache().unwrap_err();
        assert!(
            err.to_string().contains("not running"),
            "should fail with VM-not-running error, got: {err}"
        );
    }

    #[test]
    fn test_prune_buildkit_cache_propagates_command_error() {
        let runner = mock_runner_with_vm_running().with_error(
            &format!(
                "limactl shell {} -- sudo nerdctl builder prune --all --force",
                consts::LIMA_VM_NAME
            ),
            "buildkit prune failed",
        );
        let rt = LimaRuntime::with_runner(Box::new(runner));
        let result = rt.prune_buildkit_cache();
        assert!(result.is_err());
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("buildkit prune failed"),
            "should propagate the command error message"
        );
    }

    #[test]
    fn test_remove_images_empty_tags_is_noop_after_require_running() {
        // VM is running, but no rmi command should be issued for empty tags
        let runner = mock_runner_with_vm_running();
        let rt = LimaRuntime::with_runner(Box::new(runner));
        assert!(
            rt.remove_images(&[]).is_ok(),
            "empty tags should return Ok without calling rmi"
        );
    }

    #[test]
    fn test_remove_images_happy_path() {
        let tags = vec![
            "speedwave-claude:abc123".to_string(),
            "speedwave-mcp-hub:abc123".to_string(),
        ];
        let runner = mock_runner_with_vm_running().with_response(
            &format!(
                "limactl shell {} -- sudo nerdctl rmi speedwave-claude:abc123 speedwave-mcp-hub:abc123",
                consts::LIMA_VM_NAME
            ),
            "",
        );
        let rt = LimaRuntime::with_runner(Box::new(runner));
        assert!(rt.remove_images(&tags).is_ok());
    }

    #[test]
    fn test_remove_images_error_is_warn_only() {
        let tags = vec!["speedwave-claude:abc123".to_string()];
        let runner = mock_runner_with_vm_running().with_error(
            &format!(
                "limactl shell {} -- sudo nerdctl rmi speedwave-claude:abc123",
                consts::LIMA_VM_NAME
            ),
            "no such image",
        );
        let rt = LimaRuntime::with_runner(Box::new(runner));
        // rmi failure must not propagate — just warn and return Ok
        assert!(
            rt.remove_images(&tags).is_ok(),
            "rmi failure should not propagate"
        );
    }

    #[test]
    fn test_remove_images_fails_when_vm_stopped() {
        let runner = MockRunner::new()
            .with_response("limactl --version", "limactl version 1.0.0")
            .with_response(
                &format!(
                    "limactl list --format {{{{.Status}}}} {}",
                    consts::LIMA_VM_NAME
                ),
                "Stopped",
            );
        let rt = LimaRuntime::with_runner(Box::new(runner));
        let err = rt
            .remove_images(&["speedwave-claude:abc123".to_string()])
            .unwrap_err();
        assert!(
            err.to_string().contains("not running"),
            "require_running error should propagate, got: {err}"
        );
    }

    #[test]
    fn test_restart_container_engine_ok() {
        let runner = mock_runner_with_vm_running()
            .with_response(
                &format!(
                    "limactl shell {} -- sudo systemctl restart containerd",
                    consts::LIMA_VM_NAME
                ),
                "",
            )
            .with_response(
                &format!(
                    "limactl shell {} -- sudo systemctl restart buildkit",
                    consts::LIMA_VM_NAME
                ),
                "",
            )
            .with_response(
                &format!(
                    "limactl shell {} -- sudo nerdctl info",
                    consts::LIMA_VM_NAME
                ),
                "containerd running",
            )
            .with_response(
                &format!(
                    "limactl shell {} -- sudo buildctl debug workers",
                    consts::LIMA_VM_NAME
                ),
                "buildkit ready",
            );
        let rt = LimaRuntime::with_runner(Box::new(runner)).with_zero_restart_delay();
        assert!(rt.restart_container_engine().is_ok());
    }

    #[test]
    fn test_restart_container_engine_buildkit_unit_not_found_still_polls() {
        let runner = mock_runner_with_vm_running()
            .with_response(
                &format!(
                    "limactl shell {} -- sudo systemctl restart containerd",
                    consts::LIMA_VM_NAME
                ),
                "",
            )
            .with_error(
                &format!(
                    "limactl shell {} -- sudo systemctl restart buildkit",
                    consts::LIMA_VM_NAME
                ),
                "unit not found",
            )
            .with_response(
                &format!(
                    "limactl shell {} -- sudo nerdctl info",
                    consts::LIMA_VM_NAME
                ),
                "containerd running",
            )
            .with_response(
                &format!(
                    "limactl shell {} -- sudo buildctl debug workers",
                    consts::LIMA_VM_NAME
                ),
                "buildkit ready",
            );
        let rt = LimaRuntime::with_runner(Box::new(runner)).with_zero_restart_delay();
        assert!(
            rt.restart_container_engine().is_ok(),
            "should succeed when buildkit unit not found but buildctl works"
        );
    }

    #[test]
    fn test_restart_container_engine_fails_when_vm_stopped() {
        let runner = MockRunner::new()
            .with_response("limactl --version", "limactl version 1.0.0")
            .with_response(
                &format!(
                    "limactl list --format {{{{.Status}}}} {}",
                    consts::LIMA_VM_NAME
                ),
                "Stopped",
            );
        let rt = LimaRuntime::with_runner(Box::new(runner)).with_zero_restart_delay();
        let err = rt.restart_container_engine().unwrap_err();
        assert!(
            err.to_string().contains("not running"),
            "should report VM not running, got: {err}"
        );
    }

    #[test]
    fn test_restart_container_engine_propagates_buildkit_error() {
        let runner = mock_runner_with_vm_running()
            .with_response(
                &format!(
                    "limactl shell {} -- sudo systemctl restart containerd",
                    consts::LIMA_VM_NAME
                ),
                "",
            )
            .with_error(
                &format!(
                    "limactl shell {} -- sudo systemctl restart buildkit",
                    consts::LIMA_VM_NAME
                ),
                "some other error",
            );
        let rt = LimaRuntime::with_runner(Box::new(runner)).with_zero_restart_delay();
        let result = rt.restart_container_engine();
        assert!(result.is_err());
        assert!(
            result.unwrap_err().to_string().contains("some other error"),
            "should propagate non-unit-not-found buildkit errors"
        );
    }

    // -----------------------------------------------------------------------
    // stop_vm() tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_stop_vm_running_vm_stops_it() {
        let runner = MockRunner::new()
            .with_response(
                &format!(
                    "limactl list --format {{{{.Status}}}} {}",
                    consts::LIMA_VM_NAME
                ),
                "Running",
            )
            .with_response(
                &format!("limactl stop --force {}", consts::LIMA_VM_NAME),
                "",
            );
        let rt = LimaRuntime::with_runner(Box::new(runner));
        assert!(
            rt.stop_vm().is_ok(),
            "stop_vm should succeed for a Running VM"
        );
    }

    #[test]
    fn test_stop_vm_already_stopped_skips_stop() {
        let runner = MockRunner::new().with_response(
            &format!(
                "limactl list --format {{{{.Status}}}} {}",
                consts::LIMA_VM_NAME
            ),
            "Stopped",
        );
        let rt = LimaRuntime::with_runner(Box::new(runner));
        assert!(
            rt.stop_vm().is_ok(),
            "stop_vm should return Ok when VM is already Stopped"
        );
    }

    #[test]
    fn test_stop_vm_empty_status_skips_stop() {
        let runner = MockRunner::new().with_response(
            &format!(
                "limactl list --format {{{{.Status}}}} {}",
                consts::LIMA_VM_NAME
            ),
            "",
        );
        let rt = LimaRuntime::with_runner(Box::new(runner));
        assert!(
            rt.stop_vm().is_ok(),
            "stop_vm should return Ok when status is empty"
        );
    }

    #[test]
    fn test_stop_vm_stopping_status_skips_stop() {
        let runner = MockRunner::new().with_response(
            &format!(
                "limactl list --format {{{{.Status}}}} {}",
                consts::LIMA_VM_NAME
            ),
            "Stopping",
        );
        let rt = LimaRuntime::with_runner(Box::new(runner));
        assert!(
            rt.stop_vm().is_ok(),
            "stop_vm should return Ok when VM is already Stopping (another process handles it)"
        );
    }

    #[test]
    fn test_stop_vm_creating_status_skips_stop() {
        let runner = MockRunner::new().with_response(
            &format!(
                "limactl list --format {{{{.Status}}}} {}",
                consts::LIMA_VM_NAME
            ),
            "Creating",
        );
        let rt = LimaRuntime::with_runner(Box::new(runner));
        assert!(
            rt.stop_vm().is_ok(),
            "stop_vm should return Ok when VM is Creating (setup wizard in progress)"
        );
    }

    #[test]
    fn test_stop_vm_stop_command_fails_returns_err() {
        let runner = MockRunner::new()
            .with_response(
                &format!(
                    "limactl list --format {{{{.Status}}}} {}",
                    consts::LIMA_VM_NAME
                ),
                "Running",
            )
            .with_error(
                &format!("limactl stop --force {}", consts::LIMA_VM_NAME),
                "limactl stop failed",
            );
        let rt = LimaRuntime::with_runner(Box::new(runner));
        let result = rt.stop_vm();
        assert!(
            result.is_err(),
            "stop_vm should propagate stop command error"
        );
        let err_msg = result.unwrap_err().to_string();
        assert!(
            err_msg.contains("Failed to stop Lima VM"),
            "error should mention VM stop failure, got: {err_msg}"
        );
    }

    #[test]
    fn test_stop_vm_status_with_whitespace_still_stops() {
        let runner = MockRunner::new()
            .with_response(
                &format!(
                    "limactl list --format {{{{.Status}}}} {}",
                    consts::LIMA_VM_NAME
                ),
                "  Running  \n",
            )
            .with_response(
                &format!("limactl stop --force {}", consts::LIMA_VM_NAME),
                "",
            );
        let rt = LimaRuntime::with_runner(Box::new(runner));
        assert!(
            rt.stop_vm().is_ok(),
            "stop_vm should handle whitespace around status"
        );
    }

    #[test]
    fn test_stop_vm_status_check_error_skips_stop() {
        let runner = MockRunner::new().with_error(
            &format!(
                "limactl list --format {{{{.Status}}}} {}",
                consts::LIMA_VM_NAME
            ),
            "limactl not found",
        );
        let rt = LimaRuntime::with_runner(Box::new(runner));
        assert!(
            rt.stop_vm().is_ok(),
            "stop_vm should return Ok when status check fails (unwrap_or_default gives empty string)"
        );
    }

    // -----------------------------------------------------------------------
    // ensure_ready_inner() "Stopping" arm tests
    //
    // Uses a SequencedRunner that returns responses in order for the same key.
    // -----------------------------------------------------------------------

    /// A CommandRunner that returns a sequence of responses for a given key.
    /// Once all responses are exhausted it returns the last one repeatedly.
    struct SequencedRunner {
        sequences: std::collections::HashMap<String, Arc<Mutex<Vec<String>>>>,
        fallback: std::collections::HashMap<String, anyhow::Result<String>>,
    }

    impl SequencedRunner {
        fn new() -> Self {
            Self {
                sequences: std::collections::HashMap::new(),
                fallback: std::collections::HashMap::new(),
            }
        }

        fn with_sequence(mut self, key: &str, responses: Vec<&str>) -> Self {
            self.sequences.insert(
                key.to_string(),
                Arc::new(Mutex::new(
                    responses.iter().map(|s| s.to_string()).collect(),
                )),
            );
            self
        }

        fn with_fallback(mut self, key: &str, response: &str) -> Self {
            self.fallback
                .insert(key.to_string(), Ok(response.to_string()));
            self
        }
    }

    impl CommandRunner for SequencedRunner {
        fn run(&self, cmd: &str, args: &[&str]) -> anyhow::Result<String> {
            let key = format!("{} {}", cmd, args.join(" "));
            if let Some(seq) = self.sequences.get(&key) {
                let mut v = seq.lock().unwrap();
                if v.len() > 1 {
                    return Ok(v.remove(0));
                }
                if let Some(last) = v.first() {
                    return Ok(last.clone());
                }
            }
            if let Some(r) = self.fallback.get(&key) {
                return match r {
                    Ok(s) => Ok(s.clone()),
                    Err(e) => Err(anyhow::anyhow!("{}", e)),
                };
            }
            Err(anyhow::anyhow!("unexpected command: {}", key))
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

    #[test]
    fn test_ensure_ready_stopping_then_stopped_starts_vm() {
        let vm = consts::LIMA_VM_NAME;
        let runner = SequencedRunner::new()
            // ensure_ready_inner calls: --version, then list (Stopping), then list (Stopped)
            .with_fallback("limactl --version", "limactl version 1.0.0")
            .with_sequence(
                &format!("limactl list --format {{{{.Status}}}} {vm}"),
                vec!["Stopping", "Stopped"],
            )
            .with_fallback(&format!("limactl start {vm}"), "");
        let rt = LimaRuntime::with_runner(Box::new(runner)).with_zero_vm_stop_poll_delay();
        assert!(
            rt.ensure_ready().is_ok(),
            "ensure_ready should succeed: Stopping → Stopped → start"
        );
    }

    #[test]
    fn test_ensure_ready_stopping_then_running_returns_ok_without_start() {
        let vm = consts::LIMA_VM_NAME;
        let runner = SequencedRunner::new()
            .with_fallback("limactl --version", "limactl version 1.0.0")
            .with_sequence(
                &format!("limactl list --format {{{{.Status}}}} {vm}"),
                vec!["Stopping", "Running"],
            );
        let rt = LimaRuntime::with_runner(Box::new(runner)).with_zero_vm_stop_poll_delay();
        assert!(
            rt.ensure_ready().is_ok(),
            "ensure_ready should return Ok when VM recovers to Running"
        );
    }

    #[test]
    fn test_ensure_ready_stopping_deadline_exceeded_returns_err() {
        // Runner whose `list --format` query always reports `Stopping`, so
        // `ensure_ready_inner`'s Stopping arm spins until the deadline fires.
        struct AlwaysStoppingRunner;
        impl CommandRunner for AlwaysStoppingRunner {
            fn run(&self, cmd: &str, args: &[&str]) -> anyhow::Result<String> {
                let key = format!("{} {}", cmd, args.join(" "));
                if key.contains("--version") {
                    return Ok("limactl version 1.0.0".to_string());
                }
                if key.contains("list --format") {
                    return Ok("Stopping".to_string());
                }
                Err(anyhow::anyhow!("unexpected: {key}"))
            }
        }

        // 1 ms stop timeout + zero poll delay → deadline expires on the first
        // iteration, so we exercise the real bail-out path in milliseconds
        // instead of the production 30 s value.
        let rt = LimaRuntime::with_runner(Box::new(AlwaysStoppingRunner))
            .with_zero_vm_stop_poll_delay()
            .with_stop_timeout(std::time::Duration::from_millis(1));

        let err = rt
            .ensure_ready()
            .expect_err("ensure_ready must return Err when VM is stuck in Stopping state");
        let msg = format!("{err}");
        assert!(
            msg.contains("stuck in Stopping state"),
            "error message must mention 'stuck in Stopping state', got: {msg}"
        );
        assert!(
            msg.contains("limactl stop --force"),
            "error message must include the recovery hint, got: {msg}"
        );
    }
}
