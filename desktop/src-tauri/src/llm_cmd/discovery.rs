use futures_util::stream::{self, StreamExt};
use serde::{Deserialize, Serialize};
use std::time::Duration;

use crate::http_util::read_body_limited;
#[cfg(test)]
use crate::http_util::MAX_RESPONSE_BODY_BYTES;
#[cfg(test)]
use crate::llm_cmd::build_llm_probe_client;
use crate::llm_cmd::{
    build_llm_probe_client_with_auth, strip_bearer_prefix, DISCOVERY_TIMEOUT_SECS,
};
use crate::url_validation::{is_private_on_premise, validate_url, PrivatePolicy};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DiscoveredModel {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_tokens: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscoverResult {
    pub models: Vec<DiscoveredModel>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub messages_endpoint_ok: Option<bool>,
}

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
    for (k, val) in model_info {
        if k.ends_with(".context_length") {
            if let Some(n) = val.as_u64() {
                return non_zero_u32(n);
            }
        }
    }
    None
}

fn non_zero_u32(n: u64) -> Option<u32> {
    u32::try_from(n).ok().filter(|&v| v > 0)
}

pub(crate) fn validate_llm_base_url(url: &str) -> Result<url::Url, String> {
    if url.contains('\\') {
        return Err("URL must not contain backslashes".to_string());
    }

    let candidate: url::Url = url.parse().map_err(|e: url::ParseError| e.to_string())?;

    if candidate.query().is_some() {
        return Err("URL must not contain a query string".to_string());
    }
    if candidate.fragment().is_some() {
        return Err("URL must not contain a fragment".to_string());
    }

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
            let host = candidate.host_str().unwrap_or("<bug:no-host>");
            if host_is_localhost || is_loopback_host(&candidate) {
                log::warn!("Allowing loopback address for local LLM: {}", host);
            } else {
                log::warn!("Allowing private address for local LLM: {}", host);
            }
            candidate
        } else {
            let v = validate_url(url)?;
            let host = v.host_str().unwrap_or("<bug:no-host>");
            log::warn!("Allowing public address for local LLM: {}", host);
            v
        };

    if parsed.password().is_some() || !parsed.username().is_empty() {
        return Err("URL must not contain embedded credentials".to_string());
    }

    if parsed.scheme() == "http" {
        log::warn!("LLM traffic will be transmitted in cleartext over HTTP");
    }

    Ok(parsed)
}

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

fn normalize_and_validate_discovery_url(base_url: &str) -> Result<url::Url, String> {
    let normalized = speedwave_runtime::compose::strip_trailing_v1(base_url);

    let mut parsed: url::Url = normalized
        .parse()
        .map_err(|e: url::ParseError| format!("Invalid base_url: {e}"))?;

    if let Some(host_str) = parsed.host_str() {
        if let Some(loopback) = crate::http_util::rewrite_container_alias_to_loopback(host_str) {
            parsed
                .set_host(Some(loopback))
                .map_err(|e| format!("URL host rewrite failed: {e}"))?;
        }
    }

    validate_llm_base_url(parsed.as_str())
}

