//! Resolution of bundled engine binaries (limactl, nerdctl, node) on the host.

use std::path::PathBuf;
use std::process::Command;

use crate::consts;

use crate::consts::BUNDLE_RESOURCES_ENV;

/// Platform-specific PATH environment variable separator.
/// Windows uses `;`, all other platforms use `:`.
#[cfg(windows)]
const PATH_SEP: char = ';';
#[cfg(not(windows))]
const PATH_SEP: char = ':';

/// Windows OS commands that are never bundled; the fallback-to-PATH debug log
/// is suppressed for them.
#[cfg(windows)]
const ALWAYS_SYSTEM_COMMANDS: &[&str] = &["wsl.exe", "powershell.exe", "cmd.exe"];

/// `true` if `cmd` is a never-bundled Windows OS command (case-insensitive).
/// Matches on the file name, so an absolute path (e.g. the
/// `C:\Windows\System32\wsl.exe` that `reset_vm` builds) is recognised too.
#[cfg(windows)]
fn is_always_system_command(cmd: &str) -> bool {
    let name = std::path::Path::new(cmd)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(cmd);
    ALWAYS_SYSTEM_COMMANDS
        .iter()
        .any(|c| c.eq_ignore_ascii_case(name))
}

/// Resolves the path to a binary command via bundled resources or system PATH.
///
/// Resolution order (each step only if `SPEEDWAVE_RESOURCES_DIR` is set):
/// 1. `<dir>/lima/bin/<cmd>` (macOS Lima bundle).
/// 2. `<dir>/nerdctl-full/bin/<cmd>` (reserved layout, not populated in prod).
/// 3. `<dir>/nodejs/bin/<cmd>` (Unix) or `<dir>/nodejs/<cmd>.exe` (Windows).
/// 4. `<dir>/<cmd>` (native CLI helpers at the top of `Resources/`).
/// 5. Otherwise the bare command name (system PATH lookup).
pub fn resolve_binary(cmd: &str) -> String {
    if let Ok(resources_dir) = std::env::var(BUNDLE_RESOURCES_ENV) {
        let resources = PathBuf::from(&resources_dir);

        // Try Lima bundle first (macOS)
        let lima_bundled = resources.join("lima").join("bin").join(cmd);
        if lima_bundled.exists() {
            return lima_bundled.to_string_lossy().to_string();
        }

        // Try nerdctl-full bundle (reserved layout — see fn docstring)
        let nerdctl_bundled = resources
            .join(consts::NERDCTL_FULL_SUBDIR)
            .join("bin")
            .join(cmd);
        if nerdctl_bundled.exists() {
            return nerdctl_bundled.to_string_lossy().to_string();
        }

        // Try Node.js bundle (all platforms)
        // Unix layout: nodejs/bin/<cmd>, Windows layout: nodejs/<cmd>.exe
        let nodejs_bundled = resources.join(consts::NODEJS_SUBDIR).join("bin").join(cmd);
        if nodejs_bundled.exists() {
            return nodejs_bundled.to_string_lossy().to_string();
        }
        #[cfg(windows)]
        {
            let nodejs_win = resources
                .join(consts::NODEJS_SUBDIR)
                .join(format!("{cmd}.exe"));
            if nodejs_win.exists() {
                return nodejs_win.to_string_lossy().to_string();
            }
        }

        // Native CLI helpers live at the top of Resources/ per tauri.macos.conf.json.
        let top_level = resources.join(cmd);
        if top_level.exists() {
            return top_level.to_string_lossy().to_string();
        }

        #[cfg(windows)]
        let should_log = !is_always_system_command(cmd);
        #[cfg(not(windows))]
        let should_log = true;
        if should_log {
            log::debug!(
                "bundled binary not found for '{}', falling back to system PATH",
                cmd
            );
        }
    }
    cmd.to_string()
}

