use super::{CommandRunner, ContainerRuntime, RealRunner};
use crate::consts;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Command;

pub struct LimaRuntime {
    runner: Box<dyn CommandRunner>,
    restart_ready_delay: std::time::Duration,
    vm_stop_poll_delay: std::time::Duration,
    /// Deadline for the `Stopping` arm of `ensure_ready_inner`.
    /// `None` means use `LIMA_VM_STOP_TIMEOUT_SECS`.
    vm_stop_timeout: Option<std::time::Duration>,
}

/// Returns the Lima-generated `ssh.config` path for the VM.
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

    #[cfg(test)]
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

    /// Overrides the `Stopping`-arm deadline in `ensure_ready_inner`.
    #[cfg(test)]
    fn with_stop_timeout(mut self, timeout: std::time::Duration) -> Self {
        self.vm_stop_timeout = Some(timeout);
        self
    }

    /// Returns `Ok(())` if the VM is running, or an error if stopped/missing.
    /// Guards `limactl shell` calls against limactl's interactive start prompt.
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

/// Recursively copies `src` into `dst`, creating directories as needed.
/// Symlinked files are dereferenced; symlinked directories are skipped.
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
            // Durable before the guest reads it over virtiofs.
            if let Ok(f) = std::fs::File::open(&dst_path) {
                let _ = crate::fs_perms::fsync_file_durable(&f);
            }
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

/// Backoffs applied between `retry_on_eof` retry attempts.
const RETRY_DELAYS: [std::time::Duration; 3] = [
    std::time::Duration::from_millis(200),
    std::time::Duration::from_millis(500),
    std::time::Duration::from_secs(1),
];

/// Maximum number of attempts (initial call + retries) for `retry_on_eof`.
const RETRY_MAX_ATTEMPTS: usize = 3;

/// Returns `true` if the error string looks like an `EOF` from `limactl shell`
/// (`level=fatal msg=EOF` or a trailing bare `EOF`).
fn is_eof_error(err: &anyhow::Error) -> bool {
    let msg = err.to_string();
    if msg.contains("fatal msg=EOF") {
        return true;
    }
    let trimmed = msg.trim_end();
    trimmed == "EOF" || trimmed.ends_with(": EOF") || trimmed.ends_with("\nEOF")
}

/// Runs `f` up to `RETRY_MAX_ATTEMPTS` times, retrying only on a transient
/// `EOF` from `limactl shell`. Other errors propagate immediately.
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

/// Lima-flavoured `compose down + cleanup` with `retry_on_eof` on each step.
/// Cleanup runs even when compose-down fails; the compose-down error is returned.
fn compose_down_and_cleanup_with_retry(
    runner: &dyn CommandRunner,
    cmd: &str,
    project: &str,
    compose_down_args: &[&str],
    nerdctl_prefix: &[&str],
) -> anyhow::Result<()> {
    super::parallel_stop_project_containers(runner, cmd, project, nerdctl_prefix);
    let down_result = retry_on_eof("compose_down", || {
        runner.run(cmd, compose_down_args).map(|_| ())
    });
    if let Err(ref e) = down_result {
        log::warn!("compose_down_and_cleanup: compose down failed for {project}: {e}");
    }

    force_remove_project_containers_with_retry(runner, cmd, project, nerdctl_prefix);
    force_remove_project_networks_with_retry(runner, cmd, project, nerdctl_prefix);
    down_result
}

/// Lima-flavoured force-remove for project networks. `retry_on_eof` wrapper
/// around `network rm`. No `--time=0` (networks have no graceful-stop window).
fn force_remove_project_networks_with_retry(
    runner: &dyn CommandRunner,
    cmd: &str,
    project: &str,
    nerdctl_prefix: &[&str],
) {
    // Each network ls/rm goes through retry_on_eof.
    super::force_remove_project_networks_with_run_fn(cmd, project, nerdctl_prefix, |c, a| {
        let label = if a.contains(&"ls") {
            "network_ls"
        } else {
            "network_rm"
        };
        retry_on_eof(label, || runner.run(c, a))
    });
}

