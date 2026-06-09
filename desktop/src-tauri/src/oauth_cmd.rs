// SharePoint OAuth Device Code Flow. Two-file persistence per ADR-060.

use crate::oauth_flow::{self, save_credential_file, DeviceCodeInfo, FlowRegistry};
use crate::types::check_project;
use serde::Deserialize;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

const PROGRESS_EVENT: &str = "sharepoint_oauth_progress";

// ---------------------------------------------------------------------------
// Serde DTOs — Microsoft identity platform responses
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct MsDeviceCodeResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    expires_in: u64,
    interval: u64,
    #[serde(rename = "message")]
    _message: String,
}

#[derive(Deserialize)]
struct MsTokenResponse {
    access_token: String,
    refresh_token: String,
    #[serde(rename = "token_type")]
    _token_type: String,
    expires_in: u64,
}

impl MsTokenResponse {
    fn expires_in(&self) -> u64 {
        self.expires_in
    }
}

#[derive(Deserialize)]
struct MsTokenErrorResponse {
    error: String,
    error_description: Option<String>,
}

static FLOW_STATE: FlowRegistry = FlowRegistry::new(PROGRESS_EVENT);

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

fn validate_tenant_id(tenant_id: &str) -> Result<(), String> {
    if tenant_id.is_empty() {
        return Err("tenant_id is required".to_string());
    }
    if tenant_id.contains('\0') {
        return Err("tenant_id contains null byte".to_string());
    }
    if tenant_id.len() > 253 {
        return Err("tenant_id exceeds 253 characters".to_string());
    }

    if matches!(tenant_id, "common" | "organizations" | "consumers") {
        return Ok(());
    }

    let stripped = tenant_id.replace('-', "");
    if stripped.len() == 32 && stripped.chars().all(|c| c.is_ascii_hexdigit()) {
        return Ok(());
    }

    // FQDN-like: alphanumeric, dots, hyphens; must start and end with alphanumeric.
    let bytes = tenant_id.as_bytes();
    let first = bytes[0];
    let last = bytes[bytes.len() - 1];
    if !first.is_ascii_alphanumeric() || !last.is_ascii_alphanumeric() {
        return Err(format!("invalid tenant_id: {tenant_id}"));
    }
    if tenant_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
    {
        return Ok(());
    }

    Err(format!("invalid tenant_id: {tenant_id}"))
}

fn save_oauth_state(
    project: &str,
    service: &str,
    client_id: &str,
    tenant_id: &str,
    refresh_token: &str,
    scopes: &str,
    expires_in: u64,
) -> Result<(), String> {
    let max = crate::types::MAX_CREDENTIAL_BYTES;
    if refresh_token.len() > max {
        return Err(format!("refresh_token exceeds {max} bytes"));
    }
    let scopes_vec: Vec<String> = scopes.split_whitespace().map(String::from).collect();
    let mut provider_data = std::collections::BTreeMap::new();
    provider_data.insert("clientId".to_string(), client_id.to_string());
    provider_data.insert("tenantId".to_string(), tenant_id.to_string());

    let path = speedwave_runtime::plugin::oauth_state_file(project, service);
    speedwave_runtime::oauth_persist::write_oauth_state(
        &path,
        &speedwave_runtime::oauth_persist::OAuthStateParams {
            provider: crate::oauth_providers::MICROSOFT_PROVIDER_ID,
            grant_type: None,
            provider_data,
            scopes: scopes_vec.clone(),
            granted_scopes: scopes_vec,
            refresh_token,
            expires_in,
        },
    )
}

/// Keeps the AADSTS trace code; drops free text (ADR-060 live-compromise).
/// Mirror of `redactErrorDescription` in `mcp-servers/oauth/src/providers/microsoft.ts`.
fn redact_ms_error_description(raw: &str) -> String {
    if raw.is_empty() {
        return "no description".to_string();
    }
    let bytes = raw.as_bytes();
    if let Some(start) = raw.find("AADSTS") {
        let mut end = start + "AADSTS".len();
        while end < bytes.len() && bytes[end].is_ascii_digit() {
            end += 1;
        }
        if end > start + "AADSTS".len() {
            return raw[start..end].to_string();
        }
    }
    "redacted".to_string()
}

