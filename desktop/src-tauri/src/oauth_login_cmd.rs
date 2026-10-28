//! Tauri command: open the host's terminal running `speedwave login` for the chosen
//! project. OAuth happens in the container; Speedwave never sees or stores the token.
//! macOS opens a `.command` script through LaunchServices; Windows runs PowerShell directly.

use crate::auth_commands::{
    build_auth_command_for_platform, ensure_cli_installed, resolve_project_dirs, CliInvocation,
};
use crate::types::check_project;
use std::path::Path;
#[cfg(any(target_os = "macos", test))]
use std::path::PathBuf;

#[cfg(any(target_os = "macos", test))]
const TERMINAL_SCRIPT_DIR: &str = "terminal";
#[cfg(any(target_os = "macos", test))]
const TERMINAL_SCRIPT_EXTENSION: &str = "command";
#[cfg(target_os = "macos")]
const OPEN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// Body of the `.command` script: runs `cmd`, then leaves the user in a login shell.
#[cfg(any(target_os = "macos", test))]
fn build_terminal_script(cmd: &str) -> String {
    format!("#!/bin/sh\n{cmd}\nexec \"${{SHELL:-/bin/zsh}}\" -l\n")
}

#[cfg(any(target_os = "macos", test))]
fn terminal_script_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(TERMINAL_SCRIPT_DIR)
}

/// `<data_dir>/terminal/<login|run>-<project>.command`.
#[cfg(any(target_os = "macos", test))]
fn terminal_script_path(data_dir: &Path, invocation: CliInvocation, project: &str) -> PathBuf {
    let purpose = match invocation {
        CliInvocation::Login => "login",
        CliInvocation::Run => "run",
    };
    terminal_script_dir(data_dir).join(format!("{purpose}-{project}.{TERMINAL_SCRIPT_EXTENSION}"))
}

/// Maps the outcome of `open <script>` to a user-readable error carrying its stderr.
#[cfg(any(target_os = "macos", test))]
fn check_open_result(success: bool, stderr: &[u8]) -> anyhow::Result<()> {
    if success {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(stderr);
    let stderr = stderr.trim();
    if stderr.is_empty() {
        anyhow::bail!("could not open the terminal: open exited with a failure status");
    }
    anyhow::bail!("could not open the terminal: {stderr}");
}

#[cfg(target_os = "macos")]
fn write_terminal_script(
    data_dir: &Path,
    invocation: CliInvocation,
    project: &str,
    cmd: &str,
) -> anyhow::Result<PathBuf> {
    use std::os::unix::fs::PermissionsExt;

    speedwave_runtime::fs_perms::ensure_owner_only_dir(&terminal_script_dir(data_dir))?;
    let path = terminal_script_path(data_dir, invocation, project);
    speedwave_runtime::fs_perms::write_restricted_file_atomic(&path, &build_terminal_script(cmd))?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))?;
    Ok(path)
}

/// Opens Terminal (the default `.command` handler) on a script that runs `cmd`, via `open`.
/// Returns once **launched**; does not wait for `cmd`.
#[cfg(target_os = "macos")]
pub(crate) fn open_terminal_with_command(
    invocation: CliInvocation,
    project: &str,
    data_dir: &Path,
    cmd: &str,
) -> anyhow::Result<()> {
    let path = write_terminal_script(data_dir, invocation, project, cmd)?;
    let output = speedwave_runtime::binary::run_with_timeout_capture(
        speedwave_runtime::binary::system_command("open").arg(&path),
        OPEN_TIMEOUT,
    )?;
    check_open_result(output.status.success(), &output.stderr)
}

/// Encodes a PowerShell command for `-EncodedCommand`: UTF-16LE then base64.
#[cfg(any(target_os = "windows", test))]
fn encode_powershell_command(cmd: &str) -> String {
    let utf16le: Vec<u8> = cmd.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    base64_standard(&utf16le)
}

