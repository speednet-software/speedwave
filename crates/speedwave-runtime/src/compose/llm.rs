//! LLM provider switching (ADR-073): routes the `claude` container at the
//! per-project LiteLLM proxy, with the pre-proxy direct-injection path kept
//! behind the `proxy_enabled` kill-switch (removal in N+2).

use super::{inject_claude_env, tokens_path_in};
use crate::config::{LlmConfig, LlmProviderKind};
use crate::consts;
use std::path::Path;

/// Applies LLM provider switching. Local-LLM token reads resolve under the
/// explicit `data_dir` so callers (and tests) never touch the production
/// `~/.speedwave/tokens`. The only caller is `render_compose_in`, which
/// already threads the data dir.
pub(crate) fn apply_llm_config_in(
    data_dir: &Path,
    yaml: &str,
    llm: &LlmConfig,
    project: &str,
) -> anyhow::Result<String> {
    if llm.proxy_enabled.unwrap_or(true) {
        if let Some(entry) = llm.active_provider() {
            // Local custom headers are addressed to the LLM server itself;
            // LiteLLM would consume rather than forward them. Those setups
            // stay on the direct path until the proxy learns to relay them.
            let needs_direct = entry.kind == LlmProviderKind::Local && entry.has_custom_headers;
            if !needs_direct {
                return apply_llm_config_proxy(yaml, llm);
            }
            log::info!("llm: custom headers configured — using the direct (non-proxy) path");
        }
    }
    apply_llm_config_legacy_in(data_dir, yaml, llm, project)
}

/// ADR-073 proxy path: every session talks to the litellm service; the
/// provider kind picks the route and model prefix.
///
/// Auth rules (validated in the Phase 0 spike):
/// - `AnthropicOauth`: passthrough route, and **no** `ANTHROPIC_AUTH_TOKEN` /
///   `ANTHROPIC_API_KEY` may be injected — any of them disables Claude
///   Code's OAuth. The OAuth `Authorization` header transits LiteLLM
///   untouched because the proxy holds no canonical Anthropic credential.
/// - `AnthropicApiKey`: same passthrough route; the key keeps riding the
///   claude env (`apply_auth_config_in`) as `x-api-key`, which the
///   passthrough forwards. This keeps `/model` aliases and the `[1m]`
///   suffix semantics identical to the direct path.
/// - Everything else: the unified `/v1/messages` root with a dummy Bearer
///   (OAuth intentionally disabled) and a `<provider_id>/<model>` name that
///   matches the wildcard route in the rendered litellm config.
fn apply_llm_config_proxy(yaml: &str, llm: &LlmConfig) -> anyhow::Result<String> {
    let entry = llm
        .active_provider()
        .ok_or_else(|| anyhow::anyhow!("proxy path requires an active provider"))?;
    let model = llm
        .active
        .as_ref()
        .and_then(|a| a.model.as_deref())
        .map(str::trim)
        .unwrap_or("");

    let mut extra_env = std::collections::HashMap::new();
    match entry.kind {
        LlmProviderKind::AnthropicOauth | LlmProviderKind::AnthropicApiKey => {
            extra_env.extend(crate::defaults::anthropic_default_models_env());
            extra_env.insert(
                "ANTHROPIC_BASE_URL".to_string(),
                super::LITELLM_ANTHROPIC_PASSTHROUGH_URL.to_string(),
            );
            if !model.is_empty() {
                extra_env.insert("ANTHROPIC_MODEL".to_string(), model.to_string());
            }
        }
        LlmProviderKind::Local | LlmProviderKind::OpenRouter | LlmProviderKind::OpenAiCompat => {
            if model.is_empty() {
                anyhow::bail!(
                    "Provider '{}' requires a model name. \
                     Configure it in Settings → LLM Provider → Model.",
                    entry.id
                );
            }
            // `<id>/<model>` matches the per-provider wildcard route in the
            // rendered litellm config (OpenRouter models already carry the
            // `openrouter/` prefix as their provider id by convention).
            let routed_model = if model.starts_with(&format!("{}/", entry.id)) {
                model.to_string()
            } else {
                format!("{}/{}", entry.id, model)
            };
            extra_env.extend(std::collections::HashMap::from([
                (
                    "ANTHROPIC_BASE_URL".to_string(),
                    super::LITELLM_BASE_URL.to_string(),
                ),
                // Dummy Bearer: disables OAuth (intended — these sessions
                // never reach Anthropic) and satisfies servers that demand a
                // non-empty Authorization.
                (
                    "ANTHROPIC_AUTH_TOKEN".to_string(),
                    "sk-no-key-required".to_string(),
                ),
                ("ANTHROPIC_MODEL".to_string(), routed_model.clone()),
                // Subagents / background tasks default to a haiku alias no
                // non-Anthropic backend knows — pin them to the same model.
                (
                    "ANTHROPIC_SMALL_FAST_MODEL".to_string(),
                    routed_model.clone(),
                ),
                (
                    "ANTHROPIC_CUSTOM_MODEL_OPTION".to_string(),
                    routed_model.clone(),
                ),
                (
                    "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME".to_string(),
                    format!("{model} ({})", entry.id),
                ),
                (
                    "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION".to_string(),
                    format!("Served via Speedwave LLM proxy ({})", entry.id),
                ),
                (
                    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC".to_string(),
                    "1".to_string(),
                ),
            ]));
        }
    }
    extra_env.insert(
        "CLAUDE_CODE_ATTRIBUTION_HEADER".to_string(),
        "0".to_string(),
    );
    inject_claude_env(yaml, &extra_env)
}

