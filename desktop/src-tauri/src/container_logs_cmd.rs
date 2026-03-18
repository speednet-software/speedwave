// Tauri commands for viewing container and compose logs.

use crate::types::check_project;

/// Validate that a container name starts with the Speedwave compose prefix
/// and contains only safe characters (alphanumeric, underscore, hyphen, dot).
fn validate_container_name(container: &str) -> Result<(), String> {
    if !container.starts_with(&format!("{}_", speedwave_runtime::consts::COMPOSE_PREFIX)) {
        return Err(format!(
            "Invalid container name: must start with '{}_'",
            speedwave_runtime::consts::COMPOSE_PREFIX
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
/// Expected format: `{COMPOSE_PREFIX}_{project}_claude`.
fn parse_claude_project(container: &str) -> Result<String, String> {
    let prefix = format!("{}_", speedwave_runtime::consts::COMPOSE_PREFIX);
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
        let home = dirs::home_dir().ok_or_else(|| "Cannot determine home directory".to_string())?;
        let log_path = home
            .join(speedwave_runtime::consts::DATA_DIR)
            .join(speedwave_runtime::consts::MCP_OS_LOG_FILE);
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
        let log_path = match speedwave_runtime::consts::claude_session_log_path(&project) {
            Some(p) => p,
            None => return Ok(String::new()),
        };
        read_tail_sanitized(&log_path, tail)
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
            "[100] SESSION: started\n[101] STDERR: Bearer sk-ant-secret-key-abc\n[102] SESSION: stopped\n";
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
}
