// Tauri commands for the unified `/logs` view (`get_all_logs`).

use crate::logging_cmd::desktop_log_dir;
use crate::types::check_project;

/// Read a log file, take the last `tail` lines, and sanitize secrets.
/// Returns an empty string if the file does not exist.
fn read_tail_sanitized(path: &std::path::Path, tail: usize) -> Result<String, String> {
    // claude-home is container-writable: a symlinked source could pull an
    // arbitrary host file (e.g. a token) into /logs and the diagnostics ZIP.
    match std::fs::symlink_metadata(path) {
        Ok(meta) if !meta.file_type().is_file() => {
            return Err(format!("not a regular file: {}", path.display()));
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        _ => {}
    }
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        Err(e) => return Err(format!("Failed to read log file: {e}")),
    };
    let lines: Vec<&str> = content.lines().collect();
    let start = lines.len().saturating_sub(tail);
    Ok(speedwave_runtime::log_sanitizer::sanitize(
        &lines[start..].join("\n"),
    ))
}

// Reads all `speedwave-desktop*.log` segments (tauri-plugin-log rotates them).
fn read_tail_desktop_logs(dir: &std::path::Path, tail: usize) -> String {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) => {
            log::warn!(
                "failed to read desktop log directory {}: {e}",
                dir.display()
            );
            return String::new();
        }
    };
    let mut files: Vec<(std::path::PathBuf, std::time::SystemTime)> = entries
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            let name = p.file_name()?.to_str()?.to_string();
            if !name.starts_with("speedwave-desktop") || !name.ends_with(".log") {
                return None;
            }
            let mtime = e.metadata().ok()?.modified().ok()?;
            Some((p, mtime))
        })
        .collect();
    files.sort_by_key(|(_, m)| *m);
    let mut combined: Vec<String> = Vec::new();
    for (path, _) in files {
        match std::fs::read_to_string(&path) {
            Ok(content) => combined.extend(content.lines().map(str::to_string)),
            Err(e) => log::warn!("failed to read desktop log file {}: {e}", path.display()),
        }
    }
    let start = combined.len().saturating_sub(tail);
    speedwave_runtime::log_sanitizer::sanitize(&combined[start..].join("\n"))
}

// ── Unified `/logs` view — merge of every log source the app produces ──
// Frontend `parseLogLine` expects `<source> | <rest>`; host files reformat via `prefix_lines`.

/// Returns true when the line already carries a `<source-token> | …` prefix
/// that the frontend parser will recognise.
fn has_source_prefix(line: &str) -> bool {
    let bytes = line.as_bytes();
    if bytes.is_empty() {
        return false;
    }
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        let is_word_char = c.is_ascii_alphanumeric() || c == b'_' || c == b'.' || c == b'-';
        if !is_word_char {
            break;
        }
        i += 1;
    }
    if i == 0 {
        return false;
    }
    // Skip optional whitespace before `|` (matches frontend `\s*\|`).
    while i < bytes.len() && (bytes[i] == b' ' || bytes[i] == b'\t') {
        i += 1;
    }
    i < bytes.len() && bytes[i] == b'|'
}

/// Rewrites tauri-plugin-log's bracketed level (`[INFO]`) into the unbracketed form Angular's
/// `LEVEL_RE` expects. Returns the line unchanged when it doesn't match the expected layout.
fn rewrite_desktop_bracketed_level(line: &str) -> String {
    // ISO timestamp ends at the first space (it contains no spaces).
    let Some(space_idx) = line.find(' ') else {
        return line.to_string();
    };
    let after_ts = &line[space_idx + 1..];
    if !after_ts.starts_with('[') {
        return line.to_string();
    }
    let Some(close_idx) = after_ts.find(']') else {
        return line.to_string();
    };
    let level = &after_ts[1..close_idx];
    if !matches!(
        level,
        "DEBUG" | "INFO" | "WARN" | "WARNING" | "ERROR" | "TRACE"
    ) {
        return line.to_string();
    }
    // Frontend `LEVEL_RE` requires a space after the level word.
    let before = &line[..space_idx];
    let after = &after_ts[close_idx + 1..];
    format!("{before} {level} {after}")
}