/// Windows process creation flag preventing a visible console window on child
/// processes. `Command::creation_flags()` is a setter, not OR — apply once.
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Creates a `Command` for the given binary with bundled-binary resolution.
///
/// - Applies `CREATE_NO_WINDOW` on Windows.
/// - For `limactl`, sets `LIMA_HOME` to the isolated Speedwave directory.
/// - For bundled binaries, prepends their parent directory to `PATH`.
///
/// `container_exec()` bypasses this and uses raw `Command::new()` (TTY needs a
/// console window on Windows).
pub fn command(cmd: &str) -> Command {
    let resolved = resolve_binary(cmd);
    let mut command = Command::new(&resolved);

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    // For bundled (absolute) paths, prepend parent dir to PATH and set CNI_PATH.
    let resolved_path = std::path::Path::new(&resolved);
    if resolved_path.is_absolute() {
        if let Some(bin_dir) = resolved_path.parent() {
            let system_path = std::env::var("PATH").unwrap_or_default();
            let bin_dir_str = bin_dir.to_string_lossy();
            if !system_path
                .split(PATH_SEP)
                .any(|p| p == bin_dir_str.as_ref())
            {
                command.env("PATH", format!("{bin_dir_str}{PATH_SEP}{system_path}"));
            }

            // nerdctl-full bundles CNI plugins in <bundle>/libexec/cni/.
            if let Some(bundle_root) = bin_dir.parent() {
                let cni_dir = bundle_root.join("libexec").join("cni");
                if cni_dir.is_dir() {
                    command.env("CNI_PATH", &cni_dir);
                }
            }
        }
    }

    apply_wsl_utf8(&mut command, cmd);

    if cmd == "limactl" {
        match lima_home() {
            Some(home) => {
                if let Err(e) = std::fs::create_dir_all(&home) {
                    log::error!(
                        "failed to create LIMA_HOME directory {}: {}",
                        home.display(),
                        e
                    );
                }
                command.env("LIMA_HOME", &home);
            }
            None => {
                log::error!("LIMA_HOME not set: could not determine home directory");
            }
        }
    }
    command
}

/// Creates a `Command` for a system binary (no bundled-binary resolution).
///
/// Use this for system utilities like `wsl.exe`, `powershell.exe`, `tasklist`,
/// `taskkill`, `icacls`, etc. that are never bundled in the app resources.
///
/// Applies `CREATE_NO_WINDOW` on Windows to prevent console window flashing.
/// For interactive TTY commands, use raw `Command::new()` instead.
pub fn system_command(program: &str) -> Command {
    let mut command = Command::new(program);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    apply_wsl_utf8(&mut command, program);
    command
}

/// Absolute path to Windows PowerShell — a bare `powershell` PATH lookup is
/// hijackable and inconsistent across contexts (SSOT; Desktop re-exports it).
pub fn system_powershell_path() -> PathBuf {
    let system_root =
        std::env::var_os("SystemRoot").unwrap_or_else(|| std::ffi::OsString::from(r"C:\Windows"));
    PathBuf::from(&system_root)
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe")
}

/// `system_command` pinned to the absolute PowerShell path.
pub fn powershell_command() -> Command {
    system_command(&system_powershell_path().to_string_lossy())
}

/// Forces UTF-8 output from `wsl.exe` (default is UTF-16LE / localized);
/// classifiers and logs downstream assume UTF-8. No-op for other programs.
fn apply_wsl_utf8(command: &mut Command, program: &str) {
    let name = program
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(program)
        .to_ascii_lowercase();
    if name == "wsl" || name == "wsl.exe" {
        command.env("WSL_UTF8", "1");
    }
}

