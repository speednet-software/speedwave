use super::{CommandRunner, ContainerRuntime, RealRunner};
use crate::consts;
use serde_json::Value;
use std::process::Command;

pub struct NerdctlRuntime {
    runner: Box<dyn CommandRunner>,
    restart_ready_delay: std::time::Duration,
}

impl Default for NerdctlRuntime {
    fn default() -> Self {
        Self::new()
    }
}

impl NerdctlRuntime {
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

    fn parse_version(version_output: &str) -> Option<(u32, u32, u32)> {
        super::parse_version(version_output)
    }
}

impl ContainerRuntime for NerdctlRuntime {
    fn compose_up(&self, project: &str) -> anyhow::Result<()> {
        let compose_file = super::compose_file_path(project)?;
        self.runner.run(
            "nerdctl",
            &[
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
        let compose_file = super::compose_file_path(project)?;
        super::compose_down_and_cleanup(
            &*self.runner,
            "nerdctl",
            project,
            &[
                "compose",
                "-f",
                &compose_file,
                "-p",
                project,
                "down",
                "--remove-orphans",
            ],
            &[],
        )
    }

    fn compose_ps(&self, project: &str) -> anyhow::Result<Vec<Value>> {
        let compose_file = super::compose_file_path(project)?;
        let output = self.runner.run(
            "nerdctl",
            &[
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
        let path_env = format!("PATH={}", consts::CONTAINER_PATH);
        let nerdctl = crate::binary::resolve_binary("nerdctl");
        // Raw Command::new — intentionally bypasses binary::command() because
        // interactive TTY sessions need a console window on Windows.
        let mut command = Command::new(&nerdctl);
        command.args([
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
        let path_env = format!("PATH={}", consts::CONTAINER_PATH);
        let mut command = crate::binary::command("nerdctl");
        command.args(["exec", "-i", "-e", &path_env, container]);
        command.args(cmd);
        Ok(command)
    }

    fn is_available(&self) -> bool {
        self.runner
            .run("nerdctl", &["--version"])
            .map(|output| Self::parse_version(&output).is_some())
            .unwrap_or(false)
    }

    fn build_image(
        &self,
        tag: &str,
        context_dir: &str,
        containerfile: &str,
        build_args: &[(&str, &str)],
    ) -> anyhow::Result<()> {
        let ba_strings: Vec<String> = build_args
            .iter()
            .map(|(k, v)| format!("{}={}", k, v))
            .collect();
        let mut args: Vec<&str> = vec!["build", "-t", tag, "-f", containerfile];
        for s in &ba_strings {
            args.push("--build-arg");
            args.push(s);
        }
        args.push(context_dir);
        self.runner.run("nerdctl", &args)?;
        Ok(())
    }

    fn container_logs(&self, container: &str, tail: u32) -> anyhow::Result<String> {
        let tail_str = tail.to_string();
        self.runner
            .run_with_stderr("nerdctl", &["logs", "--tail", &tail_str, container])
    }

    fn compose_logs(&self, project: &str, tail: u32) -> anyhow::Result<String> {
        let compose_file = super::compose_file_path(project)?;
        let tail_str = tail.to_string();
        self.runner.run_with_stderr(
            "nerdctl",
            &[
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
        let compose_file = super::compose_file_path(project)?;
        self.runner.run(
            "nerdctl",
            &[
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
        let result = self.runner.run("nerdctl", &["image", "inspect", tag]);
        Ok(result.is_ok())
    }

    fn system_prune(&self) -> anyhow::Result<()> {
        self.runner
            .run("nerdctl", &["system", "prune", "--force"])?;
        Ok(())
    }

    fn restart_container_engine(&self) -> anyhow::Result<()> {
        log::info!("restarting containerd (rootless)");
        self.runner
            .run("systemctl", &["--user", "restart", "containerd"])?;

        log::info!("restarting buildkit (rootless)");
        self.runner
            .run("systemctl", &["--user", "restart", "buildkit"])?;

        // Phase 1: wait for systemd units to reach "active" state.
        // In rootless mode, containerd runs inside rootlesskit which needs time
        // to set up network namespaces (slirp4netns). `systemctl is-active` is
        // the fastest reliable signal that the unit's ExecStart succeeded.
        let max = consts::CONTAINERD_RESTART_READY_MAX_RETRIES;
        for attempt in 1..=max {
            std::thread::sleep(self.restart_ready_delay);

            let containerd_active = self
                .runner
                .run("systemctl", &["--user", "is-active", "containerd"])
                .is_ok();
            let buildkit_active = self
                .runner
                .run("systemctl", &["--user", "is-active", "buildkit"])
                .is_ok();

            if containerd_active && buildkit_active {
                log::info!("systemd units active after {attempt} attempt(s)");
                break;
            }
            if attempt == max {
                anyhow::bail!(
                    "containerd/buildkit not ready after restart ({max} attempts). \
                     Try: systemctl --user restart containerd && systemctl --user restart buildkit"
                );
            }
            log::info!("waiting for containerd/buildkit readiness (attempt {attempt}/{max})");
        }

        // Phase 2: verify end-to-end connectivity through rootlesskit namespace.
        // rootlesskit needs a moment after systemd reports "active" before the
        // nerdctl socket is reachable from the host side.
        for attempt in 1..=max {
            std::thread::sleep(self.restart_ready_delay);

            let nerdctl_ok = self.runner.run("nerdctl", &["info"]).is_ok();
            let buildctl_ok = self.runner.run("buildctl", &["debug", "workers"]).is_ok();

            if nerdctl_ok && buildctl_ok {
                log::info!("containerd + buildkit fully ready after phase 2 attempt {attempt}");
                return Ok(());
            }
            if attempt == max {
                anyhow::bail!(
                    "containerd/buildkit systemd units active but nerdctl/buildctl not reachable \
                     after restart ({max} phase-2 attempts). \
                     Try: systemctl --user restart containerd && systemctl --user restart buildkit"
                );
            }
            log::info!(
                "waiting for rootlesskit namespace readiness (phase 2 attempt {attempt}/{max})"
            );
        }

        unreachable!("loop always returns or bails")
    }

    fn ensure_ready(&self) -> anyhow::Result<()> {
        // (1) OS prerequisite check (SSOT: os_prereqs module)
        let violations = crate::os_prereqs::check_os_prereqs();
        if let Some(v) = violations.first() {
            anyhow::bail!("{v}");
        }

        // (2) Check nerdctl version >= 2.0.0
        let version_output = self
            .runner
            .run("nerdctl", &["--version"])
            .map_err(|_| {
                anyhow::anyhow!(
                    "nerdctl not found. Install nerdctl-full from \
                     https://github.com/containerd/nerdctl/releases or run Speedwave.app setup wizard."
                )
            })?;

        if let Some((major, minor, patch)) = Self::parse_version(&version_output) {
            if major < 2 {
                anyhow::bail!(
                    "nerdctl version >= 2.0.0 required (found {}.{}.{}). \
                     Speedwave requires nerdctl 2.x for rootless containerd support.",
                    major,
                    minor,
                    patch
                );
            }
        }

        // (3) Check containerd is running
        let info_output = self.runner.run("nerdctl", &["info"]).map_err(|_| {
            anyhow::anyhow!(
                "containerd is not running. Start it with: \
                     systemctl --user start containerd"
            )
        })?;

        // (4) Verify rootless mode — Speedwave requires rootless nerdctl on Linux.
        // In rootless mode, containers run inside a user namespace where UID 0
        // maps to the host user's UID. If rootful nerdctl is detected, UID 0
        // in containers would be real root on the host — a security risk.
        if !info_output.contains("rootless") {
            anyhow::bail!(
                "Speedwave requires rootless nerdctl on Linux. \
                 Detected rootful containerd — containers would run as real root. \
                 Set up rootless containerd: containerd-rootless-setuptool.sh install"
            );
        }

        Ok(())
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use crate::runtime::test_support::MockRunner;

    #[test]
    fn test_parse_version() {
        assert_eq!(
            NerdctlRuntime::parse_version("nerdctl version 2.0.3"),
            Some((2, 0, 3))
        );
        assert_eq!(
            NerdctlRuntime::parse_version("nerdctl version 2.1.0"),
            Some((2, 1, 0))
        );
        assert_eq!(NerdctlRuntime::parse_version("2.0.0"), Some((2, 0, 0)));
        assert_eq!(NerdctlRuntime::parse_version("garbage"), None);
    }

    #[test]
    fn test_is_available_ok() {
        let runner = MockRunner::new().with_response("nerdctl --version", "nerdctl version 2.0.3");
        let rt = NerdctlRuntime::with_runner(Box::new(runner));
        assert!(rt.is_available());
    }

    #[test]
    fn test_is_available_not_installed() {
        let runner = MockRunner::new().with_error("nerdctl --version", "not found");
        let rt = NerdctlRuntime::with_runner(Box::new(runner));
        assert!(!rt.is_available());
    }

    /// On Linux, os_prereqs::check_os_prereqs() catches missing uidmap.
    /// On macOS (dev/CI), prereqs return empty so ensure_ready() proceeds
    /// to the nerdctl version check — which fails via mock.
    #[test]
    fn test_ensure_ready_uidmap_missing() {
        let runner =
            MockRunner::new().with_error("sh -c command -v newuidmap >/dev/null 2>&1", "not found");
        let rt = NerdctlRuntime::with_runner(Box::new(runner));
        let result = rt.ensure_ready();
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        // On Linux: os_prereqs catches uidmap → "newuidmap not found"
        // On macOS: os_prereqs returns empty, mock has no nerdctl → "nerdctl not found"
        if cfg!(target_os = "linux") {
            assert!(
                err.contains("newuidmap"),
                "error should mention newuidmap on Linux, got: {err}"
            );
        } else {
            assert!(
                err.contains("nerdctl"),
                "error should mention nerdctl on non-Linux, got: {err}"
            );
        }
    }

    #[test]
    fn test_ensure_ready_version_too_old() {
        let runner = MockRunner::new()
            .with_response(
                "sh -c command -v newuidmap >/dev/null 2>&1",
                "usage: newuidmap ...",
            )
            .with_response("nerdctl --version", "nerdctl version 1.7.6");
        let rt = NerdctlRuntime::with_runner(Box::new(runner));
        let result = rt.ensure_ready();
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(
            err.contains("2.0.0"),
            "error should mention required version 2.0.0, got: {}",
            err
        );
    }

    #[test]
    fn test_ensure_ready_all_good() {
        let runner = MockRunner::new()
            .with_response(
                "sh -c command -v newuidmap >/dev/null 2>&1",
                "usage: newuidmap ...",
            )
            .with_response("nerdctl --version", "nerdctl version 2.0.3")
            .with_response(
                "nerdctl info",
                "containerd: running\nSecurity Options: rootless",
            );
        let rt = NerdctlRuntime::with_runner(Box::new(runner));
        assert!(rt.ensure_ready().is_ok());
    }

    #[test]
    fn test_ensure_ready_containerd_not_running() {
        let runner = MockRunner::new()
            .with_response(
                "sh -c command -v newuidmap >/dev/null 2>&1",
                "usage: newuidmap ...",
            )
            .with_response("nerdctl --version", "nerdctl version 2.0.3")
            .with_error("nerdctl info", "connection refused");
        let rt = NerdctlRuntime::with_runner(Box::new(runner));
        let result = rt.ensure_ready();
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(
            err.contains("containerd"),
            "error should mention containerd, got: {}",
            err
        );
    }

    #[test]
    fn test_ensure_ready_rootful_rejected() {
        let runner = MockRunner::new()
            .with_response(
                "sh -c command -v newuidmap >/dev/null 2>&1",
                "usage: newuidmap ...",
            )
            .with_response("nerdctl --version", "nerdctl version 2.0.3")
            .with_response("nerdctl info", "Server Version: 2.0.3\nDriver: overlayfs");
        let rt = NerdctlRuntime::with_runner(Box::new(runner));
        let result = rt.ensure_ready();
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(
            err.contains("rootless"),
            "error should mention rootless, got: {}",
            err
        );
    }

    #[test]
    fn test_ensure_ready_rootless_accepted() {
        let runner = MockRunner::new()
            .with_response(
                "sh -c command -v newuidmap >/dev/null 2>&1",
                "usage: newuidmap ...",
            )
            .with_response("nerdctl --version", "nerdctl version 2.0.3")
            .with_response(
                "nerdctl info",
                "Server Version: 2.0.3\nSecurity Options: rootless\nDriver: overlayfs",
            );
        let rt = NerdctlRuntime::with_runner(Box::new(runner));
        assert!(rt.ensure_ready().is_ok());
    }

    #[test]
    fn test_container_exec_path_env() {
        let rt = NerdctlRuntime::new();
        let cmd = rt.container_exec("test_container", &["claude", "-p"]);

        let args: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect();

        let path_env = format!("PATH={}", consts::CONTAINER_PATH);
        assert!(
            args.contains(&path_env),
            "container_exec should set PATH env, got args: {:?}",
            args
        );

        assert!(
            args.contains(&"test_container".to_string()),
            "container_exec should include container name, got args: {:?}",
            args
        );

        assert!(
            args.contains(&"claude".to_string()),
            "container_exec should include user command, got args: {:?}",
            args
        );

        assert!(
            args.contains(&"-it".to_string()),
            "container_exec should use -it for interactive TTY, got args: {:?}",
            args
        );

        assert!(
            !args.contains(&"-i".to_string()),
            "container_exec should NOT use bare -i (use -it instead), got args: {:?}",
            args
        );
    }

    #[test]
    fn test_container_exec_piped_path_env() {
        let rt = NerdctlRuntime::new();
        let cmd = rt
            .container_exec_piped("test_container", &["claude", "-p"])
            .unwrap();

        let args: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect();

        let path_env = format!("PATH={}", consts::CONTAINER_PATH);
        assert!(
            args.contains(&path_env),
            "container_exec_piped should set PATH env, got args: {:?}",
            args
        );

        assert!(
            args.contains(&"test_container".to_string()),
            "container_exec_piped should include container name, got args: {:?}",
            args
        );

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
    }

    #[test]
    fn test_container_exec_uses_resolved_binary() {
        let _guard = crate::binary::tests::ENV_LOCK.lock().unwrap();
        std::env::remove_var("SPEEDWAVE_RESOURCES_DIR");

        let rt = NerdctlRuntime::new();
        let cmd = rt.container_exec("test_container", &["sh"]);

        let program = cmd.get_program().to_string_lossy().to_string();
        // Without SPEEDWAVE_RESOURCES_DIR set, resolve_binary("nerdctl") returns "nerdctl"
        assert_eq!(
            program, "nerdctl",
            "container_exec program should be resolved nerdctl binary, got: {}",
            program
        );
    }

    #[test]
    fn test_container_exec_piped_uses_resolved_binary() {
        let _guard = crate::binary::tests::ENV_LOCK.lock().unwrap();
        std::env::remove_var("SPEEDWAVE_RESOURCES_DIR");

        let rt = NerdctlRuntime::new();
        let cmd = rt.container_exec_piped("test_container", &["sh"]).unwrap();

        let program = cmd.get_program().to_string_lossy().to_string();
        assert_eq!(
            program, "nerdctl",
            "container_exec_piped program should be resolved nerdctl binary, got: {}",
            program
        );
    }

    #[test]
    fn test_container_exec_uses_bundled_binary() {
        let _guard = crate::binary::tests::ENV_LOCK.lock().unwrap();
        let tmp = tempfile::tempdir().expect("tempdir");
        let bin_dir = tmp
            .path()
            .join(crate::consts::NERDCTL_FULL_SUBDIR)
            .join("bin");
        std::fs::create_dir_all(&bin_dir).expect("mkdir");
        let nerdctl_path = bin_dir.join("nerdctl");
        std::fs::write(&nerdctl_path, "fake").expect("write");

        std::env::set_var(
            "SPEEDWAVE_RESOURCES_DIR",
            tmp.path().to_string_lossy().as_ref(),
        );

        let rt = NerdctlRuntime::new();
        let cmd = rt.container_exec("mycontainer", &["sh"]);
        let program = cmd.get_program().to_string_lossy().to_string();

        std::env::remove_var("SPEEDWAVE_RESOURCES_DIR");

        assert_eq!(
            program,
            nerdctl_path.to_string_lossy().to_string(),
            "container_exec should use the bundled nerdctl binary"
        );
    }

    #[test]
    fn test_container_exec_piped_uses_bundled_binary() {
        let _guard = crate::binary::tests::ENV_LOCK.lock().unwrap();
        let tmp = tempfile::tempdir().expect("tempdir");
        let bin_dir = tmp
            .path()
            .join(crate::consts::NERDCTL_FULL_SUBDIR)
            .join("bin");
        std::fs::create_dir_all(&bin_dir).expect("mkdir");
        let nerdctl_path = bin_dir.join("nerdctl");
        std::fs::write(&nerdctl_path, "fake").expect("write");

        std::env::set_var(
            "SPEEDWAVE_RESOURCES_DIR",
            tmp.path().to_string_lossy().as_ref(),
        );

        let rt = NerdctlRuntime::new();
        let cmd = rt.container_exec_piped("mycontainer", &["sh"]).unwrap();
        let program = cmd.get_program().to_string_lossy().to_string();

        std::env::remove_var("SPEEDWAVE_RESOURCES_DIR");

        assert_eq!(
            program,
            nerdctl_path.to_string_lossy().to_string(),
            "container_exec_piped should use the bundled nerdctl binary"
        );
    }

    #[test]
    fn test_compose_down() {
        let compose_file = crate::runtime::compose_file_path("runtime-cleanup-test").unwrap();
        let expected_key = format!(
            "nerdctl compose -f {} -p runtime-cleanup-test down --remove-orphans",
            compose_file
        );
        let runner = MockRunner::new()
            .with_response(&expected_key, "")
            .with_response(
                "nerdctl ps -a --filter label=com.docker.compose.project=runtime-cleanup-test -q",
                "stale-id",
            )
            .with_response("nerdctl rm -f stale-id", "");
        let rt = NerdctlRuntime::with_runner(Box::new(runner));
        assert!(rt.compose_down("runtime-cleanup-test").is_ok());
    }

    #[test]
    fn test_compose_up() {
        let compose_file = crate::runtime::compose_file_path("myproject").unwrap();
        let expected_key = format!(
            "nerdctl compose -f {} -p myproject up -d --remove-orphans",
            compose_file
        );
        let runner = MockRunner::new().with_response(&expected_key, "");
        let rt = NerdctlRuntime::with_runner(Box::new(runner));
        assert!(rt.compose_up("myproject").is_ok());
    }

    #[test]
    fn test_compose_up_recreate() {
        let compose_file = crate::runtime::compose_file_path("myproject").unwrap();
        let expected_key = format!(
            "nerdctl compose -f {} -p myproject up -d --force-recreate --remove-orphans",
            compose_file
        );
        let runner = MockRunner::new().with_response(&expected_key, "");
        let rt = NerdctlRuntime::with_runner(Box::new(runner));
        assert!(rt.compose_up_recreate("myproject").is_ok());
    }

    #[test]
    fn test_container_logs() {
        let runner = MockRunner::new().with_response(
            "nerdctl logs --tail 100 speedwave_acme_claude",
            "line1\nline2\nline3",
        );
        let rt = NerdctlRuntime::with_runner(Box::new(runner));
        let logs = rt.container_logs("speedwave_acme_claude", 100).unwrap();
        assert_eq!(logs, "line1\nline2\nline3");
    }

    #[test]
    fn test_compose_logs() {
        let compose_file = crate::runtime::compose_file_path("acme").unwrap();
        let runner = MockRunner::new().with_response(
            &format!(
                "nerdctl compose -f {} -p acme logs --tail 200",
                compose_file
            ),
            "hub | started\nclaude | ready",
        );
        let rt = NerdctlRuntime::with_runner(Box::new(runner));
        let logs = rt.compose_logs("acme", 200).unwrap();
        assert_eq!(logs, "hub | started\nclaude | ready");
    }

    #[test]
    fn test_system_prune() {
        let runner = MockRunner::new().with_response("nerdctl system prune --force", "");
        let rt = NerdctlRuntime::with_runner(Box::new(runner));
        assert!(rt.system_prune().is_ok());
    }

    #[test]
    fn test_system_prune_propagates_error() {
        let runner = MockRunner::new().with_error("nerdctl system prune --force", "prune failed");
        let rt = NerdctlRuntime::with_runner(Box::new(runner));
        let result = rt.system_prune();
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("prune failed"));
    }

    #[test]
    fn test_build_image_passes_build_args() {
        let version = crate::defaults::CLAUDE_VERSION;
        let expected_key = format!(
            "nerdctl build -t my-image:latest -f /ctx/Containerfile --build-arg CLAUDE_VERSION={} /ctx",
            version
        );
        let runner = MockRunner::new().with_response(&expected_key, "");
        let rt = NerdctlRuntime::with_runner(Box::new(runner));
        assert!(
            rt.build_image(
                "my-image:latest",
                "/ctx",
                "/ctx/Containerfile",
                &[("CLAUDE_VERSION", version)],
            )
            .is_ok(),
            "build_image with build_args should succeed"
        );
    }

    #[test]
    fn test_prepare_build_context_returns_path_unchanged() {
        let runner = MockRunner::new();
        let rt = NerdctlRuntime::with_runner(Box::new(runner));
        let path = std::path::PathBuf::from("/some/arbitrary/path");
        let result = rt.prepare_build_context(&path).unwrap();
        assert_eq!(result, path);
    }

    #[test]
    fn test_restart_container_engine_ok() {
        let runner = MockRunner::new()
            .with_response("systemctl --user restart containerd", "")
            .with_response("systemctl --user restart buildkit", "")
            .with_response("systemctl --user is-active containerd", "active")
            .with_response("systemctl --user is-active buildkit", "active")
            .with_response(
                "nerdctl info",
                "containerd: running\nSecurity Options: rootless",
            )
            .with_response("buildctl debug workers", "buildkit ready");
        let rt = NerdctlRuntime::with_runner(Box::new(runner)).with_zero_restart_delay();
        assert!(rt.restart_container_engine().is_ok());
    }

    #[test]
    fn test_restart_container_engine_propagates_containerd_error() {
        let runner = MockRunner::new().with_error(
            "systemctl --user restart containerd",
            "Failed to restart containerd.service",
        );
        let rt = NerdctlRuntime::with_runner(Box::new(runner)).with_zero_restart_delay();
        let result = rt.restart_container_engine();
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("Failed to restart"));
    }

    #[test]
    fn test_restart_container_engine_units_not_active_after_retries() {
        let runner = MockRunner::new()
            .with_response("systemctl --user restart containerd", "")
            .with_response("systemctl --user restart buildkit", "")
            .with_error("systemctl --user is-active containerd", "inactive")
            .with_error("systemctl --user is-active buildkit", "inactive");
        let rt = NerdctlRuntime::with_runner(Box::new(runner)).with_zero_restart_delay();
        let result = rt.restart_container_engine();
        assert!(result.is_err());
        assert!(
            result.unwrap_err().to_string().contains("not ready"),
            "should report not ready after retries"
        );
    }

    #[test]
    fn test_restart_container_engine_units_active_but_nerdctl_unreachable() {
        let runner = MockRunner::new()
            .with_response("systemctl --user restart containerd", "")
            .with_response("systemctl --user restart buildkit", "")
            .with_response("systemctl --user is-active containerd", "active")
            .with_response("systemctl --user is-active buildkit", "active")
            .with_error("nerdctl info", "connection refused")
            .with_error("buildctl debug workers", "connection refused");
        let rt = NerdctlRuntime::with_runner(Box::new(runner)).with_zero_restart_delay();
        let result = rt.restart_container_engine();
        assert!(result.is_err());
        assert!(
            result.unwrap_err().to_string().contains("not reachable"),
            "should report nerdctl/buildctl not reachable in phase 2"
        );
    }
}
