// LLM model discovery — Tauri command for probing local LLM servers.
//
// When a user configures a local-LLM provider in Settings (ollama, lmstudio,
// llamacpp) the Desktop can hit the server's `/v1/models` or `/api/tags`
// endpoint and present the advertised models as a `<select>`.
// The same SSRF-safe validation path (`validate_llm_base_url`) is reused by
// `containers_cmd::update_llm_config` so both discover and save reject
// link-local, metadata, and other dangerous URLs.
//
// See docs/adr/ADR-041-local-llm-model-discovery.md for the threat model and
// the RFC1918/loopback/public-domain policy rationale.

use serde::Deserialize;
use std::time::Duration;

use crate::http_util::{read_body_limited, MAX_RESPONSE_BODY_BYTES};
use crate::url_validation::{is_private_on_premise, validate_url, PrivatePolicy};

/// Production timeout for the HTTP probe. Localhost / LAN should respond well
/// under this; a model mid-load that hasn't come up yet will time out and
/// the UI falls back to the free-text input.
const DISCOVERY_TIMEOUT_SECS: u64 = 5;

// ---------------------------------------------------------------------------
// Response DTOs
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct OllamaTagsResponse {
    /// Ollama returns the list under `models`. Additional fields (`model`,
    /// `modified_at`, `size`, `digest`, `details`) are ignored — no
    /// `deny_unknown_fields` so a future Ollama schema extension won't break us.
    models: Vec<OllamaModel>,
}

#[derive(Debug, Deserialize)]
struct OllamaModel {
    name: String,
}

#[derive(Debug, Deserialize)]
struct OpenAIModelsResponse {
    /// OpenAI-compatible servers (LM Studio, llama.cpp) advertise models under
    /// `data`.
    data: Vec<OpenAIModel>,
}

#[derive(Debug, Deserialize)]
struct OpenAIModel {
    id: String,
}

// ---------------------------------------------------------------------------
// Pure parsers (tested in isolation, no HTTP)
// ---------------------------------------------------------------------------

fn parse_ollama(body: &[u8]) -> anyhow::Result<Vec<String>> {
    let resp: OllamaTagsResponse = serde_json::from_slice(body)
        .map_err(|e| anyhow::anyhow!("failed to parse Ollama /api/tags response: {e}"))?;
    Ok(resp.models.into_iter().map(|m| m.name).collect())
}

fn parse_openai(body: &[u8]) -> anyhow::Result<Vec<String>> {
    let resp: OpenAIModelsResponse = serde_json::from_slice(body)
        .map_err(|e| anyhow::anyhow!("failed to parse OpenAI /v1/models response: {e}"))?;
    Ok(resp.data.into_iter().map(|m| m.id).collect())
}

// ---------------------------------------------------------------------------
// URL validation (shared between discover and save paths)
// ---------------------------------------------------------------------------

