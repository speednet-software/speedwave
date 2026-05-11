// Tauri commands for viewing container and compose logs.

use crate::logging_cmd::desktop_log_dir;
use crate::types::check_project;

/// Validate that a container name starts with the Speedwave compose prefix
/// and contains only safe characters (alphanumeric, underscore, hyphen, dot).
fn validate_container_name(container: &str) -> Result<(), String> {
    if !container.starts_with(&format!("{}_", speedwave_runtime::consts::compose_prefix())) {
        return Err(format!(
            "Invalid container name: must start with '{}_'",
            speedwave_runtime::consts::compose_prefix()
        ));
    }
    if !container
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.')
    {
        return Err("Invalid container name: contains illegal characters".to_string());
    }
    Ok(())
}

/// Parse the project name from a Claude container name.
/// Expected format: `{compose_prefix()}_{project}_claude`.
fn parse_claude_project(container: &str) -> Result<String, String> {
    let prefix = format!("{}_", speedwave_runtime::consts::compose_prefix());
    let without_prefix = container
        .strip_prefix(&prefix)
        .ok_or_else(|| "Not a claude container".to_string())?;
    let project = without_prefix
        .strip_suffix("_claude")
        .ok_or_else(|| "Not a claude container".to_string())?;
    if project.is_empty() {
        return Err("Not a claude container".to_string());
    }
    Ok(project.to_string())
}