/// Runs a command with a timeout, killing the process if it exceeds the deadline.
/// Polls `child.try_wait()` every 200ms; does not capture stdout/stderr.
/// Do not use with `Stdio::piped()` (pipe-buffer deadlock risk).
pub fn run_with_timeout(
    cmd: &mut std::process::Command,
    timeout: std::time::Duration,
) -> anyhow::Result<std::process::ExitStatus> {
    let program = cmd.get_program().to_string_lossy().to_string();
    let mut child = cmd.spawn()?;
    let start = std::time::Instant::now();
    loop {
        match child.try_wait()? {
            Some(status) => return Ok(status),
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

/// Spawns `wsl.exe` with `args` (optionally feeding `stdin` — the `bash -s` pattern that
/// survives wsl.exe's default-shell reparse of the post-`--` line) and waits bounded
/// via [`wait_with_output_timeout`]. Decode output with `runtime::decode_wsl_output`.
pub fn run_wsl_bounded(
    args: &[&str],
    stdin: Option<&str>,
    timeout: std::time::Duration,
) -> anyhow::Result<std::process::Output> {
    let mut cmd = system_command("wsl.exe");
    cmd.args(args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    if stdin.is_some() {
        cmd.stdin(std::process::Stdio::piped());
    }
    let mut child = cmd.spawn()?;
    if let Some(script) = stdin {
        if let Some(mut pipe) = child.stdin.take() {
            use std::io::Write;
            pipe.write_all(script.as_bytes())?;
        }
    }
    wait_with_output_timeout(child, timeout)
}

/// Waits for `child` (piped stdout/stderr) at most `timeout`, draining pipes
/// on threads; kills the child and errors on expiry.
pub fn wait_with_output_timeout(
    mut child: std::process::Child,
    timeout: std::time::Duration,
) -> anyhow::Result<std::process::Output> {
    debug_assert!(
        child.stdout.is_some() && child.stderr.is_some(),
        "wait_with_output_timeout requires Stdio::piped() stdout AND stderr; \
         an unpiped child silently yields empty output"
    );
    fn drain<R: std::io::Read + Send + 'static>(
        pipe: Option<R>,
    ) -> std::thread::JoinHandle<Vec<u8>> {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(mut r) = pipe {
                let _ = r.read_to_end(&mut buf);
            }
            buf
        })
    }
    let stdout = drain(child.stdout.take());
    let stderr = drain(child.stderr.take());
    let start = std::time::Instant::now();
    let status = loop {
        match child.try_wait()? {
            Some(status) => break status,
            None if start.elapsed() >= timeout => {
                if let Err(e) = child.kill() {
                    log::warn!("wait_with_output_timeout: kill failed: {e}");
                }
                let _ = child.wait();
                anyhow::bail!("child process timed out after {}s", timeout.as_secs());
            }
            None => std::thread::sleep(std::time::Duration::from_millis(200)),
        }
    };
    Ok(std::process::Output {
        status,
        stdout: stdout.join().unwrap_or_default(),
        stderr: stderr.join().unwrap_or_default(),
    })
}

/// Returns the isolated LIMA_HOME directory `~/.speedwave/lima` (avoids
/// collision with a user-installed Lima at `~/.lima`).
pub fn lima_home() -> Option<PathBuf> {
    Some(consts::data_dir().join(consts::LIMA_SUBDIR))
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
pub(crate) mod tests {
    use super::*;
    use std::env;
    use std::sync::Mutex;

    /// Serialises env-var mutations across parallel test threads.
    pub(crate) static ENV_LOCK: Mutex<()> = Mutex::new(());

    /// True when the built Command carries `WSL_UTF8=1`.
    fn has_wsl_utf8(cmd: &std::process::Command) -> bool {
        cmd.get_envs()
            .any(|(k, v)| k == "WSL_UTF8" && v.is_some_and(|v| v == "1"))
    }

    #[test]
    fn system_command_sets_wsl_utf8_for_wsl_only() {
        assert!(has_wsl_utf8(&system_command("wsl.exe")));
        assert!(has_wsl_utf8(&system_command(
            r"C:\Windows\System32\wsl.exe"
        )));
        assert!(!has_wsl_utf8(&system_command("powershell.exe")));
        assert!(!has_wsl_utf8(&system_command("tasklist")));
    }

    #[test]
    fn system_powershell_path_is_absolute_system32() {
        let p = system_powershell_path();
        let s = p.to_string_lossy();
        assert!(s.ends_with("powershell.exe"), "got: {s}");
        assert!(
            s.contains("System32") && s.contains("WindowsPowerShell"),
            "must pin the System32 install, got: {s}"
        );
    }

    #[test]
    fn command_sets_wsl_utf8_for_wsl_only() {
        let _guard = ENV_LOCK.lock().unwrap();
        assert!(has_wsl_utf8(&command("wsl.exe")));
        assert!(!has_wsl_utf8(&command("nerdctl")));
    }

    #[test]
    fn resolve_binary_without_env_returns_bare_name() {
        let _guard = ENV_LOCK.lock().unwrap();
        env::remove_var(BUNDLE_RESOURCES_ENV);
        assert_eq!(resolve_binary("limactl"), "limactl");
        assert_eq!(resolve_binary("nerdctl"), "nerdctl");
    }

    #[test]
    fn resolve_binary_with_env_but_missing_file_returns_bare_name() {
        let _guard = ENV_LOCK.lock().unwrap();
        let tmp = tempfile::tempdir().expect("tempdir");
        env::set_var(BUNDLE_RESOURCES_ENV, tmp.path().to_string_lossy().as_ref());
        assert_eq!(resolve_binary("limactl"), "limactl");
        env::remove_var(BUNDLE_RESOURCES_ENV);
    }

    #[test]
    fn resolve_binary_with_env_and_existing_file_returns_full_path() {
        let _guard = ENV_LOCK.lock().unwrap();
        let tmp = tempfile::tempdir().expect("tempdir");
        let bin_dir = tmp.path().join("lima").join("bin");
        std::fs::create_dir_all(&bin_dir).expect("mkdir");
        let limactl_path = bin_dir.join("limactl");
        std::fs::write(&limactl_path, "fake").expect("write");

        env::set_var(BUNDLE_RESOURCES_ENV, tmp.path().to_string_lossy().as_ref());
        let result = resolve_binary("limactl");
        assert_eq!(result, limactl_path.to_string_lossy().to_string());
        env::remove_var(BUNDLE_RESOURCES_ENV);
    }

    #[test]
    fn resolve_binary_non_bundled_command_falls_back_to_path() {
        let _guard = ENV_LOCK.lock().unwrap();
        let tmp = tempfile::tempdir().expect("tempdir");
        let bin_dir = tmp.path().join("lima").join("bin");
        std::fs::create_dir_all(&bin_dir).expect("mkdir");
        std::fs::write(bin_dir.join("limactl"), "fake").expect("write");

        env::set_var(BUNDLE_RESOURCES_ENV, tmp.path().to_string_lossy().as_ref());
        assert_eq!(resolve_binary("unknown-cmd"), "unknown-cmd");
        env::remove_var(BUNDLE_RESOURCES_ENV);
    }

    // Never-bundled OS commands are recognised case-insensitively (Windows-only).
    #[cfg(windows)]
    #[test]
    fn always_system_commands_recognised() {
        assert!(is_always_system_command("wsl.exe"));
        assert!(is_always_system_command("WSL.EXE"));
        assert!(is_always_system_command("powershell.exe"));
        assert!(is_always_system_command("cmd.exe"));
        // Absolute path (reset_vm builds C:\Windows\System32\wsl.exe).
        assert!(is_always_system_command("C:\\Windows\\System32\\wsl.exe"));
        assert!(is_always_system_command("C:\\Windows\\System32\\WSL.EXE"));
        assert!(!is_always_system_command("limactl"));
        assert!(!is_always_system_command("nerdctl"));
        assert!(!is_always_system_command("node"));
        assert!(!is_always_system_command("C:\\bundle\\limactl.exe"));
    }

    // Suppression must not change resolution — wsl.exe still resolves to the bare name.
    #[cfg(windows)]
    #[test]
    fn resolve_binary_wsl_still_returns_bare_name() {
        let _guard = ENV_LOCK.lock().unwrap();
        let tmp = tempfile::tempdir().expect("tempdir");
        env::set_var(BUNDLE_RESOURCES_ENV, tmp.path().to_string_lossy().as_ref());
        assert_eq!(resolve_binary("wsl.exe"), "wsl.exe");
        env::remove_var(BUNDLE_RESOURCES_ENV);
    }

    #[test]
    fn resolve_binary_top_level_native_cli_helper() {
        // Native CLIs sit at the top of Resources/, not under lima/nerdctl-full/nodejs.
        let _guard = ENV_LOCK.lock().unwrap();
        let tmp = tempfile::tempdir().expect("tempdir");
        let cli_path = tmp.path().join("audio-capture-cli");
        std::fs::write(&cli_path, "fake").expect("write");

        env::set_var(BUNDLE_RESOURCES_ENV, tmp.path().to_string_lossy().as_ref());
        assert_eq!(
            resolve_binary("audio-capture-cli"),
            cli_path.to_string_lossy().to_string()
        );
        env::remove_var(BUNDLE_RESOURCES_ENV);
    }

    #[test]
    fn test_resolve_binary_nerdctl_from_bundle() {
        let _guard = ENV_LOCK.lock().unwrap();
        let tmp = tempfile::tempdir().expect("tempdir");
        let bin_dir = tmp
            .path()
            .join(crate::consts::NERDCTL_FULL_SUBDIR)
            .join("bin");
        std::fs::create_dir_all(&bin_dir).expect("mkdir");
        let nerdctl_path = bin_dir.join("nerdctl");
        std::fs::write(&nerdctl_path, "fake").expect("write");

        env::set_var(BUNDLE_RESOURCES_ENV, tmp.path().to_string_lossy().as_ref());
        let result = resolve_binary("nerdctl");
        assert_eq!(result, nerdctl_path.to_string_lossy().to_string());
        env::remove_var(BUNDLE_RESOURCES_ENV);
    }

    #[test]
    fn test_resolve_binary_nerdctl_fallback_to_path() {
        let _guard = ENV_LOCK.lock().unwrap();
        let tmp = tempfile::tempdir().expect("tempdir");
        // No nerdctl-full/bin/nerdctl exists
        env::set_var(BUNDLE_RESOURCES_ENV, tmp.path().to_string_lossy().as_ref());
        assert_eq!(resolve_binary("nerdctl"), "nerdctl");
        env::remove_var(BUNDLE_RESOURCES_ENV);
    }

    #[test]
    fn test_resolve_binary_lima_takes_priority_over_nerdctl() {
        let _guard = ENV_LOCK.lock().unwrap();
        let tmp = tempfile::tempdir().expect("tempdir");
        // Create same binary in both lima and nerdctl-full
        let lima_bin = tmp.path().join("lima").join("bin");
        std::fs::create_dir_all(&lima_bin).expect("mkdir");
        std::fs::write(lima_bin.join("nerdctl"), "lima-nerdctl").expect("write");

        let nerdctl_bin = tmp
            .path()
            .join(crate::consts::NERDCTL_FULL_SUBDIR)
            .join("bin");
        std::fs::create_dir_all(&nerdctl_bin).expect("mkdir");
        std::fs::write(nerdctl_bin.join("nerdctl"), "nerdctl-full-nerdctl").expect("write");

        env::set_var(BUNDLE_RESOURCES_ENV, tmp.path().to_string_lossy().as_ref());
        let result = resolve_binary("nerdctl");
        // Lima path should win (checked first)
        assert_eq!(
            result,
            lima_bin.join("nerdctl").to_string_lossy().to_string()
        );
        env::remove_var(BUNDLE_RESOURCES_ENV);
    }

    #[test]
    fn test_resolve_binary_node_from_bundle() {
        let _guard = ENV_LOCK.lock().unwrap();
        let tmp = tempfile::tempdir().expect("tempdir");
        let bin_dir = tmp.path().join(crate::consts::NODEJS_SUBDIR).join("bin");
        std::fs::create_dir_all(&bin_dir).expect("mkdir");
        let node_path = bin_dir.join("node");
        std::fs::write(&node_path, "fake").expect("write");

        env::set_var(BUNDLE_RESOURCES_ENV, tmp.path().to_string_lossy().as_ref());
        let result = resolve_binary("node");
        assert_eq!(result, node_path.to_string_lossy().to_string());
        env::remove_var(BUNDLE_RESOURCES_ENV);
    }

    #[test]
    fn test_resolve_binary_node_fallback_to_path() {
        let _guard = ENV_LOCK.lock().unwrap();
        let tmp = tempfile::tempdir().expect("tempdir");
        // No nodejs/bin/node exists
        env::set_var(BUNDLE_RESOURCES_ENV, tmp.path().to_string_lossy().as_ref());
        assert_eq!(resolve_binary("node"), "node");
        env::remove_var(BUNDLE_RESOURCES_ENV);
    }

    #[test]
    fn lima_home_returns_expected_path() {
        // Structural invariant `<data_dir>/lima`, separator-agnostic (Path tail).
        let path = lima_home().expect("lima_home should resolve");
        assert!(
            path.ends_with(consts::LIMA_SUBDIR),
            "lima_home should end with {}, got: {}",
            consts::LIMA_SUBDIR,
            path.display()
        );
        assert!(
            path.parent().is_some_and(|p| p.file_name().is_some()),
            "lima_home should have a data-dir parent, got: {}",
            path.display()
        );
    }

    #[test]
    fn command_limactl_sets_lima_home_env() {
        let _guard = ENV_LOCK.lock().unwrap();
        env::remove_var(BUNDLE_RESOURCES_ENV);

        let cmd = command("limactl");
        let envs: Vec<_> = cmd.get_envs().collect();

        let lima_home_env = envs
            .iter()
            .find(|(k, _)| *k == "LIMA_HOME")
            .expect("LIMA_HOME env should be set for limactl");

        let value = lima_home_env.1.expect("LIMA_HOME should have a value");
        // Structural invariant `<data_dir>/lima`, separator-agnostic (Path tail).
        let value_path = std::path::Path::new(value);
        assert!(
            value_path.ends_with(consts::LIMA_SUBDIR),
            "LIMA_HOME should end with {}, got: {}",
            consts::LIMA_SUBDIR,
            value.to_string_lossy()
        );
    }

    #[test]
    fn command_non_limactl_does_not_set_lima_home() {
        let _guard = ENV_LOCK.lock().unwrap();
        env::remove_var(BUNDLE_RESOURCES_ENV);

        let cmd = command("nerdctl");
        let envs: Vec<_> = cmd.get_envs().collect();

        let lima_home_env = envs.iter().find(|(k, _)| *k == "LIMA_HOME");
        assert!(
            lima_home_env.is_none(),
            "LIMA_HOME should not be set for non-limactl commands"
        );
    }

    #[test]
    fn command_limactl_uses_resolved_binary() {
        let _guard = ENV_LOCK.lock().unwrap();
        env::remove_var(BUNDLE_RESOURCES_ENV);

        let cmd = command("limactl");
        let program = cmd.get_program().to_string_lossy().to_string();
        assert_eq!(program, "limactl");
    }

    #[test]
    fn command_limactl_with_bundled_binary() {
        let _guard = ENV_LOCK.lock().unwrap();
        let tmp = tempfile::tempdir().expect("tempdir");
        let bin_dir = tmp.path().join("lima").join("bin");
        std::fs::create_dir_all(&bin_dir).expect("mkdir");
        let limactl_path = bin_dir.join("limactl");
        std::fs::write(&limactl_path, "fake").expect("write");

        env::set_var(BUNDLE_RESOURCES_ENV, tmp.path().to_string_lossy().as_ref());
        let cmd = command("limactl");
        let program = cmd.get_program().to_string_lossy().to_string();
        assert_eq!(
            program,
            limactl_path.to_string_lossy().to_string(),
            "command() should use the bundled binary path"
        );
        env::remove_var(BUNDLE_RESOURCES_ENV);
    }

    #[test]
    fn command_bundled_nerdctl_prepends_bin_dir_to_path() {
        let _guard = ENV_LOCK.lock().unwrap();
        let tmp = tempfile::tempdir().expect("tempdir");
        let bin_dir = tmp
            .path()
            .join(crate::consts::NERDCTL_FULL_SUBDIR)
            .join("bin");
        std::fs::create_dir_all(&bin_dir).expect("mkdir");
        std::fs::write(bin_dir.join("nerdctl"), "fake").expect("write");

        env::set_var(BUNDLE_RESOURCES_ENV, tmp.path().to_string_lossy().as_ref());
        let cmd = command("nerdctl");

        let path_env = cmd
            .get_envs()
            .find(|(k, _)| *k == "PATH")
            .expect("PATH should be set for bundled binary");
        let path_value = path_env
            .1
            .expect("PATH should have a value")
            .to_string_lossy();
        let bin_dir_str = bin_dir.to_string_lossy();
        assert!(
            path_value.starts_with(bin_dir_str.as_ref()),
            "PATH should start with bundled bin dir {}, got: {}",
            bin_dir_str,
            path_value
        );

        env::remove_var(BUNDLE_RESOURCES_ENV);
    }

    #[test]
    fn command_system_binary_does_not_modify_path() {
        let _guard = ENV_LOCK.lock().unwrap();
        env::remove_var(BUNDLE_RESOURCES_ENV);

        let cmd = command("nerdctl");
        let path_env = cmd.get_envs().find(|(k, _)| *k == "PATH");
        assert!(
            path_env.is_none(),
            "PATH should not be modified for system-resolved binaries"
        );
    }

    #[test]
    fn command_bundled_nerdctl_sets_cni_path() {
        let _guard = ENV_LOCK.lock().unwrap();
        let tmp = tempfile::tempdir().expect("tempdir");
        let bin_dir = tmp
            .path()
            .join(crate::consts::NERDCTL_FULL_SUBDIR)
            .join("bin");
        std::fs::create_dir_all(&bin_dir).expect("mkdir");
        std::fs::write(bin_dir.join("nerdctl"), "fake").expect("write");

        // Create the libexec/cni directory that nerdctl-full bundles include
        let cni_dir = tmp
            .path()
            .join(crate::consts::NERDCTL_FULL_SUBDIR)
            .join("libexec")
            .join("cni");
        std::fs::create_dir_all(&cni_dir).expect("mkdir cni");

        env::set_var(BUNDLE_RESOURCES_ENV, tmp.path().to_string_lossy().as_ref());
        let cmd = command("nerdctl");

        let cni_env = cmd
            .get_envs()
            .find(|(k, _)| *k == "CNI_PATH")
            .expect("CNI_PATH should be set for bundled nerdctl with libexec/cni");
        let cni_value = cni_env
            .1
            .expect("CNI_PATH should have a value")
            .to_string_lossy();
        assert_eq!(
            cni_value,
            cni_dir.to_string_lossy(),
            "CNI_PATH should point to nerdctl-full/libexec/cni/"
        );

        env::remove_var(BUNDLE_RESOURCES_ENV);
    }

    #[test]
    fn command_bundled_nerdctl_no_cni_path_without_cni_dir() {
        let _guard = ENV_LOCK.lock().unwrap();
        let tmp = tempfile::tempdir().expect("tempdir");
        let bin_dir = tmp
            .path()
            .join(crate::consts::NERDCTL_FULL_SUBDIR)
            .join("bin");
        std::fs::create_dir_all(&bin_dir).expect("mkdir");
        std::fs::write(bin_dir.join("nerdctl"), "fake").expect("write");
        // No libexec/cni directory

        env::set_var(BUNDLE_RESOURCES_ENV, tmp.path().to_string_lossy().as_ref());
        let cmd = command("nerdctl");

        let cni_env = cmd.get_envs().find(|(k, _)| *k == "CNI_PATH");
        assert!(
            cni_env.is_none(),
            "CNI_PATH should not be set when libexec/cni does not exist"
        );

        env::remove_var(BUNDLE_RESOURCES_ENV);
    }

    #[test]
    fn system_command_returns_correct_program() {
        let cmd = system_command("wsl.exe");
        assert_eq!(
            cmd.get_program().to_string_lossy(),
            "wsl.exe",
            "system_command should use the given program name verbatim"
        );
    }

    #[test]
    fn system_command_does_not_modify_path() {
        let cmd = system_command("powershell.exe");
        let path_env = cmd.get_envs().find(|(k, _)| *k == "PATH");
        assert!(path_env.is_none(), "system_command should not modify PATH");
    }

    #[test]
    fn system_command_does_not_set_lima_home() {
        let cmd = system_command("limactl");
        let lima_home_env = cmd.get_envs().find(|(k, _)| *k == "LIMA_HOME");
        assert!(
            lima_home_env.is_none(),
            "system_command should not set LIMA_HOME even for 'limactl'"
        );
    }

    #[test]
    #[cfg(unix)]
    fn test_run_with_timeout_success() {
        use std::process::Command;
        use std::time::Duration;

        let result = run_with_timeout(Command::new("echo").arg("hello"), Duration::from_secs(5));
        assert!(result.is_ok(), "fast command should succeed");
        assert!(result.unwrap().success());
    }

    #[test]
    fn test_run_with_timeout_nonexistent_command() {
        use std::process::Command;
        use std::time::Duration;

        let result = run_with_timeout(
            &mut Command::new("__nonexistent_binary_4f3a2b1c__"),
            Duration::from_secs(5),
        );
        assert!(result.is_err(), "nonexistent command should fail on spawn");
    }

    #[test]
    #[cfg(unix)]
    fn test_run_with_timeout_nonzero_exit() {
        use std::process::Command;
        use std::time::Duration;

        let result = run_with_timeout(&mut Command::new("false"), Duration::from_secs(5));
        assert!(result.is_ok(), "non-zero exit is not an error");
        assert!(!result.unwrap().success(), "exit code should be non-zero");
    }

    #[test]
    #[cfg(unix)]
    fn test_run_with_timeout_zero_duration_kills_immediately() {
        use std::process::Command;
        use std::time::Duration;

        let result = run_with_timeout(Command::new("sleep").arg("60"), Duration::from_secs(0));
        assert!(result.is_err(), "zero timeout should kill immediately");
        assert!(result.unwrap_err().to_string().contains("timed out"));
    }

    #[test]
    #[cfg(unix)]
    fn test_run_with_timeout_exceeds_deadline() {
        use std::process::Command;
        use std::time::{Duration, Instant};

        let start = Instant::now();
        let result = run_with_timeout(Command::new("sleep").arg("60"), Duration::from_secs(1));
        let elapsed = start.elapsed();

        assert!(result.is_err(), "slow command should be killed");
        let err_msg = result.unwrap_err().to_string();
        assert!(
            err_msg.contains("timed out"),
            "error should mention timeout, got: {err_msg}"
        );
        assert!(
            elapsed < Duration::from_secs(5),
            "should not wait for the full 60s, elapsed: {elapsed:?}"
        );
    }

    fn spawn_shell(script: &str) -> std::process::Child {
        let mut cmd = if cfg!(windows) {
            let mut c = std::process::Command::new("cmd");
            c.arg("/C").arg(script);
            c
        } else {
            let mut c = std::process::Command::new("sh");
            c.arg("-c").arg(script);
            c
        };
        cmd.stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .expect("spawn shell child")
    }

    #[test]
    fn wait_with_output_timeout_captures_fast_child_output() {
        let child = spawn_shell("echo drained");
        let out = wait_with_output_timeout(child, std::time::Duration::from_secs(30))
            .expect("fast child");
        assert!(out.status.success());
        assert!(String::from_utf8_lossy(&out.stdout).contains("drained"));
    }

    #[test]
    fn wait_with_output_timeout_kills_and_errors_on_expiry() {
        let script = if cfg!(windows) {
            "ping -n 30 127.0.0.1 >NUL"
        } else {
            "sleep 30"
        };
        let child = spawn_shell(script);
        let err = wait_with_output_timeout(child, std::time::Duration::from_millis(200))
            .expect_err("must time out");
        assert!(err.to_string().contains("timed out"));
    }

    #[test]
    #[cfg(all(unix, debug_assertions))]
    #[should_panic(expected = "requires Stdio::piped()")]
    fn wait_with_output_timeout_rejects_unpiped_child_in_debug() {
        let child = std::process::Command::new("true")
            .spawn()
            .expect("spawn unpiped child");
        let _ = wait_with_output_timeout(child, std::time::Duration::from_secs(5));
    }

    #[test]
    #[cfg(not(target_os = "windows"))]
    fn run_wsl_bounded_errors_off_windows_instead_of_hanging() {
        // wsl.exe does not exist off Windows — the helper must surface a spawn
        // error, never panic or block.
        let err = super::run_wsl_bounded(
            &["--list", "--running", "--quiet"],
            None,
            std::time::Duration::from_secs(1),
        )
        .expect_err("wsl.exe must not spawn off Windows");
        assert!(!err.to_string().is_empty());
    }
}
