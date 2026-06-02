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
    /// Path to the per-project host-exec worker log.
    pub host_exec_log: Option<std::path::PathBuf>,
    /// Path to the project's `compose.yml`.
    pub compose_path: Option<std::path::PathBuf>,
    /// Path to the Claude session log file.
    pub claude_session_log: Option<std::path::PathBuf>,
}

/// Builds a diagnostics ZIP at `zip_path` from the provided inputs.
///
/// All textual content is passed through `log_sanitizer::sanitize()` before
/// being written to the archive. System info is appended without sanitization.
/// Writes one ZIP entry, ALWAYS sanitized. The single textual-write path —
/// every secret-bearing entry goes through here, so none can skip redaction.
fn write_sanitized_entry(
    zip: &mut zip::ZipWriter<std::fs::File>,
    options: zip::write::SimpleFileOptions,
    name: &str,
    raw: &str,
) -> anyhow::Result<()> {
    use std::io::Write;
    let sanitized = speedwave_runtime::log_sanitizer::sanitize(raw);
    zip.start_file(name, options)?;
    zip.write_all(sanitized.as_bytes())?;
    Ok(())
}

pub(crate) fn build_diagnostics_zip(
    zip_path: &std::path::Path,
    input: &DiagnosticsInput,
) -> anyhow::Result<()> {
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    let file = std::fs::File::create(zip_path)?;
    let mut zip = zip::ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    // App logs: one /logs source ("desktop") → N `logs/<file>` entries.
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
                    let name = format!(
                        "logs/{}",
                        path.file_name().unwrap_or_default().to_string_lossy()
                    );
                    write_sanitized_entry(&mut zip, options, &name, &content)?;
                }
            }
        }
    }

    // Entry names come from the SSOT registry (keyed by source), so a stray
    // hand-rolled entry can't appear — every name traces to DIAGNOSTIC_SOURCES.
    let zip_entry = |key: &str| -> &'static str {
        speedwave_runtime::diagnostic_sources::DIAGNOSTIC_SOURCES
            .iter()
            .find(|s| s.key == key)
            .map(|s| s.zip_entry)
            .unwrap_or_default()
    };

    if let Some(ref logs) = input.container_logs {
        write_sanitized_entry(&mut zip, options, zip_entry("compose"), logs)?;
    }

    // Single-file sources keyed to the registry. Existence-gated.
    let single_files = [
        (&input.serial_log, "lima"),
        (&input.mcp_os_log, "mcp-os"),
        (&input.host_exec_log, "host-exec"),
        (&input.claude_session_log, "claude"),
        (&input.compose_path, "compose-yml"),
    ];
    for (maybe_path, key) in single_files {
        if let Some(path) = maybe_path {
            if path.exists() {
                if let Ok(content) = std::fs::read_to_string(path) {
                    write_sanitized_entry(&mut zip, options, zip_entry(key), &content)?;
                }
            }
        }
    }

    // System info: compile-time constants, no secrets — the one raw entry.
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

        let log_dir = crate::logging_cmd::desktop_log_dir();

        let rt = speedwave_runtime::runtime::detect_runtime();
        let container_logs = rt.compose_logs(&project, 5000).ok();

        // File-source paths resolved from the SSOT registry (platform-gated), so
        // /logs and the ZIP can't drift and host-exec is no longer dropped.
        let data_dir = speedwave_runtime::consts::data_dir();
        let resolve = |key: &str| {
            speedwave_runtime::diagnostic_sources::resolve_file_path(key, data_dir, &project)
        };

        let input = DiagnosticsInput {
            log_dir,
            serial_log: resolve("lima"),
            container_logs,
            mcp_os_log: resolve("mcp-os"),
            host_exec_log: resolve("host-exec"),
            compose_path: resolve("compose-yml"),
            claude_session_log: resolve("claude"),
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

    /// Regression: paths must come from the DIAGNOSTIC_SOURCES registry, never
    /// a hand-rolled `projects/<project>/` path that silently bundled nothing.
    #[test]
    fn export_diagnostics_resolves_paths_via_registry() {
        let src = include_str!("diagnostics.rs");
        let cmd = src
            .split("async fn export_diagnostics(")
            .nth(1)
            .and_then(|s| s.split("\n}").next())
            .expect("export_diagnostics body");
        assert!(
            cmd.contains("resolve_file_path"),
            "paths must be resolved from the registry SSOT (resolve_file_path)"
        );
        assert!(
            !cmd.contains(".join(\"projects\")"),
            "must not re-introduce the non-existent projects/<project>/compose.yml path"
        );
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
            host_exec_log: None,
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
            host_exec_log: None,
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
            host_exec_log: None,
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
            host_exec_log: None,
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
            host_exec_log: None,
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
            host_exec_log: None,
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
            host_exec_log: None,
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
            host_exec_log: None,
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

    #[test]
    fn diagnostics_zip_includes_host_exec_log() {
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("diag-hostexec.zip");
        let host_exec = tmp.path().join("host-exec-log");
        std::fs::write(&host_exec, "host_exec ran npm test").unwrap();

        let input = DiagnosticsInput {
            log_dir: None,
            serial_log: None,
            container_logs: None,
            mcp_os_log: None,
            host_exec_log: Some(host_exec),
            compose_path: None,
            claude_session_log: None,
        };
        build_diagnostics_zip(&zip_path, &input).unwrap();

        let names = zip_entry_names(&zip_path);
        assert!(
            names.contains(&"host-exec/log".to_string()),
            "ZIP must contain host-exec log (was missing before the registry fix): {names:?}"
        );
    }

    /// Matrix guard: a secret planted in EVERY textual source must be redacted
    /// in EVERY ZIP entry — not just the few cases the per-source tests check.
    #[test]
    fn diagnostics_zip_all_sources_redact_secrets() {
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("diag-matrix.zip");

        let log_dir = tmp.path().join("logs");
        std::fs::create_dir_all(&log_dir).unwrap();
        std::fs::write(
            log_dir.join("app.log"),
            "desktop sk-ant-deadbeefdeadbeefdeadbeef",
        )
        .unwrap();
        let mk = |name: &str, body: &str| {
            let p = tmp.path().join(name);
            std::fs::write(&p, body).unwrap();
            p
        };
        let secrets = [
            "sk-ant-deadbeefdeadbeefdeadbeef",
            "xoxb-1111-2222-secretslacktoken",
            "MCP_SLACK_AUTH_TOKEN=550e8400-e29b-41d4-a716-446655440000",
            "password=hunter2hunter2",
            "Bearer ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ];
        let input = DiagnosticsInput {
            log_dir: Some(log_dir),
            serial_log: Some(mk("serial.log", secrets[1])),
            container_logs: Some(secrets[2].into()),
            mcp_os_log: Some(mk("mcp.log", secrets[3])),
            host_exec_log: Some(mk("he.log", secrets[4])),
            compose_path: Some(mk("compose.yml", secrets[0])),
            claude_session_log: Some(mk("claude.log", secrets[1])),
        };
        build_diagnostics_zip(&zip_path, &input).unwrap();

        for name in zip_entry_names(&zip_path) {
            if name == "system-info.txt" {
                continue;
            }
            let content = read_zip_entry(&zip_path, &name).unwrap_or_default();
            for s in &secrets {
                assert!(
                    !content.contains(s),
                    "secret '{s}' leaked into ZIP entry '{name}': {content}"
                );
            }
        }
    }

    /// Parity: every ZIP entry must trace to a registry `zip_entry`. A stray
    /// hand-rolled `zip.start_file(...)` outside the registry would fail here.
    #[test]
    fn every_zip_entry_traces_to_source() {
        use speedwave_runtime::diagnostic_sources::DIAGNOSTIC_SOURCES;
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("diag-trace.zip");
        let log_dir = tmp.path().join("logs");
        std::fs::create_dir_all(&log_dir).unwrap();
        std::fs::write(log_dir.join("app.log"), "x").unwrap();
        let mk = |name: &str| {
            let p = tmp.path().join(name);
            std::fs::write(&p, "x").unwrap();
            p
        };
        let input = DiagnosticsInput {
            log_dir: Some(log_dir),
            serial_log: Some(mk("serial.log")),
            container_logs: Some("x".into()),
            mcp_os_log: Some(mk("mcp.log")),
            host_exec_log: Some(mk("he.log")),
            compose_path: Some(mk("compose.yml")),
            claude_session_log: Some(mk("claude.log")),
        };
        build_diagnostics_zip(&zip_path, &input).unwrap();

        let registry_entries: Vec<&str> = DIAGNOSTIC_SOURCES.iter().map(|s| s.zip_entry).collect();
        for name in zip_entry_names(&zip_path) {
            // system-info.txt is the documented non-source trailing write;
            // `logs/<file>` are the desktop dir's N dynamic entries (zip_entry "logs/").
            let traced = name == "system-info.txt"
                || name.starts_with("logs/")
                || registry_entries.contains(&name.as_str());
            assert!(
                traced,
                "ZIP entry '{name}' does not trace to any DIAGNOSTIC_SOURCES.zip_entry"
            );
        }
    }
}