/// Validates a base URL for a local LLM provider.
///
/// Policy (see ADR-041):
/// - Loopback (127.0.0.0/8, ::1, IPv6-mapped loopback) — allowed with `warn!`.
/// - RFC 1918 private + IPv6 ULA (fc00::/7) — allowed with `warn!`.
/// - Link-local / metadata / reserved — rejected via `validate_url`.
/// - Public IP / public domain — allowed with `warn!` (user-written URL; same
///   threat model as Redmine's `validate_redmine_host_url`).
/// - `http://` scheme warns about cleartext transmission.
///
/// Rejects embedded credentials, backslashes, query strings, fragments, and
/// non-HTTP schemes in all cases.
///
/// Returns the parsed `url::Url` so callers (the discover pipeline) can reuse
/// the parse result without re-parsing.
pub(crate) fn validate_llm_base_url(url: &str) -> Result<url::Url, String> {
    // Reject backslashes before parsing (Windows path confusion)
    if url.contains('\\') {
        return Err("URL must not contain backslashes".to_string());
    }

    let candidate: url::Url = url.parse().map_err(|e: url::ParseError| e.to_string())?;

    // Reject query and fragment up front — LLM endpoints are canonical paths.
    if candidate.query().is_some() {
        return Err("URL must not contain a query string".to_string());
    }
    if candidate.fragment().is_some() {
        return Err("URL must not contain a fragment".to_string());
    }

    // If the host is a private on-premise address (loopback, RFC1918, ULA) OR
    // the literal hostname `localhost` (which `validate_url` otherwise blocks),
    // skip the base validator and check scheme/host ourselves. Otherwise
    // delegate to `validate_url` which handles link-local rejection, IPv6-mapped
    // IPv4 bypass prevention, decimal IP bypass, and the full RFC 5737 / 2544 /
    // 6666 / 3849 reserved-range set.
    let host_is_localhost = matches!(
        candidate.host(),
        Some(url::Host::Domain(d)) if d.eq_ignore_ascii_case("localhost")
    );
    let parsed =
        if host_is_localhost || is_private_on_premise(&candidate, PrivatePolicy::AllowLoopback) {
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
            let host = candidate.host_str().unwrap_or("unknown");
            if host_is_localhost || is_loopback_host(&candidate) {
                log::warn!("Allowing loopback address for local LLM: {}", host);
            } else {
                log::warn!("Allowing private address for local LLM: {}", host);
            }
            candidate
        } else {
            let v = validate_url(url)?;
            log::warn!(
                "Allowing public address for local LLM: {}",
                v.host_str().unwrap_or("unknown")
            );
            v
        };

    // Reject embedded credentials.
    if parsed.password().is_some() || !parsed.username().is_empty() {
        return Err("URL must not contain embedded credentials".to_string());
    }

    // Warn about cleartext HTTP (credentials are not transmitted, but an
    // on-path attacker can still read LLM traffic content).
    if parsed.scheme() == "http" {
        log::warn!("LLM traffic will be transmitted in cleartext over HTTP");
    }

    Ok(parsed)
}

/// Returns true when the parsed URL's host is an IPv4/IPv6 loopback address
/// (native or IPv6-mapped). Used purely to pick the right `warn!` message.
fn is_loopback_host(url: &url::Url) -> bool {
    match url.host() {
        Some(url::Host::Ipv4(v4)) => v4.is_loopback(),
        Some(url::Host::Ipv6(v6)) => {
            v6.is_loopback()
                || v6
                    .to_ipv4_mapped()
                    .map(|v4| v4.is_loopback())
                    .unwrap_or(false)
        }
        _ => false,
    }
}

// ---------------------------------------------------------------------------
// HTTP client helper
// ---------------------------------------------------------------------------

/// Builds an HTTP client for the LLM discovery probe. Redirects disabled to prevent SSRF.
fn build_llm_probe_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(format!("Speedwave-Desktop/{}", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))
}

// ---------------------------------------------------------------------------
// Endpoint selection
// ---------------------------------------------------------------------------

/// Returns the path suffix to append to the validated base URL for the given
/// provider, or `Err("unsupported")` for unknown / anthropic providers.
fn endpoint_path(provider: &str) -> Result<&'static str, String> {
    match provider {
        "anthropic" => Err("unsupported".to_string()),
        "ollama" => Ok("/api/tags"),
        "lmstudio" | "llamacpp" => Ok("/v1/models"),
        _ => Err("unsupported".to_string()),
    }
}

// ---------------------------------------------------------------------------
// URL normalisation pipeline
// ---------------------------------------------------------------------------

/// Strips `/v1`, rewrites container host aliases, and runs SSRF validation.
///
/// Returns the validated `url::Url` ready for endpoint path composition.
fn normalize_and_validate_discovery_url(base_url: &str) -> Result<url::Url, String> {
    // 1. Strip trailing /v1 (Ollama docs sometimes include it).
    let normalized = speedwave_runtime::compose::strip_trailing_v1(base_url);

    // 2. Parse URL; early-Err on malformed input.
    let mut parsed: url::Url = normalized
        .parse()
        .map_err(|e: url::ParseError| format!("Invalid base_url: {e}"))?;

    // 3. Rewrite container-side host aliases (host.docker.internal etc.) to
    //    loopback. On the Desktop host process, those aliases are not in
    //    /etc/hosts — we need to hit the server on 127.0.0.1 directly.
    if let Some(host_str) = parsed.host_str() {
        if let Some(loopback) = crate::http_util::rewrite_container_alias_to_loopback(host_str) {
            parsed
                .set_host(Some(loopback))
                .map_err(|e| format!("URL host rewrite failed: {e}"))?;
        }
    }

    // 4. SSRF-safe validation (same function used by the save path).
    validate_llm_base_url(parsed.as_str())
}