/// Reformats one log source to the frontend's `<source> | <rest>` contract: drops empty lines,
/// strips compose lines' project prefix (if given), prefixes others, rewrites desktop-log level
pub(crate) fn prefix_lines(source: &str, raw: &str, project: Option<&str>) -> String {
    let mut out = String::with_capacity(raw.len() + raw.lines().count() * (source.len() + 4));
    for line in raw.split('\n') {
        if line.is_empty() {
            continue;
        }
        if has_source_prefix(line) {
            if let Some(proj) = project {
                if let Some((container, rest)) = line.split_once(" | ") {
                    let normalised =
                        speedwave_runtime::consts::strip_compose_container_prefix(container, proj);
                    out.push_str(normalised);
                    out.push_str(" | ");
                    out.push_str(rest);
                    out.push('\n');
                    continue;
                }
            }
            out.push_str(line);
            out.push('\n');
            continue;
        }
        let normalized = if source == "desktop" {
            rewrite_desktop_bracketed_level(line)
        } else {
            line.to_string()
        };
        out.push_str(source);
        out.push_str(" | ");
        out.push_str(&normalized);
        out.push('\n');
    }
    out
}

/// Inputs to `merge_log_sources`. Held as owned strings so the merge function
/// is pure (no IO) and testable without filesystem fixtures.
pub(crate) struct LogSources {
    pub compose: String,
    pub desktop: String,
    pub mcp_os: String,
    pub claude: String,
    /// Lima VM serial log (macOS only; empty elsewhere).
    pub lima: String,
    pub entrypoint: String,
}

/// Concatenates the per-source log buffers into one newline-separated string in deterministic
/// source order. Chronological interleaving is the frontend's job (`sortLogLinesByTime`).
pub(crate) fn merge_log_sources(sources: LogSources, project: &str) -> String {
    let compose = prefix_lines("compose", &sources.compose, Some(project));
    let desktop = prefix_lines("desktop", &sources.desktop, None);
    let mcp_os = prefix_lines("mcp-os", &sources.mcp_os, None);
    let claude = prefix_lines("claude", &sources.claude, None);
    let lima = prefix_lines("lima", &sources.lima, None);
    let entrypoint = prefix_lines("entrypoint", &sources.entrypoint, None);

    // Defence-in-depth sanitizer pass over the merged buffer (idempotent).
    speedwave_runtime::log_sanitizer::sanitize(&format!(
        "{compose}{desktop}{mcp_os}{claude}{lima}{entrypoint}"
    ))
}

/// Compose-logs fetch timeout; a busy container engine must not blank the
/// file-based sources.
const COMPOSE_LOGS_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// Single-flight marker: a compose-logs fetch survives its timeout as a
/// detached task; polls must not stack more nerdctl processes behind it.
static COMPOSE_LOGS_IN_FLIGHT: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// Synthetic `compose | …` WARN line shown while container logs are unreachable.
fn compose_busy_marker() -> String {
    format!(
        "compose | {} WARN  container logs unavailable while the container engine is busy — retrying on the next refresh\n",
        speedwave_runtime::log_ts::log_timestamp(),
    )
}

