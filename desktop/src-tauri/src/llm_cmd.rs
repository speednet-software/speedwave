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

use futures_util::stream::{self, StreamExt};
use serde::{Deserialize, Serialize};
use std::time::Duration;

use crate::http_util::read_body_limited;
#[cfg(test)]
use crate::http_util::MAX_RESPONSE_BODY_BYTES;
use crate::url_validation::{is_private_on_premise, validate_url, PrivatePolicy};

/// Production timeout for the HTTP probe. Localhost / LAN should respond well
/// under this; a model mid-load that hasn't come up yet will time out and
/// the UI falls back to the free-text input.
const DISCOVERY_TIMEOUT_SECS: u64 = 5;

// ---------------------------------------------------------------------------
// Public DTO surfaced through Tauri to the frontend
// ---------------------------------------------------------------------------

/// One discovered model from a local LLM server.
///
/// `context_tokens` is `None` when the provider's listing endpoint did not
/// expose the model's context window — the frontend then leaves the chat
/// footer's `used / max` ratio derived from the stream-level
/// `context_window_size` (when available) or falls back to the global
/// default. We deliberately do not invent a value: silent guesses
/// undermine the SSOT goal.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DiscoveredModel {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_tokens: Option<u32>,
}

/// Compatibility status of the Anthropic Messages chat endpoint (`/v1/messages`).
///
/// A plain `bool` cannot represent "endpoint exists but rejects Claude Code's
/// request shape". This enum makes the four states mutually exclusive and
/// total, preventing illegal combinations.
///
/// The wire value (`serde(rename_all = "snake_case")`) is mirrored in the
/// TypeScript frontend — see `desktop/src/src/app/models/llm.ts::MessagesEndpointStatus`.
/// Adding a variant requires a matching update there.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MessagesEndpointStatus {
    /// `POST /v1/messages` exists and accepted the probe request shape.
    Ok,
    /// Endpoint absent — server returned 404 or 405.
    Missing,
    /// Endpoint exists but rejects the system turn Claude Code sends inside
    /// `messages[]` as `{role:"system"}` (strict Anthropic schema enforcement,
    /// e.g. unsloth llama-server). Claude Code sends the system turn in
    /// `messages[]`, so chat will fail even though the endpoint "exists".
    /// Speedwave cannot reshape the request (no proxy — ADR-040).
    StrictSystemRole,
    /// Could not determine: 5xx, transport error, or timeout during probe.
    Unknown,
}

/// Result of a `provider="local"` discovery probe. Pairs the model list with
/// a chat-endpoint compatibility status so the UI can warn before the user
/// starts a session. `None` for the status means "not probed at all"
/// (anthropic provider or field omitted from the response).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscoverResult {
    pub models: Vec<DiscoveredModel>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub messages_endpoint_status: Option<MessagesEndpointStatus>,
}

// ---------------------------------------------------------------------------
// Pure parsers (tested in isolation, no HTTP)
// ---------------------------------------------------------------------------

/// Parses the JSON returned by `POST /api/show` and locates the model's
/// context window. The key is dynamic: `model_info["<arch>.context_length"]`
/// where `<arch>` is the value of `model_info["general.architecture"]`
/// (`"llama"`, `"qwen2"`, `"mistral"`…). When the architecture key is
/// absent we still scan for any key ending in `.context_length` so we
/// degrade gracefully against future Ollama schema tweaks. Returns `None`
/// when no context length is found — caller persists `context_tokens: None`
/// and the chat fallback chain takes over.
fn parse_ollama_show(body: &[u8]) -> Option<u32> {
    let v: serde_json::Value = serde_json::from_slice(body).ok()?;
    let model_info = v.get("model_info")?.as_object()?;
    let arch = model_info
        .get("general.architecture")
        .and_then(|x| x.as_str());
    if let Some(arch) = arch {
        let key = format!("{arch}.context_length");
        if let Some(n) = model_info.get(&key).and_then(|x| x.as_u64()) {
            return non_zero_u32(n);
        }
    }
    // Fallback: any `<something>.context_length` key.
    for (k, val) in model_info {
        if k.ends_with(".context_length") {
            if let Some(n) = val.as_u64() {
                return non_zero_u32(n);
            }
        }
    }
    None
}

/// Convert a server-reported context-length to `u32`, treating both overflow
/// and a literal `0` as "unknown". A zero would otherwise propagate through
/// to `update_llm_config` and surface as a misleading "context_tokens must
/// be greater than 0" error at save time.
fn non_zero_u32(n: u64) -> Option<u32> {
    u32::try_from(n).ok().filter(|&v| v > 0)
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
            // Host is guaranteed present here: host_is_localhost requires
            // Some(Domain("localhost")); is_private_on_premise returns true
            // only for Some(Ipv4) or Some(Ipv6). The `<bug:no-host>` token
            // is a deliberate giveaway in the warning log: if it ever
            // appears, the upstream guard regressed and host classification
            // was bypassed — making it impossible to confuse with a real
            // hostname.
            let host = candidate.host_str().unwrap_or("<bug:no-host>");
            if host_is_localhost || is_loopback_host(&candidate) {
                log::warn!("Allowing loopback address for local LLM: {}", host);
            } else {
                log::warn!("Allowing private address for local LLM: {}", host);
            }
            candidate
        } else {
            let v = validate_url(url)?;
            // Same invariant as above: `validate_url` rejects schemes / IP
            // classes that lack a host, so `Ok` guarantees `Some` here.
            let host = v.host_str().unwrap_or("<bug:no-host>");
            log::warn!("Allowing public address for local LLM: {}", host);
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

/// Builds an HTTP client without auth. Test-only convenience; production
/// always goes through `build_llm_probe_client_with_auth`.
#[cfg(test)]
fn build_llm_probe_client() -> Result<reqwest::Client, String> {
    build_llm_probe_client_with_auth(None, None)
}

/// Builds an HTTP client with optional `Authorization: Bearer <token>` and
/// optional custom headers (`Name: Value` per line). Custom headers are
/// applied as **default headers** (sent on every request from the client).
/// `Authorization` in `custom_headers` is rejected defensively — it would
/// collide with the Bearer token added separately.
fn build_llm_probe_client_with_auth(
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
                // Defense-in-depth: validation should have rejected on save,
                // but we double-check here so a stale config can't smuggle
                // Authorization back in via the headers blob.
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
// Probe transport — abstracts "HTTP from host" vs "HTTP from VM" so the
// discovery probe can reach corporate-VPN-protected servers that the host
// cannot route to but the VM (via Apple VZ NAT / WSL2 mirrored) can.
// ---------------------------------------------------------------------------

/// Minimal HTTP transport for the discovery probe. Returned `body` is capped
/// at [`MAX_RESPONSE_BODY_BYTES`]; callers parse it as JSON. Auth headers
/// (`Authorization: Bearer …`, custom headers) are pre-configured on the
/// implementation; calls supply only URL + optional JSON body.
#[async_trait::async_trait]
pub(crate) trait ProbeTransport: Send + Sync {
    /// `GET url` with `Accept: application/json`. Returns `(status, body)`.
    /// Errors: transport-layer failures (DNS, connection, timeout, redirect).
    async fn get(&self, url: &str) -> Result<ProbeResponse, String>;
    /// `POST url` with `Content-Type: application/json` and `body` as the
    /// request body. Same status/error semantics as `get`.
    async fn post(&self, url: &str, body: &serde_json::Value) -> Result<ProbeResponse, String>;
}

#[derive(Debug, Clone)]
pub(crate) struct ProbeResponse {
    pub status: u16,
    pub content_type: Option<String>,
    pub body: Vec<u8>,
}

impl ProbeResponse {
    pub fn is_success(&self) -> bool {
        (200..300).contains(&self.status)
    }
    pub fn is_redirect(&self) -> bool {
        (300..400).contains(&self.status)
    }
}

/// Host-side probe via `reqwest`. Cannot reach corporate-VPN endpoints that
/// only route through the VM's interface — see `VmProbe` for that path.
pub(crate) struct HostProbe {
    client: reqwest::Client,
    timeout: Duration,
}

impl HostProbe {
    pub fn new(client: reqwest::Client, timeout: Duration) -> Self {
        Self { client, timeout }
    }
}

#[async_trait::async_trait]
impl ProbeTransport for HostProbe {
    async fn get(&self, url: &str) -> Result<ProbeResponse, String> {
        let resp = self
            .client
            .get(url)
            .header("Accept", "application/json")
            .timeout(self.timeout)
            .send()
            .await
            .map_err(|e| {
                log::warn!("LLM probe (host): GET {url} failed: {e}");
                format!("LLM model discovery: request failed: {e}")
            })?;
        let status = resp.status().as_u16();
        let content_type = resp
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string());
        let body = read_body_limited(resp, "LLM model discovery").await?;
        Ok(ProbeResponse {
            status,
            content_type,
            body,
        })
    }
    async fn post(&self, url: &str, body: &serde_json::Value) -> Result<ProbeResponse, String> {
        let resp = self
            .client
            .post(url)
            .header("Accept", "application/json")
            .json(body)
            .timeout(self.timeout)
            .send()
            .await
            .map_err(|e| {
                log::warn!("LLM probe (host): POST {url} failed: {e}");
                format!("LLM model discovery: request failed: {e}")
            })?;
        let status = resp.status().as_u16();
        let content_type = resp
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string());
        let response_body = read_body_limited(resp, "LLM model discovery").await?;
        Ok(ProbeResponse {
            status,
            content_type,
            body: response_body,
        })
    }
}

