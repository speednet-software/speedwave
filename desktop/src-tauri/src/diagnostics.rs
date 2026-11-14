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
    /// Path to the container entrypoint's startup diagnostics log.
    pub entrypoint_log: Option<std::path::PathBuf>,
    /// Path to the proxy's usage JSONL (ZIP-only; not shown in `/logs`).
    pub proxy_usage_log: Option<std::path::PathBuf>,
}

/// Writes one ZIP entry; content always passes through `log_sanitizer::sanitize()` first
/// (`system-info.txt` is written separately, unsanitized — see its own call site).
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

const COMPOSE_LOGS_EXPORT_TAIL: u32 = 1_000_000;

fn source_for(
    key: &str,
) -> anyhow::Result<&'static speedwave_runtime::diagnostic_sources::DiagnosticSource> {
    speedwave_runtime::diagnostic_sources::DIAGNOSTIC_SOURCES
        .iter()
        .find(|s| s.key == key)
        .ok_or_else(|| anyhow::anyhow!("unknown diagnostic source '{key}'"))
}

fn within_window<'a>(
    key: &str,
    raw: &'a str,
    since: chrono::DateTime<chrono::Utc>,
) -> anyhow::Result<std::borrow::Cow<'a, str>> {
    Ok(speedwave_runtime::export_window::apply(
        raw,
        source_for(key)?.retention,
        since,
    ))
}

pub(crate) fn build_diagnostics_zip(
    zip_path: &std::path::Path,
    input: &DiagnosticsInput,
    window: &str,
    now: chrono::DateTime<chrono::Utc>,
) -> anyhow::Result<()> {
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    let window: speedwave_runtime::export_window::ExportWindow = window.parse()?;
    let since = window.since(now);

    let file = std::fs::File::create(zip_path)?;
    let mut zip = zip::ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    if let Some(ref log_dir) = input.log_dir {
        if let Ok(entries) = std::fs::read_dir(log_dir) {
            let mut log_paths: Vec<_> = entries
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.extension().map(|e| e == "log").unwrap_or(false))
                .collect();
            log_paths.sort();
            for path in &log_paths {
                let file_name = path.file_name().unwrap_or_default().to_string_lossy();
                if speedwave_runtime::export_window::rotated_file_ends_before(&file_name, since) {
                    continue;
                }
                if let Ok(content) = std::fs::read_to_string(path) {
                    let content = within_window("desktop", &content, since)?;
                    write_sanitized_entry(
                        &mut zip,
                        options,
                        &format!("logs/{file_name}"),
                        &content,
                    )?;
                }
            }
        }
    }

    let zip_entry = |key: &str| -> &'static str {
        speedwave_runtime::diagnostic_sources::DIAGNOSTIC_SOURCES
            .iter()
            .find(|s| s.key == key)
            .map(|s| s.zip_entry)
            .unwrap_or_default()
    };

    if let Some(ref logs) = input.container_logs {
        let logs = within_window("compose", logs, since)?;
        write_sanitized_entry(&mut zip, options, zip_entry("compose"), &logs)?;
    }

    let single_files = [
        (&input.serial_log, "lima"),
        (&input.mcp_os_log, "mcp-os"),
        (&input.claude_session_log, "claude"),
        (&input.compose_path, "compose-yml"),
        (&input.entrypoint_log, "entrypoint"),
        (&input.proxy_usage_log, "proxy-usage"),
    ];
    for (maybe_path, key) in single_files {
        if let Some(path) = maybe_path {
            match speedwave_runtime::fs_perms::read_regular_file_no_follow(path) {
                Ok(Some(content)) => {
                    let content = within_window(key, &content, since)?;
                    write_sanitized_entry(&mut zip, options, zip_entry(key), &content)?;
                }
                Ok(None) => {}
                Err(reason) => {
                    let reason = speedwave_runtime::log_sanitizer::sanitize(&reason);
                    log::warn!(
                        "diagnostics source {} is unreadable, recording a placeholder: {reason}",
                        path.display()
                    );
                    let name = format!("{}.unavailable.txt", zip_entry(key));
                    write_sanitized_entry(
                        &mut zip,
                        options,
                        &name,
                        &format!("unavailable: {reason}\n"),
                    )?;
                }
            }
        }
    }

    let sys_info = format!(
        "os: {}\narch: {}\nversion: {}\nclaude_pinned: {}\nwindow: {}, since: {}\n",
        std::env::consts::OS,
        std::env::consts::ARCH,
        env!("SPEEDWAVE_VERSION"),
        speedwave_runtime::defaults::CLAUDE_VERSION,
        window.as_str(),
        speedwave_runtime::log_ts::format_log_timestamp(&since),
    );
    zip.start_file("system-info.txt", options)?;
    zip.write_all(sys_info.as_bytes())?;

    zip.finish()?;
    Ok(())
}