/// Minimal RFC 4648 base64 (standard alphabet, `=` padding). Inlined to avoid
/// pulling a crate for the single `-EncodedCommand` call site.
#[cfg(any(target_os = "windows", test))]
fn base64_standard(input: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[((n >> 18) & 0x3f) as usize] as char);
        out.push(ALPHABET[((n >> 12) & 0x3f) as usize] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[((n >> 6) & 0x3f) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[(n & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    out
}

/// Argv for launching the login terminal via Windows Terminal:
/// `wt.exe new-tab <ps> -NoExit -EncodedCommand <b64>` (ADR-052).
#[cfg(any(target_os = "windows", test))]
fn build_wt_terminal_argv(ps_exe: &str, cmd: &str) -> [String; 5] {
    [
        "new-tab".to_string(),
        ps_exe.to_string(),
        "-NoExit".to_string(),
        "-EncodedCommand".to_string(),
        encode_powershell_command(cmd),
    ]
}

/// Argv for launching PowerShell directly:
/// `<ps> -NoExit -EncodedCommand <b64>`. Fallback when wt.exe is unavailable.
#[cfg(any(target_os = "windows", test))]
fn build_powershell_argv(cmd: &str) -> [String; 3] {
    [
        "-NoExit".to_string(),
        "-EncodedCommand".to_string(),
        encode_powershell_command(cmd),
    ]
}

/// Spawns a new terminal window running `cmd` (PowerShell syntax). Prefers `pwsh.exe` then
/// `powershell.exe`, Windows Terminal then direct spawn. `-NoExit` keeps the window open.
#[cfg(target_os = "windows")]
pub(crate) fn open_terminal_with_command(
    _invocation: CliInvocation,
    _project: &str,
    _data_dir: &Path,
    cmd: &str,
) -> anyhow::Result<()> {
    let ps = if crate::path_util::which_in_path("pwsh.exe").is_some() {
        "pwsh.exe"
    } else {
        "powershell.exe"
    };

    let argv = build_wt_terminal_argv(ps, cmd);
    match speedwave_runtime::binary::interactive_command("wt.exe")
        .args(argv)
        .status()
    {
        Ok(s) if s.success() => return Ok(()),
        Ok(s) => log::warn!("wt.exe exited {s}; falling back to direct PowerShell"),
        Err(e) => log::warn!("wt.exe not available ({e}); falling back to direct PowerShell"),
    }

    let argv = build_powershell_argv(cmd);
    speedwave_runtime::binary::interactive_command(ps)
        .args(argv)
        .spawn()?;
    Ok(())
}

/// Tauri command: opens a system terminal that runs `speedwave login` for the requested
/// project. OAuth happens inside Claude Code in the container; this only launches the terminal.
#[tauri::command]
pub async fn start_oauth_login(project: String) -> Result<(), String> {
    check_project(&project)?;
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        log::info!("starting OAuth login terminal for project {project}");

        let (project_dir, home, data_dir) = resolve_project_dirs(&project)?;
        ensure_cli_installed()?;

        let cmd = build_auth_command_for_platform(
            &project,
            &project_dir,
            &home,
            &data_dir,
            cfg!(target_os = "windows"),
        );
        open_terminal_with_command(CliInvocation::Login, &project, &data_dir, &cmd).map_err(|e| {
            log::error!("failed to spawn OAuth login terminal: {e}");
            e.to_string()
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
#[cfg_attr(
    target_os = "macos",
    expect(
        clippy::unwrap_used,
        reason = "the macOS-only script write test unwraps results"
    )
)]
#[expect(
    clippy::expect_used,
    reason = "unwrap/expect are fine in test assertions"
)]
mod tests {
    use super::*;
    use crate::auth_commands::build_project_cli_command_for_platform;

    fn base64_decode(s: &str) -> Vec<u8> {
        fn val(c: u8) -> u32 {
            match c {
                b'A'..=b'Z' => (c - b'A') as u32,
                b'a'..=b'z' => (c - b'a' + 26) as u32,
                b'0'..=b'9' => (c - b'0' + 52) as u32,
                b'+' => 62,
                b'/' => 63,
                _ => panic!("invalid base64 char {c}"),
            }
        }
        let symbols: Vec<u8> = s.bytes().filter(|b| *b != b'=').collect();
        let mut out = Vec::new();
        for chunk in symbols.chunks(4) {
            let mut n = 0u32;
            for &c in chunk {
                n = (n << 6) | val(c);
            }
            n <<= 6 * (4 - chunk.len());
            for i in 0..(chunk.len() - 1) {
                out.push(((n >> (16 - 8 * i)) & 0xff) as u8);
            }
        }
        out
    }

    fn decode_ps_encoded(b64: &str) -> String {
        let bytes = base64_decode(b64);
        let u16s: Vec<u16> = bytes
            .chunks(2)
            .map(|c| u16::from_le_bytes([c[0], *c.get(1).unwrap_or(&0)]))
            .collect();
        String::from_utf16(&u16s).expect("valid utf16")
    }

    #[test]
    fn wt_terminal_argv_opens_tab_with_encoded_command() {
        let cmd = "Set-Location 'C:\\proj'; speedwave login --project 'p'";
        let argv = super::build_wt_terminal_argv("powershell.exe", cmd);
        assert_eq!(argv[0], "new-tab");
        assert_eq!(argv[1], "powershell.exe");
        assert_eq!(argv[2], "-NoExit");
        assert_eq!(argv[3], "-EncodedCommand");
        assert!(!argv[4].contains(';'));
        assert!(!argv[4].contains(' '));
        assert_eq!(decode_ps_encoded(&argv[4]), cmd);
    }

    #[test]
    fn powershell_argv_is_direct_encoded_no_start_wrapper() {
        let argv = super::build_powershell_argv("echo hi");
        assert_eq!(argv[0], "-NoExit");
        assert_eq!(argv[1], "-EncodedCommand");
        assert_eq!(decode_ps_encoded(&argv[2]), "echo hi");
    }

    #[test]
    fn wt_terminal_argv_passes_pwsh7_when_selected() {
        let argv = super::build_wt_terminal_argv("pwsh.exe", "echo hi");
        assert_eq!(argv[1], "pwsh.exe");
    }

    #[test]
    fn encode_powershell_command_is_utf16le_base64() {
        assert_eq!(super::encode_powershell_command("A"), "QQA=");
        assert_eq!(super::encode_powershell_command(""), "");
        let cmd = "Set-Location 'C:\\x'; speedwave login --project 'p'";
        assert_eq!(
            decode_ps_encoded(&super::encode_powershell_command(cmd)),
            cmd
        );
    }

    fn unix_command(invocation: CliInvocation, project_dir: &str) -> String {
        build_project_cli_command_for_platform(
            invocation,
            "myproj",
            project_dir,
            Path::new("/home/u"),
            Path::new("/home/u/.speedwave"),
            false,
        )
    }

    #[test]
    fn terminal_script_runs_the_command_then_a_login_shell() {
        for (invocation, project_dir) in [
            (CliInvocation::Run, "/work/proj"),
            (CliInvocation::Login, "/work/proj"),
            (CliInvocation::Run, "/work/o'brien"),
        ] {
            let cmd = unix_command(invocation, project_dir);
            let body = build_terminal_script(&cmd);
            let lines: Vec<&str> = body.lines().collect();
            assert_eq!(lines.len(), 3);
            assert_eq!(lines[0], "#!/bin/sh");
            assert_eq!(lines[1], cmd);
            assert_eq!(lines[2], "exec \"${SHELL:-/bin/zsh}\" -l");
            assert!(body.ends_with('\n'));
        }
    }

    #[test]
    fn terminal_script_path_is_per_purpose_and_project() {
        let data_dir = Path::new("/data");
        assert_eq!(
            terminal_script_path(data_dir, CliInvocation::Run, "myproj"),
            data_dir.join("terminal").join("run-myproj.command")
        );
        assert_eq!(
            terminal_script_path(data_dir, CliInvocation::Login, "myproj"),
            data_dir.join("terminal").join("login-myproj.command")
        );
    }

    #[test]
    fn open_result_is_ok_on_success() {
        assert!(check_open_result(true, b"").is_ok());
    }

    #[test]
    fn open_result_carries_trimmed_stderr_on_failure() {
        let err = check_open_result(false, b"LSOpenURLsWithRole() failed with error -10810\n")
            .expect_err("a failed open must be an error");
        assert_eq!(
            err.to_string(),
            "could not open the terminal: LSOpenURLsWithRole() failed with error -10810"
        );
    }

    #[test]
    fn open_result_names_the_failure_when_stderr_is_empty() {
        let err = check_open_result(false, b"  \n").expect_err("a failed open must be an error");
        assert!(err.to_string().starts_with("could not open the terminal: "));
        assert!(err.to_string().contains("failure status"));
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn write_terminal_script_is_owner_only_executable_and_replaced_on_rewrite() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().unwrap();
        let path =
            write_terminal_script(tmp.path(), CliInvocation::Run, "myproj", "echo one").unwrap();
        assert_eq!(path, tmp.path().join("terminal").join("run-myproj.command"));
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            build_terminal_script("echo one")
        );
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o700);
        let dir_mode = std::fs::metadata(tmp.path().join("terminal"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(dir_mode & 0o777, 0o700);

        let again =
            write_terminal_script(tmp.path(), CliInvocation::Run, "myproj", "echo two").unwrap();
        assert_eq!(again, path);
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            build_terminal_script("echo two")
        );
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }
}