/// Pre-ADR-073 direct-injection path, kept verbatim behind the
/// `proxy_enabled` kill-switch. Scheduled for removal in N+2.
fn apply_llm_config_legacy_in(
    data_dir: &Path,
    yaml: &str,
    llm: &LlmConfig,
    project: &str,
) -> anyhow::Result<String> {
    let provider = llm.provider.as_deref().unwrap_or("anthropic");
    if !crate::config::LOCAL_PROVIDERS.contains(&provider) && provider != "anthropic" {
        anyhow::bail!(
            "Unsupported LLM provider '{provider}'. Supported: anthropic, {}.",
            crate::config::LOCAL_PROVIDERS.join(", ")
        );
    }
    match provider {
        "anthropic" => {
            // ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL pin each alias to the
            // SSOT-latest model id with a `[1m]` suffix where the model
            // supports a 1M-token context window. Without this, Max/Team
            // subscribers see their 1M models capped at the 200k base spec
            // (anthropics/claude-code#34083). Generated dynamically so a SSOT
            // bump (Opus 4.8 etc.) propagates without touching this branch.
            let mut extra_env = crate::defaults::anthropic_default_models_env();
            let model = llm.model.as_deref().map(str::trim).unwrap_or("");
            if !model.is_empty() {
                extra_env.insert("ANTHROPIC_MODEL".to_string(), model.to_string());
            }
            inject_claude_env(yaml, &extra_env)
        }
        // All local providers (legacy aliases + `local`) share the same env
        // injection. `LOCAL_PROVIDERS` is the SSOT — adding a new local name
        // there propagates here automatically.
        local if crate::config::LOCAL_PROVIDERS.contains(&local) => {
            let base_url = llm
                .base_url
                .clone()
                .or_else(|| default_base_url(provider))
                .ok_or_else(|| anyhow::anyhow!("Provider '{}' requires a base_url.", provider))?;
            let base_url = strip_trailing_v1(&base_url);
            validate_base_url(&base_url)?;
            let model = llm.model.as_deref().ok_or_else(|| {
                anyhow::anyhow!(
                    "Provider '{}' requires a model name. \
                     Configure it in Settings → LLM Provider → Model.",
                    provider
                )
            })?;

            // Resolve Bearer auth token. If a per-project key file exists, use
            // it; otherwise inject the documented `sk-no-key-required` dummy so
            // Claude Code keeps the Authorization header present (some local
            // servers expect *any* non-empty Bearer).
            const DUMMY_TOKEN: &str = "sk-no-key-required";
            let auth_token = if llm.has_api_key {
                read_local_llm_token_opt_in(data_dir, project, "api_key").unwrap_or_else(|| {
                    log::warn!("local-llm api_key flagged but unreadable — using dummy");
                    DUMMY_TOKEN.to_string()
                })
            } else {
                DUMMY_TOKEN.to_string()
            };

            let mut extra_env = std::collections::HashMap::from([
                ("ANTHROPIC_BASE_URL".to_string(), base_url),
                ("ANTHROPIC_AUTH_TOKEN".to_string(), auth_token),
                ("ANTHROPIC_MODEL".to_string(), model.to_string()),
                (
                    "ANTHROPIC_CUSTOM_MODEL_OPTION".to_string(),
                    model.to_string(),
                ),
                (
                    "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME".to_string(),
                    custom_model_display_name(provider, model),
                ),
                (
                    "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION".to_string(),
                    custom_model_description(provider),
                ),
                (
                    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC".to_string(),
                    "1".to_string(),
                ),
                (
                    "CLAUDE_CODE_ATTRIBUTION_HEADER".to_string(),
                    "0".to_string(),
                ),
            ]);

            // Custom HTTP headers — stored as `Name: Value` per line for
            // human-friendly editing, flattened to a comma-separated single
            // line here because nerdctl-compose rejects YAML block literals
            // inside an `environment:` sequence. `Authorization` is rejected
            // defensively (a stale token file must not smuggle a header that
            // would collide with the `ANTHROPIC_AUTH_TOKEN` Bearer).
            if llm.has_custom_headers {
                if let Some(headers) =
                    read_local_llm_token_opt_in(data_dir, project, "custom_headers")
                {
                    let flattened = headers
                        .lines()
                        .map(str::trim)
                        .filter(|line| !line.is_empty())
                        .filter(|line| {
                            // Strip any leading `Authorization:` header.
                            !line
                                .split_once(':')
                                .map(|(name, _)| name.trim().eq_ignore_ascii_case("authorization"))
                                .unwrap_or(false)
                        })
                        .collect::<Vec<_>>()
                        .join(", ");
                    if !flattened.is_empty() {
                        extra_env.insert("ANTHROPIC_CUSTOM_HEADERS".to_string(), flattened);
                    }
                }
            }

            inject_claude_env(yaml, &extra_env)
        }
        // Unreachable: the early guard above filters all non-LOCAL_PROVIDERS
        // and non-"anthropic" values before this match.
        _ => unreachable!("provider validated by early guard"),
    }
}