/// Collects app logs, container logs, compose config, and system info of `window` into a
/// sanitized ZIP archive for support diagnostics.
#[tauri::command]
pub(crate) async fn export_diagnostics(project: String, window: String) -> Result<String, String> {
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
        let container_logs = rt.compose_logs(&project, COMPOSE_LOGS_EXPORT_TAIL).ok();

        let data_dir = speedwave_runtime::consts::data_dir();
        let resolve = |key: &str| {
            speedwave_runtime::diagnostic_sources::resolve_file_path(key, data_dir, &project)
        };

        let input = DiagnosticsInput {
            log_dir,
            serial_log: resolve("lima"),
            container_logs,
            mcp_os_log: resolve("mcp-os"),
            compose_path: resolve("compose-yml"),
            claude_session_log: resolve("claude"),
            entrypoint_log: resolve("entrypoint"),
            proxy_usage_log: resolve("proxy-usage"),
        };

        build_diagnostics_zip(&zip_path, &input, &window, chrono::Utc::now())?;

        Ok(zip_path.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "test code asserts via unwrap/expect"
)]
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

    fn now() -> chrono::DateTime<chrono::Utc> {
        chrono::DateTime::parse_from_rfc3339("2026-11-13T12:00:00Z")
            .unwrap()
            .with_timezone(&chrono::Utc)
    }

    fn build_zip(zip_path: &std::path::Path, input: &DiagnosticsInput) -> anyhow::Result<()> {
        build_diagnostics_zip(zip_path, input, "7d", now())
    }

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
            .map(|i| archive.by_index(i).unwrap().name().unwrap().into_owned())
            .collect()
    }

    #[test]
    fn diagnostics_zip_contains_expected_entries() {
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("diag.zip");

        let log_dir = tmp.path().join("logs");
        std::fs::create_dir_all(&log_dir).unwrap();
        std::fs::write(
            log_dir.join("app.log"),
            "2026-11-13T11:00:00.000+00:00 INFO started\n",
        )
        .unwrap();
        std::fs::write(log_dir.join("app.txt"), "ignored").unwrap();

        let compose_path = tmp.path().join("compose.yml");
        std::fs::write(
            &compose_path,
            "version: '3'\nservices:\n  claude:\n    image: test\n",
        )
        .unwrap();

        let usage_path = tmp.path().join("usage.jsonl");
        std::fs::write(
            &usage_path,
            r#"{"ts":"2026-11-13T12:07:28.000+02:00","model":"claude-fable-5","status":"failure","prompt_tokens":2,"completion_tokens":2,"latency_ms":26770}"#,
        )
        .unwrap();
        assert!(usage_path.exists(), "usage.jsonl plant must land on disk");

        let input = DiagnosticsInput {
            log_dir: Some(log_dir),
            serial_log: None,
            container_logs: Some(
                "web  | 2026-11-13T11:00:00.000000000Z container output here\n".into(),
            ),
            mcp_os_log: None,
            compose_path: Some(compose_path),
            claude_session_log: None,
            entrypoint_log: None,
            proxy_usage_log: Some(usage_path),
        };

        build_zip(&zip_path, &input).unwrap();

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
            names.contains(&"proxy/usage.jsonl".to_string()),
            "ZIP should contain proxy usage.jsonl: {names:?}"
        );
        let usage_content = read_zip_entry(&zip_path, "proxy/usage.jsonl").unwrap();
        assert!(
            usage_content.contains("\"status\":\"failure\""),
            "usage.jsonl entry should carry the failure status: {usage_content}"
        );
        assert!(
            names.contains(&"system-info.txt".to_string()),
            "ZIP should contain system info: {names:?}"
        );

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
        assert!(
            sys_info.contains(&format!(
                "claude_pinned: {}",
                speedwave_runtime::defaults::CLAUDE_VERSION
            )),
            "system info should carry the pinned Claude Code version"
        );
    }

    fn empty_input() -> DiagnosticsInput {
        DiagnosticsInput {
            log_dir: None,
            serial_log: None,
            container_logs: None,
            mcp_os_log: None,
            compose_path: None,
            claude_session_log: None,
            entrypoint_log: None,
            proxy_usage_log: None,
        }
    }

    fn all_entries_text(zip_path: &std::path::Path) -> String {
        zip_entry_names(zip_path)
            .iter()
            .filter(|n| *n != "system-info.txt")
            .map(|n| read_zip_entry(zip_path, n).unwrap_or_default())
            .collect()
    }

    #[test]
    fn export_windows_match_ts_mirror() {
        use speedwave_runtime::export_window::ExportWindow;
        let ts = include_str!("../../src/src/app/logs-view/logs-view.component.ts");
        let windows = [
            ExportWindow::Hours2,
            ExportWindow::Hours24,
            ExportWindow::Days7,
            ExportWindow::Days30,
        ];
        let union = windows
            .iter()
            .map(|w| format!("'{}'", w.as_str()))
            .collect::<Vec<_>>()
            .join(" | ");
        assert!(
            ts.contains(&format!("export type ExportWindow = {union};")),
            "ExportWindow union in logs-view.component.ts must list {union}"
        );
        for w in windows {
            assert!(
                ts.contains(&format!("{{ value: '{}', label:", w.as_str())),
                "selector must offer {}",
                w.as_str()
            );
        }
        assert!(
            ts.contains("DEFAULT_EXPORT_WINDOW: ExportWindow = '7d';"),
            "the selector defaults to 7d"
        );
    }

    #[test]
    fn window_keeps_only_lines_inside_it_in_every_timestamp_shape() {
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("diag-window.zip");
        let mk = |name: &str, body: &str| {
            let p = tmp.path().join(name);
            std::fs::write(&p, body).unwrap();
            p
        };

        let log_dir = tmp.path().join("logs");
        std::fs::create_dir_all(&log_dir).unwrap();
        std::fs::write(
            log_dir.join("speedwave-desktop.log"),
            "2026-11-12T13:59:59.999+02:00 [WARN][app] OLD-LOCAL\n  at old.frame\n\
             2026-11-12T14:00:00.000+02:00 [WARN][app] KEPT-LOCAL\n  at kept.frame\n\
             2026-11-12T11:59:59.999+00:00 [WARN][app] OLD-UTC\n\
             2026-11-12T12:00:00.001+00:00 [WARN][app] KEPT-UTC\n",
        )
        .unwrap();

        let mut serial = String::new();
        for i in 0..40_000 {
            serial.push_str(&format!("serial line {i:06} padding padding padding\n"));
        }
        assert!(serial.len() > speedwave_runtime::diagnostic_sources::SERIAL_LOG_EXPORT_BYTES);

        let input = DiagnosticsInput {
            log_dir: Some(log_dir),
            serial_log: Some(mk("serial.log", &serial)),
            container_logs: Some(
                "web  | 2026-11-12T11:59:59.999999999Z OLD-CONTAINER\n\
                 web  | 2026-11-12T12:00:00.000000000Z KEPT-CONTAINER\n\
                 web  |   kept continuation\n"
                    .into(),
            ),
            mcp_os_log: Some(mk(
                "mcp.log",
                "2026-11-12T11:00:00.000+00:00 STDERR: OLD-MCP\n\
                 2026-11-12T15:00:00.000+02:00 STDERR: KEPT-MCP\n",
            )),
            compose_path: Some(mk(
                "compose.yml",
                "# 2020-01-01T00:00:00Z OLD-COMPOSE-WHOLE\nservices: {}\n",
            )),
            claude_session_log: Some(mk(
                "claude.log",
                "2026-11-12T11:59:00.000+00:00 SESSION:ab: OLD-CLAUDE\n\
                 2026-11-12T12:01:00.000+00:00 SESSION:ab: KEPT-CLAUDE\n",
            )),
            entrypoint_log: Some(mk(
                "entrypoint.log",
                "=== speedwave entrypoint header ===\n\
                 2026-11-12T13:00:00+02:00 ERROR OLD-ENTRYPOINT\n\
                 2026-11-12T14:30:00+02:00 ERROR KEPT-ENTRYPOINT\n",
            )),
            proxy_usage_log: Some(mk(
                "usage.jsonl",
                "{\"ts\":\"2026-11-12T13:59:59.000+02:00\",\"n\":\"OLD-USAGE\"}\n\
                 {\"ts\":\"2026-11-12T14:00:01.000+02:00\",\"n\":\"KEPT-USAGE\"}\n",
            )),
        };

        build_diagnostics_zip(&zip_path, &input, "24h", now()).unwrap();

        let text = all_entries_text(&zip_path);
        for kept in [
            "KEPT-LOCAL",
            "kept.frame",
            "KEPT-UTC",
            "KEPT-CONTAINER",
            "kept continuation",
            "KEPT-MCP",
            "KEPT-CLAUDE",
            "KEPT-ENTRYPOINT",
            "KEPT-USAGE",
            "OLD-COMPOSE-WHOLE",
        ] {
            assert!(text.contains(kept), "{kept} missing from the ZIP: {text}");
        }
        for old in [
            "OLD-LOCAL",
            "old.frame",
            "OLD-UTC",
            "OLD-CONTAINER",
            "OLD-MCP",
            "OLD-CLAUDE",
            "OLD-ENTRYPOINT",
            "OLD-USAGE",
            "entrypoint header",
        ] {
            assert!(!text.contains(old), "{old} leaked into the ZIP: {text}");
        }

        let serial_out = read_zip_entry(&zip_path, "lima/serial.log").unwrap();
        assert!(
            serial_out.len() <= speedwave_runtime::diagnostic_sources::SERIAL_LOG_EXPORT_BYTES,
            "{}",
            serial_out.len()
        );
        assert!(serial_out.ends_with("serial line 039999 padding padding padding\n"));
        assert!(serial_out.starts_with("serial line "));

        let sys_info = read_zip_entry(&zip_path, "system-info.txt").unwrap();
        assert!(
            sys_info.contains("window: 24h, since: 2026-11-12T12:00:00.000+00:00\n"),
            "{sys_info}"
        );
    }

    #[test]
    fn window_values_move_the_boundary() {
        let tmp = tempfile::tempdir().unwrap();
        let log = tmp.path().join("mcp.log");
        std::fs::write(
            &log,
            "2026-10-13T11:00:00.000+00:00 AGE-31D\n\
             2026-11-05T11:00:00.000+00:00 AGE-8D\n\
             2026-11-07T11:00:00.000+00:00 AGE-6D\n\
             2026-11-12T11:00:00.000+00:00 AGE-25H\n\
             2026-11-13T09:00:00.000+00:00 AGE-3H\n\
             2026-11-13T11:00:00.000+00:00 AGE-1H\n",
        )
        .unwrap();
        let mut input = empty_input();
        input.mcp_os_log = Some(log);
        let entry = format!("mcp-os/{}", speedwave_runtime::consts::MCP_OS_LOG_FILE);

        let ages = |window: &str| -> Vec<String> {
            let zip_path = tmp.path().join(format!("diag-{window}.zip"));
            build_diagnostics_zip(&zip_path, &input, window, now()).unwrap();
            read_zip_entry(&zip_path, &entry)
                .unwrap()
                .lines()
                .map(|l| l.rsplit(' ').next().unwrap().to_string())
                .collect()
        };

        assert_eq!(ages("2h"), ["AGE-1H"]);
        assert_eq!(ages("24h"), ["AGE-3H", "AGE-1H"]);
        assert_eq!(ages("7d"), ["AGE-6D", "AGE-25H", "AGE-3H", "AGE-1H"]);
        assert_eq!(ages("30d").len(), 5);
    }

    #[test]
    fn unknown_window_is_an_error_and_writes_no_zip() {
        let tmp = tempfile::tempdir().unwrap();
        for bad in ["3d", "7D", "", "all", "7d "] {
            let zip_path = tmp.path().join("diag-bad.zip");
            let err = build_diagnostics_zip(&zip_path, &empty_input(), bad, now()).unwrap_err();
            assert!(err.to_string().contains("unknown export window"), "{err}");
            assert!(!zip_path.exists(), "no ZIP for window '{bad}'");
        }
    }

    #[test]
    fn rotated_file_named_before_the_window_is_skipped_whatever_it_holds() {
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("diag-rotated.zip");
        let log_dir = tmp.path().join("logs");
        std::fs::create_dir_all(&log_dir).unwrap();
        let in_window = "2026-11-13T11:00:00.000+00:00 [INFO][app] STAMPED-IN-WINDOW\n";
        for name in [
            "speedwave-desktop.log",
            "speedwave-desktop_2026-11-13_10-00-00.log",
            "speedwave-desktop_2026-11-01_00-00-00.log",
        ] {
            std::fs::write(log_dir.join(name), in_window).unwrap();
        }
        let mut input = empty_input();
        input.log_dir = Some(log_dir);

        build_diagnostics_zip(&zip_path, &input, "24h", now()).unwrap();

        assert_eq!(
            zip_entry_names(&zip_path),
            [
                "logs/speedwave-desktop.log",
                "logs/speedwave-desktop_2026-11-13_10-00-00.log",
                "system-info.txt",
            ]
        );
    }

    #[test]
    fn a_file_without_a_stamp_before_its_first_stamped_line_loses_those_lines() {
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("diag-unstamped.zip");
        let log_dir = tmp.path().join("logs");
        std::fs::create_dir_all(&log_dir).unwrap();
        std::fs::write(
            log_dir.join("app.log"),
            "UNSTAMPED-HEAD\n2026-11-13T11:00:00.000+00:00 STAMPED\n  continuation\n",
        )
        .unwrap();
        let mut input = empty_input();
        input.log_dir = Some(log_dir);

        build_diagnostics_zip(&zip_path, &input, "7d", now()).unwrap();

        let content = read_zip_entry(&zip_path, "logs/app.log").unwrap();
        assert_eq!(
            content,
            "2026-11-13T11:00:00.000+00:00 STAMPED\n  continuation\n"
        );
    }

    #[test]
    fn secrets_in_lines_inside_the_window_are_still_masked() {
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("diag-window-redact.zip");
        let mut input = empty_input();
        input.container_logs = Some(
            "web | 2026-11-13T11:00:00.000000000Z Authorization: Bearer window-secret-token\n"
                .into(),
        );

        build_diagnostics_zip(&zip_path, &input, "2h", now()).unwrap();

        let content = read_zip_entry(&zip_path, "containers/compose.log").unwrap();
        assert!(!content.contains("window-secret-token"), "{content}");
        assert!(content.contains("***REDACTED***"), "{content}");
    }

    #[test]
    fn diagnostics_zip_redacts_secrets_in_logs() {
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("diag-redact.zip");

        let log_dir = tmp.path().join("logs");
        std::fs::create_dir_all(&log_dir).unwrap();
        std::fs::write(
            log_dir.join("app.log"),
            "2026-11-13T11:00:00.000+00:00 Auth: Bearer sk-ant-super-secret-key-12345\n2026-11-13T11:00:00.000+00:00 Slack token: xoxb-slack-secret-token\n",
        )
        .unwrap();

        let input = DiagnosticsInput {
            log_dir: Some(log_dir),
            serial_log: None,
            container_logs: Some(format!(
                "web  | 2026-11-13T11:00:00.000000000Z JWT: {}.{}.signature123\n",
                "eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0"
            )),
            mcp_os_log: None,
            compose_path: None,
            claude_session_log: None,
            entrypoint_log: None,
            proxy_usage_log: None,
        };

        build_zip(&zip_path, &input).unwrap();

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
            entrypoint_log: None,
            proxy_usage_log: None,
        };

        build_zip(&zip_path, &input).unwrap();

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

        let log_dir = tmp.path().join("logs");
        std::fs::create_dir_all(&log_dir).unwrap();
        std::fs::write(
            log_dir.join("app.log"),
            "2026-11-13T11:00:00.000+00:00 normal log\n",
        )
        .unwrap();
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
            entrypoint_log: None,
            proxy_usage_log: None,
        };

        build_zip(&zip_path, &input).unwrap();

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
            entrypoint_log: None,
            proxy_usage_log: None,
        };

        build_zip(&zip_path, &input).unwrap();

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
            entrypoint_log: None,
            proxy_usage_log: None,
        };

        build_zip(&zip_path, &input).unwrap();

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
        std::fs::write(
            &mcp_os_log,
            "2026-11-13T11:00:00.000+00:00 mcp-os log content\n",
        )
        .unwrap();

        let input = DiagnosticsInput {
            log_dir: None,
            serial_log: None,
            container_logs: None,
            mcp_os_log: Some(mcp_os_log),
            compose_path: None,
            claude_session_log: None,
            entrypoint_log: None,
            proxy_usage_log: None,
        };

        build_zip(&zip_path, &input).unwrap();

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
            "2026-11-13T11:00:00.000+00:00 SESSION:ab: started\n2026-11-13T11:00:00.000+00:00 TOOL:ab: start: Read (toolu_01)\n",
        )
        .unwrap();

        let input = DiagnosticsInput {
            log_dir: None,
            serial_log: None,
            container_logs: None,
            mcp_os_log: None,
            compose_path: None,
            claude_session_log: Some(session_log),
            entrypoint_log: None,
            proxy_usage_log: None,
        };

        build_zip(&zip_path, &input).unwrap();

        let names = zip_entry_names(&zip_path);
        assert!(
            names.contains(&"claude/claude-session.log".to_string()),
            "ZIP should contain claude session log: {names:?}"
        );

        let content = read_zip_entry(&zip_path, "claude/claude-session.log").unwrap();
        assert!(
            content.contains("SESSION:ab: started"),
            "content: {content}"
        );
        assert!(content.contains("TOOL:ab: start"), "content: {content}");
    }

    #[test]
    fn diagnostics_zip_includes_entrypoint_log() {
        let tmp = tempfile::tempdir().unwrap();
        let log = tmp.path().join(".speedwave-entrypoint.log");
        std::fs::write(
            &log,
            "2026-11-13T12:00:01+02:00 ERROR FAIL example-plugin: clone failed\n",
        )
        .unwrap();
        let out = tmp.path().join("diag.zip");
        let input = DiagnosticsInput {
            log_dir: None,
            serial_log: None,
            container_logs: None,
            mcp_os_log: None,
            compose_path: None,
            claude_session_log: None,
            entrypoint_log: Some(log),
            proxy_usage_log: None,
        };
        build_zip(&out, &input).unwrap();

        let names = zip_entry_names(&out);
        assert!(
            names.iter().any(|n| n == "claude/entrypoint.log"),
            "got: {names:?}"
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
            "2026-11-13T11:00:00.000+00:00 desktop sk-ant-deadbeefdeadbeefdeadbeef\n",
        )
        .unwrap();
        let stamp = "2026-11-13T11:00:00.000+00:00";
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
            "xoxp-another-secret-token-value",
            "Bearer sk-ant-api03-usagejsonlleaktoken0000",
        ];
        let input = DiagnosticsInput {
            log_dir: Some(log_dir),
            serial_log: Some(mk("serial.log", secrets[1])),
            container_logs: Some(format!(
                "web | 2026-11-13T11:00:00.000000000Z {}\n",
                secrets[2]
            )),
            mcp_os_log: Some(mk("mcp.log", &format!("{stamp} {}\n", secrets[3]))),
            compose_path: Some(mk("compose.yml", secrets[0])),
            claude_session_log: Some(mk("claude.log", &format!("{stamp} {}\n", secrets[4]))),
            entrypoint_log: Some(mk("entrypoint.log", &format!("{stamp} {}\n", secrets[5]))),
            proxy_usage_log: Some(mk(
                "usage.jsonl",
                &format!("{{\"ts\":\"{stamp}\",\"note\":\"{}\"}}\n", secrets[6]),
            )),
        };
        build_zip(&zip_path, &input).unwrap();

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

    /// An unreadable source must leave a visible `.unavailable.txt` placeholder
    /// instead of silently vanishing; readable sources next to it are unaffected.
    #[test]
    fn diagnostics_zip_records_placeholder_for_unreadable_source() {
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("diag-unavailable.zip");

        let unreadable = tmp.path().join("compose.yml");
        std::fs::create_dir(&unreadable).unwrap();
        let readable = tmp.path().join("mcp.log");
        std::fs::write(&readable, "mcp-os log content").unwrap();

        let input = DiagnosticsInput {
            log_dir: None,
            serial_log: None,
            container_logs: None,
            mcp_os_log: Some(readable),
            compose_path: Some(unreadable),
            claude_session_log: None,
            entrypoint_log: None,
            proxy_usage_log: None,
        };
        build_zip(&zip_path, &input).unwrap();

        let names = zip_entry_names(&zip_path);
        assert!(
            names.contains(&"containers/compose.yml.unavailable.txt".to_string()),
            "unreadable source must leave a placeholder entry: {names:?}"
        );
        assert!(
            !names.contains(&"containers/compose.yml".to_string()),
            "no regular entry for the unreadable source: {names:?}"
        );
        let placeholder =
            read_zip_entry(&zip_path, "containers/compose.yml.unavailable.txt").unwrap();
        assert!(
            placeholder.starts_with("unavailable: "),
            "placeholder must carry the reason: {placeholder}"
        );

        let mcp_entry = format!("mcp-os/{}", speedwave_runtime::consts::MCP_OS_LOG_FILE);
        assert!(
            names.contains(&mcp_entry),
            "readable source must be packed unchanged: {names:?}"
        );
        let placeholders: Vec<&String> = names
            .iter()
            .filter(|n| n.ends_with(".unavailable.txt"))
            .collect();
        assert_eq!(
            placeholders,
            vec!["containers/compose.yml.unavailable.txt"],
            "only the unreadable source gets a placeholder"
        );
    }

    /// Placeholder contract for the proxy usage-log source, mirroring the other
    /// single-file sources.
    #[test]
    fn diagnostics_zip_proxy_usage_records_placeholder_when_unreadable() {
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("diag-usage-unavailable.zip");

        let unreadable = tmp.path().join("usage.jsonl");
        std::fs::create_dir(&unreadable).unwrap();

        let input = DiagnosticsInput {
            log_dir: None,
            serial_log: None,
            container_logs: None,
            mcp_os_log: None,
            compose_path: None,
            claude_session_log: None,
            entrypoint_log: None,
            proxy_usage_log: Some(unreadable),
        };
        build_zip(&zip_path, &input).unwrap();

        let names = zip_entry_names(&zip_path);
        assert!(
            names.contains(&"proxy/usage.jsonl.unavailable.txt".to_string()),
            "unreadable source must leave a placeholder entry: {names:?}"
        );
        assert!(
            !names.contains(&"proxy/usage.jsonl".to_string()),
            "no regular entry for the unreadable source: {names:?}"
        );
        let placeholder = read_zip_entry(&zip_path, "proxy/usage.jsonl.unavailable.txt").unwrap();
        assert!(
            placeholder.starts_with("unavailable: "),
            "placeholder must carry the reason: {placeholder}"
        );
    }

    /// A missing source stays absent: no entry AND no placeholder.
    #[test]
    fn diagnostics_zip_missing_source_leaves_no_placeholder() {
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("diag-missing.zip");
        let input = DiagnosticsInput {
            log_dir: None,
            serial_log: Some(tmp.path().join("nope.log")),
            container_logs: None,
            mcp_os_log: None,
            compose_path: None,
            claude_session_log: None,
            entrypoint_log: None,
            proxy_usage_log: Some(tmp.path().join("nope.jsonl")),
        };
        build_zip(&zip_path, &input).unwrap();
        let names = zip_entry_names(&zip_path);
        assert_eq!(
            names,
            vec!["system-info.txt"],
            "a missing source must leave neither entry nor placeholder"
        );
    }

    /// The failure reason embeds the source path; it must pass the sanitizer
    /// before landing in the placeholder entry.
    #[test]
    fn diagnostics_zip_placeholder_reason_is_sanitized() {
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("diag-placeholder-redact.zip");
        let unreadable = tmp.path().join("xoxb-1234567890-abcdefghij");
        std::fs::create_dir(&unreadable).unwrap();
        let input = DiagnosticsInput {
            log_dir: None,
            serial_log: None,
            container_logs: None,
            mcp_os_log: None,
            compose_path: Some(unreadable),
            claude_session_log: None,
            entrypoint_log: None,
            proxy_usage_log: None,
        };
        build_zip(&zip_path, &input).unwrap();
        let placeholder =
            read_zip_entry(&zip_path, "containers/compose.yml.unavailable.txt").unwrap();
        assert!(
            !placeholder.contains("xoxb-1234567890-abcdefghij"),
            "placeholder reason must be sanitized: {placeholder}"
        );
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
            compose_path: Some(mk("compose.yml")),
            claude_session_log: Some(mk("claude.log")),
            entrypoint_log: Some(mk("entrypoint.log")),
            proxy_usage_log: Some(mk("usage.jsonl")),
        };
        build_zip(&zip_path, &input).unwrap();

        let registry_entries: Vec<&str> = DIAGNOSTIC_SOURCES.iter().map(|s| s.zip_entry).collect();
        for name in zip_entry_names(&zip_path) {
            let traced = name == "system-info.txt"
                || name.starts_with("logs/")
                || registry_entries.contains(&name.as_str())
                || name
                    .strip_suffix(".unavailable.txt")
                    .is_some_and(|base| registry_entries.contains(&base));
            assert!(
                traced,
                "ZIP entry '{name}' does not trace to any DIAGNOSTIC_SOURCES.zip_entry"
            );
        }
    }
}