/// Classifies a Microsoft token-poll body into a [`PollAction`], or `Ok(())`
/// when it carries tokens. Pure — the shared poll loop drives the effects.
fn classify_sharepoint_response(status: u16, bytes: &[u8]) -> Result<(), oauth_flow::PollAction> {
    use oauth_flow::PollAction;
    if serde_json::from_slice::<MsTokenResponse>(bytes).is_ok() {
        return Ok(());
    }
    if let Ok(err) = serde_json::from_slice::<MsTokenErrorResponse>(bytes) {
        return Err(match err.error.as_str() {
            "authorization_pending" => PollAction::KeepPolling,
            "slow_down" => PollAction::SlowDown,
            "expired_token" => {
                PollAction::Expired("Device code expired — please try again".to_string())
            }
            "authorization_declined" => {
                PollAction::Failed("Authorization was declined".to_string())
            }
            "bad_verification_code" => PollAction::Failed("Invalid verification code".to_string()),
            other => {
                let msg = err
                    .error_description
                    .as_deref()
                    .map(redact_ms_error_description)
                    .unwrap_or_else(|| other.to_string());
                PollAction::Failed(msg)
            }
        });
    }
    let preview = String::from_utf8_lossy(bytes);
    let truncated = preview.chars().take(200).collect::<String>();
    Err(PollAction::Failed(format!(
        "Unexpected response from Microsoft (HTTP {status}): {truncated}"
    )))
}

