use super::{CommandRunner, ContainerRuntime, RealRunner};
use crate::consts;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Command;

pub struct WslRuntime {
    runner: Box<dyn CommandRunner>,
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
        }
    }

    pub fn with_runner(runner: Box<dyn CommandRunner>) -> Self {
        Self { runner }
    }
}

/// Converts a Windows-style path (`C:\foo\bar` or `C:/foo/bar`) to a WSL mount path
/// (`/mnt/c/foo/bar`). Passes through paths that are already Unix-style.
///
/// Returns an error for UNC paths (`\\server\share`) and extended-length prefixes
/// (`\\?\C:\...`) which cannot be mapped to WSL mount points.
fn windows_to_wsl_path(path: &Path) -> anyhow::Result<PathBuf> {
    let s = path.to_string_lossy();
    let bytes = s.as_bytes();

    // Reject UNC and extended-length paths — they can't be mapped to /mnt/<drive>/
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

impl ContainerRuntime for WslRuntime {
    fn compose_up(&self, project: &str) -> anyhow::Result<()> {
        let compose_file = super::compose_file_path(project)?;
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
        let compose_file = super::compose_file_path(project)?;
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
                "down",
            ],
        )?;
        Ok(())
    }

    fn compose_ps(&self, project: &str) -> anyhow::Result<Vec<Value>> {
        let compose_file = super::compose_file_path(project)?;
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
        let mut command = Command::new("wsl.exe");
        command.args([
            "-d",
            consts::WSL_DISTRO_NAME,
            "--",
            "nerdctl",
            "exec",
            "-i",
            container,
        ]);
        command.args(cmd);
        Ok(command)
    }

    fn is_available(&self) -> bool {
        self.runner
            .run("wsl.exe", &["--list", "--quiet"])
            .map(|output| {
                output
                    .lines()
                    .any(|line| line.trim().trim_matches('\0') == consts::WSL_DISTRO_NAME)
            })
            .unwrap_or(false)
    }

    fn build_image(&self, tag: &str, context_dir: &str, containerfile: &str) -> anyhow::Result<()> {
        self.runner.run(
            "wsl.exe",
            &[
                "-d",
                consts::WSL_DISTRO_NAME,
                "--",
                "nerdctl",
                "build",
                "-t",
                tag,
                "-f",
                containerfile,
                context_dir,
            ],
        )?;
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
        let compose_file = super::compose_file_path(project)?;
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
        let compose_file = super::compose_file_path(project)?;
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

    fn ensure_ready(&self) -> anyhow::Result<()> {
        let output = self
            .runner
            .run("wsl.exe", &["--list", "--quiet"])
            .map_err(|_| {
                anyhow::anyhow!(
                    "WSL2 not available. Ensure Windows Subsystem for Linux is enabled.\n\
                     Run: wsl --install"
                )
            })?;

        let distro_exists = output
            .lines()
            .any(|line| line.trim().trim_matches('\0') == consts::WSL_DISTRO_NAME);

        if !distro_exists {
            anyhow::bail!(
                "WSL2 distribution '{}' not found. Run Speedwave.app setup wizard to import it.",
                consts::WSL_DISTRO_NAME
            );
        }

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
    fn test_is_available_handles_null_bytes() {
        // WSL output often has null bytes between characters
        let runner = MockRunner::new()
            .with_response("wsl.exe --list --quiet", "S\0p\0e\0e\0d\0f\0l\0o\0w\02\0\n");
        let rt = WslRuntime::with_runner(Box::new(runner));
        // After trim_matches('\0'), "S\0p\0..." won't match "Speedwave"
        // because trim_matches only trims leading/trailing, not internal nulls.
        // This tests the real behavior: internal nulls prevent matching.
        assert!(!rt.is_available());
    }

    #[test]
    fn test_is_available_distro_with_trailing_null() {
        let runner = MockRunner::new().with_response("wsl.exe --list --quiet", "Speedwave\0\n");
        let rt = WslRuntime::with_runner(Box::new(runner));
        assert!(rt.is_available());
    }

    #[test]
    fn test_ensure_ready_distro_exists() {
        let runner =
            MockRunner::new().with_response("wsl.exe --list --quiet", "Ubuntu\nSpeedwave\n");
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
    fn test_container_logs() {
        let runner = MockRunner::new().with_response(
            "wsl.exe -d Speedwave -- nerdctl logs --tail 100 my_container",
            "log output here",
        );
        let rt = WslRuntime::with_runner(Box::new(runner));
        let logs = rt.container_logs("my_container", 100).unwrap();
        assert_eq!(logs, "log output here");
    }

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
    fn test_windows_to_wsl_path_rejects_extended_length_path() {
        let result = windows_to_wsl_path(Path::new(r"\\?\C:\Users\dev"));
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(
            err.contains("UNC path"),
            "error should mention UNC, got: {}",
            err
        );
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
}
