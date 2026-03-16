// Diagnostic export — collects logs, compose config, and system info into a
// sanitized ZIP archive for support diagnostics.

/// Inputs for building a diagnostics ZIP — extracted for testability.
pub(crate) struct DiagnosticsInput {
    /// Directory containing `.log` files (app logs).
    pub log_dir: Option<std::path::PathBuf>,
    /// Path to the Lima VM serial log (macOS only).
    pub serial_log: Option<std::path::PathBuf>,
    /// Container logs as a raw string (already fetched from runtime).
    pub container_logs: Option<String>,
    /// Path to the mcp-os dedicated log file.
    pub mcp_os_log: Option<std::path::PathBuf>,
    /// Path to the project's `compose.yml`.
    pub compose_path: Option<std::path::PathBuf>,
    /// Path to the Claude session log file.
    pub claude_session_log: Option<std::path::PathBuf>,
}

/// Builds a diagnostics ZIP at `zip_path` from the provided inputs.
///
/// All textual content is passed through `log_sanitizer::sanitize()` before
/// being written to the archive. System info is appended without sanitization.
pub(crate) fn build_diagnostics_zip(
    zip_path: &std::path::Path,
    input: &DiagnosticsInput,
) -> anyhow::Result<()> {
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    let file = std::fs::File::create(zip_path)?;
    let mut zip = zip::ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    // 1. App logs
    if let Some(ref log_dir) = input.log_dir {
        if let Ok(entries) = std::fs::read_dir(log_dir) {
            let mut log_paths: Vec<_> = entries
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.extension().map(|e| e == "log").unwrap_or(false))
                .collect();
            log_paths.sort();
            for path in &log_paths {
                if let Ok(content) = std::fs::read_to_string(path) {
                    let sanitized = speedwave_runtime::log_sanitizer::sanitize(&content);
                    let name = format!(
                        "logs/{}",
                        path.file_name().unwrap_or_default().to_string_lossy()
                    );
                    zip.start_file(&name, options)?;
                    zip.write_all(sanitized.as_bytes())?;
                }
            }
        }
    }

    // 2. Lima VM serial log
    if let Some(ref serial_log) = input.serial_log {
        if serial_log.exists() {
            if let Ok(content) = std::fs::read_to_string(serial_log) {
                let sanitized = speedwave_runtime::log_sanitizer::sanitize(&content);
                zip.start_file("lima/serial.log", options)?;
                zip.write_all(sanitized.as_bytes())?;
            }
        }
    }

    // 3. Container logs
    if let Some(ref logs) = input.container_logs {
        let sanitized = speedwave_runtime::log_sanitizer::sanitize(logs);
        zip.start_file("containers/compose.log", options)?;
        zip.write_all(sanitized.as_bytes())?;
    }

    // 4. mcp-os log
    if let Some(ref path) = input.mcp_os_log {
        if path.exists() {
            if let Ok(content) = std::fs::read_to_string(path) {
                let sanitized = speedwave_runtime::log_sanitizer::sanitize(&content);
                let entry_name = format!("mcp-os/{}", speedwave_runtime::consts::MCP_OS_LOG_FILE);
                zip.start_file(&entry_name, options)?;
                zip.write_all(sanitized.as_bytes())?;
            }
        }
    }

    // 5. Claude session log
    if let Some(ref path) = input.claude_session_log {
        if path.exists() {
            if let Ok(content) = std::fs::read_to_string(path) {
                let sanitized = speedwave_runtime::log_sanitizer::sanitize(&content);
                zip.start_file("claude/claude-session.log", options)?;
                zip.write_all(sanitized.as_bytes())?;
            }
        }
    }

    // 6. compose.yml
    if let Some(ref compose_path) = input.compose_path {
        if compose_path.exists() {
            if let Ok(content) = std::fs::read_to_string(compose_path) {
                let sanitized = speedwave_runtime::log_sanitizer::sanitize(&content);
                zip.start_file("containers/compose.yml", options)?;
                zip.write_all(sanitized.as_bytes())?;
            }
        }
    }

    // 7. System info (no sanitization needed)
    let sys_info = format!(
        "os: {}\narch: {}\nversion: {}\n",
        std::env::consts::OS,
        std::env::consts::ARCH,
        env!("CARGO_PKG_VERSION"),
    );
    zip.start_file("system-info.txt", options)?;
    zip.write_all(sys_info.as_bytes())?;

    zip.finish()?;
    Ok(())
}

