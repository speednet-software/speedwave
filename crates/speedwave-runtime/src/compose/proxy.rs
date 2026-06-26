//! Renders the per-project `proxy.json` routing config (ADR-073).
//!
//! The file lands at `<data_dir>/proxy/<project>/proxy.json` (0600,
//! atomic) and is mounted `:ro` at `/config` in the `proxy` container.
//! It carries NO secrets: non-Anthropic keys are referenced by env name only
//! (`SPW_KEY_<PROVIDER_ID>`), resolved inside the container from `/tokens`.
//!
//! INVARIANT: the rendered config must never contain a key value or a canonical
//! Anthropic credential name (`ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`).

use crate::config::{LlmConfig, LlmProviderKind};
use std::path::{Path, PathBuf};

/// Port the proxy container listens on (fixed in the forwarder binary).
pub const PROXY_PORT: u16 = 4000;

/// In-network base URL of the proxy as the claude container sees it. Every
/// session (subscription + non-anthropic) points `ANTHROPIC_BASE_URL` here;
/// routing is by the model prefix in the request body, not the URL path.
pub const PROXY_BASE_URL: &str = "http://proxy:4000";

/// `SPW_KEY_<ID>` env name for a provider id (hyphens → underscores,
/// uppercased — same normalisation as `plugin::derive_worker_env`).
///
/// SSOT-alignment: the in-container inverse is
/// `containers/proxy/src/keys.rs::provider_id_from_env_name`. The
/// `spw_key_env_name_round_trips_with_proxy_reverse` test below pins
/// `reverse(forward(id)) == id`; changing this normalisation must update both.
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

/// Renders the proxy routing config for the project's provider set.
///
/// Emits a JSON object with a `routes` array consumed by the Rust forwarder
/// (see `containers/proxy/src/router.rs`). Pure — no filesystem
/// access; `write_proxy_config_in` persists the result.
pub fn render_proxy_config(llm: &LlmConfig) -> String {
    let mut routes = Vec::new();

    // OAuth vs API key render the same passthrough route; the kind is learned
    // host-side from the active provider (ADR-073) — never sniffed in the proxy.
    let anthropic_kind = match llm.active_provider().map(|p| p.kind) {
        Some(LlmProviderKind::AnthropicApiKey) => "anthropic_apikey",
        _ => "anthropic_oauth",
    };

    // Anthropic passthrough is always first — bare model names (no prefix)
    // resolve here. It forwards the caller's Authorization header unchanged.
    routes.push(format!(
        r#"{{"prefix":"anthropic","base_url":"https://api.anthropic.com","auth":"passthrough","provider_kind":"{anthropic_kind}","provider_id":"anthropic"}}"#
    ));

    for entry in &llm.providers {
        // Re-check: ids are embedded bare in JSON below.
        if !crate::plugin::is_valid_slug(&entry.id) {
            log::warn!("proxy config: skipping provider with invalid id");
            continue;
        }
        match entry.kind {
            // Subscription rides the /anthropic passthrough; no extra route.
            LlmProviderKind::AnthropicOauth => {}
            // API-key Anthropic: still passthrough — key is in /tokens, not here.
            LlmProviderKind::AnthropicApiKey => {}
            LlmProviderKind::OpenRouter => {
                let env = spw_key_env_name(&entry.id);
                let id = &entry.id;
                routes.push(format!(
                    r#"{{"prefix":"openrouter","base_url":"https://openrouter.ai/api","auth":{{"swap_env":"{env}","scheme":"bearer"}},"provider_kind":"openrouter","provider_id":"{id}"}}"#
                ));
            }
            LlmProviderKind::Local | LlmProviderKind::OpenAiCompat => {
                let Some(base_url) = entry.base_url.as_deref() else {
                    log::warn!(
                        "proxy config: provider '{}' has no base_url — skipped",
                        entry.id
                    );
                    continue;
                };
                // Re-validate before embedding bare in JSON.
                if let Err(e) = super::llm::validate_base_url(base_url) {
                    log::warn!(
                        "proxy config: provider '{}' has invalid base_url — skipped: {e}",
                        entry.id
                    );
                    continue;
                }
                // The forwarder appends `/v1/messages`; strip a trailing `/v1`
                // (common in Ollama/LiteLLM base URLs) so it isn't doubled.
                let base_url = super::llm::strip_trailing_v1(base_url);
                let id = &entry.id;
                let kind = match entry.kind {
                    LlmProviderKind::OpenAiCompat => "openai_compat",
                    _ => "local",
                };
                // Two distinct route shapes: object-auth (key swap) vs string-auth (none).
                if entry.has_api_key {
                    let env = spw_key_env_name(id);
                    routes.push(format!(
                        r#"{{"prefix":"{id}","base_url":"{base_url}","auth":{{"swap_env":"{env}","scheme":"bearer"}},"provider_kind":"{kind}","provider_id":"{id}"}}"#
                    ));
                } else {
                    routes.push(format!(
                        r#"{{"prefix":"{id}","base_url":"{base_url}","auth":"none","provider_kind":"{kind}","provider_id":"{id}"}}"#
                    ));
                }
            }
        }
    }

    let routes_json = routes.join(",");
    format!(r#"{{"routes":[{routes_json}]}}"#)
}

/// Renders and atomically persists the proxy routing config (0600 + fsync) under
/// `<data_dir>/proxy/<project>/`. Also lifts a legacy `local-llm/api_key`
/// into the llm token namespace (ADR-073 migration).
pub fn write_proxy_config_in(
    data_dir: &Path,
    project: &str,
    llm: &LlmConfig,
) -> anyhow::Result<PathBuf> {
    crate::validation::validate_project_name(project)?;
    let path = proxy_config_path_in(data_dir, project);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
        crate::fs_perms::ensure_owner_only_dir(parent)?;
    }
    migrate_legacy_local_key_in(data_dir, project, llm);
    // `has_api_key` is the on-disk key file's existence (config.rs), not the
    // persisted flag — a stale `false` would render `auth:none` and drop the
    // provider key, 401-ing a backend that requires it.
    let llm = sync_has_api_key_from_disk(data_dir, project, llm);
    let content = render_proxy_config(&llm);
    crate::fs_perms::write_restricted_file_atomic(&path, &content)?;
    Ok(path)
}

