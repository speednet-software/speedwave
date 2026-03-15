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

/// Resolves the path to a binary command.
///
/// Lima (macOS), nerdctl-full (Linux), and Node.js (all platforms) binaries
/// are bundled in the app resources directory. WSL2 uses system-installed nerdctl.
///
/// Resolution order:
/// 1. If `SPEEDWAVE_RESOURCES_DIR` env var is set and the binary exists at
///    `<dir>/lima/bin/<cmd>`, return that absolute path (macOS).
/// 2. If `SPEEDWAVE_RESOURCES_DIR` env var is set and the binary exists at
///    `<dir>/nerdctl-full/bin/<cmd>`, return that absolute path (Linux).
/// 3. If `SPEEDWAVE_RESOURCES_DIR` env var is set and the binary exists at
///    `<dir>/nodejs/bin/<cmd>` (Unix) or `<dir>/nodejs/<cmd>.exe` (Windows),
///    return that absolute path.
/// 4. Otherwise return the bare command name (system PATH lookup).
pub fn resolve_binary(cmd: &str) -> String {
    if let Ok(resources_dir) = std::env::var(BUNDLE_RESOURCES_ENV) {
        let resources = PathBuf::from(&resources_dir);

        // Try Lima bundle first (macOS)
        let lima_bundled = resources.join("lima").join("bin").join(cmd);
        if lima_bundled.exists() {
            return lima_bundled.to_string_lossy().to_string();
        }

        // Try nerdctl-full bundle (Linux)
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

        log::debug!(
            "bundled binary not found for '{}', falling back to system PATH",
            cmd
        );
    }
    cmd.to_string()
}

/// Windows process creation flag that prevents a visible console window from
/// being allocated for child processes. Applied to all background subprocesses
/// so that `wsl.exe`, `powershell.exe`, `node.exe`, etc. do not flash a black
/// console window over the Desktop app's UI.
///
/// **Warning:** `Command::creation_flags()` is a setter, not OR. Calling it
/// twice replaces the previous value. If you need additional flags, OR them
/// with this constant.
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Creates a `Command` for the given binary with bundled-binary resolution.
///
/// - Applies `CREATE_NO_WINDOW` on Windows to prevent console window flashing.
/// - For `limactl`, sets `LIMA_HOME` to the isolated Speedwave directory.
/// - For bundled binaries, prepends their parent directory to `PATH` so that
///   child processes (e.g. `buildctl` spawned by `nerdctl build`) can find
///   sibling binaries in the same bundle.
///
/// **Note:** `container_exec()` methods intentionally bypass this function
/// and use raw `Command::new()` because interactive TTY sessions need a
/// console window on Windows.
pub fn command(cmd: &str) -> Command {
    let resolved = resolve_binary(cmd);
    let mut command = Command::new(&resolved);

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    // If the resolved path is absolute (= bundled), prepend its parent dir to PATH
    // and set CNI_PATH for nerdctl-full bundles (CNI plugins live in libexec/cni/).
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
            // Without CNI_PATH, nerdctl defaults to /opt/cni/bin which doesn't
            // exist on systems where nerdctl-full is installed as a .deb resource.
            if let Some(bundle_root) = bin_dir.parent() {
                let cni_dir = bundle_root.join("libexec").join("cni");
                if cni_dir.is_dir() {
                    command.env("CNI_PATH", &cni_dir);
                }
            }
        }
    }

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
    #[allow(unused_mut)] // mut needed on Windows for creation_flags()
    let mut command = Command::new(program);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

/// Returns the isolated LIMA_HOME directory: `~/.speedwave/lima`.
///
/// Speedwave uses a dedicated LIMA_HOME so that its VM data does not collide
/// with a user-installed Lima (`~/.lima`).
pub fn lima_home() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(consts::DATA_DIR).join(consts::LIMA_SUBDIR))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::env;
    use std::sync::Mutex;

    /// Serialises env-var mutations across parallel test threads.
    pub(crate) static ENV_LOCK: Mutex<()> = Mutex::new(());

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
        let home = lima_home();
        assert!(home.is_some());
        let path = home.unwrap();
        let path_str = path.to_string_lossy();
        assert!(
            path_str.ends_with(".speedwave/lima"),
            "expected path ending with .speedwave/lima, got: {}",
            path_str
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
        let value_str = value.to_string_lossy();
        assert!(
            value_str.ends_with(".speedwave/lima"),
            "LIMA_HOME should end with .speedwave/lima, got: {}",
            value_str
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
}
