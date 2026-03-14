// Auth and terminal commands — extracted from main.rs
//
// Tauri command wrappers for API-key management and native terminal launch.

use super::{auth, setup_wizard};
use crate::types::AuthStatusResponse;

// ---------------------------------------------------------------------------
// Authentication commands (API key only — OAuth is done via CLI)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn save_api_key(project: String, api_key: String) -> Result<(), String> {
    if api_key.len() > 4096 {
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
// Open native terminal with speedwave (Claude Code)
// ---------------------------------------------------------------------------

/// Resolves and validates the CLI binary path.
///
/// Uses [`setup_wizard::cli_install_path()`] as the SSOT for the install location.
/// Returns the path to the installed CLI binary, or an error if it doesn't exist.
pub fn validate_cli_path() -> Result<std::path::PathBuf, String> {
    let cli_path = setup_wizard::cli_install_path()
        .ok_or_else(|| "cannot determine home directory".to_string())?;

    if !cli_path.exists() {
        return Err(format!(
            "CLI binary not found at {}. Please restart Speedwave to re-link the CLI.",
            cli_path.display()
        ));
    }

    Ok(cli_path)
}

/// Shell-escape a string for use inside single quotes (POSIX standard).
/// Each embedded single-quote becomes: close-quote, backslash-escaped quote, open-quote.
fn shell_escape_single_quoted(s: &str) -> String {
    s.replace('\'', "'\\''")
}

/// Validates that a string contains no control characters (U+0000..U+001F, U+007F).
///
/// Control characters in paths embedded into AppleScript or shell commands
/// can break quoting and enable injection attacks. This rejects newlines,
/// carriage returns, null bytes, tabs, and all other ASCII control characters.
fn validate_no_control_chars(s: &str) -> Result<(), String> {
    if let Some(pos) = s.find(|c: char| c.is_ascii_control()) {
        let byte = s.as_bytes()[pos];
        return Err(format!(
            "path contains control character 0x{byte:02X} at position {pos} — \
             this is not allowed for security reasons"
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn open_auth_terminal(project: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        log::info!("open_auth_terminal: project={project}");

        // Resolve project dir from config
        let user_config = speedwave_runtime::config::load_user_config()
            .map_err(|e| format!("Failed to load config: {e}"))?;
        let project_dir = user_config
            .find_project(&project)
            .map(|p| p.dir.clone())
            .ok_or_else(|| format!("project '{}' not found in config", project))?;

        // Reject paths with control characters (newlines, carriage returns, etc.)
        // to prevent AppleScript / shell injection via crafted project directory names.
        validate_no_control_chars(&project_dir)?;

        // Find the speedwave CLI binary
        let cli_path = validate_cli_path()?;

        let cli_str = cli_path.to_string_lossy().to_string();

        #[cfg(target_os = "macos")]
        {
            // Escape a string for embedding inside an AppleScript double-quoted string.
            // AppleScript treats backslash and double-quote as special inside "...".
            fn applescript_escape(s: &str) -> String {
                s.replace('\\', "\\\\").replace('"', "\\\"")
            }

            // Build the shell command with proper single-quote escaping, then
            // escape the result for embedding in the AppleScript "do script" string.
            let shell_cmd = format!(
                "cd '{}' && '{}'",
                shell_escape_single_quoted(&project_dir),
                shell_escape_single_quoted(&cli_str),
            );
            let apple_script = format!(
                "tell application \"Terminal\"\n  activate\n  do script \"{}\"\nend tell",
                applescript_escape(&shell_cmd),
            );
            std::process::Command::new("osascript")
                .arg("-e")
                .arg(&apple_script)
                .status()
                .map_err(|e| e.to_string())?;
        }

        #[cfg(target_os = "linux")]
        {
            let shell_cmd = format!(
                "cd '{}' && exec '{}'",
                shell_escape_single_quoted(&project_dir),
                shell_escape_single_quoted(&cli_str),
            );
            let terminals = ["x-terminal-emulator", "gnome-terminal", "xterm"];
            let mut launched = false;
            for term in &terminals {
                if std::process::Command::new(term)
                    .args(["--", "bash", "-c", &shell_cmd])
                    .spawn()
                    .is_ok()
                {
                    launched = true;
                    break;
                }
            }
            if !launched {
                return Err("No terminal emulator found".to_string());
            }
        }

        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        {
            let _ = cli_str;
            return Err("Terminal launch not supported on this platform yet".to_string());
        }

        #[allow(unreachable_code)]
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    // -- validate_cli_path tests --

    #[test]
    fn validate_cli_path_returns_error_when_binary_missing() {
        // validate_cli_path delegates to setup_wizard::cli_install_path() for
        // the platform-specific path. Since this test runs in a clean CI
        // environment (or dev machine without a full install), the binary is
        // very unlikely to exist — but if it does, the test still passes.
        let result = validate_cli_path();
        match result {
            Ok(path) => assert!(path.exists(), "returned path should exist"),
            Err(msg) => assert!(
                msg.contains("not found"),
                "error should mention 'not found': {msg}"
            ),
        }
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

    // -- validate_no_control_chars tests --

    #[test]
    fn validate_no_control_chars_accepts_normal_path() {
        assert!(validate_no_control_chars("/Users/dev/my project").is_ok());
    }

    #[test]
    fn validate_no_control_chars_accepts_unicode() {
        assert!(validate_no_control_chars("/Users/dev/projekt-zółw").is_ok());
    }

    #[test]
    fn validate_no_control_chars_rejects_newline() {
        let result = validate_no_control_chars("/tmp/evil\n; rm -rf /");
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            err.contains("0x0A"),
            "error should mention 0x0A for newline: {err}"
        );
    }

    #[test]
    fn validate_no_control_chars_rejects_carriage_return() {
        let result = validate_no_control_chars("/tmp/evil\r");
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            err.contains("0x0D"),
            "error should mention 0x0D for CR: {err}"
        );
    }

    #[test]
    fn validate_no_control_chars_rejects_null_byte() {
        let result = validate_no_control_chars("/tmp/evil\0");
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            err.contains("0x00"),
            "error should mention 0x00 for null: {err}"
        );
    }

    #[test]
    fn validate_no_control_chars_rejects_tab() {
        let result = validate_no_control_chars("/tmp/evil\there");
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            err.contains("0x09"),
            "error should mention 0x09 for tab: {err}"
        );
    }

    #[test]
    fn validate_no_control_chars_rejects_escape() {
        let result = validate_no_control_chars("/tmp/\x1B[31mred");
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            err.contains("0x1B"),
            "error should mention 0x1B for ESC: {err}"
        );
    }

    #[test]
    fn validate_no_control_chars_rejects_del() {
        let result = validate_no_control_chars("/tmp/evil\x7F");
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            err.contains("0x7F"),
            "error should mention 0x7F for DEL: {err}"
        );
    }

    #[test]
    fn validate_no_control_chars_reports_position() {
        let result = validate_no_control_chars("abcd\nefg");
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            err.contains("position 4"),
            "error should report position 4: {err}"
        );
    }

    #[test]
    fn validate_no_control_chars_accepts_empty_string() {
        assert!(validate_no_control_chars("").is_ok());
    }
}
