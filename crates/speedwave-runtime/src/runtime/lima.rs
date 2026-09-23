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
    engine_teardown_started: fn() -> bool,
    start_gate: &'static VmStartGate,
    /// `None` means use `consts::data_dir()`. Test-only override so compose-path
    /// resolution never touches the shared data dir during a test run.
    #[cfg(test)]
    data_dir_override: Option<PathBuf>,
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
            engine_teardown_started: super::engine_teardown_started,
            start_gate: &VM_START_GATE,
            #[cfg(test)]
            data_dir_override: None,
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
            engine_teardown_started: || false,
            start_gate: Box::leak(Box::new(VmStartGate::new())),
            data_dir_override: None,
        }
    }

    /// Redirects compose-path resolution to an explicit data dir instead of
    /// `consts::data_dir()` — keeps disk-writing tests off the shared data dir.
    #[cfg(test)]
    fn with_data_dir(mut self, data_dir: PathBuf) -> Self {
        self.data_dir_override = Some(data_dir);
        self
    }

    /// Resolves a project's compose path under `data_dir_override` in tests,
    /// or the real `consts::data_dir()` in production.
    fn compose_file_path(&self, project: &str) -> anyhow::Result<String> {
        #[cfg(test)]
        if let Some(dir) = &self.data_dir_override {
            return super::compose_file_path_in(dir, project);
        }
        super::compose_file_path(project)
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

    #[cfg(test)]
    fn with_engine_teardown_check(mut self, started: fn() -> bool) -> Self {
        self.engine_teardown_started = started;
        self
    }

    fn read_vm_listing(&self, format: &str) -> anyhow::Result<String> {
        self.runner.run_bounded(
            "limactl",
            &["list", "--format", format, consts::lima_vm_name()],
            consts::VM_LIST_TIMEOUT,
        )
    }

    fn read_vm_status(&self) -> anyhow::Result<String> {
        match self.read_vm_listing("{{.Status}}") {
            Err(e) if e.to_string().contains(LIMA_UNMATCHED_INSTANCES) => Ok(String::new()),
            status => status,
        }
    }

    fn require_running(&self) -> anyhow::Result<()> {
        if self.is_available() {
            Ok(())
        } else {
            anyhow::bail!("Lima VM '{}' is not running.", consts::lima_vm_name())
        }
    }

    fn parse_version(version_output: &str) -> Option<(u32, u32, u32)> {
        super::parse_version(version_output)
    }

    /// Flushes the stale CNI iptables chains / bridges in `targets` in the Lima VM
    /// via `sudo`. Best-effort; see [`super::cni_cleanup_command`].
    fn cleanup_stale_cni(&self, targets: &super::CniTargets) -> anyhow::Result<()> {
        let vm = consts::lima_vm_name();
        let cmd = super::cni_cleanup_command(targets);
        self.runner
            .run("limactl", &["shell", vm, "--", "sudo", "sh", "-c", &cmd])
            .map(|_| ())
    }

    /// Releases the project's provably-dead name-store reservations named in `err`
    /// (fail-closed, under the store flock); see [`super::name_store_heal_command_in`].
    fn cleanup_stale_name_store(&self, err: &anyhow::Error, project: &str) -> anyhow::Result<()> {
        let vm = consts::lima_vm_name();
        let cmd =
            super::name_store_heal_command_in(&super::NameStoreLayout::production(), err, project);
        self.runner
            .run("limactl", &["shell", vm, "--", "sudo", "sh", "-c", &cmd])
            .map(|_| ())
    }

    /// Ghost sweep for a project with no rendered compose.yml (down path);
    /// see [`super::name_store_sweep_command_in`].
    fn sweep_stale_name_store(&self, project: &str) -> anyhow::Result<()> {
        let vm = consts::lima_vm_name();
        let cmd = super::name_store_sweep_command_in(
            &super::NameStoreLayout::production(),
            project,
            &super::registered_compose_projects(),
        );
        self.runner
            .run("limactl", &["shell", vm, "--", "sudo", "sh", "-c", &cmd])
            .map(|_| ())
    }

    fn up_with_heal(
        &self,
        project: &str,
        compose_file: &str,
        mode: super::UpMode<'_>,
    ) -> anyhow::Result<()> {
        let up_argv = super::compose_up_argv(compose_file, project, mode);
        let rejoin_argv =
            super::compose_up_argv(compose_file, project, mode.after_task_collision());
        super::with_engine_state_heal(
            project,
            || run_bounded_up(&*self.runner, &up_argv),
            || run_bounded_up(&*self.runner, &rejoin_argv),
            |targets| self.cleanup_stale_cni(targets),
            |e| self.cleanup_stale_name_store(e, project),
        )
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
            continue;
        }
        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            std::fs::copy(&src_path, &dst_path)?;
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
                    "{label} hit a transient EOF on attempt {attempt}/{RETRY_MAX_ATTEMPTS}, \
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
        log::warn!("compose down failed for {project}: {e}");
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
                let force_kill = attempt == RETRY_MAX_ATTEMPTS;
                super::run_rm_force(runner, cmd, nerdctl_prefix, targets, force_kill)
            })
        },
    );
}

fn run_bounded_up(runner: &dyn CommandRunner, up_argv: &[String]) -> anyhow::Result<()> {
    let mut args = vec!["shell", consts::lima_vm_name(), "--", "sudo"];
    args.extend(up_argv.iter().map(String::as_str));
    runner
        .run("limactl", &args)
        .map(|_| ())
        .map_err(super::explain_compose_up_deadline)
}

impl ContainerRuntime for LimaRuntime {
    fn compose_up(&self, project: &str) -> anyhow::Result<()> {
        self.require_running()?;
        let vm = consts::lima_vm_name();
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

        let compose_file = self.compose_file_path(project)?;
        self.up_with_heal(project, &compose_file, super::UpMode::Diverged)
    }

    fn compose_down(&self, project: &str) -> anyhow::Result<()> {
        self.require_running()?;
        let vm = consts::lima_vm_name();
        let compose_file = self.compose_file_path(project)?;
        if super::compose_down_is_noop(&compose_file) {
            log::info!("no compose.yml for '{project}' — removing leftovers without compose down");
            let nerdctl_prefix = ["shell", vm, "--", "sudo", "nerdctl"];
            force_remove_project_containers_with_retry(
                &*self.runner,
                "limactl",
                project,
                &nerdctl_prefix,
            );
            force_remove_project_networks_with_retry(
                &*self.runner,
                "limactl",
                project,
                &nerdctl_prefix,
            );
            if let Err(e) = self.sweep_stale_name_store(project) {
                log::warn!("name-store sweep failed for '{project}': {e}");
            }
            return Ok(());
        }
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
        let compose_file = self.compose_file_path(project)?;
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
        let term_env = super::resolved_term_env();

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
        let mut command = crate::binary::interactive_command("ssh");
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
        self.read_vm_listing("{{.Status}}")
            .map(|output| output.trim() == "Running")
            .unwrap_or(false)
    }

