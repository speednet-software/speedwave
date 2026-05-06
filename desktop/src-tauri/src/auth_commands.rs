// Auth commands — extracted from main.rs
//
// Tauri command wrappers for API-key management and CLI auth command generation.

use crate::types::{check_project, AuthStatusResponse};

use super::{auth, setup_wizard};

// ---------------------------------------------------------------------------
// Authentication commands (API key only — OAuth is done via CLI)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn save_api_key(project: String, api_key: String) -> Result<(), String> {
    check_project(&project)?;
    if api_key.len() > crate::types::MAX_CREDENTIAL_BYTES {
        return Err("API key too long".to_string());
    }
    tokio::task::spawn_blocking(move || {
        log::info!("save_api_key: project={project}");
        auth::save_api_key(&project, &api_key).map_err(|e| {
            log::error!("save_api_key: error: {e}");
            e.to_string()
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn delete_api_key(project: String) -> Result<(), String> {
    check_project(&project)?;
    tokio::task::spawn_blocking(move || {
        log::info!("delete_api_key: project={project}");
        auth::delete_api_key(&project).map_err(|e| {
            log::error!("delete_api_key: error: {e}");
            e.to_string()
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_auth_status(project: String) -> Result<AuthStatusResponse, String> {
    check_project(&project)?;
    tokio::task::spawn_blocking(move || {
        log::info!("get_auth_status: project={project}");
        let api_key_configured = auth::has_api_key(&project);
        let oauth_authenticated = setup_wizard::check_claude_auth(&project).unwrap_or(false);
        Ok(AuthStatusResponse {
            api_key_configured,
            oauth_authenticated,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// CLI auth command generation
// ---------------------------------------------------------------------------

/// Shell-escape a string for use inside single quotes (POSIX standard).
/// Each embedded single-quote becomes: close-quote, backslash-escaped quote, open-quote.
pub(crate) fn shell_escape_single_quoted(s: &str) -> String {
    s.replace('\'', "'\\''")
}

/// Strips the `\\?\` extended-length prefix from a Windows path when the
/// remainder begins with `<drive>:\` or `<drive>:/` (`\\?\C:\…` -> `C:\…`).
/// Returns the input unchanged for paths that don't match `\\?\<drive>:\`
/// (UNC paths, already-stripped paths, POSIX paths, anything else). The
/// function is purely pattern-based on the input string and does not inspect
/// the host OS. Bare `\\?\C:` (no separator) is intentionally left alone —
/// `Set-Location 'C:'` would set drive-relative cwd, which is not what the
/// user copied a project path for; passing the original string through means
/// PowerShell raises a clear "path not found" error rather than silently
/// changing drive.
///
/// The Tauri folder picker on Windows can return canonicalized paths with
/// the `\\?\` prefix; neither PowerShell `Set-Location` nor `cd` handles
/// these, and they are not user-readable. This helper unifies the path so
/// the rendered command is paste-ready.
pub(crate) fn strip_windows_extended_length_prefix(path: &str) -> &str {
    let b = path.as_bytes();
    if b.len() >= 7
        && b[0] == b'\\'
        && b[1] == b'\\'
        && b[2] == b'?'
        && b[3] == b'\\'
        && b[4].is_ascii_alphabetic()
        && b[5] == b':'
        && (b[6] == b'\\' || b[6] == b'/')
    {
        &path[4..]
    } else {
        path
    }
}

/// Escapes a string for safe interpolation inside a PowerShell single-quoted
/// literal. PowerShell single-quote literals are literal — only embedded
/// single quotes need doubling.
pub(crate) fn ps_escape_single_quoted(s: &str) -> String {
    s.replace('\'', "''")
}

/// Pure, host-platform-agnostic command assembly. The `is_windows` flag
/// selects PowerShell-shaped output (Set-Location, `;`, $env:, '' escape,
/// \\?\ prefix stripping) versus POSIX-shaped output (cd, &&, export,
/// '\'' escape). The flag is taken as a parameter — not derived inside the
/// function from `cfg!()` — so both branches are reachable from unit tests
/// on any host, including macOS/Linux where `make test-desktop` runs.
///
/// The trailing command is `speedwave login --project '<project>'` — once
/// stored, the OAuth token is per-project, so the exact name is bound into
/// the copy-paste so it works regardless of CWD.
pub(crate) fn build_auth_command_for_platform(
    project: &str,
    project_dir: &str,
    data_dir: &std::path::Path,
    default_data_dir: Option<&std::path::Path>,
    is_windows: bool,
) -> String {
    let needs_env_pin = default_data_dir.map(|d| d != data_dir).unwrap_or(false);
    let data_dir_str = data_dir.to_string_lossy();

    if is_windows {
        let pdir = strip_windows_extended_length_prefix(project_dir);
        let ddir = strip_windows_extended_length_prefix(&data_dir_str);
        if needs_env_pin {
            format!(
                "$env:{} = '{}'; Set-Location '{}'; speedwave login --project '{}'",
                speedwave_runtime::consts::DATA_DIR_ENV,
                ps_escape_single_quoted(ddir),
                ps_escape_single_quoted(pdir),
                ps_escape_single_quoted(project),
            )
        } else {
            format!(
                "Set-Location '{}'; speedwave login --project '{}'",
                ps_escape_single_quoted(pdir),
                ps_escape_single_quoted(project),
            )
        }
    } else if needs_env_pin {
        format!(
            "export {}='{}' && cd '{}' && speedwave login --project '{}'",
            speedwave_runtime::consts::DATA_DIR_ENV,
            shell_escape_single_quoted(&data_dir_str),
            shell_escape_single_quoted(project_dir),
            shell_escape_single_quoted(project),
        )
    } else {
        format!(
            "cd '{}' && speedwave login --project '{}'",
            shell_escape_single_quoted(project_dir),
            shell_escape_single_quoted(project),
        )
    }
}

/// Production entry point. Reads the host platform once via `cfg!()` and
/// delegates to `build_auth_command_for_platform`. Keeping this wrapper
/// preserves the existing call-site in `get_auth_command` unchanged.
fn build_auth_command(
    project: &str,
    project_dir: &str,
    data_dir: &std::path::Path,
    default_data_dir: Option<&std::path::Path>,
) -> String {
    build_auth_command_for_platform(
        project,
        project_dir,
        data_dir,
        default_data_dir,
        cfg!(target_os = "windows"),
    )
}

/// Returns a CLI command string for the user to copy into their terminal
/// to authenticate with Claude Code.
///
/// When the Desktop app's data directory differs from the default
/// (`~/.speedwave`), the command includes a data-directory prefix:
/// `export SPEEDWAVE_DATA_DIR=...` on POSIX shells, or
/// `$env:SPEEDWAVE_DATA_DIR = '...'` on Windows PowerShell.
#[tauri::command]
pub async fn get_auth_command(project: String) -> Result<String, String> {
    check_project(&project)?;
    tokio::task::spawn_blocking(move || {
        log::info!("get_auth_command: project={project}");

        let user_config = speedwave_runtime::config::load_user_config()
            .map_err(|e| format!("Failed to load config: {e}"))?;
        let project_dir = user_config
            .find_project(&project)
            .map(|p| p.dir.clone())
            .ok_or_else(|| format!("project '{}' not found in config", project))?;

        let data_dir = speedwave_runtime::consts::data_dir();
        let default_data_dir =
            dirs::home_dir().map(|h| h.join(speedwave_runtime::consts::DATA_DIR));

        Ok(build_auth_command(
            &project,
            &project_dir,
            data_dir,
            default_data_dir.as_deref(),
        ))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    // -- shell_escape_single_quoted tests --

    #[test]
    fn shell_escape_no_quotes() {
        assert_eq!(shell_escape_single_quoted("hello"), "hello");
    }

    #[test]
    fn shell_escape_with_single_quote() {
        assert_eq!(shell_escape_single_quoted("it's"), "it'\\''s");
    }

    #[test]
    fn shell_escape_multiple_quotes() {
        assert_eq!(shell_escape_single_quoted("a'b'c"), "a'\\''b'\\''c");
    }

    #[test]
    fn shell_escape_empty_string() {
        assert_eq!(shell_escape_single_quoted(""), "");
    }

    // -- build_auth_command tests --

    #[test]
    fn build_auth_command_default_data_dir() {
        let cmd = build_auth_command(
            "myproj",
            "/Users/test/Projects",
            std::path::Path::new("/Users/test/.speedwave"),
            Some(std::path::Path::new("/Users/test/.speedwave")),
        );
        assert_eq!(
            cmd,
            "cd '/Users/test/Projects' && speedwave login --project 'myproj'"
        );
        assert!(!cmd.contains("export"));
    }

    #[test]
    fn build_auth_command_custom_data_dir() {
        let cmd = build_auth_command(
            "myproj",
            "/Users/test/Projects",
            std::path::Path::new("/Users/test/.speedwave-dev"),
            Some(std::path::Path::new("/Users/test/.speedwave")),
        );
        assert!(cmd.starts_with(&format!(
            "export {}=",
            speedwave_runtime::consts::DATA_DIR_ENV
        )));
        assert!(cmd.contains("/Users/test/.speedwave-dev"));
        assert!(cmd.contains("cd '/Users/test/Projects'"));
        assert!(cmd.ends_with("speedwave login --project 'myproj'"));
    }

    #[test]
    fn build_auth_command_custom_data_dir_quotes_value() {
        let cmd = build_auth_command(
            "p",
            "/proj",
            std::path::Path::new("/Users/test/.speedwave-dev"),
            Some(std::path::Path::new("/Users/test/.speedwave")),
        );
        assert!(cmd.contains("='/Users/test/.speedwave-dev'"));
    }

    #[test]
    fn build_auth_command_no_default_data_dir() {
        let cmd = build_auth_command(
            "p",
            "/projects",
            std::path::Path::new("/data/.speedwave"),
            None,
        );
        assert_eq!(cmd, "cd '/projects' && speedwave login --project 'p'");
    }

    #[test]
    fn build_auth_command_quotes_paths_with_spaces() {
        let cmd = build_auth_command(
            "p",
            "/Users/John Smith/My Projects",
            std::path::Path::new("/Users/John Smith/.speedwave"),
            Some(std::path::Path::new("/Users/John Smith/.speedwave")),
        );
        assert!(cmd.contains("cd '/Users/John Smith/My Projects'"));
    }

    #[test]
    fn build_auth_command_escapes_single_quotes_in_project_dir() {
        let cmd = build_auth_command(
            "p",
            "/Users/O'Brien/project",
            std::path::Path::new("/Users/O'Brien/.speedwave"),
            Some(std::path::Path::new("/Users/O'Brien/.speedwave")),
        );
        assert!(cmd.contains("O'\\''Brien"));
        assert!(cmd.contains("cd '"));
        assert!(cmd.ends_with("speedwave login --project 'p'"));
    }

    #[test]
    fn build_auth_command_escapes_single_quotes_in_data_dir() {
        let cmd = build_auth_command(
            "p",
            "/projects",
            std::path::Path::new("/Users/O'Brien/.speedwave-dev"),
            Some(std::path::Path::new("/Users/O'Brien/.speedwave")),
        );
        assert!(cmd.contains("export"));
        assert!(cmd.contains("O'\\''Brien"));
    }

    #[test]
    fn build_auth_command_quotes_paths_with_special_chars() {
        let cmd = build_auth_command(
            "p",
            "/Users/test/proj&ect",
            std::path::Path::new("/Users/test/.speedwave"),
            Some(std::path::Path::new("/Users/test/.speedwave")),
        );
        assert!(cmd.contains("cd '/Users/test/proj&ect'"));
    }

    #[test]
    fn build_auth_command_unicode_paths() {
        let cmd = build_auth_command(
            "p",
            "/Users/tëst/プロジェクト",
            std::path::Path::new("/Users/tëst/.speedwave"),
            Some(std::path::Path::new("/Users/tëst/.speedwave")),
        );
        assert!(cmd.contains("プロジェクト"));
    }

    #[test]
    fn build_auth_command_trailing_slash_does_not_cause_mismatch() {
        // Rust's Path normalizes trailing slashes: Path("/a/") == Path("/a")
        let cmd = build_auth_command(
            "p",
            "/projects",
            std::path::Path::new("/Users/test/.speedwave/"),
            Some(std::path::Path::new("/Users/test/.speedwave")),
        );
        assert!(
            !cmd.contains("export"),
            "trailing slash should not trigger export prefix (Path normalizes)"
        );
        assert_eq!(cmd, "cd '/projects' && speedwave login --project 'p'");
    }

    #[test]
    fn build_auth_command_ordering() {
        let cmd = build_auth_command(
            "p",
            "/proj",
            std::path::Path::new("/data-dev"),
            Some(std::path::Path::new("/data")),
        );
        let export_pos = cmd.find("export").unwrap();
        let cd_pos = cmd.find("cd ").unwrap();
        let sw_pos = cmd.find("speedwave").unwrap();
        assert!(export_pos < cd_pos);
        assert!(cd_pos < sw_pos);
    }

    #[test]
    fn build_auth_command_empty_project_dir() {
        let cmd = build_auth_command(
            "p",
            "",
            std::path::Path::new("/data"),
            Some(std::path::Path::new("/data")),
        );
        assert_eq!(cmd, "cd '' && speedwave login --project 'p'");
    }

    #[test]
    fn build_auth_command_includes_project_in_login_argument() {
        // Sanity check: the project name actually flows into the trailing
        // `--project '<name>'`. Catches a future bug where the call-site in
        // get_auth_command forgets to thread `project` through.
        let cmd = build_auth_command(
            "specific-project-name",
            "/proj",
            std::path::Path::new("/data"),
            Some(std::path::Path::new("/data")),
        );
        assert!(cmd.contains("--project 'specific-project-name'"));
    }

    #[test]
    fn build_auth_command_escapes_single_quote_in_project_name() {
        // Defensive: validate_project_name forbids `'`, but the renderer
        // must defensively escape — otherwise relaxing validation later
        // would silently break the output.
        let cmd = build_auth_command(
            "weird'name",
            "/proj",
            std::path::Path::new("/data"),
            Some(std::path::Path::new("/data")),
        );
        assert!(cmd.contains("--project 'weird'\\''name'"));
    }

    // -- strip_windows_extended_length_prefix tests --
    // build_auth_command_for_platform is infallible by design — every input is a valid
    // PathBuf or &str chosen by the user. No error-path or state-transition tests apply
    // to pure functions.

    #[test]
    fn strip_prefix_uppercase_drive() {
        assert_eq!(
            strip_windows_extended_length_prefix(r"\\?\C:\Users\dev"),
            r"C:\Users\dev"
        );
    }

    #[test]
    fn strip_prefix_lowercase_drive() {
        assert_eq!(
            strip_windows_extended_length_prefix(r"\\?\d:\temp\proj"),
            r"d:\temp\proj"
        );
    }

    #[test]
    fn strip_prefix_forward_slash_separator() {
        assert_eq!(
            strip_windows_extended_length_prefix(r"\\?\C:/Users/dev"),
            r"C:/Users/dev"
        );
    }

    #[test]
    fn strip_prefix_already_stripped() {
        assert_eq!(
            strip_windows_extended_length_prefix(r"C:\Users\dev"),
            r"C:\Users\dev"
        );
    }

    #[test]
    fn strip_prefix_unc_path() {
        assert_eq!(
            strip_windows_extended_length_prefix(r"\\server\share"),
            r"\\server\share"
        );
    }

    #[test]
    fn strip_prefix_unc_extended_length() {
        assert_eq!(
            strip_windows_extended_length_prefix(r"\\?\UNC\server\share"),
            r"\\?\UNC\server\share"
        );
    }

    #[test]
    fn strip_prefix_posix_path() {
        assert_eq!(
            strip_windows_extended_length_prefix("/Users/dev"),
            "/Users/dev"
        );
    }

    #[test]
    fn strip_prefix_empty_string() {
        assert_eq!(strip_windows_extended_length_prefix(""), "");
    }

    #[test]
    fn strip_prefix_too_short() {
        assert_eq!(strip_windows_extended_length_prefix(r"\\?\"), r"\\?\");
    }

    #[test]
    fn strip_prefix_bare_drive_no_separator() {
        // \\?\C: is six bytes — must NOT strip (would yield "C:" which is drive-relative)
        assert_eq!(strip_windows_extended_length_prefix(r"\\?\C:"), r"\\?\C:");
    }

    #[test]
    fn strip_prefix_unicode_no_crash() {
        let s = "プロジェクト";
        assert_eq!(strip_windows_extended_length_prefix(s), s);
    }

    // -- ps_escape_single_quoted tests --

    #[test]
    fn ps_escape_no_quotes() {
        assert_eq!(ps_escape_single_quoted("hello"), "hello");
    }

    #[test]
    fn ps_escape_single_quote() {
        assert_eq!(ps_escape_single_quoted("it's"), "it''s");
    }

    #[test]
    fn ps_escape_multiple_quotes() {
        assert_eq!(ps_escape_single_quoted("a'b'c"), "a''b''c");
    }

    #[test]
    fn ps_escape_empty_string() {
        assert_eq!(ps_escape_single_quoted(""), "");
    }

    #[test]
    fn ps_escape_unicode_preserved() {
        assert_eq!(ps_escape_single_quoted("プロジェクト"), "プロジェクト");
    }

    // -- build_auth_command_for_platform Windows branch tests --

    #[test]
    fn build_auth_command_for_platform_windows_default_data_dir() {
        let cmd = build_auth_command_for_platform(
            "myproj",
            r"C:\Users\test\Projects",
            std::path::Path::new(r"C:\Users\test\.speedwave"),
            Some(std::path::Path::new(r"C:\Users\test\.speedwave")),
            true,
        );
        assert_eq!(
            cmd,
            r"Set-Location 'C:\Users\test\Projects'; speedwave login --project 'myproj'"
        );
        assert!(!cmd.contains("&&"));
        assert!(!cmd.contains("export"));
        assert!(!cmd.starts_with("cd "));
    }

    #[test]
    fn build_auth_command_for_platform_windows_custom_data_dir() {
        let cmd = build_auth_command_for_platform(
            "myproj",
            r"C:\Users\test\Projects",
            std::path::Path::new(r"C:\Users\test\.speedwave-dev"),
            Some(std::path::Path::new(r"C:\Users\test\.speedwave")),
            true,
        );
        assert!(cmd.starts_with(&format!(
            "$env:{} = '",
            speedwave_runtime::consts::DATA_DIR_ENV
        )));
        let env_pos = cmd.find("$env:").unwrap();
        let loc_pos = cmd.find("Set-Location").unwrap();
        // Find "; speedwave" to avoid matching "SPEEDWAVE_DATA_DIR"
        let sw_pos = cmd.find("; speedwave").unwrap();
        assert!(env_pos < loc_pos);
        assert!(loc_pos < sw_pos);
        assert!(cmd.ends_with("speedwave login --project 'myproj'"));
        assert!(!cmd.contains("&&"));
        assert!(!cmd.contains("export "));
    }

    #[test]
    fn build_auth_command_for_platform_strips_extended_length_prefix_issue_612() {
        // Regression test for GitHub issue #612 — reproduces the exact failing input
        let cmd = build_auth_command_for_platform(
            "p",
            r"\\?\C:\Users\NikodemDeja\testproject",
            std::path::Path::new(r"C:\Users\NikodemDeja\.speedwave"),
            Some(std::path::Path::new(r"C:\Users\NikodemDeja\.speedwave")),
            true,
        );
        assert_eq!(
            cmd,
            r"Set-Location 'C:\Users\NikodemDeja\testproject'; speedwave login --project 'p'"
        );
        assert!(!cmd.contains(r"\\?\"));
        assert!(!cmd.contains(" && "));
        assert!(!cmd.contains("export "));
        assert!(!cmd.contains(" cd "));
    }

    #[test]
    fn build_auth_command_for_platform_windows_escapes_single_quote_in_path() {
        let cmd = build_auth_command_for_platform(
            "p",
            r"C:\Users\O'Brien\proj",
            std::path::Path::new(r"C:\Users\O'Brien\.speedwave"),
            Some(std::path::Path::new(r"C:\Users\O'Brien\.speedwave")),
            true,
        );
        assert!(cmd.contains("O''Brien"));
        assert!(!cmd.contains("O'\\''Brien"));
    }

    #[test]
    fn build_auth_command_for_platform_windows_unicode_path() {
        let cmd = build_auth_command_for_platform(
            "p",
            r"C:\Users\test\プロジェクト",
            std::path::Path::new(r"C:\Users\test\.speedwave"),
            Some(std::path::Path::new(r"C:\Users\test\.speedwave")),
            true,
        );
        assert!(cmd.contains("プロジェクト"));
    }

    #[test]
    fn build_auth_command_for_platform_windows_no_double_ampersand() {
        // Defence-in-depth: no Windows output may contain " && "
        let cmd_no_env = build_auth_command_for_platform(
            "p",
            r"C:\proj",
            std::path::Path::new(r"C:\.speedwave"),
            Some(std::path::Path::new(r"C:\.speedwave")),
            true,
        );
        assert!(!cmd_no_env.contains(" && "));

        let cmd_with_env = build_auth_command_for_platform(
            "p",
            r"C:\proj",
            std::path::Path::new(r"C:\.speedwave-dev"),
            Some(std::path::Path::new(r"C:\.speedwave")),
            true,
        );
        assert!(!cmd_with_env.contains(" && "));
    }

    #[test]
    fn build_auth_command_for_platform_windows_escapes_single_quote_in_data_dir() {
        // Custom data dir containing a `'` must use PS doubling (`''`),
        // never POSIX backslash escaping (`'\''`). Closes review gap.
        let cmd = build_auth_command_for_platform(
            "p",
            r"C:\proj",
            std::path::Path::new(r"C:\Users\O'Brien\.speedwave-dev"),
            Some(std::path::Path::new(r"C:\Users\O'Brien\.speedwave")),
            true,
        );
        assert!(cmd.contains("O''Brien"));
        assert!(!cmd.contains("O'\\''Brien"));
        assert!(cmd.starts_with(&format!(
            "$env:{} = 'C:\\Users\\O''Brien\\.speedwave-dev'",
            speedwave_runtime::consts::DATA_DIR_ENV
        )));
    }

    #[test]
    fn build_auth_command_for_platform_windows_strips_extended_length_prefix_in_data_dir() {
        // Defence-in-depth: if data_dir ever carries `\\?\` (e.g. a future
        // "choose data directory" picker on Windows), the env var must be
        // set to a clean, paste-ready path — not the raw extended-length
        // form which subsequent tools would mishandle.
        let cmd = build_auth_command_for_platform(
            "p",
            r"C:\proj",
            std::path::Path::new(r"\\?\C:\Users\test\.speedwave-dev"),
            Some(std::path::Path::new(r"C:\Users\test\.speedwave")),
            true,
        );
        assert!(!cmd.contains(r"\\?\"));
        assert!(cmd.contains(r"$env:"));
        assert!(cmd.contains(r"'C:\Users\test\.speedwave-dev'"));
    }

    #[test]
    fn build_auth_command_for_platform_windows_passthrough_bare_drive() {
        // \\?\C: (bare drive, no separator) must pass through unchanged
        let cmd = build_auth_command_for_platform(
            "p",
            r"\\?\C:",
            std::path::Path::new(r"C:\.speedwave"),
            Some(std::path::Path::new(r"C:\.speedwave")),
            true,
        );
        assert!(cmd.contains(r"Set-Location '\\?\C:'"));
    }

    #[test]
    fn build_auth_command_for_platform_windows_escapes_single_quote_in_project_name() {
        // Defensive escaping for project names containing `'`. validate_project_name
        // forbids them — but renderer must escape regardless.
        let cmd = build_auth_command_for_platform(
            "weird'name",
            r"C:\proj",
            std::path::Path::new(r"C:\.speedwave"),
            Some(std::path::Path::new(r"C:\.speedwave")),
            true,
        );
        assert!(cmd.contains("--project 'weird''name'"));
    }

    // ── AuthStatusResponse wire-format ─────────────────────────────────────

    #[test]
    fn auth_status_response_serializes_two_fields() {
        let resp = crate::types::AuthStatusResponse {
            api_key_configured: true,
            oauth_authenticated: false,
        };
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(json["api_key_configured"], true);
        assert_eq!(json["oauth_authenticated"], false);
    }
}