/// Fetches compose logs with a timeout and single-flight guard; falls back to
/// `compose_busy_marker()` instead of blocking the merged view.
async fn fetch_compose_logs_bounded(project: String, tail: u32) -> String {
    use std::sync::atomic::Ordering;
    if COMPOSE_LOGS_IN_FLIGHT
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return compose_busy_marker();
    }
    struct InFlightGuard;
    impl Drop for InFlightGuard {
        fn drop(&mut self) {
            COMPOSE_LOGS_IN_FLIGHT.store(false, std::sync::atomic::Ordering::SeqCst);
        }
    }
    let handle = tokio::task::spawn_blocking(move || {
        let _guard = InFlightGuard;
        let rt = speedwave_runtime::runtime::detect_runtime();
        // best-effort; missing runtime should not blank the whole view
        if rt.is_available() {
            rt.compose_logs(&project, tail).unwrap_or_default()
        } else {
            String::new()
        }
    });
    match tokio::time::timeout(COMPOSE_LOGS_TIMEOUT, handle).await {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => {
            log::warn!("compose logs task failed: {e}");
            String::new()
        }
        // The detached task clears the in-flight flag when it eventually ends.
        Err(_) => {
            log::warn!("compose logs timed out — container engine busy");
            compose_busy_marker()
        }
    }
}

