use crate::config::{
    GitRepositoryLists, LlmConfig, LlmProviderKind, ResolvedClaudeConfig,
    ResolvedIntegrationsConfig,
};
use crate::git_allowlist::{enforced_entries, forge_host_in, GitForgeService};
use crate::secret_store::{SecretName, SecretStore};
use serde::Serialize;
use speedwave_access_policy::{AccessMode, AccessPolicy};
use std::path::Path;

#[derive(Serialize)]
#[serde(untagged)]
enum RouteAuth {
    Bare(&'static str),
    Swap {
        swap_env: String,
        scheme: &'static str,
    },
}

#[derive(Serialize)]
struct RenderRoute {
    prefix: String,
    base_url: String,
    auth: RouteAuth,
    provider_kind: &'static str,
    provider_id: String,
}

#[derive(Serialize)]
struct RenderConfig<'a> {
    routes: Vec<RenderRoute>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ner: Option<&'a super::pii_ner::NerRenderConfig>,
    #[serde(skip_serializing_if = "<[GitForge]>::is_empty")]
    git_forges: &'a [GitForge],
}

/// Port the proxy container listens on (fixed in the forwarder binary).
pub const PROXY_PORT: u16 = 4000;

/// In-network proxy URL every session points `ANTHROPIC_BASE_URL` at; routing
/// is by the request body's model prefix, not the URL path.
pub const PROXY_BASE_URL: &str = "http://proxy:4000";

const GIT_TOKENS_MOUNT_ROOT: &str = "/git-tokens";

impl GitForgeService {
    pub(super) fn token_mount_target(self) -> String {
        format!("{GIT_TOKENS_MOUNT_ROOT}/{}", self.config_key())
    }

    fn login(self) -> &'static str {
        match self {
            Self::Github => "x-access-token",
            Self::Gitlab => "oauth2",
        }
    }

    fn token_file(self) -> String {
        format!("{}/token", self.token_mount_target())
    }
}

#[derive(Serialize)]
pub(super) struct GitForge {
    #[serde(skip)]
    pub(super) kind: GitForgeService,
    pub(super) host: String,
    base_url: String,
    login: &'static str,
    token_file: String,
    repositories: Vec<String>,
    #[serde(skip_serializing_if = "AccessMode::is_full")]
    access: AccessMode,
}

impl GitForge {
    fn new(
        kind: GitForgeService,
        host: String,
        repositories: Vec<String>,
        access: AccessMode,
    ) -> Self {
        Self {
            kind,
            base_url: format!("https://{host}"),
            host,
            login: kind.login(),
            token_file: kind.token_file(),
            repositories,
            access,
        }
    }
}

pub(super) struct RenderedProxyConfig {
    pub(super) content: String,
    pub(super) ner_url: Option<String>,
}

pub(super) struct ProjectProxyConfig {
    pub(super) git_forges: Vec<GitForge>,
    pub(super) config: RenderedProxyConfig,
}

pub(super) fn project_proxy_config_in(
    data_dir: &Path,
    project: &str,
    resolved_config: &ResolvedClaudeConfig,
    integrations: &ResolvedIntegrationsConfig,
) -> anyhow::Result<ProjectProxyConfig> {
    let git_forges = git_forges_in(
        data_dir,
        project,
        integrations,
        &resolved_config.git_repositories,
        &resolved_config.access,
    );
    let config = render_proxy_config_in(
        data_dir,
        project,
        &resolved_config.llm,
        resolved_config.pii_ner_enabled,
        &git_forges,
    )?;
    Ok(ProjectProxyConfig { git_forges, config })
}

pub(crate) fn enabled_git_forge_kinds_in(
    data_dir: &Path,
    project: &str,
    integrations: &ResolvedIntegrationsConfig,
    repositories: &GitRepositoryLists,
    access: &AccessPolicy,
) -> Vec<GitForgeService> {
    git_forges_in(data_dir, project, integrations, repositories, access)
        .into_iter()
        .map(|forge| forge.kind)
        .collect()
}

pub(super) fn git_forges_in(
    data_dir: &Path,
    project: &str,
    integrations: &ResolvedIntegrationsConfig,
    repositories: &GitRepositoryLists,
    access: &AccessPolicy,
) -> Vec<GitForge> {
    let mut forges = Vec::new();
    for service in GitForgeService::ALL {
        if integrations.is_service_enabled(service.config_key()) != Some(true) {
            continue;
        }
        let Some(host) = forge_host_in(data_dir, project, service) else {
            continue;
        };
        let (allowed, rejected) = enforced_entries(repositories.of(service), &host);
        for index in rejected {
            log::warn!(
                "{} repository entry {index} is not valid for {host} and is not passed to the proxy",
                service.config_key()
            );
        }
        forges.push(GitForge::new(
            service,
            host,
            allowed,
            access.mode_of(service.config_key()),
        ));
    }
    forges.sort_by(|a, b| a.host.cmp(&b.host));
    forges
}

/// `SPW_KEY_<ID>` env name (hyphens → underscores, uppercased — like
/// `plugin::derive_worker_env`). SSOT inverse: `containers/proxy/src/keys.rs::provider_id_from_env_name`.
pub fn spw_key_env_name(provider_id: &str) -> String {
    format!(
        "SPW_KEY_{}",
        provider_id.to_ascii_uppercase().replace('-', "_")
    )
}

/// Header carrying the per-project caller secret; mirror of the proxy's
/// `CALLER_AUTH_HEADER` in `containers/proxy/src/main.rs`.
pub const PROXY_CALLER_AUTH_HEADER: &str = "x-speedwave-proxy-auth";

