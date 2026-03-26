use super::{CommandRunner, ContainerRuntime, RealRunner};
use crate::consts;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Command;

pub struct LimaRuntime {
    runner: Box<dyn CommandRunner>,
    restart_ready_delay: std::time::Duration,
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
        }
    }

    pub fn with_runner(runner: Box<dyn CommandRunner>) -> Self {
        Self {
            runner,
            restart_ready_delay: std::time::Duration::from_secs(
                consts::CONTAINERD_RESTART_READY_DELAY_SECS,
            ),
        }
    }

    /// Sets restart ready delay to zero for tests to avoid sleeping.
    #[cfg(test)]
    fn with_zero_restart_delay(mut self) -> Self {
        self.restart_ready_delay = std::time::Duration::ZERO;
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
        super::compose_down_and_cleanup(
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
                command.args([
                    "shell",
                    vm,
                    "--",
                    "sudo",
                    "nerdctl",
                    "exec",
                    "-it",
                    "-e",
                    "TERM=xterm-256color",
                    "-e",
                    "COLORTERM=truecolor",
                    "-e",
                    &path_env,
                    container,
                ]);
                command.args(cmd);
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
            "sudo",
            "nerdctl",
            "exec",
            "-it",
            "-e",
            "TERM=xterm-256color",
            "-e",
            "COLORTERM=truecolor",
            "-e",
            &path_env,
            container,
        ]);
        command.args(cmd);
        command
    }

    fn container_exec_piped(&self, container: &str, cmd: &[&str]) -> anyhow::Result<Command> {
        self.require_running()?;
        // For piped I/O (chat.rs, auth checks): use limactl shell without PTY.
        // No -it on nerdctl exec, just -i for stdin forwarding.
        let path_env = format!("PATH={}", consts::CONTAINER_PATH);
        let mut command = crate::binary::command("limactl");
        command.args([
            "shell",
            consts::lima_vm_name(),
            "--",
            "sudo",
            "nerdctl",
            "exec",
            "-i",
            "-e",
            "TERM=xterm-256color",
            "-e",
            &path_env,
            container,
        ]);
        command.args(cmd);
        Ok(command)
    }

    fn is_available(&self) -> bool {
        let limactl_ok = self.runner.run("limactl", &["--version"]).is_ok();
        if !limactl_ok {
            return false;
        }
        // Check if VM is running
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
            "Stopped" => {
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

        let args: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect();

        // Verify PATH env is set for the speedwave user
        let path_env = format!("PATH={}", consts::CONTAINER_PATH);
        assert!(
            args.contains(&path_env.to_string()),
            "container_exec should set PATH env, got args: {:?}",
            args
        );

        // Verify the container name is passed
        assert!(
            args.contains(&"test_container".to_string()),
            "container_exec should include container name, got args: {:?}",
            args
        );

        // Verify the user command is appended
        assert!(
            args.contains(&"claude".to_string()),
            "container_exec should include user command, got args: {:?}",
            args
        );
        assert!(
            args.contains(&"-p".to_string()),
            "container_exec should include user command args, got args: {:?}",
            args
        );

        // Verify interactive TTY flags are present
        assert!(
            args.contains(&"-it".to_string()),
            "container_exec should use -it for interactive TTY, got args: {:?}",
            args
        );
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

        let args: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect();

        // Verify PATH env is set for the speedwave user
        let path_env = format!("PATH={}", consts::CONTAINER_PATH);
        assert!(
            args.contains(&path_env.to_string()),
            "container_exec_piped should set PATH env, got args: {:?}",
            args
        );

        // Verify the container name is passed
        assert!(
            args.contains(&"test_container".to_string()),
            "container_exec_piped should include container name, got args: {:?}",
            args
        );

        // Verify piped mode uses -i (not -it) for stdin forwarding without TTY
        assert!(
            args.contains(&"-i".to_string()),
            "container_exec_piped should use -i for stdin forwarding, got args: {:?}",
            args
        );
        assert!(
            !args.contains(&"-it".to_string()),
            "container_exec_piped should NOT use -it (no TTY for piped mode), got args: {:?}",
            args
        );

        // Verify the user command is appended
        assert!(
            args.contains(&"claude".to_string()),
            "container_exec_piped should include user command, got args: {:?}",
            args
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
                "limactl shell {} -- sudo nerdctl compose -f {} -p acme logs --tail 200",
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
}
