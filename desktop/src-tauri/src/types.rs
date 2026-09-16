use serde::{Deserialize, Serialize};

pub(crate) const MAX_CREDENTIAL_BYTES: usize = 4096;

pub(crate) trait IntoAnyhow<T> {
    fn into_anyhow(self) -> anyhow::Result<T>;
}

impl<T> IntoAnyhow<T> for Result<T, String> {
    fn into_anyhow(self) -> anyhow::Result<T> {
        self.map_err(|e| anyhow::anyhow!("{e}"))
    }
}

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

#[derive(Serialize)]
pub(crate) struct LlmConfigResponse {
    #[serde(flatten)]
    pub(crate) llm: speedwave_runtime::config::LlmConfig,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) default_base_url: Option<String>,
}

#[derive(Serialize)]
pub(crate) struct AnthropicModelWire {
    #[serde(flatten)]
    pub(crate) info: speedwave_runtime::defaults::AnthropicModelInfo,
    pub(crate) has_1m: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AuthReadiness {
    #[default]
    NoProvider,
    Ready,
    AuthRequired,
}

impl AuthReadiness {
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

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub(crate) enum OauthSignIn {
    Verified,
    SavedUnverified,
    #[default]
    None,
}

#[derive(Serialize, Deserialize)]
pub(crate) struct AuthStatusResponse {
    pub(crate) api_key_configured: bool,
    pub(crate) oauth_authenticated: bool,
    pub(crate) needs_anthropic_auth: bool,
    #[serde(default)]
    pub(crate) provider_configured: bool,
    #[serde(default)]
    pub(crate) status: AuthReadiness,
    #[serde(default)]
    pub(crate) oauth_sign_in: OauthSignIn,
}

impl AuthStatusResponse {
    pub(crate) fn from_flags(
        api_key_configured: bool,
        oauth_sign_in: OauthSignIn,
        needs_anthropic_auth: bool,
        provider_configured: bool,
    ) -> Self {
        let oauth_authenticated = oauth_sign_in == OauthSignIn::Verified;
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
            oauth_sign_in,
        }
    }
}

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
    #[serde(default)]
    pub(crate) providers: Option<Vec<speedwave_runtime::config::LlmProviderEntry>>,
    #[serde(default)]
    pub(crate) active: Option<speedwave_runtime::config::LlmActive>,
    #[serde(default)]
    pub(crate) proxy_enabled: Option<bool>,
}

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

#[derive(Serialize)]
pub(crate) struct TelemetryConfigResponse {
    pub(crate) enabled: bool,
    pub(crate) endpoint: Option<String>,
    pub(crate) protocol: speedwave_runtime::config::OtlpProtocol,
    pub(crate) export_metrics: bool,
    pub(crate) export_logs: bool,
    pub(crate) has_headers: bool,
    pub(crate) resource_attributes: Option<String>,
    pub(crate) include_account_uuid: bool,
    pub(crate) log_user_prompts: bool,
    pub(crate) log_assistant_responses: bool,
    pub(crate) log_tool_details: bool,
    pub(crate) log_raw_api_bodies: bool,
    pub(crate) metric_export_interval_ms: Option<u64>,
    pub(crate) logs_export_interval_ms: Option<u64>,
    pub(crate) locks: TelemetryLocks,
    pub(crate) any_locked: bool,
    pub(crate) kill_switch: bool,
}

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
    #[serde(default, with = "serde_with::rust::double_option")]
    pub(crate) metric_export_interval_ms: Option<Option<u64>>,
    #[serde(default, with = "serde_with::rust::double_option")]
    pub(crate) logs_export_interval_ms: Option<Option<u64>>,
}

#[derive(Serialize, Clone)]
pub(crate) struct PiiRuleInfo {
    pub(crate) id: String,
    pub(crate) display_name: String,
}

#[derive(Serialize, Clone)]
pub(crate) struct SecurityPolicyTemplateInfo {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) categories:
        std::collections::HashMap<String, speedwave_runtime::pii_policy::RuleFlags>,
}

#[derive(Serialize, Clone)]
pub(crate) struct CustomPolicyDto {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) categories:
        std::collections::HashMap<String, speedwave_runtime::pii_policy::RuleFlags>,
    pub(crate) rules: Vec<speedwave_runtime::pii_policy::OwnRuleV3>,
    #[serde(default)]
    pub(crate) keywords: Vec<speedwave_runtime::pii_policy::KeywordV3>,
}

#[derive(Serialize)]
pub(crate) struct SecurityPolicyResponse {
    pub(crate) enabled_policies: Vec<String>,
    pub(crate) forced_policies: Vec<String>,
    pub(crate) effective_rules: Vec<speedwave_runtime::pii_policy::RuleOutput>,
    pub(crate) custom_policies: Vec<CustomPolicyDto>,
}

#[derive(Deserialize, Clone)]
pub(crate) struct SecurityPolicyCustomPatternInput {
    pub(crate) display_name: String,
    pub(crate) pattern: String,
    pub(crate) case_insensitive: bool,
}

#[derive(Deserialize, Clone)]
pub(crate) struct CustomPolicyDtoInput {
    pub(crate) name: String,
    pub(crate) enabled: bool,
    pub(crate) categories:
        std::collections::HashMap<String, speedwave_runtime::pii_policy::RuleFlags>,
    pub(crate) custom_patterns: Vec<SecurityPolicyCustomPatternInput>,
    #[serde(default)]
    pub(crate) keywords: Vec<speedwave_runtime::pii_policy::KeywordV3>,
}

