// SharePoint OAuth Device Code Flow — Tauri commands.
//
// Implements the Microsoft Device Code Flow:
// 1. `start_sharepoint_oauth` — requests a device code, spawns a polling task
// 2. `cancel_sharepoint_oauth` — cancels any active polling task
//
// The polling task emits `sharepoint_oauth_progress` events to the frontend
// via Tauri's event system.

use crate::types::check_project;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::Duration;
use tauri::Emitter;
use tokio_util::sync::CancellationToken;

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

// ---------------------------------------------------------------------------
// Frontend DTOs
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone)]
pub(crate) struct DeviceCodeInfo {
    user_code: String,
    verification_uri: String,
    expires_in: u64,
    request_id: String,
}

#[derive(Serialize, Clone)]
pub(crate) struct OAuthProgressEvent {
    status: String,
    message: String,
    request_id: String,
}

// ---------------------------------------------------------------------------
// Flow state — CancellationToken + generation counter
// ---------------------------------------------------------------------------

struct ActiveFlow {
    request_id: String,
    cancel: CancellationToken,
}

struct FlowState {
    current: Option<ActiveFlow>,
    generation: u64,
}

static FLOW_STATE: std::sync::LazyLock<Mutex<FlowState>> = std::sync::LazyLock::new(|| {
    Mutex::new(FlowState {
        current: None,
        generation: 0,
    })
});

