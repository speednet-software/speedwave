//! Tauri command: open the host's terminal application running
//! `speedwave login` for the chosen project.
//!
//! Why a system terminal? Claude Code's `/login` (the OAuth interactive flow
//! the user triggers at the TUI prompt) requires a real TTY. Tauri commands
//! have no TTY, and embedding xterm.js + node-pty would add a heavy frontend
//! dependency just to host one interactive command. Spawning the OS-native
//! terminal keeps the host invariants (no PTY in the desktop), reuses the CLI
//! TTY path that already works, and gives the user an experience identical to
//! "open Terminal and run …" but without copy-paste friction. The actual
//! OAuth flow itself happens inside Claude Code in the container — Speedwave
//! never sees or stores the token.

use crate::auth_commands::{build_auth_command_for_platform, resolve_project_dirs};
use crate::types::check_project;

/// Returns true when `s` contains any control character (`< 0x20` or DEL).
/// AppleScript `do script` interprets newlines and other control bytes — we
/// reject them to avoid command-injection-shaped surprises.
#[cfg(target_os = "macos")]
fn contains_control_chars(s: &str) -> bool {
    s.bytes().any(|b| b < 0x20 || b == 0x7f)
}

/// Escapes a string for embedding inside an AppleScript double-quoted literal.
/// Order matters: backslashes must be doubled before quotes are escaped, or a
/// pre-existing `\` would consume the leading backslash of `\"`.
#[cfg(target_os = "macos")]
pub(crate) fn escape_for_applescript(s: &str) -> anyhow::Result<String> {
    if contains_control_chars(s) {
        anyhow::bail!("control characters in AppleScript argument");
    }
    Ok(s.replace('\\', "\\\\").replace('"', "\\\""))
}

#[cfg(target_os = "macos")]
const DEFAULT_LOGIN_SHELL: &str = "/bin/zsh";

/// Whether `s` is a plain absolute path safe to use as argv[0] in iTerm2's
/// word-split `command "<str>"` — i.e. no whitespace, no shell metacharacters.
#[cfg(target_os = "macos")]
fn is_safe_shell_path(s: &str) -> bool {
    s.starts_with('/')
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'/' | b'_' | b'.' | b'-'))
}

/// Validates a candidate shell path (typically `$SHELL`), falling back to
/// `DEFAULT_LOGIN_SHELL` when it's missing or not a plain absolute path.
/// Pure — takes the candidate so it's testable without mutating the env.
#[cfg(target_os = "macos")]
fn sanitize_login_shell(candidate: Option<&str>) -> String {
    match candidate {
        Some(s) if is_safe_shell_path(s) => s.to_string(),
        Some(s) => {
            log::warn!(
                "SHELL='{s}' is not a plain absolute path; using {DEFAULT_LOGIN_SHELL} for iTerm2 spawn"
            );
            DEFAULT_LOGIN_SHELL.to_string()
        }
        None => DEFAULT_LOGIN_SHELL.to_string(),
    }
}

/// Returns a login shell to wrap the command in for iTerm2 — `$SHELL` if it is
/// a plain absolute path, otherwise `/bin/zsh` (macOS default).
#[cfg(target_os = "macos")]
fn safe_login_shell() -> String {
    sanitize_login_shell(std::env::var("SHELL").ok().as_deref())
}

/// True iff `iTerm.app` exists in any of `roots`. Pure path check — testable
/// against a tempdir without consulting the real `/Applications/`.
#[cfg(target_os = "macos")]
fn iterm2_installed_in(roots: &[&std::path::Path]) -> bool {
    roots.iter().any(|r| r.join("iTerm.app").exists())
}

/// True iff iTerm2 is installed in `/Applications/` or `~/Applications/`.
/// macOS prefers iTerm2 over Terminal.app because iTerm2 honors OSC 52 (the
/// wrapper that makes "press c to copy URL" work in the container).
#[cfg(target_os = "macos")]
fn iterm2_installed() -> bool {
    let system = std::path::PathBuf::from("/Applications");
    let user = dirs::home_dir().map(|h| h.join("Applications"));
    let mut roots: Vec<&std::path::Path> = vec![&system];
    if let Some(ref u) = user {
        roots.push(u);
    }
    iterm2_installed_in(&roots)
}