#[tauri::command]
pub(crate) async fn get_all_logs(project: String, tail: Option<u32>) -> Result<String, String> {
    check_project(&project)?;
    let tail_u32 = tail.unwrap_or(200).min(10_000);
    let tail_us = tail_u32 as usize;

    let compose = fetch_compose_logs_bounded(project.clone(), tail_u32).await;

    tokio::task::spawn_blocking(move || -> Result<String, String> {
        let desktop = match desktop_log_dir() {
            Some(dir) => read_tail_desktop_logs(&dir, tail_us),
            None => String::new(),
        };

        // File-source paths resolved from the SSOT registry (platform-gated).
        let data_dir = speedwave_runtime::consts::data_dir();
        let read_source = |key: &str| -> String {
            speedwave_runtime::diagnostic_sources::resolve_file_path(key, data_dir, &project)
                .map(|p| read_tail_sanitized(&p, tail_us).unwrap_or_default())
                .unwrap_or_default()
        };

        Ok(merge_log_sources(
            LogSources {
                compose,
                desktop,
                mcp_os: read_source("mcp-os"),
                claude: read_source("claude"),
                lima: read_source("lima"),
                entrypoint: read_source("entrypoint"),
            },
            &project,
        ))
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── Tests ──

#[cfg(test)]
#[expect(clippy::unwrap_used, reason = "test assertions may unwrap freely")]
mod tests {
    use super::*;

    // -- Log sanitization tests (compose / container log content) --

    #[test]
    fn container_logs_sanitize_bearer_token() {
        let raw = "2024-01-15 INFO  Calling API with Bearer sk-ant-api03-secret123\nDone.";
        let sanitized = speedwave_runtime::log_sanitizer::sanitize(raw);
        assert!(
            !sanitized.contains("sk-ant-api03-secret123"),
            "Bearer token should be redacted in container logs: {sanitized}"
        );
        assert!(
            sanitized.contains("Bearer ***REDACTED***"),
            "Should contain redacted marker: {sanitized}"
        );
        assert!(
            sanitized.contains("Done."),
            "Non-secret content should remain: {sanitized}"
        );
    }

    #[test]
    fn container_logs_sanitize_slack_token() {
        let raw = "mcp-hub | Connecting with token xoxb-1234567890-abcdefghij";
        let sanitized = speedwave_runtime::log_sanitizer::sanitize(raw);
        assert!(
            !sanitized.contains("xoxb-1234567890-abcdefghij"),
            "Slack token should be redacted in container logs: {sanitized}"
        );
        assert!(
            sanitized.contains("***REDACTED_SLACK_TOKEN***"),
            "Should contain Slack redacted marker: {sanitized}"
        );
    }

    #[test]
    fn container_logs_sanitize_api_key_assignment() {
        let raw = "Config loaded: api_key=sk-proj-abc123def456 endpoint=https://api.example.com";
        let sanitized = speedwave_runtime::log_sanitizer::sanitize(raw);
        assert!(
            !sanitized.contains("sk-proj-abc123def456"),
            "API key should be redacted in container logs: {sanitized}"
        );
        assert!(
            sanitized.contains("api_key=***REDACTED***"),
            "Should contain redacted api_key: {sanitized}"
        );
        assert!(
            sanitized.contains("https://api.example.com"),
            "Non-secret content should remain: {sanitized}"
        );
    }

    #[test]
    fn compose_logs_sanitize_bearer_token() {
        let raw = concat!(
            "claude_1  | Starting session\n",
            "mcp_hub_1 | Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig123\n",
            "mcp_hub_1 | Ready\n"
        );
        let sanitized = speedwave_runtime::log_sanitizer::sanitize(raw);
        assert!(
            !sanitized.contains("eyJhbGciOiJIUzI1NiJ9"),
            "JWT in compose logs should be redacted: {sanitized}"
        );
        assert!(
            sanitized.contains("Starting session"),
            "Non-secret lines should remain: {sanitized}"
        );
        assert!(
            sanitized.contains("Ready"),
            "Non-secret lines should remain: {sanitized}"
        );
    }

    #[test]
    fn compose_logs_sanitize_multiple_secrets() {
        let raw = concat!(
            "hub | password=hunter2 connecting\n",
            "hub | using token xoxb-slack-secret-token\n",
            "hub | Bearer my-bearer-token in header\n",
        );
        let sanitized = speedwave_runtime::log_sanitizer::sanitize(raw);
        assert!(
            !sanitized.contains("hunter2"),
            "Password should be redacted: {sanitized}"
        );
        assert!(
            !sanitized.contains("xoxb-slack-secret-token"),
            "Slack token should be redacted: {sanitized}"
        );
        assert!(
            !sanitized.contains("my-bearer-token"),
            "Bearer token should be redacted: {sanitized}"
        );
    }

    #[test]
    fn container_logs_sanitize_plain_text_unchanged() {
        let raw = "2024-01-15 INFO  Container started successfully on port 4000\nHealthcheck OK";
        let sanitized = speedwave_runtime::log_sanitizer::sanitize(raw);
        assert_eq!(
            sanitized, raw,
            "Plain log lines without secrets should pass through unchanged"
        );
    }

    // -- read_tail_sanitized --

    #[cfg(unix)]
    #[test]
    fn read_tail_sanitized_refuses_a_symlinked_source() {
        let tmp = tempfile::tempdir().unwrap();
        let secret = tmp.path().join("secret.txt");
        std::fs::write(&secret, "sk-ant-SECRET\n").unwrap();
        let link = tmp.path().join("entrypoint.log");
        std::os::unix::fs::symlink(&secret, &link).unwrap();

        let out = read_tail_sanitized(&link, 100);
        assert!(
            out.is_err() || !out.unwrap().contains("SECRET"),
            "a symlinked log source must not be followed"
        );
    }

    #[test]
    fn read_tail_sanitized_returns_empty_for_missing_file() {
        let path = std::path::Path::new("/tmp/nonexistent-speedwave-test/claude-session.log");
        let result = read_tail_sanitized(path, 200).unwrap();
        assert_eq!(result, "");
    }

    #[test]
    fn read_tail_sanitized_reads_and_sanitizes() {
        let tmp = tempfile::tempdir().unwrap();
        let log_content = "2026-04-07T14:30:00.000+02:00 SESSION: started\n2026-04-07T14:30:01.000+02:00 STDERR: Bearer sk-ant-secret-key-abc\n2026-04-07T14:30:02.000+02:00 SESSION: stopped\n";
        let log_path = tmp.path().join("claude-session.log");
        std::fs::write(&log_path, log_content).unwrap();

        let result = read_tail_sanitized(&log_path, 200).unwrap();

        assert!(
            result.contains("SESSION: started"),
            "should contain session markers: {result}"
        );
        assert!(
            !result.contains("sk-ant-secret-key-abc"),
            "should redact bearer tokens: {result}"
        );
    }

    #[test]
    fn read_tail_sanitized_respects_tail_limit() {
        let tmp = tempfile::tempdir().unwrap();
        let log_path = tmp.path().join("test.log");
        std::fs::write(&log_path, "line1\nline2\nline3\nline4\nline5\n").unwrap();

        let result = read_tail_sanitized(&log_path, 2).unwrap();
        assert!(!result.contains("line3"), "should only have last 2 lines");
        assert!(result.contains("line4"), "result: {result}");
        assert!(result.contains("line5"), "result: {result}");
    }

    // -- has_source_prefix tests --

    #[test]
    fn has_source_prefix_matches_compose_container_format() {
        // What `nerdctl compose logs` emits — must pass through unchanged.
        assert!(has_source_prefix("speedwave_acme_mcp_hub | hello"));
        assert!(has_source_prefix("claude_1 | INFO foo"));
        assert!(has_source_prefix("a.b-c | x"));
    }

    #[test]
    fn has_source_prefix_rejects_lines_without_pipe() {
        assert!(!has_source_prefix("plain log line without pipe"));
        assert!(!has_source_prefix("2026-05-06T19:58:38 INFO msg"));
    }

    #[test]
    fn has_source_prefix_rejects_empty_token() {
        // `| no-source` would put an empty source token in the dropdown — guard against it
        assert!(!has_source_prefix("| only pipe"));
        assert!(!has_source_prefix(" | leading-space"));
    }

    #[test]
    fn has_source_prefix_rejects_token_with_spaces() {
        // Token chars are `[\w.-]`; any space inside the token portion fails.
        assert!(!has_source_prefix("a b | c"));
    }

    // -- rewrite_desktop_bracketed_level tests --

    #[test]
    fn rewrite_desktop_level_unwraps_known_levels() {
        let line = "2026-05-06T19:58:38.724+0200 [INFO][speedwave_desktop::integrations_cmd] hi";
        let out = rewrite_desktop_bracketed_level(line);
        assert_eq!(
            out,
            "2026-05-06T19:58:38.724+0200 INFO [speedwave_desktop::integrations_cmd] hi"
        );
    }

    #[test]
    fn rewrite_desktop_level_supports_warn_error_debug_trace_warning() {
        for lvl in ["DEBUG", "INFO", "WARN", "WARNING", "ERROR", "TRACE"] {
            let line = format!("2026-05-06T19:58:38.724+0200 [{lvl}][target] msg");
            let out = rewrite_desktop_bracketed_level(&line);
            assert!(
                out.contains(&format!(" {lvl} [target]")),
                "expected unbracketed {lvl} with trailing space (frontend LEVEL_RE needs \\s+), got: {out}"
            );
        }
    }

    #[test]
    fn rewrite_desktop_level_handles_colon_offset_timestamp() {
        // RFC-3339 colon-offset `+02:00` has no space, so the split lands at `[LEVEL]`.
        let line = "2026-05-12T14:34:02.814+02:00 [WARN][speedwave_desktop::x] msg";
        let out = rewrite_desktop_bracketed_level(line);
        assert_eq!(
            out,
            "2026-05-12T14:34:02.814+02:00 WARN [speedwave_desktop::x] msg"
        );
    }

    #[test]
    fn rewrite_desktop_level_passes_through_unknown_levels() {
        // `[VERBOSE]` is not a recognised log level — line must pass unchanged.
        let line = "2026-05-06T19:58:38 [VERBOSE][x] msg";
        assert_eq!(rewrite_desktop_bracketed_level(line), line);
    }

    #[test]
    fn rewrite_desktop_level_passes_through_lines_without_timestamp() {
        // Multi-line stack traces, banners, etc.
        let line = "stack trace continued";
        assert_eq!(rewrite_desktop_bracketed_level(line), line);
    }

    // -- prefix_lines tests --

    #[test]
    fn prefix_lines_passthrough_for_compose_format_when_no_project() {
        let raw = "claude_1 | hello\nmcp_hub_1 | world";
        let out = prefix_lines("compose", raw, None);
        // With no project supplied, compose lines pass through verbatim.
        assert!(out.contains("claude_1 | hello"));
        assert!(out.contains("mcp_hub_1 | world"));
        assert!(!out.contains("compose | claude_1"));
    }

    #[test]
    fn prefix_lines_strips_compose_project_prefix_when_project_supplied() {
        let prefix = speedwave_runtime::consts::compose_prefix();
        let raw = format!("{prefix}_my_proj_mcp_hub | line a\nother_container | line b");
        let out = prefix_lines("compose", &raw, Some("my_proj"));
        assert!(
            out.contains("mcp_hub | line a"),
            "prefix must be stripped, got: {out}"
        );
        assert!(
            out.contains("other_container | line b"),
            "unrelated container survives, got: {out}"
        );
        assert!(!out.contains(&format!("{prefix}_my_proj_mcp_hub | line a")));
    }

    #[test]
    fn prefix_lines_prepends_source_for_plain_lines() {
        let raw = "2026-05-06T19:58:38 INFO mcp-os started\nready";
        let out = prefix_lines("mcp-os", raw, None);
        assert!(out.contains("mcp-os | 2026-05-06T19:58:38 INFO mcp-os started"));
        assert!(out.contains("mcp-os | ready"));
    }

    #[test]
    fn prefix_lines_rewrites_desktop_bracketed_level() {
        let raw = "2026-05-06T19:58:38.724+0200 [INFO][speedwave_desktop::integrations_cmd] hi";
        let out = prefix_lines("desktop", raw, None);
        assert!(
            out.contains("desktop | 2026-05-06T19:58:38.724+0200 INFO [speedwave_desktop::integrations_cmd] hi"),
            "expected unwrapped level + desktop prefix, got: {out}"
        );
    }

    #[test]
    fn prefix_lines_skips_empty_lines() {
        let raw = "first\n\nsecond\n";
        let out = prefix_lines("desktop", raw, None);
        let pipe_count = out.matches("desktop | ").count();
        assert_eq!(pipe_count, 2, "expected 2 prefixed lines, got: {out}");
    }

    #[test]
    fn prefix_lines_does_not_double_rewrite_when_source_is_not_desktop() {
        let raw = "2026-05-06T19:58:38 [INFO] foo";
        let out = prefix_lines("mcp-os", raw, None);
        assert!(
            out.contains("mcp-os | 2026-05-06T19:58:38 [INFO] foo"),
            "non-desktop source must NOT unwrap brackets; got: {out}"
        );
    }

    // -- merge_log_sources tests --

    #[test]
    fn merge_log_sources_handles_missing_files_as_empty() {
        let merged = merge_log_sources(
            LogSources {
                compose: String::new(),
                desktop: String::new(),
                mcp_os: String::new(),
                claude: String::new(),
                lima: String::new(),
                entrypoint: String::new(),
            },
            "testproj",
        );
        assert_eq!(merged, "");
    }

    #[test]
    fn merge_log_sources_includes_entrypoint_block() {
        let merged = merge_log_sources(
            LogSources {
                compose: String::new(),
                desktop: String::new(),
                mcp_os: String::new(),
                claude: String::new(),
                lima: String::new(),
                entrypoint: "2026-07-13T12:00:01+02:00 ERROR FAIL superpowers: clone failed\n"
                    .to_string(),
            },
            "proj",
        );
        assert!(merged.contains("entrypoint | 2026-07-13T12:00:01+02:00 ERROR FAIL superpowers"));
    }

    #[test]
    fn merge_log_sources_includes_all_source_tokens_in_dropdown_friendly_form() {
        let prefix = speedwave_runtime::consts::compose_prefix();
        let compose_line = format!("{prefix}_testproj_claude | first\n");
        let merged = merge_log_sources(
            LogSources {
                compose: compose_line.clone(),
                desktop: "2026-01-01T00:00:00.000+0000 [INFO][x] d\n".to_string(),
                mcp_os: "ready\n".to_string(),
                claude: "session started\n".to_string(),
                lima: String::new(),
                entrypoint: String::new(),
            },
            "testproj",
        );
        assert!(
            merged.contains("claude | first"),
            "compose prefix stripped, got: {merged}"
        );
        assert!(!merged.contains(&format!("{prefix}_testproj_claude")));
        assert!(merged.contains("desktop | 2026-01-01T00:00:00.000+0000 INFO [x] d"));
        assert!(merged.contains("mcp-os | ready"));
        assert!(merged.contains("claude | session started"));
    }

    #[test]
    fn logs_view_covers_all_displayable_registry_sources() {
        // A displayable registry source not wired into the merge fails here.
        use speedwave_runtime::diagnostic_sources::DIAGNOSTIC_SOURCES;
        let merged = merge_log_sources(
            LogSources {
                compose: "MARKER_compose\n".to_string(),
                desktop: "MARKER_desktop\n".to_string(),
                mcp_os: "MARKER_mcp_os\n".to_string(),
                claude: "MARKER_claude\n".to_string(),
                lima: "MARKER_lima\n".to_string(),
                entrypoint: "MARKER_entrypoint\n".to_string(),
            },
            "proj",
        );
        for s in DIAGNOSTIC_SOURCES {
            if s.displayable && s.platforms.available_here() {
                let token = format!("{} | MARKER_{}", s.key, s.key.replace('-', "_"));
                assert!(
                    merged.contains(&token),
                    "displayable registry source '{}' not present in /logs merge \
                     (expected '{token}') — ZIP would carry more than /logs, \
                     violating parity. Merged:\n{merged}",
                    s.key
                );
            }
        }
        // compose-yml (non-displayable) must never appear in /logs.
        assert!(!merged.contains("compose-yml |"), "merged: {merged}");
    }

    #[test]
    fn merge_log_sources_sanitizes_secrets_across_sources() {
        let merged = merge_log_sources(
            LogSources {
                compose: String::new(),
                desktop:
                    "2026-01-01T00:00:00.000+0000 [INFO][x] auth Bearer sk-ant-api03-secret123\n"
                        .to_string(),
                mcp_os: String::new(),
                claude: String::new(),
                lima: String::new(),
                entrypoint: String::new(),
            },
            "testproj",
        );
        assert!(
            !merged.contains("sk-ant-api03-secret123"),
            "Bearer token must be redacted, got: {merged}"
        );
    }

    #[test]
    fn merge_log_sources_preserves_compose_block_first() {
        let prefix = speedwave_runtime::consts::compose_prefix();
        let compose_line = format!("{prefix}_testproj_claude | START\n");
        let merged = merge_log_sources(
            LogSources {
                compose: compose_line,
                desktop: "desktop_only_line\n".to_string(),
                mcp_os: String::new(),
                claude: String::new(),
                lima: String::new(),
                entrypoint: String::new(),
            },
            "testproj",
        );
        let compose_idx = merged.find("claude | START").unwrap();
        let desktop_idx = merged.find("desktop | desktop_only_line").unwrap();
        assert!(compose_idx < desktop_idx, "compose block must come first");
    }

    #[test]
    fn merge_log_sources_block_order_mcp_os_before_claude() {
        let merged = merge_log_sources(
            LogSources {
                compose: String::new(),
                desktop: String::new(),
                mcp_os: "mcp_os_line\n".to_string(),
                claude: "claude_line\n".to_string(),
                lima: String::new(),
                entrypoint: String::new(),
            },
            "testproj",
        );
        let mcp_idx = merged.find("mcp-os | mcp_os_line").unwrap();
        let claude_idx = merged.find("claude | claude_line").unwrap();
        assert!(mcp_idx < claude_idx, "got: {merged}");
    }

    #[test]
    fn prefix_lines_does_not_unwrap_brackets_in_json() {
        let raw = r#"{"ts":"2026-01-01T00:00:00.000Z","recipe":"r","argv":["echo","[INFO]"]}"#;
        let out = prefix_lines("mcp-os", raw, None);
        assert!(
            out.contains(r#"mcp-os | {"ts":"2026-01-01T00:00:00.000Z","recipe":"r","argv":["echo","[INFO]"]}"#),
            "JSON content must pass through verbatim with only the prefix, got: {out}"
        );
    }

    // ── read_tail_desktop_logs tests ─────────────────────────────────────────

    #[test]
    fn read_tail_desktop_logs_returns_empty_when_dir_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let missing = tmp.path().join("nope");
        assert_eq!(read_tail_desktop_logs(&missing, 100), "");
    }

    #[test]
    fn read_tail_desktop_logs_returns_empty_on_empty_dir() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(read_tail_desktop_logs(tmp.path(), 100), "");
    }

    #[test]
    fn read_tail_desktop_logs_tails_single_file() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("speedwave-desktop.log");
        let lines: Vec<String> = (0..10).map(|i| format!("line {i}")).collect();
        std::fs::write(&path, lines.join("\n")).unwrap();
        let out = read_tail_desktop_logs(tmp.path(), 3);
        assert_eq!(out, "line 7\nline 8\nline 9");
    }

    #[test]
    fn read_tail_desktop_logs_merges_rotated_files_in_mtime_order() {
        let tmp = tempfile::tempdir().unwrap();
        let older = tmp.path().join("speedwave-desktop_2026-05-12_08-00-00.log");
        let newer = tmp.path().join("speedwave-desktop.log");
        std::fs::write(&older, "old-1\nold-2").unwrap();
        std::fs::write(&newer, "new-1\nnew-2").unwrap();
        std::fs::File::open(&older)
            .unwrap()
            .set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000))
            .unwrap();
        std::fs::File::open(&newer)
            .unwrap()
            .set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(2_000_000))
            .unwrap();
        let out = read_tail_desktop_logs(tmp.path(), 10);
        assert!(out.contains("old-1\nold-2\nnew-1\nnew-2"), "got: {out}");
    }

    #[test]
    fn read_tail_desktop_logs_ignores_unrelated_files() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("other.log"), "noise").unwrap();
        std::fs::write(tmp.path().join("speedwave-desktop.txt"), "noise").unwrap();
        std::fs::write(tmp.path().join("speedwave-desktop.log"), "keep").unwrap();
        let out = read_tail_desktop_logs(tmp.path(), 10);
        assert_eq!(out, "keep");
    }

    #[test]
    fn read_tail_desktop_logs_sanitizes_secrets() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(
            tmp.path().join("speedwave-desktop.log"),
            "Authorization: Bearer sk-ant-api03-secret",
        )
        .unwrap();
        let out = read_tail_desktop_logs(tmp.path(), 10);
        assert!(!out.contains("sk-ant-api03-secret"), "got: {out}");
        assert!(out.contains("***REDACTED"), "got: {out}");
    }

    /// The marker must match the `<source> | <ISO> LEVEL msg` shape the
    /// frontend's `parseLogLine` recognises.
    #[test]
    fn compose_busy_marker_has_parseable_shape() {
        let marker = compose_busy_marker();
        assert!(marker.starts_with("compose | 2"), "got: {marker}");
        assert!(marker.contains(" WARN  "), "got: {marker}");
        assert!(marker.ends_with('\n'), "got: {marker}");
    }

    #[test]
    fn fetch_compose_logs_skips_when_another_fetch_is_in_flight() {
        use std::sync::atomic::Ordering;
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        COMPOSE_LOGS_IN_FLIGHT.store(true, Ordering::SeqCst);
        let out = rt.block_on(fetch_compose_logs_bounded("p".to_string(), 10));
        COMPOSE_LOGS_IN_FLIGHT.store(false, Ordering::SeqCst);
        assert!(out.contains("container logs unavailable"), "got: {out}");
    }
}
