// SharePoint OAuth Device Code Flow. Two-file persistence per ADR-060.

use crate::oauth_flow::{
    self, emit_error, save_credential_file, DeviceCodeInfo, DeviceCodeProvider, FlowRegistry,
    PollStep, ProgressStatus,
};
use crate::types::check_project;
use serde::Deserialize;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

const PROGRESS_EVENT: &str = "sharepoint_oauth_progress";

// ── Serde DTOs — Microsoft identity platform responses ──────────────────────────────────

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

// ── Validation helpers ──────────────────────────────────────────────────────────────────

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

/// Inputs for the SharePoint off-mount OAuth state write (ADR-060 split).
struct SpOAuthState<'a> {
    client_id: &'a str,
    tenant_id: &'a str,
    refresh_token: &'a str,
    scopes: &'a str,
    expires_in: u64,
}

/// `data_dir`-parameterised variant; production reaches this via `save_tokens`.
fn save_oauth_state_in(
    data_dir: &std::path::Path,
    project: &str,
    service: &str,
    st: &SpOAuthState<'_>,
) -> Result<(), String> {
    let max = crate::types::MAX_CREDENTIAL_BYTES;
    if st.refresh_token.len() > max {
        return Err(format!("refresh_token exceeds {max} bytes"));
    }
    let scopes_vec: Vec<String> = st.scopes.split_whitespace().map(String::from).collect();
    let mut provider_data = std::collections::BTreeMap::new();
    provider_data.insert("clientId".to_string(), st.client_id.to_string());
    provider_data.insert("tenantId".to_string(), st.tenant_id.to_string());

    let path = speedwave_runtime::plugin::oauth_state_file_in(data_dir, project, service);
    speedwave_runtime::oauth_persist::write_oauth_state(
        &path,
        &speedwave_runtime::oauth_persist::OAuthStateParams {
            provider: crate::oauth_providers::MICROSOFT_PROVIDER_ID,
            grant_type: None,
            provider_data,
            scopes: scopes_vec.clone(),
            granted_scopes: scopes_vec,
            refresh_token: st.refresh_token,
            expires_in: st.expires_in,
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
            "expired_token" => PollAction::Expired(oauth_flow::DEVICE_CODE_EXPIRED_MSG.to_string()),
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
    save_tokens_in(
        speedwave_runtime::consts::data_dir(),
        project,
        client_id,
        tenant_id,
        tokens,
    )
}

/// `data_dir`-parameterised variant (see `save_oauth_state_in`).
fn save_tokens_in(
    data_dir: &std::path::Path,
    project: &str,
    client_id: &str,
    tenant_id: &str,
    tokens: &MsTokenResponse,
) -> Result<(), String> {
    // State first, mounted token second.
    save_oauth_state_in(
        data_dir,
        project,
        "sharepoint",
        &SpOAuthState {
            client_id,
            tenant_id,
            refresh_token: &tokens.refresh_token,
            scopes: speedwave_runtime::consts::SHAREPOINT_OAUTH_SCOPES,
            expires_in: tokens.expires_in(),
        },
    )?;
    let svc_dir = speedwave_runtime::plugin::token_dir_in(data_dir, project, "sharepoint");
    save_credential_file(&svc_dir, "access_token", &tokens.access_token)?;
    Ok(())
}

/// SharePoint/Microsoft device-code polling behaviour. Drives the shared
/// `run_device_code_poll` loop in `oauth_flow`.
struct SharepointProvider {
    project: String,
    client_id: String,
    tenant_id: String,
    device_code: String,
    token_url: String,
}

impl DeviceCodeProvider for SharepointProvider {
    fn token_request(&self, client: &reqwest::Client) -> reqwest::RequestBuilder {
        let body = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("grant_type", "urn:ietf:params:oauth:grant-type:device_code")
            .append_pair("client_id", &self.client_id)
            .append_pair("device_code", &self.device_code)
            .finish();
        client
            .post(&self.token_url)
            .header("Content-Type", "application/x-www-form-urlencoded")
            .body(body)
    }

    fn handle_token_response(
        &self,
        http_status: reqwest::StatusCode,
        body_bytes: &[u8],
    ) -> PollStep {
        match classify_sharepoint_response(http_status.as_u16(), body_bytes) {
            Ok(()) => {
                let tokens: MsTokenResponse = match serde_json::from_slice(body_bytes) {
                    Ok(t) => t,
                    Err(e) => return emit_error(format!("Failed to parse token response: {e}")),
                };
                if let Err(e) =
                    save_tokens(&self.project, &self.client_id, &self.tenant_id, &tokens)
                {
                    return emit_error(format!("Failed to save tokens: {e}"));
                }
                PollStep::Emit {
                    status: ProgressStatus::Success,
                    message: "Authentication successful".to_string(),
                }
            }
            Err(action) => action.into_step(),
        }
    }
}

// ── Tauri commands ──────────────────────────────────────────────────────────────────────

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
    let my_generation = FLOW_STATE.install(request_id.clone(), cancel_token.clone());

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

    if FLOW_STATE.current_generation() != my_generation {
        FLOW_STATE.clear_if_current(&request_id);
        return Err("OAuth flow was cancelled".to_string());
    }

    let info = DeviceCodeInfo {
        user_code: dc_resp.user_code.clone(),
        verification_uri: dc_resp.verification_uri.clone(),
        expires_in: dc_resp.expires_in,
        request_id: request_id.clone(),
    };

    let token_url = format!(
        "https://login.microsoftonline.com/{}/oauth2/v2.0/token",
        tenant_id
    );
    let provider = SharepointProvider {
        project: project.clone(),
        client_id: client_id.clone(),
        tenant_id: tenant_id.clone(),
        device_code: dc_resp.device_code.clone(),
        token_url,
    };
    tokio::spawn(oauth_flow::run_device_code_poll(
        oauth_flow::DeviceCodePoll {
            app: app.clone(),
            registry: &FLOW_STATE,
            cancel: cancel_token.clone(),
            request_id: request_id.clone(),
            http_client,
            interval: dc_resp.interval,
            expires_in: dc_resp.expires_in,
        },
        provider,
    ));

    Ok(info)
}

#[tauri::command]
pub fn cancel_sharepoint_oauth() {
    FLOW_STATE.cancel();
}

#[cfg(test)]
#[expect(clippy::unwrap_used, reason = "unwrap is fine in test assertions")]
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
    fn save_oauth_state_writes_json_with_required_fields() {
        let tmp = tempfile::tempdir().unwrap();
        save_oauth_state_in(
            tmp.path(),
            "test-project",
            "sharepoint",
            &SpOAuthState {
                client_id: "11111111-1111-1111-1111-111111111111",
                tenant_id: "common",
                refresh_token: "rt-secret",
                scopes: speedwave_runtime::consts::SHAREPOINT_OAUTH_SCOPES,
                expires_in: 3600,
            },
        )
        .unwrap();

        let path = speedwave_runtime::plugin::oauth_state_file_in(
            tmp.path(),
            "test-project",
            "sharepoint",
        );
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
    }

    /// SSOT parity guard: written key set must equal
    /// `mcp-servers/oauth/src/oauth-state.ts::assertOAuthState`.
    #[test]
    fn save_oauth_state_key_set_matches_documented_ts_schema() {
        // Mirror of OAuthState in oauth-state.ts (top-level + providerData keys).
        const EXPECTED_TOP_LEVEL: &[&str] = &[
            "provider",
            "providerData",
            "scopes",
            "grantedScopes",
            "refreshToken",
            "expiresAt",
            "lastRefreshAt",
        ];
        const EXPECTED_PROVIDER_DATA: &[&str] = &["clientId", "tenantId"];

        let tmp = tempfile::tempdir().unwrap();
        save_oauth_state_in(
            tmp.path(),
            "test-project",
            "sharepoint",
            &SpOAuthState {
                client_id: "11111111-1111-1111-1111-111111111111",
                tenant_id: "common",
                refresh_token: "rt-secret",
                scopes: speedwave_runtime::consts::SHAREPOINT_OAUTH_SCOPES,
                expires_in: 3600,
            },
        )
        .unwrap();

        let path = speedwave_runtime::plugin::oauth_state_file_in(
            tmp.path(),
            "test-project",
            "sharepoint",
        );
        let content = std::fs::read_to_string(&path).unwrap();
        let json: serde_json::Value = serde_json::from_str(&content).unwrap();

        let top_keys: std::collections::BTreeSet<&str> = json
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        let expected_top: std::collections::BTreeSet<&str> =
            EXPECTED_TOP_LEVEL.iter().copied().collect();
        assert_eq!(
            top_keys, expected_top,
            "oauth.json top-level keys drifted from assertOAuthState schema"
        );

        let pd_keys: std::collections::BTreeSet<&str> = json["providerData"]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        let expected_pd: std::collections::BTreeSet<&str> =
            EXPECTED_PROVIDER_DATA.iter().copied().collect();
        assert_eq!(
            pd_keys, expected_pd,
            "oauth.json providerData keys drifted from the Microsoft schema"
        );
    }

    #[test]
    fn save_oauth_state_rejects_oversized_refresh_token() {
        let tmp = tempfile::tempdir().unwrap();
        let big = "x".repeat(crate::types::MAX_CREDENTIAL_BYTES + 1);
        let result = save_oauth_state_in(
            tmp.path(),
            "test-project",
            "sharepoint",
            &SpOAuthState {
                client_id: "11111111-1111-1111-1111-111111111111",
                tenant_id: "common",
                refresh_token: &big,
                scopes: speedwave_runtime::consts::SHAREPOINT_OAUTH_SCOPES,
                expires_in: 3600,
            },
        );
        assert!(result.unwrap_err().contains("refresh_token"));
    }

    #[test]
    fn save_tokens_splits_into_two_locations() {
        let tmp = tempfile::tempdir().unwrap();
        let tokens = MsTokenResponse {
            access_token: "at-secret".to_string(),
            refresh_token: "rt-secret".to_string(),
            _token_type: "Bearer".to_string(),
            expires_in: 3600,
        };
        save_tokens_in(
            tmp.path(),
            "test-project",
            "11111111-1111-1111-1111-111111111111",
            "common",
            &tokens,
        )
        .unwrap();

        let svc_dir =
            speedwave_runtime::plugin::token_dir_in(tmp.path(), "test-project", "sharepoint");
        assert_eq!(
            std::fs::read_to_string(svc_dir.join("access_token")).unwrap(),
            "at-secret"
        );
        assert!(
            !svc_dir.join("refresh_token").exists(),
            "refresh_token must NOT be in the worker-mounted dir"
        );
        let state_path = speedwave_runtime::plugin::oauth_state_file_in(
            tmp.path(),
            "test-project",
            "sharepoint",
        );
        let content = std::fs::read_to_string(&state_path).unwrap();
        let json: serde_json::Value = serde_json::from_str(&content).unwrap();
        assert_eq!(json["refreshToken"], "rt-secret");
        assert_eq!(
            json["providerData"]["clientId"],
            "11111111-1111-1111-1111-111111111111"
        );
        assert_eq!(json["providerData"]["tenantId"], "common");
    }

    // -- classify_sharepoint_response: poll-loop mechanics (mirrors github) --

    #[test]
    fn classify_sp_accepts_success_body() {
        let body =
            br#"{"access_token":"a","refresh_token":"r","token_type":"Bearer","expires_in":3600}"#;
        assert!(classify_sharepoint_response(200, body).is_ok());
    }

    #[test]
    fn classify_sp_pending_keeps_polling() {
        let body = br#"{"error":"authorization_pending"}"#;
        assert!(matches!(
            classify_sharepoint_response(400, body),
            Err(oauth_flow::PollAction::KeepPolling)
        ));
    }

    #[test]
    fn classify_sp_slow_down_backs_off() {
        let body = br#"{"error":"slow_down"}"#;
        assert!(matches!(
            classify_sharepoint_response(400, body),
            Err(oauth_flow::PollAction::SlowDown)
        ));
    }

    #[test]
    fn classify_sp_expired_token_is_expired() {
        let body = br#"{"error":"expired_token"}"#;
        assert!(matches!(
            classify_sharepoint_response(400, body),
            Err(oauth_flow::PollAction::Expired(_))
        ));
    }

    #[test]
    fn classify_sp_declined_is_failed() {
        let body = br#"{"error":"authorization_declined"}"#;
        assert!(matches!(
            classify_sharepoint_response(400, body),
            Err(oauth_flow::PollAction::Failed(_))
        ));
    }

    #[test]
    fn classify_sp_other_error_redacts_description() {
        // The `other` branch routes error_description through redaction.
        let body =
            br#"{"error":"invalid_grant","error_description":"AADSTS9000 secret tenant detail"}"#;
        match classify_sharepoint_response(400, body) {
            Err(oauth_flow::PollAction::Failed(msg)) => {
                assert!(!msg.contains("secret tenant detail"), "leaked: {msg}");
            }
            _ => panic!("expected Failed"),
        }
    }

    #[test]
    fn classify_sp_garbage_is_failed_with_http_status() {
        match classify_sharepoint_response(503, b"not json") {
            Err(oauth_flow::PollAction::Failed(msg)) => {
                assert!(msg.contains("HTTP 503"), "status must surface: {msg}");
            }
            _ => panic!("expected Failed with HTTP status"),
        }
    }

    // -- SharepointProvider::handle_token_response classification --

    fn provider() -> SharepointProvider {
        SharepointProvider {
            project: "test-project".to_string(),
            client_id: "11111111-1111-1111-1111-111111111111".to_string(),
            tenant_id: "common".to_string(),
            device_code: "dc".to_string(),
            token_url: "https://login.microsoftonline.com/common/oauth2/v2.0/token".to_string(),
        }
    }

    fn ok_status() -> reqwest::StatusCode {
        reqwest::StatusCode::OK
    }

    #[test]
    fn provider_authorization_pending_keeps_polling() {
        let body = br#"{"error":"authorization_pending"}"#;
        match provider().handle_token_response(ok_status(), body) {
            PollStep::KeepPolling { slow_down } => assert!(!slow_down),
            PollStep::Emit { .. } => panic!("pending must keep polling"),
        }
    }

    #[test]
    fn provider_slow_down_keeps_polling_with_slow_down() {
        let body = br#"{"error":"slow_down"}"#;
        match provider().handle_token_response(ok_status(), body) {
            PollStep::KeepPolling { slow_down } => assert!(slow_down),
            PollStep::Emit { .. } => panic!("slow_down must keep polling"),
        }
    }

    #[test]
    fn provider_expired_token_emits_canonical_expired_message() {
        let body = br#"{"error":"expired_token"}"#;
        match provider().handle_token_response(ok_status(), body) {
            PollStep::Emit { status, message } => {
                assert_eq!(status, ProgressStatus::Expired);
                assert_eq!(message, oauth_flow::DEVICE_CODE_EXPIRED_MSG);
            }
            PollStep::KeepPolling { .. } => panic!("expired_token must terminate"),
        }
    }

    #[test]
    fn provider_declined_emits_error() {
        let body = br#"{"error":"authorization_declined"}"#;
        match provider().handle_token_response(ok_status(), body) {
            PollStep::Emit { status, message } => {
                assert_eq!(status, ProgressStatus::Error);
                assert!(message.contains("declined"));
            }
            PollStep::KeepPolling { .. } => panic!("declined must terminate"),
        }
    }

    #[test]
    fn provider_unknown_error_redacts_description() {
        let body =
            br#"{"error":"interaction_required","error_description":"AADSTS50079: leak here"}"#;
        match provider().handle_token_response(ok_status(), body) {
            PollStep::Emit { status, message } => {
                assert_eq!(status, ProgressStatus::Error);
                assert_eq!(message, "AADSTS50079");
                assert!(!message.contains("leak"));
            }
            PollStep::KeepPolling { .. } => panic!("unknown error must terminate"),
        }
    }

    #[test]
    fn provider_unparseable_body_emits_unexpected_error() {
        let body = b"<html>nonsense</html>";
        match provider().handle_token_response(ok_status(), body) {
            PollStep::Emit { status, message } => {
                assert_eq!(status, ProgressStatus::Error);
                assert!(message.contains("Unexpected response from Microsoft"));
            }
            PollStep::KeepPolling { .. } => panic!("garbage body must terminate"),
        }
    }

    #[test]
    #[serial]
    fn provider_success_saves_tokens_and_emits_success() {
        let tmp = tempfile::tempdir().unwrap();
        let prev = std::env::var("SPEEDWAVE_DATA_DIR").ok();
        std::env::set_var("SPEEDWAVE_DATA_DIR", tmp.path());

        let body = br#"{"access_token":"at-secret","refresh_token":"rt-secret","token_type":"Bearer","expires_in":3600}"#;
        match provider().handle_token_response(ok_status(), body) {
            PollStep::Emit { status, .. } => assert_eq!(status, ProgressStatus::Success),
            PollStep::KeepPolling { .. } => panic!("success must terminate"),
        }
        let at_path = speedwave_runtime::plugin::token_dir("test-project", "sharepoint")
            .unwrap()
            .join("access_token");
        assert_eq!(std::fs::read_to_string(&at_path).unwrap(), "at-secret");

        match prev {
            Some(v) => std::env::set_var("SPEEDWAVE_DATA_DIR", v),
            None => std::env::remove_var("SPEEDWAVE_DATA_DIR"),
        }
    }
}