#[async_trait::async_trait]
pub(crate) trait ProbeTransport: Send + Sync {
    async fn get(&self, url: &str) -> Result<ProbeResponse, String>;
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
                log::warn!(
                    "LLM probe GET {url} failed on host transport: {}",
                    crate::http_util::error_chain(&e)
                );
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
                log::warn!(
                    "LLM probe POST {url} failed on host transport: {}",
                    crate::http_util::error_chain(&e)
                );
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
            if line
                .split_once(':')
                .map(|(name, _)| name.trim().eq_ignore_ascii_case("authorization"))
                .unwrap_or(false)
            {
                log::warn!("dropping Authorization from custom_headers in VM probe (use api_key)");
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

    let exec_timeout = timeout + Duration::from_secs(2);
    let out = runtime
        .vm_exec("curl", &args_ref, &[], exec_timeout)
        .map_err(|e| {
            log::warn!("vm_exec curl failed for LLM probe: {e}");
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

const MAX_OLLAMA_PROBE_CONCURRENCY: usize = 8;

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

    if entries.iter().all(|m| m.context_tokens.is_some()) {
        return Ok(entries);
    }

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
        return Ok(entries);
    }
    let first_ctx = sanity.as_ref().and_then(|r| parse_ollama_show(&r.body));

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

const ERR_AUTH: &str = "auth";
const ERR_EMPTY: &str = "empty";
const ERR_UNSUPPORTED: &str = "unsupported";
const ERR_HTML_RESPONSE: &str = "LLM server returned an HTML response";
const ERR_HTTP_STATUS_PREFIX: &str = "LLM server returned HTTP ";

fn enforce_json_response(resp: &ProbeResponse, url: &str) -> Result<(), String> {
    if !resp.is_success() {
        if resp.status == 401 || resp.status == 403 {
            log::warn!(
                "{} returned HTTP {} (auth) during LLM model discovery — bad or missing API key",
                url,
                resp.status
            );
            return Err(ERR_AUTH.to_string());
        }
        if resp.is_redirect() {
            log::warn!(
                "refusing to follow {} redirect from {} during LLM model discovery",
                resp.status,
                url
            );
        } else {
            log::warn!(
                "{} returned HTTP {} during LLM model discovery",
                url,
                resp.status
            );
        }
        return Err(format!("{ERR_HTTP_STATUS_PREFIX}{}", resp.status));
    }
    if let Some(ct) = resp.content_type.as_deref() {
        if ct.to_ascii_lowercase().starts_with("text/html") {
            log::warn!(
                "{} returned HTML content-type during LLM model discovery, refusing",
                url
            );
            return Err(ERR_HTML_RESPONSE.to_string());
        }
    }
    Ok(())
}

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
            })
            .or_else(|| {
                entry
                    .get("max_input_tokens")
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

const OPENROUTER_MODELS_URL: &str = "https://openrouter.ai/api/v1/models";

fn parse_openrouter_models(body: &[u8]) -> Result<Vec<DiscoveredModel>, String> {
    let v: serde_json::Value = serde_json::from_slice(body)
        .map_err(|e| format!("failed to parse OpenRouter models response: {e}"))?;
    let data = v
        .get("data")
        .and_then(|d| d.as_array())
        .ok_or_else(|| "OpenRouter models response missing `data` array".to_string())?;
    let mut out = Vec::new();
    for entry in data {
        let id = entry.get("id").and_then(|v| v.as_str()).unwrap_or("");
        if id.is_empty() {
            continue;
        }
        let supports_tools = entry
            .get("supported_parameters")
            .and_then(|p| p.as_array())
            .is_some_and(|p| p.iter().any(|s| s.as_str() == Some("tools")));
        if !supports_tools {
            continue;
        }
        out.push(DiscoveredModel {
            id: id.to_string(),
            context_tokens: entry
                .get("context_length")
                .and_then(|n| n.as_u64())
                .and_then(non_zero_u32),
        });
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

async fn discover_openrouter(
    transport: &dyn ProbeTransport,
) -> Result<Vec<DiscoveredModel>, String> {
    let resp = transport.get(OPENROUTER_MODELS_URL).await?;
    enforce_json_response(&resp, OPENROUTER_MODELS_URL)?;
    parse_openrouter_models(&resp.body)
}

fn stored_credential(provider: &str, project: Option<&str>, file: &str) -> Option<String> {
    stored_credential_in(
        speedwave_runtime::consts::data_dir(),
        provider,
        project,
        file,
    )
}

fn stored_credential_in(
    data_dir: &std::path::Path,
    provider: &str,
    project: Option<&str>,
    file: &str,
) -> Option<String> {
    if !speedwave_runtime::config::is_local_provider(Some(provider)) {
        return None;
    }
    project.and_then(|p| speedwave_runtime::compose::read_local_llm_token_opt_in(data_dir, p, file))
}

fn resolve_transient_credential(
    field: Option<&Option<String>>,
    provider: &str,
    project: Option<&str>,
    file: &str,
) -> Option<String> {
    match field {
        None => stored_credential(provider, project, file),
        Some(None) => None,
        Some(Some(s)) if s.is_empty() => None,
        Some(Some(s)) => strip_bearer_prefix(s),
    }
}

async fn probe_messages_endpoint(
    base: &url::Url,
    model: Option<&str>,
    transport: &dyn ProbeTransport,
) -> Option<bool> {
    let url = format!("{}/v1/messages", base.as_str().trim_end_matches('/'));
    let body = serde_json::json!({
        "model": model.unwrap_or("ping"),
        "max_tokens": 1,
        "messages": [{ "role": "user", "content": "ping" }],
    });
    let resp = transport.post(&url, &body).await;
    match resp {
        Ok(r) => {
            let status = r.status;
            match status {
                404 | 405 => Some(false),
                s if (200..500).contains(&s) => Some(true),
                _ => None,
            }
        }
        Err(_) => None,
    }
}

pub(crate) async fn do_discover_llm_models(
    provider: &str,
    base_url: &str,
    transport: &dyn ProbeTransport,
) -> Result<DiscoverResult, String> {
    if provider == "anthropic" {
        return Err(ERR_UNSUPPORTED.to_string());
    }

    if provider == "openrouter" {
        let models = discover_openrouter(transport).await?;
        if models.is_empty() {
            return Err(ERR_EMPTY.to_string());
        }
        return Ok(DiscoverResult {
            models,
            messages_endpoint_ok: None,
        });
    }

    let validated = normalize_and_validate_discovery_url(base_url)?;

    let (raw_models, messages_endpoint_ok) =
        if speedwave_runtime::config::is_local_provider(Some(provider)) {
            let models = discover_local(&validated, transport).await?;
            let first_model = models.first().map(|m| m.id.as_str());
            let sanity = probe_messages_endpoint(&validated, first_model, transport).await;
            (models, sanity)
        } else {
            return Err(ERR_UNSUPPORTED.to_string());
        };

    let models: Vec<DiscoveredModel> = raw_models
        .into_iter()
        .filter(|m| !m.id.is_empty())
        .collect();

    log::info!(
        "LLM model discovery for {} returned {} model(s) (messages_ok={:?})",
        provider,
        models.len(),
        messages_endpoint_ok
    );

    if models.is_empty() {
        return Err(ERR_EMPTY.to_string());
    }
    Ok(DiscoverResult {
        models,
        messages_endpoint_ok,
    })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoverLlmModelsArgs {
    pub provider: String,
    pub base_url: String,
    #[serde(default, with = "serde_with::rust::double_option")]
    pub api_key: Option<Option<String>>,
    #[serde(default, with = "serde_with::rust::double_option")]
    pub custom_headers: Option<Option<String>>,
    #[serde(default)]
    pub project: Option<String>,
}

fn credential_project(args: &DiscoverLlmModelsArgs, active: Option<String>) -> Option<String> {
    args.project.clone().or(active)
}

/// Discovers over the VM transport; when that fails, logs the VM error with its cause at info
/// (expected for a server on the host's loopback) and retries over the host transport.
async fn discover_via_vm_then_host<H: ProbeTransport>(
    provider: &str,
    base_url: &str,
    vm: &dyn ProbeTransport,
    host: impl FnOnce() -> Result<H, String>,
) -> Result<DiscoverResult, String> {
    match do_discover_llm_models(provider, base_url, vm).await {
        Ok(result) => Ok(result),
        Err(vm_err) => {
            log::info!(
                "VM probe for LLM model discovery failed, retrying via host transport: {vm_err}"
            );
            let host_transport = host()?;
            do_discover_llm_models(provider, base_url, &host_transport).await
        }
    }
}

pub(crate) async fn discover_llm_models_with_fallback(
    provider: &str,
    base_url: &str,
    api_key: Option<&str>,
    custom_headers: Option<&str>,
    active_project: Option<&str>,
) -> Result<DiscoverResult, String> {
    let bearer = api_key
        .and_then(strip_bearer_prefix)
        .or_else(|| stored_credential(provider, active_project, "api_key"));
    let headers = custom_headers
        .map(str::to_string)
        .or_else(|| stored_credential(provider, active_project, "custom_headers"));
    let timeout = Duration::from_secs(DISCOVERY_TIMEOUT_SECS);
    let runtime = speedwave_runtime::runtime::detect_runtime();
    let vm_available = runtime.is_available();
    let result = if vm_available {
        let vm_transport = VmProbe::new(bearer.clone(), headers.clone(), timeout);
        discover_via_vm_then_host(provider, base_url, &vm_transport, || {
            let client = build_llm_probe_client_with_auth(bearer.as_deref(), headers.as_deref())?;
            Ok(HostProbe::new(client, timeout))
        })
        .await
    } else {
        let client = build_llm_probe_client_with_auth(bearer.as_deref(), headers.as_deref())?;
        let host_transport = HostProbe::new(client, timeout);
        do_discover_llm_models(provider, base_url, &host_transport).await
    };
    match &result {
        Ok(r) => log::info!(
            "LLM model discovery succeeded: {} model(s), messages_endpoint_ok={:?}",
            r.models.len(),
            r.messages_endpoint_ok
        ),
        Err(e) => log::warn!("LLM model discovery failed: {e}"),
    }
    result
}

#[tauri::command]
pub async fn discover_llm_models(args: DiscoverLlmModelsArgs) -> Result<DiscoverResult, String> {
    log::info!(
        "discovering LLM models: provider={} base_url={} api_key_present={} custom_headers_present={}",
        args.provider,
        args.base_url,
        args.api_key.is_some(),
        args.custom_headers.is_some(),
    );
    let active = speedwave_runtime::config::load_user_config()
        .ok()
        .and_then(|c| c.active_project);
    let project = credential_project(&args, active);
    let bearer = resolve_transient_credential(
        args.api_key.as_ref(),
        &args.provider,
        project.as_deref(),
        "api_key",
    );
    let headers = resolve_transient_credential(
        args.custom_headers.as_ref(),
        &args.provider,
        project.as_deref(),
        "custom_headers",
    );
    discover_llm_models_with_fallback(
        &args.provider,
        &args.base_url,
        bearer.as_deref(),
        headers.as_deref(),
        None,
    )
    .await
}

#[cfg(test)]
#[expect(clippy::unwrap_used, clippy::expect_used, reason = "test code")]
mod tests {
    use super::*;
    use std::sync::{Mutex, OnceLock};

    fn model_ids(models: &[DiscoveredModel]) -> Vec<&str> {
        models.iter().map(|m| m.id.as_str()).collect()
    }

    async fn do_discover_llm_models(
        provider: &str,
        base_url: &str,
        client: &reqwest::Client,
        timeout: Duration,
    ) -> Result<DiscoverResult, String> {
        let transport = HostProbe::new(client.clone(), timeout);
        super::do_discover_llm_models(provider, base_url, &transport).await
    }

    fn ts_string_after<'a>(src: &'a str, marker: &str) -> &'a str {
        let start = src
            .find(marker)
            .unwrap_or_else(|| panic!("TS source must contain `{marker}`"));
        let rest = &src[start + marker.len()..];
        let open = rest.find('\'').expect("opening quote after marker");
        let rest = &rest[open + 1..];
        let close = rest.find('\'').expect("closing quote after marker");
        &rest[..close]
    }

    #[test]
    fn discovery_err_contract_matches_ts() {
        let src =
            include_str!("../../../src/src/app/settings/llm-provider/llm-provider.component.ts");
        assert_eq!(
            ts_string_after(src, "const HTTP_STATUS_ERR_PREFIX"),
            ERR_HTTP_STATUS_PREFIX,
            "TS HTTP_STATUS_ERR_PREFIX must equal the Rust prefix (incl. trailing space)"
        );
        for sentinel in [ERR_AUTH, ERR_EMPTY, ERR_UNSUPPORTED, ERR_HTML_RESPONSE] {
            let needle = format!("msg === '{sentinel}'");
            assert!(
                src.contains(&needle),
                "classifyDiscoveryFailure must exact-match `{needle}`"
            );
        }
    }

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

    #[test]
    fn parse_ollama_show_resolves_arch_specific_context_length() {
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
    fn parse_ollama_show_treats_zero_context_length_as_unknown() {
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

    #[test]
    fn validate_allows_localhost_hostname() {
        assert!(validate_llm_base_url("http://localhost:11434").is_ok());
    }

    #[test]
    fn validate_allows_loopback_ipv4() {
        assert!(validate_llm_base_url("http://127.0.0.1:11434").is_ok());
    }

    #[test]
    fn validate_allows_rfc1918() {
        assert!(validate_llm_base_url("http://192.168.1.1").is_ok());
    }

    #[test]
    fn validate_blocks_link_local_metadata() {
        let err = validate_llm_base_url("http://169.254.169.254").unwrap_err();
        assert!(
            err.to_lowercase().contains("private") || err.to_lowercase().contains("reserved"),
            "expected metadata IP rejection; got: {err}"
        );
    }

    #[test]
    fn validate_allows_public_ipv4() {
        assert!(validate_llm_base_url("http://8.8.8.8").is_ok());
    }

    #[test]
    fn validate_allows_public_domain() {
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
        assert!(validate_llm_base_url("http://[::ffff:127.0.0.1]").is_ok());
    }

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
    async fn discover_routes_every_local_provider_kind_via_ssot() {
        let mut server = mockito::Server::new_async().await;
        let _models_mock = server
            .mock("GET", "/v1/models")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"data":[{"id":"test-model"}]}"#)
            .create_async()
            .await;
        let _messages_mock = server
            .mock("POST", "/v1/messages")
            .with_status(200)
            .with_body(r#"{}"#)
            .create_async()
            .await;

        let client = build_llm_probe_client().unwrap();
        for provider in speedwave_runtime::config::LOCAL_PROVIDERS {
            assert!(speedwave_runtime::config::is_local_provider(Some(provider)));
            let result =
                do_discover_llm_models(provider, &server.url(), &client, Duration::from_secs(2))
                    .await;
            assert!(
                !matches!(result, Err(ref e) if e == ERR_UNSUPPORTED),
                "provider '{provider}' accepted by is_local_provider must not return unsupported"
            );
        }
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

    #[tokio::test]
    async fn integration_legacy_ollama_alias_routes_to_unified_path() {
        let mut server = mockito::Server::new_async().await;
        let _models_mock = server
            .mock("GET", "/v1/models")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"data":[{"id":"llama3.3"},{"id":"qwen2.5"}]}"#)
            .create_async()
            .await;
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
        let err =
            do_discover_llm_models("llamacpp", &server.url(), &client, Duration::from_secs(2))
                .await
                .unwrap_err();
        assert_eq!(err, "LLM server returned HTTP 500");
    }

    #[tokio::test]
    async fn integration_returns_auth_sentinel_on_401() {
        let mut server = mockito::Server::new_async().await;
        server
            .mock("GET", "/v1/models")
            .with_status(401)
            .create_async()
            .await;
        let client = build_llm_probe_client().unwrap();
        let err =
            do_discover_llm_models("llamacpp", &server.url(), &client, Duration::from_secs(2))
                .await
                .unwrap_err();
        assert_eq!(err, "auth");
    }

    #[tokio::test]
    async fn integration_returns_auth_sentinel_on_403() {
        let mut server = mockito::Server::new_async().await;
        server
            .mock("GET", "/v1/models")
            .with_status(403)
            .create_async()
            .await;
        let client = build_llm_probe_client().unwrap();
        let err =
            do_discover_llm_models("llamacpp", &server.url(), &client, Duration::from_secs(2))
                .await
                .unwrap_err();
        assert_eq!(err, "auth");
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
        never_hit.assert_async().await;
    }

    #[tokio::test]
    async fn integration_redirect_to_metadata_ip_not_followed() {
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
    fn parse_openai_models_with_context_extracts_litellm_shape() {
        let body = br#"{"data":[
            {"id":"gemma-4-26b-a4b","object":"model","max_input_tokens":262144,"max_output_tokens":32768},
            {"id":"small-model","object":"model","max_input_tokens":32768,"max_output_tokens":8192},
            {"id":"qwen3-coder-30b","object":"model"},
            {"id":"zero-window","object":"model","max_input_tokens":0}
        ]}"#;
        let out = parse_openai_models_with_context(body).unwrap();
        assert_eq!(out[0].context_tokens, Some(262_144));
        assert_eq!(out[1].context_tokens, Some(32_768));
        assert_eq!(out[2].context_tokens, None);
        assert_eq!(out[3].context_tokens, None);
    }

    #[test]
    fn parse_openai_models_with_context_prefers_the_server_context_over_litellm_model_info() {
        let body = br#"{"data":[
            {"id":"llama","meta":{"n_ctx_train":8192},"max_input_tokens":262144},
            {"id":"qwen","max_context_length":32768,"max_input_tokens":262144}
        ]}"#;
        let out = parse_openai_models_with_context(body).unwrap();
        assert_eq!(out[0].context_tokens, Some(8192));
        assert_eq!(out[1].context_tokens, Some(32_768));
    }

    #[test]
    fn parse_openai_models_with_context_handles_mixed_dialect() {
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
        assert_eq!(result.messages_endpoint_ok, Some(true));
        models_mock.assert_async().await;
        messages_mock.assert_async().await;
        no_show_mock.assert_async().await;
    }

    #[tokio::test]
    async fn discover_llm_models_with_fallback_returns_first_local_model_via_host_probe() {
        let mut server = mockito::Server::new_async().await;
        let _m = server
            .mock("GET", "/v1/models")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"data":[{"id":"llama-3.3-70b"},{"id":"llama-3.1-8b"}]}"#)
            .create_async()
            .await;
        let result = discover_llm_models_with_fallback("ollama", &server.url(), None, None, None)
            .await
            .expect("discovery must succeed against the mocked server");
        assert_eq!(
            result.models.first().map(|m| m.id.as_str()),
            Some("llama-3.3-70b")
        );
    }

    #[tokio::test]
    async fn integration_local_messages_probe_uses_real_model_not_ping() {
        let mut server = mockito::Server::new_async().await;
        let models_mock = server
            .mock("GET", "/v1/models")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"data":[{"id":"qwen3:0.6b","meta":{"n_ctx_train":4096}}]}"#)
            .expect(1)
            .create_async()
            .await;
        let real_model_mock = server
            .mock("POST", "/v1/messages")
            .match_body(mockito::Matcher::PartialJsonString(
                r#"{"model":"qwen3:0.6b"}"#.to_string(),
            ))
            .with_status(200)
            .with_body(r#"{"type":"message","content":[]}"#)
            .expect(1)
            .create_async()
            .await;
        let ping_mock = server
            .mock("POST", "/v1/messages")
            .match_body(mockito::Matcher::PartialJsonString(
                r#"{"model":"ping"}"#.to_string(),
            ))
            .with_status(404)
            .expect(0)
            .create_async()
            .await;

        let client = build_llm_probe_client().unwrap();
        let result =
            do_discover_llm_models("local", &server.url(), &client, Duration::from_secs(2))
                .await
                .unwrap();
        assert_eq!(result.messages_endpoint_ok, Some(true));
        models_mock.assert_async().await;
        real_model_mock.assert_async().await;
        ping_mock.assert_async().await;
    }

    #[tokio::test]
    async fn integration_local_warns_when_messages_endpoint_missing() {
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
        assert_eq!(result.messages_endpoint_ok, Some(false));
        models_mock.assert_async().await;
        messages_mock.assert_async().await;
        no_show_mock.assert_async().await;
    }

    #[tokio::test]
    async fn integration_local_falls_back_to_ollama_show_when_no_inline_meta() {
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
        assert_eq!(result.messages_endpoint_ok, Some(true));
        models_mock.assert_async().await;
        show_mock.assert_async().await;
        messages_mock.assert_async().await;
    }

    #[tokio::test]
    async fn integration_local_generic_openai_gateway_stays_under_three_calls_for_context() {
        let mut server = mockito::Server::new_async().await;
        let models_mock = server
            .mock("GET", "/v1/models")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"data":[{"id":"a"},{"id":"b"},{"id":"c"},{"id":"d"},{"id":"e"}]}"#)
            .expect(1)
            .create_async()
            .await;
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

    #[test]
    fn resolve_credential_some_some_strips_bearer_prefix() {
        let r = resolve_transient_credential(
            Some(&Some("Bearer sk-test".to_string())),
            "local",
            None,
            "api_key",
        );
        assert_eq!(r, Some("sk-test".to_string()));
    }

    #[test]
    fn resolve_credential_some_none_means_no_auth() {
        let r = resolve_transient_credential(Some(&None), "local", None, "api_key");
        assert_eq!(r, None, "Some(None) explicitly means no auth");
    }

    #[test]
    fn resolve_credential_some_empty_string_means_no_auth() {
        let r = resolve_transient_credential(Some(&Some(String::new())), "local", None, "api_key");
        assert_eq!(r, None, "Some(Some(\"\")) means no auth");
    }

    fn discover_args(provider: &str, project: Option<&str>) -> DiscoverLlmModelsArgs {
        DiscoverLlmModelsArgs {
            provider: provider.to_string(),
            base_url: String::new(),
            api_key: None,
            custom_headers: None,
            project: project.map(str::to_string),
        }
    }

    #[test]
    fn a_probe_reads_the_stored_credentials_of_the_forms_project_else_the_active_one() {
        let active = || Some("alpha".to_string());

        let named = credential_project(&discover_args("local", Some("beta")), active());
        let unnamed = credential_project(&discover_args("local", None), active());

        assert_eq!(named.as_deref(), Some("beta"));
        assert_eq!(unnamed.as_deref(), Some("alpha"));
    }

    #[test]
    fn only_a_local_provider_reads_the_stored_local_server_credentials() {
        let tmp = tempfile::tempdir().expect("tempdir");
        for (file, value) in [
            ("api_key", "sk-local-server"),
            ("custom_headers", "X-Team: a"),
        ] {
            let path =
                speedwave_runtime::compose::tokens_path_in(tmp.path(), "alpha", "local-llm", file)
                    .expect("token path");
            std::fs::create_dir_all(path.parent().expect("token dir")).expect("create token dir");
            std::fs::write(&path, format!("{value}\n")).expect("write token");
        }

        for (file, value) in [
            ("api_key", "sk-local-server"),
            ("custom_headers", "X-Team: a"),
        ] {
            assert_eq!(
                stored_credential_in(tmp.path(), "local", Some("alpha"), file).as_deref(),
                Some(value)
            );
            for provider in ["openrouter", "anthropic"] {
                assert_eq!(
                    stored_credential_in(tmp.path(), provider, Some("alpha"), file),
                    None,
                    "{provider} {file}"
                );
            }
        }
        assert_eq!(
            stored_credential_in(tmp.path(), "local", None, "api_key"),
            None
        );
    }

    const OPENROUTER_CATALOG: &[u8] = br#"{"data":[
        {"id":"deepseek/deepseek-v3.2","context_length":163840,
         "supported_parameters":["tools","tool_choice","max_tokens"]},
        {"id":"nvidia/llama-nemotron-rerank-vl-1b-v2:free","context_length":8192,
         "supported_parameters":["max_tokens"]},
        {"id":"qwen/qwen3-coder","context_length":262144,
         "supported_parameters":["tools"]},
        {"id":"vendor/no-params-model","context_length":4096},
        {"id":"","context_length":1},
        {"id":"vendor/zero-ctx","context_length":0,"supported_parameters":["tools"]}
    ]}"#;

