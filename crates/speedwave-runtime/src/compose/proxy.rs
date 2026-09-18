use crate::config::{LlmConfig, LlmProviderKind};
use serde::Serialize;
use std::path::{Path, PathBuf};

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
    caller_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ner: Option<&'a super::pii_ner::NerRenderConfig>,
}

/// Port the proxy container listens on (fixed in the forwarder binary).
pub const PROXY_PORT: u16 = 4000;

/// In-network proxy URL every session points `ANTHROPIC_BASE_URL` at; routing
/// is by the request body's model prefix, not the URL path.
pub const PROXY_BASE_URL: &str = "http://proxy:4000";

/// `SPW_KEY_<ID>` env name (hyphens → underscores, uppercased — like
/// `plugin::derive_worker_env`). SSOT inverse: `containers/proxy/src/keys.rs::provider_id_from_env_name`.
pub fn spw_key_env_name(provider_id: &str) -> String {
    format!(
        "SPW_KEY_{}",
        provider_id.to_ascii_uppercase().replace('-', "_")
    )
}

/// Per-project proxy config dir: `<data_dir>/proxy/<project>/`.
pub fn proxy_config_dir_in(data_dir: &Path, project: &str) -> PathBuf {
    data_dir.join("proxy").join(project)
}

/// Path of the rendered config: `<data_dir>/proxy/<project>/proxy.json`.
pub fn proxy_config_path_in(data_dir: &Path, project: &str) -> PathBuf {
    proxy_config_dir_in(data_dir, project).join("proxy.json")
}

/// Header carrying the per-project caller secret; mirror of the proxy's
/// `CALLER_AUTH_HEADER` in `containers/proxy/src/main.rs`.
pub const PROXY_CALLER_AUTH_HEADER: &str = "x-speedwave-proxy-auth";

fn caller_token_path_in(data_dir: &Path, project: &str) -> PathBuf {
    proxy_config_dir_in(data_dir, project).join("caller-token")
}

pub fn ensure_caller_token_in(data_dir: &Path, project: &str) -> anyhow::Result<String> {
    crate::validation::validate_project_name(project)?;
    let path = caller_token_path_in(data_dir, project);
    if let Ok(existing) = std::fs::read_to_string(&path) {
        let trimmed = existing.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
        crate::fs_perms::ensure_owner_only_dir(parent)?;
    }
    let token = crate::pkce::generate_state();
    crate::fs_perms::write_restricted_file_atomic(&path, &token)?;
    Ok(token)
}

/// Renders the proxy routing config (a `routes` array consumed by the forwarder
/// `containers/proxy/src/router.rs`). Pure; `write_proxy_config_in` persists it.
pub fn render_proxy_config(llm: &LlmConfig) -> String {
    render_proxy_config_with(llm, None)
}

pub fn render_proxy_config_with(llm: &LlmConfig, caller_token: Option<&str>) -> String {
    render_proxy_config_full(llm, caller_token, None)
}

/// [`render_proxy_config_with`] plus the optional `ner` section pointing the proxy at the
/// live host-side detector (ADR-090).
pub(crate) fn render_proxy_config_full(
    llm: &LlmConfig,
    caller_token: Option<&str>,
    ner: Option<&super::pii_ner::NerRenderConfig>,
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
        caller_token: caller_token.map(str::to_string),
        ner,
    })
    .unwrap_or_else(|_| r#"{"routes":[]}"#.into())
}

/// Renders + atomically persists the config (0600 + fsync) under
/// `<data_dir>/proxy/<project>/`. Trusts the resolved `has_api_key` flag. The `ner`
/// section is rendered only when the project enables the detector and the host
/// detector's lock names a live process.
pub fn write_proxy_config_in(
    data_dir: &Path,
    project: &str,
    llm: &LlmConfig,
    ner_enabled: bool,
) -> anyhow::Result<PathBuf> {
    crate::validation::validate_project_name(project)?;
    let path = proxy_config_path_in(data_dir, project);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
        crate::fs_perms::ensure_owner_only_dir(parent)?;
    }
    let token = ensure_caller_token_in(data_dir, project)?;
    let ner = ner_enabled
        .then(|| super::pii_ner::live_service_in(data_dir))
        .flatten()
        .map(|live| {
            log::info!(
                "rendering proxy.json with the host PII NER detector on port {}",
                live.port
            );
            super::pii_ner::ner_render_config(&live)
        });
    let content = render_proxy_config_full(llm, Some(&token), ner.as_ref());
    crate::fs_perms::write_restricted_file_atomic(&path, &content)?;
    Ok(path)
}

