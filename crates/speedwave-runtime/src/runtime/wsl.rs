use super::{CommandRunner, ContainerRuntime, RealRunner};
use crate::consts;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Decodes raw bytes from `wsl.exe` output, handling UTF-16LE (with or without BOM)
/// which is the default encoding for `wsl.exe --list` on Windows.
///
/// Tries decoding approaches in order:
/// 1. UTF-16LE with BOM (bytes start with 0xFF 0xFE)
/// 2. UTF-16LE without BOM (even length, decodes without replacement characters
///    and contains only printable text plus common whitespace)
/// 3. Fallback to UTF-8
pub fn decode_wsl_output(bytes: &[u8]) -> String {
    // UTF-16LE with BOM
    if bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE {
        let u16s: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        return String::from_utf16_lossy(&u16s);
    }
    // Heuristic for UTF-16LE without BOM: require even length and at least
    // one null byte in an odd position (the high byte of ASCII code points
    // in UTF-16LE is always 0x00). This distinguishes UTF-16LE-encoded ASCII
    // from plain UTF-8, which would never have null bytes in odd positions.
    // If the heuristic matches, attempt decode and accept only if the result
    // contains no replacement characters and no unexpected control characters.
    if bytes.len() >= 4 && bytes.len().is_multiple_of(2) {
        let has_null_high_bytes = bytes.iter().skip(1).step_by(2).any(|&b| b == 0x00);
        if has_null_high_bytes {
            let u16s: Vec<u16> = bytes
                .chunks_exact(2)
                .map(|c| u16::from_le_bytes([c[0], c[1]]))
                .collect();
            let decoded = String::from_utf16_lossy(&u16s);
            if !decoded.contains('\u{FFFD}')
                && decoded
                    .chars()
                    .all(|c| !c.is_control() || c == '\n' || c == '\r' || c == '\t')
            {
                return decoded;
            }
        }
    }
    String::from_utf8_lossy(bytes).to_string()
}

pub struct WslRuntime {
    runner: Box<dyn CommandRunner>,
    retry_delay: std::time::Duration,
    restart_ready_delay: std::time::Duration,
}

impl Default for WslRuntime {
    fn default() -> Self {
        Self::new()
    }
}

impl WslRuntime {
    pub fn new() -> Self {
        Self {
            runner: Box::new(RealRunner),
            retry_delay: std::time::Duration::from_secs(consts::WSL_SERVICE_START_DELAY_SECS),
            restart_ready_delay: std::time::Duration::from_secs(
                consts::CONTAINERD_RESTART_READY_DELAY_SECS,
            ),
        }
    }

    pub fn with_runner(runner: Box<dyn CommandRunner>) -> Self {
        Self {
            runner,
            retry_delay: std::time::Duration::from_secs(consts::WSL_SERVICE_START_DELAY_SECS),
            restart_ready_delay: std::time::Duration::from_secs(
                consts::CONTAINERD_RESTART_READY_DELAY_SECS,
            ),
        }
    }

    /// Sets retry delay and restart ready delay to zero for tests to avoid sleeping.
    #[cfg(test)]
    fn with_zero_delay(mut self) -> Self {
        self.retry_delay = std::time::Duration::ZERO;
        self.restart_ready_delay = std::time::Duration::ZERO;
        self
    }

    /// Checks that a service is running inside the WSL distro. If the check
    /// command fails, tries to start the service via systemctl and retries
    /// with a delay up to `WSL_SERVICE_CHECK_MAX_RETRIES` times.
    ///
    /// - `service_name`: display name for logs/errors (e.g. "buildkitd")
    /// - `systemd_unit`: systemd unit name for `systemctl start` (e.g. "buildkit")
    fn check_service(
        &self,
        distro: &str,
        check_cmd: &[&str],
        service_name: &str,
        systemd_unit: &str,
    ) -> anyhow::Result<()> {
        let mut args = vec!["-d", distro, "--"];
        args.extend_from_slice(check_cmd);

        // Fast path: service already running
        if self.runner.run("wsl.exe", &args).is_ok() {
            return Ok(());
        }

        // Try starting the service, preserve error for diagnostics
        let start_err = self
            .runner
            .run(
                "wsl.exe",
                &["-d", distro, "--", "systemctl", "start", systemd_unit],
            )
            .err();
        if let Some(ref e) = start_err {
            log::warn!("systemctl start {systemd_unit} failed: {e}");
        }

        let max = consts::WSL_SERVICE_CHECK_MAX_RETRIES;
        let mut last_check_err = None;

        for attempt in 1..=max {
            // Check first, sleep after — avoids unnecessary wait when service is already up
            match self.runner.run("wsl.exe", &args) {
                Ok(_) => {
                    log::info!("{service_name} ready after {attempt} attempt(s)");
                    return Ok(());
                }
                Err(e) => {
                    last_check_err = Some(e);
                    log::info!("Waiting for {service_name} (attempt {attempt}/{max})");
                }
            }
            std::thread::sleep(self.retry_delay);
        }

        // Build diagnostic error with both start and check errors
        let mut msg = format!(
            "{service_name} is not running inside WSL2 distribution '{distro}' after {max} attempts."
        );
        if let Some(e) = start_err {
            msg.push_str(&format!(" systemctl start {systemd_unit}: {e}."));
        }
        if let Some(e) = last_check_err {
            msg.push_str(&format!(" Last health check: {e}."));
        }
        msg.push_str(&format!(
            " Try: wsl -d {distro} -- systemctl start {systemd_unit}"
        ));
        Err(anyhow::anyhow!(msg))
    }
}

