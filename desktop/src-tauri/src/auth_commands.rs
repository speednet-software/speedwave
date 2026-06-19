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
        // check_claude_auth → ensure_exec_healthy can call compose_up_recreate;
        // block on bundle reconcile first.
        crate::containers_cmd::ensure_images_ready()?;
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

/// Strips `\\?\` extended-length prefix from Windows paths when followed by `<drive>:\`.
/// Returns input unchanged for UNC, POSIX, or already-stripped paths.
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

/// Pure command assembly. `is_windows` selects PowerShell-shaped output
/// (Set-Location, `;`, $env:, '' escape, \\?\ stripping) vs POSIX (cd, &&,
/// export, '\'' escape).
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
            // Pin CLI path to <data_dir>/bin so PATH cannot resolve a foreign install.
            let cli_path = format!(
                "{}\\{}\\speedwave.exe",
                ddir,
                speedwave_runtime::consts::CLI_BIN_SUBDIR
            );
            format!(
                "$env:{} = '{}'; Set-Location '{}'; & '{}' login --project '{}'",
                speedwave_runtime::consts::DATA_DIR_ENV,
                ps_escape_single_quoted(ddir),
                ps_escape_single_quoted(pdir),
                ps_escape_single_quoted(&cli_path),
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

/// Resolves the project directory, active data dir, and default data dir.
/// Shared by `get_auth_command` and `start_oauth_login` to prevent drift.
pub(crate) fn resolve_project_dirs(
    project: &str,
) -> Result<(String, std::path::PathBuf, Option<std::path::PathBuf>), String> {
    let user_config = speedwave_runtime::config::load_user_config()
        .map_err(|e| format!("Failed to load config: {e}"))?;
    let project_dir = user_config
        .find_project(project)
        .map(|p| p.dir.clone())
        .ok_or_else(|| format!("project '{project}' not found in config"))?;
    let data_dir = speedwave_runtime::consts::data_dir().clone();
    let default_data_dir = dirs::home_dir().map(|h| h.join(speedwave_runtime::consts::DATA_DIR));
    Ok((project_dir, data_dir, default_data_dir))
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
        let (project_dir, data_dir, default_data_dir) = resolve_project_dirs(&project)?;
        Ok(build_auth_command(
            &project,
            &project_dir,
            &data_dir,
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

    // -- get_auth_status race guard --

    #[test]
    fn get_auth_status_waits_for_image_readiness() {
        // Race guard: get_auth_status must gate on image readiness before exec.
        let source = include_str!("auth_commands.rs");
        let fn_start = source
            .find("pub async fn get_auth_status(")
            .expect("get_auth_status Tauri command must exist");
        let fn_tail = &source[fn_start + 1..];
        let fn_end = fn_tail
            .find("pub async fn ")
            .or_else(|| fn_tail.find("pub fn "))
            .map(|i| fn_start + 1 + i)
            .unwrap_or(source.len());
        let fn_body = &source[fn_start..fn_end];

        let ensure_pos = fn_body
            .find("ensure_images_ready")
            .expect("get_auth_status must call ensure_images_ready");
        let inner_call_pos = fn_body
            .find("setup_wizard::check_claude_auth")
            .expect("get_auth_status must delegate to setup_wizard::check_claude_auth");
        assert!(
            ensure_pos < inner_call_pos,
            "ensure_images_ready must come BEFORE setup_wizard::check_claude_auth"
        );
    }

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
        // Project name must flow into the trailing `--project '<name>'`.
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
        // Defensive escaping in case validation is relaxed.
        let cmd = build_auth_command(
            "weird'name",
            "/proj",
            std::path::Path::new("/data"),
            Some(std::path::Path::new("/data")),
        );
        assert!(cmd.contains("--project 'weird'\\''name'"));
    }

    // -- strip_windows_extended_length_prefix tests --

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
        assert_eq!(
            cmd,
            format!(
                "$env:{} = 'C:\\Users\\test\\.speedwave-dev'; \
                 Set-Location 'C:\\Users\\test\\Projects'; \
                 & 'C:\\Users\\test\\.speedwave-dev\\bin\\speedwave.exe' \
                 login --project 'myproj'",
                speedwave_runtime::consts::DATA_DIR_ENV,
            )
        );
        assert!(!cmd.contains("&&"));
        assert!(!cmd.contains("export "));
    }

    #[test]
    fn build_auth_command_for_platform_windows_custom_data_dir_pins_cli_path() {
        let cmd = build_auth_command_for_platform(
            "p",
            r"C:\proj",
            std::path::Path::new(r"C:\Users\test\.speedwave-dev"),
            Some(std::path::Path::new(r"C:\Users\test\.speedwave")),
            true,
        );
        assert!(
            cmd.contains(r"& 'C:\Users\test\.speedwave-dev\bin\speedwave.exe'"),
            "env-pinned PS command must invoke CLI via absolute data_dir path, got: {cmd}"
        );
        assert!(
            !cmd.contains("; speedwave login"),
            "bare `speedwave` would let PATH pick a foreign install, got: {cmd}"
        );
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
        // Custom data dir must use PS doubling (''), not POSIX ('\').
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
        // Defence-in-depth: if data_dir carries \\?\, env var must be cleaned.
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
        // Defensive escaping in case validation changes.
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