/// VM-side probe via `vm_exec` + `curl`. Used when the host cannot reach the
/// target URL but the VM can (Apple VZ NAT inherits macOS VPN routing;
/// WSL2 mirrored mode inherits Windows VPN routing). Falls back to
/// `HostProbe` automatically in `discover_llm_models` if the VM is not
/// available (fresh install).
pub(crate) struct VmProbe {
    bearer: Option<String>,
    custom_headers: Option<String>,
    timeout: Duration,
}

impl VmProbe {
    pub fn new(bearer: Option<String>, custom_headers: Option<String>, timeout: Duration) -> Self {
        Self {
            bearer,
            custom_headers,
            timeout,
        }
    }
}

#[async_trait::async_trait]
impl ProbeTransport for VmProbe {
    async fn get(&self, url: &str) -> Result<ProbeResponse, String> {
        run_vm_curl(
            "GET",
            url,
            None,
            self.bearer.as_deref(),
            self.custom_headers.as_deref(),
            self.timeout,
        )
        .await
    }
    async fn post(&self, url: &str, body: &serde_json::Value) -> Result<ProbeResponse, String> {
        run_vm_curl(
            "POST",
            url,
            Some(body.clone()),
            self.bearer.as_deref(),
            self.custom_headers.as_deref(),
            self.timeout,
        )
        .await
    }
}

/// Builds the curl argv (auth headers + write-out trailer) and runs it via
/// `vm_exec`, returning the parsed `ProbeResponse`. Sync because `vm_exec`
/// is blocking; called from async via `spawn_blocking`.
async fn run_vm_curl(
    method: &str,
    url: &str,
    json_body: Option<serde_json::Value>,
    bearer: Option<&str>,
    custom_headers: Option<&str>,
    timeout: Duration,
) -> Result<ProbeResponse, String> {
    let method = method.to_string();
    let url = url.to_string();
    let bearer = bearer.map(|s| s.to_string());
    let custom_headers = custom_headers.map(|s| s.to_string());
    tokio::task::spawn_blocking(move || {
        let runtime = speedwave_runtime::runtime::detect_runtime();
        run_vm_curl_blocking(
            &runtime,
            &method,
            &url,
            json_body.as_ref(),
            bearer.as_deref(),
            custom_headers.as_deref(),
            timeout,
        )
    })
    .await
    .map_err(|e| format!("VM probe task join failed: {e}"))?
}

fn run_vm_curl_blocking(
    runtime: &speedwave_runtime::runtime::LockedRuntime,
    method: &str,
    url: &str,
    json_body: Option<&serde_json::Value>,
    bearer: Option<&str>,
    custom_headers: Option<&str>,
    timeout: Duration,
) -> Result<ProbeResponse, String> {
    let timeout_s = timeout.as_secs().max(1).to_string();
    let bearer_hdr = bearer.map(|t| format!("Authorization: Bearer {t}"));
    let body_str = json_body.map(|j| j.to_string());

    let mut args: Vec<String> = vec![
        "--silent".into(),
        "--show-error".into(),
        "--max-time".into(),
        timeout_s,
        "-w".into(),
        "\nHTTP_STATUS:%{http_code}\nCONTENT_TYPE:%{content_type}\n".into(),
        "--max-redirs".into(),
        "0".into(),
        "-X".into(),
        method.to_string(),
        "-H".into(),
        "Accept: application/json".into(),
    ];
    if let Some(hdr) = bearer_hdr {
        args.push("-H".into());
        args.push(hdr);
    }
    if let Some(blob) = custom_headers {
        for line in blob.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            // Mirror the HostProbe / save-path guard: a stale custom_headers
            // file must not smuggle an `Authorization` header that collides
            // with the Bearer added separately.
            if line
                .split_once(':')
                .map(|(name, _)| name.trim().eq_ignore_ascii_case("authorization"))
                .unwrap_or(false)
            {
                log::warn!(
                    "LLM probe (vm): dropping Authorization from custom_headers (use api_key)"
                );
                continue;
            }
            args.push("-H".into());
            args.push(line.to_string());
        }
    }
    if let Some(body) = body_str.as_deref() {
        args.push("-H".into());
        args.push("Content-Type: application/json".into());
        args.push("-d".into());
        args.push(body.into());
    }
    args.push(url.into());
    let args_ref: Vec<&str> = args.iter().map(|s| s.as_str()).collect();

    // Headroom for curl spawn + connect on top of curl's own --max-time.
    let exec_timeout = timeout + Duration::from_secs(2);
    let out = runtime
        .vm_exec("curl", &args_ref, &[], exec_timeout)
        .map_err(|e| {
            log::warn!("LLM probe (vm): vm_exec curl failed: {e}");
            format!("VM probe failed: {e}")
        })?;

    let exit_success = out.status.success();
    let stderr_owned = String::from_utf8_lossy(&out.stderr).into_owned();
    let stdout = out.stdout;
    let trailer_start = stdout
        .windows(b"\nHTTP_STATUS:".len())
        .rposition(|w| w == b"\nHTTP_STATUS:");
    let (body, trailer) = match trailer_start {
        Some(idx) => (stdout[..idx].to_vec(), &stdout[idx + 1..]),
        None => {
            if !exit_success {
                return Err(format!(
                    "LLM model discovery: curl in VM failed: {stderr_owned}"
                ));
            }
            return Err("LLM model discovery: malformed curl output (no status trailer)".into());
        }
    };
    let trailer_str = String::from_utf8_lossy(trailer);
    let mut status: u16 = 0;
    let mut content_type: Option<String> = None;
    for line in trailer_str.lines() {
        if let Some(v) = line.strip_prefix("HTTP_STATUS:") {
            status = v.trim().parse().unwrap_or(0);
        } else if let Some(v) = line.strip_prefix("CONTENT_TYPE:") {
            let v = v.trim();
            if !v.is_empty() {
                content_type = Some(v.to_string());
            }
        }
    }
    if status == 0 {
        if !exit_success {
            return Err(format!(
                "LLM model discovery: curl in VM failed: {stderr_owned}"
            ));
        }
        return Err("LLM model discovery: curl returned no HTTP status".into());
    }
    Ok(ProbeResponse {
        status,
        content_type,
        body,
    })
}