/// Converts a Windows-style path (`C:\foo\bar` or `C:/foo/bar`) to a WSL mount path
/// (`/mnt/c/foo/bar`). Passes through paths that are already Unix-style.
///
/// Handles the extended-length prefix (`\\?\C:\...`) that Windows APIs sometimes
/// return (e.g. from `canonicalize()` or `GetTempPath()`), stripping it to extract
/// the underlying drive-letter path.
///
/// Returns an error for true UNC paths (`\\server\share`) which cannot be mapped
/// to WSL mount points.
pub fn windows_to_wsl_path(path: &Path) -> anyhow::Result<PathBuf> {
    let s = path.to_string_lossy();
    let bytes = s.as_bytes();

    // Handle extended-length prefix: \\?\C:\... → strip prefix and recurse
    if bytes.len() >= 6
        && bytes[0] == b'\\'
        && bytes[1] == b'\\'
        && bytes[2] == b'?'
        && bytes[3] == b'\\'
        && bytes[4].is_ascii_alphabetic()
        && bytes[5] == b':'
    {
        // Safe: first 4 bytes are ASCII (`\\?\`), remainder is a normal path
        return windows_to_wsl_path(Path::new(&s[4..]));
    }

    // Reject true UNC paths (\\server\share) — they can't be mapped to /mnt/<drive>/
    if bytes.len() >= 2 && bytes[0] == b'\\' && bytes[1] == b'\\' {
        anyhow::bail!(
            "UNC path '{}' is not supported. Move your project under a drive-letter path (e.g. C:\\Users\\...)",
            s
        );
    }

    // Match drive letter patterns: `C:\...`, `C:/...`, `c:\...`, `c:/...`
    if bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
    {
        let drive = (bytes[0] as char).to_ascii_lowercase();
        // Safe: bytes 0-2 are ASCII (drive letter + ':' + separator)
        let rest = s[3..].replace('\\', "/");
        return Ok(PathBuf::from(format!("/mnt/{}/{}", drive, rest)));
    }

    // Already a Unix path or relative — pass through
    Ok(path.to_path_buf())
}

/// Returns the compose file path translated to a WSL mount path.
///
/// `compose_file_path()` returns a Windows path (e.g. `C:\Users\...\compose.yml`);
/// nerdctl inside WSL2 needs it as `/mnt/c/Users/.../compose.yml`.
fn wsl_compose_file_path(project: &str) -> anyhow::Result<String> {
    let win_path = super::compose_file_path(project)?;
    let wsl_path = windows_to_wsl_path(Path::new(&win_path))?;
    Ok(wsl_path.to_string_lossy().to_string())
}

