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
    // Gate (SSOT: LlmConfig::is_unconfigured) — never-touched, explicit logout, and dangling
    // active (entry missing) all refuse to start; logout gets distinct wording, checked first.
    if llm.is_logged_out() {
        anyhow::bail!(
            "No LLM provider selected. Run `speedwave login` to use your Anthropic \
             subscription, or choose a provider in Desktop Settings → LLM providers."
        );
    } else if llm.is_unconfigured() {
        anyhow::bail!(
            "No LLM provider configured for this project. Open Speedwave Desktop → \
             Settings → LLM providers to choose one."
        );
    }
    if llm.proxy_enabled.unwrap_or(true) {
        if let Some(entry) = llm.active_provider() {
            // Local custom headers are unsupported by the proxy — stay on direct path.
            let needs_direct = entry.kind == LlmProviderKind::Local && entry.has_custom_headers;
            if !needs_direct {
                let caller_token = super::proxy::ensure_caller_token_in(data_dir, project)?;
                return apply_llm_config_proxy(yaml, llm, &caller_token);
            }
            log::info!("custom headers configured — using the direct (non-proxy) path");
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
    }
    apply_llm_config_legacy_in(data_dir, yaml, llm, project)
}

/// ADR-073 proxy path: every session talks to the proxy service; the provider kind picks the
/// route/model prefix. `caller_token` authenticates `claude` so co-resident workers can't relay.
fn apply_llm_config_proxy(
    yaml: &str,
    llm: &LlmConfig,
    caller_token: &str,
) -> anyhow::Result<String> {
    let entry = llm
        .active_provider()
        .ok_or_else(|| anyhow::anyhow!("proxy path requires an active provider"))?;
    // Provenance: routing model comes from the active provider entry (ADR-073).
    let model = llm.effective_active_model().unwrap_or_default();

    let mut extra_env = std::collections::HashMap::new();
    // Caller secret to the proxy's /v1 auth middleware; the proxy strips it
    // (not in its outbound allow-list) so it never reaches the upstream.
    extra_env.insert(
        "ANTHROPIC_CUSTOM_HEADERS".to_string(),
        format!("{}: {caller_token}", super::proxy::PROXY_CALLER_AUTH_HEADER),
    );
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
                    "ignoring foreign model '{model}' under anthropic provider '{}' — using account default",
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
            let routed_model = crate::model_id::wire_model_id(entry.kind, &entry.id, &model);
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
            // Pins each ANTHROPIC_DEFAULT_*_MODEL to the SSOT-latest id, `[1m]` where supported.
            let mut extra_env = crate::defaults::anthropic_default_models_env();
            let model = llm.model.as_deref().map(str::trim).unwrap_or("");
            // Provenance guard (mirrors the proxy path): a foreign id falls
            // back to account default rather than 404 the API.
            if crate::config::is_foreign_anthropic_model(model) {
                log::warn!(
                    "ignoring foreign model '{model}' on direct anthropic path — using account default"
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

/// Rewrites a loopback host (SSOT: [`crate::url_validation::is_loopback_host`])
/// to `HOST_GATEWAY_ALIAS`; non-loopback hosts and bad input pass through.
pub fn canonicalize_local_base_url(url: &str) -> String {
    let Ok(mut parsed) = url::Url::parse(url) else {
        return url.to_string();
    };
    let is_loopback = parsed
        .host()
        .is_some_and(|h| crate::url_validation::is_loopback_host(&h));
    if !is_loopback {
        return url.to_string();
    }
    if parsed.set_host(Some(consts::HOST_GATEWAY_ALIAS)).is_err() {
        return url.to_string();
    }
    parsed.as_str().to_string()
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

/// Env keys `speedwave login` clears so Anthropic OAuth runs unshadowed by a
/// non-Anthropic provider. Excludes re-exported BASE_URL + cache-only ATTRIBUTION_HEADER.
pub fn anthropic_login_unset_keys() -> &'static [&'static str] {
    &[
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "ANTHROPIC_DEFAULT_FABLE_MODEL",
        "ANTHROPIC_CUSTOM_MODEL_OPTION",
        "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME",
        "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION",
        "ANTHROPIC_CUSTOM_HEADERS",
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
    ]
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

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "test assertions may unwrap/expect freely"
)]
mod tests {
    use super::*;

    #[test]
    fn login_unset_keys_cover_local_proxy_env() {
        // BASE_URL is re-exported by login; ATTRIBUTION_HEADER is OAuth-neutral
        // (prompt-cache only) — both deliberately stay off the unset list.
        const OAUTH_NEUTRAL: &[&str] = &["ANTHROPIC_BASE_URL", "CLAUDE_CODE_ATTRIBUTION_HEADER"];
        let cfg = crate::config::LlmConfig {
            providers: vec![crate::config::LlmProviderEntry {
                id: "local".into(),
                kind: crate::config::LlmProviderKind::Local,
                base_url: Some("http://host.docker.internal:1234".into()),
                model: Some("qwen".into()),
                has_api_key: false,
                context_tokens: None,
                has_custom_headers: false,
            }],
            active: Some(crate::config::LlmActive {
                provider_id: "local".into(),
                model: Some("qwen".into()),
            }),
            proxy_enabled: Some(true),
            ..Default::default()
        };
        let rendered = apply_llm_config_proxy(
            "services:\n  claude:\n    environment: []\n",
            &cfg,
            "test-caller-token",
        )
        .unwrap();
        let unset: std::collections::HashSet<&str> =
            anthropic_login_unset_keys().iter().copied().collect();
        for line in rendered.lines() {
            let t = line.trim().trim_start_matches('-').trim().trim_matches('"');
            if let Some((key, _)) = t.split_once('=') {
                let key = key.trim();
                if (key.starts_with("ANTHROPIC_") || key.starts_with("CLAUDE_CODE_"))
                    && !OAUTH_NEUTRAL.contains(&key)
                {
                    assert!(unset.contains(key), "login unset list is missing `{key}`");
                }
            }
        }
    }

    /// Pins the actual rendered `ANTHROPIC_MODEL` value through `wire_model_id`
    /// for both a nested-catalog OpenRouter id and a Local id.
    #[test]
    fn routed_model_env_pins_wire_model_id() {
        let cases = [
            (
                crate::config::LlmProviderKind::OpenRouter,
                "openrouter",
                "anthropic/claude-sonnet-5",
                "openrouter/anthropic/claude-sonnet-5",
            ),
            (
                crate::config::LlmProviderKind::Local,
                "local",
                "qwen2.5-coder",
                "local/qwen2.5-coder",
            ),
        ];
        for (kind, id, model, expected_wire) in cases {
            let cfg = crate::config::LlmConfig {
                providers: vec![crate::config::LlmProviderEntry {
                    id: id.into(),
                    kind,
                    base_url: Some("http://host.docker.internal:1234".into()),
                    model: Some(model.into()),
                    has_api_key: false,
                    context_tokens: None,
                    has_custom_headers: false,
                }],
                active: Some(crate::config::LlmActive {
                    provider_id: id.into(),
                    model: Some(model.into()),
                }),
                proxy_enabled: Some(true),
                ..Default::default()
            };
            let rendered = apply_llm_config_proxy(
                "services:\n  claude:\n    environment: []\n",
                &cfg,
                "test-caller-token",
            )
            .unwrap();
            let expected_line = format!("ANTHROPIC_MODEL={expected_wire}");
            assert!(
                rendered.contains(&expected_line),
                "id={id}: expected `{expected_line}` in rendered env: {rendered}"
            );
        }
    }

    fn emptied_v2(proxy_enabled: Option<bool>) -> crate::config::LlmConfig {
        crate::config::LlmConfig {
            schema_version: Some(crate::config::LLM_SCHEMA_VERSION),
            providers: vec![crate::config::LlmProviderEntry {
                id: "anthropic".into(),
                kind: crate::config::LlmProviderKind::AnthropicOauth,
                base_url: None,
                model: None,
                has_api_key: false,
                context_tokens: None,
                has_custom_headers: false,
            }],
            active: None,
            proxy_enabled,
            ..Default::default()
        }
    }

    #[test]
    fn logged_out_bails_on_both_proxy_modes() {
        let tmp = tempfile::tempdir().unwrap();
        for proxy in [Some(true), Some(false), None] {
            let err = apply_llm_config_in(tmp.path(), "services: {}", &emptied_v2(proxy), "proj")
                .unwrap_err()
                .to_string();
            assert!(
                err.contains("No LLM provider selected"),
                "proxy={proxy:?}: {err}"
            );
        }
    }

    #[test]
    fn dangling_active_bails_no_provider_configured() {
        // Dangling active (points at a missing entry) is unconfigured (SSOT gate): render must
        // refuse rather than silently fall back to Anthropic for a nonexistent provider id.
        let tmp = tempfile::tempdir().unwrap();
        for proxy in [Some(true), Some(false), None] {
            let llm = crate::config::LlmConfig {
                schema_version: Some(crate::config::LLM_SCHEMA_VERSION),
                providers: vec![],
                active: Some(crate::config::LlmActive {
                    provider_id: "ghost".into(),
                    model: None,
                }),
                proxy_enabled: proxy,
                ..Default::default()
            };
            let err = apply_llm_config_in(
                tmp.path(),
                "services:\n  claude:\n    environment: []\n",
                &llm,
                "proj",
            )
            .unwrap_err()
            .to_string();
            assert!(
                err.contains("No LLM provider configured"),
                "proxy={proxy:?}: {err}"
            );
        }
    }

    #[test]
    fn fresh_config_bails_no_provider_configured() {
        // Never-touched project (no llm override at all) must refuse to start
        // rather than silently default to Anthropic with no credentials.
        let tmp = tempfile::tempdir().unwrap();
        for proxy in [Some(true), Some(false), None] {
            let llm = crate::config::LlmConfig {
                proxy_enabled: proxy,
                ..Default::default()
            };
            let err = apply_llm_config_in(
                tmp.path(),
                "services:\n  claude:\n    environment: []\n",
                &llm,
                "proj",
            )
            .unwrap_err()
            .to_string();
            assert!(
                err.contains("No LLM provider configured"),
                "proxy={proxy:?}: {err}"
            );
        }
    }

    #[test]
    fn legacy_v1_config_with_provider_still_renders() {
        // A real legacy v1 config (provider explicitly set), migrated the way
        // every production caller does before render_compose, still renders.
        let tmp = tempfile::tempdir().unwrap();
        let mut llm = crate::config::LlmConfig {
            provider: Some("anthropic".to_string()),
            ..Default::default()
        };
        crate::config::migrate_llm(&mut llm, crate::config::AnthropicEvidence::None);
        let rendered = apply_llm_config_in(
            tmp.path(),
            "services:\n  claude:\n    environment: []\n",
            &llm,
            "proj",
        )
        .expect("legacy v1 config must render (anthropic default)");
        // No `{rendered}`: the proxy path injects the caller-auth token (cleartext-logging).
        assert!(rendered.contains("ANTHROPIC_"), "anthropic env injected");
    }

    #[test]
    fn unmigrated_legacy_v1_config_bails_until_migrated() {
        // Flip side of the above: render_compose requires migrate_llm to run first. A raw,
        // never-migrated flat `provider` has no resolvable active provider and must bail.
        let tmp = tempfile::tempdir().unwrap();
        let llm = crate::config::LlmConfig {
            provider: Some("anthropic".to_string()),
            ..Default::default()
        };
        let err = apply_llm_config_in(
            tmp.path(),
            "services:\n  claude:\n    environment: []\n",
            &llm,
            "proj",
        )
        .unwrap_err()
        .to_string();
        assert!(
            err.contains("No LLM provider configured"),
            "unmigrated legacy config must bail until migrate_llm runs: {err}"
        );
    }

    /// Defense-in-depth: this shape is unreachable in production since
    /// `migrate_llm` always normalises `provider` first.
    #[test]
    fn legacy_in_rejects_unsupported_provider() {
        let tmp = tempfile::tempdir().unwrap();
        let llm = crate::config::LlmConfig {
            provider: Some("openrouter".to_string()),
            model: Some("some-model".to_string()),
            base_url: Some("http://host.docker.internal:9999".to_string()),
            ..Default::default()
        };
        let err = apply_llm_config_legacy_in(
            tmp.path(),
            "services:\n  claude:\n    environment: []\n",
            &llm,
            "proj",
        )
        .unwrap_err()
        .to_string();
        assert!(
            err.contains("Unsupported LLM provider") && err.contains("openrouter"),
            "Error must mention unsupported provider, got: {err}"
        );
    }

    #[test]
    fn legacy_in_rejects_custom_provider_after_removal() {
        // Regression guard: provider="custom" removed end-to-end; falls
        // through to the unknown-provider path, not its own bespoke error.
        let tmp = tempfile::tempdir().unwrap();
        let llm = crate::config::LlmConfig {
            provider: Some("custom".to_string()),
            model: Some("my-model".to_string()),
            base_url: Some("http://host.docker.internal:9999".to_string()),
            ..Default::default()
        };
        let err = apply_llm_config_legacy_in(
            tmp.path(),
            "services:\n  claude:\n    environment: []\n",
            &llm,
            "proj",
        )
        .unwrap_err()
        .to_string();
        assert!(
            err.contains("Unsupported LLM provider") && err.contains("custom"),
            "Error must treat 'custom' as unsupported, got: {err}"
        );
        assert!(
            !err.contains("Custom provider requires a base_url"),
            "The legacy 'custom requires base_url' error must be gone, got: {err}"
        );
    }

    /// Bypasses `migrate_llm` to exercise the legacy per-alias default port,
    /// which a migrated config would never hit.
    #[test]
    fn legacy_in_lmstudio_uses_its_own_default_port() {
        let tmp = tempfile::tempdir().unwrap();
        let llm = crate::config::LlmConfig {
            provider: Some("lmstudio".to_string()),
            model: Some("qwen2.5-coder".to_string()),
            ..Default::default()
        };
        let rendered = apply_llm_config_legacy_in(
            tmp.path(),
            "services:\n  claude:\n    environment: []\n",
            &llm,
            "proj",
        )
        .unwrap();
        let expected = format!(
            "ANTHROPIC_BASE_URL={}",
            default_base_url("lmstudio").unwrap()
        );
        assert!(
            rendered.contains(&expected),
            "LM Studio must set {expected}, got: {rendered}"
        );
    }

    #[test]
    fn legacy_in_llamacpp_uses_its_own_default_port() {
        let tmp = tempfile::tempdir().unwrap();
        let llm = crate::config::LlmConfig {
            provider: Some("llamacpp".to_string()),
            model: Some("deepseek-r1".to_string()),
            ..Default::default()
        };
        let rendered = apply_llm_config_legacy_in(
            tmp.path(),
            "services:\n  claude:\n    environment: []\n",
            &llm,
            "proj",
        )
        .unwrap();
        let expected = format!(
            "ANTHROPIC_BASE_URL={}",
            default_base_url("llamacpp").unwrap()
        );
        assert!(
            rendered.contains(&expected),
            "llama.cpp must set {expected}, got: {rendered}"
        );
    }

    /// The per-alias display label (llama.cpp/LM Studio) is v1-only too:
    /// post-migration it collapses to the generic "Local" label.
    #[test]
    fn legacy_in_llamacpp_uses_its_own_display_label() {
        let tmp = tempfile::tempdir().unwrap();
        let llm = crate::config::LlmConfig {
            provider: Some("llamacpp".to_string()),
            model: Some("deepseek-r1".to_string()),
            ..Default::default()
        };
        let rendered = apply_llm_config_legacy_in(
            tmp.path(),
            "services:\n  claude:\n    environment: []\n",
            &llm,
            "proj",
        )
        .unwrap();
        assert!(
            rendered.contains("ANTHROPIC_CUSTOM_MODEL_OPTION_NAME=deepseek-r1 (llama.cpp)"),
            "llamacpp display name must use 'llama.cpp' label, got: {rendered}"
        );
    }

    #[test]
    fn legacy_in_lmstudio_uses_its_own_display_label() {
        let tmp = tempfile::tempdir().unwrap();
        let llm = crate::config::LlmConfig {
            provider: Some("lmstudio".to_string()),
            model: Some("qwen2.5-coder".to_string()),
            ..Default::default()
        };
        let rendered = apply_llm_config_legacy_in(
            tmp.path(),
            "services:\n  claude:\n    environment: []\n",
            &llm,
            "proj",
        )
        .unwrap();
        assert!(
            rendered.contains("ANTHROPIC_CUSTOM_MODEL_OPTION_NAME=qwen2.5-coder (LM Studio)"),
            "lmstudio display name must use 'LM Studio' label, got: {rendered}"
        );
    }

    #[test]
    fn legacy_in_ollama_uses_its_own_display_label() {
        let tmp = tempfile::tempdir().unwrap();
        let llm = crate::config::LlmConfig {
            provider: Some("ollama".to_string()),
            model: Some("llama3.3".to_string()),
            ..Default::default()
        };
        let rendered = apply_llm_config_legacy_in(
            tmp.path(),
            "services:\n  claude:\n    environment: []\n",
            &llm,
            "proj",
        )
        .unwrap();
        assert!(
            rendered.contains("ANTHROPIC_CUSTOM_MODEL_OPTION_NAME=llama3.3 (Ollama)"),
            "ollama display name must use 'Ollama' label, got: {rendered}"
        );
    }
}