// ---------------------------------------------------------------------------
// Core logic (parameterized timeout for testing)
// ---------------------------------------------------------------------------

/// Issues a GET against `<base>/<path>` with shared status / content-type /
/// body-size guards. Returns the validated body bytes ready for parsing.
/// Bounded fan-out for `/api/show` probes. Higher floods Ollama; lower
/// stretches wall-clock for users with large model libraries.
const MAX_OLLAMA_PROBE_CONCURRENCY: usize = 8;

/// Per-entry context detection for the `provider="local"` path.
///
/// Reads `/v1/models` and for each entry tries to extract a context window
/// from inline metadata in this order:
/// 1. `meta.n_ctx_train` (llama.cpp / Unsloth / vLLM)
/// 2. `max_context_length` (LM Studio 0.4.1+)
///
/// Entries that lack inline context fall back to Ollama's `POST /api/show`
/// path — one **sanity** call on the first missing entry decides whether to
/// fan out: 200 → fan out for the rest; 404/error → all remaining missing
/// stay `None`. This bounds the worst-case call count for unknown servers
/// (generic OpenAI gateway = 2 + 1 sanity = 3 calls, never N×404).
async fn discover_local(
    base: &url::Url,
    transport: &dyn ProbeTransport,
) -> Result<Vec<DiscoveredModel>, String> {
    let models_url = format!("{}/v1/models", base.as_str().trim_end_matches('/'));
    let resp = transport.get(&models_url).await?;
    enforce_json_response(&resp, &models_url)?;
    let entries: Vec<DiscoveredModel> = parse_openai_models_with_context(&resp.body)?;
    if entries.is_empty() {
        return Ok(Vec::new());
    }

    // If every entry already has context, we're done — no fallback calls.
    if entries.iter().all(|m| m.context_tokens.is_some()) {
        return Ok(entries);
    }

    // Try one Ollama `/api/show` sanity call on the first missing entry.
    let first_missing = entries
        .iter()
        .find(|m| m.context_tokens.is_none())
        .map(|m| m.id.clone());
    let Some(first_missing) = first_missing else {
        return Ok(entries);
    };

    let show_url = format!("{}/api/show", base.as_str().trim_end_matches('/'));
    let sanity = transport
        .post(&show_url, &serde_json::json!({ "model": first_missing }))
        .await
        .ok();
    let sanity_ok = sanity.as_ref().map(|r| r.is_success()).unwrap_or(false);
    if !sanity_ok {
        // Server does not implement `/api/show` — return the list as-is.
        return Ok(entries);
    }
    let first_ctx = sanity.as_ref().and_then(|r| parse_ollama_show(&r.body));

    // Fan out for the remaining missing entries (skip the one we just probed).
    let missing: Vec<(usize, String)> = entries
        .iter()
        .enumerate()
        .filter(|(_, m)| m.context_tokens.is_none() && m.id != first_missing)
        .map(|(idx, m)| (idx, m.id.clone()))
        .collect();
    let probe_futures = missing.into_iter().map(|(idx, name)| {
        let show_url = show_url.clone();
        async move {
            let body = serde_json::json!({ "model": name });
            let ctx = match transport.post(&show_url, &body).await {
                Ok(r) if r.is_success() => parse_ollama_show(&r.body),
                _ => None,
            };
            (idx, ctx)
        }
    });
    let probed: Vec<(usize, Option<u32>)> = stream::iter(probe_futures)
        .buffer_unordered(MAX_OLLAMA_PROBE_CONCURRENCY)
        .collect()
        .await;

    let mut out = entries;
    if let Some(idx) = out.iter().position(|m| m.id == first_missing) {
        out[idx].context_tokens = first_ctx;
    }
    for (idx, ctx) in probed {
        if let Some(slot) = out.get_mut(idx) {
            slot.context_tokens = ctx;
        }
    }
    Ok(out)
}

/// Shared status/content-type guard for `GET /v1/models` over either probe
/// transport. Status outside 2xx → Err; HTML content-type → Err.
fn enforce_json_response(resp: &ProbeResponse, url: &str) -> Result<(), String> {
    if !resp.is_success() {
        if resp.is_redirect() {
            log::warn!(
                "LLM model discovery: refusing to follow {} redirect from {}",
                resp.status,
                url
            );
        } else {
            log::warn!("LLM model discovery: {} returned HTTP {}", url, resp.status);
        }
        return Err(format!("LLM server returned HTTP {}", resp.status));
    }
    if let Some(ct) = resp.content_type.as_deref() {
        if ct.to_ascii_lowercase().starts_with("text/html") {
            log::warn!(
                "LLM model discovery: {} returned HTML content-type, refusing",
                url
            );
            return Err("LLM server returned an HTML response".to_string());
        }
    }
    Ok(())
}

