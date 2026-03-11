use super::{CommandRunner, ContainerRuntime, RealRunner};
use crate::consts;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Decodes raw bytes from `wsl.exe` output, handling UTF-16LE (with or without BOM)
/// which is the default encoding for `wsl.exe --list` on Windows.
///
/// Falls back to `String::from_utf8_lossy` for plain UTF-8 output.
pub fn decode_wsl_output(bytes: &[u8]) -> String {
    if bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE {
        // UTF-16LE with BOM — skip the 2-byte BOM
        decode_utf16le(&bytes[2..])
    } else if bytes.len() >= 2 && looks_like_utf16le(bytes) {
        // UTF-16LE without BOM (common on Windows)
        decode_utf16le(bytes)
    } else {
        String::from_utf8_lossy(bytes).to_string()
    }
}

fn decode_utf16le(bytes: &[u8]) -> String {
    let u16s: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .collect();
    String::from_utf16_lossy(&u16s)
}

/// Checks whether `bytes` look like UTF-16LE-encoded text (without BOM).
///
/// Uses a UTF-16LE ASCII pattern check: for ASCII text encoded as UTF-16LE,
/// every odd-indexed byte (high byte of each code unit) should be 0x00.
/// We check up to the first 10 code units (20 bytes) and require at least
/// 30% of the high bytes to be null. This is stronger than a general null-byte
/// ratio because it specifically checks the UTF-16LE byte pattern, catching
/// cases where non-ASCII distro names appear at the start of the output.
fn looks_like_utf16le(bytes: &[u8]) -> bool {
    if bytes.len() < 2 || !bytes.len().is_multiple_of(2) {
        return false;
    }
    let sample_code_units = (bytes.len() / 2).min(10);
    let sample_bytes = sample_code_units * 2;
    let null_high_bytes = bytes[..sample_bytes]
        .chunks_exact(2)
        .filter(|pair| pair[1] == 0x00)
        .count();
    // For ASCII-range UTF-16LE, 100% of high bytes are null.
    // A 30% threshold catches mixed ASCII/non-ASCII UTF-16LE reliably
    // while rejecting plain UTF-8 or binary garbage.
    null_high_bytes > sample_code_units * 3 / 10
}

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
pub fn windows_to_wsl_path(path: &Path) -> anyhow::Result<PathBuf> {
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
        // Non-ASCII distro name before Speedwave — verifies the heuristic
        // catches UTF-16LE even when the first bytes aren't ASCII
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
        let runner = MockRunner::new().with_raw_response("wsl.exe --list --quiet", bytes);
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
    fn test_decode_wsl_output_binary_garbage_with_stray_nulls() {
        let input: &[u8] = &[0x48, 0x65, 0x6C, 0x6C, 0x6F, 0x00, 0x57, 0x6F, 0x72, 0x64];
        let result = decode_wsl_output(input);
        assert!(
            result.contains("Hello"),
            "binary data with sparse nulls should be decoded as UTF-8, got: {result:?}"
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

    // ── looks_like_utf16le unit tests ───────────────────────────────────

    #[test]
    fn test_looks_like_utf16le_ascii_encoded() {
        // "AB" as UTF-16LE: [0x41, 0x00, 0x42, 0x00]
        assert!(looks_like_utf16le(&[0x41, 0x00, 0x42, 0x00]));
    }

    #[test]
    fn test_looks_like_utf16le_rejects_plain_ascii() {
        assert!(!looks_like_utf16le(b"Hello World!"));
    }

    #[test]
    fn test_looks_like_utf16le_rejects_odd_length() {
        assert!(!looks_like_utf16le(&[0x41, 0x00, 0x42]));
    }

    #[test]
    fn test_looks_like_utf16le_rejects_empty() {
        assert!(!looks_like_utf16le(b""));
    }

    #[test]
    fn test_looks_like_utf16le_rejects_single_byte() {
        assert!(!looks_like_utf16le(b"\0"));
    }

    #[test]
    fn test_looks_like_utf16le_sparse_nulls_below_threshold() {
        // 1 null high byte out of 5 code units = 20%, below the 30% threshold
        let data: &[u8] = &[0x48, 0x65, 0x6C, 0x6C, 0x6F, 0x00, 0x57, 0x6F, 0x72, 0x64];
        assert!(!looks_like_utf16le(data));
    }

    #[test]
    fn test_looks_like_utf16le_non_ascii_start() {
        // "开" (U+5F00) as UTF-16LE is [0x00, 0x5F] — high byte is 0x5F, not 0x00
        // "S" as UTF-16LE is [0x53, 0x00] — high byte is 0x00
        // Mixed content should still be detected if enough ASCII chars follow
        let text = "S\u{5F00}Spe";
        let mut bytes: Vec<u8> = Vec::new();
        for ch in text.encode_utf16() {
            bytes.extend_from_slice(&ch.to_le_bytes());
        }
        // 3 out of 4 code units have null high byte — 75% > 30%
        assert!(looks_like_utf16le(&bytes));
    }
}