    fn is_installed(&self) -> bool {
        self.read_vm_listing("{{.Name}}")
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
        let compose_file = self.compose_file_path(project)?;
        let tail_str = tail.to_string();
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
        let compose_file = self.compose_file_path(project)?;
        self.up_with_heal(project, &compose_file, super::UpMode::All)
    }

    fn compose_up_service(&self, project: &str, service: &str) -> anyhow::Result<()> {
        super::validate_builtin_service_name(service)?;
        self.require_running()?;
        let compose_file = self.compose_file_path(project)?;
        self.up_with_heal(project, &compose_file, super::UpMode::Service(service))
    }

    fn compose_validate(&self, project: &str) -> anyhow::Result<()> {
        self.require_running()?;
        let compose_file = self.compose_file_path(project)?;
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
        super::image_inspect_verdict(self.runner.run_bounded(
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
            consts::CONTAINER_EXEC_PROBE_TIMEOUT,
        ))
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
        let _held = self.start_gate.hold();
        let vm = consts::lima_vm_name();
        if self
            .start_gate
            .start_unfinished
            .swap(false, std::sync::atomic::Ordering::SeqCst)
        {
            log::info!("Lima VM '{vm}' may still be booting from a start that did not finish");
        } else if let Ok(status) = self
            .read_vm_status()
            .inspect_err(|e| log::warn!("Lima VM status check failed, stopping it anyway: {e}"))
        {
            let trimmed = status.trim();
            if trimmed != "Running" {
                if trimmed == "Stopping" {
                    log::debug!(
                        "Lima VM '{}' is in Stopping state, will be stopped on next ensure_ready",
                        vm,
                    );
                } else if trimmed.is_empty() {
                    log::debug!("Lima VM '{vm}' does not exist, skipping stop");
                } else {
                    log::debug!(
                        "Lima VM '{}' is not running (status: '{}'), skipping stop",
                        vm,
                        trimmed,
                    );
                }
                return Ok(());
            }
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

const LIMA_UNMATCHED_INSTANCES: &str = "unmatched instances";

pub(crate) struct VmStartGate {
    held: std::sync::Mutex<()>,
    start_unfinished: std::sync::atomic::AtomicBool,
}

impl VmStartGate {
    pub(crate) const fn new() -> Self {
        Self {
            held: std::sync::Mutex::new(()),
            start_unfinished: std::sync::atomic::AtomicBool::new(false),
        }
    }

    fn hold(&self) -> std::sync::MutexGuard<'_, ()> {
        self.held
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

pub(crate) static VM_START_GATE: VmStartGate = VmStartGate::new();

pub(crate) fn start_vm_unless_torn_down(
    runner: &dyn CommandRunner,
    gate: &VmStartGate,
    vm: &str,
    timeout: std::time::Duration,
    teardown_started: fn() -> bool,
) -> anyhow::Result<bool> {
    let _held = gate.hold();
    if teardown_started() {
        return Ok(false);
    }
    let started =
        runner.run_with_timeout_until("limactl", &["start", vm], timeout, &teardown_started);
    if !matches!(started, Ok(true)) {
        gate.start_unfinished
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }
    started
}

fn unreadable_vm_status(vm: &str, cause: &anyhow::Error) -> anyhow::Error {
    super::VmStatusUnreadable::error(format!("Cannot read the state of Lima VM '{vm}': {cause}"))
}

fn missing_vm(vm: &str) -> anyhow::Error {
    anyhow::anyhow!("Lima VM '{vm}' not found. Run Speedwave.app setup wizard to create it.")
}

impl LimaRuntime {
    fn start_stopped_vm(&self, vm: &str) -> anyhow::Result<()> {
        let timeout = std::time::Duration::from_secs(consts::LIMA_VM_PROVISION_START_TIMEOUT_SECS);
        log::info!(
            "Lima VM '{}' is stopped, starting (timeout: {}s; a one-time \
             container-tooling download may run first)",
            vm,
            timeout.as_secs()
        );
        let started = start_vm_unless_torn_down(
            self.runner.as_ref(),
            self.start_gate,
            vm,
            timeout,
            self.engine_teardown_started,
        )
        .map_err(|e| {
            anyhow::anyhow!(
                "Failed to start Lima VM '{vm}': {e}. {}",
                consts::LIMA_START_PROVISION_HINT
            )
        })?;
        if !started {
            log::info!("Lima VM '{vm}' stays stopped while the engine shuts down");
            return Err(anyhow::Error::new(super::EngineTearingDown));
        }
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

        let vm = consts::lima_vm_name();
        let status = self
            .read_vm_status()
            .map_err(|e| unreadable_vm_status(vm, &e))?;

        match status.trim() {
            "Running" => Ok(()),
            "Stopped" => self.start_stopped_vm(vm),
            "Stopping" => {
                log::info!("Lima VM '{}' is stopping, waiting for it to finish", vm);
                let stop_timeout = self.vm_stop_timeout.unwrap_or_else(|| {
                    std::time::Duration::from_secs(consts::LIMA_VM_STOP_TIMEOUT_SECS)
                });
                let deadline = std::time::Instant::now() + stop_timeout;
                let mut status_poll_failing = false;
                loop {
                    std::thread::sleep(self.vm_stop_poll_delay);
                    let s = match self.read_vm_status() {
                        Ok(s) => {
                            status_poll_failing = false;
                            s
                        }
                        Err(e) if std::time::Instant::now() >= deadline => {
                            return Err(unreadable_vm_status(vm, &e));
                        }
                        Err(e) => {
                            if !status_poll_failing {
                                log::warn!("Lima VM status poll failed (will retry): {e}");
                                status_poll_failing = true;
                            }
                            continue;
                        }
                    };
                    match s.trim() {
                        "Stopped" => {
                            log::info!("Lima VM '{}' finished stopping", vm);
                            break;
                        }
                        "Running" => {
                            log::info!("Lima VM '{}' is running again", vm);
                            return Ok(());
                        }
                        "" => return Err(missing_vm(vm)),
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
            "" => Err(missing_vm(vm)),
            other => {
                anyhow::bail!(
                    "Lima VM '{vm}' is in state '{other}', which Speedwave cannot start from."
                );
            }
        }
    }
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "test code: panics on failure are the expected fixture behavior"
)]
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
        assert!(!is_eof_error(&anyhow::anyhow!(
            "EOF reached but file still open"
        )));
    }

    #[test]
    fn test_is_eof_error_recognises_a_shaped_run_failure() {
        let stderr = "time=\"2026-09-16T10:00:00+02:00\" level=info msg=\"Running [nerdctl compose up]\"\ntime=\"2026-09-16T10:00:01+02:00\" level=fatal msg=EOF\n";
        let err = crate::runtime::run_failure("limactl", stderr.as_bytes(), b"");
        assert!(is_eof_error(&err), "got: {err}");
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

    #[test]
    fn test_run_rm_force_appends_time_zero_only_when_force_kill() {
        let runner = MockRunner::new()
            .with_response("nerdctl rm -f a", "")
            .with_response("nerdctl rm -f --time=0 a", "");

        crate::runtime::run_rm_force(&runner, "nerdctl", &[], &["a".to_string()], false).unwrap();
        crate::runtime::run_rm_force(&runner, "nerdctl", &[], &["a".to_string()], true).unwrap();
    }

    /// End-to-end check that `force_remove_project_containers_with_retry` (a) retries on EOF,
    /// (b) escalates to `--time=0` on the **last** attempt rather than giving up.
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

        let project = format!(
            "lima-retry-test-{}",
            std::time::SystemTime::UNIX_EPOCH
                .elapsed()
                .unwrap()
                .subsec_nanos()
        );

        force_remove_project_containers_with_retry(&runner, "nerdctl", &project, &[]);

        let observed = calls.lock().unwrap().clone();
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
        let nasty_args: &[&[&str]] = &[
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

    /// Creates a recording runner that reports the VM as "Running" for `require_running()` /
    /// `is_available()` checks, while recording all other commands for inspection.
    fn make_recording_runner() -> (Arc<Mutex<Vec<String>>>, Box<dyn CommandRunner>) {
        let recorded: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));

        struct ArcRecordingRunner {
            recorded: Arc<Mutex<Vec<String>>>,
        }

        impl CommandRunner for ArcRecordingRunner {
            fn run(&self, cmd: &str, args: &[&str]) -> anyhow::Result<String> {
                let key = format!("{} {}", cmd, args.join(" "));
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

        assert!(
            commands[1].contains("nerdctl compose"),
            "second command should be nerdctl compose up, got: {}",
            commands[1]
        );
    }

    #[test]
    fn compose_up_self_heals_stale_cni_and_retries_to_success() {
        const PROXY_CHAIN: &str = "CNI-d3c42d65590ae0cf2c72261f";
        const CLAUDE_CHAIN: &str = "CNI-1be9c452999fb96d888571d2";

        struct HealRunner {
            chains: Mutex<std::collections::VecDeque<&'static str>>,
            events: Arc<Mutex<Vec<String>>>,
        }
        impl CommandRunner for HealRunner {
            fn run(&self, cmd: &str, args: &[&str]) -> anyhow::Result<String> {
                if cmd == "limactl" && args.first() == Some(&"--version") {
                    return Ok("limactl version 1.0.0".to_string());
                }
                if cmd == "limactl" && args.first() == Some(&"list") {
                    return Ok("Running".to_string());
                }
                let joined = args.join(" ");
                if joined.contains("nerdctl")
                    && joined.contains("compose")
                    && joined.contains(" up ")
                {
                    self.events.lock().unwrap().push("up".to_string());
                    return match self.chains.lock().unwrap().pop_front() {
                        Some(chain) => Err(anyhow::anyhow!(
                            "running [/usr/sbin/iptables -t nat -N {chain} --wait]: iptables: Chain already exists"
                        )),
                        None => Ok(String::new()),
                    };
                }
                if joined.contains("base64 -d | sh") {
                    let sudo = if args.contains(&"sudo") { "sudo " } else { "" };
                    let script = crate::runtime::test_support::decode_payload(args.last().unwrap());
                    self.events
                        .lock()
                        .unwrap()
                        .push(format!("{sudo}cleanup:\n{script}"));
                }
                Ok(String::new())
            }
        }

        let events = Arc::new(Mutex::new(Vec::new()));
        let rt = LimaRuntime::with_runner(Box::new(HealRunner {
            chains: Mutex::new([PROXY_CHAIN, CLAUDE_CHAIN].into()),
            events: Arc::clone(&events),
        }));
        assert!(
            rt.compose_up("acme").is_ok(),
            "each stale chain a retry uncovers must be healed"
        );
        let events = events.lock().unwrap();
        assert_eq!(events.len(), 5, "up, cleanup, up, cleanup, up: {events:?}");
        for i in [0, 2, 4] {
            assert_eq!(events[i], "up", "event {i}: {events:?}");
        }
        for (i, own, other) in [
            (1, PROXY_CHAIN, CLAUDE_CHAIN),
            (3, CLAUDE_CHAIN, PROXY_CHAIN),
        ] {
            assert!(
                events[i].starts_with("sudo cleanup:"),
                "cleanup {i} runs via sudo between the failed up and its retry: {}",
                events[i]
            );
            assert!(
                events[i].contains(&format!("iptables -t nat -X {own}")),
                "cleanup {i} flushes the chain its own failure named: {}",
                events[i]
            );
            assert!(
                !events[i].contains(other),
                "cleanup {i} leaves the other chain alone: {}",
                events[i]
            );
        }
    }

    struct FirstUpFailsRunner {
        first_up_error: String,
        up_calls: Arc<std::sync::atomic::AtomicUsize>,
        up_argvs: Arc<Mutex<Vec<String>>>,
        cleanup_calls: Arc<std::sync::atomic::AtomicUsize>,
    }
    impl FirstUpFailsRunner {
        fn with_error(first_up_error: String) -> Self {
            Self {
                first_up_error,
                up_calls: Arc::default(),
                up_argvs: Arc::default(),
                cleanup_calls: Arc::default(),
            }
        }

        fn name_store_conflict() -> Self {
            Self::with_error(format!(
                "level=fatal msg=\"name-store error\\nname \\\"{}_acme_mcp_hub\\\" \
                 is already used by ID \\\"{}\\\"\"",
                consts::compose_prefix(),
                "db0da85287aa1119f5ef5483d7585c28ef721cf946111cf8d5369d308ecf450e"
            ))
        }
    }
    impl CommandRunner for FirstUpFailsRunner {
        fn run(&self, cmd: &str, args: &[&str]) -> anyhow::Result<String> {
            use std::sync::atomic::Ordering;
            if cmd == "limactl" && args.first() == Some(&"--version") {
                return Ok("limactl version 1.0.0".to_string());
            }
            if cmd == "limactl" && args.first() == Some(&"list") {
                return Ok("Running".to_string());
            }
            let joined = args.join(" ");
            if joined.contains("nerdctl") && joined.contains("compose") && joined.contains(" up ") {
                self.up_argvs.lock().unwrap().push(joined);
                if self.up_calls.fetch_add(1, Ordering::SeqCst) == 0 {
                    anyhow::bail!("{}", self.first_up_error);
                }
                return Ok(String::new());
            }
            if joined.contains("base64 -d | sh") {
                self.cleanup_calls.fetch_add(1, Ordering::SeqCst);
            }
            Ok(String::new())
        }
    }

    #[test]
    fn compose_up_recreate_self_heals_stale_name_store_and_retries() {
        use std::sync::atomic::Ordering;
        let runner = FirstUpFailsRunner::name_store_conflict();
        let up_calls = Arc::clone(&runner.up_calls);
        let cleanup_calls = Arc::clone(&runner.cleanup_calls);
        let rt = LimaRuntime::with_runner(Box::new(runner));
        assert!(
            rt.compose_up_recreate("acme").is_ok(),
            "a dead name-store reservation must self-heal and retry to success"
        );
        assert_eq!(up_calls.load(Ordering::SeqCst), 2, "up fail + retry");
        assert_eq!(cleanup_calls.load(Ordering::SeqCst), 1, "one heal payload");
    }

    #[test]
    fn compose_up_service_self_heals_stale_name_store_and_retries() {
        use std::sync::atomic::Ordering;
        let runner = FirstUpFailsRunner::name_store_conflict();
        let up_calls = Arc::clone(&runner.up_calls);
        let cleanup_calls = Arc::clone(&runner.cleanup_calls);
        let rt = LimaRuntime::with_runner(Box::new(runner));
        assert!(rt.compose_up_service("acme", "proxy").is_ok());
        assert_eq!(up_calls.load(Ordering::SeqCst), 2, "up fail + retry");
        assert_eq!(cleanup_calls.load(Ordering::SeqCst), 1, "one heal payload");
    }

    #[test]
    fn compose_up_service_rejoins_a_raced_proxy_without_recreating_it_again() {
        let runner = FirstUpFailsRunner::with_error(
            "limactl failed: level=fatal msg=\"1 errors:\\ntask \
             1d5a4194220fe7d0373e802431ebc3fb00fcd05d62508bfbeeca837658cf00bd: already exists\""
                .to_string(),
        );
        let up_argvs = Arc::clone(&runner.up_argvs);
        let rt = LimaRuntime::with_runner(Box::new(runner));
        rt.compose_up_service("acme", "proxy")
            .expect("the rejoin finds the proxy the restart monitor started");
        let up_argvs = up_argvs.lock().unwrap();
        assert_eq!(up_argvs.len(), 2, "{up_argvs:?}");
        assert!(
            up_argvs[0].ends_with(" up -d --force-recreate proxy"),
            "{up_argvs:?}"
        );
        assert!(up_argvs[1].ends_with(" up -d proxy"), "{up_argvs:?}");
    }

    #[test]
    fn compose_up_service_recreates_again_after_a_name_store_heal() {
        let runner = FirstUpFailsRunner::name_store_conflict();
        let up_argvs = Arc::clone(&runner.up_argvs);
        let rt = LimaRuntime::with_runner(Box::new(runner));
        rt.compose_up_service("acme", "proxy")
            .expect("a dead name-store reservation must self-heal and retry to success");
        let up_argvs = up_argvs.lock().unwrap();
        assert_eq!(up_argvs.len(), 2, "{up_argvs:?}");
        assert!(
            up_argvs
                .iter()
                .all(|argv| argv.ends_with(" up -d --force-recreate proxy")),
            "{up_argvs:?}"
        );
    }

    #[test]
    fn compose_down_without_compose_file_sweeps_leftovers() {
        let (recorded, runner) = make_recording_runner();
        let rt = LimaRuntime::with_runner(runner);
        rt.compose_down("lima-no-compose-sweep").unwrap();
        let commands = recorded.lock().unwrap();
        assert!(
            commands.iter().any(|c| c.contains("ps -a")
                && c.contains("label=com.docker.compose.project=lima-no-compose-sweep")),
            "live leftovers are looked up by project label: {commands:?}"
        );
        assert!(
            commands.iter().any(|c| c.contains("network ls")),
            "leftover networks are looked up: {commands:?}"
        );
        assert!(
            commands
                .iter()
                .any(|c| c.contains("sudo sh -c") && c.contains("base64 -d | sh")),
            "ghost name-store sweep runs as root: {commands:?}"
        );
        assert!(
            !commands.iter().any(|c| c.contains(" down ")),
            "no compose down without a compose file: {commands:?}"
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
        let tmp = tempfile::tempdir().unwrap();
        let compose_file = crate::runtime::compose_file_path_in(tmp.path(), "testproject").unwrap();
        let compose_path = std::path::PathBuf::from(&compose_file);
        if let Some(parent) = compose_path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(&compose_path, "services: {}").unwrap();

        let (recorded, runner) = make_recording_runner();
        let rt = LimaRuntime::with_runner(runner).with_data_dir(tmp.path().to_path_buf());
        rt.compose_down("testproject").unwrap();

        let commands = recorded.lock().unwrap();
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

    /// A Stopped VM returns `is_available() == false`, but `ensure_ready()` must succeed by
    /// starting it. Callers need `ensure_ready()`, not `is_available()`, for operational.
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
            err_msg.contains(consts::LIMA_START_PROVISION_HINT),
            "error should carry the download cause + retry hint, got: {err_msg}"
        );
    }

    /// Concurrent `ensure_ready()` calls must be serialized: the second thread
    /// waits for the first to finish starting the VM, then sees "Running".
    #[test]
    fn test_ensure_ready_concurrent_calls_serialized() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let start_count = Arc::new(AtomicUsize::new(0));

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

    #[test]
    fn every_compose_up_runs_nerdctl_under_the_up_deadline() {
        let bounded = format!(
            "sudo timeout --signal=KILL --verbose {} nerdctl compose",
            super::super::COMPOSE_UP_TIMEOUT_SECS
        );
        let (recorded, runner) = make_recording_runner();
        let rt = LimaRuntime::with_runner(runner);
        rt.compose_up("testproject").unwrap();
        rt.compose_up_recreate("testproject").unwrap();
        rt.compose_up_service("testproject", "proxy").unwrap();

        let commands = recorded.lock().unwrap();
        let ups: Vec<&String> = commands.iter().filter(|c| c.contains(" up -d")).collect();
        assert_eq!(ups.len(), 3, "one up per variant: {commands:?}");
        for up in ups {
            assert!(
                up.contains(&bounded),
                "up must run under the deadline: {up}"
            );
        }
    }

    #[test]
    fn compose_up_names_the_deadline_when_timeout_stops_nerdctl() {
        use std::sync::atomic::Ordering;
        let runner = FirstUpFailsRunner::with_error(
            "limactl failed: timeout: sending signal KILL to command \u{2018}nerdctl\u{2019}"
                .to_string(),
        );
        let up_calls = Arc::clone(&runner.up_calls);
        let rt = LimaRuntime::with_runner(Box::new(runner));
        let msg = rt
            .compose_up_recreate("acme")
            .expect_err("a stopped up must fail")
            .to_string();
        assert!(
            msg.contains(&format!(
                "did not finish within {}s",
                super::super::COMPOSE_UP_TIMEOUT_SECS
            )),
            "got: {msg}"
        );
        assert!(msg.contains("sending signal KILL"), "raw cause kept: {msg}");
        assert_eq!(
            up_calls.load(Ordering::SeqCst),
            1,
            "a deadline is not healed"
        );
    }

    #[test]
    fn compose_up_keeps_an_error_that_is_not_the_deadline_unchanged() {
        let raw = "limactl failed: level=fatal msg=\"no such image: speedwave-claude:abc\"";
        let runner = FirstUpFailsRunner::with_error(raw.to_string());
        let rt = LimaRuntime::with_runner(Box::new(runner));
        let msg = rt
            .compose_up("acme")
            .expect_err("a failed up must fail")
            .to_string();
        assert_eq!(msg, raw);
    }

    /// ADR-073: single-service recreate targets exactly the named service, keeps
    /// --force-recreate, and never removes orphans — the rest of the stack stays untouched.
    #[test]
    fn test_compose_up_service_targets_one_service() {
        let (recorded, runner) = make_recording_runner();
        let rt = LimaRuntime::with_runner(runner);
        rt.compose_up_service("testproject", "proxy").unwrap();

        let commands = recorded.lock().unwrap();
        assert_eq!(commands.len(), 1);
        assert!(
            commands[0].ends_with("--force-recreate proxy"),
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
        let tmp = tempfile::tempdir().unwrap();
        let compose_file = crate::runtime::compose_file_path_in(tmp.path(), "acme").unwrap();
        let runner = mock_runner_with_vm_running().with_response(
            &format!(
                "limactl shell {} -- sudo nerdctl compose -f {} -p acme logs --timestamps --tail 200",
                consts::lima_vm_name(),
                compose_file
            ),
            "hub | started\nclaude | ready",
        );
        let rt = LimaRuntime::with_runner(Box::new(runner)).with_data_dir(tmp.path().to_path_buf());
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

        #[cfg(unix)]
        std::os::unix::fs::symlink(&src, src.join("cycle")).unwrap();

        let dst = tmp.path().join("dst");
        copy_dir_recursive(&src, &dst).unwrap();

        assert!(dst.join("real").join("file.txt").exists());
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
        let (recorded, runner) = make_recording_runner();
        let rt = LimaRuntime::with_runner(runner);
        assert!(rt.remove_images(&[], false).is_ok());
        assert!(
            recorded.lock().unwrap().is_empty(),
            "empty tags must not run rmi, got: {:?}",
            recorded.lock().unwrap()
        );
    }

    #[test]
    fn test_remove_images_happy_path() {
        let tags = vec![
            "speedwave-claude:abc123".to_string(),
            "speedwave-mcp-hub:abc123".to_string(),
        ];
        let (recorded, runner) = make_recording_runner();
        let rt = LimaRuntime::with_runner(runner);
        assert!(rt.remove_images(&tags, false).is_ok());
        assert_eq!(
            *recorded.lock().unwrap(),
            vec![format!(
                "limactl shell {} -- sudo nerdctl rmi speedwave-claude:abc123 speedwave-mcp-hub:abc123",
                consts::lima_vm_name()
            )]
        );
    }

    #[test]
    fn test_remove_images_error_is_warn_only() {
        struct FailingRmiRunner {
            rmi_calls: Arc<Mutex<Vec<String>>>,
        }
        impl CommandRunner for FailingRmiRunner {
            fn run(&self, cmd: &str, args: &[&str]) -> anyhow::Result<String> {
                let key = format!("{} {}", cmd, args.join(" "));
                if key.contains("--version") {
                    return Ok("limactl version 2.1.2".to_string());
                }
                if key.contains("list --format") {
                    return Ok("Running".to_string());
                }
                self.rmi_calls.lock().unwrap().push(key);
                anyhow::bail!("no such image")
            }
        }
        let tags = vec!["speedwave-claude:abc123".to_string()];
        let rmi_calls = Arc::new(Mutex::new(Vec::new()));
        let rt = LimaRuntime::with_runner(Box::new(FailingRmiRunner {
            rmi_calls: rmi_calls.clone(),
        }));
        assert!(
            rt.remove_images(&tags, false).is_ok(),
            "rmi failure should not propagate"
        );
        assert_eq!(
            *rmi_calls.lock().unwrap(),
            vec![format!(
                "limactl shell {} -- sudo nerdctl rmi speedwave-claude:abc123",
                consts::lima_vm_name()
            )],
            "the rmi must run even though its failure is only a warning"
        );
    }

    #[test]
    fn test_remove_images_force_passes_force_flag() {
        let tags = vec!["speedwave-mcp-example:1.0.0".to_string()];
        let (recorded, runner) = make_recording_runner();
        let rt = LimaRuntime::with_runner(runner);
        assert!(rt.remove_images(&tags, true).is_ok());
        assert_eq!(
            *recorded.lock().unwrap(),
            vec![format!(
                "limactl shell {} -- sudo nerdctl rmi --force speedwave-mcp-example:1.0.0",
                consts::lima_vm_name()
            )]
        );
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

    fn image_inspect_key(tag: &str) -> String {
        format!(
            "limactl shell {} -- sudo nerdctl image inspect {tag}",
            consts::lima_vm_name()
        )
    }

    #[test]
    fn image_exists_is_true_for_a_tag_nerdctl_inspects() {
        let runner = mock_runner_with_vm_running()
            .with_response(&image_inspect_key("speedwave-claude:abc123"), "[{}]");
        let rt = LimaRuntime::with_runner(Box::new(runner));
        assert!(rt.image_exists("speedwave-claude:abc123").unwrap());
    }

    #[test]
    fn image_exists_is_false_when_nerdctl_answers_no_such_image() {
        let runner = mock_runner_with_vm_running().with_error(
            &image_inspect_key("speedwave-claude:abc123"),
            "limactl failed: time=\"2026-09-23T12:15:48+02:00\" level=fatal \
             msg=\"1 errors:\\nno such image: speedwave-claude:abc123\"",
        );
        let rt = LimaRuntime::with_runner(Box::new(runner));
        assert!(!rt.image_exists("speedwave-claude:abc123").unwrap());
    }

    #[test]
    fn image_exists_reads_no_such_image_in_any_case() {
        let runner = mock_runner_with_vm_running().with_error(
            &image_inspect_key("speedwave-claude:abc123"),
            "limactl failed: Error: No such image: speedwave-claude:abc123",
        );
        let rt = LimaRuntime::with_runner(Box::new(runner));
        assert!(!rt.image_exists("speedwave-claude:abc123").unwrap());
    }

    #[test]
    fn image_exists_surfaces_an_ssh_failure_instead_of_an_absent_image() {
        let runner = mock_runner_with_vm_running().with_error(
            &image_inspect_key("speedwave-claude:abc123"),
            "limactl failed: kex_exchange_identification: read: Connection reset by peer",
        );
        let rt = LimaRuntime::with_runner(Box::new(runner));
        let err = rt.image_exists("speedwave-claude:abc123").unwrap_err();
        assert!(
            err.to_string().contains("kex_exchange_identification"),
            "the engine error must reach the caller, got: {err}"
        );
    }

    #[test]
    fn image_exists_bounds_the_probe_by_the_exec_probe_timeout() {
        struct BoundedProbeRecorder {
            probe_timeouts: Arc<Mutex<Vec<std::time::Duration>>>,
        }
        impl CommandRunner for BoundedProbeRecorder {
            fn run(&self, cmd: &str, args: &[&str]) -> anyhow::Result<String> {
                let key = format!("{} {}", cmd, args.join(" "));
                if key.contains("--version") {
                    return Ok("limactl version 2.1.2".to_string());
                }
                anyhow::bail!("the image probe must go through run_bounded, got run: {key}")
            }
            fn run_bounded(
                &self,
                cmd: &str,
                args: &[&str],
                timeout: std::time::Duration,
            ) -> anyhow::Result<String> {
                let key = format!("{} {}", cmd, args.join(" "));
                if key.contains("list --format") {
                    return Ok("Running".to_string());
                }
                self.probe_timeouts.lock().unwrap().push(timeout);
                Ok("[{}]".to_string())
            }
        }
        let probe_timeouts = Arc::new(Mutex::new(Vec::new()));
        let rt = LimaRuntime::with_runner(Box::new(BoundedProbeRecorder {
            probe_timeouts: probe_timeouts.clone(),
        }));
        assert!(rt.image_exists("speedwave-claude:abc123").unwrap());
        assert_eq!(
            *probe_timeouts.lock().unwrap(),
            vec![consts::CONTAINER_EXEC_PROBE_TIMEOUT]
        );
    }

    #[test]
    fn image_exists_fails_when_the_vm_is_stopped() {
        let runner = MockRunner::new()
            .with_response("limactl --version", "limactl version 1.0.0")
            .with_response(&vm_status_key(), "Stopped");
        let rt = LimaRuntime::with_runner(Box::new(runner));
        let err = rt.image_exists("speedwave-claude:abc123").unwrap_err();
        assert!(
            err.to_string().contains("not running"),
            "a stopped VM cannot answer for its images, got: {err}"
        );
        assert!(
            !err.to_string().contains("ensure_ready"),
            "this text reaches the rebuild banner, so it must not name internal API, got: {err}"
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
    fn stop_vm_stops_a_vm_whose_status_cannot_be_read() {
        let (recorded, runner) =
            make_status_recording_runner(Err("resource temporarily unavailable"));
        let rt = LimaRuntime::with_runner(runner);
        rt.stop_vm().unwrap();
        assert!(
            recorded
                .lock()
                .unwrap()
                .contains(&format!("limactl stop --force {}", consts::lima_vm_name())),
            "a failed status read must not skip the teardown"
        );
    }

    #[test]
    fn stop_vm_leaves_a_vm_that_does_not_exist_alone() {
        let (recorded, runner) = make_status_recording_runner(Err(
            "time=\"2026-09-23T22:54:04+02:00\" level=fatal msg=\"unmatched instances\"",
        ));
        let rt = LimaRuntime::with_runner(runner);
        rt.stop_vm().unwrap();
        assert!(
            recorded.lock().unwrap().is_empty(),
            "a VM limactl does not know has nothing to stop"
        );
    }

    fn make_status_recording_runner(
        status: Result<&'static str, &'static str>,
    ) -> (Arc<Mutex<Vec<String>>>, Box<dyn CommandRunner>) {
        struct StatusRecorder {
            status: Result<&'static str, &'static str>,
            recorded: Arc<Mutex<Vec<String>>>,
        }
        impl CommandRunner for StatusRecorder {
            fn run(&self, cmd: &str, args: &[&str]) -> anyhow::Result<String> {
                let key = format!("{} {}", cmd, args.join(" "));
                if key.contains("--version") {
                    return Ok("limactl version 2.1.2".to_string());
                }
                if key.contains("{{.Status}}") {
                    return self
                        .status
                        .map(str::to_string)
                        .map_err(|e| anyhow::anyhow!("limactl failed: {e}"));
                }
                anyhow::bail!("unexpected: {key}")
            }
            fn run_with_timeout_until(
                &self,
                cmd: &str,
                args: &[&str],
                _timeout: std::time::Duration,
                _stop: &dyn Fn() -> bool,
            ) -> anyhow::Result<bool> {
                self.recorded
                    .lock()
                    .unwrap()
                    .push(format!("{} {}", cmd, args.join(" ")));
                anyhow::bail!("command 'limactl' timed out after 600s")
            }
            fn run_with_timeout(
                &self,
                cmd: &str,
                args: &[&str],
                _timeout: std::time::Duration,
            ) -> anyhow::Result<()> {
                self.recorded
                    .lock()
                    .unwrap()
                    .push(format!("{} {}", cmd, args.join(" ")));
                Ok(())
            }
        }
        let recorded = Arc::new(Mutex::new(Vec::new()));
        let runner = StatusRecorder {
            status,
            recorded: Arc::clone(&recorded),
        };
        (recorded, Box::new(runner))
    }

    #[test]
    fn a_vm_start_that_did_not_finish_is_stopped_on_exit() {
        let (recorded, runner) = make_status_recording_runner(Ok("Stopped"));
        let rt = LimaRuntime::with_runner(runner);
        let err = rt.ensure_ready().unwrap_err();
        assert!(err.to_string().contains("timed out"), "got: {err}");
        rt.stop_vm().unwrap();
        let vm = consts::lima_vm_name();
        assert_eq!(
            *recorded.lock().unwrap(),
            vec![format!("limactl start {vm}"), format!("limactl stop --force {vm}")],
            "a killed limactl start can leave its host agent booting the VM, whatever limactl list says"
        );
    }

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

    fn vm_status_key() -> String {
        format!(
            "limactl list --format {{{{.Status}}}} {}",
            consts::lima_vm_name()
        )
    }

    #[test]
    fn ensure_ready_reports_a_missing_vm_when_limactl_matches_no_instance() {
        let runner = MockRunner::new()
            .with_response("limactl --version", "limactl version 2.1.2")
            .with_error(
                &vm_status_key(),
                "limactl failed: time=\"2026-09-23T13:33:20+02:00\" level=fatal \
                 msg=\"unmatched instances\"",
            );
        let rt = LimaRuntime::with_runner(Box::new(runner));
        let err = rt.ensure_ready().unwrap_err();
        assert!(
            err.to_string().contains("not found"),
            "an instance limactl does not know is a missing VM, got: {err}"
        );
        assert!(err
            .downcast_ref::<crate::runtime::VmStatusUnreadable>()
            .is_none());
    }

    #[test]
    fn ensure_ready_reports_an_unreadable_status_instead_of_a_missing_vm() {
        let runner = MockRunner::new()
            .with_response("limactl --version", "limactl version 2.1.2")
            .with_error(
                &vm_status_key(),
                "limactl failed: open lima/speedwave/ha.pid: resource temporarily unavailable",
            );
        let rt = LimaRuntime::with_runner(Box::new(runner));
        let err = rt.ensure_ready().unwrap_err();
        assert!(
            err.downcast_ref::<crate::runtime::VmStatusUnreadable>()
                .is_some(),
            "a failed status read must stay distinguishable from a missing VM, got: {err}"
        );
        assert!(
            err.to_string().contains("resource temporarily unavailable"),
            "the limactl failure must reach the caller, got: {err}"
        );
        assert!(
            !err.to_string().contains("setup wizard"),
            "a VM whose status could not be read is not a VM to create, got: {err}"
        );
    }

    #[test]
    fn ensure_ready_gives_up_on_a_stopping_vm_whose_status_stops_being_readable() {
        struct StoppingThenUnreadableRunner {
            status_reads: std::sync::atomic::AtomicUsize,
        }
        impl CommandRunner for StoppingThenUnreadableRunner {
            fn run(&self, cmd: &str, args: &[&str]) -> anyhow::Result<String> {
                let key = format!("{} {}", cmd, args.join(" "));
                if key.contains("--version") {
                    return Ok("limactl version 2.1.2".to_string());
                }
                if key.contains("list --format") {
                    let read = self
                        .status_reads
                        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    if read == 0 {
                        return Ok("Stopping".to_string());
                    }
                    anyhow::bail!("limactl failed: resource temporarily unavailable");
                }
                Err(anyhow::anyhow!("unexpected: {key}"))
            }
        }
        let rt = LimaRuntime::with_runner(Box::new(StoppingThenUnreadableRunner {
            status_reads: std::sync::atomic::AtomicUsize::new(0),
        }))
        .with_zero_vm_stop_poll_delay()
        .with_stop_timeout(std::time::Duration::ZERO);
        let err = rt
            .ensure_ready()
            .expect_err("an unreadable status past the Stopping deadline must end the wait");
        assert!(
            err.downcast_ref::<crate::runtime::VmStatusUnreadable>()
                .is_some(),
            "the last status read failed, so the error must say the state is unreadable, got: {err}"
        );
    }

    #[test]
    fn ensure_ready_reports_a_vm_deleted_while_it_stops_as_missing() {
        struct StoppingThenDeletedRunner {
            status_reads: std::sync::atomic::AtomicUsize,
        }
        impl CommandRunner for StoppingThenDeletedRunner {
            fn run(&self, cmd: &str, args: &[&str]) -> anyhow::Result<String> {
                let key = format!("{} {}", cmd, args.join(" "));
                if key.contains("--version") {
                    return Ok("limactl version 2.1.2".to_string());
                }
                if key.contains("list --format") {
                    let read = self
                        .status_reads
                        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    if read == 0 {
                        return Ok("Stopping".to_string());
                    }
                    anyhow::bail!(
                        "limactl failed: time=\"2026-09-23T22:54:04+02:00\" level=fatal \
                         msg=\"unmatched instances\""
                    );
                }
                Err(anyhow::anyhow!("unexpected: {key}"))
            }
        }
        let runner = StoppingThenDeletedRunner {
            status_reads: std::sync::atomic::AtomicUsize::new(0),
        };
        let rt = LimaRuntime::with_runner(Box::new(runner))
            .with_zero_vm_stop_poll_delay()
            .with_stop_timeout(std::time::Duration::from_secs(5));
        let started = std::time::Instant::now();
        let err = rt.ensure_ready().unwrap_err();
        assert!(
            err.to_string().contains("not found"),
            "a VM limactl stopped knowing while it stopped is a missing VM, got: {err}"
        );
        assert!(err
            .downcast_ref::<crate::runtime::VmStatusUnreadable>()
            .is_none());
        assert!(
            started.elapsed() < std::time::Duration::from_secs(2),
            "a missing VM ends the wait at once, not at the Stopping deadline"
        );
    }

    #[test]
    fn ensure_ready_leaves_a_stopped_vm_stopped_once_the_engine_teardown_began() {
        let runner = MockRunner::new()
            .with_response("limactl --version", "limactl version 2.1.2")
            .with_response(&vm_status_key(), "Stopped");
        let rt = LimaRuntime::with_runner(Box::new(runner)).with_engine_teardown_check(|| true);
        let err = rt.ensure_ready().unwrap_err();
        assert!(
            err.downcast_ref::<crate::runtime::EngineTearingDown>()
                .is_some(),
            "a stopped VM must stay stopped once the engine teardown began, got: {err}"
        );
    }

    #[test]
    fn ensure_ready_does_not_start_a_vm_that_finished_stopping_once_the_engine_teardown_began() {
        let runner = SequencedRunner::new()
            .with_fallback("limactl --version", "limactl version 2.1.2")
            .with_sequence(&vm_status_key(), vec!["Stopping", "Stopped"]);
        let rt = LimaRuntime::with_runner(Box::new(runner))
            .with_zero_vm_stop_poll_delay()
            .with_engine_teardown_check(|| true);
        let err = rt.ensure_ready().unwrap_err();
        assert!(
            err.downcast_ref::<crate::runtime::EngineTearingDown>()
                .is_some(),
            "the wait for a stopping VM must not end in a start, got: {err}"
        );
    }

    #[test]
    fn ensure_ready_accepts_a_running_vm_during_the_engine_teardown() {
        let rt = LimaRuntime::with_runner(Box::new(mock_runner_with_vm_running()))
            .with_engine_teardown_check(|| true);
        assert!(rt.ensure_ready().is_ok());
    }

    #[test]
    fn a_vm_start_the_engine_teardown_cuts_short_is_force_stopped_on_exit() {
        static TEARDOWN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
        fn teardown_started() -> bool {
            TEARDOWN.load(std::sync::atomic::Ordering::SeqCst)
        }
        struct StartCutShortRunner {
            calls: Arc<Mutex<Vec<String>>>,
        }
        impl CommandRunner for StartCutShortRunner {
            fn run(&self, cmd: &str, args: &[&str]) -> anyhow::Result<String> {
                let key = format!("{} {}", cmd, args.join(" "));
                if key.contains("--version") {
                    return Ok("limactl version 2.1.2".to_string());
                }
                self.calls.lock().unwrap().push(key.clone());
                if key.contains("{{.Status}}") {
                    return Ok("Stopped".to_string());
                }
                anyhow::bail!("unexpected: {key}")
            }
            fn run_with_timeout_until(
                &self,
                cmd: &str,
                args: &[&str],
                _timeout: std::time::Duration,
                stop: &dyn Fn() -> bool,
            ) -> anyhow::Result<bool> {
                self.calls
                    .lock()
                    .unwrap()
                    .push(format!("{} {}", cmd, args.join(" ")));
                TEARDOWN.store(true, std::sync::atomic::Ordering::SeqCst);
                Ok(!stop())
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
                    .push(format!("{} {}", cmd, args.join(" ")));
                Ok(())
            }
        }
        let calls = Arc::new(Mutex::new(Vec::new()));
        let rt = LimaRuntime::with_runner(Box::new(StartCutShortRunner {
            calls: calls.clone(),
        }))
        .with_engine_teardown_check(teardown_started);
        let err = rt.ensure_ready().unwrap_err();
        assert!(
            err.downcast_ref::<crate::runtime::EngineTearingDown>()
                .is_some(),
            "a start the teardown cut short must not read as a started VM, got: {err}"
        );
        rt.stop_vm().unwrap();
        rt.stop_vm().unwrap();
        let vm = consts::lima_vm_name();
        assert_eq!(
            *calls.lock().unwrap(),
            vec![
                format!("limactl list --format {{{{.Status}}}} {vm}"),
                format!("limactl start {vm}"),
                format!("limactl stop --force {vm}"),
                format!("limactl list --format {{{{.Status}}}} {vm}"),
            ],
            "the VM a cut-short start left booting must be stopped whatever limactl list says, \
             and only once"
        );
    }

    #[test]
    fn stop_vm_waits_for_a_vm_start_in_flight_to_end() {
        static TEARDOWN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
        fn teardown_started() -> bool {
            TEARDOWN.load(std::sync::atomic::Ordering::SeqCst)
        }
        struct BlockingStartRunner {
            events: Arc<Mutex<Vec<&'static str>>>,
            started: Mutex<Option<std::sync::mpsc::Sender<()>>>,
        }
        struct EndTheStartOnDrop;
        impl Drop for EndTheStartOnDrop {
            fn drop(&mut self) {
                TEARDOWN.store(true, std::sync::atomic::Ordering::SeqCst);
            }
        }
        impl CommandRunner for BlockingStartRunner {
            fn run(&self, cmd: &str, args: &[&str]) -> anyhow::Result<String> {
                let key = format!("{} {}", cmd, args.join(" "));
                if key.contains("--version") {
                    return Ok("limactl version 2.1.2".to_string());
                }
                if key.contains("{{.Status}}") {
                    return Ok("Stopped".to_string());
                }
                anyhow::bail!("unexpected: {key}")
            }
            fn run_with_timeout_until(
                &self,
                _cmd: &str,
                _args: &[&str],
                _timeout: std::time::Duration,
                stop: &dyn Fn() -> bool,
            ) -> anyhow::Result<bool> {
                self.events.lock().unwrap().push("start began");
                if let Some(started) = self.started.lock().unwrap().take() {
                    started.send(()).unwrap();
                }
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
                while !stop() && std::time::Instant::now() < deadline {
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                self.events.lock().unwrap().push("start cut short");
                Ok(false)
            }
            fn run_with_timeout(
                &self,
                _cmd: &str,
                _args: &[&str],
                _timeout: std::time::Duration,
            ) -> anyhow::Result<()> {
                self.events.lock().unwrap().push("force stop");
                Ok(())
            }
        }
        let events = Arc::new(Mutex::new(Vec::new()));
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let rt = Arc::new(
            LimaRuntime::with_runner(Box::new(BlockingStartRunner {
                events: events.clone(),
                started: Mutex::new(Some(started_tx)),
            }))
            .with_zero_vm_stop_poll_delay()
            .with_engine_teardown_check(teardown_started),
        );
        let end_the_start = EndTheStartOnDrop;
        let starter = {
            let rt = Arc::clone(&rt);
            std::thread::spawn(move || rt.ensure_ready())
        };
        started_rx
            .recv_timeout(std::time::Duration::from_secs(10))
            .unwrap();
        let stopper = {
            let rt = Arc::clone(&rt);
            std::thread::spawn(move || rt.stop_vm())
        };
        std::thread::sleep(std::time::Duration::from_millis(100));
        assert_eq!(
            *events.lock().unwrap(),
            vec!["start began"],
            "stop_vm must wait for the start in flight instead of reading a status it cannot trust"
        );
        drop(end_the_start);
        let started = starter.join().unwrap();
        stopper.join().unwrap().unwrap();
        assert!(started.is_err());
        assert_eq!(
            *events.lock().unwrap(),
            vec!["start began", "start cut short", "force stop"]
        );
    }

    #[test]
    fn every_limactl_list_read_is_bounded_by_the_list_timeout() {
        struct ListRecorder {
            bounded: Arc<Mutex<Vec<(String, std::time::Duration)>>>,
        }
        impl CommandRunner for ListRecorder {
            fn run(&self, cmd: &str, args: &[&str]) -> anyhow::Result<String> {
                let key = format!("{} {}", cmd, args.join(" "));
                if key.contains("--version") {
                    return Ok("limactl version 2.1.2".to_string());
                }
                anyhow::bail!("an unbounded read ran: {key}")
            }
            fn run_bounded(
                &self,
                cmd: &str,
                args: &[&str],
                timeout: std::time::Duration,
            ) -> anyhow::Result<String> {
                let key = format!("{} {}", cmd, args.join(" "));
                self.bounded.lock().unwrap().push((key.clone(), timeout));
                if key.contains("{{.Name}}") {
                    return Ok(consts::lima_vm_name().to_string());
                }
                Ok("Running".to_string())
            }
            fn run_with_timeout(
                &self,
                _cmd: &str,
                _args: &[&str],
                _timeout: std::time::Duration,
            ) -> anyhow::Result<()> {
                Ok(())
            }
        }
        let bounded = Arc::new(Mutex::new(Vec::new()));
        let rt = LimaRuntime::with_runner(Box::new(ListRecorder {
            bounded: bounded.clone(),
        }));
        assert!(rt.is_available());
        assert!(rt.is_installed());
        rt.ensure_ready().unwrap();
        rt.stop_vm().unwrap();
        let reads = bounded.lock().unwrap().clone();
        assert_eq!(
            reads.len(),
            4,
            "one bounded read per entry point, got: {reads:?}"
        );
        for (key, timeout) in reads {
            assert!(key.starts_with("limactl list --format"), "got: {key}");
            assert_eq!(timeout, consts::VM_LIST_TIMEOUT, "for: {key}");
        }
    }

    #[test]
    fn the_production_runtime_reads_the_process_wide_engine_teardown() {
        let source = include_str!("lima.rs");
        let new_fn = source
            .split("    pub fn new() -> Self {")
            .nth(1)
            .expect("LimaRuntime::new must exist");
        let body = &new_fn[..new_fn.find("\n    }\n").expect("new() must end")];
        assert!(
            body.contains("start_gate: &VM_START_GATE,"),
            "every production runtime must share the one start gate, or exit cannot see a start in flight"
        );
        assert!(
            body.contains("engine_teardown_started: super::engine_teardown_started,"),
            "LimaRuntime::new must read the flag app exit and factory reset set"
        );
    }

    #[test]
    fn ensure_ready_names_a_vm_state_it_cannot_act_on() {
        let runner = MockRunner::new()
            .with_response("limactl --version", "limactl version 2.1.2")
            .with_response(&vm_status_key(), "Broken");
        let rt = LimaRuntime::with_runner(Box::new(runner));
        let err = rt.ensure_ready().unwrap_err().to_string();
        assert!(
            err.contains("Broken"),
            "the state limactl reported must reach the caller, got: {err}"
        );
        assert!(
            !err.contains("setup wizard"),
            "an existing VM in another state is not a VM to create, got: {err}"
        );
    }

    #[test]
    fn test_ensure_ready_stopping_deadline_exceeded_returns_err() {
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
