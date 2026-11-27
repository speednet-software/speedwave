use super::inject_claude_env;
use crate::config::{LlmConfig, LlmProviderKind};
use crate::consts;
use crate::secret_store::{SecretName, SecretStore, SecretStoreError};
use std::path::Path;

const NO_KEY_REQUIRED_TOKEN: &str = "sk-no-key-required";

pub(super) struct ClaudeLlmEnv {
    pub(super) plain: std::collections::HashMap<String, String>,
    pub(super) auth_token: Option<String>,
    pub(super) custom_headers: Option<String>,
    pub(super) proxied: bool,
}

pub(crate) fn apply_llm_config_in(
    data_dir: &Path,
    yaml: &str,
    llm: &LlmConfig,
    project: &str,
) -> anyhow::Result<String> {
    inject_claude_env(yaml, &claude_llm_env_in(data_dir, llm, project)?.plain)
}

pub(super) fn anthropic_provider_active(llm: &LlmConfig) -> bool {
    match llm.active_provider() {
        Some(entry) => entry.kind.is_anthropic(),
        None => llm.provider.as_deref().unwrap_or("anthropic") == "anthropic",
    }
}

pub(super) fn anthropic_api_key_in(
    data_dir: &Path,
    project: &str,
) -> anyhow::Result<Option<String>> {
    let name = SecretName::anthropic_api_key(project)?;
    let Some(value) = read_secret_in(data_dir, &name)? else {
        return Ok(None);
    };
    let api_key = value.trim().to_string();
    Ok((!api_key.is_empty()).then_some(api_key))
}

fn read_secret_in(data_dir: &Path, name: &SecretName) -> anyhow::Result<Option<String>> {
    match SecretStore::open(data_dir)?.read(name) {
        Ok(value) => Ok(value.map(|value| value.to_string())),
        Err(SecretStoreError::Unreadable(unreadable)) => {
            log::warn!("secret {unreadable} cannot be read; the integration is started without it");
            Ok(None)
        }
        Err(e) => Err(e.into()),
    }
}

pub(super) fn claude_llm_env_in(
    data_dir: &Path,
    llm: &LlmConfig,
    project: &str,
) -> anyhow::Result<ClaudeLlmEnv> {
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
            let needs_direct = entry.kind == LlmProviderKind::Local && entry.has_custom_headers;
            if !needs_direct {
                return proxy_llm_env(llm);
            }
            log::info!("custom headers configured — using the direct (non-proxy) path");
        }
    } else if let Some(entry) = llm.active_provider() {
        if matches!(entry.kind, LlmProviderKind::OpenRouter) {
            anyhow::bail!(
                "Provider '{}' requires the LLM proxy. Re-enable it (unset proxy_enabled=false) \
                 to use OpenRouter.",
                entry.id
            );
        }
    }
    legacy_llm_env_in(data_dir, llm, project)
}

fn proxy_llm_env(llm: &LlmConfig) -> anyhow::Result<ClaudeLlmEnv> {
    let entry = llm
        .active_provider()
        .ok_or_else(|| anyhow::anyhow!("proxy path requires an active provider"))?;
    let model = llm.effective_active_model().unwrap_or_default();

    let mut extra_env = std::collections::HashMap::new();
    let mut auth_token = None;
    match entry.kind {
        LlmProviderKind::AnthropicOauth | LlmProviderKind::AnthropicApiKey => {
            extra_env.extend(crate::defaults::anthropic_default_models_env());
            extra_env.insert(
                "ANTHROPIC_BASE_URL".to_string(),
                super::PROXY_BASE_URL.to_string(),
            );
        }
        LlmProviderKind::Local | LlmProviderKind::OpenRouter => {
            if model.is_empty() {
                anyhow::bail!(
                    "Provider '{}' requires a model name. \
                     Configure it in Settings → LLM Provider → Model.",
                    entry.id
                );
            }
            let routed_model = crate::model_id::wire_model_id(entry.kind, &entry.id, &model);
            extra_env.insert(
                "ANTHROPIC_BASE_URL".to_string(),
                super::PROXY_BASE_URL.to_string(),
            );
            auth_token = Some(NO_KEY_REQUIRED_TOKEN.to_string());
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
                    consts::CLAUDE_DISABLE_NONESSENTIAL_TRAFFIC_ENV.to_string(),
                    "1".to_string(),
                ),
            ]);
            match entry.context_tokens {
                Some(window) => extra_env.insert(
                    "CLAUDE_CODE_MAX_CONTEXT_TOKENS".to_string(),
                    window.to_string(),
                ),
                None => extra_env.insert(
                    "CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT".to_string(),
                    "1".to_string(),
                ),
            };
        }
    }
    if !keeps_attribution_block(entry.kind, &model) {
        extra_env.insert(ATTRIBUTION_HEADER_ENV.to_string(), "0".to_string());
    }
    Ok(ClaudeLlmEnv {
        plain: extra_env,
        auth_token,
        custom_headers: None,
        proxied: true,
    })
}