#[cfg(target_os = "macos")]
fn spawn_iterm2(cmd: &str) -> anyhow::Result<()> {
    // iTerm2's `command "..."` runs argv directly via execvp — no shell parsing.
    // `$SHELL -ilc 'cmd'` runs the user's login shell with PATH from .zshrc.
    // We do NOT chain a follow-up interactive shell — Claude is the foreground
    // process that owns the TTY for the entire session. iTerm2 closes the
    // window on shell exit per its profile setting.
    let shell = safe_login_shell();
    let inner_escaped = cmd.replace('\'', "'\\''");
    let wrapped = format!("{shell} -ilc '{inner_escaped}'");
    let escaped = escape_for_applescript(&wrapped)?;
    let script = format!(
        "tell application \"iTerm\"\n\
         \tactivate\n\
         \tcreate window with default profile command \"{escaped}\"\n\
         end tell"
    );
    let status = std::process::Command::new("osascript")
        .args(["-e", &script])
        .status()?;
    if !status.success() {
        anyhow::bail!("osascript (iTerm2) exited with status {status}");
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn spawn_apple_terminal(cmd: &str) -> anyhow::Result<()> {
    let escaped = escape_for_applescript(cmd)?;
    let script = format!(
        "tell application \"Terminal\" to do script \"{escaped}\"\n\
         tell application \"Terminal\" to activate"
    );
    let status = std::process::Command::new("osascript")
        .args(["-e", &script])
        .status()?;
    if !status.success() {
        anyhow::bail!("osascript exited with status {status}");
    }
    Ok(())
}

/// Spawns the OS-native terminal running `cmd` (macOS: iTerm2 if installed,
/// otherwise Apple Terminal — both via `osascript`). Returns once the
/// terminal has been **launched**; does not wait for `cmd` to finish.
#[cfg(target_os = "macos")]
fn open_terminal_with_command(cmd: &str) -> anyhow::Result<()> {
    if iterm2_installed() {
        match spawn_iterm2(cmd) {
            Ok(()) => return Ok(()),
            Err(iterm_err) => {
                log::warn!("iTerm2 spawn failed ({iterm_err}); falling back to Apple Terminal");
                return spawn_apple_terminal(cmd).map_err(|apple_err| {
                    anyhow::anyhow!(
                        "iTerm2 failed ({iterm_err}); Apple Terminal also failed: {apple_err}"
                    )
                });
            }
        }
    }
    spawn_apple_terminal(cmd)
}

/// Argv for `cmd.exe /c start "" <ps> -NoExit -Command <cmd>`. Empty title
/// is mandatory — `start` treats the first quoted arg as the window title.
#[cfg(any(target_os = "windows", test))]
fn build_windows_terminal_argv<'a>(ps_exe: &'a str, cmd: &'a str) -> [&'a str; 7] {
    ["/c", "start", "", ps_exe, "-NoExit", "-Command", cmd]
}

/// Spawns a new PowerShell console window running `cmd`.
/// `build_auth_command_for_platform` emits PowerShell syntax (`Set-Location`,
/// `$env:`, `;`) on Windows, so we must spawn PowerShell — not `cmd.exe`.
/// Prefers `pwsh.exe` (PowerShell 7+) when on PATH. `-NoExit` keeps the window
/// open so the user can read output and paste.
#[cfg(target_os = "windows")]
fn open_terminal_with_command(cmd: &str) -> anyhow::Result<()> {
    let ps = if crate::path_util::which_in_path("pwsh.exe").is_some() {
        "pwsh.exe"
    } else {
        "powershell.exe"
    };
    let argv = build_windows_terminal_argv(ps, cmd);
    let status = std::process::Command::new("cmd.exe").args(argv).status()?;
    if !status.success() {
        anyhow::bail!("{ps} exited with status {status}");
    }
    Ok(())
}

/// Tauri command: opens a system terminal that runs `speedwave login` for the
/// requested project. The actual OAuth flow happens inside Claude Code in the
/// container; this command only launches the terminal.
#[tauri::command]
pub async fn start_oauth_login(project: String) -> Result<(), String> {
    check_project(&project)?;
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        log::info!("start_oauth_login: project={project}");

        let (project_dir, data_dir, default_data_dir) = resolve_project_dirs(&project)?;

        // Same renderer as get_auth_command's copy-paste fallback, so the
        // auto-spawned command and the one a user could paste are identical.
        let cmd = build_auth_command_for_platform(
            &project,
            &project_dir,
            &data_dir,
            default_data_dir.as_deref(),
            cfg!(target_os = "windows"),
        );
        open_terminal_with_command(&cmd).map_err(|e| {
            log::error!("start_oauth_login: terminal spawn failed: {e}");
            e.to_string()
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    #[cfg(target_os = "macos")]
    use super::*;

    // -- Windows terminal argv (cross-platform: pure pattern) --

    #[test]
    fn windows_terminal_argv_includes_empty_title_after_start() {
        let argv = super::build_windows_terminal_argv(
            "powershell.exe",
            "Set-Location 'C:\\proj'; speedwave login --project 'p'",
        );
        // Empty title MUST be argv[2] — otherwise `start` consumes the next
        // quoted token as the window title and drops the actual command.
        assert_eq!(argv[0], "/c");
        assert_eq!(argv[1], "start");
        assert_eq!(argv[2], "", "empty title required between `start` and exe");
        assert_eq!(argv[3], "powershell.exe");
        assert_eq!(argv[4], "-NoExit");
        assert_eq!(argv[5], "-Command");
        assert!(argv[6].contains("speedwave login"));
    }

    #[test]
    fn windows_terminal_argv_passes_pwsh7_when_selected() {
        let argv = super::build_windows_terminal_argv("pwsh.exe", "echo hi");
        assert_eq!(argv[3], "pwsh.exe");
    }

    // -- escape_for_applescript (macOS only) --

    #[test]
    #[cfg(target_os = "macos")]
    fn escape_applescript_no_special_chars() {
        assert_eq!(escape_for_applescript("hello").unwrap(), "hello");
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn escape_applescript_double_quote() {
        assert_eq!(escape_for_applescript(r#"a"b"#).unwrap(), r#"a\"b"#);
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn escape_applescript_backslash() {
        // Single backslash in input becomes two in output (escaped)
        assert_eq!(escape_for_applescript(r"a\b").unwrap(), r"a\\b");
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn escape_applescript_backslash_then_quote() {
        // `\"` in input must escape both the backslash AND the quote — output
        // sees `\\\"` (4 chars). Order-of-operations matters here.
        assert_eq!(escape_for_applescript(r#"\""#).unwrap(), r#"\\\""#);
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn escape_applescript_empty() {
        assert_eq!(escape_for_applescript("").unwrap(), "");
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn escape_applescript_rejects_newline() {
        assert!(escape_for_applescript("foo\nbar").is_err());
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn escape_applescript_rejects_tab() {
        assert!(escape_for_applescript("foo\tbar").is_err());
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn escape_applescript_rejects_null() {
        assert!(escape_for_applescript("foo\0bar").is_err());
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn escape_applescript_rejects_del() {
        // DEL (0x7f) is in the rejected control-char set.
        assert!(escape_for_applescript("foo\x7fbar").is_err());
    }

    // -- sanitize_login_shell (pure; no env mutation) --

    #[test]
    #[cfg(target_os = "macos")]
    fn sanitize_shell_accepts_plain_absolute_path() {
        assert_eq!(sanitize_login_shell(Some("/bin/bash")), "/bin/bash");
        assert_eq!(
            sanitize_login_shell(Some("/usr/local/bin/fish")),
            "/usr/local/bin/fish"
        );
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn sanitize_shell_rejects_value_with_spaces() {
        assert_eq!(
            sanitize_login_shell(Some("/bin/zsh -c 'echo pwned'")),
            DEFAULT_LOGIN_SHELL
        );
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn sanitize_shell_rejects_semicolon_and_metachars() {
        assert_eq!(
            sanitize_login_shell(Some("/bin/zsh;touch /tmp/x")),
            DEFAULT_LOGIN_SHELL
        );
        assert_eq!(
            sanitize_login_shell(Some("/bin/zsh\"")),
            DEFAULT_LOGIN_SHELL
        );
        assert_eq!(
            sanitize_login_shell(Some("/bin/zsh$(id)")),
            DEFAULT_LOGIN_SHELL
        );
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn sanitize_shell_rejects_relative_path() {
        assert_eq!(sanitize_login_shell(Some("zsh")), DEFAULT_LOGIN_SHELL);
        assert_eq!(sanitize_login_shell(Some("bin/zsh")), DEFAULT_LOGIN_SHELL);
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn sanitize_shell_falls_back_when_unset() {
        assert_eq!(sanitize_login_shell(None), DEFAULT_LOGIN_SHELL);
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn sanitize_shell_rejects_empty_string() {
        assert_eq!(sanitize_login_shell(Some("")), DEFAULT_LOGIN_SHELL);
    }

    // -- iterm2_installed --

    #[test]
    #[cfg(target_os = "macos")]
    fn iterm2_installed_in_returns_true_when_system_root_has_app() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir(tmp.path().join("iTerm.app")).unwrap();
        assert!(super::iterm2_installed_in(&[tmp.path()]));
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn iterm2_installed_in_returns_true_when_user_root_has_app() {
        let system_root = tempfile::tempdir().unwrap();
        let user_root = tempfile::tempdir().unwrap();
        std::fs::create_dir(user_root.path().join("iTerm.app")).unwrap();
        // System root empty; user root has the app — must still detect.
        assert!(super::iterm2_installed_in(&[
            system_root.path(),
            user_root.path()
        ]));
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn iterm2_installed_in_returns_false_when_no_root_has_app() {
        let r1 = tempfile::tempdir().unwrap();
        let r2 = tempfile::tempdir().unwrap();
        assert!(!super::iterm2_installed_in(&[r1.path(), r2.path()]));
    }
}