pub(crate) fn proxy_state_digest_in(data_dir: &Path, project: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    let config_dir = proxy_config_dir_in(data_dir, project);
    let mut rendered: Vec<PathBuf> = std::fs::read_dir(&config_dir)
        .map(|dir| {
            dir.filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| p.is_file())
                .collect()
        })
        .unwrap_or_default();
    rendered.sort();
    for path in rendered {
        hasher.update(path.file_name().unwrap_or_default().as_encoded_bytes());
        hasher.update(b"\0");
        hasher.update(std::fs::read(&path).unwrap_or_default());
        hasher.update(b"\0");
    }
    let tokens_dir = data_dir.join("tokens").join(project).join("llm");
    let mut entries: Vec<(std::ffi::OsString, Vec<u8>)> = std::fs::read_dir(&tokens_dir)
        .map(|dir| {
            dir.filter_map(|e| e.ok())
                .map(|e| {
                    let content_hash = Sha256::digest(std::fs::read(e.path()).unwrap_or_default());
                    (e.file_name(), content_hash.to_vec())
                })
                .collect()
        })
        .unwrap_or_default();
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    for (name, content_hash) in entries {
        hasher.update(name.as_encoded_bytes());
        hasher.update(b"\0");
        hasher.update(&content_hash);
        hasher.update(b"\n");
    }
    crate::bundle::bytes_to_hex(&hasher.finalize())
}

pub(crate) fn migrate_legacy_local_key_in(data_dir: &Path, project: &str, llm: &LlmConfig) {
    let has_local_entry = llm
        .providers
        .iter()
        .any(|p| p.id == "local" && p.kind == LlmProviderKind::Local);
    if !has_local_entry {
        return;
    }
    let Ok(target) = super::tokens::llm_provider_key_path_in(data_dir, project, "local") else {
        return;
    };
    if target.exists() {
        return;
    }
    let Some(value) = super::llm::read_local_llm_token_opt_in(data_dir, project, "api_key") else {
        log::debug!("no legacy local-llm api_key to migrate (missing or unreadable)");
        return;
    };
    if let Err(e) = write_llm_provider_key_in(data_dir, project, "local", &value) {
        log::warn!("legacy local key migration failed: {e}");
    } else {
        log::info!("migrated legacy local-llm api_key into the llm token namespace");
    }
}

/// Validates + persists one provider's API key in the llm token namespace:
/// strips `Bearer `, rejects control chars and empty values (ADR-040).
pub fn write_llm_provider_key_in(
    data_dir: &Path,
    project: &str,
    provider_id: &str,
    key: &str,
) -> anyhow::Result<PathBuf> {
    let value = key.trim();
    let value = value.strip_prefix("Bearer ").unwrap_or(value).trim();
    if value.is_empty() {
        anyhow::bail!("API key must not be empty");
    }
    if value.chars().any(|c| c.is_control()) {
        anyhow::bail!("API key must not contain control characters");
    }
    let path = super::tokens::llm_provider_key_path_in(data_dir, project, provider_id)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
        crate::fs_perms::ensure_owner_only_dir(parent)?;
    }
    crate::fs_perms::write_restricted_file_atomic(&path, value)?;
    Ok(path)
}