/// Returns a copy of `llm` with each provider's `has_api_key` set to whether
/// its key file actually exists on disk — the authoritative source.
fn sync_has_api_key_from_disk(data_dir: &Path, project: &str, llm: &LlmConfig) -> LlmConfig {
    let mut synced = llm.clone();
    for entry in &mut synced.providers {
        if let Ok(key_path) = super::tokens::llm_provider_key_path_in(data_dir, project, &entry.id)
        {
            entry.has_api_key = key_path.exists();
        }
    }
    synced
}

/// `SPW_CONFIG_DIGEST` value: sha256 over every rendered `/config` file and
/// every key file's name + content hash (key values folded in as their own
/// sha256, never raw). Changing it forces a proxy container recreate.
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

/// v1→v2 key-file migration: copies legacy `local-llm/api_key` into the llm
/// token namespace once when the target is missing. Non-fatal on failure.
fn migrate_legacy_local_key_in(data_dir: &Path, project: &str, llm: &LlmConfig) {
    let needs_local_key = llm
        .providers
        .iter()
        .any(|p| p.id == "local" && p.kind == LlmProviderKind::Local && p.has_api_key);
    if !needs_local_key {
        return;
    }
    let Ok(target) = super::tokens::llm_provider_key_path_in(data_dir, project, "local") else {
        return;
    };
    if target.exists() {
        return;
    }
    let Some(value) = super::llm::read_local_llm_token_opt_in(data_dir, project, "api_key") else {
        log::warn!("local entry flags has_api_key but no legacy key file to migrate");
        return;
    };
    if let Err(e) = write_llm_provider_key_in(data_dir, project, "local", &value) {
        log::warn!("litellm: legacy local key migration failed: {e}");
    } else {
        log::info!("litellm: migrated legacy local-llm api_key into the llm token namespace");
    }
}

