//! LLM provider switching (ADR-073): routes `claude` at the per-project proxy,
//! with the pre-proxy direct path behind the `proxy_enabled` kill-switch.

use super::{inject_claude_env, tokens_path_in};
use crate::config::{LlmConfig, LlmProviderKind};
use crate::consts;
use std::path::Path;

/// Applies LLM provider switching. Local-LLM token reads resolve under the
/// explicit `data_dir`.
pub(crate) fn apply_llm_config_in(
    data_dir: &Path,
    yaml: &str,
    llm: &LlmConfig,
    project: &str,
) -> anyhow::Result<String> {
    if llm.proxy_enabled.unwrap_or(true) {
        if let Some(entry) = llm.active_provider() {
            // Local custom headers are unsupported by the proxy — stay on direct path.
            let needs_direct = entry.kind == LlmProviderKind::Local && entry.has_custom_headers;
            if !needs_direct {
                return apply_llm_config_proxy(yaml, llm);
            }
            log::info!("llm: custom headers configured — using the direct (non-proxy) path");
        }
    } else if let Some(entry) = llm.active_provider() {
        // Legacy direct path supports only anthropic + local; erroring beats
        // silently billing the Anthropic subscription for an OpenRouter session.
        if matches!(entry.kind, LlmProviderKind::OpenRouter) {
            anyhow::bail!(
                "Provider '{}' requires the LLM proxy. Re-enable it (unset proxy_enabled=false) \
                 to use OpenRouter.",
                entry.id
            );
        }
    } else if llm.active.is_some() {
        // Kill-switch + dangling active (points at no entry): legacy path falls
        // back to the Anthropic account default. Heal normally repairs this.
        log::warn!(
            "llm: kill-switch with a dangling active selection — using the direct default path"
        );
    }
    apply_llm_config_legacy_in(data_dir, yaml, llm, project)
}

/// ADR-073 proxy path: every session talks to the proxy service; the
/// provider kind picks the route and model prefix.
fn apply_llm_config_proxy(yaml: &str, llm: &LlmConfig) -> anyhow::Result<String> {
    let entry = llm
        .active_provider()
        .ok_or_else(|| anyhow::anyhow!("proxy path requires an active provider"))?;
    // Provenance: routing model comes from the active provider entry (ADR-073).
    let model = llm.effective_active_model().unwrap_or_default();

    let mut extra_env = std::collections::HashMap::new();
    match entry.kind {
        LlmProviderKind::AnthropicOauth | LlmProviderKind::AnthropicApiKey => {
            extra_env.extend(crate::defaults::anthropic_default_models_env());
            // Bare base URL: claude POSTs /v1/messages with a bare claude-* model,
            // which the forwarder routes to the anthropic passthrough by prefix.
            extra_env.insert(
                "ANTHROPIC_BASE_URL".to_string(),
                super::PROXY_BASE_URL.to_string(),
            );
            // Defense-in-depth after heal/quarantine: drop a foreign id from a
            // not-yet-healed config → account default, not 404.
            if crate::config::is_foreign_anthropic_model(&model) {
                log::warn!(
                    "llm: ignoring foreign model '{model}' under anthropic provider '{}' — using account default",
                    entry.id
                );
            } else if !model.is_empty() {
                extra_env.insert("ANTHROPIC_MODEL".to_string(), model.clone());
            }
        }
        LlmProviderKind::Local | LlmProviderKind::OpenRouter => {
            if model.is_empty() {
                anyhow::bail!(
                    "Provider '{}' requires a model name. \
                     Configure it in Settings → LLM Provider → Model.",
                    entry.id
                );
            }
            // `<id>/<model>` matches the per-provider wildcard route in the proxy config.
            let routed_model = if model.starts_with(&format!("{}/", entry.id)) {
                model.clone()
            } else {
                format!("{}/{}", entry.id, model)
            };
            extra_env.insert(
                "ANTHROPIC_BASE_URL".to_string(),
                super::PROXY_BASE_URL.to_string(),
            );
            // Dummy Bearer: disables OAuth and satisfies non-empty Authorization.
            extra_env.insert(
                "ANTHROPIC_AUTH_TOKEN".to_string(),
                "sk-no-key-required".to_string(),
            );
            // Remap every built-in alias to the routed id (ADR-073) so
            // `/model opus` etc. hit the wildcard route, not a bare claude-*.
            for key in [
                "ANTHROPIC_MODEL",
                "ANTHROPIC_DEFAULT_OPUS_MODEL",
                "ANTHROPIC_DEFAULT_SONNET_MODEL",
                "ANTHROPIC_DEFAULT_HAIKU_MODEL",
                "ANTHROPIC_DEFAULT_FABLE_MODEL",
                "ANTHROPIC_CUSTOM_MODEL_OPTION",
            ] {
                extra_env.insert(key.to_string(), routed_model.clone());
            }
            extra_env.extend([
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
            ]);
        }
    }
    extra_env.insert(
        "CLAUDE_CODE_ATTRIBUTION_HEADER".to_string(),
        "0".to_string(),
    );
    inject_claude_env(yaml, &extra_env)
}

/// Pre-ADR-073 direct-injection path, kept verbatim behind the
/// `proxy_enabled` kill-switch (see ADR-040/ADR-073).
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
            // Pins each ANTHROPIC_DEFAULT_*_MODEL alias to the SSOT-latest id with `[1m]` where supported.
            let mut extra_env = crate::defaults::anthropic_default_models_env();
            let model = llm.model.as_deref().map(str::trim).unwrap_or("");
            // Provenance guard (mirrors the proxy path): a foreign id falls
            // back to account default rather than 404 the API.
            if crate::config::is_foreign_anthropic_model(model) {
                log::warn!(
                    "llm: ignoring foreign model '{model}' on direct anthropic path — using account default"
                );
            } else if !model.is_empty() {
                extra_env.insert("ANTHROPIC_MODEL".to_string(), model.to_string());
            }
            inject_claude_env(yaml, &extra_env)
        }
        // All `LOCAL_PROVIDERS` (SSOT) share the same env injection.
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

            // Resolve Bearer auth token: per-project key file, else dummy.
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

            // Flatten `Name: Value` header lines to one comma-separated line; drop `Authorization`.
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
        // Unreachable: provider filtered by the early guard above.
        _ => unreachable!("provider validated by early guard"),
    }
}

/// Reads a local-LLM token file. Returns `None` on any failure (missing file,
/// I/O error, empty content); callers fall back to a dummy or skip injection.
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

/// Strips trailing `/v1` and slashes from a base URL; exposed so
/// `update_llm_config` normalizes save-time and render-time acceptance alike.
pub fn strip_trailing_v1(url: &str) -> String {
    let stripped = url.trim_end_matches('/');
    if let Some(without_v1) = stripped.strip_suffix("/v1") {
        without_v1.to_string()
    } else {
        stripped.to_string()
    }
}

/// Returns the default base URL for a known local model provider.
/// `"local"` defaults to the Ollama port.
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
/// credentials, query strings, fragments, and multi-segment paths.
pub fn validate_base_url(raw: &str) -> anyhow::Result<()> {
    // Reject `..` / `.` segments before url::Url parses, as it normalizes them away.
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
        // Allow only a single-segment path prefix.
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