/// Removes one provider's key file (e.g. provider deleted in Settings).
/// Missing file is not an error.
pub fn remove_llm_provider_key_in(
    data_dir: &Path,
    project: &str,
    provider_id: &str,
) -> anyhow::Result<()> {
    let path = super::tokens::llm_provider_key_path_in(data_dir, project, provider_id)?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
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
    fn render_embeds_caller_token_when_present_and_omits_when_none() {
        let cfg = full_provider_mix();
        let with = render_proxy_config_with(&cfg, Some("secret-abc"));
        assert!(
            with.contains(r#""caller_token":"secret-abc""#),
            "token must be embedded"
        );
        let without = render_proxy_config(&cfg);
        assert!(
            !without.contains("caller_token"),
            "no token field when absent: {without}"
        );
    }

    #[test]
    fn ensure_caller_token_is_stable_and_restricted() {
        let dir = tempfile::tempdir().unwrap();
        let t1 = ensure_caller_token_in(dir.path(), "proj").unwrap();
        let t2 = ensure_caller_token_in(dir.path(), "proj").unwrap();
        assert_eq!(t1, t2, "token must be stable across renders");
        assert!(!t1.is_empty());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(caller_token_path_in(dir.path(), "proj"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600, "token file must be 0600");
        }
    }

    #[test]
    fn write_proxy_config_embeds_the_caller_token() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = full_provider_mix();
        write_proxy_config_in(dir.path(), "proj", &cfg, true).unwrap();
        let written = std::fs::read_to_string(proxy_config_path_in(dir.path(), "proj")).unwrap();
        let token = ensure_caller_token_in(dir.path(), "proj").unwrap();
        assert!(
            written.contains(&format!(r#""caller_token":"{token}""#)),
            "written proxy.json must carry the caller token"
        );
    }

    #[test]
    fn write_proxy_config_renders_ner_only_for_a_live_detector() {
        use crate::host_mcp_process::lock::{self, LockFile, LockService};
        let dir = tempfile::tempdir().unwrap();
        let cfg = full_provider_mix();
        write_proxy_config_in(dir.path(), "proj", &cfg, true).unwrap();
        let written = std::fs::read_to_string(proxy_config_path_in(dir.path(), "proj")).unwrap();
        assert!(!written.contains(r#""ner":"#));
        assert_eq!(
            super::super::pii_ner::ner_url_state(&written, None),
            super::super::pii_ner::NerUrlState::Absent
        );

        let lock = LockFile::new(
            LockService::PiiNer,
            std::process::id(),
            50444,
            "ner-tok".into(),
        );
        lock::write(&dir.path().join(crate::consts::PII_NER_LOCK_FILE), &lock).unwrap();
        write_proxy_config_in(dir.path(), "proj", &cfg, true).unwrap();
        let written = std::fs::read_to_string(proxy_config_path_in(dir.path(), "proj")).unwrap();
        let doc: serde_json::Value = serde_json::from_str(&written).unwrap();
        assert_eq!(doc["ner"]["token"], "ner-tok");
        assert_eq!(doc["ner"]["min_confidence"], 0.6);
        assert_eq!(doc["ner"]["required"], false);
        assert_eq!(
            doc["ner"]["labels"].as_array().unwrap().len(),
            super::super::pii_ner::DEFAULT_NER_LABELS.len()
        );
        assert_eq!(
            super::super::pii_ner::ner_url_state(&written, Some(50444)),
            super::super::pii_ner::NerUrlState::Current
        );
        assert!(written.contains(r#""caller_token":"#));
    }

    #[test]
    fn write_proxy_config_omits_ner_when_the_project_disables_it() {
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

        write_proxy_config_in(dir.path(), "proj", &cfg, false).unwrap();
        let written = std::fs::read_to_string(proxy_config_path_in(dir.path(), "proj")).unwrap();
        assert!(!written.contains(r#""ner":"#));
        assert_eq!(
            super::super::pii_ner::ner_url_state(&written, None),
            super::super::pii_ner::NerUrlState::Absent,
            "a disabled project must reconcile against no detector, not the live one"
        );
    }

    #[test]
    fn render_full_places_ner_after_the_caller_token() {
        let live = super::super::pii_ner::LiveNerService::test_new(50555, "t");
        let ner = super::super::pii_ner::ner_render_config(&live);
        let rendered = render_proxy_config_full(&full_provider_mix(), Some("c"), Some(&ner));
        let tail = r#","caller_token":"c","ner":{"url":"http://host.docker.internal:50555","token":"t","min_confidence":0.6,"labels":["#;
        assert!(rendered.contains(tail), "{rendered}");
        assert_eq!(
            render_proxy_config_full(&full_provider_mix(), Some("c"), None),
            render_proxy_config_with(&full_provider_mix(), Some("c"))
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

    #[test]
    fn write_config_creates_restricted_file() {
        let dir = tempfile::tempdir().unwrap();
        let llm = LlmConfig {
            providers: vec![entry("anthropic", LlmProviderKind::AnthropicOauth)],
            ..Default::default()
        };
        let path = write_proxy_config_in(dir.path(), "proj", &llm, true).unwrap();
        assert!(path.is_file());
        assert!(path.ends_with("proxy/proj/proxy.json"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "config must be owner-only");
        }
    }

    #[test]
    fn migrate_legacy_local_key_copies_and_does_not_clobber() {
        let dir = tempfile::tempdir().unwrap();
        let legacy_dir =
            super::super::ensure_token_dir_in(dir.path(), "proj", "local-llm").unwrap();
        std::fs::write(legacy_dir.join("api_key"), "sk-legacy-token\n").unwrap();

        let llm = LlmConfig {
            providers: vec![LlmProviderEntry {
                has_api_key: true,
                base_url: Some("http://host.docker.internal:9000".into()),
                ..entry("local", LlmProviderKind::Local)
            }],
            ..Default::default()
        };
        migrate_legacy_local_key_in(dir.path(), "proj", &llm);

        let target =
            super::super::tokens::llm_provider_key_path_in(dir.path(), "proj", "local").unwrap();
        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            "sk-legacy-token",
            "legacy key must be copied (trimmed) into the llm namespace"
        );

        std::fs::write(&target, "sk-new-token").unwrap();
        migrate_legacy_local_key_in(dir.path(), "proj", &llm);
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "sk-new-token");
    }

    #[test]
    fn migrate_legacy_local_key_runs_when_flag_is_false() {
        let dir = tempfile::tempdir().unwrap();
        let legacy_dir =
            super::super::ensure_token_dir_in(dir.path(), "proj", "local-llm").unwrap();
        std::fs::write(legacy_dir.join("api_key"), "sk-legacy\n").unwrap();

        let llm = LlmConfig {
            providers: vec![LlmProviderEntry {
                has_api_key: false,
                base_url: Some("http://host.docker.internal:9000".into()),
                ..entry("local", LlmProviderKind::Local)
            }],
            ..Default::default()
        };

        migrate_legacy_local_key_in(dir.path(), "proj", &llm);

        let target =
            super::super::tokens::llm_provider_key_path_in(dir.path(), "proj", "local").unwrap();
        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            "sk-legacy",
            "migration must copy the legacy key based on file existence, not has_api_key"
        );
    }

    #[test]
    fn migrate_legacy_local_key_noop_without_legacy_file() {
        let dir = tempfile::tempdir().unwrap();
        let llm = LlmConfig {
            providers: vec![LlmProviderEntry {
                has_api_key: false,
                ..entry("local", LlmProviderKind::Local)
            }],
            ..Default::default()
        };
        migrate_legacy_local_key_in(dir.path(), "proj", &llm);
        let target =
            super::super::tokens::llm_provider_key_path_in(dir.path(), "proj", "local").unwrap();
        assert!(!target.exists(), "no legacy file → no target key written");
    }

    #[test]
    fn migrate_legacy_local_key_skipped_without_local_entry() {
        let dir = tempfile::tempdir().unwrap();
        let legacy_dir =
            super::super::ensure_token_dir_in(dir.path(), "proj", "local-llm").unwrap();
        std::fs::write(legacy_dir.join("api_key"), "sk-legacy\n").unwrap();
        let llm = LlmConfig {
            providers: vec![entry("anthropic", LlmProviderKind::AnthropicOauth)],
            ..Default::default()
        };
        migrate_legacy_local_key_in(dir.path(), "proj", &llm);
        let target =
            super::super::tokens::llm_provider_key_path_in(dir.path(), "proj", "local").unwrap();
        assert!(!target.exists(), "no local entry → migration must not run");
    }

    #[test]
    fn migrate_then_sync_yields_has_api_key_true() {
        let dir = tempfile::tempdir().unwrap();
        let legacy_dir =
            super::super::ensure_token_dir_in(dir.path(), "proj", "local-llm").unwrap();
        std::fs::write(legacy_dir.join("api_key"), "sk-legacy\n").unwrap();

        let mut llm = LlmConfig {
            providers: vec![LlmProviderEntry {
                has_api_key: false,
                base_url: Some("http://host.docker.internal:9000".into()),
                ..entry("local", LlmProviderKind::Local)
            }],
            ..Default::default()
        };

        migrate_legacy_local_key_in(dir.path(), "proj", &llm);
        llm.sync_has_api_key_from_disk_in(dir.path(), "proj");

        assert!(
            llm.providers[0].has_api_key,
            "after migrate→sync the flag must be true (key now on the new path)"
        );
        let rendered = render_proxy_config(&llm);
        assert!(
            !rendered.contains("\"auth\":\"none\"") && !rendered.contains("\"auth\": \"none\""),
            "a keyed local provider must not render auth:none after migration"
        );
    }

    #[test]
    fn write_key_validates_and_strips_bearer() {
        let dir = tempfile::tempdir().unwrap();
        let path =
            write_llm_provider_key_in(dir.path(), "proj", "openrouter", "Bearer sk-or-v1-abc ")
                .unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "sk-or-v1-abc");

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
        write_proxy_config_in(dir.path(), "proj", &llm, true).unwrap();

        let d1 = proxy_state_digest_in(dir.path(), "proj");
        assert_eq!(d1.len(), 64);
        assert!(d1.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(d1, proxy_state_digest_in(dir.path(), "proj"));

        write_llm_provider_key_in(dir.path(), "proj", "openrouter", "sk-or-v1-abc").unwrap();
        let d2 = proxy_state_digest_in(dir.path(), "proj");
        assert_ne!(d1, d2);
        assert!(!d2.contains("sk-or-v1-abc"));

        write_llm_provider_key_in(dir.path(), "proj", "openrouter", "sk-or-v1-xyz").unwrap();
        let d3 = proxy_state_digest_in(dir.path(), "proj");
        assert_ne!(d2, d3, "same-length key rotation must change the digest");

        remove_llm_provider_key_in(dir.path(), "proj", "openrouter").unwrap();
        assert_ne!(d3, proxy_state_digest_in(dir.path(), "proj"));

        let llm2 = LlmConfig {
            providers: vec![LlmProviderEntry {
                has_api_key: true,
                ..entry("openrouter", LlmProviderKind::OpenRouter)
            }],
            ..Default::default()
        };
        write_proxy_config_in(dir.path(), "proj", &llm2, true).unwrap();
        assert_ne!(d1, proxy_state_digest_in(dir.path(), "proj"));
    }

    #[test]
    fn state_digest_covers_proxy_json() {
        let dir = tempfile::tempdir().unwrap();
        let llm = LlmConfig {
            providers: vec![entry("local", LlmProviderKind::Local)],
            ..Default::default()
        };
        write_proxy_config_in(dir.path(), "proj", &llm, true).unwrap();
        let d1 = proxy_state_digest_in(dir.path(), "proj");

        let proxy_json = proxy_config_path_in(dir.path(), "proj");
        std::fs::write(&proxy_json, r#"{"routes":[]}"#).unwrap();
        assert_ne!(d1, proxy_state_digest_in(dir.path(), "proj"));
    }

    #[test]
    fn state_digest_handles_missing_config_and_tokens() {
        let dir = tempfile::tempdir().unwrap();
        let d = proxy_state_digest_in(dir.path(), "proj");
        assert_eq!(d.len(), 64);
        assert_eq!(d, proxy_state_digest_in(dir.path(), "proj"));
    }

    #[test]
    fn write_proxy_config_does_not_overwrite_existing_llm_key() {
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
        write_proxy_config_in(dir.path(), "proj", &llm, true).unwrap();
        let target =
            super::super::tokens::llm_provider_key_path_in(dir.path(), "proj", "local").unwrap();
        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            "sk-rotated",
            "write_proxy_config_in must not touch an existing key in the new namespace"
        );
    }

    #[cfg(unix)]
    #[test]
    fn migrate_legacy_local_key_noop_when_legacy_file_unreadable() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let legacy_dir =
            super::super::ensure_token_dir_in(dir.path(), "proj", "local-llm").unwrap();
        let legacy_file = legacy_dir.join("api_key");
        std::fs::write(&legacy_file, "sk-secret\n").unwrap();
        std::fs::set_permissions(&legacy_file, std::fs::Permissions::from_mode(0o000)).unwrap();

        let llm = LlmConfig {
            providers: vec![LlmProviderEntry {
                has_api_key: false,
                ..entry("local", LlmProviderKind::Local)
            }],
            ..Default::default()
        };
        migrate_legacy_local_key_in(dir.path(), "proj", &llm);

        let _ = std::fs::set_permissions(&legacy_file, std::fs::Permissions::from_mode(0o600));

        let target =
            super::super::tokens::llm_provider_key_path_in(dir.path(), "proj", "local").unwrap();
        assert!(
            !target.exists(),
            "no target key must be written when the legacy file is unreadable"
        );
    }

    #[test]
    fn write_renders_bearer_when_has_api_key_set() {
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
        let path = write_proxy_config_in(dir.path(), "proj", &llm, true).unwrap();
        let rendered = std::fs::read_to_string(&path).unwrap();
        assert!(
            rendered.contains(r#""swap_env":"SPW_KEY_LOCAL""#),
            "local route must use bearer when has_api_key is set: {rendered}"
        );
        assert!(!rendered
            .contains(r#""prefix":"local","base_url":"http://10.0.0.1:4000","auth":"none""#));
    }
}