/// Reads a local-LLM token file. Returns `None` on any failure (missing
/// file, I/O error, empty content). Callers decide whether to fall back to
/// a dummy or skip env injection.
pub fn read_local_llm_token_opt(project: &str, file: &str) -> Option<String> {
    read_local_llm_token_opt_in(consts::data_dir().as_path(), project, file)
}

/// Testable variant: resolves the token file under an explicit data directory.
pub fn read_local_llm_token_opt_in(data_dir: &Path, project: &str, file: &str) -> Option<String> {
    let path = tokens_path_in(data_dir, project, "local-llm", file).ok()?;
    let content = std::fs::read_to_string(&path).ok()?;
    let trimmed = content.trim_end_matches(['\n', '\r']).to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

/// Strips any trailing `/v1` and trailing slashes from a base URL.
/// Exposed so `update_llm_config` can normalize before validating, keeping
/// save-time and render-time acceptance consistent.
pub fn strip_trailing_v1(url: &str) -> String {
    let stripped = url.trim_end_matches('/');
    if let Some(without_v1) = stripped.strip_suffix("/v1") {
        without_v1.to_string()
    } else {
        stripped.to_string()
    }
}

/// Returns the default base URL for a known local model provider.
/// Used by the frontend to show a placeholder without duplicating the URL logic.
/// `"local"` defaults to the Ollama port — the most common starting point;
/// users typically replace it when pointing at a different server.
pub fn default_base_url(provider: &str) -> Option<String> {
    let host = consts::HOST_GATEWAY_ALIAS;
    match provider {
        "ollama" | "local" => Some(format!("http://{host}:11434")),
        "lmstudio" => Some(format!("http://{host}:1234")),
        "llamacpp" => Some(format!("http://{host}:8080")),
        _ => None,
    }
}

/// Human-readable label for a local LLM provider.
///
/// Invariant: the only callers (`custom_model_display_name` and
/// `custom_model_description`) are reached only after `apply_llm_config`
/// narrows the provider to one of the local values below. Any other
/// value at this point indicates a programmer error in `apply_llm_config`.
pub(crate) fn provider_display_label(provider: &str) -> &'static str {
    match provider {
        "ollama" => "Ollama",
        "lmstudio" => "LM Studio",
        "llamacpp" => "llama.cpp",
        "local" => "Local",
        other => unreachable!("provider_display_label called with unsupported provider '{other}'"),
    }
}

fn custom_model_display_name(provider: &str, model: &str) -> String {
    format!("{} ({})", model, provider_display_label(provider))
}

fn custom_model_description(provider: &str) -> String {
    format!("Local model served by {}", provider_display_label(provider))
}

/// Validates a base URL for local model providers. Rejects non-HTTP schemes,
/// credentials, query strings, and fragments.
///
/// Path policy: accepts `/` (or empty), or a single-segment prefix matching
/// `^/[A-Za-z0-9_-]+$` (e.g. LiteLLM's `/anthropic`, AWS gateway's `/v1`).
/// Multi-segment paths, `..`, and trailing slashes on segments are rejected.
pub fn validate_base_url(raw: &str) -> anyhow::Result<()> {
    // Reject `..` / `.` segments in the *raw* input before url::Url parses, as
    // the URL crate normalizes them away (`http://host/..` parses to path `/`).
    // Without this, a malicious URL could slip through traversal checks.
    if raw.contains("/..") || raw.contains("/./") || raw.ends_with("/.") {
        anyhow::bail!("base_url must not contain '..' or '.' path segments");
    }
    let parsed =
        url::Url::parse(raw).map_err(|e| anyhow::anyhow!("Invalid base_url '{}': {}", raw, e))?;
    match parsed.scheme() {
        "http" | "https" => {}
        s => anyhow::bail!("base_url must use http:// or https://, got: {}", s),
    }
    if parsed.username() != "" || parsed.password().is_some() {
        anyhow::bail!("base_url must not contain credentials");
    }
    let path = parsed.path();
    if path != "/" && !path.is_empty() {
        // Allow a single-segment path prefix (LiteLLM `/anthropic`,
        // AWS-style `/v1`). Anything multi-segment, traversal, or trailing
        // slash on the segment is rejected.
        if !path.starts_with('/') {
            anyhow::bail!("base_url path must start with '/', got '{}'", path);
        }
        let segment = &path[1..];
        let valid = !segment.is_empty()
            && !segment.contains('/')
            && segment
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
        if !valid {
            anyhow::bail!(
                "base_url path must be a single segment matching ^/[A-Za-z0-9_-]+$ (got '{}')",
                path
            );
        }
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        anyhow::bail!("base_url must not contain query or fragment");
    }
    Ok(())
}