pub(crate) const ATTRIBUTION_HEADER_ENV: &str = "CLAUDE_CODE_ATTRIBUTION_HEADER";

fn keeps_attribution_block(kind: LlmProviderKind, model: &str) -> bool {
    match kind {
        LlmProviderKind::AnthropicApiKey => true,
        LlmProviderKind::Local => model
            .rsplit('/')
            .next()
            .is_some_and(|name| name.to_ascii_lowercase().starts_with("claude-")),
        LlmProviderKind::AnthropicOauth | LlmProviderKind::OpenRouter => false,
    }
}

fn legacy_llm_env_in(
    data_dir: &Path,
    llm: &LlmConfig,
    project: &str,
) -> anyhow::Result<ClaudeLlmEnv> {
    let provider = llm.provider.as_deref().unwrap_or("anthropic");
    if !crate::config::LOCAL_PROVIDERS.contains(&provider) && provider != "anthropic" {
        anyhow::bail!(
            "Unsupported LLM provider '{provider}'. Supported: anthropic, {}.",
            crate::config::LOCAL_PROVIDERS.join(", ")
        );
    }
    match provider {
        "anthropic" => Ok(ClaudeLlmEnv {
            plain: crate::defaults::anthropic_default_models_env(),
            auth_token: None,
            custom_headers: None,
            proxied: false,
        }),
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

            let auth_token = if llm.has_api_key {
                read_local_llm_token_opt_in(data_dir, project, "api_key").unwrap_or_else(|| {
                    log::warn!("local-llm api_key flagged but unreadable — using dummy");
                    NO_KEY_REQUIRED_TOKEN.to_string()
                })
            } else {
                NO_KEY_REQUIRED_TOKEN.to_string()
            };

            let mut extra_env = std::collections::HashMap::from([
                ("ANTHROPIC_BASE_URL".to_string(), base_url),
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
                    consts::CLAUDE_DISABLE_NONESSENTIAL_TRAFFIC_ENV.to_string(),
                    "1".to_string(),
                ),
            ]);
            if !keeps_attribution_block(LlmProviderKind::Local, model) {
                extra_env.insert(ATTRIBUTION_HEADER_ENV.to_string(), "0".to_string());
            }

            let mut custom_headers = None;
            if llm.has_custom_headers {
                if let Some(headers) =
                    read_local_llm_token_opt_in(data_dir, project, "custom_headers")
                {
                    let flattened = headers
                        .lines()
                        .map(str::trim)
                        .filter(|line| !line.is_empty())
                        .filter(|line| {
                            !line
                                .split_once(':')
                                .map(|(name, _)| name.trim().eq_ignore_ascii_case("authorization"))
                                .unwrap_or(false)
                        })
                        .collect::<Vec<_>>()
                        .join(", ");
                    if !flattened.is_empty() {
                        custom_headers = Some(flattened);
                    }
                }
            }

            Ok(ClaudeLlmEnv {
                plain: extra_env,
                auth_token: Some(auth_token),
                custom_headers,
                proxied: false,
            })
        }
        _ => unreachable!("provider validated by early guard"),
    }
}