/// Read a log file, take the last `tail` lines, and sanitize secrets.
/// Returns an empty string if the file does not exist.
fn read_tail_sanitized(path: &std::path::Path, tail: usize) -> Result<String, String> {
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

#[tauri::command]
pub(crate) async fn get_container_logs(
    container: String,
    tail: Option<u32>,
) -> Result<String, String> {
    validate_container_name(&container)?;
    let tail = tail.unwrap_or(200).min(10_000);
    tokio::task::spawn_blocking(move || {
        let rt = speedwave_runtime::runtime::detect_runtime();
        if !rt.is_available() {
            return Err("Container runtime is not available. Please ensure the runtime is started before viewing logs.".to_string());
        }
        rt.container_logs(&container, tail)
            .map(|logs| speedwave_runtime::log_sanitizer::sanitize(&logs))
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn get_compose_logs(project: String, tail: Option<u32>) -> Result<String, String> {
    check_project(&project)?;
    let tail = tail.unwrap_or(200).min(10_000);
    tokio::task::spawn_blocking(move || {
        let rt = speedwave_runtime::runtime::detect_runtime();
        if !rt.is_available() {
            return Err("Container runtime is not available. Please ensure the runtime is started before viewing logs.".to_string());
        }
        rt.compose_logs(&project, tail)
            .map(|logs| speedwave_runtime::log_sanitizer::sanitize(&logs))
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn get_mcp_os_logs(tail: Option<u32>) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let log_path =
            speedwave_runtime::consts::data_dir().join(speedwave_runtime::consts::MCP_OS_LOG_FILE);
        let tail = tail.unwrap_or(200).min(10_000) as usize;
        read_tail_sanitized(&log_path, tail)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn get_claude_session_logs(
    container: String,
    tail: Option<u32>,
) -> Result<String, String> {
    validate_container_name(&container)?;
    let project = parse_claude_project(&container)?;
    check_project(&project)?;

    let tail = tail.unwrap_or(200).min(10_000) as usize;

    tokio::task::spawn_blocking(move || {
        let log_path = speedwave_runtime::consts::claude_session_log_path(&project);
        read_tail_sanitized(&log_path, tail)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// Unified `/logs` view — merge of every log source the app produces
// ---------------------------------------------------------------------------
//
// The frontend's `parseLogLine` recognises lines of the form
// `<source-token> | <rest>`, where `<source-token>` matches `[\w.-]+`. Compose
// container logs already arrive in that shape (`<container_name> | <ISO> msg`).
// Host-side log files (tauri-desktop, mcp-os, claude-session) do not, so we
// reformat them via `prefix_lines` before concatenating with the compose
// stream into a single string. This is what `get_all_logs` returns.

/// Returns true when the line already carries a `<source-token> | …` prefix
/// that the frontend parser will recognise. Used to skip re-prefixing compose
/// container lines (which `nerdctl compose logs` already prefixes for us).
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

/// Rewrites tauri-plugin-log's bracketed level (`[INFO]`, `[WARN]`, …) into
/// the unbracketed form Angular's `LEVEL_RE` expects after timestamp
/// extraction.
///
/// Production input:
///   `2026-05-06T19:58:38.724+0200 [INFO][speedwave_desktop::integrations_cmd] msg`
/// Output:
///   `2026-05-06T19:58:38.724+0200 INFO [speedwave_desktop::integrations_cmd] msg`
///
/// Returns the line unchanged when it does not match the expected layout
/// (e.g. multi-line stack traces or external library lines).
fn rewrite_desktop_bracketed_level(line: &str) -> String {
    // ISO timestamp ends at the first space (timestamp contains digits, `-`,
    // `:`, `.`, `+`, optionally `Z` — never spaces).
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
    // `line[..space_idx]` = ISO timestamp (without trailing space)
    // After the closing `]` comes the rest, which usually starts with `[target]`.
    // The frontend `LEVEL_RE = /^(LEVEL)\s+(.*)$/i` requires a space after the
    // level word — without it the line falls back to default `info` and we lose
    // the WARN/ERROR signal in the level chip.
    let before = &line[..space_idx];
    let after = &after_ts[close_idx + 1..];
    format!("{before} {level} {after}")
}

/// Reformats the raw output of one log source so that every non-empty line
/// matches the frontend's `<source> | <rest>` parsing contract.
///
/// - Empty lines are dropped (they would break `parseLogLine` and add no value).
/// - Lines that already carry a `<word> | …` prefix (compose container logs)
///   are passed through unchanged — re-prefixing them would lose the
///   container name in the dropdown.
/// - Other lines (host-side log files) get the `<source> | ` prefix.
/// - Desktop-log lines additionally have their bracketed level rewritten
///   so the Angular level chip works (`[INFO]` → `INFO`).
pub(crate) fn prefix_lines(source: &str, raw: &str) -> String {
    let mut out = String::with_capacity(raw.len() + raw.lines().count() * (source.len() + 4));
    for line in raw.split('\n') {
        if line.is_empty() {
            continue;
        }
        if has_source_prefix(line) {
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
}

/// Composes the four per-source log buffers into a single newline-separated
/// string, in a deterministic per-source order. We deliberately do NOT sort
/// globally by timestamp — the four sources use heterogeneous timestamp
/// formats (compose `--timestamps` ISO, tauri-plugin-log local-with-offset,
/// mcp-os/claude raw text), and any sort would have to either parse all four
/// (expensive, fragile) or compare lexicographically (incorrect for offsets).
/// The frontend source-filter dropdown gives users the per-source view they
/// need, so per-source-block ordering is sufficient.
pub(crate) fn merge_log_sources(sources: LogSources) -> String {
    let compose = prefix_lines("compose", &sources.compose);
    let desktop = prefix_lines("desktop", &sources.desktop);
    let mcp_os = prefix_lines("mcp-os", &sources.mcp_os);
    let claude = prefix_lines("claude", &sources.claude);

    // Apply the sanitizer once to the merged buffer (idempotent — sources are
    // already individually sanitized, this is a defence-in-depth pass).
    speedwave_runtime::log_sanitizer::sanitize(&format!("{compose}{desktop}{mcp_os}{claude}"))
}

/// Reads every host-side log file, fetches the compose stream, and returns a
/// merged buffer that the frontend's existing `parseLogLine` understands.
///
/// Sources merged (in this fixed order, per-source-block):
///   1. compose  — `nerdctl compose logs --timestamps --tail <N>`
///   2. desktop  — tauri-plugin-log file (Rust + Angular `LoggerService` +
///                 Swift CLI stderr forwarded by `check_os_permission`)
///   3. mcp-os   — `~/.speedwave/mcp-os.log`
///   4. claude   — `~/.speedwave/logs/<project>/claude-session.log` (if exists)
///
/// Each source uses the full `tail` budget independently (default 200, cap
/// 10 000). With 4 sources × 10 000 the upper bound is 40 000 lines — trivial
/// for the renderer, especially since the frontend further filters by source
/// in the dropdown.
///
/// Backwards-compatible with `get_compose_logs`: that command still exists for
/// callers that want compose-only output (e.g. diagnostics export). New
/// frontend code should prefer this command.
#[tauri::command]
pub(crate) async fn get_all_logs(project: String, tail: Option<u32>) -> Result<String, String> {
    check_project(&project)?;
    let tail_u32 = tail.unwrap_or(200).min(10_000);
    let tail_us = tail_u32 as usize;

    tokio::task::spawn_blocking(move || -> Result<String, String> {
        let rt = speedwave_runtime::runtime::detect_runtime();

        // compose (best-effort; missing runtime should not blank the whole view)
        let compose = if rt.is_available() {
            rt.compose_logs(&project, tail_u32).unwrap_or_default()
        } else {
            String::new()
        };

        // desktop (tauri-plugin-log) — best-effort, missing dir/file is fine
        let desktop = match desktop_log_dir() {
            Some(dir) => {
                let path = dir.join("speedwave-desktop.log");
                read_tail_sanitized(&path, tail_us).unwrap_or_default()
            }
            None => String::new(),
        };

        // mcp-os — same path resolution `get_mcp_os_logs` uses
        let mcp_os_path =
            speedwave_runtime::consts::data_dir().join(speedwave_runtime::consts::MCP_OS_LOG_FILE);
        let mcp_os = read_tail_sanitized(&mcp_os_path, tail_us).unwrap_or_default();

        // claude session log — same path resolution `get_claude_session_logs` uses
        let claude_path = speedwave_runtime::consts::claude_session_log_path(&project);
        let claude = read_tail_sanitized(&claude_path, tail_us).unwrap_or_default();

        Ok(merge_log_sources(LogSources {
            compose,
            desktop,
            mcp_os,
            claude,
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    // -- Container name validation --

    #[test]
    fn validate_container_name_accepts_valid() {
        assert!(validate_container_name("speedwave_acme_claude").is_ok());
        assert!(validate_container_name("speedwave_proj.v1_mcp-hub").is_ok());
    }

    #[test]
    fn validate_container_name_rejects_missing_prefix() {
        assert!(validate_container_name("random_container").is_err());
    }

    #[test]
    fn validate_container_name_rejects_shell_characters() {
        assert!(validate_container_name("speedwave_acme;rm -rf /").is_err());
    }

    #[test]
    fn validate_container_name_rejects_path_traversal() {
        assert!(validate_container_name("speedwave_../etc/passwd").is_err());
    }

    // -- Log sanitization tests (get_container_logs / get_compose_logs) --

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

    // -- Claude session logs: project parsing from container name --

    #[test]
    fn parse_project_from_claude_container() {
        let project = parse_claude_project("speedwave_myproject_claude").unwrap();
        assert_eq!(project, "myproject");
    }

    #[test]
    fn parse_project_from_dotted_container_name() {
        let project = parse_claude_project("speedwave_proj.v1_claude").unwrap();
        assert_eq!(project, "proj.v1");
    }

    #[test]
    fn parse_project_rejects_non_claude_container() {
        let result = parse_claude_project("speedwave_myproject_mcp-hub");
        assert!(result.is_err(), "non-claude container should be rejected");
    }

    #[test]
    fn parse_project_rejects_missing_prefix() {
        let result = parse_claude_project("other_myproject_claude");
        assert!(result.is_err(), "missing prefix should be rejected");
    }

    #[test]
    fn parse_project_validates_extracted_project() {
        // Container with ".." in project name → check_project rejects it
        let project = parse_claude_project("speedwave_.._claude").unwrap();
        let result = crate::types::check_project(&project);
        assert!(
            result.is_err(),
            "path traversal project should be rejected by check_project"
        );
    }

    #[test]
    fn parse_project_dotted_name_passes_check_project() {
        let project = parse_claude_project("speedwave_proj.v1_claude").unwrap();
        let result = crate::types::check_project(&project);
        assert!(
            result.is_ok(),
            "proj.v1 should pass check_project: {result:?}"
        );
    }

    // -- read_tail_sanitized --

    #[test]
    fn read_tail_sanitized_returns_empty_for_missing_file() {
        let path = std::path::Path::new("/tmp/nonexistent-speedwave-test/claude-session.log");
        let result = read_tail_sanitized(path, 200).unwrap();
        assert_eq!(result, "");
    }

    #[test]
    fn read_tail_sanitized_reads_and_sanitizes() {
        let tmp = tempfile::tempdir().unwrap();
        let log_content =
            "[07-04-2026 14:30:00] SESSION: started\n[07-04-2026 14:30:01] STDERR: Bearer sk-ant-secret-key-abc\n[07-04-2026 14:30:02] SESSION: stopped\n";
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
        // (`a b | c` — frontend `COMPOSE_RE` would not match either.)
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
    fn prefix_lines_passthrough_for_compose_format() {
        let raw = "claude_1 | hello\nmcp_hub_1 | world";
        let out = prefix_lines("compose", raw);
        // Compose lines pass through verbatim — they already have a source token.
        assert!(out.contains("claude_1 | hello"));
        assert!(out.contains("mcp_hub_1 | world"));
        // Must NOT prepend `compose | `.
        assert!(!out.contains("compose | claude_1"));
    }

    #[test]
    fn prefix_lines_prepends_source_for_plain_lines() {
        let raw = "2026-05-06T19:58:38 INFO mcp-os started\nready";
        let out = prefix_lines("mcp-os", raw);
        assert!(out.contains("mcp-os | 2026-05-06T19:58:38 INFO mcp-os started"));
        assert!(out.contains("mcp-os | ready"));
    }

    #[test]
    fn prefix_lines_rewrites_desktop_bracketed_level() {
        let raw = "2026-05-06T19:58:38.724+0200 [INFO][speedwave_desktop::integrations_cmd] hi";
        let out = prefix_lines("desktop", raw);
        // Bracketed level is unwrapped (with trailing space — frontend LEVEL_RE
        // requires \s+ after the level word) AND the line is prefixed with
        // `desktop | `.
        assert!(
            out.contains("desktop | 2026-05-06T19:58:38.724+0200 INFO [speedwave_desktop::integrations_cmd] hi"),
            "expected unwrapped level + desktop prefix, got: {out}"
        );
    }

    #[test]
    fn prefix_lines_skips_empty_lines() {
        let raw = "first\n\nsecond\n";
        let out = prefix_lines("desktop", raw);
        // No `desktop | ` lines for the empty splits.
        let pipe_count = out.matches("desktop | ").count();
        assert_eq!(pipe_count, 2, "expected 2 prefixed lines, got: {out}");
    }

    #[test]
    fn prefix_lines_does_not_double_rewrite_when_source_is_not_desktop() {
        // mcp-os logs sometimes contain `[INFO]` text but we must NOT rewrite
        // them (the rewrite is desktop-format-specific). Non-desktop sources
        // pass content through with only the prefix added.
        let raw = "2026-05-06T19:58:38 [INFO] foo";
        let out = prefix_lines("mcp-os", raw);
        assert!(
            out.contains("mcp-os | 2026-05-06T19:58:38 [INFO] foo"),
            "non-desktop source must NOT unwrap brackets; got: {out}"
        );
    }

    // -- merge_log_sources tests --

    #[test]
    fn merge_log_sources_handles_missing_files_as_empty() {
        // Every source empty → merged buffer is empty.
        let merged = merge_log_sources(LogSources {
            compose: String::new(),
            desktop: String::new(),
            mcp_os: String::new(),
            claude: String::new(),
        });
        assert_eq!(merged, "");
    }

    #[test]
    fn merge_log_sources_includes_all_four_source_tokens_in_dropdown_friendly_form() {
        let merged = merge_log_sources(LogSources {
            compose: "claude_1 | first\n".to_string(),
            desktop: "2026-01-01T00:00:00.000+0000 [INFO][x] d\n".to_string(),
            mcp_os: "ready\n".to_string(),
            claude: "session started\n".to_string(),
        });
        assert!(merged.contains("claude_1 | first"), "compose passthrough");
        assert!(merged.contains("desktop | 2026-01-01T00:00:00.000+0000 INFO [x] d"));
        assert!(merged.contains("mcp-os | ready"));
        assert!(merged.contains("claude | session started"));
    }

    #[test]
    fn merge_log_sources_sanitizes_secrets_across_sources() {
        // A Bearer token in the desktop log must be redacted in the merged
        // buffer (sanitizer is applied as a defence-in-depth pass at merge).
        let merged = merge_log_sources(LogSources {
            compose: String::new(),
            desktop: "2026-01-01T00:00:00.000+0000 [INFO][x] auth Bearer sk-ant-api03-secret123\n"
                .to_string(),
            mcp_os: String::new(),
            claude: String::new(),
        });
        assert!(
            !merged.contains("sk-ant-api03-secret123"),
            "Bearer token must be redacted, got: {merged}"
        );
    }

    #[test]
    fn merge_log_sources_preserves_compose_block_first() {
        // Per-source-block ordering must put compose first so users
        // diagnosing a workflow that started in a container (most common) see
        // those lines without scrolling. Document by asserting offset.
        let merged = merge_log_sources(LogSources {
            compose: "claude_1 | START\n".to_string(),
            desktop: "desktop_only_line\n".to_string(),
            mcp_os: String::new(),
            claude: String::new(),
        });
        let compose_idx = merged.find("claude_1 | START").unwrap();
        let desktop_idx = merged.find("desktop | desktop_only_line").unwrap();
        assert!(compose_idx < desktop_idx, "compose block must come first");
    }
}
