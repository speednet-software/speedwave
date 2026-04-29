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

use crate::http_util::{read_body_limited, MAX_RESPONSE_BODY_BYTES};
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

// ---------------------------------------------------------------------------
// Wire-format response DTOs (per provider)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct OllamaTagsResponse {
    /// Ollama returns the list under `models`. Additional fields (`model`,
    /// `modified_at`, `size`, `digest`, `details`) are ignored — no
    /// `deny_unknown_fields` so a future Ollama schema extension won't break us.
    models: Vec<OllamaTagEntry>,
}

#[derive(Debug, Deserialize)]
struct OllamaTagEntry {
    name: String,
}

/// LM Studio's extended listing endpoint (`GET /api/v0/models`) advertises
/// `max_context_length` per entry. The response shape is mostly
/// OpenAI-compatible (`{object, data: [...]}`) but every entry carries
/// extra fields — we extract just the ones we need.
#[derive(Debug, Deserialize)]
struct LmStudioModelsResponse {
    data: Vec<LmStudioModelEntry>,
}

#[derive(Debug, Deserialize)]
struct LmStudioModelEntry {
    id: String,
    #[serde(default)]
    max_context_length: Option<u64>,
}

/// llama.cpp's `/v1/models` endpoint surfaces `meta.n_ctx_train` — the
/// model's training-time context window, which is also the maximum the
/// engine will accept at generation time. The runtime `--ctx-size` flag may
/// constrain it lower (visible via `/props`); we report `n_ctx_train` here
/// because it's the value Claude Code negotiates against, and a separate
/// `/props` round-trip would just race the user changing the slot config.
#[derive(Debug, Deserialize)]
struct LlamaCppModelsResponse {
    data: Vec<LlamaCppModelEntry>,
}

#[derive(Debug, Deserialize)]
struct LlamaCppModelEntry {
    id: String,
    #[serde(default)]
    meta: Option<LlamaCppMeta>,
}

#[derive(Debug, Deserialize)]
struct LlamaCppMeta {
    #[serde(default)]
    n_ctx_train: Option<u64>,
}

// ---------------------------------------------------------------------------
// Pure parsers (tested in isolation, no HTTP)
// ---------------------------------------------------------------------------

fn parse_ollama_tags(body: &[u8]) -> anyhow::Result<Vec<String>> {
    let resp: OllamaTagsResponse = serde_json::from_slice(body)
        .map_err(|e| anyhow::anyhow!("failed to parse Ollama /api/tags response: {e}"))?;
    Ok(resp.models.into_iter().map(|m| m.name).collect())
}

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

fn parse_lmstudio(body: &[u8]) -> anyhow::Result<Vec<DiscoveredModel>> {
    let resp: LmStudioModelsResponse = serde_json::from_slice(body)
        .map_err(|e| anyhow::anyhow!("failed to parse LM Studio /api/v0/models response: {e}"))?;
    Ok(resp
        .data
        .into_iter()
        .map(|m| DiscoveredModel {
            id: m.id,
            context_tokens: m.max_context_length.and_then(non_zero_u32),
        })
        .collect())
}