/// Clear current flow if it matches the given request_id.
/// Called on terminal states (success, error, expired) to avoid leaving stale entries.
fn clear_flow_if_current(request_id: &str) {
    if let Ok(mut state) = FLOW_STATE.lock() {
        if state.current.as_ref().map(|f| f.request_id.as_str()) == Some(request_id) {
            state.current = None;
        }
    }
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/// Validate tenant_id: UUID, well-known names, or FQDN-like.
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

    // Well-known tenant names
    if matches!(tenant_id, "common" | "organizations" | "consumers") {
        return Ok(());
    }

    // UUID format (with or without hyphens)
    let stripped = tenant_id.replace('-', "");
    if stripped.len() == 32 && stripped.chars().all(|c| c.is_ascii_hexdigit()) {
        return Ok(());
    }

    // FQDN-like: alphanumeric, dots, hyphens; must start and end with alphanumeric.
    // Reject URL-injection characters: ?, #, %, spaces, /, \, etc.
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

/// Emit an `OAuthProgressEvent` to the frontend.
fn emit_progress(app: &tauri::AppHandle, status: &str, message: &str, request_id: &str) {
    let event = OAuthProgressEvent {
        status: status.to_string(),
        message: message.to_string(),
        request_id: request_id.to_string(),
    };
    if let Err(e) = app.emit("sharepoint_oauth_progress", &event) {
        log::warn!("failed to emit sharepoint_oauth_progress: {e}");
    }
}

/// Save the access_token to the worker-mounted tokens directory. The other
/// fields (`refresh_token`, `client_id`, `tenant_id`, scopes) go to the
/// host-only `oauth.json` via `save_oauth_state` — see ADR-060.
fn save_access_token_to_dir(svc_dir: &std::path::Path, access_token: &str) -> Result<(), String> {
    let max = crate::types::MAX_CREDENTIAL_BYTES;
    if access_token.len() > max {
        return Err(format!("access_token exceeds {max} bytes"));
    }
    std::fs::create_dir_all(svc_dir).map_err(|e| e.to_string())?;
    let at_path = svc_dir.join("access_token");
    // Atomic O_CREAT|0o600 write — avoids the TOCTOU window present in the
    // legacy fs::write + set_owner_only pair (PR1 / fs_perms SSOT).
    speedwave_runtime::fs_perms::write_restricted_file(&at_path, access_token)
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Write the host-only OAuth state file `~/.speedwave/oauth/<project>/<service>.json`
/// with mode 0o600 in an owner-only parent directory (0o700). Used by
/// `save_tokens` after a successful device-code flow; the `oauth` worker writes
/// the same file shape on refresh (ADR-060).
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
    let path = speedwave_runtime::plugin::oauth_state_file(project, service);
    let parent = path.parent().ok_or_else(|| "no parent".to_string())?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;

    // Owner-only parent dir: defense in depth (the oauth worker also expects this).
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let expires_at_iso = iso8601_from_unix_ms(now_ms + expires_in.saturating_mul(1000));
    let last_refresh_iso = iso8601_from_unix_ms(now_ms);

    // Granted scopes start equal to requested (initial consent succeeded).
    let scopes_vec: Vec<&str> = scopes.split_whitespace().collect();

    let state = serde_json::json!({
        "provider": "microsoft",
        "clientId": client_id,
        "tenantId": tenant_id,
        "scopes": scopes_vec,
        "grantedScopes": scopes_vec,
        "refreshToken": refresh_token,
        "expiresAt": expires_at_iso,
        "lastRefreshAt": last_refresh_iso,
    });
    let body = serde_json::to_string_pretty(&state).map_err(|e| e.to_string())? + "\n";
    // Atomic O_CREAT|0o600 — oauth.json contains refresh_token, must never
    // exist with broader perms even for a microsecond.
    speedwave_runtime::fs_perms::write_restricted_file(&path, &body).map_err(|e| e.to_string())?;
    Ok(())
}

/// Format `unix_ms` as `YYYY-MM-DDTHH:MM:SS.sssZ` (UTC).
fn iso8601_from_unix_ms(unix_ms: u64) -> String {
    let secs = (unix_ms / 1000) as i64;
    let ms = (unix_ms % 1000) as u32;
    let dt = chrono::DateTime::<chrono::Utc>::from_timestamp(secs, ms * 1_000_000)
        .unwrap_or_else(chrono::Utc::now);
    dt.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

/// Save tokens after a successful device-code flow: splits across two locations
/// per ADR-060.
fn save_tokens(
    project: &str,
    client_id: &str,
    tenant_id: &str,
    tokens: &MsTokenResponse,
) -> Result<(), String> {
    let svc_dir =
        speedwave_runtime::plugin::token_dir(project, "sharepoint").map_err(|e| e.to_string())?;
    save_access_token_to_dir(&svc_dir, &tokens.access_token)?;
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

/// Start the SharePoint OAuth Device Code Flow.
///
/// Returns a `DeviceCodeInfo` containing the user code and verification URL.
/// Spawns a background task that polls Microsoft for token completion and
/// emits `sharepoint_oauth_progress` events.
#[tauri::command]
pub async fn start_sharepoint_oauth(
    project: String,
    client_id: String,
    tenant_id: String,
    app: tauri::AppHandle,
) -> Result<DeviceCodeInfo, String> {
    check_project(&project)?;

    // Validate client_id as UUID
    uuid::Uuid::parse_str(&client_id).map_err(|_| "client_id must be a valid UUID".to_string())?;

    // Validate tenant_id
    validate_tenant_id(&tenant_id)?;

    // Generate request_id and set up cancellation
    let request_id = uuid::Uuid::new_v4().to_string();
    let cancel_token = CancellationToken::new();

    let my_generation = {
        let mut state = FLOW_STATE
            .lock()
            .map_err(|e| format!("lock poisoned: {e}"))?;
        state.generation += 1;
        // Cancel any previous flow
        if let Some(prev) = state.current.take() {
            prev.cancel.cancel();
        }
        let gen = state.generation;
        state.current = Some(ActiveFlow {
            request_id: request_id.clone(),
            cancel: cancel_token.clone(),
        });
        gen
    };

    // Request device code from Microsoft
    let scopes = speedwave_runtime::consts::SHAREPOINT_OAUTH_SCOPES;
    let devicecode_url = format!(
        "https://login.microsoftonline.com/{}/oauth2/v2.0/devicecode",
        tenant_id
    );
    let body = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("client_id", &client_id)
        .append_pair("scope", scopes)
        .finish();

    let http_client = reqwest::Client::new();
    let resp = http_client
        .post(&devicecode_url)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(body)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| {
            clear_flow_if_current(&request_id);
            format!("Failed to contact Microsoft: {e}")
        })?;

    let status = resp.status();
    let body_bytes = resp.bytes().await.map_err(|e| {
        clear_flow_if_current(&request_id);
        format!("Failed to read device code response: {e}")
    })?;

    if !status.is_success() {
        let preview = String::from_utf8_lossy(&body_bytes);
        clear_flow_if_current(&request_id);
        return Err(format!(
            "Microsoft device code request failed (HTTP {status}): {preview}"
        ));
    }

    let dc_resp: MsDeviceCodeResponse = serde_json::from_slice(&body_bytes).map_err(|e| {
        clear_flow_if_current(&request_id);
        format!("Failed to parse device code response: {e}")
    })?;

    // Re-check generation — if it changed during the HTTP request, abort
    {
        let state = FLOW_STATE
            .lock()
            .map_err(|e| format!("lock poisoned: {e}"))?;
        if state.generation != my_generation {
            clear_flow_if_current(&request_id);
            return Err("OAuth flow was cancelled".to_string());
        }
    }

    // Build response for frontend
    let info = DeviceCodeInfo {
        user_code: dc_resp.user_code.clone(),
        verification_uri: dc_resp.verification_uri.clone(),
        expires_in: dc_resp.expires_in,
        request_id: request_id.clone(),
    };

    // Spawn background polling task
    let poll_cancel = cancel_token.clone();
    let poll_request_id = request_id.clone();
    let poll_project = project.clone();
    let poll_app = app.clone();
    let poll_client_id = client_id.clone();
    let poll_tenant_id = tenant_id.clone();
    let device_code = dc_resp.device_code.clone();
    let mut interval = dc_resp.interval;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(dc_resp.expires_in);

    tokio::spawn(async move {
        let client = http_client;
        let token_url = format!(
            "https://login.microsoftonline.com/{}/oauth2/v2.0/token",
            tenant_id
        );
        let body = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("grant_type", "urn:ietf:params:oauth:grant-type:device_code")
            .append_pair("client_id", &client_id)
            .append_pair("device_code", &device_code)
            .finish();

        loop {
            // Check deadline before sleeping
            if tokio::time::Instant::now() >= deadline {
                emit_progress(
                    &poll_app,
                    "expired",
                    "Device code expired — please try again",
                    &poll_request_id,
                );
                clear_flow_if_current(&poll_request_id);
                return;
            }

            // Cancellable sleep
            tokio::select! {
                () = tokio::time::sleep(Duration::from_secs(interval)) => {}
                () = poll_cancel.cancelled() => {
                    emit_progress(&poll_app, "cancelled", "OAuth flow cancelled", &poll_request_id);
                    clear_flow_if_current(&poll_request_id);
                    return;
                }
            }

            let resp = client
                .post(&token_url)
                .header("Content-Type", "application/x-www-form-urlencoded")
                .body(body.clone())
                .timeout(Duration::from_secs(30))
                .send()
                .await;

            if poll_cancel.is_cancelled() {
                emit_progress(
                    &poll_app,
                    "cancelled",
                    "OAuth flow cancelled",
                    &poll_request_id,
                );
                clear_flow_if_current(&poll_request_id);
                return;
            }

            match resp {
                Ok(r) => {
                    let status = r.status();
                    let body_bytes = match r.bytes().await {
                        Ok(b) => b,
                        Err(e) => {
                            emit_progress(
                                &poll_app,
                                "error",
                                &format!("Failed to read response: {e}"),
                                &poll_request_id,
                            );
                            clear_flow_if_current(&poll_request_id);
                            return;
                        }
                    };

                    // Try parsing as success
                    if let Ok(tokens) = serde_json::from_slice::<MsTokenResponse>(&body_bytes) {
                        if let Err(e) =
                            save_tokens(&poll_project, &poll_client_id, &poll_tenant_id, &tokens)
                        {
                            emit_progress(
                                &poll_app,
                                "error",
                                &format!("Failed to save tokens: {e}"),
                                &poll_request_id,
                            );
                            clear_flow_if_current(&poll_request_id);
                            return;
                        }
                        emit_progress(
                            &poll_app,
                            "success",
                            "Authentication successful",
                            &poll_request_id,
                        );
                        clear_flow_if_current(&poll_request_id);
                        return;
                    }

                    // Try parsing as error
                    if let Ok(err) = serde_json::from_slice::<MsTokenErrorResponse>(&body_bytes) {
                        match err.error.as_str() {
                            "authorization_pending" => continue,
                            "slow_down" => {
                                interval += 5;
                                continue;
                            }
                            "expired_token" => {
                                emit_progress(
                                    &poll_app,
                                    "expired",
                                    "Device code expired — please try again",
                                    &poll_request_id,
                                );
                                clear_flow_if_current(&poll_request_id);
                                return;
                            }
                            "authorization_declined" => {
                                emit_progress(
                                    &poll_app,
                                    "error",
                                    "Authorization was declined",
                                    &poll_request_id,
                                );
                                clear_flow_if_current(&poll_request_id);
                                return;
                            }
                            "bad_verification_code" => {
                                emit_progress(
                                    &poll_app,
                                    "error",
                                    "Invalid verification code",
                                    &poll_request_id,
                                );
                                clear_flow_if_current(&poll_request_id);
                                return;
                            }
                            other => {
                                let msg =
                                    err.error_description.unwrap_or_else(|| other.to_string());
                                emit_progress(&poll_app, "error", &msg, &poll_request_id);
                                clear_flow_if_current(&poll_request_id);
                                return;
                            }
                        }
                    }

                    // Neither success nor recognized error JSON
                    let preview = String::from_utf8_lossy(&body_bytes);
                    let truncated = if preview.len() > 200 {
                        &preview[..200]
                    } else {
                        &preview
                    };
                    emit_progress(
                        &poll_app,
                        "error",
                        &format!(
                            "Unexpected response from Microsoft (HTTP {}): {}",
                            status, truncated
                        ),
                        &poll_request_id,
                    );
                    clear_flow_if_current(&poll_request_id);
                    return;
                }
                Err(e) => {
                    emit_progress(
                        &poll_app,
                        "error",
                        &format!("Network error: {e}"),
                        &poll_request_id,
                    );
                    clear_flow_if_current(&poll_request_id);
                    return;
                }
            }
        }
    });

    Ok(info)
}

/// Cancel any active SharePoint OAuth flow.
#[tauri::command]
pub fn cancel_sharepoint_oauth() {
    if let Ok(mut state) = FLOW_STATE.lock() {
        state.generation += 1;
        if let Some(active) = state.current.take() {
            active.cancel.cancel();
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

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

    // -- Flow state --

    #[test]
    #[serial]
    fn cancel_clears_active_flow() {
        // Set up a flow
        let cancel = CancellationToken::new();
        let rid = "test-rid-cancel";
        {
            let mut state = FLOW_STATE.lock().unwrap();
            state.generation += 1;
            state.current = Some(ActiveFlow {
                request_id: rid.to_string(),
                cancel: cancel.clone(),
            });
        }

        cancel_sharepoint_oauth();

        assert!(cancel.is_cancelled(), "token should be cancelled");
        let state = FLOW_STATE.lock().unwrap();
        assert!(state.current.is_none(), "active flow should be cleared");
    }

    #[test]
    #[serial]
    fn new_flow_cancels_previous_token() {
        let old_cancel = CancellationToken::new();
        let new_cancel = CancellationToken::new();
        {
            let mut state = FLOW_STATE.lock().unwrap();
            state.generation += 1;
            state.current = Some(ActiveFlow {
                request_id: "old-rid".to_string(),
                cancel: old_cancel.clone(),
            });
        }

        // Simulate a new flow starting
        {
            let mut state = FLOW_STATE.lock().unwrap();
            state.generation += 1;
            if let Some(prev) = state.current.take() {
                prev.cancel.cancel();
            }
            state.current = Some(ActiveFlow {
                request_id: "new-rid".to_string(),
                cancel: new_cancel.clone(),
            });
        }

        assert!(
            old_cancel.is_cancelled(),
            "previous token should be cancelled"
        );
        assert!(
            !new_cancel.is_cancelled(),
            "new token should not be cancelled"
        );
    }

    #[test]
    #[serial]
    fn cancel_bumps_generation() {
        let gen_before = {
            let state = FLOW_STATE.lock().unwrap();
            state.generation
        };

        cancel_sharepoint_oauth();

        let gen_after = {
            let state = FLOW_STATE.lock().unwrap();
            state.generation
        };

        assert!(
            gen_after > gen_before,
            "cancel should bump generation counter"
        );
    }

    #[test]
    #[serial]
    fn clear_flow_if_current_only_clears_matching_id() {
        let cancel = CancellationToken::new();
        {
            let mut state = FLOW_STATE.lock().unwrap();
            state.generation += 1;
            state.current = Some(ActiveFlow {
                request_id: "keep-me".to_string(),
                cancel: cancel.clone(),
            });
        }

        // Try to clear with a non-matching ID
        clear_flow_if_current("wrong-id");

        let state = FLOW_STATE.lock().unwrap();
        assert!(
            state.current.is_some(),
            "flow should NOT be cleared for non-matching request_id"
        );
        assert_eq!(state.current.as_ref().unwrap().request_id, "keep-me");
    }

    #[test]
    #[serial]
    fn clear_flow_if_current_clears_matching_id() {
        let cancel = CancellationToken::new();
        {
            let mut state = FLOW_STATE.lock().unwrap();
            state.generation += 1;
            state.current = Some(ActiveFlow {
                request_id: "match-me".to_string(),
                cancel: cancel.clone(),
            });
        }

        clear_flow_if_current("match-me");

        let state = FLOW_STATE.lock().unwrap();
        assert!(
            state.current.is_none(),
            "flow SHOULD be cleared for matching request_id"
        );
    }

    // -- save_access_token_to_dir & save_oauth_state (ADR-060 split) --

    #[test]
    fn save_access_token_to_dir_writes_access_token_only() {
        let tmp = tempfile::tempdir().unwrap();
        let svc_dir = tmp.path().join("sharepoint");
        save_access_token_to_dir(&svc_dir, "at-secret").unwrap();

        let at_path = svc_dir.join("access_token");
        assert_eq!(std::fs::read_to_string(&at_path).unwrap(), "at-secret");
        // refresh_token must NOT be written here — it lives in oauth.json per ADR-060.
        assert!(
            !svc_dir.join("refresh_token").exists(),
            "refresh_token must not be in the worker-mounted tokens dir"
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&at_path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
    }

    #[test]
    fn save_access_token_rejects_oversized() {
        let tmp = tempfile::tempdir().unwrap();
        let big = "x".repeat(crate::types::MAX_CREDENTIAL_BYTES + 1);
        let result = save_access_token_to_dir(&tmp.path().join("sp"), &big);
        assert!(result.unwrap_err().contains("access_token"));
    }

    #[test]
    fn save_access_token_returns_err_on_unwritable_path() {
        let impossible = std::path::Path::new("/dev/null/impossible");
        let result = save_access_token_to_dir(impossible, "at");
        assert!(result.is_err(), "must fail on unwritable path");
    }

    #[test]
    #[serial]
    fn save_oauth_state_writes_json_with_required_fields() {
        // Use a one-off SPEEDWAVE_DATA_DIR so the oauth/<project>/ dir is in tempdir
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
        assert_eq!(json["clientId"], "11111111-1111-1111-1111-111111111111");
        assert_eq!(json["tenantId"], "common");
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
            // Parent dir 0o700 (defense in depth)
            let parent_mode = std::fs::metadata(path.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(parent_mode, 0o700, "oauth/<project> dir must be 0o700");
        }

        // Restore env
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

        // access_token in worker-mounted dir
        let at_path = speedwave_runtime::plugin::token_dir("test-project", "sharepoint")
            .unwrap()
            .join("access_token");
        assert_eq!(std::fs::read_to_string(&at_path).unwrap(), "at-secret");
        // refresh_token NOT in worker-mounted dir
        assert!(
            !speedwave_runtime::plugin::token_dir("test-project", "sharepoint")
                .unwrap()
                .join("refresh_token")
                .exists(),
            "refresh_token must NOT be in the worker-mounted dir"
        );
        // refresh_token + client_id + tenant_id in oauth.json
        let state_path = speedwave_runtime::plugin::oauth_state_file("test-project", "sharepoint");
        let content = std::fs::read_to_string(&state_path).unwrap();
        assert!(content.contains("rt-secret"));
        assert!(content.contains("11111111-1111-1111-1111-111111111111"));
        assert!(content.contains("common"));

        match prev {
            Some(v) => std::env::set_var("SPEEDWAVE_DATA_DIR", v),
            None => std::env::remove_var("SPEEDWAVE_DATA_DIR"),
        }
    }

    #[test]
    #[serial]
    fn save_tokens_error_path_clears_flow() {
        // Verifies the contract: when save_tokens fails, the polling task calls
        // clear_flow_if_current (lines 359-367 in the polling loop). We test the
        // clear_flow_if_current call that happens on the error path.
        let cancel = CancellationToken::new();
        let rid = "save-fail-rid";
        {
            let mut state = FLOW_STATE.lock().unwrap();
            state.generation += 1;
            state.current = Some(ActiveFlow {
                request_id: rid.to_string(),
                cancel: cancel.clone(),
            });
        }

        // Simulate the polling task's error path: save fails, then the task calls
        // clear_flow_if_current(&request_id). Use save_access_token_to_dir here
        // (formerly save_tokens_to_dir before the ADR-060 split).
        let impossible = std::path::Path::new("/dev/null/impossible");
        let save_result = save_access_token_to_dir(impossible, "at-secret");
        assert!(save_result.is_err(), "save should fail");

        // This is what the polling task does after save failure
        clear_flow_if_current(rid);

        let state = FLOW_STATE.lock().unwrap();
        assert!(
            state.current.is_none(),
            "flow should be cleared after save_tokens failure"
        );
    }
}