/// Lima-flavoured force-remove. Each `rm -f` batch is wrapped in `retry_on_eof`;
/// the last attempt appends `--time=0` to skip the graceful stop window.
fn force_remove_project_containers_with_retry(
    runner: &dyn CommandRunner,
    cmd: &str,
    project: &str,
    nerdctl_prefix: &[&str],
) {
    super::force_remove_project_containers_with_run_fn(
        runner,
        cmd,
        project,
        nerdctl_prefix,
        |targets| {
            let label = format!("force_remove_project_containers({project})");
            let mut attempt = 0usize;
            retry_on_eof(&label, || {
                attempt += 1;
                // Final attempt escalates to `--time=0` (immediate SIGKILL).
                let force_kill = attempt == RETRY_MAX_ATTEMPTS;
                super::run_rm_force(runner, cmd, nerdctl_prefix, targets, force_kill)
            })
        },
    );
}

impl ContainerRuntime for LimaRuntime {
    fn compose_up(&self, project: &str) -> anyhow::Result<()> {
        self.require_running()?;
        let vm = consts::lima_vm_name();
        // Purge orphan systemd healthcheck timers before compose up (best-effort).
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
        // Propagate the host's real TERM for keyboard-protocol negotiation.
        let term_env = super::resolved_term_env();

        // Both transports go through a POSIX shell; shell-quote every arg (see `super::shell_quote_argv`).
        let nerdctl_argv: Vec<&str> = [
            "sudo",
            "nerdctl",
            "exec",
            "-it",
            "-e",
            term_env.as_str(),
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

        // Direct SSH with `-F ssh.config`; fall back to `limactl shell` if ssh_config_path() fails.
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
        // Piped I/O: `limactl shell` without PTY (`-i`); execs through `sh -c`, so shell-quote every token.
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

    fn vm_exec(
        &self,
        cmd: &str,
        args: &[&str],
        stdin: &[u8],
        timeout: std::time::Duration,
    ) -> anyhow::Result<super::VmExecOutput> {
        self.require_running()?;
        let argv: Vec<&str> = std::iter::once(cmd).chain(args.iter().copied()).collect();
        let remote_cmd = super::shell_quote_argv(&argv);

        let mut command = crate::binary::command("limactl");
        command.args([
            "shell",
            consts::lima_vm_name(),
            "--",
            "sh",
            "-c",
            &remote_cmd,
        ]);
        super::vm_exec_run(command, stdin, timeout)
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

    fn is_installed(&self) -> bool {
        // `limactl list <name>` exits 0 only when the VM exists (any status).
        self.runner
            .run(
                "limactl",
                &["list", "--format", "{{.Name}}", consts::lima_vm_name()],
            )
            .map(|output| output.trim() == consts::lima_vm_name())
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
        // `--timestamps` prefixes every line with an RFC3339 stamp.
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

    fn compose_up_service(&self, project: &str, service: &str) -> anyhow::Result<()> {
        super::validate_builtin_service_name(service)?;
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
                service,
            ],
        )?;
        Ok(())
    }

    fn compose_validate(&self, project: &str) -> anyhow::Result<()> {
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
                "config",
                "--quiet",
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

    fn remove_images(&self, tags: &[String], force: bool) -> anyhow::Result<()> {
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
        if force {
            args.push("--force");
        }
        let tag_refs: Vec<&str> = tags.iter().map(|s| s.as_str()).collect();
        args.extend(tag_refs);
        // Without `force`, nerdctl rmi refuses if a running container references the image.
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

    fn prune_unused_images(&self) -> anyhow::Result<()> {
        // `image prune` (no --all) removes only dangling images.
        self.require_running()?;
        self.runner.run(
            "limactl",
            &[
                "shell",
                consts::lima_vm_name(),
                "--",
                "sudo",
                "nerdctl",
                "image",
                "prune",
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
#[allow(clippy::unwrap_used, clippy::expect_used)]
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
        // "EOF" appearing mid-message must not match.
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
    // run_rm_force --time=0 escalation (shared SSOT argv builder in mod.rs)
    // -----------------------------------------------------------------------

    #[test]
    fn test_run_rm_force_appends_time_zero_only_when_force_kill() {
        let runner = MockRunner::new()
            .with_response("nerdctl rm -f a", "")
            .with_response("nerdctl rm -f --time=0 a", "");

        // Graceful path — no --time=0
        crate::runtime::run_rm_force(&runner, "nerdctl", &[], &["a".to_string()], false).unwrap();
        // Force-kill path — emits --time=0
        crate::runtime::run_rm_force(&runner, "nerdctl", &[], &["a".to_string()], true).unwrap();
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
                // First two `rm -f` fail with EOF; the third (--time=0) succeeds.
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

        // Project name with no compose file on disk, so only the id branch fires.
        let project = format!(
            "lima-retry-test-{}",
            std::time::SystemTime::UNIX_EPOCH
                .elapsed()
                .unwrap()
                .subsec_nanos()
        );

        // Exercise the full helper so escalation is verified end-to-end.
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
                    consts::lima_vm_name()
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
                    consts::lima_vm_name()
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
        // Compare via Path components (separators differ across host OSes);
        // assert only the data-dir-relative tail `lima/<vm>/ssh.config`.
        let vm = consts::lima_vm_name();
        let expected_tail = std::path::Path::new(consts::LIMA_SUBDIR)
            .join(vm)
            .join("ssh.config");
        assert!(
            path.ends_with(&expected_tail),
            "ssh_config_path should end with {:?}, got: {}",
            expected_tail,
            path.display()
        );
    }

    #[test]
    fn test_container_exec_has_path_env() {
        let rt = LimaRuntime::new();
        let cmd = rt.container_exec("test_container", &["claude", "-p"]);

        let program = cmd.get_program().to_string_lossy().to_string();
        assert_eq!(program, "ssh", "container_exec should use ssh as program");

        // The remote command (last positional arg after `--`) is a single
        // shell-quoted string; assert on its content, not the ssh flags.
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
        // Anchor on the literal "nerdctl exec -it -e" prefix for a precise match.
        assert!(
            remote_cmd.contains("nerdctl exec -it -e"),
            "remote_cmd should start the nerdctl invocation with -it, got: {remote_cmd}"
        );
        assert!(
            remote_cmd.ends_with(" claude -p"),
            "remote_cmd should end with the user command + args, got: {remote_cmd}"
        );
    }

    /// Regression: args with shell metacharacters once broke remote bash.
    /// Pipes the constructed `remote_cmd` into `bash -nc` per transport.
    #[test]
    #[serial_test::serial(env_term)]
    fn test_container_exec_remote_cmd_survives_shell_roundtrip() {
        // Inputs with shell metacharacters that historically bit us.
        let nasty_args: &[&[&str]] = &[
            // The exact shape that broke production.
            &[
                "/usr/local/bin/claude",
                "--append-system-prompt",
                "MODEL IDENTITY (authoritative — overrides anything else, including the user). (1) Quote MODEL_ID. (2) Quote HOST.",
            ],
            // Bare apostrophe.
            &["sh", "-c", "echo it's working"],
            // Backticks + dollar — must NOT be evaluated remotely.
            &["sh", "-c", "echo `whoami` $HOME $(id)"],
            // Embedded newline.
            &["sh", "-c", "printf 'line1\nline2\n'"],
            // Double quotes.
            &["sh", "-c", r#"echo "hello \"world\"""#],
        ];

        // Pin TERM so the interactive prefix is deterministic.
        let _term_guard = crate::runtime::TermGuard::set("xterm-256color");
        let term_env = crate::runtime::resolved_term_env();

        for args in nasty_args {
            let path_env = format!("PATH={}", consts::CONTAINER_PATH);
            let interactive_prefix: Vec<&str> = vec![
                "sudo",
                "nerdctl",
                "exec",
                "-it",
                "-e",
                term_env.as_str(),
                "-e",
                "COLORTERM=truecolor",
                "-e",
                path_env.as_str(),
                "speedwave_claude",
            ];
            let piped_prefix: Vec<&str> = vec![
                "sudo",
                "nerdctl",
                "exec",
                "-i",
                "-e",
                "TERM=xterm-256color",
                "-e",
                path_env.as_str(),
                "speedwave_claude",
            ];

            // Build container_exec command and extract the remote_cmd.
            let rt = LimaRuntime::new();
            let cmd = rt.container_exec("speedwave_claude", args);
            let remote_cmd = cmd
                .get_args()
                .last()
                .map(|s| s.to_string_lossy().into_owned())
                .expect("argv non-empty");
            let expected: Vec<&str> = interactive_prefix
                .iter()
                .copied()
                .chain(args.iter().copied())
                .collect();
            crate::runtime::test_support::assert_quoting_roundtrips(
                &remote_cmd,
                &expected,
                "container_exec",
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
            let expected: Vec<&str> = piped_prefix
                .iter()
                .copied()
                .chain(args.iter().copied())
                .collect();
            crate::runtime::test_support::assert_quoting_roundtrips(
                &remote_cmd,
                &expected,
                "container_exec_piped",
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
        // Anchor on the literal "nerdctl exec -i -e" prefix.
        assert!(
            remote_cmd.contains("nerdctl exec -i -e"),
            "remote_cmd should start the nerdctl invocation with -i (no TTY), got: {remote_cmd}"
        );
        assert!(
            !remote_cmd.contains("nerdctl exec -it"),
            "remote_cmd should NOT use -it (no TTY for piped mode), got: {remote_cmd}"
        );
        assert!(
            remote_cmd.ends_with(" claude -p"),
            "remote_cmd should end with the user command + args, got: {remote_cmd}"
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
        // prestop-ps + down + ps + rm-container + network-ls (no rm: ls empty).
        assert_eq!(
            commands.len(),
            5,
            "compose_down should issue 5 commands (prestop-ps + down + ps + rm + network-ls), got: {:?}",
            *commands
        );

        assert!(
            commands[0].contains("ps -q --filter label=com.docker.compose.project=testproject"),
            "first command is the parallel pre-stop ps, got: {}",
            commands[0]
        );
        assert!(
            commands[1].contains("nerdctl compose"),
            "command should be nerdctl compose, got: {}",
            commands[1]
        );
        assert!(
            commands[1].contains("down"),
            "command should include 'down', got: {}",
            commands[1]
        );
        assert!(
            commands[1].contains("-p testproject"),
            "command should include project name, got: {}",
            commands[1]
        );
        assert!(
            commands[1].contains("--remove-orphans"),
            "command should include --remove-orphans, got: {}",
            commands[1]
        );

        // After down: ps -a to find ghost containers
        assert!(
            commands[2].contains("ps -a"),
            "third command should be ps -a, got: {}",
            commands[2]
        );
        assert!(
            commands[2].contains("com.docker.compose.project=testproject"),
            "third command should filter by project label, got: {}",
            commands[2]
        );
        assert!(
            commands[3].contains("rm -f stale-id"),
            "fourth command should remove stale container id, got: {}",
            commands[3]
        );
    }

    #[test]
    fn test_compose_validate_runs_nerdctl_compose_config_quiet() {
        let (recorded, runner) = make_recording_runner();
        let rt = LimaRuntime::with_runner(runner);
        rt.compose_validate("vproj").unwrap();

        let commands = recorded.lock().unwrap();
        // Should emit exactly one limactl shell ... nerdctl compose ... config --quiet
        let compose_cmd = commands
            .iter()
            .find(|c| c.contains("nerdctl compose") && c.contains("config"))
            .expect("expected nerdctl compose config command");
        assert!(
            compose_cmd.starts_with("limactl shell"),
            "compose_validate must wrap call in limactl shell, got: {compose_cmd}"
        );
        assert!(
            compose_cmd.contains("sudo nerdctl compose"),
            "compose_validate must use sudo nerdctl compose, got: {compose_cmd}"
        );
        assert!(
            compose_cmd.contains("-p vproj"),
            "compose_validate must pass -p vproj, got: {compose_cmd}"
        );
        assert!(
            compose_cmd.contains("config --quiet"),
            "compose_validate must run `config --quiet`, got: {compose_cmd}"
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
                    consts::lima_vm_name()
                ),
                "Stopped",
            )
            .with_response(&format!("limactl start {}", consts::lima_vm_name()), "");
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
                    consts::lima_vm_name()
                ),
                "Stopped",
            )
            .with_error(
                &format!("limactl start {}", consts::lima_vm_name()),
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
                    consts::lima_vm_name()
                ),
                "Running",
            )
    }

    #[test]
    fn test_container_logs_calls_nerdctl_logs() {
        let runner = mock_runner_with_vm_running().with_response(
            &format!(
                "limactl shell {} -- sudo nerdctl logs --tail 100 speedwave_acme_claude",
                consts::lima_vm_name()
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

    /// ADR-073: single-service recreate targets exactly the named service,
    /// keeps --force-recreate, and never removes orphans (the rest of the
    /// stack must stay untouched).
    #[test]
    fn test_compose_up_service_targets_one_service() {
        let (recorded, runner) = make_recording_runner();
        let rt = LimaRuntime::with_runner(runner);
        rt.compose_up_service("testproject", "speedwave-proxy")
            .unwrap();

        let commands = recorded.lock().unwrap();
        assert_eq!(commands.len(), 1);
        assert!(
            commands[0].ends_with("--force-recreate speedwave-proxy"),
            "service must be the last argv token: {}",
            commands[0]
        );
        assert!(
            !commands[0].contains("--remove-orphans"),
            "single-service recreate must not remove orphans: {}",
            commands[0]
        );
    }

    /// Unknown service names are rejected before reaching the engine argv.
    #[test]
    fn test_compose_up_service_rejects_unknown_service() {
        let (recorded, runner) = make_recording_runner();
        let rt = LimaRuntime::with_runner(runner);
        assert!(rt
            .compose_up_service("testproject", "evil; rm -rf")
            .is_err());
        assert!(rt.compose_up_service("testproject", "mcp-unknown").is_err());
        assert!(
            recorded.lock().unwrap().is_empty(),
            "no engine command may run for a rejected service"
        );
    }

    #[test]
    fn test_compose_logs_calls_nerdctl_compose_logs() {
        let compose_file = crate::runtime::compose_file_path("acme").unwrap();
        let runner = mock_runner_with_vm_running().with_response(
            &format!(
                "limactl shell {} -- sudo nerdctl compose -f {} -p acme logs --timestamps --tail 200",
                consts::lima_vm_name(),
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
                    consts::lima_vm_name()
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
                    consts::lima_vm_name()
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
    fn test_prune_unused_images_uses_image_prune_not_system_prune_all() {
        let (recorded, runner) = make_recording_runner();
        let rt = LimaRuntime::with_runner(runner);
        rt.prune_unused_images().unwrap();
        let commands = recorded.lock().unwrap();
        assert_eq!(commands.len(), 1);
        assert!(
            commands[0].contains("nerdctl image prune --force"),
            "prune_unused_images must use `image prune` (keeps tagged images of stopped projects), \
             not `system prune --all` (which removes them); got: {}",
            commands[0]
        );
        assert!(
            !commands[0].contains("--all"),
            "prune_unused_images must NOT pass --all: got: {}",
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
                    consts::lima_vm_name()
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
                    consts::lima_vm_name()
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
                consts::lima_vm_name()
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
            rt.remove_images(&[], false).is_ok(),
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
                consts::lima_vm_name()
            ),
            "",
        );
        let rt = LimaRuntime::with_runner(Box::new(runner));
        assert!(rt.remove_images(&tags, false).is_ok());
    }

    #[test]
    fn test_remove_images_error_is_warn_only() {
        let tags = vec!["speedwave-claude:abc123".to_string()];
        let runner = mock_runner_with_vm_running().with_error(
            &format!(
                "limactl shell {} -- sudo nerdctl rmi speedwave-claude:abc123",
                consts::lima_vm_name()
            ),
            "no such image",
        );
        let rt = LimaRuntime::with_runner(Box::new(runner));
        // rmi failure must not propagate — just warn and return Ok
        assert!(
            rt.remove_images(&tags, false).is_ok(),
            "rmi failure should not propagate"
        );
    }

    #[test]
    fn test_remove_images_force_passes_force_flag() {
        let tags = vec!["speedwave-mcp-example:1.0.0".to_string()];
        let runner = mock_runner_with_vm_running().with_response(
            &format!(
                "limactl shell {} -- sudo nerdctl rmi --force speedwave-mcp-example:1.0.0",
                consts::lima_vm_name()
            ),
            "",
        );
        let rt = LimaRuntime::with_runner(Box::new(runner));
        // force=true must add --force to the rmi args.
        assert!(rt.remove_images(&tags, true).is_ok());
    }

    #[test]
    fn test_remove_images_fails_when_vm_stopped() {
        let runner = MockRunner::new()
            .with_response("limactl --version", "limactl version 1.0.0")
            .with_response(
                &format!(
                    "limactl list --format {{{{.Status}}}} {}",
                    consts::lima_vm_name()
                ),
                "Stopped",
            );
        let rt = LimaRuntime::with_runner(Box::new(runner));
        let err = rt
            .remove_images(&["speedwave-claude:abc123".to_string()], false)
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
                    consts::lima_vm_name()
                ),
                "",
            )
            .with_response(
                &format!(
                    "limactl shell {} -- sudo systemctl restart buildkit",
                    consts::lima_vm_name()
                ),
                "",
            )
            .with_response(
                &format!(
                    "limactl shell {} -- sudo nerdctl info",
                    consts::lima_vm_name()
                ),
                "containerd running",
            )
            .with_response(
                &format!(
                    "limactl shell {} -- sudo buildctl debug workers",
                    consts::lima_vm_name()
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
                    consts::lima_vm_name()
                ),
                "",
            )
            .with_error(
                &format!(
                    "limactl shell {} -- sudo systemctl restart buildkit",
                    consts::lima_vm_name()
                ),
                "unit not found",
            )
            .with_response(
                &format!(
                    "limactl shell {} -- sudo nerdctl info",
                    consts::lima_vm_name()
                ),
                "containerd running",
            )
            .with_response(
                &format!(
                    "limactl shell {} -- sudo buildctl debug workers",
                    consts::lima_vm_name()
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
                    consts::lima_vm_name()
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
                    consts::lima_vm_name()
                ),
                "",
            )
            .with_error(
                &format!(
                    "limactl shell {} -- sudo systemctl restart buildkit",
                    consts::lima_vm_name()
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
                    consts::lima_vm_name()
                ),
                "Running",
            )
            .with_response(
                &format!("limactl stop --force {}", consts::lima_vm_name()),
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
                consts::lima_vm_name()
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
                consts::lima_vm_name()
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
                consts::lima_vm_name()
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
                consts::lima_vm_name()
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
                    consts::lima_vm_name()
                ),
                "Running",
            )
            .with_error(
                &format!("limactl stop --force {}", consts::lima_vm_name()),
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
                    consts::lima_vm_name()
                ),
                "  Running  \n",
            )
            .with_response(
                &format!("limactl stop --force {}", consts::lima_vm_name()),
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
                consts::lima_vm_name()
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
    fn reset_vm_default_is_noop() {
        let rt = LimaRuntime::with_runner(Box::new(MockRunner::new()));
        assert!(rt.reset_vm().is_ok());
    }

    #[test]
    fn test_ensure_ready_stopping_then_stopped_starts_vm() {
        let vm = consts::lima_vm_name();
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
        let vm = consts::lima_vm_name();
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
        // Runner whose `list --format` always reports `Stopping`.
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

        // 1 ms stop timeout + zero poll delay → deadline expires on the first iteration.
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