/// Validates and persists one provider's API key under the llm token
/// namespace: strips a `Bearer ` prefix, rejects control chars and empty
/// values (ADR-040 rules).
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
#[allow(clippy::unwrap_used, clippy::expect_used)]
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
        assert!(out.contains("SPW_KEY_OPENROUTER")); // env NAME only
        assert!(!out.contains("callbacks")); // litellm callback machinery gone
    }

    #[test]
    fn spw_key_env_name_normalises_like_worker_env() {
        assert_eq!(spw_key_env_name("openrouter"), "SPW_KEY_OPENROUTER");
        assert_eq!(spw_key_env_name("my-anthropic"), "SPW_KEY_MY_ANTHROPIC");
    }

    /// Golden file: the full provider mix renders the expected JSON routing config.
    #[test]
    fn render_full_provider_mix_golden() {
        let llm = full_provider_mix();
        let expected = r#"{"routes":[{"prefix":"anthropic","base_url":"https://api.anthropic.com","auth":"passthrough","provider_kind":"anthropic_oauth","provider_id":"anthropic"},{"prefix":"local","base_url":"http://host.docker.internal:9000","auth":"none","provider_kind":"local","provider_id":"local"},{"prefix":"openrouter","base_url":"https://openrouter.ai/api","auth":{"swap_env":"SPW_KEY_OPENROUTER","scheme":"bearer"},"provider_kind":"openrouter","provider_id":"openrouter"}]}"#;
        assert_eq!(render_proxy_config(&llm), expected);
    }

    /// The anthropic passthrough route's kind reflects the active provider:
    /// `anthropic_apikey` when the active entry is an API key, else oauth.
    #[test]
    fn anthropic_route_kind_reflects_active_provider() {
        let mut cfg = full_provider_mix();
        cfg.active = Some(LlmActive {
            provider_id: "anthropic-key".into(),
            model: None,
        });
        let out = render_proxy_config(&cfg);
        assert!(out.contains(r#""prefix":"anthropic""#));
        assert!(out.contains(r#""provider_kind":"anthropic_apikey""#));
    }

    /// A local route carries its `provider_kind`/`provider_id`.
    #[test]
    fn local_route_carries_kind_and_id() {
        let out = render_proxy_config(&full_provider_mix());
        assert!(out.contains(
            r#"{"prefix":"local","base_url":"http://host.docker.internal:9000","auth":"none","provider_kind":"local","provider_id":"local"}"#
        ));
    }

    #[test]
    fn render_strips_trailing_v1_so_forwarder_does_not_double_it() {
        // The forwarder appends `/v1/messages`; a stored base_url ending in `/v1`
        // (common in Ollama/LiteLLM docs) must NOT survive into proxy.json, or
        // the upstream URL becomes `…/v1/v1/messages` → 404. (A trailing slash
        // is rejected by validate_base_url, so `/v1/` never reaches here.)
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
        // Only the built-in anthropic passthrough route.
        assert!(
            json.contains(r#""prefix":"anthropic""#),
            "anthropic passthrough must be present: {json}"
        );
        assert!(
            json.contains(r#""auth":"passthrough""#),
            "must be passthrough: {json}"
        );
        // No other routes for OAuth-only config.
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
        let path = write_proxy_config_in(dir.path(), "proj", &llm).unwrap();
        assert!(path.is_file());
        assert!(path.ends_with("proxy/proj/proxy.json"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "config must be owner-only");
        }
        // No callback file should be written.
        let callback = path.parent().unwrap().join("litellm_callback.py");
        assert!(
            !callback.exists(),
            "callback module must NOT be written by the forwarder config writer"
        );
    }

    /// v1→v2 key migration: a legacy `local-llm/api_key` is lifted into the
    /// llm namespace when the migrated entry references SPW_KEY_LOCAL —
    /// once, without clobbering an existing new-namespace key.
    #[test]
    fn write_config_migrates_legacy_local_key() {
        let dir = tempfile::tempdir().unwrap();
        // Seed the legacy key file.
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
        write_proxy_config_in(dir.path(), "proj", &llm).unwrap();

        let target =
            super::super::tokens::llm_provider_key_path_in(dir.path(), "proj", "local").unwrap();
        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            "sk-legacy-token",
            "legacy key must be copied (trimmed) into the llm namespace"
        );

        // Idempotent + non-clobbering: a newer key in the llm namespace wins.
        std::fs::write(&target, "sk-new-token").unwrap();
        write_proxy_config_in(dir.path(), "proj", &llm).unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "sk-new-token");

        // No legacy file + no target → non-fatal (dummy-key behaviour).
        let dir2 = tempfile::tempdir().unwrap();
        write_proxy_config_in(dir2.path(), "proj", &llm).unwrap();
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
        // Second removal: missing file is fine.
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
        write_proxy_config_in(dir.path(), "proj", &llm).unwrap();

        let d1 = proxy_state_digest_in(dir.path(), "proj");
        assert_eq!(d1.len(), 64);
        assert!(d1.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(d1, proxy_state_digest_in(dir.path(), "proj"));

        write_llm_provider_key_in(dir.path(), "proj", "openrouter", "sk-or-v1-abc").unwrap();
        let d2 = proxy_state_digest_in(dir.path(), "proj");
        assert_ne!(d1, d2);
        assert!(!d2.contains("sk-or-v1-abc"));

        // Same-length rotation must flip the digest: it hashes content, not size/mtime.
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
        write_proxy_config_in(dir.path(), "proj", &llm2).unwrap();
        assert_ne!(d1, proxy_state_digest_in(dir.path(), "proj"));
    }

    #[test]
    fn state_digest_covers_proxy_json() {
        let dir = tempfile::tempdir().unwrap();
        let llm = LlmConfig {
            providers: vec![entry("local", LlmProviderKind::Local)],
            ..Default::default()
        };
        write_proxy_config_in(dir.path(), "proj", &llm).unwrap();
        let d1 = proxy_state_digest_in(dir.path(), "proj");

        // Patching proxy.json must change the digest.
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
    fn render_uses_key_file_existence_over_stale_has_api_key_flag() {
        let dir = tempfile::tempdir().unwrap();
        // Config says local has NO key, but the key file exists on disk.
        let llm = LlmConfig {
            providers: vec![LlmProviderEntry {
                base_url: Some("http://10.0.0.1:4000".into()),
                ..entry("local", LlmProviderKind::Local)
            }],
            active: None,
            ..LlmConfig::default()
        };
        assert!(!llm.providers[0].has_api_key, "config flag is stale-false");
        write_llm_provider_key_in(dir.path(), "proj", "local", "sk-real").unwrap();
        let path = write_proxy_config_in(dir.path(), "proj", &llm).unwrap();
        let rendered = std::fs::read_to_string(&path).unwrap();
        // File exists → bearer swap, not auth:none — the key reaches the backend.
        assert!(
            rendered.contains(r#""swap_env":"SPW_KEY_LOCAL""#),
            "local route must use bearer when the key file exists: {rendered}"
        );
        assert!(!rendered
            .contains(r#""prefix":"local","base_url":"http://10.0.0.1:4000","auth":"none""#));
    }
}
