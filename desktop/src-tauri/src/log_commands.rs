// Tauri commands for viewing container and compose logs.

use crate::types::check_project;

#[tauri::command]
pub(crate) async fn get_container_logs(
    container: String,
    tail: Option<u32>,
) -> Result<String, String> {
    // Only allow alphanumeric, underscore, hyphen, dot in container names
    // and must start with the Speedwave prefix
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    // -- Container name validation (get_container_logs logic) --

    #[test]
    fn container_name_requires_compose_prefix() {
        let prefix = speedwave_runtime::consts::COMPOSE_PREFIX;
        let valid = format!("{}_acme_claude", prefix);
        assert!(valid.starts_with(&format!("{}_", prefix)));

        // Without prefix
        assert!(!"random_container".starts_with(&format!("{}_", prefix)));
    }

    #[test]
    fn container_name_rejects_shell_characters() {
        let name = "speedwave_acme;rm -rf /";
        let has_invalid = !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.');
        assert!(has_invalid, "semicolons should be rejected");
    }

    #[test]
    fn container_name_rejects_path_traversal() {
        let name = "speedwave_../etc/passwd";
        let has_invalid = !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.');
        assert!(has_invalid, "slashes should be rejected");
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
}
