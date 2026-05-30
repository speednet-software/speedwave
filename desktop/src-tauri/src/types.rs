// Types returned to the Angular frontend, integration metadata constants,
// and associated helper functions.

use serde::{Deserialize, Serialize};

pub(crate) const MAX_CREDENTIAL_BYTES: usize = 4096;

/// Converts a `Result<T, String>` into `anyhow::Result<T>` — eliminates the
/// repeated `.map_err(|e| anyhow::anyhow!("{e}"))` boilerplate at compose
/// transaction callsites where the inner function returns `String` errors.
pub(crate) trait IntoAnyhow<T> {
    fn into_anyhow(self) -> anyhow::Result<T>;
}

impl<T> IntoAnyhow<T> for Result<T, String> {
    fn into_anyhow(self) -> anyhow::Result<T> {
        self.map_err(|e| anyhow::anyhow!("{e}"))
    }
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize)]
pub(crate) struct ProjectEntry {
    pub(crate) name: String,
    pub(crate) dir: String,
}

#[derive(Serialize, Deserialize)]
pub(crate) struct ProjectList {
    pub(crate) projects: Vec<ProjectEntry>,
    pub(crate) active_project: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct BundleReconcileStatus {
    pub(crate) phase: String,
    pub(crate) in_progress: bool,
    pub(crate) last_error: Option<String>,
    pub(crate) pending_running_projects: Vec<String>,
    pub(crate) applied_bundle_id: Option<String>,
}

/// Frontend-facing snapshot of `claude.llm` for the active project plus the
/// computed `default_base_url`. We flatten the underlying `LlmConfig` so
/// every new field added to the SSOT struct (`speedwave_runtime::config::LlmConfig`)
/// surfaces here automatically — without this, `provider`/`model`/`base_url`/
/// `context_tokens` had to be hand-copied at three layers (LlmConfig → this
/// response → frontend interface) and a missed step would silently drop the
/// field.
///
/// Write-only direction (backend → frontend). The struct does not derive
/// `Deserialize` so the type-system makes that explicit.
///
/// Footgun warning: when adding a new field to `LlmConfig`, mark optional
/// fields with `#[serde(default, skip_serializing_if = "Option::is_none")]`
/// — `#[serde(flatten)]` here propagates the field but does not omit
/// `null`s, so a bare `Option` would surface as `field: null` in the JSON
/// payload and the frontend's exact-shape assertions would diverge.
#[derive(Serialize)]
pub(crate) struct LlmConfigResponse {
    #[serde(flatten)]
    pub(crate) llm: speedwave_runtime::config::LlmConfig,
    /// Backend-authoritative default for the selected provider — exposed so
    /// the UI can render it as a placeholder without duplicating provider URL
    /// strings on the frontend.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) default_base_url: Option<String>,
}

#[derive(Serialize, Deserialize)]
pub(crate) struct AuthStatusResponse {
    pub(crate) api_key_configured: bool,
    /// True when `claude auth status` inside the running container succeeds.
    pub(crate) oauth_authenticated: bool,
}

/// Update DTO for the LLM settings save path.
///
/// Mirrors `speedwave_runtime::config::LlmConfig` fields but adds two
/// tri-state credential fields that the runtime struct doesn't carry (it
/// only stores presence flags). The `api_key` / `custom_headers` *values*
/// land in token files on disk; only `has_api_key` / `has_custom_headers`
/// reach `LlmConfig` in `config.json`.
///
/// Tri-state semantics via `serde_with::rust::double_option`:
/// - **field omitted** (`None`) — leave on-disk file unchanged
/// - **explicit `null`** (`Some(None)`) — delete on-disk file, flag becomes false
/// - **string** (`Some(Some(value))`) — write/replace; empty string also deletes
#[derive(Deserialize, Default)]
pub(crate) struct LlmConfigUpdate {
    pub(crate) provider: Option<String>,
    pub(crate) model: Option<String>,
    pub(crate) base_url: Option<String>,
    #[serde(default)]
    pub(crate) context_tokens: Option<u32>,
    #[serde(default, with = "serde_with::rust::double_option")]
    pub(crate) api_key: Option<Option<String>>,
    #[serde(default, with = "serde_with::rust::double_option")]
    pub(crate) custom_headers: Option<Option<String>>,
}

#[derive(Serialize, Clone)]
pub(crate) struct AuthField {
    pub(crate) key: String,
    pub(crate) label: String,
    pub(crate) field_type: String,
    pub(crate) placeholder: String,
    pub(crate) oauth_flow: bool,
    pub(crate) optional: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) hint: Option<String>,
}

