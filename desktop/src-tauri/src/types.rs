// Types returned to the Angular frontend, integration metadata constants,
// and associated helper functions.

use serde::{Deserialize, Serialize};

pub(crate) const MAX_CREDENTIAL_BYTES: usize = 4096;

/// Converts a `Result<T, String>` into `anyhow::Result<T>`.
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

/// Write-only (backend → frontend) flattened snapshot of `claude.llm` plus
/// the computed `default_base_url`. Optional fields added to `LlmConfig` must
/// use `#[serde(default, skip_serializing_if = "Option::is_none")]`.
#[derive(Serialize)]
pub(crate) struct LlmConfigResponse {
    #[serde(flatten)]
    pub(crate) llm: speedwave_runtime::config::LlmConfig,
    /// Backend-authoritative default base URL for the selected provider.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) default_base_url: Option<String>,
}

/// Auth-status discriminant derived from the `AuthStatusResponse` flags.
/// Wire strings are snake_case: `no_provider` | `ready` | `auth_required`.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AuthReadiness {
    /// Fail-safe default: an absent/unknown status routes to provider setup.
    #[default]
    NoProvider,
    Ready,
    AuthRequired,
}

impl AuthReadiness {
    /// SSOT derivation (mirrors `authStatusToProjectStatus` in
    /// `project-state.service.ts`): no provider wins, then the R7 gate + flags.
    pub(crate) fn derive(
        provider_configured: bool,
        needs_anthropic_auth: bool,
        api_key_configured: bool,
        oauth_authenticated: bool,
    ) -> Self {
        if !provider_configured {
            return AuthReadiness::NoProvider;
        }
        if !needs_anthropic_auth || api_key_configured || oauth_authenticated {
            return AuthReadiness::Ready;
        }
        AuthReadiness::AuthRequired
    }
}

#[derive(Serialize, Deserialize)]
pub(crate) struct AuthStatusResponse {
    pub(crate) api_key_configured: bool,
    /// True when `claude auth status` inside the running container succeeds.
    pub(crate) oauth_authenticated: bool,
    /// Whether the active provider needs Anthropic auth at all (R7); `false`
    /// for non-anthropic kinds, so the UI gate never blocks on the two flags.
    pub(crate) needs_anthropic_auth: bool,
    /// False when the project has no active LLM provider (logout) — the UI shows
    /// "choose a provider" instead of a fake-ready chat.
    #[serde(default)]
    pub(crate) provider_configured: bool,
    /// Backend-derived discriminant (`AuthReadiness::derive`) — the frontend
    /// consumes this instead of re-deriving from the raw flags above.
    #[serde(default)]
    pub(crate) status: AuthReadiness,
}

impl AuthStatusResponse {
    /// Builds the response with `status` derived from the flags — the only
    /// constructor, so no site can ship an inconsistent discriminant.
    pub(crate) fn from_flags(
        api_key_configured: bool,
        oauth_authenticated: bool,
        needs_anthropic_auth: bool,
        provider_configured: bool,
    ) -> Self {
        Self {
            api_key_configured,
            oauth_authenticated,
            needs_anthropic_auth,
            provider_configured,
            status: AuthReadiness::derive(
                provider_configured,
                needs_anthropic_auth,
                api_key_configured,
                oauth_authenticated,
            ),
        }
    }
}

/// Update DTO for the LLM settings save path. Mirrors `LlmConfig` plus two
/// tri-state credential fields (`api_key`/`custom_headers`) stored off-config.
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
    /// v2 provider list (ADR-073). When present, replaces the stored list
    /// wholesale (the UI always sends the full set). Key VALUES never ride
    /// this DTO — they go through `set_llm_provider_key`.
    #[serde(default)]
    pub(crate) providers: Option<Vec<speedwave_runtime::config::LlmProviderEntry>>,
    /// v2 active provider+model selection (ADR-073).
    #[serde(default)]
    pub(crate) active: Option<speedwave_runtime::config::LlmActive>,
    /// ADR-073 kill-switch passthrough; omitted = leave unchanged.
    #[serde(default)]
    pub(crate) proxy_enabled: Option<bool>,
}