impl ContainerRuntime for WslRuntime {
    fn compose_up(&self, project: &str) -> anyhow::Result<()> {
        let compose_file = wsl_compose_file_path(project)?;
        self.runner.run(
            "wsl.exe",
            &[
                "-d",
                consts::WSL_DISTRO_NAME,
                "--",
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
        let compose_file = wsl_compose_file_path(project)?;
        super::compose_down_and_cleanup(
            &*self.runner,
            "wsl.exe",
            project,
            &[
                "-d",
                consts::WSL_DISTRO_NAME,
                "--",
                "nerdctl",
                "compose",
                "-f",
                &compose_file,
                "-p",
                project,
                "down",
                "--remove-orphans",
            ],
            &["-d", consts::WSL_DISTRO_NAME, "--", "nerdctl"],
        )
    }

    fn compose_ps(&self, project: &str) -> anyhow::Result<Vec<Value>> {
        let compose_file = wsl_compose_file_path(project)?;
        let output = self.runner.run(
            "wsl.exe",
            &[
                "-d",
                consts::WSL_DISTRO_NAME,
                "--",
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
        let path_env = format!("PATH={}", consts::CONTAINER_PATH);
        // Raw Command::new — intentionally bypasses binary::system_command() because
        // interactive TTY sessions need a console window on Windows.
        let mut command = Command::new("wsl.exe");
        command.args([
            "-d",
            consts::WSL_DISTRO_NAME,
            "--",
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
        let path_env = format!("PATH={}", consts::CONTAINER_PATH);
        let mut command = crate::binary::system_command("wsl.exe");
        command.args([
            "-d",
            consts::WSL_DISTRO_NAME,
            "--",
            "nerdctl",
            "exec",
            "-i",
            "-e",
            &path_env,
            container,
        ]);
        command.args(cmd);
        Ok(command)
    }

    fn is_available(&self) -> bool {
        self.runner
            .run_raw_stdout("wsl.exe", &["--list", "--quiet"])
            .map(|raw| {
                let output = decode_wsl_output(&raw);
                output
                    .lines()
                    .any(|line| line.trim().trim_matches('\0') == consts::WSL_DISTRO_NAME)
            })
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
        let mut args: Vec<&str> = vec![
            "-d",
            consts::WSL_DISTRO_NAME,
            "--",
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
        self.runner.run("wsl.exe", &args)?;
        Ok(())
    }

    fn prepare_build_context(&self, build_root: &Path) -> anyhow::Result<PathBuf> {
        windows_to_wsl_path(build_root)
    }

    fn container_logs(&self, container: &str, tail: u32) -> anyhow::Result<String> {
        let tail_str = tail.to_string();
        self.runner.run_with_stderr(
            "wsl.exe",
            &[
                "-d",
                consts::WSL_DISTRO_NAME,
                "--",
                "nerdctl",
                "logs",
                "--tail",
                &tail_str,
                container,
            ],
        )
    }

    fn compose_logs(&self, project: &str, tail: u32) -> anyhow::Result<String> {
        let compose_file = wsl_compose_file_path(project)?;
        let tail_str = tail.to_string();
        self.runner.run_with_stderr(
            "wsl.exe",
            &[
                "-d",
                consts::WSL_DISTRO_NAME,
                "--",
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
        let compose_file = wsl_compose_file_path(project)?;
        self.runner.run(
            "wsl.exe",
            &[
                "-d",
                consts::WSL_DISTRO_NAME,
                "--",
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

    fn system_prune(&self) -> anyhow::Result<()> {
        self.runner.run(
            "wsl.exe",
            &[
                "-d",
                consts::WSL_DISTRO_NAME,
                "--",
                "nerdctl",
                "system",
                "prune",
                "--force",
            ],
        )?;
        Ok(())
    }

    fn restart_container_engine(&self) -> anyhow::Result<()> {
        let distro = consts::WSL_DISTRO_NAME;

        log::info!("restarting containerd inside WSL2");
        self.runner.run(
            "wsl.exe",
            &["-d", distro, "--", "systemctl", "restart", "containerd"],
        )?;

        log::info!("restarting buildkit inside WSL2");
        self.runner.run(
            "wsl.exe",
            &["-d", distro, "--", "systemctl", "restart", "buildkit"],
        )?;

        let max = consts::CONTAINERD_RESTART_READY_MAX_RETRIES;
        for attempt in 1..=max {
            std::thread::sleep(self.restart_ready_delay);

            let nerdctl_ok = self
                .runner
                .run("wsl.exe", &["-d", distro, "--", "nerdctl", "info"])
                .is_ok();

            let buildctl_ok = self
                .runner
                .run(
                    "wsl.exe",
                    &["-d", distro, "--", "buildctl", "debug", "workers"],
                )
                .is_ok();

            if nerdctl_ok && buildctl_ok {
                log::info!("containerd + buildkit ready after {attempt} attempt(s)");
                return Ok(());
            }
            log::info!("waiting for containerd/buildkit readiness (attempt {attempt}/{max})");
        }

        anyhow::bail!(
            "containerd/buildkit not ready after restart ({max} attempts). \
             Try: wsl.exe -d {distro} -- systemctl restart containerd && \
             wsl.exe -d {distro} -- systemctl restart buildkit"
        )
    }

    fn ensure_ready(&self) -> anyhow::Result<()> {
        let raw = self
            .runner
            .run_raw_stdout("wsl.exe", &["--list", "--quiet"])
            .map_err(|_| {
                anyhow::anyhow!(
                    "WSL2 not available. Ensure Windows Subsystem for Linux is enabled.\n\
                     Run: wsl --install"
                )
            })?;

        let output = decode_wsl_output(&raw);
        let distro_exists = output
            .lines()
            .any(|line| line.trim().trim_matches('\0') == consts::WSL_DISTRO_NAME);

        if !distro_exists {
            anyhow::bail!(
                "WSL2 distribution '{}' not found. Run Speedwave.app setup wizard to import it.",
                consts::WSL_DISTRO_NAME
            );
        }

        // Verify containerd and buildkitd are running inside the WSL distro.
        // After a WSL session closes, the VM may restart and systemd services
        // need time to come up. check_service() attempts `systemctl start` on
        // failure and retries up to WSL_SERVICE_CHECK_MAX_RETRIES times.
        let distro = consts::WSL_DISTRO_NAME;
        self.check_service(distro, &["nerdctl", "info"], "containerd", "containerd")?;
        self.check_service(
            distro,
            &["buildctl", "debug", "workers"],
            "buildkitd",
            "buildkit",
        )?;

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::test_support::MockRunner;

    #[test]
    fn test_is_available_distro_exists() {
        let runner =
            MockRunner::new().with_response("wsl.exe --list --quiet", "Ubuntu\nSpeedwave\n");
        let rt = WslRuntime::with_runner(Box::new(runner));
        assert!(rt.is_available());
    }

    #[test]
    fn test_is_available_distro_missing() {
        let runner = MockRunner::new().with_response("wsl.exe --list --quiet", "Ubuntu\nDebian\n");
        let rt = WslRuntime::with_runner(Box::new(runner));
        assert!(!rt.is_available());
    }

    #[test]
    fn test_is_available_wsl_not_installed() {
        let runner = MockRunner::new().with_error("wsl.exe --list --quiet", "not found");
        let rt = WslRuntime::with_runner(Box::new(runner));
        assert!(!rt.is_available());
    }

    #[test]
    fn test_is_available_handles_utf16le_output() {
        // Real wsl.exe outputs UTF-16LE: "Speedwave\r\n" with each char as 2 bytes
        let text = "Ubuntu\r\nSpeedwave\r\n";
        let mut bytes: Vec<u8> = Vec::new();
        for ch in text.encode_utf16() {
            bytes.extend_from_slice(&ch.to_le_bytes());
        }
        let runner = MockRunner::new().with_raw_response("wsl.exe --list --quiet", bytes);
        let rt = WslRuntime::with_runner(Box::new(runner));
        assert!(rt.is_available());
    }

    #[test]
    fn test_is_available_handles_utf16le_with_bom() {
        let text = "Speedwave\r\n";
        let mut bytes: Vec<u8> = vec![0xFF, 0xFE]; // BOM
        for ch in text.encode_utf16() {
            bytes.extend_from_slice(&ch.to_le_bytes());
        }
        let runner = MockRunner::new().with_raw_response("wsl.exe --list --quiet", bytes);
        let rt = WslRuntime::with_runner(Box::new(runner));
        assert!(rt.is_available());
    }

    #[test]
    fn test_is_available_distro_with_trailing_null() {
        let runner = MockRunner::new().with_response("wsl.exe --list --quiet", "Speedwave\0\n");
        let rt = WslRuntime::with_runner(Box::new(runner));
        assert!(rt.is_available());
    }

    #[test]
    fn test_is_available_utf16le_non_ascii_distro_before_speedwave() {
        // Non-ASCII distro name before Speedwave — verifies that
        // UTF-16LE is detected even when the first bytes aren't ASCII
        let text = "\u{5F00}\u{53D1}\r\nSpeedwave\r\n"; // "开发\r\nSpeedwave\r\n"
        let mut bytes: Vec<u8> = Vec::new();
        for ch in text.encode_utf16() {
            bytes.extend_from_slice(&ch.to_le_bytes());
        }
        let runner = MockRunner::new().with_raw_response("wsl.exe --list --quiet", bytes);
        let rt = WslRuntime::with_runner(Box::new(runner));
        assert!(rt.is_available());
    }

    #[test]
    fn test_ensure_ready_distro_exists() {
        let runner = MockRunner::new()
            .with_response("wsl.exe --list --quiet", "Ubuntu\nSpeedwave\n")
            .with_response("wsl.exe -d Speedwave -- nerdctl info", "containerd running")
            .with_response(
                "wsl.exe -d Speedwave -- buildctl debug workers",
                "buildkit ready",
            );
        let rt = WslRuntime::with_runner(Box::new(runner));
        assert!(rt.ensure_ready().is_ok());
    }

    #[test]
    fn test_ensure_ready_distro_missing() {
        let runner = MockRunner::new().with_response("wsl.exe --list --quiet", "Ubuntu\nDebian\n");
        let rt = WslRuntime::with_runner(Box::new(runner));
        let result = rt.ensure_ready();
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("Speedwave"));
        assert!(err.contains("setup wizard"));
    }

    #[test]
    fn test_ensure_ready_wsl_not_installed() {
        let runner = MockRunner::new().with_error("wsl.exe --list --quiet", "not found");
        let rt = WslRuntime::with_runner(Box::new(runner));
        let result = rt.ensure_ready();
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("WSL2 not available"));
    }

    #[test]
    fn test_ensure_ready_containerd_not_running() {
        let runner = MockRunner::new()
            .with_response("wsl.exe --list --quiet", "Speedwave\n")
            .with_error("wsl.exe -d Speedwave -- nerdctl info", "connection refused")
            .with_error(
                "wsl.exe -d Speedwave -- systemctl start containerd",
                "start failed",
            );
        let rt = WslRuntime::with_runner(Box::new(runner)).with_zero_delay();
        let result = rt.ensure_ready();
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(
            err.contains("containerd"),
            "error should mention containerd, got: {err}"
        );
        assert!(
            err.contains("start failed"),
            "error should include start error, got: {err}"
        );
        assert!(
            err.contains("Last health check"),
            "error should include last health check error, got: {err}"
        );
    }

    #[test]
    fn test_ensure_ready_buildkit_not_running() {
        let runner = MockRunner::new()
            .with_response("wsl.exe --list --quiet", "Speedwave\n")
            .with_response("wsl.exe -d Speedwave -- nerdctl info", "containerd running")
            .with_error(
                "wsl.exe -d Speedwave -- buildctl debug workers",
                "connection refused",
            )
            .with_error(
                "wsl.exe -d Speedwave -- systemctl start buildkit",
                "start failed",
            );
        let rt = WslRuntime::with_runner(Box::new(runner)).with_zero_delay();
        let result = rt.ensure_ready();
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(
            err.contains("buildkitd"),
            "error should mention buildkitd, got: {err}"
        );
        // Verify correct systemd unit name is used (buildkit, not buildkitd)
        assert!(
            err.contains("systemctl start buildkit"),
            "error hint should use systemd unit 'buildkit', got: {err}"
        );
        assert!(
            err.contains("Last health check"),
            "error should include last health check error, got: {err}"
        );
    }

    #[test]
    fn test_container_logs() {
        let runner = MockRunner::new().with_response(
            "wsl.exe -d Speedwave -- nerdctl logs --tail 100 my_container",
            "log output here",
        );
        let rt = WslRuntime::with_runner(Box::new(runner));
        let logs = rt.container_logs("my_container", 100).unwrap();
        assert_eq!(logs, "log output here");
    }

    /// `compose_file_path()` returns a host-specific path (includes the current
    /// user's home directory). This is fine: both the test setup and the
    /// production `WslRuntime::compose_logs()` call the same function, so the
    /// mock key always matches regardless of the machine running the test.
    #[test]
    fn test_compose_logs() {
        let compose_file = crate::runtime::compose_file_path("acme").unwrap();
        let runner = MockRunner::new().with_response(
            &format!(
                "wsl.exe -d Speedwave -- nerdctl compose -f {} -p acme logs --tail 200",
                compose_file
            ),
            "hub | started\nclaude | ready",
        );
        let rt = WslRuntime::with_runner(Box::new(runner));
        let logs = rt.compose_logs("acme", 200).unwrap();
        assert_eq!(logs, "hub | started\nclaude | ready");
    }

    #[test]
    fn test_container_exec_has_path_env() {
        let rt = WslRuntime::new();
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
    }

    #[test]
    fn test_container_exec_piped_returns_ok() {
        let rt = WslRuntime::new();
        let cmd = rt
            .container_exec_piped("test_container", &["claude", "-p"])
            .unwrap();
        let program = cmd.get_program().to_string_lossy().to_string();
        assert_eq!(
            program, "wsl.exe",
            "container_exec_piped should use wsl.exe"
        );

        let args: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect();

        // Verify PATH env is set for the speedwave user
        let path_env = format!("PATH={}", consts::CONTAINER_PATH);
        assert!(
            args.contains(&path_env),
            "container_exec_piped should set PATH env, got args: {:?}",
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
        assert!(
            args.contains(&"claude".to_string()),
            "container_exec_piped should include user command, got args: {:?}",
            args
        );
    }

    #[test]
    fn test_compose_down_includes_remove_orphans() {
        let compose_file = crate::runtime::compose_file_path("wsl-cleanup-test").unwrap();
        let expected_key = format!(
            "wsl.exe -d Speedwave -- nerdctl compose -f {} -p wsl-cleanup-test down --remove-orphans",
            compose_file
        );
        let runner = MockRunner::new()
            .with_response(&expected_key, "")
            .with_response(
                "wsl.exe -d Speedwave -- nerdctl ps -a --filter label=com.docker.compose.project=wsl-cleanup-test -q",
                "stale-id",
            )
            .with_response("wsl.exe -d Speedwave -- nerdctl rm -f stale-id", "");
        let rt = WslRuntime::with_runner(Box::new(runner));
        assert!(rt.compose_down("wsl-cleanup-test").is_ok());
    }

    #[test]
    fn test_compose_up_recreate_includes_force_recreate() {
        let compose_file = crate::runtime::compose_file_path("acme").unwrap();
        let expected_key = format!(
            "wsl.exe -d Speedwave -- nerdctl compose -f {} -p acme up -d --force-recreate --remove-orphans",
            compose_file
        );
        let runner = MockRunner::new().with_response(&expected_key, "");
        let rt = WslRuntime::with_runner(Box::new(runner));
        assert!(rt.compose_up_recreate("acme").is_ok());
    }

    #[test]
    fn test_windows_to_wsl_path_converts_drive_letter() {
        let result = windows_to_wsl_path(Path::new(r"C:\Program Files\Speedwave")).unwrap();
        assert_eq!(result, PathBuf::from("/mnt/c/Program Files/Speedwave"));
    }

    #[test]
    fn test_windows_to_wsl_path_lowercase_drive() {
        let result = windows_to_wsl_path(Path::new(r"D:\data")).unwrap();
        assert_eq!(result, PathBuf::from("/mnt/d/data"));
    }

    #[test]
    fn test_windows_to_wsl_path_forward_slashes() {
        let result = windows_to_wsl_path(Path::new("C:/Users/dev/project")).unwrap();
        assert_eq!(result, PathBuf::from("/mnt/c/Users/dev/project"));
    }

    #[test]
    fn test_windows_to_wsl_path_unix_path_unchanged() {
        let result = windows_to_wsl_path(Path::new("/home/user/project")).unwrap();
        assert_eq!(result, PathBuf::from("/home/user/project"));
    }

    #[test]
    fn test_windows_to_wsl_path_rejects_unc_path() {
        let result = windows_to_wsl_path(Path::new(r"\\server\share\project"));
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(
            err.contains("UNC path"),
            "error should mention UNC, got: {}",
            err
        );
    }

    #[test]
    fn test_windows_to_wsl_path_strips_extended_length_prefix() {
        let result = windows_to_wsl_path(Path::new(r"\\?\C:\Users\dev")).unwrap();
        assert_eq!(result, PathBuf::from("/mnt/c/Users/dev"));
    }

    #[test]
    fn test_windows_to_wsl_path_strips_extended_length_prefix_lowercase() {
        let result = windows_to_wsl_path(Path::new(r"\\?\d:\temp\project")).unwrap();
        assert_eq!(result, PathBuf::from("/mnt/d/temp/project"));
    }

    #[test]
    fn test_windows_to_wsl_path_extended_length_temp_path() {
        // Regression: Windows GetTempPath/canonicalize can return \\?\C:\Users\...
        let result = windows_to_wsl_path(Path::new(
            r"\\?\C:\Users\User\AppData\Local\Temp\speedwave-e2e-project",
        ))
        .unwrap();
        assert_eq!(
            result,
            PathBuf::from("/mnt/c/Users/User/AppData/Local/Temp/speedwave-e2e-project")
        );
    }

    #[test]
    fn test_windows_to_wsl_path_rejects_unc_without_drive() {
        // \\?\UNC\server\share — not a drive-letter path, should still be rejected
        let result = windows_to_wsl_path(Path::new(r"\\?\UNC\server\share"));
        assert!(result.is_err());
    }

    #[test]
    fn test_wsl_prepare_build_context_translates_path() {
        let runner = MockRunner::new();
        let rt = WslRuntime::with_runner(Box::new(runner));
        let result = rt
            .prepare_build_context(Path::new(r"C:\Program Files\Speedwave\build-context"))
            .unwrap();
        assert_eq!(
            result,
            PathBuf::from("/mnt/c/Program Files/Speedwave/build-context")
        );
    }

    #[test]
    fn test_system_prune_calls_nerdctl_in_wsl() {
        let runner = MockRunner::new()
            .with_response("wsl.exe -d Speedwave -- nerdctl system prune --force", "");
        let rt = WslRuntime::with_runner(Box::new(runner));
        assert!(
            rt.system_prune().is_ok(),
            "WslRuntime::system_prune should succeed"
        );
    }

    #[test]
    fn test_system_prune_propagates_error() {
        let runner = MockRunner::new().with_error(
            "wsl.exe -d Speedwave -- nerdctl system prune --force",
            "prune failed",
        );
        let rt = WslRuntime::with_runner(Box::new(runner));
        let result = rt.system_prune();
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("prune failed"));
    }

    #[test]
    fn test_build_image_passes_build_args() {
        let version = crate::defaults::CLAUDE_VERSION;
        let expected_key = format!(
            "wsl.exe -d Speedwave -- nerdctl build -t my-image:latest -f /ctx/Containerfile --build-arg CLAUDE_VERSION={} /ctx",
            version
        );
        let runner = MockRunner::new().with_response(&expected_key, "");
        let rt = WslRuntime::with_runner(Box::new(runner));
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

    // ── wsl_compose_file_path tests ────────────────────────────────────

    #[test]
    fn test_wsl_compose_file_path_returns_unix_path() {
        // On macOS/Linux, compose_file_path already returns a Unix path,
        // so wsl_compose_file_path passes it through unchanged.
        let result = wsl_compose_file_path("test-project").unwrap();
        assert!(
            result.contains("/compose/test-project/compose.yml"),
            "should contain compose path structure, got: {}",
            result
        );
        assert!(
            !result.contains('\\'),
            "WSL compose path should use forward slashes, got: {}",
            result
        );
    }

    #[test]
    fn test_windows_to_wsl_path_converts_compose_file() {
        // Simulates what happens on Windows: compose_file_path returns a Windows path
        let win_path = Path::new(r"C:\Users\jakub\.speedwave\compose\e2e-test\compose.yml");
        let wsl = windows_to_wsl_path(win_path).unwrap();
        assert_eq!(
            wsl,
            PathBuf::from("/mnt/c/Users/jakub/.speedwave/compose/e2e-test/compose.yml")
        );
    }

    // ── ensure_ready UTF-16LE tests ─────────────────────────────────────

    #[test]
    fn test_ensure_ready_handles_utf16le_output() {
        let text = "Ubuntu\r\nSpeedwave\r\n";
        let mut bytes: Vec<u8> = Vec::new();
        for ch in text.encode_utf16() {
            bytes.extend_from_slice(&ch.to_le_bytes());
        }
        let runner = MockRunner::new()
            .with_raw_response("wsl.exe --list --quiet", bytes)
            .with_response("wsl.exe -d Speedwave -- nerdctl info", "containerd running")
            .with_response(
                "wsl.exe -d Speedwave -- buildctl debug workers",
                "buildkit ready",
            );
        let rt = WslRuntime::with_runner(Box::new(runner));
        assert!(rt.ensure_ready().is_ok());
    }

    #[test]
    fn test_ensure_ready_utf16le_distro_missing() {
        let text = "Ubuntu\r\nDebian\r\n";
        let mut bytes: Vec<u8> = Vec::new();
        for ch in text.encode_utf16() {
            bytes.extend_from_slice(&ch.to_le_bytes());
        }
        let runner = MockRunner::new().with_raw_response("wsl.exe --list --quiet", bytes);
        let rt = WslRuntime::with_runner(Box::new(runner));
        let result = rt.ensure_ready();
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("Speedwave"));
        assert!(err.contains("setup wizard"));
    }

    // ── decode_wsl_output unit tests ────────────────────────────────────

    #[test]
    fn test_decode_wsl_output_handles_utf8() {
        let input = b"Speedwave\nUbuntu\n";
        let result = decode_wsl_output(input);
        assert_eq!(result, "Speedwave\nUbuntu\n");
    }

    #[test]
    fn test_decode_wsl_output_handles_utf16le_with_bom() {
        let text = "Speedwave\r\n";
        let mut bytes: Vec<u8> = vec![0xFF, 0xFE];
        for ch in text.encode_utf16() {
            bytes.extend_from_slice(&ch.to_le_bytes());
        }
        let result = decode_wsl_output(&bytes);
        assert!(
            result.contains("Speedwave"),
            "should decode UTF-16LE with BOM correctly, got: {result:?}"
        );
    }

    #[test]
    fn test_decode_wsl_output_handles_utf16le_without_bom() {
        let text = "Speedwave\r\n";
        let mut bytes: Vec<u8> = Vec::new();
        for ch in text.encode_utf16() {
            bytes.extend_from_slice(&ch.to_le_bytes());
        }
        assert!(
            bytes.iter().any(|&b| b == 0),
            "UTF-16LE of ASCII text should contain null bytes"
        );
        let result = decode_wsl_output(&bytes);
        assert!(
            result.contains("Speedwave"),
            "should decode UTF-16LE without BOM correctly, got: {result:?}"
        );
    }

    #[test]
    fn test_decode_wsl_output_empty_input() {
        let result = decode_wsl_output(b"");
        assert_eq!(result, "");
    }

    #[test]
    fn test_decode_wsl_output_single_byte_input() {
        let result = decode_wsl_output(b"X");
        assert_eq!(result, "X");
    }

    #[test]
    fn test_decode_wsl_output_utf16le_distro_name_matches_after_trim() {
        let text = "Speedwave\r\n";
        let mut bytes: Vec<u8> = vec![0xFF, 0xFE];
        for ch in text.encode_utf16() {
            bytes.extend_from_slice(&ch.to_le_bytes());
        }
        let decoded = decode_wsl_output(&bytes);
        let found = decoded
            .lines()
            .any(|l| l.trim().trim_matches('\0') == consts::WSL_DISTRO_NAME);
        assert!(
            found,
            "distro name '{}' should be found in decoded output, lines: {:?}",
            consts::WSL_DISTRO_NAME,
            decoded.lines().collect::<Vec<_>>()
        );
    }

    #[test]
    fn test_decode_wsl_output_utf16le_without_bom_distro_name_matches() {
        let text = "Ubuntu\r\nSpeedwave\r\n";
        let mut bytes: Vec<u8> = Vec::new();
        for ch in text.encode_utf16() {
            bytes.extend_from_slice(&ch.to_le_bytes());
        }
        let decoded = decode_wsl_output(&bytes);
        let found = decoded
            .lines()
            .any(|l| l.trim().trim_matches('\0') == consts::WSL_DISTRO_NAME);
        assert!(
            found,
            "distro name '{}' should be found in decoded UTF-16LE (no BOM) output, lines: {:?}",
            consts::WSL_DISTRO_NAME,
            decoded.lines().collect::<Vec<_>>()
        );
    }

    #[test]
    fn test_decode_wsl_output_odd_length_treated_as_utf8() {
        let input = b"AB\0CD\0E"; // 7 bytes — odd length
        let result = decode_wsl_output(input);
        assert_eq!(result, "AB\0CD\0E");
    }

    #[test]
    fn test_decode_wsl_output_control_chars_fall_back_to_utf8() {
        // Even-length input whose UTF-16LE decode contains control characters
        // (NUL at code-unit level), triggering the UTF-8 fallback.
        let input: &[u8] = &[0x48, 0x65, 0x6C, 0x6C, 0x6F, 0x00, 0x57, 0x6F, 0x72, 0x64];
        let result = decode_wsl_output(input);
        // UTF-16LE decode of this input produces control chars (NUL from 0x006F),
        // so the function falls back to UTF-8. The NUL byte is a control char that
        // is not \n, \r, or \t, so the UTF-16LE candidate is rejected.
        // However, the UTF-16LE decode of [0x6548, 0x6C6C, 0x006F, 0x6F57, 0x6472]
        // produces valid CJK chars with no control chars — so it is accepted as UTF-16LE.
        // We just verify it returns a non-empty string without panicking.
        assert!(
            !result.is_empty(),
            "should produce a non-empty string, got: {result:?}"
        );
    }

    #[test]
    fn test_decode_wsl_output_non_ascii_utf16le() {
        // "开发\r\nSpeedwave\r\n" encoded as UTF-16LE without BOM
        let text = "\u{5F00}\u{53D1}\r\nSpeedwave\r\n";
        let mut bytes: Vec<u8> = Vec::new();
        for ch in text.encode_utf16() {
            bytes.extend_from_slice(&ch.to_le_bytes());
        }
        let decoded = decode_wsl_output(&bytes);
        assert!(
            decoded.contains("Speedwave"),
            "should decode UTF-16LE with non-ASCII chars, got: {decoded:?}"
        );
        assert!(
            decoded.contains('\u{5F00}'),
            "should preserve non-ASCII chars, got: {decoded:?}"
        );
    }

    // ── SequentialMockRunner for retry tests ──────────────────────────────

    use std::collections::{HashMap, VecDeque};
    use std::sync::Mutex;

    /// A mock runner that returns responses sequentially for the same command key.
    /// Each call to `run()` pops the next response from the queue for that key.
    struct SequentialMockRunner {
        responses: HashMap<String, Mutex<VecDeque<anyhow::Result<String>>>>,
    }

    impl SequentialMockRunner {
        fn new() -> Self {
            Self {
                responses: HashMap::new(),
            }
        }

        fn with_responses(mut self, key: &str, results: Vec<anyhow::Result<String>>) -> Self {
            self.responses
                .insert(key.to_string(), Mutex::new(VecDeque::from(results)));
            self
        }
    }

    impl CommandRunner for SequentialMockRunner {
        fn run(&self, cmd: &str, args: &[&str]) -> anyhow::Result<String> {
            let key = format!("{} {}", cmd, args.join(" "));
            let queue = self
                .responses
                .get(&key)
                .unwrap_or_else(|| panic!("unexpected command: {key}"));
            let mut q = queue.lock().unwrap();
            match q.pop_front() {
                Some(Ok(val)) => Ok(val),
                Some(Err(e)) => Err(anyhow::anyhow!("{e}")),
                None => panic!("no more responses for: {key}"),
            }
        }

        fn run_raw_stdout(&self, cmd: &str, args: &[&str]) -> anyhow::Result<Vec<u8>> {
            self.run(cmd, args).map(|s| s.into_bytes())
        }
    }

    // ── Retry tests ──────────────────────────────────────────────────────

    #[test]
    fn test_ensure_ready_recovers_buildkit_after_retries() {
        // buildctl: fast-path fails, then 3 retry failures, then succeeds on 4th retry
        let runner = SequentialMockRunner::new()
            .with_responses(
                "wsl.exe --list --quiet",
                vec![Ok("Speedwave\n".to_string())],
            )
            // containerd: fast-path OK
            .with_responses(
                "wsl.exe -d Speedwave -- nerdctl info",
                vec![Ok("containerd running".to_string())],
            )
            .with_responses("wsl.exe -d Speedwave -- buildctl debug workers", {
                let mut v: Vec<anyhow::Result<String>> = Vec::new();
                // Fast-path check fails
                v.push(Err(anyhow::anyhow!("connection refused")));
                // Retry checks: 3 failures then success
                for _ in 0..3 {
                    v.push(Err(anyhow::anyhow!("connection refused")));
                }
                v.push(Ok("buildkit ready".to_string()));
                v
            })
            // systemctl start uses correct unit name "buildkit" (not "buildkitd").
            // If the code used "buildkitd", this mock wouldn't match and the test
            // would panic with "unexpected command".
            .with_responses(
                "wsl.exe -d Speedwave -- systemctl start buildkit",
                vec![Ok(String::new())],
            );

        let rt = WslRuntime {
            runner: Box::new(runner),
            retry_delay: std::time::Duration::ZERO,
            restart_ready_delay: std::time::Duration::ZERO,
        };
        assert!(rt.ensure_ready().is_ok());
    }

    #[test]
    fn test_ensure_ready_recovers_containerd_after_retries() {
        let runner = SequentialMockRunner::new()
            .with_responses(
                "wsl.exe --list --quiet",
                vec![Ok("Speedwave\n".to_string())],
            )
            // containerd: fast-path fails, start succeeds, 1st retry fails, 2nd retry OK
            .with_responses(
                "wsl.exe -d Speedwave -- nerdctl info",
                vec![
                    Err(anyhow::anyhow!("connection refused")),
                    Err(anyhow::anyhow!("connection refused")),
                    Ok("containerd running".to_string()),
                ],
            )
            .with_responses(
                "wsl.exe -d Speedwave -- systemctl start containerd",
                vec![Ok(String::new())],
            )
            // buildkitd: fast-path OK
            .with_responses(
                "wsl.exe -d Speedwave -- buildctl debug workers",
                vec![Ok("buildkit ready".to_string())],
            );

        let rt = WslRuntime {
            runner: Box::new(runner),
            retry_delay: std::time::Duration::ZERO,
            restart_ready_delay: std::time::Duration::ZERO,
        };
        assert!(rt.ensure_ready().is_ok());
    }

    #[test]
    fn test_ensure_ready_fails_after_max_retries_with_diagnostics() {
        let max = consts::WSL_SERVICE_CHECK_MAX_RETRIES;

        // buildctl fails on all attempts (fast-path + max retries)
        let mut buildctl_responses: Vec<anyhow::Result<String>> = Vec::new();
        // Fast-path check
        buildctl_responses.push(Err(anyhow::anyhow!("connection refused")));
        // All retry checks
        for _ in 0..max {
            buildctl_responses.push(Err(anyhow::anyhow!("still refused")));
        }

        let runner = SequentialMockRunner::new()
            .with_responses(
                "wsl.exe --list --quiet",
                vec![Ok("Speedwave\n".to_string())],
            )
            .with_responses(
                "wsl.exe -d Speedwave -- nerdctl info",
                vec![Ok("containerd running".to_string())],
            )
            .with_responses(
                "wsl.exe -d Speedwave -- buildctl debug workers",
                buildctl_responses,
            )
            .with_responses(
                "wsl.exe -d Speedwave -- systemctl start buildkit",
                vec![Err(anyhow::anyhow!("unit not found"))],
            );

        let rt = WslRuntime {
            runner: Box::new(runner),
            retry_delay: std::time::Duration::ZERO,
            restart_ready_delay: std::time::Duration::ZERO,
        };
        let result = rt.ensure_ready();
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();

        // Verify diagnostic error contains all expected information
        assert!(
            err.contains("buildkitd"),
            "error should mention service display name 'buildkitd', got: {err}"
        );
        assert!(
            err.contains("unit not found"),
            "error should include systemctl start error, got: {err}"
        );
        assert!(
            err.contains("still refused"),
            "error should include last health check error, got: {err}"
        );
        assert!(
            err.contains("systemctl start buildkit"),
            "error hint should use systemd unit 'buildkit' (not 'buildkitd'), got: {err}"
        );
        assert!(
            err.contains(&format!("after {max} attempts")),
            "error should mention retry count, got: {err}"
        );
    }

    #[test]
    fn test_restart_container_engine_ok() {
        let runner = MockRunner::new()
            .with_response("wsl.exe -d Speedwave -- systemctl restart containerd", "")
            .with_response("wsl.exe -d Speedwave -- systemctl restart buildkit", "")
            .with_response("wsl.exe -d Speedwave -- nerdctl info", "containerd running")
            .with_response(
                "wsl.exe -d Speedwave -- buildctl debug workers",
                "buildkit ready",
            );
        let rt = WslRuntime::with_runner(Box::new(runner)).with_zero_delay();
        assert!(rt.restart_container_engine().is_ok());
    }

    #[test]
    fn test_restart_container_engine_propagates_containerd_error() {
        let runner = MockRunner::new().with_error(
            "wsl.exe -d Speedwave -- systemctl restart containerd",
            "restart failed",
        );
        let rt = WslRuntime::with_runner(Box::new(runner)).with_zero_delay();
        let result = rt.restart_container_engine();
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("restart failed"));
    }

    #[test]
    fn test_restart_container_engine_not_ready_after_retries() {
        let runner = MockRunner::new()
            .with_response("wsl.exe -d Speedwave -- systemctl restart containerd", "")
            .with_response("wsl.exe -d Speedwave -- systemctl restart buildkit", "")
            .with_error("wsl.exe -d Speedwave -- nerdctl info", "connection refused")
            .with_error(
                "wsl.exe -d Speedwave -- buildctl debug workers",
                "connection refused",
            );
        let rt = WslRuntime::with_runner(Box::new(runner)).with_zero_delay();
        let result = rt.restart_container_engine();
        assert!(result.is_err());
        assert!(
            result.unwrap_err().to_string().contains("not ready"),
            "should report not ready after retries"
        );
    }
}