    #[test]
    fn parse_openrouter_keeps_only_tool_capable_models_sorted() {
        let models = parse_openrouter_models(OPENROUTER_CATALOG).unwrap();
        assert_eq!(
            model_ids(&models),
            vec![
                "deepseek/deepseek-v3.2",
                "qwen/qwen3-coder",
                "vendor/zero-ctx"
            ]
        );
        assert_eq!(models[0].context_tokens, Some(163840));
        assert_eq!(models[2].context_tokens, None, "zero context → unknown");
    }

    #[test]
    fn parse_openrouter_rejects_malformed_payloads() {
        assert!(parse_openrouter_models(b"not json").is_err());
        assert!(parse_openrouter_models(br#"{"models":[]}"#).is_err());
        assert_eq!(
            parse_openrouter_models(br#"{"data":[]}"#).unwrap(),
            Vec::new()
        );
    }

    struct CatalogTransport(Vec<u8>);

    #[async_trait::async_trait]
    impl ProbeTransport for CatalogTransport {
        async fn get(&self, url: &str) -> Result<ProbeResponse, String> {
            assert_eq!(url, OPENROUTER_MODELS_URL);
            Ok(ProbeResponse {
                status: 200,
                content_type: Some("application/json".into()),
                body: self.0.clone(),
            })
        }
        async fn post(
            &self,
            _url: &str,
            _body: &serde_json::Value,
        ) -> Result<ProbeResponse, String> {
            Err("unexpected POST".into())
        }
    }

    #[tokio::test]
    async fn discover_openrouter_ignores_base_url_and_skips_messages_probe() {
        let transport = CatalogTransport(OPENROUTER_CATALOG.to_vec());
        let res = super::do_discover_llm_models("openrouter", "", &transport)
            .await
            .unwrap();
        assert_eq!(res.models.len(), 3);
        assert_eq!(res.messages_endpoint_ok, None);
    }

    #[tokio::test]
    async fn discover_openrouter_empty_catalog_maps_to_empty_error() {
        let transport = CatalogTransport(br#"{"data":[]}"#.to_vec());
        let err = super::do_discover_llm_models("openrouter", "", &transport)
            .await
            .unwrap_err();
        assert_eq!(err, "empty");
    }

    struct FailingTransport(&'static str);

    #[async_trait::async_trait]
    impl ProbeTransport for FailingTransport {
        async fn get(&self, _url: &str) -> Result<ProbeResponse, String> {
            Err(self.0.to_string())
        }
        async fn post(
            &self,
            _url: &str,
            _body: &serde_json::Value,
        ) -> Result<ProbeResponse, String> {
            Err(self.0.to_string())
        }
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn vm_probe_failure_is_logged_with_its_cause_before_the_host_retry() {
        let logger = test_logger();
        let _ = logger.take();
        let vm = FailingTransport(
            "LLM model discovery: curl in VM failed: curl: (6) Could not resolve host: llm.example",
        );
        let res = discover_via_vm_then_host("openrouter", "", &vm, || {
            Ok(CatalogTransport(OPENROUTER_CATALOG.to_vec()))
        })
        .await
        .unwrap();
        assert_eq!(
            res.models.len(),
            3,
            "the host transport answers after the VM"
        );
        let records = logger.take();
        assert!(
            records.iter().any(|(level, msg)| {
                *level == log::Level::Info
                    && msg.contains("retrying via host transport")
                    && msg.contains("Could not resolve host: llm.example")
            }),
            "the VM error must be logged at info before the host retry; got: {records:?}"
        );
    }

    #[tokio::test]
    async fn vm_probe_success_never_builds_the_host_transport() {
        let vm = CatalogTransport(OPENROUTER_CATALOG.to_vec());
        let mut host_built = false;
        let res = discover_via_vm_then_host("openrouter", "", &vm, || {
            host_built = true;
            Err::<CatalogTransport, String>("unused".into())
        })
        .await
        .unwrap();
        assert_eq!(res.models.len(), 3);
        assert!(!host_built);
    }

    #[tokio::test]
    async fn host_transport_build_error_is_returned_after_a_vm_failure() {
        let vm = FailingTransport("VM probe failed: no route to host");
        let err = discover_via_vm_then_host("openrouter", "", &vm, || {
            Err::<CatalogTransport, String>("Failed to build HTTP client: boom".into())
        })
        .await
        .unwrap_err();
        assert_eq!(err, "Failed to build HTTP client: boom");
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn host_probe_logs_the_cause_of_a_refused_connection() {
        let logger = test_logger();
        let _ = logger.take();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let transport = HostProbe::new(
            crate::http_util::build_hardened_client(None).unwrap(),
            Duration::from_secs(5),
        );
        let err = transport
            .get(&format!("http://127.0.0.1:{port}/v1/models"))
            .await
            .unwrap_err();
        assert!(
            err.starts_with("LLM model discovery: request failed:"),
            "the user-facing error keeps its shape: {err}"
        );
        let records = logger.take();
        let address = format!("127.0.0.1:{port}");
        assert!(
            records.iter().any(|(level, msg)| {
                *level == log::Level::Warn && msg.contains(&address) && msg.contains("os error")
            }),
            "one host probe warning must name both the address and the refused connection; \
             got: {records:?}"
        );
    }
}
