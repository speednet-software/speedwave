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
fn shell_escape_single_quoted(s: &str) -> String {
    s.replace('\'', "'\\''")
}

/// Builds the CLI command string for the user to copy into their terminal.
///
/// When `data_dir` differs from `default_data_dir`, the command includes an
/// `export SPEEDWAVE_DATA_DIR=...` prefix so the CLI uses the correct data
/// directory regardless of the terminal's inherited environment.
///
/// Paths are single-quote escaped (POSIX) to handle spaces, `&`, `|`, and
/// other shell metacharacters. The user pastes this into a shell, so quoting
/// must be correct for safe execution.
fn build_auth_command(
    project_dir: &str,
    data_dir: &std::path::Path,
    default_data_dir: Option<&std::path::Path>,
) -> String {
    let needs_env_pin = default_data_dir.map(|d| d != data_dir).unwrap_or(false);

    let data_dir_str = data_dir.to_string_lossy();

    if needs_env_pin {
        format!(
            "export {}='{}' && cd '{}' && speedwave",
            speedwave_runtime::consts::DATA_DIR_ENV,
            shell_escape_single_quoted(&data_dir_str),
            shell_escape_single_quoted(project_dir),
        )
    } else {
        format!(
            "cd '{}' && speedwave",
            shell_escape_single_quoted(project_dir),
        )
    }
}

/// Returns a CLI command string for the user to copy into their terminal
/// to authenticate with Claude Code.
///
/// When the Desktop app's data directory differs from the default
/// (`~/.speedwave`), the command includes an `export SPEEDWAVE_DATA_DIR=...`
/// prefix to ensure the CLI uses the correct data directory regardless of
/// the terminal's inherited environment.
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
            "/Users/test/Projects",
            std::path::Path::new("/Users/test/.speedwave"),
            Some(std::path::Path::new("/Users/test/.speedwave")),
        );
        assert_eq!(cmd, "cd '/Users/test/Projects' && speedwave");
        assert!(!cmd.contains("export"));
    }

    #[test]
    fn build_auth_command_custom_data_dir() {
        let cmd = build_auth_command(
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
        assert!(cmd.ends_with("&& speedwave"));
    }

    #[test]
    fn build_auth_command_custom_data_dir_quotes_value() {
        let cmd = build_auth_command(
            "/proj",
            std::path::Path::new("/Users/test/.speedwave-dev"),
            Some(std::path::Path::new("/Users/test/.speedwave")),
        );
        assert!(cmd.contains("='/Users/test/.speedwave-dev'"));
    }

    #[test]
    fn build_auth_command_no_default_data_dir() {
        let cmd = build_auth_command("/projects", std::path::Path::new("/data/.speedwave"), None);
        assert_eq!(cmd, "cd '/projects' && speedwave");
    }

    #[test]
    fn build_auth_command_quotes_paths_with_spaces() {
        let cmd = build_auth_command(
            "/Users/John Smith/My Projects",
            std::path::Path::new("/Users/John Smith/.speedwave"),
            Some(std::path::Path::new("/Users/John Smith/.speedwave")),
        );
        assert!(cmd.contains("cd '/Users/John Smith/My Projects'"));
    }

    #[test]
    fn build_auth_command_escapes_single_quotes_in_project_dir() {
        let cmd = build_auth_command(
            "/Users/O'Brien/project",
            std::path::Path::new("/Users/O'Brien/.speedwave"),
            Some(std::path::Path::new("/Users/O'Brien/.speedwave")),
        );
        assert!(cmd.contains("O'\\''Brien"));
        assert!(cmd.contains("cd '"));
        assert!(cmd.ends_with("&& speedwave"));
    }

    #[test]
    fn build_auth_command_escapes_single_quotes_in_data_dir() {
        let cmd = build_auth_command(
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
            "/Users/test/proj&ect",
            std::path::Path::new("/Users/test/.speedwave"),
            Some(std::path::Path::new("/Users/test/.speedwave")),
        );
        assert!(cmd.contains("cd '/Users/test/proj&ect'"));
    }

    #[test]
    fn build_auth_command_unicode_paths() {
        let cmd = build_auth_command(
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
            "/projects",
            std::path::Path::new("/Users/test/.speedwave/"),
            Some(std::path::Path::new("/Users/test/.speedwave")),
        );
        assert!(
            !cmd.contains("export"),
            "trailing slash should not trigger export prefix (Path normalizes)"
        );
        assert_eq!(cmd, "cd '/projects' && speedwave");
    }

    #[test]
    fn build_auth_command_ordering() {
        let cmd = build_auth_command(
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
            "",
            std::path::Path::new("/data"),
            Some(std::path::Path::new("/data")),
        );
        assert_eq!(cmd, "cd '' && speedwave");
    }
}
