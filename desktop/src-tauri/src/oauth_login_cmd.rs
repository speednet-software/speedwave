//! Tauri command: open the host's terminal application running
//! `speedwave login` for the chosen project.
//!
//! Why a system terminal? `claude setup-token` (the OAuth interactive flow we
//! delegate to inside the container) requires a real TTY. Tauri commands have
//! no TTY, and embedding xterm.js + node-pty would add a heavy frontend
//! dependency just to host one interactive command. Spawning the OS-native
//! terminal keeps the host invariants (no PTY in the desktop), reuses the CLI
//! TTY path that already works, and gives the user an experience identical to
//! "open Terminal and run …" but without copy-paste friction.

use crate::auth_commands::build_auth_command_for_platform;
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

/// Delegates to `auth_commands::build_auth_command_for_platform` — the two
/// surfaces (`get_auth_command` for copy-paste, `start_oauth_login` for
/// auto-spawn) must produce identical strings, so we share one renderer.
pub(crate) fn build_login_command_str(
    project: &str,
    project_dir: &str,
    data_dir: &std::path::Path,
    default_data_dir: Option<&std::path::Path>,
    is_windows: bool,
) -> String {
    build_auth_command_for_platform(project, project_dir, data_dir, default_data_dir, is_windows)
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
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
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
        if let Err(e) = spawn_iterm2(cmd) {
            log::warn!("iTerm2 spawn failed ({e}); falling back to Apple Terminal");
            return spawn_apple_terminal(cmd);
        }
        return Ok(());
    }
    spawn_apple_terminal(cmd)
}

/// Spawns a new PowerShell console window running `cmd`. `build_login_command_str`
/// emits PowerShell syntax (`Set-Location`, `$env:`, `;`), so we must spawn
/// PowerShell — not `cmd.exe`. Prefers `pwsh.exe` (PowerShell 7+) when on PATH.
/// `-NoExit` keeps the window open so the user can read output and paste.
#[cfg(target_os = "windows")]
fn open_terminal_with_command(cmd: &str) -> anyhow::Result<()> {
    let ps = if which_in_path("pwsh.exe") {
        "pwsh.exe"
    } else {
        "powershell.exe"
    };
    let status = std::process::Command::new("cmd.exe")
        .args(["/c", "start", ps, "-NoExit", "-Command", cmd])
        .status()?;
    if !status.success() {
        anyhow::bail!("{ps} exited with status {status}");
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn which_in_path(bin: &str) -> bool {
    std::env::var_os("PATH")
        .and_then(|p| {
            std::env::split_paths(&p)
                .find(|d| d.join(bin).is_file())
                .map(|_| ())
        })
        .is_some()
}

/// Spawns a Linux terminal running `cmd`. Tries gnome-terminal, konsole, then
/// xterm in order. After `cmd` completes the user sees a clear success/failure
/// line, then drops to an interactive shell so they can keep working or close
/// the window manually.
#[cfg(all(unix, not(target_os = "macos")))]
fn open_terminal_with_command(cmd: &str) -> anyhow::Result<()> {
    let inner = format!("{cmd} && echo 'Login completed.' || echo 'Login failed.'; exec bash");

    // gnome-terminal: -- means "the rest is the command"
    let r = std::process::Command::new("gnome-terminal")
        .args(["--", "bash", "-c", &inner])
        .status();
    if matches!(r, Ok(s) if s.success()) {
        return Ok(());
    }

    // konsole: -e accepts a command-string after argv[0]
    let r = std::process::Command::new("konsole")
        .args(["-e", "bash", "-c", &inner])
        .status();
    if matches!(r, Ok(s) if s.success()) {
        return Ok(());
    }

    // xterm fallback
    let r = std::process::Command::new("xterm")
        .args(["-e", "bash", "-c", &inner])
        .status();
    if matches!(r, Ok(s) if s.success()) {
        return Ok(());
    }

    anyhow::bail!(
        "no supported terminal found (tried gnome-terminal, konsole, xterm). \
         Open a terminal manually and run: {cmd}"
    );
}

/// Tauri command: opens a system terminal that runs `speedwave login` for the
/// requested project. The actual OAuth flow happens inside Claude Code in the
/// container; this command only launches the terminal.
#[tauri::command]
pub async fn start_oauth_login(project: String) -> Result<(), String> {
    check_project(&project)?;
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        log::info!("start_oauth_login: project={project}");

        let user_config = speedwave_runtime::config::load_user_config()
            .map_err(|e| format!("Failed to load config: {e}"))?;
        let project_dir = user_config
            .find_project(&project)
            .map(|p| p.dir.clone())
            .ok_or_else(|| format!("project '{}' not found in config", project))?;

        let data_dir = speedwave_runtime::consts::data_dir();
        let default_data_dir =
            dirs::home_dir().map(|h| h.join(speedwave_runtime::consts::DATA_DIR));

        let cmd = build_login_command_str(
            &project,
            &project_dir,
            data_dir,
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
    use super::*;
    use std::path::Path;

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

    // -- build_login_command_str: delegation sanity (full coverage in auth_commands tests) --

    #[test]
    fn build_login_command_str_delegates_to_build_auth_command_for_platform() {
        let cmd = build_login_command_str(
            "foo",
            "/proj",
            Path::new("/data"),
            Some(Path::new("/data")),
            false,
        );
        assert_eq!(cmd, "cd '/proj' && speedwave login --project 'foo'");
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