/// Parses an OpenAI-shape `/v1/models` response, extracting `id` plus an
/// inline context window from either `meta.n_ctx_train` (llama.cpp shape) or
/// `max_context_length` (LM Studio shape) on a per-entry basis. Servers that
/// expose neither return `context_tokens: None` for every entry.
fn parse_openai_models_with_context(body: &[u8]) -> Result<Vec<DiscoveredModel>, String> {
    let v: serde_json::Value = serde_json::from_slice(body)
        .map_err(|e| format!("failed to parse /v1/models response: {e}"))?;
    let data = v
        .get("data")
        .and_then(|d| d.as_array())
        .ok_or_else(|| "/v1/models response missing `data` array".to_string())?;
    let mut out = Vec::with_capacity(data.len());
    for entry in data {
        let id = entry
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if id.is_empty() {
            continue;
        }
        let ctx = entry
            .get("meta")
            .and_then(|m| m.get("n_ctx_train"))
            .and_then(|n| n.as_u64())
            .and_then(non_zero_u32)
            .or_else(|| {
                entry
                    .get("max_context_length")
                    .and_then(|n| n.as_u64())
                    .and_then(non_zero_u32)
            });
        out.push(DiscoveredModel {
            id,
            context_tokens: ctx,
        });
    }
    Ok(out)
}

/// Strips a leading `Bearer ` (case-insensitive) and trims whitespace.
/// Returns `None` when the result is empty. Shared between save-time
/// validation (`containers_cmd::validate_api_key`) and the discovery
/// resolver so a user who pastes `Bearer sk-…` from a curl example sees
/// the same normalisation everywhere.
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

/// Tri-state credential resolver for discovery. Transient UI value wins over
/// stored on-disk; `Some(None)` / `Some(Some(""))` means "no auth" (ignore
/// stored). `active_project` is passed in so the caller can load it once
/// when both `api_key` and `custom_headers` need to be resolved.
fn resolve_transient_credential(
    field: Option<&Option<String>>,
    active_project: Option<&str>,
    file: &str,
) -> Option<String> {
    match field {
        None => active_project
            .and_then(|p| speedwave_runtime::compose::read_local_llm_token_opt(p, file)),
        Some(None) => None,
        Some(Some(s)) if s.is_empty() => None,
        Some(Some(s)) => strip_bearer_prefix(s),
    }
}

/// Returns `true` when `body` is a 4xx response that signals the server
/// rejected the `{role:"system"}` element inside `messages[]` — the strict
/// Anthropic-schema validation error emitted by llama-server / unsloth.
///
/// This distinguishes "system-role rejection" from other 4xx causes (e.g.
/// unknown model `"ping"`). If the JSON cannot be parsed or does not carry
/// the expected detail shape, we conservatively return `false` so the probe
/// is classified as `Ok` rather than `StrictSystemRole` — better to let a
/// session start and fail explicitly than to block it on a false positive.
///
/// Signature matched against the user-reported error:
/// `{"detail":[{"type":"literal_error","loc":["body","messages",1,"role"],
///   "msg":"Input should be 'user' or 'assistant'","input":"system"}]}`
///
/// Two independent checks — either is sufficient:
/// 1. A `detail[]` entry whose `"loc"` array ends with `"role"` and whose
///    `"input"` is `"system"`.
/// 2. Any string value in the body contains `"'user' or 'assistant'"`.
pub(crate) fn body_rejects_system_role(body: &[u8]) -> bool {
    let Ok(val) = serde_json::from_slice::<serde_json::Value>(body) else {
        return false;
    };

    // Check 2: fast string scan first (cheaper than deep traversal).
    let body_str = String::from_utf8_lossy(body);
    if body_str.contains("'user' or 'assistant'") {
        return true;
    }

    // Check 1: detail[].loc ends with "role" and input == "system".
    if let Some(details) = val.get("detail").and_then(|d| d.as_array()) {
        for entry in details {
            let input_is_system = entry
                .get("input")
                .and_then(|v| v.as_str())
                .map(|s| s == "system")
                .unwrap_or(false);
            let loc_ends_with_role = entry
                .get("loc")
                .and_then(|l| l.as_array())
                .and_then(|arr| arr.last())
                .and_then(|last| last.as_str())
                .map(|s| s == "role")
                .unwrap_or(false);
            if input_is_system && loc_ends_with_role {
                return true;
            }
        }
    }

    false
}

/// Probes `POST /v1/messages` with a 1-token request that **faithfully
/// replicates the request shape Claude Code sends** — a `{role:"system"}`
/// entry inside `messages[]`. This detects the exact 422 a strict
/// Anthropic-schema server returns before the user starts a session.
///
/// Status mapping:
/// - `404`/`405` → `Missing` (endpoint absent).
/// - `4xx` whose body matches the system-role rejection signature → `StrictSystemRole`.
/// - Other `2xx`–`4xx` (incl. "unknown model `ping`" errors) → `Ok`.
/// - `5xx` / transport error / timeout → `Unknown`.
///
/// See ADR-041 and the `MessagesEndpointStatus` doc for rationale.
async fn probe_messages_endpoint(
    base: &url::Url,
    transport: &dyn ProbeTransport,
) -> Option<MessagesEndpointStatus> {
    let url = format!("{}/v1/messages", base.as_str().trim_end_matches('/'));
    // Send the faithful Claude Code shape: system turn inside messages[].
    // This is the exact request that fails on strict-schema servers (llama-server,
    // unsloth) and is accepted by fully-compatible ones (Ollama, LM Studio,
    // recent llama.cpp with system-in-messages support).
    let body = serde_json::json!({
        "model": "ping",
        "max_tokens": 1,
        "messages": [
            { "role": "system", "content": "ping" },
            { "role": "user",   "content": "ping" }
        ],
    });
    match transport.post(&url, &body).await {
        Ok(r) => {
            let status = r.status;
            match status {
                404 | 405 => Some(MessagesEndpointStatus::Missing),
                // 4xx with a body that identifies the system-role rejection →
                // server exists but is incompatible with Claude Code's payload.
                s if (400..500).contains(&s) && body_rejects_system_role(&r.body) => {
                    Some(MessagesEndpointStatus::StrictSystemRole)
                }
                // Other 4xx (unknown model "ping", auth required, etc.) →
                // endpoint exists, the system-role shape was not the problem.
                s if (200..500).contains(&s) => Some(MessagesEndpointStatus::Ok),
                // 5xx or unexpected → could not determine.
                _ => Some(MessagesEndpointStatus::Unknown),
            }
        }
        // Transport error / timeout → could not determine.
        Err(_) => Some(MessagesEndpointStatus::Unknown),
    }
}