// ---------------------------------------------------------------------------
// Core logic (parameterized timeout for testing)
// ---------------------------------------------------------------------------

/// Discovers available models from a local LLM server.
///
/// `timeout` controls both the reqwest-level request timeout. Production uses
/// `DISCOVERY_TIMEOUT_SECS` via the Tauri wrapper; tests pass shorter
/// durations to keep the suite fast.
///
/// Returns `Err("empty")` when the server responds OK but with no models (a
/// server up without any model loaded). The UI treats this the same as an
/// offline server and falls back to the free-text input.
pub(crate) async fn do_discover_llm_models(
    provider: &str,
    base_url: &str,
    client: &reqwest::Client,
    timeout: Duration,
) -> Result<Vec<String>, String> {
    // 1. Short-circuit anthropic — there's no local model-list endpoint.
    if provider == "anthropic" {
        return Err("unsupported".to_string());
    }

    // 2. Normalise URL: strip /v1, rewrite container aliases, SSRF-validate.
    let validated = normalize_and_validate_discovery_url(base_url)?;

    // 3. Compose the endpoint URL.
    let endpoint_suffix = endpoint_path(provider)?;
    let url = format!(
        "{}{}",
        validated.as_str().trim_end_matches('/'),
        endpoint_suffix
    );

    // 4. Issue the GET with the requested timeout.
    let resp = client
        .get(&url)
        .header("Accept", "application/json")
        .timeout(timeout)
        .send()
        .await
        .map_err(|e| {
            log::debug!("LLM model discovery: HTTP send failed for {url}: {e}");
            format!("LLM model discovery: request failed: {e}")
        })?;

    // 5. Status check. 3xx is treated as non-2xx because we disabled redirect
    //    following — a 3xx here means the server tried to bounce us, which is
    //    either a misconfiguration or an SSRF attempt. warn!-level for
    //    security auditability.
    let status = resp.status();
    if !status.is_success() {
        if status.is_redirection() {
            log::warn!(
                "LLM model discovery: refusing to follow {} redirect to {}",
                status.as_u16(),
                resp.headers()
                    .get("location")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("<missing>")
            );
        } else {
            log::debug!("LLM model discovery: non-2xx status {}", status.as_u16());
        }
        return Err(format!("LLM server returned HTTP {}", status.as_u16()));
    }

    // 6. Content-Type sanity. A 200 with text/html body means the user
    //    probably pointed at a Grafana / admin UI rather than an LLM server.
    //    Case-insensitive prefix match (charset params vary).
    if let Some(ct) = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
    {
        if ct.to_ascii_lowercase().starts_with("text/html") {
            log::debug!("LLM model discovery: unexpected HTML response");
            return Err("LLM server returned an HTML response".to_string());
        }
    }

    // 7. Body read with size cap (protects against OOM).
    let body = read_body_limited(resp, "LLM model discovery").await?;

    // 8. Parse per provider.
    let models = match provider {
        "ollama" => parse_ollama(&body).map_err(|e| {
            log::debug!("LLM model discovery: Ollama parse failed: {e}");
            format!("Failed to parse Ollama response: {e}")
        })?,
        _ => parse_openai(&body).map_err(|e| {
            log::debug!("LLM model discovery: OpenAI parse failed: {e}");
            format!("Failed to parse OpenAI-compatible response: {e}")
        })?,
    };

    log::debug!(
        "LLM model discovery: {} returned {} model(s)",
        provider,
        models.len()
    );

    // 9. Empty list is a failure — UI will show the free-text input.
    if models.is_empty() {
        return Err("empty".to_string());
    }

    // Sanity: ensure we haven't accidentally accepted a body larger than the
    // cap. This is defensive — read_body_limited already enforces.
    debug_assert!(body.len() <= MAX_RESPONSE_BODY_BYTES);

    Ok(models)
}

// ---------------------------------------------------------------------------
// Tauri command (thin wrapper)
// ---------------------------------------------------------------------------