/// Reads a local-LLM secret (`api_key` or `custom_headers`) from the secret store.
pub fn read_local_llm_token_opt_in(data_dir: &Path, project: &str, file: &str) -> Option<String> {
    let name = match file {
        "api_key" => SecretName::local_llm_api_key(project),
        "custom_headers" => SecretName::local_llm_custom_headers(project),
        _ => return None,
    }
    .ok()?;
    let value = read_secret_in(data_dir, &name).ok()??;
    let trimmed = value.trim_end_matches(['\n', '\r']).to_string();
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
/// non-Anthropic provider. Excludes re-exported BASE_URL + ATTRIBUTION_HEADER, which the OAuth proxy path keeps at `0`.
pub fn anthropic_login_unset_keys() -> &'static [&'static str] {
    &[
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_MODEL",
        "ANTHROPIC_DEFAULT_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "ANTHROPIC_DEFAULT_FABLE_MODEL",
        "ANTHROPIC_CUSTOM_MODEL_OPTION",
        "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME",
        "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION",
        "ANTHROPIC_CUSTOM_HEADERS",
        consts::CLAUDE_DISABLE_NONESSENTIAL_TRAFFIC_ENV,
        "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
        "CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT",
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

    fn rendered_proxy_env(yaml: &str, llm: &crate::config::LlmConfig) -> anyhow::Result<String> {
        inject_claude_env(yaml, &proxy_llm_env(llm)?.plain)
    }

    fn rendered_legacy_env(
        data_dir: &Path,
        yaml: &str,
        llm: &crate::config::LlmConfig,
        project: &str,
    ) -> anyhow::Result<String> {
        inject_claude_env(yaml, &legacy_llm_env_in(data_dir, llm, project)?.plain)
    }

    fn proxy_cfg(
        id: &str,
        kind: crate::config::LlmProviderKind,
        base_url: Option<&str>,
        model: &str,
    ) -> crate::config::LlmConfig {
        crate::config::LlmConfig {
            providers: vec![crate::config::LlmProviderEntry {
                id: id.into(),
                kind,
                base_url: base_url.map(Into::into),
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
        }
    }

    #[test]
    fn login_unset_keys_cover_local_and_anthropic_proxy_env() {
        const OAUTH_NEUTRAL: &[&str] = &["ANTHROPIC_BASE_URL", "CLAUDE_CODE_ATTRIBUTION_HEADER"];
        let unset: std::collections::HashSet<&str> =
            anthropic_login_unset_keys().iter().copied().collect();
        for cfg in [
            proxy_cfg(
                "local",
                crate::config::LlmProviderKind::Local,
                Some("http://host.docker.internal:1234"),
                "qwen",
            ),
            proxy_cfg(
                "anthropic",
                crate::config::LlmProviderKind::AnthropicOauth,
                None,
                "claude-sonnet-4-6",
            ),
        ] {
            let rendered = rendered_proxy_env(CLAUDE_ENV_YAML, &cfg).unwrap();
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
    }

    fn routed_cfg(
        kind: crate::config::LlmProviderKind,
        context_tokens: Option<u32>,
    ) -> crate::config::LlmConfig {
        let mut cfg = proxy_cfg(
            "litellm",
            kind,
            Some("http://host.docker.internal:4000"),
            "qwen3-coder-30b",
        );
        cfg.providers[0].context_tokens = context_tokens;
        cfg
    }

    const CLAUDE_ENV_YAML: &str = "services:\n  claude:\n    environment: []\n";

    #[test]
    fn routed_provider_with_known_window_pins_max_context_tokens() {
        for kind in [
            crate::config::LlmProviderKind::Local,
            crate::config::LlmProviderKind::OpenRouter,
        ] {
            let rendered =
                rendered_proxy_env(CLAUDE_ENV_YAML, &routed_cfg(kind, Some(131_072))).unwrap();
            assert!(
                rendered.contains("CLAUDE_CODE_MAX_CONTEXT_TOKENS=131072"),
                "{kind:?}: probed window must reach CC: {rendered}"
            );
            assert!(
                !rendered.contains("CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT"),
                "{kind:?}: a known window must not also disable enforcement"
            );
        }
    }

    #[test]
    fn routed_provider_without_window_disables_unknown_model_enforcement() {
        let rendered = rendered_proxy_env(
            CLAUDE_ENV_YAML,
            &routed_cfg(crate::config::LlmProviderKind::Local, None),
        )
        .unwrap();
        assert!(
            rendered.contains("CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=1"),
            "missing enforcement kill-switch: {rendered}"
        );
        assert!(
            !rendered.contains("CLAUDE_CODE_MAX_CONTEXT_TOKENS"),
            "no window value may be invented: {rendered}"
        );
    }

    #[test]
    fn anthropic_provider_injects_no_window_env() {
        let cfg = crate::config::LlmConfig {
            providers: vec![crate::config::LlmProviderEntry {
                id: "anthropic".into(),
                kind: crate::config::LlmProviderKind::AnthropicOauth,
                base_url: None,
                model: Some("claude-sonnet-5".into()),
                has_api_key: false,
                context_tokens: Some(1_000_000),
                has_custom_headers: false,
            }],
            active: Some(crate::config::LlmActive {
                provider_id: "anthropic".into(),
                model: Some("claude-sonnet-5".into()),
            }),
            proxy_enabled: Some(true),
            ..Default::default()
        };
        let rendered = rendered_proxy_env(CLAUDE_ENV_YAML, &cfg).unwrap();
        assert!(!rendered.contains("CLAUDE_CODE_MAX_CONTEXT_TOKENS"));
        assert!(!rendered.contains("CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT"));
    }

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
            let rendered =
                rendered_proxy_env("services:\n  claude:\n    environment: []\n", &cfg).unwrap();
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
        assert!(rendered.contains("ANTHROPIC_"), "anthropic env injected");
    }

    #[test]
    fn unmigrated_legacy_v1_config_bails_until_migrated() {
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

    #[test]
    fn legacy_in_rejects_unsupported_provider() {
        let tmp = tempfile::tempdir().unwrap();
        let llm = crate::config::LlmConfig {
            provider: Some("openrouter".to_string()),
            model: Some("some-model".to_string()),
            base_url: Some("http://host.docker.internal:9999".to_string()),
            ..Default::default()
        };
        let err = rendered_legacy_env(
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
        let tmp = tempfile::tempdir().unwrap();
        let llm = crate::config::LlmConfig {
            provider: Some("custom".to_string()),
            model: Some("my-model".to_string()),
            base_url: Some("http://host.docker.internal:9999".to_string()),
            ..Default::default()
        };
        let err = rendered_legacy_env(
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

    #[test]
    fn legacy_in_lmstudio_uses_its_own_default_port() {
        let tmp = tempfile::tempdir().unwrap();
        let llm = crate::config::LlmConfig {
            provider: Some("lmstudio".to_string()),
            model: Some("qwen2.5-coder".to_string()),
            ..Default::default()
        };
        let rendered = rendered_legacy_env(
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
        let rendered = rendered_legacy_env(
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

    #[test]
    fn legacy_in_llamacpp_uses_its_own_display_label() {
        let tmp = tempfile::tempdir().unwrap();
        let llm = crate::config::LlmConfig {
            provider: Some("llamacpp".to_string()),
            model: Some("deepseek-r1".to_string()),
            ..Default::default()
        };
        let rendered = rendered_legacy_env(
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
        let rendered = rendered_legacy_env(
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
        let rendered = rendered_legacy_env(
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

    #[test]
    fn attribution_block_stays_on_only_for_claude_billed_by_api_key() {
        use crate::config::LlmProviderKind::{AnthropicApiKey, AnthropicOauth, Local, OpenRouter};
        let litellm = Some("http://host.docker.internal:4000");
        let cases = [
            (Local, litellm, "claude-opus-5-5", false),
            (Local, litellm, "claude-haiku-5-5", false),
            (Local, litellm, "anthropic/claude-opus-5-5", false),
            (Local, litellm, "prov/claude-opus-5-5", false),
            (Local, litellm, "Claude-Sonnet-5", false),
            (Local, litellm, "qwen3.6-35b-a3b", true),
            (Local, litellm, "my-claude-finetune", true),
            (Local, litellm, "claude-finetunes/qwen3", true),
            (OpenRouter, None, "anthropic/claude-opus-5-5", true),
            (OpenRouter, None, "qwen/qwen3-coder", true),
            (AnthropicApiKey, None, "claude-opus-5-5", false),
            (AnthropicOauth, None, "claude-opus-5-5", true),
        ];
        for (kind, base_url, model, disabled) in cases {
            let rendered =
                rendered_proxy_env(CLAUDE_ENV_YAML, &proxy_cfg("prov", kind, base_url, model))
                    .unwrap();
            assert_eq!(
                rendered.contains("CLAUDE_CODE_ATTRIBUTION_HEADER=0"),
                disabled,
                "{kind:?} with {model}: {rendered}"
            );
        }
    }

    #[test]
    fn direct_local_path_keeps_the_attribution_block_only_for_claude_models() {
        let tmp = tempfile::tempdir().unwrap();
        for (model, disabled) in [("claude-opus-5-5", false), ("qwen3.6-35b-a3b", true)] {
            let llm = crate::config::LlmConfig {
                provider: Some("local".to_string()),
                base_url: Some("http://host.docker.internal:4000".to_string()),
                model: Some(model.to_string()),
                ..Default::default()
            };
            let rendered = rendered_legacy_env(tmp.path(), CLAUDE_ENV_YAML, &llm, "proj").unwrap();
            assert_eq!(
                rendered.contains("CLAUDE_CODE_ATTRIBUTION_HEADER=0"),
                disabled,
                "{model}: {rendered}"
            );
        }
    }

    fn store_anthropic_key(data_dir: &Path, value: &str) {
        SecretStore::open(data_dir)
            .unwrap()
            .write(&SecretName::anthropic_api_key("proj").unwrap(), value)
            .unwrap();
    }

    #[test]
    fn anthropic_api_key_is_read_from_the_store_and_trimmed() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(anthropic_api_key_in(dir.path(), "proj").unwrap(), None);

        store_anthropic_key(dir.path(), "  sk-ant-1\n");

        assert_eq!(
            anthropic_api_key_in(dir.path(), "proj").unwrap().as_deref(),
            Some("sk-ant-1")
        );
        assert_eq!(anthropic_api_key_in(dir.path(), "other").unwrap(), None);
    }

    #[test]
    fn a_plaintext_anthropic_key_file_is_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let legacy = dir.path().join("secrets").join("proj");
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(legacy.join("anthropic_api_key"), "sk-plaintext").unwrap();

        assert_eq!(anthropic_api_key_in(dir.path(), "proj").unwrap(), None);
    }

    #[test]
    fn an_unreadable_anthropic_key_degrades_to_none() {
        let dir = tempfile::tempdir().unwrap();
        store_anthropic_key(dir.path(), "sk-ant-1");
        std::fs::write(
            dir.path().join("secrets/proj/anthropic.api_key.enc"),
            "garbage\n",
        )
        .unwrap();

        assert_eq!(anthropic_api_key_in(dir.path(), "proj").unwrap(), None);
    }

    #[test]
    fn a_missing_install_key_is_an_error_not_a_silent_none() {
        let dir = tempfile::tempdir().unwrap();
        store_anthropic_key(dir.path(), "sk-ant-1");
        std::fs::remove_file(dir.path().join("secret-store.key")).unwrap();

        assert!(anthropic_api_key_in(dir.path(), "proj").is_err());
    }

    #[test]
    fn the_direct_local_path_reads_its_token_and_headers_from_the_store() {
        let dir = tempfile::tempdir().unwrap();
        let store = SecretStore::open(dir.path()).unwrap();
        store
            .write(&SecretName::local_llm_api_key("proj").unwrap(), "sk-local")
            .unwrap();
        store
            .write(
                &SecretName::local_llm_custom_headers("proj").unwrap(),
                "X-A: 1\nAuthorization: Bearer leaked\nX-B: 2\n",
            )
            .unwrap();
        let llm = crate::config::LlmConfig {
            provider: Some("local".to_string()),
            model: Some("qwen3".to_string()),
            base_url: Some("http://host.docker.internal:9000".to_string()),
            has_api_key: true,
            has_custom_headers: true,
            ..Default::default()
        };

        let env = legacy_llm_env_in(dir.path(), &llm, "proj").unwrap();

        assert_eq!(env.auth_token.as_deref(), Some("sk-local"));
        assert_eq!(env.custom_headers.as_deref(), Some("X-A: 1, X-B: 2"));
    }

    #[test]
    fn the_direct_local_path_falls_back_to_the_dummy_token_when_the_key_cannot_be_read() {
        let dir = tempfile::tempdir().unwrap();
        SecretStore::open(dir.path())
            .unwrap()
            .write(&SecretName::local_llm_api_key("proj").unwrap(), "sk-local")
            .unwrap();
        std::fs::write(
            dir.path().join("secrets/proj/local-llm.api_key.enc"),
            "garbage\n",
        )
        .unwrap();
        let llm = crate::config::LlmConfig {
            provider: Some("local".to_string()),
            model: Some("qwen3".to_string()),
            base_url: Some("http://host.docker.internal:9000".to_string()),
            has_api_key: true,
            ..Default::default()
        };

        let env = legacy_llm_env_in(dir.path(), &llm, "proj").unwrap();

        assert_eq!(env.auth_token.as_deref(), Some(NO_KEY_REQUIRED_TOKEN));
    }
}
