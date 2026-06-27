//! LLM command surface: discovery probes and usage/cost aggregation.
//! Holds shared helpers and re-exports the submodules' Tauri commands.

pub(crate) mod discovery;
pub(crate) mod usage;

pub(crate) use discovery::validate_llm_base_url;

// Re-export the commands + `#[tauri::command]` helper macros (`__cmd__*` /
// `__tauri_command_name_*`) so `main.rs`'s `generate_handler!` resolves unchanged.
pub(crate) use discovery::{
    __cmd__discover_llm_models, __tauri_command_name_discover_llm_models, discover_llm_models,
};
pub(crate) use usage::{
    __cmd__get_conversation_cost, __cmd__get_llm_usage, __cmd__get_session_cost,
    __cmd__get_usage_for_response, __tauri_command_name_get_conversation_cost,
    __tauri_command_name_get_llm_usage, __tauri_command_name_get_session_cost,
    __tauri_command_name_get_usage_for_response, get_conversation_cost, get_llm_usage,
    get_session_cost, get_usage_for_response,
};

/// Production timeout for the HTTP probe. A model still loading times out and
/// the UI falls back to free-text input.
pub(crate) const DISCOVERY_TIMEOUT_SECS: u64 = 5;

// HTTP client helper (shared by discovery + usage)

/// Builds an HTTP client without auth. Test-only convenience; production
/// always goes through `build_llm_probe_client_with_auth`.
#[cfg(test)]
pub(crate) fn build_llm_probe_client() -> Result<reqwest::Client, String> {
    build_llm_probe_client_with_auth(None, None)
}

/// Builds an HTTP client with optional Bearer auth and custom default headers.
/// Rejects `Authorization` in `custom_headers`.
pub(crate) fn build_llm_probe_client_with_auth(
    bearer: Option<&str>,
    custom_headers: Option<&str>,
) -> Result<reqwest::Client, String> {
    use reqwest::header::{HeaderMap, HeaderName, HeaderValue, AUTHORIZATION};

    let mut headers = HeaderMap::new();
    if let Some(token) = bearer {
        let value = format!("Bearer {token}");
        let header_value = HeaderValue::from_str(&value)
            .map_err(|e| format!("invalid Bearer token (header construction): {e}"))?;
        headers.insert(AUTHORIZATION, header_value);
    }
    if let Some(blob) = custom_headers {
        for (idx, line) in blob.lines().enumerate() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let (name, rest) = line
                .split_once(':')
                .ok_or_else(|| format!("custom_headers line {} missing ':'", idx + 1))?;
            let name = name.trim();
            let value = rest.trim();
            if name.eq_ignore_ascii_case("authorization") {
                // Guard against stale config smuggling Authorization.
                return Err(
                    "custom_headers must not contain Authorization (use api_key)".to_string(),
                );
            }
            let header_name = HeaderName::from_bytes(name.as_bytes())
                .map_err(|e| format!("invalid header name '{name}': {e}"))?;
            let header_value = HeaderValue::from_str(value)
                .map_err(|e| format!("invalid header value for '{name}': {e}"))?;
            headers.insert(header_name, header_value);
        }
    }

    crate::http_util::build_hardened_client(Some(headers))
}

/// Strips a leading `Bearer ` (case-insensitive) and trims whitespace.
/// Returns `None` when the result is empty.
pub(crate) fn strip_bearer_prefix(s: &str) -> Option<String> {
    let trimmed = s.trim();
    let stripped = if trimmed.len() >= 7 && trimmed[..7].eq_ignore_ascii_case("Bearer ") {
        trimmed[7..].trim_start()
    } else {
        trimmed
    };
    if stripped.is_empty() {
        None
    } else {
        Some(stripped.to_string())
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    // build_llm_probe_client_with_auth — header construction

    #[test]
    fn build_client_rejects_authorization_in_custom_headers() {
        let r = build_llm_probe_client_with_auth(None, Some("Authorization: Bearer foo"));
        assert!(
            r.is_err(),
            "Authorization in custom_headers must be rejected"
        );
    }

    #[test]
    fn build_client_with_bearer_succeeds() {
        let r = build_llm_probe_client_with_auth(Some("sk-test"), None);
        assert!(r.is_ok());
    }

    #[test]
    fn build_client_with_multiline_custom_headers_succeeds() {
        let r = build_llm_probe_client_with_auth(None, Some("X-Foo: bar\nX-Baz: qux"));
        assert!(r.is_ok());
    }

    #[test]
    fn build_client_rejects_invalid_header_name() {
        let r = build_llm_probe_client_with_auth(None, Some("X Foo: bar"));
        assert!(r.is_err());
    }

    #[test]
    fn strip_bearer_prefix_handles_all_cases() {
        assert_eq!(strip_bearer_prefix("sk-test"), Some("sk-test".to_string()));
        assert_eq!(
            strip_bearer_prefix("Bearer sk-test"),
            Some("sk-test".to_string())
        );
        assert_eq!(
            strip_bearer_prefix("bearer sk-x"),
            Some("sk-x".to_string()),
            "case-insensitive"
        );
        assert_eq!(
            strip_bearer_prefix("  sk-trim  "),
            Some("sk-trim".to_string())
        );
        // Empty / whitespace-only → None.
        assert_eq!(strip_bearer_prefix(""), None);
        assert_eq!(strip_bearer_prefix("   "), None);
        // `Bearer` alone is not a prefix; trims to the literal word.
        assert_eq!(strip_bearer_prefix("Bearer"), Some("Bearer".to_string()));
    }
}