fn save_tokens(
    project: &str,
    client_id: &str,
    tenant_id: &str,
    tokens: &MsTokenResponse,
) -> Result<(), String> {
    let svc_dir =
        speedwave_runtime::plugin::token_dir(project, "sharepoint").map_err(|e| e.to_string())?;
    save_credential_file(&svc_dir, "access_token", &tokens.access_token)?;
    save_oauth_state(
        project,
        "sharepoint",
        client_id,
        tenant_id,
        &tokens.refresh_token,
        speedwave_runtime::consts::SHAREPOINT_OAUTH_SCOPES,
        tokens.expires_in(),
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn start_sharepoint_oauth(
    project: String,
    client_id: String,
    tenant_id: String,
    app: tauri::AppHandle,
) -> Result<DeviceCodeInfo, String> {
    check_project(&project)?;

    uuid::Uuid::parse_str(&client_id).map_err(|_| "client_id must be a valid UUID".to_string())?;
    validate_tenant_id(&tenant_id)?;

    let request_id = uuid::Uuid::new_v4().to_string();
    let cancel_token = CancellationToken::new();
    let my_generation = FLOW_STATE.install(request_id.clone(), cancel_token.clone())?;

    let scopes = speedwave_runtime::consts::SHAREPOINT_OAUTH_SCOPES;
    let devicecode_url = format!(
        "https://login.microsoftonline.com/{}/oauth2/v2.0/devicecode",
        tenant_id
    );
    let body = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("client_id", &client_id)
        .append_pair("scope", scopes)
        .finish();

    let http_client = crate::http_util::build_hardened_client(None).inspect_err(|_| {
        FLOW_STATE.clear_if_current(&request_id);
    })?;
    let resp = http_client
        .post(&devicecode_url)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(body)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| {
            FLOW_STATE.clear_if_current(&request_id);
            format!("Failed to contact Microsoft: {e}")
        })?;

    let status = resp.status();
    let body_bytes = crate::http_util::read_body_limited(resp, "device code")
        .await
        .inspect_err(|_| {
            FLOW_STATE.clear_if_current(&request_id);
        })?;

    if !status.is_success() {
        let preview = String::from_utf8_lossy(&body_bytes);
        FLOW_STATE.clear_if_current(&request_id);
        return Err(format!(
            "Microsoft device code request failed (HTTP {status}): {preview}"
        ));
    }

    let dc_resp: MsDeviceCodeResponse = serde_json::from_slice(&body_bytes).map_err(|e| {
        FLOW_STATE.clear_if_current(&request_id);
        format!("Failed to parse device code response: {e}")
    })?;

    if FLOW_STATE.current_generation()? != my_generation {
        FLOW_STATE.clear_if_current(&request_id);
        return Err("OAuth flow was cancelled".to_string());
    }

    let info = DeviceCodeInfo {
        user_code: dc_resp.user_code.clone(),
        verification_uri: dc_resp.verification_uri.clone(),
        expires_in: dc_resp.expires_in,
        request_id: request_id.clone(),
    };

    let poll_project = project.clone();
    let poll_client_id = client_id.clone();
    let poll_tenant_id = tenant_id.clone();
    let token_url = format!("https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token");
    let form_body = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("grant_type", "urn:ietf:params:oauth:grant-type:device_code")
        .append_pair("client_id", &client_id)
        .append_pair("device_code", &dc_resp.device_code)
        .finish();

    oauth_flow::run_device_poll(
        app,
        &FLOW_STATE,
        request_id,
        oauth_flow::DevicePollConfig {
            client: http_client,
            token_url,
            form_body,
            accept_json: false,
            interval_secs: dc_resp.interval,
            expires_in_secs: dc_resp.expires_in,
        },
        cancel_token,
        classify_sharepoint_response,
        move |bytes| {
            let tokens: MsTokenResponse =
                serde_json::from_slice(bytes).map_err(|e| format!("parse token: {e}"))?;
            save_tokens(&poll_project, &poll_client_id, &poll_tenant_id, &tokens)
        },
    );

    Ok(info)
}

#[tauri::command]
pub fn cancel_sharepoint_oauth() {
    FLOW_STATE.cancel();
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use serial_test::serial;

    // -- Tenant ID validation --

    #[test]
    fn validate_tenant_id_accepts_uuid_with_hyphens() {
        assert!(validate_tenant_id("550e8400-e29b-41d4-a716-446655440000").is_ok());
    }

    #[test]
    fn validate_tenant_id_accepts_uuid_without_hyphens() {
        assert!(validate_tenant_id("550e8400e29b41d4a716446655440000").is_ok());
    }

    #[test]
    fn validate_tenant_id_accepts_common() {
        assert!(validate_tenant_id("common").is_ok());
    }

    #[test]
    fn validate_tenant_id_accepts_organizations() {
        assert!(validate_tenant_id("organizations").is_ok());
    }

    #[test]
    fn validate_tenant_id_accepts_consumers() {
        assert!(validate_tenant_id("consumers").is_ok());
    }

    #[test]
    fn validate_tenant_id_accepts_fqdn() {
        assert!(validate_tenant_id("contoso.onmicrosoft.com").is_ok());
    }

    #[test]
    fn validate_tenant_id_rejects_empty() {
        assert!(validate_tenant_id("").is_err());
    }

    #[test]
    fn validate_tenant_id_rejects_path_traversal() {
        assert!(validate_tenant_id("../evil").is_err());
    }

    #[test]
    fn validate_tenant_id_rejects_query_injection() {
        assert!(validate_tenant_id("tenant?inject=1").is_err());
    }

    #[test]
    fn validate_tenant_id_rejects_fragment() {
        assert!(validate_tenant_id("tenant#fragment").is_err());
    }

    #[test]
    fn validate_tenant_id_rejects_spaces() {
        assert!(validate_tenant_id("tenant with spaces").is_err());
    }

    #[test]
    fn validate_tenant_id_rejects_percent() {
        assert!(validate_tenant_id("tenant%20encoded").is_err());
    }

    #[test]
    fn validate_tenant_id_rejects_null_byte() {
        assert!(validate_tenant_id("tenant\0evil").is_err());
    }

    #[test]
    fn validate_tenant_id_rejects_backslash() {
        assert!(validate_tenant_id("tenant\\evil").is_err());
    }

    #[test]
    fn validate_tenant_id_rejects_over_253_chars() {
        let long = "a".repeat(254);
        assert!(validate_tenant_id(&long).is_err());
    }

    #[test]
    fn validate_tenant_id_accepts_253_chars() {
        let long = "a".repeat(253);
        assert!(validate_tenant_id(&long).is_ok());
    }

    // -- Client ID validation (UUID) --

    #[test]
    fn client_id_accepts_valid_uuid() {
        assert!(uuid::Uuid::parse_str("550e8400-e29b-41d4-a716-446655440000").is_ok());
    }

    #[test]
    fn client_id_rejects_non_uuid() {
        assert!(uuid::Uuid::parse_str("not-a-uuid").is_err());
    }

    // -- DTO deserialization --

    #[test]
    fn ms_device_code_response_deserializes() {
        let json = r#"{
            "device_code": "dc123",
            "user_code": "ABCD1234",
            "verification_uri": "https://microsoft.com/devicelogin",
            "expires_in": 900,
            "interval": 5,
            "message": "Enter code ABCD1234"
        }"#;
        let resp: MsDeviceCodeResponse = serde_json::from_str(json).unwrap();
        assert_eq!(resp.device_code, "dc123");
        assert_eq!(resp.user_code, "ABCD1234");
        assert_eq!(resp.verification_uri, "https://microsoft.com/devicelogin");
        assert_eq!(resp.expires_in, 900);
        assert_eq!(resp.interval, 5);
    }

    #[test]
    fn ms_token_response_deserializes() {
        let json = r#"{
            "access_token": "eyJ...",
            "refresh_token": "0.AR...",
            "token_type": "Bearer",
            "expires_in": 3600
        }"#;
        let resp: MsTokenResponse = serde_json::from_str(json).unwrap();
        assert_eq!(resp.access_token, "eyJ...");
        assert_eq!(resp.refresh_token, "0.AR...");
    }

    #[test]
    fn ms_token_error_response_deserializes_expired() {
        let json = r#"{
            "error": "expired_token",
            "error_description": "The device code has expired"
        }"#;
        let resp: MsTokenErrorResponse = serde_json::from_str(json).unwrap();
        assert_eq!(resp.error, "expired_token");
        assert_eq!(
            resp.error_description.unwrap(),
            "The device code has expired"
        );
    }

    #[test]
    fn ms_token_error_response_deserializes_declined() {
        let json = r#"{"error": "authorization_declined"}"#;
        let resp: MsTokenErrorResponse = serde_json::from_str(json).unwrap();
        assert_eq!(resp.error, "authorization_declined");
        assert!(resp.error_description.is_none());
    }

    #[test]
    fn ms_token_error_response_deserializes_bad_code() {
        let json = r#"{"error": "bad_verification_code", "error_description": "Bad code"}"#;
        let resp: MsTokenErrorResponse = serde_json::from_str(json).unwrap();
        assert_eq!(resp.error, "bad_verification_code");
    }

    // -- redact_ms_error_description --

    #[test]
    fn redact_keeps_aadsts_code_and_drops_free_text() {
        let raw = "AADSTS50158: External challenge; UPN=alice@contoso.com; tenant=11111111-2222-3333-4444-555555555555; policy=\"Require Compliant Device\"";
        let out = redact_ms_error_description(raw);
        assert_eq!(out, "AADSTS50158");
        assert!(!out.contains("alice@contoso.com"));
        assert!(!out.contains("contoso"));
        assert!(!out.contains("Require Compliant Device"));
    }

    #[test]
    fn redact_returns_placeholder_for_non_aadsts() {
        assert_eq!(
            redact_ms_error_description("unexpected free-form leak"),
            "redacted"
        );
    }

    #[test]
    fn redact_returns_no_description_for_empty() {
        assert_eq!(redact_ms_error_description(""), "no description");
    }

    // -- save_oauth_state (ADR-060 split) --

    #[test]
    #[serial]
    fn save_oauth_state_writes_json_with_required_fields() {
        let tmp = tempfile::tempdir().unwrap();
        let prev = std::env::var("SPEEDWAVE_DATA_DIR").ok();
        std::env::set_var("SPEEDWAVE_DATA_DIR", tmp.path());

        save_oauth_state(
            "test-project",
            "sharepoint",
            "11111111-1111-1111-1111-111111111111",
            "common",
            "rt-secret",
            speedwave_runtime::consts::SHAREPOINT_OAUTH_SCOPES,
            3600,
        )
        .unwrap();

        let path = speedwave_runtime::plugin::oauth_state_file("test-project", "sharepoint");
        let content = std::fs::read_to_string(&path).unwrap();
        let json: serde_json::Value = serde_json::from_str(&content).unwrap();
        assert_eq!(json["provider"], "microsoft");
        assert_eq!(
            json["providerData"]["clientId"],
            "11111111-1111-1111-1111-111111111111"
        );
        assert_eq!(json["providerData"]["tenantId"], "common");
        assert!(json.get("clientId").is_none());
        assert!(json.get("tenantId").is_none());
        assert_eq!(json["refreshToken"], "rt-secret");
        assert!(json["scopes"].as_array().unwrap().len() >= 2);
        assert!(json["grantedScopes"].as_array().unwrap().len() >= 2);
        assert!(json["expiresAt"].as_str().unwrap().ends_with('Z'));
        assert!(json["lastRefreshAt"].as_str().unwrap().ends_with('Z'));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "oauth.json must be chmod 600");
            let parent_mode = std::fs::metadata(path.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(parent_mode, 0o700, "oauth/<project> dir must be 0o700");
        }

        match prev {
            Some(v) => std::env::set_var("SPEEDWAVE_DATA_DIR", v),
            None => std::env::remove_var("SPEEDWAVE_DATA_DIR"),
        }
    }

    #[test]
    #[serial]
    fn save_oauth_state_rejects_oversized_refresh_token() {
        let tmp = tempfile::tempdir().unwrap();
        let prev = std::env::var("SPEEDWAVE_DATA_DIR").ok();
        std::env::set_var("SPEEDWAVE_DATA_DIR", tmp.path());

        let big = "x".repeat(crate::types::MAX_CREDENTIAL_BYTES + 1);
        let result = save_oauth_state(
            "test-project",
            "sharepoint",
            "11111111-1111-1111-1111-111111111111",
            "common",
            &big,
            speedwave_runtime::consts::SHAREPOINT_OAUTH_SCOPES,
            3600,
        );
        assert!(result.unwrap_err().contains("refresh_token"));

        match prev {
            Some(v) => std::env::set_var("SPEEDWAVE_DATA_DIR", v),
            None => std::env::remove_var("SPEEDWAVE_DATA_DIR"),
        }
    }

    #[test]
    #[serial]
    fn save_tokens_splits_into_two_locations() {
        let tmp = tempfile::tempdir().unwrap();
        let prev = std::env::var("SPEEDWAVE_DATA_DIR").ok();
        std::env::set_var("SPEEDWAVE_DATA_DIR", tmp.path());

        let tokens = MsTokenResponse {
            access_token: "at-secret".to_string(),
            refresh_token: "rt-secret".to_string(),
            _token_type: "Bearer".to_string(),
            expires_in: 3600,
        };
        save_tokens(
            "test-project",
            "11111111-1111-1111-1111-111111111111",
            "common",
            &tokens,
        )
        .unwrap();

        let at_path = speedwave_runtime::plugin::token_dir("test-project", "sharepoint")
            .unwrap()
            .join("access_token");
        assert_eq!(std::fs::read_to_string(&at_path).unwrap(), "at-secret");
        assert!(
            !speedwave_runtime::plugin::token_dir("test-project", "sharepoint")
                .unwrap()
                .join("refresh_token")
                .exists(),
            "refresh_token must NOT be in the worker-mounted dir"
        );
        let state_path = speedwave_runtime::plugin::oauth_state_file("test-project", "sharepoint");
        let content = std::fs::read_to_string(&state_path).unwrap();
        let json: serde_json::Value = serde_json::from_str(&content).unwrap();
        assert_eq!(json["refreshToken"], "rt-secret");
        assert_eq!(
            json["providerData"]["clientId"],
            "11111111-1111-1111-1111-111111111111"
        );
        assert_eq!(json["providerData"]["tenantId"], "common");

        match prev {
            Some(v) => std::env::set_var("SPEEDWAVE_DATA_DIR", v),
            None => std::env::remove_var("SPEEDWAVE_DATA_DIR"),
        }
    }
}