/// Discovers available models from a local LLM server.
///
/// `timeout` controls the reqwest-level request timeout for every
/// individual HTTP call (Ollama issues `1 + N` calls, others `1`).
/// Production uses `DISCOVERY_TIMEOUT_SECS` via the Tauri wrapper; tests
/// pass shorter durations to keep the suite fast.
///
/// Returns `Err("empty")` when the server responds OK but with no models (a
/// server up without any model loaded). The UI treats this the same as an
/// offline server and falls back to the free-text input.
pub(crate) async fn do_discover_llm_models(
    provider: &str,
    base_url: &str,
    transport: &dyn ProbeTransport,
) -> Result<DiscoverResult, String> {
    if provider == "anthropic" {
        return Err("unsupported".to_string());
    }

    let validated = normalize_and_validate_discovery_url(base_url)?;

    // All non-anthropic providers route through the unified `discover_local`
    // path (per-entry inline context detection + Anthropic Messages sanity
    // probe). Legacy provider names (`ollama`/`lmstudio`/`llamacpp`) are
    // accepted on read for two release cycles — the Settings UI auto-migrates
    // them to `local` on the next Save (ADR-040 §"Supported Providers").
    let (raw_models, messages_endpoint_status) = match provider {
        "local" | "ollama" | "lmstudio" | "llamacpp" => {
            let (models, status) = futures_util::future::join(
                discover_local(&validated, transport),
                probe_messages_endpoint(&validated, transport),
            )
            .await;
            (models?, status)
        }
        _ => return Err("unsupported".to_string()),
    };

    let models: Vec<DiscoveredModel> = raw_models
        .into_iter()
        .filter(|m| !m.id.is_empty())
        .collect();

    log::info!(
        "LLM model discovery: {} returned {} model(s) (messages_endpoint_status={:?})",
        provider,
        models.len(),
        messages_endpoint_status
    );

    if models.is_empty() {
        return Err("empty".to_string());
    }
    Ok(DiscoverResult {
        models,
        messages_endpoint_status,
    })
}

// ---------------------------------------------------------------------------
// Tauri command (thin wrapper)
// ---------------------------------------------------------------------------

/// Tri-state credential params for discovery.
///
/// `api_key == None` (field omitted) — use the stored token file (if any).
/// `api_key == Some(None)` or `Some(Some(""))` — probe **without** Bearer
/// even if a token exists on disk. `api_key == Some(Some(value))` — use the
/// transient value, ignore stored. Same semantics for `custom_headers`.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoverLlmModelsArgs {
    pub provider: String,
    pub base_url: String,
    #[serde(default, with = "serde_with::rust::double_option")]
    pub api_key: Option<Option<String>>,
    #[serde(default, with = "serde_with::rust::double_option")]
    pub custom_headers: Option<Option<String>>,
}