/// Tauri entry point for LLM model discovery. Builds a per-call reqwest client
/// and delegates to `do_discover_llm_models` with the production timeout.
#[tauri::command]
pub async fn discover_llm_models(
    provider: String,
    base_url: String,
) -> Result<Vec<String>, String> {
    let client = build_llm_probe_client()?;
    do_discover_llm_models(
        &provider,
        &base_url,
        &client,
        Duration::from_secs(DISCOVERY_TIMEOUT_SECS),
    )
    .await
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use std::sync::{Mutex, OnceLock};

    // ── normalize_and_validate_discovery_url ────────────────────────────

    #[test]
    fn normalize_strips_v1_suffix() {
        let url = normalize_and_validate_discovery_url("http://127.0.0.1:11434/v1").unwrap();
        assert!(
            !url.as_str().contains("/v1"),
            "expected /v1 to be stripped; got: {}",
            url
        );
        assert_eq!(url.host_str(), Some("127.0.0.1"));
    }

    #[test]
    fn normalize_rewrites_container_alias() {
        let url =
            normalize_and_validate_discovery_url("http://host.docker.internal:11434").unwrap();
        assert_eq!(
            url.host_str(),
            Some("127.0.0.1"),
            "expected container alias rewritten to 127.0.0.1; got: {}",
            url
        );
    }

    #[test]
    fn normalize_rejects_metadata_ip() {
        let err = normalize_and_validate_discovery_url("http://169.254.169.254").unwrap_err();
        assert!(
            err.to_lowercase().contains("private") || err.to_lowercase().contains("reserved"),
            "expected metadata IP rejection; got: {err}"
        );
    }

    // ── Pure parsers ────────────────────────────────────────────────────

    #[test]
    fn parse_ollama_happy_path() {
        // Extra fields (`model`, `modified_at`, …) MUST NOT break parse — we
        // deliberately do not set `deny_unknown_fields`.
        let body = br#"{
            "models": [
                {
                    "name": "llama3.3",
                    "model": "llama3.3:latest",
                    "modified_at": "2024-01-01T00:00:00Z",
                    "size": "4000000000",
                    "digest": "",
                    "details": { "format": "gguf" }
                },
                { "name": "qwen2.5" }
            ]
        }"#;
        assert_eq!(parse_ollama(body).unwrap(), vec!["llama3.3", "qwen2.5"]);
    }

    #[test]
    fn parse_ollama_empty_list() {
        let body = br#"{ "models": [] }"#;
        assert!(parse_ollama(body).unwrap().is_empty());
    }

    #[test]
    fn parse_ollama_malformed_json() {
        assert!(parse_ollama(b"not json at all").is_err());
    }

    #[test]
    fn parse_ollama_wrong_outer_type() {
        assert!(parse_ollama(b"[]").is_err());
    }

    #[test]
    fn parse_ollama_wrong_field_type_for_name() {
        let body = br#"{ "models": [ { "name": 42 } ] }"#;
        assert!(parse_ollama(body).is_err());
    }

    #[test]
    fn parse_openai_happy_path() {
        let body = br#"{
            "data": [
                { "id": "gpt-oss", "object": "model", "owned_by": "organization" },
                { "id": "qwen" }
            ]
        }"#;
        assert_eq!(parse_openai(body).unwrap(), vec!["gpt-oss", "qwen"]);
    }

    #[test]
    fn parse_openai_empty_list() {
        assert!(parse_openai(br#"{ "data": [] }"#).unwrap().is_empty());
    }

    #[test]
    fn parse_openai_malformed_json() {
        assert!(parse_openai(b"{bad").is_err());
    }

    #[test]
    fn parse_openai_wrong_outer_type() {
        assert!(parse_openai(b"[]").is_err());
    }

    // ── validate_llm_base_url: branch coverage ──────────────────────────
    //
    // `url_validation::validate_url` already has 50+ tests covering every
    // RFC-reserved range and IPv6-mapped IPv4 bypass. These tests cover the
    // LLM-specific delta: branch selection (on-premise arm vs. delegation
    // arm) and the policy difference (loopback allowed).

    #[test]
    fn validate_allows_localhost_hostname() {
        // The `localhost` hostname is special-cased via host_is_localhost in
        // validate_llm_base_url — must be allowed under the LLM policy.
        assert!(validate_llm_base_url("http://localhost:11434").is_ok());
    }

    #[test]
    fn validate_allows_loopback_ipv4() {
        // On-premise arm (AllowLoopback).
        assert!(validate_llm_base_url("http://127.0.0.1:11434").is_ok());
    }

    #[test]
    fn validate_allows_rfc1918() {
        // On-premise arm (RFC 1918).
        assert!(validate_llm_base_url("http://192.168.1.1").is_ok());
    }

    #[test]
    fn validate_blocks_link_local_metadata() {
        // Delegation arm → url_validation rejects.
        let err = validate_llm_base_url("http://169.254.169.254").unwrap_err();
        assert!(
            err.to_lowercase().contains("private") || err.to_lowercase().contains("reserved"),
            "expected metadata IP rejection; got: {err}"
        );
    }

    #[test]
    fn validate_allows_public_ipv4() {
        // Delegation arm → url_validation accepts public IPs.
        assert!(validate_llm_base_url("http://8.8.8.8").is_ok());
    }

    #[test]
    fn validate_allows_public_domain() {
        // Delegation arm — unknown DNS name is treated as public (align with Redmine).
        assert!(validate_llm_base_url("http://my-ollama.lan").is_ok());
    }

    #[test]
    fn validate_allows_loopback_ipv6() {
        assert!(validate_llm_base_url("http://[::1]").is_ok());
    }

    #[test]
    fn validate_allows_ula_ipv6() {
        assert!(validate_llm_base_url("http://[fc00::1]").is_ok());
    }

    #[test]
    fn validate_blocks_link_local_ipv6() {
        assert!(validate_llm_base_url("http://[fe80::1]").is_err());
    }

    #[test]
    fn validate_blocks_mapped_link_local() {
        assert!(validate_llm_base_url("http://[::ffff:169.254.169.254]").is_err());
    }

    #[test]
    fn validate_allows_mapped_loopback() {
        // Delta vs Redmine — under AllowLoopback, IPv6-mapped loopback is OK.
        assert!(validate_llm_base_url("http://[::ffff:127.0.0.1]").is_ok());
    }

    // Schema / format rejections

    #[test]
    fn validate_blocks_file_scheme() {
        assert!(validate_llm_base_url("file:///etc/passwd").is_err());
    }

    #[test]
    fn validate_blocks_javascript_scheme() {
        assert!(validate_llm_base_url("javascript:alert(1)").is_err());
    }

    #[test]
    fn validate_blocks_ssh_scheme() {
        assert!(validate_llm_base_url("ssh://user@host").is_err());
    }

    #[test]
    fn validate_blocks_ftp_scheme() {
        assert!(validate_llm_base_url("ftp://ollama.com").is_err());
    }

    #[test]
    fn validate_blocks_data_scheme() {
        assert!(validate_llm_base_url("data:text/html,<script>").is_err());
    }

    #[test]
    fn validate_blocks_backslash() {
        assert!(validate_llm_base_url("http://localhost\\admin").is_err());
    }

    #[test]
    fn validate_blocks_credentials() {
        assert!(validate_llm_base_url("http://user:pass@localhost:11434").is_err());
    }

    #[test]
    fn validate_blocks_credentials_on_private() {
        assert!(validate_llm_base_url("http://admin:secret@192.168.1.1").is_err());
    }

    #[test]
    fn validate_blocks_empty() {
        assert!(validate_llm_base_url("").is_err());
    }

    #[test]
    fn validate_blocks_no_scheme() {
        assert!(validate_llm_base_url("example.com").is_err());
    }

    #[test]
    fn validate_blocks_scheme_only() {
        assert!(validate_llm_base_url("https:").is_err());
    }

    #[test]
    fn validate_blocks_with_query() {
        assert!(validate_llm_base_url("http://localhost:11434?foo=bar").is_err());
    }

    #[test]
    fn validate_blocks_with_fragment() {
        assert!(validate_llm_base_url("http://localhost:11434#frag").is_err());
    }

    // ── Log capture tests ───────────────────────────────────────────────
    //
    // Uses a process-global TestLogger behind `serial_test::serial` to avoid
    // interference from tauri-plugin-log or parallel tests.

    struct TestLogger {
        records: Mutex<Vec<(log::Level, String)>>,
    }

    impl TestLogger {
        fn new() -> Self {
            Self {
                records: Mutex::new(Vec::new()),
            }
        }

        fn take(&self) -> Vec<(log::Level, String)> {
            let mut guard = self.records.lock().unwrap();
            std::mem::take(&mut *guard)
        }
    }

    impl log::Log for TestLogger {
        fn enabled(&self, _: &log::Metadata) -> bool {
            true
        }
        fn log(&self, record: &log::Record) {
            self.records
                .lock()
                .unwrap()
                .push((record.level(), record.args().to_string()));
        }
        fn flush(&self) {}
    }

    fn test_logger() -> &'static TestLogger {
        static LOGGER: OnceLock<TestLogger> = OnceLock::new();
        let logger = LOGGER.get_or_init(TestLogger::new);
        // Safe to call multiple times — only the first succeeds; subsequent
        // calls return Err which we ignore.
        let _ = log::set_logger(logger);
        log::set_max_level(log::LevelFilter::Trace);
        logger
    }

    fn warns_contain(records: &[(log::Level, String)], needle: &str) -> bool {
        records.iter().any(|(level, msg)| {
            *level == log::Level::Warn && msg.to_lowercase().contains(&needle.to_lowercase())
        })
    }

    #[test]
    #[serial_test::serial]
    fn logs_warn_on_cleartext_http_private_ip() {
        let logger = test_logger();
        let _ = logger.take();
        validate_llm_base_url("http://192.168.1.1").unwrap();
        let records = logger.take();
        assert!(
            warns_contain(&records, "cleartext"),
            "expected cleartext warning; got: {records:?}"
        );
        assert!(
            warns_contain(&records, "private"),
            "expected private-address warning; got: {records:?}"
        );
    }

    #[test]
    #[serial_test::serial]
    fn logs_warn_on_public_ip() {
        let logger = test_logger();
        let _ = logger.take();
        validate_llm_base_url("http://8.8.8.8").unwrap();
        let records = logger.take();
        assert!(
            warns_contain(&records, "public"),
            "expected public-address warning; got: {records:?}"
        );
    }

    #[test]
    #[serial_test::serial]
    fn logs_warn_on_loopback() {
        let logger = test_logger();
        let _ = logger.take();
        validate_llm_base_url("http://127.0.0.1").unwrap();
        let records = logger.take();
        assert!(
            warns_contain(&records, "loopback"),
            "expected loopback warning; got: {records:?}"
        );
    }

    // ── Command-level (anthropic short-circuit, alias rewrite) ──────────

    #[tokio::test]
    async fn do_discover_rejects_anthropic() {
        let client = build_llm_probe_client().unwrap();
        let err = do_discover_llm_models(
            "anthropic",
            "http://127.0.0.1:11434",
            &client,
            Duration::from_secs(1),
        )
        .await
        .unwrap_err();
        assert_eq!(err, "unsupported");
    }

    #[tokio::test]
    async fn do_discover_rejects_file_scheme() {
        let client = build_llm_probe_client().unwrap();
        assert!(do_discover_llm_models(
            "ollama",
            "file:///etc/passwd",
            &client,
            Duration::from_secs(1),
        )
        .await
        .is_err());
    }

    #[tokio::test]
    async fn do_discover_rejects_metadata_ip() {
        let client = build_llm_probe_client().unwrap();
        // We never issue the request — validate_llm_base_url rejects first.
        assert!(do_discover_llm_models(
            "ollama",
            "http://169.254.169.254",
            &client,
            Duration::from_secs(1),
        )
        .await
        .is_err());
    }

    #[tokio::test]
    async fn do_discover_rewrites_docker_internal_via_mockito() {
        // Start a local mockito server on a dynamic 127.0.0.1 port, then call
        // do_discover with base_url = host.docker.internal:{port}. The rewrite
        // helper must substitute 127.0.0.1 so the request actually lands on
        // our mock (rather than failing DNS resolution for host.docker.internal
        // on the host).
        let mut server = mockito::Server::new_async().await;
        let port = server.host_with_port();
        let port = port.split(':').nth(1).unwrap();
        let mock = server
            .mock("GET", "/api/tags")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"models":[{"name":"test-model"}]}"#)
            .create_async()
            .await;

        let client = build_llm_probe_client().unwrap();
        let base_url = format!("http://host.docker.internal:{}", port);
        let models = do_discover_llm_models("ollama", &base_url, &client, Duration::from_secs(2))
            .await
            .unwrap();
        assert_eq!(models, vec!["test-model"]);
        mock.assert_async().await;
    }

    // ── Integration tests via mockito ───────────────────────────────────

    #[tokio::test]
    async fn integration_ollama_happy_path() {
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("GET", "/api/tags")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"models":[{"name":"llama3.3"},{"name":"qwen2.5"}]}"#)
            .create_async()
            .await;
        let client = build_llm_probe_client().unwrap();
        let models =
            do_discover_llm_models("ollama", &server.url(), &client, Duration::from_secs(2))
                .await
                .unwrap();
        assert_eq!(models, vec!["llama3.3", "qwen2.5"]);
        mock.assert_async().await;
    }

    #[tokio::test]
    async fn integration_lmstudio_happy_path() {
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("GET", "/v1/models")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"data":[{"id":"gpt-oss"},{"id":"qwen"}]}"#)
            .create_async()
            .await;
        let client = build_llm_probe_client().unwrap();
        let models =
            do_discover_llm_models("lmstudio", &server.url(), &client, Duration::from_secs(2))
                .await
                .unwrap();
        assert_eq!(models, vec!["gpt-oss", "qwen"]);
        mock.assert_async().await;
    }

    #[tokio::test]
    async fn integration_llamacpp_happy_path() {
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("GET", "/v1/models")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"data":[{"id":"bielik"}]}"#)
            .create_async()
            .await;
        let client = build_llm_probe_client().unwrap();
        let models =
            do_discover_llm_models("llamacpp", &server.url(), &client, Duration::from_secs(2))
                .await
                .unwrap();
        assert_eq!(models, vec!["bielik"]);
        mock.assert_async().await;
    }

    #[tokio::test]
    async fn discover_rejects_custom_provider_after_removal() {
        // Regression guard: `custom` was removed as a first-class provider. Any
        // lingering config that still passes it through the Tauri command must
        // now land on the generic unknown-provider path (`Err("unsupported")`),
        // not a bespoke `custom` branch that routes to `/v1/models`. The client
        // is unused because the rejection happens before any HTTP call.
        let client = build_llm_probe_client().unwrap();
        let err = do_discover_llm_models(
            "custom",
            "http://127.0.0.1:1234",
            &client,
            Duration::from_secs(1),
        )
        .await
        .unwrap_err();
        assert_eq!(err, "unsupported");
    }

    #[tokio::test]
    async fn integration_returns_err_on_500() {
        let mut server = mockito::Server::new_async().await;
        server
            .mock("GET", "/v1/models")
            .with_status(500)
            .create_async()
            .await;
        let client = build_llm_probe_client().unwrap();
        assert!(
            do_discover_llm_models("lmstudio", &server.url(), &client, Duration::from_secs(2),)
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn integration_returns_err_on_401() {
        let mut server = mockito::Server::new_async().await;
        server
            .mock("GET", "/v1/models")
            .with_status(401)
            .create_async()
            .await;
        let client = build_llm_probe_client().unwrap();
        assert!(
            do_discover_llm_models("lmstudio", &server.url(), &client, Duration::from_secs(2),)
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn integration_returns_err_on_429() {
        let mut server = mockito::Server::new_async().await;
        server
            .mock("GET", "/v1/models")
            .with_status(429)
            .create_async()
            .await;
        let client = build_llm_probe_client().unwrap();
        assert!(
            do_discover_llm_models("lmstudio", &server.url(), &client, Duration::from_secs(2),)
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn integration_returns_err_on_html_content_type() {
        let mut server = mockito::Server::new_async().await;
        server
            .mock("GET", "/v1/models")
            .with_status(200)
            // Mixed-case + charset param — check is case-insensitive + prefix.
            .with_header("content-type", "TEXT/HTML; charset=UTF-8")
            .with_body("<!doctype html><html>...</html>")
            .create_async()
            .await;
        let client = build_llm_probe_client().unwrap();
        let err =
            do_discover_llm_models("lmstudio", &server.url(), &client, Duration::from_secs(2))
                .await
                .unwrap_err();
        assert!(err.to_lowercase().contains("html"));
    }

    #[tokio::test]
    async fn integration_accepts_mixed_case_json_content_type() {
        // Regression guard: the content-type sanity check must NOT reject
        // `application/json; charset=utf-8` with unusual casing.
        let mut server = mockito::Server::new_async().await;
        server
            .mock("GET", "/v1/models")
            .with_status(200)
            .with_header("content-type", "Application/JSON; charset=UTF-8")
            .with_body(r#"{"data":[{"id":"x"}]}"#)
            .create_async()
            .await;
        let client = build_llm_probe_client().unwrap();
        let models =
            do_discover_llm_models("lmstudio", &server.url(), &client, Duration::from_secs(2))
                .await
                .unwrap();
        assert_eq!(models, vec!["x"]);
    }

    #[tokio::test]
    async fn integration_returns_err_on_empty_list() {
        let mut server = mockito::Server::new_async().await;
        server
            .mock("GET", "/v1/models")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"data":[]}"#)
            .create_async()
            .await;
        let client = build_llm_probe_client().unwrap();
        let err =
            do_discover_llm_models("lmstudio", &server.url(), &client, Duration::from_secs(2))
                .await
                .unwrap_err();
        assert_eq!(err, "empty");
    }

    #[tokio::test]
    async fn integration_returns_err_on_oversized_body() {
        let oversized = vec![b'x'; MAX_RESPONSE_BODY_BYTES + 1];
        let mut server = mockito::Server::new_async().await;
        server
            .mock("GET", "/v1/models")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(oversized)
            .create_async()
            .await;
        let client = build_llm_probe_client().unwrap();
        let err =
            do_discover_llm_models("lmstudio", &server.url(), &client, Duration::from_secs(2))
                .await
                .unwrap_err();
        assert!(err.to_lowercase().contains("too large"));
    }

    #[tokio::test]
    async fn integration_returns_err_on_timeout() {
        let mut server = mockito::Server::new_async().await;
        server
            .mock("GET", "/v1/models")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_chunked_body(|w| {
                // Sleep longer than the test's 100ms timeout before writing.
                std::thread::sleep(Duration::from_secs(2));
                w.write_all(b"{}")?;
                Ok(())
            })
            .create_async()
            .await;
        let client = build_llm_probe_client().unwrap();
        assert!(do_discover_llm_models(
            "lmstudio",
            &server.url(),
            &client,
            Duration::from_millis(100),
        )
        .await
        .is_err());
    }

    #[tokio::test]
    async fn integration_redirect_not_followed() {
        // First server returns 302 → second server. Second server must never
        // be hit because Policy::none() blocks redirect following.
        let mut target = mockito::Server::new_async().await;
        let never_hit = target
            .mock("GET", "/v1/models")
            .with_status(200)
            .expect(0)
            .create_async()
            .await;

        let mut redirect = mockito::Server::new_async().await;
        let initial = redirect
            .mock("GET", "/v1/models")
            .with_status(302)
            .with_header("location", &format!("{}/v1/models", target.url()))
            .create_async()
            .await;

        let client = build_llm_probe_client().unwrap();
        assert!(do_discover_llm_models(
            "lmstudio",
            &redirect.url(),
            &client,
            Duration::from_secs(2),
        )
        .await
        .is_err());

        initial.assert_async().await;
        never_hit.assert_async().await; // expect(0) — confirms redirect NOT followed
    }

    #[tokio::test]
    async fn integration_redirect_to_metadata_ip_not_followed() {
        // 302 → http://169.254.169.254/latest/meta-data/. If we were following
        // redirects, this would turn into a real (slow / refused) network
        // fetch. Assertion (b): wrap the whole operation in a 500ms timeout —
        // if we blew through it, something fetched the metadata URL.
        let mut server = mockito::Server::new_async().await;
        server
            .mock("GET", "/v1/models")
            .with_status(302)
            .with_header("location", "http://169.254.169.254/latest/meta-data/")
            .create_async()
            .await;

        let client = build_llm_probe_client().unwrap();
        let result = tokio::time::timeout(
            Duration::from_millis(500),
            do_discover_llm_models("lmstudio", &server.url(), &client, Duration::from_secs(2)),
        )
        .await
        .expect("operation must complete within 500ms — otherwise redirect was followed");

        assert!(result.is_err());
    }
}