pub(super) fn caller_header_value(caller_token: &str) -> String {
    format!("{PROXY_CALLER_AUTH_HEADER}: {caller_token}")
}

/// Renders the proxy routing config (a `routes` array consumed by the forwarder
/// `containers/proxy/src/router.rs`). Pure.
pub fn render_proxy_config(llm: &LlmConfig) -> String {
    render_proxy_config_full(llm, None, &[])
}

/// [`render_proxy_config`] plus the optional `ner` section pointing the proxy at the
/// live host-side detector (ADR-096).
pub(crate) fn render_proxy_config_full(
    llm: &LlmConfig,
    ner: Option<&super::pii_ner::NerRenderConfig>,
    git_forges: &[GitForge],
) -> String {
    let mut routes = Vec::new();

    let anthropic_kind = match llm.active_provider().map(|p| p.kind) {
        Some(LlmProviderKind::AnthropicApiKey) => LlmProviderKind::AnthropicApiKey.wire_str(),
        _ => LlmProviderKind::AnthropicOauth.wire_str(),
    };

    routes.push(RenderRoute {
        prefix: "anthropic".into(),
        base_url: "https://api.anthropic.com".into(),
        auth: RouteAuth::Bare("passthrough"),
        provider_kind: anthropic_kind,
        provider_id: "anthropic".into(),
    });

    for entry in &llm.providers {
        if !crate::plugin::is_valid_slug(&entry.id) {
            log::warn!("skipping provider with invalid id");
            continue;
        }
        match entry.kind {
            LlmProviderKind::AnthropicOauth | LlmProviderKind::AnthropicApiKey => {}
            LlmProviderKind::OpenRouter => {
                routes.push(RenderRoute {
                    prefix: entry.id.clone(),
                    base_url: "https://openrouter.ai/api".into(),
                    auth: RouteAuth::Swap {
                        swap_env: spw_key_env_name(&entry.id),
                        scheme: "bearer",
                    },
                    provider_kind: "openrouter",
                    provider_id: entry.id.clone(),
                });
            }
            LlmProviderKind::Local => {
                let Some(base_url) = entry.base_url.as_deref() else {
                    log::warn!("provider '{}' has no base_url — skipped", entry.id);
                    continue;
                };
                let base_url = super::llm::strip_trailing_v1(base_url);
                if let Err(e) = super::llm::validate_base_url(&base_url) {
                    log::warn!(
                        "provider '{}' has invalid base_url — skipped: {e}",
                        entry.id
                    );
                    continue;
                }
                let auth = if entry.has_api_key {
                    RouteAuth::Swap {
                        swap_env: spw_key_env_name(&entry.id),
                        scheme: "bearer",
                    }
                } else {
                    RouteAuth::Bare("none")
                };
                routes.push(RenderRoute {
                    prefix: entry.id.clone(),
                    base_url,
                    auth,
                    provider_kind: "local",
                    provider_id: entry.id.clone(),
                });
            }
        }
    }

    serde_json::to_string(&RenderConfig {
        routes,
        ner,
        git_forges,
    })
    .unwrap_or_else(|_| r#"{"routes":[]}"#.into())
}

fn render_proxy_config_in(
    data_dir: &Path,
    project: &str,
    llm: &LlmConfig,
    pii_ner_enabled: bool,
    git_forges: &[GitForge],
) -> anyhow::Result<RenderedProxyConfig> {
    crate::validation::validate_project_name(project)?;
    let ner = super::pii_ner::live_ner_config_in(data_dir, pii_ner_enabled);
    let content = render_proxy_config_full(llm, ner.as_ref(), git_forges);
    Ok(RenderedProxyConfig {
        content,
        ner_url: ner.map(|ner| ner.url().to_string()),
    })
}

pub(super) fn proxy_state_digest_in(
    content: &str,
    data_dir: &Path,
    project: &str,
) -> anyhow::Result<String> {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(super::secret_slots::PROXY_CONFIG_FILE.as_bytes());
    hasher.update(b"\0");
    hasher.update(content.as_bytes());
    hasher.update(b"\0");
    let secrets = SecretStore::open(data_dir)?.read_project(project)?;
    for (name, value) in &secrets.values {
        if name.service() != super::LLM_TOKEN_SERVICE {
            continue;
        }
        hasher.update(name.field().as_bytes());
        hasher.update(b"\0");
        hasher.update(Sha256::digest(value.as_bytes()));
        hasher.update(b"\n");
    }
    Ok(crate::bundle::bytes_to_hex(&hasher.finalize()))
}

/// Stores one provider's API key in the secret store.
pub fn write_llm_provider_key_in(
    data_dir: &Path,
    project: &str,
    provider_id: &str,
    key: &str,
) -> anyhow::Result<()> {
    let value = key.trim();
    let value = value.strip_prefix("Bearer ").unwrap_or(value).trim();
    if value.is_empty() {
        anyhow::bail!("API key must not be empty");
    }
    if value.chars().any(|c| c.is_control()) {
        anyhow::bail!("API key must not contain control characters");
    }
    let name = SecretName::llm_provider_key(project, provider_id)?;
    SecretStore::open(data_dir)?.write(&name, value)?;
    Ok(())
}

/// Removes one provider's key from the secret store.
pub fn remove_llm_provider_key_in(
    data_dir: &Path,
    project: &str,
    provider_id: &str,
) -> anyhow::Result<()> {
    let name = SecretName::llm_provider_key(project, provider_id)?;
    SecretStore::open(data_dir)?.delete(&name)?;
    Ok(())
}

#[cfg(test)]
#[expect(clippy::unwrap_used, reason = "test assertions may unwrap freely")]
mod tests {
    use super::*;
    use crate::config::{LlmActive, LlmProviderEntry};

    fn entry(id: &str, kind: LlmProviderKind) -> LlmProviderEntry {
        LlmProviderEntry {
            id: id.into(),
            kind,
            base_url: None,
            model: None,
            has_api_key: false,
            context_tokens: None,
            has_custom_headers: false,
        }
    }

    fn full_provider_mix() -> LlmConfig {
        LlmConfig {
            providers: vec![
                entry("anthropic", LlmProviderKind::AnthropicOauth),
                LlmProviderEntry {
                    has_api_key: true,
                    ..entry("anthropic-key", LlmProviderKind::AnthropicApiKey)
                },
                LlmProviderEntry {
                    base_url: Some("http://host.docker.internal:9000".into()),
                    ..entry("local", LlmProviderKind::Local)
                },
                LlmProviderEntry {
                    has_api_key: true,
                    ..entry("openrouter", LlmProviderKind::OpenRouter)
                },
            ],
            active: Some(LlmActive {
                provider_id: "local".into(),
                model: Some("qwen3".into()),
            }),
            ..Default::default()
        }
    }

    #[test]
    fn render_proxy_config_has_no_key_values_or_canonical_names() {
        let cfg = full_provider_mix();
        let out = render_proxy_config(&cfg);
        assert!(!out.contains("sk-"));
        assert!(!out.contains("ANTHROPIC_API_KEY") && !out.contains("ANTHROPIC_AUTH_TOKEN"));
        assert!(out.contains("SPW_KEY_OPENROUTER"));
    }

    #[test]
    fn render_proxy_config_carries_no_caller_token() {
        let dir = tempfile::tempdir().unwrap();
        let rendered = rendered_content(dir.path(), &full_provider_mix(), &[]);
        assert!(!rendered.contains("caller_token"), "{rendered}");
        assert!(!render_proxy_config(&full_provider_mix()).contains("caller_token"));
    }

    #[test]
    fn caller_header_value_joins_the_header_name_and_the_token() {
        assert_eq!(
            caller_header_value("abc123"),
            "x-speedwave-proxy-auth: abc123"
        );
    }

    fn stored_key(dir: &Path, provider_id: &str) -> Option<String> {
        let name = SecretName::llm_provider_key("proj", provider_id).unwrap();
        SecretStore::open(dir)
            .unwrap()
            .read(&name)
            .unwrap()
            .map(|value| value.to_string())
    }

    fn rendered_content(dir: &Path, llm: &LlmConfig, forges: &[GitForge]) -> String {
        render_proxy_config_in(dir, "proj", llm, true, forges)
            .unwrap()
            .content
    }

    #[test]
    fn render_proxy_config_writes_no_proxy_json_and_no_caller_token_file() {
        fn files_named(dir: &Path, name: &str, found: &mut Vec<std::path::PathBuf>) {
            for entry in std::fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    files_named(&path, name, found);
                } else if path.file_name().is_some_and(|n| n == name) {
                    found.push(path);
                }
            }
        }

        let dir = tempfile::tempdir().unwrap();
        let llm = LlmConfig {
            providers: vec![entry("anthropic", LlmProviderKind::AnthropicOauth)],
            ..Default::default()
        };
        let rendered = rendered_content(dir.path(), &llm, &[]);
        assert!(!rendered.is_empty());

        let mut proxy_jsons = Vec::new();
        files_named(dir.path(), "proxy.json", &mut proxy_jsons);
        assert!(proxy_jsons.is_empty(), "found {proxy_jsons:?}");

        let mut token_files = Vec::new();
        files_named(dir.path(), "caller-token", &mut token_files);
        assert!(token_files.is_empty(), "found {token_files:?}");
    }

    #[test]
    fn render_proxy_config_rejects_an_invalid_project_name() {
        let dir = tempfile::tempdir().unwrap();
        let result = render_proxy_config_in(dir.path(), "../evil", &full_provider_mix(), true, &[]);
        assert!(result.is_err());
        assert!(std::fs::read_dir(dir.path()).unwrap().next().is_none());
    }

    #[test]
    fn render_proxy_config_renders_ner_only_for_a_live_detector() {
        use crate::host_mcp_process::lock::{self, LockFile, LockService};
        let dir = tempfile::tempdir().unwrap();
        let cfg = full_provider_mix();
        let rendered = render_proxy_config_in(dir.path(), "proj", &cfg, true, &[]).unwrap();
        assert!(!rendered.content.contains(r#""ner":"#));
        assert_eq!(rendered.ner_url, None);

        let lock = LockFile::new(
            LockService::PiiNer,
            std::process::id(),
            50444,
            "ner-tok".into(),
        );
        lock::write(&dir.path().join(crate::consts::PII_NER_LOCK_FILE), &lock).unwrap();
        let rendered = render_proxy_config_in(dir.path(), "proj", &cfg, true, &[]).unwrap();
        let doc: serde_json::Value = serde_json::from_str(&rendered.content).unwrap();
        assert_eq!(doc["ner"]["token"], "ner-tok");
        assert_eq!(doc["ner"]["min_confidence"], 0.6);
        assert_eq!(
            doc["ner"]["labels"].as_array().unwrap().len(),
            super::super::pii_ner::DEFAULT_NER_LABELS.len()
        );
        assert_eq!(
            rendered.ner_url.as_deref(),
            doc["ner"]["url"].as_str(),
            "the returned ner url must be the one inside the content"
        );
        assert!(rendered.ner_url.is_some());
    }

    #[test]
    fn render_proxy_config_omits_ner_when_the_project_disables_it() {
        use crate::host_mcp_process::lock::{self, LockFile, LockService};
        let dir = tempfile::tempdir().unwrap();
        let cfg = full_provider_mix();
        let lock = LockFile::new(
            LockService::PiiNer,
            std::process::id(),
            50666,
            "ner-tok".into(),
        );
        lock::write(&dir.path().join(crate::consts::PII_NER_LOCK_FILE), &lock).unwrap();

        let rendered = render_proxy_config_in(dir.path(), "proj", &cfg, false, &[]).unwrap();
        assert!(!rendered.content.contains(r#""ner":"#));
        assert_eq!(
            rendered.ner_url, None,
            "a disabled project must render no detector even while one is live"
        );
    }

    #[test]
    fn render_full_places_ner_after_the_routes() {
        let live = super::super::pii_ner::LiveNerService::test_new(50555, "t");
        let ner = super::super::pii_ner::ner_render_config(&live);
        let rendered = render_proxy_config_full(&full_provider_mix(), Some(&ner), &[]);
        let tail = r#"],"ner":{"url":"http://host.docker.internal:50555","token":"t","min_confidence":0.6,"labels":["#;
        assert!(rendered.contains(tail), "{rendered}");
        assert_eq!(
            render_proxy_config_full(&full_provider_mix(), None, &[]),
            render_proxy_config(&full_provider_mix())
        );
    }

    #[test]
    fn spw_key_env_name_normalises_like_worker_env() {
        assert_eq!(spw_key_env_name("openrouter"), "SPW_KEY_OPENROUTER");
        assert_eq!(spw_key_env_name("my-anthropic"), "SPW_KEY_MY_ANTHROPIC");
    }

    #[test]
    fn render_full_provider_mix_golden() {
        let llm = full_provider_mix();
        let expected = r#"{"routes":[{"prefix":"anthropic","base_url":"https://api.anthropic.com","auth":"passthrough","provider_kind":"anthropic_oauth","provider_id":"anthropic"},{"prefix":"local","base_url":"http://host.docker.internal:9000","auth":"none","provider_kind":"local","provider_id":"local"},{"prefix":"openrouter","base_url":"https://openrouter.ai/api","auth":{"swap_env":"SPW_KEY_OPENROUTER","scheme":"bearer"},"provider_kind":"openrouter","provider_id":"openrouter"}]}"#;
        assert_eq!(render_proxy_config(&llm), expected);
    }

    #[test]
    fn openrouter_route_prefix_follows_a_custom_entry_id_not_a_hardcoded_literal() {
        let llm = LlmConfig {
            providers: vec![LlmProviderEntry {
                has_api_key: true,
                ..entry("my-or", LlmProviderKind::OpenRouter)
            }],
            ..Default::default()
        };
        let json = render_proxy_config(&llm);
        assert!(
            json.contains(r#""prefix":"my-or""#),
            "route prefix must be the entry's own id, not a hardcoded 'openrouter': {json}"
        );
        assert!(
            !json.contains(r#""prefix":"openrouter""#),
            "must not fall back to the hardcoded literal: {json}"
        );
    }

    #[test]
    fn anthropic_route_kind_reflects_active_provider() {
        let mut cfg = full_provider_mix();
        cfg.active = Some(LlmActive {
            provider_id: "anthropic-key".into(),
            model: None,
        });
        let out = render_proxy_config(&cfg);
        assert!(out.contains(r#""prefix":"anthropic""#));
        assert!(out.contains(r#""provider_kind":"anthropic_api_key""#));
    }

    #[test]
    fn local_route_carries_kind_and_id() {
        let out = render_proxy_config(&full_provider_mix());
        assert!(out.contains(
            r#"{"prefix":"local","base_url":"http://host.docker.internal:9000","auth":"none","provider_kind":"local","provider_id":"local"}"#
        ));
    }

    #[test]
    fn render_accepts_v1_persisted_trailing_slash_base_url() {
        for stored in [
            "http://host.docker.internal:9000/v1/",
            "http://host.docker.internal:9000/",
        ] {
            let llm = LlmConfig {
                providers: vec![LlmProviderEntry {
                    base_url: Some(stored.into()),
                    ..entry("local", LlmProviderKind::Local)
                }],
                ..Default::default()
            };
            let json = render_proxy_config(&llm);
            assert!(
                json.contains(r#""prefix":"local","base_url":"http://host.docker.internal:9000""#),
                "stored '{stored}' must normalize to a live route: {json}"
            );
        }
    }

    #[test]
    fn render_strips_trailing_v1_so_forwarder_does_not_double_it() {
        let llm = LlmConfig {
            providers: vec![LlmProviderEntry {
                base_url: Some("http://host.docker.internal:9000/v1".into()),
                ..entry("local", LlmProviderKind::Local)
            }],
            ..Default::default()
        };
        let out = render_proxy_config(&llm);
        assert!(
            out.contains(r#""prefix":"local","base_url":"http://host.docker.internal:9000""#),
            "trailing /v1 must be stripped, got: {out}"
        );
        assert!(!out.contains("/v1\""), "no /v1 should remain: {out}");
    }

    #[test]
    fn render_never_embeds_key_values_or_canonical_names() {
        let llm = LlmConfig {
            providers: vec![
                LlmProviderEntry {
                    has_api_key: true,
                    ..entry("openrouter", LlmProviderKind::OpenRouter)
                },
                LlmProviderEntry {
                    has_api_key: true,
                    ..entry("anthropic-key", LlmProviderKind::AnthropicApiKey)
                },
            ],
            ..Default::default()
        };
        let json = render_proxy_config(&llm);
        assert!(!json.contains("ANTHROPIC_API_KEY"));
        assert!(!json.contains("ANTHROPIC_AUTH_TOKEN"));
        assert!(!json.contains("sk-"));
        assert!(json.contains("SPW_KEY_OPENROUTER"));
    }

    #[test]
    fn render_oauth_only_has_anthropic_passthrough_only() {
        let llm = LlmConfig {
            providers: vec![entry("anthropic", LlmProviderKind::AnthropicOauth)],
            ..Default::default()
        };
        let json = render_proxy_config(&llm);
        assert!(
            json.contains(r#""prefix":"anthropic""#),
            "anthropic passthrough must be present: {json}"
        );
        assert!(
            json.contains(r#""auth":"passthrough""#),
            "must be passthrough: {json}"
        );
        let route_count = json.matches(r#""prefix":"#).count();
        assert_eq!(
            route_count, 1,
            "oauth-only must have exactly one route: {json}"
        );
    }

    #[test]
    fn render_skips_local_without_base_url_and_invalid_ids() {
        let mut bad_id = entry("ok-id", LlmProviderKind::OpenRouter);
        bad_id.id = "Bad.Id".into();
        let llm = LlmConfig {
            providers: vec![entry("local", LlmProviderKind::Local), bad_id],
            ..Default::default()
        };
        let json = render_proxy_config(&llm);
        assert!(
            !json.contains(r#""prefix":"local""#),
            "no base_url → skipped: {json}"
        );
        assert!(!json.contains("Bad.Id"), "invalid id → skipped: {json}");
    }

    #[test]
    fn render_skips_provider_with_invalid_base_url() {
        for bad in [
            "http://user:pass@host.docker.internal:9000",
            "file:///etc/passwd",
            "http://host.docker.internal:9000/a/b",
        ] {
            let llm = LlmConfig {
                providers: vec![LlmProviderEntry {
                    base_url: Some(bad.into()),
                    ..entry("local", LlmProviderKind::Local)
                }],
                ..Default::default()
            };
            let json = render_proxy_config(&llm);
            assert!(
                !json.contains(r#""prefix":"local""#),
                "invalid base_url '{bad}' must be skipped, got: {json}"
            );
        }
    }

    fn forges_with(
        integrations: &ResolvedIntegrationsConfig,
        gitlab_host_url: Option<&str>,
    ) -> (tempfile::TempDir, Vec<GitForge>) {
        forges_with_lists(
            integrations,
            gitlab_host_url,
            &GitRepositoryLists::default(),
        )
    }

    fn forges_with_lists(
        integrations: &ResolvedIntegrationsConfig,
        gitlab_host_url: Option<&str>,
        lists: &GitRepositoryLists,
    ) -> (tempfile::TempDir, Vec<GitForge>) {
        let dir = tempfile::tempdir().unwrap();
        if let Some(host_url) = gitlab_host_url {
            let gitlab =
                super::super::tokens::resolve_tokens_dir_in(dir.path(), "proj").join("gitlab");
            std::fs::create_dir_all(&gitlab).unwrap();
            std::fs::write(gitlab.join("host_url"), host_url).unwrap();
        }
        let forges = git_forges_in(
            dir.path(),
            "proj",
            integrations,
            lists,
            &AccessPolicy::default(),
        );
        (dir, forges)
    }

    fn both_forges_enabled() -> ResolvedIntegrationsConfig {
        ResolvedIntegrationsConfig {
            github: true,
            gitlab: true,
            ..Default::default()
        }
    }

    fn rendered_git_forges(forges: &[GitForge]) -> serde_json::Value {
        let json = render_proxy_config_full(&full_provider_mix(), None, forges);
        serde_json::from_str::<serde_json::Value>(&json).unwrap()["git_forges"].clone()
    }

    #[test]
    fn git_forges_are_absent_when_no_integration_is_enabled() {
        let (_dir, forges) = forges_with(
            &ResolvedIntegrationsConfig::default(),
            Some("https://gitlab.example.com"),
        );
        assert!(forges.is_empty());
        let json = render_proxy_config_full(&full_provider_mix(), None, &forges);
        assert!(!json.contains("git_forges"), "{json}");
    }

    #[test]
    fn git_forges_render_github_and_default_gitlab_sorted_by_host() {
        let (_dir, forges) = forges_with(&both_forges_enabled(), None);
        assert_eq!(
            rendered_git_forges(&forges),
            serde_json::json!([
                {"host": "github.com", "base_url": "https://github.com", "login": "x-access-token", "token_file": "/git-tokens/github/token", "repositories": []},
                {"host": "gitlab.com", "base_url": "https://gitlab.com", "login": "oauth2", "token_file": "/git-tokens/gitlab/token", "repositories": []}
            ])
        );
    }

    fn lists(github: &[&str], gitlab: &[&str]) -> GitRepositoryLists {
        GitRepositoryLists {
            github: github.iter().map(|s| s.to_string()).collect(),
            gitlab: gitlab.iter().map(|s| s.to_string()).collect(),
        }
    }

    fn repositories_of<'a>(forges: &'a [GitForge], host: &str) -> &'a [String] {
        &forges.iter().find(|f| f.host == host).unwrap().repositories
    }

    #[test]
    fn git_forges_carry_their_own_repository_list() {
        let (_dir, forges) = forges_with_lists(
            &both_forges_enabled(),
            None,
            &lists(
                &["Speednet-Software/Speedwave", "other/*"],
                &["group/sub/repo"],
            ),
        );
        assert_eq!(
            repositories_of(&forges, "github.com"),
            ["other/*", "speednet-software/speedwave"]
        );
        assert_eq!(repositories_of(&forges, "gitlab.com"), ["group/sub/repo"]);
        let json = rendered_git_forges(&forges);
        assert_eq!(
            json[0]["repositories"],
            serde_json::json!(["other/*", "speednet-software/speedwave"])
        );
        assert_eq!(
            json[1]["repositories"],
            serde_json::json!(["group/sub/repo"])
        );
    }

    #[test]
    fn git_forges_sort_and_deduplicate_the_normalised_entries() {
        let (_dir, forges) = forges_with_lists(
            &ResolvedIntegrationsConfig {
                github: true,
                ..Default::default()
            },
            None,
            &lists(
                &[
                    "b/repo",
                    "https://github.com/B/Repo.git",
                    "github.com/a/repo",
                    "a/repo",
                ],
                &[],
            ),
        );
        assert_eq!(repositories_of(&forges, "github.com"), ["a/repo", "b/repo"]);
    }

    #[test]
    fn git_forges_drop_entries_that_no_longer_validate_for_the_host() {
        let (_dir, forges) = forges_with_lists(
            &both_forges_enabled(),
            Some("https://gitlab.example.com"),
            &lists(
                &["ok/repo", "*", "a/*/b", "gitlab.example.com/moved/repo", ""],
                &[
                    "team/app",
                    "https://gitlab.com/old/host",
                    "github.com:not/here.git",
                ],
            ),
        );
        assert_eq!(repositories_of(&forges, "github.com"), ["ok/repo"]);
        assert_eq!(repositories_of(&forges, "gitlab.example.com"), ["team/app"]);
    }

    #[test]
    fn git_forges_of_a_disabled_integration_ignore_its_list() {
        let (_dir, forges) = forges_with_lists(
            &ResolvedIntegrationsConfig {
                github: true,
                ..Default::default()
            },
            None,
            &lists(&["a/b"], &["c/d"]),
        );
        assert_eq!(forges.len(), 1);
        assert_eq!(repositories_of(&forges, "github.com"), ["a/b"]);
    }

    #[test]
    fn git_forges_render_an_empty_list_as_an_empty_array() {
        let (_dir, forges) = forges_with_lists(
            &ResolvedIntegrationsConfig {
                github: true,
                ..Default::default()
            },
            None,
            &lists(&["*"], &[]),
        );
        assert!(forges[0].repositories.is_empty());
        let json = render_proxy_config_full(&full_provider_mix(), None, &forges);
        assert!(json.contains(r#""repositories":[]"#), "{json}");
        assert_eq!(
            rendered_git_forges(&forges)[0]["repositories"],
            serde_json::json!([])
        );
    }

    fn composed(managed: bool, project: bool, modes: &[(&str, AccessMode)]) -> AccessPolicy {
        let service_modes = modes
            .iter()
            .map(|(service, mode)| ((*service).to_string(), *mode))
            .collect();
        speedwave_access_policy::compose_access_policy(&speedwave_access_policy::AccessInputs {
            managed_read_only: managed,
            project_read_only: project,
            service_modes: &service_modes,
        })
    }

    fn rendered_access_modes(access: &AccessPolicy) -> Vec<(String, Option<String>)> {
        let dir = tempfile::tempdir().unwrap();
        let forges = git_forges_in(
            dir.path(),
            "proj",
            &both_forges_enabled(),
            &GitRepositoryLists::default(),
            access,
        );
        rendered_git_forges(&forges)
            .as_array()
            .unwrap()
            .iter()
            .map(|forge| {
                (
                    forge["host"].as_str().unwrap().to_string(),
                    forge.get("access").map(|a| a.as_str().unwrap().to_string()),
                )
            })
            .collect()
    }

    fn mode(host: &str, access: Option<&str>) -> (String, Option<String>) {
        (host.to_string(), access.map(str::to_string))
    }

    #[test]
    fn git_forges_carry_no_access_key_while_nothing_is_read_only() {
        assert_eq!(
            rendered_access_modes(&composed(false, false, &[])),
            [mode("github.com", None), mode("gitlab.com", None)]
        );
    }

    #[test]
    fn integration_mode_makes_only_that_forge_read_only() {
        assert_eq!(
            rendered_access_modes(&composed(false, false, &[("github", AccessMode::ReadOnly)])),
            [
                mode("github.com", Some("read_only")),
                mode("gitlab.com", None)
            ]
        );
        assert_eq!(
            rendered_access_modes(&composed(false, false, &[("gitlab", AccessMode::ReadOnly)])),
            [
                mode("github.com", None),
                mode("gitlab.com", Some("read_only"))
            ]
        );
    }

    #[test]
    fn other_integrations_modes_do_not_touch_the_forges() {
        assert_eq!(
            rendered_access_modes(&composed(false, false, &[("slack", AccessMode::ReadOnly)])),
            [mode("github.com", None), mode("gitlab.com", None)]
        );
    }

    #[test]
    fn project_wide_mode_makes_every_forge_read_only() {
        assert_eq!(
            rendered_access_modes(&composed(false, true, &[])),
            [
                mode("github.com", Some("read_only")),
                mode("gitlab.com", Some("read_only"))
            ]
        );
    }

    #[test]
    fn mdm_makes_every_forge_read_only_even_when_an_integration_says_full() {
        assert_eq!(
            rendered_access_modes(&composed(
                true,
                false,
                &[("github", AccessMode::Full), ("gitlab", AccessMode::Full)]
            )),
            [
                mode("github.com", Some("read_only")),
                mode("gitlab.com", Some("read_only"))
            ]
        );
    }

    #[test]
    fn state_digest_changes_with_the_access_mode_of_a_forge() {
        let dir = tempfile::tempdir().unwrap();
        let digest_with = |access: &AccessPolicy| {
            let forges = git_forges_in(
                dir.path(),
                "proj",
                &both_forges_enabled(),
                &GitRepositoryLists::default(),
                access,
            );
            let content = rendered_content(dir.path(), &full_provider_mix(), &forges);
            proxy_state_digest_in(&content, dir.path(), "proj").unwrap()
        };
        let full = digest_with(&composed(false, false, &[]));
        let read_only = digest_with(&composed(false, true, &[]));
        assert_ne!(full, read_only);
        assert_eq!(full, digest_with(&composed(false, false, &[])));
    }

    #[test]
    fn git_forges_sort_by_host_not_by_integration() {
        let (_dir, forges) =
            forges_with(&both_forges_enabled(), Some("https://git.corp.example\n"));
        let hosts: Vec<&str> = forges.iter().map(|f| f.host.as_str()).collect();
        assert_eq!(hosts, ["git.corp.example", "github.com"]);
    }

    #[test]
    fn git_forges_gitlab_empty_host_url_falls_back_to_default() {
        let (_dir, forges) = forges_with(&both_forges_enabled(), Some("  \n"));
        assert!(forges.iter().any(|f| f.host == "gitlab.com"));
    }

    #[test]
    fn git_forges_skip_gitlab_when_host_url_is_unreadable() {
        let dir = tempfile::tempdir().unwrap();
        let gitlab = super::super::tokens::resolve_tokens_dir_in(dir.path(), "proj").join("gitlab");
        std::fs::create_dir_all(gitlab.join("host_url")).unwrap();
        let forges = git_forges_in(
            dir.path(),
            "proj",
            &ResolvedIntegrationsConfig {
                gitlab: true,
                ..Default::default()
            },
            &GitRepositoryLists::default(),
            &AccessPolicy::default(),
        );
        assert!(forges.is_empty());
    }

    #[test]
    fn git_forges_gitlab_missing_host_url_falls_back_to_default() {
        let (_dir, forges) = forges_with(
            &ResolvedIntegrationsConfig {
                gitlab: true,
                ..Default::default()
            },
            None,
        );
        assert_eq!(forges[0].host, "gitlab.com");
    }

    #[test]
    fn git_forges_gitlab_keeps_scheme_and_authority_only() {
        let (_dir, forges) = forges_with(
            &ResolvedIntegrationsConfig {
                gitlab: true,
                ..Default::default()
            },
            Some("https://GitLab.Example.com:8443/sub/path?x=1#f"),
        );
        let json = rendered_git_forges(&forges);
        assert_eq!(json[0]["host"], "gitlab.example.com:8443");
        assert_eq!(json[0]["base_url"], "https://gitlab.example.com:8443");
    }

    #[test]
    fn git_forges_skip_gitlab_hosts_that_are_not_plain_https() {
        for bad in [
            "http://gitlab.example.com",
            "gitlab.example.com",
            "ssh://git@gitlab.example.com",
            "https://user:pw@gitlab.example.com",
            "https://",
        ] {
            let (_dir, forges) = forges_with(
                &ResolvedIntegrationsConfig {
                    gitlab: true,
                    ..Default::default()
                },
                Some(bad),
            );
            assert!(forges.is_empty(), "'{bad}' must be skipped");
        }
    }

    #[test]
    fn render_proxy_config_carries_git_forges() {
        let dir = tempfile::tempdir().unwrap();
        let forges = git_forges_in(
            dir.path(),
            "proj",
            &ResolvedIntegrationsConfig {
                github: true,
                ..Default::default()
            },
            &GitRepositoryLists::default(),
            &AccessPolicy::default(),
        );
        let rendered = rendered_content(dir.path(), &full_provider_mix(), &forges);
        assert!(
            rendered.contains(r#""git_forges":[{"host":"github.com""#),
            "{rendered}"
        );
    }

    #[test]
    fn write_key_validates_and_strips_bearer() {
        let dir = tempfile::tempdir().unwrap();
        write_llm_provider_key_in(dir.path(), "proj", "openrouter", "Bearer sk-or-v1-abc ")
            .unwrap();
        assert_eq!(
            stored_key(dir.path(), "openrouter").as_deref(),
            Some("sk-or-v1-abc")
        );

        assert!(write_llm_provider_key_in(dir.path(), "proj", "openrouter", "  ").is_err());
        assert!(
            write_llm_provider_key_in(dir.path(), "proj", "openrouter", "evil\r\nheader").is_err()
        );
        assert!(write_llm_provider_key_in(dir.path(), "proj", "../escape", "v").is_err());
    }

    #[test]
    fn remove_key_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        write_llm_provider_key_in(dir.path(), "proj", "openrouter", "sk-x").unwrap();
        remove_llm_provider_key_in(dir.path(), "proj", "openrouter").unwrap();
        remove_llm_provider_key_in(dir.path(), "proj", "openrouter").unwrap();
        assert!(remove_llm_provider_key_in(dir.path(), "proj", "../x").is_err());
    }

    #[test]
    fn state_digest_tracks_config_and_key_lifecycle() {
        let dir = tempfile::tempdir().unwrap();
        let llm = LlmConfig {
            providers: vec![entry("local", LlmProviderKind::Local)],
            ..Default::default()
        };
        let content = rendered_content(dir.path(), &llm, &[]);

        let d1 = proxy_state_digest_in(&content, dir.path(), "proj").unwrap();
        assert_eq!(d1.len(), 64);
        assert!(d1.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(
            d1,
            proxy_state_digest_in(&content, dir.path(), "proj").unwrap()
        );

        write_llm_provider_key_in(dir.path(), "proj", "openrouter", "sk-or-v1-abc").unwrap();
        let d2 = proxy_state_digest_in(&content, dir.path(), "proj").unwrap();
        assert_ne!(d1, d2);
        assert!(!d2.contains("sk-or-v1-abc"));

        write_llm_provider_key_in(dir.path(), "proj", "openrouter", "sk-or-v1-xyz").unwrap();
        let d3 = proxy_state_digest_in(&content, dir.path(), "proj").unwrap();
        assert_ne!(d2, d3, "same-length key rotation must change the digest");

        remove_llm_provider_key_in(dir.path(), "proj", "openrouter").unwrap();
        let d4 = proxy_state_digest_in(&content, dir.path(), "proj").unwrap();
        assert_ne!(d3, d4);
        assert_eq!(d1, d4, "removing the key restores the original digest");

        let llm2 = LlmConfig {
            providers: vec![LlmProviderEntry {
                has_api_key: true,
                ..entry("openrouter", LlmProviderKind::OpenRouter)
            }],
            ..Default::default()
        };
        let content2 = rendered_content(dir.path(), &llm2, &[]);
        assert_ne!(content, content2);
        assert_ne!(
            d1,
            proxy_state_digest_in(&content2, dir.path(), "proj").unwrap()
        );
    }

    #[test]
    fn state_digest_covers_the_rendered_content() {
        let dir = tempfile::tempdir().unwrap();
        let llm = LlmConfig {
            providers: vec![entry("local", LlmProviderKind::Local)],
            ..Default::default()
        };
        let content = rendered_content(dir.path(), &llm, &[]);
        let d1 = proxy_state_digest_in(&content, dir.path(), "proj").unwrap();
        assert_ne!(
            d1,
            proxy_state_digest_in(r#"{"routes":[]}"#, dir.path(), "proj").unwrap()
        );
    }

    #[test]
    fn state_digest_changes_with_the_repository_list_of_a_forge() {
        let dir = tempfile::tempdir().unwrap();
        let github = ResolvedIntegrationsConfig {
            github: true,
            ..Default::default()
        };
        let digest_with = |entries: &[&str]| {
            let forges = git_forges_in(
                dir.path(),
                "proj",
                &github,
                &lists(entries, &[]),
                &AccessPolicy::default(),
            );
            let content = rendered_content(dir.path(), &full_provider_mix(), &forges);
            proxy_state_digest_in(&content, dir.path(), "proj").unwrap()
        };
        let empty = digest_with(&[]);
        let one = digest_with(&["owner/repo"]);
        let two = digest_with(&["owner/repo", "other/repo"]);
        assert_ne!(empty, one);
        assert_ne!(one, two);
        assert_eq!(one, digest_with(&["owner/repo"]));
    }

    #[test]
    fn state_digest_handles_a_store_without_keys() {
        let dir = tempfile::tempdir().unwrap();
        let content = r#"{"routes":[]}"#;
        let d = proxy_state_digest_in(content, dir.path(), "proj").unwrap();
        assert_eq!(d.len(), 64);
        assert_eq!(
            d,
            proxy_state_digest_in(content, dir.path(), "proj").unwrap()
        );
        assert_ne!(d, proxy_state_digest_in("{}", dir.path(), "proj").unwrap());
    }

    #[test]
    fn render_proxy_config_does_not_overwrite_existing_llm_key() {
        let dir = tempfile::tempdir().unwrap();
        let llm = LlmConfig {
            providers: vec![LlmProviderEntry {
                has_api_key: true,
                base_url: Some("http://host.docker.internal:9000".into()),
                ..entry("local", LlmProviderKind::Local)
            }],
            ..Default::default()
        };
        write_llm_provider_key_in(dir.path(), "proj", "local", "sk-rotated").unwrap();
        rendered_content(dir.path(), &llm, &[]);
        assert_eq!(
            stored_key(dir.path(), "local").as_deref(),
            Some("sk-rotated"),
            "render_proxy_config_in must not touch an existing key in the store"
        );
    }

    #[test]
    fn render_renders_bearer_when_has_api_key_set() {
        let dir = tempfile::tempdir().unwrap();
        let llm = LlmConfig {
            providers: vec![LlmProviderEntry {
                base_url: Some("http://10.0.0.1:4000".into()),
                has_api_key: true,
                ..entry("local", LlmProviderKind::Local)
            }],
            active: None,
            ..LlmConfig::default()
        };
        write_llm_provider_key_in(dir.path(), "proj", "local", "sk-real").unwrap();
        let rendered = rendered_content(dir.path(), &llm, &[]);
        assert!(
            rendered.contains(r#""swap_env":"SPW_KEY_LOCAL""#),
            "local route must use bearer when has_api_key is set: {rendered}"
        );
        assert!(!rendered
            .contains(r#""prefix":"local","base_url":"http://10.0.0.1:4000","auth":"none""#));
    }
}