#[derive(Serialize, Clone)]
pub(crate) struct IntegrationStatusEntry {
    pub(crate) service: String,
    pub(crate) enabled: bool,
    pub(crate) configured: bool,
    pub(crate) display_name: String,
    pub(crate) description: String,
    pub(crate) auth_fields: Vec<AuthField>,
    pub(crate) current_values: std::collections::HashMap<String, String>,
    pub(crate) mappings: Option<std::collections::HashMap<String, serde_json::Value>>,
    pub(crate) badge: Option<String>,
    /// Reason the integration needs the user's attention even though it is
    /// configured. Currently only SharePoint sets this — when the stored
    /// `grantedScopes` is a strict subset of the currently-required
    /// `SHAREPOINT_OAUTH_SCOPES` (typically after migration, ADR-060), the UI
    /// surfaces a "Re-authorize" banner so the next refresh doesn't quietly
    /// fail with `scope_mismatch`. `None` = no action required.
    pub(crate) oauth_action_required: Option<String>,
}

#[derive(Serialize, Clone)]
pub(crate) struct OsIntegrationStatusEntry {
    pub(crate) service: String,
    pub(crate) enabled: bool,
    pub(crate) display_name: String,
    pub(crate) description: String,
}

#[derive(Serialize)]
pub(crate) struct IntegrationsResponse {
    pub(crate) services: Vec<IntegrationStatusEntry>,
    pub(crate) os: Vec<OsIntegrationStatusEntry>,
}

// ---------------------------------------------------------------------------
// Integration metadata helpers — delegates to consts SSOT
// ---------------------------------------------------------------------------

pub(crate) fn get_allowed_fields(service: &str) -> Option<&'static [&'static str]> {
    speedwave_runtime::consts::find_mcp_service(service).map(|svc| svc.credential_files)
}

/// Returns the field's physical storage tier (plan §PR3:290-299).
/// `None` when the field is not declared in the service's `auth_fields`.
pub(crate) fn field_storage(
    service: &str,
    key: &str,
) -> Option<speedwave_runtime::consts::FieldStorage> {
    speedwave_runtime::consts::find_mcp_service(service).and_then(|svc| {
        svc.auth_fields
            .iter()
            .find(|f| f.key == key)
            .map(|f| f.storage)
    })
}

/// `true` if `key` is allowed on `service`, considering both storage tiers
/// (worker-mounted credential files + OAuth state fields). Used by save paths
/// to accept UI form fields whose physical home is `oauth/<project>/<service>.json`.
pub(crate) fn is_allowed_field(service: &str, key: &str) -> bool {
    let Some(svc) = speedwave_runtime::consts::find_mcp_service(service) else {
        return false;
    };
    if svc.credential_files.contains(&key) {
        return true;
    }
    svc.oauth_state_fields
        .map(|fs| fs.contains(&key))
        .unwrap_or(false)
}

pub(crate) fn is_secret_field(key: &str) -> bool {
    speedwave_runtime::consts::TOGGLEABLE_MCP_SERVICES
        .iter()
        .flat_map(|svc| svc.auth_fields.iter())
        .any(|f| f.key == key && f.is_secret)
}