#[derive(Deserialize)]
pub(crate) struct SecurityPolicyUpdate {
    pub(crate) policies: Vec<String>,
    pub(crate) custom_policies: Vec<CustomPolicyDtoInput>,
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
    pub(crate) oauth_action_required: Option<String>,
    pub(crate) oauth_identity: Option<String>,
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

pub(crate) fn get_allowed_fields(service: &str) -> Option<&'static [&'static str]> {
    speedwave_runtime::consts::find_mcp_service(service).map(|svc| svc.credential_files)
}

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

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "test assertions use unwrap/expect"
)]
mod tests {
    use super::*;

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
        for svc in speedwave_runtime::consts::TOGGLEABLE_MCP_SERVICES {
            let auth_fields = get_auth_fields(svc.config_key);
            for field in &auth_fields {
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
        assert!(
            json.get("llm").is_none(),
            "llm wrapper must not appear: {json}"
        );
    }

    #[test]
    fn llm_config_response_omits_context_tokens_when_unset() {
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
    fn auth_readiness_no_provider_wins_over_everything() {
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
        let resp = AuthStatusResponse::from_flags(false, OauthSignIn::Verified, true, true);
        assert_eq!(resp.status, AuthReadiness::Ready);
        let resp = AuthStatusResponse::from_flags(false, OauthSignIn::None, true, true);
        assert_eq!(resp.status, AuthReadiness::AuthRequired);
        let resp = AuthStatusResponse::from_flags(true, OauthSignIn::Verified, true, false);
        assert_eq!(resp.status, AuthReadiness::NoProvider);
    }

    #[test]
    fn oauth_sign_in_default_is_none() {
        assert_eq!(OauthSignIn::default(), OauthSignIn::None);
    }

    #[test]
    fn oauth_sign_in_wire_strings_are_snake_case() {
        let cases = [
            (OauthSignIn::Verified, "\"verified\""),
            (OauthSignIn::SavedUnverified, "\"saved_unverified\""),
            (OauthSignIn::None, "\"none\""),
        ];
        for (v, wire) in cases {
            assert_eq!(serde_json::to_string(&v).unwrap(), wire);
            assert_eq!(serde_json::from_str::<OauthSignIn>(wire).unwrap(), v);
        }
    }

    #[test]
    fn oauth_sign_in_matches_ts_union() {
        let all = [
            OauthSignIn::Verified,
            OauthSignIn::SavedUnverified,
            OauthSignIn::None,
        ];
        for v in all {
            match v {
                OauthSignIn::Verified | OauthSignIn::SavedUnverified | OauthSignIn::None => {}
            }
        }
        let mut rust: Vec<String> = all
            .iter()
            .map(|v| {
                serde_json::to_value(v)
                    .unwrap()
                    .as_str()
                    .unwrap()
                    .to_string()
            })
            .collect();
        rust.sort();

        let src = include_str!("../../src/src/app/services/project-state.service.ts");
        let marker = "export type OauthSignIn =";
        let idx = src
            .find(marker)
            .expect("project-state.service.ts must declare `export type OauthSignIn`");
        let union = src[idx + marker.len()..].split(';').next().unwrap_or("");
        let mut ts: Vec<String> = union
            .split('|')
            .map(|s| s.trim().trim_matches('\'').to_string())
            .filter(|s| !s.is_empty())
            .collect();
        ts.sort();

        assert_eq!(
            rust, ts,
            "TS OauthSignIn union must match Rust OauthSignIn serde strings"
        );
    }

    #[test]
    fn from_flags_sets_oauth_authenticated_true_only_when_verified() {
        let resp = AuthStatusResponse::from_flags(false, OauthSignIn::Verified, true, true);
        assert!(resp.oauth_authenticated);
        assert_eq!(resp.oauth_sign_in, OauthSignIn::Verified);

        for not_verified in [OauthSignIn::SavedUnverified, OauthSignIn::None] {
            let resp = AuthStatusResponse::from_flags(false, not_verified, true, true);
            assert!(!resp.oauth_authenticated);
            assert_eq!(resp.oauth_sign_in, not_verified);
        }
    }

    #[test]
    fn max_credential_bytes_matches_ts_constant() {
        let src = include_str!("../../src/src/app/models/plugin.ts");
        let needle = "export const MAX_PLUGIN_CREDENTIAL_BYTES";
        let idx = src
            .find(needle)
            .expect("plugin.ts must declare `export const MAX_PLUGIN_CREDENTIAL_BYTES = N`");
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

    #[test]
    fn anthropic_model_wire_fields_match_ts_mirror() {
        const UNMIRRORED: &[&str] = &["pricing", "pricing_1m"];

        let sample = speedwave_runtime::defaults::ANTHROPIC_MODELS
            .first()
            .expect("catalog must not be empty");
        let wire = AnthropicModelWire {
            info: sample.clone(),
            has_1m: sample.has_1m(),
        };
        let json = serde_json::to_value(&wire).expect("AnthropicModelWire must serialize");
        let mut rust: Vec<&str> = json
            .as_object()
            .expect("wire serializes as an object")
            .keys()
            .map(String::as_str)
            .filter(|k| !UNMIRRORED.contains(k))
            .collect();
        rust.sort_unstable();

        let ts_src = include_str!("../../src/src/app/models/llm.ts");
        let marker = "export interface AnthropicModel {";
        let idx = ts_src
            .find(marker)
            .expect("llm.ts must declare `export interface AnthropicModel`");
        let body = ts_src[idx + marker.len()..]
            .split('}')
            .next()
            .expect("the AnthropicModel interface must be closed");
        let mut ts: Vec<&str> = body
            .lines()
            .filter_map(|l| l.split(':').next())
            .map(str::trim)
            .filter(|s| !s.is_empty() && !s.starts_with('/') && !s.starts_with('*'))
            .collect();
        ts.sort_unstable();

        assert_eq!(
            rust, ts,
            "TS AnthropicModel must mirror AnthropicModelWire, minus pricing/pricing_1m"
        );
    }
}