fn parse_llamacpp(body: &[u8]) -> anyhow::Result<Vec<DiscoveredModel>> {
    let resp: LlamaCppModelsResponse = serde_json::from_slice(body)
        .map_err(|e| anyhow::anyhow!("failed to parse llama.cpp /v1/models response: {e}"))?;
    Ok(resp
        .data
        .into_iter()
        .map(|m| DiscoveredModel {
            id: m.id,
            context_tokens: m
                .meta
                .and_then(|meta| meta.n_ctx_train)
                .and_then(non_zero_u32),
        })
        .collect())
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

/// Builds an HTTP client for the LLM discovery probe. Redirects disabled to prevent SSRF.
fn build_llm_probe_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(format!("Speedwave-Desktop/{}", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))
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

/// Issues a GET against `<base>/<path>` with shared status / content-type /
/// body-size guards. Returns the validated body bytes ready for parsing.
async fn fetch_json(
    base: &url::Url,
    path: &str,
    client: &reqwest::Client,
    timeout: Duration,
) -> Result<Vec<u8>, String> {
    let url = format!("{}{}", base.as_str().trim_end_matches('/'), path);
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

    let body = read_body_limited(resp, "LLM model discovery").await?;
    debug_assert!(body.len() <= MAX_RESPONSE_BODY_BYTES);
    Ok(body)
}

/// Ollama path: list models via `/api/tags`, then resolve the per-model
/// context window with `POST /api/show` requests issued in parallel. Models
/// whose `/api/show` probe fails come back with `context_tokens: None` —
/// the listing still succeeds so the user can pick one.
async fn discover_ollama(
    base: &url::Url,
    client: &reqwest::Client,
    timeout: Duration,
) -> Result<Vec<DiscoveredModel>, String> {
    let body = fetch_json(base, "/api/tags", client, timeout).await?;
    let names = parse_ollama_tags(&body).map_err(|e| {
        log::debug!("LLM model discovery: Ollama parse failed: {e}");
        format!("Failed to parse Ollama response: {e}")
    })?;

    if names.is_empty() {
        return Ok(Vec::new());
    }

    // Issue /api/show in parallel for every model name. The endpoint takes a
    // POST body with `{model: "<name>"}` and returns `model_info` whose
    // `<arch>.context_length` key carries the context window. Probe failures
    // (timeout, server churn during model load) degrade silently.
    //
    // Bounded fan-out via `buffer_unordered`: a user with 50+ pulled models
    // would otherwise fire 50+ simultaneous POSTs, which can saturate
    // Ollama's per-model lock and time out the listing entirely. Eight
    // concurrent probes is a safe upper bound for local hardware while
    // keeping the total wall-clock cost bounded by the slowest probe in the
    // last batch rather than the slowest single model in the listing.
    let url = format!("{}/api/show", base.as_str().trim_end_matches('/'));
    // `buffer_unordered` reorders results, so each future carries its index
    // and we re-sort afterwards to keep the response order matching `names`.
    let probe_futures = names.iter().cloned().enumerate().map(|(idx, name)| {
        let client = client.clone();
        let url = url.clone();
        async move {
            let resp = client
                .post(&url)
                .header("Accept", "application/json")
                .json(&serde_json::json!({ "model": name }))
                .timeout(timeout)
                .send()
                .await
                .ok();
            let ctx = match resp {
                Some(r) if r.status().is_success() => {
                    match read_body_limited(r, "Ollama /api/show").await {
                        Ok(body) => parse_ollama_show(&body),
                        Err(_) => None,
                    }
                }
                _ => None,
            };
            (idx, ctx)
        }
    });
    let mut indexed: Vec<(usize, Option<u32>)> = stream::iter(probe_futures)
        .buffer_unordered(MAX_OLLAMA_PROBE_CONCURRENCY)
        .collect()
        .await;
    indexed.sort_by_key(|(idx, _)| *idx);

    Ok(names
        .into_iter()
        .zip(indexed.into_iter().map(|(_, ctx)| ctx))
        .map(|(id, ctx)| DiscoveredModel {
            id,
            context_tokens: ctx,
        })
        .collect())
}

/// Maximum number of `/api/show` probes Ollama discovery may have in flight
/// at once. Higher concurrency floods the server (single-threaded for many
/// model-loading operations); lower concurrency drags wall-clock latency
/// for users with large model libraries. Eight is a conservative middle
/// ground that matches typical CPU-core counts.
const MAX_OLLAMA_PROBE_CONCURRENCY: usize = 8;

/// LM Studio path: hits the extended `/api/v0/models` listing which carries
/// `max_context_length` per entry. The OpenAI-compatible `/v1/models`
/// fallback was removed — it returns ids only, so the dropdown gets the
/// same ids minus the context window data we actually want, in exchange
/// for a second round-trip and a duplicate parser. Modern LM Studio always
/// exposes `/api/v0/models`.
async fn discover_lmstudio(
    base: &url::Url,
    client: &reqwest::Client,
    timeout: Duration,
) -> Result<Vec<DiscoveredModel>, String> {
    let body = fetch_json(base, "/api/v0/models", client, timeout).await?;
    parse_lmstudio(&body).map_err(|e| {
        log::debug!("LLM model discovery: LM Studio /api/v0/models parse failed: {e}");
        format!("Failed to parse LM Studio response: {e}")
    })
}

/// llama.cpp path: a single `/v1/models` request returns ids plus
/// `meta.n_ctx_train` for every model — no second round-trip needed.
async fn discover_llamacpp(
    base: &url::Url,
    client: &reqwest::Client,
    timeout: Duration,
) -> Result<Vec<DiscoveredModel>, String> {
    let body = fetch_json(base, "/v1/models", client, timeout).await?;
    parse_llamacpp(&body).map_err(|e| {
        log::debug!("LLM model discovery: llama.cpp parse failed: {e}");
        format!("Failed to parse llama.cpp response: {e}")
    })
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
    client: &reqwest::Client,
    timeout: Duration,
) -> Result<Vec<DiscoveredModel>, String> {
    // 1. Short-circuit anthropic — there's no local model-list endpoint.
    if provider == "anthropic" {
        return Err("unsupported".to_string());
    }

    // 2. Normalise URL: strip /v1, rewrite container aliases, SSRF-validate.
    let validated = normalize_and_validate_discovery_url(base_url)?;

    // 3. Provider-specific discovery (each helper handles its own endpoints
    //    so we can fan out for Ollama and use the extended LM Studio listing
    //    where it gives us context windows for free).
    let raw_models = match provider {
        "ollama" => discover_ollama(&validated, client, timeout).await?,
        "lmstudio" => discover_lmstudio(&validated, client, timeout).await?,
        "llamacpp" => discover_llamacpp(&validated, client, timeout).await?,
        _ => return Err("unsupported".to_string()),
    };

    // Drop entries with an empty id: a server returning `"name": ""` would
    // otherwise show up in the dropdown as a blank `<option>` that the user
    // can't meaningfully select. The chat fallback chain already handles
    // empty lists gracefully.
    let models: Vec<DiscoveredModel> = raw_models
        .into_iter()
        .filter(|m| !m.id.is_empty())
        .collect();

    log::debug!(
        "LLM model discovery: {} returned {} model(s)",
        provider,
        models.len()
    );

    if models.is_empty() {
        return Err("empty".to_string());
    }
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
) -> Result<Vec<DiscoveredModel>, String> {
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

    /// Convenience extractor — discovery returns rich `DiscoveredModel`s but
    /// most happy-path assertions only care about the id list.
    fn model_ids(models: &[DiscoveredModel]) -> Vec<&str> {
        models.iter().map(|m| m.id.as_str()).collect()
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
    fn parse_ollama_tags_happy_path() {
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
        assert_eq!(
            parse_ollama_tags(body).unwrap(),
            vec!["llama3.3", "qwen2.5"]
        );
    }

    #[test]
    fn parse_ollama_tags_empty_list() {
        let body = br#"{ "models": [] }"#;
        assert!(parse_ollama_tags(body).unwrap().is_empty());
    }

    #[test]
    fn parse_ollama_tags_malformed_json() {
        assert!(parse_ollama_tags(b"not json at all").is_err());
    }

    #[test]
    fn parse_ollama_tags_wrong_outer_type() {
        assert!(parse_ollama_tags(b"[]").is_err());
    }

    #[test]
    fn parse_ollama_tags_wrong_field_type_for_name() {
        let body = br#"{ "models": [ { "name": 42 } ] }"#;
        assert!(parse_ollama_tags(body).is_err());
    }

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

    #[test]
    fn parse_lmstudio_extracts_max_context_length() {
        // /api/v0/models — context window is in the listing, no follow-up
        // request needed.
        let body = br#"{
            "object": "list",
            "data": [
                {
                    "id": "qwen2.5-coder",
                    "object": "model",
                    "type": "llm",
                    "max_context_length": 32768
                },
                { "id": "embed-only", "object": "model", "type": "embeddings" }
            ]
        }"#;
        let models = parse_lmstudio(body).unwrap();
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "qwen2.5-coder");
        assert_eq!(models[0].context_tokens, Some(32768));
        // `embed-only` lacks max_context_length — context_tokens=None.
        assert_eq!(models[1].id, "embed-only");
        assert_eq!(models[1].context_tokens, None);
    }

    #[test]
    fn parse_llamacpp_extracts_n_ctx_train() {
        // llama.cpp /v1/models exposes meta.n_ctx_train per entry.
        let body = br#"{
            "object": "list",
            "data": [
                {
                    "id": "../models/Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf",
                    "object": "model",
                    "meta": {
                        "n_ctx_train": 131072,
                        "n_vocab": 128256
                    }
                }
            ]
        }"#;
        let models = parse_llamacpp(body).unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].context_tokens, Some(131072));
    }

    #[test]
    fn parse_llamacpp_handles_missing_meta() {
        let body = br#"{ "data": [{ "id": "model-without-meta" }] }"#;
        let models = parse_llamacpp(body).unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].context_tokens, None);
    }

    // ── zero-context_tokens guard ───────────────────────────────────────
    //
    // A literal `0` from the server (or an overflow on `u32::try_from`)
    // would otherwise propagate to `update_llm_config`, which rejects it
    // with a misleading "context_tokens must be greater than 0" error
    // — confusing because it's an internal invariant, not a user mistake.
    // `non_zero_u32` flips zero to `None` so the chat fallback chain
    // takes over instead.

    #[test]
    fn parse_lmstudio_treats_zero_max_context_length_as_unknown() {
        let body = br#"{
            "data": [
                { "id": "broken-model", "max_context_length": 0 },
                { "id": "ok-model", "max_context_length": 32768 }
            ]
        }"#;
        let models = parse_lmstudio(body).unwrap();
        assert_eq!(models[0].context_tokens, None, "zero must become None");
        assert_eq!(models[1].context_tokens, Some(32_768));
    }

    #[test]
    fn parse_llamacpp_treats_zero_n_ctx_train_as_unknown() {
        let body = br#"{
            "data": [
                { "id": "broken", "meta": { "n_ctx_train": 0 } }
            ]
        }"#;
        let models = parse_llamacpp(body).unwrap();
        assert_eq!(models[0].context_tokens, None);
    }

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
        assert_eq!(model_ids(&models), vec!["test-model"]);
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
        assert_eq!(model_ids(&models), vec!["llama3.3", "qwen2.5"]);
        mock.assert_async().await;
    }

    #[tokio::test]
    async fn integration_lmstudio_extended_api_includes_context_window() {
        let mut server = mockito::Server::new_async().await;
        // /api/v0/models is the only endpoint we hit since the /v1/models
        // fallback was removed. The extended listing carries `max_context_length`
        // per entry — verify it propagates into `DiscoveredModel.context_tokens`.
        let mock = server
            .mock("GET", "/api/v0/models")
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
        let client = build_llm_probe_client().unwrap();
        let models =
            do_discover_llm_models("lmstudio", &server.url(), &client, Duration::from_secs(2))
                .await
                .unwrap();
        assert_eq!(model_ids(&models), vec!["gpt-oss", "qwen"]);
        assert_eq!(models[0].context_tokens, Some(131_072));
        assert_eq!(models[1].context_tokens, Some(32_768));
        mock.assert_async().await;
    }

    #[tokio::test]
    async fn integration_lmstudio_extended_api_failure_propagates() {
        // /api/v0/models is the sole endpoint — without a fallback, a 500
        // response surfaces as an error rather than silently producing an
        // empty list.
        let mut server = mockito::Server::new_async().await;
        server
            .mock("GET", "/api/v0/models")
            .with_status(500)
            .create_async()
            .await;
        let client = build_llm_probe_client().unwrap();
        let result =
            do_discover_llm_models("lmstudio", &server.url(), &client, Duration::from_secs(2))
                .await;
        assert!(result.is_err(), "expected Err on /api/v0/models 500");
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
                .unwrap();
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
}