/// Collects app logs, container logs, compose config, and system info into a
/// sanitized ZIP archive for support diagnostics.
#[tauri::command]
pub(crate) async fn export_diagnostics(project: String) -> Result<String, String> {
    super::check_project(&project)?;

    tokio::task::spawn_blocking(move || -> anyhow::Result<String> {
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        let downloads = dirs::download_dir()
            .or_else(dirs::home_dir)
            .ok_or_else(|| anyhow::anyhow!("cannot determine downloads directory"))?;

        let zip_path = downloads.join(format!("speedwave-diagnostics-{timestamp}.zip"));

        let log_dir = if cfg!(target_os = "macos") {
            dirs::home_dir().map(|h| h.join("Library/Logs/pl.speedwave.desktop"))
        } else {
            dirs::home_dir().map(|h| h.join(".local/share/pl.speedwave.desktop/logs"))
        };

        let serial_log = if cfg!(target_os = "macos") {
            dirs::home_dir().map(|h| h.join(".speedwave/lima/speedwave/serial.log"))
        } else {
            None
        };

        let rt = speedwave_runtime::runtime::detect_runtime();
        let container_logs = rt.compose_logs(&project, 5000).ok();

        let compose_path = dirs::home_dir().map(|h| {
            h.join(speedwave_runtime::consts::DATA_DIR)
                .join("projects")
                .join(&project)
                .join("compose.yml")
        });

        let mcp_os_log = dirs::home_dir()
            .map(|h| {
                h.join(speedwave_runtime::consts::DATA_DIR)
                    .join(speedwave_runtime::consts::MCP_OS_LOG_FILE)
            })
            .filter(|p| p.exists());

        let claude_session_log = speedwave_runtime::consts::claude_session_log_path(&project)
            .filter(|p| p.exists());

        let input = DiagnosticsInput {
            log_dir,
            serial_log,
            container_logs,
            mcp_os_log,
            compose_path,
            claude_session_log,
        };

        build_diagnostics_zip(&zip_path, &input)?;

        Ok(zip_path.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn export_diagnostics_rejects_invalid_project_name() {
        let result = super::super::check_project("../escape");
        assert!(result.is_err(), "path traversal should be rejected");
    }

    #[test]
    fn export_diagnostics_rejects_empty_project_name() {
        let result = super::super::check_project("");
        assert!(result.is_err(), "empty project name should be rejected");
    }

    // -- build_diagnostics_zip tests --

    /// Helper: read a ZIP entry as a UTF-8 string.
    fn read_zip_entry(zip_path: &std::path::Path, entry_name: &str) -> Option<String> {
        let file = std::fs::File::open(zip_path).ok()?;
        let mut archive = zip::ZipArchive::new(file).ok()?;
        let mut entry = archive.by_name(entry_name).ok()?;
        let mut buf = String::new();
        std::io::Read::read_to_string(&mut entry, &mut buf).ok()?;
        Some(buf)
    }

    /// Helper: list all entry names in a ZIP.
    fn zip_entry_names(zip_path: &std::path::Path) -> Vec<String> {
        let file = std::fs::File::open(zip_path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        (0..archive.len())
            .map(|i| archive.by_index(i).unwrap().name().to_string())
            .collect()
    }

    #[test]
    fn diagnostics_zip_contains_expected_entries() {
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("diag.zip");

        // Create a fake log directory with one log file
        let log_dir = tmp.path().join("logs");
        std::fs::create_dir_all(&log_dir).unwrap();
        std::fs::write(log_dir.join("app.log"), "INFO started").unwrap();
        // Non-.log file should be ignored
        std::fs::write(log_dir.join("app.txt"), "ignored").unwrap();

        // Create a fake compose.yml
        let compose_path = tmp.path().join("compose.yml");
        std::fs::write(
            &compose_path,
            "version: '3'\nservices:\n  claude:\n    image: test\n",
        )
        .unwrap();

        let input = DiagnosticsInput {
            log_dir: Some(log_dir),
            serial_log: None,
            container_logs: Some("container output here".into()),
            mcp_os_log: None,
            compose_path: Some(compose_path),
            claude_session_log: None,
        };

        build_diagnostics_zip(&zip_path, &input).unwrap();

        let names = zip_entry_names(&zip_path);
        assert!(
            names.contains(&"logs/app.log".to_string()),
            "ZIP should contain app log: {names:?}"
        );
        assert!(
            !names.iter().any(|n| n.contains("app.txt")),
            "ZIP should not contain non-.log files: {names:?}"
        );
        assert!(
            names.contains(&"containers/compose.log".to_string()),
            "ZIP should contain container logs: {names:?}"
        );
        assert!(
            names.contains(&"containers/compose.yml".to_string()),
            "ZIP should contain compose.yml: {names:?}"
        );
        assert!(
            names.contains(&"system-info.txt".to_string()),
            "ZIP should contain system info: {names:?}"
        );

        // Verify system-info.txt has expected fields
        let sys_info = read_zip_entry(&zip_path, "system-info.txt").unwrap();
        assert!(sys_info.contains("os:"), "system info should contain OS");
        assert!(
            sys_info.contains("arch:"),
            "system info should contain arch"
        );
        assert!(
            sys_info.contains("version:"),
            "system info should contain version"
        );
    }

    #[test]
    fn diagnostics_zip_redacts_secrets_in_logs() {
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("diag-redact.zip");

        let log_dir = tmp.path().join("logs");
        std::fs::create_dir_all(&log_dir).unwrap();
        std::fs::write(
            log_dir.join("app.log"),
            "Auth: Bearer sk-ant-super-secret-key-12345\nSlack token: xoxb-slack-secret-token\n",
        )
        .unwrap();

        let input = DiagnosticsInput {
            log_dir: Some(log_dir),
            serial_log: None,
            container_logs: Some(
                "JWT: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123\n".into(),
            ),
            mcp_os_log: None,
            compose_path: None,
            claude_session_log: None,
        };

        build_diagnostics_zip(&zip_path, &input).unwrap();

        let log_content = read_zip_entry(&zip_path, "logs/app.log").unwrap();
        assert!(
            !log_content.contains("sk-ant-super-secret-key-12345"),
            "Bearer token should be redacted in log: {log_content}"
        );
        assert!(
            !log_content.contains("xoxb-slack-secret-token"),
            "Slack token should be redacted in log: {log_content}"
        );
        assert!(
            log_content.contains("***REDACTED***"),
            "Redacted marker should be present: {log_content}"
        );

        let container_content = read_zip_entry(&zip_path, "containers/compose.log").unwrap();
        assert!(
            !container_content.contains("eyJhbGciOiJIUzI1NiJ9"),
            "JWT should be redacted in container logs: {container_content}"
        );
    }

    #[test]
    fn diagnostics_zip_redacts_secrets_in_compose_yml() {
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("diag-compose.zip");

        let compose_path = tmp.path().join("compose.yml");
        std::fs::write(
            &compose_path,
            "environment:\n  - API_KEY=password=hunter2\n  - SLACK_TOKEN=xoxp-slack-token\n",
        )
        .unwrap();

        let input = DiagnosticsInput {
            log_dir: None,
            serial_log: None,
            container_logs: None,
            mcp_os_log: None,
            compose_path: Some(compose_path),
            claude_session_log: None,
        };

        build_diagnostics_zip(&zip_path, &input).unwrap();

        let content = read_zip_entry(&zip_path, "containers/compose.yml").unwrap();
        assert!(
            !content.contains("hunter2"),
            "Password value should be redacted in compose.yml: {content}"
        );
        assert!(
            !content.contains("xoxp-slack-token"),
            "Slack token should be redacted in compose.yml: {content}"
        );
    }

    #[test]
    fn diagnostics_zip_never_includes_tokens_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("diag-tokens.zip");

        // Create a fake log dir with a tokens/ subdirectory
        let log_dir = tmp.path().join("logs");
        std::fs::create_dir_all(&log_dir).unwrap();
        std::fs::write(log_dir.join("app.log"), "normal log").unwrap();
        // tokens/ dir alongside logs — should never appear
        let tokens_dir = tmp.path().join("tokens");
        std::fs::create_dir_all(tokens_dir.join("slack")).unwrap();
        std::fs::write(
            tokens_dir.join("slack/token.json"),
            r#"{"token":"xoxb-real-secret"}"#,
        )
        .unwrap();

        let input = DiagnosticsInput {
            log_dir: Some(log_dir),
            serial_log: None,
            container_logs: None,
            mcp_os_log: None,
            compose_path: None,
            claude_session_log: None,
        };

        build_diagnostics_zip(&zip_path, &input).unwrap();

        let names = zip_entry_names(&zip_path);
        assert!(
            !names.iter().any(|n| n.contains("token")),
            "ZIP must never contain tokens directory entries: {names:?}"
        );
    }

    #[test]
    fn diagnostics_zip_redacts_serial_log() {
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("diag-serial.zip");

        let serial_log = tmp.path().join("serial.log");
        std::fs::write(
            &serial_log,
            "kernel boot\nAuthorization: Bearer leaked-token-here\nboot complete\n",
        )
        .unwrap();

        let input = DiagnosticsInput {
            log_dir: None,
            serial_log: Some(serial_log),
            container_logs: None,
            mcp_os_log: None,
            compose_path: None,
            claude_session_log: None,
        };

        build_diagnostics_zip(&zip_path, &input).unwrap();

        let content = read_zip_entry(&zip_path, "lima/serial.log").unwrap();
        assert!(
            !content.contains("leaked-token-here"),
            "Bearer token should be redacted in serial log: {content}"
        );
        assert!(
            content.contains("kernel boot"),
            "Non-secret content should be preserved: {content}"
        );
    }

    #[test]
    fn diagnostics_zip_handles_empty_inputs() {
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("diag-empty.zip");

        let input = DiagnosticsInput {
            log_dir: None,
            serial_log: None,
            container_logs: None,
            mcp_os_log: None,
            compose_path: None,
            claude_session_log: None,
        };

        build_diagnostics_zip(&zip_path, &input).unwrap();

        let names = zip_entry_names(&zip_path);
        assert_eq!(
            names,
            vec!["system-info.txt"],
            "Empty-input ZIP should only contain system-info.txt"
        );
    }

    #[test]
    fn diagnostics_zip_mcp_os_entry_uses_const() {
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("diag-mcp-os.zip");

        let mcp_os_log = tmp.path().join("mcp-os.log");
        std::fs::write(&mcp_os_log, "mcp-os log content").unwrap();

        let input = DiagnosticsInput {
            log_dir: None,
            serial_log: None,
            container_logs: None,
            mcp_os_log: Some(mcp_os_log),
            compose_path: None,
            claude_session_log: None,
        };

        build_diagnostics_zip(&zip_path, &input).unwrap();

        let expected_entry = format!("mcp-os/{}", speedwave_runtime::consts::MCP_OS_LOG_FILE);
        let names = zip_entry_names(&zip_path);
        assert!(
            names.contains(&expected_entry),
            "ZIP should contain mcp-os entry named '{}', got: {:?}",
            expected_entry,
            names
        );
    }

    #[test]
    fn diagnostics_zip_includes_claude_session_log() {
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("diag-claude.zip");

        let session_log = tmp.path().join("claude-session.log");
        std::fs::write(
            &session_log,
            "[123] SESSION: started\n[124] TOOL: start: Read (toolu_01)\n",
        )
        .unwrap();

        let input = DiagnosticsInput {
            log_dir: None,
            serial_log: None,
            container_logs: None,
            mcp_os_log: None,
            compose_path: None,
            claude_session_log: Some(session_log),
        };

        build_diagnostics_zip(&zip_path, &input).unwrap();

        let names = zip_entry_names(&zip_path);
        assert!(
            names.contains(&"claude/claude-session.log".to_string()),
            "ZIP should contain claude session log: {names:?}"
        );

        let content = read_zip_entry(&zip_path, "claude/claude-session.log").unwrap();
        assert!(content.contains("SESSION: started"), "content: {content}");
        assert!(content.contains("TOOL: start"), "content: {content}");
    }
}
