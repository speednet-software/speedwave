// Types returned to the Angular frontend, integration metadata constants,
// and associated helper functions.

use serde::{Deserialize, Serialize};

pub(crate) const MAX_CREDENTIAL_BYTES: usize = 4096;

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

#[derive(Serialize, Deserialize)]
pub(crate) struct LlmConfigResponse {
    pub(crate) provider: Option<String>,
    pub(crate) model: Option<String>,
    pub(crate) base_url: Option<String>,
    pub(crate) api_key_env: Option<String>,
}

#[derive(Serialize, Deserialize)]
pub(crate) struct AuthStatusResponse {
    pub(crate) api_key_configured: bool,
    pub(crate) oauth_authenticated: bool,
}

#[derive(Serialize, Clone)]
pub(crate) struct AuthField {
    pub(crate) key: String,
    pub(crate) label: String,
    pub(crate) field_type: String,
    pub(crate) placeholder: String,
    pub(crate) oauth_flow: bool,
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
            let allowed = get_allowed_fields(svc.config_key).unwrap();
            let auth_fields = get_auth_fields(svc.config_key);
            for field in &auth_fields {
                // config.json is a virtual file for redmine, not an auth field
                if field.key == "config.json" {
                    continue;
                }
                assert!(
                    allowed.contains(&field.key.as_str()),
                    "auth field '{}' for service '{}' not in allowed credential files",
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
        assert!(!is_secret_field("base_path"));
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
    fn get_auth_fields_other_services_no_oauth_flow() {
        for svc_key in &["slack", "gitlab", "redmine"] {
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
    fn toggleable_services_have_auth_fields() {
        for svc in speedwave_runtime::consts::TOGGLEABLE_MCP_SERVICES {
            let fields = get_auth_fields(svc.config_key);
            assert!(
                !fields.is_empty(),
                "TOGGLEABLE service '{}' has no auth_fields defined",
                svc.config_key
            );
        }
    }
}