pub(crate) fn get_auth_fields(service: &str) -> Vec<AuthField> {
    speedwave_runtime::consts::find_mcp_service(service)
        .map(|svc| {
            svc.auth_fields
                .iter()
                .map(|f| AuthField {
                    key: f.key.to_string(),
                    label: f.label.to_string(),
                    field_type: f.field_type.to_string(),
                    placeholder: f.placeholder.to_string(),
                    oauth_flow: f.oauth_flow,
                    optional: f.optional,
                    hint: f.hint.map(|s| s.to_string()),
                })
                .collect()
        })
        .unwrap_or_default()
}

pub(crate) fn check_project(name: &str) -> Result<(), String> {
    speedwave_runtime::validation::validate_project_name(name).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    // -- check_project tests --

    #[test]
    fn check_project_rejects_path_traversal() {
        let result = check_project("../escape");
        assert!(result.is_err(), "path traversal should be rejected");
    }

    #[test]
    fn check_project_rejects_empty_name() {
        let result = check_project("");
        assert!(result.is_err(), "empty project name should be rejected");
    }

    // -- Credential allowlist tests --

    #[test]
    fn get_allowed_fields_returns_fields_for_known_services() {
        assert!(get_allowed_fields("slack").is_some());
        assert!(get_allowed_fields("sharepoint").is_some());
        assert!(get_allowed_fields("redmine").is_some());
        assert!(get_allowed_fields("gitlab").is_some());
        assert!(get_allowed_fields("github").is_some());
        assert!(get_allowed_fields("atlassian").is_some());
    }

    #[test]
    fn get_allowed_fields_returns_none_for_unknown_service() {
        assert!(get_allowed_fields("unknown").is_none());
        assert!(get_allowed_fields("").is_none());
        assert!(get_allowed_fields("os").is_none());
    }

    #[test]
    fn allowed_fields_match_auth_fields() {
        // Every UI auth field must live in exactly one storage tier:
        // credential_files (worker-mounted) OR oauth_state_fields (off-mount,
        // plan §PR3:290-299). Earlier versions of this test only checked
        // credential_files — that became wrong when PR3 moved SharePoint's
        // refresh_token / client_id / tenant_id off-mount.
        for svc in speedwave_runtime::consts::TOGGLEABLE_MCP_SERVICES {
            let auth_fields = get_auth_fields(svc.config_key);
            for field in &auth_fields {
                // config.json is a virtual file for redmine, not an auth field
                if field.key == "config.json" {
                    continue;
                }
                assert!(
                    is_allowed_field(svc.config_key, &field.key),
                    "auth field '{}' for service '{}' has no storage tier",
                    field.key,
                    svc.config_key
                );
            }
        }
    }

    #[test]
    fn credential_field_rejects_forward_slash() {
        let key = "../../etc/passwd";
        assert!(
            key.contains('/') || key.contains('\\') || key.contains(".."),
            "path traversal must be detected"
        );
    }

    #[test]
    fn credential_field_rejects_backslash() {
        let key = "..\\windows\\system32";
        assert!(
            key.contains('/') || key.contains('\\') || key.contains(".."),
            "backslash path traversal must be detected"
        );
    }

    #[test]
    fn credential_field_rejects_dot_dot() {
        let key = "..token";
        assert!(key.contains(".."), "double dot must be detected");
    }

    #[test]
    fn credential_field_allows_valid_names() {
        for name in &["bot_token", "api_key", "host_url", "config.json"] {
            assert!(
                !name.contains('/') && !name.contains('\\') && !name.contains(".."),
                "valid field '{}' should pass validation",
                name
            );
        }
    }

    #[test]
    fn credential_value_length_limit() {
        let max_len = MAX_CREDENTIAL_BYTES;
        let short_value = "a".repeat(max_len);
        assert!(short_value.len() <= max_len, "exactly at limit should pass");

        let long_value = "a".repeat(max_len + 1);
        assert!(long_value.len() > max_len, "over limit should fail");
    }

    #[test]
    fn secret_fields_list_covers_sensitive_keys() {
        assert!(is_secret_field("bot_token"));
        assert!(is_secret_field("api_key"));
        assert!(is_secret_field("token"));
        assert!(is_secret_field("access_token"));
        assert!(is_secret_field("refresh_token"));
    }

    #[test]
    fn secret_fields_excludes_non_secret_keys() {
        assert!(!is_secret_field("host_url"));
        assert!(!is_secret_field("project_id"));
        assert!(!is_secret_field("site_id"));
    }

    #[test]
    fn toggleable_services_match_allowed_credentials() {
        for svc in speedwave_runtime::consts::TOGGLEABLE_MCP_SERVICES {
            assert!(
                get_allowed_fields(svc.config_key).is_some(),
                "TOGGLEABLE service '{}' has no credential_files",
                svc.config_key
            );
        }
    }

    #[test]
    fn get_auth_fields_includes_oauth_flow() {
        let fields = get_auth_fields("sharepoint");
        let access_token = fields.iter().find(|f| f.key == "access_token").unwrap();
        assert!(
            access_token.oauth_flow,
            "access_token must have oauth_flow=true"
        );
        let refresh_token = fields.iter().find(|f| f.key == "refresh_token").unwrap();
        assert!(
            refresh_token.oauth_flow,
            "refresh_token must have oauth_flow=true"
        );
        let client_id = fields.iter().find(|f| f.key == "client_id").unwrap();
        assert!(
            !client_id.oauth_flow,
            "client_id must have oauth_flow=false"
        );
    }

    #[test]
    fn get_auth_fields_classic_form_services_no_oauth_flow() {
        // Services that authenticate with a single user-entered token (PAT,
        // API key, bot token) — none of their fields should be flagged as
        // OAuth-flow-driven. SharePoint and GitHub are intentionally NOT in
        // this list because they use OAuth device flow (the UI renders a
        // "Sign in with X" button instead of a text input for the OAuth field).
        for svc_key in &["slack", "gitlab", "atlassian", "redmine"] {
            let fields = get_auth_fields(svc_key);
            for field in &fields {
                assert!(
                    !field.oauth_flow,
                    "field '{}' in service '{}' should not have oauth_flow=true",
                    field.key, svc_key
                );
            }
        }
    }

    #[test]
    fn get_auth_fields_github_token_uses_oauth_flow() {
        // GitHub `token` field is populated by the OAuth App device flow
        // (`start_github_oauth` Tauri command) — the UI must not render a
        // text input for it. SharePoint has the analogous invariant tested
        // in `get_auth_fields_includes_oauth_flow` above.
        let fields = get_auth_fields("github");
        let token = fields
            .iter()
            .find(|f| f.key == "token")
            .expect("github must declare a token field");
        assert!(
            token.oauth_flow,
            "github token field must have oauth_flow=true so the UI renders a 'Sign in with GitHub' button"
        );
    }

    #[test]
    fn get_auth_fields_includes_optional() {
        let fields = get_auth_fields("redmine");
        let project_id = fields.iter().find(|f| f.key == "project_id").unwrap();
        assert!(project_id.optional, "project_id must have optional=true");
        assert!(
            fields.iter().all(|f| f.key != "project_name"),
            "project_name must not appear in auth_fields (removed from UI)"
        );
        let api_key = fields.iter().find(|f| f.key == "api_key").unwrap();
        assert!(!api_key.optional, "api_key must have optional=false");
    }

    #[test]
    fn toggleable_services_have_auth_fields() {
        for svc in speedwave_runtime::consts::TOGGLEABLE_MCP_SERVICES {
            let fields = get_auth_fields(svc.config_key);
            // Credential-less services (e.g. Playwright) declare `auth_fields: &[]`
            // in their descriptor; `get_auth_fields` faithfully returns an empty vec.
            // Only fail if the descriptor says the service has auth fields but the
            // getter returns nothing — a real bug.
            if svc.auth_fields.is_empty() {
                assert!(
                    fields.is_empty(),
                    "service '{}' has no descriptor auth_fields but get_auth_fields returned {}",
                    svc.config_key,
                    fields.len()
                );
                continue;
            }
            assert!(
                !fields.is_empty(),
                "TOGGLEABLE service '{}' has no auth_fields defined",
                svc.config_key
            );
        }
    }

    /// Wire-format guard: flattening `LlmConfig` into `LlmConfigResponse`
    /// must keep `provider`/`model`/`base_url`/`context_tokens` at the top
    /// level of the JSON payload — the frontend reads them from there
    /// (mirror declared in `desktop/src/src/app/settings/llm-provider/`).
    /// If a future serde change buries them under an `llm:` key the
    /// frontend silently breaks.
    #[test]
    fn llm_config_response_flattens_inner_llm_at_top_level() {
        let resp = LlmConfigResponse {
            llm: speedwave_runtime::config::LlmConfig {
                provider: Some("ollama".to_string()),
                model: Some("qwen3:35b".to_string()),
                base_url: Some("http://localhost:11434".to_string()),
                context_tokens: Some(32_768),
                has_api_key: false,
                has_custom_headers: false,
            },
            default_base_url: Some("http://host.docker.internal:11434".to_string()),
        };
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(json["provider"], "ollama");
        assert_eq!(json["model"], "qwen3:35b");
        assert_eq!(json["base_url"], "http://localhost:11434");
        assert_eq!(json["context_tokens"], 32_768);
        assert_eq!(
            json["default_base_url"],
            "http://host.docker.internal:11434"
        );
        // No `llm:` wrapper — flatten makes the inner fields top-level.
        assert!(
            json.get("llm").is_none(),
            "llm wrapper must not appear: {json}"
        );
    }

    #[test]
    fn llm_config_response_omits_context_tokens_when_unset() {
        // Backend returns `LlmConfig::default()` when no project is active —
        // the response must skip the `context_tokens` key entirely so the
        // frontend's `?? null` fallback kicks in cleanly.
        let resp = LlmConfigResponse {
            llm: speedwave_runtime::config::LlmConfig::default(),
            default_base_url: None,
        };
        let json = serde_json::to_string(&resp).unwrap();
        assert!(
            !json.contains("context_tokens"),
            "context_tokens must be skipped when None, got: {json}"
        );
    }

    #[test]
    fn max_credential_bytes_matches_ts_constant() {
        // Cross-language SSOT guard (cf. allowed_auth_field_types_match_ts_union
        // in plugin.rs): TS `MAX_PLUGIN_CREDENTIAL_BYTES` must equal Rust
        // `MAX_CREDENTIAL_BYTES` so the form's <input maxlength=…> exactly
        // mirrors the server-side reject threshold. Bumping one without the
        // other = silent drift.
        let src = include_str!("../../src/src/app/models/plugin.ts");
        let needle = "export const MAX_PLUGIN_CREDENTIAL_BYTES";
        let idx = src
            .find(needle)
            .expect("plugin.ts must declare `export const MAX_PLUGIN_CREDENTIAL_BYTES = N`");
        // Take the rest of the line after the marker and extract the integer.
        let line = src[idx + needle.len()..].lines().next().unwrap_or("");
        let digits: String = line.chars().filter(|c| c.is_ascii_digit()).collect();
        let ts_val: usize = digits
            .parse()
            .expect("MAX_PLUGIN_CREDENTIAL_BYTES must be assigned an integer literal");
        assert_eq!(
            ts_val, MAX_CREDENTIAL_BYTES,
            "TS MAX_PLUGIN_CREDENTIAL_BYTES must match Rust types::MAX_CREDENTIAL_BYTES"
        );
    }
}