#[tauri::command]
pub async fn discover_llm_models(args: DiscoverLlmModelsArgs) -> Result<DiscoverResult, String> {
    log::info!(
        "discover_llm_models: provider={} base_url={} api_key_present={} custom_headers_present={}",
        args.provider,
        args.base_url,
        args.api_key.is_some(),
        args.custom_headers.is_some(),
    );
    let active = speedwave_runtime::config::load_user_config()
        .ok()
        .and_then(|c| c.active_project);
    let bearer = resolve_transient_credential(args.api_key.as_ref(), active.as_deref(), "api_key");
    let headers = resolve_transient_credential(
        args.custom_headers.as_ref(),
        active.as_deref(),
        "custom_headers",
    );
    let timeout = Duration::from_secs(DISCOVERY_TIMEOUT_SECS);
    // Try VM-routed probe first when a VM is available — that gives access to
    // VPN-only servers (Lima vzNAT + WSL2 mirrored inherit host routing).
    // Fall back to the host-side reqwest client when the VM is missing
    // (fresh install) or the VM probe fails. The fallback is silent: users
    // shouldn't have to choose a probe path.
    let runtime = speedwave_runtime::runtime::detect_runtime();
    let vm_available = runtime.is_available();
    let result = if vm_available {
        let vm_transport = VmProbe::new(bearer.clone(), headers.clone(), timeout);
        let vm_res = do_discover_llm_models(&args.provider, &args.base_url, &vm_transport).await;
        if vm_res.is_ok() {
            vm_res
        } else {
            log::info!("discover_llm_models: VM probe failed, retrying via host transport");
            let client = build_llm_probe_client_with_auth(bearer.as_deref(), headers.as_deref())?;
            let host_transport = HostProbe::new(client, timeout);
            do_discover_llm_models(&args.provider, &args.base_url, &host_transport).await
        }
    } else {
        let client = build_llm_probe_client_with_auth(bearer.as_deref(), headers.as_deref())?;
        let host_transport = HostProbe::new(client, timeout);
        do_discover_llm_models(&args.provider, &args.base_url, &host_transport).await
    };
    match &result {
        Ok(r) => log::info!(
            "discover_llm_models: ok — {} model(s), messages_endpoint_status={:?}",
            r.models.len(),
            r.messages_endpoint_status
        ),
        Err(e) => log::warn!("discover_llm_models: err — {e}"),
    }
    result
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use std::sync::{Mutex, OnceLock};

    /// Convenience extractor — discovery returns rich `DiscoveredModel`s but
    /// most happy-path assertions only care about the id list.
    fn model_ids(models: &[DiscoveredModel]) -> Vec<&str> {
        models.iter().map(|m| m.id.as_str()).collect()
    }

    /// Test shim: legacy `do_discover_llm_models(provider, url, client, timeout)`
    /// signature wrapping the host transport. Keeps the existing mockito tests
    /// terse without re-wiring every call site to construct a `HostProbe`.
    async fn do_discover_llm_models(
        provider: &str,
        base_url: &str,
        client: &reqwest::Client,
        timeout: Duration,
    ) -> Result<DiscoverResult, String> {
        let transport = HostProbe::new(client.clone(), timeout);
        super::do_discover_llm_models(provider, base_url, &transport).await
    }

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
    fn parse_ollama_show_resolves_arch_specific_context_length() {
        // Real /api/show response shape (truncated): `general.architecture`
        // selects which `<arch>.context_length` key carries the window.
        let body = br#"{
            "license": "...",
            "modelfile": "...",
            "model_info": {
                "general.architecture": "qwen2",
                "qwen2.context_length": 32768,
                "qwen2.attention.head_count": 28
            }
        }"#;
        assert_eq!(parse_ollama_show(body), Some(32768));
    }

    #[test]
    fn parse_ollama_show_falls_back_to_any_context_length_key() {
        // If the `general.architecture` key is missing we still grab any
        // `<X>.context_length` we can find. Future Ollama schema tweaks
        // shouldn't silently drop us back to 200k.
        let body = br#"{
            "model_info": {
                "llama.context_length": 8192
            }
        }"#;
        assert_eq!(parse_ollama_show(body), Some(8192));
    }

    #[test]
    fn parse_ollama_show_returns_none_without_context_length() {
        let body = br#"{
            "model_info": {
                "general.architecture": "llama",
                "llama.attention.head_count": 32
            }
        }"#;
        assert_eq!(parse_ollama_show(body), None);
    }

    #[test]
    fn parse_ollama_show_returns_none_on_malformed_json() {
        assert_eq!(parse_ollama_show(b"not json"), None);
    }

    // ── zero-context_tokens guard ───────────────────────────────────────
    //
    // A literal `0` from the server (or an overflow on `u32::try_from`)
    // would otherwise propagate to `update_llm_config`, which rejects it
    // with a misleading "context_tokens must be greater than 0" error
    // — confusing because it's an internal invariant, not a user mistake.
    // `non_zero_u32` flips zero to `None` so the chat fallback chain
    // takes over instead. The unified `parse_openai_models_with_context`
    // path is covered by separate tests; legacy LM Studio / llama.cpp
    // specific parsers have been removed alongside their helpers.

    #[test]
    fn parse_ollama_show_treats_zero_context_length_as_unknown() {
        // Arch-specific key path.
        let body = br#"{
            "model_info": {
                "general.architecture": "llama",
                "llama.context_length": 0
            }
        }"#;
        assert_eq!(parse_ollama_show(body), None);
    }

    #[test]
    fn parse_ollama_show_treats_zero_in_fallback_scan_as_unknown() {
        // Generic *.context_length scan path — same zero handling.
        let body = br#"{
            "model_info": {
                "qwen2.context_length": 0
            }
        }"#;
        assert_eq!(parse_ollama_show(body), None);
    }

    #[test]
    fn non_zero_u32_helper_filters_zero_and_overflow() {
        assert_eq!(super::non_zero_u32(0), None);
        assert_eq!(super::non_zero_u32(1), Some(1));
        assert_eq!(super::non_zero_u32(u32::MAX as u64), Some(u32::MAX));
        assert_eq!(super::non_zero_u32(u32::MAX as u64 + 1), None);
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
        // on the host). Uses `/v1/models` since legacy provider names route
        // through `discover_local`.
        let mut server = mockito::Server::new_async().await;
        let port = server.host_with_port();
        let port = port.split(':').nth(1).unwrap();
        let _models_mock = server
            .mock("GET", "/v1/models")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"data":[{"id":"test-model","meta":{"n_ctx_train":4096}}]}"#)
            .create_async()
            .await;
        let _messages_mock = server
            .mock("POST", "/v1/messages")
            .with_status(200)
            .with_body(r#"{}"#)
            .create_async()
            .await;

        let client = build_llm_probe_client().unwrap();
        let base_url = format!("http://host.docker.internal:{}", port);
        let result = do_discover_llm_models("ollama", &base_url, &client, Duration::from_secs(2))
            .await
            .unwrap();
        assert_eq!(model_ids(&result.models), vec!["test-model"]);
    }

    // ── Integration tests via mockito ───────────────────────────────────

    #[tokio::test]
    async fn integration_legacy_ollama_alias_routes_to_unified_path() {
        // Legacy `provider="ollama"` continues to work for 2 release cycles.
        // Backend routes it through `discover_local` (which hits `/v1/models`
        // since Ollama 0.14+), not the obsolete `/api/tags`.
        let mut server = mockito::Server::new_async().await;
        let _models_mock = server
            .mock("GET", "/v1/models")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"data":[{"id":"llama3.3"},{"id":"qwen2.5"}]}"#)
            .create_async()
            .await;
        // /api/show sanity probe returns 404 → both models stay context_tokens: None.
        let _show_mock = server
            .mock("POST", "/api/show")
            .with_status(404)
            .create_async()
            .await;
        let _messages_mock = server
            .mock("POST", "/v1/messages")
            .with_status(200)
            .with_body(r#"{}"#)
            .create_async()
            .await;
        let client = build_llm_probe_client().unwrap();
        let result =
            do_discover_llm_models("ollama", &server.url(), &client, Duration::from_secs(2))
                .await
                .unwrap();
        assert_eq!(model_ids(&result.models), vec!["llama3.3", "qwen2.5"]);
    }

    #[tokio::test]
    async fn integration_legacy_lmstudio_alias_routes_to_unified_path() {
        // Legacy `provider="lmstudio"` continues to work — context window is
        // extracted inline from `/v1/models` (LM Studio 0.4.1+ shape).
        let mut server = mockito::Server::new_async().await;
        let _models_mock = server
            .mock("GET", "/v1/models")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{"data":[
                    {"id":"gpt-oss","max_context_length":131072},
                    {"id":"qwen","max_context_length":32768}
                ]}"#,
            )
            .create_async()
            .await;
        let _messages_mock = server
            .mock("POST", "/v1/messages")
            .with_status(200)
            .with_body(r#"{}"#)
            .create_async()
            .await;
        let client = build_llm_probe_client().unwrap();
        let result =
            do_discover_llm_models("lmstudio", &server.url(), &client, Duration::from_secs(2))
                .await
                .unwrap();
        assert_eq!(model_ids(&result.models), vec!["gpt-oss", "qwen"]);
        assert_eq!(result.models[0].context_tokens, Some(131_072));
        assert_eq!(result.models[1].context_tokens, Some(32_768));
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
                .unwrap()
                .models;
        assert_eq!(model_ids(&models), vec!["bielik"]);
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

    // Generic HTTP-layer integration tests use llama.cpp because it shares the
    // OpenAI-compatible `/v1/models` endpoint exercised by mockito. They cover
    // status / content-type / size / timeout / redirect behaviour of
    // `fetch_json` and apply equally to LM Studio's `/api/v0/models` path.
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
            do_discover_llm_models("llamacpp", &server.url(), &client, Duration::from_secs(2),)
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
            do_discover_llm_models("llamacpp", &server.url(), &client, Duration::from_secs(2),)
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
            do_discover_llm_models("llamacpp", &server.url(), &client, Duration::from_secs(2),)
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
            do_discover_llm_models("llamacpp", &server.url(), &client, Duration::from_secs(2))
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
            do_discover_llm_models("llamacpp", &server.url(), &client, Duration::from_secs(2))
                .await
                .unwrap()
                .models;
        assert_eq!(model_ids(&models), vec!["x"]);
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
            do_discover_llm_models("llamacpp", &server.url(), &client, Duration::from_secs(2))
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
            do_discover_llm_models("llamacpp", &server.url(), &client, Duration::from_secs(2))
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
            "llamacpp",
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
            "llamacpp",
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
            do_discover_llm_models("llamacpp", &server.url(), &client, Duration::from_secs(2)),
        )
        .await
        .expect("operation must complete within 500ms — otherwise redirect was followed");

        assert!(result.is_err());
    }

    // ─────────────────────────────────────────────────────────────────────
    // discover_local (provider="local") — per-entry inline context detection
    // and `/v1/messages` sanity probe
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn parse_openai_models_with_context_extracts_llamacpp_shape() {
        let body = br#"{"data":[
            {"id":"llama-3","meta":{"n_ctx_train":131072}},
            {"id":"qwen","meta":{"n_ctx_train":32768}}
        ]}"#;
        let out = parse_openai_models_with_context(body).unwrap();
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].id, "llama-3");
        assert_eq!(out[0].context_tokens, Some(131_072));
        assert_eq!(out[1].context_tokens, Some(32_768));
    }

    #[test]
    fn parse_openai_models_with_context_extracts_lmstudio_shape() {
        let body = br#"{"data":[
            {"id":"qwen2.5","max_context_length":32768},
            {"id":"gpt-oss","max_context_length":131072}
        ]}"#;
        let out = parse_openai_models_with_context(body).unwrap();
        assert_eq!(out[0].context_tokens, Some(32_768));
        assert_eq!(out[1].context_tokens, Some(131_072));
    }

    #[test]
    fn parse_openai_models_with_context_handles_mixed_dialect() {
        // One entry from llama.cpp (meta), one from LM Studio (max_context_length).
        let body = br#"{"data":[
            {"id":"llama","meta":{"n_ctx_train":8192}},
            {"id":"qwen","max_context_length":32768}
        ]}"#;
        let out = parse_openai_models_with_context(body).unwrap();
        assert_eq!(out[0].context_tokens, Some(8192));
        assert_eq!(out[1].context_tokens, Some(32_768));
    }

    #[test]
    fn parse_openai_models_with_context_returns_none_when_absent() {
        // Generic OpenAI server — only `id` available.
        let body = br#"{"data":[{"id":"foo"},{"id":"bar"}]}"#;
        let out = parse_openai_models_with_context(body).unwrap();
        assert_eq!(out.len(), 2);
        assert!(out.iter().all(|m| m.context_tokens.is_none()));
    }

    #[test]
    fn parse_openai_models_with_context_drops_empty_ids() {
        let body = br#"{"data":[{"id":""},{"id":"ok"}]}"#;
        let out = parse_openai_models_with_context(body).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].id, "ok");
    }

    #[tokio::test]
    async fn integration_local_with_inline_meta_skips_fallback_calls() {
        // llama.cpp-shape inline context → exactly 2 calls total:
        // `/v1/models` and `/v1/messages` sanity. No `/api/show`.
        let mut server = mockito::Server::new_async().await;
        let models_mock = server
            .mock("GET", "/v1/models")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"data":[{"id":"llama3","meta":{"n_ctx_train":8192}}]}"#)
            .expect(1)
            .create_async()
            .await;
        let messages_mock = server
            .mock("POST", "/v1/messages")
            .with_status(200)
            .with_body(r#"{"id":"x","content":[]}"#)
            .expect(1)
            .create_async()
            .await;
        // `/api/show` must NOT be hit — assert it would error if called.
        let no_show_mock = server
            .mock("POST", "/api/show")
            .with_status(500)
            .expect(0)
            .create_async()
            .await;

        let client = build_llm_probe_client().unwrap();
        let result =
            do_discover_llm_models("local", &server.url(), &client, Duration::from_secs(2))
                .await
                .unwrap();
        assert_eq!(result.models.len(), 1);
        assert_eq!(result.models[0].context_tokens, Some(8192));
        assert_eq!(
            result.messages_endpoint_status,
            Some(MessagesEndpointStatus::Ok)
        );
        models_mock.assert_async().await;
        messages_mock.assert_async().await;
        no_show_mock.assert_async().await;
    }

    #[tokio::test]
    async fn integration_local_warns_when_messages_endpoint_missing() {
        // Server has `/v1/models` but returns 404 on `/v1/messages` — UI
        // should get `messages_endpoint_status: Some(Missing)` so it can warn.
        // Inline `meta.n_ctx_train` → no `/api/show` fallback fires.
        let mut server = mockito::Server::new_async().await;
        let models_mock = server
            .mock("GET", "/v1/models")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"data":[{"id":"foo","meta":{"n_ctx_train":4096}}]}"#)
            .expect(1)
            .create_async()
            .await;
        let messages_mock = server
            .mock("POST", "/v1/messages")
            .with_status(404)
            .expect(1)
            .create_async()
            .await;
        // No `/api/show` because inline meta supplies the context window.
        let no_show_mock = server
            .mock("POST", "/api/show")
            .with_status(500)
            .expect(0)
            .create_async()
            .await;

        let client = build_llm_probe_client().unwrap();
        let result =
            do_discover_llm_models("local", &server.url(), &client, Duration::from_secs(2))
                .await
                .unwrap();
        assert_eq!(
            result.messages_endpoint_status,
            Some(MessagesEndpointStatus::Missing)
        );
        models_mock.assert_async().await;
        messages_mock.assert_async().await;
        no_show_mock.assert_async().await;
    }

    #[tokio::test]
    async fn integration_local_falls_back_to_ollama_show_when_no_inline_meta() {
        // Generic `/v1/models` without inline meta + Ollama `/api/show` works.
        // Expected exact call counts: /v1/models = 1, /api/show = N (one
        // sanity + N-1 fan-out = 2 for 2 models), /v1/messages = 1.
        let mut server = mockito::Server::new_async().await;
        let models_mock = server
            .mock("GET", "/v1/models")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"data":[{"id":"a"},{"id":"b"}]}"#)
            .expect(1)
            .create_async()
            .await;
        let show_mock = server
            .mock("POST", "/api/show")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{"model_info":{"general.architecture":"llama","llama.context_length":8192}}"#,
            )
            .expect(2)
            .create_async()
            .await;
        let messages_mock = server
            .mock("POST", "/v1/messages")
            .with_status(200)
            .with_body(r#"{}"#)
            .expect(1)
            .create_async()
            .await;

        let client = build_llm_probe_client().unwrap();
        let result =
            do_discover_llm_models("local", &server.url(), &client, Duration::from_secs(2))
                .await
                .unwrap();
        assert_eq!(result.models.len(), 2);
        for m in &result.models {
            assert_eq!(m.context_tokens, Some(8192));
        }
        assert_eq!(
            result.messages_endpoint_status,
            Some(MessagesEndpointStatus::Ok)
        );
        models_mock.assert_async().await;
        show_mock.assert_async().await;
        messages_mock.assert_async().await;
    }

    #[tokio::test]
    async fn integration_local_generic_openai_gateway_stays_under_three_calls_for_context() {
        // Server has `/v1/models` but neither inline meta NOR /api/show.
        // Expected exact: 1 /v1/models + 1 sanity /api/show (404) + 1
        // /v1/messages = 3 calls. Critical: must NOT fire N×/api/show.
        let mut server = mockito::Server::new_async().await;
        let models_mock = server
            .mock("GET", "/v1/models")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"data":[{"id":"a"},{"id":"b"},{"id":"c"},{"id":"d"},{"id":"e"}]}"#)
            .expect(1)
            .create_async()
            .await;
        // Sanity call (first missing) — expect exactly 1, no fan-out.
        let show_mock = server
            .mock("POST", "/api/show")
            .with_status(404)
            .expect(1)
            .create_async()
            .await;
        let messages_mock = server
            .mock("POST", "/v1/messages")
            .with_status(200)
            .with_body(r#"{}"#)
            .expect(1)
            .create_async()
            .await;

        let client = build_llm_probe_client().unwrap();
        let result =
            do_discover_llm_models("local", &server.url(), &client, Duration::from_secs(2))
                .await
                .unwrap();
        assert_eq!(result.models.len(), 5);
        for m in &result.models {
            assert_eq!(m.context_tokens, None);
        }
        models_mock.assert_async().await;
        show_mock.assert_async().await;
        messages_mock.assert_async().await;
    }

    // ─────────────────────────────────────────────────────────────────────
    // build_llm_probe_client_with_auth — header construction
    // ─────────────────────────────────────────────────────────────────────

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

    // ─────────────────────────────────────────────────────────────────────
    // resolve_transient_credential — tri-state semantics
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn resolve_credential_some_some_strips_bearer_prefix() {
        let r = resolve_transient_credential(
            Some(&Some("Bearer sk-test".to_string())),
            None,
            "api_key",
        );
        assert_eq!(r, Some("sk-test".to_string()));
    }

    #[test]
    fn resolve_credential_some_none_means_no_auth() {
        let r = resolve_transient_credential(Some(&None), None, "api_key");
        assert_eq!(r, None, "Some(None) explicitly means no auth");
    }

    #[test]
    fn resolve_credential_some_empty_string_means_no_auth() {
        let r = resolve_transient_credential(Some(&Some(String::new())), None, "api_key");
        assert_eq!(r, None, "Some(Some(\"\")) means no auth");
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
        // `Bearer` alone (no trailing token) is NOT a prefix — trims to the
        // literal word; caller's validation logic decides what to do with it.
        assert_eq!(strip_bearer_prefix("Bearer"), Some("Bearer".to_string()));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // body_rejects_system_role — pure unit tests
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn body_rejects_system_role_detects_llama_server_422() {
        // Exact body from the user-reported error (unsloth llama-server).
        let body = br#"{"detail":[{"type":"literal_error","loc":["body","messages",1,"role"],"msg":"Input should be 'user' or 'assistant'","input":"system","ctx":{"expected":"'user' or 'assistant'"}}]}"#;
        assert!(
            body_rejects_system_role(body),
            "must detect llama-server's system-role 422 body"
        );
    }

    #[test]
    fn body_rejects_system_role_detects_user_or_assistant_in_msg() {
        // A server that uses the msg substring but a different loc structure.
        let body = br#"{"error":{"message":"Input should be 'user' or 'assistant'"}}"#;
        assert!(
            body_rejects_system_role(body),
            "must detect 'user' or 'assistant' substring"
        );
    }

    #[test]
    fn body_rejects_system_role_ignores_unknown_model_422() {
        // A 422 for an unknown model — must NOT be classified as StrictSystemRole.
        let body =
            br#"{"error":{"message":"model 'ping' not found","type":"invalid_request_error"}}"#;
        assert!(
            !body_rejects_system_role(body),
            "unknown-model 422 must not be classified as system-role rejection"
        );
    }

    #[test]
    fn body_rejects_system_role_ignores_unrelated_loc() {
        // detail[].loc ends with "model", not "role" — a different schema error.
        let body = br#"{"detail":[{"type":"literal_error","loc":["body","model"],"msg":"Invalid value","input":"ping","ctx":{}}]}"#;
        assert!(
            !body_rejects_system_role(body),
            "different loc field must not be classified as system-role rejection"
        );
    }

    #[test]
    fn body_rejects_system_role_handles_malformed_json() {
        assert!(
            !body_rejects_system_role(b"not json at all"),
            "malformed JSON must return false (conservative)"
        );
        assert!(
            !body_rejects_system_role(b""),
            "empty body must return false"
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // probe_messages_endpoint — integration with MessagesEndpointStatus
    // ─────────────────────────────────────────────────────────────────────────

    #[tokio::test]
    async fn integration_local_strict_system_role_server() {
        // Server lists models but rejects system-in-messages with the exact
        // llama-server 422 body — probe must return StrictSystemRole.
        let mut server = mockito::Server::new_async().await;
        let models_mock = server
            .mock("GET", "/v1/models")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"data":[{"id":"qwen3","meta":{"n_ctx_train":32768}}]}"#)
            .expect(1)
            .create_async()
            .await;
        let messages_mock = server
            .mock("POST", "/v1/messages")
            .with_status(422)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{"detail":[{"type":"literal_error","loc":["body","messages",1,"role"],"msg":"Input should be 'user' or 'assistant'","input":"system","ctx":{"expected":"'user' or 'assistant'"}}]}"#,
            )
            .expect(1)
            .create_async()
            .await;

        let client = build_llm_probe_client().unwrap();
        let result =
            do_discover_llm_models("local", &server.url(), &client, Duration::from_secs(2))
                .await
                .unwrap();
        assert_eq!(
            result.messages_endpoint_status,
            Some(MessagesEndpointStatus::StrictSystemRole),
            "llama-server strict-schema 422 must be detected as StrictSystemRole"
        );
        models_mock.assert_async().await;
        messages_mock.assert_async().await;
    }

    #[tokio::test]
    async fn integration_local_unknown_model_ping_is_ok() {
        // Server returns 422 for the unknown "ping" model, but the body
        // does NOT contain the system-role signature — must be Ok, not
        // StrictSystemRole, because a real model name would succeed.
        let mut server = mockito::Server::new_async().await;
        let models_mock = server
            .mock("GET", "/v1/models")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"data":[{"id":"llama3","meta":{"n_ctx_train":8192}}]}"#)
            .expect(1)
            .create_async()
            .await;
        let messages_mock = server
            .mock("POST", "/v1/messages")
            .with_status(422)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{"error":{"message":"model 'ping' not found","type":"invalid_request_error"}}"#,
            )
            .expect(1)
            .create_async()
            .await;

        let client = build_llm_probe_client().unwrap();
        let result =
            do_discover_llm_models("local", &server.url(), &client, Duration::from_secs(2))
                .await
                .unwrap();
        assert_eq!(
            result.messages_endpoint_status,
            Some(MessagesEndpointStatus::Ok),
            "unknown-model 422 must not be classified as StrictSystemRole"
        );
        models_mock.assert_async().await;
        messages_mock.assert_async().await;
    }

    #[tokio::test]
    async fn probe_returns_unknown_on_5xx() {
        // A 5xx on /v1/messages must yield Unknown — server is up for
        // models but the endpoint errored transiently.
        let mut server = mockito::Server::new_async().await;
        let models_mock = server
            .mock("GET", "/v1/models")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"data":[{"id":"foo","meta":{"n_ctx_train":4096}}]}"#)
            .expect(1)
            .create_async()
            .await;
        let messages_mock = server
            .mock("POST", "/v1/messages")
            .with_status(503)
            .expect(1)
            .create_async()
            .await;

        let client = build_llm_probe_client().unwrap();
        let result =
            do_discover_llm_models("local", &server.url(), &client, Duration::from_secs(2))
                .await
                .unwrap();
        assert_eq!(
            result.messages_endpoint_status,
            Some(MessagesEndpointStatus::Unknown),
            "5xx on /v1/messages must yield Unknown"
        );
        models_mock.assert_async().await;
        messages_mock.assert_async().await;
    }
}
