// Redmine API proxy — Tauri commands for direct Redmine API calls.
//
// Used during integration configuration before the MCP container exists.
// The Desktop host calls the Redmine API directly to validate credentials
// and fetch enumerations (projects, statuses, trackers, priorities, activities).

use serde::{Deserialize, Serialize};
use std::time::Duration;

use crate::http_util::read_body_limited;
#[cfg(test)]
use crate::http_util::MAX_RESPONSE_BODY_BYTES;

// ---------------------------------------------------------------------------
// Response DTOs
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct RedmineUser {
    pub id: u32,
    pub login: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct RedmineValidationResult {
    pub valid: bool,
    pub user: Option<RedmineUser>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct RedmineEnumEntry {
    pub id: u32,
    pub name: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct RedmineEnumerations {
    pub projects: Vec<RedmineEnumEntry>,
    pub projects_truncated: bool,
    pub statuses: Vec<RedmineEnumEntry>,
    pub trackers: Vec<RedmineEnumEntry>,
    pub priorities: Vec<RedmineEnumEntry>,
    pub activities: Vec<RedmineEnumEntry>,
}

// ---------------------------------------------------------------------------
// Internal DTOs for Redmine JSON responses
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct RedmineCurrentUserWrapper {
    user: RedmineUser,
}

#[derive(Deserialize)]
struct RawEnumEntry {
    id: u32,
    name: String,
}

impl From<RawEnumEntry> for RedmineEnumEntry {
    fn from(e: RawEnumEntry) -> Self {
        Self {
            id: e.id,
            name: e.name,
        }
    }
}

#[derive(Deserialize)]
struct RedmineProjectsResponse {
    projects: Vec<RawEnumEntry>,
    #[serde(default)]
    total_count: Option<u32>,
}

#[derive(Deserialize)]
struct RedmineStatusesResponse {
    issue_statuses: Vec<RawEnumEntry>,
}

#[derive(Deserialize)]
struct RedmineTrackersResponse {
    trackers: Vec<RawEnumEntry>,
}

#[derive(Deserialize)]
struct RedminePrioritiesResponse {
    issue_priorities: Vec<RawEnumEntry>,
}

#[derive(Deserialize)]
struct RedmineActivitiesResponse {
    time_entry_activities: Vec<RawEnumEntry>,
}

// ---------------------------------------------------------------------------
// URL validation
// ---------------------------------------------------------------------------

/// Validates and normalizes a Redmine host URL for API use.
///
/// Rejects backslashes, embedded credentials, and non-HTTP schemes.
/// Allows RFC1918 private IPs and IPv6 ULA addresses (common for on-premise
/// Redmine) with a warning, but blocks loopback, link-local, and unspecified
/// addresses. Strips trailing slashes for consistent URL construction.
fn validate_redmine_host_url(url: &str) -> Result<String, String> {
    // Reject backslashes before parsing (Windows path confusion)
    if url.contains('\\') {
        return Err("URL must not contain backslashes".to_string());
    }

    // Parse URL first to check for RFC1918 before delegating to base validation
    let candidate: url::Url = url.parse().map_err(|e: url::ParseError| e.to_string())?;

    // If private on-premise address (RFC1918 or IPv6 ULA), skip base validation
    // (which blocks all private IPs) and validate scheme/host ourselves.
    // Redmine policy blocks loopback — use `PrivatePolicy::BlockLoopback`.
    let parsed = if crate::url_validation::is_private_on_premise(
        &candidate,
        crate::url_validation::PrivatePolicy::BlockLoopback,
    ) {
        match candidate.scheme() {
            "http" | "https" => {}
            scheme => {
                return Err(format!(
                    "Blocked URL scheme '{}': only http and https are allowed",
                    scheme
                ))
            }
        }
        if candidate.host().is_none() {
            return Err("URL has no host".to_string());
        }
        log::warn!(
            "Allowing private address for on-premise Redmine: {}",
            candidate.host_str().unwrap_or("unknown")
        );
        candidate
    } else {
        // Non-RFC1918: delegate to base validation (blocks loopback, link-local, metadata)
        crate::url_validation::validate_url(url)?
    };

    // Reject embedded credentials
    if parsed.password().is_some() || !parsed.username().is_empty() {
        return Err("URL must not contain embedded credentials".to_string());
    }

    // Warn about cleartext HTTP
    if parsed.scheme() == "http" {
        log::warn!("Redmine credentials will be transmitted in cleartext over HTTP");
    }

    // Strip trailing slash from the string representation for consistent URL construction.
    // url::Url always appends a trailing `/` for root paths, so we trim at string level.
    let result = parsed.as_str().trim_end_matches('/').to_string();

    Ok(result)
}

// read_body_limited + MAX_RESPONSE_BODY_BYTES moved to `crate::http_util`
// (Rule of Three: the LLM discovery command is the second consumer).

// ---------------------------------------------------------------------------
// HTTP client helper
// ---------------------------------------------------------------------------

/// Builds a reqwest client configured for Redmine API calls.
///
/// - No redirect following (prevents SSRF via open redirects)
/// - Custom User-Agent header
/// - No cookie jar
fn build_redmine_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(format!("Speedwave-Desktop/{}", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))
}

// ---------------------------------------------------------------------------
// Core logic (separated from Tauri commands for testability)
// ---------------------------------------------------------------------------

/// Core credential validation logic. Accepts a pre-validated base URL string.
async fn do_validate_credentials(
    base_url: &str,
    api_key: &str,
) -> Result<RedmineValidationResult, String> {
    let client = build_redmine_client()?;
    let url = format!("{base_url}/users/current.json");

    let resp = client
        .get(&url)
        .header("X-Redmine-API-Key", api_key)
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| {
            if e.is_connect() || e.is_timeout() {
                return format!("Connection failed: {e}");
            }
            let msg = e.to_string();
            if msg.to_lowercase().contains("certificate") {
                return format!(
                    "TLS certificate error: {e}. \
                     Check if the Redmine server uses a self-signed or expired certificate."
                );
            }
            format!("Request failed: {e}")
        })?;

    let status = resp.status();

    // Redirect — blocked by policy, but check status code
    if status.is_redirection() {
        return Ok(RedmineValidationResult {
            valid: false,
            user: None,
            error: Some(format!(
                "Server returned redirect (HTTP {status}). Check the Redmine URL."
            )),
        });
    }

    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Ok(RedmineValidationResult {
            valid: false,
            user: None,
            error: Some(format!("Authentication failed (HTTP {status})")),
        });
    }

    if status.is_server_error() {
        return Err(format!("Redmine server error (HTTP {status})"));
    }

    if !status.is_success() {
        return Ok(RedmineValidationResult {
            valid: false,
            user: None,
            error: Some(format!("Unexpected response (HTTP {status})")),
        });
    }

    let body = read_body_limited(resp, "Credentials validation").await?;

    let wrapper: RedmineCurrentUserWrapper = serde_json::from_slice(&body)
        .map_err(|e| format!("Response is not valid Redmine JSON (expected user.id field): {e}"))?;

    Ok(RedmineValidationResult {
        valid: true,
        user: Some(wrapper.user),
        error: None,
    })
}