/// Which telemetry fields MDM locked, by semantic name — mirrors `TelemetryConfig`'s
/// field set so the UI greys the right controls without knowing any `OTEL_*` key.
#[derive(Serialize, Default)]
pub(crate) struct TelemetryLocks {
    pub(crate) enabled: bool,
    pub(crate) endpoint: bool,
    pub(crate) protocol: bool,
    pub(crate) export_metrics: bool,
    pub(crate) export_logs: bool,
    pub(crate) headers: bool,
    pub(crate) resource_attributes: bool,
    pub(crate) include_account_uuid: bool,
    pub(crate) log_user_prompts: bool,
    pub(crate) log_assistant_responses: bool,
    pub(crate) log_tool_details: bool,
    pub(crate) log_raw_api_bodies: bool,
    pub(crate) metric_export_interval_ms: bool,
    pub(crate) logs_export_interval_ms: bool,
}

/// Effective telemetry the frontend renders. Never carries the headers value —
/// only `has_headers` — so the secret stays on the host.
#[derive(Serialize)]
pub(crate) struct TelemetryConfigResponse {
    pub(crate) enabled: bool,
    pub(crate) endpoint: Option<String>,
    pub(crate) protocol: speedwave_runtime::config::OtlpProtocol,
    pub(crate) export_metrics: bool,
    pub(crate) export_logs: bool,
    /// True when a headers secret is set (the value itself is never sent).
    pub(crate) has_headers: bool,
    pub(crate) resource_attributes: Option<String>,
    pub(crate) include_account_uuid: bool,
    pub(crate) log_user_prompts: bool,
    pub(crate) log_assistant_responses: bool,
    pub(crate) log_tool_details: bool,
    pub(crate) log_raw_api_bodies: bool,
    pub(crate) metric_export_interval_ms: Option<u64>,
    pub(crate) logs_export_interval_ms: Option<u64>,
    /// Per-field lock flags so the UI greys locked fields.
    pub(crate) locks: TelemetryLocks,
    pub(crate) any_locked: bool,
    pub(crate) kill_switch: bool,
}