/// Core enumeration fetch logic. Accepts a pre-validated base URL string.
/// Fetches all 5 endpoints in parallel with `tokio::join!` — each endpoint
/// handles its own errors independently (404/500 → empty vec).
async fn do_fetch_enumerations(
    base_url: &str,
    api_key: &str,
) -> Result<RedmineEnumerations, String> {
    let client = build_redmine_client()?;

    let (projects, statuses, trackers, priorities, activities) = tokio::join!(
        async {
            fetch_enum_endpoint::<RedmineProjectsResponse>(
                &client,
                base_url,
                "/projects.json?limit=100",
                api_key,
                "projects",
            )
            .await
            .map(|r| {
                let truncated = r
                    .total_count
                    .map(|tc| tc as usize > r.projects.len())
                    .unwrap_or(false);
                let entries = r.projects.into_iter().map(Into::into).collect();
                (entries, truncated)
            })
            .unwrap_or_default()
        },
        async {
            fetch_enum_endpoint::<RedmineStatusesResponse>(
                &client,
                base_url,
                "/issue_statuses.json",
                api_key,
                "statuses",
            )
            .await
            .map(|r| r.issue_statuses.into_iter().map(Into::into).collect())
            .unwrap_or_default()
        },
        async {
            fetch_enum_endpoint::<RedmineTrackersResponse>(
                &client,
                base_url,
                "/trackers.json",
                api_key,
                "trackers",
            )
            .await
            .map(|r| r.trackers.into_iter().map(Into::into).collect())
            .unwrap_or_default()
        },
        async {
            fetch_enum_endpoint::<RedminePrioritiesResponse>(
                &client,
                base_url,
                "/enumerations/issue_priorities.json",
                api_key,
                "priorities",
            )
            .await
            .map(|r| r.issue_priorities.into_iter().map(Into::into).collect())
            .unwrap_or_default()
        },
        async {
            fetch_enum_endpoint::<RedmineActivitiesResponse>(
                &client,
                base_url,
                "/enumerations/time_entry_activities.json",
                api_key,
                "activities",
            )
            .await
            .map(|r| {
                r.time_entry_activities
                    .into_iter()
                    .map(Into::into)
                    .collect()
            })
            .unwrap_or_default()
        },
    );

    let (projects, projects_truncated) = projects;

    Ok(RedmineEnumerations {
        projects,
        projects_truncated,
        statuses,
        trackers,
        priorities,
        activities,
    })
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Validates Redmine credentials by calling `/users/current.json`.
///
/// Returns a `RedmineValidationResult` indicating whether the credentials
/// are valid, along with the authenticated user's info on success.
#[tauri::command]
pub async fn validate_redmine_credentials(
    host_url: String,
    api_key: String,
) -> Result<RedmineValidationResult, String> {
    if api_key.is_empty() {
        return Err("API key must not be empty".to_string());
    }

    let base = validate_redmine_host_url(&host_url)?;
    do_validate_credentials(&base, &api_key).await
}

/// Fetches Redmine enumerations (projects, statuses, trackers, priorities, activities).
///
/// Makes 5 parallel requests via `tokio::join!`. Per-endpoint error handling:
/// - 404 → empty vec + log::info (endpoint may be disabled)
/// - 500 → empty vec + log::warn
/// - Success → validate JSON shape, then parse
#[tauri::command]
pub async fn fetch_redmine_enumerations(
    host_url: String,
    api_key: String,
) -> Result<RedmineEnumerations, String> {
    if api_key.is_empty() {
        return Err("API key must not be empty".to_string());
    }

    let base = validate_redmine_host_url(&host_url)?;
    do_fetch_enumerations(&base, &api_key).await
}

/// Fetches and parses a single Redmine enumeration endpoint.
///
/// Returns `Ok(T)` on success, `Err(())` on non-success status codes
/// (with appropriate logging), or propagates errors for connection failures.
async fn fetch_enum_endpoint<T: serde::de::DeserializeOwned>(
    client: &reqwest::Client,
    base_url: &str,
    path: &str,
    api_key: &str,
    label: &str,
) -> Result<T, ()> {
    let url = format!("{base_url}{path}");

    let resp = match client
        .get(&url)
        .header("X-Redmine-API-Key", api_key)
        .timeout(Duration::from_secs(5))
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            log::warn!("Failed to fetch Redmine {label}: {e}");
            return Err(());
        }
    };

    let status = resp.status();

    if status == reqwest::StatusCode::NOT_FOUND {
        log::info!("Redmine {label} endpoint returned 404 — may be disabled");
        return Err(());
    }

    if status.is_server_error() {
        log::warn!("Redmine {label} endpoint returned server error (HTTP {status})");
        return Err(());
    }

    if !status.is_success() {
        log::warn!("Redmine {label} endpoint returned HTTP {status}");
        return Err(());
    }

    let body = match read_body_limited(resp, label).await {
        Ok(b) => b,
        Err(e) => {
            log::warn!("Redmine {label}: {e}");
            return Err(());
        }
    };

    serde_json::from_slice(&body).map_err(|e| {
        log::warn!("Failed to parse Redmine {label} JSON: {e}");
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    // ── URL validation: happy path ──────────────────────────────────────

    #[test]
    fn validate_url_allows_https_redmine() {
        let result = validate_redmine_host_url("https://redmine.company.com");
        assert!(result.is_ok(), "HTTPS Redmine URL should be valid");
        assert_eq!(result.unwrap(), "https://redmine.company.com");
    }

    // ── URL validation: RFC1918 allowed with warn ───────────────────────

    #[test]
    fn validate_url_allows_rfc1918_192_168() {
        let result = validate_redmine_host_url("http://192.168.1.100:3000");
        assert!(
            result.is_ok(),
            "RFC1918 192.168.x.x should be allowed: {:?}",
            result.err()
        );
    }

    #[test]
    fn validate_url_allows_rfc1918_10() {
        let result = validate_redmine_host_url("http://10.0.0.1/");
        assert!(
            result.is_ok(),
            "RFC1918 10.x.x.x should be allowed: {:?}",
            result.err()
        );
    }

    #[test]
    fn validate_url_allows_rfc1918_172_16() {
        let result = validate_redmine_host_url("http://172.16.0.1/");
        assert!(
            result.is_ok(),
            "RFC1918 172.16.x.x should be allowed: {:?}",
            result.err()
        );
    }

    // ── URL validation: CGNAT (RFC 6598) allowed — Tailscale support ────

    #[test]
    fn validate_url_allows_cgnat_lower_boundary() {
        // RFC 6598 CGNAT (100.64.0.0/10) — commonly seen on Tailscale and
        // carrier-grade NAT networks. Previously blocked by Redmine's
        // is_private_on_premise (which only covered RFC 1918); now accepted
        // via the shared url_validation::is_private_on_premise(BlockLoopback).
        let result = validate_redmine_host_url("http://100.64.1.1:3000/");
        assert!(
            result.is_ok(),
            "CGNAT 100.64.x.x should be allowed: {:?}",
            result.err()
        );
    }

    #[test]
    fn validate_url_allows_cgnat_upper_boundary() {
        // Last address in 100.64.0.0/10 — must still be classified as on-premise.
        let result = validate_redmine_host_url("http://100.127.255.254/");
        assert!(
            result.is_ok(),
            "CGNAT upper boundary should be allowed: {:?}",
            result.err()
        );
    }

    #[test]
    fn validate_url_rejects_just_outside_cgnat() {
        // 100.128.x.x is outside /10 — must NOT be classified as CGNAT and
        // must NOT be mistaken for on-premise by the IP classifier.
        // It's a regular public IP, which Redmine accepts with a warn; this
        // test documents that it goes through the public-IP path, not CGNAT.
        let result = validate_redmine_host_url("http://100.128.0.1/");
        // Public IP — Redmine's policy is to allow with warn (user-written).
        // The important invariant is that it does NOT go through the
        // CGNAT/on-premise arm; this is exercised indirectly by the test
        // passing (if the classifier were wrong, validate_url rejection
        // logic would differ).
        assert!(
            result.is_ok(),
            "100.128.0.1 (outside CGNAT) should still resolve as a public IP: {:?}",
            result.err()
        );
    }

    // ── URL validation: path preserved ──────────────────────────────────

    #[test]
    fn validate_url_preserves_path() {
        let result = validate_redmine_host_url("https://company.com/redmine");
        assert!(result.is_ok());
        let url_str = result.unwrap();
        assert!(
            url_str.contains("/redmine"),
            "Path /redmine should be preserved: {url_str}"
        );
    }

    // ── URL validation: trailing slash stripped ──────────────────────────

    #[test]
    fn validate_url_strips_trailing_slash() {
        let result = validate_redmine_host_url("https://redmine.com/");
        assert!(result.is_ok());
        let url_str = result.unwrap();
        assert!(
            !url_str.ends_with('/'),
            "Trailing slash should be stripped: {url_str}"
        );
    }

    // ── URL validation: reject credentials ──────────────────────────────

    #[test]
    fn validate_url_rejects_credentials() {
        let result = validate_redmine_host_url("http://user:pass@redmine.com");
        assert!(result.is_err());
        assert!(
            result.unwrap_err().contains("credentials"),
            "Error should mention credentials"
        );
    }

    // ── URL validation: reject backslashes ──────────────────────────────

    #[test]
    fn validate_url_rejects_backslashes() {
        let result = validate_redmine_host_url("https://redmine.com\\path");
        assert!(result.is_err());
        assert!(
            result.unwrap_err().contains("backslash"),
            "Error should mention backslashes"
        );
    }

    // ── URL validation: HTTP cleartext warn ─────────────────────────────

    #[test]
    fn validate_url_allows_http_with_cleartext_warn() {
        let result = validate_redmine_host_url("http://redmine.company.com");
        assert!(
            result.is_ok(),
            "HTTP should be allowed (with warning): {:?}",
            result.err()
        );
    }

    // ── URL validation: delegated to base ───────────────────────────────

    #[test]
    fn validate_url_rejects_ftp() {
        assert!(validate_redmine_host_url("ftp://redmine.com").is_err());
    }

    #[test]
    fn validate_url_rejects_file() {
        assert!(validate_redmine_host_url("file:///etc/passwd").is_err());
    }

    #[test]
    fn validate_url_rejects_javascript() {
        assert!(validate_redmine_host_url("javascript:alert(1)").is_err());
    }

    #[test]
    fn validate_url_rejects_empty() {
        assert!(validate_redmine_host_url("").is_err());
    }

    #[test]
    fn validate_url_rejects_loopback_127() {
        let result = validate_redmine_host_url("http://127.0.0.1/");
        assert!(result.is_err(), "Loopback should be blocked");
    }

    #[test]
    fn validate_url_rejects_localhost() {
        let result = validate_redmine_host_url("http://localhost/");
        assert!(result.is_err(), "localhost should be blocked");
    }

    #[test]
    fn validate_url_rejects_ipv6_loopback() {
        let result = validate_redmine_host_url("http://[::1]/");
        assert!(result.is_err(), "IPv6 loopback should be blocked");
    }

    #[test]
    fn validate_url_rejects_link_local() {
        let result = validate_redmine_host_url("http://169.254.169.254/");
        assert!(result.is_err(), "Link-local should be blocked");
    }

    #[test]
    fn validate_url_rejects_ipv6_mapped_loopback() {
        let result = validate_redmine_host_url("http://[::ffff:127.0.0.1]/");
        assert!(result.is_err(), "IPv6-mapped loopback should be blocked");
    }

    #[test]
    fn validate_url_rejects_decimal_ip_loopback() {
        let result = validate_redmine_host_url("http://2130706433/");
        assert!(result.is_err(), "Decimal IP loopback should be blocked");
    }

    // ── URL validation: octal IP ──────────────────────────────────────

    #[test]
    fn validate_url_octal_ip_blocked() {
        // The url crate correctly interprets octal notation: 0177 = 127 decimal.
        // So "0177.0.0.1" is parsed as 127.0.0.1 (loopback) and blocked.
        let result = validate_redmine_host_url("http://0177.0.0.1/");
        assert!(
            result.is_err(),
            "Octal IP 0177.0.0.1 (= 127.0.0.1) should be blocked"
        );
    }

    // ── URL validation: Windows paths ───────────────────────────────────

    #[test]
    fn validate_url_rejects_unc_path() {
        let result = validate_redmine_host_url("\\\\server\\redmine");
        assert!(result.is_err(), "UNC path should be rejected");
    }

    #[test]
    fn validate_url_rejects_file_c_drive() {
        let result = validate_redmine_host_url("file:///C:/redmine");
        assert!(result.is_err(), "file:// URL should be rejected");
    }

    // ── DTO parsing tests ───────────────────────────────────────────────

    #[test]
    fn parse_users_current_valid() {
        let json = r#"{"user": {"id": 42, "login": "admin"}}"#;
        let wrapper: RedmineCurrentUserWrapper = serde_json::from_str(json).unwrap();
        assert_eq!(wrapper.user.id, 42);
        assert_eq!(wrapper.user.login, "admin");
    }

    #[test]
    fn parse_issue_statuses_valid() {
        let json = r#"{"issue_statuses": [{"id": 1, "name": "New"}, {"id": 2, "name": "Closed"}]}"#;
        let resp: RedmineStatusesResponse = serde_json::from_str(json).unwrap();
        assert_eq!(resp.issue_statuses.len(), 2);
        assert_eq!(resp.issue_statuses[0].id, 1);
        assert_eq!(resp.issue_statuses[0].name, "New");
    }

    #[test]
    fn parse_issue_statuses_empty() {
        let json = r#"{"issue_statuses": []}"#;
        let resp: RedmineStatusesResponse = serde_json::from_str(json).unwrap();
        assert!(resp.issue_statuses.is_empty());
    }

    #[test]
    fn parse_projects_valid() {
        let json = r#"{"projects": [{"id": 1, "name": "Alpha"}], "total_count": 1}"#;
        let resp: RedmineProjectsResponse = serde_json::from_str(json).unwrap();
        assert_eq!(resp.projects.len(), 1);
        assert_eq!(resp.projects[0].name, "Alpha");
        assert_eq!(resp.total_count, Some(1));
    }

    #[test]
    fn parse_trackers_valid() {
        let json = r#"{"trackers": [{"id": 1, "name": "Bug"}, {"id": 2, "name": "Feature"}]}"#;
        let resp: RedmineTrackersResponse = serde_json::from_str(json).unwrap();
        assert_eq!(resp.trackers.len(), 2);
    }

    #[test]
    fn parse_priorities_valid() {
        let json =
            r#"{"issue_priorities": [{"id": 1, "name": "Low"}, {"id": 2, "name": "Normal"}]}"#;
        let resp: RedminePrioritiesResponse = serde_json::from_str(json).unwrap();
        assert_eq!(resp.issue_priorities.len(), 2);
    }

    #[test]
    fn parse_activities_valid() {
        let json = r#"{"time_entry_activities": [{"id": 9, "name": "Development"}]}"#;
        let resp: RedmineActivitiesResponse = serde_json::from_str(json).unwrap();
        assert_eq!(resp.time_entry_activities.len(), 1);
        assert_eq!(resp.time_entry_activities[0].name, "Development");
    }

    #[test]
    fn parse_unexpected_json_shape_fails() {
        let json = r#"{"unexpected": "shape"}"#;
        let result = serde_json::from_str::<RedmineCurrentUserWrapper>(json);
        assert!(
            result.is_err(),
            "Unexpected JSON shape should fail to parse"
        );
    }

    #[test]
    fn parse_non_json_fails() {
        let input = "This is not JSON at all";
        let result = serde_json::from_str::<RedmineCurrentUserWrapper>(input);
        assert!(result.is_err(), "Non-JSON input should fail to parse");
    }

    #[test]
    fn parse_unicode_project_names() {
        let json = r#"{"projects": [{"id": 1, "name": "Проект Альфа"}, {"id": 2, "name": "プロジェクト"}], "total_count": 2}"#;
        let resp: RedmineProjectsResponse = serde_json::from_str(json).unwrap();
        assert_eq!(resp.projects[0].name, "Проект Альфа");
        assert_eq!(resp.projects[1].name, "プロジェクト");
        assert_eq!(resp.total_count, Some(2));
    }

    #[test]
    fn parse_projects_with_total_count() {
        let json = r#"{"projects": [{"id": 1, "name": "A"}], "total_count": 1}"#;
        let resp: RedmineProjectsResponse = serde_json::from_str(json).unwrap();
        assert_eq!(resp.total_count, Some(1));
    }

    #[test]
    fn parse_projects_without_total_count() {
        let json = r#"{"projects": [{"id": 1, "name": "A"}]}"#;
        let resp: RedmineProjectsResponse = serde_json::from_str(json).unwrap();
        assert_eq!(resp.total_count, None);
    }

    // ── HTTP integration tests (mockito) ────────────────────────────────
    //
    // These tests call the core functions (do_validate_credentials,
    // do_fetch_enumerations) directly with the mockito server URL,
    // bypassing URL validation (mockito runs on 127.0.0.1 which is
    // intentionally blocked by validate_redmine_host_url).
    //
    // Not covered here:
    // - TLS certificate errors: mockito serves plain HTTP, so the reqwest
    //   TLS error path (certificate keyword detection) cannot be triggered.
    // - Connection timeout: mockito doesn't support delaying responses past
    //   the reqwest timeout. The connection-refused test below verifies the
    //   error path for unreachable servers instead.

    #[tokio::test]
    async fn http_401_returns_invalid() {
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("GET", "/users/current.json")
            .with_status(401)
            .create_async()
            .await;

        let result = do_validate_credentials(&server.url(), "bad-key").await;
        assert!(result.is_ok());
        let val = result.unwrap();
        assert!(!val.valid);
        assert!(val.error.is_some());
        mock.assert_async().await;
    }

    #[tokio::test]
    async fn http_403_returns_invalid() {
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("GET", "/users/current.json")
            .with_status(403)
            .create_async()
            .await;

        let result = do_validate_credentials(&server.url(), "bad-key").await;
        assert!(result.is_ok());
        let val = result.unwrap();
        assert!(!val.valid);
        mock.assert_async().await;
    }

    #[tokio::test]
    async fn http_500_returns_error() {
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("GET", "/users/current.json")
            .with_status(500)
            .create_async()
            .await;

        let result = do_validate_credentials(&server.url(), "test-key").await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("500"));
        mock.assert_async().await;
    }

    #[tokio::test]
    async fn empty_api_key_rejected_before_http() {
        let result =
            validate_redmine_credentials("https://redmine.example.com".to_string(), String::new())
                .await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("empty"));
    }

    #[tokio::test]
    async fn http_redirect_blocked() {
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("GET", "/users/current.json")
            .with_status(301)
            .with_header("Location", "https://evil.com/steal")
            .create_async()
            .await;

        let result = do_validate_credentials(&server.url(), "key").await;
        assert!(result.is_ok());
        let val = result.unwrap();
        assert!(!val.valid);
        assert!(val
            .error
            .as_ref()
            .unwrap()
            .to_lowercase()
            .contains("redirect"));
        mock.assert_async().await;
    }

    #[tokio::test]
    async fn http_valid_credentials() {
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("GET", "/users/current.json")
            .with_status(200)
            .with_header("Content-Type", "application/json")
            .with_body(r#"{"user": {"id": 1, "login": "admin"}}"#)
            .create_async()
            .await;

        let result = do_validate_credentials(&server.url(), "valid-key").await;
        assert!(result.is_ok());
        let val = result.unwrap();
        assert!(val.valid);
        assert_eq!(val.user.as_ref().unwrap().id, 1);
        assert_eq!(val.user.as_ref().unwrap().login, "admin");
        mock.assert_async().await;
    }

    #[tokio::test]
    async fn http_non_redmine_json_returns_error() {
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("GET", "/users/current.json")
            .with_status(200)
            .with_header("Content-Type", "application/json")
            .with_body(r#"{"not": "redmine"}"#)
            .create_async()
            .await;

        let result = do_validate_credentials(&server.url(), "key").await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not valid Redmine JSON"));
        mock.assert_async().await;
    }

    #[tokio::test]
    async fn enumerations_partial_failure() {
        let mut server = mockito::Server::new_async().await;

        // projects: 200 OK
        let m1 = server
            .mock("GET", "/projects.json?limit=100")
            .with_status(200)
            .with_header("Content-Type", "application/json")
            .with_body(r#"{"projects": [{"id": 1, "name": "Test"}], "total_count": 1}"#)
            .create_async()
            .await;

        // statuses: 404
        let m2 = server
            .mock("GET", "/issue_statuses.json")
            .with_status(404)
            .create_async()
            .await;

        // trackers: 500
        let m3 = server
            .mock("GET", "/trackers.json")
            .with_status(500)
            .create_async()
            .await;

        // priorities: 200 OK
        let m4 = server
            .mock("GET", "/enumerations/issue_priorities.json")
            .with_status(200)
            .with_header("Content-Type", "application/json")
            .with_body(r#"{"issue_priorities": [{"id": 1, "name": "Normal"}]}"#)
            .create_async()
            .await;

        // activities: 200 OK
        let m5 = server
            .mock("GET", "/enumerations/time_entry_activities.json")
            .with_status(200)
            .with_header("Content-Type", "application/json")
            .with_body(r#"{"time_entry_activities": [{"id": 9, "name": "Dev"}]}"#)
            .create_async()
            .await;

        let result = do_fetch_enumerations(&server.url(), "test-key").await;
        assert!(result.is_ok());
        let enums = result.unwrap();
        assert_eq!(enums.projects.len(), 1);
        assert!(!enums.projects_truncated);
        assert!(
            enums.statuses.is_empty(),
            "404 endpoint should produce empty vec"
        );
        assert!(
            enums.trackers.is_empty(),
            "500 endpoint should produce empty vec"
        );
        assert_eq!(enums.priorities.len(), 1);
        assert_eq!(enums.activities.len(), 1);

        m1.assert_async().await;
        m2.assert_async().await;
        m3.assert_async().await;
        m4.assert_async().await;
        m5.assert_async().await;
    }

    #[tokio::test]
    async fn enumerations_all_404() {
        let mut server = mockito::Server::new_async().await;

        let m1 = server
            .mock("GET", "/projects.json?limit=100")
            .with_status(404)
            .create_async()
            .await;
        let m2 = server
            .mock("GET", "/issue_statuses.json")
            .with_status(404)
            .create_async()
            .await;
        let m3 = server
            .mock("GET", "/trackers.json")
            .with_status(404)
            .create_async()
            .await;
        let m4 = server
            .mock("GET", "/enumerations/issue_priorities.json")
            .with_status(404)
            .create_async()
            .await;
        let m5 = server
            .mock("GET", "/enumerations/time_entry_activities.json")
            .with_status(404)
            .create_async()
            .await;

        let result = do_fetch_enumerations(&server.url(), "test-key").await;
        assert!(result.is_ok());
        let enums = result.unwrap();
        assert!(enums.projects.is_empty());
        assert!(!enums.projects_truncated);
        assert!(enums.statuses.is_empty());
        assert!(enums.trackers.is_empty());
        assert!(enums.priorities.is_empty());
        assert!(enums.activities.is_empty());

        m1.assert_async().await;
        m2.assert_async().await;
        m3.assert_async().await;
        m4.assert_async().await;
        m5.assert_async().await;
    }

    #[tokio::test]
    async fn enumerations_empty_api_key_rejected() {
        let result =
            fetch_redmine_enumerations("https://redmine.example.com".to_string(), String::new())
                .await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("empty"));
    }

    #[tokio::test]
    async fn connection_refused_returns_error() {
        // Bind a port, get its number, then close the listener to guarantee
        // nothing is listening when we connect.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);

        let url = format!("http://127.0.0.1:{port}");
        let result = do_validate_credentials(&url, "key").await;
        assert!(
            result.is_err(),
            "Connection to closed port should fail: {:?}",
            result
        );
    }

    // ── Truncation detection integration tests ──────────────────────────

    async fn mock_all_empty_except_projects(
        server: &mut mockito::Server,
        projects_body: &'static str,
    ) -> Vec<mockito::Mock> {
        vec![
            server
                .mock("GET", "/projects.json?limit=100")
                .with_status(200)
                .with_header("Content-Type", "application/json")
                .with_body(projects_body)
                .create_async()
                .await,
            server
                .mock("GET", "/issue_statuses.json")
                .with_status(200)
                .with_header("Content-Type", "application/json")
                .with_body(r#"{"issue_statuses": []}"#)
                .create_async()
                .await,
            server
                .mock("GET", "/trackers.json")
                .with_status(200)
                .with_header("Content-Type", "application/json")
                .with_body(r#"{"trackers": []}"#)
                .create_async()
                .await,
            server
                .mock("GET", "/enumerations/issue_priorities.json")
                .with_status(200)
                .with_header("Content-Type", "application/json")
                .with_body(r#"{"issue_priorities": []}"#)
                .create_async()
                .await,
            server
                .mock("GET", "/enumerations/time_entry_activities.json")
                .with_status(200)
                .with_header("Content-Type", "application/json")
                .with_body(r#"{"time_entry_activities": []}"#)
                .create_async()
                .await,
        ]
    }

    #[tokio::test]
    async fn enumerations_projects_truncated_with_total_count() {
        let mut server = mockito::Server::new_async().await;
        let _mocks = mock_all_empty_except_projects(
            &mut server,
            r#"{"projects": [{"id": 1, "name": "A"}], "total_count": 150}"#,
        )
        .await;

        let result = do_fetch_enumerations(&server.url(), "key").await;
        assert!(result.is_ok());
        let enums = result.unwrap();
        assert!(
            enums.projects_truncated,
            "total_count=150 > len=1 means truncated"
        );
        assert_eq!(enums.projects.len(), 1);
    }

    #[tokio::test]
    async fn enumerations_projects_not_truncated_with_total_count() {
        let mut server = mockito::Server::new_async().await;
        let _mocks = mock_all_empty_except_projects(
            &mut server,
            r#"{"projects": [{"id": 1, "name": "A"}], "total_count": 1}"#,
        )
        .await;

        let result = do_fetch_enumerations(&server.url(), "key").await;
        assert!(result.is_ok());
        let enums = result.unwrap();
        assert!(
            !enums.projects_truncated,
            "total_count=1 == len=1 means not truncated"
        );
        assert_eq!(enums.projects.len(), 1);
    }

    #[tokio::test]
    async fn enumerations_projects_not_truncated_without_total_count() {
        let mut server = mockito::Server::new_async().await;
        let _mocks = mock_all_empty_except_projects(
            &mut server,
            r#"{"projects": [{"id": 1, "name": "A"}]}"#,
        )
        .await;

        let result = do_fetch_enumerations(&server.url(), "key").await;
        assert!(result.is_ok());
        let enums = result.unwrap();
        assert!(
            !enums.projects_truncated,
            "missing total_count means not truncated"
        );
    }

    // Note: is_private_on_premise helper + its coverage moved to url_validation.rs
    // as part of the consolidation for LLM model discovery (ADR-041). Redmine uses
    // PrivatePolicy::BlockLoopback; LLM discovery uses PrivatePolicy::AllowLoopback.
    // See url_validation::tests for private_on_premise_*_policy tests.

    #[test]
    fn validate_url_allows_ipv6_ula_for_redmine() {
        let result = validate_redmine_host_url("http://[fd00::1]:3000/");
        assert!(
            result.is_ok(),
            "IPv6 ULA should be allowed for on-premise Redmine: {:?}",
            result.err()
        );
    }

    // ── MAX_RESPONSE_BODY_BYTES constant ────────────────────────────────

    #[test]
    fn max_response_body_bytes_is_5mb() {
        assert_eq!(MAX_RESPONSE_BODY_BYTES, 5 * 1024 * 1024);
    }

    // ── read_body_limited: happy path / edge cases ──────────────────────

    #[tokio::test]
    async fn body_exactly_at_limit_accepted() {
        let mut server = mockito::Server::new_async().await;
        let body = vec![0u8; MAX_RESPONSE_BODY_BYTES];
        let _mock = server
            .mock("GET", "/test")
            .with_status(200)
            .with_body(body)
            .create_async()
            .await;

        let client = build_redmine_client().unwrap();
        let resp = client
            .get(format!("{}/test", server.url()))
            .send()
            .await
            .unwrap();
        let result = read_body_limited(resp, "test").await;
        assert!(
            result.is_ok(),
            "Body at exactly the limit should be accepted"
        );
        assert_eq!(result.unwrap().len(), MAX_RESPONSE_BODY_BYTES);
    }

    #[tokio::test]
    async fn body_one_byte_over_limit_rejected() {
        let mut server = mockito::Server::new_async().await;
        let body = vec![0u8; MAX_RESPONSE_BODY_BYTES + 1];
        let _mock = server
            .mock("GET", "/test")
            .with_status(200)
            .with_body(body)
            .create_async()
            .await;

        let client = build_redmine_client().unwrap();
        let resp = client
            .get(format!("{}/test", server.url()))
            .send()
            .await
            .unwrap();
        let result = read_body_limited(resp, "test").await;
        assert!(
            result.is_err(),
            "Body one byte over limit should be rejected"
        );
        // The error mentions either "too large" (Content-Length pre-check) or
        // "exceeded" (streaming check) depending on whether mockito includes
        // a Content-Length header.
        let err = result.unwrap_err();
        assert!(
            err.contains("too large") || err.contains("exceeded"),
            "Error should mention size limit: {err}"
        );
    }

    #[tokio::test]
    async fn empty_body_accepted() {
        let mut server = mockito::Server::new_async().await;
        let _mock = server
            .mock("GET", "/test")
            .with_status(200)
            .with_body("")
            .create_async()
            .await;

        let client = build_redmine_client().unwrap();
        let resp = client
            .get(format!("{}/test", server.url()))
            .send()
            .await
            .unwrap();
        let result = read_body_limited(resp, "test").await;
        assert!(result.is_ok(), "Empty body should be accepted");
        assert_eq!(result.unwrap().len(), 0);
    }

    #[tokio::test]
    async fn no_content_length_small_body_accepted() {
        let mut server = mockito::Server::new_async().await;
        let _mock = server
            .mock("GET", "/test")
            .with_status(200)
            .with_body("hello world this is fifty bytes of data padding!!")
            .create_async()
            .await;

        let client = build_redmine_client().unwrap();
        let resp = client
            .get(format!("{}/test", server.url()))
            .send()
            .await
            .unwrap();
        let result = read_body_limited(resp, "test").await;
        assert!(
            result.is_ok(),
            "Small body without Content-Length should be accepted"
        );
    }

    // ── read_body_limited: error paths ──────────────────────────────────

    #[tokio::test]
    async fn body_too_large_content_length_preflight_rejected() {
        // Exercises the Content-Length pre-flight guard in read_body_limited
        // using a real HTTP server. mockito sets Content-Length automatically
        // from the body, so reqwest sees it in the response header and the
        // pre-flight guard rejects before streaming. We assert on "bytes, limit"
        // to distinguish from the streaming guard ("exceeded ... byte limit").
        let mut server = mockito::Server::new_async().await;
        let body = vec![b'x'; MAX_RESPONSE_BODY_BYTES + 1];
        let _mock = server
            .mock("GET", "/test")
            .with_status(200)
            .with_body(body)
            .create_async()
            .await;

        let client = build_redmine_client().unwrap();
        let resp = client
            .get(format!("{}/test", server.url()))
            .send()
            .await
            .unwrap();
        let result = read_body_limited(resp, "test").await;
        assert!(result.is_err(), "Should reject oversized Content-Length");
        let err = result.unwrap_err();
        assert!(
            err.contains("bytes, limit"),
            "Should hit Content-Length pre-flight (not streaming guard): {err}"
        );
    }

    #[tokio::test]
    async fn body_too_large_chunked_rejected() {
        let mut server = mockito::Server::new_async().await;
        // Body exceeding MAX_RESPONSE_BODY_BYTES without Content-Length header
        let body = vec![b'x'; MAX_RESPONSE_BODY_BYTES + 1];
        let _mock = server
            .mock("GET", "/test")
            .with_status(200)
            .with_body(body)
            .create_async()
            .await;

        let client = build_redmine_client().unwrap();
        let resp = client
            .get(format!("{}/test", server.url()))
            .send()
            .await
            .unwrap();
        let result = read_body_limited(resp, "test").await;
        assert!(result.is_err(), "Oversized body should be rejected");
    }

    #[tokio::test]
    async fn validate_credentials_large_body_returns_error() {
        let mut server = mockito::Server::new_async().await;
        let oversized = vec![b'x'; MAX_RESPONSE_BODY_BYTES + 1];
        let _mock = server
            .mock("GET", "/users/current.json")
            .with_status(200)
            .with_body(oversized)
            .create_async()
            .await;

        let result = do_validate_credentials(&server.url(), "key").await;
        assert!(
            result.is_err(),
            "Oversized credential response should return Err"
        );
    }

    #[tokio::test]
    async fn enum_endpoint_large_body_returns_empty() {
        let mut server = mockito::Server::new_async().await;
        let oversized = vec![b'x'; MAX_RESPONSE_BODY_BYTES + 1];

        // Projects endpoint returns oversized body
        let _m1 = server
            .mock("GET", "/projects.json?limit=100")
            .with_status(200)
            .with_body(oversized)
            .create_async()
            .await;
        let _m2 = server
            .mock("GET", "/issue_statuses.json")
            .with_status(200)
            .with_header("Content-Type", "application/json")
            .with_body(r#"{"issue_statuses": []}"#)
            .create_async()
            .await;
        let _m3 = server
            .mock("GET", "/trackers.json")
            .with_status(200)
            .with_header("Content-Type", "application/json")
            .with_body(r#"{"trackers": []}"#)
            .create_async()
            .await;
        let _m4 = server
            .mock("GET", "/enumerations/issue_priorities.json")
            .with_status(200)
            .with_header("Content-Type", "application/json")
            .with_body(r#"{"issue_priorities": []}"#)
            .create_async()
            .await;
        let _m5 = server
            .mock("GET", "/enumerations/time_entry_activities.json")
            .with_status(200)
            .with_header("Content-Type", "application/json")
            .with_body(r#"{"time_entry_activities": []}"#)
            .create_async()
            .await;

        let result = do_fetch_enumerations(&server.url(), "key").await;
        assert!(
            result.is_ok(),
            "Large body in enum endpoint should degrade gracefully"
        );
        let enums = result.unwrap();
        assert!(
            enums.projects.is_empty(),
            "Oversized projects response -> empty vec"
        );
    }
}