/// User-supplied telemetry update. `headers` is tri-state (omit = keep, null =
/// clear, string = replace). MDM-locked fields are ignored server-side.
#[derive(Deserialize, Default)]
pub(crate) struct TelemetryConfigUpdate {
    #[serde(default)]
    pub(crate) enabled: Option<bool>,
    #[serde(default, with = "serde_with::rust::double_option")]
    pub(crate) endpoint: Option<Option<String>>,
    #[serde(default)]
    pub(crate) protocol: Option<speedwave_runtime::config::OtlpProtocol>,
    #[serde(default)]
    pub(crate) export_metrics: Option<bool>,
    #[serde(default)]
    pub(crate) export_logs: Option<bool>,
    #[serde(default, with = "serde_with::rust::double_option")]
    pub(crate) headers: Option<Option<String>>,
    #[serde(default, with = "serde_with::rust::double_option")]
    pub(crate) resource_attributes: Option<Option<String>>,
    #[serde(default)]
    pub(crate) include_account_uuid: Option<bool>,
    #[serde(default)]
    pub(crate) log_user_prompts: Option<bool>,
    #[serde(default)]
    pub(crate) log_assistant_responses: Option<bool>,
    #[serde(default)]
    pub(crate) log_tool_details: Option<bool>,
    #[serde(default)]
    pub(crate) log_raw_api_bodies: Option<bool>,
    #[serde(default)]
    pub(crate) metric_export_interval_ms: Option<u64>,
    #[serde(default)]
    pub(crate) logs_export_interval_ms: Option<u64>,
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
    /// OAuth re-authorization required (stale scopes, expired token, etc.).
    /// `None` = no action required.
    pub(crate) oauth_action_required: Option<String>,
    /// "Connected to <workspace>" hint for OAuth services persisting identity
    /// in providerData (Slack: teamName · authedUserId). `None` = nothing to show.
    pub(crate) oauth_identity: Option<String>,
    /// IdP brand name for OAuth button copy, from the descriptor SSOT.
    pub(crate) oauth_provider_label: Option<String>,
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
        // Verify auth fields belong to credential_files or oauth_state_fields storage tier.
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
        // Descriptor-derived keys with is_secret=true.
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
        // Services using PAT/API key auth (not OAuth flows like SharePoint, GitHub, Slack).
        for svc_key in &["gitlab", "atlassian", "redmine"] {
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
        // GitHub `token` is populated by the OAuth App device flow, so oauth_flow=true.
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
            // Credential-less services (e.g. Playwright) declare `auth_fields: &[]`.
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

    /// Verify `#[serde(flatten)]` surfaces `LlmConfig` fields at top level (not nested under `llm:`).
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
                ..Default::default()
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
        // Default config (no active project) must skip the `context_tokens` key entirely.
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

    // ── AuthReadiness derivation (SSOT for the frontend discriminant) ──

    #[test]
    fn auth_readiness_no_provider_wins_over_everything() {
        // provider_configured=false → NoProvider regardless of the other flags.
        for needs in [false, true] {
            for key in [false, true] {
                for oauth in [false, true] {
                    assert_eq!(
                        AuthReadiness::derive(false, needs, key, oauth),
                        AuthReadiness::NoProvider,
                        "needs={needs} key={key} oauth={oauth}"
                    );
                }
            }
        }
    }

    #[test]
    fn auth_readiness_ready_when_no_anthropic_auth_needed() {
        // R7: non-anthropic providers are ready without any credential flag.
        assert_eq!(
            AuthReadiness::derive(true, false, false, false),
            AuthReadiness::Ready
        );
    }

    #[test]
    fn auth_readiness_ready_with_api_key_or_oauth() {
        assert_eq!(
            AuthReadiness::derive(true, true, true, false),
            AuthReadiness::Ready
        );
        assert_eq!(
            AuthReadiness::derive(true, true, false, true),
            AuthReadiness::Ready
        );
        assert_eq!(
            AuthReadiness::derive(true, true, true, true),
            AuthReadiness::Ready
        );
    }

    #[test]
    fn auth_readiness_auth_required_only_without_credentials() {
        assert_eq!(
            AuthReadiness::derive(true, true, false, false),
            AuthReadiness::AuthRequired
        );
    }

    #[test]
    fn auth_readiness_wire_strings_are_snake_case() {
        let cases = [
            (AuthReadiness::NoProvider, "\"no_provider\""),
            (AuthReadiness::Ready, "\"ready\""),
            (AuthReadiness::AuthRequired, "\"auth_required\""),
        ];
        for (v, wire) in cases {
            assert_eq!(serde_json::to_string(&v).unwrap(), wire);
            assert_eq!(serde_json::from_str::<AuthReadiness>(wire).unwrap(), v);
        }
    }

    #[test]
    fn auth_status_missing_provider_configured_deserializes_to_no_provider() {
        // Fail-safe: a legacy payload without `provider_configured`/`status`
        // reads as false → derives NoProvider (provider setup, not fake-ready).
        let json = r#"{
            "api_key_configured": true,
            "oauth_authenticated": true,
            "needs_anthropic_auth": true
        }"#;
        let resp: AuthStatusResponse = serde_json::from_str(json).unwrap();
        assert!(!resp.provider_configured);
        assert_eq!(resp.status, AuthReadiness::NoProvider);
        assert_eq!(
            AuthReadiness::derive(
                resp.provider_configured,
                resp.needs_anthropic_auth,
                resp.api_key_configured,
                resp.oauth_authenticated,
            ),
            AuthReadiness::NoProvider
        );
    }

    #[test]
    fn auth_status_from_flags_populates_consistent_status() {
        let resp = AuthStatusResponse::from_flags(false, true, true, true);
        assert_eq!(resp.status, AuthReadiness::Ready);
        let resp = AuthStatusResponse::from_flags(false, false, true, true);
        assert_eq!(resp.status, AuthReadiness::AuthRequired);
        let resp = AuthStatusResponse::from_flags(true, true, true, false);
        assert_eq!(resp.status, AuthReadiness::NoProvider);
    }

    #[test]
    fn max_credential_bytes_matches_ts_constant() {
        // Cross-language SSOT guard: TS `MAX_PLUGIN_CREDENTIAL_BYTES` must equal Rust `MAX_CREDENTIAL_BYTES`.
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
